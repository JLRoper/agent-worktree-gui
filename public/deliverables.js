// deliverables.js - the deliverables list, cut out of public/app.js.
//
// WHY THIS FILE EXISTS. public/app.js held 22,000 lines and a third of the board's work landed in it, so one file
// was one lane. This is step 3 of the order of work in docs/reports/module-map-2026-11-07.html ("charts.js and
// deliverables.js out of app.js. Self-contained, low risk, and they prove the re-export pattern twice"), moved
// line for line: not one body was rewritten and not one call site was touched. The report's row for this file is
// "the 27 deliver* functions and their UI", and this is that row: the header button's popover, its rows, its text
// filter and kind chips, its place and size on the page, the store read, the seen watermark, and the two openers
// (a row's own URL, or POST /api/deliverables/open for a file the browser cannot render).
//
// WHAT IS HERE
//
//   the popover          deliverPopEl, openDeliverPop, closeDeliverPop, toggleDeliverPop, deliverKindChipsHtml,
//                        deliverTabStops, toggleDeliverKind, paintDeliverKinds: one panel built once and reused,
//                        with one opener per row and a chip per kind.
//   the place and size   the DL_* floors and DL_RECT_KEY, deliverGeo, deliverZoom, deliverSpace,
//                        clampDeliverRect, paintDeliverRect, clearDeliverRect, deliverStoredRect,
//                        deliverRemember, deliverForget, deliverStoredFits, deliverRestore, deliverPosition and
//                        the three gesture handlers. Layout lengths against visual room: every number that says
//                        where the panel LANDED is divided by the page zoom only when it is written back.
//   the list             deliverList, deliverFetch, paintDeliverRows, deliverRowHtml, deliverLinkLabel,
//                        deliverDayLabel, deliverMarkActive, paintDeliverAges, deliverKeydown.
//   the count            deliver (the page's own list state), DELIVER_DEFAULT_CAP, deliverUnseenCount,
//                        paintDeliverBadge, deliverMarkSeen: the watermark only ever moves forward here.
//   the openers          deliverOpenTarget, deliverOpenOnServer, deliverTargetName, sayDeliverOpened,
//                        sayDeliverWhy, clearDeliverWhy, deliverOpenAgent, deliverOpenWorktree.
//   the poll             DELIVER_POLL_MS, deliverPollTick, deliverHookStream.
//
// WHAT STAYS IN public/app.js, and why: the wiring that has to run at app.js's own load, after `state` exists -
// the button's press and its `data-wired` mark, the first quiet read that paints the badge, the retry hookup for
// the stream, the interval, and the mousedown/keydown/resize listeners that close or place the popover. Those are
// callers, and they reach these functions by bare name exactly as they did before the move.
//
// WHAT IT REACHES OUT FOR (by name, at call time, exactly as before the move)
//
//   state, conversations,      the list's store read, the seen watermark, and the agent a row's other control
//   renderConversation,        opens
//   renderJobs, assistantSessionFor, hotRowFor, hotOpenPath, flashHotCard, scrollCardUnderBar, showBanner,
//   toggleProject, humanTextEntry
//   $, esc, keyOf, tailPath,   the markup, the paths and the ages (core/dom-format.js)
//   fmtAgo
//   apiFetch                   GET /api/deliverables and POST /api/deliverables/open (core/transport.js)
//   wtTurnFold                 the opener's turn lookup (core/turn-fold.js)
//   window.wtDeliverKinds      the kinds, their glyphs and the two pure narrowings (core/deliver-kinds.js)
//
// THE LOAD CONTRACT. public/index.html loads CLASSIC scripts, so the page is one global scope: a top-level
// `function` here is a window property and a top-level `let` is a binding every other script reads by bare name.
// This file DECLARES ONLY - nothing in it reads an app.js binding while it loads, so sitting before app.js costs
// nothing and cannot land in a temporal dead zone. public/app.js re-exports these names on window.WMApp.deliverables.

// ---- deliverables: one button, one list, everything an agent handed back -------------------------
// A worker hands something back with one line in its FINAL message — `DELIVER <kind> <target> | <title>` — and
// the panel reads it at settle (lib/deliverables.js), validates that the target is openable NOW, and keeps one row
// per target. This is the reader's way in: one header button beside HUMAN, and one popover listing every
// deliverable this panel has recorded, newest first, each row carrying its age. The plan is
// docs/plan/deliverables-handback.md and its five DECIDED choices are what this block implements: the word
// DELIVERABLES; one row updated in place (so the page paints the store, never a second row); a malformed line said
// on the card only (so nothing here invents a row); an image as a glyph plus the OS viewer, with NO new route (Q4);
// and the paragraph on every tree turn (the backend's half).
//
// ONE OPEN CONTROL PER ROW, and one decision behind it. The store's list carries the URL a tab can open (`href`,
// decided by the server: a link's own URL, or a file under the panel's served root). A row that has one opens THAT,
// synchronously in the click, in the reader's own browser — no fetch of the URL on the reader's behalf and no
// browser launched on this machine. A row with no URL is a file the browser cannot render: it goes through
// POST /api/deliverables/open {seq}, the route that has always handed a file to the OS default handler. The page
// still never sends a path back — only a seq — so a stray string cannot launch an arbitrary file.
//
// A REFUSAL IS SAID ON THE CARD. Missing, a directory, or outside the repo comes back from that route as the
// sentence the reader sees under the row; the click never opens a blank tab and never hides the reason in a banner.
// AN ANSWER IS SAID ON THE CARD TOO. The one 200 the page used to swallow is the handler's: the route answers from
// the spawn (a detached child reports nothing), so the row says what was handed over and to WHICH browser -
// `opened report.html with msedge.exe - the registered default browser (MSEdgeHTM)` - names the fallback when one
// fired, and says in the same line that the panel cannot see whether a window appeared. That is the whole of what
// the spawn proves; a sentence about the window itself would claim the one fact the route cannot report. A reader
// who saw nothing for it read the silence as "the control does not respond at all".
// The title is the row's name now, not a second opener; the row's other control points at the AGENT that delivered
// it, so a mis-click in a 200-row list opens a console (cheap, reversible) rather than a window (not).
//
// WHAT THIS REACHES OUT FOR, by name at call time (all page globals): $, esc, tailPath, keyOf, fmtAgo
// (core/dom-format.js), apiFetch (core/transport.js), wtTurnFold (core/turn-fold.js), state, conversations,
// renderConversation, renderJobs, assistantSessionFor, hotRowFor, hotOpenPath, flashHotCard, scrollCardUnderBar,
// showBanner, toggleProject and humanTextEntry (this file).

