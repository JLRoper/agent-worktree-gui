#!/usr/bin/env node
// Thinking and tool calls in ONE console stream, with the live mark, proved on a real run.
//
//   node tools/verify-thinking-stream.mjs                      # this checkout
//   node tools/verify-thinking-stream.mjs --root <dir>          # a `git archive` of another build (expected to fail)
//   node tools/verify-thinking-stream.mjs --out <dir>           # where the screenshots and results.json go
//
// WHAT THIS PINS (the reader's four decisions on row #276)
//   (1) one stream: the reasoning is rows of the console, interleaved with the tool calls in the order they happened -
//       there is no `details.think` pane above it and no thought is drawn twice;
//   (2) the LIVE view splits at every tool boundary: the reasoning before a call is its own row, and reasoning that
//       resumes after the call is a NEW row rather than the old one rewritten;
//   (3) the live row carries the still-thinking mark IN the console output: it exists while deltas are arriving and is
//       gone at the first tool and at the end of the turn;
//   (4) the row is dim and clipped to a few lines, and a press opens it in place; the console is still readable at a
//       narrow viewport;
//   (5) a settled reload reproduces the same order with ONE copy of each block: the store's blocks are merged by `at`
//       and the live preview rows are taken out;
//   (6) a FOLDED row never paints past its four-line lid, at any painted frame: not while the stream grows it, not
//       while the page measures its cut, and not when a card rebuild draws the row again mid-stream. It never gains
//       is-open on its own; only the reader's press opens it. Sampled every animation frame (window.__lid), because
//       a row that is over the lid for one frame is exactly the flash the reader reported, and no poll can see it.
//
// WHAT IS DRIVEN. A sandbox panel of its own on a spare port (tools/panel-testkit.mjs: own PANEL_CONFIG / HERMES_HOME
// / jobs.json, no reader's store touched), with a stub Runs API playing a scripted turn over REAL SSE:
// reasoning.delta x7 (one console line each), tool.started/terminal, tool.completed, reasoning.delta x2,
// message.delta, run.completed - with one card rebuild forced in the middle of the live window. The card
// is spawned through the panel's own POST /api/agents into a fixture repo, so the console is a real run drawn by the
// page's own painters. /api/thinking is answered by this gate (the sandbox has no session store); the settled read is
// driven with the block stamps the page itself recorded, so the merge under test is the shipped one.
//
// Exit codes: 0 every assertion held; 1 one failed; 2 the run could not measure what it claims (no Playwright).
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const OUT = opt("--out", path.join(os.tmpdir(), "wag", "thinking-stream"));

const THOUGHT_A = [
  "First, read the fixture: one file, one heading.",
  "The row is clipped at four lines of the console's own leading, so this thought is longer than that on purpose.",
  "Line three says the same thing again, so the scrollHeight is measurably past the clip.",
  "Line four is still on screen.",
  "Line five is hidden until the reader presses the row.",
  "Line six is hidden too.",
  "Line seven ends the thought.",
].join("\n");
const THOUGHT_B = "The read came back; the heading is what the answer needs.";
const ANSWER = "The fixture's heading is Title and the body is one line.";

// ---- a scripted turn over the real Runs SSE -----------------------------------------------------------
// One event per 320 ms. The reasoning is SEVEN deltas - one console line each, so the row is over its four-line lid
// while the stream is still writing it - then a call and its result, then two more deltas, then the answer and the
// terminal event. That is the shape a reasoning model produces: a thought, the call it led to, the next thought after
// the result. Splitting the thought finer than four deltas is what gives the lid case in the middle of the live
// window its own frames to judge: a row that only reached the lid on the last delta would be judged after it stopped.
const THOUGHT_LINES = THOUGHT_A.split("\n");
function nextEvent(rec) {
  const script = [
    ...THOUGHT_LINES.map((line, i) => ({ event: "reasoning.delta", delta: i < THOUGHT_LINES.length - 1 ? `${line}\n` : line })),
    { event: "tool.started", tool: "read_file", preview: "docs/a.md" },
    { event: "tool.completed", tool: "read_file", duration: 0.21, preview: "# Title\n\nbody line\n" },
    { event: "reasoning.delta", delta: "The read came back; " },
    { event: "reasoning.delta", delta: "the heading is what the answer needs." },
    { event: "message.delta", delta: `\n\n${ANSWER}` },
    { event: "run.completed", output: ANSWER, usage: { total_tokens: 4200, input_tokens: 3800, output_tokens: 400 } },
  ].filter((e) => e.delta !== "");
  const evt = script[Math.min(rec.step, script.length - 1)];
  rec.step += 1;
  if (evt.event === "run.completed") rec.done = true;
  return evt;
}

