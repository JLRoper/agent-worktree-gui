#!/usr/bin/env node
// What the browser stream costs a reader, measured the same way before and after a change.
//
// Row 256: the stream pushed a full snapshot on every attach and after every write, so a board of 185 projects paid
// ~6.4 MB to open a tab and 4.29 MB per write, most of it rows and job transcripts the tab already had. This tool is
// the instrument for that claim: it boots a sandbox panel of its own (own config, own state copy, assistant off,
// gateway pointed at a stub that plays a scripted turn), attaches the two stream shapes the panel serves, and counts
// bytes by frame type, the frame rate, which frames carry a full state, and - for the console - how many `jobline`
// frames a live run produced and when.
//
//   node tools/measure-stream-bytes.mjs --root <checkout> --label before
//   node tools/measure-stream-bytes.mjs --root <checkout> --label after  --writes
//
// --root      the checkout to boot (default: this one). Point it at a `git archive` export to measure a build you
//             have not changed; the board and the state copy are the same for both, which is what makes the two
//             numbers comparable.
// --live      the panel whose state is copied in (default: ~/.wag/state). Read-only: the copy is what the sandbox
//             writes. Running jobs are left out of the copy on purpose - their records carry the live panel's pids,
//             and a sandbox must never be able to settle (and kill) a run that is not its own.
// --live-config  the config the projects/scanRoots come from (default: <this checkout>/config.json).
// --seconds   the measuring window (default 30).
// --writes    after the window, make ONE todo edit through the panel's own route and report the frames it caused.
// --out       where the JSON report goes (default: <scratch>/stream-bytes-<label>.json).
//
// Nothing here touches the live panel: the sandbox binds its own port, reads a copy of the state, and its gateway is
// a stub on another free port. The projects it scans are the real ones (read-only git), so the board is the real
// board - the same 185 projects, rows, todos and collisions the reader's panel has.
import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { startPanel, ROOT as TOOL_ROOT } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const flag = (name) => argv.includes(name);

const ROOT = path.resolve(opt("--root", path.join(HERE, "..")));
const LIVE_STATE = path.resolve(opt("--live", path.join(os.homedir(), ".wag", "state")));
const LIVE_CONFIG = path.resolve(opt("--live-config", path.join(TOOL_ROOT, "config.json")));
const SECONDS = Number(opt("--seconds", "30"));
const LABEL = opt("--label", "run");
const OUT = path.resolve(opt("--out", path.join(os.tmpdir(), "wag", `stream-bytes-${LABEL}.json`)));
const SANDBOX = path.resolve(opt("--dir", path.join(os.tmpdir(), "wag", `stream-bytes-${LABEL}`)));
const DO_WRITES = flag("--writes");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (n) => Math.round(n * 10) / 10;

// The state files worth copying: the panes the board draws (todos, collisions, reviews, descriptions, names,
// initiatives, waves, locks, deliverables) and the job records. Not restart.json or the watcher records - those are
// instructions to the panel that owns them, and a sandbox must not act on them.
const STATE_FILES = [
  "jobs.json",
  "todos.json",
  "collisions.json",
  "reviews.json",
  "descriptions.json",
  "tree-names.json",
  "labels.json",
  "initiatives.json",
  "waves.json",
  "locks.json",
  "deliverables.json",
  "clarify-history.json",
  "parents.json",
  "branch-parents.json",
  "hosts.json",
  "projects.json",
  "tree-cache.json",
  "thread-models.json",
  "model-prices.json",
];

