/**
 * Fixtures are real /media/{id}/download responses captured from a live GoPro
 * Cloud account on 2026-08-23 (docs/probe-results.json), with signed URLs replaced.
 * They exist to pin the two traps that silently degrade quality.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { selectAssets, likelyHasOriginal } from "./selection.js";
import type { DownloadManifest, MediaRow } from "./types.js";

const url = (n: string) => `https://media-cdn-vod.gopro.com/${n}?Signature=x`;

/** Real 4K video: variations[0] is a 720p edit_proxy and files[0] is 720p. */
const VIDEO: DownloadManifest = {
  _embedded: {
    variations: [
      { label: "edit_proxy", type: "mp4", quality: "720p", width: 1280, height: 720, available: true, url: url("proxy"), head: url("proxy-h") },
      { label: "audio_proxy", type: "m4a", quality: "0p", width: 0, height: 0, available: true, url: url("audio"), head: url("audio-h") },
      { label: "source", type: "mp4", quality: "2160p", width: 3840, height: 2160, available: true, url: url("source"), head: url("source-h") },
      { label: "high_res_proxy_mp4", type: "mp4", quality: "2160p", width: 3840, height: 2160, available: true, url: url("hrp"), head: url("hrp-h") },
    ],
    files: [{ type: null, width: 1280, height: 720, item_number: 1, available: true, url: url("file0"), head: url("file0-h") }],
  },
};

const PHOTO: DownloadManifest = {
  _embedded: {
    variations: [{ label: "source", type: "jpg", quality: "4872p", width: 5568, height: 4872, available: true, url: url("photo"), head: url("photo-h") }],
    files: [{ item_number: 1, width: 5568, height: 4872, available: true, url: url("photo-file"), head: url("photo-file-h") }],
  },
};

const MCE: DownloadManifest = {
  _embedded: {
    variations: [{ label: "baked_source", type: "mp4", quality: "2156p", width: 2464, height: 2156, available: true, url: url("baked"), head: url("baked-h") }],
    files: [{ item_number: 1, width: 2464, height: 2156, available: true, url: url("mce-file"), head: url("mce-file-h") }],
  },
};

const row = (o: Partial<MediaRow> = {}): MediaRow => ({ id: "m1", type: "Video", filename: "GX010174.MP4", file_extension: "mp4", ...o });

test("picks source, never variations[0] (which is a 720p edit_proxy)", () => {
  const s = selectAssets(row(), VIDEO);
  assert.equal(s.skip, null);
  assert.equal(s.assets.length, 1);
  assert.equal(s.assets[0]?.label, "source");
  assert.equal(s.assets[0]?.height, 2160, "must be the 4K source, not the 720p proxy");
  assert.equal(s.assets[0]?.degraded, false);
});

test("ignores files[], which is a 720p proxy for video", () => {
  const s = selectAssets(row(), VIDEO);
  assert.notEqual(s.assets[0]?.url, url("file0"));
  assert.equal(s.assets[0]?.width, 3840);
});

test("does not mistake high_res_proxy_mp4 for an original despite equal resolution", () => {
  const s = selectAssets(row(), VIDEO);
  assert.equal(s.assets[0]?.label, "source");
});

test("photos expose a source variation and it is full resolution", () => {
  const s = selectAssets(row({ type: "Photo", filename: "GP010214.JPG", file_extension: "jpg" }), PHOTO);
  assert.equal(s.assets[0]?.label, "source");
  assert.equal(s.assets[0]?.width, 5568);
  assert.equal(s.assets[0]?.degraded, false);
});

test("baked_source counts as an original", () => {
  const s = selectAssets(row({ type: "MultiClipEdit", mce_type: "auto_edit", play_as: "video" }), MCE);
  assert.equal(s.assets[0]?.label, "baked_source");
  assert.equal(s.skip, null);
});

test("skips Quik edit projects", () => {
  const s = selectAssets(row({ type: "MultiClipEdit", play_as: "edl", mce_type: "user_created" }), MCE);
  assert.equal(s.skip, "quik-edit-project");
  assert.equal(s.assets.length, 0);
});

test("skips .360 and other denied extensions before spending bandwidth", () => {
  for (const ext of ["360", "gpr", "lrv", "thm"]) {
    const s = selectAssets(row({ file_extension: ext, filename: `X.${ext}` }), VIDEO);
    assert.equal(s.skip, "unsupported-format", `${ext} must be skipped`);
  }
});

