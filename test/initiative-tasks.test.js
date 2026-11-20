// THE EXACT TASKS UNDER AN ASSISTANT ON THE INITIATIVES TAB: the grouping the route hands the page, the fold key and
// the state chips the page draws, and the contract that a live row is patched where it stands.
//
// WHY THIS FILE EXISTS. The tab already said an assistant had worked an initiative and how many rows it held. The
// expansion that shows WHICH rows has three wrong answers that all look right on a screenshot:
//
//   1. MEMBERSHIP BY BRANCH NAME. A row is on this initiative because the queue file's own `worktree` is one of the
//      initiative's trees - not because its branch looks like the tree's, and not because a tree scan found it. A task
//      with no initiative link must never appear; a tree on two initiatives must put the same row under both, never
//      twice under one.
//   2. A RUN ID ON A DEAD ROW. The queue keeps the run a done task finished on; drawing it beside "done" reads as a
//      live run. The run is drawn only while the row is live, and the PR only when the row has one.
//   3. A REBUILT FOLD. The pane repaints on every snapshot, so a list rebuilt from markup would re-animate under the
//      reader every couple of seconds and drop their place. The rows are reconciled by task id and patched in place;
//      the fourth test below pins that from the pane's own source, because it is a fact about DOM identity that no
//      pure function can carry.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initiativesView } from "../routes/initiatives.js";
import { normTreePath } from "../lib/initiatives.js";
import { sliceRegion } from "../tools/panel-testkit.mjs";

await import("../public/core/initiative-fold.js");
const fold = globalThis.wtInitiativeFold;
const pane = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");

// ---- the fixture: two initiatives, one tree on both, one tree on neither -----------------------------------------
// The trees are repo-relative placeholders, not this machine's folders: the code keys on the string, nothing asserts
// its shape, and a drive-letter path belongs to exactly one machine.
const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const iso = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();
const treeOf = (p) => ({ key: normTreePath(p), path: p, at: iso(600), by: "reader", attachedAt: iso(600), attachedBy: "reader" });
const one = treeOf("worktrees/sso-one");
const two = treeOf("worktrees/sso-two");
const shared = treeOf("worktrees/menu-one");
const elsewhere = treeOf("worktrees/nowhere");

const initiatives = {
  statusOf: () => ({ file: "logs/initiatives.json", found: true, readable: true, error: "" }),
  initiativeList: () => [
    { id: "init_a", title: "SSO migration", description: "", createdAt: iso(900), updatedAt: iso(900), updatedBy: "reader" },
    { id: "init_b", title: "Menu cutover", description: "", createdAt: iso(800), updatedAt: iso(800), updatedBy: "reader" },
  ],
  treesFor: (id) => (id === "init_a" ? [one, two, shared] : [shared]),
  historyFor: () => [],
};
const projectForPath = () => ({ name: "alpha" });
// The board row: the PR's page is the ROW's own `prUrl`, exactly as the chart's cell reads it; a row with no page
// answers null so the fold can only draw plain text.
const rowFor = (project, p) => {
  const want = normTreePath(p);
  if (want === normTreePath(elsewhere.path)) return { path: p, name: "nowhere", branch: "work/nowhere", pr: null, prUrl: null };
  const name = want.split("/").pop();
  const pr = want === normTreePath(shared.path) ? { number: 71, state: "OPEN" } : null;
  return {
    path: p,
    name,
    branch: `work/${name}`,
    pr,
    prUrl: pr ? "https://git.example.test/projects/IT/repos/beta/pull-requests/71" : null,
  };
};
const assistants = [
  { id: "assistant-1", name: "Scout", threadId: "thread-scout" },
  { id: "assistant-2", name: "Builder", threadId: "thread-builder" },
];
const queues = {
  "assistant-1": {
    tasks: [
      // The running row: live NOW, so it sorts first, and its run is the run it is on.
      { id: 4, title: "Wire the SSO callback", state: "running", worktree: one.path, thread: "wtgui-sso-one", runId: "chatcmpl-run-4", startedAt: iso(2) },
      // A done row on the tree BOTH initiatives carry, with a pull request the board row knows about.
      { id: 2, title: "Land the Menu login page", state: "done", worktree: shared.path, thread: "wtgui-menu-one", runId: "chatcmpl-run-2", doneAt: iso(30), row: { pr: { number: 71, state: "OPEN" } } },
      // A queued row on a tree NO initiative carries: it must not appear anywhere on the tab.
      { id: 7, title: "Not on any initiative", state: "queued", worktree: elsewhere.path, createdAt: iso(5) },
    ],
  },
  "assistant-2": {
    tasks: [
      // Parked, and with no clock at all: it sorts after the row that has one.
      { id: 9, title: "Wait for the DBA", state: "parked", worktree: shared.path, thread: "wtgui-menu-one-b", reason: "waiting on the DBA" },
      { id: 11, title: "Queue the gateway retry", state: "queued", worktree: two.path, createdAt: iso(60) },
    ],
  },
};
const view = () =>
  initiativesView({
    initiatives,
    projectForPath,
    rowFor,
    assistants,
    queueFor: (id) => queues[id] || { tasks: [] },
    now: NOW,
    tier: "none",
  });

