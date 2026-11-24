#!/usr/bin/env node
// No thinking row may begin mid-sentence, and no drawn thought may lose a character it was handed.
//
//   node tools/verify-think-prefix.mjs                       # this checkout
//   node tools/verify-think-prefix.mjs --root <dir>          # a `git archive` of another build (expected to fail)
//   node tools/verify-think-prefix.mjs --out <dir>           # where results.json goes
//
// WHAT THIS PINS (queue row #285). The reader's screenshot showed a row drawn as
//   : "worker briefs: targeted tests only; cancel suite runs past 20 min." Not related.
// - it began in the MIDDLE of a thought: the block's own first words, and the sentence this fragment belongs to,
// were not on screen at all. That is a dropped PREFIX, not a bottom clip: the row's clip keeps four lines from the
// TOP (the first line on screen is the thought's first line and only the bottom is cut), and nothing in the
// stylesheet indents, re-orders or left-clips the row.
//
// THE SOURCE, and the shape that produces the defect. The store keeps ONE block per ASSISTANT MESSAGE; the live
// stream draws ONE row per SEGMENT, cut at every tool boundary (row #276's decision). So the page and the store
// disagree about how many pieces one thought has, and the read that lands while they disagree is what this gate
// scripts, at a named moment:
//
//   1. the turn's first thought is complete on screen (row P1), and the store holds it as block B1;
//   2. reasoning resumes after the call: a SECOND row (P2), still being written;
//   3. a store read lands now - message 2's block is not written yet, so `fresh` is [B1] while the page holds two
//      previews. The old reconcile matched them BY COUNT from the tail: P1 took B1's text and P2 was dropped from
//      the cache while its row stayed on screen;
//   4. the next delta of that same segment arrives. growLiveThought finds no preview under that `at` any more and
//      rebuilds the row from the delta alone - so the row loses everything it had already drawn and begins
//      mid-sentence, which is the reader's screenshot.
//
// WHAT IS CHECKED, character for character:
//   (1) every drawn row is a PREFIX of its own source at every moment it is drawn (a row that grows from its first
//       character passes; a row rebuilt from a later delta fails on the spot);
//   (2) the first character of every block reaches the DOM;
//   (3) the clip is a BOTTOM clip: scrollTop 0, scrollLeft 0, four lines visible, the first line on screen is the
//       thought's first line, and the press reveals the rest;
//   (4) after settle, every row equals its store block EXACTLY, once each, in order.
//
// WHAT IS DRIVEN. A sandbox panel of its own (tools/panel-testkit.mjs: own PANEL_CONFIG / HERMES_HOME / jobs.json -
// the reader's store is never touched) and a stub Runs API playing the turn over REAL SSE. /api/thinking is answered
// by this gate with the store's own shape and moved by the gate's clock, so the disagreement above happens on a
// named step instead of at whatever moment a 1.2 s poll happens to land.
//
// Exit codes: 0 every assertion held; 1 one failed; 2 the run could not measure what it claims (no Playwright).
//
// HARNESS: LIVE GATE - it boots the shipped server and drives the shipped page, and its claim is about the page's
// behaviour, not about a recording of it.
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
const OUT = opt("--out", path.join(os.tmpdir(), "wag", "think-prefix"));

// The first thought is longer than four console lines on purpose: the clip has to have a bottom to cut.
const THOUGHT_A = [
  "First, read the fixture: one file, one heading.",
  "The row is clipped at four lines of the console's own leading, so this thought is longer than that on purpose.",
  "Line three says the same thing again, so the scrollHeight is measurably past the clip.",
  "Line four is still on screen, and only the bottom of this thought may be cut.",
  "Line five is hidden until the reader presses the row.",
  "Line six is hidden too.",
  "Line seven ends the thought.",
].join("\n");
// The thought that resumes AFTER the call, and it begins mid-sentence on purpose: this is the reader's own fragment,
// so a row that begins anywhere else - or that loses its own first words - is the defect, not a style choice.
const THOUGHT_B = ': "worker briefs: targeted tests only; cancel suite runs past 20 min." Not related.';
const THOUGHT_B_MORE = " Maybe the panel's worker toolset excludes delegate_task?";
const ANSWER = "The fixture's heading is Title and the body is one line.";

