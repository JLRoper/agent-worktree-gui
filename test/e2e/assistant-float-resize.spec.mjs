// test/e2e/assistant-float-resize.spec.mjs - the floating assistant's corner, dragged in a real browser.
//
// WHAT THIS IS. The float is a window (`#assistant.is-floating`): its title row moves it and the split handle
// (`#as-split`, moved to the bottom-right corner by the stylesheet) sizes it. A reader who grabs that corner and
// drags it expects the corner to stay under the pointer, the frame to grow by exactly what the pointer travelled,
// and - the half this spec's console case was added for - the CONSOLE they are reading to get the room the frame
// gained. Three failures are named where they happen:
//
//   1. THE CORNER IS DEAD. `#assistant.is-floating .as-split` is drawn inside the float's rounded corner
//      (a 10px radius with `overflow: hidden` on the float, 9px on the handle itself), so the last few pixels of the
//      handle are clipped out of every hit area and a press there falls through to the board UNDER the window. The
//      reader grabs the grip, drags, and nothing resizes; the size never changes and the corner walks away from the
//      pointer by the whole step.
//   2. THE CORNER DOES NOT TRACK. Once the press does land on the handle, the frame has to grow by the pointer's own
//      travel - `width + dx`, `height + dy`, divided once by the page zoom - or the corner drifts away from the
//      cursor, which is the "jump" the reader sees: the frame grows by something other than the drag.
//   3. THE CONSOLE GOES BACKWARDS. The room a taller frame gains belongs to the open turn's console (`is-slack` in
//      assistant.js, `flex: 1 1 auto` in the stylesheet). In an OVERFLOWING transcript there is no free space for
//      that flex to grow into, and the console's drawn height is its content's, so a WIDER frame rewraps the text
//      into fewer lines and the console came back SHORTER for a drag that made the panel bigger (measured 132.5 ->
//      98px on a +200x+150 drag) and TALLER for one that made it smaller. A drag is monotonic in both directions, or
//      the reader's box shrinks while they pull it open.
//
// All of it is measured per step (the corner within 2px of the pointer, each dimension changed by the step, the
// console never going backwards), then after the release (the drawn frame is the last dragged frame, the transcript
// has not scrolled out from under the reader, and the remembered rect is the DRAWN one), then a drag back up-left
// (both the frame and the console shrink and stop at their floors).
//
//   RUN   node --test --test-reporter=spec test/e2e/assistant-float-resize.spec.mjs
//
// The panel is its own (tools/panel-testkit.mjs): a throwaway server.js from THIS checkout, a spare port, its own
// config and job store, `assistant.enabled` false and `fetchSeconds` off, so no gateway or worker can be reached and
// the reader's panel on 7331 is never started, read or written.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadPlaywright } from "../../tools/browser.mjs";
import { startPanel } from "../../tools/panel-testkit.mjs";

const PW = loadPlaywright();
const SKIP = PW
  ? null
  : "BROWSER-HALF-NOT-RUN: no Playwright install found (set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright)";
const it = (name, fn) => (PW ? test(name, fn) : test(name, { skip: SKIP }, () => {}));

const THREAD = "panel-assistant";
const STEP = 20;
const STEPS = 5;
const BACK = 25;
const BACK_STEPS = 20;
const FLOAT_MIN = 320;
const TOL = 2;

const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-float-resize-"));
let panel = null;
let browser = null;

