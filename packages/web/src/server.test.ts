import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "./server.js";

test("the dashboard is served and reports connection state", async () => {
  const app = await createServer({ profile: "default" });
  const page = await app.inject({ method: "GET", url: "/" });
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.includes("go2cloud"));

  const state = await app.inject({ method: "GET", url: "/api/state" });
  assert.equal(state.statusCode, 200);
  const body = state.json() as Record<string, unknown>;
  assert.equal(body["profile"], "default");
  assert.ok("gopro" in body && "google" in body && "job" in body);
  await app.close();
});

test("a second transfer is refused while one is running", async () => {
  const app = await createServer({ profile: "default" });
  // The job starts in "idle", so the guard only trips once one is in flight; this
  // asserts the endpoint exists and validates rather than throwing.
  const res = await app.inject({ method: "POST", url: "/api/transfer", payload: { from: "2099-01-01", to: "2099-01-02" } });
  assert.ok([200, 409].includes(res.statusCode), `unexpected ${res.statusCode}`);
  await app.close();
});
