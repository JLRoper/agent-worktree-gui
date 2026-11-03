#!/usr/bin/env node
// DOGFOOD THE ASSISTANT CHAT PANE, on a panel of its own.
//
//   npm run dogfood:chat -- --turns 7 --out C:/CodeReviews/agent-worktree-gui/dogfood-chat
//
// WHY THIS EXISTS. The chat pane is the one surface where the reader and the assistant talk, and it is drawn by
// public/app.js's card renderer through public/assistant.js — the same code the board uses, reached by a different
// path (a rail with a composer, not a worktree row). A silent JS error, a fold that forgets itself, a repaint that
// drops the reader's draft, or a console that stops updating while the turn is still running is invisible to the
// suite: every unit test builds its own DOM. This drives the real page like a person.
//
// WHAT IT DOES NOT DO. It never touches the reader's board. It boots a second panel on a free port with its own
// dataDir, logsDir, config copy and scanRoots (an empty folder), so no card, tree or journal entry of this run can
// land in C:/Users/roper/.wag/state. The one thing it SHARES is the real Hermes gateway on :8642, on purpose: the
// chat's answers have to be real model answers for the timings and token counts to mean anything. Every turn is
// started by the SANDBOX's own assistant (its own thread, its own job store), never by the reader's.
//
// WHAT IT RECORDS, per step: the wall clock, the step's own duration, every console message and page error that
// appeared since the previous step, and a screenshot. The run record (run.json) carries the run's conditions —
// model, reasoning effort, token counts, wall clock — beside the timings, so a slow UI cannot be read as a slow
// model. summary.md is the machine report; the human report is written from it.
//
// EXIT: 0 when every check passed, 1 when a check failed or the run threw, 2 when Playwright is not installed.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROOT, freePort, startPanel, waitFor } from "./panel-testkit.mjs";
import { attachPageCollectors, loadPlaywright, openPage } from "./browser.mjs";

// ---- arguments ----------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
};
const has = (name) => argv.includes(`--${name}`);

const TURNS = Math.max(2, Number(argOf("turns", 7)) || 7);
const TURN_TIMEOUT_MS = Number(argOf("turn-timeout", 240_000)) || 240_000;
const OUT = path.resolve(String(argOf("out", "C:/CodeReviews/agent-worktree-gui/dogfood-chat")));
const GATEWAY = String(argOf("gateway", process.env.PANEL_GATEWAY_URL || "http://127.0.0.1:8642")).replace(/\/+$/, "");
const KEEP = has("keep");
const HEADED = has("headed");
const PORT_ARG = Number(argOf("port", 0)) || 0;
const SLOW = Number(argOf("slow", 0)) || 0; // extra settle ms after each interaction, for a flaky machine
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
// The turn's gateway session id is the job's `thread`. The primary assistant's is the fixed `panel-assistant`,
// which the READER's live assistant is also talking on — a run started there lands in their session and pays for
// their context. So the default is a second assistant seeded into this sandbox with a thread nobody else uses:
// its own gateway session, its own job store, its own token bill.
const SESSION = String(argOf("assistant", "assistant-2"));
const SHARED_OK = has("allow-shared-session");
const THREAD = String(argOf("thread", `dogfood-chat-${STAMP.replace(/[^0-9a-z]/gi, "").toLowerCase()}`));
const PANE_SUFFIX = SESSION === "assistant-1" ? "" : `-${SESSION.replace(/^assistant-/, "")}`;
const CHAT = `#as-chat${PANE_SUFFIX}`;

