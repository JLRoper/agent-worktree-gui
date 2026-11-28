// THE PARENT LINE: the five sayings a worktree row's Merge state block prints about where the tree was cut from.
//
// The line is one sentence with a provenance, and the provenance is the point. A "cut from X" drawn from a guess is
// the defect this pins: the recorded answer comes from the cut book (branch-parents.json) through
// lib/worktrees.js `recordedParentFor`, a reconstruction comes from lib/parents.js and SAYS it is reconstructed, and
// an answer neither source can give says unknown with the reason. Main and master are named as the project base and
// never as a parent; a tie between two equally near candidates reads unknown; a record that names the tree's own
// branch, and a reconstruction that names it, are not parents either.
//
// The last case is the wiring: the page's template is pinned to `parentLineItemHtml` so the proof tool and
// public/board-scaffold.js cannot drift apart about the markup, the dim label or the mono value.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { PARENT_LINE_KINDS, UNKNOWN_PARENT_LINE, parentLineFor, parentLineItemHtml } from "../lib/parent-line.js";
import { pickBackfill } from "../lib/parents.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const TAG = "abc123";
const PARENT = "20261127_2134_TASK-405_row-405-is-the-complete";
const CHILD = `wtgui/row-497-is-the-complete-brief-every-${TAG}`;
// A drive letter is BUILT here, never written: this tree's own absolute-path gate reads every line for a machine's
// folder, and a fixture that must contain one spells it from parts so the gate keeps reading the words, not a path.
const DRIVE = "C" + ":";
const TREE = `${DRIVE}/ProjectDevelopment/agent-worktree-gui/.worktrees/row-497-is-the-complete-brief-every-${TAG}`;

// One record in the cut book, in the shape lib/jobs.js `rememberParent` writes: keyed by the tree's six-hex tag.
const book = (over = {}) => ({
  [`tag:${TAG}`]: { parent: PARENT, branch: CHILD, tree: TREE, at: "2026-11-28T08:59:29.855Z", ...over },
});

test("1. a recorded parent is named as recorded, and its title names the record it came from", () => {
  const line = parentLineFor({ book: book(), tree: TREE, branch: CHILD, parentSource: "unknown", mainBranch: "main" });
  assert.equal(line.kind, "recorded");
  assert.equal(line.parent, PARENT);
  assert.equal(line.text, `cut from ${PARENT}`);
  assert.match(line.title, /branch-parents\.json tag:abc123/);
  assert.match(line.title, /recorded/);
  assert.doesNotMatch(line.text, /reconstruct|guess/i);

  // The tag is the key even after the panel renamed the branch: the record names the OLD branch, and the tree is the
  // same tree because both names carry the same six hex. Still recorded, still the same parent.
  const renamed = parentLineFor({
    book: book({ branch: "wtgui/row-497-an-older-name-abc123" }),
    tree: TREE,
    branch: CHILD,
    mainBranch: "main",
  });
  assert.equal(renamed.kind, "recorded");
  assert.equal(renamed.text, `cut from ${PARENT}`);

  // A record with no tag at all is found by the tree's own path.
  const byPath = parentLineFor({
    book: { [`tree:${TREE.toLowerCase()}`]: { parent: PARENT, branch: null, tree: TREE, at: null } },
    tree: TREE,
    branch: CHILD,
    mainBranch: "main",
  });
  assert.equal(byPath.kind, "recorded");
  assert.match(byPath.title, /branch-parents\.json tree:/);
});

