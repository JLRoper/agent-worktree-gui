// The pipeline import contract — lib/pipeline-bundle.js.
//
// Six facts, each driven rather than read off the source:
//
//   1. a panel bundle loads: pipelines by id, stages in array order with 1-based positions, each stage's prompt and the
//      artifact it produces, gates carrying the artifact a decision is written to, and the handoffs between stages;
//   2. a studio `bundle.json` loads as ONE pipeline — its title from the project, its budget renamed, and each
//      stage's prompt taken from the roster role that owns it, with `promptFrom` recording which one answered. The
//      bare studio pipeline document (`stages[]` at the top level, which the studio's own export button writes) is
//      the same records and loads the same way;
//   3. four bad bundles are refused BY NAME — not-a-bundle, unsupported-version, incomplete-stage, dangling-reference
//      — each with the sentence and the locator a settings page can show a reader, and no bundle returned;
//   4. a gate's decision artifact is READ when present (id, path, schema, writer and the outcomes the stage waits on)
//      and null when absent, because a gate with no decision is a pause; a decision that declares no outcome is
//      refused as incomplete-gate, and a handoff of an unknown kind as bad-handoff;
//   5. absence is not breakage: a path with no file answers `missing`, an unreadable one answers `not-a-bundle`, and
//      the file the loader read is named back;
//   6. the lookups are exact — a pipeline id and a stage id are keys, so a near match answers null rather than a
//      record the caller did not ask for.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BUNDLE_FAULTS, BUNDLE_VERSION, parseBundle, pipelineById, positionOf, readBundle, stageById } from "../lib/pipeline-bundle.js";

const stage = (id, title, artifact, extra = {}) => ({
  id,
  title,
  prompt: `Do the ${title} work.`,
  artifact: { id: artifact, path: `out/${artifact}.json`, schema: "out/1", writer: "worker", ...(artifact === "charter" ? { sha256: "sha256:abc" } : {}) },
  ...extra,
});

// The panel's own form: one wrapper, two pipelines. Fresh on every call so a test may mutate the clone it was given.
const panelBundle = () => ({
  bundleVersion: 1,
  name: "sefl",
  pipelines: [
    {
      id: "poc-to-uat",
      title: "POC to UAT",
      description: "Thirteen stages and five gates.",
      stages: [
        stage("S0", "Intake", "charter"),
        stage("S1", "Freeze", "frozen-export"),
        stage("S2", "Implement", "build"),
      ],
      gates: [
        {
          id: "G0",
          name: "Charter",
          after: "S0",
          artifact: "charter",
          decider: "user",
          verified_by: "machine",
          decision: {
            id: "charter-decision",
            path: "ledger/gates/G0.json",
            schema: "gate-decision/1",
            sha256: "sha256:def",
            writer: "user",
            outcomes: ["PASS", "FAIL"],
          },
        },
        { id: "G1", name: "Freeze", after: "S1", artifact: "frozen-export", decider: "engineer", verified_by: "layer-validator" },
      ],
      handoffs: [
        { id: "H-01", from: "S0", to: "S1", artifact: "charter", kind: "sequence", note: "G0 is signed between the two." },
        { id: "H-02", from: "S1", to: "S2", artifact: "frozen-export", kind: "sequence" },
      ],
    },
    {
      id: "probe",
      title: "Probe",
      stages: [stage("P0", "Probe", "findings")],
      gates: [],
      handoffs: [],
    },
  ],
});

