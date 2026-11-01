// Does Settings → Agent cards → **Combined output** decide a NEW card's console — and does a card's own 🌊 still win?
//
//   node tools/verify-stream-default.mjs                      # this checkout, one panel, five phases
//   node tools/verify-stream-default.mjs --root <dir>         # serve a `git archive` of another build
//   node tools/verify-stream-default.mjs --out <dir>          # where results.json + the shots go
//   node tools/verify-stream-default.mjs --seconds 30         # how long each console is watched (default 20)
//
// THE CLAIM. The 🌊 was a per-card choice with no default: a card that never pressed it was the separate thinking
// block over its console and the condensed tool bursts. It now has a default beside Show thinking, read at card BUILD
// the way 🧠's default is, and the per-card button still overrides it:
//
//   (1) default off (nothing stored) — a new run's card comes up condensed: no `jl-sep` pieces, and the reasoning is
//       the separate `details.think` block above the console rather than rows inside it;
//   (2) the switch repaints a card that never chose, with no reload and no press on that card;
//   (3) default on — a new run's card comes up as ONE stream: every piece but the first carries `jl-sep`, and the
//       reasoning is `.jl-think` rows inside `pre.job-out`, with no separate block;
//   (4) a 🌊 press on a card following an ON default turns the stream OFF, is saved under that card's own key, survives
//       a reload (the per-card key is what build reads), and leaves the switch checked;
//   (5) the other direction: a 🌊 press on a card following an OFF default turns the stream ON, and a reload keeps it
//       while the switch stays clear.
//   Both phases are re-read a few seconds later, so a 3 s store sweep that repainted the old shape cannot pass.
//
// WHAT IS DRIVEN. A panel of its own on a spare port, from the checkout under test (tools/panel-testkit.mjs: own
// PANEL_CONFIG / HERMES_HOME / jobs.json, API_SERVER_KEY empty), with a stub Runs API playing prose, tool calls, their
// results and reasoning over real SSE. Cards are spawned through the panel's own POST /api/agents (`existing: true`)
// into a fixture repo, so every console is a real run drawn by the page's own painters. The settings row is pressed
// through #btn-settings and the group head, exactly as a reader opens it. No reader's panel, port or store is touched.
//
// Exit codes: 0 every assertion held; 1 one failed (or the page erred); 2 the run did not measure what it claims (no
// Playwright, no console, no tool group on a card, no reasoning rows to tell the two consoles apart).
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright, notRun, openSettingsGroup } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const OUT = opt("--out", path.join(os.tmpdir(), "wag", "stream-default"));
const SECONDS = Number(opt("--seconds", "20"));
const log = (...a) => console.log(...a);

// ---- the stub Runs API ----------------------------------------------------------------------------------------------
// One event every 300 ms, cycling prose -> call -> result -> prose -> call -> result -> reasoning. A paragraph is a
// delta that BEGINS with a blank line, because lib/jobs.js grows one open paragraph in place until a fragment starts
// a new one: that is how the console gets distinct text lines without a tool call between them.
function nextEvent(rec) {
  const n = rec.cycle;
  switch (rec.step++ % 8) {
    case 0:
      return { event: "message.delta", delta: `\n\nRound ${n}: the file is small, so one read answers it.` };
    case 1:
      return { event: "tool.started", tool: "terminal", preview: "wc -l docs/a.md" };
    case 2:
      return { event: "tool.completed", tool: "terminal", preview: `  ${42 + (n % 7)} docs/a.md`, duration: 0.31 };
    case 3:
      return { event: "message.delta", delta: `\n\nIt is ${42 + (n % 7)} lines; the heading is what matters.` };
    case 4:
      return { event: "tool.started", tool: "read_file", preview: "docs/a.md" };
    case 5:
      return { event: "tool.completed", tool: "read_file", preview: "# Title\n\nbody line\n", duration: 0.22 };
    case 6:
      rec.cycle = n + 1;
      return { event: "message.delta", delta: `\n\nThat is the whole answer for round ${n}.` };
    default:
      return { event: "reasoning.available", text: `round ${n}: the heading, not the body, is the point` };
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
        version: "stream-default-stub",
        features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true },
      });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      req.resume();
      req.on("end", () => {
        posts += 1;
        const id = `run_dflt_${posts}`;
        runs.set(id, { id, step: 0, cycle: 1, timer: null });
        json(200, { run_id: id, status: "running" });
      });
      return;
    }
    const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const rec = runs.get(one[1]);
      if (!rec) return json(404, { error: { message: "Run not found", code: "run_not_found" } });
      return json(200, { run_id: rec.id, status: "running", output: "", usage: { total_tokens: 4000, input_tokens: 3600, output_tokens: 400 } });
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

