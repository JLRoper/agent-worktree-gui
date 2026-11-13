#!/usr/bin/env node
// The console's corner grip must stay under the pointer that grabbed it, at every step of the gesture, and the number
// it lands on must survive the release and the rebuild that follows it.
//
//   node tools/verify-console-resize.mjs
//   node tools/verify-console-resize.mjs --keep                              # leave the sandbox behind
//   node tools/verify-console-resize.mjs --shots docs/reports/console-grip    # keep the two captures here
//
// WHAT THIS GUARDS. The console used to be resized by the BROWSER (`resize: vertical` under a 230px max-height). That
// handle is not a gesture the page can see: it is tied to the node it started on, and almost everything here replaces
// or re-measures that node (a status change rebuilds the card, a snapshot rebuilds the board, the 400ms sweep re-pins
// the console to its newest line). Mid-drag the box came back as a fresh node on its cap and the handle walked out
// from under the pointer - the reported "the bottom-right corner jumps out from under my cursor".
//
// The replacement is a grip the page owns (`outGripHtml`, public/board/console.js) with the gesture in public/app.js.
// What this file drives, with CDP input only (a trusted event in Chromium, so nothing synthetic reaches the page):
//
//   1. the console still starts on its cap, its transcript scrolling inside it, nothing pinned inline
//   2. the press lands on the GRIP (`[data-out-grip]`), which is the only thing that resizes a console now
//   3. TEN 20px moves of the pressed pointer, each one checked against the grip's own bounding box: within 2px of
//      the cursor at every step, with the height moving 20px a step in one direction and never back
//   4. the same ten moves in the other direction, the same two readings
//   5. a board-wide rebuild (`window.renderAll()`) fired MID-DRAG: the console is the same node afterwards, at the
//      same height - the gesture owns the box, so no repaint path may rebuild or re-pin it
//   6. two captures: one mid-drag, with a marker drawn at the pointer CDP reports, and one after the release, with the
//      height the gesture reached still on the box
//   7. a press that never moves is a click: it leaves no height and no lifted cap behind
//   8. a second grab starts from where the first left the box, instead of snapping back to the cap
//   9. a console shorter than the cap can be pulled past it
//  10. a click in the console's own text is not a resize
//
// A NOTE ON DIRECTION. The console is a block in the flow: its top edge does not move, so dragging the corner UP makes
// the box SHORTER and DOWN makes it TALLER. The monotonic reading below is therefore "the height moves one way for
// the whole leg, 20px a step" - up shrinks, down grows - which is the only shape a top-anchored box can have.
//
// Everything runs in a sandbox of its own: a throwaway config, log folder, job store and HERMES_HOME, on an ephemeral
// port, assistant off and fetchSeconds off so no worker or gateway can be reached. The live panel is not touched.
//
// The browser half needs a Playwright install. Point the script at one with PANEL_PLAYWRIGHT_ROOT (a directory
// holding node_modules/playwright, or the package itself); without one the script says BROWSER-HALF-NOT-RUN and
// exits 2 rather than passing on a half that never ran.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const CAP = 230;
const GRIP_OFF = 1; // where inside the grip's corner the pointer is put, in px
const TOL = 2; // the grip's box must stay this close to the cursor, at every step
const STEP = 20; // px per move
const MOVES = 10; // moves per leg
const LONG = "probe-console-resize-long";
const SHORT = "probe-console-resize-short";
const KEEP = process.argv.includes("--keep");
const SHOT_DIR = process.argv.includes("--shots")
  ? path.resolve(process.argv[process.argv.indexOf("--shots") + 1])
  : "";