// The studio's bundle.json, trimmed to three stages: `pipeline` is the semantic layer core.js `exportBundle` writes,
// `roles` and `artifacts` are its siblings, and `yaml` is the rendered file the panel does not read. The stages carry
// no `prompt`: the roster's `instructions` are the instruction, which is the whole reason rule 3 of the module exists.
const studioBundle = () => ({
  pipeline: {
    version: 1,
    project: {
      id: "poc-to-uat",
      name: "POC to UAT",
      description: "The existing SEFL pipeline.",
      budget: { stage_tokens: 400000, episode_rounds: 3, wall_minutes: 240 },
    },
    stages: [
      {
        id: "S0",
        name: "Intake and charter",
        owner: { role: "steward", kind: "agent" },
        artifact: { id: "charter", path: "ledger/charters/charter.md", schema: "charter/1", sha256: "sha256:1f0a", writer: "steward" },
      },
      {
        id: "S1",
        name: "Freeze the export",
        owner: { role: "freeze-job", kind: "job" },
        artifact: { id: "frozen-export", path: "layer/export.json", schema: "export/1", sha256: "sha256:2b3c", writer: "freeze-job" },
      },
      {
        id: "S2",
        name: "Implement",
        owner: { role: "implementer", kind: "agent" },
        artifact: { id: "build", path: "build/", schema: "build/1", sha256: "sha256:4d5e", writer: "implementer" },
      },
    ],
    gates: [
      {
        id: "G0",
        name: "Charter",
        after: "S0",
        artifact: "charter",
        decider: "user",
        verified_by: "machine",
        decision: {
          id: "charter-decision",
          path: "ledger/gates/G0.json",
          schema: "gate-decision/1",
          sha256: "sha256:6f7a",
          writer: "user",
          outcomes: ["GO", "NO-GO"],
        },
      },
    ],
    handoffs: [
      { id: "H-01", from: "S0", to: "S1", artifact: "charter", kind: "sequence" },
      { id: "H-02", from: "S1", to: "S2", artifact: "frozen-export", kind: "sequence" },
    ],
    roles: [
      { id: "steward", name: "Steward", kind: "agent", stage: "S0", instructions: "You write one page and no more." },
      { id: "freeze-job", name: "Freeze job", kind: "job", stage: "S1", instructions: "Copy the export, then hash it." },
      { id: "implementer", name: "Implementer", kind: "agent", stage: "S2", instructions: "Implement the rule as written; do not improve it." },
    ],
  },
  roles: { version: 1, project: "poc-to-uat", roles: [] },
  artifacts: { version: 1, project: "poc-to-uat", artifacts: [] },
  yaml: "version: 1\nproject:\n  id: poc-to-uat\n",
});

// A loaded bundle to mutate for the refusal tests. The wherever-path is the panel form, which is the one an install
// writes by hand, so the locators the tests assert are the ones a reader of that file would recognise.
const loaded = () => parseBundle(panelBundle());

test("a panel bundle loads: stages in order, prompts, artifacts, gates and handoffs", () => {
  const result = loaded();
  assert.equal(result.ok, true);
  assert.equal(result.code, null);
  assert.equal(result.bundle.version, BUNDLE_VERSION);
  assert.equal(result.bundle.name, "sefl");
  assert.deepEqual(result.bundle.pipelines.map((p) => p.id), ["poc-to-uat", "probe"]);

  const pipeline = pipelineById(result.bundle, "poc-to-uat");
  assert.equal(pipeline.title, "POC to UAT");
  assert.equal(pipeline.description, "Thirteen stages and five gates.");
  // Array order is the reading order, and position is 1-based: a card says "stage 2 of 3".
  assert.deepEqual(pipeline.order, ["S0", "S1", "S2"]);
  assert.deepEqual(pipeline.stages.map((s) => s.position), [1, 2, 3]);

  const [s0, s1] = pipeline.stages;
  assert.equal(s0.prompt, "Do the Intake work.");
  assert.equal(s0.promptFrom, "stage");
  assert.deepEqual(s0.artifact, { id: "charter", path: "out/charter.json", schema: "out/1", writer: "worker", sha256: "sha256:abc" });
  // A stage the studio names with `name` (the guide's field) is the same record as one the panel names with `title`.
  assert.equal(s1.title, "Freeze");

  // A gate carries the artifact its decision is written to, and the outcomes the stage that waits on it reads by name.
  const g0 = pipeline.gates[0];
  assert.equal(g0.id, "G0");
  assert.equal(g0.after, "S0");
  assert.equal(g0.artifact, "charter");
  assert.equal(g0.verifiedBy, "machine");
  assert.deepEqual(g0.decision.outcomes, ["PASS", "FAIL"]);
  assert.equal(g0.decision.path, "ledger/gates/G0.json");
  // No decision is a PAUSE, not a broken gate, and null says exactly that.
  assert.equal(pipeline.gates[1].decision, null);

  assert.deepEqual(pipeline.handoffs[0], { id: "H-01", from: "S0", to: "S1", artifact: "charter", kind: "sequence", cap: null });
  // The note is the studio's, and the panel does not read it: the contract carries what it acts on, not the prose.
  assert.equal("note" in pipeline.handoffs[0], false);

  // The second pipeline is independent: its order and count are its own.
  const probe = pipelineById(result.bundle, "probe");
  assert.deepEqual(probe.order, ["P0"]);
  assert.equal(probe.stages.length, 1);
});

