#!/usr/bin/env node
// GATE: the console corner's RELEASE CONTRACT - the height a drag draws is the height the release keeps, so the
// corner never jumps when the pointer comes up.
//
//   node tools/verify-console-resize-release.mjs
//   node tools/verify-console-resize-release.mjs --viewport 1400x900
//   node tools/verify-console-resize-release.mjs --json <path>
//   node tools/verify-console-resize-release.mjs --headed
//   node tools/verify-console-resize-release.mjs --keep
//
// WHAT IT GUARDS, AND WHY IT IS A GATE. The corner gesture follows the pointer for the whole drag (public/app.js's
// pointermove -> outGripStep -> setOutHeight) and holds the box to a band (outGripLimit) whose top is the ROOM the box
// has under its top edge in the viewport,
//
//   room = max(sheet cap, round(innerHeight - top - OUT_GRIP_ROOM))
//
// in layout px, with OUT_GRIP_ROOM 8. THE DEFECT THIS WAS BUILT FROM, measured on 1.180.1: the move ran free and the
// release applied that room, so a downward drag that carried the corner past it drew a height the pointerup took back
// - 892px drawn, 772px kept, 120px of bounce, at page zoom 100, 90 AND 110. The fix is that the move stops the box on
// the room while the pointer keeps going (the way a window resize stops at the screen edge) and the release's clamp
// then returns the height already on the box. This gate is the measurement turned into a verdict: for EVERY accepted
// drag the release+1 height minus the last-move height must be 0.
//
// WHAT IT ASSERTS, per case:
//
//   delta 0        release+1 height minus the last-move height, within 0.5px. This is the bounce.
//   top unchanged  the release moves neither edge of the box, within 0.5px (a corner that jumps shows up in either).
//   the shape      follow: the box drew what the hand asked, and the grip's bottom is on the pointer at the last move.
//                  limit:  the hand asked for at least 20px MORE than the room, the pointer passed the viewport's
//                          bottom edge, and the box stopped ON the room - a case that failed to carry the corner past
//                          the limit would otherwise read as a clean zero.
//                  hold:   a press that never moved changed nothing while the hand was down.
//   the store      state.outHeights and `--out-h` both hold the height the box draws after the release.
//
// Four numbers are printed per case, all in LAYOUT px - the unit `--out-h`, the sheet's min/max-height and the room are
// written in; a rect and a pointer are VISUAL, and are divided by the page zoom before they are reported:
//
//   asked       the hand's own request at the last move, before the band was applied (the page's outGripDrag.want)
//   last-move   the box's height after the FINAL pointermove
//   release+1   the box's height one animation frame after pointerup
//   delta       release+1 minus last-move. A non-zero delta is the corner jumping at the release.
//
// THE CASES. inside-room: a drag well inside the room. past-room-120: the last move asks for the room plus 120px, so
// the corner is carried past it - the reader's bounce, and now the box must stop on the room. The same past-room drag
// at page zoom 90 and 110. past-then-back: past the room, then back up 60px inside it, so the corner must return to
// the hand rather than staying at the limit (the limit is applied from the pointer's own position, not accumulated).
// The same return at 90%. press-only: a press that never moves. upward: a shrink. The zoom is the page's own
// (Settings > Display, `applyZoom` in public/settings.js), a layout scale on documentElement, so a pointer length and a
// CSS length stop being the same number away from 100 - and the bounce was identical at all three zooms.
//
// WHY A SYNTHETIC CONSOLE. The bounce is a property of the gesture and the box's geometry, not of the transcript, so
// the console is BUILT into the real page - the real sheet, the real delegated pointerdown, the real release - rather
// than seeding a board, a transcript and a stub gateway to drag a live card: `.out-wrap > .out-box > pre.job-out` plus
// `.out-grip`, placed fixed in the viewport where its room is known, given a 200 px height through the page's ONE
// writer (setOutHeight). The pointer is real CDP input, the same trusted press and moves a reader makes, including
// moves BELOW the viewport's bottom edge (a hand that travels past the screen is how the room is overrun on a page
// whose zoom lets it be). What this shape therefore does NOT cover is a console inside a scrollport whose top edge a
// pin or a rebuild moves mid-drag: that is tools/verify-console-corner-drag.mjs's matrix, which reads the same
// unclamped request (`dragWant`) to tell a box held on the limit from a corner the gesture lost.
//
// The panel is a throwaway one (tools/panel-testkit.mjs: spare port, own PANEL_CONFIG / HERMES_HOME / stores,
// assistant off, fetch off), so no board, no gateway key and no reader's tab are involved.
//
// EXIT CODE: 0 when every case passed, 1 when a case failed or could not be measured (a press that missed the grip, a
// console that did not draw, a release whose frame read never landed), 2 when the panel or the browser half did not
// run.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadPlaywright, notRun } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

