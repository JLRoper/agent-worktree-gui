// The harvest gate reads EVERY assistant's finished turn, not only Assistant #1's.
//
// What this file is the contract for:
//
//   1. A second assistant's turn is harvested as ITS turn. `applyActions` already resolves `who` from the job and
//      stamps a SPAWN card with `assistantId: assistant-2`; the gate in `observe` was the only thing still reading
//      `ASSISTANT_THREAD`, so #2's SPAWN and NOTE were dropped in silence while its card repainted.
//
//   2. Assistant #1's turn still harvests: the gate widened, it did not move, and a #1 card keeps the pre-assistant
//      shape (no stamp at all).
//
//   3. The COMPLETE-chip ledger is keyed per assistant. A #2 turn clears #2's asks and leaves #1's alone (and the
//      reverse). Clearing the whole map on any assistant turn made a #1 turn eat a #2 ask the reader had just
//      pressed, so the next press on that card was queued as a fresh question to #2 before #2 read the first one.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant, ASSISTANT_THREAD } from "../lib/assistant.js";
import { PRIMARY_ASSISTANT } from "../lib/assistants.js";

const T0 = Date.now() - 60_000;
const iso = (ms) => new Date(ms).toISOString();
const textLine = (text, at = T0) => ({ kind: "text", text, at, lid: Math.random() });
const PROJECT = { name: "agent-worktree-gui", path: "C:/ProjectDevelopment/agent-worktree-gui" };
const tick = () => new Promise((r) => setTimeout(r, 20));

// A job summary of the shape jobs.summary() emits, carrying the fields the harvest and the COMPLETE ledger touch.
function turn(over = {}) {
  return {
    id: "turn-1",
    thread: ASSISTANT_THREAD,
    status: "done",
    prompt: "(the assistant's own turn)",
    startedAt: iso(T0 - 60_000),
    endedAt: iso(T0),
    lines: [],
    artifacts: [],
    approval: null,
    stats: null,
    ownerPath: null,
    cwd: "C:/panel/assistant-cwd",
    label: null,
    title: "the assistant",
    model: null,
    turn: 1,
    budget: 1800,
    maxTurns: null,
    assistant: true,
    ...over,
  };
}

async function panel(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-harvest-gate-"));
  const rows = [];
  const assistant = new Assistant({
    config: {
      jobsFile: path.join(dir, "jobs.json"),
      assistantFile: path.join(dir, "assistant.json"),
      charterFile: path.join(dir, "assistant-charter.md"),
      defaultCwd: dir,
    },
    jobs: {
      list: () => rows,
      get: (id) => rows.find((j) => j.id === id) || null,
      firstOfThread: (thread) => rows.find((j) => j.thread === thread) || null,
      busyFor: () => ({ held: false, where: null, by: [] }),
      create: async (body) => {
        const job = { id: `job-${rows.length + 1}`, ...body };
        rows.push(job);
        return job;
      },
      modelFor: () => null,
      stop: async () => ({ ok: true }),
      answerQuestion: async () => ({ ok: true }),
      clarify: { state: () => null },
    },
    getProjects: () => [PROJECT],
    spawner: async (spec) => ({ id: "job-spawned", thread: "wtgui-docs-1", ...spec }),
    now: () => T0,
    onLog: () => {},
  });
  // A wake is a real turn in the panel; a test never talks to a gateway.
  assistant.say = async () => ({ id: "said" });
  t.after(async () => {
    for (const timer of ["wakeTimer", "settleTimer", "timer"]) {
      if (assistant[timer]) clearTimeout(assistant[timer]);
    }
    await rm(dir, { recursive: true, force: true });
  });
  return { assistant, rows };
}

test("a second assistant's finished turn is harvested as its own", async (t) => {
  const { assistant } = await panel(t);
  const second = assistant.createAssistant({ roleId: "agent-manager", name: "Reviewer" }).created;
  assistant.observe({
    type: "job",
    job: turn({
      id: "turn-second",
      thread: second.threadId,
      assistant: true,
      lines: [textLine("Cutting a tree for this.\n\nSPAWN agent-worktree-gui | write the docs\n\nNOTE: keep the log")],
    }),
  });
  await tick();

  const cards = assistant.state().alerts.filter((a) => a.spawn);
  assert.equal(cards.length, 1, "#2's SPAWN opened a card — its finished turn was read");
  assert.equal(cards[0].spawn.assistantId, second.id, "the card is stamped with the assistant that wrote the line");
  assert.match(assistant.notesFor(second.id), /keep the log/, "#2's NOTE landed in #2's own pad");
  assert.ok(!assistant.notesFor(PRIMARY_ASSISTANT).includes("keep the log"), "and not in Assistant #1's");
});

test("Assistant #1's finished turn still harvests", async (t) => {
  const { assistant } = await panel(t);
  assistant.observe({
    type: "job",
    job: turn({ id: "turn-primary", lines: [textLine("SPAWN agent-worktree-gui | write the docs")] }),
  });
  await tick();

  const cards = assistant.state().alerts.filter((a) => a.spawn);
  assert.equal(cards.length, 1, "#1's SPAWN still opens its card");
  assert.equal(cards[0].spawn.assistantId, undefined, "a #1 card keeps the record shape every earlier build wrote");
});

test("a #2 turn does not clear #1's COMPLETE ask, and #1's own turn does", async (t) => {
  const { assistant, rows } = await panel(t);
  const second = assistant.createAssistant({ roleId: "agent-manager", name: "Reviewer" }).created;
  const run = turn({ id: "run-1", thread: "wtgui-docs-111111", assistant: false, assistantId: PRIMARY_ASSISTANT, turn: 1 });
  rows.push(run);

  assert.equal(assistant.askAboutComplete("run-1").queued, true, "the first press queues the ask");
  const repeat = assistant.askAboutComplete("run-1");
  assert.equal(repeat.duplicate, true, "the second press before any turn is the duplicate the ledger exists for");
  assert.equal(repeat.queued, false);

  assistant.observe({ type: "job", job: turn({ id: "turn-second", thread: second.threadId, assistant: true }) });
  await tick();
  assert.equal(assistant.askAboutComplete("run-1").duplicate, true, "#2's turn did not answer #1's ask");

  assistant.observe({ type: "job", job: turn({ id: "turn-primary" }) });
  await tick();
  const after = assistant.askAboutComplete("run-1");
  assert.equal(after.duplicate, false, "#1's own turn read the ask, so the next press is a new question");
  assert.equal(after.queued, true);
});

test("a #1 turn does not clear #2's COMPLETE ask, and #2's own turn does", async (t) => {
  const { assistant, rows } = await panel(t);
  const second = assistant.createAssistant({ roleId: "agent-manager", name: "Reviewer" }).created;
  const run = turn({ id: "run-2", thread: "wtgui-docs-222222", assistant: false, assistantId: second.id, turn: 1 });
  rows.push(run);

  assert.equal(assistant.askAboutComplete("run-2").queued, true);
  assistant.observe({ type: "job", job: turn({ id: "turn-primary" }) });
  await tick();
  assert.equal(assistant.askAboutComplete("run-2").duplicate, true, "#1's turn did not eat the ask #2 had not read");

  assistant.observe({ type: "job", job: turn({ id: "turn-second", thread: second.threadId, assistant: true }) });
  await tick();
  assert.equal(assistant.askAboutComplete("run-2").duplicate, false, "#2's own turn is what clears it");
});
