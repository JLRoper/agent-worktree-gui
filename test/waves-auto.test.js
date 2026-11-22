// THE AUTO SWITCH: ONE PER WAVE, DEFAULT OFF, AND IT OPENS THE NEXT WAVE ON A READ.
//
// This file is the acceptance the brief names, one test per clause:
//
//   1. A wave with `auto` absent or false NEVER opens the next one, even when its exit gate reads met. Default is not
//      a lesser case: the next wave is opened by a person, and that is what the record says.
//   2. With `auto` true and the exit gate reading met - from the SAME live evidence the gate chip is drawn from - the
//      next wave opens, and its `autoOpen` record names the wave that opened it and the evidence it read.
//   3. With `auto` true and the gate answering cannot tell NOTHING opens, and the sentence carries the evidence
//      reader's own reason, so the reader can see what was unreadable rather than a bare "blocked".
//   4. An auto-opened wave inherits nothing: its own `auto` is its record's, absent is false, so wave 2 opening does
//      not open wave 3. Switching wave 1's auto back off shuts wave 2 on the very next read.
//   5. A met exit is necessary and not enough: a wave that still holds a run opens no successor, because the fold
//      keeps that wave open (deriveWaveState's running clause) and this read applies the same rule.
//   6. Nothing is stored and membership stays explicit: `waveLane` over a real `waves.json` answers `autoOpen`, the
//      file is byte-identical afterwards, and an auto-opened wave holds its OWN members - or none - never a copy of
//      the predecessor's.
//
// The lane markup is test/waves-lane.test.js's subject; the two unit-level cases that need a hand-built gate answer
// (a met exit while a member runs) live here, beside the derivation they judge.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { WAVE_AUTO_BY, Waves, waveAutoOpens, waveLane, waveView } from "../lib/waves.js";

const member = (id, state, over = {}) => ({
  id,
  title: `task ${id}`,
  state,
  project: "proj",
  worktree: `/work/proj/.worktrees/t${id}`,
  lane: null,
  files: [],
  pipeline: null,
  pr: null,
  hasRow: true,
  dirty: 0,
  ahead: 1,
  verdict: null,
  ...over,
});

const wave = (id, position, over = {}) => ({
  id,
  initiativeId: "init_a",
  position,
  title: `wave ${position}`,
  entryGate: null,
  exitGate: { check: "pr-merged" },
  template: null,
  ...over,
});

// The live evidence a gate reads (lib/wave-evidence.js): the PR through the API, and the landing judged by content.
const mergedEvidence = (number = 7, over = {}) => ({
  number,
  pr: { number, state: "MERGED", mergedAt: "2026-11-21T00:00:00.000Z", headRefOid: "a".repeat(40) },
  why: null,
  landing: { state: "landed", why: "origin/main 1234567 holds the recorded sha's content in 1 file", main: "origin/main" },
  ...over,
});
const blindEvidence = (over = {}) => ({
  number: null,
  pr: null,
  why: "the member names no pull request, so no API read can be made for it",
  landing: { state: "unknown", why: "the member records no sha, so there is no content to find on main", main: "origin/main" },
  ...over,
});
const evidenceFor = (byId) => (m) => byId[m.id] || null;

const view = (record, members = [], evidence = null) => waveView({ wave: record, members, evidenceFor: evidence });

