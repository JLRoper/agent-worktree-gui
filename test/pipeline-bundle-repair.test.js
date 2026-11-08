// Repairing a live bundle whose gates are ambiguous: the plan, the refusals, and the guard left standing.
//
// The case this file exists for is the reader's own state file: a `pipeline-bundle.json` written before
// `lib/pipeline-bundle.js` refused a route-less gate. It declares `decision.outcomes: ["accept", "reject"]` on
// `author-review-revise` G1, follows a stage with two ways out, and carries no `routes` map - so the loader refuses
// the whole file and the Pipeline tab offers nothing. The repair copies the routes the SHIPPED SEED declares for the
// same pipeline and gate, and writes an explicit `decision: null` on each gate that declares no decision at all.
//
// Pinned here:
//   1. the plan on the seed's own author-review-revise, stripped of its routes: accept -> H-03, reject -> H-02, and
//      the result loads with four pipelines (the repaired document is one the panel can read);
//   2. the six gates that declare no decision come out as explicit nulls, and the loader still reads them as pauses;
//   3. the refusals: a model with no routes for the gate, and a model route that names a handoff the live pipeline does
//      not hold. A refusal writes nothing and returns no document;
//   4. the guard itself is untouched: a bundle that leaves its routes off is STILL refused by the loader, and this
//      module's answer to that refusal is the plan, not a weakened loader.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BUNDLE_FAULTS, parseBundle } from "../lib/pipeline-bundle.js";
import { REPAIR_FAULTS, planBundleRepair, readRepairModel } from "../lib/pipeline-bundle-repair.js";

const SEED = fileURLToPath(new URL("../pipeline-bundle.seed.json", import.meta.url));
const seedDoc = () => JSON.parse(readFileSync(SEED, "utf8"));
const seedModel = () => readRepairModel(SEED);

// The reader's stale file, in the one detail that refuses it: the seed's four studio pipelines with G1's routes gone.
// Built from the seed rather than copied so the fixture cannot drift from the document the panel ships.
const staleDoc = () => {
  const doc = seedDoc();
  doc.pipelines = doc.pipelines.filter((pipeline) => ["poc-to-uat", "ping-pong", "probe-fix", "author-review-revise"].includes(pipeline.id || (pipeline.project && pipeline.project.id)));
  const review = doc.pipelines.find((pipeline) => pipeline.id === "author-review-revise");
  delete review.gates[0].decision.routes;
  // The live file also predates the explicit pause: its six no-decision gates carry no key at all.
  for (const pipeline of doc.pipelines) for (const gate of pipeline.gates || []) if (gate.decision === null) delete gate.decision;
  return doc;
};

test("the stale four-pipeline bundle is refused, and the repair is the seed's own routes", () => {
  const doc = staleDoc();
  const before = parseBundle(doc);
  assert.equal(before.ok, false, "the fixture must be the refused shape");
  assert.equal(before.code, BUNDLE_FAULTS.GATE);
  assert.equal(before.where, "pipelines[3].gates[0].decision.routes");

  const plan = planBundleRepair(doc, { model: seedModel(), file: "state/pipeline-bundle.json" });
  assert.equal(plan.ok, true, plan.reason || "");
  assert.deepEqual(plan.pipelines.map((pipeline) => `${pipeline.id}:${pipeline.stages}`), [
    "poc-to-uat:13",
    "ping-pong:2",
    "probe-fix:2",
    "author-review-revise:3",
  ]);

  const routed = plan.changes.find((change) => change.kind === "routes");
  assert.ok(routed, "the one gate that refused is the one gate routed");
  assert.equal(routed.pipeline, "author-review-revise");
  assert.equal(routed.gate, "G1");
  assert.deepEqual(routed.routes, { accept: "H-03", reject: "H-02" }, "accept takes the sequence to revise, reject the capped loop");
  assert.equal(routed.where, "pipelines[3].gates[0].decision.routes");

  // The repaired document is one the panel's own loader accepts, with every pipeline it held before.
  const after = parseBundle(plan.doc);
  assert.equal(after.ok, true, after.reason || "");
  const review = after.bundle.pipelines.find((pipeline) => pipeline.id === "author-review-revise");
  assert.deepEqual(review.gates[0].decision.routes, { accept: "H-03", reject: "H-02" });
  assert.deepEqual(review.gates[0].decision.outcomes, ["accept", "reject"]);
});

test("the six gates that declare no decision come out as explicit pauses, and still load as pauses", () => {
  const doc = staleDoc();
  const plan = planBundleRepair(doc, { model: seedModel() });
  assert.equal(plan.ok, true, plan.reason || "");
  const pauses = plan.changes.filter((change) => change.kind === "pause");
  assert.deepEqual(
    pauses.map((change) => `${change.pipeline}/${change.gate}`),
    ["poc-to-uat/G0", "poc-to-uat/G1", "poc-to-uat/G2", "poc-to-uat/G3", "poc-to-uat/G4", "ping-pong/G1"],
    "every gate that declared nothing now says null, by pipeline and gate",
  );
  // The written document carries the key (not an omission), and the loader still reads each one as the pause it is.
  for (const pipeline of doc.pipelines) {
    for (const gate of pipeline.gates || []) {
      if (pipeline.id === "author-review-revise") continue;
      assert.ok(Object.prototype.hasOwnProperty.call(gate, "decision"), `${pipeline.id}/${gate.id} carries the decision key`);
      assert.equal(gate.decision, null, `${pipeline.id}/${gate.id} is a pause`);
    }
  }
  const loaded = parseBundle(doc);
  assert.equal(loaded.ok, true, loaded.reason || "");
  assert.ok(loaded.bundle.pipelines.filter((pipeline) => pipeline.id !== "author-review-revise").every((pipeline) => pipeline.gates.every((gate) => gate.decision === null)));
});

