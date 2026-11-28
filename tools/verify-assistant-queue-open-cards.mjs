// HARNESS: LIVE GATE
// The Queue sub-tab draws ONE CARD PER OPEN ROW, and the cards drawn agree with the store.
//
//   node tools/verify-assistant-queue-open-cards.mjs
//
// The defect this gate was written for, measured by the reader on the live panel: the tab's own caption read
// "4 queued - 5 running - 1 parked - 190 done" while the list under it drew TWO running cards (#438 and #443) and no
// card at all for #402, #404 and #411 - three running rows, three live runs, invisible. The caption is built from the
// store's counts and the list from a WINDOW, and the window counted from the newest task id, so an open row older than
// the twenty newest ids fell out of the list while it stayed in the counts. A reader scanning the tab concluded one
// agent was working.
//
// So this gate seeds the shape the reader photographed - 190 finished rows, five RUNNING rows whose ids sit under the
// newest twenty (402, 404, 411, 438, 443), one parked and four queued - and asserts, against the real page:
//
//   1. the store's counts and the caption agree (one read of the route, the same numbers on screen);
//   2. the drawn cards agree with the store: every running row has a card, each carries its own agent line and its own
//      run chip, and the drawn running count equals counts.running (five, not two);
//   3. the two REPAINT cases: a row flipped to running through the route draws its card within one poll, and a page
//      open while two rows were queued shows both running after the page's own poll - no reload, no reader press;
//   4. what the window still hides is finished history, and it says so: "showing N of M" beside the count it hides.
//
// A sandbox of its own: `tools/panel-testkit.mjs` gives it a throwaway data directory and a free port, the queue is
// seeded through the route's own file path, `assistant.enabled` is false and `apiServer` is a dead port so nothing can
// spawn a run. The live board on 7331 is never touched (its listener count is compared before and after).
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// THE SEED, in the reader's shape: 200 CONTIGUOUS ids (244..443, the panel hands them out in order), 190 finished rows,
// five RUNNING rows and four queued, one parked. Three of the running rows (402, 404, 411) and the parked row (300) and
// one queued row (420) are OLDER than the newest twenty ids (424..443) - the three the live tab lost entirely. #438 and
// #443 are the two it kept, so a window that "works" still passes the wrong test: the ten together are the acceptance.
const now = Date.now();
const iso = (min) => new Date(now - min * 60_000).toISOString();
const FIRST_ID = 244;
const LAST_ID = 443;
const RUNNING = [
  { id: 402, runId: "93efaeb8" },
  { id: 404, runId: "ec0d0e41" },
  { id: 411, runId: "83bc09f1" },
  { id: 438, runId: "ae51c6a7" },
  { id: 443, runId: "5c1d0b92" },
];
const PARKED = 300;
const QUEUED = [420, 425, 430, 435];
const WINDOW = 20;
const OLDEST_KEPT = LAST_ID - WINDOW + 1; // 424 - the id the window's own arithmetic starts at
const OPEN = new Set([...RUNNING.map((r) => r.id), PARKED, ...QUEUED]);
const DONE = LAST_ID - FIRST_ID + 1 - OPEN.size;
const TOTAL = LAST_ID - FIRST_ID + 1;
const SEED = [];
for (let id = FIRST_ID; id <= LAST_ID; id += 1) {
  if (RUNNING.some((r) => r.id === id)) {
    const r = RUNNING.find((x) => x.id === id);
    SEED.push({
      id,
      title: `running task ${id}`,
      state: "running",
      files: [],
      thread: `wtgui-row-${id}`,
      threads: [`wtgui-row-${id}`],
      runId: r.runId,
      runStatus: "running",
      runBy: "run",
      startedAt: iso(30),
    });
  } else if (id === PARKED) {
    SEED.push({ id, title: `parked task ${id}`, state: "parked", files: [], reason: "waiting on the reader", createdAt: iso(60) });
  } else if (QUEUED.includes(id)) {
    SEED.push({
      id,
      title: `queued task ${id}`,
      state: "queued",
      files: [],
      thread: `wtgui-row-${id}`,
      threads: [`wtgui-row-${id}`],
      runId: `run_${id}`,
      runStatus: "running",
      runBy: "run",
      createdAt: iso(5),
    });
  } else {
    SEED.push({ id, title: `finished task ${id}`, state: "done", files: [], doneAt: iso(LAST_ID - id), doneBy: "panel" });
  }
}

