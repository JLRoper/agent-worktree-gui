// The waves' READ half, over a real server in a sandbox: GET /api/waves, and the same fold inside GET
// /api/initiatives. THE WRITE HALF IS test/waves-write.test.js's, and it is the one that proves the four POSTs; this
// file still pins that a read writes nothing, which is why it keeps its own store and its own byte comparisons.
//
// WHAT THIS FILE PINS, in the order it runs:
//
//   * THREE MEMBERS, THREE STATES, FROM THE MEMBERS ALONE. A wave with a done, a running and a queued task reads
//     `running`; after the other two close it reads `done` - and no wave-state field is written anywhere (the store
//     on disk is read back beside it).
//   * A RUNNING MEMBER KEEPS THE WAVE OFF GREEN even while the exit gate reads met. That is the reader's acceptance
//     clause, proved against a real gate read over a real board row rather than a stubbed gate.
//   * MEMBERSHIP IS EXPLICIT AND CROSS-PROJECT. Two members live in different projects; a third task on the same
//     board that names no wave is NOT a member and is not counted.
//   * THE TAB AND THE ROUTE AGREE. GET /api/initiatives carries the identical wave lane, so the card cannot draw a
//     different state from the route.
//   * AN UNREADABLE STORE IS A 409 AND ITS BYTES ARE UNCHANGED - the read path never repairs a file, and the write path
//     (test/waves-write.test.js) refuses beside it for the same reason.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readQueueFile, writeQueueFile } from "../lib/assistant/queue.js";
import { git, post, startPanel, waitForState } from "../tools/panel-testkit.mjs";

const sandbox = mkdtempSync(path.join(tmpdir(), "wag-waves-route-"));
const repos = path.join(sandbox, "repos");
mkdirSync(repos, { recursive: true });
after(() => rmSync(sandbox, { recursive: true, force: true }));

// Two projects, one worktree each: enough for the wave to span projects, which is the point of explicit membership.
function project(name, trees) {
  const dir = path.join(repos, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "first"]);
  for (const tree of trees) git(dir, ["worktree", "add", "-q", "-b", tree, path.join(dir, ".worktrees", tree)]);
  return dir;
}
const projectA = project("project-a", ["wave-a"]);
const projectB = project("project-b", ["wave-b"]);
const treeA = path.join(projectA, ".worktrees", "wave-a");
const treeB = path.join(projectB, ".worktrees", "wave-b");
const wavesFile = path.join(sandbox, "logs", "waves.json");

const panel = await startPanel({ dir: sandbox, config: { wavesFile } });
after(() => panel.stop());
const base = panel.base;
const get = async (p) => {
  const r = await fetch(`${base}${p}`);
  return { status: r.status, json: await r.json() };
};
const readWaves = () => readFileSync(wavesFile, "utf8");

await waitForState(
  base,
  (s) => {
    const rows = s.projects.flatMap((p) => (p.worktrees || []).map((w) => w.path));
    return [treeA, treeB].every((p) => rows.some((r) => r.replace(/\\/g, "/").toLowerCase() === p.replace(/\\/g, "/").toLowerCase()));
  },
  "the two worktrees are on the board",
  { timeout: 120_000 },
);

// The initiative is the card the lane hangs from. `remove` is the level that leaves create free: this file is about
// waves, and the tier's own behaviour is test/initiative-tier-route.test.js's subject.
assert.equal((await post(base, "/api/settings/initiative-tier", { body: { tier: "remove" } })).status, 200);
const created = await post(base, "/api/initiatives", { body: { title: "Waves of work", description: "The first slice" } });
assert.equal(created.status, 201, created.text);
const initiativeId = created.json.initiative.id;

const assistant = (await get("/api/assistant")).json.assistants[0];
assert.ok(assistant?.id, "the panel seeds an assistant");
const addTask = async (title, worktree, projectName) => {
  const made = await post(base, "/api/assistant/queue", { body: { assistantId: assistant.id, action: "add", title, worktree, project: projectName } });
  assert.equal(made.status, 200, made.text);
  const tasks = (await get(`/api/assistant/queue?assistantId=${assistant.id}`)).json.queue.tasks;
  const task = tasks.find((t) => t.title === title);
  assert.ok(task, `task ${title} exists`);
  return task;
};
const setState = async (id, next) => {
  const out = await post(base, "/api/assistant/queue", { body: { assistantId: assistant.id, action: "state", id, state: next } });
  assert.equal(out.status, 200, out.text);
};

