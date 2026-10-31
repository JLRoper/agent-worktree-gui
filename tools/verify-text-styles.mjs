// Do the three text styles reach the console, and does the empty line stand where it should? Read off a real page.
//
//   node tools/verify-text-styles.mjs                  # 🌊 one-stream console, then the 🧠 block, headless (~40 s)
//   node tools/verify-text-styles.mjs --mode stream    # the 🌊 console only
//   node tools/verify-text-styles.mjs --mode think     # the 🧠 block above a condensed console only
//   node tools/verify-text-styles.mjs --headed         # watch it
//   node tools/verify-text-styles.mjs --keep           # leave the sandbox behind for inspection
//
// WHAT THIS ANSWERS
//   Settings > Display carries a colour and a size for three kinds of console text — the agent's reasoning, what a
//   skill prints, and the rest of the console — and every reasoning section stands an empty line below whatever came
//   before it. The unit test (test/text-styles.test.js) proves the setting writes the right variables; this proves
//   the stylesheet reads them where the reader is looking:
//
//     1. UNSET, the console is the console it always was: reasoning lavender (🌊) or dim (🧠), a skill's rows the
//        console's tool-output grey, prose #e6e9ef, every size the console's own;
//     2. SET through the real controls (the colour picker, the size select), each of the three changes its own text and
//        nothing else — reasoning and skill output keep their own size while the console's moves, a diff row inside a
//        skill box keeps its green;
//     3. an empty line stands above every reasoning section but the first line of a console, measured as the gap
//        between the row above and the reasoning (not just the margin that was asked for);
//     4. the choice survives a reload, and "use defaults" removes the property and the stored key.
//
// WHAT IT DRIVES
//   a sandbox panel of its own (tools/panel-testkit.mjs) and a stub Runs API that plays a fixed script over real SSE:
//   two replies that think, a skill's result, prose, a terminal call. Pacing is off (words/s 0) so the text is whole
//   the moment it arrives and the styles are read off settled rows.
//
// EXIT CODES
//   0  every check held (or Playwright is not installed: SKIP)   1  a check failed   2  the run did not drive what it measures
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { startPanel } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const MODE = opt("--mode", "both");
const HEADED = argv.includes("--headed");
const KEEP = argv.includes("--keep");
if (!["stream", "think", "both"].includes(MODE)) {
  console.log(`--mode must be stream, think or both, not ${MODE}`);
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const THREAD = "probe-text-styles";

// ---- the turn ------------------------------------------------------------------------------------------------
const SKILL_RESULT = "# pdf — create, read and merge PDF files\nUse this skill when a task names a .pdf file.\n--- a/skill.md\n+++ b/skill.md\n@@ -1,2 +1,2 @@\n-old line\n+new line\n context";
const STEPS = [
  { at: 300, think: "First thought: the task names a PDF, so I should load the pdf skill before touching the file.", tool: "skill_view", preview: "pdf", result: SKILL_RESULT },
  { at: 1700, text: "Loaded the skill, now listing the folder." },
  { at: 2600, think: "Second thought: list the folder, then decide which file to open.", tool: "terminal", preview: "ls", result: "a.pdf\nb.pdf" },
  { at: 3800, text: "Both files are there." },
];
const END_AT = 4600;

function seedStore(dir) {
  mkdirSync(path.join(dir, "hermes"), { recursive: true });
  const db = new DatabaseSync(path.join(dir, "hermes", "state.db"));
  db.exec(`
    create table if not exists sessions (id text primary key, source text not null, started_at real not null,
      model text, cwd text, title text, message_count integer default 0);
    create table if not exists messages (id integer primary key autoincrement, session_id text not null, role text not null,
      content text, timestamp real not null, reasoning text, reasoning_content text, tool_name text, tool_call_id text,
      token_count integer, finish_reason text);
  `);
  db.prepare("insert or replace into sessions (id, source, started_at, model, cwd, title) values (?,?,?,?,?,?)").run(THREAD, "probe", Date.now() / 1000, "probe/model", ROOT, "text styles probe");
  db.close();
}

function makeGateway(dir) {
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
      return json(200, { version: "text-styles-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true } });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        state.posts += 1;
        const id = `run_ts_${state.posts}`;
        state.runs.set(id, { id, status: "running", output: "", startedAt: null });
        json(200, { run_id: id, status: "running" });
      });
      return;
    }
    const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const rec = state.runs.get(one[1]);
      if (!rec) return json(404, { error: { message: "Run not found", code: "run_not_found" } });
      return json(200, { run_id: rec.id, status: rec.status, output: rec.output, usage: { total_tokens: 900, input_tokens: 800, output_tokens: 100 } });
    }
    const ev = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (ev && req.method === "GET") {
      const rec = state.runs.get(ev[1]);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      if (!rec) return res.end();
      res.write(": open\n\n");
      if (rec.startedAt != null) return;
      rec.startedAt = Date.now();
      let open = true;
      req.on("close", () => {
        open = false;
      });
      let seq = 0;
      const send = (evt) => {
        if (!open) return;
        res.write(`id: ${seq}\ndata: ${JSON.stringify({ ...evt, run_id: rec.id, seq, timestamp: Date.now() / 1000 })}\n\n`);
        seq += 1;
      };
      for (const s of STEPS) {
        later(s.at, () => {
          if (s.think) {
            const db = new DatabaseSync(path.join(dir, "hermes", "state.db"));
            db.prepare("insert into messages (session_id, role, content, timestamp, reasoning_content) values (?,?,?,?,?)").run(THREAD, "assistant", "…", Date.now() / 1000, s.think);
            db.close();
          }
          if (s.text) send({ event: "message.delta", delta: `\n\n${s.text}` });
          if (s.tool) {
            later(60, () => {
              send({ event: "tool.started", tool: s.tool, preview: s.preview });
              later(300, () => send({ event: "tool.completed", tool: s.tool, duration: 0.3, error: false, preview: s.result }));
            });
          }
        });
      }
      later(END_AT, () => {
        rec.status = "completed";
        rec.output = "done";
        send({ event: "run.completed", output: "done", usage: { total_tokens: 900, input_tokens: 800, output_tokens: 100 } });
        later(50, () => res.end());
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

function loadPlaywright() {
  for (const root of [process.env.PANEL_PLAYWRIGHT_ROOT, process.env.PLAYWRIGHT_ROOT, ROOT, process.cwd(), "C:/Users/roper/AppData/Roaming/npm/node_modules"].filter(Boolean)) {
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

function git(args, cwd) {
  return execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@localhost", ...args], { cwd, stdio: "pipe", encoding: "utf8" });
}

// ---- reading the page ----------------------------------------------------------------------------------------
// Everything is read in one evaluate so the console cannot move between two measurements.
function readStyles(thread) {
  const px = (v) => Math.round(parseFloat(v) * 100) / 100;
  const rgb = (v) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v) || [];
    return m.length ? `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}` : v;
  };
  const card = document.querySelector(`.job[data-thread="${thread}"]`);
  const con = card?.querySelector("pre.job-out");
  if (!con) return { ok: false };
  const style = (el) => (el ? getComputedStyle(el) : null);
  const of = (el) => {
    const s = style(el);
    return s ? { color: rgb(s.color), size: px(s.fontSize), marginTop: px(s.marginTop), lineHeight: px(s.lineHeight) } : null;
  };
  const think = [...card.querySelectorAll('pre.job-out [data-lid^="think:"], .think-body [data-lid^="think:"]')];
  const skillRows = [...card.querySelectorAll(".code-box.is-skill > .code-body > .jl")];
  const skillBox = card.querySelector(".code-box.is-skill");
  const otherBox = [...card.querySelectorAll(".code-box")].find((b) => !b.classList.contains("is-skill"));
  const addRow = card.querySelector(".code-box.is-skill .df-c.is-add");
  const prose = [...con.querySelectorAll(".jl-text")];
  const termOut = otherBox ? [...otherBox.querySelectorAll(":scope > .code-body > .jl-tool-out, :scope > .code-body > .jl")] : [];
  // The gap above each reasoning row: how far its top is below the bottom of the row above it, in px.
  const gaps = think.map((el) => {
    const prev = el.previousElementSibling;
    const r = el.getBoundingClientRect();
    return prev ? Math.round((r.top - prev.getBoundingClientRect().bottom) * 100) / 100 : null;
  });
  const block = card.querySelector("details.think");
  return {
    ok: true,
    console: { size: px(style(con).fontSize), weight: style(con).fontWeight },
    think: think.map(of),
    thinkGaps: gaps,
    thinkIsFirstChild: think.map((el) => el === el.parentElement.firstElementChild),
    thinkInConsole: think.map((el) => Boolean(el.closest("pre.job-out"))),
    blockMarginTop: block ? px(style(block).marginTop) : null,
    skillRows: skillRows.map(of),
    skillBoxCount: card.querySelectorAll(".code-box.is-skill").length,
    skillBodySize: skillBox ? px(style(skillBox.querySelector(":scope > .code-body")).fontSize) : null,
    addRowColor: addRow ? rgb(style(addRow).color) : null,
    otherBoxIsSkill: otherBox ? otherBox.classList.contains("is-skill") : null,
    termRows: termOut.map(of),
    prose: prose.map(of),
    rootVars: Object.fromEntries(["--think-color", "--think-font-size", "--skill-color", "--skill-font-size", "--con-color", "--term-size"].map((k) => [k, document.documentElement.style.getPropertyValue(k) || null])),
    stored: Object.fromEntries(["wtgui.thinkColor", "wtgui.thinkSize", "wtgui.skillColor", "wtgui.skillSize", "wtgui.consoleColor", "wtgui.termSize"].map((k) => [k, localStorage.getItem(k)])),
  };
}

async function openDisplay(page) {
  const open = await page.evaluate(() => !document.getElementById("settings")?.classList.contains("hidden") && getComputedStyle(document.getElementById("settings")).display !== "none");
  if (!open) await page.click("#btn-settings");
  await page.waitForSelector("#think-color", { state: "attached" });
  const folded = await page.evaluate(() => document.querySelector('[data-settings-group="display"]').getAttribute("aria-expanded") === "false");
  if (folded) await page.click('[data-settings-group="display"]');
  await page.waitForSelector("#think-color", { state: "visible" });
}

async function runMode(ctx, work, mode) {
  const dir = path.join(work, mode);
  const repo = path.join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  mkdirSync(path.join(dir, "empty-root"), { recursive: true });
  git(["init", "-q", "-b", "main"], repo);
  writeFileSync(path.join(repo, "README.md"), "# probe repo\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "first"], repo);
  seedStore(dir);
  const gw = makeGateway(dir);
  const gwPort = await gw.listen();
  const sandbox = await startPanel({
    dir,
    keep: KEEP,
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
  // Beside the sandbox, not in it: stop() removes the sandbox, and a screenshot is only worth having if it outlives it.
  const shotDir = path.join(work, "shots");
  mkdirSync(shotDir, { recursive: true });
  const out = { mode, shots: [] };
  try {
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String((e && e.message) || e)));
    await page.addInitScript(({ thread, mode: m }) => {
      // Only on the first load: a reload must show what the reader chose, not a script putting the page back.
      if (sessionStorage.getItem("__init")) return;
      sessionStorage.setItem("__init", "1");
      localStorage.setItem("wtgui.autoCollect", "0");
      localStorage.setItem("wtgui.think", "1");
      localStorage.setItem(`wtgui.think.${thread}`, "1");
      localStorage.setItem("wtgui.streamWords", "0");
      localStorage.setItem("wtgui.streamLines", "0");
      if (m === "stream") localStorage.setItem(`wtgui.stream.${thread}`, "1");
    }, { thread: THREAD, mode });
    await page.goto(sandbox.base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.jobs, null, { timeout: 30000 });
    const spawned = await fetch(`${sandbox.base}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "probe: think, load a skill, call a tool", cwd: repo, existing: true, thread: THREAD }),
    }).then((r) => r.json());
    if (!spawned || !spawned.job) throw new Error(`spawn failed: ${JSON.stringify(spawned)}`);
    await page.waitForSelector(`.job[data-thread="${THREAD}"] pre.job-out`, { timeout: 20000 });
    await sleep(END_AT + 3500); // the turn is over and every row is whole
    // The skill's box is folded by default; open it so its rows are on screen for the screenshot (computed style is
    // read either way).
    await page.evaluate((th) => document.querySelector(`.job[data-thread="${th}"] .code-box.is-skill .code-head`)?.click(), THREAD);
    await page.evaluate((th) => document.querySelector(`.job[data-thread="${th}"]`)?.scrollIntoView({ block: "center" }), THREAD);
    out.before = await page.evaluate(readStyles, THREAD);
    out.shots.push(path.join(shotDir, `${mode}-1-defaults.png`));
    await page.screenshot({ path: out.shots.at(-1) });

    // ---- set all three through the real controls -----------------------------------------------------------
    await openDisplay(page);
    await page.locator("#think-color").fill("#ff8800");
    await page.selectOption("#think-size-select", "15");
    await page.locator("#skill-color").fill("#33cc99");
    await page.selectOption("#skill-size-select", "14");
    await page.locator("#console-color").fill("#ffffff");
    await page.selectOption("#term-size-select", "13");
    out.panel = await page.evaluate(() => ({
      thinkState: document.getElementById("think-color-state").textContent,
      skillState: document.getElementById("skill-color-state").textContent,
      consoleState: document.getElementById("console-color-state").textContent,
      previews: ["think", "skill", "console"].map((k) => {
        const s = getComputedStyle(document.getElementById(`${k}-preview`));
        return { k, color: s.color, size: s.fontSize };
      }),
    }));
    await page.click("#btn-settings-close").catch(() => {});
    await sleep(200);
    out.after = await page.evaluate(readStyles, THREAD);
    await page.evaluate((th) => document.querySelector(`.job[data-thread="${th}"]`)?.scrollIntoView({ block: "center" }), THREAD);
    out.shots.push(path.join(shotDir, `${mode}-2-set.png`));
    await page.screenshot({ path: out.shots.at(-1) });

    // ---- a reload keeps them ---------------------------------------------------------------------------------
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.jobs, null, { timeout: 30000 });
    await page.waitForSelector(`.job[data-thread="${THREAD}"] pre.job-out`, { timeout: 20000 });
    await sleep(2500);
    out.reloaded = await page.evaluate(readStyles, THREAD);
    await openDisplay(page);
    out.reloadedControls = await page.evaluate(() => ({
      think: [document.getElementById("think-color").value, document.getElementById("think-size-select").value],
      skill: [document.getElementById("skill-color").value, document.getElementById("skill-size-select").value],
      console: [document.getElementById("console-color").value, document.getElementById("term-size-select").value],
    }));

    // ---- use defaults ----------------------------------------------------------------------------------------
    for (const kind of ["think", "skill", "console"]) await page.click(`[data-text-reset="${kind}"]`);
    await page.click("#btn-settings-close").catch(() => {});
    await sleep(200);
    out.reset = await page.evaluate(readStyles, THREAD);
    out.errors = errors;
    return out;
  } finally {
    await gw.close().catch(() => {});
    await sandbox.stop().catch(() => {});
  }
}

// ---- the verdicts --------------------------------------------------------------------------------------------
const near = (a, b, tol = 1.5) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= tol;
function judge(cap) {
  const checks = [];
  const add = (name, got, want, ok) => checks.push({ name, got, want, ok });
  const { before: b, after: a, reloaded: r, reset: z } = cap;
  const driven = [b, a, r, z].every((x) => x && x.ok) && b.think.length >= 2 && b.skillBoxCount >= 1 && b.prose.length >= 1;
  if (!driven) return { checks, driven: false };
  const stream = cap.mode === "stream";
  const thinkDefault = stream ? "#b3a8cc" : "#9aa4b2";

  // 1. unset: the look the console always had
  add("unset: reasoning keeps its own colour", b.think.map((t) => t.color), b.think.map(() => thinkDefault), b.think.every((t) => t.color === thinkDefault));
  add("unset: reasoning size is the console's (🌊) or 12px (🧠)", b.think.map((t) => t.size), stream ? b.console.size : 12, b.think.every((t) => t.size === (stream ? b.console.size : 12)));
  add("unset: a skill's rows are the console's tool-output grey", b.skillRows.map((t) => t.color), "#9aa4b2", b.skillRows.length > 0 && b.skillRows.every((t) => t.color === "#9aa4b2"));
  add("unset: prose keeps #e6e9ef", b.prose.map((t) => t.color), "#e6e9ef", b.prose.every((t) => t.color === "#e6e9ef"));
  add("unset: no variable is set on the root", b.rootVars, "only --term-size (the console's own)", ["--think-color", "--think-font-size", "--skill-color", "--skill-font-size", "--con-color"].every((k) => b.rootVars[k] === null));

  // 2. set: each its own, nothing else
  add("set: reasoning is the picked colour", a.think.map((t) => t.color), "#ff8800", a.think.every((t) => t.color === "#ff8800"));
  add("set: reasoning is the picked size", a.think.map((t) => t.size), 15, a.think.every((t) => t.size === 15));
  add("set: a skill's rows are the picked colour", a.skillRows.map((t) => t.color), "#33cc99", a.skillRows.length > 0 && a.skillRows.every((t) => t.color === "#33cc99"));
  add("set: a skill's box is the picked size", a.skillBodySize, 14, a.skillBodySize === 14);
  add("set: a diff row inside the skill box keeps its green", a.addRowColor, "#7ee787", a.addRowColor === "#7ee787");
  add("set: prose is the picked console colour", a.prose.map((t) => t.color), "#ffffff", a.prose.every((t) => t.color === "#ffffff"));
  add("set: the console is the picked size", a.console.size, 13, a.console.size === 13);
  add("set: prose follows the console's size", a.prose.map((t) => t.size), 13, a.prose.every((t) => t.size === 13));
  add("set: a terminal result's rows take the console colour, and are not a skill box", { rows: a.termRows.map((t) => t.color), skill: a.otherBoxIsSkill }, { rows: "#ffffff", skill: false }, a.termRows.length > 0 && a.termRows.every((t) => t.color === "#ffffff") && a.otherBoxIsSkill === false);
  add("set: the Settings previews are drawn from the same variables", cap.panel.previews, "think #ff8800/15px, skill #33cc99/14px, console #ffffff/13px", cap.panel.previews.every((p) => (p.k === "think" ? p.color === "rgb(255, 136, 0)" && p.size === "15px" : p.k === "skill" ? p.color === "rgb(51, 204, 153)" && p.size === "14px" : p.color === "rgb(255, 255, 255)" && p.size === "13px")));
  add("set: each row names the colour in force", [cap.panel.thinkState, cap.panel.skillState, cap.panel.consoleState], ["#ff8800", "#33cc99", "#ffffff"], cap.panel.thinkState === "#ff8800" && cap.panel.skillState === "#33cc99" && cap.panel.consoleState === "#ffffff");

  // 3. the empty line
  const lineH = (t) => t.size * 1.5;
  const above = a.think.map((t, i) => ({ t, gap: a.thinkGaps[i], first: a.thinkIsFirstChild[i], inConsole: a.thinkInConsole[i] }));
  if (stream) {
    const later = above.filter((x) => x.inConsole && !x.first);
    add("an empty line is asked for above every reasoning row of the 🌊 (margin-top 1.5 em)", later.map((x) => x.t.marginTop), "1.5 × the row's font size", later.length > 0 && later.every((x) => near(x.t.marginTop, x.t.size * 1.5, 0.6)));
    add("and the gap actually drawn is a whole empty line", later.map((x) => x.gap), `>= 0.95 × a line of the reasoning`, later.every((x) => x.gap >= lineH(x.t) * 0.95));
  } else {
    add("an empty line stands above the 🧠 block and between its blocks", { block: a.blockMarginTop, between: a.think.slice(1).map((t) => t.marginTop) }, "18px above the block, 1.5 em between blocks", near(a.blockMarginTop, 18, 0.6) && a.think.slice(1).every((t) => near(t.marginTop, t.size * 1.5, 0.6)));
  }
  add("the first line of a console has no empty line above it", above.filter((x) => x.first && x.inConsole).map((x) => x.t.marginTop), 0, above.filter((x) => x.first && x.inConsole).every((x) => x.t.marginTop === 0));

  // 4. persistence and defaults
  add("a reload keeps all three", { think: r.think.map((t) => [t.color, t.size]), skill: r.skillRows.map((t) => [t.color, t.size]), prose: r.prose.map((t) => t.color), console: r.console.size }, "#ff8800/15, #33cc99, #ffffff, 13", r.think.every((t) => t.color === "#ff8800" && t.size === 15) && r.skillRows.every((t) => t.color === "#33cc99") && r.prose.every((t) => t.color === "#ffffff") && r.console.size === 13);
  add("and the controls show what was chosen", cap.reloadedControls, "#ff8800/15, #33cc99/14, #ffffff/13", cap.reloadedControls.think.join() === "#ff8800,15" && cap.reloadedControls.skill.join() === "#33cc99,14" && cap.reloadedControls.console.join() === "#ffffff,13");
  add("use defaults: the colours and sizes are back", { think: z.think.map((t) => [t.color, t.size]), skill: z.skillRows.map((t) => t.color), prose: z.prose.map((t) => t.color), console: z.console.size }, `${thinkDefault}, #9aa4b2, #e6e9ef, 11.5px`, z.think.every((t) => t.color === thinkDefault && t.size === (stream ? 11.5 : 12)) && z.skillRows.every((t) => t.color === "#9aa4b2") && z.prose.every((t) => t.color === "#e6e9ef") && z.console.size === 11.5);
  add("use defaults: the variables are removed and the keys forgotten", { vars: z.rootVars, stored: z.stored }, "no --think/--skill/--con vars, no stored colour or size", ["--think-color", "--think-font-size", "--skill-color", "--skill-font-size", "--con-color"].every((k) => z.rootVars[k] === null) && ["wtgui.thinkColor", "wtgui.thinkSize", "wtgui.skillColor", "wtgui.skillSize", "wtgui.consoleColor"].every((k) => z.stored[k] === null) && (z.stored["wtgui.termSize"] === "11.5"));
  add("the page threw nothing", cap.errors, [], cap.errors.length === 0);
  return { checks, driven: true };
}

// ---- main -----------------------------------------------------------------------------------------------------
const pw = loadPlaywright();
if (!pw) {
  console.log("SKIP  playwright is not installed here (set PLAYWRIGHT_ROOT to a node_modules directory that has it)");
  process.exit(0);
}
const work = mkdtempSync(path.join(os.tmpdir(), "wtgui-text-styles-"));
const profile = path.join(work, "profile");
mkdirSync(profile, { recursive: true });
const ctx = await pw.chromium.launchPersistentContext(profile, { headless: !HEADED, viewport: { width: 1280, height: 1000 } });
let exit = 0;
try {
  const modes = MODE === "both" ? ["stream", "think"] : [MODE];
  for (const mode of modes) {
    console.log(`\n-- ${mode}: a sandbox panel of its own, a scripted turn with two thoughts, a skill's result, prose and a terminal call`);
    const cap = await runMode(ctx, work, mode);
    const verdict = judge(cap);
    for (const c of verdict.checks) {
      if (c.ok) console.log(`PASS  ${c.name}: ${JSON.stringify(c.got)}`);
      else console.log(`FAIL  ${c.name}\n        got  ${JSON.stringify(c.got)}\n        want ${typeof c.want === "string" ? c.want : JSON.stringify(c.want)}`);
    }
    console.log(`   screenshots: ${cap.shots.join("  ")}`);
    if (!verdict.driven) {
      console.log("NOT DRIVEN  the page did not show two thoughts, a skill box and prose: a pass here would prove nothing");
      console.log(JSON.stringify({ before: cap.before }, null, 1).slice(0, 1500));
      exit = Math.max(exit, 2);
    } else if (verdict.checks.some((c) => !c.ok)) exit = Math.max(exit, 1);
  }
} finally {
  await ctx.close().catch(() => {});
}
console.log(exit === 0 ? "\nOK  each of the three text styles reaches its own text, and the empty line stands where it should" : exit === 1 ? "\nFAILED  see the FAIL lines above" : "\nINCONCLUSIVE  the harness did not drive what it measures");
process.exit(exit);
