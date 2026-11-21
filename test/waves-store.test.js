// The wave store's own half: one document, keyed by initiative id, and the record a reader authors by hand.
//
// The first slice's claims are pinned here as behaviour rather than prose:
//
//   1. AN UNREADABLE FILE IS REFUSED, NEVER OVERWRITTEN. A corrupt file reports `readable: false` with the path and
//      the parse error, reads as zero waves, and the bytes on disk are unchanged. This slice ships no writer, so the
//      assertion is that no read path writes - and that a later write route has the rule to copy.
//   2. A KEY AND A FIELD THAT DISAGREE REFUSE THE RECORD. The map key is the lookup; `initiativeId` is the record's
//      identity. A record under the wrong key is skipped WITH ITS SENTENCE, and the sibling records still load.
//   3. POSITIONS SORT, and a hand-edited duplicate is refused rather than silently renumbered.
//   4. THE GATE VOCABULARY IS THE PANEL'S. A check outside the 14 names, a parameter the spec does not describe and a
//      missing required parameter each refuse the record at load, instead of rendering an empty gate at run time.
//   5. A TEMPLATE IS A NAME. A bundle id the bundle no longer holds stays on the record and reads unresolved; it is
//      never silently nulled.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { WAVES_VERSION, WAVE_TITLE_MAX, Waves, currentWaveId, waveLane, waveView } from "../lib/waves.js";

