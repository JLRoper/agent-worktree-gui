#!/usr/bin/env node
// EVERY FOLD IN THE INITIATIVES TAB OPENS DOWNWARD, AND THE PRESSED HEAD STAYS UNDER THE POINTER.
//
//   node tools/verify-initiative-folds.mjs [--shots <dir>]
//
// HARNESS: LIVE GATE
//
// OVER A SYNTHETIC PANE. tools/initiatives-fixture.mjs writes four initiatives, their trees, two assistants' queues
// and the wave store, and this gate boots its own server.js against that home under the scratch root - the reader's
// live panel on 7331 and its store are never touched. Two of the cards carry a note log seeded here, so the notes
// fold is measured on a real list rather than on an empty wording.
//
// WHAT THIS GATE PROVES:
//
//   1. A FRESH RENDER DRAWS NOTES AND PROJECTS FOLDED. Every card's notes head reads aria-expanded "false", its body
//      carries `hidden` and has no client rects, and no project row anywhere in the pane has a tree list under it.
//   2. A NOTES PRESS UNFOLDS, AND REMEMBERS PER INITIATIVE. Unfolding one card's log leaves the other card's shut,
//      a tab repaint (its own Refresh press) keeps both as the reader left them, and a second press folds it again.
//   3. EVERY PROJECT ROW FOLDS. For every project row on every card: the row starts folded, a press draws its trees
//      under it (counted against the row's own chip), and a second press takes them away.
//   4. THE PRESSED HEAD IS HELD AT THE FOOT. For notes, assistants, history, each project row on the card at the
//      pane's foot, and the card's own title row: the pane is parked at its foot (scrollTop at its maximum, the state
//      the keeper's foot rule exists for), a real mouse press lands on the head itself, and afterwards
//        - the pressed head's own rect.top is unchanged within 1px, and
//        - the pane's scrollTop did not follow the growth to the new end, and
//        - the content the press inserted starts at or below the head's bottom.
//      Before the fix the foot rule parked the pane at its new end and the head slid up by the whole growth. The same
//      capture covers the two smaller expandables (the description's show more and the tasks' one-more-slice), which
//      press through the same listener and the same hold.
//   5. A FRESH RENDER AFTER ALL OF THAT still reads folded: the page is reloaded, one card is opened, and its notes
//      and project rows are folded again.
//
// Screenshots: one before and one after every held press, plus the fresh default and its folded state, in
// <shots>/ (scratch by default). Every check prints PASS/FAIL with the numbers it read.
//
// Exit codes: 0 every check held; 1 one failed; 2 the run could not measure what it claims (no Playwright, no
// fixture, no card). Nothing here needs the reader's panel, a gateway or a network.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { buildFixture, startFixturePanel, waitForFixtureRows, waitForInitiativesView } from "./initiatives-fixture.mjs";

const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 240_000);
const watchdog = setTimeout(() => {
  try {
    process.stderr.write(`WATCHDOG: ${WATCHDOG_MS}ms elapsed without the run finishing - see the last line printed above.\n`);
  } catch {
    /* nothing left to do */
  }
  process.exit(1);
}, WATCHDOG_MS);

