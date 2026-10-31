// What a live 🧠 block does when ONE store read comes back empty.
//
// The reasoning block is the only pane on a card that is POLLED and redrawn: the runs API carries a 500-char preview of
// a thought, so the block is re-read from the session store about every 2.4 s and `paintThink` replaces the whole
// `<details>`. A read that fails (a locked store) and a turn that genuinely thought nothing are the same bytes to the
// page unless the read carries its own error, so the question this measures is: does one empty read take the block's
// text away and give it back? On a turn with 60 blocks that is 102,731 characters collapsing to one line and popping
// back about 2.4 s later — the flicker itself.
//
//   node tools/measure-thinking-live.mjs                    # this checkout, newest session with reasoning, default report dir
//   node tools/measure-thinking-live.mjs --root <checkout>  # measure another checkout (e.g. a `git archive` export)
//   node tools/measure-thinking-live.mjs --thread <session>  # name the session to draw
//   node tools/measure-thinking-live.mjs --report <dir>     # where the JSON + shots go (default C:/CodeReviews/agent-worktree-gui)
//   node tools/measure-thinking-live.mjs --shots            # also write the before/after screenshots
//
// WHAT IS DRIVEN, and what is not
//   * a sandbox panel of its own — free port, own PANEL_CONFIG / jobs.json / projects cache, assistant off, a gateway
//     pointed at a closed port so nothing can be posted — serving the chosen checkout's public/, so no live panel is
//     touched;
//   * ONE card, drawn client-side from a synthetic `jobs` event for a REAL session id, so its blocks are the ones the
//     store holds. No turn is started, no reply is posted, and the store is opened read-only by the panel's own route;
//   * the probe then lets the pacer run, and injects exactly one `{ blocks: [] }` answer to /api/thinking — what a
//     locked store looks like to the page — and samples the block's drawn text every painted frame.
//
// CHECKS (exit 1 while any fails)
//   (1) the block rendered at least 2 blocks and 1,000 characters of real reasoning
//   (2) the injected empty read really reached the page
//   (3) the drawn text never fell below 90% of what the block held when the read landed (this is the flicker)
//   (4) the block still holds its text and its scroll position afterwards
//   (5) no page errors
import { execFileSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, mkdirSync as mkdir, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const ROOT = path.resolve(opt("--root", path.join(HERE, "..")));
const REPORT_DIR = opt("--report", "C:/CodeReviews/agent-worktree-gui");
const WANT_THREAD = opt("--thread");
const SHOTS = argv.includes("--shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the session to draw ---------------------------------------------------------------------------------------
// The newest session in the store that carries real reasoning. A store with none is a skip, not a failure: the tool
// has nothing to measure, and inventing blocks would measure the fixture instead of the page.
function hermesHome() {
  const env = process.env.HERMES_HOME;
  if (env && !env.startsWith("/")) return env;
  return path.join(process.env.LOCALAPPDATA || process.env.HOME || "", "hermes");
}
function pickSession() {
  const dbPath = path.join(hermesHome(), "state.db");
  if (!existsSync(dbPath)) return { skip: `no session store at ${dbPath}` };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (WANT_THREAD) {
      const rows = db
        .prepare("select timestamp, length(coalesce(reasoning_content, reasoning, '')) len from messages where session_id=? and length(coalesce(reasoning_content, reasoning, '')) > 20 order by timestamp asc")
        .all(WANT_THREAD);
      if (!rows.length) return { skip: `session ${WANT_THREAD} has no reasoning blocks` };
      return { thread: WANT_THREAD, rows };
    }
    const s = db
      .prepare(
        `select m.session_id id, count(*) n, sum(length(coalesce(m.reasoning_content, m.reasoning, ''))) chars, min(m.timestamp) first
           from messages m
          where length(coalesce(m.reasoning_content, m.reasoning, '')) > 20
            -- the panel's own assistant thread is not a card the board draws from a jobs event
            and m.session_id <> 'panel-assistant'
          group by m.session_id having n between 2 and 300
          order by max(m.timestamp) desc limit 1`,
      )
      .get();
    if (!s) return { skip: "no session in the store carries two or more reasoning blocks" };
    const rows = db
      .prepare("select timestamp, length(coalesce(reasoning_content, reasoning, '')) len from messages where session_id=? and length(coalesce(reasoning_content, reasoning, '')) > 20 order by timestamp asc")
      .all(s.id);
    return { thread: s.id, rows };
  } finally {
    db.close();
  }
}

// ---- the sandbox panel ------------------------------------------------------------------------------------------
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
const git = (cwd, a) => execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@localhost", ...a], { cwd, stdio: "pipe" });

async function startSandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-think-live-"));
  const repo = path.join(dir, "repo");
  const logs = path.join(dir, "logs");
  mkdir(repo, { recursive: true });
  mkdir(logs, { recursive: true });
  mkdir(path.join(dir, "empty-root"), { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(repo, "README.md"), "# probe repo\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "first"]);
  const port = await freePort();
  const cfgPath = path.join(dir, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      port,
      host: "127.0.0.1",
      scanRoots: [path.join(dir, "empty-root")],
      threads: 1,
      worktreeSeconds: 60,
      midSeconds: 60,
      dormantSeconds: 60,
      slowSeconds: 300,
      refreshSeconds: 3600,
      fetchSeconds: -1,
      projects: [{ name: "probe", path: repo, remote: "origin", mainBranch: "main", remoteBranchPolicy: "local-only", worktrees: null }],
      jobsFile: path.join(logs, "jobs.json"),
      projectsCacheFile: path.join(logs, "projects.json"),
      assistantFile: path.join(logs, "assistant.json"),
      assistant: { enabled: false },
      // No gateway: nothing in this tool may start or steer a turn.
      apiServer: { url: "http://127.0.0.1:9", key: "none" },
      remoteBranchPolicy: "local-only",
      defaultCwd: repo,
    }),
    "utf8",
  );
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: cfgPath },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const plog = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (x) => plog.push(x));
  child.stderr.on("data", (x) => plog.push(x));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (child.exitCode !== null) throw new Error(`sandbox panel exited: ${plog.join("").slice(-800)}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 300) throw new Error(`sandbox panel did not start: ${plog.join("").slice(-800)}`);
    await sleep(100);
  }
  return {
    base,
    repo,
    dir,
    plog,
    stop() {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a handle may still be open on Windows */
      }
    },
  };
}

// ---- the page ----------------------------------------------------------------------------------------------------
function pageInit({ thread, startedAt, cwd }) {
  try {
    localStorage.setItem("wtgui.autoCollect", "0");
    localStorage.setItem("wtgui.think." + thread, "1");
  } catch {
    /* storage */
  }
  const R = { t0: performance.now(), samples: [], paints: [], reads: [], errors: [], phase: "typing", injected: 0 };
  window.__w = R;
  window.__card = null;
  window.__emptyReads = 0;
  // Keep the live EventSource so the card can be handed to the page — and keep it in every job list the server
  // broadcasts (and every /api/state poll), or the next frame wipes a card the server does not know about.
  const orig = window.EventSource;
  window.__es = [];
  const withCard = (data) => {
    const d = JSON.parse(data || "{}");
    if (window.__card) d.jobs = (Array.isArray(d.jobs) ? d.jobs : []).filter((j) => j.id !== window.__card.id).concat([window.__card]);
    return JSON.stringify(d);
  };
  window.EventSource = class extends orig {
    constructor(...a) {
      super(...a);
      window.__es.push(this);
      const add = this.addEventListener.bind(this);
      this.addEventListener = (type, fn, opts) => {
        if (type === "jobs" || type === "snapshot") {
          return add(
            type,
            function (ev) {
              return fn.call(this, new MessageEvent(type, { data: withCard(ev.data) }));
            },
            opts,
          );
        }
        return add(type, fn, opts);
      };
    }
  };
  const now = () => Math.round((performance.now() - R.t0) * 10) / 10;
  const card = () => document.querySelector(`.job[data-thread="${thread}"]`);
  const body = () => [...(card()?.querySelectorAll(".think-body") || [])].pop() || null;
  const readBody = () => {
    const b = body();
    if (!b) return null;
    return {
      len: String(b.textContent || "").length,
      blocks: b.querySelectorAll("[data-lid]").length,
      st: Math.round(b.scrollTop),
      sh: b.scrollHeight,
      ch: b.clientHeight,
      open: Boolean(b.closest("details.think")?.open),
      meta: String(b.closest("details.think")?.querySelector(".think-meta")?.textContent || ""),
    };
  };
  let last = "";
  const tick = () => {
    const s = readBody();
    const k = s ? JSON.stringify([s.len, s.blocks, s.st, s.open]) : "null";
    if (k !== last) {
      last = k;
      if (s) R.samples.push({ t: now(), phase: R.phase, ...s });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__showCard = () => {
    const es = window.__es.find((e) => e.readyState === 1) || window.__es[0];
    if (!es) return "no stream";
    window.__card = {
      id: "liveThinkingCard",
      thread,
      turn: 1,
      status: "running",
      prompt: "a live turn, drawn read-only from the store",
      displayPrompt: "a live turn, drawn read-only from the store",
      cwd,
      worktree: false,
      worktreePath: null,
      projectPath: null,
      ownerPath: null,
      branch: null,
      runId: null,
      startedAt,
      endedAt: null,
      model: "probe/live",
      lines: [],
      artifacts: [],
      attachments: [],
      subagents: [],
    };
    es.dispatchEvent(new MessageEvent("jobs", { data: JSON.stringify({ jobs: [window.__card] }) }));
    return "dispatched";
  };
  window.__phase = (p) => (R.phase = p);
  window.__emptyOnce = (n = 1) => {
    window.__emptyReads = n;
    return "armed";
  };
  window.__instrument = () => {
    const o = window.paintThink;
    if (typeof o !== "function" || o.__w) return false;
    const w = function () {
      const b0 = body();
      const before = b0 ? String(b0.textContent || "").length : -1;
      const r = o.apply(this, arguments);
      const b1 = body();
      R.paints.push({ t: now(), before, after: b1 ? String(b1.textContent || "").length : -1, phase: R.phase });
      return r;
    };
    w.__w = true;
    window.paintThink = w;
    const of = window.fetch;
    window.fetch = async function (...a) {
      const url = String((a[0] && a[0].url) || a[0] || "");
      const r = await of.apply(this, a);
      if (url.includes("/api/state") && window.__card) {
        try {
          const d = await r.clone().json();
          d.jobs = (Array.isArray(d.jobs) ? d.jobs : []).filter((j) => j.id !== window.__card.id).concat([window.__card]);
          return new Response(JSON.stringify(d), { status: r.status, headers: { "Content-Type": "application/json" } });
        } catch {
          return r;
        }
      }
      if (url.includes("/api/thinking")) {
        // One empty answer, the way a locked store looks to the page (the route answers 200 `{ blocks: [] }`).
        if (window.__emptyReads > 0) {
          window.__emptyReads -= 1;
          R.injected += 1;
          R.reads.push({ t: now(), phase: R.phase, status: 200, blocks: 0, chars: 0, injected: true });
          return new Response(JSON.stringify({ blocks: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        let info;
        try {
          const d = await r.clone().json();
          const blocks = Array.isArray(d.blocks) ? d.blocks : [];
          info = { status: r.status, blocks: blocks.length, chars: blocks.reduce((n, b) => n + String(b.text || "").length, 0), error: d.error || null };
        } catch {
          info = { status: r.status, blocks: -1, chars: -1, error: "unreadable body" };
        }
        R.reads.push({ t: now(), phase: R.phase, ...info });
      }
      return r;
    };
    return true;
  };
}

// ---- main -------------------------------------------------------------------------------------------------------
const session = pickSession();
if (session.skip) {
  console.log(`SKIP  ${session.skip}`);
  process.exit(0);
}
const total = session.rows.reduce((n, r) => n + r.len, 0);
console.log(`session ${session.thread}: ${session.rows.length} blocks, ${total} chars, first ${new Date(session.rows[0].timestamp * 1000).toISOString()}`);

const pw = loadPlaywright();
if (!pw) {
  console.log("SKIP  playwright is not installed here (set PANEL_PLAYWRIGHT_ROOT to a node_modules directory that has it)");
  process.exit(0);
}
mkdirSync(REPORT_DIR, { recursive: true });
const sb = await startSandbox();
// A `git archive` export has no .git; name it by its directory instead of failing before the first check.
const stamp = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return path.basename(ROOT);
  }
})();
const out = { root: ROOT, commit: stamp, session: session.thread, blocks: session.rows.length, chars: total, at: new Date().toISOString(), checks: [], errors: [], shots: [] };
let failures = 0;
const check = (name, got, want, extra = "") => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  out.checks.push({ name, ok, got, want });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}${extra ? `\n        ${extra}` : ""}`}`);
};
const browser = await pw.chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(pageInit, { thread: session.thread, startedAt: new Date(session.rows[0].timestamp * 1000 - 2000).toISOString(), cwd: sb.repo });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => out.errors.push(String((e && e.message) || e)));
  page.on("console", (m) => {
    if (m.type() === "error") out.errors.push("console: " + m.text().slice(0, 300));
  });
  await page.goto(sb.base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof state !== "undefined" && state.jobs, null, { timeout: 30000 });
  await sleep(1200);
  out.instrumented = await page.evaluate(() => window.__instrument());
  out.shown = await page.evaluate(() => window.__showCard());
  await page.waitForFunction(() => document.querySelectorAll("details.think [data-lid]").length > 1, null, { timeout: 30000 });
  const shot = async (name) => {
    if (!SHOTS) return;
    const f = path.join(REPORT_DIR, `thinking-live-${out.commit}-${name}.png`);
    await page.locator(`.job[data-thread="${session.thread}"]`).screenshot({ path: f }).catch(() => {});
    out.shots.push(path.basename(f));
  };
  // Let the pacer draw what it will: the block holds real text, and the last block is still typing.
  await sleep(7000);
  await page.evaluate(() => window.__phase("typing"));
  // The block streams, so its scrollTop grows with its text; "place" means distance from the bottom.
  await page.evaluate(() => {
    window.__body = () => {
      const b = [...document.querySelectorAll(".think-body")].pop();
      if (!b) return null;
      const st = Math.round(b.scrollTop);
      const sh = Math.round(b.scrollHeight);
      const ch = Math.round(b.clientHeight);
      return { len: String(b.textContent || "").length, blocks: b.querySelectorAll("[data-lid]").length, st, sh, ch, fromBottom: Math.max(0, sh - ch - st) };
    };
  });
  const before = await page.evaluate(() => window.__body());
  await shot("1-before");
  // ONE empty read, then watch every painted frame.
  await page.evaluate(() => {
    window.__phase("after-empty-read");
    window.__emptyOnce(1);
  });
  await sleep(3400);
  const during = await page.evaluate(() => window.__body());
  await shot("2-after-empty-read");
  await sleep(3400);
  const after = await page.evaluate(() => window.__body());
  await shot("3-later");
  const R = await page.evaluate(() => window.__w);
  out.before = before;
  out.during = during;
  out.after = after;
  out.reads = R.reads;
  out.paints = R.paints;
  out.injected = R.injected;
  out.samples = R.samples;
  const injected = R.reads.filter((r) => r.injected);
  check("the block drew real reasoning (>= 2 blocks, >= 1,000 chars)", Boolean(before && before.blocks >= 2 && before.len >= 1000), true, `before: ${JSON.stringify(before)}`);
  check("the injected empty read reached the page", injected.length, 1);
  // The flicker: the block's drawn text may not fall to a fraction of what it held when the empty read landed.
  const floor = before ? Math.floor(before.len * 0.9) : 0;
  const low = R.samples.filter((s) => s.phase === "after-empty-read" && s.len < floor);
  check("one empty read does not take the block's text away", low.length, 0, `the block fell to ${low.length ? `${low[0].len} chars (${low[0].blocks} blocks) at ${Math.round(low[0].t)} ms from ${before ? before.len : "?"}` : "n/a"}`);
  check(
    "the block still holds its text and its place afterwards",
    Boolean(after && before && after.blocks >= before.blocks && after.len >= floor && Math.abs(after.fromBottom - before.fromBottom) <= 4),
    true,
    `before ${before ? `${before.len} chars, ${before.fromBottom}px from the bottom` : "n/a"} → after ${after ? `${after.len} chars, ${after.fromBottom}px from the bottom` : "n/a"}`,
  );
  check("no page errors", out.errors.length, 0);
  const falls = R.samples.filter((s, i) => i > 0 && s.len < R.samples[i - 1].len - 1);
  out.falls = falls;
  console.log(`\nblock drawn over the run: ${R.samples.length} painted states; ${R.reads.length} store reads (${injected.length} injected); ${falls.length} fall${falls.length === 1 ? "" : "s"} of the drawn text`);
  for (const f of falls.slice(0, 5)) console.log(`   fell at ${Math.round(f.t)} ms [${f.phase}] to ${f.len} chars / ${f.blocks} blocks`);
  console.log(`before ${before ? `${before.len} chars / ${before.blocks} blocks` : "n/a"} → after the empty read ${during ? `${during.len} chars / ${during.blocks} blocks` : "n/a"} → later ${after ? `${after.len} chars / ${after.blocks} blocks` : "n/a"}`);
} finally {
  await browser.close().catch(() => {});
  sb.stop();
}
out.failures = failures;
const file = path.join(REPORT_DIR, `thinking-live-${out.commit}.json`);
writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`\n${failures ? "FAIL" : "PASS"}  ${out.checks.length - failures}/${out.checks.length} checks  → ${file}`);
process.exit(failures ? 1 : 0);
