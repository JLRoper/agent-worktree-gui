#!/usr/bin/env node
// THE NOTES SECTION FOLDS, and the count stays readable while it is shut.
//
//   node tools/verify-initiative-notes-fold.mjs [--shots <dir>]
//
// HARNESS: LIVE GATE
//
// OVER A SYNTHETIC PANE. The four initiatives tools/initiatives-fixture.mjs writes are a pane with notes on it that
// nobody has to type: two notes on init_sso, one on init_release, none on init_sweeper. The fixture boots its own
// server.js against its own WAG_HOME under the scratch root, so the reader's live panel on 7331 and its store are
// never touched, and every reading below comes from the real Initiatives tab drawing those stores - not from markup
// this gate pasted into a page.
//
// WHAT THIS GATE PROVES:
//
//   1. DEFAULT OPEN. A card first painted draws its log: the head reads aria-expanded "true", the list holds the
//      notes the store holds, the write box is there, and the count reads N.
//   2. A PRESS FOLDS IT. The head is a real <button type="button">, a press on it turns aria-expanded to "false",
//      the body carries `hidden`, the list and the write row have no box at all (getClientRects() is empty, so this
//      is a measurement rather than a class name), the section is materially shorter, and .init-notes-count still
//      reads N and is still visible in the folded head.
//   3. A SECOND PRESS UNFOLDS IT, with the same list and the same write row back.
//   4. ENTER AND SPACE BOTH PRESS IT. Focus lands on the head and a real Enter, then a real Space, each flip
//      aria-expanded and the body's hidden attribute - the browser's own button activation, not a key handler this
//      pane had to grow.
//   5. TWO INITIATIVES FOLD APART. Folding init_sso leaves init_release open, folding init_release leaves init_sso
//      shut, and unfolding one does not move the other: the book is keyed by the initiative id.
//   6. A NOTE WHILE FOLDED BUMPS THE COUNT AND LEAVES IT SHUT. A note is written through the real
//      POST /api/initiatives/notes/add route (the writer an assistant's turn uses), the tab is re-read with its own
//      Refresh press, and the folded head goes 2 -> 3 while aria-expanded stays "false" and the body stays hidden:
//      the fold is module state, not a DOM detail the repaint would lose.
//   7. ZERO NOTES STILL DRAWS THE EMPTY WORDING under a pressable head, and that head folds and unfolds like any
//      other.
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
const SHOTS = path.resolve(opt("--shots", path.join(os.tmpdir(), "wag", "initiative-notes-fold-shots")));
mkdirSync(SHOTS, { recursive: true });
const shot = (slug) => path.join(SHOTS, `${slug}.png`);

// The synthetic pane's own facts. The notes are written into the fixture's store BEFORE the panel boots, so the
// first read the tab makes already has a log to draw and the run never waits on a write to begin.
const SSO = "init_sso";
const RELEASE = "init_release";
const SWEEPER = "init_sweeper";
const SSO_NOTES = 2;
const RELEASE_NOTES = 1;
const SSO_CARD = `[data-init-card="${SSO}"]`;
const RELEASE_CARD = `[data-init-card="${RELEASE}"]`;
const SWEEPER_CARD = `[data-init-card="${SWEEPER}"]`;
const headSel = (card) => `${card} [data-init-notes-fold]`;

const playwright = loadPlaywright({ root: path.join(import.meta.dirname, "..") });
if (!playwright) {
  console.log(notRun("the initiative notes fold", "playwright is not installed for this node (see tools/browser.mjs)"));
  process.exit(2);
}

const now = Date.now();
const seedNote = (id, text, minutesAgo) => ({ id, at: new Date(now - minutesAgo * 60_000).toISOString(), by: "reader", kind: "note", text });

