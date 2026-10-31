// Lane A: a long turn's burst survives the console window, and the reader's fold survives the turn growing.
//
//   node tools/verify-lane-a-burst.mjs                     # drive this checkout, write the report
//   node tools/verify-lane-a-burst.mjs --root <checkout>    # serve another checkout's server.js + public/
//   node tools/verify-lane-a-burst.mjs --report <dir>       # where the shots and the .md go
//   node tools/verify-lane-a-burst.mjs --keep               # leave the sandbox temp dir behind
//
// WHAT IS DRIVEN (nothing synthetic reaches the page)
//   * a throwaway panel of its own — spare port, own PANEL_CONFIG, own jobs.json, own HERMES_HOME, empty
//     API_SERVER_KEY — serving the chosen checkout's public/, so the live panel on 7331 is never written to and is
//     never restarted. The live panel is read first, over HTTP, to prove it is up and serving the same app.js.
//   * a stub Runs API that plays one scripted long turn over real SSE, gated so the reader's clicks land between
//     segments. The panel's own server code (lib/jobs.js linesForEvent → jobline frames → /api/stream → drawJobLine)
//     produces every line the browser draws, and the card is spawned through the panel's own /api/agents route.
//   * one turn of 600+ console lines: three earlier bursts, then a terminal call with a 240-line result (the console's
//     own fold draws 40 of them plus the note), then the two small bursts the reader folds, then ten more joblines,
//     then enough further work that a blind 300-line cut of the turn starts inside the flood's own results.
//
// WHAT IT ASSERTS
//   (1) the flood's .tgrp still exists, with a head row and non-empty data-gstate/data-gat, after a full repaint whose
//       300-line window has slid past the flood's call line — measured at the repaint a deliverable forces, and again
//       at the repaint the turn's own end forces
//   (2) a group the reader opened is still open after ten new joblines, and after the full repaint that follows them
//   (3) a group the reader closed (having opened it) is still closed across the same ten, and after that repaint
//   (4) no .tgrp-body ever changes its `hidden` attribute in place: the count is 0, because open state is markup and
//       every change to it is a node replacement
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const SHOT_DIR = path.join(REPORT_DIR, "playwright-lane-a");
const LIVE = opt("--live", "http://127.0.0.1:7331");
const THREAD = "probe-lane-a";
const BIG_LINES = 240; // the flood's result, in lines: the console's own fold draws 40 of them plus the note
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the scripted long turn --------------------------------------------------------------------------------------
// A script is [{ at: ms, evt }] plus { gate: name } markers. Times are relative to the previous step, so a gate pause
// does not turn the rest of the segment into one burst.
function buildScript(dir) {
  const steps = [];
  let t = 150;
  const say = (text, { perDelta = 80, words = 6 } = {}) => {
    const w = String(text).split(" ");
    for (let i = 0; i < w.length; i += words) {
      steps.push({ at: t, evt: { event: "message.delta", delta: `${i === 0 ? "\n\n" : ""}${w.slice(i, i + words).join(" ")} ` } });
      t += perDelta;
    }
    t += 100;
  };
  const call = (tool, preview, result, { dur = 0.1, gap = 0.05, envelope = false } = {}) => {
    steps.push({ at: t, evt: { event: "tool.started", tool, preview } });
    t += Math.round(dur * 1000);
    const body = envelope ? JSON.stringify({ output: result, exit_code: 0, error: null }) : result;
    steps.push({ at: t, evt: { event: "tool.completed", tool, duration: dur, error: false, preview: body } });
    t += gap;
  };
  const gate = (name) => steps.push({ gate: name });
  const out = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} line ${String(i + 1).padStart(3, "0")} — ${"~".repeat(16)}`).join("\n");
  const f = (n) => `${String(dir).split(String.fromCharCode(92)).join("/")}/${n}`;

  // The earlier work: three bursts of seven calls (14 console lines each), prose between them so each is its own group.
  say("One long turn. The earlier work first, then a flood of terminal output.");
  for (let b = 0; b < 3; b++) {
    for (let i = 0; i < 7; i++) call("terminal", `pre ${b + 1}.${i + 1}: read the tree`, out(12, `pre${b + 1}x${i + 1}`), { envelope: true });
    if (b < 2) say(`Burst ${b + 1} is done; the next one follows.`);
  }
  // The flood: ONE terminal call whose result is 240 lines. Prose before it, so it is a burst of its own and the window
  // has exactly one call line to walk back to; prose after it, so the calls that follow do not join it.
  say("Now the flood: one command, two hundred and forty lines back.");
  call("terminal", "node tools/flood.js", out(BIG_LINES, "flood"), { envelope: true, dur: 0.5 });
  say("Two hundred and forty lines, of which the console shows the first forty and the note that folds the rest.");
  gate("g1");

  // The two bursts the reader will fold, each behind its own prose.
  say("A small burst to open, with GROUPBRAVO in its output.");
  call("terminal", "grep -rn GROUPBRAVO .", out(4, "GROUPBRAVO"), { envelope: true });
  call("read_file", "GROUPBRAVO.md", out(4, "GROUPBRAVO"));
  call("terminal", "grep -c GROUPBRAVO GROUPBRAVO.md", out(4, "GROUPBRAVO"), { envelope: true });
  say("And a second small burst, this one to close, with GROUPCHARLIE in it.");
  call("terminal", "grep -rn GROUPCHARLIE .", out(2, "GROUPCHARLIE"), { envelope: true });
  call("read_file", "GROUPCHARLIE.md", out(2, "GROUPCHARLIE"));
  gate("g2");

  // Exactly ten joblines, appended to the burst at the tail of the console (the one the reader just closed). Each joins
  // that group and re-cuts it, so the closed body is rebuilt ten times under the reader's choice.
  for (let i = 1; i <= 10; i++) {
    steps.push({ at: t, evt: { event: "tool.started", tool: "terminal", preview: `probe append ${i}` } });
    t += 130;
  }
  gate("g3");

  // Enough more work that a blind 300-line cut of the turn starts inside the flood's own results, then a deliverable
  // (its artifact changes conversationSignature → the page rebuilds the card and the window runs).
  for (let b = 0; b < 2; b++) {
    say(`Burst ${b + 1} of the later work, which puts the flood well above the window.`);
    for (let i = 0; i < 8; i++) call("terminal", `later ${b + 1}.${i + 1}: keep going`, out(12, `later${b + 1}x${i + 1}`), { envelope: true });
  }
  call("write_file", f("NOTES-1.md"), JSON.stringify({ resolved_path: f("NOTES-1.md"), bytes_written: 412 }));
  steps.push({ at: t + 200, evt: { event: "run.completed", output: "done", usage: { total_tokens: 4321, input_tokens: 4000, output_tokens: 321 } } });
  return steps;
}

// ---- the stub gateway: a Runs API that plays the script over real SSE, with gates --------------------------------
function makeGateway() {
  const state = { runs: new Map(), posts: 0, dir: "", gates: new Map(), released: [] };
  const timers = new Set();
  const later = (ms, fn) => {
    const h = setTimeout(() => {
      timers.delete(h);
      fn();
    }, ms);
    timers.add(h);
  };
  const awaitGate = (name) =>
    new Promise((resolve) => {
      if (state.released.includes(name)) return resolve();
      state.gates.set(name, () => {
        state.released.push(name);
        resolve();
      });
    });
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/ctl/state") return json(200, { pending: [...state.gates.keys()], released: state.released, runs: [...state.runs.keys()] });
    if (url.pathname === "/ctl/release" && req.method === "POST") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        let name = "";
        try {
          name = String(JSON.parse(raw || "{}").gate || "");
        } catch {
          /* a body that is not JSON names no gate */
        }
        const fn = state.gates.get(name);
        if (fn) {
          state.gates.delete(name);
          fn();
        }
        json(200, { released: name, ok: Boolean(fn) });
      });
      return;
    }
    if (url.pathname === "/v1/capabilities")
      return json(200, { version: "lane-a-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true } });
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      req.on("data", () => {});
      req.on("end", () => {
        state.posts += 1;
        const id = `run_lane_a_${state.posts}`;
        state.runs.set(id, { id, status: "running", output: "", script: buildScript(state.dir) });
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
      const from = Number(req.headers["last-event-id"] ?? url.searchParams.get("last_seq") ?? -1) + 1;
      let open = true;
      let prevAt = null;
      let i = -1;
      req.on("close", () => {
        open = false;
      });
      // One pump, so a gate stops the timeline instead of letting the rest of the segment arrive at once.
      void (async () => {
        for (const step of rec.script) {
          i += 1;
          if (i < from) {
            if (!step.gate) prevAt = step.at;
            continue;
          }
          if (!open) return;
          if (step.gate) {
            await awaitGate(step.gate);
            prevAt = null;
            if (!open) return;
            continue;
          }
          const delay = prevAt == null ? 30 : Math.max(0, step.at - prevAt);
          prevAt = step.at;
          if (delay) await new Promise((r) => later(delay, r));
          if (!open) return;
          res.write(`id: ${i}\ndata: ${JSON.stringify({ ...step.evt, run_id: rec.id, seq: i, timestamp: Date.now() / 1000 })}\n\n`);
          if (step.evt.event === "run.completed") {
            rec.status = "completed";
            rec.output = step.evt.output;
            later(60, () => res.end());
          }
        }
      })();
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-lane-a-"));
  const repo = path.join(dir, "repo");
  const logs = path.join(dir, "logs");
  mkdirSync(repo, { recursive: true });
  mkdirSync(logs, { recursive: true });
  mkdirSync(path.join(dir, "empty-root"), { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(repo, "README.md"), "# lane a probe repo\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "first"]);
  const now = Date.now();
  const finished = Array.from({ length: 3 }, (_, i) => ({
    id: `lane-seed-${i}`, thread: `lane-seed-thread-${i}`, turn: 1, status: "done",
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
    stop(keep) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      if (keep) return;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a handle may still be open on Windows */
      }
    },
  };
}

// ---- the page-side instrument ------------------------------------------------------------------------------------
// Runs before app.js. It records; it never changes what the page does.
function pageInit() {
  try {
    localStorage.setItem("wtgui.autoCollect", "0"); // a probe must never post a turn into a reader's thread
  } catch {
    /* storage may be unavailable */
  }
  const R = { t0: performance.now(), frames: [], rebuilds: [], bodyHiddenFlips: [], flatFlips: [], gstateFlips: [], groupSplices: [] };
  window.__rec = R;
  window.__errors = [];
  const now = () => Math.round((performance.now() - R.t0) * 10) / 10;
  const classOf = (el) => (el && (el.className || el.tagName)) || "?";
  // (4) The count this tool exists to keep at zero: an attribute change on a .tgrp-body or a .tgrp. A group whose state
  // changes by REPLACING the node never produces one of these.
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type !== "attributes" || !m.target || !m.target.matches) continue;
      const el = m.target;
      const rec = { t: now(), attr: m.attributeName, was: m.oldValue, now: el.getAttribute(m.attributeName), cls: classOf(el), gstate: el.dataset && el.dataset.gstate };
      if (el.matches(".tgrp-body") && m.attributeName === "hidden") R.bodyHiddenFlips.push(rec);
      else if (el.matches(".tgrp") && m.attributeName === "data-gflat") R.flatFlips.push(rec);
      else if (el.matches(".tgrp") && m.attributeName === "data-gstate") R.gstateFlips.push(rec);
    }
  }).observe(document, { attributes: true, attributeOldValue: true, attributeFilter: ["hidden", "data-gflat", "data-gstate"], subtree: true });
  // How often a .tgrp node itself is removed and another put in its place: the mechanism the fold is supposed to use.
  new MutationObserver((list) => {
    for (const m of list) {
      const added = [...(m.addedNodes || [])].filter((n) => n.nodeType === 1 && n.matches && n.matches(".tgrp"));
      const removed = [...(m.removedNodes || [])].filter((n) => n.nodeType === 1 && n.matches && n.matches(".tgrp"));
      if (added.length || removed.length) R.groupSplices.push({ t: now(), added: added.length, removed: removed.length, gstate: (added[0] && added[0].dataset.gstate) || (removed[0] && removed[0].dataset.gstate) || "" });
    }
  }).observe(document, { childList: true, subtree: true });
  window.addEventListener("error", (e) => window.__errors.push(String((e && e.message) || e)));
  // Every jobline frame the page drew, so "ten new joblines" is counted rather than assumed.
  window.__instrument = () => {
    const out = [];
    const wrap = (name, make) => {
      const o = window[name];
      if (typeof o !== "function" || o.__w) return false;
      const w = make(o);
      w.__w = true;
      window[name] = w;
      return true;
    };
    if (wrap("appendJobLine", (o) => function (...a) {
      const l = (a[0] && a[0].line) || {};
      R.frames.push({ t: now(), kind: l.kind || "", mode: l.mode || "", text: String(l.text || "").slice(0, 60) });
      return o.apply(this, a);
    })) out.push("appendJobLine");
    if (wrap("renderConversation", (o) => function (...a) {
      const sel = `.job[data-thread="${CSS.escape(String(a[0] || ""))}"]`;
      const before = document.querySelector(sel);
      const r = o.apply(this, a);
      const after = document.querySelector(sel);
      if (before && after && before !== after) R.rebuilds.push({ t: now(), rows: [...after.querySelectorAll("pre.job-out")].map((c) => c.querySelectorAll(".jl").length), groups: after.querySelectorAll(".tgrp").length });
      return r;
    })) out.push("renderConversation");
    return out;
  };
}

// ---- reading the console -----------------------------------------------------------------------------------------
// One snapshot of the turn's console: the window it is showing and every group in it, with the attributes the report is
// about. Only the head of each group travels, so a 300-row burst does not cross the bridge.
const SNAPSHOT = (thread) => {
  const job = [...state.jobs.values()].find((j) => j.thread === thread) || null;
  const out = job ? document.querySelector(`pre.job-out[data-out="${job.id}"]`) : null;
  if (!out) return { job: job ? job.id : null, out: false, status: job ? job.status : null };
  return {
    job: job.id, status: job.status, out: true,
    totalRows: out.querySelectorAll(".jl").length,
    children: out.children.length,
    firstChildText: out.firstElementChild ? String(out.firstElementChild.textContent || "").replace(/\s+/g, " ").slice(0, 60) : "",
    hasWait: Boolean(out.querySelector("[data-wait]")),
    groups: [...out.querySelectorAll(".tgrp")].map((g, i) => {
      const b = g.querySelector(".tgrp-body");
      const head = g.querySelector(".tgrp-head");
      return {
        i,
        gstate: g.dataset.gstate || "",
        gat: g.dataset.gat || "",
        gdefault: g.dataset.gdefault || "",
        gflat: g.dataset.gflat || "",
        filter: g.dataset.filter || "",
        hasHead: Boolean(head),
        headText: head ? String(head.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80) : "",
        headRows: head ? head.querySelectorAll(".tgrp-row").length : 0,
        trimmed: Boolean(head && head.querySelector(".tgrp-row-trimmed")),
        hasBody: Boolean(b),
        bodyHidden: b ? b.hidden : null,
        rows: g.querySelectorAll(".jl").length,
        bodyChars: b ? String(b.textContent || "").length : 0,
        firstBodyText: b && b.firstElementChild ? String(b.firstElementChild.textContent || "").replace(/\s+/g, " ").slice(0, 60) : "",
      };
    }),
  };
};

// The group whose own text carries a marker the burst's output was given. Found by reading the DOM's own groups rather
// than by an attribute selector, so the identity reported is the one the node actually carries.
const FIND_GROUP = ({ thread, marker }) => {
  const job = [...state.jobs.values()].find((j) => j.thread === thread) || null;
  const out = job ? document.querySelector(`pre.job-out[data-out="${job.id}"]`) : null;
  if (!out) return null;
  const hits = [...out.querySelectorAll(".tgrp")].filter((g) => String(g.textContent || "").includes(marker));
  const g = hits[hits.length - 1];
  if (!g) return null;
  const b = g.querySelector(".tgrp-body");
  return { gstate: g.dataset.gstate || "", gat: g.dataset.gat || "", rows: g.querySelectorAll(".jl").length, bodyHidden: b ? b.hidden : null, hasHead: Boolean(g.querySelector(".tgrp-head")), headText: String((g.querySelector(".tgrp-head") || {}).textContent || "").replace(/\s+/g, " ").trim().slice(0, 80) };
};

// The panel's own client buffer and its own window function: what a blind 300-line cut would do, and what it does.
const BUFFER = (thread) => {
  const j = [...state.jobs.values()].find((x) => x.thread === thread);
  if (!j) return null;
  const lines = (state.jobLines.get(j.id) || []).filter((l) => !isBookkeeping(l));
  const call = lines.findIndex((l) => l.kind === "tool" && /flood\.js/.test(String(l.text || "")));
  // The console's own fold note for that result: how many of its lines the panel did not draw.
  const after = call >= 0 ? lines.slice(call + 1, call + 60) : [];
  const note = after.map((l) => String(l.text || "")).find((t) => /lines hidden/.test(t)) || "";
  const w = windowLines(lines);
  return {
    total: lines.length,
    callIndex: call,
    callLid: call >= 0 ? String(lines[call].lid) : "",
    callText: call >= 0 ? String(lines[call].text || "") : "",
    foldNote: note,
    resultRowsDrawn: after.filter((l) => l.kind === "tool-out").length,
    blindStart: Math.max(0, lines.length - 300),
    windowLen: w.length,
    windowFirstKind: w[0] ? w[0].kind : "",
    windowFirstText: w[0] ? String(w[0].text || "").slice(0, 50) : "",
    callAtWindowHead: Boolean(call >= 0 && lines.length > 300 && w[0] === lines[call]),
    linesFromCall: call >= 0 ? lines.length - call : null,
  };
};

function sh(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

// ---- where the code under test is, by file:line ---------------------------------------------------------------
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
  const win = find(app, /^function windowLines/);
  const grp = find(app, /^function toolGroupHtml/);
  const trim = find(app, /^function trimmedGroupHtml/);
  const draw = find(app, /^function drawJobLine/);
  return {
    windowLines: win,
    windowWalk: win ? find(app, /while \(start > 0 && lines\[start\]\.kind === "tool-out"\)/, win - 1) : null,
    windowKeep: win ? find(app, /lines\.length - start <= max \* 2/, win - 1) : null,
    turnWindowConst: find(app, /^const TURN_WINDOW/),
    toolGroupHtml: grp,
    groupSaved: grp ? find(app, /const saved = flat \? null : state\.toolGroupOpen\.get\(gkey\)/, grp - 1) : null,
    groupBody: grp ? find(app, /<div class="tgrp-body"\$\{openBody \|\| filter/, grp - 1) : null,
    trimmedGroup: trim,
    trimmedBody: trim ? find(app, /<div class="tgrp-body"\$\{open \? "" : " hidden"\}/, trim - 1) : null,
    drawJobLine: draw,
    drawReplace: draw ? find(app, /openGroup\.replaceWith\(fresh\)/, draw - 1) : null,
    drawOpenState: draw ? find(app, /holder\.innerHTML = toolGroupHtml\(lines, key, filter, bodyEl \? !bodyEl\.hidden/, draw - 1) : null,
    rememberToolGroup: find(app, /^function rememberToolGroup/),
    stateKey: find(app, /^function toolGroupStateKey/),
    anchor: find(app, /^function toolGroupAnchor/),
  };
}

// ---- main --------------------------------------------------------------------------------------------------------
async function main() {
  const pw = loadPlaywright();
  if (!pw) {
    console.log("SKIP  playwright is not installed here (set PLAYWRIGHT_ROOT to a node_modules directory that has it)");
    process.exit(0);
  }
  mkdirSync(SHOT_DIR, { recursive: true });
  const result = {
    lane: "A", root: ROOT, commit: sh("git", ["rev-parse", "--short", "HEAD"], ROOT),
    dirty: sh("git", ["status", "--short", "--", "public", "lib", "server.js"], ROOT) !== "",
    at: new Date().toISOString(), refs: locate(ROOT), live: null, checks: [], counts: {}, shots: [], errors: [],
  };
  let failures = 0;
  const check = (name, got, want, extra = "", where = "") => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failures += 1;
    result.checks.push({ name, ok, got, want, where });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}${extra ? `\n        ${extra}` : ""}${!ok && where ? `\n        at   ${where}` : ""}`);
  };

  // The live panel, read only: it must be up, and it must be serving this same app.js, or "against 7331" means nothing.
  // Nothing is posted to it and nothing is written to its store.
  try {
    const health = await fetch(`${LIVE}/api/health`).then((r) => r.json());
    const liveApp = await fetch(`${LIVE}/app.js`).then((r) => r.text());
    const liveHash = createHash("sha256").update(liveApp).digest("hex");
    const localHash = createHash("sha256").update(readFileSync(path.join(ROOT, "public/app.js"), "utf8")).digest("hex");
    result.live = { url: LIVE, ok: Boolean(health.ok), panelVersion: health.settings?.version || "", liveAppHash: liveHash.slice(0, 16), localAppHash: localHash.slice(0, 16), sameBuild: liveHash === localHash, clients: health.clients };
  } catch (e) {
    result.live = { url: LIVE, ok: false, error: String(e.message || e) };
  }
  console.log(`live ${LIVE}: ${result.live.ok ? `up, panel version ${result.live.panelVersion || "?"}, app.js ${result.live.sameBuild ? "byte-identical to this checkout" : "DIFFERS"} (${result.live.liveAppHash} vs ${result.live.localAppHash})` : "unreachable"}`);

  const gw = makeGateway();
  const gwPort = await gw.listen();
  const sb = await startSandbox(gwPort);
  gw.state.dir = sb.repo;
  const browser = await pw.chromium.launch({ headless: true });
  const S = {};
  try {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 } });
    await ctx.addInitScript(pageInit);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => result.errors.push(String((e && e.message) || e)));
    const shot = async (name) => {
      const file = path.join(SHOT_DIR, name);
      await page.screenshot({ path: file });
      result.shots.push(path.basename(file));
      return path.basename(file);
    };
    // The harness only releases a gate the script has already reached: no step of the turn is ever skipped.
    const gateState = () => fetch(`http://127.0.0.1:${gwPort}/ctl/state`).then((r) => r.json());
    const waitPending = async (name, ms = 60000) => {
      const until = Date.now() + ms;
      for (;;) {
        const st = await gateState();
        if (st.pending.includes(name) || st.released.includes(name)) return st;
        if (Date.now() > until) throw new Error(`gate ${name} never became pending (pending: ${st.pending.join(",") || "none"})`);
        await sleep(80);
      }
    };
    const release = async (name, ms = 60000) => {
      await waitPending(name, ms);
      await fetch(`http://127.0.0.1:${gwPort}/ctl/release`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ gate: name }) });
      await sleep(60);
    };
    const snap = () => page.evaluate(SNAPSHOT, THREAD);
    const buf = () => page.evaluate(BUFFER, THREAD);
    const findGroup = (marker) =>
      page.evaluate(FIND_GROUP, { thread: THREAD, marker }).catch((e) => {
        console.log(`   findGroup(${marker}) threw: ${String(e.message || e).split("\n")[0]}`);
        return null;
      });
    const frameCount = () => page.evaluate(() => window.__rec.frames.length);
    const waitRebuild = async (n, ms = 30000) => {
      const until = Date.now() + ms;
      for (;;) {
        const got = await page.evaluate(() => window.__rec.rebuilds.length);
        if (got >= n) return got;
        if (Date.now() > until) return got;
        await sleep(100);
      }
    };
    const scrollTo = async (sel) => {
      await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: "center" }), sel);
      await sleep(180);
    };
    // Scroll a group into view by the marker its output carries, so nothing depends on the identity string being a
    // usable CSS attribute value.
    const scrollToGroup = async (marker) => {
      await page.evaluate(({ thread, marker }) => {
        const job = [...state.jobs.values()].find((j) => j.thread === thread);
        const out = job && document.querySelector(`pre.job-out[data-out="${job.id}"]`);
        const g = out && [...out.querySelectorAll(".tgrp")].filter((x) => String(x.textContent || "").includes(marker)).pop();
        if (g) g.scrollIntoView({ block: "center" });
      }, { thread: THREAD, marker });
      await sleep(180);
    };

    await page.goto(sb.base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.jobs && state.jobs.size >= 3, null, { timeout: 30000 });
    S.instrumented = await page.evaluate(() => window.__instrument());

    const spawned = await fetch(`${sb.base}/api/agents`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "lane A: one long turn", cwd: sb.repo, existing: true, thread: THREAD }),
    }).then((x) => x.json());
    if (!spawned || !spawned.job) throw new Error(`spawn failed: ${JSON.stringify(spawned)}`);
    S.job = spawned.job.id;
    await page.waitForSelector(`.job[data-thread="${THREAD}"] pre.job-out`, { timeout: 20000 });
    await page.waitForFunction(() => window.__rec.frames.length > 5, null, { timeout: 20000 });
    const cardSel = `.job[data-thread="${THREAD}"]`;

    // ---- segment 1: the earlier work, then the flood ------------------------------------------------------
    await waitPending("g1", 90000);
    const s0 = await snap();
    const b0 = await buf();
    console.log(`   after the flood: ${b0.total} console lines, flood call at index ${b0.callIndex} (lid ${b0.callLid}), live console ${s0.totalRows} rows in ${s0.groups.length} groups`);
    console.log(`   the turn is ${b0.total} lines at the flood; it grows past 450 before the window is measured`);
    check("preconditions: the flood's terminal call produced 200+ output lines", /^.{0,3}200 lines hidden/.test(b0.foldNote), true, `the panel's own fold note for that result: "${b0.foldNote}" (${b0.resultRowsDrawn} result rows drawn of ${BIG_LINES})`);
    const floodGroup0 = s0.groups.find((g) => g.gat === b0.callLid) || null;
    result.counts.foldNoteAtFlood = b0.foldNote;
    result.counts.floodRowsDrawn = b0.resultRowsDrawn;
    result.counts.floodRowsInGroup = floodGroup0 ? floodGroup0.rows : null;
    check("preconditions: the flood is a group of its own in the live console", Boolean(floodGroup0 && floodGroup0.rows >= 40), true, floodGroup0 ? `head "${floodGroup0.headText}", ${floodGroup0.rows} rows, first body row "${floodGroup0.firstBodyText.slice(0, 40)}"` : `groups: ${s0.groups.map((g) => g.gat).join(", ")}`);
    await scrollTo(cardSel);
    await shot("a0-flood-in-the-live-console.png");

    // ---- the two bursts the reader folds ------------------------------------------------------------------
    await release("g1");
    await waitPending("g2", 40000);
    await sleep(300);
    const sB = await snap();
    const all = sB.groups;
    const gB = await findGroup("GROUPBRAVO");
    const gC = await findGroup("GROUPCHARLIE");
    if (!gB || !gC) {
      console.log(`   groups at the click: ${JSON.stringify(all.map((g) => ({ i: g.i, gstate: g.gstate, gat: g.gat, head: g.headText, rows: g.rows, chars: g.bodyChars, first: g.firstBodyText.slice(0, 40) })), null, 1)}`);
      throw new Error(`could not find the two bursts by marker: bravo=${Boolean(gB)} charlie=${Boolean(gC)} groups=${all.length}`);
    }
    console.log(`   the reader's bursts: bravo gat ${gB.gat} (gstate "${gB.gstate}", ${gB.rows} rows), charlie gat ${gC.gat} (gstate "${gC.gstate}", ${gC.rows} rows)`);
    // A click on the group's own "N lines" button, found by the marker its output carries (the node is replaced by the
    // click, so it is looked up again every time).
    const clickMore = async (marker) => {
      const hit = await page.evaluate(({ thread, marker }) => {
        const job = [...state.jobs.values()].find((j) => j.thread === thread);
        const out = job && document.querySelector(`pre.job-out[data-out="${job.id}"]`);
        const g = out && [...out.querySelectorAll(".tgrp")].filter((x) => String(x.textContent || "").includes(marker)).pop();
        const b = g && g.querySelector("[data-tgrp-more]");
        if (b) b.click();
        return Boolean(b);
      }, { thread: THREAD, marker });
      await sleep(320);
      return hit;
    };
    await clickMore("GROUPBRAVO"); // open
    await clickMore("GROUPCHARLIE"); // open
    await clickMore("GROUPCHARLIE"); // then close: the reader's choice is now "closed"
    const sC = await snap();
    const bNow = sC.groups.find((g) => g.gstate === gB.gstate) || {};
    const cNow = sC.groups.find((g) => g.gstate === gC.gstate) || {};
    S.clicks = { bravo: gB, charlie: gC, after: { bravo: bNow, charlie: cNow } };
    console.log(`   reader: opened ${gB.gat} (body hidden=${bNow.bodyHidden}), closed ${gC.gat} (body hidden=${cNow.bodyHidden})`);
    check("preconditions: the reader's click opened the bravo burst", bNow.bodyHidden, false);
    check("preconditions: the reader's click closed the charlie burst", cNow.bodyHidden, true);
    await scrollToGroup("GROUPBRAVO");
    await shot("a-pre-open.png");

    // ---- assertions 2 and 3, live path: exactly ten new joblines ------------------------------------------
    const beforeTen = await frameCount();
    await release("g2");
    // The script parks at g3 once all ten appends are written; then wait for the page to stop drawing, so the count is
    // of what the console actually got rather than of what the socket had queued.
    await waitPending("g3", 40000);
    for (let i = 0, last = -1; ; i++) {
      const now = await frameCount();
      if (now === last) break;
      last = now;
      if (i > 60) break;
      await sleep(120);
    }
    const tenFrames = await page.evaluate((from) => window.__rec.frames.slice(from), beforeTen);
    const appends = tenFrames.filter((f) => f.kind === "tool" && /probe append/.test(f.text));
    const midFrames = tenFrames.length;
    const sTen = await snap();
    const bTen = sTen.groups.find((g) => g.gstate === gB.gstate) || {};
    const cTen = sTen.groups.find((g) => g.gstate === gC.gstate) || {};
    result.counts.joblinesDrawnBetweenChecks = midFrames;
    result.counts.joblinesAppended = appends.length;
    result.counts.tenFrameKinds = tenFrames.map((f) => f.kind).join(",");
    result.counts.tenFramesPreview = tenFrames.map((f) => `${f.kind}:${f.text.slice(0, 34)}`).join(" | ");
    console.log(`   after the click: ${midFrames} jobline frames drawn (${appends.length} of them the probe appends), kinds ${result.counts.tenFrameKinds}`);
    check("precondition: exactly ten new tool joblines were drawn", appends.length, 10, `drawn: ${appends.map((f) => f.text.slice(0, 22)).join(" / ")}`);
    check("(2) the group the reader opened is still open after ten new joblines", bTen.bodyHidden, false, `gstate ${gB.gstate}, ${bTen.rows} rows`);
    check("(3) the group the reader closed is still closed after ten new joblines", cTen.bodyHidden, true, `gstate ${gC.gstate}, ${cTen.rows} rows`);
    result.counts.charlieRowsAfterTen = cTen.rows;
    await scrollToGroup("GROUPBRAVO");
    await shot("a2-open-after-ten.png");
    await scrollToGroup("GROUPCHARLIE");
    await shot("a3-closed-after-ten.png");

    // ---- the repaint the deliverable forces, then the one the turn's end forces ---------------------------
    const rebuildsBefore = await page.evaluate(() => window.__rec.rebuilds.length);
    await release("g3");
    const rAfterDeliverable = await waitRebuild(rebuildsBefore + 1, 60000);
    await sleep(500);
    const bDel = await buf();
    const sDel = await snap();
    const floodDel = sDel.groups.find((g) => g.gat === bDel.callLid) || null;
    const bDelGroup = sDel.groups.find((g) => g.gstate === gB.gstate) || {};
    const cDelGroup = sDel.groups.find((g) => g.gstate === gC.gstate) || {};
    S.afterDeliverable = { buffer: bDel, snapshot: sDel, rebuilds: rAfterDeliverable };
    result.counts = { ...result.counts, bufferLinesAtRepaint: bDel.total, callLineIndex: bDel.callIndex, blindWindowStart: bDel.blindStart, windowLen: bDel.windowLen, windowFirst: `${bDel.windowFirstKind}: ${bDel.windowFirstText}`, callAtWindowHead: bDel.callAtWindowHead, linesFromCall: bDel.linesFromCall, rowsRendered: sDel.totalRows, groupsRendered: sDel.groups.length, rebuilds: rAfterDeliverable };
    console.log(`   repaint at ${bDel.total} lines: a blind 300-line cut starts at ${bDel.blindStart}, the flood's call is at ${bDel.callIndex}; windowLines renders ${bDel.windowLen} lines starting "${result.counts.windowFirst}"`);
    check("preconditions: the turn holds 450+ console lines", bDel.total >= 450, true, `${bDel.total} lines in the panel's own client buffer`);
    check("preconditions: the 300-line window has slid past the flood's call line", bDel.total > 300 && bDel.blindStart > bDel.callIndex, true, `blind cut at ${bDel.blindStart}, call line at ${bDel.callIndex}`);
    check("(1a) the flood's .tgrp still exists after that repaint", Boolean(floodDel), true, `groups: ${sDel.groups.map((g) => `${g.gat}${g.trimmed ? "(trimmed)" : ""}`).join(", ")}`);
    check("(1a) that .tgrp carries a head row", Boolean(floodDel && floodDel.hasHead && floodDel.headRows > 0), true, floodDel ? `head "${floodDel.headText}" (${floodDel.headRows} rows)` : "");
    check("(1a) that .tgrp carries data-gstate", Boolean(floodDel && floodDel.gstate), true, floodDel ? floodDel.gstate : "");
    check("(1a) that .tgrp carries data-gat, and it is the flood's call line identity", floodDel ? floodDel.gat : null, bDel.callLid, floodDel ? `data-gat "${floodDel.gat}" vs the call line's lid "${bDel.callLid}"` : "");
    check("(1a) the call line is the first row the window draws", Boolean(floodDel && floodDel.firstBodyText.includes("flood.js")), true, floodDel ? `first body row "${floodDel.firstBodyText}"` : "");
    check("(1a) the group still holds the flood's own result rows", Boolean(floodDel && floodDel.rows >= 40), true, floodDel ? `${floodDel.rows} rows` : "");
    check("(2a) the opened group is still open after that repaint", bDelGroup.bodyHidden, false, `${bDelGroup.rows} rows`);
    check("(3a) the closed group is still closed after that repaint", cDelGroup.bodyHidden, true, `${cDelGroup.rows} rows`);
    await scrollToGroup("node tools/flood.js");
    await shot("a1-window-slid.png");
    await scrollToGroup("GROUPBRAVO");
    await shot("a2a-open-after-repaint.png");
    await scrollToGroup("GROUPCHARLIE");
    await shot("a3a-closed-after-repaint.png");

    // The turn ends: the status change rebuilds the card once more, from a still longer transcript.
    const rFinal = await waitRebuild(rAfterDeliverable + 1, 45000);
    await page.waitForFunction((th) => [...state.jobs.values()].some((j) => j.thread === th && j.status === "done"), THREAD, { timeout: 60000 }).catch(() => {});
    await sleep(700);
    const bEnd = await buf();
    const sEnd = await snap();
    const floodEnd = sEnd.groups.find((g) => g.gat === bEnd.callLid) || null;
    const bEndGroup = sEnd.groups.find((g) => g.gstate === gB.gstate) || {};
    const cEndGroup = sEnd.groups.find((g) => g.gstate === gC.gstate) || {};
    const rec = await page.evaluate(() => ({ bodyHiddenFlips: window.__rec.bodyHiddenFlips, flatFlips: window.__rec.flatFlips, gstateFlips: window.__rec.gstateFlips, groupSplices: window.__rec.groupSplices.length, frames: window.__rec.frames.length, rebuilds: window.__rec.rebuilds.length, errors: window.__errors }));
    S.final = { buffer: bEnd, snapshot: sEnd, rebuilds: rFinal, rec };
    result.counts = { ...result.counts, bufferLinesAtEnd: bEnd.total, windowLenAtEnd: bEnd.windowLen, groupsAfterEnd: sEnd.groups.length, rebuildsTotal: rec.rebuilds, joblinesDrawn: rec.frames, groupNodeSplices: rec.groupSplices, bodyHiddenFlips: rec.bodyHiddenFlips.length, dataGflatFlips: rec.flatFlips.length, dataGstateFlips: rec.gstateFlips.length };
    check("(1b) the flood's .tgrp still exists after the turn ended and the card was rebuilt", Boolean(floodEnd), true, `groups: ${sEnd.groups.map((g) => g.gat).join(", ")}`);
    check("(1b) it still carries a head row and its data-gstate/data-gat", Boolean(floodEnd && floodEnd.hasHead && floodEnd.gstate && floodEnd.gat === bEnd.callLid), true, floodEnd ? `gstate "${floodEnd.gstate}", gat "${floodEnd.gat}", head "${floodEnd.headText}"` : "");
    check("(2b) the opened group is still open after the final repaint", bEndGroup.bodyHidden, false, `${bEndGroup.rows} rows`);
    check("(3b) the closed group is still closed after the final repaint", cEndGroup.bodyHidden, true, `${cEndGroup.rows} rows`);

    // ---- assertion 4: attribute changes on a .tgrp-body, counted across the whole run ---------------------
    check("(4) no .tgrp-body ever changes `hidden` in place", rec.bodyHiddenFlips.length, 0, rec.bodyHiddenFlips.slice(0, 3).map((f) => `@${f.t}ms ${f.cls} hidden ${f.was}->${f.now}`).join("; "));
    check("(4) no .tgrp ever changes data-gflat in place", rec.flatFlips.length, 0, rec.flatFlips.slice(0, 3).map((f) => `@${f.t}ms ${f.was}->${f.now}`).join("; "));
    check("(4) no .tgrp ever re-keys its data-gstate in place", rec.gstateFlips.length, 0, rec.gstateFlips.slice(0, 3).map((f) => `@${f.t}ms ${f.was}->${f.now}`).join("; "));
    check("(4) the fold really changed, and only by replacing the group node", rec.groupSplices > 0, true, `${rec.groupSplices} .tgrp node insert/remove splices across ${rec.frames} joblines and ${rec.rebuilds} card rebuilds`);
    check("no page errors", result.errors.length + rec.errors.length, 0, [...result.errors, ...rec.errors].slice(0, 3).join("; "));
    await scrollTo(cardSel);
    await shot("a4-console-at-the-end.png");
  } catch (e) {
    result.error = String((e && e.stack) || e);
    console.log(`ERROR ${result.error}`);
    failures += 1;
  } finally {
    await browser.close().catch(() => {});
    sb.stop(argv.includes("--keep"));
    await gw.close();
  }

  result.failures = failures;
  const json = path.join(REPORT_DIR, "playwright-lane-a.json");
  writeFileSync(json, JSON.stringify(result, null, 1));
  writeReport(result);
  console.log(`\n${failures ? "FAIL" : "PASS"}  ${result.checks.length - failures}/${result.checks.length} checks → ${json}`);
  console.log(`report → ${path.join(REPORT_DIR, "playwright-lane-a.md")}`);
  process.exit(failures ? 1 : 0);
}

