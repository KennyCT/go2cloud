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

test("an unknown path 404s rather than falling through to the app shell", async () => {
  const app = await createServer({ profile: "default" });
  const res = await app.inject({ method: "GET", url: "/api/nope" });
  assert.equal(res.statusCode, 404);
  await app.close();
});