test("a gate with one way out is left alone: the loader needs no map there", () => {
  const doc = staleDoc();
  // probe-fix has no gate; use a one-stage document with a decision and one edge out, which the loader accepts.
  const oneWay = {
    bundleVersion: 1,
    name: "one way",
    pipelines: [
      {
        id: "one-way",
        title: "One way",
        stages: [
          { id: "write", title: "Write", prompt: "write it", artifact: { id: "a", path: "a/1", schema: "a/1", writer: "w" } },
          { id: "ship", title: "Ship", prompt: "ship it", artifact: { id: "b", path: "b/1", schema: "b/1", writer: "w" } },
        ],
        handoffs: [{ id: "H-01", from: "write", to: "ship", artifact: "a", kind: "sequence" }],
        gates: [{ id: "G1", after: "write", artifact: "a", decision: { id: "v", path: "v.json", schema: "v/1", writer: "w", outcomes: ["go"] } }],
      },
    ],
  };
  assert.equal(parseBundle(oneWay).ok, true, "the loader already accepts this shape");
  const plan = planBundleRepair(oneWay, { model: seedModel() });
  assert.equal(plan.ok, true, plan.reason || "");
  const change = plan.changes.find((entry) => entry.gate === "G1");
  assert.equal(change.kind, "not-required");
  assert.equal(oneWay.pipelines[0].gates[0].decision.routes, undefined, "no map was invented");
  assert.equal(doc.pipelines.length, 4, "and the other fixture was not touched by this plan");
});

test("a model that declares no routes for the gate refuses the plan, and nothing is written", () => {
  const doc = staleDoc();
  const model = seedModel();
  const review = model.raw.pipelines.find((pipeline) => pipeline.id === "author-review-revise");
  delete review.gates[0].decision.routes;
  const plan = planBundleRepair(doc, { model });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, REPAIR_FAULTS.OUTCOME);
  assert.equal(plan.where, "pipelines[3].gates[0].decision.routes");
  assert.match(plan.reason, /declares outcomes accept, reject and no "routes" map/);
  assert.match(plan.reason, /there is nothing to copy/);
  assert.equal(plan.doc, null, "a refusal carries no document to write");
  assert.deepEqual(plan.changes, []);
});

test("a model route the live pipeline does not hold refuses, rather than writing a dead edge", () => {
  const doc = staleDoc();
  const model = seedModel();
  // The model says accept goes to H-03; the live pipeline's acceptance edge is named something else.
  const review = doc.pipelines.find((pipeline) => pipeline.id === "author-review-revise");
  review.handoffs = review.handoffs.map((handoff) => (handoff.id === "H-03" ? { ...handoff, id: "H-99" } : handoff));
  const plan = planBundleRepair(doc, { model });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, REPAIR_FAULTS.TARGET);
  assert.match(plan.reason, /routes "accept" to handoff "H-03", which this pipeline does not hold/);
  assert.equal(plan.doc, null);
});

test("the repair is idempotent: a second plan finds nothing to route", () => {
  const doc = staleDoc();
  const first = planBundleRepair(doc, { model: seedModel() });
  assert.equal(first.ok, true, first.reason || "");
  const second = planBundleRepair(doc, { model: seedModel() });
  assert.equal(second.ok, true, second.reason || "");
  assert.deepEqual(second.changes, [], "the routes and the nulls are already there");
});

test("the guard still refuses a gate that declares outcomes and leaves the routes off", () => {
  // The seed is the model, so this fixture is the reader's real document with the ONE field removed that the repair
  // writes back. If the loader ever stopped refusing it, this test would pass only by losing its own premise.
  const doc = staleDoc();
  const refused = parseBundle(doc);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, BUNDLE_FAULTS.GATE);
  assert.equal(refused.bundle, null, "a refused bundle is never half-read");
  assert.match(refused.reason, /gate G1 of pipeline author-review-revise/);
  assert.match(refused.reason, /no "routes" map/);
  assert.match(refused.reason, /2 ways out \(H-02, H-03\)/);

  // And the SEED, as shipped, is not that shape: its own G1 answers both outcomes.
  const seed = parseBundle(seedDoc());
  assert.equal(seed.ok, true, seed.reason || "");
  assert.deepEqual(seed.bundle.pipelines.find((pipeline) => pipeline.id === "author-review-revise").gates.find((gate) => gate.id === "G1").decision.routes, {
    accept: "H-03",
    reject: "H-02",
  });
});
