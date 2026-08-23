/**
 * Google Photos Library API client.
 *
 * Every behaviour below was verified live on 2026-08-23 (docs/probe-results-google.json).
 * Several contradict both the official docs and sibling Google upload APIs:
 *
 *   - The resumable phases use POST, not PUT, with Authorization on every one.
 *   - There is no 308 in this protocol. Success is 200 everywhere.
 *   - Every protocol violation returns a bare 400 with no X-Goog-Upload-Status,
 *     so "bad chunk" and "dead session" are indistinguishable by status alone.
 *   - Re-sending an already-committed offset is REJECTED, not idempotent.
 *   - A partial batch failure came back HTTP 200, not 207.
 *   - One oversized fileName rejects the entire batch, losing every item in it.
 */

import { MAX_BATCH_ITEMS, MAX_GOOGLE_FILENAME, DEFAULT_CHUNK_GRANULARITY } from "../index.js";
import { accessToken } from "./auth.js";

const API = "https://photoslibrary.googleapis.com";

export interface UploadSession {
  url: string;
  granularity: number;
}

export interface BatchItemResult {
  uploadToken: string;
  /** 0 = created. 3 = permanently unusable media. 6 = already exists. 13 = retry. */
  code: number;
  message: string | null;
  mediaItemId: string | null;
  filename: string | null;
}

