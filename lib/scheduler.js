// Drives the scans.
//
// One ticker, per-worktree due times, and the pool's per-worktree serialisation replace the
// old pair of racing timers (a 5s fast pass and a 60s full pass that happily scanned the
// same worktree at the same time and trampled each other's row).
//
// Cadence is adaptive. A row is polled at `worktreeSeconds` when it has a reason to move —
// a live session, an open-but-idle one, a dirty or untracked tree, unmerged work, or a
// verdict not yet computed — and at `dormantSeconds` when it is simply merged and clean.
// Re-reading 19 dormant trees every 5s was ~100 git processes per pass for no new
// information; this keeps the live ones sharp and lets the rest coast.
//
// Row lifetimes are decided by git, on every full pass. `git worktree list --porcelain` is read per
// project each time (see reconcile) and any row git no longer lists is dropped — the panel is
// not the only thing that removes a worktree, and a row deleted out-of-band used to live in memory for
// the life of the process. Never when that call failed or came back empty: a transient git hiccup must
// not blank the table. A row whose folder is still a checkout (it has a `.git` entry) but which git did
// not list keeps a two-pass rule, because that is the shape a hiccup takes; a row whose folder is gone,
// or is there with no `.git` any more, goes on the first pass — that is what a failed delete leaves
// behind, and waiting out a second pass is what kept its ghost on the board with no branch.
//
// The one exception is a row an agent is standing on. A tree that vanished from disk while a card is
// filed under it is kept as STALE (last seen at, path, reason) for `TREE_CACHE_STALE_KEEP_MS` instead of
// being dropped into the unattached list (lib/tree-cache.js): the panel's rule is that a card belongs to
// the tree it named until a scan has actually completed, never to the unattached bucket because a folder
// moved.
import { stat } from "node:fs/promises";
import path from "node:path";
import { worktreeList, isInsideProject } from "./project.js";
import { resolveBaseRef } from "./base-ref.js";
import { baseBranchesFrom } from "./base-branches.js";
import { hostIdFor } from "./hosts.js";
import { gitIn } from "./scan.js";
import { TierBook, statSignal, TIER_BUCKETS, TIER_CHECK_SECONDS } from "./tiers.js";
import { heldBack, failed as hostFailed, answered as hostAnswered, looksLikeHostTrouble } from "./remote-backoff.js";
import { log } from "./log.js";
import { SchedulerPasses } from "./scheduler-passes.js";

export { yieldToLoop, staggeredReads } from "./scheduler-lifecycle.js";

// How long a project's scan context is reused (see ctxFor).
const CTX_TTL_MS = 30_000;

