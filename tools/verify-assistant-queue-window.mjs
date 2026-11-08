// HARNESS: LIVE GATE
// The Queue sub-tab's WINDOW: the newest 20 tasks on open, "Load 50 more" appending 50 per press, the control retiring
// at the end of the list, and the window surviving a repaint.
//
//   node tools/verify-assistant-queue-window.mjs
//
// Why a browser: the window is client-side state read by a painter that rebuilds the pane's innerHTML on every board
// tick and after every action. A unit test can prove the arithmetic; only the real page proves the count lives OUTSIDE
// that painter. This gate seeds 121 tasks (120 done + 1 queued), drives the real float, and forces THREE repaints -
// `window.applyAssistant` with a fresh /api/state snapshot (the entry point a board tick calls), the pane's Refresh
// control (a re-read), and a task action (Start) - checking the row count and the control after each. It also counts
// the pane's own childList mutations, so a "repaint" that never rebuilt the pane cannot pass as evidence.
//
// A sandbox of its own: `tools/panel-testkit.mjs` gives it a throwaway data directory and a free port, the queue is
// seeded through the route's own file path, `assistant.enabled` is false and `apiServer` is a dead port so nothing can
// spawn a run. The live board on 7331 is never touched (its listener count is compared before and after).
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROOT, freePort, waitFor } from "./panel-testkit.mjs";
import { loadPlaywright } from "./browser.mjs";

const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 240_000);
const watchdog = setTimeout(() => {
  try {
    process.stderr.write(`WATCHDOG: ${WATCHDOG_MS}ms elapsed without the run finishing - see the last line printed above.\n`);
  } catch {
    /* nothing left to do */
  }
  process.exit(1);
}, WATCHDOG_MS);

