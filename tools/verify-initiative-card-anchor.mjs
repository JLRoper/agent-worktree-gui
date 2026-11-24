#!/usr/bin/env node
// THE INITIATIVE CARD'S DOTS, ITS TITLE, AND ITS COLOUR.
//
// HARNESS: LIVE GATE
//
//   node tools/verify-initiative-card-anchor.mjs [--shots <dir>] [--home <dir>]
//
// WHAT THIS GATE PROVES. The reader asked for three things on the one card, and each of them has a
// wrong answer that still looks right in a screenshot, so every claim below is measured on the painted
// page and never read out of the source:
//
//   1. THE DOTS SHARE THE TITLE'S LINE. On a folded card the route mark hangs in a fixed gutter left of
//      the title, and every dot's centre is on the title's FIRST line box centre - not 6px above it, as
//      the absolute `top` did. The gutter and the dot-to-title distance are the same on every folded row
//      that has a route, so one reading edge runs down the ledger.
//   2. THE TITLE DOES NOT JUMP ON EXPAND. The title's x and y INSIDE ITS OWN CARD are identical folded
//      and open, at two card widths (a 480px dock and a 720px one, measured, not assumed). The dots stay
//      drawn when the card opens, in their own order and with their own colours, because they are what
//      the gutter is for. This is the check the row asked for: a measured x and y, at more than one
//      width, never an eyeball.
//   3. ONE INITIATIVE CARRIES A THEME COLOUR. Ctrl+click on the dot column or the title rolls a hue onto
//      that card by the project boxes' own rule, Shift+click drops it, Ctrl+click does not fold the card,
//      the dots keep their own colours and order, the choice survives a reload through the same
//      localStorage key shape a project's does, and a browser with no storage still gets the colour for
//      this tab only. The projects' own Ctrl+click is measured beside it and must be unchanged.
//
// Sandbox only: the initiatives fixture (three throwaway repos, four initiatives, a wave store) boots
// `server.js` with WAG_HOME under the caller's scratch. The reader's ~/.wag and the live 7331 listener
// are never read or written. Without Playwright the script says BROWSER-NOT-RUN and exits 2 rather than
// passing a half that never ran.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { buildFixture, defaultHome, startFixturePanel, waitForFixtureRows, waitForInitiativesView } from "./initiatives-fixture.mjs";

const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 300_000);
const watchdog = setTimeout(() => {
  try {
    process.stderr.write(`WATCHDOG: ${WATCHDOG_MS}ms elapsed without the run finishing - see the last line printed above.\n`);
  } catch {
    /* nothing left to do */
  }
  process.exit(1);
}, WATCHDOG_MS);

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const HOME = path.resolve(opt("--home", defaultHome()));
const SHOTS = path.resolve(opt("--shots", path.join(HOME, "shots")));

let failures = 0;
let checks = 0;
const check = (name, got, want) => {
  checks += 1;
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` - ${extra}` : ""}`);
  }
};
const near = (a, b, tol = 0.6) => Math.abs(Number(a) - Number(b)) <= tol;

// `data-init-card` values are the store's own ids (init_sso, init_kafka): quoted, with the two characters
// that could end the string escaped, because this side of the harness has no CSS.escape.
const sel = (id) => `#as-initiatives [data-init-card="${String(id).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;

// ---- the page's own helpers, in its own words -------------------------------------------------------
// The pane remembers which tab was open in module state, not across a reload, so every navigation goes
// through the two presses a reader makes: the header button, then the Initiatives tab.
const openPane = async (page, base) => {
  await openPage(page, base, { selector: "#btn-assistant" });
  await page.waitForSelector("section.project, .topbar", { timeout: 60_000 });
  const open = await page.evaluate(() => {
    const el = document.getElementById("assistant");
    return Boolean(el) && !el.hidden && getComputedStyle(el).display !== "none";
  });
  if (!open) await page.click("#btn-assistant");
  await page.waitForSelector("#assistant:not([hidden])", { timeout: 15_000 });
  return page;
};