export class Scheduler extends SchedulerPasses {
  constructor({ config, store, pool, registry = null, getProjects = null, panelAgents = null, panelThreads = null, onWorktreeSeen = null, hosts = null, listWorktrees = null, onRowRead = null, onScanComplete = null }) {
    // The lifecycle layer is a prototype layer, not a state holder: every field the instance reads is
    // still set here, and the base constructor has nothing to do. Required by `extends`, nothing else.
    super();
    this.config = config;
    this.store = store;
    this.pool = pool;
    // Every successful read of one tree, after its row is in the store: the tree cache's own hook (server.js writes
    // `state/tree-cache.json` from it). Optional, and never allowed to fail a scan - a cache that cannot be written is
    // a slower first paint, not a broken board.
    this.onRowRead = onRowRead;
    // The moment a pass that enumerated every project's tree list finished. The page uses it for the one rule the
    // cache exists to keep: a card may fall to the unattached list only after a scan has actually completed.
    this.onScanComplete = onScanComplete;
    // The listing behind discovery. A seam, not an abstraction: `git worktree list --porcelain` is the only source
    // of the row set, and a test has to be able to hand discovery a listing without a repository on disk.
    this.listWorktrees = listWorktrees || worktreeList;
    this.registry = registry;
    this.getProjects = getProjects || (() => config.projects || []);
    // Where each project's branches and PRs live (lib/hosts.js, the panel's hosts.json). Optional: a scheduler built without
    // it still scans, it just has no host mappings to link from — every cell then reads plain text with the reason.
    this.hosts = hosts;
    this.panelAgents = panelAgents;
    // Every worktree this scheduler ENUMERATES, once per listing: the naming ledger's seeding hook (server.js).
    // Called with the project and `{path, branch}` exactly as `git worktree list` answered, before the tree is
    // scanned or a row is written — a name is the panel's fact, not git's, and it has to be written down before
    // anything can ask whether the tree has one.
    this.onWorktreeSeen = onWorktreeSeen || null;
    // Threads the panel ran itself; those are counted by the agent chips and excluded from hermes evidence.
    this.panelThreads = panelThreads;
    this.lastRegistry = 0;
    this.lastLive = 0;
    // Set by markScanComplete: the moment this process last finished enumerating every project's tree list.
    this.lastScanCompleteAt = null;
    this.cfg = {
      worktreeSeconds: 5,
      // Liveness evidence gets its own fast tick: chips must appear and clear within seconds
      // even for a dormant worktree, which the cheaper git cadence cannot promise.
      liveSeconds: 5,
      // Unfinished-but-idle work (dirty / unmerged / not yet classified). Its own tier: reading it
      // at the live cadence is what made a 94-repo fleet permanently overdue.
      midSeconds: 30,
      dormantSeconds: 30,
      slowSeconds: 60,
      // How many projects may be in a full pass at the same time. A fleet of ~100 projects whose due
      // times all fall in the same tick started ~100 deep scans at once, and for the six or seven
      // seconds that took the box had no CPU left for the board's own requests - the periodic drag.
      fullPassConcurrency: 2,
      scanDeferRetryMs: 5000,
      // Re-walking scanRoots and probing every repo (`git worktree list` per project) is minutes of git
      // work for an answer that changes when a repo is created - its own, slower clock.
      registrySeconds: 900,
      fetchSeconds: 600,
      prCacheSeconds: 300,
      remoteCacheSeconds: 300,
      // The two-tier gate (lib/tiers.js). `tierDays` is the window that decides a repo is recent; a repo past
      // it is checked by ONE signal read per `tierBuckets`-minute rotation (`tierCheckSeconds` is
      // the length of one slice, so 60 x 60 s is the hour). Both are config keys so a test can run the gate on
      // a one-second rotation instead of waiting for the wall clock.
      tierDays: 7,
      tierBuckets: TIER_BUCKETS,
      tierCheckSeconds: TIER_CHECK_SECONDS,
      // THE FRESHNESS FLOOR. A project's rows may not be served forever from the last time something happened to
      // look at it: a recent-tier project whose rows were last READ longer ago than this is due for a full pass
      // whether or not a page reports it visible. Visibility chooses the FREQUENT cadence; it is not permission to
      // never read a project again — that gap is what served /api/state a row set scanned at 18:23 while five trees
      // cut in between had no row at all.
      projectStaleSeconds: 900,
      liveMinutes: 5,
      ...config,
    };
    this.timers = [];
    this.stopped = true;
    this.projectRunning = new Set();
    this.liveRunning = false;
    // "project::path" -> ms this row was last claimed for a read. Its due time is always
    // `lastFast + intervalFor(row)`, recomputed on each tick, so a tree that turns live is read on its new
    // 5s cadence at once instead of waiting out the window it had while its verdict was unknown. The
    // stagger lives in the seed (see dueAfter / enqueueDue), not in this number's arithmetic.
    this.lastFast = new Map(); // "project::path" -> ms of that row's last scan
    // "project::path" -> { at, value }: the context every row of a project is scanned with (see ctxFor).
    this.ctxCache = new Map();
    this.deferUntil = new Map();
    // The tier book is the registry's (it persists beside the projects cache and is what discovery stamps the
    // records from); a scheduler built without a registry - a test, a one-off probe - gets its own in memory.
    this.tiers = this.registry?.tiers || new TierBook({ buckets: this.cfg.tierBuckets, checkSeconds: this.cfg.tierCheckSeconds, days: this.cfg.tierDays });
    this.promoting = new Set(); // projects with a promotion in flight, so one pass cannot start two
    // Promotions are serialised: one runs, the rest wait here in arrival order. `promotingQueued` is the waiting
    // set (bounded by PROMOTION_QUEUE_MAX), `promotionChain` is the promise they queue on.
    this.promotingQueued = new Set();
    this.promotionChain = Promise.resolve();
    this.lastTierCheck = 0; // ms of the last slice-check tick (one per tierCheckSeconds)
    this.tierCheckAbort = null;
    this.tierSignal = statSignal;
    this.misses = new Map(); // "project::path" -> consecutive reconciles that did not list it
    this.lastProjectPass = new Map();
    // Which projects the page says it can see, and when it said so. Only used when scanMode is "visible"; a report
    // older than VISIBLE_TTL_MS means no browser is watching, and the fleet is read as before rather than frozen.
    this.visible = new Set();
    this.visibleAt = 0;
    // When each project was last in a visibility report, so a repaint that momentarily drops a project does not
    // count as it "arriving" and re-queue its whole pass.
    this.visibleSeenAt = new Map();
    this.passesSeeded = false;
    this.lastFetch = new Map();
    this.queuedFull = new Set();
    // Open only while the boot pass runs: the phase accumulator the boot's own timing report drains (see
    // `start`). Null in every other pass; a scheduler that is never started keeps it null forever.
    this.bootReport = null;
    this.stats = {
      ticks: 0,
      livenessPasses: 0,
      livenessTouched: 0,
      lastLiveMs: null,
      fastPasses: 0,
      fullPasses: 0,
      rowScans: 0,
      fetches: 0,
      // The tier gate: how many repos it has stat-checked, how many it promoted, and the split the last pass
      // saw. Reported by /api/stats, which is where a reader checks that the old fleet is not being scanned.
      tierChecks: 0,
      tierPromotions: 0,
      tierParked: 0,
      // The SAME number as a live reading: how many of the projects this pass looked at are parked on the hourly
      // gate. `tierParked` above is the gate's own cumulative count of passes it refused, which reads 0 on a
      // visible-mode board because an old project is filtered out before the gate is ever reached. This is the
      // count a reader can trust for "how much is not being scanned right now".
      tierParkedNow: 0,
      tierRecent: 0,
      tierOld: 0,
      lastTierMs: null,
      lastTierAt: null,
      lastTickMs: null,
      lastTickAt: null,
      lastFastMs: null,
      lastFullMs: null,
      lastFastAt: null,
      lastFullAt: null,
      inFlight: 0,
      // The boot pass's own weight, as measured: { totalMs, projects, recentRead, rowsScanned, trees,
      // remoteAnswers, remoteAnswerMs, metaMs, reconcileMs, boardMs, rowsMs, perProject[top 20] }.
      lastBoot: null,
    };
  }

