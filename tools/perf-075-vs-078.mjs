// Is 0.78.1 actually slower than 0.75.0 on the SAME board? One probe, two real panels, nine numbers.
//
//   node tools/perf-075-vs-078.mjs
//   node tools/perf-075-vs-078.mjs --old <an extracted 0.75.0 tree> --keep
//
// WHY THIS EXISTS. "0.78 feels heavier" is a claim about a board, and a board is a store, a scan, a page and a
// process. Measuring one of those and calling it "the panel" is how a regression gets attributed to the wrong
// layer. So this probe builds ONE synthetic board — 200 rows across 6 projects with mixed verdicts, one live job,
// one open approval, one parked queue row and one 500-line turn — and gives it to two panels that differ only in
// their code: 0.75.0 (exported with `git archive 35b3c82`, never checked out over a worktree) and 0.78.1 (this
// checkout, cut from main fd36130). Each runs on its own free port with its own `PANEL_CONFIG`, its own `dataDir`
// and its own store; the reader's :7331 board is never touched and its logs are never read.
//
// WHAT IS MEASURED, and why each one is a number a reader can act on:
//
//   /api/state, 20 calls   the snapshot's own latency: median and max, plus the JSON body's bytes. This is the
//                          route the page's resync calls, and its body is the "JSON per refresh" the brief names.
//   first paint            navigation -> the frame that shows all 200 rows, measured on a COLD boot (the first
//                          page after the panel answers, so the initial scan is inside the number). Two warm
//                          reloads follow it, so "noise" is a measurement rather than an opinion.
//   DOM nodes              every element after the board has loaded, all six projects expanded.
//   live intervals         setInterval handles the page still holds (plus pending setTimeouts, kept separately):
//                          a board that leaks timers is slower at every later paint, not just this one.
//   JSON bytes / refresh   the /api/state body: what the page parses on every resync.
//   SSE bytes / 60 s       bytes the page's own EventSource received in one window, counted in the page (frame
//                          payload + header, per event type). This is the refresh channel; /api/state is the resync.
//   console render         the page's own render of a 500-line turn (toggleJob -> renderConversation), 5 repeats,
//                          median. The console windows to TURN_WINDOW=300, so 300 of the 500 lines are drawn.
//   RSS after 2 min idle   the panel process's OS working set with the page still attached and nothing scanning
//                          (every scan clock is pinned to 3600 s), read with Get-Process's WorkingSet64.
//
// WHAT IS DRIVEN, AND WHAT IS ONLY INSPECTED
//
//   driven   both panels are the real `server.js` of their own tree, booted by tools/panel-testkit.mjs on ports
//            the OS said were free; the browser is a real Chromium through tools/browser.mjs; every store read is
//            an HTTP answer from the running panel. The fixture is real git: branches, commits, merges, worktrees.
//   inspected  the two package.json versions, so the report cannot name the wrong trees.
//
// A NOTE ON SEQUENTIAL RUNS. The two panels are measured one after the other, not side by side. Both scan the same
// fixture repositories, and two panels running `git status` in the same 200 trees at once contend on git's own
// index locks — that contention would be a property of the harness, not of the builds. Same fixture, same seed,
// same config, own store: that is the A/B this brief asks for.
//
// The output is a table plus a JSON file (`--out`, default `<scratch>/perf-075-vs-078.json`). Without Playwright
// this prints BROWSER-HALF-NOT-RUN and exits 2 rather than reporting a browser half that never ran.
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, git, startPanel, waitForState } from "./panel-testkit.mjs";
import { loadPlaywright, withBrowser } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, ".."); // the 0.78.1 side: this checkout, cut from main fd36130
const OLD_COMMIT = "35b3c82"; // 0.75.0
const OLD_VERSION = "0.75.0";
const NEW_VERSION = "0.78.1";

const args = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);
const SCRATCH = process.env.WAG_SCRATCH || path.join(tmpdir(), "wag", "perf-075-vs-078");
const OUT = path.resolve(argOf("out", path.join(SCRATCH, "perf-075-vs-078.json")));
const KEEP = flag("keep");
// Which side is measured first. The default is the chronological one (old, then new); `--reverse` measures the new
// build first, so a second run can cancel the machine's own drift (a panel that runs second inherits whatever the
// first one warmed up: file cache, node's JIT, the OS's working set). One run in each order is the A/B.
const REVERSE = flag("reverse");
const STATE_CALLS = Number(argOf("state-calls", "20"));
const IDLE_SECONDS = Number(argOf("idle-seconds", "120"));
const PAINT_ROUNDS = 3;
const CONSOLE_ROUNDS = 5;

