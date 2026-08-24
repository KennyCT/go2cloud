/**
 * GoPro Cloud HTTP client.
 *
 * Undocumented API. Every non-obvious behaviour here is evidence-backed — see
 * PLAN.md §2.4 and docs/probe-results*.json. Do not "clean up" without reading them.
 */

import { GOPRO_ACCEPT, GOPRO_PAGE_SIZE } from "../index.js";
import { classify, GoProError } from "./errors.js";
import { currentAccessToken, loadTokens, refreshTokens } from "./auth.js";
import { DownloadManifest, MediaItemsResponse, MediaRow, SearchResponse } from "./types.js";

const API = "https://api.gopro.com";
const USER_AGENT = "go2cloud/0.1 (+https://github.com/KennyCT/go2cloud)";

/** Fields worth requesting. Unknown names are silently dropped, so a superset is safe. */
export const SEARCH_FIELDS = [
  "id", "type", "filename", "file_extension", "file_size", "width", "height",
  "captured_at", "captured_at_timezone", "created_at", "item_count",
  "available_labels", "mce_type", "play_as", "ready_to_view",
].join(",");

export interface SearchFilter {
  /** Capture-date window. Send an explicit end-of-day — a zero-width range returns 0. */
  capturedFrom?: Date | undefined;
  capturedTo?: Date | undefined;
  /** Upload-date window. `created_range` is a real server-side filter (verified). */
  createdFrom?: Date | undefined;
  createdTo?: Date | undefined;
  types?: string[] | undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isoRange(from?: Date, to?: Date): string | null {
  if (!from || !to) return null;
  return `${from.toISOString()},${to.toISOString()}`;
}

export interface ClientOptions {
  maxRetries?: number | undefined;
  onWarn?: ((message: string) => void) | undefined;
}

export class GoProClient {
  private readonly maxRetries: number;
  private readonly warn: (m: string) => void;
  private refreshedOnce = false;

  constructor(opts: ClientOptions = {}) {
    this.maxRetries = opts.maxRetries ?? 4;
    this.warn = opts.onWarn ?? (() => {});
  }

  private async request(path: string, params?: Record<string, string>): Promise<unknown> {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);

    let lastError: GoProError | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const token = await currentAccessToken();
      if (!token) throw new GoProError("unauthorized", "Not signed in to GoPro. Run `go2cloud auth gopro`.");

      let res: Response;
      try {
        res = await fetch(url, {
          headers: {
            // Mandatory. Without it every path returns 406, before auth is even checked.
            Accept: GOPRO_ACCEPT,
            Authorization: `Bearer ${token}`,
            "User-Agent": USER_AGENT,
          },
        });
      } catch (cause) {
        lastError = new GoProError("network", `Network failure: ${String(cause)}`);
        await sleep(Math.min(1000 * 2 ** attempt, 30_000));
        continue;
      }

      if (res.ok) return res.json();

      const body = await res.text().catch(() => "");
      const err = classify(res.status, body);

      // A 401 — and, on an authenticated call, sometimes a 500 — can mean a dead
      // token rather than a dead server. Try exactly one refresh before giving up.
      if ((err.kind === "unauthorized" || err.kind === "server") && !this.refreshedOnce) {
        const tokens = loadTokens();
        if (tokens?.refreshToken) {
          this.refreshedOnce = true;
          try {
            await refreshTokens(tokens);
            continue;
          } catch {
            /* fall through to normal handling */
          }
        }
      }
      if (err.kind === "version-gone") throw err; // deprecation canary — never retry
      if (!err.retryable) throw err;

