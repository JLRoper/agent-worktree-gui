// The assistant header's search COUNT and its STEP keys, driven by the KEYBOARD ALONE, in a real browser at
// 1440x900.
//
// THE DEFECT THIS PROVES GONE. The header counted turns ("1 of 1") while the footer counted hits ("5 matched, 5
// displayed, in 1 turn"), so a filter that hit five rows of ONE turn printed two numbers that disagreed and the box
// looked broken. There is one count source now (public/core/search-count.js): the header divides the rows the
// keyboard steps, and the footer's "displayed" is that same number.
//
// WHAT IT ASSERTS, in the order a reader would meet it:
//
//   1. ONE COUNT SOURCE, FIVE ROWS IN ONE TURN. A filter that matches five rows of a single message reads
//      "1 of 5" beside the box and "5 hits matched, 5 displayed, in 1 turn" in the footer: the header's total and
//      the footer's displayed are the same five rows.
//   2. ONE PRESS, ONE MATCH. One Down moves to "2 of 5" and the bright mark moves from the prompt to the newest
//      console row inside that same message - not to another message, and not nowhere.
//   3. SHIFT GOES BACK. Shift+Up returns to "1 of 5", Shift+Down wraps backwards to "5 of 5", and Shift+Enter steps
//      backwards too. No arrow press scrolls the page.
//   4. FIVE TURNS READ THE SAME WAY. A filter that matches five separate messages reads "1 of 5" with
//      "5 hits matched, 5 displayed, in 5 turns", and a Down moves to the next message.
//   5. THE CAP KEEPS ITS AMBER. A filter that matches twelve rows of four turns shows ten rows: the header reads
//      "1 of 10", the footer "12 hits matched, 10 displayed, in 4 turns", and the count turns amber.
//   6. ENTER AND ESCAPE KEEP THEIR PROMISES. Enter opens the current match where it is (marks it, hides the list)
//      and does not step; Escape clears the filter and leaves the caret in the box.
//
// HOW TO RUN:  node tools/verify-assistant-search-keys.mjs
//              node tools/verify-assistant-search-keys.mjs --out <dir>   (defaults to the committed asset dir)
//              node tools/verify-assistant-search-keys.mjs --keep         (leave the sandbox store behind)
//
// It boots THIS checkout's server.js on a free port with its own state directory and a SYNTHESIZED store - one turn
// with five matching rows, five turns with one matching row each, four turns that match in three fields - so the
// proof is the same on a machine that has never opened the panel. No live panel is touched, and every action under
// test is a key press: nothing here clicks, focuses a locator or calls a page function that acts.
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, createVerifier, startPanel } from "./panel-testkit.mjs";
import { loadPlaywright, withBrowser } from "./browser.mjs";

const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const keep = argv.includes("--keep");
const outDir = argOf("out", path.join(ROOT, "docs", "assets", "assistant-search-count"));
const dir = argOf("dir", path.join(os.tmpdir(), "wag-assistant-search-count-sandbox"));
mkdirSync(outDir, { recursive: true });
mkdirSync(dir, { recursive: true });
const shot = (name) => path.join(outDir, name);

const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  process.exit(1);
};

// ---- the store ---------------------------------------------------------------------------------------------
// ONE_TURN: a single message whose prompt and four console rows all match ONE_TURN_FILTER. That is the defect's
// shape: five rows, one turn, and a count that used to read "1 of 1".
//
// FIVE_TURNS: five separate messages, one matching row each, so the same "1 of 5" must also be the five-turn case.
//
// CAPPED: four messages matching in their prompt, reply and console line - twelve rows for a ten-row list, which
// is what keeps the amber note honest.
const ONE_TURN_FILTER = "zephyr";
const FIVE_TURNS_FILTER = "quasar";
const CAPPED_FILTER = "common";
const THREAD = "panel-assistant";

const utc = (h, m, s = 0) => new Date(Date.UTC(2026, 10, 12, h, m, s)).toISOString();
const oneTurnAt = Date.parse(utc(12, 0, 0));
const line = (lid, text, at) => ({ kind: "tool", lid, text, at });

