import assert from "node:assert/strict";
import test from "node:test";
import { get } from "node:http";
import { gunzipSync } from "node:zlib";
import { startPanel } from "../tools/panel-testkit.mjs";

test("the real panel exposes bounded synchronous phase diagnostics", async (t) => {
  const panel = await startPanel();
  t.after(() => panel.stop());
  const response = await fetch(`${panel.base}/api/diagnostics`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.syncPhases.thresholdMs, 250);
  assert.equal(typeof body.syncPhases.count, "number");
  assert.ok(Array.isArray(body.syncPhases.recent));
  assert.ok(body.syncPhases.recent.length <= 20);
});

test("the real panel serves a decodable compressed state snapshot", async (t) => {
  const panel = await startPanel();
  t.after(() => panel.stop());
  const response = await new Promise((resolve, reject) => {
    const req = get(`${panel.base}/api/state`, { headers: { "accept-encoding": "gzip" } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.once("error", reject);
      res.once("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.once("error", reject);
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-encoding"], "gzip");
  assert.equal(response.headers["content-length"], undefined);
  assert.ok(JSON.parse(gunzipSync(response.body)).projects);
});

test("a real SSE subscriber receives the initial snapshot", async (t) => {
  const panel = await startPanel();
  t.after(() => panel.stop());
  const controller = new AbortController();
  t.after(() => controller.abort());
  const timeout = setTimeout(() => controller.abort(), 5000);
  t.after(() => clearTimeout(timeout));
  const response = await fetch(`${panel.base}/api/stream`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let frame = "";
  while (!frame.includes("\n\n")) {
    const part = await reader.read();
    assert.equal(part.done, false, "stream ended before initial snapshot");
    frame += decoder.decode(part.value, { stream: true });
    assert.ok(frame.length < 5 * 1024 * 1024, "unexpectedly large sandbox snapshot");
  }
  assert.match(frame, /^event: snapshot\ndata: /);
  const first = frame.slice(0, frame.indexOf("\n\n"));
  assert.ok(JSON.parse(first.slice(first.indexOf("data: ") + 6)).projects);
  controller.abort();
});
