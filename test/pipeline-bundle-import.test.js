// Importing a studio export into the live bundle APPENDS by id; it never replaces what is already there.
//
// The defect this pins: the live `state/pipeline-bundle.json` was one studio document, so a second import could only
// overwrite the first and the panel's dropdown kept exactly one entry. The bundle format holds a list, so an import
// reads the wrapper (or lifts a studio document into one), appends the incoming pipelines, and refuses a duplicate id
// BY NAME — a duplicate would make a task's `pipelineRun.pipeline` ambiguous.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseBundle, readBundle } from "../lib/pipeline-bundle.js";
import { IMPORT_FAULTS, importBundleFile, planImport } from "../lib/pipeline-bundle-import.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEED = JSON.parse(readFileSync(path.join(ROOT, "pipeline-bundle.seed.json"), "utf8"));
const POC = SEED.pipelines.find((p) => (p.id || (p.project && p.project.id)) === "poc-to-uat");
const PING = SEED.pipelines.find((p) => p.id === "ping-pong");

const studioDoc = (id, title) => ({
  version: 1,
  project: { id, name: title, description: `${title} as the studio exports it.` },
  roles: [{ id: `${id}-role`, name: `${title} role`, kind: "agent", instructions: `do ${title}` }],
  stages: [
    {
      id: `${id}-one`,
      title: `${title} one`,
      owner: { kind: "agent", role: `${id}-role` },
      artifact: { id: `${id}-artifact`, path: `ledger/${id}/one.md`, schema: "one/1", writer: `${id}-role` },
    },
  ],
  handoffs: [],
  gates: [],
});

const bundled = (pipelines, name = "mixed") => ({ bundleVersion: 1, name, pipelines });

test("the FIRST import into no file creates the panel wrapper around the studio document", () => {
  const incoming = studioDoc("first", "First");
  const plan = planImport(null, incoming);
  assert.equal(plan.ok, true, plan.reason);
  assert.deepEqual(plan.added, [{ id: "first", title: "First", stages: 1 }]);
  assert.deepEqual(plan.pipelines.map((p) => p.id), ["first"]);
  assert.equal(plan.doc.bundleVersion, 1);
  assert.equal(plan.doc.pipelines.length, 1);
  // The studio record is carried VERBATIM — the lift adds a wrapper, it does not re-serialise the pipeline.
  assert.deepEqual(plan.doc.pipelines[0], incoming);
  const read = parseBundle(plan.text);
  assert.equal(read.ok, true, `${read.code} ${read.reason}`);
});

test("a second import APPENDS: the live studio document is lifted to pipelines[0] and the new one becomes pipelines[1]", () => {
  const live = POC; // exactly what `state/pipeline-bundle.json` used to hold: one studio document
  const incoming = studioDoc("second", "Second");
  const plan = planImport(live, incoming);
  assert.equal(plan.ok, true, plan.reason);
  assert.deepEqual(plan.pipelines.map((p) => p.id), ["poc-to-uat", "second"]);
  assert.deepEqual(plan.added, [{ id: "second", title: "Second", stages: 1 }], "only the new pipeline is in `added`");
  assert.deepEqual(plan.doc.pipelines[0], POC, "the pipeline already in the file is unchanged, field for field");
  assert.deepEqual(plan.doc.pipelines[1], incoming);

  const read = parseBundle(plan.text);
  assert.equal(read.ok, true, `${read.code} ${read.reason}`);
  assert.deepEqual(read.bundle.pipelines.map((p) => [p.id, p.stages.length]), [["poc-to-uat", 13], ["second", 1]]);
  // 13 stages come back with their prompt from the role, which is only true if the lifted record kept `roles`.
  assert.equal(read.bundle.pipelines[0].stages[0].promptFrom, "role:steward");
});

test("an import into an existing panel wrapper keeps its name, adds the pipeline, and leaves the others alone", () => {
  const live = bundled([POC], "SEFL pipelines");
  // A single pipeline still arrives as a DOCUMENT (a panel one here) because the loader dates an import by its version.
  const plan = planImport(live, bundled([PING], "ping-pong export"));
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(plan.repair, null, "a readable live bundle is an append, not a repair");
  assert.equal(plan.doc.name, "SEFL pipelines");
  assert.deepEqual(plan.pipelines.map((p) => p.id), ["poc-to-uat", "ping-pong"]);
});

