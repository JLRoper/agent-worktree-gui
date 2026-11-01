// Does ONE tool call read as ONE line, unexpanded, when the tally is off — and does the Settings switch put the
// tallied group back?
//
//   node tools/verify-tool-call-rows.mjs                          # this checkout, one card, a burst of three calls
//   node tools/verify-tool-call-rows.mjs --root <dir>             # serve another checkout (a `git archive` of HEAD)
//   node tools/verify-tool-call-rows.mjs --shots <dir>            # keep the screenshots it took
//
// THE CLAIM, in the reader's own words ("if the toggle is off, then each tool call is one expandable line when
// clicked on" — and the shape he was shown took four: a head row with a tally, an "all N" button, the call row, its
// "↳ tool" result line, and the output box under them):
//
//   (1) with the setting off — which is how it ships — a run of three calls is THREE rows and nothing else: no head
//       row, no per-tool tally, no "all N" button, no "↳ tool" result line in the flow;
//   (2) each row is ONE line tall on the layout the reader sees: its painted height is the console's own
//       line-height (within a pixel or two), and the whole group at rest is three lines plus the rules and padding;
//   (3) each row is its own opener: the box behind it is shut at rest, a press opens it in place with THAT call's
//       output in it, and the group's other rows do not move;
//   (4) the group is still a group — one rule above the rows and one below — so a burst is bracketed exactly as the
//       tallied version was;
//   (5) the Settings switch is live: pressing the real `#group-tools` checkbox redraws this card as the tallied
//       group (a head row per tool with the count, an "all N" button, the call blocks in the body), and pressing it
//       again puts the three rows back — the same card, in both shapes, without a reload.
//
// WHAT IS DRIVEN. A panel of its own, on a spare port, from the checkout under test (tools/panel-testkit.mjs: own
// PANEL_CONFIG / HERMES_HOME / jobs.json, API_SERVER_KEY empty), so no reader's panel is touched. A stub Runs API
// plays one burst of three calls with their results, then prose; every line reaches the page as a `jobline` frame
// from the panel's own server, so the page's own painter, burst cutting and row builder draw it.
//
// Exit codes: 0 every assertion held; 1 one failed (or the page erred); 2 the run did not measure what it claims
// (no Playwright, no card, no group of three rows).
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
const SHOTS = opt("--shots", path.join(os.tmpdir(), "wag", "tool-call-rows"));
const log = (...a) => console.log(...a);

// ---- the stub Runs API ---------------------------------------------------------------------------------------------
// Three calls of three different tools (so the tally would draw three head rows), each followed by its result, then
// the prose that ends the burst. The results carry text a row's box can be recognised by.
const BURST = [
  { event: "tool.started", tool: "terminal", preview: "git status --short" },
  { event: "tool.completed", tool: "terminal", preview: "  M public/app.js", duration: 0.31 },
  { event: "tool.started", tool: "read_file", preview: "docs/a.md L1-40" },
  { event: "tool.completed", tool: "read_file", preview: "# Title\n\nbody line\n", duration: 0.22 },
  { event: "tool.started", tool: "patch", preview: "public/app.js" },
  { event: "tool.completed", tool: "patch", preview: "@@ -1,2 +1,3 @@\n-old\n+new\n+added\n", duration: 1.2 },
  { event: "message.delta", delta: "\n\nThe burst is finished; this paragraph ends it." },
];

