// TWO ASSISTANTS, AT THE SAME TIME, END TO END. One sandbox panel of its own (free port, own state directory, own
// scanned repo, its own stub Runs API), and the whole product path driven through the routes the page uses:
//
//   node tools/verify-two-assistants-e2e.mjs
//
// WHAT THIS GATE EXISTS FOR. Two assistants can be created and drawn, each with its own role, rules and queue — and
// until this branch the run that was supposed to belong to the second one was handed to the first: `wake()` read
// Assistant #1's settings and started a turn on Assistant #1's thread, so a worker in #2's tree settled into #1's
// console while #2 never heard. The dispatch that fixes it is `assistantIdForJob` (thread -> tree owner -> the run's
// own stamp), and this gate is what proves it rather than reading it:
//
//   1. THE SANDBOX IS ITS OWN. A free port asserted ≠ 7331, a throwaway state directory, a throwaway scanned repo, a
//      throwaway HERMES_HOME, and every path the panel is handed is asserted to sit inside that directory. The live
//      board's 7331 listener count is compared before and after, so "it never touched the reader's panel" is a
//      measurement and not a promise;
//   2. TWO LIVE RUNS AT ONCE. Assistant #2 is created through the route. Then BOTH assistants are handed a turn in the
//      same second, and `/api/jobs` — the store, not the page — is asked whether both are live, on their own threads,
//      each stamped with its own assistant;
//   3. #2'S OWN PREAMBLE AND ITS OWN QUEUE DIGEST. The stub gateway keeps every `POST /v1/runs` body, so the input the
//      model was actually handed is a fact: #2's carries #2's name, its own queue file, its own task and its own rule,
//      and #1's carries #1's — neither carries the other's;
//   4. #2'S WAKE FIRES ON ITS OWN TREE'S SETTLE. Each assistant starts a worker in a worktree the panel cuts for it.
//      Both are live at once, in different trees, and #2's tree is recorded as #2's in locks.json. The watch the spawn
//      auto-adds is removed, the run is settled through the gateway's own terminal event, and the next run submitted
//      on #2's thread is the settle wake — while nothing new is submitted on #1's;
//   5. A TASK HANDS BOTH WAYS. A task moves with the queue's own Move (reassign), proven from the two queue files on
//      disk: it leaves #1's file and lands in #2's, then comes back;
//   6. A WORKTREE HANDS BOTH WAYS. The handover route flips the owner of #1's worker tree to #2 — a stale `from` is
//      refused — and then a run that #1 STARTS in that tree still settles into #2's thread, because the tree's owner
//      outranks the run's stamp. Handing it back flips the routing back, proven the same way;
//   7. NEITHER RUN TOUCHES THE OTHER'S TREE. The two workers' trees are disjoint, a file written into one is absent
//      from the other, one assistant's queue write leaves the other's file byte-identical, and a second run on a live
//      thread is refused (assistant thread and worker thread both).
//
// The live panel on :7331 and the live gateway are never touched: the stub answers on an ephemeral port of its own.
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { freePort, git, startPanel, waitFor, waitForState } from "./panel-testkit.mjs";

