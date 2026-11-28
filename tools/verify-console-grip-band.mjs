#!/usr/bin/env node
// GATE: the console corner's BAND - the floor and the room, at three zooms and two window heights, from the one
// module the page runs (public/core/console-grip.js).
//
//   node tools/verify-console-grip-band.mjs
//   node tools/verify-console-grip-band.mjs --json <path>
//   node tools/verify-console-grip-band.mjs --headed
//
// WHAT IT GUARDS. The corner's room was `innerHeight - top / zoom - 8` in public/app.js: the viewport's height was a
// VISUAL length and the top edge a LAYOUT one, so on a page at 90% the box stopped a tenth of the viewport short of the
// edge and at 110% it drew past the bottom (measured on the live float: 97.5px short at 900 tall / 90%, 81.3px past at
// 110%; 83.1 short and 67.0 past at 760). It also ignored the pane, so a console inside a scrollport grew behind the
// reply box and past the pane's own bottom (measured: 17.5px past it at 100%). This gate drives the same gesture on a
// synthetic console inside a real `.job-body` scrollport, with the pane edge and the viewport edge at known positions,
// and asserts that the stop is the NEARER of them, named on the drag record, at 100, 90 and 110, in a 900 and a
// 760 window.
//
// THE SHAPES. `pane`: a 460px-tall pane whose bottom is 300px above the viewport's, so the pane is the edge. `viewport`:
// a pane whose bottom is 200px BELOW the viewport's, so the viewport is the edge and the pane would allow more. Both
// are built into the real page - the real sheet, the real delegated pointerdown, the real release - so the console
// under the hand is the console a reader drags.
//
// WHAT IT ASSERTS, per shape:
//
//   press        the gesture engaged, and `wtConsoleGripDrag` exists
//   the edge     the band's `edge` is the shape's expected one
//   monotone     the height rises (down) or falls (up) with every step while the hand is inside the band
//   the stop     the height lands on the band's room (down) or the floor (up), within 1px
//   the edge px  the box's bottom is the named edge minus the 8px gap, within 1.5px
//   the corner   the grip's bottom is on the pointer while the box is free, within 1px
//   the top      the frozen top edge moved 1px or less
//   the store    state.outHeights holds the drawn height
//
// The up drag is a SHRINK: the grip is on the box's bottom edge and stays under the hand, so dragging up makes the box
// shorter and the floor is its only stop. The expanding drag is the downward one, and its stop is the pane or the
// viewport edge. Both are asserted, so "the stop is only ever the pane or viewport edge" is a statement about the
// growing drag and "the floor is the floor" about the shrinking one.
//
// EXIT: 0 every shape passed; 1 a shape failed or could not be measured; 2 the panel or browser half did not run.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPlaywright, notRun } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const JSON_OUT = opt("json", null);
const HEADED = flag("headed");

const ZOOMS = [100, 90, 110];
const HEIGHTS = [900, 760];
const GAP_PX = 8;
const START_H = 200;
const STEP_PX = 20;
const MAX_STEPS = 45;
const TOL = 1.5;

