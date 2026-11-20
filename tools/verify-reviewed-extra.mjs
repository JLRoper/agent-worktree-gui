// tools/verify-reviewed-extra.mjs - the row's SECOND review chip in a cell of its own, driven in a real browser
// against a real panel at 1600x1000.
//
//   node tools/verify-reviewed-extra.mjs
//   PANEL_SHOTS_DIR=docs/assets/reviewed-extra node tools/verify-reviewed-extra.mjs
//
// WHAT THIS IS. A worktree row can carry two review chips. Both used to sit in the name line, and on a row with both the
// name was the thing that gave way. The amber mark and its "✓ Reviewed" press stay exactly where they were
// (public/render-projects.js `reviewRowMarkHtml`, switched by the CHART_CHIPS entry `reviewed`); the row's RESULT chip
// (public/board-scaffold.js `resultChipHtml`, the summary's first clause + age + "reviewed") moved into the chart's own
// `reviewedExtra` column - a real <th> and <td> immediately right of the name - with its own checkbox in
// Settings -> Display -> Chart columns, saved in the same config.json `hiddenColumns` list as every other switch.
//
// WHAT IS DRIVEN AND WHY EACH ONE MATTERS
//   1. the control: "Reviewed (extra)" is a column box, drawn immediately after Worktree and ticked at rest, and the
//      amber chip is still the LAST switch in the same list and still ticked - one control, two ids, one stored list
//   2. both on: the row draws the amber mark and its press in the name line, AND the result chip in td.reviewed-extra;
//      the chip is not a child of td.name, and the name is drawn WHOLE - which is the defect this change ends
//   3. the header: th[data-col-id="reviewedExtra"] reads "Reviewed (extra)" and sits immediately right of Worktree
//   4. Reviewed (extra) OFF: config.json stores exactly ["reviewedExtra"], the header and every row's cell are GONE -
//      no td.reviewed-extra anywhere, one cell fewer per row, nothing left behind - and the amber mark, its press and
//      the row's amber edge are still drawn, because that is the other switch
//   5. a reload keeps it off; ticking it again brings the cell and its chip back
//   6. the amber chip OFF instead: the extra cell and its chip stay, so each switch takes only its own chip
//   7. no page errors, and the same row is photographed in each state
//
// The panel under test is a SECOND instance: its own config, its own scan root and a port the OS says is free
// (tools/panel-testkit.mjs `freePort`). Nothing here touches a panel already running on this machine.
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
  console.log("BROWSER-NOT-RUN  the second review chip was not exercised in a browser.");
  console.log("  re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-reviewed-extra.mjs");
  process.exit(2);
}

// ---- the sandbox ---------------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-reviewed-extra-"));
const rootDir = path.join(dir, "scan-root");
const repo = path.join(rootDir, "sandbox-repo");
const home = path.join(dir, "hermes-home");
const configDir = path.join(dir, "panel");
const shotsDir = path.join(dir, "shots");
// A name long enough to be at risk: at 1600 the name column gives its text about 300px once the cell's own
// controls (the probe, the rename, the lock, the amber mark and its press) are in, so this 25-character name fits BESIDE
// both review chips and would not fit with the result chip in the same line. Every state below asserts it is drawn
// whole, which is the defect this change ends.
const LONG = "two-review-chips-row-name";
const TREE_ONE = path.join(repo, ".worktrees", LONG);
const TREE_TWO = path.join(repo, ".worktrees", "a-tree-with-no-delivery");
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

// The lane's own record, written before the panel boots: the long-named tree's last run left a result nobody has
// checked, so that row carries BOTH review chips (the amber mark and the press, and the result chip).
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
          at: iso(12),
          summary: "the sandbox run left a result to check",
          report: "docs/reports/sandbox.html",
          next: ["read the report", "re-run the failing test"],
          reviewedAt: null,
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
const readConfig = () => JSON.parse(readFileSync(configPath, "utf8"));