const VIEWPORT = String(opt("viewport", "1400x900")).split("x").map(Number);
const WIDTH = Number.isFinite(VIEWPORT[0]) && VIEWPORT[0] > 200 ? VIEWPORT[0] : 1400;
const HEIGHT = Number.isFinite(VIEWPORT[1]) && VIEWPORT[1] > 200 ? VIEWPORT[1] : 900;
const JSON_OUT = opt("json", null);
const KEEP = flag("keep");
const HEADED = flag("headed");

// The console every case drags. One id, so the page-side hook and the Node side agree about WHICH console a frame was
// read from; a case rebuilds the node, and the id is what survives the rebuild.
const OUT = "resize-release-probe";
// Where the synthetic console is placed, in layout px from the viewport's top-left corner. Its top edge is what the
// release's room is measured from, so it is a case input, not a style preference: 120 px puts a 200 px box well up the
// screen, with a known 772 px of room under it at a 900 px viewport.
const TOP = 120;
const LEFT = 40;
const BOX_W = 640;
const START_H = 200; // the press height: under the sheet's 230 px cap, so the cap is read for real
const INSIDE_PX = 150; // how far inside the room the inside-room drag stops
const PAST_PX = 120; // how far past the room the past-room drag's last move asks for
const BACK_PX = 60; // how far back inside the room the return drag comes
const UP_PX = 80; // how far the upward drag shrinks the box
const STEPS = 5; // pointer moves per leg
const STEP_MS = 45;
const HOLD_MS = 350; // the press-only case's hold, so it is a press and not a click
const GRIP_INSET_PX = 3; // a hand lands a few px inside the 18 px band
const ROOM_PX = 8; // OUT_GRIP_ROOM, public/app.js
const SETTLE_MS = 400; // after a zoom change and a rebuild
const FRAME_WAIT_MS = 3000;

// The tolerances. `delta` is the defect: the release writes a rounded pixel height, so anything above half a pixel is
// a real move and a bounce is tens of pixels. `follow` is the same 2px the repo's corner gates use.
const RELEASE_TOLERANCE_PX = 0.5;
const STORE_TOLERANCE_PX = 0.5;
const FOLLOW_TOLERANCE_PX = 2;
const LIMIT_TOLERANCE_PX = 1;
const LIMIT_MARGIN_PX = 20; // how far past the room a "limit" case must ask, so a short drag cannot pass vacuously
const WANT_TOLERANCE_PX = 1.5; // the page's own record of the hand's request against the height the case planned

// The shape each case drives. `drag` is what the pointer does; `zoom` is the page's own zoom in percent; `expect` is
// the promise the verdict holds the case to.
const CASES = [
  { id: "inside-room", zoom: 100, drag: "inside", expect: "follow", note: "a drag well inside the room under the corner" },
  { id: "past-room-120", zoom: 100, drag: "past", expect: "limit", note: "the corner carried past the room by about 120 px" },
  { id: "past-room-120@90", zoom: 90, drag: "past", expect: "limit", note: "the same drag on a page at 90%" },
  { id: "past-room-120@110", zoom: 110, drag: "past", expect: "limit", note: "the same drag on a page at 110%" },
  { id: "past-then-back", zoom: 100, drag: "back", expect: "follow", note: "past the room, then back 60 px inside it: the corner must return to the hand" },
  { id: "past-then-back@90", zoom: 90, drag: "back", expect: "follow", note: "the same return on a page at 90%" },
  { id: "press-only", zoom: 100, drag: "none", expect: "hold", note: "a press that never moves" },
  { id: "upward", zoom: 100, drag: "up", expect: "follow", note: "a drag upward, a shrink" },
];