  // ONE ANSWER PER PROJECT PER HALF-MINUTE. `scanOne` asks this for EVERY row it reads, and the answer is a `git
  // remote` spawn (lib/base-ref.js) plus pure mapping of the project's own config. Measured 2026-11-25 with a stack
  // trace on `gitIn`: 95 of these in 40 seconds of an idle board, all on the main thread, because the row scans run in
  // pool workers but the context they are handed is built here. The TTL is short enough that a reader who renames a
  // remote sees the new base ref on the next scan, not on the next restart.
  async ctxFor(project) {
    // ONE RESOLUTION PER PROJECT PER HALF-MINUTE, AND ONE FOR A BURST. `scanOne` asks this for every row it reads, and
    // the answer begins with a `git remote` spawn (lib/base-ref.js). Measured 2026-11-25 with a stack trace on `gitIn`:
    // 95 of those in 25 seconds of an idle board, 38 of them for ONE project - the pool hands out a project's rows at
    // once, so every row missed a cache that was only filled when the first await returned. The cache therefore holds
    // the PROMISE, not the value: concurrent callers share one resolution, and the TTL starts when it was asked for.
    // Everything else in the context - the project's rows, the parents book - is read fresh, because those change as
    // trees are cut and a stale list would have a scan call another tree's files its own.
    const key = `${project?.name || ""}::${project?.path || ""}`;
    const now = Date.now();
    let base = this.ctxCache.get(key);
    if (!base || now - base.at >= CTX_TTL_MS) {
      const pending = resolveBaseRef(project).then(({ remote, remoteRef }) => ({ remote, remoteRef }));
      pending.catch(() => this.ctxCache.delete(key)); // a failed read must not pin the project to an answer
      base = { at: now, pending };
      this.ctxCache.set(key, base);
    }
    const { remote, remoteRef } = await base.pending;
    return {
      remoteRef,
      // The per-row half: this project's list of base branches with an environment label each, and the resolved
      // remote that qualifies them. `remoteRef` above stays the project's single base and is the last candidate,
      // so a project that names no list is measured exactly as it was before (lib/base-branches.js).
      remote,
      bases: baseBranchesFrom(project.baseBranches),
      mainBranch: project.mainBranch,
      liveMinutes: this.cfg.liveMinutes,
      // Every worktree of this project, so a scan can ignore files that actually belong to a nested
      // one: the parent's `git status` lists them, and they are not the parent's work.
      nested: this.store.rowsFor(project.name).map((r) => r.path),
      // Where each tree was cut from (lib/parents.js), as plain data because this context is postMessage'd into the
      // scan worker. The row carries it so the UNMERGED chip and the steward read the same answer as the board.
      parents: this.parents ? this.parents.rowsFor(project.name) : [],
    };
  }


