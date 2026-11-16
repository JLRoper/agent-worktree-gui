// The assistant header's search, driven by the KEYBOARD ALONE, in a real browser at 1440x900.
//
// WHAT IT ASSERTS, in the order a reader would meet it:
//
//   1. Ctrl+Q LANDS IN THE BOX. Pressed while the caret is on a panel control - reached with Tab, not a click - the
//      box takes the caret, reports the key handled (a cancelable synthetic keydown answers `defaultPrevented`), and
//      a second Ctrl+Q SELECTS the filter it already holds, so the next character typed replaces it instead of
//      appending. A textarea and the composer are left alone: a chord that stole the caret there would eat words.
//   2. ONE PRESS, ONE ITEM. Against a filter that matches FOUR multi-row turns (each turn's prompt, reply and
//      console line match), the count beside the box reads "1 of 4" and one Down per press walks 2 of 4, 3 of 4,
//      4 of 4 - each press moving a whole message, scrolling it into view and ringing it as the current match.
//   3. THE ENDS WRAP. Down on the last item lands on the first (stated in docs/assistant-search-keys.md).
//   4. ENTER OPENS THE CURRENT MATCH. With the current turn folded (Ctrl+[ folds the turn tier), Enter unfolds it,
//      marks the match inside it and leaves the count where it was - it acts on the current item, it does not step.
//   5. ESCAPE CLEARS AND HANDS THE CARET BACK. The filter and the count go, and focus returns to the control Ctrl+Q
//      took it from.
//
// HOW TO RUN:  node tools/verify-assistant-search-keys.mjs
//              node tools/verify-assistant-search-keys.mjs --out <dir>   (defaults to the temp dir)
//              node tools/verify-assistant-search-keys.mjs --keep         (leave the sandbox store behind)
//
// It boots THIS checkout's server.js on a free port with its own state directory and a SYNTHESIZED store - four
// turns that all match one phrase, each with three matching rows - so the proof is the same on a machine that has
// never opened the panel. No live panel is touched, and every action under test is a key press.
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
const outDir = argOf("out", path.join(os.tmpdir(), "wag-assistant-search-keys"));
const dir = argOf("dir", path.join(os.tmpdir(), "wag-assistant-search-keys-sandbox"));
mkdirSync(outDir, { recursive: true });
mkdirSync(dir, { recursive: true });
const shot = (name) => path.join(outDir, name);

const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  process.exit(1);
};

// ---- the store ---------------------------------------------------------------------------------------------
// Four turns, and every one of them matches the filter in THREE fields: its prompt, its reply and one console line.
// That is what makes an "item" visible: four messages, twelve matching rows, and a step that must move between the
// four, not the twelve.
const PHRASE = "zephyr";
const TURNS = [1, 2, 3, 4].map((i) => {
  const at = new Date(Date.UTC(2026, 10, 12, 9, i * 5, 0)).toISOString();
  const end = new Date(Date.UTC(2026, 10, 12, 9, i * 5 + 4, 0)).toISOString();
  return {
    id: `zephyr${i}`,
    thread: "panel-assistant",
    turn: i,
    origin: "assistant",
    status: "done",
    startedAt: at,
    endedAt: end,
    lastActiveAt: end,
    prompt: `${PHRASE} budget ${i}: keep the board quiet`,
    finalMessage: `${PHRASE} reply ${i}: the budget holds for turn ${i}`,
    lines: [{ kind: "tool", text: `grep -n ${PHRASE} routes/turn-${i}.js`, at: Date.parse(end) - 1000 }],
  };
});
const jobsFile = { version: 3, savedAt: new Date().toISOString(), jobs: TURNS };
const assistantsFile = { version: 2, assistants: [{ id: "assistant-1", name: "Assistant #1", threadId: "panel-assistant" }] };
const logsDir = path.join(dir, "logs");
mkdirSync(logsDir, { recursive: true });
// Written every run, never merged: the sandbox exists to hold exactly this fixture.
writeFileSync(path.join(logsDir, "jobs.json"), JSON.stringify(jobsFile, null, 1), "utf8");
writeFileSync(path.join(logsDir, "assistants.json"), JSON.stringify(assistantsFile, null, 1), "utf8");
// The four items, in the order the search answers them: the newest prompt first, then the older ones.
const EXPECTED_ITEMS = ["zephyr4", "zephyr3", "zephyr2", "zephyr1"];

