// Change 3 of the approved gateway fixes: the board digest stops riding every turn.
//
// The board digest — the block under "The board right now:" — was the biggest fixed cost of a turn (about 8 KB on a
// busy board), and it went out on every turn, including the sweep turns that find the board exactly as they left it.
// This file is the contract for what decides it, and it is the four cases the item names plus the one guarantee that
// must survive:
//
//   1. an event turn — a wake whose rule is not in SWEEP_WAKE_RULES — always carries the full digest;
//   2. a turn the reader writes always carries it;
//   3. a sweep turn whose board signature changed carries it, and every Nth sweep carries it with N in the settings;
//   4. every other sweep carries a one-line marker instead, naming the board's signature and its row count.
//
// The marker's signature is `lib/scan.js`'s own `boardSignature` over the per-row signature the scan computes — never
// a second hash minted here, which is the mistake that would let the marker and the scan disagree about the board.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { PRIMARY_ASSISTANT } from "../lib/assistants.js";
import { SWEEP_WAKE_RULES } from "../lib/assistant/config.js";
import { boardSignature } from "../lib/scan.js";

const SWEEP = { kind: "assistant-wake", rule: "quiet", event: false };
const EVENT = { kind: "assistant-wake", rule: "settle", event: true };

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

function makeJobs() {
  return {
    list: () => [
      { id: "j1", thread: "t1", title: "worker one", status: "running", startedAt: "2026-11-02T00:00:00Z", prompt: "land change 3", lines: [] },
      {
        id: "j2",
        thread: "t2",
        title: "worker two",
        status: "done",
        startedAt: "2026-11-02T00:10:00Z",
        endedAt: "2026-11-02T00:20:00Z",
        prompt: "review the board",
        lines: [],
      },
    ],
    firstOfThread: () => null,
    create: async (body) => ({ id: "job-1", ...body }),
  };
}

async function panel(t, { rows = [makeRow()], n = 2 } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-digest-"));
  const assistant = new Assistant({
    config: {
      jobsFile: path.join(dir, "jobs.json"),
      assistantFile: path.join(dir, "assistant.json"),
      charterFile: path.join(dir, "assistant-charter.md"),
      assistant: { digestSweepEveryNWakes: n },
    },
    jobs: makeJobs(),
    getRows: () => rows,
    onLog: () => {},
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { assistant, rows };
}

const isMarker = (text) => /^\[Board unchanged —/.test(text);

test("an event turn carries the full board, however the counter reads", async (t) => {
  const { assistant } = await panel(t);
  assert.equal(SWEEP_WAKE_RULES.has("settle"), false, "settle is the event this test wakes on");
  const first = assistant.boardForTurn(PRIMARY_ASSISTANT, EVENT);
  assert.equal(first, assistant.digest(), "the event turn's board is the whole digest");
  assert.equal(isMarker(first), false, "not the marker");
  // An event is never gated on the sweep counter: a second event turn carries it again.
  assert.equal(assistant.boardForTurn(PRIMARY_ASSISTANT, EVENT), assistant.digest());
});

test("a turn the reader writes carries the full board", async (t) => {
  const { assistant } = await panel(t);
  const text = assistant.boardForTurn(PRIMARY_ASSISTANT, null);
  assert.equal(text, assistant.digest(), "the reader's own turn always sees the board in full");
  assert.equal(isMarker(text), false);
});

test("a sweep turn with an unchanged board pays the marker, signed by lib/scan.js", async (t) => {
  const { assistant, rows } = await panel(t);
  // The first two sweeps prime the record: the first because the board's signature is new to this assistant, the
  // second because it is the Nth sweep (the default N is 2). The third finds both of those reasons spent.
  assistant.boardForTurn(PRIMARY_ASSISTANT, SWEEP);
  assistant.boardForTurn(PRIMARY_ASSISTANT, SWEEP);
  const text = assistant.boardForTurn(PRIMARY_ASSISTANT, SWEEP);

  const expectedSig = boardSignature(rows).slice(0, 12);
  assert.match(text, /^\[Board unchanged — 1 row, signature [0-9a-f]{12}\./, "one line, the row count and the signature");
  assert.ok(text.includes(expectedSig), `the marker's signature is lib/scan.js's boardSignature (${expectedSig})`);
  assert.ok(!text.includes("The board right now"), "the marker is not the digest under its heading");
  assert.ok(text.length < assistant.digest().length, "and it is smaller than the digest it replaces");
});

test("a sweep turn after a row changes carries the full board again", async (t) => {
  const { assistant, rows } = await panel(t);
  assistant.boardForTurn(PRIMARY_ASSISTANT, SWEEP);
  assistant.boardForTurn(PRIMARY_ASSISTANT, SWEEP);
  const before = boardSignature(rows);
  rows[0] = makeRow("def5678");
  assert.notEqual(boardSignature(rows), before, "the row's own signature moved with its tip");
  assert.equal(assistant.boardForTurn(PRIMARY_ASSISTANT, SWEEP), assistant.digest(), "so the turn gets the board in full");
});

test("N sends the full board one sweep in N, and the rest are markers", async (t) => {
  const { assistant } = await panel(t, { n: 3 });
  assert.equal(assistant.settingsFor(PRIMARY_ASSISTANT).digestSweepEveryNWakes, 3, "N is the settings knob");
  const turns = [1, 2, 3, 4].map(() => assistant.boardForTurn(PRIMARY_ASSISTANT, SWEEP));
  // Turn 1 is full because the signature is new; 2 and 4 are markers because they are not the Nth; 3 is the Nth.
  assert.equal(turns[0], assistant.digest());
  assert.equal(isMarker(turns[1]), true);
  assert.equal(turns[2], assistant.digest());
  assert.equal(isMarker(turns[3]), true);
});

test("a reader turn and an event turn do not spend the sweep counter", async (t) => {
  const { assistant } = await panel(t, { n: 2 });
  // A reader turn and an event turn carry the board in full and record its signature, but neither is a sweep: the
  // first sweep after them is still the first, so it is not the Nth and pays the marker. If either had spent the
  // counter, that sweep would be tick 2 and would carry the digest again.
  assistant.boardForTurn(PRIMARY_ASSISTANT, null);
  assistant.boardForTurn(PRIMARY_ASSISTANT, EVENT);
  assert.equal(isMarker(assistant.boardForTurn(PRIMARY_ASSISTANT, SWEEP)), true, "the first sweep is still the first");
  assert.equal(assistant.boardForTurn(PRIMARY_ASSISTANT, SWEEP), assistant.digest(), "and the second is the Nth");
});
