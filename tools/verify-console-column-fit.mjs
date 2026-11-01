// Does measuring the worktree table's columns move the consoles inside it?
//
//   node tools/verify-console-column-fit.mjs                # the direct check + a 30 s window of the board's own clocks
//   node tools/verify-console-column-fit.mjs --seconds 60   # a longer window
//   node tools/verify-console-column-fit.mjs --root <dir>   # serve another checkout (a `git archive` export of the base)
//   node tools/verify-console-column-fit.mjs --headed       # a window instead of headless Chromium
//   node tools/verify-console-column-fit.mjs --json <file>  # keep the raw ledger
//
// THE REPORT. "The console keeps bouncing up and quickly back down in a split second" while an agent writes, and "when
// I scroll back to read, it loses my place and jumps somewhere else in the scrollbar". Neither had a writer: no
// scrollTop assignment, no DOM move carrying the console and no mutation inside it explained the falls
// (docs/console-frames-7393-0461.md, "the no-writer class").
//
// THE MECHANISM UNDER TEST. Every row repaint ends in scheduleColumnFit(), and fitColumns() asks naturalColumnWidths()
// what each column would be with nothing constraining it. That function used to lay the LIVE table out at
// `table-layout: auto; width: max-content` for one synchronous step. The table's detail rows hold the agent cards, and
// a `white-space: pre-wrap` transcript at max-content has no line breaks at all: a paragraph that wraps across five
// lines is one line, so every console in the table was a fraction of its height for that one layout. The browser
// clamps a scroll offset that no longer fits, the styles go back, the transcript is tall again - and the offset is
// not: a console following its run is painted near its first lines until the next streamed line or the 400 ms sweep
// puts it back (the bounce), and a console the reader parked stays wherever the clamp left it (the lost place). A stub
// that streams short lines cannot show it, because a short line is already its own max-content width: the fixture
// below streams the long paragraphs a real agent writes.
//
// WHAT IS DRIVEN (nothing synthetic reaches the page): a throwaway panel of its own (tools/panel-testkit.mjs: spare port,
// own PANEL_CONFIG / HERMES_HOME / jobs.json, API_SERVER_KEY empty) serving the chosen checkout; a stub Runs API that
// plays long paragraphs over real SSE; two cards spawned through the panel's own POST /api/agents into one worktree
// row; the row opened the way the reader opens it. One console is left following its run, the other is parked by the
// reader with a real wheel. The window runs the board's own clocks, plus a file written into the worktree every 3 s so
// the row really is repainted (that is the reader's own board: an agent writing files).
//
// WHAT IT ASSERTS
//   (1) direct: fitColumns() on the open table, called three times between frames, moves no console - the following
//       one stays on its newest line, the parked one on the reader's line;
//   (2) window: no frame paints the following console more than OFF_PX above its newest line, and the parked console
//       never leaves the reader's line without input;
//   (3) the run measured something: the consoles had scrollback, the park was recorded by the page, the board measured
//       its columns at least 3 times in the window, and a planted fall is seen by the recorder (its sensitivity).
//
// Exit codes: 0 held; 1 a console moved; 2 the run did not measure what it claims.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright, notRun } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SECONDS = Number(opt("--seconds", 30));
const JSON_OUT = opt("--json");
const HEADLESS = !argv.includes("--headed");
// A following console may sit up to a line behind a growing row for a frame (the stick lands on the next one). More
// than two lines above its newest line is not lag: it is the console painted somewhere it was never asked to be.
const OFF_PX = 40;
const NEED_DEPTH = 600; // px of scrollback before a console is a fair test: a clamp needs somewhere to fall from
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[column-fit]", ...a);

