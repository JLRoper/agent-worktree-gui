// Static + JSON + SSE server for the worktree monitor, plus Stage-1 agent spawning.
// The HTTP layer never runs git: the scheduler scans in worker threads and the
// store holds the results. Spawned agents go through lib/jobs.js.
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
// The push-guard record is a few hundred bytes read at boot and written on an install: sync is the honest shape
// for it, and it is the same file the Settings row reports from.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "./lib/pool.js";
import { worktreeList } from "./lib/project.js";
import { Store } from "./lib/store.js";
import { Scheduler } from "./lib/scheduler.js";
import { ProjectRegistry } from "./lib/projects.js";
// isLiveJobStatus is main's: the 429 hold asks whether a card's run is live before it re-arms the timer.
// previewRequest is not: this commit moves both previewRequest call sites into lib/features/spawn.js, so
// server.js has no use for the name any more — the import keeps their new name and drops the moved one.
import { Jobs, hermesHome, isLiveJobStatus, makeThreadName } from "./lib/jobs.js";
import { gitIn, scanWorktree } from "./lib/scan.js";
import { mergeLabel, mergePrompt } from "./lib/merge-prompt.js";
import { verifyLabel, verifyPrompt } from "./lib/verify-prompt.js";
import { answerDeletes, answerLine, answeredChecks } from "./lib/verify-landed.js";
import { deleteWorktreeRow } from "./lib/worktree-remove.js";
import { Hosts, proposeMapping } from "./lib/hosts.js";
import { suggestWorktreeName } from "./lib/name-from-work.js";
import { TreeNames, describeNaming, tagOf, treeKey, autoNameRefusal, namingState, renameRefusal } from "./lib/tree-names.js";
import { WorktreeNaming } from "./lib/worktree-naming.js";
import { Locks, describeLock } from "./lib/locks.js";
import { createDescriptions } from "./lib/features/descriptions.js";
import { TodoLists, todoSummary } from "./lib/todos.js";import { auditRepo } from "./lib/hermes-worktrees.js";
import { ParentBook } from "./lib/parents.js";
import { Questions, applyPlan, buildPlan, inspectProject, parentWorktreeOf, readPlan, rollGate, rollUp, worktrees as stewardWorktrees, writePlan } from "./lib/steward.js";
import { RestartController, providerKeyCheck } from "./lib/restart.js";
import { Approvals } from "./lib/approvals.js";
import { RemoteWrites, POLICIES, DEFAULT_POLICY, policyFrom, policyForProject, policyLabel } from "./lib/remote-writes.js";
import { installGuard, uninstallGuard, guardState, refreshGuardFiles, normTree } from "./lib/push-guard.js";
import { safeUrl, openerFor, openerForFolder } from "./lib/open-url.js";
import { errorStatus } from "./lib/errors.js";
import {
  approvalState, writeApprovalTimeout, APPROVAL_TIMEOUT_MIN, APPROVAL_TIMEOUT_MAX,
  clarifyWindowSeconds, approvalWindowSeconds,
  sessionSettings, writeSessionListLimit, SESSION_LIST_MIN, SESSION_LIST_MAX,
  providerState, writeProviderSettings,
} from "./lib/hermes-config.js";
import { hermesSessionTail } from "./lib/activity.js";
import { Assistant, ASSISTANT_THREAD } from "./lib/assistant.js";
import { childTranscript, collectPrompt, subagentsFor, subagentRoster } from "./lib/subagents.js";
import { thinkingFor } from "./lib/thinking.js";
import { modelCatalogue, refreshModelCatalogue } from "./lib/hermes-models.js";
import { createSpawn } from "./lib/features/spawn.js";
// The panel's own directories, and every state path derived from them. Nothing below builds one of those
// paths itself any more: `resolveDirs` answers where, `statePaths` answers which file.
import {
  cleanScratch, ensureDirs, humanBytes, measureSize, migrateState, readMigrationJournal, resolveConfigPath, resolveDirs,
  SCRATCH_MARKER, sizeOf, statePaths,
} from "./lib/paths.js";
// HTTP framing lives in lib/http/: transport.js knows about req/res and nothing about worktrees,
// and static.js serves public/. Both are handed the state they used to read by closure.
import { authorised, handleStream, readBody, readRawBody, sendJson } from "./lib/http/transport.js";
import { serveStatic, PUBLIC_DIR } from "./lib/http/static.js";
import { createBuild } from "./lib/build-version.js";

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
// The panel's version is declared once, in package.json: read it here so the page can say which
// build is running without a second copy to keep in step.
const VERSION = await readFile(path.join(HERE, "package.json"), "utf8")
  .then((t) => JSON.parse(t).version || null)
  .catch(() => null);
// PANEL_CONFIG lets a second instance run from the same code with its own config and port —
// a sandbox or a demo you can click around in without touching the real one:
//   set PANEL_CONFIG=C:\path\to\panel-config.json && node server.js
//
// Otherwise the file has two homes, and lib/paths.js decides between them: `<dataDir>/config.json` when an
// install has been moved there, else `config.json` beside this checkout — so an existing install keeps
// running untouched, and moving the file is what opts into the new home.
const CONFIG_FILE = resolveConfigPath({ here: HERE });
const CONFIG_PATH = CONFIG_FILE.path;
// The folder the config was read from. It is a PROTECTED path (the clean route must never empty it) and the place a
// second instance keeps its own files, never a place to derive a state file from: that is lib/paths.js's job, and a
// guard in test/paths.test.js fails on any other `path.dirname(CONFIG_PATH)`.
const CONFIG_DIR = path.dirname(CONFIG_PATH);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// The versioned static bundle: one hash over everything the shell loads, computed here at boot and
// re-read when a file under public/ moves. The shell's asset URLs carry it and GET /api/build
// answers with it — that is how a tab open since yesterday learns the panel changed.
const build = createBuild({ publicDir: PUBLIC_DIR, log });
const buildAtBoot = await build.current();

// How old a worktree's last activity has to be before the chart holds its row out of the view it opens on (the row
// is never lost — one arrow on that chart shows every tree again). Measured from ACTIVITY, never from when the
// directory was created: a tree cut months ago that somebody is working in right now is not stale, and hiding it
// would be the one thing this setting must not do. 0 shows everything.
//
// A value that cannot be read as a number or a count of days falls back to the DEFAULT rather than to 0: an
// unreadable number must never silently switch a filter off (and Number(null) is 0, so "absent" is handled first).
const AGE_DAYS_DEFAULT = 7;
const AGE_DAYS_MAX = 3650;
function ageDaysFrom(value) {
  if (value == null || value === "") return AGE_DAYS_DEFAULT;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return AGE_DAYS_DEFAULT;
  return Math.min(AGE_DAYS_MAX, Math.round(n));
}

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
  // The token that gates writes from other machines comes from the ENVIRONMENT, never from this file.
  // config.json is tracked by git, so a secret in it is a secret in the repository and in every clone of it.
  // PANEL_TOKEN is read once, at boot; if it is missing or empty there is simply no token, and authorised()
  // then REFUSES every non-loopback write rather than letting one through — the door closes when the variable
  // is absent, it does not open. A leftover "token" key in the file is ignored, loudly, so an old secret cannot
  // look like it is doing something.
  const fileToken = typeof cfg.token === "string" ? cfg.token.trim() : "";
  const envToken = String(process.env.PANEL_TOKEN || "").trim();
  cfg.token = envToken || null;
  if (fileToken) {
    log(envToken
      ? 'config.json still has a "token" key — ignoring it: PANEL_TOKEN from the environment wins, so remove the key from the file'
      : 'config.json has a "token" key but no PANEL_TOKEN in the environment — the file\'s token is IGNORED; set PANEL_TOKEN or writes from other machines stay refused');
  }
  cfg.refreshSeconds = Number(cfg.refreshSeconds ?? 30);
  cfg.worktreeSeconds = Number(cfg.worktreeSeconds ?? 5);
  cfg.midSeconds = Number(cfg.midSeconds ?? 30);
  cfg.dormantSeconds = Number(cfg.dormantSeconds ?? 60);
  cfg.slowSeconds = Number(cfg.slowSeconds ?? 60);
  cfg.fetchSeconds = Number(cfg.fetchSeconds ?? 600);
  cfg.threads = Number(cfg.threads) || Math.max(1, Math.min(4, cpus().length - 1));
  // How old a worktree's last activity has to be before the chart hides its row. Server-side, like scanMode below:
  // it lives in this file so it survives a restart and applies to every browser.
  cfg.hideOlderThanDays = ageDaysFrom(cfg.hideOlderThanDays);
  cfg.projects = Array.isArray(cfg.projects) ? cfg.projects : [];
  if (!cfg.defaultCwd) cfg.defaultCwd = cfg.projects[0]?.path || process.cwd();
  // "all": keep every project fresh, whether or not anyone is looking at it. "visible": the page reports which
  // project sections are on screen and only those are re-read - with ~100 projects that is most of the git work
  // the board does. The setting lives in this file so it survives a restart and applies to every browser.
  cfg.scanMode = String(cfg.scanMode || "all").toLowerCase() === "visible" ? "visible" : "all";
  // ---- where the panel keeps things ----------------------------------------------------------------
  // Two directories, resolved once, here, by lib/paths.js — and every state file derived from the data one.
  // This used to be eleven separate `path.dirname(CONFIG_PATH)` lines, which put the job store, the assistant,
  // the TODOs, the naming ledger, the labels and the push-guard record INSIDE the checkout: a fresh clone opened
  // on an empty board, a re-clone lost the history, and `git status` could never be trusted to be about the code.
  //
  // `dataDir` is the durable half (default `~/.wag`), `scratchDir` the throwaway half (default `<os tmpdir>/wag`).
  // Explicit `dataDir` / `scratchDir` keys win, then WAG_HOME / WAG_SCRATCH, then those defaults — and the source
  // of each travels with it, so the Settings row can answer "why is my board empty" without a docs hunt.
  //
  // A config that names one of these files itself still wins (that is how a sandbox points at its own store); the
  // rest follow it, which is the behaviour every existing `PANEL_CONFIG` sandbox relies on.
  //
  // A PANEL_CONFIG instance that names no `dataDir` is a second instance, and it keeps its own folder: it resolves
  // to `<dir of its config>/logs` (flat, as it always did) and ignores WAG_HOME / WAG_SCRATCH. Resolving it to the
  // shared `~/.wag` instead would point every verify tool and test sandbox at the reader's live job store.
  const dirs = resolveDirs({ config: cfg, configSource: CONFIG_FILE.source, configDir: CONFIG_DIR });
  cfg.dataDir = dirs.dataDir;
  cfg.dataDirSource = dirs.dataSource;
  cfg.dataLayout = dirs.dataLayout;
  cfg.scratchDir = dirs.scratchDir;
  cfg.scratchDirSource = dirs.scratchSource;
  Object.assign(cfg, statePaths(cfg));
  // The assistant's `assistant` block is an optional set of knobs (mode, model, rule escalations) that the page can
  // also change at runtime. It is not a path, but it is read by the same callers, so it is resolved here too.
  cfg.assistant = cfg.assistant && typeof cfg.assistant === "object" ? cfg.assistant : {};
  // `assistant.cwd` (lib/assistant.js) defaults to `assistant-cwd` beside `assistantFile`, so it follows this store
  // into the data directory with no extra key: state, not source, and never a folder inside the checkout.
  // The locks, the parent book, the steward's plan files (`stewardDir`) and its questions ledger, the model prices, the
  // push-guard record, the host mappings and the branch-parent ledger are state like everything above: lib/paths.js
  // derives every one of them beside the job store, so they follow it into the data directory.
  // `steward.prodBranch` names the one branch a roll-up must never be done inline: production is handed to a worker
  // (or a TO), never merged by editing a tree. null means this project has no such branch.
  cfg.steward = cfg.steward && typeof cfg.steward === "object" ? cfg.steward : {};
  if (!("prodBranch" in cfg.steward)) cfg.steward.prodBranch = null;
  cfg.stewardRefreshSeconds = Number(cfg.stewardRefreshSeconds) > 0 ? Number(cfg.stewardRefreshSeconds) : 300;
  // Where each project's branches and pull requests live (lib/hosts.js). The live file (`hostsFile`) is reader-edited state,
  // so lib/paths.js puts it beside the job store above, and not in projects.json, which the discovery sweep rewrites every
  // pass. The SEED is the opposite: it ships with the code (hosts.seed.json next to this file) and supplies defaults the
  // live file overrides.
  if (!cfg.hostsSeedFile) cfg.hostsSeedFile = path.join(HERE, "hosts.seed.json");
  // Whether a branch may exist on a REMOTE at all: the setting the reader's permission box writes, and what the
  // installed pre-push guard reads. local-only by default — a value that cannot be read falls back to it rather
  // than to a permissive one.
  cfg.remoteBranchPolicy = policyFrom(cfg.remoteBranchPolicy);
  // How long a parked remote-write question waits before it is denied: the guard's own poll window as well, since
  // the panel hands it this number at install time.
  cfg.remoteWriteSeconds = Number(cfg.remoteWriteSeconds) > 0 ? Math.min(3600, Number(cfg.remoteWriteSeconds)) : 300;
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

