// One pipeline definition, one validation path: the PDL bundle both controls quote.
//
//   lib/pipeline-source.js                  readPipelineSource / pdlCatalogue / pipelineSourceCatalogue
//   GET /api/assistant/pipeline-catalogue   the queue picker's list (lib/task-pipeline-assign.js)
//   GET /api/pipelines                      the Settings pipeline tab's answer, carrying the same list as `pdl`
//
// The defect this holds shut: the Settings tab listed the tree ladder and the queue picker listed the PDL bundle, so
// "the pipelines" was two different sets depending on which control the reader pressed, and a PDL document imported
// from the factory appeared in one and not the other. Six things are pinned here:
//
//   1. the catalogue is the BUNDLE's own list - every id, its stage count, its stages in order, its gates and its
//      handoffs - read through the loader, never re-parsed;
//   2. the two routes quote the SAME list, id for id and stage count for stage count;
//   3. a refused bundle is refused ONCE: both answers carry the loader's own code, sentence and locator, and the
//      Settings answer still carries the ladder beside it (a broken bundle is not a broken catalogue);
//   4. a bundle that is not there is `missing` on both sides, and both name the file;
//   5. the list is read per request, so an import shows on the next open with no restart and no cache to clear;
//   6. an imported PDL document is read AS IT IS - the import does not rewrite the format the factory exports.
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readBundle } from "../lib/pipeline-bundle.js";
import { pdlCatalogue, readPipelineSource } from "../lib/pipeline-source.js";
import { ROOT, startPanel } from "../tools/panel-testkit.mjs";
import { ladderDefinition } from "./fixtures/ladder-definitions.mjs";

const SEED = path.join(ROOT, "pipeline-bundle.seed.json");
const SEED_DOC = JSON.parse(readFileSync(SEED, "utf8"));

// The bundle's own order: the four studio exports it shipped, then the seven ladders the conversion moved here. A
// pipeline that dropped out of the bundle, or moved, fails the first assertion below.
const BUNDLE_IDS = [
  "poc-to-uat",
  "ping-pong",
  "probe-fix",
  "author-review-revise",
  "local",
  "investigate",
  "turnover",
  "github-investigate",
  "sefl-investigate",
  "github-force-merge",
  "sefl-review-loop",
];

const catalogueOf = async (base) => {
  const res = await fetch(`${base}/api/assistant/pipeline-catalogue`);
  return { status: res.status, json: await res.json() };
};

const settingsOf = async (base) => {
  const res = await fetch(`${base}/api/pipelines`);
  return { status: res.status, json: await res.json() };
};

// The fields a page may quote, in one place: id, title, count, and the stage ids in order.
const bare = (catalogue) => ({
  ok: catalogue.ok,
  code: catalogue.code,
  reason: catalogue.reason,
  where: catalogue.where,
  file: catalogue.file === null ? null : Boolean(catalogue.file),
  name: catalogue.name,
  pipelines: (catalogue.pipelines || []).map((p) => ({
    id: p.id,
    title: p.title,
    stageCount: p.stageCount,
    stages: p.stages.map((s) => s.id),
  })),
});

test("the catalogue is the bundle's own list, read through the loader", () => {
  const source = readBundle(SEED);
  assert.equal(source.ok, true, source.reason || "the shipped seed must parse");
  const catalogue = pdlCatalogue(source);
  assert.equal(catalogue.ok, true);
  assert.equal(catalogue.name, SEED_DOC.name);
  assert.deepEqual(
    catalogue.pipelines.map((p) => p.id),
    BUNDLE_IDS,
  );
  const big = catalogue.pipelines.find((p) => p.id === "poc-to-uat");
  assert.equal(big.stageCount, 13);
  assert.equal(big.stageCount, big.stages.length, "the count is the stages list's own length");
  assert.equal(big.stages[0].id, "S0");
  assert.equal(big.stages[0].position, 1);
  assert.ok(big.stages[0].artifact && big.stages[0].artifact.id, "a stage's artifact travels with it");
  assert.ok(big.gates.length >= 1 && big.handoffs.length >= 1, "gates and handoffs travel with the pipeline");
  assert.equal(big.isolation, "shared");
});

