// public/core/pipeline-mermaid.js - ONE mermaid card, drawn by both surfaces that show a pipeline.
//
// The map page (public/pipeline-map.html, script public/pipeline-map.js) and the panel's flow dialog
// (public/pipeline-modal.js) used to be two different drawings of the same thing: the map drew the vendored mermaid
// chart, the dialog drew the hand-built SVG in public/pipeline-flow.js. The reader's question was why the popup
// could not have the map's charts, so this module IS the chart: the two surfaces hand it the same model and read back
// the same card, and there is one place where a stage's label, an edge's label, a loop tag or the status line is
// written.
//
// WHAT IT OWNS
//   - the closed ROLE table and `fromDefinition()`: a catalogue definition (pipelines.seed.json / pipelines.json)
//     becomes the card model the map page draws. tools/render-pipeline-map.mjs evaluates this same file for the
//     page's data block, so the page and the dialog cannot disagree about a role, an ordinal or an exit label.
//   - `card(item, opts)`: the card element - head (optional), scroller, drawing host, status line, loop-backs and
//     gates lists.
//   - `paint(record, opts)`: the mermaid render, the node post-processing (data-stage, role attributes, the prompt on
//     hover), the loop paths, the book-mode arcs and the status line's numbers.
//   - `ensureMermaid()`: the map page inlines mermaid (one file that opens offline); the panel cannot, so this loads
//     the repo's own vendored copy from `/vendor/mermaid.min.js` on first use and initialises it once.
//
// IT IS DATA IN, MARKUP OUT. Nothing here reads a URL, a store or a page state. `paint()` is the only async path, it
// takes a `live()` predicate so a caller whose generation moved on can abandon a render, and it never writes outside
// the card element it was handed.
(function (global) {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const MERMAID_VERSION = "11.4.1";
  const MERMAID_URL = `/vendor/mermaid.min.js?v=${MERMAID_VERSION}`;

  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const oneLine = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

  function nodeIdOf(stageOrId) {
    const id = typeof stageOrId === "string" ? stageOrId : stageOrId.id;
    return "n_" + String(id).replace(/[^A-Za-z0-9_]/g, "_");
  }

  // mermaid reads a quoted label as markdown and its parser also understands entity codes. These keep a title's
  // punctuation visible as itself instead of turning it into markup.
  const MERMAID_CODES = { "&": "#amp;", "#": "#35;", "<": "#lt;", ">": "#gt;", '"': "#quot;", _: "#95;", "*": "#42;", "`": "#96;", "|": "#124;" };
  const mtext = (s) => [...String(s == null ? "" : s)].map((c) => MERMAID_CODES[c] ?? c).join("");

  // ---- the closed role table ---------------------------------------------------------------------------------------
  // Every rule is a sentence the PROMPT actually says. The label names the actor in the prompt's own vocabulary.
  // `why` is the sentence a reader gets when they ask how the line was derived. A rule whose regex does not match the
  // prompt is never used; the strict reader (the page generator) refuses to invent a role, the lenient one (the
  // dialog, which may be looking at a definition the reader is still typing) says "not stated" instead.
  const ROLE_RULES = [
    { id: "merge", re: /Merge the (?:pull request|PR) for/i, label: "worker · merges", why: "the prompt tells the stage to merge the PR on the host" },
    { id: "wait", re: /Read the PR's activities once/i, label: "panel · waits for reviewer", why: "the prompt ends the turn and the panel re-checks on its own clock" },
    { id: "approve", re: /wait for the head to be reviewed/i, label: "reviewer · approves at head", why: "the stage ends only when an approval exists at the head" },
    { id: "answer", re: /For each new comment/i, label: "worker · answers comments", why: "the prompt answers every comment on the PR" },
    { id: "open-pr", re: /Open ONE pull request/i, label: "worker · opens the PR", why: "the prompt opens one PR from the branch into main on the project's host" },
    { id: "push", re: /Push the branch/i, label: "worker · pushes", why: "the prompt pushes the branch and names the panel's permission box as the grant" },
    { id: "branch", re: /Rename this tree's branch/i, label: "worker · renames branch", why: "the prompt renames this tree's branch and nothing else" },
    { id: "version", re: /tools\/version\.mjs suggest/i, label: "worker · version check", why: "the prompt runs node tools/version.mjs suggest and check" },
    { id: "main", re: /git fetch origin/i, label: "worker · confirms main", why: "the prompt fetches origin's main and confirms the merge is reachable" },
    { id: "commit", re: /Commit (?:everything|it on|the evidence)/i, label: "worker · commits", why: "the prompt commits in this tree on the branch" },
    { id: "conclude", re: /Write the conclusion down/i, label: "worker · writes conclusion", why: "the prompt writes the conclusion into docs/investigation.md" },
    { id: "probe", re: /Read, run and probe/i, label: "worker · probes", why: "the prompt reads, runs and probes this tree" },
    { id: "work", re: /Do the work in this tree/i, label: "worker · does the work", why: "the prompt tells the stage to do the work in this tree" },
  ];

  function deriveRole(stage, strict) {
    const prompt = String((stage && stage.prompt) || "");
    for (const rule of ROLE_RULES) {
      const m = rule.re.exec(prompt);
      if (!m) continue;
      const at = m.index;
      const from = Math.max(0, prompt.lastIndexOf(". ", at) + (prompt.lastIndexOf(". ", at) >= 0 ? 2 : 0));
      const endDot = prompt.indexOf(". ", at);
      const sentence = prompt.slice(from, endDot >= 0 ? endDot + 1 : Math.min(prompt.length, at + 240)).trim();
      return {
        source: "derived",
        rule: rule.id,
        label: `derived: ${rule.label}`,
        why: rule.why,
        evidence: m[0],
        quote: oneLine(sentence).slice(0, 220),
      };
    }
    if (strict) throw new Error(`stage ${stage && stage.id}: no role rule matched its prompt — refusing to invent a role`);
    return { source: "unstated", rule: null, label: "role: not stated", why: "no role rule names an actor in this stage's prompt", evidence: "", quote: "" };
  }

  // ---- exit labels -------------------------------------------------------------------------------------------------
  // The edge is the condition the panel evaluates; its label names the check exactly and only carries parameters that
  // fit on an 11 px edge label. The full exit object travels in the data and is printed in the inspector.
  const basename = (p) => String(p || "").split(/[\\/]/).pop();
  function compactExit(exit) {
    if (!exit || !exit.check) return "";
    if (exit.check === "commits") return `${exit.check} \u2265 ${Number(exit.min) || 1}`;
    if (exit.check === "file-exists") return `${exit.check} ${basename(exit.path)}`;
    if (exit.check === "command") return `${exit.check}: ${(exit.argv || []).join(" ")}`;
    if (exit.check === "branch-name") return exit.check;
    return String(exit.check);
  }

  function exitOf(stage) {
    if (!isObject(stage) || !isObject(stage.exit) || !stage.exit.check) return null;
    return { check: stage.exit.check, ...Object.fromEntries(Object.entries(stage.exit).filter(([k]) => k !== "check")) };
  }

  // ---- a catalogue definition, as the card model ---------------------------------------------------------------
  // This is the SAME mapping tools/render-pipeline-map.mjs writes into the page's data block: ordinal from the stage's
  // place, the role from the closed table, the exit label on the edge that leaves the stage, the loops the definition
  // declares, and the one inference sefl-review-loop needs (it is iterative in its prompts and declares no loop).
  function fromDefinition(def, options = {}) {
    const strict = options.strict === true;
    const d = isObject(def) ? def : {};
    const rows = Array.isArray(d.stages) ? d.stages : [];
    const stages = rows.map((st, i) => {
      const stage = isObject(st) ? st : {};
      return {
        id: stage.id,
        ordinal: i + 1,
        title: oneLine(stage.title || stage.id),
        prompt: String(stage.prompt || ""),
        role: deriveRole(stage, strict),
        exit: exitOf(stage),
        exitLabel: compactExit(stage.exit),
      };
    });
    const loops = [];
    for (const loop of Array.isArray(d.loops) ? d.loops : []) {
      if (!loop || !loop.from || !loop.to) continue;
      loops.push({
        id: oneLine(loop.id) || "",
        from: oneLine(loop.from),
        to: oneLine(loop.to),
        cap: oneLine(loop.cap),
        label: `${oneLine(loop.id) ? oneLine(loop.id) + " · " : ""}${oneLine(loop.label) || oneLine(loop.cap) || "loop"}`,
        short: oneLine(loop.id) || "loop",
        source: "data",
        note: oneLine(loop.note),
      });
    }
    if (d.id === "sefl-review-loop" && !loops.length) {
      const approve = stages.find((s) => s.id === "approve");
      const address = stages.find((s) => s.id === "address");
      if (approve && address) {
        loops.push({
          id: "inferred-review-round",
          from: "approve",
          to: "address",
          cap: "",
          label: "inferred · another review round",
          short: "inferred",
          source: "inferred",
          note: "the definition declares no loop (next: null); the round trip is read from the prompts — a change request at Wait for the approval at the head sends the head back to Answer the review",
        });
      }
    }
    return {
      id: d.id,
      title: oneLine(d.title || d.id),
      kind: oneLine(d.kind),
      description: oneLine(d.description),
      next: d.next == null || d.next === "" ? null : oneLine(d.next),
      stages,
      loops,
      edges: stages.slice(0, -1).map((s, i) => ({ from: s.id, to: stages[i + 1].id, label: s.exitLabel, exit: s.exit })),
      lastExit: stages.length ? { stage: stages[stages.length - 1].id, label: stages[stages.length - 1].exitLabel, exit: stages[stages.length - 1].exit } : null,
    };
  }

  // ---- a PDL pipeline (the bundle's own shape), as the card model -----------------------------------------------
  // A PDL pipeline is not a ladder definition. Its stages carry an artifact and the reads they are handed, its gates
  // end a stage, and its handoffs are the edges (kind "sequence") and the loops (kind "loop", with a cap). Nothing is
  // derived from a prompt, because a PDL stage has none: the second line names the artifact the stage writes, which is
  // the document's own word for what leaves it. This is the mapping tools/render-pipeline-map.mjs writes for the
  // bundle file's pipelines, so the panel's dialog and the map page draw one pipeline the same way.
  const artifactId = (value) => oneLine(isObject(value) ? value.id || value.path : value);

  function fromPdl(pipeline) {
    const d = isObject(pipeline) ? pipeline : {};
    const rows = Array.isArray(d.stages) ? d.stages : [];
    const stages = rows.map((st, i) => {
      const stage = isObject(st) ? st : {};
      const artifact = artifactId(stage.artifact);
      const position = Number(stage.position);
      const reads = (Array.isArray(stage.reads) ? stage.reads : []).map(artifactId).filter(Boolean);
      return {
        id: stage.id,
        ordinal: Number.isFinite(position) && position > 0 ? position : i + 1,
        title: oneLine(stage.title || stage.id),
        prompt: "",
        purpose: artifact ? `writes ${artifact}` : "",
        role: {
          source: "artifact",
          label: artifact ? `writes ${artifact}` : "writes nothing",
          why: "a PDL stage names the artifact it writes; there is no prompt to derive a role from",
          evidence: artifact,
          quote: reads.length ? `reads ${reads.join(", ")}` : "",
        },
        artifact,
        reads,
        exit: null,
        exitLabel: "",
      };
    });
    const gates = (Array.isArray(d.gates) ? d.gates : []).filter(isObject).map((g) => ({
      id: g.id,
      after: g.after,
      name: oneLine(g.name),
      decider: oneLine(g.decider),
      artifact: artifactId(g.artifact),
      verifiedBy: oneLine(g.verifiedBy || g.verified_by || artifactId(g.decision)),
      refusesWhen: oneLine(g.refusesWhen || g.refuses_when),
    }));
    const gateAfter = new Map(gates.map((g) => [g.after, g]));
    const order = new Map(stages.map((s, i) => [s.id, i]));
    const handoffs = (Array.isArray(d.handoffs) ? d.handoffs : []).filter(isObject);
    const edges = handoffs
      .filter((h) => h.kind === "sequence" && h.from && h.to)
      .slice()
      .sort((a, b) => (order.get(a.from) ?? 0) - (order.get(b.from) ?? 0))
      .map((h) => {
        const gate = gateAfter.get(h.from);
        return {
          from: h.from,
          to: h.to,
          artifact: artifactId(h.artifact),
          label: gate ? `${gate.id} · ${gate.name} (${gate.decider})` : "",
          gate: gate ? gate.id : null,
        };
      });
    const loops = handoffs
      .filter((h) => h.kind === "loop" && h.from && h.to)
      .map((h) => ({
        id: oneLine(h.id),
        from: h.from,
        to: h.to,
        cap: oneLine(h.cap),
        label: `${oneLine(h.id) ? oneLine(h.id) + " · " : ""}${oneLine(h.cap) || "loop"}`,
        short: oneLine(h.id) || "loop",
        source: "data",
        note: oneLine(h.note),
      }));
    return {
      id: d.id,
      title: oneLine(d.title || d.id),
      kind: "pdl",
      description: oneLine(d.description),
      next: null,
      stages,
      gates,
      edges,
      loops,
      lastExit: null,
      pdl: true,
    };
  }

  // ---- mermaid ----------------------------------------------------------------------------------------------------
  // useMaxWidth:false is a correctness setting here: with the default, mermaid scales the whole SVG to the container
  // and a 12 px label is painted at whatever fraction is left. Both surfaces keep the natural size and scroll
  // instead, and `measure()` reads the product back so a shrunken label cannot hide.
  const CONFIG = {
    startOnLoad: false,
    securityLevel: "strict",
    theme: "dark",
    flowchart: { htmlLabels: true, curve: "basis", nodeSpacing: 30, rankSpacing: 64, padding: 8, useMaxWidth: false, wrappingWidth: 380 },
    themeVariables: {
      fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, "SF Mono", Menlo, monospace',
      fontSize: "12px",
      primaryColor: "#1b212a",
      primaryTextColor: "#e6e9ef",
      primaryBorderColor: "#39414f",
      lineColor: "#5b6675",
      tertiaryColor: "#151a21",
      background: "#12161c",
    },
  };

  let initialised = false;
  function initialize(mermaid) {
    if (!mermaid || typeof mermaid.initialize !== "function" || initialised) return mermaid;
    mermaid.initialize(CONFIG);
    initialised = true;
    return mermaid;
  }

  let loading = null;
  // The map page has `window.mermaid` (inlined); the panel does not, so the first preview loads the repo's own
  // vendored copy once. A failed load clears the promise, so a corrected URL can be retried without a reload.
  function ensureMermaid(options = {}) {
    const win = options.window || global;
    if (win.mermaid) return Promise.resolve(initialize(win.mermaid));
    if (loading) return loading;
    const doc = win.document;
    if (!doc || !doc.head) return Promise.reject(new Error("no document to load mermaid into"));
    loading = new Promise((resolve, reject) => {
      const script = doc.createElement("script");
      script.src = options.url || MERMAID_URL;
      script.async = true;
      script.onload = () => {
        if (!win.mermaid) {
          loading = null;
          reject(new Error(`mermaid loaded from ${script.src} but published nothing`));
          return;
        }
        resolve(initialize(win.mermaid));
      };
      script.onerror = () => {
        loading = null;
        reject(new Error(`mermaid could not be read from ${script.src}`));
      };
      doc.head.appendChild(script);
    });
    return loading;
  }

  let seq = 0;
  const renderId = (ns, id) => `pm_${String(ns || "c").replace(/[^a-z0-9]/gi, "_")}_${++seq}_${String(id).replace(/[^a-z0-9]/gi, "_")}`;

  function normalize(svg) {
    if (!svg || !svg.viewBox || !svg.viewBox.baseVal || !svg.viewBox.baseVal.width) return;
    const vb = svg.viewBox.baseVal;
    svg.removeAttribute("style");
    svg.setAttribute("width", String(Math.ceil(vb.width)));
    svg.setAttribute("height", String(Math.ceil(vb.height)));
    svg.style.maxWidth = "none";
    svg.style.height = "auto";
  }

  function svgFrom(text) {
    const tpl = document.createElement("template");
    tpl.innerHTML = String(text || "").trim();
    return tpl.content.firstElementChild;
  }

  function stageOfNode(node) {
    const m = String((node && node.id) || "").match(/flowchart-(.+?)-\d+$/);
    return m ? m[1] : "";
  }

  // ---- mermaid sources --------------------------------------------------------------------------------------------
  function loopTag(item, loop) {
    const a = item.stages.find((s) => s.id === loop.from);
    const b = item.stages.find((s) => s.id === loop.to);
    return `${loop.short} ${a ? a.ordinal : "?"}\u2192${b ? b.ordinal : "?"}`;
  }

  function labelFor(stage) {
    return `<b>${stage.ordinal}</b> · ${mtext(stage.title)}<br><span class="pm-role">${mtext(stage.role && stage.role.label)}</span>`;
  }

  function rowSource(item) {
    const lines = ["flowchart LR"];
    for (const stage of item.stages) lines.push(`  ${nodeIdOf(stage)}["${labelFor(stage)}"]`);
    for (const edge of item.edges || []) {
      lines.push(edge.label ? `  ${nodeIdOf(edge.from)} -->|"${mtext(edge.label)}"| ${nodeIdOf(edge.to)}` : `  ${nodeIdOf(edge.from)} --> ${nodeIdOf(edge.to)}`);
    }
    for (const loop of item.loops || []) {
      const cap = loop.cap ? ` · ${loop.cap}` : "";
      lines.push(`  ${nodeIdOf(loop.from)} -.->|"${mtext(loopTag(item, loop) + cap)}"| ${nodeIdOf(loop.to)}`);
    }
    return lines.join("\n");
  }

  function bookRowSource(item, from, to) {
    const lines = ["flowchart LR"];
    for (const stage of item.stages.slice(from, to)) lines.push(`  ${nodeIdOf(stage)}["${labelFor(stage)}"]`);
    for (const edge of item.edges || []) {
      const fi = item.stages.findIndex((s) => s.id === edge.from);
      const ti = item.stages.findIndex((s) => s.id === edge.to);
      if (fi < from || fi >= to || ti < from || ti >= to) continue;
      lines.push(edge.label ? `  ${nodeIdOf(edge.from)} -->|"${mtext(edge.label)}"| ${nodeIdOf(edge.to)}` : `  ${nodeIdOf(edge.from)} --> ${nodeIdOf(edge.to)}`);
    }
    return lines.join("\n");
  }

  // ---- the card element -------------------------------------------------------------------------------------------
  function chip(text, cls) {
    return `<span class="chip ${cls || ""}">${esc(text)}</span>`;
  }

  function loopItem(loop, stages) {
    const inferred = loop.source === "inferred";
    const nameOf = (id) => {
      const s = (stages || []).find((x) => x.id === id);
      return s ? `${s.id} ${s.title}` : id;
    };
    return `<li><span class="tag" data-loop-source="${esc(loop.source)}">${esc(inferred ? "inferred" : loop.id || loop.short)}</span>
      <code>${esc(nameOf(loop.from))} \u2192 ${esc(nameOf(loop.to))}</code>${loop.cap ? ` · cap <code>${esc(loop.cap)}</code>` : ""}${loop.note ? ` · ${esc(loop.note)}` : ""}</li>`;
  }

  // A gate prints the parts it HAS. A PDL gate names a decider and an artifact and no verifier, and "verified by " with
  // nothing after it is a claim the document never made.
  function gateItem(gate, stages) {
    const after = (stages || []).find((s) => s.id === gate.after);
    const verified = gate.verifiedBy ? ` · verified by ${esc(gate.verifiedBy)}` : "";
    return `<li><span class="tag gate">${esc(gate.id)}</span> <code>${esc(gate.name)}</code> · ${esc(gate.decider)} · after ${esc(after ? `${after.ordinal} ${after.title}` : gate.after)}${verified}${gate.refusesWhen ? ` · refuses: ${esc(gate.refusesWhen)}` : ""}</li>`;
  }

  // `head: false` is the dialog: its bar already names the pipeline, so the card there is the drawing and the lists
  // without a second title band. The map page keeps its head.
  function card(item, options = {}) {
    const el = document.createElement("section");
    el.className = "pm-card";
    el.dataset.card = item.id;
    el.dataset.bundle = options.isBundle ? "1" : "0";
    el.dataset.pdl = item.pdl ? "1" : "0";
    el.dataset.stages = String((item.stages || []).length);
    const loops = item.loops || [];
    // A PDL pipeline is drawn with the bundle's chips (stages, gates, loops) and its own tag: it is one pipeline out of
    // the bundle file, not the whole file.
    const chips = options.isBundle || item.pdl
      ? [chip(item.pdl ? "PDL" : "bundle"), chip(`${item.stages.length} stages`), chip(`${(item.gates || []).length} gates`), chip(`${loops.length} loops`)]
      : [
          item.kind ? chip(item.kind, "kind") : "",
          chip(`${item.stages.length} stage${item.stages.length === 1 ? "" : "s"}`),
          item.summaryOnly ? chip("index · stage names not served", "last") : "",
          item.next ? chip(`next: ${item.next}`, "next") : chip("next: end of the chain", ""),
          item.lastExit && item.lastExit.label ? chip(`last exit: ${item.lastExit.label}`, "last") : "",
        ];
    const head =
      options.head === false
        ? ""
        : `<div class="pm-card-head">
        <span class="pm-idx">${String(options.index == null ? "" : options.index).padStart(2, "0")}</span>
        <div>
          <h2>${esc(item.title)}</h2>
          <p class="pm-desc">${esc(item.description || "")}</p>
        </div>
        <div class="pm-chips">${chips.filter(Boolean).join("")}</div>
      </div>`;
    const emptyLoops = options.emptyLoops || "a catalogue definition is a chain";
    el.innerHTML = `${head}
      <div class="pm-vp"><div class="pm-draw" data-draw data-layout="${esc(options.layout || "row")}"></div></div>
      <div class="pm-status" data-status>drawing…</div>
      <div class="pm-loops"><h3>loop-backs</h3><ul>${loops.length ? loops.map((l) => loopItem(l, item.stages)).join("") : `<li class="dim">none — ${esc(emptyLoops)}${item.next ? `; it continues into <code>${esc(item.next)}</code>` : ""}.</li>`}</ul></div>
      ${(item.gates || []).length ? `<div class="pm-loops pm-gates"><h3>gates</h3><ul>${item.gates.map((g) => gateItem(g, item.stages)).join("")}</ul></div>` : ""}`;
    return el;
  }

  // ---- the drawing ------------------------------------------------------------------------------------------------
  function wireNodes(record, draw, options) {
    const onSelect = typeof options.onSelect === "function" ? options.onSelect : null;
    for (const node of draw.querySelectorAll("g.node")) {
      const sid = stageOfNode(node);
      const stage = record.item.stages.find((s) => nodeIdOf(s) === sid) || record.item.stages.find((s) => nodeIdOf(s).endsWith(sid));
      if (!stage) continue;
      const hover = stage.prompt || [stage.purpose, stage.role && stage.role.instructions].filter(Boolean).join("\n\n") || stage.title;
      const exitText = stage.exitLabel || (stage.exit && stage.exit.check) || (stage.gates && stage.gates.length ? `gates ${stage.gates.join(", ")}` : "no exit check");
      node.setAttribute("data-stage", stage.id);
      node.setAttribute("data-role-source", stage.role.source);
      node.setAttribute("data-role-label", stage.role.label);
      node.setAttribute("title", hover);
      node.setAttribute("aria-label", `stage ${stage.ordinal} of ${record.item.stages.length}: ${stage.title}. ${stage.role.label}. ${exitText}.`);
      if (!node.querySelector(":scope > title")) {
        const t = document.createElementNS(SVG_NS, "title");
        t.textContent = hover;
        node.insertBefore(t, node.firstChild);
      }
      // A node is a BUTTON only where a press does something: the map opens its inspector. The dialog's read-only
      // preview keeps the prompt on hover and the accessible name, and offers no press it would not honour.
      if (!onSelect) continue;
      node.setAttribute("tabindex", "0");
      node.setAttribute("role", "button");
      node.addEventListener("click", (ev) => {
        ev.preventDefault();
        onSelect(record, stage, node, exitText);
      });
      node.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          onSelect(record, stage, node, exitText);
        }
      });
    }
  }

  function wireLoops(record, draw) {
    for (const loop of record.item.loops || []) {
      const prefix = `L_${nodeIdOf(loop.from)}_${nodeIdOf(loop.to)}_`;
      const path = [...draw.querySelectorAll("path.flowchart-link, g.edgePath path")].find((p) => String(p.id).startsWith(prefix));
      if (!path) continue;
      path.classList.add("pm-loop");
      path.setAttribute("data-loop-source", loop.source);
      path.setAttribute("data-loop-id", loop.id || loop.short);
    }
  }

  function finish(record, draw, options) {
    record.el.dataset.nodeCount = String(draw.querySelectorAll("g.node[data-stage]").length);
    record.el.dataset.loopCount = String(draw.querySelectorAll("path[data-loop-source]").length);
    record.el.dataset.ready = "1";
    measure(record, options);
  }

  async function paint(record, options = {}) {
    const draw = record.el.querySelector("[data-draw]");
    if (!draw) return false;
    const layout = options.layout || "row";
    const perRow = Math.max(1, Number(options.perRow) || 3);
    const live = typeof options.live === "function" ? options.live : () => true;
    record.el.dataset.ready = "0";
    draw.dataset.layout = layout;
    draw.innerHTML = "";
    draw.removeAttribute("style");
    if (layout === "row") {
      const src = rowSource(record.item);
      if (!live()) return false;
      const mermaid = await ensureMermaid(options);
      const out = await mermaid.render(renderId(options.ns, record.item.id), src);
      if (!live()) return false;
      const svg = svgFrom(out.svg);
      normalize(svg);
      draw.appendChild(svg);
      wireNodes(record, draw, options);
      wireLoops(record, draw);
      finish(record, draw, options);
      return true;
    }

    const rows = [];
    for (let i = 0; i < record.item.stages.length; i += perRow) rows.push([i, Math.min(i + perRow, record.item.stages.length)]);
    const lanes = (record.item.loops || []).length;
    draw.style.paddingLeft = lanes ? `${16 + 30 * lanes + 56}px` : "16px";
    draw.style.paddingTop = lanes ? "38px" : "10px";
    draw.style.paddingRight = "12px";
    const mermaid = await ensureMermaid(options);
    for (const [from, to] of rows) {
      if (!live()) return false;
      const src = bookRowSource(record.item, from, to);
      const out = await mermaid.render(renderId(options.ns, `${record.item.id}_r${from}`), src);
      if (!live()) return false;
      const row = document.createElement("div");
      row.className = "pm-row";
      row.dataset.row = String(from);
      const label = document.createElement("span");
      label.className = "pm-row-label";
      label.textContent = from + 1 === to ? `stage ${to}` : `stages ${from + 1}\u2013${to}`;
      row.appendChild(label);
      const svg = svgFrom(out.svg);
      normalize(svg);
      row.appendChild(svg);
      draw.appendChild(row);
    }
    wireNodes(record, draw, options);
    // The arcs are measured from the painted rows; one frame lets the SVGs settle at their natural size.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (!live()) return false;
    drawArcs(record, draw);
    finish(record, draw, options);
    return true;
  }

  // ---- book mode: the arrows mermaid cannot draw between two diagrams ---------------------------------------------
  function relRect(el, base) {
    const r = el.getBoundingClientRect();
    const b = base.getBoundingClientRect();
    return {
      left: r.left - b.left,
      top: r.top - b.top,
      right: r.right - b.left,
      bottom: r.bottom - b.top,
      width: r.width,
      height: r.height,
      cx: r.left - b.left + r.width / 2,
      cy: r.top - b.top + r.height / 2,
    };
  }

  function tag(parent, x, y, text, cls, bg, source) {
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", String(Math.round(x)));
    t.setAttribute("y", String(Math.round(y + 4)));
    t.setAttribute("class", cls);
    if (source) t.setAttribute("data-loop-source", source);
    t.textContent = text;
    const width = Math.ceil(text.length * 6.4 + 8);
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(Math.round(x - 4)));
    rect.setAttribute("y", String(Math.round(y - 8)));
    rect.setAttribute("width", String(width));
    rect.setAttribute("height", "15");
    rect.setAttribute("rx", "3");
    rect.setAttribute("fill", bg);
    parent.appendChild(rect);
    parent.appendChild(t);
  }

  function drawArcs(record, drawEl) {
    const draw = drawEl || record.el.querySelector("[data-draw]");
    if (!draw) return;
    const old = draw.querySelector("svg.pm-arcs");
    if (old) old.remove();
    const w = Math.max(draw.scrollWidth, draw.clientWidth);
    const h = Math.max(draw.scrollHeight, draw.clientHeight);
    if (!w || !h) return;
    const ov = document.createElementNS(SVG_NS, "svg");
    ov.classList.add("pm-arcs");
    ov.setAttribute("viewBox", `0 0 ${Math.ceil(w)} ${Math.ceil(h)}`);
    ov.setAttribute("width", String(Math.ceil(w)));
    ov.setAttribute("height", String(Math.ceil(h)));
    ov.setAttribute("aria-hidden", "true");

    const marker = (id, fill) => {
      const m = document.createElementNS(SVG_NS, "marker");
      m.setAttribute("id", id);
      m.setAttribute("markerWidth", "7");
      m.setAttribute("markerHeight", "7");
      m.setAttribute("refX", "6");
      m.setAttribute("refY", "3");
      m.setAttribute("orient", "auto");
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", "M0,0 L6,3 L0,6 z");
      p.setAttribute("fill", fill);
      m.appendChild(p);
      return m;
    };
    const defs = document.createElementNS(SVG_NS, "defs");
    defs.appendChild(marker(`pm-cont-${record.item.id}`, "#4a5568"));
    defs.appendChild(marker(`pm-loop-${record.item.id}`, "#b9a2e0"));
    defs.appendChild(marker(`pm-inf-${record.item.id}`, "#f0c674"));
    ov.appendChild(defs);

    const nodeRect = (id) => {
      const el = draw.querySelector(`g.node[data-stage="${CSS.escape(id)}"]`);
      return el ? relRect(el, draw) : null;
    };

    // chain continuations: a carriage return in the gap between two rows
    const rowEls = [...draw.querySelectorAll(".pm-row")];
    const rowStarts = rowEls.map((row) => Number(row.dataset.row));
    rowStarts.forEach((from, i) => {
      const next = rowStarts[i + 1];
      if (next == null) return;
      const lastStage = record.item.stages[next - 1];
      const firstStage = record.item.stages[next];
      if (!lastStage || !firstStage) return;
      const a = nodeRect(lastStage.id);
      const b = nodeRect(firstStage.id);
      if (!a || !b) return;
      const midY = a.bottom + 10;
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("class", "pm-cont");
      p.setAttribute("d", `M${a.cx},${a.bottom} L${a.cx},${midY} L${b.cx},${midY} L${b.cx},${b.top - 4}`);
      p.setAttribute("marker-end", `url(#pm-cont-${record.item.id})`);
      ov.appendChild(p);
    });

    // loop-backs: a lane in the LEFT margin, entered and left through the gap above each row, so an arc never
    // crosses a node or another row's text. The longest span gets the outermost lane.
    const rowOf = (id) => {
      const el = draw.querySelector(`g.node[data-stage="${CSS.escape(id)}"]`);
      if (!el) return null;
      const row = el.closest(".pm-row");
      return { node: relRect(el, draw), row, start: row ? Number(row.dataset.row) : 0 };
    };
    const rowTop = new Map(rowEls.map((r) => [Number(r.dataset.row), relRect(r, draw).top]));
    const gapUse = new Map();
    const gapY = new Map();
    const yInGap = (loopIndex, start) => {
      const key = `${loopIndex}:${start}`;
      if (gapY.has(key)) return gapY.get(key);
      const n = gapUse.get(start) || 0;
      gapUse.set(start, n + 1);
      const y = Math.max(8, (rowTop.get(start) || 0) - 12 - n * 12);
      gapY.set(key, y);
      return y;
    };
    const loops = (record.item.loops || [])
      .map((loop, i) => {
        const fromRow = record.item.stages.findIndex((s) => s.id === loop.from);
        const toRow = record.item.stages.findIndex((s) => s.id === loop.to);
        return { loop, i, span: Math.abs(fromRow - toRow) };
      })
      .sort((a, b) => b.span - a.span || a.i - b.i);
    loops.forEach((entry, laneIndex) => {
      const a = rowOf(entry.loop.from);
      const b = rowOf(entry.loop.to);
      if (!a || !b) return;
      const laneX = 14 + laneIndex * 30;
      const yA = yInGap(entry.i, a.start);
      const yB = yInGap(entry.i, b.start);
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", `M${a.node.cx},${a.node.top - 4} L${a.node.cx},${yA} H${laneX} V${yB} H${b.node.cx} V${b.node.top - 4}`);
      p.setAttribute("fill", "none");
      p.setAttribute("stroke-width", "1.6");
      p.setAttribute("stroke-dasharray", "5 4");
      p.setAttribute("stroke-linejoin", "round");
      p.setAttribute("data-loop-source", entry.loop.source);
      p.setAttribute("data-loop-id", entry.loop.id || entry.loop.short);
      p.setAttribute("class", "pm-loop");
      p.setAttribute("stroke", entry.loop.source === "inferred" ? "#f0c674" : "#b9a2e0");
      p.setAttribute("marker-end", `url(#${entry.loop.source === "inferred" ? "pm-inf" : "pm-loop"}-${record.item.id})`);
      ov.appendChild(p);
      tag(ov, laneX + 4, (yA + yB) / 2 - laneIndex * 14, loopTag(record.item, entry.loop), "pm-arc-label", "#12161c", entry.loop.source);
    });

    // explicit size (a fixed-position overlay is not allowed to stretch its parent)
    ov.setAttribute("height", String(Math.ceil(h)));
    ov.style.width = `${Math.ceil(w)}px`;
    ov.style.height = `${Math.ceil(h)}px`;
    draw.appendChild(ov);
  }

  // ---- the status line, measured from the painting -----------------------------------------------------------------
  // The numbers a reader sees are the browser's own: the smallest PAINTED label, the pixels past the scroller, the
  // stages actually inside it. Nothing here is a tally of the document.
  function measure(record, options = {}) {
    const layout = options.layout || "row";
    const perRow = Math.max(1, Number(options.perRow) || 3);
    const el = record.el;
    const draw = el.querySelector("[data-draw]");
    const status = el.querySelector("[data-status]");
    const vp = el.querySelector(".pm-vp");
    if (!draw || !status || !vp) return null;
    const svgs = [...draw.querySelectorAll("svg")].filter((s) => !s.classList.contains("pm-arcs"));
    const dr = draw.getBoundingClientRect();
    let maxRight = 0;
    let minLabel = null;
    const count = (root, sel) => root.querySelectorAll(sel).length;
    for (const svg of svgs) {
      const r = svg.getBoundingClientRect();
      maxRight = Math.max(maxRight, r.right - dr.left);
      const vb = svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width ? svg.viewBox.baseVal.width : r.width;
      const scale = vb ? r.width / vb : 1;
      for (const node of svg.querySelectorAll("foreignObject div, text, span.nodeLabel, g.node foreignObject p, g.node .pm-role, .edgeLabel span, .edgeLabel p")) {
        const hasText = [...node.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!hasText) continue;
        const px = parseFloat(global.getComputedStyle(node).fontSize);
        if (!px) continue;
        const painted = Math.round(px * scale * 10) / 10;
        if (minLabel == null || painted < minLabel) minLabel = painted;
      }
    }
    for (const t of draw.querySelectorAll(".pm-arcs text")) {
      const px = parseFloat(global.getComputedStyle(t).fontSize);
      if (px && (minLabel == null || px < minLabel)) minLabel = Math.round(px * 10) / 10;
    }
    const nodes = [...draw.querySelectorAll("g.node[data-stage]")];
    const vpRect = vp.getBoundingClientRect();
    const inView = nodes.filter((n) => {
      const b = n.getBoundingClientRect();
      return b.left >= vpRect.left - 0.5 && b.right <= vpRect.right + 0.5;
    }).length;
    const hidden = Math.max(0, Math.round(maxRight - vp.clientWidth));
    const loops = (record.item.loops || []).length;
    const carried = (record.item.loops || []).filter((l) => l.source === "data").length;
    const inferred = loops - carried;
    const rows = draw.querySelectorAll(".pm-row").length;
    const parts = [
      `<span><b>${record.item.stages.length}</b> stage${record.item.stages.length === 1 ? "" : "s"}</span>`,
      `<span><b>${count(draw, "g.node[data-stage]")}</b> nodes drawn</span>`,
      `<span><b>${(record.item.edges || []).length}</b> arrows · ${(record.item.edges || []).filter((e) => e.label).length} labelled</span>`,
      `<span><b>${loops}</b> loop${loops === 1 ? "" : "s"}${loops ? ` (${carried} carried${inferred ? `, ${inferred} inferred` : ""})` : ""}</span>`,
      `<span>smallest label <b class="${minLabel != null && minLabel < 11 ? "warn" : ""}">${minLabel == null ? "?" : minLabel} px</b></span>`,
    ];
    if (layout === "row") {
      parts.push(hidden ? `<span><b class="warn">${hidden} px</b> past the card — scroll</span>` : "<span>fits the card</span>");
      parts.push(`<span>${inView} of ${nodes.length} in view</span>`);
    } else {
      parts.push(`<span><b>${rows}</b> row${rows === 1 ? "" : "s"} of ${perRow}</span>`);
      parts.push(hidden ? `<span><b class="warn">${hidden} px</b> past the card</span>` : `<span>fits the card · <b>${inView} of ${nodes.length}</b> in view</span>`);
    }
    status.innerHTML = parts.join("");
    const stats = { minLabel, hidden, rows, inView, nodes: nodes.length, loops };
    el.dataset.minLabel = String(minLabel == null ? "" : minLabel);
    el.dataset.hidden = String(hidden);
    el.dataset.rows = String(rows);
    return stats;
  }

  const api = {
    version: MERMAID_VERSION,
    ROLE_RULES,
    CONFIG,
    esc,
    oneLine,
    nodeIdOf,
    mtext,
    labelFor,
    loopTag,
    rowSource,
    bookRowSource,
    compactExit,
    deriveRole,
    fromDefinition,
    fromPdl,
    initialize,
    ensureMermaid,
    card,
    paint,
    measure,
    drawArcs,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.PipelineMermaid = api;
})(typeof window !== "undefined" ? window : globalThis);
