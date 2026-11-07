// The append tax: the standing briefing is SYSTEM text, and a turn appends only its queue digest.
//
// Until this change every assistant turn wrote `Assistant.preamble()` into the run's INPUT: `jobs.create()` put it
// ahead of the question (`pre + anchored`), so ~17 KB of text that had not changed was a new user message on the
// thread every wake. Each of those messages is re-read by every later API call (as cache) and re-ingested by every
// compaction (as uncached input), which is the tax this file is the contract for.
//
// What replaces it:
//   1. the standing blocks (role, rules, charter, projects, action grammar, the board) ride in the run's `system`
//      field, which `jobs.create` sends as `instructions` on POST /v1/runs. The gateway applies that as the run's
//      ephemeral system prompt and never writes it into the session's transcript;
//   2. the per-turn input is the queue digest and the question, nothing else;
//   3. the queue digest is gated one wake in two (`queueSweepEveryNWakes`, default 2) and the full board one sweep
//      in four (`digestSweepEveryNWakes`, default 4). A wake that skips the digest appends nothing but its question.
//
// `preamble()` still returns the WHOLE briefing, standing plus turn, for the page and the tests that ask for it. It is
// what a turn would append if it were still a single message; `say()` no longer builds a turn that way.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { writeQueueFile } from "../lib/assistant/queue.js";
import { PRIMARY_ASSISTANT } from "../lib/assistants.js";
import { Jobs } from "../lib/jobs.js";

const RULE = "never start a second run on a thread the digest lists as LIVE";
const NOTE = "SCRATCHPAD-NOTE: the append tax was cut this week";
const QUESTION = "Sweep your queue. Say what you make of the board in one line.";

function makeRow() {
  return {
    path: "fixtures/test-repo",
    name: "repo",
    branch: "wtgui/test",
    head: "abc1234",
    ahead: 1,
    behind: 0,
    dirty: 0,
    untracked: 0,
    dirtyFiles: [],
    untrackedFiles: [],
    parent: "main",
    parentSha: "abc1234",
    parentSource: "cut",
    verdict: "UNMERGED (1 commit)",
    released: null,
    error: null,
    lastCommit: "2026-11-01T00:00:00Z",
  };
}

async function panel(t, { settings = {}, rows = [makeRow()] } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-system-briefing-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(
    assistantFile,
    JSON.stringify({
      version: 2,
      settings,
      notes: NOTE,
      rules: [{ id: "r1", text: RULE, at: new Date().toISOString(), by: "reader" }],
      watches: [],
      alerts: [],
      journal: [],
    }),
  );
  const created = [];
  const charterFile = path.join(dir, "assistant-charter.md");
  await writeFile(charterFile, "# The long tier\n\nCHARTER-BODY: the append tax, in one line.\n");
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile, charterFile },
    jobs: {
      list: () => [],
      firstOfThread: () => null,
      create: async (body) => {
        created.push(body);
        return { id: `job-${created.length}`, ...body };
      },
    },
    getProjects: () => [{ name: "agent-worktree-gui", path: "fixtures/agent-worktree-gui" }],
    getRows: () => rows,
    onLog: () => {},
  });
  // One queued row, so `queueBriefing` has a digest to build: an empty queue returns no lines, and an assertion
  // against an empty digest would pass without ever building one.
  writeQueueFile(assistant.queuePathOf(assistant.assistantRecord()), [{ id: 1, title: "cut the append tax", state: "queued" }], 2);
  return { assistant, created, dir };
}

const SWEEP = { kind: "assistant-wake", rule: "quiet", reason: "sweep" };

