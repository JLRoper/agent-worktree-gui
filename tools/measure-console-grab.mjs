#!/usr/bin/env node
// What does the console's bottom-right grab do to the box, in pixels?
//
//   node tools/measure-console-grab.mjs                    # ephemeral port, three live consoles
//   node tools/measure-console-grab.mjs --json <path>      # keep the raw capture
//   node tools/measure-console-grab.mjs --headed           # a window instead of headless Chromium
//   node tools/measure-console-grab.mjs --keep             # leave the sandbox behind
//
// EXIT CODE: 0 when every case was measured and held, 1 when a case was measured and failed, 2 when a case could
// not be measured at all (a console that never overflowed, a browser half that did not run) — an empty log can
// never read as a pass.
//
// WHY THIS TOOL EXISTS. tools/verify-console-resize.mjs asserts the promise in a handful of coarse checks: the
// grab moves nothing, 20 px of drag is 20 px of console, the corner stays 4 px under the pointer. It answers
// "does it work" and leaves the reader's actual question — HOW FAR off is the corner at every step, on a console
// that is following its tail, on one the reader parked, and on one that is writing while the pointer is down —
// with a yes or a no instead of a number. This tool is the number. It reuses the same sandbox shape (throwaway
// config, store, HERMES_HOME, ephemeral port, assistant off, fetch off) and adds a stub Runs API so the consoles
// under the pointer are live, plus three cases the verifier does not drive: the pointer leaving the viewport, a
// release outside the card, and a drag on a console that is streaming as it is dragged.
//
// WHAT IS DRIVEN. Three live runs through the panel's own POST /api/agents, each in its own worktree, fed by a
// stub gateway over real SSE (one word every 40 ms). All three consoles overflow the cap this board puts on them
// (320 px inside `.agents-block`; the base `.job-out` rule says 230 px), and the tool reads the cap the page is
// actually using instead of assuming one.
//
// WHAT IS MEASURED. For every step of every gesture: the console's frame, its inline height/max-height, its
// scroll position, whether the page still considers it pinned, and `gap` — the pointer-to-bottom-edge distance. A
// handle that tracks the pointer keeps `gap` at the gap the gesture opened with (4 px, or 4.9 px when the corner
// lands on a fractional layout row); the largest |gap - that gap| over a gesture is the case's drift, in px.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { git, startPanel } from "./panel-testkit.mjs";

const HANDLE = 4; // where inside the 16 px corner the pointer is put, in px
const STEP = 20; // px between measured moves
const GAP_TOL = 1; // px: "the corner is under the pointer" for this tool
// px. A following console is allowed the page's own "at the bottom" band mid-drag: a line that lands between the
// panel's 400 ms stick ticks sits below the fold for a beat and is closed again by the next tick. The end of the
// gesture is held to the stricter 8 px, which is what a reader means by "it is on its tail".
const FOLLOW_BAND = 32;
const KEEP = process.argv.includes("--keep");
const HEADED = process.argv.includes("--headed");
const JSON_OUT = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const cases = [];
const results = { measuredAt: new Date().toISOString(), commit: null, appHash: null, panel: null, viewport: null, cases: [], trails: [] };

