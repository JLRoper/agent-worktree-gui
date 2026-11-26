#!/usr/bin/env node
// MEASURE: the console corner's RELEASE BOUNCE - how many pixels the box gives back between the last pointermove of a
// drag and the first frame after the pointer comes up, on a synthetic console, at three page zooms.
//
//   node tools/measure-console-resize-release.mjs
//   node tools/measure-console-resize-release.mjs --viewport 1400x900
//   node tools/measure-console-resize-release.mjs --json <path>
//   node tools/measure-console-resize-release.mjs --headed
//   node tools/measure-console-resize-release.mjs --keep
//
// IT ASSERTS NOTHING, AND THAT IS THE POINT. This is a measurement, not a gate: it prints numbers and exits 0 whether
// or not the release bounces. A green run says the tool measured - NOT that the defect is absent - so it may land
// while the defect exists. The gesture's own gate is tools/verify-console-corner-drag.mjs, and this tool exists so
// that the number that gate reads as a failure is also on the record as a number.
//
// WHAT IT MEASURES. The corner gesture follows the pointer for the whole drag (public/app.js's pointermove ->
// outGripStep -> setOutHeight) and applies its clamps ONCE, on release (endOutGrip): the height the drag reached is
// held to the sheet's floor and to the ROOM the box has under its top edge in the viewport,
//
//   room = max(sheet cap, round(innerHeight - top - OUT_GRIP_ROOM))
//
// in layout px, with OUT_GRIP_ROOM 8. A drag whose last move asks for MORE than that room is therefore a box that
// shrinks back at the release, and the corner the hand is on jumps up by exactly the overshoot. Four numbers are
// printed per case, all in LAYOUT px - the unit `--out-h`, the sheet's min/max-height and the room are written in; a
// rect and a pointer are VISUAL, and are divided by the page zoom before they are reported:
//
//   dragged     the hand's travel in the box's own unit: the last-move height minus the height the press froze
//   last-move   the box's height after the FINAL pointermove
//   release+1   the box's height one animation frame after pointerup
//   delta       release+1 minus last-move. Negative is the box giving pixels back; `revert` prints the same fact
//               with the sign a reader means (positive = the corner jumped UP by that many px at the release)
//
// plus the room and the overshoot (last-move minus room) the case was built to produce, so a case that failed to carry
// the corner past the room says so instead of reading as a clean zero.
//
// THE CASES. inside-room: a drag well inside the room, expected delta 0. past-room-120: the last move asks for the room
// plus 120 px, so the corner is carried past it - the reader's bounce, expected to reproduce as a revert. The same
// past-room drag at page zoom 90 and at 110. press-only: a press that never moves. upward: a shrink. The zoom is the
// page's own (Settings > Display, `applyZoom` in public/settings.js), a layout scale on documentElement, so a pointer
// length and a CSS length stop being the same number away from 100.
//
// WHY A SYNTHETIC CONSOLE. The bounce is a property of the gesture and the box's geometry, not of the transcript, so
// the console is BUILT into the real page - the real sheet, the real delegated pointerdown, the real release - rather
// than seeding a board, a transcript and a stub gateway to drag a live card: `.out-wrap > .out-box > pre.job-out` plus
// `.out-grip`, placed fixed in the viewport where its room is known, given a 200 px height through the page's ONE
// writer (setOutHeight). The pointer is real CDP input, the same trusted press and moves a reader makes, including
// moves BELOW the viewport's bottom edge (a hand that travels past the screen is how the room is overrun on a page
// whose zoom lets it be). What this shape therefore does NOT cover is a console inside a scrollport whose top edge a
// pin or a rebuild moves mid-drag: that is tools/verify-console-corner-drag.mjs's matrix.
//
// The panel is a throwaway one (tools/panel-testkit.mjs: spare port, own PANEL_CONFIG / HERMES_HOME / stores,
// assistant off, fetch off), so no board, no gateway key and no reader's tab are involved.
//
// EXIT CODE: 0 when every case was measured (the numbers are not a verdict), 1 when a case could not be measured (a
// press that missed the grip, a console that did not draw, a release whose frame read never landed), 2 when the panel
// or the browser half did not run.
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
const UP_PX = 80; // how far the upward drag shrinks the box
const STEPS = 5; // pointer moves per drag
const STEP_MS = 45;
const HOLD_MS = 350; // the press-only case's hold, so it is a press and not a click
const GRIP_INSET_PX = 3; // a hand lands a few px inside the 18 px band
const ROOM_PX = 8; // OUT_GRIP_ROOM, public/app.js
const SETTLE_MS = 400; // after a zoom change and a rebuild
const FRAME_WAIT_MS = 3000;

