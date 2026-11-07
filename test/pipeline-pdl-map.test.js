// The four PDL pipelines, in the Settings dropdown and on the map.
//
// The tab used to offer one list (the ladder) and draw one kind of document (a ladder definition). The bundle's
// pipelines are a different object: stages with an artifact, gates that end a stage, handoffs that are the edges and
// the loops. This file pins the two halves that make them visible without a browser:
//
//   THE READING   the catalogue comes from lib/pipeline-source.js over config.pipelineBundleFile - the same read the
//                 queue's picker quotes - and it holds the four ids at 13, 2, 2 and 3 stages;
//   THE DRAWING   public/core/pipeline-mermaid.js `fromPdl` turns one of those pipelines into the card model: one node
//                 per stage, one arrow per sequence handoff (labelled with the gate that ends the stage it leaves), one
//                 dashed loop per loop handoff with its cap, and the gates list.
//
// The dropdown's own markup and the dialog's wiring are pinned by slicing public/app.js and public/pipeline-modal.js;
// tools/verify-pdl-pipelines.mjs is the browser proof that the control and the card actually paint.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { pdlCatalogue, readPipelineSource } from "../lib/pipeline-source.js";

await import("../public/core/pipeline-mermaid.js");
const M = globalThis.PipelineMermaid;

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replaceAll(String.fromCharCode(13), "");
const BUNDLE = fileURLToPath(new URL("../pipeline-bundle.seed.json", import.meta.url));

// The one read the panel makes: config.pipelineBundleFile, through lib/pipeline-source.js.
const catalogue = pdlCatalogue(readPipelineSource({ pipelineBundleFile: BUNDLE }));
const byId = (id) => catalogue.pipelines.find((p) => p.id === id);

test("the catalogue holds the four PDL pipelines at 13, 2, 2 and 3 stages", () => {
  assert.equal(catalogue.ok, true, catalogue.reason || "the seed bundle is readable");
  assert.deepEqual(
    catalogue.pipelines.map((p) => p.id),
    ["poc-to-uat", "ping-pong", "probe-fix", "author-review-revise"],
  );
  assert.deepEqual(catalogue.pipelines.map((p) => p.stageCount), [13, 2, 2, 3]);
  // The counts are the stages list's own length, not a second number that could disagree with it.
  for (const pipeline of catalogue.pipelines) assert.equal(pipeline.stageCount, pipeline.stages.length, pipeline.id);
});

