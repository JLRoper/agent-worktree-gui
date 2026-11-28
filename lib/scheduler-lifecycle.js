// The scheduler's lifecycle: the boot, the tick, the visible set, the promotion and the one row read.
//
// Cut 1 of the two in docs/reports/module-separation-2026-11-28.html, entry 14 (lib/scheduler.js):
// source lines 276-1077, moved verbatim. These were Scheduler's own methods, so they reach the
// instance as `this` from lib/scheduler.js's `class Scheduler extends SchedulerLifecycle` - no body
// was rewritten and no call site changed. yieldToLoop, staggeredReads and norm move here with them
// because the passes need them as well, and lib/scheduler.js re-exports the two it published.
//
// The constants and the two readers below are the ones the original carried above the class; the
// comments are its own, kept beside the code they explain.

import { remoteHeads, prIndex, prFor, branchLocals, branchLink } from "./project.js";
import { docOf, linkFor } from "./hosts.js";
import { newestEditMs, outsideNestedWorktrees } from "./scan.js";
import { signalsFor, projectBoardSummary, hermesSessionRoots, claudeSessionRoots } from "./activity.js";
import { bucketFor, sliceIndex, tierOf, TIER_CHECK_SECONDS } from "./tiers.js";
import { log } from "./log.js";
import { withActivity } from "./loop-lag.js";

// How many promotions may WAIT behind the one in flight. A promotion is a full re-probe plus a full read of one
// repo's rows; the callers are the stat gate and the reader's clicks, and a burst of either used to run them all
// at once. Past this many, a promotion is declined and the hourly stat gate picks the repo up on its own slice.
const PROMOTION_QUEUE_MAX = 8;
export const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

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

