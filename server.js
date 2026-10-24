// Static + JSON + SSE server for the worktree monitor, plus Stage-1 agent spawning.
// The HTTP layer never runs git: the scheduler scans in worker threads and the
// store holds the results. Spawned agents go through lib/jobs.js.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { gzipSync as zlibGzipSync } from "node:zlib";
import { mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "./lib/pool.js";
import { worktreeList } from "./lib/project.js";
import { Store } from "./lib/store.js";
import { Scheduler } from "./lib/scheduler.js";
import { ProjectRegistry } from "./lib/projects.js";
import { Jobs, hermesHome, makeThreadName, previewRequest } from "./lib/jobs.js";
import { gitIn } from "./lib/scan.js";
import { auditRepo } from "./lib/hermes-worktrees.js";
import { Approvals } from "./lib/approvals.js";
import {
  approvalState, writeApprovalTimeout, APPROVAL_TIMEOUT_MIN, APPROVAL_TIMEOUT_MAX,
  clarifyWindowSeconds,
  sessionSettings, writeSessionListLimit, SESSION_LIST_MIN, SESSION_LIST_MAX,
  providerState, writeProviderSettings,
} from "./lib/hermes-config.js";
import { hermesSessionTail } from "./lib/activity.js";
import { Assistant, ASSISTANT_THREAD } from "./lib/assistant.js";
import { childTranscript, collectPrompt, subagentsFor, subagentRoster } from "./lib/subagents.js";
import { thinkingFor } from "./lib/thinking.js";
import { modelCatalogue } from "./lib/hermes-models.js";

// A file an agent produced is meant to be OPENED, and the shell association may hand a .md to a
// browser. Prefer a text editor: Notepad++ when installed, else Windows' notepad (always present),
// else the platform's text opener. Resolved once — the answer cannot change while the panel runs.
let editorResolver = null;
async function editorFor(target) {
  if (!editorResolver) {
    if (process.platform === "win32") {
      let bin = "notepad.exe";
      let base = [];
      for (const candidate of [
        "C:/Program Files/Notepad++/notepad++.exe",
        "C:/Program Files (x86)/Notepad++/notepad++.exe",
      ]) {
        const isFile = await stat(candidate).then((s) => s.isFile()).catch(() => false);
        if (isFile) {
          bin = candidate;
          break;
        }
      }
      editorResolver = (t) => [bin, [...base, t]];
    } else if (process.platform === "darwin") {
      editorResolver = (t) => ["open", ["-t", t]];
    } else {
      editorResolver = (t) => ["xdg-open", [t]];
    }
  }
  return editorResolver(target);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const execP = promisify(execFile);
const PUBLIC_DIR = path.join(HERE, "public");
// The panel's version is declared once, in package.json: read it here so the page can say which
// build is running without a second copy to keep in step.
const VERSION = await readFile(path.join(HERE, "package.json"), "utf8")
  .then((t) => JSON.parse(t).version || null)
  .catch(() => null);
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
  // "all": keep every project fresh, whether or not anyone is looking at it. "visible": the page reports which
  // project sections are on screen and only those are re-read - with ~100 projects that is most of the git work
  // the board does. The setting lives in this file so it survives a restart and applies to every browser.
  cfg.scanMode = String(cfg.scanMode || "all").toLowerCase() === "visible" ? "visible" : "all";
  // Keyed off the config's own directory, so a PANEL_CONFIG sandbox keeps its own registry.
  if (!cfg.jobsFile) cfg.jobsFile = path.join(path.dirname(CONFIG_PATH), "logs", "jobs.json");
  // The assistant's scratchpad lives beside the job store; `assistant` is an optional block of knobs
  // (mode, model, rule escalations) that the page can also change at runtime.
  cfg.assistant = cfg.assistant && typeof cfg.assistant === "object" ? cfg.assistant : {};
  if (!cfg.assistantFile) cfg.assistantFile = path.join(path.dirname(cfg.jobsFile), "assistant.json");
  return cfg;
}

// Write one setting into the panel's own config.json, leaving every other key exactly as it was. Only the key being
// changed is written: dumping the in-memory config would bake computed defaults into the file.
async function patchPanelConfig(patch) {
  let raw = {};
  try {
    raw = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch {
    raw = {};
  }
  Object.assign(raw, patch);
  await writeFile(CONFIG_PATH, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
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

// Attachments arrive as raw bytes (no multipart parser here): the filename rides in x-filename, so the
// body is exactly the file.
function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (d) => {
      size += d.length;
      if (size > limit) {
        reject(Object.assign(new Error(`attachment is larger than ${Math.round(limit / (1024 * 1024))} MB`), { tooLarge: true }));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
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

// A worktree branches from HEAD, so a repo with no commits cannot host one. Refuse with a reason up
// front instead of letting the run start in a tree that cannot exist.
async function spawnBlocker(cwd, target) {
  if (target?.empty) {
    return `${target.name} has no commits yet (unborn HEAD), so a worktree cannot be created there — make an initial commit first.`;
  }
  const head = await gitIn(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], 15000);
  if (head.ok) return null;
  const err = String(head.err || head.out || "");
  if (/not a git repository/i.test(err)) return `${cwd} is not a git repository — an agent works in a worktree, which needs one.`;
  return `${cwd} has no commits yet (unborn HEAD), so a worktree cannot be created there — make an initial commit first.`;
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
  panelThreads: () => jobs.panelRunThreads(),
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
  // The tree is created by THIS panel now, so the job knows its project directly — the worktree
  // path alone would not match any project row and the card would sit "unattached" until the next
  // discovery pass.
  const project = registry.projects.find((p) => normPathKey(p.path) === normPathKey(j.projectPath || j.cwd));
  if (!project) return;
  void scheduler.adoptWorktree(project.name, j.worktreePath).catch(() => {});
}
// Declared before the job stream that feeds it: a job event arrives on the same tick as construction,
// and the observer is optional until the assistant exists.
let assistant = null;
const jobs = new Jobs({
  config,
  onEvent: (evt) => {
    broadcast(evt);
    adoptFromJob(evt);
    // A turn that just ended is the first moment the session has a name of its own, and the tree is idle: give the
    // worktree that name. Swallowed on purpose - a rename is never worth failing a job event over.
    void autoNameWorktree(evt).catch(() => {});
    assistant?.observe(evt);
  },
  onLog: log,
  // Read per question, not once at boot: the file is small and the gateway re-reads it too, so a countdown
  // matches the wait the gateway is actually enforcing.
  clarifyWindow: () => clarifyWindowSeconds(),
});
// Human side of the Hermes approval-transport contract: the plugin presents, the panel answers,
// the host decides. Nothing here can approve anything by itself.
const approvals = new Approvals({ onEvent: broadcast });

// The sentry + the assistant's own thread. It reads the same job summaries the page does, so nothing
// here can see more than the board shows; its own clock is `settings.seconds`. `spawner` is the one act it
// can perform beyond talk: a worker, in a worktree the panel cuts, exactly the way the New-agent card does.
assistant = new Assistant({
  config,
  jobs,
  getProjects: () => registry.projects,
  // The rows the scanner already produced (dirty files, commits ahead, verdict) — no second git pass — and the
  // delegated children the gateway keeps in `state.db`, which never reach a parent's run stream.
  getRows: () => [...store.rows.values()],
  getChildren: () => subagentRoster({ dbPath: path.join(hermesHome(), "state.db") }),
  spawner: assistantSpawnRun,
  onEvent: broadcast,
  onLog: log,
});
// The assistant's own working directory, created before the first turn so it cannot be refused by the
// gateway: this thread does no file work, and borrowing a project checkout is what broke a live panel when
// that checkout had been deleted. Logged once, so the path is never a mystery in the boot log.
log(`assistant cwd: ${assistant.ensureCwd()}`);
assistant.start();

// The sentry cannot report its own clock stopping, and a restart leaves its last turn `interrupted` with
// nobody to notice: both are the server's business. The watchdog repairs the timer from outside (its own
// tick() only catches throws), and the resume wakes the assistant once if the restart cut a turn in half.
assistant.resumeAfterRestart();
setInterval(() => {
  try {
    const h = assistant.supervise();
    if (h.restarted || h.stale) log(`assistant watchdog: ${h.restarted ? "timer restarted" : ""}${h.restarted && h.stale ? " · " : ""}${h.stale ? "stale pass ran" : ""}`);
  } catch (err) {
    log(`assistant watchdog: ${String((err && err.message) || err)}`);
  }
}, 10_000).unref?.();

// Start a worker on the assistant's behalf. Deliberately the same mechanics as the New-agent card —
// registry for the project, gateway probe before anything is promised, `git rev-parse`/`worktree add` in
// lib/jobs.js — but with no dry run and no model field, so the worker runs on the gateway default rather
// than on the small model the assistant itself uses.
async function assistantSpawnRun(spec = {}) {
  const prompt = String(spec.prompt || "").trim();
  if (!prompt) throw new Error("a spawn needs a prompt");
  const transport = await jobs.probe();
  if (!transport.reachable || !transport.capabilities?.runs) {
    throw new Error(`the Hermes gateway API is not usable at ${jobs.api.url}${transport.error ? `: ${transport.error}` : ""}`);
  }
  const target = spec.project
    ? registry.projects.find((p) => p.name === spec.project)
    : projectForPath(spec.target);
  if (spec.existing) {
    // An agent in a directory that already exists: no tree is cut, and the card attaches to the git top level.
    const cwd = path.resolve(String(spec.target || target?.path || ""));
    try {
      if (!(await stat(cwd)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new Error(`${cwd} does not exist or is not a directory`);
    }
    const blocked = await spawnBlocker(cwd, null);
    const top = await gitIn(cwd, ["rev-parse", "--show-toplevel"]);
    const ownerPath = top.ok && top.out ? top.out : cwd;
    const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return jobs.create({
      prompt,
      cwd,
      existing: true,
      ownerPath,
      ownerPending: false,
      baseCheckout: Boolean(target && norm(ownerPath) === norm(target.path)),
      origin: { kind: "assistant-spawn", where: "existing" },
    });
  }
  if (!target) throw new Error(`unknown project: ${spec.target || spec.project || "(none)"}`);
  const blocked = await spawnBlocker(target.path, target);
  if (blocked) throw new Error(blocked);
  return jobs.create({
    prompt,
    cwd: target.path,
    project: target.name,
    existing: false,
    // The worktree appears a moment later; adoptFromJob files the card under its own row when it does.
    ownerPending: true,
    origin: { kind: "assistant-spawn", project: target.name },
  });
}

const settingsOut = () => ({
  version: VERSION,
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
  scanMode: config.scanMode === "visible" ? "visible" : "all",
  scanVisible: scheduler ? scheduler.visibilityReport() : null,
  spawnEnabled: true,
});

const normPathKey = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// ---- renaming a worktree ---------------------------------------------------------------------
// A tree is cut from the prompt, so its name is the prompt: cut at 24 characters, usually mid-word, and about what the
// reader typed rather than what the agent worked out it was doing. Renaming it is the directory and the branch plus
// the panel's own bookkeeping - the jobs that ran there (a run's body carries its cwd), the store's row, and the row
// the board draws.
const WORKTREE_TAG_RE = /-([0-9a-f]{6})$/i;
function worktreeDirName(name, tag) {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug ? `${slug}-${tag}` : "";
}

async function renameWorktree({ projectName, target, name }) {
  const project = scheduler.getProjects().find((p) => p.name === projectName);
  if (!project) return { error: `unknown project: ${projectName}`, status: 404 };
  const oldPath = path.resolve(String(target || ""));
  if (path.resolve(project.path) === oldPath) {
    return { error: "that is the project's own checkout, not a worktree", status: 400 };
  }
  const row = scheduler.store.rowsFor(projectName).find((r) => path.resolve(r.path) === oldPath);
  if (!row) return { error: `not a worktree row of ${projectName}: ${oldPath}`, status: 404 };
  const base = path.basename(oldPath);
  // Keep the six-hex tag: it is what tells two trees named alike apart, and it makes a repeated rename a no-op
  // instead of a second suffix.
  const tag = ((WORKTREE_TAG_RE.exec(base) || [])[1] || randomUUID().slice(0, 6)).toLowerCase();
  const wanted = String(name || "").trim().replace(new RegExp(`-${tag}$`, "i"), "");
  const dirName = worktreeDirName(wanted, tag);
  if (!dirName) return { error: "a name is required", status: 400 };
  const newPath = path.join(project.path, ".worktrees", dirName);
  if (path.resolve(newPath) === oldPath) {
    return { ok: true, unchanged: true, path: oldPath.replace(/\\/g, "/"), branch: row.branch || null, jobs: 0 };
  }
  const taken = await stat(newPath)
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (taken) return { error: `${dirName} already exists`, status: 409 };
  // A running agent holds the tree as its cwd, and git refuses to move a worktree something is standing in.
  const busy = jobs
    .list()
    .find(
      (j) =>
        (j.status === "running" || j.status === "starting") &&
        [j.cwd, j.ownerPath, j.worktreePath].filter(Boolean).some((p) => path.resolve(p) === oldPath),
    );
  if (busy) return { error: `an agent is running in that worktree (${busy.id}) — stop it first`, status: 409 };
  // Windows will not rename a directory that any process has open, and an agent's shell lives in its tree long after
  // its turn ends — so the directory move is best-effort and the branch rename is the part that always lands.
  let moved = true;
  let whyNot = "";
  try {
    await execP("git", ["-C", project.path, "worktree", "move", oldPath, newPath], { timeout: 90_000 });
  } catch (e) {
    moved = false;
    whyNot = String((e && e.message) || e)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .pop() || "the directory is held open";
  }
  // The branch the tree is actually on, not the store's copy of it: the store is a scan behind, and a second rename
  // seconds later would otherwise try to move a branch that no longer exists.
  const oldBranch = await execP("git", ["-C", oldPath, "symbolic-ref", "--short", "HEAD"], { timeout: 20_000 })
    .then((r) => String(r.stdout || "").trim())
    .catch(() => row.branch || null);
  const newBranch = `wtgui/${dirName}`;
  let branchRenamed = false;
  if (oldBranch && oldBranch !== newBranch) {
    // A scan running in a worker thread can hold a ref lock for a moment ("cannot lock ref"), and the whole point of
    // this is a name: try again before giving up on the branch half.
    for (let attempt = 0; attempt < 3 && !branchRenamed; attempt += 1) {
      try {
        await execP("git", ["-C", project.path, "branch", "-m", oldBranch, newBranch], { timeout: 30_000 });
        branchRenamed = true;
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  }
  const finalPath = moved ? newPath : oldPath;
  const repointed = jobs.repointPath(oldPath, finalPath);
  if (moved) {
    scheduler.store.dropRow(projectName, row.path);
    broadcast({ type: "drop", project: projectName, path: row.path });
  }
  // Read the renamed tree in now, not on its next scan: the store's branch name is what the next rename reads, and the
  // board should show the new name in the same breath as the banner.
  const scanned = await scheduler.scanOne(project, finalPath.replace(/\\/g, "/"), "full").catch(() => null);
  return {
    ok: true,
    moved,
    path: finalPath.replace(/\\/g, "/"),
    branch: (scanned && scanned.branch) || (branchRenamed ? newBranch : oldBranch),
    branchRenamed,
    jobs: repointed,
    warning: moved ? null : `the directory keeps its old name (${whyNot})`,
  };
}

// A tree is named from the prompt, and Hermes names the session from the work itself a moment later ("Fix delete
// worktree button not removing directory"). Once that name exists and the tree is idle, the tree takes it - the
// agent's own name for the job beats the reader's first sentence cut at 24 characters. Once per tree.
const autoNamedTrees = new Set();
async function autoNameWorktree(evt) {
  if (evt?.type !== "job") return;
  const j = evt.job;
  if (!j || !j.worktreePath || j.existing || j.reply) return;
  if (!["done", "failed", "cancelled", "interrupted"].includes(String(j.status))) return;
  const treeKey = normPathKey(j.worktreePath);
  if (autoNamedTrees.has(treeKey)) return;
  // Only when the tree is idle: moving a directory out from under a running turn is what git refuses.
  const busy = jobs
    .list()
    .some((x) => (x.status === "running" || x.status === "starting") && normPathKey(x.ownerPath || x.cwd) === treeKey);
  if (busy) return;
  autoNamedTrees.add(treeKey);
  const title = jobs.sessionInfoFor(j.thread).title;
  if (!title) return;
  const project = projectForPath(j.worktreePath);
  if (!project) return;
  await renameWorktree({ projectName: project.name, target: j.worktreePath, name: title }).catch(() => {});
}

// Which project a directory belongs to: the innermost project root that contains it (a project can be nested inside
// another checkout), matched on a path boundary so `…/app-other` is not inside `…/app`.
const projectForPath = (dir) => {
  const key = normPathKey(dir);
  if (!key) return null;
  let best = null;
  for (const proj of registry.projects) {
    const root = normPathKey(proj.path);
    if (!root) continue;
    if (key !== root && !key.startsWith(`${root}/`)) continue;
    if (!best || root.length > normPathKey(best.path).length) best = proj;
  }
  return best;
};

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
    // The assistant's own state travels with the snapshot: its scratchpad, its open alerts and its
    // thread id, so a reload comes back to the same conversation and the same watches.
    assistant: assistant.state(),
    skipped: registry.skipped,
    scanRoots: config.scanRoots || [],
    spawn: {
      // Spawning is no longer "is there a hermes.exe on this box": it is "is the gateway's api_server
      // reachable and keyed". The panel probes and reports, instead of assuming.
      transport: jobs.transportInfo(),
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

const cleanPath = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "");

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// Remove a directory that something may still hold open. `force: true` makes a missing path a
// success; anything left behind is a handle, not a missing file. Returns true when the path is gone.
async function removeDirNow(target) {
  try {
    await rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  } catch {
    /* held open — the check below is the answer */
  }
  return !(await stat(target).then((s) => s.isDirectory()).catch(() => false));
}

// Windows refuses to delete (or rename) a directory that a process is using as its working directory,
// and a worktree is exactly that whenever an agent, an editor, or a panel started from it is still
// running. Nothing the panel can do makes the holder let go — it has to exit — so the cleanup keeps
// trying after the response for minutes rather than leaving an empty folder on disk forever.
function retryDirCleanup(target, { everyMs = 5_000, forMs = 10 * 60_000 } = {}) {
  const until = Date.now() + forMs;
  const tick = async () => {
    if (await removeDirNow(target)) {
      log(`worktree cleanup: removed the leftover folder ${target}`);
      return;
    }
    if (Date.now() < until) setTimeout(tick, everyMs).unref();
    else log(`worktree cleanup: gave up on ${target} — a process still holds it`);
  };
  setTimeout(tick, everyMs).unref();
}

// Is this path an ancestor of (or equal to) a process's working directory? A panel cannot delete the
// folder it was started from, and saying so is more use to the reader than "another process".
function holdsCwd(target, cwd) {
  const a = cleanPath(target).toLowerCase();
  const b = cleanPath(cwd).toLowerCase();
  return Boolean(b) && (b === a || b.startsWith(`${a}/`));
}

// The Hermes sessions the scheduler attributes to one worktree row — the same attribution the row's
// own "Hermes session open here but idle" claim is built from, so this list can never offer a session
// the row does not already say it has.
async function sessionsForRow(target) {
  const roots = await scheduler.sessionRoots();
  return roots.get(cleanPath(target).toLowerCase()) || [];
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

    // ---- the one Hermes setting the panel can change ------------------------------------
    // approvals.timeout is the gateway's clock, not the panel's: the gate that waits for the answer
    // runs inside the process executing the turn. It lives in <HERMES_HOME>/config.yaml, so this
    // reads and writes there rather than config.json, and it refuses when the gateway is another
    // machine. Read on demand — it is opened from Settings, never folded into the 30 s snapshot.
    // ---- how many sessions the CLI's picker shows ------------------------------------------
    // `sessions.list_limit`, read by the local CLI patch. The store itself is not capped — this
    // reports what it actually holds, so "only ten are kept" is answerable — and `patched: false`
    // means the installed CLI has no patch (a `hermes update` replaced it), which makes the value
    // in config.yaml inert. Saying that is the point: a setting that quietly does nothing is worse
    // than no setting.
    if (route === "/api/settings/sessions" && req.method === "GET") {
      return sendJson(res, 200, await sessionSettings());
    }

    if (route === "/api/settings/sessions" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const state = await sessionSettings();
      if (!state.editable) return sendJson(res, 409, { ...state, error: state.reason || "not editable" });
      const limit = Number(body.listLimit ?? body.limit);
      if (!Number.isInteger(limit) || limit < SESSION_LIST_MIN || limit > SESSION_LIST_MAX) {
        return sendJson(res, 400, {
          ...state,
          error: `the session list must be a whole number between ${SESSION_LIST_MIN} and ${SESSION_LIST_MAX}`,
        });
      }
      try {
        writeSessionListLimit(limit);
      } catch (e) {
        return sendJson(res, 500, { ...state, error: String((e && e.message) || e) });
      }
      log(`sessions.list_limit = ${limit} written to ${state.configPath}`);
      return sendJson(res, 200, {
        ...(await sessionSettings()),
        written: true,
        // The CLI reads config at start-up of each invocation, so the next /sessions uses it.
        note: "saved — the next hermes session's /sessions and /resume use it",
      });
    }

    if (route === "/api/settings/approvals" && req.method === "GET") {
      return sendJson(res, 200, approvalState({ gatewayUrl: jobs.api.url }));
    }

    if (route === "/api/settings/approvals" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const state = approvalState({ gatewayUrl: jobs.api.url });
      if (!state.editable) return sendJson(res, 409, { ...state, error: state.reason || "not editable" });
      const seconds = Number(body.timeoutSeconds ?? body.timeout);
      if (!Number.isInteger(seconds) || seconds < APPROVAL_TIMEOUT_MIN || seconds > APPROVAL_TIMEOUT_MAX) {
        return sendJson(res, 400, {
          ...state,
          error: `the approval window must be a whole number of seconds between ${APPROVAL_TIMEOUT_MIN} and ${APPROVAL_TIMEOUT_MAX}`,
        });
      }
      try {
        writeApprovalTimeout(seconds);
      } catch (e) {
        return sendJson(res, 500, { ...state, error: String((e && e.message) || e) });
      }
      log(`approvals.timeout = ${seconds}s written to ${state.configPath}`);
      return sendJson(res, 200, {
        ...approvalState({ gatewayUrl: jobs.api.url }),
        written: true,
        // Hermes re-reads config.yaml when the file signature changes and reads this per request,
        // so the next prompt uses the new window without restarting the gateway.
        note: "saved",
      });
    }

    // The provider endpoint every run talks to: OpenRouter's URL and the key it authenticates with. The
    // key itself never leaves this process - GET reports whether one is set, where it came from and its
    // last four characters; POST writes into config.yaml's model block (the file the gateway re-reads).
    if (route === "/api/settings/provider" && req.method === "GET") {
      return sendJson(res, 200, providerState());
    }

    if (route === "/api/settings/provider" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const state = providerState();
      if (!state.editable) return sendJson(res, 409, { ...state, error: state.reason || "not editable" });
      try {
        const wrote = writeProviderSettings({
          baseUrl: body.baseUrl,
          apiKey: body.apiKey,
          clearKey: Boolean(body.clearKey),
        });
        const what = [wrote.wroteUrl ? "model.base_url" : null, wrote.wroteKey ? "model.api_key" : null, wrote.clearedKey ? "model.api_key removed" : null]
          .filter(Boolean)
          .join(", ");
        log(`${what || "provider settings"} written to ${wrote.configPath}`);
        return sendJson(res, 200, {
          ...providerState(),
          written: true,
          note: "saved — the next run uses it; a run already in flight keeps the endpoint and key it started with",
        });
      } catch (e) {
        return sendJson(res, 400, { ...providerState(), error: String((e && e.message) || e) });
      }
    }

    // The models the New-agent form offers. Read from the gateway home, not from the run stream: the
    // provider's live list is what Hermes itself fetched, and a stale one is reported as stale rather
    // than presented as truth.
    if (route === "/api/models" && req.method === "GET") {
      return sendJson(res, 200, modelCatalogue());
    }

    // ---- the assistant: a sentry over this board, and one thread the reader talks to ----------------
    // Every read is free of side effects; every write is authorised like the rest of the panel and
    // returns the whole assistant state so the float repaints from one answer instead of guessing.
    if (route === "/api/assistant" && req.method === "GET") {
      return sendJson(res, 200, assistant.state());
    }

    // A message from the reader. The board digest and the scratchpad are attached to the run's input by
    // the module, so the card shows the sentence the reader typed.
    if (route === "/api/assistant/say" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const text = String(body.text || "").trim();
      if (!text) return sendJson(res, 400, { error: "text is required" });
      try {
        const job = await assistant.say(text);
        return sendJson(res, 202, { job, assistant: assistant.state() });
      } catch (e) {
        return sendJson(res, 409, { error: String((e && e.message) || e) });
      }
    }

    if (route === "/api/assistant/settings" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      return sendJson(res, 200, { settings: assistant.setSettings(body), assistant: assistant.state() });
    }

    // Dismiss an alert, or hand it to the assistant (one digest, rate limited). Nothing here answers an
    // approval: that stays on the agent's own card, where the gateway validates the choice.
    if (route === "/api/assistant/alert" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        const alert = assistant.alertAction(String(body.id || ""), String(body.action || ""));
        return sendJson(res, 200, { alert, assistant: assistant.state() });
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e) });
      }
    }

    // The reader pressing Send on a draft: the one path that posts into a worker's thread by hand.
    if (route === "/api/assistant/answer" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        const job = await assistant.answerThread(String(body.thread || ""), body.text, {
          source: "reader",
          alertId: body.alertId ? String(body.alertId) : null,
        });
        return sendJson(res, 202, { job, assistant: assistant.state() });
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e) });
      }
    }

    // Answer a question the run is parked on (the `clarify` tool). Not a reply: it settles the prompt the
    // gateway is holding, so the turn resumes where it stopped.
    if (route === "/api/assistant/answer-question" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        const result = await assistant.answerParked(String(body.id || ""), body.answer);
        broadcast({ type: "jobs", jobs: jobs.list() });
        return sendJson(res, 200, { result, assistant: assistant.state() });
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e) });
      }
    }

    // Create a worktree (or use a directory that already exists) and start a worker. `{id}` confirms a spawn
    // card the assistant proposed; the spec form is the same act without a card. Both go through the one
    // spawner, so neither can skip the gateway probe or the unborn-HEAD refusal.
    if (route === "/api/assistant/spawn" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        const spec = body.id ? assistant.pendingSpawn(String(body.id)) : body;
        if (!spec) throw new Error(`no pending spawn with id ${body.id}`);
        const job = await assistant.startSpawn(spec, { alertId: body.id ? String(body.id) : null });
        broadcast({ type: "jobs", jobs: jobs.list() });
        return sendJson(res, 202, { job, assistant: assistant.state() });
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e) });
      }
    }

    if (route === "/api/assistant/watch" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        const watch = assistant.addWatch(body, "reader");
        return sendJson(res, 201, { watch, assistant: assistant.state() });
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e) });
      }
    }
    if (route === "/api/assistant/watch/remove" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      return sendJson(res, 200, { watches: assistant.removeWatch(String(body.id || "")), assistant: assistant.state() });
    }

    if (route === "/api/assistant/rule" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        const rules = assistant.addRule(body.text);
        return sendJson(res, 201, { rules, assistant: assistant.state() });
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e) });
      }
    }
    if (route === "/api/assistant/rule/remove" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      return sendJson(res, 200, { rules: assistant.removeRule(String(body.id || "")), assistant: assistant.state() });
    }

    if (route === "/api/assistant/notes" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      return sendJson(res, 200, { notes: assistant.setNotes(body.text), assistant: assistant.state() });
    }

    // One sentry pass on demand. Used by the page after a change that should be judged at once, and by
    // the verification probes instead of waiting for the clock.
    if (route === "/api/assistant/check" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      assistant.tick();
      return sendJson(res, 200, { assistant: assistant.state() });
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
      await jobs.probe();
      return sendJson(res, 200, { jobs: jobs.list(), transport: jobs.transportInfo(), defaultCwd: config.defaultCwd });
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

    // Preview the exact request that would be sent — the confirm affordance.
    if (route === "/api/agents/preview" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const target = body?.project ? registry.projects.find((p) => p.name === body.project) : null;
      const cwd = body?.cwd || target?.path || config.defaultCwd;
      const blocked = await spawnBlocker(cwd, target);
      // The thread name carries a random suffix, so the preview shows its shape.
      const req0 = previewRequest({ ...(body || {}), thread: makeThreadName(body?.prompt || "") });
      return sendJson(res, 200, { transport: jobs.transportInfo(), request: req0, cwd, project: target?.name || null, blocked, command: `POST ${jobs.api.url}${req0.path}\n${JSON.stringify(req0.body, null, 1)}` });
    }

    if (route === "/api/agents" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const pickerTarget = body.project ? registry.projects.find((p) => p.name === body.project) : null;
      if (body.project && !pickerTarget) return sendJson(res, 400, { error: `unknown project: ${body.project}` });
      // The directory is the ground truth: a cwd inside a known project overrides a stale project picker, so a spawn
      // aimed at one worktree can never be checked, filed or cut against another project.
      const cwdProject = projectForPath(body.cwd);
      if (cwdProject && body.project !== cwdProject.name) body.project = cwdProject.name;
      const target = cwdProject || pickerTarget;
      if (body.dryRun) {
        const req0 = previewRequest(body);
        return sendJson(res, 200, { dryRun: true, project: body.project || null, transport: jobs.transportInfo(), request: req0, cwd: body.cwd || target?.path || config.defaultCwd, command: `POST ${jobs.api.url}${req0.path}\n${JSON.stringify(req0.body, null, 1)}` });
      }
      // Refuse before promising a job: a stopped gateway or a missing key is the answer to "why did
      // nothing happen", not a card that says "starting" forever.
      const transport = await jobs.probe();
      if (!transport.reachable || !transport.capabilities?.runs) {
        return sendJson(res, 503, { error: `the Hermes gateway API is not usable at ${jobs.api.url}${transport.error ? `: ${transport.error}` : ""}` });
      }
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
      // A spawn that stays in the project's own checkout is not "an existing worktree": the card should
      // say so, because that is the difference between an agent working in a branch of its own and one
      // editing the tree the reader has checked out.
      const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      const baseCheckout = Boolean(existing && cwdProject && norm(ownerPath || cwd) === norm(cwdProject.path));
      const job = await jobs.create({ ...body, cwd, existing, ownerPath, ownerPending: !existing, baseCheckout });
      return sendJson(res, 202, { job });
    }

    // Continue a conversation: same named thread, no new worktree, run where the agent is.
    // A repo with no commits cannot host a worktree (there is no HEAD to branch from), and the spawn
    // refuses with that reason. This is the one-line fix that reason asks for: an EMPTY commit, so no
    // file is invented for the repo, and never a push — the commit stays local.
    if (route === "/api/repo/first-commit" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const target = path.resolve(String(body.path || "").trim());
      const info = await stat(target).catch(() => null);
      if (!info || !info.isDirectory()) return sendJson(res, 404, { error: `no such directory: ${target}` });
      const repoCheck = await gitIn(target, ["rev-parse", "--git-dir"], 15000);
      if (!repoCheck.ok) return sendJson(res, 400, { error: `${target} is not a git repository` });
      const head = await gitIn(target, ["rev-parse", "--verify", "--quiet", "HEAD"], 15000);
      if (head.ok) {
        const sha = await gitIn(target, ["rev-parse", "--short", "HEAD"], 10000);
        return sendJson(res, 409, { error: `${target} already has commits (${String(sha.out || "").trim()})`, alreadyCommitted: true });
      }
      const message = String(body.message || "Initial commit").slice(0, 200);
      const args = ["commit", "--allow-empty", "-m", message];
      let made = await gitIn(target, args, 30000);
      if (!made.ok && /tell me who you are|unable to auto-detect email|empty ident|Please tell me who/i.test(String(made.err || made.out || ""))) {
        // No identity configured on this machine: a local bot identity keeps the commit local and
        // attributable instead of failing on a prompt no one can answer.
        made = await gitIn(target, ["-c", "user.name=Hermes Panel", "-c", "user.email=panel@localhost", ...args], 30000);
      }
      if (!made.ok) return sendJson(res, 400, { error: String(made.err || made.out || "git commit failed").slice(0, 400) });
      const sha = await gitIn(target, ["rev-parse", "--short", "HEAD"], 10000);
      log(`first commit made in ${target} (${String(sha.out || "").trim()}) — local only, nothing pushed`);
      // The registry still has this repo down as empty, and a full rediscovery takes a sweep. The reader
      // is looking at a disabled spawn button and the very warning this fixed, so flip the one fact that
      // changed right here; the background refresh fills in the rest (head, branch) when it lands.
      const proj = registry.projects.find((x) => normPathKey(x.path) === normPathKey(target));
      if (proj) {
        proj.empty = false;
        registry.saveCache();
      }
      void registry.refresh();
      return sendJson(res, 201, { ok: true, path: target, sha: String(sha.out || "").trim(), message });
    }

    // A pasted or dropped document is stored on disk and its ABSOLUTE path goes into the prompt. The
    // gateway's runs API has no attachment field, but the agent has file tools — and an absolute path
    // is independent of the run's cwd, which this gateway does not honour anyway.
    if (route === "/api/attachments" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const LIMIT = 25 * 1024 * 1024;
      let bytes;
      try {
        bytes = await readRawBody(req, LIMIT);
      } catch (e) {
        return sendJson(res, e.tooLarge ? 413 : 400, { error: String(e.message || e) });
      }
      if (!bytes || !bytes.length) return sendJson(res, 400, { error: "empty attachment" });
      let name = "";
      try {
        name = decodeURIComponent(String(req.headers["x-filename"] || "").replace(/\+/g, " "));
      } catch {
        name = "";
      }
      name = path.basename(name || "pasted-file").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 120) || "pasted-file";
      const dir = config.attachmentsDir || path.join(path.dirname(config.jobsFile || path.join(process.cwd(), "logs")), "attachments");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const target = path.join(dir, `${stamp}-${name}`);
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(target, bytes);
      } catch (e) {
        return sendJson(res, 500, { error: `could not store the attachment: ${String((e && e.message) || e)}` });
      }
      const type = String(req.headers["content-type"] || "application/octet-stream");
      log(`attachment stored (${bytes.length} bytes): ${target}`);
      return sendJson(res, 201, { path: target.replace(/\\/g, "/"), name, bytes: bytes.length, type });
    }

    if (route === "/api/threads/model" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const thread = String(body.thread || "").trim();
      if (!thread) return sendJson(res, 400, { error: "thread is required" });
      return sendJson(res, 200, jobs.setThreadModel(thread, body.model));
    }

    if (route === "/api/threads/context" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const thread = String(body.thread || "").trim();
      if (!thread) return sendJson(res, 400, { error: "thread is required" });
      return sendJson(res, 200, jobs.setThreadContext(thread, body.limit));
    }

    if (route === "/api/agents/reply" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const text = String(body.text || "").trim();
      if (!text) return sendJson(res, 400, { error: "reply text is required" });
      // The assistant's thread is answered through its own route: the scratchpad and the board digest ride
      // with the turn, and a plain reply here would start a turn that has neither.
      if (String(body.thread || "") === ASSISTANT_THREAD) {
        return sendJson(res, 400, { error: "the assistant's thread is answered through /api/assistant/say" });
      }
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
      const origin = body.origin && typeof body.origin === "object" ? body.origin : null;
      const job = await jobs.create({
        prompt: text,
        thread: first.thread,
        reply: true,
        // Set when the panel is delivering subagent results: the card says what caused this turn.
        origin,
        resumeDir: dir,
        cwd: dir,
        // A model picked on the card wins; otherwise the thread's own choice, then whatever the first turn used.
        model: body.model ?? jobs.modelFor(first.thread) ?? first.model,
        budget: body.budget ?? first.budget ?? 1800,
        maxTurns: body.maxTurns ?? first.maxTurns,
        yolo: body.yolo ?? first.yolo,
        // A reply continues the SAME agent, so it keeps the tree that agent was created for.
        ownerPath: first.ownerPath || null,
      });
      // A delivery turn closes the offer on the turn it answers, for every reader and every reload.
      if (origin && origin.fromTurn) jobs.markCollected(origin.fromTurn, job.id);
      return sendJson(res, 202, { job });
    }

    if (route === "/api/jobs/cancel" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      return sendJson(res, 200, { ok: jobs.cancel(String(body.id || "")) });
    }

    // Steer a turn that is already running: the text is injected at the agent's next tool boundary,
    // so it can change course without ending the turn. 409 means it crossed the last boundary.
    if (route === "/api/jobs/steer" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const r = await jobs.steer(String(body.id || ""), body.text ?? body.input);
      // A steer lands inside the turn that is already running, so its documents belong to that turn's
      // card rather than to a new one.
      if (r.ok && Array.isArray(body.attachments) && body.attachments.length) jobs.addAttachments(String(body.id || ""), body.attachments);
      return sendJson(res, r.ok ? 200 : r.code === "run_not_accepting_steer" ? 409 : 400, r);
    }

    // Answer a parked run's approval. The gateway validates the choice a second time, so a stale
    // card cannot widen what the host allows.
    if (route === "/api/jobs/approve" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const r = await jobs.approve(String(body.id || ""), body.choice, body.requestId ?? body.request_id);
      return sendJson(res, r.ok ? 200 : r.code === "approval_not_pending" ? 409 : 400, r);
    }

    // Answer a question the agent's `clarify` tool is blocked on. Same fence as an approval: the
    // gateway re-validates the prompt id against the run's pending controls and its execution
    // generation, so a stale card cannot answer a question that has already been settled.
    if (route === "/api/jobs/answer" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const r = await jobs.answerQuestion(String(body.id || ""), body.answer, body.requestId ?? body.request_id);
      return sendJson(res, r.ok ? 200 : r.code === "approval_not_pending" ? 409 : 400, r);
    }

    // ---- reviving a conversation the panel no longer has a card for -------------------------
    // A session outlives the panel's job store: the conversation lives in the gateway, so a reset
    // store (or a ✕) leaves the row still saying "Hermes session open here but idle" with nothing to
    // click. These turn that claim into a list, and put ONE back on the board when the reader picks
    // it — never automatically, because a tree accumulates every session ever run in it and the
    // board must not refill with all of them at once.
    if (route === "/api/thinking" && req.method === "GET") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const thread = String(url.searchParams.get("thread") || "").trim();
      if (!thread) return sendJson(res, 400, { error: "thread is required" });
      const from = Number(url.searchParams.get("from"));
      const to = Number(url.searchParams.get("to"));
      const { hermesHome } = await import("./lib/jobs.js");
      return sendJson(res, 200, {
        thread,
        blocks: thinkingFor(thread, {
          dbPath: path.join(hermesHome(), "state.db"),
          from: Number.isFinite(from) ? from : null,
          to: Number.isFinite(to) && to > 0 ? to : null,
        }),
      });
    }

    if (route === "/api/tool-results" && req.method === "GET") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const thread = String(url.searchParams.get("thread") || "").trim();
      const tool = String(url.searchParams.get("tool") || "").trim();
      const from = Number(url.searchParams.get("from")) || 0;
      const to = Number(url.searchParams.get("to")) || 0;
      // How many results the console is about to draw: a burst of six calls needs six, not a default of eight
      // that silently stops halfway through a longer run.
      const limit = Math.max(1, Math.min(60, Number(url.searchParams.get("n")) || 20));
      if (!thread || !tool) return sendJson(res, 400, { error: "thread and tool are required" });
      const { hermesHome } = await import("./lib/jobs.js");
      const { toolResults } = await import("./lib/tool-results.js");
      const results = toolResults({ dbPath: path.join(hermesHome(), "state.db"), sessionId: thread, tool, from, to, limit });
      return sendJson(res, 200, { thread, tool, results });
    }

    if (route === "/api/subagents/collect" && req.method === "GET") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const thread = String(url.searchParams.get("thread") || "").trim();
      if (!thread) return sendJson(res, 400, { error: "thread is required" });
      const from = Number(url.searchParams.get("from"));
      const to = Number(url.searchParams.get("to"));
      const { hermesHome } = await import("./lib/jobs.js");
      const out = collectPrompt(thread, {
        dbPath: path.join(hermesHome(), "state.db"),
        from: Number.isFinite(from) ? from : 0,
        to: Number.isFinite(to) ? to : 0,
      });
      if (!out) return sendJson(res, 404, { error: "could not read that session's subagents" });
      return sendJson(res, 200, out);
    }

    if (route === "/api/subagents/console" && req.method === "GET") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const session = String(url.searchParams.get("session") || "").trim();
      if (!session) return sendJson(res, 400, { error: "session is required" });
      const { hermesHome } = await import("./lib/jobs.js");
      const out = childTranscript(session, { dbPath: path.join(hermesHome(), "state.db") });
      if (!out) return sendJson(res, 404, { error: "no such session" });
      return sendJson(res, 200, out);
    }

    // The calls behind a "+ N commands" batch. The run stream only carries the gateway's summary of a parallel
    // batch; each call and its arguments are in the session transcript, so they are read back on demand - only
    // when the reader actually asks what the other commands were.
    if (route === "/api/tool-calls" && req.method === "GET") {
      // Same rule as the child-console read: this returns transcript text, so it is behind the panel token when one
      // is configured.
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const thread = String(url.searchParams.get("thread") || "").trim();
      const tool = String(url.searchParams.get("tool") || "").trim();
      const limit = Math.max(1, Math.min(20, Number(url.searchParams.get("n")) || 8));
      // "+ 3 commands" is four calls: the count is how the right batch is found among the session's messages.
      const want = Math.max(0, Math.min(40, Number(url.searchParams.get("want")) || 0));
      // The turn's start, in ms: the batch belongs to that turn, not to whichever one ran most recently. `first` is
      // the call the summary printed, which pins the search to this batch inside the turn.
      const sinceMs = Number(url.searchParams.get("since")) || 0;
      const first = String(url.searchParams.get("first") || "").slice(0, 120);
      if (!thread || !tool) return sendJson(res, 400, { error: "thread and tool are required" });
      const job = jobs.firstOfThread(thread);
      const sessionId = job && job.sessionId;
      if (!sessionId) return sendJson(res, 404, { error: `no session recorded for ${thread}`, calls: [] });
      const { hermesHome } = await import("./lib/jobs.js");
      const { recentToolCalls } = await import("./lib/tool-calls.js");
      const calls = recentToolCalls({
        dbPath: path.join(hermesHome(), "state.db"),
        sessionId,
        tool,
        limit,
        want,
        first,
        // Whole seconds, with a minute of slack: a turn's first message can be written a moment before the panel's
        // own startedAt stamp.
        since: sinceMs ? Math.max(0, Math.floor(sinceMs / 1000) - 60) : 0,
      });
      return sendJson(res, 200, { thread, session: sessionId, tool, calls });
    }

    if (route === "/api/subagents" && req.method === "GET") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const thread = String(url.searchParams.get("thread") || "").trim();
      // Children the run delegated: their sessions, their state and the last thing each one did. Polled while a
      // card is working, because the gateway does not put a child's work on the parent's event stream.
      const { hermesHome } = await import("./lib/jobs.js");
      const dbPath = path.join(hermesHome(), "state.db");
      return thread
        ? sendJson(res, 200, { thread, subagents: subagentsFor(thread, { dbPath }) })
        : sendJson(res, 200, { roster: subagentRoster({ dbPath }) });
    }

    if (route === "/api/sessions" && req.method === "GET") {
      const target = cleanPath(url.searchParams.get("path"));
      if (!target) return sendJson(res, 400, { error: "path is required" });
      const mine = await sessionsForRow(target);
      const onBoard = new Set(jobs.list().map((j) => j.thread));
      return sendJson(res, 200, {
        path: target,
        sessions: mine.map((s) => ({
          id: s.id,
          title: s.title || null,
          matched: s.matched || null,
          lastActivityAt: s.lastActivityAt || null,
          onBoard: onBoard.has(s.id),
        })),
      });
    }

    if (route === "/api/sessions/revive" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const sessionId = String(body.sessionId || "").trim();
      const target = cleanPath(body.path);
      if (!sessionId) return sendJson(res, 400, { error: "sessionId is required" });
      if (!target) return sendJson(res, 400, { error: "path is required" });
      // Never take the pair on trust: the session must be one the store attributes to THIS row, or a
      // stale tab could file any conversation anywhere on the board.
      const mine = await sessionsForRow(target);
      const session = mine.find((s) => s.id === sessionId);
      if (!session) return sendJson(res, 404, { error: `no open session ${sessionId} in ${target}` });
      if (jobs.firstOfThread(sessionId)) return sendJson(res, 409, { error: "that session already has a card on the board" });
      // The last exchange, so the revived card reads as the conversation it brings back.
      const tail = await hermesSessionTail(sessionId, 2).catch(() => []);
      const owner = registry.projects
        .filter((p) => {
          const b = normPathKey(p.path);
          const t = normPathKey(target);
          return t === b || t.startsWith(`${b}/`);
        })
        .sort((a, b) => normPathKey(b.path).length - normPathKey(a.path).length)[0] || null;
      const out = jobs.revive({
        thread: sessionId,
        ownerPath: target,
        projectPath: owner ? owner.path : null,
        cwd: target,
        title: session.title || null,
        // The card is dated by the conversation, not by the click: "last active 40m ago" is the
        // useful fact about a session that was idle before the reader revived it.
        at: session.lastActivityAt || null,
        tail,
      });
      if (!out.ok) return sendJson(res, 409, out);
      log(`revived session ${sessionId} under ${target}`);
      return sendJson(res, 200, out);
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

    // Which project sections the page can see right now. Sent when the set changes and as a heartbeat; in
    // scanMode "visible" it is what the scheduler reads instead of the whole fleet. Cheap and read-only, so it
    // needs no token.
    if (route === "/api/visible" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      const known = new Set(registry.projects.map((p) => p.name));
      const names = (Array.isArray(body.projects) ? body.projects : [])
        .map((n) => String(n || "").trim())
        .filter((n) => known.has(n));
      scheduler.noteVisible(names);
      return sendJson(res, 200, { ok: true, visible: names.length, mode: config.scanMode });
    }

    // Refresh everything, or only what is on screen. Server-side: the scans happen here, so the choice has to
    // outlive a tab and apply to whichever browser is open.
    if (route === "/api/settings/scan" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const mode = String(body.mode || "").toLowerCase() === "visible" ? "visible" : "all";
      try {
        await patchPanelConfig({ scanMode: mode });
      } catch (e) {
        return sendJson(res, 500, { error: `could not write config.json: ${String((e && e.message) || e)}` });
      }
      config.scanMode = mode;
      scheduler.cfg.scanMode = mode;
      // Switching back to "all" must not wait for the visibility heartbeat to lapse.
      if (mode === "all") scheduler.noteVisible(null);
      log(`scan mode: ${mode}`);
      broadcast({ type: "snapshot", data: snapshot() });
      return sendJson(res, 200, { ok: true, mode, settings: settingsOut() });
    }

    // Open a link from an agent's console in the OS default browser. Only http(s) gets through: this
    // hands a string to the operating system, so nothing else may pass. execFile (no shell) means the
    // URL can never become part of a command line.
    if (route === "/api/open-url" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      let parsed;
      try {
        parsed = new URL(String(body.url || "").trim());
      } catch {
        return sendJson(res, 400, { error: "not a URL" });
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return sendJson(res, 400, { error: "only http(s) links can be opened" });
      }
      const url = parsed.toString();
      const [bin, args] =
        process.platform === "win32"
          ? ["cmd.exe", ["/c", "start", "", url]]
          : process.platform === "darwin"
            ? ["open", [url]]
            : ["xdg-open", [url]];
      execFile(bin, args, (err) => {
        if (err) sendJson(res, 500, { error: err.message });
        else sendJson(res, 200, { ok: true, url });
      });
      return;
    }

    // Delete a deliverable. The confirmation lives in the UI; this only acts on a path or URL the panel
    // itself recorded, so a stray string from the page can never delete an arbitrary file.
    if (route === "/api/jobs/artifact/delete" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const key = String(body.key || body.path || body.url || "").trim();
      const hit = jobs.findArtifact(key);
      if (!hit) return sendJson(res, 404, { error: `not a recorded deliverable: ${key}` });
      let removedFile = false;
      if (hit.artifact.kind !== "url" && hit.artifact.path) {
        try {
          await unlink(hit.artifact.path);
          removedFile = true;
        } catch (e) {
          // Already gone is the same outcome for the reader; anything else is worth reporting.
          if (e.code !== "ENOENT") return sendJson(res, 500, { error: String((e && e.message) || e) });
        }
      }
      jobs.removeArtifact(hit.job, key);
      return sendJson(res, 200, { ok: true, removedFile, kind: hit.artifact.kind || "file" });
    }

    // Remove a worktree from the board: the directory goes to the Windows Recycle Bin (recoverable), then
    // git's own bookkeeping is pruned. Never the project's own checkout, never a tree with a live agent.
    if (route === "/api/worktree/delete" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const projectName = String(body.project || "").trim();
      const target = path.resolve(String(body.path || "").trim());
      const project = scheduler.getProjects().find((p) => p.name === projectName);
      if (!project) return sendJson(res, 404, { error: `unknown project: ${projectName}` });
      if (path.resolve(project.path) === target) {
        return sendJson(res, 400, { error: "that is the project's own checkout, not a worktree" });
      }
      const row = scheduler.store.rowsFor(projectName).find((r) => path.resolve(r.path) === target);
      if (!row) return sendJson(res, 404, { error: `not a worktree row of ${projectName}: ${target}` });
      const busy = jobs
        .list()
        .find(
          (j) =>
            (j.status === "running" || j.status === "starting") &&
            [j.cwd, j.ownerPath].filter(Boolean).some((p) => path.resolve(p) === target),
        );
      if (busy) return sendJson(res, 409, { error: `an agent is running in that worktree (${busy.id})` });

      // Recycle first: a mistaken click is recoverable from the Recycle Bin for as long as Windows keeps
      // it. `git worktree remove --force` is the fallback when the shell cannot reach the Recycle Bin.
      const psCommand =
        "Add-Type -AssemblyName Microsoft.VisualBasic; " +
        `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${target.replace(/'/g, "''")}','OnlyErrorDialogs','SendToRecycleBin')`;
      const stillThere = () => stat(target).then((s) => s.isDirectory()).catch(() => false);
      // Recorded before anything is deleted: the response should say whether this call removed a
      // directory or merely cleaned up the panel's record of one that was already gone.
      const hadDirectory = await stillThere();
      let recycled = false;
      let recycleError = null;
      if (process.platform === "win32" && hadDirectory) {
        try {
          await execP("powershell", ["-NoProfile", "-NonInteractive", "-Command", psCommand], { timeout: 90_000 });
          recycled = !(await stillThere());
          if (!recycled) recycleError = "the Recycle Bin refused it — the directory is still there";
        } catch (e) {
          recycleError = String((e && e.message) || e);
        }
      }
      // git's removal empties the tree and drops its own record. Its LAST step is the rmdir, and on
      // Windows that fails whenever a process still has the folder as its working directory — which a
      // worktree routinely is, because the agent that built it, an editor, or a panel started from it is
      // still running. So `failed to delete …: Permission denied` does NOT mean the worktree survived: by
      // then the files and the record are gone and only an EMPTY folder is left. Treating that error as
      // a failure is what left the row on the board (re-read as a worktree with no branch) while the
      // folder stayed on disk. What git still lists is the arbiter, below.
      let gitError = null;
      if (await stillThere()) {
        try {
          await execP("git", ["-C", project.path, "worktree", "remove", "--force", target], { timeout: 90_000 });
        } catch (e) {
          gitError = String((e && e.message) || e);
        }
      }
      await execP("git", ["-C", project.path, "worktree", "prune"], { timeout: 30_000 }).catch(() => {});

      const listing = await worktreeList(project.path).catch(() => null);
      const stillRegistered = listing ? listing.some((w) => path.resolve(w.path) === target) : null;
      if (stillRegistered === true) {
        // git never let go of it: the worktree is still real, so the row has to stay and the caller has
        // to hear a failure rather than a claim of deletion.
        const why = String(gitError || "git still lists it").trim().split("\n").filter(Boolean).pop();
        return sendJson(res, 500, { error: `could not remove the worktree: ${why}` });
      }
      const heldOpen = /failed to delete|Permission denied|being used by another process|EBUSY|EPERM/i.test(
        String(gitError || ""),
      );
      if (stillRegistered === null && (await stillThere()) && gitError && !heldOpen) {
        // git's listing could not be read AND its removal failed for some other reason: nothing here
        // proves the worktree is gone, so do not pretend it is.
        return sendJson(res, 500, { error: `could not remove the worktree: ${gitError}` });
      }

      // Only the folder can disagree now. An empty leftover goes at once; one a process still holds is
      // retried here, then kept after the response until the holder exits — the row goes either way,
      // because it describes a worktree git no longer has.
      let dirLeft = await stillThere();
      for (let i = 0; dirLeft && i < 4; i += 1) {
        dirLeft = !(await removeDirNow(target));
        if (dirLeft) await sleepMs(600);
      }
      if (dirLeft) retryDirCleanup(target);
      // Whether the panel itself is what holds the folder: a panel started from this worktree cannot
      // delete it while it runs, and "restart the panel" is the only useful thing to say.
      const panelHolds = dirLeft && holdsCwd(target, process.cwd());

      // Drop by the path the STORE knows, not by `path.resolve(target)`: rows are keyed by the scanned
      // path with forward slashes, so a resolved Windows path is a different key and the row survived
      // its own deletion.
      scheduler.store.dropRow(projectName, row.path);
      // A snapshot only refreshes the rows it carries — it never retracts one — so the removal needs
      // its own event or the row sits on every open board for a worktree that no longer exists.
      broadcast({ type: "drop", project: projectName, path: row.path });
      broadcast({ type: "snapshot", data: snapshot() });
      return sendJson(res, 200, {
        ok: true,
        recycled,
        // The Recycle Bin is best effort: when it declined, say why and let the card say the files are
        // gone permanently instead of promising recoverability that does not exist.
        recycleError,
        // Files deleted, git record pruned, row dropped — and the folder itself survived because a
        // process holds it. The panel keeps trying in the background.
        dirLeft,
        panelHolds,
        path: target,
        name: row.name,
        branch: row.branch || null,
        // The key the panel and its rows use, so the browser can remove the right node.
        rowPath: row.path,
        // The folder was already gone when this ran: say so rather than pretending we removed it.
        alreadyGone: !hadDirectory,
      });
    }

    // Open a file an agent produced for the reader. Not a URL: a real path, opened in an editor.
    if (route === "/api/open-path" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const target = path.resolve(String(body.path || "").trim());
      const info = await stat(target).catch(() => null);
      if (!info || !info.isFile()) return sendJson(res, 404, { error: `no such file: ${target}` });
      const [bin, args] = await editorFor(target);
      try {
        // Detached, and no waiting: an editor stays open until the reader closes it, so an execFile
        // callback would hold this response (and the browser) hostage for the whole editing session.
        const child = spawn(bin, args, { detached: true, stdio: "ignore" });
        child.on("error", () => {});
        child.unref();
      } catch (e) {
        return sendJson(res, 500, { error: String((e && e.message) || e) });
      }
      return sendJson(res, 200, { ok: true, path: target, editor: path.basename(bin) });
    }

    // One worktree, read now — the next-read ring on a row is a button. Refused while that row is
    // already being read: two scans of one worktree at once is exactly what the pool prevents.
    if (route === "/api/refresh/row" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const projectName = String(body.project || "").trim();
      const rowPath = String(body.path || "").trim();
      const project = scheduler.getProjects().find((p) => p.name === projectName);
      if (!project) return sendJson(res, 404, { error: `unknown project: ${projectName}` });
      const row = scheduler.store.rowsFor(projectName).find((r) => r.path === rowPath);
      if (!row) return sendJson(res, 404, { error: `unknown row: ${rowPath}` });
      if (scheduler.pool.isBusy(rowPath)) return sendJson(res, 409, { error: "that row is already being read" });
      // Claim the slot, or the timer will scan it again the moment this finishes.
      scheduler.lastFast.set(`${projectName}::${rowPath}`, Date.now());
      const merged = await scheduler.scanOne(project, rowPath, "full");
      return sendJson(res, 200, { ok: true, row: merged });
    }

    // Give a worktree a name of its own: the directory and its branch. The row is looked up by path, and the whole
    // operation refuses while an agent is running in the tree - see renameWorktree().
    if (route === "/api/worktree/rename" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const out = await renameWorktree({
        projectName: String(body.project || "").trim(),
        target: String(body.path || "").trim(),
        name: String(body.name || "").trim(),
      });
      if (out.error) return sendJson(res, out.status || 500, { error: out.error });
      return sendJson(res, 200, { ...out, name: path.basename(out.path) });
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
      // Fire and forget: a sweep across every project is minutes of git work, and the button must not
      // hold the request open for it. Rows update over SSE as each fetch lands.
      void scheduler
        .fetchPass({ force: true })
        .then(() => scheduler.fullPass({ discover: true }))
        .catch(() => {});
      return sendJson(res, 200, { ok: true, started: true });
    }

    if (route === "/api/reload" && req.method === "POST") {
      config = await loadConfig();
      scheduler.stop();
      pool.close();
      pool = new Pool(config.threads);
      scheduler = new Scheduler({ config, store, pool, registry, getProjects: () => registry.projects, panelAgents: () => jobs.agentPaths(), panelThreads: () => jobs.panelRunThreads() });
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
  log(`agent transport: ${jobs.api.url} (key ${jobs.api.key ? "loaded" : "MISSING"}) | default cwd ${config.defaultCwd}`);
  void jobs.probe({ fresh: true }).then((t) => {
    if (!t.reachable) log(`agent transport UNREACHABLE: ${t.error} — spawns will be refused until the gateway is back`);
    else log(`agent transport ready: hermes ${t.capabilities?.version || "?"} · runs ${t.capabilities?.runs ? "yes" : "no"} · steer ${t.capabilities?.steer ? "yes" : "no"} · per-run cwd ${t.capabilities?.runCwd ? "yes (patched gateway)" : "NO (stock gateway — agents run in the gateway's directory)"}`);
  });
});

// Seed the store from the last known project list BEFORE anything slow.
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
