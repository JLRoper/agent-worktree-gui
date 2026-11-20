// The REVIEWED CHIP as one more switch in the worktree chart's own column control, proved by driving a panel of its
// own - and a real browser at the reader's window (1440x900).
//
//   PANEL_PLAYWRIGHT_ROOT=<the directory npm installs global packages into> node tools/verify-reviewed-chip.mjs
//
// HARNESS: LIVE GATE
//
// The reader asked for the chip to be switched where the columns are switched. So there is ONE control: Settings >
// Board > Chart columns, whose boxes are built from `CHART_COLUMNS` and then `CHART_CHIPS` (public/charts.js), saved
// in ONE list (config.json `hiddenColumns`, POST /api/settings/columns), and read back by the row renderer through
// `chartChipShown("reviewed")`. No second menu, no settings tab of its own, no page-local state.
//
// WHAT IS DRIVEN
//
//   driven    the control: one holder, thirteen columns then Reviewed LAST, one checkbox per label and the same
//             label styling - and every column still ticked, with the counter still a count of COLUMNS (13/13)
//   driven    on: the row whose last run left a result carries the amber mark, its press and the amber edge exactly
//             as before; a row already reviewed carries none of them
//   driven    off: the unticked chip is stored as `["reviewed"]` in config.json, and every row is rebuilt with NO
//             element where the chip was - no span, no button, no empty placeholder - and the name line's content
//             ends where its last mark ends, so nothing is reserved for a chip that is not drawn
//   driven    a RELOAD: the box comes back unticked, the rows come back without the chip, the columns are untouched
//   driven    keyboard and Escape: the chip's box takes the focus like any other switch, and Escape still closes the
//             drawer with the stored list unchanged
//   driven    on again: the mark and its press come back, so off is a switch and not a delete
//
// The screenshots go to the sandbox's shots/ directory, and PANEL_SHOTS_DIR keeps a copy as evidence for the reader.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, openSettingsGroup } from "./browser.mjs";
import { ROOT, freePort } from "./panel-testkit.mjs";

let failures = 0;
let checks = 0;
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 30_000, stepMs = 250, what = "condition" } = {}) {
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
const git = (dir, args) => {
  try {
    return { ok: true, out: execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true }).trim() };
  } catch (e) {
    return { ok: false, out: String((e && e.stdout) || "").trim(), err: String((e && e.message) || e) };
  }
};

// ---- the browser half ----------------------------------------------------------------------------
const pw = loadPlaywright();
if (!pw) {
  console.log("BROWSER-NOT-RUN  the reviewed chip's switch was not exercised in a browser.");
  console.log("  re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-reviewed-chip.mjs");
  process.exit(2);
}