let failures = 0;
const check = (ok, label, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

// Two finished jobs in the sandbox's own store, written BEFORE the panel boots (a running panel rewrites its store
// every ~700ms): one console far taller than the cap, one shorter than it. No run id and no action lines, so
// nothing can be re-attached or re-executed.
function seed(dir) {
  const now = Date.now();
  const job = (thread, prompt, count, at) => ({
    id: (0xb1000000 + at).toString(16),
    thread,
    turn: 0,
    prompt,
    cwd: path.join(dir, `${thread}-cwd`),
    status: "done",
    exitCode: 0,
    startedAt: new Date(now - (at + 1) * 600000).toISOString(),
    endedAt: new Date(now - (at + 1) * 600000 + 40000).toISOString(),
    durationMs: 40000,
    finalMessage: "done",
    lines: [
      { kind: "cmd", text: `POST /v1/runs · session ${thread} · turn 1`, lid: 0, at: now - 600000 },
      ...Array.from({ length: count }, (_, k) => ({
        kind: "out", text: `  line ${k + 1} of the console: the reader is resizing me`, lid: k + 1, at: now - 600000 + k + 1,
      })),
    ],
  });
  // Two consoles to measure, and a dozen filler cards under them. The filler is not decoration: a page whose board is
  // only a card or two tall is scrolled to its MAXIMUM, and a document at its maximum scroll cannot get shorter - the
  // browser clamps the scroll offset down as the box shrinks, and that pull is indistinguishable from a corner that
  // walks away from the pointer. A real board has hundreds of rows below the card being resized, and so does this one.
  const filler = Array.from({ length: 12 }, (_, k) => job(`probe-console-filler-${k + 1}`, `filler card ${k + 1}`, 24, 10 + k));
  const jobs = [job(LONG, "the long console", 120, 3), job(SHORT, "the short console", 4, 1), ...filler];
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify({ savedAt: new Date(now).toISOString(), jobs }, null, 1));
}

// The console of one thread as the page paints it, the grip's own box, and what the gesture writes into the console's
// inline style. `probe` is a marker the harness leaves on the node, which is how a mid-drag rebuild would show up.
const measure = (page, thread) =>
  page.evaluate((t) => {
    const card = document.querySelector(`.job[data-thread="${t}"]`);
    const pre = card && card.querySelector("pre.job-out");
    if (!pre) return null;
    const grip = card.querySelector("[data-out-grip]");
    const r = pre.getBoundingClientRect();
    const cs = getComputedStyle(pre);
    const g = grip ? grip.getBoundingClientRect() : null;
    const gs = grip ? getComputedStyle(grip) : null;
    return {
      t: +r.top.toFixed(1), b: +r.bottom.toFixed(1), l: +r.left.toFixed(1), r: +r.right.toFixed(1),
      h: +r.height.toFixed(1),
      max: cs.maxHeight, inlineH: pre.style.height, inlineMax: pre.style.maxHeight,
      client: pre.clientHeight, scroll: pre.scrollHeight,
      probe: pre.dataset.probe || "",
      grip: g ? { b: +g.bottom.toFixed(1), r: +g.right.toFixed(1), w: +g.width.toFixed(1), h: +g.height.toFixed(1) } : null,
      gripTouch: gs ? gs.touchAction : "",
      gripCursor: gs ? gs.cursor : "",
      // The grip is a sibling of the console inside `.out-box`, and nothing else lives in that box: the marching row
      // and the chips are outside it, so neither can move the corner the reader is holding.
      gripInBox: Boolean(grip && grip.parentElement && grip.parentElement.classList.contains("out-box")),
      boxKids: grip && grip.parentElement ? [...grip.parentElement.children].map((n) => `${n.tagName}.${n.className || ""}`) : [],
      marchOutside: Boolean(grip && grip.parentElement && !grip.parentElement.querySelector(".march")),
      roomBelow: card ? Math.round(document.documentElement.scrollHeight - (window.scrollY + card.getBoundingClientRect().bottom)) : -1,
      // The page's own topbar WRAPS (`flex-wrap`, position: sticky, in the flow). One row more or less is 38px of
      // everything below it, so a rewrap between two moves moves the card under a pointer that has not moved. It is
      // watched here so a reading that is really a topbar rewrap says so instead of blaming the grip.
      bar: (() => { const tb = document.querySelector(".topbar"); return tb ? Math.round(tb.getBoundingClientRect().height) : -1; })(),
    };
  }, thread);

