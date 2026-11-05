// The ARTIFACT VIEW: what the drawing puts between the stages, and the three edge kinds it says it draws.
//
// The brief's second item: thin for `inputs.read`, thick for a handoff, dashed for the `external_inputs` boundary —
// and all of it from data the document already holds. So this file pins three things about the REAL seed and one
// hand-written fixture:
//
//   1. the node count is DERIVED — every artifact named as an input somewhere (a stage's `inputs.read[]`, a handoff's
//      `artifact`, the document's `external_inputs`) and nothing else. A drawing that invents an artifact, or drops
//      one, fails here;
//   2. a connector the document hands an artifact across is thick, and a read of something written further back is a
//      thin line — the two are not the same mark;
//   3. a read naming an artifact NOTHING here writes is drawn and MARKED missing, with the word painted: a drawing
//      that quietly dropped it would certify a graph the document does not have.
//
// The view is markup-and-a-list, not a screenshot: `flow.artifacts` is the list and `<span class="pflow-artifact">` is
// the drawing, so a test reads the same facts a reader sees.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseBundle } from "../lib/pipeline-bundle.js";
import { pipelineCatalogue } from "../lib/task-pipeline-assign.js";

await import("../public/pipeline-flow.js");
const { fromBundle, fromDefinition, fromWindowModel, markup } = globalThis.PipelineFlow;

// The seed is the panel's multi-pipeline wrapper; the 13-stage studio export is its `poc-to-uat` entry.
const SEED_DOC = JSON.parse(readFileSync(new URL("../pipeline-bundle.seed.json", import.meta.url), "utf8"));
const SEED = SEED_DOC.pipelines.find((p) => (p.id || (p.project && p.project.id)) === "poc-to-uat");
const SEED_FLOW = fromBundle(SEED);

const chips = (html) =>
  [...html.matchAll(/<span class="pflow-artifact" role="note" data-artifact="([^"]*)" data-at="(\d+)" data-side="([^"]*)" data-kind="([^"]*)"/g)].map((m) => ({
    id: m[1],
    at: Number(m[2]),
    side: m[3],
    kind: m[4],
  }));

const edges = (html) =>
  [...html.matchAll(/<span class="pflow-artifact-edge" data-edge="([^"]*)" data-artifact="([^"]*)" data-to="([^"]*)"/g)].map((m) => ({
    kind: m[1],
    artifact: m[2],
    to: m[3],
  }));

const dots = (html) =>
  [...html.matchAll(/<i class="pflow-artifact-dot" data-edge="([^"]*)" data-artifact="([^"]*)" data-to="([^"]*)"/g)].map((m) => ({
    kind: m[1],
    artifact: m[2],
    to: m[3],
  }));

// Every artifact the document names as somebody's input, from the document's own fields — the number the drawing
// must produce without being told.
function inputsOf(doc) {
  const ids = new Set();
  for (const handoff of doc.handoffs || []) if (handoff.artifact) ids.add(handoff.artifact);
  for (const stage of doc.stages || []) for (const read of (stage.inputs && stage.inputs.read) || []) if (read.artifact) ids.add(read.artifact);
  for (const entry of doc.external_inputs || []) if (entry.artifact) ids.add(entry.artifact);
  return ids;
}

test("the seed draws one node per artifact it names as an input, and no other", () => {
  const expected = inputsOf(SEED);
  const html = markup(SEED_FLOW, null);
  const drawn = chips(html);
  assert.equal(drawn.length, expected.size, `the seed names ${expected.size} input artifacts`);
  assert.deepEqual(
    drawn.map((chip) => chip.id).sort(),
    [...expected].sort(),
    "every artifact named as an input is drawn, and nothing invented",
  );
  assert.match(html, new RegExp(`data-artifacts="${expected.size}"`), "the root says how many nodes the view drew");
  assert.match(html, /<div class="pflow-artifacts" data-pflow-artifacts="\d+"/, "the layer is on the canvas, under the track");
  // A handoff's artifact is a node: the picture is a chain, so every edge the studio drew has something on it.
  for (const handoff of SEED.handoffs) assert.ok(drawn.some((chip) => chip.id === handoff.artifact), `handoff ${handoff.id} carries ${handoff.artifact}`);
});

