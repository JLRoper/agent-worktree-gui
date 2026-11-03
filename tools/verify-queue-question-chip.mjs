// A row whose agent is parked on a QUESTION says so — and the press lands where the question can be read and answered.
//
//   node tools/verify-queue-question-chip.mjs                 # this checkout: one sandbox panel + a stub Runs API
//   node tools/verify-queue-question-chip.mjs --root <dir>     # serve a `git archive` export of another build (RED PROOF)
//   node tools/verify-queue-question-chip.mjs --keep           # leave the sandbox on disk
//
// THE CLAIM. A queue row reads as a LANE: queued, running, parked, done, with a reason under it. A row whose agent
// stopped to ask something was painted by exactly that code, so "parked, waiting on a decision" and "parked, the agent
// asked me a question" were the same pixels — and the only way to find the question was to guess which card it was on.
// This build joins each row to the panel's own OPEN alert for that row's thread (the clarify alert: rule `question`,
// `parked`, a `requestId`) and draws one chip reading `question` on it, reusing the `.as-task-hold` class so the
// stylesheet gains nothing. Pressing the chip is the agent row's own opener, `openAgentTurn`, so it lands on the
// console of the turn — and the FULL question, every choice and the answer are drawn there by app.js's own turn
// renderer (`questionPrompt`/`questionAnswered`), not by a second copy of the prompt on the queue.
//
// WHAT IS DRIVEN, in order:
//
//   1. THE SANDBOX IS ITS OWN. A free port (≠ 7331), a throwaway state dir, a throwaway scanned repo and HERMES_HOME,
//      and a stub Runs API on an ephemeral port. The live board's 7331 listener count is compared before and after;
//   2. THE ALERT IS THE PANEL'S. A real run is started on a seeded thread and the stub streams `clarify.request`. The
//      alert is then read from `/api/assistant/queue` — rule, parked, requestId, thread, choices — and its `title` is
//      proved SHORTER than the question (clipped server-side), which is why the chip is a sign and not the question;
//   3. ONE CHIP, ON THE RIGHT ROW. The pane is opened in headless Chromium: exactly one row wears `question`, it is the
//      row whose thread the alert names, it is a `button.as-task-hold` with no second class, and its computed style is
//      the hold badge's own — measured against a real hold badge in the same pane, and against a plain button;
//   4. THE PRESS LANDS ON THE CONSOLE. A click on the chip focuses the parked turn's `pre.job-out` inside that agent's
//      card (the same `openAgentTurn` the agent sub-row uses), and the card that comes up carries the WHOLE question in
//      `.tq-question` — longer than the alert's title AND longer than the console line's 200-character record — with
//      every choice as a `.tq-choice`, `(Recommended)` drawn as its own chip;
//   5. THE ANSWER READS BACK IN THAT CHAT. Pressing a choice posts the clarify answer to the stub with the alert's own
//      request id, and the card then reads `✓ answered: <the choice>`; the alert closes and the chip goes with it — a
//      chip bound to a question that is still open, never a permanent badge on a parked row.
//
// RED PROOF. Every check above is made through the real route and the real page of the tree under test. Run this file
// with `--root` pointing at a `git archive` export of the base (0.73.3 has no chip): the alert still reaches the panel
// and the card still draws its question box, and the chip checks fail — there is no `.as-task-hold` on the row. The red
// run is quoted in the commit and the PR.
//
// The browser half needs a Playwright install (`PANEL_PLAYWRIGHT_ROOT`, or a global one); without it this prints
// BROWSER-HALF-NOT-RUN and exits non-zero rather than passing a half that never ran. Nothing here starts a real model.
import { execSync, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, waitFor } from "./panel-testkit.mjs";
import { loadPlaywright } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const KEEP = argv.includes("--keep");

// A browser left open keeps node's loop alive and the log never lands: fail loudly instead of hanging.
const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 300_000);
const watchdog = setTimeout(() => {
  try {
    process.stderr.write(`WATCHDOG: ${WATCHDOG_MS}ms elapsed without the run finishing — see the last line printed.\n`);
  } catch {
    /* nothing left to do */
  }
  process.exit(1);
}, WATCHDOG_MS);

