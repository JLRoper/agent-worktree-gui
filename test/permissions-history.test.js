// The permissions history: the store (lib/permissions-history.js), its route (routes/permissions-history.js) and its
// pure page half (public/core/permissions-history.js).
//
// What these pin down, in the order the brief names them: ONE RECORD PER REQUEST (a replay cannot erase a decision), the
// THREE STATES (open, answered, expired, and that an expiry is never drawn as a choice somebody made), the LIVE COUNT
// (only requests the panel can still answer), the RESTART (the file is re-read, never re-derived) and the CAP (50 drawn
// of 137 kept, with the total always the store's own).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PermissionsHistory, PERMISSIONS_HISTORY_KEEP, permissionsHistoryEntry, waitedMs } from "../lib/permissions-history.js";
import { createPermissionsHistoryRoutes } from "../routes/permissions-history.js";
import "../public/core/permissions-history.js";

const Core = globalThis.wtPermissionsHistory;
const iso = (ms) => new Date(ms).toISOString();

function tempFile() {
  const dir = mkdtempSync(path.join(tmpdir(), "permissions-history-"));
  return { dir, file: path.join(dir, "permissions-history.json"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

function ask(store, n, over = {}) {
  const at = Date.UTC(2026, 0, 1, 0, n);
  return store.ask({
    requestId: `req-${n}`,
    command: `git push origin branch-${n}`,
    description: "writes outside the worktree",
    patternKey: "git-push",
    thread: `thread-${n}`,
    agent: `agent ${n}`,
    tree: `tree-${n}`,
    runId: `run-${n}`,
    jobId: `job-${n}`,
    assistantId: "assistant-1",
    assistantName: "Assistant #1",
    choices: ["once", "session", "always", "deny"],
    timeoutSeconds: 600,
    receivedAt: iso(at),
    deadline: at + 595_000,
    ...over,
  });
}

// ---- ordering and one record per request ------------------------------------------------------------------------
test("one record per request, newest first, and a replay cannot erase a decision", () => {
  const s = new PermissionsHistory({});
  ask(s, 1);
  ask(s, 2);
  ask(s, 3);
  assert.deepEqual(s.list().entries.map((e) => e.seq), [3, 2, 1]);
  assert.deepEqual(s.list().entries.map((e) => e.requestId), ["req-3", "req-2", "req-1"]);

  // The same request, presented again while it is open: the record is updated in place, not duplicated.
  s.ask({ requestId: "req-2", command: "git push origin branch-2 --force", choices: ["once", "deny"] });
  const open = s.list().entries;
  assert.equal(open.length, 3, "a replay must not invent a second row for one request");
  assert.equal(open.find((e) => e.requestId === "req-2").command, "git push origin branch-2 --force");
  assert.deepEqual(open.find((e) => e.requestId === "req-2").choices, ["once", "deny"]);

  // Answered, then replayed: the decision stands. A host id is unique per request, and a replay of a settled one is
  // the same request arriving again, not a new question.
  s.answered("req-2", { choice: "once", by: "reader", at: iso(Date.UTC(2026, 0, 1, 1)) });
  s.ask({ requestId: "req-2", command: "something else", choices: ["deny"] });
  const settled = s.list().entries.find((e) => e.requestId === "req-2");
  assert.equal(settled.status, "answered");
  assert.equal(settled.choice, "once");
  assert.equal(settled.command, "git push origin branch-2 --force");
});

// ---- answered ----------------------------------------------------------------------------------------------------
test("an answer records the choice, who and when, and a second answer cannot double-record", () => {
  const s = new PermissionsHistory({});
  ask(s, 1);
  const at = iso(Date.UTC(2026, 0, 1, 2, 0, 0));
  const first = s.answered("req-1", { choice: "session", by: "reader", at });
  assert.equal(first.status, "answered");
  assert.equal(first.choice, "session");
  assert.equal(first.answeredBy, "reader");
  assert.equal(first.answeredAt, at);
  assert.equal(first.closedWhy, "");

  // A second press, an instant later, with a different choice: the first decision is the record.
  const second = s.answered("req-1", { choice: "deny", by: "reader", at: iso(Date.UTC(2026, 0, 1, 2, 0, 5)) });
  assert.equal(second.choice, "session");
  assert.equal(second.answeredAt, at);

  // No choice at all is not an answer.
  ask(s, 2);
  assert.equal(s.answered("req-2", { choice: "" }).status, "open");
});

test("an answer that loses the race to the expiry is not recorded as a decision", () => {
  const s = new PermissionsHistory({});
  ask(s, 1);
  s.expired("req-1", { why: "timed out", at: iso(Date.UTC(2026, 0, 1, 0, 10)) });
  const late = s.answered("req-1", { choice: "once", by: "reader" });
  assert.equal(late.status, "expired");
  assert.equal(late.choice, "");
  assert.equal(late.answeredBy, "");
});

// ---- expired -----------------------------------------------------------------------------------------------------
test("an expiry is its own word, with a reason and a time, and never reads as a deny somebody chose", () => {
  const s = new PermissionsHistory({});
  ask(s, 1);
  const at = iso(Date.UTC(2026, 0, 1, 0, 10));
  const row = s.expired("req-1", { why: "timed out", at });
  assert.equal(row.status, "expired");
  assert.equal(row.closedWhy, "timed out");
  assert.equal(row.closedAt, at);
  assert.equal(row.choice, "");
  assert.equal(row.answeredBy, "");
  // The host's fail-closed rule sends `deny` to the waiting caller; that is the HOST's word, not this record's.
  assert.notEqual(row.choice, "deny");

  // An unknown word falls back to the only cause the panel can always prove.
  ask(s, 2);
  assert.equal(s.expired("req-2", { why: "someone felt like it" }).closedWhy, "timed out");

  // A row that was answered never turns into an expiry.
  ask(s, 3);
  s.answered("req-3", { choice: "once", by: "reader", at });
  assert.equal(s.expired("req-3", { why: "timed out" }).status, "answered");
});

// ---- reconcile: the restart, and the request the gateway dropped --------------------------------------------------
test("reconcile expires only what nobody can answer, and names the reason the row can prove", () => {
  const s = new PermissionsHistory({});
  ask(s, 1, { deadline: Date.UTC(2026, 0, 1, 1) });
  ask(s, 2, { deadline: Date.UTC(2026, 0, 2) });
  ask(s, 3);
  s.answered("req-3", { choice: "deny", by: "reader" });
  // Only req-2 is still live; req-1's deadline is long past.
  const changed = s.reconcile(["req-2"], { at: Date.UTC(2026, 0, 1, 5) });
  assert.equal(changed, 1, "only the one open row nobody can answer is settled");
  const rows = s.list().entries;
  assert.equal(rows.find((e) => e.requestId === "req-1").status, "expired");
  assert.equal(rows.find((e) => e.requestId === "req-1").closedWhy, "timed out");
  // Stamped at the DEADLINE, because that is when the window closed.
  assert.equal(rows.find((e) => e.requestId === "req-1").closedAt, iso(Date.UTC(2026, 0, 1, 1)));
  assert.equal(rows.find((e) => e.requestId === "req-2").status, "open");
  // The answered row keeps its decision and its time.
  assert.equal(rows.find((e) => e.requestId === "req-3").status, "answered");
  assert.equal(rows.find((e) => e.requestId === "req-3").choice, "deny");

  // Nothing live at all is the restart case: every open row is expired rather than looking answerable.
  ask(s, 4);
  s.reconcile([], { why: "the panel restarted", at: Date.UTC(2026, 0, 1, 6) });
  const after = s.list().entries.find((e) => e.requestId === "req-2");
  assert.equal(after.status, "expired");
  assert.equal(after.closedWhy, "the panel restarted");
});

// ---- the file: a restart re-reads it -----------------------------------------------------------------------------
test("the record survives a restart: the file is re-read, with the decisions and the expiries intact", () => {
  const tmp = tempFile();
  try {
    const first = new PermissionsHistory({ file: tmp.file });
    ask(first, 1);
    ask(first, 2);
    first.answered("req-1", { choice: "always", by: "reader", at: iso(Date.UTC(2026, 0, 1, 3)) });
    first.expired("req-2", { why: "timed out", at: iso(Date.UTC(2026, 0, 1, 4)) });
    const onDisk = JSON.parse(readFileSync(tmp.file, "utf8"));
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.entries.length, 2);

    // A NEW store over the same file is the restart: nothing in memory travels across.
    const second = new PermissionsHistory({ file: tmp.file });
    assert.equal(second.count(), 2);
    const rows = second.list().entries;
    const answered = rows.find((e) => e.requestId === "req-1");
    const expired = rows.find((e) => e.requestId === "req-2");
    assert.equal(answered.status, "answered");
    assert.equal(answered.choice, "always");
    assert.equal(answered.answeredAt, iso(Date.UTC(2026, 0, 1, 3)));
    assert.equal(expired.status, "expired");
    assert.equal(expired.closedWhy, "timed out");
    assert.equal(expired.closedAt, iso(Date.UTC(2026, 0, 1, 4)));
    // The next request keeps counting from the file's own sequence, so a seq is never reused.
    ask(second, 9);
    assert.equal(second.find("req-9").seq, 3);
  } finally {
    tmp.done();
  }
});

test("the store is bounded by its own cap, and keeps the newest", () => {
  const tmp = tempFile();
  try {
    const s = new PermissionsHistory({ file: tmp.file, keep: 3 });
    for (let n = 1; n <= 5; n += 1) ask(s, n);
    assert.equal(s.count(), 3);
    assert.deepEqual(s.list().entries.map((e) => e.requestId), ["req-5", "req-4", "req-3"]);
    assert.ok(PERMISSIONS_HISTORY_KEEP >= 100);
  } finally {
    tmp.done();
  }
});

// ---- the route ---------------------------------------------------------------------------------------------------
function routeHarness({ live = [], now = Date.UTC(2026, 0, 1, 2) } = {}) {
  const store = new PermissionsHistory({});
  const calls = [];
  const approvals = { list: () => live };
  const handler = createPermissionsHistoryRoutes({
    approvals,
    permissions: store,
    describe: (thread) => (thread === "thread-1" ? { runId: "run-1", jobId: "job-1", agent: "the agent", tree: "branch-1" } : {}),
    nameForAssistant: (id) => (id === "assistant-1" ? "Assistant One" : null),
    sendJson: (res, status, body) => calls.push({ status, body }),
    now: () => now,
  });
  const get = (query = "") =>
    handler({ method: "GET", url: `/api/permissions/history${query}` }, {}, "/api/permissions/history", new URL(`http://x/api/permissions/history${query}`));
  return { store, calls, get, handler };
}

test("the route counts only requests the panel can still answer, and settles the rest", () => {
  const now = Date.UTC(2026, 0, 1, 2);
  const live = [
    { id: "req-1", command: "git push origin branch-1", allowed: ["once", "deny"], thread: "thread-1", deadline: now + 60_000, timeoutSeconds: 600 },
    { id: "req-2", command: "git push origin branch-2", allowed: ["once", "deny"], thread: "thread-2", deadline: now - 1, timeoutSeconds: 600 },
  ];
  const h = routeHarness({ now, live });
  ask(h.store, 1, { deadline: now + 60_000 });
  ask(h.store, 2, { deadline: now - 1 });
  ask(h.store, 3, { deadline: now + 60_000 });
  h.store.answered("req-3", { choice: "once", by: "reader", at: iso(now - 1000) });
  h.calls.length = 0;
  h.get();
  const { status, body } = h.calls[0];
  assert.equal(status, 200);
  assert.equal(body.outstanding, 1, "a request past its deadline is not counted as waiting");
  assert.equal(body.pending.length, 1);
  assert.equal(body.pending[0].id, "req-1");
  assert.equal(body.pending[0].runId, "run-1", "the live row carries the run it belongs to");
  assert.equal(body.pending[0].choices.length, 2, "the route offers exactly the choices the host allowed");
  assert.equal(body.pending[0].assistantName, "Assistant One");
  const expired = body.entries.find((e) => e.requestId === "req-2");
  assert.equal(expired.status, "expired");
  assert.equal(expired.closedWhy, "timed out");
  assert.equal(body.entries.find((e) => e.requestId === "req-3").status, "answered");
});

test("the route's limit is a render cap, never a filter on the total", () => {
  const h = routeHarness();
  for (let n = 1; n <= 60; n += 1) ask(h.store, n);
  h.get("?limit=50");
  const body = h.calls.at(-1).body;
  assert.equal(body.entries.length, 50);
  assert.equal(body.total, 60, "the total is the store's own, not the page it drew");
  h.get();
  assert.equal(h.calls.at(-1).body.entries.length, 60);
});

test("the route refuses anything but GET", async () => {
  const h = routeHarness();
  await h.handler({ method: "POST", url: "/api/permissions/history" }, {}, "/api/permissions/history", new URL("http://x/api/permissions/history"));
  assert.equal(h.calls.at(-1).status, 405);
});

// ---- the page's pure half ----------------------------------------------------------------------------------------
test("the page reads the three states, and an unknown status is never an answer", () => {
  assert.deepEqual(Core.STATES, ["open", "answered", "expired"]);
  assert.equal(Core.stateOf({ status: "open" }), "open");
  assert.equal(Core.stateOf({ status: "answered" }), "answered");
  assert.equal(Core.stateOf({ status: "expired" }), "expired");
  assert.equal(Core.stateOf({ status: "teleported" }), "expired");
  assert.equal(Core.stateOf({}), "open");
});

test("the list draws every open request first, the one closing soonest at the top", () => {
  const rows = [
    { seq: 1, status: "expired", deadline: 10, askedAt: iso(Date.UTC(2026, 0, 1, 0, 1)) },
    { seq: 2, status: "open", deadline: 90, askedAt: iso(Date.UTC(2026, 0, 1, 0, 2)) },
    { seq: 3, status: "answered", deadline: 20, askedAt: iso(Date.UTC(2026, 0, 1, 0, 3)) },
    { seq: 4, status: "open", deadline: 40, askedAt: iso(Date.UTC(2026, 0, 1, 0, 4)) },
  ];
  assert.deepEqual(Core.ordered(rows).map((r) => r.seq), [4, 2, 3, 1]);
});

test("the expired line counts from the ask and says its own word", () => {
  const asked = Date.UTC(2026, 0, 1, 0, 0);
  const row = { askedAt: iso(asked), closedAt: iso(asked + 4 * 60_000), closedWhy: "timed out" };
  assert.equal(Core.closedLine(row), "timed out after 4m");
  // A row with no closing time says the word and invents no span.
  assert.equal(Core.closedLine({ askedAt: iso(asked), closedWhy: "the panel restarted" }), "the panel restarted");
});

test("a choice prints the panel's own word for it, and the key when a host sends one it does not know", () => {
  assert.equal(Core.choiceText({ choice: "once" }), "Allow once (once)");
  assert.equal(Core.choiceText({ choice: "deny" }), "Deny (deny)");
  assert.equal(Core.choiceText({ choice: "for-a-week" }), "for-a-week");
  assert.equal(Core.choiceText({}), "");
});

test("the cap is honest: 50 drawn of 137, with the store's own total beside it", () => {
  const rows = Array.from({ length: 137 }, (_, i) => ({ seq: i + 1, status: "answered", choice: "once", askedAt: iso(Date.UTC(2026, 0, 1, 0, 0) + i * 1000) }));
  const cap = Core.capOf(rows);
  assert.equal(cap.shown, 50);
  assert.equal(cap.total, 137);
  assert.equal(cap.more, true);
  assert.equal(cap.foot, "showing 50 of 137");
  assert.equal(Core.capOf(rows, 200).foot, "showing all 137");
  assert.equal(Core.footText(0, 0), "no permission requests yet");
});

test("the names a row carries fall back instead of printing an empty cell", () => {
  const names = Core.namesOf({ thread: "thread-9", agent: "the agent", runId: "run-9" });
  assert.equal(names.agent, "the agent");
  assert.equal(names.thread, "thread-9");
  assert.equal(names.run, "run-9");
  assert.equal(names.tree, "(no tree)");
  const bare = Core.namesOf({});
  assert.equal(bare.agent, "an agent");
  assert.equal(bare.run, "no run recorded");
});

test("a row's exact request text survives the one-line copy", () => {
  assert.equal(Core.requestLine({ command: "git push origin x" }), "git push origin x");
  assert.equal(Core.requestLine({}), "(the request text was not recorded)");
  assert.equal(Core.policyLine({ policy: "writes outside the worktree" }), "writes outside the worktree");
});

test("the store's entry builder keeps the gateway's policy note and the host's choices", () => {
  const entry = permissionsHistoryEntry({ requestId: "r1", command: "rm -rf x", description: "destructive command", allowed: ["once", "deny"], timeoutSeconds: 0 });
  assert.equal(entry.policy, "destructive command");
  assert.deepEqual(entry.choices, ["once", "deny"]);
  assert.equal(entry.timeoutSeconds, null, "a 0 s window is deny-at-once, not a number to draw a countdown from");
  assert.equal(waitedMs({ askedAt: iso(1000), closedAt: iso(61_000) }), 60_000);
});
