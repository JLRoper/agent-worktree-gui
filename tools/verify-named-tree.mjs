// The naming ledger, proved by driving a panel of its own — and not by reading the code.
//
//   node tools/verify-named-tree.mjs
//
// The bug: a worktree's name churned. `renameWorktree` (server.js) renames the directory and the branch after the
// title Hermes gives the session at the end of the first turn, which is right for one agent per tree and wrong the
// moment a second run is started into the same tree — and wrong even for one run, because the "once per tree" guard
// was an in-memory Set of PATHS: the first rename moved the directory, so the key went stale, and the next job event
// of the same run walked straight past it. Measured on the live board: one tree whose directory was
// `…/fast-forward-main-and-restart-live-panel-4a1f05` sitting on branch `wtgui/put-the-live-panel-onto-4a1f05`, and
// four cards for one tree spelling three different branch names.
//
// The fix is a record (lib/tree-names.js) keyed on the six-hex tag every rename keeps, written beside the panel's
// job store, consulted before any automatic rename: a tree is named once, by the run that gets it first, and every
// later run — and every later event — leaves the name alone. Replacing that name is now a deliberate act: the ✦ in
// the row asks the WORK (the branch's commits and its diff against the base branch, via /api/worktree/suggest-name)
// for a name, shows it with the commits behind it, and renames only when the reader answers the question.
//
// Everything below happens in a sandbox of its own: a throwaway repo, a throwaway HERMES_HOME, its own PANEL_CONFIG
// with its own port, its own logs, and a STUB gateway on an ephemeral port. The live panel on 7331 and the live
// gateway on 8642 are never touched, and no branch of this repository is renamed — every rename below is inside the
// sandbox repo, which is deleted at the end.
//
// WHAT IS DRIVEN, AND WHAT IS ONLY INSPECTED
//
//   driven        run one names its tree: a real POST /api/agents, a real worktree cut, a real title in the panel's
//                 own session store, the panel's own 10-second title sweep, and the rename that lands on disk
//   driven        run two into the same tree leaves the name alone (the panel's existing-tree path)
//   driven        the churn case itself: a second automatic attempt for the SAME tree, in a restarted panel with a
//                 DIFFERENT title for that tree's run available — and a positive control in the same window (a tree
//                 nobody has named, renamed by that same sweeper) so "untouched" cannot mean "the sweeper was asleep"
//   driven        the 409 while an agent is running in the tree, against a stub run held live
//   driven        the ✦'s two requests: /api/worktree/suggest-name (renames nothing) and /api/worktree/rename
//                 (renames once, keeps the tag, and records the reader as the one who named it)
//   driven        the record: who and when, in the panel's own tree-names.json, and the same on the board's row
//   inspected     the browser half — the ✦ button, its confirm box and the release-time click handling live in
//                 public/app.js; this script drives the two HTTP requests behind them and asserts their answers,
//                 it does not click (there is no browser here)
//   inspected     the counterfactual — that the OLD guard would have renamed this tree again in the second-attempt
//                 phase is stated from reading that code, not shown by running it side by side
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { readWorktreeWork, nameFromWork, slugWords } from "../lib/name-from-work.js";
import { describeNaming, tagOf, treeKey } from "../lib/tree-names.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

let failures = 0;
let checks = 0;
const check = (name, got, want) => {
  checks += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 60_000, stepMs = 500, what = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let got = false;
    try {
      got = await fn();
    } catch {
      got = false;
    }
    if (got) return true;
    if (Date.now() > until) {
      console.log(`      (timed out after ${timeoutMs}ms waiting for ${what})`);
      return false;
    }
    await sleep(stepMs);
  }
}

