// test/e2e/deliverables-window.spec.mjs — the DELIVERABLES panel as a WINDOW: where it opens, how it moves, how it
// resizes, and what it remembers. Driven in headless Chromium on a throwaway panel, measured from the RENDERED box
// model (`getBoundingClientRect`), and every assertion prints the rectangle it judged.
//
//   RUN   node --test --test-reporter=spec test/e2e/deliverables-window.spec.mjs
//         npm run test:e2e:deliverables-window
//
//         DELIVERABLES_WINDOW_SHOTS=<dir>   where the screenshot goes (default: <tmp>/wtgui-deliverables-window-shots)
//
// WHAT WAS WRONG. The panel opened off the right of the window. `deliverPosition()` measured the button with
// `getBoundingClientRect()` (VISUAL px) and the panel with `offsetWidth` (LAYOUT px), then wrote the answer into
// `style.left` (LAYOUT px) and clamped all of it against `window.innerWidth` (VISUAL px). One rule, three units. With
// the panel's own page zoom at 130% the button's visual right is 1.3x its layout one, so the panel landed 1.3x too
// far right; the clamp could not hold it, because it subtracted a 560 layout width from a 1280 visual viewport while
// the drawn width was 728. Nothing clamped `top` either, and nothing re-clamped the SIZE — so the panel's foot was
// below the window on a short one, and a narrowed window left it hanging off the edge. It was also fixed in size and
// fixed in place: no drag, no resize, nothing remembered.
//
// WHAT THE PANEL PROMISES NOW, and where each case measures it:
//
//   1. OPEN IS INSIDE   the first open is fully inside the viewport with the margin on every side, and covers a sane
//                       share of it. Asserted at 1440x900 (100%) AND at 1280x800 with the page zoom at 130%, which is
//                       the window-and-zoom pair the defect was measured in: there the old rule opened the panel at
//                       {left:500 top:135 right:1228 bottom:863} in an 800 px window — 63 px of it below the glass —
//                       and at 200% in a 1440 px window it measured {left:724 top:402} 1120x1260: 404 px past the
//                       right edge and 762 px past the bottom.
//   2. HEAD DRAGS       a 200 px press on the header bar moves the panel by 200 px and it is still inside.
//   3. EDGES CLAMP      a drag to (0,0) stops at the margin; a drag past the bottom-right stops at the margin; the
//                       panel is never pushed out by the gesture, it is stopped.
//   4. BODY IS NOT A HANDLE  a press-and-move on the list body moves NOTHING — the body is where text is selected and
//                       the list scrolls.
//   5. RESIZE           the corner handle grows and shrinks the panel; a huge drag is capped at max (900x820) and a
//                       backwards one at min (320x180), and the panel stays inside while it is being sized.
//   6. IT REMEMBERS     the dragged and resized rectangle survives a reload; a stored rectangle that no longer fits
//                       the window is dropped, so the next open is the default under the button.
//   7. THE DOORS STILL WORK   the close button still closes and hands focus back to #btn-deliver, and the panel still
//                       lists the store's rows (the list itself is not this spec's subject — that is
//                       tools/verify-deliverables-ui.mjs — but a window that stopped listing is not a window either).
//
// A FAILING CASE IS A FAILURE, NOT A TEST TO RE-AIM. If a case disagrees with the panel, the panel is what the report
// is about; the assertion is not made to fit. The button's own zero-movement contract is NOT asserted here: it is
// tools/verify-deliverables-stable.mjs, and it stays the gate for it.
//
// Exit is node:test's: 0 when every case passed, 1 when one failed, and the summary line counts them.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { attachPageCollectors, loadPlaywright } from "../../tools/browser.mjs";
import { startPanel } from "../../tools/panel-testkit.mjs";
import { Deliverables } from "../../lib/deliverables.js";

// The reader's own panel. This run must never bind it, and never write its store.
const LIVE_PORT = 7331;

const PW = loadPlaywright();
const SKIP = PW ? null : "BROWSER-HALF-NOT-RUN: no Playwright install found (set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright)";
const it = (name, fn) => (PW ? test(name, fn) : test(name, { skip: SKIP }, () => {}));

const SHOTS = process.env.DELIVERABLES_WINDOW_SHOTS || path.join(os.tmpdir(), "wtgui-deliverables-window-shots");
const MARGIN = 8; // DL_MARGIN in public/app.js: every side of the viewport keeps this
const ROWS = 14;

