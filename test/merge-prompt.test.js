// The merging agent's script, asserted where the two rules that shape main's history live in it.
//
// Both are about what a landing leaves behind, not about how a conflict is resolved:
//   - a one-commit branch fast-forwards (or rebases and fast-forwards). A merge commit around one commit says nothing
//     the commit did not, and the old text offered that route whenever `git log --merges -5` was non-empty - which the
//     merges this panel's own landings had just made always were, so the exception fed itself.
//   - a harness and its report travel inside the change's commit, not as a stacked "add harness" commit.
import assert from "node:assert/strict";
import test from "node:test";
import { mergePrompt } from "../lib/merge-prompt.js";

const base = {
  project: "agent-worktree-gui",
  worktree: "C:/repo/.worktrees/lane",
  root: "C:/repo",
  branch: "wtgui/lane",
  base: "main",
  remote: "origin",
  baseRef: "origin/main",
};

test("a one-commit branch is told to rebase and fast-forward, and has no merge-commit route", () => {
  const prompt = mergePrompt({ ...base, ahead: 1, commits: ["1111111 the change"] });
  assert.match(prompt, /Fast-forward first/);
  assert.match(prompt, /this branch carries ONE commit, so there is no merge-commit route here/);
  assert.match(prompt, /the rebase in \(a\) is the whole\s+answer/);
  assert.doesNotMatch(prompt, /--no-edit/, "the merge-commit command is not in front of the agent for one commit");
  assert.doesNotMatch(prompt, /more than one commit/);
});

test("a multi-commit branch may take the merge route, but only when the repo keeps merge commits", () => {
  const prompt = mergePrompt({ ...base, ahead: 3, commits: ["1111111 one", "2222222 two", "3333333 three"] });
  assert.match(prompt, /only if this repo keeps merge commits/);
  assert.match(prompt, /git log --merges -5/);
  assert.match(prompt, /merges this\s+panel's own landings made are not a policy/);
  assert.match(prompt, /git merge --no-edit wtgui\/lane/);
  assert.doesNotMatch(prompt, /carries ONE commit/);
});

test("the harness travels in the change's own commit", () => {
  const prompt = mergePrompt({ ...base, ahead: 1 });
  assert.match(prompt, /PHASE 1C - what belongs in a commit on this branch/);
  assert.match(prompt, /A verification harness, its screenshots and its report are part of the change they measure/);
  assert.match(prompt, /not a separate "add harness" or "add report" commit stacked on top/);
});

test("an unknown count keeps the exception conditional instead of claiming one shape", () => {
  const prompt = mergePrompt({ ...base });
  assert.match(prompt, /only if this repo keeps merge commits/);
  assert.match(prompt, /more than one commit/);
  assert.doesNotMatch(prompt, /carries ONE commit/, "nothing was counted, so nothing is claimed about the count");
});
