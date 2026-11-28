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
import { TREE_CACHE_STALE_KEEP_MS } from "./tree-cache.js";
import { worktreeList, projectMeta, projectWorktrees, isInsideProject } from "./project.js";
import { resolveBaseRef } from "./base-ref.js";
import { baseBranchesFrom } from "./base-branches.js";
import { hostIdFor } from "./hosts.js";
import { gitIn } from "./scan.js";
import { projectBoardSummary } from "./activity.js";
import { TierBook, statSignal, TIER_BUCKETS, TIER_CHECK_SECONDS } from "./tiers.js";
import { heldBack, failed as hostFailed, answered as hostAnswered, looksLikeHostTrouble } from "./remote-backoff.js";
import { log } from "./log.js";
import { SchedulerLifecycle, yieldToLoop, norm } from "./scheduler-lifecycle.js";

export { yieldToLoop, staggeredReads } from "./scheduler-lifecycle.js";

// How long a project's scan context is reused (see ctxFor).
const CTX_TTL_MS = 30_000;

export class Scheduler extends SchedulerLifecycle {
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


  // ---- passes ------------------------------------------------------------------
  // The moment a pass that enumerated every project's tree list finished, in this process. It is what the page's one
  // row rule is gated on: a card may fall to the unattached list only after a completed scan, so a slow or failed
  // first pass can never be the reason an agent reads as unattached. The timestamp is monotonic for the process (a
  // later pass always wins), which is all the page needs.
  markScanComplete({ pass = "full", projects = 0 } = {}) {
    this.lastScanCompleteAt = new Date().toISOString();
    this.stats.lastScanCompleteAt = this.lastScanCompleteAt;
    this.stats.lastScanCompletePass = pass;
    this.stats.lastScanCompleteProjects = projects;
    try {
      this.onScanComplete?.({ at: this.lastScanCompleteAt, pass, projects });
    } catch (e) {
      log(`scan completion not recorded (${String((e && e.message) || e)})`);
    }
  }

  // How many cards are filed under one tree path, 0 when there is no answer. The scheduler keeps its own count so a
  // vanished tree can be kept for the agent standing on it; the hook is the panel's agent map, which is keyed the same
  // way `scanOne` reads it (`norm`).
  agentCountFor(rowPath) {
    try {
      const mine = this.panelAgents?.()?.get(norm(rowPath));
      return Number(mine?.total) || 0;
    } catch {
      return 0;
    }
  }

  // Cheap-only pass over every row (used by the Refresh now button).
  async fastPass() {
    const t0 = Date.now();
    const projects = this.getProjects().filter((p) => this.isProjectVisible(p.name));
    for (const project of projects) {
      for (const row of this.store.rowsFor(project.name)) {
        if (this.pool.isBusy(row.path)) continue;
        this.lastFast.set(`${project.name}::${row.path}`, Date.now());
        void this.scanRow(project, row);
      }
    }
    this.stats.fastPasses += 1;
    this.stats.lastFastMs = Date.now() - t0;
    this.stats.lastFastAt = new Date().toISOString();
    // A FAST pass re-reads the rows already on the board: it enumerates no project's tree list, so it must NOT mark the
    // list complete. `lastScanCompleteAt` is what lets the page call an agent unattached, and a cheap read cannot know
    // that a tree was cut or removed; only the full pass can. (Rows keep their cached flag until their own read lands.)
  }

  // One row, fully read, decorated with the project's remote heads and PR index — the sweep's own code path. Returns the
  // row it merged into the store (the ⟳ route hands it back to the page so the row repaints from the answer instead of
  // waiting for an event), or null when this tree is already being read or the read threw.
  async fullScan(project, rowPath) {
    const key = `${project.name}::${rowPath}`;
    if (this.queuedFull.has(key) || this.pool.isBusy(rowPath)) return null;
    this.queuedFull.add(key);
    try {
      const answers = await this.remoteAnswers(project);
      return (await this.scanOne(project, rowPath, "full", answers.heads, answers.prs, answers.upstreams, answers.remoteRefs)) || null;
    } catch (e) {
      // A deferred scan is not a failed read; it is retried after a short backoff.
      if (e && e.code === "SCAN_QUEUE_DEFERRED") {
        this.deferRow(project.name, rowPath);
        return null;
      }
      this.store.markError(project.name, rowPath, e);
      return null;
    } finally {
      this.queuedFull.delete(key);
    }
  }

