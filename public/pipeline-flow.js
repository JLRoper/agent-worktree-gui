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
  //   { id, title, kind, stages: [{id, title, gate, artifact, reads}], loops: [{from, to, cap, id, artifact}],
  //     externals: [{artifact, source, reason}], artifacts: [ … the artifact view … ] }
  // A gate is `{id, name, title, artifact, decider, decision}` — `decision` null for a definition's exit check, which
  // has parameters rather than a decision artifact.
  //
  // `artifacts` is the ARTIFACT VIEW: one node per artifact the document already names as an input somewhere — a
  // stage's `inputs.read[]`, a handoff's `artifact`, the document's `external_inputs` — carrying the stage that writes
  // it, the stages that read it, and the edge each arrival came by. Nothing new is added to the document to say it:
  // the view is derived, so the drawing cannot claim an artifact the document does not hold. The one thing it can add
  // is `missing` — a read naming an artifact no stage writes and no external input declares — and that node is drawn
  // and marked rather than dropped, because a drawing that silently loses a read certifies a graph the document does
  // not have.
  function exitGate(stage) {
    const exit = isObject(stage) && isObject(stage.exit) ? stage.exit : null;
    const check = text(exit && exit.check);
    if (!check) return null;
    const params = Object.entries(exit).filter(([key]) => key !== "check");
    const said = params.length ? params.map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : String(value)}`).join(" ") : "no parameters";
    // `params` is the short form a stage card can print beside the check's name ("min=1"), and `title` is the long
    // sentence the notch's tooltip keeps. One reader of `exit` decides both, so the two cannot disagree.
    return { id: `exit:${text(stage.id)}`, name: check, params: params.length ? said : "", title: `exit check ${check} — ${said}`, artifact: null, decider: null, decision: null };
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

  // Every edge the document draws, of any kind — not only the loops the arcs above the track show. The artifact view
  // needs the sequence edges too: they are what carries an artifact from one column to the next, and a drawing that
  // knew only the loops would paint the rail's own handoffs as thin reads.
  //
  // `limit` and `used` are carried only when a READER put whole numbers there: the limit from `capOf`, the count from
  // the record's own crossings. They are never parsed out of `cap`, because "2 of 3 rounds" reads back as a cap of 2
  // and the drawing would then bound the loop with the label that was describing it.
  function handoffsOf(handoffs) {
    // One edge per id: a window model can name the same loop twice (its own `loops` list and the joining
    // `handoffOut` on a stage row), and two arcs for one edge is a second, contradicting drawing.
    const seen = new Set();
    return (Array.isArray(handoffs) ? handoffs : [])
      .filter((h) => isObject(h) && text(h.from) && text(h.to))
      .map((h, index) => ({
        id: text(h.id) || `edge-${index + 1}`,
        from: text(h.from),
        to: text(h.to),
        cap: text(h.cap),
        artifact: text(h.artifact) || null,
        kind: text(h.kind) || null,
        limit: whole(h.limit),
        used: whole(h.used),
      }))
      .filter((edge) => {
        if (seen.has(edge.id)) return false;
        seen.add(edge.id);
        return true;
      });
  }

  // The arcs: only a loop is drawn as one. An already-normalised loop carries no `kind` (it was decided when the shape
  // was read); a bundle handoff carries one, and anything else — a `sequence` or a `return` edge — is a join, not a cap.
  function loopsOf(edges) {
    return (Array.isArray(edges) ? edges : []).filter((edge) => !edge.kind || edge.kind === "loop");
  }

  // A read arrives as the document writes it (`{artifact, location, sha256}`) or as a bare id in a hand-authored
  // fixture. One reader, so neither adapter has to know which it was given, and an entry with no artifact id names
  // nothing a drawing could place and is dropped rather than drawn as an empty chip.
  function readOf(entry) {
    if (typeof entry === "string") return text(entry) ? { artifact: text(entry), location: null, sha256: null } : null;
    if (!isObject(entry)) return null;
    const artifact = text(entry.artifact);
    return artifact ? { artifact, location: text(entry.location) || null, sha256: text(entry.sha256) || null } : null;
  }

  function externalOf(entry) {
    if (typeof entry === "string") return text(entry) ? { artifact: text(entry), source: null, reason: null } : null;
    if (!isObject(entry)) return null;
    const artifact = text(entry.artifact);
    return artifact ? { artifact, source: text(entry.source) || null, reason: text(entry.reason) || null } : null;
  }

  // The three ways an artifact arrives at a stage, in the order a reader needs them: a handoff is the rail's own
  // promise (the previous stage passed it on), `read` is a stage fetching one written further back, and `external` is
  // the document saying it does not write this one at all.
  const EDGE = Object.freeze({ HANDOFF: "handoff", READ: "read", EXTERNAL: "external" });

  // ---- the artifact view -------------------------------------------------------------------------------------------
  // One node per artifact that is somebody's INPUT, derived from the document's own fields. The node sits at the
  // boundary after the column that writes it (the gap between stages — where a handoff happens), or on the document's
  // left boundary when it comes from outside, or at its first reader when nothing declares it at all. `edges` are the
  // arrivals, so the drawing can style each one: thick for a handoff, thin for a read, dashed for the boundary.
  function artifactView(stages, handoffs, externals) {
    const at = new Map(stages.map((stage, index) => [text(stage.id), index]));
    const writer = new Map();
    for (const [index, stage] of stages.entries()) if (stage.artifact) writer.set(text(stage.artifact), index);
    const outside = new Map(externals.map((entry) => [entry.artifact, entry]));
    const nodes = new Map();
    const nodeOf = (id) => {
      if (!nodes.has(id)) {
        const index = writer.has(id) ? writer.get(id) : null;
        const external = index == null && outside.has(id);
        nodes.set(id, {
          id,
          writer: index == null ? null : text(stages[index].id),
          writerIndex: index,
          external,
          missing: index == null && !external,
          source: external ? outside.get(id).source : null,
          edges: [],
        });
      }
      return nodes.get(id);
    };

    // 1. Every handoff: it IS an edge, and the artifact it carries is an input of the stage it enters.
    for (const handoff of handoffs) {
      const artifact = text(handoff.artifact);
      const to = at.get(text(handoff.to));
      if (!artifact || to == null) continue;
      const node = nodeOf(artifact);
      // A handoff the loader let through always names an artifact a stage here writes; a fixture handed straight to
      // the renderer may not, and inventing a thick edge out of nothing would be a claim about the graph.
      if (node.missing) continue;
      node.edges.push({ to, toStage: text(handoff.to), edge: text(handoff.id), kind: EDGE.HANDOFF });
    }

    // 2. Every declared read. A stage reading the artifact it writes is not an edge; a read already carried by a
    // handoff into the same stage is that handoff (the thicker, better-supported claim), not a second one.
    for (const [index, stage] of stages.entries()) {
      for (const read of stage.reads || []) {
        const node = nodeOf(read.artifact);
        if (node.writerIndex === index) continue;
        if (node.edges.some((edge) => edge.to === index)) continue;
        node.edges.push({
          to: index,
          toStage: text(stage.id),
          edge: null,
          kind: node.external ? EDGE.EXTERNAL : EDGE.READ,
          location: read.location || null,
        });
      }
    }

    // 3. An external input nothing reads yet is still the document's input: it gets a node (with no destination)
    // rather than disappearing because no stage happened to name it.
    for (const entry of externals) nodeOf(entry.artifact);

    // Where each node sits, and which lane. A missing node has no origin to point at, so it sits at its first
    // reader's column.
    const anchored = [...nodes.values()].map((node) => ({
      ...node,
      boundary: node.writerIndex != null ? node.writerIndex + 1 : node.external ? 0 : node.edges.length ? node.edges[0].to : 0,
    }));
    // The left boundary is a COLUMN of chips, not a lane: a chip aligned to the canvas's left edge is as wide as a
    // column, and the chip on the first boundary is centred on that edge — in one lane the two overlap. So the
    // boundary's chips take the lowest lanes and every chip with an origin starts above them.
    const base = anchored.filter((node) => node.boundary === 0).length;
    const used = new Map();
    const placed = anchored.map((node) => {
      const seen = used.get(node.boundary) || 0;
      used.set(node.boundary, seen + 1);
      return { ...node, lane: seen + (node.boundary === 0 ? 0 : base) };
    });
    return placed.sort((a, b) => a.boundary - b.boundary || a.lane - b.lane || a.id.localeCompare(b.id));
  }

  function normalize({ id = "", title = "", kind = "", stages = [], gates = [], handoffs = [], loops = [], externals = [] } = {}) {
    const list = (Array.isArray(stages) ? stages : []).filter(isObject);
    const byAfter = new Map();
    for (const raw of Array.isArray(gates) ? gates : []) {
      if (!isObject(raw) || !text(raw.after)) continue;
      const gate = bundleGate(raw);
      if (gate) byAfter.set(text(raw.after), gate);
    }
    const ids = new Set(list.map((s) => text(s.id)));
    const rows = list.map((raw, index) => ({
      id: text(raw.id),
      title: text(raw.title) || text(raw.id) || `stage ${index + 1}`,
      gate: byAfter.get(text(raw.id)) || (isObject(raw.gate) ? raw.gate : null),
      artifact: text(raw.artifact && raw.artifact.id ? raw.artifact.id : raw.artifact) || null,
      reads: (Array.isArray(raw.reads) ? raw.reads : []).map(readOf).filter(Boolean),
    }));
    // Every edge the document draws, then the loops among them (an arc is a loop and nothing else). `loops` stays an
    // accepted alias because a window model hands its loops over under that name.
    const edges = handoffsOf(handoffs.length ? handoffs : loops);
    // A loop whose ends are not both stages this pipeline holds is not drawable: it is dropped rather than invented
    // between two neighbours, because an arc between the wrong stages is a claim about the sequence.
    const drawn = loopsOf(edges).filter((loop) => ids.has(loop.from) && ids.has(loop.to) && loop.from !== loop.to);
    const boundary = (Array.isArray(externals) ? externals : []).map(externalOf).filter(Boolean);
    return {
      id: text(id),
      title: text(title),
      kind: text(kind),
      stages: rows,
      // Every edge, and the loops among them. Both are carried so this normalised shape can be handed back to
      // `normalize` (which `markup` does) and come out the same: a flow that kept only the loops would have its
      // sequence handoffs — the ones that make a connector thick — silently dropped on the second pass.
      handoffs: edges,
      loops: drawn,
      externals: boundary,
      artifacts: artifactView(rows, edges, boundary),
    };
  }

  function fromDefinition(def) {
    const d = isObject(def) ? def : {};
    const stages = (Array.isArray(d.stages) ? d.stages : []).map((stage) => ({ id: stage && stage.id, title: stage && stage.title, gate: exitGate(stage) }));
    return normalize({ id: d.id, title: d.title, kind: d.kind, stages, gates: [], loops: [] });
  }

  // `pipeline` may be the studio's own document (whose stages carry `inputs.read` and whose root carries
  // `external_inputs`) or the panel's normalised reading of it (`stages[].reads`, `externalInputs`) — the catalogue
  // route and the tests hand over different ones, and both say the same thing. One reader accepts either.
  function fromBundle(pipeline) {
    const p = isObject(pipeline) ? pipeline : {};
    return normalize({
      id: p.id,
      title: p.title,
      kind: p.kind,
      stages: Array.isArray(p.stages)
        ? p.stages.map((stage) => ({
            id: stage && stage.id,
            title: stage && stage.title,
            artifact: stage && stage.artifact,
            reads: Array.isArray(stage && stage.reads) ? stage.reads : isObject(stage && stage.inputs) ? stage.inputs.read : [],
          }))
        : [],
      gates: p.gates,
      // Every handoff, not only the loops: a sequence edge is the artifact's ride from one column to the next.
      handoffs: p.handoffs,
      externals: Array.isArray(p.externalInputs) ? p.externalInputs : p.external_inputs,
    });
  }

  function fromWindowModel(model) {
    const m = isObject(model) ? model : {};
    const rows = Array.isArray(m.stages) ? m.stages : [];
    return normalize({
      id: m.pipeline && m.pipeline.id,
      title: m.pipeline && m.pipeline.title,
      stages: rows.map((stage) => ({
        id: stage && stage.id,
        title: stage && stage.title,
        artifact: stage && stage.artifact,
        reads: Array.isArray(stage && stage.reads) ? stage.reads : [],
        gate: stage && stage.gateEnding,
      })),
      externals: Array.isArray(m.externalInputs) ? m.externalInputs : m.external_inputs,
      gates: [],
      // `model.loops` is the window's own reading of every loop, with the limit and the count already on it; the
      // per-row `handoffOut` is the older shape and only carries the edge that joins two neighbours. Both are handed
      // over: the loops keep a back edge the sequence edge shadows (S9 → S8 on the seed), and the sequence edges are
      // what carries an artifact from one column to the next. `handoffsOf` de-duplicates by id, so the same edge
      // named twice is still drawn once.
      handoffs: [...(Array.isArray(m.loops) ? m.loops : []), ...rows.map((stage) => stage && stage.handoffOut).filter(Boolean)],
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

  // The one line a stage card prints under its title: what the stage writes, or the gate/exit check that ends it. It
  // reads the same objects the notch and the arcs carry and never parses them a second time — a definition's `exit`
  // is read once, by exitGate, and a bundle gate's decision artifact and the stage's own artifact come straight off
  // the normalised shape. Null where the stage carries nothing to say, so a bare definition does not print a word.
  function stageDetail(stage) {
    if (!stage) return null;
    const gate = stage.gate;
    if (stage.artifact) return { kind: "artifact", text: `writes ${stage.artifact}`, title: `this stage writes ${stage.artifact}` };
    if (!gate) return null;
    const target = text(gate.decision && gate.decision.path) || text(gate.artifact);
    if (target) return { kind: "gate", text: `${gate.name || "gate"} → ${target}`, title: gateTitle(gate) };
    if (!gate.name) return null;
    // A definition's exit check prints its own name and parameters — `commits min=1` — and not a prefix word: in the
    // 96 px column the prefix pushed the check past a line and a half, so `branch-exists` read `exit branch-…`. The
    // notch IS the exit check, and its tooltip is gateTitle(gate), so the sentence is a hover away.
    const short = /^exit:/.test(text(gate.id)) ? `${gate.name}${gate.params ? ` ${gate.params}` : ""}` : gate.name;
    return { kind: "exit", text: short, title: gateTitle(gate) };
  }

  // A gate after the LAST stage has no next column to reach: its notch is drawn ON the track's closing edge, so the
  // check that ends the whole pipeline (a UAT sign-off) is still a notch on the track rather than a fact the drawing
  // dropped — and nothing hangs past the last column. The stub that used to sit here was 18 px of decorative line at
  // `left: 100%`, which widened the drawing past its own track and pushed the one notch it labelled outside the
  // scroller (round 5A's finding 1: scrollWidth 1109 against clientWidth 1094 at seven stages).
  function stageHtml(stage, index, count, mark, { position = null, currentIndex = -1, handoff = null } = {}) {
    const last = index === count - 1;
    const gate = stage.gate;
    // The connector after this stage IS the handoff, when the document hands an artifact across it: `data-handoff`
    // names the edge and the stylesheet draws it thick. A connector with no artifact is the plain hairline.
    const link = last
      ? ""
      : `<span class="pflow-link" aria-hidden="true"${handoff ? ` data-handoff="${esc(handoff.edge || "")}" data-artifact="${esc(handoff.artifact)}"` : ""}></span>`;
    const state = gate ? gateStateOf(gate, { index, count, currentIndex, position }) : null;
    const notch = gate ? notchHtml(gate, { state, name: gateAria(gate, stage, state, position), last }) : "";
    const detail = stageDetail(stage);
    const line = detail ? `<span class="pflow-art mono" data-detail="${detail.kind}" title="${esc(detail.title)}">${esc(detail.text)}</span>` : "";
    // `aria-current="step"` is the one thing a screen reader needs to find the row's place, and it is a fact about the
    // record rather than a colour. The stage's own `title` still carries the long form.
    const here = mark === MARK.CURRENT ? ' aria-current="step"' : "";
    return `<li class="pflow-node" data-stage="${esc(stage.id)}" data-pos="${index + 1}" data-mark="${esc(mark)}"${gate ? ` data-gate="${esc(gate.id || "")}"` : ""}${here} title="${esc(`${index + 1} of ${count} · ${stage.title} · ${MARK_WORDS[mark] || mark}`)}">
        <span class="pflow-dot" aria-hidden="true"></span>
        <span class="pflow-title"><span class="pflow-n mono" aria-hidden="true">${index + 1}</span> ${esc(stage.title)}</span>
        ${line}
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

  // ---- the artifact view, drawn -----------------------------------------------------------------------------------
  // A lane UNDER the track, in two bands: the CHIPS (one per artifact, on the boundary the document draws it at — the
  // gap after the column that writes it, the canvas's left edge for an external input, the first reader for one
  // nothing declares), and a BUS of hairlines below them. A line runs from the chip's boundary to the column that
  // reads it, with a riser at its own end and a dot under the reader's column; the three kinds the document already
  // distinguishes get the three styles — thin for a read, thick for a handoff, dashed for the document's own boundary.
  //
  // The bus exists because a line drawn at the chips' own height runs THROUGH every chip between its ends and reads as
  // a rail joining them. Below the chips it is the artifact's own route and nothing else's. Lines are packed into
  // lanes by their span, so two that do not overlap share a lane and the band stays shallow.
  //
  // Nothing here is measured. A boundary is `k` columns and `k - 1` gaps from the canvas's left edge (the arcs'
  // arithmetic, for the same reason: a run of columns is a run of gaps), so the chips and lines are written in the
  // track's own `calc()` and a resize costs no script and no ResizeObserver.
  const CHIP_LANE = 18;
  const BUS_LANE = 7;

  const boundaryPoint = (k) => (k <= 0 ? pointAt(0, 0) : pointAt(k, k - 1));
  const boundarySpan = (a, b) => (a <= 0 ? pointAt(b, Math.max(0, b - 1)) : pointAt(b - a, b - a));

  // What the chip is, in one sentence: its id, who writes it, and which stage reads it by which edge. The accessible
  // name and the tooltip are the SAME string, so a reader who can hover and a reader who cannot are told the same
  // thing.
  function chipTitle(node) {
    const parts = [node.id];
    if (node.writer) parts.push(`written by ${node.writer}`);
    if (node.external) parts.push(`from outside this document${node.source ? ` (${node.source})` : ""}`);
    if (node.missing) parts.push("missing — no stage in this document writes it and external_inputs does not declare it");
    const readers = node.edges.map((edge) => `${edge.toStage}${edge.kind === EDGE.HANDOFF && edge.edge ? ` by ${edge.edge}` : ""}`);
    if (readers.length) parts.push(`read by ${readers.join(", ")}`);
    return parts.join(" — ");
  }

  // The node's own kind, for the palette and the key: a missing node wins, then the boundary, then whichever edge
  // the document supports most strongly (a handoff is an edge the studio drew; a read is the stage's own list).
  function nodeKind(node) {
    if (node.missing) return "missing";
    if (node.external) return EDGE.EXTERNAL;
    return node.edges.some((edge) => edge.kind === EDGE.HANDOFF) ? EDGE.HANDOFF : EDGE.READ;
  }

  // Every route a reading column is on, ONE per artifact and edge kind: a fan-out to four stages is one line with a
  // dot at each column it reaches, not four nested lines that paint over each other. A reader at the node's own
  // boundary is the chip's neighbour (a zero-width line says nothing) and a reader BEHIND the node is a loop the arc
  // above the track already draws — neither is a line here.
  function busOf(nodes) {
    const routes = [];
    for (const node of nodes) {
      const forward = node.edges.filter((edge) => edge.to > node.boundary);
      for (const kind of [EDGE.HANDOFF, EDGE.READ, EDGE.EXTERNAL]) {
        const readers = forward.filter((edge) => edge.kind === kind);
        if (!readers.length) continue;
        routes.push({ node, kind, from: node.boundary, to: Math.max(...readers.map((edge) => edge.to)), readers });
      }
    }
    // Greedy by start: a lane holds the routes whose spans do not overlap, so two independent artifacts share a lane
    // and the band stays shallow.
    const lanes = [];
    return routes
      .sort((a, b) => a.from - b.from || a.to - b.to)
      .map((route) => {
        let lane = 0;
        while (lane < lanes.length && lanes[lane] > route.from) lane += 1;
        lanes[lane] = route.to;
        return { ...route, lane };
      });
  }

  function artifactsHtml(flow) {
    const count = flow.stages.length;
    const nodes = flow.artifacts;
    if (!nodes.length || !count) return "";
    const chipLanes = Math.max(...nodes.map((node) => node.lane)) + 1;
    const routes = busOf(nodes);
    const busLanes = routes.length ? Math.max(...routes.map((route) => route.lane)) + 1 : 0;
    const busHeight = busLanes * BUS_LANE;
    const at = (node, edge) => `bottom:${edge.lane * BUS_LANE}px;left:${cssPoint(boundaryPoint(node.boundary), count)};width:${cssPoint(boundarySpan(node.boundary, edge.to), count)}`;
    const lines = routes
      .map((route) => {
        const handoff = route.readers.find((edge) => edge.edge);
        const said = `${route.node.id} — read by ${route.readers.map((edge) => edge.toStage).join(", ")}${handoff ? ` (handed on by ${handoff.edge})` : ""}`;
        return `<span class="pflow-artifact-edge" data-edge="${route.kind}" data-artifact="${esc(route.node.id)}" data-to="${esc(route.readers[route.readers.length - 1].toStage)}"${handoff ? ` data-handoff="${esc(handoff.edge)}"` : ""} style="${at(route.node, { lane: route.lane, to: route.to })}" title="${esc(said)}" aria-hidden="true"></span>`;
      })
      .join("");
    // A dot under every column the route reaches: the reader's end, and each earlier reader on the way.
    const dots = routes
      .flatMap((route) =>
        route.readers.map(
          (edge) =>
            `<i class="pflow-artifact-dot" data-edge="${route.kind}" data-artifact="${esc(route.node.id)}" data-to="${esc(edge.toStage)}" aria-hidden="true" style="bottom:${route.lane * BUS_LANE}px;left:${cssPoint(boundaryPoint(edge.to), count)}"></i>`,
        ),
      )
      .join("");
    const chips = nodes
      .map((node) => {
        // A chip centred on boundary 0 or on the track's closing edge would hang outside the drawing; at either end
        // it is aligned to the edge instead, so nothing widens the drawing past its own track.
        const side = node.boundary <= 0 ? "left" : node.boundary >= count ? "right" : "centre";
        const where = side === "right" ? "right:0" : `left:${cssPoint(boundaryPoint(node.boundary), count)}`;
        const reads = node.edges.map((edge) => edge.toStage);
        const said = chipTitle(node);
        const bottom = busHeight + node.lane * CHIP_LANE;
        return `<span class="pflow-artifact" role="note" data-artifact="${esc(node.id)}" data-at="${node.boundary}" data-side="${side}" data-kind="${nodeKind(node)}"${node.missing ? ' data-missing="1"' : ""}${node.writer ? ` data-writer="${esc(node.writer)}"` : ""}${reads.length ? ` data-reads="${esc(reads.join(" "))}"` : ""} style="bottom:${bottom}px;${where}" title="${esc(said)}" aria-label="${esc(said)}">${esc(node.missing ? `${node.id} — missing` : node.id)}</span>`;
      })
      .join("");
    const height = busHeight + chipLanes * CHIP_LANE + 2;
    return `<div class="pflow-artifacts" data-pflow-artifacts="${nodes.length}" data-art-bus="${busLanes}" aria-label="artifacts, and the edge each arrives by" style="height:${height}px">${lines}${dots}${chips}</div>`;
  }

  // The key explains the three styles the picture uses, and only the ones it uses: a pipeline with no artifact draws
  // no key, the same rule the marks' legend follows.
  const ART_WORDS = Object.freeze({
    [EDGE.READ]: "read — thin",
    [EDGE.HANDOFF]: "handoff — thick",
    [EDGE.EXTERNAL]: "external — dashed",
    missing: "missing — nothing writes it",
  });

  function artifactsKeyHtml(flow) {
    if (!flow.artifacts.length) return "";
    const kinds = new Set();
    for (const node of flow.artifacts) {
      kinds.add(nodeKind(node));
      for (const edge of node.edges) kinds.add(edge.kind);
    }
    const order = [EDGE.READ, EDGE.HANDOFF, EDGE.EXTERNAL, "missing"].filter((kind) => kinds.has(kind));
    if (!order.length) return "";
    return `<div class="pflow-artifact-key" data-pflow-artifact-key>${order
      .map((kind) => `<span class="pflow-artifact-key-item" data-edge="${kind}"><i aria-hidden="true"></i>${ART_WORDS[kind]}</span>`)
      .join("")}</div>`;
  }

  function legendHtml(marks) {
    const counts = new Map(MARK_ORDER.map((mark) => [mark, 0]));
    for (const m of marks || []) counts.set(m.mark, (counts.get(m.mark) || 0) + 1);
    // Only the states this drawing actually shows. A definition has no position, so every one of its stages is `not
    // reached` and the legend says that once instead of listing three marks the reader cannot find on the picture; a
    // live row lists the marks it carries, refused included only where a gate said no.
    const present = MARK_ORDER.filter((mark) => counts.get(mark));
    if (!present.length) return "";
    // Every key is a PHRASE WITH ITS NOUN — `not reached 7 stages` — never a mark followed by a bare numeral. "done 5"
    // reads as five of something the reader has to infer; the drawing counts stages, so the key says stages.
    return `<div class="pflow-legend" data-pflow-legend>${present.map(
      (mark) =>
        `<span class="pflow-key" data-mark="${mark}"><i aria-hidden="true"></i>${MARK_WORDS[mark]} <b class="mono">${counts.get(mark)} ${counts.get(mark) === 1 ? "stage" : "stages"}</b></span>`,
    ).join("")}</div>`;
  }

  // ---- what the reader can see ------------------------------------------------------------------------------------
  // The scroller is HONEST about its own box. A stage or a notch is IN VIEW when its whole rect sits inside the
  // scroller's client box; anything else is out, and the count says which side it is on, because "four more to come"
  // and "four behind" are different instructions to a reader scrolling a long definition. The numbers come from the
  // painted rects, never from the document's stage list: a stage the browser clipped is not counted as visible.
  //
  // The sentence is written once, here, so the element a reader looks at and the test that pins it read the same
  // words. `first`/`last` are the ordinals of the stages that are at least partly in view (1-based, from `data-pos`).
  function countText(view) {
    const s = isObject(view) && isObject(view.stages) ? view.stages : { total: 0, out: 0 };
    const n = isObject(view) && isObject(view.notches) ? view.notches : { total: 0, out: 0 };
    if (!s.total) return "no stage is drawn";
    const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
    if (!s.out && !n.out) return `all ${plural(s.total, "stage", "stages")}${n.total ? ` and ${plural(n.total, "notch", "notches")}` : ""} in view`;
    const first = whole(view.first);
    const last = whole(view.last);
    const showing = first != null && last != null ? `showing stages ${first}–${last} of ${s.total} — ` : "";
    const said = [`${s.out} of ${s.total} ${s.total === 1 ? "stage" : "stages"}`];
    if (n.total) said.push(`${n.out} of ${n.total} ${n.total === 1 ? "notch" : "notches"}`);
    return `${showing}${said.join(" and ")} out of view`;
  }

  // Measure one flow's own drawing. `root` is the `.pflow` element (or the element that holds it), so the selector
  // knowledge lives beside the markup that writes it. Null when there is nothing to measure yet.
  function viewCount(root) {
    const scope = root && typeof root.querySelector === "function" ? root : null;
    if (!scope) return null;
    const scroll = scope.querySelector(".pflow-scroll");
    if (!scroll || typeof scroll.getBoundingClientRect !== "function") return null;
    const box = scroll.getBoundingClientRect();
    const scan = (els) => {
      const tally = { total: els.length, out: 0, left: 0, right: 0 };
      for (const el of els) {
        const r = el.getBoundingClientRect();
        const clippedLeft = r.left < box.left - 0.5;
        const clippedRight = r.right > box.right + 0.5;
        if (!clippedLeft && !clippedRight) continue;
        tally.out += 1;
        // An item wider than the box (a stage column never is) counts for the side its centre is on.
        if (clippedRight && !clippedLeft) tally.right += 1;
        else if (clippedLeft && !clippedRight) tally.left += 1;
        else if (r.left + r.width / 2 < box.left + box.width / 2) tally.left += 1;
        else tally.right += 1;
      }
      return tally;
    };
    const nodes = [...scope.querySelectorAll(".pflow-node")];
    const stages = scan(nodes);
    const notches = scan([...scope.querySelectorAll(".pflow-notch")]);
    const ordinals = nodes
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left < box.right - 0.5 && r.right > box.left + 0.5;
      })
      .map((el) => Number(el.dataset.pos))
      .filter((n) => Number.isInteger(n));
    const view = {
      stages,
      notches,
      first: ordinals.length ? Math.min(...ordinals) : null,
      last: ordinals.length ? Math.max(...ordinals) : null,
      // The scroller's own overflow, which is what decides whether `fit` has anything to do.
      overflow: scroll.scrollWidth > scroll.clientWidth + 1,
    };
    return { ...view, text: countText(view) };
  }

  // The count and the control that answers it, in one row under the drawing. The row starts hidden and is unhidden
  // by the modal's measurement: a drawing that fits owes the reader no sentence, and a clipped one owes them both the
  // number and the way out. `fit` is a reader's deliberate trade (the whole chain against the readable column
  // width), so it is a press, not a resize: nothing re-lays out until they ask.
  function statusHtml(flow, fit) {
    const count = flow.stages.length;
    const id = `pflow-count-${flow.id || "flow"}`;
    const title = fit
      ? `back to the readable column width — ${count} stages scroll again`
      : `fit all ${count} stages in the card — the columns narrow and the titles wrap`;
    return `<div class="pflow-status" data-pflow-status hidden>
        <span class="pflow-count" id="${esc(id)}" data-pflow-count></span>
        <button type="button" class="pflow-fit" data-pflow-fit title="${esc(title)}">${fit ? "actual size" : "fit"}</button>
      </div>`;
  }

  function markup(flow, position = null, { motion = true, fit = false } = {}) {
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
    // The handoff across the gap after each stage — the artifact the connector carries, when the document draws one
    // there. Read from the artifact view rather than a second pass over the handoffs, so the thick connector and the
    // chip that names it cannot disagree about which edge they are.
    const handoffAfter = (index) => {
      const node = f.artifacts.find((n) => n.writerIndex === index && n.edges.some((edge) => edge.kind === EDGE.HANDOFF && edge.to === index + 1));
      if (!node) return null;
      const edge = node.edges.find((e) => e.kind === EDGE.HANDOFF && e.to === index + 1);
      return { artifact: node.id, edge: edge.edge };
    };
    return `<div class="pflow" data-flow-id="${esc(f.id)}" data-flow-stages="${count}" data-artifacts="${f.artifacts.length}" data-motion="${motion ? "on" : "off"}" data-fit="${fit ? "1" : "0"}" data-position="${esc((current && current.id) || "")}" data-refused="${esc((refused && refused.id) || "")}" data-marks-from="${from}" style="--pflow-n:${count};--pflow-pad:${pad}px">
      <div class="pflow-scroll" aria-describedby="${esc(`pflow-count-${f.id || "flow"}`)}">
        <div class="pflow-canvas">
          ${f.lanes ? `<div class="pflow-arcs">${arcsHtml(f, position)}</div>` : ""}
          <ol class="pflow-track" start="1" aria-label="${esc(`${f.title || f.id || "pipeline"} — ${count} stage${count === 1 ? "" : "s"} left to right`)}">${f.stages
            .map((stage, index) => stageHtml(stage, index, count, marks[index].mark, { position, currentIndex, handoff: handoffAfter(index) }))
            .join("")}</ol>
          ${artifactsHtml(f)}
        </div>
      </div>
      ${statusHtml(f, fit)}
      ${legendHtml(marks)}
      ${artifactsKeyHtml(f)}
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
  function render(flow, position = null, { doc = null, motion = null, fit = false } = {}) {
    const d = doc || (global && global.document ? global.document : null);
    if (!d || typeof d.createElement !== "function") return null;
    const box = d.createElement("div");
    box.innerHTML = markup(flow, position, { motion: motion == null ? motionAllowed(d.defaultView || global) : Boolean(motion), fit });
    return box.firstElementChild || null;
  }

  global.PipelineFlow = { MARK, MARK_ORDER, MARK_WORDS, normalize, fromDefinition, fromBundle, fromWindowModel, marksFor, markup, render, motionAllowed, countText, viewCount };
})(typeof window !== "undefined" ? window : globalThis);
