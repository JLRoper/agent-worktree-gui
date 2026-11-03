// An approval card must live as long as the gateway is willing to wait for it.
//
// lib/approvals.js gave every request a 300 s default and then set the deadline five seconds short of it, so the
// sweep took the card away at 4m55s while the gateway (`approvals.timeout`) held the same request for 600 s: the
// reader lost a prompt that could still be answered, and the agent was re-asked for a decision already on screen.
// The window is now one named constant, defaults to the gateway's 600 s, and is the WHOLE window the host names.
// `ttlMs` — a constructor option stored on `this.ttlMs` and read nowhere — is gone; the last test proves an option
// by that name cannot come back and quietly shorten a card.
import assert from "node:assert/strict";
import test from "node:test";
import { Approvals, DEFAULT_APPROVAL_TIMEOUT_SECONDS } from "../lib/approvals.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const recorder = () => {
  const seen = [];
  return { seen, onEvent: (evt) => seen.push(evt) };
};

test("a request that names no window gets 600 s, and a sweep does not touch it", () => {
  const { seen, onEvent } = recorder();
  const approvals = new Approvals({ onEvent });
  const at = Date.now();
  const req = approvals.present({ request_id: "no-window", command: "git push --force" });

  assert.equal(DEFAULT_APPROVAL_TIMEOUT_SECONDS, 600);
  assert.equal(req.timeoutSeconds, 600);
  // The deadline is the END of the window, counted from arrival. The old 300 s default produced 295 s here,
  // which is the card that vanished in under five minutes.
  const window = req.deadline - at;
  assert.ok(window >= 600_000, `deadline only ${window}ms after arrival`);
  assert.ok(window <= 600_050, `deadline ${window}ms after arrival is past the named window`);

  approvals.sweep();
  assert.equal(approvals.status("no-window").status, "pending");
  assert.equal(approvals.list().length, 1);
  assert.equal(seen[0].type, "approval");
  assert.equal(seen[0].request.id, "no-window");
});

test("an explicit timeout_seconds is used whole, and overrides the default", () => {
  const approvals = new Approvals({ onEvent: () => {} });
  const long = approvals.present({ request_id: "long", timeout_seconds: 600 });
  const longWindow = long.deadline - Date.parse(long.receivedAt);
  assert.equal(long.timeoutSeconds, 600);
  assert.ok(longWindow >= 600_000 && longWindow <= 600_050, `600 s window measured ${longWindow}ms`);

  const short = approvals.present({ request_id: "short", timeout_seconds: 42 });
  const shortWindow = short.deadline - Date.parse(short.receivedAt);
  assert.equal(short.timeoutSeconds, 42);
  assert.ok(shortWindow >= 42_000 && shortWindow <= 42_050, `42 s window measured ${shortWindow}ms`);
  // The sweep runs every 5 s, so a deadline a few seconds inside the named window would have dropped the
  // long card at the first tick. Both cards are still pending right after presenting.
  approvals.sweep();
  assert.equal(approvals.list().length, 2);
});

test("the card lives through its own window, is denied at the end, and a re-ask is accepted", async () => {
  const { seen, onEvent } = recorder();
  const approvals = new Approvals({ onEvent });
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

test("the dead ttlMs option is gone, so an option by that name cannot shorten the default", () => {
  const approvals = new Approvals({ onEvent: () => {}, ttlMs: 1_000 });
  assert.equal("ttlMs" in approvals, false);
  const req = approvals.present({ request_id: "ttl" });
  assert.equal(req.timeoutSeconds, DEFAULT_APPROVAL_TIMEOUT_SECONDS);
  assert.ok(req.deadline - Date.now() > 599_000);
});