let config = await loadConfig();
// ---- both directories exist before anything writes into them --------------------------------------
// Nothing is created lazily any more: a boot that dies between "store opened" and "attachment saved" used to leave
// a half-made `logs/`, and the next boot could not tell that from a fresh install. `ensureDirs` is `mkdir -p`, so
// two panels racing on one data directory is a no-op rather than a failure.
const madeDirs = ensureDirs(config);
for (const target of madeDirs.made) log(`created ${target}`);
log(`data directory: ${config.dataDir} (${config.dataDirSource}) · scratch directory: ${config.scratchDir} (${config.scratchDirSource})`);
// ---- the one-time move off the checkout -----------------------------------------------------------
// An install that has been running from a checkout keeps its whole history in `<repo>/logs`. The first boot with a
// data directory that holds no store COPIES it across. Never moved, never deleted: a downgrade, a second build, or a
// reader who deliberately points PANEL_CONFIG at the old file all still find what was there. The line names the
// count and the directory so a board that comes up full of last week's cards is explainable from the log alone.
const stateMigration = migrateState({
  dataDir: config.dataDir,
  stateFile: config.jobsFile,
  legacyDir: path.join(CONFIG_DIR, "logs"),
  layout: config.dataLayout,
  onLog: log,
});
// A second instance (PANEL_CONFIG, no dataDir) has nothing to move, and saying so on every sandbox boot is noise.
if (!stateMigration.migrated && stateMigration.reason && stateMigration.reason !== "no job store beside the checkout" && config.dataLayout !== "flat") {
  log(`state migration skipped: ${stateMigration.reason}`);
}
// Start the two size readings in the background so the first /api/state (and the first Settings open) finds a number
// waiting. They are async walks: a scratch folder holding a copied checkout must not hold up the listener.
void measureSize(config.dataDir).catch(() => {});
void measureSize(config.scratchDir).catch(() => {});
// What the data directory's own journal says about where its board came from. Read once, here: the journal only
// changes at boot, and /api/state is polled far too often to read a file for it.
const lastMigration = readMigrationJournal(config.stateDir).slice(-1)[0] || null;
let pool = new Pool(config.threads);
const store = new Store();
// A tree's name is the panel's fact, never git's. The ledger of which trees have a name, who gave it and when
// (lib/tree-names.js) is read before anything can rename a tree and written the moment the panel learns one:
// at the cut for a tree this panel makes, at first sight for a tree that was already there.
const treeNames = new TreeNames({ file: config.treeNamesFile, log });
// Where each project's branches and pull requests live. The file is created on first boot (empty: the defaults are
// hosts.seed.json's) so the reader has something to edit, and lib/hosts.js merges the seed under it per host id and
// per project — a new seed record reaches this install without anybody merging JSON by hand.
const hosts = new Hosts({
  file: config.hostsFile,
  seedFile: config.hostsSeedFile || "hosts.seed.json",
  log: (line) => log(line),
});
const hostsFile = hosts.ensure();
for (const warning of hosts.doc().warnings) log(`hosts: ${warning}`);
const registry = new ProjectRegistry({
  getConfig: () => config,
  store,
  onLog: log,
  // Last successful sweep, so a restart opens on the board it had instead of "no git repos found". Resolved by
  // lib/paths.js — it used to default to a path relative to the process cwd, which a sandbox then shared with the
  // live board while its own seeded rows stayed invisible.
  cacheFile: config.projectsCacheFile,
});
let scheduler = new Scheduler({
  config,
  store,
  pool,
  registry,
  hosts,
  getProjects: () => registry.projects,
  panelAgents: () => jobs.agentPaths(),
  panelThreads: () => jobs.panelRunThreads(),
  // Every worktree a listing turns up, before it becomes a row: the naming ledger's seeding (see seedTreeName).
  onWorktreeSeen: (project, tree) => seedTreeName(project, tree),
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

// One part of a job event's handling must not be able to take the rest down with it. `broadcast` writes to every
// open SSE client, `adoptFromJob` reads the project registry and the assistant observer runs the finished turn's
// actions — three unrelated jobs on one line, and a throw from any of them would land inside the job store's own
// emit. Say which part failed and carry on.
function guard(what, fn) {
  try {
    return fn();
  } catch (err) {
    log(`${what} failed: ${String((err && err.message) || err)}`);
    return null;
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
// The restart controller: the queue, the provider-key preflight, the one-terminal-status snapshot, the
// real-turn proof and the single resume wake. Declared before the assistant because the assistant is
// handed its `request` as the one act it cannot perform itself.
let restart = null;
// Declared before the job stream that feeds it: a job event arrives on the same tick as construction,
// and the observer is optional until the assistant exists.
let assistant = null;
// Declared before the job stream that feeds it. The naming policy itself is created below, once the ledger and the
// panel's own worktree cut are wired; an event that arrives before then is not lost — the 10-second title sweep
// emits again for any card that still has no name.
let naming = null;
const jobs = new Jobs({
  config,
  onEvent: (evt) => {
    guard("event broadcast", () => broadcast(evt));
    guard("worktree adopt", () => adoptFromJob(evt));
    // Every event that carries a session title is a chance to give a tree the name its run chose for it — the
    // sweep that emits on the first title, the run's own events, and the settle that follows. The policy (which
    // tree, which run, and the ledger that allows it exactly once) is lib/worktree-naming.js; a rename is never
    // worth failing a job event over, so the whole call is fire-and-forget.
    guard("worktree naming", () => void naming?.consider(evt?.job));
    // A run that just arrived (or changed) is a new chance to learn what a tree was started to do: the earliest
    // brief in a tree is in this store, and a harvest is collapsed into one pass per couple of seconds.
    guard("description harvest", () => descriptions.harvest());
    guard("assistant observation", () => assistant?.observe(evt));
  },
  onLog: log,
  // Read per question, not once at boot: the file is small and the gateway re-reads it too, so a countdown
  // matches the wait the gateway is actually enforcing.
  clarifyWindow: () => clarifyWindowSeconds(),
  // The same for an approval, which the gateway gives up on at `approvals.timeout`: without it the card kept
  // offering "Allow once" long after the gateway had already denied the command and moved on.
  approvalWindow: () => approvalWindowSeconds(),
});
// Where the work of a card whose run the gateway has forgotten still is: the tree the turn ran in, and the PR its
// branch has. Read from the board's own rows — a scan already carries the PR per branch (lib/scheduler.js), so this
// is a lookup, not a measurement: no git call, no gh call, and nothing the boot reconcile would have to pay per
// card. The manual press is its only caller.
function gonePointers(id) {
  const j = jobs.get(id);
  if (!j) return null;
  const store = scheduler.store;
  const wanted = [j.worktreePath, j.ownerPath, j.cwd].filter(Boolean).map(normPathKey);
  // The rows are the store's, keyed by "<project>::<path>", so the search walks that store's own project names:
  // discovery publishes a project to the registry on its own clock, and a press must not miss a row that is already
  // on the board just because the registry has not named its project yet.
  let found = null;
  for (const name of store.projects.keys()) {
    const hit = (store.rowsFor(name) || []).find((r) => wanted.includes(normPathKey(r.path))) || null;
    if (hit) {
      found = { project: store.projects.get(name), row: hit };
      break;
    }
  }
  const row = found?.row || null;
  const pr = row?.pr || null;
  return {
    worktree: row?.path || j.worktreePath || j.ownerPath || j.cwd || null,
    branch: row?.branch || j.branch || null,
    // The scan's PR index carries the number, the state and the title; the URL is the one form of a pointer the
    // console renders as a link, and it comes from the project's host record — the same template the board's PR cell
    // uses. No host mapping means no URL: the console then shows the PR number and says where the mapping is missing
    // rather than sending the reader to a github.com page that may not exist.
    pr: pr
      ? {
          number: pr.number,
          state: pr.state || null,
          title: pr.title || null,
          url: hosts.linkFor(found?.project || { name: "" }, "pull", { pr: pr.number, branch: row?.branch, sha: row?.head, main: found?.project?.mainBranch }).url || null,
        }
      : null,
  };
}

// Human side of the Hermes approval-transport contract: the plugin presents, the panel answers,
// the host decides. Nothing here can approve anything by itself.
const approvals = new Approvals({ onEvent: broadcast });

// ---- who may put a branch on a remote ------------------------------------------------------------
// The reader's rule: a worktree the panel cuts is LOCAL ONLY unless the work is going to land. The setting
// (`remoteBranchPolicy`) is the standing answer, the permission box is how an exception is granted, and the
// installed pre-push guard is what makes the default hold against a worker's own `git push`. Three surfaces, one
// decision — RemoteWrites owns it, this block is only the wiring.
//
// Which worktrees carry the guard, and when it went in. git holds the hooks path itself; this is the panel's list
// of what it installed, so the Settings row can report it without walking 90 repositories' git dirs.
function readGuardRecord() {
  try {
    const raw = JSON.parse(readFileSync(config.pushGuardFile, "utf8"));
    return raw && typeof raw === "object" && raw.trees ? raw : { version: 1, trees: {} };
  } catch {
    return { version: 1, trees: {} };
  }
}
function writeGuardRecord() {
  try {
    mkdirSync(path.dirname(config.pushGuardFile), { recursive: true });
    writeFileSync(config.pushGuardFile, `${JSON.stringify(guardRecord, null, 2)}\n`, "utf8");
  } catch (e) {
    log(`could not write ${config.pushGuardFile}: ${String((e && e.message) || e)}`);
  }
}
const guardRecord = readGuardRecord();

// The url the guard calls back on. Loopback on purpose: the hook runs on this box, and a loopback request is never
// challenged for the panel token (authorised), so the guard needs no secret of its own.
const guardPanelUrl = () => `http://127.0.0.1:${config.port}`;

// THE POLICY IN FORCE FOR ONE PROJECT. The global `remoteBranchPolicy` is the default for every checkout here; a
// project's own entry in config.json overrides it. That override is not a nicety: this panel and heroes-js LAND by
// pushing a branch and opening a PR, so a blanket local-only would refuse their own landing path, while every other
// repository on this box is local work whose child branches must merge into their parent instead of appearing on a
// shared remote. Unknown names and unreadable values fall back to the global (lib/remote-writes.js `policyForProject`).
const guardPathKey = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
function policyForProjectPath(projectPath, project = null) {
  if (project) return policyForProject(project, config.remoteBranchPolicy);
  const key = guardPathKey(projectPath);
  const found = key ? registry.projects.find((p) => guardPathKey(p.path) === key) || null : null;
  return policyForProject(found, config.remoteBranchPolicy);
}

// Install (or refresh) the guard for ONE worktree and remember it. Called the moment the panel cuts a tree, and by
// the Settings button for trees that predate this feature.
async function installGuardFor({ projectPath, worktree, branch = null, landing = false, project = null }) {
  // `project` is the registry record when the caller has it (the spawn path does); a Settings install passes the path
  // alone. Either way the guard's own copy of the policy is the PROJECT's, not the global one.
  const policy = policyForProjectPath(projectPath, project && typeof project === "object" ? project : null);
  const out = await installGuard({
    projectPath,
    worktree,
    panelUrl: guardPanelUrl(),
    timeoutSeconds: config.remoteWriteSeconds,
    policy,
    landing: [...remoteWrites.landing],
    log,
  });
  if (!out.ok) return out;
  // A tree started to LAND is allowed to push by design; recorded on the panel side too, so the guard's own file
  // and this process agree about it.
  if (landing) remoteWrites.markLanding(worktree);
  guardRecord.trees[normTree(worktree)] = {
    tree: normTree(worktree),
    path: cleanPath(worktree),
    project: (project && typeof project === "object" ? project.name : project) || path.basename(projectPath || ""),
    projectPath: cleanPath(projectPath || worktree),
    branch: branch || null,
    landing: Boolean(landing),
    // The policy this tree's guard was actually written with, so the Settings row can never show the global one for a
    // project that overrides it.
    policy,
    dir: out.dir,
    at: new Date().toISOString(),
  };
  writeGuardRecord();
  log(`push guard installed: ${cleanPath(worktree)} -> ${out.dir} (policy ${policy}${policy !== config.remoteBranchPolicy ? ` — this project's own, the global is ${config.remoteBranchPolicy}` : ""}${landing ? ", started to land" : ""})`);
  return { ...out, policy };
}

// The panel's own worktree creation (lib/jobs.js calls this) — the one place a spawned tree is cut, so it is the
// one place the guard has to go in.
jobs.afterWorktreeCreate = async ({ repoDir, path: tree, branch, landing }) => {
  try {
    const project = registry.projects.find((p) => normPathKey(p.path) === normPathKey(repoDir));
    // The record, not its name: it carries this project's own `remoteBranchPolicy`, which is what the guard must obey.
    return await installGuardFor({ projectPath: repoDir, worktree: tree, branch, landing, project: project || null });
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
};

// Every guard the panel installed gets the current setting and the current landing list written into it. Cheap: a
// handful of one-word files, one call per project.
async function refreshGuards() {
  const dirs = new Map();
  for (const rec of Object.values(guardRecord.trees)) if (rec?.projectPath) dirs.set(normTree(rec.projectPath), rec.projectPath);
  const landing = [...remoteWrites.landing].map((t) => guardRecord.trees[t]?.path || t);
  const out = [];
  for (const [key, projectPath] of dirs) {
    // Each project's guard gets ITS policy: a settings change of the global must not overwrite a project that
    // carries its own answer, and an "Always allow" click must not turn every other checkout's default off either.
    const policy = policyForProjectPath(projectPath);
    const r = await refreshGuardFiles({ projectPath, panelUrl: guardPanelUrl(), timeoutSeconds: config.remoteWriteSeconds, policy, landing, log });
    out.push({ project: key, policy, ...r });
  }
  return out;
}

// What the Settings row reports, and what the tests read: which trees carry the guard, what it replaced, and which
// of them were started to land. The record is the panel's own — this is one file read, never a git call per tree.
function guardReport() {
  const trees = Object.values(guardRecord.trees || {});
  const projects = new Set(trees.map((t) => normTree(t.projectPath)).filter(Boolean));
  return {
    file: config.pushGuardFile,
    count: trees.length,
    projects: projects.size,
    landing: [...remoteWrites.landing],
    dirs: [...new Set(trees.map((t) => t.dir).filter(Boolean))],
    latest: trees
      .slice()
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 8)
      .map((t) => ({ tree: t.path, project: t.project, branch: t.branch, landing: Boolean(t.landing), at: t.at })),
  };
}

// "Always allow" in the permission box IS this setting, so the box and Settings cannot tell two different stories.
async function setRemotePolicy(policy, { by = "reader", why = "" } = {}) {
  const clean = policyFrom(policy, config.remoteBranchPolicy);
  try {
    await patchPanelConfig({ remoteBranchPolicy: clean });
  } catch (e) {
    return { error: `could not write the setting: ${String((e && e.message) || e)}` };
  }
  const before = config.remoteBranchPolicy;
  config.remoteBranchPolicy = clean;
  log(`remoteBranchPolicy: ${before} -> ${clean}${by ? ` (by ${by}${why ? `: ${why}` : ""})` : ""}`);
  await refreshGuards();
  broadcast({ type: "settings", settings: settingsOut() });
  return { ok: true, policy: clean, before };
}

const remoteWrites = new RemoteWrites({
  getPolicy: () => config.remoteBranchPolicy,
  onEvent: broadcast,
  onLog: log,
  timeoutSeconds: config.remoteWriteSeconds,
  onPolicy: (policy, { by, why }) => setRemotePolicy(policy, { by, why }),
  // A grant reaches the guard's own files too, so a tree the reader allowed does not have to reach the panel to
  // find that out — and a tree started to land keeps its permission across a panel restart.
  onGrant: () => void refreshGuards(),
});

// ---- spawning ---------------------------------------------------------------------------
// The New-agent card, its preview and the assistant's spawner all ask the same question, so they
// ask it in one place (lib/features/spawn.js), named `spawnFeature` because node:child_process
// already owns `spawn` in this module. The two answers that go stale are passed as getters:
// /api/reload replaces `config` wholesale, and every registry refresh replaces the project array.
const spawnFeature = createSpawn({
  getConfig: () => config,
  getProjects: () => registry.projects,
  jobs,
});

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
  spawner: spawnFeature.assistantSpawnRun,
  // The one act this module cannot perform itself: a RESTART line's gateway/panel restart, queued by
  // the controller and run only once the turn that asked for it has ended.
  onRestart: (spec) => restart.request(spec),
  onEvent: broadcast,
  onLog: log,
});
// The assistant's own working directory, created before the first turn so it cannot be refused by the
// gateway: this thread does no file work, and borrowing a project checkout is what broke a live panel when
// that checkout had been deleted. Logged once, so the path is never a mystery in the boot log.
log(`assistant cwd: ${assistant.ensureCwd()}`);
assistant.start();

// ---- restarting the gateway, or this panel ---------------------------------------------
// Everything that touches the outside world is injectable (lib/restart.js), which is what lets
// tools/verify-restart.mjs prove the queueing, the health wait and the resume without bouncing the
// live gateway or the live panel.
restart = new RestartController({
  config,
  jobs,
  assistant,
  home: hermesHome(),
  hermesBin: config.hermesBin || null,
  credentials: () => jobs.api,
  log,
  onState: (state) => broadcast({ type: "restart", restart: state }),
  // A panel restart exits through the same path a signal uses, so the replacement can bind the port.
  shutdown: (code) => shutdown(code),
});
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

// A panel restarted by its own restart action left a record: the replacement waits for the gateway,
// proves it with ONE REAL TURN (never with the port), and only then wakes the assistant once with
// the completion payload of everything the restart interrupted. A clean boot has no record and costs
// nothing.
setTimeout(() => {
  void restart.resumePending().catch((e) => log(`restart resume failed: ${String((e && e.message) || e)}`));
}, 3_000).unref?.();

// A gateway restart nobody asked for. Runs stop reporting while the panel is still up: their streams
// dropped and the gateway no longer knows the run ids. Every run it lost is given ONE terminal status
// (interrupted, with the restart recorded as what ended it) and the same single resume wake the panel
// fires for a restart it did ask for. Swept here rather than in the sentry: the sentry owns no network
// call, and this is the only place that can see a run stop reporting.
let sweepingOrphans = false;
setInterval(() => {
  if (sweepingOrphans || !assistant) return;
  sweepingOrphans = true;
  void jobs
    .sweepOrphanedRuns()
    .then((lost) => {
      if (!lost.length) return;
      log(`gateway restart detected: ${lost.length} run(s) stopped reporting (${lost.map((j) => j.id).join(", ")})`);
      assistant.wakeAfterRestart(lost, {
        target: "gateway",
        detected: true,
        reason: "the gateway was restarted and the panel did not ask for it",
      });
    })
    .catch((e) => log(`orphan sweep failed: ${String((e && e.message) || e)}`))
    .finally(() => {
      sweepingOrphans = false;
    });
}, 15_000).unref?.();

// The installed guards read their policy from files of their own, so a config.json edited by hand while the panel
// was down is mirrored into them once at boot. Silent when nothing is installed, which is the case on a fresh clone.
setTimeout(() => {
  void refreshGuards()
    .then((out) => {
      const refreshed = out.filter((o) => o && o.ok);
      if (refreshed.length) log(`push guard: ${refreshed.length} project(s) refreshed at boot (policy ${config.remoteBranchPolicy})`);
    })
    .catch((e) => log(`push guard refresh failed at boot: ${String((e && e.message) || e)}`));
}, 4_000).unref?.();
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
  hideOlderThanDays: config.hideOlderThanDays,
  threads: config.threads,
  host: config.host,
  defaultCwd: config.defaultCwd,
  worktreeSource: String(config.discovery?.worktreeSource || "git").toLowerCase(),
  scanMode: config.scanMode === "visible" ? "visible" : "all",
  scanVisible: scheduler ? scheduler.visibilityReport() : null,
  // Whether a branch may exist on a remote at all. It travels with every snapshot because the Settings row, the
  // spawn card's default and the permission box all read the same fact — and the guard's own copy of it is written
  // from here too, so a hook cannot be reading a different policy than the page shows.
  remoteBranchPolicy: config.remoteBranchPolicy,
  remoteBranchPolicyLabel: policyLabel(config.remoteBranchPolicy),
  // The policy actually in force per project, because the global is only the default: a project's own entry in
  // config.json (this panel, heroes-js) overrides it, and the page must be able to say which repo is which.
  remoteBranchPolicies: Object.fromEntries(
    (registry?.projects || []).map((p) => [p.name, policyForProject(p, config.remoteBranchPolicy)]),
  ),
  remoteWriteSeconds: config.remoteWriteSeconds,
  spawnEnabled: true,
});

const normPathKey = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// ---- renaming a worktree ---------------------------------------------------------------------
// A tree is cut from the prompt, so its name is the prompt: cut at 24 characters, usually mid-word, and about what the
// reader typed rather than what the agent worked out it was doing. Renaming it is the directory and the branch plus
// the panel's own bookkeeping - the jobs that ran there (a run's body carries its cwd), the store's row, and the row
// the board draws.
//
// A tree is named ONCE, and the record of that (who, when — lib/tree-names.js, constructed above) is what stops a
// name churning. There are exactly two ways a name is written: the automatic half (`once: true`, from the run that
// CUT the tree, the moment its session title first exists) and the deliberate half (the ✎ and the ✦ in the row, i.e.
// a reader asking), which may replace a name because replacing a name is the point of it. A tree the panel found
// rather than cut is seeded under the name it was found with and is never the automatic half's to move. Either way
// the six-hex tag is kept and the 409 stands while an agent is running in the tree.
//
// Seeding is what makes the first of those safe. Every tree the panel enumerates and has never recorded is written
// down under its CURRENT name, attributed to the panel, before a run can be offered the chance to rename it: the
// fleet that existed when the ledger shipped has no entry, and "no entry" used to read exactly like "a tree waiting
// for its one name" — so nothing but the job's own `existing` flag stood between those trees and a rename, and a flag
// set wrong moved a tree the reader considers fixed.
function seedTreeName(project, tree) {
  try {
    const dir = String(tree?.path || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (!dir) return false;
    // The project's own checkout is not a tree the panel names, and `renameWorktree` refuses it by this same
    // comparison. A record for it would also put "named by the panel" on the one row whose name is the folder's.
    if (normPathKey(project?.path) && normPathKey(project.path) === normPathKey(dir)) return false;
    const name = path.basename(dir);
    const branch = String(tree?.branch || "").replace(/^refs\/heads\//, "") || null;
    const key = treeKey({ project: project?.name, path: dir, branch });
    const rec = treeNames.seed(key, {
      name,
      dir,
      branch,
      tag: tagOf(dir) || tagOf(branch) || null,
      by: "the panel",
      how: "seeded — this tree was already here the first time the panel listed it, so its name is the one it had",
      at: new Date().toISOString(),
    });
    if (rec) log(`tree-names: seeded ${project?.name || "?"}::${name} as it was found — this name is fixed`);
    return Boolean(rec);
  } catch (e) {
    log(`tree-names: could not seed ${tree?.path || "a tree"}: ${String((e && e.message) || e)}`);
    return false;
  }
}

// One `git worktree list` per project at boot, so the fleet that predates the ledger is written down before the
// first job event is considered for naming. Bounded in time and width, and it never rejects: a project whose git
// cannot answer is seeded by its own discovery pass instead, which calls the same hook on every listing.
async function seedTreeNamesAtBoot({ timeoutMs = 30_000, width = 4 } = {}) {
  const started = Date.now();
  const projects = (registry.projects || []).slice();
  let next = 0;
  let seeded = 0;
  const lane = async () => {
    while (next < projects.length && Date.now() - started < timeoutMs) {
      const project = projects[next++];
      if (!project?.path) continue;
      try {
        const trees = await worktreeList(project.path);
        for (const t of trees) if (seedTreeName(project, t)) seeded += 1;
      } catch {
        /* no answer from git here: discovery will seed this project's trees on its next listing */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, projects.length)) }, lane));
  if (seeded) log(`tree-names: ${seeded} tree(s) had no record and now do — their names are fixed from here`);
  else log(`tree-names: ${treeNames.size} tree(s) on record, nothing to seed at boot`);
  return seeded;
}

// Started here, before the job store is constructed: a restored run's event can name a tree the moment the store
// loads, and that must not beat the seeding. WorktreeNaming awaits this before it decides anything.
const treeNamesReady = seedTreeNamesAtBoot();

// ---- the reader's locks ---------------------------------------------------------------------------------------
// A worktree or a branch the reader has locked (lib/locks.js): the one record here that is the reader's and not
// git's, persisted under logs/ so it survives a restart, and consulted before ANY delete touches a tree. The row
// wears it as an emoji, so an agent reading the board sees the lock without opening anything.
const locks = new Locks({ file: config.locksFile, log });

// Where every tree the panel cuts was cut from (lib/parents.js), and the ledger of trees nobody can place. Both are
// read by the /api/state row through the scheduler's scan context, so the board and the steward never disagree.
const parents = new ParentBook({ file: config.parentsFile, onLog: log });
const questions = new Questions({ file: config.stewardQuestionsFile });

const descriptions = createDescriptions({
  getConfig: () => config,
  // The RAW maps, not list()/rowsFor(): the earliest brief in a tree needs `prompt` and `startedAt`,
  // which those projections trim on purpose.
  getJobs: () => jobs.jobs,
  getRows: () => store.rows,
  normPathKey,
  snapshot,
  broadcast,
  guard,
  log,
});

// ---- the TODO list of each worktree --------------------------------------------------------------------------------
// Written by the assistant (a `TODO <text>` line, normally under the SPAWN that starts the work), kept current by
// every agent in the tree (a run's FINAL message is harvested when it settles), and read by the row. ONE store for
// the whole panel, keyed the way the row already is (`keyOf(project, path)` — `${project}::${path}` in
// public/app.js), and never a file inside the worktree: it is state, not source, and a file in the tree would be git
// noise and a merge conflict. Every writer goes through this one Node process, so the store is its own lock.
const todos = new TodoLists({
  file: config.todosFile,
  log,
  // The trees this store may NAME — a path, a directory name, a branch, a six-hex tag, a thread. Read per question,
  // never captured: a rename moves a row and the store must see the new one.
  trees: () => {
    const out = [];
    const seen = new Set();
    for (const p of registry.projects || []) {
      const key = `${p.name}::${normPathKey(p.path)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ project: p.name, path: String(p.path || "").replace(/\\/g, "/"), branch: null });
    }
    for (const [rowKey, row] of store.rows) {
      const project = String(rowKey).split("::")[0];
      const n = `${project}::${normPathKey(row.path)}`;
      if (seen.has(n)) continue;
      seen.add(n);
      out.push({ project, path: String(row.path || "").replace(/\\/g, "/"), branch: row.branch || null });
    }
    return out;
  },
  // …and the job store, so a THREAD can name its tree (that is how the assistant points a TODO line at a card).
  jobs: () => jobs,
});
// The two writers that need the store: lib/jobs.js prepends the list to a worker's brief and harvests the run's own
// last words; the assistant seeds a tree and keeps the list honest against what a worker actually did.
jobs.todos = todos;
// The parent book: the panel records every tree it cuts (lib/jobs.js), the scheduler hands the answer to each scan so
// the row carries it, and the steward + the UNMERGED chip read it from there.
jobs.parents = parents;
scheduler.parents = parents;
if (assistant) {
  assistant.todos = todos;
  // …and the one thing the assistant cannot do itself: tell the page a list moved. The assistant's own TODO lines are
  // applied inside its harvest, which has no SSE handle of its own.
  assistant.todosChanged = broadcastTodos;
}

// The list travels with the snapshot the way a description does: the row carries the counts, the OLDEST incomplete
// item (the one thing the collapsed strip reads) and the items themselves. A tree with no list carries no `todo`
// field at all, so the section is simply absent rather than an empty box.
function withTodos(snap) {
  for (const project of snap.projects || []) {
    for (const row of project.worktrees || []) {
      const rec = todos.forRow(project.name, row.path);
      if (!rec) {
        delete row.todo;
        continue;
      }
      row.todo = rec;
    }
  }
  return snap;
}

// A list that changed is a row that changed: the same full snapshot the description harvest sends, so the strip
// repaints without waiting for the next scan to happen to mention that row.
function broadcastTodos() {
  broadcast({ type: "snapshot", data: snapshot() });
}

// What the page says after a reader's own press. It names the item and the id, because the id is what the assistant
// and every worker are told to write, and a press that says nothing is a press the reader cannot trust.
function todoSay(op, item) {
  if (!item) return null;
  const id = `#${item.id}`;
  if (op === "add") return `added ${id}: ${item.text}`;
  if (op === "edit") return `${id} rewritten`;
  if (op === "note") return item.note ? `${id} note saved` : `${id} note cleared`;
  if (op === "files") return `${id} files ${item.files?.length ? `set to ${item.files.join(", ")}` : "cleared"}`;
  if (item.status === "done") return `${id} done`;
  if (item.status === "dropped") return `${id} dropped`;
  if (item.status === "doing") return `${id} claimed — doing`;
  return `${id} reopened`;
}

// The two events that can add what a harvest needs — a row written by a scan, a job arriving or changing — plus one
// pass at boot, because a panel started over a store whose trees were all scanned long ago has no row event coming.
store.onEvent((evt) => {
  if (evt?.type === "row") descriptions.harvest();
});
descriptions.harvest(2500);

function worktreeDirName(name, tag) {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug ? `${slug}-${tag}` : "";
}

// The main checkout of a repository is the one whose git dir IS the repository (`.git`), not a link into another
// tree's (`.git/worktrees/<name>`). Asked of git rather than inferred from a path, so a checkout reached by a
// different spelling, or a project whose registry path is not the top of the repo, is still recognised as main.
async function isMainCheckout(dir) {
  const gitDir = await execP("git", ["-C", dir, "rev-parse", "--absolute-git-dir"], { timeout: 20_000, windowsHide: true })
    .then((r) => String(r.stdout || "").trim())
    .catch(() => "");
  return Boolean(gitDir) && normPathKey(path.dirname(gitDir)) === normPathKey(dir);
}

async function renameWorktree({ projectName, target, name, by = null, how = null, once = false, run = null }) {
  const project = scheduler.getProjects().find((p) => p.name === projectName);
  if (!project) return { error: `unknown project: ${projectName}`, status: 404 };
  const oldPath = path.resolve(String(target || ""));
  // The project's own checkout is the parent of every tree cut from it and its name is the folder's name: renaming it
  // would rename the project itself. Matched the way every other path comparison here is (case- and slash-insensitive,
  // because the page, the registry and a scan spell the same directory differently), and again against git so a
  // checkout reached by another spelling still cannot be moved.
  if (normPathKey(oldPath) === normPathKey(project.path) || (await isMainCheckout(oldPath))) {
    return { error: "that is the project's own checkout, not a worktree — its name is the project folder's", status: 400 };
  }
  const row = scheduler.store.rowsFor(projectName).find((r) => path.resolve(r.path) === oldPath);
  if (!row) return { error: `not a worktree row of ${projectName}: ${oldPath}`, status: 404 };
  // A rename keys the naming ledger on the six-hex tag and keeps that tag as the one part of the name it does not
  // rebuild, so a directory carrying none has no identity to rename by — lib/tree-names.js `renameRefusal` has the
  // full reason. Refused here, before anything is claimed or moved, for the automatic half and the deliberate one
  // alike. The old code invented a tag for a bare name, which gave the tree a second identity and a ledger record
  // keyed on a path the rename then moved out from under itself.
  const refusal = renameRefusal(oldPath);
  if (refusal) return { error: refusal, status: 400 };
  const base = path.basename(oldPath);
  // Keep the six-hex tag: it is what tells two trees named alike apart, and it makes a repeated rename a no-op
  // instead of a second suffix. `tagOf` also reads a directory that IS six hex, which is the tag being named.
  const tag = tagOf(base);
  // The tag is also the tree's identity for the naming ledger, and it is the same key before and after a rename —
  // which is exactly what the old in-memory Set of paths could not say, its key going stale the moment the first
  // rename landed. This is the automatic path asking (`once`), so the LEDGER decides: only the run that cut this tree
  // may give it its one name, only until one lands, and a tree that was seeded (found, not cut) or already named has
  // an entry that can never qualify. `job.existing` is never consulted — a flag set wrong is how a tree the reader
  // considers fixed got moved.
  const key = treeKey({ project: projectName, path: oldPath });
  if (once) {
    const named = treeNames.get(key);
    const refusal = autoNameRefusal(named, run);
    if (refusal) {
      return {
        ok: true,
        unchanged: true,
        skipped: refusal,
        named,
        path: oldPath.replace(/\\/g, "/"),
        branch: row.branch || null,
        jobs: 0,
      };
    }
  }
  // ---- the name belongs to the work once there is work --------------------------------------------
  // A tree is named BEFORE its work exists, and that is a rule now rather than a hope. Two gates, both read from git
  // rather than from the store (the store is a scan behind, and a rename is the irreversible half of this):
  //
  //   * the branch is published — it exists on the project's remote. A remote branch and any PR are keyed on the
  //     name, so moving it silently detaches the row from both. Refused even for the deliberate ✦; the reader can
  //     still rename it themselves.
  //   * the automatic half (`once`) stops at the branch's first own commit. Measured on this board: one tree's
  //     rename landed 95 seconds AFTER its second commit, leaving a directory named one thing and a branch named
  //     another, and 12 of 180 rows sit in that split state. After the first commit the name is part of the work.
  const branchNow = await execP("git", ["-C", oldPath, "symbolic-ref", "--short", "HEAD"], { timeout: 20_000, windowsHide: true })
    .then((r) => String(r.stdout || "").trim())
    .catch(() => "");
  if (project.remote && branchNow) {
    const published = await execP("git", ["-C", project.path, "rev-parse", "--verify", "--quiet", `refs/remotes/${project.remote}/${branchNow}`], { timeout: 20_000, windowsHide: true })
      .then((r) => Boolean(String(r.stdout || "").trim()))
      .catch(() => false);
    if (published) {
      return {
        error: `${branchNow} is already on the remote (${project.remote}/${branchNow}) — its name is published, so the panel will not move it. Rename it yourself with \`git branch -m\` if it really has to change.`,
        status: 409,
      };
    }
  }
  if (once && branchNow) {
    const baseRef = project.remote ? `${project.remote}/${project.mainBranch}` : project.mainBranch || null;
    const ahead = baseRef
      ? await execP("git", ["-C", oldPath, "rev-list", "--count", `${baseRef}..HEAD`], { timeout: 30_000, windowsHide: true })
          .then((r) => Number.parseInt(String(r.stdout || "").trim(), 10))
          .catch(() => Number.NaN)
      : Number.NaN;
    // Unknown is not zero: a branch whose base cannot be read is one the panel cannot prove is empty.
    if (!Number.isFinite(ahead) || ahead > 0) {
      const why = Number.isFinite(ahead)
        ? `the branch already carries ${ahead} commit${ahead === 1 ? "" : "s"} of its own`
        : "the branch's base could not be read, so it cannot be proved to carry no work";
      // Written down, not merely returned: the sweeper asks again after every restart, and a tree this rule spared
      // must not be offered a new name each time. `skipped` keeps it off the board's `named` line — the tree was not
      // renamed, so it must not claim it was (`withTreeNames`).
      const skippedRec = treeNames.record(key, {
        name: base,
        dir: base,
        branch: branchNow,
        tag,
        by: by || "the panel",
        how: `${why} — the name stays`,
        at: new Date().toISOString(),
        skipped: true,
        claimedOnly: false,
        from: base,
      });
      log(`naming ${oldPath}: refused — ${why}; a tree is named before its work is committed, not after`);
      return {
        ok: true,
        unchanged: true,
        skipped: `${why} — a tree is named before its work is committed, not after`,
        named: skippedRec,
        path: oldPath.replace(/\\/g, "/"),
        branch: branchNow,
        jobs: 0,
      };
    }
  }
  const wanted = String(name || "").trim().replace(new RegExp(`-${tag}$`, "i"), "");
  const dirName = worktreeDirName(wanted, tag);
  if (!dirName) return { error: "a name is required", status: 400 };
  const newPath = path.join(project.path, ".worktrees", dirName);
  if (path.resolve(newPath) === oldPath) {
    // Already called that, so there is nothing to move — but the name still has to be settled here, or the automatic
    // half would keep trying the same rename for the rest of the tree's life. Written through settle() so the entry
    // stops being "a cut tree waiting for its one name" whatever it was before.
    const named = treeNames.settle(key, {
      name: dirName,
      dir: dirName,
      branch: row.branch || null,
      tag,
      by: by || "the panel",
      how: how || "already its name",
      at: new Date().toISOString(),
    });
    return { ok: true, unchanged: true, path: oldPath.replace(/\\/g, "/"), branch: row.branch || null, jobs: 0, named };
  }
  const taken = await stat(newPath)
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (taken) {
    // The automatic half spends its one chance HERE rather than trying the same taken name on every later event: the
    // tree is settled under the name it already has, and the row says why. The reader's own rename does not settle
    // anything — a 409 leaves the tree exactly as eligible as it was, and it stays that way until it is renamed.
    if (once) {
      const named = treeNames.settle(key, {
        name: base,
        dir: base,
        branch: row.branch || null,
        tag,
        by: "the panel",
        how: `left under its first name — ${dirName} was already taken`,
        at: new Date().toISOString(),
        collision: true,
        moved: false,
      });
      return {
        ok: true,
        unchanged: true,
        collision: true,
        path: oldPath.replace(/\\/g, "/"),
        branch: row.branch || null,
        jobs: 0,
        named,
        warning: `${dirName} already exists — the tree keeps its first name`,
      };
    }
    return { error: `${dirName} already exists`, status: 409 };
  }
  // A running agent holds the tree as its cwd, and git refuses to move a worktree something is standing in.
  const busy = jobs
    .list()
    .find(
      (j) =>
        isLiveJobStatus(j.status) &&
        [j.cwd, j.ownerPath, j.worktreePath].filter(Boolean).some((p) => path.resolve(p) === oldPath),
    );
  if (busy) return { error: `an agent is running in that worktree (${busy.id}) — stop it first`, status: 409 };
  // Claim it BEFORE the git work, and only for the automatic half: two events of one turn settle within a second of
  // each other, and both of them would otherwise find a tree whose one name has not landed yet. The claim keeps the
  // cut marker (so the tree is still this run's to name if the git work dies with the process) and is settled below
  // once something lands, so a tree is never frozen under a name it did not get.
  if (once) {
    treeNames.record(key, {
      name: dirName,
      dir: dirName,
      branch: row.branch || null,
      tag,
      by: by || "the panel",
      how: how || "the automatic rename",
      at: new Date().toISOString(),
      cut: true,
      cutRun: run || null,
      claimedOnly: true,
      // A claim is a real attempt at a name: clear any earlier `skipped` mark, or a tree that was spared once
      // would keep claiming it had been named and hide its own name from the board.
      skipped: false,
    });
  }
  // The branch the tree is actually on, read BEFORE the directory is moved: after `worktree move` the old path is
  // gone, so the same question asked there can only fall back to the store — and a row that discovery has not
  // scanned yet has no branch at all, which left the directory renamed and the branch behind. Git is the authority
  // and it is asked while it can still answer.
  const oldBranch = await execP("git", ["-C", oldPath, "symbolic-ref", "--short", "HEAD"], { timeout: 20_000, windowsHide: true })
    .then((r) => String(r.stdout || "").trim())
    .catch(() => row.branch || null);
  // Windows will not rename a directory that any process has open, and an agent's shell lives in its tree long after
  // its turn ends — so the directory move is best-effort and the branch rename is the part that lands. Both halves
  // are retried: a file indexer, a scan worker or a ref lock holds one of them for a moment, and one retry each is
  // what keeps a transient lock from leaving a tree's name and its branch disagreeing.
  let moved = false;
  let whyNot = "";
  for (let attempt = 0; attempt < 3 && !moved; attempt += 1) {
    try {
      await execP("git", ["-C", project.path, "worktree", "move", oldPath, newPath], { timeout: 90_000, windowsHide: true });
      moved = true;
    } catch (e) {
      whyNot =
        String((e && e.message) || e)
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
          .pop() || "the directory is held open";
      if (attempt < 2) await new Promise((r) => setTimeout(r, 250));
    }
  }
  const newBranch = `wtgui/${dirName}`;
  let branchRenamed = false;
  if (oldBranch && oldBranch !== newBranch) {
    // A scan running in a worker thread can hold a ref lock for a moment ("cannot lock ref"), and the whole point of
    // this is a name: try again, longer than a scan's tick, before giving up on the branch half.
    for (let attempt = 0; attempt < 6 && !branchRenamed; attempt += 1) {
      try {
        await execP("git", ["-C", project.path, "branch", "-m", oldBranch, newBranch], { timeout: 30_000, windowsHide: true });
        branchRenamed = true;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
  const finalPath = moved ? newPath : oldPath;
  // A locked BRANCH follows its own rename. `git branch -m` keeps the branch's identity — its history and its ref —
  // so a branch the reader locked is the SAME branch under a new name. Leaving the lock on the old name would
  // silently unprotect a turnover branch the moment the panel auto-named a tree on it, which is exactly the case
  // the branch scope exists for. Tied to `branchRenamed`, not to `moved`: the branch half lands on its own when a
  // process holds the directory open, and the protection has to follow whichever half moved.
  const heldBranch = oldBranch ? locks.branchEntry(projectName, oldBranch) : null;
  if (branchRenamed && heldBranch) {
    locks.setBranch(projectName, oldBranch, false);
    locks.setBranch(projectName, newBranch, true, { by: heldBranch.by || "the reader", path: finalPath });
    log(`branch lock follows the rename: ${oldBranch} -> ${newBranch}`);
  }
  const repointed = jobs.repointPath(oldPath, finalPath);
  if (moved) {
    // A locked tree stays locked when it moves. The lock is keyed by the directory (lib/locks.js), so a rename would
    // otherwise unlock a tree nobody asked to unlock — the old key goes and the new path carries the same record.
    const held = locks.treeEntry(projectName, row.path);
    if (held) {
      locks.setTree(projectName, row.path, false);
      locks.setTree(projectName, finalPath, true, { by: held.by || "the reader", branch: branchRenamed ? newBranch : held.branch || oldBranch });
      log(`lock follows the rename: ${row.path} -> ${finalPath.replace(/\\/g, "/")}`);
    }
    scheduler.store.dropRow(projectName, row.path);
    broadcast({ type: "drop", project: projectName, path: row.path });
  }
  // Nothing of the rename landed (the directory is held open AND the branch would not move): hand the tree back as the
  // cut tree it still is, rather than leaving a claim on a name it never got. Handing it back to the CUT state (not
  // forgetting it) keeps "this run cut it, nobody has named it" intact: a later event of the same run may try again,
  // and a seed — which would fix the name for good — can never slip in behind it.
  if (!moved && !branchRenamed) {
    if (once) {
      treeNames.record(key, {
        name: base,
        dir: base,
        branch: oldBranch || row.branch || null,
        tag,
        by: "the panel",
        how: "cut for this run — its one name did not land, so it is still this run's to give",
        at: new Date().toISOString(),
        cut: true,
        cutRun: run || null,
        claimedOnly: false,
      });
    }
    // Said out loud: a rename that did not land is the one case a reader (or a harness) cannot see from the board, and
    // the reason is otherwise only in the code.
    log(`naming ${oldPath}: the directory would not move (${whyNot}) and the branch would not move either — nothing was renamed`);
    const scanned = await scheduler.scanOne(project, finalPath.replace(/\\/g, "/"), "full").catch(() => null);
    return {
      ok: true,
      moved: false,
      path: finalPath.replace(/\\/g, "/"),
      branch: (scanned && scanned.branch) || oldBranch,
      branchRenamed: false,
      jobs: repointed,
      warning: `the directory keeps its old name (${whyNot})`,
    };
  }
  // Read the renamed tree in now, not on its next scan: the store's branch name is what the next rename reads, and the
  // board should show the new name in the same breath as the banner.
  const scanned = await scheduler.scanOne(project, finalPath.replace(/\\/g, "/"), "full").catch(() => null);
  const finalBranch = (scanned && scanned.branch) || (branchRenamed ? newBranch : oldBranch);
  // The record follows the tree: a name with no tag gets one here (rename keeps a tag, and makes one when the tree
  // had none), so the key changes with the name and the old one is dropped. settle() — not record() — is the write
  // that says the name is final: it clears the cut marker so no later event, and no later run, can give this tree
  // another one.
  const keyAfter = treeKey({ project: projectName, path: finalPath });
  if (keyAfter !== key) treeNames.forget(key);
  const named = treeNames.settle(keyAfter, {
    name: path.basename(finalPath),
    dir: path.basename(finalPath),
    branch: finalBranch || null,
    tag: tagOf(finalPath) || tag,
    by: by || "the panel",
    how: how || `renamed after “${wanted}”`,
    at: new Date().toISOString(),
    moved,
    from: base,
    claimedOnly: false,
    // A rename that actually landed is the tree's name: clear any `skipped` mark left by an earlier refusal.
    skipped: false,
  });
  return {
    ok: true,
    moved,
    path: finalPath.replace(/\\/g, "/"),
    branch: finalBranch,
    branchRenamed,
    jobs: repointed,
    named,
    warning: moved ? null : `the directory keeps its old name (${whyNot})`,
  };
}

// A tree is named from the prompt, and Hermes names the session from the work itself a moment later ("Fix delete
// worktree button not removing directory"). The reader wants the tree to take that name the moment the session is
// first named — not at the end of a later turn — so the policy is asked on every job event that carries a title.
// ONCE PER TREE, and that "once" is the ledger rather than a hope (lib/tree-names.js): the panel records the tree at
// the cut with the id of the run that cut it, only that record is eligible, and a rename settles it. A tree that was
// already here is seeded under the name it was found with and never enters this path at all.
naming = new WorktreeNaming({
  ledger: treeNames,
  // The project a tree belongs to, by path — the same lookup the board uses to place a row.
  projectForPath: (p) => spawnFeature.projectForPath(p),
  // The title from the event's own summary (jobs.summary carries it), falling back to the session store for an event
  // that arrived before Hermes wrote the name — the 10-second sweep emits again as soon as it has one.
  titleFor: (job) => job.title || jobs.sessionInfoFor(job.thread).title,
  // A tree a live run is standing in cannot be moved by git, so the attempt waits for the settle rather than fail.
  isBusy: (dir) => jobs.list().some((x) => isLiveJobStatus(x.status) && normPathKey(x.ownerPath || x.cwd) === normPathKey(dir)),
  rename: (args) => renameWorktree(args),
  log,
  // The boot backfill: a tree that was here before this process must be written down before any restored run's
  // title is considered, or "no entry" would let it through.
  ready: treeNamesReady,
});

// The cut half of the ledger, called by lib/jobs.js around `git worktree add`: BEFORE the directory exists the tree is
// recorded as this run's to name, and if git then fails the record is handed back. Injected here because the ledger
// and the project registry are this file's, and lib/jobs.js must stay usable without either.
jobs.naming = {
  cut: ({ repoDir, path: tree, branch, tag, run, thread }) => {
    const project = registry.projects.find((p) => normPathKey(p.path) === normPathKey(repoDir));
    if (!project?.name) return null; // not a project the panel watches: discovery will seed it instead
    const key = treeKey({ project: project.name, path: tree, branch });
    const rec = treeNames.claimCut(key, {
      name: path.basename(tree),
      dir: path.basename(tree),
      branch: branch || null,
      tag: tag || tagOf(tree) || null,
      by: `run ${run || "?"} (${thread || "?"})`,
      how: "cut by this panel — its one name is the run's to give",
      at: new Date().toISOString(),
      cutRun: run || null,
      cutThread: thread || null,
    });
    if (rec?.cut) log(`tree-names: ${project.name}::${path.basename(tree)} is cut for run ${run || "?"} — one name allowed`);
    return rec;
  },
  release: ({ repoDir, path: tree, tag, run }) => {
    const project = registry.projects.find((p) => normPathKey(p.path) === normPathKey(repoDir));
    if (!project?.name) return false;
    const key = treeKey({ project: project.name, path: tree });
    // Only the record THIS cut wrote is withdrawn: a tree that already had one (seeded, named, cut by another run)
    // is not this run's to erase, and a failed `git worktree add` must not leave a claim on a directory nobody made.
    const rec = treeNames.get(key);
    if (!rec?.cut || (rec.cutRun && run && String(rec.cutRun) !== String(run))) return false;
    return treeNames.forget(key);
  },
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
        const other = Boolean(s.hermes?.on || s.claude?.on || s.board?.on || s.ports?.on || s.files?.on);
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

// The reader's lock travels with the snapshot the way the naming ledger does: git knows nothing about it, the
// scanner must not have to, and the row is where it has to be visible. A row with no `lock` is unlocked — absence is
// the default, so an unlocked row costs nothing on the wire and a store that cannot be read cannot make a tree look
// protected. `tree` and `branch` are independent bits: the row draws one toggle for each, and `by` says which one
// refused a delete.
function withLocks(snap) {
  for (const project of snap.projects || []) {
    for (const row of project.worktrees || []) {
      const lock = locks.check({ project: project.name, path: row.path, branch: row.branch });
      if (!lock.locked) {
        delete row.lock;
        continue;
      }
      row.lock = {
        tree: lock.tree,
        // `branch` is the branch's NAME and `branchLocked` is the boolean; a row that merely HAS a branch must not
        // read as a locked one. The row draws one toggle per bit and names the branch in its tooltip.
        branch: lock.branch,
        branchLocked: lock.branchLocked,
        locked: true,
        by: lock.by,
        at: lock.at,
        reason: lock.reason,
        line: describeLock(lock.by === "branch" ? { at: lock.at, by: lock.branchBy } : { at: lock.at, by: lock.treeBy }, lock.by === "branch" ? "branch" : "worktree"),
      };
    }
  }
  return snap;
}

// What the panel itself knows about a tree's name — who gave it and when — is in no git repository, so it travels
// with the snapshot the way the live agent state does. A row that carries `named` is a row the automatic rename
// will never touch again; one without it is a tree still waiting for the run that will name it.
function withTreeNames(snap) {
  for (const project of snap.projects || []) {
    for (const row of project.worktrees || []) {
      const rec = treeNames.forTree({ project: project.name, path: row.path, branch: row.branch });
      // A cut record is a tree waiting for its one name, not a tree that has one: the row must not claim a name
      // nobody has given it yet (the tooltip is the only place this shows, and it would say "named by run …").
      // A `skipped` record says the panel looked and LEFT THE NAME ALONE (the branch already carried its own
      // commits): it is written so the title sweep stops asking, not because a name landed, so the row must not
      // claim to have been named either. The ledger keeps the reason for anyone reading the file.
      if (!rec || namingState(rec) === "cut" || rec.skipped) {
        delete row.named;
        continue;
      }
      row.named = {
        name: rec.name || null,
        by: rec.by || null,
        at: rec.at || null,
        how: rec.how || null,
        claimedOnly: Boolean(rec.claimedOnly),
        line: describeNaming(rec),
      };
    }
  }
  return snap;
}

// ---- the two directories the panel keeps its things in ---------------------------------------------
// The page shows these, with their sizes, and offers to open either or to empty the scratch one. Both numbers come
// from lib/paths.js's cached walk (10 s), so a board polled every few seconds never pays for a fresh stat of the
// attachments folder; `at` says how old the reading is rather than the page pretending it is live.
function pathsInfo() {
  const data = sizeOf(config.dataDir);
  const scratch = sizeOf(config.scratchDir);
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  return {
    dataDir: config.dataDir,
    dataSource: config.dataDirSource,
    // `split` (state/, attachments/, logs/ inside) or `flat` (a PANEL_CONFIG instance's own folder).
    dataLayout: config.dataLayout,
    dataBytes: data.bytes,
    dataFiles: data.files,
    // null until the first background walk lands, so the row says "measuring…" instead of a false "0 B".
    dataMeasuredAt: iso(data.at),
    scratchDir: config.scratchDir,
    scratchSource: config.scratchDirSource,
    scratchBytes: scratch.bytes,
    scratchFiles: scratch.files,
    scratchDirs: scratch.dirs,
    scratchMeasuredAt: iso(scratch.at),
    // Whether Clean scratch will work at all: it refuses a folder the panel did not make (paths.js, SCRATCH_MARKER).
    scratchMarked: existsSync(path.join(config.scratchDir, SCRATCH_MARKER)),
    // Where the pieces sit, so the row can say "the job store is under state/" without the reader guessing.
    stateDir: config.stateDir,
    attachmentsDir: config.attachmentsDir,
    logsDir: config.logsDir,
    // Where this board's history came from, from the data directory's own journal — so it is still answerable on
    // every later boot. `thisBoot` is true only on the boot that did the copy.
    migrated: lastMigration
      ? { files: (lastMigration.copied || []).length, from: lastMigration.from, to: lastMigration.to, at: lastMigration.at, thisBoot: stateMigration.migrated }
      : null,
    at: iso(data.at || Date.now()),
  };
}

// ---- the steward's own reads ------------------------------------------------------------------------------------
// One project, re-read from git and classified: the parent book is refreshed first, because a plan that guessed a
// different parent from the board would be two answers to one question, and the row is the one the reader is looking
// at. Cost is a handful of git calls per local branch, which is why nothing here runs on a scan tick.
async function stewardProject(name) {
  const project = (registry.projects || []).find((p) => p.name === name) || null;
  if (!project) return { status: 404, error: `unknown project: ${name || "(none)"}` };
  const rows = store.rowsFor(project.name) || [];
  const branches = rows.map((r) => r.branch).filter(Boolean);
  await parents.refresh({ project: project.name, repoDir: project.path, mainBranch: project.mainBranch, branches });
  const map = new Map();
  for (const rec of parents.state(project.name)) map.set(rec.branch, rec);
  const entries = await inspectProject({ project: project.name, repoDir: project.path, rows, parents: map, mainBranch: project.mainBranch });
  const plan = buildPlan({ project: project.name, repoDir: project.path, entries, questions: questions.list(project.name), mainBranch: project.mainBranch });
  return { project, rows, map, entries, plan };
}

function snapshot() {
  return withTodos(
    descriptions.withDescriptions(
      withLocks(
        withTreeNames(
          withLiveAgents({
          ...store.snapshot({ settings: settingsOut() }),
          paths: pathsInfo(),
          jobs: jobs.list(),
          approvals: approvals.list(),
          // The panel's own permission requests (a push a worker's guard parked, a merge the panel itself wants to
          // write to a remote for). They ride with the snapshot the way the CLI-transport approvals do, so a reload
          // comes back to the same open question instead of losing it.
          remoteWrites: remoteWrites.state(),        // The assistant's own state travels with the snapshot: its scratchpad, its open alerts and its
          // thread id, so a reload comes back to the same conversation and the same watches.
          assistant: assistant.state(),
          // Where the board's links go: the host records a reader can choose from, plus what each project resolves to
          // right now. One object, because the header's chip and the Discover strip must read the same answer.
          hosts: { ...hosts.state(), projects: Object.fromEntries(registry.projects.map((p) => [p.name, hosts.view(p)])) },
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
        }),
      ),
    ),
  ),
  );
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

// ---- the model menu's prices, kept warm without ever blocking a read ---------------------------
// The dropdown reads a cache file and nothing else, so the one thing that can refresh it is a
// gateway call, and that call re-fetches every provider's live list. It is therefore deliberately
// rare: at most one attempt per process minute, and only while the panel has no prices at all or has
// not regenerated them for over a week. A press in Settings (POST /api/models/refresh) is the
// deliberate path and is never throttled.
const MODEL_PRICING_WARM_MS = 7 * 24 * 60 * 60 * 1000;
let modelPricingWarm = null; // the in-flight warm, so a burst of page loads starts exactly one
let modelPricingWarmTriedAt = 0;
function warmModelPrices(cfg, catalogue) {
  if (modelPricingWarm) return;
  const ageSeconds = catalogue?.pricingAge;
  const stale = !Number.isFinite(ageSeconds) || ageSeconds * 1000 > MODEL_PRICING_WARM_MS;
  if (!stale || Date.now() - modelPricingWarmTriedAt < 60_000) return;
  modelPricingWarmTriedAt = Date.now();
  modelPricingWarm = refreshModelCatalogue({
    home: hermesHome(),
    pricingFile: cfg.modelPricingFile,
    api: jobs.api,
    log,
  })
    .catch((e) => log(`model prices: the background warm failed — ${String((e && e.message) || e)}`))
    .finally(() => {
      modelPricingWarm = null;
    });
}

const cleanPath = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "");

// Removing a worktree's folder - the Recycle Bin attempt, the retry for a folder a process still holds, and
// the question of whether the panel itself is what holds it - lives in lib/worktree-remove.js with the rest of
// the act, because the answer a CHECKING agent gives ends in the same removal.

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

    // The build this process is serving: the page carries the version it loaded with, polls this,
    // and offers (or takes) a reload when the two part company. A read, like every other GET here.
    if (route === "/api/build" && req.method === "GET") {
      return sendJson(res, 200, await build.info());
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
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
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
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
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
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
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

    // ---- scan roots and projects configuration -------------------------------------------------------
    if (route === "/api/settings/projects" && req.method === "GET") {
      return sendJson(res, 200, {
        scanRoots: config.scanRoots || [],
        projects: config.projects || [],
      });
    }

    if (route === "/api/settings/projects" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const scanRoots = Array.isArray(body.scanRoots) ? body.scanRoots.filter((r) => String(r || "").trim()) : [];
      if (!scanRoots.length) return sendJson(res, 400, { error: "scanRoots cannot be empty" });
      try {
        await patchPanelConfig({ scanRoots });
        config.scanRoots = scanRoots;
        log(`scanRoots updated: ${scanRoots.join(", ")}`);
        // The response only tells THIS request's caller the save worked. Every other open board
        // (and this one, once settings closes) still shows the old project set until something pushes
        // a snapshot — a removed root's projects otherwise sit on screen forever, looking like the
        // removal silently failed. refresh() drops them from the registry and the store; broadcasting
        // once it lands is what actually retires their sections (see the clone handler, same pattern).
        void registry
          .refresh()
          .then(() => broadcast({ type: "snapshot", data: snapshot() }))
          .catch(() => {});
        return sendJson(res, 200, {
          scanRoots: config.scanRoots,
          projects: config.projects || [],
          note: "saved — scanning for repos",
        });
      } catch (e) {
        return sendJson(res, 500, { error: String((e && e.message) || e) });
      }
    }

    // The models the New-agent form offers. Read from the gateway home, not from the run stream: the
    // provider's live list is what Hermes itself fetched, and a stale one is reported as stale rather
    // than presented as truth. Each row also carries the in/out price per Mtok and the 0-10 coding
    // rating the shipped CLI picker shows — read from this panel's own cache file and NOT fetched
    // here, so opening the menu can never wait on a cold endpoint.
    if (route === "/api/models" && req.method === "GET") {
      const catalogue = modelCatalogue({ home: hermesHome(), pricingFile: config.modelPricingFile });
      warmModelPrices(config, catalogue); // fire and forget: the answer above is file-only
      return sendJson(res, 200, catalogue);
    }

    // Regenerate the menu rather than re-read it. The gateway re-fetches every authenticated
    // provider's live /v1/models list and persists it — the same file `hermes model --refresh`
    // writes, and the file the menu above lists from — and the panel then rebuilds its price/rating
    // cache from that answer, having deleted its own copy first. Both files' row counts and mtimes
    // come back with the reply, because "the press did something" is otherwise indistinguishable
    // from "the page re-read the same bytes".
    if (route === "/api/models/refresh" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      try {
        const result = await refreshModelCatalogue({
          home: hermesHome(),
          pricingFile: config.modelPricingFile,
          api: jobs.api,
          log,
        });
        return sendJson(res, 200, result);
      } catch (e) {
        return sendJson(res, 502, { error: String((e && e.message) || e), ...((e && e.partial) || {}) });
      }
    }

    // ---- the assistant: a sentry over this board, and one thread the reader talks to ----------------
    // Every read is free of side effects; every write is authorised like the rest of the panel and
    // returns the whole assistant state so the float repaints from one answer instead of guessing.
    if (route === "/api/assistant" && req.method === "GET") {
      return sendJson(res, 200, assistant.state());
    }

    // The message board between the assistant and the agents. Deliberately NOT part of the polled state:
    // it is the whole seven-day conversation, it is only read while its tab is open, and it is built from
    // the job store and the journal on every request (no cache to prune). The cap and the window travel
    // with the answer, so the tab can say which one it is up against.
    if (route === "/api/assistant/messages" && req.method === "GET") {
      const q = new URL(req.url, "http://127.0.0.1").searchParams;
      const days = Number(q.get("days"));
      const cap = Number(q.get("cap"));
      return sendJson(res, 200, {
        messages: assistant.messages({
          ...(Number.isFinite(days) && days > 0 ? { days: Math.min(30, days) } : {}),
          ...(Number.isFinite(cap) && cap > 0 ? { cap: Math.min(2000, Math.round(cap)) } : {}),
        }),
      });
    }

    // The continuity file — the long tier of the assistant's memory, injected into every turn. GET carries
    // the text (the polled state carries only its path, size and mtime, so a 20 KB body is not re-sent on
    // every board event); PUT replaces it whole. Too big is its own status: the module raises the cap
    // refusal with the numbers in it, and 413 says "prune it" rather than "something broke".
    if (route === "/api/assistant/charter" && req.method === "GET") {
      return sendJson(res, 200, { charter: assistant.charterPayload(), assistant: assistant.state() });
    }
    if (route === "/api/assistant/charter" && req.method === "PUT") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e) });
      }
      try {
        const charter = assistant.setCharter(body.text, "reader", { expectMtime: body.expectMtime });
        return sendJson(res, 200, { charter, assistant: assistant.state() });
      } catch (e) {
        // 413 prune it · 409 someone else wrote it since you read it · 400 anything else.
        const code = (e && e.code) === "charter-too-long" ? 413 : (e && e.code) === "charter-stale" ? 409 : 400;
        return sendJson(res, code, { error: String((e && e.message) || e) });
      }
    }

    // A message from the reader. The board digest and the scratchpad are attached to the run's input by
    // the module, so the card shows the sentence the reader typed.
    if (route === "/api/assistant/say" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
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
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      return sendJson(res, 200, { settings: assistant.setSettings(body), assistant: assistant.state() });
    }

    // The header's aggressive-mode toggle. One route for one button: `on` is the requested state and the answer
    // says whether anything changed — pressing it twice, or switching off a mode that was never on, comes back
    // changed:false with a reason instead of silently pretending it did something. The whole assistant state
    // rides with the answer so the float repaints from one response.
    if (route === "/api/assistant/aggressive" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const wanted = body.on === undefined ? !assistant.aggressive.on : Boolean(body.on);
      const out = assistant.setAggressive(wanted);
      return sendJson(res, 200, { ...out, settings: assistant.settings, assistant: assistant.state() });
    }

    // Dismiss an alert, or hand it to the assistant (one digest, rate limited). Nothing here answers an
    // approval: that stays on the agent's own card, where the gateway validates the choice.
    if (route === "/api/assistant/alert" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
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
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        const job = await assistant.answerThread(String(body.thread || ""), body.text, {
          source: "reader",
          alertId: body.alertId ? String(body.alertId) : null,
        });
        return sendJson(res, 202, { job, assistant: assistant.state() });
      } catch (e) {
        // 409 for a worker that is already turning: the request was well-formed and understood, and the answer is
        // "not now" (the code a steer that missed the last tool boundary already gets). 400 for everything else.
        return sendJson(res, (e && e.code) === "thread_busy" ? 409 : 400, { error: String((e && e.message) || e) });
      }
    }

    // Answer a question the run is parked on (the `clarify` tool). Not a reply: it settles the prompt the
    // gateway is holding, so the turn resumes where it stopped.
    if (route === "/api/assistant/answer-question" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
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
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
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
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        const watch = assistant.addWatch(body, "reader");
        return sendJson(res, 201, { watch, assistant: assistant.state() });
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e) });
      }
    }
    if (route === "/api/assistant/watch/remove" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      return sendJson(res, 200, { watches: assistant.removeWatch(String(body.id || "")), assistant: assistant.state() });
    }

    if (route === "/api/assistant/rule" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        const rules = assistant.addRule(body.text);
        return sendJson(res, 201, { rules, assistant: assistant.state() });
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e) });
      }
    }
    if (route === "/api/assistant/rule/remove" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      return sendJson(res, 200, { rules: assistant.removeRule(String(body.id || "")), assistant: assistant.state() });
    }

    if (route === "/api/assistant/notes" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      return sendJson(res, 200, { notes: assistant.setNotes(body.text), assistant: assistant.state() });
    }

    // One sentry pass on demand. Used by the page after a change that should be judged at once, and by
    // the verification probes instead of waiting for the clock.
    if (route === "/api/assistant/check" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      assistant.tick();
      return sendJson(res, 200, { assistant: assistant.state() });
    }

    // The reader's lock, toggled from the row's emoji (lib/locks.js). `scope` says which lock the press is about —
    // "tree" for this worktree, "branch" for the branch it is on and every worktree cut from that branch later — and
    // `locked` omitted means flip. The answer carries the checked state so the button can paint what the server now
    // holds rather than what the page hoped; every open board repaints from the snapshot the write broadcasts.
    if (route === "/api/worktree/lock" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const projectName = String(body.project || "").trim();
      const project = scheduler.getProjects().find((p) => p.name === projectName);
      if (!project) return sendJson(res, 404, { error: `unknown project: ${projectName}` });
      const scope = String(body.scope || "tree").toLowerCase() === "branch" ? "branch" : "tree";
      // The row is the authority for both halves: its path is the key git and the store use, and its branch is what a
      // branch lock is about. A path the caller names that is not this project's row is refused rather than locked,
      // so a typo cannot protect a directory nobody is looking at.
      const asked = body.path ? normPathKey(body.path) : null;
      const row = asked ? scheduler.store.rowsFor(projectName).find((r) => normPathKey(r.path) === asked) : null;
      if (asked && !row) return sendJson(res, 404, { error: `not a worktree row of ${projectName}: ${body.path}` });
      if (!asked && scope === "tree") return sendJson(res, 400, { error: "a worktree path is required to lock a worktree" });
      const branch = scope === "branch" ? String(body.branch || row?.branch || "").trim() : row?.branch || null;
      if (scope === "branch" && !branch) return sendJson(res, 400, { error: "this row has no branch to lock" });
      const out = locks.toggle({
        project: projectName,
        path: row?.path || String(body.path || ""),
        branch,
        scope,
        locked: body.locked === undefined ? null : Boolean(body.locked),
      });
      if (!out.ok) return sendJson(res, 400, { error: out.error || "the lock could not be changed" });
      const lock = locks.check({ project: projectName, path: row?.path || String(body.path || ""), branch: row?.branch || branch });
      const what = scope === "branch" ? `branch ${branch}` : `worktree ${row?.name || path.basename(String(row?.path || body.path || ""))}`;
      log(`lock ${out.locked ? "set" : "cleared"} on ${what} in ${projectName}${out.locked ? " — deletes are refused until it is removed" : ""}`);
      broadcast({ type: "snapshot", data: snapshot() });
      return sendJson(res, 200, {
        ok: true,
        scope,
        locked: Boolean(out.locked),
        lock,
        say: out.locked ? `🔒 ${what} is locked — nothing may delete it until you unlock it` : `🔓 ${what} is unlocked`,
      });
    }

    if (route === "/api/state" || route === "/api/audit") {
      return sendJson(res, 200, snapshot());
    }

    // ---- the panel's own folders, acted on only when the reader asks -------------------------------------
    // Settings > Data shows the data and scratch directories with their sizes (both ride in /api/state as
    // `paths`). These two routes are the only things that touch them: one opens a folder, one empties the
    // scratch directory. Both are writes, so both are authorised.
    if (route === "/api/paths/open" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const which = String(body.which || "data").trim().toLowerCase();
      const target = which === "data" ? config.dataDir : which === "scratch" ? config.scratchDir : which === "logs" ? config.logsDir : null;
      if (!target) return sendJson(res, 400, { error: `unknown folder “${which}” — one of data, scratch, logs` });
      // Created before it is opened: the button says "open the folder", and a folder that exists but is empty is
      // a better answer than "there is no such folder" on a panel that has simply not written anything yet.
      try {
        ensureDirs(config);
      } catch (e) {
        return sendJson(res, 500, { error: `could not create ${target}: ${String((e && e.message) || e)}` });
      }
      const { bin, args, error } = openerForFolder(target);
      if (error) return sendJson(res, 400, { error });
      try {
        // Detached, exactly like /api/open-url: explorer.exe reports an exit code before the window is up, so the
        // spawn is the only thing this route can honestly report on.
        const child = spawn(bin, args, { detached: true, stdio: "ignore", windowsHide: true });
        child.on("error", (e) => log(`could not open ${target}: ${String((e && e.message) || e)}`));
        child.unref();
      } catch (e) {
        return sendJson(res, 500, { error: String((e && e.message) || e) });
      }
      return sendJson(res, 200, { ok: true, which, path: target, opened: bin });
    }

    // Empty the scratch directory. Three things REFUSE the whole clean, none of them a partial one: a folder the panel
    // did not make or one that holds its own state/checkout/projects (paths.js, `scratchProblem` and the marker file),
    // and a live run that is working in it or was told to write in it — on Windows the delete would half-fail under a
    // process holding the files, and the agent would be left with a tree that no longer adds up. The refusal names the
    // reason, and the reader fixes the setting, stops the run, or cleans it by hand.
    if (route === "/api/scratch/clean" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const out = await cleanScratch({
        scratchDir: config.scratchDir,
        jobs: jobs.list(),
        dataDir: config.dataDir,
        home: homedir(),
        // Everything a mistyped scratchDir could be an ancestor of: this checkout, the config's folder, the panel's own
        // state, its default working folder, the scan roots and every project the registry knows.
        keep: [
          HERE, CONFIG_DIR, config.stateDir, config.attachmentsDir, config.logsDir, config.defaultCwd,
          ...(Array.isArray(config.scanRoots) ? config.scanRoots : []),
          ...registry.projects.map((p) => p.path),
        ],
      });
      if (!out.ok) {
        log(`scratch NOT cleaned: ${out.error}`);
        return sendJson(res, out.refused ? 409 : 500, { ...out, freed: "0 B", paths: pathsInfo() });
      }
      sizeOf(config.scratchDir, { fresh: true });
      const freed = humanBytes(out.freedBytes);
      log(
        `scratch cleaned: freed ${freed} (${out.removedFiles} file(s), ${out.removedDirs} folder(s)) from ${config.scratchDir}` +
          `${out.leftBehind ? ` — ${out.leftBehind} entr${out.leftBehind === 1 ? "y" : "ies"} could not be removed (still open)` : ""}`,
      );
      // Every open Settings tab repaints from this: the size in the row has to move with the press.
      broadcast({ type: "snapshot", data: snapshot() });
      return sendJson(res, 200, { ...out, freed, paths: pathsInfo() });
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

    // ---- where a project's branches and PRs live ---------------------------------------------------------------
    // The mapping is data (logs/hosts.json + hosts.seed.json), so the page needs to read it and the reader needs a way
    // to fill one in without hand-editing JSON. Three routes: the whole mapping, a PROPOSAL read off the project's
    // own remote (never written), and the confirm that writes it. The proposal is separate from the write on purpose:
    // nothing here guesses a host into the file, and a mapping the reader did not confirm is not a mapping.
    if (route === "/api/hosts" && req.method === "GET") {
      const doc = hosts.doc({ fresh: true });
      return sendJson(res, 200, {
        ...hosts.state(),
        warnings: doc.warnings,
        projects: Object.fromEntries(registry.projects.map((p) => [p.name, hosts.view(p)])),
      });
    }

    if (route === "/api/hosts/propose" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const project = registry.projects.find((p) => p.name === String(body.project || "").trim());
      if (!project) return sendJson(res, 404, { error: `unknown project: ${body.project || "(none)"}` });
      let remoteUrl = "";
      if (project.remote) {
        const r = await gitIn(project.path, ["remote", "get-url", project.remote], 15000);
        remoteUrl = r.ok ? String(r.out || "").trim() : "";
      }
      const proposal = proposeMapping(hosts.doc({ fresh: true }), project, remoteUrl);
      return sendJson(res, 200, { project: project.name, remote: project.remote || null, proposal, current: hosts.view(project) });
    }

    if (route === "/api/hosts/mapping" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const project = registry.projects.find((p) => p.name === String(body.project || "").trim());
      if (!project) return sendJson(res, 404, { error: `unknown project: ${body.project || "(none)"}` });
      const doc = hosts.doc({ fresh: true });
      const hostId = String(body.host || "").trim();
      if (!doc.hosts[hostId]) {
        return sendJson(res, 400, { error: `unknown host "${hostId}" — known hosts: ${Object.keys(doc.hosts).join(", ") || "(none)"}` });
      }
      // Coordinates arrive as an object, or as the one line a reader types: "owner/repo" for github, "PROJECTKEY/slug"
      // for a Bitbucket project. The second form is parsed here so the page does not have to know the kind.
      let coordinates = body.coordinates;
      if (typeof coordinates === "string") {
        const [first, second] = coordinates.split(/[\/,\s]+/).filter(Boolean);
        coordinates = doc.hosts[hostId].kind === "bitbucket-server" ? { projectKey: first, repoSlug: second } : { owner: first, repo: second };
      }
      try {
        hosts.save(project.name, { host: hostId, coordinates: coordinates || null });
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e) });
      }
      const view = hosts.view(project);
      log(`hosts: ${project.name} mapped to ${hostId}${view.links?.repo ? ` (${view.links.repo})` : ""}`);
      // The rows carry their link as a scan result, so the board repaints on the next pass; this event lets the page
      // show the new chip at once, and a resync from the page refreshes the rows.
      broadcast({ type: "hosts", hosts: hosts.state() });
      return sendJson(res, 200, { ok: true, project: project.name, mapping: view, file: hostsFile.file || null });
    }

    // ---- the steward: every local branch of one project, classified --------------------------------------------
    // Stage 3 of this feature, and it ACTS ON NOTHING. GET answers the last plan file; POST re-reads the repo and
    // writes a fresh one (the .md the reader can open, the .json the page reads). The plan says what it would delete,
    // what it would roll and what it needs the reader to answer.
    if (route === "/api/steward" && req.method === "GET") {
      const name = String(url.searchParams.get("project") || "").trim();
      const plan = name ? readPlan(config.stewardDir, name) : null;
      if (!plan) return sendJson(res, 404, { error: `no plan yet for ${name || "(no project)"} — POST /api/steward to write one` });
      return sendJson(res, 200, { ...plan, parents: parents.state(name) });
    }

    if (route === "/api/steward" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const name = String(body.project || "").trim();
      const out = await stewardProject(name);
      if (out.error) return sendJson(res, out.status || 400, { error: out.error });
      const written = writePlan(config.stewardDir, out.plan);
      log(`steward: ${name} — ${out.plan.counts.total} branch(es): ${out.plan.counts.delete} to delete, ${out.plan.counts.roll} to roll, ${out.plan.counts.ask} need an answer → ${written.md}`);
      return sendJson(res, 200, { ...out.plan, file: written.md, text: written.text, parents: parents.state(name) });
    }

    // The only writer. A dry run is the default: `confirm: true` alone is not enough — the body must name the plan
    // the reader was looking at (`planAt`), and the entries are re-read from git before anything is touched.
    if (route === "/api/steward/apply" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const name = String(body.project || "").trim();
      const out = await stewardProject(name);
      if (out.error) return sendJson(res, out.status || 400, { error: out.error });
      const file = readPlan(config.stewardDir, name);
      const listing = await stewardWorktrees(out.project.path);
      const result = await applyPlan({
        plan: file,
        fresh: out.plan,
        expectedAt: body.planAt ? String(body.planAt) : null,
        repoDir: out.project.path,
        trees: listing.trees,
        dryRun: body.dryRun !== false && body.confirm !== true,
        confirm: body.confirm === true,
        prodBranch: config.steward.prodBranch,
        onLog: log,
      });
      if (!result.ok) return sendJson(res, 409, result);
      if (result.dryRun) log(`steward apply (dry run): ${name} — ${result.delete.length} would be deleted, ${result.roll.length} would be rolled`);
      else {
        log(`steward apply: ${name} — deleted ${result.deleted.length}, rolled ${result.rolled.length}, refused ${result.refused.length}`);
        broadcast({ type: "snapshot", data: snapshot() });
      }
      return sendJson(res, 200, result);
    }

    // ---- rolling one child into its parent ---------------------------------------------------------------------
    // The UNMERGED chip's first outcome. The merge happens inside the PARENT's own worktree, serialised per parent
    // branch (lib/locks.js), and is refused outright when the parent is master/main, when the parent is a guess rather
    // than a recorded cut, or when the parent branch is the project's production branch (that is a worker's or a TO's
    // job, never a merge run from here).
    if (route === "/api/worktree/rollup" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const project = (registry.projects || []).find((p) => p.name === String(body.project || "").trim()) || null;
      if (!project) return sendJson(res, 404, { error: `unknown project: ${body.project || "(none)"}` });
      const row = store.rowsFor(project.name).find((r) => normPathKey(r.path) === normPathKey(body.path)) || null;
      if (!row) return sendJson(res, 404, { error: `no row for ${body.path || "(no path)"} in ${project.name}` });
      const rec = parents.get(project.name, row.branch) || null;
      const parentBranch = String(body.parent || rec?.parent || "").trim();
      // One gate, shared with lib/steward.js, so the chip and the steward cannot disagree about what may be written.
      // The parent named by the request must be the parent on record: a body cannot promote a row to a rollable one.
      if (parentBranch && rec && rec.parent && parentBranch !== rec.parent) {
        return sendJson(res, 409, { error: `refused: ${parentBranch} is not ${row.branch || "this branch"}'s recorded parent (${rec.parent})` });
      }
      const listing = await stewardWorktrees(project.path);
      const parentWorktree = parentWorktreeOf(listing.trees, parentBranch);
      const gate = rollGate({ parentBranch, parentSource: rec?.parentSource || "unknown", mainBranch: project.mainBranch, prodBranch: config.steward.prodBranch, parentWorktree });
      if (!gate.ok) return sendJson(res, 409, gate);
      if (body.confirm !== true) {
        return sendJson(res, 428, { error: `nothing was rolled: confirming starts a merge into ${parentBranch} in its own worktree`, parent: parentBranch, branch: row.branch, preview: true });
      }
      const out = await rollUp({
        repoDir: project.path,
        parentBranch,
        parentWorktree,
        childBranch: row.branch,
        mainBranch: project.mainBranch,
        prodBranch: config.steward.prodBranch,
        parentSource: rec?.parentSource || "unknown",
        dryRun: body.dryRun === true,
      });
      if (!out.ok) return sendJson(res, 409, out);
      log(`rollup: ${row.branch} → ${parentBranch} in ${project.name} (${out.method}${out.sha ? ` ${out.sha}` : ""})`);
      broadcast({ type: "snapshot", data: snapshot() });
      return sendJson(res, 200, out);
    }

    // "Where should this go?" — the chip's third outcome, and the only thing it does: write the question down and
    // start nothing. It lands in the ledger the steward's plan reads, so the next plan lists it under "needs you".
    if (route === "/api/worktree/parent-question" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const project = (registry.projects || []).find((p) => p.name === String(body.project || "").trim()) || null;
      if (!project) return sendJson(res, 404, { error: `unknown project: ${body.project || "(none)"}` });
      const row = store.rowsFor(project.name).find((r) => normPathKey(r.path) === normPathKey(body.path)) || null;
      const question = questions.ask({
        project: project.name,
        path: body.path || row?.path || "",
        branch: body.branch || row?.branch || null,
        note: String(body.note || "").slice(0, 300),
        by: String(body.by || "the reader").slice(0, 80),
      });
      log(`steward: question recorded for ${question.branch || question.path} in ${project.name} — nothing was started`);
      return sendJson(res, 202, { ok: true, question, started: false });
    }

    if (route === "/api/parents" && req.method === "GET") {
      const name = String(url.searchParams.get("project") || "").trim();
      return sendJson(res, 200, { project: name || null, parents: parents.state(name || null) });
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
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
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
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const r = approvals.answer(body.id, body.choice, body.by || "ui");
      return sendJson(res, r.ok ? 200 : 409, r);
    }

    if (route.startsWith("/api/approvals/") && req.method === "GET") {
      const id = decodeURIComponent(route.slice("/api/approvals/".length));
      return sendJson(res, 200, approvals.status(id));
    }

    // ---- the TODO list of one worktree -------------------------------------------------------------------------
    // Read on demand (the row carries its own copy in /api/state; this is for the expanded strip's journal and for a
    // check that wants the whole list), and written by the reader's own buttons. Every write is stamped
    // `by: "reader"` and every refusal comes back WITH its reason — the page says it rather than looking like a
    // press that did nothing.
    if (route === "/api/todos" && req.method === "GET") {
      const key = todos.keyFor({ project: url.searchParams.get("project"), path: url.searchParams.get("path") || url.searchParams.get("tree") });
      if (!key) return sendJson(res, 400, { error: "a worktree is required: pass project and path (the row's own key)" });
      const rec = todos.list(key);
      return sendJson(res, 200, { key, list: rec ? { project: rec.project, path: rec.path, items: rec.items, journal: rec.journal } : null, summary: todos.summary(key) });
    }

    if (route === "/api/todos" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const op = String(body?.op || "").toLowerCase();
      const args = {
        project: body?.project || null,
        path: body?.path || null,
        id: body?.id === undefined || body?.id === null || body?.id === "" ? null : Number(body.id),
        text: body?.text ?? "",
        note: body?.note ?? null,
        files: Array.isArray(body?.files) ? body.files : null,
        by: "reader",
        owner: null,
        from: "reader",
      };
      let r;
      if (op === "add") r = todos.write({ ...args, op: "add" });
      else if (op === "edit") r = todos.write({ ...args, op: "edit" });
      else if (op === "note") r = todos.write({ ...args, op: "note" });
      else if (op === "files") r = todos.write({ ...args, op: "files" });
      else if (["done", "doing", "drop", "dropped", "reopen", "todo"].includes(op)) r = todos.setStatus({ ...args, op });
      else r = { ok: false, error: `unknown todo op “${op || "(none)"}” — one of add, edit, note, done, doing, drop, reopen` };
      if (r.ok) broadcastTodos();
      return sendJson(res, r.ok ? 200 : 400, {
        ok: Boolean(r.ok),
        error: r.error || null,
        message: r.ok ? todoSay(op, r.item) : null,
        key: r.key || null,
        summary: r.key ? todos.summary(r.key) : null,
        journal: r.list ? r.list.journal.slice(-6) : [],
      });
    }

    // ---- who may put a branch on a remote ------------------------------------------------------------
    // The page's own view of it: what is parked, what the setting is, and which trees carry the guard.
    if (route === "/api/remote-write/state" && req.method === "GET") {
      return sendJson(res, 200, {
        ...remoteWrites.state(),
        policies: POLICIES,
        defaultPolicy: DEFAULT_POLICY,
        configPath: CONFIG_PATH,
        guards: guardReport(),
      });
    }

    // THE GUARD ASKING. A local-only worktree's `git push` reaches here (lib/push-guard.js writes the hook that
    // calls it) and this is what draws the permission box. Three answers, and the hook reads them off the body:
    //   allowed:true          — go ahead (the setting allows it, the tree was started to land, or a grant stands)
    //   refused:true          — no, and no question to ask (the setting is `deny`)
    //   id + deadline         — a question is parked in the dock; the hook polls the status route for the answer
    if (route === "/api/remote-write/request" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const worktree = String(body.worktree || "");
      // The project that owns this tree decides, not the global default (which is local-only for every other
      // checkout): a repo that lands by PR is allowed here, and one whose branches merge into a parent is refused.
      const found = spawnFeature.projectForPath(worktree);
      const policy = policyForProject(found, config.remoteBranchPolicy);
      const decision = remoteWrites.decision(worktree, policy);
      if (decision.allowed) {
        // A one-shot grant is spent by the write it was given for.
        if (decision.consume) remoteWrites.spend(worktree);
        return sendJson(res, 200, { allowed: true, why: decision.why, policy });
      }
      if (!decision.ask) {
        log(`remote write refused without asking: ${cleanPath(worktree)} (${decision.why}, policy ${policy})`);
        return sendJson(res, 200, { allowed: false, refused: true, why: decision.why, policy });
      }
      const remote = String(body.remote || "") || found?.remote || "";
      const branch = String(body.branch || "");
      const req0 = remoteWrites.request({
        kind: "push",
        worktree,
        project: found?.name || "",
        branch,
        remote,
        refs: String(body.refs || ""),
        title: `${path.basename(worktree || "") || worktree} wants to push`,
        command: `git push ${remote || "<remote>"} ${branch || "<branch>"}   — from ${cleanPath(worktree)}${body.remoteUrl ? ` (${String(body.remoteUrl).slice(0, 120)})` : ""}`,
        description: "a worker in this LOCAL-ONLY worktree is trying to put a branch on the remote. Nothing is pushed until you answer, and Deny leaves the remote untouched.",
      });
      return sendJson(res, 200, {
        allowed: false,
        id: req0.id,
        deadline: req0.deadline,
        timeoutSeconds: req0.timeoutSeconds,
        policy,
        why: `${policy === "local-only" ? "local only" : policy} — this push is parked on your permission box`,
      });
    }

    // What the parked hook long-polls. A request nobody answered reads as `deny` once its window closes.
    if (route === "/api/remote-write/status" && req.method === "GET") {
      const id = url.searchParams.get("id") || "";
      const st = remoteWrites.status(id);
      // The one-shot grant is handed to the hook that asked for it: it is spent as soon as the hook has been told,
      // so a second push cannot ride the same answer.
      if (st.status === "answered" && st.choice === "once") remoteWrites.spend(remoteWrites.treeOfDecision(id));
      return sendJson(res, 200, st);
    }

    // The reader's answer, from the panel's own permission box. Same four choices, same semantics as an approval:
    // once / this session / always (which IS the setting) / deny. Anything the question was parked on is resumed
    // here — the panel's own merge flow starts only after a yes.
    if (route === "/api/remote-write/answer" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const id = String(body.id || "");
      // Read the resumable action BEFORE the answer clears the request, and never twice: a second press finds
      // nothing to run.
      const resume = remoteWrites.takeResume(id);
      const out = remoteWrites.answer(id, body.choice, { by: body.by || "reader" });
      if (!out.ok) return sendJson(res, 409, out);
      let resumed = null;
      if (resume && out.choice !== "deny") {
        try {
          resumed = await resume();
          log(`remote-write ${id}: the granted write was resumed (${resumed?.status || "ok"})`);
        } catch (e) {
          resumed = { status: 500, error: String((e && e.message) || e) };
          log(`remote-write ${id}: resuming the granted write failed — ${resumed.error}`);
        }
      }
      return sendJson(res, 200, { ...out, resumed, state: remoteWrites.state() });
    }

    // The setting itself. Written into this panel's config.json (with every other key left exactly as it was),
    // pushed into the guards' own copies, and broadcast so a second tab sees it at once.
    if (route === "/api/settings/remote-branches" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const wanted = String(body.policy || "").trim().toLowerCase();
      if (!POLICIES.includes(wanted)) {
        return sendJson(res, 400, { error: `the setting must be one of: ${POLICIES.join(", ")}`, settings: settingsOut() });
      }
      const out = await setRemotePolicy(wanted, { by: "the Settings row" });
      if (out.error) return sendJson(res, 500, { error: out.error, settings: settingsOut() });
      return sendJson(res, 200, {
        ok: true,
        ...out,
        settings: settingsOut(),
        guards: guardReport(),
        note:
          wanted === "allow"
            ? "saved — remote writes go through without asking from now on (the guard's own copy says so too)"
            : wanted === "deny"
              ? "saved — remote writes are refused outright, and the box will not even be offered"
              : "saved — branches stay local unless you allow a write in the permission box",
      });
    }

    // Put the guard in (or take it out of) the worktrees of a project, or in every local-only tree the board
    // knows. The automatic path is the panel's own worktree creation; this is the deliberate one, for trees that
    // were cut before the guard existed.
    if (route === "/api/remote-write/guard" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const action = String(body.action || "install").toLowerCase();
      const one = String(body.path || "").trim();
      if (action === "remove") {
        if (!one) return sendJson(res, 400, { error: "path is required to remove the guard" });
        const out = await uninstallGuard({ worktree: path.resolve(one), log });
        delete guardRecord.trees[normTree(one)];
        writeGuardRecord();
        return sendJson(res, out.ok ? 200 : 500, { ...out, guards: guardReport() });
      }
      const targets = [];
      if (one) {
        targets.push({ tree: path.resolve(one), projectPath: null });
      } else if (String(body.project || "").trim()) {
        const project = registry.projects.find((p) => p.name === String(body.project).trim());
        if (!project) return sendJson(res, 404, { error: `unknown project: ${body.project}` });
        for (const row of scheduler.store.rowsFor(project.name)) targets.push({ tree: row.path, projectPath: project.path, project: project.name, branch: row.branch });
      } else {
        // Every LOCAL-ONLY tree the board holds: a branch that exists on the remote is not one of these, and the
        // project's own checkout is never touched (the reader pushes there himself).
        for (const project of registry.projects) {
          for (const row of scheduler.store.rowsFor(project.name)) {
            if (normPathKey(row.path) === normPathKey(project.path)) continue;
            if (row.remoteBranch === "exists") continue;
            targets.push({ tree: row.path, projectPath: project.path, project: project.name, branch: row.branch });
          }
        }
      }
      const done = [];
      for (const t of targets) {
        if (!t.projectPath) {
          const proj = spawnFeature.projectForPath(t.tree);
          t.projectPath = proj?.path || t.tree;
          t.project = proj?.name || null;
        }
        // Idempotent, and never a reason to fail the request: one tree that cannot take a hooks path (a directory
        // held open, a git dir that is not there) is reported and the rest carry on.
        const out = await installGuardFor({ projectPath: t.projectPath, worktree: t.tree, branch: t.branch, project: t.project }).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        done.push({ tree: cleanPath(t.tree), ok: Boolean(out.ok), error: out.error || null, dir: out.dir || null, shims: out.shims || [] });
      }
      log(`push guard: install asked for ${done.length} worktree(s), ${done.filter((d) => d.ok).length} ok`);
      return sendJson(res, 200, { ok: true, installed: done.filter((d) => d.ok).length, failed: done.filter((d) => !d.ok).length, trees: done, guards: guardReport() });
    }
    // Preview the exact request that would be sent — the confirm affordance.
    if (route === "/api/agents/preview" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      return sendJson(res, 200, await spawnFeature.previewPayload(body));
    }

    if (route === "/api/agents" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      // Which project, and which directory: the directory is the ground truth, so a stale project
      // picker is corrected here, before anything downstream reads it.
      const aimed = spawnFeature.targetForSpawn(body);
      if (!aimed.ok) return sendJson(res, 400, { error: aimed.error });
      if (aimed.project !== undefined) body.project = aimed.project;
      if (body.dryRun) return sendJson(res, 200, spawnFeature.dryRunPayload(body, aimed.target));
      // Which backend runs it. Hermes is the default; anything the panel has no transport for is refused here.
      const agent = String(body.agent || "hermes");
      if (!jobs.transports[agent]) return sendJson(res, 400, { error: `unknown agent: ${agent} (one of: ${Object.keys(jobs.transports).join(", ")})` });
      body.agent = agent;
      // Refuse before promising a job: a stopped gateway, a missing key or an absent CLI is the answer to "why did
      // nothing happen", not a card that says "starting" forever.
      const linked = await spawnFeature.linkSpawn(body, aimed.target, aimed.cwdProject);
      if (!linked.ok) return sendJson(res, linked.status, linked.payload);
      const job = await jobs.create({ ...body, ...linked.fields });
      return sendJson(res, 202, { job });
    }

    // Continue a conversation: same named thread, no new worktree, run where the agent is.
    // A repo with no commits cannot host a worktree (there is no HEAD to branch from), and the spawn
    // refuses with that reason. This is the one-line fix that reason asks for: an EMPTY commit, so no
    // file is invented for the repo, and never a push — the commit stays local.
    if (route === "/api/repo/first-commit" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
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
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
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
      // Under the data directory, never inside the checkout: an attachment is state the panel keeps, and its
      // absolute path is what goes into the run's prompt (lib/paths.js owns the default).
      const dir = config.attachmentsDir;
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
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const thread = String(body.thread || "").trim();
      if (!thread) return sendJson(res, 400, { error: "thread is required" });
      return sendJson(res, 200, jobs.setThreadModel(thread, body.model));
    }

    if (route === "/api/threads/context" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const thread = String(body.thread || "").trim();
      if (!thread) return sendJson(res, 400, { error: "thread is required" });
      return sendJson(res, 200, jobs.setThreadContext(thread, body.limit));
    }

    if (route === "/api/agents/reply" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
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
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      return sendJson(res, 200, { ok: jobs.cancel(String(body.id || "")) });
    }

    // Steer a turn that is already running: the text is injected at the agent's next tool boundary,
    // so it can change course without ending the turn. 409 means it crossed the last boundary.
    if (route === "/api/jobs/steer" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const r = await jobs.steer(String(body.id || ""), body.text ?? body.input);
      // A steer lands inside the turn that is already running, so its documents belong to that turn's
      // card rather than to a new one.
      if (r.ok && Array.isArray(body.attachments) && body.attachments.length) jobs.addAttachments(String(body.id || ""), body.attachments);
      return sendJson(res, r.ok ? 200 : r.code === "run_not_accepting_steer" ? 409 : 400, r);
    }

    // The NOT-RUNNABLE chip's press: ask the gateway about ONE interrupted card's run and take the same decision
    // the boot reconcile takes (lib/jobs.js settleRestoredRun — one implementation, not two). The pointers are
    // looked up only here, because only this answer leaves the reader with nothing left to click: a run the gateway
    // has forgotten settles as interrupted, and the card has to name the tree the work is in and its PR.
    if (route === "/api/jobs/reattach" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const id = String(body?.id || "").trim();
      const r = await jobs.reattachNow(id, { pointers: gonePointers(id) });
      // 400 for a card this route cannot ask about at all (unknown, no run id, not interrupted), and for a gateway
      // that will not answer: the press is a question the panel understood and cannot settle, and the card keeps its
      // verdict. A decision always comes back as 200 with the card it left behind.
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    // The press on a finished card's COMPLETE chip: queue ONE ask for the board assistant and send nothing to the
    // agent. It goes through the assistant's own wake queue — the path an alert handed over uses — and never through
    // /api/assistant/say, which starts a turn at once and would talk over a run already in flight. The answer carries
    // what the queue decided, so the chip can say the ask landed or say why it did not; a card this route cannot ask
    // about (unknown, or no longer `done`) is a 400 with the reason.
    if (route === "/api/jobs/ask-complete" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        return sendJson(res, 200, assistant.askAboutComplete(String(body?.id || "").trim()));
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e), ok: false });
      }
    }

    // Answer a parked run's approval. The gateway validates the choice a second time, so a stale
    // card cannot widen what the host allows.
    if (route === "/api/jobs/approve" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const r = await jobs.approve(String(body.id || ""), body.choice, body.requestId ?? body.request_id);
      // 409 for "there is nothing to answer any more" — the gateway's own verdict on a prompt it has let go, and
      // the panel's on one whose window closed (`gone`), so a client can tell it from a malformed request.
      return sendJson(res, r.ok ? 200 : r.gone || r.code === "approval_not_pending" ? 409 : 400, r);
    }

    // Answer a question the agent's `clarify` tool is blocked on. Same fence as an approval: the
    // gateway re-validates the prompt id against the run's pending controls and its execution
    // generation, so a stale card cannot answer a question that has already been settled.
    if (route === "/api/jobs/answer" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
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
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const thread = String(url.searchParams.get("thread") || "").trim();
      if (!thread) return sendJson(res, 400, { error: "thread is required" });
      const from = Number(url.searchParams.get("from"));
      const to = Number(url.searchParams.get("to"));
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
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const thread = String(url.searchParams.get("thread") || "").trim();
      const tool = String(url.searchParams.get("tool") || "").trim();
      const from = Number(url.searchParams.get("from")) || 0;
      const to = Number(url.searchParams.get("to")) || 0;
      // How many results the console is about to draw: a burst of six calls needs six, not a default of eight
      // that silently stops halfway through a longer run.
      const limit = Math.max(1, Math.min(60, Number(url.searchParams.get("n")) || 20));
      // One row, exactly as stored, for the console's fold: `row` picks which of the turn's results (the order the
      // console paired them in) and `full=1` lifts the store reader's own 6,000-character display cap. Without
      // them this is the array the burst pairing reads; with them it is the whole text behind one folded result.
      const rowParam = url.searchParams.get("row");
      const index = rowParam === null ? null : Math.max(0, Number(rowParam) || 0);
      const full = url.searchParams.get("full") === "1";
      if (!thread || !tool) return sendJson(res, 400, { error: "thread and tool are required" });
      const { toolResults } = await import("./lib/tool-results.js");
      // `full=1` reads the row exactly as it was stored (maxChars 0 = no cap); without it the store reader's own
      // 6,000-character display cap applies to every row of the array.
      const results = toolResults({
        dbPath: path.join(hermesHome(), "state.db"), sessionId: thread, tool, from, to, limit, index,
        ...(full ? { maxChars: 0 } : {}),
      });
      return sendJson(res, 200, { thread, tool, results });
    }

    if (route === "/api/subagents/collect" && req.method === "GET") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const thread = String(url.searchParams.get("thread") || "").trim();
      if (!thread) return sendJson(res, 400, { error: "thread is required" });
      const from = Number(url.searchParams.get("from"));
      const to = Number(url.searchParams.get("to"));
      const out = collectPrompt(thread, {
        dbPath: path.join(hermesHome(), "state.db"),
        from: Number.isFinite(from) ? from : 0,
        to: Number.isFinite(to) ? to : 0,
      });
      if (!out) return sendJson(res, 404, { error: "could not read that session's subagents" });
      return sendJson(res, 200, out);
    }

    if (route === "/api/subagents/console" && req.method === "GET") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const session = String(url.searchParams.get("session") || "").trim();
      if (!session) return sendJson(res, 400, { error: "session is required" });
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
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
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
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const thread = String(url.searchParams.get("thread") || "").trim();
      // Children the run delegated: their sessions, their state and the last thing each one did. Polled while a
      // card is working, because the gateway does not put a child's work on the parent's event stream.
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
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
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
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
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
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
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
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
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
      // Every POST goes through authorised(): with the panel reachable off this machine, "this route
      // forgot to check" is not a thing the next route should be able to repeat. Loopback is exempt, so
      // the local board is unaffected.
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      await scheduler.fastPass();
      return sendJson(res, 200, { ok: true });
    }

    // Which project sections the page can see right now. Sent when the set changes and as a heartbeat; in
    // scanMode "visible" it is what the scheduler reads instead of the whole fleet. It writes the scheduler's
    // visible set, so it is a write like any other: a route does not get to decide that the panel token does
    // not apply to it.
    if (route === "/api/visible" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
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
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
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

    // How old a worktree has to be before the chart holds its row back, so the board can open on the trees that
    // are still being worked in. Server-side for the same reason the refresh mode is: the number goes into this
    // panel's own config.json, so it survives a restart and applies to whichever browser is open — and it is the
    // config.json the reader edits by hand. `days: 0` shows everything.
    if (route === "/api/settings/age" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const days = ageDaysFrom(body.days);
      try {
        await patchPanelConfig({ hideOlderThanDays: days });
      } catch (e) {
        return sendJson(res, 500, { error: `could not write config.json: ${String((e && e.message) || e)}` });
      }
      config.hideOlderThanDays = days;
      log(`worktrees older than: ${days ? `${days} day${days === 1 ? "" : "s"} held back (the chart's arrow shows them)` : "none held back"}`);
      broadcast({ type: "snapshot", data: snapshot() });
      return sendJson(res, 200, { ok: true, days, settings: settingsOut() });
    }

    // Open a link from an agent's console in the OS default browser. Only http(s) gets through, and the
    // URL is handed to the opener as a single argv element: no shell, no `cmd.exe /c start`, so a query
    // string cannot become a second command. See lib/open-url.js for what that cost before.
    if (route === "/api/open-url" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const { url, error } = safeUrl(body.url);
      if (!url) return sendJson(res, 400, { error });
      const { bin, args } = openerFor(url);
      try {
        // Detached: the browser outlives this request, and its exit code says nothing about whether a
        // page opened. A spawn failure is the only failure this route can honestly report.
        const child = spawn(bin, args, { detached: true, stdio: "ignore", windowsHide: true });
        child.on("error", (e) => log(`could not open ${url}: ${String((e && e.message) || e)}`));
        child.unref();
      } catch (e) {
        return sendJson(res, 500, { error: String((e && e.message) || e) });
      }
      return sendJson(res, 200, { ok: true, url });
    }

    // Delete a deliverable. The confirmation lives in the UI; this only acts on a path or URL the panel
    // itself recorded, so a stray string from the page can never delete an arbitrary file.
    if (route === "/api/jobs/artifact/delete" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
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

    // Remove a worktree from the board: the directory goes to the Windows Recycle Bin (recoverable), then git's
    // own bookkeeping is pruned. Never the project's own checkout, never a tree with a live agent, never a locked
    // tree. The act itself is lib/worktree-remove.js, because the answer a CHECKING agent gives (LANDED: YES) ends in
    // the same removal and has to pass through the same guards - the lock, the live-agent check and what git still
    // lists are enforced there, so a second caller cannot arrive one guard short of this one.
    if (route === "/api/worktree/delete" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const projectName = String(body.project || "").trim();
      const target = path.resolve(String(body.path || "").trim());
      const project = scheduler.getProjects().find((p) => p.name === projectName);
      if (!project) return sendJson(res, 404, { error: `unknown project: ${projectName}` });
      const row = scheduler.store.rowsFor(projectName).find((r) => path.resolve(r.path) === target);
      if (!row) return sendJson(res, 404, { error: `not a worktree row of ${projectName}: ${target}` });
      const out = await deleteWorktreeRow({ project, row, target, jobs, locks, onLog: log });
      if (!out.ok) return sendJson(res, out.status || 500, { error: out.error, lock: out.lock || undefined });
      // Drop by the path the STORE knows, not by `path.resolve(target)`: rows are keyed by the scanned path with
      // forward slashes, so a resolved Windows path is a different key and the row survived its own deletion.
      scheduler.store.dropRow(projectName, row.path);
      // A snapshot only refreshes the rows it carries - it never retracts one - so the removal needs its own event
      // or the row sits on every open board for a worktree that no longer exists.
      broadcast({ type: "drop", project: projectName, path: row.path });
      broadcast({ type: "snapshot", data: snapshot() });
      return sendJson(res, 200, out);
    }

    // Open a file an agent produced for the reader. Not a URL: a real path, opened in an editor.
    if (route === "/api/open-path" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const target = path.resolve(String(body.path || "").trim());
      const info = await stat(target).catch(() => null);
      if (!info || !info.isFile()) return sendJson(res, 404, { error: `no such file: ${target}` });
      const [bin, args] = await editorFor(target);
      try {
        // Detached, and no waiting: an editor stays open until the reader closes it, so an execFile
        // callback would hold this response (and the browser) hostage for the whole editing session.
        // windowsHide belongs with detached: a detached child is the one Windows gives its own console,
        // so leaving it out here is a console window appearing next to the editor (and off a .cmd shim,
        // the cmd.exe that hosts it).
        const child = spawn(bin, args, { detached: true, stdio: "ignore", windowsHide: true });
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
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
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

    // The UNMERGED chip's button: start the merge agent for one worktree. The board's verdict is a scan behind and
    // a half-finished tree is the one thing that must never be merged, so every fact the button's enabled state
    // claims is re-read here, from git, before a run exists. The prompt is lib/merge-prompt.js (the script the agent
    // is held to); `dryRun` hands it back for a preview without starting anything.
    if (route === "/api/worktree/merge" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const asked = String(body.path || "").trim();
      if (!asked) return sendJson(res, 400, { error: "path is required" });
      const worktree = path.resolve(asked);
      const info = await stat(worktree).catch(() => null);
      if (!info || !info.isDirectory()) return sendJson(res, 404, { error: `no such directory: ${worktree}` });
      // A worktree can live anywhere (`git worktree add ../tree`), so a path outside the project's own root is not an
      // error by itself: the row's project is the hint, and git's own worktree list is the proof that the hint is real.
      let project = spawnFeature.projectForPath(worktree) || registry.projects.find((p) => normPathKey(p.path) === normPathKey(worktree));
      let trees = project ? await worktreeList(project.path).catch(() => []) : [];
      if (!project) {
        const hinted = registry.projects.find((p) => p.name === String(body.project || "").trim());
        if (hinted) {
          const listed = await worktreeList(hinted.path).catch(() => []);
          if (listed.some((w) => normPathKey(w.path) === normPathKey(worktree))) {
            project = hinted;
            trees = listed;
          }
        }
      }
      if (!project) return sendJson(res, 400, { error: `${worktree} is not inside a known project, and is not one of its worktrees` });
      const base = String(project.mainBranch || "");
      if (!base) return sendJson(res, 400, { error: `${project.name} has no base branch (no main/master and no remote default) to merge into` });
      const remote = project.remote || null;
      const baseRef = remote ? `${remote}/${base}` : base;
      const row = await scanWorktree(worktree, { remoteRef: baseRef, mainBranch: base }, "fast");
      if (row.error) return sendJson(res, 400, { error: row.error });
      if (row.branch === base) return sendJson(res, 409, { error: `${path.basename(worktree)} is on ${base} itself — there is nothing to land` });
      if (row.ahead === null) return sendJson(res, 409, { error: `cannot count commits against ${baseRef} in this worktree — is the base ref there?` });
      if (row.ahead === 0) return sendJson(res, 409, { error: `${row.branch} has no commits off ${base} — nothing to land` });
      const dirty = Number(row.dirty) || 0;
      const untracked = Number(row.untracked) || 0;
      if (dirty || untracked) {
        return sendJson(res, 409, {
          error: `the tree is not clean (${dirty} modified, ${untracked} untracked) — commit or stash them first, so a merge cannot carry someone else's work`,
        });
      }
      const label = mergeLabel(base);
      // One merge agent per worktree: a second would race the first over the same base branch.
      const live = jobs
        .list()
        .find((j) => isLiveJobStatus(j.status) && normPathKey(j.ownerPath || j.cwd) === normPathKey(worktree) && String(j.label || "").startsWith("MERGING into "));
      if (live) return sendJson(res, 409, { error: `an agent is already merging this worktree (${live.label || live.thread})` });
      const list = await gitIn(worktree, ["log", "--oneline", "-20", `${baseRef}..HEAD`], 20000);
      const commitList = list.ok ? list.out.split("\n").filter(Boolean) : [];
      // Where the base branch is actually checked out — normally the project's own checkout, but the worktree list
      // read above is the only thing that knows, and merging into a branch that is checked out elsewhere needs that
      // directory.
      const root = (trees.find((w) => w.branch === base) || trees[0] || { path: project.path }).path;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      // The reader's lock goes into the agent's own script, not just into the board: a merge agent's last phase is
      // cleanup, and that is exactly where a locked tree must not be touched. The delete route refuses it too — this
      // is so the agent never tries and then reports a failure it cannot understand.
      const lock = locks.check({ project: project.name, path: worktree, branch: row.branch });
      const prompt = mergePrompt({
        project: project.name,
        worktree,
        root,
        branch: row.branch,
        base,
        remote,
        baseRef,
        ahead: row.ahead,
        commits: commitList,
        stamp,
        locked: lock.locked ? lock : null,
        panelPort: config.port,
        // Where this branch lands — the doctrine of the project's host (logs/hosts.json), not a shape chosen here. A
        // project with no mapping hands over null, and the prompt says so instead of inventing a PR.
        host: hosts.landing(project, { branch: row.branch }),
      });
      const thread = makeThreadName(`${label} ${project.name}`);
      const preview = { project: project.name, base, baseRef, remote, branch: row.branch, ahead: row.ahead, root, worktree: worktree.replace(/\\/g, "/"), label, thread, prompt, lock: lock.locked ? lock : null };
      if (body.dryRun) return sendJson(res, 200, { dryRun: true, ...preview });
      // The whole start, as its own function, because a local-only panel may have to PARK it on the reader's
      // permission box first and run it the moment they say yes. The one thing the merge agent does that touches
      // the world outside this box is PHASE 4's push, so that is the panel's own remote write and it asks first.
      const startMerge = async () => {
        const transport = await jobs.probe();
        if (!transport.reachable || !transport.capabilities?.runs) {
          return { status: 503, body: { error: `the Hermes gateway API is not usable at ${jobs.api.url}${transport.error ? `: ${transport.error}` : ""}`, ...preview, prompt: undefined } };
        }
        const top = await gitIn(worktree, ["rev-parse", "--show-toplevel"], 15000);
        const ownerPath = top.ok && top.out ? top.out : worktree;
        // `remoteWrite: "land"` is what tells lib/jobs.js this worker MAY push and names the landing step: the
        // merge prompt says so in every phase, and the brief line must not contradict it.
        const job = await jobs.create({ prompt, thread, cwd: worktree, existing: true, ownerPath, project: project.name, remoteWrite: "land", remote, baseBranch: base });
        // The card is named for the job it is doing before it draws: the label survives the thread for good, and it
        // is what the route above reads back to refuse a second merge agent in the same tree.
        jobs.setLabel(job.thread, label);
        if (job.status === "failed") return { status: 502, body: { error: job.error || "the run could not be started", job, ...preview, prompt: undefined } };
        log(`merge ${row.branch} -> ${base} in ${project.name}: job ${job.id} (${job.status})`);
        return { status: 202, body: { job, ...preview } };
      };
      // The MERGE flow asks under this project's policy too: a repo that lands by PR is answered from its own
      // setting, and one that is local-only asks the reader like anything else.
      const decision = remoteWrites.decision(worktree, policyForProject(project, config.remoteBranchPolicy));
      if (decision.allowed) {
        // A one-shot grant is spent by the write it was granted for.
        if (decision.consume) remoteWrites.spend(worktree);
        const out = await startMerge();
        return sendJson(res, out.status, out.body);
      }
      if (!decision.ask) {
        return sendJson(res, 403, {
          error: `nothing was started: ${decision.why}. The merge agent pushes the base branch as its last phase, so the panel will not start one while remote writes are refused.`,
          ...preview,
          prompt: undefined,
        });
      }
      // Local only (the default): park it on the permission box. Answering Allow starts the merge; Deny starts
      // nothing at all, which is the difference between asking and telling.
      const parked = remoteWrites.request({
        kind: "merge",
        worktree,
        project: project.name,
        branch: row.branch,
        remote,
        title: `${label} — ${project.name}`,
        command: `git push ${remote || "<remote>"} ${base}   (PHASE 4 of ${label}, in ${root} — the merge itself is only staged first)`,
        description:
          "the panel's OWN merge flow, which pushes the base branch once the branch has landed and the tests pass. Allow starts the merge agent; Deny starts nothing and touches neither tree.",
        timeoutSeconds: config.remoteWriteSeconds,
        resume: async () => {
          const out = await startMerge();
          if (out.status >= 400) log(`remote-write ${parked.id}: the granted merge could not start — ${out.body?.error || out.status}`);
          // The page finds the new card through the ordinary job events this emits.
          broadcast({ type: "jobs", jobs: jobs.list() });
          return out;
        },
      });
      log(`merge ${row.branch} -> ${base} in ${project.name}: parked on the permission box (${parked.id}) — the setting is local-only`);
      return sendJson(res, 202, { pending: { id: parked.id, deadline: parked.deadline, timeoutSeconds: parked.timeoutSeconds, kind: "merge" }, ...preview, prompt: undefined });
    }

    // The UNMERGED chip's fourth outcome: an agent that CHECKS the branch against the base, because the commit count
    // cannot answer it. A squash, a rebase or a hand-rewritten patch leaves the branch carrying commits of its own
    // while the base holds the change under another sha, so "is it on main?" is a question about CONTENT, and
    // lib/verify-prompt.js is the script that answers it from the content itself (a reverse-apply of the branch's own
    // patch to a pristine export of the base).
    //
    // The run writes nothing to either branch, so it does NOT pass through the remote-write box: the only act that
    // follows its answer is the panel's own delete - on LANDED: YES, through the same lib/worktree-remove.js the ✕
    // uses, so a locked tree, a tree with a live agent and a tree with uncommitted work are all still refused.
    // `dryRun` hands the script back without starting anything, the way the merge route does.
    if (route === "/api/worktree/verify-landed" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const asked = String(body.path || "").trim();
      if (!asked) return sendJson(res, 400, { error: "path is required" });
      const worktree = path.resolve(asked);
      const info = await stat(worktree).catch(() => null);
      if (!info || !info.isDirectory()) return sendJson(res, 404, { error: `no such directory: ${worktree}` });
      // The same resolution the merge route does, for the same reason: a worktree can live anywhere, so the row's
      // project is the hint and git's own worktree list is the proof that the hint is real.
      let project = spawnFeature.projectForPath(worktree) || registry.projects.find((p) => normPathKey(p.path) === normPathKey(worktree));
      let trees = project ? await worktreeList(project.path).catch(() => []) : [];
      if (!project) {
        const hinted = registry.projects.find((p) => p.name === String(body.project || "").trim());
        if (hinted) {
          const listed = await worktreeList(hinted.path).catch(() => []);
          if (listed.some((w) => normPathKey(w.path) === normPathKey(worktree))) {
            project = hinted;
            trees = listed;
          }
        }
      }
      if (!project) return sendJson(res, 400, { error: `${worktree} is not inside a known project, and is not one of its worktrees` });
      const base = String(project.mainBranch || "");
      if (!base) return sendJson(res, 400, { error: `${project.name} has no base branch (no main/master and no remote default) to check against` });
      const remote = project.remote || null;
      const baseRef = remote ? `${remote}/${base}` : base;
      const row = await scanWorktree(worktree, { remoteRef: baseRef, mainBranch: base }, "fast");
      if (row.error) return sendJson(res, 400, { error: row.error });
      if (row.branch === base) return sendJson(res, 409, { error: `${path.basename(worktree)} is on ${base} itself - there is nothing to check` });
      if (row.ahead === null) return sendJson(res, 409, { error: `cannot count commits against ${baseRef} in this worktree - is the base ref there?` });
      if (row.ahead === 0) return sendJson(res, 409, { error: `${row.branch} has no commits off ${base} - there is nothing to check` });
      const label = verifyLabel(base);
      // One check agent per worktree: a second would spend the gateway's run on the answer the first one is writing.
      const running = jobs
        .list()
        .find((j) => isLiveJobStatus(j.status) && normPathKey(j.ownerPath || j.cwd) === normPathKey(worktree) && String(j.label || "").startsWith("CHECKING "));
      if (running) return sendJson(res, 409, { error: `an agent is already checking this worktree (${running.label || running.thread})` });
      const list = await gitIn(worktree, ["log", "--oneline", "-20", `${baseRef}..HEAD`], 20000);
      const commitList = list.ok ? list.out.split("\n").filter(Boolean) : [];
      const root = (trees.find((w) => w.branch === base) || trees[0] || { path: project.path }).path;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const lock = locks.check({ project: project.name, path: worktree, branch: row.branch });
      const prompt = verifyPrompt({
        project: project.name,
        worktree,
        root,
        branch: row.branch,
        base,
        baseRef,
        remote,
        ahead: row.ahead,
        commits: commitList,
        stamp,
        // What the board knows, so the agent reads a clean tree rather than trusting this line: the panel will refuse
        // the delete for a dirty tree, and the report has to say so before the reader wonders why nothing moved.
        dirty: row.dirty,
        untracked: row.untracked,
        locked: lock.locked ? lock : null,
        panelPort: config.port,
        scratchBase: tmpdir(),
      });
      const thread = makeThreadName(`${label} ${project.name}`);
      const preview = { project: project.name, base, baseRef, remote, branch: row.branch, ahead: row.ahead, root, worktree: worktree.replace(/\\/g, "/"), label, thread, prompt, lock: lock.locked ? lock : null };
      if (body.dryRun) return sendJson(res, 200, { dryRun: true, ...preview });
      const transport = await jobs.probe();
      if (!transport.reachable || !transport.capabilities?.runs) {
        return sendJson(res, 503, { error: `the Hermes gateway API is not usable at ${jobs.api.url}${transport.error ? `: ${transport.error}` : ""}`, ...preview, prompt: undefined });
      }
      const top = await gitIn(worktree, ["rev-parse", "--show-toplevel"], 15000);
      const ownerPath = top.ok && top.out ? top.out : worktree;
      // `remoteWrite: "none"` is the promise this run makes: a check reads, so the landing paragraphs stay out of its
      // brief and no push guard is installed for a push it must never make.
      const job = await jobs.create({ prompt, thread, cwd: worktree, existing: true, ownerPath, project: project.name, remoteWrite: "none" });
      // The label is what the sweep reads the answer back from, so it is set before the card draws.
      jobs.setLabel(job.thread, label);
      if (job.status === "failed") return sendJson(res, 502, { error: job.error || "the run could not be started", job, ...preview, prompt: undefined });
      log(`check ${row.branch} against ${base} in ${project.name}: job ${job.id} (${job.status})`);
      return sendJson(res, 202, { job, ...preview });
    }

    // Give a worktree a name of its own: the directory and its branch. The row is looked up by path, and the whole
    // operation refuses while an agent is running in the tree - see renameWorktree().
    //
    // This is the DELIBERATE half: it renames whenever the reader asks, including a tree the automatic half has
    // already named (replacing a name is the point), and it writes down who asked and when - the naming ledger's
    // record is what stops every later automatic rename of this tree.
    if (route === "/api/worktree/rename" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const out = await renameWorktree({
        projectName: String(body.project || "").trim(),
        target: String(body.path || "").trim(),
        name: String(body.name || "").trim(),
        by: String(body.by || "").trim().slice(0, 80) || "the reader",
        how: String(body.how || "").trim().slice(0, 160) || "renamed from the row",
      });
      if (out.error) return sendJson(res, out.status || 500, { error: out.error });
      return sendJson(res, 200, { ...out, name: path.basename(out.path), namedLine: describeNaming(out.named) });
    }

    // What the tree should be called, read from the work in it: the branch's own commits and its diff against the
    // project's base branch. It renames NOTHING - the row's ✦ shows this name, the commits behind it and where they
    // came from, and the rename itself is the reader's second click on /api/worktree/rename above.
    if (route === "/api/worktree/suggest-name" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const projectName = String(body.project || "").trim();
      const project = scheduler.getProjects().find((p) => p.name === projectName);
      if (!project) return sendJson(res, 404, { error: `unknown project: ${projectName}` });
      const dir = path.resolve(String(body.path || "").trim());
      // A row, not a free path: the same door the rename uses, so this can only ever read a tree the panel watches.
      const row = scheduler.store.rowsFor(projectName).find((r) => path.resolve(r.path) === dir);
      if (!row) return sendJson(res, 404, { error: `not a worktree row of ${projectName}: ${dir}` });
      if (normPathKey(dir) === normPathKey(project.path) || (await isMainCheckout(dir))) {
        return sendJson(res, 400, { error: "that is the project's own checkout, not a worktree — its name is the project folder's" });
      }
      // The naming path, so it obeys the rename's rule: an untagged directory has no tag for the offered name to
      // keep, and `Name it` would post a rename that refuses. Say so here rather than offering a name that cannot land.
      const refusal = renameRefusal(dir);
      if (refusal) return sendJson(res, 400, { error: refusal });
      // The tag every rename keeps, so the name this offers is already the whole directory name the row would get.
      const tag = tagOf(dir) || tagOf(row.branch) || null;
      const picked = await suggestWorktreeName({
        dir,
        base: project.mainBranch || "main",
        current: row.name || "",
        tag,
      });
      const named = treeNames.forTree({ project: projectName, path: dir, branch: row.branch });
      return sendJson(res, 200, {
        ok: true,
        project: projectName,
        path: dir.replace(/\\/g, "/"),
        current: row.name || null,
        branch: row.branch || null,
        tag,
        named: named || null,
        namedLine: describeNaming(named),
        name: picked.name,
        dirName: picked.name && tag ? worktreeDirName(picked.name, tag) : picked.name,
        why: picked.why,
        source: picked.source,
        frame: picked.frame,
        words: picked.words,
        note: picked.note,
        evidence: picked.evidence,
      });
    }

    // Clone a GitHub repo over SSH into ONE of the configured scan roots — what the folder
    // accordion's "+" uses: the root is the folder you clicked, the name is the repo
    // (`name` or `owner/name`). The destination is inside that root and must not exist yet.
    // Responds as soon as git finishes; discovery picks the new repo up on the next pass (the
    // refresh below is deliberately not awaited — probing 94 repos would stall the response).
    if (route === "/api/clone" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
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
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      // Fire and forget: a sweep across every project is minutes of git work, and the button must not
      // hold the request open for it. Rows update over SSE as each fetch lands.
      void scheduler
        .fetchPass({ force: true })
        .then(() => scheduler.fullPass())
        .catch(() => {});
      return sendJson(res, 200, { ok: true, started: true });
    }

    if (route === "/api/reload" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      config = await loadConfig();
      scheduler.stop();
      pool.close();
      pool = new Pool(config.threads);
      scheduler = new Scheduler({ config, store, pool, registry, getProjects: () => registry.projects, panelAgents: () => jobs.agentPaths(), panelThreads: () => jobs.panelRunThreads(), onWorktreeSeen: (project, tree) => seedTreeName(project, tree) });
      await registry.refresh();
      await scheduler.start();
      broadcast({ type: "snapshot", data: snapshot() });
      return sendJson(res, 200, { ok: true, projects: config.projects.map((p) => p.name) });
    }

    // ---- restarting the gateway or this panel --------------------------------------------
    // An operator action, answerable from an assistant turn: the request returns at once and the action
    // runs only once the requesting turn has ended, because restarting the gateway synchronously kills
    // the very turn that asked for it. The preflight is synchronous, so a missing provider key is
    // refused here rather than discovered after the new process is up and every run is dying.
    if (route === "/api/restart" && req.method === "GET") {
      return sendJson(res, 200, restart.state());
    }

    if (route === "/api/restart" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      try {
        const record = restart.request({ target: body.target, reason: body.reason, waitFor: body.waitFor || body.thread });
        log(`restart queued: ${record.target} (${record.id}) — it runs once ${record.thread} has no turn running`);
        return sendJson(res, 202, { ok: true, restart: record, provider: record.provider, assistant: assistant.state() });
      } catch (e) {
        return sendJson(res, Number(e.status) || 400, { ok: false, error: String((e && e.message) || e), restart: restart.state() });
      }
    }

    if (route === "/api/stream") return handleStream(req, res, { clients, snapshot });

    return serveStatic(req, res, route, build);
  } catch (e) {
    // The answer may already be on the wire (a static file half-written, an SSE client that died
    // mid-write). sendJson there throws ERR_HTTP_HEADERS_SENT *inside* the catch, which rejects the
    // async handler - an unhandled rejection from a routine client disconnect, and a possible exit.
    if (res.headersSent) {
      log(`${req.method} ${route} failed after the headers were sent: ${String((e && e.message) || e)}`);
      return res.destroy();
    }
    // A caller's mistake is one the handler named (HttpError). Everything else is a bug in this
    // process: 500 and a log line, instead of the 400 that used to make it invisible.
    const status = errorStatus(e);
    const detail = String((e && e.message) || e);
    if (status >= 500) log(`${req.method} ${route} failed (${status}): ${detail}${e?.stack ? `\n${e.stack}` : ""}`);
    return sendJson(res, status, { error: status >= 500 ? `the panel could not answer that: ${detail}` : detail });
  }
});

// ---- legacy trees get a parent, slowly ---------------------------------------------------------------------------
// A tree the panel did not cut has no record, so its parent is reconstructed (lib/parents.js): from the branch's own
// reflog when git still has the creation line, and from the ticket id in its name when it does not. That is git work
// per unresolved branch, it changes only when somebody branches or merges, and a reconstruction can never drive a
// write — so it runs on its own slow clock over the trees the board is actually showing, never on a scan tick, and
// never in the boot path (the board must come up before this).
let parentsWarmAt = 0;
async function warmParents() {
  if (Date.now() - parentsWarmAt < config.stewardRefreshSeconds * 1000) return;
  // A pass with nothing to look at must not spend the whole window: the first one fires 20 s in, and on a slow boot
  // discovery has not finished by then, so a pass that returned here after setting the clock left every legacy tree
  // reading "unknown" for the next five minutes. The configured projects are known at boot, so they are the fallback.
  const projects = (registry.projects?.length ? registry.projects : config.projects) || [];
  if (!projects.length) return;
  parentsWarmAt = Date.now();
  let learned = 0;
  let guessed = 0;
  for (const project of projects) {
    // The whole REPO, never the rows the board happens to be showing: this pass exists to fill in every legacy tree,
    // and a board that has only scanned the project's own checkout so far used to hand it [`master`] — one branch,
    // resolved, window spent, and every other tree still reading "unknown" five minutes later. `refresh()` starts from
    // the repo's own branch list anyway; what it skips cheaply is the branches it already has an answer for.
    try {
      const out = await parents.refresh({ project: project.name, repoDir: project.path, mainBranch: project.mainBranch });
      learned += out.learned || 0;
      guessed += parents.state(project.name).filter((r) => r.parentSource === "backfilled").length;
    } catch (e) {
      log(`parent backfill for ${project.name} failed: ${String((e && e.message) || e)}`);
    }
  }
  if (learned) log(`parents: ${learned} branch(es) resolved (${guessed} backfilled guess(es) in total — a guess never drives a write)`);
}
// ---- the CHECKING agent's answer, acted on -------------------------------------------------------------------
// A check run is read-only, so its answer is the whole product: on LANDED: YES the panel does the one thing that
// answer is for and moves the tree to the Recycle Bin, through the ✕'s own act (lib/worktree-remove.js) so the
// reader's lock, a live agent and the project's own checkout still refuse it. Every other word - PARTIAL, NO,
// SUPERSEDED, or no readable line at all - leaves the tree exactly where it is and the card says which word it read.
//
// A pass over the JOB STORE rather than a callback on the run that answered: a panel restarted between the answer and
// the delete still acts on it, and the store is what survives a restart. `checkedAnswers` keeps one answer to one
// delete per process, and lib/verify-landed.js bounds how old an answer may be before it is history rather than an
// instruction.
const checkedAnswers = new Set();
// Answers whose tree the board has not re-adopted yet. Not `acted`: the answer is still good, and the next tick may
// find the row. Only the one log line is deduped.
const pendingChecked = new Set();
let sweepingChecked = false;
async function sweepCheckedLandings() {
  if (sweepingChecked) return;
  sweepingChecked = true;
  try {
    // The summary `jobs.list()` hands back has no `finalMessage` (the card store drops it), so each candidate is
    // enriched from the LIVE job first: the answer is the last line of a message the completion payload may have
    // truncated from the start.
    const rows = jobs.list().map((s) => ({ ...s, finalMessage: jobs.get(s.id)?.finalMessage || s.completion?.final?.text || "" }));
    for (const { job, answer } of answeredChecks(rows, { acted: checkedAnswers })) {
      checkedAnswers.add(job.id);
      const live = jobs.get(job.id);
      const tree = job.ownerPath || job.cwd || "";
      const project = (tree && spawnFeature.projectForPath(tree)) || null;
      const row = project ? store.rowsFor(project.name).find((r) => normPathKey(r.path) === normPathKey(tree)) : null;
      const base = String(project?.mainBranch || "main");
      const say = (text) => {
        if (live) jobs.push(live, { kind: "raw", text });
      };
      if (!answerDeletes(answer)) {
        say(answerLine(answer, { base }));
        log(`check ${job.id}: answered LANDED: ${answer.verdict} for ${row?.branch || tree || "(no tree)"} - nothing was deleted`);
        continue;
      }
      if (!project) {
        say(answerLine(answer, { base, error: "it is no longer a worktree row of this project, so there was nothing to remove" }));
        continue;
      }
      if (!row) {
        // The project is known but its row is not in the store YET - the answer arrived before a discovery pass put
        // the tree back on the board (a restart between the answer and the delete is exactly that). Do not spend the
        // answer: leave it for the next tick, inside lib/verify-landed.js's age window, and say so once.
        if (!pendingChecked.has(job.id)) {
          pendingChecked.add(job.id);
          log(`check ${job.id}: LANDED: YES, but ${tree} is not on the board yet - waiting for the scan`);
        }
        continue;
      }
      const out = await deleteWorktreeRow({ project, row, target: row.path, jobs, locks, onLog: log });
      if (!out.ok) {
        say(answerLine(answer, { base, error: out.error }));
        log(`check ${job.id}: LANDED: YES for ${row.branch}, but ${row.path} was not deleted - ${out.error}`);
        continue;
      }
      store.dropRow(project.name, row.path);
      broadcast({ type: "drop", project: project.name, path: row.path });
      broadcast({ type: "snapshot", data: snapshot() });
      say(answerLine(answer, { base, deleted: true }));
      log(`check ${job.id}: LANDED: YES for ${row.branch} - removed ${row.path} (recycled: ${out.recycled ? "yes" : "no"})`);
    }
  } catch (e) {
    log(`checked-landing sweep failed: ${String((e && e.message) || e)}`);
  } finally {
    sweepingChecked = false;
  }
}
setInterval(() => void sweepCheckedLandings(), 10_000).unref?.();
// One pass shortly after boot, so an answer a restart interrupted is acted on without waiting for the first tick.
setTimeout(() => void sweepCheckedLandings(), 6_000).unref?.();

setInterval(() => void warmParents(), Math.max(30_000, config.stewardRefreshSeconds * 500));
// First pass 20s in: late enough that the board is up (the boot pass is local git only), early enough that a legacy
// tree stops reading "unknown" within one screen of the panel opening.
setTimeout(() => void warmParents(), 20_000).unref?.();

server.listen(config.port, config.host, () => {
  log(`agent-worktree-gui on http://${config.host}:${config.port}`);
  log(`static build ${buildAtBoot.version || "(unversioned)"} — ${Object.keys(buildAtBoot.files).length} file(s) hashed; the shell is no-store, its assets carry ?v= and are cached hard`);
  // Binding off loopback is a deliberate act, so say out loud what it opens and whether the token that
  // guards it is there at all. Reads are still open to anyone who can reach the port.
  if (!["127.0.0.1", "localhost", "::1"].includes(String(config.host).toLowerCase())) {
    log(config.token
      ? "reachable off this machine: writes from other hosts need x-panel-token (the PANEL_TOKEN value; open the panel with ?token=… once); reads stay open"
      : "WARNING reachable off this machine with NO PANEL_TOKEN in the environment — writes from other hosts are refused until one is set");
  }
  log(`projects: ${config.projects.map((p) => p.name).join(", ") || "(none)"} | threads: ${config.threads} | fast ${config.worktreeSeconds}s / full ${config.slowSeconds}s`);
  log(`agent transport: ${jobs.api.url} (key ${jobs.api.key ? "loaded" : "MISSING"}) | default cwd ${config.defaultCwd}`);
  void jobs.probe({ fresh: true }).then(async (t) => {
    if (!t.reachable) {
      log(`agent transport UNREACHABLE: ${t.error} — spawns will be refused until the gateway is back`);
      return; // nothing to ask: every restored turn keeps its interrupted verdict, which is the safe one
    }
    log(`agent transport ready: hermes ${t.capabilities?.version || "?"} · runs ${t.capabilities?.runs ? "yes" : "no"} · steer ${t.capabilities?.steer ? "yes" : "no"} · per-run cwd ${t.capabilities?.runCwd ? "advertised (a run's tools still start in the gateway's directory — measured 2026-10-27)" : "NO (stock gateway — agents run in the gateway's directory)"}`);
    // What the gateway did with the turns this panel lost in a restart. `load()` stamps them `interrupted`
    // without asking, and a run that finished in the meantime must not keep reading "may still be live".
    try {
      const settled = await jobs.reconcileRestored();
      if (settled.length) log(`reconciled ${settled.length} turn(s) a restart cut off: ${settled.join(", ")}`);
    } catch (e) {
      log(`reconcile of restored turns failed: ${String((e && e.message) || e)}`);
    }
    // ...and the runs the reconcile could not give back to a live card because the gateway answering now is
    // not the process that was issued them. A run lives in one process's memory: a card stamped with an older
    // gateway identity is a turn nobody here can watch, and one nobody has told the gateway to stop — nine of
    // those once held every concurrency slot with their session_turn_leases never released. A stop is asked for
    // on each (404/409 tolerated), after the reconcile, so nothing it re-attached is touched.
    try {
      const stopped = await jobs.stopStaleRuns();
      if (stopped.length) log(`asked the gateway to stop ${stopped.length} run(s) this panel inherited from an earlier gateway: ${stopped.map((a) => `${a.runId || a.jobId}${a.already ? " (already gone)" : a.ok ? "" : ` (failed: ${a.error})`}`).join(", ")}`);
    } catch (e) {
      log(`stopping the runs inherited from an earlier gateway failed: ${String((e && e.message) || e)}`);
    }
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

// The exit path, shared by a signal and a panel restart: the replacement has to be able to bind the
// port, so nothing waits on the SSE clients beyond the same two seconds this always allowed.
function shutdown(code = 0) {
  log(`shutting down (exit ${code})`);
  try {
    scheduler.stop();
  } catch {
    /* an already-stopped scheduler is not a failure */
  }
  clearInterval(heartbeat);
  try {
    pool.close();
  } catch {
    /* ...nor is a closed pool */
  }
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 2000).unref?.();
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => shutdown(0));
}
