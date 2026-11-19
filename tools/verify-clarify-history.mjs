// The header's Clarify button and its history popup, proved headless at 1440x900 and at 768 wide.
// HARNESS: LIVE GATE. `npm run verify:clarify-history`.
//
//   node tools/verify-clarify-history.mjs                # this checkout
//   node tools/verify-clarify-history.mjs --keep         # leave the sandbox on disk
//   node tools/verify-clarify-history.mjs --out <dir>    # where the screenshots go
//
// THE BRIEF, and the section that proves each line:
//
//   1. THE FOUR CONTROLS, in order and in colour. Assistant search, the Hot Agent pen, Clarify, Human: the purple
//      button is the fourth control, sitting between the pen and Human, and its colour is the header's violet rather
//      than Human's grey. The three controls it sits between are unchanged (the pen still has its glyph and its own
//      keys, Human still reads "Human").
//   2. THE ROWS, by state. The store is seeded newest first with an unanswered question, an answered one and a
//      CANCELED one. The unanswered row is in full colour, carries its marker and both choices, and names the agent,
//      the tree and the assistant. The answered row is greyed, the answer the reader chose is its loudest element and
//      the question sits muted behind it. The cancelled row says "cancelled after 16m" and is NOT greyed as answered.
//   3. THE HONEST CAP. Sixty rows in the store: fifty are drawn and the footer says "showing 50 of 60" (the unit test
//      covers 137, the store keeps 400).
//   4. LANDING ON THE ASKING TURN. The unanswered row belongs to the OLDEST of eight turns, so clicking it has to page
//      the card back to that turn: the project opens, the row unfolds, the turn is unfolded and on screen, its question
//      box is centred and ringed purple, its first choice takes the caret, and the AGENT'S ROW wears the purple row
//      flash (the worktree link's own animation, in the header's colour). The answered row, on a turn that is NOT the
//      current one, opens that turn too rather than only the agent.
//   5. THE SIZE IS REMEMBERED. The panel resizes from its corner handle, and the size is written to localStorage
//      `wtgui.clarify.rect`; Escape closes it and hands the caret back; reopening restores that size.
//   6. KEYBOARD. Enter on the button opens it, ArrowDown steps one row per press, ArrowUp steps back, Enter opens the
//      row under the caret, Escape closes.
//   7. NO CLIPPING AT 768. At 768x900 the panel is inside the viewport on all four edges, the page has no horizontal
//      scroll, and the list does not overflow sideways.
//   8. A RESTART DOES NOT EMPTY IT. The panel is stopped and booted again on the same state folder; the route still
//      answers 60 rows and the answered one keeps its answer, because the list reads the stored record and never
//      re-derives it from the live prompts.
//
// WHAT IS REAL HERE. The server is this checkout's server.js on its own port and its own state folder; the page is the
// one it serves; the store is the same `clarify-history.json` the panel writes in life, read through
// /api/clarify/history. Nothing fabricates page state: the clicks, the drag, the keys and the localStorage reads are
// the page's own.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { ROOT, freePort, startPanel, waitForState } from "./panel-testkit.mjs";
import { loadPlaywright, withBrowser } from "./browser.mjs";

const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const keep = argv.includes("--keep");
const outDir = argOf("out", path.join(ROOT, "docs", "assets", "clarify-history"));
const dir = argOf("dir", path.join(os.tmpdir(), "wag-clarify-history-sandbox"));
mkdirSync(outDir, { recursive: true });
// A clean fixture every run: the worktree add and the store seed both assume an empty folder.
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

let checks = 0;
let failures = 0;
const ok = (label, cond, detail = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${label}${detail ? `: ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
};
const is = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}${JSON.stringify(got) === JSON.stringify(want) ? "" : ` want ${JSON.stringify(want)}`}`);
const note = (t) => console.log(`      ${t}`);
const section = (t) => console.log(`\n-- ${t}`);
const shot = (name) => path.join(outDir, name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the fixture: one project, one worktree, eight turns ---------------------------------------------------------
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=Gate", "-c", "user.email=gate@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
  });
