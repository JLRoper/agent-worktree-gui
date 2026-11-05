// The policy route over the wire: GET serves the effective text the next row consumes, POST replaces the panel's
// copy, and both refusals the store can raise are real HTTP statuses (413 over the cap, 409 when the file moved).
//
// Boots the real server.js (tools/panel-testkit.mjs) against a throwaway data directory, so this asserts what the
// route answers rather than what its source says. The store's own unit tests are test/matrix-policy.test.js.
import assert from "node:assert/strict";
import test from "node:test";
import { post, startPanel } from "../tools/panel-testkit.mjs";

const TOKEN = "matrix-policy-test-token";
let panel = null;

test.before(async () => {
  panel = await startPanel({ token: TOKEN });
});
test.after(async () => {
  if (panel) await panel.stop();
});

const getJson = async (route) => {
  const r = await fetch(`${panel.base}${route}`);
  return { status: r.status, body: await r.json() };
};

test("GET /api/matrix/policy serves the store, and POST replaces the panel's copy", async () => {
  const first = await getJson("/api/matrix/policy");
  assert.equal(first.status, 200);
  assert.equal(first.body.source, "template", "a fresh panel opens on the template");
  assert.equal(first.body.saved, false);
  assert.equal(first.body.cap, 12000);
  assert.equal(first.body.envVar, "WTGUI_MATRIX_POLICY");
  assert.match(first.body.text, /## Quiet hours/, "the box is not blank: the template is the first screen");
  assert.ok(first.body.path.toLowerCase().startsWith(panel.dir.replace(/\\/g, "/").toLowerCase()), "the file is in the sandbox's data directory");
  assert.ok(first.body.path.endsWith("matrix-policy.md"));
  assert.equal(first.body.path.includes("\\"), false, "the page gets a forward-slash path");

  const body = "# My policy\n\n- short replies\n- quiet after 22:00\n";
  const saved = await post(panel.base, "/api/matrix/policy", { token: TOKEN, body: { text: body } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.source, "panel");
  assert.equal(saved.json.saved, true);
  assert.equal(saved.json.text, body, "the answer is the file, byte for byte");
  assert.ok(saved.json.mtime > 0);

  const again = await getJson("/api/matrix/policy");
  assert.equal(again.body.text, body, "the next reader sees the saved copy");
  assert.equal(again.body.source, "panel");
});

test("a loopback save needs no token — the reader's own machine is the panel's rule — and a non-string body is a 400", async () => {
  // authorised() is a LOOPBACK pass plus a token for other hosts. A test on the same machine is loopback by
  // definition, so this press succeeds without the header; the token's own refusal is covered by the transport's
  // tests, not invented here.
  const noToken = await post(panel.base, "/api/matrix/policy", { body: { text: "from loopback" } });
  assert.equal(noToken.status, 200);
  assert.equal(noToken.json.text, "from loopback");

  const bad = await post(panel.base, "/api/matrix/policy", { token: TOKEN, body: { text: 7 } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /string `text`/);
});

test("a save over the cap is a 413 with the numbers, and the file is untouched", async () => {
  const before = await getJson("/api/matrix/policy");
  const huge = "x".repeat(12001);
  const refused = await post(panel.base, "/api/matrix/policy", { token: TOKEN, body: { text: huge } });
  assert.equal(refused.status, 413);
  assert.match(refused.json.error, /12001/);
  assert.match(refused.json.error, /12000/);
  const after = await getJson("/api/matrix/policy");
  assert.equal(after.body.text, before.body.text, "the last good policy is the one still served");
});

test("a save whose mtime is stale is a 409, not a silent overwrite", async () => {
  const loaded = await getJson("/api/matrix/policy");
  const oldMtime = loaded.body.mtime;
  // Another writer (the assistant, a second tab) moves the file after this copy was read.
  await new Promise((resolve) => setTimeout(resolve, 25));
  const moved = await post(panel.base, "/api/matrix/policy", { token: TOKEN, body: { text: "written elsewhere" } });
  assert.equal(moved.status, 200);
  const stale = await post(panel.base, "/api/matrix/policy", { token: TOKEN, body: { text: "mine", expectMtime: oldMtime } });
  assert.equal(stale.status, 409);
  assert.match(stale.json.error, /changed on disk/);
  assert.equal((await getJson("/api/matrix/policy")).body.text, "written elsewhere");
});

test("GET /api/matrix/status serves the tab's four sections in one answer, with bridge.env's PATH and no value", async () => {
  const r = await getJson("/api/matrix/status");
  assert.equal(r.status, 200);
  assert.ok(r.body.at && !Number.isNaN(Date.parse(r.body.at)));
  assert.equal(typeof r.body.bridge.running, "boolean");
  assert.equal(typeof r.body.bridge.envPath, "string", "the path is a string; an unconfigured panel's is empty");
  assert.equal("credentialsPresent" in r.body.bridge, true);
  assert.equal(Array.isArray(r.body.bridge.senderAllowList.senders), true);
  assert.ok(r.body.element.activity.lastSentAt === null || typeof r.body.element.activity.lastSentAt === "string", "null, or the ISO time of the last successful send");
  assert.equal(Array.isArray(r.body.element.inbound), true);
  assert.equal(Array.isArray(r.body.element.messages), true);
  assert.equal(r.body.policy.path.endsWith("matrix-policy.md"), true);
  assert.equal(typeof r.body.gateway.reachable, "boolean", "the sandbox has no key, so the probe answers false rather than nothing");
});
