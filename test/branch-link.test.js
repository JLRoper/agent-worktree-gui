// The branch name, in ONE renderer: public/core/branch-link.js.
//
// WHY THIS FILE EXISTS. The chart's branch cell has drawn a branch as a link to its page on the remote for a long
// time. The Initiatives tab's worktree list now draws the SAME affordance, and the brief's rule is one implementation
// rather than two: a change to the anchor has to change both surfaces, and a tree with no resolvable repo has to read
// as plain text with no dead link. The answers that still look right when they are wrong:
//
//   * an href built here from the branch name instead of the server's `branchUrl` - a guessed page that 404s, which
//     is the one thing lib/project.js `branchLink` refuses to do;
//   * a plain span that still carries `href`, or an anchor with no href - a dead link that a keyboard can reach and a
//     screen reader announces as a link that goes nowhere;
//   * two copies of the markup, one in app.js and one in assistant.js, which is the drift this module exists to stop.
//
// The link is an `<a href>` on purpose: that is what puts it in the tab order and makes a screen reader announce it
// as a link. Nothing here adds a role, a tabindex or a click handler.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

await import("../public/core/branch-link.js");
const { branchNameHtml, LINK_CLASS, PLAIN_CLASS, NO_BRANCH } = globalThis.wtBranchLink;

const page = "https://github.com/JLRoper/proof-repo/tree/wtgui/proof-local-bbbbbb";
const tag = (html) => (/^<(\w+)/.exec(html) || [])[1] || null;
const attr = (html, name) => (new RegExp(`\\s${name}="([^"]*)"`).exec(html) || [])[1] ?? null;
const text = (html) => (/^<[^>]+>([\s\S]*)<\/\w+>$/.exec(html) || [])[1] ?? "";

test("a resolved page is an anchor: the server's href, a new tab, noopener, and a title that says where it goes", () => {
  const html = branchNameHtml({ branch: "wtgui/proof-local-bbbbbb", url: page, linkFrom: "remote" });
  assert.equal(tag(html), "a");
  assert.equal(attr(html, "class"), LINK_CLASS);
  assert.equal(attr(html, "href"), page, "the href is the server's page, byte for byte");
  assert.equal(attr(html, "target"), "_blank", "the chart has always opened the remote page in a new tab");
  assert.equal(attr(html, "rel"), "noopener");
  assert.equal(attr(html, "title"), "open wtgui/proof-local-bbbbbb on the remote");
  assert.equal(text(html), "wtgui/proof-local-bbbbbb", "the visible text is the branch, so it is the accessible name");
  assert.equal(attr(html, "tabindex"), null, "an anchor with an href is already in the tab order");
  assert.equal(attr(html, "role"), null, "an anchor with an href is already a link to a screen reader");
});

test("a page found in the last fetch's refs says the remote itself was not asked", () => {
  const html = branchNameHtml({ branch: "b", url: page, linkFrom: "local-refs" });
  assert.match(attr(html, "title"), /the remote itself was not asked/);
});

test("no page is a plain span: no href, no dead link, and the server's reason in the title", () => {
  const why = "local only - this branch has no copy on the remote (the remote origin does not list it)";
  const html = branchNameHtml({ branch: "wtgui/proof-local-bbbbbb", url: null, why });
  assert.equal(tag(html), "span");
  assert.equal(attr(html, "class"), PLAIN_CLASS);
  assert.equal(attr(html, "href"), null, "plain text must not carry an href");
  assert.equal(attr(html, "title"), why, "the reason is the title, not a guess");
  assert.equal(text(html), "wtgui/proof-local-bbbbbb");
});

test("no reason from the server falls back to the honest sentence, not to a claim about the remote", () => {
  const html = branchNameHtml({ branch: "b", url: "" });
  assert.equal(tag(html), "span");
  assert.match(attr(html, "title"), /not read yet - the remote has not been asked about this branch/);
  assert.match(attr(branchNameHtml({ branch: "b", url: null, remoteBranch: "n/a" }), "title"), /no remote configured/);
});

test("a caller may name its own class pair and fallback title, and those are escaped too", () => {
  const html = branchNameHtml({
    branch: 'a"<b>',
    url: null,
    fallback: 'the branch this "worktree" is on',
    plainClass: 'chip init-branch mono "x"',
  });
  assert.equal(attr(html, "class"), "chip init-branch mono &quot;x&quot;");
  assert.equal(attr(html, "title"), "the branch this &quot;worktree&quot; is on");
  assert.equal(text(html), "a&quot;&lt;b&gt;");
});

