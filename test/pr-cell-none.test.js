// The PR cell's `none`: one word, and no second half explaining a branch the column beside it already explains.
//
// A row whose branch the remote no longer has used to read `none · branch gone` in the PR cell. That state is already
// the BRANCH cell's answer — one column left, the name is plain text instead of the blue link, with the `local` chip
// and the reason in its tooltip — so the PR cell repeated a word the reader had just read and asked the measured
// column to be wide enough to hold it. This file pins the one word for every `remoteBranch` state, so `none` cannot
// drift back into a sentence, and keeps the PR-bearing half of the cell (number, state, page) in the same place.
//
// The function under test is READ OUT of public/app.js between its markers, not copied here: a change to the page's
// own rule changes these answers.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { sliceRegion } from "../tools/panel-testkit.mjs";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const code = sliceRegion(src, "pr cell", "pr cell");

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const prMatchNote = () => "";
const { prCellHtml } = new Function("esc", "prMatchNote", `${code}; return { prCellHtml };`)(esc, prMatchNote);

// A row as decorate leaves it for a project whose remote is `origin`, before any PR is looked for.
const row = (over = {}) => ({
  project: "prooflib",
  path: "C:/repos/prooflib/.worktrees/proof-local-bbbbbb",
  name: "proof-local-bbbbbb",
  branch: "wtgui/proof-local-bbbbbb",
  branchUrl: null,
  ...over,
});
const text = (html) => html.replace(/<[^>]*>/g, "");

test("no PR reads the one word `none`, whatever the remote says about the branch", () => {
  // `gone` is the row this file exists for: the branch's copy was deleted on the remote, which the branch cell says
  // with plain text and its `local` chip. Every other state is here so the answer cannot become conditional again.
  for (const remoteBranch of ["gone", "exists", "unknown", "n/a", undefined]) {
    const html = prCellHtml(row({ remoteBranch }));
    assert.equal(text(html), "none", `remoteBranch=${remoteBranch} is one word`);
    assert.doesNotMatch(html, /branch gone/, `remoteBranch=${remoteBranch} does not explain the branch column`);
  }
});

test("the word is dim, is not a link, and guesses at no page", () => {
  const html = prCellHtml(row({ remoteBranch: "gone", prUrl: "https://example.invalid/pull/1" }));
  assert.match(html, /class="dimmer">none</);
  assert.doesNotMatch(html, /<a\b/, "a missing PR has no page to open");
});

test("a PR keeps its number, its state and its page", () => {
  const open = prCellHtml(
    row({ pr: { number: 18, state: "OPEN", title: "A title" }, prUrl: "https://github.com/JLRoper/proof-repo/pull/18" }),
  );
  assert.equal(text(open), "#18 OPEN");
  assert.match(open, /class="pr-link pr-open"/);
  assert.match(open, /href="https:\/\/github\.com\/JLRoper\/proof-repo\/pull\/18"/);

  const merged = prCellHtml(row({ pr: { number: 7, state: "MERGED" }, prUrl: "https://github.com/JLRoper/proof-repo/pull/7" }));
  assert.equal(text(merged), "#7 MERGED");
  assert.match(merged, /class="pr-link pr-merged"/);

  // No page to build: the same words, plain, with the reason in the title — never a guessed href.
  const plain = prCellHtml(row({ pr: { number: 7, state: "MERGED" }, prUrl: null, prWhy: "no host mapping for prooflib" }));
  assert.equal(text(plain), "#7 MERGED");
  assert.doesNotMatch(plain, /<a\b/);
  assert.match(plain, /no host mapping for prooflib/);
});
