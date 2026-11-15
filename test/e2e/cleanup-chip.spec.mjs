// test/e2e/cleanup-chip.spec.mjs - the cleanup chip in a real browser: the pill, the two presses, the run's effect.
//
// WHAT THIS IS. The chip is drawn by public/render-projects.js from public/board-scaffold.js, its press goes through
// POST /api/projects/:id/cleanup (routes/project-cleanup.js), and the run removes real worktrees
// (lib/cleanup-run.js -> lib/worktree-remove.js). The unit tests pin each of those on its own; this spec presses the
// REAL chip on a real project card in headless Chromium and asserts what the reader sees and what the disk holds after,
// so no one of them is taken on its own word.
//
//   RUN   node --test --test-reporter=spec test/e2e/cleanup-chip.spec.mjs
//         npm run test:e2e:cleanup-chip
//         CLEANUP_CHIP_SHOTS=<dir>   where the screenshots go (default: the run's scratch dir)
//
// THE PANEL IS ITS OWN. A throwaway server.js from this checkout (tools/panel-testkit.mjs) on a spare port with its own
// store; the reader's live panel on 7331 is never started, restarted, read or written, and case 0 asserts the port.
//
// NOTHING OPENS A WINDOW. The chip opens the report through the panel's own opener (POST /api/open-file), which on
// this host would launch the reader's browser. The spec intercepts that one route in the browser and records the path
// instead: the chip's request is what is under test, not the browser the panel would have started.
//
// THE FIXTURE is one worktree per verdict the card can show:
//
//   landed    wtgui/landed    fast-forwarded into main   -> remove (an ancestor proof)
//   ahead     wtgui/ahead     1 commit main lacks        -> merge into a child of the turnover branch
//   rollup    20261114_0930_DMR-1-rollup  merged into main -> keep (a turnover name is never deleted)
//   the primary checkout                                     -> skip
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { attachPageCollectors, loadPlaywright } from "../../tools/browser.mjs";
import { configureRepo, freePort, git, ran, slash, startPanel, waitFor } from "../../tools/panel-testkit.mjs";

const LIVE_PORT = 7331;
const PROJECT = "cleanup-e2e";
const TURNOVER = "20261114_0930_DMR-1-rollup";
const SHOTS = path.resolve(process.env.CLEANUP_CHIP_SHOTS || path.join(os.tmpdir(), "wtgui-cleanup-chip-shots"));

let fixture = null;
let panel = null;
let browser = null;
let page = null;
let pageErrors = [];
let consoleErrors = [];
let openFileCalls = [];

function makeFixture() {
  const base = mkdtempSync(path.join(os.tmpdir(), "cleanup-chip-e2e-"));
  const repo = path.join(base, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  configureRepo(repo);
  writeFileSync(path.join(repo, "README.md"), "# fixture\n", "utf8");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "root");
  const treeOf = (name) => slash(path.join(repo, ".worktrees", name));
  const cut = (name, branch) => {
    git(repo, "worktree", "add", "-q", "-b", branch, treeOf(name), "main");
    return treeOf(name);
  };

  // landed: a commit main was fast-forwarded onto, so the branch is an ancestor of main.
  const landed = cut("landed", "wtgui/landed");
  writeFileSync(path.join(landed, "landed.txt"), "already in main\n", "utf8");
  git(landed, "add", "-A");
  git(landed, "commit", "-qm", "landed work");
  git(repo, "merge", "--ff-only", "-q", "wtgui/landed");

  // rollup: a turnover branch, fully merged - the one branch the plan must never delete.
  const rollup = cut("rollup", TURNOVER);
  writeFileSync(path.join(rollup, "rollup.txt"), "roll-up work\n", "utf8");
  git(rollup, "add", "-A");
  git(rollup, "commit", "-qm", "rollup work");
  git(repo, "merge", "--ff-only", "-q", TURNOVER);

  // ahead: one commit main does not have - merged into a child, its tree kept.
  const ahead = cut("ahead", "wtgui/ahead");
  writeFileSync(path.join(ahead, "ahead.txt"), "work main lacks\n", "utf8");
  git(ahead, "add", "-A");
  git(ahead, "commit", "-qm", "ahead work");

  return { base, repo: slash(repo), landed, rollup, ahead };
}