  async fullPassProject(project, { fetch = false, rows = true, promote = false, boot = false } = {}) {
    if (this.projectRunning.has(project.name)) return;
    // THE GATE. An old-tier repo is mapped ONCE - the pass that has to create the rows the board draws for
    // it, which a cold process needs and no later pass does - and from then on it is not read at all. Every
    // refresh pass (the slow clock, `Refresh`, the pass the Fetch button chains) walks the whole fleet, and
    // without this guard each of them re-read 160 repositories whose entire meaning is that nothing has
    // happened in them: `git worktree list`, the project meta, the remote answers and one scan per row, per
    // repo, per pass. That is the spawn pressure, and the tier's hourly stat check is what replaces it.
    //
    // The two ways past the guard are the reader opening the project and the stat check promoting it, and
    // both arrive here through `promoteProject` with `promote: true`. Nothing on this path may re-derive a
    // tier: a refresh cannot make an old repo recent, whatever it would have found. Only the probe that a
    // promotion runs reads a commit date, and that is what puts a repo back on the scan cadence.
    if (!promote && this.projectTier(project) === "old" && this.store.rowsFor(project.name).length > 0) {
      this.stats.tierParked += 1;
      return;
    }
    this.projectRunning.add(project.name);
    const t0 = Date.now();
    // Boot timing (see `start`): one entry per project the boot pass walks, with its phase split. The
    // report is null outside the boot pass, so every accumulation below costs one object check in normal passes.
    const bootReport = boot ? this.bootReport : null;
    const bootEntry = bootReport
      ? { name: project.name, tier: this.projectTier(project), ms: 0, metaMs: 0, reconcileMs: 0, boardMs: 0, remoteMs: 0, rowsMs: 0, rows: 0, trees: 0 }
      : null;
    if (bootReport) {
      bootReport.projects += 1;
      bootReport.perProject.push(bootEntry);
    }
    try {
      if (fetch) await this.maybeFetch(project, true);

      // What this pass reads, decided once so the warm-up below and the read block cannot disagree.
      const readRows = rows || (boot && this.projectTier(project) === "recent");
      // The pass's only network reads are the remote answers, and only the read block consumes them, so start
      // them here and they overlap the spawn-heavy meta walk instead of queueing their round trips behind it:
      // the first measured boot spent 22s under `remoteAnswers` across 17 recent projects, most of it a wait no
      // lane was doing anything else in (2026-11-13, 73.8s boot). The block awaits THIS promise, so the
      // answers, the rows built from them and the cadences derived from the rows are the ones the pass always
      // produced - only the network's overlap with the mapping is new. Started after the fetch step, so a fetch
      // pass still asks the remote after its fetch, as it always did. A pass that never reaches the block (an
      // exception) leaves the promise settling unawaited; the no-op catch keeps that path from an unhandled
      // rejection. Nothing is awaited early here - only started.
      let answerWarmup = null;
      if (readRows) {
        answerWarmup = this.remoteAnswers(project);
        answerWarmup.catch(() => {});
      }

      // Project meta and the worktree registry are the two spawn-heavy reads on this path, and both now run in a
      // pool worker: a `CreateProcess` blocks the loop that starts it, so leaving them here is what made /api/state
      // answer in seconds while the fleet was mapped. A scheduler built without a pool (a probe, a test) keeps the
      // in-process read, and a pool job that fails falls back to it rather than losing the project's pass.
      let mapped = null;
      const tMeta = Date.now();
      try {
        mapped = this.pool?.meta ? await this.pool.meta(project) : { meta: await projectMeta(project), trees: null };
      } catch (e) {
        log(`worktree meta for ${project.name} in the pool failed (${String((e && e.message) || e).slice(0, 90)}) — reading it here`);
        mapped = { meta: await projectMeta(project), trees: null };
      }
      this.store.patchProject(project.name, mapped.meta);
      if (bootEntry) {
        bootEntry.metaMs = Date.now() - tMeta;
        bootReport.metaMs += bootEntry.metaMs;
      }

      // The coordination board lives at the checkout root, not per worktree, so its claim is a project-level
      // statement (per-worktree evidence is the session store and the declared dev port). NOT on the boot: the
      // read includes a whole process table (`tasklist`, lib/activity.js runningPids), which took 10.6s under the
      // boot's own load and held every project's pass behind it (measured 2026-11-23: 30.4s boot, board
      // 10,565ms). `boardPass` fills it straight after the boot pass, so the header's claim lands seconds later
      // instead of holding the first paint.
      if (!boot) {
        try {
          this.store.patchProject(project.name, { board: await projectBoardSummary(project.path) });
        } catch {
          /* board is optional */
        }
      }

      // Reconcile on EVERY full pass, not only on the slow discovery clock. `dropRow` is called by the paths the
      // panel itself drives (the ✕, a rename that moved the directory), so a worktree removed out-of-band — a
      // merge agent's `git worktree remove`, a worker cleaning up in its own shell — left its row in this Map for
      // the life of the process: on the board it read as a worktree with no branch and a verdict from days ago.
      // `git worktree list --porcelain` is git's own registry and the only authority, and it is the same call
      // discovery makes, so a pass that already reads it hands the answer over instead of paying for it twice.
      const tReconcile = Date.now();
      const reconciled = await this.reconcile(project, mapped.trees);
      if (bootEntry) {
        bootEntry.reconcileMs = Date.now() - tReconcile;
        bootReport.reconcileMs += bootEntry.reconcileMs;
        bootEntry.trees = reconciled.listed || 0;
        bootReport.trees += bootEntry.trees;
      }
      if (!reconciled.ok) log(`worktree reconcile for ${project.name}: keeping rows (${reconciled.why})`);

      // `rows: false` is the boot pass in "visible" mode: it maps what exists (projects, worktrees, headers) and
      // leaves the per-row git reads to the page's first visibility report. Those rows still carry their last-known
      // values, and the ones on screen are read within a second of the page saying so. A RECENT project's rows are
      // read even then (`boot`): the board must open with the projects that matter read, not mapped and waiting for
      // a page that may never report them.
      if (readRows) {
        if (bootReport) bootReport.recentRead += 1;
        // A boot does NOT wait for the remote answers before reading its rows. `ls-remote` and the PR index are
        // the only network reads on this path, and a host that is slow or in backoff held them for 30-38s per
        // project (measured 2026-11-22: optym-transmission-multi remote 33.2s, sales-territory-poc 38.0s, their
        // rows 43.3s and 38.5s behind them). Nothing a row's first paint needs comes from the network: status,
        // branch and commit counts are local, and a fast put keeps the verdict the last full read classified
        // (lib/store.js putRow). The answers decorate these rows when they land - see the block after the read -
        // so a remote that is down costs the branch cell its link for a moment, not the board its first paint.
        //
        // A boot also reads at "fast" depth. The pass exists to open the board; verdict, cherry patch-ids and
        // diffstat are what a full scan classifies, and a row whose commit count moved is marked `verdictStale`
        // by putRow, which puts it on `midSeconds` and has `scanRow` escalate it to a full scan on its next tick.
        // The depth therefore costs the board nothing it does not catch up on within 90s.
        const depth = boot ? "fast" : "full";
        const answers = boot ? null : await answerWarmup;
        const tRows = Date.now();
        let read = 0;
        const scanned = [];
        await Promise.all(
          this.store.rowsFor(project.name).map(async (r) => {
            try {
              const merged = await this.scanOne(project, r.path, depth, answers?.heads, answers?.prs, answers?.upstreams, answers?.remoteRefs);
              if (merged) scanned.push(merged);
              // Stamp the row as read. Without this the first tick after boot sees every row as
              // never-scanned and re-enqueues the whole fleet the pass just read -- a redundant
              // burst that leaves the board stale exactly when it finally came up.
              this.lastFast.set(`${project.name}::${r.path}`, Date.now());
              this.stats.rowScans += 1;
              read += 1;
            } catch (e) {
              // A deferred scan is not a failed read: park it for a short backoff. Do not
              // stamp lastFast (it was never read) and do not write an ERROR verdict.
              if (e && e.code === "SCAN_QUEUE_DEFERRED") {
                this.deferRow(project.name, r.path);
                return;
              }
              this.store.markError(project.name, r.path, e);
            }
          }),
        );
        if (bootReport) {
          bootReport.rowsScanned += read;
          bootReport.rowsMs += Date.now() - tRows;
          if (bootEntry) {
            bootEntry.rowsMs = Date.now() - tRows;
            bootEntry.rows = read;
          }
        }
        // The answers the boot did not wait for decorate the rows it just read. The promise was started before the
        // meta walk, so by now it is usually settled and this is a handful of in-memory merges; when it is not - the
        // failing host in its backoff - the board has already opened and the branch cells fill in later. `remoteMs`
        // in the boot report is the answers' own duration, recorded only while the report is still open, so a boot
        // that no longer waits cannot report a wait it did not do.
        if (boot && answerWarmup) {
          const tAnswers = Date.now();
          void answerWarmup
            .then(async (a) => {
              await this.decorateReadRows(project, scanned, a);
              if (bootReport && this.bootReport === bootReport) {
                bootReport.remoteAnswers += 1;
                bootReport.remoteAnswerMs += Date.now() - tAnswers;
                if (bootEntry) bootEntry.remoteMs = Date.now() - tAnswers;
              }
            })
            .catch((e) => log(`remote answers for ${project.name} did not decorate its rows (${String((e && e.message) || e).slice(0, 90)})`));
        }
        // The pass read every row within the same few seconds, which would put a tier back in lockstep;
        // hand each one its own slot now that the verdicts (and so the cadences) are in.
        this.dueAfter(project.name, this.store.rowsFor(project.name));
        // THE SCAN STAMP. A pass that READ this project's rows is the project's own scan: /api/state carries it, and
        // the freshness floor compares against it. A map-only pass leaves it alone on purpose — otherwise a boot in
        // visible mode would stamp a project it never read.
        this.store.patchProject(project.name, { lastScanAt: new Date().toISOString() });
      }
      this.stats.fullPasses += 1;
      this.stats.lastFullMs = Date.now() - t0;
      this.stats.lastFullAt = new Date().toISOString();
    } catch (e) {
      this.store.patchProject(project.name, { error: String((e && e.message) || e) });
    } finally {
      this.projectRunning.delete(project.name);
      if (bootEntry) bootEntry.ms = Date.now() - t0;
    }
  }

