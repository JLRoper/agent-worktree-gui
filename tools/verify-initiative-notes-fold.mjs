#!/usr/bin/env node
// THE NOTES SECTION IS FOLDED UNTIL THE READER OPENS IT, and the count stays readable while it is shut.
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
//   1. DEFAULT FOLDED. A card first painted draws its head with the count and nothing else: aria-expanded "false",
//      the body carries `hidden` and has no box at all, the list and the write row are in the DOM but laid out as
//      nothing, and the count still reads N in the folded head.
//   2. A PRESS UNFOLDS IT. A press on the head turns aria-expanded to "true", the body loses `hidden`, the list and
//      the write row are laid out, and the section is materially taller.
//   3. A SECOND PRESS FOLDS IT AGAIN, with the count still on the head.
//   4. ENTER AND SPACE BOTH PRESS IT. Focus lands on the head and a real Enter, then a real Space, each flip
//      aria-expanded and the body's hidden attribute - the browser's own button activation, not a key handler this
//      pane had to grow.
//   5. TWO INITIATIVES FOLD APART. Unfolding init_sso leaves init_release folded, unfolding init_release leaves
//      init_sso as it was, and folding one does not move the other: the book is keyed by the initiative id.
//   6. A NOTE WHILE FOLDED BUMPS THE COUNT AND LEAVES IT SHUT. A note is written through the real
//      POST /api/initiatives/notes/add route (the writer an assistant's turn uses), the tab is re-read with its own
//      Refresh press, and the folded head goes 2 -> 3 while aria-expanded stays "false" and the body stays hidden:
//      the fold is module state, not a DOM detail the repaint would lose.
//   7. ZERO NOTES STILL CARRIES THE EMPTY WORDING under a pressable head, and that head unfolds onto it and folds
//      again like any other.
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

      // ---- 1. DEFAULT FOLDED: THE HEAD AND ITS COUNT, NOTHING ELSE -------------------------------------------------
      const first = await readSection(SSO);
      ok("the notes section is drawn on the open card", !first.missing, JSON.stringify({ missing: first.missing || false }));
      ok("the head is a real button, so a press and the keyboard can both reach it", first.head?.tag === "BUTTON" && first.head?.type === "button", `${first.head?.tag} type=${first.head?.type} tabIndex=${first.head?.tabIndex}`);
      eq("a card first painted shows its notes FOLDED", first.head?.expanded, "false");
      ok("aria-controls names the body the fold hides", first.controlsBody === true, `${first.head?.controls}`);
      eq("the default body carries hidden and is laid out as nothing", [first.body?.hidden, first.body?.display, first.body?.visible], [true, "none", false]);
      eq("the folded body still holds every note the store holds", first.list?.notes, SSO_NOTES);
      ok("the folded list is laid out as nothing", first.list ? first.list.visible === false : true, first.list ? `visible=${first.list.visible}` : "no note rows drawn");
      eq("the folded count reads N", first.count?.text, String(SSO_NOTES));
      ok("the folded count is visible in the head", first.count?.visible === true && first.head?.visible === true, `count visible=${first.count?.visible}, head visible=${first.head?.visible}`);
      ok("the write row is out of sight with the log", first.write?.visible === false && first.write?.textareaVisible === false, JSON.stringify(first.write));
      ok("the folded head says the log is folded", /folded|unfold/i.test(first.head?.text || ""), first.head?.text);
      const foldedH = first.sectionH;
      await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: "start" }), `${SSO_CARD} [data-init-notes]`);
      await page.screenshot({ path: shot("01-notes-folded-default") });

      // ---- 2. A PRESS UNFOLDS IT, AND THE COUNT IS STILL ON THE HEAD ---------------------------------------------
      await page.click(headSel(SSO_CARD));
      await waitExpanded(SSO_CARD, "true");
      const opened = await readSection(SSO);
      eq("a press turns aria-expanded to true", opened.head?.expanded, "true");
      eq("the body is drawn and laid out", [opened.body?.hidden, opened.body?.visible], [false, true]);
      eq("the unfolded list holds every note the store holds", opened.list?.notes, SSO_NOTES);
      ok("the unfolded list is visible", opened.list?.visible === true, `visible=${opened.list?.visible}`);
      ok("the write row comes back with the list", opened.write?.visible === true && opened.write?.textareaVisible === true && opened.write?.saveVisible === true, JSON.stringify(opened.write));
      eq("the count never moved for an unfold", opened.count?.text, String(SSO_NOTES));
      ok("unfolding adds the log's height to the section", opened.sectionH > foldedH + 80, `${foldedH}px folded -> ${opened.sectionH}px open`);
      await page.screenshot({ path: shot("02-notes-unfolded") });

      // ---- 3. A SECOND PRESS FOLDS IT AGAIN -----------------------------------------------------------------------
      await page.click(headSel(SSO_CARD));
      await waitExpanded(SSO_CARD, "false");
      const again = await readSection(SSO);
      eq("a second press folds it", [again.head?.expanded, again.body?.hidden, again.body?.visible], ["false", true, false]);
      ok("the folded head keeps the count reading N", again.count?.text === String(SSO_NOTES) && again.count?.visible === true, JSON.stringify(again.count));

      // ---- 4. ENTER AND SPACE BOTH PRESS IT ----------------------------------------------------------------------
      await page.locator(headSel(SSO_CARD)).focus();
      eq("the head takes focus like a button", await page.evaluate((sel) => document.activeElement === document.querySelector(sel), headSel(SSO_CARD)), true);
      await page.keyboard.press("Enter");
      await waitExpanded(SSO_CARD, "true");
      const afterEnter = await readSection(SSO);
      eq("Enter unfolds it", [afterEnter.head?.expanded, afterEnter.body?.hidden, afterEnter.body?.visible], ["true", false, true]);
      ok("Enter leaves the count reading N", afterEnter.count?.text === String(SSO_NOTES) && afterEnter.count?.visible === true, JSON.stringify(afterEnter.count));
      await page.keyboard.press("Space");
      await waitExpanded(SSO_CARD, "false");
      const afterSpace = await readSection(SSO);
      eq("Space folds it", [afterSpace.head?.expanded, afterSpace.body?.hidden, afterSpace.body?.visible], ["false", true, false]);
      ok("Space leaves the count reading N", afterSpace.count?.text === String(SSO_NOTES) && afterSpace.count?.visible === true, JSON.stringify(afterSpace.count));

      // ---- 5. TWO INITIATIVES FOLD APART --------------------------------------------------------------------------
      await openCard(RELEASE_CARD);
      await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: "start" }), `${RELEASE_CARD} [data-init-notes]`);
      const releaseFirst = await readSection(RELEASE);
      eq("the second card starts folded with its own count", [releaseFirst.head?.expanded, releaseFirst.count?.text, releaseFirst.list?.notes], ["false", String(RELEASE_NOTES), RELEASE_NOTES]);

      await page.click(headSel(SSO_CARD));
      await waitExpanded(SSO_CARD, "true");
      const releaseWhileSsoOpen = await readSection(RELEASE);
      eq("unfolding one initiative leaves the other folded", [releaseWhileSsoOpen.head?.expanded, releaseWhileSsoOpen.body?.visible], ["false", false]);

      await page.click(headSel(RELEASE_CARD));
      await waitExpanded(RELEASE_CARD, "true");
      const both = { sso: await readSection(SSO), release: await readSection(RELEASE) };
      eq("unfolding the second leaves the first open", [both.sso.head?.expanded, both.sso.body?.hidden], ["true", false]);
      eq("and the second is open", [both.release.head?.expanded, both.release.body?.visible], ["true", true]);

      await page.click(headSel(SSO_CARD));
      await waitExpanded(SSO_CARD, "false");
      const afterSsoShut = await readSection(RELEASE);
      eq("folding one does not fold the other", [afterSsoShut.head?.expanded, afterSsoShut.body?.hidden], ["true", false]);

      // ---- 6. A NOTE WHILE FOLDED BUMPS THE COUNT AND LEAVES IT SHUT ---------------------------------------------
      // init_release is open and init_sso shut; shut init_release too, then write through the route a turn uses and
      // refresh the tab with its own control. The count must move and the fold must not.
      await page.click(headSel(RELEASE_CARD));
      await waitExpanded(RELEASE_CARD, "false");
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

      // ---- 7. ZERO NOTES: THE EXISTING EMPTY WORDING UNDER A PRESSABLE HEAD --------------------------------------
      await openCard(SWEEPER_CARD);
      await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: "start" }), `${SWEEPER_CARD} [data-init-notes]`);
      const none = await readSection(SWEEPER);
      eq("a card with no notes draws its count as zero, folded", [none.count?.text, none.head?.expanded, none.body?.hidden], ["0", "false", true]);
      ok("the folded empty card's head is a pressable button", none.head?.tag === "BUTTON" && none.head?.type === "button" && none.head?.tabIndex >= 0, JSON.stringify(none.head));
      ok("the zero stays visible on the folded head", none.count?.visible === true, JSON.stringify(none.count));
      await page.click(headSel(SWEEPER_CARD));
      await waitExpanded(SWEEPER_CARD, "true");
      const noneShut = await readSection(SWEEPER);
      eq("the empty card unfolds onto its wording", [noneShut.head?.expanded, noneShut.body?.hidden, noneShut.empty?.visible], ["true", false, true]);
      ok("the empty wording is the existing one", /Nothing remembered here yet/.test(noneShut.empty?.text || "") && /ticket/.test(noneShut.empty?.text || "") && /pull request/.test(noneShut.empty?.text || "") && /decision/.test(noneShut.empty?.text || "") && /version/.test(noneShut.empty?.text || ""), (noneShut.empty?.text || "").slice(0, 100));
      await page.locator(headSel(SWEEPER_CARD)).focus();
      await page.keyboard.press("Enter");
      await waitExpanded(SWEEPER_CARD, "false");
      const noneOpen = await readSection(SWEEPER);
      eq("Enter folds it again onto the bare head", [noneOpen.head?.expanded, noneOpen.body?.visible, noneOpen.empty?.visible], ["false", false, false]);
      await page.screenshot({ path: shot("04-empty-card") });

      // ---- 8. HEALTH ----------------------------------------------------------------------------------------------
      ok("zero page errors and zero console errors", pageErrors.length === 0 && consoleErrors.length === 0, [...pageErrors, ...consoleErrors].slice(0, 3).join(" | "));
      return { foldedH, openH: opened.sectionH, counts: { sso: arrived.count?.text, release: releaseFirst.count?.text, sweeper: noneOpen.count?.text } };
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
