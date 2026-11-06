// The pipeline MODAL: one shell for the two places a pipeline is looked at.
//
//   edit mode      the Pipeline tab's "open the flow" control. The pipeline is a catalogue definition
//                  (pipelines.json over pipelines.seed.json) — stages left to right, each stage's exit check as the
//                  notch on the connector after it, no mark because nothing has been entered yet.
//   position mode  a queue row's flow control. The pipeline is the task pipeline window's own answer for that task
//                  (lib/pipeline-window.js) — the same sequence with the current stage, the ones behind it and the
//                  ones still ahead, its gates as notches, and any capped loop as an arc labelled with its cap.
//
// The callers differ ONLY in mode: both call `open({mode, ...})`, and every mark, notch and arc comes from
// public/pipeline-flow.js. This file owns the dialog's behaviour and nothing else:
//
//   - it is appended to <body>, OUTSIDE #settings and #assistant, and sits at z-index 140 — above the Settings window
//     (120), which is the window the edit-mode press comes from. Nothing in the page is above it that opens on its own;
//   - Escape is handled in the CAPTURE phase on document and stops propagation there. The Settings window closes on a
//     bubble-phase Escape (public/app.js), so without the interception an Esc inside this dialog would close the
//     dialog AND the window behind it. The task pipeline window solves the same collision with a handler on its own
//     host; this one cannot, because its actions come from two windows with different handlers;
//   - Tab wraps inside the card, and the card takes focus on open, so the reader's next key lands in the dialog;
//   - a press on the backdrop closes it; a press inside the card does not, including a press that begins inside and
//     is released outside — and neither press reaches the page, which closes Settings for any click outside its own
//     panel (public/app.js). Without that stop one press closed two surfaces (round 5A's finding 5);
//   - focus returns to the control that opened it (found again by `data-pipe-flow` when a repaint replaced it);
//   - `prefers-reduced-motion: reduce` turns the marks' animation off by `data-motion="off"`, and the stylesheet
//     restates the same rule inside a media query for a page whose script never ran.
//
// The body is rebuilt from the arguments, never mutated in place, except the flow itself: `setPosition` replaces only
// the flow element, so the position control keeps the focus the reader put on it.
(function (global) {
  "use strict";

  if (!global) return;

  const OVERLAY_ID = "pipeline-modal";
  const CARD_ID = "pipeline-modal-card";
  const TITLE_ID = "pipeline-modal-title";
  const TABBABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const MODES = ["edit", "position"];
  // ---- the card as a window ----------------------------------------------------------------------------------------
  // The bar drags the card and the corner grip resizes it. Both are POINTER gestures in VISUAL px (what a pointer
  // arrives in), and every length written back as a style is a LAYOUT px: Settings > Display's page zoom scales the
  // page (`documentElement.style.zoom`), so the two are the same unit only at 100%. This is the arithmetic the
  // deliverables popover already uses, and the reason a drag used to land a panel somewhere the reader did not aim.
  const PM_MARGIN = 8;   // the card never touches a viewport edge
  const PM_MIN_W = 320;  // narrower than this and a stage tile is a smear of wrapped letters
  const PM_MIN_H = 160;
  const PM_SLOP = 3;     // a press that moves less than this is a press on the bar, not a drag

  const esc = (value) =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  // The one open dialog's frame of reference. A record, not a DOM flag, so a test can read what it kept.
  const state = {
    open: false,
    mode: null,
    opener: null,
    flow: null,
    position: null,
    title: "",
    subtitle: "",
    facts: [],
    note: "",
    status: "",
    loading: false,
    preview: false,
    onClose: null,
    wired: false,
    motion: true,
    media: null,
    // `fit` is this dialog's reader-owned layout choice, not the drawing's: the renderer only turns it into a
    // data attribute, and the modal remembers it across a re-render (a position change, a motion change) so a
    // press is not undone by the next frame.
    fit: false,
    // Where the READER put this card, and the gesture in flight. `rect` is a VISUAL rectangle (the unit a pointer
    // arrives in) and null while the stylesheet still centres a card sized to its drawing; once they have dragged or
    // resized it, the card sits at the reader's corner, is as wide as they made it, and its height is CAPPED by
    // `h` while the drawing inside decides how much of that room to use.
    rect: null,
    gesture: null,
    flowWatch: null,
  };

  // Tab and Escape, decided without a page: the index of the focused item and how many there are is the whole input.
  // Returned as a word the handler acts on, so node:test can pin the wrap without a DOM.
  function keyIntent({ key, shift = false, activeIndex = -1, count = 0 } = {}) {
    const k = String(key || "");
    if (k === "Escape") return "close";
    if (k !== "Tab" || count < 1) return null;
    if (shift && activeIndex <= 0) return "last";
    if (!shift && activeIndex >= count - 1) return "first";
    return null;
  }

  // Node has no page: publish the pure key rule (so node:test can pin the wrap) and stop before anything touches a
  // document. In the browser this branch is never taken.
  if (typeof global.document === "undefined") {
    global.PipelineModal = { keyIntent };
    return;
  }

  function matchMotion(doc) {
    try {
      const win = doc.defaultView || global;
      return typeof win.matchMedia === "function" ? !win.matchMedia("(prefers-reduced-motion: reduce)").matches : true;
    } catch {
      return true;
    }
  }

  function overlay(doc = document) {
    let host = doc.getElementById(OVERLAY_ID);
    if (host) return host;
    host = doc.createElement("div");
    host.id = OVERLAY_ID;
    host.className = "pmodal";
    host.hidden = true;
    host.setAttribute("data-mode", "edit");
    host.innerHTML = `<div class="pmodal-card" id="${CARD_ID}" role="dialog" aria-modal="true" aria-labelledby="${TITLE_ID}" tabindex="-1"></div>`;
    doc.body.appendChild(host);
    return host;
  }

  function factsHtml(facts) {
    const list = (Array.isArray(facts) ? facts : []).filter(Boolean);
    if (!list.length) return "";
    return `<div class="pmodal-facts">${list
      .map((fact) => (typeof fact === "string" ? `<span class="mono">${esc(fact)}</span>` : `<span><i>${esc(fact.label || "")}</i> <b class="mono">${esc(fact.value ?? "")}</b></span>`))
      .join("")}</div>`;
  }

  function flowHtml(flow, position, motion, fit = false) {
    if (!flow || !Array.isArray(flow.stages) || !flow.stages.length) {
      return `<div class="pmodal-empty">this pipeline holds no stage, so there is nothing to draw</div>`;
    }
    return global.PipelineFlow.markup(flow, position, { motion, fit });
  }

  // How many columns the drawing needs. The CARD's width is its own policy — `public/style.css` turns this number into
  // `n * 96px + (n - 1) * 26px + 18px`, the track's own floor and gap plus the body's 16 px of horizontal padding and
  // the card's 2 px border — so a one-stage definition opens as a small panel and thirteen stages open wide enough for
  // the readable column width. It is set on the card, not on the flow: a custom property inherits DOWNWARD, and the card
  // is the ancestor that sizes itself from it.
  function stageCount(flow) {
    return flow && Array.isArray(flow.stages) && flow.stages.length ? flow.stages.length : 1;
  }

  function previewHtml(flow, position) {
    if (!state.preview || !flow || !Array.isArray(flow.stages) || !flow.stages.length) return "";
    const stage = String((position && position.stage) || "");
    const refused = String((position && position.refused) || "");
    return `<div class="pmodal-preview" data-pm-preview>
      <span class="pmodal-preview-note">preview — this moves nothing</span>
      <label>position <select data-pm-stage aria-label="preview the flow at another stage">${flow.stages
        .map((s, i) => `<option value="${esc(s.id)}"${s.id === stage ? " selected" : ""}>${esc(`${i + 1}. ${s.title}`)}</option>`)
        .join("")}</select></label>
      <label class="pmodal-check"><input type="checkbox" data-pm-refused aria-label="preview the stage as refused — a gate said no there"${refused ? " checked" : ""} /> stage refused</label>
    </div>`;
  }

  function cardHtml() {
    // The kicker names the thing being looked at, not a verb this dialog does not offer: the surface draws a flow in
    // both modes and has no edit control of its own, so "editing" claimed an action that is not here. The edit-mode
    // caller is the Settings tab, where the edit happens; a dirty draft is the `sub` line's job.
    const kicker = state.mode === "position" ? "pipeline flow · position" : "pipeline flow · definition";
    const body = state.loading
      ? `<div class="pmodal-note">reading this task's pipeline…</div>`
      : `${state.note ? `<div class="pmodal-note">${esc(state.note)}</div>` : ""}${
          state.flow ? `<div class="pmodal-flow" data-pm-flow>${flowHtml(state.flow, state.position, state.motion, state.fit)}</div>` : ""
        }${previewHtml(state.flow, state.position)}`;
    // ONE close control — the ✕ in the header. The footer under it held a second "close" button and a status span no
    // caller ever wrote to: 41 px of card below a drawing that was already the smaller half of the dialog. The status
    // element itself is kept (setStatus() writes to it) and moved up into the bar, where it costs nothing while empty.
    // The facts moved into the header band for the same reason: they are one line of 11 px type about the thing the
    // title names, and as a body row they cost a gap and a padding on both sides of themselves.
    //
    // The MAP is the one control here that leaves the dialog. It is in the bar, in BOTH modes, because the map draws
    // the whole library this dialog draws one member of — a definition in edit mode, a task's pipeline in position
    // mode — and it is an `<a target="_blank">`, so the press opens its own tab and the panel (and the Settings tab
    // the reader is editing in) stays where it was. No click handler of this dialog may swallow it: the card's own
    // `click` listener stops PROPAGATION only, never the default, so the browser's navigation still happens.
    return `<div class="pmodal-bar">
        <span class="pmodal-kicker">${esc(kicker)}</span>
        <b class="pmodal-title" id="${TITLE_ID}">${esc(state.title || "pipeline")}</b>
        ${state.subtitle ? `<span class="pmodal-sub mono">${esc(state.subtitle)}</span>` : ""}
        <span class="spacer"></span>
        <span class="pmodal-status mono" data-pm-status role="status" aria-live="polite">${esc(state.status || "")}</span>
        <span class="pmodal-actions">
          <a class="pmodal-map" data-pm-map href="/pipeline-map.html" target="_blank" rel="noopener" title="open the pipeline map in a new tab — every definition and every bundle pipeline the panel can put a tree on, drawn on one page with each stage's role and exit check. This dialog draws one of them.">map ↗</a>
          <button type="button" class="pmodal-close" data-pm-close title="close (Esc) — focus goes back to the control that opened this" aria-label="close the pipeline flow">✕</button>
        </span>
        ${factsHtml(state.facts)}
      </div>
      <div class="pmodal-body">${body}</div>
      <span class="pmodal-resize" data-pm-resize aria-hidden="true" title="drag to resize this card"></span>`;
  }

  function paint(doc = document) {
    const card = doc.getElementById(CARD_ID);
    if (!card) return;
    card.innerHTML = cardHtml();
    // The card's width comes from the drawing it is about to hold: `--pflow-card-n` is read by `.pmodal-card` in
    // public/style.css. Set on every paint, so a dialog reused for a shorter definition shrinks with it.
    card.style?.setProperty?.("--pflow-card-n", String(stageCount(state.flow)));
    wireContent(doc);
  }

  // Only the flow is replaced by a position change: the preview control is a sibling, so the select the reader is
  // holding on to is not rebuilt under their hands and keeps its focus.
  function paintFlow(doc = document) {
    const box = doc.querySelector("[data-pm-flow]");
    if (!box) return;
    box.innerHTML = flowHtml(state.flow, state.position, state.motion, state.fit);
    // The flow's own position, on its OWN attributes: `data-pm-*` names belong to the preview controls, and a wrapper
    // that carried one of them made `[data-pm-refused]` select two elements (the checkbox and this div).
    box.dataset.flowPosition = String((state.position && state.position.stage) || "");
    box.dataset.flowRefused = String((state.position && state.position.refused) || "");
    // The count is a measurement of the painting, so it is taken (and re-taken on every scroll) from the new subtree;
    // the press listener belongs to the button the renderer just built, not to the one it replaced.
    wireFlow(doc);
  }

  // The count under the drawing, and the `fit` press. Both are measurements, never guesses: every stage and every
  // notch is read against the scroller's own box, so the number a reader sees is the number the browser clipped. The
  // same pass decides whether the control has anything to do — a drawing that fits does not offer it, and the row is
  // hidden rather than printing "all 3 stages in view" under a picture that obviously holds them.
  //
  // It also decides the SHAPE, because the card is a window now: the reader can drag it narrower, and the window can be
  // small. Two shapes, one rule each:
  //
  //   one row  the drawing is a row of the readable 96 px columns; when they do not fit, the row scrolls and the status
  //            row says how many stages are out and offers the compact 56 px row (the `fit` press that was already here).
  //   wrapped  not even the compact row fits - a card ~880 px or narrower for thirteen stages. A single row that narrow
  //            gives each column ~34 px, which turns "Stage 1 - intake" into a stack of single letters: every stage is on
  //            screen and none can be read. So the track wraps into ROWS of the 96 px columns instead
  //            (`.pflow[data-wrap="1"]` in public/style.css): every stage stays on screen, at full type size. The row
  //            ends are marked because only the laid-out page knows which tile is last on its line - a connector stub
  //            after it would point into the row below.
  //
  // Nothing is measured with a canvas or a font metric: two subtractions on the scroller's own client width.
  const PFLOW_COMPACT = 56; // the compact column the `fit` press draws (--pflow-minw under [data-fit="1"])

  function shapeOf(flowEl) {
    const scroll = flowEl.querySelector(".pflow-scroll");
    const nodes = [...flowEl.querySelectorAll(".pflow-node")];
    if (!scroll || !nodes.length || !scroll.clientWidth) return null;
    const n = nodes.length;
    const width = scroll.clientWidth;
    return {
      nodes,
      // What the compact row (12 px gaps, the `fit` press's own shape) would leave a column. It is the narrowest the
      // drawing can be while it is still a row, so it is the shape's own floor: below it, the drawing wraps.
      compactShare: (width - (n - 1) * 12) / n,
    };
  }

  function wrapRows(flowEl, shape) {
    const wrap = shape.nodes.length > 1 && shape.compactShare < PFLOW_COMPACT;
    const said = wrap ? "1" : "0";
    if (flowEl.dataset.wrap !== said) flowEl.dataset.wrap = said;
    // Last on its line: the next tile starts a new one, or there is no next tile. That is the ONLY thing this pass has
    // to know about the row: the stylesheet drops the connector stub on a row's last tile, and a gate's notch is
    // already drawn inside the tile it ends (`.pflow-notch`, `left: 100%` pulled back by its own width), so a wrapped
    // row needs no notch re-aimed into a gap that is not there - the measured 6 px of scroller overflow that came with
    // re-aiming it is gone with the re-aiming.
    const nodes = shape.nodes;
    for (let i = 0; i < nodes.length; i += 1) {
      const next = nodes[i + 1];
      const ends = !next || Math.abs(next.offsetTop - nodes[i].offsetTop) > 1;
      if (ends) nodes[i].dataset.rowEnd = "1";
      else delete nodes[i].dataset.rowEnd;
    }
    return wrap;
  }

  function readView(doc) {
    const flowEl = doc.querySelector("[data-pm-flow] .pflow");
    const count = flowEl && flowEl.querySelector("[data-pflow-count]");
    if (!flowEl || !count || !global.PipelineFlow || typeof global.PipelineFlow.viewCount !== "function") return;
    const shape = shapeOf(flowEl);
    if (!shape) return;
    const wrap = wrapRows(flowEl, shape);
    const said = global.PipelineFlow.viewCount(flowEl);
    if (!said) return;
    count.textContent = said.text;
    count.dataset.out = String(said.stages.out + said.notches.out);
    // A wrapped drawing shows every stage, so it owes the reader no count and no press; the row is for a row.
    const show = !wrap && (said.overflow || state.fit);
    for (const selector of ["[data-pflow-status]", "[data-pflow-fit]"]) {
      const el = flowEl.querySelector(selector);
      if (el) el.hidden = !show;
    }
  }

  function wireFlow(doc) {
    if (state.flowWatch) {
      state.flowWatch();
      state.flowWatch = null;
    }
    const flowEl = doc.querySelector("[data-pm-flow] .pflow");
    if (!flowEl) return;
    const scroll = flowEl.querySelector(".pflow-scroll");
    const onScroll = () => readView(doc);
    scroll?.addEventListener?.("scroll", onScroll, { passive: true });
    // The card is 96vw up to its cap, so a window resize changes how much of a long definition fits; a count taken
    // once and left to rot is the same lie as no count at all.
    const win = doc.defaultView;
    const onResize = () => readView(doc);
    win?.addEventListener?.("resize", onResize);
    const fit = flowEl.querySelector("[data-pflow-fit]");
    fit?.addEventListener("click", (e) => {
      e.preventDefault?.();
      state.fit = !state.fit;
      paintFlow(doc);
      // The press rebuilds the flow, so the button under the reader's finger is a new element: hand the focus back to
      // it rather than dropping them at the top of the page (and so a keyboard press keeps its ring).
      doc.querySelector("[data-pm-flow] [data-pflow-fit]")?.focus?.({ preventScroll: true });
    });
    state.flowWatch = () => {
      scroll?.removeEventListener?.("scroll", onScroll);
      win?.removeEventListener?.("resize", onResize);
    };
    readView(doc);
  }

  function focusables(doc) {
    const card = doc.getElementById(CARD_ID);
    if (!card || typeof card.querySelectorAll !== "function") return [];
    // A control the reader cannot reach is not a Tab stop: the status row's `fit` press is `hidden` while the drawing
    // fits, and counting it made the wrap land on it — the browser skips it and the caret leaves the card, which is the
    // one thing this dialog promises not to do.
    return [...card.querySelectorAll(TABBABLE)].filter((el) => {
      if (el.hidden || el.closest?.("[hidden]")) return false;
      return typeof el.getClientRects === "function" ? el.getClientRects().length > 0 : true;
    });
  }

  // ---- the card's geometry: VISUAL px in, LAYOUT px out ------------------------------------------------------------
  // `getComputedStyle(document.documentElement).zoom` is the page zoom Settings > Display writes, and it is the factor
  // between a pointer's visual px and a style's layout px. Reading it at gesture time (never caching it) means a zoom
  // change between two drags is answered by the second drag's own arithmetic.
  function zoomOf(doc) {
    try {
      const z = parseFloat(doc.defaultView?.getComputedStyle?.(doc.documentElement)?.zoom);
      return Number.isFinite(z) && z > 0 ? z : 1;
    } catch {
      return 1;
    }
  }

  function roomOf(doc) {
    const win = doc.defaultView || global;
    const vw = Math.max(1, Math.round(win?.innerWidth || 1));
    const vh = Math.max(1, Math.round(win?.innerHeight || 1));
    return { z: zoomOf(doc), vw, vh, roomW: Math.max(1, vw - PM_MARGIN * 2), roomH: Math.max(1, vh - PM_MARGIN * 2) };
  }

  // A VISUAL rectangle clamped: the size first (the reader's floor, then the room this window has), then the place, so
  // a card that no longer fits is SHRUNK into the window instead of hanging off an edge. `max: false` is the DRAG's
  // rule: dragging must never also resize the card.
  function clampCard(g, { max = true, doc = document } = {}) {
    const { vw, vh, roomW, roomH } = roomOf(doc);
    const w = max ? Math.min(Math.max(Math.round(g.w), PM_MIN_W), roomW) : Math.min(Math.round(g.w), roomW);
    const h = max ? Math.min(Math.max(Math.round(g.h), PM_MIN_H), roomH) : Math.min(Math.round(g.h), roomH);
    const x = Math.min(Math.max(Math.round(g.x), PM_MARGIN), Math.max(PM_MARGIN, vw - w - PM_MARGIN));
    const y = Math.min(Math.max(Math.round(g.y), PM_MARGIN), Math.max(PM_MARGIN, vh - h - PM_MARGIN));
    return { x, y, w, h };
  }

  // Write a VISUAL rectangle back as style lengths, each divided by the zoom once. `position: fixed` takes the card out
  // of the backdrop's centring flex, so left/top are the reader's own numbers and the flow inside re-lays out in the
  // width they chose (the grid's columns are a share of it, never a fixed strip).
  //
  // The HEIGHT is a ceiling, never a box: the card follows its own content and the reader's drag says how tall the
  // body may grow before it scrolls. A pinned height was an empty grey field - the card's own background, three
  // lines under a legend that ends the drawing (the 3285x472 capture) - because nothing paints the room a drawing
  // did not ask for. So `height` is cleared and `max-height` carries the gesture's number.
  function paintCard(g, doc = document) {
    const card = doc.getElementById(CARD_ID);
    if (!card || !card.style) return;
    const { z } = roomOf(doc);
    card.style.position = "fixed";
    card.style.margin = "0";
    card.style.left = `${Math.round(g.x / z)}px`;
    card.style.top = `${Math.round(g.y / z)}px`;
    card.style.width = `${Math.round(g.w / z)}px`;
    card.style.height = "";
    card.style.maxHeight = `${Math.round(g.h / z)}px`;
  }

  // Back to the stylesheet's own card: centred, sized from the drawing it holds. A double-press on the bar does this,
  // and every open starts here, so a place chosen for another definition is not inherited by this one.
  function resetCard(doc = document) {
    const card = doc.getElementById(CARD_ID);
    state.rect = null;
    state.gesture = null;
    if (!card || !card.style) return;
    for (const prop of ["position", "margin", "left", "top", "width", "height", "maxHeight"]) card.style[prop] = "";
    card.classList.remove("is-dragging");
  }

  // The press that starts a gesture. Only the BAR drags (a press on one of its controls is that control, and the body
  // is never a handle, so its text stays selectable and the drawing keeps scrolling), and only the CORNER resizes.
  function gestureStart(e, kind, doc) {
    const card = doc.getElementById(CARD_ID);
    if (!state.open || !card || e.button !== 0) return;
    const box = card.getBoundingClientRect();
    state.gesture = { kind, id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, rect: { x: box.left, y: box.top, w: box.width, h: box.height } };
    // The first press pins the size the card already has, so a drag can never resize it and a resize can never move
    // it by accident: both gestures then work from one rectangle.
    state.rect = { ...state.gesture.rect };
    card.setPointerCapture?.(e.pointerId);
    e.preventDefault?.(); // a drag is not a text selection
  }

  function gestureMove(e, doc) {
    const g = state.gesture;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.moved && Math.abs(dx) + Math.abs(dy) < PM_SLOP) return;
    g.moved = true;
    doc.getElementById(CARD_ID)?.classList.add("is-dragging");
    const next =
      g.kind === "drag"
        ? clampCard({ x: g.rect.x + dx, y: g.rect.y + dy, w: g.rect.w, h: g.rect.h }, { max: false, doc })
        : clampCard({ x: g.rect.x, y: g.rect.y, w: g.rect.w + dx, h: g.rect.h + dy }, { doc });
    state.rect = next;
    paintCard(next, doc);
    // The card just changed the room the drawing has: re-decide the shape and the count on every frame of the gesture,
    // so a resize never leaves the flow in the shape of a width it no longer has.
    readView(doc);
  }

  function gestureEnd(e, doc) {
    const g = state.gesture;
    if (!g) return;
    if (e && g.id !== e.pointerId) return;
    state.gesture = null;
    doc.getElementById(CARD_ID)?.classList?.remove("is-dragging");
  }

  // A window resize answers the card the same way: the rectangle it had is re-clamped into the room that is left.
  function rehomeCard(doc) {
    if (!state.rect) return;
    const next = clampCard(state.rect, { doc });
    state.rect = next;
    paintCard(next, doc);
  }

  function restore(doc) {
    const from = state.opener;
    const again =
      from && from.isConnected !== false
        ? from
        : state.mode === "position"
          ? doc.querySelector?.("[data-as-qflow], [data-as-qpipe]")
          : doc.getElementById("settings-tab-pipeline") || doc.getElementById("pipeline-select");
    if (again && typeof again.focus === "function") again.focus({ preventScroll: true });
  }

  function close({ doc = document, restoreFocus = true, fire = true } = {}) {
    const host = doc.getElementById(OVERLAY_ID);
    const card = doc.getElementById(CARD_ID);
    if (!host || host.hidden) return false;
    const wasMode = state.mode;
    const onClose = state.onClose;
    if (state.flowWatch) {
      state.flowWatch();
      state.flowWatch = null;
    }
    host.hidden = true;
    host.setAttribute("data-mode", "edit");
    if (card) {
      card.innerHTML = "";
      // The next open may be a shorter definition, and paint() sets this again from the flow it is given; clearing it
      // here keeps an empty card from carrying the last drawing's width while the next one is still loading.
      card.style?.setProperty?.("--pflow-card-n", "1");
      // The place and size the reader chose belong to the definition they were looking at, not to the next one.
      resetCard(doc);
    }
    doc.body?.classList?.remove("pipeline-modal-open");
    Object.assign(state, {
      open: false,
      mode: null,
      flow: null,
      position: null,
      title: "",
      subtitle: "",
      facts: [],
      note: "",
      status: "",
      loading: false,
      preview: false,
      fit: false,
      onClose: null,
    });
    if (restoreFocus) restore(doc);
    if (fire && typeof onClose === "function") {
      try {
        onClose(wasMode);
      } catch {
        /* a caller's own clean-up cannot stop the dialog from having closed */
      }
    }
    return true;
  }

  function open(options = {}) {
    const doc = document;
    const mode = String(options.mode || "");
    if (!MODES.includes(mode)) {
      // A mode nobody defined would draw an unlabelled dialog: refuse the press, and say so where a developer reads.
      console.warn(`pipeline-modal: open() needs mode "edit" or "position" (got ${JSON.stringify(options.mode)})`);
      return null;
    }
    const host = overlay(doc);
    state.mode = mode;
    state.opener = options.opener || (doc.activeElement && doc.activeElement.closest ? doc.activeElement.closest("[data-as-qflow], [data-as-qpipe], [data-pipeline-flow-open]") : null) || doc.activeElement || null;
    state.flow = options.pipeline || options.flow || null;
    state.position = options.position || null;
    state.title = String(options.title || "");
    state.subtitle = String(options.subtitle || "");
    state.facts = Array.isArray(options.facts) ? options.facts : [];
    state.note = String(options.note || "");
    state.status = String(options.status || "");
    state.loading = Boolean(options.loading);
    state.preview = options.preview == null ? mode === "position" : Boolean(options.preview);
    // Every open starts at the readable column width; `fit` is a reader's choice for the drawing they are looking at.
    state.fit = false;
    state.onClose = typeof options.onClose === "function" ? options.onClose : null;
    state.motion = matchMotion(doc);
    state.open = true;
    host.hidden = false;
    host.setAttribute("data-mode", mode);
    host.setAttribute("data-motion", state.motion ? "on" : "off");
    // Every open is the stylesheet's card: centred, sized from the drawing it is about to hold.
    resetCard(doc);
    paint(doc);
    wire(doc);
    watchMotion(doc);
    doc.body?.classList?.add("pipeline-modal-open");
    doc.getElementById(CARD_ID)?.focus?.({ preventScroll: true });
    return state;
  }

  function setPosition(position, { doc = document } = {}) {
    if (!state.open) return false;
    state.position = position || null;
    paintFlow(doc);
    return true;
  }

  function setStatus(text, { doc = document } = {}) {
    const el = doc.querySelector?.("[data-pm-status]");
    state.status = String(text || "");
    if (el) el.textContent = state.status;
    return true;
  }

  function wireContent(doc) {
    const card = doc.getElementById(CARD_ID);
    if (!card) return;
    for (const btn of card.querySelectorAll("[data-pm-close]")) {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        close({ doc });
      });
    }
    const stage = card.querySelector("[data-pm-stage]");
    const refused = card.querySelector("[data-pm-refused]");
    const read = () => {
      const id = stage ? stage.value : "";
      setPosition({ stage: id, refused: refused && refused.checked ? id : null }, { doc });
      if (refused && refused.checked && stage) stage.focus?.({ preventScroll: true });
    };
    if (stage) stage.addEventListener("change", read);
    if (refused) refused.addEventListener("change", read);
    wireFlow(doc);
  }

  function wire(doc) {
    if (state.wired) return;
    state.wired = true;
    // CAPTURE on document: this runs before the Settings window's bubble-phase Escape, and stopping propagation here
    // is what keeps one Esc from closing two surfaces.
    doc.addEventListener(
      "keydown",
      (e) => {
        if (!state.open) return;
        const items = focusables(doc);
        const activeIndex = items.indexOf(doc.activeElement);
        const intent = keyIntent({ key: e.key, shift: e.shiftKey, activeIndex, count: items.length });
        if (!intent) return;
        e.preventDefault?.();
        e.stopPropagation?.();
        if (intent === "close") {
          close({ doc });
          return;
        }
        const target = intent === "last" ? items[items.length - 1] : items[0];
        target?.focus?.();
      },
      true,
    );
    // A press that BEGINS on the backdrop closes; one that begins inside the card does not, even when it ends on the
    // backdrop (a drag out of a select would otherwise look like a dismissal).
    doc.addEventListener(
      "pointerdown",
      (e) => {
        if (!state.open) return;
        const host = doc.getElementById(OVERLAY_ID);
        state.pressedOnBackdrop = Boolean(host && e.target === host);
      },
      true,
    );
    doc.addEventListener(
      "click",
      (e) => {
        const host = doc.getElementById(OVERLAY_ID);
        if (!state.open || !host || host.hidden) return;
        if (e.target !== host) return;
        e.preventDefault?.();
        // A press on the backdrop belongs to THIS dialog and to nothing under it. The page closes Settings for any click
        // whose path does not include it (public/app.js, the #settings outside-press handler), so without this one press
        // closed two surfaces and the reader lost the tab they were editing in (round 5A's finding 5). It stops on the
        // DRAG-OUT press as well as the closing one: a press that begins in the card and ends on the backdrop is not a
        // dismissal, but it is still this dialog's press, and it used to close Settings on its way past.
        e.stopPropagation?.();
        if (!state.pressedOnBackdrop) return;
        close({ doc });
      },
      true,
    );
    // A press INSIDE the card belongs to this dialog as much as a backdrop press does. The page closes the Settings
    // window for any click whose path does not include it (public/app.js, the #settings outside-press handler), and
    // this dialog is opened FROM Settings — so a press on one of its own controls (the fit control, the preview
    // select, close) used to close the window the reader was editing in, leaving the dialog over a bare board. It is
    // bound on the CARD, not as a capture stop on document: capture at document runs BEFORE the button's own handler
    // and a stop there is the press never arriving at all.
    doc.getElementById(CARD_ID)?.addEventListener("click", (e) => e.stopPropagation?.());
    // ---- the card as a window ---------------------------------------------------------------------------------------
    // Bound on the CARD, once: the element outlives every repaint (paint() replaces its innerHTML, not the node), so a
    // listener here is not rebuilt under a gesture. The bar drags, the corner resizes, and a double-press on the bar
    // puts the card back where the stylesheet had it.
    const card = doc.getElementById(CARD_ID);
    card?.addEventListener?.("pointerdown", (e) => {
      if (!state.open || e.button !== 0) return;
      if (e.target?.closest?.("[data-pm-resize]")) {
        gestureStart(e, "resize", doc);
        return;
      }
      const bar = e.target?.closest?.(".pmodal-bar");
      if (!bar || e.target.closest?.("button, a, select, input, textarea, label")) return;
      gestureStart(e, "drag", doc);
    });
    card?.addEventListener?.("dblclick", (e) => {
      if (e.target?.closest?.("button, a, select, input, textarea, label")) return;
      if (!e.target?.closest?.(".pmodal-bar")) return;
      resetCard(doc);
    });
    const win = doc.defaultView;
    win?.addEventListener?.("pointermove", (e) => gestureMove(e, doc));
    win?.addEventListener?.("pointerup", (e) => gestureEnd(e, doc));
    win?.addEventListener?.("pointercancel", (e) => gestureEnd(e, doc));
    // A window that shrinks under a card the reader placed re-clamps it, so the bar is never off the glass.
    win?.addEventListener?.("resize", () => rehomeCard(doc));
  }

  function watchMotion(doc) {
    try {
      const win = doc.defaultView || global;
      if (state.media && typeof state.media.removeEventListener === "function") state.media.removeEventListener("change", state.onMedia);
      if (typeof win.matchMedia !== "function") return;
      const media = win.matchMedia("(prefers-reduced-motion: reduce)");
      state.media = media;
      state.onMedia = () => {
        state.motion = !media.matches;
        doc.getElementById(OVERLAY_ID)?.setAttribute("data-motion", state.motion ? "on" : "off");
        paintFlow(doc);
      };
      if (typeof media.addEventListener === "function") media.addEventListener("change", state.onMedia);
    } catch {
      /* a browser without matchMedia keeps the default, which is motion on */
    }
  }

  global.PipelineModal = {
    open,
    close,
    isOpen: () => Boolean(state.open),
    setPosition,
    setStatus,
    keyIntent,
    // A reader of the page with devtools can tell which mode is up without reading the words.
    state: () => ({ ...state }),
  };
})(typeof window !== "undefined" ? window : globalThis);