// ---- the sandbox ---------------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-reviewed-chip-"));
const rootDir = path.join(dir, "scan-root");
const repo = path.join(rootDir, "sandbox-repo");
const home = path.join(dir, "hermes-home");
const configDir = path.join(dir, "panel");
const shotsDir = path.join(dir, "shots");
const TREE_ONE = path.join(repo, ".worktrees", "one-tree");
const TREE_TWO = path.join(repo, ".worktrees", "two-tree");
for (const d of [repo, path.join(repo, ".worktrees"), home, configDir, shotsDir]) mkdirSync(d, { recursive: true });
const commit = (where, message) => {
  git(where, ["add", "-A"]);
  return git(where, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", message]);
};
git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# sandbox repo\n", "utf8");
commit(repo, "seed the sandbox repo");
for (const [where, branch, file] of [
  [TREE_ONE, "work/one", "one.txt"],
  [TREE_TWO, "work/two", "two.txt"],
]) {
  git(repo, ["worktree", "add", "-q", "-b", branch, where]);
  writeFileSync(path.join(where, file), "sandbox work\n", "utf8");
  commit(where, `do the ${branch} work`);
}

// The lane's own record, written before the panel boots: one tree whose run left a result to check, one already
// reviewed. `lib/review-inbox.js` keys on the tree path, lower-cased with forward slashes.
const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const iso = (minusMinutes) => new Date(Date.now() - minusMinutes * 60_000).toISOString();
const reviewsFile = path.join(configDir, "reviews.json");
writeFileSync(
  reviewsFile,
  `${JSON.stringify(
    {
      version: 1,
      entries: [
        {
          project: "sandbox-repo",
          path: norm(TREE_ONE),
          at: iso(20),
          summary: "the sandbox run left a result to check",
          report: "docs/reports/sandbox.html",
          next: ["read the report", "re-run the failing test"],
          reviewedAt: null,
        },
        {
          project: "sandbox-repo",
          path: norm(TREE_TWO),
          at: iso(60),
          summary: "the second run was already looked at",
          reviewedAt: iso(30),
          reviewedBy: "reader",
        },
      ],
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const port = await freePort();
const configPath = path.join(configDir, "config.json");
const writeConfig = () =>
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
        defaultCwd: repo,
        projectsCacheFile: path.join(configDir, "logs", "projects.json"),
        reviewsFile,
        apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
        assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
writeConfig();
const readConfig = () => JSON.parse(readFileSync(configPath, "utf8"));

const base = `http://127.0.0.1:${port}`;
const panelLog = [];
let panel = null;
let browser = null;
let shots = 0;
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
  await new Promise((resolve) => {
    p.on("exit", resolve);
    p.kill();
    setTimeout(resolve, 6000);
  });
};
const shot = async (page, name) => {
  shots += 1;
  const file = path.join(shotsDir, `${String(shots).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  note(`screenshot ${file}`);
  if (process.env.PANEL_SHOTS_DIR) {
    mkdirSync(process.env.PANEL_SHOTS_DIR, { recursive: true });
    copyFileSync(file, path.join(process.env.PANEL_SHOTS_DIR, path.basename(file)));
  }
  return file;
};

// The control's own state: one holder, one box per switch, and the chip LAST.
const controlState = (page) =>
  page.evaluate(() => {
    const holder = document.getElementById("chart-cols");
    const boxes = [...holder.querySelectorAll("input[data-chart-col]")];
    const labels = [...holder.querySelectorAll("label")];
    return {
      holders: document.querySelectorAll("#chart-cols").length,
      ids: boxes.map((b) => b.dataset.chartCol),
      checked: boxes.filter((b) => b.checked).map((b) => b.dataset.chartCol),
      labels: labels.map((l) => l.textContent.trim()),
      lastChipHook: labels.at(-1)?.dataset.chartChip || null,
      oneBoxPerLabel: labels.every((l) => l.querySelectorAll('input[type="checkbox"]').length === 1),
      count: document.getElementById("chart-cols-count")?.textContent,
      preview: document.getElementById("chart-cols-preview")?.textContent || "",
    };
  });

// Every row's chip, and where the name line's content actually ENDS (a Range over the cell's contents, so the answer
// is "the last thing drawn", not the cell's own width). `empties` is the "hidden, not removed" bug: an element left
// with nothing in it is exactly the gap this feature must not leave.
const chipState = (page) =>
  page.evaluate(() => {
    const tree = (key) => (String(key).toLowerCase().includes("one-tree") ? "one" : String(key).toLowerCase().includes("two-tree") ? "two" : key);
    return [...document.querySelectorAll("section.project tr.row")].map((tr) => {
      const cell = tr.cells[0];
      let contentWidth = 0;
      if (cell) {
        const range = document.createRange();
        range.selectNodeContents(cell);
        contentWidth = Math.round(range.getBoundingClientRect().width);
      }
      return {
        tree: tree(tr.dataset.key || ""),
        marks: tr.querySelectorAll(".review-mark").length,
        presses: tr.querySelectorAll("[data-review-done]").length,
        amber: tr.classList.contains("has-review"),
        empties: [...(cell?.children || [])].filter((el) => !el.textContent.trim() && !el.querySelector("img,svg")).map((el) => el.className || el.tagName),
        contentWidth,
        cells: tr.cells.length,
      };
    });
  });

const openSettings = async (page) => {
  await openSettingsGroup(page, "board");
  await page.waitForSelector("#chart-cols input[data-chart-col]", { state: "visible", timeout: 8000 });
};
const openProjects = async (page) => {
  for (const head of await page.locator("section.project > .project-head[data-toggle-project]").all()) {
    const section = head.locator("xpath=..");
    const cls = await section.getAttribute("class");
    if (cls && cls.includes("collapsed")) await head.click();
  }
};
const chipBox = (page) => page.locator('#chart-cols input[data-chart-col="reviewed"]');

const run = async () => {
  const errors = [];
  browser = await pw.chromium.launch({ headless: true });
  // The reader's window, exactly: 1440x900, and every shot is the viewport, not a full-page stitch.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(String((e && e.message) || e)));
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitFor(async () => (await page.locator("section.project[data-project]").count()) > 0, { timeoutMs: 90_000, what: "the sandbox project" });
  await openProjects(page);
  const rows = await waitFor(async () => (await page.locator("section.project[data-project] tr.row").count()) >= 2, { timeoutMs: 30_000, what: "two worktree rows" });
  ok("the sandbox draws both worktrees", rows);
  await page.waitForFunction(() => document.querySelectorAll("section.project tr.row .review-mark").length > 0, null, { timeout: 20_000 });

  // ---- 1. the control the columns are switched in -------------------------------------------------
  await openSettings(page);
  await page.evaluate(() => document.getElementById("chart-cols-row")?.scrollIntoView({ block: "center" }));
  const control = await controlState(page);
  const COLUMNS = ["name", "branch", "assistant", "initiative", "tip", "ahead", "cherry", "pr", "dirty", "life", "nextread", "verdict", "actions"];
  // The owner column hides ITSELF while every tree is on Assistant #1 and there is no second assistant, so the rows
  // draw twelve of the thirteen cells on this idle board - which is the only reason the count below is not 13.
  const AT_REST = COLUMNS.filter((id) => id !== "assistant");
  check("one holder carries every switch", control.holders, 1);
  check("the switches are the thirteen columns, then the chip", control.ids, [...COLUMNS, "reviewed"]);
  check("the chip's label reads like a column's", control.labels.at(-1), "Reviewed");
  check("…and its entry carries the chip hook", control.lastChipHook, "reviewed");
  ok("one checkbox per label, as a column's entry has", control.oneBoxPerLabel);
  check("every column is on at rest, and the chip starts out on with them", control.checked, [...COLUMNS, "reviewed"]);
  check("the counter is a count of COLUMNS, not of switches", control.count, `${COLUMNS.length}/${COLUMNS.length}`);
  const controlShot = await shot(page, "control-open");

  // ---- Escape still closes the drawer, with the stored list unchanged -----------------------------
  await page.keyboard.press("Escape");
  const closed = await waitFor(async () => page.evaluate(() => document.getElementById("settings")?.classList.contains("hidden")), { timeoutMs: 5000, what: "Escape to close the drawer" });
  ok("Escape closes the drawer, as before", closed);
  ok("…and it changes nothing that is stored", !("hiddenColumns" in readConfig()));

  // ---- 2. on: the chip as it is today -------------------------------------------------------------
  const on = await chipState(page);
  const one = on.find((r) => r.tree === "one");
  const two = on.find((r) => r.tree === "two");
  check("the row with a result to check carries one mark and one press", [one?.marks, one?.presses], [1, 1]);
  ok("…and the amber edge that says so at rest", one?.amber === true);
  check("the row already reviewed carries neither", [two?.marks, two?.presses, two?.amber], [0, 0, false]);
  check("the name cell has nothing empty in it", one?.empties, []);
  const onShot = await shot(page, "chip-on");
  const onWidth = one.contentWidth;
  check("every row still draws the same cells: the chip is no column", [...new Set(on.map((r) => r.cells))], [AT_REST.length]);

  // ---- 3. off: one more switch, and the element is not emitted ------------------------------------
  await openSettings(page);
  await page.evaluate(() => document.getElementById("chart-cols-row")?.scrollIntoView({ block: "center" }));
  ok("the chip's box is keyboard-reachable", await chipBox(page).evaluate((el) => (el.focus(), document.activeElement === el)));
  await chipBox(page).click();
  const stored = await waitFor(async () => JSON.stringify(readConfig().hiddenColumns) === JSON.stringify(["reviewed"]), { timeoutMs: 20_000, what: "config.json to store the chip" });
  ok("unticking the chip stores its own id, in the columns' own list", stored);
  check("…and stores nothing else", readConfig().hiddenColumns, ["reviewed"]);
  await page.keyboard.press("Escape");
  const repainted = await waitFor(async () => (await chipState(page)).every((r) => r.marks === 0 && r.presses === 0), { timeoutMs: 20_000, what: "the rows to repaint without the chip" });
  ok("every row repaints without the chip, with no reload and no second control", repainted);
  const off = await chipState(page);
  check("no row draws the mark or the press", off.map((r) => [r.marks, r.presses]), off.map(() => [0, 0]));
  check("…and no row keeps the amber edge", off.map((r) => r.amber), off.map(() => false));
  check("…and nothing is left where the chip was", off.map((r) => r.empties), off.map(() => []));
  ok(
    "the name line's content closes up - the chip's width is not reserved",
    off.find((r) => r.tree === "one").contentWidth < onWidth,
    `on ${onWidth}px, off ${off.find((r) => r.tree === "one").contentWidth}px`,
  );
  check("…and the cells are exactly what they were: switching the chip moves no column", [...new Set(off.map((r) => r.cells))], [AT_REST.length]);
  const offShot = await shot(page, "chip-off");

  // ---- 4. a reload is a fresh browser: the switch is the panel's ----------------------------------
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(async () => (await page.locator("section.project[data-project]").count()) > 0, { timeoutMs: 90_000, what: "the project after a reload" });
  await openProjects(page);
  await waitFor(async () => (await page.locator("section.project[data-project] tr.row").count()) >= 2, { timeoutMs: 30_000, what: "the rows after a reload" });
  const reloaded = await waitFor(async () => (await chipState(page)).every((r) => r.marks === 0 && r.presses === 0), { timeoutMs: 30_000, what: "no chip after a reload" });
  ok("the reload draws no chip on any row", reloaded);
  await openSettings(page);
  await page.evaluate(() => document.getElementById("chart-cols-row")?.scrollIntoView({ block: "center" }));
  const after = await controlState(page);
  check("the chip's box reads back unticked", after.checked, COLUMNS);
  check("…with every column still ticked and the counter untouched", [after.count, after.labels.at(-1)], [`${COLUMNS.length}/${COLUMNS.length}`, "Reviewed"]);
  ok("…and the sentence says which chip is off", /the reviewed chip is off/.test(after.preview), after.preview);
  const reloadShot = await shot(page, "after-reload");

  // ---- 5. on again: a switch, not a delete --------------------------------------------------------
  await chipBox(page).click();
  const back = await waitFor(async () => (await chipState(page)).some((r) => r.marks === 1 && r.presses === 1), { timeoutMs: 20_000, what: "the chip to come back" });
  ok("ticking it again brings the mark and its press back", back);
  check("the stored list is empty again", readConfig().hiddenColumns, []);
  const backShot = await shot(page, "chip-on-again");

  ok("no page error along the way", errors.length === 0, errors.slice(0, 3).join(" | "));
  const log = panelLog.join("\n");
  ok("the panel logged the switch it stored", /chart columns: .*hidden/.test(log), (log.match(/chart columns: .*/) || [""])[0]);
  note(`shots: ${[controlShot, onShot, offShot, reloadShot, backShot].map((f) => path.basename(f)).join(", ")}`);
  await page.close();
};

try {
  await startPanel();
  await run();
} catch (e) {
  failures += 1;
  console.log(`FAIL  the harness threw: ${String((e && e.stack) || e)}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopPanel();
  if (process.env.VERIFY_KEEP === "1") {
    console.log(`      VERIFY_KEEP=1 - sandbox left at ${dir} (shots in ${shotsDir})`);
  } else {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

console.log(`\n${checks} checks, ${failures} failed.`);
process.exitCode = failures ? 1 : 0;
