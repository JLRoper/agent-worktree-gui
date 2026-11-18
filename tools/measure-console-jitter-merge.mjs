#!/usr/bin/env node
// The console's jitter while one turn streams text, tool lines and reasoning: four numbers, one page.
//
//   node tools/measure-console-jitter-merge.mjs
//   node tools/measure-console-jitter-merge.mjs --arm base --root <a git archive export>
//   node tools/measure-console-jitter-merge.mjs --arm thinkonly          # in-page control: the pre-1.113.1 predicate
//   node tools/measure-console-jitter-merge.mjs --seconds 32 --json <path>
//
// WHAT THIS MEASURES, and why each number is here:
//   1. DRIFT, in pixels. Every animation frame reads the console's scrollTop, scrollHeight, clientHeight and the
//      element's own box (top and height). From that: the path the box travelled (sum of |dScrollTop|), how far it
//      ever sat off its own tail (scrollHeight - scrollTop - clientHeight), the number of frames it was painted off
//      the tail, every UPWARD move with its size, and whether the element's box moved on the page at all.
//   2. MUTATIONS per second. One MutationObserver on the document counts childList / characterData / attribute
//      records, attributes each record to the console when its target stands inside one, and keeps the number of
//      element nodes one callback added: the last is the BURST size, which is what a hold that releases a queue of
//      frames at once looks like from the DOM's side.
//   3. LAYOUT SHIFTS. A PerformanceObserver on layout-shift, buffered from the first byte, with each entry's value
//      and its source nodes. A console that is corrected in the task that grew it has no visible shift; one whose
//      correction lands in the next frame paints the row below the box's edge first.
//   4. LONG TASKS, as the cost of whatever the other three are doing.
//   5. HOLD DEPTH, on a 2.5 s clock: how many frames the reasoning hold is keeping out of the console, how many rows
//      the console has drawn and how many lines it has recorded, plus the stream's own queue. This is the number that
//      separates a console the page has not been handed from one the page is holding, and it is the one that named
//      the cause of the 2026-11-17 regression (see the timeline array in the --json capture).
//
// WHAT IT DRIVES: a sandbox panel of its own (tools/panel-testkit.mjs startPanel), a stub Runs API that plays ONE
// fixed script over real SSE at a steady rate for the whole window - three words every 60 ms (50 words/s, faster
// than the page's own 40 words/s pacer, so the pacer is always behind the wire), a tool call and its output every
// 1150 ms, and a reasoning block every 3000 ms. Nothing reaches the page that the page's own clocks did not draw:
// lib/jobs.js coalesces the deltas, the pacer types them, the reasoning hold decides when a tool line may join,
// stickSoon and setScroll place the box.
//
// THE ARMS. `head` is the checkout this file lives in. `base` is the same harness pointed at a `git archive` export
// of the commit a change is being judged against (`--root` picks the checkout the panel serves), so the only
// difference between two rows of the output is the code under test. `thinkonly` is the sharpest control when the
// change was a PREDICATE: it rebuilds state.typeHold in the page with the pre-change `busy` function and leaves
// every other byte alone (labelled as an in-page control wherever its numbers are quoted).
//
// EXIT CODES
//   0  measured (the numbers are the output; this tool has no pass threshold)
//   1  the page threw, or the run drove nothing
//   2  Playwright is not installed, or --root is not a panel checkout
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startPanel } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const ARM = opt("--arm", "head");
const SECONDS = Math.max(12, Number(opt("--seconds", "32")) || 32);
const ROOT_UNDER_TEST = path.resolve(opt("--root", ROOT));
const JSON_OUT = opt("--json");
const KEEP = argv.includes("--keep");
const THREAD = "probe-console-merge";
const VIEWPORT = { width: 1440, height: 900 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (n) => Math.round(Number(n) * 10) / 10;
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
};

function loadPlaywright() {
  for (const root of [process.env.PANEL_PLAYWRIGHT_ROOT, process.env.PLAYWRIGHT_ROOT, ROOT, process.cwd()].filter(Boolean)) {
    for (const p of [path.join(root, "node_modules", "playwright"), path.join(root, "playwright"), root]) {
      try {
        return require(p);
      } catch {
        /* not there */
      }
    }
  }
  try {
    return require("playwright");
  } catch {
    return null;
  }
}

