// The per-assistant queue, end to end: several tasks at once, driven queued → running → done against the REAL job
// store, two of them moved to Assistant #2 through the pane's own Move control, and every row chip checked against
// `/api/jobs` at each step rather than against the page's own words.
//
//   node tools/verify-assistant-queue-e2e.mjs
//
// WHAT THIS ADDS to tools/verify-assistant-queue.mjs (the browser gate for the sub-tab's four markers). That gate drives
// the STORE and the ROUTES and paints four rows; its tasks never have a thread that a run is actually turning, and it
// asserts the reassign by the owner field alone. This one boots its own panel over its own state directory and its own
// stub Runs API, gives four tasks four real threads, starts real runs on them through `POST /api/agents/reply`, settles
// them as completed / failed / cancelled through the gateway's own terminal events, and reads the queue back — so the
// task states and the consoles' pills are answers about the job store, not about the fixture.
//
// WHAT IS DRIVEN, in order:
//
//   1. THE SANDBOX IS ITS OWN. A free port (checked ≠ 7331), a throwaway state directory, a throwaway scanned repo, a
//      throwaway HERMES_HOME, and every path the panel is handed (jobs, assistant, queue, project cache) is asserted to
//      sit inside that directory. The live board's 7331 listener count is compared before and after, so "it never
//      touched the reader's panel" is a measurement and not a promise (item 1);
//   2. FOUR TASKS AT ONCE. Four POSTs in flight together into Assistant #1's queue: four ids, no lost write, all
//      queued. Assistant #2 is created first so the Move control exists (item 2);
//   3. QUEUED → RUNNING → DONE, and the two other endings. Each task's thread is a seeded card in the panel's own jobs
//      store; `POST /api/agents/reply` starts a run on it against the stub, the stub answers the terminal event, and
//      `/api/jobs` is the only thing asked what happened. The panel's own sentry sweep marks the finished one done
//      (doneBy "panel") and puts the failed one back in the queue with attempts+1 — no queue route is asked to do
//      either, so the transition is the panel's real eager-completion path (items 2, 4);
//   4. THE CHIPS. At EVERY step the four cards' pills are read from the DOM and compared with the word `/api/jobs`
//      implies for that thread's latest run — RUNNING (a live status), COMPLETE (`done`), EXITED (`failed`), else
//      NOT-RUNNING — including the class, the ↻ glyph and the hook each word carries. The expected word is computed
//      from the API before the DOM is read; the page's own text is never the expectation it is measured against
//      (item 4);
//   5. TWO MOVED. Through the pane's own Move control, with a real click: parked #3 and live-running #4 go to
//      Assistant #2. Asserted from the routes AND from the two queue files on disk: they leave Assistant #1's list,
//      arrive in Assistant #2's under ids that queue has never used, keep their state, thread and files, and carry
//      `movedFrom` naming assistant-1 → assistant-2, by "reader" (item 3); then Assistant #2's pane is opened and paints
//      exactly those two rows.
//
// WHAT IS ONLY INSPECTED: the chips' uppercase casing is the stylesheet's (asserted as the computed `text-transform` on
// the pill the page drew, not as a second rule re-implemented here).
//
// The browser half needs a Playwright install; without one this prints BROWSER-HALF-NOT-RUN and exits non-zero rather
// than passing a half that never ran. The live panel on :7331 and the live gateway are never touched: the stub answers
// on an ephemeral port of its own.
import { execSync, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROOT, freePort, waitFor } from "./panel-testkit.mjs";
import { loadPlaywright } from "./browser.mjs";

