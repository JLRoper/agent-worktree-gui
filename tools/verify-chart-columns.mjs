// The worktree chart's column switches, proved by driving a panel of its own — and a real browser over it.
//
//   PANEL_PLAYWRIGHT_ROOT=C:/Users/<user>/AppData/Roaming/npm node tools/verify-chart-columns.mjs
//
// Settings > Board > **Chart columns** turns each of the table's eleven columns on and off. The choice is the panel's
// own config.json (`hiddenColumns`, POST /api/settings/columns), so every browser and every restart draws the same
// chart, and the table is rebuilt from the shown set: the header carries one <th> per visible column, every row one
// <td>, and the two column-spanning rows (an expanded worktree, the delete question) ask for the shown count instead
// of the old literal 10 — which is exactly where a hidden column used to leave a bare strip of panel at the right
// edge, or a cell one column short of the last one.
//
// WHAT IS DRIVEN, AND WHAT IS ONLY INSPECTED
//
//   driven    at rest: ten of the eleven headers drawn — the OWNER column ("assistant") starts switched OFF, because
//             a config that has never expressed a preference gets DEFAULT_HIDDEN_COLUMNS — ten cells per row, no key
//             in config.json (the default lives in memory; the file stays keyless until the reader moves a switch),
//             and ten of the eleven switches checked in Settings
//   driven    switching the owner column on draws its header and its cell — the cell reads the ROLE LABEL ("Manager 1"),
//             never `assistant-1` — and the counter says 11/11; switching it off again stores exactly that one column
//   driven    an expanded worktree's detail carries its own line, "Controlled by: Manager 1", beside the branch and
//             the verdict
//   driven    unchecking Cherry and Tip rebuilds every project table to eight columns — the header loses those two
//             <th>, each row loses those two <td>, an expanded worktree's detail row spans exactly eight, and the
//             remaining columns still add up to the table's width (no horizontal scroll where there was none)
//   driven    the write is the panel's, not the tab's: config.json carries ["assistant","tip","cherry"] in the
//             chart's own order, /api/config agrees, and a RELOAD of the page (a fresh browser state) still draws
//             eight columns
//   driven    "show all" puts eleven back and stores an empty list, not a missing key
//   driven    the actions column cannot be hidden away: unchecking every switch leaves one column, the row's ⟳/✕
//   driven    no page error along the way, and the settings row reads back what the chart draws
//   inspected the column list itself: the page's ids and the server's are the same list (test/chart-columns.test.js
//             owns the static half; this script drives the rendering)
//
// Sandbox only: a throwaway repo with two hand-cut worktrees, its own HERMES_HOME, its own PANEL_CONFIG with its own
// port and logs, and an apiServer pointed at a dead port so nothing here can reach the live gateway. The live panel
// on 7331 and the live gateway are never touched, and the temp root is deleted at the end. Without a Playwright
// install the script says BROWSER-NOT-RUN and exits 2 rather than passing on a half that never ran.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  console.log("BROWSER-NOT-RUN  the chart's column switches were not exercised in a browser.");
  console.log("  re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-chart-columns.mjs");
  process.exit(2);
}

// ---- the sandbox ---------------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-chart-cols-"));
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
  return file;
};

// The chart as the page draws it: one table per project, the header's column ids in order, and the widest row's cell
// count. Read from the DOM on every step — a header that disagrees with its rows is the bug this feature could ship.
const chartState = (page) =>
  page.evaluate(() => {
    const tables = [...document.querySelectorAll("section.project .wt-scroll > table")];
    return tables.map((t) => {
      const ths = [...t.tHead.rows[0].cells];
      const rows = [...t.tBodies[0].querySelectorAll("tr.row")];
      return {
        project: t.closest("section.project").dataset.project,
        ids: ths.map((th) => th.dataset.colId || ""),
        headers: ths.map((th) => th.textContent.trim()),
        widths: ths.map((th) => Math.round(th.getBoundingClientRect().width)),
        tableWidth: Math.round(t.getBoundingClientRect().width),
        rows: rows.length,
        rowCells: rows.map((r) => r.cells.length),
        cols: rows[0] ? [...rows[0].cells].map((td) => td.className.split(" ")[0]) : [],
      };
    });
  });

