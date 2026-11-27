// tools/verify-legend.mjs - the worktree chart's legend as a disclosure, proved in a real browser.
//
//   node tools/verify-legend.mjs
//   PANEL_SHOTS_DIR=docs/assets/legend-disclosure node tools/verify-legend.mjs
//
// WHAT THIS IS. The legend under every chart used to be ONE dense paragraph: the five liveness chips, the age
// number and its ring, the kind column's three letters and the fold, all at once. This harness proves the shape
// that replaced it:
//
//   COLLAPSED  the strip is ONE line that does not wrap at the live width. It carries every symbol with its short
//              word (hermes, claude, board, port, files, T, R, I, fold) and ONE control whose visible label says
//              what it is ("what these mean"), which declares aria-expanded and points aria-controls at the popover.
//   EXPANDED   a small popover anchored UNDER the strip, not in the page's flow, carrying the same words as short
//              lines under three headings: liveness evidence, the kind column, folding. No sentence of the old
//              block is missing - the harness compares the popover's whole text against every clause.
//   KEYBOARD   Enter and Space open it, Escape closes it and leaves focus on the control (with the :focus-visible
//              ring), an outside press closes it, and the open popover covers none of the chart's tree rows and
//              does not move them.
//
// The panel under test is a SECOND instance on a port the OS says is free (tools/panel-testkit.mjs), with its own
// throwaway state dir; the fixture is the same five-row git sandbox the Kind column's gate photographs, plus a
// filler project BELOW it so the expanded popover has real page room under the strip in the shot.
//
// The two shots the landing reports name are written to docs/assets/legend-disclosure/ (or PANEL_SHOTS_DIR) at
// 1440x900, headless. The harness prints its own cleanup ledger: the panel's pid and port, its stop, the port
// read free, and a scan for a surviving node process carrying this sandbox's path.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright } from "./browser.mjs";
import { ROOT, git, startPanel, waitFor, waitForState } from "./panel-testkit.mjs";
import { buildKindFixture } from "./kind-fixture.mjs";

let checks = 0;
let failures = 0;
const check = (name, got, want) => {
  checks += 1;
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (!same) failures += 1;
  console.log(`${same ? "PASS" : "FAIL"}  ${name}${same ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` - ${extra}` : ""}`);
  }
};
const note = (text) => console.log(`      ${text}`);

const pw = loadPlaywright();
if (!pw) {
  console.log("BROWSER-NOT-RUN  the legend was not driven in a browser.");
  console.log("  re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-legend.mjs");
  process.exit(2);
}

// ---- the sandbox: the Kind column's five rows, then two projects BELOW them ------------------------------------
// The fillers are created FIRST because the board orders projects by most recent activity, so the chart under
// test - built last - sorts to the top and the fillers' tall, open cards give the expanded popover real page room
// under the strip instead of the footer's edge.
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-legend-"));
const fillerRepos = [];
for (const name of ["zzz-filler-a", "zzz-filler-b"]) {
  const repo = path.join(dir, "repos", name);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(repo, "README.md"), `# ${name}\n`, "utf8");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "seed the filler project"]);
  for (const n of [1, 2, 3]) git(repo, ["worktree", "add", "-q", "-b", `wtgui/${name}-${n}`, path.join(repo, ".worktrees", `${name}-${n}`)]);
  fillerRepos.push(repo);
}
const fx = buildKindFixture(dir);

const shotsDir = process.env.PANEL_SHOTS_DIR ? path.resolve(process.env.PANEL_SHOTS_DIR) : path.join(ROOT, "docs", "assets", "legend-disclosure");
mkdirSync(shotsDir, { recursive: true });

const panel = await startPanel({
  dir,
  config: {
    branchParentsFile: fx.bookFile,
    sameRepoScan: true,
    scanMode: "all",
    defaultCwd: fx.repo,
    refreshSeconds: 3600,
    worktreeSeconds: 2,
    midSeconds: 8,
    dormantSeconds: 15,
    slowSeconds: 20,
    fetchSeconds: 3600,
    threads: 1,
    apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
    assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
  },
});
const started = { pid: panel.pid, port: panel.port, dir };
note(`panel pid ${panel.pid} on free port ${panel.port}, state dir ${panel.dir}`);
note(`config ${panel.configPath}`);
if (fillerRepos.length) note(`filler projects below the chart: ${fillerRepos.length}`);

