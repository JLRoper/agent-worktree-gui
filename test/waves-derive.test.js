// The wave state is DERIVED from its members on every read - never stored, and never able to read green while a
// member is still running.
//
// This file is the acceptance test the brief names, in three parts:
//
//   1. THREE MEMBERS, THREE STATES. A wave of three tasks that are queued, running and done reads `running`; when the
//      running one finishes and every member's PR is MERGED, the SAME RECORD reads `done` - the record did not change,
//      the members did.
//   2. NO GREEN WHILE A MEMBER RUNS. A met exit gate cannot make the wave `done` while any member is running. That is
//      the reader's own acceptance clause, and it is asserted for a met pr-merged exit and for every other state the
//      fold can reach.
//   3. NO WAVE-STATE FIELD, ANYWHERE. The store refuses one: a record carrying `state` reads without it, and the view
//      has no field on disk to disagree with the fold. The test reads the raw file back to prove nothing was written.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Waves, deriveWaveState, readWaveGate, waveView } from "../lib/waves.js";

const member = (id, state, over = {}) => ({
  id,
  title: `task ${id}`,
  state,
  project: "proj",
  worktree: `/work/proj/.worktrees/t${id}`,
  pipeline: null,
  pr: null,
  hasRow: true,
  dirty: 0,
  ahead: 1,
  verdict: null,
  ...over,
});

const wave = (over = {}) => ({
  id: "wave_01",
  initiativeId: "init_a",
  position: 1,
  title: "The read path",
  entryGate: null,
  exitGate: { check: "pr-merged" },
  template: null,
  auto: false,
  ...over,
});

const view = (members, over = {}) => waveView({ wave: wave(over), members });

test("three members queued, running and done draw running - from the members alone", () => {
  const drawn = view([member(1, "queued"), member(2, "running"), member(3, "done")]);
  assert.equal(drawn.state, "running");
  assert.equal(drawn.stateWord, "running");
  assert.equal(drawn.stateWhy, "#2 is running");
  assert.deepEqual(
    drawn.members.map((m) => m.state),
    ["queued", "running", "done"],
  );
});

test("the same record reads done once the running member finishes and every PR is MERGED", () => {
  const merged = { number: 7, state: "MERGED" };
  const drawn = view([member(1, "done", { pr: merged }), member(2, "done", { pr: merged }), member(3, "done", { pr: merged })]);
  assert.equal(drawn.state, "done");
  assert.match(drawn.stateWhy, /exit gate reads met/);
  assert.equal(drawn.gates.exit.state, "met");
});

test("a met exit gate cannot read done or closed while any member is still running", () => {
  const merged = { number: 7, state: "MERGED" };
  // Two members have merged; the third is still running. The exit gate alone would say met.
  const members = [member(1, "done", { pr: merged }), member(2, "done", { pr: merged }), member(3, "running", { pr: { number: 9, state: "OPEN" } })];
  const exit = readWaveGate({ check: "pr-merged" }, members);
  assert.equal(exit.state, "unmet", "the running member's PR is not MERGED, so the gate is not met either");
  const drawn = view(members);
  assert.equal(drawn.state, "running");
  assert.notEqual(drawn.state, "done");
  assert.notEqual(drawn.state, "ready");

  // Even a gate a caller hands back as MET cannot outrank the running member: the fold settles running first.
  const alwaysMet = () => ({ check: "pr-merged", state: "met", met: true, cannotTell: false, why: "stubbed met" });
  const forced = deriveWaveState({ wave: wave(), members, readGate: alwaysMet });
  assert.equal(forced.state, "running");
  // ...and the same hold for every one of the four task states while a run is live.
  for (const other of ["queued", "parked", "done"]) {
    const withRun = deriveWaveState({ wave: wave(), members: [member(1, other), member(2, "running")], readGate: alwaysMet });
    assert.equal(withRun.state, "running", `a running member beside a ${other} one still reads running`);
  }
});

test("a met exit closes the wave even with a member still queued - but never while one runs", () => {
  const clean = { exitGate: { check: "clean" } };
  const queuedFollowUp = view([member(1, "done"), member(2, "done"), member(3, "queued")], clean);
  assert.equal(queuedFollowUp.state, "done", "the design's own row: a wave can exit while a member is queued for a follow-up");
  // The same members, one of them running, are held.
  const held = view([member(1, "done"), member(2, "done"), member(3, "running")], clean);
  assert.equal(held.state, "running");
});

test("blocked means parked and none running", () => {
  assert.equal(view([member(1, "queued"), member(2, "parked")]).state, "blocked");
  assert.equal(view([member(1, "parked"), member(2, "running")]).state, "running");
  assert.equal(view([member(1, "done", { pr: { number: 1, state: "MERGED" } }), member(2, "parked")]).state, "blocked");
});

