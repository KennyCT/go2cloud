/**
 * Choosing what to show a human, as opposed to what to upload.
 *
 * `selectAssets` insists on the ORIGINAL because those bytes land in someone's
 * library permanently. A preview wants the exact opposite: the smallest thing that
 * still shows what the clip is. Handing a browser the 8 GB source to scrub through
 * would be wrong in every direction — bandwidth, memory, and time to first frame.
 *
 * GoPro transcodes proxies for its own web player, so they cost nothing extra:
 * `edit_proxy` is 720p, while `high_res_proxy_mp4` matches the source resolution
 * (2160p on a real 4K clip), so "high res" is literal and it is NOT the 1080p proxy
 * the name suggests.
 */

import type { DownloadManifest, MediaRow, Variation } from "./types.js";

/** Preferred labels, cheapest first. Anything unlisted sorts after these, by size. */
const VIDEO_PREFERENCE = ["edit_proxy", "high_res_proxy_mp4", "baked_source", "source"];

/** Containers a browser's <video> element can actually play. */
const PLAYABLE = new Set(["mp4", "m4v", "mov", "webm"]);

export interface PreviewAsset {
  label: string;
  url: string;
  /**
   * Container of the rendition itself, e.g. "mp4".
   *
   * Carried out deliberately: the medium's own filename is NOT a safe source of MIME
   * for the proxy. A Quik edit is named `*.json` while its baked_source is an mp4, and
   * an older Hero clip is `*.MOV` while its proxy is mp4 (PLAN.md §7.5). Typing the
   * stream from the filename would send `application/octet-stream` for the first and
   * the wrong container for the second — and the CDN's own content-type is useless,
   * which is the entire reason the bytes are proxied.
   */
  container: string;
  width: number | null;
  height: number | null;
  /** Which chapter this is. A chaptered video is one medium with several files. */
  itemNumber: number;
  /** How many chapters exist at this label — the UI says "1 of 3" rather than lying. */
  chapters: number;
}

/**
 * Whether a row is footage or a still.
 *
 * `play_as` is what GoPro's own player switches on, and it was present and
 * unambiguous ("video" | "photo") on every live row observed. `type` is the fallback
 * for rows where the API drops it.
 */
export function previewKind(row: MediaRow): "video" | "photo" {
  if (row.play_as === "video") return "video";
  if (row.play_as === "photo") return "photo";
  return String(row.type ?? "").toLowerCase().includes("photo") ? "photo" : "video";
}

const usable = (v: Variation) => v.available !== false && typeof v.url === "string" && v.url.length > 0;
const area = (v: Variation) => (v.width ?? 0) * (v.height ?? 0);

/**
 * The cheapest playable rendition of a video, or null when GoPro has produced none.
 *
 * Null is a real answer rather than a failure: a medium still transcoding lists its
 * variations with `available: false`, and a format the browser has no decoder for may
 * offer nothing in PLAYABLE. The caller falls back to the still thumbnail.
 *
 * No account with a `.360` has been observed yet (PLAN.md §11, U10), so whether GoPro
 * publishes a rectilinear mp4 proxy for one is genuinely unknown. Either way this is
 * correct: if such a proxy exists it is returned and plays, and if it does not, null.
 */
export function selectPreview(row: MediaRow, manifest: DownloadManifest): PreviewAsset | null {
  if (previewKind(row) !== "video") return null;

  const candidates = (manifest._embedded.variations ?? []).filter(
    (v) => usable(v) && PLAYABLE.has(String(v.type ?? "").toLowerCase()),
  );
  if (candidates.length === 0) return null;

  const rank = (v: Variation) => {
    const i = VIDEO_PREFERENCE.indexOf(String(v.label ?? ""));
    return i === -1 ? VIDEO_PREFERENCE.length : i;
  };
  const best = candidates.slice().sort(
    (a, b) => rank(a) - rank(b) || area(a) - area(b) || (a.item_number ?? 1) - (b.item_number ?? 1),
  )[0]!;

  // Chapters share a label and differ by item_number; preview the first one.
  const label = String(best.label ?? "unknown");
  const sameLabel = candidates.filter((v) => String(v.label ?? "unknown") === label);
  const first = sameLabel.slice().sort((a, b) => (a.item_number ?? 1) - (b.item_number ?? 1))[0]!;

  return {
    label,
    url: first.url as string,
    container: String(first.type ?? "mp4").toLowerCase(),
    width: first.width ?? null,
    height: first.height ?? null,
    itemNumber: first.item_number ?? 1,
    chapters: sameLabel.length,
  };
}
