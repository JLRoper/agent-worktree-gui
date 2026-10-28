// The console flicker, caught in a browser against a REAL run's output.
//
//   node tools/verify-console-flicker.mjs                      # drive this checkout, write the capture
//   node tools/verify-console-flicker.mjs --label before       # name the capture (before | after | anything)
//   node tools/verify-console-flicker.mjs --root <checkout>    # serve another checkout's server.js + public/
//   node tools/verify-console-flicker.mjs --compose            # merge the `before` and `after` captures into the report
//   --report <dir>   where the captures, screenshots and report go (default C:/CodeReviews/agent-worktree-gui)
//   --only <name>    one scenario: deliverables | stream
//
// WHAT THE FLICKER IS (the finding this tool carries)
//   The dark console of a live turn is not wiped by a tool group re-cutting itself; it is wiped by the NEXT live
//   line after anything repaints the console from the transcript. `drawJobLine` clears the console when its first
//   child is a `.jl-dim` line — meant for the "waiting for output…" placeholder, but every worker turn starts with a
//   real dim note ("⇢ asked to work in …", "cut from …", "push guard: …"), and any full repaint (the thinking sweep,
//   a new deliverable, an approval) puts that note back on top. So: repaint → console full → next line → console is
//   ONE line (a tool tally restarts at ×1) → repaint → full again. Everything below the console rides up and down.
//
// WHAT IS DRIVEN (nothing synthetic reaches the page)
//   * a throwaway panel of its own — spare port, own PANEL_CONFIG, own jobs.json, own HERMES_HOME, API_SERVER_KEY empty
//     — serving the chosen checkout's public/, so the live panel on 7331 is never touched
//   * a stub Runs API that plays a scripted agent turn over real SSE; the panel's own server code (jobs.push →
//     console-lines → /api/stream) produces every `jobline` frame the browser draws, and the card is spawned and
//     replied to through the panel's own routes
//   * the page records, per painted frame, what the console holds (children, line ids, duplicates, height) and where
//     the reply box under it sits, plus every wholesale write to a console with the stack that made it
//   * a paired shot per scenario: the page holds the live lines the instant a repaint finishes, shoots the console as
//     the repaint left it, lets exactly ONE line through, and shoots again — the open and the collapsed state, on disk
//
// WHAT IT ASSERTS, per scenario (exit code 1 while any fails)
//   (1) no live line wipes a console that holds transcript
//   (2) no live line removes rows from the console it is drawn into, and the console never loses 40px of height at once
//   (3) no line is drawn twice (a repaint plus a live append must not double a line)
//   (4) nothing under the console jumps up by more than 40px at an unchanged window scroll
//   (5) the repainters really fired (>= 3), so a clean run means the see-saw was exercised and survived
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const ROOT = path.resolve(opt("--root", path.join(HERE, "..")));
const REPORT_DIR = opt("--report", "C:/CodeReviews/agent-worktree-gui");
const LABEL = opt("--label", "run");
const ONLY = opt("--only");
const SHOT_DIR = path.join(REPORT_DIR, "console-flicker-shots");
const THREAD = "probe-thread-1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (n) => Math.round(n * 10) / 10;
const stat = (a) => {
  const s = [...a].sort((x, y) => x - y);
  if (!s.length) return null;
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], median: q(0.5), p90: q(0.9), max: s[s.length - 1] };
};

// ---- a scripted agent turn --------------------------------------------------------------------------------------
// A script is [{ at: ms-from-run-start, evt }]. Prose arrives as small deltas, a new paragraph starts with a blank
// line the way the model's own text does, and each call is a started/completed pair.
function buildScript(plan) {
  const steps = [];
  let t = 250;
  const say = (text, { para = true, perDelta = 120, words = 3 } = {}) => {
    const w = text.split(" ");
    for (let i = 0; i < w.length; i += words) {
      steps.push({ at: t, evt: { event: "message.delta", delta: `${i === 0 && para ? "\n\n" : ""}${w.slice(i, i + words).join(" ")} ` } });
      t += perDelta;
    }
    t += 200;
  };
  const call = (tool, preview, result, { dur = 0.45, gap = 220, envelope = false } = {}) => {
    steps.push({ at: t, evt: { event: "tool.started", tool, preview } });
    t += Math.round(dur * 1000);
    const body = envelope ? JSON.stringify({ output: result, exit_code: 0, error: null }) : result;
    steps.push({ at: t, evt: { event: "tool.completed", tool, duration: dur, error: false, preview: body } });
    t += gap;
  };
  plan({ say, call, pause: (ms) => (t += ms) });
  steps.push({ at: t + 300, evt: { event: "run.completed", output: "done", usage: { total_tokens: 4321, input_tokens: 4000, output_tokens: 321 } } });
  return steps;
}
const SHORT = () =>
  buildScript(({ say, call }) => {
    say("Reading the tree first.", { para: false });
    call("terminal", "git status --short", "M public/app.js\n?? notes.md", { envelope: true });
    call("read_file", "public/app.js", "1|const a = 1;\n2|const b = 2;\n3|module.exports = { a, b };");
    say("Nothing odd. Done with turn one.");
  });
