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
// project each time (see reconcile) and any row git no longer lists is dropped at once — the panel is
// not the only thing that removes a worktree, and a row deleted out-of-band used to live in memory for
// the life of the process. Never when that call failed or came back empty: a transient git hiccup must
// not blank the table. A row whose folder is still a checkout (it has a `.git` entry) but which git did
// not list keeps a two-pass rule, because that is the shape a hiccup takes; a row whose folder is gone,
// or is there with no `.git` any more, goes on the first pass — that is what a failed delete leaves
// behind, and waiting out a second pass is what kept its ghost on the board with no branch.
import { stat } from "node:fs/promises";
import path from "node:path";
import { worktreeList, projectMeta, projectWorktrees, isInsideProject, remoteHeads, prIndex, prFor, branchUpstreams, remoteTrackedBranches, branchLink } from "./project.js";
import { resolveBaseRef } from "./base-ref.js";
import { docOf, linkFor, hostIdFor } from "./hosts.js";
import { gitIn, newestEditMs, outsideNestedWorktrees } from "./scan.js";
import { signalsFor, projectBoardSummary, hermesSessionRoots, claudeSessionRoots } from "./activity.js";
import { TierBook, bucketFor, sliceIndex, statSignal, tierOf, TIER_BUCKETS, TIER_CHECK_SECONDS } from "./tiers.js";
import { heldBack, failed as hostFailed, answered as hostAnswered, looksLikeHostTrouble } from "./remote-backoff.js";

import { log } from "./log.js";
import { withActivity } from "./loop-lag.js";

// How many promotions may WAIT behind the one in flight. A promotion is a full re-probe plus a full read of one
// repo's rows; the callers are the stat gate and the reader's clicks, and a burst of either used to run them all
// at once. Past this many, a promotion is declined and the hourly stat gate picks the repo up on its own slice.
const PROMOTION_QUEUE_MAX = 8;
const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// Rows that share one cadence are spread evenly across its window: the i-th of N of a tier is treated as
// i/N of the way through its wait, so the tier's rings drain and refill one after another instead of as a
// single animation copied down the column. The slot comes from the path order and the tier's own
// membership, so a restart comes back with the same spread and two panels agree on it; a hash of the key
// clustered instead, because sibling worktree paths differ only in their leaf.
function tierSlots(rows, intervalFor) {
  const byTier = new Map();
  for (const row of rows) {
    const interval = Math.max(1, intervalFor(row)) * 1000;
    if (!byTier.has(interval)) byTier.set(interval, []);
    byTier.get(interval).push(row);
  }
  const slot = new Map(); // row path -> ms of its wait already behind it
  for (const [interval, tier] of byTier) {
    tier.sort((a, b) => String(a.path).localeCompare(String(b.path)));
    tier.forEach((row, i) => slot.set(row.path, Math.floor((i * interval) / tier.length)));
  }
  return slot;
}
// How long a visibility report is believed. The page sends this every few seconds; a report older than this means
// no browser is watching, and the scheduler falls back to reading the whole fleet rather than freezing it.
const VISIBLE_TTL_MS = 45000;

// A git child-process spawn blocks this event loop for 0.6-4.7s under the endpoint filter
// (lib/project.js:89, test/meta-off-loop.test.js:3). The four remote answers a full pass needs
// used to be started inside one `Promise.all`, whose argument evaluation plus the memo microtask
// drain fired all four spawns back-to-back: with two passes overlapping that is eight consecutive
// spawn blocks and a 12-44s loop-pause in which /api/state and /api/thinking cannot be answered.
// Give the HTTP poll phase a MACROTASK turn between the starts. A plain `await` (microtask) does
// not return control to the poll phase; setImmediate does. The readers stay in flight together,
// so the children still run concurrently and the returned values keep their original order.
export const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

export async function staggeredReads(readers) {
  const pending = [];
  for (let i = 0; i < readers.length; i++) {
    pending.push(Promise.resolve().then(readers[i]));
    if (i < readers.length - 1) await yieldToLoop();
  }
  return Promise.all(pending);
}