// ---- the report --------------------------------------------------------------------------------------------------
function writeReport(result) {
  const c = result.counts || {};
  const refs = result.refs || {};
  const at = (k) => `public/app.js:${refs[k] ?? "?"}`;
  const L = [];
  const push = (...x) => L.push(...x);
  push(
    "# Lane A — a long turn's burst survives the console window, and a reader's fold survives the turn growing",
    "",
    `Tree \`wtgui/playwright-lane-a-long-t-7dbdfb\` at \`${result.commit}\`${result.dirty ? " (with local edits to product code!)" : ""}, captured ${String(result.at).slice(0, 19).replace("T", " ")} by \`node tools/verify-lane-a-burst.mjs\`. Every number below is read back from \`playwright-lane-a.json\` beside this file; screenshots are in \`playwright-lane-a/\`.`,
    "",
    "## Where the checks ran",
    "",
    `The live panel on ${result.live?.url || "http://127.0.0.1:7331"} was **read only to this harness**: \`/api/health\` and \`/app.js\` were fetched and nothing else — no post, no write to its logs store, no restart, no reuse of its port or config. It answered ${result.live?.ok ? `ok (panel version ${result.live.panelVersion || "unreported"}), and its \`app.js\` hashes to \`${result.live.liveAppHash}…\`, ${result.live.sameBuild ? "byte-identical to this checkout's" : "**which differs from this checkout's**"}` : "nothing"}.`,
    "",
    "The turn itself ran in a throwaway panel of the same build: its own `PANEL_CONFIG`, its own `jobs.json`, its own `HERMES_HOME`, an empty `API_SERVER_KEY`, a spare port — serving this checkout's `server.js` and `public/`. A stub Runs API played one scripted turn over real SSE, so every line the browser drew came through the panel's own `jobline` frames, and the card was spawned, folded and rebuilt through the panel's own routes, click handlers and render path.",
    "",
    "## The counts",
    "",
    `- the turn: **${c.bufferLinesAtRepaint ?? "?"}** console lines when the window was first measured, **${c.bufferLinesAtEnd ?? "?"}** when it ended`,
    `- the flood's call line sits at index **${c.callLineIndex ?? "?"}**; a blind 300-line cut of the ${c.bufferLinesAtRepaint ?? "?"}-line turn starts at **${c.blindWindowStart ?? "?"}**, i.e. ${(c.blindWindowStart ?? 0) - (c.callLineIndex ?? 0)} lines past the call`,
    `- the flood's result: **${BIG_LINES} lines**; the panel's own console kept **${c.floodRowsDrawn ?? "?"}** of them and wrote the fold note \`${c.foldNoteAtFlood || "?"}\` (its group is **${c.floodRowsInGroup ?? "?"}** rows)`,
    `- \`windowLines\` drew **${c.windowLen ?? "?"}** lines for that turn and the render produced **${c.groupsRendered ?? "?"}** groups; the first thing in the window is \`${c.windowFirst ?? "?"}\`, and the call line is the head of the window: **${c.callAtWindowHead ?? "?"}**`,
    `- rows in the console at that repaint: **${c.rowsRendered ?? "?"}**`,
    `- jobline frames drawn in the whole run: **${c.joblinesDrawn ?? "?"}**; between the reader's clicks and the next check: **${c.joblinesDrawnBetweenChecks ?? "?"}**, of which **${c.joblinesAppended ?? "?"}** are the ten probe appends (the rest are prose deltas from the burst written just before)`,
    `- card rebuilds observed: **${c.rebuildsTotal ?? "?"}**; \`.tgrp\` node insert/remove splices: **${c.groupNodeSplices ?? "?"}**`,
    `- \`.tgrp-body\` \`hidden\` attribute changes in place: **${c.bodyHiddenFlips ?? "?"}**; \`data-gflat\` changes: **${c.dataGflatFlips ?? "?"}**; \`data-gstate\` changes: **${c.dataGstateFlips ?? "?"}**`,
    "",
    "## Pass / fail",
    "",
    "| result | check | measured | expected | file:line of a failure |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const chk of result.checks) {
    push(`| ${chk.ok ? "PASS" : "FAIL"} | ${chk.name} | \`${JSON.stringify(chk.got)}\` | \`${JSON.stringify(chk.want)}\` | ${chk.ok ? "—" : chk.where || "see the note below"} |`);
  }
  push("", `**${result.checks.filter((x) => x.ok).length}/${result.checks.length} checks pass.**${result.error ? `\n\nThe run stopped early: \`${String(result.error).split("\n")[0]}\`` : ""}`, "");
  push(
    "## The mechanism these checks are about, and where it lives",
    "",
    `The console draws a window of the turn, not the whole of it: \`TURN_WINDOW\` is 300 (${at("turnWindowConst")}) and \`windowLines\` (${at("windowLines")}) cuts it on a burst's own boundary — it walks back over \`tool-out\` lines (${at("windowWalk")}) to the call that produced them, so a window that would have opened in the middle of a burst opens on its call line instead. A burst that fits a second window is kept whole (${at("windowKeep")}).`,
    `\`toolGroupHtml\` (${at("toolGroupHtml")}) draws that burst as a group with a head row and \`data-gstate\`/\`data-gat\`; a burst whose call line is gone from the buffer altogether is drawn by \`trimmedGroupHtml\` (${at("trimmedGroup")}) with a "trimmed" head row and the same identity (${at("trimmedBody")}).`,
    `The reader's fold is remembered under that identity (\`rememberToolGroup\`, ${at("rememberToolGroup")}; \`toolGroupStateKey\`, ${at("stateKey")}; anchor ${at("anchor")}), re-read at render time (${at("groupSaved")}), and the \`hidden\` attribute on a body is only ever written when the markup is BUILT (${at("groupBody")}). A live tool line joins the tail burst by re-cutting the group and \`replaceWith\`-ing the node (${at("drawJobLine")}, ${at("drawReplace")}), carrying the open state across as \`bodyEl ? !bodyEl.hidden\` (${at("drawOpenState")}) — which is why no attribute ever changes in place.`,
    "",
    "## Screenshots",
    "",
  );
  for (const [name, caption] of [
    ["a0-flood-in-the-live-console.png", "the flood as the live console drew it: one group, its head row, 40 result rows and the note that folds the other 200"],
    ["a-pre-open.png", "the burst the reader opens next, just before the click (its body still folded)"],
    ["a2-open-after-ten.png", "(2) the opened group, ten joblines after the click"],
    ["a3-closed-after-ten.png", "(3) the group the reader closed (it was opened first), the same ten joblines later"],
    ["a1-window-slid.png", `(1a) the same turn after a full repaint: the 300-line window now starts inside the flood's results, and the walk-back has put its call line at the head — the group is still there with its head row and identity (${c.rowsRendered ?? "?"} rows, ${c.groupsRendered ?? "?"} groups)`],
    ["a2a-open-after-repaint.png", "(2a) the opened group after that rebuild"],
    ["a3a-closed-after-repaint.png", "(3a) the closed group after that rebuild"],
    ["a4-console-at-the-end.png", `(4) the console at the end: the fold changed only by node replacement — ${c.bodyHiddenFlips ?? "?"} attribute changes on any .tgrp-body`],
  ]) {
    if (result.shots.includes(name)) push(`![${name}](${path.posix.join("playwright-lane-a", name)})`, `*${caption}*`, "");
  }
  push(
    "## Limits",
    "",
    "- The run is a scripted stub gateway, not a live Hermes agent. Everything between the stub and the browser is the panel's own code: `lib/jobs.js` turns the events into console lines, `/api/stream` carries them, `drawJobLine` draws them. Which tool is called, and what it returns, is scripted.",
    "- The turn is driven in the condensed console. The 🌊 one-stream card draws its groups flat (`data-gflat`, always open, no head row), so the fold assertions do not apply to it by design.",
    "- The reader's clicks are real clicks on `[data-tgrp-more]` through Playwright; the fold state they set is the page's own (`state.toolGroupOpen`), not an injected class.",
    "",
  );
  writeFileSync(path.join(REPORT_DIR, "playwright-lane-a.md"), L.join("\n"));
}

await main();