  async fullPass({ fetch = false, rows = true, boot = false } = {}) {
    // Bounded parallelism, not a serial await: 94 projects at ~5s each is an eight-minute boot when
    // done one at a time, and that whole window is the board showing stale rows. Wider than this
    // and boot competes with the row scans for git.
    const projects = this.getProjects();
    const span = Math.max(1000, this.cfg.slowSeconds * 1000);
    const seedNow = Date.now();
    for (const project of projects) {
      if (!this.lastProjectPass.has(project.name)) {
        this.lastProjectPass.set(project.name, seedNow - Math.floor(Math.random() * span));
      }
    }
    const width = Math.max(1, Math.min(Number(this.cfg.threads) || 4, 8));
    let next = 0;
    const lane = async () => {
      while (next < projects.length) {
        const project = projects[next++];
        try {
          await this.fullPassProject(project, { fetch, rows, boot });
        } catch (err) {
          log(`full pass failed for ${project.name}: ${(err && err.message) || err}`);
        }
        // One project's pass still starts several child processes; give a pending HTTP
        // request a macrotask turn before the next project's spawn burst begins.
        await yieldToLoop();
      }
    };
    await Promise.all(Array.from({ length: width }, lane));
    // Every project's tree list has now been enumerated by this pass, whatever each row's own read answered. The page
    // reads this as "a scan has completed", which is the only thing that may move a card to the unattached list.
    this.markScanComplete({ pass: "full", projects: projects.length });
  }