// ---- the scripted turn -----------------------------------------------------------------------------------
// Emitted one step at a time, on the gate's own permission (`allow`), so the store read below lands on a named
// moment rather than wherever a poll happens to fire.
const SCRIPT = [
  { event: "reasoning.delta", delta: "First, read the fixture: one file, one heading.\n" },
  { event: "reasoning.delta", delta: "The row is clipped at four lines of the console's own leading, so this thought is longer than that on purpose.\n" },
  { event: "reasoning.delta", delta: "Line three says the same thing again, so the scrollHeight is measurably past the clip.\n" },
  { event: "reasoning.delta", delta: "Line four is still on screen, and only the bottom of this thought may be cut.\n" },
  { event: "reasoning.delta", delta: "Line five is hidden until the reader presses the row.\nLine six is hidden too.\nLine seven ends the thought." },
  { event: "tool.started", tool: "read_file", preview: "docs/a.md" },
  { event: "tool.completed", tool: "read_file", duration: 0.21, preview: "# Title\n\nbody line\n" },
  { event: "reasoning.delta", delta: ': "worker briefs: targeted tests only;' }, // 7 - P2 begins here
  { event: "reasoning.delta", delta: ' cancel suite runs past 20 min." Not related.' }, // 8
  { event: "reasoning.delta", delta: THOUGHT_B_MORE }, // 9 - the same segment grows: this is the delta the drop eats
  { event: "tool.started", tool: "grep", preview: "delegate_task" }, // 10
  { event: "tool.completed", tool: "grep", duration: 0.12, preview: "server.js:101\n" }, // 11
  { event: "message.delta", delta: `\n\n${ANSWER}` },
  { event: "run.completed", output: ANSWER, usage: { total_tokens: 4200, input_tokens: 3800, output_tokens: 400 } },
];
const STEP = { A_DONE: 5, B_TWO: 9, ALL: SCRIPT.length };

