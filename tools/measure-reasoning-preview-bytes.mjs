#!/usr/bin/env node
// What the live reasoning preview costs the reader's stream, measured the same way before and after a change.
//
// lib/jobs.js relays a gateway `reasoning.delta` as ONE growing 🧠 block (a stable `at`, cumulative text) and pushes a
// coalesced, non-persisted `jobline` frame every TEXT_FLUSH_MS (120 ms). Until this fix each of those frames carried
// the WHOLE block so far, so a 48 kB thought cost megabytes on the wire and the cost grew with the square of the
// block's length - the frame is the same block re-sent, nothing is new in it. This tool is the instrument for that
// claim: a sandbox panel of its own (own config, empty board, assistant off, gateway pointed at a stub that plays a
// scripted turn), one raw SSE reader, and every frame counted by type and by bytes.
//
//   node tools/measure-reasoning-preview-bytes.mjs --label before
//   node tools/measure-reasoning-preview-bytes.mjs --root <export> --label after
//
// --root       the checkout to boot (default: this one). Point it at a `git archive` export to measure a build you
//              have not changed; the board, the stub and the scripted turn are identical for both runs, which is what
//              makes the two numbers comparable.
// --label      names the JSON report (default: run)
// --out        where the JSON report goes (default: <scratch>/reasoning-preview-bytes-<label>.json)
// --block      chars of reasoning in the scripted block (default: 48000)
// --turn-ms    how long that block takes to stream (default: 30000)
// --timeout    how long to wait for the turn to settle (default: 120000)
//
// The turn is deliberately console-heavy: one long reasoning block with prose paragraphs and tool calls interleaved,
// which is the shape a real turn has and the shape whose stream cost the console pays. Nothing here is sampled or
// extrapolated: a frame's bytes are the exact bytes the panel wrote into the SSE stream.
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git, startPanel } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (n) => Math.round(n * 10) / 10;
const kb = (n) => r1(n / 1024);

const ROOT = path.resolve(opt("--root", path.join(HERE, "..")));
const LABEL = opt("--label", "run");
const BLOCK_CHARS = Number(opt("--block", "48000"));
const TURN_MS = Number(opt("--turn-ms", "30000"));
const TIMEOUT_MS = Number(opt("--timeout", "120000"));
const OUT = path.resolve(opt("--out", path.join(os.tmpdir(), "wag", `reasoning-preview-bytes-${LABEL}.json`)));
const SANDBOX = path.resolve(opt("--dir", path.join(os.tmpdir(), "wag", `reasoning-preview-${LABEL}`)));

// ---- the scripted turn ---------------------------------------------------------------------------------------------
// One block of reasoning, streamed in small deltas at a rate a big model actually thinks at, with prose and tool calls
// interleaved so the console is doing its normal work while the preview grows. The text is generated, not sampled, so
// both runs stream the identical bytes.
const SENTENCE = "The console has to show what the run is doing without re-reading what it already showed; a frame that carries the whole block again is the same words bought twice. ";
function reasoningText(chars) {
  let out = "";
  while (out.length < chars) out += SENTENCE;
  return out.slice(0, chars);
}

function scriptedTurn() {
  const script = [];
  let at = 300;
  const text = reasoningText(BLOCK_CHARS);
  // 64 chars a delta, one every 40 ms: ~1,600 chars/s, the rate a large model's reasoning arrives at.
  const STEP = 64;
  const GAP = 40;
  const slices = Math.ceil(text.length / STEP);
  const span = Math.max(1, TURN_MS - 600);
  const per = Math.max(GAP, Math.floor(span / slices));
  for (let i = 0; i < slices; i += 1) {
    script.push({ at, evt: { event: "reasoning.delta", delta: text.slice(i * STEP, (i + 1) * STEP) } });
    at += per;
  }
  // Prose and tool calls, placed inside the block's window: the console's own lines, which every turn carries.
  const proseAt = [2500, 7000, 12000, 17000, 22000, 27000];
  const para = "Paragraph: the console draws every line this turn writes, and the stream carries each one as its own frame.";
  for (const when of proseAt) {
    let p = when;
    for (let i = 0; i < para.length; i += 80) {
      script.push({ at: p, evt: { event: "message.delta", delta: `${i === 0 ? "\n\n" : ""}${para.slice(i, i + 80)}` } });
      p += 100;
    }
  }
  for (const when of [5000, 11000, 19000, 25000]) {
    script.push({ at: when, evt: { event: "tool.started", tool: "terminal", preview: "git status --short" } });
    script.push({ at: when + 380, evt: { event: "tool.completed", tool: "terminal", duration: 0.38, error: false, preview: "M public/board/console.js\n?? notes.md" } });
  }
  script.sort((a, b) => a.at - b.at);
  const end = Math.max(at, 28000) + 400;
  script.push({ at: end, evt: { event: "run.completed", output: "done", usage: { total_tokens: 10, input_tokens: 8, output_tokens: 2 } } });
  return { script, chars: text.length, end };
}

