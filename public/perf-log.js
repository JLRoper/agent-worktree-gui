// WHAT THE PAGE WAITED FOR, KEPT WHERE A RELOAD CANNOT LOSE IT.
//
// A panel restart reloads every open tab: the stream drops, and the page comes back by loading itself again. So a
// console that only lives in memory shows nothing of the minutes that made the restart feel slow - by the time the
// reader looks, the tab that felt it is gone. This records the boot window into a sessionStorage ring (sessionStorage
// survives reloads in the same tab) and prints one `[wag perf]` line per breach as it happens, so the evidence is in the
// reader's own console, before and after the reload.
//
// What it watches, and why each one:
//   navigation timing  - the reload itself: TTFB, first paint, DOMContentLoaded, load
//   long tasks         - the browser's own measure of "the tab could not respond": anything >= 250ms
//   /api/* fetches     - which read the page waited on, and for how long (>= 1s is printed)
//   stream open/error  - a reconnect is what a restart looks like from the page; the gap between messages is the
//                        "nothing is happening" the reader sees
//
// Nothing here talks to the server and nothing here changes behaviour: read it with `__wagPerf.summary()` in the
// console, or `__wagPerf.dump()` for the whole record.
(function () {
  const KEY = "wag.perf.v1";
  const LONG_TASK_MS = 250;
  const SLOW_API_MS = 1000;
  const KEEP_NAVIGATIONS = 4;
  const KEEP_CONSOLE = 60;

  function empty() {
    return { startedAt: Date.now(), navs: [], long: [], api: [], streams: [], errors: [] };
  }
  function load() {
    try {
      const raw = sessionStorage.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && Array.isArray(parsed.navs)) return parsed;
    } catch {
      /* a corrupt record is no record */
    }
    return empty();
  }

  const rec = load();
  let saveTimer = null;
  function save(now = false) {
    if (!now && saveTimer) return;
    if (!now) {
      saveTimer = setTimeout(() => {
        saveTimer = null;
        save(true);
      }, 1000);
      return;
    }
    try {
      sessionStorage.setItem(KEY, JSON.stringify(rec));
    } catch {
      /* a full or blocked sessionStorage costs the record, never the page */
    }
  }

  const round = (n) => Math.round(Number(n) || 0);

  // ---- the navigation this script is running inside ------------------------------------------------------------
  function recordNavigation() {
    const nav = (performance.getEntriesByType && performance.getEntriesByType("navigation")[0]) || null;
    const entry = {
      at: Date.now(),
      url: location.href,
      ttfb: nav ? round(nav.responseStart) : null,
      domReady: nav ? round(nav.domContentLoadedEventEnd) : null,
      load: nav ? round(nav.loadEventEnd) : null,
      previous: rec.navs.length ? rec.navs[rec.navs.length - 1] : null,
    };
    rec.navs.push(entry);
    while (rec.navs.length > KEEP_NAVIGATIONS) rec.navs.shift();
    const prev = entry.previous;
    if (prev) {
      const between = round(entry.at - prev.at);
      // The line a reader needs after a restart: how long the tab was away, and how long this load took to be usable.
      console.log(
        `[wag perf] reload after ${(between / 1000).toFixed(1)}s away - ttfb ${entry.ttfb}ms, first paint ${firstPaint()}ms, domReady ${entry.domReady}ms, load ${entry.load}ms`,
      );
      if (between >= 60000) console.warn(`[wag perf] the page was away for ${(between / 1000).toFixed(0)}s - that is the restart, not a slow render`);
    }
    save();
  }

  function firstPaint() {
    try {
      const paints = performance.getEntriesByType("paint") || [];
      const fcp = paints.find((p) => p.name === "first-contentful-paint") || paints[0];
      return fcp ? round(fcp.startTime) : "n/a";
    } catch {
      return "n/a";
    }
  }

  // ---- long tasks: the browser saying it could not respond ------------------------------------------------------
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const ms = round(e.duration);
        rec.long.push({ at: Date.now(), ms });
        while (rec.long.length > 200) rec.long.shift();
        if (ms >= LONG_TASK_MS) console.warn(`[wag perf] long task ${ms}ms - the tab was not answering`);
      }
      save();
    }).observe({ type: "longtask" });
  } catch {
    /* Safari and older Edge have no longtask observer; everything else here still records */
  }

  // ---- the reads the page waited on -----------------------------------------------------------------------------
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const name = String(e.name || "");
        if (!name.includes("/api/")) continue;
        const path = name.replace(location.origin, "").split("?")[0];
        const ms = round(e.duration);
        rec.api.push({ at: Date.now(), path, ms });
        while (rec.api.length > 300) rec.api.shift();
        if (ms >= SLOW_API_MS) console.warn(`[wag perf] ${path} took ${ms}ms`);
      }
      save();
    }).observe({ type: "resource" });
  } catch {
    /* no resource timing: the rest still records */
  }

  // ---- the stream: what a restart looks like from here ----------------------------------------------------------
  const NativeEventSource = window.EventSource;
  if (typeof NativeEventSource === "function") {
    function WrappedEventSource(url, config) {
      const es = new NativeEventSource(url, config);
      const row = { url: String(url || ""), at: Date.now(), opened: false, errored: false, messages: 0, lastMessageAt: 0, worstGapMs: 0 };
      rec.streams.push(row);
      while (rec.streams.length > 20) rec.streams.shift();
      es.addEventListener("open", () => {
        row.opened = true;
        save();
      });
      es.addEventListener("error", () => {
        row.errored = true;
        console.warn("[wag perf] the stream dropped - the page will reconnect");
        save();
      });
      es.addEventListener("message", () => {
        const now = Date.now();
        if (row.lastMessageAt) row.worstGapMs = Math.max(row.worstGapMs, now - row.lastMessageAt);
        row.lastMessageAt = now;
        row.messages += 1;
      });
      return es;
    }
    WrappedEventSource.prototype = NativeEventSource.prototype;
    window.EventSource = WrappedEventSource;
  }

  // ---- page errors, because a slow boot often has one behind it ------------------------------------------------
  window.addEventListener("error", (e) => {
    rec.errors.push({ at: Date.now(), text: String((e && (e.message || e.error)) || "error").slice(0, 200) });
    while (rec.errors.length > KEEP_CONSOLE) rec.errors.shift();
    save();
  });
  window.addEventListener("unhandledrejection", (e) => {
    rec.errors.push({ at: Date.now(), text: `rejection: ${String(e && e.reason).slice(0, 180)}` });
    while (rec.errors.length > KEEP_CONSOLE) rec.errors.shift();
    save();
  });
  window.addEventListener("pagehide", () => save(true));

  // ---- what the reader (or an agent) reads ---------------------------------------------------------------------
  function summary() {
    const navs = rec.navs.slice(-2);
    const longTotal = rec.long.reduce((n, x) => n + x.ms, 0);
    const worstLong = rec.long.reduce((n, x) => Math.max(n, x.ms), 0);
    const slow = rec.api.filter((x) => x.ms >= SLOW_API_MS).sort((a, b) => b.ms - a.ms).slice(0, 5);
    const streams = rec.streams.slice(-2).map((s) => ({ opened: s.opened, errored: s.errored, messages: s.messages, worstGapMs: s.worstGapMs }));
    return {
      navigations: navs,
      longTasks: rec.long.length,
      longTaskTotalMs: longTotal,
      worstLongTaskMs: worstLong,
      apiCalls: rec.api.length,
      slowestApis: slow,
      streams,
      errors: rec.errors.slice(-5),
    };
  }

  window.__wagPerf = {
    summary,
    dump: () => JSON.parse(JSON.stringify(rec)),
    clear() {
      const fresh = empty();
      Object.keys(rec).forEach((k) => delete rec[k]);
      Object.assign(rec, fresh);
      save(true);
    },
  };

  recordNavigation();
})();
