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

const view = (members, over = {}, evidenceFor = null) => waveView({ wave: wave(over), members, evidenceFor });

// The live evidence a gate reads (lib/wave-evidence.js): the PR through the API and the landing by content. The
// stored `pr.state` on a member is what the lane DRAWS; these are what the gate BELIEVES.
const mergedEvidence = (number = 7, over = {}) => ({
  number,
  pr: { number, state: "MERGED", mergedAt: "2026-11-21T00:00:00.000Z", headRefOid: "a".repeat(40) },
  why: null,
  landing: { state: "landed", why: "origin/main 1234567 holds the recorded sha's content in 1 file", main: "origin/main" },
  ...over,
});
const openEvidence = (number = 9) => ({ number, pr: { number, state: "OPEN", mergedAt: null, headRefOid: "b".repeat(40) }, why: null, landing: { state: "unknown", why: "the pull request did not land", main: "origin/main" } });
const evidenceFor = (byId) => (member) => byId[member.id] || null;

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

test("the same record reads done once the running member finishes and every PR reads MERGED with its content on main", () => {
  const merged = { number: 7, state: "MERGED" };
  const evidence = evidenceFor({ 1: mergedEvidence(7), 2: mergedEvidence(8), 3: mergedEvidence(9) });
  const drawn = view([member(1, "done", { pr: merged }), member(2, "done", { pr: merged }), member(3, "done", { pr: merged })], {}, evidence);
  assert.equal(drawn.state, "done");
  assert.match(drawn.stateWhy, /exit gate reads met/);
  assert.equal(drawn.gates.exit.state, "met");
  assert.match(drawn.gates.exit.why, /holds the recorded sha/);
});

test("a score that says MERGED is not evidence: with no live read the gate answers cannot tell", () => {
  // The row's own word, MERGED, on every member - and no evidence reader. The gate must not believe it.
  const merged = { number: 7, state: "MERGED" };
  const drawn = view([member(1, "done", { pr: merged }), member(2, "done", { pr: merged })]);
  assert.equal(drawn.gates.exit.state, "unknown");
  assert.equal(drawn.gates.exit.met, false);
  assert.notEqual(drawn.state, "done");
});

test("a met exit gate cannot read done or closed while any member is still running", () => {
  const merged = { number: 7, state: "MERGED" };
  // Two members have merged; the third is still running. The exit read alone says the running member's PR is open.
  const members = [member(1, "done", { pr: merged }), member(2, "done", { pr: merged }), member(3, "running", { pr: { number: 9, state: "OPEN" } })];
  const evidence = evidenceFor({ 1: mergedEvidence(7), 2: mergedEvidence(8), 3: openEvidence(9) });
  const exit = readWaveGate({ check: "pr-merged" }, members, evidence);
  assert.equal(exit.state, "unmet", "the running member's PR reads OPEN through the API, so the gate is not met either");
  const drawn = view(members, {}, evidence);
  assert.equal(drawn.state, "running");
  assert.notEqual(drawn.state, "done");
  assert.notEqual(drawn.state, "ready");

  // Even a gate a caller hands back as MET cannot outrank the running member: the fold settles running first.
  const alwaysMet = () => ({ check: "pr-merged", state: "met", met: true, closed: true, cannotTell: false, why: "stubbed met" });
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
  // Every name in the 14 that this slice did not give an evidence read. `main-moved` is read now (by content), so it
  // is asserted in its own tests below, not here.
  for (const check of ["file-exists", "command", "branch-exists", "pushed", "pr-head", "pr-approved", "pr-comments", "reviewers-exact", "branch-name"]) {
    const gate = { check };
    const read = readWaveGate(gate, [member(1, "queued")]);
    assert.equal(read.state, "unknown", `${check} has no evaluator yet`);
    assert.equal(read.met, false, `${check} cannot pass`);
    assert.match(read.why, /no evaluator/);
  }
});

test("the row-fact checks answer from the row, with cannot-tell apart from not-met", () => {
  assert.equal(readWaveGate({ check: "clean" }, [member(1, "queued", { dirty: 0 })]).state, "met");
  assert.equal(readWaveGate({ check: "clean" }, [member(1, "queued", { dirty: 1 })]).state, "unmet");
  assert.equal(readWaveGate({ check: "clean" }, [member(1, "queued", { hasRow: false })]).state, "unknown");
  assert.equal(readWaveGate({ check: "commits", min: 2 }, [member(1, "queued", { ahead: 3 })]).state, "met");
  assert.equal(readWaveGate({ check: "commits", min: 2 }, [member(1, "queued", { ahead: 1 })]).state, "unmet");
});

