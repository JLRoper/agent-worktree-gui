#!/usr/bin/env node
// The red banner FLOATS under the sticky topbar: it is pinned there, it moves nothing on the board, and it never
// covers the docked rail.
//
//   node tools/verify-banner-float.mjs
//
// WHAT WAS WRONG. `#banner` was a block between the settings popover and `.shell`, so every message was a new row
// in the page: the board dropped by the bar's height (measured ~35px) the moment a failure appeared, and came back
// up when the next snapshot hid it. A red banner also had no way to be dismissed — the panel's own poll took it away
// — and a green one appeared and vanished with no transition at all.
//
// NOW. The banner is a fixed layer under the topbar. Its top is the topbar's MEASURED height (the header wraps to a
// second row on a narrow window, so a constant would be wrong at one of the two widths this gate drives) and its
// sides are the board's own column, which is what keeps the docked rail uncovered. The layer takes no press at all
// and the bar inside it takes its own, so a floating bar never eats a click meant for the board. A red failure stays
// until its ✕; a green confirmation carries no ✕ and takes itself away after four seconds; both fade in.
//
// WHAT IS DRIVEN, on a panel of this checkout (throwaway config, store, HERMES_HOME and port) in a real Chromium:
//   * at 1954px with the rail closed: the layer is fixed, its top is the topbar's bottom edge, the bar sits inside
//     the board's column, the board's first section does not move when it appears (rect and scrollHeight, before and
//     after), the layer's own box does not take a press, the red bar survives five seconds, its ✕ dismisses it, and
//     the green one is still there at 3.5s and gone by 4.6s
//   * at 1954px with the rail open: the bar re-places itself against the narrower column without being re-shown, and
//     the rail is what a press at its own centre lands on
//   * at 1280px with the rail open: the topbar's measured height has changed (it wraps), the bar follows it, the rail
//     is still unobstructed, and the board still does not move
//
// The browser half needs a Playwright install. Point the script at one with PANEL_PLAYWRIGHT_ROOT (a directory holding
// node_modules/playwright, or the package itself); without one it says BROWSER-HALF-NOT-RUN and exits 2 rather than
// passing on a half that never ran. The live panel on :7331 is never touched.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, notRun, openPage, stubEventSourceInit, withBrowser } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const WIDE = { width: 1954, height: 1080 };
const NARROW = { width: 1280, height: 900 };
const RED = "probe: the board could not be re-read";

