// The pipeline FLOW renderer (public/pipeline-flow.js): a definition, a bundle pipeline or a task window's model
// drawn as one left-to-right sequence.
//
// This is the pure half of the pipeline modal and it is driven against the REAL documents: pipeline-bundle.seed.json
// read from disk, so a shape the loader produces is what the renderer is asked to draw, and the ladder definitions in
// test/fixtures/ladder-definitions.mjs, which are the shapes a reader's own pipelines.json may still hold now that the
// ladder seed ships none.
// What this pins:
//
//   - the sequence reads left to right, one column per stage in the order the document holds;
//   - every gate is a NOTCH on the closing edge of the stage it ends, drawn inside that stage's own box (no inline
//     position, nothing hung in the gap), so the gate that ends the last stage is on the track's closing edge too;
//   - a capped loop is ONE arc above the track, labelled with its cap and nothing else: no handoff id, no stage id
//     and no stage title reaches the drawing, and two loops that meet on a stage are on different lanes;
//   - the four marks — not reached, current, done, refused — are `data-mark` on the stage, and the legend counts them;
//   - a definition's exit check is its notch (a definition has gates, not a bundle's gates), and a definition has no
//     position, so every stage is drawn not reached;
//   - motion is a data attribute: `data-motion="off"` when the reader asked for reduced motion, and the same drawing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { LADDER_DEFINITIONS } from "./fixtures/ladder-definitions.mjs";

await import("../public/pipeline-flow.js");
const { fromDefinition, fromBundle, fromWindowModel, marksFor, markup, render } = globalThis.PipelineFlow;

// The ladder shapes a reader's own pipelines.json may still hold: the seed ships none, so the renderer's definition
// half is driven against the fixture rather than a file that no longer carries a definition.
const SEED_DEFS = LADDER_DEFINITIONS;
// The shipped seed is the panel's multi-pipeline wrapper now; the 13-stage studio export is its `poc-to-uat` entry.
const SEED_DOC = JSON.parse(readFileSync(new URL("../pipeline-bundle.seed.json", import.meta.url), "utf8"));
const SEED_BUNDLE = SEED_DOC.pipelines.find((p) => (p.id || (p.project && p.project.id)) === "poc-to-uat");
assert.ok(SEED_BUNDLE, "the shipped seed must hold the poc-to-uat pipeline");

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

