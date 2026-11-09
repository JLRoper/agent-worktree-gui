// The board digest is an append-only tail, and this file is the contract for it.
//
// WHAT IT WAS. The digest was a block rewritten in full on every turn it was due: every live run and the five most
// recent, each with its prompt, its tree and its last tool calls. On a busy board that is about 8 KB, and the sweep
// after a quiet one sent the same text again.
//
// WHAT IT IS. One message per turn, appended to the assistant's digest transcript
// (`state/assistants/<id>/digest.jsonl`) and handed to the run. A row carries
// `#<id> tok=<state> at=<stamp> send=<assistant>/<thread>/<turn>`: the state token is a hash of the facts an
// assistant acts on, so a row whose token moved is the only row with news, and the text behind a row is read on
// demand from the turn its `send` pointer names (`readTurn`).
//
// THE FIVE FACTS THIS FILE PINS
//   1. a turn appends EXACTLY one message (and a create that throws appends none);
//   2. an unchanged item does not re-send its text - its row is four fields and nothing else;
//   3. a changed item's state token differs from the previous one, and the row carries its text again;
//   4. the read tool answers the turn the pointer NAMES, not the newest turn on its thread;
//   5. the busiest realistic board fits one screen at the assistant float's default width (`DIGEST_SCREEN`).
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { PRIMARY_ASSISTANT } from "../lib/assistants.js";
import {
  DIGEST_SCREEN,
  LIVE_RUNS_LINE,
  appendDigestMessage,
  digestRelFor,
  displayLines,
  itemStateOf,
  readDigestTail,
  readTurn,
  stateToken,
} from "../lib/assistant/digest-tail.js";

function makeRow(head = "abc1234") {
  return {
    path: "C:/test/repo",
    name: "repo",
    branch: "wtgui/test",
    head,
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

// A run with two tool calls and a final message, so the read tool has something to answer with.
const run = (over = {}) => ({
  id: "j1",
  thread: "t1",
  title: "worker one",
  status: "running",
  startedAt: "2026-11-09T10:00:00.000Z",
  prompt: "land change 3",
  worktreePath: ".worktrees/repo-one",
  finalMessage: "",
  lines: [
    { kind: "tool", text: "\u{1F4BB} terminal \u00b7 npm test", at: 1 },
    { kind: "tool", text: "\u{1F4BB} read_file \u00b7 lib/a.js", at: 2 },
  ],
  ...over,
});

async function panel(t, { jobs = [run()] } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-tail-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = {
    list: () => jobs,
    get: (id) => jobs.find((j) => j.id === id) || null,
    firstOfThread: () => null,
    create: async (body) => ({ id: "job-1", ...body }),
  };
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile: path.join(dir, "assistant.json"), charterFile: path.join(dir, "assistant-charter.md") },
    jobs: store,
    getRows: () => [makeRow()],
    getProjects: () => [],
    onLog: () => {},
  });
  t.after(() => {
    if (assistant.timer) clearInterval(assistant.timer);
    if (assistant.persistTimer) clearTimeout(assistant.persistTimer);
  });
  const file = path.join(dir, "assistants", PRIMARY_ASSISTANT, "digest.jsonl");
  return { assistant, jobs, file, dir };
}

test("a turn appends exactly one message, and a create that throws appends none", async (t) => {
  const { assistant, file } = await panel(t);
  assert.deepEqual(readDigestTail(file), [], "nothing is written before the first turn");

  await assistant.say("what is going on?");
  assert.equal(readDigestTail(file).length, 1, "one turn, one message");

  await assistant.say("and now?");
  assert.equal(readDigestTail(file).length, 2, "the second turn appends the second message");

  // A create that throws is a turn that never happened: the message is built before the create and appended after it,
  // so a refusal leaves the transcript exactly as it was.
  assistant.jobs.create = async () => {
    throw new Error("gateway refused");
  };
  await assert.rejects(() => assistant.say("this one never starts?"));
  assert.equal(readDigestTail(file).length, 2, "the refused turn appended nothing");

  // boardForTurn is the same pair for a caller that is itself a turn.
  assistant.boardForTurn(PRIMARY_ASSISTANT);
  assert.equal(readDigestTail(file).length, 3);
});