// ---- the stub Runs API: a scripted turn over real SSE ---------------------------------------------------------------
function stubGateway(script) {
  const state = { runs: new Map(), posts: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/v1/capabilities") {
      return json(200, { version: "reasoning-preview-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true } });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        state.posts += 1;
        const id = `run_stub_${state.posts}`;
        state.runs.set(id, { id, status: "running", output: "" });
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
      req.on("close", () => {
        open = false;
        for (const t of timers) clearTimeout(t);
      });
      return;
    }
    return json(404, { error: { message: `no such stub route: ${url.pathname}` } });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, state })));
}

// ---- one SSE reader: every frame, its name and its exact bytes ------------------------------------------------------
function attach(base) {
  const frames = [];
  let buf = "";
  const startedAt = Date.now();
  const url = new URL(`${base}/api/stream?shape=delta`);
  const req = http.get(url, { headers: { accept: "text/event-stream" } }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let name = "message";
        const data = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        const text = `${block}\n\n`;
        let think = null;
        try {
          const o = JSON.parse(data.join("\n"));
          const line = o && o.line;
          if (name === "jobline" && line && line.thinkOnly) think = { chars: String(line.think ?? "").length, from: Number(line.thinkFrom ?? 0) || 0, at: line.at ?? null };
        } catch {
          /* a comment or a keep-alive: counted by type only */
        }
        frames.push({ at: Date.now() - startedAt, name, bytes: Buffer.byteLength(text, "utf8"), think });
      }
    });
  });
  req.on("error", () => {});
  return { frames, req, startedAt, url: url.href };
}

function summarise(client, seconds, turnChars) {
  const byType = new Map();
  const think = { frames: 0, bytes: 0, maxBytes: 0, charsSent: 0, wholeBlocks: 0, deltas: 0 };
  let total = 0;
  for (const f of client.frames) {
    total += f.bytes;
    const rec = byType.get(f.name) || { frames: 0, bytes: 0, max: 0 };
    rec.frames += 1;
    rec.bytes += f.bytes;
    rec.max = Math.max(rec.max, f.bytes);
    byType.set(f.name, rec);
    if (f.think) {
      think.frames += 1;
      think.bytes += f.bytes;
      think.maxBytes = Math.max(think.maxBytes, f.bytes);
      think.charsSent += f.think.chars;
      // A frame that starts at offset 0 and carries the block is the whole block re-sent; a frame with thinkFrom > 0
      // is an append. This split is what the change moves, so it is measured rather than described.
      if (f.think.from === 0 && f.think.chars > 0) think.wholeBlocks += 1;
      else if (f.think.chars > 0) think.deltas += 1;
    }
  }
  const jobline = byType.get("jobline") || { frames: 0, bytes: 0, max: 0 };
  return {
    seconds,
    frames: client.frames.length,
    framesPerSecond: Number((client.frames.length / Math.max(0.001, seconds)).toFixed(2)),
    totalBytes: total,
    totalKb: kb(total),
    bytesPerSecond: Math.round(total / Math.max(0.001, seconds)),
    frameTypes: [...byType.entries()]
      .map(([name, rec]) => ({ type: name, frames: rec.frames, bytes: rec.bytes, kb: kb(rec.bytes), kbPerFrame: r1(rec.bytes / rec.frames / 1024), maxKb: kb(rec.max) }))
      .sort((a, b) => b.bytes - a.bytes),
    jobline: { frames: jobline.frames, bytes: jobline.bytes, kb: kb(jobline.bytes) },
    reasoningPreview: {
      frames: think.frames,
      bytes: think.bytes,
      kb: kb(think.bytes),
      meanBytes: think.frames ? Math.round(think.bytes / think.frames) : 0,
      maxBytes: think.maxBytes,
      maxKb: kb(think.maxBytes),
      // The text itself is BLOCK_CHARS on both runs; these two say how much of it crossed the wire.
      blockChars: turnChars,
      charsSent: think.charsSent,
      charsPerBlockChar: turnChars ? Number((think.charsSent / turnChars).toFixed(2)) : null,
      wholeBlockFrames: think.wholeBlocks,
      deltaFrames: think.deltas,
      shareOfStreamPercent: total ? Number(((think.bytes / total) * 100).toFixed(1)) : 0,
    },
    consoleLines: { frames: jobline.frames - think.frames, bytes: jobline.bytes - think.bytes, kb: kb(jobline.bytes - think.bytes) },
  };
}

