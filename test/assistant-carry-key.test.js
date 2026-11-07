// Keying the Director's carry: one QUEUE/MESSAGE line, one row, one turn — however often its reply is read again.
//
// The defect this file is the contract for (docs/reports/queue-recarry-2026-11-07.html): a finished Director reply is
// carried out by `harvest`, and the only thing stopping a second carry was the turn id sitting in
// `Assistant.harvested` — a Set of at most 50 ids, evicted in HARVEST order, not by age. A stored reply that had left
// that window read as never harvested, so the next pass filed its QUEUE lines again as brand new rows and re-sent its
// MESSAGE lines as brand new turns: five texts became eighteen rows, and two of the re-sends started real turns on
// Assistant #2 at 19:05.
//
// What this pins, in the report's fix-A terms:
//   1. ONE TURN, ONE ROW. A reply with a QUEUE and a MESSAGE line files one row and sends one turn;
//   2. THE KEY IS ON THE ROW. The row names the line that filed it (`<turn id>|queue|<index>`), and a second filing
//      of that key returns the row that exists rather than pushing another;
//   3. THE MARK AGES OUT, THE ROW DOES NOT. With `harvested` emptied — the state a re-read treats as "never
//      harvested" — the same stored reply files nothing and sends nothing, and says so by name;
//   4. IT SURVIVES A RESTART. A second panel reading the same state directory refuses the same lines with an empty
//      ledger rebuilt from the row, and a fresh process with the ledger still on disk refuses the MESSAGE;
//   5. A NEW TURN IS NOT A REPLAY. The same text written in a different turn files again: the key is the line's
//      identity, not its words.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { addTask, pickTask } from "../lib/assistant/queue.js";
import { CARRIED_CAP } from "../lib/assistant/store-file.js";
import { ASSISTANT_DIRECTOR_ID } from "../lib/roles.js";
import { PRIMARY_ASSISTANT } from "../lib/assistants.js";

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
// Two lines of one reply: a row to file and a turn to start. The body is the report's own wording — the Director is
// the second assistant (#2) and it files into #1, which is the only other queue it may write to.
const REPLY = [
  "Assistant #1 owns the tree and is carrying the row, so I filed there and told it why.",
  "QUEUE #1 | Close the two landed parks #236 and #241 and say which row each one became",
  "MESSAGE #1 | #282 is extended: you may stand up a throwaway node service for the measurement",
].join("\n");

async function panel(t, { dir: given = null } = {}) {
  const dir = given || (await mkdtemp(path.join(os.tmpdir(), "wtgui-carry-key-")));
  if (!given) t.after(() => rm(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  if (!given) {
    await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  }
  const said = [];
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile, defaultCwd: dir },
    jobs: { list: () => [], firstOfThread: () => null, create: async (body) => ({ id: `job-${said.length}`, ...body }) },
    getProjects: () => [],
    getRows: () => [],
    onLog: () => {},
  });
  // The turn a MESSAGE starts is the thing being counted; stubbing `say` is how this file counts it without a gateway.
  assistant.say = async (text, opts = {}) => {
    said.push({ text: String(text), assistantId: opts.assistantId || null, origin: opts.origin || null });
    return { id: `said-${said.length}` };
  };
  assistant.createAssistant({ roleId: ASSISTANT_DIRECTOR_ID });
  t.after(() => {
    for (const timer of [assistant.persistTimer, assistant.wakeTimer, assistant.timer, assistant.settleTimer]) clearTimeout(timer);
  });
  return { assistant, dir, said, assistantFile };
}

// The stored Director turn: #2's thread (the Director is the second assistant this panel creates), status done.
const turn = (id) => ({
  id,
  thread: "panel-assistant-2",
  assistantId: "assistant-2",
  status: "done",
  prompt: "",
  startedAt: new Date().toISOString(),
  lines: [{ kind: "text", text: REPLY }],
});

const lineKinds = (assistant) => assistant.journal.map((j) => j.kind);

test("one Director turn files one row and starts one turn, and its row names the line that filed it", async (t) => {
  const { assistant, said } = await panel(t);
  await assistant.harvest(turn("turn-1"));
  await wait();

  const queue = assistant.queueView(PRIMARY_ASSISTANT);
  assert.equal(queue.tasks.length, 1, "one QUEUE line filed one row");
  const row = queue.tasks[0];
  assert.equal(row.carriedKey, "turn-1|queue|0", "the row names the turn and the line's place in it");
  assert.equal(row.createdBy, "assistant-2", "and still says who filed it");
  assert.match(row.title, /^Close the two landed parks/);
  assert.equal(said.length, 1, "one MESSAGE line started one turn");
  assert.equal(said[0].assistantId, PRIMARY_ASSISTANT, "on the assistant it named");

  // The ledger is persisted at the moment the line is carried, not on the debounce: a boot that starts before it is
  // flushed is exactly the boot this record exists to answer.
  assert.ok(CARRIED_CAP > 50, "the ledger is longer than the 50-id mark it stands behind");
  assert.equal(assistant.carriedLines.length, 2, "one record for each carried line");
  assert.deepEqual(
    assistant.carriedLines.map((x) => [x.key, x.kind, x.outcome]),
    [
      ["turn-1|queue|0", "queue", "filed"],
      ["turn-1|message|0", "message", "sent"],
    ],
  );
});

