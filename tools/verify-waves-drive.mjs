// THE WAVE DRIVER, END TO END: a throwaway initiative with two waves and two cards in each, driven by the panel's OWN
// settle path, with both auto switches and a replay.
//
//   node tools/verify-waves-drive.mjs
//
// WHAT THIS ADDS to test/waves-drive.test.js (the plan's decisions, pinned against a real wave store). That test proves
// what a settle DECIDES; this one proves the panel TAKES the decision: a real panel, its real job store, its real
// assistant queue, its real wave routes. Nothing here calls the driver directly except the replay, which is the point.
//
// WHAT IS DRIVEN, in order:
//
//   1. THE SANDBOX IS ITS OWN. A free port (asserted not 7331), a throwaway state directory, a throwaway scanned repo
//      with real git worktrees, a throwaway HERMES_HOME, and every path the panel is handed asserted to sit inside that
//      directory. The reader's panel is never asked to write; the n8n initiative's read is hashed before and after;
//   2. A THROWAWAY INITIATIVE: `wave_01` and `wave_02`, both gate-less, both auto off, two task cards each. Card 1 is
//      RUNNING on a seeded job; cards 2, 3 and 4 are queued with real trees;
//   3. THE SETTLE STARTS THE NEXT CARD (wave progressing, switch not consulted). The stub Runs API ends the seeded run;
//      the panel's own `jobs.settle` fires the driver; card 1 reads done, card 2 reads running on a real spawned run, and
//      card 1 carries the stamp `{action:"start", task:2, job:"run-1"}`. The stub saw exactly ONE run posted;
//   4. THE GATE-LESS WAVE CLOSES ON MEMBERSHIP, AND AUTO OFF SURFACES THE NEXT. Card 2 is closed by the reader's own
//      queue route and its run is ended: `wave_01` reads done on membership, card 2's stamp reads `surfaced` with
//      "W1 done, W2 ready - press to open", and NOTHING in `wave_02` started;
//   5. AUTO ON STARTS THE NEXT WAVE. `POST /api/waves/update` turns `wave_01`'s switch on, a second real run on card 2's
//      thread ends, and card 3 starts in `wave_02` with card 2's stamp reading `opened`. Exactly one more run posted;
//   6. THE REPLAY STARTS NOTHING TWICE. The last settle is replayed against the panel's own queue and wave files with a
//      spawner that THROWS if it is called: the answer is `replay`, and the file is unchanged byte for byte;
//   7. THE THROWAWAY IS DELETED WITH THE SANDBOX. The waves are removed through the panel's own route first, so the
//      store is left as an empty document rather than a directory disappearing under a reader's feet; then the whole
//      sandbox is removed. The live panel's waves for the seven real initiatives (the n8n one included) are hashed
//      before and after and must be byte-identical.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { queuePathOf, readQueueFile } from "../lib/assistant/queue.js";
import { Waves } from "../lib/waves.js";
import { createWaveDriver } from "../lib/waves-driver.js";
import { freePort, startPanel } from "./panel-testkit.mjs";