// ---- the fixture: a real store, seeded through the same seam the panel reads --------------------------------------
const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-deliver-window-"));
const tree = path.join(dir, "repos", "agent-worktree-gui", ".worktrees", "wtgui-deliver-window");
const STORE = path.join(dir, "logs", "deliverables.json");
mkdirSync(path.join(tree, "docs"), { recursive: true });
mkdirSync(path.join(dir, "logs"), { recursive: true });
mkdirSync(SHOTS, { recursive: true });

const store = new Deliverables({ file: STORE, log: () => {} });
for (let i = 1; i <= ROWS; i += 1) {
  writeFileSync(path.join(tree, "docs", `report-${i}.md`), `# report ${i}\n`);
  store.record({
    job: { id: `job${i}`, thread: `wtgui-report-${i}`, turn: i, project: "agent-worktree-gui", worktreePath: tree, branch: `wtgui/report-${i}` },
    tree: { path: tree, branch: `wtgui/report-${i}` },
    finalText: `DELIVER file docs/report-${i}.md | Report ${i}`,
    agent: "deliver-window",
    now: Date.now() - i * 60_000,
  });
}

let panel = null;
let browser = null;
const contexts = [];

const openPage = async ({ width, height, zoom = 100 }) => {
  const ctx = await browser.newContext({ viewport: { width, height } });
  contexts.push(ctx);
  if (zoom !== 100) {
    // The panel's own zoom is remembered in localStorage (`wtgui.zoom`), so a fresh context is made to remember it
    // before the first script runs: that is exactly how a reader's zoom meets a panel they did not resize.
    await ctx.addInitScript((z) => {
      try { localStorage.setItem("wtgui.zoom", String(z)); } catch { /* private mode */ }
    }, zoom);
  } else {
    await ctx.addInitScript(() => {
      try { localStorage.removeItem("wtgui.zoom"); } catch { /* private mode */ }
    });
  }
  const page = await ctx.newPage();
  const errors = attachPageCollectors(page);
  await page.goto(panel.base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#btn-deliver");
  await page.waitForTimeout(500); // the header's own clocks settle; nothing here reads the clock
  return { ctx, page, errors };
};

// ---- the reads -----------------------------------------------------------------------------------------------------
const RECT = () => {
  const pop = document.getElementById("deliver-pop");
  const r = pop.getBoundingClientRect();
  const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  return {
    left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom),
    width: Math.round(r.width), height: Math.round(r.height),
    vw: window.innerWidth, vh: window.innerHeight, zoom: z,
  };
};
const read = (page) => page.evaluate(RECT);
const line = (what, r) => `      ${what.padEnd(12)} {left:${r.left} top:${r.top} right:${r.right} bottom:${r.bottom}} ${r.width}x${r.height} in ${r.vw}x${r.vh} (zoom ${r.zoom})`;
const inside = (r, m = MARGIN) => r.left >= m && r.top >= m && r.right <= r.vw - m && r.bottom <= r.vh - m;
const share = (r) => (r.width * r.height) / (r.vw * r.vh);

const openPop = async (page) => {
  await page.click("#btn-deliver");
  await page.waitForSelector("#deliver-pop:not([hidden])");
  await page.waitForTimeout(250); // the list paints from the store on the next frame
};

const drag = async (page, from, to) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(60);
};

const headPoint = async (page, dx = 40) => {
  const h = await page.locator("#deliver-pop .dl-head").boundingBox();
  return { x: Math.round(h.x + dx), y: Math.round(h.y + h.height / 2) };
};

before(async () => {
  if (!PW) return;
  panel = await startPanel({ dir, config: { assistant: { enabled: false } } });
  assert.notEqual(Number(new URL(panel.base).port), LIVE_PORT, "the throwaway panel must not bind the reader's panel");
  console.log(`      panel   ${panel.base}  (throwaway: ${panel.dir})`);
  browser = await PW.chromium.launch();
});

after(async () => {
  for (const ctx of contexts) await ctx.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (panel) await panel.stop().catch(() => {});
});

