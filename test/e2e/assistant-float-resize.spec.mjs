// test/e2e/assistant-float-resize.spec.mjs - the floating assistant's corner, dragged in a real browser.
//
// WHAT THIS IS. The float is a window (`#assistant.is-floating`): its title row moves it and the split handle
// (`#as-split`, moved to the bottom-right corner by the stylesheet) sizes it. A reader who grabs that corner and
// drags it expects the corner to stay under the pointer and the frame to grow by exactly what the pointer travelled,
// and expects the frame it let go of to be the frame they get. This spec drives that gesture with real pointer
// events and measures the frame after every step, so the two failures a corner can have are named where they happen:
//
//   1. THE CORNER IS DEAD. `#assistant.is-floating .as-split` is drawn inside the float's rounded corner
//      (a 10px radius with `overflow: hidden` on the float, 9px on the handle itself), so the last few pixels of the
//      handle are clipped out of every hit area and a press there falls through to the board UNDER the window. The
//      reader grabs the grip, drags, and nothing resizes; the size never changes and the corner walks away from the
//      pointer by the whole step.
//   2. THE CORNER DOES NOT TRACK. Once the press does land on the handle, the frame has to grow by the pointer's own
//      travel - `width + dx`, `height + dy`, divided once by the page zoom - or the corner drifts away from the
//      cursor, which is the "jump" the reader sees: the frame grows by something other than the drag.
//
// Both are measured per step (the corner within 2px of the pointer, each dimension changed by the step), then after
// the release (the drawn frame is the last dragged frame, and the transcript has not scrolled out from under the
// reader, which is what a re-place or a re-render during the gesture would do).
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

// The one read every case below is a statement about: the float's border box, the handle's corner, the transcript's
// scroll position, and the zoom the styles write through.
const geometry = (page) =>
  page.evaluate(() => {
    const a = document.getElementById("assistant");
    const split = document.getElementById("as-split");
    const r = a.getBoundingClientRect();
    const h = split.getBoundingClientRect();
    const body = document.querySelector('#assistant [data-subpane="chat"] > .job > .job-body');
    return {
      box: { l: +r.left.toFixed(2), t: +r.top.toFixed(2), r: +r.right.toFixed(2), b: +r.bottom.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) },
      handle: { l: +h.left.toFixed(2), t: +h.top.toFixed(2), r: +h.right.toFixed(2), b: +h.bottom.toFixed(2), w: +h.width.toFixed(2), h: +h.height.toFixed(2) },
      floating: a.classList.contains("is-floating"),
      scrollTop: body ? body.scrollTop : null,
      zoom: parseFloat(getComputedStyle(document.documentElement).zoom) || 1,
    };
  });

it("a corner drag keeps the corner under the pointer and grows the float by the drag", async () => {
  seedTurns();
  panel = await startPanel({ dir, config: { assistant: { enabled: false }, fetchSeconds: -1, refreshSeconds: 3600 } });
  await post(panel.base, "/api/assistant/profile", { assistantId: "assistant-1", dock: "floating" });

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
  await page.waitForSelector('#assistant [data-subpane="chat"] .turn', { timeout: 30_000 });
  await page.waitForTimeout(400);

  const start = await geometry(page);
  assert.equal(start.floating, true, "the pane is drawn as the float");
  assert.ok(start.handle.w > 0 && start.handle.h > 0, `the split handle is on the page (${start.handle.w}x${start.handle.h})`);

  // Put the transcript somewhere a re-render would visibly move it.
  await page.evaluate(() => {
    const body = document.querySelector('#assistant [data-subpane="chat"] > .job > .job-body');
    body.scrollTop = Math.round((body.scrollHeight - body.clientHeight) / 2);
  });
  await page.waitForTimeout(120);
  const scrolled = await geometry(page);
  assert.ok(scrolled.scrollTop > 0, `the transcript is scrolled off its top (${scrolled.scrollTop}px)`);

  // The press: the corner of the grip, where a reader aims. One pixel in, so the point is inside the handle's box.
  const px = start.handle.r - 1;
  const py = start.handle.b - 1;
  await page.mouse.move(px, py);
  await page.mouse.down();

  let last = start;
  try {
    for (let i = 1; i <= STEPS; i += 1) {
      const cx = px + STEP * i;
      const cy = py + STEP * i;
      await page.mouse.move(cx, cy);
      await page.waitForTimeout(40);
      const now = await geometry(page);
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
      last = now;
    }
  } finally {
    await page.mouse.up();
  }

  await page.waitForTimeout(250);
  const released = await geometry(page);
  assert.ok(
    Math.abs(released.box.w - last.box.w) <= TOL && Math.abs(released.box.h - last.box.h) <= TOL,
    `the release draws the frame that was dragged (dragged ${last.box.w}x${last.box.h}, released ${released.box.w}x${released.box.h})`,
  );
  assert.ok(
    Math.abs(released.box.l - start.box.l) <= TOL && Math.abs(released.box.t - start.box.t) <= TOL,
    `the left and top edges did not move (${start.box.l},${start.box.t} -> ${released.box.l},${released.box.t})`,
  );
  assert.equal(released.scrollTop, scrolled.scrollTop, `the transcript kept its scroll position (${scrolled.scrollTop} -> ${released.scrollTop})`);
  assert.deepEqual(errors, [], "no page errors");
});
