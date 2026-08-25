/**
 * GoPro Cloud response shapes.
 *
 * The API is undocumented, returns ~70 fields per media row, and changes field
 * types without notice — `ready_to_view` was declared boolean here and arrives as
 * a string, which aborted a whole 212-item scan on first contact with live data.
 *
 * So: `id` is the only field that is genuinely required. Every other field is
 * wrapped in `.catch(undefined)`, meaning a type change upstream degrades that one
 * field to undefined instead of failing the request. An undocumented API drifting
 * must never cost a user their scan.
 */

import { z } from "zod";

/** Optional field that yields undefined rather than throwing on an unexpected type. */
const soft = <T extends z.ZodType>(schema: T) => schema.nullish().catch(undefined);

/** Fields GoPro types inconsistently (booleans as strings, numbers as strings). */
const softBool = soft(
  z.union([z.boolean(), z.string()]).transform((v) => (typeof v === "boolean" ? v : v === "true" || v === "1")),
);
const softNum = soft(z.union([z.number(), z.string()]).transform((v) => typeof v === "number" ? v : Number.parseInt(v, 10)));
const softStr = soft(z.string());

export const MediaRow = z
  .object({
    id: z.string(), // the only genuinely required field
    type: softStr,
    filename: softStr,
    file_extension: softStr,
    file_size: softNum,
    width: softNum,
    height: softNum,
    captured_at: softStr,
    captured_at_timezone: softStr,
    created_at: softStr,
    item_count: softNum,
    /** Superset of the /download variation labels — a cheap pre-flight predicate. */
    available_labels: soft(z.array(z.string())),
    mce_type: softStr,
    play_as: softStr,
    /**
     * Despite the name this is a processing-state STRING (observed: "ready"), not
     * a boolean. Coercing it to a boolean silently yields false for every item.
     */
    ready_to_view: softStr,
    token: softStr,
    source_duration: softNum,
  })
  .loose();
export type MediaRow = z.infer<typeof MediaRow>;

// _pages drives the completeness assertion, so these must parse — but tolerate
// numbers arriving as strings, which this API does elsewhere.
const pageNum = z.union([z.number(), z.string()]).transform((v) => typeof v === "number" ? v : Number.parseInt(v, 10));
export const Pages = z
  .object({
    current_page: pageNum,
    per_page: pageNum,
    total_items: pageNum,
    total_pages: pageNum,
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
    label: softStr,
    type: softStr,
    quality: softStr,
    width: softNum,
    height: softNum,
    item_number: softNum,
    available: softBool,
    url: softStr,
    head: softStr,
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
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