test("the standing briefing is the run's system text, not its input", async (t) => {
  const { assistant, created } = await panel(t, { settings: { queueSweepEveryNWakes: 1 } });
  await assistant.say(QUESTION, { origin: SWEEP });
  const [job] = created;

  // The standing blocks are in `system`.
  for (const standing of [
    "You are the assistant watching this panel's agent board",
    "Your task queue is YOURS",
    RULE,
    NOTE,
    "Standing rules (written by the reader",
    "Projects you can SPAWN in",
    "The board right now:",
    "A restart re-attaches runs",
    "SPAWN ", // the action grammar
  ]) {
    assert.ok(job.system.includes(standing), `the system text carries: ${standing}`);
  }
  assert.ok(job.system.includes("Charter — the long tier"), "and the charter block, whole on the first turn");

  // The per-turn input is the digest and the question. None of the standing text is repeated there.
  assert.ok(job.preamble.includes("Your task queue (1 queued"), "the turn carries the queue digest");
  assert.ok(!job.preamble.includes("Standing rules (written by the reader"), "the rules are not appended to the thread");
  assert.ok(!job.preamble.includes(NOTE), "nor the scratchpad");
  assert.ok(!job.preamble.includes("The board right now:"), "nor the board");
  assert.ok(!job.preamble.includes("Projects you can SPAWN in"), "nor the projects list");
  assert.ok(job.preamble.length < job.system.length / 2, "and the turn is less than half the standing text");
});

test("a wake that skips the digest appends nothing but its question", async (t) => {
  const { assistant, created } = await panel(t);
  // Four wakes, N=2 (the default): the digest is due on the even ticks only.
  for (let i = 0; i < 4; i += 1) await assistant.say(QUESTION, { origin: SWEEP });
  const withDigest = created.filter((job) => job.preamble.includes("Your task queue ("));
  const without = created.filter((job) => !job.preamble.includes("Your task queue ("));

  assert.equal(withDigest.length, 2, "two of four wakes carry the digest");
  assert.equal(without.length, 2, "and two append nothing");
  for (const job of without) assert.equal(job.preamble, "", "a skipped digest is an empty briefing, not a marker");
  for (const job of created) assert.ok(job.system.includes(RULE), "every wake still carries the standing text");
});

test("queueSweepEveryNWakes defaults to 2 and the setting still overrides it", async (t) => {
  const { assistant } = await panel(t);
  assert.equal(assistant.settingsFor(PRIMARY_ASSISTANT).queueSweepEveryNWakes, 2, "the default is one wake in two");
  const due = [];
  for (let i = 0; i < 6; i += 1) due.push(assistant.queueDigestDue(PRIMARY_ASSISTANT));
  assert.deepEqual(due, [false, true, false, true, false, true], "the gate alternates from the first wake");

  const every = await panel(t, { settings: { queueSweepEveryNWakes: 1 } });
  const all = [];
  for (let i = 0; i < 4; i += 1) all.push(every.assistant.queueDigestDue(PRIMARY_ASSISTANT));
  assert.deepEqual(all, [true, true, true, true], "1 still means every wake");
});

test("digestSweepEveryNWakes defaults to 4 and still sends the full board on its sweep", async (t) => {
  const { assistant } = await panel(t);
  assert.equal(assistant.settingsFor(PRIMARY_ASSISTANT).digestSweepEveryNWakes, 4, "the default is one sweep in four");
  const boards = [];
  for (let i = 0; i < 8; i += 1) boards.push(assistant.boardForTurn(PRIMARY_ASSISTANT, SWEEP));
  // Sweep 1 is full because the signature is new to this session; 4 and 8 are the Nth sweeps.
  assert.equal(boards[0], assistant.digest(), "the first sweep describes the board in full");
  assert.match(boards[1], /^\[Board unchanged/, "the second is the marker");
  assert.equal(boards[3], assistant.digest(), "the fourth sweep is the Nth, in full");
  assert.equal(boards[7], assistant.digest(), "and so is the eighth");
  assert.equal(boards.filter((b) => /^\[Board unchanged/.test(b)).length, 5, "the other five are markers");
});

test("preamble() is still the whole briefing, in the order a turn reads it", async (t) => {
  const { assistant } = await panel(t);
  const text = assistant.preamble(PRIMARY_ASSISTANT);
  assert.ok(text.includes(RULE), "the rules are there");
  assert.ok(text.includes("Your task queue (1 queued"), "the digest is there");
  assert.ok(text.includes("The board right now:"), "the board is there");
  assert.ok(text.indexOf("Your task queue is YOURS") < text.indexOf("Your task queue (1 queued"), "the directive precedes the digest");
  assert.ok(text.indexOf("Your task queue (1 queued") < text.indexOf("A restart re-attaches runs"), "and the digest precedes the standing rest");
  assert.ok(text.indexOf("A restart re-attaches runs") < text.indexOf("The board right now:"), "the board comes after the queue block");
});

// The wire contract. `Assistant.say` builds the turn and `Jobs.create` posts it; the split is only real if the
// standing text reaches the gateway on `instructions` and the transcript carries the digest. A stub Runs API records
// the body, so the assertion is on the request the gateway would receive rather than on the object the assistant built.
async function stubGateway() {
  const submitted = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/v1/capabilities") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ version: "stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, model_options: true } }));
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          submitted.push(JSON.parse(raw || "{}"));
        } catch {
          submitted.push({});
        }
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ run_id: `stub-run-${submitted.length}`, status: "started" }));
      });
      return;
    }
    if (/^\/v1\/runs\/[^/]+\/events$/.test(url.pathname)) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(`event: run.completed\ndata: ${JSON.stringify({ event: "run.completed", output: "done", exit_code: 0 })}\n\n`);
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ run_id: "stub-run-0", status: "completed" }));
  });
  await new Promise((open) => server.listen(0, "127.0.0.1", open));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    submitted,
    close: () => new Promise((done) => {
      server.closeAllConnections?.();
      server.close(done);
    }),
  };
}

