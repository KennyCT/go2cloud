/**
 * @go2cloud/core — engine shared by the CLI and the web UI.
 *
 * Design decisions and the evidence behind them live in docs/PLAN.md. Much of
 * what looks arbitrary here is a workaround for undocumented GoPro API behaviour
 * or verified Google Photos protocol quirks — check the plan before "simplifying".
 */

export const VERSION = "0.1.0";

/** Vendor mediatype required on every api.gopro.com request; omitting it returns 406. */
export const GOPRO_ACCEPT = "application/vnd.gopro.jk.media+json; version=2.0.0";

/**
 * Page size for /media/search. Deliberately 50, not 200: larger pages were
 * observed returning short results (12 rows against total_items=212) with a
 * coherent-looking 200 response. See PLAN.md §2.4.
 */
export const GOPRO_PAGE_SIZE = 50;

/** GoPro signed CDN URLs expire in exactly 3600s; re-resolve before then. PLAN.md §7.2. */
export const GOPRO_URL_TTL_MS = 3_600_000;
export const GOPRO_URL_REFRESH_MARGIN_MS = 60_000;

/** Variation labels that denote an original rather than a proxy. PLAN.md §7.5. */
export const ORIGINAL_LABELS = ["source", "baked_source"] as const;

/**
 * Ceiling on an ORIGINAL streamed as a preview.
 *
 * Preview normally streams one of GoPro's proxies, which are small by construction.
 * Where GoPro has produced none, the only playable thing left is the original — and
 * a peek at a 7 GB 4K file pulls full-quality bytes for every second watched. Ranged
 * streaming bounds that by what you actually watch, not by the file size, but on a
 * weak connection even a few seconds is painful, so past this size preview declines
 * and says why rather than quietly hammering the link.
 *
 * Sized to be no worse than a large proxy: the biggest proxy measured on a live
 * account was 290 MB (for an 8.7 GB source). Measured on that same account, the
 * fallback is rare — 24 of 25 sampled videos had an `edit_proxy`, and the one that
 * did not was a Quik edit, which is not transferable and so is not previewable.
 */
export const PREVIEW_ORIGINAL_MAX_BYTES = 500 * 1024 * 1024;

/** Google rejects a whole batch if any fileName exceeds this. PLAN.md §7.6. */
export const MAX_GOOGLE_FILENAME = 255;

/** mediaItems:batchCreate hard limit. */
export const MAX_BATCH_ITEMS = 50;

/**
 * Upload mode threshold. Below this, one request; above it, chunked.
 *
 * Chunking is quota-free — verified 2026-08-23 by a differential test in which 32
 * requests to /v1/uploads left the project's daily Library API counter unchanged
 * (PLAN.md §7.3). So chunk size trades memory against resume granularity only.
 */
export const SINGLE_REQUEST_MAX_BYTES = 256 * 1024 * 1024;

/** Chunk size for large files: a dropped connection costs <=64 MB, not the whole file. */
export const UPLOAD_CHUNK_BYTES = 64 * 1024 * 1024;

/**
 * Fallback granularity. Observed to be 262144 for every declared size (1 MB, 200 MB,
 * 5 GB) and both image/jpeg and video/mp4 — but still read
 * X-Goog-Upload-Chunk-Granularity from the session-start response rather than
 * trusting this. Non-final chunks must be an exact multiple; the final chunk is exempt.
 */
export const DEFAULT_CHUNK_GRANULARITY = 262_144;

// The two auth modules both expose loadTokens/saveTokens, so they are namespaced
// rather than flattened — `goproAuth.loadTokens()` vs `googleAuth.loadTokens()`.
export * as goproAuth from "./gopro/auth.js";
export * as googleAuth from "./google/auth.js";

export * from "./gopro/client.js";
export * from "./gopro/errors.js";
export * from "./gopro/preview.js";
export * from "./gopro/selection.js";
export * from "./gopro/types.js";
export * from "./google/client.js";
export * from "./state/db.js";
export * from "./transfer/engine.js";
export * from "./transfer/mime.js";
export * from "./util/keychain.js";