test("every gate is a notch on the closing edge of the stage it ends, drawn inside that stage's own box", () => {
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
  // The notch is placed by the STYLESHEET, inside the tile it belongs to, and carries no inline geometry: a notch
  // hung in the gap after its stage is in the one band of the drawing no element owns, so a scroller or a card edge
  // can slice it - and the wrapped shape had to re-aim it in script for a row's last tile. Inside the tile it needs
  // no measurement at all. The 18 px stub that used to sit past the last column widened the drawing past its own
  // track (scrollWidth 1109 against clientWidth 1094 at seven stages), so nothing hangs past the last column either.
  const html = markup(flow, null);
  assert.doesNotMatch(html, /pflow-link is-end/, "nothing is drawn past the last column");
  assert.doesNotMatch(html, /class="pflow-notch"[^>]*style=/, "a notch carries no inline position");
  const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8").replaceAll(String.fromCharCode(13), "");
  const rule = /\.pflow-notch \{ ([^}]*)\}/.exec(css)?.[1] || "";
  assert.match(rule, /left: 100%/, "the notch starts at the column's own trailing edge");
  assert.match(rule, /margin-left: -3px/, "and is pulled back by its own width, so its whole box is inside the column");
  assert.match(rule, /width: 3px; height: 15px;/, "a 3 px bar");
  assert.doesNotMatch(rule, /calc\(100% \+/, "nothing places a notch out in the gap");
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

test("the count says how many stages AND how many notches are out, and what run of stages is showing", () => {
  const { countText } = globalThis.PipelineFlow;
  const view = (stagesOut, notchesOut, first = null, last = null, totals = [13, 13]) => ({
    stages: { total: totals[0], out: stagesOut, left: 0, right: stagesOut },
    notches: { total: totals[1], out: notchesOut, left: 0, right: notchesOut },
    first,
    last,
  });
  assert.equal(countText({ stages: { total: 13, out: 0 }, notches: { total: 13, out: 0 } }), "all 13 stages and 13 notches in view");
  assert.equal(countText(view(4, 4, 1, 9)), "showing stages 1–9 of 13 — 4 of 13 stages and 4 of 13 notches out of view");
  // scrolled to the far end the totals change too: the last gap's notch is visible even though its stage is not
  assert.equal(countText(view(4, 3, 5, 13)), "showing stages 5–13 of 13 — 4 of 13 stages and 3 of 13 notches out of view");
  // a definition with no gate is a stage count alone; the singular reads as one, not "1 stages"
  assert.equal(countText(view(1, 0, 1, 3, [4, 0])), "showing stages 1–3 of 4 — 1 of 4 stages out of view");
  assert.equal(countText({ stages: { total: 1, out: 0 }, notches: { total: 1, out: 0 } }), "all 1 stage and 1 notch in view");
  assert.equal(countText({ stages: { total: 0, out: 0 }, notches: { total: 0, out: 0 } }), "no stage is drawn");
  // nothing to measure, nothing to claim: the function refuses rather than inventing a count
  assert.equal(globalThis.PipelineFlow.viewCount(null), null);
});

test("markup carries the count and the fit control, and `fit` changes only the root's attribute and the label", () => {
  const flow = fromBundle(SEED_BUNDLE);
  const off = markup(flow, null);
  const on = markup(flow, null, { fit: true });
  assert.match(off, /data-fit="0"/, "the default is the readable column width");
  assert.match(on, /data-fit="1"/, "the fitted render is a data attribute, so the stylesheet owns the widths");
  assert.match(off, /<div class="pflow-status" data-pflow-status hidden>/, "the row starts hidden: the measurement unhides it");
  assert.match(off, /<span class="pflow-count" id="pflow-count-[^"]*" data-pflow-count><\/span>/);
  assert.match(off, /<div class="pflow-scroll" aria-describedby="pflow-count-[^"]*">/, "the scroller names the count as its description");
  assert.match(off, /<button type="button" class="pflow-fit" data-pflow-fit title="[^"]*">fit<\/button>/);
  assert.match(on, /<button type="button" class="pflow-fit" data-pflow-fit title="[^"]*">actual size<\/button>/);
  // The fitted drawing is the SAME drawing: every stage, every mark and every notch survives the narrower columns.
  const a = flowOf(off);
  const b = flowOf(on);
  assert.equal(a.nodes.length, SEED_BUNDLE.stages.length);
  assert.deepEqual(b.nodes, a.nodes, "the fitted markup carries the same stages, positions and marks");
  assert.deepEqual(b.notches, a.notches, "and the same gate notches");
});

test("the legend lists only the states this drawing actually shows, and counts them in stages", () => {
  const keys = (html) => {
    const legend = (html.match(/<div class="pflow-legend"[\s\S]*?<\/div>/) || [""])[0];
    return [...legend.matchAll(/data-mark="([^"]+)"><i aria-hidden="true"><\/i>([^<]*)<b class="mono">(\d+) (stage|stages)<\/b>/g)].map((m) => ({
      mark: m[1],
      text: m[2].trim(),
      count: Number(m[3]),
      noun: m[4],
    }));
  };
  // A definition has no position: one state, said once — not four keys the reader cannot find on the picture.
  const def = fromDefinition(SEED_DEFS.find((p) => p.id === "local"));
  assert.deepEqual(keys(markup(def, null)), [{ mark: "not-reached", text: "not reached", count: 1, noun: "stage" }]);
  const thirteen = fromDefinition(SEED_DEFS.find((p) => p.id === "sefl-review-loop"));
  assert.deepEqual(
    keys(markup(thirteen, null)).map((k) => k.mark),
    ["not-reached"],
    "seven not-reached stages are still one state in the legend",
  );
  // A live row shows the marks it carries, and the counts are the number of stages carrying each one.
  const row = fromBundle(SEED_BUNDLE);
  const liveHtml = markup(row, { stage: "S6" });
  const live = keys(liveHtml);
  const drawn = flowOf(liveHtml).nodes;
  assert.deepEqual(live.map((k) => k.mark).sort(), [...new Set(drawn.map((n) => n.mark))].sort(), "one key per state on screen, and no other");
  assert.ok(!live.some((k) => k.mark === "refused"), "no gate refused on this row, so the legend offers no refusal key");
  for (const k of live) assert.equal(k.count, drawn.filter((n) => n.mark === k.mark).length, `${k.mark} is counted from the drawing`);
  // Every key is a PHRASE WITH ITS NOUN — "3 stages", never a bare numeral — so the reader is never left to infer what
  // the number counts. One stage is singular; the noun follows the number it belongs to.
  for (const k of [...keys(markup(def, null)), ...live]) {
    assert.equal(k.noun, k.count === 1 ? "stage" : "stages", `${k.mark}: ${k.count} ${k.noun}`);
    assert.ok(k.text && /\p{L}/u.test(k.text), `${k.mark} names the state in words`);
  }
  // A refused preview is the only producer of the fourth state, and it appears only there.
  const refused = keys(markup(row, { stage: "S6", refused: "S3" })).map((k) => k.mark);
  assert.ok(refused.includes("refused"), "a refusal on screen gets its key");
  assert.ok(!keys(markup(fromDefinition({ id: "none", title: "none", stages: [] }), null)).length, "no stages, no legend to explain");
});

test("render() needs a page: with no document it returns null instead of throwing", () => {
  assert.equal(typeof globalThis.document, "undefined");
  assert.equal(render(fromBundle(SEED_BUNDLE), null), null);
  assert.equal(render(fromBundle(SEED_BUNDLE), null, { fit: true }), null);
});
