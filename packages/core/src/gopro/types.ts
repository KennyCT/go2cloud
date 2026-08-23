/**
 * GoPro Cloud response shapes.
 *
 * Schemas are deliberately loose: the API is undocumented, returns ~70 fields per
 * media row, and adds fields without notice. We validate only what we depend on and
 * pass the rest through, so an upstream addition never breaks a scan.
 */

import { z } from "zod";

export const MediaRow = z
  .object({
    id: z.string(),
    type: z.string().nullish(),
    filename: z.string().nullish(),
    file_extension: z.string().nullish(),
    file_size: z.union([z.number(), z.string()]).nullish(),
    width: z.number().nullish(),
    height: z.number().nullish(),
    captured_at: z.string().nullish(),
    captured_at_timezone: z.string().nullish(),
    created_at: z.string().nullish(),
    item_count: z.number().nullish(),
    /** Superset of the /download variation labels — usable as a cheap pre-flight predicate. */
    available_labels: z.array(z.string()).nullish(),
    mce_type: z.string().nullish(),
    play_as: z.string().nullish(),
    ready_to_view: z.boolean().nullish(),
  })
  .loose();
export type MediaRow = z.infer<typeof MediaRow>;

export const Pages = z
  .object({
    current_page: z.number(),
    per_page: z.number(),
    total_items: z.number(),
    total_pages: z.number(),
  })
  .loose();

export const SearchResponse = z
  .object({
    _embedded: z.object({ media: z.array(MediaRow).nullish() }).loose(),
    _pages: Pages,
  })
  .loose();

/** One downloadable asset. Note there is NO size field — HEAD the URL for that. */
export const Variation = z
  .object({
    label: z.string().nullish(),
    type: z.string().nullish(),
    quality: z.string().nullish(),
    width: z.number().nullish(),
    height: z.number().nullish(),
    item_number: z.number().nullish(),
    available: z.boolean().nullish(),
    url: z.string().nullish(),
    head: z.string().nullish(),
  })
  .loose();
export type Variation = z.infer<typeof Variation>;

/**
 * /media/{id}/download. Four arrays, not two.
 * `files[]` is a PROXY for video (observed 1280x720 against a 3840x2160 source) —
 * never treat it as the original. `sprites` uses plural urls/heads and will throw a
 * naive `.url` accessor. `sidecar_files` is telemetry, never user media.
 */
export const DownloadManifest = z
  .object({
    filename: z.string().nullish(),
    _embedded: z
      .object({
        variations: z.array(Variation).nullish(),
        files: z.array(Variation).nullish(),
        sprites: z.array(z.unknown()).nullish(),
        sidecar_files: z.array(z.unknown()).nullish(),
      })
      .loose(),
  })
  .loose();
export type DownloadManifest = z.infer<typeof DownloadManifest>;

/** /media/items uses a bare envelope — NO _embedded wrapper. Shared parsers break here. */
export const MediaItemsResponse = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string(),
            type: z.string().nullish(),
            label: z.string().nullish(),
            title: z.string().nullish(),
            root: z.boolean().nullish(),
            parent_ids: z.array(z.string()).nullish(),
            item_ids: z.array(z.string()).nullish(),
            medium: MediaRow.nullish(),
          })
          .loose(),
      )
      .nullish(),
    _pages: Pages.nullish(),
  })
  .loose();
export type MediaItemsResponse = z.infer<typeof MediaItemsResponse>;

export function bytesOf(row: MediaRow): number {
  const v = row.file_size;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
