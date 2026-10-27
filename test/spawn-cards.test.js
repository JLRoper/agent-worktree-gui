// A SPAWN line is a claim about the future, and both halves of that claim used to fail in silence: a card the
// reader never clicked (four sat open for an evening behind a badge number, and the reader concluded the agents
// had failed to spawn), and a line that produced no job and no card at all (the charter's open question).
//
// The first half is main's spawn watchdog (test/spawn-watch.test.js), which names an unstarted card in place and
// on its own badge; this file deliberately does not test it a second time. This file covers the second half,
// which nothing else watches: a SPAWN line that produced neither a job nor a card. It drives the parse-to-card
// path and that watchdog on an INJECTED clock. No wall-clock sleep is involved: `now()` is the only clock the
// watchdog reads, so advancing it is the whole test.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant, ASSISTANT_THREAD } from "../lib/assistant.js";
import { SPAWN_WATCH_MS } from "../lib/assistant/config.js";

const T0 = Date.parse("2026-10-26T20:00:00.000Z");
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const textLine = (text, at) => ({ kind: "text", text, at, lid: Math.random() });
const PROJECT = { name: "agent-worktree-gui", path: "C:/ProjectDevelopment/agent-worktree-gui" };

// A job summary of the shape jobs.summary() emits, carrying the fields these two watchdogs touch. The rest of
// the sentry's rules are driven by tools/verify-assistant.mjs; this file is only about spawns.
function job(over = {}) {
  return {
    id: "turn-1",
    thread: ASSISTANT_THREAD,
    status: "done",
    prompt: "(the assistant's own turn)",
    startedAt: iso(T0 - 2 * MIN),
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
    ...over,
  };
}

function harness(t, { now = () => T0, spawn = "ask" } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-spawn-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const started = [];
  const state = { board: [] };
  const jobs = {
    list: () => state.board,
    firstOfThread: (thread) => state.board.find((j) => j.thread === thread) || null,
    busyFor: () => ({ held: false, where: null, by: [] }),
    modelFor: () => null,
    create: async (opts) => ({ id: "job-created", ...opts }),
    answerQuestion: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    get: () => null,
    clarify: { state: () => null },
  };
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile: path.join(dir, "assistant.json"), defaultCwd: dir },
    jobs,
    getProjects: () => [PROJECT],
    spawner: async (spec) => {
      started.push(spec);
      return { id: "job-spawned", thread: "wtgui-docs-1" };
    },
    now,
  });
  assistant.settings.spawn = spawn;
  return { assistant, started, state, dir };
}

// ---------------------------------------------------------------------------------------------
// parse to card: the ask-me-first path still asks, and the card names the turn that wrote the line
// ---------------------------------------------------------------------------------------------

test("a SPAWN line becomes one card that names its turn, and starts nothing", async (t) => {
  const { assistant, started, state } = harness(t);
  state.board = [];

  await assistant.harvest({
    id: "turn-a",
    thread: ASSISTANT_THREAD,
    lines: [textLine("SPAWN agent-worktree-gui | write the docs for the board", T0)],
  });

  const cards = assistant.state().alerts.filter((a) => a.spawn);
  assert.equal(cards.length, 1, "one SPAWN line is one card");
  const [card] = cards;
  assert.equal(card.rule, "spawn");
  assert.equal(card.status, "open");
  assert.equal(card.spawn.project, PROJECT.name);
  assert.equal(card.spawn.prompt, "write the docs for the board");
  assert.equal(card.spawn.turnId, "turn-a", "the card remembers the turn that proposed it");
  assert.equal(card.spawn.thread, ASSISTANT_THREAD);
  assert.equal(started.length, 0, "ask mode starts nothing by itself — that is the whole contract");

  // The debt the watchdog reads is settled by the card, not left owed.
  assert.equal(assistant.spawnIntents.length, 1);
  assert.equal(assistant.spawnIntents[0].outcome, "card");
  assert.equal(assistant.spawnIntents[0].alertId, card.id);


  // One turn is harvested once: the same turn re-emitted does not open a second card.
  await assistant.harvest({
    id: "turn-a",
    thread: ASSISTANT_THREAD,
    lines: [textLine("SPAWN agent-worktree-gui | write the docs for the board", T0)],
  });
  assert.equal(assistant.state().alerts.filter((a) => a.spawn).length, 1);

  // The click is the only thing that starts it, and it closes the card.
  const spec = assistant.pendingSpawn(card.id);
  assert.ok(spec, "the card still offers its spawn spec");
  await assistant.startSpawn(spec, { alertId: card.id });
  assert.equal(started.length, 1, "confirming the card is what starts the worker");
  assert.equal(assistant.state().alerts.filter((a) => a.spawn).length, 0, "a started card is done, not waiting");
});

