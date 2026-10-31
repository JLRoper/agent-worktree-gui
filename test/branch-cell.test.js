// The branch cell: a link when the remote has that branch, ONE dim word — `local` — when the remote answered that it
// does not, and a second, weaker word — `unverified` — when the panel could not get an answer at all. Each word is
// the whole at-a-glance answer the chart was asked for, so neither may be drawn from a state that does not support it:
// `unknown` (the remote could not be reached, or the scan has not read this branch yet) is the panel saying it cannot
// tell, and the row used to wear `local` next to a tooltip that said "cannot tell whether the remote has this branch
// yet". The opposite mistake is the one this file now also pins: that same row used to wear NOTHING, so an
// unverifiable branch looked exactly like one nobody had ever pushed.
//
// The function under test is READ OUT of public/app.js between its markers, not copied here (the way
// tools/verify-merge-chip.mjs reads the merge chip): a change to the page's own rule changes these answers, and a
// rule that moves back to guessing from `row.remoteBranch` fails here.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { sliceRegion } from "../tools/panel-testkit.mjs";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const code = sliceRegion(src, "branch cell: the link, and the local chip", "branch cell");

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
const unverified = (html) => /class="branch-unverified"/.test(html);
const anyChip = (html) => /class="branch-(local|unverified)"/.test(html);
const word = (html) => (/class="branch-(local|unverified)"[^>]*>([^<]*)</.exec(html) || [])[2] || null;
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

test("an UNKNOWN answer is never `local` — it wears its own word, and the title says the panel cannot tell", () => {
  // The remote could not be reached: decorate says so, and `branchLocalOnly` is false because nothing was answered.
  const html = branchCellHtml(
    decorated({ remoteBranch: "unknown", branchLocalOnly: false, branchChip: "unverified", branchUrl: null, branchWhy: "cannot tell whether the remote has this branch yet (the remote could not be reached)" }),
  );
  assert.equal(chip(html), false, "the `local` word is the remote's own denial, and it did not deny anything");
  assert.equal(unverified(html), true, "a row the panel could not verify says so");
  assert.equal(word(html), "unverified");
  assert.match(title(html), /^cannot tell/);
  assert.doesNotMatch(title(html), /local only/);
});

test("the unverified chip quotes the project's fetch note, so the reason is on the row", () => {
  // The note is `maybeFetch`'s own sentence, verbatim — that is what tells "no credentials" from "wrong host".
  const note = "fetch failed: Permission denied (publickey)";
  const why = `cannot tell whether the remote has this branch yet (the remote could not be reached) — the project's last fetch said: ${note}`;
  const html = branchCellHtml(decorated({ remoteBranch: "unknown", branchChip: "unverified", branchUrl: null, branchWhy: why }));
  // Both titles come from `branchWhy`, so whichever one a reader hovers carries the note.
  const titles = [...html.matchAll(/title="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(titles.length >= 2, "the branch name and the chip each carry the sentence");
  for (const t of titles) assert.match(t, /Permission denied \(publickey\)/);
});

test("a row the last fetch's refs DID resolve to a page carries no chip at all", () => {
  // `unknown` with a link: the link already says the remote itself was not asked, so a second word is noise.
  const html = branchCellHtml(
    decorated({ remoteBranch: "unknown", branchChip: null, branchLocalOnly: false, branchUrl: "https://github.com/JLRoper/proof-repo/tree/wtgui/proof-local-bbbbbb", branchLinkFrom: "local-refs" }),
  );
  assert.equal(tag(html), "a");
  assert.equal(anyChip(html), false);
  assert.match(title(html), /the remote itself was not asked/);
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
  const html = branchCellHtml({ project: "prooflib", path: "C:/t", name: "t", branch: null, remoteBranch: "unknown", branchLocalOnly: true, branchChip: "unverified" });
  assert.equal(anyChip(html), false, "there is no branch for either word to be about");
  assert.match(html, /—/);
});

test("the chip's word is the ONLY thing gated on the flag: the branch name always reads", () => {
  for (const row of [decorated({ branchLocalOnly: true }), decorated({ branchLocalOnly: false })]) {
    assert.match(branchCellHtml(row), /wtgui\/proof-local-bbbbbb/);
  }
});
