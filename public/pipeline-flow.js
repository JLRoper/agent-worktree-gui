// The pipeline FLOW: one definition or one live task drawn as a left-to-right sequence of stages.
//
// This file is the renderer half of the pipeline modal and it is deliberately DATA IN, MARKUP OUT: it reads the
// shapes the panel already has and returns a string (`markup`) or an element (`render`), and it touches no other
// piece of the page. Everything it knows comes from one of the three adapters below:
//
//   fromDefinition(def)   a catalogue definition (pipelines.json over pipelines.seed.json, lib/pipelines.js). Its
//                         stages end on an `exit.check` — that check IS the notch on the connector after the stage,
//                         because it is what ends the stage. A definition has no loop: its chain is `next`, another
//                         pipeline, and the modal prints that as a fact instead of drawing it.
//   fromBundle(pipeline)  a bundle pipeline (lib/pipeline-bundle.js): stages in order, `gates[]` following the stage
//                         they close (`after`), and `handoffs[]` — of which `kind: "loop"` is drawn as an arc back.
//   fromWindowModel(model) the task pipeline window's answer (lib/pipeline-window.js) for one queue row: the same
//                         stages with `gateEnding` and `handoffOut`, which is enough for the same drawing without a
//                         second read of the bundle.
//
// The drawing has four marks and no fifth, carried as `data-mark` on every stage so a test and a stylesheet read the
// same thing: `not-reached`, `current`, `done`, `refused`. A position is `{stage, refused}`; a null position (the
// catalogue's edit mode) marks every stage `not-reached`, because nothing has been entered yet.
//
// A capped loop is an ARC back to the stage it re-enters, labelled ONLY with its cap: "3 rounds (P-50)" is the whole
// statement the drawing makes about it. The handoff's id, its artifact and the stage ids are data attributes, never
// words on the picture — a cap is the one number a reader needs to know the loop ends.
(function (global) {
  "use strict";

  const MARK = Object.freeze({
    NOT_REACHED: "not-reached",
    CURRENT: "current",
    DONE: "done",
    REFUSED: "refused",
  });
  const MARK_ORDER = [MARK.NOT_REACHED, MARK.CURRENT, MARK.DONE, MARK.REFUSED];
  const MARK_WORDS = Object.freeze({
    "not-reached": "not reached",
    current: "current",
    done: "done",
    refused: "refused",
  });

  const text = (value) => String(value ?? "").trim();
  const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

  const esc = (value) =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  // ---- the three adapters -----------------------------------------------------------------------------------------
  // One normalised shape is what the drawing reads:
  //   { id, title, kind, stages: [{id, title, gate, artifact}], loops: [{from, to, cap, id, artifact}] }
  // A gate is `{id, name, title, artifact, decider, decision}` — `decision` null for a definition's exit check, which
  // has parameters rather than a decision artifact.
  function exitGate(stage) {
    const exit = isObject(stage) && isObject(stage.exit) ? stage.exit : null;
    const check = text(exit && exit.check);
    if (!check) return null;
    const params = Object.entries(exit).filter(([key]) => key !== "check");
    const said = params.length ? params.map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : String(value)}`).join(" ") : "no parameters";
    return { id: `exit:${text(stage.id)}`, name: check, title: `exit check ${check} — ${said}`, artifact: null, decider: null, decision: null };
  }

  function bundleGate(gate) {
    if (!isObject(gate)) return null;
    const decision = isObject(gate.decision)
      ? { path: text(gate.decision.path), outcomes: Array.isArray(gate.decision.outcomes) ? gate.decision.outcomes.map(text).filter(Boolean) : [] }
      : null;
    return {
      id: text(gate.id) || null,
      name: text(gate.name) || text(gate.id) || "gate",
      title: "",
      artifact: text(gate.artifact) || null,
      decider: text(gate.decider) || null,
      decision,
    };
  }

  function loopsOf(handoffs) {
    // An already-normalised loop carries no `kind` (it was decided when the shape was read); a bundle handoff carries
    // one and only `loop` is drawn. Anything else — a `sequence` or a `return` edge — is a join, not a cap.
    return (Array.isArray(handoffs) ? handoffs : [])
      .filter((h) => isObject(h) && (!h.kind || text(h.kind) === "loop") && text(h.from) && text(h.to))
      .map((h, index) => ({ id: text(h.id) || `loop-${index + 1}`, from: text(h.from), to: text(h.to), cap: text(h.cap), artifact: text(h.artifact) || null }));
  }

  function normalize({ id = "", title = "", kind = "", stages = [], gates = [], loops = [] } = {}) {
    const list = (Array.isArray(stages) ? stages : []).filter(isObject);
    const byAfter = new Map();
    for (const raw of Array.isArray(gates) ? gates : []) {
      if (!isObject(raw) || !text(raw.after)) continue;
      const gate = bundleGate(raw);
      if (gate) byAfter.set(text(raw.after), gate);
    }
    const ids = new Set(list.map((s) => text(s.id)));
    return {
      id: text(id),
      title: text(title),
      kind: text(kind),
      stages: list.map((raw, index) => ({
        id: text(raw.id),
        title: text(raw.title) || text(raw.id) || `stage ${index + 1}`,
        gate: byAfter.get(text(raw.id)) || (isObject(raw.gate) ? raw.gate : null),
        artifact: text(raw.artifact && raw.artifact.id ? raw.artifact.id : raw.artifact) || null,
      })),
      // A loop whose ends are not both stages this pipeline holds is not drawable: it is dropped rather than
      // invented between two neighbours, because an arc between the wrong stages is a claim about the sequence.
      loops: loopsOf(loops).filter((loop) => ids.has(loop.from) && ids.has(loop.to) && loop.from !== loop.to),
    };
  }

  function fromDefinition(def) {
    const d = isObject(def) ? def : {};
    const stages = (Array.isArray(d.stages) ? d.stages : []).map((stage) => ({ id: stage && stage.id, title: stage && stage.title, gate: exitGate(stage) }));
    return normalize({ id: d.id, title: d.title, kind: d.kind, stages, gates: [], loops: [] });
  }

  function fromBundle(pipeline) {
    const p = isObject(pipeline) ? pipeline : {};
    return normalize({
      id: p.id,
      title: p.title,
      kind: p.kind,
      stages: Array.isArray(p.stages)
        ? p.stages.map((stage) => ({ id: stage && stage.id, title: stage && stage.title, artifact: stage && stage.artifact }))
        : [],
      gates: p.gates,
      loops: p.handoffs,
    });
  }

  function fromWindowModel(model) {
    const m = isObject(model) ? model : {};
    const rows = Array.isArray(m.stages) ? m.stages : [];
    return normalize({
      id: m.pipeline && m.pipeline.id,
      title: m.pipeline && m.pipeline.title,
      stages: rows.map((stage) => ({ id: stage && stage.id, title: stage && stage.title, artifact: stage && stage.artifact, gate: stage && stage.gateEnding })),
      gates: [],
      loops: rows.map((stage) => stage && stage.handoffOut).filter(Boolean),
    });
  }

  // ---- the marks --------------------------------------------------------------------------------------------------
  // Four marks, decided by one function so the drawing, the legend and a test cannot disagree. `refused` wins for its
  // own stage (a gate said no there); `stage` is the stage the task is IN; anything before it is done, anything after
  // it is not reached. A position with neither is the catalogue's own drawing and marks every stage not-reached.
  function marksFor(stages, position) {
    const list = Array.isArray(stages) ? stages : [];
    const pos = isObject(position) ? position : {};
    const withoutSlash = (value) => text(value).replace(/^#/, "");
    const current = withoutSlash(pos.stage);
    const refused = withoutSlash(pos.refused);
    const currentIndex = current ? list.findIndex((stage) => text(stage.id) === current) : -1;
    return list.map((stage, index) => {
      const id = text(stage.id);
      if (refused && id === refused) return { id, mark: MARK.REFUSED };
      if (current && id === current) return { id, mark: MARK.CURRENT };
      if (currentIndex >= 0 && index < currentIndex) return { id, mark: MARK.DONE };
      return { id, mark: MARK.NOT_REACHED };
    });
  }

  function positionOf(marks, wanted) {
    return (marks || []).find((m) => m.mark === wanted) || null;
  }

  // ---- the drawing ------------------------------------------------------------------------------------------------
  // One string, built from the normalised shape. Every stage is a COLUMN, so the picture reads left to right and a
  // connector is the gap between two columns; a gate is a notch at the middle of that connector. `--pflow-n` and
  // `--pflow-i` drive the arc geometry in CSS, so no measurement is taken and a resize costs no script.
  function gateTitle(gate) {
    if (!gate) return "";
    const parts = [`gate ${gate.id || "?"}${gate.name ? ` · ${gate.name}` : ""}`];
    if (gate.decision && gate.decision.path) parts.push(`decides ${gate.decision.path}${gate.decision.outcomes.length ? ` (${gate.decision.outcomes.join(", ")})` : ""}`);
    else if (gate.title) parts.push(gate.title);
    if (gate.artifact) parts.push(`on ${gate.artifact}`);
    if (gate.decider) parts.push(`decider ${gate.decider}`);
    return parts.join(" — ");
  }

  function stageHtml(stage, index, count, mark) {
    const last = index === count - 1;
    const gate = stage.gate;
    // A gate after the LAST stage has no next column to reach: it gets a short stub instead, so the gate that ends
    // the whole pipeline (a UAT sign-off) is still a notch on a connector rather than a fact the drawing dropped.
    const link = last
      ? gate
        ? `<span class="pflow-link is-end" aria-hidden="true"><span class="pflow-notch" data-gate="${esc(gate.id || "")}" data-gate-name="${esc(gate.name || "")}" title="${esc(gateTitle(gate))}" aria-label="${esc(`gate after ${stage.title} — the last stage`)}"></span></span>`
        : ""
      : `<span class="pflow-link" aria-hidden="true">${
          gate
            ? `<span class="pflow-notch" data-gate="${esc(gate.id || "")}" data-gate-name="${esc(gate.name || "")}" title="${esc(gateTitle(gate))}" aria-label="${esc(`gate after ${stage.title}`)}"></span>`
            : ""
        }</span>`;
    const artifact = stage.artifact ? `<span class="pflow-art mono" title="the artifact this stage writes">${esc(stage.artifact)}</span>` : "";
    return `<li class="pflow-node" data-stage="${esc(stage.id)}" data-pos="${index + 1}" data-mark="${esc(mark)}"${gate ? ` data-gate="${esc(gate.id || "")}"` : ""} title="${esc(`${index + 1} of ${count} · ${stage.title} · ${MARK_WORDS[mark] || mark}`)}">
        <span class="pflow-dot" aria-hidden="true"></span>
        <span class="pflow-n mono" aria-hidden="true">${index + 1}</span>
        <span class="pflow-title">${esc(stage.title)}</span>
        ${artifact}
        ${link}
      </li>`;
  }

  // The arcs a pipeline can actually draw: both ends are stages it holds, the loop goes BACKWARDS (a "loop" that
  // points forwards is a sequence edge the bundle mislabelled), and each gets a LANE above the track, so two loops
  // over neighbouring stages do not paint over each other. Computed once, because the drawing's padding and its arcs
  // must agree about how many lanes there are.
  const ARC_LANE = 26;
  // The room an arc's own height and its label need above the track. The label sits ABOVE the arc's top border (a
  // long cap over a one-column loop is wider than the arch, and a label painted on the line hides the line).
  const ARC_BASE = 22;

  function layout(flow) {
    const index = new Map(flow.stages.map((stage, i) => [stage.id, i]));
    const lanes = new Map();
    const loops = flow.loops
      .map((loop) => ({ ...loop, fromIndex: index.get(loop.from), toIndex: index.get(loop.to) }))
      .filter((loop) => Number.isInteger(loop.fromIndex) && Number.isInteger(loop.toIndex) && loop.fromIndex > loop.toIndex)
      .sort((a, b) => a.toIndex - b.toIndex || a.fromIndex - b.fromIndex)
      .map((loop) => {
        // Lane 0 is nearest the track. A lane is free only when the loop already on it ENDS before this one begins:
        // two loops that meet on the same stage (S9 re-entered from S10, which re-enters S8) are one chain, and
        // drawing them on one lane would paint two caps on top of each other.
        let lane = 0;
        while (lanes.has(lane) && lanes.get(lane) >= loop.toIndex) lane += 1;
        lanes.set(lane, loop.fromIndex);
        return { ...loop, lane };
      });
    const lanesUsed = loops.length ? Math.max(...loops.map((loop) => loop.lane)) + 1 : 0;
    return { ...flow, drawn: loops, lanes: lanesUsed };
  }

  function arcsHtml(flow) {
    return flow.drawn
      .map(
        (loop) =>
          `<div class="pflow-arc" data-loop="${esc(loop.id)}" data-from="${esc(flow.stages[loop.fromIndex].id)}" data-to="${esc(flow.stages[loop.toIndex].id)}" data-cap="${esc(loop.cap)}" style="--pflow-i:${loop.toIndex};--pflow-j:${loop.fromIndex};--pflow-lane:${loop.lane}">
            <span class="pflow-arc-label mono" title="${esc(`loop ${loop.id}${loop.cap ? ` — ${loop.cap}` : ""}${loop.artifact ? ` — carries ${loop.artifact}` : ""}`)}">${esc(loop.cap)}</span>
          </div>`,
      )
      .join("");
  }

  function legendHtml(marks) {
    const counts = new Map(MARK_ORDER.map((mark) => [mark, 0]));
    for (const m of marks || []) counts.set(m.mark, (counts.get(m.mark) || 0) + 1);
    return `<div class="pflow-legend" data-pflow-legend>${MARK_ORDER.map(
      (mark) =>
        `<span class="pflow-key" data-mark="${mark}"><i aria-hidden="true"></i>${MARK_WORDS[mark]}${counts.get(mark) ? ` <b class="mono">${counts.get(mark)}</b>` : ""}</span>`,
    ).join("")}</div>`;
  }

  function markup(flow, position = null, { motion = true } = {}) {
    const f = layout(normalize(flow || {}));
    const marks = marksFor(f.stages, position);
    const count = f.stages.length;
    const pad = f.lanes ? f.lanes * ARC_LANE + ARC_BASE : 0;
    const current = positionOf(marks, MARK.CURRENT);
    const refused = positionOf(marks, MARK.REFUSED);
    return `<div class="pflow" data-flow-id="${esc(f.id)}" data-flow-stages="${count}" data-motion="${motion ? "on" : "off"}" data-position="${esc((current && current.id) || "")}" data-refused="${esc((refused && refused.id) || "")}" style="--pflow-n:${count};--pflow-pad:${pad}px">
      <div class="pflow-scroll">
        <div class="pflow-canvas">
          ${f.lanes ? `<div class="pflow-arcs">${arcsHtml(f)}</div>` : ""}
          <ol class="pflow-track" start="1" aria-label="${esc(`${f.title || f.id || "pipeline"} — ${count} stage${count === 1 ? "" : "s"} left to right`)}">${f.stages
            .map((stage, index) => stageHtml(stage, index, count, marks[index].mark))
            .join("")}</ol>
        </div>
      </div>
      ${legendHtml(marks)}
    </div>`;
  }

  function motionAllowed(win) {
    const w = win || global;
    try {
      if (w && typeof w.matchMedia === "function") return !w.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      /* a browser that cannot answer the query gets the motion: it is the safe default, not a promise */
    }
    return true;
  }

  // The element the modal mounts. Built through a detached container, never by innerHTML onto a live node, so an
  // incomplete string cannot take a subtree with it.
  function render(flow, position = null, { doc = null, motion = null } = {}) {
    const d = doc || (global && global.document ? global.document : null);
    if (!d || typeof d.createElement !== "function") return null;
    const box = d.createElement("div");
    box.innerHTML = markup(flow, position, { motion: motion == null ? motionAllowed(d.defaultView || global) : Boolean(motion) });
    return box.firstElementChild || null;
  }

  global.PipelineFlow = { MARK, MARK_ORDER, MARK_WORDS, normalize, fromDefinition, fromBundle, fromWindowModel, marksFor, markup, render, motionAllowed };
})(typeof window !== "undefined" ? window : globalThis);