// ---- the fixed stream -----------------------------------------------------------------------------------------------
// Deterministic: the same words at the same milliseconds on every run, so two arms differ by their code and not by
// what the wire happened to send.
const WORDS = `the console grows a row at a time while the turn is still running
a row that keeps its node keeps the selection inside it
the pacer releases words on its own clock and extends the row in place
a tool card that waits for the sentence above it joins when the sentence ends
a queue that leaves together is one jump of three or four rows
a queue that leaves a row at a time is a transcript being read
the reasoning block types on the same clock as the prose it precedes
the corner of the box is fixed and its content is longer than the box
keeping the newest row in view means writing the scroll on every growth
a reader who has scrolled up is a reader the panel must not move
the sweep runs on its own clock whether or not the wire is moving
the frame clock says whether any of it costs a frame`.split(/\s+/).filter(Boolean);

function sentence(seed, words = 3) {
  const out = [];
  for (let i = 0; i < words; i += 1) out.push(WORDS[(seed + i) % WORDS.length]);
  return out.join(" ");
}

// The script the stub plays. Three kinds at a steady rate for the whole window.
function buildScript(seconds) {
  const steps = [];
  const until = seconds * 1000;
  let seed = 0;
  let sinceBreak = 0;
  for (let t = 200; t < until; t += 60) {
    const text = sentence(seed, 3);
    seed += 3;
    sinceBreak += 3;
    const lead = sinceBreak >= 45 ? "\n\n" : sinceBreak === 3 ? "" : " ";
    if (sinceBreak >= 45) sinceBreak = 0;
    steps.push({ at: t, evt: { event: "message.delta", delta: `${lead}${text} ` } });
  }
  let n = 0;
  for (let t = 900; t < until; t += 1150) {
    n += 1;
    const tool = n % 3 === 0 ? "web_search" : "terminal";
    steps.push({ at: t, evt: { event: "tool.started", tool, preview: n % 3 === 0 ? "the console jitter question" : `npm run check -- ${n}` } });
    steps.push({
      at: t + 130,
      evt: {
        event: "tool.completed",
        tool,
        duration: 0.13,
        preview: n % 3 === 0 ? "3 results for the console jitter question" : `row ${n} of the run\nrow ${n + 1} of the run\nrow ${n + 2} of the run`,
      },
    });
  }
  let b = 0;
  for (let t = 1500; t < until; t += 3000) {
    b += 1;
    steps.push({
      at: t,
      evt: {
        event: "reasoning.available",
        text: `thought ${b}: the reader is watching a live card, so the pane to measure is the one that is redrawn, and the prose arrives on the stream while the reasoning is read back from the store at the same words a second`,
      },
    });
  }
  steps.sort((a, z) => a.at - z.at);
  steps.push({ at: until + 900, evt: { event: "run.completed", output: "done", usage: { total_tokens: 9000, input_tokens: 8100, output_tokens: 900 } } });
  return steps;
}

