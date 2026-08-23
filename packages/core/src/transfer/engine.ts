/**
 * The streaming transfer engine.
 *
 * Bytes go GoPro CDN -> a bounded in-memory buffer -> Google Photos. Nothing is
 * written to disk, so library size is irrelevant to disk usage.
 *
 * The hardest constraint is that GoPro's signed URLs live exactly 3600 seconds
 * while a 20 GB upload can take longer than that (PLAN.md §7.2). Download URLs are
 * therefore never persisted, are re-resolved pre-emptively before expiry, and are
 * re-resolved again on a 403. The Google session is unaffected: its committed
 * offset is authoritative and the session itself lasts 7 days.
 */

import {
  GOPRO_URL_REFRESH_MARGIN_MS, GOPRO_URL_TTL_MS,
  SINGLE_REQUEST_MAX_BYTES, UPLOAD_CHUNK_BYTES, MAX_BATCH_ITEMS,
} from "../index.js";
import type { GoProClient } from "../gopro/client.js";
import { GoProError } from "../gopro/errors.js";
import { selectAssets, type SelectedAsset } from "../gopro/selection.js";
import type { MediaRow } from "../gopro/types.js";
import type { GooglePhotosClient, UploadSession } from "../google/client.js";
import type { Store } from "../state/db.js";
import { mimeFor } from "./mime.js";

export interface TransferTask {
  row: MediaRow;
  asset: SelectedAsset;
}

export interface EngineOptions {
  concurrency?: number | undefined;
  albumId?: string | null | undefined;
  chunkBytes?: number | undefined;
  onProgress?: ((e: ProgressEvent) => void) | undefined;
  onLog?: ((message: string) => void) | undefined;
}

export interface ProgressEvent {
  mediaId: string;
  itemNumber: number;
  filename: string;
  bytesSent: number;
  bytesTotal: number;
  phase: "resolving" | "uploading" | "creating" | "done" | "failed" | "skipped";
  message?: string | undefined;
}