const git = (dir, args) => {
  try {
    return { ok: true, out: execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true }).trim() };
  } catch (e) {
    return { ok: false, out: String((e && e.stdout) || "").trim(), err: String((e && e.message) || e) };
  }
};
const commit = (dir, files, message) => {
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body, "utf8");
  }
  git(dir, ["add", "."]);
  const r = git(dir, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", message]);
  return r.ok;
};
const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const baseOf = (p) => norm(p).split("/").filter(Boolean).pop() || "";
const branchOf = (dir) => git(dir, ["symbolic-ref", "--short", "HEAD"]).out || null;
const listTrees = (repo) => {
  const out = git(repo, ["worktree", "list", "--porcelain"]).out;
  const trees = [];
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) cur = { path: line.slice(9).trim(), branch: null };
    else if (line.startsWith("branch ") && cur) cur.branch = line.slice(7).trim().replace("refs/heads/", "");
    else if (!line.trim() && cur) {
      trees.push(cur);
      cur = null;
    }
  }
  if (cur) trees.push(cur);
  return trees;
};
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// ---- a stub gateway --------------------------------------------------------------------------
// Exactly what lib/jobs.js asks of a real one and nothing more: capabilities, run submission, a pollable status and
// the run's SSE stream. A run settles on its own unless it is HELD (which is how the 409 gets an agent that is
// genuinely running in a tree).
function makeStub() {
  const state = { runs: new Map(), seq: 0, hold: false, settleMs: 500 };
  const timers = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/v1/capabilities") {
      return json(200, {
        version: "0.22.2-stub",
        features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true },
      });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        state.seq += 1;
        const id = `run-${state.seq}`;
        state.runs.set(id, { id, status: "running", output: "", session: body.session_id || null, input: String(body.input || "") });
        // Held: this run stays "running" until the script releases it — an agent genuinely living in a tree.
        if (!state.hold) {
          const t = setTimeout(() => {
            const rec = state.runs.get(id);
            if (rec && rec.status === "running") {
              rec.status = "completed";
              rec.output = "sandbox stub: done";
            }
          }, state.settleMs);
          timers.push(t);
        }
        json(200, { run_id: id });
      });
      return;
    }
    const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const rec = state.runs.get(one[1]);
      if (!rec) return json(404, { error: { message: "Run not found", code: "run_not_found" } });
      return json(200, { run_id: rec.id, status: rec.status, output: rec.output });
    }
    if (/^\/v1\/runs\/[^/]+\/events$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3];
      const rec = state.runs.get(id);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      if (!rec) return res.end();
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
        if (rec.status !== "running") {
          clearInterval(timer);
          const payload = JSON.stringify({ event: `run.${rec.status}`, output: rec.output });
          res.write(`event: run.${rec.status}\ndata: ${payload}\n\n`);
          res.end();
        } else if (ticks > 150) {
          clearInterval(timer);
          res.end();
        }
      }, 200);
      timers.push(timer);
      req.on("close", () => clearInterval(timer));
      return;
    }
    json(404, {});
  });
  const finishAll = () => {
    for (const rec of state.runs.values()) {
      if (rec.status === "running") {
        rec.status = "completed";
        rec.output = "sandbox stub: released";
      }
    }
  };
  const close = () =>
    new Promise((r) => {
      for (const t of timers) clearInterval(t);
      server.closeAllConnections?.();
      server.close(() => r());
    });
  return { state, server, finishAll, close };
}

// ---- the sandbox -----------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-named-tree-"));
const rootDir = path.join(dir, "scan-root");
const repo = path.join(rootDir, "sandbox-repo");
const home = path.join(dir, "hermes-home");
const configDir = path.join(dir, "panel");
const cwdDir = path.join(dir, "panel-cwd");
mkdirSync(repo, { recursive: true });
mkdirSync(path.join(repo, ".worktrees"), { recursive: true });
mkdirSync(home, { recursive: true });
mkdirSync(configDir, { recursive: true });
mkdirSync(cwdDir, { recursive: true });

// The session store the panel reads titles from ($HERMES_HOME/state.db) — the same two tables `sessionIndex` queries.
const dbPath = path.join(home, "state.db");
const db = new DatabaseSync(dbPath);
// The panel opens this file for its own reads (session titles, usage) while a phase is writing to it: without a busy
// timeout the write fails outright with "database is locked" rather than waiting its turn.
db.exec("pragma busy_timeout = 15000");
db.exec("create table if not exists sessions (id text primary key, title text, last_activity_at integer)");
db.exec("create table if not exists messages (session_id text, timestamp integer, role text, content text)");
const seedSession = (thread, title) => {
  // A synchronous sleep: this runs at the top level of a phase, and a busy-timeout retry is the only thing that has
  // to wait here.
  const waitMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const write = () =>
    db
      .prepare("insert into sessions (id, title, last_activity_at) values (?, ?, ?) on conflict(id) do update set title = excluded.title")
      .run(thread, title, Math.floor(Date.now() / 1000));
  for (let attempt = 1; ; attempt += 1) {
    try {
      write();
      return true;
    } catch (e) {
      if (attempt >= 5) throw e;
      // The panel's own read of the session index is open: wait it out rather than lose the write.
      waitMs(300);
    }
  }
};
const setTitle = seedSession;

