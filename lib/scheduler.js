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
// Row lifetimes are sticky. A worktree is dropped only after `git worktree list` has failed
// to mention it on two consecutive discovery passes, and never when that call itself failed
// or came back empty: a transient git hiccup must not blank the table. The one exception is a
// row that is no longer a worktree at all — its folder gone, or the folder there without a `.git`
// entry — which is not a hiccup, and waiting out a second pass is what kept a failed delete's ghost
// on the board as a worktree with no branch.
import { stat } from "node:fs/promises";
import path from "node:path";
import { worktreeList, projectMeta, remoteHeads, prIndex, prFor, branchUpstreams, remoteTrackedBranches, branchLink } from "./project.js";
import { gitIn, newestEditMs, outsideNestedWorktrees } from "./scan.js";
import { signalsFor, projectBoardSummary, hermesSessionRoots, claudeSessionRoots } from "./activity.js";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
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

export class Scheduler {
  constructor({ config, store, pool, registry = null, getProjects = null, panelAgents = null, panelThreads = null }) {
    this.config = config;
    this.store = store;
    this.pool = pool;
    this.registry = registry;
    this.getProjects = getProjects || (() => config.projects || []);
    this.panelAgents = panelAgents;
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
      // `git worktree list` per project is the expensive half of a full pass and its answer changes
      // rarely: run it on its own, much slower cadence instead of on every pass.
      discoverSeconds: 900,
      // Re-walking scanRoots and probing every repo (`git worktree list` per project) is minutes of git
      // work for an answer that changes when a repo is created - its own, slower clock.
      registrySeconds: 900,
      fetchSeconds: 600,
      prCacheSeconds: 300,
      remoteCacheSeconds: 300,
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
    this.misses = new Map(); // "project::path" -> consecutive discovery misses
    this.lastProjectPass = new Map();
    // Which projects the page says it can see, and when it said so. Only used when scanMode is "visible"; a report
    // older than VISIBLE_TTL_MS means no browser is watching, and the fleet is read as before rather than frozen.
    this.visible = new Set();
    this.visibleAt = 0;
    // When each project was last in a visibility report, so a repaint that momentarily drops a project does not
    // count as it "arriving" and re-queue its whole pass.
    this.visibleSeenAt = new Map();
    this.lastDiscover = new Map(); // project name -> ms of its last worktree discovery
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
      lastTickMs: null,
      lastTickAt: null,
      lastFastMs: null,
      lastFullMs: null,
      lastFastAt: null,
      lastFullAt: null,
      inFlight: 0,
    };
  }

  ctxFor(project) {
    return {
      // No remote (a local-only repo): compare against its own main branch rather than a
      // <remote>/<branch> ref that does not exist.
      remoteRef: project.remote ? `${project.remote}/${project.mainBranch}` : project.mainBranch || null,
      mainBranch: project.mainBranch,
      liveMinutes: this.cfg.liveMinutes,
      // Every worktree of this project, so a scan can ignore files that actually belong to a nested
      // one: the parent's `git status` lists them, and they are not the parent's work.
      nested: this.store.rowsFor(project.name).map((r) => r.path),
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
    await this.fullPass({ discover: true, fetch: false, rows: this.cfg.scanMode !== "visible" });
    this.stopped = false;
    // A single 1s tick decides what is due; there is no global pass stampede.
    this.timers.push(setInterval(() => void this.tick(), 1000));
    log(
      `scheduler started: active ${this.cfg.worktreeSeconds}s / mid ${this.cfg.midSeconds}s / dormant ${this.cfg.dormantSeconds}s / ` +
        `full ${this.cfg.slowSeconds}s / fetch ${this.cfg.fetchSeconds}s / pool ${this.pool.size}`,
    );
    // Remotes catch up in the background so the board is up first, accurate second.
    void this.fetchPass().catch((err) => log(`background fetch pass failed: ${err.message}`));
  }

  stop() {
    this.stopped = true;
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

  async tick() {
    if (this.stopped) return;
    const t0 = Date.now();
    const now = t0;
    try {
      // Projects come and go (new repos under scanRoots): re-discover on the slow cadence,
      // then work from the fresh list.
      if (this.registry && now - this.lastRegistry >= this.cfg.registrySeconds * 1000) {
        this.lastRegistry = now;
        void this.registry.refresh().catch((e) => log(`project discovery failed: ${String((e && e.message) || e)}`));
      }
      if (now - this.lastLive >= this.cfg.liveSeconds * 1000) {
        this.lastLive = now;
        void this.livenessPass();
      }
      // In "visible" mode only the projects the page can see are read. Everything else keeps its last-known rows:
      // nothing is looked at, so nothing about it has to be fresh - and with ~100 projects that is most of the git
      // the board spawns.
      const projects = this.getProjects().filter((p) => this.isProjectVisible(p.name));
      // Cheap per-row work first: it is what keeps the board live, and it must not wait behind a
      // project pass.
      for (const project of projects) this.enqueueDue(project, now);
      // Full passes are staggered. Every project used to become due in the same tick (they were all
      // stamped together at boot), so ~100 deep scans started at once and starved the main thread -
      // the requests the page makes during that window queued for seconds. Seed each project's first
      // due time somewhere at random inside the window, then start only as many as the cap allows.
      if (!this.passesSeeded) {
        this.passesSeeded = true;
        const span = Math.max(1000, this.cfg.slowSeconds * 1000);
        for (const project of projects) {
          this.lastProjectPass.set(project.name, now - Math.floor(Math.random() * span));
        }
      }
      const cap = Math.max(1, Number(this.cfg.fullPassConcurrency) || 1);
      let started = 0;
      for (const project of projects) {
        if (started >= cap || this.projectRunning.size >= cap) break;
        if (now - (this.lastProjectPass.get(project.name) || 0) < this.cfg.slowSeconds * 1000) continue;
        this.lastProjectPass.set(project.name, now);
        started += 1;
        // deliberately not awaited: project meta + full scans must not block cheap scans
        const discover = now - (this.lastDiscover.get(project.name) || 0) >= this.cfg.discoverSeconds * 1000;
        if (discover) this.lastDiscover.set(project.name, now);
        void this.fullPassProject(project, { discover });
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
    const roots = await this.sessionRoots();
    const claudeByRoot = await this.claudeRoots();
    try {
      const visible = this.getProjects().filter((p) => this.isProjectVisible(p.name));
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
    } catch {
      this._sessionRoots = this._sessionRoots || new Map();
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
    const rows = this.store.rowsFor(project.name);
    const slot = tierSlots(rows, (r) => this.intervalFor(r));
    for (const row of rows) {
      const key = `${project.name}::${row.path}`;
      if (!this.lastFast.has(key)) {
        // A row this process has never read is clocked at its own slot, not at "now": every row used to
        // come due in the same tick (an empty map reads as 0), so the rings of one tier drained and
        // refilled in lockstep and the column looked like one animation copied down it.
        this.lastFast.set(key, now - (slot.get(row.path) || 0));
      }
      if (now - this.lastFast.get(key) < this.intervalFor(row) * 1000) continue;
      if (this.pool.isBusy(row.path)) continue; // already being read
      // Claim the slot before the await so a slow scan is not re-queued every tick.
      this.lastFast.set(key, now);
      void this.scanRow(project, row);
    }
  }

  async scanRow(project, row) {
    try {
      const merged = await this.scanOne(project, row.path, "fast");
      this.stats.rowScans += 1;
      if (merged.verdictStale) await this.fullScan(project, merged.path);
    } catch (e) {
      this.store.markError(project.name, row.path, e);
    }
  }

  async decorate(project, row, heads, prs, upstreams = null, remoteRefs = null) {
    // The row's own tip goes in with the branch: a PR found by the tree's tag is only that row's PR while the
    // tree still carries the commit the PR was opened on (see prFor).
    row.pr = prFor(prs, row.branch, { upstream: upstreams?.get(row.branch) || null, tip: row.head, base: project.mainBranch });
    row.remoteBranch = !project.remote ? "n/a" : heads.size === 0 ? "unknown" : heads.has(row.branch) ? "exists" : "gone";
    // The branch cell is a link to the branch on the remote when the remote actually has it, and plain text with a
    // reason when it does not. Computed HERE, from the row's own fields, so the client holds no URL policy and one
    // test can check the shape without a browser: `branchUrl` is null unless a page is certain to exist, and
    // `branchWhy` is the sentence the cell's title carries. `remoteRefs` (the last fetch's refs/remotes/<remote>/…,
    // read once per project, no network) is only the fallback for the case `ls-remote` could not answer.
    const link = branchLink({ project, row, offline: remoteRefs });
    row.branchUrl = link.url || null;
    row.branchWhy = link.url ? "" : link.why;
    row.branchLinkFrom = link.url ? (String(row.remoteBranch) === "exists" ? "remote" : "local-refs") : null;
    return row;
  }

  async scanOne(project, rowPath, depth, heads, prs, upstreams = null, remoteRefs = null) {
    const row = await this.pool.run({ wtPath: rowPath, ctx: this.ctxFor(project), depth });
    if (heads || prs) await this.decorate(project, row, heads || new Set(), prs || new Map(), upstreams, remoteRefs);

    // Liveness is a composite: files / hermes session / board PID / listening port.
    // The worker's own `live` (recent edit) is replaced by the aggregate, and the
    // sources that fired are named so the UI can show which evidence it has.
    try {
      const act = await signalsFor(rowPath, { lastEdit: row.lastEdit, liveMinutes: this.cfg.liveMinutes, sessionsByRoot: await this.sessionRoots(), claudeByRoot: await this.claudeRoots() });
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
    const prevRow = this.store.rowsFor(project.name).find((r) => norm(r.path) === norm(rowPath));
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

  async fullScan(project, rowPath) {
    const key = `${project.name}::${rowPath}`;
    if (this.queuedFull.has(key) || this.pool.isBusy(rowPath)) return;
    this.queuedFull.add(key);
    try {
      const [heads, prs, upstreams, remoteRefs] = await Promise.all([
        remoteHeads(project, this.cfg.remoteCacheSeconds),
        prIndex(project, this.cfg.prCacheSeconds),
        branchUpstreams(project),
        // The offline half of "does the remote have this branch": one for-each-ref per project, memoised, and only
        // consulted when `ls-remote` could not answer. No network call is added to the scan path.
        remoteTrackedBranches(project, this.cfg.remoteCacheSeconds),
      ]);
      await this.scanOne(project, rowPath, "full", heads, prs, upstreams, remoteRefs);
    } catch (e) {
      this.store.markError(project.name, rowPath, e);
    } finally {
      this.queuedFull.delete(key);
    }
  }

  async fullPassProject(project, { discover = false, fetch = false, rows = true } = {}) {
    if (this.projectRunning.has(project.name)) return;
    this.projectRunning.add(project.name);
    const t0 = Date.now();
    try {
      if (fetch) await this.maybeFetch(project, true);

      this.store.patchProject(project.name, await projectMeta(project));

      // The coordination board lives at the checkout root, not per worktree, so its claim
      // is a project-level statement (per-worktree evidence is the session store and the
      // declared dev port).
      try {
        this.store.patchProject(project.name, { board: await projectBoardSummary(project.path) });
      } catch {
        /* board is optional */
      }

      if (discover) await this.discover(project);

      // `rows: false` is the boot pass in "visible" mode: it maps what exists (projects, worktrees, headers) and
      // leaves the per-row git reads to the page's first visibility report. Those rows still carry their last-known
      // values, and the ones on screen are read within a second of the page saying so.
      if (rows) {
        const [heads, prs, upstreams] = await Promise.all([
          remoteHeads(project, this.cfg.remoteCacheSeconds),
          prIndex(project, this.cfg.prCacheSeconds),
          branchUpstreams(project),
        ]);
        await Promise.all(
          this.store.rowsFor(project.name).map(async (r) => {
            try {
              await this.scanOne(project, r.path, "full", heads, prs, upstreams);
              // Stamp the row as read. Without this the first tick after boot sees every row as
              // never-scanned and re-enqueues the whole fleet the pass just read -- a redundant
              // burst that leaves the board stale exactly when it finally came up.
              this.lastFast.set(`${project.name}::${r.path}`, Date.now());
              this.stats.rowScans += 1;
            } catch (e) {
              this.store.markError(project.name, r.path, e);
            }
          }),
        );
        // The pass read every row within the same few seconds, which would put a tier back in lockstep;
        // hand each one its own slot now that the verdicts (and so the cadences) are in.
        this.dueAfter(project.name, this.store.rowsFor(project.name));
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

  async fullPass({ discover = false, fetch = false, rows = true } = {}) {
    // Bounded parallelism, not a serial await: 94 projects at ~5s each is an eight-minute boot when
    // done one at a time, and that whole window is the board showing stale rows. Wider than this
    // and boot competes with the row scans for git.
    const projects = this.getProjects();
    const width = Math.max(1, Math.min(Number(this.cfg.threads) || 4, 8));
    let next = 0;
    const lane = async () => {
      while (next < projects.length) {
        const project = projects[next++];
        try {
          await this.fullPassProject(project, { discover, fetch, rows });
        } catch (err) {
          log(`full pass failed for ${project.name}: ${(err && err.message) || err}`);
        }
      }
    };
    await Promise.all(Array.from({ length: width }, lane));
  }

  // Add new worktrees, and retire rows only when they are genuinely gone: the listing must
  // have succeeded and omitted this worktree twice in a row.
  async discover(project) {
    let wts = null;
    try {
      wts = (await worktreeList(project.path)).map((w) => w.path);
    } catch (e) {
      this.store.patchProject(project.name, { discoveryNote: `worktree list failed — keeping rows (${String((e && e.message) || e).slice(0, 90)})` });
      return;
    }
    const held = this.store.rowsFor(project.name).length;
    if (!wts.length && held) {
      this.store.patchProject(project.name, { discoveryNote: `worktree list came back empty — keeping ${held} row(s)` });
      return;
    }

    const live = new Set(wts.map(norm));
    for (const w of wts) {
      const known = this.store.rowsFor(project.name).some((r) => norm(r.path) === norm(w));
      if (!known) {
        log(`new worktree detected: ${w}`);
        this.store.putRow(project.name, { path: w.replace(/\\/g, "/"), name: w.split(/[\\/]/).pop(), verdict: "…" }, "fast", { force: true });
      }
    }

    for (const r of this.store.rowsFor(project.name)) {
      const key = `${project.name}::${r.path}`;
      if (live.has(norm(r.path))) {
        this.misses.delete(key);
        continue;
      }
      // A row that is no longer a worktree needs no second opinion. Either its folder is gone, or the folder is
      // there but has no `.git` entry — git answered a successful listing without it, so it is not a worktree any
      // more, and waiting out another pass is what kept a failed delete's ghost on the board with no branch. A
      // folder that still HAS its `.git` but is missing from the listing keeps the two-pass rule: that is the
      // shape a git hiccup takes.
      const onDisk = await stat(r.path).then(() => true).catch(() => false);
      const isTree = onDisk && (await stat(path.join(r.path, ".git")).then(() => true).catch(() => false));
      const gone = !isTree;
      const n = gone ? 2 : (this.misses.get(key) || 0) + 1;
      this.misses.set(key, n);
      if (n >= 2) {
        log(`worktree gone (${gone ? (onDisk ? "its folder is no longer a worktree" : "its folder is gone") : `absent from ${n} consecutive listings`}): ${r.path}`);
        this.misses.delete(key);
        this.lastFast.delete(key);
        this.store.dropRow(project.name, r.path);
      } else {
        log(`worktree not listed this pass (1/2) — keeping: ${r.path}`);
      }
    }
    this.store.patchProject(project.name, { discoveryNote: null });
  }

  // A `-w` spawn created a worktree the panel has not seen yet. Add its row immediately and read it,
  // instead of waiting for the next discovery pass (slowSeconds can be minutes away) — otherwise the
  // agent sits in the unattached list while the tree it owns exists on disk.
  async adoptWorktree(projectName, worktreePath) {
    const project = this.getProjects().find((p) => p.name === projectName);
    if (!project || !worktreePath) return false;
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
    // 20 s, not 180: a remote that cannot be reached is not worth stalling the pass for. gitIn also
    // disables every interactive prompt, so the common case (private repo, no cached credential) fails
    // in well under a second instead of blocking on a hidden password prompt.
    const r = await gitIn(project.path, ["fetch", project.remote, "--prune", "--no-tags"], 20000);
    if (r.ok) {
      this.lastFetch.set(project.path, Date.now());
      this.stats.fetches += 1;
      this.store.patchProject(project.name, { fetchedAt: new Date(this.lastFetch.get(project.path)).toISOString(), fetchNote: null });
      log(`fetched ${project.remote} for ${project.name}`);
    } else {
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