  // A `-w` spawn created a worktree the panel has not seen yet. Add its row immediately and read it,
  // instead of waiting for the next discovery pass (slowSeconds can be minutes away) — otherwise the
  // agent sits in the unattached list while the tree it owns exists on disk.
  async adoptWorktree(projectName, worktreePath) {
    const project = this.getProjects().find((p) => p.name === projectName);
    if (!project || !worktreePath) return false;
    // The same membership rule discovery applies: a job from an earlier session can name a tree of this repository that
    // lives somewhere else on disk, and adopting it would put a row on the board that the scan would then drop again.
    if (!isInsideProject(project.path, worktreePath)) {
      log(`not adopting ${worktreePath} for ${project.name} — its path is outside ${project.path}`);
      return false;
    }
    const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const path = String(worktreePath).replace(/\\/g, "/").replace(/\/+$/, "");
    if (this.store.rowsFor(project.name).some((r) => norm(r.path) === norm(path))) return true;
    // A job from an earlier session can name a worktree that has since been deleted, and the panel's boot
    // replays those jobs: adopting one put a branchless "…" row on the board for a folder that is not there
    // (or for an empty leftover a held delete could not remove). Only a real worktree on disk is adopted —
    // a directory with a `.git` entry; discovery adds anything else.
    const realTree = await stat(`${path}/.git`).then(() => true).catch(() => false);
    if (!realTree) {
      log(`not adopting ${path} for ${project.name} — no worktree there`);
      return false;
    }
    // Adopted between discovery passes: the same record a scan would have written, unless the cut that made it
    // already did (the panel writes the cut down before `git worktree add`, so this is normally a no-op).
    try {
      this.onWorktreeSeen?.({ name: project.name, path: project.path }, { path });
    } catch {
      /* the board adopts either way; the next discovery pass is the retry */
    }
    this.store.putRow(project.name, { path, name: path.split("/").pop(), verdict: "…" }, "fast", { force: true });
    try {
      await this.scanRow(project, { path });
    } catch {
      /* the row exists either way; its first scan can fail and retry */
    }
    log(`adopted new worktree for ${project.name}: ${path}`);
    return true;
  }

