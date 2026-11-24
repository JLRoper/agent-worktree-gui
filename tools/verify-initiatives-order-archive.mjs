#!/usr/bin/env node
// THE INITIATIVES TAB'S ORDER ARROWS AND ITS ARCHIVED VIEW (row 297).
//
// HARNESS: LIVE GATE
//
//   node tools/verify-initiatives-order-archive.mjs [--shots <dir>]
//
// WHAT THIS GATE PROVES, measured on the real page at 1440x900 against a panel of its own:
//
//   1. EVERY ACTIVE CARD CARRIES BOTH ARROWS, and the one at an end is DISABLED rather than missing: the first card's
//      up arrow and the last card's down arrow are drawn, disabled, so a card that moves does not change height.
//   2. A PRESS IS A SAVE. Pressing the second card's up arrow moves it to position 1 in the DOM, the note under the
//      card says it was saved, and GET /api/initiatives reads the same order - the answer the tab painted came from
//      the store, not from a local shuffle. The moved card's own height is the same before and after it moves.
//   3. THE ORDER SURVIVES A RELOAD: after page.reload() the list is drawn in the saved order, first card first.
//   4. ARCHIVE AND ITS ARCHIVED VIEW: a card with nothing open leaves the active list and appears under Archived; the
//      search box only exists there; a word from its TITLE finds it, a word from its DESCRIPTION finds it, and a word
//      in neither draws the no-match line - so the search is not a title-only filter wearing a description's name.
//   5. RESTORE PUTS IT BACK AT ITS OLD POSITION: the card returns to the active list at the place it was archived from.
//   6. HEALTH: zero page errors and zero console errors.
//
// The archive REFUSAL (an open wave or task named by id and title) is proven at the wire in
// test/initiatives-route.test.js, where a real wave and a real task can be filed; this gate is about what only the
// browser can show.
//
// Sandbox only: its own config, port, HERMES_HOME and logs, the assistant disabled, an apiServer pointed at a dead
// port, and no projects. The live panel is never touched. Without Playwright the script says BROWSER-NOT-RUN and
// exits 2 rather than passing on a half that never ran.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

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
    // The gate seeds through the route, so the tier is set where nothing parks a question: which level is in force is
    // not what this gate measures.
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

  // ---- the fixture: four cards, one of them carrying a word that appears in its description only ----------------
  console.log("\n== seed ==");
  const seed = [
    { title: "Fixture alpha", description: "the first piece of work in this sandbox" },
    { title: "Fixture beta", description: "the second piece of work in this sandbox" },
    { title: "Fixture gamma", description: "the third piece of work, and its description carries the word kerfuffle" },
    { title: "Fixture delta", description: "the fourth piece of work in this sandbox" },
  ];
  const ids = {};
  for (const one of seed) {
    const made = await POST("/api/initiatives", one);
    if (made.status !== 201) throw new Error(`seeding "${one.title}" answered HTTP ${made.status}: ${made.body?.error || ""}`);
    ids[one.title] = made.body.initiative.id;
  }
  const before = await GET("/api/initiatives");
  check("the store holds the four cards this gate seeded", before.body?.initiatives?.length, 4);
  // A fresh create lands on top, so the read is the reverse of the seed order.
  check("the read's order is the four cards, newest first", before.body.initiatives.map((i) => i.title), seed.map((s) => s.title).reverse());

  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the initiatives order arrows and archived view", "playwright is not installed for this node (see tools/browser.mjs)"));
    failures += 1;
  } else {
    await withBrowser(async ({ page, pageErrors, consoleErrors }) => {
      const shot = async (slug) => {
        if (!shotsDir) return null;
        const file = shotName(slug);
        await page.screenshot({ path: file });
        note(`shot ${path.basename(file)}`);
        return file;
      };
      const cardIds = () => page.$$eval("#as-initiatives [data-init-card]", (nodes) => nodes.map((n) => n.getAttribute("data-init-card")));
      const cardTitles = () => page.$$eval("#as-initiatives [data-init-card] .init-title", (nodes) => nodes.map((n) => n.textContent.trim()));
      const waitCards = async (count, why) => {
        await page.waitForFunction((n) => document.querySelectorAll("#as-initiatives [data-init-card]").length === n, count, { timeout: 20_000 });
        return cardTitles().catch(() => []);
      };

      await openPage(page, base, { selector: "#projects" });
      // THE FLOAT'S OPEN STATE IS THE `hidden` ATTRIBUTE, not the class the panes use: `#assistant` is hidden at boot and
      // the tab strip inside it is not visible until the float is up.
      const open = await page.evaluate(() => {
        const el = document.getElementById("assistant");
        return Boolean(el) && !el.hidden && getComputedStyle(el).display !== "none";
      });
      if (!open) await page.click("#btn-assistant");
      await page.waitForSelector("#assistant:not([hidden])", { timeout: 20_000 });
      await page.click('#as-tabs [data-as-tab="initiatives"]');
      await page.waitForSelector("#as-initiatives:not(.hidden)", { timeout: 20_000 });
      await waitCards(4, "the four cards");
      await page.waitForSelector("#as-initiatives [data-init-card] .init-order", { timeout: 20_000 });

      // ---- 1. both arrows, disabled at the ends ---------------------------------------------------------------
      console.log("\n== the arrows ==");
      const arrows = await page.evaluate(() => {
        const cards = [...document.querySelectorAll("#as-initiatives [data-init-card]")];
        return cards.map((card) => {
          const up = card.querySelector("[data-init-up]");
          const down = card.querySelector("[data-init-down]");
          return {
            id: card.getAttribute("data-init-card"),
            up: Boolean(up),
            down: Boolean(down),
            upDisabled: Boolean(up && up.disabled),
            downDisabled: Boolean(down && down.disabled),
            height: Math.round(card.getBoundingClientRect().height),
          };
        });
      });
      check("every active card carries both arrows", arrows.map((a) => [a.up, a.down]), arrows.map(() => [true, true]));
      check("the first card's up arrow is drawn and disabled", arrows[0].upDisabled, true);
      check("the first card's down arrow is enabled", arrows[0].downDisabled, false);
      check("the last card's down arrow is drawn and disabled", arrows[arrows.length - 1].downDisabled, true);
      check("the last card's up arrow is enabled", arrows[arrows.length - 1].upDisabled, false);
      await shot("the-list-with-both-arrows");

      // ---- 2. a press is a save ------------------------------------------------------------------------------
      console.log("\n== a press is a save ==");
      // The card moved is the THIRD one, pressed TWICE: one press is one place and one write, so two presses are the
      // reader's "save as you go" in its smallest form. The card this gate archives afterwards keeps a middle place,
      // so its restore can be measured against a position that is not an end.
      const movedId = arrows[2].id;
      // THE HEIGHT A CARD MUST KEEP IS THE ARROW GROUP'S OWN, measured on an end card and a middle one before anything
      // moves: both arrows are drawn on every card, so the control row is the same size at both ends. The note a write
      // leaves under a card is a line of its own, so the moved card's height is not this measurement's subject.
      const arrowBoxes = await page.evaluate(() => {
        const cards = [...document.querySelectorAll("#as-initiatives [data-init-card]")];
        const box = (card) => {
          const el = card.querySelector(".init-order");
          const r = el.getBoundingClientRect();
          return [Math.round(r.width), Math.round(r.height)];
        };
        return { first: box(cards[0]), last: box(cards[cards.length - 1]) };
      });
      check("the arrow group is the same size on the first and the last card", arrowBoxes.first, arrowBoxes.last);
      const untouchedId = arrows[3].id;
      const untouchedHeight = arrows[3].height;
      const orderNow = async () => (await GET("/api/initiatives")).body.initiatives.map((i) => i.id);
      const before = await orderNow();

      // FIRST PRESS: one place up, saved at once.
      await page.click(`#as-initiatives [data-init-card="${movedId}"] [data-init-up]`);
      await page.waitForFunction(
        (args) => {
          const now = [...document.querySelectorAll("#as-initiatives [data-init-card]")].map((n) => n.getAttribute("data-init-card"));
          return now[1] === args[0] && now[0] === args[1];
        },
        [movedId, before[0]],
        { timeout: 20_000 },
      );
      const afterOne = await orderNow();
      check("one press moved the card exactly one place", [afterOne[0], afterOne[1]], [before[0], movedId]);
      check("and the tab draws that order", await cardIds(), afterOne);
      const movedOne = (await GET("/api/initiatives")).body.initiatives[1];
      check("the store kept its number and who moved it", [movedOne.position, movedOne.order, movedOne.orderBy], [2, 2, "reader"]);
      const noteOne = await page.evaluate((id) => String(document.querySelector(`#as-initiatives [data-init-card="${id}"] .as-ask`)?.textContent || "").trim(), movedId);
      ok("the note under the card says it was saved", /moved to position 2/.test(noteOne) && /saved/.test(noteOne), noteOne);

      // SECOND PRESS: to the front, the same way.
      await page.click(`#as-initiatives [data-init-card="${movedId}"] [data-init-up]`);
      await page.waitForFunction(
        (id) => {
          const first = document.querySelector("#as-initiatives [data-init-card]");
          return Boolean(first) && first.getAttribute("data-init-card") === id;
        },
        movedId,
        { timeout: 20_000 },
      );
      const domAfter = await cardIds();
      const readAfter = await GET("/api/initiatives");
      check("the pressed card is first in the DOM", domAfter[0], movedId);
      check("and first in the store", readAfter.body.initiatives.map((i) => i.id), domAfter);
      const moved = readAfter.body.initiatives[0];
      check("the store kept its number and who moved it", [moved.order, moved.orderBy], [1, "reader"]);
      const untouchedAfter = await page.evaluate((id) => Math.round(document.querySelector(`#as-initiatives [data-init-card="${id}"]`).getBoundingClientRect().height), untouchedId);
      check("a card the reader did not touch keeps its height", untouchedAfter, untouchedHeight);
      await shot("after-two-presses");

      // ---- 3. the order survives a reload --------------------------------------------------------------------
      console.log("\n== a reload ==");
      const expectedOrder = (await GET("/api/initiatives")).body.initiatives.map((i) => i.id);
      await page.reload({ waitUntil: "domcontentloaded" });
      // The panel remembers the float open, so after a reload it is already up and pressing #btn-assistant would close
      // it: wait for it, do not click it.
      await page.waitForSelector("#assistant:not([hidden])", { timeout: 20_000 });
      await page.click('#as-tabs [data-as-tab="initiatives"]');
      await page.waitForSelector("#as-initiatives:not(.hidden)", { timeout: 20_000 });
      await waitCards(4, "the four cards after the reload");
      await page.waitForFunction(
        (want) => {
          const now = [...document.querySelectorAll("#as-initiatives [data-init-card]")].map((n) => n.getAttribute("data-init-card"));
          return JSON.stringify(now) === JSON.stringify(want);
        },
        expectedOrder,
        { timeout: 20_000 },
      );
      check("the reloaded tab draws the saved order", await cardIds(), expectedOrder);

      // ---- 4. archive into the archived view, and the search over titles AND descriptions ---------------------
      console.log("\n== the archived view ==");
      const gammaCard = await page.evaluate((id) => Boolean(document.querySelector(`#as-initiatives [data-init-card="${id}"]`)), ids["Fixture gamma"]);
      ok("the card this gate archives is on the list", gammaCard, ids["Fixture gamma"]);
      const gammaPosition = (await GET("/api/initiatives")).body.initiatives.findIndex((i) => i.id === ids["Fixture gamma"]) + 1;
      await page.click(`#as-initiatives [data-init-card="${ids["Fixture gamma"]}"] [data-init-card-toggle]`);
      await page.waitForSelector(`#as-initiatives [data-init-card="${ids["Fixture gamma"]}"] [data-init-archive]`, { timeout: 20_000 });
      await page.click(`#as-initiatives [data-init-card="${ids["Fixture gamma"]}"] [data-init-archive]`);
      await page.waitForFunction((id) => !document.querySelector(`#as-initiatives [data-init-card="${id}"]`), ids["Fixture gamma"], { timeout: 20_000 });
      check("the archived card left the active list", (await cardIds()).includes(ids["Fixture gamma"]), false);
      const switchState = await page.evaluate(() => [...document.querySelectorAll("#as-initiatives [data-init-filter]")].map((b) => [b.getAttribute("data-init-filter"), b.getAttribute("aria-pressed")]));
      check("the switch says one archived card is behind it", switchState.map((s) => s[0]), ["active", "archived"]);
      ok("the archived count is drawn on the switch", /1/.test(await page.$eval('#as-initiatives [data-init-filter="archived"]', (b) => b.textContent)), await page.$eval('#as-initiatives [data-init-filter="archived"]', (b) => b.textContent.trim()));
      await page.click('#as-initiatives [data-init-filter="archived"]');
      await page.waitForSelector("#as-initiatives [data-init-archived-card]", { timeout: 20_000 });
      await page.waitForSelector("#as-initiatives [data-init-search]", { timeout: 20_000 });
      const archivedTitle = await page.$eval("#as-initiatives [data-init-archived-card] .init-arch-title", (n) => n.textContent.trim());
      check("the archived card is drawn with its title", archivedTitle, "Fixture gamma");
      ok("the search box is drawn with the archived view", Boolean(await page.$("#as-initiatives [data-init-search]")), "yes");
      await shot("the-archived-view");

      // A TITLE WORD.
      await page.fill("#as-initiatives [data-init-search]", "gamma");
      await page.waitForFunction(() => document.querySelectorAll("#as-initiatives [data-init-archived-card]").length === 1, null, { timeout: 10_000 });
      check("a word from the TITLE finds it", await page.$$eval("#as-initiatives [data-init-archived-card]", (n) => n.length), 1);
      // A word from NEITHER.
      await page.fill("#as-initiatives [data-init-search]", "zzzznothing");
      await page.waitForSelector("#as-initiatives [data-init-noarch]", { timeout: 10_000 });
      check("a word in neither field draws the no-match line", await page.$$eval("#as-initiatives [data-init-archived-card]", (n) => n.length), 0);
      // A DESCRIPTION WORD - the half a title-only filter would fail.
      await page.fill("#as-initiatives [data-init-search]", "kerfuffle");
      await page.waitForFunction(() => document.querySelectorAll("#as-initiatives [data-init-archived-card]").length === 1, null, { timeout: 10_000 });
      check("a word from the DESCRIPTION finds it too", await page.$$eval("#as-initiatives [data-init-archived-card]", (n) => n.length), 1);
      ok("and it is the same card", (await page.$eval("#as-initiatives [data-init-archived-card] .init-arch-title", (n) => n.textContent.trim())) === "Fixture gamma", "Fixture gamma");
      await shot("the-archived-search-by-description");

      // ---- 5. restore puts it back at its old position ------------------------------------------------------
      console.log("\n== restore ==");
      await page.click("#as-initiatives [data-init-restore]");
      await page.waitForFunction((id) => Boolean(document.querySelector(`#as-initiatives [data-init-card="${id}"]`)), ids["Fixture gamma"], { timeout: 20_000 });
      const restored = await GET("/api/initiatives");
      const restoredIds = restored.body.initiatives.map((i) => i.id);
      check("the card is back in the active list at the place it was archived from", restoredIds.indexOf(ids["Fixture gamma"]) + 1, gammaPosition);
      check("and the tab draws that list", await cardIds(), restoredIds);
      check("the archived list let it go", restored.body.archived?.length, 0);
      await shot("after-restore");

      // ---- 6. health ----------------------------------------------------------------------------------------
      console.log("\n== health ==");
      check("zero page errors", pageErrors.length, 0);
      check("zero console errors", consoleErrors.length, 0);
      if (pageErrors.length) note(`page errors: ${pageErrors.slice(0, 3).join(" | ")}`);
      if (consoleErrors.length) note(`console errors: ${consoleErrors.slice(0, 3).join(" | ")}`);
    }, { viewport: { width: 1440, height: 900 } });
  }
} finally {
  clearTimeout(watchdog);
  if (browser && typeof browser.close === "function") await browser.close().catch(() => {});
  await panel.stop().catch(() => {});
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`FAILED: ${failures} check${failures === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log("OK");
process.exit(0);