const PROJECT = "kind-repo";
const BTN = `section.project[data-project="${PROJECT}"] .legend [data-legend-toggle]`;
const rowsOf = (snap) => (snap.projects || []).flatMap((p) => p.worktrees || []);

let browser = null;
let shots = 0;
let stopSentAt = null;
let exitConfirmedIn = null;
const shoot = async (page, label) => {
  shots += 1;
  const file = path.join(shotsDir, `${String(shots).padStart(2, "0")}-${label}.png`);
  await page.screenshot({ path: file, animations: "disabled" });
  note(`shot ${file}`);
  return file;
};

// Put the legend's own box at `top` px in the viewport, whichever element actually scrolls: the window on a short
// page, or `main` (the board's own scroll container) when the popover's overflow makes main taller than its box.
const placeLegend = (page, top) =>
  page.evaluate(([project, want]) => {
    const legend = document.querySelector(`section.project[data-project="${project}"] .legend`);
    if (!legend) return null;
    const main = document.querySelector("main");
    const docScrolls = document.scrollingElement.scrollHeight > window.innerHeight + 2;
    const mainScrolls = main && main.scrollHeight > main.clientHeight + 2;
    const scroller = docScrolls || !mainScrolls ? document.scrollingElement : main;
    const from = scroller === document.scrollingElement ? window.scrollY : scroller.scrollTop;
    const delta = legend.getBoundingClientRect().top - want;
    if (scroller === document.scrollingElement) window.scrollTo(0, Math.max(0, from + delta));
    else scroller.scrollTop = Math.max(0, from + delta);
    const b = legend.getBoundingClientRect();
    return { top: Math.round(b.top), left: Math.round(b.left), width: Math.round(b.width), scrollY: Math.round(window.scrollY), mainTop: Math.round(main?.scrollTop || 0) };
  }, [PROJECT, top]);

const legendMetrics = (page) =>
  page.evaluate((project) => {
    const section = document.querySelector(`section.project[data-project="${project}"]`);
    const legend = section?.querySelector(".legend");
    if (!legend) return null;
    const line = legend.querySelector(".legend-line");
    const keys = legend.querySelector(".legend-keys");
    const btn = legend.querySelector("[data-legend-toggle]");
    const pop = legend.querySelector("[data-legend-pop]");
    const rect = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      const n = (v) => Math.round(v * 10) / 10;
      return { x: n(b.x), y: n(b.y), w: n(b.width), h: n(b.height), top: n(b.top), bottom: n(b.bottom), left: n(b.left), right: n(b.right) };
    };
    const rows = [...section.querySelectorAll("tbody tr.row")];
    return {
      line: rect(line),
      legend: rect(legend),
      keys: rect(keys),
      keysOverflow: keys ? keys.scrollWidth - keys.clientWidth : null,
      lineOverflow: line ? line.scrollWidth - line.clientWidth : null,
      keyTexts: [...keys.children].map((el) => el.textContent.replace(/\s+/g, " ").trim()),
      keyTops: [...keys.children].map((el) => Math.round(el.getBoundingClientRect().top)),
      btn: btn
        ? {
            ...rect(btn),
            text: btn.textContent.replace(/\s+/g, " ").trim(),
            expanded: btn.getAttribute("aria-expanded"),
            controls: btn.getAttribute("aria-controls"),
            tag: btn.tagName.toLowerCase(),
            focusVisible: btn.matches(":focus-visible"),
            outline: `${getComputedStyle(btn).outlineStyle} ${getComputedStyle(btn).outlineWidth}`,
            focused: document.activeElement === btn,
          }
        : null,
      pop: pop
        ? {
            ...rect(pop),
            hidden: pop.hidden,
            id: pop.id,
            text: pop.textContent.replace(/\s+/g, " ").trim(),
            headings: [...pop.querySelectorAll("h4")].map((h) => h.textContent.trim()),
            paras: [...pop.querySelectorAll("p")].map((p) => p.textContent.replace(/\s+/g, " ").trim()),
            groups: pop.querySelectorAll(".legend-group").length,
          }
        : null,
      rows: rows.map((r) => rect(r)),
      rowCount: rows.length,
      section: rect(section),
    };
  }, PROJECT);

