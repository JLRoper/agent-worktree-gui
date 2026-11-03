// The HUMAN button: every open permission and clarify question on the board, in one rotation.
//
//   node tools/verify-human-button.mjs                    # this checkout
//   node tools/verify-human-button.mjs --root <export>     # serve a `git archive` of another build (RED PROOF)
//   node tools/verify-human-button.mjs --keep              # leave the sandbox on disk
//
// THE BRIEF. NOT-RUNNING steps through agents that are not running; a permission or a clarify question can sit on an
// agent that IS running, and those are the ones the reader kept missing. HUMAN is the second rotation: one button
// beside NOT-RUNNING, a red count of everything waiting on a human, and a press (or H) that opens the next question —
// project and row unfolded, the turn that owns it unfolded and paged in, the prompt centred and flashed, its answer
// control focused. A question that is answered, times out or whose turn ends drops out of the list, and a press that
// lands on one which vanished between the sample and the paint steps on instead of opening a dead card.
//
// WHAT IS DRIVEN, against a real panel of its own (its own PANEL_CONFIG, port and jobs store), a stub Runs API on an
// ephemeral port, and headless Chromium over the page it serves. Nothing here fabricates page state: the two clarify
// questions and the approval arrive the way they do in life — a real run is started through POST /api/agents/reply,
// the stub streams `clarify.request` / `approval.request` on that run's own event stream, and the answers below are
// real POSTs back through the panel to the stub. Backboard order, then:
//   1. the control and its count — the button sits immediately beside NOT-RUNNING, the badge is the number of open
//      questions and is red, and the title splits them into permissions and clarify questions with the agents named;
//   2. list built from live state — the page's own `humanQuestions()` names exactly the three open questions and
//      nothing from the settled fourth agent;
//   3. one press opens the agent — a question on a worktree row that was collapsed unfolds the project and the row,
//      and a card paged back with its own pager is paged forward to the turn that owns the question; the prompt's
//      centre is in the middle of the window, the box wears the red flash and the card the amber one (the
//      NOT-RUNNING stepper's own), and a permission box leaves DENY under the caret, never Allow;
//   4. cycling wraps — presses visit every open question exactly once and the next returns to the first;
//   5. H is the same press — and it is INERT inside a textarea, an input and a contenteditable, where the keystroke
//      belongs to the reader;
//   6. a vanished question is dropped — answering one really closes its box and lowers the count, and the next press
//      skips it (including the direct case: `humanShow()` refuses the stale entry);
//   7. the dock's own permission card joins the rotation — a parked remote write raises the count, is reachable by
//      pressing H, and unfolds the dock;
//   8. zero is quiet — every question answered or denied leaves no badge, a plain HUMAN label, and a press that says
//      nothing is waiting instead of doing nothing.
//
// THE RED PROOF is `--root` against a `git archive` of the base (0.81.0): there is no #btn-human at all, so every
// check fails; the harness itself still runs, because it takes the panel kit and the browser helper from the tree it
// serves. An export needs its own one-commit repository (server.js reads `git rev-parse` at boot).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const KEEP = argv.includes("--keep");

const { startPanel, waitFor } = await import(pathToFileURL(path.join(TREE, "tools", "panel-testkit.mjs")).href);
const { loadPlaywright, notRun, withBrowser, openPage } = await import(pathToFileURL(path.join(TREE, "tools", "browser.mjs")).href);

