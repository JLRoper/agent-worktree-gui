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
    ["running", "▸", "Start"],
    ["parked", "‖", "Park"],
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
  assert.ok(html.includes(">→</button>"), "Move is the → glyph");
  // A done row's queue press is Requeue, and it says so.
  const done = queueTaskHtml("assistant-1", { id: 9, title: "d", state: "done", files: [] });
  assert.ok(done.includes('aria-label="Requeue"') && done.includes(">↺</button>"), "a done row's ↺ is Requeue");
  // …and a parked row's queue press is the ⤵ Queue one.
  const parked = queueTaskHtml("assistant-1", { id: 10, title: "p", state: "parked", files: [] });
  assert.ok(parked.includes('aria-label="Queue"') && parked.includes(">⇣</button>"), "a parked row's ⇣ is Queue");
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

test("a row with no other assistant offers no move, and no sentence about the deployment", () => {
  const solo = build({ ids: ["assistant-1"] });
  const html = solo.queueTaskHtml("assistant-1", { id: 6, title: "solo", state: "queued", files: [] });
  assert.ok(!html.includes('data-as-qact="reassign"'), "a lone assistant cannot move work to itself");
  assert.ok(!html.includes("data-as-qmove-open"), "and no ➡️ either");
  // The sentence used to be printed in every row of a one-assistant board, where it read as a disabled control.
  assert.ok(!html.includes("no other assistant to move it to"), "the repeated hint is gone; the control's title says it");
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
  // …and the pill is the card's own: classes and words, one run at a time. A STOPPED run's chip is a button now (the
  // re-attach press), so the match reads both tags — the word and the classes are unchanged, which is the point.
  const pills = [...html.matchAll(/<(span|button)[^>]*class="([^"]*pill[^"]*)"[^>]*>(running|complete|exited|not-running)/g)].map((m) => `${m[1]}|${m[2]}|${m[3]}`);
  assert.deepEqual(pills, [
    "span|pill pill-running|running",
    "button|pill pill-complete|complete",
    "button|pill pill-notrunning is-failed pill-reattach|exited",
    "button|pill pill-notrunning pill-reattach|not-running",
    "span|pill pill-running|running",
    "button|pill pill-notrunning pill-reattach|not-running",
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

// A row parked on a QUESTION is not a lane, and the chip is what says so. The join is by thread — the open alert's
// thread against the row's whole `threads[]` history — and it reuses the hold badge's own class, so the stylesheet
// gains nothing for it.
test("a row whose thread is parked on a question wears one `question` chip, and no other row does", () => {
  const { queueTaskHtml } = build();
  const row = { id: 21, title: "carry it", state: "running", files: [], threads: ["T-quiet", "T-asked"] };
  const asked = {
    id: "a1b2c3d4",
    rule: "question",
    status: "open",
    parked: true,
    requestId: "req-7",
    thread: "T-asked",
    at: "2026-11-02T10:00:00.000Z",
    title: "waiting on your answer: which of these?",
    detail: "worker-3 is parked on a question · waiting 4m · 2 choices",
    choices: ["ship it", "wait"],
  };
  const html = queueTaskHtml("assistant-1", row, new Map(), new Map(), [asked]);
  const chips = [...html.matchAll(/<button[^>]*class="as-task-hold as-task-question"[^>]*>question<\/button>/g)];
  assert.equal(chips.length, 1, "exactly one question chip on the row");
  assert.ok(chips[0][0].includes('data-as-qopen="T-asked"'), "the chip opens the ALERT's agent, not the task's last thread");
  assert.ok(chips[0][0].includes('data-as-qquestion="a1b2c3d4"'), "…and names the alert it came from");
  assert.ok(!html.includes("as-qchip"), "no second class was invented for it: the hold badge's own is reused");

  // The control: every way the same alert can fail to be a question in force.
  const control = (alerts, name) =>
    assert.ok(
      !queueTaskHtml("assistant-1", row, new Map(), new Map(), alerts).includes(">question</button>"),
      `${name} draws no chip`,
    );
  control([], "no alerts at all");
  control([{ ...asked, status: "answered" }], "an alert that is closed");
  control([{ ...asked, thread: "T-somebody-else" }], "an alert on another thread");
  control([{ ...asked, parked: false, requestId: null }], "a prose question that is not parked");
  control([{ ...asked, rule: "approval" }], "an approval");
  assert.ok(
    queueTaskHtml("assistant-1", row, new Map(), new Map(), [{ ...asked, rule: "clarify" }]).includes(">question</button>"),
    "a clarify-rule alert is a question even without the parked flag",
  );
  // A legacy record with only `thread` joins the same way, and a row whose thread nobody asked on stays clean.
  assert.ok(
    queueTaskHtml("assistant-1", { id: 22, title: "old", state: "parked", thread: "T-asked", files: [] }, new Map(), new Map(), [asked]).includes(
      'data-as-qopen="T-asked"',
    ),
    "a legacy `thread`-only record joins too",
  );
  assert.ok(
    !queueTaskHtml("assistant-1", { id: 23, title: "quiet", state: "queued", thread: "T-quiet", files: [] }, new Map(), new Map(), [asked]).includes(
      ">question</button>",
    ),
    "the row that was not asked stays clean",
  );
});

// ---- the facts line: WHERE on one line, the second read folded -------------------------------------
// The card's facts line is the row's own string (`project Menu · PR #12 open`), and the tree, files, attempts and
// detail are the row's closed disclosure. The assertions read those two containers rather than the whole markup: a
// path anywhere else on the row (a title, a reason) must not pass for the fact under test.
const metaOf = (html) => {
  const m = /<span class="as-task-meta">([\s\S]*?)<\/span>/.exec(html);
  return m ? m[1] : "";
};
const foldOf = (html) => {
  const m = /<div class="as-task-more-body">([\s\S]*?)<\/div>/.exec(html);
  return m ? m[1] : "";
};

test("the facts line is the project and the PR, and the files are one press away", () => {
  const { queueTaskHtml } = build();
  const html = queueTaskHtml(
    "assistant-1",
    { id: 1, title: "carry it", state: "queued", project: "Menu", files: ["lib/assistant/queue.js", "public/assistant.js"] },
    new Map(),
  );
  assert.equal(metaOf(html), "project Menu", "the project is the whole facts line when there is no PR");
  assert.match(foldOf(html), /files lib\/assistant\/queue\.js, public\/assistant\.js/, "…and the files are in the fold");
  assert.equal(metaOf(html).includes("files"), false, "the files are not printed on the facts line");
});

test("an old row with no project derives one from its worktree, as a NAME, and the path is folded", () => {
  const { queueTaskHtml } = build();
  const html = queueTaskHtml(
    "assistant-1",
    { id: 2, title: "old row", state: "running", worktree: "C:/ProjectDevelopment/Menu/.worktrees/put-a-thing-1234", files: [] },
    new Map(),
  );
  assert.equal(metaOf(html), "project Menu", "the segment before /.worktrees/, reduced to its directory name");
  assert.match(foldOf(html), /tree C:\/ProjectDevelopment\/Menu\/\.worktrees\/put-a-thing-1234/, "the tree word keeps the path, in the fold");
});

test("a tree outside .worktrees/ falls back to the row's own project, and the PR stays on the facts line", () => {
  const { queueTaskHtml } = build();
  const html = queueTaskHtml(
    "assistant-1",
    {
      id: 3,
      title: "in the project checkout",
      state: "running",
      worktree: "C:/ProjectDevelopment/Menu",
      row: { path: "C:/ProjectDevelopment/Menu", branch: "main", verdict: "ON MAIN", project: "Menu" },
      files: [],
    },
    new Map(),
  );
  assert.equal(metaOf(html), "project Menu · PR ON MAIN");
});

test("nothing to derive draws NO project word, and the files are still on the row", () => {
  const { queueTaskHtml } = build();
  const html = queueTaskHtml("assistant-1", { id: 4, title: "loose work", state: "queued", worktree: "C:/scratch/a-loose-tree", files: ["lib/x.js"] }, new Map());
  assert.equal(metaOf(html), "", "a row that cannot say where it is says nothing");
  assert.match(foldOf(html), /files lib\/x\.js/, "…and the files are in the fold");
});

test("a long project name never pushes the row around, and the fold keeps the first four files", () => {
  const { queueTaskHtml } = build();
  const files = ["lib/a.js", "lib/b.js", "public/c.js", "test/d.test.js", "tools/e.mjs"];
  const html = queueTaskHtml(
    "assistant-1",
    { id: 5, title: "many files", state: "queued", project: "C:/ProjectDevelopment/a-very-long-project-directory-name-that-would-wrap", files },
    new Map(),
  );
  assert.equal(metaOf(html), "project a-very-long-project-directory-name-that-would-wrap", "the name is the directory, however long");
  assert.match(foldOf(html), /files lib\/a\.js, lib\/b\.js, public\/c\.js, test\/d\.test\.js…/, "the first four files and the ellipsis");
});

// ---- the head: the state in a word, the row's own hover text, and what it is waiting on -----------
test("the head says the state in a word, and a stale row says stale while its data state stays running", () => {
  const { queueTaskHtml } = build();
  const base = { id: 1, title: "carry it", files: [] };
  for (const state of ["queued", "running", "parked", "done"]) {
    const html = queueTaskHtml("assistant-1", { ...base, state }, new Map());
    assert.ok(html.includes(`<span class="as-task-state is-${state}"`), `${state} carries its word`);
    assert.ok(html.includes(`>${state}</span>`), `…and prints it`);
    assert.ok(html.includes(`data-as-qstate="${state}"`), "the data state the drag reads is unchanged");
  }
  const stale = queueTaskHtml("assistant-1", { ...base, id: 2, state: "running", stale: true, staleWhy: "that thread has no live run" }, new Map());
  assert.ok(stale.includes('<span class="as-task-state is-stale"'), "a stale row's word is stale");
  assert.ok(stale.includes(">stale</span>"), "…and it is the word a reader sees");
  assert.ok(stale.includes('data-as-qstate="running"'), "…while the stored state is still running");
  assert.match(stale, /title="stale — the file still says running, but its thread has no live run"/, "the word explains itself on hover");
});

test("the row's description, tree, files and attempts sit behind one closed disclosure", () => {
  const { queueTaskHtml } = build();
  const html = queueTaskHtml(
    "assistant-1",
    {
      id: 7,
      title: "fold it",
      state: "queued",
      worktree: "C:/ProjectDevelopment/Menu/.worktrees/fold-1",
      files: ["lib/a.js"],
      attempts: 2,
      detail: "the paragraph a reader only needs after the first question",
      project: "Menu",
    },
    new Map(),
  );
  assert.ok(html.includes('<details class="as-task-more">'), "the disclosure exists");
  assert.ok(!/<details class="as-task-more" open/.test(html), "…and starts closed");
  const fold = foldOf(html);
  assert.match(fold, /tree C:\/ProjectDevelopment\/Menu\/\.worktrees\/fold-1/, "the tree is folded");
  assert.match(fold, /files lib\/a\.js/, "the files are folded");
  assert.match(fold, /2 attempts/, "the attempts are folded");
  assert.match(fold, /the paragraph a reader only needs after the first question/, "the detail is folded");
  assert.ok(!metaOf(html).includes("tree "), "none of it is printed on the facts line");
  assert.match(html, /<summary title="the tree, the files, the attempts and the detail/, "the summary explains the fold on hover");
});

test("the waiting-on chip draws the lane head the store derived, naming the lane in its hover text", () => {
  const { queueTaskHtml } = build();
  const html = queueTaskHtml(
    "assistant-1",
    { id: 8, title: "behind the head", state: "queued", files: ["lib/assistant.js"], waitingOn: { id: 3, lane: "lib/assistant.js" } },
    new Map(),
  );
  assert.ok(html.includes('data-as-qwait="3"'), "the chip names the row it waits on");
  assert.ok(html.includes(">waiting on #3</span>"), "…in three words a reader can scan");
  assert.ok(/title="waiting on #3 — #3 heads this lane \(lib\/assistant\.js\)/.test(html), "…with the lane file on hover");

  const quiet = queueTaskHtml("assistant-1", { id: 9, title: "no lane", state: "queued", files: [] }, new Map());
  assert.ok(!quiet.includes("as-task-wait"), "a row with no lane head wears no chip");
});