const DELIVER_DEFAULT_CAP = 200;
const deliver = {
  el: null,        // the popover, built once and reused; the board repaint never owns it
  open: false,
  loading: false,
  error: "",
  entries: [],     // the store's order — newest first — untouched by this file
  cap: DELIVER_DEFAULT_CAP,
  kept: 0,
  filter: "",
  // The kinds the reader switched OFF with the header's chips. Default empty is ALL ON, and this is page state, not
  // list state: paintDeliverRows re-reads it on every repaint (the list re-renders on each deliverable frame) and
  // never writes it, which is what keeps a switched-off kind switched off through a repaint. It narrows the VIEW
  // only — the store's rows stay where they are and come back the moment the chip is pressed again.
  kindsOff: [],
  active: 0,       // index into the FILTERED rows, which is what the combobox drives
  agesTimer: null,
  why: {},         // seq → the refusal the click was given, said under that row and nowhere else
  opened: {},      // seq → { name, opener }: what a 200 handler handed to the OS, said under its row
  seenSeq: 0,      // the store's watermark as this page knows it — it only ever moves forward here
  serverSeen: 0,   // the last watermark the STORE reported, so a failed POST can put the count back honestly
  seenPosted: 0,   // the highest seq this page has recorded; a second open with nothing new posts nothing
  unseen: 0,       // rows above seenSeq — the number on the badge, never "everything ever delivered"
};

// The popover, built once. A fixed panel under the button, in the shape `.artifacts-pop` already uses — the
// panel's own idiom for a list that hangs off a control.
function deliverPopEl() {
  if (deliver.el && deliver.el.isConnected) return deliver.el;
  const pop = document.createElement("div");
  pop.id = "deliver-pop";
  pop.className = "deliver-pop";
  pop.hidden = true;
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "every deliverable produced on this panel, newest first");
  pop.innerHTML = `
    <div class="dl-head">
      <span class="dl-count" id="dl-count">deliverables — newest first</span>
      <input id="dl-filter" class="dl-filter" type="search" autocomplete="off" spellcheck="false" placeholder="filter…" role="combobox" aria-label="filter deliverables" aria-autocomplete="list" aria-controls="dl-list" aria-expanded="true" />
      <div class="dl-kinds" id="dl-kinds" role="group" aria-label="which kinds to show" hidden>${deliverKindChipsHtml()}</div>
      <button id="dl-close" type="button" class="dl-close" title="close (Esc)">✕</button>
    </div>
    <div class="dl-body" id="dl-list" role="listbox" aria-label="deliverables"></div>
    <div class="dl-foot" id="dl-foot" hidden></div>
    <div class="dl-resize" id="dl-resize" title="resize the list" aria-hidden="true"></div>
  `;
  document.body.append(pop);
  deliver.el = pop;

  // The HEAD is the drag handle and the CORNER resizes. Both gestures are captured on the popup and moved/ended on
  // the window, so a fast drag that leaves the panel still tracks, and neither changes what a click means: the
  // popup's own click handler below is untouched, and a press that moves is prevented from starting a selection.
  pop.addEventListener("pointerdown", (e) => {
    if (e.target.closest?.("#dl-resize")) return deliverGestureStart(e, "resize");
    const head = e.target.closest?.(".dl-head");
    if (!head || e.target.closest?.("input, button, select, textarea, label, a")) return;
    deliverGestureStart(e, "drag");
  });
  window.addEventListener("pointermove", deliverGestureMove);
  window.addEventListener("pointerup", deliverGestureEnd);
  window.addEventListener("pointercancel", deliverGestureEnd);

  pop.addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest?.("[data-dl-retry]")) return void deliverFetch();
    if (t.closest?.("#dl-close")) return closeDeliverPop({ focus: true });
    // A kind chip narrows the view and nothing else: no route, no store write, no row touched. Pressing it again
    // puts the kind back. It is a real button, so Space and Enter do exactly what the mouse does.
    const chip = t.closest?.("[data-dl-kind]");
    if (chip) return void toggleDeliverKind(chip.dataset.dlKind);
    // The row's ONE opener, and it never falls through to the row's agent: a press on Open opens the deliverable,
    // whatever the row click means.
    const openControl = t.closest?.("[data-dl-open]");
    if (openControl) {
      e.stopPropagation();
      return void deliverOpenTarget(Number(openControl.dataset.dlOpen));
    }
    const openAgent = t.closest?.("[data-dl-agent]");
    if (openAgent) return void deliverOpenAgent(Number(openAgent.dataset.dlAgent));
    const row = t.closest?.(".dl-row");
    if (row) return void deliverOpenAgent(Number(row.dataset.seq));
  });

  const filter = pop.querySelector("#dl-filter");
  filter.addEventListener("input", (e) => {
    deliver.filter = e.target.value;
    deliver.active = 0;
    paintDeliverRows();
  });
  filter.addEventListener("keydown", deliverKeydown);
  // Tab is the way OUT of the popover, but it is also the way ACROSS its header: the chips are real buttons and a
  // control a keyboard cannot reach is not a control. So Tab walks the header's own stops (filter → chips → close)
  // and closes the popover only when it would leave from either edge; from a row's own control the browser keeps
  // Tab, and nothing here traps focus.
  pop.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const stops = deliverTabStops();
    const at = stops.indexOf(document.activeElement);
    if (at < 0) return;
    const edge = e.shiftKey ? at === 0 : at === stops.length - 1;
    if (edge) closeDeliverPop({ focus: true });
  });
  return pop;
}

// One chip per kind, in DELIVER_KINDS order, each a real button with aria-pressed. The chips are built ONCE with the
// popover and only ever have their attributes and `hidden` repainted, so a press survives every list repaint — and
// focus never leaves the chip the reader just pressed.
function deliverKindChipsHtml() {
  const K = window.wtDeliverKinds;
  return K.KINDS.map(
    (kind) => `<button type="button" class="dl-kind" data-dl-kind="${esc(kind)}" aria-pressed="true" aria-label="${esc(kind)}" hidden title="${esc(K.chipTitle(kind, []))}"><span class="dl-kind-glyph" aria-hidden="true">${K.GLYPH[kind]}</span></button>`,
  ).join("");
}

// The header's tab order: the search box, the chips that are actually on screen, then close. A hidden chip is not a
// stop (a display:none button cannot take focus), which is why the dead ones are filtered out here rather than
// relied on to be skipped.
function deliverTabStops() {
  const pop = deliver.el;
  if (!pop) return [];
  return [pop.querySelector("#dl-filter"), ...pop.querySelectorAll("[data-dl-kind]"), pop.querySelector("#dl-close")].filter(
    (el) => el && !el.hidden,
  );
}