function record(id, title, ok, numbers, note = "") {
  if (!ok) failures += 1;
  const c = { id, title, status: ok ? "PASS" : "FAIL", numbers, note };
  cases.push(c);
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${title}${note ? `  — ${note}` : ""}`);
  return c;
}
const check = (ok, label, detail = "") => {
  if (!ok) failures += 1;
  console.log(`      ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const near = (a, b, tol = GAP_TOL) => Math.abs(a - b) <= tol;

// ---- the stub gateway: three runs of plain text, one word per 40 ms, over real SSE -------------------------------
const WORDS = `the grab is a press on the corner of a fixed height box
every pixel the pointer travels down is a pixel of console
every pixel back up is a pixel less
a following console keeps its newest line while the box is resized
a parked console keeps the line the reader stopped on
a console that is writing keeps writing while the pointer is down
the cap is lifted at the press and never comes back mid drag
the corner belongs under the pointer for the whole gesture`.split(/\s+/).filter(Boolean);

function script(seed, lenMs) {
  const out = [];
  let t = 200;
  let i = seed;
  let inLine = 0;
  let lines = 0;
  while (t < lenMs) {
    const w = WORDS[i % WORDS.length];
    i += 1;
    inLine += 1;
    let sep = " ";
    if (inLine >= 7 + (i % 3)) {
      sep = lines % 5 === 4 ? "\n\n" : "\n";
      inLine = 0;
      lines += 1;
    }
    out.push({ at: t, evt: { event: "message.delta", delta: `${w}${sep}` } });
    t += 40;
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
      return json(200, { version: "grab-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true } });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      req.resume();
      req.on("end", () => {
        posts += 1;
        const id = `run_grab_${posts}`;
        runs.set(id, { id, startedAt: null, script: script(posts * 37, lenMs) });
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

// ---- fixtures ----------------------------------------------------------------------------------------------------
function makeRepo(dir, name) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "first"]);
}

const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// The console of one thread as the page paints it, plus what the drag wrote into its inline style.
const measure = (page, thread) =>
  page.evaluate((t) => {
    const card = document.querySelector(`.job[data-thread="${t}"]`);
    const pre = card && card.querySelector("pre.job-out");
    if (!pre) return null;
    const r = pre.getBoundingClientRect();
    const cs = getComputedStyle(pre);
    const id = pre.dataset.out || "";
    const cr = card.getBoundingClientRect();
    return {
      t: +r.top.toFixed(1), b: +r.bottom.toFixed(1), l: +r.left.toFixed(1), r: +r.right.toFixed(1),
      h: +r.height.toFixed(1),
      cardL: +cr.left.toFixed(1), cardR: +cr.right.toFixed(1), cardB: +cr.bottom.toFixed(1),
      max: cs.maxHeight, cap: parseFloat(cs.maxHeight) || null, inlineH: pre.style.height || "", inlineMax: pre.style.maxHeight || "",
      client: pre.clientHeight, scroll: pre.scrollHeight, top: +pre.scrollTop.toFixed(1),
      dist: +(pre.scrollHeight - pre.scrollTop - pre.clientHeight).toFixed(1),
      pinned: typeof state !== "undefined" && state.outPinned ? state.outPinned[id] !== false : null,
      id, rows: pre.children.length,
    };
  }, thread);

// Bring the card into the window; `block` decides how much room is left below for a downward drag.
async function show(page, thread, block = "center") {
  await page.evaluate(({ t, b }) => document.querySelector(`.job[data-thread="${t}"]`)?.scrollIntoView({ block: b }), { t: thread, b: block });
  await page.waitForTimeout(150);
  return measure(page, thread);
}

// Press the bottom-right handle and hand back the point, so every later move is the reader's own pointer. The point
// is floored to whole pixels: a fractional y is not what a mouse reports, and Chromium's own hit test floors it, which
// would show up as sub-pixel "drift" that is really the instrument's.
async function grab(page, thread) {
  const m = await measure(page, thread);
  const x = Math.floor(m.r - HANDLE);
  const y = Math.floor(m.b - HANDLE);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(80);
  return { x, y, at: m, after: await measure(page, thread) };
}

// One move of the pressed pointer, and the console's frame there. `gap` is pointer-to-bottom-edge; `drift` is that
// gap against the gap the gesture opened with, so a corner that starts 4.9 px above the edge (a fractional layout)
// is not reported as a fault of the drag.
async function slide(page, thread, x, y, settle = 40) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(settle);
  const m = await measure(page, thread);
  return { ...m, mx: x, my: y, gap: +(m.b - y).toFixed(1) };
}

const drift = (trail, base) => (trail.length ? +Math.max(...trail.map((s) => Math.abs(s.gap - base))).toFixed(1) : null);
const heights = (trail) => trail.map((s) => s.h);
const gaps = (trail) => trail.map((s) => s.gap);

async function park(page, thread, want = 80) {
  const el = await page.$(`.job[data-thread="${thread}"] pre.job-out`);
  if (!el) return null;
  const bb = await el.boundingBox();
  if (!bb) return null;
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  for (let i = 0; i < 30; i += 1) {
    const m = await measure(page, thread);
    if (m.dist >= want) break;
    await page.mouse.wheel(0, -60);
    await page.waitForTimeout(70);
  }
  await page.waitForTimeout(150);
  return measure(page, thread);
}

// Unfold the three rows so their cards are on the board. The expansion lives in the page's own state, so it has to
// be asked for again after a reload.
async function expandRows(page, wantRows) {
  await page.evaluate((w) => {
    for (const p of w) {
      const row = [...state.rows.values()].find((r) => String(r.path || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === p);
      if (!row) continue;
      state.expandedProjects.add(row.project);
      state.expanded.add(`${row.project}::${row.path}`);
    }
    renderAll();
  }, wantRows);
}

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("console resize grab", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
    process.exit(2);
  }

  const work = mkdtempSync(path.join(tmpdir(), "wtgui-grab-"));
  const root = path.join(work, "rootA");
  const repo = path.join(root, "grab");
  makeRepo(repo, "grab");
  const threads = ["grab-follow", "grab-park", "grab-stream"];
  const trees = threads.map((t, i) => path.join(repo, ".worktrees", `wt-${i + 1}`));
  for (const [i, tree] of trees.entries()) git(repo, ["worktree", "add", "-q", "-b", `feature-${i + 1}`, tree]);

  const gw = makeGateway(900_000);
  const gwPort = await gw.listen();
  const panel = await startPanel({
    dir: work,
    config: {
      scanRoots: [root],
      projects: [],
      refreshSeconds: 30,
      worktreeSeconds: 5,
      midSeconds: 45,
      dormantSeconds: 90,
      fetchSeconds: -1,
      assistant: { enabled: false },
      remoteBranchPolicy: "local-only",
      defaultCwd: root,
      apiServer: { url: `http://127.0.0.1:${gwPort}`, key: "probe" },
    },
  });

  try {
    console.log(`sandbox: ${panel.base}  (${panel.dir})`);
    results.panel = { base: panel.base, port: panel.port, pid: panel.pid };
    results.commit = git(process.cwd(), ["rev-parse", "HEAD"]).trim();
    results.appHash = createHash("sha256").update(readFileSync(path.join(process.cwd(), "public", "app.js"))).digest("hex");

    await withBrowser(
      async ({ page, pageErrors }) => {
        await openPage(page, panel.base);
        await page.waitForFunction(() => typeof state !== "undefined" && state.rows && state.jobs, null, { timeout: 30_000 });
        results.viewport = page.viewportSize();
        const wantRows = trees.map((p) => norm(p));
        await page.waitForFunction(
          (w) => w.every((x) => [...state.rows.values()].some((r) => String(r.path || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === x)),
          wantRows,
          { timeout: 60_000 },
        );
        await expandRows(page, wantRows);

        for (const [i, thread] of threads.entries()) {
          const r = await fetch(`${panel.base}/api/agents`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: `probe: stream plain text #${i + 1}`, cwd: trees[i], existing: true, thread }),
          }).then((x) => x.json());
          if (!r || !r.job) throw new Error(`spawn failed for ${thread}: ${JSON.stringify(r).slice(0, 300)}`);
        }
        for (const thread of threads) await page.waitForSelector(`.job[data-thread="${thread}"] pre.job-out`, { timeout: 45_000 });
        console.log(`three live consoles spawned: ${threads.join(", ")}`);

        // Every console has to overflow the cap before a drag means anything: 240 px is enough to park a reader and
        // enough that a 160 px drag cannot reach the bottom of the content.
        const overflowed = await page
          .waitForFunction(
            ({ min, count }) => [...document.querySelectorAll("pre.job-out")].filter((o) => o.scrollHeight - o.clientHeight >= min).length >= count,
            { min: 240, count: threads.length },
            { timeout: 150_000, polling: 250 },
          )
          .then(() => true)
          .catch(() => false);
        if (!overflowed) {
          console.log("MEASURE-NOT-RUN  the consoles did not all reach 240 px of scrollback inside 150 s");
          process.exitCode = 2;
          return;
        }

        const [FOLLOW, PARKED, STREAM] = threads;
        // The live board draws these consoles inside `.agents-block`, whose cap is 320 px — the base `.job-out`
        // max-height is 230 px and the block overrides it. Take the number the page is actually using.
        const cap = (await measure(page, FOLLOW)).cap;
        results.cap = cap;
        console.log(`console cap on this board: ${cap} px`);

        // ---- case 1: the pointerdown itself moves nothing, on all three consoles ----------------------------
        {
          const rows = [];
          let ok = true;
          for (const thread of threads) {
            await show(page, thread, "center");
            const before = await measure(page, thread);
            const g = await grab(page, thread);
            const pressed = g.after;
            rows.push({ thread, before: before.h, after: pressed.h, delta: +(pressed.h - before.h).toFixed(1), pin: pressed.inlineH, max: pressed.max, content: pressed.scroll, box: pressed.client });
            const pass = near(pressed.h, before.h, 0.01) && pressed.inlineH === `${before.h}px` && pressed.max === "none";
            if (!pass) ok = false;
            console.log(`      ${thread}: h ${before.h} px -> ${pressed.h} px (delta ${(pressed.h - before.h).toFixed(1)}), content ${pressed.scroll} px in a ${pressed.client} px box, inline ${JSON.stringify(pressed.inlineH)}, max ${pressed.max}`);
            await page.mouse.up();
            await page.waitForTimeout(80);
            const after = await measure(page, thread);
            const clean = after.inlineH === "" && near(after.max === null ? NaN : parseFloat(after.max), cap, 0.01);
            if (!clean) { ok = false; console.log(`      FAIL  ${thread}: the press left ${after.inlineH || "no height"} / ${after.max} behind`); }
          }
          record("1", "pointerdown on the corner changes no console height", ok, rows);
        }

        // ---- case 2: one gesture, down then up, every step measured ------------------------------------------
        {
          const start = await show(page, FOLLOW, "center");
          const g = await grab(page, FOLLOW);
          const edge = g.after;
          const base = +(edge.b - g.y).toFixed(1);
          const down = [];
          for (let i = 1; i <= 8; i += 1) down.push(await slide(page, FOLLOW, g.x, g.y + i * STEP));
          const up = [];
          for (let i = 1; i <= 8; i += 1) up.push(await slide(page, FOLLOW, g.x, g.y + (8 - i) * STEP));
          await page.mouse.up();
          await page.waitForTimeout(120);
          const end = await measure(page, FOLLOW);
          const trail = [...down, ...up];
          results.trails.push({ case: "2", thread: FOLLOW, base, points: trail.map((s) => ({ y: s.my, gap: s.gap, h: s.h, dist: s.dist })) });
          console.log(`      grabbed at ${g.x},${g.y} with the corner ${base} px above the edge`);
          console.log(`      down heights  ${heights(down).join(", ")}`);
          console.log(`      down gaps     ${gaps(down).join(", ")}`);
          console.log(`      up gaps       ${gaps(up).join(", ")}`);
          console.log(`      end: h ${end.h} px (start ${edge.h} px), inline ${end.inlineH}, max ${end.max}`);
          const okDrift = drift(trail, base) <= GAP_TOL;
          const okSteps = down.every((s, i) => near(s.h, edge.h + (i + 1) * STEP, 1));
          const okBack = up.every((s, i) => near(s.h, edge.h + (7 - i) * STEP, 1));
          const okClose = near(end.h, edge.h, 1);
          record("2", "drag down then up in one gesture: the corner tracks the pointer", okDrift && okSteps && okBack && okClose, {
            startHeight: edge.h, baseGap: base, steps: trail.length, maxDrift: drift(trail, base), gaps: gaps(trail), heights: heights(trail), endHeight: end.h,
          }, `max drift ${drift(trail, base)} px over ${trail.length} steps`);
          check(okSteps, "each 20 px down is 20 px of console", `heights ${heights(down).join(",")}`);
          check(okBack, "each 20 px back up is 20 px less console", `heights ${heights(up).join(",")}`);
          check(okClose, "the gesture closes on the height it opened with", `${edge.h} -> ${end.h}`);
        }

        // ---- case 3: a following console, a parked console, a console streaming while it is dragged ---------
        {
          const detail = {};

          // 3a. following: pinned at its tail before and after the gesture.
          {
            await show(page, FOLLOW, "center");
            const before = await measure(page, FOLLOW);
            const g = await grab(page, FOLLOW);
            const base = +(g.after.b - g.y).toFixed(1);
            const down = [];
            for (let i = 1; i <= 4; i += 1) down.push(await slide(page, FOLLOW, g.x, g.y + i * STEP));
            const up = [];
            for (let i = 1; i <= 4; i += 1) up.push(await slide(page, FOLLOW, g.x, g.y + (4 - i) * STEP));
            await page.mouse.up();
            await page.waitForTimeout(250);
            const after = await measure(page, FOLLOW);
            const trail = [...down, ...up];
            const maxDist = Math.max(...trail.map((s) => s.dist));
            detail.follow = { before, trail, after, base, maxDrift: drift(trail, base), maxDist };
            const ok = drift(trail, base) <= GAP_TOL && after.pinned === true && after.dist <= 8 && maxDist <= FOLLOW_BAND;
            console.log(`      following: dist ${before.dist} -> ${after.dist} px from its tail (worst mid-drag ${maxDist} px), pinned ${before.pinned} -> ${after.pinned}, base gap ${base} px, max drift ${drift(trail, base)} px`);
            check(ok, "a following console tracks the pointer and is still on its newest line after", `dist ${after.dist}, worst ${maxDist}, drift ${drift(trail, base)}`);
          }

          // 3b. parked: the reader's line is the top of the box, so a resize must leave scrollTop where it was.
          {
            await show(page, PARKED, "center");
            await park(page, PARKED, 80);
            const before = await measure(page, PARKED);
            const g = await grab(page, PARKED);
            const base = +(g.after.b - g.y).toFixed(1);
            const down = [];
            for (let i = 1; i <= 4; i += 1) down.push(await slide(page, PARKED, g.x, g.y + i * STEP));
            const up = [];
            for (let i = 1; i <= 4; i += 1) up.push(await slide(page, PARKED, g.x, g.y + (4 - i) * STEP));
            await page.mouse.up();
            await page.waitForTimeout(250);
            const after = await measure(page, PARKED);
            const scrollMoved = +(after.top - before.top).toFixed(1);
            const trail = [...down, ...up];
            const midMoved = Math.max(...trail.map((s) => Math.abs(s.top - before.top)));
            detail.parked = { before, trail, after, base, maxDrift: drift(trail, base), scrollMoved, midMoved };
            const ok = drift(trail, base) <= GAP_TOL && Math.abs(scrollMoved) <= 2 && midMoved <= 2;
            console.log(`      parked: ${before.dist} px from the tail, scrollTop ${before.top} -> ${after.top} (moved ${scrollMoved} px, worst mid-drag ${midMoved} px), base gap ${base} px, max drift ${drift(trail, base)} px`);
            check(ok, "a parked console tracks the pointer and holds the reader's line", `scrollTop moved ${scrollMoved} px, worst ${midMoved}`);
          }

          // 3c. streaming: the console writes while the pointer is down. Growth of the transcript (scrollHeight, not
          //     the row count — a paced line extends the row it is in) during the gesture proves it was writing.
          {
            await show(page, STREAM, "center");
            const before = await measure(page, STREAM);
            const g = await grab(page, STREAM);
            const base = +(g.after.b - g.y).toFixed(1);
            const down = [];
            for (let i = 1; i <= 4; i += 1) down.push(await slide(page, STREAM, g.x, g.y + i * STEP, 180));
            const mid = await measure(page, STREAM);
            const up = [];
            for (let i = 1; i <= 4; i += 1) up.push(await slide(page, STREAM, g.x, g.y + (4 - i) * STEP, 180));
            const atRelease = await measure(page, STREAM);
            await page.mouse.up();
            await page.waitForTimeout(200);
            const after = await measure(page, STREAM);
            const trail = [...down, ...up];
            const grew = +(after.scroll - before.scroll).toFixed(1);
            detail.stream = { before, mid, atRelease, after, trail, base, maxDrift: drift(trail, base), grew };
            const ok = drift(trail, base) <= GAP_TOL && grew >= 20;
            console.log(`      streaming: transcript grew ${grew} px during the gesture (${before.scroll} -> ${after.scroll}), base gap ${base} px, max drift ${drift(trail, base)} px, pinned ${after.pinned}`);
            check(ok, "a console writing while it is dragged still tracks the pointer", `drift ${drift(trail, base)} px, transcript +${grew} px`);
          }

          const ok = detail.follow.maxDrift <= GAP_TOL && detail.parked.maxDrift <= GAP_TOL && detail.stream.maxDrift <= GAP_TOL;
          record("3", "following, parked and streaming consoles all keep the corner under the pointer", ok, {
            follow: { maxDrift: detail.follow.maxDrift, distAfter: detail.follow.after.dist, worstDist: detail.follow.maxDist },
            parked: { maxDrift: detail.parked.maxDrift, scrollMoved: detail.parked.scrollMoved, worstScrollMoved: detail.parked.midMoved },
            stream: { maxDrift: detail.stream.maxDrift, grewPx: detail.stream.grew },
          }, `drift follow ${detail.follow.maxDrift} · parked ${detail.parked.maxDrift} · stream ${detail.stream.maxDrift} px`);
          results.trails.push({ case: "3", follow: detail.follow.trail.map((s) => ({ y: s.my, gap: s.gap, h: s.h, dist: s.dist })), parked: detail.parked.trail.map((s) => ({ y: s.my, gap: s.gap, h: s.h, top: s.top })), stream: detail.stream.trail.map((s) => ({ y: s.my, gap: s.gap, h: s.h })) });
        }

        // ---- case 4a: a drag that ends outside the card ------------------------------------------------------
        {
          // Runs while the console is still the 320 px box case 3 left it at; the viewport-edge drag below leaves a
          // box taller than the window, and a handle past the bottom of the screen cannot be grabbed at all.
          const start = await show(page, FOLLOW, "center");
          const g = await grab(page, FOLLOW);
          const base = +(g.after.b - g.y).toFixed(1);
          const down = await slide(page, FOLLOW, g.x, g.y + 60, 100);
          const awayX = Math.max(5, start.l - 120); // left of the card, still on the page
          const away = await slide(page, FOLLOW, awayX, g.y + 60, 120);
          const atRelease = await measure(page, FOLLOW);
          await page.mouse.up();
          await page.waitForTimeout(250);
          const after = await measure(page, FOLLOW);
          // A release that landed outside the card must END the drag: a further move with no button moves nothing.
          const ghost = await slide(page, FOLLOW, awayX, g.y + 140, 150);
          const still = near(ghost.h, after.h, 1);
          results.trails.push({ case: "4a", base, points: [down, away].map((s) => ({ x: s.mx, y: s.my, gap: s.gap, h: s.h })) });
          console.log(`      start h ${start.h} px, base gap ${base} px; 60 px down h ${down.h} (gap ${down.gap}); pointer left of the card x=${away.mx} h ${away.h} (gap ${away.gap})`);
          console.log(`      released outside the card: h ${atRelease.h} -> ${after.h} px, inline ${after.inlineH}, max ${after.max}; unbuttoned move -> h ${ghost.h}`);
          const ok = near(down.h, start.h + 60, 1) && near(away.h, down.h, 1) && near(after.h, atRelease.h, 1) && still;
          record("4a", "a drag that ends outside the card keeps its height and ends the gesture", ok, {
            startHeight: start.h, cardLeft: start.l, baseGap: base, down60: { h: down.h, gap: down.gap }, outside: { x: away.mx, h: away.h, gap: away.gap },
            atRelease: atRelease.h, afterRelease: after.h, afterGhostMove: ghost.h,
          }, `h ${start.h} -> ${atRelease.h} px, release moved ${(after.h - atRelease.h).toFixed(1)} px`);
          check(still, "the release outside the card ended the drag (an unbuttoned move changes nothing)", `h ${after.h} -> ${ghost.h}`);
        }

        // ---- case 4b: a drag past the bottom edge of the viewport --------------------------------------------
        {
          await show(page, FOLLOW, "start");
          const g = await grab(page, FOLLOW);
          const base = +(g.after.b - g.y).toFixed(1);
          const vh = page.viewportSize().height;
          const inside = await slide(page, FOLLOW, g.x, vh - 10, 80);
          const outside1 = await slide(page, FOLLOW, g.x, vh + 60, 120);
          const outside2 = await slide(page, FOLLOW, g.x, vh + 200, 120);
          const atRelease = await measure(page, FOLLOW);
          await page.mouse.up();
          await page.waitForTimeout(250);
          const after = await measure(page, FOLLOW);
          const trail = [inside, outside1, outside2];
          results.trails.push({ case: "4b", base, points: trail.map((s) => ({ y: s.my, gap: s.gap, h: s.h })) });
          console.log(`      viewport 0..${vh}, base gap ${base} px: inside(y=${inside.my}) gap ${inside.gap}, h ${inside.h}; outside(y=${outside1.my}) gap ${outside1.gap}, h ${outside1.h}; y=${outside2.my} gap ${outside2.gap}, h ${outside2.h}`);
          console.log(`      at release h ${atRelease.h} px, after release h ${after.h} px, inline ${after.inlineH}, max ${after.max}`);
          const maxDrift = drift(trail, base);
          const okHeld = near(after.h, atRelease.h, 1);
          record("4b", "a drag past the bottom of the viewport still follows the pointer", maxDrift <= GAP_TOL && okHeld, {
            viewportHeight: vh, baseGap: base, inside: { y: inside.my, gap: inside.gap, h: inside.h },
            outside: [{ y: outside1.my, gap: outside1.gap, h: outside1.h }, { y: outside2.my, gap: outside2.gap, h: outside2.h }],
            maxDrift, atRelease: atRelease.h, afterRelease: after.h,
          }, `max drift ${maxDrift} px, ${outside2.my - vh} px below the viewport edge`);
          check(okHeld, "the release past the edge leaves the height it was dragged to", `${atRelease.h} -> ${after.h}`);
        }

        check(pageErrors.length === 0, "the page threw nothing", pageErrors.slice(0, 3).join(" | "));
        results.pageErrors = pageErrors;
      },
      { viewport: { width: 1440, height: 900 }, headless: !HEADED },
    );
  } finally {
    await panel.stop();
    await gw.close();
    if (JSON_OUT) {
      results.cases = cases;
      mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
      writeFileSync(path.resolve(JSON_OUT), JSON.stringify(results, null, 2));
      console.log(`capture: ${path.resolve(JSON_OUT)}`);
    }
    if (!KEEP) rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    else console.log(`sandbox kept: ${work}`);
  }

  console.log(failures ? `RESULT: FAIL (${failures} check${failures === 1 ? "" : "s"})` : "RESULT: PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