// Bring the card into the window, CLEAR OF THE STICKY TOPBAR, and let the board's own scroll correction settle before
// anything is pressed. `scrollIntoView({block:"start"})` puts the card at viewport 0, behind the sticky bar, and the
// panel's reader-position code then scrolls it out by the bar's height (38px here) a fraction of a second later - a
// correction that lands between a press and the first move reads as the corner moving, which is the very thing this
// file is measuring. A page scroll does not touch a console's own scrollTop.
async function show(page, thread) {
  await page.evaluate((t) => {
    const card = document.querySelector(`.job[data-thread="${t}"]`);
    if (!card) return;
    const top = card.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, Math.round(top) - 120));
  }, thread);
  // The board corrects the reader's position for a few frames after a scroll (its anchor repick, then the observer's
  // answer to it). Read the card twice, 220ms apart, until the two readings agree; four tries covers the corrections
  // the panel makes and is short enough not to hide a page that never settles.
  let a = null;
  let b = await measure(page, thread);
  for (let try_ = 0; try_ < 4; try_ += 1) {
    await page.waitForTimeout(220);
    a = b;
    b = await measure(page, thread);
    if (Math.abs(a.t - b.t) < 1 && Math.abs(a.h - b.h) < 1 && a.bar === b.bar) break;
  }
  return { ...b, settled: Math.abs(a.t - b.t) < 1 && Math.abs(a.h - b.h) < 1 && a.bar === b.bar };
}

// Press the grip's bottom-right corner and hand back the point, so every later move is the reader's own pointer.
async function grab(page, thread) {
  const m = await measure(page, thread);
  if (!m.grip) return { x: 0, y: 0, at: m, after: m, onGrip: false };
  const x = m.grip.r - GRIP_OFF;
  const y = m.grip.b - GRIP_OFF;
  await page.mouse.move(x, y);
  const onGrip = await page.evaluate(
    ({ px, py }) => {
      const el = document.elementFromPoint(px, py);
      const grip = document.querySelector(".job [data-out-grip]");
      const gs = grip ? getComputedStyle(grip) : null;
      return {
        hit: Boolean(el?.closest?.("[data-out-grip]")),
        at: el ? `${el.tagName}.${el.className}` : "none",
        pe: gs ? gs.pointerEvents : "",
        vis: gs ? `${gs.visibility}/${gs.display}/${gs.opacity}` : "",
      };
    },
    { px: x, py: y },
  );
  await page.mouse.down();
  await page.waitForTimeout(80);
  return { x, y, at: m, after: await measure(page, thread), onGrip: onGrip.hit, onGripAt: onGrip.at, onGripStyle: onGrip.pe + " " + onGrip.vis };
}

// One move of the pressed pointer, and the console's frame and grip there. `gapX`/`gapY` are the pointer-to-grip-corner
// distances in px: a grip that tracks the pointer keeps them constant, and 0 x 0 would mean the corner is exactly under
// the cursor.
async function slide(page, thread, x, y) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(40);
  const m = await measure(page, thread);
  return {
    ...m, mx: x, my: y,
    gapX: +(m.grip ? m.grip.r - x : NaN).toFixed(1),
    gapY: +(m.grip ? m.grip.b - y : NaN).toFixed(1),
  };
}

// A marker at the coordinates CDP reports, drawn by the HARNESS (not the app) so the capture shows where the pointer
// was: a screenshot has no cursor in it, and "the grip is under the pointer" is the whole claim.
const mark = (page, x, y, label) =>
  page.evaluate(
    ({ px, py, text }) => {
      let dot = document.getElementById("probe-pointer");
      if (!dot) {
        dot = document.createElement("div");
        dot.id = "probe-pointer";
        dot.style.cssText =
          "position:fixed;z-index:99999;pointer-events:none;width:13px;height:13px;margin:-6.5px 0 0 -6.5px;" +
          "border-radius:50%;border:2px solid #e11;box-shadow:0 0 0 2px #fff;";
        document.body.appendChild(dot);
      }
      dot.style.left = `${px}px`;
      dot.style.top = `${py}px`;
      dot.title = text;
      return true;
    },
    { px: x, py: y, text: label },
  );