// ---- the page half ------------------------------------------------------------------------------------------------
// Installed once, and reachable as `window.__RR_API`. Everything is looked up at call time: a case replaces the console
// node, and a helper that remembered the old one would measure a node nobody is holding.
const PAGE_HELPERS = (cfg) => {
  const zoomOf = () => {
    const v = parseFloat(getComputedStyle(document.documentElement).zoom);
    return Number.isFinite(v) && v > 0 ? v : 1;
  };
  const out = () => document.querySelector(`#${cfg.host} pre.job-out[data-out="${cfg.out}"]`);
  const grip = () => out()?.parentElement.querySelector(":scope > .out-grip") || null;
  // The cap the press will read, through the page's own reader when this build has one: a box an earlier gesture left
  // with `max-height: none` inline has no parseable computed cap, and outGripCap is the function that lifts that inline
  // value for the read and puts it back.
  const capOf = (o, cs) => {
    if (typeof outGripCap === "function") return outGripCap(o, cs);
    return parseFloat(cs && cs.maxHeight);
  };

  const read = () => {
    const o = out();
    const g = grip();
    if (!o || !g) return null;
    const z = zoomOf();
    const r = o.getBoundingClientRect();
    const gr = g.getBoundingClientRect();
    const cs = getComputedStyle(o);
    const cap = capOf(o, cs);
    const room = Math.max(Number.isFinite(cap) ? cap : 0, Math.round(window.innerHeight - r.top / z - cfg.room));
    return {
      h: +(r.height / z).toFixed(2),
      top: +(r.top / z).toFixed(2),
      bottom: +(r.bottom / z).toFixed(2),
      gripBottom: +gr.bottom.toFixed(2),
      gripRight: +gr.right.toFixed(2),
      varH: o.style.getPropertyValue("--out-h"),
      varPx: (() => {
        const n = parseFloat(o.style.getPropertyValue("--out-h"));
        return Number.isFinite(n) ? n : null;
      })(),
      maxH: cs.maxHeight,
      inlineMax: o.style.maxHeight,
      z,
      innerH: window.innerHeight,
      innerW: window.innerWidth,
      room,
      cap: Number.isFinite(cap) ? cap : null,
      held: typeof outDragging === "function" ? outDragging(o) : null,
      moved: typeof outGripDrag !== "undefined" && outGripDrag ? Boolean(outGripDrag.moved) : null,
      // The hand's own request, before the gesture's band was applied (public/app.js outGripDrag.want). The difference
      // between this and the height on the box is the clamp doing its job, not the drag failing.
      want: typeof outGripDrag !== "undefined" && outGripDrag && outGripDrag.want != null ? +Number(outGripDrag.want).toFixed(2) : null,
      held_room: typeof outGripDrag !== "undefined" && outGripDrag && Number.isFinite(Number(outGripDrag.room)) ? +Number(outGripDrag.room).toFixed(2) : null,
      content: +((o.scrollHeight || 0) / z).toFixed(2),
      stored: (() => {
        try {
          const n = Number(state.outHeights && state.outHeights[cfg.out]);
          return Number.isFinite(n) && n > 0 ? n : null;
        } catch {
          return null;
        }
      })(),
    };
  };

  window.__RR = window.__RR || { installed: false, frameH: null, frameTop: null, syncH: null, syncTop: null, ys: [], lastY: null, ups: 0 };

  window.__RR_API = {
    // The console, built fresh. A case starts from the same node and the same 200 px, so a previous case's height, cap
    // lift or store entry cannot leak into the next one's numbers.
    build: () => {
      document.getElementById(cfg.host)?.remove();
      // A fresh console is one the reader never sized: the store entry from the previous case is cleared, so
      // `stored` on a press-only case reads unset rather than the number the last drag left behind.
      try {
        if (state.outHeights) delete state.outHeights[cfg.out];
        const ls = JSON.parse(localStorage.getItem("wm.outHeights") || "{}");
        delete ls[cfg.out];
        localStorage.setItem("wm.outHeights", JSON.stringify(ls));
      } catch {
        /* the store is best effort here */
      }
      const host = document.createElement("div");
      host.id = cfg.host;
      host.style.cssText = `position:fixed;left:${cfg.left}px;top:${cfg.top}px;width:${cfg.width}px;z-index:99999`;
      host.innerHTML = `<div class="out-wrap out-tab"><div class="out-box"><pre class="job-out" data-out="${cfg.out}"></pre><span class="out-grip" data-out-grip="1" title="drag this corner to resize the console"></span></div></div>`;
      document.body.appendChild(host);
      const pre = host.querySelector("pre.job-out");
      pre.textContent = Array.from({ length: 40 }, (_, i) => `probe line ${i + 1}: this console is taller than the box it is drawn in`).join("\n");
      if (typeof setOutHeight !== "function") return { ok: false, why: "the page has no setOutHeight" };
      const set = setOutHeight(pre, cfg.startH);
      window.__RR.frameH = null;
      window.__RR.frameTop = null;
      window.__RR.syncH = null;
      window.__RR.syncTop = null;
      window.__RR.ys = [];
      window.__RR.lastY = null;
      window.__RR.ups = 0;
      return { ok: set === true, set, varH: pre.style.getPropertyValue("--out-h") };
    },
    read,
    // The corner a hand reaches for: a few px inside the 18 px band.
    at: () => {
      const g = grip();
      if (!g) return null;
      const r = g.getBoundingClientRect();
      return { x: +(r.right - cfg.inset).toFixed(1), y: +(r.bottom - cfg.inset).toFixed(1) };
    },
    // What is at the corner's point. A press that misses the band is a case that measured nothing, and this separates a
    // hand one px off from a corner something else on the page is painting over.
    hit: (pt) => {
      const g = grip();
      const el = pt ? document.elementFromPoint(pt.x, pt.y) : null;
      const name = (n) => {
        if (!n) return "nothing";
        const cls = typeof n.className === "string" && n.className.trim() ? `.${n.className.trim().split(/\s+/).join(".")}` : "";
        return `${n.tagName.toLowerCase()}${cls}`;
      };
      return { onGrip: Boolean(g && el && (el === g || g.contains(el))), at: name(el) };
    },
    zoom: (pct) => {
      document.documentElement.style.zoom = pct === 100 ? "" : String(pct / 100);
      try {
        localStorage.setItem("wtgui.zoom", String(pct));
      } catch {
        /* private mode */
      }
      if (typeof state !== "undefined") state.zoom = pct;
      return zoomOf();
    },
    // The one-frame reader: a pointerup that runs AFTER the gesture's own capture handler has applied the release
    // clamps, then one requestAnimationFrame. `sync` is the same task's reading, kept as context only.
    install: () => {
      if (window.__RR.installed) return true;
      window.__RR.installed = true;
      window.addEventListener(
        "pointerup",
        () => {
          const o = out();
          if (!o) return;
          const z = zoomOf();
          const r = o.getBoundingClientRect();
          window.__RR.ups += 1;
          window.__RR.syncH = +(r.height / z).toFixed(2);
          window.__RR.syncTop = +(r.top / z).toFixed(2);
          requestAnimationFrame(() => {
            const r2 = o.getBoundingClientRect();
            window.__RR.frameH = +(r2.height / z).toFixed(2);
            window.__RR.frameTop = +(r2.top / z).toFixed(2);
          });
        },
        false,
      );
      window.addEventListener(
        "pointermove",
        (e) => {
          window.__RR.lastY = +e.clientY.toFixed(1);
          window.__RR.ys.push(window.__RR.lastY);
          if (window.__RR.ys.length > 60) window.__RR.ys.shift();
        },
        true,
      );
      return true;
    },
    probe: () => ({ ...window.__RR, ys: window.__RR.ys.slice(-6) }),
    version: () => (typeof state !== "undefined" && state.settings ? state.settings.version : ""),
  };
  return true;
};

