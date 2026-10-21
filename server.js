// Static + JSON + SSE server for the worktree monitor, plus Stage-1 agent spawning.
// The HTTP layer never runs git: the scheduler scans in worker threads and the
// store holds the results. Spawned agents go through lib/jobs.js.
import { createServer } from "node:http";
import { gzipSync as zlibGzipSync } from "node:zlib";
import { readFile, stat } from "node:fs/promises";
import { cpus } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "./lib/pool.js";
import { Store } from "./lib/store.js";
import { Scheduler } from "./lib/scheduler.js";
import { ProjectRegistry } from "./lib/projects.js";
import { Jobs, keyStatus, makeThreadName } from "./lib/jobs.js";
import { gitIn } from "./lib/scan.js";
import { auditRepo } from "./lib/hermes-worktrees.js";
import { Approvals } from "./lib/approvals.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "public");
// PANEL_CONFIG lets a second instance run from the same code with its own config and port —
// a sandbox or a demo you can click around in without touching the real one:
//   set PANEL_CONFIG=C:\path\to\panel-config.json && node server.js
const CONFIG_PATH = process.env.PANEL_CONFIG ? path.resolve(process.env.PANEL_CONFIG) : path.join(HERE, "config.json");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function loadConfig() {
  // A fresh clone may have no config.json yet: start on defaults and say so, rather than dying.
  let cfg;
  try {
    cfg = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch (e) {
    log(`no readable config.json (${String((e && e.message) || e)}) — using defaults`);
    // Default to the folder the panel itself sits in, so a bare clone is immediately useful.
    cfg = { scanRoots: [path.dirname(HERE)] };
  }
  cfg.port = Number(cfg.port) || 7331;
  // Loopback by default. This panel can now spawn agents, so binding it to the LAN
  // would be unauthenticated remote code execution.
  cfg.host = cfg.host || "127.0.0.1";
  cfg.refreshSeconds = Number(cfg.refreshSeconds ?? 30);
  cfg.worktreeSeconds = Number(cfg.worktreeSeconds ?? 5);
  cfg.midSeconds = Number(cfg.midSeconds ?? 30);
  cfg.dormantSeconds = Number(cfg.dormantSeconds ?? 60);
  cfg.slowSeconds = Number(cfg.slowSeconds ?? 60);
  cfg.fetchSeconds = Number(cfg.fetchSeconds ?? 600);
  cfg.threads = Number(cfg.threads) || Math.max(1, Math.min(4, cpus().length - 1));
  cfg.projects = Array.isArray(cfg.projects) ? cfg.projects : [];
  if (!cfg.defaultCwd) cfg.defaultCwd = cfg.projects[0]?.path || process.cwd();
  // Keyed off the config's own directory, so a PANEL_CONFIG sandbox keeps its own registry.
  if (!cfg.jobsFile) cfg.jobsFile = path.join(path.dirname(CONFIG_PATH), "logs", "jobs.json");
  return cfg;
}

const gzip = (buf) => zlibGzipSync(buf, { level: 6 });

function acceptsGzip(req) {
  return /\bgzip\b/.test(String((req && req.headers["accept-encoding"]) || ""));
}

function sendJson(res, code, body) {
  const req = res.req;
  const text = JSON.stringify(body);
  const raw = Buffer.from(text);
  const head = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Vary: "Accept-Encoding" };
  // /api/state is half a megabyte of JSON and the page asks for it periodically; gzip costs a few
  // ms of CPU and removes ~90% of the bytes and most of the client's parse time.
  if (raw.length > 2048 && acceptsGzip(req)) {
    const gz = gzip(raw);
    res.writeHead(code, { ...head, "Content-Encoding": "gzip", "Content-Length": gz.length });
    return res.end(gz);
  }
  res.writeHead(code, { ...head, "Content-Length": raw.length });
  res.end(raw);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (d) => {
      size += d.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error(`invalid JSON body: ${e.message}`));
      }
    });
    req.on("error", reject);
  });
}

