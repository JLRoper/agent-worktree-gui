// The assistant search over EVERY assistant's turns, proved in a real browser at 1440x900.
//
// WHY THIS SCRIPT EXISTS. The header search box sent the open tab's assistant id, so the corpus was the tab the
// reader happened to be looking at: a phrase in Assistant #2's turns was invisible while Assistant #1 was selected.
// The box asks about every assistant now - each one's own threads are searched and the lists are merged into one
// ordered index at query time - and a result row names its assistant so two hits from two assistants are told apart
// at a glance. Stepping or clicking such a row switches the panel to that assistant's tab, opens the thread, scrolls
// the turn into view and rings it.
//
// WHAT IT ASSERTS, in the order a reader would meet it:
//
//   A. THE CROSS-TAB FIND. Assistant #1 is the tab on screen, its card holds no `sextant` at all, and the filter
//      answers one row that names Assistant #2. The header reads 1 of 1 and the footer 1 hit matched, 1 displayed,
//      in 1 turn.
//   B. ENTER LANDS THERE. Enter switches the tab to Assistant #2, its card draws the turn, the turn is ringed
//      (.is-search-current), the matched text is the bright mark, and the turn is inside the float's visible band
//      and under the pointer (elementFromPoint finds it).
//   C. TWO ASSISTANTS, NEWEST FIRST. `beacon` exists in both: the list holds both rows, the newer Assistant #1 row
//      first and the older Assistant #2 row second, each naming its assistant, and the footer's 2 hits matched, 2
//      displayed, in 2 turns agrees with the two rows on screen.
//   D. A STEP CROSSES TABS TOO. One Down from 1 of 2 lands on 2 of 2, switches the panel to Assistant #2 and rings
//      that assistant's turn.
//   E. THE COST IS CAPPED. `common` matches a hundred and twenty turns across the two assistants: the answer says
//      120 matched, the popover draws ten rows, the header reads 1 of 10 in its amber cap, and the answer's own hits
//      carry ten rows. The time from the last keystroke to the count is recorded, not bounded by a sleep.
//   F. THE HOT AGENT SEARCH IS UNTOUCHED. Ctrl+Shift+Q still opens its own popover, its rows carry no assistant name
//      cell (that is the turn search's), and Escape still closes it.
//
// HOW TO RUN:  node tools/verify-assistant-search-all.mjs
//              node tools/verify-assistant-search-all.mjs --out <dir>   (defaults to the committed asset dir)
//              node tools/verify-assistant-search-all.mjs --keep         (leave the sandbox store behind)
//
// It boots THIS checkout's server.js on a free port with its own state directory and a SYNTHESIZED store of two
// assistants, so the proof is the same on a machine that has never opened the panel. The first steps are keyboard
// only; Enter and Down are the subjects.
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
const outDir = argOf("out", path.join(ROOT, "docs", "assets", "assistant-search-all"));
const dir = argOf("dir", path.join(os.tmpdir(), "wag-assistant-search-all-sandbox"));
mkdirSync(outDir, { recursive: true });
mkdirSync(dir, { recursive: true });
const shot = (name) => path.join(outDir, name);

const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  process.exit(1);
};

// ---- the store ---------------------------------------------------------------------------------------------
// TWO assistants, each on its own thread. The words are chosen so each filter has exactly one meaning:
//
//   sextant  only Assistant #2 holds it (its newest turn)
//   beacon   one in each assistant, Assistant #1's ten minutes old and Assistant #2's two hours old, so "newest
//            first ACROSS assistants" is a direction and not a coincidence
//   common   a hundred and twenty turns (sixty per assistant) spread over days, so the cap has to bite and the DOM
//            must stay at ten rows
const A1 = "assistant-1";
const A2 = "assistant-2";
const T1 = "panel-assistant";
const T2 = "panel-assistant-2";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const turn = (id, thread, n, startedAt, prompt, finalMessage, lines = []) => ({
  id,
  thread,
  turn: n,
  origin: "assistant",
  status: "done",
  startedAt: iso(startedAt),
  endedAt: iso(startedAt + 2 * MIN),
  lastActiveAt: iso(startedAt + 2 * MIN),
  prompt,
  finalMessage,
  lines,
});