function store(t, doc) {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-waves-"));
  const file = path.join(dir, "waves.json");
  if (doc !== undefined) writeFileSync(file, typeof doc === "string" ? doc : `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file, make: () => new Waves({ file, log: () => {} }) };
}

const wave = (over = {}) => ({
  id: "wave_01",
  initiativeId: "init_a",
  position: 1,
  title: "The read path",
  entryGate: null,
  exitGate: { check: "pr-merged" },
  template: "poc-to-uat",
  auto: false,
  ...over,
});

const docOf = (...waves) => {
  const byInitiative = {};
  for (const w of waves) {
    if (!byInitiative[w.initiativeId]) byInitiative[w.initiativeId] = [];
    byInitiative[w.initiativeId].push(w);
  }
  return { version: WAVES_VERSION, byInitiative };
};

test("a missing store is zero waves, not an error", (t) => {
  const { file, make } = store(t);
  const s = make();
  const status = s.statusOf();
  assert.equal(status.found, false);
  assert.equal(status.readable, true);
  assert.equal(status.file, file);
  assert.deepEqual(s.wavesFor("init_a"), []);
  assert.deepEqual(s.skippedFor("init_a"), []);
});

test("positions sort on read, whatever order the array was written in", (t) => {
  const { make } = store(
    t,
    docOf(wave({ id: "wave_03", position: 3, title: "Third" }), wave({ id: "wave_01", position: 1, title: "First" }), wave({ id: "wave_02", position: 2, title: "Second" })),
  );
  const list = make().wavesFor("init_a");
  assert.deepEqual(
    list.map((w) => w.id),
    ["wave_01", "wave_02", "wave_03"],
  );
  assert.deepEqual(
    list.map((w) => w.title),
    ["First", "Second", "Third"],
  );
});

test("a key and a field that disagree refuse the record, and its siblings still load", (t) => {
  // The mismatch case has to be written by hand: a record sitting under init_a while its own field says init_b.
  const mismatched = { ...wave({ id: "wave_02", initiativeId: "init_b", position: 2, title: "Elsewhere" }) };
  const { make } = store(t, { version: WAVES_VERSION, byInitiative: { init_a: [mismatched, wave({ id: "wave_01", position: 1 })] } });
  const s = make();
  assert.deepEqual(
    s.wavesFor("init_a").map((w) => w.id),
    ["wave_01"],
  );
  assert.deepEqual(s.wavesFor("init_b"), []);
  const skipped = s.skippedFor("init_a");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].id, "wave_02");
  assert.match(skipped[0].error, /says it belongs to init_b but sits under init_a/);
});

test("a duplicate position inside one initiative is refused, not renumbered", (t) => {
  const { make } = store(t, docOf(wave({ id: "wave_01", position: 1 }), wave({ id: "wave_02", position: 1, title: "Same slot" })));
  const s = make();
  assert.deepEqual(
    s.wavesFor("init_a").map((w) => w.id),
    ["wave_01"],
  );
  assert.match(s.skippedFor("init_a")[0].error, /repeats position 1/);
});

test("a duplicate id across the whole file is refused", (t) => {
  const { make } = store(t, docOf(wave({ id: "wave_01" }), wave({ id: "wave_01", initiativeId: "init_b", position: 1 })));
  const s = make();
  assert.deepEqual(s.wavesFor("init_b"), []);
  assert.match(s.skippedFor("init_b")[0].error, /appears twice in the file/);
});

test("a check outside the closed vocabulary refuses the record, with the list in the sentence", (t) => {
  const { make } = store(t, docOf(wave({ exitGate: { check: "looks-done" } })));
  const s = make();
  assert.deepEqual(s.wavesFor("init_a"), []);
  const error = s.skippedFor("init_a")[0].error;
  assert.match(error, /exitGate/);
  assert.match(error, /"looks-done" is not one of the panel's exit checks/);
  assert.match(error, /pr-merged/);
});

test("a parameter the spec does not describe, and a missing required one, both refuse the record", (t) => {
  const extra = store(t, docOf(wave({ entryGate: { check: "clean", blockedBy: "waiting on review" } }))).make();
  assert.match(extra.skippedFor("init_a")[0].error, /clean takes no parameter "blockedBy"/);

  const missing = store(t, docOf(wave({ entryGate: { check: "branch-exists" } }))).make();
  assert.match(missing.skippedFor("init_a")[0].error, /branch-exists needs "branch"/);

  const badType = store(t, docOf(wave({ entryGate: { check: "commits", min: 0 } }))).make();
  assert.match(badType.skippedFor("init_a")[0].error, /must be a positive whole number/);
});

test("a gate that IS in the vocabulary and the spec loads, parameters and all", (t) => {
  const { make } = store(t, docOf(wave({ entryGate: { check: "commits", min: 2 }, exitGate: { check: "reviewers-exact", who: ["ana", "bo"] } })));
  const [loaded] = make().wavesFor("init_a");
  assert.deepEqual(loaded.entryGate, { check: "commits", min: 2 });
  assert.deepEqual(loaded.exitGate, { check: "reviewers-exact", who: ["ana", "bo"] });
});

test("an empty title, a missing id and a bad position each refuse the record", (t) => {
  const empty = store(t, docOf(wave({ title: "   " }))).make();
  assert.match(empty.skippedFor("init_a")[0].error, /needs a title/);

  const noId = store(t, docOf(wave({ id: "" }))).make();
  assert.match(noId.skippedFor("init_a")[0].error, /needs an id/);

  const zero = store(t, docOf(wave({ position: 0 }))).make();
  assert.match(zero.skippedFor("init_a")[0].error, /position must be a whole number from 1/);
});

test("a title is clipped at the store's cap", (t) => {
  const { make } = store(t, docOf(wave({ title: "x".repeat(WAVE_TITLE_MAX + 40) })));
  assert.equal(make().wavesFor("init_a")[0].title.length, WAVE_TITLE_MAX);
});

test("auto defaults false and only a real boolean true turns it on", (t) => {
  const { make } = store(
    t,
    docOf(wave({ id: "wave_01", position: 1, auto: "yes" }), wave({ id: "wave_02", position: 2, auto: true })),
  );
  const list = make().wavesFor("init_a");
  assert.equal(list[0].auto, false);
  assert.equal(list[1].auto, true);
});

test("a template the bundle no longer holds is kept and reads unresolved, never nulled", (t) => {
  const { make } = store(t, docOf(wave({ template: "a-pipeline-the-bundle-dropped" })));
  const [loaded] = make().wavesFor("init_a");
  assert.equal(loaded.template, "a-pipeline-the-bundle-dropped");
  const view = waveView({ wave: loaded, members: [], templateExists: () => false });
  assert.equal(view.template, "a-pipeline-the-bundle-dropped");
  assert.equal(view.templateResolved, false);
  // A caller with no bundle read to give says it could not check, rather than claiming either answer.
  assert.equal(waveView({ wave: loaded, members: [] }).templateResolved, null);
});

test("a wave with no member reads empty - not ready, and not an error", (t) => {
  const { make } = store(t, docOf(wave()));
  const lane = waveLane({ waves: make(), initiativeId: "init_a", tasks: [] });
  assert.equal(lane.waves.length, 1);
  assert.equal(lane.waves[0].state, "empty");
  assert.equal(lane.waves[0].stateWord, "no members");
  assert.deepEqual(lane.waves[0].members, []);
});

test("an unreadable file is refused with its path, reads zero waves, and its bytes are unchanged", (t) => {
  const broken = "{ this is not json\n";
  const { file, make } = store(t, broken);
  const s = make();
  const status = s.statusOf();
  assert.equal(status.found, true);
  assert.equal(status.readable, false);
  assert.equal(status.file, file);
  assert.ok(status.error && status.error.length > 0);
  assert.deepEqual(s.wavesFor("init_a"), []);
  assert.deepEqual(s.skippedFor("init_a"), []);
  // Every read path ran above; the file is byte-identical.
  assert.equal(readFileSync(file, "utf8"), broken);
});

test("a file that holds an array instead of an object is refused too", (t) => {
  const { make } = store(t, "[]\n");
  const status = make().statusOf();
  assert.equal(status.readable, false);
  assert.match(status.error, /does not hold an object/);
});

test("one initiative's waves are not another's, and the document is never rewritten by a read", (t) => {
  const before = docOf(wave({ id: "wave_01", initiativeId: "init_a" }), wave({ id: "wave_02", initiativeId: "init_b", position: 1, title: "B" }));
  const { file, make } = store(t, before);
  const s = make();
  assert.deepEqual(
    s.wavesFor("init_a").map((w) => w.id),
    ["wave_01"],
  );
  assert.deepEqual(
    s.wavesFor("init_b").map((w) => w.id),
    ["wave_02"],
  );
  assert.equal(s.waveById("wave_02").initiativeId, "init_b");
  assert.equal(existsSync(file), true);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), before);
});

test("which wave is current is the stated order: running, then ready, then unentered", () => {
  const waves = [
    { id: "w1", position: 1, state: "done" },
    { id: "w2", position: 2, state: "unentered" },
    { id: "w3", position: 3, state: "ready" },
    { id: "w4", position: 4, state: "running" },
  ];
  assert.equal(currentWaveId(waves), "w4");
  assert.equal(currentWaveId(waves.filter((w) => w.state !== "running")), "w3");
  assert.equal(currentWaveId(waves.filter((w) => !["running", "ready"].includes(w.state))), "w2");
  assert.equal(currentWaveId([{ id: "w1", position: 1, state: "done" }]), null);
});
