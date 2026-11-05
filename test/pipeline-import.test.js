// The map's importer, driven without a browser.
//
// public/pipeline-map.html is generated from two seeds; the documents it draws instead come through
// public/core/pipeline-import.js, which the page loads as a classic script and this test imports as the same code.
// What matters here is that nothing is INVENTED: an index row has no stage names, so its nodes say "counted only";
// a catalogue stage has no role, so its line says "not stated"; a studio stage's role is its own owner.role looked
// up in the document's roles[], and its arrows are its handoffs. A document that is none of those shapes is a
// DocError with a sentence the page can print — never an empty model.
import assert from "node:assert/strict";
import test from "node:test";

await import("../public/core/pipeline-import.js");
const P = globalThis.wtPipelineImport;

const STUDIO = {
  version: 1,
  project: { id: "poc-breaking-suite", name: "POC-breaking suite", description: "Nine stages, two gates." },
  roles: [
    { id: "entity-extractor", name: "Entity extractor", kind: "service", remit: "reads the frozen slice" },
    { id: "suite-runner", name: "Suite runner", kind: "service", remit: "records the run" },
  ],
  stages: [
    { id: "S160", name: "Extract the entities", owner: { kind: "service", role: "entity-extractor" }, done: [{ check_id: "S160-EXIT-01", command: "true" }, { check_id: "S160-EXIT-02", command: "true" }] },
    { id: "S166", name: "Record the run", owner: { kind: "service", role: "suite-runner" }, done: [{ check_id: "S166-EXIT-01" }] },
    { id: "S167", name: "Judge the criteria", owner: { kind: "human", name: "pipeline-owner" }, done: [] },
  ],
  handoffs: [
    { id: "H-1", kind: "sequence", from: "S160", to: "S166", artifact: "entity-records" },
    { id: "H-2", kind: "sequence", from: "S166", to: "S167", artifact: "run-manifest" },
    { id: "H-9", kind: "loop", from: "S167", to: "S160", cap: "3 rounds", note: "a false criterion sends it back" },
  ],
  gates: [{ id: "G41", after: "S166", name: "Verdict accepted", decider: "pipeline-owner", verified_by: "machine", refuses_when: "C1 is false" }],
};

const meta = (source = "test") => ({ source, sha256: "0".repeat(64), bytes: 100, at: "2026-11-05T00:00:00.000Z" });