test("a studio bundle.json loads as one pipeline, each prompt from the role that owns the stage", () => {
  const result = parseBundle(studioBundle());
  assert.equal(result.ok, true);
  assert.equal(result.bundle.name, "poc-to-uat");
  assert.equal(result.bundle.pipelines.length, 1);

  const pipeline = result.bundle.pipelines[0];
  assert.equal(pipeline.id, "poc-to-uat");
  assert.equal(pipeline.title, "POC to UAT");
  assert.deepEqual(pipeline.budget, { stageTokens: 400000, episodeRounds: 3, wallMinutes: 240 });

  const s0 = pipeline.stages[0];
  assert.equal(s0.title, "Intake and charter");
  assert.equal(s0.prompt, "You write one page and no more.");
  assert.equal(s0.promptFrom, "role:steward");
  assert.equal(s0.role, "steward");
  assert.equal(s0.artifact.id, "charter");
  assert.equal(s0.artifact.sha256, "sha256:1f0a");
  assert.deepEqual(pipeline.gates[0].decision.outcomes, ["GO", "NO-GO"]);
  assert.deepEqual(pipeline.order, ["S0", "S1", "S2"]);

  // The bare studio pipeline document is the same records without the bundle wrapper, and loads to the same pipeline.
  const bare = parseBundle(studioBundle().pipeline);
  assert.equal(bare.ok, true);
  assert.deepEqual(bare.bundle.pipelines[0], pipeline);
});

test("a bundle that is not JSON is refused by name", () => {
  const result = parseBundle('{"bundleVersion": 1, "pipelines": [');
  assert.equal(result.ok, false);
  assert.equal(result.code, BUNDLE_FAULTS.SHAPE);
  assert.equal(result.bundle, null);
  assert.match(result.reason, /not JSON/);

  // Right JSON, wrong shape: no list of pipelines anywhere. The sentence names all three forms it looked for, because
  // the reader is the one who has to choose which one they meant to export.
  const shape = parseBundle({ version: 1, stages: "nope" });
  assert.equal(shape.ok, false);
  assert.equal(shape.code, BUNDLE_FAULTS.SHAPE);
  assert.match(shape.reason, /no pipelines list/);
  assert.match(shape.reason, /pipeline/);
});

test("a bundle from a newer panel is refused by name, without being half-read", () => {
  const result = parseBundle({ ...panelBundle(), bundleVersion: BUNDLE_VERSION + 1 });
  assert.equal(result.ok, false);
  assert.equal(result.code, BUNDLE_FAULTS.VERSION);
  assert.equal(result.bundle, null);
  assert.match(result.reason, new RegExp(`version ${BUNDLE_VERSION + 1}, newer than this panel's ${BUNDLE_VERSION}`));

  // An undated bundle is refused by the same rule: the contract's first word is "versioned", and an import the panel
  // cannot date is one it cannot promise to read the same way twice.
  const undated = parseBundle({ pipelines: panelBundle().pipelines });
  assert.equal(undated.ok, false);
  assert.equal(undated.code, BUNDLE_FAULTS.VERSION);
  assert.match(undated.reason, /declares no version/);
});

