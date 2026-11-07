// public/pipeline-map.js — the renderer half of public/pipeline-map.html.
//
// The page is generated from pipelines.seed.json and pipeline-bundle.seed.json by tools/render-pipeline-map.mjs;
// this file owns the drawing, the two layouts and the interaction. It READS ONE THING it did not build: the JSON
// block the page carries (window.PIPELINE_MAP_DATA), so it cannot disagree with the seeds the page was built from.
//
// IT CAN ALSO DRAW A DOCUMENT THE PAGE DOES NOT CARRY. `open a document` reads a JSON file from disk and
// `?doc=<url|path>` reads one the page can reach; public/core/pipeline-import.js turns either into the same model
// this file draws. Every imported drawing prints the source and its sha256 above the cards, because a drawing that
// does not say where it came from is indistinguishable from the catalogue it was built from. A document that does
// not parse prints an error and leaves the page exactly as it was — a blank canvas is not an acceptable failure.

//
// TWO LAYOUTS, ONE MODEL:
//   row   — one mermaid flowchart LR per card, at its natural viewBox size. Labels are 12 px (titles) and 11 px
//           (roles and edge labels) PAINTED at 1:1; the card scrolls horizontally instead of shrinking.
//   book  — the same chain cut into rows of N stages, each row its own mermaid flowchart LR. The row break is a
//           layout choice, drawn by this script as a dashed "continues" arrow; cross-row loop-backs are drawn in
//           the right-hand margin by measureArcs(), from the same painted node rects. Nothing about a stage changes.
//
// The CARD itself — the mermaid source, the node post-processing (data-stage, data-role-source/label, a tab stop,
// role=button, an accessible name, and BOTH a title attribute and an SVG <title>), the book-mode arcs, the status
// line and the definition-to-card model — is public/core/pipeline-mermaid.js, shared with the flow dialog. This
// file is the PAGE around it: the summary, the provenance line, the import, the layout controls and the inspector.
(async function () {
  "use strict";

  const BUILTIN = JSON.parse(document.getElementById("pipeline-map-data").textContent);
  let DATA = BUILTIN;
  // The built-in model carries `bundles[]` (every pipeline in the bundle file). An imported document may still
  // carry the older single `bundle` — the importer's own model shape — so both are read here, in one place.
  const bundlesOf = (d) => (Array.isArray(d.bundles) ? d.bundles : d.bundle ? [d.bundle] : []);
  const importer = window.wtPipelineImport;
  const cardsEl = document.getElementById("cards");
  const inspector = document.getElementById("inspector");
  const insTitle = document.getElementById("inspector-title");
  const insWho = document.getElementById("inspector-who");
  const insExit = document.getElementById("inspector-exit");
  const insWhy = document.getElementById("inspector-why");
  const insPromptH = document.getElementById("inspector-prompt-h");
  const insPrompt = document.getElementById("inspector-prompt");
  const drawCount = document.getElementById("draw-count");
  const provenanceEl = document.getElementById("provenance");
  const docErrorEl = document.getElementById("doc-error");
  const docFileEl = document.getElementById("doc-file");
  const docRestoreEl = document.getElementById("doc-restore");
  const docStatusEl = document.getElementById("doc-status");

  const state = { layout: "row", perRow: 3, gen: 0, selected: null, busy: false, docSeq: 0 };

  const cards = [];

  // The CARD is not drawn here any more: public/core/pipeline-mermaid.js owns the mermaid render, the node
  // post-processing, the book-mode arcs, the status line and the definition-to-card model, and the flow dialog
  // (public/pipeline-modal.js) draws the same card from the same module. This file is the PAGE around it: the
  // summary, the provenance line, the import, the two layout controls and the inspector those cards feed.
  const M = window.PipelineMermaid;
  if (!M) throw new Error("public/core/pipeline-mermaid.js did not load, so the page cannot draw its cards");
  M.initialize(window.mermaid);
  const esc = M.esc;

  // ---- the page shell ---------------------------------------------------------------------------------------------
  function summary() {
    const m = DATA.meta || {};
    const builtin = DATA === BUILTIN;
    const bundles = bundlesOf(DATA);
    const loops = DATA.pipelines.reduce((n, p) => n + p.loops.length, 0) + bundles.reduce((n, b) => n + b.loops.length, 0);
    const carried = DATA.pipelines.reduce((n, p) => n + p.loops.filter((l) => l.source === "data").length, 0) + bundles.reduce((n, b) => n + b.loops.filter((l) => l.source === "data").length, 0);
    const inferred = loops - carried;
    const stats = [
      [m.totalPipelines, builtin ? "catalogue definitions" : `${m.totalPipelines === 1 ? "definition" : "definitions"} in this document`],
      [m.totalStages, builtin ? "catalogue stage nodes" : `stage node${m.totalStages === 1 ? "" : "s"} in this document`],
    ];
    if (bundles.length) stats.push([m.bundleStages, `bundle stage nodes · ${bundles.length} pipeline${bundles.length === 1 ? "" : "s"}`], [m.totalStages + m.bundleStages, "stage nodes, total"]);
    stats.push(
      [loops, `loop-backs · ${carried} carried, ${inferred} inferred`],
      [DATA.pipelines.filter((p) => p.next).length, "chains between definitions"],
    );
    document.getElementById("summary").innerHTML = stats
      .map(([n, label]) => `<div class="stat"><b>${n}</b><span>${esc(label)}</span></div>`)
      .join("");
    const chains = DATA.pipelines.filter((p) => p.next);
    document.getElementById("chains").innerHTML = chains.length
      ? "chains: " + chains.map((p) => `<code>${esc(p.id)}</code> → <code>${esc(p.next)}</code>`).join(" · ")
      : "";
  }

  function buildCards() {
    DATA.pipelines.forEach((p, i) => {
      const el = M.card(p, {
        index: i + 1,
        layout: state.layout,
        isBundle: false,
        head: true,
        emptyLoops: DATA === BUILTIN ? "a catalogue definition is a chain" : "this document declares no loop",
      });
      cardsEl.appendChild(el);
      cards.push({ item: p, el, isBundle: false });
    });
    const bundles = bundlesOf(DATA);
    if (!bundles.length) return;
    const stages = bundles.reduce((n, b) => n + b.stages.length, 0);
    const gates = bundles.reduce((n, b) => n + (b.gates || []).length, 0);
    const head = document.createElement("h2");
    head.className = "pm-section";
    head.textContent = `The bundle file — ${bundles.length} pipeline${bundles.length === 1 ? "" : "s"}, ${stages} stage${stages === 1 ? "" : "s"}, ${gates} gate${gates === 1 ? "" : "s"}`;
    head.style.cssText = "font-size:17px;margin:28px 0 10px;letter-spacing:-0.1px";
    cardsEl.appendChild(head);
    bundles.forEach((b, i) => {
      const el = M.card(b, {
        index: DATA.pipelines.length + i + 1,
        layout: state.layout,
        isBundle: true,
        head: true,
        emptyLoops: "this document declares no loop",
      });
      el.querySelector(".pm-card-head .pm-idx").textContent = i === 0 ? "B" : `B${i + 1}`;
      cardsEl.appendChild(el);
      cards.push({ item: b, el, isBundle: true });
    });
  }

  // ---- the inspector ---------------------------------------------------------------------------------------------
  function selectStage(card, stage, node, exitText) {
    for (const n of document.querySelectorAll("g.node[data-selected='1']")) n.removeAttribute("data-selected");
    node.setAttribute("data-selected", "1");
    state.selected = { cardId: card.item.id, stageId: stage.id };
    const bundle = card.isBundle;
    const role = stage.role || { source: "unstated", label: "role: not stated" };
    insTitle.textContent = `${stage.ordinal}. ${stage.title}`;
    insWho.textContent = role.label || "role: not stated";
    insWho.dataset.roleSource = role.source || "unstated";
    insExit.textContent = bundle
      ? `${role.owner} · ${role.kind}${role.others && role.others.length ? `; other roles on this stage: ${role.others.join(", ")}` : ""}`
      : `exit: ${exitText}`;
    if (role.source === "derived") {
      insWhy.textContent = `derived by rule "${role.rule}" — ${role.why}. The phrase in the prompt: “${role.evidence}”.`;
    } else if (role.source === "assigned") {
      insWhy.textContent = bundle
        ? `assigned by the bundle — ${role.remit || "the owner's own remit"}.${stage.purpose ? ` Stage purpose: ${stage.purpose}.` : ""}`
        : `assigned by the document — ${role.remit || `it names “${role.owner}” (${role.kind}) as the owner.`}${stage.purpose ? ` Stage purpose: ${stage.purpose}.` : ""}`;
    } else if (role.source === "summary") {
      insWhy.textContent = "this source is an index: it counts the stages and does not name them, so there is nothing more to read here.";
    } else {
      insWhy.textContent = `${role.why || "the document does not say who runs this stage."}${stage.purpose ? ` Stage purpose: ${stage.purpose}.` : ""}`;
    }
    insPromptH.textContent = bundle ? "purpose and owner instructions" : stage.prompt ? "prompt" : stage.purpose ? "purpose" : "nothing to read";
    insPrompt.textContent = bundle
      ? [stage.purpose, role.instructions].filter(Boolean).join("\n\n")
      : stage.prompt || stage.purpose || "";
    const gates = (card.item.gates || []).filter((g) => g.after === stage.id);
    if (gates.length) {
      insExit.textContent += ` · gate after: ${gates.map((g) => `${g.id} ${g.name} (${g.decider})`).join(", ")}`;
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

  // ---- the source line, the import, and the refusal ---------------------------------------------------------------
  // A drawing that does not say where it came from is indistinguishable from the catalogue this page was built
  // from, so the source and its sha256 are printed above the cards for every drawing — the built-in one included.
  function builtinProvenance() {
    return {
      kind: "built-in",
      source: "pipelines.seed.json + pipeline-bundle.seed.json",
      sha256: "",
      bytes: 0,
      stages: BUILTIN.meta.totalStages + BUILTIN.meta.bundleStages,
      cards: BUILTIN.pipelines.length + bundlesOf(BUILTIN).length,
      at: BUILTIN.meta.generatedAt,
      note: "",
    };
  }

  function setProvenance(prov) {
    const root = document.documentElement;
    root.dataset.pipelineSource = prov.kind;
    root.dataset.pipelineDocShape = prov.shape || "";
    root.dataset.pipelineDocSha256 = prov.sha256 || "";
    root.dataset.pipelineDocSource = prov.source || "";
    root.dataset.pipelineDocIds = (prov.ids || []).join(", ");
    root.dataset.pipelineDocStages = String(prov.stages);
    root.dataset.pipelineDocCards = String(prov.cards);
    provenanceEl.dataset.kind = prov.kind;
    provenanceEl.dataset.source = prov.source || "";
    provenanceEl.dataset.sha256 = prov.sha256 || "";
    if (prov.kind === "built-in") {
      const seeds = (BUILTIN.meta.sources || []).filter((s) => /(^|\/)(pipelines|pipeline-bundle)\.seed\.json$/.test(s.file));
      const named = seeds.map((s) => `<code>${esc(s.file)}</code> sha256 <code class="sha">${esc(s.sha256)}</code>`).join(" · ");
      // Every pipeline in the bundle file is drawn, so the line names the count and the stages rather than calling
      // the file "the studio bundle" — a page that drew one of four would be a picture of a library that is not there.
      const bundles = bundlesOf(BUILTIN);
      const bundleLine = bundles.length
        ? ` and <b>${bundles.length}</b> bundle pipeline${bundles.length === 1 ? "" : "s"} (<b>${BUILTIN.meta.bundleStages}</b> stages, the studio's <b>${BUILTIN.meta.studioStages}</b> among them)`
        : "";
      provenanceEl.innerHTML = `<span class="pv-tag">built in</span>this page was rendered from ${named || "its own seeds"} — <b>${BUILTIN.meta.totalPipelines}</b> definitions${bundleLine}. Nothing on this screen was fetched.`;
      return;
    }
    const label = (importer && importer.SHAPES[prov.shape]) || "a document";
    // The document's own id goes on this line beside the sha256, not only in the card it becomes: two documents
    // can share a title, and the id is the one name a reader can match against the factory's index or the studio.
    const ids = (prov.ids || []).filter(Boolean);
    const named = ids.length ? `document <b>${esc(ids.join(", "))}</b> · ` : "";
    provenanceEl.innerHTML = `<span class="pv-tag">imported</span>${named}drawing <b>${esc(prov.source)}</b> · sha256 <code class="sha">${esc(prov.sha256)}</code> · ${prov.bytes} bytes · <b>${prov.stages}</b> stage node${prov.stages === 1 ? "" : "s"} in ${prov.cards} card${prov.cards === 1 ? "" : "s"} · read ${esc(String(prov.at || "").replace("T", " ").slice(0, 19))} UTC. The source is ${esc(label)}${prov.note ? ` — ${esc(prov.note)}` : ""}.`;
  }

  function clearDocError() {
    docErrorEl.hidden = true;
    docErrorEl.textContent = "";
    docErrorEl.dataset.target = "";
    delete document.documentElement.dataset.pipelineDocError;
  }

  // Visible, specific, and the drawing is NOT touched: the reader keeps the picture they had and the sentence that
  // says why the new one is not there. An empty canvas would be indistinguishable from a document with no stages.
  function showDocError(target, message) {
    docErrorEl.hidden = false;
    docErrorEl.dataset.target = target || "";
    docErrorEl.textContent = `Could not draw ${target || "that document"}: ${message}. The page is still showing ${DATA === BUILTIN ? "the built-in catalogue" : "the last document it drew"} — nothing was cleared.`;
    document.documentElement.dataset.pipelineDocError = String(message);
    document.documentElement.dataset.pipelineDocLoaded = "0";
    setDocStatus("");
  }

  function setDocStatus(text) {
    docStatusEl.textContent = text || "";
  }

  // Book mode cuts a CHAIN into rows. A document whose arrows converge (six extractors into one runner) or skip a
  // stage would be drawn by it as a sequence that is not in the document — a row break where no handoff exists — so
  // the control is disabled and says why rather than offering a picture that lies.
  function bookAllowed() {
    return DATA.pipelines.concat(bundlesOf(DATA)).every((p) => {
      const stages = p.stages;
      const edges = p.edges || [];
      if (stages.length < 2) return true;
      if (edges.length !== stages.length - 1) return false;
      return edges.every((e, i) => e.from === stages[i].id && e.to === stages[i + 1].id);
    });
  }

  function syncLayoutControls() {
    const allowed = bookAllowed();
    const book = document.querySelector('#layout button[data-layout="book"]');
    if (book) {
      book.disabled = !allowed;
      book.title = allowed
        ? "the same chain wrapped into rows of N stages, like a book page — no horizontal scroll"
        : "this drawing is not one chain — its arrows converge or skip a stage — so book mode would draw a sequence the document does not declare";
    }
    if (state.layout === "book" && !allowed) state.layout = "row";
    setPressed("layout", state.layout, "data-layout");
    for (const b of document.querySelectorAll("#per-row button")) b.disabled = state.layout !== "book";
  }

  async function applyModel(model, prov) {
    DATA = model;
    closeInspector();
    cardsEl.innerHTML = "";
    cards.length = 0;
    docRestoreEl.hidden = false;
    setProvenance(prov);
    summary();
    buildCards();
    syncLayoutControls();
    await renderAll();
    document.documentElement.dataset.pipelineDocSeq = String(++state.docSeq);
    document.documentElement.dataset.pipelineDocLoaded = "1";
  }

  async function importText(text, meta) {
    const parsed = importer.parse(text);
    const adapted = importer.adapt(parsed, meta);
    const prov = {
      kind: "document",
      shape: adapted.shape,
      // The document's own ids, printed beside its sha256: an index or a catalogue can carry several, and a
      // reader matching a shot to a factory must be able to read the id off the page rather than the title.
      ids: adapted.model.pipelines.map((p) => p.id).filter(Boolean),
      source: meta.source,
      sha256: meta.sha256,
      bytes: meta.bytes,
      at: new Date().toISOString(),
      note: (adapted.model.meta.import && adapted.model.meta.import.note) || "",
      stages: adapted.model.meta.totalStages,
      cards: adapted.model.pipelines.length,
    };
    clearDocError();
    setDocStatus("drawing…");
    await applyModel(adapted.model, prov);
    setDocStatus(`drew ${prov.stages} stage node${prov.stages === 1 ? "" : "s"}`);
  }

  // A path is read from the page's own origin. An http(s) URL is read through the panel's `GET /api/pipeline-doc`:
  // a page on 127.0.0.1:<panel port> cannot fetch 127.0.0.1:8090 itself, because the factory sends no CORS header
  // and the browser is right to refuse. The panel is the reader's own machine, which is the one place that read is
  // allowed to happen.
  async function readDoc(target) {
    const t = String(target || "").trim();
    if (!t) throw new importer.DocError("no document named");
    if (/^https?:\/\//i.test(t)) {
      const bases = [];
      if (location.protocol === "http:" || location.protocol === "https:") bases.push(location.origin);
      if (!bases.includes("http://127.0.0.1:7331")) bases.push("http://127.0.0.1:7331");
      let last = null;
      for (const base of bases) {
        let res;
        try {
          res = await fetch(`${base}/api/pipeline-doc?url=${encodeURIComponent(t)}`, { headers: { accept: "application/json" } });
        } catch (e) {
          last = e;
          continue;
        }
        if (res.status === 404) { last = new Error(`${base} does not serve /api/pipeline-doc`); continue; }
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || body.ok === false) {
          throw new importer.DocError((body && body.error) || `HTTP ${res.status} from ${base}`);
        }
        return { text: body.text, bytes: body.bytes, sha256: body.sha256, source: body.finalUrl || body.source || t, via: "panel" };
      }
      throw new importer.DocError(`the panel could not read ${t}${last ? ` — ${last.message}` : ""}${location.protocol === "file:" ? ". This page is open from a file, so it cannot reach the panel; open it from the panel's own URL, or use the file input" : ""}`);
    }
    const url = new URL(t, location.href);
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new importer.DocError(`could not read ${url.href} — ${e.message}. A path is fetched from the page's own origin; from a file:// page use the file input, or name an http(s) URL`);
    }
    if (!res.ok) throw new importer.DocError(`${url.href} answered HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { text: importer.decode(bytes), bytes: bytes.length, sha256: await importer.sha256Hex(bytes), source: url.href, via: "path" };
  }

  async function loadDocTarget(target) {
    setDocStatus(`reading ${target}…`);
    try {
      const read = await readDoc(target);
      await importText(read.text, { source: read.source, sha256: read.sha256, bytes: read.bytes, via: read.via });
    } catch (e) {
      showDocError(String(target), (e && e.message) || String(e));
    }
  }

  async function restoreBuiltIn() {
    try { history.replaceState(null, "", location.pathname); } catch { /* a file:// page may refuse; the drawing is what matters */ }
    clearDocError();
    DATA = BUILTIN;
    cardsEl.innerHTML = "";
    cards.length = 0;
    closeInspector();
    docRestoreEl.hidden = true;
    setDocStatus("");
    setProvenance(builtinProvenance());
    summary();
    buildCards();
    syncLayoutControls();
    await renderAll();
    document.documentElement.dataset.pipelineDocSeq = String(++state.docSeq);
    document.documentElement.dataset.pipelineDocLoaded = "1";
  }

  docFileEl.addEventListener("change", async () => {
    const file = docFileEl.files && docFileEl.files[0];
    docFileEl.value = "";
    if (!file) return;
    setDocStatus(`reading ${file.name}…`);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sha = await importer.sha256Hex(bytes);
      await importText(importer.decode(bytes), { source: `file: ${file.name}`, sha256: sha, bytes: bytes.length, via: "file" });
    } catch (e) {
      showDocError(`file: ${file.name}`, (e && e.message) || String(e));
    }
  });
  docRestoreEl.addEventListener("click", () => { restoreBuiltIn(); });

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
        // The card is the shared renderer's: the same model, the same mermaid source, the same post-processing the
        // flow dialog's Preview runs. `live` abandons a render whose generation a layout press has already replaced.
        await M.paint(card, {
          layout: state.layout,
          perRow: state.perRow,
          live: () => gen === state.gen,
          ns: "map",
          onSelect: (record, stage, node, exitText) => selectStage(record, stage, node, exitText),
        });
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
      if (btn.dataset.layout === "book" && !bookAllowed()) return;
      state.layout = btn.dataset.layout;
      syncLayoutControls();
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
      if (draw && card.el.dataset.ready === "1") M.drawArcs(card, draw);
    }
  });

  // ---- boot -------------------------------------------------------------------------------------------------------
  // The built-in catalogue is drawn FIRST, always: a `?doc=` that cannot be read then leaves a reader looking at
  // the page they would have had without it, plus one sentence saying what went wrong.
  setProvenance(builtinProvenance());
  summary();
  buildCards();
  syncLayoutControls();
  await renderAll();
  const docParam = new URLSearchParams(location.search).get("doc");
  if (docParam) await loadDocTarget(docParam);
})();
