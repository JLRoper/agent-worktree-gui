// Thin client for `hermes worktree list --json` — the audit Hermes already ships:
// linked trees, externally-registered trees, and a keep/reap verdict with a reason
// for every local branch.
//
// Where this is the right source, and where it is not (measured on this box,
// Windows 11, warm cache, 2026-10-20):
//
//   hermes --version                       2.9s
//   hermes worktree list --json   (tiny)   5.5s
//   hermes worktree list --json   (Menu)   6.8s
//   the panel's own 6-7 git probes         0.8s
//
// The cost is Python start-up plus a `git cherry` per branch, and it is per repo.
// Discovery sweeps ~94 repos every 60s, so 6s per repo would turn a 60s pass into
// a 10-minute one. This client is therefore built for ON-DEMAND detail ("what can I
// safely reclaim here?") and, opt-in, for small scan roots — see
// `discovery.worktreeSource` in config.json. What it adds over `git worktree list`
// is exactly the part the panel cannot compute cheaply: `locked`/`missing` per
// external tree and a cleanup verdict per branch.
// The panel's child supervisor: every helper here carries a hard ceiling for its kind and is killed with
// its tree at the deadline, when its scope settles and on shutdown (lib/child-tree.js).
import { childExec } from "./child-tree.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { treeOnDisk } from "./own-tree.js";

const pexec = childExec;
const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
const key = (p) => norm(p).toLowerCase();

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // lowercase path -> { at, value, pending }
let available = null; // { at, ok }

// The `hermes` CLI is still used here, but only for `hermes worktree …` audits: those read git's
// own state, not an agent run. Agent runs go through the gateway's Runs API (lib/jobs.js).
function defaultHome() {
  const local = process.env.LOCALAPPDATA || process.env.HOME || "";
  return path.join(local, "hermes");
}

export function hermesBinary(config = {}) {
  if (config.hermesBin && existsSync(config.hermesBin)) return config.hermesBin;
  const guess = path.join(defaultHome(), "bin", "hermes.exe");
  if (existsSync(guess)) return guess;
  return "hermes";
}

// Is the CLI runnable at all? Cached: this gates a config option, it is not a health check.
export async function hermesAvailable(config = {}, ttlMs = 5 * 60 * 1000) {
  const now = Date.now();
  if (available && now - available.at < ttlMs) return available.ok;
  let ok = false;
  try {
    await pexec(hermesBinary(config), ["--version"], { timeout: 15000, windowsHide: true });
    ok = true;
  } catch {
    ok = false;
  }
  available = { at: now, ok };
  return ok;
}

// Which trees git itself has registered. Read once per repo, beside the CLI's listing, and kept in the cache with it:
// the CLI classifies every DIRECTORY under `.worktrees/`, so a directory an eviction left behind is measured there
// too — with `git status` run inside it, which walks UP to the primary checkout and answers with the READER's files.
// That is the whole of the first defect: 18 empty husks read "uncommitted tracked changes (real work)" — the one
// thing that was completely safe to delete was the one thing the audit protected. A path is a tree only when git's
// own list carries it, and the answer is cached, so this costs one git call per repo per audit, not one per tree.
async function registeredTrees(repoPath, run, timeoutMs) {
  try {
    const { stdout } = await run("git", ["worktree", "list", "--porcelain"], {
      cwd: repoPath,
      timeout: timeoutMs,
      windowsHide: true,
      encoding: "utf8",
    });
    const set = new Set();
    for (const line of String(stdout || "").split("\n")) {
      if (line.startsWith("worktree ")) set.add(key(line.slice("worktree ".length).trim()));
    }
    return [...set];
  } catch {
    // Unknown is not "unregistered": falling back to the folder's own `.git` keeps a real tree real.
    return null;
  }
}

// The live run whose tree this is, or null. `liveCwds` is the caller's job-store answer — the cwd (and tree) of every
// run the panel believes is going — and the match is "equal to the tree, or somewhere under it", because a run's cwd
// can be a subdirectory of the tree the panel cut.
function liveRunIn(treePath, liveCwds) {
  const want = key(treePath);
  if (!want) return null;
  for (const cwd of Array.isArray(liveCwds) ? liveCwds : []) {
    const c = key(cwd);
    if (c && (c === want || c.startsWith(`${want}/`))) return norm(cwd);
  }
  return null;
}

