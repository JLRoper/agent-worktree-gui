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

test("a real SSE subscriber receives the board frame first, then the full snapshot", async (t) => {
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
  const readFrame = async (buf) => {
    while (!buf.includes("\n\n")) {
      const part = await reader.read();
      assert.equal(part.done, false, "stream ended before the frame arrived");
      buf += decoder.decode(part.value, { stream: true });
      assert.ok(buf.length < 5 * 1024 * 1024, "unexpectedly large sandbox frame");
    }
    return buf;
  };
  const payloadOf = (frame) => JSON.parse(frame.slice(frame.indexOf("data: ") + 6, frame.indexOf("\n\n")));

  // The board frame is what makes the page drawable before the full snapshot is built: it must come first, and it
  // must carry the projects and rows the page paints.
  let buf = await readFrame("");
  assert.match(buf, /^event: board\ndata: /);
  const board = payloadOf(buf);
  assert.ok(Array.isArray(board.projects), "the board frame carries the project list");
  assert.ok("settings" in board && "treeList" in board, "…and the settings and tree list the page draws with");
  assert.ok(!("jobs" in board), "the board frame leaves the job pane to the full snapshot");
  buf = buf.slice(buf.indexOf("\n\n") + 2);

  // …and the full snapshot still follows on the same connection, with the panes the board frame leaves out.
  buf = await readFrame(buf);
  assert.match(buf, /^event: snapshot\ndata: /);
  const full = payloadOf(buf);
  assert.ok(Array.isArray(full.projects));
  assert.ok("jobs" in full || "assistant" in full, "the full snapshot carries the panes the board frame omits");
  controller.abort();
});