// ~15 s of an ordinary turn: prose, bursts of mixed calls, prose between them. `files` adds deliverables — files the
// agent writes and a URL it hands over — and a new artifact is a changed card signature on the page.
const LONG = (dir, files) =>
  buildScript(({ say, call, pause }) => {
    const f = (n) => `${String(dir).split(String.fromCharCode(92)).join("/")}/${n}`;
    const write = (n, bytes) => {
      if (files) call("write_file", f(n), JSON.stringify({ resolved_path: f(n), bytes_written: bytes }));
    };
    say("Let me look at the current state of the tree before I change anything.", { para: false });
    call("terminal", "git status --short", "M public/app.js\nM lib/jobs.js\n?? notes.md", { envelope: true });
    call("terminal", "git log --oneline -5", "540fbc1 Merge reasoning types out too\n76b690a Reasoning types out too\nf373bea Merge every gate a push meets\n8dde23a docs: enumerate every guard\nc02d249 Merge the console fills in at a reading pace", { envelope: true });
    call("read_file", "public/app.js", Array.from({ length: 14 }, (_, i) => `${i + 1}|function part${i}() { return ${i}; }`).join("\n"));
    write("NOTES-1.md", 412);
    pause(500);
    say("The status shows two modified files. I will read the code that draws a console line next, then search for every writer.");
    call("search_files", "drawJobLine", "public/app.js:6962: function drawJobLine(evt) {\npublic/app.js:6941:   drawJobLine(evt);");
    call("read_file", "public/app.js", Array.from({ length: 22 }, (_, i) => `${i + 1}|  const step${i} = ${i};`).join("\n"));
    call("terminal", "grep -n innerHTML public/app.js | head", "6110:  out.innerHTML = streamBodyHtml(turn);\n6979:    if (out.firstElementChild) out.innerHTML = \"\";", { envelope: true });
    write("findings.json", 233);
    pause(600);
    say(files ? "The server is up at http://127.0.0.1:7599/ if you want to look while I keep going." : "Found it. Now I will apply the change and then run the suite to prove it.");
    call("patch", "public/app.js", "--- a/public/app.js\n+++ b/public/app.js\n@@ -6979,1 +6979,1 @@\n-    if (out.firstElementChild?.classList.contains(\"jl-dim\")) out.innerHTML = \"\";\n+    out.querySelector(\"[data-waiting]\")?.remove();", { dur: 0.9 });
    call("terminal", "node --test test/*.test.js", "ok 1 - a\nok 2 - b\nok 3 - c\n# tests 204\n# pass 204\n# fail 0", { envelope: true, dur: 1.4 });
    write("report.md", 900);
    call("terminal", "git diff --stat", " public/app.js | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)", { envelope: true });
    pause(500);
    say("The suite is green. One more read to confirm the diff is what I meant.");
    call("read_file", "public/app.js", "6979|    out.querySelector(\"[data-waiting]\")?.remove();");
    write("handoff.md", 640);
    call("terminal", "git add -A && git commit -m fix", "[main 1a2b3c4] fix\n 1 file changed", { envelope: true, dur: 0.6 });
    write("summary.txt", 120);
    say("Committed. That is the whole change.");
  });