// ---- the gateway key -----------------------------------------------------------------------------------------------
// Read from the reader's own Hermes .env at LAUNCH, never written into the repo or the config: the only thing this
// process needs it for is the panel it starts, whose environment it inherits.
function gatewayKey() {
  if (process.env.API_SERVER_KEY) return process.env.API_SERVER_KEY;
  const candidates = [
    path.join(process.env.LOCALAPPDATA || "", "hermes", ".env"),
    path.join(process.env.HOME || process.env.USERPROFILE || "", "AppData", "Local", "hermes", ".env"),
  ];
  for (const file of candidates) {
    if (!file || !existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*API_SERVER_KEY\s*=\s*(.+?)\s*$/.exec(line);
      if (m) return m[1].replace(/^["']|["']$/g, "");
    }
  }
  return "";
}

// The model a turn actually ran on. The panel sends no model for the reader's message (the assistant's own setting
// is empty by default), so the job record's `model` is null and the GATEWAY's configured default is what answered —
// without this, every run of this harness would report `?` for the one condition a reader compares across runs.
function gatewayDefaultModel() {
  try {
    const file = path.join(process.env.LOCALAPPDATA || "", "hermes", "config.yaml");
    if (!existsSync(file)) return null;
    let inModel = false;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (/^model:\s*$/.test(line)) {
        inModel = true;
        continue;
      }
      if (!inModel) continue;
      if (/^\S/.test(line)) break;
      const m = /^\s+(?:default|model):\s*"?([^"#]+?)"?\s*$/.exec(line);
      if (m) return m[1].trim();
    }
    return null;
  } catch {
    return null;
  }
}

// ---- small helpers -------------------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slash = (p) => String(p || "").replace(/\\/g, "/");
const listenerCount = (port) => {
  let out = "";
  try {
    out = execSync("netstat -ano", { encoding: "utf8", windowsHide: true });
  } catch (e) {
    out = String((e && e.stdout) || "");
  }
  return out.split(/\r?\n/).filter((l) => l.includes(`:${port} `) && l.includes("LISTENING")).length;
};

const checks = [];
const steps = [];
const findings = [];
let shotN = 0;
const shotsDir = path.join(OUT, "shots");
mkdirSync(shotsDir, { recursive: true });

const check = (name, cond, detail = "") => {
  checks.push({ name, pass: Boolean(cond), detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  return Boolean(cond);
};
const note = (text) => console.log(`      ${text}`);

// A finding is a defect this run observed. `severity` is the dogfood taxonomy's four levels.
const finding = ({ severity, title, area = "chat", stepsToRepro = [], expected, actual, shot = null, evidence = null }) => {
  findings.push({ severity, title, area, stepsToRepro, expected, actual, shot, evidence });
  console.log(`FINDING ${severity.toUpperCase()}  ${title}`);
};

async function api(base, route, { method = "GET", body = null } = {}) {
  const r = await fetch(`${base}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: r.status, json, text };
}
const getJson = async (base, route) => (await api(base, route)).json;

// ---- the page driver -----------------------------------------------------------------------------------------------
function makeDriver(page, ctx) {
  const { allConsole, pageErrors } = ctx;
  let shots = 0;

  const capture = async (name) => {
    shots += 1;
    shotN += 1;
    const file = path.join(shotsDir, `${String(shotN).padStart(2, "0")}-${String(shots).padStart(2, "0")}-${name.replace(/[^a-z0-9.-]+/gi, "-")}.png`);
    await page.screenshot({ path: file, animations: "disabled" });
    // A second, tight capture of the rail: the chat pane's own text is what a reader reads.
    const pane = page.locator("#assistant");
    if (await pane.count()) {
      const tight = file.replace(/\.png$/, "-rail.png");
      await pane.screenshot({ path: tight, animations: "disabled" }).catch(() => {});
    }
    return file;
  };

  // One interaction: time it, settle, then read what the console gained because of it.
  const step = async (name, fn, { shot = true, settle = 300 } = {}) => {
    const c0 = allConsole.length;
    const p0 = pageErrors.length;
    const t0 = Date.now();
    let value;
    let error = null;
    try {
      value = await fn();
    } catch (e) {
      error = String((e && e.message) || e);
    }
    await page.waitForTimeout(settle + SLOW);
    const record = {
      name,
      at: new Date().toISOString(),
      ms: Date.now() - t0,
      console: allConsole.slice(c0),
      pageErrors: pageErrors.slice(p0),
      shot: null,
      error,
    };
    if (shot) {
      record.shot = await capture(name).catch(() => null);
      // The tight capture of the rail, beside the full page: a finding about the chat is judged on this one.
      record.shotRail = record.shot ? record.shot.replace(/\.png$/, "-rail.png") : null;
    }
    steps.push(record);
    const bad = record.console.filter((m) => m.type === "error").length + record.pageErrors.length;
    console.log(`${bad || error ? "STEP!" : "step "} ${name} — ${record.ms} ms${bad ? ` · ${bad} console error(s)` : ""}${error ? ` · threw: ${error}` : ""}`);
    for (const m of record.console) if (m.type === "error") console.log(`        console.error: ${m.text}`);
    for (const e of record.pageErrors) console.log(`        pageerror: ${e}`);
    if (error) throw new Error(`${name}: ${error}`);
    return value;
  };

  return { capture, step, shots: () => shots };
}

// ---- the turn loop -------------------------------------------------------------------------------------------------
async function main() {
  if (has("help")) {
    console.log(`dogfood the assistant chat pane on a panel of its own

  npm run dogfood:chat -- [--turns N] [--out DIR] [--assistant ID] [--thread NAME]
                            [--gateway URL] [--port N] [--turn-timeout MS]
                            [--headed] [--keep] [--slow MS] [--allow-shared-session]

  --turns N        how many turns to drive (default 7; the brief wants more than five)
  --out DIR        where run.json, summary.md and shots/ go (default C:/CodeReviews/agent-worktree-gui/dogfood-chat)
  --assistant ID   which assistant tab to drive (default assistant-2, seeded with its own thread so the
                   gateway session is this run's and not the reader's)
  --thread NAME    the gateway session id / job thread (default dogfood-chat-<timestamp>)
  --gateway URL    the Runs API (default http://127.0.0.1:8642); the key comes from API_SERVER_KEY or
                   %LOCALAPPDATA%/hermes/.env and is never written anywhere
  --port N         the sandbox panel's port (default: a free one; 7331 is refused)
  --turn-timeout   ms to wait for one turn to settle (default 240000)
  --headed         run Chromium with a window
  --keep           keep the sandbox directory (state, logs, config) for inspection
  --slow MS        extra settle time after every interaction
  --allow-shared-session  permit --assistant assistant-1, whose thread is the reader's live session

Exit 0 when every check passed.`);
    return process.exit(0);
  }
  const key = gatewayKey();
  if (!key) throw new Error("no API_SERVER_KEY — set it in the environment or in %LOCALAPPDATA%/hermes/.env");

  const playwright = loadPlaywright({ root: ROOT });
  if (!playwright) {
    console.log("BROWSER-HALF-NOT-RUN  no Playwright install found (set PANEL_PLAYWRIGHT_ROOT)");
    process.exit(2);
  }

  const gateway = await fetch(`${GATEWAY}/v1/capabilities`, { headers: { Authorization: `Bearer ${key}` } }).catch((e) => ({ ok: false, status: String(e) }));
  if (!gateway.ok) throw new Error(`the gateway at ${GATEWAY} did not answer /v1/capabilities (${gateway.status})`);

  const live7331Before = listenerCount(7331);
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-dogfood-chat-"));
  const repos = path.join(dir, "repos");
  mkdirSync(repos, { recursive: true });
  const port = PORT_ARG || (await freePort());
  if (port === 7331) throw new Error("the sandbox must not run on the reader's port 7331");
  const base = `http://127.0.0.1:${port}`;

  // The sandbox assistant. Assistant #1's thread is the fixed `panel-assistant` (lib/assistants.js normalises it),
  // and the gateway keys a session by that id — so talking to #1 here would continue the READER's assistant session
  // and pay for its context. A seeded second assistant owns a thread nobody else uses.
  const assistantsFile = path.join(dir, "assistants.json");
  if (SESSION !== "assistant-1") {
    writeFileSync(
      assistantsFile,
      JSON.stringify(
        {
          version: 1,
          assistants: [
            { id: "assistant-1", name: "Assistant #1", roleId: "agent-manager", threadId: "panel-assistant", rules: [], createdAt: new Date().toISOString() },
            { id: SESSION, name: "Sandbox Assistant", roleId: "agent-manager", threadId: THREAD, charterRel: `assistants/${SESSION}/charter.md`, rules: [], createdAt: new Date().toISOString() },
          ],
        },
        null,
        1,
      ),
      "utf8",
    );
  } else if (!SHARED_OK) {
    throw new Error(`--assistant assistant-1 talks on ${THREAD}, the reader's own assistant session on the gateway; pass --allow-shared-session if that is really wanted`);
  }

  // The panel's own config. Named dataDir/scratchDir are what give this instance the split layout (state/, logs/,
  // attachments/) instead of the flat one beside its config; the clocks are long because this run drives every
  // change itself and no sweep may add a turn the reader did not ask for.
  const config = {
    host: "127.0.0.1",
    dataDir: path.join(dir, "data"),
    scratchDir: path.join(dir, "scratch"),
    assistantsFile,
    // startPanel() seeds these beside its config; naming them here puts the store in the split layout the
    // brief asks for (state/ and logs/ under this instance's own data directory), not in a flat logs/ folder.
    jobsFile: path.join(dir, "data", "state", "jobs.json"),
    assistantFile: path.join(dir, "data", "state", "assistant.json"),
    projectsCacheFile: path.join(dir, "data", "state", "projects.json"),
    scanRoots: [repos],
    projects: [],
    threads: 1,
    refreshSeconds: 3600,
    worktreeSeconds: 3600,
    midSeconds: 3600,
    dormantSeconds: 3600,
    slowSeconds: 3600,
    fetchSeconds: -1,
    discoverSeconds: 3600,
    apiServer: { url: GATEWAY, key: "" },
    assistant: { enabled: true, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0, quietSeconds: 3600 },
  };

  const panel = await startPanel({
    dir,
    port,
    config,
    // The key rides the ENVIRONMENT only. startPanel forces API_SERVER_KEY:"" so a test can never reach the
    // developer's gateway; this run needs exactly that gateway, so the value is restored here and nowhere else.
    env: { API_SERVER_KEY: key, HERMES_HOME: path.join(dir, "hermes") },
  });

  const run = {
    startedAt: new Date().toISOString(),
    out: OUT,
    turnsRequested: TURNS,
    panel: { port, base, dir, configPath: panel.configPath, dataDir: config.dataDir, scratchDir: config.scratchDir },
    assistant: { id: SESSION, thread: THREAD },
    gateway: { url: GATEWAY, defaultModel: gatewayDefaultModel() },
    browser: { headless: !HEADED, engine: "chromium" },
    views: null,
    turnRecords: [],
    steps,
    checks,
    findings,
    totals: {},
  };

  const jobs = async () => (await getJson(base, "/api/jobs")).jobs || [];
  const jobsOn = async (thread) => (await jobs()).filter((j) => j.thread === thread);
  const terminal = (j) => j && ["done", "failed", "cancelled", "interrupted"].includes(j.status);

  try {
    // ---- 1. the sandbox is the sandbox ------------------------------------------------------------------------
    console.log(`\n== 1. the sandbox: port ${port}, data ${slash(config.dataDir)}`);
    check("the sandbox port is not the reader's 7331", port !== 7331, `port ${port}`);
    check("the sandbox config is inside the sandbox", slash(panel.configPath).toLowerCase().startsWith(slash(dir).toLowerCase()), slash(panel.configPath));
    const health = await api(base, "/api/health");
    check("the sandbox answers on its own port", health.status === 200, `HTTP ${health.status}`);
    const assistantState = await getJson(base, "/api/assistant");
    const rec = (assistantState.assistants || []).find((a) => a.id === SESSION);
    check("the sandbox has its own assistant record on a thread nobody else uses", Boolean(rec) && rec.threadId === THREAD, rec ? `${rec.id} → ${rec.threadId}` : `no ${SESSION} record`);
    check("its store is empty before the run", (await jobsOn(THREAD)).length === 0, `${(await jobsOn(THREAD)).length} job(s)`);
    check("nothing is running on the reader's own assistant thread", (await jobsOn("panel-assistant")).length === 0, `${(await jobsOn("panel-assistant")).length} job(s) on panel-assistant`);
    const state = await getJson(base, "/api/state");
    const strayPaths = JSON.stringify(state).match(/([A-Za-z]:[\\/][^"]*?\.wag[\\/])/g) || [];
    check("no path in /api/state points at the reader's .wag store", strayPaths.length === 0, strayPaths.slice(0, 3).join(" "));
    // The split layout (dataDir named in the config) puts the store at <dataDir>/state/jobs.json.
    run.store = {
      dataDir: config.dataDir,
      scratchDir: config.scratchDir,
      stateDir: path.join(config.dataDir, "state"),
      logsDir: path.join(config.dataDir, "logs"),
      jobsFile: path.join(config.dataDir, "state", "jobs.json"),
      assistantFile: path.join(config.dataDir, "state", "assistant.json"),
    };
    check("the sandbox's state and logs live under its own dataDir", slash(run.store.stateDir).startsWith(slash(dir)) && slash(run.store.logsDir).startsWith(slash(dir)), `${run.store.stateDir} · ${run.store.logsDir}`);

    // ---- 2. the page ------------------------------------------------------------------------------------------
    const browser = await playwright.chromium.launch({ headless: !HEADED });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const { pageErrors, consoleErrors } = attachPageCollectors(page);
    const allConsole = [];
    page.on("console", (m) => allConsole.push({ type: m.type(), text: m.text() }));
    const driver = makeDriver(page, { allConsole, pageErrors, consoleErrors });

    try {
      await openPage(page, base, { selector: "#btn-assistant" });
      await driver.step("open the board", async () => page.waitForTimeout(800));

      await driver.step("open the assistant rail", async () => {
        await page.click("#btn-assistant");
        await page.waitForSelector("#assistant:not([hidden])", { timeout: 15_000 });
        if (SESSION !== "assistant-1") {
          await page.waitForSelector(`#as-tabs [data-as-tab="${SESSION}"]`, { timeout: 10_000 });
          await page.click(`#as-tabs [data-as-tab="${SESSION}"]`);
          await page.waitForSelector(`#as-assistant-${SESSION.replace(/^assistant-/, "")}:not(.hidden)`, { timeout: 10_000 });
        }
      });
      // The sub-tab record is one across sessions (skill: "The float's sub-tab record is ONE record across
      // sessions"), so press Chat explicitly rather than assuming it is the one that opens.
      await driver.step("select the chat sub-tab", async () => {
        await page.waitForSelector("#as-subtabs:not([hidden])", { timeout: 10_000 });
        const on = await page.evaluate(() => document.querySelector('#as-subtabs [data-as-subtab="chat"]')?.classList.contains("is-on"));
        if (!on) await page.click('#as-subtabs [data-as-subtab="chat"]');
        await page.waitForSelector(`${CHAT}:not(.hidden)`, { timeout: 10_000 });
        await page.waitForTimeout(500);
      });
      const intro = await page.evaluate(({ sel, suffix }) => {
        const host = document.querySelector(sel);
        return { mode: host?.dataset.mode || null, box: Boolean(document.getElementById(`as-first-text${suffix}`)), btn: Boolean(document.getElementById(`btn-as-first${suffix}`)) };
      }, { sel: CHAT, suffix: PANE_SUFFIX });
      check("the chat pane opens on the intro box", intro.mode === "intro" && intro.box && intro.btn, JSON.stringify(intro));
      run.views = await page.evaluate(() => ({ inner: [innerWidth, innerHeight], rail: document.getElementById("assistant")?.getBoundingClientRect().toJSON() }));

      // ---- 3. the back-and-forth ------------------------------------------------------------------------------
      const prompts = [
        "In one sentence: what can you see from this board?",
        "Thanks. In one sentence, what is the task queue for?",
        "Okay — one sentence: how do you tell a stalled agent from a slow one?",
        "Good. In one sentence: what happens when an agent parks on an approval?",
        "Next: in one sentence, why do worktrees matter here?",
        "One more: in a sentence, what should I check before merging a branch?",
        "Last one: read your queue file, then in three short sentences say what you would do next on this board.",
      ];
      const promptFor = (i) => prompts[(i - 1) % prompts.length];

      const boxOf = async () => {
        const reply = await page.evaluate((sel) => Boolean(document.querySelector(`${sel} .reply-box[data-reply]`)), CHAT);
        return reply ? `${CHAT} .reply-box[data-reply="${THREAD}"]` : `#as-first-text${PANE_SUFFIX}`;
      };
      const sendButtonOf = async () => {
        const reply = await page.evaluate((sel) => Boolean(document.querySelector(`${sel} .btn-reply[data-thread]`)), CHAT);
        return reply ? `${CHAT} .btn-reply[data-thread="${THREAD}"]` : `#btn-as-first${PANE_SUFFIX}`;
      };

      // Type like a person: focus the box, real keystrokes, then the button — or Enter, which is the gesture a
      // reader actually uses and a different branch of the page's own handler. A repaint between typing and the
      // press is the reader's own hazard, so the text is read back before the press and retyped once if it went.
      const send = async (text, { useEnter = false } = {}) => {
        const box = await boxOf();
        const btn = await sendButtonOf();
        await page.click(box);
        await page.keyboard.type(text, { delay: 8 });
        let got = await page.evaluate((s) => document.querySelector(s)?.innerText?.trim() || "", box);
        if (got !== text) {
          await page.click(box);
          await page.evaluate((s) => { const el = document.querySelector(s); if (el) el.textContent = ""; }, box);
          await page.keyboard.type(text, { delay: 8 });
          got = await page.evaluate((s) => document.querySelector(s)?.innerText?.trim() || "", box);
        }
        if (useEnter) await page.keyboard.press("Enter");
        else await page.click(btn);
        return { box, btn, typed: got, useEnter };
      };

      // Read a turn's own fold state, and set it. A blind `.turn-head` press is a TOGGLE: pressing one that is
      // already folded unfolds it, which is how a harness reports a defect the page does not have.
      const turnState = async (id) =>
        page.evaluate(({ sel, id }) => {
          const t = document.querySelector(`${sel} .turn[data-turn="${id}"]`);
          if (!t) return null;
          const pre = t.querySelector("pre.job-out");
          return {
            folded: t.classList.contains("folded"),
            running: t.classList.contains("is-running"),
            console: Boolean(pre),
            chars: pre ? pre.innerText.length : 0,
            peek: t.querySelector("[data-peek-turn]")?.innerText?.trim().slice(0, 200) ?? null,
            head: t.querySelector(".turn-text")?.innerText?.trim() || null,
            height: Math.round(t.getBoundingClientRect().height),
          };
        }, { sel: CHAT, id });
      const setTurnOpen = async (id, wantOpen) => {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const st = await turnState(id);
          if (!st) {
            await page.waitForTimeout(250);
            continue;
          }
          if (st.folded === !wantOpen && st.console === wantOpen) return st;
          await page.click(`${CHAT} .turn[data-turn="${id}"] .turn-head`);
          await page.waitForTimeout(300);
        }
        return turnState(id);
      };

      const turnIds = [];
      for (let i = 1; i <= TURNS; i += 1) {
        const before = (await jobsOn(THREAD)).map((j) => j.id);
        const text = promptFor(i);
        // Enter on the even turns: a reader's own gesture, and a branch of the handler the button never reaches.
        const useEnter = i % 2 === 0 && i !== TURNS;
        const t0 = Date.now();
        let typing = null;
        await driver.step(`turn ${i}: type and ${useEnter ? "press Enter" : "press Send"}`, async () => { typing = await send(text, { useEnter }); }, { settle: 120 });
        check(`turn ${i}: the message is in the box before ${useEnter ? "Enter" : "Send"}`, typing?.typed === text, JSON.stringify(typing?.typed));

        let job = await waitFor(async () => (await jobsOn(THREAD)).find((j) => !before.includes(j.id)) || null, {
          what: "the new turn to exist in the store",
          timeoutMs: useEnter ? 8_000 : 30_000,
        }).catch(() => null);
        if (!job && typing?.useEnter) {
          // The gesture is the thing under test: record it, then press the button so the rest of the run still
          // has its turn. A press that starts nothing is a finding, not a harness failure.
          const kept = await page.evaluate((s) => document.querySelector(s)?.innerText?.trim() || "", typing.box);
          finding({ severity: "high", title: `Enter in the chat composer does not start a turn (turn ${i})`, stepsToRepro: [`type "${text.slice(0, 40)}…" into the chat composer`, "press Enter"], expected: "the turn starts, as the box's own placeholder promises", actual: `no job within 8 s; the box still holds ${JSON.stringify(kept)}`, shot: steps[steps.length - 1]?.shot });
          await page.click(typing.btn);
          job = await waitFor(async () => (await jobsOn(THREAD)).find((j) => !before.includes(j.id)) || null, { what: "the new turn after pressing the button", timeoutMs: 30_000 }).catch(() => null);
        }
        if (!job) {
          finding({ severity: "critical", title: `Turn ${i} never started`, expected: "a job on the assistant thread", actual: "no new job in /api/jobs", shot: steps[steps.length - 1]?.shot });
          break;
        }
        const tJob = Date.now();
        turnIds.push(job.id);

        const painted = await waitFor(
          async () => page.evaluate(({ sel, id }) => Boolean(document.querySelector(`${sel} .turn[data-turn="${id}"]`)), { sel: CHAT, id: job.id }),
          { what: `turn ${i}'s block to paint`, timeoutMs: 20_000 },
        ).catch(() => false);
        const tPaint = Date.now();

        // First token: the console's first text that is neither the "waiting for output…" placeholder nor the
        // request the reader just sent. The text is recorded, because a "first token" that is the prompt would
        // make every timing number a lie.
        // The console paints a context note and tool rows before a single word of prose, so "the first text in
        // the console" is the context line at +0 ms — a number that would make every timing look instant. The
        // first assistant TOKEN is the first `kind: "text"` line the store records; the DOM is read beside it
        // so the same probe also proves the line reached the page.
        let tFirstToken = null;
        let firstText = null;
        const firstToken = waitFor(
          async () => {
            const j = (await jobsOn(THREAD)).find((x) => x.id === job.id);
            const line = (j?.lines || []).find((l) => l.kind === "text" && String(l.text || "").trim());
            if (!line) return false;
            const painted = await page.evaluate(({ sel, id }) => {
              const pre = document.querySelector(`${sel} .turn[data-turn="${id}"] pre.job-out`);
              return pre ? pre.innerText : "";
            }, { sel: CHAT, id: job.id });
            if (!painted.includes(String(line.text).trim().slice(0, 24))) return false;
            tFirstToken = Date.now();
            firstText = String(line.text).slice(0, 200);
            return true;
          },
          { what: "the first prose token", timeoutMs: 90_000, stepMs: 120 },
        ).catch(() => false);

        if (i === TURNS) {
          // ---- the streaming turn: fold and unfold while it is still answering -------------------------------
          // The gestures start as soon as the turn EXISTS in the store (starting/running), not after its first
          // prose token: a fast turn settles in about 3 s, and a fold that waits for the first token lands on a
          // finished card — which measures the answered-turn path a second time and nothing about streaming.
          const live = await waitFor(
            async () => {
              const j = (await jobsOn(THREAD)).find((x) => x.id === job.id);
              return j && (j.status === "starting" || j.status === "running") ? j : null;
            },
            { what: "the turn to be live", timeoutMs: 10_000, stepMs: 40 },
          ).catch(() => null);
          if (!live) note("the last turn settled before the fold could run while it was live — the streaming fold was NOT exercised");
          run.streamingExercised = Boolean(live);
          const foldLive = async (folded) => setTurnOpen(job.id, !folded);
          const liveFolded = await driver.step(`streaming turn ${i}: collapse the ${live ? "running" : "just-settled"} turn`, () => foldLive(true), { settle: 500 });
          check(`turn ${i}: collapsing the live turn folds it${live ? " and keeps it marked running" : ""}`, liveFolded.folded === true && (live ? liveFolded.running === true : true), JSON.stringify(liveFolded));
          // Does the folded line keep moving while lines keep arriving? That is the whole point of the peek.
          const beforePeek = liveFolded.peek || "";
          const linesAt = (await jobsOn(THREAD)).find((x) => x.id === job.id)?.lines?.length ?? null;
          const after = await driver.step(`streaming turn ${i}: the folded line two and a half seconds later`, async () => {
            await page.waitForTimeout(2500);
            return page.evaluate(({ sel, id }) => {
              const t = document.querySelector(`${sel} .turn[data-turn="${id}"]`);
              const peek = t?.querySelector("[data-peek-turn]");
              return { folded: Boolean(t?.classList.contains("folded")), peek: peek ? peek.innerText.trim().slice(0, 160) : null, head: t?.querySelector(".turn-text")?.innerText.trim() || null };
            }, { sel: CHAT, id: job.id });
          }, { settle: 0 });
          const linesLater = (await jobsOn(THREAD)).find((x) => x.id === job.id)?.lines?.length ?? null;
          if (after.folded !== true) {
            finding({ severity: "high", title: "A folded, still-streaming turn unfolds itself on the next repaint", stepsToRepro: [`send turn ${i}`, "collapsed the running turn", "waited 2.5 s"], expected: "the turn stays folded, its peek line carries the newest output", actual: `folded=${after.folded}, head=${JSON.stringify(after.head)}`, shot: steps[steps.length - 1]?.shot });
          } else if ((linesLater ?? 0) > (linesAt ?? 0) && after.peek === beforePeek && !after.peek) {
            finding({ severity: "medium", title: "A folded, still-streaming turn's peek never fills", stepsToRepro: [`send turn ${i}`, "collapsed the running turn", "waited 2.5 s while lines arrived"], expected: "the peek line shows the newest line or a tally", actual: `peek stayed ${JSON.stringify(after.peek)} while lines went ${linesAt} → ${linesLater}`, shot: steps[steps.length - 1]?.shot });
          }
          steps[steps.length - 1].observed = { beforePeek, afterPeek: after.peek, linesAt, linesLater, head: after.head };

          const liveOpen = await driver.step(`streaming turn ${i}: expand the running turn again`, () => foldLive(false), { settle: 500 });
          check(`turn ${i}: expanding the running turn brings its console back`, liveOpen.folded === false && liveOpen.console === true, JSON.stringify(liveOpen));

          // A draft typed into the composer WHILE the card is being rebuilt on every job frame. The renderer
          // captures and restores typing across a rebuild; a lost draft here is the reader's sentence vanishing
          // mid-thought, which is the class of defect the console check cannot see.
          const marker = `half-written note ${Date.now() % 10000}`;
          const draft = await driver.step(`streaming turn ${i}: type a draft while the card repaints`, async () => {
            const box = await boxOf();
            await page.click(box);
            await page.keyboard.type(marker, { delay: 6 });
            await page.waitForTimeout(2200);
            const got = await page.evaluate((s) => document.querySelector(s)?.innerText?.trim() || "", box);
            return { box, want: marker, got };
          }, { settle: 100 });
          check(`turn ${i}: a draft typed mid-stream survives the repaints`, draft.got === draft.want, `got ${JSON.stringify(draft.got)}`);
          if (draft.got !== draft.want) {
            finding({ severity: "high", title: "A draft typed into the composer while a turn streams is lost on a repaint", stepsToRepro: [`send turn ${i}`, "type into the reply box while it runs", "wait 2.2 s (several job frames)"], expected: "the text stays in the box", actual: `box held ${JSON.stringify(draft.got)} of ${JSON.stringify(draft.want)}`, shot: steps[steps.length - 1]?.shot });
          }
          await page.evaluate((s) => {
            const el = document.querySelector(s);
            if (el) {
              el.textContent = "";
              el.dispatchEvent(new Event("input", { bubbles: true }));
            }
          }, draft.box);
          await driver.step(`streaming turn ${i}: the composer is still on screen`, async () =>
            page.evaluate((sel) => {
              const box = document.querySelector(`${sel} .reply-box[data-reply]`);
              const rail = document.getElementById("assistant");
              if (!box || !rail) return { box: null };
              const b = box.getBoundingClientRect();
              const r = rail.getBoundingClientRect();
              return { box: { top: Math.round(b.top), bottom: Math.round(b.bottom) }, rail: { top: Math.round(r.top), bottom: Math.round(r.bottom) }, inside: b.top >= r.top && b.bottom <= r.bottom + 1 };
            }, CHAT), { settle: 0 }).then((pos) => check(`turn ${i}: the composer stays inside the rail with the transcript scrolled`, pos.inside === true, JSON.stringify(pos)));

          // A reader who scrolls up to re-read an earlier answer while the newest turn is still writing: the
          // card is rebuilt on every frame, and a rebuild that re-pins to the bottom is the classic "it yanks me
          // back" defect. Hold the position, sample it twice.
          const scrollHold = await driver.step(`streaming turn ${i}: scroll up and hold it`, async () => {
            const before = await page.evaluate((sel) => {
              const body = document.querySelector(`${sel} .job .job-body`);
              if (!body) return null;
              body.scrollTop = Math.max(0, body.scrollTop - 260);
              return { scrollTop: body.scrollTop, max: body.scrollHeight - body.clientHeight };
            }, CHAT);
            await page.waitForTimeout(1800);
            const after = await page.evaluate((sel) => {
              const body = document.querySelector(`${sel} .job .job-body`);
              return body ? { scrollTop: body.scrollTop, max: body.scrollHeight - body.clientHeight } : null;
            }, CHAT);
            return { before, after };
          }, { settle: 100 });
          if (scrollHold.before && scrollHold.before.max > 300) {
            const drift = Math.abs((scrollHold.after?.scrollTop ?? 0) - scrollHold.before.scrollTop);
            check(`turn ${i}: a reader scrolled up mid-stream is not dragged back to the bottom`, drift <= 24, `drift ${drift}px (before ${scrollHold.before.scrollTop}, after ${scrollHold.after?.scrollTop})`);
            if (drift > 24) {
              finding({ severity: "medium", title: "The chat yanks the reader back to the bottom mid-stream", stepsToRepro: [`send turn ${i}`, "scroll the transcript up while it streams", "wait 1.8 s"], expected: "the scroll position holds while the reader is not at the bottom", actual: `scrollTop moved ${scrollHold.before.scrollTop} → ${scrollHold.after?.scrollTop}`, shot: steps[steps.length - 1]?.shot });
            }
          } else {
            note("the transcript was too short to scroll at this point — the hold was not measurable");
          }

          // An older answered turn, folded and unfolded while the newest one streams.
          const older = turnIds.slice(0, -1).pop();
          if (older) {
            const olderFold = await driver.step(`streaming turn ${i}: collapse turn ${turnIds.indexOf(older) + 1} while ${i} streams`, () => setTurnOpen(older, false), { settle: 400 });
            check(`turn ${i}: an older turn folds while the newest streams`, olderFold.folded === true, JSON.stringify(olderFold));
          }
        }

        const done = await waitFor(async () => { const j = (await jobsOn(THREAD)).find((x) => x.id === job.id); return terminal(j) ? j : null; }, {
          what: `turn ${i} to finish`,
          timeoutMs: TURN_TIMEOUT_MS,
          stepMs: 250,
        }).catch(() => null);
        const tDone = Date.now();
        await firstToken;
        if (!done) {
          finding({ severity: "high", title: `Turn ${i} never finished within ${Math.round(TURN_TIMEOUT_MS / 1000)} s`, expected: "the turn settles", actual: `status ${(await jobsOn(THREAD)).find((x) => x.id === job.id)?.status}`, shot: (await driver.capture(`turn-${i}-timeout`)) });
        }

        const snapshot = await page.evaluate(({ sel, id }) => {
          const t = document.querySelector(`${sel} .turn[data-turn="${id}"]`);
          if (!t) return null;
          const pre = t.querySelector("pre.job-out");
          return {
            folded: t.classList.contains("folded"),
            running: t.classList.contains("is-running"),
            head: t.querySelector(".turn-text")?.innerText?.trim() || null,
            consoleChars: pre ? pre.innerText.length : 0,
            consoleText: pre ? pre.innerText.slice(-400) : null,
            replyBox: Boolean(document.querySelector(`${sel} .reply-box[data-reply]`)),
            replyDraft: document.querySelector(`${sel} .reply-box[data-reply]`)?.innerText || "",
          };
        }, { sel: CHAT, id: job.id });
        const jobNow = (await jobsOn(THREAD)).find((x) => x.id === job.id) || job;
        run.turnRecords.push({
          n: i,
          id: job.id,
          prompt: text,
          status: jobNow.status,
          model: jobNow.model || null,
          reasoningEffort: jobNow.reasoningEffort ?? null,
          tokens: jobNow.tokens || null,
          jobDurationMs: jobNow.durationMs ?? null,
          timing: {
            sendToJob: tJob - t0,
            jobToPaint: tPaint - tJob,
            sendToPaint: tPaint - t0,
            sendToFirstToken: tFirstToken ? tFirstToken - t0 : null,
            sendToDone: tDone - t0,
            jobToDone: tDone - tJob,
          },
          firstText,
          dom: snapshot,
        });
        if (snapshot && snapshot.consoleChars === 0) {
          finding({ severity: "high", title: `Turn ${i} finished with an empty console`, expected: "the assistant's answer is on the card", actual: `status ${jobNow.status}, console 0 chars`, shot: steps[steps.length - 1]?.shot });
        }
        if (snapshot?.head && jobNow.tokens?.total) {
          const shown = String(snapshot.head).match(/([\d.]+)k tok/);
          const want = jobNow.tokens.total / 1000;
          check(`turn ${i}: the head's token tally matches the store`, shown ? Math.round(Number(shown[1])) === Math.round(want) : false, `head ${JSON.stringify(snapshot.head)} vs ${jobNow.tokens.total}`);
        }
        if (!snapshot) {
          finding({ severity: "high", title: `Turn ${i}'s block disappeared from the chat pane after it finished`, expected: "the answered turn stays on the page", actual: "no .turn[data-turn] node for it", shot: null });
        } else if (snapshot.replyDraft) {
          finding({ severity: "medium", title: `Turn ${i} left the reply box holding text the reader did not type`, expected: "the box is empty after a send", actual: JSON.stringify(snapshot.replyDraft.slice(0, 120)), shot: null });
        }
        await driver.step(`turn ${i}: answered`, async () => {}, { settle: 120 });

        // ---- close the turn, then the next message opens a new one ------------------------------------------
        if (i < TURNS) {
          const folded = await driver.step(`turn ${i}: collapse the answered turn`, () => setTurnOpen(job.id, false));
          check(`turn ${i}: collapsing an answered turn folds it and hides its console`, folded.folded === true && folded.console === false, JSON.stringify(folded));
          if (!folded.peek) {
            finding({ severity: "medium", title: `A folded turn ${i} shows no peek line`, expected: "the folded line says what the turn concluded", actual: "no [data-peek-turn] text", shot: steps[steps.length - 1]?.shot });
          }
        }
      }

      // ---- 4. expand and collapse several answered turns ------------------------------------------------------
      console.log("\n== 4. expand and collapse several turns");
      // A card pages its turns five at a time, so with more than five the oldest ones are not in the DOM at
      // all. Reaching them is part of the reader's own path, not a harness convenience.
      const ensureOnPage = async (id) => {
        const present = () => page.evaluate(({ sel, id }) => Boolean(document.querySelector(`${sel} .turn[data-turn="${id}"]`)), { sel: CHAT, id });
        // Older first: the card opens on the newest page, so the oldest turns are one or two presses ▲ away.
        // Once ▲ is disabled the target is on a NEWER page (the pages are 5 + remainder), so ▼ is the way back.
        for (const dir of ["older", "newer"]) {
          for (let p = 0; p < 4; p += 1) {
            if (await present()) return true;
            const btn = page.locator(`${CHAT} [data-turn-page="${dir}"]:not([disabled])`);
            if (!(await btn.count())) break;
            await btn.first().click();
            await page.waitForTimeout(250);
          }
          if (await present()) return true;
        }
        return false;
      };
      for (const id of turnIds.slice(0, Math.min(3, turnIds.length))) {
        const n = turnIds.indexOf(id) + 1;
        const paged = await ensureOnPage(id);
        const pagerLabel = await page.evaluate((sel) => document.querySelector(`${sel} .pager-n`)?.innerText?.trim() || null, CHAT);
        if (!paged) {
          finding({ severity: "high", title: `Turn ${n} cannot be reached with the card's older-turns pager`, stepsToRepro: ["send more than five turns", "press the pager's ▲ / older-turns button"], expected: "the older turns come back", actual: `no .turn[data-turn="${id}"] after five presses; pager read ${JSON.stringify(pagerLabel)}`, shot: steps[steps.length - 1]?.shot });
          break;
        }
        const open = await driver.step(`turn ${n}: expand it again`, () => setTurnOpen(id, true));
        check(`turn ${n}: expanding it brings its console back with text`, open.folded === false && open.console === true && open.chars > 0, JSON.stringify({ ...open, pager: pagerLabel }));
      }
      // Back to the newest page: a reader who went looking at the start of the thread has to be able to return.
      const backToNewest = await driver.step("page back to the newest turns", async () => {
        for (let p = 0; p < 5; p += 1) {
          const newer = page.locator(`${CHAT} [data-turn-page="newer"]:not([disabled])`);
          if (!(await newer.count())) break;
          await newer.first().click();
          await page.waitForTimeout(220);
        }
        return page.evaluate((sel) => ({ pager: document.querySelector(`${sel} .pager-n`)?.innerText?.trim() || null, turns: document.querySelectorAll(`${sel} .turn[data-turn]`).length }), CHAT);
      });
      check("the pager returns to the newest page", /\/\s*\d+\s*$/.test(backToNewest.pager || "") && backToNewest.turns > 0, JSON.stringify(backToNewest));

      // The pager sits in the card HEAD, which is a single flex row inside the docked rail (480 px here). With no
      // `flex: none` on `.turn-pager` and no `white-space: nowrap` on its count, the count shrinks to its
      // min-content width and wraps into a vertical strip — measured at 11.5 px wide and 61 px tall, four lines,
      // at BOTH 1600 and 1280 window widths because the rail's own width is what is tight.
      const pagerFit = await page.evaluate((sel) => {
        const n = document.querySelector(`${sel} .pager-n`);
        const box = document.querySelector(`${sel} .turn-pager`);
        if (!n || !box) return null;
        const cs = getComputedStyle(n);
        const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2 || 12;
        const r = n.getBoundingClientRect();
        return {
          text: (n.innerText || "").trim(),
          pagerWidth: Math.round(box.getBoundingClientRect().width * 10) / 10,
          countWidth: Math.round(r.width * 10) / 10,
          countHeight: Math.round(r.height * 10) / 10,
          lineHeight: Math.round(line * 10) / 10,
          lines: Math.max(1, Math.round(r.height / line)),
          whiteSpace: cs.whiteSpace,
          pagerShrink: getComputedStyle(box).flexShrink,
        };
      }, CHAT);
      check("the turn pager's count stays on one line in the docked rail", Boolean(pagerFit) && pagerFit.lines <= 1, JSON.stringify(pagerFit));
      if (pagerFit && pagerFit.lines > 1) {
        finding({
          severity: "medium",
          title: "The turn pager's count wraps into a vertical strip in the docked rail",
          stepsToRepro: [`drive more than five turns so the card pages`, "look at the card head's ▲ ▼ pager"],
          expected: "the count reads on one line (e.g. 3–7 / 7) beside the arrows",
          actual: `the count is ${pagerFit.countWidth}×${pagerFit.countHeight} px and wraps to ${pagerFit.lines} lines (white-space: ${pagerFit.whiteSpace}, pager flex-shrink: ${pagerFit.pagerShrink})`,
          shot: steps[steps.length - 1]?.shotRail || steps[steps.length - 1]?.shot,
          evidence: pagerFit,
        });
      }
      const lastId = turnIds[turnIds.length - 1];
      const restored = await page.evaluate(({ sel, id }) => {
        const t = document.querySelector(`${sel} .turn[data-turn="${id}"]`);
        const pre = t?.querySelector("pre.job-out");
        return { folded: Boolean(t?.classList.contains("folded")), chars: pre ? pre.innerText.length : 0, head: t?.querySelector(".turn-text")?.innerText?.trim() || null };
      }, { sel: CHAT, id: lastId });
      check("the final turn is on the page with its answer", Boolean(restored.head) && restored.chars > 0, JSON.stringify(restored));
      await driver.step("final view of the chat", async () => page.waitForTimeout(400));

      // ---- 5. a reader's F5: the transcript has to come back -----------------------------------------------
      console.log("\n== 5. reload the page: the transcript comes back from the store");
      await driver.step("reload the page", async () => {
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector("#btn-assistant", { timeout: 20_000 });
        await page.waitForTimeout(1500);
        // The float remembers it was open (wm.assistantOpen). Pressing #btn-assistant here would CLOSE it, which
        // is the trap this panel's harnesses have already paid for — only press when it is actually shut.
        const open = await page.evaluate(() => {
          const el = document.getElementById("assistant");
          return Boolean(el) && !el.hidden;
        });
        if (!open) await page.click("#btn-assistant");
        await page.waitForSelector("#assistant:not([hidden])", { timeout: 15_000 });
        if (SESSION !== "assistant-1") {
          const tabOn = await page.evaluate((s) => document.querySelector(`#as-tabs [data-as-tab="${s}"]`)?.classList.contains("is-on"), SESSION);
          if (!tabOn) await page.click(`#as-tabs [data-as-tab="${SESSION}"]`);
        }
        const chatOn = await page.evaluate(() => document.querySelector('#as-subtabs [data-as-subtab="chat"]')?.classList.contains("is-on"));
        if (!chatOn) await page.click('#as-subtabs [data-as-subtab="chat"]');
        await page.waitForSelector(`${CHAT}:not(.hidden)`, { timeout: 10_000 });
        await page.waitForTimeout(1500);
      });
      const afterReload = await page.evaluate(({ sel, last }) => {
        const host = document.querySelector(sel);
        const card = host?.querySelector(".job");
        const newest = card?.querySelector(`.turn[data-turn="${last}"]`);
        return {
          mode: host?.dataset.mode || null,
          turns: card ? card.querySelectorAll(".turn[data-turn]").length : 0,
          total: (card?.querySelector(".pager-n")?.innerText || "").trim() || null,
          newestPresent: Boolean(newest),
          newestFolded: newest ? newest.classList.contains("folded") : null,
          newestChars: newest?.querySelector("pre.job-out")?.innerText.length ?? 0,
          replyBox: Boolean(host?.querySelector(".reply-box[data-reply]")),
        };
      }, { sel: CHAT, last: turnIds[turnIds.length - 1] });
      check("after a reload the chat is still a card with the transcript", afterReload.mode === "card" && afterReload.turns > 0, JSON.stringify(afterReload));
      check("after a reload the newest turn is present and shows its answer", afterReload.newestPresent === true && afterReload.newestChars > 0, JSON.stringify(afterReload));
      check("after a reload the composer is back", afterReload.replyBox === true, `reply box ${afterReload.replyBox}`);
      if (!afterReload.newestPresent || afterReload.newestChars === 0) {
        finding({ severity: "high", title: "A page reload loses the chat transcript", stepsToRepro: ["hold a conversation", "press F5", "open the assistant's Chat"], expected: "every turn comes back from the job store", actual: JSON.stringify(afterReload), shot: steps[steps.length - 1]?.shot });
      }

      // ---- 6. the reader's board was not touched --------------------------------------------------------------
      const liveAfter = listenerCount(7331);
      check("the reader's 7331 listener count is unchanged", liveAfter === live7331Before, `${live7331Before} → ${liveAfter}`);
      const ownJobs = await jobsOn(THREAD);
      check("every turn this run drove is on the sandbox assistant's own thread", ownJobs.length === run.turnRecords.length, `${ownJobs.length} of ${run.turnRecords.length} on ${THREAD}`);
      check("no turn landed on the reader's assistant thread", (await jobsOn("panel-assistant")).length === 0, `${(await jobsOn("panel-assistant")).length} job(s) on panel-assistant`);
      check("the sandbox's own store file holds the run", existsSync(run.store.jobsFile), run.store.jobsFile);

      run.totals = {
        turns: run.turnRecords.length,
        tokensTotal: run.turnRecords.reduce((a, t) => a + (t.tokens?.total || 0), 0),
        tokensInput: run.turnRecords.reduce((a, t) => a + (t.tokens?.input || 0), 0),
        tokensOutput: run.turnRecords.reduce((a, t) => a + (t.tokens?.output || 0), 0),
        wallClockMs: Date.now() - Date.parse(run.startedAt),
        stepMs: steps.reduce((a, s) => a + s.ms, 0),
        consoleErrors: steps.reduce((a, s) => a + s.console.filter((m) => m.type === "error").length, 0),
        pageErrors: steps.reduce((a, s) => a + s.pageErrors.length, 0),
        checks: checks.length,
        failed: checks.filter((c) => !c.pass).length,
      };
    } finally {
      await browser.close().catch(() => {});
    }
  } finally {
    run.finishedAt = new Date().toISOString();
    run.panelLogTail = (() => {
      try {
        return panel.log().split(/\r?\n/).filter(Boolean).slice(-12);
      } catch {
        return [];
      }
    })();
    const failed = checks.filter((c) => !c.pass).length;
    run.passed = failed === 0 && findings.filter((f) => ["critical", "high"].includes(f.severity)).length === 0;

    writeFileSync(path.join(OUT, "run.json"), JSON.stringify(run, null, 2), "utf8");
    writeFileSync(path.join(OUT, "summary.md"), summaryOf(run), "utf8");
    if (!KEEP) writeFileSync(path.join(OUT, "panel.log"), run.panelLogTail.join("\n"), "utf8");
    await panel.stop().catch(() => {});
    if (KEEP) console.log(`      sandbox kept at ${dir}`);
    else rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

    console.log(`\nrun.json   ${path.join(OUT, "run.json")}`);
    console.log(`summary.md ${path.join(OUT, "summary.md")}`);
    console.log(`shots      ${shotsDir}`);
    console.log(`\nRESULT: ${run.passed ? "PASS" : "FAIL"} — ${run.totals.checks} checks, ${run.totals.failed} failed · ${findings.length} finding(s)`);
    for (const f of findings) console.log(`  ${f.severity.toUpperCase().padEnd(8)} ${f.title}`);
    process.exit(run.passed ? 0 : 1);
  }
}

// ---- the machine report ----------------------------------------------------------------------------------------------
function summaryOf(run) {
  const sev = ["critical", "high", "medium", "low"].map((s) => [s, run.findings.filter((f) => f.severity === s).length]).filter(([, n]) => n);
  const lines = [];
  lines.push(`# Assistant chat dogfood — ${run.startedAt}`);
  lines.push("");
  lines.push(`Panel: http://127.0.0.1:${run.panel.port} (sandbox, data ${run.panel.dataDir}) · gateway ${run.gateway?.url || run.gateway}`);
  lines.push(`Model: ${run.gateway?.defaultModel || "?"} (the gateway's default — the panel sends no model for a reader's message) · reasoning effort: none set by the panel`);
  lines.push(`Turns driven: ${run.totals.turns} · wall clock ${(run.totals.wallClockMs / 1000).toFixed(1)} s · tokens ${run.totals.tokensTotal} (${run.totals.tokensInput} in / ${run.totals.tokensOutput} out) · streaming fold exercised: ${run.streamingExercised ? "yes" : "no"}`);
  lines.push(`Checks: ${run.totals.checks} run, ${run.totals.failed} failed · console errors ${run.totals.consoleErrors} · page errors ${run.totals.pageErrors}`);
  lines.push(`Findings: ${sev.length ? sev.map(([s, n]) => `${n} ${s}`).join(", ") : "none"}`);
  lines.push("");
  lines.push("## Run conditions");
  lines.push("");
  lines.push("| turn | model | reasoning | tokens in | tokens out | job ms | send→job | send→paint | send→token | send→done |");
  lines.push("| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const t of run.turnRecords) {
    lines.push(`| ${t.n} | ${t.model || run.gateway?.defaultModel || "?"} | ${t.reasoningEffort || "—"} | ${t.tokens?.input ?? "—"} | ${t.tokens?.output ?? "—"} | ${t.jobDurationMs ?? "—"} | ${t.timing.sendToJob} | ${t.timing.jobToPaint} | ${t.timing.sendToFirstToken ?? "—"} | ${t.timing.sendToDone} |`);
  }
  lines.push("");
  lines.push("## Checks");
  lines.push("");
  for (const c of run.checks) lines.push(`- ${c.pass ? "PASS" : "FAIL"} — ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
  lines.push("");
  lines.push("## Findings");
  lines.push("");
  if (!run.findings.length) lines.push("None: every step was clean.");
  for (const f of run.findings) {
    lines.push(`### ${f.severity.toUpperCase()} — ${f.title}`);
    lines.push("");
    lines.push(`- Expected: ${f.expected}`);
    lines.push(`- Actual: ${f.actual}`);
    if (f.stepsToRepro?.length) lines.push(`- Repro: ${f.stepsToRepro.join(" → ")}`);
    if (f.shot) lines.push(`- Screenshot: ${f.shot}`);
    lines.push("");
  }
  lines.push("## Steps");
  lines.push("");
  lines.push("| # | step | ms | console errors | page errors | shot |");
  lines.push("| ---: | --- | ---: | ---: | ---: | --- |");
  run.steps.forEach((s, i) => {
    const errs = s.console.filter((m) => m.type === "error").length;
    lines.push(`| ${i + 1} | ${s.name} | ${s.ms} | ${errs} | ${s.pageErrors.length} | ${s.shot ? path.basename(s.shot) : ""} |`);
  });
  lines.push("");
  return lines.join("\n");
}

main().catch((err) => {
  console.log(`FAIL  the run threw: ${String((err && err.stack) || err)}`);
  try {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(path.join(OUT, "run.json"), JSON.stringify({ startedAt: STAMP, threw: String((err && err.stack) || err), steps, checks, findings }, null, 2), "utf8");
  } catch {
    /* nothing left to write */
  }
  process.exit(1);
});