// The heights (layout px) the hand asks for, in order. Empty is the press-only case; two entries are a drag with a
// direction change. The past-room legs ask for more than the room on purpose.
function targetsFor(spec, press) {
  if (spec.drag === "inside") return [press.h + INSIDE_PX];
  if (spec.drag === "past") return [press.room + PAST_PX];
  if (spec.drag === "back") return [press.room + PAST_PX, press.room - BACK_PX];
  if (spec.drag === "up") return [press.h - UP_PX];
  return [];
}

// One case: fresh console, zoom, press, motion, release, the four numbers.
async function runCase(page, spec) {
  const built = await page.evaluate(() => window.__RR_API.build());
  if (!built || built.ok !== true) throw new Error(`the synthetic console did not take a height: ${JSON.stringify(built)}`);
  await page.evaluate((pct) => window.__RR_API.zoom(pct), spec.zoom);
  await page.waitForTimeout(SETTLE_MS);
  const before = await page.evaluate(() => window.__RR_API.read());
  if (!before) throw new Error("the synthetic console did not draw");
  const at = await page.evaluate(() => window.__RR_API.at());
  if (!at) throw new Error("the synthetic console has no corner grip");
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(50);
  const prePress = await page.evaluate(() => window.__RR_API.read());
  await page.mouse.down();
  await page.waitForTimeout(70);
  const press = await page.evaluate(() => window.__RR_API.read());
  if (!press || press.held !== true) {
    const hit = await page.evaluate((pt) => window.__RR_API.hit(pt), at);
    await page.mouse.up().catch(() => {});
    return { spec, at, before, prePress, press, hit, measured: false, why: `the press did not engage the corner gesture (the point is ${hit.at})` };
  }

  // `grab` is the layout px of the grip the hand landed inside, which the press froze. A height `want` is asked for by
  // the pointer at `(want + top - grab) * z` (visual px) - the gesture's own arithmetic, read back from the page.
  const grab = +(press.top + press.h - at.y / press.z).toFixed(3);
  const targets = targetsFor(spec, press);
  const steps = [];
  let lastY = at.y;
  let fromH = press.h;
  if (targets.length) {
    for (const want of targets) {
      for (let i = 1; i <= STEPS; i += 1) {
        const h = fromH + ((want - fromH) * i) / STEPS;
        lastY = +((h + press.top - grab) * press.z).toFixed(1);
        await page.mouse.move(at.x, lastY);
        await page.waitForTimeout(STEP_MS);
        const r = await page.evaluate(() => window.__RR_API.read());
        if (r) steps.push({ pointerY: lastY, h: r.h, top: r.top, want: r.want, varPx: r.varPx });
      }
      fromH = want;
    }
    await page.waitForTimeout(60);
  } else {
    await page.waitForTimeout(HOLD_MS);
  }
  const last = await page.evaluate(() => window.__RR_API.read());
  const finalTarget = targets.length ? targets[targets.length - 1] : null;

  // The release. The frame read is the number this tool is about; the same-task read is kept as context.
  await page.mouse.up();
  await page.waitForFunction(() => window.__RR && window.__RR.frameH != null, null, { timeout: FRAME_WAIT_MS }).catch(() => {});
  const probe = await page.evaluate(() => window.__RR_API.probe());
  await page.waitForTimeout(120);
  const after = await page.evaluate(() => window.__RR_API.read());
  const measured = probe.frameH != null;
  // The corner at the last move, in layout px: the grip's own bottom edge against (pointer + the pixels of the grip the
  // hand landed inside). Both sides are visual numbers divided by the press's scale.
  const cornerPx = last ? +(last.gripBottom / last.z - (lastY / last.z + grab)).toFixed(2) : null;
  const numbers = measured
    ? {
        id: spec.id,
        zoom: spec.zoom,
        expect: spec.expect,
        pressPx: press.h,
        askedPx: last && last.want != null ? last.want : null,
        lastMovePx: last.h,
        releasePx: probe.frameH,
        releaseSyncPx: probe.syncH,
        deltaPx: +(probe.frameH - last.h).toFixed(2),
        roomPx: last.room,
        wantPx: finalTarget,
        shortfallPx: finalTarget == null ? null : +(last.h - finalTarget).toFixed(2),
        cornerPx,
        topMovedPx: last && probe.frameTop != null ? +(probe.frameTop - last.top).toFixed(2) : null,
        pointerBelowViewportPx: +(lastY - press.innerH).toFixed(1),
        afterVarPx: after ? after.varPx : null,
        storedPx: after ? after.stored : null,
        steps: steps.length,
      }
    : null;
  return {
    spec,
    measured,
    why: measured ? "" : "the release's one-frame read never landed",
    at,
    grab,
    before,
    prePress,
    press,
    targets,
    endY: lastY,
    steps,
    last,
    probe,
    after,
    numbers,
  };
}