test("entry gate: met is ready, not met is unentered, unreadable is unknown", () => {
  const ready = view([member(1, "queued")], { entryGate: { check: "clean" }, exitGate: null });
  assert.equal(ready.state, "ready");
  assert.equal(ready.gates.entry.state, "met");

  const dirty = view([member(1, "queued", { dirty: 2 })], { entryGate: { check: "clean" }, exitGate: null });
  assert.equal(dirty.state, "unentered");
  assert.match(dirty.stateWhy, /not met/);

  const blind = view([member(1, "queued", { hasRow: false })], { entryGate: { check: "clean" }, exitGate: null });
  assert.equal(blind.state, "unknown");
  assert.equal(blind.gates.entry.state, "unknown");
  assert.match(blind.stateWhy, /cannot be read/);
});

test("a check the panel validates but does not evaluate reads unknown, never met", () => {
  for (const check of ["file-exists", "command", "branch-exists", "pushed", "main-moved", "pr-head", "pr-approved", "pr-comments", "reviewers-exact", "branch-name"]) {
    const gate = { check };
    const read = readWaveGate(gate, [member(1, "queued")]);
    assert.equal(read.state, "unknown", `${check} has no evaluator yet`);
    assert.equal(read.met, false, `${check} cannot pass`);
    assert.match(read.why, /no evaluator/);
  }
});

test("the readable checks answer from the row facts, with cannot-tell apart from not-met", () => {
  assert.equal(readWaveGate({ check: "clean" }, [member(1, "queued", { dirty: 0 })]).state, "met");
  assert.equal(readWaveGate({ check: "clean" }, [member(1, "queued", { dirty: 1 })]).state, "unmet");
  assert.equal(readWaveGate({ check: "clean" }, [member(1, "queued", { hasRow: false })]).state, "unknown");
  assert.equal(readWaveGate({ check: "commits", min: 2 }, [member(1, "queued", { ahead: 3 })]).state, "met");
  assert.equal(readWaveGate({ check: "commits", min: 2 }, [member(1, "queued", { ahead: 1 })]).state, "unmet");
  assert.equal(readWaveGate({ check: "pr-open" }, [member(1, "queued", { pr: { number: 1, state: "OPEN" } })]).state, "met");
  assert.equal(readWaveGate({ check: "pr-open" }, [member(1, "queued", { pr: { number: 1, state: "DECLINED" } })]).state, "unmet");
  assert.equal(readWaveGate({ check: "pr-open" }, [member(1, "queued")]).state, "unknown");
  assert.equal(readWaveGate({ check: "pr-merged" }, [member(1, "done", { pr: { number: 1, state: "MERGED" } })]).state, "met");
  assert.equal(readWaveGate({ check: "pr-merged" }, [member(1, "running", { pr: { number: 1, state: "OPEN" } })]).state, "unmet");
  assert.equal(readWaveGate({ check: "pr-merged" }, [member(1, "queued")]).state, "unknown");
  // Every member has to answer: one merged member and one with no PR is cannot-tell, not met.
  assert.equal(
    readWaveGate({ check: "pr-merged" }, [member(1, "done", { pr: { number: 1, state: "MERGED" } }), member(2, "queued")]).state,
    "unknown",
  );
});

test("no member and no gate: empty wins before any gate is read", () => {
  const drawn = view([], { entryGate: { check: "clean" }, exitGate: { check: "pr-merged" } });
  assert.equal(drawn.state, "empty");
  assert.equal(drawn.gates.entry.state, "none");
  assert.equal(drawn.gates.exit.state, "none");
});

test("a null entry gate opens by hand (ready), and a null exit gate never closes it", () => {
  const drawn = view([member(1, "queued")], { entryGate: null, exitGate: null });
  assert.equal(drawn.state, "ready");
  assert.equal(drawn.gates.exit.state, "none");
  assert.match(drawn.gates.exit.why, /a person closes this wave/);
});

test("the wave record on disk has NO state field, and a hand-written one is not read as state", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-waves-derive-"));
  const file = path.join(dir, "waves.json");
  const record = { ...wave(), state: "done", doneAt: "2026-11-21T00:00:00.000Z" };
  writeFileSync(file, `${JSON.stringify({ version: 1, byInitiative: { init_a: [record] } }, null, 2)}\n`, "utf8");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s = new Waves({ file, log: () => {} });
  const [loaded] = s.wavesFor("init_a");
  assert.equal("state" in loaded, false, "the store's record shape carries no state");
  assert.equal("doneAt" in loaded, false);
  // The fold, not the record, decides: one running member still reads running.
  const drawn = waveView({ wave: loaded, members: [member(1, "running")] });
  assert.equal(drawn.state, "running");
  // And no read wrote anything back.
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).byInitiative.init_a[0], record);
});

test("a task that names its own pipeline keeps it; one that names none inherits the wave's template", () => {
  const inherited = view([member(1, "queued"), member(2, "queued", { pipeline: "my-own-pipeline" })], { template: "poc-to-uat" });
  assert.equal(inherited.members[0].pipeline, "poc-to-uat");
  assert.equal(inherited.members[0].pipelineFrom, "wave");
  assert.equal(inherited.members[1].pipeline, "my-own-pipeline");
  assert.equal(inherited.members[1].pipelineFrom, "task");
});
