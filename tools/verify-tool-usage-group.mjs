// Does the 🌊 stream draw a run of tool calls the way the reader asked for it — ONE row per call, bracketed by a rule
// above and a rule below, each row opening the box that call returned — and does the console keep its pin while it is
// drawn?
//
//   node tools/verify-tool-usage-group.mjs                        # this checkout, one card, one group of six calls
//   node tools/verify-tool-usage-group.mjs --root <dir>           # serve another checkout (a `git archive` of HEAD)
//   node tools/verify-tool-usage-group.mjs --shots <dir>          # keep the screenshots it took
//   node tools/verify-tool-usage-group.mjs --seconds 30           # a longer pin window
//
// THE CLAIM, in the reader's own words ("a horizontal rule above and below the group, and inside it ONE line per tool
// call carrying the tool, its identifying target and the elapsed time — no separate result line; each row clickable to
// open today's full-output box"):
//
//   (1) a burst of six calls is SIX rows — one per call, not one per tool name with a tally — and every row carries
//       the tool's glyph and name, the target that call was given (a file and its range, or the command) and the time
//       it took, measured on the layout the reader sees;
//   (2) there is no "↳ tool" line anywhere in the group: the result's own header travels on the row (data-lresult),
//       not in the flow;
//   (3) the group is bracketed by exactly one rule above the rows and one below, and nothing else in the console
//       carries a rule — the blank line it stands apart by is still the stream's `jl-sep`, outside those edges;
//   (4) EVERY row opens the box that call returned: the box is shut at rest, a press (mouse, and Enter on a focused
//       row) opens it in place with that call's output in it, and it is still open through the repaints a live console
//       does — the open state is in the panel's model, not in the DOM;
//   (5) the console does not lose its pin. Every animation frame of the window is sampled: once it is pinned at its
//       newest line, no later frame may paint it away from the bottom while output is still arriving.
//
// WHAT IS DRIVEN. A panel of its own, on a spare port, from the checkout under test (tools/panel-testkit.mjs: own
// PANEL_CONFIG / HERMES_HOME / jobs.json, API_SERVER_KEY empty), so no reader's panel is touched. A stub Runs API
// plays one burst of six calls with their results, then prose, then a second burst of two; every line reaches the page
// as a `jobline` frame from the panel's own server, so the page's own painter, burst cutting and row builder draw it.
//
// Exit codes: 0 every assertion held; 1 one failed (or the page erred); 2 the run did not measure what it claims
// (no Playwright, no 🌊 card, no group of six rows, a console that never overflowed).
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
const SECONDS = Number(opt("--seconds", "20"));
const SHOTS = opt("--shots", path.join(os.tmpdir(), "wag", "tool-usage-group"));
const log = (...a) => console.log(...a);

// ---- the stub Runs API ---------------------------------------------------------------------------------------------
// One burst of six calls (a terminal, two reads with ranges, a patch, a command, a search), the prose that ends the
// burst, then a second burst of two — so "one group, two rules" is measured on a six-row group and the prose between
// the two bursts is proved NOT to be bracketed. After the script, prose keeps arriving: that is what the pin is tested
// against.
const BURST = [
  { event: "tool.started", tool: "terminal", preview: "wc -l docs/a.md" },
  { event: "tool.completed", tool: "terminal", preview: "  42 docs/a.md", duration: 0.31 },
  { event: "tool.started", tool: "read_file", preview: "docs/a.md L1-40" },
  { event: "tool.completed", tool: "read_file", preview: "# Title\n\nbody line\n", duration: 0.22 },
  { event: "tool.started", tool: "read_file", preview: "docs/b.md L5-60" },
  { event: "tool.completed", tool: "read_file", preview: "## Second\n\nanother line\n", duration: 0.41 },
  { event: "tool.started", tool: "patch", preview: "public/app.js" },
  { event: "tool.completed", tool: "patch", preview: "@@ -1,2 +1,3 @@\n-old\n+new\n+added\n", duration: 1.2 },
  { event: "tool.started", tool: "terminal", preview: "git status --short" },
  { event: "tool.completed", tool: "terminal", preview: " M public/app.js", duration: 0.12 },
  { event: "tool.started", tool: "search_files", preview: "tgrp in public/app.js" },
  { event: "tool.completed", tool: "search_files", preview: "public/app.js:1017", duration: 0.9 },
  { event: "message.delta", delta: "\n\nThat is the first burst. Now the second one, after this sentence." },
  { event: "tool.started", tool: "terminal", preview: "npm test" },
  { event: "tool.completed", tool: "terminal", preview: "552 pass, 0 fail", duration: 91.4 },
  { event: "tool.started", tool: "terminal", preview: "git status" },
  { event: "tool.completed", tool: "terminal", preview: "nothing to commit", duration: 0.2 },
];