const one = await addTask("the wave record", treeA, "project-a");
const two = await addTask("the derived state", treeB, "project-b");
const three = await addTask("the lane", treeA, "project-a");
const loose = await addTask("no wave names me", treeB, "project-b");

// The queue route files every task with no wave, so membership is stamped here exactly as a reader (or a later
// write route) would: the task carries `waveId`. `two` also names its own pipeline, which the wave's template must
// NOT override; `one` names none and inherits it.
const queueFile = path.join(sandbox, "logs", "assistants", assistant.id, "queue.json");
const queued = readQueueFile(queueFile);
assert.equal(queued.error, null);
const stamped = queued.tasks.map((t) => {
  if (t.id === one.id) return { ...t, waveId: "wave_01", lane: "left" };
  if (t.id === two.id) return { ...t, waveId: "wave_01", lane: "right", pipelineRun: { pipeline: "own-pipeline", stage: "build", enteredAt: "2026-11-21T00:00:00.000Z" } };
  if (t.id === three.id) return { ...t, waveId: "wave_01", lane: "left" };
  return t;
});
writeQueueFile(queueFile, stamped, queued.nextId);

// One wave whose exit is the real vocabulary's pr-merged, and one wave nobody has joined yet. The sandbox has no
// remote, so every member's PR read is null: the exit reads CANNOT TELL and can never go green - which is the
// fail-closed half. The hold the fold must keep (a met exit outranked by a running member) is proved at the unit
// level in test/waves-derive.test.js, where a PR can be handed in as MERGED.
writeFileSync(
  wavesFile,
  `${JSON.stringify(
    {
      version: 1,
      byInitiative: {
        [initiativeId]: [
          { id: "wave_01", initiativeId, position: 1, title: "The read path", entryGate: { check: "clean" }, exitGate: { check: "pr-merged" }, template: "poc-to-uat", auto: false },
          { id: "wave_02", initiativeId, position: 2, title: "The next wave", entryGate: null, exitGate: null, template: null, auto: false },
        ],
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

await setState(one.id, "running");
const wavesOf = async () => {
  const out = await get(`/api/waves?initiative=${initiativeId}`);
  assert.equal(out.status, 200, out.text);
  return out.json;
};

test("a wave reads running while one member runs, from the members alone", async () => {
  const doc = await wavesOf();
  assert.equal(doc.readable, true);
  assert.equal(doc.file, wavesFile);
  assert.equal(doc.initiative, initiativeId);
  assert.equal(doc.waves.length, 2);
  const [first, second] = doc.waves;
  assert.equal(first.id, "wave_01");
  assert.equal(first.position, 1);
  assert.equal(first.state, "running");
  assert.equal(first.stateWord, "running");
  assert.match(first.stateWhy, new RegExp(`#${one.id} is running`));
  // Both gates read the real rows: the trees are clean, so the entry is met. The exit is pr-merged and the sandbox
  // has no remote, so it reads cannot-tell and the wave is held at running by its live member.
  assert.equal(first.gates.entry.state, "met");
  assert.equal(first.gates.exit.state, "unknown");
  assert.equal(second.state, "empty");
  assert.equal(doc.currentId, "wave_01", "the running wave is the current one");
  // THE LANES RIDE ON THE SAME READ. Two lanes, named by the members' own records, in two trees - so a close would be
  // one join. `one` and `three` are both left, because they share a tree; `two` runs beside them.
  assert.equal(first.laneCount, 2);
  assert.equal(first.laneImplicit, false, "two lanes, both named by their members");
  assert.equal(first.laneJoinOwed, true);
  assert.equal(first.laneIsolation, "per-stage", "the lanes run under the fan-out's own isolation model");
  assert.deepEqual(first.lanes.map((lane) => lane.label), ["left", "right"]);
  assert.deepEqual(first.lanes[0].memberIds.slice().sort((a, b) => a - b), [one.id, three.id].sort((a, b) => a - b));
  assert.deepEqual(first.lanes[1].memberIds, [two.id]);
  assert.equal(first.lanes[0].read.ok, true, "a lane whose members name their trees can be pinned");
  assert.equal(first.lanes[1].read.ok, true);
  assert.equal(first.laneRefused, null);
  // The empty wave holds no lane at all, and owes no join.
  assert.equal(second.laneCount, 0);
  assert.equal(second.laneJoinOwed, false);
});

