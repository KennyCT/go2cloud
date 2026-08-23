/**
 * The composite-key tests guard against a data-loss bug: keying transfers on
 * gopro_media_id alone silently drops chapters 2..N of every chaptered video,
 * and does so without any error. See PLAN.md §6.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "./db.js";

const store = () => new Store(":memory:");

test("chapters of one media id are distinct rows, not overwrites", () => {
  const s = store();
  s.enqueue("GX010639", 1, "source", null, 100);
  s.enqueue("GX010639", 2, "source", null, 200);
  s.enqueue("GX010639", 3, "source", null, 300);
  assert.equal(s.pending().length, 3, "all three chapters must survive");
  assert.equal(s.bytesRemaining(), 600);
  s.close();
});

test("re-enqueuing is a no-op, so re-runs never duplicate work", () => {
  const s = store();
  s.enqueue("m1", 1, "source", null, 500);
  s.recordProgress("m1", 1, 250, "https://upload/session");
  s.enqueue("m1", 1, "source", null, 500); // second run over the same library
  const [row] = s.pending();
  assert.equal(s.pending().length, 1);
  assert.equal(row?.bytes_sent, 250, "in-flight progress must not be reset by a re-scan");
  s.close();
});

test("isDone gates both verified and skipped, so neither is retried", () => {
  const s = store();
  s.enqueue("a", 1, "source", null, 10);
  assert.equal(s.isDone("a", 1), false);
  s.markVerified("a", 1, "GOOGLE_ID_1");
  assert.equal(s.isDone("a", 1), true);

  s.markSkipped("b", 1, "unsupported-format");
  assert.equal(s.isDone("b", 1), true);
  assert.equal(s.isDone("never-seen", 1), false);
  s.close();
});

test("verifying clears the resumable session so stale URLs are never reused", () => {
  const s = store();
  s.enqueue("a", 1, "source", null, 10);
  s.recordProgress("a", 1, 10, "https://upload/session");
  s.markVerified("a", 1, "G1");
  assert.equal(s.pending().length, 0);
  assert.deepEqual(s.summary(), { verified: 1 });
  s.close();
});

test("resume state survives across Store instances for the same file", () => {
  const path = `/tmp/go2cloud-test-${process.pid}.sqlite`;
  const a = new Store(path);
  a.enqueue("big", 1, "source", null, 20_000_000_000);
  a.recordProgress("big", 1, 5_000_000_000, "https://upload/resume-me");
  a.close();

  const b = new Store(path);
  const [row] = b.pending();
  assert.equal(row?.bytes_sent, 5_000_000_000);
  assert.equal(row?.upload_url, "https://upload/resume-me");
  assert.equal(b.bytesRemaining(), 15_000_000_000);
  b.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { require("node:fs").unlinkSync(path + suffix); } catch { /* ignore */ }
  }
});

test("media upsert is idempotent and preserves the raw row", () => {
  const s = store();
  const row = { id: "m1", filename: "GX010174.MP4", type: "Video", file_size: 2_887_105_349, available_labels: ["source"] };
  assert.equal(s.upsertMedia([row]), 1);
  assert.equal(s.upsertMedia([{ ...row, filename: "RENAMED.MP4" }]), 1);
  assert.equal(s.mediaCount(), 1, "same id must update, not insert a second row");
  s.close();
});

test("summary and bytesRemaining reflect only outstanding work", () => {
  const s = store();
  s.enqueue("a", 1, "source", null, 100);
  s.enqueue("b", 1, "source", null, 200);
  s.markVerified("a", 1, "G");
  assert.deepEqual(s.summary(), { pending: 1, verified: 1 });
  assert.equal(s.bytesRemaining(), 200);
  s.close();
});