  async maybeFetch(project, force = false) {
    if (!project.remote) return; // local-only repo: nothing to fetch
    // Negative means "never fetch on a timer": the Fetch remotes button still works.
    if (this.cfg.fetchSeconds < 0 && !force) return;
    const age = Date.now() - (this.lastFetch.get(project.path) || 0);
    const want = force ? this.cfg.fetchSeconds >= 0 : this.cfg.fetchSeconds === 0 || age >= this.cfg.fetchSeconds * 1000;
    if (!want) return;
    // A host that is not answering is not dialled again (lib/remote-backoff.js) — the same hold the PR
    // reads keep. The reader's own Fetch button (`force`) still goes through: a deliberate act is the probe.
    // The id comes from the hosts mapping (2026-11-09): `project.host` is not a field the registry sets,
    // so keying on it left the fetch path outside the hold — and outside the recovery — entirely.
    const hostId = hostIdFor(this.hosts, project);
    const hold = hostId && !force ? heldBack(hostId) : false;
    if (hold) {
      this.store.patchProject(project.name, { fetchNote: `fetch held back: the host is not answering (${Math.max(1, Math.round(hold.ms / 60000))} min left)` });
      return;
    }
    // 20 s, not 180: a remote that cannot be reached is not worth stalling the pass for. gitIn also
    // disables every interactive prompt, so the common case (private repo, no cached credential) fails
    // in well under a second instead of blocking on a hidden password prompt.
    const r = await gitIn(project.path, ["fetch", project.remote, "--prune", "--no-tags"], 20000);
    if (r.ok) {
      if (hostId) hostAnswered(hostId);
      this.lastFetch.set(project.path, Date.now());
      this.stats.fetches += 1;
      this.store.patchProject(project.name, { fetchedAt: new Date(this.lastFetch.get(project.path)).toISOString(), fetchNote: null });
      log(`fetched ${project.remote} for ${project.name}`);
    } else {
      if (hostId && looksLikeHostTrouble(r.err)) hostFailed(hostId, r.err);
      this.store.patchProject(project.name, { fetchNote: `fetch failed: ${r.err || "unknown error"}` });
      log(`fetch failed for ${project.name}: ${r.err || "unknown"}`);
    }
  }

  async fetchPass({ force = false } = {}) {
    // One pass at a time, a few remotes in flight, and never more than that: 96 projects fetched one
    // after another is minutes of process spawning while the board is being used. Fetches are
    // independent of each other, so a small fan-out finishes far sooner and keeps the event loop
    // responsive between them.
    if (this.fetching) return;
    this.fetching = true;
    try {
      const queue = this.getProjects().filter((p) => {
        if (!p.remote) return false;
        if (force) return true;
        // A repo on the hourly gate is not fetched on the timer either: a fetch is a git process per repo and
        // rewrites the very .git paths the gate watches, so the fleet's old half would wake itself every ten
        // minutes. The explicit Fetch button (`force`) is the reader's own act and still covers every project.
        if (this.projectTier(p) !== "recent") return false;
        if (this.cfg.fetchSeconds < 0) return false;
        const age = Date.now() - (this.lastFetch.get(p.path) || 0);
        return this.cfg.fetchSeconds === 0 || age >= this.cfg.fetchSeconds * 1000;
      });
      const fanout = Math.max(1, Math.min(4, Number(this.cfg.fetchConcurrency) || 4));
      // A pass may start work only until this deadline: on a machine with dozens of repos a full sweep
      // is minutes of process spawning, and the panel is being used the whole time. Whatever is left
      // is picked up by the next pass.
      const stopAt = Date.now() + Math.max(5, Number(this.cfg.fetchPassSeconds) || 60) * 1000;
      let next = 0;
      const worker = async () => {
        while (next < queue.length && Date.now() < stopAt) {
          const project = queue[next++];
          await this.maybeFetch(project, force);
        }
      };
      await Promise.all(Array.from({ length: Math.min(fanout, queue.length) }, worker));
    } finally {
      this.fetching = false;
    }
  }
}


