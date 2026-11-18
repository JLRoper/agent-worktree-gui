// The Hot Agent search, driven by the KEYBOARD ALONE, in headless Chromium at 1440x900.
//
// WHAT IT PROVES, in the order a reader meets it:
//
//   0. BINDING. `a` opens the panel, then Ctrl+Shift+Q opens the Hot Agent list and the caret is in ITS box - not in
//      the assistant search's, which is what Ctrl+Q without Shift owns. One press, one bar.
//   1. THE LIST IS THE MOST RECENT TURNS. Nothing typed, and the list holds the newest 20 of 26 eligible turns: the
//      count reads "20 turns" and the footer says how many the store holds, so the cap is stated rather than hidden.
//   2. IT IS ONLY THE READER WRITING TO WORKERS. The store also holds two manager turns, two the manager spawned, two
//      wakes it sent, one reply the reader typed on the MANAGER's card and one agent reply whose text matches. None of
//      their threads is in the list; the fixture's own thread ids are asserted absent, not merely "fewer rows".
//   3. A FILTER NARROWS IT, server-side. Typing `saffron` answers "1 of 8" from the route, and the eight rows are the
//      eight reader turns that carry the word.
//   4. DOWN PAST THE FOLD. With twenty rows the list has a fold; fourteen presses walk to row 15 and that row is
//      inside the popover's band at every step, with the list's own scroller moved and the page left at scroll 0.
//   5. ENTER LANDS ON THE TURN. The popover closes, the turn's own card holds the ring (`.ha-hit`), the card wears the
//      board's flash, and the turn is on screen.
//   6. ESCAPE CLOSES AND CLEARS, and hands focus to the header button, so the next press is one keystroke away.
//
// HOW TO RUN:  node tools/verify-hot-agent-search.mjs
//              node tools/verify-hot-agent-search.mjs --out <dir>   (defaults to docs/assets/hot-agent-search)
//              node tools/verify-hot-agent-search.mjs --keep         (leave the sandbox store behind)
//
// It boots THIS checkout's server.js on a free port with its own state directory and a SYNTHESIZED store in the
// shape the live `logs/jobs.json` uses (`tree.path`, `projectPath`, `origin.kind`, `assistant`, `reply`), so the
// eligibility rules are exercised against the fields the store actually writes. No live panel is touched, and every
// action under test is a key press: nothing here clicks a locator, focuses an element or calls a page function.
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, configureRepo, createVerifier, git, ran, startPanel } from "./panel-testkit.mjs";
import { loadPlaywright, withBrowser } from "./browser.mjs";

const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const keep = argv.includes("--keep");
const outDir = argOf("out", path.join(ROOT, "docs", "assets", "hot-agent-search"));
const dir = argOf("dir", path.join(os.tmpdir(), "wag-hot-agent-search-sandbox"));
mkdirSync(outDir, { recursive: true });
mkdirSync(dir, { recursive: true });
const shot = (name) => path.join(outDir, (name.endsWith(".png") ? name.slice(0, -4) : name) + "-1440x900.png");

const FILTER = "saffron";
const MANAGER_THREAD = "panel-assistant";
// 26 worker turns plus ONE whose AGENT REPLY carries the word: the reply is never indexed, so that turn is eligible
// on its prompt ("unrelated worker instruction") and can never answer the filter. So the store holds 27 rows and the
// filter answers 8.
const WORKER_TURNS = 26; // reader turns to worker agents, one per task
const ELIGIBLE = WORKER_TURNS + 1; // ...plus the reply-only turn, which is eligible on its prompt
const MATCHING = 8; // ...of which eight carry the filter word
const WINDOW = 20; // the shared default in public/core/hot-agent-list.js

// ---- the two project trees, real git repos so the board can draw a card in each ------------------------------
const repos = path.join(dir, "repos");
mkdirSync(repos, { recursive: true });
const repoOf = (name) => path.join(repos, name);
for (const name of ["project-alpha", "project-beta"]) {
  const repo = repoOf(name);
  mkdirSync(repo, { recursive: true });
  if (!ran(repo, "rev-parse", "--git-dir")) {
    git(repo, "init", "-q", "-b", "main");
    configureRepo(repo, { name: "Hot Agent Verify" });
    writeFileSync(path.join(repo, "README.md"), `# ${name}\n`, "utf8");
    git(repo, "add", "README.md");
    git(repo, "commit", "-q", "-m", `the ${name} fixture`);
  }
}

