// branch-link.js - ONE renderer for a branch NAME that may be a link to its page on the remote.
//
// WHY THIS IS A MODULE AND NOT MARKUP IN TWO PLACES. The chart's branch cell has drawn this link since the branch
// column existed: an anchor with class `branch-link`, opened in a new tab (`target="_blank"`, `rel="noopener"`), with
// a title that says the branch opens on the remote and - when the page came from the last fetch's refs instead of
// the remote itself - says so. The Initiatives tab now draws the same affordance beside each worktree, so a second
// copy of that markup would drift one gesture at a time: the initiative's link would open in the panel's own viewer
// while the chart's opened a tab, or one would carry a title the other did not. The anchor's whole shape lives here
// and BOTH callers call it - public/app.js `branchCellHtml` (the chart row) and public/assistant.js
// `initTreeRowHtml` (the initiative's worktree list). A change to the link is a change to both.
//
// WHAT IS NOT HERE: the URL. `row.branchUrl` is the server's answer - lib/project.js `branchLink` asks the project's
// host record for the href shape and git whether the remote really has that branch - and `branchWhy` is the
// sentence for the no-link case. This module draws what it is given and falls back to plain text when the URL is
// null, never a guessed href. A tree with no resolvable repo therefore reads as a branch name with no dead link.
//
// KEYBOARD AND SCREEN READER: the link is a real `<a href>`, so it is in the tab order and announced as a link with
// the branch name as its accessible name. No tabindex, no role and no click handler of its own: the panel's rows
// already step aside for an anchor, so following the link never folds a card or opens a row.
//
// Published on globalThis as `wtBranchLink`; loaded as a classic script by public/index.html before app.js and
// assistant.js, and imported by test/branch-link.test.js, which pins the href shape, the plain-text fallback and the
// one-implementation claim.
(function (root) {
  "use strict";

  const LINK_CLASS = "branch-link";
  const PLAIN_CLASS = "branch-plain";
  // A row that has not been read yet has no branch: the chart has always drawn one short placeholder rather than an
  // empty cell, and a span with no text would leave the cell looking broken.
  const NO_BRANCH = "-";

  // The same four characters the page's `esc` handles. Kept local so this module is the one dependency the two
  // callers share and neither has to hold the link's markup itself; test/branch-link.test.js imports this file alone.
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ESC[c]);

  // The title on the anchor. `local-refs` is the weaker route: the remote itself was not asked, so the title says
  // the page was found in what the last fetch left (the chart's own sentence, moved here verbatim).
  function linkTitle(branch, from) {
    const how = from === "local-refs" ? " (found in refs/remotes from the last fetch - the remote itself was not asked)" : "";
    return `open ${branch} on the remote${how}`;
  }

  // The title on the plain name. It is the server's reason (`branchWhy`) whenever there is one, because that is what
  // tells "local only" from "no remote configured" from "not read yet"; a caller may pass its own fallback sentence
  // for a surface where the server said nothing.
  function plainTitle({ why, remoteBranch, fallback }) {
    if (why) return String(why);
    if (fallback) return String(fallback);
    return remoteBranch === "n/a" ? "no remote configured" : "not read yet - the remote has not been asked about this branch";
  }

  /**
   * The branch name, as a link when `url` is a page the server could build, as plain text otherwise.
   *
   *   branch        the branch name to draw (its text is the link's accessible name)
   *   url           the server's page for that branch, or null/empty for no link
   *   linkFrom      "remote" or "local-refs" - only the weaker one changes the anchor's title
   *   why           the server's sentence for the no-link case (the plain span's title)
   *   remoteBranch  "n/a" when the project has no remote, so the fallback title can say exactly that
   *   fallback      a caller's own title for the plain case, used only when `why` is empty
   *   linkClass     the anchor's class; defaults to the chart's `branch-link`
   *   plainClass    the span's class; defaults to the chart's `branch-plain`
   */
  function branchNameHtml({ branch, url, linkFrom = "", why = "", remoteBranch = "", fallback = "", linkClass = "", plainClass = "" } = {}) {
    const name = esc(String(branch || NO_BRANCH));
    if (url) {
      const cls = esc(linkClass || LINK_CLASS);
      return `<a class="${cls}" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(linkTitle(String(branch || ""), linkFrom))}">${name}</a>`;
    }
    const cls = esc(plainClass || PLAIN_CLASS);
    const title = esc(plainTitle({ why, remoteBranch, fallback }));
    return `<span class="${cls}" title="${title}">${name}</span>`;
  }

  root.wtBranchLink = { LINK_CLASS, PLAIN_CLASS, NO_BRANCH, linkTitle, plainTitle, branchNameHtml };
})(globalThis);
