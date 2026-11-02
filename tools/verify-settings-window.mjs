#!/usr/bin/env node
// The ⚙ Settings window moves and sizes: a drag on its head carries it, the corner grip resizes it, the rect is
// remembered in this browser, and the panel's own controls keep working the whole time.
//
//   node tools/verify-settings-window.mjs
//
// WHAT WAS WRONG. Settings was pinned: `position: fixed; right: 16px; top: 74px` in style.css and nothing in app.js
// wrote a rect, so a panel that covered the row the reader was reading could not be moved off it, and a long group
// could not be given more room than `max-height: calc(100vh - 90px)`. There was no grip in the markup and no pointer
// handler that could have used one.
//
// WHAT IS DRIVEN, on a sandbox panel of this checkout in a real Chromium:
//   * the ⚙ opens it anchored (right 16 / top 74 / 340 wide), and the corner grip is drawn, hittable and says
//     nwse-resize
//   * a drag on the head carries the rect by the pointer's own delta, and leaves no text selected behind it
//   * a press INSIDE #settings-search does not move the window: the box takes the focus, a query filters the rows,
//     a drag across the query selects it, and Esc clears it leaving the panel open
//   * a drag starting on a head button does not move the window either
//   * the grip resizes from the bottom-right: width and height follow the pointer, left and top stay put, and the
//     panel stops at 320 x 240
//   * a drag aimed outside the window leaves the whole rect inside the viewport, on all four sides
//   * the rect survives a reload, and a window that got smaller clamps it back inside on the way in
//   * Esc closes, an outside press closes, the ✕ closes, and a tab still switches the panel
//
// The browser half needs a Playwright install. Point the script at one with PANEL_PLAYWRIGHT_ROOT (a directory
// holding node_modules/playwright, or the package itself); without one it says BROWSER-HALF-NOT-RUN and exits 2
// rather than passing on a half that never ran. The live panel on :7331 is never touched.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const WIDE = { width: 1400, height: 900 };
const SMALL = { width: 900, height: 600 };
const MIN = { w: 320, h: 240 };
const EDGE = 8;
const KEY = "wtgui.settingsRect";

let failures = 0;
let checks = 0;
const check = (cond, label, detail = "") => {
  checks += 1;
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const note = (text) => console.log(`      ${text}`);
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;
const rectText = (r) => (r ? `${r.left},${r.top} ${r.width}x${r.height}` : "none");

// One read of everything this gate has an opinion about, so every case is a statement about the same numbers.
const read = (page) =>
  page.evaluate((key) => {
    const panel = document.getElementById("settings");
    const grip = document.getElementById("settings-grip");
    const box = panel ? panel.getBoundingClientRect() : null;
    const g = grip ? grip.getBoundingClientRect() : null;
    const rows = [...document.querySelectorAll("#settings .settings-row")];
    const shown = rows.filter((row) => row.getClientRects().length > 0);
    const search = document.getElementById("settings-search");
    return {
      rect: box ? { left: +box.left.toFixed(1), top: +box.top.toFixed(1), width: +box.width.toFixed(1), height: +box.height.toFixed(1) } : null,
      right: box ? +box.right.toFixed(1) : null,
      bottom: box ? +box.bottom.toFixed(1) : null,
      inline: panel
        ? { left: panel.style.left, top: panel.style.top, width: panel.style.width, height: panel.style.height, right: panel.style.right, maxHeight: panel.style.maxHeight }
        : null,
      open: Boolean(panel) && !panel.classList.contains("hidden"),
      grip: g
        ? { ...{ left: +g.left.toFixed(1), top: +g.top.toFixed(1), width: +g.width.toFixed(1), height: +g.height.toFixed(1) }, cursor: grip ? getComputedStyle(grip).cursor : "" }
        : null,
      stored: localStorage.getItem(key),
      rows: rows.length,
      shownRows: shown.length,
      query: search ? search.value : null,
      focus: document.activeElement ? document.activeElement.id : "",
      selection: search ? { start: search.selectionStart, end: search.selectionEnd } : null,
      pageSelection: String(window.getSelection() || ""),
      vw: document.documentElement.clientWidth,
      vh: document.documentElement.clientHeight,
      tabs: [...document.querySelectorAll("#settings [role='tab']")].map((t) => t.dataset.settingsTab),
      selected: [...document.querySelectorAll("#settings [role='tab']")].map((t) => t.getAttribute("aria-selected")),
      shownPanels: [...document.querySelectorAll("#settings .settings-group")].filter((p) => p.getClientRects().length > 0).map((p) => p.dataset.settingsGroup),
    };
  }, KEY);

// Press at `from`, walk to `to` in steps (a real drag, not a teleport: the panel follows pointermove), release.
const drag = async (page, from, to, steps = 8) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
  await page.waitForTimeout(90);
};