const ONE_TURN = {
  id: "zephyr-turn",
  thread: THREAD,
  turn: 10,
  origin: "assistant",
  status: "done",
  startedAt: utc(12, 0, 0),
  endedAt: utc(12, 4, 0),
  lastActiveAt: utc(12, 4, 0),
  prompt: `${ONE_TURN_FILTER} budget: keep the board quiet`,
  finalMessage: "the budget holds",
  // Four console rows, each with its own lid: the walk reads them in their own order (the order the card draws them),
  // which is the order the message reads on screen - the prompt, then z1 to z4.
  lines: [
    line("z1", `grep -n ${ONE_TURN_FILTER} routes/a.js`, oneTurnAt + 1000),
    line("z2", `rg -n ${ONE_TURN_FILTER} lib/b.js`, oneTurnAt + 2000),
    line("z3", `node tools/c.mjs ${ONE_TURN_FILTER}`, oneTurnAt + 3000),
    line("z4", `cat docs/${ONE_TURN_FILTER}.md`, oneTurnAt + 4000),
  ],
};
const FIVE_TURNS = [1, 2, 3, 4, 5].map((i) => ({
  id: `quasar-${i}`,
  thread: THREAD,
  turn: i,
  origin: "assistant",
  status: "done",
  startedAt: utc(9, i * 5, 0),
  endedAt: utc(9, i * 5 + 4, 0),
  lastActiveAt: utc(9, i * 5 + 4, 0),
  prompt: `${FIVE_TURNS_FILTER} request ${i}: check the queue`,
  finalMessage: `done ${i}`,
  lines: [line(`q${i}`, `echo done ${i}`, Date.parse(utc(9, i * 5 + 1, 0)))],
}));
const CAPPED = [1, 2, 3, 4].map((i) => ({
  id: `common-${i}`,
  thread: THREAD,
  turn: i,
  origin: "assistant",
  status: "done",
  startedAt: utc(8, i * 5, 0),
  endedAt: utc(8, i * 5 + 4, 0),
  lastActiveAt: utc(8, i * 5 + 4, 0),
  prompt: `${CAPPED_FILTER} step ${i}: read the board`,
  finalMessage: `${CAPPED_FILTER} reply ${i}: nothing to do`,
  lines: [line(`c${i}`, `grep ${CAPPED_FILTER} board.json`, Date.parse(utc(8, i * 5 + 1, 0)))],
}));
const TURNS = [...CAPPED, ...FIVE_TURNS, ONE_TURN];
const jobsFile = { version: 3, savedAt: new Date().toISOString(), jobs: TURNS };
const assistantsFile = { version: 2, assistants: [{ id: "assistant-1", name: "Assistant #1", threadId: THREAD }] };
const logsDir = path.join(dir, "logs");
mkdirSync(logsDir, { recursive: true });
// Written every run, never merged: the sandbox exists to hold exactly this fixture.
writeFileSync(path.join(logsDir, "jobs.json"), JSON.stringify(jobsFile, null, 1), "utf8");
writeFileSync(path.join(logsDir, "assistants.json"), JSON.stringify(assistantsFile, null, 1), "utf8");

console.log(
  `store: ${TURNS.length} turns; ${ONE_TURN_FILTER} = 5 rows in 1 turn, ${FIVE_TURNS_FILTER} = 1 row in 5 turns, ${CAPPED_FILTER} = 12 rows in 4 turns`,
);

// ---- the browser -------------------------------------------------------------------------------------------
const pw = loadPlaywright();
if (!pw) {
  console.log("BROWSER-HALF-NOT-RUN: no playwright on this machine, so nothing was checked in a page");
  process.exit(2);
}