test("before anything: the panel is this run's own, not the reader's", async () => {
  fixture = makeFixture();
  mkdirSync(SHOTS, { recursive: true });
  const port = await freePort();
  assert.notEqual(port, LIVE_PORT, "the OS handed out the reader's own port - refusing to boot over a live panel");
  panel = await startPanel({
    port,
    config: {
      refreshSeconds: 3600,
      worktreeSeconds: 3600,
      midSeconds: 3600,
      dormantSeconds: 3600,
      slowSeconds: 3600,
      fetchSeconds: -1,
      discoverSeconds: 3600,
      assistant: { enabled: false },
      apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
      projects: [{ name: PROJECT, path: fixture.repo, mainBranch: "main", turnoverBranch: TURNOVER }],
    },
  });
  console.log(`      cleanup-chip spec: panel ${panel.base} (repo ${fixture.repo}), shots ${SHOTS}`);
  assert.match(panel.base, /^http:\/\/127\.0\.0\.1:\d+$/, "the panel is a loopback listener of this run");
  assert.equal((await fetch(`${panel.base}/api/health`)).status, 200, "and it is the panel this run started");
});

test.after(async () => {
  if (browser) await browser.close().catch(() => {});
  if (panel) await panel.stop();
  if (fixture) rmSync(fixture.base, { recursive: true, force: true });
});

test("the chip is the last pill of the project head line, and the same pill as the board chip", async () => {
  const PW = loadPlaywright();
  if (!PW) {
    console.log("      BROWSER-HALF-NOT-RUN: playwright is not on this machine, so the browser half did not run");
    return;
  }
  browser = await PW.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1760, height: 1000 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  ({ pageErrors, consoleErrors } = attachPageCollectors(page));
  // The report's opener would launch the reader's browser; this spec records the request instead. Only the POST is
  // recorded - the page also READS /api/open-file on load (which browser is registered), and that read opens nothing.
  await page.route("**/api/open-file", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    openFileCalls.push(JSON.parse(request.postData() || "{}"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, reused: false }) });
  });
  await page.goto(panel.base, { waitUntil: "domcontentloaded" });
  // `attached`, not the default `visible`: a folded project hides the meta line the chip lives in, so waiting for the
  // chip to be visible before opening the card would wait for something the fold is hiding.
  await page.waitForSelector(`section.project[data-project="${PROJECT}"] [data-cleanup-chip="${PROJECT}"]`, { state: "attached" });
  // A project starts FOLDED on a fresh panel, and a folded card hides its meta line (style.css: `section.project
  // .collapsed .project-head.meta-line { display: none }`). The chip lives in that line, so the card is opened first -
  // and the height assertions below then have to be non-zero rather than a pair of zeroes that compare equal.
  if (await page.locator(`section.project[data-project="${PROJECT}"]`).evaluate((el) => el.classList.contains("collapsed"))) {
    await page.click(`section.project[data-project="${PROJECT}"] .project-head[data-toggle-project] h2`);
  }
  await page.waitForSelector(`section.project[data-project="${PROJECT}"] .project-head.meta-line [data-cleanup-chip="${PROJECT}"]`, { state: "visible" });

  const geom = await page.evaluate((name) => {
    const section = document.querySelector(`section.project[data-project="${name}"]`);
    const head = section.querySelector(".project-head.meta-line");
    const order = ["data-host-chip", "data-rules-chip", "data-turnover-chip", "data-board-chip", "data-cleanup-chip"];
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top * 10) / 10, height: Math.round(r.height * 10) / 10, left: Math.round(r.left * 10) / 10 };
    };
    const found = order.filter((attr) => section.querySelector(`.project-head.meta-line [${attr}="${name}"]`));
    const board = head.querySelector(`[data-board-chip="${name}"]`);
    const cleanup = head.querySelector(`[data-cleanup-chip="${name}"]`);
    return {
      found,
      inHead: head.contains(cleanup),
      board: board ? rect(board) : null,
      cleanup: rect(cleanup),
      label: cleanup.textContent.trim(),
      cleanupIsLast: head.querySelectorAll(".project-head.meta-line > button, button").length
        ? Array.from(head.querySelectorAll("button")).pop() === cleanup
        : false,
      sectionTag: section.tagName,
    };
  }, PROJECT);

  // The pill sits in the head's second line, after the board chip, and is the last of them.
  assert.equal(geom.inHead, true, "the cleanup chip is in the project head's meta line");
  assert.equal(geom.found.includes("data-board-chip"), true, "the board chip is in that same line");
  assert.equal(geom.found[geom.found.length - 1], "data-cleanup-chip", `the cleanup chip is the LAST pill of the line, got ${geom.found.join(", ")}`);
  assert.equal(geom.cleanupIsLast, true, "no button after it in the head line");
  assert.equal(geom.label, "cleanup", "at rest it says cleanup");
  // The same pill: the board chip's height and its line, not a control with its own.
  assert.ok(geom.board, "the board chip was drawn");
  assert.ok(geom.cleanup.height > 10, `the pill has a real height, not a hidden zero (${geom.cleanup.height})`);
  assert.equal(geom.cleanup.height, geom.board.height, `the pill is the board chip's height (${geom.cleanup.height} vs ${geom.board.height})`);
  assert.equal(geom.cleanup.top, geom.board.top, "and sits on the same line");

  await page.locator(`section.project[data-project="${PROJECT}"] .project-head.meta-line`).screenshot({ path: path.join(SHOTS, "1-head-line.png") });
});

