// Is every piece of the 🌊 stream set apart from the piece above it — and does the console keep its pin while the
// blank lines are drawn?
//
//   node tools/verify-stream-separation.mjs                       # this checkout, 45 s window, one card, one control
//   node tools/verify-stream-separation.mjs --root <dir>          # serve another checkout (a `git archive` of HEAD)
//   node tools/verify-stream-separation.mjs --seconds 60          # a longer window
//   node tools/verify-stream-separation.mjs --cards 2             # two live cards
//   node tools/verify-stream-separation.mjs --serve --out <dir>   # stand the panel up and leave it running for pop-a
//   node tools/verify-stream-separation.mjs --record before --seconds 60
//                                                                 # the same fixture, measured by tools/pop-a.mjs's
//                                                                 # own frame recorder (hops / tail / painted hops)
//
// THE CLAIM. In the combined console (the 🌊 beside the 🧠) a reasoning block has always been set apart from the line
// above it by one blank line. The reader asked for the same blank line before every group of tool output and every
// chunk of normal output, and for the condensed console to look exactly as it did. So:
//
//   (1) every piece but the console's first carries `jl-sep`, and the rule that class hangs on gives it one line of
//       this console's own line-height of margin — measured on the layout, not on the string (a computed margin and
//       the painted gap between two pieces' boxes, which is what the reader sees);
//   (2) the first piece has no blank line above it, as a reasoning block at the top of a console never had one;
//   (3) the three kinds are all there and all separated: a reasoning row, a group of tool output, a chunk of words;
//   (4) nothing on a CONDENSED card wears the class or moved: those groups keep the 3px/6px margins they had, which
//       is "do not change any other layout";
//   (5) the console does not lose its pin. Every animation frame of the window is sampled: from the frame it is
//       pinned at its newest line, no later frame may paint it away from the bottom while output is still arriving.
//       The blank lines are drawn by the same repaints that used to shift a console, so this is the measurement that
//       says the new margins cost the pin nothing.
//
// WHAT IS DRIVEN. A panel of its own, on a spare port, from the checkout under test (tools/panel-testkit.mjs: own
// PANEL_CONFIG / HERMES_HOME / jobs.json, API_SERVER_KEY empty), so no reader's panel is touched. A stub Runs API
// plays a loop of prose, tool calls, their results and reasoning previews over real SSE; the cards are spawned
// through the panel's own POST /api/agents; every line reaches the page as a `jobline` frame from the panel's own
// server. The reasoning ROWS come from `/api/thinking`, which the sandbox has no store for, so that one route is
// answered here — the page's own merge, painter and pacer still draw them.
//
// Exit codes: 0 every assertion held; 1 one failed (or the page erred); 2 the run did not measure what it claims
// (no Playwright, no 🌊 card, no console overflowing, a kind missing from the stream).
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright, notRun } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const flag = (name) => argv.includes(name);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SECONDS = Number(opt("--seconds", "45"));
const OUT = opt("--out", path.join(os.tmpdir(), "wag", "stream-separation"));
const CARDS = Math.max(1, Number(opt("--cards", "1")));
const SERVE = flag("--serve");
// `--record <scenario>` hands the same live panel to tools/pop-a.mjs's own frame recorder: the pin measurement this
// repo already trusts, run on a card whose stream was stood up here (so the SAME fixture can be measured on two
// checkouts — a git archive of HEAD and the working tree — and the tables compared).
const RECORD = opt("--record", "");
const log = (...a) => console.log(...a);