const built = await buildFixture({});
// The fixture writes four initiatives with no log. Two of them get a log here, and the third keeps its zero, so the
// empty wording is measured on the same pane as the folded count rather than in a second run with a second store.
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
putNotes(RELEASE, [seedNote("note_fold_rel_1", "The turnover window closes on the last Friday of the quarter.", 25)]);
writeFileSync(built.files.initiatives, `${JSON.stringify(storeDoc, null, 2)}\n`, "utf8");
const readStore = () => JSON.parse(readFileSync(built.files.initiatives, "utf8"));
const notesInStore = (id) => {
  const rec = (readStore().initiatives || []).find((i) => i.id === id);
  return Array.isArray(rec?.notes) ? rec.notes : [];
};

const panel = await startFixturePanel({ home: built.home });
let verdict = null;
try {
  await waitForFixtureRows(panel.base);
  const view = await waitForInitiativesView(panel.base);
  const card = (id) => (view.initiatives || []).find((i) => i.id === id);
  eq("the synthetic pane carries the notes this gate seeded", [card(SSO)?.noteCount, card(RELEASE)?.noteCount, card(SWEEPER)?.noteCount], [SSO_NOTES, RELEASE_NOTES, 0]);

  verdict = await withBrowser(
    async ({ page, pageErrors, consoleErrors }) => {
      await openPage(page, panel.base, { selector: "#projects" });
      const floatOpen = await page.evaluate(() => {
        const el = document.getElementById("assistant");
        return Boolean(el) && !el.hidden && getComputedStyle(el).display !== "none";
      });
      if (!floatOpen) await page.click("#btn-assistant");
      await page.waitForSelector("#assistant:not([hidden])", { timeout: 20_000 });
      await page.click('#as-tabs [data-as-tab="initiatives"]');
      await page.waitForSelector("#as-initiatives .init-card", { timeout: 40_000 });

      const openCard = async (cardSel) => {
        const toggle = `${cardSel} [data-init-card-toggle]`;
        await page.waitForSelector(toggle, { timeout: 20_000 });
        if ((await page.locator(toggle).getAttribute("aria-expanded")) !== "true") await page.locator(toggle).click();
        await page.waitForSelector(`${cardSel} [data-init-notes]`, { timeout: 20_000 });
      };

      // ONE READING OF THE SECTION, taken from the drawn DOM. `visible` is a box measurement rather than a class
      // name or an attribute: an element inside a `hidden` body has no client rects at all, which is the fact a
      // reader's eye and a screenshot both agree with.
      const readSection = (id) =>
        page.evaluate((initId) => {
          const card = document.querySelector(`[data-init-card="${initId}"]`);
          const sec = card ? card.querySelector("[data-init-notes]") : null;
          if (!sec) return { missing: true };
          const head = sec.querySelector("[data-init-notes-fold]");
          const body = sec.querySelector(".init-notesbody");
          const list = sec.querySelector("[data-init-notes-list]");
          const empty = sec.querySelector("[data-init-notes-empty]");
          const write = sec.querySelector(".init-notewrite");
          const count = sec.querySelector("[data-init-notes-count]");
          const visible = (el) => Boolean(el) && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
          return {
            sectionH: Math.round(sec.getBoundingClientRect().height),
            head: head
              ? {
                  tag: head.tagName,
                  type: head.getAttribute("type"),
                  expanded: head.getAttribute("aria-expanded"),
                  controls: head.getAttribute("aria-controls"),
                  tabIndex: head.tabIndex,
                  visible: visible(head),
                  text: head.textContent.replace(/\s+/g, " ").trim(),
                }
              : null,
            controlsBody: Boolean(head && body && head.getAttribute("aria-controls") === body.id && document.getElementById(body.id) === body),
            body: body ? { hidden: body.hasAttribute("hidden"), display: getComputedStyle(body).display, visible: visible(body) } : null,
            list: list ? { notes: list.querySelectorAll("[data-init-note]").length, visible: visible(list) } : null,
            empty: empty ? { text: empty.textContent.replace(/\s+/g, " ").trim(), visible: visible(empty) } : null,
            write: write
              ? {
                  visible: visible(write),
                  textareaVisible: visible(write.querySelector("textarea")),
                  saveVisible: visible(write.querySelector("[data-init-notesave]")),
                }
              : null,
            count: count ? { text: count.textContent.trim(), visible: visible(count) } : null,
          };
        }, id);

      const waitExpanded = (cardSel, want) =>
        page.waitForFunction(
          ({ sel, state }) => document.querySelector(`${sel} [data-init-notes-fold]`)?.getAttribute("aria-expanded") === state,
          { sel: cardSel, state: want },
          { timeout: 15_000 },
        );

      await openCard(SSO_CARD);

      // ---- 1. DEFAULT OPEN SHOWS THE LIST AND THE COUNT ---------------------------------------------------------
      const first = await readSection(SSO);
      ok("the notes section is drawn on the open card", !first.missing, JSON.stringify({ missing: first.missing || false }));
      ok("the head is a real button, so a press and the keyboard can both reach it", first.head?.tag === "BUTTON" && first.head?.type === "button", `${first.head?.tag} type=${first.head?.type} tabIndex=${first.head?.tabIndex}`);
      eq("a card first painted shows its notes expanded", first.head?.expanded, "true");
      ok("aria-controls names the body the fold hides", first.controlsBody === true, `${first.head?.controls}`);
      eq("the default body is not hidden and is laid out", [first.body?.hidden, first.body?.visible], [false, true]);
      eq("the default list holds every note the store holds", first.list?.notes, SSO_NOTES);
      ok("the default list is visible", first.list?.visible === true, `visible=${first.list?.visible}`);
      eq("the default count reads N", first.count?.text, String(SSO_NOTES));
      ok("the default count is visible", first.count?.visible === true, `visible=${first.count?.visible}`);
      ok("the write row is drawn open with the list", first.write?.visible === true && first.write?.textareaVisible === true && first.write?.saveVisible === true, JSON.stringify(first.write));
      const openH = first.sectionH;
      await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: "start" }), `${SSO_CARD} [data-init-notes]`);
      await page.screenshot({ path: shot("01-notes-expanded") });

      // ---- 2. A PRESS FOLDS IT, AND THE COUNT STAYS ON THE HEAD -------------------------------------------------
      await page.click(headSel(SSO_CARD));
      await waitExpanded(SSO_CARD, "false");
      const folded = await readSection(SSO);
      eq("a press turns aria-expanded to false", folded.head?.expanded, "false");
      eq("the body carries hidden, and the browser lays it out as nothing", [folded.body?.hidden, folded.body?.display, folded.body?.visible], [true, "none", false]);
      ok("the list has no box while folded", folded.list ? folded.list.visible === false : true, folded.list ? `visible=${folded.list.visible}` : "no note rows on the folded card");
      ok("the write row and its box have no box while folded", folded.write?.visible === false && folded.write?.textareaVisible === false && folded.write?.saveVisible === false, JSON.stringify(folded.write));
      eq("the folded head still reads N", folded.count?.text, String(SSO_NOTES));
      ok("the folded count is still visible in the head", folded.count?.visible === true && folded.head?.visible === true, `count visible=${folded.count?.visible}, head visible=${folded.head?.visible}`);
      ok("the fold takes the log's height out of the section", folded.sectionH < openH - 80, `${openH}px open -> ${folded.sectionH}px folded`);
      ok("the folded head names the fold in its hint", /folded/i.test(folded.head?.text || ""), folded.head?.text);
      await page.screenshot({ path: shot("02-notes-folded") });

      // ---- 3. A SECOND PRESS UNFOLDS IT ------------------------------------------------------------------------
      await page.click(headSel(SSO_CARD));
      await waitExpanded(SSO_CARD, "true");
      const again = await readSection(SSO);
      eq("a second press turns aria-expanded back to true", again.head?.expanded, "true");
      eq("the body is drawn again", [again.body?.hidden, again.body?.visible], [false, true]);
      eq("the same note rows come back", again.list?.notes, SSO_NOTES);
      ok("the same write row comes back", again.write?.textareaVisible === true && again.write?.saveVisible === true, JSON.stringify(again.write));
      eq("the count never moved for a fold", again.count?.text, String(SSO_NOTES));

      // ---- 4. ENTER AND SPACE BOTH PRESS IT --------------------------------------------------------------------
      await page.locator(headSel(SSO_CARD)).focus();
      eq("the head takes focus like a button", await page.evaluate((sel) => document.activeElement === document.querySelector(sel), headSel(SSO_CARD)), true);
      await page.keyboard.press("Enter");
      await waitExpanded(SSO_CARD, "false");
      const afterEnter = await readSection(SSO);
      eq("Enter folds it", [afterEnter.head?.expanded, afterEnter.body?.hidden, afterEnter.body?.visible], ["false", true, false]);
      ok("Enter leaves the count reading N", afterEnter.count?.text === String(SSO_NOTES) && afterEnter.count?.visible === true, JSON.stringify(afterEnter.count));
      await page.keyboard.press("Space");
      await waitExpanded(SSO_CARD, "true");
      const afterSpace = await readSection(SSO);
      eq("Space unfolds it", [afterSpace.head?.expanded, afterSpace.body?.hidden, afterSpace.body?.visible], ["true", false, true]);
      ok("Space leaves the count reading N", afterSpace.count?.text === String(SSO_NOTES) && afterSpace.count?.visible === true, JSON.stringify(afterSpace.count));

      // ---- 5. TWO INITIATIVES FOLD APART -----------------------------------------------------------------------
      await openCard(RELEASE_CARD);
      await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: "start" }), `${RELEASE_CARD} [data-init-notes]`);
      const releaseFirst = await readSection(RELEASE);
      eq("the second card starts expanded with its own count", [releaseFirst.head?.expanded, releaseFirst.count?.text, releaseFirst.list?.notes], ["true", String(RELEASE_NOTES), RELEASE_NOTES]);

      await page.click(headSel(SSO_CARD));
      await waitExpanded(SSO_CARD, "false");
      const releaseWhileSsoShut = await readSection(RELEASE);
      eq("folding one initiative leaves the other open", [releaseWhileSsoShut.head?.expanded, releaseWhileSsoShut.body?.visible, releaseWhileSsoShut.list?.visible], ["true", true, true]);

      await page.click(headSel(RELEASE_CARD));
      await waitExpanded(RELEASE_CARD, "false");
      const both = { sso: await readSection(SSO), release: await readSection(RELEASE) };
      eq("folding the second leaves the first exactly as it was", [both.sso.head?.expanded, both.sso.body?.hidden], ["false", true]);
      eq("and the second is shut", [both.release.head?.expanded, both.release.body?.hidden], ["false", true]);

      await page.click(headSel(SSO_CARD));
      await waitExpanded(SSO_CARD, "true");
      const afterSsoOpen = await readSection(RELEASE);
      eq("unfolding one does not unfold the other", [afterSsoOpen.head?.expanded, afterSsoOpen.body?.hidden], ["false", true]);

      // ---- 6. A NOTE WHILE FOLDED BUMPS THE COUNT AND LEAVES IT SHUT -------------------------------------------
      // init_sso is open again; fold it, then write through the route a turn uses and refresh the tab with its own
      // control. The count must move and the fold must not.
      await page.click(headSel(SSO_CARD));
      await waitExpanded(SSO_CARD, "false");
      const beforeArrival = await readSection(SSO);
      const addRes = await fetch(`${panel.base}/api/initiatives/notes/add`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: SSO, text: "1.179.0 is the version the fold first ships in", by: "assistant-1" }),
      });
      const addBody = await addRes.json().catch(() => ({}));
      ok("the route accepts the arriving note as an assistant's write", addRes.status === 201 && addBody.note?.by === "assistant-1", `HTTP ${addRes.status}, by ${addBody.note?.by}`);
      const stored = notesInStore(SSO);
      eq("the store holds the note before the tab is re-read", stored.length, SSO_NOTES + 1);
      await page.click("#as-initiatives [data-init-refresh]");
      await page.waitForFunction(
        ({ sel, want }) => document.querySelector(`${sel} [data-init-notes-count]`)?.textContent.trim() === want,
        { sel: SSO_CARD, want: String(SSO_NOTES + 1) },
        { timeout: 25_000 },
      );
      const arrived = await readSection(SSO);
      eq("the count moves for the arriving note", arrived.count?.text, String(SSO_NOTES + 1));
      ok("the arriving note does not force the fold open", arrived.head?.expanded === "false" && arrived.body?.hidden === true && arrived.body?.visible === false, JSON.stringify({ expanded: arrived.head?.expanded, hidden: arrived.body?.hidden, visible: arrived.body?.visible }));
      ok("the folded head keeps the new count visible", arrived.count?.visible === true && arrived.head?.visible === true, JSON.stringify(arrived.count));
      ok("the list and the write row stay out of sight", arrived.list?.visible === false && arrived.write?.visible === false, JSON.stringify({ list: arrived.list?.visible, write: arrived.write?.visible }));
      ok("the fold survived a repaint, and the count moved without one", beforeArrival.head?.expanded === "false" && beforeArrival.count?.text === String(SSO_NOTES), `${beforeArrival.count?.text} -> ${arrived.count?.text}`);
      await page.screenshot({ path: shot("03-note-arrived-folded") });

      // ---- 7. ZERO NOTES: THE EXISTING EMPTY WORDING UNDER A PRESSABLE HEAD ------------------------------------
      await openCard(SWEEPER_CARD);
      await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: "start" }), `${SWEEPER_CARD} [data-init-notes]`);
      const none = await readSection(SWEEPER);
      eq("a card with no notes draws its count as zero", none.count?.text, "0");
      ok("the empty wording is the existing one", /Nothing remembered here yet/.test(none.empty?.text || "") && /ticket/.test(none.empty?.text || "") && /pull request/.test(none.empty?.text || "") && /decision/.test(none.empty?.text || "") && /version/.test(none.empty?.text || ""), (none.empty?.text || "").slice(0, 100));
      ok("the empty card's head is a pressable button, expanded", none.head?.tag === "BUTTON" && none.head?.type === "button" && none.head?.expanded === "true" && none.head?.tabIndex >= 0, JSON.stringify(none.head));
      await page.click(headSel(SWEEPER_CARD));
      await waitExpanded(SWEEPER_CARD, "false");
      const noneShut = await readSection(SWEEPER);
      eq("the empty card folds too", [noneShut.head?.expanded, noneShut.body?.hidden, noneShut.empty?.visible], ["false", true, false]);
      ok("and its zero stays visible on the folded head", noneShut.count?.text === "0" && noneShut.count?.visible === true, JSON.stringify(noneShut.count));
      await page.locator(headSel(SWEEPER_CARD)).focus();
      await page.keyboard.press("Enter");
      await waitExpanded(SWEEPER_CARD, "true");
      const noneOpen = await readSection(SWEEPER);
      eq("and unfolds onto the empty wording again", [noneOpen.head?.expanded, noneOpen.body?.visible, noneOpen.empty?.visible], ["true", true, true]);
      await page.screenshot({ path: shot("04-empty-card") });

      // ---- 8. HEALTH ------------------------------------------------------------------------------------------
      ok("zero page errors and zero console errors", pageErrors.length === 0 && consoleErrors.length === 0, [...pageErrors, ...consoleErrors].slice(0, 3).join(" | "));
      return { openH, foldedH: folded.sectionH, counts: { sso: arrived.count?.text, release: releaseFirst.count?.text, sweeper: noneOpen.count?.text } };
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