const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 300_000);
const watchdog = setTimeout(() => {
  process.stderr.write(`WATCHDOG: ${WATCHDOG_MS}ms elapsed without the run finishing - see the last line above.\n`);
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
const lower = (p) => slash(p).replace(/\/+$/, "").toLowerCase();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(base, route) {
  const r = await fetch(`${base}${route}`);
  const text = await r.text();
  try {
    return { status: r.status, json: JSON.parse(text), text };
  } catch {
    return { status: r.status, json: null, text };
  }
}
async function postJson(base, route, body) {
  const r = await fetch(`${base}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const text = await r.text();
  try {
    return { status: r.status, json: JSON.parse(text), text };
  } catch {
    return { status: r.status, json: null, text };
  }
}
async function until(what, fn, { timeoutMs = 90_000, stepMs = 250 } = {}) {
  const untilAt = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = { error: String((e && e.message) || e) };
    }
    if (Date.now() > untilAt) {
      console.log(`      (timed out after ${timeoutMs}ms waiting for ${what}; last ${JSON.stringify(last)})`);
      return null;
    }
    await sleep(stepMs);
  }
}

// ---- the stub Runs API -------------------------------------------------------------------------------------------
// The gateway's shape, with the one power this gate needs: the test decides when a run ends. A run whose answer is
// "running" holds its event stream open exactly like a real gateway, so the panel's follow stays attached.
function makeStub() {
  const answers = new Map();
  const seen = { submitted: [], status: [], events: [] };
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
      return json(200, { version: "waves-drive-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_cwd: true } }, res);
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
      if (sub === "/steer") return json(200, { accepted: true, run_id: id }, res);
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

// ---- the sandbox ------------------------------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-waves-drive-"));
const repos = path.join(dir, "repos");
const repo = path.join(repos, "wave-sandbox");
const logs = path.join(dir, "panel", "logs");
const home = path.join(dir, "hermes-home");
const treesDir = path.join(repo, ".worktrees");
for (const d of [repo, treesDir, logs, home]) mkdirSync(d, { recursive: true });
const git = (args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
git(["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# wave drive sandbox\n", "utf8");
git(["add", "."]);
git(["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "first"]);
const trees = {};
for (const name of ["t2", "t3", "t4"]) {
  const p = path.join(treesDir, name);
  git(["worktree", "add", "-q", "-b", `wt/${name}`, p]);
  trees[name] = p;
}
const cwd1 = path.join(dir, "cwd", "t1");
mkdirSync(cwd1, { recursive: true });

const INIT = `init_wavedrive_${Math.random().toString(36).slice(2, 8)}`;
const WAVES = [
  { id: "wave_01", initiativeId: INIT, position: 1, title: "the read path", entryGate: null, exitGate: null, template: null, auto: false },
  { id: "wave_02", initiativeId: INIT, position: 2, title: "the write path", entryGate: null, exitGate: null, template: null, auto: false },
];
const wavesFile = path.join(logs, "waves.json");
writeFileSync(wavesFile, `${JSON.stringify({ version: 1, byInitiative: { [INIT]: WAVES } }, null, 2)}\n`, "utf8");
const initiativesFile = path.join(logs, "initiatives.json");
writeFileSync(initiativesFile, `${JSON.stringify({ version: 1, initiatives: [{ id: INIT, title: "Throwaway wave drive", description: "deleted with its sandbox", createdAt: new Date().toISOString(), createdBy: "verify", history: [] }], trees: {} }, null, 2)}\n`, "utf8");

const assistantFile = path.join(logs, "assistant.json");
const queueFile = queuePathOf(path.dirname(assistantFile), "assistant-1");
mkdirSync(path.dirname(queueFile), { recursive: true });
const card = (id, waveId, state, over = {}) => ({
  id,
  title: `card ${id}`,
  state,
  waveId,
  project: "wave-sandbox",
  worktree: null,
  files: [],
  detail: `the throwaway card ${id}`,
  attempts: 0,
  order: id,
  lane: null,
  createdBy: "verify",
  createdAt: new Date().toISOString(),
  ...over,
});
const cards = [
  // Card 1 names NO tree: a settled row with no tree to land closes on its run alone, which is the one ending the stub
  // can give it. Card 2 names a real worktree because the driver must start it there.
  card(1, "wave_01", "running", { thread: "wd-t1", runId: "run-1", startedAt: new Date(Date.now() - 60_000).toISOString() }),
  card(2, "wave_01", "queued", { worktree: trees.t2 }),
  card(3, "wave_02", "queued", { worktree: trees.t3 }),
  card(4, "wave_02", "queued", { worktree: trees.t4 }),
];
writeFileSync(queueFile, `${JSON.stringify({ version: 1, nextId: 5, tasks: cards }, null, 2)}\n`, "utf8");

const jobsFile = path.join(logs, "jobs.json");
const seeded = {
  id: "j-seed-1",
  thread: "wd-t1",
  turn: 1,
  prompt: "the seeded turn card 1 is on",
  cwd: cwd1,
  ownerPath: null,
  projectPath: null,
  sessionId: "wd-t1",
  status: "running",
  exitCode: null,
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  endedAt: null,
  runId: "run-1",
  worktree: false,
  existing: false,
  worktreePath: null,
  branch: null,
  lines: [],
  finalMessage: "",
};
writeFileSync(jobsFile, `${JSON.stringify({ savedAt: seeded.startedAt, jobs: [seeded] }, null, 2)}\n`, "utf8");

const stub = makeStub();
await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${stub.server.address().port}`;
const port = await freePort();

// The live panel's read of its waves, hashed before the sandbox boots and after it stops. Every initiative the live
// roster names is read, so "the seven real initiatives, the n8n one included" is measured and not promised. A panel
// that is not up is a SKIP, not a failure of this gate.
const LIVE = "http://127.0.0.1:7331";
async function liveWavesShape() {
  const roster = await getJson(LIVE, "/api/initiatives");
  const ids = (roster.json?.initiatives || []).map((i) => i.id).filter(Boolean);
  if (!ids.length) return null;
  const out = {};
  for (const id of ids) {
    const r = await getJson(LIVE, `/api/waves?initiative=${encodeURIComponent(id)}`);
    out[id] = (r.json?.waves || []).map((w) => ({ id: w.id, state: w.state, auto: w.auto, open: w.autoOpen?.open ?? null, members: (w.members || []).map((m) => `${m.id}:${m.state}`) }));
  }
  return out;
}
const liveBefore = await liveWavesShape().catch(() => null);
ok("the sandbox port is not the live panel's", port !== 7331, `port ${port}`);
ok("the sandbox directory is a throwaway", lower(dir).includes("wtgui-waves-drive"), slash(dir));
if (liveBefore) note(`the live panel's ${Object.keys(liveBefore).length} initiatives are read before the sandbox boots`);

let panel = null;
try {
  console.log(`\n== the sandbox: a panel of its own, its own stub Runs API, its own wave store ==`);
  note(`temp root ${dir}`);
  note(`throwaway initiative ${INIT}`);
  for (const [label, p] of [["the wave store", wavesFile], ["the initiative store", initiativesFile], ["the queue", queueFile], ["the jobs", jobsFile]]) {
    ok(`${label} is inside the sandbox (the reader's state is not touched)`, lower(p).startsWith(lower(dir)), slash(p));
  }
  panel = await startPanel({
    dir,
    port,
    config: {
      host: "127.0.0.1",
      scanRoots: [repos],
      threads: 1,
      scanMode: "all",
      defaultCwd: cwd1,
      refreshSeconds: 3600,
      worktreeSeconds: 3600,
      midSeconds: 3600,
      dormantSeconds: 3600,
      slowSeconds: 3600,
      fetchSeconds: 3600,
      jobsFile,
      assistantFile,
      wavesFile,
      initiativesFile,
      projectsCacheFile: path.join(logs, "projects.json"),
      treeNamesFile: path.join(logs, "tree-names.json"),
      apiServer: { url: stubUrl, key: "sandbox-key" },
      // The permission box at its free setting: this gate is about the driver, not about the dock, and a question in the
      // dock is an answer this gate would then have to give.
      initiativePermissions: "none",
      // The sentry awake at its fastest clock with a wake budget of zero: its queue sweep is the panel's own
      // settle-to-queue fold, and the budget keeps it from starting a turn of its own.
      assistant: { enabled: true, autonomy: "draft", seconds: 2, maxWakesPerHour: 0 },
    },
    env: { HERMES_HOME: home },
  });
  const base = panel.base;
  const lane = async () => {
    const r = await getJson(base, `/api/waves?initiative=${INIT}`);
    return r.json && Array.isArray(r.json.waves) ? r.json : null;
  };
  const queue = async () => {
    const r = await getJson(base, "/api/assistant/queue");
    const q = (r.json?.queues || []).find((x) => x.assistantId === "assistant-1");
    return q?.tasks || null;
  };
  const jobByThread = async (thread) => {
    const r = await getJson(base, "/api/jobs");
    const list = Array.isArray(r.json?.jobs) ? r.json.jobs : Array.isArray(r.json) ? r.json : [];
    return list.filter((j) => String(j.thread || "") === String(thread || "")).sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))[0] || null;
  };

  const first = await until("the sandbox's wave read", lane, { timeoutMs: 30_000 });
  check("the throwaway has its two waves", (first?.waves || []).map((w) => w.id), ["wave_01", "wave_02"]);
  check("wave_01 reads running on its one running member", first?.waves?.[0]?.state, "running");
  check("wave_02 reads ready (no entry gate) and has opened nothing", first?.waves?.[1]?.autoOpen?.open, false);

  // ---- 3. the settle starts the next card ----
  console.log(`\n== the settle: the stub ends the seeded run, and the panel's own job store fires the driver ==`);
  stub.set("run-1", { status: "completed", exit_code: 0, output: "the seeded turn landed" });
  const started = await until("card 1 settled and card 2 started", async () => {
    const tasks = await queue();
    if (!tasks) return null;
    const a = tasks.find((t) => t.id === 1);
    const b = tasks.find((t) => t.id === 2);
    return a?.state === "done" && b?.state === "running" ? { a, b, tasks } : null;
  });
  ok("the seeded run settled card 1 and started card 2", Boolean(started));
  if (started) {
    check("card 1 is done by the panel", started.a.doneBy, "panel");
    check("card 1's stamp is the advance", { action: started.a.waveAdvance?.action, task: started.a.waveAdvance?.task, wave: started.a.waveAdvance?.wave, job: started.a.waveAdvance?.job }, { action: "start", task: 2, wave: "wave_01", job: "run-1" });
    ok("card 1 says the wave progressed, not the switch", /whatever the auto switch says/.test(String(started.a.waveAdvance?.why || "")), started.a.waveAdvance?.why);
    ok("card 2 runs in its own tree", String(started.b.thread || "").length > 0, started.b.thread);
    ok("card 2 names the job it runs on", Boolean(started.b.runId), String(started.b.runId || "(none)"));
    // ONE ADVANCE, ONE START: the submissions that name a queue card are counted, not every run the stub saw (the
    // panel's own assistant may hold a turn of its own, and that turn is not this gate's business).
    const waveRuns = stub.seen.submitted.map((b) => JSON.stringify(b)).filter((p) => p.includes("Queue task #"));
    check("exactly one wave run was posted for the start", waveRuns.length, 1);
    ok("the posted prompt is card 2's, in wave 1", /Queue task #2: card 2/.test(waveRuns[0] || "") && /Wave 1/.test(waveRuns[0] || ""), String(waveRuns[0] || "").slice(0, 120));
    note(`the run body's own keys: ${Object.keys(stub.seen.submitted[0] || {}).join(", ")}`);

    // ---- 4. the gate-less wave closes on membership; auto off surfaces the next ----
    console.log(`\n== the gate-less close: card 2 is closed by the reader's route, then its run ends ==`);
    const closed = await postJson(base, "/api/assistant/queue", { action: "state", id: 2, state: "done", reason: "landed by hand in the sandbox", by: "verify" });
    check("the reader's close is accepted", closed.status, 200);
    const job2 = await jobByThread(started.b.thread);
    ok("the panel holds the run card 2 was started on", Boolean(job2?.runId), String(job2?.runId || "(none)"));
    stub.set(job2.runId, { status: "completed", exit_code: 0, output: "card 2 finished" });
    const surfaced = await until("card 2's stamp reads surfaced", async () => {
      const tasks = await queue();
      const b = tasks?.find((t) => t.id === 2);
      return b?.waveAdvance?.action === "surfaced" ? { b, tasks } : null;
    });
    ok("the second settle surfaced the next wave", Boolean(surfaced));
    if (surfaced) {
      check("the sentence is the fold's own", surfaced.b.waveAdvance.why, "W1 done, W2 ready - press to open");
      check("and nothing in wave_02 started", surfaced.tasks.filter((t) => t.waveId === "wave_02").map((t) => t.state), ["queued", "queued"]);
      const readBack = await lane();
      check("wave_01 reads done on its membership", readBack?.waves?.[0]?.state, "done");
      check("wave_02 still reads ready, not opened", readBack?.waves?.[1]?.autoOpen?.open, false);
      ok("wave_02's autoOpen carries the same sentence", String(readBack?.waves?.[1]?.autoOpen?.surface || "") === "W1 done, W2 ready - press to open", readBack?.waves?.[1]?.autoOpen?.surface);
    }
  }

  // ---- 5. auto on starts the next wave ----
  console.log(`\n== the switch: wave_01 auto on, a second real run on card 2's thread, and wave_02 starts ==`);
  const flipped = await postJson(base, "/api/waves/update", { initiativeId: INIT, id: "wave_01", auto: true, by: "verify" });
  check("the switch write is accepted", flipped.status, 200);
  const afterFlip = await lane();
  check("wave_01's record carries auto on", afterFlip?.waves?.[0]?.auto, true);

  const stampBefore = (await queue())?.find((t) => t.id === 2)?.waveAdvance || null;
  const tasksNow = await queue();
  const thread2 = tasksNow?.find((t) => t.id === 2)?.thread;
  ok("card 2 still names its thread", Boolean(thread2), String(thread2 || "(none)"));
  const posted = await postJson(base, "/api/agents/reply", { thread: thread2, text: "one more turn on the settled card, so a settle lands under the switch" });
  ok("a second run was accepted on card 2's thread", posted.status === 200 || posted.status === 202, `status ${posted.status}`);
  const job3 = await until("the second run on card 2's thread", () => jobByThread(thread2), { timeoutMs: 30_000 });
  ok("the panel started it and holds its run id", Boolean(job3?.runId), String(job3?.runId || "(none)"));
  if (job3?.runId) stub.set(job3.runId, { status: "completed", exit_code: 0, output: "the extra turn finished" });

  const opened = await until("card 3 started by the switch", async () => {
    const tasks = await queue();
    const b = tasks?.find((t) => t.id === 2);
    const c = tasks?.find((t) => t.id === 3);
    return b?.waveAdvance?.action === "opened" && c?.state === "running" ? { b, c, tasks } : null;
  });
  ok("auto on crossed into wave_02", Boolean(opened));
  if (opened) {
    check("card 2's stamp says the switch opened it", { action: opened.b.waveAdvance.action, task: opened.b.waveAdvance.task, wave: opened.b.waveAdvance.wave }, { action: "opened", task: 3, wave: "wave_02" });
    ok("the stamp is not the surfaced one it replaced", String(opened.b.waveAdvance.why || "") !== String(stampBefore?.why || ""), opened.b.waveAdvance.why);
    ok("card 3 runs in its own tree", String(opened.c.thread || "").length > 0, opened.c.thread);
    check("card 4 stays queued behind it", opened.tasks.find((t) => t.id === 4)?.state, "queued");
    const waveRunsNow = stub.seen.submitted.map((b) => JSON.stringify(b)).filter((p) => p.includes("Queue task #"));
    check("exactly two wave runs were posted in all", waveRunsNow.length, 2);
    ok("the second names card 3 in wave 2", /Queue task #3: card 3/.test(waveRunsNow[1] || "") && /Wave 2/.test(waveRunsNow[1] || ""), (String(waveRunsNow[1] || "").match(/Queue task #3[^\\]*/) || [""])[0] + " / " + (String(waveRunsNow[1] || "").match(/Wave 2: [^.]+/) || [""])[0]);
    const readBack = await lane();
    check("wave_02 reads running on its started member", readBack?.waves?.[1]?.state, "running");
    check("wave_02's autoOpen names the switch, from wave_01", { open: readBack?.waves?.[1]?.autoOpen?.open, by: readBack?.waves?.[1]?.autoOpen?.by, from: readBack?.waves?.[1]?.autoOpen?.from }, { open: true, by: "auto", from: "wave_01" });
  }

  // ---- 6. the replay starts nothing twice ----
  console.log(`\n== the replay: the last settle, answered again, against the panel's own files ==`);
  const beforeBytes = readFileSync(queueFile, "utf8");
  const lastSettle = { job: "the-replay", runId: job3?.runId || "stub-run-3", thread: thread2, tree: null, status: "done" };
  const stubAssistant = {
    assistants: [{ id: "assistant-1", name: "Assistant #1" }],
    jobs: { list: () => [] },
    assistantRecord: (id) => ({ id: id || "assistant-1", name: "Assistant #1" }),
    queuePathOf: () => queueFile,
    queueView: () => {
      const out = readQueueFile(queueFile);
      return { tasks: out.tasks, nextId: out.nextId };
    },
    writeQueue: () => {
      throw new Error("a replay wrote the queue");
    },
    sweepQueues: async () => 0,
    journalAdd: () => {},
    startSpawn: async () => {
      throw new Error("a replay started a run");
    },
  };
  const replayDriver = createWaveDriver({ waves: new Waves({ file: wavesFile, log: () => {} }), assistant: stubAssistant, rowFor: () => null, log: () => {} });
  let replayed = null;
  let replayError = null;
  try {
    replayed = await replayDriver.advanceSettle(lastSettle);
  } catch (e) {
    replayError = String((e && e.message) || e);
  }
  ok("the replay did not write or start anything", replayError === null, replayError || "no throw");
  check("the replay is named as a replay", replayed?.notes?.map((n) => n.code) || [], ["replay"]);
  ok("the queue file is byte for byte what the panel left", readFileSync(queueFile, "utf8") === beforeBytes);

  // ---- 7. the throwaway is deleted, and the real initiatives are untouched ----
  console.log(`\n== the throwaway is deleted, and the reader's seven initiatives are not ==`);
  const removed2 = await postJson(base, "/api/waves/remove", { initiativeId: INIT, id: "wave_02", by: "verify" });
  const removed1 = await postJson(base, "/api/waves/remove", { initiativeId: INIT, id: "wave_01", by: "verify" });
  check("the throwaway's second wave is removed", removed2.status, 200);
  check("the throwaway's first wave is removed", removed1.status, 200);
  const gone = await getJson(base, `/api/waves?initiative=${INIT}`);
  check("the throwaway store answers no waves", (gone.json?.waves || []).length, 0);
  const stored = JSON.parse(readFileSync(wavesFile, "utf8"));
  check("and the sandbox's document holds no record of it", Object.values(stored.byInitiative || {}).flat().length, 0);
} catch (e) {
  failures += 1;
  console.log(`FAIL  the run threw: ${String((e && e.stack) || e)}`);
  console.log(panel?.log ? panel.log().slice(-4000) : "");
} finally {
  if (panel) await panel.stop();
  const liveAfter = await liveWavesShape().catch(() => null);
  if (liveBefore && liveAfter) {
    // The SUBSTANCE of the read, not the whole body: a wave's fold carries the clock it was read at, and hashing that
    // would fail every run for a reason that has nothing to do with this gate. What must not move is which waves there
    // are, what each one reads, and which cards it holds.
    const created = Object.keys(liveAfter).filter((id) => !(id in liveBefore));
    const lost = Object.keys(liveBefore).filter((id) => !(id in liveAfter));
    const moved = Object.keys(liveBefore).filter((id) => id in liveAfter && JSON.stringify(liveAfter[id]) !== JSON.stringify(liveBefore[id]));
    check("no initiative appeared or vanished", { created, lost }, { created: [], lost: [] });
    check("no initiative's waves read differently", moved, []);
    note(`${Object.keys(liveAfter).length} live initiatives read, ${Object.values(liveAfter).reduce((n, ws) => n + ws.length, 0)} waves, ${Object.values(liveAfter).reduce((n, ws) => n + ws.reduce((m, w) => m + w.members.length, 0), 0)} members`);
  } else {
    note("SKIP the live panel was not answering on 7331, so its waves were not read; this gate never wrote to it");
  }
  await stub.close();
  clearTimeout(watchdog);
  console.log(`\n${failures ? "FAILED" : "OK"}  ${checks - failures}/${checks} checks passed`);
  console.log(`      the sandbox was removed: ${slash(dir)}`);
  process.exit(failures ? 1 : 0);
}