after(async () => {
  if (browser) await browser.close().catch(() => {});
  if (panel) await panel.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

// One settled turn with a console longer than the pane, so the transcript has a scroll position the drag could lose.
function seedTurns() {
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  const now = Date.now();
  const jobs = [];
  for (let i = 0; i < 2; i += 1) {
    const at = now - (2 - i) * 600_000;
    const lines = Array.from({ length: 90 }, (_, k) => ({
      kind: "out",
      text: `turn ${i + 1} line ${k + 1}: the console is longer than the pane, so the transcript has somewhere to be`,
      lid: k + 1,
      at: at + 1_000 + k,
    }));
    jobs.push({
      id: `tkfloat${i + 1}`, thread: THREAD, turn: i + 1, prompt: `fixture turn ${i + 1}`, status: "done", exitCode: 0,
      startedAt: new Date(at).toISOString(), endedAt: new Date(at + 30_000).toISOString(), durationMs: 30_000,
      finalMessage: "done", cwd: dir, ownerPath: dir, worktreePath: dir, lines,
    });
  }
  writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify({ savedAt: new Date(now).toISOString(), jobs }, null, 1));
}

const post = (base, route, body) =>
  fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

// The one read every case below is a statement about: the float's border box, the handle's corner, the console the
// open turn is reading, the transcript's scroll position, the remembered rect, and the zoom the styles write through.
const geometry = (page) =>
  page.evaluate(() => {
    const a = document.getElementById("assistant");
    const split = document.getElementById("as-split");
    const r = a.getBoundingClientRect();
    const h = split.getBoundingClientRect();
    const sub = document.querySelector('#assistant [data-subpane="chat"]');
    const body = sub && sub.querySelector(":scope > .job > .job-body");
    const open = body ? [...body.querySelectorAll(":scope > .turn:not(.folded)")] : [];
    const cons = open.length ? open[open.length - 1].querySelector(".job-out") : null;
    const cr = cons ? cons.getBoundingClientRect() : null;
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem("wm.assistantFloat") || "null");
    } catch {
      saved = null;
    }
    return {
      box: { l: +r.left.toFixed(2), t: +r.top.toFixed(2), r: +r.right.toFixed(2), b: +r.bottom.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) },
      handle: { l: +h.left.toFixed(2), t: +h.top.toFixed(2), r: +h.right.toFixed(2), b: +h.bottom.toFixed(2), w: +h.width.toFixed(2), h: +h.height.toFixed(2) },
      console: cr ? { h: +cr.height.toFixed(2), min: parseFloat(getComputedStyle(cons).minHeight) || 0, inline: cons.style.height || "" } : null,
      floating: a.classList.contains("is-floating"),
      scrollTop: body ? body.scrollTop : null,
      saved,
      zoom: parseFloat(getComputedStyle(document.documentElement).zoom) || 1,
    };
  });

// One press at the drawn corner's grip, moved `steps` times by (dx, dy), with `each` reading the page after every
// move. The release happens in `finally`, so a failed assertion still leaves the page without a held pointer.
async function drag(page, { dx, dy, steps, each }) {
  const at = await geometry(page);
  const px = at.handle.r - 1;
  const py = at.handle.b - 1;
  await page.mouse.move(px, py);
  await page.mouse.down();
  const seen = [];
  try {
    for (let i = 1; i <= steps; i += 1) {
      const cx = Math.max(1, px + dx * i);
      const cy = Math.max(1, py + dy * i);
      await page.mouse.move(cx, cy);
      await page.waitForTimeout(40);
      const now = await geometry(page);
      seen.push({ step: i, pointer: { x: cx, y: cy }, ...now });
      if (each) await each(now, i, px, py);
    }
  } finally {
    await page.mouse.up();
  }
  return { start: at, seen };
}

