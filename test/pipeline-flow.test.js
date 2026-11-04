// The pipeline FLOW renderer (public/pipeline-flow.js): a definition, a bundle pipeline or a task window's model
// drawn as one left-to-right sequence.
//
// This is the pure half of the pipeline modal and it is driven against the REAL documents: pipelines.seed.json and
// pipeline-bundle.seed.json, read from disk, so a shape the two loaders produce is what the renderer is asked to draw.
// What this pins:
//
//   - the sequence reads left to right, one column per stage in the order the document holds;
//   - every gate is a NOTCH on the connector after its stage — including the gate that ends the last stage, which
//     sits on the track's own closing edge rather than on a stub past it;
//   - a capped loop is ONE arc above the track, labelled with its cap and nothing else: no handoff id, no stage id
//     and no stage title reaches the drawing, and two loops that meet on a stage are on different lanes;
//   - the four marks — not reached, current, done, refused — are `data-mark` on the stage, and the legend counts them;
//   - a definition's exit check is its notch (a definition has gates, not a bundle's gates), and a definition has no
//     position, so every stage is drawn not reached;
//   - motion is a data attribute: `data-motion="off"` when the reader asked for reduced motion, and the same drawing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

await import("../public/pipeline-flow.js");
const { fromDefinition, fromBundle, fromWindowModel, marksFor, markup, render } = globalThis.PipelineFlow;

const SEED_DEFS = JSON.parse(readFileSync(new URL("../pipelines.seed.json", import.meta.url), "utf8")).pipelines;
const SEED_BUNDLE = JSON.parse(readFileSync(new URL("../pipeline-bundle.seed.json", import.meta.url), "utf8"));