test("a branch with no name draws the one placeholder the chart has always drawn", () => {
  const html = branchNameHtml({ branch: "", url: null, why: "no branch was read for this worktree" });
  assert.equal(text(html), NO_BRANCH);
  assert.equal(tag(html), "span");
});

test("an amp in the URL is escaped, so the href is still the URL the server sent", () => {
  const url = "https://git.sefl.com/projects/IT/repos/email-multi/browse?at=refs%2Fheads%2Fa&x=1";
  const html = branchNameHtml({ branch: "a", url });
  assert.equal(attr(html, "href"), url.replace("&", "&amp;"));
});

// ---- the route hands the tab the same page the chart was given ---------------------------------------------------
// The initiative's worktree row can only draw a link if the read carries the row's own `branchUrl`. This is the join
// between the store (which knows paths) and the board (which knows the branch and its page), so it is pinned here
// rather than only on a screenshot: a field dropped on the way through would leave every branch plain in the tab
// while the chart still linked them, which is exactly the two-implementations bug.
const { initiativesView } = await import("../routes/initiatives.js");

const viewFor = (row) =>
  initiativesView({
    initiatives: {
      statusOf: () => ({ file: "panel/logs/initiatives.json", found: true, readable: true }),
      initiativeList: () => [{ id: "i1", title: "SSO migration", description: "" }],
      treesFor: () => [{ key: "repos/tree", path: "repos/prooflib/.worktrees/proof-local-bbbbbb", at: null, by: null }],
    },
    projectForPath: () => ({ name: "prooflib" }),
    rowFor: () => row,
    now: 0,
  }).initiatives[0].projects[0].trees[0];

test("the initiatives read carries the row's branch page through to the tab", () => {
  const tree = viewFor({ branch: "wtgui/proof-local-bbbbbb", branchUrl: page, branchWhy: "", branchLinkFrom: "remote" });
  assert.equal(tree.branch, "wtgui/proof-local-bbbbbb");
  assert.equal(tree.branchUrl, page, "the tab draws the same href the chart does");
  assert.equal(tree.branchLinkFrom, "remote");
});

test("a row with no page passes null, so the tab can only draw plain text", () => {
  const tree = viewFor({ branch: "wtgui/proof-local-bbbbbb", branchUrl: null, branchWhy: "no remote configured" });
  assert.equal(tree.branchUrl, null);
  assert.equal(tree.branchWhy, "no remote configured");
});

test("a tree with no board row has no branch and no page at all", () => {
  const tree = viewFor(null);
  assert.equal(tree.branch, "");
  assert.equal(tree.branchUrl, null);
  assert.equal(tree.missing, true);
});

// The two surfaces and the module they share. A second copy of the anchor in either caller is the drift the brief
// names, and it would not fail any of the renderer's own tests above - so the copies themselves are what is pinned.
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const assistant = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
const core = readFileSync(new URL("../public/core/branch-link.js", import.meta.url), "utf8");
const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("the anchor's markup exists in ONE file: the shared renderer", () => {
  assert.equal((core.match(/<a class="/g) || []).length, 1, "the module draws the anchor");
  assert.match(core, /const LINK_CLASS = "branch-link"/);
  assert.equal((app.match(/<a class="branch-link"/g) || []).length, 0, "app.js draws no branch anchor of its own");
  assert.equal((assistant.match(/<a class="branch-link"/g) || []).length, 0, "assistant.js draws no branch anchor of its own");
});

test("both the chart row and the initiative's worktree list call the renderer", () => {
  assert.match(app, /wtBranchLink\.branchNameHtml\(\{/, "the chart's branch cell calls the shared renderer");
  assert.match(assistant, /wtBranchLink\.branchNameHtml\(\{/, "the initiative's tree row calls the shared renderer");
  assert.equal((assistant.match(/wtBranchLink\.branchNameHtml\(/g) || []).length, 1, "one call site in the pane");
});

test("the page loads it before either caller, which is what makes the global exist", () => {
  const at = (needle) => index.indexOf(needle);
  assert.ok(at('src="/core/branch-link.js"') > 0, "the shell loads the module");
  assert.ok(at('src="/app.js"') > at('src="/core/branch-link.js"'), "loaded before app.js");
  assert.ok(at('src="/assistant.js"') > at('src="/core/branch-link.js"'), "loaded before assistant.js");
});