// What a case promises. `delta` and the top edge are the release contract; the rest keeps the case honest, so a drag
// that never reached the limit - or a box that was never free to follow - cannot read as a pass.
function verdictOf(run) {
  const { spec } = run;
  const fails = [];
  const n = run.numbers;
  if (!run.measured || !n) return { fail: [`not measured: ${run.why}`], numbers: n };
  // The hand's request: the page's own record when the build has one (`outGripDrag.want`, added with the limit), and the
  // height this case moved the pointer to otherwise. A build without the record must still fail on the delta, not on a
  // field it never had.
  const asked = n.askedPx == null ? n.wantPx : n.askedPx;
  if (!(Math.abs(n.deltaPx) <= RELEASE_TOLERANCE_PX)) {
    fails.push(`the release moved the box ${n.deltaPx}px (last move ${n.lastMovePx}px -> ${n.releasePx}px): the corner jumps on pointerup`);
  }
  if (n.topMovedPx == null || Math.abs(n.topMovedPx) > RELEASE_TOLERANCE_PX) {
    fails.push(`the release moved the box's top edge ${n.topMovedPx}px`);
  }
  if (spec.expect === "hold") {
    if (Math.abs(n.lastMovePx - n.pressPx) > RELEASE_TOLERANCE_PX) {
      fails.push(`a press that moved nothing changed the box ${+(n.lastMovePx - n.pressPx).toFixed(2)}px while the hand was down`);
    }
  } else if (spec.expect === "limit") {
    if (asked == null || asked < n.roomPx + LIMIT_MARGIN_PX) {
      fails.push(`the case did not carry the hand past the room: it asked ${asked}px against a ${n.roomPx}px room`);
    }
    if (Math.abs(n.lastMovePx - n.roomPx) > LIMIT_TOLERANCE_PX) {
      fails.push(`the box drew ${n.lastMovePx}px where the room is ${n.roomPx}px: the move did not stop on the limit`);
    }
    if (!(n.pointerBelowViewportPx > 0)) {
      fails.push(`the pointer never passed the viewport's bottom edge (${n.pointerBelowViewportPx}px): the drag did not overrun the room`);
    }
  } else {
    if (n.shortfallPx == null || Math.abs(n.shortfallPx) > FOLLOW_TOLERANCE_PX) {
      fails.push(`the box drew ${n.lastMovePx}px against the hand's ${n.wantPx}px: it did not follow inside the room`);
    }
    if (n.cornerPx == null || Math.abs(n.cornerPx) > FOLLOW_TOLERANCE_PX) {
      fails.push(`the corner stood ${n.cornerPx}px from the hand at the last move`);
    }
  }
  if (spec.drag !== "none") {
    if (n.askedPx != null && Math.abs(n.askedPx - n.wantPx) > WANT_TOLERANCE_PX) {
      fails.push(`the page recorded the hand asking for ${n.askedPx}px where the case moved the pointer to ${n.wantPx}px`);
    }
    if (n.storedPx == null) fails.push("nothing was stored for the height the drag reached");
    else if (Math.abs(n.storedPx - n.releasePx) > STORE_TOLERANCE_PX) {
      fails.push(`stored ${n.storedPx}px against the ${n.releasePx}px the box draws`);
    }
    if (n.afterVarPx == null) fails.push("--out-h was left unset after the drag");
    else if (Math.abs(n.afterVarPx - n.releasePx) > STORE_TOLERANCE_PX) {
      fails.push(`--out-h ${n.afterVarPx}px against the ${n.releasePx}px the box draws`);
    }
  }
  return { fail: fails, numbers: n };
}

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const signed = (n) => (n == null || !Number.isFinite(Number(n)) ? "?" : `${Number(n) > 0 ? "+" : ""}${Number(n).toFixed(0)}`);
const COLUMNS = `case                 zoom  asked  last-move  release+1  delta   room  shape   verdict`;
const rowOf = (n, ok) =>
  `${pad(n.id, 20)}${rpad(`${n.zoom}%`, 5)}${rpad(n.askedPx == null ? "-" : n.askedPx.toFixed(0), 7)}${rpad(n.lastMovePx.toFixed(0), 11)}${rpad(n.releasePx.toFixed(0), 11)}${rpad(signed(n.deltaPx), 7)}${rpad(n.roomPx.toFixed(0), 7)}  ${pad(n.expect, 8)}${ok ? "PASS" : "FAIL"}`;