test("a duplicate id is refused BY NAME, and the reason says which pipeline already holds it", () => {
  const live = bundled([POC]);
  const plan = planImport(live, studioDoc("poc-to-uat", "A second copy"));
  assert.equal(plan.ok, false);
  assert.equal(plan.code, IMPORT_FAULTS.DUPLICATE);
  assert.deepEqual(plan.duplicates, [{ id: "poc-to-uat", title: "A second copy", existingTitle: "POC to UAT" }]);
  assert.match(plan.reason, /"poc-to-uat"/);
  assert.match(plan.reason, /already held as POC to UAT/);
  assert.match(plan.reason, /Nothing was written/);
  assert.equal(plan.doc, null, "a refused plan carries no document to write");
});

test("two pipelines inside ONE incoming bundle that share an id are refused too — before either is written", () => {
  // The loader refuses an intra-document duplicate before this module's own by-id pass sees it, and that is the better
  // refusal: it names the id the reader has to change. Either way nothing is written.
  const plan = planImport(null, bundled([studioDoc("twin", "Twin A"), studioDoc("twin", "Twin B")]));
  assert.equal(plan.ok, false);
  assert.ok(["not-a-bundle", IMPORT_FAULTS.DUPLICATE].includes(plan.code), plan.code);
  assert.match(plan.reason, /"twin"/);
  assert.equal(plan.doc, null);
});

test("a document the loader refuses is refused here with the loader's own code and locator", () => {
  const bad = studioDoc("broken", "Broken");
  delete bad.stages[0].artifact;
  const plan = planImport(null, bad);
  assert.equal(plan.ok, false);
  assert.equal(plan.code, "incomplete-stage", "the loader's code travels, not a new one");
  assert.match(plan.reason, /cannot be read/);
  assert.match(plan.reason, /stages\[0\]/);
});

// The case this module exists for is a bundle the panel draws as unresolved, and it was the one case the import
// refused: a live file the loader cannot read. The reader had to run `node tools/seed-pipeline-bundle.mjs --force` by
// hand. A repair replaces that file with the document being imported and says so on the plan, naming the fault of the
// file it replaces — but a document that does not load is still refused, because one refused bundle does not repair
// another, and a readable bundle is still appended to.

test("a READABLE live bundle is still an append: the plan is not a repair and carries no repair sentence", () => {
  const plan = planImport(bundled([POC], "SEFL pipelines"), studioDoc("after", "After"));
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(plan.repair, null);
  assert.equal(plan.reason, null);
  assert.deepEqual(plan.pipelines.map((p) => p.id), ["poc-to-uat", "after"]);
});

test("a live bundle the loader REFUSES is repaired, and the plan names the fault of the file it replaces", () => {
  // The measured case (docs/reports/pipeline-window-stale-bundle-2026-11-08.md): gate G1 of `author-review-revise`
  // declares two outcomes and carries no routes map, so the loader refuses the file WHOLE and the window draws
  // nothing. Importing the seed over it used to answer live-bundle-unreadable.
  const stale = JSON.parse(JSON.stringify(SEED));
  delete stale.pipelines.find((p) => p.id === "author-review-revise").gates[0].decision.routes;
  const refused = parseBundle(stale);
  assert.equal(refused.ok, false, "the fixture has to be one the panel's own loader refuses");
  assert.equal(refused.code, "incomplete-gate");

  const plan = planImport(stale, SEED);
  assert.equal(plan.ok, true, plan.reason);
  assert.ok(plan.repair, "the plan says it is a repair");
  assert.equal(plan.repair.code, "incomplete-gate", "the loader's code travels into the repair");
  assert.equal(plan.repair.where, refused.where);
  assert.match(plan.repair.reason, /the file it replaces cannot be read/);
  assert.match(plan.repair.reason, /routes/, "what was wrong is the loader's own sentence");
  assert.match(plan.reason, /a repair/);
  assert.match(plan.reason, /incomplete-gate/);

  // The replacement is the seed whole, and it reads back through the same loader the panel reads with.
  const seedIds = SEED.pipelines.map((p) => p.id || (p.project && p.project.id));
  assert.deepEqual(plan.pipelines.map((p) => p.id), seedIds);
  assert.equal(plan.doc.name, "SEFL pipelines");
  const reread = parseBundle(plan.text);
  assert.equal(reread.ok, true, `${reread.code} ${reread.reason}`);
  assert.equal(reread.bundle.pipelines.length, seedIds.length);
});