// ---- 1. the first open is a rectangle the reader can see ------------------------------------------------------------
it("1. the first open is fully inside the viewport and covers a sane share of it", async () => {
  const { page } = await openPage({ width: 1440, height: 900 });
  await openPop(page);
  const r = await read(page);
  console.log(line("open 1440", r));
  assert.ok(inside(r), `the panel is not inside the viewport: ${JSON.stringify(r)}`);
  assert.ok(r.width >= Math.round(r.vw * 0.3), `the panel is a sliver: ${r.width}px of ${r.vw}`);
  assert.ok(share(r) >= 0.2, `the panel covers ${(share(r) * 100).toFixed(1)}% of the window`);
  await page.screenshot({ path: path.join(SHOTS, "deliverables-window-open.png") });

  // The same promise in the window-and-zoom pair the defect was measured in: a narrowed window whose page zoom is
  // remembered at 130%. The old rule put this panel's foot at y=832 in an 800 px window.
  const zoomed = await openPage({ width: 1280, height: 800, zoom: 130 });
  await openPop(zoomed.page);
  const z = await read(zoomed.page);
  console.log(line("open 1280@130", z));
  assert.ok(inside(z), `the zoomed panel is not inside the viewport: ${JSON.stringify(z)}`);
  assert.ok(share(z) >= 0.2, `the zoomed panel covers ${(share(z) * 100).toFixed(1)}% of the window`);
  await zoomed.page.screenshot({ path: path.join(SHOTS, "deliverables-window-open-zoom-130.png") });
});

// ---- 2. the head drags ---------------------------------------------------------------------------------------------
it("2. a 200 px drag of the header moves the panel 200 px and keeps it inside", async () => {
  const { page } = await openPage({ width: 1440, height: 900 });
  await openPop(page);
  const before = await read(page);
  console.log(line("before drag", before));
  const from = await headPoint(page);
  await drag(page, from, { x: from.x + 200, y: from.y + 40 });
  const after = await read(page);
  console.log(line("after +200", after));
  assert.equal(after.left - before.left, 200, "the panel did not follow the pointer");
  assert.equal(after.top - before.top, 40, "the panel did not follow the pointer");
  assert.ok(inside(after), `the dragged panel left the viewport: ${JSON.stringify(after)}`);
  assert.equal(after.width, before.width, "a drag resized the panel");
  assert.equal(after.height, before.height, "a drag resized the panel");
});

// ---- 3. the edges clamp, they do not push it out -------------------------------------------------------------------
it("3. a hard drag at each edge is clamped, not pushed out", async () => {
  const { page } = await openPage({ width: 1440, height: 900 });
  await openPop(page);
  const start = await read(page);
  console.log(line("start", start));

  // top-left: the pointer goes PAST the corner; the panel must stop with the margin showing.
  await drag(page, await headPoint(page), { x: 2, y: 2 });
  const tl = await read(page);
  console.log(line("to top-left", tl));
  assert.equal(tl.left, MARGIN, `the left edge was not clamped: ${JSON.stringify(tl)}`);
  assert.equal(tl.top, MARGIN, `the top edge was not clamped: ${JSON.stringify(tl)}`);

  // bottom-right: the panel's own bottom-right corner must stop with the margin showing, not off the window.
  await drag(page, await headPoint(page), { x: 1438, y: 898 });
  const br = await read(page);
  console.log(line("to bot-right", br));
  assert.equal(br.right, 1440 - MARGIN, `the right edge was not clamped: ${JSON.stringify(br)}`);
  assert.equal(br.bottom, 900 - MARGIN, `the bottom edge was not clamped: ${JSON.stringify(br)}`);
  assert.equal(br.width, start.width, "an edge drag resized the panel");
  assert.equal(br.height, start.height, "an edge drag resized the panel");
});

// ---- 4. the body is not a handle -----------------------------------------------------------------------------------
it("4. a press-and-move on the list body moves nothing and does not lose the list", async () => {
  const { page } = await openPage({ width: 1440, height: 900 });
  await openPop(page);
  const before = await read(page);
  const row = await page.locator("#deliver-pop .dl-row").first().boundingBox();
  // A press that starts on a row and travels is a text selection, not a window drag. (The row's own click handler may
  // open the agent, which is why this press is released far to the left of where it started: no click.)
  await page.mouse.move(row.x + 120, row.y + row.height / 2);
  await page.mouse.down();
  await page.mouse.move(row.x + 420, row.y + 260, { steps: 10 });
  const during = await read(page);
  console.log(line("during body", during));
  assert.deepEqual(during, before, "a press on the body dragged the window");
  await page.mouse.up();
  await page.waitForTimeout(80);
  const after = await read(page);
  console.log(line("after body", after));
  assert.deepEqual(after, before, "a press on the body moved the window");
  assert.ok(await page.locator("#deliver-pop .dl-row").count() >= ROWS, "the list lost its rows");
});

