// Does a tool's output wait for the thought in front of it? One question, measured on the page.
//
//   node tools/verify-reasoning-first.mjs                 # 🌊 one-stream console and the 🧠 block, headless (~45 s)
//   node tools/verify-reasoning-first.mjs --mode stream   # the 🌊 console only
//   node tools/verify-reasoning-first.mjs --mode think    # the 🧠 block above a condensed console only
//   node tools/verify-reasoning-first.mjs --headed        # watch it
//   node tools/verify-reasoning-first.mjs --keep          # leave the sandbox behind for inspection
//
// WHAT THIS ANSWERS
//   The pacer types a reasoning block at the reader's words-a-second, and the tool call that reply made arrives on the
//   run stream as whole lines a few tens of milliseconds after the reply was written to the store — so the call (and
//   its output) used to land while the thought above it was still being typed. The reasoning hold keeps them out of
//   the console until the thought has been written. This drives a real sandbox panel through a scripted turn and
//   reads, per reasoning block, three moments off the page:
//
//     thought whole   the first instant the block's text is whole on screen
//     call drawn      the first instant the tool call that followed it is in the console
//     emitted         when the stub gateway put that tool call on the wire (the page cannot see this one)
//
//   and asks: did the call appear after the thought was whole (and not long after), and is the thought above the
//   call? A call with no thought in front of it is the control: it must not be held more than one beat.
//
// WHAT IT DRIVES (nothing synthetic reaches the page)
//   * a sandbox panel of its own (tools/panel-testkit.mjs) on a spare port; the reading panel is never touched;
//   * a stub Runs API that plays a fixed script over real SSE, and writes each reply's reasoning into a
//     `<sandbox>/hermes/state.db` `messages.reasoning_content` row a few tens of ms BEFORE it emits the tool call —
//     the order a real gateway has (see public/core/stream-merge.js);
//   * the page's own clocks: the 1.2 s thinking sweep, the pacer, drawJobLine, the hold.
//
// EXIT CODES
//   0  every check held (or Playwright is not installed: SKIP, like the other browser harnesses)
//   1  a call landed before its thought was written, or was held far longer than the thought took
//   2  the run did not drive what it measures (no card, no reasoning on screen, no tool call drawn)
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
const WORDS_PER_SEC = Number(opt("--words", 20));
if (!["stream", "think", "both"].includes(MODE)) {
  console.log(`--mode must be stream, think or both, not ${MODE}`);
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const THREAD = "probe-reasoning-first";

// ---- the turn ------------------------------------------------------------------------------------------------
const words = (n, seed) => Array.from({ length: n }, (_, i) => `${seed}${i + 1}`).join(" ");
// Two replies that think before they call, and one that does not.
const REPLIES = [
  { at: 600, think: `First thought. ${words(58, "alpha")}`, tool: "terminal", preview: "git status --short", result: "M public/app.js\n?? notes.md" },
  { at: 8200, think: `Second thought. ${words(38, "beta")}`, tool: "read_file", preview: "public/app.js", result: "1|const a = 1;\n2|const b = 2;" },
  { at: 13600, think: null, tool: "search_files", preview: "pattern: TODO", result: "none" },
];
const END_AT = 15400;

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
  db.prepare("insert or replace into sessions (id, source, started_at, model, cwd, title) values (?,?,?,?,?,?)").run(THREAD, "probe", Date.now() / 1000, "probe/model", ROOT, "reasoning first probe");
  db.close();
}

function writeReasoning(dir, text) {
  const db = new DatabaseSync(path.join(dir, "hermes", "state.db"));
  const stamp = Date.now();
  db.prepare("insert into messages (session_id, role, content, timestamp, reasoning_content) values (?,?,?,?,?)").run(THREAD, "assistant", "…", stamp / 1000, text);
  db.close();
  return stamp;
}

