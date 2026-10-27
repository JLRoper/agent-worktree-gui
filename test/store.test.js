// A row is "safe to remove" when its WORK is accounted for, not when the word MERGED happens to be in its
// verdict. This repo lands by rebase and squash, so a landed branch can read UNMERGED forever (its patch-id
// no longer matches), and a branch that never committed anything reads NO COMMITS. Both are rows the reader
// is meant to clear. Keying the flag on MERGED alone left every zero-commit tree out of the count, which is
// how merged work kept sitting on the board with nothing marking it as removable.
import assert from "node:assert/strict";
import test from "node:test";
import { Store } from "../lib/store.js";

const PROJECT = "proj";
const MAIN = "main";

function row(fields) {
  const s = new Store();
  s.ensureProject({ name: PROJECT, mainBranch: MAIN });
  s.putRow(PROJECT, { path: "C:/tmp/wt", dirty: 0, untracked: 0, ...fields }, "full");
  return s.rowsFor(PROJECT)[0];
}

test("MERGED with a clean tree is safe to remove", () => {
  for (const verdict of ["MERGED", "MERGED (3 commits)", "MERGED (squash/rebase, 2 commits)", "MERGED (content identical)"]) {
    assert.equal(row({ branch: "wtgui/a", verdict }).mergeable, true, verdict);
  }
});

test("NO COMMITS with a clean tree is safe to remove: there is nothing on the branch to lose", () => {
  assert.equal(row({ branch: "wtgui/b", verdict: "NO COMMITS" }).mergeable, true);
});

test("NO COMMITS? is not: an unread reflog means nothing is known", () => {
  assert.equal(row({ branch: "wtgui/c", verdict: "NO COMMITS?" }).mergeable, false);
});

test("UNMERGED is not safe to remove, whatever its commit count", () => {
  for (const verdict of ["UNMERGED (1 commit)", "UNMERGED (7 commits)", "UNMERGED (?)"]) {
    assert.equal(row({ branch: "wtgui/d", verdict }).mergeable, false, verdict);
  }
});

test("ON MAIN and EMPTY REPO are never offered: removing the main checkout is not a cleanup", () => {
  assert.equal(row({ branch: MAIN, verdict: "ON MAIN", ahead: 0 }).mergeable, false);
  assert.equal(row({ branch: "wtgui/e", verdict: "EMPTY REPO" }).mergeable, false);
});

test("a stale or unknown verdict is not safe to remove", () => {
  for (const verdict of ["\u2026", "ERROR"]) {
    assert.equal(row({ branch: "wtgui/f", verdict }).mergeable, false, verdict);
  }
});

test("uncommitted work disqualifies a merged row: the tree is the only copy", () => {
  assert.equal(row({ branch: "wtgui/g", verdict: "MERGED (2 commits)", dirty: 1 }).mergeable, false);
  assert.equal(row({ branch: "wtgui/g", verdict: "MERGED (2 commits)", untracked: 3 }).mergeable, false);
  assert.equal(row({ branch: "wtgui/g", verdict: "NO COMMITS", dirty: 1 }).mergeable, false);
});

test("a live run disqualifies a merged row: a worker mid-turn may not have written its first file yet", () => {
  assert.equal(row({ branch: "wtgui/h", verdict: "MERGED (1 commit)", live: true }).mergeable, false);
  assert.equal(row({ branch: "wtgui/h", verdict: "NO COMMITS", live: true }).mergeable, false);
});

test("the project summary counts every removable row, not just the merged ones", () => {
  const s = new Store();
  s.ensureProject({ name: PROJECT, mainBranch: MAIN });
  const put = (path, fields) => s.putRow(PROJECT, { path, dirty: 0, untracked: 0, ...fields }, "full");
  put("C:/tmp/1", { branch: "wtgui/1", verdict: "MERGED (2 commits)" });
  put("C:/tmp/2", { branch: "wtgui/2", verdict: "NO COMMITS" });
  put("C:/tmp/3", { branch: "wtgui/3", verdict: "UNMERGED (1 commit)" });
  put("C:/tmp/4", { branch: MAIN, verdict: "ON MAIN", ahead: 0 });
  assert.equal(s.summaryFor(PROJECT).removable, 2);
  assert.equal(s.summaryFor(PROJECT).total, 4);
});