const base = `http://127.0.0.1:${port}`;
note(`second panel instance on free port ${port} (config ${configPath})`);
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
// The row itself, cropped: the deliverable the reader opens to see the two chips on the same row, then one off. A live
// panel repaints its rows every couple of seconds, so the row is photographed by CLIP from the box it has at that
// instant - an element screenshot can lose the race against the repaint that replaces the <tr> under it.
const ROW_SEL = 'section.project tr.row[data-key*="two-review-chips"]';
const shotRow = async (page, name) => {
  shots += 1;
  const file = path.join(shotsDir, `${String(shots).padStart(2, "0")}-${name}.png`);
  let box = null;
  for (let attempt = 0; attempt < 6 && !box; attempt += 1) {
    box = await page.evaluate((sel) => {
      const tr = document.querySelector(sel);
      if (!tr) return null;
      const r = tr.getBoundingClientRect();
      return r.width > 100 && r.height > 10 ? { x: Math.max(0, Math.floor(r.left)), y: Math.max(0, Math.floor(r.top)), width: Math.ceil(r.width), height: Math.ceil(r.height) } : null;
    }, ROW_SEL);
    if (!box) await sleep(400);
  }
  if (!box) throw new Error(`could not find the row to photograph (${ROW_SEL})`);
  await page.screenshot({ path: file, clip: box });
  note(`screenshot ${file}`);
  if (process.env.PANEL_SHOTS_DIR) {
    mkdirSync(process.env.PANEL_SHOTS_DIR, { recursive: true });
    copyFileSync(file, path.join(process.env.PANEL_SHOTS_DIR, path.basename(file)));
  }
  return file;
};

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
const box = (page, id) => page.locator(`#chart-cols input[data-chart-col="${id}"]`);

// What the control offers, in the order it offers it.
const controlState = (page) =>
  page.evaluate(() => {
    const holder = document.getElementById("chart-cols");
    const boxes = [...holder.querySelectorAll("input[data-chart-col]")];
    return {
      ids: boxes.map((b) => b.dataset.chartCol),
      checked: boxes.filter((b) => b.checked).map((b) => b.dataset.chartCol),
      labels: [...holder.querySelectorAll("label")].map((l) => l.textContent.trim()),
      count: document.getElementById("chart-cols-count")?.textContent,
      preview: document.getElementById("chart-cols-preview")?.textContent || "",
    };
  });

// The row the reader complained about: both review chips, where each one lives, and whether the name is drawn whole.
const rowState = (page) =>
  page.evaluate(() => {
    const tr = [...document.querySelectorAll("section.project tr.row")].find((r) => String(r.dataset.key || "").toLowerCase().includes("two-review-chips"));
    if (!tr) return null;
    const nameCell = tr.querySelector("td.name");
    const nameEl = nameCell?.querySelector(".row-name");
    const extra = tr.querySelector("td.reviewed-extra");
    const chip = extra?.querySelector('[data-rowchip="result"]') || null;
    const range = document.createRange();
    if (nameCell) range.selectNodeContents(nameCell);
    return {
      cells: tr.cells.length,
      cols: [...document.querySelectorAll("section.project thead th")].map((th) => th.dataset.colId),
      extraHeader: Boolean(document.querySelector('section.project thead th[data-col-id="reviewedExtra"]')),
      hasExtraCell: Boolean(extra),
      chipInExtra: Boolean(chip),
      chipInNameCell: Boolean(nameCell?.querySelector('[data-rowchip="result"]')),
      chipLabel: (chip?.querySelector(".rowchip-text")?.textContent || "").trim(),
      marks: tr.querySelectorAll(".review-mark").length,
      presses: tr.querySelectorAll("[data-review-done]").length,
      amber: tr.classList.contains("has-review"),
      nameShown: (nameEl?.textContent || "").trim(),
      nameWhole: Boolean(nameEl) && nameEl.scrollWidth <= nameEl.clientWidth + 1,
      nameBox: Boolean(nameEl) ? { client: Math.round(nameEl.clientWidth), scroll: Math.round(nameEl.scrollWidth) } : null,
      nameCellContent: nameCell ? Math.round(range.getBoundingClientRect().width) : 0,
      extraCellsOnBoard: document.querySelectorAll("td.reviewed-extra").length,
      emptyTds: [...tr.querySelectorAll("td")].filter((td) => !td.textContent.trim() && !td.querySelector("button,input,img,svg")).length,
    };
  });

