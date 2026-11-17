// The assistant search's ORDER and its outside-click DISMISSAL, proved in a real browser at 1440x900.
//
// WHY THIS SCRIPT EXISTS. Two things about the results popover were wrong for the reader:
//
//   1. THE ORDER WAS THE CAP'S, NOT THE CLOCK'S. The server answers in the cap's preference - your own input first,
//      then replies, then console lines - because that decides which matches survive ten rows. The popover drew
//      that answer as it arrived, so a filter whose hits span hours read a six-hour-old prompt on top and the reply
//      from five minutes ago at the bottom. The list is ordered by the clock now
//      (public/core/search-items.js `order`): one item per message, newest first by the message's newest row, the
//      rows inside a message in reading order (prompt, console lines, reply). This script proves the newest match
//      is 1 of N, that one Down moves to the SECOND newest, and that the oldest is last.
//   2. THE LIST WOULD NOT CLOSE ON AN OUTSIDE CLICK. Only a key or a row closed it. A mousedown outside the box and
//      outside the list - the transcript below, another pane of the float - closes it and drops the highlight now
//      (public/core/search-dismiss.js), while the filter stays in the box so the list comes back without retyping.
//
// WHAT IT ASSERTS, in the order a reader would meet it:
//
//   A. THE ANSWER'S OWN ORDER IS NOT THE LIST'S. The store's answer for the spanning filter lists the oldest prompt
//      first; the popover lists it last. Both are printed, so the reordering is the page's and not the server's.
//   B. NEWEST FIRST, OLDEST LAST. The popover's rows read newest reply, two-hour reply, five-hour console line,
//      six-hour prompt; the count reads "1 of 4" on the newest; one Down reads "2 of 4" on the second newest; two
//      more Downs read "4 of 4" on the oldest.
//   C. ONE MESSAGE READS TOP TO BOTTOM. A second filter matches one message in its prompt, three console rows and
//      its reply: the rows read prompt, row 1, row 2, row 3, reply - and every item has exactly one header, the last
//      row before the footer is a row, and no header trails the last item.
//   D. AN OUTSIDE MOUSEDOWN CLOSES IT. A click on the transcript below hides the popover and the count and drops the
//      ring, the marks and the row highlight; the filter stays in the box; the count is not left behind.
//   E. ONE KEY BRINGS IT BACK. With the caret back in the box, one Down reopens the list on the same filter ("1 of 4")
//      without retyping it.
//   F. INSIDE IS STILL INSIDE. A click on a row selects that row (the ring moves, the list gets out of the way), and a
//      DRAG that starts on a row and ends over the transcript does not close the list.
//   G. ANOTHER PANE IS OUTSIDE. A mousedown on this assistant's Notes sub-tab closes the list (the pane switch is the
//      reader going somewhere else). Escape keeps its old behaviour: it clears the filter and leaves the caret in the
//      box.
//
// HOW TO RUN:  node tools/verify-assistant-search-order.mjs
//              node tools/verify-assistant-search-order.mjs --out <dir>   (defaults to the committed asset dir)
//              node tools/verify-assistant-search-order.mjs --keep         (leave the sandbox store behind)
//
// It boots THIS checkout's server.js on a free port with its own state directory and a SYNTHESIZED store whose hits
// are laid out HOURS apart, so the proof is the same on a machine that has never opened the panel. The ordering steps
// are keyboard-only; the dismissal steps use the mouse because a mousedown is the subject.
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
const outDir = argOf("out", path.join(ROOT, "docs", "assets", "assistant-search-order"));
const dir = argOf("dir", path.join(os.tmpdir(), "wag-assistant-search-order-sandbox"));
mkdirSync(outDir, { recursive: true });
mkdirSync(dir, { recursive: true });
const shot = (name) => path.join(outDir, name);

const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  process.exit(1);
};