async function main() {
  const pw = loadPlaywright();
  if (!pw) return notRun("the console release contract", "no Playwright install (set PANEL_PLAYWRIGHT_ROOT)");

  const panel = await startPanel({ config: { assistant: { enabled: false }, fetchSeconds: -1 } });
  const rows = [];
  const results = [];
  const ledger = { checkedAt: new Date().toISOString(), viewport: { width: WIDTH, height: HEIGHT }, panel: panel.base, version: "", cases: [], pageErrors: [], consoleErrors: [] };
  let browser = null;
  try {
    browser = await pw.chromium.launch({ headless: !HEADED });
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
    const page = await context.newPage();
    page.on("pageerror", (e) => ledger.pageErrors.push(String((e && e.message) || e).slice(0, 200)));
    page.on("console", (m) => {
      if (m.type && m.type() === "error" && !/favicon/i.test(m.text())) ledger.consoleErrors.push(m.text().slice(0, 200));
    });
    try {
      await page.goto(panel.base + "/", { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForFunction(() => typeof setOutHeight === "function" && typeof state !== "undefined", null, { timeout: 30_000 });
      await page.evaluate(PAGE_HELPERS, {
        host: "resize-release-probe-host",
        out: OUT,
        top: TOP,
        left: LEFT,
        width: BOX_W,
        startH: START_H,
        inset: GRIP_INSET_PX,
        room: ROOM_PX,
      });
      await page.evaluate(() => window.__RR_API.install());
      ledger.version = await page.evaluate(() => window.__RR_API.version());

      console.log(`\nVERIFY console release contract - panel ${panel.base} v${ledger.version || "?"}, ${WIDTH}x${HEIGHT}, headless Chromium`);
      console.log("The release must keep the height the drag draws: delta 0 for every accepted drag, at every zoom.\n");
      console.log(COLUMNS);

      for (const spec of CASES) {
        let run = null;
        try {
          run = await runCase(page, spec);
        } catch (err) {
          run = { spec, measured: false, why: String((err && err.message) || err).slice(0, 240), numbers: null };
        }
        const verdict = verdictOf(run);
        ledger.cases.push({ ...run, verdict: verdict.fail });
        if (run.numbers) {
          rows.push(run.numbers);
          console.log(rowOf(run.numbers, verdict.fail.length === 0));
          for (const f of verdict.fail) console.log(`  ${spec.id}: ${f}`);
        } else {
          console.log(`${pad(spec.id, 20)}${rpad(`${spec.zoom}%`, 5)}   NOT MEASURED - ${run.why}`);
        }
        results.push({ id: spec.id, ok: verdict.fail.length === 0, fail: verdict.fail });
        await page.waitForTimeout(150);
      }
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!KEEP) await panel.stop();
    else console.log(`\nkept: ${panel.dir}`);
  }

  console.log("\nAll columns are LAYOUT px. asked = the hand's request at the last move, before the band; last-move = the");
  console.log("box's height after the final pointermove; release+1 = one animation frame after pointerup; delta = release+1");
  console.log("minus last-move (0 is the contract); room = max(sheet cap, viewport under the frozen top - 8).");

  for (const n of rows) {
    console.log(
      `  ${pad(n.id, 20)}${rpad(`${n.zoom}%`, 5)}  ${rpad(n.lastMovePx.toFixed(0), 5)}px -> ${rpad(n.releasePx.toFixed(0), 5)}px  ${
        Math.abs(n.deltaPx) <= RELEASE_TOLERANCE_PX ? "no revert (delta 0)" : `the release gave back ${Math.abs(n.deltaPx).toFixed(0)}px`
      }`,
    );
  }
  if (ledger.pageErrors.length) console.log(`PAGEERRORS ${ledger.pageErrors.length}: ${ledger.pageErrors.slice(0, 3).join(" | ")}`);

  const failures = results.filter((r) => !r.ok);
  const measuredCount = rows.length;
  if (JSON_OUT) {
    mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
    writeFileSync(path.resolve(JSON_OUT), JSON.stringify(ledger, null, 1), "utf8");
    console.log(`ledger: ${path.resolve(JSON_OUT)}`);
  }
  console.log(
    failures.length
      ? `\nRESULT: FAIL ${failures.length}/${CASES.length} cases: ${failures.map((f) => f.id).join(", ")}`
      : `\nRESULT: PASS ${measuredCount}/${CASES.length} cases, delta 0 at every zoom, press-only and upward unchanged`,
  );
  process.exit(failures.length ? 1 : measuredCount === CASES.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
