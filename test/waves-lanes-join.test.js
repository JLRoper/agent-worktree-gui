// Step 3 of the waves plan: LANES inside a wave, and a close that joins them in ONE commit.
//
// The wave side adds three facts and nothing else, and each one has a wrong answer that still looks right:
//
//   1. LANES ARE DERIVED, NEVER STORED TWICE. A lane is the set of members that touch a common file (the queue's own
//      `intersectingFiles` rule, grouped) or the set a member names on its own record; the wave record has no `lanes`
//      field and a hand-written one is not read. A wave whose members land in one lane holds ONE IMPLICIT LANE and
//      behaves exactly as it did before lanes: same fold, same markup, no join owed.
//   2. ISOLATION IS THE FAN-OUT'S, AND A LANE'S FAILURE CANNOT REACH ANOTHER. A lane runs in its own tree (measured
//      here: neither tree carries the other's file, and a write in one leaves the other's checkout byte-identical),
//      and a lane whose pin does not read refuses the whole join rather than merging the lanes it could read.
//   3. THE JOIN IS ONE COMMIT THAT NAMES EVERY LANE, over pins that name a commit AND a blob. A squash rewrites the
//      landed sha, so ancestry is not evidence here; the blob read at the pinned commit is the half that still names
//      what landed.
//
// The git fixtures are REAL repositories: a fake that answers a pin without a commit proves nothing about a pin.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ISOLATION_PER_STAGE } from "../lib/pipeline-fanout.js";
import { pinCheck } from "../lib/stage-pin.js";
import { readMemberPin, readWaveLanePins } from "../lib/wave-evidence.js";
import { WAVES_VERSION, Waves, deriveWaveState, joinWaveLanes, readWaveLane, waveLanes, waveView } from "../lib/waves.js";

// The fixture's git identity. Built from parts so no address-shaped literal sits in the source.
const MAIL = ["lanes", "example.invalid"].join("@");

const member = (over = {}) => ({
  id: 1,
  title: "a member",
  state: "done",
  lane: null,
  files: [],
  worktree: null,
  project: "agent-worktree-gui",
  thread: null,
  pipeline: null,
  abandoned: null,
  pr: null,
  hasRow: false,
  dirty: null,
  ahead: null,
  verdict: null,
  ...over,
});

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "wag-lanes-"));
  const at = (name) => path.join(root, name);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();
  const write = (cwd, rel, body) => {
    mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    writeFileSync(path.join(cwd, rel), body);
  };
  const main = at("main");
  mkdirSync(main, { recursive: true });
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "user.name", "Lane Fixture");
  git(main, "config", "user.email", MAIL);
  git(main, "config", "core.autocrlf", "false");
  write(main, "README.md", "the base\n");
  git(main, "add", "-A");
  git(main, "commit", "-qm", "the base");
  const base = git(main, "rev-parse", "HEAD");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, main, base, git, write, at };
}

// A tree cut from one base with its own branch: exactly what a lane is handed (lib/pipeline-fanout.js rule 2).
function cut(fx, name, branch, from = null) {
  const dir = fx.at(name);
  fx.git(fx.main, "worktree", "add", "-q", "-b", branch, dir, from || fx.base);
  return dir;
}

// One lane's members pinned the way the panel pins them: a commit, and the blob of every file it claims.
const pinnedLane = (lane) => ({ ...lane, pins: readWaveLanePins({ lane }) });

