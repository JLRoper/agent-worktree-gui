// The Queue sub-tab's row: one task, its four markers, one sub-row per AGENT and the presses on it.
//
// The row renderer is the page's own code, sliced out of public/assistant.js and driven against stubs — the same
// style as assistant-subtabs.test.js. What this pins:
//
//   - ○ queued, ● running, ⏸ parked, ✓ done still reach the task's own marker, and a done row is the only greyed one;
//   - one sub-row per thread on `threads[]`, each carrying the mark and the card's own pill (class + word) for the
//     status its RUN has in the job map — never the task's stored state, which is why a parked task with a live run
//     still reads RUNNING and a running task whose run is gone reads EXITED;
//   - a legacy record with only `thread` draws one sub-row, and a task nobody has run says so;
//   - every press is a GLYPH whose title= and aria-label= carry the real word (▶ Start, ⤵ Queue, ↺ Requeue, ⏸ Park,
//     ✓ Done, ➡️ Move, ✕ Delete);
//   - Move is a popover: no always-visible <select>, a ➡️ that opens it, and one pick per other assistant carrying
//     data-as-qmove-to — the value the reassign route is posted with.
//
// The region's top level only constructs a Map and declares functions, so evaluating it executes nothing that needs a
// document. `esc`, the assistant list, the session lookup and the thread-label lookup are handed in.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sliceRegion } from "../tools/panel-testkit.mjs";

const assistant = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
const region = sliceRegion(assistant, "the queue sub-tab");

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const build = ({ ids = ["assistant-1", "assistant-2"], label = (t) => t } = {}) =>
  new Function(
    "esc",
    "assistantIds",
    "sessionById",
    "assistantThreadName",
    `${region}
return { queueMark, queueStateName, queueAgentChip, queueTaskHtml };`,
  )(esc, () => ids, (id) => ({ id, name: `Assistant ${id}` }), label);

const jobs = (pairs) => new Map(pairs);

test("the queue's four markers are the brief's four", () => {
  const { queueMark } = build();
  assert.equal(queueMark("queued"), "○");
  assert.equal(queueMark("running"), "●");
  assert.equal(queueMark("parked"), "⏸");
  assert.equal(queueMark("done"), "✓");
});

test("queueStateName falls every unknown state back to queued", () => {
  const { queueStateName } = build();
  assert.equal(queueStateName("queued"), "queued");
  assert.equal(queueStateName("running"), "running");
  assert.equal(queueStateName("parked"), "parked");
  assert.equal(queueStateName("done"), "done");
  assert.equal(queueStateName("bogus"), "queued");
});

test("each task row renders its state's marker and its marker class", () => {
  const { queueTaskHtml } = build();
  const base = { id: 1, title: "carry it", owner: "assistant-1", files: [] };
  const cases = [
    ["queued", "○"],
    ["running", "●"],
    ["parked", "⏸"],
    ["done", "✓"],
  ];
  for (const [state, mark] of cases) {
    const html = queueTaskHtml("assistant-1", { ...base, state }, new Map());
    assert.ok(html.includes(`>${mark}</span>`), `${state} renders its marker ${mark}`);
    assert.ok(html.includes(`as-task-mark is-${state}`), `${state} carries its marker class`);
    assert.equal(html.includes("as-task is-done"), state === "done", `${state} row's greyed class`);
  }
});

test("a stale row and a skipped row carry their reason under the marker", () => {
  const { queueTaskHtml } = build();
  const stale = queueTaskHtml("assistant-1", { id: 2, title: "phantom", state: "running", stale: true, staleWhy: "that thread has no live run", files: [] });
  assert.ok(stale.includes("STALE — that thread has no live run"), "the stale sentence is shown, not a spinner");
  const skipped = queueTaskHtml("assistant-1", { id: 3, title: "next", state: "queued", conflict: { files: ["lib/a.js"] }, skipped: "files in use by #2", files: [] });
  assert.ok(skipped.includes("SKIPPED — files in use by #2"), "the conflict's reason is shown on the tab");
});