test("an unchanged item does not re-send its text", async (t) => {
  const { assistant, file } = await panel(t);
  assistant.boardForTurn(PRIMARY_ASSISTANT);
  assistant.boardForTurn(PRIMARY_ASSISTANT, { kind: "assistant-wake", rule: "quiet" });

  const [first, second] = readDigestTail(file);
  const rowOf = (msg) => msg.items.find((i) => i.id === "j1");
  assert.ok(rowOf(first).text.includes("worker one"), `the first message carries the item's text: ${rowOf(first).text}`);
  assert.equal(rowOf(first).changed, true);
  assert.equal(rowOf(first).text.length > 0, true);

  assert.equal(rowOf(second).text, "", "the unchanged row re-sends no text");
  assert.equal(rowOf(second).changed, false, "and says so");
  assert.equal(rowOf(second).token, rowOf(first).token, "the token is the same state");
  assert.equal(rowOf(second).at, rowOf(first).at, "so the moment that state began is carried, not reset");
  assert.ok(!second.text.includes("worker one"), `and the message has no text for it: ${second.text}`);
});

test("a changed item's state token differs from the previous one, and its text rides again", async (t) => {
  const { assistant, jobs, file } = await panel(t);
  assistant.boardForTurn(PRIMARY_ASSISTANT);
  const before = readDigestTail(file).at(-1).items.find((i) => i.id === "j1");

  jobs[0].status = "done";
  jobs[0].endedAt = "2026-11-09T10:05:00.000Z";
  assistant.boardForTurn(PRIMARY_ASSISTANT, { kind: "assistant-wake", rule: "quiet" });
  const after = readDigestTail(file).at(-1).items.find((i) => i.id === "j1");

  assert.notEqual(after.token, before.token, "the state token moved with the state");
  assert.ok(after.text.includes("done"), `and the row carries its new text: ${after.text}`);
  assert.equal(after.changed, true);

  // The token covers the facts, not the clock or the console: a line arriving is not a state change.
  jobs[0].lines.push({ kind: "tool", text: "\u{1F4BB} terminal \u00b7 ls", at: 3 });
  assert.equal(stateToken(itemStateOf(jobs[0])), after.token, "appending a console line does not move the token");
});

test("the read tool returns the pointed-at turn rather than the latest", async (t) => {
  const older = run({ id: "aaaa1111", thread: "t-old", title: "the older turn", status: "done", endedAt: "2026-11-09T10:01:00.000Z", finalMessage: "the older turn's last word" });
  const newer = run({ id: "bbbb2222", thread: "t-new", title: "the newest turn", status: "done", endedAt: "2026-11-09T10:09:00.000Z", finalMessage: "the newest turn's last word" });
  const { assistant } = await panel(t, { jobs: [older, newer] });

  const out = assistant.readTurn(`assistant-1/${older.thread}/${older.id}`);
  assert.equal(out.ok, true);
  assert.equal(out.finalMessage, "the older turn's last word", "the turn the pointer names, not the newest one");
  assert.equal(out.turn.id, older.id);
  assert.equal(out.calls.length, 2, "its last few tool calls");
  assert.deepEqual(out.calls.map((c) => c.tool), ["terminal", "read_file"]);

  // The newest turn answers for its own pointer, so the first answer was not a happy accident.
  assert.equal(assistant.readTurn(`assistant-1/${newer.thread}/${newer.id}`).finalMessage, "the newest turn's last word");

  // A turn the pointer does not name, or a thread that is not its own, is refused rather than guessed at.
  assert.equal(assistant.readTurn("assistant-1/t-old/no-such-turn").ok, false);
  const wrongThread = assistant.readTurn(`assistant-1/t-new/${older.id}`);
  assert.equal(wrongThread.ok, false);
  assert.match(wrongThread.why, /ran on t-old/);
});

test("a row's pointer names the sending turn when the run has one", async (t) => {
  const spawned = run({ id: "cccc3333", thread: "worker-thread", assistantId: "assistant-1", origin: { kind: "assistant-spawn", turnId: "turn7777", turnThread: "panel-assistant" } });
  const { assistant, file } = await panel(t, { jobs: [spawned] });
  assistant.boardForTurn(PRIMARY_ASSISTANT);
  const row = readDigestTail(file).at(-1).items[0];
  assert.equal(row.pointer, "assistant-1/panel-assistant/turn7777", "sender, its thread and the turn that wrote the SPAWN line");
});

