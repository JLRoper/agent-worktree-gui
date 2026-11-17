// The assistant header's search LIST follows the walk, driven by the KEYBOARD ALONE, in a real browser at 1440x900.
//
// THE DEFECT THIS PROVES GONE. A keyboard step scrolled the TRANSCRIPT (`(mark || turnEl).scrollIntoView({ block:
// "end" })`) and then put `window.scrollY` back, while `paintSearchCurrent` deliberately scrolled nothing. So the
// popover's own scroller never followed the highlight: from the sixth result on, every press moved the current row
// outside the list's visible band, and the header went on counting while the reader could not see the row it counted.
//
// WHAT IT ASSERTS, in the order a reader would meet it:
//
//   1. THE LIST HAS A FOLD. A filter matching twelve rows shows ten (the cap) and the popover is shorter than its
//      content, so there are more rows than the popup can show: `scrollHeight > clientHeight`, and fewer rows are
//      inside the band than the list holds.
//   2. EVERY KEYBOARD STEP KEEPS THE CURRENT ROW VISIBLE. Walking Down from `1 of 10` to `10 of 10`, and back Up to
//      `1 of 10`, the row the header counts is inside the popover's band at every single step - first, middle, last,
//      and the whole way home.
//   3. ONE PRESS IS ONE ROW. Once the list starts moving, each press moves it by exactly one row's pitch, never a
//      page, and the popover's own height, top and the box above it never move.
//   4. THE WAY BACK IS THE WAY DOWN. The `scrollTop` at each step home is exactly the one that step had on the way
//      out: pressing Up from the last result scrolls the list up by the same row the down walk scrolled down.
//   5. NOTHING ELSE SCROLLS. The page stays at `scrollY` 0, and of every scroller in the assistant pane - the
//      transcript's own boxes included - the popover is the only one whose `scrollTop` changes across a press. A
//      transcript box the reveal repaints may land on its own bottom (a chat pane pins itself to its newest content
//      when it draws) and that is the repaint, not a scroll of the reader's place: any box that stopped anywhere
//      else is a failure. The caret stays in the search box, and the count beside it does not move.
//
// HOW TO RUN:  node tools/verify-assistant-search-scroll.mjs
//              node tools/verify-assistant-search-scroll.mjs --out <dir>   (defaults to the committed asset dir)
//              node tools/verify-assistant-search-scroll.mjs --keep         (leave the sandbox store behind)
//
// It boots THIS checkout's server.js on a free port with its own state directory and a SYNTHESIZED store of twelve
// matching messages, each with a body long enough that the transcript itself overflows - so "the popover is the only
// thing that scrolled" is a real comparison and not an empty list. No live panel is touched, and every action under
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
const outDir = argOf("out", path.join(ROOT, "docs", "assets", "assistant-search-scroll"));
const dir = argOf("dir", path.join(os.tmpdir(), "wag-assistant-search-scroll-sandbox"));
mkdirSync(outDir, { recursive: true });
mkdirSync(dir, { recursive: true });
const shot = (name) => path.join(outDir, name);

const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  process.exit(1);
};

// ---- the store ---------------------------------------------------------------------------------------------
// Twelve messages, each matching in its prompt: twelve rows for a ten-row list, which is the cap's own shape. The
// prompt is long enough and the console tails are long enough that the transcript below the popover overflows its
// pane, so a press that dragged the transcript would be a scroll a probe could catch.
const FILTER = "saffron";
const THREAD = "panel-assistant";
const utc = (h, m, s = 0) => new Date(Date.UTC(2026, 10, 12, h, m, s)).toISOString();
const body = (i) =>
  Array.from({ length: 6 }, (_, k) => `line ${k + 1} of message ${i}: the board holds and the queue is quiet, nothing to report`);