// The shape each case drives. `drag` is what the pointer does; `zoom` is the page's own zoom in percent.
const CASES = [
  { id: "inside-room", zoom: 100, drag: "inside", note: "a drag well inside the room under the corner" },
  { id: "past-room-120", zoom: 100, drag: "past", note: "the corner carried past the room by about 120 px" },
  { id: "past-room-120@90", zoom: 90, drag: "past", note: "the same drag on a page at 90%" },
  { id: "past-room-120@110", zoom: 110, drag: "past", note: "the same drag on a page at 110%" },
  { id: "press-only", zoom: 100, drag: "none", note: "a press that never moves" },
  { id: "upward", zoom: 100, drag: "up", note: "a drag upward, a shrink" },
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
      inJobBody: Boolean(o.closest(".job-body")),
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
          if (window.__RR.ys.length > 40) window.__RR.ys.shift();
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

  // Where the last move must land. The gesture's own arithmetic, read back from the page: the height a pointer y asks
  // for is `y / zoom + grab - top`, so the y that asks for `want` is `(want + top - grab) * zoom`. `grab` is the layout
  // px of the grip the hand landed inside, which the press froze.
  const grab = +(press.top + press.h - at.y / press.z).toFixed(3);
  const want = spec.drag === "past" ? +(press.room + PAST_PX).toFixed(2) : spec.drag === "up" ? +(press.h - UP_PX).toFixed(2) : +(press.h + INSIDE_PX).toFixed(2);
  const endY = spec.drag === "none" ? at.y : +((want + press.top - grab) * press.z).toFixed(1);

  const steps = [];
  if (spec.drag !== "none") {
    for (let i = 1; i <= STEPS; i += 1) {
      const y = at.y + ((endY - at.y) * i) / STEPS;
      await page.mouse.move(at.x, y);
      await page.waitForTimeout(STEP_MS);
      const r = await page.evaluate(() => window.__RR_API.read());
      if (r) steps.push({ pointerY: +y.toFixed(1), h: r.h, top: r.top, varPx: r.varPx });
    }
    await page.waitForTimeout(60);
  } else {
    await page.waitForTimeout(HOLD_MS);
  }
  const last = await page.evaluate(() => window.__RR_API.read());

  // The release. The frame read is the number this tool is about; the same-task read is kept as context.
  await page.mouse.up();
  await page.waitForFunction(() => window.__RR && window.__RR.frameH != null, null, { timeout: FRAME_WAIT_MS }).catch(() => {});
  const probe = await page.evaluate(() => window.__RR_API.probe());
  await page.waitForTimeout(120);
  const after = await page.evaluate(() => window.__RR_API.read());
  const measured = probe.frameH != null;
  return {
    spec,
    measured,
    why: measured ? "" : "the release's one-frame read never landed",
    at,
    grab,
    before,
    prePress,
    press,
    want,
    endY,
    steps,
    last,
    probe,
    after,
    numbers: measured
      ? {
          id: spec.id,
          zoom: spec.zoom,
          draggedPx: +(last.h - press.h).toFixed(2),
          lastMovePx: last.h,
          releasePx: probe.frameH,
          releaseSyncPx: probe.syncH,
          deltaPx: +(probe.frameH - last.h).toFixed(2),
          revertPx: +(last.h - probe.frameH).toFixed(2),
          pressPx: press.h,
          roomPx: last.room,
          overshootPx: +(last.h - last.room).toFixed(2),
          shortfallPx: +(last.h - want).toFixed(2),
          pointerTravelPx: +(endY - at.y).toFixed(1),
          pointerBelowViewportPx: +(endY - press.innerH).toFixed(1),
          pointerDelivered: probe.ys.length ? probe.ys[probe.ys.length - 1] : null,
          afterVarPx: after ? after.varPx : null,
          storedPx: after ? after.stored : null,
          steps: steps.length,
        }
      : null,
  };
}

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const signed = (n) => (n == null || !Number.isFinite(Number(n)) ? "?" : `${Number(n) > 0 ? "+" : ""}${Number(n).toFixed(0)}`);
const COLUMNS = `case               zoom dragged  last-move  release+1  delta  revert   room  overshoot`;
const rowOf = (n) =>
  `${pad(n.id, 18)}${rpad(`${n.zoom}%`, 5)}${rpad(n.draggedPx.toFixed(0), 9)}${rpad(n.lastMovePx.toFixed(0), 11)}${rpad(n.releasePx.toFixed(0), 11)}${rpad(signed(n.deltaPx), 7)}${rpad(signed(n.revertPx), 8)}${rpad(n.roomPx.toFixed(0), 7)}${rpad(signed(n.overshootPx), 11)}`;

