// Does the card offer a Steer control the gateway would refuse? The three refusals, and the second approval that
// must bring its box back — driven through a real panel of THIS checkout and a real browser, against a stub
// gateway that records every steer and every approval answer.
//
//   node tools/verify-steerable.mjs
//   PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-steerable.mjs
//
// What it proves (docs/steer-refusal.md §1.4, §2.2/§2.4):
//
//   parked    a turn parked on an approval draws its approval box and NO Steer control; Ctrl+Enter holds the text
//             as a queued reply instead of spending a gateway request
//   second    answering a first approval and then receiving a SECOND request draws the second box — the stale
//             `approvalDone` used to hide it — and the card still offers no Steer control
//   past      the gateway's genuine 409 (`steer_not_accepted` on a run it still calls running) is HELD as a queued
//             reply and said so in words; the control disappears in the same round trip
//   gone      a 404 settles the row in the same answer, the card stops reading `running`, and nothing is queued
//
// RED ON THE BASE. Run it from an export of 0.74.0 and it fails: `git archive 0.74.0 | tar -x -C <dir>`, copy this
// file into `<dir>/tools/`, then `cd <dir> && node tools/verify-steerable.mjs`. There the parked card draws a Steer
// button, the second approval's box never arrives, a genuine 409 leaves "press Queue reply" advice with nothing
// held, and the 404 surfaces as a 400 on a card that goes on reading `running`.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, withBrowser } from "./browser.mjs";

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
// Four runs, each held by the "gateway": a parked one (waiting_for_approval), one that raises two approvals in
// turn, one that refuses a steer with the gateway's genuine 409, and one whose run vanishes between the card being
// drawn and the press (404 from then on). Every steer POST and every approval answer is RECORDED — that ledger is
// what the checks are asserted from.
const RUN_PARK = "run_steerable_park";
const RUN_SECOND = "run_steerable_second";
const RUN_PAST = "run_steerable_past";
const RUN_GONE = "run_steerable_gone";
const RUNS = [RUN_PARK, RUN_SECOND, RUN_PAST, RUN_GONE];

