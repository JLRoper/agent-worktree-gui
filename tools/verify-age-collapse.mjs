// The chart's "older than N days" collapse, proved by driving a panel of its own — and a real browser over it.
//
//   PANEL_PLAYWRIGHT_ROOT=C:/ProjectDevelopment/heroes-js node tools/verify-age-collapse.mjs
//
// A project's chart drew every tree it ever cut, so a long-lived board opened on trees nobody had touched since
// spring. A row is now held out of the chart when its LAST ACTIVITY is older than `hideOlderThanDays` (config.json,
// default 7, 0 shows everything): the newest of its last commit, its last edited file, the last moment the panel saw
// it alive and any event received about its agents — never the age of the directory. The rows are still there: one
// arrow at the bottom of that project's chart shows every tree again. The arrow is the console's own little tail
// chip in everything but ink — the same 21px circle, the same glyph, the same fade — brighter, because it sits on
// the legend's dark strip rather than floating over a console. It is invisible until the pointer is over the chart,
// it is drawn only while that chart has something held back or is showing everything, and the threshold is written
// back by POST /api/settings/age, so it is the panel's own setting rather than this tab's. The per-project "show
// everything" choice is remembered in the browser (localStorage) — the reload phase below is what proves it, and it
// is the check that caught the loader reading its key below `state`: a const in its dead zone, a try/catch that
// swallowed the ReferenceError, and every reload quietly forgetting which charts the reader had opened up.
//
// Everything below happens in a sandbox of its own: a throwaway repo with three hand-cut worktrees whose ACTIVITY
// ages are known to the minute, a throwaway HERMES_HOME, its own PANEL_CONFIG with its own port and its own logs,
// and an apiServer pointed at a dead port so nothing anywhere can reach the live gateway. The live panel on 7331 and
// the live gateway on 8642 are never touched, and the whole temp root is deleted at the end.
//
// WHAT IS DRIVEN, AND WHAT IS ONLY INSPECTED
//
//   driven        the threshold's default: a config.json with no such key boots on 7 days (and still has no key)
//   driven        the rows carry the activity the client measures: a clean tree committed 45 days ago, a tree whose
//                 commit is 45 days old but whose last file edit was half an hour ago, and the project's own checkout
//   driven        the setting: POST /api/settings/age rewrites that ONE key in config.json (every other key is
//                 compared byte for byte around it), the answer and /api/config agree, an unreadable value falls
//                 back to the default rather than to "off", and an absurd one is clamped
//   driven        the browser (Playwright, headless Chromium): the chart at rest holds the 45-day-old tree back and
//                 says so in a chip, the arrow is there but invisible and takes no clicks, hovering the chart brings
//                 it up, its computed shape is the console chip's own, one click draws the held-back tree, the chip
//                 goes, the arrow turns up, the choice is written to localStorage, it survives a reload, the arrow
//                 holds the tree back again, the Settings control reads and writes the number, the chart redraws from
//                 it, and 0 puts every tree back and takes the arrow away
//   inspected     the arity of the filter itself: that the row a chart holds back is decided in the client
//                 (public/app.js `rowAgeHidden`) and never in the server's row set is read off the source, not
//                 measured — this script drives the client's decision through the DOM, which is the same thing
//                 one level down
//
// The browser half needs a Playwright install. Point the script at one with PANEL_PLAYWRIGHT_ROOT (a directory
// holding node_modules/playwright, or the package itself); without one the script says BROWSER-HALF-NOT-RUN and
// exits 2 rather than passing on a half that never ran.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, openSettingsGroup } from "./browser.mjs";
import { ROOT, pickFreePort as freePort } from "./panel-testkit.mjs";

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
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();

// ---- the sandbox ---------------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-age-collapse-"));
const rootDir = path.join(dir, "scan-root");
const repo = path.join(rootDir, "sandbox-repo");
const home = path.join(dir, "hermes-home");
const configDir = path.join(dir, "panel");
const shotsDir = path.join(dir, "shots");
const PROJECT = "sandbox-repo";
const TREE_RECENT = path.join(repo, ".worktrees", "worked-in-today");
const TREE_OLD = path.join(repo, ".worktrees", "committed-45-days-ago-and-left-alone");
const TREE_BUSY = path.join(repo, ".worktrees", "long-lived-but-being-worked-in");