// ---- the store ---------------------------------------------------------------------------------------------
// HARBOR: four messages whose only matching row is in a DIFFERENT field each, laid out hours apart. The server's
// answer therefore leads with the oldest prompt (the cap's preference), while the reader needs the five-minute reply
// first - the exact defect, with one row per message so a Down moves a message.
//
// LANTERN: one message matching in its prompt, three console rows and its reply, so the rows inside one item can be
// read in order and the item header can say how many rows it carries.
const HARBOR_FILTER = "harbor";
const LANTERN_FILTER = "lantern";
const THREAD = "panel-assistant";
const MIN = 60_000;
const HOUR = 60 * MIN;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const line = (lid, text, at) => ({ kind: "tool", lid, text, at });

const HARBOR = [
  {
    id: "harbor-a",
    thread: THREAD,
    turn: 1,
    origin: "assistant",
    status: "done",
    startedAt: iso(now - 6 * HOUR),
    endedAt: iso(now - 6 * HOUR + 4 * MIN),
    lastActiveAt: iso(now - 6 * HOUR + 4 * MIN),
    prompt: `${HARBOR_FILTER}: the request from six hours ago`,
    finalMessage: "nothing to do",
    lines: [],
  },
  {
    id: "harbor-b",
    thread: THREAD,
    turn: 2,
    origin: "assistant",
    status: "done",
    startedAt: iso(now - 5 * HOUR - 10 * MIN),
    endedAt: iso(now - 5 * HOUR + 2 * MIN),
    lastActiveAt: iso(now - 5 * HOUR + 2 * MIN),
    prompt: "the second request",
    finalMessage: "read it",
    lines: [line("harbor-b1", `grep -n ${HARBOR_FILTER} lib/x.js`, now - 5 * HOUR)],
  },
  {
    id: "harbor-c",
    thread: THREAD,
    turn: 3,
    origin: "assistant",
    status: "done",
    startedAt: iso(now - 2 * HOUR - 10 * MIN),
    endedAt: iso(now - 2 * HOUR),
    lastActiveAt: iso(now - 2 * HOUR),
    prompt: "the third request",
    finalMessage: `${HARBOR_FILTER} is quiet now`,
    lines: [],
  },
  {
    id: "harbor-d",
    thread: THREAD,
    turn: 4,
    origin: "assistant",
    status: "done",
    startedAt: iso(now - 10 * MIN),
    endedAt: iso(now - 5 * MIN),
    lastActiveAt: iso(now - 5 * MIN),
    prompt: "the newest request",
    finalMessage: `${HARBOR_FILTER}: the newest reply`,
    lines: [],
  },
];

const lanternAt = now - 30 * MIN;
const LANTERN = {
  id: "lantern-turn",
  thread: THREAD,
  turn: 5,
  origin: "assistant",
  status: "done",
  startedAt: iso(lanternAt),
  endedAt: iso(lanternAt + 4 * MIN),
  lastActiveAt: iso(lanternAt + 4 * MIN),
  prompt: `${LANTERN_FILTER}: read me top to bottom`,
  finalMessage: `${LANTERN_FILTER}: the reply, last`,
  lines: [
    line("lantern-1", `${LANTERN_FILTER} row one`, lanternAt + 1 * MIN),
    line("lantern-2", `${LANTERN_FILTER} row two`, lanternAt + 2 * MIN),
    line("lantern-3", `${LANTERN_FILTER} row three`, lanternAt + 3 * MIN),
  ],
};

// What holds the filter but is not asserted on: an older message with no match at all, so the card has a body.
const QUIET = {
  id: "quiet-turn",
  thread: THREAD,
  turn: 6,
  origin: "assistant",
  status: "done",
  startedAt: iso(now - 8 * HOUR),
  endedAt: iso(now - 8 * HOUR + MIN),
  lastActiveAt: iso(now - 8 * HOUR + MIN),
  prompt: "a request that matches nothing",
  finalMessage: "done",
  lines: [],
};

const TURNS = [QUIET, ...HARBOR, LANTERN];
const jobsFile = { version: 3, savedAt: new Date().toISOString(), jobs: TURNS };
const assistantsFile = { version: 2, assistants: [{ id: "assistant-1", name: "Assistant #1", threadId: THREAD }] };
const logsDir = path.join(dir, "logs");
mkdirSync(logsDir, { recursive: true });
writeFileSync(path.join(logsDir, "jobs.json"), JSON.stringify(jobsFile, null, 1), "utf8");
writeFileSync(path.join(logsDir, "assistants.json"), JSON.stringify(assistantsFile, null, 1), "utf8");