// ---- helpers --------------------------------------------------------------------------------------------------------
const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const git = (args, cwd) =>
  execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@localhost", ...args], { cwd, stdio: "pipe", encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  return Boolean(ok);
};

// What the card's console IS, as the page drew it. The two consoles differ in two structural facts and nothing that
// depends on a setting of its own: where reasoning is drawn (`details.think` above, or `.jl-think` rows inside), and
// whether the console's pieces are set apart by `jl-sep` (the one-stream painter marks every piece but the first).
const readShape = (page, thread) =>
  page.evaluate((t) => {
    const card = document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
    if (!card) return { found: false };
    const out = card.querySelector("pre.job-out");
    const btn = card.querySelector("[data-stream-thread]");
    const kids = out ? [...out.children] : [];
    const groups = out ? [...out.querySelectorAll(":scope > .tgrp")] : [];
    return {
      found: Boolean(out),
      pieces: kids.length,
      seps: kids.filter((n) => n.classList.contains("jl-sep")).length,
      groups: groups.length,
      flat: groups.filter((g) => g.classList.contains("tgrp-flat") || g.dataset.gflat === "1").length,
      tallied: out ? out.querySelectorAll(".tgrp-n").length : 0,
      calls: out ? out.querySelectorAll(".tgrp-call").length : 0,
      thinkRows: out ? out.querySelectorAll(".jl-think").length : 0,
      thinkBlock: Boolean(card.querySelector("details.think")),
      pressed: btn ? btn.getAttribute("aria-pressed") : null,
      on: btn ? btn.classList.contains("is-on") : null,
      text: out ? out.textContent.replace(/\s+/g, " ").slice(0, 140) : "",
    };
  }, thread);

const isStream = (s) => s.found && s.pieces >= 2 && s.seps === s.pieces - 1 && !s.thinkBlock;
// A condensed console has to have DRAWN something: one piece and no burst would pass the two structural facts for the
// wrong reason (it is the "waiting for output…" placeholder at that point).
const isCondensed = (s) => s.found && s.pieces >= 2 && s.seps === 0 && s.thinkBlock && s.groups >= 1;
const why = (s) =>
  s.found
    ? `pieces ${s.pieces}, sep ${s.seps}, think rows ${s.thinkRows}, think block ${s.thinkBlock}, groups ${s.groups}, tallied ${s.tallied}, aria-pressed ${s.pressed}`
    : "no console";

// Poll until the card's console has the shape the phase expects — a build/repaint is not instantaneous, and settling
// on the wrong shape only after the timeout is a real failure.
async function waitShape(page, thread, want, { timeout = 20_000, what = "shape" } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    last = await readShape(page, thread);
    if (want(last)) return last;
    await sleep(250);
  }
  return last;
}