// What one tree entry really is, before either the CLI's verdict or its own dirty counts are believed.
//
// Two questions are asked in the order that can destroy work: LIVE first (a tree a run is working in is never
// deletable and never "clean and fully merged", whatever git says about it — task-46's live tree read exactly that
// and deleting it would have destroyed a working agent's tree), then REAL (registered by git, `.git` on disk). A path
// that is neither is a directory left behind by an eviction: it has no branch and no work of its own, so the CLI's
// branch ("main") and "real work" are the PRIMARY checkout's, and none of them are copied onto the row. The empty
// husk is the deletable case; a non-tree that still holds files is a keep with what is left named, because files
// somebody put there are not the panel's to call deletable.
function shapeTree(tree, registered, liveCwds) {
  const at = norm(tree.path);
  const live = liveRunIn(at, liveCwds);
  if (live) {
    return {
      ...tree,
      live: true,
      gone: false,
      deletable: false,
      verdict: "keep",
      reason: `a live run is working in this tree (${live}) — not deletable`,
      untracked: [],
    };
  }
  const disk = treeOnDisk(at);
  const isRegistered = registered ? registered.includes(key(at)) : disk.there;
  if (!disk.there || !isRegistered) {
    const why = disk.there
      ? "not a registered worktree (no entry in `git worktree list`) — inspect before deleting"
      : disk.why;
    return {
      ...tree,
      live: false,
      gone: true,
      empty: Boolean(disk.empty),
      deletable: Boolean(disk.empty),
      // No branch and no untracked list: whatever the CLI read from inside this path belongs to the checkout above it.
      branch: null,
      untracked: [],
      verdict: disk.empty && !disk.there ? "reap" : "keep",
      reason: why,
    };
  }
  return { ...tree, live: false, gone: false, deletable: String(tree.verdict || "").startsWith("reap") };
}

// Audit one repo. Concurrent callers for the same repo share the in-flight run — a
// 6s subprocess times the number of rows asking for it is how the liveness probe
// storm happened, and this has the same shape.
//
// `liveCwds` is applied on EVERY call, cache hit included: the cached half is git's own answer, and a live run that
// started since the cache was filled must still make its tree undeletable. `run` is the process runner (the CLI and
// the one `git worktree list` call), injectable so a test can hand in the CLI's shape without a 6-second audit.
export async function auditRepo(
  repoPath,
  { config = {}, timeoutMs = 45000, ttlMs = DEFAULT_TTL_MS, force = false, liveCwds = [], run = pexec } = {},
) {
  const cacheKey = key(repoPath);
  const now = Date.now();
  const hit = cache.get(cacheKey);
  let value = null;
  if (!force && hit) {
    if (now - hit.at < ttlMs && hit.value) value = hit.value;
    else if (hit.pending) value = await hit.pending;
  }
  if (!value) {
    const bin = hermesBinary(config);
    const pending = (async () => {
      const { stdout } = await run(bin, ["worktree", "list", "--json", "--repo", norm(repoPath)], {
        cwd: repoPath,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
      const raw = String(stdout || "").trim();
      // The CLI writes only JSON to stdout with --json; anything else means a banner, a
      // traceback on stdout, or an older build. Say so instead of parsing garbage.
      if (!raw.startsWith("{")) throw new Error(`unexpected output from ${bin}: ${raw.slice(0, 140)}`);
      const j = JSON.parse(raw);
      return {
        repo: norm(j.repo || repoPath),
        trees: (Array.isArray(j.trees) ? j.trees : []).map((t) => ({ ...t, path: norm(t.path) })),
        externalTrees: (Array.isArray(j.external_trees) ? j.external_trees : []).map((t) => ({ ...t, path: norm(t.path) })),
        branches: Array.isArray(j.branches) ? j.branches : [],
        registered: await registeredTrees(repoPath, run, timeoutMs),
        at: new Date().toISOString(),
      };
    })();

    cache.set(cacheKey, { at: now, value: hit?.value ?? null, pending });
    try {
      value = await pending;
      cache.set(cacheKey, { at: Date.now(), value, pending: null });
    } catch (e) {
      // Keep whatever we had rather than making an on-demand audit fail harder than it must.
      cache.set(cacheKey, { at: now, value: hit?.value ?? null, pending: null });
      throw e;
    }
  }

  // Git's facts are cached; liveness and what is on disk right now are not. The overlay runs on every read so a
  // husk that was re-cut, or a run that started a second ago, cannot be answered from a ten-minute-old verdict.
  return {
    repo: value.repo,
    trees: value.trees.map((t) => shapeTree(t, value.registered, liveCwds)),
    externalTrees: value.externalTrees,
    branches: value.branches,
    at: value.at,
  };
}

export function clearAuditCache() {
  cache.clear();
  available = null;
}
