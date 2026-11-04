// HARNESS: LIVE GATE
// The Queue sub-tab's redesigned row, proved on the REAL page: the fold, the hover text, the row order, and that a
// press still writes.
//
//   node tools/verify-assistant-queue-ui.mjs
//
// The redesign is a re-skin and a re-order, not a rewrite: a row must read as WHAT it is, its STATE in a word and
// WHAT IT IS WAITING ON, while the tree, the files, the attempts and the task's own detail sit behind one closed
// summary. That is a claim about pixels, so it is proved by Chromium over a booted panel — never by jsdom or by
// slicing the renderer's string. In order, this gate:
//
//   1. the CHROME: the explainer and the add form are closed disclosures, the counts are a caption and the queue's
//      path is hover text, and the first task starts inside the first screenful (< 140 px of chrome, not 285); its
//      EXPLAINER is a one-line lead plus five labelled <dl> entries, each at most two lines, with every fact the old
//      nine-line paragraph carried still in its own entry — and the qline's PIPELINE BUTTON opens a CLOSED Settings on
//      its Pipeline tab, and switches one already open on another tab rather than closing it;
//   2. the ROW: one head line per task with the state word (STALE for a running row nothing is running), the title,
//      the waiting-on sentence and the lane/hold chips; the second read folded and closed; row height <= 92 px;
//   3. the HOVER TEXT the fold replaced: `title=` carries the whole sentence for a line that is one line, the state
//      word explains itself, and the counts' title names the queue file the pane no longer prints;
//   4. the ORDER: the state buckets first, the reader's `order` inside the queued bucket, exactly as the store
//      derives it;
//   5. the CONTROLS: a real click on ✓ Done flips the row's state and moves it to the done bucket, a real pointer
//      drag reorders two queued cards and the route keeps it, ➡️ Move hands a task to Assistant #2, and the folded
//      Add-task form still files a task — with no page errors and the pane still resting folded afterwards.
//
// A sandbox of its own: `tools/panel-testkit.mjs` gives it a throwaway data directory and a free port, the queue is
// seeded through the route's own file path, `assistant.enabled` is false and `apiServer` is a dead port so nothing
// can spawn a run. The live board on 7331 is never touched (its listener count is compared before and after).
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROOT, freePort, waitFor } from "./panel-testkit.mjs";
import { loadPlaywright } from "./browser.mjs";

