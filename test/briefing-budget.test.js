// The turn briefing budget: a ceiling, a cut at a line boundary, and a turn that fits left byte for byte.
//
// The number exists because a turn is the only text a panel pays for per wake, and the bill is the whole request:
// measured on a live panel the API calls ran p50 123,786 input tokens (p90 253,442), every one of them re-read on
// each call of the turn. The knob has to be safe to set, which is what these four cases pin: off is the old
// behaviour exactly, a fitting turn is untouched, an over-budget turn keeps the queue and says in its own words that
// the tail was cut, and the stored value cannot escape its own range.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Assistant } from "../lib/assistant.js";
import { PRIMARY_ASSISTANT } from "../lib/assistants.js";
import { DEFAULTS, pickSettings } from "../lib/assistant/config.js";

function makeJobs() {
  return {
    list: () => [],
    firstOfThread: () => null,
    create: async (body) => ({ id: "job-1", ...body }),
  };
}

async function panel(t, settings = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-budget-"));
  const assistant = new Assistant({
    config: {
      jobsFile: path.join(dir, "jobs.json"),
      assistantFile: path.join(dir, "assistant.json"),
      charterFile: path.join(dir, "assistant-charter.md"),
      assistant: settings,
    },
    jobs: makeJobs(),
    getRows: () => [],
    onLog: () => {},
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return assistant;
}

const board = (n = 400) => Array.from({ length: n }, (_, i) => `row ${i}: a worktree with a branch and a verdict`).join("\n");

test("a budget of zero is the old behaviour: the turn is sent whole", async (t) => {
  const assistant = await panel(t, { briefingBudgetChars: 0 });
  const text = assistant.turnBriefing(PRIMARY_ASSISTANT, { queue: true, board: board() });
  assert.match(text, /The board tail \(one message this turn\):/, "the board block is there");
  assert.doesNotMatch(text, /briefing cut at/, "and nothing claims it was cut");
});

test("a turn that fits the budget is untouched", async (t) => {
  const roomy = await panel(t, { briefingBudgetChars: 40_000 });
  const text = roomy.turnBriefing(PRIMARY_ASSISTANT, { board: board(20) });
  assert.doesNotMatch(text, /briefing cut at/, "a turn inside its budget carries no cut sentence");
  assert.match(text, /The board tail \(one message this turn\):/, "and its board block is still the tail");
  assert.ok(text.length < 40_000, "the fixture turn is far smaller than the ceiling");
});

test("an over-budget turn keeps the queue, cuts at a line boundary and says so", async (t) => {
  const assistant = await panel(t, { briefingBudgetChars: 800 });
  const text = assistant.turnBriefing(PRIMARY_ASSISTANT, { queue: true, board: board() });
  assert.ok(text.length <= 800, `the turn is within its budget (${text.length} chars)`);
  assert.match(text, /briefing cut at 800 chars/, "the sentence names the number it stopped at");
  assert.match(text, /Read your queue first/, "the head — the queue — is what survives");
  assert.ok(!text.includes("row 399"), "the tail is what went");
  assert.ok(!text.endsWith("\n"), "the cut does not leave a dangling line");
});

test("the knob clamps to its own range, so a stored value cannot escape it", () => {
  assert.equal(pickSettings({ briefingBudgetChars: 99_999 }, DEFAULTS).briefingBudgetChars, 40_000);
  assert.equal(pickSettings({ briefingBudgetChars: -5 }, DEFAULTS).briefingBudgetChars, 0, "below zero is off, not negative");
  assert.equal(pickSettings({ briefingBudgetChars: "16000" }, DEFAULTS).briefingBudgetChars, 16_000, "a string from the wire is a number");
  assert.equal(pickSettings({}, DEFAULTS).briefingBudgetChars, undefined, "a knob nobody named is not written by a picker");
});