const SExtantAt = now - 5 * MIN;
const SECRET = turn(
  "sextant-two",
  T2,
  1,
  SExtantAt,
  "sextant: the phrase only assistant two holds",
  "kept for assistant two",
  [],
);
const BEACON_ONE = turn(
  "beacon-one",
  T1,
  1,
  now - 10 * MIN,
  "beacon: assistant one's newest request",
  "acknowledged by assistant one",
  [],
);
const BEACON_TWO = turn(
  "beacon-two",
  T2,
  2,
  now - 2 * HOUR,
  "beacon: assistant two's older request",
  "acknowledged by assistant two",
  [],
);
// The hundred and twenty turns the cap has to hold back. Older than every beacon, in both assistants, so they never
// take a row the first two filters assert on.
const BULK = [];
for (let i = 0; i < 60; i += 1) {
  BULK.push(turn(`common-one-${i}`, T1, i + 2, now - (3 * DAY + i * 30 * MIN), `common row ${i + 1} for assistant one`, `ack ${i + 1}`, []));
  BULK.push(turn(`common-two-${i}`, T2, i + 3, now - (3 * DAY + i * 30 * MIN + 7 * MIN), `common row ${i + 1} for assistant two`, `ack ${i + 1}`, []));
}
// A turn in each assistant's card that matches nothing, so the card has a body under the hits.
const QUIET_ONE = turn("quiet-one", T1, 99, now - 9 * DAY, "a request that matches nothing", "done", []);
const QUIET_TWO = turn("quiet-two", T2, 99, now - 9 * DAY, "another quiet request", "done", []);

const TURNS = [SECRET, BEACON_ONE, BEACON_TWO, QUIET_ONE, QUIET_TWO, ...BULK];
const jobsFile = { version: 3, savedAt: new Date().toISOString(), jobs: TURNS };
const assistantsFile = {
  version: 1,
  assistants: [
    { id: A1, name: "Assistant #1", threadId: T1, rules: [] },
    { id: A2, name: "Assistant #2", threadId: T2, rules: [] },
  ],
};
const logsDir = path.join(dir, "logs");
mkdirSync(logsDir, { recursive: true });
writeFileSync(path.join(logsDir, "jobs.json"), JSON.stringify(jobsFile, null, 1), "utf8");
writeFileSync(path.join(logsDir, "assistants.json"), JSON.stringify(assistantsFile, null, 1), "utf8");

