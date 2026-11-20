// test/e2e/cleanup-drop-all.spec.mjs - the cleanup chip's "drop all N suggested" button, in a real browser.
//
// WHAT THIS PROVES, at 1440x900, on a real project with real worktrees:
//
//   1. THE BUTTON IS THERE, beside the cleanup chip, reading the plan's own count ("drop all 4 suggested"), and the
//      chip is still the last pill of the line.
//   2. THE CONFIRM names the exact count and every class it will not touch, its own button is focused, and Escape
//      would close it (asserted by closing one and opening it again).
//   3. THE RUN DROPS EXACTLY THE DROP ROWS. Three trees are removed from disk, their branches stay, and every row
//      the plan did not label drop is still on the board with its label unchanged - the merge row, the turnover row
//      and the primary checkout. The bar's rows are compared before and after, so "unchanged" is a comparison and
//      not a re-reading of the same assertion.
//   4. THE PLAN RE-READ IS REAL. One tree that the plan called drop is given an uncommitted file after the plan was
//      printed. The run must refuse it, by name, with the planner's own sentence, and leave the tree alone: the
//      button is never allowed to remove a tree the planner no longer calls drop.
//
//   RUN   node --test --test-reporter=spec test/e2e/cleanup-drop-all.spec.mjs
//         CLEANUP_DROP_ALL_SHOTS=<dir>   where the screenshots go (default: the run's scratch dir)
//
// THE PANEL IS THIS RUN'S OWN (tools/panel-testkit.mjs): a throwaway server on a spare port with its own store. The
// reader's live panel on 7331 is never started, restarted, read or written, and case 0 asserts the port.
//
// NOTHING OPENS A WINDOW. The chip opens its report through POST /api/open-file, which on this host would launch the
// reader's browser; that one route is intercepted and the request recorded instead.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { attachPageCollectors, loadPlaywright } from "../../tools/browser.mjs";
import { configureRepo, freePort, git, ran, slash, startPanel, waitFor } from "../../tools/panel-testkit.mjs";

const LIVE_PORT = 7331;
const PROJECT = "cleanup-drop-all-e2e";
const TURNOVER = "20261114_0930_DMR-1-rollup";
const SHOTS = path.resolve(process.env.CLEANUP_DROP_ALL_SHOTS || path.join(os.tmpdir(), "wtgui-cleanup-drop-all-shots"));

let fixture = null;
let panel = null;
let browser = null;
let page = null;
let pageErrors = [];
let consoleErrors = [];
let openFileCalls = [];

// One tree per class the plan can put on a row, plus one that is drop when the plan is read and is dirtied after.
function makeFixture() {
  const base = mkdtempSync(path.join(os.tmpdir(), "cleanup-drop-all-e2e-"));
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
  // A tree whose branch main was fast-forwarded onto: an ancestor proof, so the plan calls it drop.
  const landed = (name) => {
    const tree = cut(name, `wtgui/${name}`);
    writeFileSync(path.join(tree, `${name}.txt`), `${name} work\n`, "utf8");
    git(tree, "add", "-A");
    git(tree, "commit", "-qm", `${name} work`);
    git(repo, "merge", "--ff-only", "-q", `wtgui/${name}`);
    return tree;
  };

  const dropA = landed("drop-a");
  const dropB = landed("drop-b");
  const dropC = landed("drop-c");
  // The late one: clean and landed when the plan is read, given an uncommitted file before the button is pressed.
  const late = landed("late");

  // rollup: a turnover branch, fully merged - the one branch the plan must never delete.
  const rollup = cut("rollup", TURNOVER);
  writeFileSync(path.join(rollup, "rollup.txt"), "roll-up work\n", "utf8");
  git(rollup, "add", "-A");
  git(rollup, "commit", "-qm", "rollup work");
  git(repo, "merge", "--ff-only", "-q", TURNOVER);

  // ahead: one commit main does not have - the plan merges the branch into a child and keeps the tree.
  const ahead = cut("ahead", "wtgui/ahead");
  writeFileSync(path.join(ahead, "ahead.txt"), "work main lacks\n", "utf8");
  git(ahead, "add", "-A");
  git(ahead, "commit", "-qm", "ahead work");

  return { base, repo: slash(repo), dropA, dropB, dropC, late, rollup, ahead };
}