function nextEvent(rec) {
  if (rec.step < BURST.length) return { ...BURST[rec.step++] };
  rec.cycle += 1;
  return { event: "message.delta", delta: `\n\nStill working — paragraph ${rec.cycle}.` };
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
        version: "call-rows-stub",
        features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true },
      });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      req.resume();
      req.on("end", () => {
        posts += 1;
        const id = `run_rows_${posts}`;
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

const git = (args, cwd) =>
  execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@localhost", ...args], { cwd, stdio: "pipe", encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  return ok;
};

// ---- the page-side reader ------------------------------------------------------------------------------------------
// Everything measured in the page, on ONE console: the group, its rows, their painted geometry, and what a click
// opened. `shape` describes which of the two the card is drawn in, so a check can say what it actually saw.
function readGroup(outId) {
  const out = [...document.querySelectorAll("pre.job-out")].find((o) => o.dataset.out === outId);
  if (!out) return null;
  const group = out.querySelector(":scope > .tgrp");
  if (!group) return null;
  const rows = [...group.querySelectorAll(".tgrp-call > .tgrp-row")];
  const pre = getComputedStyle(out);
  const cs = getComputedStyle(group);
  const px = (v) => Math.round(Number.parseFloat(v) * 100) / 100;
  const flow = (group.textContent || "").replace(/\s+/g, " ").trim();
  return {
    flat: group.dataset.gflat === "1",
    headRows: [...group.querySelectorAll(":scope > .tgrp-head > .tgrp-row")].map((r) => (r.textContent || "").replace(/\s+/g, " ").trim()),
    more: group.querySelector("[data-tgrp-more]") ? (group.querySelector("[data-tgrp-more]").textContent || "").trim() : null,
    tallyRows: group.querySelectorAll("[data-tgrp-tool]").length,
    calls: group.querySelectorAll(".tgrp-call").length,
    callBlocks: group.querySelectorAll(".call").length,
    rows: rows.map((r) => ({
      text: (r.textContent || "").replace(/\s+/g, " ").trim(),
      glyph: r.querySelector(".tgrp-g") ? r.querySelector(".tgrp-g").textContent : "",
      name: r.querySelector(".tgrp-name") ? r.querySelector(".tgrp-name").textContent : "",
      target: r.querySelector(".tgrp-last") ? r.querySelector(".tgrp-last").textContent : "",
      height: px(r.getBoundingClientRect().height),
      expanded: r.getAttribute("aria-expanded"),
      boxShut: (() => {
        const block = r.closest(".tgrp-call");
        const box = block && block.querySelector(":scope > .tgrp-out");
        return box ? box.hidden : null;
      })(),
    })),
    lineHeight: px(pre.lineHeight),
    height: px(group.getBoundingClientRect().height),
    borderTop: px(cs.borderTopWidth),
    borderBottom: px(cs.borderBottomWidth),
    flow,
    hasArrowLine: /↳/.test(flow),
  };
}

async function main(pw, startPanel) {
  const work = mkdtempSync(path.join(os.tmpdir(), "wtgui-call-rows-"));
  const roots = [path.join(work, "rootA")];
  let sandbox = null;
  let gw = null;
  let browser = null;
  const out = { tree: TREE, checks: results, before: null, afterOpen: null, tallied: null, back: null, errors: [] };
  try {
    mkdirSync(path.join(roots[0], "proj", "docs"), { recursive: true });
    const repo = path.join(roots[0], "proj");
    git(["init", "-q", "-b", "main"], repo);
    writeFileSync(path.join(repo, "docs", "a.md"), "# Title\n\nbody line\n");
    writeFileSync(path.join(repo, "public-app.js"), "old\n");
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
    const thread = "call-rows";
    const spawned = await fetch(`${sandbox.base}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "probe: one line per tool call", cwd: repo, existing: true, thread }),
    }).then((x) => x.json());
    if (!spawned || !spawned.job) throw new Error(`spawn failed: ${JSON.stringify(spawned).slice(0, 300)}`);
    const jobId = spawned.job.id;

    browser = await pw.chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => out.errors.push(String((e && e.message) || e).slice(0, 200)));
    await page.route("**/api/thinking**", (route) => route.fulfill({ json: { blocks: [] } }));
    await page.goto(sandbox.base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.jobs, null, { timeout: 30_000 });
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

    // The burst has played when the console holds one group with three rows in it.
    const gotBurst = await page
      .waitForFunction(
        (id) => {
          const out = [...document.querySelectorAll("pre.job-out")].find((o) => o.dataset.out === id);
          const group = out && out.querySelector(":scope > .tgrp");
          return Boolean(group && group.querySelectorAll(".tgrp-call > .tgrp-row").length >= 3);
        },
        jobId,
        { timeout: 60_000 },
      )
      .then(() => true)
      .catch(() => false);
    if (!gotBurst) {
      log("NOT MEASURED  the burst never drew three rows in one group");
      return 2;
    }
    await sleep(400);

    // (1) + (2) + (4): the shipped shape.
    const before = await page.evaluate(readGroup, jobId);
    out.before = before;
    mkdirSync(SHOTS, { recursive: true });
    await page.locator(`.job[data-thread="${thread}"]`).screenshot({ path: path.join(SHOTS, "1-rows-at-rest.png") });
    check("the setting ships off: the group is the flat run of rows", before && before.flat === true && before.calls === 3, before ? `flat=${before.flat}, calls=${before.calls}` : "no group");
    check("three calls are three rows", Boolean(before && before.rows.length === 3), before ? `${before.rows.length} row(s)` : "no rows");
    check(
      "no head row, no tally and no 'all N' button",
      Boolean(before && before.headRows.length === 0 && before.tallyRows === 0 && before.more === null && before.callBlocks === 0),
      before ? `heads=${before.headRows.length}, tallies=${before.tallyRows}, more=${JSON.stringify(before.more)}, call blocks=${before.callBlocks}` : "no group",
    );
    check("no '↳ tool' result line in the flow", Boolean(before && !before.hasArrowLine), before ? before.rows.map((r) => r.text).join(" | ") : "no group");
    check(
      "every row names its tool and its target",
      Boolean(before && before.rows.every((r) => r.name && r.target)),
      before ? before.rows.map((r) => `${r.glyph}${r.name} ${r.target}`).join(" | ") : "no group",
    );
    check(
      "each row is ONE line tall, and the group is three lines plus its rules",
      Boolean(
        before &&
          before.rows.every((r) => r.height <= before.lineHeight * 1.6) &&
          before.height <= before.lineHeight * 3 + 34 &&
          before.borderTop >= 1 &&
          before.borderBottom >= 1,
      ),
      before
        ? `line-height ${before.lineHeight}px; rows ${before.rows.map((r) => `${r.height}px`).join(", ")}; group ${before.height}px; rules ${before.borderTop}/${before.borderBottom}px`
        : "no group",
    );
    check("every row's box starts shut", Boolean(before && before.rows.every((r) => r.boxShut === true)), before ? before.rows.map((r) => r.boxShut).join(", ") : "no group");

    // (3) one row opens its own box, in place, with that call's output in it.
    const rowSel = `.job[data-thread="${thread}"] pre.job-out[data-out="${jobId}"] .tgrp-call > .tgrp-row`;
    await page.locator(rowSel).nth(0).click();
    await sleep(500);
    const afterOpen = await page.evaluate((id) => {
      const out = [...document.querySelectorAll("pre.job-out")].find((o) => o.dataset.out === id);
      const group = out && out.querySelector(":scope > .tgrp");
      if (!group) return null;
      const rows = [...group.querySelectorAll(".tgrp-call > .tgrp-row")];
      const block = rows[0] && rows[0].closest(".tgrp-call");
      const box = block && block.querySelector(":scope > .tgrp-out");
      return {
        open: box ? !box.hidden : null,
        expanded: rows[0] ? rows[0].getAttribute("aria-expanded") : null,
        text: box ? (box.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160) : "",
        otherBoxesShut: rows.slice(1).every((r) => {
          const b = r.closest(".tgrp-call");
          const el = b && b.querySelector(":scope > .tgrp-out");
          return el ? el.hidden : true;
        }),
        rows: rows.length,
      };
    }, jobId);
    out.afterOpen = afterOpen;
    await page.locator(`.job[data-thread="${thread}"]`).screenshot({ path: path.join(SHOTS, "2-first-row-open.png") });
    check("pressing a row opens the box behind it", Boolean(afterOpen && afterOpen.open === true && afterOpen.expanded === "true"), afterOpen ? `open=${afterOpen.open}, aria-expanded=${afterOpen.expanded}` : "no group");
    check(
      "the box holds that call's own output, and the other rows stay shut",
      Boolean(afterOpen && /git status --short|M public\/app\.js/.test(afterOpen.text) && afterOpen.otherBoxesShut && afterOpen.rows === 3),
      afterOpen ? `“${afterOpen.text}”, other boxes shut=${afterOpen.otherBoxesShut}` : "no group",
    );

    // (5) the Settings switch, pressed as the reader presses it: the card redraws into the tallied group in place.
    const toggle = (want) =>
      page.evaluate((on) => {
        const box = document.getElementById("group-tools");
        if (!box) return false;
        box.checked = on;
        box.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }, want);
    const hasSwitch = await page.evaluate(() => Boolean(document.getElementById("group-tools")));
    check("the Settings row exists (Settings > Agent cards)", hasSwitch, hasSwitch ? "#group-tools" : "no #group-tools in the page");
    if (hasSwitch) {
      await toggle(true);
      const tallied = await page
        .waitForFunction(
          (id) => {
            const out = [...document.querySelectorAll("pre.job-out")].find((o) => o.dataset.out === id);
            const group = out && out.querySelector(":scope > .tgrp");
            return Boolean(group && group.querySelector(":scope > .tgrp-head") && group.querySelector("[data-tgrp-more]"));
          },
          jobId,
          { timeout: 15_000 },
        )
        .then(() => true)
        .catch(() => false);
      const talliedNow = await page.evaluate(readGroup, jobId);
      out.tallied = talliedNow;
      await page.locator(`.job[data-thread="${thread}"]`).screenshot({ path: path.join(SHOTS, "3-switched-on-the-tallied-group.png") });
      check(
        "switched on, the same card is the tallied group again",
        Boolean(tallied && talliedNow && talliedNow.flat === false && talliedNow.headRows.length >= 1 && talliedNow.more && /^(all \d+|\d+ lines?)$/.test(talliedNow.more)),
        talliedNow ? `head=${JSON.stringify(talliedNow.headRows)} more=${JSON.stringify(talliedNow.more)}` : "no group",
      );
      check(
        "the tally counts the three calls it holds",
        Boolean(talliedNow && talliedNow.headRows.some((t) => /×1/.test(t)) && /^(all \d+|\d+ lines?)$/.test(String(talliedNow.more))),
        talliedNow ? talliedNow.headRows.join(" | ") : "no group",
      );
      check(
        "the tallied body repeats the calls as blocks, where the flat shape drew rows",
        Boolean(talliedNow && talliedNow.callBlocks === 3 && talliedNow.rows.length === 0),
        talliedNow ? `call blocks=${talliedNow.callBlocks}, rows=${talliedNow.rows.length}` : "no group",
      );
      await toggle(false);
      const back = await page
        .waitForFunction(
          (id) => {
            const out = [...document.querySelectorAll("pre.job-out")].find((o) => o.dataset.out === id);
            const group = out && out.querySelector(":scope > .tgrp");
            return Boolean(group && !group.querySelector(":scope > .tgrp-head") && group.querySelectorAll(".tgrp-call > .tgrp-row").length >= 3);
          },
          jobId,
          { timeout: 15_000 },
        )
        .then(() => true)
        .catch(() => false);
      const backNow = await page.evaluate(readGroup, jobId);
      out.back = backNow;
      await page.locator(`.job[data-thread="${thread}"]`).screenshot({ path: path.join(SHOTS, "4-switched-off-again.png") });
      check(
        "switched back off, the rows return without a reload",
        Boolean(back && backNow && backNow.flat === true && backNow.rows.length === 3 && backNow.headRows.length === 0),
        backNow ? `rows=${backNow.rows.length}, heads=${backNow.headRows.length}` : "no group",
      );
    }

    for (const e of out.errors) log(`page error: ${e}`);
    check("the page raised no error", out.errors.length === 0, out.errors.slice(0, 2).join(" | "));
    const failed = results.filter((x) => !x.ok).length;
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(path.join(SHOTS, `tool-call-rows-${Date.now()}.json`), JSON.stringify(out, null, 1));
    log(`shots: ${SHOTS}`);
    log(`\n${failed ? `${failed} failed` : "all checks held"}`);
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
  console.log(notRun("tools/verify-tool-call-rows.mjs", "Playwright is not installed here (set PANEL_PLAYWRIGHT_ROOT to a directory that has node_modules/playwright)"));
  process.exit(2);
}
const { startPanel } = await import(pathToFileURL(path.join(TREE, "tools", "panel-testkit.mjs")).href);
mkdirSync(SHOTS, { recursive: true });
process.exit(await main(pw, startPanel));