git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# sandbox repo\n");
git(repo, ["add", "."]);
git(repo, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "first"]);
const PROJECT = "sandbox-repo";

const stub = makeStub();
await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${stub.server.address().port}`;
const port = await freePort();
const configPath = path.join(configDir, "config.json");
writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      port,
      host: "127.0.0.1",
      scanRoots: [rootDir],
      refreshSeconds: 5,
      worktreeSeconds: 2,
      midSeconds: 10,
      dormantSeconds: 20,
      slowSeconds: 30,
      fetchSeconds: 3600,
      threads: 1,
      scanMode: "all",
      defaultCwd: cwdDir,
      projectsCacheFile: path.join(configDir, "logs", "projects.json"),
      apiServer: { url: stubUrl, key: "sandbox-key" },
      // Nothing here is a setting the panel needs; it is here so the sentry cannot spawn a worker of its own into
      // the sandbox repo while a phase is being measured.
      assistant: { autonomy: "draft" },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
const base = `http://127.0.0.1:${port}`;
const ledgerPath = path.join(configDir, "logs", "tree-names.json");
const jobsPath = path.join(configDir, "logs", "jobs.json");

const panelLog = [];
let panel = null;
const startPanel = async () => {
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
  // The project has to be discovered before anything can be spawned or renamed: the rename looks the tree up as a ROW.
  await waitFor(
    async () => {
      const s = await state();
      return Boolean(s.projects?.some((p) => p.name === PROJECT));
    },
    { timeoutMs: 40_000, what: "the sandbox repo to be discovered as a project" },
  );
};
const stopPanel = async () => {
  if (!panel) return;
  const p = panel;
  panel = null;
  p.kill();
  await waitFor(() => p.exitCode !== null || p.signalCode !== null, { timeoutMs: 15_000, what: "the panel to exit" });
  await sleep(400);
};
const api = async (route, body) => {
  const res = await fetch(`${base}${route}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const state = () => api("/api/state").then((r) => r.body);
const rowFor = async (treePath) => {
  const s = await state();
  return s.projects?.find((p) => p.name === PROJECT)?.worktrees?.find((w) => norm(w.path) === norm(treePath)) || null;
};
const ledger = () => {
  try {
    return JSON.parse(readFileSync(ledgerPath, "utf8"));
  } catch {
    return { trees: {} };
  }
};
const recordFor = (treePath, project = PROJECT) => ledger().trees?.[treeKey({ project, path: treePath })] || null;
// A record is written twice in a tree's life: once as a CLAIM, before the git work (so a second event cannot rename
// the same tree), and once when the rename has landed — after the tree has been scanned back in, a moment later.
// `claimedOnly` is how the two are told apart, so every read of what a record SAYS waits for the second write.
const settledRecord = async (treePath) => {
  await waitFor(
    () => {
      const r = recordFor(treePath);
      return Boolean(r) && r.claimedOnly === false;
    },
    { timeoutMs: 30_000, what: "a record that says the rename landed" },
  );
  return recordFor(treePath);
};
// The one tree of the sandbox repo whose directory name is not the project root and is not `except` — how a phase
// finds "the tree that run N got" without depending on the exact slug the panel built.
const treesExcept = (except = []) =>
  listTrees(repo).filter((t) => norm(t.path) !== norm(repo) && !except.some((e) => norm(e) === norm(t.path)));
const treeByTag = (tag, except = []) => treesExcept(except).find((t) => tagOf(t.path) === tag) || null;
// The panel offers a run's title to a tree ONCE per process (`sweepTitles` sets its per-job flag on the first emit),
// so an attempt that arrives before the tree has been scanned into the store is simply lost. Seed the title only
// once the row is there, and if it is still lost, restart the panel — which is the state a fresh process comes up in.
const rowExists = (treePath) => waitFor(async () => Boolean(await rowFor(treePath)), { timeoutMs: 40_000, what: "the tree's row to be scanned" });
const awaitAutoName = async (treePath, tag, except, { tries = 3, perTryMs = 30_000 } = {}) => {
  for (let i = 1; i <= tries; i += 1) {
    const named = await waitFor(
      async () => {
        const t = treeByTag(tag, except);
        return Boolean(t) && branchOf(t.path) === `wtgui/${baseOf(t.path)}`;
      },
      { timeoutMs: perTryMs, stepMs: 700, what: `the automatic rename (attempt ${i})` },
    );
    if (named) return true;
    await stopPanel();
    await startPanel();
  }
  return false;
};

const THREAD1 = "wtgui-sandbox-run-one";
const THREAD2 = "wtgui-sandbox-run-two";
const THREAD3 = "wtgui-sandbox-run-three";
const THREAD_HOLD = "wtgui-sandbox-hold";
const TITLE1 = "Retention sweep for the job store";

let phase = "";
try {
  // =============================================================================================
  phase = "phase 1 — run one names the tree";
  console.log(`\n== ${phase}`);
  // Only the titles of runs that must NOT name anything are seeded up front; run one's arrives once its tree is on
  // the board, so the panel's single automatic attempt has everything it needs when it comes.
  seedSession(THREAD2, "Something else entirely, asked for later");
  seedSession(THREAD_HOLD, "Hold this run open");
  await startPanel();
  note(`sandbox panel on ${base}, stub gateway on ${stubUrl}, PANEL_CONFIG ${configPath}`);

  const spawned = await api("/api/agents", {
    project: PROJECT,
    cwd: repo,
    prompt: "Set up the retention sweep for the job store",
    thread: THREAD1,
  });
  check("run one was accepted", spawned.status, 202);
  const cut = spawned.body.job?.worktreePath || null;
  ok("the panel cut a real worktree for it", Boolean(cut) && existsSync(cut), cut || "");
  const tag1 = tagOf(cut);
  ok("the cut tree carries a six-hex tag", Boolean(tag1) && /^[0-9a-f]{6}$/i.test(tag1), String(tag1));
  check("its branch is wtgui/<slug>-<tag>", branchOf(cut), `wtgui/${baseOf(cut)}`);
  const row0 = await rowExists(cut);
  ok("the tree is a row of the board before its title is offered", row0);
  seedSession(THREAD1, TITLE1);

  // The panel sweeps titles every 10s; the rename is the automatic path working on its own clock.
  const named = await awaitAutoName(cut, tag1, [cut]);
  const tree1 = treeByTag(tag1, [cut]);
  ok("run one's title named the tree (directory moved, branch with it)", named, tree1 ? `${baseOf(tree1.path)} on ${tree1.branch}` : "not renamed");
  ok("the directory is named after the session title", Boolean(tree1) && baseOf(tree1.path).includes("retention"), tree1 ? baseOf(tree1.path) : "");
  check("the six-hex tag is the one it was cut with", tagOf(tree1?.path), tag1);
  check("the branch follows the directory, still wtgui/<slug>-<tag>", tree1?.branch, `wtgui/${baseOf(tree1.path)}`);
  check("the old directory is gone", existsSync(cut), false);

  const rec1 = await settledRecord(tree1.path);
  ok("the panel wrote down who named it and when", Boolean(rec1), rec1 ? JSON.stringify(rec1) : "no record");
  ok("the record says the rename landed, not just that it was claimed", rec1?.claimedOnly === false, String(rec1?.claimedOnly));
  ok("the record carries the branch the tree ended up on", rec1?.branch === `wtgui/${baseOf(tree1.path)}`, String(rec1?.branch));
  check("the record names the run that got the tree first", String(rec1?.by || "").includes(THREAD1), true);
  ok("the record carries the tag a rename keeps", rec1?.tag === tag1, String(rec1?.tag));
  ok("the record carries a real timestamp", Number.isFinite(Date.parse(rec1?.at || "")), String(rec1?.at));
  note(`record: ${describeNaming(rec1)}`);
  // What the panel itself said about the automatic half: a rename its own guard refused is logged there, and that is
  // the only place the difference between "did not try" and "tried and was refused" is visible.
  for (const line of panelLog.filter((l) => /auto-naming/.test(l)).slice(-6)) note(`panel: ${line}`);
  note(`ledger: ${JSON.stringify(Object.values(ledger().trees || {}))}`);
  const row1Ok = await waitFor(async () => Boolean((await rowFor(tree1.path))?.named?.line), { timeoutMs: 30_000, what: "the board's row to carry the record" });
  const row1 = await rowFor(tree1.path);
  ok("the board's row carries the same record", row1Ok && String(row1?.named?.line || "").includes(THREAD1), String(row1?.named?.line || ""));

  // =============================================================================================
  phase = "phase 2 — run two into the same tree leaves the name alone";
  console.log(`\n== ${phase}`);
  const before2 = { path: tree1.path, branch: tree1.branch, at: rec1.at };
  const spawn2 = await api("/api/agents", {
    project: PROJECT,
    cwd: tree1.path,
    existing: true,
    prompt: "Carry the work on in that tree",
    thread: THREAD2,
  });
  check("run two was accepted into the tree run one named", spawn2.status, 202);
  check("and it really runs in that tree", norm(spawn2.body.job?.ownerPath || spawn2.body.job?.cwd), norm(tree1.path));
  await waitFor(async () => (await api("/api/jobs")).body.jobs?.some((j) => j.thread === THREAD2 && j.status === "done"), {
    timeoutMs: 30_000,
    what: "run two to finish",
  });
  // Two full sweeps after it finished: the second run has a title of its own, and that is what used to churn the name.
  await sleep(12_000);
  const after2 = treesExcept().find((t) => tagOf(t.path) === tag1) || null;
  check("the directory is where it was", norm(after2?.path), norm(before2.path));
  check("the branch is the same branch", after2?.branch, before2.branch);
  check("the record still names run one, and still says when", (await settledRecord(after2.path))?.at, before2.at);
  check("no second tree appeared", treesExcept().length, 1);

  // =============================================================================================
  phase = "phase 2b — the churn case: a second automatic attempt for the same tree";
  console.log(`\n== ${phase}`);
  note("the tree's run now has a DIFFERENT title in the session store, and the panel is restarted: a fresh process,");
  note("no in-memory per-job flags, and the title cache is gone — so the sweeper reads the new title and tries again.");
  setTitle(THREAD1, "Reconcile every branch that main does not have");
  await stopPanel();
  await startPanel();
  const persisted = JSON.parse(readFileSync(jobsPath, "utf8")).jobs.find((j) => j.thread === THREAD1) || null;
  check("the restarted panel still aims that run at the same tree", norm(persisted?.worktreePath), norm(tree1.path));

  // The positive control, in the same window: a tree nobody has named yet, whose run's title the same sweeper
  // renames. Without it, "the tree is untouched" could just mean the sweeper never fired.
  const spawn3 = await api("/api/agents", {
    project: PROJECT,
    cwd: repo,
    prompt: "Land the retention sweep on main",
    thread: THREAD3,
  });
  check("the control run was accepted", spawn3.status, 202);
  const cut3 = spawn3.body.job?.worktreePath || null;
  const tag3 = tagOf(cut3);
  ok("the control run got a tree of its own", Boolean(cut3) && existsSync(cut3), cut3 || "");
  const row3 = await rowExists(cut3);
  ok("the control tree is on the board before its title is offered", row3);
  seedSession(THREAD3, "Land the retention sweep on main");
  const controlRenamed = await awaitAutoName(cut3, tag3, [cut3]);
  ok("the control tree WAS renamed by the same sweeper in the same window", controlRenamed);
  const tree1Again = treeByTag(tag1, [cut3]) || null;
  check("while the already-named tree is where it was", norm(tree1Again?.path), norm(tree1.path));
  check("with the same branch", tree1Again?.branch, tree1.branch);
  check("and the same record — same namer, same moment", [(await settledRecord(tree1.path))?.by?.includes(THREAD1), (await settledRecord(tree1.path))?.at], [true, rec1.at]);
  note("the old guard (an in-memory Set of paths) could not refuse this: the first rename moved the directory it was");
  note("keyed on, so the next event of the same run saw a new key. Said from reading that code, not re-run here.");

  // =============================================================================================
  phase = "phase 3 — the 409 while an agent is running in the tree";
  console.log(`\n== ${phase}`);
  stub.state.hold = true;
  const held = await api("/api/agents", { project: PROJECT, cwd: tree1.path, existing: true, prompt: "hold this open", thread: THREAD_HOLD });
  check("a run was started in the tree and is being held live", held.status, 202);
  const running = await waitFor(
    async () => (await api("/api/jobs")).body.jobs?.some((j) => j.thread === THREAD_HOLD && j.status === "running"),
    { timeoutMs: 30_000, what: "the held run to be running" },
  );
  ok("the panel sees it running in the tree", running);
  const refused = await api("/api/worktree/rename", { project: PROJECT, path: tree1.path, name: "this must not land", by: "verify" });
  check("renaming a tree with an agent in it is refused", refused.status, 409);
  ok("with the same reason as before", /an agent is running in that worktree/.test(String(refused.body.error || "")), String(refused.body.error || ""));
  check("and nothing moved", norm(treeByTag(tag1, [cut3])?.path), norm(tree1.path));
  stub.state.hold = false;
  stub.finishAll();
  await waitFor(async () => (await api("/api/jobs")).body.jobs?.some((j) => j.thread === THREAD_HOLD && j.status === "done"), {
    timeoutMs: 30_000,
    what: "the held run to be released",
  });

  // =============================================================================================
  phase = "phase 4 — the ✦ button: a name read from the work";
  console.log(`\n== ${phase}`);
  const work = commit(tree1.path, { "lib/retention.js": "export const sweep = () => {};\n" }, "stub the retention seams in the job store");
  const work2 = commit(tree1.path, { "lib/scheduler.js": "// sweep wired in\nexport const tick = () => {};\n" }, "wire the retention sweep into the scheduler");
  const work3 = commit(tree1.path, { "tools/verify-retention.mjs": "// restart\n" }, "test the sweep across a panel restart");
  check("the tree has three commits describing its work", [work, work2, work3], [true, true, true]);
  check("its branch is three ahead of main", git(repo, ["rev-list", "--count", `main..${tree1.branch}`]).out, "3");

  const read = await readWorktreeWork({ dir: tree1.path, base: "main" });
  check("the module reads the branch's own commits", read.commits.length, 3);
  check("and the diff against main", read.files.map((f) => f.path).sort(), ["lib/retention.js", "lib/scheduler.js", "tools/verify-retention.mjs"]);
  const pure = nameFromWork({ commits: read.commits, files: read.files });
  ok("the name comes from the commits, not from the old name", pure.source === "commits" && /retention|sweep|seams/.test(pure.name), pure.name);
  check("a slug is at most 40 characters and never cut mid-word", slugWords(["a".repeat(50)]) , "a".repeat(40));

  const suggested = await api("/api/worktree/suggest-name", { project: PROJECT, path: tree1.path });
  check("the suggestion answered", suggested.status, 200);
  const sug = suggested.body;
  ok("it offers a name", Boolean(sug.name) && /^[a-z0-9-]+$/.test(sug.name), String(sug.name));
  ok("built from this branch's work", /retention/.test(String(sug.name)), `${sug.name} (from “${sug.frame}”)`);
  check("it read three commits against main", sug.evidence?.ahead, 3);
  check("and names the files it read", (sug.evidence?.files || []).length, 3);
  ok("it says where the name came from", /commits/.test(String(sug.why)), String(sug.why || ""));
  check("the offered directory name keeps the tag", sug.dirName, `${sug.name}-${tag1}`);
  check("the offered branch keeps it too", `wtgui/${sug.dirName}`, `wtgui/${sug.name}-${tag1}`);
  // The whole point of the button being deliberate: reading the work renames NOTHING.
  check("asking renamed nothing — the directory is where it was", norm(treeByTag(tag1, [cut3])?.path), norm(tree1.path));
  check("asking renamed nothing — the branch is the same", branchOf(tree1.path), tree1.branch);
  check("and the record still names run one", (await settledRecord(tree1.path))?.by?.includes(THREAD1), true);

  const recBefore = await settledRecord(tree1.path);
  const renamed = await api("/api/worktree/rename", {
    project: PROJECT,
    path: tree1.path,
    name: sug.dirName,
    by: "the reader (✦ from the work)",
    how: `named from the work: ${sug.why}`,
  });
  check("answering the question renames it", renamed.status, 200);
  const treeNamed = treeByTag(tag1, [cut3]) || null;
  check("the directory takes the name read from the work", baseOf(treeNamed?.path || ""), sug.dirName);
  check("the branch takes it too", treeNamed?.branch, `wtgui/${sug.dirName}`);
  check("the six-hex tag is still the one it was cut with", tagOf(treeNamed?.path), tag1);
  check("the old directory is gone", existsSync(tree1.path), false);
  const recAfter = await settledRecord(treeNamed.path);
  ok("the record now names the reader", /reader/.test(String(recAfter?.by || "")), describeNaming(recAfter));
  ok("and when — after the run that had it before", Date.parse(recAfter?.at || "") >= Date.parse(recBefore?.at || ""), `${recBefore?.at} → ${recAfter?.at}`);
  ok("with the work it was read from on the record", /commits/.test(String(recAfter?.how || "")), String(recAfter?.how || ""));
  const rowOk = await waitFor(async () => Boolean((await rowFor(treeNamed.path))?.named?.by), { timeoutMs: 30_000, what: "the board's row to carry the reader's record" });
  const namedRow = await rowFor(treeNamed.path);
  ok("the board's row says so too", rowOk && String(namedRow?.named?.by) === "the reader (✦ from the work)", String(namedRow?.named?.by || ""));

  // Renaming once: the same request again is a no-op, not a second slug, and not a second record.
  const again = await api("/api/worktree/rename", { project: PROJECT, path: treeNamed.path, name: sug.dirName, by: "the reader (✦ from the work)" });
  check("asking for the same name again changes nothing", [again.status, again.body.unchanged], [200, true]);
  check("the tag is still kept", tagOf(treeByTag(tag1, [cut3])?.path), tag1);
  check("exactly one tree, one branch, one name", [treesExcept().length, treeByTag(tag1, [cut3])?.branch], [2, `wtgui/${sug.dirName}`]);
  const strays = treesExcept()
    .filter((t) => t.branch !== `wtgui/${baseOf(t.path)}`)
    .map((t) => `${baseOf(t.path)} on ${t.branch}`);
  ok("every tree of the sandbox is on its own wtgui/<dir-name> branch", strays.length === 0, strays.join(" · "));

  // And the name the reader chose is as final as any other: the automatic half cannot take it away.
  setTitle(THREAD1, "Something the panel must not act on");
  await stopPanel();
  await startPanel();
  await sleep(13_000);
  check("a restarted panel with a fresh title still leaves the reader's name alone", norm(treeByTag(tag1, [cut3])?.path), norm(treeNamed.path));
  check("and the record is still the reader's", (await settledRecord(treeNamed.path))?.by, "the reader (✦ from the work)");

  // =============================================================================================
  phase = "phase 5 — the two halves are still two, and the ledger is the only thing that separates them";
  console.log(`\n== ${phase}`);
  const refusedUnknown = await api("/api/worktree/suggest-name", { project: PROJECT, path: path.join(repo, "not-a-worktree") });
  check("a path that is not a row of the project is refused", refusedUnknown.status, 404);
  const ownCheckout = await api("/api/worktree/suggest-name", { project: PROJECT, path: repo });
  check("the project's own checkout is never nameable", ownCheckout.status, 400);
  const unknownProject = await api("/api/worktree/suggest-name", { project: "no-such-project", path: repo });
  check("an unknown project is refused", unknownProject.status, 404);
  check("the ledger has one record per tree it has named", Object.keys(ledger().trees || {}).length, 2);
  ok("each of them names who and when", Object.values(ledger().trees || {}).every((r) => r.by && r.at && r.tag), JSON.stringify(Object.values(ledger().trees || {}).map((r) => r.by)));
} catch (err) {
  failures += 1;
  console.log(`FAIL  ${phase}: ${String((err && err.stack) || err)}`);
  if (panelLog.length) console.log(`      panel log tail:\n${panelLog.slice(-20).map((l) => `      ${l}`).join("\n")}`);
} finally {
  await stopPanel().catch(() => {});
  await stub.close().catch(() => {});
  db.close();
  if (process.env.VERIFY_KEEP) console.log(`\n      sandbox kept: ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${checks} checks, ${failures} failed.`);
console.log("driven end to end in a sandbox of its own (own port, own PANEL_CONFIG, own HERMES_HOME, stub gateway).");
console.log("the browser half (the ✦ button and its confirm box in public/app.js) and the counterfactual about the old");
console.log("in-memory guard are the two parts this script states from inspection rather than driving — see the header.");
console.log(failures ? `RESULT: ${failures} FAILED` : "RESULT: ALL PASS");
process.exit(failures ? 1 : 0);