test("the first wave is opened by a person: there is no earlier switch to read", () => {
  const [first] = waveAutoOpens([{ id: "wave_01", auto: true, state: "ready", stateWhy: "entry met", gates: { exit: null } }]);
  assert.equal(first.open, false);
  assert.equal(first.by, "hand");
  assert.ok(WAVE_AUTO_BY.includes(first.by), "the record's by is one of the two words the module names");
  assert.equal(first.from, null);
  assert.match(first.why, /is first in this initiative's sequence/);
  assert.match(first.why, /a person opens it/);
});

test("the sequence is the records the store read: a gap in position is stepped over, and the wave before is read", () => {
  // Position 2 was refused by the loader and is drawn with its sentence beside the lane (waves-store.test.js). It is
  // not a wave this read can judge, so the wave at position 3 reads the one at position 1 - the previous wave the
  // sequence actually holds - rather than pretending the gap is a closed wave.
  const one = view(wave("wave_01", 1, { auto: true }), [member(1, "done", { pr: { number: 7, state: "MERGED" } })], evidenceFor({ 1: mergedEvidence(7) }));
  const three = view(wave("wave_03", 3), [member(3, "queued")]);
  const [, third] = waveAutoOpens([one, three]);
  assert.equal(third.open, true);
  assert.equal(third.from, "wave_01");
});

test("auto absent or false never opens the next wave, even when its exit gate reads met", () => {
  const one = view(wave("wave_01", 1, { auto: false, exitGate: { check: "pr-merged" } }), [member(1, "done", { pr: { number: 7, state: "MERGED" } })], evidenceFor({ 1: mergedEvidence(7) }));
  const two = view(wave("wave_02", 2), [member(2, "queued")]);
  assert.equal(one.gates.exit.state, "met", "the premise: the exit gate really does read met from the live evidence");
  assert.equal(one.state, "done");
  const [first, second] = waveAutoOpens([one, two]);
  assert.equal(first.open, false);
  assert.equal(second.open, false, "auto off means the next wave is NOT opened, whatever the gate says");
  assert.equal(second.by, "hand");
  assert.equal(second.from, "wave_01", "the record still names the wave whose switch was read");
  assert.equal(second.switchOn, false);
  assert.match(second.why, /wave_01 has auto off/);
  assert.match(second.why, /whatever its exit gate reads/);

  // A record with `auto` absent is the same answer, because pickWave keeps only a real boolean true.
  const absent = view(wave("wave_02", 2), [member(2, "queued")]);
  delete absent.auto;
  const [, shut] = waveAutoOpens([{ ...one, auto: undefined }, absent]);
  assert.equal(shut.open, false);
  assert.match(shut.why, /has auto off/);
});

test("auto true and a met exit gate opens the next wave, and the record names what opened it", () => {
  const one = view(wave("wave_01", 1, { auto: true }), [member(1, "done", { pr: { number: 7, state: "MERGED" } })], evidenceFor({ 1: mergedEvidence(7) }));
  const two = view(wave("wave_02", 2, { auto: false, exitGate: null }), [member(2, "queued")]);
  const [first, second] = waveAutoOpens([one, two]);
  assert.equal(first.open, false, "the switch opens the NEXT wave; it does not open the wave that carries it");
  assert.equal(second.open, true);
  assert.equal(second.by, "auto");
  assert.equal(second.from, "wave_01");
  assert.equal(second.switchOn, true);
  assert.equal(second.gate.state, "met", "the gate in the record is the SAME answer the lane draws for wave_01");
  assert.equal(second.gate, one.gates.exit);
  assert.match(second.why, /wave_01 has auto on and its exit gate reads met/);
  assert.match(second.why, /holds the recorded sha's content/, "the evidence sentence rides the record, so the reader can check it");
  assert.match(second.why, /opened by itself on this read/);
  assert.match(second.why, /nothing was started/, "an open is not a start, and the record says so");
});

test("auto true and a gate that cannot tell opens nothing, and the reason names the unreadable evidence", () => {
  const one = view(wave("wave_01", 1, { auto: true }), [member(1, "done", { pr: { number: 7, state: "MERGED" } })], evidenceFor({ 1: blindEvidence() }));
  const two = view(wave("wave_02", 2), [member(2, "queued")]);
  assert.equal(one.gates.exit.state, "unknown", "the stored MERGED word is not evidence: with no live read the gate cannot tell");
  const [, second] = waveAutoOpens([one, two]);
  assert.equal(second.open, false);
  assert.equal(second.switchOn, true, "the switch is on - the record does not hide that");
  assert.match(second.why, /exit gate cannot be read/);
  assert.match(second.why, /names no pull request/, "the evidence reader's own sentence is carried");
  assert.match(second.why, /stays shut/);
});

test("an auto-opened wave is itself default-off, so a chain cannot run away by inheritance", () => {
  const evidence = evidenceFor({ 1: mergedEvidence(7), 2: mergedEvidence(8), 3: mergedEvidence(9) });
  const one = view(wave("wave_01", 1, { auto: true }), [member(1, "done", { pr: { number: 7, state: "MERGED" } })], evidence);
  const two = view(wave("wave_02", 2, { auto: false }), [member(2, "done", { pr: { number: 8, state: "MERGED" } })], evidence);
  const three = view(wave("wave_03", 3), [member(3, "done", { pr: { number: 9, state: "MERGED" } })], evidence);
  const [first, second, third] = waveAutoOpens([one, two, three]);
  assert.equal(first.open, false);
  assert.equal(second.open, true, "wave_01's switch opened wave_02");
  assert.equal(two.auto, false, "the opened wave carries the switch its OWN record says: false");
  assert.equal(third.open, false, "wave_02's switch is off, so wave_03 does not open - the chain stops here");
  assert.equal(third.from, "wave_02");
  assert.match(third.why, /wave_02 has auto off/);
});

test("switching auto back off shuts the next wave on the next read", () => {
  const one = view(wave("wave_01", 1, { auto: true }), [member(1, "done", { pr: { number: 7, state: "MERGED" } })], evidenceFor({ 1: mergedEvidence(7) }));
  const two = view(wave("wave_02", 2), [member(2, "queued")]);
  assert.equal(waveAutoOpens([one, two])[1].open, true);
  const backOff = view(wave("wave_01", 1, { auto: false }), [member(1, "done", { pr: { number: 7, state: "MERGED" } })], evidenceFor({ 1: mergedEvidence(7) }));
  assert.equal(backOff.state, "done", "the same wave, still done");
  assert.equal(waveAutoOpens([backOff, two])[1].open, false, "the switch is the only difference, and it is enough");
});

test("a met exit gate is not enough while the previous wave still holds a run", () => {
  // The fold's clause, applied rather than gone around: a wave with a running member never reads done, however green
  // its exit gate is (test/waves-derive.test.js proves the fold half). This read must not open a successor under it.
  const metExit = { check: "pr-merged", state: "met", met: true, cannotTell: false, closed: true, why: "every member's pull request reads MERGED" };
  const [, successor] = waveAutoOpens([
    { id: "wave_01", auto: true, state: "running", stateWhy: "#2 is running", gates: { exit: metExit } },
    { id: "wave_02", auto: false, state: "ready", gates: { exit: null } },
  ]);
  assert.equal(successor.open, false);
  assert.equal(successor.switchOn, true);
  assert.match(successor.why, /exit gate reads met/);
  assert.match(successor.why, /still reads running/);
  assert.match(successor.why, /#2 is running/);
  assert.match(successor.why, /never opens under a wave that has not closed/);
});

test("no exit gate and an abandoned exit both open nothing, each with its own sentence", () => {
  const handClosed = view(wave("wave_01", 1, { auto: true, exitGate: null }), [member(1, "done")]);
  const two = view(wave("wave_02", 2), [member(2, "queued")]);
  const [, afterNothing] = waveAutoOpens([handClosed, two]);
  assert.equal(handClosed.gates.exit.state, "none");
  assert.equal(afterNothing.open, false);
  assert.match(afterNothing.why, /names no exit gate/);
  assert.match(afterNothing.why, /there is no read that can say met/);

  const abandoned = view(
    wave("wave_01", 1, { auto: true }),
    [member(1, "done", { abandoned: { reason: "the upstream feed was retired", by: "roper" } })],
    evidenceFor({}),
  );
  assert.equal(abandoned.gates.exit.state, "abandoned");
  const [, afterAbandon] = waveAutoOpens([abandoned, two]);
  assert.equal(afterAbandon.open, false);
  assert.match(afterAbandon.why, /closed as abandoned/);
  assert.match(afterAbandon.why, /decision about the work and not a landing/);
});

// ---- the lane over a real store: derived, unstored, and membership stays the task's own ---------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wag-waves-auto-"));
const file = path.join(dir, "waves.json");
const writeStore = (records) => writeFileSync(file, `${JSON.stringify({ version: 1, byInitiative: { init_a: records } }, null, 2)}\n`, "utf8");
const fresh = () => new Waves({ file, log: () => {} });
const task = (id, waveId, tree) => ({ id, title: `task ${id}`, state: "done", project: "proj", worktree: tree, waveId });
const mapOf = (entries) => new Map(entries);

test("the switch is evaluated on the lane read, and nothing is written to the store", () => {
  writeStore([
    { id: "wave_01", initiativeId: "init_a", position: 1, title: "first", entryGate: null, exitGate: { check: "pr-merged" }, auto: true },
    { id: "wave_02", initiativeId: "init_a", position: 2, title: "second", entryGate: null, exitGate: null },
    { id: "wave_03", initiativeId: "init_a", position: 3, title: "third", entryGate: null, exitGate: null },
  ]);
  const before = readFileSync(file, "utf8");
  const tasks = [task(1, "wave_01", "/w/t1"), task(2, "wave_02", "/w/t2")];
  const evidence = mapOf([
    ["1@/w/t1", mergedEvidence(7)],
    ["2@/w/t2", mergedEvidence(8)],
  ]);
  const lane = waveLane({
    waves: fresh(),
    initiativeId: "init_a",
    tasks,
    rowFor: () => null,
    evidenceFor: (m) => evidence.get(m.key) || null,
  });
  assert.equal(lane.waves.length, 3);
  const [one, two, three] = lane.waves;
  assert.equal(one.state, "done", "wave_01 closed on the live evidence");
  assert.equal(one.autoOpen.open, false);
  assert.equal(two.autoOpen.open, true, "the read opened wave_02");
  assert.equal(two.autoOpen.from, "wave_01");
  assert.equal(two.auto, false, "the record's switch is absent, so it is false");
  assert.equal(three.autoOpen.open, false, "and the chain stops at wave_02");
  assert.equal(lane.currentId, "wave_02", "the current wave is still the fold's answer: wave_01 is done, wave_02 is ready");
  // MEMBERSHIP IS EXPLICIT: wave_02 holds the task that names it, not a copy of wave_01's.
  assert.deepEqual(two.members.map((m) => m.id), [2]);
  assert.deepEqual(one.members.map((m) => m.id), [1]);
  assert.equal(readFileSync(file, "utf8"), before, "a read wrote nothing: no openedBy, no openedAt, no state");
});

test("an auto-opened wave with no member opens as itself: empty, not a fan-out of the predecessor's trees", () => {
  writeStore([
    { id: "wave_01", initiativeId: "init_a", position: 1, title: "first", entryGate: null, exitGate: { check: "pr-merged" }, auto: true },
    { id: "wave_02", initiativeId: "init_a", position: 2, title: "second", entryGate: null, exitGate: null },
  ]);
  const evidence = mapOf([["1@/w/t1", mergedEvidence(7)]]);
  const lane = waveLane({
    waves: fresh(),
    initiativeId: "init_a",
    tasks: [task(1, "wave_01", "/w/t1")],
    rowFor: () => null,
    evidenceFor: (m) => evidence.get(m.key) || null,
  });
  const [, two] = lane.waves;
  assert.equal(two.autoOpen.open, true);
  assert.equal(two.state, "empty", "it has no member of its own, and the switch does not invent one");
  assert.deepEqual(two.members, []);
  assert.equal(two.lanes.length, 0, "no trees are cut for an auto open: a wave never owns a tree");
});

after(() => rmSync(dir, { recursive: true, force: true }));