const run = async () => {
  const errors = [];
  browser = await pw.chromium.launch({ headless: true });
  // 2400x1000: the width of the reader's own panel window (the screenshot that started this work), so the row the
  // screenshots show is the row they see - a realistic name drawn whole beside both review chips.
  const page = await browser.newPage({ viewport: { width: 2400, height: 1000 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(String((e && e.message) || e)));
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitFor(async () => (await page.locator("section.project[data-project]").count()) > 0, { timeoutMs: 90_000, what: "the sandbox project" });
  await openProjects(page);
  const rows = await waitFor(async () => (await page.locator("section.project[data-project] tr.row").count()) >= 2, { timeoutMs: 30_000, what: "two worktree rows" });
  ok("the sandbox draws both worktrees", rows);
  await page.waitForFunction(() => document.querySelectorAll("section.project tr.row .review-mark").length > 0, null, { timeout: 20_000 });

  // ---- 1. the control: two review switches in the one list the reader already uses --------------------
  await openSettings(page);
  await page.evaluate(() => document.getElementById("chart-cols-row")?.scrollIntoView({ block: "center" }));
  const control = await controlState(page);
  const iName = control.ids.indexOf("name");
  const iExtra = control.ids.indexOf("reviewedExtra");
  const COLUMN_COUNT = 14;
  ok("Reviewed (extra) is one more COLUMN box in this list", iExtra === iName + 1, `at ${iExtra}, name at ${iName}`);
  check("its label says what it is", control.labels[iExtra], "Reviewed (extra)");
  ok("it starts TICKED, so today's layout is otherwise unchanged", control.checked.includes("reviewedExtra"));
  ok("the amber chip is still the LAST switch in the same list, and still ticked", control.ids.at(-1) === "reviewed" && control.checked.includes("reviewed"));
  check("the counter is still a count of COLUMNS", control.count, `${COLUMN_COUNT}/${COLUMN_COUNT}`);
  const controlShot = await shot(page, "control-both-switches-2400x1000");
  await page.keyboard.press("Escape");
  await waitFor(async () => page.evaluate(() => document.getElementById("settings")?.classList.contains("hidden")), { timeoutMs: 5000, what: "the drawer to close" });

  // ---- 2. both chips on: one in the name line, one in its own cell ------------------------------------
  const on = await rowState(page);
  ok("the row is found", Boolean(on));
  ok("the header carries a Reviewed (extra) column", Boolean(on?.extraHeader));
  check("…drawn immediately right of Worktree", (on?.cols || []).slice(0, 3), ["name", "reviewedExtra", "branch"]);
  ok("the row draws a cell for it", on?.hasExtraCell === true);
  ok("the RESULT chip is inside that cell", on?.chipInExtra === true, on?.chipLabel);
  ok("…and NOT inside the name cell - the name is never blocked by it", on?.chipInNameCell === false);
  check("both review chips are on this row at once", [on?.marks, on?.presses, on?.chipInExtra], [1, 1, true]);
  ok("the row still wears the amber edge", on?.amber === true);
  ok("the name is drawn WHOLE beside both chips", on?.nameWhole === true, `${on?.nameShown} · name ${on?.nameBox?.client}/${on?.nameBox?.scroll}px · cell content ${on?.nameCellContent}px`);
  const onShot = await shotRow(page, "row-both-chips-on-2400x1000");
  await shot(page, "board-both-chips-on-2400x1000");

  // ---- 3. Reviewed (extra) OFF: the whole cell goes, the OTHER chip stays -----------------------------
  await openSettings(page);
  await page.evaluate(() => document.getElementById("chart-cols-row")?.scrollIntoView({ block: "center" }));
  await box(page, "reviewedExtra").click();
  const stored = await waitFor(async () => JSON.stringify(readConfig().hiddenColumns) === JSON.stringify(["reviewedExtra"]), { timeoutMs: 20_000, what: "config.json to store Reviewed (extra)" });
  ok("unticking Reviewed (extra) stores its own id in the same hiddenColumns list", stored, JSON.stringify(readConfig().hiddenColumns));
  await page.keyboard.press("Escape");
  await waitFor(async () => (await rowState(page))?.hasExtraCell === false, { timeoutMs: 20_000, what: "the rows to repaint without the cell" });
  const off = await rowState(page);
  ok("the header is gone", off?.extraHeader === false);
  ok("every row's cell is gone - no empty cell is left anywhere", off?.extraCellsOnBoard === 0);
  ok("the row is one cell shorter", off?.cells === on.cells - 1, `${off?.cells} vs ${on?.cells}`);
  check("…and nothing on the row is an empty cell", off?.emptyTds, 0);
  check("the amber mark and its press are UNTOUCHED by that switch", [off?.marks, off?.presses], [1, 1]);
  ok("…with the amber edge still on the row", off?.amber === true);
  ok("the name is still drawn whole", off?.nameWhole === true, `${off?.nameShown} · name ${off?.nameBox?.client}/${off?.nameBox?.scroll}px · cell content ${off?.nameCellContent}px`);
  const offShot = await shotRow(page, "row-reviewed-extra-off-2400x1000");

  // ---- 4. a reload keeps it off; ticking it back on restores the cell ---------------------------------
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(async () => (await page.locator("section.project[data-project]").count()) > 0, { timeoutMs: 90_000, what: "the project after a reload" });
  await openProjects(page);
  await waitFor(async () => (await page.locator("section.project[data-project] tr.row").count()) >= 2, { timeoutMs: 30_000, what: "the rows after a reload" });
  const afterReload = await waitFor(async () => (await rowState(page))?.hasExtraCell === false, { timeoutMs: 30_000, what: "the column still off after a reload" });
  ok("a reload draws no Reviewed (extra) cell: the choice is the panel's, not the tab's", afterReload);
  await openSettings(page);
  await page.evaluate(() => document.getElementById("chart-cols-row")?.scrollIntoView({ block: "center" }));
  const reloadedControl = await controlState(page);
  ok("…and its box reads back unticked, with the amber chip still ticked", !reloadedControl.checked.includes("reviewedExtra") && reloadedControl.checked.includes("reviewed"));
  await box(page, "reviewedExtra").click();
  ok("ticking it again brings the cell back", await waitFor(async () => (await rowState(page))?.chipInExtra === true, { timeoutMs: 20_000, what: "the cell to come back" }));

  // ---- 5. the amber chip OFF instead: the extra cell and its chip stay --------------------------------
  await box(page, "reviewed").click();
  const amberOff = await waitFor(async () => JSON.stringify(readConfig().hiddenColumns) === JSON.stringify(["reviewed"]), { timeoutMs: 20_000, what: "config.json to store the amber chip" });
  ok("unticking Reviewed stores the amber chip's id", amberOff, JSON.stringify(readConfig().hiddenColumns));
  await page.keyboard.press("Escape");
  await waitFor(async () => (await rowState(page))?.marks === 0, { timeoutMs: 20_000, what: "the amber mark to leave" });
  const other = await rowState(page);
  check("the amber mark and press are gone", [other?.marks, other?.presses, other?.amber], [0, 0, false]);
  ok("the Reviewed (extra) cell and its result chip are still drawn", other?.chipInExtra === true);
  const amberOffShot = await shotRow(page, "row-amber-off-extra-on-2400x1000");
  // put it back, so a re-run of this gate starts from the shipped layout
  await openSettings(page);
  await page.evaluate(() => document.getElementById("chart-cols-row")?.scrollIntoView({ block: "center" }));
  await box(page, "reviewed").click();
  ok("ticking the amber chip back on empties the stored list again", await waitFor(async () => JSON.stringify(readConfig().hiddenColumns) === JSON.stringify([]), { timeoutMs: 20_000, what: "the stored list to clear" }));

  ok("no page error along the way", errors.length === 0, errors.slice(0, 3).join(" | "));
  note(`shots: ${[controlShot, onShot, offShot, amberOffShot].map((f) => path.basename(f)).join(", ")}`);
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