// ---- the stub Runs API ----------------------------------------------------------------------------------------------
function makeGateway(script) {
  const state = { runs: new Map(), posts: 0 };
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
      return json(200, { version: "merge-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_cwd: true } });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        state.posts += 1;
        const id = `run_merge_${state.posts}`;
        state.runs.set(id, { id, status: "running", output: "", startedAt: null });
        json(200, { run_id: id, status: "running" });
      });
      return;
    }
    const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const rec = state.runs.get(one[1]);
      if (!rec) return json(404, { error: { message: "Run not found", code: "run_not_found" } });
      return json(200, { run_id: rec.id, status: rec.status, output: rec.output, usage: { total_tokens: 9000, input_tokens: 8100, output_tokens: 900 } });
    }
    const ev = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (ev && req.method === "GET") {
      const rec = state.runs.get(ev[1]);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      if (!rec) return res.end();
      res.write(": open\n\n");
      rec.startedAt = Date.now();
      let open = true;
      req.on("close", () => {
        open = false;
      });
      script.forEach((step, i) => {
        later(rec.startedAt + step.at - Date.now(), () => {
          if (!open) return;
          res.write(`id: ${i}\ndata: ${JSON.stringify({ ...step.evt, run_id: rec.id, seq: i, timestamp: Date.now() / 1000 })}\n\n`);
          if (step.evt.event === "run.completed") {
            rec.status = "completed";
            rec.output = step.evt.output;
            later(60, () => res.end());
          }
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

// ---- the page-side instrument --------------------------------------------------------------------------------------
// Installed before app.js parses: the frame sampler, the mutation counter and the layout-shift reader are all live
// before the first byte of the turn arrives.
function pageInit({ thread }) {
  try {
    localStorage.setItem("wtgui.autoCollect", "0");
    localStorage.setItem("wtgui.think", "1");
    localStorage.setItem(`wtgui.think.${thread}`, "1");
    localStorage.setItem(`wtgui.stream.${thread}`, "1");
  } catch {
    /* storage may be unavailable */
  }
  const T0 = performance.now();
  const now = () => performance.now() - T0;
  const H = { frames: [], buckets: [], shifts: [], longtasks: [], marks: [], errors: [] };
  window.__H = H;
  const cardSel = `.job[data-thread="${thread}"]`;
  const consoleOf = () => {
    const card = document.querySelector(cardSel);
    if (!card) return null;
    const outs = [...card.querySelectorAll("pre.job-out[data-out]")].filter((el) => !String(el.dataset.out || "").endsWith("@pin"));
    return outs[0] || card.querySelector("pre.job-out");
  };

  let sec = -1;
  let bucket = null;
  const tick = () => {
    const s = Math.floor(now() / 1000);
    if (s !== sec) {
      sec = s;
      bucket = { s, mut: 0, child: 0, char: 0, attr: 0, inConsole: 0, added: 0, removed: 0, bursts: 0, maxBurst: 0, callbacks: 0, rows: 0, st: 0, sh: 0 };
      H.buckets.push(bucket);
    }
    return bucket;
  };
  const insideConsole = (n) => Boolean(n && (n.closest ? n.closest("pre.job-out") : null));
  new MutationObserver((records) => {
    const b = tick();
    b.callbacks += 1;
    let added = 0;
    for (const r of records) {
      b.mut += 1;
      if (r.type === "childList") {
        b.child += 1;
        for (const n of r.addedNodes) if (n.nodeType === 1) added += 1;
        for (const n of r.removedNodes) if (n.nodeType === 1) b.removed += 1;
        if (insideConsole(r.target)) b.inConsole += 1;
      } else if (r.type === "characterData") {
        b.char += 1;
        if (insideConsole(r.target.parentNode)) b.inConsole += 1;
      } else {
        b.attr += 1;
      }
    }
    b.added += added;
    if (added >= 3) b.bursts += 1;
    if (added > b.maxBurst) b.maxBurst = added;
  }).observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "style"] });

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        H.shifts.push({
          t: Math.round(e.startTime * 10) / 10,
          v: Math.round(e.value * 100000) / 100000,
          n: (e.sources || []).map((s) => (s.node ? String(s.node.className || s.node.nodeName || "").slice(0, 60) : "")).filter(Boolean).slice(0, 3),
          inConsole: (e.sources || []).some((s) => insideConsole(s.node)),
        });
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {
    /* no layout-shift in this engine: the field stays empty and the report says so */
  }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) H.longtasks.push({ t: Math.round(e.startTime * 10) / 10, d: Math.round(e.duration * 10) / 10 });
    }).observe({ type: "longtask", buffered: true });
  } catch {
    /* not every engine reports long tasks */
  }

  const loop = () => {
    const el = consoleOf();
    if (el) {
      const rect = el.getBoundingClientRect();
      H.frames.push({
        t: Math.round(now() * 10) / 10,
        st: Math.round(el.scrollTop * 10) / 10,
        sh: el.scrollHeight,
        ch: el.clientHeight,
        top: Math.round(rect.top * 10) / 10,
        h: Math.round(rect.height * 10) / 10,
        rows: el.children.length,
      });
      const b = tick();
      b.rows = el.children.length;
      b.st = Math.round(el.scrollTop * 10) / 10;
      b.sh = el.scrollHeight;
    } else {
      H.frames.push({ t: Math.round(now() * 10) / 10, miss: 1 });
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  window.__probe = {
    mark(name) {
      H.marks.push({ name, t: Math.round(now() * 10) / 10 });
      return H.marks[H.marks.length - 1].t;
    },
    // The rows the console ended on, by kind, plus the page's own answer about its hold and its pacer.
    state() {
      const el = consoleOf();
      const kinds = {};
      let tgrp = 0;
      let stolen = 0;
      if (el) {
        for (const n of el.querySelectorAll("[data-lkind]")) kinds[n.dataset.lkind] = (kinds[n.dataset.lkind] || 0) + 1;
        tgrp = el.querySelectorAll(".tgrp").length;
        stolen = el.querySelectorAll("[data-lid^='think:']").length;
      }
      return {
        rows: el ? el.children.length : 0,
        kinds,
        tgrp,
        thinkRows: stolen,
        consoleScrollHeight: el ? el.scrollHeight : 0,
        consoleClientHeight: el ? el.clientHeight : 0,
        pinned: el ? Boolean(state.outPinned?.[el.dataset.out] !== false) : null,
        holdQueued: state.typeHold?.queued?.() ?? null,
        streamQueue: state.typeStream?.queued?.() ?? null,
        words: state.typeStream?.rate?.() ?? null,
        lines: state.typeGate?.rate?.() ?? null,
        lastThisTurn: el ? String(el.dataset.out || "") : "",
      };
    },
    // The control for a change that was a predicate: rebuild the hold around the PRE-change `busy` and leave every
    // other function (wants, start, release) exactly as app.js built it.
    thinkOnlyHold() {
      if (!window.wtType || !state.typeHold) return false;
      const floorOf = (job) => {
        const lines = jobLines(String(job));
        for (let k = lines.length - 1; k >= 0; k -= 1) if (lines[k]?.kind === "tool-out") return Number(lines[k].at) || 0;
        return 0;
      };
      state.typeHold = window.wtType.createReasoningHold({
        wants: reasoningWants,
        busy: (job) => {
          const rec = state.reasoningReads.get(job);
          if (rec && !rec.done && Date.now() - rec.at < 2000) return true;
          const floor = floorOf(job);
          return Boolean(
            state.typeStream?.pendingFor(job, (lid) => String(lid || "").startsWith("think:") && (Number(String(lid).slice(6)) || 0) > floor),
          );
        },
        start: reasoningStart,
        release: (evt) => {
          if (!state.typeGate?.push(evt)) {
            recordJobLine(evt);
            drawJobLine(evt);
          }
        },
      });
      return true;
    },
    // A sample of the page's own queues, taken on a clock: the depth of the hold and of the stream's own queue is
    // what says whether a still console is a console the page has not been handed or one it is holding.
    poll() {
      try {
        const el = consoleOf();
        const id = String(el?.dataset.out || "");
        const q = state.typeHold?.held?.(id)?.[0] || null;
        const P = state.typeStream;
        const at = Number(q?.line?.at);
        return {
          t: Math.round(now() * 10) / 10,
          rows: el ? el.children.length : 0,
          sh: el ? el.scrollHeight : 0,
          recorded: state.jobLines?.get?.(id)?.length ?? 0,
          held: state.typeHold?.queued?.() ?? null,
          gate: state.typeGate?.queued?.() ?? null,
          outs: typeof placedNodes === "function" ? placedNodes("pre.job-out").length : null,
          head: q ? { kind: q.line?.kind, lid: q.line?.lid, mode: q.line?.mode, at: q.line?.at } : null,
          pendingBefore: q && P ? Boolean(P.pendingBefore(id, at, typeof reasoningFloor === "function" ? reasoningFloor(id) : 0)) : null,
          floor: typeof reasoningFloor === "function" ? reasoningFloor(id) : null,
          read: state.reasoningReads?.get(id) ? { done: state.reasoningReads.get(id).done, age: Date.now() - state.reasoningReads.get(id).at } : null,
          order: P ? P.order().length : null,
          words: P ? P.pendingWords() : null,
          stats: P ? P.stats() : null,
        };
      } catch (err) {
        return { t: Math.round(now() * 10) / 10, error: String((err && err.message) || err) };
      }
    },
    dump() {
      H.state = this.state();
      return H;
    },
  };
}

// ---- one arm -------------------------------------------------------------------------------------------------------
async function runArm(pw, ctx, work) {
  const dir = path.join(work, ARM);
  const repo = path.join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  mkdirSync(path.join(dir, "empty-root"), { recursive: true });
  const EMAIL = ["probe", "example.invalid"].join(String.fromCharCode(64));
  const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  writeFileSync(path.join(repo, "README.md"), "# probe repo\n");
  git(["add", "."]);
  git(["-c", "user.name=probe", "-c", `user.email=${EMAIL}`, "commit", "-q", "-m", "first"]);

  const script = buildScript(SECONDS);
  const gw = makeGateway(script);
  const gwPort = await gw.listen();
  const sandbox = await startPanel({
    dir,
    keep: KEEP,
    root: ROOT_UNDER_TEST,
    config: {
      scanRoots: [path.join(dir, "empty-root")],
      refreshSeconds: 3600,
      fetchSeconds: -1,
      assistant: { enabled: false },
      remoteBranchPolicy: "local-only",
      defaultCwd: repo,
      apiServer: { url: `http://127.0.0.1:${gwPort}`, key: "probe" },
    },
    env: { API_SERVER_KEY: "" },
  });
  const errors = [];
  let page = null;
  try {
    page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String((e && e.message) || e)));
    await page.addInitScript(pageInit, { thread: THREAD });
    await page.goto(sandbox.base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && Boolean(state.jobs), null, { timeout: 30000 });
    if (ARM === "thinkonly") {
      const swapped = await page.evaluate(() => window.__probe.thinkOnlyHold());
      if (!swapped) throw new Error("the thinkonly control could not rebuild the hold");
    }
    const spawned = await fetch(`${sandbox.base}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "probe: stream text, tool lines and reasoning at a steady rate", cwd: repo, existing: true, thread: THREAD }),
    }).then((r) => r.json());
    if (!spawned || !spawned.job) throw new Error(`spawn failed: ${JSON.stringify(spawned)}`);
    await page.waitForSelector(`.job[data-thread="${THREAD}"] pre.job-out`, { timeout: 25000 });
    await page.evaluate((th) => document.querySelector(`.job[data-thread="${th}"]`)?.scrollIntoView({ block: "center" }), THREAD);
    // The first second belongs to the arm: the card is placed, the console gets its first rows, the box finds its
    // height. The measured window opens after that.
    await sleep(1600);
    await page.evaluate(() => window.__probe.mark("arm"));
    const timeline = [];
    for (let i = 0; i < Math.ceil(SECONDS / 2.5); i += 1) {
      await sleep(2500);
      timeline.push(await page.evaluate(() => window.__probe.poll()).catch(() => null));
    }
    await page.evaluate(() => window.__probe.mark("end"));
    const H = await page.evaluate(() => window.__probe.dump());
    return { arm: ARM, root: ROOT_UNDER_TEST, job: spawned.job.id, thread: THREAD, seconds: SECONDS, viewport: VIEWPORT, errors, timeline: timeline.filter(Boolean), script: { deltas: script.filter((s) => s.evt.event === "message.delta").length, tools: script.filter((s) => s.evt.event === "tool.completed").length, reasoning: script.filter((s) => s.evt.event === "reasoning.available").length }, H };
  } finally {
    if (page) await page.close().catch(() => {});
    await gw.close().catch(() => {});
    await sandbox.stop().catch(() => {});
  }
}

// ---- the numbers ---------------------------------------------------------------------------------------------------
function summarise(cap) {
  const H = cap.H;
  const marks = Object.fromEntries((H.marks || []).map((m) => [m.name, m.t]));
  const from = marks.arm ?? 0;
  const to = marks.end ?? Math.max(...H.frames.map((f) => f.t));
  const frames = H.frames.filter((f) => !f.miss && f.t >= from && f.t <= to);
  const secs = Math.max(0.001, (to - from) / 1000);
  const buckets = H.buckets.filter((b) => b.s * 1000 >= from && b.s * 1000 <= to);

  const steps = [];
  const ups = [];
  for (let i = 1; i < frames.length; i += 1) {
    const d = frames[i].st - frames[i - 1].st;
    steps.push(Math.abs(d));
    if (d < -0.5) ups.push({ t: frames[i].t, d: r1(d) });
  }
  const gaps = frames.map((f) => f.sh - f.st - f.ch);
  const tops = frames.map((f) => f.top);
  const heights = frames.map((f) => f.h);
  const intervals = [];
  for (let i = 1; i < frames.length; i += 1) intervals.push(frames[i].t - frames[i - 1].t);

  const mut = buckets.reduce((a, b) => a + b.mut, 0);
  const added = buckets.reduce((a, b) => a + b.added, 0);
  const bursts = buckets.reduce((a, b) => a + b.bursts, 0);
  const maxBurst = buckets.reduce((a, b) => Math.max(a, b.maxBurst), 0);
  const shifts = (H.shifts || []).filter((s) => s.t >= from && s.t <= to);
  const longtasks = (H.longtasks || []).filter((s) => s.t >= from && s.t <= to);

  return {
    arm: cap.arm,
    root: cap.root,
    job: cap.job,
    seconds: r1(secs),
    frames: frames.length,
    fps: r1(frames.length / secs),
    frameP50: r1(pct(intervals, 50) || 0),
    frameP95: r1(pct(intervals, 95) || 0),
    missing: (H.frames || []).filter((f) => f.miss).length,
    scroll: {
      path: r1(steps.reduce((a, b) => a + b, 0)),
      pathPerSec: r1(steps.reduce((a, b) => a + b, 0) / secs),
      net: r1(frames.length ? frames[frames.length - 1].st - frames[0].st : 0),
      grown: frames.length ? frames[frames.length - 1].sh - frames[0].sh : 0,
      distinctTop: new Set(frames.map((f) => Math.round(f.st))).size,
      upMoves: ups.length,
      upPx: r1(ups.reduce((a, b) => a + Math.abs(b.d), 0)),
      biggestStep: r1(Math.max(0, ...steps)),
      stepP95: r1(pct(steps, 95) || 0),
      offTailFrames: gaps.filter((g) => g > 4).length,
      offTailPct: r1((gaps.filter((g) => g > 4).length / Math.max(1, gaps.length)) * 100),
      gapMax: r1(Math.max(0, ...gaps)),
      gapP95: r1(pct(gaps, 95) || 0),
      boxTopDistinct: new Set(tops.map((t) => Math.round(t * 10) / 10)).size,
      boxTopRange: r1(Math.max(...tops) - Math.min(...tops)),
      boxHeightDistinct: new Set(heights.map((h) => Math.round(h))).size,
      boxHeightRange: r1(Math.max(...heights) - Math.min(...heights)),
      firstSh: frames.length ? frames[0].sh : 0,
      lastSh: frames.length ? frames[frames.length - 1].sh : 0,
    },
    mutations: {
      total: mut,
      perSec: r1(mut / secs),
      inConsolePerSec: r1(buckets.reduce((a, b) => a + b.inConsole, 0) / secs),
      childPerSec: r1(buckets.reduce((a, b) => a + b.child, 0) / secs),
      charPerSec: r1(buckets.reduce((a, b) => a + b.char, 0) / secs),
      addedPerSec: r1(added / secs),
      added: added,
      removed: buckets.reduce((a, b) => a + b.removed, 0),
      callbacks: buckets.reduce((a, b) => a + b.callbacks, 0),
      burstCallbacks: bursts,
      burstPct: r1((bursts / Math.max(1, buckets.reduce((a, b) => a + b.callbacks, 0))) * 100),
      maxBurst,
      maxPerSec: buckets.reduce((a, b) => Math.max(a, b.mut), 0),
      p95PerSec: pct(buckets.map((b) => b.mut), 95) || 0,
      series: buckets.map((b) => b.mut),
    },
    shifts: {
      count: shifts.length,
      perSec: r1(shifts.length / secs),
      sum: r1(shifts.reduce((a, b) => a + b.v, 0) * 1000) / 1000,
      max: shifts.length ? Math.max(...shifts.map((s) => s.v)) : 0,
      inConsole: shifts.filter((s) => s.inConsole).length,
      top: shifts
        .slice()
        .sort((a, b) => b.v - a.v)
        .slice(0, 5)
        .map((s) => ({ t: s.t, v: s.v, n: s.n, c: s.inConsole })),
    },
    longtasks: { count: longtasks.length, totalMs: r1(longtasks.reduce((a, b) => a + b.d, 0) / 10) / 10, maxMs: longtasks.length ? Math.max(...longtasks.map((l) => l.d)) : 0 },
    rows: H.state || null,
    timeline: cap.timeline || [],
    script: cap.script,
    errors: cap.errors,
  };
}

function printArm(s) {
  console.log(`\n== ${s.arm}  (${s.root})`);
  console.log(`   window ${s.seconds}s, ${s.frames} frames at ${s.fps}/s (p50 ${s.frameP50}ms, p95 ${s.frameP95}ms), console grew ${s.scroll.grown}px to ${s.scroll.lastSh}px in a ${s.rows?.consoleClientHeight ?? "?"}px box`);
  console.log(
    `   drift: path ${s.scroll.path}px (${s.scroll.pathPerSec}px/s), net ${s.scroll.net}px, distinct scrollTop ${s.scroll.distinctTop}, ` +
      `up moves ${s.scroll.upMoves} / ${s.scroll.upPx}px, biggest step ${s.scroll.biggestStep}px, off-tail ${s.scroll.offTailFrames} frames (${s.scroll.offTailPct}%), gap max ${s.scroll.gapMax}px`,
  );
  console.log(`   box: top moved over ${s.scroll.boxTopRange}px across ${s.scroll.boxTopDistinct} values, height over ${s.scroll.boxHeightRange}px`);
  console.log(
    `   mutations: ${s.mutations.perSec}/s (max ${s.mutations.maxPerSec}/s, p95 ${s.mutations.p95PerSec}), ${s.mutations.inConsolePerSec}/s inside the console, ` +
      `child ${s.mutations.childPerSec}/s, char ${s.mutations.charPerSec}/s, added ${s.mutations.added} elements / removed ${s.mutations.removed}, ` +
      `bursts (>=3 in one callback) ${s.mutations.burstCallbacks} (${s.mutations.burstPct}%), max ${s.mutations.maxBurst}`,
  );
  console.log(`   layout shifts: ${s.shifts.count} (${s.shifts.perSec}/s), sum ${s.shifts.sum}, max ${s.shifts.max}, in console ${s.shifts.inConsole}`);
  console.log(`   long tasks: ${s.longtasks.count}, ${s.longtasks.totalMs}ms total, max ${s.longtasks.maxMs}ms`);
  if (s.timeline?.length) console.log(`   timeline: ${s.timeline.map((x) => `${x.t}ms rows=${x.rows} sh=${x.sh} recorded=${x.recorded} held=${x.held}`).join(" | ")}`);
  console.log(`   rows: ${s.rows?.rows} children, ${s.rows?.tgrp} tool groups, kinds ${JSON.stringify(s.rows?.kinds)}, hold queued ${s.rows?.holdQueued}, stream queued ${s.rows?.streamQueue}, words/s ${s.rows?.words}, lines/s ${s.rows?.lines}`);
}

// ---- main ----------------------------------------------------------------------------------------------------------
const pw = loadPlaywright();
if (!pw) {
  console.log("SKIP  playwright is not installed here (set PLAYWRIGHT_ROOT to a node_modules directory that has it)");
  process.exit(2);
}
if (!ROOT_UNDER_TEST || ROOT_UNDER_TEST.length < 3) {
  console.log(`--root must name a panel checkout, not ${ROOT_UNDER_TEST}`);
  process.exit(2);
}
const work = mkdtempSync(path.join(os.tmpdir(), "wtgui-merge-"));
const profile = path.join(work, "profile");
mkdirSync(profile, { recursive: true });
const ctx = await pw.chromium.launchPersistentContext(profile, { headless: true, viewport: VIEWPORT });
let exit = 0;
try {
  console.log(`-- ${ARM}: sandbox panel from ${ROOT_UNDER_TEST}, ${SECONDS}s of text/tool/reasoning at a steady rate, ${VIEWPORT.width}x${VIEWPORT.height} headless`);
  const cap = await runArm(pw, ctx, work);
  const s = summarise(cap);
  printArm(s);
  if (cap.errors.length) {
    console.log(`   page errors: ${JSON.stringify(cap.errors.slice(0, 3))}`);
    exit = 1;
  }
  if (!s.frames || s.frames < 60) {
    console.log("   the run drove nothing: fewer than 60 sampled frames in the window");
    exit = 1;
  }
  if (JSON_OUT) {
    mkdirSync(path.dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), sha: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(), summary: s, capture: cap }, null, 1));
    console.log(`   capture: ${JSON_OUT}`);
  }
} finally {
  await ctx.close().catch(() => {});
  if (!KEEP) rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  else console.log(`   sandbox kept: ${work}`);
}
process.exit(exit);