// ---- the stub Hermes gateway: long paragraphs, the way an agent writes, over real SSE --------------------------------
const VOCAB = `the console follows its newest line while the agent writes and a reader who scrolls back keeps their place
measuring columns lays the table out at its natural width which is wider than the card so every paragraph unwraps
a transcript is not a column and its width should never be shared out over the cells of the row above it
the browser clamps a scroll offset that no longer fits and nothing remembers what it was before the clamp
analysis reasoning implementation verification regression measurement instrumentation repository worktree
gateway scheduler renderer pacer anchor rebuild detail signature selection approval subagent deliverable`
  .split(/\s+/)
  .filter(Boolean);

function paragraphs(seed, lenMs, wordMs) {
  const out = [];
  let t = 300;
  let x = seed * 7919 + 17;
  const rnd = () => {
    x = (Math.imul(x, 69069) + 1) >>> 0; // a 32-bit LCG: the same paragraphs on every run
    return x / 2 ** 32;
  };
  while (t < lenMs) {
    const words = 70 + Math.floor(rnd() * 60);
    for (let i = 0; i < words && t < lenMs; i++) {
      const w = VOCAB[Math.floor(rnd() * VOCAB.length)];
      const end = i === words - 1 ? ".\n\n" : " ";
      out.push({ at: t, evt: { event: "message.delta", delta: `${i === 0 ? w[0].toUpperCase() + w.slice(1) : w}${end}` } });
      t += wordMs;
    }
  }
  return out;
}