let checks = 0;
let failures = 0;
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
const lower = (p) => slash(p).replace(/\/+$/, "").toLowerCase();
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const listenersOn = (port) => {
  let out = "";
  try {
    out = execSync("netstat -ano", { encoding: "utf8", windowsHide: true });
  } catch (e) {
    out = String((e && e.stdout) || "");
  }
  return out.split(/\r?\n/).filter((l) => l.includes(`:${port} `) && l.includes("LISTENING")).length;
};

// ---- the fact the whole gate is about ---------------------------------------------------------------
// Longer than the alert's 70-character title AND longer than the console line's 200-character record of the ask, with a
// tail no clip can reach: that is what makes "the FULL question is in the card" a measurement instead of a claim.
const QUESTION =
  "Which of these three should the queue row take now that the sibling landing has moved main — land its PR immediately with --rebase --admin, wait for the next sweep so the sibling's gate runs first, or park the row until somebody confirms the tree is clean?";
const CHOICES = ["land it now (Recommended)", "wait for the next sweep", "park the row until the tree is clean"];
const T_ASKED = "wtgui-question-chip-asked-c0ffee";
const T_QUIET = "wtgui-question-chip-quiet-c0ffee";
const REQUEST_ID = "req-question-chip-1";

// ---- the stub Runs API ------------------------------------------------------------------------------
// The gateway's shape, with the one power this gate needs: it decides what a run says. `/clarify` records the answer
// body the panel posts, which is how "the answer read back in the chat" is proved about the panel rather than about the
// page's own words.
function makeStub() {
  const seen = { submitted: [], clarify: [], events: [] };
  const asked = new Set();
  const timers = new Set();
  const json = (code, body, res) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
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
      return json(200, { version: "question-chip-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_cwd: true } }, res);
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      const body = await readBody(req);
      seen.submitted.push(body);
      return json(200, { run_id: `stub-run-${seen.submitted.length}`, status: "running" }, res);
    }
    const m = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const sub = m[2] || "";
      if (sub === "/clarify") {
        const body = await readBody(req);
        seen.clarify.push({ id, ...body });
        return json(200, { ok: true, run_id: id }, res);
      }
      if (sub === "/approve") {
        seen.clarify.push({ id, approve: await readBody(req) });
        return json(200, { ok: true }, res);
      }
      if (sub === "/steer") {
        await readBody(req);
        return json(200, { accepted: true, run_id: id }, res);
      }
      if (sub === "/stop") return json(200, { ok: true }, res);
      if (sub === "/events") {
        seen.events.push(id);
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": attached\n\n");
        // The turn parks on the clarify tool a moment after it starts, exactly as a real run does — one request, then
        // the stream stays OPEN, because a parked run is still a live run.
        const park = setTimeout(() => {
          timers.delete(park);
          if (asked.has(id)) return;
          asked.add(id);
          const evt = {
            event: "clarify.request",
            prompt_id: REQUEST_ID,
            question: `${QUESTION}\n\nReply "skip" to skip this question.`,
            choices: CHOICES,
            multi_select: false,
            timeout_s: 900,
            timestamp: Math.floor(Date.now() / 1000),
          };
          try {
            res.write(`event: clarify.request\ndata: ${JSON.stringify(evt)}\n\n`);
          } catch {
            /* the listener went away with the panel */
          }
        }, 250);
        timers.add(park);
        const hold = setInterval(() => {
          try {
            res.write(": hold\n\n");
          } catch {
            clearInterval(hold);
            timers.delete(hold);
          }
        }, 500);
        timers.add(hold);
        req.on("close", () => {
          clearInterval(hold);
          clearTimeout(park);
          timers.delete(hold);
          timers.delete(park);
        });
        return;
      }
      // A GET of the run: pending_controls names the clarify, which is what the panel's answer path resolves a prompt
      // id from when the job's own copy is missing it.
      return json(200, {
        run_id: id,
        status: "running",
        pending_controls: asked.has(id) ? [{ kind: "clarify", prompt_id: REQUEST_ID, question: QUESTION }] : [],
      }, res);
    }
    json(404, { error: { message: "not found" } }, res);
  });
  return {
    seen,
    server,
    close: () =>
      new Promise((r) => {
        for (const t of timers) {
          clearInterval(t);
          clearTimeout(t);
        }
        timers.clear();
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

// ---- the sandbox ------------------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-question-chip-"));
const repos = path.join(dir, "repos");
const repo = path.join(repos, "sandbox-repo");
const home = path.join(dir, "hermes-home");
const configDir = path.join(dir, "panel");
const logs = path.join(configDir, "logs");
const cwds = [0, 1].map((i) => path.join(dir, "cwd", `t${i + 1}`));
for (const d of [repo, path.join(repo, ".worktrees"), home, configDir, logs, ...cwds]) mkdirSync(d, { recursive: true });
const git = (args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true }).trim();
git(["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# sandbox repo\n", "utf8");
git(["add", "."]);
git(["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "first"]);
// A run's cwd has to be a TREE of its own, not just a directory: `replyTree` refuses a resume in anything that is not
// a linked worktree or a repository's own checkout root (`lib/own-tree.js`). A plain temp dir 409s with
// "its tree is not a git repository", and that refusal used to be swallowed by an `ok(...)` handed an array — so the
// gate waited 30 s for a run the panel had never started. One repository per cwd is the cheapest honest shape.
for (const d of cwds) {
  execFileSync("git", ["-C", d, "init", "-q", "-b", "main"], { encoding: "utf8", windowsHide: true });
  writeFileSync(path.join(d, "README.md"), `# run dir ${path.basename(d)}\n`, "utf8");
  execFileSync("git", ["-C", d, "add", "."], { encoding: "utf8", windowsHide: true });
  execFileSync("git", ["-C", d, "-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "run dir"], { encoding: "utf8", windowsHide: true });
}

// Two settled turns, one per thread: a queue row needs a thread, and the CONTROL row needs one whose agent asked nothing.
// Dated in the past of this run's clock so the new run sorts after its own seed rather than behind it.
const SEED_START = Date.now() - 30 * 60_000;
const threads = [T_ASKED, T_QUIET];
const seededJobs = threads.map((thread, i) => ({
  id: `j-seed-${i + 1}`,
  thread,
  turn: 1,
  prompt: `the turn behind ${thread}`,
  cwd: cwds[i],
  ownerPath: null,
  projectPath: null,
  sessionId: thread,
  status: "done",
  exitCode: 0,
  startedAt: new Date(SEED_START + i * 60_000).toISOString(),
  endedAt: new Date(SEED_START + i * 60_000 + 40_000).toISOString(),
  runId: `run_seed_${i + 1}`,
  worktree: false,
  existing: false,
  worktreePath: null,
  branch: null,
  lines: [{ kind: "text", lid: i * 2 + 1, at: SEED_START + i * 60_000 + 40_000, text: "done — nothing left in this turn." }],
  finalMessage: "done — nothing left in this turn.",
}));
const jobsFile = path.join(logs, "jobs.json");
writeFileSync(jobsFile, JSON.stringify({ savedAt: new Date().toISOString(), jobs: seededJobs }), "utf8");

const stub = makeStub();
await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${stub.server.address().port}`;

let panel = null;
let liveBrowser = null;
try {
  console.log("\n== the sandbox: its own panel, its own state dir, its own gateway stub ==");
  const port = await freePort();
  ok("the sandbox port is not the live one", port !== 7331, `port ${port}`);
  const base = `http://127.0.0.1:${port}`;
  const configPath = path.join(configDir, "config.json");
  const config = {
    port,
    host: "127.0.0.1",
    scanRoots: [repos],
    // Long clocks: this gate drives every change itself and must not race a scan.
    refreshSeconds: 3600,
    worktreeSeconds: 3600,
    midSeconds: 3600,
    dormantSeconds: 3600,
    slowSeconds: 3600,
    fetchSeconds: 3600,
    threads: 1,
    scanMode: "all",
    defaultCwd: cwds[0],
    jobsFile,
    assistantFile: path.join(logs, "assistant.json"),
    projectsCacheFile: path.join(logs, "projects.json"),
    treeNamesFile: path.join(logs, "tree-names.json"),
    apiServer: { url: stubUrl, key: "sandbox-key" },
    // The sentry ON at its fastest legal clock (it is what raises the alert), budget zero (it must never start a turn).
    assistant: { enabled: true, autonomy: "draft", seconds: 2, maxWakesPerHour: 0 },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  for (const key of ["jobsFile", "assistantFile", "projectsCacheFile", "treeNamesFile"]) {
    ok(`…${key} is inside the sandbox (the reader's state is not touched)`, lower(config[key]).startsWith(lower(dir)), slash(config[key]));
  }

  const liveBefore = listenersOn(7331);
  const panelLog = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: TREE,
    env: {
      ...process.env,
      PANEL_CONFIG: configPath,
      HERMES_HOME: home,
      CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
      PANEL_TOKEN: "",
      API_SERVER_KEY: "",
    },
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
        /* Windows can still hold a file for a moment; the verdict does not depend on the cleanup */
      }
    },
  };
  const up = await waitFor(async () => (await fetch(`${base}/api/state`)).ok, {
    timeoutMs: 90_000,
    stepMs: 300,
    what: "the sandbox panel to answer /api/state",
  });
  if (!up) throw new Error(`the sandbox panel never came up on ${base}\n${panelLog.slice(-20).join("\n")}`);
  note(`tree  ${TREE}`);
  note(`panel ${base} (own data dir; the live board :7331 has ${liveBefore} listener(s) before)`);
  ok("the sandbox is the listener on its own port", listenersOn(port) >= 1, `${listenersOn(port)} listener(s) on :${port}`);
  note(`stub  ${stubUrl}`);

  const GET = async (p) => {
    const r = await fetch(`${base}${p}`);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const POST = async (p, body) => {
    const r = await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const queueRead = async () => (await GET("/api/assistant/queue?assistantId=assistant-1")).body;

  // ---- 1. the rows, and the run that parks on a question ---------------------------------------------
  console.log("\n== two rows on two threads, and a real run that stops to ask ==");
  const restored = await GET("/api/jobs");
  check("the panel restored the two seeded turns from ITS store", (restored.body.jobs || []).filter((j) => threads.includes(j.thread)).map((j) => j.status), ["done", "done"]);

  const added = [];
  added.push(await POST("/api/assistant/queue", { assistantId: "assistant-1", action: "add", title: "the row whose agent is asked", files: "public/assistant.js", thread: T_ASKED }));
  added.push(await POST("/api/assistant/queue", { assistantId: "assistant-1", action: "add", title: "the row nobody asked", files: "lib/assistant/queue.js", thread: T_QUIET }));
  check("two tasks are filed, each carrying its thread", added.map((r) => [r.status, r.body.task?.id, r.body.task?.thread]), [
    [200, 1, T_ASKED],
    [200, 2, T_QUIET],
  ]);
  const started = await POST("/api/assistant/queue", { assistantId: "assistant-1", action: "state", id: 1, state: "running" });
  ok("#1 is running (its agent is the run about to park)", started.body.task?.state === "running", JSON.stringify({ status: started.status, state: started.body.task?.state }));
  const reply = await POST("/api/agents/reply", { thread: T_ASKED, text: "carry the row until you need a decision" });
  // `check`, not `ok`: this line used to hand `ok` an array for its condition, which is truthy, so a reply the
  // panel REFUSED (404/409/503) still printed PASS and the gate then waited 30 s for a run nobody had started.
  check("a REAL run is started on its thread, against the stub", [reply.status, Boolean(reply.body.job?.id)], [202, true]);
  if (reply.status !== 202) note(`the panel refused the reply: ${reply.status} ${JSON.stringify(reply.body).slice(0, 400)}`);
  const parked = await waitFor(
    async () => {
      const j = (await GET("/api/jobs")).body.jobs || [];
      const mine = j.filter((x) => x.thread === T_ASKED).sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")));
      const last = mine[mine.length - 1];
      return last?.question?.requestId === REQUEST_ID ? last : false;
    },
    { timeoutMs: 30_000, stepMs: 250, what: "the stub's clarify.request to park the run" },
  );
  // The failure this diagnostic exists for: "the question never arrived" says nothing about WHERE it stopped. The
  // stub's own counters say whether the panel ever opened the event stream and whether the stub answered the run at
  // all; the job's last state says whether the run even started against the stub. A gate that cannot say which of
  // those broke is a gate the next reader has to debug by hand.
  let stubDiag = "";
  if (!parked) {
    const jobsNow = (await GET("/api/jobs")).body.jobs || [];
    stubDiag =
      ` — stub saw ${stub.seen.submitted.length} submission(s), ${stub.seen.events.length} event stream(s) ` +
      `[${stub.seen.events.join(", ")}]; reply job ${JSON.stringify(reply.body.job && { id: reply.body.job.id, thread: reply.body.job.thread, status: reply.body.job.status })}; ` +
      `jobs on the board: ${JSON.stringify(jobsNow.map((j) => [j.id, j.thread, j.status, j.startedAt]))}`;
  }
  ok("the panel's job store carries the question the gateway asked", Boolean(parked), parked ? `${String(parked.question.question).length} chars · ${parked.question.choices.length} choices · requestId ${parked.question.requestId}` : `never arrived${stubDiag}`);
  check("…with every choice the tool offered, verbatim", parked?.question?.choices, CHOICES);
  ok("…and the question is the FULL sentence (the console line clips it, this does not)", norm(parked?.question?.question) === QUESTION, `${norm(parked?.question?.question).length} chars, tail “${norm(parked?.question?.question).slice(-40)}”`);

  // ---- 2. the alert, from the route the brief names ---------------------------------------------------
  console.log("\n== the OPEN alert on that thread, out of /api/assistant/queue ==");
  const first = await queueRead();
  ok("the read answers a queue AND the assistant's state (the payload the chip joins from)", Boolean(first.queue) && Boolean(first.assistant), Object.keys(first).join(" + "));
  const alerts = Array.isArray(first.assistant?.alerts) ? first.assistant.alerts : [];
  // The alert is raised by the SENTRY on its own clock (2 s in this sandbox), not by this read: the page picks it up
  // on its next repaint, so the gate waits the same way instead of calling the feature broken because the tick had
  // not run yet.
  const alert = await waitFor(
    async () => {
      const d = await queueRead();
      const list = Array.isArray(d.assistant?.alerts) ? d.assistant.alerts : [];
      return list.find((a) => a.rule === "question" && a.thread === T_ASKED && a.status === "open") || false;
    },
    { timeoutMs: 15_000, stepMs: 250, what: "the sentry to publish the OPEN question alert" },
  );
  ok("an OPEN question alert is published for that thread", Boolean(alert), alert ? JSON.stringify({ rule: alert.rule, parked: alert.parked, requestId: alert.requestId, choices: alert.choices?.length }) : `open alerts: ${JSON.stringify(alerts.map((a) => [a.rule, a.thread, a.status]))}`);
  check("…the shape the chip joins on: parked, carrying a requestId", [alert?.parked, alert?.requestId], [true, REQUEST_ID]);
  check("…carrying every choice", alert?.choices, CHOICES);
  ok("…and its title is CLIPPED — the chip cannot be the question", String(alert?.title || "").length < QUESTION.length && String(alert?.title || "").includes("waiting on your answer"), `${String(alert?.title || "").length} of ${QUESTION.length} chars`);
  check("…and the queue's own row names the thread the alert is on", first.queue?.tasks?.find((t) => t.id === 1)?.thread, T_ASKED);
  const clarify = first.assistant?.clarify || null;
  ok("the same read carries what the panel knows about clarify (available / at / evidence)", Boolean(clarify) && "available" in clarify && "at" in clarify && "evidence" in clarify, JSON.stringify(clarify));
  const otherRows = (first.queue?.tasks || []).filter((t) => t.id !== 1 && [t.thread, ...(t.threads || [])].includes(T_ASKED));
  check("no other row is on that thread, so no other row can join", otherRows.map((t) => t.id), []);

  // ---- 3. the pane, in a real browser -----------------------------------------------------------------
  console.log("\n== the pane in headless Chromium: one chip, on the row the alert names ==");
  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  the chip was not read or pressed in a browser.");
    note("re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<a dir holding node_modules/playwright>");
    failures += 1;
  } else {
    const pageErrors = [];
    liveBrowser = await pw.chromium.launch({ headless: true });
    const context = await liveBrowser.newContext({ viewport: { width: 1500, height: 1100 } });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on("pageerror", (e) => pageErrors.push(`pageerror: ${String((e && e.message) || e)}`));
    page.on("console", (m) => {
      if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
    });

    const openQueue = async () => {
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#job-prompt", { state: "visible", timeout: 30_000 });
      // The float remembers it was open; pressing the button would CLOSE it, so wait for it instead.
      if (!(await page.locator("#assistant").isVisible())) await page.locator("#btn-assistant").click();
      await page.waitForSelector("#assistant", { state: "visible" });
      await page.waitForSelector('#as-tabs [data-as-tab="assistant-1"]');
      if (!(await page.locator("#as-queue").isVisible()) && (await page.locator("#as-subtabs").isVisible())) {
        await page.click('#as-subtabs [data-as-subtab="queue"]');
      }
      await page.waitForSelector("#as-queue:not(.hidden)");
    };
    // Every row's chip, read as the page draws it — the class list, the opener, and the stylesheet's own computed style
    // so "reuses .as-task-hold, no CSS added" is a measurement against a plain button rather than a class name.
    const readRows = () =>
      page.evaluate(() => {
        const style = (el) => {
          if (!el) return null;
          const cs = getComputedStyle(el);
          return { radius: cs.borderTopLeftRadius, bg: cs.backgroundColor, size: cs.fontSize, pad: cs.paddingTop };
        };
        const plain = document.querySelector('#as-queue [data-as-qact="reload"]');
        const rows = [...document.querySelectorAll("#as-queue .as-task")].map((el) => {
          const chip = el.querySelector("button.as-task-hold");
          return {
            id: Number(el.dataset.asQrow),
            thread: el.dataset.asQthread || "",
            title: (el.querySelector(".as-task-title")?.textContent || "").trim(),
            chip: chip
              ? {
                  text: chip.textContent.trim(),
                  classes: [...chip.classList],
                  opens: chip.dataset.asQopen || "",
                  qid: chip.dataset.asQid || "",
                  alertId: chip.dataset.asQquestion || "",
                  tag: chip.tagName,
                  style: style(chip),
                  hoverHint: getComputedStyle(chip).cursor,
                }
              : null,
            hold: el.querySelector(".as-task-hold[data-as-qhold]") ? style(el.querySelector(".as-task-hold[data-as-qhold]")) : null,
          };
        });
        return { rows, plain: style(plain) };
      });

    await openQueue();
    const painted = await waitFor(async () => ((await readRows()).rows.length === 2 ? readRows() : false), {
      timeoutMs: 30_000,
      stepMs: 200,
      what: "the two queue rows to paint",
    });
    ok("the pane paints one row per task", Boolean(painted), painted ? painted.rows.map((r) => `#${r.id} ${r.thread}`).join(" · ") : "never painted");

    // The alert is raised on the sentry's clock, so the chip arrives after the row — wait for it, then read the whole row.
    const chipped = await waitFor(async () => {
      const now = await readRows();
      return now.rows.filter((r) => r.chip).length === 1 ? now : false;
    }, { timeoutMs: 25_000, stepMs: 250, what: "one row to wear the question chip" });
    const got = chipped || (await readRows());
    const withChip = got.rows.filter((r) => r.chip);
    check("exactly ONE row of the two wears the chip", withChip.map((r) => r.id), [1]);
    const chip = withChip[0]?.chip || null;
    ok("…the row whose thread the alert names", withChip[0]?.thread === T_ASKED, `${withChip[0]?.thread || "(none)"} vs ${T_ASKED}`);
    check("…reading the single word `question`", chip?.text, "question");
    check("…as a button on the row, not a link or a span", chip?.tag, "BUTTON");
    check("…carrying the hold badge's own class and no second class", chip?.classes, ["as-task-hold"]);
    check("…and the press the agent row already uses (data-as-qopen on the ALERT's thread)", [chip?.opens, chip?.qid, chip?.alertId], [T_ASKED, "1", String(alert?.id || "")]);
    ok("…so the chip's computed style is the hold badge's rule, not a bare button's", JSON.stringify(chip?.style) !== JSON.stringify(got.plain), `chip ${JSON.stringify(chip?.style)} · plain button ${JSON.stringify(got.plain)}`);
    check("…and it is styled as a pill, from that one class", [chip?.style?.radius, chip?.style?.bg], ["999px", "rgb(36, 31, 54)"]);
    check("the row that was asked nothing carries no chip", got.rows.find((r) => r.id === 2)?.chip || null, null);

    // ---- 4. the press: the agent's card, on its console, with the whole question in it -----------------
    console.log("\n== the press lands on that agent's console, and the question reads there in full ==");
    await page.click(`#as-queue .as-task[data-as-qrow="1"] button.as-task-hold`);
    const landed = await waitFor(
      () =>
        page.evaluate((t) => {
          const card = document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
          const pre = card?.querySelector("pre.job-out");
          const active = document.activeElement;
          const rect = pre?.getBoundingClientRect();
          const inView = Boolean(rect) && rect.top >= 0 && rect.bottom <= window.innerHeight + 1;
          return Boolean(pre) && active === pre ? { focused: true, inView, card: t } : false;
        }, T_ASKED),
      { timeoutMs: 15_000, stepMs: 150, what: "the parked turn's console to take focus", silent: true },
    );
    ok("clicking the chip focuses that agent's console (the agent row's own opener)", Boolean(landed), landed ? JSON.stringify(landed) : "the console never took focus");
    const card = await page.evaluate((t) => {
      const box = document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
      const q = box?.querySelector(".turn-question");
      const pre = box?.querySelector("pre.job-out");
      return {
        card: Boolean(box),
        // The console and the question are in the SAME card — the press lands on the console and the question is the
        // thing under that turn, not a paragraph in another pane. (The console sits in an `.out-wrap`, so its parent
        // is not the question box's; the card is the unit both belong to.)
        sameBody: Boolean(q && pre && q.closest(".job") === pre.closest(".job")),
        questionVisible: Boolean(q && q.getBoundingClientRect().height > 0),
        question: (q?.querySelector(".tq-question")?.textContent || "").trim(),
        choices: [...(q?.querySelectorAll(".tq-choice .tq-text") || [])].map((el) => el.textContent.trim()),
        recommended: [...(q?.querySelectorAll(".tq-choice .tq-rec") || [])].map((el) => el.textContent.trim()),
        head: (q?.querySelector(".tq-head")?.textContent || "").trim(),
        typed: Boolean(q?.querySelector(".tq-other")),
        consoleLine: (pre?.textContent || "").includes("❓ question asked:"),
        consoleText: pre?.textContent || "",
      };
    }, T_ASKED);
    ok("the agent's card is up, with the console and the question in the same card", card.card && card.sameBody && card.questionVisible);
    check("the FULL question is readable there — not the alert's clipped title", norm(card.question), QUESTION);
    ok("…including the tail no 200-character console record can hold", norm(card.question).endsWith("confirms the tree is clean?"), `tail “${norm(card.question).slice(-42)}”`);
    check("…every choice the tool offered", card.choices, ["land it now", "wait for the next sweep", "park the row until the tree is clean"]);
    check("…with the tool's recommendation drawn as its own chip, not eaten from the label", card.recommended, ["recommended"]);
    ok("…and a box to answer with words as well", card.typed, card.head || "(no head)");
    ok("the console's own record of the ask is there too (clipped by its own row)", card.consoleLine && !card.consoleText.includes("confirms the tree is clean?"), `${card.consoleText.match(/❓ question asked: [^\n]*/)?.[0]?.length || 0} chars in the stream line`);

    // ---- 5. the answer, read back in that chat ---------------------------------------------------------
    console.log("\n== the answer: pressed in the card, posted with the alert's request id, read back there ==");
    await page.click(`.job[data-thread="${T_ASKED}"] .tq-choice`);
    const answered = await waitFor(
      () =>
        page.evaluate((t) => {
          const box = document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
          const done = box?.querySelector(".turn-question-done");
          return done ? { text: done.textContent.trim(), title: done.getAttribute("title") || "", boxGone: !box.querySelector(".turn-question") } : false;
        }, T_ASKED),
      { timeoutMs: 20_000, stepMs: 200, what: "the answered line in that card" },
    );
    ok("the card becomes the answer…", Boolean(answered), answered ? JSON.stringify(answered) : "the line never appeared");
    check("…reading the choice that was sent", answered?.text, "✓ answered: land it now (Recommended)");
    ok("…and the question box is gone with it", answered?.boxGone === true);
    check("the answer went to the stub with the alert's own request id", [stub.seen.clarify.at(-1)?.request_id, stub.seen.clarify.at(-1)?.answer], [REQUEST_ID, "land it now (Recommended)"]);

    // The alert closes on the sentry's own tick (2 s here), with no assistant event behind it. Wait for the SERVER to
    // say so first, then press the pane's own Refresh: the pane holds its answer for 20 s, so a read taken before the
    // closure is a correct read of an alert that was still open — and the gate would then be measuring its own timing.
    const closedAlerts = await waitFor(
      async () => {
        // `/api/assistant` answers the state itself (no `assistant` wrapper — that is only the queue route's
        // envelope), so a `body.assistant?.alerts` read here is always `undefined` and always "closed".
        const open = ((await GET("/api/assistant")).body.alerts || []).filter((a) => a.thread === T_ASKED && a.status === "open");
        return open.length === 0 ? [] : false;
      },
      { timeoutMs: 15_000, stepMs: 250, what: "the sentry to close the answered question's alert" },
    );
    check("the alert itself is no longer open", closedAlerts, []);
    // The chip is bound to an OPEN alert, and the pane's list is a CACHE: the reader's own Refresh is the read that
    // re-answers. Pressing it is the proof that the chip follows the alert rather than the row — a stale badge on a
    // resolved question is the failure this rules out.
    await page.evaluate(() => document.querySelector('#as-queue [data-as-qact="reload"]')?.click());
    const cleared = await waitFor(async () => {
      const now = await readRows();
      return now.rows.every((r) => !r.chip) ? now : false;
    }, { timeoutMs: 20_000, stepMs: 250, what: "the chip to go once the question is answered and the pane re-read" });
    ok("…and the chip goes with the question it was about", Boolean(cleared), cleared ? cleared.rows.map((r) => `#${r.id} chip=${Boolean(r.chip)}`).join(" · ") : "still chipped after 20s");

    // The press on a chip must not have been a page of its own errors.
    check("the page raised no errors driving the pane", pageErrors.slice(0, 3), []);
  }

  check("the live board's listener count is unchanged by this run", listenersOn(7331), liveBefore);
} catch (err) {
  failures += 1;
  console.log(`\nFAIL  the run threw: ${String((err && err.stack) || err)}`);
  if (panel) console.log(`--- panel log (tail)\n${String(panel.log()).split(/\r?\n/).slice(-25).join("\n")}`);
} finally {
  clearTimeout(watchdog);
  try {
    if (liveBrowser) await liveBrowser.close();
  } catch {
    /* the verdict does not depend on the cleanup */
  }
  try {
    await stub.close();
  } catch {
    /* same */
  }
  if (panel && !KEEP) {
    try {
      await panel.stop();
    } catch {
      /* the verdict does not depend on the cleanup */
    }
  }
}

console.log("\n== summary ==");
console.log(`${checks - failures}/${checks} checks held`);
console.log("WHAT WAS DRIVEN: a panel booted from the tree under test over its own data dir and a stub Runs API; a real run");
console.log("parked on `clarify.request`; the OPEN alert read out of /api/assistant/queue (rule, parked, requestId, choices,");
console.log("a clipped title); the queue pane in headless Chromium with ONE `question` chip on the row whose thread asked and");
console.log("none on its control; the chip's press focusing that agent's console; the FULL question, its three choices and the");
console.log("recommendation drawn in that card; and the answer posted with the alert's request id and read back as one line.");
if (!failures) console.log("QUEUE-QUESTION-CHIP-OK");
process.exitCode = failures ? 1 : 0;
