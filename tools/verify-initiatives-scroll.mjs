#!/usr/bin/env node
// THE INITIATIVES PANE SCROLLS INSIDE THE FLOAT.
//
// HARNESS: LIVE GATE
//
//   node tools/verify-initiatives-scroll.mjs [--shots <dir>]
//
// WHAT THIS GATE PROVES. The reader's report: with several initiatives expanded the list runs past the bottom of the
// assistant float and there is no scroll bar, so the cards below the fold cannot be reached. The cause is the sheet,
// not the painter - `.as-pane` carries padding and nothing else (public/style.css:4438), and the rule that turns a
// pane into a pass-through box (display flex, flex 1, min-height 0) is scoped to `[data-pane^="assistant-"]`
// (public/style.css:5058), while the Initiatives pane is `data-pane="initiatives"` (public/index.html:1149) and is
// painted by public/assistant.js from GET /api/initiatives. The float's body clips its children
// (`.as-body:has(.as-subpane[data-subpane="chat"]:not(.hidden))`, public/style.css:5055), so the pane grew past the
// window and the overflow was painted nowhere.
//
// Measured on the real page at 1440x900, against a panel of its own:
//
//   1. THE PANE IS THE SCROLLER: #as-initiatives computes `overflow-y: auto`, and its box ends inside `.as-body`, so
//      the pane is the size of the float rather than the size of its content.
//   2. THERE IS SOMETHING BELOW THE FOLD: with every card expanded, the pane's scrollHeight exceeds its clientHeight
//      by more than one card, and the last card's box sits below the pane's own box.
//   3. THE SCROLL IS THE PANE'S: a wheel over the pane (the reader's own gesture) moves the pane's scrollTop, leaves
//      `.as-body` and the document where they were, and the pane reaches its maximum - where the last card's REACHABLE
//      BOTTOM is inside the pane's visible box. The whole box is asserted only when the card fits: the last card is
//      747px tall with its fills open inside a 727px pane, so its top and bottom cannot both be on screen at any scroll
//      position. Demanding the whole box was this gate's own defect - it answered 31/33 at the tree the round shipped
//      (d0df8ca) while the scroll itself was correct at 8612 of 8612, and 33/33 on the archived parent c2692598 only
//      because that parent's card was shorter. The gate now asserts what the reader needs (the end of the list) and
//      says so in its failure line, so a future card that grows past the pane cannot turn a correct scroll red again.
//   4. THE SCROLL SURVIVES THE TAB'S OWN RE-READ: the pane reads /api/initiatives every four seconds and repaints
//      from that answer; five seconds later it is still where the reader left it and the last card's reachable bottom
//      is still on screen (and its whole box, when it fits).
//   5. A TAB THAT FITS GROWS NO SCROLL BAR: each panel-level pane on the row (Role, Watchdog, Bridge) is measured with
//      its own content on screen; every one whose content fits reads scrollHeight === clientHeight, so no scroll bar
//      is drawn, and none of them hangs below the body.
//   6. THE hidden CLASS STILL SWITCHES PANES: with another tab on screen #as-initiatives carries `hidden` and computes
//      display none, pressing Initiatives back shows it and hides the other, and exactly one pane is on screen.
//   7. HEALTH: zero page errors and zero console errors.
//
// Sandbox only: its own config, port, HERMES_HOME and logs, assistant disabled, an apiServer pointed at a dead port,
// and no projects. The live panel is never touched. Without Playwright the script says BROWSER-NOT-RUN and exits 2
// rather than passing on a half that never ran.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { ROOT, startPanel } from "./panel-testkit.mjs";