const repos = path.join(dir, "repos");
const project = path.join(repos, "demo");
const worktree = path.join(project, ".worktrees", "wt-clarify");
mkdirSync(repos, { recursive: true });
mkdirSync(project, { recursive: true });
git(project, "init", "-q", "-b", "main");
writeFileSync(path.join(project, "README.md"), "the gate's project\n", "utf8");
git(project, "add", "-A");
git(project, "commit", "-q", "-m", "fixture: one commit");
git(project, "worktree", "add", "-q", "-b", "wt/clarify", worktree);

const now = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();
const THREAD = "wt-agent-thread";
const TREE = "wt-clarify";
const turns = [];
for (let i = 1; i <= 8; i += 1) {
  // t1 is the OLDEST turn (two hours ago) and the one an unanswered question belongs to, so a landing on it has to page
  // a card that opens on its newest page back to an older one. t8 is the current turn.
  const at = now - (9 - i) * 15 * MIN;
  const t = {
    id: `t${i}`,
    thread: THREAD,
    turn: i,
    origin: "worker",
    status: "done",
    startedAt: iso(at),
    endedAt: iso(at + 4 * MIN),
    lastActiveAt: iso(at + 4 * MIN),
    prompt: `turn ${i}: work in the tree`,
    finalMessage: `turn ${i} finished`,
    cwd: worktree,
    ownerPath: worktree,
    worktreePath: worktree,
    worktree: TREE,
    branch: "wt/clarify",
    title: "the clarify gate's agent",
    lines: [],
  };
  if (i === 1) {
    // t1 is PARKED: the unanswered history row has to open the box that is still on the card, not a turn that merely
    // remembers having asked. A restart reconciler keeps this one open because the prompt is still on the job.
    t.status = "running";
    t.runId = "run-gate";
    t.endedAt = null;
    t.lastActiveAt = iso(now - 5 * MIN);
    t.question = {
      key: `clarify:t1:p1`,
      requestId: "p1",
      question: "Land it on the turn that asked, or only on the agent?",
      choices: ["the turn that asked", "only the agent"],
      links: [],
      multiSelect: false,
      base: "",
      timeoutSeconds: 3600,
      deadline: now + 50 * MIN,
      at: iso(now - 20 * MIN),
      reasks: 0,
      lastAskedAt: null,
    };
  }
  turns.push(t);
}
const jobsStore = { version: 3, savedAt: iso(now), jobs: turns };

// The history: an unanswered pair, an answered row and a cancelled row in the first three places, then 57 older rows
// so the 50-row cap has something honest to say. `seq` is the order the page draws, newest first.
const entry = (n, over) => ({
  seq: 60 - n,
  key: `clarify:seed:${n}`,
  requestId: `seed-${n}`,
  jobId: "t1",
  thread: THREAD,
  agent: "the clarify gate's agent",
  tree: TREE,
  treePath: worktree.replace(/\\/g, "/"),
  project: "demo",
  assistantId: "assistant-1",
  assistantName: "Assistant #1",
  question: `seeded question ${n}?`,
  choices: ["yes", "no"],
  multiSelect: false,
  links: [],
  base: "",
  askedAt: iso(now - 2 * HOUR - n * MIN),
  deadline: null,
  timeoutSeconds: null,
  reasks: 0,
  status: "answered",
  answer: "yes",
  answeredBy: "reader",
  answeredAt: iso(now - 2 * HOUR - n * MIN + 3 * MIN),
  closedWhy: "",
  closedAt: iso(now - 2 * HOUR - n * MIN + 3 * MIN),
  ...over,
});
const history = {
  version: 1,
  // Highest first: seq 60 is the newest row, so the three rows the gate reads are the first three drawn.
  seq: 60,
  entries: [
    entry(1, {
      seq: 60,
      key: "clarify:t1:p1",
      requestId: "p1",
      jobId: "t1",
      question: "Land it on the turn that asked, or only on the agent?",
      choices: ["the turn that asked", "only the agent"],
      askedAt: iso(now - 20 * MIN),
      deadline: now + 50 * MIN,
      timeoutSeconds: 3600,
      status: "open",
      answer: "",
      answeredBy: "",
      answeredAt: null,
      closedWhy: "",
      closedAt: null,
    }),
    entry(2, {
      seq: 59,
      key: "clarify:t6:p2",
      requestId: "p2",
      jobId: "t6",
      question: "Which side of the merge goes first?",
      choices: ["the tree", "main"],
      askedAt: iso(now - 40 * MIN),
      status: "answered",
      answer: "the tree, then main",
      answeredBy: "reader",
      answeredAt: iso(now - 39 * MIN),
      closedWhy: "",
      closedAt: iso(now - 39 * MIN),
    }),
    entry(3, {
      seq: 58,
      key: "clarify:t3:p3",
      requestId: "p3",
      jobId: "t3",
      question: "Should this turn keep waiting on the reader?",
      choices: ["wait", "stop"],
      askedAt: iso(now - 60 * MIN),
      status: "closed",
      answer: "",
      answeredBy: "",
      answeredAt: null,
      closedWhy: "cancelled",
      closedAt: iso(now - 60 * MIN + 16 * MIN),
    }),
    ...Array.from({ length: 57 }, (_, i) => entry(i + 4, { seq: 57 - i, askedAt: iso(now - 3 * HOUR - i * 7 * MIN) })),
  ],
};
const logs = path.join(dir, "logs");
mkdirSync(logs, { recursive: true });
writeFileSync(path.join(logs, "jobs.json"), JSON.stringify(jobsStore, null, 1), "utf8");
writeFileSync(path.join(logs, "clarify-history.json"), JSON.stringify(history, null, 1), "utf8");
writeFileSync(path.join(logs, "assistants.json"), JSON.stringify({ version: 1, assistants: [{ id: "assistant-1", name: "Assistant #1", threadId: "panel-assistant", rules: [] }] }, null, 1), "utf8");
note(`fixture: ${turns.length} turns on ${TREE}, ${history.entries.length} history rows (open, answered, cancelled, then 57 older)`);

