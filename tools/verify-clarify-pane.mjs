#!/usr/bin/env node
// A clarify question, where the reader is looking: the turn output, with every choice, exactly once.
//
//   node tools/verify-clarify-pane.mjs                     # this checkout
//   node tools/verify-clarify-pane.mjs --root <dir>         # a `git archive` of another build (expected to fail)
//   node tools/verify-clarify-pane.mjs --out <dir>          # where the screenshots and results.json go
//
// WHAT IT PINS (queue row #277, and row #267's timeout behind it)
//
//   (1) ASKED THROUGH THE AGENT PATH, not a hand-made record: a real Runs API stream carries `clarify.request` into a
//       sandbox panel's own jobs pipeline, and the card is drawn from the record that arrives.
//   (2) VISIBLE IN THE TURN OUTPUT: the question text and EVERY choice are inside the card's turn, and the box is in
//       the reader's viewport when it arrives - the pane brings it into view instead of leaving it below the fold while
//       only the header's badge changes.
//   (3) NOT HIDDEN BY THE FOLD: a turn the reader has folded, or frozen to a snippet, still carries the whole question,
//       with every choice clickable. A question is not a detail of an open console.
//   (4) EXACTLY ONCE: one question block per question in the document - the turn's own copy - and a press answers that
//       one card once (one POST, one recorded answer, the box cleared on the spot).
//   (5) A SPENT WINDOW IS A VISIBLE TRACE, not a vanish: the card stops offering an answer at its deadline, and when the
//       gateway settles the prompt the turn keeps a block that names the question, its choices and why it closed.
//
// WHAT IS DRIVEN. A sandbox panel of its own on a spare port (tools/panel-testkit.mjs: own config, own jobs.json, no
// reader's store touched) pointed at a stub Runs API that plays a parked turn over REAL SSE and answers the clarify
// route. The agent is started through the panel's own POST /api/agents, so the question record the card draws is the
// shipped one. The page is a real Chromium; every reading below is taken from the DOM it renders.
//
// HARNESS: LIVE GATE
//
// Exit codes: 0 every assertion held; 1 one failed; 2 the run could not measure what it claims (no Playwright).
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./browser.mjs";
import { startPanel, git, configureRepo, sliceBetween } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const OUT = opt("--out", path.join(os.tmpdir(), "wag", "clarify-pane"));

const QUESTION =
  "The pane proof is ready at __REPORT_PATH__ - should the card ship as drawn?";