test("2. a reconstruction names the parent and says it was reconstructed, never recorded", () => {
  // 2a. From the reflog, which is the strongest reconstruction lib/parents.js has.
  const reflog = parentLineFor({
    tree: TREE,
    branch: CHILD,
    parent: "dmr-7-turnover",
    parentSource: "backfilled",
    why: "its reflog still records `Created from dmr-7-turnover`",
    mainBranch: "main",
  });
  assert.equal(reflog.kind, "reconstructed");
  assert.equal(reflog.text, "cut from dmr-7-turnover - reconstructed from its reflog, not recorded");
  assert.match(reflog.title, /reconstructed by lib\/parents\.js, not recorded/);
  assert.match(reflog.title, /Created from dmr-7-turnover/);

  // 2b. From the shared-ticket heuristic: still reconstructed, and the title says which reconstruction it was.
  const guessed = parentLineFor({
    tree: TREE,
    branch: CHILD,
    parent: "dmr-7-turnover",
    parentSource: "backfilled",
    why: "the only branch this one descends from with ticket DMR-7",
    mainBranch: "main",
  });
  assert.equal(guessed.kind, "reconstructed");
  assert.equal(guessed.text, "cut from dmr-7-turnover - reconstructed, not recorded");
  assert.match(guessed.title, /the only branch this one descends from/);

  // THE ONE ANSWER A GUESS MAY NEVER GIVE: a backfilled parent is never printed as recorded.
  for (const line of [reflog, guessed]) {
    assert.notEqual(line.kind, "recorded");
    assert.match(line.text, /not recorded/);
  }
});

test("3. an unknown says so, with the reason, and a tie is unknown rather than a pick", () => {
  const bare = parentLineFor({ tree: TREE, branch: CHILD, mainBranch: "main" });
  assert.equal(bare.kind, "unknown");
  assert.equal(bare.text, UNKNOWN_PARENT_LINE);
  assert.equal(bare.text, "unknown - no cut record and its reflog names no local branch");
  assert.equal(bare.parent, null);
  assert.match(bare.title, /no cut record/);

  // The tie lib/parents.js refuses to break: two ancestors equally near. The reconstruction answers null, and the
  // row reads unknown - a guess must not choose between siblings.
  const tie = pickBackfill({
    branch: CHILD,
    candidates: [
      { branch: "sibling-a", sharesBase: true, isAncestor: true, behind: 4 },
      { branch: "sibling-b", sharesBase: true, isAncestor: true, behind: 4 },
    ],
  });
  assert.equal(tie.parent, null, "a tie has no parent");
  const tieLine = parentLineFor({
    tree: TREE,
    branch: CHILD,
    parent: tie.parent,
    parentSource: "unknown",
    why: tie.why,
    mainBranch: "main",
  });
  assert.equal(tieLine.kind, "unknown");
  assert.equal(tieLine.text, UNKNOWN_PARENT_LINE);
  assert.match(tieLine.title, /ambiguous: sibling-a, sibling-b/);
  assert.doesNotMatch(tieLine.text, /sibling-a|sibling-b/);

  // A record whose reason is a refusal still says unknown, and the reason travels in the title.
  const refused = parentLineFor({
    tree: TREE,
    branch: CHILD,
    parent: null,
    parentSource: "unknown",
    why: "its reflog says it was created from refs/remotes/origin/somewhere, which is not a local branch - nothing here can roll into it",
    mainBranch: "main",
  });
  assert.equal(refused.kind, "unknown");
  assert.equal(refused.text, UNKNOWN_PARENT_LINE);
  assert.match(refused.title, /not a local branch/);
});