function makeStub() {
  const steers = [];
  const approvals = [];
  const asked = { capabilities: 0, status: [] };
  const streams = new Map(); // runId -> open SSE response
  const timers = new Set();
  const started = new Set();
  let seq = 0;
  let goneGone = false;
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
  const later = (ms, fn) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };
  const push = (runId, evt) => {
    const res = streams.get(runId);
    if (!res) return false;
    seq += 1;
    res.write(`id: ${seq}\ndata: ${JSON.stringify({ ...evt, run_id: runId, timestamp: Date.now() / 1000 })}\n\n`);
    return true;
  };
  const approvalEvent = (runId, command) => ({ event: "approval.request", request_id: `req_${runId}_${Date.now()}`, command, choices: ["once", "deny"], timeout_seconds: 600 });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/v1/capabilities") {
      asked.capabilities += 1;
      return json(res, 200, {
        version: "steerable-stub",
        features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_cwd: true, run_approval_response: true },
      });
    }
    const m = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    if (!m) return json(res, 404, { error: { message: "not found", code: "not_found" } });
    const runId = decodeURIComponent(m[1]);
    const sub = m[2] || "";
    if (!RUNS.includes(runId)) return json(res, 404, { error: { message: "Run not found", code: "run_not_found" } });

    if (sub === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": attached\n\n");
      streams.set(runId, res);
      const timer = setInterval(() => res.write(": hold\n\n"), 2000);
      timers.add(timer);
      req.on("close", () => {
        clearInterval(timer);
        timers.delete(timer);
        if (streams.get(runId) === res) streams.delete(runId);
      });
      // The two-approval card raises its FIRST park here, once: the store reaches the panel with no approval on it,
      // the way a turn that has not hit its first flagged command does.
      if (runId === RUN_SECOND && !started.has(runId)) {
        started.add(runId);
        later(600, () => push(runId, approvalEvent(runId, "git status --short — the first command")));
      }
      return undefined;
    }

    if (sub === "/steer" && req.method === "POST") {
      const body = await readBody(req);
      steers.push({ runId, body });
      if (runId === RUN_PARK) {
        return json(res, 409, { error: { message: `Run is not currently accepting steer input: ${runId}`, code: "run_not_accepting_steer" } });
      }
      if (runId === RUN_PAST) {
        return json(res, 409, { error: { message: `Run did not accept steer text: ${runId}`, code: "steer_not_accepted" } });
      }
      if (runId === RUN_GONE) {
        goneGone = true;
        return json(res, 404, { error: { message: `Run not found: ${runId}`, code: "run_not_found" } });
      }
      return json(res, 200, { object: "hermes.run.steer", run_id: runId, accepted: true });
    }

    if (sub === "/approval" && req.method === "POST") {
      const body = await readBody(req);
      approvals.push({ runId, body });
      json(res, 200, { object: "hermes.run.approval_response", run_id: runId, choice: body.choice, resolved: 1 });
      // The gateway confirms on the stream, and this turn's SECOND flagged command parks it again a moment later.
      if (runId === RUN_SECOND) {
        later(250, () => push(runId, { event: "approval.responded", request_id: body.request_id || null, choice: body.choice }));
        later(700, () => push(runId, approvalEvent(runId, "rm -rf build — the second command")));
      }
      return undefined;
    }

    if (!sub) {
      asked.status.push(runId);
      if (runId === RUN_GONE && goneGone) return json(res, 404, { error: { message: `Run not found: ${runId}`, code: "run_not_found" } });
      const status = runId === RUN_PARK ? "waiting_for_approval" : "running";
      return json(res, 200, { object: "hermes.run", run_id: runId, status, created_at: new Date().toISOString(), execution_generation: 1, output: "", usage: {} });
    }
    return json(res, 404, { error: { message: "not found", code: "not_found" } });
  });

  return {
    steers,
    approvals,
    asked,
    steersFor: (runId) => steers.filter((s) => s.runId === runId),
    server,
    close: () =>
      new Promise((r) => {
        for (const t of timers) clearInterval(t);
        timers.clear();
        streams.clear();
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

// ---- the sandbox panel -----------------------------------------------------------------------------------
const TH_PARK = "wtgui-steerable-park-1a2b3c";
const TH_SECOND = "wtgui-steerable-second-4d5e6f";
const TH_PAST = "wtgui-steerable-past-7g8h9i";
const TH_GONE = "wtgui-steerable-gone-0j1k2l";
const CARDS = [
  { id: "probe-park", thread: TH_PARK, runId: RUN_PARK },
  { id: "probe-second", thread: TH_SECOND, runId: RUN_SECOND },
  { id: "probe-past", thread: TH_PAST, runId: RUN_PAST },
  { id: "probe-gone", thread: TH_GONE, runId: RUN_GONE },
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
    prompt: `steerable probe ${i} — the state under test`,
    displayPrompt: `steerable probe ${i} — the state under test`,
    // No cwd on purpose: a tree would make `jobs.steer` append that tree's TODO block to the text.
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
    // The parked card reaches the panel already holding its park: `approval` is not persisted in real life, but the
    // store this harness writes IS the panel's memory, and the park it must draw is the one under test.
    ...(c.id === "probe-park"
      ? {
          approval: {
            requestId: "req_park_probe",
            command: "chmod 777 /tmp/steerable-probe",
            choices: ["once", "deny"],
            timeoutSeconds: 600,
            at: new Date().toISOString(),
            deadline: Date.now() + 600_000,
          },
        }
      : {}),
  };
}

async function startSandbox(stubUrl) {
  dir = mkdtempSync(path.join(tmpdir(), "wtgui-steerable-"));
  const scanRoot = path.join(dir, "scan-root");
  const home = path.join(dir, "hermes-home");
  const configDir = path.join(dir, "panel");
  const cwdDir = path.join(dir, "panel-cwd");
  const logsDir = path.join(configDir, "logs");
  for (const d of [scanRoot, home, configDir, cwdDir, logsDir]) mkdirSync(d, { recursive: true });
  const port = await freePort();
  const configPath = path.join(configDir, "config.json");
  const jobsPath = path.join(logsDir, "jobs.json");
  writeFileSync(jobsPath, `${JSON.stringify({ savedAt: new Date().toISOString(), jobs: CARDS.map(seedJob) }, null, 2)}\n`, "utf8");
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
        // The ONLY gateway this panel may reach is the stub.
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
async function drive(pw, stub) {
  return withBrowser(
    async ({ page, pageErrors }) => {
      const cardSel = (t) => `.job[data-thread="${t}"]`;
      const boxSel = (t) => `${cardSel(t)} .reply-box`;
      const warnSel = (t) => `[data-reply-warn="${t}"]`;
      const steerSel = (t) => `${cardSel(t)} [data-steer]`;
      // The approval box is keyed by the TURN's id (the job id), not the thread the card is filed under.
      const CARD_ID = { [TH_PARK]: "probe-park", [TH_SECOND]: "probe-second", [TH_PAST]: "probe-past", [TH_GONE]: "probe-gone" };
      const boxFor = (t) => `${cardSel(t)} [data-approval-for^="${CARD_ID[t]}"]`;
      const steerCount = (t) => page.locator(steerSel(t)).count();
      const approvalCount = (t) => page.locator(boxFor(t)).count();
      const approvalText = (t) => page.$eval(boxFor(t), (el) => (el.innerText || "").replace(/\s+/g, " ").trim()).catch(() => "");
      const ghostCount = (t) => page.locator(`${cardSel(t)} .ghost-turn`).count();
      const warn = (t) => page.$eval(warnSel(t), (el) => el.textContent || "").catch(() => "");
      const boxText = (t) => page.$eval(boxSel(t), (b) => window.WMApp.board.pasteChips.readBox(b)).catch(() => "");
      const type = async (t, text) => {
        await page.locator(boxSel(t)).fill(text);
        await page.waitForTimeout(80);
      };
      const jobsNow = async () => (await (await fetch(`${base}/api/jobs`)).json()).jobs || [];
      const cardNow = async (id) => (await jobsNow()).find((j) => j.id === id) || null;

      await page.goto(base, { waitUntil: "domcontentloaded" });
      const ready = await page
        .waitForFunction(() => typeof window.renderJobs === "function", null, { timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      ok("browser: the page loaded with the panel's own renderer", ready);
      for (const c of CARDS) {
        const up = await page.waitForSelector(cardSel(c.thread), { timeout: 20_000 }).then(() => true).catch(() => false);
        ok(`browser: the card for ${c.id} rendered`, up);
      }
      // The panel re-attaches every seeded card to the stub's runs; wait for that before judging a button.
      const attached = await waitFor(
        async () => (await cardNow("probe-park"))?.status === "running" && (await cardNow("probe-past"))?.status === "running",
        { timeoutMs: 30_000, what: "the seeded cards to re-attach to the stub's runs" },
      );
      ok("all four seeded cards are live on the stub's runs", attached);

      // ── parked: the box is drawn and no Steer control is offered ─────────────────────────────────────
      console.log("\n== parked on an approval ==");
      check("the parked card draws its approval box", await approvalCount(TH_PARK), 1);
      ok("…naming the command that is waiting", /chmod 777 \/tmp\/steerable-probe/.test(await approvalText(TH_PARK)), await approvalText(TH_PARK));
      check("…and offers NO Steer control", await steerCount(TH_PARK), 0);
      await type(TH_PARK, "answer the approval before steering");
      await page.locator(boxSel(TH_PARK)).focus();
      await page.keyboard.press("Control+Enter");
      await page.waitForTimeout(400);
      check("Ctrl+Enter held the text as a queued reply", await ghostCount(TH_PARK), 1);
      check("…and the parked run was never asked to steer", stub.steersFor(RUN_PARK).length, 0);
      check("…the box is empty (held, not left to send twice)", await boxText(TH_PARK), "");

      // ── second: answering #1 must not hide #2 ────────────────────────────────────────────────────────
      console.log("\n== a second approval.request brings its box back ==");
      const firstBox = await waitFor(() => approvalCount(TH_SECOND).then((n) => n === 1), { what: "the first approval box" });
      ok("the first approval's box is drawn", firstBox);
      ok("…naming the first command", /the first command/.test(await approvalText(TH_SECOND)), await approvalText(TH_SECOND));
      check("…and offers NO Steer control", await steerCount(TH_SECOND), 0);
      await page.locator(`${cardSel(TH_SECOND)} [data-approval-for] button[data-choice="once"]`).first().click();
      const answered = await waitFor(() => stub.approvals.filter((a) => a.runId === RUN_SECOND).length === 1, { what: "the approval answer to reach the stub" });
      ok("answering it reached the gateway once", answered);
      const secondBox = await waitFor(() => approvalText(TH_SECOND).then((t) => /the second command/.test(t)), { what: "the SECOND approval's box" });
      ok("the second request's box IS drawn — the stale approvalDone no longer hides it", secondBox, await approvalText(TH_SECOND));
      check("…and the card still offers NO Steer control", await steerCount(TH_SECOND), 0);
      const secondCard = await cardNow("probe-second");
      ok("the card carries the second park, not the first answer", Boolean(secondCard?.approval) && !secondCard?.approvalDone, JSON.stringify({ approval: Boolean(secondCard?.approval), approvalDone: secondCard?.approvalDone }));

      // ── past: a genuine 409 is held, and said ────────────────────────────────────────────────────────
      console.log("\n== a genuine 409 (past the last tool boundary) ==");
      check("the card offers Steer while its run is live", await steerCount(TH_PAST), 1);
      await type(TH_PAST, "one boundary too late");
      await page.locator(steerSel(TH_PAST)).click();
      const asked = await waitFor(() => stub.steersFor(RUN_PAST).length === 1, { what: "the steer to reach the stub" });
      ok("the press asked the gateway once", asked);
      await page.waitForTimeout(700);
      const pastWarn = await warn(TH_PAST);
      ok("the card says the text was HELD, not lost", /held/i.test(pastWarn) && /queued/i.test(pastWarn), pastWarn);
      check("…it is a queued reply", await ghostCount(TH_PAST), 1);
      check("…and the Steer control is gone in the same round trip", await steerCount(TH_PAST), 0);
      check("…the box is empty", await boxText(TH_PAST), "");

      // ── gone: the 404 settles the row and nothing is queued ─────────────────────────────────────────
      console.log("\n== a run the gateway no longer has (404) ==");
      check("the card offers Steer before the press", await steerCount(TH_GONE), 1);
      await type(TH_GONE, "anyone there");
      await page.locator(steerSel(TH_GONE)).click();
      const goneAsked = await waitFor(() => stub.steersFor(RUN_GONE).length === 1, { what: "the steer to reach the stub" });
      ok("the press asked the gateway once", goneAsked);
      const settled = await waitFor(async () => (await cardNow("probe-gone"))?.status === "interrupted", { what: "the row to settle" });
      ok("the row settles in the same request", settled, (await cardNow("probe-gone"))?.status);
      ok("…and it records the run as gone", Boolean((await cardNow("probe-gone"))?.runGone));
      await page.waitForTimeout(500);
      const goneWarn = await warn(TH_GONE);
      ok("the card says the run is gone and nothing was queued", /no longer has this run/i.test(goneWarn) && /nothing was queued/i.test(goneWarn), goneWarn);
      check("…the Steer control is gone", await steerCount(TH_GONE), 0);
      check("…and nothing was queued", await ghostCount(TH_GONE), 0);
      check("…the text is still in the box, unsent", await boxText(TH_GONE), "anyone there");

      await page.waitForTimeout(200);
      ok("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
      return pageErrors;
    },
    { playwright: pw, viewport: { width: 1500, height: 1100 } },
  );
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
  const pw = loadPlaywright();
  if (!pw) {
    console.log("\nBROWSER-HALF-NOT-RUN  the parked/second/past/gone cards and their presses — no Playwright install found (set PANEL_PLAYWRIGHT_ROOT)");
    process.exitCode = 2;
  } else {
    console.log("\nphase 2 — a real browser over the panel");
    await drive(pw, stub);
  }
} catch (e) {
  err = e;
} finally {
  console.log(`\n---- ${checks - failures}/${checks} checks passed${err ? " (with an error)" : ""}`);
  if (process.env.STEERABLE_GATE_LOG) note(panelLog.slice(-12).join("\n      "));
  await stopSandbox();
  await stub.close();
  if (err) {
    console.error(`\nSTEERABLE GATE ERROR: ${String((err && err.stack) || err)}`);
    process.exitCode = 1;
  } else if (failures) {
    process.exitCode = 1;
  }
}