const openInitiatives = async (page, base) => {
  await openPane(page, base);
  const selected = await page.evaluate(() => document.querySelector('#as-tabs [data-as-tab="initiatives"]')?.getAttribute("aria-selected") === "true");
  if (!selected) await page.click('#as-tabs [data-as-tab="initiatives"]');
  await page.waitForSelector("#as-initiatives:not(.hidden)", { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelectorAll("#as-initiatives .init-card").length >= 4, null, { timeout: 30_000 });
};

// One card, measured as the reader sees it: the title's place INSIDE ITS OWN CARD (the frame that does
// not move when a sibling above it reflows), the dot column's place inside it, and each dot's own box,
// class and painted colour.
const CARD_GEOM = (id) => {
  const card = document.querySelector(`#as-initiatives [data-init-card="${CSS.escape(id)}"]`);
  if (!card) return null;
  const r2 = (v) => Math.round(Number(v) * 100) / 100;
  const title = card.querySelector(".init-title");
  const head = card.querySelector(".init-head-btn");
  const glyph = card.querySelector(".init-glyph");
  const cr = card.getBoundingClientRect();
  const tr = title.getBoundingClientRect();
  const cs = getComputedStyle(title);
  const ccs = getComputedStyle(card);
  const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.25 || 0;
  const dots = glyph ? [...glyph.querySelectorAll("i")] : [];
  const gr = glyph ? glyph.getBoundingClientRect() : null;
  return {
    open: !card.classList.contains("is-titlecard"),
    card: { left: r2(cr.left), top: r2(cr.top), width: r2(cr.width), height: r2(cr.height) },
    // The card's place in the PANE'S OWN SCROLLED DOCUMENT, not in the viewport: the pane corrects its scroll when the
    // content above the reader moves, so the viewport top is allowed to shift by design. This number is the card's own
    // position, which is what "the expand changed nothing above it" means.
    cardDocTop: r2(cr.top - (document.getElementById("as-initiatives")?.getBoundingClientRect().top || 0) + (document.getElementById("as-initiatives")?.scrollTop || 0)),
    cardStyle: {
      paddingLeft: ccs.paddingLeft,
      paddingTop: ccs.paddingTop,
      borderTop: ccs.borderTopWidth,
      hue: card.style.getPropertyValue("--init-hue").trim() || null,
      hasHue: card.classList.contains("has-init-hue"),
      classes: card.className,
    },
    title: {
      left: r2(tr.left),
      top: r2(tr.top),
      width: r2(tr.width),
      height: r2(tr.height),
      fontSize: cs.fontSize,
      lineHeight: cs.lineHeight,
      lineHeightPx: r2(lh),
      lines: lh ? Math.round(tr.height / lh) : null,
      colour: cs.color,
    },
    titleInCard: { x: r2(tr.left - cr.left), y: r2(tr.top - cr.top) },
    lineBox: { top: r2(tr.top), centre: r2(tr.top + lh / 2), bottom: r2(tr.top + lh) },
    headHeight: r2(head.getBoundingClientRect().height),
    glyph: glyph
      ? {
          present: true,
          left: r2(gr.left),
          top: r2(gr.top),
          width: r2(gr.width),
          height: r2(gr.height),
          inCard: { x: r2(gr.left - cr.left), y: r2(gr.top - cr.top) },
          centreY: r2(gr.top + gr.height / 2),
          dots: dots.map((d) => {
            const dr = d.getBoundingClientRect();
            return {
              cls: String(d.className),
              bg: getComputedStyle(d).backgroundColor,
              w: r2(dr.width),
              h: r2(dr.height),
              cx: r2(dr.left + dr.width / 2),
              cy: r2(dr.top + dr.height / 2),
              top: r2(dr.top),
              bottom: r2(dr.bottom),
            };
          }),
        }
      : { present: false },
  };
};

const geomOf = (page, id) => page.evaluate(CARD_GEOM, id);

const expand = async (page, id) => {
  const folded = await page.evaluate((s) => document.querySelector(s)?.classList.contains("is-titlecard"), sel(id));
  if (folded) await page.click(`${sel(id)} [data-init-card-toggle]`);
  await page.waitForSelector(`${sel(id)}:not(.is-titlecard) .init-projects`, { timeout: 15_000 });
};

const collapse = async (page, id) => {
  const folded = await page.evaluate((s) => document.querySelector(s)?.classList.contains("is-titlecard"), sel(id));
  if (!folded) await page.click(`${sel(id)} [data-init-card-toggle]`);
  await page.waitForSelector(`${sel(id)}.is-titlecard`, { timeout: 15_000 });
};

const storeKeys = (page) =>
  page.evaluate(() => ({
    initiatives: (() => {
      try {
        return JSON.parse(localStorage.getItem("wm.initiativeHues") || "null");
      } catch {
        return "unreadable";
      }
    })(),
    projects: (() => {
      try {
        return JSON.parse(localStorage.getItem("wm.projectHues") || "null");
      } catch {
        return "unreadable";
      }
    })(),
    all: Object.keys(localStorage).filter((k) => /hue/i.test(k)).sort(),
  }));

// The dot column, folded, on every row that has one: one gutter from the card's own edge, one distance
// from the gutter to the title, and every dot on the title's first line.
const foldedDotRows = (page) =>
  page.evaluate(() => {
    const r2 = (v) => Math.round(Number(v) * 100) / 100;
    return [...document.querySelectorAll("#as-initiatives .init-card.is-titlecard")]
      .filter((card) => card.querySelector(".init-glyph i"))
      .map((card) => {
        const cr = card.getBoundingClientRect();
        const tr = card.querySelector(".init-title").getBoundingClientRect();
        const gr = card.querySelector(".init-glyph").getBoundingClientRect();
        const lh = parseFloat(getComputedStyle(card.querySelector(".init-title")).lineHeight) || 0;
        const dots = [...card.querySelectorAll(".init-glyph i")].map((d) => {
          const dr = d.getBoundingClientRect();
          return { cy: r2(dr.top + dr.height / 2), top: r2(dr.top), bottom: r2(dr.bottom) };
        });
        return {
          id: card.getAttribute("data-init-card"),
          gutter: r2(gr.left - cr.left),
          gap: r2(tr.left - gr.left),
          titleX: r2(tr.left - cr.left),
          titleY: r2(tr.top - cr.top),
          lineCentre: r2(tr.top + lh / 2),
          lineTop: r2(tr.top),
          lineBottom: r2(tr.top + lh),
          dots,
        };
      });
  });

const shot = async (page, name, selector = "#as-initiatives") => {
  try {
    // A card that is scrolled out of the pane would be clipped from its own top: put the frame's top just under the
    // pane's own top edge first, so the picture shows the thing being measured and not the middle of it.
    await page.evaluate((s) => {
      const pane = document.getElementById("as-initiatives");
      const target = document.querySelector(s);
      if (!pane || !target) return;
      const box = target.getBoundingClientRect();
      const frame = pane.getBoundingClientRect();
      if (box.top < frame.top || box.bottom > frame.bottom) {
        pane.scrollTop = Math.max(0, pane.scrollTop + box.top - frame.top - 8);
      }
    }, selector);
    await page.waitForTimeout(150);
    const box = await page.locator(selector).boundingBox();
    if (!box) return;
    const clip = { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.min(box.width, 1200), height: Math.min(box.height, 900) };
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), clip });
  } catch {
    /* a screenshot is evidence, not the check */
  }
};