test("both routes quote one list, and a refused bundle is refused once", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-pipeline-source-"));
  const bundleFile = path.join(dir, "pipeline-bundle.json");
  writeFileSync(bundleFile, JSON.stringify(SEED_DOC, null, 1), "utf8");
  // The ladder that reads beside the PDL list: the seed ships none, so the reader's own file is what the panel shows,
  // and a bundle that is refused or absent must leave it untouched.
  const pipelinesFile = path.join(dir, "pipelines.json");
  writeFileSync(pipelinesFile, JSON.stringify({ version: 1, pipelines: [ladderDefinition("local")] }, null, 1), "utf8");
  const panel = await startPanel({
    dir,
    keep: true,
    config: {
      dataDir: path.join(dir, "data"),
      scratchDir: path.join(dir, "scratch"),
      refreshSeconds: 3600,
      worktreeSeconds: 3600,
      midSeconds: 3600,
      dormantSeconds: 3600,
      slowSeconds: 3600,
      fetchSeconds: -1,
      assistant: { enabled: false },
      apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
      pipelineBundleFile: bundleFile,
      pipelinesFile,
    },
  });
  t.after(async () => {
    await panel.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  // (1) one list, quoted by both routes.
  const picker = await catalogueOf(panel.base);
  const settings = await settingsOf(panel.base);
  assert.equal(picker.status, 200);
  assert.equal(settings.status, 200);
  assert.equal(picker.json.ok, true, picker.json.reason || "");
  assert.deepEqual(bare(settings.json.pdl), bare(picker.json), "the Settings answer carries the picker's own list");
  assert.equal(settings.json.pdl.pipelines.length, BUNDLE_IDS.length);
  assert.ok(settings.json.pipelines.local, "the ladder still reads beside the PDL list");

  // (2) a refused bundle: the loader's code, sentence and locator, identically on both sides, and nothing written.
  writeFileSync(
    bundleFile,
    JSON.stringify({ bundleVersion: 1, name: "broken", pipelines: [{ id: "half", title: "Half", stages: [{ id: "only" }] }] }, null, 1),
    "utf8",
  );
  const refusedPicker = await catalogueOf(panel.base);
  const refusedSettings = await settingsOf(panel.base);
  assert.equal(refusedPicker.json.ok, false);
  assert.equal(refusedSettings.json.pdl.ok, false);
  assert.equal(refusedPicker.json.code, "incomplete-stage", `code: ${refusedPicker.json.code}`);
  assert.deepEqual(bare(refusedSettings.json.pdl), bare(refusedPicker.json), "one refusal, not two sentences");
  assert.match(refusedPicker.json.reason, /stages\[0\]/, "the locator is in the sentence as well as in `where`");
  assert.ok(refusedSettings.json.pipelines.local, "a refused PDL bundle does not empty the ladder");
  assert.equal(refusedSettings.json.pdl.pipelines.length, 0);

  // (3) absent: `missing` on both sides, and both name the file.
  const missingFile = path.join(dir, "no-bundle-here.json");
  const missingPanel = await startPanel({
    dir: path.join(dir, "missing"),
    keep: true,
    config: {
      dataDir: path.join(dir, "missing", "data"),
      scratchDir: path.join(dir, "missing", "scratch"),
      refreshSeconds: 3600,
      worktreeSeconds: 3600,
      midSeconds: 3600,
      dormantSeconds: 3600,
      slowSeconds: 3600,
      fetchSeconds: -1,
      assistant: { enabled: false },
      apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
      pipelineBundleFile: missingFile,
    },
  });
  t.after(async () => {
    await missingPanel.stop();
  });
  const missingPicker = await catalogueOf(missingPanel.base);
  const missingSettings = await settingsOf(missingPanel.base);
  assert.equal(missingPicker.json.code, "missing");
  assert.equal(missingSettings.json.pdl.code, "missing");
  assert.deepEqual(bare(missingSettings.json.pdl), bare(missingPicker.json));
  assert.ok(String(missingPicker.json.reason).includes("no-bundle-here.json"), missingPicker.json.reason);
});

test("an imported PDL document is read as it is, and the next open lists it", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-pipeline-source-import-"));
  const bundleFile = path.join(dir, "pipeline-bundle.json");
  writeFileSync(bundleFile, JSON.stringify(SEED_DOC, null, 1), "utf8");
  const panel = await startPanel({
    dir,
    keep: true,
    config: {
      dataDir: path.join(dir, "data"),
      scratchDir: path.join(dir, "scratch"),
      refreshSeconds: 3600,
      worktreeSeconds: 3600,
      midSeconds: 3600,
      dormantSeconds: 3600,
      slowSeconds: 3600,
      fetchSeconds: -1,
      assistant: { enabled: false },
      apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
      pipelineBundleFile: bundleFile,
    },
  });
  t.after(async () => {
    await panel.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  // The shape a factory export arrives in: the document's own snake_case fields, a project root, roles by id.
  const imported = {
    version: 1,
    project: { id: "factory-doc", name: "A factory document" },
    roles: [{ id: "checker", name: "Checker", kind: "agent", instructions: "check it" }],
    stages: [
      { id: "check", title: "Check", owner: { kind: "agent", role: "checker" }, artifact: { id: "check-report", path: "ledger/factory/check.md", schema: "check/1", writer: "checker" } },
      { id: "sign", title: "Sign", owner: { kind: "seat", role: "checker" }, artifact: { id: "signed", path: "ledger/factory/signed.md", schema: "signed/1", writer: "checker" } },
    ],
    handoffs: [{ id: "H-01", from: "check", to: "sign", artifact: "check-report", kind: "sequence" }],
    gates: [],
    external_inputs: [],
  };
  const res = await fetch(`${panel.base}/api/assistant/pipeline-bundle/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ document: imported }),
  });
  const answer = await res.json();
  assert.equal(res.status, 200, JSON.stringify(answer));
  assert.equal(answer.ok, true);

  const picker = await catalogueOf(panel.base);
  const settings = await settingsOf(panel.base);
  assert.deepEqual(bare(settings.json.pdl), bare(picker.json), "the imported document reached both answers");
  assert.deepEqual(picker.json.pipelines.map((p) => p.id), [...BUNDLE_IDS, "factory-doc"]);
  const added = picker.json.pipelines.find((p) => p.id === "factory-doc");
  assert.equal(added.stageCount, 2);
  assert.deepEqual(added.stages.map((s) => s.id), ["check", "sign"]);
  assert.equal(added.handoffs[0].kind, "sequence", "the document's own handoff kind is carried, not normalised");

  // The file on disk is the bundle the import wrote: the document's fields are untouched, only the wrapper is new.
  const onDisk = JSON.parse(readFileSync(bundleFile, "utf8"));
  const record = onDisk.pipelines.find((p) => (p.id || (p.project && p.project.id)) === "factory-doc");
  assert.ok(record.project && record.project.name === "A factory document", "the PDL document travels verbatim");
  assert.deepEqual(record.stages.map((s) => s.id), ["check", "sign"]);
});

test("readPipelineSource names one file: the config key, never a second guess", () => {
  const source = readPipelineSource({ pipelineBundleFile: SEED });
  assert.equal(source.ok, true, source.reason || "");
  assert.equal(path.resolve(source.file), path.resolve(SEED));
  assert.equal(readPipelineSource({}).code, "missing", "no key is a missing bundle, not a crash");
  assert.equal(pdlCatalogue(null).code, "pipeline-bundle");
});