test("the mark ages out and a re-read files nothing: the key, not the window, decides", async (t) => {
  const { assistant, said } = await panel(t);
  await assistant.harvest(turn("turn-aged"));
  await wait(80);
  assert.equal(assistant.queueView(PRIMARY_ASSISTANT).tasks.length, 1);
  assert.equal(said.length, 1);

  // What the report's step 3 does: 50 later turns go in, the oldest fall out, and this turn reads as never harvested.
  for (let i = 0; i < 50; i += 1) assistant.harvested.add(`later-${i}`);
  assistant.harvested = new Set([...assistant.harvested].slice(-50));
  assert.equal(assistant.harvested.has("turn-aged"), false, "the turn is no longer marked");

  // Step 4: the same stored reply delivered again. No row, no turn, and a refusal said out loud for each line.
  await assistant.harvest(turn("turn-aged"));
  await wait(120);
  assert.equal(assistant.queueView(PRIMARY_ASSISTANT).tasks.length, 1, "the re-read filed nothing");
  assert.equal(said.length, 1, "and sent nothing");
  const kinds = lineKinds(assistant);
  assert.equal(kinds.filter((k) => k === "queue").length, 1, "the only 'added' line is the first filing");
  assert.equal(kinds.filter((k) => k === "queue-replay-refused").length, 1, "the QUEUE line is refused by name");
  assert.equal(kinds.filter((k) => k === "message-replay-refused").length, 1, "and so is the MESSAGE line");
  const refused = assistant.journal.find((j) => j.kind === "queue-replay-refused");
  assert.match(refused.text, /already carried out once \(row #1\)/, "the refusal names the row that exists");
});

test("a restart answers the same way: the row carries the key and the ledger carries the message", async (t) => {
  const first = await panel(t);
  await first.assistant.harvest(turn("turn-boot"));
  await wait(80);
  first.assistant.writeNow();
  assert.equal(first.assistant.queueView(PRIMARY_ASSISTANT).tasks.length, 1);
  assert.equal(first.said.length, 1);

  // The next boot: same state directory and the ledger read back from assistant.json. The mark is the half that AGES
  // OUT — 50 turn ids in, this one is gone — so the new process is given the state a re-read after that window has.
  const boot = await panel(t, { dir: first.dir });
  boot.assistant.harvested = new Set();
  assert.equal(boot.assistant.carriedLines.length, 2, "but it has both carried-line records");

  await boot.assistant.harvest(turn("turn-boot"));
  await wait(120);
  assert.equal(boot.assistant.queueView(PRIMARY_ASSISTANT).tasks.length, 1, "the row is not filed a second time");
  assert.equal(boot.said.length, 0, "and the message is not sent a second time");
});

test("a ledger that lost its records is rebuilt from the row: the row is the durable half", async (t) => {
  const { assistant, said } = await panel(t);
  await assistant.harvest(turn("turn-row"));
  await wait(80);
  assert.equal(assistant.queueView(PRIMARY_ASSISTANT).tasks.length, 1);

  // The ledger pruned, restored from an older copy, or never written — but the row is still there with its key.
  assistant.carriedLines = [];
  assistant.harvested = new Set();
  await assistant.harvest(turn("turn-row"));
  await wait(120);
  assert.equal(assistant.queueView(PRIMARY_ASSISTANT).tasks.length, 1, "the row's own key refused the second filing");
  assert.ok(lineKinds(assistant).includes("queue-replay-refused"), "and the refusal was said, not swallowed");
  // The refusal points at the row that exists, and the ledger was repaired on the way through.
  assert.equal(assistant.carriedLines.find((x) => x.kind === "queue").ref, 1);
  // The MESSAGE has no row to fall back on: with its record gone the line is sent again. That is the honest limit of
  // a ledger record — and the reason the cap (200) sits far beyond the job store's own 80-turn retention, so the
  // record is still there for every turn a boot can re-read.
  assert.equal(said.length, 2, "the message went out once more when its only record was gone");
  assert.equal(assistant.carriedLines.filter((x) => x.kind === "message").length, 1, "and the record is back");
});

test("a new turn writing the same text is not a replay: the key is the line, not its words", async (t) => {
  const { assistant, said } = await panel(t);
  await assistant.harvest(turn("turn-a"));
  await wait(80);
  await assistant.harvest(turn("turn-b"));
  await wait(80);
  assert.equal(assistant.queueView(PRIMARY_ASSISTANT).tasks.length, 2, "the same words in a new turn file again");
  assert.equal(said.length, 2, "and the message is said again");
  const keys = assistant.queueView(PRIMARY_ASSISTANT).tasks.map((x) => x.carriedKey);
  assert.deepEqual(keys, ["turn-a|queue|0", "turn-b|queue|0"], "each row names its own turn");
});

test("the row's key is the caller's, never the payload's, and a missing key is never a match", () => {
  const { task } = addTask([], { title: "t" });
  assert.equal(task.carriedKey, null, "a reader's row carries no key");
  // A posted payload cannot claim a line the panel never carried.
  const { task: forged } = addTask([], { title: "u", carriedKey: "x|queue|9" });
  assert.equal(forged.carriedKey, null, "the payload's key is dropped");
  const given = addTask([], { title: "v" }, { carriedKey: "turn-9|queue|0" });
  assert.equal(given.task.carriedKey, "turn-9|queue|0", "the caller's key is written");
  const again = addTask(given.tasks, { title: "v again" }, { carriedKey: "turn-9|queue|0" });
  assert.equal(again.duplicate, true, "the same key returns the row that exists");
  assert.equal(again.task.id, given.task.id);
  assert.equal(again.tasks.length, 1, "and pushes nothing");
  assert.equal(pickTask({ ...again.task }).carriedKey, "turn-9|queue|0", "the key survives a file round-trip");
});