// ---- the run --------------------------------------------------------------------------------------------------------
async function main(pw, startPanel) {
  const work = mkdtempSync(path.join(os.tmpdir(), "wtgui-dflt-"));
  const roots = [path.join(work, "rootA")];
  let sandbox = null;
  let gw = null;
  let browser = null;
  const out = { tree: TREE, seconds: SECONDS, checks: results, phases: {}, errors: [] };
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

    // The card's thread is the panel's own; a spawn names it, so the per-card keys can be written before the card is
    // painted (which is what "the card was BUILT with this answer" means).
    const spawn = async (thread) => {
      const r = await fetch(`${sandbox.base}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: `probe: the Combined output default, ${thread}`, cwd: repo, existing: true, thread }),
      }).then((x) => x.json());
      if (!r || !r.job) throw new Error(`spawn failed: ${JSON.stringify(r).slice(0, 300)}`);
      return r.job.id;
    };

    browser = await pw.chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => out.errors.push(String((e && e.message) || e).slice(0, 200)));
    // The sandbox has no session store: the reasoning the two consoles draw differently comes from this one route.
    await page.route("**/api/thinking**", (route) => {
      const now = Date.now();
      return route.fulfill({
        json: {
          blocks: [
            { at: now - 30_000, text: "First, what the request actually asks for." },
            { at: now - 12_000, text: "The file is small; the heading is the part worth checking." },
            { at: now - 1_200, text: "One read is enough, then I can answer." },
          ],
        },
      });
    });
    await page.goto(sandbox.base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.jobs, null, { timeout: 30_000 });

    // The card lives under the fixture repo's row: expand the project and the row with the panel's own state, the way
    // a reader opens it (the ▶ probe starts an agent). Called before a spawn it just opens the row the card will land
    // in; called after one it repaints to pick the card up.
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

    const openSettings = async () => {
      await openSettingsGroup(page, "cards");
      await page.waitForSelector("#stream-default", { state: "visible", timeout: 10_000 });
    };
    // The drawer covers the board: pressing a card's own button needs it away first, the way a reader would.
    const closeSettings = async () => {
      const open = await page.evaluate(() => {
        const panel = document.getElementById("settings");
        return Boolean(panel) && !panel.classList.contains("hidden");
      });
      if (open) await page.click("#btn-settings");
      await page.waitForFunction(() => document.getElementById("settings")?.classList.contains("hidden"), null, { timeout: 10_000 });
    };
    const switchOn = () => page.evaluate(() => localStorage.getItem("wtgui.stream"));
    const box = () => page.evaluate(() => Boolean(document.querySelector("#stream-default")?.checked));
    const pressWave = async (thread) => {
      await closeSettings();
      await page.click(`.job[data-thread="${thread}"] [data-stream-thread]`);
    };

    await reveal();

    // ---- phase 1: the default is off, and a new run comes up condensed -------------------------------------------------
    check("the Combined output row is in the page, beside Show thinking", await page.evaluate(() => {
      const row = document.querySelector("#settings label[for=stream-default]");
      const think = document.querySelector("#settings label[for=show-thinking]");
      return Boolean(row && think && row.previousElementSibling === think && row.textContent.includes("Combined output"));
    }));
    await openSettings();
    check("the switch starts clear when nothing is stored", (await switchOn()) === null && (await box()) === false, `stored ${JSON.stringify(await switchOn())}, box ${await box()}`);

    const offThread = "dflt-off";
    await page.evaluate((t) => localStorage.setItem(`wtgui.think.${t}`, "1"), offThread);
    await spawn(offThread);
    await reveal();
    await page.waitForSelector(`.job[data-thread="${offThread}"] pre.job-out`, { timeout: 60_000 });
    let s = await waitShape(page, offThread, isCondensed);
    out.phases.off = s;
    check("a new run under the off default is the condensed console: separate thinking block, no separated pieces", isCondensed(s), why(s));
    check("…and its 🌊 reads off", s.found && s.pressed === "false" && s.on === false, `aria-pressed ${s.pressed}`);

    // ---- phase 2: the switch repaints a card that never chose ----------------------------------------------------------
    await openSettings();
    await page.click("#stream-default");
    check("pressing the switch saves the global default", (await switchOn()) === "1" && (await box()) === true);
    s = await waitShape(page, offThread, isStream, { timeout: 15_000 });
    out.phases.repainted = s;
    check("the card that never chose follows it, with no reload and no press on the card", isStream(s), why(s));

    // ---- phase 3: a new run under the ON default is one stream ---------------------------------------------------------
    const onThread = "dflt-on";
    await page.evaluate((t) => localStorage.setItem(`wtgui.think.${t}`, "1"), onThread);
    check("the new session has no answer of its own stored", await page.evaluate((t) => localStorage.getItem(`wtgui.stream.${t}`) === null, onThread));
    await spawn(onThread);
    await reveal();
    await page.waitForSelector(`.job[data-thread="${onThread}"] pre.job-out`, { timeout: 60_000 });
    s = await waitShape(page, onThread, (v) => isStream(v) && v.thinkRows > 0, { timeout: 25_000 });
    out.phases.on = s;
    check("a new run under the on default is ONE stream: reasoning rows inside the console, no separate block", isStream(s) && s.thinkRows > 0, why(s));
    check("…and its 🌊 reads on without a press", s.found && s.pressed === "true" && s.on === true, `aria-pressed ${s.pressed}`);
    const settled = await (async () => {
      await sleep(3000);
      return readShape(page, onThread);
    })();
    out.phases.onAfterSweep = settled;
    check("the stream survives the 3 s sweep that repaints consoles", isStream(settled), why(settled));

    // ---- phase 4: 🌊 pressed on a card following an ON default turns it off, and a reload keeps it ----------------------
    await pressWave(onThread);
    check("the press saves the CARD's own answer, not the default", (await page.evaluate((t) => localStorage.getItem(`wtgui.stream.${t}`), onThread)) === "0");
    check("…and the global default is untouched", (await switchOn()) === "1");
    s = await waitShape(page, onThread, isCondensed, { timeout: 15_000 });
    out.phases.overrideOff = s;
    check("the card goes back to the separate block and the condensed console", isCondensed(s), why(s));

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.jobs, null, { timeout: 30_000 });
    await reveal();
    await page.waitForSelector(`.job[data-thread="${onThread}"] pre.job-out`, { timeout: 60_000 });
    s = await waitShape(page, onThread, isCondensed, { timeout: 25_000 });
    out.phases.overrideOffAfterReload = s;
    check("a reload rebuilds the card with its own answer, not the default", isCondensed(s), why(s));
    check("…and the switch is still on, painted from the stored default", (await box()) === true && (await switchOn()) === "1");

    // ---- phase 5: 🌊 pressed on a card following an OFF default turns it on, and a reload keeps it ---------------------
    await openSettings();
    await page.click("#stream-default");
    check("pressing the switch off saves it", (await switchOn()) === "0" && (await box()) === false);
    s = await waitShape(page, offThread, isCondensed, { timeout: 15_000 });
    out.phases.backOff = s;
    check("the card that still never chose follows the switch back to condensed", isCondensed(s), why(s));

    await pressWave(offThread);
    check("the press saves that card's own answer", (await page.evaluate((t) => localStorage.getItem(`wtgui.stream.${t}`), offThread)) === "1");
    s = await waitShape(page, offThread, isStream, { timeout: 15_000 });
    out.phases.overrideOn = s;
    check("the card becomes ONE stream over an off default", isStream(s), why(s));

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.jobs, null, { timeout: 30_000 });
    await reveal();
    await page.waitForSelector(`.job[data-thread="${offThread}"] pre.job-out`, { timeout: 60_000 });
    s = await waitShape(page, offThread, isStream, { timeout: 25_000 });
    out.phases.overrideOnAfterReload = s;
    check("a reload keeps that card a stream while the default stays off", isStream(s) && (await switchOn()) === "0", why(s));

    await page.screenshot({ path: path.join(OUT, "after-two-overrides.png"), fullPage: false }).catch(() => {});
    if (out.errors.length) check("the page threw nothing", false, out.errors.join(" | "));
    else check("the page threw nothing", true);
  } catch (e) {
    check(`the run completed: ${String((e && e.message) || e).slice(0, 200)}`, false);
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
    try {
      await gw?.close();
    } catch {
      /* ignore */
    }
    try {
      await sandbox?.stop?.();
    } catch {
      /* ignore */
    }
    writeFileSync(path.join(OUT, "results.json"), JSON.stringify(out, null, 2));
    log(`→ ${path.join(OUT, "results.json")}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  log(`\n${results.length - failed}/${results.length} checks held${failed ? `, ${failed} failed` : ""}`);
  if (!results.length) return 2;
  return failed ? 1 : 0;
}

// ---- main -----------------------------------------------------------------------------------------------------------
const pw = loadPlaywright({ root: TREE });
if (!pw) {
  log(notRun("tools/verify-stream-default.mjs", "Playwright is not installed here (set PANEL_PLAYWRIGHT_ROOT to a directory that has node_modules/playwright)"));
  process.exit(2);
}
const { startPanel } = await import(pathToFileURL(path.join(TREE, "tools", "panel-testkit.mjs")).href);
mkdirSync(OUT, { recursive: true });
const code = await main(pw, startPanel);
// A run where nothing reached the page has not measured its claim, whatever the checks say.
if (code === 0 && !results.length) {
  log("NOT MEASURED  no check ran");
  process.exit(2);
}
process.exit(code);
