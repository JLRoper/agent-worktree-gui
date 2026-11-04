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
//     is released outside;
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

  function flowHtml(flow, position, motion) {
    if (!flow || !Array.isArray(flow.stages) || !flow.stages.length) {
      return `<div class="pmodal-empty">this pipeline holds no stage, so there is nothing to draw</div>`;
    }
    return global.PipelineFlow.markup(flow, position, { motion });
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
    const kicker = state.mode === "position" ? "pipeline flow · position" : "pipeline flow · editing";
    const body = state.loading
      ? `<div class="pmodal-note">reading this task's pipeline…</div>`
      : `${factsHtml(state.facts)}${state.note ? `<div class="pmodal-note">${esc(state.note)}</div>` : ""}${
          state.flow ? `<div class="pmodal-flow" data-pm-flow>${flowHtml(state.flow, state.position, state.motion)}</div>` : ""
        }${previewHtml(state.flow, state.position)}`;
    return `<div class="pmodal-bar">
        <span class="pmodal-kicker">${esc(kicker)}</span>
        <b class="pmodal-title" id="${TITLE_ID}">${esc(state.title || "pipeline")}</b>
        ${state.subtitle ? `<span class="pmodal-sub mono">${esc(state.subtitle)}</span>` : ""}
        <span class="spacer"></span>
        <button type="button" class="pmodal-close" data-pm-close title="close (Esc) — focus goes back to the control that opened this" aria-label="close the pipeline flow">✕</button>
      </div>
      <div class="pmodal-body">${body}</div>
      <div class="pmodal-foot">
        <span class="pmodal-status mono" data-pm-status role="status" aria-live="polite">${esc(state.status || "")}</span>
        <button type="button" data-pm-close title="close (Esc)">close</button>
      </div>`;
  }

  function paint(doc = document) {
    const card = doc.getElementById(CARD_ID);
    if (!card) return;
    card.innerHTML = cardHtml();
    wireContent(doc);
  }

  // Only the flow is replaced by a position change: the preview control is a sibling, so the select the reader is
  // holding on to is not rebuilt under their hands and keeps its focus.
  function paintFlow(doc = document) {
    const box = doc.querySelector("[data-pm-flow]");
    if (!box) return;
    box.innerHTML = flowHtml(state.flow, state.position, state.motion);
    // The flow's own position, on its OWN attributes: `data-pm-*` names belong to the preview controls, and a wrapper
    // that carried one of them made `[data-pm-refused]` select two elements (the checkbox and this div).
    box.dataset.flowPosition = String((state.position && state.position.stage) || "");
    box.dataset.flowRefused = String((state.position && state.position.refused) || "");
  }

  function focusables(doc) {
    const card = doc.getElementById(CARD_ID);
    return card && typeof card.querySelectorAll === "function" ? [...card.querySelectorAll(TABBABLE)] : [];
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
    host.hidden = true;
    host.setAttribute("data-mode", "edit");
    if (card) card.innerHTML = "";
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
    state.onClose = typeof options.onClose === "function" ? options.onClose : null;
    state.motion = matchMotion(doc);
    state.open = true;
    host.hidden = false;
    host.setAttribute("data-mode", mode);
    host.setAttribute("data-motion", state.motion ? "on" : "off");
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
        if (e.target !== host || !state.pressedOnBackdrop) return;
        e.preventDefault?.();
        close({ doc });
      },
      true,
    );
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