for (const d of [repo, path.join(repo, ".worktrees"), home, configDir, shotsDir]) mkdirSync(d, { recursive: true });
const commit = (dirPath, message, env) => {
  git(dirPath, ["add", "-A"]);
  return git(dirPath, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", message], env);
};
const OLD = { GIT_AUTHOR_DATE: daysAgo(45), GIT_COMMITTER_DATE: daysAgo(45) };

git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# sandbox repo\n", "utf8");
commit(repo, "seed the sandbox repo", OLD);

// recent: a commit today, so its activity is minutes old.
git(repo, ["worktree", "add", "-q", "-b", "work/recent", TREE_RECENT]);
writeFileSync(path.join(TREE_RECENT, "recent.txt"), "worked in today\n", "utf8");
commit(TREE_RECENT, "do the recent work");

// old: everything about it is 45 days old, and the tree is clean (nothing to stat), so its activity is 45 days old.
git(repo, ["worktree", "add", "-q", "-b", "work/old", TREE_OLD]);
writeFileSync(path.join(TREE_OLD, "old.txt"), "committed long ago, untouched since\n", "utf8");
commit(TREE_OLD, "do the old work", OLD);

// busy: its history is just as old, but somebody is working in it right now. Half an hour is deliberately longer than
// liveMinutes (5), so this row is not "live" either — the only thing that can keep it on the chart is the activity
// measurement the setting is meant to use, which is what makes this the case the whole feature has to get right.
git(repo, ["worktree", "add", "-q", "-b", "work/busy", TREE_BUSY]);
writeFileSync(path.join(TREE_BUSY, "busy.txt"), "the long-lived tree's own history\n", "utf8");
commit(TREE_BUSY, "do the long-lived tree's first work", OLD);
const wip = path.join(TREE_BUSY, "work-in-progress.txt");
writeFileSync(wip, "being worked in\n", "utf8");
const halfHourAgo = new Date(Date.now() - 30 * 60 * 1000);
utimesSync(wip, halfHourAgo, halfHourAgo);

// Deliberately NO hideOlderThanDays key: the default the panel applies is part of what is proved. apiServer points at
// a dead port, so no phase of this test can reach the live gateway even by accident.
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
        threads: 1,
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
writeConfig();
const readConfigFile = () => JSON.parse(readFileSync(configPath, "utf8"));

const base = `http://127.0.0.1:${port}`;
const panelLog = [];
let panel = null;
let shots = null;
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
  // A node process can outlive a polite kill on Windows, and its stdio pipes then hold THIS process's event loop
  // open — a script that never returns. Take the tree down hard instead, and release the pipes either way.
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
const rowFor = async (treePath) => (await rows()).find((w) => norm(w.path) === norm(treePath)) || null;

// ---- the browser phase ---------------------------------------------------------------------------
async function browserPhase(pw) {
  const pageErrors = [];
  const consoleErrors = [];
  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
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
  const arrow = () =>
    page.evaluate((project) => {
      const b = document.querySelector(`section.project[data-project="${project}"] [data-age-toggle]`);
      if (!b) return null;
      const cs = getComputedStyle(b);
      return { glyph: b.textContent, pressed: b.getAttribute("aria-pressed"), opacity: cs.opacity, pointerEvents: cs.pointerEvents, title: b.title };
    }, PROJECT);
  const chart = `tbody[data-tbody="${PROJECT}"]`;
  // The arrow lives in the legend's own slot (`[data-age-slot]`), which is where the chart's held-back count is known.
  const arrowSel = `section.project[data-project="${PROJECT}"] [data-age-toggle]`;

  await page.goto(base, { waitUntil: "domcontentloaded" });
  if (!(await waitFor(async () => (await drawn()).length > 0, { what: "the chart to draw its rows" }))) throw new Error("the sandbox chart never drew a row");

  console.log("\n== the chart at rest holds the stale tree back, and says so ==");
  const atRest = await drawn();
  check("the chart draws the project's own checkout and the two trees with recent activity", atRest.slice().sort(), [PROJECT, "long-lived-but-being-worked-in", "worked-in-today"].sort());
  ok("the 45-day-old tree is not drawn", !atRest.includes(path.basename(TREE_OLD)));
  ok("a chip on the project says one tree is held back", (await chips()).includes("1 older hidden"), (await chips()).join(" | "));
  const atRestArrow = await arrow();
  ok("the arrow is in the chart's legend, invisible, and takes no clicks", atRestArrow && atRestArrow.opacity === "0" && atRestArrow.pointerEvents === "none", JSON.stringify(atRestArrow));
  note(`screenshot: ${await shot("1-at-rest")}`);

  console.log("\n== hovering the chart brings the arrow up, in the console chip's own style ==");
  await page.hover(chart);
  if (!(await waitFor(async () => ((await arrow()) || {}).opacity === "1", { what: "the arrow to appear while the chart is hovered" }))) throw new Error("the arrow never appeared on hover");
  const shown = await arrow();
  ok("the pointer over the chart makes the arrow visible and clickable", shown.opacity === "1" && shown.pointerEvents === "auto", JSON.stringify(shown));

  // The console's own chip is built here with the panel's own renderer (`toBottomBtnHtml` is a page global: app.js is
  // a classic script), so the comparison is against the element the reader sees, not against a copy of its CSS.
  //
  // What is asserted is the IDIOM, because that is what "the same chip" means here: the same 21px circle, the same
  // border width and radius, the same fade transition, the same glyph. The arrow's ink is deliberately NOT the
  // console chip's — it is brighter and its halo is tighter, because it sits on the legend's dark strip rather than
  // floating over a console, where #c3ccd8 read as a smudge instead of a control. That difference is the one thing
  // this check leaves out on purpose, and it is written down here rather than silently skipped.
  const styleDigest = await page.evaluate(() => {
    const wrap = document.createElement("div");
    wrap.className = "out-wrap out-tab";
    wrap.style.cssText = "position:fixed;left:0;top:0;width:320px;height:80px;";
    wrap.innerHTML = `<pre class="job-out"></pre>${toBottomBtnHtml()}`;
    document.body.appendChild(wrap);
    const consoleChip = wrap.querySelector(".to-bottom");
    const chartChip = document.querySelector('section.project[data-project="sandbox-repo"] [data-age-toggle]');
    const keys = ["width", "height", "borderRadius", "borderTopWidth", "transitionProperty", "transitionDuration", "cursor"];
    const pick = (el) => Object.fromEntries(keys.map((k) => [k, getComputedStyle(el)[k]]));
    const out = { consoleChip: pick(consoleChip), chartChip: pick(chartChip), consoleGlyph: consoleChip.textContent, chartGlyph: chartChip.textContent };
    wrap.remove();
    return out;
  });
  check("the chart arrow is the console chip's own shape and bargain", styleDigest.chartChip, styleDigest.consoleChip);
  check("and both carry the same down arrow", [styleDigest.consoleGlyph, styleDigest.chartGlyph], ["\u2193", "\u2193"]);
  note(`screenshot: ${await shot("2-arrow-on-hover")}`);

  console.log("\n== one click shows every tree, and the choice is what a reload comes back with ==");
  await page.click(arrowSel);
  if (!(await waitFor(async () => (await drawn()).length === 4, { what: "the click to draw the held-back tree" }))) throw new Error("the held-back tree never came back");
  ok("one click draws the tree that was held back", (await drawn()).includes(path.basename(TREE_OLD)), (await drawn()).slice().sort().join(" | "));
  ok("the 'older hidden' chip is gone", !(await chips()).includes("1 older hidden"), (await chips()).join(" | "));
  const afterClick = await arrow();
  ok("the arrow turns up and says it is showing everything", afterClick.glyph === "\u2191" && afterClick.pressed === "true", JSON.stringify(afterClick));
  check("the choice is written down in this browser", await page.evaluate(() => JSON.parse(localStorage.getItem("wtgui.showOldProjects") || "[]")), [PROJECT]);
  note(`screenshot: ${await shot("3-shown-in-full")}`);

  await page.reload({ waitUntil: "domcontentloaded" });
  if (!(await waitFor(async () => (await drawn()).length === 4, { what: "the reloaded chart to still show every tree" }))) throw new Error("the reload forgot which charts were showing everything");
  ok("after a reload the chart is still showing every tree", (await drawn()).includes(path.basename(TREE_OLD)), (await drawn()).slice().sort().join(" | "));
  ok("and the threshold after that reload is still the panel's", (await api("/api/config")).body.hideOlderThanDays === 7);

  console.log("\n== the Settings control, and the chart redrawing from the number ==");
  // Held back again first, so that what the next threshold does is decided by the threshold and not by this project's
  // remembered "show everything".
  await page.hover(chart);
  await waitFor(async () => ((await arrow()) || {}).opacity === "1", { what: "the arrow on hover again" });
  await page.click(arrowSel);
  if (!(await waitFor(async () => (await drawn()).length === 3, { what: "the arrow to hold the stale tree back again" }))) throw new Error("the arrow did not hold the tree back");
  ok("the arrow holds the stale tree back again", !(await drawn()).includes(path.basename(TREE_OLD)), (await drawn()).slice().sort().join(" | "));

  await openSettingsGroup(page, "board");
  check("the Settings tab carries the threshold, reading the panel's value", await page.inputValue("#hide-older-days"), "7");
  const preview = await page.textContent("#hide-older-preview");
  ok("its preview says what the threshold is doing and where it lives", /hold back worktrees whose last activity is older than 7 days · set in config\.json/.test(preview), preview);

  await page.fill("#hide-older-days", "60");
  await page.dispatchEvent("#hide-older-days", "change");
  await waitFor(() => readConfigFile().hideOlderThanDays === 60, { what: "config.json to take 60 days" });
  check("saving 60 days writes config.json", readConfigFile().hideOlderThanDays, 60);
  await page.click("#btn-settings-close");
  if (!(await waitFor(async () => (await drawn()).length === 4, { what: "a 60-day threshold to draw the 45-day-old tree" }))) throw new Error("the new threshold did not reach the chart");
  ok("a 60-day threshold no longer holds the 45-day-old tree back", (await drawn()).includes(path.basename(TREE_OLD)), (await drawn()).slice().sort().join(" | "));
  ok("and nothing is reported as held back", !(await chips()).some((c) => /older hidden/.test(c)), (await chips()).join(" | "));

  await openSettingsGroup(page, "board");
  await page.fill("#hide-older-days", "7");
  await page.dispatchEvent("#hide-older-days", "change");
  await waitFor(() => readConfigFile().hideOlderThanDays === 7, { what: "config.json back to 7 days" });
  check("saving 7 days writes config.json", readConfigFile().hideOlderThanDays, 7);
  await page.click("#btn-settings-close");
  if (!(await waitFor(async () => (await drawn()).length === 3, { what: "7 days to hold the 45-day-old tree back" }))) throw new Error("7 days did not hold the tree back");
  ok("7 days holds the 45-day-old tree back again", !(await drawn()).includes(path.basename(TREE_OLD)), (await drawn()).slice().sort().join(" | "));
  ok("and the chip says how many are held back", (await chips()).includes("1 older hidden"), (await chips()).join(" | "));

  console.log("\n== 0 shows everything, and the chart stops carrying a control it is not using ==");
  await openSettingsGroup(page, "board");
  await page.click('[data-age-set="0"]');
  await waitFor(() => readConfigFile().hideOlderThanDays === 0, { what: "config.json to take 0 (off)" });
  check("the 'off' preset writes 0 to config.json", readConfigFile().hideOlderThanDays, 0);
  await page.click("#btn-settings-close");
  if (!(await waitFor(async () => (await drawn()).length === 4, { what: "every tree to be drawn with the threshold off" }))) throw new Error("turning the threshold off did not put every tree back");
  ok("with the threshold off the chart draws every tree", (await drawn()).includes(path.basename(TREE_OLD)));
  ok("and there is no arrow left on the chart", (await arrow()) === null);
  await page.click("#btn-settings");
  await page.click('[data-age-set="7"]');
  await waitFor(() => readConfigFile().hideOlderThanDays === 7, { what: "config.json back to 7 days" });
  await page.click("#btn-settings-close");
  await waitFor(async () => (await arrow()) !== null, { what: "the arrow to come back" });
  ok("turning the threshold back on brings the arrow back", (await arrow()) !== null);
  if (!(await waitFor(async () => (await drawn()).length === 3, { what: "the chart to hold the tree back again" }))) throw new Error("7 days did not put the tree back out of the chart");

  check("no uncaught page errors", pageErrors, []);
  ok("no console errors", consoleErrors.length === 0, consoleErrors.join(" | "));
  await browser.close();
  return { shotAtRest: path.join(shotsDir, "1-at-rest.png"), shotHover: path.join(shotsDir, "2-arrow-on-hover.png"), shotShown: path.join(shotsDir, "3-shown-in-full.png") };
}

// ---- run -----------------------------------------------------------------------------------------
try {
  await startPanel();

  console.log("== the default, and the activity the client measures ==");
  const settings = (await api("/api/config")).body;
  check("a config.json with no hideOlderThanDays boots on 7 days", settings.hideOlderThanDays, 7);
  ok("and the file still has no such key (the default is not written back on boot)", !("hideOlderThanDays" in readConfigFile()), JSON.stringify(Object.keys(readConfigFile())));

  const scanned = await waitFor(
    async () => {
      const r = await rows();
      return r.length === 4 && r.every((x) => x.lastCommit && x.lastEdit);
    },
    { timeoutMs: 120_000, what: "the four rows to be scanned with their activity", stepMs: 700 },
  );
  ok("four rows scanned (three worktrees and the project's own checkout)", scanned, (await rows()).map((r) => r.name).sort().join(" | "));
  const ageDays = (iso) => Math.round((Date.now() - Date.parse(iso)) / 864e5);
  const oldRow = await rowFor(TREE_OLD);
  const busyRow = await rowFor(TREE_BUSY);
  const recentRow = await rowFor(TREE_RECENT);
  const rootRow = await rowFor(repo);
  check("the abandoned tree's last activity is 45 days old", ageDays(oldRow.lastEdit), 45);
  check("the long-lived tree's LAST COMMIT is just as old", ageDays(busyRow.lastCommit), 45);
  ok("...but its last activity is half an hour old, which is why it stays on the chart", Date.now() - Date.parse(busyRow.lastEdit) < 3600e3, `lastEdit ${busyRow.lastEdit}`);
  ok("the tree worked in today is minutes old", Date.now() - Date.parse(recentRow.lastEdit) < 3600e3, `lastEdit ${recentRow.lastEdit}`);
  check("the project's own checkout is 45 days old too", ageDays(rootRow.lastCommit), 45);

  console.log("\n== the setting writes one key of config.json, and reads back what it wrote ==");
  const before = readConfigFile();
  const saved = await api("/api/settings/age", { days: 14 });
  check("POST /api/settings/age answers 200", saved.status, 200);
  check("...with the number it stored", saved.body.days, 14);
  check("...and the settings the page redraws from", saved.body.settings?.hideOlderThanDays, 14);
  check("config.json now says 14", readConfigFile().hideOlderThanDays, 14);
  const after = readConfigFile();
  delete before.hideOlderThanDays;
  delete after.hideOlderThanDays;
  check("every other key in config.json is untouched", after, before);
  check("and /api/config agrees", (await api("/api/config")).body.hideOlderThanDays, 14);

  check("an unreadable value falls back to the default, not to 'off'", (await api("/api/settings/age", { days: "not a number" })).body.days, 7);
  check("...and that is what the file says too", readConfigFile().hideOlderThanDays, 7);
  check("a value past the cap is clamped", (await api("/api/settings/age", { days: 99999 })).body.days, 3650);
  check("0 is accepted as 'off'", (await api("/api/settings/age", { days: 0 })).body.days, 0);
  check("a negative value falls back to the default", (await api("/api/settings/age", { days: -5 })).body.days, 7);

  console.log("\n== the browser: held back at rest, one arrow, and it survives a reload ==");
  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  the client half of this change was not exercised in a browser.");
    note("re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-age-collapse.mjs");
    failures += 1;
  } else {
    shots = await browserPhase(pw);
    if (shots?.shotAtRest) note(`screenshots: ${shots.shotAtRest} · ${shots.shotHover} · ${shots.shotShown}`);
  }

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed`);
  if (shots?.shotAtRest) {
    console.log("\nWHAT WAS DRIVEN: a sandbox panel booted over a throwaway repo whose three worktrees have known activity");
    console.log("ages (the default, the activity the client measures, the setting's write-back and its clamping), and headless");
    console.log("Chromium over the running panel (the chart at rest, the chip, the invisible arrow and its hover, the style");
    console.log("comparison against the console's own chip, the click, the reload, the Settings control, 0 = off).");
    console.log("WHAT WAS INSPECTED, NOT DRIVEN: that the row filter lives in public/app.js rather than in the server's row set is");
    console.log("read off the source; this script drives that decision through the DOM, which is the same thing one level down.");
  }
  if (!failures) console.log("AGE-VERIFY-OK");
} catch (err) {
  failures += 1;
  console.log(`\nFAIL  the run threw: ${String((err && err.stack) || err)}`);
  if (panelLog.length) console.log(`--- panel log (tail)\n${panelLog.slice(-25).join("\n")}`);
} finally {
  if (process.env.VERIFY_KEEP === "1") {
    console.log(`VERIFY_KEEP=1 — leaving ${dir} in place`);
  } else {
    await stopPanel();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch (e) {
      console.log(`      (could not remove ${dir}: ${String((e && e.message) || e)})`);
    }
  }
}
process.exitCode = failures ? 1 : 0;