      lastError = err;
      // 429 carries no guaranteed Retry-After, so always keep the exponential fallback.
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(1000 * 2 ** attempt, 30_000);
      await sleep(waitMs);
    }
    throw lastError ?? new GoProError("unknown", "Request failed after retries");
  }

  /**
   * Fetch one page, retrying when the server returns a short page.
   *
   * /media/search intermittently returns fewer rows than requested with a perfectly
   * healthy-looking 200 and coherent _pages — 12 rows against total_items=212 was
   * observed live. A short page is indistinguishable from a complete one, so it must
   * be detected by arithmetic. Without this a scan silently misses most of a library.
   */
  private async searchPage(page: number, filter: SearchFilter): Promise<{ rows: MediaRow[]; total: number }> {
    const params: Record<string, string> = {
      fields: SEARCH_FIELDS,
      per_page: String(GOPRO_PAGE_SIZE),
      page: String(page),
      order_by: "captured_at",
    };
    const captured = isoRange(filter.capturedFrom, filter.capturedTo);
    if (captured) params["captured_range"] = captured;
    const created = isoRange(filter.createdFrom, filter.createdTo);
    if (created) params["created_range"] = created;
    if (filter.types?.length) params["type"] = filter.types.join(",");

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const parsed = SearchResponse.parse(await this.request("/media/search", params));
      const rows = parsed._embedded.media ?? [];
      const total = parsed._pages.total_items;
      const offset = (page - 1) * GOPRO_PAGE_SIZE;
      const expected = Math.max(0, Math.min(GOPRO_PAGE_SIZE, total - offset));

      if (rows.length >= expected) return { rows, total };

      this.warn(
        `GoPro returned a short page (${rows.length}/${expected} on page ${page}); retrying — ` +
          `this is a known API defect, not a client bug.`,
      );
      await sleep(Math.min(500 * 2 ** attempt, 8000));
    }
    throw new GoProError(
      "unknown",
      `Page ${page} kept returning fewer rows than total_items promises. Refusing to continue ` +
        `with an incomplete library view.`,
    );
  }

  /** Walk the whole library, asserting completeness. Throws rather than under-reporting. */
  async *search(filter: SearchFilter = {}): AsyncGenerator<MediaRow> {
    const seen = new Set<string>();
    let page = 1;
    let total = Number.POSITIVE_INFINITY;

    while (true) {
      const { rows, total: reported } = await this.searchPage(page, filter);
      total = reported;
      for (const row of rows) {
        if (!seen.has(row.id)) {
          seen.add(row.id);
          yield row;
        }
      }
      if (rows.length === 0 || seen.size >= total || page * GOPRO_PAGE_SIZE >= total) break;
      page++;
    }

    if (Number.isFinite(total) && seen.size < total) {
      throw new GoProError(
        "unknown",
        `Scan incomplete: found ${seen.size} of ${total} items. Refusing to proceed — a partial ` +
          `scan would silently skip media.`,
      );
    }
  }

  async downloadManifest(mediaId: string): Promise<DownloadManifest> {
    return DownloadManifest.parse(await this.request(`/media/${mediaId}/download`));
  }

  /** Albums live under /media/items, not /collections (which is share-links). */
  async albums(): Promise<MediaItemsResponse> {
    return MediaItemsResponse.parse(
      await this.request("/media/items", { type: "collection", per_page: "100", page: "1" }),
    );
  }

  async albumMembers(albumId: string): Promise<MediaItemsResponse> {
    return MediaItemsResponse.parse(
      await this.request("/media/items", { parent_id: albumId, per_page: "100", page: "1" }),
    );
  }

  /**
   * Media inside an album, as full rows.
   *
   * /media/search cannot filter by album — parent_id is null on every row and passing
   * it as a parameter is silently ignored. But /media/items inlines the whole medium
   * object alongside membership, so one request per album yields both.
   */
  async albumMedia(albumId: string): Promise<MediaRow[]> {
    const out: MediaRow[] = [];
    for (let page = 1; page <= 20; page++) {
      const res = MediaItemsResponse.parse(
        await this.request("/media/items", { parent_id: albumId, per_page: "100", page: String(page) }),
      );
      const items = res.items ?? [];
      for (const item of items) if (item.medium) out.push(item.medium);
      const pages = res._pages;
      if (items.length === 0 || !pages || page >= pages.total_pages) break;
    }
    return out;
  }

  /**
   * Real albums only.
   *
   * Excludes share links (label !== "mural") and the account's root container, which
   * is itself a mural-labelled collection that every real album lists in parent_ids.
   * Including it would offer the user an "album" holding their entire library.
   */
  async albumList(): Promise<Array<{ id: string; title: string }>> {
    const res = await this.albums();
    const items = (res.items ?? []).filter((i) => i.type === "collection" && i.label === "mural");
    const rootIds = new Set(items.flatMap((i) => i.parent_ids ?? []));
    return items
      .filter((i) => i.root !== true && !rootIds.has(i.id))
      .map((i) => ({ id: i.id, title: i.title ?? "(untitled)" }));
  }
}