test("the POST carries the standing briefing as `instructions`, and the input is the digest and the question", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-system-wire-"));
  const gw = await stubGateway();
  t.after(async () => {
    await gw.close();
    await rm(dir, { recursive: true, force: true });
  });
  const config = { jobsFile: path.join(dir, "jobs.json"), apiServer: { url: gw.url }, defaultCwd: dir };
  const jobs = new Jobs({ config, onEvent: () => {}, onLog: () => {} });
  t.after(() => {
    for (const j of jobs.jobs.values()) {
      clearTimeout(j.timer);
      clearTimeout(j.persistTimer);
      clearInterval(j.poller);
      clearInterval(j.statsTimer);
      try {
        j.ctrl?.abort();
      } catch {
        /* an aborted stream is the point */
      }
    }
  });
  const assistant = new Assistant({
    config: { ...config, assistantFile: path.join(dir, "assistant.json") },
    jobs,
    getProjects: () => [{ name: "agent-worktree-gui", path: "fixtures/agent-worktree-gui" }],
    getRows: () => [makeRow()],
    onLog: () => {},
  });
  await writeFile(
    assistant.file,
    JSON.stringify({ version: 2, settings: { queueSweepEveryNWakes: 1 }, notes: NOTE, rules: [{ id: "r1", text: RULE, at: new Date().toISOString(), by: "reader" }], watches: [], alerts: [], journal: [] }),
  );
  assistant.load();
  writeQueueFile(assistant.queuePathOf(assistant.assistantRecord()), [{ id: 1, title: "cut the append tax", state: "queued" }], 2);

  await assistant.say(QUESTION, { origin: SWEEP });
  const until = Date.now() + 8_000;
  while (!gw.submitted.length && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  const body = gw.submitted[0];
  assert.ok(body, "a run was posted to the stub");

  assert.ok(String(body.instructions || "").includes(RULE), "the standing rules ride on `instructions`");
  assert.ok(!String(body.input || "").includes(RULE), "and not in the run's input");
  assert.ok(String(body.input || "").includes("Your task queue (1 queued"), "the input carries the queue digest");
  assert.ok(String(body.input || "").includes(QUESTION), "and the question");
  assert.equal(body.session_id, "panel-assistant", "on the assistant's own thread");
});

// The charter's send counter is the trap this split creates: `say()` builds the turn half and the standing half in
// one call, and a standing half rendered twice would record the full send and then withhold it from the SAME turn.
// The first turn of a session must carry the file, and the second must carry the marker.
test("the charter is sent whole on the first turn, though the turn half is built first", async (t) => {
  const { assistant, created } = await panel(t);
  await assistant.say(QUESTION, { origin: SWEEP });
  assert.match(created[0].system, /Charter — the long tier, read in full this turn/, "turn 1 carries the file");
  assert.ok(created[0].system.includes("CHARTER-BODY: the append tax"), "the text itself, not only the label");
  await assistant.say(QUESTION, { origin: SWEEP });
  assert.match(created[1].system, /Charter — the long tier is unchanged and withheld this turn/, "turn 2 carries the marker");
  assert.ok(!created[1].system.includes("CHARTER-BODY: the append tax"), "and not the file again");
});
