// The wave WRITER: the store's four changes, and the four routes that expose them.
//
// The read side is test/waves-store.test.js's and test/waves-route.test.js's subject. This file pins the half that did
// not exist before it: a wave can be created, edited, reordered and deleted from the panel, and every rule the read
// side established still holds over a store a writer has touched.
//
// WHAT THIS FILE PINS, store first and then wire:
//
//   * CREATE writes VERSION 2 with the record's seven fields plus provenance, lands last when no position is posted,
//     and the file on disk is the document the next read parses (a create answers `ok` only after the save).
//   * THE DOOR IS THE LOADER'S DOOR. A posted `state`, `lanes`, `done` or a member list is REFUSED BY NAME; a gate
//     outside the vocabulary is refused by name; a title longer than 120 characters is CLIPPED, not refused; a
//     duplicate id and a taken position are refused rather than renumbered.
//   * MOVE renumbers 1..n in one write and clamps `to` into range; EDIT is not a move, and an edit that changes
//     nothing writes nothing and records nothing.
//   * PROVENANCE: create stamps `at`/`by` and one `create` event; an edit appends an `edit` event; the history keeps
//     the newest 20 and drops the oldest.
//   * REMOVE deletes the record and nothing else: a task row that names the id still names it, and the route counts
//     those rows in its answer.
//   * A REFUSAL LEAVES THE BYTES ALONE: an unreadable store is a 409 with its path and its sentence, and a store with
//     a record the loader skipped refuses a write naming that record (decision 3), because serialising the document
//     would drop it.
//   * THE TIER decides whether a change asks: `all` asks about all four, `remove` asks only about a delete, `own`
//     asks about a delete of somebody else's wave and not about the actor's own, `none` asks nothing. An asked change
//     writes nothing (202) and its title names the wave.
//   * THE WRITER IS NOT A SECOND WRITER: initiatives.json is byte-identical after a wave is created, and GET
//     /api/waves answers identically for a store it did not touch.
//   * 405 IS KEPT WHERE IT IS STILL TRUE: a PUT is not a verb, and GET on a write path is not a read. A GET
//     /api/waves still answers 200 for an initiative with no waves once a writer exists.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readQueueFile, writeQueueFile } from "../lib/assistant/queue.js";
import { Waves, WAVES_MAX, WAVE_HISTORY_MAX, WAVE_TITLE_MAX, waveIdFrom } from "../lib/waves.js";
import { initiativeAsks } from "../lib/initiative-permissions.js";
import { git, post, startPanel, waitForState } from "../tools/panel-testkit.mjs";

const sandbox = mkdtempSync(path.join(tmpdir(), "wag-waves-write-"));
const repos = path.join(sandbox, "repos");
const wavesFile = path.join(sandbox, "state", "waves.json");
const initiativesFile = path.join(sandbox, "state", "initiatives.json");
mkdirSync(repos, { recursive: true });

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const readBytes = (file) => readFileSync(file, "utf8");

// ---- the store, without a server ------------------------------------------------------------------------------------
// One fresh directory per test so a refusal in one cannot be read as a state another left behind.
function storeAt(name, now) {
  const dir = path.join(sandbox, "store", name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "waves.json");
  return { file, waves: new Waves({ file, now: now || (() => Date.parse("2026-11-23T12:00:00.000Z")) }) };
}

test("create writes version 2, lands last, and the file is what the next read parses", () => {
  const { file, waves } = storeAt("create");
  assert.equal(waves.create({ initiativeId: "init_a", title: "Prove the callback" }).ok, true);
  const second = waves.create({ initiativeId: "init_a", title: "Then the VIP", by: "assistant-1" });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.wave.position, 2);
  assert.equal(second.wave.id, "then-the-vip");
  assert.equal(second.wave.by, "assistant-1");

  const doc = readJson(file);
  assert.equal(doc.version, 2);
  assert.ok(doc.savedAt, "the document carries its own stamp");
  assert.equal(doc.byInitiative.init_a.length, 2);
  const first = doc.byInitiative.init_a[0];
  assert.deepEqual(Object.keys(first), ["id", "initiativeId", "position", "title", "entryGate", "exitGate", "template", "auto", "at", "by", "history"]);
  assert.equal(first.id, "prove-the-callback");
  assert.equal(first.initiativeId, "init_a");
  assert.equal(first.auto, false);
  assert.equal(first.history[0].action, "create");
  // A SECOND READ, from a store object that never held this document, is the proof the save is what answers.
  const reread = new Waves({ file });
  assert.deepEqual(
    reread.wavesFor("init_a").map((wave) => [wave.id, wave.position, wave.title]),
    [
      ["prove-the-callback", 1, "Prove the callback"],
      ["then-the-vip", 2, "Then the VIP"],
    ],
  );
});

