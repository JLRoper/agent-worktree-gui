// Steer turn, end to end: a steer the gateway accepts actually steers, and a steer it refuses is HELD as a queued
// reply and said so — never silently lost. Proved by driving a real panel of this checkout and a real browser
// over it, against a STUB gateway that records every `POST /v1/runs/<id>/steer` it is sent.
//
//   node tools/verify-steer-turn.mjs
//   PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-steer-turn.mjs
//
// What each acceptance item of the brief is proved by:
//
//   (a) a steer the gateway will accept actually steers — one recorded POST /v1/runs/<id>/steer carrying the
//       typed text, the box emptied, and ZERO queued ghost rows on the card (button, and again from Ctrl+Enter)
//   (b) a steer the gateway REFUSES on a run it still calls running (409 run_not_accepting_steer — the panel
//       classifies that as the last-tool-boundary refusal) is HELD: the card says so in words, the text becomes ONE
//       queued reply, the box is emptied and the Steer control goes in the same round trip. The brief for the
//       parked-turn fix reversed the older rule that handed the text back with "press Queue reply": the reader
//       asked for it to be sent, so it is held for the next turn rather than lost to a second press
//   (c) Queue reply still holds the text (one ghost, its own "sends when the current turn finishes" line) and
//       ENTER still queues rather than steering: the Queue press and the Enter press make no steer POST at all
//
// WHAT IS DRIVEN, AND WHAT IS ONLY INSPECTED
//
//   driven    a panel of this checkout on its own PANEL_CONFIG, pointed at a stub Runs API; three restored cards
//             whose runs the stub still holds (so the panel re-attaches them, the way it does after a restart),
//             and a real headless Chromium typing and clicking in the shipped reply box
//   driven    the panel's own POST /api/jobs/steer route and `jobs.steer` — the page is NOT stubbed, so the
//             request under test is the one the panel really makes to the gateway
//   inspected that the button's click and Ctrl+Enter both call `steerFromBox` (read off public/app.js) — the
//             two gestures are one code path, and each is driven here separately so a drift shows as a failure
//
// The browser half needs a Playwright install; without one the script prints BROWSER-HALF-NOT-RUN and exits 2
// rather than passing on a half that never ran.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