const flowOf = (html) => {
  const nodes = [...html.matchAll(/<li class="pflow-node" data-stage="([^"]*)" data-pos="(\d+)" data-mark="([^"]*)"/g)].map((m) => ({
    id: m[1],
    pos: Number(m[2]),
    mark: m[3],
  }));
  const arcs = [...html.matchAll(/<div class="pflow-arc" data-loop="([^"]*)" data-from="([^"]*)" data-to="([^"]*)" data-cap="([^"]*)"/g)].map((m) => ({
    id: m[1],
    from: m[2],
    to: m[3],
    cap: m[4],
  }));
  const labels = [...html.matchAll(/<span class="pflow-arc-label mono" title="[^"]*">([^<]*)<\/span>/g)].map((m) => m[1]);
  const notches = [...html.matchAll(/data-gate="([^"]*)" data-gate-name="([^"]*)"/g)].map((m) => ({ id: m[1], name: m[2] }));
  return { nodes, arcs, labels, notches };
};

test("a bundle pipeline reads left to right, every stage in the document's own order", () => {
  const flow = fromBundle(SEED_BUNDLE);
  assert.equal(flow.stages.length, 13);
  const html = markup(flow, null);
  const { nodes } = flowOf(html);
  assert.deepEqual(
    nodes.map((n) => n.id),
    SEED_BUNDLE.stages.map((s) => s.id),
    "the drawing's order is the document's order",
  );
  assert.deepEqual(nodes.map((n) => n.pos), nodes.map((_, i) => i + 1), "positions ascend 1..n");
});

test("every gate is a notch on the connector after its stage, and the last stage's gate sits on the closing edge", () => {
  const flow = fromBundle(SEED_BUNDLE);
  const { notches } = flowOf(markup(flow, null));
  assert.deepEqual(
    notches.map((n) => n.id),
    SEED_BUNDLE.gates.map((g) => g.id),
    "one notch per gate, in document order",
  );
  assert.deepEqual(
    notches.map((n) => n.name),
    SEED_BUNDLE.gates.map((g) => g.name),
    "the notch carries the gate's name (a tooltip, not a label on the strip)",
  );
  const afterLast = flow.stages.find((s) => s.id === SEED_BUNDLE.stages[SEED_BUNDLE.stages.length - 1].id);
  assert.ok(afterLast.gate && afterLast.gate.id === "G4", "the gate after the final stage is carried, not dropped");
  // The last gate is a notch ON the track's closing edge — no stub hanging off the last column. The stub was 18 px at
  // `left: 100%`: it widened the drawing past its own track (scrollWidth 1109 vs clientWidth 1094 at seven stages) and
  // put the one notch it labelled outside the scroller, so a reader saw no notch at all after the last stage.
  const html = markup(flow, null);
  assert.doesNotMatch(html, /pflow-link is-end/, "nothing is drawn past the last column");
  const styles = [...html.matchAll(/<span class="pflow-notch"[^>]*style="left:([^;]*);/g)].map((m) => m[1]);
  assert.equal(styles[styles.length - 1], "calc(100% - 1.5px)", "and the closing gate's notch ends at the column's right edge");
  assert.ok(
    styles.slice(0, -1).every((s) => s === "calc(100% + var(--pflow-gap) / 2)"),
    "every other notch still sits at the middle of its gap",
  );
});

test("a capped loop is one arc, labelled only with its cap", () => {
  const flow = fromBundle(SEED_BUNDLE);
  const html = markup(flow, null);
  const { arcs, labels } = flowOf(html);
  const loops = SEED_BUNDLE.handoffs.filter((h) => h.kind === "loop");
  assert.equal(arcs.length, loops.length, "one arc per loop handoff");
  assert.deepEqual(
    arcs.map((a) => [a.from, a.to]),
    loops.map((h) => [h.from, h.to]),
    "each arc joins the stages its handoff names",
  );
  assert.deepEqual(labels, loops.map((h) => h.cap), "the label is the cap and nothing else");
  const arcsOnly = html.slice(html.indexOf('class="pflow-arc"'), html.indexOf('class="pflow-track"'));
  for (const h of loops) assert.ok(!arcsOnly.includes(`>${h.id}<`), `the handoff id ${h.id} is a data attribute, not a word`);
  // The layer's ATTRIBUTES name the ends (data-from/data-to are what a reader of the DOM reads); what must not carry a
  // stage id is the painted text, so strip every attribute before looking for one.
  const painted = arcsOnly.replace(/[a-z-]+="[^"]*"/gi, "");
  assert.doesNotMatch(painted, /S\d+/, "no stage id is painted onto the arcs layer");
  assert.doesNotMatch(painted, /Charter|UAT sign-off/, "no stage title is painted onto the arcs layer");
});

test("two loops that meet on one stage take different lanes, and the drawing reserves exactly their room", () => {
  const flow = fromBundle(SEED_BUNDLE);
  const html = markup(flow, null);
  const lanes = [...html.matchAll(/--pflow-lane:(\d+)/g)].map((m) => Number(m[1]));
  // H-10 (S9 -> S8) and H-12 (S10 -> S9) share S9, so they cannot be on one lane; H-15 (S12 -> S11) is clear of both.
  assert.deepEqual(lanes, [0, 1, 0], `lanes: ${lanes.join(",")}`);
  const pad = Number(/--pflow-pad:(\d+)px/.exec(html)[1]);
  assert.ok(pad >= 2 * 22, `the pad leaves room for two lanes of arc and label (got ${pad}px)`);
});

test("the four marks: before the current stage is done, the stage is current, after it is not reached", () => {
  const flow = fromBundle(SEED_BUNDLE);
  const marks = marksFor(flow.stages, { stage: "S4" });
  assert.equal(marks.filter((m) => m.mark === "done").length, 4, "S0..S3 are done");
  assert.equal(marks.filter((m) => m.mark === "current").length, 1, "one stage is current");
  assert.equal(marks.find((m) => m.mark === "current").id, "S4");
  assert.equal(marks.filter((m) => m.mark === "not-reached").length, 8, "S5..S12 are not reached");
  assert.equal(marks.filter((m) => m.mark === "refused").length, 0, "nothing is refused unless the position says so");
});

test("a refused position marks that stage refused, and the refused mark wins for its own stage", () => {
  const flow = fromBundle(SEED_BUNDLE);
  const marks = marksFor(flow.stages, { stage: "S6", refused: "S3" });
  assert.equal(marks.filter((m) => m.mark === "refused").length, 1);
  assert.equal(marks.find((m) => m.mark === "refused").id, "S3");
  assert.equal(marks.filter((m) => m.mark === "current").length, 1);
  assert.equal(marks.find((m) => m.mark === "current").id, "S6");
  assert.equal(marks.filter((m) => m.mark === "done").length, 5, "every stage before the current one is done, except the refused one");
  const html = markup(flow, { stage: "S6", refused: "S3" });
  assert.match(html, /data-mark="refused"/);
  assert.equal(flowOf(html).nodes.filter((n) => n.mark === "refused").length, 1);
});

test("no position at all is every stage not reached — a definition has no place in it", () => {
  const flow = fromDefinition(SEED_DEFS.find((p) => p.id === "local"));
  const marks = marksFor(flow.stages, null);
  assert.deepEqual(
    marks.map((m) => m.mark),
    ["not-reached"],
    "one stage, not reached: nothing has been entered",
  );
  assert.match(markup(flow, null), /data-mark="not-reached"/);
});

test("a definition's exit check is the notch after its stage", () => {
  const local = SEED_DEFS.find((p) => p.id === "local");
  const flow = fromDefinition(local);
  assert.equal(flow.stages.length, local.stages.length);
  assert.equal(flow.loops.length, 0, "a definition has no loop; its `next` is another pipeline");
  const { notches } = flowOf(markup(flow, null));
  assert.deepEqual(
    notches.map((n) => n.name),
    local.stages.map((s) => s.exit.check),
    "the closed vocabulary's check name is the notch",
  );
  assert.match(notches[0].id, /^exit:/, "a definition's notch is named as an exit, not as a bundle gate");
});

test("the task window's model draws the same sequence when no bundle is available", () => {
  const stages = ["S0", "S1", "S2"].map((id) => ({
    id,
    title: `stage ${id}`,
    position: Number(id.slice(1)) + 1,
    phase: "before",
    gateEnding: id === "S0" ? { id: "G0", name: "Charter", after: "S0", artifact: "charter", decider: "user", decision: null } : null,
    handoffOut: id === "S2" ? { id: "H-9", from: "S2", to: "S0", artifact: "v", kind: "loop", cap: "2 rounds" } : null,
  }));
  const flow = fromWindowModel({ pipeline: { id: "p", title: "P" }, stages, count: 3 });
  const html = markup(flow, { stage: "S1" });
  const { nodes, arcs, labels } = flowOf(html);
  assert.deepEqual(nodes.map((n) => `${n.id}:${n.mark}`), ["S0:done", "S1:current", "S2:not-reached"]);
  assert.deepEqual(arcs.map((a) => [a.from, a.to]), [["S2", "S0"]]);
  assert.deepEqual(labels, ["2 rounds"]);
});

test("reduced motion is a data attribute and the drawing does not change with it", () => {
  const flow = fromBundle(SEED_BUNDLE);
  const on = markup(flow, { stage: "S4" }, { motion: true });
  const off = markup(flow, { stage: "S4" }, { motion: false });
  assert.match(on, /data-motion="on"/);
  assert.match(off, /data-motion="off"/);
  assert.equal(off.replace('data-motion="off"', 'data-motion="on"'), on, "motion changes nothing about the marks");
});

test("render() needs a page: with no document it returns null instead of throwing", () => {
  assert.equal(typeof globalThis.document, "undefined");
  assert.equal(render(fromBundle(SEED_BUNDLE), null), null);
});