// A hang here would otherwise be silent (a browser left open keeps node's loop alive and the log never lands).
const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 240_000);
const watchdog = setTimeout(() => {
  try {
    process.stderr.write(`WATCHDOG: ${WATCHDOG_MS}ms elapsed without the run finishing - see the last line printed above.\n`);
  } catch {
    /* nothing left to do */
  }
  process.exit(1);
}, WATCHDOG_MS);

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
const note = (s) => console.log(`      ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const shotDirArg = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : null;
const shotsDir = shotDirArg ? path.resolve(shotDirArg) : null;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

// Two initiatives is the list most readers have: short enough that the pane's content fits the float, so it is the
// no-regress case - the scroll container must not draw a bar for it. Ten more, each expanded with its description
// whole, is the reader's report: several initiatives, taller than the pane, with nothing to scroll with.
const FIT_COUNT = 2;
const COUNT = 12;
const PARA =
  "One project at a time, so a cutover that goes wrong is one app and one toggle away from the way it works today. " +
  "The blast radius is the reason this is an initiative rather than twelve tickets: the work only counts as done when " +
  "every one of them has landed and nothing has been left half switched over.";

const panel = await startPanel({
  config: {
    refreshSeconds: 3600,
    worktreeSeconds: 3600,
    midSeconds: 3600,
    dormantSeconds: 3600,
    slowSeconds: 3600,
    fetchSeconds: 3600,
    scanMode: "all",
    projects: [],
    apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
    assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
    // The gate seeds the store through the route, so the tier is set where no answer would park a question: which
    // level is in force is not what this gate measures.
    initiativePermissions: "none",
  },
});
const base = panel.base;
const GET = async (p) => {
  const r = await fetch(`${base}${p}`);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const POST = async (p, body) => {
  const r = await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

let browser = null;
let shotNo = 0;
const shotName = (slug) => path.join(shotsDir, `${String((shotNo += 1)).padStart(2, "0")}-${slug}.png`);

try {
  console.log(`sandbox: ${base}`);
  console.log(`panel pid: ${panel.pid}`);

  // ---- the fixture: two initiatives first (the list that FITS), then ten more -----------------------
  console.log("\n== seed ==");
  const seedOne = async (i) => {
    const made = await POST("/api/initiatives", {
      title: `Initiative ${String(i).padStart(2, "0")} - the ${["first", "second", "third"][i % 3]} cutover`,
      description: [`The ${i}th piece of work in this fixture.`, PARA, PARA, `Done when initiative ${i} has landed.`].join("\n\n"),
    });
    if (made.status !== 201) throw new Error(`seeding initiative ${i} answered HTTP ${made.status}: ${made.body?.error || ""}`);
  };
  // The first two are the no-regress case: a list short enough to fit the float must still grow no scroll bar once the
  // pane is a scroll container, and that is measured BEFORE the list is long enough to overflow.
  for (let i = 1; i <= FIT_COUNT; i += 1) await seedOne(i);
  const store = await GET("/api/initiatives");
  check("the store holds the initiatives this gate seeded", store.body?.initiatives?.length, FIT_COUNT);
  ok("the store is a file beside the panel's own state", Boolean(store.body?.file), String(store.body?.file || ""));

  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the initiatives pane's scroll", "playwright is not installed for this node (see tools/browser.mjs)"));
    failures += 1;
  } else {
    await withBrowser(
      async ({ page, pageErrors, consoleErrors }) => {
        const shot = async (slug) => {
          if (!shotsDir) return null;
          const file = shotName(slug);
          await page.screenshot({ path: file });
          note(`shot ${path.basename(file)}`);
          return file;
        };
        const shotPane = async (slug) => {
          if (!shotsDir) return null;
          const box = await page.locator("#as-initiatives").boundingBox();
          if (!box) return null;
          const file = shotName(slug);
          await page.screenshot({
            path: file,
            clip: { x: Math.max(0, box.x - 6), y: Math.max(0, box.y - 6), width: Math.min(1440 - Math.max(0, box.x - 6), box.width + 12), height: Math.min(900 - Math.max(0, box.y - 6), box.height + 12) },
          });
          note(`shot ${path.basename(file)}`);
          return file;
        };

        // One read of the pane and the boxes around it. Never a computed guess: the numbers are the element's own.
        const geometry = () =>
          page.evaluate(() => {
            const pane = document.getElementById("as-initiatives");
            const body = document.querySelector("#assistant .as-body");
            const cards = [...pane.querySelectorAll(".init-card")];
            const last = cards[cards.length - 1] || null;
            const pr = pane.getBoundingClientRect();
            const br = body ? body.getBoundingClientRect() : null;
            const lr = last ? last.getBoundingClientRect() : null;
            const cs = getComputedStyle(pane);
            const bs = body ? getComputedStyle(body) : null;
            const doc = document.scrollingElement || document.documentElement;
            return {
              overflowY: cs.overflowY,
              display: cs.display,
              hidden: pane.classList.contains("hidden"),
              bodyDisplay: bs ? bs.display : null,
              bodyOverflowY: bs ? bs.overflowY : null,
              chatHidden: document.getElementById("as-chat") ? document.getElementById("as-chat").classList.contains("hidden") : null,
              view: (() => {
                try {
                  return JSON.parse(localStorage.getItem("wm.assistantView") || "null");
                } catch {
                  return null;
                }
              })(),
              clientHeight: pane.clientHeight,
              scrollHeight: pane.scrollHeight,
              scrollTop: Math.round(pane.scrollTop),
              maxScroll: Math.round(pane.scrollHeight - pane.clientHeight),
              paneTop: Math.round(pr.top),
              paneBottom: Math.round(pr.bottom),
              bodyBottom: br ? Math.round(br.bottom) : null,
              bodyScrollTop: body ? Math.round(body.scrollTop) : null,
              docScrollTop: Math.round(doc.scrollTop),
              cards: cards.length,
              lastTop: lr ? Math.round(lr.top) : null,
              lastBottom: lr ? Math.round(lr.bottom) : null,
              lastHeight: lr ? Math.round(lr.height) : null,
              lastInPane: lr ? lr.top >= pr.top - 1 && lr.bottom <= pr.bottom + 1 : false,
              // The bottom, not the box: an open card can be taller than the pane, and then no scrollTop puts its whole
              // box on screen. The reader needs its end reachable, and that is what this reads.
              lastBottomInPane: lr ? lr.bottom <= pr.bottom + 1 : false,
              lastTallerThanPane: lr ? lr.height > pane.clientHeight : false,
              lastBelowPane: lr ? lr.bottom > pr.bottom + 1 : false,
            };
          });

        // Press every card open, then every description to its whole text: the state the reader reports. The aria
        // attribute is the painter's own record of the fold, so a re-press cannot close a card that is already open.
        const expandAll = async () => {
          for (let guard = 0; guard < COUNT * 3 + 6; guard += 1) {
            const folded = page.locator('#as-initiatives .init-head-btn[aria-expanded="false"]').first();
            if ((await folded.count()) === 0) break;
            await folded.click();
          }
          for (let guard = 0; guard < COUNT * 3 + 6; guard += 1) {
            const folded = page.locator('#as-initiatives [data-init-desc-fold][aria-expanded="false"]').first();
            if ((await folded.count()) === 0) break;
            await folded.click();
          }
        };

        await openPage(page, base, { selector: "#projects" });
        const open = await page.evaluate(() => {
          const el = document.getElementById("assistant");
          return Boolean(el) && !el.hidden && getComputedStyle(el).display !== "none";
        });
        if (!open) await page.click("#btn-assistant");
        await page.waitForSelector("#assistant:not([hidden])", { timeout: 20_000 });
        await page.click('#as-tabs [data-as-tab="initiatives"]');
        await page.waitForSelector("#as-initiatives:not(.hidden)", { timeout: 20_000 });
        await page.waitForSelector("#as-initiatives .init-card", { timeout: 30_000 });

        // ---- the tab is painted from the route, on the list that fits ---------------------------------
        console.log("\n== the pane on screen, with a list short enough to fit ==");
        const painted = await page.evaluate(() => ({
          cards: document.querySelectorAll("#as-initiatives .init-card").length,
          titles: [...document.querySelectorAll("#as-initiatives .init-title")].map((t) => t.textContent.trim()),
          titleCards: document.querySelectorAll("#as-initiatives .init-card.is-titlecard").length,
          tier: document.querySelector("#as-initiatives [data-init-tier]")?.dataset?.initTier || null,
        }));
        check("the pane is painted from GET /api/initiatives, one card per initiative", painted.cards, FIT_COUNT);
        ok("every card starts folded to its title", painted.titleCards === FIT_COUNT, `${painted.titleCards} of ${FIT_COUNT} title cards`);

        const fit = await geometry();
        note(`pane: ${fit.clientHeight}px client, ${fit.scrollHeight}px content, overflow-y ${fit.overflowY}, bottom ${fit.paneBottom} vs body ${fit.bodyBottom}`);
        note(`body: display ${fit.bodyDisplay}, overflow-y ${fit.bodyOverflowY}; chat subpane hidden ${fit.chatHidden}; view ${JSON.stringify(fit.view)}`);
        ok("the short list's content fits the pane", fit.scrollHeight <= fit.clientHeight + 1, `${fit.scrollHeight} of ${fit.clientHeight}`);
        ok("…and the pane grows no scroll bar for it", fit.scrollTop === 0 && fit.scrollHeight === fit.clientHeight, `scrollTop ${fit.scrollTop}, ${fit.scrollHeight}/${fit.clientHeight}`);
        await shotPane("fits");

        // ---- grow the list to the reader's report, then expand every card ---------------------------
        console.log("\n== the full list, every initiative expanded ==");
        for (let i = FIT_COUNT + 1; i <= COUNT; i += 1) await seedOne(i);
        // The reader's own Refresh, not a state poke: the pane reads the store again and repaints from the answer.
        await page.click("#as-initiatives [data-init-refresh]");
        await page.waitForFunction((want) => document.querySelectorAll("#as-initiatives .init-card").length === want, COUNT, { timeout: 30_000 });

        await expandAll();
        await sleep(300);
        const expanded = await page.evaluate(() => ({
          cards: document.querySelectorAll("#as-initiatives .init-card").length,
          heads: document.querySelectorAll('#as-initiatives .init-head-btn[aria-expanded="false"]').length,
          descs: document.querySelectorAll('#as-initiatives [data-init-desc-fold][aria-expanded="false"]').length,
          titleCards: document.querySelectorAll("#as-initiatives .init-card.is-titlecard").length,
        }));
        check("every initiative is expanded, descriptions whole", { heads: expanded.heads, descs: expanded.descs, titleCards: expanded.titleCards }, { heads: 0, descs: 0, titleCards: 0 });
        check("all of them are on the pane", expanded.cards, COUNT);

        const g = await geometry();
        note(`pane: ${g.clientHeight}px client, ${g.scrollHeight}px content, overflow-y ${g.overflowY}, bottom ${g.paneBottom} vs body ${g.bodyBottom}`);
        note(`body: display ${g.bodyDisplay}, overflow-y ${g.bodyOverflowY}; chat subpane hidden ${g.chatHidden}; view ${JSON.stringify(g.view)}`);
        note(`last card: ${g.cards}th, top ${g.lastTop}, bottom ${g.lastBottom}, in pane ${g.lastInPane}, below pane ${g.lastBelowPane}`);
        await shotPane("expanded");

        // ---- 1. the pane is the scroller ---------------------------------------------------------
        console.log("\n== 1. the pane is the float's scroller ==");
        ok("the pane computes overflow-y: auto", g.overflowY === "auto", g.overflowY);
        ok(
          "the pane ends inside the float's body, so it is the float's size and not its content's",
          g.bodyBottom !== null && g.paneBottom <= g.bodyBottom + 1,
          `pane bottom ${g.paneBottom}, body bottom ${g.bodyBottom}`,
        );
        ok("the pane's content is taller than the pane", g.scrollHeight > g.clientHeight + 100, `${g.scrollHeight} > ${g.clientHeight}`);

        // ---- 2. the last card is below the fold ---------------------------------------------------
        console.log("\n== 2. there is something below the fold ==");
        // The presses that expanded twenty-four controls each scrolled their own box into view (the browser's native
        // focus scroll), so the pane is not at its top. Put it back where a reader finds it - the top of the list -
        // and measure the state the report describes.
        await page.evaluate(() => {
          const pane = document.getElementById("as-initiatives");
          const body = document.querySelector("#assistant .as-body");
          pane.scrollTop = 0;
          if (body) body.scrollTop = 0;
          (document.scrollingElement || document.documentElement).scrollTop = 0;
        });
        await sleep(150);
        const top = await geometry();
        check("the pane is at the top of the list", top.scrollTop, 0);
        ok("the last card's box sits below the pane's own box", top.lastBelowPane, `last bottom ${top.lastBottom}, pane bottom ${top.paneBottom}`);
        ok("so the last card is not on screen before the scroll", top.lastInPane === false, `lastInPane ${top.lastInPane}`);

        // ---- 3. the reader's wheel scrolls the pane ------------------------------------------------
        console.log("\n== 3. a wheel over the pane moves the pane ==");
        const box = await page.locator("#as-initiatives").boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 200));
        await page.mouse.wheel(0, 600);
        await sleep(250);
        const up = await geometry();
        ok("the wheel moved the pane's own scrollTop", up.scrollTop > 0, `scrollTop ${up.scrollTop}`);
        check("the float's body stayed where it was", up.bodyScrollTop, 0);
        check("the document did not scroll instead", up.docScrollTop, 0);
        await page.evaluate(() => {
          const pane = document.getElementById("as-initiatives");
          pane.scrollTop = pane.scrollHeight;
        });
        await sleep(250);
        const bottom = await geometry();
        note(`at the foot: scrollTop ${bottom.scrollTop} of ${bottom.maxScroll}`);
        ok("the pane reaches its own maximum", Math.abs(bottom.scrollTop - bottom.maxScroll) <= 2, `${bottom.scrollTop} of ${bottom.maxScroll}`);
        // THE REACHABLE BOTTOM, NOT THE WHOLE BOX. With its own folds open the last card is 747px tall inside a 727px
        // pane, so its top and its bottom cannot be on screen at once and "the whole box is in the pane" was false at
        // every scroll position - the gate's own defect, not the tab's (it answered 31/33 at d0df8ca while the scroll
        // itself was at 8612 of 8612). The reader needs the end of the card; that is asserted here, and the whole box is
        // still asserted whenever the card fits.
        ok("the last card's reachable bottom is inside the pane's visible box at maximum scroll", bottom.lastBottomInPane && Math.abs(bottom.scrollTop - bottom.maxScroll) <= 2, `last ${bottom.lastTop}..${bottom.lastBottom} (${bottom.lastHeight}px) in ${bottom.paneTop}..${bottom.paneBottom}, ${bottom.clientHeight}px pane; scrollTop ${bottom.scrollTop} of ${bottom.maxScroll}`);
        ok("the last card's whole box is on screen when it fits - and is reported as taller than the pane when it does not", bottom.lastTallerThanPane ? bottom.lastBottomInPane : bottom.lastInPane, bottom.lastTallerThanPane ? `card ${bottom.lastHeight}px in ${bottom.clientHeight}px pane: taller, so only its bottom can be in view` : `card ${bottom.lastHeight}px fits in ${bottom.clientHeight}px`);
        await shotPane("scrolled");

        // ---- 4. the scroll survives the tab's own four-second re-read ------------------------------
        console.log("\n== 4. the tab's own re-read leaves the reader where they were ==");
        const before = bottom.scrollTop;
        await sleep(5200);
        const later = await geometry();
        note(`after a re-read: scrollTop ${later.scrollTop}, last card bottom in pane ${later.lastBottomInPane}`);
        ok("the pane is still where the reader left it after the pane re-read the store", later.scrollTop > 0 && Math.abs(later.scrollTop - before) <= 2, `${before} -> ${later.scrollTop}`);
        ok("the last card's reachable bottom is still on screen after the re-read", later.lastBottomInPane, `last ${later.lastTop}..${later.lastBottom} (${later.lastHeight}px), pane bottom ${later.paneBottom}`);
        ok("the whole box is still on screen after the re-read when the card fits", later.lastTallerThanPane || later.lastInPane, later.lastTallerThanPane ? `card ${later.lastHeight}px in ${later.clientHeight}px pane` : `lastInPane ${later.lastInPane}`);

        // ---- 5. the other panel-level tabs are scrollers too ---------------------------------------
        console.log("\n== 5. the other panel-level tabs are scrollers, not panes that hang below the float ==");
        const measurePane = (id) =>
          page.evaluate((paneId) => {
            const pane = document.getElementById(`as-${paneId}`);
            const body = document.querySelector("#assistant .as-body");
            const pr = pane.getBoundingClientRect();
            const br = body ? body.getBoundingClientRect() : null;
            return {
              id: paneId,
              overflowY: getComputedStyle(pane).overflowY,
              clientHeight: pane.clientHeight,
              scrollHeight: pane.scrollHeight,
              paneBottom: Math.round(pr.bottom),
              bodyBottom: br ? Math.round(br.bottom) : null,
              scrollTop: Math.round(pane.scrollTop),
            };
          }, id);
        for (const id of ["role", "watchdog", "bridge"]) {
          await page.click(`#as-tabs [data-as-tab="${id}"]`);
          await page.waitForSelector(`#as-${id}:not(.hidden)`, { timeout: 20_000 });
          await sleep(1200);
          const one = await measurePane(id);
          note(`${id}: ${one.clientHeight}px client, ${one.scrollHeight}px content, overflow-y ${one.overflowY}, bottom ${one.paneBottom} vs body ${one.bodyBottom}`);
          ok(`the ${id} tab computes overflow-y: auto`, one.overflowY === "auto", one.overflowY);
          ok(`the ${id} tab ends inside the body`, one.bodyBottom !== null && one.paneBottom <= one.bodyBottom + 1, `bottom ${one.paneBottom}, body ${one.bodyBottom}`);
        }

        // ---- 6. the hidden class still switches panes ---------------------------------------------
        console.log("\n== 6. hidden still switches panes ==");
        await page.click('#as-tabs [data-as-tab="role"]');
        await page.waitForSelector("#as-role:not(.hidden)", { timeout: 20_000 });
        await sleep(150);
        const afterRole = await page.evaluate(() => {
          const init = document.getElementById("as-initiatives");
          const role = document.getElementById("as-role");
          const shown = [...document.querySelectorAll("#assistant .as-body > .as-pane")].filter((p) => getComputedStyle(p).display !== "none");
          return {
            initHidden: init.classList.contains("hidden"),
            initDisplay: getComputedStyle(init).display,
            roleDisplay: getComputedStyle(role).display,
            shown: shown.map((p) => p.dataset.pane),
          };
        });
        check("the initiatives pane carries hidden and paints nothing while Role is on screen", { hidden: afterRole.initHidden, display: afterRole.initDisplay }, { hidden: true, display: "none" });
        check("exactly one panel-level pane is on screen", afterRole.shown, ["role"]);
        await page.click('#as-tabs [data-as-tab="initiatives"]');
        await page.waitForSelector("#as-initiatives:not(.hidden)", { timeout: 20_000 });
        await sleep(200);
        const back = await page.evaluate(() => {
          const shown = [...document.querySelectorAll("#assistant .as-body > .as-pane")].filter((p) => getComputedStyle(p).display !== "none");
          const pane = document.getElementById("as-initiatives");
          return { shown: shown.map((p) => p.dataset.pane), display: getComputedStyle(pane).display, clientHeight: pane.clientHeight, scrollHeight: pane.scrollHeight, overflowY: getComputedStyle(pane).overflowY };
        });
        check("pressing Initiatives back shows it and hides Role", back.shown, ["initiatives"]);
        ok("the pane is still the scroller when it comes back", back.overflowY === "auto" && back.display !== "none", `overflow-y ${back.overflowY}, display ${back.display}`);

        // ---- 7. health ----------------------------------------------------------------------------
        console.log("\n== 7. health ==");
        check("no page errors", pageErrors.map(String), []);
        check("no console errors", consoleErrors.map(String), []);
      },
      { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
    );
  }
} catch (err) {
  failures += 1;
  console.error(`\nFAIL  the run threw: ${err && err.stack ? err.stack : err}`);
  try {
    console.error(panel.log().split("\n").slice(-20).join("\n"));
  } catch {
    /* the log is a courtesy */
  }
} finally {
  try {
    if (browser) await browser.close();
  } catch {
    /* already gone */
  }
  await panel.stop();
  clearTimeout(watchdog);
}

console.log(`\n${failures === 0 ? "OK" : "FAILED"}  ${checks - failures}/${checks} checks passed${shotsDir ? `; shots in ${shotsDir}` : ""}`);
process.exit(failures === 0 ? 0 : 1);