test("the PR checks read the API, never the row's stored state word", () => {
  const open = evidenceFor({ 1: openEvidence(1) });
  const gone = evidenceFor({ 1: mergedEvidence(1, { pr: { number: 1, state: "DECLINED", mergedAt: null, headRefOid: "c".repeat(40) } }) });
  // The stored word says OPEN but the API says MERGED: the API wins, and the row's word is not consulted at all.
  const storedOpen = member(1, "queued", { pr: { number: 1, state: "OPEN" } });
  assert.equal(readWaveGate({ check: "pr-merged" }, [storedOpen], evidenceFor({ 1: mergedEvidence(1) })).state, "met");
  // The stored word says MERGED but the API says OPEN: the API wins the other way too.
  const storedMerged = member(1, "done", { pr: { number: 1, state: "MERGED" } });
  assert.equal(readWaveGate({ check: "pr-merged" }, [storedMerged], open).state, "unmet");
  // No PR recorded: cannot tell, never met - regardless of what the row claims.
  assert.equal(readWaveGate({ check: "pr-merged" }, [member(1, "done", { pr: { number: 1, state: "MERGED" } })]).state, "unknown");
  assert.equal(readWaveGate({ check: "pr-merged" }, [member(1, "done")]).state, "unknown");
  assert.equal(readWaveGate({ check: "pr-open" }, [member(1, "queued")], open).state, "met");
  assert.equal(readWaveGate({ check: "pr-open" }, [member(1, "queued")], gone).state, "unmet");
  // A PR that reads MERGED but whose landing cannot be read is cannot tell: merged is not the same fact as on main.
  const mergedNoLanding = evidenceFor({ 1: mergedEvidence(1, { landing: { state: "unknown", why: "the clone does not hold the sha", main: "origin/main" } }) });
  assert.equal(readWaveGate({ check: "pr-merged" }, [member(1, "done")], mergedNoLanding).state, "unknown");
  // A PR that reads MERGED and whose content is NOT on main is not met: the merge did not land the content.
  const mergedNotLanded = evidenceFor({ 1: mergedEvidence(1, { landing: { state: "not-landed", why: "origin/main differs in lib/a.js", main: "origin/main" } }) });
  assert.equal(readWaveGate({ check: "pr-merged" }, [member(1, "done")], mergedNotLanded).state, "unmet");
  // Every member has to answer: one merged member and one with no PR is cannot-tell, not met.
  assert.equal(
    readWaveGate({ check: "pr-merged" }, [member(1, "done"), member(2, "queued")], evidenceFor({ 1: mergedEvidence(1) })).state,
    "unknown",
  );
  // One definite not-met outranks one cannot-tell: the gate is definitely not closed.
  assert.equal(
    readWaveGate({ check: "pr-merged" }, [member(1, "done"), member(2, "done")], evidenceFor({ 1: openEvidence(1) })).state,
    "unmet",
  );
});