export class GooglePhotosError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;
  constructor(message: string, status?: number, retryable = false) {
    super(message);
    this.name = "GooglePhotosError";
    this.status = status;
    this.retryable = retryable;
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await accessToken()}` };
}

/** Names longer than this reject the whole batch, so callers must sanitise first. */
export function sanitizeFilename(name: string): string {
  const trimmed = name.trim() || "untitled";
  if (trimmed.length <= MAX_GOOGLE_FILENAME) return trimmed;
  const dot = trimmed.lastIndexOf(".");
  const ext = dot > 0 && trimmed.length - dot <= 12 ? trimmed.slice(dot) : "";
  return trimmed.slice(0, MAX_GOOGLE_FILENAME - ext.length) + ext;
}

export class GooglePhotosClient {
  /** Open a resumable session. Granularity is read from the response, never assumed. */
  async startSession(totalBytes: number, mimeType: string): Promise<UploadSession> {
    const res = await fetch(`${API}/v1/uploads`, {
      method: "POST",
      headers: {
        ...(await authHeaders()),
        "Content-Length": "0",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Content-Type": mimeType,
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Raw-Size": String(totalBytes),
      },
    });
    if (!res.ok) {
      throw new GooglePhotosError(`Could not start upload session (${res.status})`, res.status, res.status >= 500);
    }
    const url = res.headers.get("x-goog-upload-url");
    if (!url) throw new GooglePhotosError("Upload session returned no X-Goog-Upload-URL");
    const gran = Number(res.headers.get("x-goog-upload-chunk-granularity"));
    return { url, granularity: Number.isFinite(gran) && gran > 0 ? gran : DEFAULT_CHUNK_GRANULARITY };
  }

  /**
   * Send one chunk. Non-final chunks must be an exact multiple of granularity.
   * Returns the upload token when `finalize` is set — it arrives as raw text, not JSON.
   */
  async sendChunk(session: UploadSession, data: Uint8Array, offset: number, finalize: boolean): Promise<string | null> {
    const res = await fetch(session.url, {
      method: "POST",
      headers: {
        ...(await authHeaders()),
        "Content-Length": String(data.byteLength),
        "X-Goog-Upload-Command": finalize ? "upload, finalize" : "upload",
        "X-Goog-Upload-Offset": String(offset),
      },
      body: data,
    });
    if (!res.ok) {
      throw new GooglePhotosError(
        `Chunk at offset ${offset} rejected (${res.status})`,
        res.status,
        res.status >= 500 || res.status === 429,
      );
    }
    return finalize ? (await res.text()).trim() : null;
  }

  /**
   * Ask the server how much it actually holds.
   *
   * This is the only way to tell a recoverable bad chunk from a dead session, since
   * both return 400. Never replay a committed offset — that is itself rejected.
   */
  async queryOffset(session: UploadSession): Promise<{ status: string | null; committed: number } | null> {
    const res = await fetch(session.url, {
      method: "POST",
      headers: { ...(await authHeaders()), "Content-Length": "0", "X-Goog-Upload-Command": "query" },
    });
    if (!res.ok) return null; // session is gone — the caller must restart
    const status = res.headers.get("x-goog-upload-status");
    const received = Number(res.headers.get("x-goog-upload-size-received"));
    // Size-Received is only meaningful while the session is active.
    if (status !== "active") return { status, committed: 0 };
    return { status, committed: Number.isFinite(received) ? received : 0 };
  }

  /** Single-request upload for small files — fewer round trips, Google's own advice. */
  async uploadWhole(data: Uint8Array, mimeType: string): Promise<string> {
    const res = await fetch(`${API}/v1/uploads`, {
      method: "POST",
      headers: {
        ...(await authHeaders()),
        "Content-type": "application/octet-stream",
        "X-Goog-Upload-Content-Type": mimeType,
        "X-Goog-Upload-Protocol": "raw",
      },
      body: data,
    });
    if (!res.ok) {
      throw new GooglePhotosError(`Upload failed (${res.status})`, res.status, res.status >= 500);
    }
    return (await res.text()).trim();
  }

  /**
   * Create media items. MUST be called serially per user — parallel calls are the
   * documented cause of 500s. HTTP 200 does NOT mean every item succeeded.
   */
  async batchCreate(
    items: Array<{ uploadToken: string; fileName: string }>,
    albumId?: string,
  ): Promise<BatchItemResult[]> {
    if (items.length === 0) return [];
    if (items.length > MAX_BATCH_ITEMS) {
      throw new GooglePhotosError(`batchCreate accepts at most ${MAX_BATCH_ITEMS} items`);
    }
    // De-duplicate within the batch or Google manufactures spurious ALREADY_EXISTS.
    const seen = new Set<string>();
    const unique = items.filter((i) => (seen.has(i.uploadToken) ? false : (seen.add(i.uploadToken), true)));

    const body: Record<string, unknown> = {
      newMediaItems: unique.map((i) => ({
        // description is deliberately omitted: Google's policy forbids auto-generated text.
        simpleMediaItem: { uploadToken: i.uploadToken, fileName: sanitizeFilename(i.fileName) },
      })),
    };
    if (albumId) body["albumId"] = albumId;

    const res = await fetch(`${API}/v1/mediaItems:batchCreate`, {
      method: "POST",
      headers: { ...(await authHeaders()), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (!res.ok) {
      const err = (json["error"] ?? {}) as Record<string, unknown>;
      const message = String(err["message"] ?? res.status);
      // Batch-level failures create nothing, but leave every upload token valid.
      throw new GooglePhotosError(
        `batchCreate rejected the whole batch: ${message}`,
        res.status,
        res.status >= 500 || res.status === 429,
      );
    }

    const results = (json["newMediaItemResults"] ?? []) as Array<Record<string, unknown>>;
    return results.map((r, i) => {
      const status = (r["status"] ?? {}) as Record<string, unknown>;
      const mediaItem = (r["mediaItem"] ?? null) as Record<string, unknown> | null;
      return {
        uploadToken: unique[i]?.uploadToken ?? "",
        code: typeof status["code"] === "number" ? status["code"] : 0,
        message: typeof status["message"] === "string" ? status["message"] : null,
        mediaItemId: mediaItem && typeof mediaItem["id"] === "string" ? mediaItem["id"] : null,
        filename: mediaItem && typeof mediaItem["filename"] === "string" ? mediaItem["filename"] : null,
      };
    });
  }

  async createAlbum(title: string): Promise<{ id: string; title: string }> {
    const res = await fetch(`${API}/v1/albums`, {
      method: "POST",
      headers: { ...(await authHeaders()), "Content-Type": "application/json" },
      body: JSON.stringify({ album: { title: title.slice(0, 500) } }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof json["id"] !== "string") {
      throw new GooglePhotosError(`Could not create album: ${JSON.stringify(json).slice(0, 200)}`, res.status);
    }
    return { id: json["id"], title: String(json["title"] ?? title) };
  }

  /** Only albums this app created are visible — a Google restriction, not a bug. */
  async listAlbums(): Promise<Array<{ id: string; title: string; itemCount: number; writeable: boolean }>> {
    const out: Array<{ id: string; title: string; itemCount: number; writeable: boolean }> = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${API}/v1/albums`);
      url.searchParams.set("pageSize", "50");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const res = await fetch(url, { headers: await authHeaders() });
      if (!res.ok) throw new GooglePhotosError(`Could not list albums (${res.status})`, res.status);
      const json = (await res.json()) as Record<string, unknown>;
      for (const a of (json["albums"] ?? []) as Array<Record<string, unknown>>) {
        out.push({
          id: String(a["id"]),
          title: String(a["title"] ?? ""),
          itemCount: Number(a["mediaItemsCount"] ?? 0),
          writeable: a["isWriteable"] === true,
        });
      }
      pageToken = typeof json["nextPageToken"] === "string" ? json["nextPageToken"] : undefined;
    } while (pageToken);
    return out;
  }
}
