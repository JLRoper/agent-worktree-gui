#!/usr/bin/env node
// READ-ONLY round trip on the panel's CARD PATH: does an answered clarify card's answer land on the thread that
// asked, and does the queue row that asked still settle?
//
//   node tools/verify-clarify-answer-reuse.mjs
//
// Read-only in the two senses that matter: it never writes to the real board (every file lives in a fresh temp
// directory under the scratch root and is removed at the end) and it never starts a real run (the Runs API is a
// loopback stub, so `POST /v1/runs` is answered by this file, not by the gateway). Nothing here restarts the panel
// or the gateway, and no other assistant's queue row is read or written.
//
// What it drives is the shipped path, not a copy of it: routes/jobs.js mounted with its own transport helpers, the
// real Jobs store, the real Assistant, and a POST to /api/jobs/answer with the panel token - the same request the
// card's Answer button makes.
//
// It prints the thread id and the run id it saw, and exits 1 when the answer did not continue the asking thread, so
// it is its own before/after: run it on a tree that does not carry the change and the answer comes back
// `undelivered` with no answering turn at all.
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Assistant } from "../lib/assistant.js";
import { settleTasks } from "../lib/assistant/queue.js";
import { Jobs } from "../lib/jobs.js";
import { createJobsRoutes } from "../routes/jobs.js";

const run = promisify(execFile);
const QUESTION = "Which comment do you want posted on the ticket?";
const PROMPT_ID = "p-verify-1";
const ASKING_THREAD = "wtgui-verify-the-asking-thread";
const TOKEN = "verify-token";
// The scratch root comes from the environment or from the OS, never from a path typed into this file: a
// drive-letter path exists on one machine only (test/absolute-paths.test.js is the gate).
const SCRATCH_ROOT = process.env.WAG_SCRATCH || path.join(os.tmpdir(), "wag-clarify-answer-reuse");

const say = (line = "") => console.log(line);
const fail = [];
const check = (ok, claim, detail) => {
  if (ok) say(`  ok   ${claim}`);
  else {
    say(`  FAIL ${claim}${detail ? ` (${detail})` : ""}`);
    fail.push(claim);
  }
  return ok;
};

// ---- the stub Runs API: no real run is ever started ---------------------------------------------------
async function stubGateway() {
  const submitted = [];
  const statuses = new Map(); // run id -> the status `GET /v1/runs/<id>` answers with
  const streams = new Set();
  const json = (res, code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/v1/capabilities") {
      return json(res, 200, { object: "hermes.api_server.capabilities", version: "reuse-verify", features: { run_submission: true, run_events_sse: true } });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        submitted.push(JSON.parse(raw || "{}"));
        json(res, 200, { run_id: `run_${submitted.length}`, session_id: submitted[submitted.length - 1].session_id || null });
      });
      return;
    }
    const events = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (events) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "close" });
      if (events[1] === "run_1") {
        // The first run ASKS. Its stream then stays open, which is what a parked run looks like on the wire.
        res.write(`data: ${JSON.stringify({ event: "tool.started", tool: "clarify", preview: QUESTION, seq: 0 })}\n\n`);
        res.write(
          `data: ${JSON.stringify({ event: "clarify.request", prompt_id: PROMPT_ID, question: QUESTION, choices: ["the first", "the second (Recommended)"], multi_select: false, seq: 1 })}\n\n`,
        );
      }
      streams.add(res);
      return;
    }
    const clarify = /^\/v1\/runs\/([^/]+)\/clarify$/.exec(url.pathname);
    if (clarify && req.method === "POST") return json(res, 200, { ok: true, prompt_id: PROMPT_ID });
    const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (one) return json(res, 200, { status: statuses.get(one[1]) || "running", output: "", usage: {} });
    return json(res, 404, { error: "not found" });
  });
  const base = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
  return {
    base,
    submitted,
    statuses,
    stop() {
      for (const res of streams) res.destroy();
      server.closeAllConnections?.();
      server.close();
    },
  };
}

const until = async (fn, what, ms = 8000) => {
  const stop = Date.now() + ms;
  for (;;) {
    const got = fn();
    if (got) return got;
    if (Date.now() > stop) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

// ---- the panel, on the card's own endpoint ------------------------------------------------------------
const bodyOf = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
  });
const sendJson = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
};
const authorised = (req, token) => !token || req.headers["x-panel-token"] === token;