const assistantsOf = (doc, id) => doc.initiatives.find((i) => i.id === id).assistants;
const oneAssistant = (doc, initId, assistantId) => assistantsOf(doc, initId).find((a) => a.id === assistantId);

// ---- 1. the grouping ---------------------------------------------------------------------------------------------
test("one assistant's fold lists every queue row on this initiative's trees, newest activity first", () => {
  const doc = view();
  const scout = oneAssistant(doc, "init_a", "assistant-1");
  assert.ok(scout, "the assistant that worked the initiative is on its document");
  assert.deepEqual(scout.taskRows.map((r) => r.id), [4, 2], "the running row is working now, so it leads; then the done one");
  assert.equal(scout.tasks, scout.taskRows.length, "the count beside the fold is the number of rows it opens");
  // The second assistant's list is its own: a parked row with no clock sorts after the queued one that has one.
  const builder = oneAssistant(doc, "init_a", "assistant-2");
  assert.deepEqual(builder.taskRows.map((r) => r.id), [11, 9]);
  assert.deepEqual(builder.counts, { queued: 1, running: 0, done: 0, parked: 1 });
});

test("a task with no initiative link never appears under an initiative", () => {
  const doc = view();
  const ids = doc.initiatives.flatMap((i) => i.assistants.flatMap((a) => a.taskRows.map((r) => r.id)));
  assert.equal(ids.includes(7), false, "queued on a worktree no initiative carries, so it is on no initiative's document");
  assert.equal(
    JSON.stringify(doc).includes("Not on any initiative"),
    false,
    "and not even its title rides the document",
  );
});

test("a tree on two initiatives puts the same task under both, once in each", () => {
  const doc = view();
  const underA = oneAssistant(doc, "init_a", "assistant-1").taskRows.map((r) => r.id);
  const underB = oneAssistant(doc, "init_b", "assistant-1").taskRows.map((r) => r.id);
  assert.deepEqual(underA, [4, 2]);
  assert.deepEqual(underB, [2], "the shared tree's task, shown under the second initiative too");
  for (const list of [underA, underB]) assert.equal(new Set(list).size, list.length, "never twice within one initiative");
  // The second initiative's other assistant is the parked row on the same tree - and only that one.
  assert.deepEqual(oneAssistant(doc, "init_b", "assistant-2").taskRows.map((r) => r.id), [9]);
});

