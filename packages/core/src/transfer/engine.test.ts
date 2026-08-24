/**
 * Engine tests for the two paths that are easy to get silently wrong: resuming a
 * session left behind by a previous process, and how much finished-but-uncommitted
 * work is allowed to accumulate.
 *
 * The CDN and Photos clients are stubbed. global fetch is replaced because the
 * engine talks to the GoPro CDN directly rather than through a client object.
 */

import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { Store } from "../state/db.js";
import { TransferEngine, type TransferTask } from "./engine.js";
import type { GoProClient } from "../gopro/client.js";
import type { GooglePhotosClient } from "../google/client.js";

const TOTAL = 4 * 1024 * 1024 * 1024; // 4 GB — comfortably into the chunked path
const GRAN = 262_144;

const realFetch = globalThis.fetch;
const rangesRequested: Array<[number, number]> = [];

beforeEach(() => {
  rangesRequested.length = 0;
  globalThis.fetch = (async (input: unknown, init?: { method?: string; headers?: Record<string, string> }) => {
    if (init?.method === "HEAD") {
      return { ok: true, status: 200, headers: new Headers({ "content-length": String(TOTAL) }) } as Response;
    }
    const range = init?.headers?.["Range"] ?? "";
    const m = /bytes=(\d+)-(\d+)/.exec(range);
    if (m) {
      const start = Number(m[1]), end = Number(m[2]);
      rangesRequested.push([start, end]);
      return { ok: true, status: 206, arrayBuffer: async () => new ArrayBuffer(end - start + 1) } as unknown as Response;
    }
    void input;
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
  }) as typeof fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

function fakeGoPro(): GoProClient {
  return {
    downloadManifest: async () => ({
      _embedded: {
        variations: [
          { label: "source", item_number: 1, width: 3840, height: 2160, available: true,
            url: "https://cdn.example/src?Expires=9999999999", head: "https://cdn.example/head" },
        ],
        files: [],
      },
    }),
  } as unknown as GoProClient;
}

interface GoogleStub { client: GooglePhotosClient; batches: number[]; }

function fakeGoogle(opts: { existingOffset?: number } = {}): GoogleStub {
  const batches: number[] = [];
  const client = {
    startSession: async () => ({ url: "https://upload.example/NEW", granularity: GRAN }),
    queryOffset: async (session: { url: string }) =>
      session.url === "https://upload.example/RESUME" && opts.existingOffset !== undefined
        ? { status: "active", committed: opts.existingOffset }
        : null,
    sendChunk: async (_s: unknown, _d: unknown, _o: number, finalize: boolean) => (finalize ? "TOKEN" : null),
    uploadWhole: async () => "TOKEN",
    batchCreate: async (items: Array<{ uploadToken: string }>) => {
      batches.push(items.length);
      return items.map((i) => ({ uploadToken: i.uploadToken, code: 0, message: "Success", mediaItemId: "G" + batches.length, filename: "f.mp4" }));
    },
  } as unknown as GooglePhotosClient;
  return { client, batches };
}

const task = (id: string): TransferTask => ({
  row: { id, filename: `${id}.MP4`, type: "Video", file_extension: "mp4" },
  asset: { itemNumber: 1, label: "source", url: "", headUrl: null, width: 3840, height: 2160, degraded: false },
});

test("resumes from a session left by a previous process instead of re-uploading", async () => {
  const store = new Store(":memory:");
  store.enqueue("m1", 1, "source", null, TOTAL);
  // Simulate a crash after 3 GB against a session Google still holds.
  store.recordProgress("m1", 1, 3 * 1024 ** 3, "https://upload.example/RESUME");

  const g = fakeGoogle({ existingOffset: 3 * 1024 ** 3 });
  const engine = new TransferEngine(fakeGoPro(), g.client, store, { concurrency: 1 });
  const result = await engine.run([task("m1")]);

  assert.equal(result.created, 1);
  const firstByte = rangesRequested[0]?.[0];
  assert.equal(firstByte, 3 * 1024 ** 3, "must continue at the committed offset, not restart at 0");
  const sent = rangesRequested.reduce((n, [s, e]) => n + (e - s + 1), 0);
  assert.ok(sent < TOTAL / 2, `should send only the remaining ~1 GB, sent ${sent}`);
  store.close();
});

test("starts fresh when Google no longer recognises the stored session", async () => {
  const store = new Store(":memory:");
  store.enqueue("m2", 1, "source", null, TOTAL);
  store.recordProgress("m2", 1, 3 * 1024 ** 3, "https://upload.example/DEAD");

  const g = fakeGoogle(); // queryOffset returns null for anything but RESUME
  const engine = new TransferEngine(fakeGoPro(), g.client, store, { concurrency: 1 });
  await engine.run([task("m2")]);

  assert.equal(rangesRequested[0]?.[0], 0, "a dead session must restart from byte 0");
  store.close();
});

test("commits in small batches so a crash cannot waste hours of upload", async () => {
  const store = new Store(":memory:");
  const tasks: TransferTask[] = [];
  for (let i = 0; i < 25; i++) {
    store.enqueue(`b${i}`, 1, "source", null, 1000);
    tasks.push(task(`b${i}`));
  }
  const g = fakeGoogle();
  const engine = new TransferEngine(fakeGoPro(), g.client, store, { concurrency: 1, batchSize: 5 });
  const result = await engine.run(tasks);

  assert.equal(result.created, 25);
  assert.ok(g.batches.length >= 5, `expected several commits, got ${g.batches.length}`);
  assert.ok(Math.max(...g.batches) <= 5, `no batch may exceed batchSize, saw ${Math.max(...g.batches)}`);
  store.close();
});

test("the default batch size is far below the API maximum of 50", async () => {
  const store = new Store(":memory:");
  const tasks: TransferTask[] = [];
  for (let i = 0; i < 30; i++) {
    store.enqueue(`d${i}`, 1, "source", null, 1000);
    tasks.push(task(`d${i}`));
  }
  const g = fakeGoogle();
  await new TransferEngine(fakeGoPro(), g.client, store, { concurrency: 1 }).run(tasks);
  assert.ok(Math.max(...g.batches) <= 10, `default should commit in tens, saw ${Math.max(...g.batches)}`);
  store.close();
});