const pw = loadPlaywright();
if (!pw) {
  console.log("BROWSER-HALF-NOT-RUN: no playwright on this machine, so nothing was checked in a page");
  process.exit(2);
}

// A stub Runs API holding ONE parked run. The panel re-attaches to it after the boot reconcile, which keeps t1 live
// (an interrupted card draws no question box, so an unanswered row would land on nothing to answer), and the SSE hold
// keeps the re-attach from settling the run on its own.
const stubPort = await freePort();
const stub = createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname.endsWith("/events")) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": attached\n\n");
    const hold = setInterval(() => {
      try {
        res.write(": hold\n\n");
      } catch {
        clearInterval(hold);
      }
    }, 1000);
    req.on("close", () => clearInterval(hold));
    return;
  }
  const m = /^\/v1\/runs\/([^/]+)/.exec(url.pathname);
  if (m && decodeURIComponent(m[1]) === "run-gate") {
    return json(200, {
      run_id: "run-gate",
      status: "running",
      pending_controls: [{ kind: "clarify", prompt_id: "p1", question: "Land it on the turn that asked, or only on the agent?" }],
    });
  }
  return json(404, { error: { message: "no such run" } });
});
await new Promise((r) => stub.listen(stubPort, "127.0.0.1", r));
const API = { url: `http://127.0.0.1:${stubPort}`, key: "gate-key" };