export class Scheduler {
  constructor({ config, store, pool, registry = null, getProjects = null, panelAgents = null, panelThreads = null, onWorktreeSeen = null, hosts = null, listWorktrees = null }) {
    this.config = config;
    this.store = store;
    this.pool = pool;
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
    };
  }

  async ctxFor(project) {
    // The same resolution the project's header uses (lib/base-ref.js): a configured remote this checkout does not
    // have falls back to `origin` (or the only remote there is) and is named once in the log, instead of putting a
    // ref nothing resolves into every row as `github/main` and reading the whole column as NO BASE REF. No remote
    // (a local-only repo): compare against its own main branch rather than a <remote>/<branch> ref that does not exist.
    const { remoteRef } = await resolveBaseRef(project);
    return {
      remoteRef,
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

  // ---- lifecycle ---------------------------------------------------------------
  async start() {
    for (const p of this.getProjects()) this.store.ensureProject(p);
    // Discovery + first read, WITHOUT fetching. A fetch per project against a slow remote is what
    // turned every restart into a five-minute window where the whole board looked stale and every
    // next-read ring was already overdue: boots are local git only, remotes fill in afterwards.
    // "visible" mode keeps the boot pass to mapping only - projects, worktrees, project headers - and lets the
    // page's first visibility report decide which rows are worth reading. A restart then costs seconds of git
    // instead of a minute spent reading ninety projects nobody is looking at.
    this.stopped = false;
    // `boot: true` is the licence to read a recent project's rows even in "visible" mode: the board opens with the
    // projects that matter read, not mapped-and-waiting for a page that may never report them (this is the pass
    // that must exist for a row set to be honest at all).
    await withActivity("full pass (boot)", () => this.fullPass({ discover: true, fetch: false, rows: this.cfg.scanMode !== "visible", boot: true }));
    if (this.stopped) return;
    // The boot pass is a MAP: every project is read so the board opens whole. Only now do the old tier's rows
    // exist, so their rings are pointed at the hourly gate here (discovery ran before they were written).
    try {
      this.registry?.parkOldRows?.();
    } catch (e) {
      log(`tier: could not park the old fleet's rows: ${String((e && e.message) || e)}`);
    }
    // A single 1s tick decides what is due; there is no global pass stampede.
    this.timers.push(setInterval(() => void this.tick(), 1000));
    log(
      `scheduler started: active ${this.cfg.worktreeSeconds}s / mid ${this.cfg.midSeconds}s / dormant ${this.cfg.dormantSeconds}s / ` +
        `full ${this.cfg.slowSeconds}s / fetch ${this.cfg.fetchSeconds}s / pool ${this.pool.size}`,
    );
    // Remotes catch up in the background so the board is up first, accurate second.
    void withActivity("fetch pass", () => this.fetchPass()).catch((err) => log(`background fetch pass failed: ${err.message}`));
  }

  stop() {
    this.stopped = true;
    this.tierCheckAbort?.abort();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  // ---- what the reader is looking at --------------------------------------------------------------
  // The page reports the project sections it can see. Only scanMode "visible" uses it, and only while the report is
  // fresh: with the tab closed the board must still keep itself up to date (nothing else would ever read it).
  noteVisible(names) {
    const next = Array.isArray(names) ? new Set(names) : null;
    const prev = this.visible;
    this.visible = next || new Set();
    this.visibleAt = Date.now();
    const now = this.visibleAt;
    if (next) {
      // A project that has genuinely come on screen is due at once: scrolling to one that has not been read for ten
      // minutes should refresh it, not show ten-minute-old rows. But a project that merely dropped out of one report
      // and back into the next - which is what a page repainting under the reader looks like - keeps its clock, or
      // the board would re-read the same handful of projects every few seconds.
      for (const name of next) {
        const seen = this.visibleSeenAt.get(name) || 0;
        this.visibleSeenAt.set(name, now);
        if (prev.has(name) || now - seen < 30000) continue;
        this.lastProjectPass.delete(name);
        // `0` is "overdue", not "unseen": its rows are read on the next tick (see enqueueDue), while a row
        // the panel has never clocked is instead given a slot inside its own window.
        for (const key of [...this.lastFast.keys()]) if (key.startsWith(`${name}::`)) this.lastFast.set(key, 0);
        for (const key of [...this.deferUntil.keys()]) if (key.startsWith(`${name}::`)) this.deferUntil.delete(key);
      }
    }
    this.stats.visibleProjects = this.visible.size;
    this.stats.visibleAt = this.visibleAt ? new Date(this.visibleAt).toISOString() : null;
  }

  // Is there a page whose report is recent enough to be believed? Before the first report (server just started) and
  // after one goes quiet (tab closed, laptop asleep) the answer is no.
  viewingLive() {
    return this.visibleAt > 0 && Date.now() - this.visibleAt < VISIBLE_TTL_MS;
  }

  visibleOnly() {
    return String(this.cfg.scanMode || "all") === "visible";
  }

  isProjectVisible(name) {
    // The mode's whole contract: no page, no work. In "visible" a project is read only while a page says it can see
    // it - before the first report and after a stale one, nothing is read at all. Falling back to the whole fleet
    // there would undo the setting exactly when the reader is not looking, which is the case it exists for.
    if (!this.visibleOnly()) return true;
    return this.viewingLive() && this.visible.has(name);
  }

  // Priority for the bounded scan queue (lib/scan-queue.js). A project the reader is actually
  // looking at goes first (0); the rest are still queued (1), and the queue's starvation age and
  // fairness window ensure they cannot starve behind a steady stream of visible work. This is
  // independent of scanMode: even in "all" mode the reader's on-screen sections lead.
  priorityFor(name) {
    return this.viewingLive() && this.visible.has(name) ? 0 : 1;
  }

  visibilityReport() {
    return {
      mode: String(this.cfg.scanMode || "all"),
      // "active" is "this mode is deciding what gets read right now", i.e. a page is reporting.
      active: this.visibleOnly() && this.viewingLive(),
      projects: [...this.visible],
      at: this.visibleAt ? new Date(this.visibleAt).toISOString() : null,
      ageMs: this.visibleAt ? Date.now() - this.visibleAt : null,
      ttlMs: VISIBLE_TTL_MS,
    };
  }

  // The tier split for one pass, and the counters the board reads. `projects` is what this pass will read at the
  // frequent cadence; everything else in `visible` is parked on the hourly stat gate. Recording both readings here
  // (and not only in the gate, which visible mode never reaches) is what makes /api/stats answer "how many are
  // being scanned" instead of two zeroes on a board that is mostly parked.
  countTiers(visible) {
    const projects = visible.filter((p) => this.projectTier(p) === "recent");
    // The counters are the FLEET's split, not this pass's slice. A reader asking "how many are parked" means every
    // project the board knows; `visible` is only the sections a page has reported, and those are the recent ones by
    // construction - so a visible-only reading says 0 parked on a board that is 90% parked, which is the same lie
    // the gate's own counter told. The return value stays this pass's read list, which is what the caller acts on.
    const fleet = this.getProjects();
    const recent = fleet.filter((p) => this.projectTier(p) === "recent").length;
    this.stats.tierRecent = recent;
    this.stats.tierOld = Math.max(0, fleet.length - recent);
    this.stats.tierParkedNow = this.stats.tierOld;
    return projects;
  }

  async tick() {
    if (this.stopped) return;
    const t0 = Date.now();
    const now = t0;
    try {
      // Projects come and go (new repos under scanRoots): re-discover on the slow cadence,
      // then work from the fresh list.
      if (this.registry && now - this.lastRegistry >= this.cfg.registrySeconds * 1000) {
        this.lastRegistry = now;
        void withActivity("discovery", () => this.registry.refresh()).catch((e) => log(`project discovery failed: ${String((e && e.message) || e)}`));
      }
      if (now - this.lastLive >= this.cfg.liveSeconds * 1000) {
        this.lastLive = now;
        void this.livenessPass();
      }
      // In "visible" mode only the projects the page can see are read. Everything else keeps its last-known rows:
      // nothing is looked at, so nothing about it has to be fresh - and with ~100 projects that is most of the git
      // the board spawns.
      const visible = this.getProjects().filter((p) => this.isProjectVisible(p.name));
      // The tier split is decided SERVER-SIDE, once, by discovery (lib/tiers.js) and carried on the project record;
      // this loop only reads it. An old-tier repo gets no row scan and no full pass at all - the hourly stat gate
      // below is its whole cadence, and movement (or the reader opening it) promotes it back for one full probe.
      const projects = this.countTiers(visible);
      // Cheap per-row work first: it is what keeps the board live, and it must not wait behind a
      // project pass.
      for (const project of projects) this.enqueueDue(project, now);
      void withActivity("tier check", () => this.tierPass(now)).catch((e) => log(`tier pass failed: ${String((e && e.message) || e)}`));
      // Full passes are staggered. Every project used to become due in the same tick (they were all
      // stamped together at boot), so ~100 deep scans started at once and starved the main thread -
      // the requests the page makes during that window queued for seconds. Seed each project's first
      // due time somewhere at random inside the window, then start only as many as the cap allows.
      if (!this.passesSeeded) {
        this.passesSeeded = true;
        const span = Math.max(1000, this.cfg.slowSeconds * 1000);
        for (const project of projects) {
          if (!this.lastProjectPass.has(project.name) && this.store.rowsFor(project.name).length > 0) {
            this.lastProjectPass.set(project.name, now - Math.floor(Math.random() * span));
          }
        }
      }
      const cap = Math.max(1, Number(this.cfg.fullPassConcurrency) || 1);
      let started = 0;
      const startPass = (project) => {
        if (started >= cap || this.projectRunning.size >= cap) return false;
        if (this.projectRunning.has(project.name)) return false;
        this.lastProjectPass.set(project.name, now);
        started += 1;
        // deliberately not awaited: project meta + full scans must not block cheap scans
        void withActivity(`full scan: ${project.name}`, () => this.fullPassProject(project));
        return true;
      };
      // THE FRESHNESS FLOOR FIRST. A project whose rows have not been READ for `projectStaleSeconds` is due now,
      // whether or not a page can see it: "visible" chooses the frequent cadence, never "this project is not read
      // again". This is the guard that keeps /api/state from serving a ten-hour-old row set whose trees have been
      // cut since — and the one that scans every recent project once at boot, because a fresh process has no stamps.
      const staleFloor = this.getProjects().filter((p) => this.projectTier(p) === "recent" && this.projectScanDue(p, now));
      const floored = new Set(staleFloor.map((p) => p.name));
      for (const project of staleFloor) {
        if (started >= cap || this.projectRunning.size >= cap) break;
        startPass(project);
      }
      for (const project of projects) {
        if (floored.has(project.name)) continue;
        if (started >= cap || this.projectRunning.size >= cap) break;
        if (now - (this.lastProjectPass.get(project.name) || 0) < this.cfg.slowSeconds * 1000) continue;
        if (!startPass(project)) break;
      }
      this.stats.ticks += 1;
      this.stats.lastTickMs = Date.now() - t0;
      this.stats.lastTickAt = new Date().toISOString();
      this.stats.inFlight = this.pool.inFlight;
    } catch (e) {
      log(`tick error: ${String((e && e.message) || e)}`);
    }
  }

  // Cheap liveness tick: refresh the evidence chips (files / hermes / board / port) for every
  // row without running git. The underlying sources carry 4-5s TTLs and are shared across rows,
  // so a pass costs one netstat + one tasklist + one session-store read, plus a few stats.
  async livenessPass() {
    if (this.liveRunning) return; // a pass slower than liveSeconds must not stack up behind itself
    this.liveRunning = true;
    const t0 = Date.now();
    const live = this.cfg.liveMinutes;
    const [roots, claudeByRoot] = await Promise.all([withActivity("session attribution", () => this.sessionRoots()), this.claudeRoots()]);
    try {
      // Only the recent tier: liveness is a per-row filesystem read, and an old repo's rows are parked at the
      // hourly gate. Its chips were cleared when it demoted, so there is nothing here to keep fresh.
      const visible = this.getProjects().filter((p) => this.isProjectVisible(p.name) && this.projectTier(p) === "recent");
      await Promise.all(
        visible.map(async (project) => {
          await Promise.all(
            this.store.rowsFor(project.name).map(async (row) => {
              try {
                const files = outsideNestedWorktrees(
                  [...(row.dirtyFiles || []).map((f) => f.path), ...(row.untrackedFiles || [])],
                  row.path,
                  this.store.rowsFor(project.name).map((r) => r.path),
                );
                const ms = await newestEditMs(row.path, files);
                let lastEdit = row.lastEdit || null;
                if (ms && (!lastEdit || ms > Date.parse(lastEdit))) lastEdit = new Date(ms).toISOString();
                const act = await signalsFor(row.path, { lastEdit, liveMinutes: live, sessionsByRoot: roots, claudeByRoot });
                const same =
                  row.live === act.live &&
                  row.idle === act.open &&
                  row.liveWhy === act.liveWhy &&
                  lastEdit === (row.lastEdit || null) &&
                  JSON.stringify(row.signals || {}) === JSON.stringify(act.signals || {});
                // A live row always writes: lastAliveAt has to advance while the worktree stays
                // alive, even if nothing else about it changed this pass.
                if (same && !act.live) return;
                this.stats.livenessTouched += 1;
                this.store.touch(project.name, row.path, {
                  live: act.live,
                  idle: act.open,
                  signals: act.signals,
                  liveWhy: act.liveWhy,
                  lastEdit,
                  // Liveness is the whole point of this pass: when a signal fires, this is the
                  // newest moment the worktree was seen alive. `live` later lapses; the stamp stays.
                  lastAliveAt: act.live ? new Date().toISOString() : row.lastAliveAt || null,
                });
              } catch {
                /* evidence is best-effort: never let it break the tick */
              }
            }),
          );
        }),
      );
    } finally {
      this.liveRunning = false;
      this.stats.livenessPasses += 1;
      this.stats.lastLiveMs = Date.now() - t0;
    }
  }

  // Which worktree each open Hermes session is working in, recomputed at most every 5s. Computed
  // once per pass rather than once per row, because attribution walks every known worktree per
  // candidate path.
  async sessionRoots() {
    const now = Date.now();
    if (this._sessionRoots && now - this._sessionRootsAt < 5000) return this._sessionRoots;
    const known = [];
    for (const p of this.getProjects()) for (const r of this.store.rowsFor(p.name)) known.push(r.path);
    try {
      // Sessions this panel started are counted by the agent chips, not by the hermes chip: excluding them
      // here is what stops one agent being drawn twice on its row.
      const owned = this.panelThreads ? new Set(this.panelThreads()) : new Set();
      this._sessionRoots = await hermesSessionRoots(known, { exclude: owned });
      this._sessionRootsError = null;
    } catch (e) {
      // An empty Map is the safe answer, but not a silent one: this is where the node:sqlite failure
      // used to disappear, leaving "no hermes chip anywhere on the board" with no line to explain it.
      this._sessionRoots = this._sessionRoots || new Map();
      const why = String((e && e.message) || e);
      if (this._sessionRootsError !== why) log(`session attribution failed: ${why} — rows keep their last known sessions`);
      this._sessionRootsError = why;
    }
    this._sessionRootsAt = now;
    return this._sessionRoots;
  }

  // The same attribution for Claude Code sessions (read from ~/.claude, nothing the panel started).
  async claudeRoots() {
    const now = Date.now();
    if (this._claudeRoots && now - this._claudeRootsAt < 5000) return this._claudeRoots;
    const known = [];
    for (const p of this.getProjects()) for (const r of this.store.rowsFor(p.name)) known.push(r.path);
    try {
      this._claudeRoots = await claudeSessionRoots(known);
    } catch {
      this._claudeRoots = this._claudeRoots || new Map();
    }
    this._claudeRootsAt = now;
    return this._claudeRoots;
  }

  // How often this row is worth re-reading. Three tiers, because at fleet scale the demand has to
  // fit the pool: something is happening (live / idle / a panel agent) keeps the sharp cadence,
  // work that is merely unfinished (dirty, unmerged, not yet classified) coasts at midSeconds, and
  // a merged clean tree coasts at dormantSeconds.
  intervalFor(row) {
    if (row.panelAgent?.running) return this.cfg.worktreeSeconds; // an agent is working here
    if (row.live || row.idle) return this.cfg.worktreeSeconds;
    if (row.dirty || row.untracked || row.verdictStale) return this.cfg.midSeconds;
    const v = String(row.verdict || "");
    if (!v || v === "…" || v.startsWith("UNMERGED") || v.startsWith("ERROR")) return this.cfg.midSeconds;
    return this.cfg.dormantSeconds; // MERGED / NO COMMITS / ON MAIN and clean
  }

  // Which tier this project is read in, as discovery decided it (lib/tiers.js). A record with no tier is
  // classified from its own commit date here, which means an unclassified project is OLD: "not classified
  // yet" must never be mistaken for "nothing has happened here in seven days". Defaulting it to recent is
  // how a fleet-wide full scan starts.
  projectTier(project) {
    if (project?.tier === "old" || project?.tier === "recent") return project.tier;
    return tierOf(project, Date.now(), this.tiers.days);
  }

  // Has this project's row set gone unread for longer than the freshness floor? `lastScanAt` is stamped by the pass
  // that actually READ the rows (`fullPassProject`), so a map-only pass — the boot pass in visible mode — does not
  // count as a scan and the floor still reads the project on the first tick. A project with no stamp is due: a fresh
  // process must not begin by serving whatever it found.
  projectScanDue(project, now = Date.now()) {
    const at = Date.parse(this.store?.projects?.get(project?.name)?.lastScanAt || "");
    if (!Number.isFinite(at) || at <= 0) return true;
    const ttl = Math.max(1, Number(this.cfg.projectStaleSeconds) || 900) * 1000;
    return now - at >= ttl;
  }

  // One slice of the old tier's hour: read the signal on each repo whose bucket this slice is, and promote
  // any that moved. Never a burst - the bucket is a hash of the path, so a slice holds about old/buckets repos,
  // and the cap holds even if a hash were degenerate. No git runs here: `statSignal` runs the worktree walk
  // and handful of `.git` stats in a bounded worker, not on the panel's event loop.
  async tierPass(now = Date.now()) {
    const every = Math.max(1, Number(this.cfg.tierCheckSeconds) || TIER_CHECK_SECONDS) * 1000;
    if (this.tierCheckAbort || now - this.lastTierCheck < every) return { slice: null, checked: 0, promoted: 0, due: 0 };
    this.lastTierCheck = now;
    const controller = new AbortController();
    this.tierCheckAbort = controller;
    try {
      const t0 = Date.now();
      const buckets = this.tiers.buckets;
      const old = this.getProjects().filter(
        (p) => p.name && p.path && this.projectTier(p) === "old" && this.isProjectVisible(p.name) && !this.promoting.has(p.name),
      );
      const slice = sliceIndex(now, buckets, this.cfg.tierCheckSeconds);
      const cap = Math.max(1, Math.ceil(old.length / buckets));
      // Least-recently-checked first, so a bucket that holds more repos than the cap does not starve the same
      // tail every hour.
      const due = old
        .filter((p) => bucketFor(p.path, buckets) === slice)
        .sort((a, b) => (this.tiers.entry(a.path)?.checkedAt || 0) - (this.tiers.entry(b.path)?.checkedAt || 0))
        .slice(0, cap);
      let checked = 0;
      let promoted = 0;
      for (const project of due) {
        if (controller.signal.aborted) break;
        const before = this.tiers.entry(project.path);
        let signal;
        try {
          signal = await this.tierSignal(project.path, { signal: controller.signal });
        } catch (e) {
          if (controller.signal.aborted) break;
          log(`tier: ${project.name} signal failed: ${String((e && e.message) || e)} - will retry on its next slice`);
          continue;
        }
        if (controller.signal.aborted) break;
        const current = this.getProjects().find((p) => p.name === project.name);
        // A concurrent open, discovery or promotion may have changed the tier or seeded a newer
        // baseline while this worker was reading. Never compare or overwrite that newer state.
        if (!current || norm(current.path) !== norm(project.path) || this.projectTier(current) !== "old" ||
            this.promoting.has(project.name) || this.promotingQueued.has(project.name) || this.tiers.entry(project.path) !== before) continue;
        const verdict = this.tiers.stat(project.path, signal, now);
        checked += 1;
        if (verdict.moved && (await this.promoteProject(current, "stat"))) promoted += 1;
      }
      this.stats.tierChecks += checked;
      this.stats.lastTierMs = Date.now() - t0;
      this.stats.lastTierAt = new Date(now).toISOString();
      if (checked || promoted) log(`tier: slice ${slice}/${buckets} - checked ${checked} old repo(s), promoted ${promoted}`);
      return { slice, checked, promoted, due: due.length };
    } finally {
      if (this.tierCheckAbort === controller) this.tierCheckAbort = null;
    }
  }

  // Promote ONE repo: the full discovery probe (which re-derives its tier from the commit it finds) and then
  // today's full treatment for its rows. Called by the stat gate on movement and by the reader opening an old
  // project; the guard means a burst of movement in one pass costs one probe, not one per row.
  //
  // Promotions run ONE AT A TIME. A promotion is a full re-probe plus a full read of the repo's rows, and the callers
  // are not one: the stat gate, the reader's click, and (before the boot loop was removed) every restored-open
  // section of every panel tab. They used to start in parallel, so a burst - fifteen tabs each restoring a boardful
  // of sections - read the whole fleet at once and the panel answered /api/state in seconds or timed out. The queue
  // is bounded: a promotion that finds PROMOTION_QUEUE_MAX already waiting is declined, and the hourly stat gate
  // picks that repo up on its own slice instead.
  async promoteProject(project, why = "stat") {
    const name = project?.name;
    if (!name) return false;
    if (this.promoting.has(name) || this.promotingQueued.has(name)) return false;
    if (this.promotingQueued.size >= PROMOTION_QUEUE_MAX) {
      log(`tier: ${name} promotion declined (${why}) - ${this.promotingQueued.size} already waiting; the stat gate keeps it`);
      return false;
    }
    this.promotingQueued.add(name);
    const run = this.promotionChain.then(async () => {
      this.promotingQueued.delete(name);
      return this.promoteNow(project, why);
    });
    // The chain never rejects: one promotion's failure must not cancel the ones queued behind it.
    this.promotionChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async promoteNow(project, why) {
    const name = project?.name;
    if (!name) return false;
    if (this.promoting.has(name)) return false;
    this.promoting.add(name);
    const t0 = Date.now();
    try {
      let fresh = project;
      if (this.registry?.refreshProject) {
        const rec = await this.registry.refreshProject(name);
        if (rec) fresh = { ...project, ...rec };
      }
      this.lastProjectPass.set(name, Date.now());
      // `promote: true` is the licence the gate requires: this read is a promotion, not a refresh.
      await this.fullPassProject(fresh, { promote: true });
      const rows = this.store.rowsFor(name);
      for (const r of rows) this.lastFast.set(`${name}::${r.path}`, Date.now());
      // A repo the probe found STILL old goes back on the gate, so its freshly read rows are parked again: the
      // full pass just gave them the scan cadence, which is not the cadence they will actually get.
      if (this.projectTier(fresh) === "old") this.registry?.parkRows?.(fresh);
      this.stats.tierPromotions += 1;
      log(`tier: ${name} promoted (${why}) - one full probe, ${rows.length} row(s) re-read in ${Date.now() - t0}ms`);
      return true;
    } catch (e) {
      log(`tier: ${name} promotion failed (${why}): ${String((e && e.message) || e)}`);
      return false;
    } finally {
      this.promoting.delete(name);
    }
  }

  // The reader opened a project section. That is a promotion signal in its own right: an old repo is probed and
  // read once, so the rows under the section the reader just opened are current instead of up to an hour old.
  // A recent project is already on the scan cadence and costs nothing here.
  async openProject(name) {
    const project = this.getProjects().find((p) => p.name === name);
    if (!project) return { ok: false, promoted: false, tier: null, why: `no project called '${name}'` };
    if (this.projectTier(project) !== "old") return { ok: true, promoted: false, tier: "recent" };
    const promoted = await this.promoteProject(project, "open");
    const after = this.getProjects().find((p) => p.name === name) || project;
    return { ok: promoted, promoted, tier: this.projectTier(after) };
  }

  // Spread a project's rows back across their own slots after anything that read many of them at once --
  // boot, a full pass, Refresh now. Those all finish within a few seconds of each other, so without this
  // the whole tier comes due in one tick again and the column of rings moves as a single animation.
  // The row's own scan is the base: a pass over a real repo outlives a 5s cadence, and sizing from the
  // end of the pass left a live row unread for 40s with a ring counting to six times its cadence.
  dueAfter(projectName, rows, from = Date.now()) {
    const slot = tierSlots(rows, (r) => this.intervalFor(r));
    for (const row of rows) {
      const read = Date.parse(row.scannedAt || "");
      const base = Number.isFinite(read) && read <= from ? read : from;
      const due = base - (slot.get(row.path) || 0) + this.intervalFor(row) * 1000;
      this.lastFast.set(`${projectName}::${row.path}`, base - (slot.get(row.path) || 0));
      const nextReadAt = new Date(due).toISOString();
      if (row.nextReadAt !== nextReadAt) this.store.touch(projectName, row.path, { nextReadAt });
    }
  }

  // Queue a cheap scan for every row whose own due time has come round. Not awaited here:
  // the pool bounds concurrency and refuses to duplicate a worktree.
  enqueueDue(project, now = Date.now()) {
    // An old-tier repo's rows are not read on the scan cadence at all: its whole cadence is the hourly stat
    // gate (`tierPass`). The guard lives here as well as at the call site so no other caller can queue one.
    if (this.projectTier(project) !== "recent") return;
    const rows = this.store.rowsFor(project.name);
    const slot = tierSlots(rows, (r) => this.intervalFor(r));
    for (const row of rows) {
      const key = `${project.name}::${row.path}`;
      if ((this.deferUntil.get(key) || 0) > now) continue;
      if (!this.lastFast.has(key)) {
        // A row this process has never read is clocked at its own slot, not at "now": every row used to
        // come due in the same tick (an empty map reads as 0), so the rings of one tier drained and
        // refilled in lockstep and the column looked like one animation copied down it.
        this.lastFast.set(key, now - (slot.get(row.path) || 0));
      }
      if (now - this.lastFast.get(key) < this.intervalFor(row) * 1000) continue;
      if (this.pool.isBusy(row.path)) continue; // already being read
      // The pending queue is bounded and coalesced per project (lib/scan-queue.js). When it
      // has no room for this project, leave the row due instead of claiming its slot: the next
      // tick retries it, so a 100-project fleet cannot pile 87 scans behind two workers while
      // one project occupies every slot.

      if (this.pool.canEnqueue && !this.pool.canEnqueue(project.name)) continue;
      // Claim the slot before the await so a slow scan is not re-queued every tick.
      this.deferUntil.delete(key);
      this.lastFast.set(key, now);
      void this.scanRow(project, row);
    }
  }

  deferRow(projectName, rowPath, now = Date.now()) {
    const backoff = Math.max(1, Number(this.cfg.scanDeferRetryMs) || 5000);
    this.deferUntil.set(`${projectName}::${rowPath}`, now + backoff);
    this.stats.deferred = (this.stats.deferred || 0) + 1;
  }

  async scanRow(project, row) {
    try {
      const merged = await this.scanOne(project, row.path, "fast");
      this.stats.rowScans += 1;
      if (merged.verdictStale) await this.fullScan(project, merged.path);
    } catch (e) {
      // A deferred scan is not a failed read: the pool refused it because the queue was full
      // or that project already had its share pending. Park it briefly so the 1s tick does not
      // re-request it every second, and do NOT stamp an ERROR verdict onto a tree nobody looked at.
      if (e && e.code === "SCAN_QUEUE_DEFERRED") {
        this.deferRow(project.name, row.path);
        return;
      }
      this.store.markError(project.name, row.path, e);
    }
  }

  // The four remote answers a row's branch cell needs, read per PROJECT and cached, never per row: which heads the
  // remote lists (`ls-remote`), the PR index, each branch's upstream, and the last fetch's refs/remotes — the offline
  // half of "does the remote have this branch", consulted only when `ls-remote` could not answer, so no network call
  // is added to any scan path. One reader for the three callers that want them: a full scan, a project pass, and a
  // fast read that found the row's BRANCH had changed.
  async remoteAnswers(project) {
    const [heads, prs, upstreams, remoteRefs] = await staggeredReads([
      () => remoteHeads(project, this.cfg.remoteCacheSeconds, this.hosts),
      () => prIndex(project, this.cfg.prCacheSeconds, this.hosts),
      () => branchUpstreams(project),
      () => remoteTrackedBranches(project, this.cfg.remoteCacheSeconds),
    ]);
    return { heads, prs, upstreams, remoteRefs };
  }

  async decorate(project, row, heads, prs, upstreams = null, remoteRefs = null) {
    // The row's own tip goes in with the branch: a PR found by the tree's tag is only that row's PR while the
    // tree still carries the commit the PR was opened on (see prFor).
    row.pr = prFor(prs, row.branch, { upstream: upstreams?.get(row.branch) || null, tip: row.head, base: project.mainBranch });
    // The PR's own page, from the project's host record — the same template machinery as the branch cell, so a
    // Bitbucket PR links to `.../pull-requests/<n>` and a GitHub one to `.../pull/<n>` without either shape being
    // written in this file. `prUrl` is null (and `prWhy` says why) whenever the mapping cannot build it, which is the
    // one case the cell keeps plain text: a PR number with no page to open is still useful, a guessed page is not.
    const prLink = row.pr ? linkFor(docOf(this.hosts), project, "pull", { pr: row.pr.number, branch: row.branch, sha: row.head, main: project.mainBranch }) : null;
    row.prUrl = prLink?.url || null;
    row.prWhy = row.pr && !prLink?.url ? prLink.why : "";
    row.remoteBranch = !project.remote ? "n/a" : heads.size === 0 ? "unknown" : heads.has(row.branch) ? "exists" : "gone";
    // The branch cell is a link to the branch on the remote when the remote actually has it, and plain text with a
    // reason when it does not. Computed HERE, from the row's own fields, so the client holds no URL policy and one
    // test can check the shape without a browser: `branchUrl` is null unless a page is certain to exist, and
    // `branchWhy` is the sentence the cell's title carries. `remoteRefs` (the last fetch's refs/remotes/<remote>/…,
    // read once per project, no network) is only the fallback for the case `ls-remote` could not answer.
    const link = branchLink({ project, row, offline: remoteRefs, hosts: this.hosts, fetchNote: this.store.fetchNoteFor(project.name) });
    row.branchUrl = link.url || null;
    row.branchWhy = link.url ? "" : link.why;
    row.branchLinkFrom = link.url ? (String(row.remoteBranch) === "exists" ? "remote" : "local-refs") : null;
    // The branch cell's ONE chip, and which word it may carry. `local` is a claim that this branch exists ONLY on this
    // box, so it is drawn from the one answer that supports it: the remote itself listed its heads and this branch was
    // not among them (`gone`). The page used to derive the chip from `remoteBranch !== "n/a"`, which made `unknown` —
    // the remote unreachable, or the row not read yet — read as local while the same cell's tooltip said it could not
    // tell. `unverified` is that state's own word: the panel says it could not tell, and the sentence behind it quotes
    // the project's fetch note. `exists` (and a row a page could be built for from the last fetch's refs) carries no
    // chip at all, because the link already says everything a reader needs. Both fields are the server's answer; the
    // page picks no word for itself.
    row.branchChip = link.chip || null;
    row.branchLocalOnly = row.branchChip === "local";
    return row;
  }

  async scanOne(project, rowPath, depth, heads, prs, upstreams = null, remoteRefs = null) {
    const row = await this.pool.run({
      wtPath: rowPath,
      ctx: await this.ctxFor(project),
      depth,
      project: project.name,
      priority: this.priorityFor(project.name),
    });
    const prevRow = this.store.rowsFor(project.name).find((r) => norm(r.path) === norm(rowPath));
    // A row reporting a different BRANCH from the one the store had is a different branch, so everything decorate
    // computed from the old name — the link to it on the remote, why there is none, the `local` chip's answer, and the
    // PR that owns it — is now a claim about a branch this tree is not on. The rename route re-reads a tree already
    // (`scheduler.scanOne(project, path, "full")`, no heads), and a branch switched inside a tree arrives on a fast
    // tick the same way, so the answers are re-read HERE rather than waiting for the next full pass: the row carried
    // its old branch's page, which is worse than carrying none. Answers already in hand are used as they are; the
    // rest come from `remoteAnswers`, which is cached per project.
    const branchMoved = String(prevRow?.branch || "") !== String(row.branch || "");
    if (heads || prs || branchMoved) {
      const answers = heads && prs ? { heads, prs, upstreams, remoteRefs } : await this.remoteAnswers(project);
      await this.decorate(project, row, answers.heads || new Set(), answers.prs || new Map(), answers.upstreams, answers.remoteRefs);
    }

    // Liveness is a composite: files / hermes session / board PID / listening port.
    // The worker's own `live` (recent edit) is replaced by the aggregate, and the
    // sources that fired are named so the UI can show which evidence it has.
    try {
      const [sessionsByRoot, claudeByRoot] = await Promise.all([this.sessionRoots(), this.claudeRoots()]);
      const act = await signalsFor(rowPath, { lastEdit: row.lastEdit, liveMinutes: this.cfg.liveMinutes, sessionsByRoot, claudeByRoot });
      row.signals = act.signals;
      row.live = act.live;
      row.idle = act.open;
      row.liveWhy = act.liveWhy;
    } catch (e) {
      row.liveWhy = `signals error: ${String((e && e.message) || e)}`;
    }

    // The panel's own agents. A running one is the strongest evidence available and, for a `-c`
    // named-thread session, the ONLY evidence — Hermes records no cwd for those, so the session
    // store can never place them in a worktree.
    if (this.panelAgents) {
      try {
        const mine = this.panelAgents().get(norm(rowPath));
        if (mine) {
          row.panelAgent = mine;
          row.signals = { ...(row.signals || {}), panel: { on: mine.running > 0, running: mine.running, total: mine.total, threads: mine.threads } };
          if (mine.running > 0) {
            row.live = true;
            const base = String(row.liveWhy || "").replace(/panel-agent\(\d+\)/g, "").trim();
            row.liveWhy = `${base ? `${base} ` : ""}panel-agent(${mine.running})`;
          }
        }
      } catch {
        /* the mapping is best-effort */
      }
    }

    // Two clock facts the UI needs, both owned here because only the scheduler knows them:
    //   lastAliveAt  - the newest moment this worktree was actually seen alive. `live` is a
    //                  rolling window, so once it lapses the evidence is gone; this keeps the
    //                  high-water mark (carried from the previous row) plus the file-edit
    //                  timestamp, which is a real point in time.
    //   pollSeconds  - the cadence `enqueueDue` will actually apply to this row, so the client
    //                  can drain a countdown ring that empties exactly when the row is due.
    const stamps = [];
    // Only an observation of a live signal counts as "life seen". A file mtime or commit date is
    // history, not evidence that we watched something happen — stamping those made a quiet repo
    // with an old untracked file read as "last life in March".
    // A row that STAYS live must not look busier than one that just became live: stamping Date.now() on
    // every scan made the timestamp a clock of our polling rather than of the worktree, and two live rows
    // leapfrogged each other every few seconds with nothing happening in either. Now the stamp advances
    // only on an actual event - the row becoming alive, a file edit, or a session doing something.
    if (row.live) {
      if (!prevRow?.live) stamps.push(Date.now());
      stamps.push(Date.parse(row.lastEdit || "") || 0);
      stamps.push(prevRow?.signals?.hermes?.at || 0);
      // `act` is scoped to the try above; the merged row carries the same figure.
      stamps.push(row.signals?.hermes?.at || 0);
      stamps.push(prevRow?.signals?.claude?.at || 0);
      stamps.push(row.signals?.claude?.at || 0);
    }
    if (prevRow?.lastAliveAt) stamps.push(Date.parse(prevRow.lastAliveAt) || 0);
    const newestStamp = Math.max(0, ...stamps);
    row.lastAliveAt = newestStamp ? new Date(newestStamp).toISOString() : null;
    row.pollSeconds = this.intervalFor(row);
    // The server's own due time for this row, so the ring counts to the moment it will really be read.
    // Rows are staggered inside their window (see dueAfter), and a ring sized from the cadence alone
    // would fill early and then sit full until the row's turn came round.
    const clock = this.lastFast.get(`${project.name}::${rowPath}`) || Date.now();
    row.nextReadAt = new Date(clock + row.pollSeconds * 1000).toISOString();

    // A row deleted while this scan was in flight must STAY deleted: putRow creates one that is missing,
    // so a pass that began before the ✕ would put the worktree back on the board as a branchless "…"
    // row the moment it finished — the reader's "it keeps coming back" symptom. The scan is thrown away
    // instead; discovery will re-add the row if the worktree is genuinely still there.
    if (!this.store.rows.has(this.store.rowKey(project.name, rowPath))) return row;
    return this.store.putRow(project.name, row, depth);
  }

  // ---- passes ------------------------------------------------------------------
  // Cheap-only pass over every row (used by the Refresh now button).
  async fastPass() {
    const t0 = Date.now();
    for (const project of this.getProjects().filter((p) => this.isProjectVisible(p.name))) {
      for (const row of this.store.rowsFor(project.name)) {
        if (this.pool.isBusy(row.path)) continue;
        this.lastFast.set(`${project.name}::${row.path}`, Date.now());
        void this.scanRow(project, row);
      }
    }
    this.stats.fastPasses += 1;
    this.stats.lastFastMs = Date.now() - t0;
    this.stats.lastFastAt = new Date().toISOString();
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
    try {
      if (fetch) await this.maybeFetch(project, true);

      // Project meta and the worktree registry are the two spawn-heavy reads on this path, and both now run in a
      // pool worker: a `CreateProcess` blocks the loop that starts it, so leaving them here is what made /api/state
      // answer in seconds while the fleet was mapped. A scheduler built without a pool (a probe, a test) keeps the
      // in-process read, and a pool job that fails falls back to it rather than losing the project's pass.
      let mapped = null;
      try {
        mapped = this.pool?.meta ? await this.pool.meta(project) : { meta: await projectMeta(project), trees: null };
      } catch (e) {
        log(`worktree meta for ${project.name} in the pool failed (${String((e && e.message) || e).slice(0, 90)}) — reading it here`);
        mapped = { meta: await projectMeta(project), trees: null };
      }
      this.store.patchProject(project.name, mapped.meta);

      // The coordination board lives at the checkout root, not per worktree, so its claim
      // is a project-level statement (per-worktree evidence is the session store and the
      // declared dev port).
      try {
        this.store.patchProject(project.name, { board: await projectBoardSummary(project.path) });
      } catch {
        /* board is optional */
      }

      // Reconcile on EVERY full pass, not only on the slow discovery clock. `dropRow` is called by the paths the
      // panel itself drives (the ✕, a rename that moved the directory), so a worktree removed out-of-band — a
      // merge agent's `git worktree remove`, a worker cleaning up in its own shell — left its row in this Map for
      // the life of the process: on the board it read as a worktree with no branch and a verdict from days ago.
      // `git worktree list --porcelain` is git's own registry and the only authority, and it is the same call
      // discovery makes, so a pass that already reads it hands the answer over instead of paying for it twice.
      const reconciled = await this.reconcile(project, mapped.trees);
      if (!reconciled.ok) log(`worktree reconcile for ${project.name}: keeping rows (${reconciled.why})`);

      // `rows: false` is the boot pass in "visible" mode: it maps what exists (projects, worktrees, headers) and
      // leaves the per-row git reads to the page's first visibility report. Those rows still carry their last-known
      // values, and the ones on screen are read within a second of the page saying so. A RECENT project's rows are
      // read even then (`boot`): the board must open with the projects that matter read, not mapped and waiting for
      // a page that may never report them.
      const readRows = rows || (boot && this.projectTier(project) === "recent");
      if (readRows) {
        const answers = await this.remoteAnswers(project);
        await Promise.all(
          this.store.rowsFor(project.name).map(async (r) => {
            try {
              await this.scanOne(project, r.path, "full", answers.heads, answers.prs, answers.upstreams, answers.remoteRefs);
              // Stamp the row as read. Without this the first tick after boot sees every row as
              // never-scanned and re-enqueues the whole fleet the pass just read -- a redundant
              // burst that leaves the board stale exactly when it finally came up.
              this.lastFast.set(`${project.name}::${r.path}`, Date.now());
              this.stats.rowScans += 1;
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
    for (const t of listed) {
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
    for (const w of wts) {
      const known = this.store.rowsFor(project.name).some((r) => norm(r.path) === norm(w));
      if (known) continue;
      log(`new worktree detected: ${w}`);
      this.store.putRow(project.name, { path: w.replace(/\\/g, "/"), name: w.split(/[\\/]/).pop(), verdict: "…" }, "fast", { force: true });
      added += 1;
    }

    let dropped = 0;
    for (const r of this.store.rowsFor(project.name)) {
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
      const n = gone || outsideRow ? 2 : (this.misses.get(key) || 0) + 1;
      this.misses.set(key, n);
      if (n >= 2) {
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