const unmark = (page) => page.evaluate(() => document.getElementById("probe-pointer")?.remove());

// A caption inside the capture: two panes 20px apart say nothing on their own, and the numbers the assertions used are
// what make the pair readable.
const caption = (page, box, lines) =>
  page.evaluate(
    ({ spot, text }) => {
      let cap = document.getElementById("probe-caption");
      if (!cap) {
        cap = document.createElement("div");
        cap.id = "probe-caption";
        document.body.appendChild(cap);
      }
      cap.style.cssText =
        "position:fixed;z-index:99998;pointer-events:none;background:#0b0e13e6;color:#e6edf7;border:1px solid #e11;" +
        `border-radius:4px;padding:3px 6px;font:11px/1.5 ui-monospace,SFMono-Regular,monospace;white-space:pre;left:${spot.x + 8}px;top:${spot.y + 8}px;`;
      cap.textContent = text;
      return true;
    },
    { spot: box, text: lines.join(String.fromCharCode(10)) },
  );

const uncaption = (page) => page.evaluate(() => document.getElementById("probe-caption")?.remove());

// The card the console lives in, as a clip for the capture: the corner the reader is holding, plus a margin.
const clipOf = (page, thread, m) =>
  page.evaluate(
    ({ t, top, bottom }) => {
      const card = document.querySelector(`.job[data-thread="${t}"]`);
      const r = card.getBoundingClientRect();
      const x = Math.max(0, r.left - 12);
      const y = Math.max(0, Math.min(top, r.top) - 12);
      return {
        x,
        y,
        width: Math.min(r.width + 24, innerWidth - x),
        height: Math.min(Math.max(bottom, r.bottom) - y + 24, innerHeight - y),
      };
    },
    { t: thread, top: m.t, bottom: m.b },
  );