// Settings is a drawer, and its button TOGGLES: opening it twice closes it, so the harness asks before it clicks.
const openSettings = async (page) => {
  await openSettingsGroup(page, "board");
  await page.waitForSelector("#chart-cols input[data-chart-col]", { state: "visible", timeout: 8000 });
};

// A project section renders collapsed by default and a collapsed one holds no `tr.row` at all, so every project is
// opened before anything is measured. The chart is what the reader opens, and hiding columns never changes that.
const openProjects = async (page) => {
  for (const head of await page.locator("section.project > .project-head[data-toggle-project]").all()) {
    const section = head.locator("xpath=..");
    const cls = await section.getAttribute("class");
    if (cls && cls.includes("collapsed")) await head.click();
  }
};

const setSwitches = async (page, hide) => {
  await openSettings(page);
  for (const id of hide) {
    const box = page.locator(`#chart-cols input[data-chart-col="${id}"]`);
    if (await box.isChecked()) await box.click();
  }
  for (const id of hide) await page.locator(`#chart-cols input[data-chart-col="${id}"]`).waitFor({ state: "attached" });
};

const run = async () => {
  await startPanel();
  browser = await pw.chromium.launch({ headless: true, args: ["--disable-features=OverlayScrollbar,FluentOverlayScrollbar"] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await waitFor(async () => (await page.locator("section.project").count()) > 0, { timeoutMs: 60_000, what: "the sandbox project" });
  await openProjects(page);
  const ready = await waitFor(
    async () => (await chartState(page)).some((t) => t.rows > 0),
    { timeoutMs: 60_000, what: "the chart's rows" },
  );
  ok("the chart draws the sandbox repo's rows", ready);

  // ---- at rest -----------------------------------------------------------------------------------
  const before = await chartState(page);
  const ALL_IDS = ["name", "branch", "assistant", "tip", "ahead", "cherry", "pr", "dirty", "life", "verdict", "actions"];
  // The owner column is OFF by default: the sandbox's config.json carries no hiddenColumns key, so the read-time
  // default hides exactly this one and the chart opens on the other ten.
  const AT_REST = ALL_IDS.filter((id) => id !== "assistant");
  note(`chart: ${before.map((t) => `${t.project} ${t.ids.length} cols / ${t.rows} rows`).join(" · ")}`);
  ok("every project table starts with ten of its eleven columns", before.every((t) => t.ids.join(",") === AT_REST.join(",")), before[0]?.ids.join(","));
  ok("every row starts with ten cells", before.every((t) => t.rowCells.every((n) => n === 10)), JSON.stringify(before[0]?.rowCells));
  ok("the owner column is not drawn until it is switched on", before.every((t) => !t.ids.includes("assistant")), before[0]?.ids.join(","));
  check("no column key is written until the reader chooses", "hiddenColumns" in readConfig(), false);

  // The helper, not a bare press: it opens the drawer if it is closed AND unfolds the Board group the row lives in,
  // which a plain `#btn-settings` click does not (the switches are then attached but not visible).
  await openSettings(page);
  const switches = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll("#chart-cols input[data-chart-col]")];
    return { ids: boxes.map((b) => b.dataset.chartCol), checked: boxes.filter((b) => b.checked).length, count: document.querySelector("#chart-cols-count")?.textContent };
  });
  check("Settings carries one switch per column", switches.ids, ALL_IDS);
  check("ten of the eleven start switched on", switches.checked, 10);
  check("the row's counter reads the whole chart", switches.count, "10/11");
  // The owner column starts OFF, so its switch is the one that is not checked.
  const offSwitch = await page.evaluate(() => {
    const box = document.querySelector('#chart-cols input[data-chart-col="assistant"]');
    return box ? { present: true, checked: box.checked } : { present: false };
  });
  check("the owner switch is present and switched off", offSwitch, { present: true, checked: false });
  // The row lives in the Board group, below Display: the screenshot has to LOOK at it, not at the top of the drawer.
  await page.evaluate(() => document.getElementById("chart-cols-row")?.scrollIntoView({ block: "center" }));
  await sleep(250);
  await shot(page, "all-columns");

  // ---- the owner column, switched ON --------------------------------------------------------------
  // The whole point of the column: one press draws it in every table, its header sits where the chart's list puts it,
  // and the cell reads the role label the SERVER resolved rather than the id the store holds.
  const ownerBox = page.locator('#chart-cols input[data-chart-col="assistant"]');
  await ownerBox.click();
  const ownerOn = await waitFor(
    async () => (await chartState(page)).every((t) => t.ids.length === 11 && t.ids.includes("assistant")),
    { timeoutMs: 15_000, what: "eleven columns with the owner column on" },
  );
  ok("switching the owner column on draws it in every project table", ownerOn);
  const withOwner = await chartState(page);
  check("the owner header sits between Branch and Tip, in the chart's own order", withOwner.every((t) => t.ids.join(",") === ALL_IDS.join(",")), true);
  ok("every row gains its cell", withOwner.every((t) => t.rowCells.every((n) => n === 11)), JSON.stringify(withOwner[0]?.rowCells));
  const ownerCells = await page.evaluate(() =>
    [...document.querySelectorAll("section.project tbody tr.row td.assistant")].map((td) => td.textContent.trim()),
  );
  ok(
    "the cell reads the role label, never the raw id",
    ownerCells.length > 0 && ownerCells.every((x) => x === "Manager 1"),
    JSON.stringify(ownerCells.slice(0, 3)),
  );
  check("the counter counts the column now drawn", await page.evaluate(() => document.querySelector("#chart-cols-count")?.textContent), "11/11");
  await page.evaluate(() => document.getElementById("chart-cols-row")?.scrollIntoView({ block: "center" }));
  await sleep(250);
  await shot(page, "owner-column-on");

  // …and off again: the stored list is now the owner column alone, which is the state the next step's arithmetic
  // starts from (two more switches off = eight columns).
  await ownerBox.click();
  const ownerOff = await waitFor(
    async () => (await chartState(page)).every((t) => t.ids.length === 10 && !t.ids.includes("assistant")),
    { timeoutMs: 15_000, what: "ten columns with the owner column off" },
  );
  ok("switching it off takes it back out of every table", ownerOff);
  check("and stores that one hidden column, in the chart's own order", readConfig().hiddenColumns, ["assistant"]);

  // ---- hide Cherry and Tip -----------------------------------------------------------------------
  await setSwitches(page, ["cherry", "tip"]);
  const eight = await waitFor(async () => (await chartState(page)).every((t) => t.ids.length === 8), { timeoutMs: 15_000, what: "eight columns" });
  ok("unchecking Cherry and Tip rebuilds every table to eight columns", eight);
  const hidden = await chartState(page);
  const want8 = ALL_IDS.filter((id) => id !== "tip" && id !== "cherry" && id !== "assistant");
  check("the header keeps the other eight, in table order", hidden.every((t) => t.ids.join(",") === want8.join(",")), true);
  ok("no row still draws a ninth cell", hidden.every((t) => t.rowCells.every((n) => n === 8)), JSON.stringify(hidden[0]?.rowCells));
  ok(
    "the remaining columns still add up to the table's own width",
    hidden.every((t) => Math.abs(t.widths.reduce((a, b) => a + b, 0) - t.tableWidth) <= 2),
    hidden[0] ? `${hidden[0].widths.join("+")} = ${hidden[0].widths.reduce((a, b) => a + b, 0)} vs ${hidden[0].tableWidth}` : "",
  );
  check("config.json stores the hidden columns in the chart's own order", readConfig().hiddenColumns, ["assistant", "tip", "cherry"]);
  const liveSettings = await (await fetch(`${base}/api/config`)).json();
  check("/api/config agrees with the file", liveSettings.hiddenColumns, ["assistant", "tip", "cherry"]);
  const counter = await page.evaluate(() => document.querySelector("#chart-cols-count")?.textContent);
  check("the Settings row counts what is drawn", counter, "8/11");

  // ---- the column-spanning rows --------------------------------------------------------------------
  // A plain click on a row's name folds it open (the ⧉ chip only exists for a row that already owns agents); the
  // detail row is one cell across the whole table, so a colspan left at 10 would sit two columns wide of the chart.
  const nameCell = page.locator("section.project tbody tr.row td.name .row-name").first();
  const opened = (await nameCell.count()) > 0;
  if (opened) {
    await nameCell.click();
    await shot(page, "row-opening");
    const span = await waitFor(
      async () =>
        page.evaluate(() => {
          const d = document.querySelector("tr.detail td[colspan]");
          return d ? Number(d.getAttribute("colspan")) : 0;
        }),
      { timeoutMs: 15_000, what: "an expanded worktree's detail row" },
    );
    const colspan = await page.evaluate(() => Number(document.querySelector("tr.detail td[colspan]")?.getAttribute("colspan") || 0));
    ok("an expanded worktree's detail cell spans the eight visible columns", span && colspan === 8, `colspan=${colspan}`);
    const ownerLine = await page.evaluate(() => document.querySelector("tr.detail .git-owner")?.textContent.trim() || "");
    check("the detail carries its own owner line, in the role's label", ownerLine.startsWith("Controlled by: Manager 1"), true);
    ok("…and never the raw id", !/assistant-1/.test(ownerLine), ownerLine);
    await shot(page, "eight-columns");
  } else {
    note("no [data-open-row] chip was reachable, so the detail row's colspan was not driven here");
  }

  // ---- a reload is a fresh browser: the setting has to be the panel's ------------------------------
  await page.reload({ waitUntil: "domcontentloaded" });
  const persisted = await waitFor(async () => (await chartState(page)).every((t) => t.ids.length === 8), { timeoutMs: 60_000, what: "eight columns after a reload" });
  ok("the choice survives a reload — it lives in the panel's config.json, not the tab", persisted);
  await page.click("#btn-settings");
  const reloadedBoxes = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll("#chart-cols input[data-chart-col]")];
    return { checked: boxes.filter((b) => b.checked).map((b) => b.dataset.chartCol), count: document.querySelector("#chart-cols-count")?.textContent };
  });
  check("the switches read back the stored choice", reloadedBoxes.checked, want8);
  check("and the counter with it", reloadedBoxes.count, "8/11");

  // ---- show all -----------------------------------------------------------------------------------
  await page.click("#btn-cols-all");
  const back = await waitFor(async () => (await chartState(page)).every((t) => t.ids.length === 11), { timeoutMs: 15_000, what: "eleven columns again" });
  ok("show all puts every column back", back);
  check("and stores an empty list, not a missing key", readConfig().hiddenColumns, []);
  const cleared = await page.evaluate(() => [...document.querySelectorAll("#chart-cols input[data-chart-col]")].every((b) => b.checked));
  ok("every switch is checked again", cleared);

  // ---- the floor: the actions cell cannot be hidden away --------------------------------------------
  await setSwitches(page, ALL_IDS);
  const one = await waitFor(async () => (await chartState(page)).every((t) => t.ids.length === 1 && t.ids[0] === "actions"), { timeoutMs: 15_000, what: "one column" });
  ok("hiding every switch still leaves one column, and it is the row's controls", one);
  const floor = await chartState(page);
  ok("that last row still carries its ⟳ and ✕", floor.every((t) => t.rowCells.every((n) => n === 1)), JSON.stringify(floor[0]?.rowCells));
  check("the server kept the actions column too", readConfig().hiddenColumns, ALL_IDS.filter((id) => id !== "actions"));
  await shot(page, "actions-only");

  // Put the chart back the way a fresh config draws it — every column on, then the owner column off — so the sandbox
  // ends where it started. `show all` first, because the previous step hid everything but the actions cell.
  await page.click("#btn-cols-all");
  await waitFor(async () => (await chartState(page)).every((t) => t.ids.length === 11), { timeoutMs: 15_000, what: "eleven columns before the restore" });
  await setSwitches(page, ["assistant"]);
  const restored = await waitFor(
    async () => (await chartState(page)).every((t) => t.ids.length === 10 && !t.ids.includes("assistant")),
    { timeoutMs: 15_000, what: "the default chart at the end" },
  );
  ok("the chart ends on its default: ten columns, the owner column off", restored);
  check("and the file holds that one hidden column", readConfig().hiddenColumns, ["assistant"]);

  ok("no page error along the way", errors.length === 0, errors.slice(0, 3).join(" | "));
  const log = panelLog.join("\n");
  ok("the panel logged the change it made", /chart columns: .*hidden/.test(log), (log.match(/chart columns: .*/) || [""])[0]);
  await page.close();
};

try {
  await run();
} catch (e) {
  failures += 1;
  console.log(`FAIL  the harness threw: ${String((e && e.stack) || e)}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopPanel();
  if (process.env.VERIFY_KEEP === "1") {
    console.log(`      VERIFY_KEEP=1 — sandbox left at ${dir} (shots in ${shotsDir})`);
  } else {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

console.log(`\n${checks} checks, ${failures} failed.`);
process.exit(failures ? 1 : 0);