test("a row names its own id, title, state, thread, run id when live, and its PR when it has one", () => {
  const doc = view();
  const rows = oneAssistant(doc, "init_a", "assistant-1").taskRows;
  const live = rows.find((r) => r.id === 4);
  assert.equal(live.title, "Wire the SSO callback");
  assert.equal(live.state, "running");
  assert.equal(live.thread, "wtgui-sso-one", "the thread comes from the row, not from a tree");
  assert.equal(live.runId, "chatcmpl-run-4", "a live row names the run it is on");
  assert.equal(live.pr, null, "and has no pull request");
  const done = rows.find((r) => r.id === 2);
  assert.equal(done.runId, "", "a done row keeps its run in the file, but the fold does not draw it as live");
  assert.deepEqual(done.pr, {
    number: 71,
    state: "OPEN",
    url: "https://git.example.test/projects/IT/repos/beta/pull-requests/71",
  });
});

test("a row with no clock is drawn, sorts last, and is not given an invented time", () => {
  const doc = view();
  const parked = oneAssistant(doc, "init_a", "assistant-2").taskRows.find((r) => r.id === 9);
  assert.equal(parked.at, null);
  assert.equal(parked.state, "parked");
});

// ---- 2. the fold's key and its state chips -----------------------------------------------------------------------
test("the fold's key is the initiative AND the assistant, so two rows under one card fold apart", () => {
  assert.equal(fold.taskFoldKey("init_a", "assistant-1"), "init_a::assistant-1");
  assert.notEqual(fold.taskFoldKey("init_a", "assistant-1"), fold.taskFoldKey("init_a", "assistant-2"));
  assert.notEqual(fold.taskFoldKey("init_a", "assistant-1"), fold.taskFoldKey("init_b", "assistant-1"));
  assert.equal(fold.taskFoldKey(null, undefined), "::", "a missing half is an empty half, never the word undefined");
});

test("a task's state is drawn in the reader's four words and the panel's own tones", () => {
  assert.deepEqual(
    fold.TASK_STATE_INFO.map((s) => [s.id, s.label]),
    [
      ["queued", "queued"],
      ["running", "running"],
      ["parked", "parked"],
      ["done", "done"],
    ],
    "the brief's four states, in the order a task moves through them",
  );
  assert.equal(fold.taskChip("running").cls, "chip init-task-state good", "running keeps the panel's good tone");
  assert.equal(fold.taskChip("parked").cls, "chip init-task-state warn", "parked keeps the panel's warn tone");
  assert.equal(fold.taskChip("queued").cls, "chip init-task-state");
  assert.equal(fold.taskChip("done").cls, "chip init-task-state");
  assert.equal(fold.taskChip("running").label, "running");
  // A state this module does not know is shown as itself rather than dropped or left blank.
  assert.equal(fold.taskChip("exploded").label, "exploded");
  assert.equal(fold.taskChip("").label, "unknown");
  assert.match(fold.taskChip("running").title, /right now/);
});

// ---- 3. one card, two callers -------------------------------------------------------------------------------
// THE CARD THE READER ALREADY KNOWS. The Initiatives tab used to print its own two-line listing under an assistant
// (an id, the whole brief as the row's title, a chip, a thread, a run, a PR). It now draws the QUEUE's card in a
// compact, read-only mode, from the same function the queue pane calls - so these tests hold the shape the brief
// asked for: ONE renderer, a row and a mode, the pane calling it in compact mode, and no second copy of the head.
const cardsSrc = readFileSync(new URL("../public/queue-cards.js", import.meta.url), "utf8");
const escHtml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
// The queue sub-tab's region, evaluated with the five things the page hands it: the escaper, the assistants, the
// session lookup, the thread label and the relative clock. Nothing at the region's top level touches a document.
const card = new Function(
  "esc",
  "assistantIds",
  "sessionById",
  "assistantThreadName",
  "relTime",
  `${sliceRegion(cardsSrc, "the queue sub-tab")}
return { taskCardHtml };`,
)(escHtml, () => ["assistant-1", "assistant-2"], (id) => ({ id }), (t) => t, () => "5m");