// The two card widths the jump is measured at. The dock's own width is the reader's (`wm.assistantWidth`),
// so the second width is set the way they set it and then re-measured - never assumed from the viewport.
const WIDTHS = [
  { label: "480px dock", dock: 480, viewport: { width: 1440, height: 900 } },
  { label: "720px dock", dock: 720, viewport: { width: 1440, height: 900 } },
  // The wide container splits the OPEN card into its words and its cast (public/style.css's 1000px container
  // query), so it is a second drawing of the same card and the title has to stay put there too.
  { label: "1100px dock, the split plate", dock: 1100, viewport: { width: 2200, height: 900 } },
];

let panel = null;
let browser = null;
try {
  mkdirSync(SHOTS, { recursive: true });
  console.log(`home:  ${HOME.replace(/\\/g, "/")}`);
  console.log(`shots: ${SHOTS.replace(/\\/g, "/")}`);

  await buildFixture({ home: HOME, reset: true });
  panel = await startFixturePanel({ home: HOME });
  console.log(`panel: ${panel.base} (pid ${panel.pid})`);
  await waitForFixtureRows(panel.base);
  const view = await waitForInitiativesView(panel.base);
  ok("the fixture serves its four initiatives and their waves", view.initiatives.length === 4 && view.initiatives.some((i) => (i.waves || []).length >= 3), view.initiatives.map((i) => `${i.id}:${(i.waves || []).length}w`).join(", "));

  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the initiative card's dots, title and colour", "playwright is not installed for this node (see tools/browser.mjs)"));
    process.exitCode = 2;
  } else {
    browser = await playwright.chromium.launch({ headless: true });
    const widthRun = [];
    for (const width of WIDTHS) {
      const context = await browser.newContext({ viewport: width.viewport, deviceScaleFactor: 1 });
      const errors = { page: [], console: [] };
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.page.push(String(e && e.message ? e.message : e)));
      page.on("console", (m) => {
        if (m.type() === "error") errors.console.push(m.text());
      });
      try {
        await openPage(page, panel.base, { selector: "#btn-assistant" });
        await page.evaluate((dock) => {
          localStorage.setItem("wm.assistantWidth", String(dock));
        }, width.dock);

        // ---- 3b. THE PROJECTS' OWN GESTURE, BEFORE ANYTHING OF OURS IS ON THE BOARD ------------------
        // Measured on the folded board with the assistant pane closed, so a failing project path cannot be
        // blamed on the initiatives code.
        if (width.label === WIDTHS[0].label) {
          await page.waitForSelector("section.project .project-head[data-toggle-project]", { timeout: 60_000 });
          const phead = page.locator("section.project .project-head[data-toggle-project]").first();
          const projName = await phead.evaluate((el) => el.getAttribute("data-toggle-project"));
          const before = await page.evaluate((n) => {
            const sec = document.querySelector(`section.project[data-project="${CSS.escape(n)}"]`);
            return { hue: sec.style.getPropertyValue("--proj-hue").trim() || null, hasHue: sec.classList.contains("has-hue") };
          }, projName);
          await phead.click({ modifiers: ["Control"] });
          await page.waitForTimeout(150);
          const themed = await page.evaluate((n) => {
            const sec = document.querySelector(`section.project[data-project="${CSS.escape(n)}"]`);
            return { hue: sec.style.getPropertyValue("--proj-hue").trim() || null, hasHue: sec.classList.contains("has-hue"), stored: (() => { try { return JSON.parse(localStorage.getItem("wm.projectHues") || "null"); } catch { return "unreadable"; } })() };
          }, projName);
          check("a project starts with no theme colour", [before.hasHue, before.hue], [false, null]);
          ok("Ctrl+click on a project head still themes it, through wm.projectHues", themed.hasHue && Number.isFinite(Number(themed.hue)) && Number(themed.stored?.[projName]) === Number(themed.hue), `${projName}: hue ${themed.hue}, stored ${JSON.stringify(themed.stored)}`);
          await phead.click({ modifiers: ["Control", "Shift"] });
          await page.waitForTimeout(150);
          const dropped = await page.evaluate((n) => {
            const sec = document.querySelector(`section.project[data-project="${CSS.escape(n)}"]`);
            return { hue: sec.style.getPropertyValue("--proj-hue").trim() || null, hasHue: sec.classList.contains("has-hue") };
          }, projName);
          check("Ctrl+Shift+click on a project head still drops the colour", [dropped.hasHue, dropped.hue], [false, null]);
        }

        // ---- 1. THE DOTS ON THE TITLE'S LINE --------------------------------------------------------
        await openInitiatives(page, panel.base);
        const rows = await foldedDotRows(page);
        ok("the folded ledger draws the route mark with its dots", rows.length >= 1 && rows[0].dots.length >= 2, rows.map((r) => `${r.id}:${r.dots.length} dots`).join(", "));
        const gutters = [...new Set(rows.map((r) => r.gutter))];
        const gaps = [...new Set(rows.map((r) => r.gap))];
        const titleXs = [...new Set(rows.map((r) => r.titleX))];
        check("every folded row hangs its dots in one gutter from the card's edge", gutters.length, 1);
        check("the dots sit one fixed distance left of the title on every row", gaps.length, 1);
        check("every folded title starts on one reading edge", titleXs.length, 1);
        const offCentre = rows.flatMap((r) => r.dots.map((d) => ({ id: r.id, off: Math.round((d.cy - r.lineCentre) * 100) / 100 }))).filter((d) => Math.abs(d.off) > 0.6);
        const worstOff = offCentre.length ? Math.max(...offCentre.map((d) => Math.abs(d.off))) : 0;
        ok(
          "every dot's centre is on the title's first line box centre",
          offCentre.length === 0,
          offCentre.length ? offCentre.map((d) => `${d.id} ${d.off}px off`).join(", ") : `${rows.reduce((n, r) => n + r.dots.length, 0)} dots, off-centre by at most ${worstOff}px`,
        );
        const outsideLine = rows.flatMap((r) => r.dots.map((d) => ({ id: r.id, top: d.top - r.lineTop, bottom: r.lineBottom - d.bottom }))).filter((d) => d.top < -0.6 || d.bottom < -0.6);
        ok(
          "every dot is drawn inside the title's own line box",
          outsideLine.length === 0,
          outsideLine.length ? outsideLine.map((d) => `${d.id}: ${d.top}px below the line top, ${d.bottom}px above its bottom`).join(", ") : "all inside",
        );
        console.log(`      gutter ${gutters[0]}px, dots to title ${gaps[0]}px, title x ${titleXs[0]}px, at ${width.label}`);
        if (width.label === WIDTHS[0].label) await shot(page, "01-folded");

        // ---- 2. THE TITLE DOES NOT JUMP WHEN THE CARD OPENS -----------------------------------------
        // The row with the wave route: its dots must survive the expand. The long-titled row: its title
        // must not move, and at the narrow dock it wraps to two lines, which is the case a fixed `top`
        // offset could never get right.
        const routeId = rows[0].id;
        const longId = (await page.evaluate(() => {
          const cards = [...document.querySelectorAll("#as-initiatives .init-card.is-titlecard")];
          const best = cards.map((c) => ({ id: c.getAttribute("data-init-card"), w: c.querySelector(".init-title").getBoundingClientRect().width })).sort((a, b) => b.w - a.w)[0];
          return best ? best.id : null;
        })) || routeId;

        const foldedRoute = await geomOf(page, routeId);
        await expand(page, routeId);
        const openRoute = await geomOf(page, routeId);
        const foldedDots = foldedRoute.glyph.dots.map((d) => `${d.cls}|${d.bg}`);
        const openDots = openRoute.glyph.present ? openRoute.glyph.dots.map((d) => `${d.cls}|${d.bg}`) : [];
        ok("the route dots are still drawn on the open card", openRoute.glyph.present && openDots.length === foldedDots.length, openRoute.glyph.present ? `${openDots.length} of ${foldedDots.length} dots` : "no glyph on the open card");
        check("the dots keep their own colours and order when the card opens", openDots, foldedDots);
        if (width.label === WIDTHS[0].label) await shot(page, "02-expanded", sel(routeId));
        await collapse(page, routeId);

        const foldedLong = await geomOf(page, longId);
        await expand(page, longId);
        const openLong = await geomOf(page, longId);
        const jump = { dx: Math.round((openLong.titleInCard.x - foldedLong.titleInCard.x) * 100) / 100, dy: Math.round((openLong.titleInCard.y - foldedLong.titleInCard.y) * 100) / 100 };
        check(
          `the title is at the same x and y open and closed at ${width.label}`,
          [jump.dx, jump.dy],
          [0, 0],
        );
        console.log(
          `      ${width.label}: card ${foldedLong.card.width}px wide, title ${foldedLong.title.lines} line(s) folded, ${openLong.title.lines} open; ` +
            `folded x ${foldedLong.titleInCard.x} y ${foldedLong.titleInCard.y} -> open x ${openLong.titleInCard.x} y ${openLong.titleInCard.y}`,
        );
        // The same card's own place must not move either: the expand is a change INSIDE it, so a card that jumped up
        // its pane would be a second defect hiding behind the relative measurement (the pane's scroll correction is
        // why this reads the card's place in the scrolled document rather than in the viewport).
        check(`the card's own place does not move when it opens at ${width.label}`, Math.round((openLong.cardDocTop - foldedLong.cardDocTop) * 100) / 100, 0);
        await collapse(page, longId);
        widthRun.push({ label: width.label, card: foldedLong.card.width, folded: foldedLong.titleInCard, open: openLong.titleInCard, lines: foldedLong.title.lines });

        // ---- 3. ONE INITIATIVE'S THEME COLOUR --------------------------------------------------------
        if (width.label === WIDTHS[0].label) {
          // The card WITH the route mark carries the colour check: its dots are the thing that must survive the
          // gesture untouched, and a card with no waves has an empty slot to compare against.
          const colourId = routeId;
          const plain = await geomOf(page, colourId);
          const beforeStore = await storeKeys(page);
          // Ctrl+click the TITLE: it must theme, not fold, and the dots must not be repainted.
          await page.click(`${sel(colourId)} .init-title`, { modifiers: ["Control"] });
          await page.waitForTimeout(200);
          const themed = await geomOf(page, colourId);
          check("Ctrl+click on the title does not fold or unfold the card", themed.open, plain.open);
          ok("Ctrl+click paints the initiative in a theme hue", themed.cardStyle.hasHue && Number.isFinite(Number(themed.cardStyle.hue)), `hue ${themed.cardStyle.hue}`);
          const hue = Number(themed.cardStyle.hue);
          ok("the hue is a real colour on the circle", hue >= 0 && hue < 360, String(hue));
          const afterStore = await storeKeys(page);
          ok("the choice is kept in wm.initiativeHues, by the project rule", Number(afterStore.initiatives?.[colourId]) === hue, JSON.stringify(afterStore.initiatives));
          ok("no project hue was written by the initiative's colour", JSON.stringify(afterStore.projects), JSON.stringify(beforeStore.projects));
          if (width.label === WIDTHS[0].label) await shot(page, "03-coloured", sel(colourId));

          // The dots keep their own meaning: same boxes, same order, same painted colours.
          const dotsBefore = plain.glyph.present ? plain.glyph.dots.map((d) => `${d.cls}|${d.bg}|${d.w}x${d.h}`) : [];
          const dotsAfter = themed.glyph.present ? themed.glyph.dots.map((d) => `${d.cls}|${d.bg}|${d.w}x${d.h}`) : [];
          check("the colour leaves the dots' own colours and order untouched", dotsAfter, dotsBefore);
          check("the colour leaves the title on the same spot", [themed.titleInCard.x, themed.titleInCard.y], [plain.titleInCard.x, plain.titleInCard.y]);

          // A second Ctrl+click re-rolls: the chooser's own rule is that a re-roll changes what you see.
          await page.click(`${sel(colourId)} .init-glyph`, { modifiers: ["Control"] });
          await page.waitForTimeout(200);
          const rerolled = await geomOf(page, colourId);
          const hue2 = Number(rerolled.cardStyle.hue);
          ok("a second Ctrl+click, this time on the dot column, rolls a different hue", Number.isFinite(hue2) && Math.abs(hue2 - hue) >= 45, `${hue} -> ${hue2}`);

          // RELOAD: the same rule a project colour follows, proved by a fresh document.
          await openInitiatives(page, panel.base);
          const reloaded = await geomOf(page, colourId);
          ok("the colour survives a reload", reloaded.cardStyle.hasHue && Number(reloaded.cardStyle.hue) === hue2, `hue ${reloaded.cardStyle.hue} after reload (wrote ${hue2})`);
          const reloadStore = await storeKeys(page);
          ok("the reloaded colour is the one the store holds", Number(reloadStore.initiatives?.[colourId]) === hue2, JSON.stringify(reloadStore.initiatives));

          // Shift drops it (and Ctrl+Shift, the projects' own form, is the same gesture).
          await page.click(`${sel(colourId)} .init-title`, { modifiers: ["Shift"] });
          await page.waitForTimeout(200);
          const dropped = await geomOf(page, colourId);
          check("Shift+click drops the colour", [dropped.cardStyle.hasHue, dropped.cardStyle.hue], [false, null]);
          await openInitiatives(page, panel.base);
          const stillDropped = await geomOf(page, colourId);
          check("the drop survives a reload", [stillDropped.cardStyle.hasHue, stillDropped.cardStyle.hue], [false, null]);

          // NO STORAGE: the colour still paints, for this tab only, and a reload forgets it - the
          // `saveProjectHues` try/catch rule, not a second store.
          await page.evaluate(() => {
            window.__realSetItem = Storage.prototype.setItem;
            Storage.prototype.setItem = function () {
              throw new Error("storage denied by the gate");
            };
          });
          await page.click(`${sel(colourId)} .init-title`, { modifiers: ["Control"] });
          await page.waitForTimeout(200);
          const noStore = await geomOf(page, colourId);
          ok("with storage denied the colour still paints on the card", noStore.cardStyle.hasHue && Number.isFinite(Number(noStore.cardStyle.hue)), `hue ${noStore.cardStyle.hue}`);
          const written = await page.evaluate(() => {
            try {
              return localStorage.getItem("wm.initiativeHues");
            } catch {
              return "unreadable";
            }
          });
          ok("with storage denied nothing was persisted", written == null || !String(written).includes(colourId), String(written));
          await page.evaluate(() => {
            Storage.prototype.setItem = window.__realSetItem;
          });
          await openInitiatives(page, panel.base);
          const afterDenied = await geomOf(page, colourId);
          check("with storage denied the colour lasts this tab only", [afterDenied.cardStyle.hasHue, afterDenied.cardStyle.hue], [false, null]);
        }

        // ---- 5. HEALTH ------------------------------------------------------------------------------
        check("no page errors", errors.page, []);
        check("no console errors", errors.console, []);
      } finally {
        await context.close().catch(() => {});
      }
    }
    ok("the runs measured more than one card width", new Set(widthRun.map((w) => w.card)).size >= 2, widthRun.map((w) => `${w.label}: ${w.card}px`).join(", "));
  }
} catch (err) {
  failures += 1;
  console.error(`\nFAIL  the run threw: ${err && err.stack ? err.stack : err}`);
  try {
    console.error(panel.log().split("\n").slice(-25).join("\n"));
  } catch {
    /* the log is a courtesy */
  }
} finally {
  try {
    if (browser) await browser.close();
  } catch {
    /* already gone */
  }
  try {
    await panel?.stop();
  } catch {
    /* already gone */
  }
  clearTimeout(watchdog);
}

console.log(`\n${failures === 0 ? "OK" : "FAILED"}  ${checks - failures}/${checks} checks passed; shots in ${SHOTS}`);
process.exit(failures === 0 ? 0 : 1);
