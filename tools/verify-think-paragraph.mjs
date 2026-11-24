#!/usr/bin/env node
// A minimized thinking row shows the thought's FIRST PARAGRAPH, cut at the first blank line, and ends in four dots
// whenever anything is hidden (queue row #292).
//
//   node tools/verify-think-paragraph.mjs                    # this checkout
//   node tools/verify-think-paragraph.mjs --root <dir>       # a `git archive` of another build (expected to fail)
//   node tools/verify-think-paragraph.mjs --out <dir>        # where results.json goes
//
// WHAT THIS PINS. The reader's screenshot showed one expanded thinking row holding several paragraphs, with the later
// ones crossed out in red: while the row is MINIMIZED he wants only the first of them, and dots to say more is there.
// The rule, checked here on a real scripted turn:
//   (1) a thought with three paragraphs draws ONLY the first, then "...." - and no word of paragraphs two and three;
//   (2) a one-paragraph thought shorter than the lid draws itself with NO dots;
//   (3) a first paragraph longer than the four-line lid is cut at a WORD boundary and still ends in the dots, inside
//       the lid (the dots do not add a line, and the row's first line is still the thought's first line);
//   (4) a press shows every paragraph byte for byte, with no dots, live and after the store settles.
//
// WHAT IS DRIVEN. A sandbox panel of its own (tools/panel-testkit.mjs: own PANEL_CONFIG / HERMES_HOME / jobs.json, so
// the reader's store is never touched), a stub Runs API playing the turn over REAL SSE, and /api/thinking answered by
// this gate with the store's own shape at settle. The rows are read from the shipped page's DOM.
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
const OUT = opt("--out", path.join(os.tmpdir(), "wag", "think-paragraph"));

const NL = String.fromCharCode(10);
const NL2 = NL + NL;
const DOTS = "....";

// The three scripted shapes. Paragraph one is deliberately short, so only the BLANK LINE can end it.
const P1 = "First I read the row the reader sent me.";
const P2 = "Then I looked at how the row is drawn, and where its clip begins.";
const P3 = "Last, I checked that the whole thought comes back when the row is pressed.";
const THOUGHT_A = [P1, P2, P3].join(NL2);
// One paragraph, shorter than four console lines: a fully shown thought carries no dots.
const THOUGHT_B = "One short paragraph, and nothing after it.";
// A first paragraph longer than the four-line lid at any reasonable console width, so the lid has to cut it.
const LONG_SENTENCE = "The long first paragraph keeps going so that the four-line lid has to cut it, and it must stop at a word boundary rather than in the middle of one. ";
const THOUGHT_C = Array.from({ length: 9 }, (_, i) => `${LONG_SENTENCE.trim()} (${i + 1})`).join(" ");
const ANSWER = "The fixture's heading is Title and the body is one line.";

// ---- the scripted turn -----------------------------------------------------------------------------------
// Three thoughts, each in its own assistant message (a tool call follows each), so the store holds three blocks and
// every shape is drawn by the live path and again by the settled read.
const SCRIPT = [
  { event: "reasoning.delta", delta: P1 },
  { event: "reasoning.delta", delta: NL2 + P2 },
  { event: "reasoning.delta", delta: NL2 + P3 },
  { event: "tool.started", tool: "read_file", preview: "docs/a.md" },
  { event: "tool.completed", tool: "read_file", duration: 0.21, preview: "# Title" + NL2 + "body line" + NL },
  { event: "reasoning.delta", delta: THOUGHT_B },
  { event: "tool.started", tool: "grep", preview: "Title" },
  { event: "tool.completed", tool: "grep", duration: 0.12, preview: "docs/a.md:1" + NL },
  { event: "reasoning.delta", delta: THOUGHT_C.slice(0, 180) },
  { event: "reasoning.delta", delta: THOUGHT_C.slice(180) },
  { event: "message.delta", delta: NL2 + ANSWER },
  { event: "run.completed", output: ANSWER, usage: { total_tokens: 4200, input_tokens: 3800, output_tokens: 400 } },
];