function makeGateway() {
  const runs = new Map();
  let posts = 0;
  const timers = new Set();
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/v1/capabilities") {
      return json(200, {
        version: "thinking-stream-stub",
        features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true },
      });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      req.resume();
      req.on("end", () => {
        posts += 1;
        const id = `run_think_${posts}`;
        runs.set(id, { id, step: 0, done: false });
        json(200, { run_id: id, status: "running" });
      });
      return;
    }
    const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const rec = runs.get(one[1]);
      if (!rec) return json(404, { error: { message: "Run not found", code: "run_not_found" } });
      return json(200, {
        run_id: rec.id,
        status: rec.done ? "completed" : "running",
        output: rec.done ? ANSWER : "",
        usage: { total_tokens: 4200, input_tokens: 3800, output_tokens: 400 },
      });
    }
    const ev = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (ev && req.method === "GET") {
      const rec = runs.get(ev[1]);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": open\n\n");
      if (!rec) return res.end();
      let seq = 0;
      const timer = setInterval(() => {
        const evt = nextEvent(rec);
        res.write(`id: ${seq}\ndata: ${JSON.stringify({ ...evt, run_id: rec.id, seq: seq++, timestamp: Date.now() / 1000 })}\n\n`);
        if (rec.done) {
          clearInterval(timer);
          timers.delete(timer);
          setTimeout(() => res.end(), 400);
        }
      }, 320);
      rec.timer = timer;
      timers.add(timer);
      req.on("close", () => {
        clearInterval(timer);
        timers.delete(timer);
      });
      return;
    }
    json(404, {});
  });
  return {
    listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))),
    close: () =>
      new Promise((r) => {
        for (const h of timers) clearInterval(h);
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

// ---- helpers --------------------------------------------------------------------------------------------
const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const git = (args, cwd) =>
  execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@localhost", ...args], { cwd, stdio: "pipe", encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  - ${detail}` : ""}`);
  return Boolean(ok);
};

// The console as the page drew it: rows in order, which are thoughts, where the mark is, and what each row says.
const readConsole = (page, thread) =>
  page.evaluate((t) => {
    const card = document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
    const out = card?.querySelector("pre.job-out");
    if (!out) return { found: false };
    const rows = [...out.children].map((n) => ({
      kind: n.dataset.lkind || n.className,
      lid: n.dataset.lid || "",
      think: n.classList.contains("jl-think"),
      text: (n.innerText || "").replace(/\s+/g, " ").trim(),
    }));
    const thinks = [...out.querySelectorAll(".jl-think")];
    const first = thinks[0] || null;
    const text = first?.querySelector(".think-text") || null;
    const cs = text ? getComputedStyle(text) : null;
    return {
      found: true,
      rows,
      thinkRows: thinks.length,
      liveMarks: out.querySelectorAll("[data-think-live]").length,
      pane: Boolean(card.querySelector("details.think, .think-body")),
      clip: text
        ? {
            maxHeight: cs.maxHeight,
            clientHeight: text.clientHeight,
            scrollHeight: text.scrollHeight,
            overflowY: cs.overflowY,
            ends: text.textContent.endsWith("...."),
            source: first.dataset.ltext || "",
            drawn: text.textContent,
          }
        : null,
      open: Boolean(first?.classList.contains("is-open")),
      width: { client: out.clientWidth, scroll: out.scrollWidth },
      text: out.textContent.replace(/\s+/g, " ").trim(),
    };
  }, thread);

const occurrences = (haystack, needle) =>
  String(haystack).split(String(needle).replace(/\s+/g, " ").trim()).length - 1;
const order = (rows, pick) => rows.map((r, i) => (pick(r) ? i : -1)).filter((i) => i >= 0);
const why = (s) =>
  s.found
    ? `rows ${s.rows.length} (${s.rows.map((r) => (r.think ? "think" : r.kind)).join(" | ")}), marks ${s.liveMarks}, pane ${s.pane}`
    : "no console";

// ---- the run --------------------------------------------------------------------------------------------
const main = async () => {
  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN: no playwright on this box (set PANEL_PLAYWRIGHT_ROOT)");
    process.exit(2);
  }
  mkdirSync(OUT, { recursive: true });
  const work = mkdtempSync(path.join(os.tmpdir(), "wtgui-thinking-stream-"));
  const roots = [path.join(work, "rootA")];
  const repo = path.join(roots[0], "proj");
  let sandbox = null;
  let gw = null;
  let browser = null;
  const out = { tree: TREE, checks: results, phases: {}, errors: [], thoughtA: THOUGHT_A, thoughtB: THOUGHT_B, answer: ANSWER };
  try {
    mkdirSync(path.join(repo, "docs"), { recursive: true });
    git(["init", "-q", "-b", "main"], repo);
    writeFileSync(path.join(repo, "docs", "a.md"), "# Title\n\nbody line\n");
    git(["add", "."], repo);
    git(["commit", "-q", "-m", "first"], repo);

    gw = makeGateway();
    const gwPort = await gw.listen();
    sandbox = await startPanel({
      dir: work,
      // Boot the checkout named by --root (a `git archive` of another commit) rather than the one beside this file:
      // without this the base-tree run would quietly measure this tree and report the fix as a failure.
      root: TREE,
      config: {
        scanRoots: roots,
        projects: [],
        refreshSeconds: 30,
        worktreeSeconds: 60,
        midSeconds: 60,
        dormantSeconds: 60,
        slowSeconds: 300,
        fetchSeconds: -1,
        assistant: { enabled: false },
        remoteBranchPolicy: "local-only",
        defaultCwd: repo,
        apiServer: { url: `http://127.0.0.1:${gwPort}`, key: "probe" },
      },
      env: { API_SERVER_KEY: "" },
    });
    console.log(`panel ${sandbox.base} (${TREE})`);

    const thread = "think-stream";
    const spawn = async () => {
      const r = await fetch(`${sandbox.base}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "probe: one stream, thinking and tools", cwd: repo, existing: true, thread }),
      }).then((x) => x.json());
      if (!r || !r.job) throw new Error(`spawn failed: ${JSON.stringify(r).slice(0, 300)}`);
      return r.job.id;
    };

    browser = await pw.chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    // The folded row's own instrument: one sample per PAINTED frame of the first thinking row, so a row that is
    // over its lid for a single frame is counted rather than missed between two polls. It reads the row's drawn
    // height, its box's content height (what the row would paint if the lid were not there), the open state and the
    // number of characters in the box. A frame is "over the lid" when the content the row holds is taller than the
    // four-line lid by more than 1 px - which on the pre-fix tree happens on every card paint and every measurement.
    await ctx.addInitScript(
      ({ thread }) => {
        const lid = (window.__lid = { frames: [], sampling: false, thread });
        const row = () => document.querySelector(`.job[data-thread="${CSS.escape(lid.thread)}"] pre.job-out .jl-think[data-think-row]`);
        lid.measure = () => {
          const r = row();
          if (!r) return null;
          const box = r.querySelector(":scope > .think-text");
          if (!box) return null;
          const cs = getComputedStyle(box);
          const maxH = parseFloat(cs.maxHeight);
          return {
            rowH: r.clientHeight,
            boxH: box.clientHeight,
            boxSH: box.scrollHeight,
            maxH: Number.isFinite(maxH) ? maxH : null,
            open: r.classList.contains("is-open"),
            aria: r.getAttribute("aria-expanded"),
            drawn: box.textContent.length,
            dots: box.textContent.endsWith("...."),
          };
        };
        lid.start = () => {
          lid.frames = [];
          const tick = () => {
            const m = lid.measure();
            if (m) lid.frames.push({ t: Math.round(performance.now()), ...m });
            if (lid.sampling) requestAnimationFrame(tick);
          };
          lid.sampling = true;
          requestAnimationFrame(tick);
        };
        lid.stop = () => {
          lid.sampling = false;
          return lid.frames;
        };
        lid.reset = () => {
          lid.frames = [];
        };
        // The reader's press, sampled the same way: one sample per painted frame of the FIRST thinking row while it
        // is open, so a delta or a card rebuild that closed it is counted rather than missed between two polls.
        const opened = (window.__open = { frames: [], sampling: false, thread });
        opened.measure = () => {
          const r = document.querySelectorAll(`.job[data-thread="${CSS.escape(opened.thread)}"] pre.job-out .jl-think[data-think-row]`)[0];
          const box = r?.querySelector(":scope > .think-text");
          if (!r || !box) return null;
          return {
            open: r.classList.contains("is-open"),
            aria: r.getAttribute("aria-expanded"),
            drawn: box.textContent.length,
            boxH: box.clientHeight,
            boxSH: box.scrollHeight,
          };
        };
        opened.start = () => {
          opened.frames = [];
          const tick = () => {
            const m = opened.measure();
            if (m) opened.frames.push({ t: Math.round(performance.now()), ...m });
            if (opened.sampling) requestAnimationFrame(tick);
          };
          opened.sampling = true;
          requestAnimationFrame(tick);
        };
        opened.stop = () => {
          opened.sampling = false;
          return opened.frames;
        };
      },
      { thread },
    );
    const page = await ctx.newPage();
    page.on("pageerror", (e) => out.errors.push(String((e && e.message) || e).slice(0, 240)));
    // The sandbox has no session store. Empty until the settled phase, which answers with the stamps the page recorded.
    let storeBlocks = [];
    await page.route("**/api/thinking**", (route) => route.fulfill({ json: { blocks: storeBlocks, error: null } }));
    await page.goto(sandbox.base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.jobs, null, { timeout: 30_000 });

    const reveal = async () =>
      page.evaluate((p) => {
        const n2 = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
        const row = [...state.rows.values()].find((r) => n2(r.path) === p);
        if (!row) return false;
        state.expandedProjects.add(row.project);
        state.expanded.add(`${row.project}::${row.path}`);
        renderAll();
        return true;
      }, norm(repo));

    // The 🧠 must be on for the reasoning rows to be drawn at all.
    await page.evaluate((t) => localStorage.setItem(`wtgui.think.${t}`, "1"), thread);
    await reveal();
    const jobId = await spawn();
    await reveal();
    await page.waitForSelector(`.job[data-thread="${thread}"] pre.job-out`, { timeout: 60_000 });
    // The row's frames are collected from here, before the first delta, so the whole growth of the folded row is
    // sampled and not only the moment a poll happened to look.
    await page.evaluate(() => window.__lid.start());

    // ---- the live mark starts with the first delta ------------------------------------------------------
    const started = Date.now();
    let sawMark = false;
    while (Date.now() - started < 20_000) {
      const s = await readConsole(page, thread);
      if (s.found && s.liveMarks > 0) {
        sawMark = true;
        break;
      }
      if (s.found && s.thinkRows > 0 && s.liveMarks === 0) break;
      await sleep(120);
    }
    check("the still-thinking mark appears in the console while reasoning arrives", sawMark);
    const live = await readConsole(page, thread);
    out.phases.live = live;
    check("the mark is inside the thinking row, not a separate pane", live.found && live.liveMarks === 1 && live.thinkRows === 1, why(live));

    // ---- a press opens the live row, and it stays open while the thought grows --------------------------
    // The reader's press is the ONLY writer of `is-open`; a delta or a state frame must not close it (nor open a row
    // they left folded, which the frame case below measures). One press here, one sample per painted frame through
    // the next deltas and a card rebuild forced in the middle, then the press again to fold it for that case.
    const thinkBox = `.job[data-thread="${thread}"] .jl-think .think-text`;
    await page.click(thinkBox);
    await page.evaluate(() => window.__open.start());
    await sleep(600);
    await page.evaluate((t) => {
      const el = document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
      if (el) delete el.dataset.sig; // a signature is the card's own reason to repaint; a caller may not fake one
      renderConversation(t);
    }, thread);
    await sleep(600);
    const openFrames = await page.evaluate(() => window.__open.stop());
    const openStats = {
      frames: openFrames.length,
      closed: openFrames.filter((f) => !f.open || f.aria !== "true").length,
      first: openFrames.length ? openFrames[0].drawn : null,
      last: openFrames.length ? openFrames[openFrames.length - 1].drawn : null,
      peak: openFrames.length ? Math.max(...openFrames.map((f) => f.drawn)) : null,
      peakBox: openFrames.length ? Math.max(...openFrames.map((f) => f.boxSH)) : null,
    };
    out.phases.openGrowth = openStats;
    check(
      "a press opens the live row, and it stays open while the thought grows through a card rebuild",
      openStats.frames > 1 && openStats.closed === 0 && openStats.peak > openStats.first,
      JSON.stringify(openStats),
    );
    // Fold it again: the frame case below is about a row the reader left folded. Its frames before this point were
    // the open row's, so the folded sampler starts from here.
    await page.click(thinkBox);
    await page.evaluate(() => window.__lid.reset());

    // ---- it stops at the first tool, and the call is drawn after the thought ------------------------------
    const stop = Date.now();
    let atTool = null;
    while (Date.now() - stop < 25_000) {
      const s = await readConsole(page, thread);
      const groupAt = order(s.rows, (r) => !r.think && /tgrp/.test(r.kind))[0];
      if (groupAt != null && groupAt >= 0) {
        atTool = s;
        break;
      }
      await sleep(120);
    }
    out.phases.atTool = atTool;
    check("a tool call is drawn in the same stream", Boolean(atTool), atTool ? why(atTool) : "no tool group");
    check("the mark stops at the first tool", Boolean(atTool) && atTool.liveMarks === 0, atTool ? `marks ${atTool.liveMarks}` : "no tool group");
    const thinkAt = order(atTool?.rows || [], (r) => r.think)[0];
    const groupAt = order(atTool?.rows || [], (r) => !r.think && /tgrp/.test(r.kind))[0];
    check("the thought is above the call it led to", thinkAt != null && groupAt != null && thinkAt < groupAt, `think ${thinkAt}, group ${groupAt}`);

    // ---- the next thought after the result is a NEW row ---------------------------------------------------
    const second = Date.now();
    let two = null;
    while (Date.now() - second < 25_000) {
      const s = await readConsole(page, thread);
      if (s.thinkRows >= 2) {
        two = s;
        break;
      }
      await sleep(120);
    }
    out.phases.twoThoughts = two;
    check("reasoning that resumes after a call starts a NEW row", Boolean(two) && two.thinkRows === 2, two ? why(two) : "one thought only");
    const thoughtRows = (two?.rows || []).filter((r) => r.think).map((r) => r.text);
    check(
      "the first row keeps the first thought and the second row carries the second",
      thoughtRows.length === 2 && thoughtRows[0].includes("First, read the fixture") && thoughtRows[1].includes("The read came back"),
      JSON.stringify(thoughtRows.map((t) => t.slice(0, 48))),
    );
    const firstGroup = order(two?.rows || [], (r) => !r.think && /tgrp/.test(r.kind))[0];
    const secondThink = order(two?.rows || [], (r) => r.think)[1];
    check("the new thought is drawn below the call it followed", secondThink != null && firstGroup != null && secondThink > firstGroup, `group ${firstGroup}, think ${secondThink}`);

    // ---- one copy of each thought, and no pane -------------------------------------------------------------
    check("no separate brain pane on the card", Boolean(two) && two.pane === false);
    check(
      "each thought is drawn exactly once",
      occurrences(two?.text || "", "First, read the fixture") === 1 && occurrences(two?.text || "", "The read came back") === 1,
      `first ${occurrences(two?.text || "", "First, read the fixture")}, second ${occurrences(two?.text || "", "The read came back")}`,
    );

    // ---- dim, minimized, and a press opens it --------------------------------------------------------------
    // A minimized row draws its first section (here: the whole long first paragraph, so the four-line lid cuts it)
    // and marks the cut with four dots; the source is still the whole thought on data-ltext (queue row #292).
    check(
      "the thinking row draws its first section inside the four-line lid, marked with the four dots",
      Boolean(two?.clip) && two.clip.overflowY === "hidden" && two.clip.ends === true && two.clip.source === THOUGHT_A && two.clip.clientHeight <= parseFloat(two.clip.maxHeight) + 1,
      two?.clip ? JSON.stringify({ ends: two.clip.ends, source: two.clip.source === THOUGHT_A, clientHeight: two.clip.clientHeight, maxHeight: two.clip.maxHeight }) : "no row",
    );
    check("the row's clip is finite at the console's leading", Boolean(two?.clip) && /px$/.test(two.clip.maxHeight) && parseFloat(two.clip.maxHeight) > 0, two?.clip ? two.clip.maxHeight : "no row");
    // ---- the folded row never paints past its lid ---------------------------------------------------------
    // The reader's bug: a FOLDED thinking row flashes the whole thought and re-folds on the reasoning events. The
    // invariant is about what the row PAINTS at every frame the stream drew, not about what a poll happens to catch:
    // the row's drawn height and the content its box holds are both inside the four-line lid, and the row never gains
    // is-open on its own. `boxSH` is the content height of the box, i.e. what the row would paint if the lid were not
    // there, so a box holding the whole section - the measuring write, or a card rebuild that drew the source text -
    // counts as over the lid even though the CSS clip holds the row itself at four lines.
    const lidStats = (frames) => {
      const lids = frames.map((f) => f.maxH).filter((n) => Number.isFinite(n) && n > 0);
      const lid = lids.length ? Math.min(...lids) : null;
      const over = lid == null ? [] : frames.filter((f) => f.boxSH > lid + 1);
      const tall = lid == null ? [] : frames.filter((f) => f.rowH > lid + 1);
      const opened = frames.filter((f) => f.open || f.aria === "true");
      return {
        lid,
        frames: frames.length,
        overLid: over.length,
        tall: tall.length,
        opened: opened.length,
        peakContent: frames.length ? Math.max(...frames.map((f) => f.boxSH)) : null,
        peakRow: frames.length ? Math.max(...frames.map((f) => f.rowH)) : null,
        peakDrawn: frames.length ? Math.max(...frames.map((f) => f.drawn)) : null,
        firstOver: over[0] ? { boxSH: over[0].boxSH, boxH: over[0].boxH, drawn: over[0].drawn, dots: over[0].dots, maxH: over[0].maxH } : null,
      };
    };
    // The row reaches its lid while the thought is still arriving - the moment the reader's report is about - and a
    // card rebuild is forced THERE, in the middle of the stream: a rebuild is how the row is drawn again from its
    // source text whenever the page is handed a new version of the card, which is once per state frame of a live turn.
    const lidAt = Date.now();
    let reached = null;
    while (Date.now() - lidAt < 25_000) {
      const s = await readConsole(page, thread);
      const m = await page.evaluate(() => window.__lid.measure());
      if (s.thinkRows > 0 && s.liveMarks === 0) break;
      if (m && m.maxH && m.rowH >= m.maxH - 1 && s.liveMarks > 0) {
        reached = m;
        break;
      }
      await sleep(60);
    }
    out.phases.lidReached = reached;
    check("the live row reaches its four-line lid while the thought is still arriving", Boolean(reached), JSON.stringify(reached));
    await page.evaluate((t) => {
      const el = document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
      if (el) delete el.dataset.sig; // a signature is the card's own reason to repaint; a caller may not fake one
      renderConversation(t);
    }, thread);
    await sleep(700);
    const liveLid = lidStats(await page.evaluate(() => window.__lid.stop()));
    out.phases.liveLid = liveLid;
    out.folded = liveLid;
    check(
      "no frame painted the folded row past its lid, across the stream and the card rebuild in it",
      liveLid.frames > 0 && liveLid.overLid === 0 && liveLid.tall === 0 && liveLid.opened === 0,
      JSON.stringify(liveLid),
    );
    if (liveLid.overLid) await page.screenshot({ path: path.join(OUT, "folded-row-over-lid.png") }).catch(() => {});

    await page.click(`.job[data-thread="${thread}"] .jl-think .think-text`);
    const opened = await readConsole(page, thread);
    out.phases.opened = opened;
    check("a press on the row opens the whole thought in place", opened.open === true && opened.clip && opened.clip.drawn === opened.clip.source && !opened.clip.drawn.endsWith("...."), `open ${opened.open}, same ${opened.clip ? opened.clip.drawn === opened.clip.source : false}`);

    // ---- the settled read: store blocks replace the previews, once each -------------------------------------
    // Wait for the run to settle in the page.
    const settleAt = Date.now();
    let stateOf = null;
    while (Date.now() - settleAt < 40_000) {
      stateOf = await page.evaluate((id) => {
        const j = state.jobs.get(id);
        return j ? { status: j.status, endedAt: j.endedAt } : null;
      }, jobId);
      if (stateOf && stateOf.status && !["running", "starting", "waiting", "waiting_for_approval", "queued"].includes(stateOf.status)) break;
      await sleep(200);
    }
    check("the run settled in the page", Boolean(stateOf) && ["done", "completed", "failed", "cancelled", "interrupted"].includes(stateOf.status), JSON.stringify(stateOf));

    // The store's own stamps: an assistant message is written 10-110 ms BEFORE the call it made, so each block is
    // placed by the line it led to. The page recorded those line stamps; answer the settled read with them.
    const stamps = await page.evaluate((id) => {
      const lines = jobLines(id).filter((l) => l && !l.preview);
      return lines.map((l) => ({ kind: l.kind, at: Number(l.at) || 0, text: String(l.text || "").slice(0, 40) }));
    }, jobId);
    const toolLine = stamps.find((l) => l.kind === "tool");
    const textLine = stamps.find((l) => l.kind === "text");
    storeBlocks = [
      { at: Math.max(1, (toolLine?.at || Date.now()) - 40), text: THOUGHT_A },
      { at: Math.max(1, (textLine?.at || Date.now()) - 40), text: THOUGHT_B },
    ];
    out.phases.storeBlocks = storeBlocks;
    out.phases.lineStamps = stamps;
    // Drive the shipped settled read directly (the sweep would do it within 500 ms; this makes the moment exact).
    await page.evaluate(async (id) => {
      const turn = state.jobs.get(id);
      if (turn) await loadThinking(turn);
    }, jobId);
    await sleep(500);
    const settled = await readConsole(page, thread);
    out.phases.settled = settled;
    check("the settled console keeps exactly two thinking rows", settled.thinkRows === 2, why(settled));
    check("the live previews are gone, so no thought is drawn twice", settled.liveMarks === 0 && occurrences(settled.text, "First, read the fixture") === 1 && occurrences(settled.text, THOUGHT_B) === 1, `marks ${settled.liveMarks}, A ${occurrences(settled.text, "First, read the fixture")}, B ${occurrences(settled.text, THOUGHT_B)}`);
    const settledThink = order(settled.rows, (r) => r.think);
    const settledGroup = order(settled.rows, (r) => !r.think && /tgrp/.test(r.kind))[0];
    const settledText = settled.rows.findIndex((r) => r.text.includes(ANSWER));
    check(
      "settled order is block, then that message's tools, then the next block",
      settledThink.length === 2 && settledGroup != null && settledText >= 0 && settledThink[0] < settledGroup && settledGroup < settledThink[1] && settledThink[1] < settledText,
      `think ${settledThink.join(",")}, group ${settledGroup}, answer at ${settledText}`,
    );

    // ---- a reload of the settled turn reproduces it ----------------------------------------------------------
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.jobs, null, { timeout: 30_000 });
    const revealReady = async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 30_000) {
        const there = await page.evaluate((t) => Boolean(document.querySelector(`.job[data-thread="${CSS.escape(t)}"] pre.job-out`)), thread);
        if (there) return true;
        await reveal();
        await sleep(300);
      }
      return false;
    };
    const arrived = await revealReady();
    if (!arrived) {
      const diag = await page.evaluate((id) => ({
        jobs: state.jobs.size,
        hasJob: state.jobs.has(id),
        threads: [...new Set([...state.jobs.values()].map((j) => j.thread))].slice(0, 10),
        cards: [...document.querySelectorAll(".job[data-thread]")].map((n) => n.dataset.thread).slice(0, 10),
      }), jobId);
      out.phases.reloadDiagnostics = diag;
    }
    check("the settled turn is on the page after a reload", arrived, arrived ? "card drawn" : JSON.stringify(out.phases.reloadDiagnostics));
    await page.waitForSelector(`.job[data-thread="${thread}"] pre.job-out`, { timeout: arrived ? 5_000 : 1 }).catch(() => {});
    const reloadAt = Date.now();
    let reloaded = null;
    while (Date.now() - reloadAt < 25_000) {
      const s = await readConsole(page, thread);
      if (s.thinkRows === 2) {
        reloaded = s;
        break;
      }
      await sleep(200);
    }
    out.phases.reloaded = reloaded;
    check("a settled reload reproduces both thoughts", Boolean(reloaded) && reloaded.thinkRows === 2, reloaded ? why(reloaded) : "none drawn");
    check(
      "…with one copy of each and no mark",
      Boolean(reloaded) && reloaded.liveMarks === 0 && occurrences(reloaded.text, "First, read the fixture") === 1 && occurrences(reloaded.text, THOUGHT_B) === 1,
      reloaded ? `marks ${reloaded.liveMarks}, A ${occurrences(reloaded.text, "First, read the fixture")}, B ${occurrences(reloaded.text, THOUGHT_B)}` : "none drawn",
    );

    // ---- the narrow dock: the console is still readable ------------------------------------------------------
    await page.setViewportSize({ width: 460, height: 900 });
    await sleep(400);
    const narrow = await readConsole(page, thread);
    out.phases.narrow = narrow;
    check("the console is readable at a 460 px viewport", narrow.found && narrow.width.client > 120 && narrow.width.scroll <= narrow.width.client + 2, JSON.stringify(narrow.width));
    await page.screenshot({ path: path.join(OUT, "narrow-console.png") }).catch(() => {});
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.screenshot({ path: path.join(OUT, "settled-console.png") }).catch(() => {});

    if (out.errors.length) check("the page threw nothing", false, out.errors.join(" | "));
    else check("the page threw nothing", true);
  } catch (e) {
    check(`the run completed: ${String((e && e.message) || e).slice(0, 240)}`, false);
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
    try {
      await sandbox?.stop();
    } catch {
      /* ignore */
    }
    try {
      await gw?.close();
    } catch {
      /* ignore */
    }
    try {
      writeFileSync(path.join(OUT, "results.json"), JSON.stringify(out, null, 2));
    } catch {
      /* ignore */
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed - ${path.join(OUT, "results.json")}`);
  process.exit(failed ? 1 : 0);
};

main();
