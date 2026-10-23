// Project discovery: every git repo under the configured `scanRoots` becomes a monitored
// project, so the panel is not heroes-js-only. Explicit entries in config.json win over
// what discovery finds (heroes-js carries a prRepo, for instance), and non-git directories
// are reported in `skipped` rather than silently vanishing.
//
// Each project also carries `activityAt` — the newest of its last commit, its git index and
// its .git directory — which is what the UI orders the project list by ("most recently
// worked on first"). The client further folds in per-worktree file activity.
import { readdir, stat } from "node:fs/promises";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { gitIn } from "./scan.js";
import { auditRepo, hermesAvailable } from "./hermes-worktrees.js";

const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
const toMs = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const t = Date.parse(v || "");
  return Number.isFinite(t) ? t : 0;
};

async function mtimeMs(p) {
  try {
    return (await stat(p)).mtimeMs;
  } catch {
    return 0;
  }
}

function githubRepo(url) {
  if (!url) return null;
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(url).trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

async function probe(dir, name) {
  const p = norm(dir);
  const [branchOut, remoteOut, headOut, verify] = await Promise.all([
    gitIn(p, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
    gitIn(p, ["remote"]),
    gitIn(p, ["symbolic-ref", "--short", "HEAD"]),
    gitIn(p, ["rev-parse", "--verify", "--quiet", "HEAD"]),
  ]);
  const branches = branchOut.ok ? branchOut.out.split("\n").filter(Boolean) : [];
  const remotes = remoteOut.ok ? remoteOut.out.split("\n").filter(Boolean) : [];
  const out = {
    name,
    path: p,
    head: headOut.ok ? headOut.out : branches[0] || null,
    empty: !verify.ok, // repo exists but has no commits yet
    remote: null,
    mainBranch: null,
    prRepo: null,
    activityAt: null,
  };

  // Prefer a remote literally named github (this box's convention), then origin, then any.
  out.remote = ["github", "origin"].find((r) => remotes.includes(r)) || remotes[0] || null;

  // Main branch: a real local main/master, else the remote's default, else the current branch.
  let mb = ["main", "master"].find((b) => branches.includes(b));
  if (!mb && out.remote) {
    const sym = await gitIn(p, ["symbolic-ref", "--short", `refs/remotes/${out.remote}/HEAD`]);
    if (sym.ok && sym.out.startsWith(`${out.remote}/`)) mb = sym.out.slice(out.remote.length + 1);
  }
  out.mainBranch = mb || out.head || null;

  if (out.remote) {
    const url = await gitIn(p, ["remote", "get-url", out.remote]);
    out.prRepo = url.ok ? githubRepo(url.out) : null;
  }

  const [lastCommit, idx, gitdir] = await Promise.all([
    gitIn(p, ["log", "-1", "--format=%cI"]),
    mtimeMs(path.join(dir, ".git", "index")),
    mtimeMs(path.join(dir, ".git")),
  ]);
  out.lastCommit = lastCommit.ok ? lastCommit.out : null;
  // Recency is the last commit date. Deliberately NOT the index/.git mtime: `git fetch` and
  // `git status` (the panel's own reads) rewrite those, which would make every repo look
  // freshly worked on. For a repo with no commits yet, fall back to the .git mtime.
  const newest = lastCommit.ok ? 0 : Math.max(idx, gitdir);
  out.activityAt = lastCommit.ok ? out.lastCommit : newest ? new Date(newest).toISOString() : null;
  return out;
}

// The same project record, but assembled from `hermes worktree list --json` (trees, external
// trees, per-branch cleanup verdicts) instead of the panel's own branch enumeration. Four cheap
// git calls remain for the fields the audit does not carry: remote names + URL, the current
// HEAD, whether HEAD exists at all, and the last commit date the UI orders by.
//
// Cost, measured: 5.5-7.2s per repo versus ~0.8s for the probes above. Discovery sweeps every
// repo under `scanRoots` on the slow cadence, so this engine is opt-in
// (`discovery.worktreeSource: "hermes"`), not the default — see lib/hermes-worktrees.js.
async function probeViaHermes(dir, name, config) {
  const p = norm(dir);
  const audit = await auditRepo(p, { config });
  const [remoteOut, headOut, verify, lastCommit, idx, gitdir] = await Promise.all([
    gitIn(p, ["remote", "-v"]),
    gitIn(p, ["symbolic-ref", "--short", "HEAD"]),
    gitIn(p, ["rev-parse", "--verify", "--quiet", "HEAD"]),
    gitIn(p, ["log", "-1", "--format=%cI"]),
    mtimeMs(path.join(dir, ".git", "index")),
    mtimeMs(path.join(dir, ".git")),
  ]);

  // `remote -v` gives every name and its URL in one call, which is why it beats asking
  // `remote` then `remote get-url` per remote.
  const urls = new Map();
  if (remoteOut.ok) {
    for (const line of remoteOut.out.split("\n")) {
      const m = /^(\S+)\s+(\S+)\s+\((?:fetch|push)\)$/.exec(line.trim());
      if (m && !urls.has(m[1])) urls.set(m[1], m[2]);
    }
  }
  const remotes = [...urls.keys()];
  const branches = audit.branches.map((b) => b.name).filter(Boolean);

  const out = {
    name,
    path: p,
    head: headOut.ok ? headOut.out : branches[0] || null,
    empty: !verify.ok, // repo exists but has no commits yet
    remote: ["github", "origin"].find((r) => remotes.includes(r)) || remotes[0] || null,
    mainBranch: null,
    prRepo: null,
    activityAt: null,
  };

  let mb = ["main", "master"].find((b) => branches.includes(b));
  if (!mb && out.remote) {
    const sym = await gitIn(p, ["symbolic-ref", "--short", `refs/remotes/${out.remote}/HEAD`]);
    if (sym.ok && sym.out.startsWith(`${out.remote}/`)) mb = sym.out.slice(out.remote.length + 1);
  }
  out.mainBranch = mb || out.head || null;
  if (out.remote) out.prRepo = githubRepo(urls.get(out.remote) || "");

  out.lastCommit = lastCommit.ok ? lastCommit.out : null;
  const newest = lastCommit.ok ? 0 : Math.max(idx, gitdir);
  out.activityAt = lastCommit.ok ? out.lastCommit : newest ? new Date(newest).toISOString() : null;

  // Counts only. The per-branch reasons live behind /api/cleanup so /api/state does not carry
  // a verdict list per branch for 94 projects.
  out.cleanup = {
    trees: audit.trees.length,
    externalTrees: audit.externalTrees.length,
    reapableTrees: audit.trees.filter((t) => String(t.verdict || "").startsWith("reap")).length,
    deletableBranches: audit.branches.filter((b) => b.verdict === "delete").length,
    auditedAt: audit.at,
  };
  return out;
}

export class ProjectRegistry {
  constructor({ getConfig, store, onLog = () => {}, cacheFile = null }) {
    this.getConfig = getConfig;
    this.store = store;
    this.log = onLog;
    // The last successful discovery is cached: a restart then starts from the board it had, instead
    // of from nothing while the first sweep runs (which showed up as "no git repos found" for the
    // first ~30 seconds after every restart).
    this.cacheFile = cacheFile;
    this.list = this.loadCache();
    if (this.list.length) this.log(`discovery cache: ${this.list.length} project(s) from ${cacheFile}`);
    this.skipped = [];
    this.at = 0;
    this.refreshing = null;
  }

  loadCache() {
    if (!this.cacheFile) return [];
    try {
      const saved = JSON.parse(readFileSync(this.cacheFile, "utf8"));
      const list = Array.isArray(saved.projects) ? saved.projects : [];
      return list.filter((p) => p && p.name && p.path);
    } catch {
      return [];
    }
  }

  saveCache() {
    if (!this.cacheFile || !this.list.length) return;
    try {
      mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      writeFileSync(this.cacheFile, JSON.stringify({ savedAt: new Date().toISOString(), projects: this.list }, null, 0));
    } catch {
      /* a cache we cannot write is not a failure: the next discovery repopulates it */
    }
  }

  get projects() {
    const cfg = this.getConfig();
    return this.list.length ? this.list : cfg.projects || [];
  }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this
      .discover()
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  // Which source answers "what repos, trees and branches exist here".
  //   git    (default) - 6-7 cheap git calls per repo, ~0.8s
  //   hermes           - `hermes worktree list --json`, 5.5-7.2s per repo, and the only
  //                      source that carries per-tree locked/missing and per-branch
  //                      keep/reap verdicts. Opt-in because discovery sweeps every repo.
  async engine() {
    const want = String(this.getConfig()?.discovery?.worktreeSource || "git").toLowerCase();
    if (want !== "hermes") return "git";
    if (await hermesAvailable(this.getConfig())) return "hermes";
    this.log("discovery: worktreeSource is 'hermes' but the hermes CLI is not runnable — using git");
    return "git";
  }

  async discover() {
    const cfg = this.getConfig();
    const engine = await this.engine();
    if (engine === "hermes") this.log("discovery engine: hermes worktree audit (expect ~6s per repo)");
    const startedAt = Date.now();
    const roots = (cfg.scanRoots || []).map(norm);
    const explicit = new Map((cfg.projects || []).map((p) => [p.name, p]));
    const found = new Map();
    const skipped = [];
    // What discovery actually answers is "which repositories exist under the roots". Every repo's STATE - branches,
    // worktrees, verdicts - is read by the scan pool, worktree by worktree, on the panel's own cadence. Probing all
    // of them again here cost ~10 git calls per repo, ~96 repos deep, once per discovery pass: a burst of a minute
    // or more of process spawning that made the whole board lag. Known repos are reused as they are; only a repo
    // that is new to this machine is probed.
    const known = new Map();
    for (const prev of this.list || []) {
      const key = norm(prev.path || (prev.root ? path.join(prev.root, prev.name) : ""));
      if (key) known.set(key, prev);
    }
    let probed = 0;

    // The one field discovery must keep fresh for known repos is `activityAt` (the board sorts projects by it).
    // The store already has every row's last commit and last sign of life, so this costs no git at all.
    const activityFromRows = (name) => {
      let newest = 0;
      for (const row of this.store.rowsFor(name) || []) {
        for (const stamp of [row.lastCommit, row.lastAliveAt]) {
          const ms = Date.parse(stamp || "");
          if (Number.isFinite(ms) && ms > newest) newest = ms;
        }
      }
      return newest || 0;
    };

    for (const root of roots) {
      let entries = [];
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch (e) {
        skipped.push({ dir: root, why: `cannot read: ${String((e && e.message) || e)}` });
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        const full = path.join(root, e.name);
        let gitEntry;
        try {
          gitEntry = await stat(path.join(full, ".git"));
        } catch {
          skipped.push({ dir: norm(full), why: "not a git repo" });
          continue;
        }
        // A `.git` FILE is a linked worktree (or a submodule), not a repo of its own: its rows
        // belong to the project that owns it. Only a `.git` DIRECTORY is a project.
        if (!gitEntry.isDirectory()) {
          skipped.push({ dir: norm(full), why: "linked worktree — rows come from its own project" });
          continue;
        }
        const prev = known.get(norm(full));
        if (prev) {
          const activity = activityFromRows(e.name);
          found.set(e.name, activity && activity > (Date.parse(prev.activityAt || "") || 0) ? { ...prev, activityAt: new Date(activity).toISOString() } : prev);
          continue;
        }
        probed += 1;
        try {
          found.set(e.name, engine === "hermes" ? await probeViaHermes(full, e.name, cfg) : await probe(full, e.name));
          continue;
        } catch (err) {
          // One repo's audit failing must not lose the repo: read that one with git and say so.
          if (engine !== "hermes") {
            skipped.push({ dir: norm(full), why: `probe failed: ${String((err && err.message) || err)}` });
            continue;
          }
          try {
            found.set(e.name, await probe(full, e.name));
            skipped.push({ dir: norm(full), why: `hermes audit failed (${String((err && err.message) || err).slice(0, 110)}) — read with git instead` });
          } catch (err2) {
            skipped.push({ dir: norm(full), why: `probe failed: ${String((err2 && err2.message) || err2)}` });
          }
        }
      }
    }

    const merged = [];
    for (const [name, p] of found) merged.push({ ...p, ...(explicit.get(name) || {}) });
    // Explicit projects outside the roots still belong here — but only if they exist on THIS
    // machine, so a config committed on one box cannot conjure a phantom project on another.
    for (const [name, p] of explicit) {
      if (found.has(name)) continue;
      try {
        await stat(path.join(p.path, ".git"));
        merged.push({ ...p });
      } catch {
        skipped.push({ dir: norm(p.path), why: `configured project '${name}' is not on this machine` });
      }
    }
    merged.sort((a, b) => toMs(b.activityAt) - toMs(a.activityAt) || a.name.localeCompare(b.name));

    // A sweep that found nothing is not evidence that the repos are gone: `readdir` can fail for a
    // moment (drive busy, antivirus, a network root), and treating that as "no projects" wiped the
    // whole board until the next pass. Keep the previous list unless this pass actually saw something.
    if (!merged.length && this.list.length) {
      this.log(`discovery found nothing (${skipped.length} skipped) — keeping ${this.list.length} known project(s)`);
      this.skipped = skipped;
      return this.list;
    }
    this.list = merged;
    this.skipped = skipped;
    this.at = Date.now();
    for (const p of merged) this.store.ensureProject(p);
    this.saveCache();
    // A project that vanished from the roots stops being monitored (rows and all).
    const names = new Set(merged.map((p) => p.name));
    for (const name of [...this.store.projects.keys()]) {
      if (!names.has(name)) this.store.dropProject(name);
    }
    this.log(
      `projects: ${merged.length} (probed ${probed} new, reused ${merged.length - probed}) | skipped ${skipped.length} non-repo dir(s) | discovery ${Date.now() - startedAt}ms`,
    );
    return merged;
  }
}