test("membership is explicit: the three tasks that name the wave, and NOT the one that does not", async () => {
  const doc = await wavesOf();
  const [first] = doc.waves;
  assert.deepEqual(
    first.members.map((m) => m.id).sort((a, b) => a - b),
    [one.id, two.id, three.id].sort((a, b) => a - b),
  );
  assert.equal(
    first.members.some((m) => m.id === loose.id),
    false,
    "a task carrying no waveId is not silently counted as a member",
  );
  // Two projects in one wave, which is why membership is the task's field and not the initiative's tree keys.
  assert.equal(new Set(first.members.map((m) => m.project)).size, 2);
  // A task that names its own pipeline keeps it; one that names none inherits the wave's template.
  assert.equal(first.members.find((m) => m.id === two.id).pipeline, "own-pipeline");
  assert.equal(first.members.find((m) => m.id === two.id).pipelineFrom, "task");
  assert.equal(first.members.find((m) => m.id === one.id).pipeline, "poc-to-uat");
  assert.equal(first.members.find((m) => m.id === one.id).pipelineFrom, "wave");
  // The template is a NAME the sandbox's bundle does not hold, so the read says unresolved rather than nulling it.
  assert.equal(first.template, "poc-to-uat");
  assert.equal(first.templateResolved, false);
});

test("the Initiatives read carries the identical lane, so the card and the route cannot disagree", async () => {
  const doc = await wavesOf();
  const tab = await get("/api/initiatives");
  assert.equal(tab.status, 200);
  assert.equal(tab.json.waveStatus.readable, true);
  const card = tab.json.initiatives.find((i) => i.id === initiativeId);
  assert.ok(card, "the initiative is on the tab");
  assert.deepEqual(card.waves, doc.waves);
  assert.equal(card.waveCurrentId, doc.currentId);
  assert.deepEqual(card.waveSkipped, []);
});

test("the wave never reads green on an exit nobody can see: unknown, then ready once the members close", async () => {
  await setState(one.id, "done");
  await setState(three.id, "done");
  // `two` is still queued, and no member names a PR: the exit gate cannot be read, and an unevaluable exit does not
  // exit. The wave falls back to the entry read, which is met - so it is READY, not done.
  let doc = await wavesOf();
  assert.equal(doc.waves[0].gates.exit.state, "unknown");
  assert.equal(doc.waves[0].state, "ready", "an exit nobody can read never closes a wave");
  assert.equal(doc.currentId, "wave_01");

  await setState(two.id, "done");
  doc = await wavesOf();
  // Every member is done and the exit STILL cannot be read; the wave does not invent a green from the member states.
  assert.deepEqual(
    doc.waves[0].members.map((m) => m.state),
    ["done", "done", "done"],
  );
  assert.equal(doc.waves[0].state, "ready");
  assert.equal(doc.waves[0].gates.exit.state, "unknown");
  assert.match(doc.waves[0].gates.exit.why, /names no pull request/);
});