// ---- the stub Runs API: a scripted turn over real SSE -------------------------------------------------------------
// Only what lib/jobs.js asks of a gateway: capabilities, submit, one run, and its event stream. The turn is prose and
// a couple of tool calls, because those are the events that become `jobline` frames - the console's own lines.
function stubGateway() {
  const state = { runs: new Map(), posts: 0 };
  const script = [];
  let at = 200;
  const say = (text, per = 140) => {
    const words = text.split(" ");
    for (let i = 0; i < words.length; i += 3) {
      script.push({ at, evt: { event: "message.delta", delta: `${i === 0 ? "\n\n" : ""}${words.slice(i, i + 3).join(" ")} ` } });
      at += per;
    }
    at += 180;
  };
  const call = (tool, preview, result) => {
    script.push({ at, evt: { event: "tool.started", tool, preview } });
    at += 380;
    script.push({ at, evt: { event: "tool.completed", tool, duration: 0.38, error: false, preview: result } });
    at += 200;
  };
  // ~25 s of output: one line every ~140 ms, which is the rate a real turn writes at.
  for (let para = 0; para < 8; para += 1) {
    say(`Paragraph ${para + 1}: the console draws every line this turn writes, and the stream carries each one as its own jobline frame. Nothing here is throttled or coalesced.`, 140);
    call("terminal", "git status --short", "M public/app.js\n?? notes.md");
  }
  script.push({ at: at + 200, evt: { event: "run.completed", output: "done", usage: { total_tokens: 10, input_tokens: 8, output_tokens: 2 } } });
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/v1/capabilities") {
      return json(200, { version: "stream-bytes-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true } });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        state.posts += 1;
        const id = `run_stub_${state.posts}`;
        state.runs.set(id, { id, status: "running", output: "", startedAt: null });
        json(200, { run_id: id, status: "running" });
      });
      return;
    }
    const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const rec = state.runs.get(one[1]);
      if (!rec) return json(404, { error: { message: "Run not found", code: "run_not_found" } });
      return json(200, { run_id: rec.id, status: rec.status, output: rec.output, usage: { total_tokens: 10, input_tokens: 8, output_tokens: 2 } });
    }
    const ev = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (ev && req.method === "GET") {
      const rec = state.runs.get(ev[1]);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      if (!rec) return res.end();
      res.write(": open\n\n");
      const from = Number(req.headers["last-event-id"] ?? url.searchParams.get("last_seq") ?? -1) + 1;
      const t0 = Date.now();
      let open = true;
      req.on("close", () => {
        open = false;
      });
      const timers = [];
      for (let i = Math.max(0, from); i < script.length; i += 1) {
        const step = script[i];
        timers.push(
          setTimeout(() => {
            if (!open) return;
            res.write(`id: ${i}\ndata: ${JSON.stringify({ ...step.evt, run_id: rec.id, seq: i, timestamp: Date.now() / 1000 })}\n\n`);
            if (step.evt.event === "run.completed") {
              rec.status = "completed";
              rec.output = step.evt.output;
              setTimeout(() => res.end(), 40);
            }
          }, Math.max(0, step.at - (Date.now() - t0))),
        );
      }
      const stop = setInterval(() => {}, 1000);
      req.on("close", () => {
        for (const t of timers) clearTimeout(t);
        clearInterval(stop);
      });
      return;
    }
    return json(404, { error: { message: `no such stub route: ${url.pathname}` } });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, state })));
}

// ---- one SSE reader, counted by frame ----------------------------------------------------------------------------
function attach(base, shape) {
  const frames = [];
  const chunks = [];
  let buf = "";
  const startedAt = Date.now();
  const url = new URL(`${base}/api/stream${shape === "delta" ? "?shape=delta" : ""}`);
  const req = http.get(url, { headers: { accept: "text/event-stream" } }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      chunks.push(chunk);
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = block.split("\n");
        let name = "message";
        const data = [];
        for (const line of lines) {
          if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        const text = block + "\n\n";
        let delta = false;
        let projects = 0;
        let rows = 0;
        let keys = null;
        try {
          const o = JSON.parse(data.join("\n"));
          const d = o && o.data !== undefined && o.type ? o.data : o;
          delta = Boolean(o && o.delta) || Boolean(d && d.delta);
          const list = Array.isArray(d && d.projects) ? d.projects : [];
          projects = list.length;
          rows = list.reduce((n, p) => n + (Array.isArray(p.worktrees) ? p.worktrees.length : 0), 0) + (Array.isArray(d && d.rows) ? d.rows.length : 0);
          if (name === "snapshot" || name === "board") {
            keys = Object.keys(d || {})
              .map((k) => ({ k, kb: r1(Buffer.byteLength(JSON.stringify(d[k]), "utf8") / 1024) }))
              .sort((a, b) => b.kb - a.kb)
              .slice(0, 8);
          }
        } catch {
          /* not JSON: a comment or a keep-alive, counted by type only */
        }
        frames.push({ at: Date.now() - startedAt, name, bytes: Buffer.byteLength(text, "utf8"), delta, projects, rows, keys });
      }
    });
  });
  req.on("error", () => {});
  return { frames, chunks, req, startedAt, shape, url: url.href };
}