function makeGateway() {
  const runs = new Map();
  const ctl = { allow: 0, last: null };
  let posts = 0;
  const timers = new Set();
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/v1/capabilities") {
      return json(200, {
        version: "think-prefix-stub",
        features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true },
      });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      req.resume();
      req.on("end", () => {
        posts += 1;
        const id = `run_prefix_${posts}`;
        runs.set(id, { id, step: 0, done: false, allow: ctl.allow });
        ctl.last = id;
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
        if (rec.step >= rec.allow) return;
        const evt = SCRIPT[Math.min(rec.step, SCRIPT.length - 1)];
        rec.step += 1;
        if (evt.event === "run.completed") rec.done = true;
        res.write(`id: ${seq}\ndata: ${JSON.stringify({ ...evt, run_id: rec.id, seq: seq++, timestamp: Date.now() / 1000 })}\n\n`);
        if (rec.done) {
          clearInterval(timer);
          timers.delete(timer);
          setTimeout(() => res.end(), 400);
        }
      }, 60);
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
    allow: (n) => {
      ctl.allow = n;
      const rec = runs.get(ctl.last);
      if (rec) rec.allow = n;
    },
    step: () => runs.get(ctl.last)?.step ?? 0,
    close: () =>
      new Promise((r) => {
        for (const h of timers) clearInterval(h);
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

// ---- helpers ---------------------------------------------------------------------------------------------
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
const clip = (s, n = 72) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

// Every drawn thought row, exactly as the DOM holds it, plus the box that clips it. `text` is the row's OWN words:
// the `.think-text` span when it is there, the row's own text nodes when a paint has flattened it, and never the
// live mark's "thinking 12s".
const readRows = (page, thread) =>
  page.evaluate((t) => {
    const card = document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
    const out = card?.querySelector("pre.job-out");
    if (!out) return [];
    const own = (row) => {
      const span = row.querySelector(":scope > .think-text");
      if (span) return span.textContent;
      let s = "";
      for (const n of row.childNodes) if (n.nodeType === 3) s += n.data;
      return s;
    };
    return [...out.querySelectorAll(".jl-think")].map((row) => {
      const box = row.querySelector(":scope > .think-text") || row;
      const cs = getComputedStyle(box);
      return {
        lid: row.dataset.lid || "",
        text: own(row),
        open: row.classList.contains("is-open"),
        scrollTop: box.scrollTop,
        scrollLeft: box.scrollLeft,
        clientHeight: box.clientHeight,
        scrollHeight: box.scrollHeight,
        overflowY: cs.overflowY,
        maxHeight: cs.maxHeight,
        marks: row.querySelectorAll("[data-think-live]").length,
      };
    });
  }, thread);

const main = async () => {
  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN: no playwright on this box (set PANEL_PLAYWRIGHT_ROOT)");
    process.exit(2);
  }
  mkdirSync(OUT, { recursive: true });
  const work = mkdtempSync(path.join(os.tmpdir(), "wtgui-think-prefix-"));
  const root = path.join(work, "rootA");
  const repo = path.join(root, "proj");
  let sandbox = null;
  let gw = null;
  let browser = null;
  const out = { tree: TREE, checks: results, phases: {}, errors: [], thoughtA: THOUGHT_A, thoughtB: THOUGHT_B, answer: ANSWER, samples: [] };
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
      root: TREE,
      config: {
        scanRoots: [root],
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

    const thread = "think-prefix";
    const spawn = async () => {
      const r = await fetch(`${sandbox.base}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "probe: a thought that resumes after a tool", cwd: repo, existing: true, thread }),
      }).then((x) => x.json());
      if (!r || !r.job) throw new Error(`spawn failed: ${JSON.stringify(r).slice(0, 300)}`);
      return r.job.id;
    };

    browser = await pw.chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => out.errors.push(String((e && e.message) || e).slice(0, 240)));
    // The store's own shape: ONE block per assistant message, written when that message produced its call. `store`
    // is moved by the gate at the two named moments below - msg1's block after its thought is complete, and message
    // 2's block only at settle, because its thought is still streaming until then.
    const store = { blocks: [], msg1At: 0 };
    let storeReads = 0;
    await page.route("**/api/thinking**", (route) => {
      storeReads += 1;
      route.fulfill({ json: { blocks: store.blocks.map((b) => ({ at: b.at, text: b.text })), error: null } });
    });
    // Every live reasoning frame, as the wire sent it: the accumulated text for an `at` is the source a row grows from.
    await page.addInitScript(() => {
      window.__thinkFrames = [];
      const hook = () => {
        if (typeof window.appendJobLine !== "function" || window.appendJobLine.__hooked) return false;
        const orig = window.appendJobLine;
        window.appendJobLine = function (evt) {
          const l = evt && evt.line;
          if (l && (l.think || l.thinkEnd)) {
            window.__thinkFrames.push({ id: evt.id, at: Number(l.at) || 0, from: Number(l.thinkFrom) || 0, think: String(l.think || ""), end: Boolean(l.thinkEnd), t: Date.now() });
          }
          return orig.apply(this, arguments);
        };
        window.appendJobLine.__hooked = true;
        return true;
      };
      if (!hook()) {
        const timer = setInterval(() => {
          if (hook()) clearInterval(timer);
        }, 20);
      }
    });
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

    await page.evaluate((t) => localStorage.setItem(`wtgui.think.${t}`, "1"), thread);
    await reveal();
    const jobId = await spawn();
    await reveal();
    await page.waitForSelector(`.job[data-thread="${thread}"] pre.job-out`, { timeout: 60_000 });

    // ---- sample every state the console is left in --------------------------------------------------------
    // A mutation batch plus a timer: the row is read whenever it changes, so a rebuild from a later delta cannot slip
    // between two samples. Each change of a row's own words is recorded with the box that clips it.
    await page.evaluate((t) => {
      window.__rows = [];
      const snap = () => {
        const card = document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
        const out = card?.querySelector("pre.job-out");
        if (!out) return;
        for (const row of out.querySelectorAll(".jl-think")) {
          const span = row.querySelector(":scope > .think-text");
          let text = "";
          if (span) text = span.textContent;
          else for (const n of row.childNodes) if (n.nodeType === 3) text += n.data;
          const box = span || row;
          const prev = window.__rows[window.__rows.length - 1];
          if (prev && prev.lid === (row.dataset.lid || "") && prev.text === text) continue;
          const cs = getComputedStyle(box);
          window.__rows.push({
            lid: row.dataset.lid || "",
            text,
            open: row.classList.contains("is-open"),
            scrollTop: box.scrollTop,
            scrollLeft: box.scrollLeft,
            clientHeight: box.clientHeight,
            scrollHeight: box.scrollHeight,
            overflowY: cs.overflowY,
            maxHeight: cs.maxHeight,
            t: Date.now(),
          });
        }
      };
      const mo = new MutationObserver(snap);
      const card = document.querySelector(`.job[data-thread="${CSS.escape(t)}"] pre.job-out`);
      if (card) mo.observe(card, { subtree: true, childList: true, characterData: true, attributes: true });
      window.__snap = snap;
      setInterval(snap, 100);
    }, thread);

    const waitFor = async (fn, ms = 20_000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const v = await fn();
        if (v) return v;
        await sleep(60);
      }
      return null;
    };

    // ---- 1: the first thought, whole, with nothing in the store yet ----------------------------------------
    gw.allow(STEP.A_DONE);
    const rowA = await waitFor(async () => (await readRows(page, thread)).find((r) => r.text === THOUGHT_A));
    check("the first thought is drawn whole, from its first character", Boolean(rowA), rowA ? clip(rowA.text, 48) : "not drawn");
    out.phases.rowA = rowA;

    // The store writes message 1's block now: stamped just before the call, which is what the real store does.
    const callAt = await page.evaluate((id) => {
      const lines = jobLines(id).filter((l) => l && !l.preview);
      const first = lines.find((l) => l.kind === "tool");
      return first ? Number(first.at) || 0 : 0;
    }, jobId);
    store.msg1At = Math.max(1, (callAt || Date.now()) - 40);

    // ---- 2: the thought that resumes after the call is its own row ----------------------------------------
    gw.allow(STEP.B_TWO);
    const rowB = await waitFor(async () => (await readRows(page, thread)).find((r) => r.text === THOUGHT_B));
    check("the thought that resumes after the call is a NEW row, complete", Boolean(rowB), rowB ? JSON.stringify(clip(rowB.text, 48)) : "not drawn");
    out.phases.rowB = rowB;
    const twoRows = await readRows(page, thread);
    check("two rows are on screen when the store still holds one block", twoRows.length === 2, `rows ${twoRows.length}`);

    // ---- 3: the read that lands on that disagreement -------------------------------------------------------
    // The store has message 1's block and message 2's thought is still streaming, which is the state every live turn
    // passes through. This is the read the page's own cue and its sweep make; here it is made on a named moment.
    store.blocks = [{ at: store.msg1At, text: THOUGHT_A }];
    await page.evaluate(async (id) => {
      const turn = state.jobs.get(id);
      if (turn) await loadThinking(turn);
    }, jobId);
    await sleep(250);
    const afterRead = await readRows(page, thread);
    out.phases.afterRead = afterRead.map((r) => ({ lid: r.lid, len: r.text.length, text: clip(r.text, 48) }));
    check(
      "a store read with one block does not take the live row's words away",
      afterRead.length === 2 && afterRead.some((r) => r.text === THOUGHT_A) && afterRead.some((r) => r.text === THOUGHT_B),
      JSON.stringify(out.phases.afterRead),
    );

    // ---- 4: the same segment grows, and the row must keep everything it had -------------------------------
    gw.allow(SCRIPT.length);
    const rowBGrown = await waitFor(async () => (await readRows(page, thread)).find((r) => r.text === THOUGHT_B + THOUGHT_B_MORE));
    const nowRows = await readRows(page, thread);
    check("the row keeps its own first words as the thought grows", Boolean(rowBGrown), rowBGrown ? clip(rowBGrown.text, 60) : `took ${clip(nowRows.map((r) => r.text).join(" | "), 160)}`);

    // ---- wait for the run to settle ------------------------------------------------------------------------
    const settleAt = Date.now();
    let stateOf = null;
    while (Date.now() - settleAt < 45_000) {
      stateOf = await page.evaluate((id) => {
        const j = state.jobs.get(id);
        return j ? { status: j.status, endedAt: j.endedAt } : null;
      }, jobId);
      if (stateOf && stateOf.status && !["running", "starting", "waiting", "waiting_for_approval", "queued"].includes(stateOf.status)) break;
      await sleep(200);
    }
    check("the run settled in the page", Boolean(stateOf) && ["done", "completed", "failed", "cancelled", "interrupted"].includes(stateOf.status), JSON.stringify(stateOf));

    const frames = await page.evaluate(() => window.__thinkFrames || []);
    const samples = await page.evaluate(() => window.__rows || []);
    out.frames = frames;
    out.samples = samples;
    out.phases.storeReads = storeReads;

    // The wire's text for each segment, in arrival order: what the page was handed for that `at`. This is the row's
    // own source while it is live, and every drawn row must grow from its first character out of this string.
    const wire = new Map();
    for (const f of frames) {
      if (!f.at) continue;
      const cur = wire.get(f.at) || "";
      if (f.from > 0 && f.from === cur.length) wire.set(f.at, cur + f.think);
      else if (f.think) wire.set(f.at, f.from === 0 ? f.think : cur.slice(0, f.from) + f.think);
    }
    out.phases.wire = [...wire.entries()].map(([at, text]) => ({ at, len: text.length, head: clip(text, 48) }));
    // A row's own source while it is live is the WIRE text for its `at` (its segment); the BLOCK it belongs to is the
    // one store message that contains that segment. Both are checked: the row grows from its segment's first
    // character, and every word it shows is a slice of the store's own text.
    const BLOCKS = [THOUGHT_A, THOUGHT_B + THOUGHT_B_MORE];
    const wireOf = (lid) => wire.get(Number(String(lid).replace(/^think:/, "")) || 0) || "";
    const blockOf = (lid) => {
      const w = wireOf(lid).slice(0, 24);
      return w ? BLOCKS.find((b) => b.includes(w)) || "" : "";
    };

    // ---- (1) every row is a PREFIX of its own source, and never loses a character it drew -------------------
    // LIVE rows only: a row whose lid is one of the wire's segments. The settled rows carry the store's stamps
    // instead, and they are checked exactly, block by block, at the end.
    const rowSamples = samples.filter((s) => s.lid && s.text && Number(String(s.lid).replace(/^think:/, "")) && wire.has(Number(String(s.lid).replace(/^think:/, ""))));
    out.phases.rowLids = [...new Set(rowSamples.map((s) => s.lid))];
    const bad = [];
    const foreign = [];
    const shrink = [];
    const lastLen = new Map();
    for (const s of rowSamples) {
      const w = wireOf(s.lid);
      if (!w.startsWith(s.text)) bad.push({ lid: s.lid, drawn: clip(s.text, 90), len: s.text.length, expected: clip(w, 90) });
      if (!BLOCKS.some((b) => b.includes(s.text))) foreign.push({ lid: s.lid, drawn: clip(s.text, 90) });
      const prev = lastLen.get(s.lid);
      if (prev != null && s.text.length < prev) shrink.push({ lid: s.lid, from: prev, to: s.text.length, drawn: clip(s.text, 60) });
      lastLen.set(s.lid, s.text.length);
    }
    out.phases.badSamples = bad.slice(0, 8);
    out.phases.shrunk = shrink.slice(0, 8);
    out.phases.foreign = foreign.slice(0, 8);
    check(
      "every drawn thought row is a prefix of its own source, at every moment it is on screen",
      bad.length === 0,
      bad.length ? `${bad.length} samples lost or reordered words, first: ${JSON.stringify(bad[0])}` : `${rowSamples.length} samples`,
    );
    check(
      "no drawn row ever loses a character it had already drawn",
      shrink.length === 0,
      shrink.length ? `${shrink.length} shrinks, first: ${JSON.stringify(shrink[0])}` : `${rowSamples.length} samples`,
    );
    check(
      "every word a row draws is the store's own text for that thought",
      foreign.length === 0,
      foreign.length ? `${foreign.length} samples, first: ${JSON.stringify(foreign[0])}` : `${rowSamples.length} samples`,
    );
    const heads = BLOCKS.map((b) => rowSamples.some((s) => s.text.startsWith(b[0]) && blockOf(s.lid) === b));
    check("the first character of every block reaches the DOM", heads.every(Boolean), JSON.stringify(heads));

    // ---- (3) the clip is a bottom clip of four lines, never a start clip ----------------------------------
    const clipSample = rowSamples.find((s) => s.text === THOUGHT_A) || rowSamples.find((s) => s.text.length > 200);
    out.phases.clipSample = clipSample;
    check("the four-line clip hides the bottom of a long thought", Boolean(clipSample) && clipSample.overflowY === "hidden" && clipSample.clientHeight < clipSample.scrollHeight, clipSample ? JSON.stringify({ clientHeight: clipSample.clientHeight, scrollHeight: clipSample.scrollHeight, overflowY: clipSample.overflowY, maxHeight: clipSample.maxHeight }) : "no long row");
    check("the clip is not scrolled: no left clip and no start clip", Boolean(clipSample) && clipSample.scrollTop === 0 && clipSample.scrollLeft === 0, clipSample ? `scrollTop ${clipSample.scrollTop}, scrollLeft ${clipSample.scrollLeft}` : "no long row");
    const firstLine = await page.evaluate((t) => {
      const card = document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
      const row = card && [...card.querySelectorAll(".jl-think")].find((r) => !r.classList.contains("is-open"));
      const box = row && (row.querySelector(":scope > .think-text") || row);
      if (!box) return null;
      const w = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      const first = w.nextNode();
      if (!first || !first.length) return null;
      const r = document.createRange();
      r.setStart(first, 0);
      r.setEnd(first, 1);
      const ch = r.getClientRects()[0];
      const br = box.getBoundingClientRect();
      return ch ? { delta: Math.round(ch.top - br.top), top: Math.round(ch.top), boxTop: Math.round(br.top), boxBottom: Math.round(br.bottom) } : null;
    }, thread);
    out.phases.firstLine = firstLine;
    check("the row's first line is the thought's first line (a bottom clip, not a start clip)", Boolean(firstLine) && Math.abs(firstLine.delta) <= 2, JSON.stringify(firstLine));

    // ---- (4) the settled rows equal the store's blocks, exactly, once each -------------------------------
    const calls = (
      await page.evaluate((id) => {
        const lines = jobLines(id).filter((l) => l && !l.preview);
        return lines.filter((l) => l.kind === "tool").map((l) => Number(l.at) || 0);
      }, jobId)
    ).filter(Boolean);
    store.blocks = [
      { at: store.msg1At, text: THOUGHT_A },
      { at: Math.max(1, (calls[calls.length - 1] || Date.now()) - 40), text: THOUGHT_B + THOUGHT_B_MORE },
    ];
    out.phases.storeBlocks = store.blocks;
    await page.evaluate(async (id) => {
      const turn = state.jobs.get(id);
      if (turn) await loadThinking(turn);
    }, jobId);
    await sleep(600);
    const settled = await readRows(page, thread);
    out.phases.settled = settled.map((r) => ({ lid: r.lid, len: r.text.length, head: clip(r.text, 60) }));
    const want = store.blocks.map((b) => b.text);
    check("the settled console draws one row per store block", settled.length === want.length, `rows ${settled.length}`);
    const exact = want.every((w, i) => settled[i] && settled[i].text === w);
    check(
      "each settled row's drawn text equals its store block, character for character",
      exact,
      exact ? "exact" : JSON.stringify(want.map((w, i) => ({ want: clip(w, 40), got: clip(settled[i]?.text || "", 40) }))),
    );

    // ---- the press opens the whole thought ---------------------------------------------------------------
    await page.click(`.job[data-thread="${thread}"] .jl-think .think-text`).catch(() => {});
    await sleep(200);
    const opened = await readRows(page, thread);
    const anyOpen = opened.find((r) => r.open);
    check("a press on the row opens the whole thought in place", Boolean(anyOpen) && anyOpen.scrollHeight <= anyOpen.clientHeight + 1, anyOpen ? JSON.stringify({ clientHeight: anyOpen.clientHeight, scrollHeight: anyOpen.scrollHeight }) : "no open row");

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