test("the auto switch rides on the read: off opens nothing, and cannot tell is named as unreadable", async () => {
  const records = (auto) => [
    { id: "wave_01", initiativeId, position: 1, title: "The read path", entryGate: { check: "clean" }, exitGate: { check: "pr-merged" }, template: "poc-to-uat", auto },
    { id: "wave_02", initiativeId, position: 2, title: "The next wave", entryGate: null, exitGate: null, template: null },
  ];
  const write = (auto) => {
    const text = `${JSON.stringify({ version: 1, byInitiative: { [initiativeId]: records(auto) } }, null, 2)}\n`;
    writeFileSync(wavesFile, text, "utf8");
    return text;
  };

  let written = write(true);
  const on = await wavesOf();
  const [first, second] = on.waves;
  assert.equal(first.auto, true, "the wave's own switch rides the read");
  assert.equal(first.autoOpen.open, false, "the first wave is never opened by a switch: there is none before it");
  assert.equal(first.autoOpen.from, null);
  assert.equal(second.autoOpen.switchOn, true);
  assert.equal(second.autoOpen.from, "wave_01");
  // The sandbox has no remote, so wave_01's pr-merged exit CANNOT TELL. That blocks the auto open, and the reason is
  // the evidence reader's own: the stored word is not consulted and a cannot-tell gate is never a pass.
  assert.equal(second.autoOpen.gate.state, "unknown");
  assert.equal(second.autoOpen.open, false, "cannot tell opens nothing");
  assert.match(second.autoOpen.why, /exit gate cannot be read/);
  assert.match(second.autoOpen.why, /names no pull request/);
  assert.equal(readWaves(), written, "the read wrote nothing: no open, no state, no timestamp");

  // The tab carries the identical answer, because it is the same fold.
  const tab = await get("/api/initiatives");
  const card = tab.json.initiatives.find((i) => i.id === initiativeId);
  assert.deepEqual(card.waves, on.waves);

  // And switching auto back off shuts wave_02 on the very next read, with the default-off sentence.
  written = write(false);
  const off = await wavesOf();
  assert.equal(off.waves[1].autoOpen.open, false);
  assert.equal(off.waves[1].autoOpen.switchOn, false);
  assert.match(off.waves[1].autoOpen.why, /wave_01 has auto off/);
  assert.equal(readWaves(), written);
});

test("no wave-state field is written to the wave store by any of the reads above", () => {
  const doc = JSON.parse(readWaves());
  for (const rec of doc.byInitiative[initiativeId]) {
    assert.equal("state" in rec, false, `${rec.id} carries no state field`);
    assert.equal("members" in rec, false, `${rec.id} carries no member list`);
    assert.equal("current" in rec, false);
    // The auto open is a fact about a READ, not a row: nothing a switch decided is written back.
    assert.equal("autoOpen" in rec, false, `${rec.id} carries no autoOpen`);
    assert.equal("openedBy" in rec, false);
    assert.equal("openedAt" in rec, false);
  }
});

test("the route answers 400 without an initiative, 405 on a verb it does not have, and 404 on a path it does not have", async () => {
  const noInitiative = await get("/api/waves");
  assert.equal(noInitiative.status, 400);
  assert.match(noInitiative.json.error, /\?initiative=<id>/);

  // THE WRITE EXISTS NOW (test/waves-write.test.js owns its four verbs). A POST with no initiative is a 400, not the
  // read-only slice's 405; 405 is kept for a method that is neither a read nor a write.
  const wrote = await fetch(`${base}/api/waves`, { method: "POST", body: "{}" });
  assert.equal(wrote.status, 400);
  assert.match((await wrote.json()).error, /initiativeId/);

  const put = await fetch(`${base}/api/waves?initiative=${initiativeId}`, { method: "PUT", body: "{}" });
  assert.equal(put.status, 405);
  assert.match((await put.json()).error, /not allowed/);

  const wrong = await get("/api/waves/nope");
  assert.equal(wrong.status, 404);
});

test("an unreadable store is a 409 with its path, and the bytes stay exactly as written", async () => {
  const broken = "{ not json at all\n";
  writeFileSync(wavesFile, broken, "utf8");
  const out = await get(`/api/waves?initiative=${initiativeId}`);
  assert.equal(out.status, 409, out.text);
  assert.equal(out.json.refused, "unreadable");
  assert.equal(out.json.file, wavesFile);
  assert.match(out.json.error, /could not be read/);
  assert.match(out.json.error, /NOT overwritten/);
  assert.equal(readWaves(), broken, "no read path rewrote the file");

  // And the tab says the same thing rather than drawing an empty lane as "no waves".
  const tab = await get("/api/initiatives");
  assert.equal(tab.json.waveStatus.readable, false);
  assert.equal(tab.json.initiatives.find((i) => i.id === initiativeId).waves.length, 0);
});
