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

// ---- 3. the pane's contract, read from its source ----------------------------------------------------------------
test("the expand control is a real button with aria-expanded and the tab's own chevron", () => {
  assert.match(pane, /const initTaskOpen = new Set\(\);/, "the open state is module state, not DOM state");
  assert.match(pane, /const key = wtInitiativeFold\.taskFoldKey\(init\.id, a\.id\);/, "keyed per initiative and assistant");
  assert.match(pane, /<button type="button" class="init-proj init-assist-fold" data-init-task-fold="\$\{esc\(key\)\}" aria-expanded="\$\{tasksOpen \? "true" : "false"\}"/);
  assert.match(pane, /<span class="init-caret">\$\{tasksOpen \? "▾" : "▸"\}<\/span>/, "the same caret the other folds draw");
  assert.match(pane, /initTaskOpen\.has\(key\)/, "the painter reads the book back, so the fold survives a re-render");
  assert.match(pane, /if \(el\.dataset\.initTaskFold\) \{/, "the press handler answers it");
  assert.match(
    pane,
    /\[data-init-fold\], \[data-init-assist-fold\], \[data-init-task-fold\], \[data-init-history-fold\]/,
    "and the control selector includes it",
  );
});

test("a live row is patched in place, never rebuilt from markup", () => {
  assert.match(pane, /const initTaskNodes = new Map\(\);/, "the nodes drawn last pass are kept");
  assert.match(pane, /function patchInitTaskRow\(el, task\)/, "one writer for a row's facts");
  assert.match(pane, /let el = kept\.get\(id\) \|\| null;/, "a row already drawn is looked up by task id");
  assert.match(pane, /if \(el\) patchInitTaskRow\(el, task\);/, "and patched rather than replaced");
  assert.match(pane, /box\.appendChild\(el\);/, "appendChild MOVES a node that is already a child");
  assert.match(pane, /paintInitTaskLists\(host\);/, "the painter runs in the same pass that rebuilds the pane");
  // The residue the rebuild would otherwise leave: a kept row whose task has gone is removed by id.
  assert.match(pane, /kept\.delete\(id\);/);
});

test("the honest empty line is drawn when an assistant has no rows on this initiative", () => {
  assert.match(pane, /no task is filed on this initiative's worktrees for this assistant right now/);
  assert.match(pane, /no assistant has worked on these worktrees yet/, "and the initiative with none says so at its own level");
});

test("the PR cell is rebuilt only when the PR itself changes", () => {
  assert.match(pane, /const key = task\.pr \? `\$\{task\.pr\.number\}\|\$\{task\.pr\.state \|\| ""\}\|\$\{task\.pr\.url \|\| ""\}` : "";/);
  assert.match(pane, /if \(String\(pr\.dataset\.initPr \|\| ""\) !== key\) \{/, "a state flip on the task never replaces its anchor");
  assert.match(pane, /target="_blank" rel="noopener"/, "the PR's page opens in a new tab, the panel's own link pattern");
});