let panel = await startPanel({ dir, keep: true, config: { apiServer: API } });
try {
  await waitForState(
    panel.base,
    (s) =>
      (s.projects || []).some((p) =>
        (p.worktrees || []).some((w) => String(w.path || "").replace(/\\/g, "/").toLowerCase().endsWith("/wt-clarify")),
      ),
    "the fixture worktree row",
    { timeout: 40_000 },
  );
  const before = await (await fetch(`${panel.base}/api/clarify/history`)).json();
  is("the route answers the seeded history, newest first", before.entries.slice(0, 3).map((e) => e.status), ["open", "answered", "closed"]);
  is("the route reports the honest total", before.total, 60);

  await withBrowser(async ({ page }) => {
    // Any throw this feature causes is a defect, not noise: the page's own errors are collected and named at the end.
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
    page.on("console", (m) => {
      if (m.type() === "error" && /clarify/i.test(m.text())) pageErrors.push(m.text());
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(panel.base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#btn-clarify", { timeout: 45_000 });
    // A fresh profile draws every project folded and the Agents card closed, so the board is expanded the way a reader
    // would: the project's own bar, then the card. Both are the page's own toggles, not a state edit, and the head only
    // exists once the first snapshot has painted, so the wait is on the HEAD and not on the static shell.
    await page.waitForSelector('.project-head[data-toggle-project="demo"]', { timeout: 45_000 });
    await page.evaluate(() => {
      if (!state.expandedProjects.has("demo")) document.querySelector('.project-head[data-toggle-project="demo"]')?.click();
      if (state.collapsedFixed.has("agents")) document.querySelector('[data-toggle-fixed="agents"]')?.click();
    });
    await page.waitForSelector("tr.row", { timeout: 30_000 });
    // No card wait here: the fixture's turns are ATTACHED to the worktree, so their card lives inside that row's detail
    // and only mounts when the row opens. The row is opened by the history click itself (that is the landing), and the
    // section that reads the card polls for it after that press. This is the reader's own path, not a pre-warmed one.

    const control = async () =>
      page.evaluate(() => {
        const btn = document.getElementById("btn-clarify");
        const human = document.getElementById("btn-human");
        const pen = document.getElementById("ha-search-open");
        const assistant = document.getElementById("btn-assistant");
        const pos = (a, b) => {
          if (!a || !b) return null;
          const r = a.compareDocumentPosition(b);
          return r & Node.DOCUMENT_POSITION_FOLLOWING ? "before" : "after";
        };
        const cs = btn ? getComputedStyle(btn) : null;
        return {
          present: Boolean(btn),
          purple: cs ? cs.color : null,
          border: cs ? cs.borderTopColor : null,
          bg: cs ? cs.backgroundColor : null,
          label: btn ? btn.textContent.trim() : null,
          // The four controls of the brief, in the order the header draws them.
          order: {
            penBeforeClarify: pos(pen, btn),
            clarifyBeforeHuman: pos(btn, human),
            assistantBeforePen: pos(assistant, pen),
          },
          humanLabel: human ? human.textContent.trim() : null,
          humanColor: human ? getComputedStyle(human).color : null,
          penLabel: pen ? pen.getAttribute("aria-label") : null,
          penGlyph: Boolean(pen && pen.querySelector("svg.ha-search-glyph")),
          clarifyAria: btn ? { haspopup: btn.getAttribute("aria-haspopup"), expanded: btn.getAttribute("aria-expanded") } : null,
          wired: btn ? btn.dataset.wired || null : null,
        };
      });

    section("1. the control: fourth in the header, purple");
    const c = await control();
    ok("the Clarify control exists and app.js wired it", c.present && c.wired === "1", JSON.stringify({ present: c.present, wired: c.wired }));
    is("the header's own order: assistant, pen, Clarify, Human", [c.order.assistantBeforePen, c.order.penBeforeClarify, c.order.clarifyBeforeHuman], ["before", "before", "before"]);
    is("the label reads Clarify", c.label, "Clarify");
    is("its colour is the header's violet", c.purple, "rgb(163, 113, 247)");
    ok("its border is purple too, not the grey the other controls use", c.border !== c.humanColor, JSON.stringify({ border: c.border, human: c.humanColor }));
    is("the Hot Agent pen is untouched", { label: c.penLabel, glyph: c.penGlyph }, { label: "Hot Agent search (Ctrl+Shift+Q)", glyph: true });
    ok("the Human button is untouched", String(c.humanLabel || "").startsWith("🙋 Human"), c.humanLabel);
    is("it starts closed and says so", c.clarifyAria, { haspopup: "dialog", expanded: "false" });

    // The header crop, for the report: the four controls at the size the reader sees them.
    const bar = await page.locator("header.topbar").boundingBox();
    if (bar) await page.screenshot({ path: shot("01-four-controls-1440.png"), clip: { x: Math.max(0, bar.x), y: Math.max(0, bar.y), width: Math.min(1440, bar.width), height: Math.min(120, bar.height + 10) } });
    await page.screenshot({ path: shot("00-board-1440.png") });

    section("2. the rows: an unanswered pair, an answered row and a cancelled one");
    await page.click("#btn-clarify");
    await page.waitForSelector("#clarify-pop:not([hidden]) .ch-row", { timeout: 10_000 });
    const rows = async () =>
      page.evaluate(() => {
        const pop = document.getElementById("clarify-pop");
        const list = document.getElementById("ch-list");
        const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
        const colour = (el) => (el ? getComputedStyle(el).color : null);
        const weight = (el) => (el ? getComputedStyle(el).fontWeight : null);
        return {
          open: !pop.hidden,
          expanded: document.getElementById("btn-clarify").getAttribute("aria-expanded"),
          count: document.getElementById("ch-count").textContent.trim(),
          foot: document.getElementById("ch-foot-text").textContent.trim(),
          more: document.getElementById("ch-more").hidden ? null : document.getElementById("ch-more").textContent.trim(),
          rect: (() => {
            const r = pop.getBoundingClientRect();
            return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
          })(),
          rows: [...list.querySelectorAll(".ch-row")].map((row) => ({
            state: row.classList.contains("is-open") ? "open" : row.classList.contains("is-answered") ? "answered" : row.classList.contains("is-closed") ? "closed" : "?",
            mark: text(row.querySelector(".ch-mark")),
            question: text(row.querySelector(".ch-q")),
            questionColour: colour(row.querySelector(".ch-q")),
            questionWeight: weight(row.querySelector(".ch-q")),
            answer: text(row.querySelector(".ch-answer")),
            answerColour: colour(row.querySelector(".ch-answer")),
            answerWeight: weight(row.querySelector(".ch-answer")),
            choices: [...row.querySelectorAll(".ch-choice")].map((c) => text(c)),
            agent: text(row.querySelector(".ch-agent")),
            tree: text(row.querySelector(".ch-tree")),
            assistant: text(row.querySelector(".ch-assistant")),
            seq: Number(row.dataset.seq),
          })),
          total: [...list.querySelectorAll(".ch-row")].length,
          listScrollW: list.scrollWidth,
          listClientW: list.clientWidth,
        };
      });
    const r0 = await rows();
    ok("the popup is open and the button says so", r0.open && r0.expanded === "true", JSON.stringify({ open: r0.open, expanded: r0.expanded }));
    is("the honest cap: fifty rows drawn of sixty", [r0.total, r0.foot, r0.more], [50, "showing 50 of 60", "show all 60"]);
    is("the header count names the store's total", r0.count, "60 questions");

    const open = r0.rows[0];
    ok("the newest row is UNANSWERED, in full colour with its marker and both choices", open.state === "open" && open.mark === "● unanswered" && open.choices.length === 2, JSON.stringify({ state: open.state, mark: open.mark, choices: open.choices }));
    is("the unanswered row names the agent, the tree and the assistant", [open.agent, open.tree, open.assistant], ["the clarify gate's agent", TREE, "Assistant #1"]);

    const answered = r0.rows[1];
    ok("the answered row is greyed and marked answered", answered.state === "answered" && answered.mark === "✓ answered", JSON.stringify({ state: answered.state, mark: answered.mark }));
    is("it shows the answer the reader actually chose", answered.answer, "the tree, then main");
    ok("the ANSWER is the loudest element of the answered row", Number(answered.answerWeight) > Number(answered.questionWeight) && answered.answerColour !== answered.questionColour, JSON.stringify({ answerWeight: answered.answerWeight, questionWeight: answered.questionWeight }));
    ok("the question is muted behind it", answered.questionColour !== open.questionColour && Number(answered.questionWeight) < Number(open.questionWeight), JSON.stringify({ answered: answered.questionColour, open: open.questionColour }));

    const closed = r0.rows[2];
    ok("the cancelled row says so and is not an answered row", closed.state === "closed" && closed.mark === "✕ cancelled after 16m", JSON.stringify({ state: closed.state, mark: closed.mark }));
    ok("its question keeps its weight instead of being greyed as answered", Number(closed.questionWeight) >= Number(open.questionWeight) && closed.answer === "", JSON.stringify({ weight: closed.questionWeight, answer: closed.answer }));
    is("the popup scrolls inside itself, with no sideways overflow", r0.listScrollW <= r0.listClientW, true);
    await page.screenshot({ path: shot("02-rows-1440.png") });

    section("3. a row lands on the turn that asked");
    // t1 is the oldest of eight turns, so the card opens on its newest page and this click has to page it back.
    const beforeLand = await page.evaluate(() => ({ page: state.turnPage.get("wt-agent-thread") ?? null }));
    is("the card starts on the newest page", beforeLand.page, null);
    await page.click('#clarify-pop .ch-row[data-seq="60"]');
    await page.waitForSelector("#clarify-pop[hidden]", { timeout: 5000 }).catch(() => {});
    // The flash is 900ms and the ring 1.9s, both of them measured from the press, and a Playwright click returns only
    // after its own actionability waits - long enough that a round-trip poll can miss a flash that really did happen.
    // So the PAGE records its own state from just before the press, at 60ms, and the assertions are read off that
    // recording: this is the page's own evidence of what the reader saw, not a guess made from far away.
    await page.evaluate(() => {
      window.__chSamples = [];
      const t0 = performance.now();
      window.__chIv = setInterval(() => {
        const row = document.querySelector('tr.row[data-key*="wt-clarify"]');
        const box = document.querySelector('.turn[data-turn="t1"] .turn-question');
        const r = box ? box.getBoundingClientRect() : null;
        window.__chSamples.push({
          t: Math.round(performance.now() - t0),
          row: row ? row.className : "",
          box: box ? box.className : "",
          centre: r ? Math.round(r.top + r.height / 2 - window.innerHeight / 2) : null,
          focus: document.activeElement ? String(document.activeElement.className || document.activeElement.tagName) : "",
        });
        if (performance.now() - t0 > 2600) clearInterval(window.__chIv);
      }, 60);
    });
    // The press is made IN THE PAGE, in the same turn as the open: a Playwright click waits for its own actionability
    // checks (and the popup's 5s poll can replace the row while it waits), so the reader's gesture is replayed as a real
    // MouseEvent on the real row button instead of a marionette whose timing is the harness's, not the page's.
    await page.evaluate(() => {
      if (!clarifyHist.open) clarifyHistoryOpen({ focus: false });
      document.querySelector('#clarify-pop .ch-row[data-seq="60"]').click();
    });
    // The row flash is 900ms: this shot is taken the moment the press lands, so the purple wash on the agent's row is
    // in the picture rather than a story about it. The later shot (03) is the settled landing.
    await page.screenshot({ path: shot("03a-landing-flash-1440.png") });
    // The recorder samples for 2.6s (the flash is 900ms, the ring 1.9s); read it after it has finished rather than
    // stopping it a tick after the press, when it would have nothing to show.
    await page.waitForTimeout(2700);
    const samples = await page.evaluate(() => {
      clearInterval(window.__chIv);
      return window.__chSamples;
    });
    const landedOnBox = samples.filter((x) => /clarify-flash/.test(x.box) && x.centre != null && Math.abs(x.centre) < 300 && /tq-choice/.test(x.focus));
    const rowFlashed = samples.filter((x) => /flash-clarify/.test(x.row));
    ok("the popup closed when the row was taken", (await page.evaluate(() => document.getElementById("clarify-pop").hidden)) === true);
    ok("the agent's ROW wears the purple row flash", rowFlashed.length > 0, `${rowFlashed.length} samples, first at ${rowFlashed[0]?.t ?? "-"}ms`);
    ok("the question box wears the purple ring, centred, with the first choice under the caret", landedOnBox.length > 0, landedOnBox.length ? `first at ${landedOnBox[0].t}ms, centre off by ${landedOnBox[0].centre}px` : `samples: ${JSON.stringify(samples.slice(0, 4))}`);
    // The landing as it stands a moment later (the panel may repaint the card, which is its own business): the turn is
    // unfolded and on the page it lives on, and the card shows it.
    const landed = await (async () => {
      const until = Date.now() + 20_000;
      let last = null;
      for (;;) {
        last = await page.evaluate(() => {
          const thread = "wt-agent-thread";
          const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
          const turn = card?.querySelector('.turn[data-turn="t1"]') || null;
          return { card: Boolean(card), page: state.turnPage.get(thread) ?? null, turn: Boolean(turn), folded: turn ? turn.classList.contains("folded") : null };
        });
        if (last.card && last.turn && last.folded === false) return last;
        if (Date.now() > until) return last;
        await sleep(150);
      }
    })();
    ok("the agent's card is on the board", landed.card === true);
    is("the turn that asked was paged in as the current context", landed.page, 1);
    ok("that turn is unfolded in the card", landed.turn === true && landed.folded === false, JSON.stringify({ turn: landed.turn, folded: landed.folded }));
    await page.screenshot({ path: shot("03-landed-1440.png") });

    section("4. an answered row opens its own previous turn, not only the agent");
    await page.evaluate(() => {
      if (!clarifyHist.open) clarifyHistoryOpen({ focus: false });
      document.querySelector('#clarify-pop .ch-row[data-seq="59"]').click();
    });
    const second = await (async () => {
      const until = Date.now() + 10_000;
      for (;;) {
        const s = await page.evaluate(() => {
          const thread = "wt-agent-thread";
          const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
          const turn = card?.querySelector('.turn[data-turn="t6"]') || null;
          return { card: Boolean(card), page: state.turnPage.get(thread) ?? null, turn: Boolean(turn), folded: turn ? turn.classList.contains("folded") : null };
        });
        if (s.card && s.turn && s.folded === false) return s;
        if (Date.now() > until) return s;
        await sleep(100);
      }
    })();
    ok("the answered row opened t6 unfolded", second.card && second.turn && second.folded === false, JSON.stringify(second));
    ok("and the card stayed on the page that holds t6", second.page === null || second.page === 0, JSON.stringify({ page: second.page }));

    section("5. the size is remembered");
    await page.click("#btn-clarify");
    await page.waitForSelector("#clarify-pop:not([hidden])", { timeout: 5000 });
    const geo0 = await page.evaluate(() => {
      const r = document.getElementById("clarify-pop").getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    });
    const grip = await page.locator("#ch-resize").boundingBox();
    ok("the corner handle is on screen", Boolean(grip), JSON.stringify(grip));
    if (grip) {
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(grip.x + grip.width / 2 + 120, grip.y + grip.height / 2 + 90, { steps: 8 });
      await page.mouse.up();
    }
    const geo1 = await page.evaluate(() => {
      const r = document.getElementById("clarify-pop").getBoundingClientRect();
      let stored = null;
      try {
        stored = JSON.parse(localStorage.getItem("wtgui.clarify.rect") || "null");
      } catch {
        stored = null;
      }
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), stored };
    });
    ok("the drag handle made it bigger", geo1.w > geo0.w + 80 && geo1.h > geo0.h + 60, JSON.stringify({ before: geo0, after: geo1 }));
    ok("the size was written to localStorage wgui.clarify.rect", Boolean(geo1.stored) && Math.abs(geo1.stored.w - geo1.w) <= 2 && Math.abs(geo1.stored.h - geo1.h) <= 2, JSON.stringify(geo1.stored));

    await page.keyboard.press("Escape");
    const closedByKey = await page.evaluate(() => ({
      hidden: document.getElementById("clarify-pop").hidden,
      focus: document.activeElement ? document.activeElement.id : null,
      stored: localStorage.getItem("wtgui.clarify.rect") || null,
    }));
    ok("Escape closes it and hands the caret back to the button", closedByKey.hidden === true && closedByKey.focus === "btn-clarify", JSON.stringify(closedByKey));
    ok("the remembered size survives the close", Boolean(closedByKey.stored));

    await page.click("#btn-clarify");
    await page.waitForSelector("#clarify-pop:not([hidden])", { timeout: 5000 });
    const geo2 = await page.evaluate(() => {
      const r = document.getElementById("clarify-pop").getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    });
    ok("reopening restores that size", Math.abs(geo2.w - geo1.w) <= 2 && Math.abs(geo2.h - geo1.h) <= 2, JSON.stringify({ remembered: geo1, again: geo2 }));
    await page.screenshot({ path: shot("04-resized-1440.png") });

    section("6. the keyboard");
    await page.keyboard.press("Escape");
    await page.focus("#btn-clarify");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#clarify-pop:not([hidden])", { timeout: 5000 });
    const focusOnPopup = await page.evaluate(() => document.activeElement?.id || document.activeElement?.className || null);
    is("Enter on the button opens the popup and puts the caret in it", focusOnPopup, "clarify-pop");
    await page.keyboard.press("ArrowDown");
    const one = await page.evaluate(() => ({ seq: document.activeElement?.dataset?.seq || null, active: document.querySelector(".ch-row.is-active")?.dataset.seq || null }));
    is("ArrowDown steps to the newest row", [one.seq, one.active], ["60", "60"]);
    await page.keyboard.press("ArrowDown");
    const two = await page.evaluate(() => ({ seq: document.activeElement?.dataset?.seq || null, active: document.querySelector(".ch-row.is-active")?.dataset.seq || null }));
    is("ArrowDown again steps one row", [two.seq, two.active], ["59", "59"]);
    await page.keyboard.press("ArrowUp");
    const back = await page.evaluate(() => document.activeElement?.dataset?.seq || null);
    is("ArrowUp steps back", back, "60");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#clarify-pop[hidden]", { timeout: 5000 }).catch(() => {});
    const afterEnter = await page.evaluate(() => ({ hidden: document.getElementById("clarify-pop").hidden, page: state.turnPage.get("wt-agent-thread") ?? null }));
    ok("Enter opens the row under the caret", afterEnter.hidden === true && afterEnter.page === 1, JSON.stringify(afterEnter));

    section("7. no clipping at 768 wide");
    await page.setViewportSize({ width: 768, height: 900 });
    await sleep(250);
    await page.click("#btn-clarify");
    await page.waitForSelector("#clarify-pop:not([hidden])", { timeout: 5000 });
    // The remembered 560-odd width no longer fits nothing... at 768 it still fits; the point is that it is INSIDE the
    // window on all four edges and that neither the page nor the list scrolls sideways.
    const narrow = await page.evaluate(() => {
      const pop = document.getElementById("clarify-pop");
      const r = pop.getBoundingClientRect();
      const list = document.getElementById("ch-list");
      return {
        rect: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) },
        viewport: { w: window.innerWidth, h: window.innerHeight },
        pageScrollW: document.documentElement.scrollWidth,
        listScrollW: list.scrollWidth,
        listClientW: list.clientWidth,
        foot: document.getElementById("ch-foot-text").textContent.trim(),
      };
    });
    ok("the popup is inside the 768-wide window on all four edges", narrow.rect.left >= 8 && narrow.rect.top >= 8 && narrow.rect.right <= narrow.viewport.w - 8 && narrow.rect.bottom <= narrow.viewport.h - 8, JSON.stringify(narrow.rect));
    ok("the page itself does not scroll sideways", narrow.pageScrollW <= narrow.viewport.w, String(narrow.pageScrollW));
    is("the list has no horizontal overflow", narrow.listScrollW <= narrow.listClientW, true);
    is("the honest cap is still said at 768", narrow.foot, "showing 50 of 60");
    await page.screenshot({ path: shot("05-narrow-768.png") });
    is("the page threw nothing while the control was driven", pageErrors.slice(0, 3), []);
  });

  section("8. a restart does not empty the history");
  await panel.stop();
  panel = await startPanel({ dir, keep: true, reuseConfig: true, config: { apiServer: API } });
  const afterRestart = await (await fetch(`${panel.base}/api/clarify/history`)).json();
  is("the same sixty rows answer after a restart", afterRestart.total, 60);
  const keptAnswer = afterRestart.entries.find((e) => e.key === "clarify:t6:p2");
  ok("the answered row kept its answer, who and when", keptAnswer?.status === "answered" && keptAnswer.answer === "the tree, then main" && keptAnswer.answeredBy === "reader" && Boolean(keptAnswer.answeredAt), JSON.stringify(keptAnswer && { status: keptAnswer.status, answer: keptAnswer.answer, by: keptAnswer.answeredBy, at: keptAnswer.answeredAt }));
  const stillOpen = afterRestart.entries.find((e) => e.key === "clarify:t1:p1");
  is("the question still parked on a live turn is still open", stillOpen?.status, "open");
} finally {
  await panel.stop();
  await new Promise((r) => stub.close(() => r()));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
console.log(`screenshots: ${outDir}`);