test("the busiest realistic board fits one screen at the assistant float's default width", async (t) => {
  const longPrompt = "work " + "x".repeat(450);
  const jobs = [];
  for (let i = 1; i <= 10; i += 1) {
    jobs.push(
      run({
        id: `live${i}abc`.slice(0, 8),
        thread: `live-thread-${i}`,
        title: `live worker ${i}`,
        status: "running",
        startedAt: new Date(Date.now() - i * 60_000).toISOString(),
        prompt: longPrompt,
        worktreePath: `.worktrees/repo-${i}`,
      }),
    );
  }
  for (let i = 1; i <= 5; i += 1) {
    jobs.push(
      run({
        id: `rec${i}abcd`.slice(0, 8),
        thread: `recent-thread-${i}`,
        title: `recent worker ${i}`,
        status: "done",
        startedAt: new Date(Date.now() - (10 + i) * 60_000).toISOString(),
        endedAt: new Date(Date.now() - (9 + i) * 60_000).toISOString(),
        prompt: longPrompt,
        worktreePath: `.worktrees/repo-${i}`,
      }),
    );
  }
  const { assistant, file } = await panel(t, { jobs });
  // The first message is the worst case: every row is new, so every row carries its text.
  const text = assistant.boardForTurn(PRIMARY_ASSISTANT);
  const msg = readDigestTail(file).at(-1);
  assert.equal(msg.items.length, 15, "fifteen items on the board");
  assert.ok(text.includes(LIVE_RUNS_LINE), "and the standing warning above them");
  const lines = displayLines(text, DIGEST_SCREEN.cols);
  assert.ok(lines <= DIGEST_SCREEN.lines, `the digest is one screen: ${lines} display lines at ${DIGEST_SCREEN.cols} cols, budget ${DIGEST_SCREEN.lines}`);
  assert.ok(msg.bytes < 4000, `and far under the 8 KB it replaces: ${msg.bytes} bytes`);

  // The second turn is the same board: every row is unchanged, so the message is rows and no text.
  const quiet = assistant.boardForTurn(PRIMARY_ASSISTANT);
  assert.equal(displayLines(quiet, DIGEST_SCREEN.cols) <= DIGEST_SCREEN.lines, true);
  assert.ok(quiet.length < text.length, "a quiet turn's message is smaller than the first one");
});

test("the transcript keeps every message a turn was handed, and trims from the front at its cap", async (t) => {
  const { assistant, file } = await panel(t);
  assistant.boardForTurn(PRIMARY_ASSISTANT);
  const first = readDigestTail(file)[0].text;
  assistant.boardForTurn(PRIMARY_ASSISTANT);
  assert.equal(readDigestTail(file)[0].text, first, "an appended message never edits the one above it");

  // The cap is the transcript's own, and it keeps the newest: a rewrite drops whole messages from the front.
  for (let i = 0; i < 4; i += 1) appendDigestMessage(file, readDigestTail(file).at(-1), 3);
  const kept = readDigestTail(file);
  assert.equal(kept.length, 3, "the cap is the number kept");
  assert.equal(kept.at(-1).text, kept[0].text, "the messages the cap kept are whole messages");
});

test("the transcript's own relative path is beside the assistant's queue", async (t) => {
  const { assistant } = await panel(t);
  assert.equal(digestRelFor("assistant-2"), path.join("assistants", "assistant-2", "digest.jsonl"));
  assert.equal(assistant.digestPathFor({ id: "assistant-2" }).replace(/\\/g, "/").endsWith("assistants/assistant-2/digest.jsonl"), true);
});

test("readTurn is a pure module function, so a caller with no panel can use it", async () => {
  const out = readTurn("assistant-1/t1/j1", { jobs: { get: (id) => (id === "j1" ? run({ id: "j1", thread: "t1", finalMessage: "hello" }) : null) }, calls: 1 });
  assert.equal(out.ok, true);
  assert.equal(out.finalMessage, "hello");
  assert.equal(out.calls.length, 1, "calls is the number asked for");
  assert.deepEqual(readTurn("assistant-1/t1/j1", { jobs: { get: () => null } }), { ok: false, pointer: { assistant: "assistant-1", thread: "t1", turn: "j1" }, why: "no turn j1 in the job store" });
});

test("a message is JSON on one line, so a torn append cannot take the transcript with it", async (t) => {
  const { assistant, file } = await panel(t);
  assistant.boardForTurn(PRIMARY_ASSISTANT);
  const raw = await readFile(file, "utf8");
  assert.equal(raw.trim().split("\n").length, 1, "one message, one line");
  const parsed = JSON.parse(raw.trim());
  assert.equal(parsed.version, 1);
  assert.equal(parsed.items[0].id, "j1");
});
