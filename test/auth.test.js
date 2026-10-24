// Four POSTs answered without asking for the token. Each one now fails closed like the other 41,
// and this asserts the answer rather than the source line.
import assert from "node:assert/strict";
import test from "node:test";
import { post, startPanel } from "../tools/panel-testkit.mjs";

const TOKEN = "phase0-test-token";
const PROTECTED = ["/api/refresh", "/api/visible", "/api/fetch", "/api/reload"];

test("the four POSTs that skipped authorised() now refuse an unauthenticated caller", async (t) => {
  const panel = await startPanel({ token: TOKEN });
  t.after(() => panel.stop());

  for (const route of PROTECTED) {
    const anon = await post(panel.base, route, { body: {} });
    assert.equal(anon.status, 403, `${route} must refuse a caller with no token`);
    assert.equal(anon.json?.error, "bad or missing x-panel-token", `${route} uses the panel's one refusal sentence`);

    const wrong = await post(panel.base, route, { body: {}, token: "not-the-token" });
    assert.equal(wrong.status, 403, `${route} must refuse a wrong token`);
  }

  // The same four must still work when the token is right — a guard that also blocks the owner
  // would pass the assertions above and break the panel.
  for (const route of PROTECTED) {
    const ok = await post(panel.base, route, { body: {}, token: TOKEN });
    assert.ok(ok.status < 400, `${route} must answer its owner (got ${ok.status}: ${ok.text.slice(0, 120)})`);
  }
});

test("the four now behave exactly like a route that was always protected", async (t) => {
  const panel = await startPanel({ token: TOKEN });
  t.after(() => panel.stop());

  const already = await post(panel.base, "/api/jobs/label", { body: { thread: "x" } });
  const four = await post(panel.base, "/api/refresh", { body: {} });
  assert.equal(already.status, four.status, "one rule for every write route");
  assert.equal(already.json?.error, four.json?.error, "and one sentence");
});

test("reads stay open on loopback: the token guards writes, not the board", async (t) => {
  const panel = await startPanel({ token: TOKEN });
  t.after(() => panel.stop());
  const health = await fetch(`${panel.base}/api/health`);
  assert.equal(health.status, 200, "a token must not make the panel unreadable");
});