test("a version 1 document is read as it is and written back as version 2", () => {
  const dir = path.join(sandbox, "store", "v1");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "waves.json");
  writeFileSync(
    file,
    JSON.stringify({
      savedAt: "2026-11-20T00:00:00.000Z",
      byInitiative: {
        init_a: [{ id: "old-one", initiativeId: "init_a", position: 1, title: "Old one", entryGate: null, exitGate: null, template: null, auto: false }],
      },
    }),
  );
  const waves = new Waves({ file });
  assert.equal(waves.statusOf().readable, true);
  assert.equal(waves.wavesFor("init_a").length, 1);
  assert.equal(waves.wavesFor("init_a")[0].by, null, "an absent actor is not invented on the read");
  assert.equal(waves.wavesFor("init_a")[0].history.length, 0);
  const added = waves.create({ initiativeId: "init_a", title: "New one", by: "reader" });
  assert.equal(added.ok, true, added.error);
  assert.equal(added.wave.position, 2);
  const doc = readJson(file);
  assert.equal(doc.version, 2);
  assert.equal(doc.byInitiative.init_a[0].id, "old-one", "the version 1 record survives the upgrade");
  assert.equal(doc.byInitiative.init_a[0].history, undefined, "an empty history is not written as a field nobody authored");
  assert.equal(doc.byInitiative.init_a[1].history.length, 1);
});

test("the door refuses a stored state, a lane, a member list and a tree list BY NAME", () => {
  for (const field of ["state", "lanes", "members", "trees", "done", "openedBy", "autoOpen"]) {
    const { waves } = storeAt(`door-${field}`);
    const out = waves.create({ initiativeId: "init_a", title: "Wave", [field]: field === "state" ? "running" : [] });
    assert.equal(out.ok, false, `create refused ${field}`);
    assert.match(out.error, new RegExp(`no "${field}" field`));
    assert.equal(waves.wavesFor("init_a").length, 0, "a refused create writes nothing");
  }
  // THE READ DOOR IS TOLERANT, THE WRITE DOOR IS CLOSED. A file carrying a stored `state` still LOADS (the field is
  // dropped, never believed - test/waves-derive.test.js pins that), while a record handed to a WRITE carrying one is
  // refused by name. A read refusal here would turn one stale field into a store nobody could add to.
  const { waves } = storeAt("door-name");
  waves.create({ initiativeId: "init_a", title: "Wave" });
  writeFileSync(
    waves.file,
    JSON.stringify({
      version: 2,
      byInitiative: { init_a: [{ id: "w", initiativeId: "init_a", position: 1, title: "W", state: "running" }] },
    }),
  );
  const reread = new Waves({ file: waves.file });
  assert.equal(reread.statusOf().readable, true);
  assert.equal(reread.wavesFor("init_a").length, 1, "the record loads");
  assert.equal("state" in reread.wavesFor("init_a")[0], false, "and the stored state is not part of it");
  assert.equal(reread.skipped.length, 0);
  // The write door still refuses the field by name, before anything is written.
  const added = reread.create({ initiativeId: "init_a", title: "Another", state: "running" });
  assert.equal(added.ok, false);
  assert.match(added.error, /no "state" field/);
});