it("a corner drag grows the float and its console by the drag, shrinks both back to the floor, and keeps the drawn rect", async () => {
  seedTurns();
  panel = await startPanel({ dir, config: { assistant: { enabled: false }, fetchSeconds: -1, refreshSeconds: 3600 } });
  // The pane's frame is the PANEL's key (`dockMode` in config.json, POST /api/settings/general), not a per-assistant
  // field: the older `/api/assistant/profile` route drops a `dock` patch, so a spec that posted one booted a docked
  // rail and failed on its first assertion.
  await post(panel.base, "/api/settings/general", { dockMode: "floating" });

  const { chromium } = PW;
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));

  await page.goto(panel.base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#btn-assistant", { timeout: 30_000 });
  // Open, floating, at a rect that leaves the corner room to grow in both directions. The float remembers its rect
  // in `wm.assistantFloat`, so the boot is the open.
  await page.evaluate(() => {
    localStorage.setItem("wm.assistantFloat", JSON.stringify({ x: 500, y: 60, w: 480, h: 560 }));
    localStorage.removeItem("wtgui.zoom");
    localStorage.setItem("wm.assistantOpen", "1");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  // `wm.assistantOpen` is remembered, so the float is already up: pressing #btn-assistant here would CLOSE it.
  await page.waitForSelector("#assistant", { state: "visible", timeout: 30_000 });
  await page.waitForSelector('#assistant [data-subpane="chat"] .turn', { state: "attached", timeout: 30_000 });
  await page.waitForTimeout(400);
  // A transcript folded shut has no console on the page at all: open the newest turn, which is the one a resize
  // gesture opens for itself when every turn is folded.
  await page.evaluate(() => {
    const body = document.querySelector('#assistant [data-subpane="chat"] > .job > .job-body');
    const turns = [...body.querySelectorAll(":scope > .turn")];
    if (turns.length && !turns.some((t) => !t.classList.contains("folded"))) turns[turns.length - 1].querySelector("[data-toggle-turn]")?.click();
  });
  await page.waitForTimeout(300);

  const start = await geometry(page);
  assert.equal(start.floating, true, "the pane is drawn as the float");
  assert.ok(start.handle.w > 0 && start.handle.h > 0, `the split handle is on the page (${start.handle.w}x${start.handle.h})`);
  assert.ok(start.console, "the press has an open turn's console to measure");
  assert.equal(start.console.inline, "", "the console is drawn by the sheet, not by a remembered height");

  // Put the transcript somewhere a re-render would visibly move it.
  await page.evaluate(() => {
    const body = document.querySelector('#assistant [data-subpane="chat"] > .job > .job-body');
    body.scrollTop = Math.round((body.scrollHeight - body.clientHeight) / 2);
  });
  await page.waitForTimeout(120);
  const scrolled = await geometry(page);
  assert.ok(scrolled.scrollTop > 0, `the transcript is scrolled off its top (${scrolled.scrollTop}px)`);

  // 1. DOWN-RIGHT: every step grows both dimensions of the frame by its travel, and the console never goes backwards.
  let last = start;
  const { seen: grown } = await drag(page, {
    dx: STEP,
    dy: STEP,
    steps: STEPS,
    each: (now, i, px, py) => {
      const cx = px + STEP * i;
      const cy = py + STEP * i;
      const corner = { x: +(now.box.r - cx).toFixed(2), y: +(now.box.b - cy).toFixed(2) };
      const grew = { w: +(now.box.w - last.box.w).toFixed(2), h: +(now.box.h - last.box.h).toFixed(2) };
      assert.ok(
        Math.abs(corner.x) <= TOL && Math.abs(corner.y) <= TOL,
        `step ${i}: the frame's corner is under the pointer (off by ${corner.x}, ${corner.y}; pointer ${cx},${cy}, corner ${now.box.r},${now.box.b})`,
      );
      assert.ok(
        Math.abs(grew.w - STEP) <= TOL && Math.abs(grew.h - STEP) <= TOL,
        `step ${i}: width and height each grew by the ${STEP}px step (grew ${grew.w}, ${grew.h})`,
      );
      assert.ok(
        now.console && now.console.h >= last.console.h - 0.5,
        `step ${i}: the console never went backwards (${last.console.h} -> ${now.console.h})`,
      );
      last = now;
    },
  });
  const grownEnd = grown[grown.length - 1];
  assert.ok(
    grownEnd.box.w - start.box.w >= STEP * STEPS - TOL && grownEnd.box.h - start.box.h >= STEP * STEPS - TOL,
    `the frame grew by the drag (${start.box.w}x${start.box.h} -> ${grownEnd.box.w}x${grownEnd.box.h})`,
  );
  assert.ok(
    grownEnd.console.h - start.console.h >= STEP * STEPS - TOL,
    `the console took the room the drag made (${start.console.h} -> ${grownEnd.console.h} for a ${STEP * STEPS}px taller frame)`,
  );

  await page.waitForTimeout(250);
  const released = await geometry(page);
  assert.ok(
    Math.abs(released.box.w - grownEnd.box.w) <= TOL && Math.abs(released.box.h - grownEnd.box.h) <= TOL,
    `the release draws the frame that was dragged (dragged ${grownEnd.box.w}x${grownEnd.box.h}, released ${released.box.w}x${released.box.h})`,
  );
  assert.ok(
    Math.abs(released.box.l - start.box.l) <= TOL && Math.abs(released.box.t - start.box.t) <= TOL,
    `the left and top edges did not move (${start.box.l},${start.box.t} -> ${released.box.l},${released.box.t})`,
  );
  assert.equal(released.scrollTop, scrolled.scrollTop, `the transcript kept its scroll position (${scrolled.scrollTop} -> ${released.scrollTop})`);
  assert.ok(
    Math.abs(released.console.h - grownEnd.console.h) <= TOL,
    `the release keeps the console's size (${grownEnd.console.h} -> ${released.console.h})`,
  );
  // The remembered rect is the DRAWN frame, measured after the clamp - not the pointer's arithmetic.
  assert.ok(released.saved, "the float remembered its rect");
  assert.ok(
    Math.abs(released.saved.w - Math.round(released.box.w)) <= TOL && Math.abs(released.saved.h - Math.round(released.box.h)) <= TOL,
    `the remembered rect is the drawn frame (saved ${released.saved.w}x${released.saved.h}, drawn ${released.box.w}x${released.box.h})`,
  );

  // 2. UP-LEFT: both dimensions shrink and never grow, and both stop at their floor instead of going through it.
  let back = released;
  const { seen: shrunk } = await drag(page, {
    dx: -BACK,
    dy: -BACK,
    steps: BACK_STEPS,
    each: (now, i) => {
      assert.ok(
        now.box.w <= back.box.w + 0.5 && now.box.h <= back.box.h + 0.5,
        `back ${i}: the frame never grew on an up-left drag (${back.box.w}x${back.box.h} -> ${now.box.w}x${now.box.h})`,
      );
      assert.ok(
        now.console && now.console.h <= back.console.h + 0.5,
        `back ${i}: the console never grew on an up-left drag (${back.console.h} -> ${now.console.h})`,
      );
      assert.ok(now.box.w >= FLOAT_MIN - 0.5 && now.box.h >= FLOAT_MIN - 0.5, `back ${i}: the frame stopped at its floor (${now.box.w}x${now.box.h})`);
      back = now;
    },
  });
  const shrunkEnd = shrunk[shrunk.length - 1];
  assert.ok(
    Math.abs(shrunkEnd.box.w - FLOAT_MIN) <= TOL && Math.abs(shrunkEnd.box.h - FLOAT_MIN) <= TOL,
    `the up-left drag reached the floor (${shrunkEnd.box.w}x${shrunkEnd.box.h})`,
  );
  // The console gives back the height the frame lost, and no more: its size follows the FRAME's drawn gain, not the
  // pointer's travel, so once the frame is on its floor the console stops too.
  assert.ok(
    grownEnd.console.h - shrunkEnd.console.h >= grownEnd.box.h - shrunkEnd.box.h - TOL,
    `the console gave back the room the frame lost (${grownEnd.console.h} -> ${shrunkEnd.console.h} for ${grownEnd.box.h} -> ${shrunkEnd.box.h})`,
  );
  // …and the last steps moved nothing: the floors are stops, not a creep past the pointer.
  const lastTwo = shrunk.slice(-2);
  assert.ok(
    lastTwo.every((s) => Math.abs(s.box.w - shrunkEnd.box.w) <= 0.5 && Math.abs(s.box.h - shrunkEnd.box.h) <= 0.5 && Math.abs(s.console.h - shrunkEnd.console.h) <= 0.5),
    `the floors hold: no step past them moved anything (${lastTwo.map((s) => `${s.box.w}x${s.box.h}/${s.console.h}`).join(", ")})`,
  );

  await page.waitForTimeout(250);
  const backEnd = await geometry(page);
  assert.ok(
    Math.abs(backEnd.box.w - shrunkEnd.box.w) <= TOL && Math.abs(backEnd.box.h - shrunkEnd.box.h) <= TOL,
    `the release draws the shrunk frame (${shrunkEnd.box.w}x${shrunkEnd.box.h} -> ${backEnd.box.w}x${backEnd.box.h})`,
  );
  assert.ok(
    Math.abs(backEnd.saved.w - Math.round(backEnd.box.w)) <= TOL && Math.abs(backEnd.saved.h - Math.round(backEnd.box.h)) <= TOL,
    `the remembered rect follows the shrink (saved ${backEnd.saved.w}x${backEnd.saved.h}, drawn ${backEnd.box.w}x${backEnd.box.h})`,
  );

  // 3. A FOLDED TRANSCRIPT: there is no console on the page at all, so the gesture opens the newest turn itself and
  // hands THAT box the room. A press-time measurement would have nothing to measure here.
  await page.evaluate(() => {
    const body = document.querySelector('#assistant [data-subpane="chat"] > .job > .job-body');
    for (const t of body.querySelectorAll(":scope > .turn:not(.folded)")) t.querySelector("[data-toggle-turn]")?.click();
  });
  await page.waitForTimeout(250);
  assert.equal((await geometry(page)).console, null, "every turn is folded: no console on the page");

  let folded = await geometry(page);
  const openedByDrag = [];
  await drag(page, {
    dx: STEP,
    dy: STEP,
    steps: 3,
    each: (now, i) => {
      openedByDrag.push({ i, console: now.console ? now.console.h : null, w: now.box.w, h: now.box.h });
      folded = now;
    },
  });
  assert.ok(folded.console, "the drag opened the newest turn and handed it the room");
  assert.ok(folded.box.w - start.box.w >= STEP * 3 - TOL || folded.box.w >= FLOAT_MIN + STEP * 3 - TOL, `the folded drag grew the frame (${folded.box.w}x${folded.box.h})`);
  const consFirst = openedByDrag.find((s) => s.console !== null);
  assert.ok(consFirst, "the console appeared during the drag");
  assert.ok(
    folded.console.h - consFirst.console >= STEP * (3 - consFirst.i) - TOL,
    `the console opened mid-drag took the room the rest of the drag made (${openedByDrag.map((s) => `${s.i}:${s.console}`).join(", ")})`,
  );
  assert.deepEqual(errors, [], "no page errors");
});
