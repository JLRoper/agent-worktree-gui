// The two halves of "the drawing tells the truth", pinned against the REAL seed and the REAL renderer.
//
// Stage 3 changes two files and this file is what holds them to their word:
//
//   lib/task-pipeline-drive.js  which edge a stage leaves by (the rail, not the first handoff in the document), what a
//                               cap sentence reads as ("3 rounds" is 3; "2 of 3 rounds" is a label, not a bound), and
//                               what the last stage's gate is (named in the answer, never a barrier).
//   public/pipeline-flow.js     an arc that ends on the centres of the two columns it joins — gaps included, which is
//                               the 26 px per column it used to drop — marks that read the RECORD when the position
//                               carries one, and a notch that carries its own state and a name outside `aria-hidden`.
//
// The seed is the fixture because the brief is about it: 13 stages, 5 gates, 3 one-column loops, and an S9 with BOTH a
// loop (H-10 → S8) and a sequence edge (H-11 → S10). Read the two behaviours side by side and the point is visible:
// the driver now walks to S12, and an arc laid by the old width lands 26 px short of the stage it names.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseBundle } from "../lib/pipeline-bundle.js";
import { capOf, nextStageOf } from "../lib/task-pipeline-drive.js";

await import("../public/pipeline-flow.js");
const { fromBundle, fromWindowModel, marksFor, markup } = globalThis.PipelineFlow;

const SEED_DOC = JSON.parse(readFileSync(new URL("../pipeline-bundle.seed.json", import.meta.url), "utf8"));
const SEED = parseBundle(SEED_DOC, { file: "pipeline-bundle.seed.json" });
assert.equal(SEED.ok, true, SEED.reason || "the shipped seed must parse");
const SEED_PIPELINE = SEED.bundle.pipelines[0];

// ---------------------------------------------------------------------------------------------------------------------
// 1. the driver walks the graph the drawing draws
// ---------------------------------------------------------------------------------------------------------------------

// One walk from a stage to the end, counting the crossings it takes — the same arithmetic driveTaskPipelines keeps on
// the record, so a loop is bounded here exactly as it is there.
function walk(pipeline, from, steps = 40) {
  const crossings = {};
  const hops = [];
  let stage = from;
  for (let step = 0; step < steps; step += 1) {
    const answer = nextStageOf(pipeline, { stage, crossings });
    if (!answer.ok) return { hops, stopped: answer, stage };
    if (answer.done) return { hops, done: answer, stage };
    if (answer.handoff && answer.handoff.kind === "loop") crossings[answer.handoff.id] = (crossings[answer.handoff.id] || 0) + 1;
    hops.push({ from: stage, to: answer.stage.id, edge: answer.handoff ? answer.handoff.id : null });
    stage = answer.stage.id;
  }
  throw new Error(`the walk from ${from} did not settle in ${steps} steps`);
}

test("the seed's S9 takes its sequence edge, so S10..S12 are reachable at all", () => {
  // The defect this replaces: `handoffs.find((h) => h.from === stageId)` took H-10 (the loop) every time, so the row
  // oscillated S8↔S9 until its cap and the last three stages of the seed were unreachable.
  const answer = nextStageOf(SEED_PIPELINE, { stage: "S9" });
  assert.equal(answer.ok, true);
  assert.equal(answer.stage.id, "S10", "the rail wins over the loop");
  assert.equal(answer.handoff.id, "H-11");
});

test("a walk of the seed names every edge it takes, from S0 to the last stage", () => {
  const walked = walk(SEED_PIPELINE, "S0");
  assert.deepEqual(
    walked.hops.map((hop) => `${hop.from}->${hop.to} ${hop.edge}`),
    [
      "S0->S1 H-01",
      "S1->S2 H-02",
      "S2->S3 H-03",
      "S3->S4 H-04",
      "S4->S5 H-05",
      "S5->S6 H-06",
      "S6->S7 H-07",
      "S7->S8 H-08",
      "S8->S9 H-09",
      "S9->S10 H-11",
      "S10->S11 H-13",
      "S11->S12 H-14",
      // S12 draws no sequence edge: its ONLY way on is the capped re-delivery loop, which is taken until its cap.
      "S12->S11 H-15",
      "S11->S12 H-14",
      "S12->S11 H-15",
      // The third crossing is refused at the cap; the row parks where it settled.
      "S11->S12 H-14",
    ],
    "the rail is walked, and the loop is walked only where it is the only way out",
  );
  // The cap is what stops the tail: a third crossing of H-15 is past "2 re-deliveries", and the row parks there.
  assert.equal(walked.stopped.code, "pipeline-cap");
  assert.equal(walked.stopped.handoff.id, "H-15");
  assert.equal(walked.stopped.used, 2);
  assert.equal(walked.stopped.limit, 2);
  assert.match(walked.stopped.reason, /at its cap of 2 rounds/);
});