// ---- the stub Runs API ---------------------------------------------------------------------------------------------
// One event every 300 ms, cycling prose -> call -> result -> prose -> call -> result -> reasoning preview. A paragraph
// is a delta that BEGINS with a blank line, because lib/jobs.js grows one open paragraph in place until a fragment
// starts a new one: that is how the console gets distinct text lines without a tool call between them.
function nextEvent(rec) {
  const n = rec.cycle;
  const step = rec.step++ % 7;
  switch (step) {
    case 0:
      return { event: "message.delta", delta: `\n\nCycle ${n}: I'll check how long the file is.` };
    case 1:
      return { event: "tool.started", tool: "terminal", preview: "wc -l docs/a.md" };
    case 2:
      return { event: "tool.completed", tool: "terminal", preview: `  ${42 + (n % 7)} docs/a.md`, duration: 0.31 };
    case 3:
      return { event: "message.delta", delta: `\n\nIt is ${42 + (n % 7)} lines, so I'll read the head of it.` };
    case 4:
      return { event: "tool.started", tool: "read_file", preview: "docs/a.md" };
    case 5:
      rec.cycle = n + 1;
      return { event: "tool.completed", tool: "read_file", preview: "# Title\n\nbody line\n", duration: 0.22 };
    default:
      return { event: "reasoning.available", text: `the file is short; the heading is what matters (cycle ${n})` };
  }
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
        version: "separation-stub",
        features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true },
      });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      req.resume();
      req.on("end", () => {
        posts += 1;
        const id = `run_sep_${posts}`;
        runs.set(id, { id, step: 0, cycle: 1, timer: null });
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
      res.write(": open\n\n");
      if (!rec) return res.end();
      if (rec.timer) clearInterval(rec.timer);
      let seq = 0;
      const timer = setInterval(() => {
        const evt = nextEvent(rec);
        res.write(`id: ${seq}\ndata: ${JSON.stringify({ ...evt, run_id: rec.id, seq: seq++, timestamp: Date.now() / 1000 })}\n\n`);
      }, 300);
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
// One sample per animation frame per console: where its scroll box is, how big it is, and how many pieces it holds. The
// winning question is "was it ever painted away from its newest line once it had settled there".
function pageInit() {
  const R = { samples: [], errors: [], frames: 0 };
  window.__sep = R;
  window.addEventListener("error", (e) => R.errors.push(String((e && e.message) || e)));
  window.addEventListener("unhandledrejection", (e) => R.errors.push(`unhandledrejection: ${String((e && e.reason && e.reason.message) || e.reason || "")}`));
  const now = () => Math.round(performance.now());
  const sample = () => {
    R.frames += 1;
    const t = now();
    for (const el of document.querySelectorAll("pre.job-out")) {
      const d = el.scrollHeight - el.scrollTop - el.clientHeight;
      R.samples.push({
        t,
        out: el.dataset.out || "",
        top: Math.round(el.scrollTop),
        d: Math.round(d),
        sh: el.scrollHeight,
        ch: el.clientHeight,
        kids: el.children.length,
      });
    }
    // A long window on a wide board is a lot of frames: keep the recent past, which is where a settled pin lives.
    if (R.samples.length > 60_000) R.samples.splice(0, 30_000);
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}

// What is IN the console, as the reader sees it: each piece, its class, its computed top margin, and the painted gap
// between its own box and the box above it. Measured in the page (page.evaluate), so it reads the real layout.
const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
// The fixture repo the card runs in. Its own identity, so a throwaway scan root needs no git config first.
const git = (args, cwd) =>
  execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@localhost", ...args], { cwd, stdio: "pipe", encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  return ok;
};

// ---- one card, one console, measured -------------------------------------------------------------------------------
async function main(pw, startPanel) {
  const work = mkdtempSync(path.join(os.tmpdir(), "wtgui-sep-"));
  const roots = [path.join(work, "rootA")];
  let sandbox = null;
  let gw = null;
  let browser = null;
  const out = { tree: TREE, seconds: SECONDS, cards: CARDS, checks: results, measured: null, control: null, pin: null, errors: [] };
  try {
    mkdirSync(path.join(roots[0], "proj", "docs"), { recursive: true });
    const repo = path.join(roots[0], "proj");
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
        defaultCwd: repo,
        apiServer: { url: `http://127.0.0.1:${gwPort}`, key: "probe" },
      },
      env: { API_SERVER_KEY: "" },
    });
    log(`panel ${sandbox.base} (${TREE})`);
    const spawned = [];
    for (let i = 0; i < CARDS; i++) {
      const thread = `sep-${i + 1}`;
      const r = await fetch(`${sandbox.base}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: `probe: stream for the separation check #${i + 1}`, cwd: repo, existing: true, thread }),
      }).then((x) => x.json());
      if (!r || !r.job) throw new Error(`spawn failed: ${JSON.stringify(r).slice(0, 300)}`);
      spawned.push({ thread, job: r.job.id });
    }
    // The condensing control: a card that is NOT drawn as one stream. Only spawned for the default single-card run, so
    // the separation measurement is not confused by a second live console.
    let control = null;
    if (!SERVE && !RECORD) {
      const thread = "sep-condensed";
      const r = await fetch(`${sandbox.base}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "probe: the condensed control card", cwd: repo, existing: true, thread }),
      }).then((x) => x.json());
      if (r && r.job) control = { thread, job: r.job.id };
    }

    if (SERVE) {
      writeFileSync(path.join(OUT, "serve.json"), JSON.stringify({ base: sandbox.base, threads: spawned.map((s) => s.thread), pid: process.pid, tree: TREE }, null, 2));
      log(`serving for pop-a: base=${sandbox.base} threads=${spawned.map((s) => s.thread).join(",")}`);
      log(`→ ${path.join(OUT, "serve.json")}  (ctrl-c to stop)`);
      await new Promise(() => {});
    }

    if (RECORD) {
      // pop-a's recorder, on the panel this fixture just stood up: `record` watches every animation frame of the
      // consoles and reports hops, the longest run pinned at the bottom, and how long that run lasted WHILE output was
      // still arriving. Same invocation on both checkouts, so the two tables are comparable.
      const outDir = path.join(OUT, "out");
      mkdirSync(outDir, { recursive: true });
      const args = [
        path.join(HERE, "pop-a.mjs"),
        "record",
        "--base",
        sandbox.base,
        "--mode",
        "combined",
        "--scenario",
        `${RECORD}-combined`,
        "--seconds",
        String(SECONDS),
        "--threads",
        spawned.map((s) => s.thread).join(","),
        "--out",
        outDir,
      ];
      log(`pop-a: node ${args.join(" ")}`);
      const code = await new Promise((resolve) => {
        const child = spawn(process.execPath, args, { cwd: HERE, stdio: "inherit" });
        child.on("exit", (c) => resolve(c == null ? 1 : c));
      });
      return code;
    }

    browser = await pw.chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await ctx.addInitScript(pageInit);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => out.errors.push(String((e && e.message) || e).slice(0, 200)));
    // The sandbox has no session store: the reasoning rows the 🌊 stream draws come from this one route. Three blocks,
    // stamped relative to now, handed over as the page's own `blocks` list.
    await page.route("**/api/thinking**", (route) => {
      const now = Date.now();
      const blocks = [
        { at: now - 40_000, text: "First, what the request actually asks for." },
        { at: now - 20_000, text: "Then: the file is small, so one read is enough." },
        { at: now - 1_500, text: "Now the heading; that is the part worth checking." },
      ];
      return route.fulfill({ json: { blocks } });
    });
    await page.goto(sandbox.base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.jobs, null, { timeout: 30_000 });
    await page.evaluate(
      ({ stream, condensed }) => {
        for (const t of stream) {
          localStorage.setItem(`wtgui.stream.${t}`, "1");
          localStorage.setItem(`wtgui.think.${t}`, "1");
        }
        for (const t of condensed) {
          localStorage.setItem(`wtgui.stream.${t}`, "0");
          localStorage.setItem(`wtgui.think.${t}`, "0");
        }
      },
      { stream: spawned.map((s) => s.thread), condensed: control ? [control.thread] : [] },
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction((threads) => threads.every((t) => [...state.jobs.values()].some((j) => (j.thread || j.id) === t)), spawned.map((s) => s.thread), { timeout: 60_000 });
    // The row is the card's owner: expand it and its project with the panel's own state, then repaint.
    await page.evaluate((p) => {
      const norm2 = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      const row = [...state.rows.values()].find((r) => norm2(r.path) === p);
      if (!row) return false;
      state.expandedProjects.add(row.project);
      state.expanded.add(`${row.project}::${row.path}`);
      renderAll();
      return true;
    }, norm(repo));
    for (const s of [...spawned, ...(control ? [control] : [])]) {
      await page.waitForSelector(`.job[data-thread="${s.thread}"] pre.job-out`, { timeout: 45_000 });
    }
    // Start the clocks: everything above is setup, and the pin claim is about what the reader would then watch.
    const t0 = Date.now();
    for (;;) {
      if ((Date.now() - t0) / 1000 >= SECONDS) break;
      await sleep(1000);
    }
    const rec = await page.evaluate(() => ({ samples: window.__sep.samples, errors: window.__sep.errors, frames: window.__sep.frames }));
    out.errors.push(...rec.errors.map((e) => String(e).slice(0, 200)));
    const measured = await page.evaluate(() => {
      const outs = [...document.querySelectorAll("pre.job-out")];
      return { all: outs.map((o) => o.dataset.out), first: null };
    }).catch(() => ({ all: [], first: null }));
    out.consoleIds = measured.all;

    const mainId = spawned[0].job;
    const pick = (id) => {
      const rows = rec.samples.filter((s) => s.out === id);
      return rows;
    };
    const live = pick(mainId);
    const box = await page.evaluate((id) => {
      const el = [...document.querySelectorAll("pre.job-out")].find((o) => o.dataset.out === id);
      return el ? { sh: el.scrollHeight, ch: el.clientHeight } : null;
    }, mainId);
    out.pin = analysePin(live, box);
    check("the console overflowed: there was something to keep pinned", Boolean(box && box.sh > box.ch + 20), box ? `${box.sh}px of text in ${box.ch}px` : "no console");
    check(
      "the console never lost its pin while the blank lines were drawn",
      Boolean(out.pin && out.pin.held),
      out.pin
        ? `settled at ${out.pin.settledAt}ms, ${out.pin.unpinnedAfterPin} frame(s) off the bottom after that, ${out.pin.grew ? "output kept arriving" : "output never grew"}${out.pin.why ? ` — ${out.pin.why}` : ""}`
        : "no frames for this console",
    );

    // The separation itself, on the stream card and on the condensed control.
    const m = await page.evaluate((id) => {
      const el = [...document.querySelectorAll("pre.job-out")].find((o) => o.dataset.out === id);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
      const rows = [...el.children].map((n, i) => {
        const r = n.getBoundingClientRect();
        const st = getComputedStyle(n);
        return {
          i,
          kind: n.dataset.lkind || (n.classList.contains("tgrp") ? "tool-group" : "other"),
          cls: String(n.className || ""),
          sep: n.classList.contains("jl-sep"),
          marginTop: Math.round(parseFloat(st.marginTop) * 100) / 100,
          marginBottom: Math.round(parseFloat(st.marginBottom) * 100) / 100,
          top: Math.round(r.top * 100) / 100,
          bottom: Math.round(r.bottom * 100) / 100,
          height: Math.round(r.height * 100) / 100,
        };
      });
      return {
        lineHeight: Math.round(lineHeight * 100) / 100,
        fontSize: cs.fontSize,
        overflow: el.scrollHeight - el.clientHeight,
        rows,
        gaps: rows.slice(1).map((r, i) => Math.round((r.top - rows[i].bottom) * 100) / 100),
        kinds: {
          think: rows.filter((r) => r.kind === "think").length,
          "tool-group": rows.filter((r) => r.kind === "tool-group").length,
          text: rows.filter((r) => r.kind === "text").length,
          sep: rows.filter((r) => r.sep).length,
        },
      };
    }, mainId);
    out.measured = m;
    if (!m) {
      log("NOT MEASURED  the stream card has no console");
      return 2;
    }
    const first = m.rows[0];
    const rest = m.rows.slice(1);
    check("the stream drew all three kinds", m.kinds.think > 0 && m.kinds["tool-group"] > 1 && m.kinds.text > 1, JSON.stringify(m.kinds));
    check("the console's first piece has no blank line above it", Boolean(first) && !first.sep && first.marginTop === 0, first ? `sep=${first.sep} margin-top=${first.marginTop}` : "no pieces");
    check("every other piece carries the separation class", rest.length > 0 && rest.every((r) => r.sep), `${rest.filter((r) => r.sep).length}/${rest.length} pieces`);
    check(
      `each separated piece gets one console line of margin (${m.lineHeight}px)`,
      rest.every((r) => Math.abs(r.marginTop - m.lineHeight) <= 1),
      `margins ${[...new Set(rest.map((r) => r.marginTop))].join(", ")}`,
    );
    check(
      `the painted gap between pieces is one console line of blank space (${m.lineHeight}px)`,
      m.gaps.length > 0 && m.gaps.every((g) => g >= m.lineHeight - 1),
      `min ${Math.min(...m.gaps)}px, max ${Math.max(...m.gaps)}px over ${m.gaps.length} gaps`,
    );
    for (const kind of ["think", "tool-group", "text"]) {
      const own = m.rows.filter((r) => r.kind === kind && r.i > 0);
      check(`a ${kind} piece after the first is set apart (${own.length} measured)`, own.length > 0 && own.every((r) => r.sep && Math.abs(r.marginTop - m.lineHeight) <= 1));
    }
    if (control) {
      const c = await page.evaluate((id) => {
        const el = [...document.querySelectorAll("pre.job-out")].find((o) => o.dataset.out === id);
        if (!el) return null;
        return {
          rows: [...el.children].length,
          groups: [...el.querySelectorAll(":scope > .tgrp")].map((n) => ({ cls: String(n.className), margin: getComputedStyle(n).margin })),
          sep: el.querySelectorAll(".jl-sep").length,
        };
      }, control.job);
      out.control = c;
      check("the condensed card wears no separation class at all", Boolean(c) && c.sep === 0, c ? `${c.sep} of ${c.rows} pieces` : "no control console");
      check(
        "and its tool groups keep the margins they had (3px 0 6px)",
        Boolean(c) && c.groups.length > 0 && c.groups.every((g) => /3px\s+0px\s+6px/.test(g.margin)),
        c ? `${c.groups.length} group(s): ${[...new Set(c.groups.map((g) => g.margin))].join(" / ")}` : "no groups",
      );
    }
    for (const e of out.errors) log(`page error: ${e}`);
    check("the page raised no error", out.errors.length === 0, out.errors.slice(0, 2).join(" | "));
    const failed = results.filter((r) => !r.ok).length;
    mkdirSync(OUT, { recursive: true });
    writeFileSync(path.join(OUT, `separation-${Date.now()}.json`), JSON.stringify(out, null, 1));
    log(`\n${failed ? `${failed} failed` : "all checks held"} · ${rec.frames} frames sampled`);
    return failed ? 1 : 0;
  } finally {
    await browser?.close().catch(() => {});
    await gw?.close().catch(() => {});
    await sandbox?.stop().catch(() => {});
    rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  }
}

// The pin claim, from the frames: once this console was pinned at its newest line with something to hold, no later
// frame may have painted it away from the bottom. Frames before it overflowed are not the claim (there is no "newest
// line" to keep when the text fits).
function analysePin(samples, box) {
  if (!samples || !samples.length) return { held: false, why: "no frames for this console" };
  const out = { frames: samples.length, maxDistanceAfterPin: 0, unpinnedAfterPin: 0, settledAt: null, grew: false, held: false };
  const startKids = samples[0].kids;
  out.grew = samples.some((s) => s.kids > startKids || s.sh > samples[0].sh);
  let settled = null;
  for (const s of samples) {
    if (s.sh - s.ch <= 20) continue;
    if (s.d <= 8) {
      if (settled == null) {
        settled = s.t;
        out.settledAt = s.t;
      }
      continue;
    }
    if (settled != null && s.d > 8) {
      out.unpinnedAfterPin += 1;
      out.maxDistanceAfterPin = Math.max(out.maxDistanceAfterPin, s.d);
    }
  }
  out.held = settled != null && out.unpinnedAfterPin === 0 && out.grew;
  if (!out.held) {
    out.why = settled == null ? "the console never settled at its newest line" : !out.grew ? "the console never grew, so nothing tested the pin" : `${out.unpinnedAfterPin} frame(s) painted it off the bottom (max ${out.maxDistanceAfterPin}px)`;
  }
  return out;
}

// ---- main ----------------------------------------------------------------------------------------------------------
const pw = loadPlaywright({ root: TREE });
if (!pw) {
  console.log(notRun("tools/verify-stream-separation.mjs", "Playwright is not installed here (set PANEL_PLAYWRIGHT_ROOT to a directory that has node_modules/playwright)"));
  process.exit(2);
}
const { startPanel } = await import(pathToFileURL(path.join(TREE, "tools", "panel-testkit.mjs")).href);
mkdirSync(OUT, { recursive: true });
process.exit(await main(pw, startPanel));
