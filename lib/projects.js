// Project discovery: every git repo under the configured `scanRoots` becomes a monitored
// project, so the panel is not heroes-js-only. Explicit entries in config.json win over
// what discovery finds (heroes-js carries a prRepo, for instance), and non-git directories
// are reported in `skipped` rather than silently vanishing.
//
// Each project also carries `activityAt` — the newest of its last commit, its git index and
// its .git directory — which is what the UI orders the project list by ("most recently
// worked on first"). The client further folds in per-worktree file activity.
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { gitIn } from "./scan.js";

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

export class ProjectRegistry {
  constructor({ getConfig, store, onLog = () => {} }) {
    this.getConfig = getConfig;
    this.store = store;
    this.log = onLog;
    this.list = [];
    this.skipped = [];
    this.at = 0;
    this.refreshing = null;
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

  async discover() {
    const cfg = this.getConfig();
    const roots = (cfg.scanRoots || []).map(norm);
    const explicit = new Map((cfg.projects || []).map((p) => [p.name, p]));
    const found = new Map();
    const skipped = [];

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
        try {
          await stat(path.join(full, ".git"));
        } catch {
          skipped.push({ dir: norm(full), why: "not a git repo" });
          continue;
        }
        try {
          found.set(e.name, await probe(full, e.name));
        } catch (err) {
          skipped.push({ dir: norm(full), why: `probe failed: ${String((err && err.message) || err)}` });
        }
      }
    }

    const merged = [];
    for (const [name, p] of found) merged.push({ ...p, ...(explicit.get(name) || {}) });
    // Explicit projects outside the roots still belong in the list.
    for (const [name, p] of explicit) if (!found.has(name)) merged.push({ ...p });
    merged.sort((a, b) => toMs(b.activityAt) - toMs(a.activityAt) || a.name.localeCompare(b.name));

    this.list = merged;
    this.skipped = skipped;
    this.at = Date.now();
    for (const p of merged) this.store.ensureProject(p);
    // A project that vanished from the roots stops being monitored (rows and all).
    const names = new Set(merged.map((p) => p.name));
    for (const name of [...this.store.projects.keys()]) {
      if (!names.has(name)) this.store.dropProject(name);
    }
    this.log(`projects: ${merged.map((p) => p.name).join(", ") || "(none)"} | skipped ${skipped.length} non-repo dir(s)`);
    return merged;
  }
}