// ---- the store, in the live shape ----------------------------------------------------------------------------
// startedAt rises with the index so the newest turn is the last one written: the list must open on `hot-26`, not on
// whatever order the array happens to have.
const at = (minutes) => new Date(Date.UTC(2026, 10, 18, 6, minutes, 0)).toISOString();
const prompt = (n) => {
  const n2 = String(n).padStart(2, "0");
  const word = n % 3 === 0 ? `${FILTER} ` : "";
  return `hot agent task ${n2}: ${word}read public/app.js and the job store, then say what moved since the last turn`;
};
const treeOf = (name) => ({ path: repoOf(name), branch: "main", exists: true, pending: false });
const readerTurns = Array.from({ length: WORKER_TURNS }, (_, i) => {
  const n = i + 1;
  const project = n % 2 === 0 ? "project-beta" : "project-alpha";
  return {
    id: `hot-${n}`,
    // Half the jobs carry a session TITLE, like a real panel: the row names the agent by its title and the thread on
    // its own line. The other half have none, where the thread id IS the name and printing it twice would waste the row.
    title: n % 2 === 0 ? `audit pass ${n}` : "",
    thread: `wtgui-hot-agent-${String(n).padStart(2, "0")}`,
    turn: 1,
    status: "done",
    startedAt: at(n),
    endedAt: at(n + 1),
    prompt: prompt(n),
    finalMessage: `the agent's own reply to task ${n}`,
    projectPath: repoOf(project),
    ownerPath: repoOf(project),
    tree: treeOf(project),
    branch: "main",
    assistant: false,
    reply: false,
    origin: null,
    lines: [],
  };
});
// Eight of the twenty-six carry the filter: every third task, so the answering rows are spread across both trees.
const matchingTurns = readerTurns.filter((j) => j.prompt.includes(FILTER));
// The five shapes that must NEVER be a row, each carrying the filter in its prompt so a leak would be visible.
const refused = [
  { kind: "manager-turn", job: { assistant: true, thread: MANAGER_THREAD } },
  { kind: "manager-spawn", job: { origin: { kind: "assistant-spawn", project: "project-alpha" } } },
  { kind: "manager-wake", job: { origin: { kind: "assistant-wake", reason: "[queue]" } } },
  { kind: "manager-card-reply", job: { thread: MANAGER_THREAD, reply: true } },
];
const refusedJobs = refused.map((entry, i) => {
  const n = ELIGIBLE + i + 1;
  return {
    id: `refused-${n}`,
    thread: entry.job.thread || `wtgui-manager-${String(n)}`,
    turn: 1,
    status: "done",
    startedAt: at(n),
    prompt: `${FILTER} ${entry.kind}: this must never be a Hot Agent row`,
    projectPath: repoOf("project-alpha"),
    tree: treeOf("project-alpha"),
    assistant: entry.job.assistant || false,
    reply: entry.job.reply || false,
    origin: entry.job.origin || null,
    lines: [],
  };
});
// An agent's REPLY carries the word and its prompt does not: the reply is not searchable, so this must not appear
// even though "saffron is done" is the text a reader might paste.
const replyOnly = {
  id: "reply-only",
  thread: "wtgui-reply-only",
  turn: 1,
  status: "done",
  startedAt: at(0),
  prompt: "unrelated worker instruction",
  finalMessage: `${FILTER} is done`,
  projectPath: repoOf("project-beta"),
  tree: treeOf("project-beta"),
  assistant: false,
  reply: false,
  origin: null,
  lines: [],
};
const JOBS = [...readerTurns, ...refusedJobs, replyOnly];
// The panel keeps a thread's renamed label beside the store; a labelled thread names its AGENT, and the row then
// carries the thread on its own line. Without this every row would show the thread id twice.
const labelsFile = Object.fromEntries(readerTurns.filter((j) => j.title).map((j) => [j.thread, `audit pass ${j.id.split("-")[1]}`]));
const jobsFile = { version: 3, savedAt: new Date().toISOString(), jobs: JOBS };
const assistantsFile = { version: 2, assistants: [{ id: "assistant-1", name: "Assistant #1", threadId: MANAGER_THREAD }] };
mkdirSync(path.join(dir, "logs"), { recursive: true });
// Written every run, never merged: the sandbox exists to hold exactly this fixture.
writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify(jobsFile, null, 1), "utf8");
writeFileSync(path.join(dir, "logs", "labels.json"), JSON.stringify(labelsFile), "utf8");
writeFileSync(path.join(dir, "logs", "assistants.json"), JSON.stringify(assistantsFile, null, 1), "utf8");
console.log(`store: ${ELIGIBLE} reader turns to workers, ${MATCHING} of them matching "${FILTER}", ${refusedJobs.length + 1} manager/agent turns that must never be rows`);

