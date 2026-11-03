// The chart's top-N collapse, proved by driving a panel of its own — and a real browser over it.
// HARNESS: LIVE GATE
//
//   PANEL_PLAYWRIGHT_ROOT=C:/ProjectDevelopment/heroes-js node tools/verify-chart-top-count.mjs
//
// A project's chart drew every tree it ever cut, so a long-lived board opened on rows nobody had touched in months. The
// chart now draws the TOP N (config.json `chartTopCount`, default 10, 0 draws every tree) and holds the rest behind one
// arrow at the bottom of that chart, whose label carries the real number ("show 16 more").
//
// WHAT "TOP" MEANS, AND WHY THIS SCRIPT IS BUILT THE WAY IT IS. Top is the first N rows of one total order: last
// activity, newest first, then by name. Not the order the server sent the rows in, and not the chart's live ranking —
// either would make the set a function of the scan's array index instead of the data. The fixture below exists to tell
// those apart: 25 worktrees are CREATED in name order (tree-01 .. tree-25), and their commit dates are a scrambled
// permutation of 0..24 days — the newest tree is tree-21 (0 days), not tree-25 (22 days) or tree-01 (5 days), and the
// creation order's first ten are not the ten that get drawn. Two trees (tree-10 and tree-25) share the age that
// straddles the top-10 boundary, so the NAME half of the rule has to decide which one is drawn and which one is held
// back. A selection by array index, by creation order, or by "the last 10 the scan happened to return" cannot pass
// this fixture; the expectations are written out by hand below rather than computed with the page's own comparator,
// so the script cannot agree with a bug it shares.
//
// Everything happens in a sandbox of its own: a throwaway repo with 25 hand-cut worktrees whose activity ages are
// known to the day, a throwaway HERMES_HOME, its own PANEL_CONFIG with its own port and logs, and an apiServer pointed
// at a dead port so nothing can reach the live gateway. The live panel and the live gateway are never touched, and
// the whole temp root is deleted at the end.
//
// WHAT IS DRIVEN, AND WHAT IS ONLY INSPECTED
//
//   driven        a config.json that still carries the retired hideOlderThanDays and no chartTopCount boots on 10
//                 (never 0), and names the ignored key in the settings sentence
//   driven        the setting: POST /api/settings/chart-top rewrites that ONE key in config.json (every other key is
//                 compared around it), the answer and /api/config agree, an unreadable value falls back to the
//                 default rather than to "off", an absurd one is clamped, and 0 is accepted as "no limit"
//   driven        the browser (Playwright, headless Chromium): 10 rows at the default and the 10 newest by activity
//                 (tree-10 in, tree-25 held — the boundary tie broken by name); the arrow's label says "show 16 more";
//                 hovering brings it up and its computed shape is a labelled pill, not the console chip's circle; one
//                 click draws the rest in the SAME order they were chosen; the choice is remembered in localStorage
//                 and survives a reload; the Settings control reads 10, writes 3 and the chart drops to 3 rows, Enter
//                 writes 12 and gives the field up, and the "all" preset writes 0, draws every row and takes the arrow
//                 away; a count larger than the list draws the whole list
//   driven        a second boot with NEITHER key: 10 by default, and the default is not written back to the file
//   inspected     that the slice is taken after the sort is read off the source (`chartTopSplit` in public/app.js
//                 sorts `all` and then slices it) as well as driven through the DOM
//
// The browser half needs a Playwright install. Point the script at one with PANEL_PLAYWRIGHT_ROOT (a directory holding
// node_modules/playwright, or the package itself); without one the script says BROWSER-HALF-NOT-RUN and exits 2
// rather than passing on a half that never ran.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, openSettingsGroup } from "./browser.mjs";
import { ROOT, freePort } from "./panel-testkit.mjs";