const panel = await startPanel({ root: ROOT, dir, keep });
const v = createVerifier();
const record = { viewport: "1440x900", filters: {}, steps: [], screenshots: [] };
try {
  const browserHalf = await withBrowser(
    async ({ page }) => {
      const errors = [];
      page.on("pageerror", (err) => errors.push(String(err?.message || err)));
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
      });
      const shoot = async (name) => {
        // Every shot carries the viewport it was taken at, the same convention docs/assets/<topic>/*-1440x900.png
        // uses: a picture with no size in its name cannot be compared with the next one.
        const p = shot(name.replace(/\.png$/, "-1440x900.png"));
        await page.screenshot({ path: p });
        record.screenshots.push(path.basename(p));
        return p;
      };
      const count = () =>
        page.evaluate(() => {
          const n = document.getElementById("as-search-n");
          const foot = document.querySelector("#as-search-pop .as-search-more");
          return {
            text: n.textContent.trim(),
            hidden: n.hidden,
            current: Number(n.dataset.searchCurrent),
            total: Number(n.dataset.searchTotal),
            matched: Number(n.dataset.searchMatched),
            displayed: Number(n.dataset.searchDisplayed),
            turns: Number(n.dataset.searchTurns),
            query: n.dataset.searchQuery,
            title: n.title,
            capped: n.classList.contains("is-capped"),
            amber: getComputedStyle(n).color,
            foot: foot ? foot.textContent.trim() : "",
            popHidden: document.getElementById("as-search-pop").hidden,
            rows: document.querySelectorAll("#as-search-pop [data-search-hit]").length,
          };
        });
      const footNums = (foot) => {
        const m = /^(\d+) hits? matched, (\d+) displayed, in (\d+) turns?/.exec(foot);
        return m ? { matched: Number(m[1]), displayed: Number(m[2]), turns: Number(m[3]) } : null;
      };
      // The bright mark, and the row it landed in: the prompt rides the turn's head, every console row is a
      // .jl[data-lid] line. "top" is the mark's screen position, so a step that did not move is a number that did
      // not change.
      const markSpot = () =>
        page.evaluate(() => {
          const turn = document.querySelector("#as-chat .turn.is-search-current");
          const mark = document.querySelector("#as-chat mark.as-search-mark.is-current");
          const row = mark ? mark.closest("[data-lid]") : null;
          const prompt = mark ? mark.closest(".turn-prompt-inline") : null;
          const curRow = document.querySelector("#as-chat .is-search-current-row");
          const curId = curRow ? (curRow.dataset.lid || (curRow.classList.contains("turn-prompt-inline") ? "prompt" : "?")) : null;
          const curRect = curRow ? curRow.getBoundingClientRect() : null;
          const r = mark ? mark.getBoundingClientRect() : curRect;
          return {
            turn: turn ? turn.dataset.turn : null,
            rings: document.querySelectorAll("#as-chat .turn.is-search-current").length,
            lid: row ? row.dataset.lid : null,
            prompt: Boolean(prompt),
            rowCurrent: curId,
            text: mark ? mark.textContent : null,
            top: r ? Math.round(r.top) : null,
            left: r ? Math.round(r.left) : null,
            marks: document.querySelectorAll("#as-chat mark.as-search-mark").length,
          };
        });
      const pageScroll = () => page.evaluate(() => window.scrollY);
      const focus = () =>
        page.evaluate(() => {
          const el = document.activeElement;
          const input = document.getElementById("as-search-q");
          return {
            id: el ? el.id || "" : "",
            tag: el ? el.tagName : "",
            searchFocused: el === input,
            value: String(input?.value || ""),
            selStart: input ? input.selectionStart : null,
            selEnd: input ? input.selectionEnd : null,
          };
        });
      const waitCount = async (text, query) => {
        await page.waitForFunction(
          ({ want, q }) => {
            const n = document.getElementById("as-search-n");
            return Boolean(n && !n.hidden && n.textContent.trim() === want && n.dataset.searchQuery === q);
          },
          { want: text, q: query },
          { timeout: 15000 },
        );
        return count();
      };
      // The footer the page prints must be the module's own sentence, and its numbers must be the header's numbers.
      const agree = (label, c, want) => {
        const nums = footNums(c.foot);
        v.ok(`${label}: the footer reads "${want.foot}"`, c.foot === want.foot, c.foot);
        v.ok(
          `${label}: the header's total is the footer's displayed count`,
          c.total === nums?.displayed && c.displayed === nums?.displayed,
          JSON.stringify({ header: c.text, total: c.total, displayed: c.displayed, foot: c.foot }),
        );
        v.ok(
          `${label}: the footer's matched count is the answer's own`,
          nums?.matched === want.matched && c.matched === want.matched,
          JSON.stringify({ foot: nums, matched: c.matched }),
        );
        v.ok(
          `${label}: the footer names ${want.turns} matching turn${want.turns === 1 ? "" : "s"}`,
          nums?.turns === want.turns && c.turns === want.turns,
          JSON.stringify({ foot: nums, turns: c.turns }),
        );
        v.ok(`${label}: the header prints only "n of N"`, /^\d+ of \d+$/.test(c.text), c.text);
      };

      await page.goto(panel.base, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#btn-assistant", { timeout: 45000 });

      // ---- 0. the panel, opened on the keyboard ------------------------------------------------------------------
      // A bare `a` is the documented way in (and the same keys handler Ctrl+Q lives in), so the run starts on the
      // keyboard rather than a click on the button. Nothing below clicks, focuses a locator or calls a page function
      // that acts: every subject is a key press.
      await page.keyboard.press("a");
      await page.waitForSelector("#assistant:not([hidden]) #as-chat [data-turn]", { timeout: 20000 });
      const drawn = await page.evaluate(() => [...document.querySelectorAll("#as-chat [data-turn]")].map((el) => el.dataset.turn));
      v.ok("the panel opened on the keyboard and drew its turns", drawn.length > 0, `${drawn.length} turns on screen`);

      // ---- 1. Ctrl+Q lands in the box, and selects what it holds -------------------------------------------------
      await page.keyboard.press("Control+q");
      const landed = await focus();
      v.ok("Ctrl+Q focuses the search box", landed.searchFocused === true, `${landed.tag}#${landed.id}`);
      v.ok(
        "the box holds nothing yet, so nothing is selected",
        landed.value === "" && landed.selStart === 0 && landed.selEnd === 0,
        JSON.stringify(landed),
      );

      // ---- 2. five rows in ONE turn: 1 of 5, and the footer agrees ------------------------------------------------
      await page.keyboard.type(ONE_TURN_FILTER);
      const one = await waitCount("1 of 5", ONE_TURN_FILTER);
      const api = await (
        await fetch(`${panel.base}/api/assistant/search?q=${encodeURIComponent(ONE_TURN_FILTER)}&scope=all&limit=10&assistantId=assistant-1`)
      ).json();
      v.ok("the store answers five matching rows", api.matched === 5 && api.hits.length === 5, `${api.matched} matched, ${api.hits.length} hits over HTTP`);
      v.ok("the five rows belong to one turn", api.turns === 1, `${api.turns} turn`);
      agree("one turn", one, { foot: "5 hits matched, 5 displayed, in 1 turn", matched: 5, turns: 1 });
      v.ok("the count is not amber for a list that holds every match", one.capped === false, one.amber);
      const seeded = await markSpot();
      v.ok("the first row is the turn's prompt, before any press", seeded.turn === ONE_TURN.id && seeded.prompt === true && seeded.rings === 1, JSON.stringify(seeded));
      v.ok("the list shows all five rows, one per match", one.rows === 5, `${one.rows} rows`);
      record.filters.oneTurn = { text: one.text, foot: one.foot, matched: one.matched, turns: one.turns };
      await shoot("01-five-rows-in-one-turn-1-of-5.png");

      // ---- 3. one Down steps to 2 of 5, inside the SAME turn, and does not scroll the page ------------------------
      const beforeDown = await pageScroll();
      await page.keyboard.press("ArrowDown");
      const two = await waitCount("2 of 5", ONE_TURN_FILTER);
      const afterDown = await pageScroll();
      const stepped = await markSpot();
      v.ok("one Down reads 2 of 5", two.text === "2 of 5" && two.current === 2, `${two.text}, current ${two.current}`);
      v.ok("the press stayed inside the one turn", stepped.turn === ONE_TURN.id && stepped.rings === 1, JSON.stringify(stepped));
      v.ok("the highlight moved to the next console row of that turn, in reading order", stepped.rowCurrent === "z1" && stepped.prompt === false, JSON.stringify(stepped));
      v.ok("the mark moved on screen, rather than the count moving alone", stepped.top !== seeded.top, `prompt ${seeded.top}, row ${stepped.top}`);
      v.ok("one Down did not scroll the page", afterDown === beforeDown, `${beforeDown} -> ${afterDown}`);
      record.steps.push({ press: "ArrowDown", count: two.text, lid: stepped.lid, top: stepped.top });
      await shoot("02-down-2-of-5.png");

      // ---- 4. Shift+Up steps back to 1 of 5, and the mark returns to the prompt -----------------------------------
      const beforeUp = await pageScroll();
      await page.keyboard.press("Shift+ArrowUp");
      const backToOne = await waitCount("1 of 5", ONE_TURN_FILTER);
      const afterUp = await pageScroll();
      const backSpot = await markSpot();
      v.ok("Shift+Up reads 1 of 5 again", backToOne.text === "1 of 5" && backToOne.current === 1, backToOne.text);
      v.ok("Shift+Up put the highlight back on the prompt row", backSpot.prompt === true && backSpot.rowCurrent === "prompt", JSON.stringify(backSpot));
      v.ok("Shift+Up did not scroll the page", afterUp === beforeUp, `${beforeUp} -> ${afterUp}`);
      record.steps.push({ press: "Shift+ArrowUp", count: backToOne.text, lid: backSpot.lid, top: backSpot.top });
      await shoot("03-shift-up-back-to-1-of-5.png");

      // ---- 5. Shift+Down and Shift+Enter also go BACK (from the first row they wrap to the last) ------------------
      const beforeShiftDown = await pageScroll();
      await page.keyboard.press("Shift+ArrowDown");
      const wrappedBack = await waitCount("5 of 5", ONE_TURN_FILTER);
      const afterShiftDown = await pageScroll();
      const wrappedSpot = await markSpot();
      v.ok("Shift+Down steps backwards, wrapping to 5 of 5", wrappedBack.text === "5 of 5" && wrappedBack.current === 5, wrappedBack.text);
      v.ok("Shift+Down did not scroll the page", afterShiftDown === beforeShiftDown, `${beforeShiftDown} -> ${afterShiftDown}`);
      v.ok("Shift+Down wrapped backwards to the last row of the message", wrappedSpot.rowCurrent === "z4", JSON.stringify(wrappedSpot));
      await page.keyboard.press("Shift+Enter");
      const shiftEnter = await waitCount("4 of 5", ONE_TURN_FILTER);
      v.ok("Shift+Enter steps backwards too", shiftEnter.text === "4 of 5" && shiftEnter.current === 4, shiftEnter.text);
      // Back to the first row for the Enter check: two Downs from 4 of 5 (5 of 5, then the wrap).
      await page.keyboard.press("ArrowDown");
      await waitCount("5 of 5", ONE_TURN_FILTER);
      await page.keyboard.press("ArrowDown");
      const round = await waitCount("1 of 5", ONE_TURN_FILTER);
      v.ok("Down on the last row wraps to the first", round.text === "1 of 5" && round.current === 1, round.text);

      // ---- 6. Enter opens the current match where it is, and does not step ----------------------------------------
      const beforeEnter = await count();
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        (id) => Boolean(document.querySelector(`#as-chat .turn[data-turn="${id}"] mark.as-search-mark.is-current`)),
        ONE_TURN.id,
        { timeout: 8000 },
      );
      const opened = await count();
      const openedSpot = await markSpot();
      v.ok("Enter leaves the count where it was", opened.text === beforeEnter.text && opened.current === beforeEnter.current, `${beforeEnter.text} -> ${opened.text}`);
      v.ok("Enter gets the list out of the way", opened.popHidden === true);
      v.ok("Enter opens and marks the current match", openedSpot.turn === ONE_TURN.id && openedSpot.marks >= 1, JSON.stringify(openedSpot));

      // ---- 7. Escape clears the filter and leaves the caret IN the box -------------------------------------------
      await page.keyboard.press("Escape");
      const cleared = await count();
      const afterEscape = await focus();
      v.ok(
        "Escape empties the filter and hides the count",
        cleared.hidden === true && cleared.text === "" && afterEscape.value === "",
        JSON.stringify({ count: cleared.text, hidden: cleared.hidden, value: afterEscape.value }),
      );
      const escapeMarks = await page.evaluate(() => document.querySelectorAll("#as-chat mark.as-search-mark").length);
      v.ok("Escape clears the list and the highlight", cleared.popHidden === true && cleared.rows === 0 && escapeMarks === 0, `${cleared.rows} rows, ${escapeMarks} marks`);
      v.ok("Escape leaves the caret in the search box", afterEscape.searchFocused === true, `${afterEscape.tag}#${afterEscape.id}`);
      v.ok("Escape leaves the panel open", await page.evaluate(() => !document.getElementById("assistant").hidden));

      // ---- 8. the same 1 of 5 for FIVE turns, and one Down moves to the next message -----------------------------
      await page.keyboard.press("Control+q");
      await page.keyboard.type(FIVE_TURNS_FILTER);
      const five = await waitCount("1 of 5", FIVE_TURNS_FILTER);
      const fiveApi = await (
        await fetch(`${panel.base}/api/assistant/search?q=${encodeURIComponent(FIVE_TURNS_FILTER)}&scope=all&limit=10&assistantId=assistant-1`)
      ).json();
      v.ok("the store answers five matching rows in five turns", fiveApi.matched === 5 && fiveApi.turns === 5, `${fiveApi.matched} hits, ${fiveApi.turns} turns over HTTP`);
      agree("five turns", five, { foot: "5 hits matched, 5 displayed, in 5 turns", matched: 5, turns: 5 });
      const firstTurn = await markSpot();
      v.ok("the first match is the newest matching message", firstTurn.turn === "quasar-5" && firstTurn.prompt === true, JSON.stringify(firstTurn));
      record.filters.fiveTurns = { text: five.text, foot: five.foot, matched: five.matched, turns: five.turns };
      const beforeFiveDown = await pageScroll();
      await page.keyboard.press("ArrowDown");
      const secondTurn = await waitCount("2 of 5", FIVE_TURNS_FILTER);
      const fiveSpot = await markSpot();
      const afterFiveDown = await pageScroll();
      v.ok("one Down moves to 2 of 5 of the five messages", secondTurn.text === "2 of 5", secondTurn.text);
      v.ok("the press moved to the NEXT message", fiveSpot.turn === "quasar-4", JSON.stringify(fiveSpot));
      v.ok("the message press did not scroll the page", afterFiveDown === beforeFiveDown, `${beforeFiveDown} -> ${afterFiveDown}`);
      await shoot("04-five-turns-2-of-5.png");
      await page.keyboard.press("Shift+ArrowUp");
      const fiveBack = await waitCount("1 of 5", FIVE_TURNS_FILTER);
      const fiveBackSpot = await markSpot();
      v.ok("Shift+Up goes back to the first message", fiveBack.text === "1 of 5" && fiveBackSpot.turn === "quasar-5", JSON.stringify({ count: fiveBack.text, turn: fiveBackSpot.turn }));

      // ---- 9. the cap keeps its amber, and its two numbers still agree --------------------------------------------
      await page.keyboard.press("Control+q");
      await page.keyboard.type(CAPPED_FILTER);
      const capped = await waitCount("1 of 10", CAPPED_FILTER);
      const cappedApi = await (
        await fetch(`${panel.base}/api/assistant/search?q=${encodeURIComponent(CAPPED_FILTER)}&scope=all&limit=10&assistantId=assistant-1`)
      ).json();
      v.ok("the store matched more rows than the list shows", cappedApi.matched === 12 && cappedApi.hits.length === 10, `${cappedApi.matched} matched, ${cappedApi.hits.length} displayed`);
      agree("capped", capped, {
        foot: "12 hits matched, 10 displayed, in 4 turns - your own input is kept when the cap bites",
        matched: 12,
        turns: 4,
      });
      v.ok("the capped count is amber", capped.capped === true && capped.amber === "rgb(227, 179, 65)", `${capped.capped}, ${capped.amber}`);
      v.ok(
        "the header divides the ten rows the list holds, not the twelve it lost",
        capped.total === 10 && capped.rows === 10,
        JSON.stringify({ text: capped.text, total: capped.total, rows: capped.rows }),
      );
      record.filters.capped = { text: capped.text, foot: capped.foot, matched: capped.matched, turns: capped.turns };
      await shoot("05-capped-amber-1-of-10.png");

      // ---- 10. a Down pressed BEFORE the answer lands still steps the answer (no Enter, no second press) --------
      await page.keyboard.press("Control+q");
      await page.keyboard.type(ONE_TURN_FILTER);
      await page.keyboard.press("ArrowDown");
      const raced = await waitCount("1 of 5", ONE_TURN_FILTER);
      const racedSpot = await markSpot();
      v.ok(
        "a press before the answer lands on the first row, without Enter",
        raced.text === "1 of 5" && racedSpot.turn === ONE_TURN.id && racedSpot.prompt === true,
        JSON.stringify({ count: raced.text, spot: racedSpot }),
      );

      // ---- 11. no page error came from any of it ------------------------------------------------------------------
      v.ok("no page error was raised by the run", errors.length === 0, errors.slice(0, 3).join(" | "));
      return { drawn, one, two, backToOne, wrappedBack, shiftEnter, round, five, capped };
    },
    { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  );
  if (!browserHalf) fail("the browser half returned nothing");
  console.log(`screenshots: ${record.screenshots.length} in ${outDir}`);
} finally {
  await panel.stop();
  writeFileSync(path.join(outDir, "assistant-search-count.json"), JSON.stringify(record, null, 2), "utf8");
}

console.log(`\n${v.checks - v.failures}/${v.checks} checks passed`);
if (v.failures) process.exit(1);
console.log(`assistant-search-keys: OK (screenshots in ${outDir}, sandbox ${keep ? dir : "removed"})`);