test("a wave with a member abandoned for a NAMED reason closes as abandoned, and names the member and the reason", () => {
  const reason = "the upstream feed was retired, so this member has nothing to land";
  const members = [member(1, "done", { pr: { number: 7, state: "MERGED" } }), member(2, "queued", { abandoned: { reason, by: "roper", at: "2026-11-21T10:00:00.000Z" } })];
  const evidence = evidenceFor({ 1: mergedEvidence(7), 2: mergedEvidence(8) });
  const drawn = view(members, {}, evidence);
  assert.equal(drawn.state, "abandoned");
  assert.equal(drawn.gates.exit.state, "abandoned");
  assert.equal(drawn.gates.exit.closed, true);
  assert.equal(drawn.gates.exit.met, false, "abandoned is closed, never met/done");
  // The sentence names WHICH member and WHY, in the gate and in the wave's own why.
  assert.match(drawn.gates.exit.why, /#2/);
  assert.match(drawn.gates.exit.why, new RegExp(reason.slice(0, 24)));
  assert.match(drawn.stateWhy, /#2/);
  assert.match(drawn.stateWhy, /upstream feed was retired/);
  // The lane draws the member as abandoned, not as the queued state the row happens to carry.
  assert.equal(drawn.members[1].abandoned.reason, reason);
  // A wave that reads abandoned is closed: it is not running, not ready and not a pass.
  assert.notEqual(drawn.state, "done");
  assert.equal(drawn.gates.exit.met, false);
});

test("an unnamed abandonment is a status word: it cannot close the gate, and the gate answers cannot tell", () => {
  const evidence = evidenceFor({ 1: mergedEvidence(7), 2: mergedEvidence(8) });
  // A bare `true`, blank reason and an empty object all carry no reason. (An ABSENT field is not abandonment at all,
  // and is covered by every other member in this file.)
  for (const bare of [true, { reason: "   " }, {}]) {
    const members = [member(1, "done", { pr: { number: 7, state: "MERGED" } }), member(2, "queued", { abandoned: bare })];
    const drawn = view(members, {}, evidence);
    assert.equal(drawn.gates.exit.state, "unknown", `abandoned: ${JSON.stringify(bare)} is not a decision`);
    assert.notEqual(drawn.state, "abandoned");
    assert.notEqual(drawn.state, "done");
  }
});

test("an abandoned member closes any exit gate as abandoned, including a row-fact one, and is never counted clean", () => {
  const members = [member(1, "done", { dirty: 0 }), member(2, "queued", { dirty: 2, abandoned: { reason: "the feed was retired" } })];
  const drawn = view(members, { exitGate: { check: "clean" }, entryGate: null });
  assert.equal(drawn.gates.exit.state, "abandoned");
  assert.equal(drawn.state, "abandoned");
  assert.match(drawn.gates.exit.why, /#2 was abandoned: the feed was retired/);
  // ...and the dirty tree of the abandoned member is not read as an unmet gate either: it is closed, not failed.
  assert.notEqual(drawn.gates.exit.state, "unmet");
});

test("an abandoned member still RUNNING holds the wave: abandonment does not outrank a live run", () => {
  const members = [member(1, "running", { abandoned: { reason: "stopped by the reader" } }), member(2, "done", { pr: { number: 7, state: "MERGED" } })];
  const drawn = view(members, {}, evidenceFor({ 1: mergedEvidence(8), 2: mergedEvidence(7) }));
  assert.equal(drawn.state, "running");
  assert.notEqual(drawn.state, "abandoned");
});

test("an abandoned member parked for a named reason does not block the wave, and an unnamed one still does", () => {
  const named = view([member(1, "parked", { abandoned: { reason: "moved to wave 3" } }), member(2, "done", { pr: { number: 7, state: "MERGED" } })], {}, evidenceFor({ 1: mergedEvidence(8), 2: mergedEvidence(7) }));
  assert.notEqual(named.state, "blocked");
  assert.equal(named.state, "abandoned");
  const unnamed = view([member(1, "parked"), member(2, "done", { pr: { number: 7, state: "MERGED" } })], {}, evidenceFor({ 1: mergedEvidence(8), 2: mergedEvidence(7) }));
  assert.equal(unnamed.state, "blocked");
});

test("main-moved is judged BY CONTENT: a squash-rewritten sha still closes, and ancestry is never the test", () => {
  // The landing read says landed, with `ancestor: false` - exactly a squash landing. The gate must read met.
  const squash = evidenceFor({
    1: mergedEvidence(7, { landing: { state: "landed", why: "origin/main 1234567 holds the recorded sha's content in 2 files; the sha is not an ancestor of main, so this was judged by content, not ancestry", main: "origin/main", ancestor: false } }),
  });
  const read = readWaveGate({ check: "main-moved" }, [member(1, "done")], squash);
  assert.equal(read.state, "met");
  assert.match(read.why, /not an ancestor/);
  assert.match(read.why, /judged by content/);
  // Content that is NOT on main is not met, whatever the PR's state says.
  const absent = evidenceFor({ 1: mergedEvidence(7, { landing: { state: "not-landed", why: "origin/main differs from the recorded sha in lib/a.js", main: "origin/main" } }) });
  assert.equal(readWaveGate({ check: "main-moved" }, [member(1, "done")], absent).state, "unmet");
  // No landing read at all is cannot tell.
  assert.equal(readWaveGate({ check: "main-moved" }, [member(1, "done")], evidenceFor({ 1: mergedEvidence(7, { landing: null }) })).state, "unknown");
  // A read against a different main than the gate names is cannot tell, not a comparison of two refs.
  const other = evidenceFor({ 1: mergedEvidence(7, { landing: { state: "landed", why: "ok", main: "origin/develop" } }) });
  const mismatched = readWaveGate({ check: "main-moved", main: "main" }, [member(1, "done")], other);
  assert.equal(mismatched.state, "unknown");
  assert.match(mismatched.why, /origin\/develop/);
});

test("a gate whose evidence read THROWS is cannot tell, never met", () => {
  const thrower = () => {
    throw new Error("the git child died");
  };
  for (const check of ["pr-merged", "pr-open", "main-moved"]) {
    const read = readWaveGate({ check }, [member(1, "done", { pr: { number: 7, state: "MERGED" } })], thrower);
    assert.equal(read.state, "unknown", `${check} must not pass on a throwing reader`);
    assert.equal(read.met, false);
    assert.equal(read.cannotTell, true);
    assert.match(read.why, /threw/);
  }
  // The same at the fold: a throwing reader cannot turn a wave green, and the wave stays out of done.
  const drawn = waveView({ wave: wave(), members: [member(1, "done", { pr: { number: 7, state: "MERGED" } })], evidenceFor: thrower });
  assert.notEqual(drawn.state, "done");
  assert.equal(drawn.gates.exit.state, "unknown");
});

test("an evidence value that carries its own error is cannot tell too, never met", () => {
  const err = evidenceFor({ 1: { error: "the host answered 502", pr: null, landing: null } });
  const read = readWaveGate({ check: "pr-merged" }, [member(1, "done")], err);
  assert.equal(read.state, "unknown");
  assert.match(read.why, /502/);
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