// `hermes -w` branches from HEAD, so a repo with no commits cannot host a worktree. Refuse
// with a reason up front instead of letting the spawn die inside the CLI.
async function spawnBlocker(cwd, target) {
  if (target?.empty) {
    return `${target.name} has no commits yet (unborn HEAD), so hermes -w cannot create a worktree there — make an initial commit first.`;
  }
  const head = await gitIn(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], 15000);
  if (head.ok) return null;
  const err = String(head.err || head.out || "");
  if (/not a git repository/i.test(err)) return `${cwd} is not a git repository — hermes -w needs one.`;
  return `${cwd} has no commits yet (unborn HEAD), so hermes -w cannot create a worktree there — make an initial commit first.`;
}

let config = await loadConfig();
let pool = new Pool(config.threads);
const store = new Store();
const registry = new ProjectRegistry({
  getConfig: () => config,
  store,
  onLog: log,
  // Last successful sweep, so a restart opens on the board it had instead of "no git repos found".
  cacheFile: config.projectsCacheFile || path.join("logs", "projects.json"),
});
let scheduler = new Scheduler({
  config,
  store,
  pool,
  registry,
  getProjects: () => registry.projects,
  panelAgents: () => jobs.agentPaths(),
});

const clients = new Set();

function broadcast(evt) {
  const frame = `event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}

store.onEvent(broadcast);

// A `-w` agent's worktree exists a few seconds after spawn; adopt it into the board right then so the
// card can be opened under a row instead of waiting for a discovery pass.
const adoptedTrees = new Set();
function adoptFromJob(evt) {
  if (evt?.type !== "job") return;
  const j = evt.job;
  if (!j || !j.worktreePath || adoptedTrees.has(j.worktreePath)) return;
  adoptedTrees.add(j.worktreePath);
  const project = registry.projects.find((p) => normPathKey(p.path) === normPathKey(j.cwd));
  if (!project) return;
  void scheduler.adoptWorktree(project.name, j.worktreePath).catch(() => {});
}
const jobs = new Jobs({
  config,
  onEvent: (evt) => {
    broadcast(evt);
    adoptFromJob(evt);
  },
  onLog: log,
});
// Human side of the Hermes approval-transport contract: the plugin presents, the panel answers,
// the host decides. Nothing here can approve anything by itself.
const approvals = new Approvals({ onEvent: broadcast });

const settingsOut = () => ({
  refreshSeconds: config.refreshSeconds,
  worktreeSeconds: config.worktreeSeconds,
  midSeconds: config.midSeconds,
  dormantSeconds: config.dormantSeconds,
  liveSeconds: config.liveSeconds,
  slowSeconds: config.slowSeconds,
  fetchSeconds: config.fetchSeconds,
  liveMinutes: config.liveMinutes ?? 5,
  threads: config.threads,
  host: config.host,
  defaultCwd: config.defaultCwd,
  worktreeSource: String(config.discovery?.worktreeSource || "git").toLowerCase(),
  spawnEnabled: true,
});

const normPathKey = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// Rows are written by the scheduler, so their copy of the panel-agent state is as old as that
// row's last scan (45-90s on a big fleet). Overlay it at snapshot time: a turn starting or
// finishing is known here immediately, and the row must not keep claiming "done" meanwhile.
function withLiveAgents(snap) {
  const agents = jobs.agentPaths();
  if (!agents.size) return snap;
  for (const project of snap.projects || []) {
    for (const row of project.worktrees || []) {
      const mine = agents.get(normPathKey(row.path));
      if (!mine) continue;
      row.panelAgent = mine;
      row.signals = { ...(row.signals || {}), panel: { on: mine.running > 0, running: mine.running, total: mine.total, threads: mine.threads } };
      // The stored row may already name this reason from its last scan; replace it, never stack it.
      const base = String(row.liveWhy || "").replace(/panel-agent\(\d+\)/g, "").trim();
      if (mine.running > 0) {
        row.live = true;
        row.lastAliveAt = new Date().toISOString();
        row.liveWhy = `${base ? `${base} ` : ""}panel-agent(${mine.running})`;
      } else {
        // A turn just finished. The row the scan wrote may still say live because the agent WAS
        // running then; drop that reason now and let the other signals decide.
        const s = row.signals || {};
        const other = Boolean(s.hermes?.on || s.board?.on || s.ports?.on || s.files?.on);
        if (!other) {
          row.live = false;
          row.liveWhy = base || "no session, board entry, port or file edit";
        } else {
          row.liveWhy = base;
        }
      }
    }
  }
  return snap;
}

function snapshot() {
  return withLiveAgents({
    ...store.snapshot({ settings: settingsOut() }),
    jobs: jobs.list(),
    approvals: approvals.list(),
    skipped: registry.skipped,
    scanRoots: config.scanRoots || [],
    spawn: {
      binary: jobs.binary,
      key: keyStatus(),
      defaultCwd: config.defaultCwd,
      maxRuntimeSeconds: jobs.maxRuntimeSeconds,
      projects: registry.projects.map((p) => ({ name: p.name, path: p.path, activityAt: p.activityAt || null, empty: Boolean(p.empty) })),
    },
  });
}

const heartbeat = setInterval(() => {
  const payload = { at: new Date().toISOString(), stats: scheduler.stats, pool: { inFlight: pool.inFlight, queued: pool.queued } };
  for (const res of clients) {
    try {
      res.write(`event: heartbeat\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      clients.delete(res);
    }
  }
}, 5000);

function handleStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
  clients.add(res);
  log(`client connected (${clients.size} streaming)`);
  req.on("close", () => {
    clients.delete(res);
    log(`client disconnected (${clients.size} streaming)`);
  });
}

function authorised(req) {
  if (!config.token) return true;
  return req.headers["x-panel-token"] === config.token;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const route = url.pathname;
  try {
    if (route === "/api/health") {
      return sendJson(res, 200, { ok: true, host: config.host, projects: registry.projects.map((p) => p.name), settings: settingsOut(), clients: clients.size });
    }

    if (route === "/api/config") {
      return sendJson(res, 200, {
        ...settingsOut(),
        scanRoots: config.scanRoots || [],
        projects: registry.projects.map((p) => ({ name: p.name, path: p.path, remote: p.remote, mainBranch: p.mainBranch, activityAt: p.activityAt || null })),
      });
    }

    if (route === "/api/state" || route === "/api/audit") {
      return sendJson(res, 200, snapshot());
    }

    // On-demand cleanup audit for ONE project, straight from `hermes worktree list --json`:
    // linked trees, externally-registered trees (with locked/missing), and a keep/reap verdict
    // with a reason for every local branch. ~6s per repo, so it is never polled — the UI (or a
    // script) asks for one project when it wants the detail /api/state deliberately omits.
    if (route === "/api/cleanup" && req.method === "GET") {
      const name = url.searchParams.get("project");
      const target = registry.projects.find((p) => p.name === name) || null;
      if (!target) return sendJson(res, 404, { error: `unknown project: ${name || "(none)"}` });
      const t0 = Date.now();
      try {
        const audit = await auditRepo(target.path, { config, force: url.searchParams.get("fresh") === "1" });
        return sendJson(res, 200, { project: target.name, path: target.path, tookMs: Date.now() - t0, ...audit });
      } catch (e) {
        return sendJson(res, 502, { project: target.name, path: target.path, tookMs: Date.now() - t0, error: String((e && e.message) || e) });
      }
    }

    if (route === "/api/stats") {
      return sendJson(res, 200, {
        scheduler: scheduler.stats,
        pool: { size: pool.size, inFlight: pool.inFlight, queued: pool.queued, completed: pool.completed },
        store: store.stats,
        jobs: { total: jobs.jobs.size, running: jobs.list().filter((j) => j.status === "running").length },
        clients: clients.size,
      });
    }

    if (route === "/api/jobs" && req.method === "GET") {
      return sendJson(res, 200, { jobs: jobs.list(), binary: jobs.binary, key: keyStatus(), defaultCwd: config.defaultCwd });
    }

    // ---- approvals: the human side of the Hermes approval-transport contract ---------------
    // The plugin (~/.hermes/plugins/worktree-panel) presents a redacted request here and polls
    // GET /api/approvals/<id>; the panel only records the human's choice. Policy, timeout and
    // fail-closed enforcement stay in Hermes.
    if (route === "/api/approvals" && req.method === "GET") {
      return sendJson(res, 200, { pending: approvals.list() });
    }

    if (route === "/api/approvals" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        const request = approvals.present(body || {});
        log(`approval requested (${request.id}): ${request.command.slice(0, 90)}`);
        return sendJson(res, 202, { ok: true, id: request.id, allowed: request.allowed, timeoutSeconds: request.timeoutSeconds });
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e) });
      }
    }

    if (route === "/api/approvals/answer" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const r = approvals.answer(body.id, body.choice, body.by || "ui");
      return sendJson(res, r.ok ? 200 : 409, r);
    }

    if (route.startsWith("/api/approvals/") && req.method === "GET") {
      const id = decodeURIComponent(route.slice("/api/approvals/".length));
      return sendJson(res, 200, approvals.status(id));
    }

    // Preview the exact command that would run — the confirm affordance.
    if (route === "/api/agents/preview" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const { buildArgv } = await import("./lib/jobs.js");
      const target = body?.project ? registry.projects.find((p) => p.name === body.project) : null;
      const cwd = body?.cwd || target?.path || config.defaultCwd;
      const blocked = await spawnBlocker(cwd, target);
      // The thread name carries a random suffix, so the preview shows its shape.
      const argv = buildArgv({ ...(body || {}), thread: makeThreadName(body?.prompt || "") });
      return sendJson(res, 200, { binary: jobs.binary, argv, cwd, project: target?.name || null, blocked, command: `${jobs.binary} ${argv.join(" ")}` });
    }

    if (route === "/api/agents" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      if (body.dryRun) {
        const { buildArgv } = await import("./lib/jobs.js");
        const argv = buildArgv(body);
        return sendJson(res, 200, { dryRun: true, binary: jobs.binary, argv, cwd: body.cwd || config.defaultCwd, command: `${jobs.binary} ${argv.join(" ")}` });
      }
      const target = body.project ? registry.projects.find((p) => p.name === body.project) : null;
      if (body.project && !target) return sendJson(res, 400, { error: `unknown project: ${body.project}` });
      const cwd = body.cwd || target?.path || config.defaultCwd;
      // "existing": run in a directory that is already there (a worktree you picked), so no
      // worktree is created and the agent's edits land directly in that tree.
      const existing = Boolean(body.existing);
      if (existing) {
        try {
          if (!(await stat(cwd)).isDirectory()) return sendJson(res, 400, { error: `${cwd} is not a directory` });
        } catch {
          return sendJson(res, 400, { error: `${cwd} does not exist` });
        }
      }
      const blocked = await spawnBlocker(cwd, existing ? null : target);
      if (blocked) return sendJson(res, 400, { error: blocked, blocked });
      // Attach to the worktree the spawn actually runs in, not to the directory that was typed: a cwd
      // inside `…/lib` is still the same worktree, and an owner path matching no row would show up as
      // unattached even though it is sitting in a tree we know.
      let ownerPath = null;
      if (existing) {
        const top = await gitIn(cwd, ["rev-parse", "--show-toplevel"]);
        ownerPath = top.ok && top.out ? top.out : cwd;
      }
      const job = await jobs.create({ ...body, cwd, existing, ownerPath, ownerPending: !existing });
      return sendJson(res, 202, { job });
    }

    // Continue a conversation: same named thread, no new worktree, run where the agent is.
    if (route === "/api/agents/reply" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const text = String(body.text || "").trim();
      if (!text) return sendJson(res, 400, { error: "reply text is required" });
      const first = jobs.firstOfThread(String(body.thread || ""));
      if (!first) return sendJson(res, 404, { error: `unknown thread: ${body.thread}` });

      // Run where the agent actually is: its worktree while that still exists, otherwise the
      // project it was started from — Hermes must not cd into a directory cleanup removed.
      let dir = first.cwd || config.defaultCwd;
      if (first.worktreePath) {
        try {
          if ((await stat(first.worktreePath)).isDirectory()) dir = first.worktreePath;
        } catch {
          /* gone: fall back to the project */
        }
      }
      const job = await jobs.create({
        prompt: text,
        thread: first.thread,
        reply: true,
        resumeDir: dir,
        cwd: dir,
        model: body.model ?? first.model,
        budget: body.budget ?? first.budget ?? 1800,
        maxTurns: body.maxTurns ?? first.maxTurns,
        yolo: body.yolo ?? first.yolo,
        // A reply continues the SAME agent, so it keeps the tree that agent was created for.
        ownerPath: first.ownerPath || null,
      });
      return sendJson(res, 202, { job });
    }

    if (route === "/api/jobs/cancel" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      return sendJson(res, 200, { ok: jobs.cancel(String(body.id || "")) });
    }

    if (route === "/api/jobs/attach" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const thread = String(body.thread || "").trim();
      const target = String(body.path || "").trim();
      if (!thread) return sendJson(res, 400, { error: "thread is required" });
      if (!jobs.firstOfThread(thread)) return sendJson(res, 404, { error: `unknown thread: ${thread}` });
      // detach: the agent goes back to the unattached workspace.
      if (body.detach === true || !target) {
        const r = jobs.setOwner(thread, null);
        broadcast({ type: "jobs", jobs: jobs.list() });
        return sendJson(res, 200, { ok: true, ownerPath: null, turns: r.turns, jobs: jobs.list() });
      }
      try {
        if (!(await stat(target)).isDirectory()) return sendJson(res, 400, { error: `${target} is not a directory` });
      } catch {
        return sendJson(res, 400, { error: `${target} does not exist` });
      }
      // Only a real worktree can own an agent, and only at its root — a subdirectory or a plain
      // folder would file the agent somewhere no row can ever show.
      const isWt = await gitIn(target, ["rev-parse", "--is-inside-work-tree"]);
      const top = await gitIn(target, ["rev-parse", "--show-toplevel"]);
      const normTarget = path.resolve(target).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      const normTop = String(top.out || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      if (!isWt.ok || isWt.out !== "true" || normTop !== normTarget) {
        return sendJson(res, 400, { error: `${target} is not the root of a git worktree` });
      }
      const r = jobs.setOwner(thread, target);
      broadcast({ type: "jobs", jobs: jobs.list() });
      return sendJson(res, 200, { ok: true, ownerPath: r.ownerPath, turns: r.turns, jobs: jobs.list() });
    }

    if (route === "/api/jobs/label" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const thread = String(body.thread || "").trim();
      if (!thread) return sendJson(res, 400, { error: "thread is required" });
      if (!jobs.firstOfThread(thread)) return sendJson(res, 404, { error: `unknown thread: ${thread}` });
      // A panel-side display name only. The Hermes thread id stays the identity (it is what resumes
      // the session), so renaming can never orphan a conversation.
      const label = jobs.setLabel(thread, body.label);
      if (!label.ok) return sendJson(res, 400, { error: label.error });
      return sendJson(res, 200, { ok: true, thread, label: label.label, jobs: jobs.list() });
    }

    if (route === "/api/jobs/clear" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const thread = String(body.thread || "").trim();
      if (thread) {
        // Forget one conversation only. Refused while it is working: cancelling is a deliberate,
        // separate action, and a "clear" that silently killed a turn would be a trap.
        const r = jobs.clearThread(thread);
        if (!r.ok) {
          return sendJson(res, 409, { error: `a turn is still running in this agent — cancel it first`, running: r.running });
        }
        broadcast({ type: "jobs", jobs: jobs.list() });
        return sendJson(res, 200, { ok: true, removed: r.removed, jobs: jobs.list() });
      }
      jobs.clearFinished();
      broadcast({ type: "jobs", jobs: jobs.list() });
      return sendJson(res, 200, { ok: true, jobs: jobs.list() });
    }

    if (route === "/api/refresh" && req.method === "POST") {
      await scheduler.fastPass();
      return sendJson(res, 200, { ok: true });
    }

    // Clone a GitHub repo over SSH into ONE of the configured scan roots — what the folder
    // accordion's "+" uses: the root is the folder you clicked, the name is the repo
    // (`name` or `owner/name`). The destination is inside that root and must not exist yet.
    // Responds as soon as git finishes; discovery picks the new repo up on the next pass (the
    // refresh below is deliberately not awaited — probing 94 repos would stall the response).
    if (route === "/api/clone" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
      const rootNorm = norm(body.root);
      const roots = (config.scanRoots || []).map(norm).filter(Boolean);
      if (!rootNorm || !roots.some((r) => r.toLowerCase() === rootNorm.toLowerCase())) {
        return sendJson(res, 400, { error: `root must be one of scanRoots: ${rootNorm || "(none)"}` });
      }
      // Only a plain repo name, optionally prefixed by an owner: no paths, no `..`, no URLs.
      const m = /^(?:([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/)?([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(String(body.name || "").trim());
      if (!m) return sendJson(res, 400, { error: `not a repo name: ${String(body.name || "").trim()}` });
      const owner = m[1] || String(config.cloneOwner || "JLRoper");
      const repo = m[2];
      const url = `git@github.com:${owner}/${repo}.git`;
      const dest = path.join(rootNorm, repo);
      try {
        await stat(dest);
        return sendJson(res, 409, { error: `${dest} already exists`, dest });
      } catch {
        /* good: nothing there yet */
      }
      const t0 = Date.now();
      const r = await gitIn(rootNorm, ["clone", "--no-single-branch", url, dest], 300000);
      if (!r.ok) {
        return sendJson(res, 502, { error: String(r.err || r.out || "git clone failed").split("\n").slice(-4).join(" "), url, dest, tookMs: Date.now() - t0 });
      }
      log(`cloned ${url} -> ${dest} (${Date.now() - t0}ms)`);
      void registry
        .refresh()
        .then(() => broadcast({ type: "snapshot", data: snapshot() }))
        .catch(() => {});
      return sendJson(res, 200, { ok: true, url, dest, tookMs: Date.now() - t0 });
    }

    if (route === "/api/fetch" && req.method === "POST") {
      for (const p of registry.projects) await scheduler.maybeFetch(p, true);
      await scheduler.fullPass({ discover: true });
      return sendJson(res, 200, { ok: true });
    }

    if (route === "/api/reload" && req.method === "POST") {
      config = await loadConfig();
      scheduler.stop();
      pool.close();
      pool = new Pool(config.threads);
      scheduler = new Scheduler({ config, store, pool, registry, getProjects: () => registry.projects, panelAgents: () => jobs.agentPaths() });
      await registry.refresh();
      await scheduler.start();
      broadcast({ type: "snapshot", data: snapshot() });
      return sendJson(res, 200, { ok: true, projects: config.projects.map((p) => p.name) });
    }

    if (route === "/api/stream") return handleStream(req, res);

    const rel = route === "/" ? "index.html" : route.replace(/^\/+/, "");
    const filePath = path.join(PUBLIC_DIR, rel);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    try {
      const body = await readFile(filePath);
      const type = TYPES[path.extname(filePath)] || "application/octet-stream";
      const head = { "Content-Type": type, "Cache-Control": "no-store", Vary: "Accept-Encoding" };
      // app.js is ~80KB of text the client parses on every load; gzip is free at this size.
      if (body.length > 2048 && /^(text\/|application\/(javascript|json))/.test(type) && acceptsGzip(req)) {
        const gz = gzip(body);
        res.writeHead(200, { ...head, "Content-Encoding": "gzip", "Content-Length": gz.length });
        return res.end(gz);
      }
      res.writeHead(200, { ...head, "Content-Length": body.length });
      res.end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
    }
  } catch (e) {
    sendJson(res, 400, { error: String((e && e.message) || e) });
  }
});

server.listen(config.port, config.host, () => {
  log(`agent-worktree-gui on http://${config.host}:${config.port}`);
  log(`projects: ${config.projects.map((p) => p.name).join(", ") || "(none)"} | threads: ${config.threads} | fast ${config.worktreeSeconds}s / full ${config.slowSeconds}s`);
  log(`agent spawn: ${jobs.binary} (cwd ${config.defaultCwd}) | key: ${keyStatus().fromEnv ? "env" : keyCacheHint()}`);
});

function keyCacheHint() {
  return "registry lookup on first spawn";
}

// Seed the store from the last known project list BEFORE anything slow. A restart used to answer
// `/api/state` with zero projects for the ~25s its first sweep takes, which the page renders as
// "No git repos found under scanRoots" — the board vanished and came back a minute later.
for (const p of registry.projects) store.ensureProject(p);
if (!config.defaultCwd) config.defaultCwd = registry.projects[0]?.path || process.cwd();
await scheduler.start();
// The sweep that finds repos created since the last run is not a boot dependency: it runs behind the
// first scan pass, and new projects simply appear when it lands.
void registry.refresh().catch((e) => log(`project discovery failed: ${String((e && e.message) || e)}`));

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log("shutting down");
    scheduler.stop();
    clearInterval(heartbeat);
    pool.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  });
}