// ---- the browser ---------------------------------------------------------------------------------------------
const pw = loadPlaywright();
if (!pw) {
  console.log("BROWSER-HALF-NOT-RUN: no playwright on this machine, so nothing was checked in a page");
  process.exit(2);
}

const panel = await startPanel({ root: ROOT, dir, keep });
const v = createVerifier();
const record = { viewport: "1440x900", filter: FILTER, steps: [], screenshots: [] };
const refusedThreads = [...new Set(refusedJobs.map((j) => j.thread))];
try {
  await withBrowser(
    async ({ page }) => {
      const errors = [];
      page.on("pageerror", (err) => errors.push(String(err?.message || err)));
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
      });
      const shoot = async (name) => {
        const p = shot(name);
        await page.screenshot({ path: p });
        record.screenshots.push(path.basename(p));
        return p;
      };
      // One read of the bar: the popover, its band, the current row, the count, the footer and the reader's focus.
      const look = () =>
        page.evaluate(() => {
          const pop = document.getElementById("ha-search-pop");
          const list = document.getElementById("ha-search-list");
          const input = document.getElementById("ha-search-q");
          const open = document.getElementById("ha-search-open");
          const n = document.getElementById("ha-search-n");
          const foot = document.getElementById("ha-search-more");
          const rows = [...(list?.querySelectorAll("[data-search-hit]") || [])];
          const row = rows.find((r) => r.classList.contains("is-current")) || null;
          const rr = row ? row.getBoundingClientRect() : null;
          const lr = list ? list.getBoundingClientRect() : null;
          return {
            visible: Boolean(pop && !pop.hidden && pop.getBoundingClientRect().height > 0),
            rows: rows.length,
            threads: rows.map((r) => r.dataset.thread),
            trees: [...new Set(rows.map((r) => r.dataset.tree))],
            agents: rows.map((r) => r.querySelector(".as-search-where")?.textContent.trim() || ""),
            firstThread: rows[0]?.dataset.thread || null,
            count: n ? n.textContent.trim() : "",
            foot: foot ? foot.textContent.trim() : "",
            capped: Boolean(foot && foot.classList.contains("is-capped")),
            row: row ? Number(row.dataset.searchHit) : null,
            rowTop: rr ? Math.round(rr.top) : null,
            rowBottom: rr ? Math.round(rr.bottom) : null,
            bandTop: lr ? Math.round(lr.top) : null,
            bandBottom: lr ? Math.round(lr.bottom) : null,
            inBand: Boolean(rr && lr) && rr.top >= lr.top - 0.5 && rr.bottom <= lr.bottom + 0.5,
            scrollTop: list ? Math.round(list.scrollTop) : 0,
            scrollable: Boolean(list) && list.scrollHeight > list.clientHeight + 1,
            focusHot: document.activeElement === input,
            focusAssistant: document.activeElement === document.getElementById("as-search-q"),
            focusButton: document.activeElement === open,
            expanded: open ? open.getAttribute("aria-expanded") : null,
            inputValue: input ? String(input.value || "") : "",
            pageY: window.scrollY,
            docTop: document.scrollingElement ? Math.round(document.scrollingElement.scrollTop) : 0,
          };
        });
      // The landing scroll is SMOOTH, so "is the turn on screen" has to be asked once the page has stopped moving:
      // this resolves after three animation frames in which scrollY did not change.
      const settle = () =>
        page.evaluate(
          () =>
            new Promise((resolve) => {
              let last = -1;
              let calm = 0;
              const tick = () => {
                const y = Math.round(window.scrollY);
                calm = y === last ? calm + 1 : 0;
                last = y;
                if (calm >= 3) resolve(y);
                else requestAnimationFrame(tick);
              };
              requestAnimationFrame(tick);
            }),
        );
      const waitCount = (text) =>
        page.waitForFunction(
          (want) => {
            const n = document.getElementById("ha-search-n");
            return Boolean(n && !n.hidden && n.textContent.trim() === want);
          },
          text,
          { timeout: 15000 },
        );

      await page.goto(panel.base, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#btn-assistant", { timeout: 45000 });
      // A bare `a` is the documented way into the panel: everything below is keys.
      await page.keyboard.press("a");
      await page.waitForSelector("#assistant:not([hidden])", { timeout: 20000 });

      // ---- 0. the chord, into ITS box --------------------------------------------------------------------------
      await page.keyboard.press("Control+Shift+q");
      await page.waitForSelector("#ha-search-pop:not([hidden])", { timeout: 20000 });
      await waitCount(`${WINDOW} turns`);
      const opened = await look();
      v.ok("Ctrl+Shift+Q opens the Hot Agent list", opened.visible === true, JSON.stringify({ visible: opened.visible }));
      v.ok("the caret is in the Hot Agent box, not the assistant search's", opened.focusHot === true && opened.focusAssistant === false, `hot ${opened.focusHot}, turn search ${opened.focusAssistant}`);
      v.ok("the header button says it is expanded", opened.expanded === "true", String(opened.expanded));
      record.steps.push({ step: "open", ...opened });

      // ---- 1. the newest 20, and the cap stated ---------------------------------------------------------------
      const api = await (await fetch(`${panel.base}/api/hot-agent/search`)).json();
      v.ok("the store holds every eligible turn and lists the newest 20", api.matched === ELIGIBLE && api.displayed === WINDOW, `${api.matched} matched, ${api.displayed} displayed`);
      v.ok("the list drew exactly the window", opened.rows === WINDOW, `${opened.rows} rows`);
      v.ok("the count reads as a size, not a division of a filter", opened.count === `${WINDOW} turns`, opened.count);
      v.ok("the footer says how many the store holds", opened.foot.includes(`${WINDOW} of ${ELIGIBLE} turns`) && opened.foot.includes("newest first"), opened.foot);
      v.ok("the cap is flagged amber, because more matched than are shown", opened.capped === true, `capped ${opened.capped}`);
      v.ok("the newest turn is the first row", opened.firstThread === `wtgui-hot-agent-${String(WORKER_TURNS).padStart(2, "0")}`, String(opened.firstThread));
      // Every row names its agent, its thread and its tree: the agent in the first line, the thread id as that line
      // or the thread chip, the tree as the leaf that holds it. Icons alone would be a shape nobody can read out.
      const rowText = await page.evaluate(() => [...document.querySelectorAll("#ha-search-list .as-search-row")].map((r) => r.textContent.replace(/\s+/g, " ")));
      v.ok("each row names the agent, its thread and its tree", opened.agents.every((a) => a.length > 0) && opened.threads.every((thread, i) => rowText[i].includes(thread)) && opened.trees.length === 2, `${rowText.length} rows checked, trees ${opened.trees.join(", ")}`);
      v.ok("a row names its thread exactly once, whether as the name or the chip", rowText.every((text, i) => text.split(opened.threads[i]).length - 1 === 1), rowText[0].slice(0, 80));
      v.ok("a titled agent's row puts the thread on its own line", rowText.some((text) => text.includes("thread wtgui-hot-agent-")), rowText.find((text) => text.includes("thread "))?.slice(0, 60) || "none");
      await shoot("01-open-20-turns");

      // ---- 2. never a manager turn, never an agent reply --------------------------------------------------------
      v.ok("no manager turn, spawn, wake or manager-card reply is a row", refusedThreads.every((thread) => !opened.threads.includes(thread)), `${opened.threads.length} rows, refused threads absent`);
      // The agent's own reply is not indexed: that turn is in the store, its prompt is unrelated, and the word is in
      // its finalMessage. A reply leaked into the search would put "saffron is done" in a row's excerpt.


      // ---- 3. a typed filter narrows it, server-side -----------------------------------------------------------
      await page.keyboard.type(FILTER);
      await waitCount(`1 of ${MATCHING}`);
      const filtered = await look();
      const apiFiltered = await (await fetch(`${panel.base}/api/hot-agent/search?q=${FILTER}`)).json();
      v.ok("the typed filter answers the route's own count", apiFiltered.matched === MATCHING && filtered.count === `1 of ${MATCHING}`, `${apiFiltered.matched} matched, count ${filtered.count}`);
      v.ok("the agent's reply is not searchable", !filtered.agents.some((agent) => agent.includes("reply-only")), filtered.agents.join(", "));
      v.ok("the list holds exactly the matching turns", filtered.rows === MATCHING, `${filtered.rows} rows`);
      v.ok("the filter's footer says matched and displayed", filtered.foot.includes(`${MATCHING} turns matched`) && filtered.foot.includes(`${MATCHING} displayed`), filtered.foot);
      v.ok("a filter that fits is not flagged as capped", filtered.capped === false, `capped ${filtered.capped}`);
      v.ok("the first row is current and inside the list", filtered.row === 0 && filtered.inBand === true, `row ${filtered.row}, in band ${filtered.inBand}`);
      record.steps.push({ step: "filter", ...filtered });
      await shoot("02-filter-saffron");

      // ---- 4. Down, past the fold ------------------------------------------------------------------------------
      // Clear the filter from the keyboard: select all and delete. The box keeps what it searched on a reopen (a
      // filter the reader did not clear is theirs), so emptying it is a real keystroke, not a side effect of focus.
      await page.keyboard.press("Control+a");
      await page.keyboard.press("Backspace");
      await waitCount(`${WINDOW} turns`);
      const top = await look();
      v.ok("emptying the box brings the newest twenty back", top.rows === WINDOW && top.inputValue === "", `${top.rows} rows, box ${JSON.stringify(top.inputValue)}`);
      v.ok("twenty rows have a fold", top.scrollable === true, `scrollTop ${top.scrollTop} of ${top.scrollable ? "a scrolling list" : "a list that fits"}`);
      let walked = top;
      for (let i = 2; i <= 15; i += 1) {
        await page.keyboard.press("ArrowDown");
        await waitCount(`${i} of ${WINDOW}`);
        walked = await look();
        v.ok(`${i} of ${WINDOW}: the current row is inside the list's band`, walked.inBand === true && walked.row === i - 1, `row ${walked.row}, ${walked.rowTop}..${walked.rowBottom} in ${walked.bandTop}..${walked.bandBottom}`);
        v.ok(`${i} of ${WINDOW}: the page did not scroll`, walked.pageY === 0 && walked.docTop === 0, `scrollY ${walked.pageY}, doc ${walked.docTop}`);
        v.ok(`${i} of ${WINDOW}: the caret stayed in the box`, walked.focusHot === true, `focus ${walked.focusHot}`);
      }
      v.ok("walking past the fold moved the list itself", walked.scrollTop > top.scrollTop, `${top.scrollTop} -> ${walked.scrollTop}`);
      record.steps.push({ step: "down-15", ...walked });
      await shoot("03-down-past-the-fold");

      // ---- 5. Enter lands on the turn --------------------------------------------------------------------------
      const target = walked.threads[walked.row];
      await page.evaluate(() => {
        globalThis.__t0 = Date.now();
      });
      await page.keyboard.press("Enter");
      // The ring is drawn by the same render pass that draws the card, so this waits for it rather than sleeping:
      // `waitForSelector` defaults to state "visible", which a HIDDEN popover can never satisfy, so the close is
      // asserted from the read below instead of waited on.
      await page.waitForFunction(
        (thread) => Boolean(document.querySelector(`.job[data-thread="${CSS.escape(thread)}"] .turn.ha-hit`)),
        target,
        { timeout: 10000 },
      );
      const landedY = await settle();

      const landed = await page.evaluate((thread) => {
        const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
        const turn = card?.querySelector(".turn.ha-hit") || null;
        const tr = turn ? turn.getBoundingClientRect() : null;
        return {
          card: Boolean(card),
          ring: Boolean(turn),
          ringTurn: turn?.dataset.turn || null,
          flipped: Boolean(card && card.classList.contains("hot-flash")),
          onScreen: Boolean(tr && tr.top < window.innerHeight && tr.bottom > 0),
          rect: tr ? { top: Math.round(tr.top), bottom: Math.round(tr.bottom), h: Math.round(tr.height), wh: window.innerHeight } : null,
          cardRect: (() => { const c = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`); const r = c ? c.getBoundingClientRect() : null; return r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) } : null; })(),
          elapsed: Date.now() - (globalThis.__t0 || Date.now()),
          flash: (() => { try { return JSON.stringify(state.hotFlash); } catch { return "?"; } })(),
          popHidden: document.getElementById("ha-search-pop").hidden,
          expanded: document.getElementById("ha-search-open").getAttribute("aria-expanded"),
          focusButton: document.activeElement === document.getElementById("ha-search-open"),
        };
      }, target);
      v.ok("Enter closes the list", landed.popHidden === true, `hidden ${landed.popHidden}`);
      v.ok("the header button collapses with it", landed.expanded === "false", String(landed.expanded));
      v.ok("the turn's own card is on the board", landed.card === true, `thread ${target}`);
      v.ok("the turn itself wears the ring", landed.ring === true && landed.ringTurn === target.replace("wtgui-hot-agent-", "hot-"), JSON.stringify({ ring: landed.ring, turn: landed.ringTurn }));
      v.ok("the card wears the board's own flash", landed.flipped === true, `hot-flash ${landed.flipped}`);
      v.ok("the turn is on screen", landed.onScreen === true, JSON.stringify({ turn: landed.rect, card: landed.cardRect }));
      v.ok("focus is back on the button, so the next press is one keystroke away", landed.focusButton === true, `focus button ${landed.focusButton}`);
      record.steps.push({ step: "enter", target, ...landed });
      await shoot("04-enter-on-the-turn");

      // The board repaints on every poll (cheap fields, run state, a new line), and a repaint rebuilds the cards. If
      // the landing only held until the next paint, the reader would be back at the top of the page two seconds after
      // pressing Enter - so this watches the turn for three seconds and fails on the first sample that is off screen.
      const trace = await page.evaluate(
        ({ thread, turnId }) =>
          new Promise((resolve) => {
            const series = [];
            const read = () => {
              const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
              const turn = card?.querySelector(`.turn[data-turn="${CSS.escape(turnId)}"]`) || null;
              const r = turn ? turn.getBoundingClientRect() : null;
              series.push({ t: series.length * 100, y: Math.round(window.scrollY), on: Boolean(r && r.top > 0 && r.bottom < window.innerHeight) });
            };
            read();
            const timer = setInterval(() => {
              read();
              if (series.length >= 31) {
                clearInterval(timer);
                resolve(series);
              }
            }, 100);
          }),
        { thread: target, turnId: landed.ringTurn },
      );
      // The page's own Y is allowed to change while the board settles (a repaint can fold other cards and shorten the
      // page); what may not change is whether the ringed turn is on screen. The settled Y is what Escape must respect.
      const left = trace.filter((s) => !s.on);
      const settledY = trace[trace.length - 1].y;
      v.ok("the landing survives three seconds of board paints", left.length === 0, left.length ? `${left.length} of ${trace.length} samples off screen: ${JSON.stringify(left.slice(0, 3))}` : `${trace.length} samples, the turn on screen in every one`);

      // ---- 6. Escape closes, clears, and hands the keyboard back -----------------------------------------------
      await page.keyboard.press("Control+Shift+q");
      await page.waitForSelector("#ha-search-pop:not([hidden])", { timeout: 15000 });
      await waitCount(`${WINDOW} turns`);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.getElementById("ha-search-pop").hidden, null, { timeout: 10000 });
      const closed = await look();
      v.ok("Escape closes the list", closed.visible === false, `visible ${closed.visible}`);
      v.ok("Escape clears the filter, so the next open is the newest turns", closed.inputValue === "", JSON.stringify(closed.inputValue));
      v.ok("Escape puts focus on the button that opened it", closed.focusButton === true, `focus button ${closed.focusButton}`);
      v.ok("the page is still where the landing left it", Math.abs(closed.pageY - settledY) <= 2, `settled at ${settledY}, now ${closed.pageY}`);
      record.steps.push({ step: "escape", ...closed });
      await shoot("05-escape-closed");

      v.ok("no page error was raised", errors.length === 0, errors.slice(0, 3).join(" | "));
    },
    { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  );
} finally {
  await panel.stop();
}

writeFileSync(path.join(outDir, "run.json"), JSON.stringify(record, null, 1), "utf8");
console.log(`${v.checks - v.failures}/${v.checks} checks passed  (${record.screenshots.length} screenshots in ${outDir})`);
process.exit(v.failures === 0 ? 0 : 1);
