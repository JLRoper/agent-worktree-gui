// Four POSTs answered without asking for the token. On this panel the token guards writes from OFF
// this machine: a loopback caller is the board's own page, and lib/http/transport.js's authorised()
// exempts it. So the assertion has to arrive over a socket that is not loopback — the sandbox binds
// 0.0.0.0 and the request goes to this host's own LAN address, which is what a remote caller looks
// like from inside the process. A machine with no non-internal IPv4 skips rather than passing blank.
import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import { post, startPanel } from "../tools/panel-testkit.mjs";

const TOKEN = "phase0-test-token";
const PROTECTED = ["/api/refresh", "/api/visible", "/api/fetch", "/api/reload"];
// A write route that has always carried the guard, so "one rule" is measured against something.
const ALWAYS = "/api/settings/age";

function lanAddress() {
  return (
    Object.values(os.networkInterfaces())
      .flat()
      .find((n) => n && n.family === "IPv4" && !n.internal)?.address || null
  );
}

async function remotePanel(t) {
  const lan = lanAddress();
  if (!lan) {
    t.skip("no non-loopback IPv4 address on this machine to call the panel from");
    return null;
  }
  const panel = await startPanel({ token: TOKEN, config: { host: "0.0.0.0" } });
  t.after(() => panel.stop());
  return { panel, base: `http://${lan}:${panel.port}` };
}

test("the four POSTs that skipped authorised() refuse a caller from off this machine", async (t) => {
  const started = await remotePanel(t);
  if (!started) return;
  const { base } = started;

  for (const route of [...PROTECTED, ALWAYS]) {
    const anon = await post(base, route, { body: {} });
    assert.equal(anon.status, 403, `${route} must refuse a caller with no token`);
    assert.equal(anon.json?.error, "bad or missing x-panel-token", `${route} uses the panel's one refusal sentence`);

    const wrong = await post(base, route, { body: {}, token: "not-the-token" });
    assert.equal(wrong.status, 403, `${route} must refuse a wrong token`);
  }
});

test("the same four must still answer their owner — a guard that blocks the token holder is broken", async (t) => {
  const started = await remotePanel(t);
  if (!started) return;
  const { base } = started;

  for (const route of PROTECTED) {
    const ok = await post(base, route, { body: {}, token: TOKEN });
    assert.ok(ok.status < 400, `${route} must answer its owner (got ${ok.status}: ${ok.text.slice(0, 120)})`);
  }
});

test("reads stay open, and the machine's own board keeps writing without a token", async (t) => {
  const panel = await startPanel({ token: TOKEN });
  t.after(() => panel.stop());

  const health = await fetch(`${panel.base}/api/health`);
  assert.equal(health.status, 200, "a token must not make the panel unreadable");

  // Loopback is exempt by design (authorised() answers before it looks at the token), and that
  // exemption is what keeps the reader's own board writable. A 403 here would mean the guard broke it.
  const local = await post(panel.base, "/api/refresh", { body: {} });
  assert.ok(local.status < 400, `loopback is exempt from the token (got ${local.status}: ${local.text.slice(0, 120)})`);
});