function summarise(client, seconds) {
  const byType = new Map();
  let total = 0;
  let fullFrames = 0;
  for (const f of client.frames) {
    total += f.bytes;
    const rec = byType.get(f.name) || { frames: 0, bytes: 0, max: 0, full: 0, delta: 0 };
    rec.frames += 1;
    rec.bytes += f.bytes;
    rec.max = Math.max(rec.max, f.bytes);
    if (f.name === "snapshot" || f.name === "board") {
      if (f.delta) rec.delta += 1;
      else {
        rec.full += 1;
        fullFrames += 1;
      }
    }
    byType.set(f.name, rec);
  }
  return {
    shape: client.shape,
    seconds,
    totalBytes: total,
    bytesPerSecond: Math.round(total / Math.max(0.001, seconds)),
    frames: client.frames.length,
    framesPerSecond: Number((client.frames.length / Math.max(0.001, seconds)).toFixed(2)),
    fullStateFrames: fullFrames,
    // The two frames a connection opens with, named: what they were and what was in them.
    openingFrames: client.frames
      .filter((f) => f.name === "board" || f.name === "snapshot")
      .map((f) => ({ type: f.name, delta: f.delta, bytes: f.bytes, projects: f.projects, rows: f.rows, keys: f.keys })),
    frameTypes: [...byType.entries()]
      .map(([name, rec]) => ({
        type: name,
        frames: rec.frames,
        bytes: rec.bytes,
        kbPerFrame: r1(rec.bytes / rec.frames / 1024),
        maxKb: r1(rec.max / 1024),
        fullFrames: rec.full,
        deltaFrames: rec.delta,
      }))
      .sort((a, b) => b.bytes - a.bytes),
    // The console's own lines: one frame per line the run wrote, never coalesced or throttled.
    joblines: {
      frames: (byType.get("jobline") || { frames: 0 }).frames,
      bytes: (byType.get("jobline") || { bytes: 0 }).bytes,
      perSecond: Number((((byType.get("jobline") || { frames: 0 }).frames) / Math.max(0.001, seconds)).toFixed(2)),
    },
  };
}

// ---- the sandbox ---------------------------------------------------------------------------------------------------
function readLiveConfig() {
  const raw = JSON.parse(readFileSync(LIVE_CONFIG, "utf8"));
  return raw;
}

function seedState(dir) {
  const logs = path.join(dir, "logs");
  mkdirSync(logs, { recursive: true });
  const copied = [];
  for (const name of STATE_FILES) {
    const from = path.join(LIVE_STATE, name);
    if (!existsSync(from)) continue;
    if (name === "jobs.json") {
      // Running records carry the LIVE panel's pids and run ids. A sandbox that adopted one could settle it and kill a
      // run that is not its own, so only the settled records travel.
      const store = JSON.parse(readFileSync(from, "utf8"));
      const jobs = (store.jobs || []).filter((j) => j && j.status !== "running");
      writeFileSync(path.join(logs, name), JSON.stringify({ ...store, jobs, nextId: store.nextId }, null, 1), "utf8");
    } else {
      copyFileSync(from, path.join(logs, name));
    }
    copied.push(name);
  }
  return copied;
}

async function waitForBoot(base, timeoutMs = 240_000) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const r = await fetch(`${base}/api/state`);
      if (r.ok) {
        const snap = await r.json();
        const projects = (snap.projects || []).length;
        const rows = (snap.projects || []).reduce((n, p) => n + (p.worktrees || []).length, 0);
        const complete = Boolean(snap.treeList && snap.treeList.completedAt);
        last = { projects, rows, complete };
        if (projects > 0 && rows > 0 && complete) return { ...last, tookMs: Date.now() - startedAt };
      }
    } catch {
      /* the port is not up yet */
    }
    await sleep(1000);
  }
  throw new Error(`the sandbox never finished its first pass (last seen: ${JSON.stringify(last)})`);
}