function makeGateway() {
  const runs = new Map();
  let posts = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/v1/capabilities") {
      return json(200, {
        version: "think-paragraph-stub",
        features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true },
      });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      req.resume();
      req.on("end", () => {
        posts += 1;
        const id = `run_para_${posts}`;
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
      res.write(": open" + NL2);
      if (!rec) return res.end();
      let seq = 0;
      const timer = setInterval(() => {
        if (rec.step >= SCRIPT.length) return;
        const evt = SCRIPT[rec.step];
        rec.step += 1;
        if (evt.event === "run.completed") rec.done = true;
        res.write(`id: ${seq}${NL}data: ${JSON.stringify({ ...evt, run_id: rec.id, seq: seq++, timestamp: Date.now() / 1000 })}${NL2}`);
        if (rec.done) {
          clearInterval(timer);
          setTimeout(() => res.end(), 300);
        }
      }, 90);
      req.on("close", () => clearInterval(timer));
      return;
    }
    json(404, {});
  });
  return {
    listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))),
    close: () => new Promise((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
}

// ---- helpers ---------------------------------------------------------------------------------------------
const norm = (s) => String(s || "").split(String.fromCharCode(92)).join("/").toLowerCase();
const git = (args, cwd) =>
  execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@localhost", ...args], { cwd, stdio: "pipe", encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  - ${detail}` : ""}`);
  return Boolean(ok);
};
const clip = (s, n = 88) => (String(s).length > n ? `${String(s).slice(0, n)}...` : String(s));

// Every thought row as the page drew it: the SOURCE it holds (data-ltext), the words in the box, the dots, the box's
// own clip, and where its first character sits against the box's top edge.
const readRows = (page, thread) =>
  page.evaluate((t) => {
    const card = document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
    const out = card?.querySelector("pre.job-out");
    if (!out) return [];
    return [...out.querySelectorAll(".jl-think")].map((row) => {
      const box = row.querySelector(":scope > .think-text") || row;
      const more = box.querySelector(":scope > .think-more");
      const cs = getComputedStyle(box);
      const walk = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      const first = walk.nextNode();
      let delta = null;
      if (first && first.length) {
        const r = document.createRange();
        r.setStart(first, 0);
        r.setEnd(first, 1);
        const rect = r.getClientRects()[0];
        const br = box.getBoundingClientRect();
        if (rect) delta = Math.round(rect.top - br.top);
      }
      const height = box.scrollHeight;
      let noDots = null;
      if (more) {
        more.style.display = "none";
        noDots = box.scrollHeight;
        more.style.display = "";
      }
      return {
        lid: row.dataset.lid || "",
        source: row.dataset.ltext || "",
        text: box.textContent,
        dots: more ? more.textContent : "",
        dotsDisplay: more ? getComputedStyle(more).display : "",
        open: row.classList.contains("is-open"),
        scrollTop: box.scrollTop,
        scrollLeft: box.scrollLeft,
        clientHeight: box.clientHeight,
        scrollHeight: box.scrollHeight,
        height,
        heightNoDots: noDots,
        maxHeight: cs.maxHeight,
        overflowY: cs.overflowY,
        firstLine: delta,
      };
    });
  }, thread);

const stripDots = (s) => (String(s).endsWith(DOTS) ? String(s).slice(0, -DOTS.length) : String(s));

