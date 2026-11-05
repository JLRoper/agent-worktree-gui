// public/core/pipeline-import.js — what a document must say before the map will draw it.
//
// public/pipeline-map.html is generated from pipelines.seed.json and pipeline-bundle.seed.json, so a drawing of
// anything ELSE has to come from a document the reader hands the page: the file input, or `?doc=<url|path>`. This
// file is the half that reads that document and turns it into the page's own model, and it is the same code the
// page runs and test/pipeline-import.test.js drives — a classic script that assigns globalThis.wtPipelineImport,
// like public/core/deliver-kinds.js, because the page must still open from file:// with no module loader.
//
// FIVE SHAPES, ONE MODEL. The page draws `{meta, pipelines[], bundle}`. What arrives is one of:
//
//   page        the map's own data block ({meta, pipelines, bundle}) — a round trip, drawn as it left;
//   panel       the panel's catalogue document ({pipelines: {...}} or {pipelines: [...]}) — one card per definition;
//   studio      an exported studio document ({project, stages[], handoffs[], gates[], roles[]}) — one card;
//   definition  a single catalogue definition ({id, kind, stages[]}) — one card;
//   index       the factory's `GET /api/pipelines` ([{id, title, stageCount}]) — one card per entry, whose stage
//               nodes are COUNTED and not named, because the index does not serve a stage's name.
//
// NONE OF THIS INVENTS A FACT. A catalogue stage has no role field, so its line says "role: not stated" rather
// than guessing one. A studio stage's role is its own `owner.role`, looked up in the document's `roles[]`; a
// handoff becomes an arrow, a handoff of kind "loop" becomes a dashed one, a gate labels the arrow that leaves its
// stage. A document that cannot be read as any of the five shapes throws a DocError whose message the page prints —
// the alternative, an empty canvas, is indistinguishable from a document with no stages in it.
(function (root) {
  "use strict";

  class DocError extends Error {
    constructor(message) {
      super(message);
      this.name = "DocError";
    }
  }

  const SHAPES = {
    page: "the map's own data block",
    panel: "a panel catalogue",
    studio: "an exported studio document",
    definition: "a catalogue definition",
    index: "a pipeline index",
  };

  const textOf = (v) => (typeof v === "string" ? v.trim() : "");
  const oneLine = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const isObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);

  // The edge label the panel's own renderer uses: the check's name and only the parameters that fit on 11 px.
  const basename = (p) => String(p || "").split(/[\\/]/).pop();
  function compactExit(exit) {
    if (!exit || !exit.check) return "";
    if (exit.check === "commits") return `${exit.check} ≥ ${Number(exit.min) || 1}`;
    if (exit.check === "file-exists") return `${exit.check} ${basename(exit.path)}`;
    if (exit.check === "command") return `${exit.check}: ${(exit.argv || []).join(" ")}`;
    return String(exit.check);
  }

  // A studio stage's exit lives in `done[]` (its exit checks) rather than in the panel's `exit` object. The
  // arrow names the first check and counts the rest; the inspector carries nothing more, because the document's
  // own command text is the stage's business and not an 11 px label's.
  function exitLabelOf(stage, exit) {
    if (exit && exit.check) return compactExit(exit);
    const done = Array.isArray(stage && stage.done) ? stage.done.filter((d) => d && (d.check_id || d.command)) : [];
    if (!done.length) return "";
    const first = textOf(done[0].check_id) || `exit ${done[0].command}`.slice(0, 40);
    return done.length > 1 ? `${first} +${done.length - 1}` : first;
  }

  function roleOf(stage, rolesById) {
    const role = isObject(stage.role) ? stage.role : null;
    // An exported page model already carries a role this renderer built (derived/assigned). Keep it verbatim: the
    // round trip must draw what it drew, not re-derive it.
    if (role && textOf(role.label)) return role;
    const owner = isObject(stage.owner) ? stage.owner : {};
    const roleId = textOf(owner.role) || textOf(stage.roleId) || (typeof stage.role === "string" ? stage.role : "");
    const named = roleId ? rolesById.get(roleId) : null;
    if (named) {
      return {
        source: "assigned",
        ownerId: textOf(named.id) || roleId,
        owner: oneLine(named.name || named.id || roleId),
        kind: oneLine(named.kind || "role"),
        others: [],
        label: `role: ${oneLine(named.name || named.id || roleId)} · ${oneLine(named.kind || "role")}`,
        remit: oneLine(named.remit),
        instructions: oneLine(named.instructions),
      };
    }
    if (roleId || textOf(owner.kind)) {
      const ownerName = textOf(owner.name) || roleId || "the document's owner";
      const kind = textOf(owner.kind) || "owner";
      return {
        source: "assigned",
        ownerId: roleId,
        owner: oneLine(ownerName),
        kind: oneLine(kind),
        others: [],
        label: `role: ${oneLine(ownerName)} · ${oneLine(kind)}`,
        remit: "",
        instructions: "",
      };
    }
    return {
      source: "unstated",
      ownerId: "",
      owner: "",
      kind: "",
      others: [],
      label: "role: not stated",
      why: "the document names no owner for this stage, and its roles[] has no entry to read",
    };
  }

  function stagesOf(def, rolesById) {
    return def.stages.map((st, i) => {
      const stage = isObject(st) ? st : {};
      const id = textOf(stage.id) || `stage-${i + 1}`;
      const exit = isObject(stage.exit) ? stage.exit : null;
      return {
        id,
        ordinal: i + 1,
        title: oneLine(stage.title || stage.name || stage.id || `stage ${i + 1}`),
        prompt: typeof stage.prompt === "string" ? stage.prompt : "",
        purpose: oneLine(stage.purpose || stage.description || ""),
        role: roleOf(stage, rolesById),
        exit,
        exitLabel: exitLabelOf(stage, exit),
      };
    });
  }

  function gatesOf(def) {
    return (Array.isArray(def.gates) ? def.gates : []).filter(isObject).map((g) => ({
      id: textOf(g.id) || "gate",
      after: textOf(g.after),
      name: oneLine(g.name || g.id || "gate"),
      decider: oneLine(g.decider || g.decided_by || "unstated"),
      artifact: oneLine(g.artifact),
      verifiedBy: oneLine(g.verified_by || g.verifiedBy || ""),
      refusesWhen: oneLine(g.refuses_when || g.refusesWhen || ""),
      timebox: oneLine(isObject(g.timebox) ? `${g.timebox.minutes || "?"} minutes` : g.timebox),
      reads: (Array.isArray(g.reads) ? g.reads : []).map(oneLine),
      mayNotRead: (Array.isArray(g.may_not_read) ? g.may_not_read : []).map(oneLine),
    }));
  }

  // The arrows: a studio document's handoffs are its edges; a catalogue definition is a chain. A handoff whose
  // kind is not "sequence" (the language's "loop") is drawn by loopsOf, never twice.
  function edgesOf(def, stages, gates) {
    const ids = new Set(stages.map((s) => s.id));
    const gateAfter = new Map(gates.map((g) => [g.after, g]));
    const handoffs = (Array.isArray(def.handoffs) ? def.handoffs : []).filter(
      (h) => isObject(h) && textOf(h.kind) === "sequence" && ids.has(textOf(h.from)) && ids.has(textOf(h.to)),
    );
    if (handoffs.length) {
      return handoffs.map((h) => {
        const gate = gateAfter.get(textOf(h.from));
        return {
          from: textOf(h.from),
          to: textOf(h.to),
          label: gate ? `${gate.id} · ${gate.name} (${gate.decider})` : oneLine(h.artifact),
          gate: gate ? gate.id : null,
          artifact: oneLine(h.artifact),
        };
      });
    }
    return stages.slice(0, -1).map((s, i) => ({ from: s.id, to: stages[i + 1].id, label: s.exitLabel }));
  }

  function loopsOf(def) {
    const ids = new Set((Array.isArray(def.stages) ? def.stages : []).map((s) => textOf(s && s.id)));
    const declared = (Array.isArray(def.handoffs) ? def.handoffs : []).filter(
      (h) => isObject(h) && textOf(h.kind) === "loop" && ids.has(textOf(h.from)) && ids.has(textOf(h.to)),
    );
    const fromData = Array.isArray(def.loops) ? def.loops.filter(isObject) : [];
    return declared
      .map((h) => ({
        id: textOf(h.id) || "",
        from: textOf(h.from),
        to: textOf(h.to),
        cap: oneLine(h.cap),
        label: `${textOf(h.id) ? textOf(h.id) + " · " : ""}${oneLine(h.cap) || "loop"}`,
        short: textOf(h.id) || "loop",
        source: "data",
        note: oneLine(h.note),
      }))
      .concat(
        fromData
          .filter((l) => textOf(l.from) && textOf(l.to))
          .map((l) => ({
            id: textOf(l.id) || "",
            from: textOf(l.from),
            to: textOf(l.to),
            cap: oneLine(l.cap),
            label: `${textOf(l.id) ? textOf(l.id) + " · " : ""}${oneLine(l.label) || oneLine(l.cap) || "loop"}`,
            short: textOf(l.id) || "loop",
            source: "data",
            note: oneLine(l.note),
          })),
      );
  }

  function isDefinition(v) {
    return isObject(v) && Array.isArray(v.stages);
  }

  function isIndexEntry(v) {
    return isObject(v) && !Array.isArray(v.stages) && Number.isFinite(Number(v.stageCount));
  }

  function pipelineOf(def, index, rolesById) {
    if (!Array.isArray(def.stages) || def.stages.length === 0) {
      const id = textOf(def.id) || textOf(def.project && def.project.id) || `definition ${index + 1}`;
      throw new DocError(`pipeline "${id}" has no stages[] — a card with nothing in it is not a drawing`);
    }
    const stages = stagesOf(def, rolesById);
    const gates = gatesOf(def);
    const loops = loopsOf(def);
    const last = stages[stages.length - 1];
    return {
      id: textOf(def.id) || textOf(def.project && def.project.id) || `pipeline-${index + 1}`,
      ordinal: index + 1,
      title: oneLine(def.title || def.name || (def.project && def.project.name) || textOf(def.id) || `pipeline ${index + 1}`),
      kind: oneLine(def.kind || def.class || (def.project && def.project.kind) || ""),
      description: oneLine(def.description || (def.project && def.project.description) || ""),
      next: textOf(def.next) || null,
      stages,
      loops,
      gates,
      edges: edgesOf(def, stages, gates),
      lastExit: last ? { stage: last.id, label: last.exitLabel, exit: last.exit } : null,
    };
  }

  function modelOf(pipelines, meta, note) {
    const totalStages = pipelines.reduce((n, p) => n + p.stages.length, 0);
    const totalLoops = pipelines.reduce((n, p) => n + p.loops.length, 0);
    return {
      meta: {
        version: "imported",
        generatedAt: meta.at,
        totalPipelines: pipelines.length,
        totalStages,
        bundleStages: 0,
        totalLoops,
        roleRules: [],
        sources: [
          {
            file: meta.source || "(unnamed)",
            role: "imported document",
            exists: true,
            bytes: Number(meta.bytes) || 0,
            sha256: meta.sha256 || "",
          },
        ],
        import: {
          shape: meta.shape,
          source: meta.source,
          sha256: meta.sha256,
          bytes: Number(meta.bytes) || 0,
          at: meta.at,
          note,
        },
      },
      pipelines,
      bundle: null,
    };
  }

  function indexModel(entries, meta) {
    const pipelines = entries.map((entry, i) => {
      const count = Math.trunc(Number(entry.stageCount));
      const id = textOf(entry.id) || `pipeline-${i + 1}`;
      if (!Number.isFinite(count) || count < 1) {
        throw new DocError(`index entry "${id}" carries stageCount ${JSON.stringify(entry.stageCount)} — a count of zero cannot be drawn`);
      }
      const stages = Array.from({ length: count }, (_, k) => ({
        id: `stage-${k + 1}`,
        ordinal: k + 1,
        title: `stage ${k + 1}`,
        prompt: "",
        purpose: "",
        role: {
          source: "summary",
          ownerId: "",
          owner: "",
          kind: "",
          others: [],
          label: "counted only",
          why: "the source counts this pipeline's stages; it does not name them",
        },
        exit: null,
        exitLabel: "",
      }));
      return {
        id,
        ordinal: i + 1,
        title: oneLine(entry.title) || id,
        kind: "index",
        description: `The index names this pipeline and counts its ${count} stages. It does not serve their names or their order, so the nodes below are positions and nothing more.`,
        next: null,
        summaryOnly: true,
        stages,
        loops: [],
        gates: [],
        edges: stages.slice(0, -1).map((s, k) => ({ from: s.id, to: stages[k + 1].id, label: "" })),
        lastExit: null,
      };
    });
    const total = pipelines.reduce((n, p) => n + p.stages.length, 0);
    return modelOf(
      pipelines,
      { ...meta, shape: "index" },
      `${entries.length} pipeline${entries.length === 1 ? "" : "s"}, ${total} stages counted — an index carries no stage names`,
    );
  }

  function definitionsOf(value) {
    if (Array.isArray(value)) return value.filter(isObject);
    if (isObject(value)) return Object.values(value).filter(isObject);
    return [];
  }

  function adapt(parsed, meta = {}) {
    const at = meta.at || new Date().toISOString();
    const ctx = { ...meta, at };

    if (parsed == null) throw new DocError("the document is empty");
    if (typeof parsed !== "object") throw new DocError("the document is not a JSON object or list");

    if (Array.isArray(parsed)) {
      if (!parsed.length) throw new DocError("the document is an empty list — there is nothing to draw");
      if (parsed.every(isIndexEntry)) return { model: indexModel(parsed, ctx), shape: "index" };
      if (parsed.every(isDefinition)) {
        const model = modelOf(parsed.map((def, i) => pipelineOf(def, i, new Map())), ctx, `${parsed.length} definitions, ${parsed.reduce((n, d) => n + d.stages.length, 0)} stages`);
        return { model, shape: "panel" };
      }
      throw new DocError("the document is a list, but its entries are neither pipeline definitions (each with stages[]) nor index rows (each with stageCount)");
    }

    // The map's own data block, round-tripped. It already carries every derived role and every drawn loop; the
    // honest thing to do is draw it again rather than re-derive a second time.
    if (isObject(parsed.meta) && Array.isArray(parsed.pipelines) && parsed.pipelines.every(isDefinition)) {
      const model = JSON.parse(JSON.stringify(parsed));
      model.meta = { ...model.meta, import: { ...ctx, shape: "page", note: "the map's own data block" } };
      model.meta.sources = [{ file: ctx.source || "(unnamed)", role: "imported data block", exists: true, bytes: Number(ctx.bytes) || 0, sha256: ctx.sha256 || "" }];
      return { model, shape: "page" };
    }

    if (parsed.pipelines != null) {
      const defs = definitionsOf(parsed.pipelines);
      if (!defs.length) throw new DocError("`pipelines` is there but holds no definition");
      const rolesById = new Map(
        (Array.isArray(parsed.roles) ? parsed.roles : []).filter((r) => isObject(r) && textOf(r.id)).map((r) => [textOf(r.id), r]),
      );
      const pipelines = defs.map((def, i) => pipelineOf(def, i, rolesById));
      const model = modelOf(pipelines, { ...ctx, shape: "panel" }, `${defs.length} definition${defs.length === 1 ? "" : "s"}, ${pipelines.reduce((n, p) => n + p.stages.length, 0)} stages`);
      return { model, shape: "panel" };
    }

    if (Array.isArray(parsed.stages)) {
      const rolesById = new Map(
        (Array.isArray(parsed.roles) ? parsed.roles : []).filter((r) => isObject(r) && textOf(r.id)).map((r) => [textOf(r.id), r]),
      );
      const pipeline = pipelineOf(parsed, 0, rolesById);
      const shape = isObject(parsed.project) ? "studio" : "definition";
      const handoffs = (Array.isArray(parsed.handoffs) ? parsed.handoffs : []).length;
      const gates = (pipeline.gates || []).length;
      const note = shape === "studio"
        ? `${pipeline.stages.length} stages, ${handoffs} handoffs, ${gates} gate${gates === 1 ? "" : "s"}`
        : `${pipeline.stages.length} stages`;
      return { model: modelOf([pipeline], { ...ctx, shape }, note), shape };
    }

    const keys = Object.keys(parsed).slice(0, 8).join(", ") || "(none)";
    throw new DocError(`this JSON is not a pipeline document: it has no \`pipelines\`, no \`stages\` array and no index rows (its keys are ${keys})`);
  }

  function parse(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new DocError(`not JSON — ${String((e && e.message) || e)}`);
    }
  }

  function decode(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(view);
    } catch {
      throw new DocError("the document is not UTF-8 text");
    }
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  async function sha256Hex(bytes) {
    const subtle = root.crypto && root.crypto.subtle;
    if (!subtle) throw new DocError("this browser has no crypto.subtle, so it cannot name the document's sha256 — and a drawing that cannot name its source is not drawn");
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    const digest = await subtle.digest("SHA-256", view);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  root.wtPipelineImport = { DocError, SHAPES, adapt, parse, decode, sha256Hex };
})(typeof globalThis !== "undefined" ? globalThis : this);
