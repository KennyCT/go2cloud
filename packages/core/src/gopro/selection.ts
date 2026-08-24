/**
 * Choosing which asset to upload.
 *
 * Two live-verified traps make the obvious implementations wrong (PLAN.md §7.5):
 *
 *   1. `variations[0]` was `edit_proxy` at 720p on a real 4K video.
 *   2. `files[0]` was 1280x720 while the `source` variation was 3840x2160.
 *
 * Either mistake silently uploads a downscaled re-encode AND loses the capture
 * metadata Google Photos needs to date the item correctly. Neither fails loudly.
 */

import { ORIGINAL_LABELS } from "../index.js";
import type { DownloadManifest, MediaRow, Variation } from "./types.js";

/** Extensions Google Photos will not accept, or will accept and pollute the library with. */
const DENY_EXTENSIONS = new Set([
  "360", // GoPro MAX/Fusion — Google Photos cannot read it
  "gpr", // GoPro RAW
  "lrv", // low-res proxy: an ordinary MP4, so it uploads happily and pollutes
  "thm", // fisheye thumbnail: an ordinary JPEG, same problem
]);

export type SkipReason =
  | "quik-edit-project"
  | "unsupported-format"
  | "no-downloadable-asset";

export interface SelectedAsset {
  /** 1-based chapter/frame index. A chaptered video is ONE media id with N of these. */
  itemNumber: number;
  label: string;
  url: string;
  headUrl: string | null;
  width: number | null;
  height: number | null;
  /** True when we fell back to a proxy — quality and capture dates are degraded. */
  degraded: boolean;
}

export interface Selection {
  assets: SelectedAsset[];
  skip: SkipReason | null;
  warning: string | null;
}

export interface SelectionOptions {
  /**
   * How to handle a chaptered video — one GoPro medium containing N chapter files.
   *
   * "split"  uploads each chapter as its own Google Photos item. Default, because it
   *          sends the original bytes and so preserves capture metadata exactly.
   * "concat" uploads GoPro's server-stitched single file instead, giving one
   *          continuous clip with no ffmpeg and no disk. It is a re-render, so its
   *          metadata fidelity is unverified, and it falls back to "split" when GoPro
   *          has not produced a concat for that medium.
   */
  chapters?: "split" | "concat" | undefined;
  /** Force a specific variation label instead of preferring an original. */
  variant?: string | undefined;
}

const area = (v: Variation) => (v.width ?? 0) * (v.height ?? 0);
const usable = (v: Variation) => v.available !== false && typeof v.url === "string" && v.url.length > 0;

function toAsset(v: Variation, fallbackIndex: number, degraded: boolean): SelectedAsset {
  return {
    itemNumber: v.item_number ?? fallbackIndex,
    label: v.label ?? "unknown",
    url: v.url as string,
    headUrl: typeof v.head === "string" ? v.head : null,
    width: v.width ?? null,
    height: v.height ?? null,
    degraded,
  };
}

export function selectAssets(
  row: MediaRow,
  manifest: DownloadManifest,
  options: SelectionOptions = {},
): Selection {
  // 1. Quik edit projects are not real media — GoPro's own web grid hides them.
  if (row.play_as === "edl" && row.mce_type === "user_created") {
    return { assets: [], skip: "quik-edit-project", warning: null };
  }

  // 2. Reject by extension before spending any bandwidth.
  const ext = (row.file_extension ?? row.filename?.split(".").pop() ?? "").toLowerCase();
  if (DENY_EXTENSIONS.has(ext)) {
    return { assets: [], skip: "unsupported-format", warning: null };
  }

  const variations = (manifest._embedded.variations ?? []).filter(usable);
  const files = (manifest._embedded.files ?? []).filter(usable);

  // An explicit --variant overrides everything, including the original-only rule.
  if (options.variant) {
    const wanted = variations.filter((v) => v.label === options.variant);
    if (wanted.length > 0) {
      const degraded = !ORIGINAL_LABELS.includes(options.variant as never);
      return {
        assets: wanted
          .slice()
          .sort((a, b) => (a.item_number ?? 1) - (b.item_number ?? 1))
          .map((v, i) => toAsset(v, i + 1, degraded)),
        skip: null,
        warning: degraded
          ? `Using variant "${options.variant}" for ${row.filename ?? row.id} instead of the ` +
            `original; quality and the capture date may be degraded.`
          : null,
      };
    }
    return {
      assets: [],
      skip: "no-downloadable-asset",
      warning: `${row.filename ?? row.id} has no "${options.variant}" variant.`,
    };
  }

  // 3. Originals only. A chaptered video yields several of these, one per item_number.
  const originals = variations.filter((v) => ORIGINAL_LABELS.includes((v.label ?? "") as never));
  if (originals.length > 0) {
    const sorted = [...originals].sort((a, b) => (a.item_number ?? 1) - (b.item_number ?? 1));

    // Prefer GoPro's stitched rendering when asked, but only if it actually exists.
    if (options.chapters === "concat" && sorted.length > 1) {
      const concat = variations.find((v) => v.label === "concat");
      if (concat) {
        return {
          assets: [toAsset(concat, 1, false)],
          skip: null,
          warning:
            `${row.filename ?? row.id}: uploading GoPro's stitched "concat" rendering as one ` +
            `clip instead of ${sorted.length} chapters. It is a re-render, so its embedded ` +
            `capture date may differ from the source.`,
        };
      }
      return {
        assets: sorted.map((v, i) => toAsset(v, i + 1, false)),
        skip: null,
        warning:
          `${row.filename ?? row.id} has no "concat" rendering, so its ${sorted.length} chapters ` +
          `will upload separately.`,
      };
    }

    return {
      assets: sorted.map((v, i) => toAsset(v, i + 1, false)),
      skip: null,
      warning:
        sorted.length > 1
          ? `${row.filename ?? row.id} is chaptered (${sorted.length} parts) and will upload as ` +
            `${sorted.length} separate items.`
          : null,
    };
  }

  // 4a. Burst / TimeLapse expand to one Google Photos item per frame.
  if (row.type === "Burst" || row.type === "TimeLapse") {
    if (files.length > 0) {
      return {
        assets: files
          .slice()
          .sort((a, b) => (a.item_number ?? 1) - (b.item_number ?? 1))
          .map((v, i) => toAsset(v, i + 1, false)),
        skip: null,
        warning: `${row.filename ?? row.id} is a ${row.type} and expands to ${files.length} items.`,
      };
    }
  }

  // 4b. No labelled original. Fall back to the largest asset available, but say so —
  // this costs resolution and very likely the embedded capture date.
  const pool = [...variations, ...files];
  if (pool.length === 0) {
    return { assets: [], skip: "no-downloadable-asset", warning: null };
  }
  const best = pool.reduce((a, b) => (area(b) > area(a) ? b : a));
  return {
    assets: [toAsset(best, 1, true)],
    skip: null,
    warning:
      `${row.filename ?? row.id} has no "source" variation; falling back to "${best.label ?? "unknown"}" ` +
      `(${best.width ?? "?"}x${best.height ?? "?"}). Quality and the capture date may be degraded.`,
  };
}

/** Cheap pre-flight predicate — avoids one /download call per item during planning. */
export function likelyHasOriginal(row: MediaRow): boolean {
  const labels = row.available_labels;
  if (!labels || labels.length === 0) return true; // unknown: assume yes, resolve later
  return labels.some((l) => ORIGINAL_LABELS.includes(l as never));
}