console.log(`store: ${TURNS.length} turns, ${TURNS.length * 3} matching rows, filter ${JSON.stringify(PHRASE)}`);
console.log(`expected items, newest first: ${EXPECTED_ITEMS.join(", ")}`);

// ---- the browser -------------------------------------------------------------------------------------------
const pw = loadPlaywright();
if (!pw) {
  console.log("BROWSER-HALF-NOT-RUN: no playwright on this machine, so nothing was checked in a page");
  process.exit(2);
}

const panel = await startPanel({ root: ROOT, dir, keep });
const v = createVerifier();
const record = { phrase: PHRASE, viewport: "1440x900", turns: TURNS.map((t) => t.id), steps: [], screenshots: [] };
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
          return {
            text: n.textContent.trim(),
            hidden: n.hidden,
            current: Number(n.dataset.searchCurrent),
            items: Number(n.dataset.searchItems),
            total: Number(n.dataset.searchItemTotal),
            matched: Number(n.dataset.searchMatched),
            displayed: Number(n.dataset.searchDisplayed),
            query: n.dataset.searchQuery,
            title: n.title,
          };
        });
      // The turn the box is standing on, where it is on screen, and the mark inside it - read from the page, so the
      // highlight is judged where the reader sees it.
      const currentMatch = () =>
        page.evaluate(() => {
          const turns = [...document.querySelectorAll("#as-chat .turn.is-search-current")];
          const el = turns[0] || null;
          const body = document.querySelector("#as-chat > .job > .job-body");
          const view = (node) => {
            if (!node) return null;
            const r = node.getBoundingClientRect();
            return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
          };
          const bodyRect = body ? body.getBoundingClientRect() : null;
          const r = el ? el.getBoundingClientRect() : null;
          const mark = el ? el.querySelector("mark.as-search-mark.is-current") : null;
          return {
            marked: turns.length,
            id: el ? el.dataset.turn : null,
            folded: el ? el.classList.contains("folded") : null,
            rect: view(el),
            body: bodyRect ? { top: Math.round(bodyRect.top), bottom: Math.round(bodyRect.bottom) } : null,
            inBody:
              Boolean(r && bodyRect) &&
              r.top >= bodyRect.top - 2 &&
              r.bottom <= bodyRect.bottom + 2 &&
              r.top < window.innerHeight &&
              r.bottom > 0,
            mark: mark ? mark.textContent : null,
            marks: el ? el.querySelectorAll("mark.as-search-mark").length : 0,
            popHidden: document.getElementById("as-search-pop").hidden,
          };
        });
      const focus = () =>
        page.evaluate(() => {
          const el = document.activeElement;
          const input = document.getElementById("as-search-q");
          const value = String(input?.value || "");
          return {
            id: el ? el.id || "" : "",
            tag: el ? el.tagName : "",
            cls: el && el.className ? String(el.className).split(" ").filter(Boolean).slice(0, 2).join(".") : "",
            inPanel: Boolean(document.getElementById("assistant")?.contains(el)),
            searchFocused: el === input,
            composerFocused: Boolean(el?.closest?.(".reply-box, [data-reply], textarea")),
            value,
            selStart: input ? input.selectionStart : null,
            selEnd: input ? input.selectionEnd : null,
          };
        });
      const waitCount = async (text) => {
        await page.waitForFunction(
          (want) => {
            const n = document.getElementById("as-search-n");
            return Boolean(n && !n.hidden && n.textContent.trim() === want && n.dataset.searchQuery);
          },
          text,
          { timeout: 10000 },
        );
        return count();
      };

      await page.goto(panel.base, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#btn-assistant", { timeout: 45000 });

      // ---- 0. the panel, opened with the keyboard -----------------------------------------------------------------
      // A bare `a` is the documented way in (and the same keys handler Ctrl+Q lives in), so the whole run starts on
      // the keyboard rather than a click on the button.
      await page.keyboard.press("a");
      await page.waitForSelector("#assistant:not([hidden]) #as-chat [data-turn]", { timeout: 20000 });
      const drawn = await page.evaluate(() => [...document.querySelectorAll("#as-chat [data-turn]")].map((el) => el.dataset.turn));
      v.check("the panel opened on the keyboard, showing all four turns", drawn.slice().sort(), EXPECTED_ITEMS.slice().sort());

      // The reader's place: Tab until the caret is inside the panel (Shift+Tab from the body lands on the last
      // tabbable in the document, which is the rail). If the browser's tab order refuses, the scope button is the
      // stand-in and the run says which it used.
      let place = null;
      for (const key of ["Shift+Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
        await page.keyboard.press(key);
        const f = await focus();
        if (f.inPanel) {
          place = f;
          break;
        }
      }
      if (!place) {
        await page.locator("#as-search-scope").focus();
        place = await focus();
      }
      v.ok("the caret is on a control inside the panel before Ctrl+Q", place.inPanel === true, `${place.tag}#${place.id || place.cls}`);
      await shoot("01-the-caret-on-a-panel-control.png");

      // ---- 1. Ctrl+Q lands in the box, and reports the key handled ----------------------------------------------
      // A synthetic cancelable keydown is how "handled" is read: dispatchEvent answers false exactly when
      // preventDefault was called, and the browser's own default would have been the next thing to run.
      const synthetic = await page.evaluate(() => {
        const target = document.activeElement || document.body;
        const e = new KeyboardEvent("keydown", { key: "q", code: "KeyQ", ctrlKey: true, bubbles: true, cancelable: true });
        const dispatched = target.dispatchEvent(e);
        const input = document.getElementById("as-search-q");
        return { dispatched, prevented: e.defaultPrevented, focused: document.activeElement === input };
      });
      v.ok("Ctrl+Q reports the key handled", synthetic.prevented === true && synthetic.dispatched === false, JSON.stringify(synthetic));
      v.ok("Ctrl+Q landed the caret in the search box", synthetic.focused === true);

      // The real press, from wherever the caret was: the same two facts, and the selection is empty on an empty box.
      await page.keyboard.press("Control+q");
      const landed = await focus();
      v.ok("a real Ctrl+Q focuses the box", landed.searchFocused === true, `${landed.tag}#${landed.id}`);
      v.ok("the box holds nothing yet, so nothing is selected", landed.value === "" && landed.selStart === 0 && landed.selEnd === 0, JSON.stringify(landed));
      await shoot("02-ctrl-q-lands-in-the-box.png");

      // ---- 2. the filter: a live n of N over FOUR multi-row items ------------------------------------------------
      await page.keyboard.type(PHRASE);
      const first = await waitCount("1 of 4");
      const api = await (await fetch(`${panel.base}/api/assistant/search?q=${encodeURIComponent(PHRASE)}&scope=all&limit=10&assistantId=assistant-1`)).json();
      // An independent read of the same endpoint, grouped by thread and turn id here rather than by the page's own
      // module: twelve matching rows in four turns.
      const apiItems = [];
      for (const hit of api.hits || []) {
        const key = `${hit.thread}|${hit.id}`;
        if (!apiItems.includes(key)) apiItems.push(key);
      }
      v.ok("the store answers twelve matching rows in four turns", api.matched === 12 && apiItems.length === 4, `${api.matched} hits, ${apiItems.length} turns over HTTP`);
      v.ok("the count beside the box reads 1 of 4", first.text === "1 of 4" && first.items === 4, `${first.text}, items ${first.items}, total ${first.total}`);
      v.ok("the count knows all four items even though the hit list is capped", first.total === 4 && first.matched === 12 && first.displayed === 10, JSON.stringify({ total: first.total, matched: first.matched, displayed: first.displayed }));
      v.ok("the current item is the first, before any press", first.current === 1, `current ${first.current}`);
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll("#as-search-pop [data-search-hit]")].map((r) => ({
          item: Number(r.dataset.searchItem),
          where: r.querySelector(".as-search-where")?.textContent || "",
          current: r.classList.contains("is-current"),
        })),
      );
      v.check("the list's rows carry their item, and all four items are in it", [...new Set(rows.map((r) => r.item))], [0, 1, 2, 3]);
      v.ok("the current item's rows are the ones marked current", rows.filter((r) => r.current).length === 3 && rows.filter((r) => r.current).every((r) => r.item === 0), `${rows.filter((r) => r.current).length} rows marked current`);
      const seeded = await currentMatch();
      v.ok("the first item is highlighted on the page before any press", seeded.id === EXPECTED_ITEMS[0] && seeded.marked === 1, `${seeded.id}, ${seeded.marked} ringed`);
      await shoot("03-filter-1-of-4.png");

      // ---- 2b. a second Ctrl+Q SELECTS the filter, so typing replaces it -----------------------------------------
      await page.keyboard.press("Control+q");
      const selected = await focus();
      v.ok("a second Ctrl+Q selects everything the box holds", selected.selStart === 0 && selected.selEnd === PHRASE.length, JSON.stringify({ value: selected.value, start: selected.selStart, end: selected.selEnd }));
      await shoot("04-ctrl-q-selects-the-filter.png");
      await page.keyboard.type(PHRASE);
      const replaced = await focus();
      v.ok("typing over the selection replaces it instead of appending", replaced.value === PHRASE, JSON.stringify(replaced.value));
      await waitCount("1 of 4");

      // ---- 3. one press, one item: 2 of 4, 3 of 4, 4 of 4 --------------------------------------------------------
      const steps = [];
      for (let n = 2; n <= 4; n += 1) {
        await page.keyboard.press("ArrowDown");
        const c = await waitCount(`${n} of 4`);
        const at = await currentMatch();
        steps.push({ n, count: c.text, id: at.id, inBody: at.inBody, mark: at.mark, folded: at.folded });
        v.ok(`one Down moves to item ${n} of 4`, c.text === `${n} of 4` && c.current === n, `${c.text}, current ${c.current}`);
        v.ok(
          `item ${n} is the next whole message, not a row of the last one`,
          at.id === EXPECTED_ITEMS[n - 1] && steps.length && (n === 2 || steps[steps.length - 2].id !== at.id),
          `${at.id} (expected ${EXPECTED_ITEMS[n - 1]})`,
        );
        v.ok(`item ${n} is scrolled into view`, at.inBody === true, JSON.stringify({ rect: at.rect, body: at.body }));
        v.ok(`item ${n} carries exactly one current-match ring`, at.marked === 1, `${at.marked} turns ringed`);
        v.ok(`item ${n} marks the matched text inside it`, Boolean(at.mark) && at.mark.toLowerCase().includes(PHRASE), JSON.stringify(at.mark));
        await shoot(`0${n + 3}-down-${n}-of-4.png`);
      }
      record.steps = steps;

      // ---- 4. the ends WRAP: Down on the last item lands on the first ---------------------------------------------
      await page.keyboard.press("ArrowDown");
      const wrapped = await waitCount("1 of 4");
      const firstAgain = await currentMatch();
      v.ok("Down on the last item wraps to the first", wrapped.text === "1 of 4" && firstAgain.id === EXPECTED_ITEMS[0], `${wrapped.text}, ${firstAgain.id}`);
      await page.keyboard.press("ArrowUp");
      const back = await waitCount("4 of 4");
      const lastAgain = await currentMatch();
      v.ok("Up on the first item wraps to the last", back.text === "4 of 4" && lastAgain.id === EXPECTED_ITEMS[3], `${back.text}, ${lastAgain.id}`);
      await shoot("08-wrap-at-both-ends.png");

      // ---- 5. Enter opens the CURRENT match, folded or not --------------------------------------------------------
      // Leave the box the way a reader would (Tab), fold the turn tier with the documented Ctrl+[, then come back
      // with Ctrl+Q and press Enter: the count must not move, and the folded turn must open and mark its match.
      await page.keyboard.press("Tab");
      const outside = await focus();
      v.ok("Tab leaves the box for the next control, so Ctrl+[ is not swallowed by a field", outside.searchFocused === false, `${outside.tag}#${outside.id || outside.cls}`);
      // The turn the box is standing on is the one Enter must open - read it before the fold, so the fold is proved
      // on that turn and not on a guess about which item the walk ended on.
      const targetId = lastAgain.id;
      await page.keyboard.press("Control+BracketLeft");
      await page.waitForFunction(
        (id) => document.querySelector(`#as-chat .turn[data-turn="${id}"]`)?.classList.contains("folded") === true,
        targetId,
        { timeout: 8000 },
      );
      v.ok("the current turn is folded before Enter", true, targetId);
      await page.keyboard.press("Control+q");
      const backIn = await focus();
      v.ok("Ctrl+Q comes back into the box with the filter intact", backIn.searchFocused === true && backIn.value === PHRASE, JSON.stringify({ focused: backIn.searchFocused, value: backIn.value }));
      await shoot("09-folded-before-enter.png");
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        (id) => {
          const el = document.querySelector(`#as-chat .turn[data-turn="${id}"]`);
          return Boolean(el && !el.classList.contains("folded") && el.querySelector("mark.as-search-mark.is-current"));
        },
        targetId,
        { timeout: 8000 },
      );
      const afterEnter = await currentMatch();
      const countAfterEnter = await count();
      v.ok("Enter opens the current match where it was folded", afterEnter.id === targetId && afterEnter.folded === false, `${afterEnter.id}, folded ${afterEnter.folded}`);
      v.ok("Enter marks the match inside the item it opened", Boolean(afterEnter.mark) && afterEnter.mark.toLowerCase().includes(PHRASE), JSON.stringify(afterEnter.mark));
      v.ok("Enter acts on the current item and does not step past it", countAfterEnter.text === "4 of 4", countAfterEnter.text);
      await shoot("10-enter-opens-the-item.png");

      // ---- 6. Escape clears the filter and hands the caret back --------------------------------------------------
      await page.keyboard.press("Escape");
      const cleared = await page.evaluate(() => {
        const input = document.getElementById("as-search-q");
        const n = document.getElementById("as-search-n");
        return {
          value: input.value,
          countHidden: n.hidden,
          countText: n.textContent.trim(),
          popHidden: document.getElementById("as-search-pop").hidden,
          rings: document.querySelectorAll("#as-chat .turn.is-search-current").length,
          marks: document.querySelectorAll("#as-chat mark.as-search-mark").length,
          panelOpen: !document.getElementById("assistant").hidden,
        };
      });
      const afterEscape = await focus();
      v.ok("Escape empties the filter", cleared.value === "" && cleared.countHidden === true && cleared.countText === "", JSON.stringify(cleared));
      v.ok("Escape clears the list and the highlight", cleared.popHidden === true && cleared.rings === 0 && cleared.marks === 0, JSON.stringify(cleared));
      v.ok("Escape leaves the panel open", cleared.panelOpen === true);
      v.ok(
        "Escape hands the caret back where Ctrl+Q took it",
        afterEscape.searchFocused === false && afterEscape.id === outside.id && afterEscape.cls === outside.cls,
        `taken from ${outside.tag}#${outside.id || outside.cls}, back on ${afterEscape.tag}#${afterEscape.id || afterEscape.cls}`,
      );
      await shoot("11-escape-cleared-and-caret-back.png");

      // ---- 7. the hosts Ctrl+Q must not touch: the composer, then a textarea --------------------------------------
      await page.locator("#as-chat .reply-box").first().focus();
      const composerBefore = await focus();
      v.ok("the composer has the caret for this check", composerBefore.composerFocused === true, `${composerBefore.tag}#${composerBefore.id || composerBefore.cls}`);
      await page.keyboard.press("Control+q");
      const composerAfter = await focus();
      v.ok("Ctrl+Q is ignored while the caret is in the composer", composerAfter.composerFocused === true && composerAfter.searchFocused === false, JSON.stringify({ tag: composerAfter.tag, search: composerAfter.searchFocused }));

      // The Pad pane is the panel's textarea host; switching to it is setup, the key press is the subject.
      await page.evaluate(() => document.querySelector('#as-subtabs [data-as-subtab="pad"]')?.click());
      await page.waitForSelector("#as-pad textarea", { timeout: 8000 });
      await page.locator("#as-pad textarea").first().focus();
      const areaBefore = await focus();
      v.ok("a textarea has the caret for this check", areaBefore.tag === "TEXTAREA", `${areaBefore.tag}#${areaBefore.id || areaBefore.cls}`);
      await page.keyboard.press("Control+q");
      const areaAfter = await focus();
      v.ok("Ctrl+Q is ignored while the caret is in a textarea", areaAfter.tag === "TEXTAREA" && areaAfter.searchFocused === false, JSON.stringify({ tag: areaAfter.tag, search: areaAfter.searchFocused }));
      await shoot("12-ignored-in-a-textarea.png");

      // ---- 8. no page error came from any of it ------------------------------------------------------------------
      v.ok("no page error was raised by the run", errors.length === 0, errors.slice(0, 3).join(" | "));
      return { drawn, first, rows, steps, seeded, afterEnter, cleared };
    },
    { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  );
  if (!browserHalf) fail("the browser half returned nothing");
  console.log(`screenshots: ${record.screenshots.length} in ${outDir}`);
} finally {
  await panel.stop();
  writeFileSync(path.join(outDir, "assistant-search-keys.json"), JSON.stringify(record, null, 2), "utf8");
}

console.log(`\n${v.checks - v.failures}/${v.checks} checks passed`);
if (v.failures) process.exit(1);
console.log(`assistant-search-keys: OK (screenshots in ${outDir}, sandbox ${keep ? dir : "removed"})`);