let failures = 0;
let checks = 0;
const check = (name, got, want) => {
  checks += 1;
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
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
const slash = (p) => String(p || "").replace(/\\/g, "/");
const listenersOn = (port) => {
  let out = "";
  try {
    out = execSync("netstat -ano", { encoding: "utf8", windowsHide: true });
  } catch (e) {
    out = String((e && e.stdout) || "");
  }
  return out.split(/\r?\n/).filter((l) => l.includes(`:${port} `) && l.includes("LISTENING")).length;
};

// The seed: 120 finished tasks and one queued task with the highest id, so the QUEUED row is the newest task and the
// twenty-row window is ids 102..121. Titles are unique, which is what lets a row be named when a count disagrees.
const now = Date.now();
const iso = (min) => new Date(now - min * 60_000).toISOString();
const DONE = 120;
const TOTAL = DONE + 1;
const WINDOW = 20;
const MORE = 50;
const SEED = Array.from({ length: DONE }, (_, i) => ({
  id: i + 1,
  title: `finished task ${i + 1}`,
  state: "done",
  files: [],
  doneAt: iso(DONE - i),
  doneBy: "panel",
})).concat([{ id: TOTAL, title: "the task at the top of the queue", state: "queued", files: [], createdAt: iso(1) }]);

let panel = null;
let liveBrowser = null;
try {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-queue-window-"));
  const repos = path.join(dir, "repos");
  const home = path.join(dir, "hermes-home");
  const configDir = path.join(dir, "panel");
  const cwdDir = path.join(dir, "panel-cwd");
  for (const d of [repos, home, configDir, path.join(configDir, "logs"), cwdDir]) mkdirSync(d, { recursive: true });

  const liveBefore = listenersOn(7331);
  const port = await freePort();
  ok("the sandbox port is not the live one", port !== 7331, `port ${port}`);
  note(`temp root ${dir}`);

  const configPath = path.join(configDir, "config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        port,
        host: "127.0.0.1",
        scanRoots: [repos],
        refreshSeconds: 2,
        worktreeSeconds: 2,
        midSeconds: 2,
        threads: 1,
        scanMode: "all",
        defaultCwd: cwdDir,
        projectsCacheFile: path.join(configDir, "logs", "projects.json"),
        apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
        assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const base = `http://127.0.0.1:${port}`;
  const panelLog = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: home, PANEL_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  child.stderr.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  panel = {
    base,
    port,
    dir,
    log: () => panelLog.join("\n"),
    stop: async () => {
      child.kill();
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, { timeoutMs: 15_000, stepMs: 200, what: "the panel to exit" });
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        /* Windows can hold a file for a moment; the run's verdict does not depend on the cleanup */
      }
    },
  };
  const up = await waitFor(async () => (await fetch(`${base}/api/health`)).ok, { timeoutMs: 90_000, stepMs: 300, what: "the sandbox panel to answer /api/health" });
  if (!up) throw new Error(`the sandbox panel never came up on ${base}\n${panelLog.slice(-15).join("\n")}`);
  ok("the sandbox is bound on its own port", listenersOn(port) >= 1, `${listenersOn(port)} listener(s) on :${port}`);

  const GET = async (p) => {
    const r = await fetch(`${base}${p}`);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const POST = async (p, body) => {
    const r = await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  console.log("\n== the sandbox: 120 finished tasks and one queued == ");
  const first = await GET("/api/assistant/queue?assistantId=assistant-1");
  const file = first.body?.queue?.file;
  ok("the route names the queue file it will read", Boolean(file) && existsSync(file), slash(file));
  writeFileSync(file, `${JSON.stringify({ version: 1, nextId: TOTAL + 1, tasks: SEED }, null, 1)}\n`, "utf8");
  const seeded = (await GET("/api/assistant/queue?assistantId=assistant-1")).body?.queue || null;
  check("the seed is read back as 121 tasks", [seeded?.counts?.total, seeded?.counts?.done, seeded?.counts?.queued], [TOTAL, DONE, 1]);
  const dock = await POST("/api/settings/general", { dockMode: "floating" });
  ok("the float is the frame this gate drives", dock.status === 200 && dock.body?.settings?.dockMode === "floating", JSON.stringify(dock.body?.settings?.dockMode || dock.body?.error));

  const pw = loadPlaywright();
  if (!pw) throw new Error("BROWSER-HALF-NOT-RUN - no Playwright install; set PANEL_PLAYWRIGHT_ROOT to a dir holding node_modules/playwright");
  const pageErrors = [];
  liveBrowser = await pw.chromium.launch({ headless: true });
  const context = await liveBrowser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${String((e && e.message) || e)}`));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
  });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#btn-assistant", { state: "visible" });
  await page.click("#btn-assistant");
  await page.waitForSelector("#assistant", { state: "visible" });
  await page.waitForSelector('#as-subtabs [data-as-subtab="queue"]', { state: "visible" });
  await page.click('#as-subtabs [data-as-subtab="queue"]');
  await page.waitForSelector("#as-queue:not(.hidden)");

  const ids = () => page.$$eval("#as-queue .as-task", (els) => els.map((e) => Number(e.dataset.asQrow)));
  const rows = () => page.locator("#as-queue .as-task").count();
  const moreBtn = () => page.locator("#as-queue .as-qmore-btn");
  const moreText = async () => ((await moreBtn().count()) ? (await moreBtn().innerText()).trim() : "");
  const moreNote = async () =>
    (await page.locator("#as-queue .as-qmore-note").count()) ? (await page.locator("#as-queue .as-qmore-note").innerText()).trim() : "";
  const settled = (want) => waitFor(async () => ((await rows()) === want ? want : 0), { timeoutMs: 25_000, stepMs: 150, what: `${want} rows` });

  // Count the pane's own rebuilds: a count that survives without one of these is not proof of a repaint.
  const watchRepaints = () =>
    page.evaluate(() => {
      window.__qrepaints = 0;
      const host = document.querySelector("#as-queue");
      new MutationObserver((records) => {
        for (const r of records) if (r.type === "childList") window.__qrepaints += 1;
      }).observe(host, { childList: true });
      return true;
    });
  const repaints = () => page.evaluate(() => Number(window.__qrepaints || 0));

  console.log("\n== 1. open: the newest 20, with the one control under them ==");
  await settled(WINDOW);
  const firstIds = (await ids()).sort((a, b) => a - b);
  check("twenty rows on open", firstIds.length, WINDOW);
  check("and they are the NEWEST twenty ids", firstIds, Array.from({ length: WINDOW }, (_, i) => TOTAL - WINDOW + 1 + i));
  ok("the newest task is drawn (the queued row)", (await ids()).includes(TOTAL), `ids ${JSON.stringify(firstIds)}`);
  check("the history reads newest first under the active row", (await ids()).slice(0, 3), [TOTAL, TOTAL - 1, TOTAL - 2]);
  check("the control is named for what it appends", await moreText(), `Load ${MORE} more`);
  check("and says how much is still hidden", await moreNote(), `${TOTAL - WINDOW} older tasks not shown`);

  await watchRepaints();
  console.log("\n== 2. a repaint from the page's own tick entry point keeps the window ==");
  const tick = await page.evaluate(async () => {
    const r = await fetch("/api/state");
    const s = await r.json();
    if (!s.assistant) return "no assistant payload";
    window.applyAssistant(s.assistant);
    return "applied";
  });
  check("applyAssistant carried a fresh snapshot", tick, "applied");
  await page.waitForTimeout(250);
  ok("the tick repainted the pane", (await repaints()) > 0, `${await repaints()} childList rebuild(s)`);
  check("and the window is still the newest twenty", (await ids()).sort((a, b) => a - b), firstIds);

  console.log("\n== 3. one press appends fifty ==");
  const beforePressRepaints = await repaints();
  await moreBtn().click();
  await settled(WINDOW + MORE);
  check("seventy rows after one press", await rows(), WINDOW + MORE);
  check("the control now offers the next fifty", await moreText(), `Load ${MORE} more`);
  check("and the note counts what is left", await moreNote(), `${TOTAL - WINDOW - MORE} older tasks not shown`);
  ok("the press rebuilt the pane", (await repaints()) > beforePressRepaints, `${beforePressRepaints} -> ${await repaints()}`);
  check("the rows already on screen keep their place", (await ids()).slice(0, 2), [TOTAL, TOTAL - 1]);
  check("and the older fifty land under them", (await ids()).slice(-2), [TOTAL - WINDOW - MORE + 2, TOTAL - WINDOW - MORE + 1]);
  const shots = path.join(ROOT, ".shots");
  mkdirSync(shots, { recursive: true });
  await moreBtn().scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(shots, "queue-window-70.png") });
  await page.locator("#as-queue .as-qmore").screenshot({ path: path.join(shots, "queue-load-more.png") });

  console.log("\n== 4. the window survives every repaint the tab does ==");
  const held = (await ids()).sort((a, b) => a - b);
  const beforeTick = await repaints();
  await page.evaluate(async () => {
    const s = await (await fetch("/api/state")).json();
    window.applyAssistant(s.assistant);
  });
  await page.waitForTimeout(250);
  ok("a board tick repaints the pane", (await repaints()) > beforeTick, `${beforeTick} -> ${await repaints()}`);
  check("and it still shows seventy", (await ids()).sort((a, b) => a - b), held);

  const beforeRefresh = await repaints();
  await page.click('#as-queue [data-as-qact="reload"]');
  await page.waitForTimeout(500);
  ok("Refresh repaints the pane", (await repaints()) > beforeRefresh, `${beforeRefresh} -> ${await repaints()}`);
  check("and it still shows seventy", (await ids()).sort((a, b) => a - b), held);

  const beforeAction = await repaints();
  await page.click(`#as-queue .as-task[data-as-qrow="${TOTAL}"] [data-as-qact="running"]`);
  const moved = await waitFor(async () => ((await page.getAttribute(`#as-queue .as-task[data-as-qrow="${TOTAL}"]`, "data-as-qstate")) === "running" ? "running" : 0), {
    timeoutMs: 20_000,
    stepMs: 150,
    what: "the action to repaint the row as running",
  });
  check("a task action repaints the row", moved, "running");
  ok("and it rebuilt the pane", (await repaints()) > beforeAction, `${beforeAction} -> ${await repaints()}`);
  check("the window still shows seventy", (await ids()).sort((a, b) => a - b), held);

  console.log("\n== 5. the control retires at the end of the list ==");
  await moreBtn().click();
  await settled(WINDOW + MORE + MORE);
  check("a second press reaches 120", await rows(), WINDOW + MORE + MORE);
  check("the last press offers the remainder, not a full fifty", await moreText(), "Load 1 more");
  check("and the note names the one left", await moreNote(), "1 older task not shown");
  await moreBtn().click();
  await settled(TOTAL);
  check("the third press reaches the whole list", await rows(), TOTAL);
  check("the control is gone", await moreBtn().count(), 0);
  await page.evaluate(async () => {
    const s = await (await fetch("/api/state")).json();
    window.applyAssistant(s.assistant);
  });
  await page.waitForTimeout(250);
  check("a repaint does not bring it back", await moreBtn().count(), 0);
  check("and all 121 rows are still drawn", await rows(), TOTAL);
  await page.screenshot({ path: path.join(shots, "queue-window-end.png") });

  console.log("\n== 6. and the page stayed clean ==");
  check("no page errors", pageErrors, []);

  const liveAfter = listenersOn(7331);
  ok("the live board on 7331 was not disturbed", liveAfter === liveBefore, `${liveBefore} -> ${liveAfter} listener(s)`);
} catch (err) {
  failures += 1;
  console.log(`\nFAIL  the gate threw: ${String((err && err.stack) || err)}`);
} finally {
  clearTimeout(watchdog);
  try {
    if (liveBrowser) await liveBrowser.close();
  } catch {
    /* closing a crashed browser is not a second failure */
  }
  if (panel) {
    console.log("\n== cleanup == ");
    try {
      await panel.stop();
      ok("the sandbox panel stopped and its temp dir is gone", !existsSync(panel.dir), panel.dir);
    } catch (err) {
      ok("the sandbox panel stopped", false, String((err && err.message) || err));
    }
  }
  console.log(`\nRESULT ${failures ? "FAIL" : "PASS"} - ${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}