test("a PDL pipeline becomes the card's model: one node per stage, in the document's own order", () => {
  const item = M.fromPdl(byId("poc-to-uat"));
  assert.equal(item.id, "poc-to-uat");
  assert.equal(item.title, "POC to UAT");
  assert.equal(item.pdl, true);
  assert.equal(item.stages.length, 13);
  assert.deepEqual(item.stages.map((s) => s.id), ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12"]);
  assert.deepEqual(item.stages.map((s) => s.ordinal), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  // The second line is the artifact the stage writes - the document's own word for what leaves it. A PDL stage has no
  // prompt, so nothing is derived and nothing is invented.
  assert.equal(item.stages[0].role.source, "artifact");
  assert.equal(item.stages[0].role.label, "writes charter");
  assert.equal(item.stages[12].role.label, "writes signed-dod");
  assert.ok(item.stages.every((s) => s.prompt === ""), "no prompt is invented for a PDL stage");
});

test("the arrows are the sequence handoffs, labelled with the gate that ends the stage they leave", () => {
  const item = M.fromPdl(byId("poc-to-uat"));
  assert.equal(item.edges.length, 12);
  assert.deepEqual(item.edges.map((e) => `${e.from}->${e.to}`), [
    "S0->S1", "S1->S2", "S2->S3", "S3->S4", "S4->S5", "S5->S6",
    "S6->S7", "S7->S8", "S8->S9", "S9->S10", "S10->S11", "S11->S12",
  ]);
  // G0 ends S0, G1 ends S1, G2 ends S3, G3 ends S10; the rest are plain handoffs.
  assert.deepEqual(item.edges.map((e) => e.label), [
    "G0 · Charter (user)", "G1 · Behaviour (user)", "", "G2 · Meaning (engineer)", "", "",
    "", "", "", "", "G3 · Rebuild (engineer)", "",
  ]);
  assert.deepEqual(item.edges.filter((e) => e.gate).map((e) => e.gate), ["G0", "G1", "G2", "G3"]);
  // The gates list is the document's, with the decider and the artifact it decides on.
  assert.deepEqual(item.gates.map((g) => g.id), ["G0", "G1", "G2", "G3", "G4"]);
  assert.equal(item.gates[0].name, "Charter");
  assert.equal(item.gates[0].decider, "user");
  assert.equal(item.gates[0].artifact, "charter");
});

test("the dashed loops are the loop handoffs, with their caps and their ids", () => {
  const item = M.fromPdl(byId("poc-to-uat"));
  assert.deepEqual(item.loops.map((l) => `${l.id} ${l.from}->${l.to} ${l.cap}`), [
    "H-10 S9->S8 3 rounds (P-50)",
    "H-12 S10->S9 3 rounds (P-50)",
    "H-15 S12->S11 2 re-deliveries",
  ]);
  assert.ok(item.loops.every((l) => l.source === "data"), "a PDL loop is carried by the document, never inferred");
  // The small pipelines carry their own shape: one loop each for ping-pong and author-review-revise, none for probe-fix.
  assert.deepEqual(M.fromPdl(byId("ping-pong")).loops.map((l) => l.cap), ["3 rounds"]);
  assert.deepEqual(M.fromPdl(byId("probe-fix")).loops, []);
  assert.deepEqual(M.fromPdl(byId("author-review-revise")).loops.map((l) => l.cap), ["2 rejects"]);
});

test("every PDL pipeline draws at its own stage count, and the mermaid source carries one line per node and arrow", () => {
  for (const [id, stages, edges, loops] of [
    ["poc-to-uat", 13, 12, 3],
    ["ping-pong", 2, 1, 1],
    ["probe-fix", 2, 1, 0],
    ["author-review-revise", 3, 2, 1],
  ]) {
    const item = M.fromPdl(byId(id));
    assert.equal(item.stages.length, stages, `${id}: stages`);
    assert.equal(item.edges.length, edges, `${id}: edges`);
    assert.equal(item.loops.length, loops, `${id}: loops`);
    const lines = M.rowSource(item).split("\n");
    assert.equal(lines[0], "flowchart LR", `${id}: one flowchart`);
    assert.equal(lines.length, 1 + stages + edges + loops, `${id}: one line per node, arrow and loop`);
    assert.equal(lines.filter((l) => l.includes("-.->")).length, loops, `${id}: a dashed arrow per loop`);
  }
});

test("the dropdown offers the PDL pipelines first, tagged PDL, above the built-in ladders", () => {
  const app = read("public/app.js");
  const pdlGroup = app.indexOf('<optgroup label="PDL pipelines">');
  const ladderGroup = app.indexOf('<optgroup label="built-in ladders">');
  assert.ok(pdlGroup > 0, "the PDL group is in the dropdown's markup");
  assert.ok(ladderGroup > pdlGroup, "and it is written before the ladder group, so it lists first");
  assert.match(app, /value="pdl:\$\{esc\(p\.id\)\}"/, "a PDL option's value is namespaced, so one control can carry both lists");
  assert.match(app, /return `PDL · \$\{pipeline\.id\} — /, "the option's words start with the PDL tag");
  // The press routes a PDL value to the PDL selection and a ladder value to the editor.
  const select = app.slice(app.indexOf("function selectPipelineTab("), app.indexOf("function openPipelineFlow("));
  assert.match(select, /raw\.startsWith\("pdl:"\)/, "the press reads the namespace");
  assert.match(select, /pipelinePdlId = pdlId/, "and keeps the PDL selection");
  assert.match(select, /closePipelineEditor\(\)/, "a PDL pipeline closes the ladder editor rather than editing it");
});

test("the flow press draws a selected PDL pipeline with the shared card, from its stages, gates and handoffs", () => {
  const app = read("public/app.js");
  const flow = app.slice(app.indexOf("function openPipelineFlow("), app.indexOf("function openPdlFlow("));
  assert.match(flow, /const pdl = selectedPdlPipeline\(\)/, "the press asks for the PDL selection first");
  assert.match(flow, /openPdlFlow\(pdl\)/, "and hands it to the PDL drawing");
  const pdlFlow = app.slice(app.indexOf("function openPdlFlow("), app.indexOf("// Wired once, at load"));
  assert.match(pdlFlow, /pdl: true/, "the dialog is told this is a PDL document");
  assert.match(pdlFlow, /definition: pdl/, "and is handed the document itself");
  assert.match(pdlFlow, /label: "gates"/, "the facts name the gates");
  assert.match(pdlFlow, /label: "handoffs"/, "and the handoffs");
  // The dialog maps it with fromPdl, not fromDefinition: a PDL stage has no prompt to derive a role from.
  const modal = read("public/pipeline-modal.js");
  assert.match(modal, /item = state\.pdl \? M\.fromPdl\(state\.definition\) : M\.fromDefinition\(state\.definition\)/);
  assert.match(modal, /if \(state\.pdl\) return "";/, "a PDL pipeline offers no position control");
  assert.match(modal, /if \(!previewAvailable\(\) \|\| state\.pdl\) return "";/, "and no edit view to switch to");
});

test("the map link hands the map page this panel's own catalogue when a PDL pipeline is selected", () => {
  const app = read("public/app.js");
  assert.match(app, /mapLink\.href = pipelinePdlId \? "\/pipeline-map\.html\?doc=\/api\/assistant\/pipeline-catalogue" : "\/pipeline-map\.html"/);
  // The page's importer reads `{pipelines: [...]}` as one card per definition, which is the catalogue's shape.
  const importer = read("public/core/pipeline-import.js");
  assert.match(importer, /if \(parsed\.pipelines != null\)/);
  assert.match(importer, /definitionsOf\(parsed\.pipelines\)/);
});