test("a gate outside the vocabulary is refused by name; a title over 120 is clipped", () => {
  const { waves } = storeAt("gate");
  const bad = waves.create({ initiativeId: "init_a", title: "Wave", entryGate: { check: "looks-good-to-me" } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /looks-good-to-me/);
  assert.match(bad.error, /is not one of the panel's exit checks/);
  assert.equal(waves.wavesFor("init_a").length, 0);

  const long = waves.create({ initiativeId: "init_a", title: "t".repeat(140) });
  assert.equal(long.ok, true, long.error);
  assert.equal(long.wave.title.length, WAVE_TITLE_MAX);
  // A posted id and a taken position are refusals, not renumberings.
  assert.equal(waves.create({ initiativeId: "init_a", title: "Second", id: long.wave.id }).ok, false);
  const taken = waves.create({ initiativeId: "init_a", title: "Third", position: 1 });
  assert.equal(taken.ok, false);
  assert.match(taken.error, /already has a wave at position 1/);
});

test("a wave's id derives from its title, and a second wave of the same title gets -2", () => {
  assert.equal(waveIdFrom("Prove the callback", new Set()), "prove-the-callback");
  assert.equal(waveIdFrom("  Spaces   and symbols!  ", new Set()), "spaces-and-symbols");
  assert.equal(waveIdFrom("Wave", new Set(["wave"])), "wave-2");
  assert.equal(waveIdFrom("Wave", new Set(["wave", "wave-2"])), "wave-3");
  const { waves } = storeAt("dup-title");
  assert.equal(waves.create({ initiativeId: "init_a", title: "Same" }).wave.id, "same");
  assert.equal(waves.create({ initiativeId: "init_a", title: "Same" }).wave.id, "same-2");
});

test("move renumbers 1..n in one write and clamps to the ends", () => {
  const { file, waves } = storeAt("move");
  for (const title of ["One", "Two", "Three"]) assert.equal(waves.create({ initiativeId: "init_a", title }).ok, true);
  const moved = waves.move({ initiativeId: "init_a", id: "three", to: 1 });
  assert.equal(moved.ok, true, moved.error);
  assert.equal(moved.to, 1);
  assert.deepEqual(waves.wavesFor("init_a").map((w) => [w.id, w.position]), [["three", 1], ["one", 2], ["two", 3]]);
  assert.deepEqual(moved.waves.map((w) => w.id), ["three", "one", "two"], "the answer carries the new order");
  // The file agrees with the answer, and every position is 1..n with no gap.
  assert.deepEqual(readJson(file).byInitiative.init_a.map((w) => w.position), [1, 2, 3]);
  // Clamped, not an error: 99 means "last".
  const last = waves.move({ initiativeId: "init_a", id: "three", to: 99 });
  assert.equal(last.to, 3);
  assert.deepEqual(waves.wavesFor("init_a").map((w) => w.id), ["one", "two", "three"]);
  // A move to where it already is changes nothing and writes no event.
  const events = waves.wavesFor("init_a").find((w) => w.id === "one").history.length;
  const noop = waves.move({ initiativeId: "init_a", id: "one", to: 1 });
  assert.equal(noop.changed, false);
  assert.equal(waves.wavesFor("init_a").find((w) => w.id === "one").history.length, events);
});

test("provenance: create stamps an event, edit appends one, and the history keeps the newest 20", () => {
  const { waves } = storeAt("history");
  const made = waves.create({ initiativeId: "init_a", title: "Wave", by: "assistant-1" });
  assert.equal(made.wave.by, "assistant-1");
  assert.match(made.wave.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(made.wave.history.length, 1);
  assert.equal(made.wave.history[0].action, "create");

  const edited = waves.update({ initiativeId: "init_a", id: made.wave.id, title: "Wave, renamed", by: "reader" });
  assert.equal(edited.ok, true, edited.error);
  assert.equal(edited.wave.history.length, 2);
  assert.equal(edited.wave.history[1].action, "edit");
  assert.match(edited.wave.history[1].detail, /the title/);
  assert.equal(edited.wave.by, "reader", "the last actor is the record's `by`");

  for (let n = 0; n < WAVE_HISTORY_MAX + 6; n += 1) {
    const out = waves.update({ initiativeId: "init_a", id: made.wave.id, title: `Wave ${n}`, by: "reader" });
    assert.equal(out.ok, true, out.error);
  }
  const kept = waves.wavesFor("init_a")[0].history;
  assert.equal(kept.length, WAVE_HISTORY_MAX);
  assert.equal(kept[kept.length - 1].detail, "the title", "the newest event is last");
  assert.equal(kept.some((ev) => ev.action === "create"), false, "the oldest events are the ones dropped");
  // An edit that changes nothing is not an event.
  const before = waves.wavesFor("init_a")[0].history.length;
  const same = waves.update({ initiativeId: "init_a", id: made.wave.id, title: waves.wavesFor("init_a")[0].title });
  assert.equal(same.changed, false);
  assert.equal(waves.wavesFor("init_a")[0].history.length, before);
});

test("remove deletes the record and touches nothing else", () => {
  const { file, waves } = storeAt("remove");
  waves.create({ initiativeId: "init_a", title: "One" });
  waves.create({ initiativeId: "init_a", title: "Two" });
  const out = waves.remove({ initiativeId: "init_a", id: "one", by: "reader" });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.wave.title, "One");
  assert.deepEqual(waves.wavesFor("init_a").map((w) => w.id), ["two"]);
  // The survivor was at 2 and the delete took the wave before it: the gap is closed in the same write, so the route
  // never draws a lone station labelled W2.
  assert.equal(waves.wavesFor("init_a")[0].position, 1);
  assert.deepEqual(readJson(file).byInitiative.init_a.map((w) => [w.id, w.position]), [["two", 1]]);
  // Removing the last wave leaves the initiative's key out rather than an empty array.
  assert.equal(waves.remove({ initiativeId: "init_a", id: "two" }).ok, true);
  assert.equal(readJson(file).byInitiative.init_a, undefined);
  assert.equal(waves.remove({ initiativeId: "init_a", id: "two" }).notFound, true);
});

test("the cap is 50 per initiative, and the 51st is refused by name", () => {
  const { waves } = storeAt("cap");
  for (let n = 0; n < WAVES_MAX; n += 1) {
    const out = waves.create({ initiativeId: "init_a", title: `Wave ${n + 1}` });
    assert.equal(out.ok, true, `wave ${n + 1}: ${out.error}`);
  }
  const over = waves.create({ initiativeId: "init_a", title: "One too many" });
  assert.equal(over.ok, false);
  assert.match(over.error, /already holds 50 waves, which is the cap/);
  // The other initiative is unaffected: the cap is per initiative, not per store.
  assert.equal(waves.create({ initiativeId: "init_b", title: "Fine" }).ok, true);
});

test("an unreadable store refuses the write and leaves its bytes exactly as they were", () => {
  const dir = path.join(sandbox, "store", "unreadable");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "waves.json");
  const garbage = "{ this is not json";
  writeFileSync(file, garbage);
  const waves = new Waves({ file });
  const out = waves.create({ initiativeId: "init_a", title: "Wave" });
  assert.equal(out.ok, false);
  assert.equal(out.refused, "unreadable");
  assert.equal(out.file, file);
  assert.match(out.error, /could not be read/);
  assert.match(out.error, /NOT overwritten/);
  assert.equal(readBytes(file), garbage);
});

test("the tier asks for the four wave changes, and `own` reads the wave's own actor", () => {
  for (const action of ["wave-create", "wave-edit", "wave-move", "wave-remove"]) {
    assert.equal(initiativeAsks("all", action, { actor: "reader" }), true, `${action} at all asks`);
    assert.equal(initiativeAsks("none", action, { actor: "reader" }), false, `${action} at none is free`);
  }
  // `remove` asks about a delete and nothing else.
  assert.equal(initiativeAsks("remove", "wave-remove", { actor: "reader" }), true);
  assert.equal(initiativeAsks("remove", "wave-create", { actor: "reader" }), false);
  assert.equal(initiativeAsks("remove", "wave-edit", { actor: "reader" }), false);
  assert.equal(initiativeAsks("remove", "wave-move", { actor: "reader" }), false);
  // `own` asks unless the wave's own `by` is the actor removing it.
  assert.equal(initiativeAsks("own", "wave-remove", { actor: "assistant-1", attachedBy: "assistant-2" }), true);
  assert.equal(initiativeAsks("own", "wave-remove", { actor: "assistant-1", attachedBy: "assistant-1" }), false);
  assert.equal(initiativeAsks("own", "wave-remove", { actor: "assistant-1", attachedBy: null }), true, "an unattributed wave is somebody else's");
  assert.equal(initiativeAsks("own", "wave-create", { actor: "assistant-1" }), false);
});

// ---- the wire, over a real server -----------------------------------------------------------------------------------
const projectDir = path.join(repos, "project-a");
mkdirSync(projectDir, { recursive: true });
git(projectDir, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(projectDir, "README.md"), "# project-a\n");
git(projectDir, ["add", "-A"]);
git(projectDir, ["commit", "-q", "-m", "first"]);
git(projectDir, ["worktree", "add", "-q", "-b", "wave-tree", path.join(projectDir, ".worktrees", "wave-tree")]);
const tree = path.join(projectDir, ".worktrees", "wave-tree");

const panel = await startPanel({ dir: sandbox, config: { wavesFile, initiativesFile } });
after(() => panel.stop());
const base = panel.base;
const get = async (p) => {
  const r = await fetch(`${base}${p}`);
  return { status: r.status, json: await r.json() };
};

await waitForState(
  base,
  (s) => {
    const rows = s.projects.flatMap((p) => (p.worktrees || []).map((w) => w.path));
    return rows.some((p) => p.replace(/\\/g, "/").toLowerCase() === tree.replace(/\\/g, "/").toLowerCase());
  },
  "the worktree is on the board",
  { timeout: 120_000 },
);

const madeInit = async (title) => {
  const r = await post(base, "/api/initiatives", { body: { title, description: "" } });
  assert.equal(r.status, 201, r.text);
  return r.json.initiative.id;
};
const setTier = async (tier) => {
  const r = await post(base, "/api/settings/initiative-tier", { body: { tier } });
  assert.equal(r.status, 200, r.text);
};

// `none` for the setup: this file's own tier table is the `tier` test, and the free level keeps the other tests about
// what a route writes rather than what it asks.
await setTier("none");
const initiativeId = await madeInit("A throwaway initiative");
const otherId = await madeInit("An initiative the writer never touches");

test("POST /api/waves creates a wave, GET /api/waves reads it back, and the tab's read agrees", async () => {
  const r = await post(base, "/api/waves", { body: { initiativeId, title: "Prove the write route", by: "assistant-3" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.changed, true);
  assert.equal(r.json.wave.id, "prove-the-write-route");
  assert.equal(r.json.wave.position, 1);
  assert.equal(r.json.wave.by, "assistant-3");
  // The answer carries the same lane the next GET would, so the tab cannot be told a different story.
  assert.equal(r.json.waves.length, 1);
  assert.equal(r.json.waves[0].state, "empty", "a wave with no member reads empty, and that state is derived, not posted");

  const read = await get(`/api/waves?initiative=${initiativeId}`);
  assert.equal(read.status, 200);
  assert.equal(read.json.waves.length, 1);
  assert.equal(read.json.waves[0].title, "Prove the write route");
  assert.equal(read.json.store.version, 2);
  assert.deepEqual(read.json.checks, ["clean", "pr-open", "pr-head", "pr-approved", "pr-merged"]);

  // THE TAB'S OWN READ: the lane arrives inside GET /api/initiatives, from the same fold.
  const tab = await get("/api/initiatives");
  const card = tab.json.initiatives.find((row) => row.id === initiativeId);
  assert.equal(card.waves.length, 1);
  assert.equal(card.waves[0].id, "prove-the-write-route");
  assert.deepEqual(tab.json.waveStatus.gateChoices, ["clean", "pr-open", "pr-head", "pr-approved", "pr-merged"]);

  // The file on disk is the version 2 document.
  const doc = readJson(wavesFile);
  assert.equal(doc.version, 2);
  assert.equal(doc.byInitiative[initiativeId][0].id, "prove-the-write-route");
});

test("POST /api/waves/update edits the title and the gates, and either reads back", async () => {
  const first = await get(`/api/waves?initiative=${initiativeId}`);
  const id = first.json.waves[0].id;
  const r = await post(base, "/api/waves/update", {
    body: { initiativeId, id, title: "Prove the write route, renamed", entryGate: { check: "clean" }, exitGate: { check: "pr-merged" }, by: "reader" },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.wave.title, "Prove the write route, renamed");
  assert.deepEqual(r.json.wave.entryGate, { check: "clean" });
  assert.deepEqual(r.json.wave.exitGate, { check: "pr-merged" });
  assert.equal(r.json.wave.history.length, 2);
  const read = await get(`/api/waves?initiative=${initiativeId}`);
  assert.equal(read.json.waves[0].title, "Prove the write route, renamed");
  assert.deepEqual(read.json.waves[0].entryGate, { check: "clean" });
  // The gate is stored as a NAME and read against the members: with no member there is nothing to check, so it reads
  // `none` rather than a stored answer - the read side's rule, not a field the write set.
  assert.deepEqual(read.json.waves[0].entryGate, { check: "clean" }, "the gate is stored as the check's name");
  assert.equal(read.json.waves[0].gates.entry.state, "none", "and it reads none while there is no member to check");
});

test("a posted state is refused by name over the wire, and a title over the cap is clipped", async () => {
  const bytes = readBytes(wavesFile);
  const bad = await post(base, "/api/waves", { body: { initiativeId, title: "Smuggler", state: "running" } });
  assert.equal(bad.status, 400, bad.text);
  assert.match(bad.json.error, /carries no "state" field/);
  assert.equal(readBytes(wavesFile), bytes, "a refused create writes nothing");
  const smuggle = await post(base, "/api/waves/update", { body: { initiativeId, id: "prove-the-write-route", lanes: ["a"] } });
  assert.equal(smuggle.status, 400, smuggle.text);
  assert.match(smuggle.json.error, /carries no "lanes" field/);

  const long = await post(base, "/api/waves", { body: { initiativeId, title: "z".repeat(140) } });
  assert.equal(long.status, 200, long.text);
  assert.equal(long.json.wave.title.length, WAVE_TITLE_MAX);
});

test("POST /api/waves/move reorders two waves and proves the positions hold", async () => {
  const created = await post(base, "/api/waves", { body: { initiativeId, title: "Second wave" } });
  assert.equal(created.status, 200, created.text);
  const before = await get(`/api/waves?initiative=${initiativeId}`);
  const count = before.json.waves.length;
  assert.ok(count >= 2, "there are at least two waves to swap");
  assert.deepEqual(before.json.waves.map((w) => w.position), before.json.waves.map((_, at) => at + 1), "the read is 1..n");
  const lastId = before.json.waves[count - 1].id;
  const moved = await post(base, "/api/waves/move", { body: { initiativeId, id: lastId, to: 1 } });
  assert.equal(moved.status, 200, moved.text);
  assert.equal(moved.json.to, 1);
  assert.equal(moved.json.order[0].id, lastId);
  assert.deepEqual(moved.json.order.map((w) => w.position), moved.json.order.map((_, at) => at + 1));
  const after = await get(`/api/waves?initiative=${initiativeId}`);
  assert.equal(after.json.waves[0].id, lastId);
  assert.deepEqual(after.json.waves.map((w) => w.position), after.json.waves.map((_, at) => at + 1));
  // The file agrees: contiguous 1..n, no gap and no duplicate.
  assert.deepEqual(readJson(wavesFile).byInitiative[initiativeId].map((w) => w.position), after.json.waves.map((_, at) => at + 1));
});

test("POST /api/waves/remove deletes the record, keeps the task row and counts it", async () => {
  const state = (await get("/api/assistant")).json;
  const assistantId = state.assistants[0].id;
  const made = await post(base, "/api/assistant/queue", { body: { assistantId, action: "add", title: "A member of a doomed wave", worktree: tree, project: "project-a" } });
  assert.equal(made.status, 200, made.text);
  // MEMBERSHIP IS THE TASK'S OWN FIELD, so the wave id is written where a scan would write it: the queue file beside
  // the assistant, through the queue module's own writer (which normalises the field), not through a route this test
  // is not about.
  const queueFile = (function find(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = find(full);
        if (found) return found;
      } else if (entry.name === "queue.json") return full;
    }
    return null;
  })(sandbox);
  assert.ok(queueFile, "the assistant's queue file exists");
  const queue = readQueueFile(queueFile);
  const task = queue.tasks.find((row) => row.title === "A member of a doomed wave");
  assert.ok(task, "the task exists");
  const before = await get(`/api/waves?initiative=${initiativeId}`);
  const id = before.json.waves[1].id; // the wave at the end
  writeQueueFile(
    queueFile,
    queue.tasks.map((row) => (row.id === task.id ? { ...row, waveId: id } : row)),
    queue.nextId,
  );
  const read = await get(`/api/waves?initiative=${initiativeId}`);
  const wave = read.json.waves.find((w) => w.id === id);
  assert.equal(wave.members.length, 1, "the task is a member of the wave");

  const removed = await post(base, "/api/waves/remove", { body: { initiativeId, id } });
  assert.equal(removed.status, 200, removed.text);
  assert.equal(removed.json.members, 1, "the answer counts the task rows that still name the id");
  assert.equal(removed.json.waves.some((w) => w.id === id), false);
  // THE ROW IS STILL THERE and still names the id: the delete touched the wave store only.
  const after = (await get(`/api/assistant/queue?assistantId=${assistantId}`)).json.queue.tasks.find((row) => row.id === task.id);
  assert.equal(after.waveId, id, "the task's wave id is untouched by the wave delete");
});

test("GET /api/waves answers identically for a store it did not touch", async () => {
  // A wave on the OTHER initiative is created between the two reads: the untouched initiative's answer must not move.
  const first = await get(`/api/waves?initiative=${otherId}`);
  const before = { ...first.json, at: undefined };
  const made = await post(base, "/api/waves", { body: { initiativeId, title: "A wave on the busy initiative" } });
  assert.equal(made.status, 200, made.text);
  const second = await get(`/api/waves?initiative=${otherId}`);
  assert.deepEqual({ ...second.json, at: undefined }, before);
  // And the initiative store is not a second writer's: byte-identical after a wave write.
  const bytes = readBytes(initiativesFile);
  const another = await post(base, "/api/waves", { body: { initiativeId, title: "One more" } });
  assert.equal(another.status, 200, another.text);
  assert.equal(readBytes(initiativesFile), bytes, "initiatives.json was not touched by a wave write");
});

test("the tier: all asks for a create and writes nothing, none does not ask", async () => {
  await setTier("all");
  const before = readBytes(wavesFile);
  const asked = await post(base, "/api/waves", { body: { initiativeId, title: "An asked wave", by: "assistant-3" } });
  assert.equal(asked.status, 202, asked.text);
  assert.equal(asked.json.asked, true);
  assert.equal(asked.json.tier, "all");
  assert.match(asked.json.title, /Create wave "An asked wave"/);
  assert.equal(readBytes(wavesFile), before, "an asked change writes nothing");
  const read = await get(`/api/waves?initiative=${initiativeId}`);
  assert.equal(read.json.waves.some((w) => w.title === "An asked wave"), false);

  await setTier("none");
  const free = await post(base, "/api/waves", { body: { initiativeId, title: "A free wave" } });
  assert.equal(free.status, 200, free.text);
  assert.equal(free.json.asked, false);
});

test("the tier: own asks about a delete of somebody else's wave and not about the actor's own", async () => {
  await setTier("own");
  const mine = await post(base, "/api/waves", { body: { initiativeId, title: "Assistant one's wave", by: "assistant-1" } });
  assert.equal(mine.status, 200, mine.text);
  const theirs = await post(base, "/api/waves/remove", { body: { initiativeId, id: mine.json.wave.id, by: "assistant-2" } });
  assert.equal(theirs.status, 202, theirs.text);
  assert.match(theirs.json.title, /Delete wave "Assistant one's wave"/);
  // Still there: the question was not an answer.
  assert.equal((await get(`/api/waves?initiative=${initiativeId}`)).json.waves.some((w) => w.id === mine.json.wave.id), true);
  const own = await post(base, "/api/waves/remove", { body: { initiativeId, id: mine.json.wave.id, by: "assistant-1" } });
  assert.equal(own.status, 200, own.text);
  assert.equal(own.json.waves.some((w) => w.id === mine.json.wave.id), false);
  await setTier("none");
});

test("the refusals over the wire: 409 unreadable, 409 skipped, 404 unknown wave, 405 a wrong verb", async () => {
  // 405 where the design keeps it: no third verb, and GET is not a write path's read.
  const put = await fetch(`${base}/api/waves`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(put.status, 405);
  const getOnWrite = await get("/api/waves/update");
  assert.equal(getOnWrite.status, 405);
  // 404: a wave that is not there, and one that belongs to the other initiative.
  const missing = await post(base, "/api/waves/update", { body: { initiativeId, id: "nobody", title: "x" } });
  assert.equal(missing.status, 404, missing.text);
  const there = (await get(`/api/waves?initiative=${initiativeId}`)).json.waves[0];
  const wrongInit = await post(base, "/api/waves/remove", { body: { initiativeId: otherId, id: there.id } });
  assert.equal(wrongInit.status, 404, wrongInit.text);
  assert.match(wrongInit.json.error, /belongs to/);

  // 409 unreadable, with the bytes untouched.
  const saved = readBytes(wavesFile);
  writeFileSync(wavesFile, "{ broken");
  const unreadable = await post(base, "/api/waves", { body: { initiativeId, title: "Never" } });
  assert.equal(unreadable.status, 409, unreadable.text);
  assert.equal(unreadable.json.refused, "unreadable");
  assert.match(unreadable.json.error, /NOT overwritten/);
  assert.equal(readBytes(wavesFile), "{ broken");
  writeFileSync(wavesFile, saved);

  // 409 skipped: a document holding a record the loader refused refuses the write, by name. The record is bent in a way
  // the LOADER owns - a position that is not a positive whole number - because a stale `state` field is dropped rather
  // than skipped (the read door is tolerant, the write door is closed).
  const doc = readJson(wavesFile);
  doc.byInitiative[initiativeId].push({ id: "broken-record", initiativeId, position: 0, title: "Broken" });
  writeFileSync(wavesFile, JSON.stringify(doc, null, 2));
  const skipped = await post(base, "/api/waves", { body: { initiativeId, title: "Never either" } });
  assert.equal(skipped.status, 409, skipped.text);
  assert.equal(skipped.json.refused, "skipped");
  assert.match(skipped.json.error, /broken-record/);
  assert.match(skipped.json.error, /a write would serialise the document and drop it/);
  // Put the document back so the next read is the store this file started with.
  const clean = readJson(wavesFile);
  clean.byInitiative[initiativeId] = clean.byInitiative[initiativeId].filter((w) => w.id !== "broken-record");
  writeFileSync(wavesFile, JSON.stringify(clean, null, 2));
});

test("a read with no initiative is a 400, and a create with no title is a 400", async () => {
  const noInit = await get("/api/waves");
  assert.equal(noInit.status, 400);
  const noTitle = await post(base, "/api/waves", { body: { initiativeId } });
  assert.equal(noTitle.status, 400, noTitle.text);
  assert.match(noTitle.json.error, /needs a title/);
  const noSuchInit = await post(base, "/api/waves", { body: { initiativeId: "init_nothere", title: "Wave" } });
  assert.equal(noSuchInit.status, 404, noSuchInit.text);
});

test("the seven real initiatives still read 0 waves once the throwaway one is gone", async () => {
  // Clean up this file's own waves so the store ends where the proof of the real states begins.
  for (const id of [initiativeId, otherId]) {
    const lane = await get(`/api/waves?initiative=${id}`);
    for (const wave of lane.json.waves) await post(base, "/api/waves/remove", { body: { initiativeId: id, id: wave.id } });
    const after = await get(`/api/waves?initiative=${id}`);
    assert.equal(after.json.waves.length, 0, `${id} holds no waves`);
  }
  // EVERY initiative in the store answers a lane with zero waves - the read-side claim, over a store a writer has
  // written and rewritten (version 2, provenance, history) and then emptied.
  const tab = await get("/api/initiatives");
  for (const row of tab.json.initiatives) {
    assert.equal(Array.isArray(row.waves) ? row.waves.length : 0, 0, `${row.title || row.id} reads no waves`);
  }
  const doc = readJson(wavesFile);
  assert.deepEqual(doc.byInitiative, {}, "the store is an empty map, not a map of empty lists");
});

// The sandbox goes LAST, after the panel has stopped: a running panel still scans its repos directory, and a cleanup
// that runs first would have it recreate the tree under the removal.
after(() => rmSync(sandbox, { recursive: true, force: true }));