test("a chaptered video yields one asset per item_number, in order", () => {
  const chaptered: DownloadManifest = {
    _embedded: {
      variations: [
        { label: "source", item_number: 3, width: 3840, height: 2160, available: true, url: url("c3"), head: null },
        { label: "source", item_number: 1, width: 3840, height: 2160, available: true, url: url("c1"), head: null },
        { label: "source", item_number: 2, width: 3840, height: 2160, available: true, url: url("c2"), head: null },
        { label: "concat", item_number: null, width: 3840, height: 2160, available: true, url: url("concat"), head: null },
      ],
      files: [],
    },
  };
  const s = selectAssets(row({ item_count: 3 }), chaptered);
  assert.equal(s.assets.length, 3, "all three chapters, none dropped");
  assert.deepEqual(s.assets.map((a) => a.itemNumber), [1, 2, 3]);
  assert.ok(s.warning?.includes("chaptered"));
  assert.ok(!s.assets.some((a) => a.label === "concat"), "concat is not a chapter");
});

test("falls back to the largest asset and flags it as degraded", () => {
  const noSource: DownloadManifest = {
    _embedded: {
      variations: [
        { label: "edit_proxy", width: 1280, height: 720, available: true, url: url("p"), head: null },
        { label: "high_res_proxy_mp4", width: 3840, height: 2160, available: true, url: url("h"), head: null },
      ],
      files: [],
    },
  };
  const s = selectAssets(row(), noSource);
  assert.equal(s.assets[0]?.degraded, true);
  assert.equal(s.assets[0]?.height, 2160);
  assert.ok(s.warning?.includes("capture date"));
});

test("ignores variations marked unavailable or lacking a url", () => {
  const partial: DownloadManifest = {
    _embedded: {
      variations: [
        { label: "source", width: 3840, height: 2160, available: false, url: url("dead"), head: null },
        { label: "source", width: 1920, height: 1080, available: true, url: url("live"), head: null },
      ],
      files: [],
    },
  };
  const s = selectAssets(row(), partial);
  assert.equal(s.assets.length, 1);
  assert.equal(s.assets[0]?.height, 1080);
});

test("likelyHasOriginal uses available_labels as a cheap pre-flight predicate", () => {
  assert.equal(likelyHasOriginal(row({ available_labels: ["source", "gpx", "mediainfo"] })), true);
  assert.equal(likelyHasOriginal(row({ available_labels: ["baked_source"] })), true);
  assert.equal(likelyHasOriginal(row({ available_labels: ["edit_proxy", "mediainfo"] })), false);
  assert.equal(likelyHasOriginal(row({ available_labels: [] })), true, "unknown must not skip");
});

// ---- --variant and --chapters ------------------------------------------- //

const CHAPTERED: DownloadManifest = {
  _embedded: {
    variations: [
      { label: "source", item_number: 1, width: 3840, height: 2160, available: true, url: url("c1"), head: null },
      { label: "source", item_number: 2, width: 3840, height: 2160, available: true, url: url("c2"), head: null },
      { label: "concat", item_number: null, width: 3840, height: 2160, available: true, url: url("cc"), head: null },
    ],
    files: [],
  },
};

test("--chapters=concat uploads the stitched rendering as one clip", () => {
  const s = selectAssets(row({ item_count: 2 }), CHAPTERED, { chapters: "concat" });
  assert.equal(s.assets.length, 1);
  assert.equal(s.assets[0]?.label, "concat");
  assert.ok(s.warning?.includes("re-render"), "must warn that metadata may differ");
});

test("--chapters=concat falls back to split when no concat exists", () => {
  const noConcat: DownloadManifest = {
    _embedded: { variations: (CHAPTERED._embedded.variations ?? []).filter((v) => v.label !== "concat"), files: [] },
  };
  const s = selectAssets(row({ item_count: 2 }), noConcat, { chapters: "concat" });
  assert.equal(s.assets.length, 2, "must not silently drop chapters");
  assert.ok(s.warning?.includes("no \"concat\""));
});

test("split remains the default for chaptered media", () => {
  assert.equal(selectAssets(row({ item_count: 2 }), CHAPTERED).assets.length, 2);
});

test("--variant forces a specific label and flags proxies as degraded", () => {
  const s = selectAssets(row(), VIDEO, { variant: "high_res_proxy_mp4" });
  assert.equal(s.assets[0]?.label, "high_res_proxy_mp4");
  assert.equal(s.assets[0]?.degraded, true);
  assert.ok(s.warning?.includes("capture date"));
});

test("--variant=source is not treated as degraded", () => {
  const s = selectAssets(row(), VIDEO, { variant: "source" });
  assert.equal(s.assets[0]?.degraded, false);
  assert.equal(s.warning, null);
});

test("--variant skips cleanly when the label is absent", () => {
  const s = selectAssets(row(), VIDEO, { variant: "does_not_exist" });
  assert.equal(s.skip, "no-downloadable-asset");
  assert.equal(s.assets.length, 0);
});
