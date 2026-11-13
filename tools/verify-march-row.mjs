// The console's marching tail, on a real card, a real turn and a real browser.
//
//   node tools/verify-march-row.mjs                      # this checkout
//   node tools/verify-march-row.mjs --root <dir>         # serve another checkout (a `git archive` of the base)
//   node tools/verify-march-row.mjs --shots <dir>        # where the two captures go
//
// THE CLAIM. A live turn's console carries a trailing decoration under its last line: ". . . . ", one dot every
// 500 ms, four dots to the cycle (two seconds), cleared back to a single dot whenever output arrives, and gone the
// instant the turn reads done. It is NOT a line of the record: it is a sibling of the <pre>, so
//   * the feed's text, height and scroll never move because of it - the numbers are equal across two full wrap
//     cycles of a quiet feed;
//   * the record's text carries no dot of it, at any moment and after the settle: the rendered rows read back
//     character-for-character equal to the turn's stored lines;
//   * reduced motion holds a static single dot and a label, on the panel's ONE existing rule.
//
// WHAT IS DRIVEN. A panel of its own on a spare port (tools/panel-testkit.mjs: own PANEL_CONFIG / HERMES_HOME /
// jobs.json, API_SERVER_KEY empty), so no reader's panel is touched. A stub Runs API plays three bursts of prose, a
// tool call and its result, with a 5 s quiet gap between them, then reports the run completed. The card is spawned
// through the panel's own POST /api/agents, every line reaches the page as a `jobline` frame from the panel's own
// server, and the row is drawn by the shipped renderer. A second turn is then run in a context that asks for reduced
// motion, and its row is measured still.
//
// Exit codes: 0 every assertion held; 1 one failed (or the page erred); 2 the run did not measure what it claims.
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright, notRun } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SHOTS = path.resolve(opt("--shots", path.join(os.tmpdir(), "wag", "march-row")));
const log = (...a) => console.log(...a);

// ---- the stub Runs API ---------------------------------------------------------------------------------------------
// Three bursts, each preceded by a blank line so lib/jobs.js opens a NEW paragraph (it grows one open line in place
// until a fragment starts the next). Between bursts there is nothing for ~5 s: that quiet feed is what the marching
// tail is for, and two full wrap cycles fit inside one gap.
// Five short lines a burst, each its own paragraph (a blank line opens a new store line), so one burst fills more of
// the console than a wrapped paragraph would and the console has to scroll - which is what makes "the scroll did not
// move" a number rather than a zero.
const burst = (n, at) =>
  Array.from({ length: 5 }, (_, k) => ({
    at: at + k * 40,
    ev: { event: "message.delta", delta: `\n\nBurst ${n} line ${k + 1}: the run read the file and counted 4${k} lines.` },
  }));
const QUIET_MS = 5000;
const SCHEDULE = [
  ...burst(1, 0),
  { at: 300, ev: { event: "tool.started", tool: "terminal", preview: "wc -l docs/a.md" } },
  { at: 420, ev: { event: "tool.completed", tool: "terminal", preview: "  42 docs/a.md", duration: 0.31 } },
  ...burst(2, 300 + QUIET_MS),
  { at: 480 + QUIET_MS, ev: { event: "tool.started", tool: "read_file", preview: "docs/a.md" } },
  { at: 600 + QUIET_MS, ev: { event: "tool.completed", tool: "read_file", preview: "# Title\n\nbody line\n", duration: 0.22 } },
  ...burst(3, 600 + QUIET_MS * 2),
];
const DONE_AT = 600 + QUIET_MS * 2 + 900;