let checks = 0;
let failures = 0;
const check = (label, got, want) => {
  checks += 1;
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${pass ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (label, cond, detail = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${label}${detail ? `: ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};
const note = (text) => console.log(`      ${text}`);
const section = (name) => console.log(`\n-- ${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the stub gateway -------------------------------------------------------------------------------------------
// Exactly what lib/jobs.js asks of a real one, plus the one thing this gate needs: a SCRIPT per run. Submission N
// streams the event that parks it (an approval for the first, a clarify question for the others), then holds the
// stream open — a parked run is still a live run, and a stub that closed the stream would settle the turn.
const REQUEST_ID = "human-req-1";
const QUESTION = "Which base should this branch use?";
const CHOICES = ["main (Recommended)", "develop"];
const APPROVAL_COMMAND = "git push origin feat/human";

function makeStub(scripts) {
  const seen = { submitted: [], events: [], approvals: [], answers: [] };
  const timers = new Set();
  const json = (res, code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          resolve(JSON.parse(raw || "{}"));
        } catch {
          resolve({});
        }
      });
    });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/v1/capabilities") {
      return json(res, 200, {
        version: "human-button-stub",
        features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true },
      });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      seen.submitted.push(await readBody(req));
      return json(res, 200, { run_id: `stub-run-${seen.submitted.length}`, status: "running" });
    }
    const m = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const sub = m[2] || "";
      const script = scripts[id];
      if (sub === "/approval") {
        seen.approvals.push({ id, ...(await readBody(req)) });
        return json(res, 200, { ok: true, resolved: 1 });
      }
      if (sub === "/clarify") {
        seen.answers.push({ id, ...(await readBody(req)) });
        return json(res, 200, { ok: true, run_id: id });
      }
      if (sub === "/steer") {
        await readBody(req);
        return json(res, 200, { accepted: true, run_id: id });
      }
      if (sub === "/stop") return json(res, 200, { ok: true });
      if (sub === "/events") {
        if (!script) return json(res, 404, { error: { message: "no such run" } });
        seen.events.push(id);
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": attached\n\n");
        const park = setTimeout(() => {
          timers.delete(park);
          try {
            // The event NAME rides inside the JSON as well as on the `event:` line: lib/jobs.js reads `data:` only
            // (frameEvent) and dispatches on `evt.event`.
            const payload = { event: script.event, ...script.payload, timestamp: Math.floor(Date.now() / 1000) };
            res.write(`event: ${script.event}\ndata: ${JSON.stringify(payload)}\n\n`);
          } catch {
            /* the listener went away with the panel */
          }
        }, 250);
        timers.add(park);
        const hold = setInterval(() => {
          try {
            res.write(": hold\n\n");
          } catch {
            clearInterval(hold);
            timers.delete(hold);
          }
        }, 500);
        timers.add(hold);
        req.on("close", () => {
          clearInterval(hold);
          clearTimeout(park);
          timers.delete(hold);
          timers.delete(park);
        });
        return;
      }
      // A GET of the run: pending_controls names the parked prompt, which is where the panel resolves a request id
      // the event did not carry.
      if (!script) return json(res, 404, { error: { message: "no such run" } });
      return json(res, 200, {
        run_id: id,
        status: "running",
        pending_controls: [{ kind: script.pendingKind, prompt_id: REQUEST_ID, [script.pendingKind === "clarify" ? "question" : "command"]: script.pendingText }],
      });
    }
    json(res, 404, { error: { message: "not found" } });
  });
  return {
    seen,
    server,
    close: () =>
      new Promise((r) => {
        for (const t of timers) {
          clearInterval(t);
          clearTimeout(t);
        }
        timers.clear();
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

// Everything this file reads comes from the painted page, never from a copy of the fixture.
const read = (page) =>
  page.evaluate(() => {
    const btn = document.getElementById("btn-human");
    const badge = document.getElementById("human-badge");
    const label = document.getElementById("human-label");
    const box = document.querySelector(".turn-approval.human-flash, .turn-question.human-flash");
    const rect = box ? box.getBoundingClientRect() : null;
    const list = typeof humanQuestions === "function" ? humanQuestions() : [];
    const active = document.activeElement;
    const project = document.querySelector('section.project[data-project="demo"]');
    const card = box?.closest(".job") || null;
    return {
      present: Boolean(btn),
      besideHot: Boolean(btn && btn.previousElementSibling && btn.previousElementSibling.id === "btn-hot"),
      label: label ? label.textContent : null,
      badgeHidden: badge ? badge.hidden : null,
      badgeText: badge ? badge.textContent : null,
      badgeBg: badge ? getComputedStyle(badge).backgroundColor : null,
      title: btn ? btn.title : null,
      hasQuestions: btn ? btn.classList.contains("has-questions") : null,
      listLength: list.length,
      keys: list.map((q) => q.key),
      kinds: list.map((q) => q.kind),
      flash: box
        ? {
            cls: box.className,
            kind: box.classList.contains("turn-question") ? "question" : "approval",
            thread: card?.dataset.thread || null,
            turnId: box.closest(".turn")?.dataset.turn || null,
            text: box.textContent.replace(/\s+/g, " ").trim().slice(0, 90),
            centreY: rect ? Math.round(rect.top + rect.height / 2) : null,
            viewportH: window.innerHeight,
            turnFolded: Boolean(box.closest(".turn")?.classList.contains("folded")),
            cardHot: Boolean(card?.classList.contains("hot-flash")),
          }
        : null,
      focus: active
        ? { tag: active.tagName.toLowerCase(), choice: active.dataset?.choice || null, value: active.dataset?.qvalue || null }
        : null,
      dockFolded: document.getElementById("approvals")?.classList.contains("is-folded") ?? null,
      projectOpen: project ? !project.hidden : false,
      page: card && box ? state.turnPage.get(card.dataset.thread) ?? 0 : null,
      banner: (document.getElementById("banner-text") || {}).textContent || "",
    };
  });

const pressHuman = async (page, { key = false } = {}) => {
  if (key) await page.keyboard.press("h");
  else await page.click("#btn-human");
  await sleep(120);
  // The scroll is smooth, so wait for the box to stop moving before anything measures its centre. Two equal samples
  // a beat apart, bounded: a hop that does not scroll still settles at once.
  let last = null;
  for (let i = 0; i < 12; i++) {
    const y = await page.evaluate(() => {
      const box = document.querySelector(".turn-approval.human-flash, .turn-question.human-flash");
      if (!box) return null;
      const r = box.getBoundingClientRect();
      return Math.round(r.top + r.height / 2);
    });
    if (y !== null && y === last) break;
    last = y;
    await sleep(100);
  }
};

// Press until the flash lands on the question the predicate names (bounded), so a check never depends on which
// thread the board's own order happened to put first.
async function pressUntil(page, predicate, { tries = 6, key = false } = {}) {
  for (let i = 0; i < tries; i++) {
    await pressHuman(page, { key });
    const now = await read(page);
    if (predicate(now)) return now;
  }
  return await read(page);
}

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the HUMAN button", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
    process.exit(2);
  }
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-human-"));
  const repos = path.join(dir, "repos");
  const repo = path.join(repos, "demo");
  const cwdFor = (name) => {
    const d = path.join(dir, "cwd", name);
    mkdirSync(d, { recursive: true });
    execFileSync("git", ["-C", d, "init", "-q", "-b", "main"], { encoding: "utf8", windowsHide: true });
    writeFileSync(path.join(d, "README.md"), `# ${name}\n`);
    execFileSync("git", ["-C", d, "add", "."], { encoding: "utf8", windowsHide: true });
    execFileSync("git", ["-C", d, "-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "seed"], {
      encoding: "utf8",
      windowsHide: true,
    });
    return d;
  };
  mkdirSync(path.join(repo, ".worktrees"), { recursive: true });
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  const empty = path.join(dir, "empty");
  mkdirSync(empty, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "HUMAN gate");
  git("config", "user.email", "human-gate@example.invalid");
  writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  const repoPath = repo.replace(/\\/g, "/");
  const homelessCwd = cwdFor("homeless").replace(/\\/g, "/");

  // ---- the seeded turns ------------------------------------------------------------------------------------
  // Three threads, each with settled turns only: the questions below are then started for real, so every state the
  // page reads (a live turn, its approval, its clarify prompt) is the panel's own. th-ask gets SIX settled turns so
  // the live seventh lands on a card with a pager — which is how the gate proves the question's turn is paged in.
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const seed = (id, thread, turn, at, extra = {}) => ({
    id,
    thread,
    turn,
    prompt: `settled turn ${turn}`,
    cwd: extra.cwd || repoPath,
    ownerPath: extra.ownerPath === undefined ? repoPath : extra.ownerPath,
    projectPath: extra.projectPath === undefined ? repoPath : extra.projectPath,
    sessionId: thread,
    status: "done",
    exitCode: 0,
    startedAt: iso(at),
    endedAt: iso(at + 30_000),
    runId: `run_seed_${id}`,
    worktree: false,
    existing: false,
    worktreePath: null,
    branch: null,
    lines: [{ kind: "out", lid: 1, at: at + 29_000, text: "done — nothing left in this turn." }],
    finalMessage: "done — nothing left in this turn.",
  });
  const jobs = [
    seed("seed-approve", "th-approve", 1, now - 40 * 60_000),
    seed("seed-homeless", "th-homeless", 1, now - 35 * 60_000, { cwd: homelessCwd, ownerPath: null, projectPath: null }),
    seed("seed-quiet", "th-quiet", 1, now - 30 * 60_000),
  ];
  for (let i = 1; i <= 6; i++) jobs.push(seed(`seed-ask-${i}`, "th-ask", i, now - (30 - i) * 60_000));
  writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify({ savedAt: iso(now), jobs }), "utf8");

  const stub = makeStub({
    "stub-run-1": {
      event: "approval.request",
      payload: { request_id: REQUEST_ID, command: APPROVAL_COMMAND, choices: ["once", "deny"], timeout_seconds: 600 },
      pendingKind: "approval",
      pendingText: APPROVAL_COMMAND,
    },
    "stub-run-2": {
      event: "clarify.request",
      payload: { prompt_id: REQUEST_ID, question: QUESTION, choices: CHOICES, multi_select: false, timeout_s: 600 },
      pendingKind: "clarify",
      pendingText: `Which base should this branch use?\n\nReply "skip" to skip this question.`,
    },
    "stub-run-3": {
      event: "clarify.request",
      payload: { prompt_id: REQUEST_ID, question: "Should this branch be landed now?", choices: ["Yes", "Not yet"], multi_select: false, timeout_s: 600 },
      pendingKind: "clarify",
      pendingText: "Should this branch be landed now?",
    },
  });
  await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
  const stubUrl = `http://127.0.0.1:${stub.server.address().port}`;

  const panel = await startPanel({
    dir,
    root: TREE,
    config: {
      scanRoots: [empty],
      projects: [{ name: "demo", path: repoPath, mainBranch: "main" }],
      refreshSeconds: 3600,
      worktreeSeconds: 3600,
      midSeconds: 3600,
      dormantSeconds: 3600,
      slowSeconds: 3600,
      fetchSeconds: -1,
      discoverSeconds: 3600,
      threads: 1,
      defaultCwd: repoPath,
      assistant: { enabled: false },
      apiServer: { url: stubUrl, key: "sandbox-key" },
    },
  });

  const POST = async (route, body) => {
    const r = await fetch(`${panel.base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const jobsNow = async () => (await (await fetch(`${panel.base}/api/jobs`)).json()).jobs || [];

  try {
    console.log(`sandbox: ${panel.base}`);
    console.log(`tree:    ${TREE}`);
    console.log(`stub:    ${stubUrl}`);

    // ---- three real runs, each parking on a question ------------------------------------------------------
    const started = [];
    for (const thread of ["th-approve", "th-ask", "th-homeless"]) {
      const reply = await POST("/api/agents/reply", { thread, text: "carry on until you need a decision" });
      started.push([thread, reply.status, Boolean(reply.body.job?.id)]);
    }
    check("three real runs are started against the stub", started.map((s) => s[1]), [202, 202, 202]);
    const parked = await waitFor(
      async () => {
        const all = await jobsNow();
        const approval = all.find((j) => j.thread === "th-approve" && j.approval?.requestId === REQUEST_ID);
        const ask = all.find((j) => j.thread === "th-ask" && j.question?.requestId === REQUEST_ID);
        const homeless = all.find((j) => j.thread === "th-homeless" && j.question?.requestId === REQUEST_ID);
        return approval && ask && homeless ? { approval, ask, homeless } : false;
      },
      { timeoutMs: 40_000, stepMs: 250, what: "the stub's approval.request and two clarify.request events" },
    );
    ok("the panel holds an approval and two clarify questions", Boolean(parked), parked ? `runs ${[parked.approval.runId, parked.ask.runId, parked.homeless.runId].join(", ")}` : "never arrived");
    if (!parked) {
      // Which link broke, said out loud: a submission the stub answered, a stream it never saw, or a run that
      // started and settled without the event. Without this the next reader debugs the harness by hand.
      const all = await jobsNow();
      note(`stub saw ${stub.seen.submitted.length} submission(s), ${stub.seen.events.length} event stream(s) [${stub.seen.events.join(", ")}]`);
      note(`jobs: ${JSON.stringify(all.map((j) => [j.id, j.thread, j.status, j.runId, Boolean(j.question), Boolean(j.approval), String(j.error || "").slice(0, 70)]))}`);
    }
    ok("the approval carries the command the stub asked about", parked?.approval?.approval?.command === APPROVAL_COMMAND, parked?.approval?.approval?.command);
    ok("the question carries every choice verbatim", JSON.stringify(parked?.ask?.question?.choices) === JSON.stringify(CHOICES), JSON.stringify(parked?.ask?.question?.choices));

    await withBrowser(
      async ({ page, pageErrors }) => {
        await page.setViewportSize({ width: 1280, height: 900 });
        await openPage(page, panel.base, { selector: "#health.ok" });
        // The red proof's first finding: a build without the control has nothing to drive. Said as a check rather
        // than left to a selector timeout, so `--root <base export>` reports a verdict instead of a stack.
        if ((await page.locator("#btn-human").count()) === 0) {
          ok("the HUMAN control exists on the board", false, "no #btn-human in this build's index.html");
          return;
        }
        await page.waitForSelector("#btn-human", { state: "attached", timeout: 20_000 });
        await waitFor(async () => (await read(page)).listLength === 3, { timeoutMs: 20_000, what: "three open questions" });
        await waitFor(async () => (await read(page)).badgeText === "3", { timeoutMs: 10_000, what: "the badge to count them" });

        // ---- 1. the control and its count ---------------------------------------------------------------
        section("1. the button and its red count");
        const first = await read(page);
        const hotTitle = await page.evaluate(() => document.getElementById("btn-hot").title);
        check("HUMAN is the control immediately after NOT-RUNNING", first.besideHot, true);
        ok("NOT-RUNNING is still its own control beside it", /NOT-RUNNING/.test(hotTitle), hotTitle.slice(0, 40));
        check("the label reads HUMAN while no question is being shown", first.label, "HUMAN");
        check("the badge is not hidden", first.badgeHidden, false);
        check("the badge counts every open question", first.badgeText, "3");
        check("the badge is red", first.badgeBg, "rgb(229, 83, 75)");
        check("the button wears the waiting look", first.hasQuestions, true);
        ok("the title splits permissions from clarify questions", /1 permission/.test(first.title) && /2 clarify questions/.test(first.title), first.title.slice(0, 150));
        ok("...and names the agents holding them", agentsInTitle(first.title, 2), first.title.slice(0, 240));

        // ---- 2. the list is the live state's ------------------------------------------------------------
        section("2. the list comes from live state");
        const live = await jobsNow();
        const latestOf = (thread) => live.filter((j) => j.thread === thread).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt))).pop();
        const runTurns = ["th-approve", "th-ask", "th-homeless"].map((t) => latestOf(t)?.id);
        check("three questions, one approval and two clarify prompts", [first.listLength, first.kinds.filter((k) => k !== "question").length], [3, 1]);
        ok(
          "every open question is keyed by its own carrier, and the settled agent is not one of them",
          ["approval", "question", "question"].every((k) => first.keys.some((key) => key.startsWith(`${k}:`))) &&
            first.keys.every((key) => runTurns.some((id) => key.split(":")[1] === id)) &&
            !first.keys.some((k) => k.startsWith("question:seed-")),
          JSON.stringify({ keys: first.keys, runTurns }),
        );
        check(
          "each entry names the LIVE turn that holds it",
          runTurns.map((id) => first.keys.some((key) => key.split(":")[1] === id)),
          [true, true, true],
        );

        // ---- 3. one press opens the agent, unfolds, pages in and centres --------------------------------
        section("3. a press opens the agent and centres the prompt");
          // The homeless card is in the page, above the table, so the board's own order puts it first.
        await pressHuman(page);
        const p1 = await read(page);
        check("press 1 lands on the unattached agent's question", [p1.flash?.thread, p1.flash?.kind], ["th-homeless", "question"]);
        ok("the prompt is flashed red", /human-flash/.test(p1.flash?.cls || ""), p1.flash?.cls);
        ok("the card wears the NOT-RUNNING amber ring too", p1.flash?.cardHot === true, String(p1.flash?.cardHot));
        ok(
          "the prompt's centre is in the middle of the window",
          Math.abs((p1.flash?.centreY ?? 0) - (p1.flash?.viewportH ?? 0) / 2) < 160,
          `centre ${p1.flash?.centreY} of ${p1.flash?.viewportH}`,
        );
        check("the clarify answer's first choice owns the caret", p1.focus, { tag: "button", choice: null, value: "Yes" });
        check("the counter now says where in the rotation you are", p1.label, "HUMAN 1/3");

        // The row-owned thread: its card is not in the page until the project and row are opened.
        const p2 = await pressUntil(page, (s) => s.flash?.thread === "th-approve");
        check("a press lands on the permission box on the demo row", [p2.flash?.thread, p2.flash?.kind], ["th-approve", "approval"]);
        ok("the project was opened for it", p2.projectOpen === true, String(p2.projectOpen));
        ok("the card is in the page (the row was unfolded)", await page.evaluate(() => Boolean(document.querySelector('.agents-block .job[data-thread="th-approve"]'))));
        check("a permission box focuses DENY, never Allow", p2.focus, { tag: "button", choice: "deny", value: null });
        ok("the prompt is centred here too", Math.abs((p2.flash?.centreY ?? 0) - (p2.flash?.viewportH ?? 0) / 2) < 160, `centre ${p2.flash?.centreY} of ${p2.flash?.viewportH}`);

        // The card with seven turns: page it BACK with its own pager, so the live turn is not on the shown page,
        // then press again — the rotation has to page the turn that owns the question back into view.
        const paged = await page.evaluate(() => {
          const card = document.querySelector('.job[data-thread="th-ask"]');
          const btn = card?.querySelector('.turn-pager [data-turn-page="older"]');
          if (!btn) return { pager: false, page: state.turnPage.get("th-ask") ?? 0 };
          if (!btn.disabled) btn.click();
          return { pager: true, page: state.turnPage.get("th-ask") ?? 0 };
        });
        ok("the seven-turn card has a pager that was used to page back", paged.pager === true, JSON.stringify(paged));
        const offPage = await page.evaluate((id) => Boolean(document.querySelector(`pre.job-out[data-out="${id}"]`)), runTurns[1]);
        check("the question's console is off the page before the press", offPage, false);
        const p3b = await pressUntil(page, (s) => s.flash?.thread === "th-ask");
        check("the next press pages the turn back in", [p3b.flash?.thread, p3b.page, p3b.flash?.turnFolded], ["th-ask", 0, false]);
        ok("its console is on the page with it", await page.evaluate((id) => Boolean(document.querySelector(`pre.job-out[data-out="${id}"]`)), p3b.flash?.turnId));
        ok("the question the stub asked is the box the reader is shown", /the agent is parked until you answer/.test(p3b.flash?.text || ""), p3b.flash?.text);
        check("the clarify answer's first choice owns the caret", p3b.focus, { tag: "button", choice: null, value: CHOICES[0] });

        // ---- 4. cycling wraps --------------------------------------------------------------------------
        section("4. cycling wraps");
        // From here the three questions are all drawable (the row is open), so three presses must visit all three
        // and the fourth must come back to this one.
        const seen = new Set();
        for (let i = 0; i < 3; i++) {
          const s = await read(page);
          if (s.flash) seen.add(`${s.flash.thread}:${s.flash.turnId}`);
          await pressHuman(page);
        }
        const afterLoop = await read(page);
        check("three presses visited the three different questions", seen.size, 3);
        check("the next press wrapped back to where it started", [afterLoop.flash?.thread, afterLoop.flash?.turnId], [p3b.flash?.thread, p3b.flash?.turnId]);

        // ---- 5. H is the same press, and is inert in a text field ---------------------------------------
        section("5. the H hotkey");
        await page.evaluate(() => document.activeElement && document.activeElement.blur());
        const h1 = await pressUntil(page, (s) => s.label !== afterLoop.label, { key: true, tries: 2 });
        ok("H advances exactly like the button", h1.label !== afterLoop.label, `${afterLoop.label} → ${h1.label}`);

        const typed = await page.evaluate(() => {
          const type = (el) => {
            document.body.appendChild(el);
            el.focus();
            return document.activeElement === el;
          };
          const area = document.createElement("textarea");
          const input = document.createElement("input");
          const editable = document.createElement("div");
          editable.setAttribute("contenteditable", "true");
          const focused = [type(area), type(input), type(editable)];
          window.__humanProbe = { area, input, editable };
          return { focused, active: document.activeElement === editable };
        });
        check("the three text-entry probes take the caret", typed.focused, [true, true, true]);
        const beforeType = await read(page);
        await page.keyboard.type("h");
        const afterType = await page.evaluate(() => ({
          editableText: window.__humanProbe.editable.textContent,
          label: document.getElementById("human-label").textContent,
        }));
        check("H typed into a contenteditable is the reader's letter, not a hop", afterType.editableText, "h");
        check("...and the rotation did not move", afterType.label, beforeType.label);
        // The same keystroke inside a card's reply box. th-quiet is a settled agent whose card is on the open row,
        // so nothing else about it is moving while the letter is typed.
        const boxFocus = await page.evaluate(() => {
          const box = document.querySelector('.job[data-thread="th-quiet"] .reply-box');
          if (!box) return null;
          box.focus();
          return document.activeElement === box;
        });
        ok("a card's reply box can hold the caret", boxFocus === true, String(boxFocus));
        await page.keyboard.type("h");
        const afterBox = await waitFor(
          async () => {
            const v = await page.evaluate(() => ({
              // The reply box is a contenteditable div (not a textarea), so its words are its own text.
              text: document.querySelector('.job[data-thread="th-quiet"] .reply-box')?.innerText ?? null,
              label: document.getElementById("human-label").textContent,
            }));
            // The card can be repainted under the box a moment after the keystroke: read again until the box is back.
            return v.text === "h" ? v : false;
          },
          { timeoutMs: 5_000, stepMs: 100, what: "the letter to stay in the reply box" },
        );
        check("H typed into a reply box stays in the box", afterBox.text, "h");
        check("...and still does not move the rotation", afterBox.label, beforeType.label);
        await page.evaluate(() => {
          window.__humanProbe.area.remove();
          window.__humanProbe.input.remove();
          window.__humanProbe.editable.remove();
          const box = document.querySelector('.job[data-thread="th-quiet"] .reply-box');
          if (box) box.textContent = "";
          document.activeElement?.blur();
        });

        // ---- 6. a vanished question is dropped ----------------------------------------------------------
        section("6. a question that goes away is dropped");
        // Walk to the unattached question, then ANSWER it for real: the choice button posts to the panel, the panel
        // posts to the stub, and the box and the count go together.
        const atHomeless = await pressUntil(page, (s) => s.flash?.thread === "th-homeless");
        check("the rotation reaches the unattached agent again", [atHomeless.flash?.thread, atHomeless.label], ["th-homeless", "HUMAN 1/3"]);
        const homelessJobId = (await jobsNow()).filter((j) => j.thread === "th-homeless").map((j) => j.id).pop();
        await page.click(`.job[data-thread="th-homeless"] .turn-question button.tq-choice[data-qvalue="Yes"]`);
        await waitFor(
          async () => {
            const s = await read(page);
            return s.listLength === 2 && s.badgeText === "2";
          },
          { timeoutMs: 15_000, what: "the count to drop to two" },
        );
        const gone = await read(page);
        check("the answered question is out of the count", gone.badgeText, "2");
        check("...and its box is gone from the page", await page.evaluate(() => Boolean(document.querySelector('.job[data-thread="th-homeless"] .turn-question'))), false);
        check("the answer really reached the stub", stub.seen.answers.some((a) => String(a.answer).includes("Yes")), true);
        check(
          "humanShow() refuses the stale entry instead of opening a dead card",
          await page.evaluate((id) => humanShow({ kind: "question", thread: "th-homeless", turnId: id, key: `question:${id}:${"human-req-1"}` }), homelessJobId),
          false,
        );
        await page.evaluate(() => document.activeElement?.blur());
        await pressHuman(page, { key: true });
        const skipped = await read(page);
        ok("the next H continues past the vanished one", skipped.flash?.thread !== "th-homeless", `${skipped.flash?.thread} · ${skipped.label}`);
        check("...with the count the page now holds", skipped.badgeText, "2");

        // ---- 7. the dock's own permission card joins the rotation ----------------------------------------
        section("7. the dock's permission card is in the rotation");
        const write = await POST("/api/remote-write/request", {
          worktree: repoPath,
          branch: "feat/human",
          remote: "origin",
          refs: "refs/heads/feat/human",
          remoteUrl: "probe",
        });
        const writeId = write.body.pending?.id || write.body.id || null;
        check("the panel parked a remote write", [write.status, Boolean(writeId)], [200, true]);
        await waitFor(async () => (await read(page)).badgeText === "3", { timeoutMs: 15_000, what: "the write in the count" });
        const withWrite = await read(page);
        ok("the count counts it as a permission", /2 permissions/.test(withWrite.title), withWrite.title.slice(0, 150));
        ok("the write is in the list", withWrite.keys.includes(`write:${writeId}`), JSON.stringify(withWrite.keys));
        let reached = null;
        for (let i = 0; i < 4 && !reached; i++) {
          await pressHuman(page, { key: true });
          const now = await read(page);
          if (now.flash?.cls.includes("turn-approval") && (await page.evaluate(() => Boolean(document.querySelector("#approval-list .turn-approval.human-flash"))))) reached = now;
        }
        ok("pressing H reaches the dock's card", Boolean(reached), reached ? `${reached.flash?.kind} · ${reached.label}` : "not reached");
        check("...with the dock unfolded", reached?.dockFolded, false);
        check("...focusing its DENY choice", await page.evaluate(() => document.activeElement?.dataset?.choice || null), "deny");
        const denied = await POST("/api/remote-write/answer", { id: writeId, choice: "deny", by: "reader" });
        check("the write can be denied", denied.status, 200);

        // ---- 8. zero is quiet ---------------------------------------------------------------------------
        section("8. nothing waiting is quiet");
        // The approval through the page's own DENY button (a real POST to the stub), and the last question by its
        // choice. Both close the box where they are, so the count reaching zero is the panel's own doing.
        const atApproval = await pressUntil(page, (s) => s.flash?.thread === "th-approve");
        if (atApproval.flash) await page.click('.job[data-thread="th-approve"] .turn-approval button[data-choice="deny"]');
        await waitFor(async () => (await read(page)).listLength <= 1, { timeoutMs: 15_000, what: "the approval to be answered" });
        check("the approval was answered through the panel", stub.seen.approvals.some((a) => a.choice === "deny"), true);
        const atAsk = await pressUntil(page, (s) => s.flash?.thread === "th-ask");
        if (atAsk.flash) await page.click(`.job[data-thread="th-ask"] .turn-question button.tq-choice[data-qvalue="${CHOICES[0]}"]`);
        await waitFor(
          async () => {
            const s = await read(page);
            return s.listLength === 0 && s.badgeHidden === true && s.label === "HUMAN";
          },
          { timeoutMs: 15_000, what: "an empty rotation with no badge" },
        );
        const zero = await read(page);
        check("no question leaves no badge", [zero.badgeHidden, zero.listLength], [true, 0]);
        check("the label is a plain HUMAN again", zero.label, "HUMAN");
        check("the waiting look is off", zero.hasQuestions, false);
        await pressHuman(page);
        const emptyPress = await read(page);
        ok("a press says nothing is waiting", /nothing is waiting/i.test(emptyPress.banner), emptyPress.banner);
        check("...and does not invent a question", emptyPress.listLength, 0);

        ok("no page error was thrown", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
      },
      { viewport: { width: 1280, height: 900 } },
    );
  } finally {
    await panel.stop();
    await stub.close();
    if (KEEP) note(`kept: ${dir}`);
    else rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }

  console.log(`\nRESULT: ${failures ? "FAIL" : "PASS"} — ${checks - failures}/${checks} checks`);
  process.exitCode = failures ? 1 : 0;
}

// The title names the agents holding the questions; the fixture's threads are the names the reader would see (the
// cards carry no session title), so the check is that at least two DIFFERENT thread names appear, not the exact ids.
function agentsInTitle(title, atLeast) {
  const named = [...String(title).matchAll(/held by ([^.]+)/g)].map((m) => m[1]).join(",");
  return named.split(",").map((s) => s.trim()).filter(Boolean).length >= atLeast;
}

main().catch((e) => {
  console.log(`\nRESULT: FAIL — the run did not complete: ${e && e.stack ? e.stack : e}`);
  process.exitCode = 1;
});
