// public/pipeline-map.js — the renderer half of public/pipeline-map.html.
//
// The page is generated from pipelines.seed.json and pipeline-bundle.seed.json by tools/render-pipeline-map.mjs;
// this file owns the drawing, the two layouts and the interaction. It reads ONE thing: the JSON block the page
// carries (window.PIPELINE_MAP_DATA), so it cannot disagree with the seeds the page was built from.
//
// TWO LAYOUTS, ONE MODEL:
//   row   — one mermaid flowchart LR per card, at its natural viewBox size. Labels are 12 px (titles) and 11 px
//           (roles and edge labels) PAINTED at 1:1; the card scrolls horizontally instead of shrinking.
//   book  — the same chain cut into rows of N stages, each row its own mermaid flowchart LR. The row break is a
//           layout choice, drawn by this script as a dashed "continues" arrow; cross-row loop-backs are drawn in
//           the right-hand margin by measureArcs(), from the same painted node rects. Nothing about a stage changes.
//
// Every node is post-processed after mermaid hands the SVG back: data-stage, data-role-source/label, a tab stop,
// role=button, an accessible name, and BOTH a title attribute and an SVG <title> so the prompt is on hover. That is
// the whole integration cost — mermaid has no per-node hooks beyond the id it sanitises from ours.
(function () {
  "use strict";

  const DATA = JSON.parse(document.getElementById("pipeline-map-data").textContent);
  const SVG_NS = "http://www.w3.org/2000/svg";
  const cardsEl = document.getElementById("cards");
  const inspector = document.getElementById("inspector");
  const insTitle = document.getElementById("inspector-title");
  const insWho = document.getElementById("inspector-who");
  const insExit = document.getElementById("inspector-exit");
  const insWhy = document.getElementById("inspector-why");
  const insPromptH = document.getElementById("inspector-prompt-h");
  const insPrompt = document.getElementById("inspector-prompt");
  const drawCount = document.getElementById("draw-count");
  const mermaid = window.mermaid;

  const state = { layout: "row", perRow: 3, gen: 0, selected: null, busy: false };
  const cards = [];

  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  function nodeIdOf(stageOrId) {
    const id = typeof stageOrId === "string" ? stageOrId : stageOrId.id;
    return "n_" + String(id).replace(/[^A-Za-z0-9_]/g, "_");
  }

  // mermaid reads a quoted label as markdown and its parser also understands entity codes. These keep a title's
  // punctuation visible as itself instead of turning it into markup.
  const MERMAID_CODES = { "&": "#amp;", "#": "#35;", "<": "#lt;", ">": "#gt;", '"': "#quot;", _: "#95;", "*": "#42;", "`": "#96;", "|": "#124;" };
  const mtext = (s) => [...String(s == null ? "" : s)].map((c) => MERMAID_CODES[c] ?? c).join("");

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "dark",
    // useMaxWidth:false is a correctness setting here: with the default, mermaid scales the whole SVG to the
    // container and a 12 px label is painted at whatever fraction is left. The page keeps the natural size and
    // scrolls instead, and measureCard() reads the product back so a shrunken label cannot hide.
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
  });

  function loopTag(card, loop) {
    const a = card.stages.find((s) => s.id === loop.from);
    const b = card.stages.find((s) => s.id === loop.to);
    return `${loop.short} ${a ? a.ordinal : "?"}→${b ? b.ordinal : "?"}`;
  }

  function rowSource(card) {
    const lines = ["flowchart LR"];
    for (const stage of card.stages) lines.push(`  ${nodeIdOf(stage)}["${labelFor(stage)}"]`);
    for (const edge of card.edges) {
      lines.push(edge.label
        ? `  ${nodeIdOf(edge.from)} -->|"${mtext(edge.label)}"| ${nodeIdOf(edge.to)}`
        : `  ${nodeIdOf(edge.from)} --> ${nodeIdOf(edge.to)}`);
    }
    for (const loop of card.loops) {
      const cap = loop.cap ? ` · ${loop.cap}` : "";
      lines.push(`  ${nodeIdOf(loop.from)} -.->|"${mtext(loopTag(card, loop) + cap)}"| ${nodeIdOf(loop.to)}`);
    }
    return lines.join("\n");
  }

  function bookRowSource(card, from, to) {
    const lines = ["flowchart LR"];
    for (const stage of card.stages.slice(from, to)) lines.push(`  ${nodeIdOf(stage)}["${labelFor(stage)}"]`);
    for (const edge of card.edges) {
      const fi = card.stages.findIndex((s) => s.id === edge.from);
      const ti = card.stages.findIndex((s) => s.id === edge.to);
      if (fi < from || fi >= to || ti < from || ti >= to) continue;
      lines.push(edge.label
        ? `  ${nodeIdOf(edge.from)} -->|"${mtext(edge.label)}"| ${nodeIdOf(edge.to)}`
        : `  ${nodeIdOf(edge.from)} --> ${nodeIdOf(edge.to)}`);
    }
    return lines.join("\n");
  }

  function labelFor(stage) {
    return `<b>${stage.ordinal}</b> · ${mtext(stage.title)}<br><span class="pm-role">${mtext(stage.role.label)}</span>`;
  }

  // ---- the page shell ---------------------------------------------------------------------------------------------
  function summary() {
    const m = DATA.meta;
    const loops = DATA.pipelines.reduce((n, p) => n + p.loops.length, 0) + DATA.bundle.loops.length;
    const carried = DATA.pipelines.reduce((n, p) => n + p.loops.filter((l) => l.source === "data").length, 0) + DATA.bundle.loops.filter((l) => l.source === "data").length;
    const inferred = loops - carried;
    const stats = [
      [m.totalPipelines, "catalogue definitions"],
      [m.totalStages, "catalogue stage nodes"],
      [m.bundleStages, "bundle stage nodes"],
      [m.totalStages + m.bundleStages, "stage nodes, total"],
      [loops, `loop-backs · ${carried} carried, ${inferred} inferred`],
      [DATA.pipelines.filter((p) => p.next).length, "chains between definitions"],
    ];
    document.getElementById("summary").innerHTML = stats
      .map(([n, label]) => `<div class="stat"><b>${n}</b><span>${esc(label)}</span></div>`)
      .join("");
    const chains = DATA.pipelines.filter((p) => p.next);
    document.getElementById("chains").innerHTML = chains.length
      ? "chains: " + chains.map((p) => `<code>${esc(p.id)}</code> → <code>${esc(p.next)}</code>`).join(" · ")
      : "";
  }

  function chip(text, cls) {
    return `<span class="chip ${cls || ""}">${esc(text)}</span>`;
  }

  function cardShell(item, index, isBundle) {
    const el = document.createElement("section");
    el.className = "pm-card";
    el.dataset.card = item.id;
    el.dataset.bundle = isBundle ? "1" : "0";
    el.dataset.stages = String(item.stages.length);
    const loops = item.loops || [];
    const chips = isBundle
      ? [chip("bundle"), chip(`${item.stages.length} stages`), chip(`${item.gates.length} gates`), chip(`${loops.length} loops`)]
      : [chip(item.kind, "kind"), chip(`${item.stages.length} stage${item.stages.length === 1 ? "" : "s"}`), chip(item.next ? `next: ${item.next}` : "next: end of the chain", item.next ? "next" : ""), item.lastExit && item.lastExit.label ? chip(`last exit: ${item.lastExit.label}`, "last") : ""];
    el.innerHTML = `
      <div class="pm-card-head">
        <span class="pm-idx">${String(index).padStart(2, "0")}</span>
        <div>
          <h2>${esc(item.title)}</h2>
          <p class="pm-desc">${esc(item.description || "")}</p>
        </div>
        <div class="pm-chips">${chips.filter(Boolean).join("")}</div>
      </div>
      <div class="pm-vp"><div class="pm-draw" data-draw data-layout="${esc(state.layout)}"></div></div>
      <div class="pm-status" data-status>drawing…</div>
      <div class="pm-loops"><h3>loop-backs</h3><ul>${loops.length ? loops.map((l) => loopItem(l, item.stages)).join("") : `<li class="dim">none — a catalogue definition is a chain${item.next ? `; it continues into <code>${esc(item.next)}</code>` : ""}.</li>`}</ul></div>
      ${isBundle ? `<div class="pm-loops pm-gates"><h3>gates</h3><ul>${item.gates.map((g) => gateItem(g, item.stages)).join("")}</ul></div>` : ""}`;
    return el;
  }

  function loopItem(loop, stages) {
    const inferred = loop.source === "inferred";
    const nameOf = (id) => {
      const s = (stages || []).find((x) => x.id === id);
      return s ? `${s.id} ${s.title}` : id;
    };
    return `<li><span class="tag" data-loop-source="${esc(loop.source)}">${esc(inferred ? "inferred" : loop.id || loop.short)}</span>
      <code>${esc(nameOf(loop.from))} → ${esc(nameOf(loop.to))}</code>${loop.cap ? ` · cap <code>${esc(loop.cap)}</code>` : ""}${loop.note ? ` · ${esc(loop.note)}` : ""}</li>`;
  }

  function gateItem(gate, stages) {
    const after = (stages || []).find((s) => s.id === gate.after);
    return `<li><span class="tag gate">${esc(gate.id)}</span> <code>${esc(gate.name)}</code> · ${esc(gate.decider)} · after ${esc(after ? `${after.ordinal} ${after.title}` : gate.after)} · verified by ${esc(gate.verifiedBy)}${gate.refusesWhen ? ` · refuses: ${esc(gate.refusesWhen)}` : ""}</li>`;
  }

  function buildCards() {
    DATA.pipelines.forEach((p, i) => {
      const el = cardShell(p, i + 1, false);
      cardsEl.appendChild(el);
      cards.push({ item: p, el, isBundle: false });
    });
    const head = document.createElement("h2");
    head.className = "pm-section";
    head.textContent = "The studio bundle — thirteen stages, five gates";
    head.style.cssText = "font-size:17px;margin:28px 0 10px;letter-spacing:-0.1px";
    cardsEl.appendChild(head);
    const el = cardShell(DATA.bundle, DATA.pipelines.length + 1, true);
    el.querySelector(".pm-card-head .pm-idx").textContent = "B";
    cardsEl.appendChild(el);
    cards.push({ item: DATA.bundle, el, isBundle: true });
  }

  // ---- mermaid ----------------------------------------------------------------------------------------------------
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
    tpl.innerHTML = text.trim();
    return tpl.content.firstElementChild;
  }

  function stageOfNode(node) {
    const m = String((node && node.id) || "").match(/flowchart-(.+?)-\d+$/);
    return m ? m[1] : "";
  }

  function wireNodes(card, draw) {
    for (const node of draw.querySelectorAll("g.node")) {
      const sid = stageOfNode(node);
      const stage = card.item.stages.find((s) => nodeIdOf(s) === sid) || card.item.stages.find((s) => nodeIdOf(s).endsWith(sid));
      if (!stage) continue;
      const hover = stage.prompt || [stage.purpose, stage.role && stage.role.instructions].filter(Boolean).join("\n\n") || stage.title;
      const exitText = stage.exitLabel || stage.exit && stage.exit.check || (stage.gates && stage.gates.length ? `gates ${stage.gates.join(", ")}` : "no exit check");
      node.setAttribute("data-stage", stage.id);
      node.setAttribute("data-role-source", stage.role.source);
      node.setAttribute("data-role-label", stage.role.label);
      node.setAttribute("tabindex", "0");
      node.setAttribute("role", "button");
      node.setAttribute("aria-label", `stage ${stage.ordinal} of ${card.item.stages.length}: ${stage.title}. ${stage.role.label}. ${exitText}.`);
      node.setAttribute("title", hover);
      if (!node.querySelector(":scope > title")) {
        const t = document.createElementNS(SVG_NS, "title");
        t.textContent = hover;
        node.insertBefore(t, node.firstChild);
      }
      node.addEventListener("click", (ev) => { ev.preventDefault(); selectStage(card, stage, node, exitText); });
      node.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); selectStage(card, stage, node, exitText); }
      });
    }
  }

  function wireLoops(card, draw) {
    for (const loop of card.item.loops || []) {
      const prefix = `L_${nodeIdOf(loop.from)}_${nodeIdOf(loop.to)}_`;
      const path = [...draw.querySelectorAll("path.flowchart-link, g.edgePath path")].find((p) => String(p.id).startsWith(prefix));
      if (!path) continue;
      path.classList.add("pm-loop");
      path.setAttribute("data-loop-source", loop.source);
      path.setAttribute("data-loop-id", loop.id || loop.short);
    }
  }

  async function renderCard(card, gen) {
    const draw = card.el.querySelector("[data-draw]");
    draw.dataset.layout = state.layout;
    draw.innerHTML = "";
    draw.removeAttribute("style");
    if (state.layout === "row") {
      const src = rowSource(card.item);
      if (gen !== state.gen) return;
      const out = await mermaid.render(`pm_${gen}_${card.item.id.replace(/[^a-z0-9]/gi, "_")}`, src);
      if (gen !== state.gen) return;
      const svg = svgFrom(out.svg);
      normalize(svg);
      draw.appendChild(svg);
      wireNodes(card, draw);
      wireLoops(card, draw);
      finishCard(card, draw, gen);
      return;
    }

    const n = state.perRow;
    const rows = [];
    for (let i = 0; i < card.item.stages.length; i += n) rows.push([i, Math.min(i + n, card.item.stages.length)]);
    const lanes = (card.item.loops || []).length;
    draw.style.paddingLeft = lanes ? `${16 + 30 * lanes + 56}px` : "16px";
    draw.style.paddingTop = lanes ? "38px" : "10px";
    draw.style.paddingRight = "12px";
    for (const [from, to] of rows) {
      if (gen !== state.gen) return;
      const src = bookRowSource(card.item, from, to);
      const out = await mermaid.render(`pm_${gen}_${card.item.id.replace(/[^a-z0-9]/gi, "_")}_r${from}`, src);
      if (gen !== state.gen) return;
      const row = document.createElement("div");
      row.className = "pm-row";
      row.dataset.row = String(from);
      const label = document.createElement("span");
      label.className = "pm-row-label";
      label.textContent = from + 1 === to ? `stage ${to}` : `stages ${from + 1}–${to}`;
      row.appendChild(label);
      const svg = svgFrom(out.svg);
      normalize(svg);
      row.appendChild(svg);
      draw.appendChild(row);
    }
    wireNodes(card, draw);
    // The arcs are measured from the painted rows; one frame lets the SVGs settle at their natural size.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (gen !== state.gen) return;
    drawBookArcs(card, draw);
    finishCard(card, draw, gen);
  }

  function finishCard(card, draw, gen) {
    card.el.dataset.nodeCount = String(draw.querySelectorAll("g.node[data-stage]").length);
    card.el.dataset.loopCount = String(draw.querySelectorAll("path[data-loop-source]").length);
    card.el.dataset.ready = "1";
    measureCard(card, draw, gen);
  }

  // ---- book mode: the arrows mermaid cannot draw between two diagrams ---------------------------------------------
  function relRect(el, base) {
    const r = el.getBoundingClientRect();
    const b = base.getBoundingClientRect();
    return { left: r.left - b.left, top: r.top - b.top, right: r.right - b.left, bottom: r.bottom - b.top, width: r.width, height: r.height, cx: r.left - b.left + r.width / 2, cy: r.top - b.top + r.height / 2 };
  }

  function drawBookArcs(card, draw) {
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
    defs.appendChild(marker(`pm-cont-${card.item.id}`, "#4a5568"));
    defs.appendChild(marker(`pm-loop-${card.item.id}`, "#b9a2e0"));
    defs.appendChild(marker(`pm-inf-${card.item.id}`, "#f0c674"));
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
      const lastStage = card.item.stages[next - 1];
      const firstStage = card.item.stages[next];
      if (!lastStage || !firstStage) return;
      const a = nodeRect(lastStage.id);
      const b = nodeRect(firstStage.id);
      if (!a || !b) return;
      const midY = a.bottom + 10;
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("class", "pm-cont");
      p.setAttribute("d", `M${a.cx},${a.bottom} L${a.cx},${midY} L${b.cx},${midY} L${b.cx},${b.top - 4}`);
      p.setAttribute("marker-end", `url(#pm-cont-${card.item.id})`);
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
    const loops = (card.item.loops || []).map((loop, i) => {
      const fromRow = card.item.stages.findIndex((s) => s.id === loop.from);
      const toRow = card.item.stages.findIndex((s) => s.id === loop.to);
      return { loop, i, span: Math.abs(fromRow - toRow) };
    }).sort((a, b) => b.span - a.span || a.i - b.i);
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
      p.setAttribute("marker-end", `url(#${entry.loop.source === "inferred" ? "pm-inf" : "pm-loop"}-${card.item.id})`);
      ov.appendChild(p);
      tag(ov, laneX + 4, (yA + yB) / 2 - laneIndex * 14, loopTag(card.item, entry.loop), "pm-arc-label", "#12161c", entry.loop.source);
    });

    // explicit size (a fixed-position overlay is not allowed to stretch its parent)
    ov.setAttribute("height", String(Math.ceil(h)));
    ov.style.width = `${Math.ceil(w)}px`;
    ov.style.height = `${Math.ceil(h)}px`;
    draw.appendChild(ov);
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

  // ---- measurement ------------------------------------------------------------------------------------------------
  function measureCard(card, draw, gen) {
    if (gen !== state.gen) return;
    const status = card.el.querySelector("[data-status]");
    const vp = card.el.querySelector(".pm-vp");
    const svgs = [...draw.querySelectorAll("svg")].filter((s) => !s.classList.contains("pm-arcs"));
    const dr = draw.getBoundingClientRect();
    let maxRight = 0;
    let minLabel = null;
    const count = (el, sel) => el.querySelectorAll(sel).length;
    for (const svg of svgs) {
      const r = svg.getBoundingClientRect();
      maxRight = Math.max(maxRight, r.right - dr.left);
      const vb = svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width ? svg.viewBox.baseVal.width : r.width;
      const scale = vb ? r.width / vb : 1;
      for (const el of svg.querySelectorAll("foreignObject div, text, span.nodeLabel, g.node foreignObject p, g.node .pm-role, .edgeLabel span, .edgeLabel p")) {
        const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!hasText) continue;
        const px = parseFloat(getComputedStyle(el).fontSize);
        if (!px) continue;
        const painted = Math.round(px * scale * 10) / 10;
        if (minLabel == null || painted < minLabel) minLabel = painted;
      }
    }
    for (const t of draw.querySelectorAll(".pm-arcs text")) {
      const px = parseFloat(getComputedStyle(t).fontSize);
      if (px && (minLabel == null || px < minLabel)) minLabel = Math.round(px * 10) / 10;
    }
    const nodes = [...draw.querySelectorAll("g.node[data-stage]")];
    const vpRect = vp.getBoundingClientRect();
    const inView = nodes.filter((n) => { const b = n.getBoundingClientRect(); return b.left >= vpRect.left - 0.5 && b.right <= vpRect.right + 0.5; }).length;
    const hidden = Math.max(0, Math.round(maxRight - vp.clientWidth));
    const loops = (card.item.loops || []).length;
    const carried = (card.item.loops || []).filter((l) => l.source === "data").length;
    const inferred = loops - carried;
    const rows = draw.querySelectorAll(".pm-row").length;
    const parts = [
      `<span><b>${card.item.stages.length}</b> stage${card.item.stages.length === 1 ? "" : "s"}</span>`,
      `<span><b>${count(draw, "g.node[data-stage]")}</b> nodes drawn</span>`,
      `<span><b>${card.item.edges.length}</b> arrows · ${card.item.edges.filter((e) => e.label).length} labelled</span>`,
      `<span><b>${loops}</b> loop${loops === 1 ? "" : "s"}${loops ? ` (${carried} carried${inferred ? `, ${inferred} inferred` : ""})` : ""}</span>`,
      `<span>smallest label <b class="${minLabel != null && minLabel < 11 ? "warn" : ""}">${minLabel == null ? "?" : minLabel} px</b></span>`,
    ];
    if (state.layout === "row") {
      parts.push(hidden ? `<span><b class="warn">${hidden} px</b> past the card — scroll</span>` : "<span>fits the card</span>");
      parts.push(`<span>${inView} of ${nodes.length} in view</span>`);
    } else {
      parts.push(`<span><b>${rows}</b> row${rows === 1 ? "" : "s"} of ${state.perRow}</span>`);
      parts.push(hidden ? `<span><b class="warn">${hidden} px</b> past the card</span>` : `<span>fits the card · <b>${inView} of ${nodes.length}</b> in view</span>`);
    }
    status.innerHTML = parts.join("");
    card.el.dataset.minLabel = String(minLabel == null ? "" : minLabel);
    card.el.dataset.hidden = String(hidden);
    card.el.dataset.rows = String(rows);
  }

  // ---- the inspector ---------------------------------------------------------------------------------------------
  function selectStage(card, stage, node, exitText) {
    for (const n of document.querySelectorAll("g.node[data-selected='1']")) n.removeAttribute("data-selected");
    node.setAttribute("data-selected", "1");
    state.selected = { cardId: card.item.id, stageId: stage.id };
    const bundle = card.isBundle;
    insTitle.textContent = `${stage.ordinal}. ${stage.title}`;
    insWho.textContent = stage.role.label;
    insWho.dataset.roleSource = stage.role.source;
    insExit.textContent = bundle
      ? `${stage.role.owner} · ${stage.role.kind}${stage.role.others && stage.role.others.length ? `; other roles on this stage: ${stage.role.others.join(", ")}` : ""}`
      : `exit: ${exitText}`;
    insWhy.textContent = stage.role.source === "derived"
      ? `derived by rule "${stage.role.rule}" — ${stage.role.why}. The phrase in the prompt: “${stage.role.evidence}”.`
      : `assigned by the bundle — ${stage.role.remit || "the owner's own remit"}.${stage.purpose ? ` Stage purpose: ${stage.purpose}.` : ""}`;
    insPromptH.textContent = bundle ? "purpose and owner instructions" : "prompt";
    insPrompt.textContent = bundle
      ? [stage.purpose, stage.role.instructions].filter(Boolean).join("\n\n")
      : (stage.prompt || "");
    if (bundle) {
      const gates = (DATA.bundle.gates || []).filter((g) => g.after === stage.id);
      if (gates.length) {
        insExit.textContent += ` · gate after: ${gates.map((g) => `${g.id} ${g.name} (${g.decider})`).join(", ")}`;
      }
    }
    inspector.hidden = false;
  }

  function closeInspector() {
    inspector.hidden = true;
    for (const n of document.querySelectorAll("g.node[data-selected='1']")) n.removeAttribute("data-selected");
    state.selected = null;
  }
  document.getElementById("inspector-close").addEventListener("click", closeInspector);
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && !inspector.hidden) closeInspector(); });

  // ---- layout controls -------------------------------------------------------------------------------------------
  function setPressed(group, value, attr) {
    for (const b of document.querySelectorAll(`#${group} button`)) b.setAttribute("aria-pressed", String(b.getAttribute(attr) === String(value)));
  }

  async function renderAll() {
    const gen = ++state.gen;
    state.busy = true;
    document.documentElement.dataset.pipelineMapReady = "0";
    drawCount.textContent = "drawing…";
    drawCount.setAttribute("aria-live", "polite");
    for (const card of cards) card.el.dataset.ready = "0";
    closeInspector();
    for (const card of cards) {
      if (gen !== state.gen) return;
      try {
        await renderCard(card, gen);
      } catch (e) {
        card.el.dataset.ready = "error";
        card.el.querySelector("[data-status]").innerHTML = `<span class="warn">mermaid refused: ${esc((e && e.message) || e)}</span>`;
        console.error("[pipeline-map] " + card.item.id + ": " + ((e && e.message) || e));
      }
      if (gen !== state.gen) return;
      const done = cards.filter((c) => c.el.dataset.ready === "1").length;
      drawCount.textContent = `${done} of ${cards.length} drawn`;
    }
    state.busy = false;
    document.documentElement.dataset.pipelineMapReady = "1";
  }

  for (const btn of document.querySelectorAll("#layout button")) {
    btn.addEventListener("click", () => {
      if (state.busy) return;
      state.layout = btn.dataset.layout;
      setPressed("layout", state.layout, "data-layout");
      for (const b of document.querySelectorAll("#per-row button")) b.disabled = state.layout !== "book";
      renderAll();
    });
  }
  for (const btn of document.querySelectorAll("#per-row button")) {
    btn.disabled = true;
    btn.addEventListener("click", () => {
      if (state.busy) return;
      state.perRow = Number(btn.dataset.n);
      setPressed("per-row", state.perRow, "data-n");
      renderAll();
    });
  }

  window.addEventListener("resize", () => {
    // The drawings keep their natural size; only the book overlay's rects move with the card. Redraw those.
    if (state.layout !== "book" || state.busy) return;
    for (const card of cards) {
      const draw = card.el.querySelector("[data-draw]");
      if (draw && card.el.dataset.ready === "1") drawBookArcs(card, draw);
    }
  });

  summary();
  buildCards();
  setPressed("layout", state.layout, "data-layout");
  renderAll();
})();