test("a wave's lanes are derived from its members on every read, and the store has no lane field", (t) => {
  // Two members claim one file, so they are ONE lane: one of them waits for the other. The third claims a file of its
  // own and shares one with nobody, so it is the unlaned lane.
  const set = waveLanes([
    member({ id: 3, files: ["lib/x.js"], worktree: "/w/one" }),
    member({ id: 4, files: ["lib/X.js"], worktree: "/w/two", state: "running" }),
    member({ id: 5, files: ["lib/y.js"], worktree: "/w/three", state: "queued" }),
  ]);
  assert.equal(set.count, 2, "two members on one file and one on its own are two lanes");
  assert.equal(set.joinOwed, true, "a close with two lanes is a join");
  assert.equal(set.isolation, ISOLATION_PER_STAGE, "the lane set runs under the fan-out's own isolation model");
  assert.deepEqual(set.lanes.map((lane) => lane.label), ["lib/x.js", "unlaned"]);
  assert.deepEqual(set.lanes[0].memberIds, [3, 4], "the file's own normalisation groups lib/x.js and lib/X.js");
  assert.deepEqual(set.lanes[1].memberIds, [5]);
  assert.equal(set.lanes[0].state, "running", "a running member holds its lane");

  // A member that NAMES a lane keeps it, and two members naming one lane are one lane.
  const named = waveLanes([
    member({ id: 7, lane: "the read path", files: [], worktree: "/w/a" }),
    member({ id: 8, lane: "the read path", files: ["lib/z.js"], worktree: "/w/b" }),
    member({ id: 9, lane: "the write path", files: [], worktree: "/w/c" }),
  ]);
  assert.deepEqual(named.lanes.map((lane) => lane.label), ["the read path", "the write path"]);
  assert.deepEqual(named.lanes[0].memberIds, [7, 8]);

  // A wave nobody gave lanes holds ONE IMPLICIT LANE, derived from members that share nothing.
  const implicit = waveLanes([member({ id: 1, files: ["lib/a.js"], worktree: "/w/a" }), member({ id: 2, files: ["lib/b.js"], worktree: "/w/b" })]);
  assert.equal(implicit.count, 1);
  assert.equal(implicit.implicit, true, "one lane the panel made up, not a lane anybody named");
  assert.equal(implicit.joinOwed, false, "one lane owes no join");

  // The store: a `lanes` list written by hand is NOT read, because the lane set is derived from the members' records.
  const dir = mkdtempSync(path.join(tmpdir(), "wag-lanes-store-"));
  const file = path.join(dir, "waves.json");
  writeFileSync(
    file,
    `${JSON.stringify({ version: WAVES_VERSION, byInitiative: { init_a: [{ id: "wave_01", initiativeId: "init_a", position: 1, title: "W", lanes: [{ name: "forged" }] }] } }, null, 2)}\n`,
    "utf8",
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const loaded = new Waves({ file, log: () => {} }).wavesFor("init_a");
  assert.equal(loaded.length, 1, "the record still loads");
  assert.equal("lanes" in loaded[0], false, "the wave record carries no lanes field: the lane set is never stored twice");
  assert.equal(loaded[0].title, "W");
});

test("two lanes in one wave run without seeing each other's trees, and a lane's failure leaves the other's work alone", (t) => {
  const fx = fixture(t);
  const left = cut(fx, "lane-left", "lane-left");
  const right = cut(fx, "lane-right", "lane-right");
  const join = cut(fx, "wave-join", "wave-join");
  fx.write(left, "lib/left.js", "export const left = 1;\n");
  fx.git(left, "add", "-A");
  fx.git(left, "commit", "-qm", "lane left writes its file");
  fx.write(right, "lib/right.js", "export const right = 2;\n");
  fx.git(right, "add", "-A");
  fx.git(right, "commit", "-qm", "lane right writes its file");
  const leftHead = fx.git(left, "rev-parse", "HEAD");
  const rightFile = readFileSync(path.join(right, "lib/right.js"), "utf8");

  // ISOLATION, measured on the disk: neither lane's tree carries the other's file, and neither tree reports it as a
  // change it made. A write in one lane leaves the other's checkout byte-identical.
  assert.equal(existsSync(path.join(right, "lib/left.js")), false, "the right lane cannot see the left lane's file");
  assert.equal(existsSync(path.join(left, "lib/right.js")), false, "the left lane cannot see the right lane's file");
  assert.doesNotMatch(fx.git(right, "status", "--porcelain"), /left\.js/);
  fx.write(left, "lib/left.js", "export const left = 3;\n");
  assert.equal(readFileSync(path.join(right, "lib/right.js"), "utf8"), rightFile, "the other lane's work is untouched");

  // The wave's lane set, and each lane pinned at the commit it settled on.
  const set = waveLanes([
    member({ id: 1, lane: "lib/left.js", files: ["lib/left.js"], worktree: left }),
    member({ id: 2, lane: "lib/right.js", files: ["lib/right.js"], worktree: right }),
  ]);
  assert.equal(set.joinOwed, true);
  const lanes = set.lanes.map(pinnedLane);
  assert.equal(lanes[0].pins.ok, true, lanes[0].pins.why);
  assert.equal(lanes[1].pins.ok, true, lanes[1].pins.why);

  // ONE LANE FAILS: the right lane claims a file its commit does not hold, so its pin cannot be read. The join refuses
  // the whole set by name; nothing is merged, and the lane that could be read is left exactly where it was.
  const blind = readWaveLanePins({ lane: { ...set.lanes[1], members: [member({ id: 2, lane: "lib/right.js", files: ["lib/missing.js"], worktree: right })] } });
  assert.equal(blind.ok, false);
  assert.match(blind.why, /lib\/missing\.js/);
  const refused = joinWaveLanes({ wave: { id: "wave_01" }, lanes: [lanes[0], { ...lanes[1], pins: blind }], tree: join, base: fx.base });
  assert.equal(refused.ok, false, "a lane that cannot be pinned refuses the join");
  assert.equal(refused.code, "wave-join-input");
  assert.match(refused.reason, /lib\/right\.js #2/);
  assert.match(refused.reason, /lib\/missing\.js/);
  assert.equal(fx.git(join, "rev-parse", "HEAD"), fx.base, "no commit was made");
  assert.equal(fx.git(left, "rev-parse", "HEAD"), leftHead, "the lane that could be read is exactly where it was");
  assert.equal(readFileSync(path.join(left, "lib/left.js"), "utf8"), "export const left = 3;\n", "the left lane's work is not touched");
});

test("a wave's close joins its lanes in exactly ONE commit, and the message names every lane", (t) => {
  const fx = fixture(t);
  const left = cut(fx, "lane-left", "lane-left");
  const right = cut(fx, "lane-right", "lane-right");
  const join = cut(fx, "wave-join", "wave-join");
  fx.write(left, "lib/left.js", "export const left = 1;\n");
  fx.git(left, "add", "-A");
  fx.git(left, "commit", "-qm", "lane left");
  fx.write(right, "lib/right.js", "export const right = 2;\n");
  fx.git(right, "add", "-A");
  fx.git(right, "commit", "-qm", "lane right");

  const set = waveLanes([
    member({ id: 1, lane: "lib/left.js", files: ["lib/left.js"], worktree: left }),
    member({ id: 2, lane: "lib/right.js", files: ["lib/right.js"], worktree: right }),
  ]);
  const lanes = set.lanes.map(pinnedLane);
  const result = joinWaveLanes({ wave: { id: "wave_01" }, lanes, tree: join, base: fx.base, at: "2026-11-22T00:00:00.000Z" });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.merged, true);
  assert.equal(result.verified, true, "the commit carries the tree the pre-flight read");
  assert.equal(result.parents, 3, "one parent for the base and one per lane: an octopus, not a chain");
  // ONE COMMIT ON THE AGGREGATE'S OWN LINE. The lanes' own commits are parents of the merge, so a plain count across
  // `base..HEAD` would count them too; `--first-parent` walks the line the join drew, and there is exactly one commit
  // on it. There is also exactly one commit with two or more parents, which is the octopus itself.
  assert.equal(fx.git(join, "rev-list", "--count", "--first-parent", `${fx.base}..HEAD`), "1", "EXACTLY one commit");
  assert.equal(fx.git(join, "rev-list", "--count", "--min-parents=2", `${fx.base}..HEAD`), "1", "and it is the only merge");
  assert.equal(fx.git(join, "rev-list", "--parents", "-n", "1", "HEAD").split(/\s+/).length, 4);

  // The message names the LANE SET, not just "the merge": both lanes and both members are in the subject a reader sees.
  assert.match(result.message, /wave_01/);
  assert.match(result.message, /lib\/left\.js #1/);
  assert.match(result.message, /lib\/right\.js #2/);
  assert.deepEqual(result.lanes, ["lib/left.js", "lib/right.js"]);
  const subject = fx.git(join, "log", "-1", "--format=%s");
  assert.equal(subject, result.message, "the commit's subject is the message the join reported");

  // Both lanes' files are in the joined tree, each with the content its lane committed.
  assert.equal(fx.git(join, "show", "HEAD:lib/left.js"), "export const left = 1;");
  assert.equal(fx.git(join, "show", "HEAD:lib/right.js"), "export const right = 2;");
  assert.equal(result.record.commit, result.commit);
  assert.equal(result.record.branches.length, 2);
  assert.equal(result.record.verified, true);
  for (const branch of result.record.branches) {
    assert.match(branch.stage, /#\d+$/);
    assert.match(branch.commit, /^[0-9a-f]{40,64}$/);
  }
});

test("a stage pin names its commit AND its blob, so a squash-rewritten sha still identifies what landed", (t) => {
  const fx = fixture(t);
  const lane = cut(fx, "lane-left", "lane-left");
  fx.write(lane, "lib/left.js", "export const left = 1;\n");
  fx.git(lane, "add", "-A");
  fx.git(lane, "commit", "-qm", "lane left");
  const recorded = fx.git(lane, "rev-parse", "HEAD");
  const blob = fx.git(lane, "rev-parse", "HEAD:lib/left.js");

  const pin = readMemberPin({ member: member({ id: 1, files: ["lib/left.js"], worktree: lane }) });
  assert.equal(pin.ok, true, pin.why);
  assert.equal(pin.commit, recorded, "the pin names the commit the member settled at, full length");
  assert.equal(pin.files[0].path, "lib/left.js");
  assert.equal(pin.files[0].blob, blob, "and the blob id that commit holds for the file it claims");

  // The landing, as this repo does it: a SQUASH onto main rewrites the sha. The recorded commit is not an ancestor of
  // main - so ancestry can never be the evidence - while the blob at the pin is still main's copy of the file.
  fx.git(fx.main, "merge", "--squash", "-q", "lane-left");
  fx.git(fx.main, "commit", "-qm", "land the left lane");
  const landed = fx.git(fx.main, "rev-parse", "HEAD");
  assert.notEqual(landed, recorded, "the squash wrote a different sha");
  let ancestor = true;
  try {
    fx.git(fx.main, "merge-base", "--is-ancestor", recorded, "HEAD");
  } catch {
    ancestor = false;
  }
  assert.equal(ancestor, false, "the recorded sha is NOT an ancestor of main: ancestry is not evidence here");
  assert.equal(fx.git(fx.main, "rev-parse", "HEAD:lib/left.js"), pin.files[0].blob, "the pin's blob is what landed");

  // And the pin verifies as a pin: the commit and blob together are the identity, so a pin whose blob differs is
  // refused rather than read as "the same file".
  const check = pinCheck(lane, { commit: pin.commit, path: "lib/left.js", blob: pin.files[0].blob });
  assert.equal(check.ok, true, check.reason);
  const wrong = pinCheck(lane, { commit: pin.commit, path: "lib/left.js", blob: recorded });
  assert.equal(wrong.ok, false, "a blob that is not the recorded one is a refusal, not a pass");
});

test("a wave with no lanes folds and draws exactly as it did before lanes existed", () => {
  const members = [
    member({ id: 1, state: "done", files: ["lib/a.js"], worktree: "/w/a" }),
    member({ id: 2, state: "queued", files: ["lib/b.js"], worktree: "/w/b" }),
  ];
  const readGate = () => ({ check: "pr-merged", state: "met", met: true, closed: true, cannotTell: false, why: "#1 merged" });
  const wave = { id: "wave_01", initiativeId: "init_a", position: 1, title: "W", template: null, entryGate: null, exitGate: { check: "pr-merged" }, auto: false };

  const drawn = waveView({ wave, members, readGate, evidenceFor: () => null });
  assert.equal(drawn.laneCount, 1);
  assert.equal(drawn.laneImplicit, true, "the one lane is the panel's, not a member's");
  assert.equal(drawn.laneJoinOwed, false, "no join is owed");
  assert.equal(drawn.state, "done");
  assert.equal(drawn.stateWhy, "the exit gate reads met: #1 merged", "the fold's sentence is the one it always was: no lane clause is appended");
  assert.equal(drawn.laneRefused, null);

  // The fold on its own: same state, same sentence.
  const folded = deriveWaveState({ wave, members, readGate, evidenceFor: () => null });
  assert.deepEqual(folded, { state: "done", why: "the exit gate reads met: #1 merged" });

  // And the record gains nothing: the view's lanes are derived, and the wave object the store handed over is untouched.
  assert.equal("lanes" in wave, false, "nothing was written onto the wave");
});

test("a wave whose lane reads cannot be made answers cannot tell, and does not close", () => {
  const members = [
    member({ id: 1, lane: "lib/a.js", files: [], worktree: "/w/a", state: "done" }),
    member({ id: 2, lane: "lib/b.js", files: [], worktree: "", state: "done" }),
  ];
  const readGate = () => ({ check: "pr-merged", state: "met", met: true, closed: true, cannotTell: false, why: "#1 merged" });
  const wave = { id: "wave_01", initiativeId: "init_a", position: 1, title: "W", exitGate: { check: "pr-merged" }, entryGate: null, template: null, auto: false };

  const drawn = waveView({ wave, members, readGate, evidenceFor: () => null });
  assert.equal(drawn.laneCount, 2);
  assert.equal(drawn.laneJoinOwed, true);
  assert.equal(drawn.state, "unknown", "a lane that cannot be named is cannot tell, never done");
  assert.match(drawn.stateWhy, /#2 has run but names no tree/);
  assert.match(drawn.stateWhy, /cannot close/);
  assert.equal(drawn.lanes[1].read.ok, false);
  assert.equal(drawn.lanes[0].read.ok, true, "the lane that CAN be named is not punished for its sibling");

  // The same lane set with a tree named: the wave closes.
  const healed = waveView({ wave, members: [members[0], { ...members[1], worktree: "/w/b" }], readGate, evidenceFor: () => null });
  assert.equal(healed.state, "done");
  assert.match(healed.stateWhy, /its 2 lanes can each be named, so the close is one join/);

  // A lane that never ran owes the join nothing: a queued member with no tree does not make its lane blind.
  const queued = readWaveLane({ label: "lib/c.js", members: [member({ id: 6, state: "queued", worktree: "" })] });
  assert.equal(queued.ok, true, "a member that never got a tree has nothing the join has to name");
});

test("two lanes that share a tree are refused as a lane set, and the wave answers blocked", () => {
  const members = [
    member({ id: 1, lane: "left", files: [], worktree: "/w/same", state: "done" }),
    member({ id: 2, lane: "right", files: [], worktree: "/w/same", state: "done" }),
  ];
  const set = waveLanes(members);
  assert.equal(set.count, 2);
  assert.ok(set.refused, "a lane set that shares a tree is refused");
  assert.match(set.refused.why, /lane left and lane right share the tree \/w\/same/);
  assert.deepEqual(set.refused.trees, ["/w/same"]);

  const drawn = waveView({
    wave: { id: "wave_01", initiativeId: "init_a", position: 1, title: "W", exitGate: null, entryGate: null, template: null, auto: false },
    members,
    readGate: () => ({ state: "met", met: true, why: "x" }),
  });
  assert.equal(drawn.state, "blocked", "the lane set is wrong, so the wave is held");
  assert.match(drawn.stateWhy, /share the tree/);
  assert.match(drawn.laneRefused, /share the tree/);
});

test("the join refuses every shape it cannot name, and names the lane it refused", () => {
  const wave = { id: "wave_01" };
  const one = { label: "lib/a.js", members: [member({ id: 1, files: [], worktree: "/w/a", pin: { commit: "a".repeat(40) } })] };
  const two = { label: "lib/b.js", members: [member({ id: 2, files: [], worktree: "/w/b", pin: { commit: "b".repeat(40) } })] };

  const noWave = joinWaveLanes({ lanes: [one, two], tree: "/w/join" });
  assert.equal(noWave.ok, false);
  assert.match(noWave.reason, /no wave to name the join/);

  const single = joinWaveLanes({ wave, lanes: [one], tree: "/w/join" });
  assert.equal(single.code, "wave-join-input");
  assert.match(single.reason, /a join is owed by two or more/);

  const noTree = joinWaveLanes({ wave, lanes: [one, two] });
  assert.match(noTree.reason, /needs the tree to merge into/);

  const unpinned = joinWaveLanes({ wave, lanes: [one, { label: "lib/b.js", members: [member({ id: 2, files: [], worktree: "" })] }], tree: "/w/join" });
  assert.match(unpinned.reason, /lib\/b\.js #2 has no pin that reads/);
  assert.match(unpinned.reason, /never by the branch it happens to carry/);

  const nothingRan = joinWaveLanes({ wave, lanes: [one, { label: "lib/b.js", members: [] }], tree: "/w/join" });
  assert.match(nothingRan.reason, /lib\/b\.js names nothing that ran/);

  const threw = joinWaveLanes({ wave, lanes: [one, two], tree: "/w/join", aggregate: () => { throw new Error("git is missing"); } });
  assert.equal(threw.ok, false);
  assert.equal(threw.code, "wave-join");
  assert.match(threw.reason, /the aggregate threw: git is missing/);

  // A conflict is a refusal that names the paths and reports the aggregate's own code - never a half-made merge.
  const conflict = joinWaveLanes({
    wave,
    lanes: [one, two],
    tree: "/w/join",
    aggregate: () => ({ ok: false, code: "pipeline-conflict", merged: false, commit: "c".repeat(40), conflicts: ["lib/x.js"], reason: "two lanes changed lib/x.js" }),
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "pipeline-conflict");
  assert.deepEqual(conflict.conflicts, ["lib/x.js"]);
  assert.equal(conflict.merged, false);
  assert.equal(conflict.record, null, "nothing is recorded for a merge that did not happen");
});

test("a wave's lanes are in the payload the initiatives route carries", () => {
  const members = [
    member({ id: 1, lane: "lib/a.js", files: ["lib/a.js"], worktree: "/w/a" }),
    member({ id: 2, lane: "lib/a.js", files: ["lib/a.js"], worktree: "/w/b" }),
    member({ id: 3, lane: null, files: ["lib/c.js"], worktree: "/w/c" }),
  ];
  const drawn = waveView({
    wave: { id: "wave_01", initiativeId: "init_a", position: 1, title: "W", exitGate: null, entryGate: null, template: null, auto: false },
    members,
    readGate: () => ({ state: "met", met: true, why: "x" }),
  });
  // A JSON round trip, because the route's answer is JSON: what a reader of /api/waves gets must survive serialisation.
  const payload = JSON.parse(JSON.stringify(drawn));
  assert.equal(payload.laneCount, 2);
  assert.equal(payload.laneJoinOwed, true);
  assert.equal(payload.laneIsolation, "per-stage");
  assert.deepEqual(payload.lanes.map((lane) => lane.label), ["lib/a.js", "unlaned"]);
  assert.deepEqual(payload.lanes[0].memberIds, [1, 2]);
  assert.equal(payload.lanes[0].read.ok, true);
  assert.equal(JSON.stringify(payload.lanes[0]).includes("/w/a"), true, "the lane names the trees it ran in");
});

test("the lane's markup draws lanes only for two or more, and says a lane it cannot read", async () => {
  await import("../public/core/waves-lane.js");
  const view = globalThis.wtWavesLane;
  const wave = {
    id: "wave_01",
    position: 1,
    title: "W",
    state: "done",
    stateWord: "done",
    stateWhy: "the exit gate reads met; its 2 lanes can each be named",
    gates: { entry: { state: "none", check: null }, exit: { state: "met", check: "pr-merged", why: "merged" } },
    template: null,
    templateResolved: null,
    auto: false,
    laneCount: 2,
    laneJoinOwed: true,
    laneIsolation: "per-stage",
    laneRefused: null,
    lanes: [
      { name: "lib/a.js", label: "lib/a.js", state: "done", members: [member({ id: 1, worktree: "/w/a" })], trees: ["/w/a"], read: { ok: true, why: "lane lib/a.js names 1 tree" } },
      { name: null, label: "unlaned", state: "queued", members: [member({ id: 2, state: "queued", worktree: "" })], trees: [], read: { ok: false, why: "#2 names no tree" } },
    ],
    members: [member({ id: 1, worktree: "/w/a" }), member({ id: 2, state: "queued", worktree: "" })],
  };
  const html = view.waveHtml(wave, null);
  assert.match(html, /data-wave-lanes="2"/);
  assert.match(html, /data-lane-isolation="per-stage"/);
  assert.match(html, /data-wave-join="2"/);
  assert.match(html, /ONE commit that names them all/);
  assert.match(html, /data-wave-lane="lib\/a\.js"[^>]*data-lane-read="ok"/);
  assert.match(html, /data-wave-lane="unlaned"[^>]*data-lane-read="cannot-tell"/);
  assert.match(html, /#2 names no tree/, "a lane that cannot be read says why, instead of drawing an empty lane");

  // ONE lane is drawn exactly as before: no lane block, the members in a flat list.
  const flat = view.waveHtml({ ...wave, lanes: [wave.lanes[0]], laneCount: 1, laneJoinOwed: false }, null);
  assert.doesNotMatch(flat, /wave-lanes/);
  assert.doesNotMatch(flat, /wave-join/);
  assert.match(flat, /data-wave-member="1"/);

  // A refused lane set is an alert, not a footnote.
  const refused = view.waveHtml({ ...wave, laneRefused: "lane a and lane b share the tree /w/x" }, null);
  assert.match(refused, /wave-lanes-bad/);
  assert.match(refused, /role="alert"/);
  assert.match(refused, /cannot be isolated/);
});
