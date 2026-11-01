// An earlier turn's record, after the tree it names has been renamed.
//
//   node --test test/tree-repoint.test.js
//
// The panel renames a worktree's directory AND its branch after the session title. Every record the panel keeps
// about that tree has to move with it, and the panel's own dogfood run found the half that did not: job 33ac3d6b
// came back from /api/state with `cwd` on the new directory but `tree.path` and `branch` spelling the old path and
// the old ref — both of which git no longer had. The card, the digest the assistant reads and the completion notice
// all quote those fields as where the work is.
//
// Two halves, both with a store of its own and no panel process:
//
//   * `repointPath` — the rename's own move: paths, branch, the measured `tree` and the `completion` payload, and
//     the `renamedFrom` stamp that lets a card say the tree was renamed rather than deleted;
//   * `reconcileTreeRecords` — a record that was ALREADY stale when the panel booted: resolved through the naming
//     ledger when its tag can be placed, and marked with the plain reason when it cannot.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { Jobs } from "../lib/jobs.js";

const scratch = mkdtempSync(path.join(tmpdir(), "wtgui-repoint-"));
after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

// A store with no file, no gateway and no todos: repointPath only reads this.jobs and emits.
function store() {
  const events = [];
  const jobs = new Jobs({ config: {}, onEvent: (evt) => events.push(evt) });
  return { jobs, events };
}

// The shape /api/state carries for one settled turn, including the two records the old repoint left behind.
function turn({ id, tree, branch, older = false }) {
  return {
    id,
    thread: `thread-${id}`,
    turn: 1,
    status: "done",
    prompt: "do the thing",
    cwd: tree,
    worktree: "demo",
    worktreePath: tree,
    ownerPath: tree,
    projectPath: path.join(scratch, "demo"),
    branch,
    baseSha: "f56691ad96a33ee5a0c62610cdad42339bce23f1",
    lines: [],
    artifacts: [],
    attachments: [],
    tree: { path: tree, branch, exists: true, commits: older ? 2 : 0, subjects: [], note: "" },
    completion: { word: "done", branch, worktree: tree, treeExists: true, commits: { count: older ? 2 : 0, base: "01234567", subjects: [] } },
  };
}

test("a rename takes every recorded reference with it — the paths, the branch, the tree and the completion", () => {
  const { jobs, events } = store();
  const oldPath = path.join(scratch, "demo", ".worktrees", "work-only-inside-c-users-9791a7");
  const newDir = `commit-notes-txt-and-open-pr-9791a7`;
  const newPath = path.join(scratch, "demo", ".worktrees", newDir);
  // The directory the rename would land on, made here because repointPath reads its `treeExists` from disk.
  mkdirSync(path.dirname(newPath), { recursive: true });
  mkdirSync(newPath, { recursive: true });
  const oldBranch = "wtgui/work-only-inside-c-users-9791a7";
  const newBranch = `wtgui/${newDir}`;

  jobs.jobs.set("33ac3d6b", turn({ id: "33ac3d6b", tree: oldPath, branch: oldBranch }));
  // A second turn in the same tree, and one in another tree that must not be touched.
  jobs.jobs.set("aaaa1111", turn({ id: "aaaa1111", tree: oldPath, branch: oldBranch }));
  jobs.jobs.set("bbbb2222", turn({ id: "bbbb2222", tree: path.join(scratch, "demo", ".worktrees", "other-111111"), branch: "wtgui/other-111111" }));
  const untouched = JSON.stringify(jobs.jobs.get("bbbb2222"));

  const moved = jobs.repointPath(oldPath, newPath, { branch: newBranch, oldBranch });
  assert.equal(moved, 2, "both turns in the renamed tree were repointed, and nothing else");

  for (const id of ["33ac3d6b", "aaaa1111"]) {
    const j = jobs.jobs.get(id);
    assert.equal(j.cwd, newPath.replace(/\\/g, "/"), `${id}: cwd follows the move`);
    assert.equal(j.worktreePath, newPath.replace(/\\/g, "/"), `${id}: worktreePath follows the move`);
    assert.equal(j.ownerPath, newPath.replace(/\\/g, "/"), `${id}: ownerPath follows the move`);
    assert.equal(j.branch, newBranch, `${id}: branch follows the rename — this is the field the dogfood run found dead`);
    assert.equal(j.tree.path, newPath.replace(/\\/g, "/"), `${id}: the measured tree's path follows`);
    assert.equal(j.tree.branch, newBranch, `${id}: and so does its branch`);
    assert.equal(j.tree.renamedFrom, oldPath.replace(/\\/g, "/"), `${id}: the record says where it came from`);
    assert.equal(j.completion.worktree, newPath.replace(/\\/g, "/"), `${id}: the completion payload's worktree follows`);
    assert.equal(j.completion.branch, newBranch, `${id}: and its branch`);
    assert.equal(j.completion.renamedFrom, oldPath.replace(/\\/g, "/"));
    assert.equal(j.completion.treeExists, true, `${id}: the tree exists at its new name, so the notice must not say "gone"`);
  }
  assert.equal(JSON.stringify(jobs.jobs.get("bbbb2222")), untouched, "a turn in another tree is not rewritten");
  assert.equal(events.filter((e) => e.type === "job").length, 2, "each repointed turn is announced once");
});