async function main() {
  await mkdir(SCRATCH_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(SCRATCH_ROOT, "reuse-rt-"));
  const gw = await stubGateway();
  const jobsFile = path.join(dir, "jobs.json");
  const assistantFile = path.join(dir, "assistant.json");
  const queueDir = path.join(dir, "assistants", "assistant-1");
  await mkdir(queueDir, { recursive: true });
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }));

  // A tree of its own: the reply path resolves the thread's tree through git, so a bare folder is refused by name
  // instead of started in. This is a temp repo, not the panel's board.
  const tree = path.join(dir, "tree");
  await mkdir(tree, { recursive: true });
  await run("git", ["init", "-q", tree]);
  await run("git", ["-C", tree, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root"]);

  const jobs = new Jobs({ config: { apiServer: { url: gw.base, key: "stub-key" }, jobsFile, defaultCwd: dir }, onLog: () => {} });
  const assistant = new Assistant({ config: { jobsFile, assistantFile }, jobs, getProjects: () => [], onLog: () => {} });
  assistant.assistants = [{ id: "assistant-1", name: "assistant-1" }];

  // The queue row that asked: running, on the asking thread, naming NO run - the row a reopen leaves behind.
  const queueFile = path.join(queueDir, "queue.json");
  await writeFile(
    queueFile,
    JSON.stringify(
      { version: 1, nextId: 2, tasks: [{ id: 1, title: "post the drafted comment", thread: ASKING_THREAD, threads: [ASKING_THREAD], state: "running", startedAt: new Date().toISOString() }] },
      null,
      2,
    ),
  );
  const row = async () => (JSON.parse(await readFile(queueFile, "utf8")).tasks || []).find((t) => Number(t.id) === 1) || null;

  // Mount the shipped route the way server.js does, on a real socket.
  const routes = createJobsRoutes({
    jobs,
    config: { token: TOKEN, defaultCwd: dir },
    assistant,
    broadcast: () => {},
    gonePointers: () => [],
    sendJson,
    readBody: bodyOf,
    authorised,
  });
  const panel = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let handled = false;
    try {
      handled = await routes(req, res, url.pathname);
    } catch (e) {
      sendJson(res, 500, { error: String((e && e.message) || e) });
      handled = true;
    }
    if (!handled) sendJson(res, 404, { error: "not found" });
  });
  const panelBase = await new Promise((resolve) => panel.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${panel.address().port}`)));

  try {
    // ── the run that asks, and then ends under its card ────────────────────────────────────────────────
    const asking = await jobs.create({ prompt: "draft the ticket comment", thread: ASKING_THREAD, existing: true, worktree: false, anchorCwd: false, cwd: tree });
    await until(() => jobs.get(asking.id)?.question, "the run to park on its question");
    const raw = jobs.get(asking.id);
    raw.ctrl?.abort();
    raw.status = "done";
    gw.statuses.set("run_1", "completed");
    const askingJob = jobs.get(asking.id);

    say("the card that asked");
    say(`  thread   ${askingJob.thread}`);
    say(`  run      ${askingJob.runId} (ended: ${gw.statuses.get("run_1")})`);
    say(`  question ${JSON.stringify(QUESTION)}`);
    say("");
    say(`POST /api/jobs/answer {id:${askingJob.id}, answer:"the second"}  (the card's Answer button, same shape)`);

    const posted = await fetch(`${panelBase}/api/jobs/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-panel-token": TOKEN },
      body: JSON.stringify({ id: askingJob.id, answer: "the second" }),
    });
    const answer = await posted.json();
    say(`  -> HTTP ${posted.status} ${JSON.stringify(answer)}`);
    say("");

    // ── what landed ─────────────────────────────────────────────────────────────────────────────────────
    const answering = answer.jobId ? jobs.get(answer.jobId) : null;
    say("the answering turn");
    say(`  mode     ${answer.mode || "(none: the base behaviour)"}`);
    say(`  thread   ${answering?.thread || answer.thread || "(none)"}`);
    say(`  run      ${answer.runId || "(none)"}`);
    say(`  says     ${answer.why || answer.error || ""}`);
    say("");

    check(answer.ok === true, "the answer was delivered", answer.error || "the answer came back undelivered");
    check(answer.mode === "reply", "it was delivered as a reply on the asking thread", `mode was ${answer.mode || "absent"}`);
    check(answering?.thread === askingJob.thread, "the answering turn carries the ASKING thread's id", `asked on ${askingJob.thread}, answered on ${answering?.thread || "nothing"}`);
    check(Boolean(answer.runId) && answer.runId !== askingJob.runId, "the answering run is a new run, not the dead one", `${askingJob.runId} -> ${answer.runId}`);
    const post = gw.submitted[gw.submitted.length - 1] || {};
    check(post.session_id === askingJob.thread, "the run was posted AS that session, so its context is the context that asked", `session_id was ${post.session_id}`);

    // ── the queue row ───────────────────────────────────────────────────────────────────────────────────
    const linked = await row();
    say("the queue row");
    say(`  before   #1 running on ${askingJob.thread} runId=null`);
    say(`  after    #1 ${linked?.state} runId=${linked?.runId || "null"}`);
    check(linked?.runId === answer.runId, "the row now names the ANSWERING run", `row runId=${linked?.runId}`);

    // The answering run ends, and the row settles against the run it names - the half a reuse change could break.
    const finished = jobs.get(answer.jobId);
    if (finished) {
      finished.ctrl?.abort();
      finished.status = "done";
      finished.outcome = finished.outcome || "completed";
    }
    const settled = settleTasks(
      [await row()],
      {
        jobs: jobs.list(),
        isLive: (t) => Boolean(t && t.status === "running"),
        rowFor: () => ({ prState: "MERGED", prUrl: "https://example.test/pr/1" }),
        by: "verify",
      },
    );
    const after = settled.tasks?.[0] || settled[0] || null;
    say(`  settled  #1 ${after?.state || "?"}${after?.doneBy ? ` by ${after.doneBy}` : ""}${after?.reason ? ` - ${after.reason}` : ""}`);
    check(after?.state === "done", "the queue row still settles once the answering run ends", `state was ${after?.state}`);

    say("");
    say(fail.length ? `${fail.length} check(s) failed` : "PASS: the answer continued the asking thread and the row settled");
    say(`thread ${askingJob.thread} run ${askingJob.runId} -> thread ${answering?.thread || "(none)"} run ${answer.runId || "(none)"}`);
    return fail.length ? 1 : 0;
  } finally {
    for (const j of jobs.list()) {
      const rec = jobs.get(j.id);
      if (!rec) continue;
      rec.status = "done";
      rec.ctrl?.abort();
      clearTimeout(rec.timer);
      clearTimeout(rec.poller);
    }
    clearTimeout(jobs.persistTimer);
    clearTimeout(assistant.timer);
    clearTimeout(assistant.wakeTimer);
    clearTimeout(assistant.persistTimer);
    panel.closeAllConnections?.();
    panel.close();
    gw.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`verify: ${(err && err.stack) || err}`);
    process.exit(2);
  },
);