console.log(`store: ${TURNS.length} turns on two assistants; sextant = ${A2} only; beacon = one each; common = 120 rows`);

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
        const p = shot(name.replace(/\.png$/, "-1440x900.png"));
        await page.screenshot({ path: p });
        record.screenshots.push(path.basename(p));
        return p;
      };
      const state = (chat = "as-chat") =>
        page.evaluate((chatId) => {
          const n = document.getElementById("as-search-n");
          const pop = document.getElementById("as-search-pop");
          const foot = pop ? pop.querySelector(".as-search-more") : null;
          const rows = pop ? [...pop.querySelectorAll("[data-search-hit]")] : [];
          const heads = pop ? [...pop.querySelectorAll(".as-search-item")] : [];
          const kids = pop ? [...pop.children] : [];
          const current = pop ? pop.querySelector('[data-search-hit][aria-current="true"]') : null;
          const host = document.getElementById(chatId);
          const body = document.querySelector("#assistant .as-body");
          const turnEl = host ? host.querySelector(".turn.is-search-current") : null;
          const turnRect = turnEl ? turnEl.getBoundingClientRect() : null;
          const bodyRect = body ? body.getBoundingClientRect() : null;
          const center = turnRect ? { x: Math.round(turnRect.left + turnRect.width / 2), y: Math.round(turnRect.top + Math.min(40, turnRect.height / 2)) } : null;
          const atPoint = center ? document.elementFromPoint(center.x, center.y) : null;
          return {
            count: {
              text: n.textContent.trim(),
              hidden: n.hidden,
              current: Number(n.dataset.searchCurrent),
              total: Number(n.dataset.searchTotal),
              matched: Number(n.dataset.searchMatched),
              displayed: Number(n.dataset.searchDisplayed),
              turns: Number(n.dataset.searchTurns),
              query: n.dataset.searchQuery,
              capped: n.classList.contains("is-capped"),
            },
            popHidden: pop.hidden,
            rows: rows.map((row) => ({
              index: Number(row.dataset.searchHit),
              assistant: row.dataset.assistant || "",
              who: row.querySelector(".as-search-who")?.textContent.trim() || "",
              where: row.querySelector(".as-search-where")?.textContent.trim() || "",
              text: row.querySelector(".as-search-snip")?.textContent.trim() || "",
              current: row.getAttribute("aria-current") === "true",
            })),
            heads: heads.map((h) => h.textContent.trim()),
            lastBeforeFooter: kids.length ? kids[kids.length - 2]?.className || "" : "",
            footerLast: kids.length ? kids[kids.length - 1]?.className || "" : "",
            foot: foot ? foot.textContent.trim() : "",
            currentRow: current ? Number(current.dataset.searchHit) : -1,
            input: String(document.getElementById("as-search-q")?.value || ""),
            tab: [...document.querySelectorAll("#as-tabs [data-as-tab]")].filter((b) => b.classList.contains("is-on")).map((b) => b.dataset.asTab),
            view: (() => {
              try {
                return JSON.parse(localStorage.getItem("wm.assistantView") || "null");
              } catch {
                return null;
              }
            })(),
            chat: chatId,
            chatMode: host ? host.dataset.mode || null : null,
            ring: turnEl ? turnEl.dataset.turn : null,
            rings: host ? host.querySelectorAll(".turn.is-search-current").length : 0,
            marks: host ? host.querySelectorAll("mark.as-search-mark").length : 0,
            currentMarks: host ? host.querySelectorAll("mark.as-search-mark.is-current").length : 0,
            rowEdges: host ? host.querySelectorAll(".is-search-current-row").length : 0,
            inBand: Boolean(turnRect && bodyRect && turnRect.top >= bodyRect.top - 2 && turnRect.bottom <= bodyRect.bottom + 2),
            underPointer: Boolean(atPoint && turnEl && (turnEl === atPoint || turnEl.contains(atPoint))),
            turnRect: turnRect ? { top: Math.round(turnRect.top), bottom: Math.round(turnRect.bottom) } : null,
            bodyRect: bodyRect ? { top: Math.round(bodyRect.top), bottom: Math.round(bodyRect.bottom) } : null,
          };
        }, chat);
      const footNums = (foot) => {
        const m = /^(\d+) hits? matched, (\d+) displayed, in (\d+) turns?/.exec(foot);
        return m ? { matched: Number(m[1]), displayed: Number(m[2]), turns: Number(m[3]) } : null;
      };
      const agree = (label, s, want) => {
        const nums = footNums(s.foot);
        v.ok(`${label}: the footer reads "${want.foot}"`, s.foot === want.foot, s.foot);
        v.ok(
          `${label}: the header, the footer and the rows agree`,
          s.count.total === nums?.displayed && s.count.displayed === nums?.displayed && s.count.total === s.rows.length && s.rows.length <= 10,
          JSON.stringify({ header: s.count.text, total: s.count.total, displayed: s.count.displayed, rows: s.rows.length, foot: s.foot }),
        );
        v.ok(
          `${label}: matched is every hit across the assistants, not only the rows on hand`,
          nums?.matched === want.matched && s.count.matched === want.matched,
          JSON.stringify({ foot: nums, matched: s.count.matched }),
        );
        v.ok(`${label}: the footer names ${want.turns} matching turn${want.turns === 1 ? "" : "s"}`, nums?.turns === want.turns && s.count.turns === want.turns, JSON.stringify({ foot: nums, turns: s.count.turns }));
      };
      const waitCount = async (text, query, timeout = 15000) => {
        const started = Date.now();
        await page.waitForFunction(
          ({ want, q }) => {
            const n = document.getElementById("as-search-n");
            return Boolean(n && !n.hidden && n.textContent.trim() === want && n.dataset.searchQuery === q);
          },
          { want: text, q: query },
          { timeout },
        );
        return { s: await state(), ms: Date.now() - started };
      };
      const api = async (q, limit = 10) => (await fetch(`${panel.base}/api/assistant/search?q=${encodeURIComponent(q)}&scope=all&limit=${limit}`)).json();
      const openOn = async (assistant) => {
        await page.click(`#as-tabs [data-as-tab="${assistant}"]`);
        await page.waitForFunction((id) => JSON.parse(localStorage.getItem("wm.assistantView") || "null")?.assistant === id, assistant, { timeout: 10000 });
        await page.waitForTimeout(250);
      };

      await page.goto(panel.base, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#btn-assistant", { timeout: 45000 });

      // ---- 0. the panel, opened on the keyboard, on Assistant #1's tab ----------------------------------------------
      await page.keyboard.press("a");
      await page.waitForSelector("#assistant:not([hidden]) #as-chat [data-turn]", { timeout: 20000 });
      const start = await state();
      v.ok("the panel opened on the keyboard and drew Assistant #1's turns", start.tab.join() === A1, JSON.stringify(start.tab));
      const onScreen = await page.evaluate(() => [...document.querySelectorAll("#as-chat [data-turn]")].map((el) => el.dataset.turn));
      v.ok("Assistant #1's card holds none of Assistant #2's sextant turn", !onScreen.includes("sextant-two"), JSON.stringify(onScreen.slice(0, 8)));

      // ---- A. a phrase only the OTHER assistant holds, found while #1 is selected ----------------------------------
      await page.keyboard.press("Control+q");
      await page.keyboard.type("sextant");
      const found = await waitCount("1 of 1", "sextant");
      const foundAnswer = await api("sextant");
      v.ok(
        "the store answers one assistant hit, and it is Assistant #2's",
        foundAnswer.matched === 1 && foundAnswer.hits[0].assistantId === A2 && foundAnswer.hits[0].assistant === "Assistant #2",
        JSON.stringify(foundAnswer.hits.map((h) => `${h.id}:${h.assistantId}`)),
      );
      agree("cross-tab find", found.s, { foot: "1 hit matched, 1 displayed, in 1 turn", matched: 1, turns: 1 });
      v.ok("the row names Assistant #2", found.s.rows.length === 1 && found.s.rows[0].who === "Assistant #2", JSON.stringify(found.s.rows));
      v.ok("the row says whose turn it is on its data attribute too", found.s.rows[0]?.assistant === A2, found.s.rows[0]?.assistant);
      v.ok("the panel is still on Assistant #1's tab (the find did not move it by itself)", found.s.tab.join() === A1, JSON.stringify(found.s.tab));
      v.ok("the other assistant's turn is not on #1's card yet, so nothing is ringed", found.s.rings === 0 && found.s.marks === 0, JSON.stringify({ rings: found.s.rings, marks: found.s.marks }));
      record.filters.sextant = { text: found.s.count.text, foot: found.s.foot, rows: found.s.rows.map((r) => `${r.who}: ${r.text}`), answer: foundAnswer.hits.map((h) => `${h.id}:${h.assistantId}`) };
      await shoot("01-cross-tab-found-1-of-1.png");

      // ---- B. Enter lands on THAT assistant, with the turn in view and ringed ---------------------------------------
      await page.keyboard.press("Enter");
      await page.waitForSelector("#as-chat-2 .turn.is-search-current", { timeout: 10000 });
      const landed = await state("as-chat-2");
      v.ok("Enter switched the panel to Assistant #2's tab", landed.tab.join() === A2 && landed.view?.assistant === A2, JSON.stringify({ tab: landed.tab, view: landed.view }));
      v.ok("and its card is drawing the thread the turn is on", landed.chatMode === "card", landed.chatMode);
      v.ok("the turn the filter found is the one ringed", landed.ring === "sextant-two" && landed.rings === 1, JSON.stringify({ ring: landed.ring, rings: landed.rings }));
      v.ok("the matched text is marked inside it, and it is the bright current mark", landed.marks >= 1 && landed.currentMarks === 1, JSON.stringify({ marks: landed.marks, currentMarks: landed.currentMarks }));
      v.ok("the turn was scrolled into the float's visible band", landed.inBand === true && landed.underPointer === true, JSON.stringify({ rect: landed.turnRect, band: landed.bodyRect, underPointer: landed.underPointer }));
      v.ok("the popover got out of the way of the turn it opened", landed.popHidden === true, landed.popHidden);
      record.steps.push({ press: "Enter", tab: landed.tab.join(), ring: landed.ring, inBand: landed.inBand, underPointer: landed.underPointer });
      await shoot("02-enter-landed-on-assistant-2.png");

      // ---- C. a phrase in BOTH assistants: both rows, newest first, each naming its assistant ----------------------
      await openOn(A1);
      await page.keyboard.press("Control+q");
      await page.keyboard.type("beacon");
      const both = await waitCount("1 of 2", "beacon");
      const bothAnswer = await api("beacon");
      v.ok(
        "the store answers both assistants' beacon turns, Assistant #1's newest first",
        bothAnswer.matched === 2 && bothAnswer.hits.map((h) => h.assistantId).join() === `${A1},${A2}`,
        JSON.stringify(bothAnswer.hits.map((h) => `${h.id}:${h.assistantId}`)),
      );
      agree("two assistants", both.s, { foot: "2 hits matched, 2 displayed, in 2 turns", matched: 2, turns: 2 });
      v.ok(
        "the rows read newest first across the two assistants, and each names its own",
        both.s.rows.length === 2 && both.s.rows[0].who === "Assistant #1" && both.s.rows[0].text.includes("newest request") && both.s.rows[1].who === "Assistant #2" && both.s.rows[1].text.includes("older request"),
        JSON.stringify(both.s.rows),
      );
      v.ok("each message's header names its assistant too", both.s.heads.length === 2 && both.s.heads[0].includes("Assistant #1") && both.s.heads[1].includes("Assistant #2"), JSON.stringify(both.s.heads));
      v.ok("the last row before the footer is a result", both.s.footerLast.includes("as-search-more") && both.s.lastBeforeFooter.includes("as-search-row"), JSON.stringify({ lastBeforeFooter: both.s.lastBeforeFooter, footerLast: both.s.footerLast }));
      record.filters.beacon = { text: both.s.count.text, foot: both.s.foot, rows: both.s.rows.map((r) => `${r.who}: ${r.text}`) };
      await shoot("03-two-assistants-newest-first-1-of-2.png");

      // ---- D. one Down crosses to the other assistant's tab -------------------------------------------------------
      await page.keyboard.press("ArrowDown");
      const second = await waitCount("2 of 2", "beacon");
      await page.waitForSelector("#as-chat-2 .turn.is-search-current", { timeout: 10000 });
      const stepped = await state("as-chat-2");
      v.ok("one Down reads 2 of 2 on the second assistant's hit", stepped.count.current === 2 && stepped.count.text === "2 of 2", stepped.count.text);
      v.ok("and the step switched the panel to Assistant #2", stepped.tab.join() === A2, JSON.stringify(stepped.tab));
      v.ok("the turn that step landed on is ringed in its own card", stepped.ring === "beacon-two" && stepped.rings === 1, JSON.stringify({ ring: stepped.ring, rings: stepped.rings }));
      v.ok("the step put that turn in the visible band", stepped.inBand === true && stepped.underPointer === true, JSON.stringify({ rect: stepped.turnRect, band: stepped.bodyRect }));
      v.ok("the list stayed up while stepping (its footer is half of the count)", second.s.popHidden === false, second.s.popHidden);
      record.steps.push({ press: "ArrowDown", count: second.s.count.text, tab: stepped.tab.join(), ring: stepped.ring });
      await shoot("04-stepped-to-assistant-2-2-of-2.png");

      // ---- E. a filter over a whole store stays ten rows, and the counts stay honest -------------------------------
      await page.keyboard.press("Control+q");
      await page.keyboard.type("common");
      const bulk = await waitCount("1 of 10", "common", 20000);
      const bulkAnswer = await api("common");
      v.ok("the store answers a hundred and twenty matching rows across the two assistants", bulkAnswer.matched === 120 && bulkAnswer.hits.length === 10, `${bulkAnswer.matched} matched, ${bulkAnswer.hits.length} in the answer`);
      agree("whole store", bulk.s, { foot: "120 hits matched, 10 displayed, in 120 turns - your own input is kept when the cap bites", matched: 120, turns: 120 });
      v.ok("the popover draws exactly ten rows - the store never becomes the DOM", bulk.s.rows.length === 10 && bulk.s.rows.every((r) => r.where === "you"), String(bulk.s.rows.length));
      v.ok("the count is amber: the cap is a fact the count does not hide", bulk.s.count.capped === true && bulk.s.count.text === "1 of 10", JSON.stringify({ capped: bulk.s.count.capped, text: bulk.s.count.text }));
      v.ok("every one of the ten rows names an assistant", bulk.s.rows.every((r) => r.who === "Assistant #1" || r.who === "Assistant #2"), JSON.stringify(bulk.s.rows.map((r) => r.who)));
      v.ok("the answer arrived while the box stayed responsive", bulk.ms > 0 && bulk.ms < 15000, `${bulk.ms}ms from the last keystroke to the count`);
      record.filters.common = { text: bulk.s.count.text, foot: bulk.s.foot, rows: bulk.s.rows.length, matched: bulkAnswer.matched, ms: bulk.ms };
      await shoot("05-whole-store-capped-1-of-10.png");

      // ---- F. the Hot Agent search still has its own corpus and its own rows --------------------------------------
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.getElementById("as-search-pop").hidden, null, { timeout: 5000 });
      await page.keyboard.press("Control+Shift+Q");
      await page.waitForFunction(() => !document.getElementById("ha-search-pop").hidden, null, { timeout: 10000 });
      const hot = await page.evaluate(() => {
        const pop = document.getElementById("ha-search-pop");
        const rows = [...pop.querySelectorAll(".as-search-row")];
        return {
          open: !pop.hidden,
          rows: rows.length,
          named: pop.querySelectorAll(".as-search-who").length,
          twoCell: rows.every((r) => !r.classList.contains("as-search-row-who")),
          countText: document.getElementById("ha-search-n")?.textContent?.trim() || "",
          searchPopHidden: document.getElementById("as-search-pop").hidden,
        };
      });
      v.ok("Ctrl+Shift+Q still opens the Hot Agent search", hot.open === true, JSON.stringify(hot));
      v.ok("its rows carry no assistant-name cell and keep their own two-cell shape", hot.named === 0 && hot.twoCell === true, JSON.stringify({ named: hot.named, twoCell: hot.twoCell }));
      v.ok("the turn search's popover is closed while the Hot Agent one is open", hot.searchPopHidden === true, hot.searchPopHidden);
      await shoot("06-hot-agent-search-unchanged.png");
      await page.keyboard.press("Escape");
      const hotClosed = await page.evaluate(() => document.getElementById("ha-search-pop").hidden);
      v.ok("Escape still closes it", hotClosed === true, hotClosed);

      // ---- no page error came from any of it -----------------------------------------------------------------------
      v.ok("no page error was raised by the run", errors.length === 0, errors.slice(0, 3).join(" | "));
      return { start, found: found.s, landed, both: both.s, stepped, bulk: bulk.s, hot };
    },
    { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  );
  if (!browserHalf) fail("the browser half returned nothing");
  console.log(`screenshots: ${record.screenshots.length} in ${outDir}`);
} finally {
  await panel.stop();
  writeFileSync(path.join(outDir, "assistant-search-all.json"), JSON.stringify(record, null, 2), "utf8");
}

console.log(`\n${v.checks - v.failures}/${v.checks} checks passed`);
if (v.failures) process.exit(1);
console.log(`assistant-search-all: OK (screenshots in ${outDir}, sandbox ${keep ? dir : "removed"})`);
