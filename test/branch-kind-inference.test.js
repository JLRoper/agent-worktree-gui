// WHICH KIND A BRIEF NAMES: the inference `planCut` falls back to, driven over real brief texts.
//
// The rule is lib/branch-kind.js `inferKindFromBrief`: a brief that NAMES CODE is implementation, anything else is
// research. "Names code" is the reader's own list - one of the verbs implement, fix, add, change, refactor, patch,
// rename, upgrade, wire, build, test; a file path with a known extension; or a commit. It is deliberately not a
// semantic reading of the sentence: a brief that says "research the code" is research, because the verb is research
// and nothing in it names a thing to change.
//
// The texts below are the shapes this board's briefs actually take: a LANDING block that orders a build, a commit
// subject from this repository's own log, a queue row that asks a question, an investigation that names a report, and
// the near-misses ("addendum", "testament", a person called Chang) that a loose stem match would get wrong.
import assert from "node:assert/strict";
import test from "node:test";

import { inferKindFromBrief } from "../lib/branch-kind.js";

const IMPLEMENTATION = [
  // This worktree's own opening line, verb and all.
  "LANDING: this worktree is on wtgui/build-the-three-tree-kinds-and-the-f44376. Build the three tree kinds and the policy layer the reader designed on 2026-11-26.",
  // Commit subjects from this repository's log.
  "fix(permissions): a run's own approval reaches the permission history",
  "fix(roles): the manager drives every agent to its landing, not always a PR",
  // The verbs the reader named, one per case.
  "Implement the turnover policy in the project settings.",
  "Add a test for the push gate.",
  "Change the kind chip so it draws all three letters.",
  "Refactor the permission history into one store and change the route.",
  "Patch lib/remote-writes.js so a kind ask parks the card.",
  "Rename the tab to Waves and wire the new route.",
  "Upgrade the Node floor to 22 and rebuild the container.",
  "Wire the new turnover route into the mount table.",
  "Build the panel's own report page.",
  "Test the push gate against a local-only tree.",
  // A file path with an extension, with and without a directory.
  "lib/push-permissions.js needs the new local-only list.",
  "The behaviour lives in lib/branch-policy.js and README.md is out of date.",
  // A commit, by the word and by a sha written beside it.
  "The commit 4e8c371e is missing from main - cherry-pick it.",
  "Please commit the draft as it stands and report the sha.",
];

const RESEARCH = [
  // Queue rows that ask a question.
  "Read your queue row 292 first - it carries the report the reader wants.",
  "Research how the push guard decides a branch, and write up what you find.",
  "Investigate why the permission button stays at zero while a request is parked, and report the cause.",
  "What is the difference between a turnover child and a research tree? Answer in the chat.",
  // Near-misses a loose stem match would misread as code words.
  "Write an addendum to the README about the release.",
  "The testament of the old guard, in prose.",
  "Ask Chang what the board says about the release.",
  // A brief that says "code" but names nothing to change.
  "Answer a question about the code.",
  // Nothing at all is the quiet answer.
  "",
  "   ",
];

test("a brief that names code is an implementation tree", () => {
  for (const text of IMPLEMENTATION) {
    assert.equal(inferKindFromBrief(text), "implementation", `expected implementation for: ${text.slice(0, 80)}`);
  }
});

test("a brief that names nothing to change is a research tree", () => {
  for (const text of RESEARCH) {
    assert.equal(inferKindFromBrief(text), "research", `expected research for: ${text.slice(0, 80)}`);
  }
});

test("the inference is pure and total: every string answers one of the three kinds", () => {
  for (const value of [undefined, null, 0, {}, [], "x"]) {
    const kind = inferKindFromBrief(value);
    assert.ok(kind === "research" || kind === "implementation", `${JSON.stringify(value)} answers a kind`);
  }
  // A huge brief is read by the same rule, not by its length.
  assert.equal(inferKindFromBrief(`${"prose ".repeat(400)}fix the bug`), "implementation");
});