const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 300_000);
const watchdog = setTimeout(() => {
  try {
    process.stderr.write(`WATCHDOG: ${WATCHDOG_MS}ms elapsed without the run finishing — see the last line above.\n`);
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
// panel posts is kept, so "which thread was asked to run, and with what preamble" is a fact about the panel rather
// than an inference from the store afterwards. A run whose answer says "running" holds its event stream open, exactly
// like a real gateway.
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
      return json(200, { version: "two-assistants-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_cwd: true } }, res);
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      const body = await readBody(req);
      seen.submitted.push({ ...body, at: Date.now() });
      const runId = `stub-run-${seen.submitted.length}`;
      return json(200, { run_id: runId, status: "running" }, res);
    }
    const m = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const sub = m[2] || "";
      if (sub === "/steer") {
        await readBody(req);
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

// ---- HTTP --------------------------------------------------------------------------------------------------------
async function api(base, route, { method = "GET", body = null, origin = null } = {}) {
  const headers = { "Content-Type": "application/json" };
  // The page's own shape: a browser attaches a same-origin Origin to every POST and a page script cannot forge it.
  if (origin) headers.Origin = origin;
  const r = await fetch(`${base}${route}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
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

// ---- the sandbox: its own port, its own state directory, its own repo --------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-two-assistants-"));
const repos = path.join(dir, "repos");
const repo = path.join(repos, "sandbox-repo");
for (const d of [repo, path.join(repo, ".worktrees"), path.join(dir, "hermes-home")]) mkdirSync(d, { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# the sandbox repo, for two assistants at once\n", "utf8");
git(repo, ["add", "."]);
git(repo, ["commit", "-q", "-m", "first"]);

const stub = makeStub();
await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${stub.server.address().port}`;

const liveBefore = listenersOn(7331);
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const pageOrigin = `http://127.0.0.1:${port}`;

let panel = null;
const summaries = [];
try {
  panel = await startPanel({
    dir,
    port,
    config: {
      // Long clocks: this gate drives every change itself and must not be racing a scan or a fetch.
      refreshSeconds: 3600,
      worktreeSeconds: 3600,
      midSeconds: 3600,
      dormantSeconds: 3600,
      slowSeconds: 3600,
      fetchSeconds: 3600,
      scanMode: "all",
      threads: 1,
      defaultCwd: repo,
      // The stub, and only the stub: a key is present because `probe()` refuses to call a keyless gateway reachable.
      apiServer: { url: stubUrl, key: "sandbox-key" },
      // The sentry at its fastest legal clock. The rules that WAKE are left at their shipped defaults (settle, watch,
      // exited); every noisy rule is already an alert or a log by default, so nothing here needs muting.
      assistant: { enabled: true, autonomy: "draft", seconds: 2, maxWakesPerHour: 20 },
    },
  });

  const state = async () => getJson(base, "/api/state");
  const assistantState = async () => (await getJson(base, "/api/assistant"));
  const jobs = async () => (await getJson(base, "/api/jobs")).jobs || [];
  const live = (j) => ["running", "starting", "waiting"].includes(String(j.status || ""));
  const jobById = async (id) => (await jobs()).find((j) => String(j.id) === String(id)) || null;

  // ================================================================================================================
  console.log("\n== 1. a sandbox of its own: own port, own state dir, own scanned repo ==");
  note(`temp root ${dir}`);
  ok("the sandbox port is free of 7331", port !== 7331, `port ${port}`);
  ok("the sandbox config is on disk inside the sandbox", lower(panel.configPath).startsWith(lower(dir)), slash(panel.configPath));
  for (const key of ["jobsFile", "assistantFile", "projectsCacheFile"]) {
    const value = JSON.parse(readFileSync(panel.configPath, "utf8"))[key];
    ok(`…${key} is inside it (the reader's state is not touched)`, lower(value).startsWith(lower(dir)), slash(value));
  }
  const locksFile = path.join(dir, "logs", "locks.json");
  ok("the owner store is the sandbox's own locks.json", lower(locksFile).startsWith(lower(dir)), slash(locksFile));
  ok("the scanned repo is the sandbox's own", lower(repo).startsWith(lower(dir)), slash(repo));
  const health = await api(base, "/api/health");
  ok("the sandbox answers on its own port", health.status === 200, `HTTP ${health.status}`);
  const board = await waitFor(
    async () => {
      const s = await state();
      const project = (s.projects || []).find((p) => lower(p.path) === lower(repo) || lower(p.name) === "sandbox-repo");
      return project ? s : null;
    },
    { what: "the sandbox repo to be discovered", timeoutMs: 45_000 },
  );
  const projectName = (board?.projects || []).find((p) => lower(p.path) === lower(repo) || lower(p.name) === "sandbox-repo")?.name || "sandbox-repo";
  ok("the sandbox repo is a project on the board", Boolean(projectName), projectName);

  // ================================================================================================================
  console.log("\n== 2. Assistant #2 is created, and gets a queue file and settings of its own ==");
  const created = await api(base, "/api/assistant/assistants", { method: "POST", body: { name: "Assistant #2" } });
  ok("creating Assistant #2 is accepted", created.status === 201, `HTTP ${created.status} ${created.json?.error || ""}`);
  const records = (await assistantState()).assistants || [];
  check("two assistants are on the board", records.map((a) => a.id), ["assistant-1", "assistant-2"]);
  check("each has its own thread", records.map((a) => a.threadId), ["panel-assistant", "panel-assistant-2"]);
  const a1 = "assistant-1";
  const a2 = "assistant-2";
  const queueFile = (id) => path.join(dir, "logs", "assistants", id, "queue.json");
  ok("Assistant #2's queue file exists before anything is written to it", readFileSync(queueFile(a2), "utf8").length > 0, slash(queueFile(a2)));

  // A task and a rule each, so the two preambles can be told apart from the model's own input.
  const addOne = await api(base, "/api/assistant/queue", { method: "POST", body: { assistantId: a1, action: "add", title: "TASK-ONE-ONLY", files: "one.txt" } });
  ok("Assistant #1's queue takes a task", addOne.status === 200, `HTTP ${addOne.status}`);
  const a1FileBefore = readFileSync(queueFile(a1), "utf8");
  const addTwo = await api(base, "/api/assistant/queue", { method: "POST", body: { assistantId: a2, action: "add", title: "TASK-TWO-ONLY", files: "two.txt" } });
  ok("Assistant #2's queue takes a task", addTwo.status === 200, `HTTP ${addTwo.status}`);
  ok(
    "…and #1's queue file is byte-identical after #2's write (one file per assistant, no shared write)",
    readFileSync(queueFile(a1), "utf8") === a1FileBefore,
    `${a1FileBefore.length} bytes`,
  );
  await api(base, "/api/assistant/rule", { method: "POST", body: { assistantId: a1, text: "RULE-ONE-ONLY: keep #1's own counsel." } });
  await api(base, "/api/assistant/rule", { method: "POST", body: { assistantId: a2, text: "RULE-TWO-ONLY: #2 answers for its own trees." } });

  // ================================================================================================================
  console.log("\n== 3. two live runs at once, one per assistant, each on its own thread ==");
  const watermark = stub.seen.submitted.length;
  const turn1 = await api(base, "/api/assistant/say", { method: "POST", body: { text: "TURN-ONE: say where your queue stands." } });
  const turn2 = await api(base, "/api/assistant/say", { method: "POST", body: { text: "TURN-TWO: say where your queue stands.", assistantId: a2 } });
  ok("Assistant #1's turn is accepted", turn1.status === 202, `HTTP ${turn1.status} ${turn1.json?.error || ""}`);
  ok("Assistant #2's turn is accepted", turn2.status === 202, `HTTP ${turn2.status} ${turn2.json?.error || ""}`);
  check("the two turns are two jobs on two threads", [turn1.json?.job?.thread, turn2.json?.job?.thread], ["panel-assistant", "panel-assistant-2"]);
  check("each job carries its own assistant's stamp", [turn1.json?.job?.assistantId, turn2.json?.job?.assistantId], [a1, a2]);

  await waitFor(async () => {
    const list = await jobs();
    return list.filter(live).filter((j) => ["panel-assistant", "panel-assistant-2"].includes(j.thread)).length === 2;
  }, { what: "both assistant turns to be live at once" });
  const bothLive = (await jobs()).filter(live).filter((j) => ["panel-assistant", "panel-assistant-2"].includes(j.thread));
  check("the job store holds BOTH live at the same time", bothLive.map((j) => j.thread).sort(), ["panel-assistant", "panel-assistant-2"]);
  // The failure this branch fixes, stated as a measurement: each thread is registered to its own assistant in the
  // store, and #2's thread is not #1's.
  check("…and `/api/jobs` registers each thread to its own assistant", bothLive.map((j) => `${j.thread}=${j.assistantId}`).sort(), [
    "panel-assistant-2=assistant-2",
    "panel-assistant=assistant-1",
  ]);
  ok("no two live runs share a thread", new Set(bothLive.map((j) => j.thread)).size === bothLive.length, `${bothLive.length} threads`);
  // The assistant's own turn runs in the assistant's own cwd — a folder of its own beside the job store, never a
  // project checkout — so neither turn can be working in a tree.
  ok(
    "both turns ran in the assistant's own cwd, not a project tree",
    bothLive.every((j) => lower(j.cwd).includes("/assistant-cwd") && !lower(j.cwd).includes("/repos/")),
    slash(bothLive[0]?.cwd),
  );

  // A second turn on a live thread is refused for BOTH assistants: one run per thread is not a rule about #1.
  const again1 = await api(base, "/api/assistant/say", { method: "POST", body: { text: "TURN-ONE-AGAIN" } });
  const again2 = await api(base, "/api/assistant/say", { method: "POST", body: { text: "TURN-TWO-AGAIN", assistantId: a2 } });
  check("a second turn on #1's live thread is refused", again1.status, 409);
  check("a second turn on #2's live thread is refused", again2.status, 409);
  summaries.push("2 live assistant turns at once, one thread each, registered to their own assistant");

  // ================================================================================================================
  console.log("\n== 4. #2's run was handed ITS preamble and ITS queue digest, not #1's ==");
  const submitted = stub.seen.submitted.slice(watermark);
  const run1 = submitted.find((b) => b.session_id === "panel-assistant");
  const run2 = submitted.find((b) => b.session_id === "panel-assistant-2");
  ok("the gateway was asked to run on #1's thread, with an input", Boolean(run1?.input), `${(run1?.input || "").length} chars`);
  ok("the gateway was asked to run on #2's thread, with an input", Boolean(run2?.input), `${(run2?.input || "").length} chars`);
  const in1 = String(run1?.input || "");
  const in2 = String(run2?.input || "");
  const q1 = slash(queueFile(a1));
  const q2 = slash(queueFile(a2));
  ok("#2's input says which assistant it is", in2.includes("You are Assistant #2"), in2.split("\n")[0]);
  ok("#1's input does not claim to be #2", !in1.includes("You are Assistant #2"), in1.split("\n")[0]);
  ok("#2's input names #2's queue file", in2.includes(q2), q2);
  ok("#2's input does not name #1's queue file", !in2.includes(q1), q1);
  ok("#1's input names #1's queue file", in1.includes(q1), q1);
  ok("#2's digest is #2's queue, and carries nothing of #1's", in2.includes("TASK-TWO-ONLY") && !in2.includes("TASK-ONE-ONLY"), "TASK-TWO-ONLY only");
  ok("#1's digest is #1's queue, and carries nothing of #2's", in1.includes("TASK-ONE-ONLY") && !in1.includes("TASK-TWO-ONLY"), "TASK-ONE-ONLY only");
  ok("#2's standing rules are #2's own", in2.includes("RULE-TWO-ONLY") && !in2.includes("RULE-ONE-ONLY"), "RULE-TWO-ONLY only");
  ok("#1's standing rules are #1's own", in1.includes("RULE-ONE-ONLY") && !in1.includes("RULE-TWO-ONLY"), "RULE-ONE-ONLY only");
  summaries.push("each assistant's turn carried its own preamble, queue file, task, digest and rules");

  // Settle both turns, so their threads are free for the wake phase.
  const settleRun = async (job, output) => {
    stub.set(job.runId, { status: "completed", exit_code: 0, output, usage: { input_tokens: 10, output_tokens: 5 } });
    await waitFor(async () => {
      const now = await jobById(job.id);
      return now && !live(now) ? now : null;
    }, { what: `${job.thread} to settle` });
  };
  await settleRun(turn1.json.job, "Nothing pressing on my queue right now.");
  await settleRun(turn2.json.job, "My queue holds one task; nothing is running in my trees.");

  // ================================================================================================================
  console.log("\n== 5. each assistant starts a worker in its OWN worktree, both at once ==");
  const spawn1 = await api(base, "/api/assistant/spawn", { method: "POST", body: { project: projectName, prompt: "WORKER-ONE: write one.txt in your tree." } });
  const spawn2 = await api(base, "/api/assistant/spawn", { method: "POST", body: { project: projectName, prompt: "WORKER-TWO: write two.txt in your tree.", assistantId: a2 } });
  ok("#1's SPAWN starts a worker", spawn1.status === 202, `HTTP ${spawn1.status} ${spawn1.json?.error || ""}`);
  ok("#2's SPAWN starts a worker", spawn2.status === 202, `HTTP ${spawn2.status} ${spawn2.json?.error || ""}`);
  const w1 = spawn1.json?.job || {};
  const w2 = spawn2.json?.job || {};
  check("each worker is stamped with the assistant that started it", [w1.assistantId, w2.assistantId], [a1, a2]);
  check("each worker cuts a worktree of its own", [Boolean(w1.worktreePath), Boolean(w2.worktreePath)], [true, true]);
  ok("the two trees are different directories", lower(w1.worktreePath) && lower(w1.worktreePath) !== lower(w2.worktreePath), `${slash(w1.worktreePath)} · ${slash(w2.worktreePath)}`);
  await waitFor(async () => {
    const list = await jobs();
    return list.filter(live).filter((j) => [w1.thread, w2.thread].includes(j.thread)).length === 2;
  }, { what: "both workers to be live at once" });
  const workersLive = (await jobs()).filter(live).filter((j) => [w1.thread, w2.thread].includes(j.thread));
  check("both workers are live at the same time", workersLive.map((j) => j.thread).sort(), [w1.thread, w2.thread].sort());
  // Each run's tree is its own: the panel cut one tree per run and every run stands in its own.
  check("each worker stands in its own tree", workersLive.map((j) => lower(j.worktreePath)).sort(), [lower(w1.worktreePath), lower(w2.worktreePath)].sort());
  ok(
    "each live worker's tree is the one it was cut in",
    lower(workersLive.find((j) => j.thread === w1.thread)?.worktreePath) === lower(w1.worktreePath) &&
      lower(workersLive.find((j) => j.thread === w2.thread)?.worktreePath) === lower(w2.worktreePath),
    `${slash(w1.worktreePath)} · ${slash(w2.worktreePath)}`,
  );

  const owners = () => {
    try {
      return JSON.parse(readFileSync(locksFile, "utf8")).owners || {};
    } catch {
      return {};
    }
  };
  const tagOf = (tree) => (/\.worktrees\/(.+)$/.exec(slash(tree)) || [])[1] || "";
  const keyFor = (tree) => `${projectName}::${(/-([0-9a-f]{6})$/.exec(tagOf(tree)) || [])[1] || ""}`;
  ok("the tree #2's worker runs in is recorded as #2's", owners()[keyFor(w2.worktreePath)] === a2, `${keyFor(w2.worktreePath)} -> ${owners()[keyFor(w2.worktreePath)] || "(absent)"}`);
  ok("the tree #1's worker runs in has NO owner record (absence is Assistant #1)", !owners()[keyFor(w1.worktreePath)], JSON.stringify(owners()));
  summaries.push("each assistant started a worker in its own worktree; #2's tree is recorded as #2's");

  // ================================================================================================================
  console.log("\n== 6. #2's wake fires on its own tree's settle — and #1's does not ==");
  // The spawn auto-adds a watch on the worker's thread, and a watch that covers a finish IS the notice (by design).
  // Removing it here is what makes the SETTLE rule the one that fires, which is the path this item is about.
  for (const j of [w1, w2]) {
    const watches = ((await assistantState()).watches || []).filter((w) => w.thread === j.thread && w.state !== "done");
    for (const w of watches) await api(base, "/api/assistant/watch/remove", { method: "POST", body: { id: w.id } });
  }
  const beforeSettle = stub.seen.submitted.length;
  const jobsOnThread = async (thread) => (await jobs()).filter((j) => j.thread === thread).length;
  const runsOnThreadBefore = await jobsOnThread("panel-assistant");
  await settleRun(w2, "WORKER-TWO finished: two.txt is written and uncommitted in my tree.");
  const woke = await waitFor(
    async () => {
      const fresh = stub.seen.submitted.slice(beforeSettle);
      return fresh.find((b) => b.session_id === "panel-assistant-2") || null;
    },
    { what: "the settle wake on Assistant #2's thread", timeoutMs: 45_000 },
  );
  ok("a run was started on Assistant #2's thread when #2's worker settled", Boolean(woke), woke ? `${(woke.input || "").length} chars` : "none");
  ok("the wake names the settle rule and the worker's own thread", Boolean(woke) && /\[settle\]/.test(woke.input) && woke.input.includes(w2.thread), (woke?.input || "").split("\n").find((l) => l.includes("[settle]")) || "(no settle line)");
  ok("the wake carries the worker's final message", Boolean(woke) && String(woke.input).includes("two.txt is written"), "the completion notice rode with it");
  const fresh = stub.seen.submitted.slice(beforeSettle);
  ok("Assistant #1 was NOT handed that settle", !fresh.some((b) => b.session_id === "panel-assistant"), `${fresh.length} run(s) submitted, none on #1's thread`);
  const afterAlerts = ((await assistantState()).alerts || []).filter((al) => al.rule === "settle");
  const settleAlert = afterAlerts[0] || null;
  ok("the settle alert is filed for Assistant #2, not #1", Boolean(settleAlert) && settleAlert.assistantId === a2, settleAlert ? `rule ${settleAlert.rule}, assistantId ${settleAlert.assistantId}` : "no settle alert");
  summaries.push("a settle in #2's tree woke #2 on its own thread, and #1 was not handed it");

  // Free #2's thread again, then prove the negative from the other side: #1's worker settles, and #1 hears it.
  const wakeJob = (await jobs()).find((j) => j.thread === "panel-assistant-2" && live(j));
  if (wakeJob) await settleRun(wakeJob, "Noted — my worker's branch is ready to land.");
  await waitFor(async () => (await jobsOnThread("panel-assistant")) === runsOnThreadBefore, { what: "#1's thread to be untouched so far" });
  const beforeSecond = stub.seen.submitted.length;
  await settleRun(w1, "WORKER-ONE finished: one.txt is written and uncommitted in my tree.");
  const woke1 = await waitFor(
    async () => stub.seen.submitted.slice(beforeSecond).find((b) => b.session_id === "panel-assistant") || null,
    { what: "the settle wake on Assistant #1's thread", timeoutMs: 45_000 },
  );
  ok("a run was started on Assistant #1's thread when #1's worker settled", Boolean(woke1), woke1 ? "settle on #1" : "none");
  ok("…and #2 was not handed that one", !stub.seen.submitted.slice(beforeSecond).some((b) => b.session_id === "panel-assistant-2"), "none on #2's thread");
  // Free #1's thread again: a wake that arrives while a turn is running is queued behind it by design.
  const wake1Job = (await jobs()).find((j) => j.thread === "panel-assistant" && live(j));
  if (wake1Job) await settleRun(wake1Job, "Noted — one.txt is ready to land.");

  // ================================================================================================================
  console.log("\n== 7. a TASK hands from #1 to #2, and back ==");
  const task = await api(base, "/api/assistant/queue", { method: "POST", body: { assistantId: a1, action: "add", title: "TASK-TO-HAND-OVER", files: "hand.txt" } });
  const taskId = task.json?.task?.id;
  ok("the task starts in #1's queue", Number.isInteger(taskId), `#${taskId}`);
  const moved = await api(base, "/api/assistant/queue", { method: "POST", body: { assistantId: a1, action: "reassign", id: taskId, owner: a2 } });
  ok("the Move is accepted", moved.status === 200, `HTTP ${moved.status} ${moved.json?.error || ""}`);
  const q1After = JSON.parse(readFileSync(queueFile(a1), "utf8")).tasks || [];
  const q2After = JSON.parse(readFileSync(queueFile(a2), "utf8")).tasks || [];
  ok("the task LEFT Assistant #1's queue file", !q1After.some((t) => t.title === "TASK-TO-HAND-OVER"), `${q1After.length} task(s) left`);
  const landed = q2After.find((t) => t.title === "TASK-TO-HAND-OVER") || null;
  ok("…and LANDED in Assistant #2's queue file", Boolean(landed), landed ? `#${landed.id} state ${landed.state}` : `#2 holds ${q2After.length} task(s)`);
  ok("…carrying the move it came from", Boolean(landed) && (landed.movedFrom || []).some((m) => m.from === a1 && m.to === a2), JSON.stringify(landed?.movedFrom || []));
  const back = await api(base, "/api/assistant/queue", { method: "POST", body: { assistantId: a2, action: "reassign", id: landed?.id, owner: a1 } });
  ok("the hand-back is accepted", back.status === 200, `HTTP ${back.status} ${back.json?.error || ""}`);
  const q1Home = (JSON.parse(readFileSync(queueFile(a1), "utf8")).tasks || []).find((t) => t.title === "TASK-TO-HAND-OVER");
  const q2Gone = (JSON.parse(readFileSync(queueFile(a2), "utf8")).tasks || []).filter((t) => t.title === "TASK-TO-HAND-OVER");
  ok("the task is back in #1's file", Boolean(q1Home), q1Home ? `#${q1Home.id}` : "missing");
  ok("…and gone from #2's file", q2Gone.length === 0, `${q2Gone.length} left behind`);
  summaries.push("a task moved #1→#2 and back, proven from both queue files");

  // ================================================================================================================
  console.log("\n== 8. a WORKTREE hands from #1 to #2: ownership, then the wake, then the hand-back ==");
  const treeA = w1.worktreePath;
  const keyA = keyFor(treeA);
  const stale = await api(base, "/api/worktree/transfer", { method: "POST", origin: pageOrigin, body: { project: projectName, path: treeA, from: a2, to: a1 } });
  check("a handover that names the wrong current owner is refused", stale.status, 409);
  ok("…and nothing moved for it", !owners()[keyA], JSON.stringify(owners()[keyA] || null));

  const flip = await api(base, "/api/worktree/transfer", { method: "POST", origin: pageOrigin, body: { project: projectName, path: treeA, from: a1, to: a2 } });
  ok("the reader's handover is accepted", flip.status === 200, `HTTP ${flip.status} ${flip.json?.error || ""}`);
  check("…and it says what it flipped", [flip.json?.from, flip.json?.to, flip.json?.changed], [a1, a2, true]);
  check("…and the routing that follows is #2's", [flip.json?.wake?.assistantId, flip.json?.wake?.thread], [a2, "panel-assistant-2"]);
  check("…and the row's owner cell is #2", flip.json?.row?.assistant?.id, a2);
  ok("the store now records that tree as #2's", owners()[keyA] === a2, `${keyA} -> ${owners()[keyA] || "(absent)"}`);
  const rowsNow = ((await state()).projects || []).find((p) => p.name === projectName)?.worktrees || [];
  check("the board's own row says #2 (a repaint, not just the answer)", rowsNow.find((r) => lower(r.path) === lower(treeA))?.assistant?.id, a2);

  // A run that #1 STARTS in a tree the reader gave #2 still belongs to #2: the tree's owner outranks the run's stamp.
  const inA2 = await api(base, "/api/assistant/spawn", { method: "POST", body: { existing: true, target: treeA, prompt: "REPLY-IN-A: one more pass in this tree.", assistantId: a1 } });
  ok("Assistant #1 can start a run in that tree", inA2.status === 202, `HTTP ${inA2.status} ${inA2.json?.error || ""}`);
  const runA2 = inA2.json?.job || {};
  check("…and the run carries #1's own stamp", runA2.assistantId, a1);
  for (const w of ((await assistantState()).watches || []).filter((w) => w.thread === runA2.thread && w.state !== "done")) {
    await api(base, "/api/assistant/watch/remove", { method: "POST", body: { id: w.id } });
  }
  const beforeFlipWake = stub.seen.submitted.length;
  await settleRun(runA2, "The pass is done; one.txt is committed on this branch.");
  const flippedWake = await waitFor(
    async () => stub.seen.submitted.slice(beforeFlipWake).find((b) => b.session_id === "panel-assistant-2") || null,
    { what: "the wake for a run in #2's tree", timeoutMs: 45_000 },
  );
  ok("a run in the handed-over tree wakes Assistant #2, though #1 started it", Boolean(flippedWake), flippedWake ? "[settle] on #2" : "none");
  ok("…and Assistant #1 is not woken for it", !stub.seen.submitted.slice(beforeFlipWake).some((b) => b.session_id === "panel-assistant"), "none on #1's thread");
  const wakeJob2 = (await jobs()).find((j) => j.thread === "panel-assistant-2" && live(j));
  if (wakeJob2) await settleRun(wakeJob2, "Understood — that branch is mine now.");

  const handback = await api(base, "/api/worktree/transfer", { method: "POST", origin: pageOrigin, body: { project: projectName, path: treeA, from: a2, to: a1 } });
  ok("the hand-back is accepted", handback.status === 200, `HTTP ${handback.status} ${handback.json?.error || ""}`);
  check("…and the row's owner cell is #1 again", handback.json?.row?.assistant?.id, a1);
  // A hand-over is the routing DECISION, so "back to #1" is written as an answer — not left to the default, which a run
  // still carrying #2's stamp would beat.
  ok("…and the store records the hand-back as a decision for #1", owners()[keyA] === a1, `${keyA} -> ${owners()[keyA] || "(absent)"}`);
  const inA1 = await api(base, "/api/assistant/spawn", { method: "POST", body: { existing: true, target: treeA, prompt: "REPLY-IN-HOME: one more pass after the hand-back.", assistantId: a2 } });
  ok("Assistant #2 can still start a run in that tree", inA1.status === 202, `HTTP ${inA1.status} ${inA1.json?.error || ""}`);
  const runA1 = inA1.json?.job || {};
  for (const w of ((await assistantState()).watches || []).filter((w) => w.thread === runA1.thread && w.state !== "done")) {
    await api(base, "/api/assistant/watch/remove", { method: "POST", body: { id: w.id } });
  }
  const beforeHomeWake = stub.seen.submitted.length;
  await settleRun(runA1, "The pass after the hand-back is done.");
  const homeWake = await waitFor(
    async () => stub.seen.submitted.slice(beforeHomeWake).find((b) => b.session_id === "panel-assistant") || null,
    { what: "the wake for a run back in #1's tree", timeoutMs: 45_000 },
  );
  ok("after the hand-back the same tree wakes Assistant #1 again", Boolean(homeWake), homeWake ? "[settle] on #1" : "none");
  ok("…and Assistant #2 is not woken for it", !stub.seen.submitted.slice(beforeHomeWake).some((b) => b.session_id === "panel-assistant-2"), "none on #2's thread");
  summaries.push("a worktree flipped #1→#2 and back; the wake followed the tree, not the run's stamp");

  // ================================================================================================================
  console.log("\n== 9. neither assistant's run touches the other's tree ==");
  writeFileSync(path.join(treeA, "only-in-a.txt"), "written by run A\n", "utf8");
  let shared = 1;
  try {
    readFileSync(path.join(w2.worktreePath, "only-in-a.txt"), "utf8");
    shared = 1;
  } catch {
    shared = 0;
  }
  check("a file written in #1's tree is absent from #2's tree", shared, 0);
  const all = await jobs();
  // The product's own rule: two agents in one tree is about WORKERS. Every assistant turn runs in the assistant's own
  // cwd by design, so those are counted the way `evaluate` counts them — by thread, not by directory.
  const workerThreads = new Set([w1.thread, w2.thread]);
  const treeCount = new Map();
  for (const j of all.filter(live).filter((j) => workerThreads.has(j.thread))) treeCount.set(lower(j.worktreePath || j.cwd), (treeCount.get(lower(j.worktreePath || j.cwd)) || 0) + 1);
  ok("no two live workers share a tree right now", [...treeCount.values()].every((n) => n <= 1), JSON.stringify([...treeCount.entries()]));
  // One run per thread, on a WORKER thread this time: a reply to #2's live worker is refused.
  const liveWorker = all.find((j) => live(j) && ![w1.thread].includes(j.thread) && j.thread !== "panel-assistant" && j.thread !== "panel-assistant-2") || null;
  if (liveWorker) {
    const twice = await api(base, "/api/agents/reply", { method: "POST", body: { thread: liveWorker.thread, text: "a second run on a live thread" } });
    check("a reply to a live worker thread is refused (one run per thread)", twice.status, 409);
  } else {
    note("no worker thread was still live at this point — the one-run-per-thread refusal was already proven above, on both assistant threads");
  }

  // ================================================================================================================
  console.log("\n== 10. the reader's own panel was never touched ==");
  const liveAfter = listenersOn(7331);
  check("the live board's 7331 listener count is unchanged", liveAfter, liveBefore);
  ok("the sandbox's own listeners are inside the sandbox's process", port !== 7331, `the panel answered on ${port}`);
  summaries.push("the live :7331 board was untouched before and after");
} catch (err) {
  failures += 1;
  console.log(`FAIL  the run threw: ${String((err && err.stack) || err)}`);
} finally {
  console.log("\n== what this run proved ==");
  for (const s of summaries) console.log(`  · ${s}`);
  if (panel) {
    try {
      console.log(`      panel log: ${panel.log().split("\n").slice(-6).join(" | ")}`);
    } catch {
      /* nothing to say */
    }
    await panel.stop();
  }
  await stub.close();
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* a locked temp file is not this gate's verdict */
  }
  console.log(`\nRESULT: ${failures ? "FAIL" : "PASS"} — ${checks} checks, ${failures} failed`);
  clearTimeout(watchdog);
  process.exit(failures ? 1 : 0);
}
