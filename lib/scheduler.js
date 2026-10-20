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
// or came back empty: a transient git hiccup must not blank the table.
import { worktreeList, projectMeta, remoteHeads, prIndex, prFor } from "./project.js";
import { gitIn, newestEditMs } from "./scan.js";
import { signalsFor, projectBoardSummary } from "./activity.js";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export class Scheduler {
  constructor({ config, store, pool, registry = null, getProjects = null, panelAgents = null }) {
    this.config = config;
    this.store = store;
    this.pool = pool;
    this.registry = registry;
    this.getProjects = getProjects || (() => config.projects || []);
    this.panelAgents = panelAgents;
    this.lastRegistry = 0;
    this.lastLive = 0;
    this.cfg = {
      worktreeSeconds: 5,
      // Liveness evidence gets its own fast tick: chips must appear and clear within seconds
      // even for a dormant worktree, which the cheaper git cadence cannot promise.
      liveSeconds: 5,
      dormantSeconds: 30,
      slowSeconds: 60,
      fetchSeconds: 600,
      prCacheSeconds: 300,
      remoteCacheSeconds: 300,
      liveMinutes: 5,
      ...config,
    };
    this.timers = [];
    this.stopped = true;
    this.projectRunning = false;
    this.liveRunning = false;
    this.lastFast = new Map(); // "project::path" -> ms of that row's last scan
    this.misses = new Map(); // "project::path" -> consecutive discovery misses
    this.lastProjectPass = new Map();
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
    };
  }

  // ---- lifecycle ---------------------------------------------------------------
  async start() {
    for (const p of this.getProjects()) this.store.ensureProject(p);
    await this.fullPass({ discover: true, fetch: true });
    this.stopped = false;
    // A single 1s tick decides what is due; there is no global pass stampede.
    this.timers.push(setInterval(() => void this.tick(), 1000));
    log(
      `scheduler started: active ${this.cfg.worktreeSeconds}s / dormant ${this.cfg.dormantSeconds}s / ` +
        `full ${this.cfg.slowSeconds}s / fetch ${this.cfg.fetchSeconds}s / pool ${this.pool.size}`,
    );
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  async tick() {
    if (this.stopped) return;
    const t0 = Date.now();
    const now = t0;
    try {
      // Projects come and go (new repos under scanRoots): re-discover on the slow cadence,
      // then work from the fresh list.
      if (this.registry && now - this.lastRegistry >= this.cfg.slowSeconds * 1000) {
        this.lastRegistry = now;
        void this.registry.refresh().catch((e) => log(`project discovery failed: ${String((e && e.message) || e)}`));
      }
      if (now - this.lastLive >= this.cfg.liveSeconds * 1000) {
        this.lastLive = now;
        void this.livenessPass();
      }
      for (const project of this.getProjects()) {
        if (now - (this.lastProjectPass.get(project.name) || 0) >= this.cfg.slowSeconds * 1000) {
          this.lastProjectPass.set(project.name, now);
          // deliberately not awaited: project meta + full scans must not block cheap scans
          void this.fullPassProject(project, { discover: true });
        }
        this.enqueueDue(project, now);
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
    try {
      await Promise.all(
        this.getProjects().map(async (project) => {
          await Promise.all(
            this.store.rowsFor(project.name).map(async (row) => {
              try {
                const files = [...(row.dirtyFiles || []).map((f) => f.path), ...(row.untrackedFiles || [])];
                const ms = await newestEditMs(row.path, files);
                let lastEdit = row.lastEdit || null;
                if (ms && (!lastEdit || ms > Date.parse(lastEdit))) lastEdit = new Date(ms).toISOString();
                const act = await signalsFor(row.path, { lastEdit, liveMinutes: live });
                const same =
                  row.live === act.live &&
                  row.idle === act.open &&
                  row.liveWhy === act.liveWhy &&
                  lastEdit === (row.lastEdit || null) &&
                  JSON.stringify(row.signals || {}) === JSON.stringify(act.signals || {});
                if (same) return;
                this.stats.livenessTouched += 1;
                this.store.touch(project.name, row.path, { live: act.live, idle: act.open, signals: act.signals, liveWhy: act.liveWhy, lastEdit });
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

  // How often this row is worth re-reading.
  intervalFor(row) {
    if (row.panelAgent?.running) return this.cfg.worktreeSeconds; // an agent is working here
    if (row.live || row.idle || row.dirty || row.untracked || row.verdictStale) return this.cfg.worktreeSeconds;
    const v = String(row.verdict || "");
    if (!v || v === "…" || v.startsWith("UNMERGED") || v.startsWith("ERROR")) return this.cfg.worktreeSeconds;
    return this.cfg.dormantSeconds; // MERGED / NO COMMITS / ON MAIN and clean
  }

  // Queue a cheap scan for every row whose own due time has come round. Not awaited here:
  // the pool bounds concurrency and refuses to duplicate a worktree.
  enqueueDue(project, now = Date.now()) {
    for (const row of this.store.rowsFor(project.name)) {
      const key = `${project.name}::${row.path}`;
      if (now - (this.lastFast.get(key) || 0) < this.intervalFor(row) * 1000) continue;
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

  async decorate(project, row, heads, prs) {
    row.pr = prFor(prs, row.branch);
    row.remoteBranch = !project.remote ? "n/a" : heads.size === 0 ? "unknown" : heads.has(row.branch) ? "exists" : "gone";
    return row;
  }

  async scanOne(project, rowPath, depth, heads, prs) {
    const row = await this.pool.run({ wtPath: rowPath, ctx: this.ctxFor(project), depth });
    if (heads || prs) await this.decorate(project, row, heads || new Set(), prs || new Map());

    // Liveness is a composite: files / hermes session / board PID / listening port.
    // The worker's own `live` (recent edit) is replaced by the aggregate, and the
    // sources that fired are named so the UI can show which evidence it has.
    try {
      const act = await signalsFor(rowPath, { lastEdit: row.lastEdit, liveMinutes: this.cfg.liveMinutes });
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
            row.liveWhy = `${row.liveWhy ? `${row.liveWhy} ` : ""}panel-agent(${mine.running})`;
          }
        }
      } catch {
        /* the mapping is best-effort */
      }
    }

    return this.store.putRow(project.name, row, depth);
  }

  // ---- passes ------------------------------------------------------------------
  // Cheap-only pass over every row (used by the Refresh now button).
  async fastPass() {
    const t0 = Date.now();
    for (const project of this.getProjects()) {
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
      const [heads, prs] = await Promise.all([remoteHeads(project, this.cfg.remoteCacheSeconds), prIndex(project, this.cfg.prCacheSeconds)]);
      await this.scanOne(project, rowPath, "full", heads, prs);
    } catch (e) {
      this.store.markError(project.name, rowPath, e);
    } finally {
      this.queuedFull.delete(key);
    }
  }

  async fullPassProject(project, { discover = false, fetch = false } = {}) {
    if (this.projectRunning) return;
    this.projectRunning = true;
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

      const [heads, prs] = await Promise.all([remoteHeads(project, this.cfg.remoteCacheSeconds), prIndex(project, this.cfg.prCacheSeconds)]);
      await Promise.all(
        this.store.rowsFor(project.name).map(async (r) => {
          try {
            await this.scanOne(project, r.path, "full", heads, prs);
            this.stats.rowScans += 1;
          } catch (e) {
            this.store.markError(project.name, r.path, e);
          }
        }),
      );
      this.stats.fullPasses += 1;
      this.stats.lastFullMs = Date.now() - t0;
      this.stats.lastFullAt = new Date().toISOString();
    } catch (e) {
      this.store.patchProject(project.name, { error: String((e && e.message) || e) });
    } finally {
      this.projectRunning = false;
    }
  }

  async fullPass({ discover = false, fetch = false } = {}) {
    for (const project of this.getProjects()) await this.fullPassProject(project, { discover, fetch });
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
      const n = (this.misses.get(key) || 0) + 1;
      this.misses.set(key, n);
      if (n >= 2) {
        log(`worktree gone (absent from ${n} consecutive listings): ${r.path}`);
        this.misses.delete(key);
        this.lastFast.delete(key);
        this.store.dropRow(project.name, r.path);
      } else {
        log(`worktree not listed this pass (1/2) — keeping: ${r.path}`);
      }
    }
    this.store.patchProject(project.name, { discoveryNote: null });
  }

  async maybeFetch(project, force = false) {
    if (!project.remote) return; // local-only repo: nothing to fetch
    const age = Date.now() - (this.lastFetch.get(project.path) || 0);
    const want = force ? this.cfg.fetchSeconds >= 0 : this.cfg.fetchSeconds === 0 || age >= this.cfg.fetchSeconds * 1000;
    if (!want) return;
    const r = await gitIn(project.path, ["fetch", project.remote, "--prune"], 180000);
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

  async fetchPass() {
    for (const project of this.getProjects()) {
      const age = Date.now() - (this.lastFetch.get(project.path) || 0);
      if (this.cfg.fetchSeconds === 0 || age >= this.cfg.fetchSeconds * 1000) await this.maybeFetch(project);
    }
  }
}