interface ResolvedUrl {
  url: string;
  headUrl: string | null;
  resolvedAt: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TransferEngine {
  constructor(
    private readonly gopro: GoProClient,
    private readonly google: GooglePhotosClient,
    private readonly store: Store,
    private readonly opts: EngineOptions = {},
  ) {}

  private log(m: string) { this.opts.onLog?.(m); }
  private emit(e: ProgressEvent) { this.opts.onProgress?.(e); }

  /** Re-fetch the manifest and find the same (label, itemNumber). Never cached. */
  private async resolveUrl(row: MediaRow, asset: SelectedAsset): Promise<ResolvedUrl> {
    const manifest = await this.gopro.downloadManifest(row.id);
    const selection = selectAssets(row, manifest);
    const match =
      selection.assets.find((a) => a.itemNumber === asset.itemNumber && a.label === asset.label) ??
      selection.assets.find((a) => a.itemNumber === asset.itemNumber);
    if (!match) {
      throw new GoProError("not-found", `Asset ${asset.label}#${asset.itemNumber} vanished from the manifest`);
    }
    return { url: match.url, headUrl: match.headUrl, resolvedAt: Date.now() };
  }

  private expiringSoon(r: ResolvedUrl): boolean {
    return Date.now() - r.resolvedAt >= GOPRO_URL_TTL_MS - GOPRO_URL_REFRESH_MARGIN_MS;
  }

  /** Exact byte length. The CDN's content-type is useless but content-length is not. */
  private async probeSize(r: ResolvedUrl): Promise<number> {
    const res = await fetch(r.headUrl ?? r.url, { method: "HEAD" });
    if (!res.ok) throw new GoProError("url-expired", `HEAD failed (${res.status})`, res.status);
    const len = Number(res.headers.get("content-length"));
    if (!Number.isFinite(len) || len <= 0) throw new GoProError("unknown", "CDN returned no content-length");
    return len;
  }

  private async fetchRange(r: ResolvedUrl, start: number, endInclusive: number): Promise<Uint8Array> {
    const res = await fetch(r.url, { headers: { Range: `bytes=${start}-${endInclusive}` } });
    if (res.status === 403 || res.status === 401) {
      throw new GoProError("url-expired", "Signed URL expired mid-transfer", res.status);
    }
    if (!res.ok && res.status !== 206) {
      throw new GoProError("network", `CDN range request failed (${res.status})`, res.status);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Upload one asset, returning its upload token. Resumes from the server's offset. */
  private async uploadAsset(task: TransferTask): Promise<string> {
    const { row, asset } = task;
    const filename = row.filename ?? `${row.id}.bin`;
    const mime = mimeFor(filename);
    const chunkBytes = this.opts.chunkBytes ?? UPLOAD_CHUNK_BYTES;

    this.emit({ mediaId: row.id, itemNumber: asset.itemNumber, filename, bytesSent: 0, bytesTotal: 0, phase: "resolving" });
    this.store.setState(row.id, asset.itemNumber, "resolving");

    let resolved = await this.resolveUrl(row, asset);
    const total = await this.probeSize(resolved);

    // Small files go in one request: fewer round trips, and Google recommends it.
    if (total <= SINGLE_REQUEST_MAX_BYTES) {
      this.store.setState(row.id, asset.itemNumber, "uploading");
      const body = await this.fetchRange(resolved, 0, total - 1);
      const token = await this.google.uploadWhole(body, mime);
      this.store.recordProgress(row.id, asset.itemNumber, total, null);
      this.emit({ mediaId: row.id, itemNumber: asset.itemNumber, filename, bytesSent: total, bytesTotal: total, phase: "creating" });
      return token;
    }

    // Large files stream in aligned chunks so a failure costs one chunk, not the file.
    const session: UploadSession = await this.google.startSession(total, mime);
    const aligned = Math.max(session.granularity, Math.floor(chunkBytes / session.granularity) * session.granularity);
    this.store.setState(row.id, asset.itemNumber, "uploading");
    this.store.recordProgress(row.id, asset.itemNumber, 0, session.url);

    let offset = 0;
    let token: string | null = null;

    while (offset < total) {
      if (this.expiringSoon(resolved)) {
        this.log(`Re-resolving ${filename} before its download URL expires`);
        resolved = await this.resolveUrl(row, asset);
      }
      const end = Math.min(offset + aligned, total) - 1;
      const isLast = end === total - 1;

      let body: Uint8Array;
      try {
        body = await this.fetchRange(resolved, offset, end);
      } catch (err) {
        if (err instanceof GoProError && err.kind === "url-expired") {
          this.log(`Download URL expired mid-file; re-resolving ${filename} and continuing at ${offset}`);
          resolved = await this.resolveUrl(row, asset);
          continue;
        }
        throw err;
      }

      try {
        token = await this.google.sendChunk(session, body, offset, isLast);
        offset += body.byteLength;
        this.store.recordProgress(row.id, asset.itemNumber, offset, session.url);
        this.emit({ mediaId: row.id, itemNumber: asset.itemNumber, filename, bytesSent: offset, bytesTotal: total, phase: "uploading" });
      } catch (err) {
        // 400 means either a bad chunk or a dead session; only a query can tell them
        // apart. Never replay a committed offset — that is itself rejected.
        const q = await this.google.queryOffset(session);
        if (q && q.status === "active") {
          this.log(`Chunk rejected for ${filename}; server holds ${q.committed} bytes, resuming there`);
          offset = q.committed;
          this.store.recordProgress(row.id, asset.itemNumber, offset, session.url);
          await sleep(1000);
          continue;
        }
        throw err;
      }
    }

    if (!token) throw new Error(`Upload of ${filename} finished without returning a token`);
    this.emit({ mediaId: row.id, itemNumber: asset.itemNumber, filename, bytesSent: total, bytesTotal: total, phase: "creating" });
    return token;
  }

  /**
   * Run a batch of tasks. Uploads proceed concurrently; batchCreate is strictly
   * serial per user, because parallel batchCreate is the documented cause of 500s.
   */
  async run(tasks: TransferTask[]): Promise<{ created: number; skipped: number; failed: number }> {
    const concurrency = Math.max(1, this.opts.concurrency ?? 3);
    const albumId = this.opts.albumId ?? undefined;
    const queue = [...tasks];
    const ready: Array<{ task: TransferTask; token: string; fileName: string }> = [];
    let created = 0, skipped = 0, failed = 0;

    const flush = async (force: boolean) => {
      while (ready.length >= (force ? 1 : MAX_BATCH_ITEMS)) {
        const batch = ready.splice(0, MAX_BATCH_ITEMS);
        try {
          const results = await this.google.batchCreate(
            batch.map((b) => ({ uploadToken: b.token, fileName: b.fileName })),
            albumId,
          );
          results.forEach((res, i) => {
            const b = batch[i];
            if (!b) return;
            const { row, asset } = b.task;
            if (res.code === 0 || res.code === 6) {
              // 6 = ALREADY_EXISTS. Google deduped identical bytes; that is success.
              this.store.markVerified(row.id, asset.itemNumber, res.mediaItemId ?? "deduped");
              created++;
              this.emit({ mediaId: row.id, itemNumber: asset.itemNumber, filename: b.fileName, bytesSent: 0, bytesTotal: 0, phase: "done" });
            } else if (res.code === 3) {
              this.store.markSkipped(row.id, asset.itemNumber, `Google rejected the media: ${res.message ?? "code 3"}`);
              skipped++;
              this.emit({ mediaId: row.id, itemNumber: asset.itemNumber, filename: b.fileName, bytesSent: 0, bytesTotal: 0, phase: "skipped", message: res.message ?? undefined });
            } else {
              this.store.setState(row.id, asset.itemNumber, "pending", res.message ?? `code ${res.code}`);
              failed++;
            }
          });
        } catch (err) {
          // Batch-level failure creates nothing but leaves every token valid, so
          // the items go back to pending rather than being marked failed.
          const msg = err instanceof Error ? err.message : String(err);
          this.log(`Batch create failed (${msg}); ${batch.length} items returned to the queue`);
          for (const b of batch) this.store.setState(b.task.row.id, b.task.asset.itemNumber, "pending", msg);
          failed += batch.length;
        }
        if (!force) break;
      }
    };

    const worker = async () => {
      while (queue.length > 0) {
        const task = queue.shift();
        if (!task) break;
        const { row, asset } = task;
        if (this.store.isDone(row.id, asset.itemNumber)) continue;
        try {
          const token = await this.uploadAsset(task);
          ready.push({ task, token, fileName: row.filename ?? `${row.id}.bin` });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.store.setState(row.id, asset.itemNumber, "failed", msg);
          failed++;
          this.emit({ mediaId: row.id, itemNumber: asset.itemNumber, filename: row.filename ?? row.id, bytesSent: 0, bytesTotal: 0, phase: "failed", message: msg });
        }
        await flush(false);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));
    await flush(true);
    return { created, skipped, failed };
  }
}