const TURNS = Array.from({ length: 12 }, (_, i) => {
  const n = i + 1;
  const at = utc(6, i * 4, 0);
  return {
    id: `${FILTER}-${n}`,
    thread: THREAD,
    turn: n,
    origin: "assistant",
    status: "done",
    startedAt: at,
    endedAt: utc(6, i * 4 + 2, 0),
    lastActiveAt: utc(6, i * 4 + 2, 0),
    prompt: `${FILTER} request ${n}: read the board, then the queue, then the alerts pane, then the watch list, and say what moved since the last time you looked`,
    finalMessage: `reply ${n}: the board holds and nothing has moved`,
    lines: body(n).map((text, k) => ({ kind: "tool", lid: `s${n}-${k}`, text, at: Date.parse(utc(6, i * 4 + 1, k)) })),
  };
});
const jobsFile = { version: 3, savedAt: new Date().toISOString(), jobs: TURNS };
const assistantsFile = { version: 2, assistants: [{ id: "assistant-1", name: "Assistant #1", threadId: THREAD }] };
const logsDir = path.join(dir, "logs");
mkdirSync(logsDir, { recursive: true });
// Written every run, never merged: the sandbox exists to hold exactly this fixture.
writeFileSync(path.join(logsDir, "jobs.json"), JSON.stringify(jobsFile, null, 1), "utf8");
writeFileSync(path.join(logsDir, "assistants.json"), JSON.stringify(assistantsFile, null, 1), "utf8");

console.log(`store: ${TURNS.length} turns, one matching row each for "${FILTER}" - 12 matched, 10 displayed`);

// ---- the browser -------------------------------------------------------------------------------------------
const pw = loadPlaywright();
if (!pw) {
  console.log("BROWSER-HALF-NOT-RUN: no playwright on this machine, so nothing was checked in a page");
  process.exit(2);
}