let failures = 0;
let checks = 0;
const check = (cond, label, detail = "") => {
  checks += 1;
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const note = (text) => console.log(`      ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One read of everything this gate has an opinion about, so every case is a statement about the same numbers.
const read = (page) =>
  page.evaluate(() => {
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { top: +r.top.toFixed(1), left: +r.left.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) };
    };
    const cs = (el) => getComputedStyle(el);
    const layer = document.getElementById("banner-layer");
    const b = document.getElementById("banner");
    const x = b ? b.querySelector(".banner-x") : null;
    const rail = document.getElementById("assistant");
    return {
      layer: layer ? { ...rect(layer), position: cs(layer).position, pe: cs(layer).pointerEvents } : null,
      banner: b
        ? {
            ...rect(b),
            display: cs(b).display,
            pe: cs(b).pointerEvents,
            ok: b.classList.contains("ok"),
            anim: cs(b).animationName,
            dur: cs(b).animationDuration,
            text: (document.getElementById("banner-text") || {}).textContent || "",
            x: x ? { hidden: x.hidden, display: cs(x).display, ...rect(x) } : null,
          }
        : null,
      bar: rect(document.querySelector(".topbar")),
      main: rect(document.querySelector(".shell > main")),
      rail: rail && !rail.hidden ? rect(rail) : null,
      agents: rect(document.getElementById("agents")),
      projects: rect(document.getElementById("projects")),
      scrollH: document.scrollingElement.scrollHeight,
      vw: document.documentElement.clientWidth,
    };
  });

const showRed = (page, msg = RED) => page.evaluate((m) => window.showBanner(m), msg);
const showGreen = (page, msg) => page.evaluate((m) => window.showNote(m), msg);
// Press the red bar's ✕. A page without one is a FAIL the summary can count, not a 30s Playwright timeout.
const dismiss = async (page) => {
  if (!(await page.locator("#banner .banner-x").count())) return false;
  await page.click("#banner .banner-x");
  await page.waitForTimeout(120);
  return true;
};
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

// Is the point a press at (x, y) would land on inside the given element?
const hits = (page, x, y, selector) =>
  page.evaluate(
    ([px, py, sel]) => {
      const el = document.elementFromPoint(px, py);
      return Boolean(el && el.closest(sel));
    },
    [x, y, selector],
  );

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the floating banner", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
    process.exit(2);
  }

  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-banner-"));
  const panel = await startPanel({ dir, config: { assistant: { enabled: false }, fetchSeconds: -1 } });
  try {
    console.log(`sandbox: ${panel.base}`);
    await withBrowser(
      async ({ page, withPage, pageErrors }) => {
        // ---- 1. 1954px, rail closed: pinned under the topbar, and the board does not move -------------------
        await page.setViewportSize(WIDE);
        // The stream is inert so no snapshot can clear the green note while its four seconds are being measured;
        // the board itself is painted by the boot `resync()` from the real server.
        await openPage(page, panel.base, { selector: "#btn-assistant" });
        await page.addInitScript(stubEventSourceInit);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector("#health.ok", { timeout: 30_000 });
        await page.waitForSelector("#projects > *", { timeout: 30_000 });
        await page.waitForTimeout(250);

        const before = await read(page);
        check(Boolean(before.layer), "the banner has a layer of its own", before.layer ? "" : "no #banner-layer in the page");
        check(before.layer && before.layer.position === "fixed", "the layer is out of the flow (position: fixed)", before.layer ? before.layer.position : "absent");
        check(before.banner && before.banner.display === "none", "the bar starts hidden");
        const wideBar = before.bar.height;

        await showRed(page);
        await page.waitForTimeout(220); // past the 140ms fade
        const after = await read(page);

        check(after.banner && after.banner.display !== "none", "showBanner puts the red bar on screen");
        check(after.banner && !after.banner.ok, "and it is the red one (no .ok)");
        check(after.banner && after.banner.text === RED, "the message is the one that was asked for", after.banner ? JSON.stringify(after.banner.text) : "");
        check(near(after.layer?.top ?? -1, after.bar.bottom), "the layer is pinned at the topbar's measured bottom edge", `layer top ${after.layer?.top}, topbar bottom ${after.bar.bottom}, topbar height ${after.bar.height}`);
        check((after.banner?.top ?? -1) >= after.bar.bottom, "the bar's own rect sits below the topbar, never over it", `bar top ${after.banner?.top}, topbar bottom ${after.bar.bottom}`);
        check(near((after.banner?.left ?? -1), after.main.left + 16) && near((after.banner?.right ?? -1), after.main.right - 16),
          "and spans the board's column (16px in from each edge)", `bar ${after.banner?.left}..${after.banner?.right}, board ${after.main.left}..${after.main.right}`);
        check(after.layer?.pe === "none", "the layer takes no press at all", after.layer?.pe);
        check(after.banner?.pe === "auto", "the bar inside it takes its own", after.banner?.pe);
        check(after.banner?.anim === "banner-in" && parseFloat(after.banner?.dur) > 0, "the red bar fades in rather than jumping", `${after.banner?.anim} ${after.banner?.dur}`);
        check(after.banner?.x && !after.banner.x.hidden && after.banner.x.display !== "none" && after.banner.x.width > 0,
          "the red bar carries its ✕", after.banner?.x ? `${after.banner.x.width}x${after.banner.x.height} at ${after.banner.x.left},${after.banner.x.top}` : "no ✕");

        // ZERO REFLOW: the board's first section, the projects container and the page's height are the same numbers.
        check(near(after.agents.top, before.agents.top, 0.5) && near(after.projects.top, before.projects.top, 0.5) && after.scrollH === before.scrollH,
          "the board does not move when the bar appears",
          `agents ${before.agents.top}->${after.agents.top}, projects ${before.projects.top}->${after.projects.top}, page ${before.scrollH}->${after.scrollH}`);

        // The layer's own box must not eat a press meant for the board: a point in its margin belongs to the page.
        const swallowed = after.layer ? await hits(page, after.layer.left + 4, after.banner.top + 4, "#banner-layer") : true;
        check(!swallowed, "a press in the layer's margin falls through to the board");

        // A second message updates the text and leaves the ✕ in place (the old code wrote textContent over it).
        await showRed(page, "probe: a second failure");
        const second = await read(page);
        check(second.banner.text === "probe: a second failure" && second.banner.x && !second.banner.x.hidden,
          "a second message rewrites the text and keeps the ✕");

        // RED PERSISTS: no timer, and a snapshot does not clear it (the stream is inert here; the ✕ is the only way out).
        await sleep(4600);
        const held = await read(page);
        check(held.banner.display !== "none", "the red bar is still there after 4.6s", `display ${held.banner.display}`);

        const pressed = await dismiss(page);
        const dismissed = await read(page);
        check(pressed && dismissed.banner.display === "none", "its ✕ dismisses it");

        // GREEN: no ✕, and it takes itself away at four seconds.
        await showGreen(page, "probe: a green confirmation");
        await page.waitForTimeout(220);
        const green = await read(page);
        check(green.banner.display !== "none" && green.banner.ok, "showNote puts the green bar on screen");
        check(green.banner.x && green.banner.x.display === "none", "the green one carries no ✕");
        check(green.banner.anim === "banner-in" && parseFloat(green.banner.dur) > 0, "the green bar fades in too", `${green.banner.anim} ${green.banner.dur}`);
        check(near(green.agents.top, before.agents.top, 0.5), "and it does not move the board either", `agents ${before.agents.top}->${green.agents.top}`);
        await sleep(3300);
        const greenHeld = await read(page);
        check(greenHeld.banner.display !== "none", "the green bar is still there at 3.5s");
        await sleep(1100);
        const greenGone = await read(page);
        check(greenGone.banner.display === "none", "and gone by 4.6s");

        // ---- 2. 1954px, rail OPEN: the bar re-places itself and never covers the rail -------------------------
        await showRed(page, "probe: the rail is open");
        await page.waitForTimeout(150);
        const closedRail = await read(page);
        await page.click("#btn-assistant");
        await page.waitForSelector("#assistant", { state: "visible", timeout: 10_000 });
        await page.waitForTimeout(350);
        const openRail = await read(page);
        check(Boolean(openRail.rail), "the rail opened");
        check(near(openRail.main.right, openRail.rail.left), "the board's right edge is the rail's left edge", `board ends ${openRail.main.right}, rail starts ${openRail.rail.left}`);
        check(openRail.banner.right <= openRail.rail.left + 0.5,
          "the bar stops at the rail without being re-shown (the column is re-measured)", `bar ends ${openRail.banner.right}, rail starts ${openRail.rail.left}`);
        check(closedRail.banner.right > openRail.banner.right, "and it is narrower than it was with the rail closed", `${closedRail.banner.right} -> ${openRail.banner.right}`);
        const railHit = await hits(page, openRail.rail.left + openRail.rail.width / 2, openRail.rail.top + 80, "#assistant");
        check(railHit, "a press in the middle of the rail lands on the rail, not on the banner");

        // ---- 3. 1280px, rail open: the topbar wraps, so the top has to be re-measured -------------------------
        await page.setViewportSize(NARROW);
        await page.waitForTimeout(400);
        const narrow = await read(page);
        note(`topbar height: ${wideBar}px at ${WIDE.width}, ${narrow.bar.height}px at ${NARROW.width}`);
        check(narrow.bar.height > wideBar, "the topbar wraps at the narrow width (its height is not a constant)", `${wideBar} -> ${narrow.bar.height}`);
        check(near(narrow.layer?.top ?? -1, narrow.bar.bottom), "the layer follows the measured height at 1280", `layer top ${narrow.layer?.top}, topbar bottom ${narrow.bar.bottom}`);
        check((narrow.banner?.top ?? -1) >= narrow.bar.bottom, "the bar is still below the topbar", `bar top ${narrow.banner?.top}`);
        check(near((narrow.banner?.left ?? -1), narrow.main.left + 16) && (narrow.banner?.right ?? 1e9) <= (narrow.rail ? narrow.rail.left : narrow.vw) + 0.5,
          "and still inside the board's column, clear of the rail", `bar ${narrow.banner?.left}..${narrow.banner?.right}, rail ${narrow.rail ? narrow.rail.left : "closed"}`);
        const narrowRailHit = narrow.rail ? await hits(page, narrow.rail.left + narrow.rail.width / 2, narrow.rail.top + 80, "#assistant") : false;
        check(narrowRailHit, "the rail is unobstructed at 1280 too");

        // ZERO REFLOW again, at the narrow width with the rail open.
        await dismiss(page);
        const noBanner = await read(page);
        await showRed(page, "probe: narrow width");
        await page.waitForTimeout(200);
        const narrowAfter = await read(page);
        check(noBanner.banner.display === "none" && near(narrowAfter.agents.top, noBanner.agents.top, 0.5) && narrowAfter.scrollH === noBanner.scrollH,
          "the board does not move at 1280 with the rail open",
          `agents ${noBanner.agents.top}->${narrowAfter.agents.top}, page ${noBanner.scrollH}->${narrowAfter.scrollH}`);

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