function nextEvent(rec) {
  if (rec.step < BURST.length) return { ...BURST[rec.step++] };
  // After the script: ordinary output, one paragraph at a time (a delta that BEGINS with a blank line starts a new
  // console line — lib/jobs.js grows one open paragraph until a fragment opens another). That is what the pin window
  // is measured against, and it runs after the rows have been read, so a burst the window later trims costs nothing.
  rec.cycle += 1;
  return { event: "message.delta", delta: `\n\nStill working — paragraph ${rec.cycle} of the burst's own turn.` };
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
        version: "usage-group-stub",
        features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true },
      });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      req.resume();
      req.on("end", () => {
        posts += 1;
        const id = `run_usage_${posts}`;
        runs.set(id, { id, step: 0, cycle: 0, timer: null });
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
// One sample per animation frame per console: where its scroll box is, and how big it is.
function pageInit() {
  const R = { samples: [], errors: [], frames: 0 };
  window.__usage = R;
  window.addEventListener("error", (e) => R.errors.push(String((e && e.message) || e)));
  window.addEventListener("unhandledrejection", (e) => R.errors.push(`unhandledrejection: ${String((e && e.reason && e.reason.message) || e.reason || "")}`));
  const now = () => Math.round(performance.now());
  const sample = () => {
    R.frames += 1;
    const t = now();
    for (const el of document.querySelectorAll("pre.job-out")) {
      R.samples.push({
        t,
        out: el.dataset.out || "",
        top: Math.round(el.scrollTop),
        d: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
        sh: el.scrollHeight,
        ch: el.clientHeight,
      });
    }
    if (R.samples.length > 60_000) R.samples.splice(0, 30_000);
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}

const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const git = (args, cwd) =>
  execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@localhost", ...args], { cwd, stdio: "pipe", encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  return ok;
};

// The pin claim, from the frames: once this console was pinned at its newest line with something to hold, no later
// frame may have painted it away from the bottom. Frames before it overflowed are not the claim.
function analysePin(samples) {
  if (!samples || !samples.length) return { held: false, why: "no frames for this console" };
  const out = { frames: samples.length, maxDistanceAfterPin: 0, unpinnedAfterPin: 0, settledAt: null, grew: false, held: false };
  out.grew = samples.some((s) => s.sh > samples[0].sh);
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

// ---- the run -------------------------------------------------------------------------------------------------------
async function main(pw, startPanel) {
  const work = mkdtempSync(path.join(os.tmpdir(), "wtgui-usage-"));
  const roots = [path.join(work, "rootA")];
  let sandbox = null;
  let gw = null;
  let browser = null;
  const out = { tree: TREE, checks: results, measured: null, rows: null, rules: null, opens: [], pin: null, errors: [] };
  try {
    mkdirSync(path.join(roots[0], "proj", "docs"), { recursive: true });
    const repo = path.join(roots[0], "proj");
    git(["init", "-q", "-b", "main"], repo);
    writeFileSync(path.join(repo, "docs", "a.md"), "# Title\n\nbody line\n");
    writeFileSync(path.join(repo, "docs", "b.md"), "## Second\n\nanother line\n");
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
    const thread = "usage-group";
    const spawned = await fetch(`${sandbox.base}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "probe: the tool-usage group", cwd: repo, existing: true, thread }),
    }).then((x) => x.json());
    if (!spawned || !spawned.job) throw new Error(`spawn failed: ${JSON.stringify(spawned).slice(0, 300)}`);
    const jobId = spawned.job.id;

    browser = await pw.chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await ctx.addInitScript(pageInit);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => out.errors.push(String((e && e.message) || e).slice(0, 200)));
    await page.route("**/api/thinking**", (route) => route.fulfill({ json: { blocks: [] } }));
    await page.goto(sandbox.base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.jobs, null, { timeout: 30_000 });
    await page.evaluate((t) => {
      localStorage.setItem(`wtgui.stream.${t}`, "1");
      localStorage.setItem(`wtgui.think.${t}`, "1");
    }, thread);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction((t) => [...state.jobs.values()].some((j) => (j.thread || j.id) === t), thread, { timeout: 60_000 });
    await page.evaluate((p) => {
      const n = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      const row = [...state.rows.values()].find((r) => n(r.path) === p);
      if (!row) return false;
      state.expandedProjects.add(row.project);
      state.expanded.add(`${row.project}::${row.path}`);
      renderAll();
      return true;
    }, norm(repo));
    await page.waitForSelector(`.job[data-thread="${thread}"] pre.job-out`, { timeout: 45_000 });
    // Wait until the script has played: six rows in one group plus the second burst.
    const gotBurst = await page
      .waitForFunction(
        () => {
          const groups = [...document.querySelectorAll("pre.job-out .tgrp-flat")];
          return groups.some((g) => g.querySelectorAll(".tgrp-call > .tgrp-row").length >= 6) && groups.length >= 2;
        },
        null,
        { timeout: 60_000 },
      )
      .then(() => true)
      .catch(() => false);
    if (!gotBurst) log("NOT MEASURED  the burst never drew six rows in one group");

    // The rows, the rules and the clicks are measured on the burst while it is the newest thing in the console. The PIN
    // is measured after them, in its own window (below): the panel serves a window of lines, and output that keeps
    // arriving eventually pushes an older burst out of it — a trimmed burst is the window being a window, and it would
    // pair one result to the left of its row, which is not what this harness is about.
    const findGroup = (id) => {
      const out = [...document.querySelectorAll("pre.job-out")].find((o) => o.dataset.out === id);
      if (!out) return null;
      const groups = [...out.querySelectorAll(":scope > .tgrp-flat")];
      return groups.find((g) => g.querySelectorAll(".tgrp-call > .tgrp-row").length >= 6) || null;
    };

    // (1) the rows themselves, read off the layout the reader sees.
    const m = await page.evaluate((id) => {
      const out = [...document.querySelectorAll("pre.job-out")].find((o) => o.dataset.out === id);
      if (!out) return null;
      const groups = [...out.querySelectorAll(":scope > .tgrp-flat")];
      const group = groups.find((g) => g.querySelectorAll(".tgrp-call > .tgrp-row").length >= 6) || null;
      const rows = group ? [...group.querySelectorAll(".tgrp-call > .tgrp-row")] : [];
      const rect = (el) => {
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top * 100) / 100, bottom: Math.round(r.bottom * 100) / 100, height: Math.round(r.height * 100) / 100 };
      };
      const cs = group ? getComputedStyle(group) : null;
      const outCs = getComputedStyle(out);
      return {
        groups: groups.length,
        rows: rows.length,
        rowText: rows.map((r) => ({
          text: (r.textContent || "").replace(/\s+/g, " ").trim(),
          glyph: r.querySelector(".tgrp-g")?.textContent || "",
          name: r.querySelector(".tgrp-name")?.textContent || "",
          target: r.querySelector(".tgrp-last")?.textContent || "",
          state: r.querySelector(".tgrp-state")?.textContent || "",
          aria: r.getAttribute("aria-expanded"),
          key: r.dataset.tgrpCall || "",
        })),
        // what the group SHOWS at rest: the rows, and nothing that reads as a result line
        shown: group
          ? [...group.querySelectorAll("*")]
              .filter((el) => el.offsetParent !== null && !el.children.length && (el.textContent || "").trim())
              .map((el) => (el.textContent || "").trim())
              .filter((t) => /^↳/.test(t))
          : [],
        boxCount: group ? group.querySelectorAll(".tgrp-call > .tgrp-out").length : 0,
        openBoxes: group ? [...group.querySelectorAll(".tgrp-call > .tgrp-out")].filter((b) => !b.hidden).length : 0,
        rules: cs
          ? {
              top: { w: cs.borderTopWidth, style: cs.borderTopStyle, color: cs.borderTopColor },
              bottom: { w: cs.borderBottomWidth, style: cs.borderBottomStyle, color: cs.borderBottomColor },
              left: cs.borderLeftWidth,
              right: cs.borderRightWidth,
              height: Math.round(group.getBoundingClientRect().height * 100) / 100,
              bg: outCs.backgroundColor,
              color: outCs.color,
              rows: rect(rows[0] || group),
              lastRow: rect(rows[rows.length - 1] || group),
              group: rect(group),
            }
          : null,
        // every console child that paints a horizontal rule, by class — the group should be the only one
        ruled: [...out.children]
          .map((n) => {
            const s = getComputedStyle(n);
            return { cls: String(n.className || ""), top: s.borderTopWidth, bottom: s.borderBottomWidth };
          })
          .filter((n) => parseFloat(n.top) > 0 || parseFloat(n.bottom) > 0),
        rowBorders: rows.map((r) => getComputedStyle(r).borderTopWidth),
        prose: (() => {
          if (groups.length < 2) return [];
          const prev = groups[groups.length - 1].previousElementSibling;
          if (!prev) return [];
          return [{ cls: String(prev.className || ""), sep: prev.classList.contains("jl-sep"), top: getComputedStyle(prev).borderTopWidth }];
        })(),
      };
    }, jobId);
    out.measured = m;
    if (!m || !m.rules) {
      const diag = await page.evaluate((id) => {
        const out = [...document.querySelectorAll("pre.job-out")].find((o) => o.dataset.out === id);
        return {
          outs: [...document.querySelectorAll("pre.job-out")].map((o) => o.dataset.out),
          children: out ? [...out.children].map((n) => `${String(n.className || "")}[${n.dataset.tgrp || n.dataset.lkind || ""}]=${(n.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60)}`) : [],
          groups: out ? [...out.querySelectorAll(".tgrp-flat")].map((g) => ({ rows: g.querySelectorAll(".tgrp-row").length, calls: g.querySelectorAll(".tgrp-call").length, html: g.innerHTML.slice(0, 300) })) : [],
          errors: window.__usage.errors,
        };
      }, jobId);
      log("NOT MEASURED  no group of six rows on this console");
      log(JSON.stringify(diag, null, 1).slice(0, 4000));
      return 2;
    }

    check("the burst drew ONE group of five or more rows", m.rows >= 5, `${m.rows} rows over ${m.groups} group(s) in this console`);
    check("every row carries a glyph, a tool name and a target", m.rowText.every((r) => r.glyph && r.name && r.target), JSON.stringify(m.rowText.map((r) => [r.glyph, r.name, r.target])).slice(0, 240));
    check("each row carries the target the call was given, not just the tool", ["wc -l docs/a.md", "docs/a.md L1-40", "docs/b.md L5-60", "public/app.js", "git status --short", "tgrp in public/app.js"].every((t) => m.rowText.some((r) => r.target === t || r.target.includes(t))), JSON.stringify(m.rowText.map((r) => r.target)).slice(0, 300));
    check("each row carries the elapsed time of its own call", m.rowText.every((r) => /^\d+\.\d\ds$/.test(r.state)) && new Set(m.rowText.map((r) => r.state)).size >= 5, JSON.stringify(m.rowText.map((r) => r.state)));
    check("no separate '↳ tool' result line is drawn in the group", m.shown.length === 0, m.shown.length ? JSON.stringify(m.shown.slice(0, 3)) : "none visible");
    check("every row has a shut box of its own", m.boxCount === m.rows && m.openBoxes === 0, `${m.boxCount} box(es), ${m.openBoxes} open at rest`);

    // (3) the two rules: one above the rows, one below, and nothing else in the console ruled.
    const r = m.rules;
    check("one rule above the rows", r.top.style === "solid" && parseFloat(r.top.w) === 1 && r.top.color !== r.bg, `border-top: ${r.top.w} ${r.top.style} ${r.top.color}`);
    check("one rule below the rows", r.bottom.style === "solid" && parseFloat(r.bottom.w) === 1 && r.bottom.color !== r.bg, `border-bottom: ${r.bottom.w} ${r.bottom.style} ${r.bottom.color}`);
    check("the rules are the group's own edges, not a line per row", m.rowBorders.every((w) => parseFloat(w) === 0) && r.left === "0px" && r.right === "0px", `row borders ${JSON.stringify(m.rowBorders)}, sides ${r.left}/${r.right}`);
    check("the group is the only ruled thing in the console", m.ruled.length >= 1 && m.ruled.every((n) => /tgrp-flat/.test(n.cls)), JSON.stringify(m.ruled).slice(0, 300));
    check("the rows sit inside the two rules", r.rows.top >= r.group.top && r.lastRow.bottom <= r.group.bottom, `rows ${r.rows.top}..${r.lastRow.bottom} in group ${r.group.top}..${r.group.bottom}`);
    check(
      "the prose between two bursts is not bracketed",
      m.prose.length > 0 && m.prose.every((p) => !p.sep || parseFloat(p.top) === 0),
      JSON.stringify(m.prose).slice(0, 200),
    );

    // (4) each row opens ITS box, by mouse for the first and by keyboard for one, then all of them through a repaint.
    const openOne = async (i, how) => {
      const row = page.locator(`.job[data-thread="${thread}"] .tgrp-call > .tgrp-row`).nth(i);
      if (how === "keyboard") {
        await row.focus();
        await page.keyboard.press("Enter");
      } else {
        await row.click();
      }
      await sleep(400);
      return page.evaluate(
        ({ id, i: idx }) => {
          const out = [...document.querySelectorAll("pre.job-out")].find((o) => o.dataset.out === id);
          const group = [...(out?.querySelectorAll(":scope > .tgrp-flat") || [])].find((g) => g.querySelectorAll(".tgrp-call > .tgrp-row").length >= 6);
          const block = group?.querySelectorAll(".tgrp-call")[idx];
          const rowEl = block?.querySelector(":scope > .tgrp-row");
          const box = block?.querySelector(":scope > .tgrp-out");
          return {
            hidden: box ? box.hidden : null,
            text: box ? (box.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120) : "",
            lines: box ? box.querySelectorAll(".jl, .code-box").length : 0,
            aria: rowEl?.getAttribute("aria-expanded") || "",
            open: Boolean(rowEl && state.callOpen.has(rowEl.dataset.tgrpCall || "")),
            title: rowEl?.title || "",
          };
        },
        { id: jobId, i },
      );
    };
    const openAll = [];
    for (let i = 0; i < m.rows; i++) {
      const got = await openOne(i, i === 1 ? "keyboard" : "mouse");
      out.opens.push(got);
      openAll.push(got);
      check(`row ${i + 1} opens its own box`, got.hidden === false && got.lines > 0 && got.aria === "true" && got.open, `hidden=${got.hidden} aria=${got.aria} box=${got.lines} node(s) · ${got.text.slice(0, 70)}`);
    }
    // The live console repaints (a store read, a 3 s sweep, a pinned copy): the open state is the panel's, not the DOM's.
    await sleep(3600);
    const still = await page.evaluate((id) => {
      const out = [...document.querySelectorAll("pre.job-out")].find((o) => o.dataset.out === id);
      const group = [...(out?.querySelectorAll(":scope > .tgrp-flat") || [])].find((g) => g.querySelectorAll(".tgrp-call > .tgrp-row").length >= 6);
      const boxes = [...(group?.querySelectorAll(".tgrp-call > .tgrp-out") || [])];
      return { open: boxes.filter((b) => !b.hidden).length, total: boxes.length };
    }, jobId);
    check("the boxes stay open through the console's own repaints", still.open === openAll.length, `${still.open}/${still.total} open after 3.6 s`);
    // The other half of the same claim, on the path a live append and the 3 s store sweep take: a group rebuilt from
    // its own DOM (no live buffer) must read back as the SAME calls — the result header travels on the row
    // (data-lresult), so the times, the pairing and the store cursor survive a rebuild that never saw the lines.
    const rebuilt = await page.evaluate((id) => {
      const out = [...document.querySelectorAll("pre.job-out")].find((o) => o.dataset.out === id);
      const group = [...(out?.querySelectorAll(":scope > .tgrp-flat") || [])].find((g) => g.querySelectorAll(".tgrp-call > .tgrp-row").length >= 6);
      if (!group) return null;
      const shape = (el) => groupLines(el).map((l) => `${l.kind}:${String(l.text || "").slice(0, 28)}`);
      const before = shape(group);
      const gkey = group.dataset.gstate;
      rebuildToolGroup(group, {});
      const fresh = [...out.querySelectorAll(`.tgrp[data-gstate="${CSS.escape(gkey)}"]`)][0];
      if (!fresh) return { before, after: [], rows: 0, times: [], open: 0 };
      return {
        before,
        after: shape(fresh),
        rows: fresh.querySelectorAll(".tgrp-call > .tgrp-row").length,
        times: [...fresh.querySelectorAll(".tgrp-call > .tgrp-row .tgrp-state")].map((s) => s.textContent),
        open: [...fresh.querySelectorAll(".tgrp-call > .tgrp-out")].filter((b) => !b.hidden).length,
      };
    }, jobId);
    check(
      "a rebuild from the group's own DOM reads back the same calls, times and open boxes",
      Boolean(rebuilt) && rebuilt.rows === m.rows && JSON.stringify(rebuilt.before) === JSON.stringify(rebuilt.after) && rebuilt.times.every((t) => /^\d+\.\d\ds$/.test(t)) && rebuilt.open === openAll.length,
      rebuilt ? `${rebuilt.rows} rows, times ${JSON.stringify(rebuilt.times)}, ${rebuilt.open} box(es) open` : "no group",
    );
    // ...and a press shuts the one it opened.
    const shut = await openOne(0, "mouse");
    check("a second press shuts that row's box again", shut.hidden === true && shut.aria === "false" && shut.open === false, `hidden=${shut.hidden} aria=${shut.aria}`);

    // The screenshots: the group at rest (what the reader's screenshot shows), then with two boxes open.
    mkdirSync(SHOTS, { recursive: true });
    const card = page.locator(`.job[data-thread="${thread}"] pre.job-out`);
    const rows = page.locator(`.job[data-thread="${thread}"] .tgrp-call > .tgrp-row`);
    const openNow = await page.evaluate((id) => {
      const out = [...document.querySelectorAll("pre.job-out")].find((o) => o.dataset.out === id);
      return [...(out?.querySelectorAll(".tgrp-call > .tgrp-out") || [])].filter((b) => !b.hidden).length;
    }, jobId);
    for (let i = 0; i < openNow; i++) {
      const shut = await page.evaluate((id) => {
        const out = [...document.querySelectorAll("pre.job-out")].find((o) => o.dataset.out === id);
        const group = [...(out?.querySelectorAll(":scope > .tgrp-flat") || [])].find((g) => g.querySelectorAll(".tgrp-call > .tgrp-row").length >= 6);
        const block = [...(group?.querySelectorAll(".tgrp-call") || [])].find((b) => !b.querySelector(":scope > .tgrp-out").hidden);
        block?.querySelector(":scope > .tgrp-row")?.click();
        return Boolean(block);
      }, jobId);
      if (!shut) break;
      await sleep(120);
    }
    await sleep(300);
    await card.screenshot({ path: path.join(SHOTS, "1-group-at-rest.png") });
    await rows.nth(0).click();
    await rows.nth(3).click();
    await sleep(400);
    await card.screenshot({ path: path.join(SHOTS, "2-group-with-two-boxes-open.png") });
    log(`shots: ${SHOTS}`);

    // The pin, in its own window now that the rows are measured and shot: the console has been following the newest
    // line since the burst landed, and output keeps arriving through it for `--seconds`. Every animation frame from
    // here on is sampled: once it is pinned at its newest line, no later frame may paint it away from the bottom.
    const pinFrom = await page.evaluate(() => {
      window.__usage.pinFrom = Math.round(performance.now());
      return window.__usage.pinFrom;
    });
    const t0 = Date.now();
    while ((Date.now() - t0) / 1000 < SECONDS) await sleep(1000);
    const rec = await page.evaluate(() => ({ samples: window.__usage.samples, errors: window.__usage.errors, frames: window.__usage.frames }));
    out.errors.push(...rec.errors.map((e) => String(e).slice(0, 200)));
    const box = await page.evaluate((id) => {
      const el = [...document.querySelectorAll("pre.job-out")].find((o) => o.dataset.out === id);
      return el ? { sh: el.scrollHeight, ch: el.clientHeight } : null;
    }, jobId);
    out.pin = analysePin(rec.samples.filter((s) => s.out === jobId && s.t >= pinFrom));
    check("the console overflowed: there was something to keep pinned", Boolean(box && box.sh > box.ch + 20), box ? `${box.sh}px of text in ${box.ch}px` : "no console");
    check(
      "the console never lost its pin while output kept arriving",
      Boolean(out.pin && out.pin.held),
      out.pin ? `settled at ${out.pin.settledAt}ms, ${out.pin.unpinnedAfterPin} frame(s) off the bottom after that, ${out.pin.grew ? "output kept arriving" : "output never grew"}${out.pin.why ? ` — ${out.pin.why}` : ""}` : "no frames",
    );

    for (const e of out.errors) log(`page error: ${e}`);
    check("the page raised no error", out.errors.length === 0, out.errors.slice(0, 2).join(" | "));
    const failed = results.filter((x) => !x.ok).length;
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(path.join(SHOTS, `usage-group-${Date.now()}.json`), JSON.stringify(out, null, 1));
    log(`\n${failed ? `${failed} failed` : "all checks held"} · ${rec.frames} frames sampled`);
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
  console.log(notRun("tools/verify-tool-usage-group.mjs", "Playwright is not installed here (set PANEL_PLAYWRIGHT_ROOT to a directory that has node_modules/playwright)"));
  process.exit(2);
}
const { startPanel } = await import(pathToFileURL(path.join(TREE, "tools", "panel-testkit.mjs")).href);
mkdirSync(SHOTS, { recursive: true });
process.exit(await main(pw, startPanel));