// ---------------------------------------------------------------------------------------------
// watchdog 1: a card still open after two minutes
// ---------------------------------------------------------------------------------------------

// the vanished line: a turn's SPAWN line that produced neither a job nor a card
// ---------------------------------------------------------------------------------------------

test("a SPAWN line that produced nothing is journaled as lost and alerted", async (t) => {
  // Boot ten minutes before the turn ends, so the turn is inside this process's own watch.
  let now = T0 - 10 * MIN;
  const { assistant, started, state } = harness(t, { now: () => now });
  // The harvest never reads this turn: it is the charter's failure, a line with no job, no card and no
  // journal entry. Only the turn's own console holds it.
  const ended = T0 - 3 * MIN;
  state.board = [
    job({
      id: "turn-lost",
      status: "done",
      startedAt: iso(ended - 2 * MIN),
      endedAt: iso(ended),
      lines: [textLine("SPAWN agent-worktree-gui | run the release checks and report", ended)],
    }),
  ];
  now = T0;

  assistant.checkSpawns(state.board);

  const lost = assistant.state().alerts.filter((a) => a.rule === "spawnlost");
  assert.equal(lost.length, 1, "a line that became nothing is one alert");
  assert.equal(lost[0].severity, "bad");
  assert.match(lost[0].detail, /turn turn-lost/);
  assert.match(lost[0].detail, /run the release checks and report/);
  assert.equal(lost[0].evidence.find((e) => e.label === "line")?.value, "SPAWN agent-worktree-gui");
  assert.ok(
    assistant.state().journal.some((j) => j.kind === "spawnlost" && /neither a worker nor a card/.test(j.text)),
    "it is journaled as a lost line, which is the record the panel never had",
  );
  assert.equal(started.length, 0, "nothing is started by the watchdog");
  assert.equal(assistant.state().alerts.filter((a) => a.spawn).length, 0, "no card appeared for it either");

  // The debt is closed, so a second pass is not a second alert, and the digest repeats it rather than losing it.
  assistant.checkSpawns(state.board);
  assert.equal(assistant.state().alerts.filter((a) => a.rule === "spawnlost").length, 1);
  assert.match(assistant.state().digest, /SPAWN LINES THAT PRODUCED NOTHING/);
});

test("a lost line is still inside the window one minute after its turn ended", async (t) => {
  let now = T0 - 10 * MIN;
  const { assistant, state } = harness(t, { now: () => now });
  const ended = T0 - MIN;
  state.board = [job({ id: "turn-early", status: "done", endedAt: iso(ended), lines: [textLine("SPAWN agent-worktree-gui | later", ended)] })];
  now = T0;
  assistant.checkSpawns(state.board);
  assert.equal(assistant.state().alerts.filter((a) => a.rule === "spawnlost").length, 0, "a minute is not two");

  now = T0 + MIN + 1_000;
  assistant.checkSpawns(state.board);
  assert.equal(assistant.state().alerts.filter((a) => a.rule === "spawnlost").length, 1, "and two is the window");
});

test("a turn the harvest did read is not a lost line", async (t) => {
  let now = T0 - 10 * MIN;
  const { assistant, started, state } = harness(t, { now: () => now });
  const turn = job({ id: "turn-ok", status: "done", endedAt: iso(T0), lines: [textLine("SPAWN agent-worktree-gui | the docs", T0)] });
  state.board = [turn];
  await assistant.harvest(turn);
  assert.equal(assistant.state().alerts.filter((a) => a.spawn).length, 1, "the harvest opened the card");

  // Three minutes later the board scan reads the same line again: it finds the debt already settled by the
  // card, so the line is not reported as lost a second time.
  now = T0 + 3 * MIN;
  assistant.checkSpawns(state.board);
  assert.equal(assistant.state().alerts.filter((a) => a.rule === "spawnlost").length, 0);
  assert.equal(started.length, 0);
});
