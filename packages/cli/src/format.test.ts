import assert from "node:assert/strict";
import { test } from "node:test";
import { bytes, duration, estimate, bar } from "./format.js";

test("duration carries minutes into hours instead of showing 60m", () => {
  assert.equal(duration(3 * 3600 + 3570), "4h 0m"); // was "3h 60m"
  assert.equal(duration(3599), "1h 0m");
  assert.equal(duration(3600), "1h 0m");
  assert.equal(duration(5400), "1h 30m");
  assert.equal(duration(90), "2m");
  assert.equal(duration(0), "unknown");
  assert.equal(duration(Number.NaN), "unknown");
});

test("estimate models upload as the bottleneck", () => {
  // 67 GB at 40 Mbps
  assert.equal(estimate(67 * 1e9, 40), duration((67 * 1e9 * 8) / 40e6));
});

test("bytes scales and stays readable", () => {
  assert.equal(bytes(0), "0 B");
  assert.equal(bytes(1024), "1.00 KB");
  assert.equal(bytes(8_705_957_387), "8.11 GB");
  assert.equal(bytes(2 * 1024 ** 4), "2.00 TB");
});

test("bar clamps out-of-range fractions", () => {
  assert.equal(bar(0, 4), "░░░░");
  assert.equal(bar(1, 4), "████");
  assert.equal(bar(-1, 4), "░░░░");
  assert.equal(bar(99, 4), "████");
});
