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

test("a live file this panel cannot read is refused rather than overwritten", () => {
  const plan = planImport("{ not json", studioDoc("x", "X"));
  assert.equal(plan.ok, false);
  assert.equal(plan.code, IMPORT_FAULTS.LIVE);
  assert.equal(plan.doc, null);
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