test("a stage with no prompt and no role instructions is refused by name", () => {
  const bundle = panelBundle();
  bundle.pipelines[0].stages[1].prompt = "   ";
  const result = parseBundle(bundle);
  assert.equal(result.ok, false);
  assert.equal(result.code, BUNDLE_FAULTS.STAGE);
  assert.equal(result.where, "pipelines[0].stages[1]");
  assert.match(result.reason, /no prompt/);
  assert.match(result.reason, /owner\.role/);

  // The same rule for the studio form: a stage whose role exists but says nothing cannot supply the instruction.
  const studio = studioBundle();
  studio.pipeline.roles[1].instructions = "";
  const noRoleText = parseBundle(studio);
  assert.equal(noRoleText.ok, false);
  assert.equal(noRoleText.code, BUNDLE_FAULTS.STAGE);
  // The locator is the file's own path: a studio bundle.json holds the pipeline under `pipeline`, so a reader can find
  // the stage at the path the sentence names.
  assert.equal(noRoleText.where, "pipeline.stages[1]");
  assert.match(noRoleText.reason, /"freeze-job" has no instructions/);

  // And the bare studio document has the pipeline at its root, so the locator drops the wrapper.
  const bareDoc = studioBundle().pipeline;
  bareDoc.roles[1].instructions = "";
  const bareNoRole = parseBundle(bareDoc);
  assert.equal(bareNoRole.code, BUNDLE_FAULTS.STAGE);
  assert.equal(bareNoRole.where, "stages[1]");

  // A role with no id is nobody's stage: it must not lend its instructions to a stage that names no owner, or the
  // panel would run a stage on a prompt nobody assigned to it.
  const stray = panelBundle();
  stray.pipelines[1].stages = [{ id: "P0", title: "Probe", artifact: { id: "findings", path: "out/f.md", schema: "findings/1", writer: "probe" } }];
  stray.roles = [{ instructions: "Instructions from a role with no id and no stage." }];
  const strayRole = parseBundle(stray);
  assert.equal(strayRole.ok, false);
  assert.equal(strayRole.code, BUNDLE_FAULTS.STAGE);
  assert.match(strayRole.reason, /no role that could supply one/);

  // And a pipeline with no stage at all: a definition that draws nothing and starts nowhere.
  const empty = panelBundle();
  empty.pipelines[1].stages = [];
  const noStages = parseBundle(empty);
  assert.equal(noStages.ok, false);
  assert.equal(noStages.code, BUNDLE_FAULTS.STAGE);
  assert.match(noStages.reason, /no stages/);
});

test("a handoff to a stage the pipeline does not hold is refused by name", () => {
  const bundle = panelBundle();
  bundle.pipelines[0].handoffs[1].to = "S9";
  const result = parseBundle(bundle);
  assert.equal(result.ok, false);
  assert.equal(result.code, BUNDLE_FAULTS.REFERENCE);
  assert.equal(result.where, "pipelines[0].handoffs[1]");
  assert.match(result.reason, /the handoff's to is stage "S9"/);
  assert.match(result.reason, /S0, S1, S2/);

  // A gate is a reference too: it follows a stage and decides on an artifact, and both have to be in the pipeline.
  const gate = panelBundle();
  gate.pipelines[0].gates[0].artifact = "no-such-artifact";
  const badGate = parseBundle(gate);
  assert.equal(badGate.ok, false);
  assert.equal(badGate.code, BUNDLE_FAULTS.REFERENCE);
  assert.equal(badGate.where, "pipelines[0].gates[0]");
  assert.match(badGate.reason, /no-such-artifact/);
});

test("a gate's decision artifact is read when present and a decision with no outcome is refused", () => {
  const bundle = panelBundle();
  bundle.pipelines[0].gates[0].decision.outcomes = [];
  const result = parseBundle(bundle);
  assert.equal(result.ok, false);
  assert.equal(result.code, BUNDLE_FAULTS.GATE);
  assert.equal(result.where, "pipelines[0].gates[0].decision.outcomes");
  assert.match(result.reason, /no outcomes/);

  // An unknown edge kind is not a dangling reference: the ids resolve, the drawing does not exist.
  const kind = panelBundle();
  kind.pipelines[0].handoffs[0].kind = "retry";
  const badKind = parseBundle(kind);
  assert.equal(badKind.ok, false);
  assert.equal(badKind.code, BUNDLE_FAULTS.HANDOFF);
  assert.match(badKind.reason, /sequence, loop, return/);
});

test("a gate's decision routes are read, and a map that cannot route every outcome is refused", () => {
  // The happy shape: one outcome to an edge, one to null (the pipeline ends). Read as a plain map.
  const good = panelBundle();
  good.pipelines[0].gates[0].decision.routes = { PASS: "H-01", FAIL: null };
  const read = parseBundle(good);
  assert.equal(read.ok, true, read.reason || "");
  assert.deepEqual(read.bundle.pipelines[0].gates[0].decision.routes, { PASS: "H-01", FAIL: null });

  // An outcome the decision does not declare.
  const unknown = panelBundle();
  unknown.pipelines[0].gates[0].decision.routes = { PASS: "H-01", FAIL: null, MAYBE: null };
  const badOutcome = parseBundle(unknown);
  assert.equal(badOutcome.ok, false);
  assert.equal(badOutcome.code, BUNDLE_FAULTS.GATE);
  assert.equal(badOutcome.where, "pipelines[0].gates[0].decision.routes");
  assert.match(badOutcome.reason, /"MAYBE", which it does not declare/);

  // An outcome the map forgets: the driver would meet a verdict it cannot route.
  const partial = panelBundle();
  partial.pipelines[0].gates[0].decision.routes = { PASS: "H-01" };
  const unrouted = parseBundle(partial);
  assert.equal(unrouted.ok, false);
  assert.equal(unrouted.code, BUNDLE_FAULTS.GATE);
  assert.match(unrouted.reason, /FAIL and routes it nowhere/);

  // A handoff that leaves a DIFFERENT stage: a gate routes the edges out of the stage it follows.
  const elsewhere = panelBundle();
  elsewhere.pipelines[0].gates[0].decision.routes = { PASS: "H-02", FAIL: null };
  const wrongStage = parseBundle(elsewhere);
  assert.equal(wrongStage.ok, false);
  assert.equal(wrongStage.code, BUNDLE_FAULTS.HANDOFF);
  assert.match(wrongStage.reason, /leaves stage S1/);

  // A handoff this pipeline does not hold.
  const absent = panelBundle();
  absent.pipelines[0].gates[0].decision.routes = { PASS: "H-99", FAIL: null };
  const missing = parseBundle(absent);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, BUNDLE_FAULTS.REFERENCE);
  assert.match(missing.reason, /does not hold/);
});

