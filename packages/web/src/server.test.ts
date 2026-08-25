/**
 * These exercise the server's shape, not the transfer engine.
 *
 * Note POST /api/transfer is deliberately NOT called here: it spawns a detached
 * job that outlives the request by design, so a test that starts one leaks work
 * past the assertion and, worse, would move real bytes into someone's library.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "./server.js";

test("serves the dashboard", async () => {
  const app = await createServer({ profile: "default" });
  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes("go2cloud"), "page should render the app shell");
  assert.ok(res.body.includes("cannot delete anything"), "the no-undo warning must be on the page");
  await app.close();
});

test("serves the client script as JavaScript", async () => {
  const app = await createServer({ profile: "default" });
  const res = await app.inject({ method: "GET", url: "/app.js" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"] as string, /javascript/);
  await app.close();
});

test("state reports both providers and the current job", async () => {
  const app = await createServer({ profile: "default" });
  const res = await app.inject({ method: "GET", url: "/api/state" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as Record<string, Record<string, unknown>>;
  assert.equal(body["profile"], "default");
  assert.ok("connected" in (body["gopro"] ?? {}));
  assert.ok("connected" in (body["google"] ?? {}));
  assert.equal(body["job"]?.["phase"], "idle");
  await app.close();
});

test("the page ships the preview viewer, not just the grid", async () => {
  const app = await createServer({ profile: "default" });
  const res = await app.inject({ method: "GET", url: "/" });
  assert.ok(res.body.includes('id="viewer"'), "the viewer dialog must be in the shell");
  assert.ok(res.body.includes('id="v-stage"'), "the viewer needs a stage to put media in");
  await app.close();
});

/**
 * The preview routes are deliberately keyed off the last scan rather than hitting
 * GoPro for an arbitrary id. That keeps an unauthenticated page from being able to
 * make the server fetch anything it likes, so the refusal is the contract.
 */
test("previewing an id that was never scanned is refused, not fetched", async () => {
  const app = await createServer({ profile: "default" });
  for (const url of ["/api/preview/nope", "/api/stream/nope", "/api/thumb/nope?size=original"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 404, `${url} should refuse an unknown id`);
    assert.match(String((res.json() as { error?: string }).error), /scan|playable/i);
  }
  await app.close();
});

/**
 * Loopback alone does not keep a website out: any page can issue requests to
 * 127.0.0.1, and DNS rebinding makes them same-origin. Host and Origin are the two
 * headers a browser will not forge, so they are the boundary.
 */
test("refuses requests addressed to anything but localhost", async () => {
  const app = await createServer({ profile: "default" });

  const rebound = await app.inject({ method: "GET", url: "/api/state", headers: { host: "x.evil.example:4173" } });
  assert.equal(rebound.statusCode, 403, "a rebound Host must be refused");

  const crossOrigin = await app.inject({
    method: "GET", url: "/api/state",
    headers: { host: "127.0.0.1:4173", origin: "https://evil.example" },
  });
  assert.equal(crossOrigin.statusCode, 403, "a cross-origin caller must be refused");

  for (const host of ["127.0.0.1:4173", "localhost:4173", "[::1]:4173"]) {
    const ok = await app.inject({ method: "GET", url: "/api/state", headers: { host } });
    assert.equal(ok.statusCode, 200, `${host} is the tool's own address and must work`);
  }
  // The page's own fetches are same-origin and announce themselves as such.
  const own = await app.inject({
    method: "GET", url: "/api/state",
    headers: { host: "127.0.0.1:4173", origin: "http://127.0.0.1:4173" },
  });
  assert.equal(own.statusCode, 200);

  await app.close();
});

test("an unknown path 404s rather than falling through to the app shell", async () => {
  const app = await createServer({ profile: "default" });
  const res = await app.inject({ method: "GET", url: "/api/nope" });
  assert.equal(res.statusCode, 404);
  await app.close();
});