console.log(
  `store: ${TURNS.length} turns; ${HARBOR_FILTER} = 4 rows in 4 messages spanning 6h..5m; ${LANTERN_FILTER} = 5 rows in 1 message`,
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
        const p = shot(name.replace(/\.png$/, "-1440x900.png"));
        await page.screenshot({ path: p });
        record.screenshots.push(path.basename(p));
        return p;
      };
      const state = () =>
        page.evaluate(() => {
          const n = document.getElementById("as-search-n");
          const pop = document.getElementById("as-search-pop");
          const foot = pop ? pop.querySelector(".as-search-more") : null;
          const rows = pop ? [...pop.querySelectorAll("[data-search-hit]")] : [];
          const heads = pop ? [...pop.querySelectorAll(".as-search-item")] : [];
          const kids = pop ? [...pop.children] : [];
          const current = pop ? pop.querySelector('[data-search-hit][aria-current="true"]') : null;
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
              item: Number(row.dataset.searchItem),
              where: row.querySelector(".as-search-where")?.textContent.trim() || "",
              meta: row.querySelector(".as-search-meta")?.textContent.trim() || "",
              text: row.querySelector(".as-search-snip")?.textContent.trim() || "",
              current: row.getAttribute("aria-current") === "true",
            })),
            heads: heads.map((h) => h.textContent.trim()),
            lastBeforeFooter: kids.length ? (kids[kids.length - 2]?.className || "") : "",
            footerLast: kids.length ? kids[kids.length - 1]?.className || "" : "",
            foot: foot ? foot.textContent.trim() : "",
            currentRow: current ? Number(current.dataset.searchHit) : -1,
            input: String(document.getElementById("as-search-q")?.value || ""),
            ring: (() => {
              const turn = document.querySelector("#as-chat .turn.is-search-current");
              return turn ? turn.dataset.turn : null;
            })(),
            rings: document.querySelectorAll("#as-chat .turn.is-search-current").length,
            marks: document.querySelectorAll("#as-chat mark.as-search-mark").length,
            currentMarks: document.querySelectorAll("#as-chat mark.as-search-mark.is-current").length,
            rowEdges: document.querySelectorAll("#as-chat .is-search-current-row").length,
            focused: document.activeElement ? document.activeElement.id || document.activeElement.tagName : "",
          };
        });
      const footNums = (foot) => {
        const m = /^(\d+) hits? matched, (\d+) displayed, in (\d+) turns?/.exec(foot);
        return m ? { matched: Number(m[1]), displayed: Number(m[2]), turns: Number(m[3]) } : null;
      };
      const agree = (label, s, want) => {
        const nums = footNums(s.foot);
        v.ok(`${label}: the footer reads "${want.foot}"`, s.foot === want.foot, s.foot);
        v.ok(
          `${label}: the header's total is the footer's displayed count`,
          s.count.total === nums?.displayed && s.count.displayed === nums?.displayed && s.count.total === s.rows.length,
          JSON.stringify({ header: s.count.text, total: s.count.total, displayed: s.count.displayed, rows: s.rows.length, foot: s.foot }),
        );
        v.ok(
          `${label}: the footer's matched count is the answer's own`,
          nums?.matched === want.matched && s.count.matched === want.matched,
          JSON.stringify({ foot: nums, matched: s.count.matched }),
        );
        v.ok(`${label}: the footer names ${want.turns} matching turn${want.turns === 1 ? "" : "s"}`, nums?.turns === want.turns && s.count.turns === want.turns, JSON.stringify({ foot: nums, turns: s.count.turns }));
      };
      const waitCount = async (text, query) => {
        await page.waitForFunction(
          ({ want, q }) => {
            const n = document.getElementById("as-search-n");
            return Boolean(n && !n.hidden && n.textContent.trim() === want && n.dataset.searchQuery === q);
          },
          { want: text, q: query },
          { timeout: 15000 },
        );
        return state();
      };
      const api = async (q) => (await fetch(`${panel.base}/api/assistant/search?q=${encodeURIComponent(q)}&scope=all&limit=10&assistantId=assistant-1`)).json();
      // A point on this assistant's transcript that is BELOW the popover: the click the brief calls "the transcript
      // below it". Asserted to land on a node inside #as-chat and outside the list before anything is pressed.
      const transcriptPoint = async () =>
        page.evaluate(() => {
          const chat = document.getElementById("as-chat");
          const pop = document.getElementById("as-search-pop");
          const c = chat.getBoundingClientRect();
          const p = pop.getBoundingClientRect();
          const x = Math.round(Math.max(c.left + 24, Math.min(c.right - 24, (c.left + c.right) / 2)));
          let y = Math.round(p.bottom + 24);
          if (y > c.bottom - 24) y = Math.round((p.top + c.bottom) / 2);
          const el = document.elementFromPoint(x, y);
          return {
            x,
            y,
            inChat: Boolean(el && chat.contains(el)),
            inPop: Boolean(el && pop.contains(el)),
            hit: el ? `${el.tagName}.${String(el.className || "")}` : null,
          };
        });
      const clickPoint = async ({ x, y }) => {
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.up();
      };

      await page.goto(panel.base, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#btn-assistant", { timeout: 45000 });

      // ---- 0. the panel, opened on the keyboard ------------------------------------------------------------------
      await page.keyboard.press("a");
      await page.waitForSelector("#assistant:not([hidden]) #as-chat [data-turn]", { timeout: 20000 });
      const drawn = await page.evaluate(() => [...document.querySelectorAll("#as-chat [data-turn]")].map((el) => el.dataset.turn));
      v.ok("the panel opened on the keyboard and drew its turns", drawn.length > 0, `${drawn.length} turns on screen`);

      // ---- A. the answer's own order is the cap's, and the list's is not -------------------------------------------
      await page.keyboard.press("Control+q");
      await page.keyboard.type(HARBOR_FILTER);
      const newest = await waitCount("1 of 4", HARBOR_FILTER);
      const answer = await api(HARBOR_FILTER);
      v.ok(
        "the store answers four rows in four messages, the OLDEST prompt first (the cap's preference)",
        answer.matched === 4 && answer.turns === 4 && answer.hits[0].id === "harbor-a" && answer.hits[0].field === "input",
        JSON.stringify(answer.hits.map((h) => `${h.id}:${h.field}`)),
      );
      v.ok(
        "the popover does NOT draw the answer's order: the oldest prompt is its LAST row",
        newest.rows[newest.rows.length - 1].text.includes("six hours ago") && newest.rows[0].text.includes("newest reply"),
        JSON.stringify(newest.rows.map((r) => r.text)),
      );

      // ---- B. newest first, oldest last, and Down walks backwards in time -----------------------------------------
      agree("spanning filter", newest, { foot: "4 hits matched, 4 displayed, in 4 turns", matched: 4, turns: 4 });
      v.ok("the count reads 1 of 4 with the newest match current", newest.count.current === 1 && newest.currentRow === 0, JSON.stringify({ text: newest.count.text, currentRow: newest.currentRow }));
      assertOrder("the rows read newest reply, two-hour reply, five-hour line, six-hour prompt", newest.rows.map((r) => r.text), [
        "newest reply",
        "harbor is quiet now",
        "grep -n harbor",
        "six hours ago",
      ]);
      v.ok("the newest match is the ringed turn, and it is harbor-d", newest.ring === "harbor-d" && newest.rings === 1, JSON.stringify({ ring: newest.ring, rings: newest.rings }));
      v.ok("every item has its own header and there are four of them", newest.heads.length === 4, JSON.stringify(newest.heads));
      v.ok(
        "the last row before the footer is a RESULT, not a next-item header",
        newest.footerLast.includes("as-search-more") && newest.lastBeforeFooter.includes("as-search-row") && !newest.lastBeforeFooter.includes("as-search-item"),
        JSON.stringify({ lastBeforeFooter: newest.lastBeforeFooter, footerLast: newest.footerLast }),
      );
      record.filters.harbor = { text: newest.count.text, foot: newest.foot, rows: newest.rows.map((r) => r.text), answer: answer.hits.map((h) => h.id) };
      await shoot("01-newest-first-1-of-4.png");

      await page.keyboard.press("ArrowDown");
      const second = await waitCount("2 of 4", HARBOR_FILTER);
      v.ok("one Down reads 2 of 4 on that spanning filter", second.count.current === 2 && second.count.text === "2 of 4", second.count.text);
      v.ok("the press moved to the SECOND newest match, not to the oldest", second.ring === "harbor-c", JSON.stringify({ ring: second.ring, currentRow: second.currentRow }));
      record.steps.push({ press: "ArrowDown", count: second.count.text, turn: second.ring });
      await shoot("02-down-second-newest-2-of-4.png");

      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      const oldest = await waitCount("4 of 4", HARBOR_FILTER);
      v.ok("the oldest match is LAST: 4 of 4 is harbor-a", oldest.count.current === 4 && oldest.ring === "harbor-a", JSON.stringify({ text: oldest.count.text, ring: oldest.ring }));
      record.steps.push({ press: "ArrowDown x2", count: oldest.count.text, turn: oldest.ring });
      await shoot("03-oldest-last-4-of-4.png");

      // ---- C. one message reads top to bottom, and no header trails it ---------------------------------------------
      await page.keyboard.press("Control+q");
      await page.keyboard.type(LANTERN_FILTER);
      const one = await waitCount("1 of 5", LANTERN_FILTER);
      const oneAnswer = await api(LANTERN_FILTER);
      v.ok("the store answers five rows in one message", oneAnswer.matched === 5 && oneAnswer.turns === 1, `${oneAnswer.matched} hits, ${oneAnswer.turns} turn`);
      agree("one message", one, { foot: "5 hits matched, 5 displayed, in 1 turn", matched: 5, turns: 1 });
      assertOrder("the rows inside one message keep reading order", one.rows.map((r) => r.text), [
        "read me top to bottom",
        "row one",
        "row two",
        "row three",
        "the reply, last",
      ]);
      v.ok("the message has exactly ONE header, and it says how many rows matched", one.heads.length === 1 && /5 rows/.test(one.heads[0]), JSON.stringify(one.heads));
      v.ok(
        "no header trails the message: the last row before the footer is a row",
        one.footerLast.includes("as-search-more") && one.lastBeforeFooter.includes("as-search-row"),
        JSON.stringify({ lastBeforeFooter: one.lastBeforeFooter, footerLast: one.footerLast }),
      );
      v.ok("the current row is the prompt, at the top of the message", one.currentRow === 0 && one.rows[0].where === "you", JSON.stringify({ currentRow: one.currentRow, where: one.rows[0]?.where }));
      record.filters.lantern = { text: one.count.text, head: one.heads[0], rows: one.rows.map((r) => r.text), answer: oneAnswer.hits.map((h) => h.field) };
      await shoot("04-one-message-reading-order-1-of-5.png");

      // ---- D. an outside mousedown closes the list, and the filter stays ------------------------------------------
      await page.keyboard.press("Control+q");
      await page.keyboard.type(HARBOR_FILTER);
      const open = await waitCount("1 of 4", HARBOR_FILTER);
      v.ok("the list is open again on the spanning filter, with the highlight on", open.popHidden === false && open.ring === "harbor-d" && open.rings === 1, JSON.stringify({ hidden: open.popHidden, ring: open.ring, rings: open.rings }));
      const spot = await transcriptPoint();
      v.ok("the click point is on the transcript below the list", spot.inChat === true && spot.inPop === false, JSON.stringify(spot));
      await clickPoint(spot);
      await page.waitForFunction(() => document.getElementById("as-search-pop").hidden, null, { timeout: 5000 });
      const closed = await state();
      v.ok("a mousedown on the transcript closes the list", closed.popHidden === true, JSON.stringify({ hidden: closed.popHidden }));
      v.ok("and it drops the highlight: no ring, no marks, no row edge", closed.rings === 0 && closed.marks === 0 && closed.rowEdges === 0, JSON.stringify({ rings: closed.rings, marks: closed.marks, rowEdges: closed.rowEdges }));
      v.ok("the filter stays in the box", closed.input === HARBOR_FILTER, JSON.stringify({ input: closed.input }));
      v.ok("no stale count is left beside the box", closed.count.hidden === true && closed.count.text === "", JSON.stringify(closed.count));
      record.steps.push({ click: "transcript", x: spot.x, y: spot.y, hidden: closed.popHidden, input: closed.input, count: closed.count.text });
      await shoot("05-outside-click-closed.png");

      // ---- E. one key brings the list back, without retyping the filter --------------------------------------------
      // The click that closes list takes the caret with it (it landed on the transcript), so the reader's way back is
      // the box: click it once, then ONE key. The filter is still there, so nothing is retyped.
      await page.click("#as-search-q");
      const refocused = await state();
      v.ok("clicking the box does not reopen or disturb it", refocused.popHidden === true && refocused.input === HARBOR_FILTER, JSON.stringify({ hidden: refocused.popHidden, input: refocused.input }));
      await page.keyboard.press("ArrowDown");
      const back = await waitCount("1 of 4", HARBOR_FILTER);
      v.ok("one Down reopens the list on the same filter, at 1 of 4", back.popHidden === false && back.count.text === "1 of 4" && back.input === HARBOR_FILTER, JSON.stringify({ hidden: back.popHidden, text: back.count.text, input: back.input }));
      v.ok("the reopened list is ordered the same way", back.ring === "harbor-d" && back.rows[0].text.includes("newest reply"), JSON.stringify({ ring: back.ring, first: back.rows[0]?.text }));
      record.steps.push({ press: "ArrowDown after reopen", count: back.count.text, turn: back.ring });
      await shoot("06-one-key-reopened-1-of-4.png");

      // ---- F. inside is still inside: a drag that starts on a row does not close the list -------------------------
      const rowBox = await page.evaluate(() => {
        const row = document.querySelector('#as-search-pop [data-search-hit="1"]');
        const r = row.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      await page.mouse.move(rowBox.x, rowBox.y);
      await page.mouse.down();
      await page.mouse.move(spot.x, spot.y, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      const dragged = await state();
      v.ok("a drag that STARTS inside the results does not close them", dragged.popHidden === false && dragged.count.text === "1 of 4", JSON.stringify({ hidden: dragged.popHidden, text: dragged.count.text }));
      v.ok("and the drag did not open the row it started on", dragged.count.current === 1 && dragged.ring === "harbor-d", JSON.stringify({ current: dragged.count.current, ring: dragged.ring }));

      // A click on a row still selects that row, as before.
      await page.click('#as-search-pop [data-search-hit="2"]');
      await page.waitForFunction(() => document.getElementById("as-search-pop").hidden, null, { timeout: 5000 });
      const selected = await state();
      v.ok("a click inside the results still selects that row", selected.count.text === "3 of 4" && selected.ring === "harbor-b", JSON.stringify({ text: selected.count.text, ring: selected.ring }));
      v.ok("and the click gets the list out of the way, as Enter does", selected.popHidden === true, JSON.stringify({ hidden: selected.popHidden }));
      record.steps.push({ click: "row 2", count: selected.count.text, turn: selected.ring });
      await shoot("07-inside-click-selects-3-of-4.png");

      // ---- G. another pane is outside; Escape keeps its behaviour --------------------------------------------------
      // The list opens over whatever pane is on screen, so the Settings pane is made the visible one FIRST and the
      // click below lands in that pane, not on a tab the popover is covering.
      await page.click('[data-as-subtab="settings"]');
      await page.waitForSelector('[data-subpane="settings"]:not([hidden])', { timeout: 10000 });
      await page.keyboard.press("Control+q");
      await page.keyboard.type(HARBOR_FILTER);
      const inSettings = await waitCount("1 of 4", HARBOR_FILTER);
      const paneSpot = await page.evaluate(() => {
        const pane = document.querySelector('[data-subpane="settings"]');
        const pop = document.getElementById("as-search-pop");
        const c = pane.getBoundingClientRect();
        const p = pop.getBoundingClientRect();
        const quiet = ["DIV", "SECTION", "P", "LABEL", "SPAN", "H2", "H3", "TD"];
        for (let y = Math.round(c.top + 24); y < c.bottom - 24; y += 32) {
          const x = Math.round(c.left + 24);
          const el = document.elementFromPoint(x, y);
          if (!el) continue;
          if (!pane.contains(el) || pop.contains(el)) continue;
          if (!quiet.includes(el.tagName)) continue;
          return { x, y, inPane: true, inPop: false, hit: `${el.tagName}.${String(el.className || "")}` };
        }
        return { x: 0, y: 0, inPane: false, inPop: !!p.contains(document.elementFromPoint(Math.round(c.left + 24), Math.round(c.top + 24))), hit: "none" };
      });
      v.ok("the click point is inside ANOTHER pane of the float, not the list", paneSpot.inPane === true && paneSpot.inPop === false, JSON.stringify(paneSpot));
      await clickPoint(paneSpot);
      await page.waitForFunction(() => document.getElementById("as-search-pop").hidden, null, { timeout: 5000 });
      const paneSwitch = await state();
      v.ok("another pane of the panel counts as outside: the click on Settings closes the list", paneSwitch.popHidden === true && paneSwitch.count.hidden === true, JSON.stringify({ hidden: paneSwitch.popHidden, count: paneSwitch.count }));
      v.ok("and it leaves the filter in the box", paneSwitch.input === HARBOR_FILTER, JSON.stringify({ input: paneSwitch.input }));
      record.steps.push({ click: "settings pane", x: paneSpot.x, y: paneSpot.y, hidden: paneSwitch.popHidden, input: paneSwitch.input });
      v.ok("the list is drawn over the Settings pane before the click", inSettings.popHidden === false && inSettings.count.text === "1 of 4", JSON.stringify({ hidden: inSettings.popHidden, text: inSettings.count.text }));
      await page.click('[data-as-subtab="chat"]');
      await page.waitForSelector("#as-chat [data-turn]", { timeout: 10000 });

      await page.keyboard.press("Control+q");
      await page.keyboard.type(HARBOR_FILTER);
      await waitCount("1 of 4", HARBOR_FILTER);
      await page.keyboard.press("Escape");
      const escaped = await state();
      v.ok(
        "Escape keeps its behaviour: the filter goes, the list goes, the caret stays in the box",
        escaped.input === "" && escaped.count.hidden === true && escaped.popHidden === true && escaped.focused === "as-search-q",
        JSON.stringify({ input: escaped.input, count: escaped.count.text, hidden: escaped.popHidden, focused: escaped.focused }),
      );
      v.ok("Escape leaves no mark behind", escaped.marks === 0 && escaped.rings === 0, JSON.stringify({ marks: escaped.marks, rings: escaped.rings }));

      // ---- no page error came from any of it -----------------------------------------------------------------------
      v.ok("no page error was raised by the run", errors.length === 0, errors.slice(0, 3).join(" | "));
      return { newest, second, oldest, one, closed, back, dragged, selected, paneSwitch, escaped };
    },
    { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  );
  if (!browserHalf) fail("the browser half returned nothing");
  console.log(`screenshots: ${record.screenshots.length} in ${outDir}`);
} finally {
  await panel.stop();
  writeFileSync(path.join(outDir, "assistant-search-order.json"), JSON.stringify(record, null, 2), "utf8");
}

// The row texts are the fixture's own sentences, so "in this order" is a readable assertion rather than an index
// arithmetic: the newest row must come first and the oldest last.
function assertOrder(name, texts, needles) {
  const ok = needles.length === texts.length && needles.every((needle, i) => String(texts[i] || "").includes(needle));
  v.ok(`${name}`, ok, JSON.stringify(texts));
}

console.log(`\n${v.checks - v.failures}/${v.checks} checks passed`);
if (v.failures) process.exit(1);
console.log(`assistant-search-order: OK (screenshots in ${outDir}, sandbox ${keep ? dir : "removed"})`);