test("the first press is a dry run: busy, then armed, and nothing on disk moves", async () => {
  assert.ok(page, "the browser half must have run");
  // Hold the answer for a moment so the BUSY state is observable rather than a frame that came and went.
  await page.route("**/api/projects/*/cleanup", async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    await route.continue();
  });
  await page.click(`[data-cleanup-chip="${PROJECT}"]`);
  // Busy on the read, drawn before the request answers.
  await waitFor(async () => (await page.locator(`[data-cleanup-chip="${PROJECT}"]`).textContent()).includes("reading"), { what: "the reading label" });
  assert.match(await page.locator(`[data-cleanup-chip="${PROJECT}"]`).getAttribute("class"), /is-busy/);
  assert.match(await page.locator(`[data-cleanup-chip="${PROJECT}"]`).textContent(), /cleanup: reading/);

  // Armed: the plan's drop count, and the bar listing one row per worktree.
  await waitFor(async () => (await page.locator(`[data-cleanup-chip="${PROJECT}"]`).textContent()).includes("apply"), { what: "the armed label", timeoutMs: 40_000 });
  assert.equal((await page.locator(`[data-cleanup-chip="${PROJECT}"]`).textContent()).trim(), "cleanup: 1 to drop, 1 to merge · apply");
  assert.match(await page.locator(`[data-cleanup-chip="${PROJECT}"]`).getAttribute("class"), /is-armed/);
  const bar = page.locator(`[data-cleanup-bar="${PROJECT}"]`);
  await bar.waitFor();
  assert.equal(await bar.locator(".cleanup-row").count(), 4, "one row per worktree, the skipped primary included");
  assert.equal(await bar.locator(".cleanup-call.is-drop").count(), 1, "one drop call, for the landed tree");
  assert.equal(await bar.locator(".cleanup-call.is-keep").count(), 3, "the merge row, the turnover row and the primary all read keep");

  // Nothing moved: the tree, its branch, and main are where they were.
  assert.equal(existsSync(fixture.landed), true, "a dry run removes nothing");
  assert.equal(ran(fixture.repo, "rev-parse", "--verify", "refs/heads/wtgui/landed"), true);
  assert.equal(git(fixture.repo, "for-each-ref", "refs/heads/cleanup/").trim(), "", "a dry run merges nothing");
  // The page the press wrote is in the TARGET repo, opened through the panel's opener.
  const reports = readdirSync(path.join(fixture.repo, "docs", "reports"));
  const reportFiles = reports.filter((f) => /^worktree-cleanup-\d{4}-\d{2}-\d{2}-\d{4}\.html$/.test(f));
  assert.equal(reportFiles.length, 1, `one report named worktree-cleanup-<date>-<hhmm>.html, got ${reports.join(", ")}`);
  assert.match(readFileSync(path.join(fixture.repo, "docs", "reports", reportFiles[0]), "utf8"), /DRY RUN/);
  assert.equal(openFileCalls.length, 1, "the chip opened the plan page");
  assert.ok(String(openFileCalls[0].path).endsWith(reportFiles[0]), `the opened path is the report (${openFileCalls[0].path})`);

  await bar.screenshot({ path: path.join(SHOTS, "2-plan-bar.png") });
});

