// THE WAKE LADDER: every assistant is on it, and a wake addressed to a failed one moves to a healthy one.
//
// Measured on a board with a second assistant: `wake()` took the caller's id and started a turn on THAT thread, so a
// wake addressed to an assistant whose last run had failed died at its door — the run it was about was never read.
// The fix is one resolver (`wakeTarget`): the owner keeps the wake when its own last run is not failed; otherwise the
// roster is walked from Assistant #1 upward and the first assistant whose own last run is not failed receives it;
// when every assistant failed, the owner (else #1) keeps it and the journal says nobody was healthy.
//
// `supervise()` had the sibling defect: `jobs.list().find(j => j.thread === ASSISTANT_THREAD && isLive(j))` looked at
// one hardcoded thread, so a hung turn on Assistant #2's thread was never stopped and every wake for #2 sat behind it.
//
// What this pins:
//   1. the walk: #1 and #2 failed, #3 never ran -> #3 receives the wake, and the journal names both skips with reasons;
//   2. the owner is preferred: a healthy #2 owns the run, so #2 receives it even though #1 is healthy and lower;
//   3. the failure is read from BOTH halves of a run: a status of `done` whose outcome word is `failed` is failed;
//   4. all failed: the owner keeps it (and #1 when nobody named an owner), and the line says NOBODY was healthy;
//   5. a run that never ran is eligible: an assistant with no turns at all is a candidate;
//   6. the stall check walks every assistant's thread, judging each at its own quiet window.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";

const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const iso = (at) => new Date(at).toISOString();
const now = Date.now();

// A run as the job store hands it to the assistant: the assistant's own thread, a status, and the outcome its result
// carried. `outcome.reason` is what the journal line quotes, so the fixtures carry a real sentence.
function run({ id = "run-1", thread, status = "done", outcome = null, startedAt = now - 60_000, lines = [] } = {}) {
  return { id, thread, status, startedAt: iso(startedAt), endedAt: iso(startedAt + 30_000), outcome, lines };
}
const failed = (id, thread, reason = "exit code 1 (max_turns)", startedAt = now - 60_000) =>
  run({ id, thread, status: "failed", startedAt, outcome: { word: "failed", exitCode: 1, reason } });
const done = (id, thread, startedAt = now - 60_000) =>
  run({ id, thread, status: "done", startedAt, outcome: { word: "normal", exitCode: 0, reason: "" } });