// A chip press: flip that kind in the page's own off-list, then repaint. `kindsOff` is assigned ONCE here and read by
// the paint, so the state is the input to every repaint instead of a thing the repaint rebuilds.
function toggleDeliverKind(kind) {
  if (!kind) return;
  const off = new Set(deliver.kindsOff);
  if (off.has(kind)) off.delete(kind);
  else off.add(kind);
  // Canonical order, so a repaint and a reopened popover read the same list.
  deliver.kindsOff = window.wtDeliverKinds.KINDS.filter((k) => off.has(k));
  deliver.active = 0;
  paintDeliverRows();
  // The chip the reader pressed keeps the focus through the repaint (nothing re-creates it).
  deliver.el?.querySelector(`[data-dl-kind="${CSS.escape(kind)}"]`)?.focus({ preventScroll: true });
}

// Which chips are on screen, and which way each is pressed. A kind with no row in this popup has no chip — hidden,
// never greyed — and the group itself is hidden when not one kind has a row (an empty store), so the header does not
// carry an empty control.
function paintDeliverKinds(present) {
  const pop = deliver.el;
  if (!pop) return;
  const K = window.wtDeliverKinds;
  const group = pop.querySelector("#dl-kinds");
  const shown = K.KINDS.filter((kind) => present.includes(kind));
  if (group) group.hidden = shown.length === 0;
  for (const chip of pop.querySelectorAll("[data-dl-kind]")) {
    const kind = chip.dataset.dlKind;
    const on = shown.includes(kind);
    const off = K.isOff(kind, deliver.kindsOff);
    chip.hidden = !on;
    chip.setAttribute("aria-pressed", off ? "false" : "true");
    chip.classList.toggle("is-off", off);
    chip.title = K.chipTitle(kind, deliver.kindsOff);
  }
}

// ---- the popup's place on the page: LAYOUT lengths, VISUAL room ------------------------------------------------
// The panel is `position: fixed`, so its `left`/`top`/`width`/`height` are LAYOUT lengths — but every number that
// says where it LANDED is a VISUAL length: `getBoundingClientRect()` and `window.innerWidth` are CSS px of the
// screen, and Settings > Display's page zoom (`documentElement.style.zoom`, `applyZoom`) is the factor between the
// two. This rule used to mix them, and that is the defect the reader measured:
//
//     const r = btn.getBoundingClientRect();            // VISUAL px (a zoomed page scales it)
//     const w = pop.offsetWidth || ...;                 // LAYOUT px (offsetWidth is not zoomed)
//     const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));   // all three in one sum
//
// A zoomed page scales the button's rect (measured at 200%: x=724, 1120x1260, i.e. 404 px past the right edge and
// 762 px below the window) while `style.left` is written unzoomed, and the `innerWidth - w` clamp cannot hold it
// because it subtracts a LAYOUT width (560) from a VISUAL viewport while the drawn width is 560 x zoom. Nothing
// clamped `top` at all, so a tall list or a short window hung the foot off the bottom too (measured at 130% in a
// 1280x800 window: the foot sat at y=863). So the placement below is computed entirely in VISUAL px and divided by
// the zoom only when it is written back as a style length, and the clamp covers all four edges plus the size.
//
// The remembered rectangle is the reader's, not the page's: it lives in localStorage, it is restored only while it
// still FITS this window (a narrowed window or a raised zoom drops it rather than clamping quietly — the next open is
// then the default under the button, which is a place the reader can see), and a drag or a resize writes it back.
const DL_MARGIN = 8;       // every side: the panel never touches the viewport edge
const DL_GAP = 6;          // between the button and the panel, on first open
const DL_MIN_W = 320;      // narrower than this and a row's title is an ellipsis with an Open tag
const DL_MIN_H = 180;
const DL_MAX_W = 900;      // wider than this and a list of rows stops reading as a list
const DL_MAX_H = 820;
const DL_SLOP = 3;         // a press that moves less than this is a click on the head, not a drag
const DL_RECT_KEY = "wtgui.deliverables.rect";

// `rect` is the rectangle the page is drawing (VISUAL px) once the reader has moved or sized the panel; null means
// CSS still owns the size and the panel hangs under the button. `drag`/`resize` are the live gesture, if any.
const deliverGeo = { rect: null, sized: false, drag: null, resize: null };