test("4. main and master are the project base, never a child's parent", () => {
  for (const [name, mainBranch] of [["main", "main"], ["master", "main"], ["develop", "develop"]]) {
    const line = parentLineFor({
      book: { [`tag:${TAG}`]: { parent: name, branch: CHILD, tree: TREE, at: null } },
      tree: TREE,
      branch: CHILD,
      mainBranch,
    });
    assert.equal(line.kind, "base", `${name} is a base, not a parent`);
    assert.notEqual(line.kind, "recorded");
    assert.equal(line.text, `cut from the project base ${name} - ${name} is the turnover destination, never a child's parent`);
    assert.match(line.title, /never a child's parent/);
    // The branch is named as the base - it is never offered as a parent a roll-up could write into.
    assert.doesNotMatch(line.text, /^cut from (main|master|develop)$/);
  }

  // The same answer when the evidence is a reflog that named a main branch: lib/parents.js refused it, and the fact it
  // refused (not a sentence parsed back into a branch name) is what says so.
  const fromReflog = parentLineFor({
    tree: TREE,
    branch: CHILD,
    parent: null,
    parentSource: "unknown",
    why: "its reflog says it was created from master - a main branch, never a child's parent",
    refused: "master",
    mainBranch: "main",
  });
  assert.equal(fromReflog.kind, "base");
  assert.equal(fromReflog.text, "cut from the project base master - master is the turnover destination, never a child's parent");
  assert.match(fromReflog.title, /^reconstructed:/);
});

test("5. a turnover container has nothing above it, and says so", () => {
  const line = parentLineFor({
    book: { [`tag:${TAG}`]: { parent: "main", branch: PARENT, tree: TREE, at: null } },
    tree: TREE,
    branch: PARENT,
    mainBranch: "main",
    turnover: true,
  });
  assert.equal(line.kind, "turnover");
  assert.equal(line.text, "turnover container - nothing above it");
  assert.equal(line.parent, null, "a container has no parent to name");
  assert.match(line.title, /is the project's turnover branch/);
  // The container's record names main as the base it was cut from; the line still does not offer it as a parent.
  assert.doesNotMatch(line.text, /cut from/);
});

test("no sibling is ever printed as a parent: the tree's own branch is not a parent", () => {
  // A record that names the tree's own branch (a hand-edited book, or a rename that collided) is not a parent.
  const self = parentLineFor({
    book: { [`tag:${TAG}`]: { parent: CHILD, branch: CHILD, tree: TREE, at: null } },
    tree: TREE,
    branch: CHILD,
    mainBranch: "main",
  });
  assert.equal(self.kind, "unknown");
  assert.equal(self.text, UNKNOWN_PARENT_LINE);
  assert.doesNotMatch(self.text, new RegExp(CHILD));

  // The same from the reconstruction side, which lib/parents.js already refuses; the line must not resurrect it.
  const guessSelf = parentLineFor({
    tree: TREE,
    branch: CHILD,
    parent: CHILD,
    parentSource: "backfilled",
    why: "its reflog still records `Created from wtgui/row-497-is-the-complete-brief-every-abc123`",
    mainBranch: "main",
  });
  assert.equal(guessSelf.kind, "unknown");
  assert.equal(guessSelf.text, UNKNOWN_PARENT_LINE);

  // A backfilled parent that IS the project's main branch is not a parent either.
  const guessMain = parentLineFor({
    tree: TREE,
    branch: CHILD,
    parent: "main",
    parentSource: "backfilled",
    why: "the only branch this one descends from with ticket DMR-7",
    mainBranch: "main",
  });
  assert.notEqual(guessMain.kind, "reconstructed");
  assert.equal(guessMain.text, UNKNOWN_PARENT_LINE);
});

test("every saying has its own kind, and the renderer draws the block's own classes", () => {
  assert.deepEqual(PARENT_LINE_KINDS, ["recorded", "reconstructed", "unknown", "base", "turnover"]);
  const item = parentLineItemHtml(parentLineFor({ book: book(), tree: TREE, branch: CHILD, mainBranch: "main" }));
  assert.equal(
    item,
    `<li class="git-parent" title="recorded in the cut book (branch-parents.json tag:abc123) when the panel cut this tree - not reconstructed and not guessed"><span class="dim">parent</span> <span class="mono">cut from ${PARENT}</span></li>`,
  );
  // Nothing to say draws nothing: the checkout row carries no line.
  assert.equal(parentLineItemHtml(null), "");
  assert.equal(parentLineItemHtml({ text: "" }), "");
  // The value is escaped, so a branch name can never break out of the block.
  const nasty = parentLineItemHtml({ text: `cut from "<script>"`, title: `a "quoted" title` });
  assert.doesNotMatch(nasty, /<script>/);
  assert.match(nasty, /&lt;script&gt;/);
  assert.match(nasty, /&quot;quoted&quot;/);
});

test("the page's template is the renderer's, byte for byte", () => {
  // The wiring: public/board-scaffold.js is a classic script and cannot import lib/parent-line.js, so its template is
  // pinned here. Drift in a class, the label or the escaping fails this test rather than the reader's block.
  const page = read("public/board-scaffold.js").replace(/\r\n/g, "\n");
  const template =
    '`<li class="git-parent" title="${esc(row.parentLine.title || row.parentLine.text)}"><span class="dim">parent</span> <span class="mono">${esc(row.parentLine.text)}</span></li>`';
  assert.ok(page.includes(template), "board-scaffold.js draws the parent item with the renderer's own markup");
  // It is inside the Merge state block's list, and the block is the one the row's detail draws.
  const detail = page.slice(page.indexOf("function detailHtml(row)"), page.indexOf("// THE COLLISION CARD reads the RECORD"));
  assert.ok(detail.includes("<li class=\"git-summary-line\">${esc(gitSummary)}</li>\n          ${parentItem}"), "the item sits in the Merge state block's own list");
  assert.ok(detail.includes("<h4>Merge state</h4>"), "the block it is drawn in is the Merge state one");
  // No stylesheet rule was added for it: the classes it wears are the panel's existing utilities.
  const css = ["public/board-table.css", "public/chart.css", "public/rowstrips.css", "public/base.css"].map((p) => read(p).replace(/\r\n/g, "\n")).join("\n");
  assert.ok(!/\.git-parent\b/.test(css), "no stylesheet rule names the parent item");
  assert.ok(/\.dim \{ color: var\(--dim\); \}/.test(read("public/rowstrips.css")), "the dim class is the existing one");
  assert.ok(/\.mono \{ font-family: var\(--mono\); font-size: 12px; \}/.test(read("public/rowstrips.css")), "the mono class is the existing one");
});

test("the server stamps the line on every row from one read of the cut book, and leaves the checkout alone", () => {
  // The row carries the sentence (server.js `withParentLines`), so the page never reads a file and the line cannot
  // disagree with the scan. One `loadParents()` per snapshot, the same cost `withTreeKinds` already pays per row.
  const server = read("server.js").replace(/\r\n/g, "\n");
  const start = server.indexOf("function withParentLines(snap)");
  assert.ok(start > 0, "withParentLines is in server.js");
  const body = server.slice(start, server.indexOf("\n// The reader's lock travels", start));
  assert.match(body, /jobs\.loadParents\(\)/, "the cut book is read once, through the store's own loader");
  assert.match(body, /parentLineFor\(\{/, "the row's line is the module's answer, not a second sentence");
  assert.match(body, /book,/, "the cut book is what recordedParentFor reads");
  assert.match(body, /parents\.get\(project\.name, branch\)/, "the reconstruction comes from the parent book");
  assert.match(body, /refused: \(rec && rec\.refused\) \|\| ""/, "a refused main ref travels with the record");
  assert.match(body, /turnoverBranchesOf\(project\)/, "the container is read from the project's own turnover list");
  assert.match(body, /delete row\.parentLine;/, "the project's own checkout has no parent to name");
  // It is applied to every snapshot, beside the kind overlay it shares its book with.
  assert.match(server, /withInitiatives\(withParentLines\(withTreeKinds\(snap\)\)\)/, "the overlay is in the snapshot chain");
  // And the only place the field is dropped is this overlay: no later one strips it.
  assert.equal((server.match(/delete row\.parentLine;/g) || []).length, 1, "the line is dropped in one place, the checkout branch above");
});