// A browser left open keeps node's loop alive and the log never lands: fail loudly instead of hanging.
const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 300_000);
const watchdog = setTimeout(() => {
  try {
    process.stderr.write(`WATCHDOG: ${WATCHDOG_MS}ms elapsed without the run finishing — see the last line above.\n`);
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
const lower = (p) => slash(p).replace(/\/+$/, "").toLowerCase();
const listenersOn = (port) => {
  let out = "";
  try {
    out = execSync("netstat -ano", { encoding: "utf8", windowsHide: true });
  } catch (e) {
    out = String((e && e.stdout) || "");
  }
  return out.split(/\r?\n/).filter((l) => l.includes(`:${port} `) && l.includes("LISTENING")).length;
};

// ---- the stub Runs API -------------------------------------------------------------------------------------------
// The gateway's shape, with the one power this gate needs: the test decides when a run ends and how. Every run body the
// panel posts is kept, so "which thread was asked to run" is a fact about the panel rather than an inference from the
// store afterwards. A run whose answer says "running" holds its event stream open, exactly like a real gateway.
function makeStub() {
  const answers = new Map();
  const seen = { submitted: [], status: [], steer: [], events: [] };
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
      return json(200, { version: "queue-e2e-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_cwd: true } }, res);
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      const body = await readBody(req);
      seen.submitted.push(body);
      const runId = `stub-run-${seen.submitted.length}`;
      return json(200, { run_id: runId, status: "running" }, res);
    }
    const m = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const sub = m[2] || "";
      if (sub === "/steer") {
        seen.steer.push({ id, body: await readBody(req) });
        return json(200, { accepted: true, run_id: id }, res);
      }
      if (sub === "/stop") return json(200, { ok: true }, res);
      if (sub === "/events") {
        seen.events.push(id);
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": attached\n\n");
        const timer = setInterval(() => {
          const cur = answers.get(id) || null;
          if (!cur || cur.status === "running") {
            res.write(": hold\n\n");
            return;
          }
          clearInterval(timer);
          timers.delete(timer);
          if (cur.output) res.write(`event: message.delta\ndata: ${JSON.stringify({ event: "message.delta", delta: `\n\n${cur.output}` })}\n\n`);
          res.write(`event: run.${cur.status}\ndata: ${JSON.stringify({ event: `run.${cur.status}`, output: cur.output, usage: cur.usage, exit_code: cur.exit_code })}\n\n`);
          res.end();
        }, 120);
        timers.add(timer);
        req.on("close", () => {
          clearInterval(timer);
          timers.delete(timer);
        });
        return;
      }
      seen.status.push(id);
      const a = answers.get(id) || { status: "running" };
      if (a.code && a.code !== 200) return json(a.code, a.body || { error: { message: `stub ${a.code}`, code: "stub_error" } }, res);
      return json(200, { run_id: id, ...a }, res);
    }
    json(404, { error: { message: "not found" } }, res);
  });
  return {
    seen,
    server,
    set: (id, body) => answers.set(id, body),
    close: () =>
      new Promise((r) => {
        for (const t of timers) clearInterval(t);
        timers.clear();
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

// ---- the sandbox: its own port, its own state directory, its own repo --------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-queue-e2e-"));
const repos = path.join(dir, "repos");
const repo = path.join(repos, "sandbox-repo");
const home = path.join(dir, "hermes-home");
const configDir = path.join(dir, "panel");
const logs = path.join(configDir, "logs");
// One working directory per thread: the panel's `busyFor` treats agents in ONE tree as busy with each other, so four
// threads in one folder would refuse each other's replies. Four folders is also closer to how four workers sit in four
// worktrees.
const THREADS = ["wtgui-queue-e2e-a-4f21b0", "wtgui-queue-e2e-b-4f21b0", "wtgui-queue-e2e-c-4f21b0", "wtgui-queue-e2e-d-4f21b0"];
const cwds = THREADS.map((_, i) => path.join(dir, "cwd", `t${i + 1}`));
for (const d of [repo, path.join(repo, ".worktrees"), home, configDir, logs, ...cwds]) mkdirSync(d, { recursive: true });
const git = (args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true }).trim();
git(["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# sandbox repo\n", "utf8");
git(["add", "."]);
git(["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "first"]);

const TASKS = [
  { title: "land the queue's own end-to-end gate", files: "tools/verify-assistant-queue-e2e.mjs", detail: "the four chips and the two moves" },
  { title: "rewrite the Move into a move between queues", files: "lib/assistant.js, lib/assistant/queue.js", detail: "the record leaves the source file" },
  { title: "SQL verify for the moved tasks", files: "docs/sql-verify/move.sql", detail: "the DBA's own check" },
  { title: "record the e2e run in the landing doc", files: "docs/landing-assistant-queue-e2e-2026-11-02.md", detail: "" },
];

const stub = makeStub();
await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${stub.server.address().port}`;

// The four cards whose pills are read: one seeded, settled turn per thread, so every task has a thread the panel's job
// store really holds before a run starts on it. The starts are fixed and apart so "the latest turn of this thread" is a
// fact about the store rather than about the clock the test happens to run on — but they must be anchored to the clock:
// a hard-coded `09:00Z` seeded turns that had not happened yet when this gate ran at 07:10Z, and every run it started
// then sorted BEFORE the seed, so `/api/jobs` kept answering the seed's `done` and the gate settled a run nobody held.
const SEED_START = Date.now() - 30 * 60_000;
const seededJobs = THREADS.map((thread, i) => ({
  id: `j-seed-${i + 1}`,
  thread,
  turn: 1,
  prompt: `the turn behind ${TASKS[i].title}`,
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
  lines: [
    { kind: "text", lid: i * 2 + 1, at: SEED_START + i * 60_000 + 40_000, text: "done — nothing left in this turn." },
  ],
  finalMessage: "done — nothing left in this turn.",
}));
const jobsFile = path.join(logs, "jobs.json");
writeFileSync(jobsFile, JSON.stringify({ savedAt: seededJobs[0].startedAt, jobs: seededJobs }), "utf8");
for (const j of seededJobs) stub.set(j.runId, { status: "completed", exit_code: 0, output: j.finalMessage });

const liveBefore = listenersOn(7331);
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const configPath = path.join(configDir, "config.json");
const config = {
  port,
  host: "127.0.0.1",
  scanRoots: [repos],
  // Long clocks: this gate drives every change itself and must not be racing a scan or a fetch.
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
  // The stub, and only the stub: a key is present because `probe()` refuses to call a keyless gateway reachable.
  apiServer: { url: stubUrl, key: "sandbox-key" },
  // The sentry is ON at its fastest legal clock, with a wake budget of zero: its sweep is the panel's own eager
  // completion (a settled `done` run marks the task done, a failed one re-queues it), which is what item 2 asks to be
  // driven; the budget keeps it from starting a turn of its own on the stub.
  assistant: { enabled: true, autonomy: "draft", seconds: 2, maxWakesPerHour: 0 },
};
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

let panel = null;
let liveBrowser = null;
try {
  console.log(`\n== the sandbox: a panel of its own on its own port and state dir ==`);
  note(`temp root ${dir}`);
  ok("the sandbox port is free of 7331", port !== 7331, `port ${port}`);
  ok("the sandbox config is on disk inside the sandbox", lower(configPath).startsWith(lower(dir)), slash(configPath));
  for (const key of ["jobsFile", "assistantFile", "projectsCacheFile", "treeNamesFile"]) {
    ok(`…${key} is inside it (the reader's state is not touched)`, lower(config[key]).startsWith(lower(dir)), slash(config[key]));
  }
  // The four seeded turns are the "latest turn" of their threads until a run starts; if they were dated ahead of this
  // run's clock every new run would sort behind them and item 4 would be measured against a turn nobody is holding.
  ok("the seeded turns are in the PAST of this run's clock", SEED_START + 4 * 60_000 < Date.now(), new Date(SEED_START).toISOString());
  const panelLog = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
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
    },
  };
  const up = await waitFor(async () => (await fetch(`${base}/api/state`)).ok, {
    timeoutMs: 90_000,
    stepMs: 300,
    what: "the sandbox panel to answer /api/state",
  });
  if (!up) throw new Error(`the sandbox panel never came up on ${base}\n${panelLog.slice(-20).join("\n")}`);
  ok("the sandbox panel announced its OWN port", panelLog.some((l) => l.includes(`agent-worktree-gui on http://127.0.0.1:${port}`)), `:${port}`);
  ok("…and never bound 7331 (its own log names no other listener)", !panelLog.some((l) => /on http:\/\/127\.0\.0\.1:7331\b/.test(l)));
  ok("the sandbox is the listener on its port", listenersOn(port) >= 1, `${listenersOn(port)} listener(s) on :${port}`);
  note(`the live board's 7331 listener count is ${liveBefore} before this run`);

  const GET = async (p) => {
    const r = await fetch(`${base}${p}`);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const POST = async (p, body) => {
    const r = await fetch(`${base}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const queueOf = async (id = "assistant-1") => (await GET(`/api/assistant/queue?assistantId=${id}`)).body.queue || null;

  // The store the panel is serving is the store this gate seeded — not the reader's.
  const jobsNow = await GET("/api/jobs");
  check("the panel restored the four seeded cards from ITS store", (jobsNow.body.jobs || []).filter((j) => THREADS.includes(j.thread)).length, 4);
  const q1 = await queueOf();
  ok("Assistant #1's queue is inside the sandbox", lower(q1?.file).startsWith(lower(dir)), slash(q1?.file));
  ok("…and is a real file", Boolean(q1?.file) && (() => { try { return readFileSync(q1.file, "utf8").length > 0; } catch { return false; } })());

  // ---- 2. four tasks at once -------------------------------------------------------------------------------------
  console.log("\n== four tasks at once, then Assistant #2 so the Move control exists ==");
  const made = await POST("/api/assistant/assistants", { name: "Settler" });
  check("Assistant #2 is created", [made.status, made.body.created?.id], [201, "assistant-2"]);
  // The path shape is the route's, not this file's guess: Assistant #1's queue file was read above, and #2's is the same
  // directory with its own id. (A hard-coded `<tmp>/assistants/...` missed the `panel/logs` half and read a missing file.)
  const queueFileFor = (id) => slash(q1.file).replace(/\/assistant-1\/queue\.json$/, `/${id}/queue.json`);
  ok("…and its queue file exists at creation, before any write", (() => { try { return readFileSync(queueFileFor("assistant-2"), "utf8").includes('"tasks"'); } catch { return false; } })(), queueFileFor("assistant-2"));

  const added = await Promise.all(
    TASKS.map((t) => POST("/api/assistant/queue", { assistantId: "assistant-1", action: "add", title: t.title, detail: t.detail, files: t.files, thread: THREADS[TASKS.indexOf(t)], owner: "assistant-1" })),
  );
  check("four adds in flight together all answer 200", added.map((r) => r.status), [200, 200, 200, 200]);
  check("…with four distinct ids, none lost to a concurrent write", added.map((r) => r.body.task?.id).sort((a, b) => a - b), [1, 2, 3, 4]);
  check("…all queued", added.map((r) => r.body.task?.state), ["queued", "queued", "queued", "queued"]);
  check("…each carrying the thread it will run on", added.map((r) => r.body.task?.thread), THREADS);
  const four = await queueOf();
  check("Assistant #1's queue counts four queued tasks", [four.counts.total, four.counts.queued], [4, 4]);
  check("…and the served file holds all four", JSON.parse(readFileSync(four.file, "utf8")).tasks.length, 4);
  const listed = await GET("/api/assistant/queue");
  check("the list form answers one view per assistant", (listed.body.queues || []).map((q) => [q.assistantId, q.counts.total]), [["assistant-1", 4], ["assistant-2", 0]]);

  // ---- 4. the chips, computed from /api/jobs -----------------------------------------------------------------------
  // The DOM read is below; this is the ONLY place a status becomes a word, and it reads the panel's own answer.
  const CHIP = {
    RUNNING: { word: "running", classes: ["pill", "pill-running"], tag: "SPAN", glyph: false },
    COMPLETE: { word: "complete", classes: ["pill", "pill-complete"], tag: "BUTTON", glyph: false },
    // Both not-running words share the one clickable pill in public/app.js (`.pill-notrunning.pill-continue`, plus
    // `.is-failed` for a failed run); the class set is read from that renderer, not guessed here.
    EXITED: { word: "exited", classes: ["is-failed", "pill", "pill-continue", "pill-notrunning"], tag: "BUTTON", glyph: true },
    "NOT-RUNNING": { word: "not-running", classes: ["pill", "pill-continue", "pill-notrunning"], tag: "BUTTON", glyph: true },
  };
  const LIVE_STATUS = new Set(["running", "starting", "waiting", "waiting_for_approval", "queued"]);
  const chipForStatus = (status) => {
    const s = String(status || "").toLowerCase();
    if (LIVE_STATUS.has(s)) return "RUNNING";
    if (s === "done") return "COMPLETE";
    if (s === "failed") return "EXITED";
    return "NOT-RUNNING";
  };

  // The latest turn of every thread, from the panel's own route. `list()` is newest-first, but the sort here is on the
  // clock the page sorts by so the answer cannot depend on the store's iteration order.
  const latestByThread = async () => {
    const body = (await GET("/api/jobs")).body;
    const map = new Map();
    for (const j of body.jobs || []) {
      const t = String(j.thread || "");
      const prev = map.get(t);
      if (!prev || String(j.startedAt || "").localeCompare(String(prev.startedAt || "")) >= 0) map.set(t, j);
    }
    return map;
  };
  const chipOf = (page, thread) =>
    page.evaluate((t) => {
      const card = document.querySelector(`.job[data-thread="${t}"]`);
      if (!card) return { card: false };
      const pill = card.querySelector(".job-head .pill");
      if (!pill) return { card: true, pill: false };
      const cs = getComputedStyle(pill);
      return {
        card: true,
        pill: true,
        tag: pill.tagName,
        text: pill.textContent.trim(),
        word: pill.textContent.replace(/\u21bb/g, "").trim(),
        classes: [...pill.classList].sort(),
        casing: cs.textTransform,
        glyph: Boolean(pill.querySelector(".pill-again")),
        hooks: {
          complete: pill.hasAttribute("data-complete-ask"),
          continue: pill.hasAttribute("data-continue-thread"),
          reattach: pill.hasAttribute("data-reattach-job"),
        },
      };
    }, thread);

  let page = null;
  const assertChip = async (step, thread, want, { settled = false } = {}) => {
    const spec = CHIP[want];
    const read = await waitFor(
      async () => {
        const got = await chipOf(page, thread);
        return got.card && got.pill && got.word === spec.word && JSON.stringify(got.classes) === JSON.stringify(spec.classes) ? got : false;
      },
      { timeoutMs: 15_000, stepMs: 150, what: `${thread}'s chip to read ${want}`, silent: true },
    );
    const got = read || (await chipOf(page, thread));
    if (!read) note(`${step}: ${thread} — the card read ${JSON.stringify({ card: got.card, word: got.word, classes: got.classes })}`);
    check(`${step}: ${thread} — /api/jobs says ${want}, the card wears ${spec.word}`, got.word, spec.word);
    check(`${step}: ${thread} — …with ${want}'s own class`, got.classes, spec.classes);
    check(`${step}: ${thread} — …as a ${spec.tag.toLowerCase()}${spec.glyph ? " with the ↻ glyph" : " with no ↻ glyph"}`, [got.tag, got.glyph], [spec.tag, spec.glyph]);
    if (settled) check(`${step}: ${thread} — …uppercased by the sheet, so the reader reads ${want}`, got.casing, "uppercase");
  };
  // Every card the page shows, against every thread the store holds. Retried, because the two reads are two moments and
  // a run can settle between them; the final comparison is still exact.
  const assertEveryCardAgrees = async (step) => {
    const agreed = await waitFor(
      async () => {
        const map = await latestByThread();
        const cards = await page.$$eval(".job[data-thread]", (els) =>
          els
            .filter((el) => el.querySelector(".job-head .pill"))
            .map((el) => ({ thread: el.dataset.thread, word: el.querySelector(".job-head .pill").textContent.replace(/\u21bb/g, "").trim() })),
        );
        if (!cards.length) return false;
        const want = cards.map((c) => ({ thread: c.thread, word: CHIP[chipForStatus(map.get(c.thread)?.status)].word }));
        const same = JSON.stringify(cards.map((c) => [c.thread, c.word]).sort()) === JSON.stringify(want.map((c) => [c.thread, c.word]).sort());
        return same ? { cards: cards.length, words: cards.map((c) => c.word) } : false;
      },
      { timeoutMs: 12_000, stepMs: 250, what: "every card's chip to agree with /api/jobs", silent: true },
    );
    ok(`${step}: every card on the page reads the word /api/jobs gives its thread`, Boolean(agreed), agreed ? `${agreed.cards} card(s): ${[...new Set(agreed.words)].sort().join(", ")}` : "the page and /api/jobs disagreed for 12s");
  };

  // ---- the browser, which draws the cards and later the panes ------------------------------------------------------
  const bootSettled = await waitFor(() => panelLog.some((l) => /parents: .*resolved/.test(l)), {
    timeoutMs: 120_000,
    stepMs: 500,
    what: "the boot's own git pass to finish",
  });
  ok("the boot's git pass has finished before a browser opens", bootSettled);

  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  the row chips were not read from a real page.");
    note("re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<a dir holding node_modules/playwright>");
    failures += 1;
  } else {
    const pageErrors = [];
    liveBrowser = await pw.chromium.launch({ headless: true });
    const context = await liveBrowser.newContext({ viewport: { width: 1500, height: 1000 } });
    page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on("pageerror", (e) => pageErrors.push(`pageerror: ${String((e && e.message) || e)}`));
    page.on("console", (m) => {
      if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
    });
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#job-prompt", { state: "visible", timeout: 30_000 });
    const cardsUp = await waitFor(() => page.$$eval(".job[data-thread]", (els) => els.length >= 4), {
      timeoutMs: 40_000,
      stepMs: 250,
      what: "the four seeded cards to be drawn",
    });
    ok("all four task threads are drawn as cards in the console", cardsUp, `${await page.locator(".job[data-thread]").count()} card(s)`);

    // ---- step 0: four queued tasks, four settled threads → every chip COMPLETE -----------------------------------
    console.log("\n== step 0: the four tasks queued, their seeded threads done ==");
    let latest = await latestByThread();
    note(`/api/jobs → ${THREADS.map((t) => `${t}: ${latest.get(t)?.status}`).join(" · ")}`);
    check("…which is the word COMPLETE for all four", THREADS.map((t) => chipForStatus(latest.get(t)?.status)), ["COMPLETE", "COMPLETE", "COMPLETE", "COMPLETE"]);
    for (const t of THREADS) await assertChip("step 0", t, "COMPLETE", { settled: t === THREADS[0] });
    await assertEveryCardAgrees("step 0");

    // ---- step 1: start two of them, on real runs through the stub -------------------------------------------------
    console.log("\n== step 1: two tasks running, on runs the stub is holding open ==");
    for (const i of [0, 1]) {
      const start = await POST("/api/assistant/queue", { assistantId: "assistant-1", action: "state", id: i + 1, state: "running" });
      ok(`task #${i + 1} is marked running with its thread`, start.body.task?.state === "running" && start.body.task?.thread === THREADS[i], JSON.stringify({ state: start.body.task?.state, thread: start.body.task?.thread }));
      const reply = await POST("/api/agents/reply", { thread: THREADS[i], text: `carry task #${i + 1} to its end` });
      ok(`…and a real run is asked for on ${THREADS[i]}`, [reply.status, Boolean(reply.body.job?.id)], [202, true]);
    }
    const twoLive = await waitFor(
      async () => {
        const m = await latestByThread();
        return [0, 1].every((i) => LIVE_STATUS.has(String(m.get(THREADS[i])?.status || ""))) && [2, 3].every((i) => m.get(THREADS[i])?.status === "done");
      },
      { timeoutMs: 30_000, stepMs: 250, what: "the two replies to be live runs in the store" },
    );
    ok("the job store says two threads are live and two are still the seeded turns", twoLive);
    latest = await latestByThread();
    note(`/api/jobs → ${THREADS.map((t) => `${t}: ${latest.get(t)?.status}`).join(" · ")}`);
    await assertChip("step 1", THREADS[0], "RUNNING", { settled: true });
    await assertChip("step 1", THREADS[1], "RUNNING");
    await assertChip("step 1", THREADS[2], "COMPLETE");
    await assertChip("step 1", THREADS[3], "COMPLETE");
    await assertEveryCardAgrees("step 1");
    const running1 = (await queueOf()).tasks.find((t) => t.id === 1);
    ok("…and the queue knows #1's thread is really live (not stale)", running1?.stale === undefined, JSON.stringify({ state: running1?.state, stale: running1?.stale }));

    // ---- step 2: #1's run completes → COMPLETE, and the PANEL marks the task done ---------------------------------
    console.log("\n== step 2: #1's run completes; the panel's own sweep closes the task ==");
    const run1 = latest.get(THREADS[0])?.runId;
    ok("the live run is the one the store names", Boolean(run1) && stub.seen.events.includes(run1), String(run1));
    stub.set(run1, { status: "completed", exit_code: 0, output: "landed — the gate is in.", usage: { total_tokens: 20, input_tokens: 12, output_tokens: 8 } });
    const done1 = await waitFor(async () => (await latestByThread()).get(THREADS[0])?.status === "done", { timeoutMs: 30_000, stepMs: 200, what: "#1's run to settle done" });
    ok("the run's own terminal event settles #1's card", done1);
    await assertChip("step 2", THREADS[0], "COMPLETE", { settled: true });
    await assertChip("step 2", THREADS[1], "RUNNING");
    const closed = await waitFor(
      async () => {
        const t = (await queueOf()).tasks.find((x) => x.id === 1);
        return t && t.state === "done" ? t : false;
      },
      { timeoutMs: 20_000, stepMs: 250, what: "the panel's sweep to mark task #1 done" },
    );
    ok("the panel's eager-completion sweep marks #1 done, with nobody pressing Done", Boolean(closed), closed ? JSON.stringify({ state: closed.state, doneBy: closed.doneBy }) : "still open after 20s");
    check("…recording that the PANEL did it", closed?.doneBy, "panel");
    ok("…and why, in its own words", /settled done with no tree to land|PR reads/.test(closed?.reason || ""), closed?.reason);
    await assertEveryCardAgrees("step 2");

    // ---- step 3: #2's run fails → EXITED, and the panel puts the task back in the queue ----------------------------
    console.log("\n== step 3: #2's run fails → EXITED, and the task goes back to queued with attempts+1 ==");
    const run2 = latest.get(THREADS[1])?.runId;
    stub.set(run2, { status: "failed", exit_code: 1, output: "the suite went red in lib/assistant.js." });
    const failed2 = await waitFor(async () => (await latestByThread()).get(THREADS[1])?.status === "failed", { timeoutMs: 30_000, stepMs: 200, what: "#2's run to settle failed" });
    ok("the run's terminal event settles #2's card as failed", failed2);
    await assertChip("step 3", THREADS[1], "EXITED", { settled: true });
    await assertChip("step 3", THREADS[0], "COMPLETE");
    const requeued = await waitFor(
      async () => {
        const t = (await queueOf()).tasks.find((x) => x.id === 2);
        return t && t.state === "queued" ? t : false;
      },
      { timeoutMs: 20_000, stepMs: 250, what: "the sweep to put task #2 back in the queue" },
    );
    ok("the sweep puts #2 back in the queue", Boolean(requeued), requeued ? JSON.stringify({ state: requeued.state, attempts: requeued.attempts }) : "still running after 20s");
    check("…with attempts+1", requeued?.attempts, 1);
    ok("…and the reason naming the failed run", /ended failed/.test(requeued?.reason || ""), requeued?.reason);
    await assertEveryCardAgrees("step 3");

    // ---- step 4: #3's run is cancelled → NOT-RUNNING, while the task itself is parked by the reader ---------------
    console.log("\n== step 4: #3's run is cancelled → NOT-RUNNING, and the task stays parked ==");
    const start3 = await POST("/api/assistant/queue", { assistantId: "assistant-1", action: "state", id: 3, state: "running" });
    ok("task #3 is marked running", start3.body.task?.state, "running");
    const reply3 = await POST("/api/agents/reply", { thread: THREADS[2], text: "run the SQL verify for the moved tasks" });
    ok("…and a run starts on its thread", reply3.status, 202);
    const live3 = await waitFor(async () => LIVE_STATUS.has(String((await latestByThread()).get(THREADS[2])?.status || "")), { timeoutMs: 30_000, stepMs: 200, what: "#3's run to go live" });
    ok("#3's thread is live", live3);
    await assertChip("step 4", THREADS[2], "RUNNING");
    const park = await POST("/api/assistant/queue", { assistantId: "assistant-1", action: "state", id: 3, state: "parked", reason: "the run was cancelled — waiting on the DBA's verify" });
    ok("the reader parks #3 with the reason", park.body.task?.state === "parked" && /DBA's verify/.test(park.body.task?.reason || ""), JSON.stringify({ state: park.body.task?.state, reason: park.body.task?.reason }));
    const run3 = (await latestByThread()).get(THREADS[2])?.runId;
    stub.set(run3, { status: "cancelled", exit_code: null, output: "" });
    const cancelled3 = await waitFor(async () => (await latestByThread()).get(THREADS[2])?.status === "cancelled", { timeoutMs: 30_000, stepMs: 200, what: "#3's run to settle cancelled" });
    ok("…then its run ends cancelled", cancelled3);
    await assertChip("step 4", THREADS[2], "NOT-RUNNING", { settled: true });
    const stillParked = (await queueOf()).tasks.find((t) => t.id === 3);
    ok("…and the parked task is untouched by the sweep", [stillParked?.state, stillParked?.reason], ["parked", "the run was cancelled — waiting on the DBA's verify"]);
    await assertEveryCardAgrees("step 4");

    // ---- step 5: #4 is started and left live, so all four words are on the page at once -------------------------
    console.log("\n== step 5: #4 left running — all four chips on the page together ==");
    const start4 = await POST("/api/assistant/queue", { assistantId: "assistant-1", action: "state", id: 4, state: "running" });
    ok("task #4 is marked running", start4.body.task?.state, "running");
    const reply4 = await POST("/api/agents/reply", { thread: THREADS[3], text: "record the e2e run in the landing doc" });
    ok("…and a run starts on its thread", reply4.status, 202);
    const live4 = await waitFor(async () => LIVE_STATUS.has(String((await latestByThread()).get(THREADS[3])?.status || "")), { timeoutMs: 30_000, stepMs: 200, what: "#4's run to go live" });
    ok("#4's thread is live", live4);
    latest = await latestByThread();
    note(`/api/jobs → ${THREADS.map((t) => `${t}: ${latest.get(t)?.status}`).join(" · ")}`);
    check("…which the API turns into the four words, once each", THREADS.map((t) => chipForStatus(latest.get(t)?.status)), ["COMPLETE", "EXITED", "NOT-RUNNING", "RUNNING"]);
    await assertChip("step 5", THREADS[0], "COMPLETE");
    await assertChip("step 5", THREADS[1], "EXITED");
    await assertChip("step 5", THREADS[2], "NOT-RUNNING", { settled: true });
    await assertChip("step 5", THREADS[3], "RUNNING", { settled: true });
    await assertEveryCardAgrees("step 5");

    // ---- 3. two moved to Assistant #2 through the pane's Move control ------------------------------------------
    console.log("\n== the Move control: parked #3 and live #4 go to Assistant #2 ==");
    await page.locator("#btn-assistant").click();
    await page.waitForSelector("#assistant", { state: "visible" });
    await page.waitForSelector('#as-tabs [data-as-tab="assistant-1"]');
    await page.click('#as-tabs [data-as-tab="assistant-1"]');
    if (!(await page.locator("#as-queue").isVisible())) await page.click('#as-subtabs [data-as-subtab="queue"]');
    await page.waitForSelector("#as-queue:not(.hidden)");
    const paneReady = await waitFor(() => page.locator("#as-queue .as-task").count().then((n) => n === 4), {
      timeoutMs: 20_000,
      stepMs: 200,
      what: "Assistant #1's pane to paint its four rows",
    });
    ok("Assistant #1's Queue pane lists the four tasks", paneReady, `${await page.locator("#as-queue .as-task").count()} row(s)`);
    // #2 was put back in the queue by the failed run, #3 was parked by the reader, #4 is live and #1 is done — the pane
    // orders running, queued, parked, done.
    check("…by id, in state order", await page.$$eval("#as-queue .as-task", (els) => els.map((el) => el.dataset.asQrow)), ["4", "2", "3", "1"]);
    check("…each offering the Move control (a second assistant exists)", await page.$$eval("#as-queue .as-task", (els) => els.map((el) => Boolean(el.querySelector("[data-as-qmove-open]")))), [true, true, true, true]);
    // One sub-row per agent, with the card's own pill word read from /api/jobs — never from the task record. These four
    // tasks were started on real threads above, so the words here are the same four the cards wear.
    check(
      "…and one sub-row per agent wearing the card's own word",
      await page.$$eval("#as-queue .as-task", (els) => els.map((el) => [...el.querySelectorAll(".as-task-agent")].map((a) => `${a.dataset.asQopen}|${(a.querySelector(".pill")?.textContent || "").trim()}`))),
      [
        [`${THREADS[3]}|running`],
        [`${THREADS[1]}|exited`],
        [`${THREADS[2]}|not-running`],
        [`${THREADS[0]}|complete`],
      ],
    );

    const movedAt = [];
    for (const [id, title] of [[3, TASKS[2].title], [4, TASKS[3].title]]) {
      const before = await page.locator("#as-queue .as-task").count();
      // ➡️ opens the picker; the NAME in it is the choice — the always-visible <select> and its Move button are gone.
      await page.click(`[data-as-qmove-open="assistant-1:${id}"]`);
      await page.click(`[data-as-qmove-pop="assistant-1:${id}"] [data-as-qmove-to="assistant-2"]`);
      const gone = await waitFor(() => page.locator("#as-queue .as-task").count().then((n) => n === before - 1), {
        timeoutMs: 15_000,
        stepMs: 200,
        what: `row #${id} to leave Assistant #1's pane`,
      });
      ok(`pressing Move on #${id} takes its row out of Assistant #1's list`, gone, `${await page.locator("#as-queue .as-task").count()} row(s) left`);
      ok(`…and #${id} is really gone from the DOM`, (await page.locator(`[data-as-qrow="${id}"]`).count()) === 0, title);
      movedAt.push(id);
    }
    check("both rows left the pane, one press each", movedAt, [3, 4]);
    check("…leaving Assistant #1's two finished-or-queued tasks", await page.$$eval("#as-queue .as-task", (els) => els.map((el) => el.dataset.asQrow)), ["2", "1"]);

    // The routes, and then the FILES: a route that answers right while the two documents disagree is the defect.
    const afterMove = await queueOf();
    const twoQueue = await queueOf("assistant-2");
    check("Assistant #1's queue no longer holds #3 or #4", afterMove.tasks.map((t) => t.id), [1, 2]);
    // #2 is the task the failed run put back in the queue, #1 is done: nothing is parked and nothing runs in #1 now.
    check(
      "…its counts follow",
      [afterMove.counts.total, afterMove.counts.queued, afterMove.counts.parked, afterMove.counts.running, afterMove.counts.done],
      [2, 1, 0, 0, 1],
    );
    check("Assistant #2's queue holds exactly the two moved tasks", twoQueue.tasks.map((t) => [t.id, t.title]), [[1, TASKS[2].title], [2, TASKS[3].title]]);
    check("…under ids its own counter had never used (3 and 4 stayed behind)", twoQueue.tasks.map((t) => t.id), [1, 2]);
    check("…owned by Assistant #2", twoQueue.tasks.map((t) => t.owner), ["assistant-2", "assistant-2"]);
    check("…with the states they were moved in", twoQueue.tasks.map((t) => t.state), ["parked", "running"]);
    check("…their threads and files intact", twoQueue.tasks.map((t) => [t.thread, t.files]), [[THREADS[2], ["docs/sql-verify/move.sql"]], [THREADS[3], ["docs/landing-assistant-queue-e2e-2026-11-02.md"]]]);
    check(
      "…and movedFrom naming assistant-1 → assistant-2, by the reader",
      twoQueue.tasks.map((t) => (t.movedFrom || []).map((m) => [m.from, m.to, m.by])),
      [
        [["assistant-1", "assistant-2", "reader"]],
        [["assistant-1", "assistant-2", "reader"]],
      ],
    );
    ok("…each record stamped with when", twoQueue.tasks.every((t) => (t.movedFrom || []).every((m) => !Number.isNaN(Date.parse(m.at || "")))), JSON.stringify(twoQueue.tasks.map((t) => t.movedFrom?.[0]?.at)));
    const oneFileDoc = JSON.parse(readFileSync(afterMove.file, "utf8"));
    const twoFileDoc = JSON.parse(readFileSync(twoQueue.file, "utf8"));
    check("the SOURCE file on disk no longer has them", oneFileDoc.tasks.map((t) => t.id), [1, 2]);
    check("the TARGET file on disk has them, movedFrom included", twoFileDoc.tasks.map((t) => [t.id, t.movedFrom?.[0]?.from, t.movedFrom?.[0]?.to]), [[1, "assistant-1", "assistant-2"], [2, "assistant-1", "assistant-2"]]);
    check("…and the target's nextId moved past them", twoFileDoc.nextId, 3);

    const digest1 = afterMove.digest || [];
    const digest2 = twoQueue.digest || [];
    ok("Assistant #1's digest no longer names the moved work", !digest1.some((l) => l.includes(TASKS[2].title) || l.includes(TASKS[3].title)), digest1.join(" | "));
    ok("Assistant #2's digest does, with its new ids", digest2.some((l) => /^- ⏸ #1 parked · SQL verify for the moved tasks/.test(l)) && digest2.some((l) => /^- ● #2 running · record the e2e run/.test(l)), digest2.join(" | "));
    check("…and its header counts them", digest2[0], "Your task queue (0 queued · 1 running · 1 parked · 0 done):");

    // Assistant #2's pane, painted from its own file: the two rows, in state order. The pane ids are per session
    // (`paneIdFor`: `as-queue` is Assistant #1's, `as-queue-2` is #2's), so reading `#as-queue` here would have counted
    // Assistant #1's two remaining rows and called them the moved ones.
    const PANE2 = "#as-queue-2";
    await page.click('#as-tabs [data-as-tab="assistant-2"]');
    await page.waitForSelector(`${PANE2}:not(.hidden)`);
    const twoRows = await waitFor(() => page.locator(`${PANE2} .as-task`).count().then((n) => n === 2), {
      timeoutMs: 20_000,
      stepMs: 200,
      what: "Assistant #2's pane to paint the two moved rows",
    });
    ok("Assistant #2's Queue pane paints the two tasks it was handed", twoRows, `${await page.locator(`${PANE2} .as-task`).count()} row(s)`);
    check("…and it is #2's own pane that is on screen", [await page.locator(PANE2).isVisible(), await page.locator("#as-queue").isVisible()], [true, false]);
    const rowsTwo = await page.$$eval(`${PANE2} .as-task`, (els) =>
      els.map((el) => ({
        id: el.dataset.asQrow,
        mark: el.querySelector(".as-task-mark")?.textContent.trim() || "",
        title: el.querySelector(".as-task-title")?.textContent.trim() || "",
        owner: el.querySelector(".as-task-owner")?.textContent.trim() || "",
        note: (el.querySelector(".as-task-note")?.textContent || "").replace(/\s+/g, " ").trim(),
      })),
    );
    check("…running first, then parked, each with its own marker", rowsTwo.map((r) => [r.id, r.mark]), [["2", "●"], ["1", "⏸"]]);
    check("…their titles, unchanged by the move", rowsTwo.map((r) => r.title), [TASKS[3].title, TASKS[2].title]);
    check("…owned by Assistant #2", rowsTwo.map((r) => r.owner), ["assistant-2", "assistant-2"]);
    ok("…the parked one carrying the reason it was parked for", /^parked — the run was cancelled/.test(rowsTwo[1]?.note || ""), rowsTwo[1]?.note);
    ok("…and the running one's thread still live, not STALE", !/STALE/.test(rowsTwo[0]?.note || ""), rowsTwo[0]?.note || "(no note)");

    // The cards are still the job store's, after two tasks changed owner and two panes were driven.
    await assertChip("after the moves", THREADS[2], "NOT-RUNNING");
    await assertChip("after the moves", THREADS[3], "RUNNING");
    await assertEveryCardAgrees("after the moves");
    check("no page error was thrown while the panes and cards were driven", pageErrors, []);

    await page.screenshot({ path: path.join(dir, "queue-e2e.png") }).catch(() => {});
  }

  // ---- 1. the reader's panel was never touched --------------------------------------------------------------------
  console.log("\n== the live board and the reader's state are untouched ==");
  check("the live board's 7331 listener count is unchanged by this run", listenersOn(7331), liveBefore);
  ok("no state the panel served lives outside the sandbox", [q1.file, four.file, (await queueOf("assistant-2")).file].every((f) => lower(f).startsWith(lower(dir))), slash(dir));

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed`);
  console.log("\nWHAT WAS DRIVEN: a panel of its own on its own port and state directory, over a stub Runs API and a seeded");
  console.log("job store of four real threads; four tasks added together; three replies that started real runs; the stub's");
  console.log("terminal events settling them completed / failed / cancelled; the panel's own sweep closing one task and");
  console.log("re-queueing another; four chips read from the DOM at every step against /api/jobs (RUNNING, COMPLETE, EXITED,");
  console.log("NOT-RUNNING); and two tasks moved to Assistant #2 through the pane's Move control, asserted in the routes, in");
  console.log("both queue files on disk and in Assistant #2's painted pane, with movedFrom recorded.");
  if (!failures) console.log("ASSISTANT-QUEUE-E2E-OK");
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
  if (panel) {
    if (process.env.VERIFY_KEEP === "1") console.log(`VERIFY_KEEP=1 — leaving ${panel.dir} in place`);
    else await panel.stop();
  }
  try {
    await stub.close();
  } catch {
    /* already closed */
  }
  if (process.env.VERIFY_KEEP !== "1") {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* Windows can hold a file for a moment; the verdict does not depend on the cleanup */
    }
  }
  clearTimeout(watchdog);
}
process.exitCode = failures ? 1 : 0;