// ---- 5. resize: grew, shrunk, and capped at both ends --------------------------------------------------------------
it("5. the corner handle resizes within min and max and never leaves the window", async () => {
  const { page } = await openPage({ width: 1440, height: 900 });
  await openPop(page);
  const open = await read(page);
  console.log(line("open", open));

  const grip = async () => {
    const g = await page.locator("#dl-resize").boundingBox();
    return { x: Math.round(g.x + g.width / 2), y: Math.round(g.y + g.height / 2) };
  };

  // smaller by 160x120
  let g = await grip();
  await drag(page, g, { x: g.x - 160, y: g.y - 120 });
  const small = await read(page);
  console.log(line("resized -", small));
  assert.equal(small.width, open.width - 160, "the width did not follow the handle");
  assert.equal(small.height, open.height - 120, "the height did not follow the handle");

  // much bigger: the handle is dragged far past the corner, and the panel stops at its max, still inside
  g = await grip();
  await drag(page, g, { x: g.x + 1200, y: g.y + 1200 });
  const big = await read(page);
  console.log(line("resized max", big));
  assert.ok(big.width <= 900, `the width passed its max: ${big.width}`);
  assert.ok(big.height <= 820, `the height passed its max: ${big.height}`);
  assert.ok(big.width > small.width && big.height > small.height, "the panel did not grow");
  assert.ok(inside(big), `the resized panel left the viewport: ${JSON.stringify(big)}`);

  // far backwards: the panel stops at its min and is still a panel, not a line
  g = await grip();
  await drag(page, g, { x: g.x - 1200, y: g.y - 1200 });
  const min = await read(page);
  console.log(line("resized min", min));
  assert.equal(min.width, 320, `the width passed its min: ${min.width}`);
  assert.equal(min.height, 180, `the height passed its min: ${min.height}`);
  assert.ok(inside(min), `the shrunk panel left the viewport: ${JSON.stringify(min)}`);
});

// ---- 6. it remembers, and forgets what no longer fits ---------------------------------------------------------------
it("6. the dragged rectangle survives a reload, and one that no longer fits is dropped", async () => {
  const { page } = await openPage({ width: 1440, height: 900 });
  await openPop(page);
  await drag(page, await headPoint(page), { x: 700, y: 300 });
  const grip = await page.locator("#dl-resize").boundingBox();
  await drag(page, { x: grip.x + 8, y: grip.y + 8 }, { x: grip.x + 8 - 120, y: grip.y + 8 - 90 });
  const chosen = await read(page);
  console.log(line("chosen", chosen));
  const stored = await page.evaluate(() => localStorage.getItem("wtgui.deliverables.rect"));
  console.log(`      stored       ${stored}`);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#btn-deliver");
  await page.waitForTimeout(400);
  await openPop(page);
  const again = await read(page);
  console.log(line("after reload", again));
  assert.deepEqual(
    { left: again.left, top: again.top, width: again.width, height: again.height },
    { left: chosen.left, top: chosen.top, width: chosen.width, height: chosen.height },
    "the panel did not come back where it was left",
  );

  // Now the window is narrowed under the remembered rectangle: it no longer fits, so the panel does not clamp it
  // quietly onto the new screen — it opens at the default under the button, fully inside.
  await page.setViewportSize({ width: 900, height: 620 });
  await page.waitForTimeout(200);
  const live = await read(page);
  console.log(line("narrowed live", live));
  assert.ok(inside(live), `the panel hung out of the narrowed window: ${JSON.stringify(live)}`);
  await page.evaluate(() => document.getElementById("btn-deliver").click());
  await page.waitForTimeout(120); // close
  await page.evaluate(() => document.getElementById("btn-deliver").click());
  await page.waitForTimeout(250);
  const reopened = await read(page);
  console.log(line("narrow reopen", reopened));
  assert.ok(inside(reopened), `the reopened panel is not inside the narrowed window: ${JSON.stringify(reopened)}`);
  assert.equal(await page.evaluate(() => localStorage.getItem("wtgui.deliverables.rect")), null, "a rectangle that no longer fits was kept");
});

// ---- 7. the close button and the list still do their jobs -----------------------------------------------------------
it("7. the close button still closes and hands focus back to the button", async () => {
  const { page, errors } = await openPage({ width: 1440, height: 900 });
  await openPop(page);
  assert.equal(await page.locator("#deliver-pop .dl-row").count(), ROWS, "the popup stopped listing the store's rows");
  assert.equal(await page.locator("#btn-deliver").getAttribute("aria-expanded"), "true");
  await page.click("#dl-close");
  await page.waitForTimeout(120);
  assert.equal(await page.locator("#deliver-pop").isHidden(), true, "the close button did not close the panel");
  assert.equal(await page.locator("#btn-deliver").getAttribute("aria-expanded"), "false");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "btn-deliver", "focus did not go back to the button");
  assert.deepEqual(errors.pageErrors, [], "the page threw");
});