test("a stage whose only edge is a loop still takes it — the bounded retry is a shape, not a bug", () => {
  const looped = parseBundle(
    {
      bundleVersion: 1,
      name: "retry",
      pipelines: [
        {
          id: "retry",
          title: "Retry",
          stages: [
            { id: "S1", title: "One", prompt: "one", artifact: { id: "a1", path: "a1", schema: "a/1", writer: "w" } },
            { id: "S2", title: "Two", prompt: "two", artifact: { id: "a2", path: "a2", schema: "a/1", writer: "w" } },
          ],
          gates: [],
          handoffs: [{ id: "back", from: "S2", to: "S1", artifact: "a2", kind: "loop", cap: "2 rounds" }],
        },
      ],
    },
    { file: "retry.json" },
  );
  assert.equal(looped.ok, true, looped.reason);
  const answer = nextStageOf(looped.bundle.pipelines[0], { stage: "S2" });
  assert.equal(answer.ok, true);
  assert.equal(answer.stage.id, "S1");
  assert.equal(answer.handoff.id, "back");
});

test("the cap is the whole number that opens the sentence, and a progress label is refused", () => {
  assert.deepEqual([capOf({ cap: "3 rounds (P-50)" }).limit, capOf({ cap: "2 re-deliveries" }).limit], [3, 2]);
  assert.equal(capOf({ cap: "P-50, 3 rounds" }).limit, null, "the first digit run in the sentence is not the cap: P-50 is a reference, not fifty rounds");
  const label = capOf({ cap: "2 of 3 rounds" });
  assert.equal(label.limit, null, "the label the drawing prints is not a bound the driver will read back");
  assert.equal(label.why, "progress");
  assert.equal(capOf({ cap: "three rounds" }).limit, null);
  assert.equal(capOf({}).limit, null);
});

test("the last stage's gate is named in the answer and is not a barrier", () => {
  const closed = parseBundle(
    {
      bundleVersion: 1,
      name: "closing",
      pipelines: [
        {
          id: "closing",
          title: "Closing",
          stages: [
            { id: "S1", title: "One", prompt: "one", artifact: { id: "a1", path: "a1", schema: "a/1", writer: "w" } },
            { id: "S2", title: "Two", prompt: "two", artifact: { id: "a2", path: "a2", schema: "a/1", writer: "w" } },
          ],
          gates: [
            {
              id: "G9",
              name: "Sign it off",
              after: "S2",
              artifact: "a2",
              decider: "seat",
              decision: { id: "d9", path: "gates/G9.json", schema: "decision/1", writer: "seat", outcomes: ["CLOSED"] },
            },
          ],
          handoffs: [{ id: "h1", from: "S1", to: "S2", artifact: "a1", kind: "sequence" }],
        },
      ],
    },
    { file: "closing.json" },
  );
  assert.equal(closed.ok, true, closed.reason);
  // No decision record exists in this fixture, and the answer is still `done`: there is no edge for the gate to guard,
  // so parking the row on it would wait for a record that could not change where the row goes.
  const answer = nextStageOf(closed.bundle.pipelines[0], { stage: "S2" });
  assert.equal(answer.ok, true);
  assert.equal(answer.done, true);
  assert.equal(answer.closing.id, "G9", "but the answer names what the run closes on, so the drawing can say so");
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. the marks read the record
// ---------------------------------------------------------------------------------------------------------------------

const marksOf = (html) => [...html.matchAll(/<li class="pflow-node" data-stage="([^"]*)" data-pos="(\d+)" data-mark="([^"]*)"/g)].map((m) => `${m[1]}:${m[3]}`);
const sourceOf = (html) => /data-marks-from="([^"]*)"/.exec(html)[1];

test("a crossed loop marks the stage it left done — the S9 the index rule draws not-reached", () => {
  const flow = fromBundle(SEED_PIPELINE);
  // Without the record: the fallback, and the drawing admits which rule it used.
  const guessed = markup(flow, { stage: "S8" });
  assert.equal(marksOf(guessed)[9], "S9:not-reached", "the index rule cannot know S9 sent the task back");
  assert.equal(sourceOf(guessed), "index");

  // With it: H-10 was crossed, so both of its ends ran, and the drawing says so.
  const read = markup(flow, { stage: "S8", crossings: { "H-10": 1 } });
  assert.equal(marksOf(read)[8], "S8:current");
  assert.equal(marksOf(read)[9], "S9:done", "the loop's own evidence puts S9 behind the row");
  assert.equal(marksOf(read)[10], "S10:not-reached", "and nothing past the loop's far end is claimed to have run");
  assert.equal(sourceOf(read), "record");
});