test("a live file that is not JSON is repaired the same way, and an ABSENT file is still a first import", () => {
  const plan = planImport("{ not json", SEED);
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(plan.repair.code, "not-a-bundle");
  assert.equal(plan.pipelines.length, SEED.pipelines.length);

  const first = planImport(null, SEED);
  assert.equal(first.ok, true, first.reason);
  assert.equal(first.repair, null, "there was no file to repair");
});

test("a document that does not parse is refused even over an unreadable live file, and nothing is replaced", () => {
  const brokenSeed = JSON.parse(JSON.stringify(SEED));
  delete brokenSeed.pipelines[0].stages[0].artifact;
  const plan = planImport("{ not json", brokenSeed);
  assert.equal(plan.ok, false);
  assert.equal(plan.code, "incomplete-stage", "the refusal names the document the reader handed in");
  assert.equal(plan.doc, null);
  assert.equal(plan.repair, null);
});

test("importBundleFile writes the merged bundle, and a second import of another pipeline appends again", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-import-"));
  const file = path.join(dir, "pipeline-bundle.json");
  try {
    // Start from exactly the old live shape: one studio document on disk.
    writeFileSync(file, JSON.stringify(POC, null, 1), "utf8");
    const first = importBundleFile({ file, document: studioDoc("second", "Second") });
    assert.equal(first.ok, true, first.reason);
    assert.deepEqual(first.added.map((p) => p.id), ["second"]);
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(onDisk.bundleVersion, 1);
    assert.deepEqual(onDisk.pipelines.map((p) => p.id || (p.project && p.project.id)), ["poc-to-uat", "second"]);

    const second = importBundleFile({ file, textBody: JSON.stringify(studioDoc("third", "Third")) });
    assert.equal(second.ok, true, second.reason);
    const read = readBundle(file);
    assert.deepEqual(read.bundle.pipelines.map((p) => p.id), ["poc-to-uat", "second", "third"]);

    // A duplicate leaves the file BYTE-IDENTICAL: the refusal is before the write, not a rollback after one.
    const before = readFileSync(file, "utf8");
    const dup = importBundleFile({ file, document: studioDoc("second", "Second again") });
    assert.equal(dup.ok, false);
    assert.equal(dup.code, IMPORT_FAULTS.DUPLICATE);
    assert.equal(readFileSync(file, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("importBundleFile REPLACES an unreadable live file, and the next import appends to the repaired file", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-import-repair-"));
  const file = path.join(dir, "pipeline-bundle.json");
  try {
    // Truncated mid-record, the shape a half-written edit leaves: not JSON at all.
    writeFileSync(file, '{"bundleVersion":1,"name":"stale","pipelines":[{"id":"half', "utf8");
    const out = importBundleFile({ file, document: SEED });
    assert.equal(out.ok, true, out.reason);
    assert.ok(out.repair, "the result says it was a repair, not an append");
    assert.equal(out.repair.code, "not-a-bundle");
    const read = readBundle(file);
    assert.equal(read.ok, true, `${read.code} ${read.reason}`);
    assert.deepEqual(read.bundle.pipelines.map((p) => p.id), SEED.pipelines.map((p) => p.id || (p.project && p.project.id)));

    // The repair is ONE import, not a mode: the file now loads, so the next one appends to it.
    const next = importBundleFile({ file, document: studioDoc("after-repair", "After the repair") });
    assert.equal(next.ok, true, next.reason);
    assert.equal(next.repair, null);
    assert.equal(next.pipelines[next.pipelines.length - 1].id, "after-repair");

    // And a seed that itself fails to parse still writes nothing: the file stays byte-identical.
    const brokenSeed = JSON.parse(JSON.stringify(SEED));
    delete brokenSeed.pipelines[0].stages[0].artifact;
    const before = readFileSync(file, "utf8");
    const bad = importBundleFile({ file, document: brokenSeed });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "incomplete-stage");
    assert.equal(readFileSync(file, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("the import refuses a body that names no document", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-import-empty-"));
  try {
    const out = importBundleFile({ file: path.join(dir, "pipeline-bundle.json") });
    assert.equal(out.ok, false);
    assert.equal(out.code, IMPORT_FAULTS.DOCUMENT);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