function makeGateway(dir, log) {
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
      return json(200, { version: "reasoning-first-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true } });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        state.posts += 1;
        const id = `run_rf_${state.posts}`;
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
      if (rec.startedAt != null) return; // one client plays the script
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
      REPLIES.forEach((r, i) => {
        later(r.at, () => {
          // The reply is complete: the store has it, and a few tens of ms later the call it made is on the wire.
          if (r.think) log.thought[i] = writeReasoning(dir, r.think);
          later(60, () => {
            log.emitted[i] = Date.now();
            send({ event: "tool.started", tool: r.tool, preview: r.preview });
            later(350, () => send({ event: "tool.completed", tool: r.tool, duration: 0.35, error: false, preview: r.result }));
          });
        });
      });
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

// ---- the page-side recorder ----------------------------------------------------------------------------------
// Before app.js. Storage (thinking on, the stream mode when asked, a words/s rate the script can outrun) and a
// MutationObserver that stamps the first instant each fact became true: a tool group is in the console, and a
// reasoning row's text is whole.
function pageInit({ thread, mode, rate, thoughts }) {
  try {
    localStorage.setItem("wtgui.autoCollect", "0");
    localStorage.setItem("wtgui.think", "1");
    localStorage.setItem(`wtgui.think.${thread}`, "1");
    localStorage.setItem("wtgui.streamWords", String(rate));
    localStorage.setItem("wtgui.streamLines", "0");
    if (mode === "stream") localStorage.setItem(`wtgui.stream.${thread}`, "1");
  } catch {
    /* storage may be unavailable */
  }
  const R = { tools: [], thoughts: thoughts.map(() => ({ firstSeen: 0, whole: 0 })), errors: [] };
  window.__rf = R;
  window.addEventListener("error", (e) => R.errors.push(String((e && e.message) || e)));
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const sweep = () => {
    const t = Date.now();
    const con = document.querySelector(`.job[data-thread="${thread}"] pre.job-out`);
    if (!con) return;
    // Every tool group, first seen (a call drawn, in either shape: flat in 🌊, condensed in the 🧠 mode).
    const groups = con.querySelectorAll(":scope > .tgrp");
    for (let i = R.tools.length; i < groups.length; i++) R.tools.push({ t, text: norm(groups[i].textContent).slice(0, 80) });
    // Each thought: where it is drawn depends on the mode, and it is whole when its text equals the stored text.
    const rows = [...document.querySelectorAll(`.job[data-thread="${thread}"] [data-lid^="think:"]`)];
    thoughts.forEach((full, i) => {
      if (!full) return;
      const want = norm(full);
      const row = rows.find((r) => norm(r.textContent) === want) || rows.find((r) => want.startsWith(norm(r.textContent).slice(0, 24)) && norm(r.textContent).length > 8);
      if (!row) return;
      const rec = R.thoughts[i];
      if (!rec.firstSeen) rec.firstSeen = t;
      if (!rec.whole && norm(row.textContent) === want) rec.whole = t;
    });
  };
  const attach = () => {
    const root = document.body || document.documentElement;
    if (!root) return false;
    new MutationObserver(sweep).observe(root, { childList: true, subtree: true, characterData: true });
    setInterval(sweep, 25); // a safety clock: text typed into an existing node is characterData, and this costs nothing
    return true;
  };
  if (!attach()) document.addEventListener("DOMContentLoaded", attach, { once: true });
}

// ---- one pass -------------------------------------------------------------------------------------------------
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
  const log = { thought: [], emitted: [] };
  const gw = makeGateway(dir, log);
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
  try {
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String((e && e.message) || e)));
    await page.addInitScript(pageInit, { thread: THREAD, mode, rate: WORDS_PER_SEC, thoughts: REPLIES.map((r) => r.think || "") });
    await page.goto(sandbox.base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.jobs, null, { timeout: 30000 });
    const spawned = await fetch(`${sandbox.base}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "probe: think, then call a tool", cwd: repo, existing: true, thread: THREAD }),
    }).then((r) => r.json());
    if (!spawned || !spawned.job) throw new Error(`spawn failed: ${JSON.stringify(spawned)}`);
    await page.waitForSelector(`.job[data-thread="${THREAD}"] pre.job-out`, { timeout: 20000 });
    await page.evaluate((th) => document.querySelector(`.job[data-thread="${th}"]`)?.scrollIntoView({ block: "center" }), THREAD);
    await sleep(END_AT + 4500);
    const R = await page.evaluate(() => window.__rf);
    const final = await page.evaluate((th) => {
      const con = document.querySelector(`.job[data-thread="${th}"] pre.job-out`);
      return {
        groups: con ? con.querySelectorAll(":scope > .tgrp").length : 0,
        // The console's rows in order: T a reasoning row (🌊 only — in the 🧠 mode it is a block above the console),
        // G a tool call with its output, . anything else. The thoughts are above the calls they led to when the
        // 🌊 reads T G T G G.
        sequence: con ? [...con.children].map((n) => (n.matches('[data-lid^="think:"]') ? "T" : n.classList.contains("tgrp") ? "G" : "")).join("") : "",
        blockAbove: Boolean(document.querySelector(`.job[data-thread="${th}"] details.think`)),
        text: con ? con.innerText : "",
        held: typeof state !== "undefined" && state.typeHold ? state.typeHold.queued() : null,
        holdPresent: typeof state !== "undefined" && Boolean(state.typeHold),
      };
    }, THREAD);
    // Beside the sandbox, not in it: stop() removes the sandbox, and a screenshot is only worth having if it outlives it.
    const shot = path.join(work, `${mode}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    return { mode, R, log, final, errors, shot };
  } finally {
    await gw.close().catch(() => {});
    await sandbox.stop().catch(() => {});
  }
}

// ---- reading the evidence -------------------------------------------------------------------------------------
const BEAT_MS = 450; // a call that has no thought in front of it may be one read late, never more
const SLACK_MS = 80; // the observer's own granularity
function judge(cap) {
  const checks = [];
  const add = (name, got, want, ok) => checks.push({ name, got, want, ok });
  const { R, log, final } = cap;
  const rows = REPLIES.map((r, i) => {
    const th = R.thoughts[i];
    const tool = R.tools[i];
    const emitted = log.emitted[i];
    return {
      reply: i + 1,
      tool: r.tool,
      thought: r.think ? `${r.think.split(" ").length} words` : "none",
      thoughtShown: th.firstSeen && emitted ? th.firstSeen - emitted : null,
      thoughtWhole: th.whole && emitted ? th.whole - emitted : null,
      toolShown: tool && emitted ? tool.t - emitted : null,
      gap: tool && th.whole ? tool.t - th.whole : null,
    };
  });
  const driven = rows.every((r) => r.toolShown != null) && rows.filter((r) => r.thought !== "none").every((r) => r.thoughtWhole != null);
  if (!driven) return { checks, rows, driven: false };
  REPLIES.forEach((r, i) => {
    const row = rows[i];
    if (r.think) {
      add(`reply ${i + 1}: the call is not drawn before its thought is whole`, row.gap, `>= ${-SLACK_MS} ms`, row.gap >= -SLACK_MS);
      add(`reply ${i + 1}: and is not held after it either`, row.gap, `<= ${BEAT_MS} ms`, row.gap <= BEAT_MS);
    } else {
      add(`reply ${i + 1} (no thought): the call is no more than one beat late`, row.toolShown, `<= ${BEAT_MS} ms`, row.toolShown <= BEAT_MS);
    }
  });
  // The 🧠 mode's console folds a run of calls into ONE burst on the repaint the turn's end causes, so a call is looked
  // for by name, not counted by node.
  const missing = REPLIES.filter((r) => !final.text.includes(r.tool)).map((r) => r.tool);
  add("every call is in the console at the end", missing, [], missing.length === 0);
  // The order the reader is left with. 🌊: each thought is a row of the console, directly above the call it led to
  // (T G T G G for two thoughts and three calls). 🧠: the thoughts are a block above the console.
  if (cap.mode === "stream") {
    const want = REPLIES.map((r) => (r.think ? "TG" : "G")).join("");
    add("each thought stands directly above its call", final.sequence, want, final.sequence === want);
  } else {
    add("the thoughts are in the block above the console, which holds no thought rows", { block: final.blockAbove, thoughtRowsInConsole: final.sequence.includes("T") }, { block: true, thoughtRowsInConsole: false }, final.blockAbove && !final.sequence.includes("T"));
  }
  add("nothing is left held at the end", final.held, 0, final.held === 0);
  add("the page threw nothing", cap.errors.concat(R.errors), [], cap.errors.length + R.errors.length === 0);
  return { checks, rows, driven: true };
}

function printRows(mode, rows) {
  console.log(`   ${mode}: ms after the stub put the call on the wire`);
  console.log("   reply | tool         | thought   | thought seen | thought whole | call drawn | call - thought whole");
  for (const r of rows) {
    const n = (v) => (v == null ? "—" : String(Math.round(v)));
    console.log(`   ${String(r.reply).padEnd(5)} | ${r.tool.padEnd(12)} | ${r.thought.padEnd(9)} | ${n(r.thoughtShown).padStart(12)} | ${n(r.thoughtWhole).padStart(13)} | ${n(r.toolShown).padStart(10)} | ${n(r.gap).padStart(20)}`);
  }
}

// ---- main -----------------------------------------------------------------------------------------------------
const pw = loadPlaywright();
if (!pw) {
  console.log("SKIP  playwright is not installed here (set PLAYWRIGHT_ROOT to a node_modules directory that has it)");
  process.exit(0);
}
const work = mkdtempSync(path.join(os.tmpdir(), "wtgui-reasoning-first-"));
const profile = path.join(work, "profile");
mkdirSync(profile, { recursive: true });
const ctx = await pw.chromium.launchPersistentContext(profile, { headless: !HEADED, viewport: { width: 1280, height: 1000 } });
let exit = 0;
try {
  const modes = MODE === "both" ? ["stream", "think"] : [MODE];
  for (const mode of modes) {
    console.log(`\n-- ${mode}: a sandbox panel of its own, ${WORDS_PER_SEC} words/s, three replies (two think first, one does not)`);
    const cap = await runMode(ctx, work, mode);
    const verdict = judge(cap);
    printRows(mode, verdict.rows);
    console.log(`   hold wired into the page: ${cap.final.holdPresent}; screenshot: ${cap.shot}`);
    for (const c of verdict.checks) {
      if (c.ok) console.log(`PASS  ${c.name}: ${JSON.stringify(c.got)}`);
      else console.log(`FAIL  ${c.name}\n        got  ${JSON.stringify(c.got)}\n        want ${typeof c.want === "string" ? c.want : JSON.stringify(c.want)}`);
    }
    if (!verdict.driven) {
      console.log("NOT DRIVEN  the run did not put every call and every thought on screen: a pass here would prove nothing");
      exit = Math.max(exit, 2);
    } else if (verdict.checks.some((c) => !c.ok)) exit = Math.max(exit, 1);
  }
} finally {
  await ctx.close().catch(() => {});
}
console.log(exit === 0 ? "\nOK  the tool output waits for the reasoning, and nothing waits for nothing" : exit === 1 ? "\nFAILED  see the FAIL lines above" : "\nINCONCLUSIVE  the harness did not drive what it measures");
process.exit(exit);