test("sha256Hex names bytes the way the provenance line does", async () => {
  assert.equal(await P.sha256Hex(new TextEncoder().encode("hello")), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
});

test("the factory's index is drawn as counted stages, and says it is counting", () => {
  const { model, shape } = P.adapt([{ id: "poc-breaking-suite", title: "POC-breaking suite", stageCount: 9 }], meta("http://127.0.0.1:8090/api/pipelines"));
  assert.equal(shape, "index");
  assert.equal(model.pipelines.length, 1);
  const card = model.pipelines[0];
  assert.equal(card.id, "poc-breaking-suite");
  assert.equal(card.stages.length, 9);
  assert.equal(card.edges.length, 8);
  assert.equal(card.summaryOnly, true);
  assert.equal(card.stages[0].role.source, "summary");
  assert.match(card.stages[0].role.label, /counted only/);
  assert.match(card.description, /does not serve their names/);
  assert.equal(model.meta.totalStages, 9);
  assert.equal(model.meta.import.shape, "index");
  assert.equal(model.meta.sources[0].sha256, "0".repeat(64));
});

test("an exported studio document keeps its own names, roles, arrows, loop and gate", () => {
  const { model, shape } = P.adapt(STUDIO, meta("poc-breaking-suite.json"));
  assert.equal(shape, "studio");
  const card = model.pipelines[0];
  assert.equal(card.id, "poc-breaking-suite");
  assert.equal(card.title, "POC-breaking suite");
  assert.deepEqual(card.stages.map((s) => s.id), ["S160", "S166", "S167"]);
  assert.deepEqual(card.stages.map((s) => s.title), ["Extract the entities", "Record the run", "Judge the criteria"]);
  assert.equal(card.stages[0].role.source, "assigned");
  assert.equal(card.stages[0].role.label, "role: Entity extractor · service");
  assert.equal(card.stages[0].role.remit, "reads the frozen slice");
  assert.equal(card.stages[2].role.label, "role: pipeline-owner · human", "an owner the roles[] does not hold is still the document's own owner");
  assert.equal(card.stages[0].exitLabel, "S160-EXIT-01 +1");
  assert.deepEqual(card.edges.map((e) => `${e.from}->${e.to}`), ["S160->S166", "S166->S167"]);
  assert.equal(card.edges[1].label, "G41 · Verdict accepted (pipeline-owner)");
  assert.equal(card.loops.length, 1);
  assert.equal(card.loops[0].cap, "3 rounds");
  assert.equal(card.loops[0].source, "data");
  assert.equal(card.gates.length, 1);
  assert.equal(card.gates[0].refusesWhen, "C1 is false");
});

test("the panel's catalogue is one card per definition, and a missing role is said, not guessed", () => {
  const doc = {
    version: 1,
    pipelines: {
      local: { id: "local", kind: "local", title: "Local work", stages: [{ id: "work", title: "Work in this tree" }] },
      review: { id: "review", kind: "turnover", title: "Review loop", stages: [{ id: "push", title: "Push" }, { id: "pr", title: "Open the PR" }] },
    },
  };
  const { model, shape } = P.adapt(doc, meta("catalogue.json"));
  assert.equal(shape, "panel");
  assert.deepEqual(model.pipelines.map((p) => p.id), ["local", "review"]);
  assert.equal(model.pipelines[1].stages.length, 2);
  assert.equal(model.pipelines[1].edges.length, 1);
  assert.equal(model.pipelines[0].stages[0].role.source, "unstated");
  assert.match(model.pipelines[0].stages[0].role.label, /not stated/);
  assert.equal(model.meta.totalStages, 3);
});

test("a bare definition is one card, and a list of definitions is a catalogue", () => {
  const one = P.adapt({ id: "solo", kind: "investigation", title: "Solo", stages: [{ id: "probe", title: "Probe" }] }, meta());
  assert.equal(one.shape, "definition");
  assert.equal(one.model.pipelines.length, 1);
  const list = P.adapt([{ id: "a", stages: [{ id: "s1", title: "One" }] }, { id: "b", stages: [{ id: "s1", title: "One" }, { id: "s2", title: "Two" }] }], meta());
  assert.equal(list.shape, "panel");
  assert.equal(list.model.pipelines.length, 2);
});

test("the map's own data block round-trips without re-deriving a role", () => {
  const page = {
    meta: { version: "1.13.0", totalPipelines: 1, totalStages: 1, bundleStages: 0, totalLoops: 0 },
    pipelines: [{ id: "local", title: "Local work", stages: [{ id: "work", title: "Work", role: { source: "derived", rule: "work", label: "derived: worker · does the work" } }], loops: [] }],
    bundle: null,
  };
  const { model, shape } = P.adapt(page, meta("map.json"));
  assert.equal(shape, "page");
  assert.equal(model.pipelines[0].stages[0].role.label, "derived: worker · does the work");
  assert.equal(model.meta.import.shape, "page");
});

test("a document that is not a pipeline is refused with a sentence, never an empty model", () => {
  const bad = [
    [null, /empty/],
    ["a string", /not a JSON object/],
    [[], /empty list/],
    [{}, /no `pipelines`, no `stages`/],
    [{ hello: 1 }, /no `pipelines`, no `stages`/],
    [{ stages: "nine" }, /no `pipelines`, no `stages`/],
    [{ stages: [] }, /no stages/],
    [{ pipelines: {} }, /holds no definition/],
    [{ pipelines: { x: { id: "x" } } }, /no stages/],
    [[{ id: "a" }, { id: "b" }], /neither pipeline definitions/],
    [[{ id: "zero", stageCount: 0 }], /cannot be drawn/],
  ];
  for (const [value, re] of bad) {
    assert.throws(() => P.adapt(value, meta()), (e) => e.name === "DocError" && re.test(e.message), `expected a DocError matching ${re} for ${JSON.stringify(value)}`);
  }
});

test("parse and decode refuse the two failure modes a file has, and strip a BOM", () => {
  assert.throws(() => P.parse('{"stages": ['), (e) => e.name === "DocError" && /not JSON/.test(e.message));
  assert.throws(() => P.decode(new Uint8Array([0xff, 0xfe, 0x00])), (e) => e.name === "DocError" && /UTF-8/.test(e.message));
  assert.equal(P.decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])), "{}");
});
