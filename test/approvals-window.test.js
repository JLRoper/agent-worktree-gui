// An approval card must live exactly as long as the gateway is willing to wait for it — and no longer.
//
// The request the transport plugin presents usually carries no window, so the fallback decides everything. It
// used to be a copied-in 300 s with a deadline five seconds short of it: the sweep took the card away at 4m55s
// while the gateway (`approvals.timeout`) held the same request for 600 s (docs/steer-refusal.md measures 604 s
// before the gateway denied it), so the reader lost a prompt that could still be answered and the agent re-asked
// for a decision already on screen. The fallback is now the host's own hold: the configured `approvals.timeout`
// when the file names one, HOST_APPROVAL_HOLD_SECONDS (600 s) when it does not.
//
// The four invariants below are the contract:
//   1. `timeout_seconds: 0` is a real window — denied at once, never a negative deadline;
//   2. an absent or unreadable `timeout_seconds` gets the 600 s hold;
//   3. an explicit `timeout_seconds: N` gets a deadline N - ANSWER_GRACE_SECONDS (5 s) from arrival;
//   4. the deadline never sits past the request's own window.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Approvals } from "../lib/approvals.js";

// Mirrors the module's own fallback; kept literal so a new number in the module is a failing test, not a
// silently agreeing one.
const HOST_APPROVAL_HOLD_SECONDS = 600;
const ANSWER_GRACE_SECONDS = 5;

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

test("no approvals.timeout in the config: the card gets the host's 600 s hold, 5 s inside it", (t) => {
  const { seen, onEvent } = recorder();
  const approvals = new Approvals({ onEvent, home: homeWith(null, t) });
  const req = approvals.present({ request_id: "unset", command: "git push --force" });

  assert.equal(approvals.windowSeconds, HOST_APPROVAL_HOLD_SECONDS);
  assert.equal(req.timeoutSeconds, HOST_APPROVAL_HOLD_SECONDS);
  assert.equal(windowMs(req), (HOST_APPROVAL_HOLD_SECONDS - ANSWER_GRACE_SECONDS) * 1000);

  // The sweep runs every 5 s. The deadline is 5 s inside the window, not a whole window away.
  approvals.sweep();
  assert.equal(approvals.status("unset").status, "pending");
  assert.equal(approvals.list().length, 1);
  assert.equal(seen[0].type, "approval");
  assert.equal(seen[0].request.id, "unset");
});

test("approvals.timeout: 600 sizes the card to 600 s, deadline 595 s out", (t) => {
  const approvals = new Approvals({ onEvent: () => {}, home: homeWith(600, t) });
  const req = approvals.present({ request_id: "cfg-600" });

  assert.equal(approvals.windowSeconds, 600);
  assert.equal(req.timeoutSeconds, 600);
  assert.equal(windowMs(req), 595_000);

  // The sweep runs every 5 s; the card is still pending right after presenting.
  approvals.sweep();
  assert.equal(approvals.status("cfg-600").status, "pending");
});

test("approvals.timeout: 900 sizes the card to 900 s, deadline 895 s out", (t) => {
  const approvals = new Approvals({ onEvent: () => {}, home: homeWith(900, t) });
  const req = approvals.present({ request_id: "cfg-900" });

  assert.equal(approvals.windowSeconds, 900);
  assert.equal(req.timeoutSeconds, 900);
  assert.equal(windowMs(req), 895_000);
});

test("an explicit timeout_seconds wins over the configured window", (t) => {
  const approvals = new Approvals({ onEvent: () => {}, home: homeWith(900, t) });

  const named = approvals.present({ request_id: "named", timeout_seconds: 120 });
  assert.equal(named.timeoutSeconds, 120);
  assert.equal(windowMs(named), 115_000);

  // The same instance still sizes a request with no window from the config, not from the last named value.
  const configured = approvals.present({ request_id: "configured" });
  assert.equal(configured.timeoutSeconds, 900);
  assert.equal(windowMs(configured), 895_000);
});

test("invariant 1: timeout_seconds 0 denies at once, with a deadline of now and never negative", (t) => {
  const { seen, onEvent } = recorder();
  const approvals = new Approvals({ onEvent, home: homeWith(null, t) });
  const before = Date.now();
  const req = approvals.present({ request_id: "zero", timeout_seconds: 0 });

  assert.equal(req.timeoutSeconds, 0);
  assert.equal(windowMs(req), 0);
  assert.ok(req.deadline >= before, `deadline ${req.deadline} went backwards past arrival ${before}`);
  assert.ok(req.deadline <= Date.now(), `deadline ${req.deadline} is in the future`);

  // Presented, then denied by the very next sweep — not held for the fallback window.
  assert.equal(approvals.status("zero").status, "pending");
  approvals.sweep();
  const denied = approvals.status("zero");
  assert.equal(denied.status, "answered");
  assert.equal(denied.choice, "deny");
  assert.ok(seen.some((evt) => evt.type === "approval-answered" && evt.id === "zero" && evt.timeout === true));
  assert.equal(approvals.list().length, 0);
});

