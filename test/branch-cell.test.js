// The branch cell: a link when the remote has that branch, and ONE dim word — `local` — when the remote answered
// that it does not. The word is the whole at-a-glance answer the chart was asked for, so it must never be drawn
// from a weaker state than the claim: `unknown` (the remote could not be reached, or the scan has not read this
// branch yet) is the panel saying it cannot tell, and the row used to wear `local` next to a tooltip that said
// "cannot tell whether the remote has this branch yet".
//
// The function under test is READ OUT of public/app.js between its markers, not copied here (the way
// tools/verify-merge-chip.mjs reads the merge chip): a change to the page's own rule changes these answers, and a
// rule that moves back to guessing from `row.remoteBranch` fails here.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const begin = src.indexOf("// ---- branch cell: the link, and the local chip");
const end = src.indexOf("// ---- end branch cell");
assert.ok(begin >= 0 && end > begin, "public/app.js carries the branch-cell markers this test reads");
const code = src.slice(src.indexOf("\n", begin) + 1, end);

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const { branchCellHtml } = new Function("esc", `${code}; return { branchCellHtml };`)(esc);

// A row as decorate leaves it for a project whose remote is `origin`.
const decorated = (over = {}) => ({
  project: "prooflib",
  path: "C:/repos/prooflib/.worktrees/proof-local-bbbbbb",
  name: "proof-local-bbbbbb",
  branch: "wtgui/proof-local-bbbbbb",
  ...over,
});
const chip = (html) => /class="branch-local"/.test(html);
const tag = (html) => (/^<(\w+)/.exec(html) || [])[1] || null;
const title = (html) => (/title="([^"]*)"/.exec(html) || [])[1] || "";

test("a branch the remote lists is a link to its page and carries no chip", () => {
  const html = branchCellHtml(decorated({ remoteBranch: "exists", branchLocalOnly: false, branchUrl: "https://github.com/JLRoper/proof-repo/tree/wtgui/proof-local-bbbbbb" }));
  assert.equal(tag(html), "a");
  assert.equal(chip(html), false);
  assert.match(html, /href="https:\/\/github\.com\/JLRoper\/proof-repo\/tree\/wtgui\/proof-local-bbbbbb"/);
});

test("a branch the remote answered it does NOT have is plain text with the chip", () => {
  const html = branchCellHtml(
    decorated({ remoteBranch: "gone", branchLocalOnly: true, branchUrl: null, branchWhy: "local only — this branch has no copy on the remote (the remote origin does not list it)" }),
  );
  assert.equal(tag(html), "span");
  assert.equal(chip(html), true);
  assert.match(title(html), /^local only/);
});

test("an UNKNOWN answer is not local — the chip stays off and the title says the panel cannot tell", () => {
  // The remote could not be reached: decorate says so, and `branchLocalOnly` is false because nothing was answered.
  const html = branchCellHtml(
    decorated({ remoteBranch: "unknown", branchLocalOnly: false, branchUrl: null, branchWhy: "cannot tell whether the remote has this branch yet (the remote could not be reached)" }),
  );
  assert.equal(chip(html), false);
  assert.match(title(html), /^cannot tell/);
  assert.doesNotMatch(title(html), /local only/);
});

test("a row the scan has not read yet is not local either, and does not claim it", () => {
  // No decorate fields at all: a row discovery has just added. The old fallback sentence claimed "local only" for
  // exactly this row; it must say it has not been read.
  const html = branchCellHtml({ project: "prooflib", path: "C:/t", name: "t", branch: "wtgui/t-1a2b3c" });
  assert.equal(chip(html), false);
  assert.doesNotMatch(title(html), /local only/);
  assert.match(title(html), /not read yet/);
});

test("a project with no remote says so and marks no row", () => {
  const html = branchCellHtml(decorated({ remoteBranch: "n/a", branchLocalOnly: false, branchUrl: null, branchWhy: "no remote configured" }));
  assert.equal(chip(html), false);
  assert.equal(title(html), "no remote configured");
});

test("a row with no branch to speak of carries no chip even if the flag is set", () => {
  // `branchLocalOnly` is only ever true with a real branch name (decorate guards it), and a row mid-read has none.
  const html = branchCellHtml({ project: "prooflib", path: "C:/t", name: "t", branch: null, remoteBranch: "unknown", branchLocalOnly: false });
  assert.equal(chip(html), false);
  assert.match(html, /—/);
});

test("the chip's word is the ONLY thing gated on the flag: the branch name always reads", () => {
  for (const row of [decorated({ branchLocalOnly: true }), decorated({ branchLocalOnly: false })]) {
    assert.match(branchCellHtml(row), /wtgui\/proof-local-bbbbbb/);
  }
});
