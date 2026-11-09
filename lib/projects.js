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
import { TierBook, statSignal, tierOf, nextCheckAt } from "./tiers.js";
import { auditRepo, hermesAvailable } from "./hermes-worktrees.js";
import { rulesFrom } from "./project-rules.js";

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

// The one parser in this codebase that reads the forms a real remote uses:
//   git@github.com:owner/repo.git · ssh://git@github.com/owner/repo.git · https://github.com/owner/repo(.git)
// Exported because a branch's page on the remote is built from its answer (lib/project.js `branchPageUrl`), and a
// second URL parser is exactly the thing that drifts.
export function githubRepo(url) {
  if (!url) return null;
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(url).trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

async function probe(dir, name, git = gitIn) {
  const p = norm(dir);
  const [branchOut, remoteOut, headOut, verify] = await Promise.all([
    git(p, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
    git(p, ["remote"]),
    git(p, ["symbolic-ref", "--short", "HEAD"]),
    git(p, ["rev-parse", "--verify", "--quiet", "HEAD"]),
  ]);
  const branches = branchOut.ok ? branchOut.out.split("\n").filter(Boolean) : [];
  const remotes = remoteOut.ok ? remoteOut.out.split("\n").filter(Boolean) : [];
  const out = {
    name,
    path: p,
    head: headOut.ok ? headOut.out : branches[0] || null,
    empty: !verify.ok, // repo exists but has no commits yet
    remote: null,
    remoteUrl: null,
    mainBranch: null,
    prRepo: null,
    activityAt: null,
  };

  // Prefer a remote literally named github (this box's convention), then origin, then any.
  out.remote = ["github", "origin"].find((r) => remotes.includes(r)) || remotes[0] || null;

  // Main branch: a real local main/master, else the remote's default, else the current branch.
  let mb = ["main", "master"].find((b) => branches.includes(b));
  if (!mb && out.remote) {
    const sym = await git(p, ["symbolic-ref", "--short", `refs/remotes/${out.remote}/HEAD`]);
    if (sym.ok && sym.out.startsWith(`${out.remote}/`)) mb = sym.out.slice(out.remote.length + 1);
  }
  out.mainBranch = mb || out.head || null;

  if (out.remote) {
    const url = await git(p, ["remote", "get-url", out.remote]);
    out.prRepo = url.ok ? githubRepo(url.out) : null;
    // The URL itself, not only a GitHub repo: the push controls group projects by REMOTE REPOSITORY
    // (git.sefl.com/IT, git.sefl.com/SA, github/JLRoper, anything else), and a host name plus the first path
    // segment is what tells them apart. `prRepo` is null for every non-GitHub remote, so it cannot answer this.
    out.remoteUrl = url.ok ? String(url.out).trim() : null;
  }

  const lastCommit = await git(p, ["log", "-1", "--format=%cI"]);
  out.lastCommit = lastCommit.ok ? lastCommit.out : null;
  // Recency is the last COMMIT, and only the last commit. The index and .git mtimes are deliberately not
  // used: `git fetch`, `git status` and every other read the panel itself performs rewrite them, so a
  // repo the panel merely looked at would report as freshly worked on. When the commit cannot be read
  // the date is UNKNOWN (null) and lib/tiers.js treats that as old, which is the safe direction: an
  // unknown repo is gated and one probe decides, instead of the whole fleet being read in full.
  out.activityAt = lastCommit.ok ? out.lastCommit : null;
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
async function probeViaHermes(dir, name, config, git = gitIn) {
  const p = norm(dir);
  const audit = await auditRepo(p, { config });
  const [remoteOut, headOut, verify, lastCommit] = await Promise.all([
    git(p, ["remote", "-v"]),
    git(p, ["symbolic-ref", "--short", "HEAD"]),
    git(p, ["rev-parse", "--verify", "--quiet", "HEAD"]),
    git(p, ["log", "-1", "--format=%cI"]),
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
    remoteUrl: null,
    mainBranch: null,
    prRepo: null,
    activityAt: null,
  };

  let mb = ["main", "master"].find((b) => branches.includes(b));
  if (!mb && out.remote) {
    const sym = await git(p, ["symbolic-ref", "--short", `refs/remotes/${out.remote}/HEAD`]);
    if (sym.ok && sym.out.startsWith(`${out.remote}/`)) mb = sym.out.slice(out.remote.length + 1);
  }
  out.mainBranch = mb || out.head || null;
  if (out.remote) {
    out.prRepo = githubRepo(urls.get(out.remote) || "");
    out.remoteUrl = String(urls.get(out.remote) || "").trim() || null;
  }

  out.lastCommit = lastCommit.ok ? lastCommit.out : null;
  // Commit date only, never an mtime: see the note on the first occurrence of this line.
  out.activityAt = lastCommit.ok ? out.lastCommit : null;

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
  constructor({ getConfig, store, onLog = () => {}, cacheFile = null, tierFile = null, git = gitIn }) {
    this.getConfig = getConfig;
    this.store = store;
    this.log = onLog;
    // The last successful discovery is cached: a restart then starts from the board it had, instead
    // of from nothing while the first sweep runs (which showed up as "no git repos found" for the
    // first ~30 seconds after every restart).
    this.cacheFile = cacheFile;
    // The seam the tier tests count: a pass that reuses every record must start NO git process, and
    // "probed 0" is a log line while this is a number. Production passes `gitIn` and never notices.
    this.git = git;
    this.list = this.loadCache();
    // Which tier each repo is read in, and what its signal looked like. Persisted on its own so a
    // restart resumes the hour: re-seeding a baseline is harmless, but promoting the fleet would be the
    // burst the tier exists to prevent. The knobs are the scheduler's own config keys.
    const cfg = this.getConfig() || {};
    this.tiers = new TierBook({
      file: tierFile,
      buckets: cfg.tierBuckets,
      checkSeconds: cfg.tierCheckSeconds,
      days: cfg.tierDays,
    });
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

  // A re-discovery request. While one is in flight, callers share it — EXCEPT a caller that has just changed what
  // discovery walks (the scan-roots route writes `scanRoots` and must be answered by a pass that began AFTER the
  // write): that one passes `{ after: true }`, waits for the in-flight pass to finish and starts a fresh one, because
  // the pass it would otherwise join read the old list and would answer with the board the reader just changed.
  async refresh({ after = false } = {}) {
    if (this.refreshing) {
      if (!after) return this.refreshing;
      await this.refreshing.catch(() => {});
    }
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
        // The board draws one card per root and files each project under the root it was FOUND under, so the root
        // travels with the record instead of being re-derived from the path: two roots can nest, a root's own path
        // can be a prefix of another's, and a project named directly in config.json lives under no root at all. The
        // page used to guess this with a longest-prefix match; a record that carries its own answer cannot disagree
        // with the folder discovery actually walked.
        //
        // A project's NAME is the board's key (rows are `name::path`, the store keys projects by name), so two roots
        // holding a repo of the same name cannot both be shown: the second is reported in `skipped` rather than
        // silently replacing the first, which would file a root's card under the wrong project.
        const clash = found.get(e.name);
        if (clash && norm(clash.root) !== norm(root)) {
          skipped.push({ dir: norm(full), why: `another project is already called '${e.name}' (under ${norm(clash.root)}) — a project's name is the board's key` });
          continue;
        }
        const prev = known.get(norm(full));
        if (prev) {
          const activity = activityFromRows(e.name);
          const rec = activity && activity > (Date.parse(prev.activityAt || "") || 0) ? { ...prev, activityAt: new Date(activity).toISOString() } : prev;
          found.set(e.name, { ...rec, root: norm(root) });
          continue;
        }
        probed += 1;
        try {
          found.set(e.name, { ...(engine === "hermes" ? await probeViaHermes(full, e.name, cfg, this.git) : await probe(full, e.name, this.git)), root: norm(root) });
          continue;
        } catch (err) {
          // One repo's audit failing must not lose the repo: read that one with git and say so.
          if (engine !== "hermes") {
            skipped.push({ dir: norm(full), why: `probe failed: ${String((err && err.message) || err)}` });
            continue;
          }
          try {
            found.set(e.name, { ...(await probe(full, e.name, this.git)), root: norm(root) });
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
        // A configured project outside every root is never PROBED, so its `remoteUrl` can only come from the file
        // or from a previous pass. Consult the record before asking git: without this, a discovery pass spends one
        // git process per pass, forever, on a project whose answer it already had (and never keeps, because `p` is
        // read from config.json every time). Only a project with no answer anywhere is asked once.
        const previousUrl = known.get(norm(p.path))?.remoteUrl || null;
        let remoteUrl = p.remoteUrl || previousUrl || null;
        if (!remoteUrl && p.remote) {
          const url = await this.git(norm(p.path), ["remote", "get-url", p.remote]);
          remoteUrl = url.ok ? String(url.out).trim() || null : null;
        }
        merged.push({ ...p, remoteUrl });
      } catch {
        skipped.push({ dir: norm(p.path), why: `configured project '${name}' is not on this machine` });
      }
    }
    // A project's own rules, normalised HERE, once, so every reader downstream (the snapshot's project record, the
    // header's chip, the route) sees the same list: a hand-edited `"rules": "ask about the migration"` is not a list
    // of characters, and an absent key is zero rules rather than an unknown.
    for (const p of merged) p.rules = rulesFrom(p.rules);
    merged.sort((a, b) => toMs(b.activityAt) - toMs(a.activityAt) || a.name.localeCompare(b.name));

    // A sweep that found nothing is not evidence that the repos are gone: `readdir` can fail for a
    // moment (drive busy, antivirus, a network root), and treating that as "no projects" wiped the
    // whole board until the next pass. Keep the previous list unless this pass actually saw something.
    if (!merged.length && this.list.length) {
      this.log(`discovery found nothing (${skipped.length} skipped) - keeping ${this.list.length} known project(s)`);
      this.skipped = skipped;
      return this.list;
    }
    // Which tier each repository is read in (lib/tiers.js). The rule is the last COMMIT: a repo that has not
    // committed in `tierDays` (7) drops to the hourly stat gate, and one inside that window keeps today's
    // treatment. Classification costs no git and no stats - the record already carries `activityAt`, and the
    // gate's baseline is taken by its first hourly CHECK rather than by a discovery pass. It runs AFTER the
    // found-nothing guard: a pass that saw nothing must not prune the tier book it is meant to keep.
    const before = new Map((this.list || []).map((p) => [p.name, p.tier || null]));
    const tiers = this.tiers.sync(merged, Date.now());
    for (const p of merged) p.tier = tiers.get(p.name) || tierOf(p, Date.now(), this.tiers.days);

    this.list = merged;
    this.skipped = skipped;
    this.at = Date.now();
    for (const p of merged) this.store.ensureProject(p);
    // A repo that has just DEMOTED keeps its rows, but they are no longer read on the scan cadence: their ring
    // is re-aimed at the repo's hourly stat check and the live chips are cleared, because nothing will refresh
    // them until movement promotes the repo (or the reader opens it). A repo that just promoted is left to the
    // full pass its promotion runs. The parking pass is idempotent, so it also catches the rows boot creates
    // AFTER the first discovery (there are none at this point: the full pass has not run yet).
    for (const p of merged) {
      const was = before.get(p.name);
      if (was === undefined || was === p.tier) continue;
      this.log(`tier: ${p.name} ${p.tier} (${p.activityAt || "no commit date"})`);
    }
    this.parkOldRows();
    this.saveCache();
    // A project that vanished from the roots stops being monitored (rows and all).
    const names = new Set(merged.map((p) => p.name));
    for (const name of [...this.store.projects.keys()]) {
      if (!names.has(name)) this.store.dropProject(name);
    }
    this.log(
      `projects: ${merged.length} (probed ${probed} new, reused ${merged.length - probed}) | skipped ${skipped.length} non-repo dir(s) | ` +
        `recent ${merged.filter((p) => p.tier !== "old").length} / old ${merged.filter((p) => p.tier === "old").length} | discovery ${Date.now() - startedAt}ms`,
    );
    return merged;
  }

  // Re-aim every old-tier repo's rows at the gate instead of the scan cadence: the ring counts to the repo's next
  // hourly stat check, and the live chips are cleared because no scan will refresh them. Idempotent: a row already
  // carrying the parked shape is left alone, so this can run on every discovery pass and once after boot.
  parkRows(project) {
    const span = this.tiers.buckets * this.tiers.checkSeconds;
    const now = Date.now();
    const next = new Date(nextCheckAt(project.path, now, this.tiers.buckets, this.tiers.checkSeconds)).toISOString();
    for (const row of this.store.rowsFor(project.name) || []) {
      // A row already parked with a ring still in the future is left alone: re-stamping it on every discovery
      // pass would repaint the whole old fleet every 15 minutes for no new answer.
      const due = Date.parse(row.nextReadAt || "");
      if (Number(row.pollSeconds) === span && !row.live && !row.idle && Number.isFinite(due) && due > now) continue;
      this.store.touch(project.name, row.path, {
        pollSeconds: span,
        nextReadAt: next,
        live: false,
        idle: false,
        signals: {},
        liveWhy: "old tier: stat-gated until something moves",
      });
    }
  }

  parkOldRows() {
    for (const p of this.list || []) if (p.tier === "old") this.parkRows(p);
  }

  // One repo, re-read by the full discovery probe - the promotion path when a stat gate sees movement or the
  // reader opens an old project. This is the ONLY place a known record is probed again, and it is called once
  // per promotion rather than on a sweep. Returns the fresh record (tier already re-derived), or null when the
  // probe could not answer (the project keeps its old record and the gate retries on its next slice).
  async refreshProject(name) {
    const cfg = this.getConfig();
    const prev = (this.list || []).find((p) => p.name === name);
    if (!prev || !prev.path) return null;
    const engine = await this.engine();
    let fresh = null;
    let why = "";
    try {
      fresh = engine === "hermes" ? await probeViaHermes(prev.path, prev.name, cfg, this.git) : await probe(prev.path, prev.name, this.git);
    } catch (e) {
      why = String((e && e.message) || e);
      if (engine === "hermes") {
        try {
          fresh = await probe(prev.path, prev.name, this.git);
          why = "";
        } catch (e2) {
          why = String((e2 && e2.message) || e2);
        }
      }
    }
    if (!fresh) {
      this.log(`tier: ${name} could not be re-probed (${why || "no answer"}) - it stays on the gate and retries`);
      return null;
    }
    const rec = { ...prev, ...fresh, name: prev.name, path: prev.path, root: prev.root };
    rec.tier = this.tiers.stamp(rec, Date.now());
    this.list = (this.list || []).map((p) => (p.name === name ? rec : p));
    // The gate starts again from what the probe just saw: the movement that promoted the repo is recorded as
    // handled, so a repo whose commit is still older than the window does not promote again on the next slice.
    if (rec.tier === "old") {
      try {
        this.tiers.seed(rec.path, await statSignal(rec.path), "old");
      } catch {
        /* the next slice seeds it instead */
      }
    }
    this.saveCache();
    this.store.ensureProject(rec);
    this.store.patchProject(name, rec);
    this.log(`tier: ${name} re-probed -> ${rec.tier} (last commit ${rec.activityAt || "unknown"})`);
    return rec;
  }
}
