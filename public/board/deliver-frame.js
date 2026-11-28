// deliver-frame.js - the deliverables popover's FRAME: where it sits on the page, how big it is, and the two
// gestures that move and resize it. Cut out of public/deliverables.js.
//
// WHY THIS FILE EXISTS. public/deliverables.js was 1,063 lines in one file: the popover, its place and size, its
// two gestures, the badge, the rows and the two openers all shared one scope, so a placement change and a row
// change were the same file. docs/reports/module-separation-2026-11-28.html's card for public/deliverables.js
// splits it two ways: public/board/deliver-frame.js (the popup's place and its two gestures) and
// public/board/deliver-rows.js (the badge, the rows, the keydown and the open control). This is the first cut
// (row 521). Not one body was rewritten and not one call site was touched.
//
// THE BLOCK, AND WHERE IT CAME FROM. The code below is lines 246-460 of the file as it stood at this cut
// (f22b1c78:public/deliverables.js), moved byte for byte. The report's span for this cut is 246-509, but 463-509 is
// THE BADGE (deliverUnseenCount and paintDeliverBadge), which the report's second cut claims as "the badge, the
// rows, ..."; the frame therefore ends where the gesture code ends, at deliverGestureEnd's closing brace, and the
// badge stays in public/deliverables.js to begin the second cut. Rows 444 and 530 changed the board's deliver rows
// after the report was measured, so the boundaries here were read from the file as it stands, not from its numbers.
//
// WHAT IS HERE
//
//   the floors and the key   DL_MARGIN, DL_GAP, DL_MIN_W, DL_MIN_H, DL_MAX_W, DL_MAX_H, DL_SLOP and DL_RECT_KEY:
//                            every length the frame is clamped to, and the localStorage key the reader's rectangle
//                            is remembered under.
//   the frame's own state    deliverGeo (rect, sized, drag, resize): the rectangle the page is drawing, and the
//                            live gesture, if any.
//   the arithmetic           deliverZoom and deliverSpace (the page zoom, the visual room, and the factor that turns
//                            a visual length into a style length), clampDeliverRect, paintDeliverRect and
//                            clearDeliverRect.
//   the memory               deliverStoredRect, deliverRemember, deliverForget, deliverStoredFits, deliverRestore and
//                            deliverPosition: the reader's rectangle, restored only while it still fits this window,
//                            otherwise the default under the button with the whole panel clamped into the window.
//   the two gestures         deliverGestureStart, deliverGestureMove and deliverGestureEnd: the head drags, the corner
//                            resizes, and a press that moves less than DL_SLOP is a click on the head, not a drag.
//
// WHAT IT REACHES OUT FOR (by name, at call time, exactly as before the move)
//
//   deliver                  the list's own state object, still declared in public/deliverables.js: the frame reads
//                            deliver.el for the popover node, and writes nothing else on it.
//   $                        the cached node lookup (public/core/dom-format.js), for btn-deliver.
//   the page                 getComputedStyle and documentElement.style.zoom for the zoom, window.innerWidth and
//                            window.innerHeight for the room, and localStorage for the remembered rectangle.
//
// THE LOAD CONTRACT. public/index.html loads CLASSIC scripts, so the page is one global scope: a top-level
// `function` here is a window property and a top-level `const` a binding every other script reads by bare name.
// This file DECLARES ONLY - the DL_* floors are literal numbers, DL_RECT_KEY a literal string and deliverGeo a
// literal object - so being loaded before public/deliverables.js and public/app.js costs nothing and cannot land in
// a temporal dead zone. public/deliverables.js keeps the header and the record of this surface, and public/app.js
// still re-exports every one of these names on window.WMApp.deliverables.

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
