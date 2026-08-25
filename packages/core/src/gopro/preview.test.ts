/**
 * Manifest shapes here mirror real /media/{id}/download responses (docs/probe-results.json)
 * with the signed URLs replaced. They pin the choices that would otherwise regress into
 * streaming multi-gigabyte originals at a browser.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { previewKind, selectPreview } from "./preview.js";
import type { DownloadManifest, MediaRow } from "./types.js";

const url = (n: string) => `https://media-cdn-vod.gopro.com/${n}?Signature=x`;

const video = (over: Partial<MediaRow> = {}): MediaRow =>
  ({ id: "m1", play_as: "video", type: "Video", filename: "GX010001.MP4", ...over }) as MediaRow;

const VIDEO: DownloadManifest = {
  _embedded: {
    variations: [
      { label: "high_res_proxy_mp4", type: "mp4", width: 3840, height: 2160, available: true, url: url("hrp") },
      { label: "audio_proxy", type: "m4a", width: 0, height: 0, available: true, url: url("audio") },
      { label: "source", type: "mp4", width: 3840, height: 2160, available: true, url: url("source") },
      { label: "edit_proxy", type: "mp4", width: 1280, height: 720, available: true, url: url("proxy") },
    ],
    files: [{ item_number: 1, width: 1280, height: 720, available: true, url: url("file0") }],
  },
} as DownloadManifest;

test("prefers the 720p proxy over the source, whatever order the manifest lists them in", () => {
  const p = selectPreview(video(), VIDEO);
  assert.equal(p?.label, "edit_proxy");
  assert.equal(p?.height, 720);
  assert.equal(p?.chapters, 1);
});

test("never offers an audio-only variation as the picture", () => {
  const audioOnly: DownloadManifest = {
    _embedded: { variations: [{ label: "audio_proxy", type: "m4a", available: true, url: url("a") }] },
  } as DownloadManifest;
  assert.equal(selectPreview(video(), audioOnly), null);
});

test("a chaptered video previews chapter one and reports how many there are", () => {
  const chaptered: DownloadManifest = {
    _embedded: {
      variations: [
        { label: "edit_proxy", type: "mp4", item_number: 2, width: 1280, height: 720, available: true, url: url("c2") },
        { label: "edit_proxy", type: "mp4", item_number: 1, width: 1280, height: 720, available: true, url: url("c1") },
        { label: "edit_proxy", type: "mp4", item_number: 3, width: 1280, height: 720, available: true, url: url("c3") },
      ],
    },
  } as DownloadManifest;
  const p = selectPreview(video(), chaptered);
  assert.equal(p?.itemNumber, 1);
  assert.equal(p?.url, url("c1"));
  assert.equal(p?.chapters, 3);
});

test("a variation still transcoding is not offered", () => {
  const pending: DownloadManifest = {
    _embedded: {
      variations: [
        { label: "edit_proxy", type: "mp4", available: false, url: url("not-yet") },
        { label: "source", type: "mp4", width: 3840, height: 2160, available: true, url: url("src") },
      ],
    },
  } as DownloadManifest;
  assert.equal(selectPreview(video(), pending)?.label, "source");
});

test("an unlisted label is still usable, smallest first", () => {
  const odd: DownloadManifest = {
    _embedded: {
      variations: [
        { label: "mystery_hd", type: "mp4", width: 1920, height: 1080, available: true, url: url("hd") },
        { label: "mystery_sd", type: "mp4", width: 640, height: 360, available: true, url: url("sd") },
      ],
    },
  } as DownloadManifest;
  assert.equal(selectPreview(video(), odd)?.label, "mystery_sd");
});

test("a container no browser plays is not offered", () => {
  const three60: DownloadManifest = {
    _embedded: { variations: [{ label: "source", type: "360", width: 4096, height: 2048, available: true, url: url("360") }] },
  } as DownloadManifest;
  assert.equal(selectPreview(video({ file_extension: "360" }), three60), null);
});

/**
 * The medium's filename is not the rendition's filename. A Quik edit is named *.json
 * while its baked_source is an mp4; typing the stream from the filename would send
 * application/octet-stream and the player would refuse it.
 */
test("carries the rendition's own container, not the medium's extension", () => {
  const quik = video({ filename: "Sunset Edit.json", file_extension: "json", type: "MultiClipEdit" });
  const baked: DownloadManifest = {
    _embedded: {
      variations: [{ label: "baked_source", type: "mp4", width: 2464, height: 2156, available: true, url: url("baked") }],
    },
  } as DownloadManifest;
  assert.equal(selectPreview(quik, baked)?.container, "mp4");
  assert.equal(selectPreview(video({ filename: "GOPR9999.MOV" }), VIDEO)?.container, "mp4");
});

test("photos never take the video path — they come from the image CDN instead", () => {
  assert.equal(selectPreview(video({ play_as: "photo", type: "Photo" }), VIDEO), null);
});

test("kind falls back to type when play_as is missing", () => {
  assert.equal(previewKind({ id: "x", type: "Photo" } as MediaRow), "photo");
  assert.equal(previewKind({ id: "x", type: "TimeLapseVideo" } as MediaRow), "video");
  assert.equal(previewKind({ id: "x", play_as: "photo", type: "Video" } as MediaRow), "photo");
});