test("invariant 2: an absent or unreadable timeout gets the 600 s hold", (t) => {
  const approvals = new Approvals({ onEvent: () => {}, home: homeWith(null, t) });

  for (const [label, value] of [
    ["absent", undefined],
    ["null", null],
    ["empty string", ""],
    ["blank string", "   "],
    ["not a number", "soon"],
  ]) {
    const req = approvals.present({ request_id: `fallback-${label}`, timeout_seconds: value });
    assert.equal(req.timeoutSeconds, HOST_APPROVAL_HOLD_SECONDS, `${label} fell back to ${req.timeoutSeconds}`);
    assert.equal(windowMs(req), 595_000, `${label} window was ${windowMs(req)}ms`);
  }
});

test("invariant 3: an explicit N gets a deadline N - 5 s from arrival", (t) => {
  const approvals = new Approvals({ onEvent: () => {}, home: homeWith(900, t) });

  for (const n of [5, 6, 15, 30, 120, 600]) {
    const req = approvals.present({ request_id: `explicit-${n}`, timeout_seconds: n });
    assert.equal(req.timeoutSeconds, n);
    assert.equal(windowMs(req), (n - ANSWER_GRACE_SECONDS) * 1000, `${n}s window measured ${windowMs(req)}ms`);
  }

  // A string integer is still the request's own window; it is not "unreadable".
  const asText = approvals.present({ request_id: "explicit-text", timeout_seconds: "120" });
  assert.equal(asText.timeoutSeconds, 120);
  assert.equal(windowMs(asText), 115_000);
});

test("invariant 4: a card never outlives its request", (t) => {
  const unset = new Approvals({ onEvent: () => {}, home: homeWith(null, t) });
  const configured = new Approvals({ onEvent: () => {}, home: homeWith(900, t) });

  const cases = [
    [unset, { request_id: "hold", timeout_seconds: undefined }, HOST_APPROVAL_HOLD_SECONDS],
    [unset, { request_id: "zero", timeout_seconds: 0 }, 0],
    [unset, { request_id: "one", timeout_seconds: 1 }, 1],
    [configured, { request_id: "nine", timeout_seconds: 900 }, 900],
    [configured, { request_id: "short", timeout_seconds: 12 }, 12],
  ];

  for (const [approvals, input, window] of cases) {
    const req = approvals.present(input);
    const held = windowMs(req);
    assert.ok(held >= 0, `${input.request_id}: deadline ${req.deadline} sits before arrival`);
    assert.ok(held <= window * 1000, `${input.request_id}: card held ${held}ms for a ${window}s request window`);
    assert.equal(req.deadline, Date.parse(req.receivedAt) + Math.max(0, window - ANSWER_GRACE_SECONDS) * 1000);
  }
});

test("the card lives until the grace-shortened deadline, is denied there, and a re-ask is accepted", async (t) => {
  const { seen, onEvent } = recorder();
  const approvals = new Approvals({ onEvent, home: homeWith(null, t) });
  const start = Date.now();
  approvals.present({ request_id: "reask", timeout_seconds: 7 });

  // 7 s window, 2 s deadline. Before it, the reader still has a live card.
  await sleep(700);
  approvals.sweep();
  assert.equal(approvals.status("reask").status, "pending", "swept before the grace-shortened deadline");

  // At the deadline the decision reads as a timeout deny, so the agent is never left waiting on the panel.
  await sleep(Math.max(0, start + 2_200 - Date.now()));
  approvals.sweep();
  const dropped = approvals.status("reask");
  assert.equal(dropped.status, "answered");
  assert.equal(dropped.choice, "deny");
  assert.ok(seen.some((evt) => evt.type === "approval-answered" && evt.id === "reask" && evt.timeout === true));

  // A gateway that timed out re-asks rather than replaying the old deny: the same id must be pending again,
  // with the old decision cleared, and answerable.
  approvals.present({ request_id: "reask", timeout_seconds: 7 });
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
  assert.equal(windowMs(req), 595_000);
});