function makeGateway(lenMs) {
  const runs = new Map();
  let posts = 0;
  const timers = new Set();
  const later = (ms, fn) => {
    const h = setTimeout(() => {
      timers.delete(h);
      fn();
    }, Math.max(0, ms));
    timers.add(h);
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/v1/capabilities") {
      return json(200, { version: "column-fit-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true } });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      req.resume();
      req.on("end", () => {
        posts += 1;
        const id = `run_colfit_${posts}`;
        runs.set(id, { id, startedAt: null, script: paragraphs(posts, lenMs, 22) });
        json(200, { run_id: id, status: "running" });
      });
      return;
    }
    const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const rec = runs.get(one[1]);
      if (!rec) return json(404, { error: { message: "Run not found", code: "run_not_found" } });
      return json(200, { run_id: rec.id, status: "running", output: "", usage: { total_tokens: 9000, input_tokens: 8100, output_tokens: 900 } });
    }
    const ev = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (ev && req.method === "GET") {
      const rec = runs.get(ev[1]);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      if (!rec) return res.end();
      res.write(": open\n\n");
      if (rec.startedAt == null) rec.startedAt = Date.now();
      let open = true;
      req.on("close", () => {
        open = false;
      });
      rec.script.forEach((step, i) => {
        later(rec.startedAt + step.at - Date.now(), () => {
          if (open) res.write(`id: ${i}\ndata: ${JSON.stringify({ ...step.evt, run_id: rec.id, seq: i, timestamp: Date.now() / 1000 })}\n\n`);
        });
      });
      return;
    }
    json(404, {});
  });
  return {
    listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))),
    close: () =>
      new Promise((r) => {
        for (const h of timers) clearTimeout(h);
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

// ---- the page-side recorder -------------------------------------------------------------------------------------------
function pageInit(o) {
  const T0 = performance.now();
  const now = () => Math.round((performance.now() - T0) * 10) / 10;
  const R = { frames: 0, reads: 0, armed: false, stopped: false, inputAt: -1e9, offTail: [], gaps: [], park: null, parkMoves: [], fits: [], writes: [], errors: [] };
  window.__rec = R;
  window.__now = now;
  window.addEventListener("error", (e) => R.errors.push(String((e && e.message) || e)));
  window.addEventListener("unhandledrejection", (e) => R.errors.push(`unhandledrejection: ${String((e && e.reason && (e.reason.message || e.reason)) || "")}`));
  for (const ev of ["wheel", "mousedown", "pointerdown", "keydown", "touchstart"]) {
    document.addEventListener(ev, () => (R.inputAt = now()), { capture: true, passive: true });
  }
  const pinOf = (id) => {
    try {
      // eslint-disable-next-line no-undef
      return state.outPinned[id] !== false;
    } catch {
      return true;
    }
  };
  // What a frame PAINTED: a timeout queued from the frame's own rAF callback runs after that frame's rendering, so its
  // read is the value on screen, not the value a callback later in the same frame might still change.
  const read = () => {
    if (R.stopped) return;
    R.reads += 1;
    const t = now();
    for (const el of document.querySelectorAll("pre.job-out")) {
      const id = el.dataset.out || "";
      if (!id || id.endsWith("@pin")) continue;
      const top = Math.round(el.scrollTop);
      const max = Math.round(el.scrollHeight - el.clientHeight);
      if (max <= 20 || !R.armed) continue;
      if (R.park && id === R.park.id) {
        if (Math.abs(top - R.park.top) > 2 && t - R.inputAt > 1500) {
          R.parkMoves.push({ t, top, max, from: R.park.top });
          R.park.top = top; // one record per move, not one per frame it stays moved
        }
        continue;
      }
      if (!pinOf(id)) continue;
      const gap = max - top;
      R.gaps.push(gap);
      if (gap > o.offPx) R.offTail.push({ t, id, top, max, gap });
    }
  };
  const tick = () => {
    if (R.stopped) return;
    R.frames += 1;
    setTimeout(read, 0);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // After app.js has parsed: its top-level functions are properties of the global object, and the page's own calls
  // resolve through that property, so these wrappers count the page's calls (an init script cannot do it - the
  // script's declarations replace whatever was assigned before it ran).
  window.__instrument = () => {
    const orig = window.naturalColumnWidths;
    if (typeof orig !== "function" || orig.__w) return false;
    const w = function (table) {
      const boxes = table ? [...table.querySelectorAll("pre.job-out")].map((el) => ({ el, id: el.dataset.out || "", top: el.scrollTop, max: el.scrollHeight - el.clientHeight })) : [];
      const r = orig.apply(this, arguments);
      if (R.armed) {
        R.fits.push({
          t: now(),
          boxes: boxes.map((b) => ({ id: b.id, before: Math.round(b.top), after: Math.round(b.el.scrollTop), maxBefore: Math.round(b.max), maxAfter: Math.round(b.el.scrollHeight - b.el.clientHeight) })),
        });
      }
      return r;
    };
    w.__w = true;
    window.naturalColumnWidths = w;
    // Every write the panel makes to the parked console, with the page function that asked for it: a parked line that
    // moves with a write is a restore, one that moves with none is a clamp.
    const set = window.setScroll;
    if (typeof set === "function" && !set.__w) {
      const ws = function (el, top) {
        const watch = R.armed && R.park && el && el.dataset && el.dataset.out === R.park.id;
        const from = watch ? Math.round(el.scrollTop) : 0;
        const r = set.apply(this, arguments);
        if (watch) {
          const landed = Math.round(el.scrollTop);
          if (Math.abs(landed - from) > 2 && R.writes.length < 400) {
            const by = String(new Error().stack || "").split("\n").slice(2, 5).map((l) => (/at\s+(\S+)/.exec(l) || [])[1] || "?").join(" < ");
            R.writes.push({ t: now(), from, asked: Math.round(Number(top) || 0), landed, by });
          }
        }
        return r;
      };
      ws.__w = true;
      window.setScroll = ws;
    }
    return true;
  };
}

// ---- main ----------------------------------------------------------------------------------------------------------
const pw = loadPlaywright({ root: TREE });
if (!pw) {
  console.log(notRun("tools/verify-console-column-fit.mjs", "Playwright is not installed here (set PANEL_PLAYWRIGHT_ROOT to a directory that has node_modules/playwright)"));
  process.exit(2);
}
const { startPanel, git } = await import(pathToFileURL(path.join(TREE, "tools", "panel-testkit.mjs")).href);
const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

const work = mkdtempSync(path.join(os.tmpdir(), "wtgui-colfit-"));
const root = path.join(work, "rootA");
const repo = path.join(root, "alpha");
mkdirSync(repo, { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# alpha\n");
git(repo, ["add", "."]);
git(repo, ["commit", "-q", "-m", "first"]);
const tree = path.join(repo, ".worktrees", "feature-a");
git(repo, ["worktree", "add", "-q", "-b", "feature-a", tree]);

const out = { tree: TREE, seconds: SECONDS, failures: [], notMeasured: [], direct: [], errors: [] };
const gw = makeGateway(600_000);
const gwPort = await gw.listen();
const sandbox = await startPanel({
  dir: work,
  config: {
    scanRoots: [root],
    projects: [],
    refreshSeconds: 30,
    worktreeSeconds: 5,
    midSeconds: 45,
    dormantSeconds: 90,
    liveSeconds: 5,
    slowSeconds: 300,
    fetchSeconds: -1,
    assistant: { enabled: false },
    remoteBranchPolicy: "local-only",
    defaultCwd: root,
    apiServer: { url: `http://127.0.0.1:${gwPort}`, key: "probe" },
  },
  env: { API_SERVER_KEY: "" },
});
const browser = await pw.chromium.launch({
  headless: HEADLESS,
  args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
});
let touch = null;
try {
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
  page.on("pageerror", (e) => out.errors.push(String((e && e.message) || e).slice(0, 200)));
  await page.addInitScript(pageInit, { offPx: OFF_PX });
  await page.goto(sandbox.base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof state !== "undefined" && state.rows && state.jobs, null, { timeout: 30_000 });
  await page.waitForFunction(() => [...state.projects.keys()].includes("alpha"), null, { timeout: 60_000 });
  await page.waitForFunction((want) => [...state.rows.values()].some((r) => r.project === "alpha" && String(r.path || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === want), norm(tree), { timeout: 60_000 });
  if (!(await page.evaluate(() => window.__instrument()))) out.notMeasured.push("naturalColumnWidths / setScroll are not page functions here, so nothing could be wrapped");

  const threads = ["colfit-follow", "colfit-park"];
  for (const thread of threads) {
    const r = await fetch(`${sandbox.base}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: `probe: write long paragraphs (${thread})`, cwd: tree, existing: true, thread }),
    }).then((x) => x.json());
    if (!r || !r.job) throw new Error(`spawn failed: ${JSON.stringify(r).slice(0, 300)}`);
  }
  await page.waitForFunction((ts) => ts.every((t) => [...state.jobs.values()].some((j) => (j.thread || j.id) === t)), threads, { timeout: 60_000 });
  // The reader has the project and the row open: that is what a console on screen means.
  await page.evaluate((want) => {
    const row = [...state.rows.values()].find((r) => r.project === "alpha" && String(r.path || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === want);
    state.expandedProjects.add("alpha");
    state.expanded.add(`alpha::${row.path}`);
    renderAll();
  }, norm(tree));
  for (const t of threads) await page.waitForSelector(`.job[data-thread="${t}"] pre.job-out`, { timeout: 45_000 });
  const outOf = (thread) => page.evaluate((t) => document.querySelector(`.job[data-thread="${t}"] pre.job-out`)?.dataset.out || null, thread);
  const ids = { follow: await outOf(threads[0]), park: await outOf(threads[1]) };
  out.ids = ids;
  log(`cards up (${ids.follow}, ${ids.park}); waiting for ${NEED_DEPTH} px of scrollback`);
  const deep = await page
    .waitForFunction(
      ({ ids, need }) => Object.values(ids).every((id) => {
        const el = document.querySelector(`pre.job-out[data-out="${id}"]`);
        return el && el.scrollHeight - el.clientHeight >= need;
      }),
      { ids, need: NEED_DEPTH },
      { timeout: 180_000, polling: 500 },
    )
    .then(() => true)
    .catch(() => false);
  if (!deep) {
    out.notMeasured.push(`the consoles never reached ${NEED_DEPTH} px of scrollback`);
    throw new Error("not deep");
  }
  // The table this is all about, and the mode it is in: a chart narrower than its columns' floors scrolls sideways and
  // pins the detail to the visible width, which is a different layout from the desktop one under test.
  out.table = await page.evaluate(() => {
    const t = document.querySelector('section.project[data-project="alpha"] > .wt-scroll > table');
    const wrap = t && t.parentElement;
    return t ? { width: Math.round(t.getBoundingClientRect().width), scrollMode: Boolean(wrap && wrap.classList.contains("is-scroll")), ths: [...t.tHead.rows[0].cells].map((th) => Math.round(th.getBoundingClientRect().width)) } : null;
  });

  // ---- the reader parks one console with a real wheel ----
  for (let attempt = 0; attempt < 6; attempt++) {
    const spot = await page.evaluate((id) => {
      const el = document.querySelector(`pre.job-out[data-out="${id}"]`);
      if (!el) return null;
      el.closest(".job").scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      const max = el.scrollHeight - el.clientHeight;
      return { x: Math.round(r.x + r.width * 0.4), y: Math.round(r.y + r.height * 0.6), top: Math.round(el.scrollTop), max: Math.round(max) };
    }, ids.park);
    if (!spot) break;
    await page.mouse.move(spot.x, spot.y);
    // 40% of the way up its scrollback on the first try - deep enough that a box clamped to a fraction of its height
    // has to move it - and a few px more on each retry, so a fresh scroll event fires.
    const dy = attempt === 0 ? Math.round(spot.max * 0.4) : 6;
    await page.mouse.wheel(0, -dy);
    await sleep(500);
    const held = await page.evaluate((id) => {
      const el = document.querySelector(`pre.job-out[data-out="${id}"]`);
      const rec = state.outScrolls[id];
      return { top: Math.round(el.scrollTop), max: Math.round(el.scrollHeight - el.clientHeight), pin: state.outPinned[id], record: rec ? { top: Math.round(rec.top), atBottom: rec.atBottom } : null };
    }, ids.park);
    out.parkAttempts = (out.parkAttempts || 0) + 1;
    out.park = held;
    (out.parkLog = out.parkLog || []).push({ from: spot.top, dy, ...held });
    if (held.pin === false && held.record && held.record.atBottom === false && Math.abs(held.record.top - held.top) <= 2 && held.top >= 60) break;
  }
  const p = out.park;
  if (!p || p.pin !== false || !p.record || p.record.atBottom !== false || Math.abs(p.record.top - p.top) > 2) {
    out.notMeasured.push(`the reader's park was not recorded by the page (${JSON.stringify(p)})`);
  }

  // ---- (1) direct: the measurement itself, three times, between frames ----
  for (let i = 0; i < 3; i++) {
    await sleep(700);
    const r = await page.evaluate(({ ids }) => {
      const table = document.querySelector('section.project[data-project="alpha"] > .wt-scroll > table');
      if (!table) return null;
      const read = () =>
        Object.fromEntries(
          Object.entries(ids).map(([k, id]) => {
            const el = document.querySelector(`pre.job-out[data-out="${id}"]`);
            return [k, { top: Math.round(el.scrollTop), max: Math.round(el.scrollHeight - el.clientHeight) }];
          }),
        );
      // eslint-disable-next-line no-undef
      columnSigs.delete(table); // the "nothing changed" memo; a streaming console changes it anyway
      const before = read();
      // eslint-disable-next-line no-undef
      fitColumns(table);
      const after = read();
      return { before, after };
    }, { ids });
    out.direct.push(r);
  }
  for (const [i, r] of out.direct.entries()) {
    if (!r) {
      out.notMeasured.push("the table was not on the page for the direct check");
      continue;
    }
    const f = r.before.follow;
    const fa = r.after.follow;
    if (f.max - f.top <= 2 && fa.max - fa.top > 2) out.failures.push(`direct #${i + 1}: the following console left its newest line (${f.top}/${f.max} -> ${fa.top}/${fa.max})`);
    const k = r.before.park;
    const ka = r.after.park;
    if (Math.abs(ka.top - k.top) > 2) out.failures.push(`direct #${i + 1}: the parked console left the reader's line (${k.top}/${k.max} -> ${ka.top}/${ka.max})`);
  }

  // ---- (2) the window: the board's own clocks, plus the agent writing files in its tree ----
  await page.evaluate(({ id }) => {
    const el = document.querySelector(`pre.job-out[data-out="${id}"]`);
    window.__rec.park = { id, top: Math.round(el.scrollTop) };
    window.__rec.armed = true;
  }, { id: ids.park });
  touch = setInterval(() => {
    try {
      writeFileSync(path.join(tree, `probe-${Date.now()}.txt`), "activity\n");
    } catch {
      /* the next tick writes another */
    }
  }, 3000);
  touch.unref?.();
  const t0 = Date.now();
  while (Date.now() - t0 < SECONDS * 1000) await sleep(1000);
  clearInterval(touch);
  touch = null;
  const rec = await page.evaluate(() => {
    const R = window.__rec;
    R.armed = false;
    return { frames: R.frames, reads: R.reads, offTail: R.offTail, gaps: R.gaps, parkMoves: R.parkMoves, fits: R.fits, writes: R.writes, errors: R.errors, park: R.park };
  });
  out.window = rec;
  out.errors.push(...rec.errors.map((e) => String(e).slice(0, 200)));

  // ---- (3) sensitivity: a fall the recorder must see. Planted in a frame's last rAF callback, so it is painted. ----
  const seen = await page.evaluate(async ({ id, offPx }) => {
    const R = window.__rec;
    const el = document.querySelector(`pre.job-out[data-out="${id}"]`);
    const n0 = R.offTail.length;
    R.armed = true;
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => {
        el.scrollTop = 0;
        r();
      })));
      await new Promise((r) => setTimeout(r, 450));
    }
    R.armed = false;
    return { planted: 3, seen: R.offTail.slice(n0).filter((x) => x.id === id && x.gap > offPx).length };
  }, { id: ids.follow, offPx: OFF_PX });
  out.sensitivity = seen;
  if (!seen.seen) out.notMeasured.push("a planted fall was not seen by the recorder, so a clean window would say nothing");
  if (rec.fits.length < 3) out.notMeasured.push(`the board measured its columns only ${rec.fits.length}x in the window (< 3): nothing was there to survive`);
  // Informational: the column split with the row open, then with it shut. A split that moves when a row opens is a
  // split that a transcript is feeding.
  out.split = await page.evaluate(async (want) => {
    const table = () => document.querySelector('section.project[data-project="alpha"] > .wt-scroll > table');
    const widths = () => [...table().tHead.rows[0].cells].map((th) => Math.round(th.getBoundingClientRect().width));
    const row = [...state.rows.values()].find((r) => r.project === "alpha" && String(r.path || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === want);
    const key = `alpha::${row.path}`;
    columnSigs.delete(table());
    fitColumns(table());
    const open = widths();
    state.expanded.delete(key);
    renderProjectRows("alpha");
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const shut = widths();
    return { open, shut };
  }, norm(tree));
} catch (e) {
  if (!out.notMeasured.length) out.notMeasured.push(`the run broke: ${String((e && e.stack) || e).split("\n").slice(0, 3).join(" / ")}`);
} finally {
  if (touch) clearInterval(touch);
  await browser.close().catch(() => {});
  await gw.close().catch(() => {});
  await sandbox.stop().catch(() => {});
  rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
}

// ---- verdict ----------------------------------------------------------------------------------------------------------
const w = out.window || { offTail: [], gaps: [], parkMoves: [], fits: [], writes: [], frames: 0 };
const movedFits = w.fits.filter((f) => f.boxes.some((b) => Math.abs(b.after - b.before) > 2));
const fallByFit = movedFits.flatMap((f) => f.boxes.filter((b) => b.before - b.after > 2).map((b) => b.before - b.after));
if (w.offTail.length) out.failures.push(`${w.offTail.length} frame(s) painted the following console more than ${OFF_PX} px above its newest line`);
if (w.parkMoves.length) out.failures.push(`the parked console left the reader's line ${w.parkMoves.length} time(s) with no input`);
if (out.errors.length) out.failures.push(`${out.errors.length} page error(s): ${out.errors[0]}`);
const pct = (xs, q) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
console.log(`console column fit on ${TREE} (${SECONDS} s window)`);
if (out.table) console.log(`  table ${out.table.width} px, ${out.table.scrollMode ? "sideways-scroll mode" : "desktop mode"}, columns ${out.table.ths.join(",")}`);
if (out.park) console.log(`  park: console ${out.ids?.park} at ${out.park.top} of ${out.park.max}, pin ${out.park.pin}, record ${JSON.stringify(out.park.record)} (${out.parkAttempts} wheel step(s))`);
for (const [i, s] of (out.parkLog || []).entries()) console.log(`    wheel #${i + 1}: ${s.from} - ${s.dy} px -> ${s.top} of ${s.max} 500 ms later, pin ${s.pin}, record ${JSON.stringify(s.record)}`);
for (const [i, r] of out.direct.entries()) {
  if (r) console.log(`  direct #${i + 1}: following ${r.before.follow.top}/${r.before.follow.max} -> ${r.after.follow.top}/${r.after.follow.max} · parked ${r.before.park.top}/${r.before.park.max} -> ${r.after.park.top}/${r.after.park.max}`);
}
console.log(`  window: ${w.frames} frames, ${w.fits.length} column measurement(s), ${movedFits.length} of them moved a console${fallByFit.length ? ` (falls ${Math.min(...fallByFit)}-${Math.max(...fallByFit)} px)` : ""}`);
console.log(`  following console: ${w.offTail.length} frame(s) more than ${OFF_PX} px above its newest line; gap p50 ${pct(w.gaps, 0.5)} / p99 ${pct(w.gaps, 0.99)} / max ${w.gaps.length ? Math.max(...w.gaps) : 0} px over ${w.gaps.length} frame(s)`);
console.log(`  parked console: ${w.parkMoves.length} move(s) off the reader's line${w.parkMoves.length ? ` (${w.parkMoves.slice(0, 4).map((m) => `${m.from}->${m.top}`).join(", ")})` : ""}; ${w.writes.length} panel write(s) moved it${w.writes.length ? ` (${w.writes.slice(0, 3).map((x) => `${x.from}->${x.landed} by ${x.by}`).join("; ")})` : ""}`);
if (out.sensitivity) console.log(`  sensitivity: ${out.sensitivity.seen} of ${out.sensitivity.planted} planted falls seen`);
if (out.split) console.log(`  column split, row open: ${out.split.open.join(",")} · row shut: ${out.split.shut.join(",")}${out.split.open.join() === out.split.shut.join() ? " (the same)" : " (the open row's transcript moved it)"}`);
for (const f of out.failures) console.log(`  - ${f}`);
for (const f of out.notMeasured) console.log(`  ? ${f}`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
if (out.notMeasured.length) {
  console.log("NOT MEASURED");
  process.exit(2);
}
if (out.failures.length) {
  console.log("FAIL  a console moved while the board measured its columns");
  process.exit(1);
}
console.log("PASS  measuring the columns moved no console, following or parked");
process.exit(0);