const main = async () => {
  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN: no playwright on this box (set PANEL_PLAYWRIGHT_ROOT)");
    process.exit(2);
  }
  mkdirSync(OUT, { recursive: true });
  const work = mkdtempSync(path.join(os.tmpdir(), "wtgui-think-paragraph-"));
  const root = path.join(work, "rootA");
  const repo = path.join(root, "proj");
  let sandbox = null;
  let gw = null;
  let browser = null;
  const out = { tree: TREE, checks: results, phases: {}, errors: [], thoughts: { a: THOUGHT_A, b: THOUGHT_B, c: THOUGHT_C } };
  try {
    mkdirSync(path.join(repo, "docs"), { recursive: true });
    git(["init", "-q", "-b", "main"], repo);
    writeFileSync(path.join(repo, "docs", "a.md"), "# Title" + NL2 + "body line" + NL);
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

    const thread = "think-paragraph";
    let store = { blocks: [] };
    browser = await pw.chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => out.errors.push(String((e && e.message) || e).slice(0, 240)));
    await page.route("**/api/thinking**", (route) => route.fulfill({ json: { blocks: store.blocks, error: null } }));
    await page.goto(sandbox.base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.jobs, null, { timeout: 30_000 });

    const reveal = async () =>
      page.evaluate((p) => {
        const n2 = (s) => String(s || "").split(String.fromCharCode(92)).join("/").replace(/\/+$/, "").toLowerCase();
        const row = [...state.rows.values()].find((r) => n2(r.path) === p);
        if (!row) return false;
        state.expandedProjects.add(row.project);
        state.expanded.add(`${row.project}::${row.path}`);
        renderAll();
        return true;
      }, norm(repo));

    await page.evaluate((t) => localStorage.setItem(`wtgui.think.${t}`, "1"), thread);
    await reveal();
    const jobId = await page.evaluate(
      async ({ p, t }) => {
        const r = await fetch("/api/agents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "probe: three thoughts, three shapes", cwd: p, existing: true, thread: t }),
        }).then((x) => x.json());
        if (!r || !r.job) throw new Error(`spawn failed: ${JSON.stringify(r).slice(0, 300)}`);
        return r.job.id;
      },
      { p: repo, t: thread },
    );
    await reveal();
    // The card is drawn by the page's own poll; reveal() only expands the row it finds. Fail with the page's state if
    // the card never arrives, rather than with a bare selector timeout.
    const cardAt = Date.now();
    let cardSeen = false;
    while (Date.now() - cardAt < 20_000) {
      const n = await page.evaluate((t) => document.querySelectorAll(`.job[data-thread="${CSS.escape(t)}"]`).length, thread);
      if (n) {
        cardSeen = true;
        break;
      }
      await reveal();
      await sleep(400);
    }
    if (!cardSeen) {
      out.phases.debug = await page.evaluate((id) => ({
        jobs: state.jobs.size,
        job: state.jobs.get(id) ? { status: state.jobs.get(id).status, thread: state.jobs.get(id).thread } : null,
        rows: [...state.rows.values()].map((r) => ({ project: r.project, path: r.path })).slice(0, 8),
        expanded: [...state.expanded].slice(0, 8),
      }), jobId);
      throw new Error(`the spawned job's card was never drawn: ${JSON.stringify(out.phases.debug)}`);
    }
    await page.waitForSelector(`.job[data-thread="${thread}"] pre.job-out`, { timeout: 60_000 });

    const waitFor = async (fn, ms = 30_000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const v = await fn();
        if (v) return v;
        await sleep(80);
      }
      return null;
    };

    // ---- the live rows: three thoughts, three shapes -------------------------------------------------------
    const rowA = await waitFor(async () => (await readRows(page, thread)).find((r) => r.source === THOUGHT_A && !r.open));
    const rowB = await waitFor(async () => (await readRows(page, thread)).find((r) => r.source === THOUGHT_B && !r.open));
    const rowC = await waitFor(async () => {
      const r = (await readRows(page, thread)).find((x) => x.source === THOUGHT_C && !x.open);
      return r && r.text.endsWith(DOTS) ? r : null;
    });
    out.phases.live = { rowA, rowB, rowC };

    check(
      "(1) a three-paragraph thought draws ONLY its first paragraph, then four dots",
      Boolean(rowA) && rowA.text === P1 + DOTS,
      rowA ? JSON.stringify(clip(rowA.text)) : "no row",
    );
    check(
      "(1) no word of the second or third paragraph is drawn while the row is minimized",
      Boolean(rowA) && !rowA.text.includes("Then I looked") && !rowA.text.includes("Last, I checked"),
      rowA ? clip(rowA.text) : "no row",
    );
    check(
      "(2) a one-paragraph thought shorter than the lid carries no dots at all",
      Boolean(rowB) && rowB.text === THOUGHT_B && !rowB.dots,
      rowB ? JSON.stringify(clip(rowB.text)) : "no row",
    );
    const cutC = rowC ? rowC.text.length - DOTS.length : 0;
    check(
      "(3) a first paragraph longer than the lid is cut and still ends in the four dots",
      Boolean(rowC) && rowC.text.endsWith(DOTS) && cutC > 0 && cutC < THOUGHT_C.length,
      rowC ? `drawn ${cutC} of ${THOUGHT_C.length} chars` : "no row",
    );
    check(
      "(3) the lid cuts at a WORD boundary, never inside a word",
      Boolean(rowC) && (cutC >= THOUGHT_C.length || /\s/.test(THOUGHT_C[cutC])),
      rowC ? JSON.stringify(THOUGHT_C.slice(Math.max(0, cutC - 18), cutC + 6)) : "no row",
    );
    check(
      "(3) the dots are inside the same text run and add no line of their own",
      Boolean(rowC) && rowC.dots === DOTS && rowC.dotsDisplay === "inline" && rowC.height === rowC.heightNoDots,
      rowC ? JSON.stringify({ dots: rowC.dots, display: rowC.dotsDisplay, height: rowC.height, withoutDots: rowC.heightNoDots }) : "no row",
    );
    check(
      "(3) the lid holds: the drawn text fits four lines and is not scrolled",
      Boolean(rowC) && rowC.overflowY === "hidden" && rowC.scrollHeight <= rowC.clientHeight + 1 && rowC.scrollTop === 0 && rowC.scrollLeft === 0,
      rowC ? JSON.stringify({ clientHeight: rowC.clientHeight, scrollHeight: rowC.scrollHeight, scrollTop: rowC.scrollTop, maxHeight: rowC.maxHeight }) : "no row",
    );
    check(
      "(3) the row still begins at the thought's own first line (a bottom cut, never a start cut)",
      Boolean(rowC) && rowC.firstLine != null && Math.abs(rowC.firstLine) <= 2,
      rowC ? `first character at ${rowC.firstLine}px from the box top` : "no row",
    );

    // ---- (4) the press: every paragraph, byte for byte, and no dots -----------------------------------------
    const press = async (lid) => {
      await page.click(`.job[data-thread="${thread}"] .jl-think[data-lid="${lid}"] .think-text`).catch(() => {});
      await sleep(180);
    };
    await press(rowA.lid);
    const openA = (await readRows(page, thread)).find((r) => r.lid === rowA.lid);
    check(
      "(4) a press restores all three paragraphs byte for byte, with no dots",
      Boolean(openA) && openA.open && openA.text === THOUGHT_A && !openA.dots,
      openA ? JSON.stringify({ open: openA.open, dots: openA.dots, len: openA.text.length, same: openA.text === THOUGHT_A }) : "no row",
    );
    await press(rowC.lid);
    const openC = (await readRows(page, thread)).find((r) => r.lid === rowC.lid);
    check(
      "(4) the long thought expands to its whole paragraph, with no dots",
      Boolean(openC) && openC.open && openC.text === THOUGHT_C && !openC.dots,
      openC ? JSON.stringify({ open: openC.open, dots: openC.dots, len: openC.text.length }) : "no row",
    );

    // ---- the settled read: the store's blocks draw the same summaries ---------------------------------------
    let stateOf = null;
    const settleAt = Date.now();
    while (Date.now() - settleAt < 45_000) {
      stateOf = await page.evaluate((id) => {
        const j = state.jobs.get(id);
        return j ? { status: j.status, endedAt: j.endedAt } : null;
      }, jobId);
      if (stateOf && stateOf.status && !["running", "starting", "waiting", "waiting_for_approval", "queued"].includes(stateOf.status)) break;
      await sleep(200);
    }
    check("the run settled in the page", Boolean(stateOf) && ["done", "completed", "failed", "cancelled", "interrupted"].includes(stateOf.status), JSON.stringify(stateOf));
    const calls = await page.evaluate((id) => {
      const lines = jobLines(id).filter((l) => l && !l.preview);
      return lines.filter((l) => l.kind === "tool").map((l) => Number(l.at) || 0);
    }, jobId);
    const stamp = (i) => Math.max(1, (calls[i] || Date.now()) - 40);
    store = {
      blocks: [
        { at: stamp(0), text: THOUGHT_A },
        { at: stamp(1), text: THOUGHT_B },
        { at: stamp(2), text: THOUGHT_C },
      ],
    };
    out.phases.store = store.blocks;
    await page.evaluate(async (id) => {
      const turn = state.jobs.get(id);
      if (turn) await loadThinking(turn);
    }, jobId);
    const settled = await waitFor(async () => {
      const rows = (await readRows(page, thread)).filter((r) => !r.open);
      const a = rows.find((r) => r.source === THOUGHT_A && r.text === P1 + DOTS);
      const b = rows.find((r) => r.source === THOUGHT_B && r.text === THOUGHT_B);
      const c = rows.find((r) => r.source === THOUGHT_C && r.text.endsWith(DOTS));
      return a && b && c ? rows : null;
    }, 20_000);
    out.phases.settled = settled;
    check(
      "(4) after the store settles, the three rows draw the same three summaries",
      Boolean(settled) && settled.length === 3,
      settled ? JSON.stringify(settled.map((r) => ({ len: r.text.length, open: r.open, dots: Boolean(r.dots) }))) : "not settled",
    );
    const settledA = settled && settled.find((r) => r.source === THOUGHT_A);
    if (settledA) {
      await press(settledA.lid);
      const again = (await readRows(page, thread)).find((r) => r.lid === settledA.lid);
      check(
        "(4) and the settled row expands to the store's block, byte for byte",
        Boolean(again) && again.text === THOUGHT_A && !again.dots,
        again ? JSON.stringify({ same: again.text === THOUGHT_A, dots: again.dots }) : "no row",
      );
    } else {
      check("(4) and the settled row expands to the store's block, byte for byte", false, "no settled first row");
    }

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
  console.log(`${NL}${results.length - failed}/${results.length} checks passed - ${path.join(OUT, "results.json")}`);
  process.exit(failed ? 1 : 0);
};

main();