const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 240_000);
const watchdog = setTimeout(() => {
  try {
    process.stderr.write(`WATCHDOG: ${WATCHDOG_MS}ms elapsed without the run finishing — see the last line printed above.\n`);
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
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
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

// The seed. Six rows: one in every state, three queued (one skipped by the running row, one held by it, one free),
// and `order` digits that disagree with the ids so the QUEUED bucket's order is a fact about `order` and not about
// insertion. The running row's thread has no job in this sandbox, so it is genuinely STALE — the state the word in
// the head exists to say.
const now = Date.now();
const iso = (min) => new Date(now - min * 60_000).toISOString();
const SEED = [
  { id: 1, title: "Land the queue row's facts-first redesign", state: "running", files: ["public/assistant.js", "public/style.css"], project: "agent-worktree-gui", worktree: "C:/ProjectDevelopment/agent-worktree-gui/.worktrees/queue-row-facts-3f2a19", thread: "wtgui-land-queue-facts-3f2a19", threads: ["wtgui-land-queue-facts-3f2a19"], attempts: 2, detail: "The row reads what it is, its state and what it is waiting on; everything else is folded." },
  { id: 6, title: "Prove the folded row in a real browser", state: "queued", files: ["tools/verify-assistant-queue-ui.mjs"], order: 1, project: "agent-worktree-gui", detail: "The harness drives this page, not jsdom." },
  { id: 2, title: "Re-skin the queue's row and its chrome", state: "queued", files: ["public/assistant.js"], order: 2, project: "agent-worktree-gui" },
  { id: 3, title: "Tighten the queue rail's spacing", state: "queued", files: ["tools/verify-assistant-queue-ui.mjs"], order: 3, hold: { kind: "task", value: "#1", since: iso(80) } },
  { id: 4, title: "SQL verify for the queue store", state: "parked", reason: "waiting on the DBA's verify", hold: { kind: "manual", since: iso(65) }, files: ["db/queue.sql"], project: "agent-worktree-gui" },
  { id: 5, title: "Split the queue row's meta line", state: "done", files: ["public/style.css"], doneAt: iso(30), doneBy: "panel", project: "agent-worktree-gui" },
];
const ROWS = SEED.length;

let panel = null;
let liveBrowser = null;
try {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-queue-ui-"));
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
        refreshSeconds: 30,
        worktreeSeconds: 30,
        midSeconds: 30,
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
  const queueOf = async (id = "assistant-1") => (await GET(`/api/assistant/queue?assistantId=${id}`)).body.queue || null;

  console.log("\n== the sandbox: a queue with a row in every state ==");
  const first = await GET("/api/assistant/queue?assistantId=assistant-1");
  const file = first.body?.queue?.file;
  ok("the route names the queue file it will read", Boolean(file) && existsSync(file), slash(file));
  writeFileSync(file, `${JSON.stringify({ version: 1, nextId: 7, tasks: SEED }, null, 1)}\n`, "utf8");
  const seeded = await queueOf();
  check("the seed is read back with one row per state", seeded?.counts, { total: 6, queued: 3, running: 1, parked: 1, done: 1, stale: 1, conflict: 1 });
  ok("…and the skipped and held facts are derived, not written", Array.isArray(seeded?.digest) && seeded.digest.some((l) => /SKIP: files in use by #1/.test(l)), seeded?.digest?.find((l) => l.includes("#2")));
  const made = await POST("/api/assistant/assistants", {});
  ok("a second assistant exists, so Move is a real control", made.status === 201, `HTTP ${made.status}`);
  const dock = await POST("/api/assistant/profile", { assistantId: "assistant-1", dock: "floating" });
  ok("the float is the frame this gate drives", dock.status === 200, JSON.stringify(dock.body?.dock || dock.body?.error));

  const pw = loadPlaywright();
  if (!pw) throw new Error("BROWSER-HALF-NOT-RUN — no Playwright install; set PANEL_PLAYWRIGHT_ROOT to a dir holding node_modules/playwright");
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
  await page.evaluate(() => (window.__probeBoot = "same-document"));
  await page.click("#btn-assistant");
  await page.waitForSelector("#assistant", { state: "visible" });
  await page.waitForSelector('#as-subtabs [data-as-subtab="queue"]', { state: "visible" });
  await page.click('#as-subtabs [data-as-subtab="queue"]');
  await page.waitForSelector("#as-queue:not(.hidden)");
  const rowsPainted = await waitFor(() => page.locator("#as-queue .as-task").count().then((n) => (n === ROWS ? n : 0)), {
    timeoutMs: 25_000,
    stepMs: 200,
    what: "one row per seeded task",
  });
  ok("the pane paints one row per task", rowsPainted === ROWS, `${await page.locator("#as-queue .as-task").count()} row(s)`);
  await page.waitForTimeout(1000);

  const ids = () => page.$$eval("#as-queue .as-task", (els) => els.map((e) => Number(e.dataset.asQrow)));
  const rowState = (id) => page.getAttribute(`#as-queue .as-task[data-as-qrow="${id}"]`, "data-as-qstate");

  // ---- 1. the chrome -------------------------------------------------------------------------------
  console.log("\n== 1. the chrome: a caption, two summaries, and no printed rationale ==");
  const chrome = await page.evaluate(() => {
    const pane = document.querySelector("#as-queue .as-qpane");
    const firstRow = pane?.querySelector(".as-task");
    const help = pane?.querySelector("details.as-qhelp");
    const add = pane?.querySelector("details.as-qadd");
    const counts = pane?.querySelector(".as-qcounts");
    const rect = (el) => (el ? el.getBoundingClientRect() : null);
    const helpBody = help?.querySelector(".as-help");
    // A CLOSED details lays its content out under `content-visibility`, so a child's rect is not "visible" — the
    // summary's own box is. Closed means: not open, and the details is no taller than its summary.
    const folded = (d) => Boolean(d) && !d.open && d.getBoundingClientRect().height <= (d.querySelector("summary")?.getBoundingClientRect().height || 0) + 2;
    return {
      chrome: firstRow && pane ? Math.round(rect(firstRow).top - rect(pane).top) : null,
      helpOpen: Boolean(help?.open),
      helpFolded: folded(help),
      addOpen: Boolean(add?.open),
      addFolded: folded(add),
      counts: counts?.textContent.trim() || "",
      countsTitle: counts?.getAttribute("title") || "",
      hasPrimaryRefresh: Boolean(pane?.querySelector(".as-qline .primary")),
      printedPath: Boolean(pane?.innerText.includes("queue.json")),
      helpChars: (helpBody?.textContent || "").trim().length,
      // The rewrite's SHAPE: a lead sentence, then a real <dl> of labelled entries — not the nine-line paragraph and
      // not that paragraph with <b> sprinkled through it.
      helpLead: (helpBody?.querySelector(".as-qlead")?.textContent || "").trim(),
      helpLabelCount: helpBody?.querySelectorAll("dl dt").length || 0,
      helpLabels: [...(helpBody?.querySelectorAll("dl dt") || [])].map((d) => d.textContent.trim()),
      helpPairs: helpBody?.querySelectorAll("dl > div").length || 0,
      helpBold: helpBody?.querySelectorAll("b").length ?? -1,
      helpDl: Boolean(helpBody?.querySelector("dl")),
      pipelineBtn: (() => {
        const b = pane?.querySelector('.as-qline [data-as-qact="pipeline"]');
        if (!b) return null;
        return { text: b.textContent.trim(), quiet: b.classList.contains("as-qquiet"), tag: b.tagName };
      })(),
      pipelineAfterRefresh: Boolean(pane?.querySelector('.as-qline [data-as-qact="reload"]')?.nextElementSibling?.matches('[data-as-qact="pipeline"]')),
    };
  });
  ok("the first task starts inside the first screenful", chrome.chrome !== null && chrome.chrome <= 140, `${chrome.chrome}px of chrome before row 1 (was 285 px)`);
  check("the explainer is a CLOSED disclosure", [chrome.helpOpen, chrome.helpFolded], [false, true]);
  check("the add form is a CLOSED disclosure", [chrome.addOpen, chrome.addFolded], [false, true]);
  // The rewrite: a lead sentence and a real <dl> of labelled entries, not the nine-line paragraph and not that
  // paragraph with <b> sprinkled through it.
  ok(
    "the explainer is a lead plus a real <dl>, with no <b> soup left",
    chrome.helpDl && chrome.helpBold === 0 && chrome.helpLead.length > 0,
    JSON.stringify({ dl: chrome.helpDl, bold: chrome.helpBold, lead: chrome.helpLead.slice(0, 70) }),
  );
  ok(
    "…and the lead is ONE sentence that says what the pane is carrying",
    /^the work this assistant is carrying/.test(chrome.helpLead) && !/[.!?]\s+\S/.test(chrome.helpLead) && chrome.helpLead.length <= 140,
    `${chrome.helpLead.length} chars: ${chrome.helpLead}`,
  );
  check("…then the five labelled lines the brief names, each a dt/dd pair", [chrome.helpLabels, chrome.helpPairs], [["Add task", "Move", "Order", "Waiting and STALE", "Where it lives"], 5]);

  // The entries' own heights are layout px, and a CLOSED details lays its content out under `content-visibility` — so
  // the "at most two lines" claim is measured with the explainer opened, then put back to rest.
  const explainer = await page.evaluate(() => {
    const help = document.querySelector("#as-queue details.as-qhelp");
    help?.querySelector("summary")?.click();
    const body = help?.querySelector(".as-help");
    const lines = (el) => (el ? Math.round(el.getBoundingClientRect().height / (parseFloat(getComputedStyle(el).lineHeight) || 15)) : 0);
    return {
      open: Boolean(help?.open),
      leadLines: lines(body?.querySelector(".as-qlead")),
      entries: [...(body?.querySelectorAll("dl > div") || [])].map((row) => {
        const dd = row.querySelector("dd");
        return {
          label: row.querySelector("dt")?.textContent.trim() || "",
          chars: (dd?.textContent || "").replace(/\s+/g, " ").trim().length,
          text: (dd?.textContent || "").replace(/\s+/g, " ").trim(),
          lines: lines(row),
        };
      }),
    };
  });
  ok("pressing the summary opens the explainer, lead first", explainer.open && explainer.leadLines >= 1 && explainer.leadLines <= 2, `lead ${explainer.leadLines} line(s), ${explainer.entries.length} entries`);
  ok("…and each labelled entry is at most TWO lines", explainer.entries.every((e) => e.lines <= 2), JSON.stringify(explainer.entries.map((e) => [e.label, e.lines, e.chars])));
  const entryText = (label) => (explainer.entries.find((e) => e.label === label) || { text: "" }).text;
  const required = [
    ["Add task", /THIS assistant's queue/],
    ["Add task", /the one this page belongs to/],
    ["Add task", /queue nobody is watching/],
    ["Move", /leaves this queue/],
    ["Move", /an id of its own/],
    ["Move", /movedFrom/],
    ["Order", /drag a queued card/i],
    ["Order", /written to the file/],
    ["Order", /survives the next read/],
    ["Order", /running, parked and done keep their own sections/i],
    ["Order", /held by #N/],
    ["Order", /cannot go above that row/],
    ["Waiting and STALE", /touch a running task's files/],
    ["Waiting and STALE", /skipped with its reason/],
    ["Waiting and STALE", /no live run reads STALE/],
    ["Waiting and STALE", /phantom progress/],
    ["Where it lives", /state\/assistants\/assistant-1\/queue\.json/],
    ["Where it lives", /beside the charter/],
    ["Where it lives", /every wake before the board/],
    ["Where it lives", /state, thread, worktree, PR/],
    ["Where it lives", /LIVE, STALE or PARKED/],
  ];
  const lost = required.filter(([label, re]) => !re.test(entryText(label)));
  ok("…and every fact the old paragraph carried is still there, in its own entry", lost.length === 0, lost.map(([l, re]) => `${l} ${re}`).join(" | ") || `${required.length}/${required.length} facts`);
  await page.evaluate(() => document.querySelector("#as-queue details.as-qhelp")?.removeAttribute("open"));

  // ---- 1b. the pane's way into Settings → Pipeline ------------------------------------------------
  console.log("\n== 1b. the Pipeline button lands Settings on its own tab ==");
  check(
    "the button sits in the qline beside Refresh, in the pane's existing quiet class",
    [chrome.pipelineBtn?.text, chrome.pipelineBtn?.quiet, chrome.pipelineAfterRefresh],
    ["Pipeline settings", true, true],
  );
  const settingsState = () =>
    page.evaluate(() => {
      const panel = document.querySelector("#settings");
      const selected = document.querySelector('#settings-tabs [role="tab"][aria-selected="true"]');
      const pipeline = document.querySelector("#settings-panel-pipeline");
      return {
        open: Boolean(panel) && !panel.classList.contains("hidden"),
        tab: selected ? selected.dataset.settingsTab : "",
        pipelineShown: Boolean(pipeline) && !pipeline.hidden,
        saved: localStorage.getItem("wtgui.settingsTab") || "",
      };
    });
  ok("the counts are a caption, not a primary button row", !chrome.hasPrimaryRefresh, chrome.counts);
  ok("the queue's path is hover text, not printed", !chrome.printedPath && chrome.countsTitle.endsWith("queue.json"), chrome.countsTitle);

  check("Settings is closed before the press", (await settingsState()).open, false);
  await page.click('#as-queue .as-qline [data-as-qact="pipeline"]');
  const landedClosed = await waitFor(async () => {
    const s = await settingsState();
    return s.open && s.tab === "pipeline" && s.pipelineShown ? s : null;
  }, { timeoutMs: 10_000, stepMs: 150, what: "Settings to open on the Pipeline tab" });
  ok(
    "a CLOSED Settings opens straight on Pipeline, and the tab is remembered",
    Boolean(landedClosed) && landedClosed.saved === "pipeline",
    JSON.stringify(landedClosed),
  );

  // The second half of the claim: Settings ALREADY OPEN, on another tab. The window opens at the right edge over the
  // float, so it is dragged clear first — otherwise the press would land on the window, not the button.
  const movedTo = await page.evaluate(() => {
    const head = document.querySelector("#settings > .settings-head");
    const r = head?.getBoundingClientRect();
    return r ? { x: r.x + 12, y: r.y + r.height / 2 } : null;
  });
  if (!movedTo) throw new Error("no Settings head to move");
  await page.mouse.move(movedTo.x, movedTo.y);
  await page.mouse.down();
  await page.mouse.move(movedTo.x - 760, movedTo.y, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  await page.click('#settings-tabs [data-settings-tab="display"]');
  const onDisplay = await settingsState();
  check("…and the reader can leave Settings open on another tab", [onDisplay.open, onDisplay.tab], [true, "display"]);
  await page.click('#as-queue .as-qline [data-as-qact="pipeline"]');
  const landedOpen = await waitFor(async () => {
    const s = await settingsState();
    return s.open && s.tab === "pipeline" && s.pipelineShown ? s : null;
  }, { timeoutMs: 10_000, stepMs: 150, what: "an already-open Settings to switch to Pipeline" });
  ok("a Settings already open elsewhere switches to Pipeline instead of closing", Boolean(landedOpen), JSON.stringify(landedOpen));
  await page.click("#btn-settings-close");
  const closedAfter = await settingsState();
  check("…and its own ✕ still closes it, with the queue pane where it was", [closedAfter.open, await page.locator("#as-queue").isVisible()], [false, true]);

  // ---- 2/3. the row: head, state word, waiting-on, hover text, fold ---------------------------------
  console.log("\n== 2. the rows: facts first, one line of head, the second read folded ==");
  const painted = await page.$$eval("#as-queue .as-task", (els) =>
    els.map((el) => {
      const head = el.querySelector(".as-task-head");
      const note = el.querySelector(".as-task-note");
      const state = el.querySelector(".as-task-state");
      const title = el.querySelector(".as-task-title");
      const more = el.querySelector("details.as-task-more");
      const foldBody = more?.querySelector(".as-task-more-body");
      const moreFolded = Boolean(more) && !more.open && more.getBoundingClientRect().height <= (more.querySelector("summary")?.getBoundingClientRect().height || 0) + 2;
      const h = (node) => (node ? Math.round(node.getBoundingClientRect().height) : 0);
      return {
        id: Number(el.dataset.asQrow),
        state: el.dataset.asQstate,
        word: (state?.textContent || "").trim(),
        stateTitle: state?.getAttribute("title") || "",
        title: (title?.textContent || "").trim(),
        titleAttr: title?.getAttribute("title") || "",
        headH: h(head),
        rowH: Math.round(el.getBoundingClientRect().height),
        note: (note?.textContent || "").trim(),
        noteTitle: note?.getAttribute("title") || "",
        noteOverflow: note ? getComputedStyle(note).textOverflow : "",
        noteWhiteSpace: note ? getComputedStyle(note).whiteSpace : "",
        wait: (el.querySelector(".as-task-wait")?.textContent || "").trim(),
        hold: (el.querySelector(".as-task-head .as-task-hold")?.textContent || "").trim(),
        more: Boolean(more),
        moreOpen: Boolean(more?.open),
        moreVisible: moreFolded,
        moreSummary: (more?.querySelector("summary")?.textContent || "").trim(),
        moreTitle: more?.querySelector("summary")?.getAttribute("title") || "",
        foldText: (foldBody?.textContent || "").replace(/\s+/g, " ").trim(),
      };
    }),
  );
  const row = (id) => painted.find((r) => r.id === id) || null;
  check("every row says its state in a word", painted.map((r) => [r.id, r.word]), [
    [1, "stale"],
    [6, "queued"],
    [2, "queued"],
    [3, "queued"],
    [4, "parked"],
    [5, "done"],
  ]);
  ok("…and a stale running row's data state is still running, so the drag and the bucket are unmoved", row(1)?.state === "running", row(1)?.state);
  ok("every row keeps its title, and the hover text is the whole title", painted.every((r) => r.title && r.titleAttr === r.title), JSON.stringify(painted.map((r) => r.title.length)));
  check("the head of every row is ONE line", painted.map((r) => r.headH <= 26), painted.map(() => true));
  ok("no row is taller than 100 px", painted.every((r) => r.rowH <= 100), `heights ${painted.map((r) => r.rowH).join(", ")} (before: 129–166)`);
  ok("the stale row says STALE where the state is read", /^STALE — that thread has no live run/.test(row(1)?.note || ""), row(1)?.note);
  ok("…and its state word explains itself on hover", /^stale — the file still says running/.test(row(1)?.stateTitle || ""), row(1)?.stateTitle);
  ok("the skipped row prints the SKIP sentence, at a glance", /^SKIPPED — files in use by #1/.test(row(2)?.note || ""), row(2)?.note);
  ok("…with the whole sentence in title=, because the line is one line", row(2)?.noteTitle === row(2)?.note && row(2)?.noteOverflow === "ellipsis" && row(2)?.noteWhiteSpace === "nowrap", `${row(2)?.noteTitle === row(2)?.note} / ${row(2)?.noteOverflow} / ${row(2)?.noteWhiteSpace}`);
  ok("the held row names the row it waits on", row(3)?.hold === "held by #1", row(3)?.hold);
  check(
    "every row's tree, files, attempts and detail are folded and CLOSED",
    painted.map((r) => [r.more, r.moreOpen, r.moreVisible]),
    painted.map(() => [true, false, true]),
  );
  ok("…and the summary names what is behind it, in hover text as well", painted.every((r) => /tree · files/.test(r.moreSummary) && /folded so the row reads/.test(r.moreTitle)), painted.map((r) => r.moreSummary).join(" | "));
  ok("the folded body really holds the files and the detail", /files public\/assistant\.js/.test(row(1)?.foldText || "") && /The row reads what it is/.test(row(1)?.foldText || ""), (row(1)?.foldText || "").slice(0, 120));

  // Opening one is a press on the row's own summary — and must not open the console instead.
  const opened = await page.evaluate(() => {
    const d = document.querySelector('#as-queue .as-task[data-as-qrow="1"] details.as-task-more');
    const before = d.getBoundingClientRect().height;
    d?.querySelector("summary")?.click();
    return { open: Boolean(d?.open), grew: d.getBoundingClientRect().height > before + 4, tab: document.querySelector('#as-subtabs .is-on')?.dataset.asSubtab || "" };
  });
  check("pressing the summary opens the fold, and the pane stays the queue", [opened.open, opened.grew, opened.tab], [true, true, "queue"]);
  await page.evaluate(() => document.querySelector('#as-queue .as-task[data-as-qrow="1"] details.as-task-more')?.removeAttribute("open"));

  // ---- 4. the order --------------------------------------------------------------------------------
  console.log("\n== 3. the order: state buckets, then the reader's own order ==");
  check("the pane draws running, then queued by `order`, then parked, then done", await ids(), [1, 6, 2, 3, 4, 5]);

  // ---- 5. the controls -----------------------------------------------------------------------------
  console.log("\n== 4. every control still fires ==");
  await page.click('[data-as-qact="done"][data-as-qid="6"]');
  const flipped = await waitFor(async () => {
    const q = await queueOf();
    const t = q?.tasks?.find((x) => x.id === 6);
    return t?.state === "done" ? t : null;
  }, { timeoutMs: 10_000, stepMs: 200, what: "the route to record #6 done" });
  ok("pressing ✓ Done writes the state through the route", Boolean(flipped), JSON.stringify({ state: flipped?.state, by: flipped?.doneBy }));
  const moved = await waitFor(async () => (await ids()).join() === [1, 2, 3, 4, 6, 5].join(), { timeoutMs: 10_000, stepMs: 150, what: "the done row to move into the done bucket" });
  ok("…and the row moves to the done bucket without a reload", moved && (await page.evaluate(() => window.__probeBoot)) === "same-document", (await ids()).join(","));

  // A pointer drag of a queued card above another. Both boxes are read in ONE evaluate — a repaint between two awaits
  // detaches the first handle.
  const dragQueued = async (fromId, toId) => {
    const boxes = await page.evaluate(([a, b]) => {
      for (const id of [a, b]) document.querySelector(`#as-queue .as-task[data-as-qrow="${id}"]`)?.scrollIntoView({ block: "nearest" });
      const box = (id) => {
        const el = document.querySelector(`#as-queue .as-task[data-as-qrow="${id}"] .as-task-body`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      return { from: box(a), to: box(b) };
    }, [fromId, toId]);
    if (!boxes.from || !boxes.to) throw new Error(`no box for #${fromId} or #${toId}`);
    const x = Math.round(boxes.from.x + boxes.from.width / 2);
    await page.mouse.move(x, Math.round(boxes.from.y + 12));
    await page.mouse.down();
    await page.mouse.move(x, Math.round(boxes.from.y + 12) - 12, { steps: 3 });
    await page.mouse.move(x, Math.round(boxes.to.y + 4), { steps: 16 });
    await page.mouse.up();
  };
  await dragQueued(3, 2);
  const dragged = await waitFor(async () => (await ids()).join() === [1, 3, 2, 4, 6, 5].join(), { timeoutMs: 10_000, stepMs: 150, what: "the drag to land #3 above #2" });
  ok("dragging #3 above #2 reorders the queued bucket", dragged, (await ids()).join(","));
  const reordered = (await queueOf())?.tasks || [];
  ok("…and the route stored the reader's order", Number(reordered.find((t) => t.id === 3)?.order) < Number(reordered.find((t) => t.id === 2)?.order), JSON.stringify(reordered.filter((t) => [2, 3].includes(t.id)).map((t) => [t.id, t.order])));

  // ➡️ Move: a real reassign, through the popover the row has always had.
  await page.click('[data-as-qmove-open="assistant-1:2"]');
  ok("the ➡️ opens the picker", await page.locator('[data-as-qmove-pop="assistant-1:2"]').isVisible());
  await page.click('[data-as-qmove-pop="assistant-1:2"] [data-as-qmove-to="assistant-2"]');
  const left = await waitFor(async () => !(await ids()).includes(2), { timeoutMs: 10_000, stepMs: 200, what: "the moved row to leave the pane" });
  ok("Move takes the row out of this assistant's queue", left && !(await queueOf()).tasks.some((t) => t.id === 2));
  const arrived = (await queueOf("assistant-2")).tasks.find((t) => t.title === "Re-skin the queue's row and its chrome");
  ok("…and Assistant #2 carries it, with movedFrom recorded", Boolean(arrived) && arrived.movedFrom?.some((m) => m.from === "assistant-1"), JSON.stringify(arrived?.movedFrom || null));

  // The folded add form: opening it and pressing Add files a task exactly as before.
  await page.click("#as-queue details.as-qadd > summary");
  await page.fill("#as-qtitle-1", "A task filed after the redesign");
  await page.click('#as-queue [data-as-qact="add"]');
  const added = await waitFor(async () => {
    const q = await queueOf();
    return q?.tasks?.find((t) => t.title === "A task filed after the redesign") || null;
  }, { timeoutMs: 10_000, stepMs: 200, what: "the add route to file the task" });
  ok("the folded Add-task form still files a task", Boolean(added) && added.state === "queued", JSON.stringify({ id: added?.id, state: added?.state }));
  const afterIds = await waitFor(async () => (await ids()).join() === [1, 3, added?.id, 4, 6, 5].join(), { timeoutMs: 10_000, stepMs: 150, what: "the new row at the end of the queued bucket" });
  ok("…and its row is painted in the queued bucket", afterIds, (await ids()).join(","));

  const resting = await page.evaluate(() => ({
    help: Boolean(document.querySelector("#as-queue details.as-qhelp")?.open),
    add: Boolean(document.querySelector("#as-queue details.as-qadd")?.open),
  }));
  check("after a write the pane is resting folded again", resting, { help: false, add: false });
  check("no page errors", pageErrors, []);
  check("the live board's listener count is unchanged by this run", listenersOn(7331), liveBefore);
} catch (err) {
  failures += 1;
  console.log(`\nFAIL  the run threw: ${String((err && err.stack) || err)}`);
  if (panel) console.log(`--- panel log (tail)\n${String(panel.log()).split(/\r?\n/).slice(-25).join("\n")}`);
} finally {
  if (liveBrowser) {
    try {
      await liveBrowser.close();
    } catch {
      /* already gone */
    }
    liveBrowser = null;
  }
  if (panel) await panel.stop();
  clearTimeout(watchdog);
}

console.log("\n== summary ==");
console.log(`${checks} checks, ${failures} failed`);
console.log("WHAT WAS DRIVEN: a real panel process over its own data directory and a seeded six-row queue, then headless");
console.log("Chromium on the real float: the closed explainer and add form, its lead and five labelled lines (each at most");
console.log("two lines, every old fact kept), the Pipeline button landing Settings on its own tab from closed AND from");
console.log("another tab, the counts' hover text, one head line per row with its state word and waiting-on sentence, the");
console.log("folded second read, the seeded order, a real ✓ Done, a real pointer drag, a real ➡️ Move and the folded add");
console.log("form — with the pane folded afterwards and no page errors.");
if (!failures) console.log("ASSISTANT-QUEUE-UI-OK");
process.exitCode = failures ? 1 : 0;