test("`ran` is the record's list even when it disagrees with the index, and `via` proves its own from-stage", () => {
  const stages = ["S0", "S1", "S2"].map((id) => ({ id, title: id }));
  assert.deepEqual(
    marksFor(stages, { stage: "S1", ran: ["S1"] }).map((m) => m.mark),
    ["not-reached", "current", "not-reached"],
    "a record that names only what ran is read as written — not as 'everything before this point'",
  );
  const loop = { id: "h9", from: "S2", to: "S0" };
  assert.deepEqual(
    marksFor(stages, { stage: "S2", via: "h9" }, [loop]).map((m) => m.mark),
    ["not-reached", "not-reached", "current"],
    "the edge the row arrived by proves its from-stage ran — and only that",
  );
  assert.deepEqual(
    marksFor(stages, { stage: "S0", crossings: { h9: 1 } }, [loop]).map((m) => m.mark),
    ["current", "done", "done"],
    "a crossed loop proves every stage between its ends ran",
  );
});

test("the current stage is marked for a screen reader, not only for the palette", () => {
  const html = markup(fromBundle(SEED_PIPELINE), { stage: "S4" });
  assert.equal((html.match(/aria-current="step"/g) || []).length, 1);
  assert.match(html, /data-stage="S4"[^>]*aria-current="step"/);
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. the arc ends where the stage is
// ---------------------------------------------------------------------------------------------------------------------

// The geometry as the DOM carries it: two numbers per end, `col` columns and `gap` gaps of the track's own grid.
const arcsOf = (html) =>
  [...html.matchAll(/<div class="pflow-arc" data-loop="([^"]*)"[^>]*style="([^"]*)"/g)].map(([, id, style]) => {
    const i = Number(/--pflow-i:(\d+)/.exec(style)[1]);
    const j = Number(/--pflow-j:(\d+)/.exec(style)[1]);
    const read = (name) => {
      const m = new RegExp(
        `${name}:calc\\(\\(100% - (\\d+) \\* var\\(--pflow-gap\\)\\) / (\\d+) \\* ([\\d.]+)(?: \\+ (\\d+) \\* var\\(--pflow-gap\\))?\\)`,
      ).exec(style);
      assert.ok(m, `${name} is a calc over the track's own grid: ${style}`);
      return { minusGaps: Number(m[1]), count: Number(m[2]), col: Number(m[3]), gap: m[4] ? Number(m[4]) : 0 };
    };
    return { id, i, j, left: read("left"), width: read("width") };
  });

test("every arc runs centre to centre, and the gaps it crosses are part of its width", () => {
  const arcs = arcsOf(markup(fromBundle(SEED_PIPELINE), null));
  assert.equal(arcs.length, 3);
  for (const arc of arcs) {
    assert.equal(arc.left.count, 13, "the arc is measured against the same 13 columns the track draws");
    assert.equal(arc.left.col + arc.width.col, arc.j + 0.5, `${arc.id}: the right edge is the far column's centre, in columns`);
    assert.equal(arc.left.gap + arc.width.gap, arc.j, `${arc.id}: …and in gaps — the old width dropped every one of them`);
  }
});

test("a four-column loop ends on the fourth column, not a whole column short", () => {
  const five = fromBundle({
    id: "wide",
    title: "Wide",
    stages: ["S0", "S1", "S2", "S3", "S4"].map((id) => ({ id, title: id })),
    gates: [],
    handoffs: [{ id: "h-wide", from: "S4", to: "S0", kind: "loop", cap: "2 rounds" }],
  });
  const [arc] = arcsOf(markup(five, null));
  // The seed's own numbers: 78 px columns, 26 px gaps.
  const colW = 78;
  const gap = 26;
  const px = (point) => colW * point.col + gap * point.gap;
  const centre = (index) => colW * (index + 0.5) + gap * index;
  assert.equal(px(arc.left), centre(0), "the arc leaves the centre of the column it re-enters");
  assert.equal(px(arc.left) + px(arc.width), centre(4), "and lands on the centre of the column it leaves");
  assert.equal(px(arc.width), 4 * colW + 4 * gap, "four columns AND the four gaps between them — the 104 px the old formula dropped");
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. the gate is an object: its own state, and a name nobody hides
// ---------------------------------------------------------------------------------------------------------------------

const GATED = fromBundle({
  id: "gated",
  title: "Gated",
  stages: ["S0", "S1", "S2"].map((id) => ({ id, title: `stage ${id}` })),
  gates: [
    { id: "g0", name: "the first", after: "S0", decision: { path: "decisions/0.json", outcomes: ["go", "no"] } },
    { id: "g2", name: "the last", after: "S2", decision: { path: "decisions/2.json", outcomes: ["go", "no"] } },
  ],
  handoffs: [],
});

const notchesOf = (html) => [...html.matchAll(/<span class="pflow-notch"[^>]*>/g)].map((m) => m[0]);
const stateOf = (html, gate) => {
  const notch = notchesOf(html).find((n) => n.includes(`data-gate="${gate}"`));
  assert.ok(notch, `the ${gate} notch is drawn`);
  return notch;
};

test("the notch sits BESIDE the hidden connector, and carries a state and a name of its own", () => {
  const html = markup(GATED, { stage: "S0" });
  assert.ok(html.includes('<span class="pflow-link" aria-hidden="true"></span><span class="pflow-notch"'), "the connector stays decorative; the notch is not inside it");
  const first = stateOf(html, "g0");
  assert.match(first, /data-gate="g0" data-gate-name="the first" data-state="ahead"/);
  assert.match(first, /aria-label="gate g0 · the first — after stage S0 — decides decisions\/0\.json; not yet crossed"/);
  assert.doesNotMatch(first, /aria-hidden/);
});

test("the four record states, and the closing check the driver never waits on", () => {
  assert.equal(/data-state="([^"]*)"/.exec(stateOf(markup(GATED, { stage: "S0" }), "g0"))[1], "ahead", "the row has not been drawn past it");
  assert.equal(
    /data-state="([^"]*)"/.exec(stateOf(markup(GATED, { stage: "S1" }), "g0"))[1],
    "answered",
    "the row is past the stage, so the driver found the record and crossed",
  );
  const waiting = stateOf(markup(GATED, { stage: "S0", waitingFor: { gate: "g0", path: "decisions/0.json", since: "2026-11-04T14:20:00.000Z" } }), "g0");
  assert.match(waiting, /data-state="waiting"/);
  assert.match(waiting, /waiting on decisions\/0\.json since 2026-11-04T14:20:00\.000Z/, "the wait, with the path and the stamp, is the name");
  const closing = stateOf(markup(GATED, { stage: "S0" }), "g2");
  assert.match(closing, /data-state="closing"/, "after the last stage the gate is a closing check, not a barrier");
  assert.match(closing, /the panel does not wait on this gate/);
  // A gate that declares no record is open, whatever the position: there is nothing to wait on.
  const seedGate = stateOf(markup(fromBundle(SEED_PIPELINE), { stage: "S0" }), "G2");
  assert.match(seedGate, /data-state="open"/);
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. the cap on the arc prints from fields, never from a re-parse
// ---------------------------------------------------------------------------------------------------------------------

const windowModel = (loops) => ({
  pipeline: { id: "w", title: "Windowed" },
  stages: ["S0", "S1", "S2"].map((id) => ({ id, title: id, position: Number(id.slice(1)) + 1, phase: "after", gateEnding: null, handoffOut: null })),
  count: 3,
  loops,
});

const WINDOWED = fromWindowModel(windowModel([{ id: "h9", from: "S2", to: "S0", cap: "3 rounds", limit: 3, used: 1 }]));

const arcLabel = (html) => /<span class="pflow-arc-label mono" title="[^"]*">([^<]*)<\/span>/.exec(html)[1];

test("the window model's own limit and count are what the arc prints", () => {
  const html = markup(WINDOWED, { stage: "S1" });
  assert.equal(arcLabel(html), "1 of 3", "used of limit, from the fields — not '3 rounds' read backwards");
  const [arc] = arcsOf(html);
  assert.equal(arc.id, "h9");
  assert.match(html, /data-used="1"/);
  assert.match(html, /data-limit="3"/);
  assert.doesNotMatch(html, /data-spent/);
});

test("a loop at its limit says so, and an unknown count is not invented as zero", () => {
  const spent = markup(fromWindowModel(windowModel([{ id: "h9", from: "S2", to: "S0", cap: "3 rounds", limit: 3, used: 3 }])), { stage: "S1" });
  assert.equal(arcLabel(spent), "3 of 3");
  assert.match(spent, /data-spent="1"/);
  // No limit known: the studio's sentence, and no `n of m` the drawing cannot count.
  const capped = markup(fromBundle(SEED_PIPELINE), { stage: "S0" });
  assert.equal(arcLabel(capped), "3 rounds (P-50)");
  assert.doesNotMatch(capped, /data-used/);
});
