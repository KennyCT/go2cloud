/**
 * Schema tolerance. An undocumented API changing a field type must degrade that
 * one field, never fail a scan — `ready_to_view` arriving as a string aborted a
 * whole 212-item walk before these guards existed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MediaRow, SearchResponse, bytesOf } from "./types.js";

test("a wrongly-typed optional field degrades to undefined, it does not throw", () => {
  const row = MediaRow.parse({ id: "x", width: { nope: true }, item_count: ["bad"] });
  assert.equal(row.id, "x");
  assert.equal(row.width, undefined);
  assert.equal(row.item_count, undefined);
});

test("ready_to_view is a processing-state string, not a boolean", () => {
  assert.equal(MediaRow.parse({ id: "x", ready_to_view: "ready" }).ready_to_view, "ready");
});

test("numeric fields sent as strings are coerced", () => {
  const row = MediaRow.parse({ id: "x", file_size: "8705957387", width: "3840" });
  assert.equal(bytesOf(row), 8_705_957_387);
  assert.equal(row.width, 3840);
});

test("a missing id is still a hard failure — we cannot address the media without it", () => {
  assert.throws(() => MediaRow.parse({ filename: "GX010174.MP4" }));
});

test("unknown upstream fields pass through without complaint", () => {
  const row = MediaRow.parse({ id: "x", some_field_gopro_added_later: 42 });
  assert.equal(row.id, "x");
});

test("_pages tolerates numbers sent as strings, since completeness depends on it", () => {
  const parsed = SearchResponse.parse({
    _embedded: { media: [{ id: "a" }] },
    _pages: { current_page: "1", per_page: "50", total_items: "212", total_pages: "5" },
  });
  assert.equal(parsed._pages.total_items, 212);
  assert.equal(parsed._pages.per_page, 50);
});

test("a row whose every optional field is garbage still yields a usable id", () => {
  const row = MediaRow.parse({
    id: "ok", type: 1, filename: false, file_extension: [], captured_at: {},
    available_labels: "not-an-array", mce_type: 0, play_as: null,
  });
  assert.equal(row.id, "ok");
  assert.equal(row.available_labels, undefined);
});
