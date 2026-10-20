// Static + JSON + SSE server for the worktree monitor, plus Stage-1 agent spawning.
// The HTTP layer never runs git: the scheduler scans in worker threads and the
// store holds the results. Spawned agents go through lib/jobs.js.
import { createServer } from "node:http";
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
  cfg.slowSeconds = Number(cfg.slowSeconds ?? 60);
  cfg.fetchSeconds = Number(cfg.fetchSeconds ?? 600);
  cfg.threads = Number(cfg.threads) || Math.max(1, Math.min(4, cpus().length - 1));
  cfg.projects = Array.isArray(cfg.projects) ? cfg.projects : [];
  if (!cfg.defaultCwd) cfg.defaultCwd = cfg.projects[0]?.path || process.cwd();
  return cfg;
}

function sendJson(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
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
const registry = new ProjectRegistry({ getConfig: () => config, store, onLog: log });
let scheduler = new Scheduler({ config, store, pool, registry, getProjects: () => registry.projects });

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

const jobs = new Jobs({ config, onEvent: broadcast, onLog: log });

const settingsOut = () => ({
  refreshSeconds: config.refreshSeconds,
  worktreeSeconds: config.worktreeSeconds,
  slowSeconds: config.slowSeconds,
  fetchSeconds: config.fetchSeconds,
  liveMinutes: config.liveMinutes ?? 5,
  threads: config.threads,
  host: config.host,
  defaultCwd: config.defaultCwd,
  spawnEnabled: true,
});

function snapshot() {
  return {
    ...store.snapshot({ settings: settingsOut() }),
    jobs: jobs.list(),
    skipped: registry.skipped,
    scanRoots: config.scanRoots || [],
    spawn: {
      binary: jobs.binary,
      key: keyStatus(),
      defaultCwd: config.defaultCwd,
      maxRuntimeSeconds: jobs.maxRuntimeSeconds,
      projects: registry.projects.map((p) => ({ name: p.name, path: p.path, activityAt: p.activityAt || null, empty: Boolean(p.empty) })),
    },
  };
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
      const job = await jobs.create({ ...body, cwd, existing });
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
      });
      return sendJson(res, 202, { job });
    }

    if (route === "/api/jobs/cancel" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      return sendJson(res, 200, { ok: jobs.cancel(String(body.id || "")) });
    }

    if (route === "/api/jobs/clear" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      jobs.clearFinished();
      broadcast({ type: "jobs", jobs: jobs.list() });
      return sendJson(res, 200, { ok: true, jobs: jobs.list() });
    }

    if (route === "/api/refresh" && req.method === "POST") {
      await scheduler.fastPass();
      return sendJson(res, 200, { ok: true });
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
      scheduler = new Scheduler({ config, store, pool, registry, getProjects: () => registry.projects });
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
      res.writeHead(200, { "Content-Type": TYPES[path.extname(filePath)] || "application/octet-stream", "Cache-Control": "no-store" });
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

await registry.refresh();
if (!config.defaultCwd) config.defaultCwd = registry.projects[0]?.path || process.cwd();
await scheduler.start();

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
