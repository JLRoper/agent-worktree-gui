// The Ahead / Behind cell as the page draws it (public/app.js, "ahead / behind cell"): the server's `row.sync` becomes
// ↑N ↓M, the side with work to do lit, a stale count dotted with a `?`, and a page newer than its server draws the old
// numbers labelled for what they count. Read out of the page and run with no browser, like test/branch-cell.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const begin = src.indexOf("// ---- ahead / behind cell");
const end = src.indexOf("// ---- end ahead / behind cell");
assert.ok(begin > 0 && end > begin, "the ahead / behind cell region is in public/app.js");
const code = src.slice(src.indexOf("\n", begin) + 1, end);
const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const { aheadBehindCellHtml, vsMainLine } = new Function("esc", `${code}; return { aheadBehindCellHtml, vsMainLine };`)(esc);

const text = (html) => html.replace(/<[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const title = (html) => /title="([^"]*)"/.exec(html)[1];
const row = (sync, over = {}) => ({ ahead: 2, behind: 2, baseRef: "origin/main", sync, ...over });
const counted = (state, ahead, behind, extra = {}) => ({ state, ahead, behind, ref: "origin/wtgui/foo", stale: false, why: `why-${state}`, ...extra });

test("level draws ↑0 ↓0 dim, with the counts on data attributes for a harness", () => {
  const html = aheadBehindCellHtml(row(counted("level", 0, 0)));
  assert.equal(text(html), "↑0 ↓0");
  assert.match(html, /data-sync="level" data-ahead="0" data-behind="0"/);
  assert.doesNotMatch(html, /class="dirty/);
  assert.doesNotMatch(html, /ab-down/);
  assert.equal((html.match(/class="dimmer"/g) || []).length, 2);
});

test("ahead lights the ↑ with the warm class and leaves ↓ dim; behind lights the ↓ blue and leaves ↑ dim", () => {
  const ahead = aheadBehindCellHtml(row(counted("ahead", 2, 0)));
  assert.equal(text(ahead), "↑2 ↓0");
  assert.match(ahead, /<span class="dirty ab-up">↑2<\/span> <span class="dimmer">↓0<\/span>/);

  const behind = aheadBehindCellHtml(row(counted("behind", 0, 3)));
  assert.equal(text(behind), "↑0 ↓3");
  assert.match(behind, /<span class="dimmer">↑0<\/span> <span class="ab-down">↓3<\/span>/);

  const both = aheadBehindCellHtml(row(counted("diverged", 1, 4)));
  assert.equal(text(both), "↑1 ↓4");
  assert.match(both, /class="dirty ab-up">↑1.*class="ab-down">↓4/);
});

test("the tooltip is the server's sentence, then the count against main", () => {
  const t = title(aheadBehindCellHtml(row(counted("ahead", 2, 0))));
  assert.equal(
    t,
    "why-ahead Against origin/main: 2 commits here that it does not have, 2 on it that this branch does not have (the verdict is built from this).",
  );
});

test("gone, untracked and none are words, not numbers, and carry no counts", () => {
  const gone = aheadBehindCellHtml(row({ state: "gone", ahead: null, behind: null, ref: "origin/x", stale: false, why: "w" }));
  assert.equal(text(gone), "gone");
  assert.match(gone, /data-sync="gone"/);
  assert.doesNotMatch(gone, /data-ahead/);

  const untracked = aheadBehindCellHtml(row({ state: "untracked", ahead: null, behind: null, ref: null, stale: false, why: "w" }));
  assert.equal(text(untracked), "?");

  const none = aheadBehindCellHtml(row({ state: "none", ahead: null, behind: null, ref: null, stale: false, why: "never pushed" }));
  assert.equal(text(none), "—");
  assert.match(none, /data-sync="none"/);
  assert.match(title(none), /^never pushed Against origin\/main/);
});

test("a stale count is dotted and carries a ?; staleness on a word-state draws nothing extra", () => {
  const stale = aheadBehindCellHtml(row(counted("ahead", 1, 0, { stale: true })));
  assert.match(stale, /class="ab ab-stale"/);
  assert.match(stale, /<span class="ab-q" aria-label="stale">\?<\/span>/);
  assert.equal(text(stale), "↑1 ↓0?");

  const fresh = aheadBehindCellHtml(row(counted("ahead", 1, 0)));
  assert.doesNotMatch(fresh, /ab-stale|ab-q/);

  const word = aheadBehindCellHtml(row({ state: "none", ahead: null, behind: null, ref: null, stale: true, why: "w" }));
  assert.doesNotMatch(word, /ab-stale|ab-q/);
});

test("a page newer than its server (no row.sync) draws the old numbers, labelled, with how to get the new ones", () => {
  const html = aheadBehindCellHtml({ ahead: 2, behind: 3, baseRef: "origin/main" });
  assert.equal(text(html), "2 / 3");
  assert.match(html, /data-sync="legacy"/);
  assert.match(title(html), /Against origin\/main: 2 commits here/);
  assert.match(title(html), /server is older than this page.*restart the board/);

  assert.equal(text(aheadBehindCellHtml({ ahead: null, behind: null })), "—");
  assert.equal(text(aheadBehindCellHtml({ ahead: 0, behind: 0, baseRef: "origin/main" })), "0 / 0");
});

test("nothing from the server is trusted as markup", () => {
  const html = aheadBehindCellHtml(row(counted("ahead", 1, 0, { why: 'a "quoted" <script>alert(1)</script> & more' })));
  assert.doesNotMatch(html, /<script>/);
  assert.match(title(html), /&lt;script&gt;/);
  assert.doesNotMatch(html.replace(/title="[^"]*"/, ""), /quoted/);
});

test("vsMainLine: singular and plural, and nothing when there is no base to count against", () => {
  assert.match(vsMainLine({ ahead: 1, behind: 1, baseRef: "origin/main" }), /1 commit here that it does not have, 1 on it/);
  assert.match(vsMainLine({ ahead: 0, behind: 5, baseRef: "origin/dev" }), /Against origin\/dev: 0 commits here that it does not have, 5 on it/);
  assert.equal(vsMainLine({ ahead: null, behind: null, baseRef: "origin/main" }), "");
  assert.equal(vsMainLine({ ahead: 1, behind: 1 }), "");
  assert.equal(vsMainLine(null), "");
});

test("the column header explains the arrows, and the verdict carries the count against main", () => {
  // The header is built from CHART_COLUMNS now (the reader can hide a column), so the explanation lives on the
  // column's own entry and reaches the <th> through chartHeaderHtml() — the test reads the entry, not the markup.
  const cols = src.slice(src.indexOf("const CHART_COLUMNS = ["), src.indexOf("// ---- end chart columns"));
  assert.match(cols, /label: "Ahead \/ Behind"/);
  assert.match(cols, /title:\s*\n?\s*"↑ commits this branch has that its own copy on the remote does not[^"]*"/);
  assert.match(cols, /id: "ahead"/);
  assert.match(src, /ahead: `<td class="mono nowrap">\$\{aheadBehindCellHtml\(row\)\}<\/td>`/);
  // verdictHtml keeps the sentence inline so tools/verify-merge-chip.mjs can read its region on its own.
  const vh = src.slice(src.indexOf("function verdictHtml"), src.indexOf("// ---- end merge control"));
  assert.match(vh, /Against \$\{row\.baseRef\}: \$\{Number\(row\.ahead\) \|\| 0\} ahead, \$\{Number\(row\.behind\) \|\| 0\} behind\./);
  assert.equal((vh.match(/withVs\(/g) || []).length, 3, "the merging, dirty and chooser titles all end with it");
});