  // Make the store's rows match git's own registry, both ways, from ONE `git worktree list --porcelain`.
  //
  //   - a worktree git lists and the store does not know is ADDED, so a tree cut out-of-band shows up on the pass
  //     after it appears rather than on the slow discovery clock;
  //   - a row whose path git does not list is DROPPED, through store.dropRow, which emits the same `type:"drop"`
  //     event the client already handles — the row leaves every open board without a full re-read.
  //
  // A row is only ever re-added from a listing read NOW. Nothing here consults a cached path list (this.misses,
  // lastFast, or the discovery cache): a deleted tree that a stale list still mentions would otherwise come back
  // as a branchless row, which is the ghost this replaces.
  //
  // A listing that FAILED, or came back empty while rows exist, is not evidence that trees are gone: every row is
  // kept and the project's note says why. A listing that SUCCEEDED without a path is evidence — but a row whose
  // folder still has a `.git` entry keeps the two-pass rule, because that is the shape a git hiccup takes; a row
  // whose folder is gone, or is there with no `.git` any more, goes on the first pass (that is what a failed
  // delete leaves behind, and waiting out a second pass is what kept its ghost on the board).
  //
  // The ONE row a successful listing does not drop is the row an agent is standing on: a tree that vanished from disk
  // with a card filed under it is marked STALE (last seen at, path) and kept for the retention window, because a card
  // belongs to the tree it named and never to the unattached list on the strength of a folder that moved.