test("a handoff is thick, a read is thin, and the document's boundary is dashed", () => {
  const html = markup(SEED_FLOW, null);
  // The connector after a stage that hands an artifact on carries the edge's id — that is the thick mark.
  const thick = [...html.matchAll(/<span class="pflow-link" aria-hidden="true" data-handoff="([^"]*)" data-artifact="([^"]*)"/g)].map((m) => ({ edge: m[1], artifact: m[2] }));
  assert.equal(thick.length, 12, "the seed's twelve sequence handoffs are drawn thick");
  assert.deepEqual(
    thick.map((link) => link.edge).sort(),
    SEED.handoffs.filter((handoff) => handoff.kind === "sequence").map((handoff) => handoff.id).sort(),
    "and each names a sequence edge the document holds",
  );
  // A read of an artifact written further back is a thin route to the furthest column it reaches, with a dot under
  // every column that reads it — `semantic-layer` is written at S3 and read again at S5..S8. One line, four dots: a
  // fan-out drawn as four nested lines would paint over itself and say the same thing four times.
  const longRead = edges(html).filter((edge) => edge.artifact === "semantic-layer");
  assert.deepEqual(longRead.map((edge) => [edge.kind, edge.to]), [["read", "S8"]], "one thin route, to the furthest reader");
  assert.deepEqual(
    dots(html).filter((dot) => dot.artifact === "semantic-layer").map((dot) => [dot.kind, dot.to]),
    [["read", "S5"], ["read", "S6"], ["read", "S7"], ["read", "S8"]],
    "and a dot under every stage that reads it (S4 is the handoff, and an adjacent handoff has no line)",
  );
  // The external inputs sit on the document's own left boundary, dashed, and their edges are dashed too.
  const external = chips(html).filter((chip) => chip.kind === "external");
  assert.deepEqual(external.map((chip) => [chip.id, chip.at, chip.side]).sort(), [["branch-head", 0, "left"], ["poc-crawl", 0, "left"], ["poc-snapshot", 0, "left"]].sort());
  assert.ok(edges(html).filter((edge) => edge.kind === "external").length >= 3, "each external read is a dashed edge");
  // Nothing is missing in a document that declares all three: `missing` must not be invented either.
  assert.doesNotMatch(html, /data-missing="1"/);
  // The key names the styles the picture uses, and only those.
  const key = (html.match(/<div class="pflow-artifact-key"[\s\S]*?<\/div>/) || [""])[0];
  assert.deepEqual([...key.matchAll(/data-edge="([^"]*)"/g)].map((m) => m[1]), ["read", "handoff", "external"]);
});

test("a read of an artifact nothing writes is drawn and marked missing, and the word is painted", () => {
  const doc = {
    id: "gaps",
    title: "Gaps",
    stages: [
      { id: "S1", title: "One", prompt: "one", artifact: { id: "a1", path: "a1.json", schema: "a/1", writer: "w1" } },
      {
        id: "S2",
        title: "Two",
        prompt: "two",
        artifact: { id: "a2", path: "a2.json", schema: "a/1", writer: "w2" },
        // `ghost` is read and declared nowhere: not a stage artifact, not an external input.
        inputs: { read: [{ artifact: "a1" }, { artifact: "ghost" }] },
      },
    ],
    gates: [],
    handoffs: [{ id: "H-1", from: "S1", to: "S2", artifact: "a1", kind: "sequence" }],
  };
  const html = markup(fromBundle(doc), null);
  const drawn = chips(html);
  assert.deepEqual(drawn.map((chip) => chip.id).sort(), ["a1", "ghost"], "two nodes: the artifact handed on, and the one nobody writes");
  const ghost = drawn.find((chip) => chip.id === "ghost");
  assert.equal(ghost.kind, "missing");
  assert.match(html, /data-artifact="ghost"[^>]*data-missing="1"/, "the node says it is missing in the DOM");
  // The mark is VISIBLE, not only an attribute: the chip's painted text carries the word.
  const chipHtml = (html.match(/<span class="pflow-artifact"[^>]*data-artifact="ghost"[^>]*>[^<]*<\/span>/) || [""])[0];
  assert.match(chipHtml.replace(/<[^>]*>/g, ""), /ghost — missing/, "the reader sees the word");
  assert.match(chipHtml, /aria-label="[^"]*missing[^"]*"/, "and a screen reader is told the same thing");
  assert.match(html, /<span class="pflow-artifact-key-item" data-edge="missing"><i aria-hidden="true"><\/i>missing — nothing writes it<\/span>/, "the key explains the mark");
  // The artifact handed on across the connector is still thick, beside the missing one.
  assert.equal((html.match(/class="pflow-link" aria-hidden="true" data-handoff="H-1"/g) || []).length, 1);
});

test("a pipeline with no artifacts draws no layer and no key, and a definition has none to draw", () => {
  const bare = { id: "bare", title: "Bare", stages: [{ id: "S1", title: "One", prompt: "one", artifact: { id: "a1", path: "a1", schema: "a/1", writer: "w" } }], gates: [], handoffs: [] };
  const html = markup(fromBundle(bare), null);
  assert.doesNotMatch(html, /class="pflow-artifacts"/);
  assert.doesNotMatch(html, /data-pflow-artifact-key/);
  assert.match(html, /data-artifacts="0"/);
  const def = JSON.parse(readFileSync(new URL("../pipelines.seed.json", import.meta.url), "utf8")).pipelines[0];
  assert.doesNotMatch(markup(fromDefinition(def), null), /class="pflow-artifacts"/);
});

test("the catalogue the live flow is handed carries what the drawing needs — nothing reads as missing", () => {
  // The live row's flow is drawn from `/api/assistant/pipeline-catalogue`, not from the document. When that answer
  // omitted the stage's artifact, every node it drew was `missing` — a claim about the DOCUMENT made by a gap in the
  // ANSWER. The catalogue now carries the artifact and the reads, and this pins it.
  const parsed = parseBundle(SEED, { file: "pipeline-bundle.seed.json" });
  assert.equal(parsed.ok, true, parsed.reason);
  const catalogue = pipelineCatalogue(parsed);
  assert.equal(catalogue.ok, true);
  const html = markup(fromBundle(catalogue.pipelines[0]), { stage: "S4" });
  const drawn = chips(html);
  assert.equal(drawn.length, inputsOf(SEED).size, "the live answer draws the same node count as the document");
  assert.deepEqual(drawn.filter((chip) => chip.kind === "missing"), [], "and claims nothing is missing");
  assert.equal((html.match(/class="pflow-link" aria-hidden="true" data-handoff=/g) || []).length, 12, "the thick connectors survive the catalogue too");
});

test("the window model draws the same view from its own stages, when no bundle is available", () => {
  const model = {
    pipeline: { id: "p", title: "P" },
    count: 2,
    externalInputs: [{ artifact: "outside", source: "a checkpoint" }],
    stages: [
      { id: "S1", title: "One", position: 1, phase: "before", artifact: { id: "a1", path: "a1", schema: "a/1", writer: "w1" }, reads: [], handoffOut: { id: "H-1", from: "S1", to: "S2", artifact: "a1", kind: "sequence" } },
      { id: "S2", title: "Two", position: 2, phase: "current", artifact: { id: "a2", path: "a2", schema: "a/1", writer: "w2" }, reads: [{ artifact: "a1" }, { artifact: "outside" }], handoffOut: null },
    ],
  };
  const html = markup(fromWindowModel(model), { stage: "S2" });
  assert.deepEqual(chips(html).map((chip) => chip.id).sort(), ["a1", "outside"]);
  assert.equal(chips(html).find((chip) => chip.id === "outside").kind, "external");
  assert.deepEqual(edges(html).map((edge) => [edge.kind, edge.to]), [["external", "S2"]], "adjacent handoffs are the thick connector, not a line");
});