let checks = 0;
let failures = 0;
const check = (name, got, want) => {
  checks += 1;
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  return pass;
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
  return Boolean(cond);
};
const note = (text) => console.log(`      ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 20_000, stepMs = 100, what = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let got = false;
    try {
      got = await fn();
    } catch {
      got = false;
    }
    if (got) return got;
    if (Date.now() > until) {
      console.log(`      (timed out after ${timeoutMs}ms waiting for ${what})`);
      return false;
    }
    await sleep(stepMs);
  }
}
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// ---- the stub Runs API -----------------------------------------------------------------------------------
// Three runs, all still held by the "gateway": one that accepts a steer, one that refuses it the way a run
// parked on an approval does (409 run_not_accepting_steer), and one that is only ever queued for. Every steer
// request is RECORDED as `{ path, runId, body }` — that ledger is what (a) and (b) are asserted from.
const RUN_OK = "run_steer_ok";
const RUN_REFUSED = "run_steer_refused";
const RUN_QUEUED = "run_steer_queued";
const RUNS = [RUN_OK, RUN_REFUSED, RUN_QUEUED];

function makeStub() {
  const steers = [];
  const asked = { capabilities: 0, status: [], events: [] };
  const timers = new Set();
  const json = (res, code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          resolve(JSON.parse(raw || "{}"));
        } catch {
          resolve({});
        }
      });
    });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/v1/capabilities") {
      asked.capabilities += 1;
      return json(res, 200, {
        version: "steer-stub",
        features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_cwd: true, run_approval_response: true },
      });
    }
    const m = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    if (!m) return json(res, 404, { error: { message: "not found", code: "not_found" } });
    const runId = decodeURIComponent(m[1]);
    const sub = m[2] || "";
    if (!RUNS.includes(runId)) return json(res, 404, { error: { message: "Run not found", code: "run_not_found" } });
    if (sub === "/events") {
      asked.events.push(runId);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": attached\n\n");
      const timer = setInterval(() => res.write(": hold\n\n"), 2000);
      timers.add(timer);
      req.on("close", () => {
        clearInterval(timer);
        timers.delete(timer);
      });
      return undefined;
    }
    if (sub === "/steer" && req.method === "POST") {
      const body = await readBody(req);
      steers.push({ path: url.pathname, runId, body });
      if (runId === RUN_REFUSED) {
        return json(res, 409, {
          error: { message: `Run is not currently accepting steer input: ${runId}`, code: "run_not_accepting_steer" },
        });
      }
      return json(res, 200, { object: "hermes.run.steer", run_id: runId, accepted: true });
    }
    if (!sub) {
      asked.status.push(runId);
      return json(res, 200, { object: "hermes.run", run_id: runId, status: "running", created_at: new Date().toISOString(), execution_generation: 1, output: "", usage: {} });
    }
    return json(res, 404, { error: { message: "not found", code: "not_found" } });
  });
  return {
    steers,
    asked,
    server,
    reset: () => {
      steers.length = 0;
    },
    close: () =>
      new Promise((r) => {
        for (const t of timers) clearInterval(t);
        timers.clear();
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

// ---- the sandbox panel -----------------------------------------------------------------------------------
const TH_OK = "wtgui-steer-probe-ok-0a1b2c";
const TH_REFUSED = "wtgui-steer-probe-refused-3d4e5f";
const TH_QUEUED = "wtgui-steer-probe-queued-6a7b8c";
const cards = [
  { id: "probe-ok", thread: TH_OK, runId: RUN_OK },
  { id: "probe-refused", thread: TH_REFUSED, runId: RUN_REFUSED },
  { id: "probe-queued", thread: TH_QUEUED, runId: RUN_QUEUED },
];

let dir = null;
let panel = null;
let base = "";
const panelLog = [];

function seedJob(c, i) {
  return {
    id: c.id,
    thread: c.thread,
    turn: 1,
    prompt: `probe brief ${i} — the state under test`,
    displayPrompt: `probe brief ${i} — the state under test`,
    // No cwd on purpose: a tree would make `jobs.steer` append that tree's TODO block to the text, and the
    // ledger asserts the POST carries exactly what was typed.
    cwd: null,
    worktree: false,
    worktreePath: null,
    projectPath: null,
    ownerPath: null,
    branch: null,
    runId: c.runId,
    status: "running",
    exitCode: null,
    startedAt: new Date(Date.now() - 90_000).toISOString(),
    endedAt: null,
    model: "probe/model",
    lines: [{ kind: "tool", lid: 1, at: Date.now() - 60_000, text: "💻 terminal · a long one" }],
    artifacts: [],
    attachments: [],
    subagents: [],
  };
}

async function startSandbox(stubUrl) {
  dir = mkdtempSync(path.join(tmpdir(), "wtgui-steer-turn-"));
  const scanRoot = path.join(dir, "scan-root");
  const home = path.join(dir, "hermes-home");
  const configDir = path.join(dir, "panel");
  const cwdDir = path.join(dir, "panel-cwd");
  const logsDir = path.join(configDir, "logs");
  for (const d of [scanRoot, home, configDir, cwdDir, logsDir]) mkdirSync(d, { recursive: true });
  const port = await freePort();
  const configPath = path.join(configDir, "config.json");
  const jobsPath = path.join(logsDir, "jobs.json");
  writeFileSync(jobsPath, `${JSON.stringify({ savedAt: new Date().toISOString(), jobs: cards.map(seedJob) }, null, 2)}\n`, "utf8");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        port,
        host: "127.0.0.1",
        scanRoots: [scanRoot],
        defaultCwd: cwdDir,
        jobsFile: jobsPath,
        assistantFile: path.join(logsDir, "assistant.json"),
        projectsCacheFile: path.join(logsDir, "projects.json"),
        treeNamesFile: path.join(logsDir, "tree-names.json"),
        // The ONLY gateway this panel may reach is the stub: a probe that resolved a real one would steer a real
        // agent, and this script must be free of side effects outside its own sandbox.
        apiServer: { url: stubUrl, key: "sandbox-key" },
        assistant: { enabled: false, seconds: 3600, maxWakesPerHour: 0 },
        refreshSeconds: 3600,
        worktreeSeconds: 3600,
        midSeconds: 3600,
        dormantSeconds: 3600,
        slowSeconds: 3600,
        fetchSeconds: 3600,
        threads: 2,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  base = `http://127.0.0.1:${port}`;
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
}

