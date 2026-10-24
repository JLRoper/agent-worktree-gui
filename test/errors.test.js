// What a failed request answers. Internal faults used to answer 400 ("your mistake") with no log,
// which is why a blank board had no explanation anywhere.
import assert from "node:assert/strict";
import test from "node:test";
import { HttpError, errorStatus } from "../lib/errors.js";
import { post, startPanel } from "../tools/panel-testkit.mjs";

test("a bug is a 500, a refusal the handler chose keeps its status", () => {
  assert.equal(errorStatus(new TypeError("cannot read properties of undefined")), 500);
  assert.equal(errorStatus(new Error("boom")), 500);
  assert.equal(errorStatus(new HttpError(413, "body too large")), 413);
  assert.equal(errorStatus(new HttpError(400, "invalid JSON body")), 400);
  // A random `.status` on an error object is not a decision this process made.
  assert.equal(errorStatus(Object.assign(new Error("nope"), { status: 404 })), 500);
});

test("a malformed body is still the caller's 400, and the server survives it", async (t) => {
  const panel = await startPanel();
  t.after(() => panel.stop());

  const bad = await post(panel.base, "/api/threads/model", { body: "{" });
  assert.equal(bad.status, 400, "invalid JSON is the caller's mistake, not a 500");
  assert.match(bad.json?.error || "", /invalid JSON body/, "the sentence names the mechanism");

  const health = await fetch(`${panel.base}/api/health`);
  assert.equal(health.status, 200, "a rejected body must not take the process with it");
});

test("an oversized body answers 413, not 400", async (t) => {
  // 413 is the proof that the outer catch consults HttpError: no other code path in the server can
  // produce it. Before this fix the request was destroyed mid-upload, so the caller saw a reset
  // socket - the status was unreachable even though the limit was.
  const panel = await startPanel();
  t.after(() => panel.stop());
  const big = await post(panel.base, "/api/threads/model", { body: JSON.stringify({ thread: "x".repeat(300 * 1024) }) });
  assert.equal(big.status, 413);
  assert.match(big.json?.error || "", /body too large/);
});

test("a missing file is a 404, and the page still serves", async (t) => {
  const panel = await startPanel();
  t.after(() => panel.stop());
  const missing = await fetch(`${panel.base}/no-such-file.js`);
  assert.equal(missing.status, 404);
  const dir = await fetch(`${panel.base}/lib`);
  assert.equal(dir.status, 404, "a directory under public/ is not a readable file, and not a 500");
  const page = await fetch(`${panel.base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<script src="\/app\.js">/, "the real page is what a blank page was failing to load");
});