function deliverZoom() {
  const z = parseFloat(getComputedStyle(document.documentElement).zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

// The room the panel may use, in VISUAL px, and the factor that turns a visual length into a style length.
function deliverSpace() {
  const vw = Math.max(1, Math.round(window.innerWidth));
  const vh = Math.max(1, Math.round(window.innerHeight));
  return { z: deliverZoom(), vw, vh, roomW: Math.max(1, vw - DL_MARGIN * 2), roomH: Math.max(1, vh - DL_MARGIN * 2) };
}

// A rectangle of VISUAL px, clamped: the size first (the reader's min/max, then the room this window has), then the
// position, so a panel that no longer fits is SHRUNK into the window instead of hanging off an edge. `max: false` is
// the DRAG's rule: a page zoom can make the panel wider than the reader's own max, and dragging it must not also
// shrink it — only the resize handle may take it down to the min or up to the max.
function clampDeliverRect(g, { max = true } = {}) {
  const { vw, vh, roomW, roomH } = deliverSpace();
  const w = max
    ? Math.min(Math.max(Math.round(g.w), DL_MIN_W), DL_MAX_W, roomW)
    : Math.min(Math.max(Math.round(g.w), DL_MIN_W), roomW);
  const h = max
    ? Math.min(Math.max(Math.round(g.h), DL_MIN_H), DL_MAX_H, roomH)
    : Math.min(Math.max(Math.round(g.h), DL_MIN_H), roomH);
  const x = Math.min(Math.max(Math.round(g.x), DL_MARGIN), Math.max(DL_MARGIN, vw - w - DL_MARGIN));
  const y = Math.min(Math.max(Math.round(g.y), DL_MARGIN), Math.max(DL_MARGIN, vh - h - DL_MARGIN));
  return { x, y, w, h };
}

// Write a VISUAL rectangle back as style lengths. Until the reader sizes the panel, `width`/`height` are left to the
// stylesheet (a flex column that is exactly as tall as its rows): a first open must not pin a height the list then
// grows out of.
function paintDeliverRect(g) {
  const pop = deliver.el;
  if (!pop) return;
  const { z } = deliverSpace();
  pop.style.left = `${Math.round(g.x / z)}px`;
  pop.style.top = `${Math.round(g.y / z)}px`;
  pop.style.right = "auto";
  if (!deliverGeo.sized) return;
  pop.style.width = `${Math.round(g.w / z)}px`;
  pop.style.height = `${Math.round(g.h / z)}px`;
  pop.style.maxHeight = "none";
}

function clearDeliverRect() {
  const pop = deliver.el;
  if (!pop) return;
  deliverGeo.rect = null;
  deliverGeo.sized = false;
  pop.style.width = "";
  pop.style.height = "";
  pop.style.maxHeight = "";
}

function deliverStoredRect() {
  try {
    const raw = JSON.parse(localStorage.getItem(DL_RECT_KEY) || "null");
    if (!raw || typeof raw !== "object") return null;
    const out = { x: Number(raw.x), y: Number(raw.y), w: Number(raw.w), h: Number(raw.h) };
    return ["x", "y", "w", "h"].every((k) => Number.isFinite(out[k])) ? out : null;
  } catch {
    return null; // a corrupt or unreadable store is the same as none
  }
}

function deliverRemember(g) {
  try {
    localStorage.setItem(DL_RECT_KEY, JSON.stringify(g));
  } catch {
    /* private mode: the place just will not persist */
  }
}

function deliverForget() {
  try {
    localStorage.removeItem(DL_RECT_KEY);
  } catch {
    /* nothing to clear */
  }
}

// A remembered rectangle is used only while it still fits: on screen with the margin on every side, and inside the
// sizes the panel draws. Anything else is a place this window does not have any more.
function deliverStoredFits(g) {
  const { vw, vh } = deliverSpace();
  return g.w >= DL_MIN_W && g.w <= DL_MAX_W && g.h >= DL_MIN_H && g.h <= DL_MAX_H
    && g.x >= DL_MARGIN && g.y >= DL_MARGIN
    && g.x + g.w <= vw - DL_MARGIN && g.y + g.h <= vh - DL_MARGIN;
}

// Open: a remembered rectangle when it still fits THIS window, otherwise the default under the button. One that no
// longer fits is DROPPED, not quietly re-clamped: the open is then the default, which is a place the reader can see,
// rather than a size they chose for another window.
function deliverRestore() {
  const stored = deliverStoredRect();
  if (stored && deliverStoredFits(stored)) {
    deliverGeo.rect = stored;
    deliverGeo.sized = true;
    paintDeliverRect(clampDeliverRect(stored));
    return;
  }
  if (stored) deliverForget();
  clearDeliverRect();
  deliverPosition();
}

// Open: the reader's remembered rectangle when it still fits, otherwise the default under the button with the whole
// panel clamped into the window. The default width is the panel's OWN measured box, not a constant, so a narrow
// window and a zoomed page are answered by the same arithmetic.
function deliverPosition() {
  const btn = $("btn-deliver");
  const pop = deliver.el;
  if (!btn || !pop || pop.hidden) return;
  const space = deliverSpace();
  if (deliverGeo.sized && deliverGeo.rect) {
    const g = clampDeliverRect(deliverGeo.rect);
    deliverGeo.rect = g;
    paintDeliverRect(g);
    return;
  }
  // The stylesheet owns the height here, so the cap is computed from the ROOM the window has — not from the box as
  // it is this instant. On a first open the list has not painted yet (it is 160 px tall for one frame and grows to
  // 630 as the rows land), so a cap measured from the box would be answered by the wrong rectangle: that is how the
  // panel's foot ended up below the window. `70vh` is a LAYOUT length too, so a page zoom multiplied it.
  pop.style.maxHeight = "";
  const r = btn.getBoundingClientRect();
  const room = Math.max(DL_MIN_H, space.vh - Math.round(r.bottom + DL_GAP) - DL_MARGIN);
  // The sheet's own default (70vh) still caps the panel's first-paint height, so a 900 px window does not get an
  // 809 px list; the room the window has is the tighter of the two and is what the clamp below is measured against.
  const cap = Math.min(room, Math.round(space.vh * 0.7), DL_MAX_H);
  pop.style.maxHeight = `${Math.floor(cap / space.z)}px`;
  const box = pop.getBoundingClientRect();
  const w = Math.min(Math.round(box.width), space.roomW);
  const h = Math.min(Math.round(box.height), space.roomH);
  const x = Math.min(Math.max(Math.round(r.right - w), DL_MARGIN), Math.max(DL_MARGIN, space.vw - w - DL_MARGIN));
  const y = Math.min(Math.max(Math.round(r.bottom + DL_GAP), DL_MARGIN), Math.max(DL_MARGIN, space.vh - h - DL_MARGIN));
  paintDeliverRect({ x, y, w, h });
}

// ---- the two gestures: the HEAD drags, the CORNER resizes -----------------------------------------------
// Only the head is a handle. A press on a control inside it (the filter, a chip, the close button) is that control
// and starts nothing; the body is never a handle, so its text stays selectable and the list keeps scrolling.
function deliverGestureStart(e, kind) {
  const pop = deliver.el;
  if (!pop || pop.hidden || e.button !== 0) return;
  const box = pop.getBoundingClientRect();
  deliverGeo[kind] = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, rect: { x: box.left, y: box.top, w: box.width, h: box.height } };
  e.currentTarget.setPointerCapture?.(e.pointerId);
  e.preventDefault(); // a drag is not a text selection
}

function deliverGestureMove(e) {
  const gesture = deliverGeo.drag || deliverGeo.resize;
  if (!gesture || gesture.id !== e.pointerId) return;
  const isDrag = Boolean(deliverGeo.drag);
  const dx = e.clientX - gesture.x;
  const dy = e.clientY - gesture.y;
  if (!gesture.moved && Math.abs(dx) + Math.abs(dy) < DL_SLOP) return;
  gesture.moved = true;
  // The first move pins the size the panel already has, so a drag can never resize it and a resize can never move it.
  if (!deliverGeo.sized) {
    deliverGeo.sized = true;
    deliverGeo.rect = { ...gesture.rect };
  }
  const g = isDrag
    ? clampDeliverRect({ x: gesture.rect.x + dx, y: gesture.rect.y + dy, w: gesture.rect.w, h: gesture.rect.h }, { max: false })
    : clampDeliverRect({ x: gesture.rect.x, y: gesture.rect.y, w: gesture.rect.w + dx, h: gesture.rect.h + dy });
  deliverGeo.rect = g;
  deliver.el?.classList.add("is-dragging");
  paintDeliverRect(g);
}

function deliverGestureEnd(e) {
  if (!deliverGeo.drag && !deliverGeo.resize) return;
  const gesture = deliverGeo.drag || deliverGeo.resize;
  if (e && gesture.id !== e.pointerId) return;
  deliverGeo.drag = null;
  deliverGeo.resize = null;
  deliver.el?.classList.remove("is-dragging");
  if (gesture.moved && deliverGeo.rect) deliverRemember(deliverGeo.rect);
}


// THE BADGE. Rows ABOVE the persisted watermark — so a list that has never been opened counts every row, and a list
// opened once and then left alone counts nothing until something NEW is delivered. The highlight is a CLASS on the
// header button (never an inline style: the pressed state and the unseen state each have one definition in
// style.css), and the number is in the button's aria-label as well as the pill, because a coloured dot is not a
// notification.
function deliverUnseenCount() {
  const floor = Number(deliver.seenSeq) || 0;
  return deliver.entries.reduce((n, e) => n + (Number(e.seq) > floor ? 1 : 0), 0);
}

function paintDeliverBadge() {
  const btn = $("btn-deliver");
  if (!btn) return;
  const n = Math.max(0, Number(deliver.unseen) || 0);
  const unseen = n > 0;
  // THE PILL EXISTS ONLY WHILE SOMETHING IS UNSEEN. A badge that ships in the markup carrying "0" and is merely
  // `hidden` is still text inside the button: the control reads "DELIVERABLES0" to anything that reads the node, and
  // the span measured 0x0 at (0,0) — a dead element with no job. So the node is created here when the count is real
  // and REMOVED when it is zero; the button's own text is then the label and nothing else.
  let badge = $("deliver-badge");
  if (unseen) {
    if (!badge) {
      badge = document.createElement("span");
      badge.id = "deliver-badge";
      badge.className = "deliver-badge";
      btn.append(badge);
    }
    badge.textContent = String(n);
    badge.title = `dismiss — ${n} deliverable${n === 1 ? "" : "s"} arrived since you last looked; this marks ${n === 1 ? "it" : "them"} seen without opening the list`;
  } else if (badge) {
    badge.remove();
  }
  btn.classList.toggle("has-unseen", unseen);
  btn.setAttribute(
    "aria-label",
    unseen
      ? `DELIVERABLES — ${n} new deliverable${n === 1 ? "" : "s"} since you last looked. Click or press D to open the list.`
      : "DELIVERABLES — every deliverable produced on this panel, newest first. Click or press D to open the list.",
  );
}

// ONE watermark, two doors: opening the popover and pressing the badge's dismiss both come through here, and both
// record the same number in the same store. It clears the badge in this tick — before the POST answers — so the paint
// cannot flicker back, and it posts ONCE: a second open with nothing new has no higher seq to send. A failed POST puts
// the count back to what the store last reported, because an optimistic clear that never landed would resurrect itself
// on the next poll and on the next restart.
function deliverMarkSeen() {
  const newest = deliver.entries.reduce((n, e) => Math.max(n, Number(e.seq) || 0), 0);
  const want = Math.max(newest, Number(deliver.seenSeq) || 0);
  if (want > (Number(deliver.seenSeq) || 0)) {
    deliver.seenSeq = want;
    deliver.unseen = deliverUnseenCount();
  }
  paintDeliverBadge();
  if (!want || want <= (Number(deliver.seenPosted) || 0)) return Promise.resolve(false);
  deliver.seenPosted = want;
  return (async () => {
    try {
      const r = await apiFetch("/api/deliverables/seen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seq: want }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(String(d.error || `HTTP ${r.status}`));
      const server = Number(d.seenSeq);
      if (Number.isFinite(server)) {
        deliver.serverSeen = server;
        deliver.seenSeq = Math.max(Number(deliver.seenSeq) || 0, server);
      }
      deliver.unseen = deliverUnseenCount();
      paintDeliverBadge();
      return true;
    } catch (e) {
      deliver.seenPosted = 0;
      deliver.seenSeq = Number(deliver.serverSeen) || 0;
      deliver.unseen = deliverUnseenCount();
      paintDeliverBadge();
      showBanner(`could not mark the deliverables seen: ${String((e && e.message) || e)}`);
      return false;
    }
  })();
}

function openDeliverPop() {
  const pop = deliverPopEl();
  pop.hidden = false; // before the measure: offsetWidth is 0 on a hidden element
  deliverRestore();
  deliver.open = true;
  $("btn-deliver")?.setAttribute("aria-expanded", "true");
  // Opening IS seeing: the same watermark the badge's dismiss writes, posted once, before the reader has scrolled a
  // single row. It clears the badge and the highlight in this tick, and nothing below can raise them again for these
  // rows — so the next poll, or a frame from this store, cannot flicker them back on.
  void deliverMarkSeen();
  deliverHookStream();
  // Paint what was last read immediately, then re-read: the list is an archive, and a stale row for a second is
  // better than an empty popover. A failed read replaces it with the sentence, never a blank list.
  paintDeliverRows();
  void deliverFetch({ quiet: deliver.entries.length > 0 });
  clearInterval(deliver.agesTimer);
  deliver.agesTimer = setInterval(paintDeliverAges, 30_000);
  requestAnimationFrame(() => $("dl-filter")?.focus({ preventScroll: true }));
}

function closeDeliverPop({ focus = false } = {}) {
  if (!deliver.open && (!deliver.el || deliver.el.hidden)) return;
  deliver.open = false;
  if (deliver.el) deliver.el.hidden = true;
  $("btn-deliver")?.setAttribute("aria-expanded", "false");
  clearInterval(deliver.agesTimer);
  deliver.agesTimer = null;
  if (focus) $("btn-deliver")?.focus({ preventScroll: true });
}

function toggleDeliverPop() {
  if (deliver.open) closeDeliverPop({ focus: true });
  else openDeliverPop();
}

const DELIVER_POLL_MS = 60_000;
function deliverPollTick() {
  deliverHookStream(); // a reconnect replaces state.es, so the hook follows it on the next tick
  if (document.hidden) return;
  void deliverFetch({ quiet: true });
}

// One SSE frame per delivery, so a list open in this tab (or another) gains its row without a reload. Attached to
// the EventSource app.js already holds; EventSource reconnects on the same object, so one listener outlives a
// dropped stream. The frame carries a summary only — the list is re-read from the store.
function deliverHookStream() {
  if (!state.es || state.es.__deliverableHook) return;
  state.es.__deliverableHook = true;
  state.es.addEventListener("deliverable", () => {
    void deliverFetch({ quiet: true }); // the open list gains its row, the closed badge its count
  });
}

// The store writes itself newest-first and this file does not re-order it; the filter narrows by what the reader
// can see — title, target, agent, project — AND by the kinds still switched on. Both narrowings are core/deliver-kinds'
// own pure answers, so the text and the chips compose by intersection and neither can win over the other.
function deliverList() {
  return window.wtDeliverKinds.visible(deliver.entries, { query: deliver.filter, off: deliver.kindsOff });
}

async function deliverFetch({ quiet = false } = {}) {
  const activeSeq = deliverList()[deliver.active]?.seq;
  if (!quiet) {
    deliver.loading = true;
    deliver.error = "";
    paintDeliverRows();
  }
  try {
    const r = await apiFetch("/api/deliverables");
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(String(d.error || `HTTP ${r.status}`));
    deliver.entries = Array.isArray(d.entries) ? d.entries : [];
    const cap = Number(d.cap);
    deliver.cap = Number.isFinite(cap) && cap > 0 ? cap : DELIVER_DEFAULT_CAP;
    const kept = Number(d.kept);
    deliver.kept = Number.isFinite(kept) ? kept : deliver.entries.length;
    // The watermark: the STORE's, never below what this page has already cleared. Taking the max is what keeps a
    // cleared badge cleared when a GET answered just before the POST landed — the next poll cannot re-light it, and a
    // fresh entry (a seq above the watermark) still does.
    const serverSeen = Number(d.seenSeq);
    if (Number.isFinite(serverSeen)) deliver.serverSeen = serverSeen;
    deliver.seenSeq = Math.max(Number(deliver.seenSeq) || 0, Number(deliver.serverSeen) || 0);
    deliver.unseen = deliverUnseenCount();
    deliver.loading = false;
    deliver.error = "";
    if (quiet) {
      const i = deliverList().findIndex((x) => x.seq === activeSeq);
      if (i >= 0) deliver.active = i;
    }
    paintDeliverRows({ keepScroll: quiet });
    paintDeliverBadge();
  } catch (e) {
    deliver.loading = false;
    deliver.error = String((e && e.message) || e);
    paintDeliverRows();
  }
}

function paintDeliverRows({ keepScroll = false } = {}) {
  const pop = deliver.el;
  if (!pop) return;
  const body = pop.querySelector("#dl-list");
  const foot = pop.querySelector("#dl-foot");
  const head = pop.querySelector("#dl-count");
  const scrollTop = body.scrollTop;

  if (deliver.loading && !deliver.entries.length) {
    head.textContent = "reading…";
    body.innerHTML = `<div class="dl-empty">reading the list…</div>`;
    foot.hidden = true;
    return;
  }
  if (deliver.error) {
    head.textContent = "deliverables";
    body.innerHTML = `<div class="dl-empty dl-err">could not read the list: ${esc(deliver.error)}</div>
      <button type="button" class="dl-retry" data-dl-retry="1">retry</button>`;
    foot.hidden = true;
    return;
  }

  const rows = deliverList();
  const kept = deliver.kept || deliver.entries.length;
  // The chips first: which ones exist, and which way each is pressed, is part of what the head SAYS — a count that
  // named a kind the header had just hidden would be the page arguing with itself.
  paintDeliverKinds(window.wtDeliverKinds.presentKinds(deliver.entries));
  head.textContent = window.wtDeliverKinds.countText({
    shown: rows.length,
    total: kept,
    query: deliver.filter,
    off: deliver.kindsOff,
    entries: deliver.entries,
  });

  if (!deliver.entries.length) {
    body.innerHTML = `<div class="dl-empty">Nothing has been delivered yet.</div>
      <div class="dl-empty dl-hint">A deliverable is a file or URL the reader can open, not a description of one — an agent hands one back with one line in its final message:
        <code>DELIVER file C:/path/to/report.html | The report</code></div>`;
    foot.hidden = true;
    return;
  }
  if (!rows.length) {
    body.innerHTML = `<div class="dl-empty">${esc(window.wtDeliverKinds.emptyText({ query: deliver.filter, off: deliver.kindsOff }))}</div>`;
    foot.hidden = true;
    return;
  }

  let markup = "";
  let day = "";
  for (const entry of rows) {
    const label = deliverDayLabel(entry.at);
    if (label !== day) {
      day = label;
      markup += `<div class="dl-day" role="presentation">${esc(label)}</div>`;
    }
    markup += deliverRowHtml(entry);
  }
  body.innerHTML = markup;
  if (deliver.active >= rows.length) deliver.active = rows.length - 1;
  if (deliver.active < 0) deliver.active = 0;
  deliverMarkActive({ scroll: !keepScroll });
  if (keepScroll) body.scrollTop = scrollTop;

  // The cap line appears only AT the cap: below it there is nothing to explain.
  if (deliver.kept >= deliver.cap && deliver.cap > 0) {
    foot.hidden = false;
    foot.textContent = `${deliver.cap} kept — older rows are forgotten; the files stay on disk.`;
  } else {
    foot.hidden = true;
  }
}

// A row: a glyph by kind, the name — which is the row's ONE Open control, and says so with the Open tag at its
// right — the last few path segments or the URL's host+path so two reports called "report" are distinguishable,
// then the agent, the project and the age. One control opens the target and its title says which of the two things
// it will do (a new tab, or the browser this machine is registered to use, with the fallbacks in
// lib/open-url.js behind it); nothing else on the row opens it.
function deliverRowHtml(entry) {
  const kind = entry.kind === "image" ? "image" : entry.kind === "link" ? "link" : "file";
  const glyph = kind === "image" ? "🖼" : kind === "link" ? "🔗" : "📄";
  const target = String(entry.target || "");
  const shown = kind === "link" ? deliverLinkLabel(target) : tailPath(target, 3);
  const meta = [entry.agent, entry.project].filter(Boolean).map((v) => esc(v)).join(" · ");
  const age = fmtAgo(entry.at);
  const lastSeen = entry.missingAt
    ? `last seen ${new Date(entry.missingAt).toLocaleString()} — delivered by ${entry.agent || "an agent"}`
    : "";
  const gone = entry.missingAt ? `<span class="dl-gone" title="${esc(lastSeen)}">gone</span>` : "";
  const why = deliver.why[entry.seq];
  const whyLine = why ? `<span class="dl-why" role="alert">${esc(why)}</span>` : "";
  const opened = deliver.opened[entry.seq];
  // The 200 handler's answer, in the row: the file, the launcher the ROUTE says started, and - when one fired -
  // which fallback it was. The route hands a local file to the browser this machine is registered to use, so the
  // opener's name is a browser's (`msedge.exe`), not `explorer.exe` for everything. It still stops where the spawn
  // stops: no detached child reports whether a window appeared, so the line says "cannot see", never that it did.
  // A reuse is the other answer and says so: the first open is what put the file on screen, this click started
  // nothing, and the row must not claim a window for it.
  const openedLine =
    opened && !why
      ? opened.reused
        ? `<span class="dl-opened" role="status" title="${esc(`already open in ${opened.opener}${deliverViaText(opened)} - ${target}`)}">already open in ${esc(opened.opener)}${esc(deliverViaText(opened))} - not opened again, this click started nothing (${esc(deliverAgeText(opened.ageMs))} ago)</span>`
        : `<span class="dl-opened" role="status" title="${esc(`opened ${opened.name} with ${opened.opener}${deliverViaText(opened)} - ${target}`)}">opened ${esc(opened.name)} with ${esc(opened.opener)}${esc(deliverViaText(opened))}; the panel started it and cannot see whether a window appeared</span>`
      : "";
  const how = entry.href
    ? "Open — a new browser tab, in this browser"
    : "Open — in the browser this machine uses for this file";
  return `<div class="dl-row${entry.missingAt ? " is-gone" : ""}" role="option" id="dl-row-${esc(entry.seq)}" data-seq="${esc(entry.seq)}" aria-selected="false" title="${esc(target)}">
      <span class="dl-glyph" aria-hidden="true">${glyph}</span>
      <span class="dl-main">
        <button type="button" class="dl-name${entry.missingAt ? " is-gone" : ""}" data-dl-open="${esc(entry.seq)}" title="${esc(`${how}\n${target}`)}"><span class="dl-title">${esc(entry.title || "(untitled)")}</span></button>
        <span class="dl-target mono" title="${esc(target)}">${esc(shown)}</span>
        <span class="dl-meta">${meta}${meta ? " · " : ""}<span class="dl-age" data-at="${esc(entry.at || "")}">${esc(age)}</span></span>
        ${whyLine}
        ${openedLine}
      </span>
      ${gone}
      <button type="button" class="dl-agent" data-dl-agent="${esc(entry.seq)}" title="open the agent that delivered this">open agent</button>
    </div>`;
}

// A URL as a row can afford to show it: host and path, no scheme — the title's tooltip carries the whole thing.
function deliverLinkLabel(target) {
  try {
    const u = new URL(target);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}${u.search}${u.hash}`;
  } catch {
    return target;
  }
}

// TODAY / YESTERDAY / 2026-11-01, so a long scroll has landmarks. Local time, because that is the clock the
// reader reads "3m ago" against.
function deliverDayLabel(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const now = new Date();
  if (sameDay(d, now)) return "TODAY";
  if (sameDay(d, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return "YESTERDAY";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// The active row is the combobox's `aria-activedescendant`: one active row, scrolled into view inside the body
// (never the page — the popover is fixed).
function deliverMarkActive({ scroll = true } = {}) {
  const pop = deliver.el;
  if (!pop) return;
  const rows = [...pop.querySelectorAll(".dl-row")];
  const input = pop.querySelector("#dl-filter");
  if (!rows.length) {
    input?.removeAttribute("aria-activedescendant");
    return;
  }
  const i = Math.min(Math.max(0, deliver.active), rows.length - 1);
  deliver.active = i;
  rows.forEach((row, n) => row.setAttribute("aria-selected", n === i ? "true" : "false"));
  input?.setAttribute("aria-activedescendant", rows[i].id);
  if (!scroll) return;
  const body = pop.querySelector("#dl-list");
  const view = body.getBoundingClientRect();
  const rowRect = rows[i].getBoundingClientRect();
  if (rowRect.top < view.top) body.scrollTop -= view.top - rowRect.top;
  else if (rowRect.bottom > view.bottom) body.scrollTop += rowRect.bottom - view.bottom;
}

function paintDeliverAges() {
  for (const el of document.querySelectorAll("#deliver-pop .dl-age[data-at]")) {
    el.textContent = fmtAgo(el.dataset.at);
  }
}

// ↓/↑ move one row, Home/End jump, PageDown/PageUp move ten, Enter opens the target and Alt+Enter the agent. It
// stops at the ends on purpose: a 200-row list that wraps is a list the reader cannot tell the end of.
function deliverKeydown(e) {
  const rows = deliverList();
  if (!rows.length) return;
  const move = (n) => {
    deliver.active = Math.min(rows.length - 1, Math.max(0, deliver.active + n));
    deliverMarkActive();
  };
  if (e.key === "ArrowDown") {
    e.preventDefault();
    move(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    move(-1);
  } else if (e.key === "Home") {
    e.preventDefault();
    move(-rows.length);
  } else if (e.key === "End") {
    e.preventDefault();
    move(rows.length);
  } else if (e.key === "PageDown") {
    e.preventDefault();
    move(10);
  } else if (e.key === "PageUp") {
    e.preventDefault();
    move(-10);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const entry = rows[deliver.active];
    if (!entry) return;
    if (e.altKey) void deliverOpenAgent(entry.seq);
    else void deliverOpenTarget(entry.seq);
  }
}

// THE one Open control's decision, in one place. A row the store gave a URL opens in a tab — synchronously, in the
// click: an await before window.open is a popup the browser blocks, which is why this is not a fetch. Everything
// else is a file the browser cannot render, and it goes through the panel's one route to the OS default handler.
async function deliverOpenTarget(seq) {
  const entry = deliver.entries.find((x) => Number(x.seq) === Number(seq));
  if (!entry) return false;
  if (entry.href) {
    clearDeliverWhy(entry.seq);
    const tab = window.open(entry.href, "_blank");
    if (tab) {
      // No `noopener` in the feature string: that makes window.open return null even when the tab DID open, and the
      // handle is how a blocked tab is told from an opened one. Severing `opener` here is the same guarantee.
      try {
        tab.opener = null;
      } catch {
        /* a cross-origin tab is already its own */
      }
      return true;
    }
    // Blocked (a host that refuses a new tab). A LINK has one more place to go — the panel launches it, which is the
    // opener it has always had. A served path has nowhere else: the browser is the only thing that can fetch it, so
    // the card says what happened instead of opening a blank tab.
    if (entry.kind === "link") return deliverOpenOnServer(entry, { mode: "launch" });
    return sayDeliverWhy(entry.seq, "your browser blocked the tab — allow pop-ups for this panel, then press Open again");
  }
  return deliverOpenOnServer(entry, {});
}

// The route, for the one case that needs it: a file with no URL on the panel. Its answer is either "the OS handler
// has it" — which this row now says, with the opener's name and no claim about a window — or the refusal the row
// must state, unchanged: the body's own `error`, never a sentence this page composes for it.
async function deliverOpenOnServer(entry, extra) {
  try {
    const r = await apiFetch("/api/deliverables/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seq: Number(entry.seq), ...extra }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      sayDeliverWhy(entry.seq, String(d.error || `could not open that deliverable (HTTP ${r.status})`));
      if (r.status === 404) void deliverFetch({ quiet: true });
      return false;
    }
    // The 200 handler is the answer the page used to swallow. `d.opener` is the basename the route spawned, `d.via`
    // names the mechanism and `d.fallback` how far down the ladder it was; none of them is a claim that a window
    // appeared, so the row says exactly those. A REUSE (`d.open === "reused"`) is the one answer where the route
    // spawned NOTHING: the file is already on screen from an open inside the last five minutes, and the row says that
    // instead of a second "opened" for a click that started no process.
    if (d.open === "handler" || d.open === "reused") {
      return sayDeliverOpened(entry.seq, {
        name: deliverTargetName(d.target || entry.target),
        opener: String(d.opener || ""),
        via: String(d.via || ""),
        progId: d.progId ? String(d.progId) : "",
        fallback: Number(d.fallback) || 0,
        reused: d.open === "reused",
        ageMs: Number(d.ageMs) || 0,
      });
    }
    clearDeliverWhy(entry.seq);
    return true;
  } catch (e) {
    sayDeliverWhy(entry.seq, `could not open that deliverable: ${String((e && e.message) || e)}`);
    return false;
  }
}

// The last segment of a path or URL, for the row's answer line: what was opened, in the reader's terms.
function deliverTargetName(target) {
  const parts = String(target || "").split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(target || "");
}

// How long ago the open that put the file on screen happened, in the row's own words. A reuse is inside five minutes
// by construction, so seconds are the useful unit, and rounding to 0 would read as if the page had just opened.
function deliverAgeText(ms) {
  const s = Math.max(1, Math.round((Number(ms) || 0) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// WHICH launcher took the file, in the reader's words. The route sends the mechanism (`via`), the registered
// ProgID when it resolved one, and how many launchers were tried before this one (`fallback`), so a fallback is
// never silent: the row says `fallback 1 of 2: rundll32 FileProtocolHandler` rather than implying a browser took it.
function deliverViaText(opened) {
  const via = String((opened && opened.via) || "");
  if (!via) return "";
  if (via === "default browser") {
    return ` - the registered default browser${opened.progId ? ` (${opened.progId})` : ""}`;
  }
  const n = Number(opened && opened.fallback);
  if (Number.isFinite(n) && n > 0) return ` - fallback ${n} of 2: ${via}`;
  return ` - ${via}, with no browser resolved`;
}

// A 200 that spawned a handler. One paint covers both halves — the refusal this row may be carrying goes, the
// answer takes its place — because two repaints would flash the row twice for one click.
function sayDeliverOpened(seq, opened) {
  delete deliver.why[seq];
  deliver.opened[seq] = opened;
  paintDeliverRows({ keepScroll: true });
  return true;
}

// A refusal belongs to its ROW. The banner is for the board (a failed write, a lost gateway); "no such file" is a
// fact about one card, and a reader scrolling a 200-row list must see which card it was.
function sayDeliverWhy(seq, why) {
  // A later refusal replaces an earlier answer: the row says the last thing the route said, and only that.
  delete deliver.opened[seq];
  deliver.why[seq] = String(why || "").trim() || "could not open that deliverable";
  paintDeliverRows({ keepScroll: true });
  return false;
}

function clearDeliverWhy(seq) {
  if (!deliver.why[seq]) return;
  delete deliver.why[seq];
  paintDeliverRows({ keepScroll: true });
}

// Which console a row opens. This is humanShow's own path (public/app.js, "HUMAN" above), copied rather than
// extracted: the plan's §8 says this feature edits no other module's renderer, and an extraction here would be a
// second idea of "this turn is the one". The steps are the same five — find the conversation, page the turn in by
// JOB ID, open the float for an assistant or the row for a board card, re-query the card the render replaced,
// scroll it under the bar and flash it.
function deliverOpenAgent(seq) {
  const entry = deliver.entries.find((x) => Number(x.seq) === Number(seq));
  if (!entry) return false;
  const thread = entry.thread;
  if (!thread) {
    showBanner("that deliverable's agent and worktree are both gone");
    return false;
  }
  const conv = conversations().find((c) => c.thread === thread);
  const assistant = assistantSessionFor(thread);
  const noRun = "the run that delivered this is no longer on the board — opened its worktree";
  if (!conv && !assistant) return deliverOpenWorktree(entry, noRun);

  // The turn is found by JOB ID, never by the `turn` counter: `turn` is siblings.length + 1 and moves BACKWARDS
  // when old jobs are trimmed, so an entry keyed by it would open the wrong turn or none (the review's M7).
  let jobId = entry.jobId;
  let trimmed = false;
  if (conv && jobId && !conv.turns.some((t) => t.id === jobId)) {
    const newest = conv.turns[conv.turns.length - 1];
    if (newest) {
      jobId = newest.id;
      trimmed = true;
    }
  }
  if (conv && jobId) {
    // The recorded turn, unfolded and paged in — the same claim `humanShow` makes, written once in the module. The
    // trimmed case above already re-pointed `jobId` at the newest turn, so `reveal` always finds it.
    wtTurnFold.reveal(state, thread, conv.turns, jobId);
  }

  let card;
  if (assistant) {
    // An assistant's card is not on the board at all: it lives in the float, one Chat pane per assistant.
    if (typeof window.__assistantShowThread !== "function" || !window.__assistantShowThread(thread)) {
      return deliverOpenWorktree(entry, noRun);
    }
    renderConversation(thread);
    card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
  } else {
    const row = hotRowFor(thread);
    if (row) hotOpenPath(row);
    if (state.collapsedJobs.has(thread)) state.collapsedJobs.delete(thread);
    renderConversation(thread);
    card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
    if (!card) {
      renderJobs();
      card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
    }
  }
  if (!card) return deliverOpenWorktree(entry, noRun);

  // Closed before the scroll, so the popover cannot cover the card it just opened.
  closeDeliverPop();
  scrollCardUnderBar(card);
  flashHotCard(thread);
  if (trimmed) showBanner("that turn is no longer on the board — opened the newest one");
  return true;
}

// The last fallback: the thread is gone from the store, so open the worktree whose row the entry names — by
// project+path first, then by the branch the delivery recorded.
function deliverOpenWorktree(entry, why) {
  const gone = "that deliverable's agent and worktree are both gone";
  if (!entry.project) {
    showBanner(gone);
    return false;
  }
  const want = keyOf(entry.project, entry.treePath || "");
  const rows = [...state.rows.values()];
  const row =
    rows.find((r) => keyOf(entry.project, r.path) === want) ||
    (entry.branch ? rows.find((r) => r.project === entry.project && r.branch === entry.branch) : null);
  if (!row) {
    showBanner(gone);
    return false;
  }
  hotOpenPath(row);
  closeDeliverPop();
  document
    .querySelector(`tr.row[data-key="${CSS.escape(keyOf(entry.project, row.path))}"]`)
    ?.scrollIntoView({ block: "center" });
  showBanner(why || "the run that delivered this is no longer on the board — opened its worktree");
  return true;
}
// ---- end deliverables
