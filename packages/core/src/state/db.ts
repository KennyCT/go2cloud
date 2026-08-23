/**
 * Local state.
 *
 * Backed by node:sqlite (built into Node >=22.5) so there is no native addon to
 * compile. The schema is PLAN.md §6; the one detail worth reading twice is that
 * `transfers` is keyed on (gopro_media_id, item_number), not media id alone — a
 * chaptered video is ONE media id containing N chapters, and a media-id-keyed
 * table silently drops chapters 2..N.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type TransferState =
  | "pending"
  | "resolving"
  | "uploading"
  | "creating"
  | "verified"
  | "skipped"
  | "failed";

export interface TransferRow {
  gopro_media_id: string;
  item_number: number;
  variation_label: string | null;
  target_album_id: string | null;
  state: TransferState;
  bytes_total: number;
  bytes_sent: number;
  upload_url: string | null;
  upload_token: string | null;
  google_media_item_id: string | null;
  attempts: number;
  last_error: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gopro_media (
  id                   TEXT PRIMARY KEY,
  type                 TEXT,
  filename             TEXT,
  file_extension       TEXT,
  file_size            INTEGER,
  width                INTEGER,
  height               INTEGER,
  captured_at          TEXT,
  captured_at_timezone TEXT,
  created_at           TEXT,
  item_count           INTEGER,
  available_labels     TEXT,
  mce_type             TEXT,
  play_as              TEXT,
  raw                  TEXT,
  scanned_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_captured ON gopro_media(captured_at);
CREATE INDEX IF NOT EXISTS idx_media_created  ON gopro_media(created_at);

CREATE TABLE IF NOT EXISTS gopro_albums (
  id          TEXT PRIMARY KEY,
  title       TEXT,
  label       TEXT,
  media_count INTEGER,
  scanned_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gopro_album_members (
  album_id       TEXT NOT NULL,
  gopro_media_id TEXT NOT NULL,
  PRIMARY KEY (album_id, gopro_media_id)
);

CREATE TABLE IF NOT EXISTS google_albums (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Composite key: one GoPro media id can contain N chapters or burst frames.
CREATE TABLE IF NOT EXISTS transfers (
  gopro_media_id       TEXT NOT NULL,
  item_number          INTEGER NOT NULL,
  variation_label      TEXT,
  target_album_id      TEXT,
  state                TEXT NOT NULL DEFAULT 'pending',
  bytes_total          INTEGER NOT NULL DEFAULT 0,
  bytes_sent           INTEGER NOT NULL DEFAULT 0,
  upload_url           TEXT,
  upload_token         TEXT,
  google_media_item_id TEXT,
  attempts             INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  started_at           TEXT,
  finished_at          TEXT,
  PRIMARY KEY (gopro_media_id, item_number)
);
CREATE INDEX IF NOT EXISTS idx_transfers_state ON transfers(state);
`;

const SCHEMA_VERSION = "1";

/**
 * Transfer state is per destination account, so profiles get their own database.
 * Sharing one would let a transfer to account A mark work "done" for account B.
 */