const headOf = (html) => {
  const m = /<div class="as-task-head">([\s\S]*?)<\/div>/.exec(html);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
};

test("the queue and the Initiatives tab call ONE function, and the pane keeps no second copy of the card", () => {
  assert.equal((cardsSrc.match(/function taskCardHtml\(/g) || []).length, 1, "one definition of the card");
  assert.equal((pane.match(/function taskCardHtml\(/g) || []).length, 0, "the pane declares no renderer of its own");
  // The head, the marker and the state word are drawn in one place: the pane's own source names no card class.
  assert.equal(cardsSrc.match(/as-task-head/g).length, 1, "the head markup exists exactly once");
  assert.equal(pane.includes('class="as-task-head"'), false, "the pane does not re-draw the head");
  assert.equal(pane.includes("as-task-mark"), false, "nor the marker");
  assert.equal(pane.includes('class="as-task-state'), false, "nor the state word");
  // …and it reaches the card through the mode, with the assistant in the kit.
  assert.match(pane, /made\.innerHTML = taskCardHtml\(row, "compact", \{ own \}\)\.trim\(\);/, "the fold asks for the compact mode");
  assert.match(cardsSrc, /taskCardHtml\(t, "full", \{ own: id, jobs: queueJobs\.byThread, byId/, "the queue pane asks for the full one");
});

test("one row, one head: the compact card is the queue's card with the controls left out", () => {
  // No lane, no hold and no question on this row, so the two heads must be the SAME string: that is what makes the
  // compact card recognisable rather than merely similar.
  const row = {
    id: 474,
    title: "Initiatives: draw the assistant's tasks with the queue's own card, and this title is long enough to be cut",
    state: "queued",
    thread: "wtgui-initiatives-draw-the-assistant-s-tasks-a7dc67",
    at: "2026-11-20T10:00:00.000Z",
    files: ["public/queue-cards.js"],
    worktree: "C:/ProjectDevelopment/agent-worktree-gui/.worktrees/x",
  };
  const full = card.taskCardHtml(row, "full", { own: "assistant-1" });
  const compact = card.taskCardHtml(row, "compact", { own: "assistant-1" });
  // The head is ONE piece of markup. Its one intended divergence is the queued state's hover, which promises a drag
  // on the queue's card and must not on a read-only one, so the identity comparison masks title= and the two sentences
  // are held to their own test just below.
  const withoutTitles = (html) => headOf(html).replace(/title="[^"]*"/g, 'title=""');
  assert.equal(withoutTitles(compact), withoutTitles(full), "the head is one piece of markup, drawn by both modes");
  assert.match(headOf(compact), /class="as-task-state is-queued" title="queued - not started; its queue is where it is started/, "the compact hover points at the queue, not a drag it does not have");
  assert.match(headOf(full), /class="as-task-state is-queued" title="queued — not started; drag the card to change its place/, "the queue's own card keeps the drag promise");
  assert.ok(headOf(compact).includes("as-task-mark is-queued"), "the marker is the queue card's own");
  assert.ok(headOf(compact).includes(">queued</span>"), "and the state is a word, not only a colour");
  assert.ok(headOf(compact).includes("<b class=\"mono\">#474</b>"), "the id the queue shows");
  assert.ok(headOf(compact).includes(`title="${row.title}"`), "the WHOLE title rides in title=, never truncated here");

  // Read-only by construction: every control the full card carries is absent, not disabled.
  for (const control of ['data-as-qact="', "data-as-qmove", "is-draggable", "<details", "<button", "as-task-actions", "data-as-qopen"]) {
    assert.equal(compact.includes(control), false, `a compact card carries no ${control}`);
    assert.equal(full.includes(control), true, `the full card still does: ${control}`);
  }
  // …and it keeps what a reader needs to recognise it: the press its caller puts on it, the agent, the clock.
  assert.ok(compact.includes('data-init-task-card="474"'), "the Initiatives pane's own press target");
  assert.ok(compact.includes('data-init-task-own="assistant-1"'), "carrying the assistant whose queue it opens");
  assert.ok(compact.includes('role="button"') && compact.includes("tabindex=\"0\""), "a real press target, keyboard included");
  assert.ok(compact.includes("as-task-agent-thread"), "the agent that carries it");
  assert.ok(compact.includes(">5m ago</span>"), "and when it last moved");
  assert.ok(compact.includes("as-task is-compact"), "the mode wears its own class, which is the only CSS hook the mode adds");
});

test("an unknown mode is the full card: a typo must not silently drop every control", () => {
  const row = { id: 1, title: "t", state: "queued", files: [] };
  const typo = card.taskCardHtml(row, "compcat", { own: "assistant-1" });
  assert.ok(typo.includes('data-as-qact="running"'), "the controls are still there");
  assert.equal(typo.includes("is-compact"), false, "and it is not half a compact card");
});

test("the compact card says what the row knows and never invents the rest", () => {
  const bare = card.taskCardHtml({ id: 2, title: "no clock, no agent", state: "parked" }, "compact", { own: "assistant-1" });
  assert.ok(bare.includes("no agent yet"), "a row nobody has run says so");
  assert.ok(bare.includes("no time recorded"), "and a row with no clock is not given one");
  const legacy = card.taskCardHtml({ id: 3, title: "old record", state: "running", thread: "T-only" }, "compact", { own: "assistant-1" });
  assert.ok(legacy.includes(">T-only</code>"), "a legacy `thread`-only record still names its agent");
});

test("the fold draws the states being acted on first, then the finished ones", () => {
  const rows = [
    { id: 1, state: "done" },
    { id: 2, state: "parked" },
    { id: 3, state: "running" },
    { id: 4, state: "queued" },
    { id: 5, state: "bogus" },
    { id: 6, state: "running" },
  ];
  assert.deepEqual(fold.taskCardOrder(rows).map((r) => r.id), [3, 6, 4, 2, 5, 1], "running, queued, parked, then done - the caller's order kept inside a bucket");
  assert.deepEqual(fold.taskCardOrder(null), [], "no rows is an empty list, not a throw");
});

test("the fold's window is six cards, and one press adds fifty - never more than is left", () => {
  const rows = Array.from({ length: 169 }, (_, i) => ({ id: i + 1, state: i < 3 ? "running" : "done" }));
  const first = fold.taskCardWindow(rows);
  assert.equal(fold.TASK_CARD_FIRST, 6, "the fold opens at six");
  assert.equal(fold.TASK_CARD_MORE, 50, "and grows by the queue pane's own slice");
  assert.equal(first.visible.length, 6);
  assert.equal(first.hidden, 163);
  assert.equal(first.more, 50);
  assert.equal(first.total, 169);
  assert.deepEqual(first.visible.map((r) => r.id), [1, 2, 3, 4, 5, 6], "the running rows lead");
  assert.equal(fold.taskCardWindow(rows, 6).hidden, 163, "the reader's count is the window");
  const tail = fold.taskCardWindow(rows, 160);
  assert.equal(tail.more, 9, "one press adds what is left, not fifty");
  const all = fold.taskCardWindow(rows, 169);
  assert.equal(all.hidden, 0);
  assert.equal(all.more, 0, "nothing hidden, nothing to offer");
  assert.deepEqual(fold.taskCardWindow([], 6), { visible: [], hidden: 0, more: 0, total: 0 });
});

test("the expand control is a real button with aria-expanded and the tab's own chevron", () => {
  assert.match(pane, /const initTaskOpen = new Set\(\);/, "the open state is module state, not DOM state");
  assert.match(pane, /const key = wtInitiativeFold\.taskFoldKey\(init\.id, a\.id\);/, "keyed per initiative and assistant");
  assert.match(pane, /<button type="button" class="init-proj init-assist-fold" data-init-task-fold="\$\{esc\(key\)\}" aria-expanded="\$\{tasksOpen \? "true" : "false"\}"/);
  assert.match(pane, /<span class="init-caret">\$\{tasksOpen \? "▾" : "▸"\}<\/span>/, "the same caret the other folds draw");
  assert.match(pane, /initTaskOpen\.has\(key\)/, "the painter reads the book back, so the fold survives a re-render");
  assert.match(pane, /if \(el\.dataset\.initTaskFold\) \{/, "the press handler answers it");
  assert.match(
    pane,
    /\[data-init-fold\], \[data-init-assist-fold\], \[data-init-task-fold\], \[data-init-history-fold\], \[data-init-task-card\], \[data-init-tasks-more\]/,
    "and the control selector includes the card's own press and the fold's more",
  );
});

test("a card that has not moved is kept, and one that moved is redrawn from the one renderer", () => {
  assert.match(pane, /const initTaskNodes = new Map\(\);/, "the cards drawn last pass are kept");
  assert.match(pane, /function initTaskSig\(row\)/, "one signature for what a compact card draws");
  assert.match(pane, /return \[row\.state, row\.title, row\.thread, row\.at, row\.runId\]\.join\("\|"\);/, "the five fields it reads");
  assert.match(pane, /let el = kept\.get\(id\) \|\| null;/, "a card already drawn is looked up by task id");
  assert.match(pane, /if \(!el \|\| String\(el\.dataset\.initCardSig \|\| ""\) !== sig\) \{/, "and redrawn only when its row moved");
  assert.match(pane, /box\.appendChild\(el\);/, "appendChild MOVES a node that is already a child");
  assert.match(pane, /paintInitTaskLists\(host\);/, "the painter runs in the same pass that rebuilds the pane");
  assert.match(pane, /kept\.delete\(id\);/, "the residue the rebuild would otherwise leave: a card whose task has gone is removed");
});

test("the fold's own count line says how many of how many, and retires when nothing is hidden", () => {
  assert.match(pane, /const win = wtInitiativeFold\.taskCardWindow\(rows, initTaskShown\.get\(key\)\);/, "the window is the module's, not the painter's");
  assert.match(pane, /if \(win\.hidden > 0\) \{/, "the line exists only while cards are hidden");
  assert.match(pane, /btn\.textContent = `Show \$\{win\.more\} more`;/, "the press names the step");
  assert.match(pane, /left\.textContent = `\$\{win\.visible\.length\} of \$\{win\.total\} shown - \$\{win\.hidden\} not shown`;/, "and the count is honest");
  assert.match(pane, /initTaskShown\.set\(key, \(initTaskShown\.get\(key\) \|\| wtInitiativeFold\.TASK_CARD_FIRST\) \+ wtInitiativeFold\.TASK_CARD_MORE\);/, "one press adds one more slice, kept for the visit");
});

test("a press on a compact card opens that task in its REAL queue, not the agent's console", () => {
  assert.match(pane, /if \(el\.hasAttribute\("data-init-task-card"\)\) \{/, "the Initiatives pane answers the card's press");
  assert.match(pane, /void openTaskRef\(String\(el\.dataset\.initTaskOwn \|\| ""\), String\(el\.dataset\.initTaskCard \|\| ""\)\);/, "the walk the console anchors and the chart chips take");
  assert.match(pane, /host\.addEventListener\("keydown", \(e\) => \{/, "and Enter/Space are the press it advertises");
  // The console's own opener is for the queue's card: a compact card must not open an agent turn instead.
  assert.match(pane, /const taskRow = e\.target\.closest\("\.as-task:not\(\.is-compact\)"\);/, "the console opener skips the compact mode");
});

test("the honest empty line is drawn when an assistant has no rows on this initiative", () => {
  assert.match(pane, /no task is filed on this initiative's worktrees for this assistant right now/);
  assert.match(pane, /no assistant has worked on these worktrees yet/, "and the initiative with none says so at its own level");
});