// The file the question links to, built at RUN time: a drive-letter path in this source would be a folder on one
// machine that no reader can open, which is what tools/absolute-paths.mjs refuses (the card still gets an absolute
// target, because that is what a link has to carry).
const REPORT_PATH = path.join(os.tmpdir(), "wag", "clarify-pane-link", "pane-report.html").replace(/\\/g, "/");
const QUESTION_TEXT = QUESTION.replace("__REPORT_PATH__", REPORT_PATH);
const CHOICES = ["Ship it as drawn (Recommended)", "Move the card above the console", "Hold it, show me the numbers"];
const QUESTION_2 = "The window is about to run out on this one - should a timed-out card keep what it asked?";
const CHOICES_2 = ["Keep the question and its choices, dead", "Leave one line saying it timed out"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const occurrences = (text, needle) => String(text || "").split(needle).length - 1;

let checks = 0;
let failures = 0;
const results = [];
const check = (name, cond, extra = "") => {
  checks += 1;
  if (!cond) failures += 1;
  results.push({ name, ok: Boolean(cond), extra });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `: ${extra}` : ""}`);
};

// ---- the stub Runs API ---------------------------------------------------------------------------------------
// One scripted turn per run: the clarify call, its request, then a stream that STAYS OPEN (a parked run's stream does;
// ending it is what makes the panel's follower reconnect and settle the job).
function makeGateway() {
  const runs = new Map();
  const answers = [];
  let posts = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/v1/capabilities") {
      // Deliberately NO clarify feature: the panel must be reading the ROUTE, and a stub that advertises the feature
      // hides exactly the bug a build without a callback has (see lib/clarify.js).
      return json(200, {
        version: "clarify-pane-stub",
        features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true },
      });
    }
    const clarify = /^\/v1\/runs\/([^/]+)\/clarify$/.exec(url.pathname);
    if (clarify && req.method === "POST") {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        const rec = runs.get(clarify[1]);
        if (!rec) return json(404, { error: { code: "run_not_found", message: "no such run" } });
        let parsed = null;
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          parsed = null;
        }
        answers.push({ runId: rec.id, body: parsed, at: Date.now() });
        rec.answered = true;
        rec.emit?.({ event: "clarify.settled", prompt_id: rec.promptId });
        setTimeout(() => rec.emit?.({ event: "run.completed", output: "answered" }), 120);
        json(200, { status: "resolved" });
      });
      return;
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      req.resume();
      req.on("end", () => {
        posts += 1;
        const id = `run_pane_${posts}`;
        runs.set(id, { id, promptId: `prompt_pane_${posts}`, answered: false, emit: null, delay: 1500 });
        json(202, { run_id: id, status: "running" });
      });
      return;
    }
    const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const rec = runs.get(one[1]);
      if (!rec) return json(404, { error: { code: "run_not_found", message: "no such run" } });
      return json(200, {
        run_id: rec.id,
        status: rec.answered ? "completed" : "running",
        output: rec.answered ? "answered" : "",
        pending_controls: rec.answered ? [] : [{ kind: "clarify", prompt_id: rec.promptId, execution_generation: 1 }],
      });
    }
    const ev = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (ev && req.method === "GET") {
      const rec = runs.get(ev[1]);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": open\n\n");
      if (!rec) return res.end();
      let seq = 0;
      rec.emit = (evt) => {
        if (res.writableEnded) return;
        seq += 1;
        res.write(`id: ${seq}\ndata: ${JSON.stringify(evt)}\n\n`);
      };
      const second = rec.id.endsWith("_2");
      const question = second ? QUESTION_2 : QUESTION_TEXT;
      const choices = second ? CHOICES_2 : CHOICES;
      setTimeout(() => {
        rec.emit({ event: "tool.started", tool: "clarify", preview: question });
        rec.emit({
          event: "clarify.request",
          prompt_id: rec.promptId,
          execution_generation: 1,
          question,
          choices,
          multi_select: false,
          // The SECOND question carries the gateway's own window: one second, so the card's countdown is what shuts
          // the box (the shipped tick, not a deadline this gate moved), and the panel's close reason is the
          // `timed out` it writes when a prompt is settled past its own deadline.
          ...(second ? { timeout_s: 1 } : { links: [{ label: "the report", path: REPORT_PATH }] }),
        });
      }, rec.delay);
      req.on("close", () => {
        rec.emit = null;
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  });
  return {
    runs,
    answers,
    listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((r) => server.close(r)),
  };
}

// ---- what the page actually holds ----------------------------------------------------------------------------
// One reading of the card: every question block in it, the question it belongs to, its choices as the DOM has them,
// whether each can be clicked, and where the block sits against the viewport the reader is looking through.
const readCard = (page, thread) =>
  page.evaluate((t) => {
    const job = document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
    if (!job) return { card: false };
    const boxes = [...job.querySelectorAll(".turn-question")].map((el) => {
      const r = el.getBoundingClientRect();
      const choices = [...el.querySelectorAll("button.tq-choice")].map((b) => ({
        label: b.innerText.replace(/\s+/g, " ").trim(),
        disabled: Boolean(b.disabled),
        clickable: !b.disabled && getComputedStyle(b).pointerEvents !== "none" && getComputedStyle(b).visibility !== "hidden",
      }));
      const ticks = [...el.querySelectorAll("input[data-qpick]")].map((i) => ({ label: i.dataset.qvalue, disabled: Boolean(i.disabled) }));
      return {
        forTurn: el.dataset.questionFor || "",
        requestId: el.querySelector("[data-qrequest]")?.dataset?.qrequest || "",
        question: (el.querySelector(".tq-question")?.innerText || "").replace(/\s+/g, " ").trim(),
        links: [...el.querySelectorAll(".tq-links .tq-link")].map((a) => (a.innerText || "").replace(/\s+/g, " ").trim()),
        choices,
        ticks,
        typed: Boolean(el.querySelector("textarea.tq-other")),
        send: Boolean(el.querySelector("button.tq-send")),
        note: (el.querySelector("[data-qnote]")?.innerText || "").replace(/\s+/g, " ").trim(),
        rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) },
        inViewport: r.height > 0 && r.bottom > 0 && r.top < window.innerHeight,
        visible: getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden" && r.height > 0,
      };
    });
    const closed = [...job.querySelectorAll(".turn-question-done.is-closed")].map((el) => ({
      head: (el.querySelector(".tqd-head")?.innerText || "").replace(/\s+/g, " ").trim(),
      text: (el.innerText || "").replace(/\s+/g, " ").trim(),
      question: (el.querySelector(".tqd-question")?.innerText || "").replace(/\s+/g, " ").trim(),
      choices: [...el.querySelectorAll(".tqd-choice")].map((c) => (c.innerText || "").replace(/\s+/g, " ").trim()),
      live: el.querySelectorAll("button").length,
    }));
    return {
      card: true,
      boxes,
      closed,
      done: [...job.querySelectorAll(".turn-question-done")].map((el) => (el.innerText || "").replace(/\s+/g, " ").trim()),
      turns: [...job.querySelectorAll(".turn")].map((n) => n.className),
      allQuestionBlocks: [...document.querySelectorAll(".job[data-thread] .turn-question")].length,
      scroll: { y: Math.round(window.scrollY), ih: window.innerHeight },
    };
  }, thread);

// ---- the run -------------------------------------------------------------------------------------------------
const main = async () => {
  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN: no playwright on this box (set PANEL_PLAYWRIGHT_ROOT)");
    process.exit(2);
  }
  mkdirSync(OUT, { recursive: true });
  // The file the question links to, so the anchor on the card points at something a click can open: the gate's own
  // copy of the report page, written beside the run's figures rather than read from the repo.
  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, "<!doctype html><title>the pane proof</title><p>the page the clarify card's link opens.</p>");
  const work = mkdtempSync(path.join(os.tmpdir(), "wtgui-clarify-pane-"));
  const roots = [path.join(work, "rootA")];
  const repo = path.join(roots[0], "proj");
  let sandbox = null;
  let gw = null;
  let browser = null;
  const out = { tree: TREE, checks: results, phases: {}, errors: [], question: QUESTION_TEXT, choices: CHOICES };
  try {
    mkdirSync(path.join(repo, "docs"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    configureRepo(repo);
    writeFileSync(path.join(repo, "docs", "a.md"), "# Title\n\nbody line\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "first");

    gw = makeGateway();
    const gwUrl = await gw.listen();
    sandbox = await startPanel({
      root: TREE,
      dir: work,
      config: {
        scanRoots: roots,
        projects: [],
        refreshSeconds: 30,
        worktreeSeconds: 60,
        midSeconds: 60,
        dormantSeconds: 60,
        slowSeconds: 300,
        fetchSeconds: -1,
        assistant: { enabled: false },
        remoteBranchPolicy: "local-only",
        defaultCwd: repo,
        apiServer: { url: gwUrl, key: "probe" },
      },
      env: { API_SERVER_KEY: "" },
    });
    console.log(`panel ${sandbox.base} (${TREE})`);

    browser = await pw.chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => out.errors.push(String((e && e.message) || e).slice(0, 240)));
    await page.goto(sandbox.base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.jobs, null, { timeout: 30_000 });

    const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const reveal = () =>
      page.evaluate((p) => {
        const n2 = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
        const row = [...state.rows.values()].find((r) => n2(r.path) === p);
        if (!row) return false;
        state.expandedProjects.add(row.project);
        state.expanded.add(`${row.project}::${row.path}`);
        renderAll();
        return true;
      }, norm(repo));

    const thread = "clarify-pane";
    const spawn = async () => {
      const r = await fetch(`${sandbox.base}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "probe: ask one clarify question", cwd: repo, existing: true, thread }),
      }).then((x) => x.json());
      if (!r || !r.job) throw new Error(`spawn failed: ${JSON.stringify(r).slice(0, 300)}`);
      return r.job.id;
    };
    const waitQuestion = async (id, ms = 30_000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const q = await page.evaluate((x) => state.jobs.get(x)?.question || null, id);
        if (q) return q;
        await sleep(120);
      }
      return null;
    };

    await reveal();
    const jobId = await spawn();
    await reveal();
    await page.waitForSelector(`.job[data-thread="${thread}"] pre.job-out`, { timeout: 60_000 });
    // The reader is at the top of the board when the question arrives: nothing has scrolled the card into view.
    await page.evaluate(() => window.scrollTo(0, 0));
    const rec = await waitQuestion(jobId);
    out.phases.record = rec
      ? { requestId: rec.requestId, question: rec.question, choices: rec.choices, links: rec.links, base: rec.base, deadline: Boolean(rec.deadline) }
      : null;
    check("a real clarify.request reaches the panel's own job record", Boolean(rec), rec ? `request ${rec.requestId}` : "no question");
    check("the record carries the question verbatim", Boolean(rec) && rec.question === QUESTION_TEXT, rec ? String(rec.question).slice(0, 60) : "no question");
    check("the record carries every choice", Boolean(rec) && Array.isArray(rec.choices) && rec.choices.length === CHOICES.length, rec ? `${(rec.choices || []).length} choices` : "no question");
    check("the record carries the question's link", Boolean(rec) && (rec.links || []).length === 1, rec ? `${(rec.links || []).length} links` : "no question");

    await sleep(700);
    const arrived = await readCard(page, thread);
    out.phases.arrived = arrived;
    check("the turn output holds the question", arrived.card && arrived.boxes.length === 1, arrived.card ? `${arrived.boxes.length} question block(s)` : "no card");
    const box = arrived.boxes[0];
    check("...with the question text in it", Boolean(box) && box.question === QUESTION_TEXT, box ? box.question.slice(0, 70) : "no block");
    check(
      "...with every choice drawn and clickable",
      Boolean(box) && (box.choices.length ? box.choices.length === CHOICES.length : box.ticks.length === CHOICES.length) && [...(box?.choices || []), ...(box?.ticks || [])].every((c) => c.clickable !== false && !c.disabled),
      box ? JSON.stringify((box.choices.length ? box.choices : box.ticks).map((c) => c.label)) : "no block",
    );
    check("...and the answer path (typed box and Send) under them", Boolean(box) && box.typed && box.send, box ? `typed ${box.typed}, send ${box.send}` : "no block");
    check("...and the question's link is an anchor", Boolean(box) && box.links.length === 1, box ? JSON.stringify(box.links) : "no block");
    check("the blocking box is not clickable through a dead state", Boolean(box) && !(box.note || "").includes("no longer be delivered"), box ? box.note : "no block");
    check("the box is in the viewport when it arrives, without the reader hunting for it", Boolean(box) && box.inViewport && box.visible, box ? JSON.stringify(box.rect) : "no block");
    check("exactly one question block for this question in the document", arrived.card && arrived.allQuestionBlocks === 1, arrived.card ? `${arrived.allQuestionBlocks} in the document` : "no card");
    await page.screenshot({ path: path.join(OUT, "1-arrived.png") }).catch(() => {});

    // ---- (3) the fold does not hide a question ---------------------------------------------------------------
    const foldTurn = () =>
      page.evaluate((t) => {
        const job = document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
        const head = job?.querySelector(".turn .turn-head [data-toggle-turn], .turn [data-toggle-turn], .turn-head");
        head?.click();
      }, thread);
    await foldTurn();
    await sleep(500);
    const folded = await readCard(page, thread);
    out.phases.folded = folded;
    check("a turn the reader folded still reads as folded", folded.card && folded.turns.some((c) => /folded/.test(c)), folded.card ? folded.turns.join(" | ") : "no card");
    check("...and still carries the question, every choice", folded.card && folded.boxes.length === 1 && (folded.boxes[0].choices.length || folded.boxes[0].ticks.length) === CHOICES.length, folded.card ? `${folded.boxes.length} block(s), ${(folded.boxes[0]?.choices || folded.boxes[0]?.ticks || []).length} choice(s)` : "no card");
    check("...with the choices still clickable", folded.card && Boolean(folded.boxes[0]) && (folded.boxes[0].choices.length ? folded.boxes[0].choices.every((c) => c.clickable) : folded.boxes[0].ticks.every((c) => !c.disabled)), folded.card ? JSON.stringify((folded.boxes[0]?.choices || []).map((c) => c.clickable)) : "no card");
    await page.screenshot({ path: path.join(OUT, "2-folded.png") }).catch(() => {});

    // the frozen form is the other way a reader closes a turn
    await page.evaluate(
      (t) => {
        const job = document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
        job?.querySelector(".turn-head")?.click();
      },
      thread,
    );
    await sleep(300);
    await page.evaluate((t) => {
      const conv = conversations().find((c) => c.thread === t);
      if (!conv) return;
      wtTurnFold.freeze(state, conv.latest, "");
      wtTurnFold.setOpen(state, conv.latest, false);
      renderConversation(t);
    }, thread);
    await sleep(400);
    const frozen = await readCard(page, thread);
    out.phases.frozen = frozen;
    check("a turn frozen to a snippet still carries the whole question", frozen.card && frozen.boxes.length === 1 && (frozen.boxes[0].choices.length || frozen.boxes[0].ticks.length) === CHOICES.length, frozen.card ? `${frozen.boxes.length} block(s)` : "no card");

    // ---- (4) one press, one answer ---------------------------------------------------------------------------
    await page.evaluate((t) => {
      const conv = conversations().find((c) => c.thread === t);
      if (!conv) return;
      wtTurnFold.unfreeze(state, conv.latest, "");
      wtTurnFold.setOpen(state, conv.latest, true);
      renderConversation(t);
    }, thread);
    await sleep(300);
    const beforePress = gw.answers.length;
    await page.click(`.job[data-thread="${thread}"] .turn-question button.tq-choice[data-qvalue="${CHOICES[1]}"]`);
    await sleep(900);
    const answered = await readCard(page, thread);
    const recAfter = await page.evaluate((id) => {
      const j = state.jobs.get(id);
      return j ? { question: Boolean(j.question), done: j.questionDone || null } : null;
    }, jobId);
    out.phases.answered = { answered, recAfter, posts: gw.answers.slice(beforePress) };
    check("a press on a choice answers the question", recAfter && !recAfter.question, recAfter ? `question ${recAfter.question}` : "no record");
    check("...the panel sent exactly ONE answer to the gateway", gw.answers.length - beforePress === 1, `${gw.answers.length - beforePress} POST(s)`);
    check(
      "...carrying the choice, the prompt id and the execution generation",
      Boolean(gw.answers[beforePress]?.body?.answer === CHOICES[1] && gw.answers[beforePress]?.body?.request_id && Number.isInteger(gw.answers[beforePress]?.body?.execution_generation)),
      JSON.stringify(gw.answers[beforePress]?.body || null),
    );
    check("...and the card stops offering an answer, saying what was answered", answered.card && answered.boxes.length === 0 && answered.done.some((t) => t.includes(CHOICES[1].slice(0, 20))), answered.card ? JSON.stringify(answered.done) : "no card");
    check("...and no question block is left anywhere for it", answered.card && answered.allQuestionBlocks === 0, answered.card ? `${answered.allQuestionBlocks}` : "no card");

    // ---- (5) a spent window leaves a trace -------------------------------------------------------------------
    const job2 = await spawn();
    await reveal();
    const rec2 = await waitQuestion(job2);
    out.phases.record2 = rec2 ? { requestId: rec2.requestId, question: rec2.question, deadline: rec2.deadline, window: rec2.timeoutSeconds } : null;
    check("a second question parks on a second turn", Boolean(rec2), rec2 ? `request ${rec2.requestId}` : "no question");
    check("...carrying the gateway's own one-second window", Boolean(rec2) && Number(rec2.timeoutSeconds) === 1, rec2 ? `${rec2.timeoutSeconds}s` : "no question");
    // The page's OWN clock shuts the box at the deadline: no deadline is moved here, the shipped tick is what acts.
    let spent = null;
    const spentAt = Date.now();
    while (Date.now() - spentAt < 12_000) {
      const s = await readCard(page, thread);
      const b = s.boxes.find((x) => x.question === QUESTION_2);
      if (b && /no longer be delivered/.test(b.note)) {
        spent = s;
        break;
      }
      await sleep(150);
    }
    out.phases.spent = spent;
    const spentBox = spent?.boxes.find((b) => b.question === QUESTION_2) || null;
    check("the card stops offering an answer once its window is spent", Boolean(spentBox) && spentBox.note.includes("no longer be delivered"), spentBox ? spentBox.note : "the tick never shut it");
    check("...and every control on it is dead", Boolean(spentBox) && (spentBox.choices.length ? spentBox.choices.every((c) => c.disabled) : spentBox.ticks.every((c) => c.disabled)), spentBox ? JSON.stringify(spentBox.choices.map((c) => c.disabled)) : "no box");

    // The gateway settles the spent prompt. What is left in the turn must NAME the question, not just say it closed.
    const run2 = [...gw.runs.values()].at(-1);
    run2?.emit?.({ event: "clarify.settled", prompt_id: run2.promptId });
    const traceAt = Date.now();
    let traced = null;
    while (Date.now() - traceAt < 15_000) {
      const s = await readCard(page, thread);
      if (s.card && s.closed.length) {
        traced = s;
        break;
      }
      await sleep(200);
    }
    out.phases.traced = traced;
    const trace = traced?.closed?.[0];
    check("a card that times out leaves a visible trace in the turn output", Boolean(trace), traced ? `${traced.closed.length} trace(s)` : "nothing drawn");
    check("...naming the question that went unanswered", Boolean(trace) && trace.question === QUESTION_2, trace ? trace.question.slice(0, 70) : "no trace");
    check("...with every choice it offered still readable", Boolean(trace) && trace.choices.length === CHOICES_2.length, trace ? JSON.stringify(trace.choices) : "no trace");
    check("...saying the window ran out rather than reading as a decision", Boolean(trace) && /window ran out/i.test(trace.head), trace ? trace.head : "no trace");
    check("...and offering no live control on a wait that is over", Boolean(trace) && trace.live === 0, trace ? `${trace.live} button(s)` : "no trace");
    await page.screenshot({ path: path.join(OUT, "3-timed-out.png") }).catch(() => {});

    // ---- the shipped renderer says what the gate claims --------------------------------------------------------
    // The page half is the one that loses a card, so its rule is read from the source too: the question block is part of
    // the TURN BLOCK in every shape the turn takes (not of the open turn's body), and a pinned copy is not a second
    // answer surface for a question its own turn is already drawing.
    const jobsSrc = readFileSync(path.join(TREE, "public", "render-jobs.js"), "utf8");
    const blockSrc = sliceBetween(jobsSrc, "function turnBlock(", "function conversationHtml(");
    const shapes = occurrences(blockSrc, "${ask}");
    check("turnBlock draws the question block in every shape of a turn (open, folded, frozen)", shapes === 3, `${shapes} of 3 shapes carry it`);
    check("...and the open turn's body no longer draws a second copy", !/questionPrompt\(/.test(sliceBetween(jobsSrc, "function turnBody(", "function conversationTaskLink(")), "");
    const convSrc = sliceBetween(jobsSrc, "function conversationHtml(", "function jobHtml(");
    check(
      "one block per question: the pinned and off-page copies take it only where the turn is not drawn",
      /const away = turns\.filter\(\(t\) => t\.question && !t\.questionDone && !pageIds\.has\(t\.id\) && !pinnedIds\.has\(t\.id\)\)/.test(convSrc) &&
        /pageIds\.has\(t\.id\) \? "" : askFor\(t, wtTurnFold\.PIN\)/.test(convSrc),
      `${occurrences(convSrc, "questionPrompt(")} renderer(s): the page copy, the off-page block`,
    );

    if (out.errors.length) check("the page threw nothing", false, out.errors.join(" | "));
    else check("the page threw nothing", true);
  } catch (e) {
    check(`the run completed: ${String((e && e.message) || e).slice(0, 240)}`, false);
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
    try {
      await sandbox?.stop();
    } catch {
      /* ignore */
    }
    try {
      await gw?.close();
    } catch {
      /* ignore */
    }
    try {
      writeFileSync(path.join(OUT, "results.json"), JSON.stringify(out, null, 2));
    } catch {
      /* ignore */
    }
  }
  console.log(`\n${checks - failures}/${checks} checks passed - ${path.join(OUT, "results.json")}`);
  process.exit(failures ? 1 : 0);
};

main();