// ---- the stub gateway: a Runs API that plays a script over real SSE ---------------------------------------------
function makeGateway() {
  const state = { runs: new Map(), posts: 0, dir: "", files: false };
  const timers = new Set();
  const later = (ms, fn) => {
    const h = setTimeout(() => {
      timers.delete(h);
      fn();
    }, ms);
    timers.add(h);
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/v1/capabilities") return json(200, { version: "flicker-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true } });
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        state.posts += 1;
        const id = `run_stub_${state.posts}`;
        const script = state.posts === 1 ? SHORT() : LONG(state.dir, state.files);
        state.runs.set(id, { id, status: "running", output: "", script, startedAt: null });
        json(200, { run_id: id, status: "running" });
      });
      return;
    }
    const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const rec = state.runs.get(one[1]);
      if (!rec) return json(404, { error: { message: "Run not found", code: "run_not_found" } });
      return json(200, { run_id: rec.id, status: rec.status, output: rec.output, usage: { total_tokens: 4321, input_tokens: 4000, output_tokens: 321 } });
    }
    const ev = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (ev && req.method === "GET") {
      const rec = state.runs.get(ev[1]);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      if (!rec) return res.end();
      res.write(": open\n\n");
      if (rec.startedAt == null) rec.startedAt = Date.now();
      const from = Number(req.headers["last-event-id"] ?? url.searchParams.get("last_seq") ?? -1) + 1;
      let open = true;
      req.on("close", () => {
        open = false;
      });
      rec.script.forEach((step, i) => {
        if (i < from) return;
        later(Math.max(0, rec.startedAt + step.at - Date.now()), () => {
          if (!open) return;
          res.write(`id: ${i}\ndata: ${JSON.stringify({ ...step.evt, run_id: rec.id, seq: i, timestamp: Date.now() / 1000 })}\n\n`);
          if (step.evt.event === "run.completed") {
            rec.status = "completed";
            rec.output = step.evt.output;
            later(50, () => res.end());
          }
        });
      });
      return;
    }
    json(404, {});
  });
  return {
    state,
    listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))),
    close: () =>
      new Promise((r) => {
        for (const h of timers) clearTimeout(h);
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

// ---- the sandbox panel -------------------------------------------------------------------------------------------
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

async function startSandbox(gwPort) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-flicker-"));
  const repo = path.join(dir, "repo");
  const logs = path.join(dir, "logs");
  mkdirSync(repo, { recursive: true });
  mkdirSync(logs, { recursive: true });
  mkdirSync(path.join(dir, "empty-root"), { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(repo, "README.md"), "# probe repo\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "first"]);
  // A board with some height to it: seven finished cards under the live one, so the page can move when the console does.
  const now = Date.now();
  const finished = Array.from({ length: 7 }, (_, i) => ({
    id: `seed-${i}`, thread: `seed-thread-${i}`, turn: 1, status: "done",
    prompt: `an earlier agent, number ${i + 1}`, displayPrompt: `an earlier agent, number ${i + 1}`,
    cwd: repo, worktree: false, worktreePath: null, projectPath: null, ownerPath: null, branch: null,
    runId: `run_seed_${i}`, startedAt: new Date(now - 900_000 - i * 60_000).toISOString(), endedAt: new Date(now - 800_000 - i * 60_000).toISOString(),
    model: "probe/model",
    lines: [
      { kind: "tool", text: "💻 terminal · ls", lid: 1, at: now - 850_000 },
      { kind: "tool-out", text: "  ↳ terminal · 0.20s", lid: 2, at: now - 849_800 },
      { kind: "text", text: `finished turn ${i + 1}: nothing left to do.`, lid: 3, at: now - 849_000 },
    ],
    artifacts: [], attachments: [], subagents: [],
  }));
  writeFileSync(path.join(logs, "jobs.json"), JSON.stringify({ savedAt: new Date(now).toISOString(), jobs: finished }), "utf8");
  const port = await freePort();
  const cfgPath = path.join(dir, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      port, host: "127.0.0.1", scanRoots: [path.join(dir, "empty-root")], threads: 1,
      worktreeSeconds: 60, midSeconds: 60, dormantSeconds: 60, slowSeconds: 60, refreshSeconds: 3600, fetchSeconds: -1, projects: [],
      jobsFile: path.join(logs, "jobs.json"), projectsCacheFile: path.join(logs, "projects.json"), assistantFile: path.join(logs, "assistant.json"),
      assistant: { enabled: false }, apiServer: { url: `http://127.0.0.1:${gwPort}`, key: "stub" }, remoteBranchPolicy: "local-only", defaultCwd: repo,
    }),
    "utf8",
  );
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: cfgPath, HERMES_HOME: path.join(dir, "home"), API_SERVER_KEY: "" },
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
    base, repo, dir, plog,
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

// ---- the page-side instrument ----------------------------------------------------------------------------------
// Runs in the page before app.js. It never changes what the page does, with one exception that is off until a paired
// shot arms it: drawJobLine holds its calls while `P.frozen` so the console can be shot exactly as a repaint left it.
function pageInit({ storage, thread }) {
  try {
    localStorage.setItem("wtgui.autoCollect", "0"); // a probe must never post a turn into a reader's thread
    for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
  } catch {
    /* storage may be unavailable */
  }
  const R = { t0: performance.now(), epoch0: performance.timeOrigin + performance.now(), writes: [], rebuilds: [], lines: [], draws: [], samples: [], attrFlips: 0, attrTargets: [] };
  const P = { armed: false, frozen: false, minRows: 6, queue: [] };
  window.__rec = R;
  window.__pair = P;
  const now = () => Math.round((performance.now() - R.t0) * 10) / 10;
  const frames = (stack) =>
    String(stack || "")
      .split("\n")
      .slice(2, 12)
      .map((s) => s.trim().replace(/^at /, "").replace(/\(?https?:\/\/[^/]+\/([^?)\s]+)[^:)]*:(\d+):\d+\)?/, "$1:$2"))
      .filter((s) => s && !/pageInit|__rec/.test(s))
      .join(" < ");
  const liveJob = () => {
    if (typeof state === "undefined") return null;
    for (const j of state.jobs.values()) if (j.thread === thread && (j.status === "running" || j.status === "starting")) return j;
    return null;
  };
  const consoleOf = (id) => document.querySelector(`pre.job-out[data-out="${id}"]`);
  const boxTop = (id) => {
    const out = consoleOf(id);
    const card = out && out.closest(".job");
    const box = card && card.querySelector(".reply-box");
    return box ? Math.round(box.getBoundingClientRect().top) : -1;
  };
  // Every wholesale write to a console, with what it held and the stack that wrote it.
  const d = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  Object.defineProperty(Element.prototype, "innerHTML", {
    configurable: true,
    enumerable: d.enumerable,
    get: d.get,
    set(v) {
      if (this.matches && this.matches("pre.job-out")) {
        const first = this.firstElementChild;
        R.writes.push({
          t: now(), out: this.dataset.out, len: String(v).length, kidsBefore: this.children.length,
          lidsBefore: this.querySelectorAll("[data-lid]").length,
          firstClass: first ? first.className : "",
          firstText: first ? String(first.dataset.ltext || first.textContent || "").slice(0, 90) : "",
          stack: frames(new Error().stack),
        });
      }
      return d.set.call(this, v);
    },
  });
  // A group body that hides and shows is the theory this tool was first written against; count it so the report can say 0.
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type !== "attributes" || !m.target.closest || !m.target.closest(".tgrp")) continue;
      R.attrFlips += 1;
      if (R.attrTargets.length < 5) R.attrTargets.push(`${m.target.className || m.target.tagName}[${m.attributeName}]`);
    }
  }).observe(document, { attributes: true, attributeFilter: ["hidden", "data-gflat"], subtree: true });
  // One sample per painted change of the live turn's console, and of the reply box under it.
  let last = "";
  const tick = () => {
    const j = liveJob();
    const out = j ? consoleOf(j.id) : null;
    if (out) {
      const lids = [...out.querySelectorAll("[data-lid]")].map((e) => e.dataset.lid);
      const rec = [now(), j.id, out.children.length, lids.length, lids.length - new Set(lids).size, out.scrollHeight, out.clientHeight, Math.round(scrollY), document.documentElement.scrollHeight, boxTop(j.id), out.querySelector("[data-wait]") ? 1 : 0];
      const key = rec.slice(2).join(",");
      if (key !== last) {
        R.samples.push(rec);
        last = key;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // A repaint has just finished: if a paired shot is armed and the console is worth shooting, hold every further live line.
  const onRepaint = (kind) => {
    if (!P.armed) return;
    const j = liveJob();
    const out = j ? consoleOf(j.id) : null;
    if (!out) return;
    const rows = out.querySelectorAll(".jl").length;
    if (rows < P.minRows) return;
    P.armed = false;
    P.frozen = true;
    window.__repainted(kind, { t: now(), job: j.id, rows, kids: out.children.length, first: out.firstElementChild ? out.firstElementChild.className : "", box: boxTop(j.id), y: Math.round(scrollY) });
  };
  // Called once app.js has loaded: wrap the entry points whose calls explain a rewrite.
  window.__instrument = () => {
    const wrap = (name, make) => {
      const o = window[name];
      if (typeof o !== "function" || o.__w) return false;
      const w = make(o);
      w.__w = true;
      window[name] = w;
      return true;
    };
    const ok = [];
    if (wrap("appendJobLine", (o) => function (...a) {
      const l = (a[0] && a[0].line) || {};
      R.lines.push({ t: now(), kind: l.kind, mode: l.mode });
      return o.apply(this, a);
    })) ok.push("appendJobLine");
    if (wrap("drawJobLine", (o) => function (...a) {
      if (P.frozen) {
        P.queue.push(a);
        return undefined;
      }
      // What one live line does to the console it is drawn into: the rows in it before and after. Rows, not line ids: a
      // tool group re-cut from groupLines() redraws every row it read back without its data-lid, which loses an
      // identity the page never reads, not a line the reader can see.
      const id = a[0] && a[0].id;
      const ln = (a[0] && a[0].line) || {};
      const pane = id ? consoleOf(id) : null;
      const rowsBefore = pane ? pane.querySelectorAll(".jl").length : -1;
      const tailBefore = pane && pane.lastElementChild ? pane.lastElementChild.className.split(" ").slice(0, 2).join(".") : "";
      const r = o.apply(this, a);
      const pane2 = id ? consoleOf(id) : null;
      if (pane || pane2) R.draws.push([now(), id, rowsBefore, pane2 ? pane2.querySelectorAll(".jl").length : -1, pane === pane2 ? 0 : 1, ln.kind || "", ln.mode || "", tailBefore, String(ln.text || "").slice(0, 50)]);
      return r;
    })) ok.push("drawJobLine");
    if (wrap("renderConversation", (o) => function (...a) {
      const sel = `.job[data-thread="${CSS.escape(String(a[0] || ""))}"]`;
      const before = document.querySelector(sel);
      const r = o.apply(this, a);
      const after = document.querySelector(sel);
      if (before && after && before !== after) {
        const live = liveJob();
        R.rebuilds.push({ t: now(), job: live ? live.id : null, stack: frames(new Error().stack).split(" < ").slice(0, 4).join(" < ") });
        if (live) onRepaint("a card rebuild");
      }
      return r;
    })) ok.push("renderConversation");
    if (wrap("paintStreamConsole", (o) => function (...a) {
      const r = o.apply(this, a);
      if (liveJob()) onRepaint("the thinking sweep");
      return r;
    })) ok.push("paintStreamConsole");
    return ok;
  };
}

// ---- one scenario ----------------------------------------------------------------------------------------------
const SCENARIOS = [
  { name: "deliverables", title: "condensed console, deliverables arrive mid-run", storage: {}, files: true, restorer: "a card rebuild: a new deliverable changes conversationSignature, renderConversation replaces the card" },
  { name: "stream", title: "🌊 one-stream console", storage: { [`wtgui.stream.${THREAD}`]: "1" }, files: false, restorer: "the thinking sweep: sweepThinking → loadThinking → paintThink → paintStreamConsole rewrites the console" },
];

async function runScenario(pw, sc, { pair }) {
  const gw = makeGateway();
  const gwPort = await gw.listen();
  const sb = await startSandbox(gwPort);
  gw.state.dir = sb.repo;
  gw.state.files = sc.files;
  const browser = await pw.chromium.launch({ headless: true });
  const out = { name: sc.name, shots: [], errors: [], paired: null };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 } });
    await ctx.addInitScript(pageInit, { storage: sc.storage, thread: THREAD });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => out.errors.push(String((e && e.message) || e)));
    const shot = async (name) => {
      mkdirSync(SHOT_DIR, { recursive: true });
      const file = path.join(SHOT_DIR, `${LABEL}-${sc.name}-${name}.png`);
      await page.screenshot({ path: file });
      out.shots.push(path.basename(file));
      return path.basename(file);
    };
    let pairResolve;
    const pairDone = new Promise((r) => (pairResolve = r));
    await page.exposeFunction("__repainted", async (kind, before) => {
      try {
        const full = await shot("1-repainted-full");
        await page.waitForFunction(() => window.__pair.queue.length >= 1, null, { timeout: 8000 }).catch(() => {});
        const queued = await page.evaluate(() => window.__pair.queue.length);
        const queuedLine = await page.evaluate(() => {
          const e = window.__pair.queue[0] && window.__pair.queue[0][0];
          return e && e.line ? { kind: e.line.kind, mode: e.line.mode, text: String(e.line.text || "").slice(0, 70) } : null;
        });
        console.log(`   paired shot: repainted by ${kind} at ${before.t}ms with ${before.rows} rows; the next live line is ${queuedLine ? `${queuedLine.kind}${queuedLine.mode ? `/${queuedLine.mode}` : ""} "${queuedLine.text.slice(0, 40)}"` : "none within 8 s"}`);
        await page.evaluate(() => {
          const P = window.__pair;
          P.frozen = false;
          const one = P.queue.shift();
          if (one) window.drawJobLine(...one);
          P.queue.length = 0; // the pairing pass needs only the one line; the rest are dropped so nothing is drawn twice
        });
        await sleep(160);
        const after = await page.evaluate(() => {
          const j = [...state.jobs.values()].find((x) => x.thread === "probe-thread-1" && x.status === "running");
          const o = j && document.querySelector(`pre.job-out[data-out="${j.id}"]`);
          const card = o && o.closest(".job");
          const box = card && card.querySelector(".reply-box");
          return o ? { rows: o.querySelectorAll(".jl").length, kids: o.children.length, first: o.firstElementChild ? o.firstElementChild.className : "", box: box ? Math.round(box.getBoundingClientRect().top) : -1, y: Math.round(scrollY) } : null;
        });
        const one = await shot("2-after-one-line");
        out.paired = { kind, before, after, queued, queuedLine, shots: [full, one] };
      } finally {
        await page.evaluate(() => (window.__pair.frozen = false)).catch(() => {});
        pairResolve();
      }
    });
    await page.goto(sb.base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.jobs && state.jobs.size >= 7, null, { timeout: 30000 });
    out.instrumented = await page.evaluate(() => window.__instrument());
    const post = async (route, body) => {
      const r = await fetch(`${sb.base}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: r.status, json: await r.json().catch(() => null) };
    };
    const waitDone = async (id, ms = 90000) => {
      const until = Date.now() + ms;
      for (;;) {
        const st = await page.evaluate((j) => (state.jobs.get(j) || {}).status, id);
        if (st && !["running", "starting", "waiting"].includes(st)) return st;
        if (Date.now() > until) return `timeout(${st})`;
        await sleep(250);
      }
    };
    const spawned = await post("/api/agents", { prompt: "probe turn one: read the tree", cwd: sb.repo, existing: true, thread: THREAD });
    if (!spawned.json || !spawned.json.job) throw new Error(`spawn failed: ${JSON.stringify(spawned)}`);
    const job1 = spawned.json.job;
    await page.waitForSelector(`.job[data-thread="${THREAD}"] pre.job-out`, { timeout: 20000 });
    await page.evaluate((th) => document.querySelector(`.job[data-thread="${th}"]`).scrollIntoView({ block: "center" }), THREAD);
    out.turn1 = await waitDone(job1.id);
    await sleep(1200);
    if (pair) await page.evaluate(() => (window.__pair.armed = true));
    const rep = await post("/api/agents/reply", { thread: THREAD, text: "now the long one" });
    if (!rep.json || !rep.json.job) throw new Error(`reply failed: ${JSON.stringify(rep)}`);
    const job2 = rep.json.job;
    await page.waitForFunction((id) => state.jobs.has(id), job2.id, { timeout: 15000 });
    out.turn2 = await waitDone(job2.id);
    if (pair) await Promise.race([pairDone, sleep(6000)]);
    await sleep(2500);
    out.jobs = { turn1: job1.id, turn2: job2.id };
    out.R = await page.evaluate(() => window.__rec);
  } finally {
    await browser.close().catch(() => {});
    sb.stop();
    await gw.close();
  }
  return out;
}

// ---- reading the evidence ----------------------------------------------------------------------------------------
function readTurn(R, jobId) {
  const S = R.samples.filter((s) => s[1] === jobId);
  const from = S.length ? S[0][0] : 0;
  const to = S.length ? S[S.length - 1][0] : 0;
  const wipes = R.writes
    .filter((w) => w.out === jobId && /drawJobLine/.test(w.stack) && w.kidsBefore >= 1 && !/^waiting for output/.test(w.firstText))
    .map((w) => ({ t: r1(w.t), kids: w.kidsBefore, lids: w.lidsBefore, firstClass: w.firstClass, firstText: w.firstText, stack: w.stack.split(" < ").slice(0, 3).join(" < ") }));
  const sweeps = R.writes.filter((w) => w.out === jobId && /paintStreamConsole/.test(w.stack)).map((w) => ({ t: r1(w.t), kind: "the thinking sweep", kids: w.kidsBefore }));
  const rebuilds = R.rebuilds.filter((b) => b.job === jobId).map((b) => ({ t: r1(b.t), kind: "a card rebuild" }));
  const bounces = [];
  const shrinks = [];
  let dupMax = 0;
  let lidMax = 0;
  for (let i = 1; i < S.length; i++) {
    const a = S[i - 1];
    const b = S[i];
    lidMax = Math.max(lidMax, b[3]);
    dupMax = Math.max(dupMax, b[4]);
    // the console's own height (scrollHeight) falling by more than a few rows at once is a transcript leaving it
    if (b[5] < a[5] - 40) shrinks.push({ t: r1(b[0]), from: a[5], to: b[5] });
    // the reply box rides up when the console above it shrinks; a change of the window's own scroll is not that
    if (b[7] === a[7] && a[9] >= 0 && b[9] >= 0 && b[9] - a[9] < -40) bounces.push({ t: r1(b[0]), by: b[9] - a[9], kidsFrom: a[2], kidsTo: b[2] });
  }
  // One live line must never take rows out of the console it is drawn into (rows, not line ids: see the drawJobLine wrapper).
  const rowDrops = R.draws.filter((d) => d[1] === jobId && d[2] >= 0 && d[3] < d[2]).map((d) => ({ t: r1(d[0]), from: d[2], to: d[3], kind: `${d[5]}${d[6] ? `/${d[6]}` : ""}`, text: d[8] }));
  const restores = [...sweeps, ...rebuilds].sort((x, y) => x.t - y.t);
  const intervals = restores.slice(1).map((x, i) => r1(x.t - restores[i].t));
  const latency = wipes.map((w) => {
    const prior = restores.filter((x) => x.t <= w.t).pop();
    return prior ? r1(w.t - prior.t) : null;
  });
  const lines = R.lines.filter((l) => l.t >= from && l.t <= to);
  const gaps = lines.slice(1).map((l, i) => r1(l.t - lines[i].t));
  const boxes = S.map((s) => s[9]).filter((v) => v >= 0);
  return {
    job: jobId, samples: S.length, startMs: r1(from), endMs: r1(to), maxLids: lidMax, wipes, rowDrops, shrinks, bounces, dupMax, restores,
    restoreIntervalsMs: intervals, restoreToWipeMs: latency.filter((x) => x != null), appendGapsMs: stat(gaps), boxRange: boxes.length ? [Math.min(...boxes), Math.max(...boxes)] : null,
  };
}

// The file:line of each thing the report points at, read from the checkout that ran.
function locate(root) {
  const file = (rel) => {
    const p = path.join(root, rel);
    return existsSync(p) ? readFileSync(p, "utf8").split(/\r?\n/) : [];
  };
  const find = (rel, re, from = 0) => {
    const L = file(rel);
    for (let i = Math.max(0, from); i < L.length; i++) if (re.test(L[i])) return i + 1;
    return null;
  };
  const app = "public/app.js";
  const paint = find(app, /^function paintStreamConsole/);
  const rc = find(app, /^function renderConversation/);
  const sig = find(app, /^function conversationSignature/);
  return {
    arm: find(app, /firstElementChild\?\.classList\.contains\("jl-dim"\)/),
    wait: find(app, /waiting for output/),
    waitClear: find(app, /:scope > \[data-wait\]/),
    drawJobLine: find(app, /^function drawJobLine/),
    paintStreamConsole: paint,
    paintWrite: paint ? find(app, /out\.innerHTML = /, paint - 1) : null,
    renderConversation: rc,
    rebuildReplace: rc ? find(app, /\.replaceWith\(/, rc - 1) : null,
    signature: sig,
    signatureArtifacts: sig ? find(app, /artifacts/, sig - 1) : null,
    sweepClock: find(app, /setInterval\(sweepThinking/),
    dimNote: find("lib/jobs.js", /asked to work in/),
  };
}

function sh(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
  } catch {
    return "";
  }
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

// ---- main: capture -----------------------------------------------------------------------------------------------
async function capture() {
  const pw = loadPlaywright();
  if (!pw) {
    console.log("SKIP  playwright is not installed here (set PLAYWRIGHT_ROOT to a node_modules directory that has it)");
    process.exit(0);
  }
  mkdirSync(SHOT_DIR, { recursive: true });
  const result = {
    label: LABEL, root: ROOT, commit: sh("git", ["rev-parse", "--short", "HEAD"], ROOT), dirty: sh("git", ["status", "--short", "--", "public", "lib", "server.js"], ROOT) !== "",
    at: new Date().toISOString(), refs: locate(ROOT), scenarios: [], checks: [],
  };
  let failures = 0;
  const check = (name, got, want, extra = "") => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failures += 1;
    result.checks.push({ name, ok, got, want });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}${extra ? `\n        ${extra}` : ""}`}`);
  };
  for (const sc of SCENARIOS.filter((s) => !ONLY || s.name === ONLY)) {
    console.log(`\n== ${sc.name}: ${sc.title}  (${LABEL}, ${result.commit}${result.dirty ? "+local edits" : ""})`);
    // pass 1 measures a run nobody touched; pass 2 holds the live lines once to take the paired shots
    const measured = await runScenario(pw, sc, { pair: false });
    const paired = argv.includes("--no-pair") ? { paired: null, shots: [], errors: [] } : await runScenario(pw, sc, { pair: true });
    const turns = [readTurn(measured.R, measured.jobs.turn1), readTurn(measured.R, measured.jobs.turn2)];
    if (argv.includes("--raw")) writeFileSync(path.join(REPORT_DIR, `console-flicker-${LABEL}-${sc.name}-raw.json`), JSON.stringify({ samples: measured.R.samples, writes: measured.R.writes, rebuilds: measured.R.rebuilds, lines: measured.R.lines, draws: measured.R.draws, jobs: measured.jobs }));
    result.scenarios.push({
      name: sc.name, title: sc.title, restorer: sc.restorer, turnStates: [measured.turn1, measured.turn2], turns, errors: measured.errors, instrumented: measured.instrumented,
      attrFlips: measured.R.attrFlips, attrTargets: measured.R.attrTargets, appends: measured.R.lines.length, paired: paired.paired, shots: paired.shots, pairedErrors: paired.errors,
    });
    const wipes = turns.flatMap((t) => t.wipes);
    const drops = turns.flatMap((t) => t.rowDrops);
    const shrinks = turns.flatMap((t) => t.shrinks);
    const bounces = turns.flatMap((t) => t.bounces);
    const restores = turns.flatMap((t) => t.restores);
    console.log(`   turns ${measured.turn1}/${measured.turn2}; ${measured.R.lines.length} appends; ${restores.length} repaints; group-body attribute flips ${measured.R.attrFlips}; instrumented ${JSON.stringify(measured.instrumented)}`);
    check(`${sc.name}: no live line wipes a console that holds transcript`, wipes.length, 0, wipes.slice(0, 3).map((w) => `@${w.t}ms wiped ${w.kids} children (first: ${w.firstClass} "${w.firstText.slice(0, 40)}") via ${w.stack}`).join("\n        "));
    check(`${sc.name}: no live line removes rows from the console it is drawn into`, drops.length, 0, drops.slice(0, 3).map((d) => `@${d.t}ms ${d.kind} took ${d.from} rows to ${d.to}`).join("; "));
    check(`${sc.name}: the console never loses more than 40px of height at once`, shrinks.length, 0, shrinks.slice(0, 3).map((d) => `@${d.t}ms ${d.from}px -> ${d.to}px`).join("; "));
    check(`${sc.name}: no line is drawn twice`, Math.max(...turns.map((t) => t.dupMax)), 0);
    check(`${sc.name}: nothing under the console jumps up by more than 40px`, bounces.length, 0, bounces.slice(0, 3).map((b) => `@${b.t}ms by ${b.by}px`).join("; "));
    check(`${sc.name}: the repainters fired at least 3 times`, restores.length >= 3, true);
    check(`${sc.name}: no page errors`, measured.errors.length + paired.errors.length, 0);
    if (!paired.paired) console.log("   (no paired shot: no repaint landed on a console of 6+ lines)");
  }
  result.failures = failures;
  const file = path.join(REPORT_DIR, `console-flicker-${LABEL}.json`);
  writeFileSync(file, JSON.stringify(result, null, 1));
  console.log(`\n${failures ? "FAIL" : "PASS"}  ${result.checks.length - failures}/${result.checks.length} checks  → ${file}`);
  process.exit(failures ? 1 : 0);
}

// ---- main: compose the report ---------------------------------------------------------------------------------------
function compose() {
  const read = (l) => {
    const p = path.join(REPORT_DIR, `console-flicker-${l}.json`);
    if (!existsSync(p)) throw new Error(`no capture at ${p} — run the tool with --label ${l} first`);
    return JSON.parse(readFileSync(p, "utf8"));
  };
  const before = read("before");
  const after = read("after");
  const wipesOf = (s) => s.turns.flatMap((t) => t.wipes);
  const dropsOf = (s) => s.turns.flatMap((t) => t.rowDrops);
  const shrinksOf = (s) => s.turns.flatMap((t) => t.shrinks);
  const bouncesOf = (s) => s.turns.flatMap((t) => t.bounces);
  const restoresOf = (s) => s.turns.flatMap((t) => t.restores);
  const range = (arr, unit = " ms") => {
    const s = stat(arr);
    return s ? `${s.min}–${s.max}${unit}` : "n/a";
  };
  const med = (arr) => {
    const s = stat(arr);
    return s ? s.median : "n/a";
  };
  const rel = (f) => `console-flicker-shots/${f}`;
  const L = [];
  const push = (...x) => L.push(...x);
  const stream = before.scenarios.find((s) => s.name === "stream");
  const deliv = before.scenarios.find((s) => s.name === "deliverables");
  const sT2 = stream && stream.turns[1];
  const dT2 = deliv && deliv.turns[1];
  const allLatency = before.scenarios.flatMap((s) => s.turns.flatMap((t) => t.restoreToWipeMs));
  const a = before.refs;
  const b = after.refs;
  const totalAppends = before.scenarios.reduce((n, s) => n + s.appends, 0);
  const totalFlips = before.scenarios.reduce((n, s) => n + s.attrFlips, 0) + after.scenarios.reduce((n, s) => n + s.attrFlips, 0);
  const totalWipes = before.scenarios.reduce((n, s) => n + wipesOf(s).length, 0);
  push(
    "# The console flicker, caught in a browser against a real run's output",
    "",
    `Tree \`wtgui/catch-the-console-flicke-579251\`. **before** = \`${before.commit}\`${before.dirty ? " (+ local edits)" : ""}, **after** = \`${after.commit}\`${after.dirty ? " + the fix, uncommitted when captured" : ""}. Captured ${after.at.slice(0, 10)} by \`node tools/verify-console-flicker.mjs\`; every number below is read back from \`console-flicker-before.json\` and \`console-flicker-after.json\` beside this file.`,
    "",
    "## Verdict",
    "",
    `1. **A group body closing and reopening — disproved.** ${totalFlips} \`hidden\` / \`data-gflat\` attribute flips were seen on anything inside a \`.tgrp\` across ${totalAppends} live appends in the before captures and the same number of after captures. The tool group is not what blinks.`,
    `2. **The console collapsing to the newest line and reopening — proved, and it happens within a second of an append.** A live line wiped the whole console ${totalWipes} times in the before captures (${before.scenarios.map((s) => `${wipesOf(s).length} in the ${s.name} run`).join(", ")}). Every wipe after the first line of a turn came ${range(allLatency)} after a repaint of the console (${allLatency.length} measured), and is caused by the first live line that arrives after it.`,
    "3. **The node that blinks:** `pre.job-out[data-out=\"<turn id>\"]`, its whole child list. What the reader sees vanish and return is `pre.job-out > .jl` (text and dim notes) and `pre.job-out > .tgrp[data-tgrp]` with its `> .tgrp-body`; they are destroyed and rebuilt, not hidden. The armed state is `pre.job-out > .jl.jl-dim:first-child`.",
    `4. **Cadence.** In 🌊 mode the repaint is a clock: every ${med(sT2 ? sT2.restoreIntervalsMs : [])} ms (median; the 1200 ms sweep tick repaints once the thinking cache is 2000 ms old). In the condensed console the repaint is the arrival of each deliverable: ${dT2 ? dT2.restores.length : 0} in the 15 s turn, gaps ${range(dT2 ? dT2.restoreIntervalsMs : [])}. Lines arrive every ${sT2 && sT2.appendGapsMs ? sT2.appendGapsMs.median : "n/a"} ms (median), so a wipe is never more than one append away from a repaint.`,
    "",
    "Nothing watches the collapse and reopens it. The two halves are independent writers that happen to alternate: a repaint writes the whole transcript (and the dim note that arms the wipe) back, and the next live line wipes it. The sweep fires on its clock whether or not anything collapsed.",
    "",
    "## Before and after, same tool, same stub run",
    "",
    "| check | scenario | before | after |",
    "| --- | --- | --- | --- |",
  );
  for (const sc of ["deliverables", "stream"]) {
    const bs = before.scenarios.find((s) => s.name === sc);
    const af = after.scenarios.find((s) => s.name === sc);
    if (!bs || !af) continue;
    push(`| live line wipes a populated console | ${sc} | ${wipesOf(bs).length} | ${wipesOf(af).length} |`);
    push(`| a live line removes rows from the console it draws into | ${sc} | ${dropsOf(bs).length} | ${dropsOf(af).length} |`);
    push(`| the console loses > 40px of height at once | ${sc} | ${shrinksOf(bs).length} | ${shrinksOf(af).length} |`);
    push(`| content under the console jumps up > 40px | ${sc} | ${bouncesOf(bs).length} (largest ${Math.min(0, ...bouncesOf(bs).map((x) => x.by))}px) | ${bouncesOf(af).length} |`);
    push(`| repaints of the console during the two turns | ${sc} | ${restoresOf(bs).length} | ${restoresOf(af).length} |`);
    push(`| a line drawn twice (max duplicate line ids) | ${sc} | ${Math.max(...bs.turns.map((t) => t.dupMax))} | ${Math.max(...af.turns.map((t) => t.dupMax))} |`);
  }
  push("", `Checks passed: before ${before.checks.filter((c) => c.ok).length}/${before.checks.length}, after ${after.checks.filter((c) => c.ok).length}/${after.checks.length}. The repaints still fire after the fix, which is the point: they now rewrite what is already there instead of arming a wipe.`, "");
  for (const s of before.scenarios) {
    const t = s.turns[1];
    const af = after.scenarios.find((x) => x.name === s.name);
    push(`## ${s.name}: ${s.title}`, "", `Repainter: ${s.restorer}.`, "", "The long turn, before the fix. Each wipe, the repaint before it, and what it destroyed (page time in ms):", "", "| wipe at | children destroyed | line ids destroyed | first child that armed it | written by | repaint before it | latency |", "| --- | --- | --- | --- | --- | --- | --- |");
    t.wipes.forEach((w, i) => {
      const prior = t.restores.filter((x) => x.t <= w.t).pop();
      const lat = prior ? r1(w.t - prior.t) : null;
      push(`| ${w.t} | ${w.kids} | ${w.lids} | \`${w.firstClass}\` “${String(w.firstText).slice(0, 48)}” | \`${w.stack.split(" < ")[0]}\` | ${prior ? `${prior.t} (${prior.kind})` : "start of turn"} | ${lat != null ? `${lat} ms` : "—"} |`);
    });
    push("", `Repaint times in this turn: ${t.restores.map((x) => x.t).join(", ") || "none"}.`, "");
    const pb = s.paired;
    const pa = af && af.paired;
    if (pb && pa) {
      const move = (p) => (p.after ? `${p.after.box - p.before.box >= 0 ? "+" : ""}${p.after.box - p.before.box}px` : "n/a");
      push(
        "Paired shots. The page holds its live lines the instant a repaint finishes, shoots the console as the repaint left it, lets exactly one line through, and shoots again.",
        "",
        `Before the fix, repainted by ${pb.kind}: ${pb.before.rows} rows in ${pb.before.kids} children, reply box at y=${pb.before.box}. One line later: ${pb.after ? `${pb.after.rows} row(s) in ${pb.after.kids} child(ren), reply box at y=${pb.after.box} (${move(pb)})` : "n/a"}.`,
        "",
        ...pb.shots.map((f, i) => `![before ${i + 1}](${rel(f)})`),
        "",
        `After the fix, repainted by ${pa.kind}: ${pa.before.rows} rows in ${pa.before.kids} children, reply box at y=${pa.before.box}. One line later: ${pa.after ? `${pa.after.rows} row(s) in ${pa.after.kids} child(ren), reply box at y=${pa.after.box} (${move(pa)})` : "n/a"}.`,
        "",
        ...pa.shots.map((f, i) => `![after ${i + 1}](${rel(f)})`),
        "",
      );
    }
  }
  push(
    "## Why it happens",
    "",
    `1. **The wipe is a class test.** \`public/app.js:${a.arm}\` in \`drawJobLine\` (:${a.drawJobLine}): \`if (out.firstElementChild?.classList.contains("jl-dim")) out.innerHTML = "";\`. It exists to clear the placeholder a console shows before its turn has said anything (:${a.wait}, \`<div class="jl jl-dim">waiting for output…</div>\`), but it asks "is the first child dim?", and the placeholder is not the only dim line.`,
    `2. **Every worker turn starts with a real dim line.** \`lib/jobs.js:${a.dimNote}\` pushes \`⇢ asked to work in <cwd> …\` as the first line of a turn (the Runs API takes no cwd); a worktree spawn pushes \`cut from …\` and \`push guard: …\` first. They are transcript, rendered as \`.jl.jl-dim\`, and they are the first child of every console that is repainted from the buffer.`,
    `3. **Repainters put that line back on top.** (a) \`paintStreamConsole\` (:${a.paintStreamConsole}, write at :${a.paintWrite}) rewrites the console wholesale; the thinking sweep (:${a.sweepClock}) calls it on a 1200 ms tick once a live turn's cache is 2000 ms old, so about every 2.4 s. (b) \`renderConversation\` (:${a.renderConversation}) replaces the whole card (:${a.rebuildReplace}) whenever \`conversationSignature\` (:${a.signature}) changes; \`artifacts\` is in it (:${a.signatureArtifacts}), so each new deliverable, and equally an approval, a status flip or a title landing, rebuilds the console from the buffer.`,
    "4. **The next live line wipes it.** A repainted console's first child is the dim note, so `drawJobLine` empties the console and draws only the new line. A tool call after a wipe finds no `.tgrp` at the tail, so it starts a group of one: the aggregation count restarts at ×1, which is what looks like the tool tally being rebuilt. Every drawn line is gone until the next repaint puts them back.",
    "5. **Why the page bounces.** The console is capped (about 230px visible); collapsed it is one line (about 33px). Everything under it, the reply box and the cards after it, rides up about 195px at the wipe and back down at the repaint. The window's own `scrollY` does not move, so the content slides under the reader.",
    "",
    "## History: why it is recent",
    "",
    "`git log -S` on each piece. The class test dates from 2026-10-21 (6e418ed, a commit about starring turns) and was harmless while the placeholder was the only dim first child. The dim `asked to work in` line arrived 2026-10-23 (6e69bba); the `cut from` / `push guard` notes 2026-10-26 to 27 (3470b18, 692c362); `artifacts` in the signature 2026-10-23 (15b203c); the 1.2 s thinking sweep 2026-10-23 (d09f27a); and `paintStreamConsole`, the whole-console rewrite the sweep now calls, 2026-10-27 (1a24139, \"Draw a card as ONE stream\"). The check became wrong the day a real dim line started the console, and became visible the day something repainted on a clock.",
    "",
    "## The fix",
    "",
    `The placeholder is marked (\`data-wait\`, \`public/app.js:${b.wait}\`) and \`drawJobLine\` removes that node only (:${b.waitClear}). A dim transcript line is no longer mistaken for the placeholder, so a repaint followed by a live line adds a line instead of replacing the console. Nothing that repaints was removed or throttled: the clocks, the signature and the stickiness helpers are as they were.`,
    "",
    "## Not part of the flicker, found on the way",
    "",
    "- `toolGroupHtml`'s flat flag is decided per call site: a live append reads `data-gflat` off the group, a new group reads `streamOn(...)` in `drawJobLine`, a card render reads it again in `turnBody`, and `conversationSignature` has no `streamOn` term, so toggling 🌊 does not repaint the card. A burst can be flat on one render and condensed on the next. Measured earlier with a synthetic seeded card (git history `5302e81`); this tool does not exercise it.",
    "- A live tool group is keyed `<turn>#<base36 time>` while the same group rebuilt from the buffer is keyed `<turn>#<index>`, so a group body the reader opened closes at the first repaint.",
    "- When a tool call joins a group that came from a repaint, `drawJobLine` re-cuts the group from `groupLines()`, which reads rows back as `{ kind, text }` without their `lid`, so every row it redraws loses its `data-lid`. Nothing visible changes (the console grows by the new row, as measured), but the rows lose the identity a live `set` update would look them up by. An earlier version of this tool counted line ids and mistook that for lost content.",
    "",
    "## Limits",
    "",
    "- The run is a scripted stub gateway, not a live Hermes agent. Everything between the stub and the browser is the panel's own code; what the model says and which tools it calls are scripted. Approvals, questions, status flips and title landing were not exercised, though by the signature they are the same kind of repainter as a deliverable.",
    "- The page is headless Chromium at 1180×900 with the card centred; a different window changes the pixel distances, not the cause.",
    "- The screenshots come from a separate pairing pass in which the page holds its live lines for a moment; the measured numbers come from an untouched pass.",
    "",
  );
  writeFileSync(path.join(REPORT_DIR, "console-flicker-playwright.md"), L.join("\n"));
  console.log(`report → ${path.join(REPORT_DIR, "console-flicker-playwright.md")}`);
}

if (argv.includes("--compose")) compose();
else await capture();