let panel = null;
let liveBrowser = null;
try {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-queue-open-"));
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

  console.log("\n== the sandbox: the reader's queue, 190 finished and ten open ==");
  const first = await GET("/api/assistant/queue?assistantId=assistant-1");
  const file = first.body?.queue?.file;
  ok("the route names the queue file it will read", Boolean(file) && existsSync(file), slash(file));
  writeFileSync(file, `${JSON.stringify({ version: 1, nextId: TOTAL + 1, tasks: SEED }, null, 1)}\n`, "utf8");
  const seeded = (await GET("/api/assistant/queue?assistantId=assistant-1")).body?.queue || null;
  const store = seeded?.counts || {};
  check("the seed reads back as the store's counts", [store.total, store.queued, store.running, store.parked, store.done], [TOTAL, QUEUED.length, RUNNING.length, 1, DONE]);

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

  // The cards as the page has them: every drawn row's id, its state attribute (the RECORD's state, not the word the
  // decoration prints), and whether it carries an agent line and a run chip.
  const drawn = () =>
    page.$$eval("#as-queue .as-task", (els) =>
      els.map((e) => {
        const chip = e.querySelector("[data-as-qrun]");
        return {
          id: Number(e.dataset.asQrow),
          state: e.dataset.asQstate || "",
          agents: e.querySelectorAll(".as-task-agent").length,
          run: chip ? chip.getAttribute("data-as-qrun") : "",
        };
      }),
    );
  const byState = (cards) => {
    const out = { queued: 0, running: 0, parked: 0, done: 0 };
    for (const c of cards) if (out[c.state] !== undefined) out[c.state] += 1;
    return out;
  };
  const caption = async () => ((await page.locator("#as-queue .as-qcounts").count()) ? (await page.locator("#as-queue .as-qcounts").innerText()).trim() : "");
  const noteText = async () =>
    (await page.locator("#as-queue .as-qmore-note").count()) ? (await page.locator("#as-queue .as-qmore-note").innerText()).trim() : "";
  const stateOf = async (id) => ((await page.locator(`#as-queue .as-task[data-as-qrow="${id}"]`).count()) ? await page.getAttribute(`#as-queue .as-task[data-as-qrow="${id}"]`, "data-as-qstate") : "(no card)");

  console.log("\n== 1. the caption is the store's own numbers ==");
  await waitFor(async () => ((await page.locator("#as-queue .as-task").count()) > 0 ? 1 : 0), { timeoutMs: 25_000, stepMs: 150, what: "the pane to draw its first cards" });
  // The caption is built from the store's counts, so it is compared with the same payload's numbers rather than a
  // literal: these seeded rows carry run ids and no gateway job behind them, so the store reports them STALE as well as
  // running (five running, five stale), and the caption is expected to carry that clause exactly as it does live.
  const captionOf = (c) =>
    `${c.queued || 0} queued · ${c.running || 0} running${c.stale ? `, ${c.stale} stale` : ""} · ${c.parked || 0} parked · ${c.done || 0} done`;
  check("the caption reads the store's counts", await caption(), captionOf(store));

  console.log("\n== 2. drawn cards against the store: every OPEN row has one ==");
  const cards = await drawn();
  const seen = byState(cards);
  note(`store: queued ${store.queued}, running ${store.running}, parked ${store.parked}, done ${store.done} (${store.total} rows)`);
  note(`drawn: queued ${seen.queued}, running ${seen.running}, parked ${seen.parked}, done ${seen.done} (${cards.length} cards)`);
  note(`the window's own arithmetic starts at #${OLDEST_KEPT}: #402, #404, #411 (running), #${PARKED} (parked) and #${QUEUED[0]} (queued) sit under it`);
  check("drawn cards agree with the store, state for state", [seen.queued, seen.running, seen.parked], [store.queued, store.running, store.parked]);
  check("the drawn open cards are exactly the store's open rows", seen.queued + seen.running + seen.parked, store.queued + store.running + store.parked);
  check("and the drawn running count is the store's", seen.running, store.running);
  const drawnIds = cards.map((c) => c.id);
  for (const r of RUNNING) ok(`#${r.id} (running, run ${r.runId}) is drawn`, drawnIds.includes(r.id), drawnIds.includes(r.id) ? "card present" : `no card - drawn ids ${JSON.stringify(drawnIds.slice(0, 8))}...`);
  for (const r of RUNNING) {
    const card = cards.find((c) => c.id === r.id) || {};
    ok(`#${r.id} carries its own agent line`, Number(card.agents) >= 1, `${card.agents || 0} agent line(s)`);
    check(`#${r.id} carries its own run chip`, card.run, r.runId);
  }
  const doneDrawn = cards.filter((c) => c.state === "done").length;
  check("the finished history is still windowed to the newest twenty", doneDrawn, WINDOW);

  console.log("\n== 3. what the window hides is history, and it says so ==");
  check("the note names what is drawn against the whole queue", await noteText(), `showing ${cards.length} of ${TOTAL} - ${DONE - WINDOW} older tasks not shown`);

  console.log("\n== 4. REPAINT: a row flipped to running through the route draws its card within one poll ==");
  // #420 is queued and sits UNDER the newest twenty ids, so the pre-fix pane drew no card for it at all. The write goes
  // through the route (the panel's own path), which emits an assistant frame - the page must not wait for the pane's
  // twenty-second clock, and must not need a reload.
  check(`#${QUEUED[0]} is drawn as queued before the flip`, await stateOf(QUEUED[0]), "queued");
  const flip1 = await POST("/api/assistant/queue", { assistantId: "assistant-1", action: "state", id: QUEUED[0], state: "running", by: "gate" });
  check("the route accepted the flip", flip1.status, 200);
  const t1 = Date.now();
  const appeared = await waitFor(async () => ((await stateOf(QUEUED[0])) === "running" ? 1 : 0), { timeoutMs: 8_000, stepMs: 150, what: `#${QUEUED[0]} to draw as running without a reload` });
  ok(`#${QUEUED[0]} draws as running within one poll`, appeared === 1, `${Date.now() - t1} ms after the write, no reload`);
  const after1 = byState(await drawn());
  check("and the drawn running count moves with the store", [after1.running, (await GET("/api/assistant/queue?assistantId=assistant-1")).body?.queue?.counts?.running], [RUNNING.length + 1, RUNNING.length + 1]);

  console.log("\n== 5. REPAINT: a page open while two rows were queued shows both running after the next poll ==");
  // Two rows are still queued on screen. The queue file is written by something that is NOT this panel (a script, a
  // worker, another panel) - no assistant frame rides that - and the page's own poll is what has to catch it.
  const raw = JSON.parse(readFileSync(file, "utf8"));
  for (const id of [QUEUED[1], QUEUED[2]]) {
    const row = raw.tasks.find((t) => Number(t.id) === id);
    row.state = "running";
    row.startedAt = new Date().toISOString();
    row.runId = `run_script_${id}`;
  }
  writeFileSync(file, `${JSON.stringify(raw, null, 1)}\n`, "utf8");
  const beforePoll = await stateOf(QUEUED[1]);
  check("the two rows still read queued before the poll", [beforePoll, await stateOf(QUEUED[2])], ["queued", "queued"]);
  const t2 = Date.now();
  await page.evaluate(async () => {
    if (typeof window.resync === "function") await window.resync();
    else throw new Error("the page has no resync - the poll entry point this gate drives");
  });
  const flipped = await waitFor(
    async () => {
      const a = await stateOf(QUEUED[1]);
      const b = await stateOf(QUEUED[2]);
      return a === "running" && b === "running" ? 1 : 0;
    },
    { timeoutMs: 8_000, stepMs: 150, what: "both rows to draw as running after one poll" },
  );
  ok("both rows draw as running after one poll", flipped === 1, `${Date.now() - t2} ms after the page's own resync, no reload`);
  const after2 = byState(await drawn());
  const storeNow = (await GET("/api/assistant/queue?assistantId=assistant-1")).body?.queue?.counts || {};
  note(`store now: running ${storeNow.running}, queued ${storeNow.queued}`);
  note(`drawn now: running ${after2.running}, queued ${after2.queued}, parked ${after2.parked}`);
  check("the drawn running count is the store's, after both repaints", after2.running, storeNow.running);

  const shots = path.join(ROOT, ".shots");
  mkdirSync(shots, { recursive: true });
  await page.locator("#as-queue .as-task").first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(shots, "queue-open-cards.png") });

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
    console.log("\n== cleanup ==");
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
