#!/usr/bin/env node
// A park where the reader is looking: the turn output, in every shape of the turn, exactly once.
//
//   node tools/verify-clarify-pane.mjs                     # this checkout
//   node tools/verify-clarify-pane.mjs --root <dir>         # a `git archive` of another build (expected to fail)
//   node tools/verify-clarify-pane.mjs --out <dir>          # where the screenshots and results.json go
//
// WHAT IT PINS (queue row #277 for the question, queue row #286 for the approval, and row #267's timeout behind it)
//
//   (1) ASKED THROUGH THE AGENT PATH, not a hand-made record: a real Runs API stream carries `clarify.request` and
//       `approval.request` into a sandbox panel's own jobs pipeline, and the card is drawn from the record that arrives.
//   (2) VISIBLE IN THE TURN OUTPUT: the question text / the command and EVERY choice are inside the card's turn, and
//       the box is in the reader's viewport when it arrives - the pane brings it into view instead of leaving it below
//       the fold while only the header's badge changes.
//   (3) NOT HIDDEN BY THE FOLD: a turn the reader has folded, or frozen to a snippet, still carries the whole box, with
//       every choice drawn. Neither a question nor an approval is a detail of an open console.
//   (4) EXACTLY ONCE: one block per park in the document - the turn's own copy - and a press answers that one card once
//       (one POST, one recorded answer, the box cleared on the spot). An approval is never answered from this harness:
//       the panel's box links to the gateway and the dock, and pressing it is the reader's act, not a gate's.
//   (5) A SPENT WINDOW IS A VISIBLE TRACE, not a vanish: the card stops offering an answer at its deadline, and when the
//       wait is over the turn keeps a block that names what was asked, its choices and why it closed.
//   (6) ONE PLACE, WHATEVER THE SHAPE: the approval box is drawn by the turn block in all three shapes, and
//       conversationHtml decides its one place - the turn's own copy, the pinned copy when the turn is off the page, or
//       a block at the top of the card naming the turn. Row #286 measured a folded turn drawing ZERO boxes on the base
//       build and an arrival below the fold, which is what `--root` on the base shows.
//
// WHAT IS DRIVEN. A sandbox panel of its own on a spare port (tools/panel-testkit.mjs: own config, own jobs.json, no
// reader's store touched) pointed at a stub Runs API that plays a parked turn over REAL SSE and answers the clarify
// route. The agent is started through the panel's own POST /api/agents, so the record the card draws is the shipped
// one. The page is a real Chromium; every reading below is taken from the DOM it renders.
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
// ---- row #286: the other park a turn can hold ---------------------------------------------------------------
// A flagged command, in the shape a real approval request carries: the command the agent asked to run and the choices
// the host allows. The first stays open for the whole run (the window the gateway's own config would give it); the
// second carries a one-second window, so the panel's own sweep expires it and the trace is the shipped one.
//
// Both of its paths are built at RUN time. A drive-letter literal here would be a folder on the machine that wrote this
// file, which tools/absolute-paths.mjs refuses, and the box wants a command that writes OUTSIDE the run's tree: the
// sandbox's own scratch parent is exactly that, on whatever machine this gate runs.
const OUTSIDE = path.join(os.tmpdir(), "wag", "approval-pane-outside").replace(/\\/g, "/");
const APPROVAL_COMMAND = `rm -rf ${OUTSIDE}/build-cache && cp -r dist/ ${OUTSIDE}/www/`;
const APPROVAL_CHOICES = ["once", "deny"];
const APPROVAL_2_COMMAND = "git push --force origin main";
const APPROVAL_2_CHOICES = ["once", "session", "deny"];
// One scripted turn per run, by the order the runs are submitted: the two clarify turns this harness has always
// played, then the approval that parks (the long window the run below needs), then three plain turns that exist only
// to push the approval off the turn pager (6 turns, 5 a page) so the away and pinned copies can be measured in the
// DOM, and last the approval that expires - last because it is the newest turn, and the newest turn is the one the
// card opens.
const PLAN = ["clarify", "clarify-expiring", "approval", "plain", "plain", "plain", "approval-expiring"];

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
  const approvalPosts = [];
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
    // The approval's own answer route. Nothing in this harness presses it - the panel is not the surface that settles
    // an approval in this proof - and the list it appends to is what proves that: it must stay empty.
    const approval = /^\/v1\/runs\/([^/]+)\/approval$/.exec(url.pathname);
    if (approval && req.method === "POST") {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        const rec = runs.get(approval[1]);
        if (!rec) return json(404, { error: { code: "run_not_found", message: "no such run" } });
        let parsed = null;
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          parsed = null;
        }
        approvalPosts.push({ runId: rec.id, body: parsed, at: Date.now() });
        rec.answered = true;
        rec.emit?.({ event: "approval.responded", request_id: rec.promptId, choice: parsed?.choice || "" });
        setTimeout(() => rec.emit?.({ event: "run.completed", output: "approved" }), 120);
        json(200, { status: "resolved" });
      });
      return;
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      req.resume();
      req.on("end", () => {
        posts += 1;
        const id = `run_pane_${posts}`;
        runs.set(id, { id, promptId: `prompt_pane_${posts}`, answered: false, emit: null, delay: 1500, kind: PLAN[posts - 1] || "plain" });
        json(202, { run_id: id, status: "running" });
      });
      return;
    }
    const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const rec = runs.get(one[1]);
      if (!rec) return json(404, { error: { code: "run_not_found", message: "no such run" } });
      // The run's own statement about what it is waiting on. A park this route does not name is one the panel's
      // reconcile has to drop, so it carries the request for the turns that really are parked and nothing for a plain
      // turn.
      const pending = rec.answered || rec.kind === "plain"
        ? []
        : rec.kind.startsWith("approval")
          ? [{ kind: "approval", prompt_id: rec.promptId, command: rec.kind === "approval" ? APPROVAL_COMMAND : APPROVAL_2_COMMAND, execution_generation: 1 }]
          : [{ kind: "clarify", prompt_id: rec.promptId, execution_generation: 1 }];
      return json(200, {
        run_id: rec.id,
        status: rec.answered ? "completed" : "running",
        output: rec.answered ? "answered" : "",
        pending_controls: pending,
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
      const second = rec.kind === "clarify-expiring";
      const question = second ? QUESTION_2 : QUESTION_TEXT;
      const choices = second ? CHOICES_2 : CHOICES;
      // A plain turn exists only to give the pager something to page: it says one line and then sits there like any
      // other parked run.
      if (rec.kind === "plain") {
        setTimeout(() => rec.emit({ event: "tool.started", tool: "read_file", preview: "docs/a.md" }), 120);
        req.on("close", () => {
          rec.emit = null;
        });
        return;
      }
      if (rec.kind.startsWith("approval")) {
        const expiring = rec.kind === "approval-expiring";
        setTimeout(() => {
          rec.emit({ event: "tool.started", tool: "shell", preview: expiring ? APPROVAL_2_COMMAND : APPROVAL_COMMAND });
          rec.emit({
            event: "approval.request",
            request_id: rec.promptId,
            execution_generation: 1,
            command: expiring ? APPROVAL_2_COMMAND : APPROVAL_COMMAND,
            description: "a flagged command",
            choices: expiring ? APPROVAL_2_CHOICES : APPROVAL_CHOICES,
            // The expiring one carries the gateway's own one-second window: the panel's sweep is what takes the box
            // away and writes the record, on the deadline this number mints - no clock is moved by the gate.
            ...(expiring ? { timeout_seconds: 1 } : { timeout_seconds: 600 }),
          });
        }, rec.delay);
        req.on("close", () => {
          rec.emit = null;
        });
        return;
      }
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
    approvalPosts,
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
    // The approval's own reading (#286): every box the card draws, where it sits, whether the reader could see it on
    // arrival, and whether it is the turn's copy, the pinned one or the off-page block.
    const approvals = [...job.querySelectorAll(".turn-approval")].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        forTurn: el.dataset.approvalFor || "",
        head: (el.querySelector(".ta-head")?.innerText || "").replace(/\s+/g, " ").trim(),
        command: (el.querySelector(".ta-cmd")?.innerText || "").replace(/\s+/g, " ").trim(),
        choices: [...el.querySelectorAll("button.btn-approve")].map((b) => ({
          choice: b.dataset.choice || "",
          label: (b.innerText || "").replace(/\s+/g, " ").trim(),
          request: b.dataset.request || "",
          disabled: Boolean(b.disabled),
        })),
        buttons: el.querySelectorAll("button").length,
        inTurn: Boolean(el.closest(".turn")),
        inPinned: Boolean(el.closest(".pinned-turns")),
        inAway: Boolean(el.closest(".turn-approval-away")),
        rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) },
        inViewport: r.height > 0 && r.bottom > 0 && r.top < window.innerHeight,
        visible: getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden" && r.height > 0,
      };
    });
    // What an expired approval leaves behind: the block, what it asked, the choices it offered and why it closed.
    const approvalTraces = [...job.querySelectorAll(".turn-approval-done.is-trace")].map((el) => ({
      head: (el.querySelector(".tad-head")?.innerText || "").replace(/\s+/g, " ").trim(),
      why: (el.querySelector(".tad-why")?.innerText || "").replace(/\s+/g, " ").trim(),
      command: (el.querySelector(".tad-cmd")?.innerText || "").replace(/\s+/g, " ").trim(),
      choices: [...el.querySelectorAll(".tad-choice")].map((c) => (c.innerText || "").replace(/\s+/g, " ").trim()),
      when: (el.querySelector(".tad-when")?.innerText || "").replace(/\s+/g, " ").trim(),
      buttons: el.querySelectorAll("button").length,
      inTurn: Boolean(el.closest(".turn")),
      inPinned: Boolean(el.closest(".pinned-turns")),
    }));
    return {
      card: true,
      boxes,
      closed,
      done: [...job.querySelectorAll(".turn-question-done")].map((el) => (el.innerText || "").replace(/\s+/g, " ").trim()),
      turns: [...job.querySelectorAll(".turn")].map((n) => n.className),
      allQuestionBlocks: [...document.querySelectorAll(".job[data-thread] .turn-question")].length,
      approvals,
      approvalTraces,
      approvalHeads: [...job.querySelectorAll(".turn-approval-away .taa-head")].map((el) => (el.innerText || "").replace(/\s+/g, " ").trim()),
      allApprovalBlocks: [...document.querySelectorAll(".job[data-thread] .turn-approval")].length,
      allApprovalTraces: [...document.querySelectorAll(".job[data-thread] .turn-approval-done.is-trace")].length,
      pinned: Boolean(job.querySelector(".pinned-turns")),
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
    // `extra` exists for the stub turns below: the panel refuses a second worker in a tree a live run already holds
    // (lib/jobs.js, `heldTreeRefusal`), and this gate needs six turns on ONE thread to exercise the turn pager. Those
    // extra turns are stub turns, not workers - nothing runs in the tree - so they are created with `anchorCwd: false`,
    // the flag the panel already carries for a turn that is not working in a directory. The two clarify turns this
    // gate has always played are spawned exactly as before.
    const spawn = async (prompt = "probe: ask one clarify question", extra = {}) => {
      const r = await fetch(`${sandbox.base}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, cwd: repo, existing: true, thread, ...extra }),
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
    // The other park: the panel's own record of a flagged command, as the approval.request event wrote it.
    const waitApproval = async (id, ms = 30_000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const a = await page.evaluate((x) => state.jobs.get(x)?.approval || null, id);
        if (a) return a;
        await sleep(120);
      }
      return null;
    };
    // The turn a park belongs to, read from the card's own record rather than guessed from the newest one.
    const turnIdWithApproval = () =>
      page.evaluate((t) => conversations().find((c) => c.thread === t)?.turns.find((x) => x.approval)?.id || "", thread);

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
    // The fold book is NOT part of the card's signature, so a state-only change to it does not repaint the card: the
    // next job event is what draws the new shape. Clearing the cached signature makes this repaint the one that event
    // would have caused, so what is measured below is the shipped renderer drawing a frozen turn - not the class the
    // card was already wearing.
    const repaintCard = async () => {
      await page.evaluate((t) => {
        const el = document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
        if (el) delete el.dataset.sig;
        renderConversation(t);
      }, thread);
      await sleep(350);
    };
    await repaintCard();
    const frozen = await readCard(page, thread);
    out.phases.frozen = frozen;
    check("a frozen turn really is drawn as the snippet form", frozen.card && frozen.turns.some((c) => /compact/.test(c)), frozen.card ? frozen.turns.join(" | ") : "no card");
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

    // ---- (6) the approval box: drawn where the reader is, and not a detail of an open console (row #286) --------
    // The same stub, the same panel, the same page - a flagged command this time. Nothing presses the box: the panel's
    // choices post to the gateway and that is the reader's act, so the stub's POST list is asserted empty at the end.
    const setTurn = (turnId, open) =>
      page.evaluate(
        ({ t, id, o }) => {
          const conv = conversations().find((c) => c.thread === t);
          const turn = conv?.turns.find((x) => x.id === id);
          if (!turn) return false;
          wtTurnFold.unfreeze(state, turn, "");
          wtTurnFold.setOpen(state, turn, o);
          renderConversation(t);
          return true;
        },
        { t: thread, id: turnId, o: open },
      );
    // The reader is at the top of the board and stays there: no scroll of the harness's own, so a box below the fold
    // is one the panel left there.
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(250);
    const job3 = await spawn("probe: run one flagged command", { anchorCwd: false });
    await reveal();
    const rec3 = await waitApproval(job3);
    out.phases.record3 = rec3
      ? { requestId: rec3.requestId, command: rec3.command, choices: rec3.choices, deadline: Boolean(rec3.deadline), timeoutSeconds: rec3.timeoutSeconds, at: rec3.at }
      : null;
    check("a real approval.request parks a turn on the panel's own record", Boolean(rec3), rec3 ? `request ${rec3.requestId}` : "no approval");
    check("...carrying the command it asked to run", Boolean(rec3) && rec3.command === APPROVAL_COMMAND, rec3 ? String(rec3.command).slice(0, 60) : "no approval");
    check("...and every choice the host allowed", Boolean(rec3) && Array.isArray(rec3.choices) && rec3.choices.length === APPROVAL_CHOICES.length, rec3 ? JSON.stringify(rec3.choices) : "no approval");

    await sleep(900);
    const arrived3 = await readCard(page, thread);
    out.phases.approvalArrived = arrived3;
    const box3 = arrived3.card ? arrived3.approvals[0] || null : null;
    const aid = await turnIdWithApproval();
    out.phases.approvalTurn = { id: aid, turns: arrived3.turns };
    check("the turn output holds the approval box", Boolean(box3) && arrived3.approvals.length === 1, arrived3.card ? `${arrived3.approvals.length} box(es)` : "no card");
    check("...with the command in it, byte for byte", Boolean(box3) && box3.command === APPROVAL_COMMAND, box3 ? box3.command.slice(0, 70) : "no box");
    check(
      "...with every choice drawn, and every press still addressed to the gateway",
      Boolean(box3) && box3.choices.length === APPROVAL_CHOICES.length && box3.choices.every((c) => c.request),
      box3 ? JSON.stringify(box3.choices.map((c) => `${c.choice}:${c.request}`)) : "no box",
    );
    check("exactly one approval box for this request in the document", arrived3.card && arrived3.allApprovalBlocks === 1, arrived3.card ? `${arrived3.allApprovalBlocks} in the document` : "no card");
    // THE BASE BUILD'S SECOND FAULT: arriving below the fold, with only the header's badge and the dock's corner
    // saying anything. The harness never scrolls; the panel's own landing is what puts it in view.
    check("the box is in the viewport when it arrives, without the reader hunting for it", Boolean(box3) && box3.inViewport && box3.visible, box3 ? `rect ${JSON.stringify(box3.rect)} at scroll ${arrived3.scroll?.y}` : "no box");
    await page.screenshot({ path: path.join(OUT, "4-approval-arrived.png") }).catch(() => {});

    // ...and the fold does not take it away (the base build's first fault: ZERO boxes on a folded turn).
    await setTurn(aid, false);
    await sleep(450);
    const folded3 = await readCard(page, thread);
    out.phases.approvalFolded = folded3;
    check("a turn the reader folded still reads as folded", folded3.card && folded3.turns.some((c) => /folded/.test(c)), folded3.card ? folded3.turns.join(" | ") : "no card");
    check("...and still carries the approval box", folded3.card && folded3.approvals.length === 1, folded3.card ? `${folded3.approvals.length} box(es)` : "no card");
    check("...with the command and every choice still drawn", Boolean(folded3.approvals?.[0]) && folded3.approvals[0].command === APPROVAL_COMMAND && folded3.approvals[0].choices.length === APPROVAL_CHOICES.length, folded3.approvals?.[0] ? `${folded3.approvals[0].choices.length} choice(s)` : "no box");
    await page.screenshot({ path: path.join(OUT, "5-approval-folded.png") }).catch(() => {});

    // the frozen form is the other way a reader closes a turn
    await page.evaluate(
      ({ t, id }) => {
        const conv = conversations().find((c) => c.thread === t);
        const turn = conv?.turns.find((x) => x.id === id);
        if (!turn) return;
        wtTurnFold.freeze(state, turn, "");
        wtTurnFold.setOpen(state, turn, false);
        renderConversation(t);
      },
      { t: thread, id: aid },
    );
    await repaintCard();
    const frozen3 = await readCard(page, thread);
    out.phases.approvalFrozen = frozen3;
    check("a frozen turn really is drawn as the snippet form", frozen3.card && frozen3.turns.some((c) => /compact/.test(c)), frozen3.card ? frozen3.turns.join(" | ") : "no card");
    check("a turn frozen to a snippet still carries the whole approval box", frozen3.card && frozen3.approvals.length === 1 && frozen3.approvals[0].choices.length === APPROVAL_CHOICES.length, frozen3.card ? `${frozen3.approvals.length} box(es)` : "no card");
    await page.screenshot({ path: path.join(OUT, "6-approval-frozen.png") }).catch(() => {});

    // The block's guard is turnLive, and turnLive counts an open approval: a status that leaves the running set must
    // not empty the block. Read in the same frame as the repaint, before the next poll puts the status back.
    const statusGuard = await page.evaluate(
      ({ t, id }) => {
        const conv = conversations().find((c) => c.thread === t);
        const turn = conv?.turns.find((x) => x.id === id);
        if (!turn) return null;
        turn.status = "done";
        renderConversation(t);
        const job = document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
        return { live: turnLive(turn), boxes: job ? job.querySelectorAll(".turn-approval").length : -1 };
      },
      { t: thread, id: aid },
    );
    out.phases.statusGuard = statusGuard;
    check("turnLive still counts an open approval", Boolean(statusGuard) && statusGuard.live === true, statusGuard ? `live ${statusGuard.live}` : "no record");
    check("...so a status outside the running set does not empty its block", Boolean(statusGuard) && statusGuard.boxes === 1, statusGuard ? `${statusGuard.boxes} box(es)` : "no record");

    // ---- (7) ONE PLACE: the pager, the pinned copy, and the off-page block --------------------------------------
    // Three more turns push the approval onto the older page (6 turns, 5 a page). The box must then be drawn once,
    // by whichever copy is actually showing - never twice, never nowhere.
    for (let i = 0; i < 3; i += 1) await spawn(`probe: plain turn ${i + 1}`, { anchorCwd: false });
    await sleep(900);
    await reveal();
    const paged = await page.evaluate(
      (t) => {
        const conv = conversations().find((c) => c.thread === t);
        if (!conv) return null;
        wtTurnFold.setOffset(state, t, 1);
        renderConversation(t);
        const r = wtTurnFold.range(conv.turns.length, 1);
        return { turns: conv.turns.length, start: r.start, end: r.end, pages: r.pages };
      },
      thread,
    );
    out.phases.paged = paged;
    await sleep(400);
    const away = await readCard(page, thread);
    out.phases.approvalAway = away;
    check("the reader is on a page that does not hold the park", Boolean(paged) && paged.turns > 5 && paged.end <= 2, paged ? `${paged.turns} turns, page ${paged.start + 1}-${paged.end} of ${paged.pages}` : "no conversation");
    check("...and the box is still drawn, at the top of the card, naming the turn", Boolean(away.approvals?.[0]) && away.approvals.length === 1 && away.approvals[0].inAway, away.card ? `${away.approvals.length} box(es), away ${away.approvals[0]?.inAway}` : "no card");
    check("...which is the only copy in the document", away.card && away.allApprovalBlocks === 1, away.card ? `${away.allApprovalBlocks}` : "no card");
    await page.screenshot({ path: path.join(OUT, "7-approval-away.png") }).catch(() => {});

    // Pinned instead: the pinned copy draws it and the off-page block stops drawing a second one.
    await page.evaluate(
      ({ t, id }) => {
        state.pinnedTurns.add(id);
        renderConversation(t);
      },
      { t: thread, id: aid },
    );
    await sleep(400);
    const pinnedAway = await readCard(page, thread);
    out.phases.approvalPinnedAway = pinnedAway;
    check("a pinned turn off the page draws the box in its pinned copy", Boolean(pinnedAway.approvals?.[0]) && pinnedAway.approvals.length === 1 && pinnedAway.approvals[0].inPinned, pinnedAway.card ? `${pinnedAway.approvals.length} box(es), pinned ${pinnedAway.approvals[0]?.inPinned}` : "no card");
    check("...and the off-page block does not draw a second one", pinnedAway.card && pinnedAway.approvals[0]?.inAway === false && pinnedAway.allApprovalBlocks === 1, pinnedAway.card ? `away ${pinnedAway.approvals[0]?.inAway}, ${pinnedAway.allApprovalBlocks} total` : "no card");
    await page.evaluate(
      ({ t, id }) => {
        state.pinnedTurns.delete(id);
        wtTurnFold.setOffset(state, t, 0);
        renderConversation(t);
      },
      { t: thread, id: aid },
    );
    await sleep(300);

    // ---- (8) the dock is still the other surface, and it still draws its own card ------------------------------
    // The panel's dock reads a different record (`state.approvals`, fed by the approval transport). It is not answered
    // here either - the check is that this row's change to the card did not take the dock's own box away.
    await page.evaluate((command) => {
      state.approvals.set("ap-dock-1", {
        id: "ap-dock-1",
        thread: "clarify-pane",
        surface: "agent",
        command,
        allowed: ["once", "deny"],
        deadline: Date.now() + 300_000,
      });
      renderApprovals();
    }, `rm -rf ${OUTSIDE}/build-cache`);
    await sleep(200);
    const dock = await page.evaluate(() => {
      const list = document.getElementById("approval-list");
      const cards = [...(list ? list.querySelectorAll(".approval") : [])];
      return {
        cards: cards.length,
        command: cards[0]?.querySelector(".ap-cmd")?.innerText || "",
        buttons: cards[0] ? [...cards[0].querySelectorAll("[data-approval-choice]")].map((b) => b.dataset.approvalChoice) : [],
        head: document.getElementById("approval-head")?.textContent || "",
      };
    });
    out.phases.dock = dock;
    check("the dock still draws an approval of its own", dock.cards === 1, `${dock.cards} card(s)`);
    check("...with the command and both choices", dock.command.includes("build-cache") && dock.buttons.length === 2, `${dock.command} / ${JSON.stringify(dock.buttons)}`);
    check("...under the head that counts it", /waiting on you/.test(dock.head), dock.head);
    await page.screenshot({ path: path.join(OUT, "8-dock.png") }).catch(() => {});
    await page.evaluate(() => {
      state.approvals.delete("ap-dock-1");
      renderApprovals();
    });

    // ---- (9) an approval that expires keeps what it asked ------------------------------------------------------
    // The window is the gateway's own one second; the panel's sweep is what takes the box away and writes the record.
    // The turn is folded first, so the trace is measured in the shape that used to lose it.
    const job4 = await spawn("probe: a command nobody answers", { anchorCwd: false });
    await reveal();
    const rec4 = await waitApproval(job4);
    out.phases.record4 = rec4 ? { requestId: rec4.requestId, command: rec4.command, choices: rec4.choices, window: rec4.timeoutSeconds, deadline: rec4.deadline } : null;
    check("the second approval carries the gateway's own one-second window", Boolean(rec4) && Number(rec4.timeoutSeconds) === 1, rec4 ? `${rec4.timeoutSeconds}s` : "no approval");
    const aid2 = await page.evaluate(() => conversations().find((c) => c.thread === "clarify-pane")?.turns.find((x) => x.approval?.command === "git push --force origin main")?.id || "");
    await setTurn(aid2, false);
    await sleep(300);
    // The sweep writes `approvalDone` on its own clock; nothing here expires the record by hand.
    let expired = null;
    const expAt = Date.now();
    while (Date.now() - expAt < 25_000) {
      const rec = await page.evaluate((id) => state.jobs.get(id)?.approvalDone || null, job4);
      if (rec?.expired) {
        expired = rec;
        break;
      }
      await sleep(250);
    }
    out.phases.expired = expired;
    check("the panel's own sweep records the approval as unanswered", Boolean(expired?.expired), expired ? `reason ${expired.reason}` : "still parked");
    check("...keeping the command it asked to run", Boolean(expired) && expired.command === APPROVAL_2_COMMAND, expired ? String(expired.command).slice(0, 60) : "no record");
    check("...keeping the choices it offered", Boolean(expired) && Array.isArray(expired.choices) && expired.choices.length === APPROVAL_2_CHOICES.length, expired ? JSON.stringify(expired.choices) : "no record");
    await sleep(500);
    const traced2 = await readCard(page, thread);
    out.phases.approvalExpired = traced2;
    const trace2 = traced2.approvalTraces?.[0] || null;
    check("a folded turn draws the expired approval as a trace", Boolean(trace2), traced2.card ? `${traced2.approvalTraces.length} trace(s)` : "no card");
    check("...naming what was asked, byte for byte", Boolean(trace2) && trace2.command === APPROVAL_2_COMMAND, trace2 ? trace2.command.slice(0, 60) : "no trace");
    check("...with every choice it offered still readable", Boolean(trace2) && trace2.choices.length === APPROVAL_2_CHOICES.length, trace2 ? JSON.stringify(trace2.choices) : "no trace");
    check("...saying nobody answered rather than reading as a decision", Boolean(trace2) && /not answered|too late/.test(trace2.head), trace2 ? trace2.head : "no trace");
    check("...and offering no control on a wait that is over", Boolean(trace2) && trace2.buttons === 0, trace2 ? `${trace2.buttons} button(s)` : "no trace");
    await page.screenshot({ path: path.join(OUT, "9-approval-expired.png") }).catch(() => {});

    // ---- (10) a reload draws both parks again ----------------------------------------------------------------
    // The page comes back with no fold book and no pins: every turn but the newest is folded, which is exactly the
    // shape the base build lost both blocks in.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.jobs && state.jobs.size > 0, null, { timeout: 30_000 });
    await reveal();
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(1200);
    const reloaded = await readCard(page, thread);
    out.phases.reloaded = reloaded;
    check("after a reload the approval still parks on a turn", await page.evaluate((id) => Boolean(state.jobs.get(id)?.approval), job3), "");
    check("...and its box is drawn on the folded turn", reloaded.card && reloaded.approvals.length === 1, reloaded.card ? `${reloaded.approvals?.length} box(es)` : "no card");
    check("...with the command and choices intact", Boolean(reloaded.approvals?.[0]) && reloaded.approvals[0].command === APPROVAL_COMMAND && reloaded.approvals[0].choices.length === APPROVAL_CHOICES.length, reloaded.approvals?.[0] ? `${reloaded.approvals[0].choices.length} choice(s)` : "no box");
    check("...and the expired approval's trace is drawn too", Boolean(reloaded.approvalTraces?.[0]) && reloaded.approvalTraces[0].command === APPROVAL_2_COMMAND, reloaded.card ? `${reloaded.approvalTraces?.length} trace(s)` : "no card");
    await page.screenshot({ path: path.join(OUT, "10-reload.png") }).catch(() => {});
    // Nothing in this run answered an approval: the panel links to the gateway, and the harness never presses it.
    check("no approval was answered from the panel by this run", gw.approvalPosts.length === 0, `${gw.approvalPosts.length} POST(s)`);

    // ---- the shipped renderer says what the gate claims --------------------------------------------------------
    // The page half is the one that loses a card, so its rule is read from the source too: the question block is part of
    // the TURN BLOCK in every shape the turn takes (not of the open turn's body), and a pinned copy is not a second
    // answer surface for a question its own turn is already drawing.
    const jobsSrc = readFileSync(path.join(TREE, "public", "render-jobs.js"), "utf8");
    const blockSrc = sliceBetween(jobsSrc, "function turnBlock(", "function conversationHtml(");
    const bodySrc = sliceBetween(jobsSrc, "function turnBody(", "function conversationTaskLink(");
    const shapes = occurrences(blockSrc, "${ask}");
    check("turnBlock draws the question block in every shape of a turn (open, folded, frozen)", shapes === 3, `${shapes} of 3 shapes carry it`);
    check("...and the open turn's body no longer draws a second copy", !/questionPrompt\(/.test(bodySrc), "");
    const convSrc = sliceBetween(jobsSrc, "function conversationHtml(", "function jobHtml(");
    check(
      "one block per question: the pinned and off-page copies take it only where the turn is not drawn",
      /const away = turns\.filter\(\(t\) => t\.question && !t\.questionDone && !pageIds\.has\(t\.id\) && !pinnedIds\.has\(t\.id\)\)/.test(convSrc) &&
        /pageIds\.has\(t\.id\) \? "" : askFor\(t, wtTurnFold\.PIN\)/.test(convSrc),
      `${occurrences(convSrc, "questionPrompt(")} renderer(s): the page copy, the off-page block`,
    );
    // The approval's half of the same rule (row #286): the box rides every shape of the turn, the open body no longer
    // draws one, and conversationHtml is where its one place is decided.
    const parks = occurrences(blockSrc, "${park}");
    check("turnBlock draws the approval box in every shape of a turn (open, folded, frozen)", parks === 3, `${parks} of 3 shapes carry it`);
    check("...and the open turn's body no longer draws a second copy", !/approvalPrompt\(/.test(bodySrc) && !/approvalDecided\(/.test(bodySrc), "");
    check(
      "one block per approval: the pinned and off-page copies take it only where the turn is not drawn",
      /const approvalsAway = turns\.filter\(\(t\) => t\.approval && !pageIds\.has\(t\.id\) && !pinnedIds\.has\(t\.id\)\)/.test(convSrc) &&
        /pageIds\.has\(t\.id\) \? "" : parkFor\(t, wtTurnFold\.PIN\)/.test(convSrc),
      `${occurrences(convSrc, "parkFor(")} renderer(s): the page copy, the pinned copy, the off-page block`,
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