const results = [];
function check(ok, label, detail) {
  results.push({ ok: Boolean(ok), label, detail: detail == null ? "" : String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
}
const round = (n) => (Number.isFinite(n) ? +n.toFixed(2) : null);

// The page half. One synthetic console in a real scrollport; every read is taken at call time because a case rebuilds
// the node.
const PAGE_HELPERS = (cfg) => {
  const HOST = "band-probe-host";
  const OUT = "band-probe";
  const host = () => document.getElementById(HOST);
  const body = () => host()?.querySelector(":scope > .job-body") || null;
  const out = () => body()?.querySelector(`pre.job-out[data-out="${OUT}"]`) || null;
  const grip = () => out()?.parentElement.querySelector(":scope > .out-grip") || null;
  const zoomOf = () => {
    const v = parseFloat(getComputedStyle(document.documentElement).zoom);
    return Number.isFinite(v) && v > 0 ? v : 1;
  };
  const r2 = (n) => (Number.isFinite(n) ? +n.toFixed(2) : null);
  const dragNow = () => (window.wtConsoleGripDrag ? window.wtConsoleGripDrag : typeof outGripDrag !== "undefined" ? outGripDrag : null);

  window.__GB = {
    build: (shape) => {
      document.getElementById(HOST)?.remove();
      const vh = window.innerHeight;
      const top = 100;
      // `pane`: the scrollport's bottom is ABOVE the viewport's. `viewport`: it is BELOW it.
      const h = shape === "pane" ? 460 : Math.max(460, vh - top + 200);
      const el = document.createElement("div");
      el.id = HOST;
      el.className = "job maximized";
      el.style.cssText = `position:fixed;left:40px;top:${top}px;width:700px;height:${h}px;z-index:99999;overflow:visible;background:#0d1117;`;
      el.innerHTML =
        `<div class="job-body" style="height:${h}px;overflow:auto;display:flex;flex-direction:column;">` +
        `<div class="turn"><div class="out-wrap out-tab"><div class="out-box">` +
        `<pre class="job-out" data-out="${OUT}">${Array.from({ length: 40 }, (_, i) => `band probe line ${i + 1}: the console is a real box in a real scrollport`).join("\n")}</pre>` +
        `<span class="out-grip" data-out-grip="1"></span>` +
        `</div></div></div></div>`;
      document.body.appendChild(el);
      if (typeof setOutHeight === "function") setOutHeight(out(), cfg.start);
      if (typeof rememberOutHeight === "function") rememberOutHeight(OUT, cfg.start);
      return window.__GB.read();
    },
    read: () => {
      const o = out();
      const g = grip();
      const b = body();
      if (!o || !g || !b) return null;
      const r = o.getBoundingClientRect();
      const gr = g.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const z = zoomOf();
      const d = dragNow();
      const stored = (() => {
        try {
          const n = Number(state.outHeights && state.outHeights[OUT]);
          return Number.isFinite(n) && n > 0 ? n : null;
        } catch {
          return null;
        }
      })();
      return {
        z,
        vh: window.innerHeight,
        vw: window.innerWidth,
        h: r2(r.height),
        top: r2(r.top),
        bottom: r2(r.bottom),
        gripBottom: r2(gr.bottom),
        gripRight: r2(gr.right),
        paneTop: r2(br.top),
        paneBottom: r2(br.bottom),
        varH: o.style.getPropertyValue("--out-h"),
        varPx: (() => { const n = parseFloat(o.style.getPropertyValue("--out-h")); return Number.isFinite(n) ? n : null; })(),
        stored,
        held: typeof outDragging === "function" ? outDragging(o) : null,
        drag: d
          ? {
              top: r2(d.top), grab: r2(d.grab), z: d.z, min: r2(d.min), room: r2(d.room), edge: d.edge || null,
              paneRoom: r2(d.paneRoom), viewRoom: r2(d.viewRoom), h: r2(d.h), want: d.want == null ? null : r2(d.want),
              moved: Boolean(d.moved),
            }
          : null,
      };
    },
    at: () => {
      const g = grip();
      if (!g) return null;
      const r = g.getBoundingClientRect();
      return { x: r2(r.right - 9), y: r2(r.bottom - 9) };
    },
    hit: (pt) => {
      const el = pt ? document.elementFromPoint(pt.x, pt.y) : null;
      const g = grip();
      return { onGrip: Boolean(g && el && (el === g || g.contains(el))), at: el ? el.tagName + "." + (el.className || "") : "none" };
    },
    remove: () => document.getElementById(HOST)?.remove(),
    zoom: (pct) => {
      document.documentElement.style.zoom = pct === 100 ? "" : String(pct / 100);
      try { localStorage.setItem("wtgui.zoom", String(pct)); } catch { /* private mode */ }
      if (typeof state !== "undefined") state.zoom = pct;
      return zoomOf();
    },
  };
  return true;
};

async function shapeCase(page, spec) {
  await page.evaluate((z) => window.__GB.zoom(z), spec.zoom);
  await page.waitForTimeout(120);
  const built = await page.evaluate((s) => window.__GB.build(s), spec.shape);
  if (!built) throw new Error("the synthetic console did not build");
  await page.waitForTimeout(120);
  const before = await page.evaluate(() => window.__GB.read());
  const at = await page.evaluate(() => window.__GB.at());
  let engaged = null;
  for (let attempt = 0; attempt < 4 && !engaged; attempt += 1) {
    const a = await page.evaluate(() => window.__GB.at());
    await page.mouse.move(a.x, a.y);
    await page.waitForTimeout(40);
    await page.mouse.down();
    await page.waitForTimeout(70);
    engaged = await page.evaluate(() => window.__GB.read());
    if (!(engaged && engaged.drag && engaged.held)) {
      const hit = await page.evaluate((pt) => window.__GB.hit(pt), a);
      console.log(`RETRY the press missed the band at ${JSON.stringify(a)} (${JSON.stringify(hit)})`);
      await page.mouse.up();
      await page.waitForTimeout(120);
      engaged = null;
    }
  }
  const rows = [];
  const sign = spec.dir === "up" ? -1 : 1;
  let stall = 0;
  for (let i = 1; i <= MAX_STEPS; i += 1) {
    const y = at.y + sign * i * STEP_PX;
    await page.mouse.move(at.x, y);
    await page.waitForTimeout(35);
    const r = await page.evaluate(() => window.__GB.read());
    if (!r) break;
    rows.push({ ...r, pointerY: round(y) });
    // The stop: two consecutive steps at the same height while the hand keeps travelling in the same direction.
    if (rows.length >= 2 && Math.abs(rows[rows.length - 1].h - rows[rows.length - 2].h) < 0.5) stall += 1;
    else stall = 0;
    if (stall >= 3) break;
  }
  await page.mouse.up();
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => window.__GB.read());
  await page.evaluate(() => window.__GB.remove());
  return { spec, at, before, engaged, rows, after };
}

function verdict(run) {
  const { spec, before, engaged, rows, after } = run;
  const fails = [];
  const n = {};
  if (!before || !engaged || !after) return { fails: ["the case was not read"], numbers: n };
  if (!engaged.drag || engaged.held !== true) fails.push("the press did not engage the grip");
  const first = engaged.drag;
  const last = rows[rows.length - 1];
  if (!first || !last) return { fails: ["no move was measured"], numbers: n };
  n.zoom = spec.zoom;
  n.window = spec.vh;
  n.shape = spec.shape;
  n.edge = first.edge;
  n.room = first.room;
  n.floor = first.min;
  // The rect is VISUAL and the band's room/floor are LAYOUT px: divide the drawn height by the page's own zoom before
  // comparing, or a 90% page's 385.19px box reads as a miss on a 427.78px room that is exactly what it drew.
  const layoutH = (r) => (r && Number(r.z) > 0 ? r.h / r.z : r ? r.h : null);
  n.startPx = before.h;
  n.startLayout = round(layoutH(before));
  n.endPx = after.h;
  n.endLayout = round(layoutH(after));
  n.finalBottom = last.bottom;
  n.paneBottom = before.paneBottom;
  n.viewport = before.vh;
  n.topBefore = before.top;
  n.topEnd = last.top;
  n.steps = rows.length;

  const edgePx = spec.shape === "pane" ? before.paneBottom : before.vh;
  n.edgePx = round(edgePx);
  n.gapPx = round(edgePx - last.bottom);
  if (first.edge !== spec.shape) fails.push(`the band named ${first.edge}, the shape's nearer edge is ${spec.shape}`);

  // Monotone and the corner, while the box is free. A step is free when its own request is inside the band.
  let prevH = before.h;
  let worstCorner = 0;
  let retro = 0;
  const grab = first.gripBottom - run.at.y;
  for (const r of rows) {
    const d = r.drag;
    if (!d) continue;
    const free = d.want != null && d.want >= first.min - 0.5 && d.want <= first.room + TOL;
    if (free) {
      worstCorner = Math.max(worstCorner, Math.abs(r.gripBottom - (r.pointerY + grab)));
      if (spec.dir === "down" && r.h < prevH - 1) retro += 1;
      if (spec.dir === "up" && r.h > prevH + 1) retro += 1;
    }
    prevH = r.h;
  }
  n.worstCorner = round(worstCorner);
  n.retro = retro;
  if (retro > 0) fails.push(`${retro} step(s) moved the box against the hand`);
  if (worstCorner > TOL) fails.push(`the corner left the pointer by ${n.worstCorner}px while the box was free`);

  if (spec.dir === "down") {
    // The stop is the room, and the bottom is on the named edge minus the gap.
    if (Math.abs(layoutH(after) - first.room) > 1) fails.push(`the stop ${n.endLayout}px is not the band's room ${first.room}px`);
    if (Math.abs(n.gapPx - GAP_PX * before.z) > TOL) fails.push(`the bottom stopped ${n.gapPx}px above ${spec.shape} (wanted ${round(GAP_PX * before.z)}px)`);
    const tail = rows.slice(-3).map((r) => r.h);
    if (Math.max(...tail) - Math.min(...tail) > 0.5) fails.push(`the last three steps were still moving (${tail.join("/")}px): the stop was not held`);
    if (Math.abs(after.stored - layoutH(after)) > 1) fails.push(`the store ${after.stored}px is not the drawn ${n.endLayout}px`);
  } else {
    // The up drag is a shrink: the floor is its only stop.
    if (Math.abs(layoutH(after) - first.min) > 1) fails.push(`the shrink stopped at ${n.endLayout}px, not the floor ${first.min}px`);
    if (Math.abs(after.stored - layoutH(after)) > 1) fails.push(`the store ${after.stored}px is not the drawn ${n.endLayout}px`);
  }
  if (Math.abs(last.top - before.top) > 1.5) fails.push(`the frozen top edge moved ${round(last.top - before.top)}px`);
  return { fails, numbers: n };
}

async function main() {
  const pw = loadPlaywright();
  if (!pw) return notRun("the console grip band", "no Playwright install (set PANEL_PLAYWRIGHT_ROOT)");
  let panel = null;
  let browser = null;
  try {
    panel = await startPanel();
    browser = await pw.chromium.launch({ headless: !HEADED });
    const numbers = {};
    for (const vh of HEIGHTS) {
      const context = await browser.newContext({ viewport: { width: 1400, height: vh } });
      const page = await context.newPage();
      const errs = [];
      page.on("pageerror", (e) => errs.push(String((e && e.message) || e).slice(0, 200)));
      await page.goto(`${panel.base}/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForFunction(() => typeof wtConsoleGrip === "object" && typeof outDragging === "function", null, { timeout: 30_000 });
      await page.evaluate(PAGE_HELPERS, { start: START_H });
      const hasModule = await page.evaluate(() => Boolean(window.wtConsoleGrip && window.wtConsoleGrip.band));
      check(hasModule, `the page serves public/core/console-grip.js at ${vh}px`, hasModule ? "wtConsoleGrip.band is present" : "missing");
      for (const shape of ["pane", "viewport"]) {
        for (const zoom of ZOOMS) {
          for (const dir of ["down", "up"]) {
            const key = `${shape}@${vh}/${zoom}/${dir}`;
            try {
              const run = await shapeCase(page, { shape, vh, zoom, dir });
              const v = verdict(run);
              numbers[key] = { ...v.numbers, fails: v.fails, ok: v.fails.length === 0 };
              const label = `${shape} ${vh}px ${zoom}% ${dir === "down" ? "grow" : "shrink"}`;
              const detail =
                dir === "down"
                  ? `stop ${v.numbers.endLayout} layout / ${v.numbers.endPx} visual on ${v.numbers.edge} (bottom ${v.numbers.finalBottom}, edge ${v.numbers.edgePx}, gap ${v.numbers.gapPx})`
                  : `stop ${v.numbers.endLayout} layout / ${v.numbers.endPx} visual on the floor ${v.numbers.floor} (the ${v.numbers.edge} is the band's edge, not the shrink's stop; top ${v.numbers.topEnd})`;
              check(v.fails.length === 0, label, v.fails.length ? v.fails.join("; ") : detail);
            } catch (err) {
              numbers[key] = { fails: [String((err && err.message) || err)] };
              check(false, `${shape} ${vh}px ${zoom}% ${dir}`, String((err && err.message) || err));
            }
          }
        }
      }
      if (errs.length) check(false, `no page errors at ${vh}px`, errs.slice(0, 3).join(" | "));
      await context.close();
    }
    if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ numbers }, null, 1));
  } finally {
    await browser?.close().catch(() => {});
    await panel?.stop?.().catch(() => {});
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nRESULT: ${failed ? "FAIL" : "PASS"} (${results.length} checks, ${failed} failed)`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error("BROWSER-HALF-NOT-RUN", e && e.stack ? e.stack : e);
  process.exit(2);
});