const openSettings = async (page) => {
  const open = await page.evaluate(() => !document.getElementById("settings").classList.contains("hidden"));
  if (!open) await page.click("#btn-settings");
  await page.waitForSelector("#settings:not(.hidden)", { timeout: 10_000 });
  await page.waitForTimeout(120);
};

const headPoint = (r) => ({ x: Math.round(r.left + 30), y: Math.round(r.top + 14) });
const gripPoint = (r) => ({ x: Math.round(r.left + r.width - 5), y: Math.round(r.top + r.height - 5) });

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the Settings window", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
    process.exit(2);
  }

  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-settings-window-"));
  const panel = await startPanel({ dir, config: { assistant: { enabled: false }, fetchSeconds: -1 } });
  try {
    console.log(`sandbox: ${panel.base}`);
    await withBrowser(
      async ({ page, pageErrors }) => {
        await page.setViewportSize(WIDE);
        await openPage(page, panel.base, { selector: "#btn-settings" });
        await page.waitForTimeout(250);
        await openSettings(page);

        // ---- A. the anchored panel, and a grip that is really there -----------------------------------------
        const anchored = await read(page);
        check(Boolean(anchored.rect), "the ⚙ opens Settings");
        check(anchored.rect && near(anchored.right, anchored.vw - 16, 0.5), "it opens anchored 16px from the window's right edge", `right ${anchored.right}, window ${anchored.vw}`);
        check(anchored.rect && near(anchored.rect.top, 74, 0.5), "and 74px from the top, under the top bar", `top ${anchored.rect?.top}`);
        check(anchored.rect && near(anchored.rect.width, 340, 0.5), "at its own 340px width", `width ${anchored.rect?.width}`);
        check(anchored.inline?.left === "", "nothing has written a rect yet: the stylesheet's rule is still the position");
        check(Boolean(anchored.grip) && anchored.grip.width >= 12 && anchored.grip.height >= 12, "the corner grip is drawn", anchored.grip ? `${anchored.grip.width}x${anchored.grip.height}` : "no #settings-grip");
        check(anchored.grip?.cursor === "nwse-resize", "and says it resizes from this corner", anchored.grip?.cursor);
        const onGrip = await page.evaluate(() => {
          const grip = document.getElementById("settings-grip");
          if (!grip) return false;
          const r = grip.getBoundingClientRect();
          const hit = document.elementFromPoint(r.right - 5, r.bottom - 5);
          return Boolean(hit && hit.id === "settings-grip");
        });
        check(onGrip, "a press at its corner lands on the grip, not on the panel's body");

        // ---- B. a drag on the head carries the window ----------------------------------------------------------
        const beforeMove = await read(page);
        await drag(page, headPoint(beforeMove.rect), { x: headPoint(beforeMove.rect).x - 120, y: headPoint(beforeMove.rect).y + 80 });
        const moved = await read(page);
        check(near(moved.rect.left, beforeMove.rect.left - 120) && near(moved.rect.top, beforeMove.rect.top + 80),
          "a drag on the head carries the window by the pointer's own delta",
          `${rectText(beforeMove.rect)} -> ${rectText(moved.rect)}`);
        check(near(moved.rect.width, beforeMove.rect.width, 0.5) && near(moved.rect.height, beforeMove.rect.height, 0.5),
          "and moves it without resizing it", `${beforeMove.rect.width}x${beforeMove.rect.height} -> ${moved.rect.width}x${moved.rect.height}`);
        check(moved.inline?.right === "auto" && moved.inline?.left !== "", "the anchored `right` is converted to explicit edges", JSON.stringify(moved.inline));
        check(moved.pageSelection === "", "the drag leaves no text selected behind it", JSON.stringify(moved.pageSelection));
        const stored = moved.stored ? JSON.parse(moved.stored) : null;
        check(Boolean(stored) && near(stored.x, moved.rect.left, 1) && near(stored.y, moved.rect.top, 1) && near(stored.w, moved.rect.width, 1) && near(stored.h, moved.rect.height, 1),
          `the rect is remembered under ${KEY}`, JSON.stringify(stored));

        // ---- C. the search box: a press in it is the box's, not the window's ----------------------------------
        const searchBox = await page.evaluate(() => {
          const b = document.getElementById("settings-search").getBoundingClientRect();
          return { left: b.left, right: b.right, top: b.top, height: b.height };
        });
        const inBox = { x: Math.round(searchBox.left + 30), y: Math.round(searchBox.top + searchBox.height / 2) };
        await drag(page, inBox, { x: inBox.x + 90, y: inBox.y + 70 });
        const afterBoxDrag = await read(page);
        check(near(afterBoxDrag.rect.left, moved.rect.left, 0.5) && near(afterBoxDrag.rect.top, moved.rect.top, 0.5),
          "a press inside #settings-search does NOT start a drag", `${rectText(moved.rect)} -> ${rectText(afterBoxDrag.rect)}`);
        check(afterBoxDrag.focus === "settings-search", "and the box takes the focus", afterBoxDrag.focus);

        await page.keyboard.type("font");
        await page.waitForTimeout(150);
        const filtered = await read(page);
        check(filtered.query === "font", "typing in the box filters the panel", `query ${JSON.stringify(filtered.query)}`);
        check(filtered.shownRows > 0 && filtered.shownRows < filtered.rows, "some rows match and the rest are hidden", `${filtered.shownRows}/${filtered.rows} rows`);
        note(`tabs: ${filtered.tabs.join(" / ")} — selected ${filtered.tabs.filter((k, i) => filtered.selected[i] === "true").join(",")}`);
        // A drag ACROSS the query selects it: the box is selectable, and that drag still does not move the window.
        const textBox = await page.evaluate(() => {
          const b = document.getElementById("settings-search").getBoundingClientRect();
          return { left: b.left, top: b.top, height: b.height, w: b.width };
        });
        await drag(page, { x: Math.round(textBox.left + 8), y: Math.round(textBox.top + textBox.height / 2) }, { x: Math.round(textBox.left + 34), y: Math.round(textBox.top + textBox.height / 2) }, 6);
        const selected = await read(page);
        check(selected.selection && selected.selection.end > selected.selection.start, "a drag across the query selects it", JSON.stringify(selected.selection));
        check(near(selected.rect.left, moved.rect.left, 0.5) && near(selected.rect.top, moved.rect.top, 0.5), "and that drag did not move the window either");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(150);
        const cleared = await read(page);
        check(cleared.query === "" && cleared.open, "Esc clears the box and leaves the panel open", `query ${JSON.stringify(cleared.query)}, open ${cleared.open}`);
        check(cleared.selected.filter((v) => v === "true").length === 1, "and exactly one tab is still selected", cleared.selected.join(","));

        // A drag that starts on a head BUTTON is the button's: the ✕ must not drag the panel. The rect is read while
        // the press is still held — a release away from the button is an outside press, which closes the panel by
        // design and would measure a hidden 0x0 box instead of the gesture.
        const beforeBtn = await read(page);
        const closeBtn = await page.evaluate(() => {
          const b = document.getElementById("btn-settings-close").getBoundingClientRect();
          return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
        });
        await page.mouse.move(closeBtn.x, closeBtn.y);
        await page.mouse.down();
        for (let i = 1; i <= 8; i += 1) await page.mouse.move(closeBtn.x + (80 * i) / 8, closeBtn.y + (60 * i) / 8);
        await page.waitForTimeout(60);
        const duringBtn = await read(page);
        check(near(duringBtn.rect.left, beforeBtn.rect.left, 0.5) && near(duringBtn.rect.top, beforeBtn.rect.top, 0.5),
          "a drag starting on a head button does not move the window", `${rectText(beforeBtn.rect)} -> ${rectText(duringBtn.rect)}`);
        check(duringBtn.open, "and it is still open under the press");
        await page.mouse.up();
        await page.waitForTimeout(120);
        await openSettings(page);

        // ---- D. the grip resizes from the bottom-right ---------------------------------------------------------
        const beforeSize = await read(page);
        await drag(page, gripPoint(beforeSize.rect), { x: gripPoint(beforeSize.rect).x + 60, y: gripPoint(beforeSize.rect).y + 40 });
        const sized = await read(page);
        check(near(sized.rect.width, beforeSize.rect.width + 60) && near(sized.rect.height, beforeSize.rect.height + 40),
          "a drag on the grip resizes the window by the pointer's own delta",
          `${beforeSize.rect.width}x${beforeSize.rect.height} -> ${sized.rect.width}x${sized.rect.height}`);
        check(near(sized.rect.left, beforeSize.rect.left, 0.5) && near(sized.rect.top, beforeSize.rect.top, 0.5),
          "from the corner: the left and top edges stay put", `${sized.rect.left},${sized.rect.top}`);

        // ---- E. the viewport is the limit ----------------------------------------------------------------------
        const beforeClamp = await read(page);
        const hp = headPoint(beforeClamp.rect);
        await drag(page, hp, { x: 1, y: 1 });
        const topLeft = await read(page);
        check(near(topLeft.rect.left, EDGE, 0.5) && near(topLeft.rect.top, EDGE, 0.5),
          "a drag aimed past the top-left leaves the window inside the viewport", `${rectText(topLeft.rect)}`);
        await drag(page, headPoint(topLeft.rect), { x: topLeft.vw - 1, y: topLeft.vh - 1 });
        const bottomRight = await read(page);
        check(near(bottomRight.right, bottomRight.vw - EDGE, 0.5) && near(bottomRight.bottom, bottomRight.vh - EDGE, 0.5),
          "and a drag past the bottom-right keeps it inside too", `right ${bottomRight.right}/${bottomRight.vw}, bottom ${bottomRight.bottom}/${bottomRight.vh}`);
        check(bottomRight.rect.left >= EDGE - 0.5 && bottomRight.rect.top >= EDGE - 0.5,
          "no edge of the window is ever left off the screen", `${rectText(bottomRight.rect)}`);

        // ---- F. the rect survives a reload ---------------------------------------------------------------------
        const kept = await read(page);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector("#btn-settings", { timeout: 30_000 });
        await page.waitForTimeout(200);
        await openSettings(page);
        const restored = await read(page);
        check(restored.rect && near(restored.rect.left, kept.rect.left, 1) && near(restored.rect.top, kept.rect.top, 1)
          && near(restored.rect.width, kept.rect.width, 1) && near(restored.rect.height, kept.rect.height, 1),
          "the window comes back where it was left after a reload", `${rectText(kept.rect)} -> ${rectText(restored.rect)}`);

        // ---- G. a smaller window clamps it back inside ----------------------------------------------------------
        await page.setViewportSize(SMALL);
        await page.waitForTimeout(300);
        const shrunk = await read(page);
        check(shrunk.rect && shrunk.rect.width <= shrunk.vw - 2 * EDGE + 0.5 && shrunk.rect.height <= shrunk.vh - 2 * EDGE + 0.5,
          "a window that got smaller shrinks the panel's rect rather than leaving it outside",
          `${rectText(shrunk.rect)} in ${shrunk.vw}x${shrunk.vh}`);
        check(shrunk.rect && shrunk.rect.left >= EDGE - 0.5 && shrunk.rect.top >= EDGE - 0.5 && shrunk.right <= shrunk.vw - EDGE + 0.5 && shrunk.bottom <= shrunk.vh - EDGE + 0.5,
          "with every edge still inside it", `left ${shrunk.rect?.left}, top ${shrunk.rect?.top}, right ${shrunk.right}, bottom ${shrunk.bottom}`);

        // ---- H. the floor ---------------------------------------------------------------------------------------
        await page.setViewportSize(WIDE);
        await page.waitForTimeout(300);
        await openSettings(page);
        const big = await read(page);
        const bigGrip = gripPoint(big.rect);
        await drag(page, bigGrip, { x: Math.max(1, bigGrip.x - 900), y: Math.max(1, bigGrip.y - 900) });
        const floor = await read(page);
        check(floor.rect && near(floor.rect.width, MIN.w, 0.5) && near(floor.rect.height, MIN.h, 0.5),
          `the grip stops at the panel's ${MIN.w} x ${MIN.h} minimum`, `${rectText(big.rect)} -> ${rectText(floor.rect)}`);

        // ---- I. the ways out still work -----------------------------------------------------------------------
        await page.keyboard.press("Escape");
        await page.waitForTimeout(120);
        const afterEsc = await read(page);
        check(!afterEsc.open, "Esc closes the window");
        await openSettings(page);
        await page.mouse.click(4, afterEsc.vh - 4);
        await page.waitForTimeout(150);
        const afterOutside = await read(page);
        check(!afterOutside.open, "a press outside it closes it");
        await openSettings(page);
        await page.click("#btn-settings-close");
        await page.waitForTimeout(120);
        const afterClose = await read(page);
        check(!afterClose.open, "and so does its ✕");
        await openSettings(page);

        // ---- J. the tab strip still switches -------------------------------------------------------------
        const tabbedBefore = await read(page);
        await page.click('[data-settings-tab="gateway"]');
        await page.waitForTimeout(180);
        const onGateway = await read(page);
        check(onGateway.shownPanels.length === 1 && onGateway.shownPanels[0] === "gateway",
          "a tab press shows that tab's panel, and only it", onGateway.shownPanels.join(","));
        check(onGateway.selected.filter((v) => v === "true").length === 1 && onGateway.selected[onGateway.tabs.indexOf("gateway")] === "true",
          "and marks that tab selected", onGateway.selected.join(","));
        check(onGateway.open, "while the panel stays open on the tab it switched to");
        await page.click('[data-settings-tab="display"]');
        await page.waitForTimeout(150);
        note(`the strip: ${tabbedBefore.tabs.length} tabs in markup order, ${tabbedBefore.shownPanels.length} panel shown`);

        // ---- K. the page zoom does not skew the gesture ---------------------------------------------------------
        // `getBoundingClientRect` and `clientX` are VISUAL px while a style length is LAYOUT px; a gesture that mixes
        // the two moves the window 1.1x (or 0.9x) as far as the pointer. 110% is the case that exposed it.
        await page.evaluate(() => window.applyZoom(110));
        await page.waitForTimeout(220);
        const zoomed = await read(page);
        const zoomHead = headPoint(zoomed.rect);
        await drag(page, zoomHead, { x: zoomHead.x - 60, y: zoomHead.y + 40 });
        const zoomedAfter = await read(page);
        check(near(zoomedAfter.rect.left, zoomed.rect.left - 60) && near(zoomedAfter.rect.top, zoomed.rect.top + 40),
          "at 110% zoom the window still tracks the pointer 1:1 (visual px in, layout px out)",
          `${rectText(zoomed.rect)} -> ${rectText(zoomedAfter.rect)}`);
        await page.evaluate(() => window.applyZoom(100));

        check(pageErrors.length === 0, "no uncaught page errors", pageErrors.join(" | "));
      },
      { viewport: WIDE, deviceScaleFactor: 1 },
    );
  } finally {
    await panel.stop();
  }

  console.log(`\n${failures === 0 ? "OK" : "FAILED"}  ${checks - failures}/${checks} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