async function stopSandbox() {
  if (panel) {
    const p = panel;
    panel = null;
    p.kill();
    await waitFor(() => p.exitCode !== null || p.signalCode !== null, { timeoutMs: 10_000, what: "the panel to exit" });
    if (p.exitCode === null && p.signalCode === null && p.pid) {
      try {
        execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } catch {
        /* already gone */
      }
    }
  }
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* a locked sandbox is not a failed check */
    }
    dir = null;
  }
}

// ---- the browser half ------------------------------------------------------------------------------------
async function run(pw) {
  const cardSel = (t) => `.job[data-thread="${t}"]`;
  const boxSel = (t) => `${cardSel(t)} .reply-box`;
  const warnSel = (t) => `[data-reply-warn="${t}"]`;
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(`pageerror: ${String((e && e.message) || e)}`));
    page.on("console", (m) => {
      // The browser's own line for a 4xx fetch ("Failed to load resource") is not a page error: this script
      // causes a 409 on purpose, and the check below is about uncaught exceptions.
      if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) pageErrors.push(`console.error: ${m.text()}`);
    });
    await page.goto(base, { waitUntil: "domcontentloaded" });
    const ready = await page
      .waitForFunction(() => typeof window.renderJobs === "function", null, { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    ok("browser: the page loaded with the panel's own renderer", ready);
    for (const c of cards) {
      const up = await page.waitForSelector(cardSel(c.thread), { timeout: 20_000 }).then(() => true).catch(() => false);
      ok(`browser: the card for ${c.id} rendered`, up);
    }

    const ghostCount = (t) => page.locator(`${cardSel(t)} .ghost-turn`).count();
    const ghostTexts = (t) =>
      page.$$eval(`${cardSel(t)} .ghost-turn`, (els) => els.map((g) => (g.innerText || "").replace(/\s+/g, " ").trim()));
    const queueNote = (t) => page.locator(`${cardSel(t)} .queue-note`).count().then((n) => (n ? page.locator(`${cardSel(t)} .queue-note`).first().innerText() : null));
    const boxText = (t) => page.$eval(boxSel(t), (b) => window.WMApp.board.pasteChips.readBox(b));
    const warn = (t) => page.$eval(warnSel(t), (el) => el.textContent || "").catch(() => "");
    const type = async (t, text) => {
      await page.locator(boxSel(t)).fill(text);
      await page.waitForTimeout(80);
    };
    const steerPostsFor = (runId) => stub.steers.filter((s) => s.runId === runId);
    const steerBtn = (t) => page.locator(`${cardSel(t)} [data-steer]`);

    // ── (a) a steer the gateway accepts, from the button ───────────────────────────────────────────────
    console.log("\n== (a) Steer turn against a live run the gateway accepts ==");
    check("the card offers Steer turn while its turn is live", await steerBtn(TH_OK).count(), 1);
    await type(TH_OK, "steer into the live turn");
    await steerBtn(TH_OK).click();
    const gotOne = await waitFor(() => steerPostsFor(RUN_OK).length === 1, { what: "one recorded steer on the stub" });
    ok("the stub was sent exactly one steer for that run", gotOne && steerPostsFor(RUN_OK).length === 1);
    check("it was POST /v1/runs/<id>/steer", steerPostsFor(RUN_OK)[0]?.path, `/v1/runs/${RUN_OK}/steer`);
    check("carrying the typed text", steerPostsFor(RUN_OK)[0]?.body?.input, "steer into the live turn");
    await page.waitForTimeout(250);
    check("…and ZERO queued ghost rows", await ghostCount(TH_OK), 0);
    check("…no queue count on the card", await queueNote(TH_OK), null);
    check("…the box is empty (the text went into the turn)", await boxText(TH_OK), "");
    ok("…and the card says it steered", /steered/.test(await warn(TH_OK)), await warn(TH_OK));

    // ── (a2) the same gesture from Ctrl+Enter, one code path later ────────────────────────────────────
    console.log("\n== (a2) Ctrl+Enter is the same press ==");
    await type(TH_OK, "and once more from the keyboard");
    await page.locator(boxSel(TH_OK)).focus();
    await page.keyboard.press("Control+Enter");
    const gotTwo = await waitFor(() => steerPostsFor(RUN_OK).length === 2, { what: "the second recorded steer" });
    ok("Ctrl+Enter made a second, single steer", gotTwo && steerPostsFor(RUN_OK).length === 2);
    check("…carrying the typed text", steerPostsFor(RUN_OK)[1]?.body?.input, "and once more from the keyboard");
    await page.waitForTimeout(250);
    check("…and held nothing", await ghostCount(TH_OK), 0);
    // The two gestures are literally one function, read off the shipped source: a drift between them is the
    // regression this line exists to catch.
    const src = await page.evaluate(async () => (await fetch("/app.js")).text());
    ok(
      "the button's click handler and Ctrl+Enter both call steerFromBox()",
      /steerFromBox\(steerBtn\.closest\("\.job"\)\?\.dataset\.thread \|\| "", steerBtn\.dataset\.steer\)/.test(src) &&
        /steerOfferedFor\(box\)\) \{\s*e\.preventDefault\(\);\s*void steerFromBox\(box\.dataset\.reply\)/.test(src),
    );

    // ── (c) Queue reply still holds the text, and Enter still queues ──────────────────────────────────
    console.log("\n== (c) Queue reply holds the text; Enter never steers ==");
    await type(TH_QUEUED, "hold this until the turn ends");
    await page.locator(`${cardSel(TH_QUEUED)} [data-queue-reply]`).click();
    await page.waitForTimeout(300);
    check("Queue reply held the text as a ghost row", await ghostCount(TH_QUEUED), 1);
    ok("…whose line is the held reply", /hold this until the turn ends/.test((await ghostTexts(TH_QUEUED))[0] || ""), JSON.stringify(await ghostTexts(TH_QUEUED)));
    ok("…with the send-when-free promise", /sends when the current turn finishes/.test((await ghostTexts(TH_QUEUED))[0] || ""));
    check("…the card counts it", await queueNote(TH_QUEUED), "1 queued");
    check("…the box is empty", await boxText(TH_QUEUED), "");
    await type(TH_QUEUED, "and this one with Enter");
    await page.locator(boxSel(TH_QUEUED)).focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    check("Enter held a second reply instead of steering", await ghostCount(TH_QUEUED), 2);
    check("…and neither press sent a steer to the gateway", steerPostsFor(RUN_QUEUED).length, 0);

    // ── (b) a genuine 409 is HELD as a queued reply, and said ─────────────────────────────────────────
    // The stub's `run_refuse` answers the steer 409 `run_not_accepting_steer` AND reports the run as still `running`,
    // so the panel classifies it as the gateway's last-tool-boundary refusal: the turn exists, it is finishing, and
    // nothing can be steered into it. The text belongs in a held reply, and the card must say it was held.
    console.log("\n== (b) a steer the gateway refuses (409 run_not_accepting_steer on a live run) ==");
    check("the card offers Steer turn for the live run", await steerBtn(TH_REFUSED).count(), 1);
    await type(TH_REFUSED, "this text must survive the refusal");
    await steerBtn(TH_REFUSED).click();
    const refusedSeen = await waitFor(() => steerPostsFor(RUN_REFUSED).length === 1, { what: "the refused steer to reach the stub" });
    ok("the panel did ask the gateway (one recorded steer)", refusedSeen && steerPostsFor(RUN_REFUSED).length === 1);
    check("…carrying the typed text", steerPostsFor(RUN_REFUSED)[0]?.body?.input, "this text must survive the refusal");
    await page.waitForTimeout(700);
    const refusedWarn = await warn(TH_REFUSED);
    ok("the card says the steer was HELD", /held/i.test(refusedWarn), refusedWarn);
    ok("…and says where the text went: queued", /queued/i.test(refusedWarn), refusedWarn);
    ok("…in words, not a code: it names what happened", refusedWarn.trim().length > 20, refusedWarn);
    check("the text became ONE held reply", await ghostCount(TH_REFUSED), 1);
    ok("…whose line is the typed text", /survive the refusal/.test((await ghostTexts(TH_REFUSED))[0] || ""), JSON.stringify(await ghostTexts(TH_REFUSED)));
    check("…the card counts it", await queueNote(TH_REFUSED), "1 queued");
    check("the box is empty (held, not left to send twice)", await boxText(TH_REFUSED), "");
    // The route answered 409 and the card remembered it: the control the gateway cannot answer is not drawn again.
    check("the Steer control is gone in the same round trip", await steerBtn(TH_REFUSED).count(), 0);
    check("…and no second steer was sent", steerPostsFor(RUN_REFUSED).length, 1);

    await page.waitForTimeout(200);
    ok("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
    return pageErrors;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---- boot ------------------------------------------------------------------------------------------------
const stub = makeStub();
await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${stub.server.address().port}`;
let err = null;
try {
  console.log(`\nphase 1 — a panel on its own store (stub gateway at ${stubUrl})`);
  await startSandbox(stubUrl);
  ok("the panel probed the stub gateway's capabilities", await waitFor(() => stub.asked.capabilities > 0, { what: "the capabilities probe" }), `count ${stub.asked.capabilities}`);
  const restored = await waitFor(async () => {
    const jobs = (await (await fetch(`${base}/api/jobs`)).json()).jobs || [];
    return cards.every((c) => jobs.find((j) => j.id === c.id && j.status === "running" && j.runId === c.runId));
  }, { timeoutMs: 30_000, what: "the three seeded cards to be running on the stub's runs" });
  ok("all three seeded cards are live, attached to the stub's runs", restored);
  for (const c of cards) {
    const jobs = (await (await fetch(`${base}/api/jobs`)).json()).jobs || [];
    const j = jobs.find((x) => x.id === c.id);
    note(`${c.id}: status=${j?.status} runId=${j?.runId}`);
  }

  const pw = loadPlaywright();
  if (!pw) {
    console.log(`\nBROWSER-HALF-NOT-RUN  the steer press and the queue press — no Playwright install found (set PANEL_PLAYWRIGHT_ROOT)`);
    process.exitCode = 2;
  } else {
    console.log("\nphase 2 — a real browser over the panel");
    await run(pw);
  }
} catch (e) {
  err = e;
} finally {
  console.log(`\n---- ${checks - failures}/${checks} checks passed${err ? ` (with an error)` : ""}`);
  if (process.env.STEER_GATE_LOG) note(panelLog.slice(-12).join("\n      "));
  await stopSandbox();
  await stub.close();
  if (err) {
    console.error(`\nSTEER GATE ERROR: ${String((err && err.stack) || err)}`);
    process.exitCode = 1;
  } else if (failures) {
    process.exitCode = 1;
  }
}