export function defaultDbPath(profile = "default"): string {
  const name = profile === "default" ? "state.sqlite" : `state-${profile}.sqlite`;
  return join(homedir(), ".go2cloud", name);
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string = defaultDbPath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL lets the web UI read progress while a transfer is mid-flight.
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO NOTHING")
      .run(SCHEMA_VERSION);
  }

  close(): void {
    this.db.close();
  }

  // ---- media ------------------------------------------------------------ //

  upsertMedia(rows: Array<Record<string, unknown>>): number {
    const stmt = this.db.prepare(`
      INSERT INTO gopro_media (id, type, filename, file_extension, file_size, width, height,
        captured_at, captured_at_timezone, created_at, item_count, available_labels,
        mce_type, play_as, raw, scanned_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        type=excluded.type, filename=excluded.filename, file_extension=excluded.file_extension,
        file_size=excluded.file_size, width=excluded.width, height=excluded.height,
        captured_at=excluded.captured_at, captured_at_timezone=excluded.captured_at_timezone,
        created_at=excluded.created_at, item_count=excluded.item_count,
        available_labels=excluded.available_labels, mce_type=excluded.mce_type,
        play_as=excluded.play_as, raw=excluded.raw, scanned_at=excluded.scanned_at
    `);
    const now = new Date().toISOString();
    const s = (v: unknown) => (typeof v === "string" ? v : null);
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    let count = 0;
    this.db.exec("BEGIN");
    try {
      for (const r of rows) {
        stmt.run(
          String(r["id"]), s(r["type"]), s(r["filename"]), s(r["file_extension"]),
          n(r["file_size"]), n(r["width"]), n(r["height"]), s(r["captured_at"]),
          s(r["captured_at_timezone"]), s(r["created_at"]), n(r["item_count"]),
          Array.isArray(r["available_labels"]) ? JSON.stringify(r["available_labels"]) : null,
          s(r["mce_type"]), s(r["play_as"]), JSON.stringify(r), now,
        );
        count++;
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return count;
  }

  mediaCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM gopro_media").get() as { c: number };
    return row.c;
  }

  // ---- transfers -------------------------------------------------------- //

  /** Queue an asset. Existing rows are left untouched, which is what makes re-runs idempotent. */
  enqueue(mediaId: string, itemNumber: number, label: string | null, albumId: string | null, bytesTotal: number): void {
    this.db
      .prepare(`
        INSERT INTO transfers (gopro_media_id, item_number, variation_label, target_album_id, bytes_total, state)
        VALUES (?,?,?,?,?, 'pending')
        ON CONFLICT(gopro_media_id, item_number) DO NOTHING
      `)
      .run(mediaId, itemNumber, label, albumId, bytesTotal);
  }

  markSkipped(mediaId: string, itemNumber: number, reason: string): void {
    this.db
      .prepare(`
        INSERT INTO transfers (gopro_media_id, item_number, state, last_error, finished_at)
        VALUES (?,?, 'skipped', ?, ?)
        ON CONFLICT(gopro_media_id, item_number) DO UPDATE SET
          state='skipped', last_error=excluded.last_error, finished_at=excluded.finished_at
      `)
      .run(mediaId, itemNumber, reason, new Date().toISOString());
  }

  setState(mediaId: string, itemNumber: number, state: TransferState, error?: string): void {
    this.db
      .prepare("UPDATE transfers SET state=?, last_error=? WHERE gopro_media_id=? AND item_number=?")
      .run(state, error ?? null, mediaId, itemNumber);
  }

  recordProgress(mediaId: string, itemNumber: number, bytesSent: number, uploadUrl: string | null): void {
    this.db
      .prepare("UPDATE transfers SET bytes_sent=?, upload_url=? WHERE gopro_media_id=? AND item_number=?")
      .run(bytesSent, uploadUrl, mediaId, itemNumber);
  }

  markVerified(mediaId: string, itemNumber: number, googleId: string): void {
    this.db
      .prepare(`
        UPDATE transfers SET state='verified', google_media_item_id=?, finished_at=?, upload_url=NULL, upload_token=NULL
        WHERE gopro_media_id=? AND item_number=?
      `)
      .run(googleId, new Date().toISOString(), mediaId, itemNumber);
  }

  /** True when this exact asset already reached Google — the idempotency check. */
  isDone(mediaId: string, itemNumber: number): boolean {
    const row = this.db
      .prepare("SELECT state FROM transfers WHERE gopro_media_id=? AND item_number=?")
      .get(mediaId, itemNumber) as { state?: string } | undefined;
    return row?.state === "verified" || row?.state === "skipped";
  }

  pending(limit = 500): TransferRow[] {
    return this.db
      .prepare(`
        SELECT * FROM transfers
        WHERE state IN ('pending','resolving','uploading','creating')
        ORDER BY gopro_media_id, item_number LIMIT ?
      `)
      .all(limit) as unknown as TransferRow[];
  }

  summary(): Record<string, number> {
    const rows = this.db.prepare("SELECT state, COUNT(*) AS c FROM transfers GROUP BY state").all() as Array<{
      state: string;
      c: number;
    }>;
    return Object.fromEntries(rows.map((r) => [r.state, r.c]));
  }

  bytesRemaining(): number {
    const row = this.db
      .prepare(`
        SELECT COALESCE(SUM(bytes_total - bytes_sent), 0) AS b FROM transfers
        WHERE state IN ('pending','resolving','uploading','creating')
      `)
      .get() as { b: number };
    return row.b;
  }

  // ---- google albums ---------------------------------------------------- //

  rememberGoogleAlbum(id: string, title: string): void {
    this.db
      .prepare("INSERT INTO google_albums (id, title, created_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title")
      .run(id, title, new Date().toISOString());
  }

  googleAlbums(): Array<{ id: string; title: string; created_at: string }> {
    return this.db.prepare("SELECT * FROM google_albums ORDER BY created_at DESC").all() as unknown as Array<{
      id: string;
      title: string;
      created_at: string;
    }>;
  }
}