test("a missing file is absence, an unreadable one is a bad bundle, and the file is named back", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-bundle-"));
  try {
    const missing = readBundle(path.join(dir, "nope.json"));
    assert.equal(missing.ok, false);
    assert.equal(missing.code, BUNDLE_FAULTS.MISSING);
    assert.match(missing.reason, /no bundle at that path/);

    const noName = readBundle("");
    assert.equal(noName.code, BUNDLE_FAULTS.MISSING);

    const file = path.join(dir, "bundle.json");
    writeFileSync(file, "not json at all", "utf8");
    const unreadable = readBundle(file);
    assert.equal(unreadable.ok, false);
    assert.equal(unreadable.code, BUNDLE_FAULTS.SHAPE);
    assert.equal(unreadable.file, path.resolve(file));

    // The real export shape goes through the file path as well as through `parseBundle`: a BOM is not a syntax error.
    const good = path.join(dir, "studio.json");
    writeFileSync(good, `\uFEFF${JSON.stringify(studioBundle())}`, "utf8");
    const loadedGood = readBundle(good);
    assert.equal(loadedGood.ok, true);
    assert.equal(loadedGood.file, path.resolve(good));
    assert.equal(loadedGood.bundle.pipelines[0].stages.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("the lookups are exact: an id is a key, so a near match is null", () => {
  const result = loaded();
  assert.equal(pipelineById(result.bundle, "poc-to-uat").id, "poc-to-uat");
  // An id is compared by case: a page that upper-cases what the reader typed has a typo, not a pipeline.
  assert.equal(pipelineById(result.bundle, "POC-TO-UAT"), null);
  // Padding is not a typo — a form field submits it — so the one thing trimmed is whitespace.
  assert.equal(pipelineById(result.bundle, " poc-to-uat ").id, "poc-to-uat");
  assert.equal(pipelineById(null, "poc-to-uat"), null);

  const pipeline = pipelineById(result.bundle, "poc-to-uat");
  assert.equal(stageById(pipeline, "S1").title, "Freeze");
  assert.equal(stageById(pipeline, "s1"), null);
  assert.equal(positionOf(pipeline, "S2"), 3);
  assert.equal(positionOf(pipeline, "S9"), null);
});
