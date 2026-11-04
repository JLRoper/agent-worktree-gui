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
// same thing: `not-reached`, `current`, `done`, `refused`. A position is `{stage, refused}` and, when the caller holds
// them, the RECORD's own fields: `ran` (the ids that ran), `crossings` (a loop edge's count), `waitingFor` (the gate
// the row is parked on) and `via` (the edge it arrived by). A null position (the catalogue's edit mode) marks every
// stage `not-reached`, because nothing has been entered yet.
//
// The marks READ THE RECORD when it is there. With no record they fall back to the stage's index in the sequence, and
// the drawing says which rule it used in `data-marks-from`. The fallback is exact for a row that never looped and
// wrong for one that did: on the seed, a task back at S8 after one crossing of H-10 has run S9, and an index alone
// draws S9 `not-reached`. A caller that holds the record must pass it — the drawing does not invent evidence it was
// not given.
//
// A capped loop is an ARC back to the stage it re-enters, running from the centre of the column it re-enters to the
// centre of the column it leaves — gaps included, because a column's width is not the distance to its neighbour. It is
// labelled with its cap, or with `used of limit` when the record carries the count and the pipeline carries the limit
// as a number. The renderer never parses a cap sentence: one reader (`capOf`, in lib/task-pipeline-drive.js) owns
// that, because a sentence read twice can be read two ways.
//
// A GATE is an object with a state of its own — `data-state`: `open`, `ahead`, `waiting`, `answered`, `closing` — and
// an accessible name that is NOT inside an `aria-hidden` wrapper. The notch used to be, which made the one object a
// reader asks about ("what is it waiting on?") the one object a screen reader could not hear.

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
  // A count the drawing is allowed to print: a whole number that a reader put there. Anything else — a missing field,
  // a sentence, a fraction — is null, and null means "not known", never zero.
  const whole = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

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
    //
    // `limit` and `used` are carried only when a READER put whole numbers there: the limit from `capOf`, the count from
    // the record's own crossings. They are never parsed out of `cap`, because "2 of 3 rounds" reads back as a cap of 2
    // and the drawing would then bound the loop with the label that was describing it.
    return (Array.isArray(handoffs) ? handoffs : [])
      .filter((h) => isObject(h) && (!h.kind || text(h.kind) === "loop") && text(h.from) && text(h.to))
      .map((h, index) => ({
        id: text(h.id) || `loop-${index + 1}`,
        from: text(h.from),
        to: text(h.to),
        cap: text(h.cap),
        artifact: text(h.artifact) || null,
        limit: whole(h.limit),
        used: whole(h.used),
      }));
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
      // `model.loops` is the window's own reading of every loop, with the limit and the count already on it; the
      // per-row `handoffOut` is the older shape and only carries the edge that joins two neighbours. Preferring the
      // first keeps a loop the sequence edge shadows (S9 → S8 on the seed) in the drawing, which is a claim about the
      // graph the picture is supposed to make.
      loops: Array.isArray(m.loops) ? m.loops : rows.map((stage) => stage && stage.handoffOut).filter(Boolean),
    });
  }

  // ---- the marks --------------------------------------------------------------------------------------------------
  // Four marks, decided by one function so the drawing, the legend and a test cannot disagree. `refused` wins for its
  // own stage (the preview said no there); `stage` is the stage the task is IN; whether anything else RAN is read off
  // the record, not off its place in the sequence. A position with nothing in it is the catalogue's own drawing and
  // marks every stage not-reached.
  //
  // The evidence, in the record's own words (`ranFrom`):
  //   stage       the id the row is in — current, whatever else is true;
  //   ran         the ids a caller read out of the record;
  //   crossings   a loop edge's count — a crossed edge proves both its ends ran and every stage between them;
  //   via         the edge the row arrived by — its `from` stage ran, whatever kind of edge it is.
  // No evidence at all is the index fallback, and the caller can see which rule drew it in `data-marks-from`.
  function ranFrom(stages, position, loops) {
    const pos = isObject(position) ? position : {};
    const said = Array.isArray(pos.ran) ? pos.ran : null;
    const crossings = isObject(pos.crossings) ? pos.crossings : null;
    const via = text(pos.via).replace(/^#/, "");
    if (!said && !crossings && !via) return null;
    const at = new Map(stages.map((stage, index) => [text(stage.id), index]));
    const ran = new Set((said || []).map((id) => text(id).replace(/^#/, "")).filter(Boolean));
    for (const loop of Array.isArray(loops) ? loops : []) {
      if (via && text(loop.id) === via) ran.add(text(loop.from));
      const crossed = crossings ? Number(crossings[loop.id] || 0) : 0;
      if (!(crossed > 0)) continue;
      const from = at.get(text(loop.from));
      const to = at.get(text(loop.to));
      if (!Number.isInteger(from) || !Number.isInteger(to)) continue;
      for (let index = Math.min(from, to); index <= Math.max(from, to); index += 1) ran.add(text(stages[index].id));
    }
    // A record that names nothing has still been READ: an empty `ran` is "nothing ran", not "no record". Only a
    // position with none of the three fields falls back to the index.
    return ran;
  }

  function marksFor(stages, position, loops = []) {
    const list = Array.isArray(stages) ? stages : [];
    const pos = isObject(position) ? position : {};
    const withoutSlash = (value) => text(value).replace(/^#/, "");
    const current = withoutSlash(pos.stage);
    const refused = withoutSlash(pos.refused);
    const currentIndex = current ? list.findIndex((stage) => text(stage.id) === current) : -1;
    const ran = ranFrom(list, pos, loops);
    return list.map((stage, index) => {
      const id = text(stage.id);
      if (refused && id === refused) return { id, mark: MARK.REFUSED };
      if (current && id === current) return { id, mark: MARK.CURRENT };
      // A record is the authority once there is one: a stage it does not name has not run, whatever its index says.
      if (ran) return { id, mark: ran.has(id) ? MARK.DONE : MARK.NOT_REACHED };
      if (currentIndex >= 0 && index < currentIndex) return { id, mark: MARK.DONE };
      return { id, mark: MARK.NOT_REACHED };
    });
  }

  function positionOf(marks, wanted) {
    return (marks || []).find((m) => m.mark === wanted) || null;
  }

  // ---- the drawing ------------------------------------------------------------------------------------------------
  // One string, built from the normalised shape. Every stage is a COLUMN, so the picture reads left to right and a
  // connector is the gap between two columns; a gate is a notch at the middle of that connector. The arc geometry is
  // written from the same two properties the track's grid uses (`--pflow-n`, `--pflow-gap`), so no measurement is taken
  // and a resize costs no script.
  function gateTitle(gate) {
    if (!gate) return "";
    const parts = [`gate ${gate.id || "?"}${gate.name ? ` · ${gate.name}` : ""}`];
    if (gate.decision && gate.decision.path) parts.push(`decides ${gate.decision.path}${gate.decision.outcomes.length ? ` (${gate.decision.outcomes.join(", ")})` : ""}`);
    else if (gate.title) parts.push(gate.title);
    if (gate.artifact) parts.push(`on ${gate.artifact}`);
    if (gate.decider) parts.push(`decider ${gate.decider}`);
    return parts.join(" — ");
  }

  // The five states a notch can be in, and each one is a fact rather than a shading:
  //   open      the gate declares no decision record — nothing can be waited on and nothing was consulted;
  //   ahead     it declares one, and the row has not been drawn past this stage (not proven crossed);
  //   waiting   the row is parked ON it: `position.waitingFor` names it, with the path and the stamp;
  //   answered  the row is past this stage, so the driver found the record and crossed;
  //   closing   it follows the LAST stage: the pipeline ends there and the driver answers `done` before it looks for a
  //             gate (lib/task-pipeline-drive.js), so the drawing says so instead of promising a barrier the run stops
  //             at. A gate the driver cannot reach must not be drawn as one it waits on.
  const GATE_STATE = Object.freeze({ OPEN: "open", AHEAD: "ahead", WAITING: "waiting", ANSWERED: "answered", CLOSING: "closing" });

  function gateStateOf(gate, { index, count, currentIndex, position }) {
    if (!gate || !gate.decision) return GATE_STATE.OPEN;
    if (index === count - 1) return GATE_STATE.CLOSING;
    const wait = isObject(position) && isObject(position.waitingFor) ? position.waitingFor : null;
    if (wait && text(wait.gate) === text(gate.id)) return GATE_STATE.WAITING;
    if (currentIndex >= 0 && index < currentIndex) return GATE_STATE.ANSWERED;
    return GATE_STATE.AHEAD;
  }

  // The notch's accessible name. It is the sentence the drawing exists to be able to say — which gate, what it decides,
  // and where the row is against it — and it sits on the notch itself, outside the decorative connector.
  function gateAria(gate, stage, state, position) {
    const head = `gate ${gate.id || "?"}${gate.name ? ` · ${gate.name}` : ""} — after ${stage.title}`;
    const path = text(gate.decision && gate.decision.path);
    if (state === GATE_STATE.OPEN) return `${head} — no decision record is declared${gate.title ? ` (${gate.title})` : ""}`;
    if (state === GATE_STATE.CLOSING) return `${head} — decides ${path || "a record"}; the pipeline ends at this stage, and the panel does not wait on this gate`;
    if (state === GATE_STATE.WAITING) {
      const wait = isObject(position) && isObject(position.waitingFor) ? position.waitingFor : {};
      return `${head} — waiting on ${text(wait.path) || path || "its decision record"}${text(wait.since) ? ` since ${text(wait.since)}` : ""}`;
    }
    if (state === GATE_STATE.ANSWERED) return `${head} — decides ${path || "a record"}; answered`;
    return `${head} — decides ${path || "a record"}; not yet crossed`;
  }

  // The notch, as its own element in the gap. The connector keeps `aria-hidden` (it is a hairline), and the notch sits
  // beside it rather than inside it: the name used to be written on a span whose whole ancestor was hidden, which is the
  // same as not writing it. The position restates what `left: 50%` of the connector meant, in the column's own
  // coordinates, because the connector is no longer its parent.
  function notchHtml(gate, { state, name, last }) {
    // The last gate's notch sits ON the closing edge: its 3 px end at the column's right edge, so the notch is inside
    // the track (and the scroller) instead of 9 px past it on a stub.
    const at = last ? "calc(100% - 1.5px)" : "calc(100% + var(--pflow-gap) / 2)";
    return `<span class="pflow-notch" role="note" data-gate="${esc(gate.id || "")}" data-gate-name="${esc(gate.name || "")}" data-state="${esc(state)}" aria-label="${esc(name)}" title="${esc(gateTitle(gate))}" style="left:${at};top:19px"></span>`;
  }

  // A gate after the LAST stage has no next column to reach: its notch is drawn ON the track's closing edge, so the
  // check that ends the whole pipeline (a UAT sign-off) is still a notch on the track rather than a fact the drawing
  // dropped — and nothing hangs past the last column. The stub that used to sit here was 18 px of decorative line at
  // `left: 100%`, which widened the drawing past its own track and pushed the one notch it labelled outside the
  // scroller (round 5A's finding 1: scrollWidth 1109 against clientWidth 1094 at seven stages).
  function stageHtml(stage, index, count, mark, { position = null, currentIndex = -1 } = {}) {
    const last = index === count - 1;
    const gate = stage.gate;
    const link = last ? "" : `<span class="pflow-link" aria-hidden="true"></span>`;
    const state = gate ? gateStateOf(gate, { index, count, currentIndex, position }) : null;
    const notch = gate ? notchHtml(gate, { state, name: gateAria(gate, stage, state, position), last }) : "";
    const artifact = stage.artifact ? `<span class="pflow-art mono" title="the artifact this stage writes">${esc(stage.artifact)}</span>` : "";
    // `aria-current="step"` is the one thing a screen reader needs to find the row's place, and it is a fact about the
    // record rather than a colour. The stage's own `title` still carries the long form.
    const here = mark === MARK.CURRENT ? ' aria-current="step"' : "";
    return `<li class="pflow-node" data-stage="${esc(stage.id)}" data-pos="${index + 1}" data-mark="${esc(mark)}"${gate ? ` data-gate="${esc(gate.id || "")}"` : ""}${here} title="${esc(`${index + 1} of ${count} · ${stage.title} · ${MARK_WORDS[mark] || mark}`)}">
        <span class="pflow-dot" aria-hidden="true"></span>
        <span class="pflow-n mono" aria-hidden="true">${index + 1}</span>
        <span class="pflow-title">${esc(stage.title)}</span>
        ${artifact}
        ${link}${notch}
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

  // ---- the arc geometry, in the track's own units -----------------------------------------------------------------
  // The track is a grid of `count` columns and `count - 1` gaps, so one column is `colW = (100% - (n-1)·gap) / n` and
  // a column plus the gap after it — the PITCH — is `colW + gap`. A point on the track is therefore two numbers: how
  // many columns, and how many gaps. The centre of column k is `k + 0.5` columns and `k` gaps.
  //
  // An arc that leaves column j and re-enters column i runs between those two centres, so its width is `j - i` COLUMNS
  // and `j - i` GAPS. The width used to be `j - i` columns alone: the same distance minus every gap it crosses. On the
  // seed's one-column loops that is 26 px — half a column, which reads as "pointing at that stage" and is why nobody
  // complained; on a four-column loop it is 104 px, a whole column, and the arc lands over the WRONG stage. The old
  // formula was exact only for an arc of zero width, and no arc has zero width.
  const pointAt = (col, gap) => ({ col, gap });
  const centreOf = (index) => pointAt(index + 0.5, index);

  // The same point as the CSS the browser evaluates. `colW` is spelled with the SAME two custom properties the track's
  // grid uses, so an arc cannot drift from the column it joins: no measurement, no resize handler.
  function cssPoint(point, count) {
    const colW = `(100% - ${count - 1} * var(--pflow-gap)) / ${count}`;
    const terms = [`${colW} * ${point.col}`];
    if (point.gap) terms.push(`${point.gap} * var(--pflow-gap)`);
    return `calc(${terms.join(" + ")})`;
  }

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
        // The arc runs centre to centre. `span` columns AND `span` gaps — the gaps are part of the distance.
        const span = loop.fromIndex - loop.toIndex;
        return { ...loop, lane, arc: { left: centreOf(loop.toIndex), width: pointAt(span, span) } };
      });
    const lanesUsed = loops.length ? Math.max(...loops.map((loop) => loop.lane)) + 1 : 0;
    return { ...flow, drawn: loops, lanes: lanesUsed };
  }

  function arcsHtml(flow, position) {
    const count = flow.stages.length;
    const pos = isObject(position) ? position : {};
    const crossings = isObject(pos.crossings) ? pos.crossings : null;
    return flow.drawn
      .map((loop) => {
        // The cap is printed from FIELDS, never re-parsed: `limit` comes from the one reader that parses the studio's
        // sentence (capOf), and `used` from the record's own crossings. With either missing, the drawing prints the
        // studio's sentence and claims nothing — "0 of 3" invented here would be a number nobody counted.
        const limit = whole(loop.limit) && loop.limit > 0 ? loop.limit : null;
        const used = limit == null ? null : loop.used != null ? loop.used : crossings ? Number(crossings[loop.id] || 0) : null;
        const spent = limit != null && used != null && used >= limit;
        const label = limit != null && used != null ? `${used} of ${limit}` : loop.cap;
        const said = [
          `loop ${loop.id}${loop.cap ? ` — ${loop.cap}` : ""}`,
          limit != null && used != null ? `${used} of ${limit} taken` : "the cap is the studio's sentence, and this drawing does not parse it",
          spent ? "at its cap: the edge is not taken again" : "",
          loop.artifact ? `carries ${loop.artifact}` : "",
          "the panel takes the sequence out of a stage that has one; this edge is taken only when it is the stage's only way out",
        ]
          .filter(Boolean)
          .join(" — ");
        return `<div class="pflow-arc" data-loop="${esc(loop.id)}" data-from="${esc(flow.stages[loop.fromIndex].id)}" data-to="${esc(flow.stages[loop.toIndex].id)}" data-cap="${esc(loop.cap)}"${spent ? ' data-spent="1"' : ""}${used != null ? ` data-used="${used}"` : ""}${limit != null ? ` data-limit="${limit}"` : ""} style="--pflow-i:${loop.toIndex};--pflow-j:${loop.fromIndex};--pflow-lane:${loop.lane};left:${cssPoint(loop.arc.left, count)};width:${cssPoint(loop.arc.width, count)}">
            <span class="pflow-arc-label mono" title="${esc(said)}">${esc(label)}</span>
          </div>`;
      })
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
    const marks = marksFor(f.stages, position, f.loops);
    const count = f.stages.length;
    const pad = f.lanes ? f.lanes * ARC_LANE + ARC_BASE : 0;
    const current = positionOf(marks, MARK.CURRENT);
    const refused = positionOf(marks, MARK.REFUSED);
    const currentIndex = current ? f.stages.findIndex((stage) => text(stage.id) === current.id) : -1;
    // Which rule drew the marks, in the DOM: `record` when the position carried evidence, `index` when it did not. A
    // reader (and a test) can see that the fallback is the weaker claim without having to reproduce it.
    const from = ranFrom(f.stages, position, f.loops) ? "record" : "index";
    return `<div class="pflow" data-flow-id="${esc(f.id)}" data-flow-stages="${count}" data-motion="${motion ? "on" : "off"}" data-position="${esc((current && current.id) || "")}" data-refused="${esc((refused && refused.id) || "")}" data-marks-from="${from}" style="--pflow-n:${count};--pflow-pad:${pad}px">
      <div class="pflow-scroll">
        <div class="pflow-canvas">
          ${f.lanes ? `<div class="pflow-arcs">${arcsHtml(f, position)}</div>` : ""}
          <ol class="pflow-track" start="1" aria-label="${esc(`${f.title || f.id || "pipeline"} — ${count} stage${count === 1 ? "" : "s"} left to right`)}">${f.stages
            .map((stage, index) => stageHtml(stage, index, count, marks[index].mark, { position, currentIndex }))
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
