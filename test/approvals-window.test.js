// An approval card must live exactly as long as the gateway is willing to wait for it.
//
// The request the transport plugin presents carries no window, so the fallback decides everything. It used to be
// a copied-in 300 s with a deadline five seconds short of it: the sweep took the card away at 4m55s while the
// gateway (`approvals.timeout`) held the same request for 600 s, so the reader lost a prompt that could still be
// answered and the agent re-asked for a decision already on screen. The fallback now comes from the same
// `approvals.timeout` the gateway reads (lib/hermes-config.js), resolved at construction, and is the WHOLE window.
// The numbers below are the contract: config unset -> 300 (the host default), 600 -> 600, 900 -> 900, and an
// explicit `timeout_seconds` wins over all of them.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Approvals } from "../lib/approvals.js";
import { APPROVAL_TIMEOUT_DEFAULT } from "../lib/hermes-config.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const recorder = () => {
  const seen = [];
  return { seen, onEvent: (evt) => seen.push(evt) };
};

// A HERMES_HOME of its own. lib/approvals.js reads `<home>/config.yaml` at construction, so every case names
// its own approvals.timeout instead of inheriting the developer's.
function homeWith(timeout, t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wag-approvals-window-"));
  if (timeout !== null) {
    writeFileSync(path.join(dir, "config.yaml"), `approvals:\n  timeout: ${timeout}\n  mode: manual\n`, "utf8");
  }
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The window the card was given, measured from its own arrival stamp.
const windowMs = (req) => req.deadline - Date.parse(req.receivedAt);

test("no approvals.timeout in the config: the card is sized from the host default, 300 s", (t) => {
  const { seen, onEvent } = recorder();
  const approvals = new Approvals({ onEvent, home: homeWith(null, t) });
  const req = approvals.present({ request_id: "unset", command: "git push --force" });

  assert.equal(APPROVAL_TIMEOUT_DEFAULT, 300);
  assert.equal(approvals.windowSeconds, 300);
  assert.equal(req.timeoutSeconds, 300);
  assert.ok(windowMs(req) >= 300_000 && windowMs(req) <= 300_050, `300 s window measured ${windowMs(req)}ms`);

  approvals.sweep();
  assert.equal(approvals.status("unset").status, "pending");
  assert.equal(approvals.list().length, 1);
  assert.equal(seen[0].type, "approval");
  assert.equal(seen[0].request.id, "unset");
});

test("approvals.timeout: 600 sizes the card to 600 s", (t) => {
  const approvals = new Approvals({ onEvent: () => {}, home: homeWith(600, t) });
  const req = approvals.present({ request_id: "cfg-600" });

  assert.equal(approvals.windowSeconds, 600);
  assert.equal(req.timeoutSeconds, 600);
  assert.ok(windowMs(req) >= 600_000 && windowMs(req) <= 600_050, `600 s window measured ${windowMs(req)}ms`);

  // The sweep runs every 5 s. A deadline a few seconds inside the window (the old `timeout - 5`) would drop
  // the card at the first tick; it is still pending right after presenting.
  approvals.sweep();
  assert.equal(approvals.status("cfg-600").status, "pending");
});

test("approvals.timeout: 900 sizes the card to 900 s", (t) => {
  const approvals = new Approvals({ onEvent: () => {}, home: homeWith(900, t) });
  const req = approvals.present({ request_id: "cfg-900" });

  assert.equal(approvals.windowSeconds, 900);
  assert.equal(req.timeoutSeconds, 900);
  assert.ok(windowMs(req) >= 900_000 && windowMs(req) <= 900_050, `900 s window measured ${windowMs(req)}ms`);
});

test("an explicit timeout_seconds wins over the configured window", (t) => {
  const approvals = new Approvals({ onEvent: () => {}, home: homeWith(900, t) });

  const named = approvals.present({ request_id: "named", timeout_seconds: 120 });
  assert.equal(named.timeoutSeconds, 120);
  assert.ok(windowMs(named) >= 120_000 && windowMs(named) <= 120_050, `120 s window measured ${windowMs(named)}ms`);

  // The same instance still sizes a request with no window from the config, not from the last named value.
  const configured = approvals.present({ request_id: "configured" });
  assert.equal(configured.timeoutSeconds, 900);
});

test("the card lives through its own window, is denied at the end, and a re-ask is accepted", async (t) => {
  const { seen, onEvent } = recorder();
  const approvals = new Approvals({ onEvent, home: homeWith(null, t) });
  const start = Date.now();
  approvals.present({ request_id: "reask", timeout_seconds: 2 });

  // Inside the window the gateway is still waiting, so the card must still be there.
  await sleep(700);
  approvals.sweep();
  assert.equal(approvals.status("reask").status, "pending", "swept inside the request's own window");

  // Past the window the host has already denied; the card goes and the decision reads as a timeout deny.
  await sleep(Math.max(0, start + 2_200 - Date.now()));
  approvals.sweep();
  const dropped = approvals.status("reask");
  assert.equal(dropped.status, "answered");
  assert.equal(dropped.choice, "deny");
  assert.ok(seen.some((evt) => evt.type === "approval-answered" && evt.id === "reask" && evt.timeout === true));

  // A gateway that timed out re-asks rather than replaying the old deny: the same id must be pending again,
  // with the old decision cleared, and answerable.
  approvals.present({ request_id: "reask", timeout_seconds: 2 });
  assert.equal(approvals.status("reask").status, "pending");
  assert.equal(approvals.list().length, 1);
  assert.equal(approvals.answer("reask", "once").ok, true);
  assert.equal(approvals.status("reask").choice, "once");
});

test("the dead ttlMs option is gone, so an option by that name cannot shorten the configured window", (t) => {
  const approvals = new Approvals({ onEvent: () => {}, ttlMs: 1_000, home: homeWith(600, t) });
  assert.equal("ttlMs" in approvals, false);
  const req = approvals.present({ request_id: "ttl" });
  assert.equal(req.timeoutSeconds, 600);
  assert.ok(windowMs(req) > 599_000);
});