async function board(t, { rows = [], stop = null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-wake-ladder-"));
  const said = [];
  const stopped = [];
  const assistant = new Assistant({
    config: {
      jobsFile: path.join(dir, "jobs.json"),
      assistantFile: path.join(dir, "assistant.json"),
      charterFile: path.join(dir, "assistant-charter.md"),
      defaultCwd: dir,
    },
    jobs: {
      list: () => rows,
      stop: async (id) => {
        stopped.push(id);
        return { ok: true };
      },
    },
    getProjects: () => [],
    onEvent: () => {},
    onLog: () => {},
  });
  // What goes out instead of a real turn: the text and the ASSISTANT the batch was submitted for.
  assistant.say = async (text, opts = {}) => {
    said.push({ text: String(text), assistantId: opts.assistantId || null });
    return { id: `said-${said.length}` };
  };
  t.after(async () => {
    if (assistant.wakeTimer) clearTimeout(assistant.wakeTimer);
    if (assistant.timer) clearInterval(assistant.timer);
    await rm(dir, { recursive: true, force: true });
  });
  return { assistant, said, stopped, rows, stop };
}

const routes = (assistant) => assistant.journal.filter((j) => j.kind === "wake-route");
const lastRoute = (assistant) => routes(assistant).at(-1)?.text || "";

test("a wake walks the roster from #1 upward and lands on the first assistant whose last run is not failed", async (t) => {
  const { assistant, said, rows } = await board(t);
  const two = assistant.createAssistant({}).created;
  const three = assistant.createAssistant({}).created;
  assert.deepEqual([assistant.assistants[0].id, two.id, three.id], ["assistant-1", "assistant-2", "assistant-3"]);

  rows.push(failed("a1-run", "panel-assistant", "exit code 1 (max_turns)"));
  // #2's card is `done` but its own result says failed: the outcome is the run's verdict, not the card's word.
  rows.push(run({ id: "a2-run", thread: two.threadId, status: "done", outcome: { word: "failed", exitCode: 2, reason: "the gateway lost the run" } }));
  // #3 has never run at all — an idle assistant is eligible, not failed.

  const out = assistant.wake("a worker settled in #1's tree", null, "settle", { assistantId: "assistant-1" });
  assert.equal(out.queued, true);
  await wait(300);

  assert.equal(said.length, 1, "exactly one turn was started");
  assert.equal(said[0].assistantId, "assistant-3", "#3 is the first assistant whose last run is not failed");
  const line = lastRoute(assistant);
  assert.match(line, /Assistant #3 took the wake/, line);
  assert.match(line, /skipped as failed: Assistant #1 \(exit code 1 \(max_turns\)\)/, line);
  assert.match(line, /Assistant #2 \(the gateway lost the run\)/, line);
});

test("a healthy owner keeps the wake even when a lower-numbered assistant is healthy and would come first", async (t) => {
  const { assistant, said, rows } = await board(t);
  const two = assistant.createAssistant({}).created;
  // #1 is healthy (a finished turn); #2 owns the run and is healthy. The ladder prefers the owner, not the number.
  rows.push(done("a1-run", "panel-assistant"));
  rows.push(done("a2-run", two.threadId, now - 30_000));

  assistant.wake("the owner's worker settled", null, "settle", { assistantId: "assistant-2" });
  await wait(300);

  assert.equal(said.length, 1);
  assert.equal(said[0].assistantId, "assistant-2", "the tree's owner received it");
  assert.match(lastRoute(assistant), /Assistant #2 took the wake/, lastRoute(assistant));
  assert.match(lastRoute(assistant), /no assistant was skipped as failed/, lastRoute(assistant));
});

test("when every assistant failed, the owner keeps the wake; with nobody named, #1 does — and the journal says so", async (t) => {
  const { assistant, said, rows } = await board(t);
  const two = assistant.createAssistant({}).created;
  rows.push(failed("a1-run", "panel-assistant", "exit code 1"));
  rows.push(failed("a2-run", two.threadId, "the gateway refused the turn"));

  assistant.wake("a wake addressed to a failed owner", null, "settle", { assistantId: "assistant-2" });
  await wait(300);
  assert.equal(said.length, 1);
  assert.equal(said[0].assistantId, "assistant-2", "the owner kept it rather than dropping it");
  assert.match(lastRoute(assistant), /Assistant #2 kept the wake though NOBODY was healthy/, lastRoute(assistant));
  assert.match(lastRoute(assistant), /every assistant's last run failed: Assistant #1 \(exit code 1\); Assistant #2 \(the gateway refused the turn\)/, lastRoute(assistant));

  // No caller names an owner: the ladder must keep Assistant #1, not drop the news on the floor.
  assistant.wake("a second thing, with nobody named", null, "resume");
  await wait(300);
  assert.equal(said.length, 2);
  assert.equal(said[1].assistantId, "assistant-1", "nobody named means #1 keeps the fallback wake");
});

test("the stall check walks every assistant's thread, not one hardcoded thread", async (t) => {
  const { assistant, rows, stopped } = await board(t);
  const two = assistant.createAssistant({}).created;
  assistant.settings.enabled = true;

  // #1 is silent past its window; #2 is silent past ITS window too, on its own thread. Both are live and neither can
  // be seen by `evaluate()` (which skips every assistant thread), so `supervise()` is the only thing that can stop them.
  rows.push({
    id: "a1-hung",
    thread: "panel-assistant",
    status: "running",
    startedAt: iso(now - 40 * 60_000),
    lines: [{ kind: "tool", text: "💻 terminal · x", at: now - 30 * 60_000 }],
  });
  rows.push({
    id: "a2-hung",
    thread: two.threadId,
    status: "running",
    startedAt: iso(now - 50 * 60_000),
    lines: [{ kind: "tool", text: "💻 terminal · y", at: now - 40 * 60_000 }],
  });

  const health = assistant.supervise();
  assert.deepEqual(health.stalledTurns.map((x) => [x.assistantId, x.turnId]), [
    ["assistant-1", "a1-hung"],
    ["assistant-2", "a2-hung"],
  ]);
  assert.equal(health.stalled, "a1-hung", "the first stalled turn is reported in the old field too");
  await wait(50);
  assert.deepEqual(stopped, ["a1-hung", "a2-hung"], "both stalled turns are stopped, not just #1's");
  const stallLines = assistant.journal.filter((j) => j.kind === "stalled").map((j) => `${j.thread}|${j.text}`);
  assert.ok(stallLines.some((l) => l.startsWith("panel-assistant|Assistant #1's turn a1-hung")), stallLines.join("\n"));
  assert.ok(stallLines.some((l) => l.startsWith(`${two.threadId}|Assistant #2's turn a2-hung`)), stallLines.join("\n"));
});