test("a branch rename with the directory held open still moves the branch on every record", () => {
  const { jobs } = store();
  const tree = path.join(scratch, "demo", ".worktrees", "held-open-abcdef");
  const oldBranch = "wtgui/held-open-abcdef";
  jobs.jobs.set("cccc3333", turn({ id: "cccc3333", tree, branch: oldBranch }));

  // `git worktree move` refused (a shell is standing in the directory) but `git branch -m` landed: the path is
  // the same and only the name moved. The records have to follow the half that DID land.
  const moved = jobs.repointPath(tree, tree, { branch: "wtgui/a-better-name-abcdef", oldBranch });
  assert.equal(moved, 1);
  const j = jobs.jobs.get("cccc3333");
  assert.equal(j.branch, "wtgui/a-better-name-abcdef");
  assert.equal(j.tree.branch, "wtgui/a-better-name-abcdef");
  assert.equal(j.completion.branch, "wtgui/a-better-name-abcdef");
  assert.equal(j.tree.renamedFrom, undefined, "nothing moved by path, so no renamed-from is claimed");
});

test("a stale record is resolved through the naming ledger by the tag a rename keeps", () => {
  const { jobs } = store();
  const oldPath = path.join(scratch, "demo", ".worktrees", "old-name-445566");
  const current = path.join(scratch, "demo", ".worktrees", "the-work-it-did-445566");
  mkdirSync(current, { recursive: true });
  jobs.jobs.set("dddd4444", turn({ id: "dddd4444", tree: oldPath, branch: "wtgui/old-name-445566" }));

  // What server.js's resolver does with the ledger: the six-hex tag is the key, and `dir`/`name` is where the tree
  // is now. The turn never saw the rename — its record was written before it and this process booted after it.
  const out = jobs.reconcileTreeRecords({
    resolve: ({ path: gone, branch }) => {
      assert.equal(gone, oldPath.replace(/\\/g, "/"));
      assert.equal(branch, "wtgui/old-name-445566");
      return { path: current.replace(/\\/g, "/"), branch: "wtgui/the-work-it-did-445566" };
    },
  });
  assert.deepEqual(out, { moved: 1, unresolved: 0 });
  const j = jobs.jobs.get("dddd4444");
  assert.equal(j.tree.path, current.replace(/\\/g, "/"));
  assert.equal(j.branch, "wtgui/the-work-it-did-445566", "the branch is resolved with the path");
  assert.equal(j.completion.worktree, current.replace(/\\/g, "/"));
  assert.equal(j.treeStale, undefined, "a resolved record is not marked stale");
});

test("a record nothing can place SAYS the tree was renamed instead of quoting a dead path", () => {
  const { jobs, events } = store();
  const gone = path.join(scratch, "demo", ".worktrees", "gone-778899");
  jobs.jobs.set("eeee5555", turn({ id: "eeee5555", tree: gone, branch: "wtgui/gone-778899" }));

  const out = jobs.reconcileTreeRecords({ resolve: () => null });
  assert.deepEqual(out, { moved: 0, unresolved: 1 });
  const j = jobs.jobs.get("eeee5555");
  assert.equal(j.tree.pathGone, true);
  assert.match(j.tree.note, /no longer exists/);
  assert.match(j.tree.note, /renamed or removed/, "it says what is actually known, not a guess");
  assert.match(j.completion.treeNote, /renamed or removed/);
  assert.equal(j.treeStale.path, gone.replace(/\\/g, "/"), "and the dead path is recorded as the one it was written with");
  assert.equal(events.filter((e) => e.type === "job").length, 1, "the card is repainted with the new fact");
});

test("a record whose tree is still where it says is left completely alone", () => {
  const { jobs, events } = store();
  const here = path.join(scratch, "demo", ".worktrees", "still-here-99aabb");
  mkdirSync(here, { recursive: true });
  jobs.jobs.set("ffff6666", turn({ id: "ffff6666", tree: here, branch: "wtgui/still-here-99aabb" }));
  const before = JSON.stringify(jobs.jobs.get("ffff6666"));

  const out = jobs.reconcileTreeRecords({ resolve: () => ({ path: "/somewhere/else" }) });
  assert.deepEqual(out, { moved: 0, unresolved: 0 }, "a live path is never second-guessed");
  assert.equal(JSON.stringify(jobs.jobs.get("ffff6666")), before);
  assert.equal(events.length, 0);
});