test("the row offers only transitions away from its current state", () => {
  const { queueTaskHtml } = build();
  const queued = queueTaskHtml("assistant-1", { id: 4, title: "q", state: "queued", files: [] });
  assert.ok(!queued.includes('data-as-qact="queued"'), "no Queue button on a queued row");
  assert.ok(queued.includes('data-as-qact="running"'), "Start is offered");
  assert.ok(queued.includes('data-as-qact="parked"'), "Park is offered");
  assert.ok(queued.includes('data-as-qact="done"'), "Done is offered");
  assert.ok(queued.includes('data-as-qact="delete"'), "delete is always offered");
  const done = queueTaskHtml("assistant-1", { id: 5, title: "d", state: "done", files: [] });
  assert.ok(!done.includes('data-as-qact="done"'), "no Done button on a done row");
  assert.ok(done.includes('data-as-qact="queued"'), "Requeue is offered on a done row");
});

test("every press is a glyph carrying the real word in title= and aria-label=", () => {
  const { queueTaskHtml } = build();
  // A queued row offers the most presses at once: Start, Park, Done, Move and Delete.
  const html = queueTaskHtml("assistant-1", { id: 8, title: "g", state: "queued", files: [], threads: [] });
  const wanted = [
    ["running", "▶", "Start"],
    ["parked", "⏸", "Park"],
    ["done", "✓", "Done"],
    ["delete", "✕", "Delete"],
  ];
  for (const [act, glyph, word] of wanted) {
    const m = new RegExp(`<button[^>]*data-as-qact="${act}"[^>]*>`).exec(html);
    assert.ok(m, `${word} is drawn`);
    const tag = m[0];
    assert.ok(html.includes(`>${glyph}</button>`), `${word} is the glyph ${glyph}, not a word`);
    assert.ok(tag.includes(`aria-label="${word}"`), `${word}: aria-label carries the real word`);
    assert.ok(new RegExp(`title="${word} — `).test(tag), `${word}: title starts with the real word`);
  }
  // The Move press is the popover's opener, and the word lives in its own aria-label.
  const mv = /<button[^>]*data-as-qmove-open[^>]*>/.exec(html);
  assert.ok(mv, "Move is offered when another assistant exists");
  assert.ok(mv[0].includes('aria-label="Move"') && mv[0].includes('title="Move — '), "Move: title and aria-label carry the word");
  assert.ok(html.includes(">➡️</button>"), "Move is the ➡️ glyph");
  // A done row's queue press is Requeue, and it says so.
  const done = queueTaskHtml("assistant-1", { id: 9, title: "d", state: "done", files: [] });
  assert.ok(done.includes('aria-label="Requeue"') && done.includes(">↺</button>"), "a done row's ↺ is Requeue");
  // …and a parked row's queue press is the ⤵ Queue one.
  const parked = queueTaskHtml("assistant-1", { id: 10, title: "p", state: "parked", files: [] });
  assert.ok(parked.includes('aria-label="Queue"') && parked.includes(">⤵</button>"), "a parked row's ⤵ is Queue");
});

test("Move is a popover, not an always-visible select", () => {
  const { queueTaskHtml } = build();
  const html = queueTaskHtml("assistant-1", { id: 7, title: "move me", state: "queued", files: [] });
  assert.ok(!html.includes("<select"), "the assistant <select> is gone");
  assert.ok(!html.includes("data-as-qmove=") || html.includes("data-as-qmove-open="), "only the opener carries the old prefix");
  assert.ok(html.includes('class="as-qmove-pop"') && html.includes("hidden"), "the list starts closed");
  assert.ok(html.includes('role="menu"'), "the list is a menu");
  // One pick per OTHER assistant, each carrying the value the reassign route is posted with.
  assert.ok(html.includes('data-as-qmove-to="assistant-2"'), "the other assistant is a pick");
  assert.ok(!html.includes('data-as-qmove-to="assistant-1"'), "the row's own assistant is not a destination");
  assert.ok(html.includes('data-as-qact="reassign"'), "a pick is the same reassign press the button was");
});