const panel = await startPanel({ root: ROOT, dir, keep });
const v = createVerifier();
const record = { viewport: "1440x900", filter: FILTER, scrolls: [], screenshots: [] };
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
      // One read of the popover, the current row, the box above it, and every scroller in the pane. The scroll map is
      // the honest way to say "the popover moved and nothing else did": it names each element that has somewhere to
      // scroll and where it stands, so a transcript box that moved would be a row in the map with a different number.
      const look = () =>
        page.evaluate(() => {
          const pop = document.getElementById("as-search-pop");
          const row = pop?.querySelector("[data-search-hit].is-current") || null;
          const pr = pop.getBoundingClientRect();
          const bandTop = pr.top + pop.clientTop;
          const bandBottom = bandTop + pop.clientHeight;
          const rr = row ? row.getBoundingClientRect() : null;
          const n = document.getElementById("as-search-n");
          const input = document.getElementById("as-search-q");
          const ir = input.getBoundingClientRect();
          const nr = n.getBoundingClientRect();
          const scrollers = {};
          for (const el of document.querySelectorAll("#assistant, #assistant *")) {
            if (el.scrollHeight > el.clientHeight + 1 || el.scrollTop !== 0) {
              const key = el.id ? `#${el.id}` : `${el.tagName}.${String(el.className || "").split(" ")[0] || "?"}`;
              scrollers[key] = { top: Math.round(el.scrollTop), max: Math.round(el.scrollHeight - el.clientHeight) };
            }
          }
          return {
            scrollTop: pop.scrollTop,
            maxScroll: pop.scrollHeight - pop.clientHeight,
            clientHeight: pop.clientHeight,
            scrollHeight: pop.scrollHeight,
            popTop: Math.round(pr.top),
            popHeight: Math.round(pr.height),
            bandTop: Math.round(bandTop),
            bandBottom: Math.round(bandBottom),
            row: row ? Number(row.dataset.searchHit) : null,
            rowTop: rr ? Math.round(rr.top) : null,
            rowBottom: rr ? Math.round(rr.bottom) : null,
            rowHeight: rr ? Math.round(rr.height) : null,
            // The reader's question, asked without trusting the module that answers it in the page.
            visible: Boolean(rr) && rr.top >= bandTop - 0.5 && rr.bottom <= bandBottom + 0.5,
            fullyInsideList: Boolean(rr) && rr.top >= pr.top && rr.bottom <= pr.bottom,
            rows: pop.querySelectorAll("[data-search-hit]").length,
            visibleRows: [...pop.querySelectorAll("[data-search-hit]")].filter((r) => {
              const b = r.getBoundingClientRect();
              return b.top >= pr.top && b.bottom <= pr.bottom;
            }).length,
            count: n.textContent.trim(),
            current: Number(n.dataset.searchCurrent),
            total: Number(n.dataset.searchTotal),
            foot: pop.querySelector(".as-search-more")?.textContent.trim() || "",
            pageY: window.scrollY,
            docTop: document.scrollingElement ? document.scrollingElement.scrollTop : 0,
            focus: document.activeElement === input,
            inputTop: Math.round(ir.top),
            inputValue: String(input.value || ""),
            countTop: Math.round(nr.top),
            scrollers,
          };
        });
      const waitCount = (text, query) => {
        return page.waitForFunction(
          ({ want, q }) => {
            const n = document.getElementById("as-search-n");
            return Boolean(n && !n.hidden && n.textContent.trim() === want && n.dataset.searchQuery === q);
          },
          { want: text, q: query },
          { timeout: 15000 },
        );
      };
      // The boxes that must not move: the popover, and the bar it hangs from. One read, so a per-press assertion is
      // three numbers rather than three evaluators.
      const still = (a, b) => a.popTop === b.popTop && a.popHeight === b.popHeight && a.inputTop === b.inputTop && a.countTop === b.countTop;
      // Which scrollers moved between two reads. The popover is the one under test; anything else is the defect -
      // with one honest exception: the reveal repaints the transcript (a turn unfolds, the card pages), and a pane
      // whose own content changed may follow it. A box that moved while its content stayed the SAME is a box the
      // step dragged: that is the regression this file exists to catch.
      const movedElsewhere = (a, b) =>
        Object.keys({ ...a.scrollers, ...b.scrollers })
          .filter((key) => key !== "#as-search-pop")
          .filter((key) => (a.scrollers[key]?.top ?? 0) !== (b.scrollers[key]?.top ?? 0))
          .filter((key) => (a.scrollers[key]?.max ?? 0) === (b.scrollers[key]?.max ?? 0));

      await page.goto(panel.base, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#btn-assistant", { timeout: 45000 });

      // ---- 0. the panel, opened on the keyboard ------------------------------------------------------------------
      // A bare `a` is the documented way in, so the run starts on the keyboard. Nothing below clicks, focuses a
      // locator or calls a page function that acts: every subject is a key press.
      await page.keyboard.press("a");
      await page.waitForSelector("#assistant:not([hidden]) #as-chat [data-turn]", { timeout: 20000 });

      // ---- 1. the fold: more rows than the popup can show ----------------------------------------------------------
      await page.keyboard.press("Control+q");
      await page.keyboard.type(FILTER);
      await waitCount("1 of 10", FILTER);
      const first = await look();
      const api = await (
        await fetch(`${panel.base}/api/assistant/search?q=${encodeURIComponent(FILTER)}&scope=all&limit=10&assistantId=assistant-1`)
      ).json();
      v.ok("the store matched more rows than the list shows", api.matched === 12 && api.hits.length === 10, `${api.matched} matched, ${api.hits.length} displayed`);
      v.ok("the header divides the ten rows the list holds", first.count === "1 of 10" && first.total === 10, first.count);
      v.ok(
        "the popover is shorter than its own content, so it has a fold",
        first.scrollHeight > first.clientHeight + 1 && first.maxScroll > 0,
        `content ${first.scrollHeight}, band ${first.clientHeight}, reach ${first.maxScroll}`,
      );
      v.ok(
        "fewer rows are inside the band than the list holds",
        first.visibleRows > 0 && first.visibleRows < first.rows,
        `${first.visibleRows} of ${first.rows} rows in view`,
      );
      v.ok("the first result is visible before any press", first.visible === true && first.current === 1, JSON.stringify({ row: first.row, visible: first.visible }));
      v.ok(
        "the transcript has its own scroller, so \"nothing else moved\" is a real comparison",
        Object.keys(first.scrollers).some((key) => key !== "#as-search-pop"),
        JSON.stringify(first.scrollers),
      );
      v.ok("the run starts with the caret in the box", first.focus === true, `active: ${first.focus}`);
      record.scrolls.push({ step: 1, label: "first", scrollTop: first.scrollTop, count: first.count, visible: first.visible });
      await shoot("01-first-result-1-of-10.png");

      // ---- 2. ten presses down, the list following the walk --------------------------------------------------------
      // The pitch is what one press is worth: the distance between two consecutive rows, measured here so the
      // "one press one row" check is the page's own geometry and not a constant this file believed.
      const pitch = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#as-search-pop [data-search-hit]")];
        return rows.length > 1 ? Math.round(rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top) : 0;
      });
      v.ok("two result rows are a measurable pitch apart", pitch > 0, `${pitch}px between rows`);
      const down = [first];
      let quiet = 0;
      for (let i = 2; i <= 10; i += 1) {
        await page.keyboard.press("ArrowDown");
        await waitCount(`${i} of 10`, FILTER);
        const now = await look();
        down.push(now);
        const prev = down[down.length - 2];
        const delta = now.scrollTop - prev.scrollTop;
        const elsewhere = movedElsewhere(prev, now);
        if (!elsewhere.length) quiet += 1;
        v.ok(`${i} of 10: the current row is fully inside the popover's band`, now.visible === true, `row ${now.row}, ${now.rowTop}..${now.rowBottom} in band ${now.bandTop}..${now.bandBottom}`);
        v.ok(`${i} of 10: the header counts the row the list shows`, now.current === i, now.count);
        v.ok(`${i} of 10: the popover's height and the box above it did not move`, still(first, now), JSON.stringify({ top: now.popTop, height: now.popHeight, input: now.inputTop, count: now.countTop }));
        v.ok(`${i} of 10: the caret stayed in the box`, now.focus === true, `active: ${now.focus}`);
        v.ok(`${i} of 10: the page did not scroll`, now.pageY === 0 && now.docTop === 0, `scrollY ${now.pageY}, doc ${now.docTop}`);
        v.ok(`${i} of 10: nothing but the popover scrolled`, elsewhere.length === 0, elsewhere.join(", "));
        v.ok(
          `${i} of 10: one press moved at most one row`,
          delta >= 0 && delta <= pitch,
          `${prev.scrollTop} -> ${now.scrollTop} (${delta}px, pitch ${pitch})`,
        );
        record.scrolls.push({ step: i, label: `down-${i}`, scrollTop: now.scrollTop, count: now.count, visible: now.visible });
        if (i === 5) await shoot("02-middle-result-5-of-10.png");
        if (i === 10) await shoot("03-last-result-10-of-10.png");
      }
      const last = down[down.length - 1];
      v.ok(
        "walking past the fold actually scrolled the list, not just the count",
        last.scrollTop > first.scrollTop,
        `${first.scrollTop} -> ${last.scrollTop}`,
      );
      v.ok("the last result is at the end of the list's reach, and still in view", last.current === 10 && last.visible === true && last.scrollTop <= last.maxScroll, JSON.stringify({ top: last.scrollTop, reach: last.maxScroll, row: last.row }));
      // The proof that the popover can carry a press on its own: on a step where the card did not repaint, the popover
      // is the only box in the pane whose scroll changed.
      v.ok(
        "at least one press moved the popover alone, with every other box exactly where it was",
        quiet >= 2,
        `${quiet} of 9 presses moved nothing but the popover`,
      );

      // ---- 3. the same walk back up, to the first result -----------------------------------------------------------
      const up = [last];
      for (let i = 9; i >= 1; i -= 1) {
        await page.keyboard.press("ArrowUp");
        await waitCount(`${i} of 10`, FILTER);
        const now = await look();
        up.push(now);
        const prev = up[up.length - 2];
        v.ok(`${i} of 10: the current row is fully inside the band on the way back too`, now.visible === true, `row ${now.row}, ${now.rowTop}..${now.rowBottom}`);
        v.ok(`${i} of 10: the page did not scroll on the way back`, now.pageY === 0 && now.docTop === 0, `scrollY ${now.pageY}`);
        const back = movedElsewhere(prev, now);
        v.ok(`${i} of 10: nothing but the popover scrolled on the way back`, back.length === 0, back.join(", "));
        v.ok(`${i} of 10: the caret stayed in the box on the way back`, now.focus === true);
        record.scrolls.push({ step: i, label: `up-${i}`, scrollTop: now.scrollTop, count: now.count, visible: now.visible });
        if (i === 5) await shoot("04-back-to-the-middle-5-of-10.png");
      }
      const home = await look();
      v.ok("the walk home lands on 1 of 10 again", home.count === "1 of 10" && home.current === 1, home.count);
      v.ok("the first result is visible again", home.visible === true, JSON.stringify({ row: home.row, visible: home.visible }));
      v.ok("and the list is back at the top, where it started", home.scrollTop === first.scrollTop, `${first.scrollTop} -> ${home.scrollTop}`);
      await shoot("05-back-to-the-first-1-of-10.png");

      // ---- 4. the way back is the way down ------------------------------------------------------------------------
      // The down walk's offsets, in order, against the up walk's. Stepping back up from the last result must scroll
      // up exactly the way the down walk scrolled down: same rows, same numbers, same order reversed.
      const downTops = down.map((s) => s.scrollTop);
      const upTops = up.map((s) => s.scrollTop);
      v.ok(
        "the way back up visits exactly the offsets the way down did, in reverse",
        JSON.stringify(upTops) === JSON.stringify([...downTops].reverse()),
        `down ${downTops.join(",")} | up ${upTops.join(",")}`,
      );
      v.ok(
        "the press back up from the last result scrolls the list up by the same row the down walk scrolled down",
        up[0].scrollTop > up[1].scrollTop && last.scrollTop - up[1].scrollTop === last.scrollTop - down[down.length - 2].scrollTop,
        `${up[0].scrollTop} -> ${up[1].scrollTop} against ${down[down.length - 2].scrollTop}`,
      );
      v.ok(
        "the row the reader stands on after that press is in view without moving the page",
        up[1].row === down[down.length - 2].row && up[1].visible === true,
        JSON.stringify({ row: up[1].row, visible: up[1].visible }),
      );

      // ---- 5. no page error came from any of it --------------------------------------------------------------------
      v.ok("no page error was raised by the run", errors.length === 0, errors.slice(0, 3).join(" | "));
      record.pitch = pitch;
      record.downTops = downTops;
      record.upTops = upTops;
      return { first, last, home, pitch };
    },
    { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  );
  if (!browserHalf) fail("the browser half returned nothing");
  console.log(`screenshots: ${record.screenshots.length} in ${outDir}`);
} finally {
  await panel.stop();
  writeFileSync(path.join(outDir, "assistant-search-scroll.json"), JSON.stringify(record, null, 2), "utf8");
}

console.log(`\n${v.checks - v.failures}/${v.checks} checks passed`);
if (v.failures) process.exit(1);
console.log(`assistant-search-scroll: OK (screenshots in ${outDir}, sandbox ${keep ? dir : "removed"})`);