  async reconcile(project, prelisted = null) {
    let listed = null;
    try {
      // The pool's meta job already asked git for this list; a second `worktree list` for the same pass is a
      // spawn this pass does not need. A caller with no list (or a test's injected reader) reads it here.
      listed = prelisted || (await this.listWorktrees(project.path));
    } catch (e) {
      const why = `worktree list failed (${String((e && e.message) || e).slice(0, 90)})`;
      this.store.patchProject(project.name, { discoveryNote: `${why} — keeping rows` });
      return { ok: false, why, listed: 0, added: 0, dropped: 0 };
    }
    // Every tree this pass enumerated, in the order git answered, before a row is written for any of them: the
    // naming record for a tree the panel has never seen is written here (server.js seeds it under the name it
    // was found with), so a tree that predates the ledger cannot reach the automatic rename as "unnamed".
    //
    // Boarding a fleet this size is hundreds of rows of synchronous bookkeeping - the log line, the store write,
    // its change detection - and a boot does it for the whole fleet at once: the 2026-11-13 21:04 boot (threads
    // 4) read as three loop-pauses (1.6s, 1.2s, 4.7s), each sitting exactly on the biggest projects' first
    // boarding. Yield on a time budget so a burst can never hold the timer: ~100ms of work, then one turn.
    let chunkAt = Date.now();
    const keepLoop = async () => {
      if (Date.now() - chunkAt < 100) return;
      await yieldToLoop();
      chunkAt = Date.now();
    };
    for (const t of listed) {
      await keepLoop();
      try {
        this.onWorktreeSeen?.(project, t);
      } catch (err) {
        log(`naming hook failed for ${project.name}: ${String((err && err.message) || err)}`);
      }
    }
    // `git worktree list` answers for the REPOSITORY, not for this project: every tree cut from the same repo is in
    // that answer wherever it sits on disk (a lander's comparison trees under a scratch folder are worktrees of this
    // repo exactly as `.worktrees/…` is). The board draws the trees this project OWNS — its own checkout and the
    // worktrees inside it — and nothing else. EXCLUDED, not drawn-and-marked: a row is what the merge, rename and
    // delete controls hang off, what `safe to remove` counts and what the header's UNMERGED arithmetic runs over, so
    // a row for a tree outside the project is a row whose every control is refused or wrong. The count rides on the
    // project record (`outsideTrees`, in /api/state) and is logged when it changes, so the exclusion is inspectable
    // rather than silent.
    const { kept, outside } = projectWorktrees(project.path, Array.isArray(listed) ? listed : []);
    const wts = kept.map((w) => w.path);
    const outsideBefore = Number(this.store.projects.get(project.name)?.outsideTrees) || 0;
    if (outside.length !== outsideBefore) {
      log(
        outside.length
          ? `${project.name}: ${outside.length} worktree(s) of this repository sit outside ${project.path} — not boarded: ${outside.map((w) => w.path).join(", ")}`
          : `${project.name}: no worktrees outside ${project.path} any more`,
      );
    }

    const held = this.store.rowsFor(project.name).length;
    if (!wts.length && held) {
      const why = `worktree list came back empty — keeping ${held} row(s)`;
      this.store.patchProject(project.name, { discoveryNote: why });
      return { ok: false, why, listed: 0, added: 0, dropped: 0 };
    }

    const live = new Set(wts.map(norm));
    let added = 0;
    // One pass over the rows builds the membership set the loop asked per tree before (`rowsFor().some()` per
    // tree was the same scan repeated for every worktree); the yield keeps the burst off the timer (see above).
    const have = new Set(this.store.rowsFor(project.name).map((r) => norm(r.path)));
    for (const w of wts) {
      await keepLoop();
      if (have.has(norm(w))) continue;
      log(`new worktree detected: ${w}`);
      this.store.putRow(project.name, { path: w.replace(/\\/g, "/"), name: w.split(/[\\/]/).pop(), verdict: "…" }, "fast", { force: true });
      added += 1;
    }

    let dropped = 0;
    for (const r of this.store.rowsFor(project.name)) {
      await keepLoop();
      const key = `${project.name}::${r.path}`;
      if (live.has(norm(r.path))) {
        this.misses.delete(key);
        continue;
      }
      // A row whose path is outside the project root is not this project's tree at all. git answered a successful
      // listing and the row is not in the set the board draws, so it needs neither a second opinion nor the two-pass
      // grace: that grace is for a git hiccup about a tree the project still owns. Dropped on the FIRST pass, which
      // is what takes the trees an earlier build boarded off the page in one discovery instead of two.
      const outsideRow = !isInsideProject(project.path, r.path);
      const onDisk = await stat(r.path).then(() => true).catch(() => false);
      const isTree = onDisk && (await stat(path.join(r.path, ".git")).then(() => true).catch(() => false));
      const gone = !isTree;
      // A CACHED row is the row the first paint was drawn from, and one listing is not a reason to take an agent's
      // tree away from it: the only things that end a cached row are its own successful read (which replaces it in
      // place, same key) or the disk, which renders it stale below. Nothing here runs before the row was ever read.
      if (r.cached) {
        if (gone && !outsideRow) {
          log(`cached worktree vanished before its first read - stale, not unattached: ${r.path}`);
          this.store.markStale(project.name, r.path, {
            reason: onDisk ? "the folder is no longer a worktree" : "the folder is gone from disk",
            lastSeenAt: r.cachedAt || r.scannedAt || null,
          });
        }
        continue;
      }
      // A row already STALE keeps its reason for the retention window (lib/tree-cache.js), then leaves. It is not
      // re-tested against the listing's misses: the tree is gone and the row says so, and a tree that comes back is
      // cleared by its own successful scan rather than by a discovery pass.
      if (r.stale) {
        const seen = Date.parse(r.stale.lastSeenAt || "") || 0;
        if (gone && !outsideRow && (!seen || Date.now() - seen > TREE_CACHE_STALE_KEEP_MS)) {
          log(`worktree stale past its keep window (${r.stale.reason}): ${r.path}`);
          this.store.dropRow(project.name, r.path);
          dropped += 1;
        }
        continue;
      }
      const n = gone || outsideRow ? 2 : (this.misses.get(key) || 0) + 1;
      this.misses.set(key, n);
      if (n >= 2) {
        // An agent still owns this tree. A tree that vanished from disk while its agent is on the board is kept as
        // STALE - last seen at, path - so the card stays under its row with the reason instead of jumping to the
        // unattached list. This is the tree cache's rule applied to a live board, and it is why the row is not
        // dropped on the same pass that noticed the folder was gone.
        const agents = this.agentCountFor(r.path);
        if (gone && !outsideRow && agents > 0) {
          log(`worktree gone, kept stale for ${agents} agent(s): ${r.path}`);
          this.store.markStale(project.name, r.path, {
            reason: onDisk ? "the folder is no longer a worktree" : "the folder is gone from disk",
            lastSeenAt: r.scannedAt || null,
          });
          this.misses.delete(key);
          continue;
        }
        log(
          `worktree gone (${outsideRow ? `its path is outside ${project.path}` : gone ? (onDisk ? "its folder is no longer a worktree" : "its folder is gone") : `absent from ${n} consecutive listings`}): ${r.path}`,
        );
        this.misses.delete(key);
        this.lastFast.delete(key);
        this.store.dropRow(project.name, r.path);
        dropped += 1;
      } else {
        log(`worktree not listed this pass (1/2) — keeping: ${r.path}`);
      }
    }
    this.store.patchProject(project.name, { discoveryNote: null, outsideTrees: outside.length });
    return { ok: true, why: "", listed: wts.length, added, dropped };
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

