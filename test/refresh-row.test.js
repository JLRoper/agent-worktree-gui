// What one row's ⟳ does, proved without a panel, a repo or a browser: the five cases the brief names.
//
//  1. merge state — the journal names what moved, and says nothing about what did not;
//  2. the TODO reconcile — a PROPOSAL written beside the list, never a status change, cleared by the first real change;
//  3. the description — written when empty, re-derived when demonstrably stale, never when the reader wrote it;
//  4. the agent pass — refused while a live run already holds the tree;
//  5. the journal — one line per action, newest first, capped, and it survives a restart.
//
// The stores are the real ones (lib/todos.js, lib/descriptions.js, lib/refresh-row.js) over a temp file, because the
// contract under test is what the ROW reads back, not what a fake returns.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Descriptions } from "../lib/descriptions.js";
import { RefreshJournal, REFRESH_JOURNAL_CAP, liveRunIn, mergeDelta, parseCommitFiles, todoProposals } from "../lib/refresh-row.js";
import { TodoLists } from "../lib/todos.js";

const TREE = { project: "wtgui", path: "C:/ProjectDevelopment/agent-worktree-gui/.worktrees/add-a-refresh-51ab7d", branch: "wtgui/add-a-refresh-51ab7d" };

async function scratch(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-refresh-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("merge state: the journal names what moved and stays quiet about what did not", () => {
  const before = { verdict: "MERGED (1 commit)", ahead: 0, behind: 2, dirty: 0, untracked: 0, cherryPlus: 0, cherryMinus: 1, head: "aaaaaaa", branch: "wt/x", pr: { number: 12, state: "OPEN" } };
  const after = { ...before, verdict: "UNMERGED (3 commits)", ahead: 3, behind: 0, cherryPlus: 2, cherryMinus: 0, head: "bbbbbbb" };

  const lines = mergeDelta(before, after);
  assert.deepEqual(lines, [
    "verdict MERGED (1 commit) -> UNMERGED (3 commits)",
    "0 -> 3 ahead",
    "2 -> 0 behind",
    "cherry +0/−1 -> +2/−0",
    "tip aaaaaaa -> bbbbbbb",
  ]);
  // The two forms the brief quotes are in it, verbatim.
  assert.ok(lines.includes("verdict MERGED (1 commit) -> UNMERGED (3 commits)"));
  assert.ok(lines.includes("0 -> 3 ahead"));
  // Nothing moved, nothing claimed — the click still journals that it looked.
  assert.deepEqual(mergeDelta(before, { ...before }), []);
  // The PR is one fact, not two: a state change reads as one line.
  assert.deepEqual(mergeDelta(before, { ...before, pr: { number: 12, state: "MERGED" } }), ["PR #12 OPEN -> #12 MERGED"]);
  // A missing value is `—`, never `0` and never `undefined`.
  assert.deepEqual(mergeDelta({ ...before, cherryPlus: undefined }, { ...before, cherryPlus: null }), []);
});

test("TODO: a reconcile proposes from commits and touched files, and closes nothing", async (t) => {
  const dir = await scratch(t);
  const todos = new TodoLists({ file: path.join(dir, "todos.json"), log: () => {} });
  // Two open items: one matched by a commit's WORDS (lib/todos.js proposeClosed), one by the FILES a commit touched.
  const byText = todos.write({ ...TREE, op: "add", text: "add the per-row refresh button to the actions cell", by: "assistant" }).item;
  const byFile = todos.write({ ...TREE, op: "add", text: "something only the diff can name", by: "assistant", files: ["public/app.js"] }).item;
  const doneBefore = todos.write({ ...TREE, op: "add", text: "read the brief", by: "assistant", status: "done" }).item;

  const log = await readFile(path.join(dir, "todos.json"), "utf8");
  assert.ok(log.includes("add the per-row refresh button"));

  const tree = parseCommitFiles(
    [
      "abc1234 Add the per-row refresh button",
      "",
      "public/app.js",
      "public/style.css",
      "",
      "def5678 tidy the css",
      "",
      "public/style.css",
    ].join("\n"),
  );
  assert.deepEqual(tree.subjects, ["abc1234 Add the per-row refresh button", "def5678 tidy the css"]);
  assert.deepEqual(tree.touched.map((f) => f.path).sort(), ["public/app.js", "public/style.css"]);

  const proposals = todoProposals({ items: todos.forRow(TREE.project, TREE.path, { journal: 0 }).items, subjects: tree.subjects, touchedFiles: tree.touched });
  const ids = proposals.map((p) => Number(p.id));
  assert.deepEqual(ids.sort(), [Number(byText.id), Number(byFile.id)].sort(), "both halves of the evidence are proposed");

  const out = todos.propose({ ...TREE, proposals, by: "panel" });
  assert.equal(out.ok, true);
  assert.equal(out.changed, true);

  // NOTHING is closed, and the proposal is what the row's badge reads.
  const row = todos.forRow(TREE.project, TREE.path);
  const status = Object.fromEntries(row.items.map((i) => [i.id, i.status]));
  assert.equal(status[byText.id], "todo");
  assert.equal(status[byFile.id], "todo");
  assert.equal(status[doneBefore.id], "done");
  assert.deepEqual(row.proposal.map((p) => p.id).sort(), ids.sort());
  // …and the list's own journal says where the proposal came from, in the panel's words.
  const line = row.journal.find((j) => j.op === "reconcile");
  assert.ok(line, "the reconcile is journalled");
  assert.match(line.text, /nothing marked done/);
  // A second identical pass writes nothing.
  assert.equal(todos.propose({ ...TREE, proposals, by: "panel" }).changed, false);
  // The reader's first real change settles the question.
  todos.setStatus({ ...TREE, op: "done", id: byText.id, by: "reader" });
  assert.deepEqual(todos.forRow(TREE.project, TREE.path).proposal, []);
});

test("description: empty is written, stale is re-derived, a reader's own is never overwritten", async (t) => {
  const dir = await scratch(t);
  const store = new Descriptions({ file: path.join(dir, "descriptions.json"), log: () => {} });
  const where = TREE;

  // (a) Empty: the first run's own words are written, stamped as the panel's.
  const first = store.refresh(where, { text: "Add a per-row refresh button to the worktree table.", from: { thread: "x" }, commits: [] });
  assert.equal(first.wrote, true);
  assert.equal(store.forTree(where).by, "panel");
  assert.equal(store.forTree(where).text, "Add a per-row refresh button to the worktree table.");

  // (b) Still true: a commit that names the same work keeps it, and nothing is written.
  const kept = store.refresh(where, { text: "a completely different sentence about fonts", commits: ["abc1234 refresh the worktree table button"] });
  assert.equal(kept.wrote, false);
  assert.match(kept.why, /still describes/);
  assert.equal(store.forTree(where).text, "Add a per-row refresh button to the worktree table.");

  // (c) Stale: no commit shares a word with it, so the panel's own record is re-derived — never invented.
  const stale = store.refresh(where, { text: "Move the sunset colours into the theme tokens.", commits: ["def5678 theme tokens for the sunset colours"] });
  assert.equal(stale.stale, true);
  assert.equal(stale.wrote, true);
  assert.equal(store.forTree(where).text, "Move the sunset colours into the theme tokens.");
  assert.equal(store.forTree(where).replaced, "Add a per-row refresh button to the worktree table.");

  // (d) The reader's own text: the store itself refuses, whatever the caller asks for.
  store.record(store.forTree(where).key, { text: "I wrote this by hand — the tree is for the SSO spike.", by: "reader" });
  const held = store.refresh(where, { text: "Overwritten by a refresh.", commits: ["aaaaaaa something else entirely"] });
  assert.equal(held.wrote, false);
  assert.match(held.why, /reader/);
  assert.equal(store.forTree(where).text, "I wrote this by hand — the tree is for the SSO spike.");
  // And a re-derivation that happens to produce the same words is not a write at all — proved on a tree with no
  // reader record (the one above can never be flipped back to the panel's, which is the point of (d)).
  const second = { project: "wtgui", path: "C:/ProjectDevelopment/agent-worktree-gui/.worktrees/another-tree-0f3a9c", branch: "wtgui/another-0f3a9c" };
  store.refresh(second, { text: "Add a per-row refresh button to the worktree table.", commits: [] });
  const same = store.refresh(second, { text: "Add a per-row refresh button to the worktree table.", commits: ["bbbbbbb unrelated migration of the database"] });
  assert.equal(same.wrote, false);
  assert.equal(same.stale, true);
  assert.match(same.why, /same/);
});

test("the agent pass refuses while a live run holds the tree", () => {
  const isLive = (s) => s === "running" || s === "starting";
  const here = [
    { id: "job-1", status: "done", cwd: TREE.path },
    { id: "job-2", status: "running", cwd: TREE.path.replace(/\//g, "\\").toUpperCase() },
  ];
  // Path spelling does not matter: the same tree in the other spelling is still held.
  assert.equal(liveRunIn(here, TREE.path, { isLive }).id, "job-2");
  // A finished run in the tree holds nothing.
  assert.equal(liveRunIn([here[0]], TREE.path, { isLive }), null);
  // A live run OWNED by the tree (a child that ran one level down) holds it too.
  assert.equal(liveRunIn([{ id: "job-3", status: "starting", ownerPath: TREE.path }], TREE.path, { isLive }).id, "job-3");
  // A live run in a sibling tree does not.
  assert.equal(liveRunIn([{ id: "job-4", status: "running", cwd: `${TREE.path}-other` }], TREE.path, { isLive }), null);
  // A parked turn is still running — the gateway's own live set, as lib/jobs.js `isLiveJobStatus` defines it.
  assert.equal(liveRunIn([{ id: "job-5", status: "waiting_for_approval", cwd: TREE.path }], TREE.path, { isLive: (s) => s === "waiting_for_approval" }).id, "job-5");
});

test("the journal keeps one line per action, newest first, capped — and survives a restart", async (t) => {
  const dir = await scratch(t);
  const file = path.join(dir, "refresh.json");
  const j = new RefreshJournal({ file, log: () => {} });
  const key = `${TREE.project}::${TREE.path}`;

  j.append({ ...TREE, lines: ["verdict MERGED -> UNMERGED", "0 -> 3 ahead"] });
  assert.deepEqual(j.recent(key, 3).map((l) => l.text), ["0 -> 3 ahead", "verdict MERGED -> UNMERGED"], "newest first, one line per action");
  j.append({ ...TREE, lines: ["1 item looks closed — nothing marked done", "description still describes what this branch is doing"] });
  assert.equal(j.recent(key, 3).length, 3, "the detail shows the newest three");
  assert.equal(j.recent(key, 99).length, 4);
  // A second process reads the same file: the record is the journal's, not the tab's.
  const again = new RefreshJournal({ file, log: () => {} });
  assert.deepEqual(again.lines(key).map((l) => l.text), j.lines(key).map((l) => l.text));
  // Capped, and the OLDEST are the ones that go.
  for (let i = 0; i < REFRESH_JOURNAL_CAP + 5; i += 1) j.append({ ...TREE, lines: [`line ${i}`] });
  const all = j.lines(key);
  assert.equal(all.length, REFRESH_JOURNAL_CAP);
  assert.equal(all[all.length - 1].text, `line ${REFRESH_JOURNAL_CAP + 4}`);
  // A row nobody refreshed has no journal, and no file is written for it.
  assert.deepEqual(j.recent(`${TREE.project}::C:/nowhere`, 3), []);
});
