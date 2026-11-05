// The assistant's own turn, across a restart that no longer writes a live card off.
//
// `Jobs.load()` leaves a turn that was running with a run id `running` until the boot reconcile has asked the
// gateway. The assistant's boot check reads that board, so it must NOT treat `running` as "the panel died
// mid-thought": the card may still be re-attached, and spending the one resume on it would leave the turn the
// gateway really lost with no wake when the answer arrives a moment later.
//
//   node --test test/assistant-resume-restored.test.js
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ASSISTANT_THREAD, Assistant } from "../lib/assistant.js";

const START = new Date(Date.now() - 5 * 60_000).toISOString();
// The one turn the assistant itself ran, in the shape `Jobs.summary()` publishes.
const turn = (over = {}) => ({
  id: "asst-1",
  thread: ASSISTANT_THREAD,
  turn: 1,
  prompt: "look at the board",
  cwd: "/state/assistant-cwd",
  sessionId: ASSISTANT_THREAD,
  status: "running",
  startedAt: START,
  endedAt: null,
  runId: "run_asst_1",
  assistant: true,
  lines: [],
  ...over,
});

async function makeBoard(t, first) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-assistant-resume-"));
  const board = [first];
  const assistant = new Assistant({
    config: {
      jobsFile: path.join(dir, "jobs.json"),
      assistantFile: path.join(dir, "assistant.json"),
      charterFile: path.join(dir, "assistant-charter.md"),
      defaultCwd: dir,
    },
    jobs: { list: () => board, api: { url: "http://127.0.0.1:1" }, headers: () => ({}) },
    getProjects: () => [],
    getRows: () => [],
    onEvent: () => {},
    onLog: () => {},
  });
  assistant.settings.enabled = true;
  t.after(async () => {
    if (assistant.wakeTimer) clearTimeout(assistant.wakeTimer);
    if (assistant.timer) clearInterval(assistant.timer);
    if (assistant.persistTimer) clearTimeout(assistant.persistTimer);
    await rm(dir, { recursive: true, force: true });
  });
  return { assistant, board };
}

test("a restored turn still waiting for the gateway does not spend the one resume", async (t) => {
  const { assistant, board } = await makeBoard(t, turn());

  assert.equal(assistant.resumeAfterRestart(), null, "running is not a verdict, so nothing is resumed");
  assert.equal(assistant.resumed, false, "the one resume is still there to spend");

  // The reconcile's answer arrives: the gateway has no record of the run, so the card is interrupted.
  board[0] = turn({ status: "interrupted", endedAt: new Date().toISOString() });
  assert.equal(assistant.resumeAfterRestart(), "asst-1", "the answer that settles it still wakes the assistant once");
  assert.equal(assistant.resumedTurn, "asst-1", "and the wake names the turn it resumed");
  assert.equal(assistant.resumeAfterRestart(), null, "a second call in the same process does nothing");
});

test("a turn the gateway still holds is re-attached and never resumed", async (t) => {
  const { assistant } = await makeBoard(t, turn());
  assert.equal(assistant.resumeAfterRestart(), null, "a running turn is not resumed");
  // The reconcile answered re-attached: the card is running and no resume was spent, so a later boot could ask again.
  assert.equal(assistant.resumed, false);
  assert.equal(assistant.resumedTurn, null);
});
