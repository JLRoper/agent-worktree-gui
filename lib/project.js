// Main-thread project-level git helpers (few calls per project, unlike the
// per-worktree scans which go through the worker pool).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitIn } from "./scan.js";

const pexec = promisify(execFile);

export async function worktreeList(projectPath) {
  const r = await gitIn(projectPath, ["worktree", "list", "--porcelain"], 25000);
  if (!r.ok) throw new Error(`git worktree list failed in ${projectPath}: ${r.err || r.out}`);
  const out = [];
  let cur = null;
  for (const line of r.out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice("worktree ".length).trim() };
      out.push(cur);
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  return out;
}

export async function projectMeta(project) {
  // A project without a remote is compared against its own main branch, so the panel still
  // says something useful instead of erroring on a missing <remote>/<branch> ref.
  const remoteRef = project.remote ? `${project.remote}/${project.mainBranch}` : project.mainBranch;
  if (!remoteRef) return { error: "no base ref: project has no remote and no main branch" };
  // A repo with no commits yet has nothing to resolve; report it as such, not as an error.
  if (project.empty) return { remoteRef, hasRemote: Boolean(project.remote), noCommits: true };
  const [tip, subj, date, lmain, lr] = await Promise.all([
    gitIn(project.path, ["rev-parse", "--short", remoteRef]),
    gitIn(project.path, ["log", "-1", "--format=%s", remoteRef]),
    gitIn(project.path, ["log", "-1", "--format=%cI", remoteRef]),
    gitIn(project.path, ["rev-parse", "--short", project.mainBranch]),
    gitIn(project.path, ["rev-list", "--left-right", "--count", `${remoteRef}...${project.mainBranch}`]),
  ]);
  const meta = { remoteRef, hasRemote: Boolean(project.remote) };
  if (!tip.ok) return { ...meta, error: `cannot resolve ${remoteRef}: ${tip.err || tip.out}` };
  meta.remoteTip = tip.out;
  meta.remoteTipSubject = subj.ok ? subj.out : null;
  meta.remoteTipDate = date.ok ? date.out : null;
  meta.localMain = lmain.ok ? lmain.out : null;
  if (lr.ok) {
    const [behind, ahead] = lr.out.split(/\s+/).map((n) => Number.parseInt(n, 10));
    meta.mainBehind = Number.isFinite(behind) ? behind : null;
    meta.mainAhead = Number.isFinite(ahead) ? ahead : null;
  }
  return meta;
}

const cache = new Map();
function memo(key, ttlMs, factory) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < ttlMs) return hit.promise;
  const promise = Promise.resolve().then(factory);
  cache.set(key, { at: now, promise });
  promise.catch(() => cache.delete(key));
  return promise;
}

export function remoteHeads(project, ttlSeconds) {
  if (!project.remote) return Promise.resolve(new Set());
  return memo(`heads:${project.path}:${project.remote}`, ttlSeconds * 1000, async () => {
    const r = await gitIn(project.path, ["ls-remote", "--heads", project.remote], 45000);
    const set = new Set();
    if (!r.ok) return set;
    for (const line of r.out.split("\n")) {
      const m = /refs\/heads\/(.+)$/.exec(line);
      if (m) set.add(m[1]);
    }
    return set;
  });
}

export function prIndex(project, ttlSeconds) {
  if (!project.prRepo) return Promise.resolve(new Map());
  return memo(`pr:${project.prRepo}`, ttlSeconds * 1000, async () => {
    const map = new Map();
    try {
      const { stdout } = await pexec(
        "gh",
        ["pr", "list", "--state", "all", "--json", "number,state,mergedAt,headRefName,title", "--limit", "400", "--repo", project.prRepo],
        { cwd: project.path, timeout: 60000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      );
      for (const pr of JSON.parse(stdout || "[]")) {
        const arr = map.get(pr.headRefName) || [];
        arr.push(pr);
        map.set(pr.headRefName, arr);
      }
    } catch {
      /* gh missing or unauthenticated: PR column just reads none */
    }
    return map;
  });
}

export function prFor(map, branch) {
  const list = map instanceof Map ? map.get(branch) : null;
  if (!list || !list.length) return null;
  const pr = list.slice().sort((a, b) => b.number - a.number)[0];
  return { number: pr.number, state: pr.state, mergedAt: pr.mergedAt || null, title: pr.title };
}