export class SchedulerLifecycle {
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
    //
    // The pass reports its own weight (the boot-pass-weight plan's Option 1, 2026-11-13): `this.bootReport` is
    // open only while the pass below runs, `fullPassProject` accumulates its phase split into it, and the one
    // summary line in the finally (plus `stats.lastBoot` on /api/stats) carries the numbers to the next reader.
    // Diagnostics only: with no report open, every accumulator site is one null check and no timer runs.
    const bootT0 = Date.now();
    this.bootReport = {
      at: new Date(bootT0).toISOString(),
      totalMs: null,
      projects: 0,
      recentRead: 0,
      rowsScanned: 0,
      trees: 0,
      remoteAnswers: 0,
      remoteAnswerMs: 0,
      metaMs: 0,
      reconcileMs: 0,
      boardMs: 0,
      rowsMs: 0,
      perProject: [],
    };
    try {
      await withActivity("full pass (boot)", () => this.fullPass({ discover: true, fetch: false, rows: this.cfg.scanMode !== "visible", boot: true }));
    } finally {
      // Runs on failure too: a boot that threw still logs the split of what it managed to walk, and the error
      // keeps travelling. The report is dropped either way, so later passes accumulate nothing.
      const report = this.bootReport;
      this.bootReport = null;
      report.totalMs = Date.now() - bootT0;
      report.perProject.sort((a, b) => b.ms - a.ms);
      const slowest = report.perProject
        .slice(0, 8)
        .map((p) => `${p.name} ${p.ms}ms [meta ${p.metaMs} reconcile ${p.reconcileMs} board ${p.boardMs} remote ${p.remoteMs} rows ${p.rowsMs} n=${p.rows}]`)
        .join(" | ");
      report.perProject = report.perProject.slice(0, 20); // capped: /api/stats carries this
      this.stats.lastBoot = report;
      log(
        `boot timing: mapped ${report.projects} project(s), read ${report.recentRead} recent, ${report.rowsScanned} row scan(s), ${report.trees} tree(s), ` +
          `${report.remoteAnswers} remote-answer set(s) in ${(report.totalMs / 1000).toFixed(1)}s — meta ${report.metaMs}ms / reconcile ${report.reconcileMs}ms / ` +
          `board ${report.boardMs}ms / remote ${report.remoteAnswerMs}ms / rows ${report.rowsMs}ms; slowest: ${slowest || "n/a"}`,
      );
    }
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
    // The project headers' coordination claim, off the boot pass (see fullPassProject): one `tasklist` for the whole
    // fleet, but 1-10s of it under load, and nothing the first paint needs. Started here so it lands within seconds
    // of the board opening.
    void withActivity("board pass", () => this.boardPass()).catch((err) => log(`background board pass failed: ${err.message}`));
  }

  // Every project's `.agentboard` claim, read once per boot, behind the board instead of in front of it. The reads
  // are a directory listing and a small JSON per project plus ONE process table (`runningPids`, memoised), so this
  // is cheap when the box is quiet and slow exactly when the boot needs the CPU - which is why it is not part of the
  // boot pass.
  async boardPass() {
    for (const project of this.getProjects()) {
      if (this.stopped) return;
      try {
        this.store.patchProject(project.name, { board: await projectBoardSummary(project.path) });
      } catch {
        /* board is optional */
      }
      await yieldToLoop();
    }
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
      const key = `${projectName}::${row.path}`;
      // A row parked on a refusal is not this pass's to stagger: nothing read it, so its `scannedAt` is the boot
      // second, and re-anchoring its claim there put the retry back behind a whole interval. Its backoff owns it.
      if ((this.deferUntil.get(key) || 0) > from) continue;
      const read = Date.parse(row.scannedAt || "");
      const base = Number.isFinite(read) && read <= from ? read : from;
      const due = base - (slot.get(row.path) || 0) + this.intervalFor(row) * 1000;
      this.lastFast.set(key, base - (slot.get(row.path) || 0));
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
      const deferredUntil = this.deferUntil.get(key) || 0;
      if (deferredUntil > now) continue;
      if (!this.lastFast.has(key)) {
        // A row this process has never read is clocked at its own slot, not at "now": every row used to
        // come due in the same tick (an empty map reads as 0), so the rings of one tier drained and
        // refilled in lockstep and the column looked like one animation copied down it.
        this.lastFast.set(key, now - (slot.get(row.path) || 0));
      }
      // A row an expired backoff released is due NOW, whatever its cadence says. The refusal stamped its claim
      // (`lastFast`) before the pool answered - and a pass that staggered it afterwards stamped it from a second
      // when nothing was read - so the cadence gate below held it for a full interval while the 5 s retry its own
      // `deferRow` asked for was never reached. That is how a boot refusal left rows "…" and branchless.
      const retryDue = deferredUntil > 0;
      if (!retryDue && now - this.lastFast.get(key) < this.intervalFor(row) * 1000) continue;
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
    const retryAt = now + backoff;
    this.deferUntil.set(`${projectName}::${rowPath}`, retryAt);
    // The row was never read, so its ring counts to the retry rather than to a cadence it missed. `enqueueDue`
    // reads the parked deadline itself, so an expired backoff makes the row due whatever its claim says.
    this.store?.touch?.(projectName, rowPath, { nextReadAt: new Date(retryAt).toISOString() });
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
    const [heads, prs, locals] = await staggeredReads([
      () => remoteHeads(project, this.cfg.remoteCacheSeconds, this.hosts),
      () => prIndex(project, this.cfg.prCacheSeconds, this.hosts),
      () => this.projectLocals(project),
    ]);
    return { heads, prs, upstreams: locals.upstreams, remoteRefs: locals.remoteRefs };
  }

  // The LOCAL reads of the answers - a branch's upstream and the refs/remotes the last fetch left, both out of ONE
  // `for-each-ref` (branchLocals, lib/project.js) - in a worker thread whenever there is a pool: a `CreateProcess`
  // blocks the loop that starts it, which is why every `full scan:` stall of 2026-11-13 carried one to two seconds
  // of that shape and why the boot's spawn bursts lived partly here. The network half (ls-remote, the PR index)
  // stays on the loop with its own memo and host backoff - those are awaited, and their spawns are one per TTL, not
  // per read. A scheduler without a pool (a probe, a test) keeps the in-process read, like the meta job's fallback,
  // and a pool that refuses the job (queue pressure) falls back the same way rather than losing the answers.
  async projectLocals(project) {
    if (this.pool?.locals) {
      try {
        const got = await this.pool.locals(project, this.cfg.remoteCacheSeconds);
        if (got) return { upstreams: got.upstreams || null, remoteRefs: got.remoteRefs || null };
      } catch {
        /* a refused or retired job: read here rather than leave a row with no branch linkage */
      }
    }
    const { upstreams, remoteRefs } = await branchLocals(project);
    return { upstreams, remoteRefs };
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

  // The rows a boot pass read before the remote answers arrived (see fullPassProject), decorated once those
  // answers land. The pass never awaits this: what is late is the branch cell's link and the PR chip, not the row.
  //
  // Every path is re-read from the store rather than decorated from the copy the scan returned: a tick may have
  // re-read that row (or dropped its tree) while the answers were in flight, and decorating a stale copy would
  // undo the newer read or put a dropped row back on the board.
  async decorateReadRows(project, rows, answers) {
    for (const read of rows || []) {
      const cur = this.store.rows.get(this.store.rowKey(project.name, read.path));
      if (!cur) continue;
      const next = { ...cur };
      await this.decorate(project, next, answers.heads || new Set(), answers.prs || new Map(), answers.upstreams, answers.remoteRefs);
      this.store.redecorate(project.name, next);
    }
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
    const stored = this.store.putRow(project.name, row, depth);
    // The tree cache records what this read SAW: its path, branch, parent, the sha it was read at and when. A row the
    // scan could not classify (an error) is still a row, but the cache's own filter decides what is worth keeping.
    try {
      this.onRowRead?.(project.name, stored);
    } catch (e) {
      log(`tree cache: a read for ${rowPath} was not recorded (${String((e && e.message) || e)})`);
    }
    return stored;
  }
}