const keyOf = (p) => `${PROJECT}::${p}`;

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
  console.log(`      cleanup-drop-all spec: panel ${panel.base} (repo ${fixture.repo}), shots ${SHOTS}`);
  assert.match(panel.base, /^http:\/\/127\.0\.0\.1:\d+$/, "the panel is a loopback listener of this run");
  assert.equal((await fetch(`${panel.base}/api/health`)).status, 200, "and it is the panel this run started");
});

test.after(async () => {
  if (browser) await browser.close().catch(() => {});
  if (panel) await panel.stop();
  if (fixture) rmSync(fixture.base, { recursive: true, force: true });
});

// The browser half is one test, in order, because every step is the next step's precondition: the plan the button
// counts is the plan the run re-reads, and the rows it removes are the rows asserted gone afterwards.
test("the drop-all button reads the plan's count, drops only the drop rows, and refuses a row that changed", async () => {
  const PW = loadPlaywright();
  if (!PW) {
    console.log("      BROWSER-HALF-NOT-RUN: playwright is not on this machine, so the browser half did not run");
    return;
  }
  browser = await PW.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  ({ pageErrors, consoleErrors } = attachPageCollectors(page));
  // The report's opener would launch the reader's browser; the request is recorded instead. Only the POST is
  // recorded - the page also READS /api/open-file on load (which browser is registered), and that read opens nothing.
  await page.route("**/api/open-file", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    openFileCalls.push(JSON.parse(request.postData() || "{}"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, reused: false }) });
  });
  await page.goto(panel.base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(`section.project[data-project="${PROJECT}"] [data-cleanup-chip="${PROJECT}"]`, { state: "attached" });
  // A fresh panel draws the card folded, and a folded card hides the meta line the chip lives in.
  if (await page.locator(`section.project[data-project="${PROJECT}"]`).evaluate((el) => el.classList.contains("collapsed"))) {
    await page.click(`section.project[data-project="${PROJECT}"] .project-head[data-toggle-project] h2`);
  }
  await page.waitForSelector(`section.project[data-project="${PROJECT}"] .project-head.meta-line [data-cleanup-chip="${PROJECT}"]`, { state: "visible" });
  await page.waitForSelector(`tbody[data-tbody="${PROJECT}"] tr[data-key="${keyOf(fixture.dropA)}"]`, { state: "attached" });

  // ---- 1. the plan, read by the chip's own dry run --------------------------------------------------------------
  await page.click(`[data-cleanup-chip="${PROJECT}"]`);
  await waitFor(async () => (await page.locator(`[data-cleanup-chip="${PROJECT}"]`).textContent()).includes("apply"), {
    what: "the chip to come back armed",
    timeoutMs: 40_000,
  });
  assert.equal((await page.locator(`[data-cleanup-chip="${PROJECT}"]`).textContent()).trim(), "cleanup: 4 to drop, 1 to merge · apply");

  // THE BUTTON, beside the chip, with the plan's count on it. Scoped to the head line: the bar the chip opens draws
  // the same button in its action row, from the same renderer, and this is the one the reader presses from the strip.
  const headBtn = `section.project[data-project="${PROJECT}"] .project-head.meta-line [data-cleanup-drop-all="${PROJECT}"]`;
  const btn = page.locator(headBtn);
  await btn.waitFor({ state: "visible" });
  assert.equal((await btn.textContent()).trim(), "drop all 4 suggested", "the number is the drop rows and nothing else");
  assert.equal(await btn.isDisabled(), false, "four rows to drop, so the button is pressable");
  const line = await page.evaluate((name) => {
    const head = document.querySelector(`section.project[data-project="${name}"] .project-head.meta-line`);
    const buttons = Array.from(head.querySelectorAll("button"));
    const drop = head.querySelector(`[data-cleanup-drop-all="${name}"]`);
    const chip = head.querySelector(`[data-cleanup-chip="${name}"]`);
    return {
      last: buttons[buttons.length - 1] === chip,
      dropBeforeChip: buttons.indexOf(drop) === buttons.indexOf(chip) - 1,
      dropHeight: Math.round(drop.getBoundingClientRect().height),
      chipHeight: Math.round(chip.getBoundingClientRect().height),
    };
  }, PROJECT);
  assert.equal(line.dropBeforeChip, true, "the button sits immediately to the left of the cleanup chip");
  assert.equal(line.last, true, "and the cleanup chip is still the last pill of the line");
  assert.equal(line.dropHeight, line.chipHeight, "the button is the chip's own pill height");

  // The plan's labels, row by row, captured BEFORE the run so "unchanged" is a comparison.
  const planRows = async () =>
    page.evaluate((name) => {
      const bar = document.querySelector(`[data-cleanup-bar="${name}"]`);
      if (!bar) return null;
      return Array.from(bar.querySelectorAll("[data-cleanup-row]")).map((row) => ({
        path: row.getAttribute("data-cleanup-row"),
        who: row.querySelector(".cleanup-verdict")?.textContent.trim() || "",
        call: row.querySelector(".cleanup-call")?.textContent.trim() || "",
        why: row.querySelector(".cleanup-why")?.textContent.trim() || "",
      }));
    }, PROJECT);
  const boardRows = async () =>
    page.evaluate((name) => {
      const tbody = document.querySelector(`tbody[data-tbody="${name}"]`);
      return Array.from(tbody.querySelectorAll("tr[data-key]")).map((tr) => ({
        key: tr.getAttribute("data-key"),
        badge: tr.querySelector(".badge")?.textContent.trim() || "",
      }));
    }, PROJECT);
  // A row's verdict is read by the scan; until that read lands it shows the cached marker. The comparison of labels
  // is only meaningful once every row has been read, so the capture waits for that rather than racing the scan.
  const settle = async (count) =>
    waitFor(async () => {
      const rows = await boardRows();
      return rows.length === count && rows.every((r) => r.badge && r.badge !== "\u2026");
    }, { what: `every board row's verdict to be read (${count} rows)`, timeoutMs: 60_000 });

  const before = await planRows();
  assert.equal(before.length, 7, "one bar row per worktree: four drop, one merge, one turnover, plus the primary");
  const dropPaths = [fixture.dropA, fixture.dropB, fixture.dropC, fixture.late];
  for (const p of dropPaths) {
    const row = before.find((r) => r.path === p);
    assert.ok(row, `the plan lists ${p}`);
    assert.equal(row.call, "drop", `${path.basename(p)} is labelled drop`);
    assert.equal(row.who, "remove", `${path.basename(p)} carries the plan's remove verdict`);
  }
  const notDrop = before.filter((r) => !dropPaths.includes(r.path));
  assert.equal(notDrop.length, 3, "two kept rows (merge, turnover) plus the primary checkout");
  for (const row of notDrop) assert.equal(row.call, "keep", `${path.basename(row.path)} is not labelled drop`);
  await settle(7);
  const boardBefore = await boardRows();
  assert.equal(boardBefore.length, 7, "the board draws a row per tree, the primary checkout included");

  await page.screenshot({ path: path.join(SHOTS, "1-armed-1440x900.png") });
  await page.locator(`section.project[data-project="${PROJECT}"] .project-head.meta-line`).screenshot({ path: path.join(SHOTS, "1b-head-line-with-button.png") });

  // ---- 2. the tree that changes between the plan and the press --------------------------------------------------
  // `late` was clean and landed a moment ago. An uncommitted file is exactly what lib/cleanup-plan.js refuses to call
  // drop, and it is the one thing that can happen between the plan being printed and the button being pressed.
  writeFileSync(path.join(fixture.late, "sudden.txt"), "work in progress\n", "utf8");
  assert.equal(git(fixture.late, "status", "--porcelain").trim(), "?? sudden.txt", "the late tree is dirty now");

  // ---- 3. the press, the confirm, and the run ------------------------------------------------------------------
  await btn.click();
  const confirm = page.locator(`[data-cleanup-confirm="${PROJECT}"]`);
  await confirm.waitFor({ state: "visible" });
  assert.equal(
    (await confirm.locator(".cleanup-confirm-text").textContent()).trim(),
    "4 worktrees will be removed; 1 merge row, 1 keep row and 1 left-alone row are not touched.",
    "the confirm names the count and every class it will not touch",
  );
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-cleanup-confirm-go") || "");
  assert.equal(focused, PROJECT, "the confirm's own button is focused, so the gesture works from the keyboard");
  await page.screenshot({ path: path.join(SHOTS, "2-confirm-1440x900.png") });

  // Escape closes it without writing anything, and the button opens it again: nothing was removed by either press.
  await page.keyboard.press("Escape");
  await confirm.waitFor({ state: "detached" });
  assert.equal(existsSync(fixture.dropA), true, "Escape removed nothing");
  await btn.click();
  await confirm.waitFor({ state: "visible" });

  // The chip's own dry-run press opens its page through the panel's opener; that is the chip, not this button. The
  // number is recorded here so the assertion at the end is about what the DROP-ALL asked for, not about the chip.
  const opensBefore = openFileCalls.length;
  assert.ok(opensBefore >= 1, "the recorder works: the chip's dry run asked the panel to open its page");

  await confirm.locator(`[data-cleanup-confirm-go="${PROJECT}"]`).click();
  const result = page.locator(`[data-cleanup-drop-all-result="${PROJECT}"]`);
  await result.waitFor({ state: "attached", timeout: 90_000 });
  await confirm.waitFor({ state: "detached" });

  // ---- 4. what the run says ------------------------------------------------------------------------------------
  assert.equal(
    (await result.locator(".mono").first().textContent()).trim(),
    "dropped 3 of 4; 1 row was refused",
    "three rows went, and the fourth was refused rather than counted as dropped",
  );
  const failures = result.locator("[data-cleanup-drop-all-failure]");
  assert.equal(await failures.count(), 1, "exactly one row was refused, and it is listed");
  const failureText = (await failures.first().textContent()).replace(/\s+/g, " ").trim();
  assert.match(failureText, /late/, "the refused row is named");
  assert.match(
    failureText,
    /uncommitted/i,
    `the reason is the planner's own sentence about the uncommitted file, got: ${failureText}`,
  );

  // ---- 5. what the disk holds ----------------------------------------------------------------------------------
  // THE DROP ROWS ARE GONE: three trees removed, and only those three.
  assert.equal(existsSync(fixture.dropA), false, "drop-a's worktree was removed");
  assert.equal(existsSync(fixture.dropB), false, "drop-b's worktree was removed");
  assert.equal(existsSync(fixture.dropC), false, "drop-c's worktree was removed");
  // Their branches stay: the run removes trees, it never deletes a branch.
  for (const name of ["drop-a", "drop-b", "drop-c"]) {
    assert.equal(ran(fixture.repo, "rev-parse", "--verify", `refs/heads/wtgui/${name}`), true, `the ${name} branch is still there`);
  }
  // EVERY NON-DROP ROW IS STILL THERE.
  assert.equal(existsSync(fixture.late), true, "the refused tree is still on disk, with its work in it");
  assert.equal(existsSync(path.join(fixture.late, "sudden.txt")), true, "and its uncommitted file is untouched");
  assert.equal(existsSync(fixture.ahead), true, "the merge row's tree is still there");
  assert.equal(existsSync(fixture.rollup), true, "the turnover row's tree is still there");
  assert.equal(existsSync(fixture.repo), true, "the primary checkout is still there");
  assert.equal(git(fixture.repo, "for-each-ref", "refs/heads/cleanup/").trim(), "", "the run merged nothing: it only drops");

  // ---- 6. the board and the bar, after -------------------------------------------------------------------------
  const chipLabel = (await page.locator(`[data-cleanup-chip="${PROJECT}"]`).textContent()).trim();
  assert.equal(chipLabel, "cleanup: 1 to merge · apply", `the chip is redrawn from the state after the run, got ${chipLabel}`);
  const btnAfter = page.locator(headBtn);
  assert.equal((await btnAfter.textContent()).trim(), "nothing to drop", "with no drop rows left the button says so");
  assert.equal(await btnAfter.isDisabled(), true, "and is not pressable");

  // The rows that are left are the rows that were not drop: three trees plus the primary, and the refused one.
  await waitFor(async () => (await boardRows()).length === 4, { what: "the removed rows to leave the board", timeoutMs: 60_000 });
  await settle(4);
  const boardAfter = await boardRows();
  for (const p of [fixture.dropA, fixture.dropB, fixture.dropC]) {
    assert.equal(boardAfter.some((r) => r.key === keyOf(p)), false, `the board row for ${path.basename(p)} is gone`);
  }
  const stillThere = [fixture.ahead, fixture.rollup, fixture.repo];
  for (const p of stillThere) {
    const was = boardBefore.find((r) => r.key === keyOf(p));
    const now = boardAfter.find((r) => r.key === keyOf(p));
    assert.ok(now, `the board row for ${path.basename(p)} is still there`);
    assert.equal(now.badge, was.badge, `${path.basename(p)} still reads ${was.badge}, its label unchanged`);
  }
  // The bar, redrawn from the post-run plan: the drop rows are gone from it too, and every row that is not a drop row
  // reads exactly the call it read before.
  const after = await planRows();
  assert.equal(after.filter((r) => dropPaths.includes(r.path)).length, 1, "only the refused tree is still on the list");
  for (const was of notDrop) {
    const now = after.find((r) => r.path === was.path);
    assert.ok(now, `${path.basename(was.path)} is still listed`);
    assert.equal(now.call, was.call, `${path.basename(was.path)} still reads ${was.call}`);
    assert.equal(now.who, was.who, `${path.basename(was.path)} still reads verdict ${was.who}`);
    assert.equal(now.why, was.why, `${path.basename(was.path)}'s reason is unchanged`);
  }
  // The refused row is the one row whose call moved, and it moved because the plan was re-read: it is kept now.
  const lateRow = after.find((r) => r.path === fixture.late);
  assert.equal(lateRow.call, "keep", "the dirtied tree is kept by the fresh plan");

  // The run leaves a page, and it is the state after the run: the removed trees are not on it.
  const reports = readdirSync(path.join(fixture.repo, "docs", "reports"));
  assert.ok(reports.length >= 1, "the run left a plan page in the target repo");
  const pageText = readFileSync(path.join(fixture.repo, "docs", "reports", reports[reports.length - 1]), "utf8");
  for (const name of ["drop-a", "drop-b", "drop-c"]) {
    // The project name contains the string "drop-a" (cleanup-drop-all-e2e), so the check is on the tree path.
    assert.equal(pageText.includes(`.worktrees/${name}`), false, `the page written after the run does not list the ${name} tree`);
  }
  assert.equal(pageText.includes(".worktrees/late"), true, "and it does list the tree that was refused, with its reason");
  assert.match(pageText, /0 to drop, 1 to merge/, "the page's own counts are the state after the run");

  await page.screenshot({ path: path.join(SHOTS, "3-after-1440x900.png"), fullPage: true });

  // Nothing in the page threw, and no request failed.
  assert.deepEqual(pageErrors, [], `the page threw: ${pageErrors.join(" | ")}`);
  const realConsole = consoleErrors.filter((line) => !/favicon|api\/open-file/i.test(line));
  assert.deepEqual(realConsole, [], `the page logged: ${realConsole.join(" | ")}`);
  assert.equal(openFileCalls.length, opensBefore, "the drop-all never opens anything: no window was asked for");
});