let checks = 0;
let failures = 0;
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` - ${extra}` : ""}`);
  }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SHOTS = path.resolve(opt("--shots", path.join(os.tmpdir(), "wag", "initiative-folds-shots")));
mkdirSync(SHOTS, { recursive: true });
const shot = (slug) => path.join(SHOTS, `${slug}.png`);
// The fixture's home is its own store root, never the reader's: `--home` is here so a run can point it at its scratch
// folder, and the default is the fixture's own (tools/initiatives-fixture.mjs).
const HOME = opt("--home", "");

// The synthetic pane's own facts.
const SSO = "init_sso";
const RELEASE = "init_release";
const KAFKA = "init_kafka";
const withCard = (id) => `[data-init-card="${id}"]`;

const playwright = loadPlaywright({ root: path.join(import.meta.dirname, "..") });
if (!playwright) {
  console.log(notRun("the initiative folds", "playwright is not installed for this node (see tools/browser.mjs)"));
  process.exit(2);
}

// A note log on two cards, written into the fixture's store BEFORE its panel boots: the fold is measured on a real
// list, and the count on the head is a real count.
const now = Date.now();
const seedNote = (id, text, minutesAgo) => ({ id, at: new Date(now - minutesAgo * 60_000).toISOString(), by: "reader", kind: "note", text });
const built = await buildFixture(HOME ? { home: path.resolve(HOME) } : {});
const storeDoc = JSON.parse(readFileSync(built.files.initiatives, "utf8"));
const putNotes = (id, notes) => {
  const rec = (storeDoc.initiatives || []).find((i) => i.id === id);
  if (!rec) throw new Error(`the fixture did not write ${id}`);
  rec.notes = notes;
};
putNotes(SSO, [
  seedNote("note_fold_sso_1", "Decided the Menu login flips behind the toggle, not before it.", 90),
  seedNote("note_fold_sso_2", "The real two-factor login is the gate on the flip.", 40),
]);
putNotes(KAFKA, [seedNote("note_fold_kafka_1", "The retry topic keeps its partition count until the pack is signed.", 30)]);
writeFileSync(built.files.initiatives, `${JSON.stringify(storeDoc, null, 2)}\n`, "utf8");

const panel = await startFixturePanel({ home: built.home });
let verdict = null;
try {
  await waitForFixtureRows(panel.base);
  const view = await waitForInitiativesView(panel.base);
  const ids = (view.initiatives || []).map((i) => i.id);
  ok(`${SSO}, ${RELEASE}, ${KAFKA} are in the pane this gate measures`, [SSO, RELEASE, KAFKA].every((id) => ids.includes(id)), ids.join(", "));

  verdict = await withBrowser(
    async ({ page, pageErrors, consoleErrors }) => {
      // ---- the page's own helpers ---------------------------------------------------------------------------------
      // Every measurement below reads the box the pane's OWN rule scrolls (initScrollerOf in public/assistant.js):
      // the pane when it overflows, else the float's body. The four lines are repeated in each evaluate rather than
      // handed in as a string: no eval in a page, and no second opinion about which box is the scroller.

      const openTab = async () => {
        const floatOpen = await page.evaluate(() => {
          const el = document.getElementById("assistant");
          return Boolean(el) && !el.hidden && getComputedStyle(el).display !== "none";
        });
        if (!floatOpen) await page.click("#btn-assistant");
        await page.waitForSelector("#assistant:not([hidden])", { timeout: 20_000 });
        await page.click('#as-tabs [data-as-tab="initiatives"]');
        await page.waitForSelector("#as-initiatives .init-card", { timeout: 40_000 });
      };

      // Every card opened, so every fold the tab draws is on the page. A card is a fold of its own and this gate is
      // not about it: the press below is on the card's toggle, not on any fold under test.
      const openEveryCard = async () => {
        const toggles = await page.$$eval("#as-initiatives .init-card [data-init-card-toggle]", (nodes) =>
          nodes.map((n) => n.getAttribute("data-init-card-toggle")),
        );
        for (const id of toggles) {
          const sel = `${withCard(id)} [data-init-card-toggle]`;
          if ((await page.locator(sel).getAttribute("aria-expanded")) !== "true") await page.locator(sel).click();
        }
        await page.waitForFunction(
          () => [...document.querySelectorAll("#as-initiatives .init-card [data-init-card-toggle]")].every((n) => n.getAttribute("aria-expanded") === "true"),
          undefined,
          { timeout: 20_000 },
        );
        return toggles;
      };

      // What the drawn DOM says about one fold head: its rect, its aria state, the content it controls and whether
      // that content has a box. `visible` is a box measurement, never a class name.
      const readFold = (headSel, contentSel) =>
        page.evaluate(
          ({ headSel, contentSel }) => {
            const host = document.getElementById("as-initiatives");
            const body = host.closest(".as-body");
            const sc = host.scrollHeight > host.clientHeight + 1 ? host : body && body.scrollHeight > body.clientHeight + 1 ? body : host;
            const head = document.querySelector(headSel);
            const box = sc.getBoundingClientRect();
            if (!head) return { missing: true, boxTop: box.top, boxBottom: box.bottom, scrollTop: sc.scrollTop, max: sc.scrollHeight - sc.clientHeight };
            const r = head.getBoundingClientRect();
            const content = contentSel ? document.querySelector(contentSel) : null;
            const cr = content ? content.getBoundingClientRect() : null;
            const visible = (el) => Boolean(el) && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none";
            return {
              missing: false,
              top: r.top,
              bottom: r.bottom,
              rel: r.top - box.top,
              height: r.height,
              expanded: head.getAttribute("aria-expanded"),
              text: head.textContent.replace(/\s+/g, " ").trim().slice(0, 90),
              controls: head.getAttribute("aria-controls") || "",
              content: cr ? { top: cr.top, height: cr.height, visible: visible(content) } : null,
              scrollTop: sc.scrollTop,
              max: sc.scrollHeight - sc.clientHeight,
              boxTop: box.top,
              boxBottom: box.bottom,
            };
          },
          { headSel, contentSel: contentSel || "" },
        );

      // Park the pane at its foot - the state the keeper's foot rule exists for - and report the numbers it parked
      // with. `scrollTop = scrollHeight` is clamped by the browser to the pane's own maximum.
      const parkAtFoot = () =>
        page.evaluate(() => {
          const host = document.getElementById("as-initiatives");
          const body = host.closest(".as-body");
          const sc = host.scrollHeight > host.clientHeight + 1 ? host : body && body.scrollHeight > body.clientHeight + 1 ? body : host;
          sc.scrollTop = sc.scrollHeight;
          const box = sc.getBoundingClientRect();
          return { top: sc.scrollTop, max: sc.scrollHeight - sc.clientHeight, ch: sc.clientHeight, boxTop: box.top, boxBottom: box.bottom };
        });

      // The head under the pointer: a real mouse press at the head's own centre, after proving the point resolves to
      // that head (Playwright's click would scroll the target into view, which is the very thing under test).
      const pressHead = async (headSel) => {
        const bb = await page.locator(headSel).boundingBox();
        if (!bb) return { pressed: false, reason: "no box" };
        const x = bb.x + bb.width / 2;
        const y = bb.y + bb.height / 2;
        const hit = await page.evaluate(
          ({ x, y, headSel }) => {
            const at = document.elementFromPoint(x, y);
            return Boolean(at && at.closest(headSel));
          },
          { x, y, headSel },
        );
        if (!hit) return { pressed: false, reason: `elementFromPoint(${Math.round(x)}, ${Math.round(y)}) is not the head` };
        await page.mouse.click(x, y);
        return { pressed: true, x: Math.round(x), y: Math.round(y) };
      };

      // ---- 1. A FRESH RENDER: NOTES AND PROJECTS FOLDED -----------------------------------------------------------
      await openPage(page, panel.base, { selector: "#projects" });
      await openTab();
      const cards = await openEveryCard();
      eq("every fixture card is drawn and opened on a fresh render", cards.length, 4);
      await page.evaluate(() => {
        const host = document.getElementById("as-initiatives");
        const sc = host.scrollHeight > host.clientHeight + 1 ? host : host.closest(".as-body") || host;
        sc.scrollTop = 0;
      });
      await page.screenshot({ path: shot("01-fresh-render") });

      const defaults = await page.evaluate(() =>
        [...document.querySelectorAll("#as-initiatives .init-card")].map((card) => {
          const id = card.getAttribute("data-init-card");
          const notesHead = card.querySelector("[data-init-notes-fold]");
          const notesBody = card.querySelector(".init-notesbody");
          const projects = [...card.querySelectorAll("[data-init-fold]")].map((b) => ({
            key: b.getAttribute("data-init-fold"),
            expanded: b.getAttribute("aria-expanded"),
            trees: Boolean(b.parentElement && b.parentElement.querySelector(":scope > .init-trees")),
          }));
          const assistsHead = card.querySelector("[data-init-assist-fold]");
          const histHead = card.querySelector("[data-init-history-fold]");
          return {
            id,
            notes: notesHead
              ? {
                  expanded: notesHead.getAttribute("aria-expanded"),
                  bodyHidden: Boolean(notesBody && notesBody.hasAttribute("hidden")),
                  bodyRects: notesBody ? notesBody.getClientRects().length : 0,
                  count: card.querySelector("[data-init-notes-count]")?.textContent.trim(),
                }
              : null,
            projects,
            assists: assistsHead ? assistsHead.getAttribute("aria-expanded") : null,
            history: histHead ? histHead.getAttribute("aria-expanded") : null,
          };
        }),
      );
      const byId = (id) => defaults.find((c) => c.id === id);
      ok("every card draws a notes head on a fresh render", defaults.every((c) => c.notes), JSON.stringify(defaults.map((c) => [c.id, Boolean(c.notes)])));
      eq(
        "every card's notes read FOLDED on a fresh render",
        defaults.map((c) => [c.id, c.notes?.expanded, c.notes?.bodyHidden, c.notes?.bodyRects]),
        defaults.map((c) => [c.id, "false", true, 0]),
      );
      ok("the folded notes head still carries its count", byId(SSO)?.notes?.count === "2" && byId(KAFKA)?.notes?.count === "1", `${byId(SSO)?.notes?.count} / ${byId(KAFKA)?.notes?.count}`);
      const everyProject = defaults.flatMap((c) => c.projects.map((p) => ({ id: c.id, ...p })));
      ok("the pane draws project rows to fold", everyProject.length >= 6, `${everyProject.length} project rows: ${everyProject.map((p) => `${p.id}::${p.key.split("::")[1]}`).join(", ")}`);
      ok(
        "every project row reads FOLDED with no tree list drawn under it",
        everyProject.every((p) => p.expanded === "false" && p.trees === false),
        JSON.stringify(everyProject.filter((p) => p.expanded !== "false" || p.trees)),
      );
      eq("the assistants and history folds are shut on a fresh render", defaults.map((c) => [c.assists, c.history]), defaults.map(() => ["false", "false"]));

      // ---- 2. A NOTES PRESS UNFOLDS, AND REMEMBERS PER INITIATIVE -------------------------------------------------
      const notesHead = (id) => `${withCard(id)} [data-init-notes-fold]`;
      const notesBody = (id) => `.init-notesbody#init-notes-body-${id}`;
      await page.locator(notesHead(SSO)).click();
      await page.waitForFunction((s) => document.querySelector(s)?.getAttribute("aria-expanded") === "true", notesHead(SSO), { timeout: 15_000 });
      const ssoOpen = await readFold(notesHead(SSO), notesBody(SSO));
      eq("a press on the notes head unfolds the log", [ssoOpen.expanded, ssoOpen.content?.visible], ["true", true]);
      ok("the unfolded body starts under its own head", ssoOpen.content && ssoOpen.content.top >= ssoOpen.bottom - 0.5, `${ssoOpen.content?.top} vs head bottom ${ssoOpen.bottom}`);
      eq("the unfolded list draws the seeded notes", await page.$$eval(`${withCard(SSO)} [data-init-note]`, (n) => n.length), 2);

      await page.locator(notesHead(RELEASE)).click();
      await page.waitForFunction((s) => document.querySelector(s)?.getAttribute("aria-expanded") === "true", notesHead(RELEASE), { timeout: 15_000 });
      const apart = { sso: await readFold(notesHead(SSO)), release: await readFold(notesHead(RELEASE)), kafka: await readFold(notesHead(KAFKA)) };
      eq("unfolding a second card's notes leaves the first unfolded, and the third shut", [apart.sso.expanded, apart.release.expanded, apart.kafka.expanded], ["true", "true", "false"]);

      await page.click("#as-initiatives [data-init-refresh]");
      await page.waitForFunction(
        (s) => document.querySelector(s)?.getAttribute("aria-expanded") === "true",
        notesHead(SSO),
        { timeout: 25_000 },
      );
      const afterRefresh = { sso: await readFold(notesHead(SSO)), release: await readFold(notesHead(RELEASE)) };
      eq("a repaint keeps each card's notes where the reader left it", [afterRefresh.sso.expanded, afterRefresh.release.expanded], ["true", "true"]);

      await page.locator(notesHead(SSO)).click();
      await page.waitForFunction((s) => document.querySelector(s)?.getAttribute("aria-expanded") === "false", notesHead(SSO), { timeout: 15_000 });
      const foldedAgain = { sso: await readFold(notesHead(SSO)), release: await readFold(notesHead(RELEASE)) };
      eq("a second press folds it again, and only it", [foldedAgain.sso.expanded, foldedAgain.release.expanded], ["false", "true"]);
      // Back to folded for the foot test.
      await page.locator(notesHead(RELEASE)).click();
      await page.waitForFunction((s) => document.querySelector(s)?.getAttribute("aria-expanded") === "false", notesHead(RELEASE), { timeout: 15_000 });

      // ---- 3. EVERY PROJECT ROW FOLDS ----------------------------------------------------------------------------
      let projectRows = 0;
      for (const id of cards) {
        const rows = await page.$$eval(`${withCard(id)} [data-init-fold]`, (nodes) =>
          nodes.map((n) => ({
            key: n.getAttribute("data-init-fold"),
            chip: Number((n.querySelector(".chip")?.textContent || "").replace(/[^0-9]/g, "")),
          })),
        );
        for (const row of rows) {
          projectRows += 1;
          const sel = `${withCard(id)} [data-init-fold="${row.key}"]`;
          const trees = `${sel} + .init-trees`;
          const folded = await readFold(sel, trees);
          ok(`${row.key}: the row starts folded`, folded.expanded === "false" && folded.content === null, `expanded=${folded.expanded}`);
          await page.locator(sel).click();
          await page.waitForFunction((s) => document.querySelector(s)?.getAttribute("aria-expanded") === "true", sel, { timeout: 15_000 });
          const opened = await readFold(sel, trees);
          const drawn = await page.$$eval(`${withCard(id)} [data-init-fold="${row.key}"] + .init-trees .init-tree`, (n) => n.length);
          eq(`${row.key}: a press unfolds it`, opened.expanded, "true");
          eq(`${row.key}: the trees drawn are the ones the row counts`, drawn, row.chip);
          ok(`${row.key}: the trees start under the row's own bottom`, opened.content && opened.content.visible && opened.content.top >= opened.bottom - 0.5, `${opened.content?.top} vs row bottom ${opened.bottom}`);
          await page.locator(sel).click();
          await page.waitForFunction((s) => document.querySelector(s)?.getAttribute("aria-expanded") === "false", sel, { timeout: 15_000 });
          const shut = await readFold(sel, trees);
          ok(`${row.key}: a second press folds it, and the list is gone`, shut.expanded === "false" && shut.content === null, `expanded=${shut.expanded}, content=${Boolean(shut.content)}`);
        }
      }
      ok("every project row in the pane was pressed both ways", projectRows === everyProject.length, `${projectRows} pressed, ${everyProject.length} drawn`);

      // ---- 4. THE PRESSED HEAD IS HELD AT THE FOOT ---------------------------------------------------------------
      // The anchor for each kind is the LOWEST head of that kind that is fully in view once the pane is parked at its
      // foot. The gate walks the cards from the bottom of the reader's list upward, folds the cards below a candidate
      // to their title rows, parks the pane and takes the first candidate whose head is in the box. That is the
      // reader's own situation - a head near the foot, with its fold's content still to be drawn under it - and it is
      // the state the foot rule used to slide the head out of.
      const cardFacts = await page.evaluate(() =>
        [...document.querySelectorAll("#as-initiatives .init-card")].map((c) => {
          const num = (sel) => Number((c.querySelector(sel)?.textContent || "").replace(/[^0-9]/g, ""));
          const id = c.getAttribute("data-init-card");
          return {
            id,
            notes: num("[data-init-notes-count]"),
            assists: num("[data-init-assist-count]"),
            history: num("[data-init-hist-count]"),
            projects: c.querySelectorAll("[data-init-fold]").length,
          };
        }),
      );
      ok("the pane draws the fixture's cards in a list this gate can walk", cardFacts.length === 4, cardFacts.map((c) => c.id).join(", "));

      const foldCard = async (id) => {
        const sel = `${withCard(id)} [data-init-card-toggle]`;
        if ((await page.locator(sel).getAttribute("aria-expanded")) === "true") await page.locator(sel).click();
        await page.waitForFunction((s) => document.querySelector(s)?.getAttribute("aria-expanded") === "false", sel, { timeout: 15_000 });
      };
      const openCard = async (id) => {
        const sel = `${withCard(id)} [data-init-card-toggle]`;
        if ((await page.locator(sel).getAttribute("aria-expanded")) !== "true") await page.locator(sel).click();
        await page.waitForFunction((s) => document.querySelector(s)?.getAttribute("aria-expanded") === "true", sel, { timeout: 15_000 });
      };
      const pickAnchor = async (headSelOf, has) => {
        for (let i = cardFacts.length - 1; i >= 0; i -= 1) {
          const c = cardFacts[i];
          if (!has(c)) continue;
          for (const below of cardFacts.slice(i + 1)) await foldCard(below.id);
          const park = await parkAtFoot();
          const head = await readFold(headSelOf(c.id));
          if (!head.missing && head.rel >= -0.5 && head.bottom <= park.boxBottom + 0.5) return c.id;
        }
        return null;
      };
      // A candidate card's own sections are put back to folded before its project rows are pressed: the rows sit ABOVE
      // them, so an open log would carry the rows out of the pane's box. That fold is a shrink, and a shrink that takes
      // the pane below its own scroll range cannot be held (the pane clamps at its new end) - a physical limit, not a
      // promise this gate breaks, so it is done without an assertion.
      const foldSections = async (id) => {
        for (const sel of [`${withCard(id)} [data-init-history-fold]`, `${withCard(id)} [data-init-assist-fold]`, notesHead(id)]) {
          if ((await page.locator(sel).getAttribute("aria-expanded")) === "true") await page.locator(sel).click();
          await page.waitForFunction((s) => document.querySelector(s)?.getAttribute("aria-expanded") === "false", sel, { timeout: 15_000 });
        }
      };

      const heldPress = async ({ label, headSel, contentSel, slug, wantContent }) => {
        const park = await parkAtFoot();
        ok(`${label}: the pane overflows, so there is a foot to be at`, park.max > 1, `scrollHeight - clientHeight = ${Math.round(park.max)}`);
        ok(`${label}: the pane is parked at its foot`, Math.abs(park.top - park.max) < 1.5, `scrollTop ${park.top} of ${park.max}`);
        const before = await readFold(headSel, contentSel);
        const inView = !before.missing && before.rel >= -0.5 && before.bottom <= park.boxBottom + 0.5;
        ok(`${label}: the head is in view at the foot`, inView, before.missing ? "head missing" : `head ${Math.round(before.rel)}..${Math.round(before.bottom - park.boxTop)} in a ${Math.round(park.ch)}px pane`);
        await page.screenshot({ path: shot(`${slug}-before`) });
        const press = await pressHead(headSel);
        ok(`${label}: the press lands on the head itself`, press.pressed, press.reason || `at ${press.x},${press.y}`);
        if (!press.pressed) return null;
        const after = await readFold(headSel, contentSel);
        ok(`${label}: the pressed head's rect.top is unchanged within 1px`, !after.missing && Math.abs(after.top - before.top) <= 1, `${before.top} -> ${after?.top}`);
        eq(`${label}: the press flipped the fold`, after.expanded, "true");
        ok(`${label}: the pane did not follow the growth to its new end`, Math.abs(after.scrollTop - park.top) <= 1, `scrollTop ${park.top} -> ${after.scrollTop} (new max ${after.max})`);
        ok(`${label}: the new content starts at or below the head's bottom`, Boolean(after.content) && after.content.visible && after.content.top >= after.bottom - 0.5, `content ${after.content?.top} vs head bottom ${after.bottom}, visible=${after.content?.visible}`);
        if (wantContent) ok(`${label}: the press drew ${wantContent}`, after.content && after.content.height > 8, `height ${Math.round(after.content?.height || 0)}`);
        await page.screenshot({ path: shot(`${slug}-after`) });
        return { label, before: before.top, after: after.top, scrollTop: [park.top, after.scrollTop], max: [park.max, after.max], content: after.content?.top };
      };

      const held = [];
      // ---- notes, on the lowest card that carries a log
      let anchor = await pickAnchor(notesHead, (c) => c.notes > 0);
      if (!anchor) anchor = await pickAnchor(notesHead, () => true);
      ok("a notes head sits in view at the pane's foot", Boolean(anchor), anchor || "none of the cards");
      if (anchor) {
        held.push(
          await heldPress({
            label: `${anchor} notes`,
            headSel: notesHead(anchor),
            contentSel: notesBody(anchor),
            slug: "02-notes-at-foot",
            wantContent: "the log",
          }),
        );
      }

      // ---- assistants, on the lowest card that has assistant rows to draw
      const assistsAnchor = await pickAnchor((id) => `${withCard(id)} [data-init-assist-fold]`, (c) => c.assists > 0);
      ok("an assistants head with rows to draw sits in view at the pane's foot", Boolean(assistsAnchor), assistsAnchor || "none of the cards");
      if (assistsAnchor) {
        const content = `${withCard(assistsAnchor)} .init-assists`;
        ok(`${assistsAnchor}: no assistant rows are drawn before the press`, (await page.$$eval(content, (n) => n.length)) === 0);
        held.push(
          await heldPress({
            label: `${assistsAnchor} assistants`,
            headSel: `${withCard(assistsAnchor)} [data-init-assist-fold]`,
            contentSel: content,
            slug: "03-assistants-at-foot",
            wantContent: "the assistant rows",
          }),
        );
      }

      // ---- history, on the lowest card that has lines to draw
      const historyAnchor = await pickAnchor((id) => `${withCard(id)} [data-init-history-fold]`, (c) => c.history > 0);
      ok("a history head with lines to draw sits in view at the pane's foot", Boolean(historyAnchor), historyAnchor || "none of the cards");
      if (historyAnchor) {
        held.push(
          await heldPress({
            label: `${historyAnchor} history`,
            headSel: `${withCard(historyAnchor)} [data-init-history-fold]`,
            contentSel: `${withCard(historyAnchor)} .init-history`,
            slug: "04-history-at-foot",
            wantContent: "the history lines",
          }),
        );
      }

      // ---- each project row of the lowest card that draws any
      // The rows sit above the card's three section heads, so the card is walked from the bottom of the list upward and
      // its own sections are folded first; the check is made on its LAST row, the one nearest the foot, because that is
      // the row whose press draws its trees at the very bottom of the pane.
      let projectAnchor = null;
      let projectRowsAtFoot = [];
      const projectCards = cardFacts
        .filter((c) => c.projects > 0)
        .map((c) => c.id)
        .reverse();
      for (const id of projectCards) {
        const at = cardFacts.findIndex((c) => c.id === id);
        for (const below of cardFacts.slice(at + 1)) await foldCard(below.id);
        await openCard(id);
        await foldSections(id);
        const rows = await page.$$eval(`${withCard(id)} [data-init-fold]`, (nodes) => nodes.map((n) => n.getAttribute("data-init-fold")));
        const lastKey = rows[rows.length - 1] || "";
        const park = await parkAtFoot();
        const head = await readFold(`${withCard(id)} [data-init-fold="${lastKey}"]`);
        if (!head.missing && head.rel >= -0.5 && head.bottom <= park.boxBottom + 0.5) {
          projectAnchor = id;
          projectRowsAtFoot = rows;
          break;
        }
      }
      ok("a card with project rows sits at the pane's foot", Boolean(projectAnchor), projectAnchor || `tried ${projectCards.join(", ")}`);
      if (projectAnchor) {
        ok(`${projectAnchor} draws project rows to press at the foot`, projectRowsAtFoot.length >= 1, projectRowsAtFoot.join(", "));
        // The LAST row first (nearest the foot), then the ones above it: each press grows the card downward, so the
        // order a reader would take them in is bottom-up.
        for (const key of [...projectRowsAtFoot].reverse()) {
          const sel = `${withCard(projectAnchor)} [data-init-fold="${key}"]`;
          held.push(
            await heldPress({
              label: `${key} at the foot`,
              headSel: sel,
              contentSel: `${sel} + .init-trees`,
              slug: `05-project-${key.split("::")[1].replace(/[^a-z0-9]+/gi, "-")}`,
              wantContent: "the tree rows",
            }),
          );
        }
      }

      // ---- the CARD'S OWN TITLE ROW OPENS DOWNWARD TOO ------------------------------------------------------------
      // The biggest expandable in the tab is the card itself, and its title row is the same press: the last card is
      // folded, the pane is parked at its foot, and the head that opens the body stays under the pointer.
      const lastCard = cardFacts[cardFacts.length - 1].id;
      await foldCard(lastCard);
      const cardHeadSel = `${withCard(lastCard)} [data-init-card-toggle]`;
      const cardPark = await parkAtFoot();
      const cardH = () => page.evaluate((sel) => Math.round(document.querySelector(sel).closest(".init-card").getBoundingClientRect().height), cardHeadSel);
      const cardBefore = await readFold(cardHeadSel);
      const cardHeightBefore = await cardH();
      ok(`${lastCard}: a folded card's title row sits in view at the pane's foot`, !cardBefore.missing && cardBefore.rel >= -0.5 && cardBefore.bottom <= cardPark.boxBottom + 0.5, cardBefore.missing ? "head missing" : `head ${Math.round(cardBefore.rel)}..${Math.round(cardBefore.bottom - cardPark.boxTop)}`);
      await page.screenshot({ path: shot("06-card-at-foot-before") });
      const cardPress = await pressHead(cardHeadSel);
      ok(`${lastCard}: the press lands on the title row itself`, cardPress.pressed, cardPress.reason || `at ${cardPress.x},${cardPress.y}`);
      if (cardPress.pressed) {
        const cardAfter = await readFold(cardHeadSel);
        const cardHeightAfter = await cardH();
        ok(`${lastCard}: the title row's rect.top is unchanged within 1px`, Math.abs(cardAfter.top - cardBefore.top) <= 1, `${cardBefore.top} -> ${cardAfter.top}`);
        eq(`${lastCard}: the press opened the card`, cardAfter.expanded, "true");
        // The scroll may move by a few pixels when something ABOVE the card re-wraps in the same rebuild - the hold is
        // what keeps the row still, and it does that by taking exactly that shift out. What it must never do is follow
        // the body to the pane's new end, which is what the foot rule did.
        ok(`${lastCard}: the pane did not follow the body to its new end`, Math.abs(cardAfter.scrollTop - cardAfter.max) > 1, `scrollTop ${cardPark.top} -> ${cardAfter.scrollTop}, new max ${cardAfter.max}`);
        ok(`${lastCard}: the body was drawn under the row`, cardHeightAfter > cardHeightBefore + 100, `${cardHeightBefore}px -> ${cardHeightAfter}px`);
        await page.screenshot({ path: shot("06-card-at-foot-after") });
      }

      // ---- 5. A FRESH RENDER AFTER ALL OF THAT --------------------------------------------------------------------
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("#projects", { timeout: 40_000 });
      await openTab();
      const freshCards = await openEveryCard();
      const fresh = await page.evaluate(() =>
        [...document.querySelectorAll("#as-initiatives .init-card")].map((card) => {
          const id = card.getAttribute("data-init-card");
          const notesHead = card.querySelector("[data-init-notes-fold]");
          const notesBody = card.querySelector(".init-notesbody");
          const rows = [...card.querySelectorAll("[data-init-fold]")].map((b) => ({
            key: b.getAttribute("data-init-fold"),
            expanded: b.getAttribute("aria-expanded"),
            trees: Boolean(b.parentElement && b.parentElement.querySelector(":scope > .init-trees")),
          }));
          return {
            id,
            notes: notesHead ? { expanded: notesHead.getAttribute("aria-expanded"), bodyRects: notesBody ? notesBody.getClientRects().length : 0 } : null,
            rows,
          };
        }),
      );
      eq("the reload drew every card again", fresh.length, freshCards.length);
      ok(
        "a fresh render after every press still draws notes and projects FOLDED",
        fresh.every((c) => c.notes?.expanded === "false" && c.notes?.bodyRects === 0 && c.rows.every((r) => r.expanded === "false" && !r.trees)),
        JSON.stringify(fresh.map((c) => [c.id, c.notes?.expanded, c.rows.length, c.rows.filter((r) => r.expanded !== "false" || r.trees).length])),
      );
      await page.screenshot({ path: shot("06-fresh-after") });

      // ---- health ------------------------------------------------------------------------------------------------
      ok("zero page errors and zero console errors", pageErrors.length === 0 && consoleErrors.length === 0, [...pageErrors, ...consoleErrors].slice(0, 3).join(" | "));
      return { projectRows, held, cards: cards.length, notesCounts: defaults.map((c) => [c.id, c.notes?.count]) };
    },
    { viewport: { width: 1440, height: 900 } },
  );
} finally {
  await panel.stop();
}

clearTimeout(watchdog);
console.log(`\n${failures === 0 ? "OK" : "FAILED"}  ${checks - failures}/${checks} checks passed; shots in ${SHOTS}`);
if (verdict) console.log(`measured: ${JSON.stringify(verdict)}`);
process.exit(failures === 0 ? 0 : 1);