let failures = 0;
let checks = 0;
const check = (name, got, want) => {
  checks += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const note = (text) => console.log(`      ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 60_000, stepMs = 500, what = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let got = false;
    try {
      got = await fn();
    } catch {
      got = false;
    }
    if (got) return true;
    if (Date.now() > until) {
      console.log(`      (timed out after ${timeoutMs}ms waiting for ${what})`);
      return false;
    }
    await sleep(stepMs);
  }
}
const git = (dir, args, env = {}) => {
  try {
    return { ok: true, out: execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true, env: { ...process.env, ...env } }).trim() };
  } catch (e) {
    return { ok: false, out: String((e && e.stdout) || "").trim(), err: String((e && e.message) || e) };
  }
};
const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
// One clock for every stamped commit: two trees that share an age must land on the SAME second, or the "tie broken by
// name" case below becomes a millisecond race between two `Date.now()` calls.
const FIXTURE_NOW = Date.now();
const daysAgo = (n) => new Date(FIXTURE_NOW - n * 864e5).toISOString();

// ---- the fixture: creation order and activity order deliberately disagree -----------------------------------------
const PROJECT = "sandbox-repo";
const TREES = 25;
// AGE_DAYS[i] is the age, in days, of tree-(i+1)'s only commit. A permutation of 0..24 EXCEPT that 9 appears twice
// and 14 not at all: tree-10 and tree-25 are the pair that straddles the top-10 boundary. Creation order is
// tree-01..tree-25, so a selection by array index draws tree-01..tree-10 and this fixture fails it.
const AGE_DAYS = [5, 13, 20, 3, 11, 18, 1, 8, 16, 9, 23, 6, 14, 21, 4, 12, 19, 2, 10, 17, 0, 7, 15, 22, 9];
const treeName = (i) => `tree-${String(i + 1).padStart(2, "0")}`;
const treePath = (i) => path.join(repo, ".worktrees", treeName(i));

// The whole order, written out by hand: activity newest first, then name. tree-10 beats tree-25 on the 9-day tie.
const EXPECTED_ALL = [
  "tree-21", "tree-07", "tree-18", "tree-04", "tree-15", "tree-01", "tree-12", "tree-22", "tree-08", "tree-10",
  "tree-25", "tree-19", "tree-05", "tree-16", "tree-02", "tree-13", "tree-23", "tree-09", "tree-20", "tree-06",
  "tree-17", "tree-03", "tree-14", "tree-24", "tree-11", "sandbox-repo",
];
const TOP10 = EXPECTED_ALL.slice(0, 10);
const TOP3 = EXPECTED_ALL.slice(0, 3);
const TIE_WINNER = "tree-10"; // drawn: the 9-day tie broken by name against tree-25
const TIE_LOSER = "tree-25"; // held back

// ---- the sandbox -------------------------------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-chart-top-"));
const rootDir = path.join(dir, "scan-root");
const repo = path.join(rootDir, PROJECT);
const home = path.join(dir, "hermes-home");
const configDir = path.join(dir, "panel");
const shotsDir = path.join(dir, "shots");

for (const d of [repo, path.join(repo, ".worktrees"), home, configDir, shotsDir]) mkdirSync(d, { recursive: true });
const commit = (dirPath, message, env) => {
  git(dirPath, ["add", "-A"]);
  return git(dirPath, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", message], env);
};

git(repo, ["init", "-q", "-b", "main"]);
// `.worktrees/` is ignored so the project's own checkout has no untracked entry whose mtime would make the root row
// look like the newest activity on the board — the root is meant to sort last, 45 days back with its seed commit.
writeFileSync(path.join(repo, ".gitignore"), ".worktrees/\n", "utf8");
writeFileSync(path.join(repo, "README.md"), "# sandbox repo\n", "utf8");
commit(repo, "seed the sandbox repo", { GIT_AUTHOR_DATE: daysAgo(45), GIT_COMMITTER_DATE: daysAgo(45) });

for (let i = 0; i < TREES; i += 1) {
  const added = git(repo, ["worktree", "add", "-q", "-b", `work/${treeName(i)}`, treePath(i)]);
  if (!added.ok) throw new Error(`could not cut ${treeName(i)}: ${added.err}`);
  writeFileSync(path.join(treePath(i), "work.txt"), `${treeName(i)} was worked in\n`, "utf8");
  const made = commit(treePath(i), `work in ${treeName(i)}`, { GIT_AUTHOR_DATE: daysAgo(AGE_DAYS[i]), GIT_COMMITTER_DATE: daysAgo(AGE_DAYS[i]) });
  if (!made.ok) throw new Error(`could not commit in ${treeName(i)}: ${made.err}`);
}

// Deliberately NO chartTopCount key, and the RETIRED age key still in the file: the fallback to 10 and the ignored-key
// sentence are both part of what is proved. apiServer points at a dead port, so no phase can reach the live gateway.
const port = await freePort();
const configPath = path.join(configDir, "config.json");
const writeConfig = (extra = {}) =>
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        port,
        host: "127.0.0.1",
        scanRoots: [rootDir],
        refreshSeconds: 4,
        worktreeSeconds: 2,
        midSeconds: 8,
        dormantSeconds: 15,
        slowSeconds: 20,
        fetchSeconds: 3600,
        threads: 2,
        scanMode: "all",
        liveMinutes: 5,
        defaultCwd: repo,
        projectsCacheFile: path.join(configDir, "logs", "projects.json"),
        apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
        assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
        ...extra,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
writeConfig({ hideOlderThanDays: 7 });
const readConfigFile = () => JSON.parse(readFileSync(configPath, "utf8"));

const base = `http://127.0.0.1:${port}`;
const panelLog = [];
let panel = null;
const startPanel = async () => {
  panel = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: home, PANEL_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  panel.stdout.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  panel.stderr.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  const up = await waitFor(async () => (await fetch(`${base}/api/state`)).ok, { timeoutMs: 40_000, what: "the sandbox panel to answer /api/state" });
  if (!up) throw new Error(`the sandbox panel never came up on ${base}\n${panelLog.slice(-15).join("\n")}`);
};
const stopPanel = async () => {
  if (!panel) return;
  const p = panel;
  panel = null;
  p.kill();
  const gone = await waitFor(() => p.exitCode !== null || p.signalCode !== null, { timeoutMs: 15_000, what: "the panel to exit" });
  // A node process can outlive a polite kill on Windows, and its stdio pipes then hold THIS process's event loop open.
  if (!gone && p.pid) {
    try {
      execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* already gone */
    }
    await waitFor(() => p.exitCode !== null || p.signalCode !== null, { timeoutMs: 8_000, what: "the panel to be gone after taskkill" });
  }
  p.stdout?.destroy();
  p.stderr?.destroy();
  await sleep(300);
};
const api = async (route, body, method) => {
  const res = await fetch(`${base}${route}`, {
    method: method || (body ? "POST" : "GET"),
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const state = () => api("/api/state").then((r) => r.body);
const rows = async () => (await state()).projects?.find((p) => p.name === PROJECT)?.worktrees || [];
const ageDays = (iso) => Math.round((Date.now() - Date.parse(iso)) / 864e5);

// ---- the browser phase -------------------------------------------------------------------------------------------
async function browserPhase(pw) {
  const pageErrors = [];
  const consoleErrors = [];
  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
  // Harness setup, not part of what is asserted: a fresh browser has no remembered layout, so the sandbox project
  // would open collapsed and no chart would be on the page at all.
  await context.addInitScript((project) => {
    localStorage.setItem("wm.expandedProjects", JSON.stringify([project]));
  }, PROJECT);
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(String((e && e.message) || e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon/i.test(m.text())) consoleErrors.push(m.text());
  });

  const shot = async (name) => {
    const file = path.join(shotsDir, `${name}.png`);
    await page.screenshot({ path: file });
    return file;
  };
  const drawn = () => page.$$eval(`tbody[data-tbody="${PROJECT}"] tr.row`, (els) => els.map((tr) => tr.querySelector(".row-name")?.textContent || tr.dataset.key));
  const chips = () => page.$$eval(`[data-chips="${PROJECT}"] .chip`, (els) => els.map((e) => e.textContent.trim()));
  const focus = () => page.evaluate(() => (document.activeElement ? String(document.activeElement.id || document.activeElement.tagName) : null));
  const arrow = () =>
    page.evaluate((project) => {
      const b = document.querySelector(`section.project[data-project="${project}"] [data-age-toggle]`);
      if (!b) return null;
      const cs = getComputedStyle(b);
      return {
        label: b.textContent,
        pressed: b.getAttribute("aria-pressed"),
        opacity: cs.opacity,
        pointerEvents: cs.pointerEvents,
        title: b.title,
        width: cs.width,
        height: cs.height,
        radius: cs.borderTopLeftRadius,
      };
    }, PROJECT);
  const chart = `tbody[data-tbody="${PROJECT}"]`;
  const arrowSel = `section.project[data-project="${PROJECT}"] [data-age-toggle]`;

  await page.goto(base, { waitUntil: "domcontentloaded" });
  if (!(await waitFor(async () => (await drawn()).length > 0, { timeoutMs: 120_000, what: "the chart to draw its rows" }))) throw new Error("the sandbox chart never drew a row");

  console.log("\n== the default: the 10 newest rows, the rest behind one arrow ==");
  const atRest = await drawn();
  check("the default draws exactly 10 rows", atRest.length, 10);
  check("and they are the 10 newest by activity, not the 10 the fixture created first", atRest.slice().sort(), TOP10.slice().sort());
  ok("the boundary tie went to the name: tree-10 is drawn and tree-25 (same timestamp) is held", atRest.includes("tree-10") && !atRest.includes("tree-25"), atRest.join(" | "));
  ok("a chip on the project says how many are held back", (await chips()).includes("16 more hidden"), (await chips()).join(" | "));
  const atRestArrow = await arrow();
  ok("the arrow's label carries the real number", atRestArrow?.label === "↓ show 16 more", JSON.stringify(atRestArrow));
  ok("it is in the chart's legend, invisible, and takes no clicks", atRestArrow.opacity === "0" && atRestArrow.pointerEvents === "none", JSON.stringify(atRestArrow));
  ok("it is a labelled pill now, wider than the console chip's 21px circle", Number.parseFloat(atRestArrow.width) > 21 && atRestArrow.height === "21px", `${atRestArrow.width} x ${atRestArrow.height}`);
  ok("and its title names the order the held-back rows are in", /newest activity first, then by name/.test(atRestArrow.title), atRestArrow.title);
  note(`screenshot: ${await shot("1-default")}`);

  console.log("\n== hovering the chart brings the arrow up, in its own ink ==");
  await page.hover(chart);
  if (!(await waitFor(async () => ((await arrow()) || {}).opacity === "1", { what: "the arrow to appear while the chart is hovered" }))) throw new Error("the arrow never appeared on hover");
  const shown = await arrow();
  ok("the pointer over the chart makes the arrow visible and clickable", shown.opacity === "1" && shown.pointerEvents === "auto", JSON.stringify(shown));
  const ink = await page.evaluate(() => {
    const wrap = document.createElement("div");
    wrap.className = "out-wrap out-tab";
    wrap.style.cssText = "position:fixed;left:0;top:0;width:320px;height:80px;";
    wrap.innerHTML = `<pre class="job-out"></pre>${toBottomBtnHtml()}`;
    document.body.appendChild(wrap);
    const consoleChip = wrap.querySelector(".to-bottom");
    const chartChip = document.querySelector('section.project[data-project="sandbox-repo"] [data-age-toggle]');
    const pick = (el) => Object.fromEntries(["color", "backgroundColor", "fontSize"].map((k) => [k, getComputedStyle(el)[k]]));
    const out = { consoleInk: pick(consoleChip), chartInk: pick(chartChip), consoleGlyph: consoleChip.textContent };
    wrap.remove();
    return out;
  });
  ok("the console's own chip is still the bare glyph", ink.consoleGlyph === "↓", JSON.stringify(ink.consoleGlyph));
  ok(
    "the chart arrow's ink is still its own — brighter than the console chip's",
    ink.chartInk.color !== ink.consoleInk.color && ink.chartInk.backgroundColor !== ink.consoleInk.backgroundColor,
    `console ${JSON.stringify(ink.consoleInk)} vs chart ${JSON.stringify(ink.chartInk)}`,
  );
  note(`screenshot: ${await shot("2-arrow-on-hover")}`);

  console.log("\n== one click lists the rest, in the order they were chosen ==");
  await page.click(arrowSel);
  if (!(await waitFor(async () => (await drawn()).length === 26, { what: "the click to draw every row" }))) throw new Error("the held-back rows never came back");
  const expanded = await drawn();
  check("the held-back remainder is appended in the same order it was chosen in", expanded.slice(10), EXPECTED_ALL.slice(10));
  ok("the 'more hidden' chip is gone", !(await chips()).includes("16 more hidden"), (await chips()).join(" | "));
  const afterClick = await arrow();
  ok("the arrow turns up and names the count it will go back to", afterClick.label === "↑ show top 10" && afterClick.pressed === "true", JSON.stringify(afterClick));
  check("the choice is written down in this browser", await page.evaluate(() => JSON.parse(localStorage.getItem("wtgui.showOldProjects") || "[]")), [PROJECT]);
  note(`screenshot: ${await shot("3-shown-in-full")}`);

  console.log("\n== the per-project choice still survives a reload ==");
  await page.reload({ waitUntil: "domcontentloaded" });
  if (!(await waitFor(async () => (await drawn()).length === 26, { what: "the reloaded chart to still show every row" }))) throw new Error("the reload forgot which charts were showing everything");
  ok("after a reload the chart is still showing every row", (await drawn()).includes("tree-25"), (await drawn()).length);
  ok("and the panel's count after that reload is still 10", (await api("/api/config")).body.chartTopCount, 10);

  console.log("\n== the Settings control: 10 -> 3 -> 12, and 0 = every row ==");
  // Held back again first, so what the count does is decided by the count and not by this project's remembered choice.
  await page.hover(chart);
  await waitFor(async () => ((await arrow()) || {}).opacity === "1", { what: "the arrow on hover again" });
  await page.click(arrowSel);
  if (!(await waitFor(async () => (await drawn()).length === 10, { what: "the arrow to hold the rest back again" }))) throw new Error("the arrow did not hold the rest back");

  await openSettingsGroup(page, "board");
  check("the Settings tab carries the count, reading the panel's value", await page.inputValue("#chart-top-count"), "10");
  const preview = await page.textContent("#chart-top-preview");
  ok("its sentence says what the count does, where it lives, and that the retired key is ignored", /draw the top 10 worktrees of every chart/.test(preview) && /hideOlderThanDays, which is ignored now/.test(preview), preview);

  await page.fill("#chart-top-count", "3");
  await page.dispatchEvent("#chart-top-count", "change");
  await waitFor(() => readConfigFile().chartTopCount === 3, { what: "config.json to take 3" });
  check("saving 3 writes config.json", readConfigFile().chartTopCount, 3);
  await page.click("#btn-settings-close");
  if (!(await waitFor(async () => (await drawn()).length === 3, { what: "the chart to drop to 3 rows" }))) throw new Error("the new count did not reach the chart");
  check("the chart draws the top 3, and they are the newest 3", (await drawn()).slice().sort(), TOP3.slice().sort());
  const threeArrow = await arrow();
  ok("the arrow says how many are behind it now", threeArrow?.label === "↓ show 23 more", JSON.stringify(threeArrow));
  await page.hover(chart);
  await waitFor(async () => ((await arrow()) || {}).opacity === "1", { what: "the arrow on hover at 3" });
  await page.click(arrowSel);
  if (!(await waitFor(async () => (await drawn()).length === 26, { what: "the arrow to list all 26 rows at 3" }))) throw new Error("the rest never came back at 3");
  check("at 3 the rest are still listed in the same order after the top 3", (await drawn()).slice(3), EXPECTED_ALL.slice(3));
  // Held back again, so the "count past the list" and "no limit" phases below are decided by the count and not by this
  // project's remembered "show everything".
  await page.hover(chart);
  await waitFor(async () => ((await arrow()) || {}).opacity === "1", { what: "the arrow on hover at 3, showing all" });
  await page.click(arrowSel);
  if (!(await waitFor(async () => (await drawn()).length === 3, { what: "the arrow to hold the rest back again at 3" }))) throw new Error("the arrow did not hold the rest back at 3");

  console.log("\n== the box's other way out: Enter saves the count and gives the field up ==");
  await openSettingsGroup(page, "board");
  await page.fill("#chart-top-count", "12");
  await page.press("#chart-top-count", "Enter");
  let landed = null;
  const took = await waitFor(
    () => {
      try {
        landed = readConfigFile().chartTopCount;
      } catch {
        landed = null;
      }
      return landed === 12;
    },
    { what: "Enter to write 12" },
  );
  if (!took) throw new Error("Enter did not save the count");
  check("Enter in the count box writes the number to config.json, with no click anywhere else", landed, 12);
  ok("and the field gives the focus up, so what was typed is not left half-committed", (await focus()) !== "chart-top-count", `activeElement: ${await focus()}`);
  await page.click("#btn-settings-close");
  if (!(await waitFor(async () => (await drawn()).length === 12, { what: "the Entered count to reach the chart" }))) throw new Error("the Entered count never reached the chart");

  console.log("\n== a count larger than the list, and 0 (no limit) ==");
  const big = await api("/api/settings/chart-top", { count: 50 });
  check("POST /api/settings/chart-top answers 200", big.status, 200);
  check("...with the count it stored", big.body.count, 50);
  check("...and the settings the page redraws from", big.body.settings?.chartTopCount, 50);
  if (!(await waitFor(async () => (await drawn()).length === 26, { what: "a count past the list to draw every row" }))) throw new Error("a count past the list did not draw every row");
  ok("a count larger than the list draws every row", (await drawn()).includes("tree-05"), (await drawn()).length);
  ok("and there is no arrow left: nothing is behind it", (await arrow()) === null, JSON.stringify(await arrow()));

  await openSettingsGroup(page, "board");
  await page.click('[data-top-set="0"]');
  await waitFor(() => readConfigFile().chartTopCount === 0, { what: "config.json to take 0 (no limit)" });
  check("the 'all' preset writes 0 to config.json", readConfigFile().chartTopCount, 0);
  await page.click("#btn-settings-close");
  if (!(await waitFor(async () => (await drawn()).length === 26, { what: "every row to be drawn with no limit" }))) throw new Error("0 did not put every row back");
  ok("with no limit the chart draws every row", (await drawn()).includes("sandbox-repo"));
  ok("and there is no arrow left on the chart", (await arrow()) === null);

  check("no uncaught page errors", pageErrors, []);
  ok("no console errors", consoleErrors.length === 0, consoleErrors.join(" | "));
  await browser.close();
  return { shotDefault: path.join(shotsDir, "1-default.png"), shotHover: path.join(shotsDir, "2-arrow-on-hover.png"), shotShown: path.join(shotsDir, "3-shown-in-full.png") };
}

// ---- run ---------------------------------------------------------------------------------------------------------
try {
  await startPanel();

  console.log("== a config.json that still carries the retired key boots on 10, never 0 ==");
  const settings = (await api("/api/config")).body;
  check("the retired hideOlderThanDays is ignored: no chartTopCount key means 10", settings.chartTopCount, 10);
  check("and the page is told the legacy key is still there", settings.hideOlderDaysIgnored, true);
  ok("the file still has no chartTopCount key (the default is not written back on boot)", !("chartTopCount" in readConfigFile()), JSON.stringify(Object.keys(readConfigFile())));

  const scanned = await waitFor(
    async () => {
      const r = await rows();
      return r.length === TREES + 1 && r.every((x) => x.lastCommit && x.lastEdit);
    },
    { timeoutMs: 180_000, what: "all 26 rows to be scanned with their activity", stepMs: 700 },
  );
  ok("26 rows scanned (25 worktrees and the project's own checkout)", scanned, (await rows()).length);
  const rowFor = async (name) => (await rows()).find((r) => r.name === name) || null;
  // The fixture's ages, read back off the rows: this is the input the order is computed from, and it is asserted
  // independently of the order so a fixture that failed to stamp its commits cannot pass the order checks by accident.
  let agesOk = true;
  for (let i = 0; i < TREES; i += 1) {
    const row = await rowFor(treeName(i));
    if (!row || Math.abs(ageDays(row.lastEdit) - AGE_DAYS[i]) > 1) {
      agesOk = false;
      note(`${treeName(i)}: wanted ${AGE_DAYS[i]} days, got ${row ? ageDays(row.lastEdit) : "no row"}`);
    }
  }
  ok("every tree's last activity is the age the fixture stamped on its commit", agesOk);
  const rootRow = await rowFor(PROJECT);
  ok("the project's own checkout is 45 days old, so it sorts last", rootRow && ageDays(rootRow.lastEdit) >= 44, rootRow ? `${ageDays(rootRow.lastEdit)} days` : "no root row");

  console.log("\n== the setting writes one key of config.json, and reads back what it wrote ==");
  const before = readConfigFile();
  const saved = await api("/api/settings/chart-top", { count: 14 });
  check("POST /api/settings/chart-top answers 200", saved.status, 200);
  check("...with the count it stored", saved.body.count, 14);
  check("...and the settings the page redraws from", saved.body.settings?.chartTopCount, 14);
  check("config.json now says 14", readConfigFile().chartTopCount, 14);
  const after = readConfigFile();
  delete before.chartTopCount;
  delete after.chartTopCount;
  check("every other key in config.json is untouched (the retired key included)", after, before);
  check("and /api/config agrees", (await api("/api/config")).body.chartTopCount, 14);

  check("an unreadable value falls back to the default, not to 'off'", (await api("/api/settings/chart-top", { count: "not a number" })).body.count, 10);
  check("...and that is what the file says too", readConfigFile().chartTopCount, 10);
  check("a value past the cap is clamped", (await api("/api/settings/chart-top", { count: 99999 })).body.count, 5000);
  check("0 is accepted as 'no limit'", (await api("/api/settings/chart-top", { count: 0 })).body.count, 0);
  // Back to the default for the browser phase below, so the chart it drives is the one a reader gets on a fresh
  // install rather than an artefact of the clamping checks just above.
  check("and the count can be put back", (await api("/api/settings/chart-top", { count: 10 })).body.count, 10);

  console.log("\n== the browser: 10 at the default, 3, and a count past the list ==");
  const pw = loadPlaywright();
  let shots = null;
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  the client half of this change was not exercised in a browser.");
    note("re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-chart-top-count.mjs");
    failures += 1;
  } else {
    shots = await browserPhase(pw);
    if (shots?.shotDefault) note(`screenshots: ${shots.shotDefault} · ${shots.shotHover} · ${shots.shotShown}`);
  }

  console.log("\n== a second boot with neither key: 10 by default, and nothing written back ==");
  await stopPanel();
  writeConfig();
  await startPanel();
  const fresh = (await api("/api/config")).body;
  check("a file with neither key boots on 10", fresh.chartTopCount, 10);
  check("and says nothing is being ignored", fresh.hideOlderDaysIgnored, false);
  ok("neither key was written back to the file", !("chartTopCount" in readConfigFile()) && !("hideOlderThanDays" in readConfigFile()), JSON.stringify(Object.keys(readConfigFile())));

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed`);
  if (shots?.shotDefault) {
    console.log("\nWHAT WAS DRIVEN: a sandbox panel booted over a throwaway repo whose 25 worktrees have known activity");
    console.log("ages in an order that disagrees with their creation order (the default fallback from the retired key, the");
    console.log("setting's write-back and its clamping), and headless Chromium over the running panel (the top 10 at the");
    console.log("default with the name tiebreak at the boundary, the arrow's label and its labelled-pill shape, the click");
    console.log("listing the rest in the same order, the reload, the Settings control at 10 -> 3 -> 12, 0 = no limit, and a");
    console.log("count past the list).");
  }
  if (!failures) console.log("CHART-TOP-VERIFY-OK");
} catch (err) {
  failures += 1;
  console.log(`\nFAIL  the run threw: ${String((err && err.stack) || err)}`);
  if (panelLog.length) console.log(`--- panel log (tail)\n${panelLog.slice(-25).join("\n")}`);
} finally {
  // The panel is stopped either way: VERIFY_KEEP keeps the FILES for inspection, not a server on a scratch port.
  await stopPanel();
  if (process.env.VERIFY_KEEP === "1") {
    console.log(`VERIFY_KEEP=1 — leaving ${dir} in place`);
  } else {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch (e) {
      console.log(`      (could not remove ${dir}: ${String((e && e.message) || e)})`);
    }
  }
}
process.exitCode = failures ? 1 : 0;
