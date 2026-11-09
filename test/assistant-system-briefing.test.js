// What a turn's two halves carry, and why the split falls where it does.
//
// The standing blocks (role, rules, projects, action grammar) ride in the run's `system` field, which `jobs.create`
// sends as `instructions` on POST /v1/runs. The gateway applies that as the run's ephemeral system prompt and never
// writes it into the session's transcript.
//
// The blocks that MOVE between turns — the queue digest, the board (its full digest or its one-line marker) and the
// charter (its text or its marker) — ride the turn's input instead. That is a caching rule, not a tidiness one: a
// provider's prefix cache reuses only the bytes a request shares with the one before it, and the system text is the
// head of the prompt. While the board alternated full and marker every fourth sweep and the charter every twentieth
// turn, the head changed on a schedule and every token of the thread behind it was re-read uncached on those turns.
//
// The invariant this file pins is therefore: `system` is the SAME STRING on every turn of a session, and everything
// that moves is in `preamble`. It stops being true only when the reader edits a rule, the scratchpad, a watch or the
// role — which is the honest boundary, because those edits change what the model is being told to do.
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

test("the standing briefing is the run's system text, and nothing that moves rides in it", async (t) => {
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
    "A restart re-attaches runs",
    "SPAWN ", // the action grammar
  ]) {
    assert.ok(job.system.includes(standing), `the system text carries: ${standing}`);
  }

  // …and the two blocks that move on a schedule are NOT in it: at the head of the prompt they would change the prefix
  // and cost the cache for the whole thread behind them.
  assert.ok(!job.system.includes("The board tail (one message this turn):"), "the board is not standing text");
  assert.ok(!job.system.includes("Charter —"), "nor is the charter");

  // The per-turn input is the digest, the board, the charter and the question. None of the standing text is repeated.
  assert.ok(job.preamble.includes("Your task queue (1 queued"), "the turn carries the queue digest");
  assert.ok(job.preamble.includes("The board tail (one message this turn):"), "and the board");
  assert.ok(job.preamble.includes("Charter — the long tier"), "and the charter, whole on the first turn");
  assert.ok(!job.preamble.includes("Standing rules (written by the reader"), "the rules are not appended to the thread");
  assert.ok(!job.preamble.includes(NOTE), "nor the scratchpad");
  assert.ok(!job.preamble.includes("Projects you can SPAWN in"), "nor the projects list");
  assert.ok(job.preamble.length < job.system.length / 2, "and the turn is less than half the standing text");
});