// The fixture: 200 rows over 6 projects, one project's primary checkout is one of its rows.
const PROJECT_COUNT = 6;
const TOTAL_ROWS = 200;
const ROW_SPLIT = [34, 33, 33, 33, 33, 34]; // sums to 200
// A row's verdict is decided by its branch's history, so the kinds are real git shapes:
//   merged     a commit main has (ff-merged):      MERGED (1 commit)
//   unmerged   a commit main does not have:        UNMERGED (1 commit)
//   nocommits  a branch with no commit of its own: NO COMMITS
const KINDS = ["merged", "unmerged", "nocommits"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const pct = (oldV, newV) => (oldV ? ((newV - oldV) / oldV) * 100 : null);

// ---- the fixture ------------------------------------------------------------------------------------------------
// One set of repositories, scanned by both panels. Nothing in them changes after the build, so "identical data" is
// a fact about the filesystem rather than a promise about two seeds.
function buildFixture(root) {
  mkdirSync(root, { recursive: true });
  const projects = [];
  let made = 0;
  for (let p = 1; p <= PROJECT_COUNT; p += 1) {
    const name = `perf-project-${p}`;
    const repo = path.join(root, name);
    const origin = path.join(root, `${name}-origin.git`);
    const trees = path.join(repo, ".worktrees");
    mkdirSync(repo, { recursive: true });
    mkdirSync(trees, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    for (const f of ["README.md", "app.txt", "notes.txt"]) writeFileSync(path.join(repo, f), `# ${name} ${f}\n`, "utf8");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", `${name}: base`);

    const worktrees = ROW_SPLIT[p - 1] - 1; // the primary checkout is a row too
    for (let i = 1; i <= worktrees; i += 1) {
      const kind = KINDS[(i + p) % KINDS.length];
      const branch = `wtgui/${kind}-${i}`;
      const tree = path.join(trees, `${kind}-${i}`);
      git(repo, "worktree", "add", "-q", "-b", branch, tree);
      if (kind !== "nocommits") {
        writeFileSync(path.join(tree, `work-${i}.txt`), `${kind} work ${i}\n`, "utf8");
        git(tree, "add", "-A");
        git(tree, "commit", "-q", "-m", `${name}: ${kind} work ${i}`);
      }
      if (kind === "merged") git(repo, "merge", "-q", "--ff-only", branch);
      made += 1;
      if (made % 25 === 0) log(`      fixture: ${made} worktrees…`);
    }
    git(root, "init", "--bare", "-q", origin);
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "main");
    projects.push({ name, path: repo });
    log(`      fixture: ${name} — ${ROW_SPLIT[p - 1]} rows (1 primary + ${worktrees} worktrees)`);
  }
  return projects;
}

// ---- the stub Runs API: it holds ONE run open, so the seeded card is genuinely live ------------------------------
// The panel asks /v1/capabilities at boot, then (because the store carries a running card) /v1/runs/<id> to decide
// whether to re-attach. "running" is that decision; the events stream stays open and sends a comment so the panel's
// own SSE reader is attached exactly as it would be to a real run.
function makeStub(runId) {
  const json = (code, body, res) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const sockets = new Set();
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/v1/capabilities") {
      return json(200, { version: "perf-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_cwd: true } }, res);
    }
    if (url.pathname === `/v1/runs/${runId}` && req.method === "GET") {
      return json(200, { run_id: runId, status: "running", started_at: new Date(Date.now() - 90_000).toISOString() }, res);
    }
    if (url.pathname === `/v1/runs/${runId}/events`) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": attached\n\n");
      const timer = setInterval(() => {
        try {
          res.write(": hold\n\n");
        } catch {
          clearInterval(timer);
        }
      }, 2000);
      timer.unref?.();
      sockets.add(res);
      req.on("close", () => {
        clearInterval(timer);
        sockets.delete(res);
      });
      return undefined;
    }
    if (url.pathname === `/v1/runs/${runId}/stop` && req.method === "POST") return json(200, { ok: true }, res);
    return json(404, { error: { message: "not found", code: "not_found" } }, res);
  });
  return {
    server,
    url: null,
    async close() {
      for (const s of sockets) s.destroy();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

// ---- the store both panels are handed ---------------------------------------------------------------------------
// A running card with a run the stub still holds (so boot re-attaches it and it is LIVE), an open approval on that
// same card (the realistic shape: the run is parked on a person), and a finished 500-line turn whose console is the
// one the render metric collapses and expands.
const LIVE_THREAD = "wtgui-perf-live";
const BIG_THREAD = "wtgui-perf-500";
const BIG_LINES = 500;
const TURN_WINDOW = 300; // public/app.js TURN_WINDOW, the same number in both builds

function bigTurnLines(now) {
  return Array.from({ length: BIG_LINES }, (_, i) => ({
    kind: "text",
    lid: i + 1,
    at: now - 60_000 + i * 40,
    text:
      i % 7 === 0
        ? `**step ${i + 1}** — the console parses \`inline code\` and a [link](https://example.test/).`
        : `line ${i + 1}: the agent said something ordinary about the turn it was working on.`,
  }));
}

function seedJobs(dir, { runId, treePath, branch }) {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const small = [
    ["text", "**perf probe** — a live turn, seeded before boot."],
    ["tool", "🔧 terminal · git status --porcelain"],
    ["tool-out", "  ↳ terminal · 0.31s"],
    ["tool-out", "  clean"],
    ["text", "The board is measuring the panel's own read path."],
    ["dim", "⇢ waiting on a person"],
    ["text", "One open approval sits under this console."],
    ["tool", "🔧 terminal · curl -s /api/state"],
    ["tool-out", "  ↳ terminal · 0.12s"],
    ["text", "Still running; the stub gateway holds the run."],
  ];
  const live = {
    id: "j-perf-live",
    thread: LIVE_THREAD,
    turn: 1,
    prompt: "the live turn the perf probe seeds",
    displayPrompt: "the live turn the perf probe seeds",
    cwd: treePath,
    ownerPath: treePath,
    projectPath: path.dirname(path.dirname(treePath)),
    worktree: true,
    worktreePath: treePath,
    branch,
    sessionId: LIVE_THREAD,
    status: "running",
    exitCode: null,
    runId,
    model: "perf/stub",
    startedAt: iso(now - 90_000),
    endedAt: null,
    approval: {
      requestId: "perf-approval-1",
      command: "git push origin HEAD",
      choices: ["once", "deny"],
      timeoutSeconds: 3600,
      at: iso(now - 30_000),
      deadline: now + 3_600_000,
    },
    lines: small.map(([kind, text], i) => ({ kind, lid: i + 1, at: now - 90_000 + i * 500, text })),
    artifacts: [],
    attachments: [],
    subagents: [],
  };
  const bigLines = bigTurnLines(now);
  const big = {
    id: "j-perf-500",
    thread: BIG_THREAD,
    turn: 1,
    prompt: "the 500-line turn the console render metric drives",
    displayPrompt: "the 500-line turn the console render metric drives",
    cwd: treePath,
    ownerPath: null,
    projectPath: path.dirname(path.dirname(treePath)),
    worktree: false,
    worktreePath: null,
    branch: null,
    sessionId: BIG_THREAD,
    status: "done",
    exitCode: 0,
    runId: "run-perf-500",
    model: "perf/stub",
    startedAt: iso(now - 60_000),
    endedAt: iso(now - 20_000),
    finalMessage: bigLines[bigLines.length - 1].text,
    lines: bigLines,
    artifacts: [],
    attachments: [],
    subagents: [],
  };
  const jobsPath = path.join(dir, "data", "jobs.json");
  mkdirSync(path.dirname(jobsPath), { recursive: true });
  writeFileSync(jobsPath, JSON.stringify({ version: 1, savedAt: iso(now), jobs: [live, big] }), "utf8");
  return { jobsPath, bigLines };
}

// ---- page-side timer ledger --------------------------------------------------------------------------------------
// Wrapping the four timer calls BEFORE app.js parses is the only way to see the intervals a page still holds. The
// wrapper keeps the browser's own handles and bookkeeping — it only mirrors them into a set (and removes one when
// its timeout has fired, so a finished one-shot is not reported as live).
function timerLedger() {
  const live = { intervals: new Set(), timeouts: new Set() };
  const si = window.setInterval;
  const ci = window.clearInterval;
  const st = window.setTimeout;
  const ct = window.clearTimeout;
  window.setInterval = function (fn, ms, ...rest) {
    const id = si.call(window, fn, ms, ...rest);
    live.intervals.add(id);
    return id;
  };
  window.clearInterval = function (id) {
    live.intervals.delete(id);
    return ci.call(window, id);
  };
  window.setTimeout = function (fn, ms, ...rest) {
    if (typeof fn !== "function") return st.call(window, fn, ms, ...rest);
    let id;
    const wrapped = function (...a) {
      live.timeouts.delete(id);
      return fn.apply(this, a);
    };
    id = st.call(window, wrapped, ms, ...rest);
    live.timeouts.add(id);
    return id;
  };
  window.clearTimeout = function (id) {
    live.timeouts.delete(id);
    return ct.call(window, id);
  };
  window.__wtTimerLedger = live;
}

// ---- one side of the A/B -----------------------------------------------------------------------------------------
async function measureSide({ label, version, root, projects, stub }) {
  const dir = mkdtempSync(path.join(tmpdir(), `wtgui-perf-${label}-`));
  mkdirSync(path.join(dir, "data"), { recursive: true });
  mkdirSync(path.join(dir, "empty-scan-root"), { recursive: true });
  const port = await freePort();
  if (port === 7331) throw new Error("the OS offered :7331 — refusing to touch the reader's board");
  const treePath = path.join(projects[0].path, ".worktrees", "merged-1");
  const branch = "wtgui/merged-1";
  const seed = seedJobs(dir, { runId: "run-perf-live", treePath, branch });

  const config = {
    port,
    host: "127.0.0.1",
    // The store and the data are OURS: PANEL_CONFIG names this file, dataDir/scratchDir sit under it, and every
    // state file the panel writes is derived from them.
    dataDir: path.join(dir, "data"),
    scratchDir: path.join(dir, "scratch"),
    jobsFile: path.join(dir, "data", "jobs.json"),
    assistantFile: path.join(dir, "data", "assistant.json"),
    projectsCacheFile: path.join(dir, "data", "projects.json"),
    scanRoots: [path.join(dir, "empty-scan-root")],
    projects: projects.map((p) => ({
      name: p.name,
      path: p.path,
      remote: "origin",
      mainBranch: "main",
      prRepo: null,
      remoteBranchPolicy: "local-only",
      worktrees: null,
    })),
    threads: 5,
    scanMode: "all",
    // Nothing scans while the probe is idle: the RSS row is "after two minutes idle", so idle has to be real.
    worktreeSeconds: 3600,
    midSeconds: 3600,
    dormantSeconds: 3600,
    slowSeconds: 3600,
    fetchSeconds: 3600,
    refreshSeconds: 30,
    prCacheSeconds: 3600,
    remoteCacheSeconds: 3600,
    collapseAfterSeconds: 3600,
    liveSeconds: 5,
    hideOlderThanDays: 7,
    defaultCwd: projects[0].path,
    remoteBranchPolicy: "local-only",
    agentCleanup: false,
    apiServer: { url: stub.url, key: "perf-stub" },
    assistant: { enabled: false, seconds: 3600, maxWakesPerHour: 0 },
  };

  log(`\n== ${version} (${label}) — ${root} on :${port}`);
  const panel = await startPanel({ dir, root, port, config, keep: true });
  const base = panel.base;
  const side = { label, version, root, port, dir, rows: null, verdicts: null, state: null, paint: null, dom: null, timers: null, sse: null, console: null, rss: null, queue: null };

  try {
    // ---- one parked queue row (the panel's own route writes it, so both sides carry the same record) ----------
    // Done before the page opens: the snapshot the page paints therefore already counts it, exactly as if the
    // reader had parked it a minute earlier.
    const q = await postJson(base, "/api/assistant/queue", { action: "add", title: "perf probe: a parked row", files: [] });
    const id = q.body?.task?.id ?? q.body?.queue?.tasks?.slice?.(-1)?.id ?? q.body?.queue?.tasks?.[0]?.id;
    const parked = await postJson(base, "/api/assistant/queue", { action: "state", id, state: "parked", hold: { kind: "manual", value: "" } });
    // The POST answer already carries the queue it just wrote; the GET list form answers `{ queues: [...] }`, so
    // reading `body.queue` from a list read is the shape mistake that made the first smoke run report zero.
    const parkedRows = (parked.body?.queue?.tasks || []).filter((t) => t.state === "parked");
    const qread = parkedRows.length ? null : await getJson(base, "/api/assistant/queue");
    const allTasks = parkedRows.length ? parked.body.queue.tasks : (qread.body?.queues || []).flatMap((x) => x.tasks || []);
    side.queue = { add: q.status, park: parked.status, parked: allTasks.filter((t) => t.state === "parked").length, title: parkedRows[0]?.title || allTasks.find((t) => t.state === "parked")?.title || null, id };
    if (!side.queue.parked) throw new Error(`the parked queue row did not read back (add ${q.status}, park ${parked.status}, id ${id})`);
    log(`   queue: 1 parked row (#${side.queue.id}) of ${allTasks.length}`);

    // ---- the browser half: cold paint, DOM, timers, /api/state, console, stream, idle, RSS ---------------------
    const verdict = await withBrowser(
      async ({ page }) => {
        // The reader has expanded all six projects; the page remembers that in localStorage, so the board paints
        // every row on the FIRST frame instead of waiting for a click.
        await page.addInitScript((names) => {
          try {
            localStorage.setItem("wm.expandedProjects", JSON.stringify(names));
          } catch {
            /* no storage: the probe would then measure a folded board */
          }
        }, projects.map((p) => p.name));

        // cold paint: navigate as soon as the panel answers, wait for the frame that holds all 200 rows.
        const paints = [];
        for (let round = 0; round < PAINT_ROUNDS; round += 1) {
          const t0 = Date.now();
          await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
          if (round === 0) await page.waitForSelector("#projects", { timeout: 30_000 });
          await page.waitForFunction((n) => document.querySelectorAll("#projects tr.row").length >= n, TOTAL_ROWS, { timeout: 300_000, polling: 100 });
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
          paints.push(Date.now() - t0);
        }
        const dom = await page.evaluate((liveThread) => ({
          nodes: document.getElementsByTagName("*").length,
          rows: document.querySelectorAll("#projects tr.row").length,
          cards: document.querySelectorAll(".job[data-thread]").length,
          intervals: window.__wtTimerLedger ? window.__wtTimerLedger.intervals.size : null,
          timeouts: window.__wtTimerLedger ? window.__wtTimerLedger.timeouts.size : null,
          liveCard: Boolean(document.querySelector(`.job[data-thread="${liveThread}"] .pill-running, .job[data-thread="${liveThread}"] [data-live-from]`)),
          approval: Boolean(document.querySelector(`.job[data-thread="${liveThread}"]`)),
        }), LIVE_THREAD);
        log(`   paint (cold + ${PAINT_ROUNDS - 1} warm): ${paints.map((p) => `${p} ms`).join(" · ")}`);

        // ---- /api/state over 20 calls, with the reader's tab open -------------------------------------------------
        const calls = [];
        let bytes = 0;
        for (let i = 0; i < STATE_CALLS; i += 1) {
          const t = nowMs();
          const r = await fetch(`${base}/api/state`);
          const text = await r.text();
          calls.push(nowMs() - t);
          bytes = Buffer.byteLength(text, "utf8");
          await sleep(100);
        }
        const stateStats = { median: median(calls), max: Math.max(...calls), min: Math.min(...calls), bytes, calls };
        log(`   /api/state: median ${stateStats.median.toFixed(1)} ms · max ${stateStats.max.toFixed(1)} ms · ${bytes} bytes`);

        // The snapshot the page loaded carries only the last 60 lines of any turn (lib/jobs.js TAIL), so a 500-line
        // turn cannot arrive through the store at all. The console's buffer is `state.jobLines`, so the 500 lines are
        // put THERE — the same array on both sides — and the render is the page's own path from that buffer. This is
        // the console's real cost for a 500-line turn; the 60-line cap is a separate fact about the snapshot.
        const injected = await page.evaluate(([id, lines]) => {
          if (!state || !state.jobLines) return { ok: false, n: 0 };
          state.jobLines.set(id, lines);
          return { ok: true, n: state.jobLines.get(id).length };
        }, ["j-perf-500", seed.bigLines]);
        if (!injected.ok) throw new Error("the console's jobLines buffer was not reachable");

        // the console render: the page's own minimize/expand path (toggleJob -> renderConversation), 5 repeats.
        // Collapsing does NOT throw the console markup away on this build (the body always renders; the sheet hides
        // it), so presence cannot be the signal — node IDENTITY is: a rebuild replaces the pre element. The number
        // runs from the call to the frame after a forced layout, so parse, layout and paint are all inside it.
        // Warm-up: three unmeasured renders first, so the number is the renderer's steady state rather than the
        // one-off cost of compiling its markdown path on the first call. The side-by-side comparison needs the
        // same warm-up on both builds, and the sequence of collapsed states is identical either way.
        for (let i = 0; i < 3; i += 1) {
          await page.evaluate(async (t) => {
            toggleJob(t);
            const after = document.querySelector(`.job[data-thread="${t}"] pre.job-out`);
            if (after) void after.offsetHeight;
            await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
          }, BIG_THREAD);
        }
        const renders = [];
        let rendered = null;
        for (let i = 0; i < CONSOLE_ROUNDS; i += 1) {
          const r = await page.evaluate(async (t) => {
            const sel = `.job[data-thread="${t}"] pre.job-out`;
            const before = document.querySelector(sel);
            const t0 = performance.now();
            toggleJob(t);
            const after = document.querySelector(sel);
            if (after) void after.offsetHeight;
            await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
            return { ms: performance.now() - t0, rebuilt: Boolean(after) && after !== before, lines: after ? after.querySelectorAll(".jl").length : 0, bytes: after ? after.innerHTML.length : 0 };
          }, BIG_THREAD);
          if (!r.rebuilt) throw new Error(`the console was not rebuilt by toggleJob (round ${i})`);
          renders.push(r.ms);
          rendered = r;
        }
        log(`   console 500-line turn: ${renders.map((r) => `${r.toFixed(1)} ms`).join(" · ")} (${rendered?.lines} of ${BIG_LINES} lines rendered)`);

        // one refresh window on the stream, with the board otherwise idle. The count is taken INSIDE the page, on
        // its own EventSource: each frame's payload length plus the frame header it arrived under. CDP's TCP-level
        // dataReceived was tried first and reported 5-6 KB chunks whose boundaries move between runs — that measures
        // the socket, not the refresh. 60 s, because a shorter window measures how many liveness frames happened to
        // tick rather than a rate.
        const sse = await page.evaluate(async (ms) => {
          const es = state.es;
          if (!es) return null;
          const types = ["snapshot", "row", "project", "job", "jobline", "heartbeat", "queue", "approval", "todo", "state", "question"];
          const counts = {};
          const handlers = types.map((t) => [
            t,
            (e) => {
              const bytes = String(e.data || "").length + `event: ${t}\ndata: \n\n`.length;
              const rec = (counts[t] = counts[t] || { frames: 0, bytes: 0 });
              rec.frames += 1;
              rec.bytes += bytes;
            },
          ]);
          for (const [t, fn] of handlers) es.addEventListener(t, fn);
          await new Promise((r) => setTimeout(r, ms));
          for (const [t, fn] of handlers) es.removeEventListener(t, fn);
          const total = Object.values(counts).reduce((n, r) => n + r.bytes, 0);
          const frames = Object.values(counts).reduce((n, r) => n + r.frames, 0);
          return { bytes: total, frames, types: counts };
        }, 60_000);
        log(`   stream: ${sse?.bytes} bytes in ${sse?.frames} frames over 60 s · ${Object.entries(sse?.types || {}).map(([k, v]) => `${k} ${v.frames}`).join(", ")}`);

        // ---- RSS after two minutes idle, page still attached -----------------------------------------------------
        log(`   idle ${IDLE_SECONDS}s, then RSS…`);
        await sleep(IDLE_SECONDS * 1000);
        const rss = rssOf(panel.pid);
        log(`   RSS ${(rss / (1024 * 1024)).toFixed(1)} MB (pid ${panel.pid})`);

        return {
          paint: { cold: paints[0], warm: paints.slice(1), all: paints, median: median(paints) },
          dom: dom.nodes,
          rows: dom.rows,
          cards: dom.cards,
          intervals: dom.intervals,
          timeouts: dom.timeouts,
          liveCard: dom.liveCard,
          state: stateStats,
          console: { median: median(renders), all: renders, rendered: rendered?.lines ?? null, htmlBytes: rendered?.bytes ?? null, window: TURN_WINDOW, source: BIG_LINES },
          sse: { ...(sse || { bytes: null, frames: null, types: null }), windowSeconds: 60 },
          rss,
        };
      },
      { viewport: { width: 1600, height: 1000 }, initScript: timerLedger },
    );

    side.paint = verdict.paint;
    side.dom = verdict.dom;
    side.rowsSeen = verdict.rows;
    side.cards = verdict.cards;
    side.timers = { intervals: verdict.intervals, timeouts: verdict.timeouts };
    side.state = verdict.state;
    side.console = verdict.console;
    side.sse = verdict.sse;
    side.rss = { bytes: verdict.rss, mb: verdict.rss / (1024 * 1024), pid: panel.pid };
    log(`   DOM ${verdict.dom} nodes · ${verdict.rows} rows · timers ${verdict.intervals} intervals / ${verdict.timeouts} pending · stream ${verdict.sse.bytes} bytes / 60 s`);

    // ---- the board the panel built, read after the fact --------------------------------------------------------
    const snapshot = await waitForState(
      base,
      (s) => (s.projects || []).reduce((n, p) => n + (p.worktrees || []).length, 0) >= TOTAL_ROWS,
      `the ${TOTAL_ROWS}-row board`,
      { timeout: 300_000, interval: 500 },
    );
    const rows = (snapshot.projects || []).flatMap((p) => p.worktrees || []);
    const verdicts = {};
    for (const r of rows) {
      const key = String(r.verdict || "(none)").replace(/\s*\(.*$/, "");
      verdicts[key] = (verdicts[key] || 0) + 1;
    }
    side.rows = rows.length;
    side.verdicts = verdicts;
    log(`   board: ${rows.length} rows · verdicts ${JSON.stringify(verdicts)}`);

    // ---- the store's own record of the live card and its approval, read from the API ---------------------------
    const after = await getJson(base, "/api/jobs");
    const live = (after.body?.jobs || []).find((j) => j.thread === LIVE_THREAD);
    side.jobs = { liveStatus: live?.status ?? null, approvalOpen: Boolean(live?.approval), liveCard: Boolean(verdict.liveCard) };
    log(`   live card: status ${side.jobs.liveStatus} · approval ${side.jobs.approvalOpen ? "open" : "closed"}`);

    side.logTail = panel.log().split(/\r?\n/).filter(Boolean).slice(-12);
    return side;
  } finally {
    await panel.stop();
    if (!KEEP) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    else log(`   sandbox kept: ${dir}`);
  }
}

// ---- transport helpers ------------------------------------------------------------------------------------------
async function getJson(base, route) {
  const r = await fetch(`${base}${route}`);
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function postJson(base, route, body) {
  const r = await fetch(`${base}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
function rssOf(pid) {
  // The OS's own resident size for the panel process: /proc on Linux, ps on macOS, WorkingSet64 on Windows.
  if (process.platform === "linux") {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    if (m) return Number(m[1]) * 1024;
  }
  if (process.platform === "darwin") {
    const out = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
    const kb = Number(String(out.stdout || "").trim());
    if (Number.isFinite(kb) && kb > 0) return kb * 1024;
  }
  const out = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: "utf8", windowsHide: true });
  const n = Number(String(out.stdout || "").trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error(`could not read RSS for pid ${pid}: ${out.stderr || out.stdout}`);
  return n;
}

// ---- the old tree, exported rather than checked out --------------------------------------------------------------
function extractOld(requested) {
  if (requested) {
    const dir = path.resolve(requested);
    if (!existsSync(path.join(dir, "server.js"))) throw new Error(`--old ${dir} has no server.js`);
    return dir;
  }
  const dir = path.join(SCRATCH, "old");
  if (existsSync(path.join(dir, "server.js")) && existsSync(path.join(dir, ".git")) && versionOf(dir) === OLD_VERSION) {
    log(`== 0.75.0 export already at ${dir}`);
    return dir;
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  log(`== exporting ${OLD_COMMIT} (0.75.0) with git archive into ${dir}`);
  execFileSync("bash", ["-c", `git -C "${ROOT.replace(/\\/g, "/")}" archive ${OLD_COMMIT} | tar -x -C "${dir.replace(/\\/g, "/")}"`], { stdio: "inherit" });
  // An export has no .git; server.js reads HEAD for its build line, so give the archive its own one-commit repo
  // (the same trick tools/verify-console-render.mjs documents for a PANEL_ROOT export).
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "0.75.0 export");
  return dir;
}

function versionOf(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

// ---- the report --------------------------------------------------------------------------------------------------
function table(oldSide, newSide) {
  const row = (metric, o, n, unit, note) => ({ metric, old: o, new: n, unit, deltaPct: pct(o, n), note });
  return [
    row("/api/state median", oldSide.state.median, newSide.state.median, "ms", `${STATE_CALLS} calls`),
    row("/api/state max", oldSide.state.max, newSide.state.max, "ms", `${STATE_CALLS} calls`),
    row("board first paint (cold)", oldSide.paint.cold, newSide.paint.cold, "ms", `warm ${oldSide.paint.warm.join("/")} vs ${newSide.paint.warm.join("/")}`),
    row("DOM nodes after load", oldSide.dom, newSide.dom, "nodes", `${oldSide.rowsSeen} rows`),
    row("live intervals", oldSide.timers.intervals, newSide.timers.intervals, "count", `pending timeouts ${oldSide.timers.timeouts} vs ${newSide.timers.timeouts}`),
    row("JSON bytes per refresh", oldSide.state.bytes, newSide.state.bytes, "bytes", "/api/state body"),
    row("SSE bytes per 60 s", oldSide.sse.bytes, newSide.sse.bytes, "bytes", `${oldSide.sse.frames || 0} vs ${newSide.sse.frames || 0} chunks`),
    row("console render (500-line turn)", oldSide.console.median, newSide.console.median, "ms", `${oldSide.console.rendered} lines rendered, median of ${CONSOLE_ROUNDS}`),
    row("RSS after 2 min idle", oldSide.rss.mb, newSide.rss.mb, "MB", `pid ${oldSide.rss.pid} vs ${newSide.rss.pid}`),
  ];
}

function printTable(rows) {
  const w = Math.max(...rows.map((r) => r.metric.length));
  log(`\n${"metric".padEnd(w)}  ${String(OLD_VERSION).padStart(11)}  ${String(NEW_VERSION).padStart(11)}  ${"delta".padStart(9)}  note`);
  log(`${"-".repeat(w)}  ${"-".repeat(11)}  ${"-".repeat(11)}  ${"-".repeat(9)}  ----`);
  for (const r of rows) {
    const fmt = (v) => (typeof v === "number" ? (r.unit === "bytes" ? String(Math.round(v)) : v.toFixed(1)) : String(v));
    const d = r.deltaPct == null ? "—" : `${r.deltaPct >= 0 ? "+" : ""}${r.deltaPct.toFixed(1)}%`;
    log(`${r.metric.padEnd(w)}  ${fmt(r.old).padStart(11)}  ${fmt(r.new).padStart(11)}  ${d.padStart(9)}  ${r.note || ""}`);
  }
}

// ---- main --------------------------------------------------------------------------------------------------------
const playwright = loadPlaywright();
if (!playwright) {
  console.log("BROWSER-HALF-NOT-RUN  the perf probe — no Playwright install found (set PANEL_PLAYWRIGHT_ROOT)");
  process.exit(2);
}

log(`== perf: ${OLD_VERSION} vs ${NEW_VERSION}, ${TOTAL_ROWS} rows over ${PROJECT_COUNT} projects`);
log(`   new: ${path.resolve(ROOT)} (${versionOf(ROOT)})`);
const oldRoot = extractOld(argOf("old"));
log(`   old: ${oldRoot} (${versionOf(oldRoot)})`);
if (versionOf(ROOT) !== NEW_VERSION) log(`   WARNING: this tree's package.json says ${versionOf(ROOT)}, expected ${NEW_VERSION}`);
if (versionOf(oldRoot) !== OLD_VERSION) log(`   WARNING: the export's package.json says ${versionOf(oldRoot)}, expected ${OLD_VERSION}`);

mkdirSync(SCRATCH, { recursive: true });
const fixtureRoot = path.join(SCRATCH, "fixture");
if (!existsSync(path.join(fixtureRoot, "perf-project-1"))) {
  log(`\n== building the fixture in ${fixtureRoot}`);
  buildFixture(fixtureRoot);
} else {
  log(`\n== reusing the fixture in ${fixtureRoot}`);
}
const projects = Array.from({ length: PROJECT_COUNT }, (_, i) => ({ name: `perf-project-${i + 1}`, path: path.join(fixtureRoot, `perf-project-${i + 1}`) }));

const stub = makeStub("run-perf-live");
await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
stub.url = `http://127.0.0.1:${stub.server.address().port}`;
log(`== stub Runs API on ${stub.url} (holds run-perf-live open)`);

let oldSide = null;
let newSide = null;
let failure = null;
const measureOld = () => measureSide({ label: "0750", version: OLD_VERSION, root: oldRoot, projects, stub });
const measureNew = () => measureSide({ label: "0781", version: NEW_VERSION, root: path.resolve(ROOT), projects, stub });
try {
  if (REVERSE) {
    newSide = await measureNew();
    oldSide = await measureOld();
  } else {
    oldSide = await measureOld();
    newSide = await measureNew();
  }
} catch (e) {
  failure = e;
} finally {
  await stub.close();
}

if (failure) {
  console.error(`\nFAILED: ${failure.stack || failure}`);
  process.exit(1);
}

const rows = table(oldSide, newSide);
printTable(rows);
log(`\nstore checks: ${OLD_VERSION} ${JSON.stringify(oldSide.jobs)} + queue ${oldSide.queue.parked} parked · ${NEW_VERSION} ${JSON.stringify(newSide.jobs)} + queue ${newSide.queue.parked} parked`);
log(`verdicts: ${OLD_VERSION} ${JSON.stringify(oldSide.verdicts)} · ${NEW_VERSION} ${JSON.stringify(newSide.verdicts)}`);

const payload = {
  measuredAt: new Date().toISOString(),
  order: REVERSE ? "new-first" : "old-first",
  old: { commit: OLD_COMMIT, version: OLD_VERSION },
  new: { commit: "fd36130", version: NEW_VERSION },
  fixture: { projects: PROJECT_COUNT, rows: TOTAL_ROWS, root: fixtureRoot },
  table: rows,
  sides: { old: oldSide, new: newSide },
};
writeFileSync(OUT, JSON.stringify(payload, null, 2), "utf8");
log(`\njson: ${OUT}`);