const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;
const monotone = (heights, dir) =>
  heights.every((h, i) => i === 0 || (dir === "down" ? h > heights[i - 1] : h < heights[i - 1]));

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("console resize grip", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
    process.exit(2);
  }
  if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });
  const shot = (name) => (SHOT_DIR ? path.join(SHOT_DIR, name) : "");

  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-console-resize-"));
  seed(dir);
  const panel = await startPanel({ dir, config: { assistant: { enabled: false }, fetchSeconds: -1 } });
  try {
    console.log(`sandbox: ${panel.base}`);
    await withBrowser(
      async ({ page, pageErrors }) => {
        await openPage(page, panel.base, { selector: `pre.job-out` });
        await page.waitForSelector(`.job[data-thread="${LONG}"] pre.job-out`, { state: "visible", timeout: 20_000 });
        await page.waitForSelector(`.job[data-thread="${SHORT}"] pre.job-out`, { state: "visible", timeout: 20_000 });
        // Let the page finish arriving before anything is measured: the topbar's own status line is painted after the
        // board and can wrap the bar into a second row a moment later - 38px of everything below it, which is the one
        // thing in this page that can move a card without a pointer.
        await page.waitForTimeout(1500);

        // ---- 1. the console still starts on its cap, with the transcript scrolling inside it
        const start = await show(page, LONG);
        check(start.settled, "the board has stopped moving the card under the reading before anything is pressed");
        check(near(start.h, CAP), "a long console sits on the 230px cap", `h=${start.h}`);
        check(start.scroll > start.client + 300, "and its transcript scrolls inside that cap",
          `scroll ${start.scroll} > client ${start.client}`);
        check(start.inlineH === "" && start.max === `${CAP}px`, "with nothing pinned in its inline style",
          `inlineH=${JSON.stringify(start.inlineH)} max=${start.max}`);
        check(Boolean(start.grip) && near(start.grip.w, 18) && near(start.grip.h, 18),
          "the corner grip is drawn, 18x18", start.grip ? `${start.grip.w}x${start.grip.h}` : "none");
        check(start.gripTouch === "none", "and takes the gesture off the browser's own touch panning",
          `touch-action=${start.gripTouch}`);
        check(start.gripCursor.includes("nwse-resize"), "and says nwse-resize", `cursor=${start.gripCursor}`);
        check(start.gripInBox && start.boxKids.length === 2, "the box holds the console and the grip, and nothing else",
          start.boxKids.join(" | "));
        check(start.marchOutside, "while the marching row and the chips sit outside that box");
        // ROOM BELOW THE CARD. A document scrolled to its very end cannot get shorter: the browser clamps the scroll
        // offset down as the box shrinks, and that clamp moves the console up the screen by exactly the pixels the
        // gesture took - indistinguishable from a corner that walks away. The probe board is given enough below the
        // card that this never happens, and this check is what says so.
        check(start.roomBelow > 600, "and the board has room under the card, so no scroll clamp can move it",
          `room below ${start.roomBelow}px`);

        // ---- 2. a press on the corner that does not move is not a resize: nothing is left pinned
        {
          const g = await grab(page, LONG);
          check(g.onGrip, "the press lands on the grip, not on the console's edge", `${g.onGripAt} pe=${g.onGripStyle}`);
          check(near(g.after.h, start.h), "the grab itself moves nothing", `h ${start.h} -> ${g.after.h}`);
          await page.mouse.up();
          await page.waitForTimeout(80);
          const after = await measure(page, LONG);
          check(near(after.h, CAP), "a press on the grip with no drag leaves the console on its cap", `h=${after.h}`);
          check(after.inlineH === "" && after.max === `${CAP}px`, "and pins neither a height nor a lifted cap",
            `inlineH=${JSON.stringify(after.inlineH)} max=${after.max}`);
        }

        // ---- 3. TEN 20px moves UP: the grip stays on the cursor and the console loses 20px a step
        const g1 = await grab(page, LONG);
        check(near(g1.after.h, g1.at.h), "pointerdown leaves the console the size it was", `h ${g1.at.h} -> ${g1.after.h}`);
        check(g1.after.inlineH === `${g1.at.h}px` && g1.after.max === "none",
          "the height it has is pinned as the gesture starts, and the cap lifted in the same breath",
          `inlineH=${g1.after.inlineH} max=${g1.after.max}`);
        check(near(g1.at.b, g1.at.grip.b) && near(g1.at.r, g1.at.grip.r),
          "the grip's corner IS the console's corner", `pre ${g1.at.r}x${g1.at.b} grip ${g1.at.grip.r}x${g1.at.grip.b}`);

        const up = [];
        for (let i = 1; i <= MOVES; i += 1) up.push(await slide(page, LONG, g1.x, g1.y - i * STEP));
        if (process.env.PROBE_SCROLL) console.log("scrollBy:", JSON.stringify(await page.evaluate(() => window.__scrollWho.slice(0, 2))));
        const upGapsX = up.map((s) => Math.abs(s.gapX));
        const upGapsY = up.map((s) => Math.abs(s.gapY));
        check(upGapsX.every((v) => v <= TOL) && upGapsY.every((v) => v <= TOL),
          `ten 20px moves up: the grip's box stays within ${TOL}px of the cursor at every step`,
          `x ${upGapsX.join(",")} | y ${upGapsY.join(",")} | topbar ${up.map((s) => s.bar).join(",")}`);
        check(monotone(up.map((s) => s.h), "up") && up.every((s, i) => near(s.h, g1.at.h - (i + 1) * STEP, 2)),
          "and the console moves 20px a step in one direction, never back",
          `heights ${up.map((s) => s.h).join(",")}`);

        // ---- the board-wide rebuild, fired MID-DRAG: the gesture owns the box, so nothing may replace or re-pin it
        {
          await page.evaluate((t) => {
            document.querySelector(`.job[data-thread="${t}"] pre.job-out`).dataset.probe = "same-node";
          }, LONG);
          const before = up[up.length - 1];
          await page.evaluate(() => {
            window.renderAll();
            window.dispatchEvent(new Event("resize"));
          });
          await page.waitForTimeout(120);
          const after = await measure(page, LONG);
          check(after.probe === "same-node", "a renderAll fired mid-drag does not replace the console node",
            `probe=${JSON.stringify(after.probe)}`);
          check(near(after.h, before.h) && after.inlineH === before.inlineH,
            "and does not re-measure or re-pin it either", `h ${before.h} -> ${after.h}`);
        }

        // ---- 4. ...and the same ten moves DOWN, with the same two readings
        const down = [];
        for (let i = 1; i <= MOVES; i += 1) down.push(await slide(page, LONG, g1.x, g1.y - (MOVES - i) * STEP));
        const downGapsX = down.map((s) => Math.abs(s.gapX));
        const downGapsY = down.map((s) => Math.abs(s.gapY));
        check(downGapsX.every((v) => v <= TOL) && downGapsY.every((v) => v <= TOL),
          `ten 20px moves down: the grip's box stays within ${TOL}px of the cursor at every step`,
          `x ${downGapsX.join(",")} | y ${downGapsY.join(",")} | topbar ${down.map((s) => s.bar).join(",")}`);
        check(monotone(down.map((s) => s.h), "down"),
          "and the console grows 20px a step, monotonically, all the way back",
          `heights ${down.map((s) => s.h).join(",")}`);
        check(near(down[down.length - 1].h, g1.at.h),
          "the ten moves back land on the height the gesture started from", `h ${down[down.length - 1].h}`);

        // ---- 5. the two captures: the grip under the pointer mid-drag, and the height kept after the release
        let chosen = 0;
        {
          const last = down[down.length - 1];
          // One more move, so the capture is of a gesture that is still travelling rather than one that has arrived.
          const mid = await slide(page, LONG, g1.x, last.my + STEP);
          const midClip = await clipOf(page, LONG, mid);
          await mark(page, mid.mx, mid.my, "pointer");
          await caption(page, midClip, [
            "mid-drag: the pointer is down, the console is still travelling",
            `grip corner ${Math.abs(mid.gapX)}px / ${Math.abs(mid.gapY)}px from the pointer (limit ${TOL})`,
            `console ${mid.h}px  (started ${g1.at.h}px, sheet cap ${CAP}px)`,
          ]);
          if (SHOT_DIR) await page.screenshot({ path: shot("console-grip-mid-drag.png"), clip: midClip });
          check(Math.abs(mid.gapX) <= TOL && Math.abs(mid.gapY) <= TOL,
            "the mid-drag capture is taken with the grip on the pointer", `gap ${mid.gapX}x${mid.gapY}`);
          check(mid.h > g1.at.h, "mid-drag the console is taller than it started", `h ${g1.at.h} -> ${mid.h}`);
          await unmark(page);
          await uncaption(page);

          // The release, with the height the gesture reached.
          await page.mouse.up();
          await page.waitForTimeout(140);
          const kept = await measure(page, LONG);
          if (SHOT_DIR) {
            const keptClip = await clipOf(page, LONG, kept);
            await caption(page, keptClip, [
              "released: the height the gesture reached is kept",
              `console ${kept.h}px  (inline ${kept.inlineH || "none"}, cap ${kept.max === "none" ? "lifted" : kept.max})`,
              "no pointer marker: the gesture is over",
            ]);
            await page.screenshot({ path: shot("console-grip-after-release.png"), clip: keptClip });
            await uncaption(page);
          }
          check(near(kept.h, Math.round(mid.h), 1), "the release keeps the height the gesture reached",
            `mid ${mid.h} -> after ${kept.h}`);
          check(near(parseFloat(kept.inlineH), mid.h, 1), "on the box, as an explicit pixel height",
            `inlineH=${JSON.stringify(kept.inlineH)}`);
          check(kept.max === "none", "with the cap still lifted off it, because it is above the cap", `max=${kept.max}`);
          check(kept.probe === "same-node" || kept.probe === "",
            "and the deferred rebuild did not lose it", `probe=${JSON.stringify(kept.probe)} h=${kept.h}`);
        }

        // ---- 6. a second grab starts from where the first left the box, instead of snapping back to the cap
        {
          const grew = await measure(page, LONG);
          const g2 = await grab(page, LONG);
          check(near(g2.after.h, g2.at.h), "a second grab moves nothing either", `h ${g2.at.h} -> ${g2.after.h}`);
          check(near(g2.at.h, grew.h), "and starts from the height the last gesture left", `h=${g2.at.h}`);
          const again = await slide(page, LONG, g2.x, g2.y + STEP);
          check(Math.abs(again.gapY) <= TOL && near(again.h, g2.at.h + STEP),
            "which it then tracks like the first", `gapY=${again.gapY} h ${g2.at.h} -> ${again.h}`);
          await page.mouse.up();
          await page.waitForTimeout(80);
          chosen = (await measure(page, LONG)).h;
        }

        // ---- 7. a console shorter than the cap can still be pulled past it (the cap is what used to stop it dead)
        {
          const shortStart = await show(page, SHORT);
          check(shortStart.h < CAP, "the short console starts under the cap", `h=${shortStart.h}`);
          const g3 = await grab(page, SHORT);
          const pull = [];
          for (let i = 1; i <= 13; i += 1) pull.push(await slide(page, SHORT, g3.x, g3.y + i * STEP));
          await page.mouse.up();
          await page.waitForTimeout(80);
          check(pull.every((s) => Math.abs(s.gapY) <= TOL), "its grip tracks the pointer too",
            `gaps ${pull.map((s) => s.gapY).join(",")}`);
          const end = pull[pull.length - 1];
          check(end.h > CAP && near(end.h, shortStart.h + 260),
            "and the drag carries it past the cap the console otherwise sits on",
            `h ${shortStart.h} -> ${end.h} (cap ${CAP})`);
        }

        // ---- 8. a reload rebuilds every card on the board: the console comes back at the height the reader chose,
        //         and a click in its own text is still not a resize
        {
          await page.reload({ waitUntil: "domcontentloaded" });
          await page.waitForSelector(`.job[data-thread="${LONG}"] pre.job-out`, { state: "visible", timeout: 20_000 });
          const before = await show(page, LONG);
          check(near(before.h, chosen, 1) && near(parseFloat(before.inlineH), chosen, 1),
            "a reload draws the console at the height the gesture left it", `chosen ${chosen} -> h ${before.h}`);
          check(before.max === "none", "with the cap lifted off it, because that height is above the cap",
            `max=${before.max}`);
          await page.mouse.move(before.l + 120, before.t + 40);
          await page.mouse.down();
          await page.mouse.up();
          await page.waitForTimeout(120);
          const after = await measure(page, LONG);
          check(after.max === before.max && after.inlineMax === before.inlineMax,
            "a click in the console's own text lifts no cap", `max ${before.max} -> ${after.max}`);
          check(near(after.h, before.h), "and moves no height the reader did not ask for", `h ${before.h} -> ${after.h}`);
        }

        check(pageErrors.length === 0, "the page threw nothing", pageErrors.slice(0, 3).join(" | "));
      },
      { viewport: { width: 1440, height: 900 } },
    );
  } finally {
    await panel.stop();
    if (!KEEP) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    else console.log(`sandbox kept: ${dir}`);
  }

  if (SHOT_DIR) console.log(`captures: ${shot("console-grip-mid-drag.png")} and ${shot("console-grip-after-release.png")}`);
  console.log(failures ? `RESULT: FAIL (${failures} check${failures === 1 ? "" : "s"})` : "RESULT: PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