async function main() {
  const pw = loadPlaywright();
  if (!pw) return notRun("the console release bounce measurement", "no Playwright install (set PANEL_PLAYWRIGHT_ROOT)");

  const panel = await startPanel({ config: { assistant: { enabled: false }, fetchSeconds: -1 } });
  const rows = [];
  const ledger = { measuredAt: new Date().toISOString(), viewport: { width: WIDTH, height: HEIGHT }, panel: panel.base, version: "", cases: [], pageErrors: [], consoleErrors: [] };
  let measuredCount = 0;
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

      console.log(`\nMEASURE console release bounce - panel ${panel.base} v${ledger.version || "?"}, ${WIDTH}x${HEIGHT}, headless Chromium`);
      console.log("A MEASUREMENT, NOT A GATE: nothing below is an assertion, and a green run does not mean the bounce is gone.\n");
      console.log(COLUMNS);

      for (const spec of CASES) {
        let run = null;
        try {
          run = await runCase(page, spec);
        } catch (err) {
          run = { spec, measured: false, why: String((err && err.message) || err).slice(0, 240) };
        }
        ledger.cases.push(run);
        if (run.measured) {
          measuredCount += 1;
          const n = run.numbers;
          rows.push(n);
          console.log(rowOf(n));
          if (spec.drag !== "none" && (Math.abs(n.shortfallPx) > 2 || n.pointerBelowViewportPx > 0)) {
            console.log(
              `  pointer ${n.pointerTravelPx}px of travel, ended ${n.pointerBelowViewportPx > 0 ? `${n.pointerBelowViewportPx}px BELOW the viewport bottom` : "inside the viewport"};` +
                ` last move asked ${run.want}px and drew ${n.lastMovePx.toFixed(0)}px${Math.abs(n.shortfallPx) > 2 ? ` (${n.shortfallPx.toFixed(0)}px short of the planned height)` : ""};` +
                ` --out-h ${n.afterVarPx == null ? "unset" : `${n.afterVarPx}px`} after the release; stored ${n.storedPx == null ? "unset" : `${n.storedPx}px`}`,
            );
          }
        } else {
          console.log(`${pad(spec.id, 18)}${rpad(`${spec.zoom}%`, 5)}   NOT MEASURED - ${run.why}`);
        }
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

  console.log("\nAll columns are LAYOUT px. dragged = last-move height minus the height the press froze; last-move = the");
  console.log("box's height after the final pointermove; release+1 = one animation frame after pointerup; delta =");
  console.log("release+1 minus last-move; revert = last-move minus release+1 (positive = the corner jumped up at the");
  console.log("release); overshoot = last-move minus the room the release clamps to.");

  const reverts = rows.filter((n) => Math.abs(n.revertPx) >= 1);
  const unchanged = rows.filter((n) => Math.abs(n.revertPx) < 1);
  if (rows.length) {
    console.log(`\nRELEASE BOUNCE, BY CASE`);
    for (const n of rows) {
      console.log(
        `  ${pad(n.id, 18)}${rpad(`${n.zoom}%`, 5)}  ${rpad(n.lastMovePx.toFixed(0), 5)}px -> ${rpad(n.releasePx.toFixed(0), 5)}px  ${
          Math.abs(n.revertPx) >= 1 ? `the release gave back ${Math.abs(n.revertPx).toFixed(0)}px (the corner jumps up on pointerup)` : "no revert"
        }`,
      );
    }
    console.log(
      `\nMEASURED ${measuredCount}/${CASES.length} cases. Release revert in ${reverts.length}: ${reverts.map((n) => `${n.id} ${Math.abs(n.revertPx).toFixed(0)}px`).join(", ") || "none"}.` +
        ` No revert in ${unchanged.length}: ${unchanged.map((n) => n.id).join(", ") || "none"}.`,
    );
    console.log("No assertion was made. This run is a measurement, not a pass.");
  } else {
    console.log("\nMEASURED 0 cases: nothing was measured, so nothing is claimed.");
  }
  if (ledger.pageErrors.length) console.log(`PAGEERRORS ${ledger.pageErrors.length}: ${ledger.pageErrors.slice(0, 3).join(" | ")}`);

  if (JSON_OUT) {
    mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
    writeFileSync(path.resolve(JSON_OUT), JSON.stringify(ledger, null, 1), "utf8");
    console.log(`ledger: ${path.resolve(JSON_OUT)}`);
  }
  process.exit(measuredCount === CASES.length ? 0 : measuredCount > 0 ? 1 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