function makeGateway() {
  const runs = new Map();
  let posts = 0;
  const timers = new Set();
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/v1/capabilities") {
      return json(200, {
        version: "march-row-stub",
        features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true },
      });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      req.resume();
      req.on("end", () => {
        posts += 1;
        const id = `run_march_${posts}`;
        runs.set(id, { id, born: Date.now(), done: false, sent: new Set(), timer: null });
        json(200, { run_id: id, status: "running" });
      });
      return;
    }
    const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const rec = runs.get(one[1]);
      if (!rec) return json(404, { error: { message: "Run not found", code: "run_not_found" } });
      const done = rec.done || Date.now() - rec.born > DONE_AT;
      rec.done = done;
      return json(200, {
        run_id: rec.id,
        status: done ? "completed" : "running",
        output: done ? "the turn's own answer, whole" : "",
        exit_code: done ? 0 : null,
        usage: { total_tokens: 9000, input_tokens: 8100, output_tokens: 900 },
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
        const age = Date.now() - rec.born;
        for (const step of SCHEDULE) {
          if (step.at > age || rec.sent.has(step.at)) continue;
          rec.sent.add(step.at);
          res.write(`id: ${seq}\ndata: ${JSON.stringify({ ...step.ev, run_id: rec.id, seq: seq++, timestamp: Date.now() / 1000 })}\n\n`);
        }
        if (age > DONE_AT) {
          rec.done = true;
          clearInterval(timer);
          timers.delete(timer);
          res.write(`id: ${seq}\ndata: ${JSON.stringify({ event: "run.completed", run_id: rec.id, seq: seq++, timestamp: Date.now() / 1000 })}\n\n`);
        }
      }, 100);
      rec.timer = timer;
      timers.add(timer);
      req.on("close", () => {
        clearInterval(timer);
        timers.delete(timer);
        if (rec.timer === timer) rec.timer = null;
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

// ---- the page-side recorder ----------------------------------------------------------------------------------------
// One sample every 50 ms: the row's own dots, the console's three numbers, and how many rows the record holds. A
// quiet feed is a run of samples whose console numbers never move, and a wrap is a change from four dots back to one.
function pageInit() {
  const R = { samples: [], errors: [] };
  window.__march = R;
  window.addEventListener("error", (e) => R.errors.push(String((e && e.message) || e)));
  window.addEventListener("unhandledrejection", (e) => R.errors.push(`unhandledrejection: ${String((e && e.reason && e.reason.message) || e.reason || "")}`));
  setInterval(() => {
    const rows = [...document.querySelectorAll("[data-march]")];
    const row = rows[0] || null;
    const out = document.querySelector("pre.job-out");
    if (!out) return;
    const dots = row ? row.querySelector(".march-dots") : null;
    const label = row ? row.querySelector(".march-label") : null;
    const dotEl = row ? row.querySelector(".pulse-dot") : null;
    R.samples.push({
      t: Math.round(performance.now()),
      row: row ? row.dataset.march : null,
      rows: rows.length,
      dots: dots ? dots.textContent : null,
      dotsShown: dots ? dots.offsetWidth > 0 && getComputedStyle(dots).display !== "none" : false,
      label: label ? label.textContent : null,
      labelShown: label ? getComputedStyle(label).display !== "none" : false,
      still: row ? row.classList.contains("is-still") : false,
      anim: dotEl ? getComputedStyle(dotEl).animationName : null,
      inside: out.querySelector("[data-march]") ? 1 : 0, // the row inside the record: must never happen
      sh: out.scrollHeight,
      ch: out.clientHeight,
      top: Math.round(out.scrollTop),
      rect: Math.round(out.getBoundingClientRect().height),
      rowH: row ? Math.round(row.getBoundingClientRect().height) : null,
      kids: out.children.length,
    });
    if (R.samples.length > 4000) R.samples.splice(0, 2000);
  }, 50);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A card is rebuilt under the pointer while output streams, so an element screenshot races the render (Playwright
// answers "element is not attached to the DOM"). Clip the viewport at the console's own box instead: one frame, no
// stability wait, and the shot is of the console and the row under it - which is the thing being claimed.
async function shotConsole(page, thread, file) {
  const clip = await page.evaluate((t) => {
    const card = document.querySelector(`.job[data-thread="${t}"]`);
    const wrap = card && card.querySelector(".out-wrap");
    if (!wrap) return null;
    wrap.scrollIntoView({ block: "center" });
    const r = wrap.getBoundingClientRect();
    const top = Math.max(0, Math.round(r.top) - 6);
    return {
      x: Math.max(0, Math.round(r.left) - 6),
      y: top,
      width: Math.min(Math.round(r.width) + 12, window.innerWidth - 12),
      height: Math.min(Math.round(r.bottom - top) + 12, window.innerHeight - top - 6),
    };
  }, thread);
  if (!clip) throw new Error(`no console to capture for ${thread}`);
  await page.screenshot({ path: file, clip });
  return clip;
}
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  - ${detail}` : ""}`);
  return ok;
};

const git = (args, cwd) =>
  execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@localhost", ...args], { cwd, stdio: "pipe", encoding: "utf8" });

// A quiet window is a run of samples in which the console's own numbers never move. What the march must not do is
// move them: the window's first and last sample have to agree on all three, and the window has to hold two wraps.
function quietWindows(samples) {
  const windows = [];
  let run = [samples[0]];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (b.row && a.row && b.sh === a.sh && b.ch === a.ch && b.top === a.top && b.rect === a.rect && b.rowH === a.rowH && b.kids === a.kids) run.push(b);
    else {
      if (run.length > 4) windows.push(run);
      run = [b];
    }
  }
  if (run.length > 4) windows.push(run);
  return windows.map((w) => {
    const wraps = [];
    for (let i = 1; i < w.length; i++) {
      const before = String(w[i - 1].dots || "").trim().split(" ").filter(Boolean).length;
      const after = String(w[i].dots || "").trim().split(" ").filter(Boolean).length;
      if (before === 4 && after === 1) wraps.push(w[i].t);
    }
    return {
      from: w[0].t,
      to: w[w.length - 1].t,
      ms: w[w.length - 1].t - w[0].t,
      samples: w.length,
      sh: [w[0].sh, w[w.length - 1].sh],
      ch: [w[0].ch, w[w.length - 1].ch],
      top: [w[0].top, w[w.length - 1].top],
      rect: [w[0].rect, w[w.length - 1].rect],
      rowH: [...new Set(w.map((s) => s.rowH))],
      wraps: wraps.length,
      steps: new Set(w.map((s) => String(s.dots || "").trim().split(" ").filter(Boolean).length)).size,
    };
  });
}

// The interval between dots: every sample where the count changed, and the gap from the one before.
function stepIntervals(samples) {
  const changes = [];
  let last = null;
  for (const s of samples) {
    const n = String(s.dots || "").trim().split(" ").filter(Boolean).length;
    if (!n) continue;
    if (last && n !== last.n) changes.push({ t: s.t, n, from: last.n });
    last = { t: s.t, n };
  }
  const gaps = changes.slice(1).map((c, i) => c.t - changes[i].t);
  return { changes, gaps };
}

// A settled turn folds to its head and one line - that is the panel's rule, not this feature's - so the record is
// read and photographed with the turn OPEN, through the same book and the same renderer the reader's click uses.
async function openTurn(page, thread) {
  const ok = await page.evaluate((t) => {
    const conv = conversations().find((c) => c.thread === t);
    if (!conv || !conv.latest) return false;
    wtTurnFold.setOpen(state, conv.latest.id, true);
    renderConversation(conv.thread);
    return true;
  }, thread);
  if (!ok) throw new Error(`no conversation for ${thread}`);
  try {
    await page.waitForSelector(`.job[data-thread="${thread}"] pre.job-out`, { timeout: 20_000 });
  } catch {
    // Say WHY the console is not there: a card in another host, a fold the renderer did not take, a job the board
    // dropped. A bare "timeout" on a card that is on screen but folded reads as a defect in the feature under test.
    const diag = await page.evaluate((t) => {
      const card = document.querySelector(`.job[data-thread="${t}"]`);
      const conv = conversations().find((c) => c.thread === t);
      const latest = conv && conv.latest ? conv.latest.id : null;
      const turn = latest ? state.jobs.get(latest) : null;
      return {
        card: Boolean(card),
        parent: card && card.parentElement ? `${card.parentElement.id || card.parentElement.className}` : null,
        classes: card ? card.className : null,
        cons: card ? card.querySelectorAll("pre.job-out").length : 0,
        html: card ? card.innerHTML.slice(0, 320) : null,
        latest,
        status: turn ? turn.status : null,
        turns: conv ? conv.turns.length : null,
        open: latest ? state.turnOpen.get(String(latest)) : null,
        jobs: state.jobs.size,
        body: [...document.body.children].map((n) => `${n.tagName.toLowerCase()}#${n.id}.${n.className}(${n.children.length})`),
        jobsInDom: [...document.querySelectorAll(".job")].map((n) => n.dataset.thread),
        projects: state.projects.size,
        rows: state.rows.size,
        collapsed: state.collapsedJobs.has(t),
        html: document.body.innerHTML.length,
      };
    }, thread);
    throw new Error(`no console to open for ${thread}: ${JSON.stringify(diag)}`);
  }
}

async function main(pw, startPanel) {
  const work = mkdtempSync(path.join(os.tmpdir(), "wtgui-march-"));
  const roots = [path.join(work, "rootA")];
  let sandbox = null;
  let gw = null;
  let browser = null;
  const out = { tree: TREE, checks: results, main: null, still: null, errors: [] };
  try {
    mkdirSync(path.join(roots[0], "proj", "docs"), { recursive: true });
    const repo = path.join(roots[0], "proj");
    // The turn runs in a directory NO row claims, so its card lives in the unattached list (#jobs) - the one host the
    // renderer rebuilds from `homelessConversations()` on every jobs event, including the settle. A run whose cwd is a
    // scanned row's path is drawn as a nested card under that row instead, and that card is not what this proves.
    const loose = path.join(work, "loose");
    mkdirSync(loose, { recursive: true });
    // A repo, because the panel refuses a cwd that is not one - and OUTSIDE scanRoots, so the scanner never makes it a
    // row: a conversation with no row to belong to is the unattached list, which is the host that survives a settle.
    git(["init", "-q", "-b", "main"], loose);
    writeFileSync(path.join(loose, "note.md"), "loose work\n");
    git(["add", "."], loose);
    git(["commit", "-q", "-m", "loose"], loose);
    git(["init", "-q", "-b", "main"], repo);
    writeFileSync(path.join(repo, "docs", "a.md"), "# Title\n\nbody line\n");
    git(["add", "."], repo);
    git(["commit", "-q", "-m", "first"], repo);

    gw = makeGateway();
    const gwPort = await gw.listen();
    sandbox = await startPanel({
      dir: work,
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
        defaultCwd: loose,
        apiServer: { url: `http://127.0.0.1:${gwPort}`, key: "probe" },
      },
      env: { API_SERVER_KEY: "" },
    });
    log(`panel ${sandbox.base} (${TREE})`);

    const spawn = async (thread, prompt) => {
      const r = await fetch(`${sandbox.base}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, cwd: loose, existing: true, thread }),
      }).then((x) => x.json());
      if (!r || !r.job) throw new Error(`spawn failed: ${JSON.stringify(r).slice(0, 300)}`);
      return r.job.id;
    };

    browser = await pw.chromium.launch({ headless: true });
    mkdirSync(SHOTS, { recursive: true });

    // ---- phase A: a live turn with three bursts, and the row's own numbers ----
    const threadA = "march-a";
    const jobA = await spawn(threadA, "probe: three bursts and a quiet feed between them");
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await ctx.addInitScript(pageInit);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => out.errors.push(String((e && e.message) || e).slice(0, 200)));
    await page.goto(sandbox.base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.jobs, null, { timeout: 30_000 });
    await page.waitForSelector(`.job[data-thread="${threadA}"] pre.job-out`, { timeout: 45_000 });
    await page.waitForSelector("[data-march]", { timeout: 20_000 });

    // The row appears under the console, outside the record, with the console's first line still arriving.
    const shape = await page.evaluate(() => {
      const row = document.querySelector("[data-march]");
      const out = document.querySelector("pre.job-out");
      return {
        isNext: out.nextElementSibling === row,
        inside: Boolean(out.querySelector("[data-march]")),
        dots: row.querySelector(".march-dots").textContent,
        cls: row.className,
        wrap: row.parentElement.className,
        label: row.querySelector(".march-label").textContent,
      };
    });
    out.main = { shape };
    check("the row is the console's own next sibling, never inside it", shape.isNext && !shape.inside, `next=${shape.isNext} inside=${shape.inside} wrap="${shape.wrap}"`);
    check("it draws one dot with one space, at the start", shape.dots === ". ", JSON.stringify(shape.dots));
    check("it wears the panel's pulse idiom", /live-pulse/.test(shape.cls) && /march/.test(shape.cls), shape.cls);

    // A capture mid-cycle: wait until three dots are on screen, then take the card.
    await page.waitForFunction(() => {
      const el = document.querySelector("[data-march] .march-dots");
      return el && el.textContent.trim().split(" ").filter(Boolean).length >= 3;
    }, null, { timeout: 10_000 });
    const shotMid = path.join(SHOTS, "march-mid-cycle.png");
    const midDots = await page.evaluate(() => document.querySelector("[data-march] .march-dots").textContent);
    const midClip = await shotConsole(page, threadA, shotMid);
    check("mid-cycle capture taken", true, `${path.basename(shotMid)} at ${JSON.stringify(midDots)} (${midClip.width}x${midClip.height})`);

    // A repaint of the feed while the row marches: the row is redrawn where it had got to, not from one dot, and its
    // clock is not restarted. `state.march.at` is the turn's own clock - a rebuild that re-entered it would move it.
    const repaint = await page.evaluate((t) => {
      const row = document.querySelector("[data-march]");
      const id = row.dataset.march;
      const before = { dots: row.querySelector(".march-dots").textContent, at: state.march.get(id).at, node: row };
      const conv = conversations().find((c) => c.thread === t);
      renderConversation(conv.thread);
      const now = document.querySelector("[data-march]");
      return {
        before: before.dots,
        at: before.at,
        atAfter: state.march.get(id) ? state.march.get(id).at : null,
        present: Boolean(now),
        isSameNode: now === before.node,
        after: now ? now.querySelector(".march-dots").textContent : null,
      };
    }, threadA);
    const nOf = (s) => String(s || "").trim().split(" ").filter(Boolean).length;
    check(
      "a repaint of the feed leaves the row marching from where it was",
      repaint.present && repaint.atAfter === repaint.at && nOf(repaint.after) >= nOf(repaint.before),
      `dots ${JSON.stringify(repaint.before)} -> ${JSON.stringify(repaint.after)}, clock ${repaint.at} -> ${repaint.atAfter}, rebuilt=${!repaint.isSameNode}`,
    );

    // The turn ends: the row must be gone and the card settled.
    await page.waitForFunction((id) => {
      const j = state.jobs.get(id);
      return j && !["running", "starting", "waiting", "waiting_for_approval", "queued"].includes(String(j.status)) && !document.querySelector("[data-march]");
    }, jobA, { timeout: 45_000 });
    await openTurn(page, threadA);
    const rowAfterDone = await page.evaluate(() => ({
      march: document.querySelectorAll("[data-march]").length,
      dots: document.querySelectorAll(".march-dots").length,
    }));
    check("no dot of the row survives the settle, anywhere on the page", rowAfterDone.march === 0 && rowAfterDone.dots === 0, `rows=${rowAfterDone.march} slots=${rowAfterDone.dots}`);
    const shotDone = path.join(SHOTS, "march-after-done.png");
    await shotConsole(page, threadA, shotDone);

    const rec = await page.evaluate(() => ({ samples: window.__march.samples, errors: window.__march.errors }));
    out.errors.push(...rec.errors.map((e) => String(e).slice(0, 200)));
    const samples = rec.samples;
    out.main.samples = samples.length;
    check("the page raised no error", out.errors.length === 0, out.errors.slice(0, 3).join(" | "));
    check("the row never entered the record", samples.every((s) => s.inside === 0), `${samples.filter((s) => s.inside).length} sample(s) with the row inside the console`);

    const { changes, gaps } = stepIntervals(samples);
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    out.main.changes = changes.length;
    out.main.gaps = { median, min: sorted[0] ?? null, max: sorted[sorted.length - 1] ?? null, n: gaps.length };
    check(
      "one dot every 500 ms (measured between rendered steps)",
      gaps.length >= 8 && Math.abs(median - 500) <= 60 && sorted[0] >= 380 && sorted[sorted.length - 1] <= 620,
      `${gaps.length} intervals, median ${median} ms, min ${sorted[0]} ms, max ${sorted[sorted.length - 1]} ms`,
    );
    const wraps = changes.filter((c, i) => i > 0 && c.from === 4 && c.n === 1).length;
    out.main.wraps = wraps;
    check("it clears at the right edge and cycles", wraps >= 4, `${wraps} wraps in the run (four dots -> one dot)`);

    const windows = quietWindows(samples).filter((w) => w.ms >= 4000);
    out.main.windows = windows;
    const twoWraps = windows.filter((w) => w.wraps >= 2);
    const want = twoWraps[twoWraps.length - 1] || null;
    check(
      "two full wrap cycles of a quiet feed leave the console's height and scroll unchanged",
      Boolean(want) && want.sh[0] === want.sh[1] && want.ch[0] === want.ch[1] && want.top[0] === want.top[1] && want.rect[0] === want.rect[1] && want.rowH.length === 1,
      want
        ? `${want.wraps} wraps over ${want.ms} ms (${want.samples} samples): scrollHeight ${want.sh[0]} -> ${want.sh[1]}, clientHeight ${want.ch[0]} -> ${want.ch[1]}, ` +
          `scrollTop ${want.top[0]} -> ${want.top[1]}, console box ${want.rect[0]} -> ${want.rect[1]} px, row height ${want.rowH.join("/")} px for every sample`
        : "no quiet window held two wraps",
    );

    // ---- the record's text, against the turn's stored lines ----
    // The rows carry the store line they were drawn from (`data-ltext`), in document order; the panel's own record of
    // the turn is /api/jobs. Both sides are read from the shipped writer and the shipped route, and every row is
    // inside the console, so a dot of the row could only appear if the row were in the record.
    const pageRows = await page.evaluate(() => {
      const out = document.querySelector("pre.job-out");
      return {
        rows: [...out.querySelectorAll("[data-ltext]")].map((n) => n.dataset.ltext),
        text: out.textContent,
        lastRow: out.lastElementChild ? out.lastElementChild.textContent : "",
        marchInside: out.querySelectorAll("[data-march]").length,
        marchRows: document.querySelectorAll("[data-march]").length,
      };
    });
    const store = await fetch(`${sandbox.base}/api/jobs`).then((r) => r.json());
    const storedJob = (store.jobs || []).find((j) => j.id === jobA);
    // The store holds three kinds of thing: the turn's own prose (`text`), the panel's record of the tools it ran
    // (`tool`, `tool-out`), and the panel LOGGING about the turn - the POST it made, the run id, "run completed"
    // (`cmd`, `init`, `dim`, `result`). Only the first is the record this card shows, so the comparison is against the
    // turn's own lines: every one of them has to be on screen, in the store's order, and nothing on screen may be a
    // line the store does not hold.
    const storedAll = (storedJob?.lines || []).filter((l) => l && typeof l.text === "string");
    const kinds = storedAll.reduce((m, l) => ({ ...m, [l.kind || "?"]: (m[l.kind || "?"] || 0) + 1 }), {});
    const prose = storedAll.filter((l) => l.kind === "text" && l.text !== "").map((l) => l.text);
    const every = new Set(storedAll.filter((l) => l.text !== "").map((l) => l.text));
    check("no row of the marching tail is left in the console after the settle", pageRows.marchInside === 0 && pageRows.marchRows === 0, `inside=${pageRows.marchInside} anywhere=${pageRows.marchRows}`);
    const drawn = pageRows.rows.filter((t) => t !== "");
    const missing = prose.filter((t) => !drawn.includes(t));
    const foreign = drawn.filter((t) => !every.has(t));
    let walked = 0;
    for (const t of drawn) if (walked < prose.length && prose[walked] === t) walked += 1;
    out.main.record = { rows: drawn.length, prose: prose.length, walked, foreign: foreign.length, missing: missing.length, kinds };
    check(
      "the rendered record reads back as the turn's own lines, in order, with no dot in it",
      missing.length === 0 && foreign.length === 0 && walked === prose.length && !/\.\s\.\s\./.test(pageRows.text),
      `${drawn.length} rendered row(s), ${prose.length} line(s) of the turn's own text (store kinds ${JSON.stringify(kinds)}); ${walked} in order` +
        (missing.length ? `; ${missing.length} line(s) not drawn ${JSON.stringify(missing.slice(0, 2).map((s) => s.slice(0, 50)))}` : "") +
        (foreign.length ? `; ${foreign.length} row(s) not in the store ${JSON.stringify(foreign.slice(0, 2).map((s) => s.slice(0, 50)))}` : ""),
    );
    const lastLine = String(prose[prose.length - 1] || "").trimEnd();
    check(
      "the record ends where the turn's own text ends",
      lastLine.length > 0 && pageRows.text.trimEnd().endsWith(lastLine.slice(-30)),
      `record ends ${JSON.stringify(pageRows.text.trimEnd().slice(-40))}, store ends ${JSON.stringify(lastLine.slice(-40))}`,
    );

    // ---- phase B: the same row with motion held still ----
    const threadB = "march-b";
    await spawn(threadB, "probe: the same console with reduced motion asked for");
    const stillCtx = await browser.newContext({ viewport: { width: 1200, height: 900 }, reducedMotion: "reduce" });
    await stillCtx.addInitScript(pageInit);
    const stillPage = await stillCtx.newPage();
    stillPage.on("pageerror", (e) => out.errors.push(String((e && e.message) || e).slice(0, 200)));
    await stillPage.goto(sandbox.base, { waitUntil: "domcontentloaded" });
    await stillPage.waitForFunction(() => typeof state !== "undefined" && state.jobs, null, { timeout: 30_000 });
    await stillPage.waitForSelector(`.job[data-thread="${threadB}"] pre.job-out`, { timeout: 45_000 });
    await stillPage.waitForSelector("[data-march]", { timeout: 20_000 });
    const before = await stillPage.evaluate(() => {
      const row = document.querySelector("[data-march]");
      const dots = row.querySelector(".march-dots");
      const label = row.querySelector(".march-label");
      const dot = row.querySelector(".pulse-dot");
      return {
        cls: row.className,
        dots: dots.textContent,
        dotsShown: dots.offsetWidth > 0,
        label: label.textContent,
        labelShown: getComputedStyle(label).display !== "none",
        anim: getComputedStyle(dot).animationName,
        reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
      };
    });
    await sleep(2500);
    const after = await stillPage.evaluate(() => ({
      dots: document.querySelector("[data-march] .march-dots").textContent,
      labelShown: getComputedStyle(document.querySelector("[data-march] .march-label")).display !== "none",
    }));
    const shotStill = path.join(SHOTS, "march-reduced-motion.png");
    await shotConsole(stillPage, threadB, shotStill);
    out.still = { before, after };
    check("the browser really asked for reduced motion", before.reduced, String(before.reduced));
    check("the row holds still: one dot, no march", before.dots.trim() === "." && before.dots === after.dots, `${JSON.stringify(before.dots)} -> ${JSON.stringify(after.dots)} over 2.5 s`);
    check("the marching slot is not shown, and the label is", !before.dotsShown && before.labelShown, `dotsShown=${before.dotsShown} label=${JSON.stringify(before.label)}`);
    check("the dot is stopped by the stylesheet's own rule, not a second one", before.anim === "none", `animation-name=${before.anim}`);
    check("the row says it is holding still", /\bis-still\b/.test(before.cls), before.cls);

    const failed = results.filter((r) => !r.ok).length;
    out.shots = { mid: shotMid, done: shotDone, still: shotStill };
    const stamp = path.join(SHOTS, `march-row-${Date.now()}.json`);
    writeFileSync(stamp, JSON.stringify(out, null, 1));
    log(`\n${failed ? `${failed} failed` : "all checks held"} · ${samples.length} samples · ${stamp}`);
    return failed ? 1 : 0;
  } finally {
    await browser?.close().catch(() => {});
    await gw?.close().catch(() => {});
    await sandbox?.stop().catch(() => {});
    rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  }
}

// ---- main ----------------------------------------------------------------------------------------------------------
const pw = loadPlaywright({ root: TREE });
if (!pw) {
  console.log(notRun("tools/verify-march-row.mjs", "Playwright is not installed here (set PANEL_PLAYWRIGHT_ROOT to a directory that has node_modules/playwright)"));
  process.exit(2);
}
const { startPanel } = await import(pathToFileURL(path.join(TREE, "tools", "panel-testkit.mjs")).href);
mkdirSync(SHOTS, { recursive: true });
process.exit(await main(pw, startPanel));
