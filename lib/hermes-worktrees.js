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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveBinary } from "./jobs.js";

const pexec = promisify(execFile);
const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // lowercase path -> { at, value, pending }
let available = null; // { at, ok }

export function hermesBinary(config = {}) {
  return resolveBinary(config);
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

// Audit one repo. Concurrent callers for the same repo share the in-flight run — a
// 6s subprocess times the number of rows asking for it is how the liveness probe
// storm happened, and this has the same shape.
export async function auditRepo(repoPath, { config = {}, timeoutMs = 45000, ttlMs = DEFAULT_TTL_MS, force = false } = {}) {
  const key = norm(repoPath).toLowerCase();
  const now = Date.now();
  const hit = cache.get(key);
  if (!force && hit) {
    if (now - hit.at < ttlMs) return hit.value;
    if (hit.pending) return hit.pending;
  }

  const bin = hermesBinary(config);
  const pending = (async () => {
    const { stdout } = await pexec(bin, ["worktree", "list", "--json", "--repo", norm(repoPath)], {
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
      at: new Date().toISOString(),
    };
  })();

  cache.set(key, { at: now, value: hit?.value ?? null, pending });
  try {
    const value = await pending;
    cache.set(key, { at: Date.now(), value, pending: null });
    return value;
  } catch (e) {
    // Keep whatever we had rather than making an on-demand audit fail harder than it must.
    cache.set(key, { at: now, value: hit?.value ?? null, pending: null });
    throw e;
  }
}

export function clearAuditCache() {
  cache.clear();
  available = null;
}