test("a row with no other assistant offers no move", () => {
  const solo = build({ ids: ["assistant-1"] });
  const html = solo.queueTaskHtml("assistant-1", { id: 6, title: "solo", state: "queued", files: [] });
  assert.ok(html.includes("no other assistant to move it to"), "a lone assistant cannot move work to itself");
  assert.ok(!html.includes('data-as-qact="reassign"'), "and no pick is drawn");
  assert.ok(!html.includes("data-as-qmove-open"), "and no ➡️ either");
});

test("one sub-row per agent, each with its own mark and the card's own pill", () => {
  const { queueTaskHtml } = build();
  const map = jobs([
    ["T-live", { status: "running" }],
    ["T-loading", { status: "starting" }],
    ["T-done", { status: "done" }],
    ["T-failed", { status: "failed" }],
    ["T-gone", { status: "cancelled" }],
    ["T-asked", { status: "waiting_for_approval" }],
  ]);
  const html = queueTaskHtml(
    "assistant-1",
    { id: 11, title: "carried twice", state: "parked", files: [], threads: ["T-live", "T-done", "T-failed", "T-gone", "T-asked", "T-missing"] },
    map,
  );
  const rows = [...html.matchAll(/<div class="as-task-agent" role="button"[^>]*data-as-qopen="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(rows, ["T-live", "T-done", "T-failed", "T-gone", "T-asked", "T-missing"], "one sub-row per thread, in record order");
  // The mark is the RUN's, so the task being parked does not turn its live agent into a parked one.
  const marks = [...html.matchAll(/<span class="as-agent-mark is-([a-z]+)" aria-hidden="true">(.)<\/span>/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(marks, ["running:●", "done:✓", "queued:○", "queued:○", "parked:⏸", "queued:○"]);
  // …and the pill is the card's own: classes and words, one run at a time.
  const pills = [...html.matchAll(/<span class="([^"]*pill[^"]*)"[^>]*>(running|complete|exited|not-running)<\/span>/g)].map((m) => `${m[1]}|${m[2]}`);
  assert.deepEqual(pills, [
    "pill pill-running|running",
    "pill pill-notrunning is-failed|exited",
    "pill pill-notrunning|not-running",
    "pill pill-running|running",
    "pill pill-notrunning|not-running",
  ], "the words and classes are the card's own, in record order");
  // COMPLETE is the card's BUTTON (`button.pill-complete`), not a span.
  assert.ok(/<button type="button" class="pill pill-complete"/.test(html), "a done run wears button.pill-complete");
  assert.ok(html.includes(">complete</button>"), "…and the word is the card's");
  // The task-level mark still says what the READER decided.
  assert.ok(html.includes("as-task-mark is-parked"), "the row's own marker is the task state");
});

test("a legacy record with only `thread` draws one sub-row, and a task nobody ran says so", () => {
  const { queueTaskHtml } = build();
  const legacy = queueTaskHtml("assistant-1", { id: 12, title: "old queue", state: "running", thread: "T-legacy", files: [] }, jobs([["T-legacy", { status: "running" }]]));
  assert.equal((legacy.match(/class="as-task-agent"/g) || []).length, 1, "one agent row from the legacy field");
  assert.ok(legacy.includes('data-as-qopen="T-legacy"'), "…opening that thread");
  assert.ok(legacy.includes("pill pill-running"), "…with its live status");
  const empty = queueTaskHtml("assistant-1", { id: 13, title: "not started", state: "queued", files: [], threads: [] }, new Map());
  assert.ok(empty.includes("no agent yet"), "a task with no agent says so instead of drawing a fake one");
  assert.ok(!empty.includes("data-as-qopen"), "…and nothing in it is an opener");
});

test("the agent's label is drawn when it is not just the thread id", () => {
  const { queueTaskHtml } = build({ label: (t) => (t === "T-named" ? "land the queue row" : t) });
  const named = queueTaskHtml("assistant-1", { id: 14, title: "x", state: "running", files: [], threads: ["T-named", "T-bare"] }, new Map());
  assert.ok(named.includes('<span class="as-task-agent-label">land the queue row</span>'), "a readable label is shown");
  assert.equal((named.match(/class="as-task-agent-label"/g) || []).length, 1, "…and the bare thread id is not printed twice");
});