const main = async () => {
  mkdirSync(SANDBOX, { recursive: true });
  const live = readLiveConfig();
  const gw = await stubGateway();
  const copied = seedState(SANDBOX);
  const started = await startPanel({
    root: ROOT,
    dir: SANDBOX,
    keep: true,
    reuseConfig: true,
    config: {
      host: "127.0.0.1",
      scanRoots: live.scanRoots,
      projects: live.projects,
      threads: 2,
      // The scans are slowed down on purpose: this measures the STREAM, and a board being re-read every 60 s buries
      // the two frames under a scan's row churn, which is the same on both builds and would only add noise to the
      // comparison. The board is the same board; it is just not being rewritten while the window runs.
      worktreeSeconds: 600,
      midSeconds: 900,
      dormantSeconds: 1200,
      slowSeconds: 1800,
      refreshSeconds: 600,
      fetchSeconds: 7200,
      prCacheSeconds: 3600,
      remoteCacheSeconds: 3600,
      assistant: { enabled: false },
      apiServer: { url: `http://127.0.0.1:${gw.port}`, key: "stub" },
      remoteBranchPolicy: "local-only",
      defaultCwd: live.defaultCwd,
    },
  });
  const base = started.base;
  const boot = await waitForBoot(base);
  const panel = await fetch(`${base}/api/state`).then((r) => r.json());
  const board = {
    projects: (panel.projects || []).length,
    rows: (panel.projects || []).reduce((n, p) => n + (p.worktrees || []).length, 0),
    jobs: (panel.jobs || []).length,
    todos: (panel.projects || []).reduce((n, p) => n + (p.worktrees || []).filter((w) => w.todo && (w.todo.items || []).length).length, 0),
    stateBytes: Buffer.byteLength(JSON.stringify(panel), "utf8"),
    boardBytes: Buffer.byteLength(JSON.stringify(await fetch(`${base}/api/board`).then((r) => r.json())), "utf8"),
  };

  // Both shapes at once, on the same board, in the same second: the classic reader is what an old tab asks for, the
  // lean one what this build's page asks for.
  const classic = attach(base, "full");
  const lean = attach(base, "delta");
  await sleep(1500);

  // A live console: one scripted turn through the stub, which the panel turns into jobline frames.
  // A cwd the board knows and that exists: the run is only a vehicle for a live console, and its card is filed on the
  // row that owns that tree. `heroes-js` (the live config's defaultCwd) is gone from this machine, so the first
  // project whose checkout is still there is used instead.
  const cwd = (panel.projects || []).map((p) => p.path).find((p) => p && existsSync(p)) || ROOT;
  const run = await fetch(`${base}/api/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "measure the stream", cwd, existing: true, thread: `measure-${LABEL}` }),
  });
  const runBody = await run.json().catch(() => ({}));
  if (!run.ok) {
    // A sandbox whose run never started has no console to measure, so say why instead of reporting zero lines.
    throw new Error(`the sandbox refused the scripted run (HTTP ${run.status}): ${JSON.stringify(runBody)}\n${started.log().split("\n").slice(-25).join("\n")}`);
  }

  // The window. Frames are counted as they arrive; nothing is sampled or extrapolated.
  await sleep(SECONDS * 1000);

  const classicOut = summarise(classic, SECONDS);
  const leanOut = summarise(lean, SECONDS);

  // ONE write, through the panel's own route, measured the same way on both shapes: this is the push a todo edit
  // causes. The row is the first one the board carries a todo item for, so the write changes a real row.
  let write = null;
  if (DO_WRITES) {
    const target = (panel.projects || [])
      .flatMap((p) => (p.worktrees || []).map((w) => ({ project: p.name, row: w })))
      .find((x) => x.row.todo && (x.row.todo.items || []).length);
    if (target) {
      const before = { classic: classic.chunks.length, lean: lean.chunks.length };
      const beforeBytes = { classic: classicOut.totalBytes, lean: leanOut.totalBytes };
      const item = target.row.todo.items[0];
      const res = await fetch(`${base}/api/todos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "note", project: target.project, path: target.row.path, id: item.id, note: "measured by tools/measure-stream-bytes.mjs" }),
      });
      const answer = await res.json().catch(() => ({}));
      await sleep(1200);
      const framesAfter = (c) => c.frames.filter((f) => f.at > SECONDS * 1000);
      const pick = (c) => {
        const after = framesAfter(c);
        const snapshot = after.find((f) => f.name === "snapshot") || null;
        return {
          frames: after.map((f) => `${f.name}${f.delta ? "-delta" : ""}:${f.bytes}`),
          bytes: after.reduce((n, f) => n + f.bytes, 0),
          snapshot: snapshot ? { delta: snapshot.delta, bytes: snapshot.bytes, rows: snapshot.rows, keys: snapshot.keys } : null,
        };
      };
      write = {
        route: "POST /api/todos {op:note}",
        ok: Boolean(answer.ok),
        row: `${target.project} ${target.row.path}`,
        item: item.id,
        classic: pick(classic),
        lean: pick(lean),
        snapshotsBefore: before,
        bytesBefore: beforeBytes,
      };
    }
  }

  classic.req.destroy();
  lean.req.destroy();
  const report = {
    label: LABEL,
    root: ROOT,
    sandbox: SANDBOX,
    seconds: SECONDS,
    boot,
    board,
    copiedState: copied,
    stub: { port: gw.port, posts: gw.state.posts, runId: runBody && runBody.job ? runBody.job.id : null },
    classic: classicOut,
    lean: leanOut,
    write,
    at: new Date().toISOString(),
  };
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 1), "utf8");
  console.log(JSON.stringify({ out: OUT, board, classic: { total: classicOut.totalBytes, bps: classicOut.bytesPerSecond, frames: classicOut.frames, full: classicOut.fullStateFrames, joblines: classicOut.joblines }, lean: { total: leanOut.totalBytes, bps: leanOut.bytesPerSecond, frames: leanOut.frames, full: leanOut.fullStateFrames, joblines: leanOut.joblines }, write }, null, 1));
  await started.stop();
  gw.server.close();
};

main().catch((e) => {
  console.error(String((e && e.stack) || e));
  process.exit(1);
});