test("the second press applies it: busy, then done, and the disk follows the plan", async () => {
  assert.ok(page, "the browser half must have run");
  await page.click(`[data-cleanup-chip="${PROJECT}"]`);
  await waitFor(async () => (await page.locator(`[data-cleanup-chip="${PROJECT}"]`).textContent()).includes("applying"), { what: "the applying label" });
  assert.match(await page.locator(`[data-cleanup-chip="${PROJECT}"]`).textContent(), /cleanup: applying/);

  await waitFor(async () => (await page.locator(`[data-cleanup-chip="${PROJECT}"]`).textContent()).includes("dropped"), { what: "the done label", timeoutMs: 60_000 });
  const label = (await page.locator(`[data-cleanup-chip="${PROJECT}"]`).textContent()).trim();
  assert.equal(label, "cleanup: 1 dropped · 1 merged");
  assert.match(await page.locator(`[data-cleanup-chip="${PROJECT}"]`).getAttribute("class"), /is-done/);

  // The landed tree and its branch are gone; the turnover branch and the two trees the plan kept are not.
  assert.equal(existsSync(fixture.landed), false, "the landed worktree was removed");
  assert.equal(ran(fixture.repo, "rev-parse", "--verify", "refs/heads/wtgui/landed"), false, "and so was its branch");
  assert.equal(existsSync(fixture.rollup), true, "the turnover tree stays");
  assert.equal(ran(fixture.repo, "rev-parse", "--verify", `refs/heads/${TURNOVER}`), true, "and so does its branch");
  assert.equal(existsSync(fixture.ahead), true, "the merged branch's tree stays");
  const children = git(fixture.repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/cleanup/").split("\n").filter(Boolean);
  assert.equal(children.length, 1, `one child for the one merged branch, got ${children.join(", ")}`);
  assert.match(children[0], /^cleanup\/wtgui-ahead-\d{8}-\d{4}-/);
  const parents = git(fixture.repo, "rev-list", "--parents", "-n", "1", children[0]).split(" ");
  assert.equal(parents.length, 3, "a --no-ff merge commit with two parents");

  // The apply's page says what it did, and it is the page the chip opened last.
  const reports = readdirSync(path.join(fixture.repo, "docs", "reports")).filter((f) => f.endsWith(".html"));
  const latest = readFileSync(path.join(fixture.repo, "docs", "reports", reports.sort().pop()), "utf8");
  assert.match(latest, /This run APPLIED the plan/);
  assert.match(latest, /merged --no-ff into cleanup\/wtgui-ahead/);
  assert.equal(openFileCalls.length, 2, "the chip opened the apply's page too");

  await page.locator(`section.project[data-project="${PROJECT}"] .project-head.meta-line`).screenshot({ path: path.join(SHOTS, "3-done-chip.png") });
});

test("the page raised no error while the chip ran", () => {
  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(" | ")}`);
  assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join(" | ")}`);
});