async function waitForBoot(base, timeoutMs = 240_000) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const r = await fetch(`${base}/api/state`);
      if (r.ok) {
        const snap = await r.json();
        last = { projects: (snap.projects || []).length, rows: (snap.projects || []).reduce((n, p) => n + (p.worktrees || []).length, 0) };
        // An empty board is this harness's board: the panel is up when /api/state answers at all.
        if (last.projects >= 0) return { ...last, tookMs: Date.now() - startedAt };
      }
    } catch {
      /* the port is not up yet */
    }
    await sleep(250);
  }
  throw new Error(`the sandbox never answered /api/state (last seen: ${JSON.stringify(last)})`);
}

const LIVE = new Set(["running", "starting", "waiting", "waiting_for_approval", "queued"]);

async function waitForTurn(base, jobId) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < TIMEOUT_MS) {
    try {
      const snap = await fetch(`${base}/api/state`).then((r) => r.json());
      const job = (snap.jobs || []).find((j) => j.id === jobId);
      last = job ? { status: job.status, lines: (job.lines || []).length } : null;
      if (job && !LIVE.has(String(job.status || ""))) return { ...last, tookMs: Date.now() - startedAt };
    } catch {
      /* a state read that fails is retried inside the budget */
    }
    await sleep(250);
  }
  throw new Error(`the scripted turn never settled (last seen: ${JSON.stringify(last)})`);
}

const main = async () => {
  mkdirSync(SANDBOX, { recursive: true });
  const { script, chars, end } = scriptedTurn();
  const gw = await stubGateway(script);
  const started = await startPanel({
    root: ROOT,
    dir: SANDBOX,
    keep: false,
    config: {
      host: "127.0.0.1",
      scanRoots: [],
      projects: [],
      threads: 1,
      assistant: { enabled: false },
      apiServer: { url: `http://127.0.0.1:${gw.port}`, key: "stub" },
      remoteBranchPolicy: "local-only",
    },
  });
  const base = started.base;
  await waitForBoot(base);
  const client = attach(base);
  await sleep(600);

  // The run is the vehicle for one live console. The cwd is a directory that exists and is its own git tree: the
  // sandbox itself is not a repo, so this makes one, which keeps the run's spawn checks honest.
  const cwd = path.join(SANDBOX, "turn");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(path.join(cwd, "README.md"), "the sandbox turn runs here\n", "utf8");
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "sandbox turn");
  const run = await fetch(`${base}/api/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "measure the reasoning preview", cwd, existing: true, thread: `measure-${LABEL}` }),
  });
  const body = await run.json().catch(() => ({}));
  if (!run.ok) {
    throw new Error(`the sandbox refused the scripted run (HTTP ${run.status}): ${JSON.stringify(body)}\n${started.log().split("\n").slice(-25).join("\n")}`);
  }
  const jobId = body.job && body.job.id;
  const settled = await waitForTurn(base, jobId);
  await sleep(800); // the settle frames (result line, job summary) belong to the turn's cost
  const seconds = (Date.now() - client.startedAt) / 1000;
  const out = summarise(client, seconds, chars);

  client.req.destroy();
  const report = {
    label: LABEL,
    root: ROOT,
    sandbox: SANDBOX,
    turn: { blockChars: chars, turnMs: TURN_MS, scriptedEndMs: end, events: script.length, settled },
    stub: { port: gw.port, posts: gw.state.posts, runId: jobId },
    ...out,
    at: new Date().toISOString(),
  };
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 1), "utf8");

  // A build that relays no reasoning preview at all would measure a beautiful zero, so the harness refuses to call
  // that a result: the preview frames are the subject, and none of them is a harness failure, not a win.
  const shown = {
    out: OUT,
    label: LABEL,
    seconds: Number(seconds.toFixed(1)),
    frames: out.frames,
    totalBytes: out.totalBytes,
    jobline: out.jobline,
    reasoningPreview: out.reasoningPreview,
    consoleLines: out.consoleLines,
  };
  console.log(JSON.stringify(shown, null, 1));
  await started.stop();
  gw.server.close();
  if (out.reasoningPreview.frames === 0) {
    console.error("no reasoning preview frame arrived: the harness measured nothing about its subject");
    process.exit(2);
  }
};

main().catch((e) => {
  console.error(String((e && e.stack) || e));
  process.exit(1);
});