test("a wake that skips the digest appends the board and the charter and nothing else", async (t) => {
  const { assistant, created } = await panel(t);
  // Four wakes, N=2 (the default): the digest is due on the even ticks only.
  for (let i = 0; i < 4; i += 1) await assistant.say(QUESTION, { origin: SWEEP });
  const withDigest = created.filter((job) => job.preamble.includes("Your task queue ("));
  const without = created.filter((job) => !job.preamble.includes("Your task queue ("));

  assert.equal(withDigest.length, 2, "two of four wakes carry the digest");
  assert.equal(without.length, 2, "and two skip it");
  for (const job of without) {
    assert.ok(!job.preamble.includes("Your task queue is YOURS"), "the standing directive is never appended");
    assert.ok(!job.preamble.includes(RULE), "nor the standing rules");
    assert.match(job.preamble, /The board tail \(one message this turn\):/, "the skipped wake still says what the board is");
    assert.match(job.preamble, /Charter — the long tier/, "and where the charter stands");
  }
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

test("the board's tail rides every turn, and the settings cannot gate it away", async (t) => {
  const { assistant } = await panel(t);
  assert.equal(assistant.settingsFor(PRIMARY_ASSISTANT).digestSweepEveryNWakes, undefined, "the board has no sweep gate any more");
  const boards = [];
  for (let i = 0; i < 8; i += 1) boards.push(assistant.boardForTurn(PRIMARY_ASSISTANT, SWEEP));
  for (const [i, board] of boards.entries()) assert.match(board, /^Board tail /, `turn ${i + 1} carries the tail, not a marker`);
  assert.equal(assistant.digestTail(PRIMARY_ASSISTANT).length, 8, "and every turn appended its own message to the transcript");
});

test("preamble() is still the whole briefing, in the order a turn reads it", async (t) => {
  const { assistant } = await panel(t);
  const text = assistant.preamble(PRIMARY_ASSISTANT);
  assert.ok(text.includes(RULE), "the rules are there");
  assert.ok(text.includes("Your task queue (1 queued"), "the digest is there");
  assert.ok(text.includes("The board tail (one message this turn):"), "the board is there");
  assert.ok(text.includes("Charter — the long tier"), "and the charter");
  assert.ok(text.indexOf("Your task queue is YOURS") < text.indexOf("Your task queue (1 queued"), "the directive precedes the digest");
  assert.ok(text.indexOf("Your task queue (1 queued") < text.indexOf("The board tail (one message this turn):"), "and the board follows the digest");
  assert.ok(text.indexOf("The board tail (one message this turn):") < text.indexOf("Charter — the long tier"), "the charter follows the board");
  assert.ok(text.indexOf("Charter — the long tier") < text.indexOf("A restart re-attaches runs"), "and the moving blocks precede the standing rest");
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

test("the POST carries the standing briefing as `instructions`, and the moving blocks in the input", async (t) => {
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
  assert.ok(!String(body.instructions || "").includes("The board tail (one message this turn):"), "the board does not");
  assert.ok(!String(body.instructions || "").includes("Charter —"), "and neither does the charter");
  assert.ok(!String(body.input || "").includes(RULE), "and not in the run's input");
  assert.ok(String(body.input || "").includes("Your task queue (1 queued"), "the input carries the queue digest");
  assert.ok(String(body.input || "").includes("The board tail (one message this turn):"), "and the board");
  assert.ok(String(body.input || "").includes("Charter — the long tier"), "and the charter");
  assert.ok(String(body.input || "").includes(QUESTION), "and the question");
  assert.equal(body.session_id, "panel-assistant", "on the assistant's own thread");
});

// The charter's send counter is the trap this split creates: `say()` builds the turn half and the standing half in
// one call, and a half rendered twice would record the full send and then withhold it from the SAME turn. The first
// turn of a session must carry the file, and the second must carry the marker.
test("the charter is sent whole on the first turn, and withheld on the second", async (t) => {
  const { assistant, created } = await panel(t);
  await assistant.say(QUESTION, { origin: SWEEP });
  assert.match(created[0].preamble, /Charter — the long tier, read in full this turn/, "turn 1 carries the file");
  assert.ok(created[0].preamble.includes("CHARTER-BODY: the append tax"), "the text itself, not only the label");
  assert.ok(!created[0].system.includes("CHARTER-BODY"), "and the system block does not carry it too");
  await assistant.say(QUESTION, { origin: SWEEP });
  assert.match(created[1].preamble, /Charter — the long tier is unchanged and withheld this turn/, "turn 2 carries the marker");
  assert.ok(!created[1].preamble.includes("CHARTER-BODY: the append tax"), "and not the file again");
});

// THE INVARIANT THE SPLIT EXISTS FOR, measured on the bytes a turn sends: eight sweep wakes of one session with
// nothing edited send ONE system block, while the turn text moves as the board and the charter change form. A
// provider's prefix cache can only reuse the thread behind text that did not move, so a system block that changes on
// a schedule is a cache miss for every token behind it - which is what the board's fourth-wake digest and the
// charter's twentieth-turn resend used to be.
test("the system block is the same bytes on every wake of a session", async (t) => {
  const { assistant, created } = await panel(t);
  for (let i = 0; i < 8; i += 1) await assistant.say(QUESTION, { origin: SWEEP });

  const systems = new Set(created.map((job) => job.system));
  assert.equal(systems.size, 1, `${created.length} wakes sent ${systems.size} distinct system blocks`);
  assert.ok(created[0].system.length > 1000, "and it is the whole standing briefing, not a stub");

  const turns = new Set(created.map((job) => job.preamble));
  assert.equal(turns.size > 1, true, "the turn text does move");
  assert.equal(created.filter((job) => job.preamble.includes("The board tail (one message this turn):")).length, 8, "every turn carries the board's tail");
  assert.equal(created.filter((job) => job.preamble.includes("- (no agents on the board)")).length, 8, "and an empty board says so on every one");
  assert.equal(created.filter((job) => job.preamble.includes("[Board unchanged")).length, 0, "there is no marker any more: the gate it belonged to is gone");
  assert.equal(created.filter((job) => job.preamble.includes("CHARTER-BODY: the append tax")).length, 1, "the charter whole once, on the first turn");
  assert.equal(created.filter((job) => job.preamble.includes("unchanged and withheld this turn")).length, 7, "and the marker on the other seven");
});