let pageErrors = [];

try {
  // ---- 1. the board, with the chart this legend belongs to -----------------------------------------------------
  let snap;
  try {
    snap = await waitForState(
      panel.base,
      (s) => rowsOf(s).length >= 5 && rowsOf(s).some((r) => String(r.path || "").replace(/\\/g, "/").toLowerCase().endsWith(String(fx.suffixes.child).toLowerCase())),
      "the sandbox repo and its four trees",
      { timeout: 120_000 },
    );
  } catch (err) {
    const seen = await (await fetch(`${panel.base}/api/state`)).json().catch(() => ({}));
    note(`the snapshot when the wait gave up: ${JSON.stringify(rowsOf(seen).map((r) => [String(r.path || "").split(/[\\/]/).pop(), r.verdict]))}`);
    throw err;
  }
  ok("the scan found the fixture's trees", rowsOf(snap).length >= 5);

  browser = await pw.chromium.launch({ headless: true }).catch(async (err) => {
    if (!/Executable doesn't exist|headless[_-]shell/i.test(String((err && err.message) || err))) throw err;
    console.log("BROWSER  the headless shell binary is not installed - launching the full chromium build instead");
    return pw.chromium.launch({ headless: true, channel: "chromium" });
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${String((e && e.message) || e)}`));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
  });
  await page.goto(panel.base, { waitUntil: "domcontentloaded" });
  await waitFor(async () => (await page.locator("section.project[data-project]").count()) >= 3, { timeoutMs: 60_000, what: "the projects on the board" });
  // The folder starts open; every project starts folded, so open each one the way a reader does. The fillers below
  // the chart are opened too: their rows are the page room the expanded popover needs under the strip.
  for (const projectHead of await page.locator("section.project > .project-head[data-toggle-project]").all()) {
    const section = projectHead.locator("xpath=..");
    const sectionClass = await section.getAttribute("class");
    if (sectionClass && sectionClass.includes("collapsed")) await projectHead.click();
  }
  note(`the board's project order: ${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll("section.project[data-project]")].map((s) => s.dataset.project)))}`);
  await page.waitForSelector(`section.project[data-project="${PROJECT}"] .legend`, { timeout: 30_000 });
  const rowCount = await waitFor(async () => (await page.locator(`section.project[data-project="${PROJECT}"] tbody tr.row`).count()) >= 4, { timeoutMs: 45_000, what: "the chart's tree rows" });
  ok("the chart draws the fixture's tree rows", rowCount);

  // ---- 2. COLLAPSED: one line, every symbol and short word, one labelled control -------------------------------
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(250);
  const atRest = await legendMetrics(page);
  ok("the legend exists under the chart", Boolean(atRest));

  check("the collapsed strip carries every symbol with its short word, in one run", atRest.keyTexts, [
    "⧉ hermes",
    "⧉ claude",
    "● board",
    ":port",
    "✎ files",
    "T",
    "R",
    "I",
    "▾ fold",
  ]);
  const tops = [...new Set(atRest.keyTops)];
  ok("the strip is ONE line: every key sits on it and the line is a single row", atRest.line.h <= 30 && Math.max(...tops) - Math.min(...tops) <= 6, `key tops ${JSON.stringify(atRest.keyTops)}, line ${atRest.line.h}px`);
  ok("...and it does not wrap or clip at 1440: the keys fit their box", atRest.lineOverflow === 0 && atRest.keysOverflow === 0, `line overflow ${atRest.lineOverflow}px, keys overflow ${atRest.keysOverflow}px`);
  ok("the one control says what it is, in visible words", atRest.btn && atRest.btn.tag === "button" && /what these mean/.test(atRest.btn.text), atRest.btn ? `${atRest.btn.w}x${atRest.btn.h} "${atRest.btn.text}"` : "no control");
  check("...and it declares its state and what it controls", [atRest.btn?.expanded, atRest.btn?.controls], ["false", atRest.pop?.id]);
  ok("the popover is closed at rest", atRest.pop?.hidden === true && atRest.pop.h === 0, JSON.stringify({ hidden: atRest.pop?.hidden, h: atRest.pop?.h }));

  // ---- 3. the popover's copy is the old block's copy, as short lines under three headings ----------------------
  const pop = atRest.pop;
  check("the popover groups its lines under the three topics", pop?.headings, ["liveness evidence", "the kind column", "folding"]);
  ok("...as short lines, not one paragraph", pop?.groups === 3 && pop?.paras?.length >= 12, `${pop?.groups} groups, ${pop?.paras?.length} lines`);
  const CLAUSES = [
    "session active",
    "Claude Code session active",
    "live board PID",
    "dev server listening",
    "edited recently",
    "a row is live only if one of these fired",
    "the number is time since that last happened, the ring fills up to green as the row becomes due for its next read",
    "turnover tree (the feature container - research and implementation trees are cut from it, and an implementation tree's work merges back into it locally)",
    "research tree (local only - press the R to lift it)",
    "implementation tree (local only - press the I to lift it; a lifted tree keeps its letter with a tick)",
    "a tree cut from another one hangs under it, one indent in, and the ▾ on its parent folds the group out of sight",
    "a fold only hides, every chip and open panel stays as it was",
  ];
  const missing = CLAUSES.filter((c) => !String(pop?.text || "").includes(c));
  check("every sentence of the old block is carried, unchanged", missing, []);

  // ---- 4. the two shots: the strip at rest, then the legend open ---------------------------------------------
  const placedRest = await placeLegend(page, 380);
  await page.waitForTimeout(200);
  note(`legend placed for the collapsed shot: ${JSON.stringify(placedRest)}`);
  const beforeOpen = await legendMetrics(page);
  ok("the strip is fully on screen for the shot", beforeOpen.line.top >= 300 && beforeOpen.line.bottom <= 900, JSON.stringify(beforeOpen.line));
  const collapsedShot = await shoot(page, "collapsed-strip");

  // ---- 5. KEYBOARD: Enter opens, Escape closes and keeps focus, Space opens ----------------------------------
  await page.locator(BTN).focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(120);
  const opened = await legendMetrics(page);
  ok("Enter opens the popover", opened.pop?.hidden === false && opened.pop?.h > 40, JSON.stringify({ hidden: opened.pop?.hidden, h: opened.pop?.h }));
  check("...and aria-expanded follows", [opened.btn?.expanded, opened.pop?.hidden], ["true", false]);
  ok("...the control keeps the focus, with the :focus-visible ring drawn", opened.btn?.focused === true && opened.btn?.focusVisible === true && /solid/.test(opened.btn?.outline || "") && !/ 0px/.test(opened.btn?.outline || ""), JSON.stringify({ focused: opened.btn?.focused, focusVisible: opened.btn?.focusVisible, outline: opened.btn?.outline }));
  ok("the open popover is anchored BELOW the strip", opened.pop.y >= opened.line.bottom - 6, `pop top ${opened.pop.y}, strip bottom ${opened.line.bottom}`);
  const covered = opened.pop ? opened.rows.filter((r) => r && r.top < opened.pop.bottom && r.bottom > opened.pop.top && r.left < opened.pop.right && r.right > opened.pop.left) : [];
  check("...and covers none of the chart's tree rows", covered.length, 0);
  check("...and does not move them (it is not in the page's flow)", opened.rows.map((r) => Math.round(r.top)), beforeOpen.rows.map((r) => Math.round(r.top)));
  ok("...and the whole popover is on screen, not clipped by the board", opened.pop.bottom <= 900 && opened.line.top === beforeOpen.line.top, `pop ${opened.pop.y}..${opened.pop.bottom}, viewport 900, strip ${beforeOpen.line.top} -> ${opened.line.top}`);

  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);
  const escaped = await legendMetrics(page);
  ok("Escape closes it", escaped.pop?.hidden === true && escaped.btn?.expanded === "false");
  ok("...and leaves focus on the control that opened it", escaped.btn?.focused === true, JSON.stringify({ focused: escaped.btn?.focused }));

  await page.keyboard.press("Space");
  await page.waitForTimeout(120);
  const spaced = await legendMetrics(page);
  ok("Space opens it again", spaced.pop?.hidden === false && spaced.btn?.expanded === "true");

  // The expanded shot: the SAME scroll position as the collapsed one, so the pair differs in one thing.
  const placedOpen = await placeLegend(page, 380);
  await page.waitForTimeout(200);
  const openShot = await shoot(page, "expanded-legend");
  note(`legend placed for the expanded shot: ${JSON.stringify(placedOpen)}`);

  // ---- 6. an outside press closes it, and a second press on the control closes it ----------------------------
  // A press on the page's own background, clear of the popover and of every control: pressing a project head
  // would fold the card (and hide the legend under test) instead of proving the outside-press rule.
  await page.mouse.click(12, 880);
  await page.waitForTimeout(120);
  const outside = await legendMetrics(page);
  ok("a press outside the popover closes it", outside.pop?.hidden === true && outside.btn?.expanded === "false");

  await page.locator(BTN).click();
  await page.waitForTimeout(120);
  const clicked = await legendMetrics(page);
  ok("a press on the control opens it", clicked.pop?.hidden === false);
  await page.locator(BTN).click();
  await page.waitForTimeout(120);
  const clickedAgain = await legendMetrics(page);
  ok("...and a second press closes it", clickedAgain.pop?.hidden === true);

  // ---- 7. the strip still holds one line at a narrow live width ----------------------------------------------
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.waitForTimeout(250);
  const narrow = await legendMetrics(page);
  ok("at 1100 the strip is still one line and still unclipped", narrow.line.h <= 30 && Math.max(...narrow.keyTops) - Math.min(...narrow.keyTops) <= 6 && narrow.keysOverflow === 0, `line ${narrow.line.h}px, key tops ${JSON.stringify(narrow.keyTops)}, overflow ${narrow.keysOverflow}px`);
  await page.setViewportSize({ width: 1440, height: 900 });

  check("the page raised no errors", pageErrors, []);

  console.log(`\nRESULT  ${checks} checks, ${failures} failed`);
  console.log(`SHOTS   ${collapsedShot}`);
  console.log(`SHOTS   ${openShot}`);
} catch (err) {
  failures += 1;
  console.log(`FAIL  the harness stopped: ${String((err && err.stack) || err)}`);
  console.log(`\nRESULT  ${checks} checks, ${failures} failed`);
} finally {
  // ---- 8. the cleanup ledger: stop what this run started, then prove it is gone -------------------------------
  try {
    if (browser) await browser.close();
    browser = null;
  } catch (err) {
    failures += 1;
    console.log(`FAIL  the browser did not close: ${String((err && err.message) || err)}`);
  }
  stopSentAt = Date.now();
  try {
    await panel.stop();
    exitConfirmedIn = Date.now() - stopSentAt;
    console.log(`CLEANUP stopped the panel pid ${started.pid} on port ${started.port} with panel.stop() - exit confirmed in ${exitConfirmedIn} ms`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  the panel did not stop: ${String((err && err.message) || err)}`);
  }
  // The port, read FREE by binding it again.
  const portFree = await new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (e) => resolve({ free: false, code: e.code }));
    srv.listen(started.port, "127.0.0.1", () => srv.close(() => resolve({ free: true })));
  });
  ok(`port ${started.port} is free after the stop`, portFree.free === true, JSON.stringify(portFree));
  // The pid, read GONE.
  let alive = true;
  try {
    process.kill(started.pid, 0);
  } catch {
    alive = false;
  }
  ok(`panel pid ${started.pid} is gone`, alive === false);
  // Every node process whose command line names this sandbox. A child that outlived the panel would still carry
  // the config path, so this is the "no node child of the run survives" read.
  let survivors = null;
  try {
    const sandbox = path.basename(started.dir);
    const script = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${sandbox}*' } | Select-Object -ExpandProperty ProcessId`;
    const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 20_000, windowsHide: true }).trim();
    survivors = out ? out.split(/\s+/).filter(Boolean) : [];
  } catch (err) {
    note(`the node-process scan did not answer: ${String((err && err.message) || err)}`);
  }
  if (survivors === null) note("UNVERIFIED  no node child scan - the PowerShell read failed");
  else ok("no node process carrying this sandbox's state dir survives", survivors.length === 0, JSON.stringify(survivors));
  note(`shot files are under ${shotsDir}`);
  console.log(`\nRESULT-FINAL  ${checks} checks, ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
}
