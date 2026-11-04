// The HUMAN button: every open permission and clarify question on the board, in one rotation.
// HARNESS: LIVE GATE — it tracks main, and `npm run verify:human-button` is how the repo runs it by name.
//
//   node tools/verify-human-button.mjs                    # this checkout
//   node tools/verify-human-button.mjs --root <export>     # serve a `git archive` of another build (RED PROOF)
//   node tools/verify-human-button.mjs --keep              # leave the sandbox on disk
//
// THE BRIEF. A permission or a clarify question can sit on an agent that IS running, and those are the ones the
// reader kept missing. HUMAN is the rotation: one button in the header, a red count of everything waiting on a
// human, and a press (or H) that opens the next question —
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
//      nothing is waiting instead of doing nothing;
//   9. an ASSISTANT's own question is in the rotation — an assistant turn started through /api/assistant/say parks on
//      its own clarify prompt beside a board question, and one badge counts both. The press opens the FLOAT (it
//      starts shut), puts that assistant's Chat pane on screen, unfolds and pages in the turn holding the question,
//      centres the prompt in the float's own scroller, flashes it red and the card amber, and leaves the caret on its
//      first choice — then the same question's console is paged off and the next press pages it back;
//  10. a question whose TURN ends is dropped — the stub ends the run under an open question with the gateway's own
//      terminal event, and the next press steps on to the question that is still open instead of a dead float.
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
// Exactly what lib/jobs.js asks of a real one, plus the two things this gate needs: a SCRIPT per run, and a way to
// END a run on demand — a question whose TURN ends has to drop out of the rotation, and that is a real terminal
// event from the gateway, never a record quietly deleted from the store.
//
// A run is NAMED by the marker the panel put in its input ("GATE-APPROVE …"), not by the order it arrived in: the
// assistant is switched on in this sandbox — that is the thing under test — so its sentry may submit a wake of its
// own at any moment, and a counter would renumber every script behind it, failing the gate for a reason that is not
// in the panel. A submission with no marker still gets an id, and its script is a QUIET one that settles at once, so
// a stray wake can never park a question this gate would have to account for.
const REQUEST_ID = "human-req-1";
const QUESTION = "Which base should this branch use?";
const CHOICES = ["main (Recommended)", "develop"];
const APPROVAL_COMMAND = "git push origin feat/human";
// The assistant's own question: its own wording and its own choices, so a box on the board can never be mistaken
// for the one in the float.
const ASSISTANT_QUESTION = "Which queue should this assistant fold first?";
const ASSISTANT_CHOICES = ["The landed one (Recommended)", "The stalled one"];

function makeStub(scripts) {
  const seen = { submitted: [], events: [], approvals: [], answers: [], stray: [] };
  const timers = new Set();
  // The streams that are still open, so a press can end one the way a gateway ends a run it finishes.
  const live = new Map();
  // Runs this stub has ended: their GET must answer finished, or the panel's poll would read the parked prompt out
  // of `pending_controls` again and resurrect a question that is over.
  const settled = new Set();
  let strays = 0;
  // What a run with no script does: settles at once, drawing no question and no approval.
  const QUIET = { event: "run.completed", payload: { status: "completed", exit_code: 0, output: "settled by the stub" }, pendingKind: null, pendingText: "" };
  const runIdFor = (submission) => {
    // The LAST marker in the input, not the first: an assistant's turn carries a digest of the board in its
    // preamble, and that digest quotes the other agents' prompts — so the first GATE- marker in the text can be a
    // question this run is only reading about. The run's own prompt is the tail of the input.
    const text = String(submission?.input ?? submission?.prompt ?? "");
    const hits = [...text.matchAll(/\bGATE-([A-Z0-9-]+)/g)];
    const hit = hits.length ? hits[hits.length - 1] : null;
    if (hit) return `stub-${hit[1].toLowerCase()}`;
    strays += 1;
    const id = `stub-stray-${strays}`;
    seen.stray.push(id);
    return id;
  };
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
      const submission = await readBody(req);
      seen.submitted.push(submission);
      return json(res, 200, { run_id: runIdFor(submission), status: "running" });
    }
    // The gate's own lever: end this run now, with the terminal event a gateway sends when a turn is over.
    if (url.pathname.startsWith("/release/") && req.method === "POST") {
      const id = decodeURIComponent(url.pathname.slice("/release/".length));
      const held = live.get(id);
      if (!held) return json(res, 404, { error: `no live stream for ${id}` });
      settled.add(id);
      clearInterval(held.hold);
      clearTimeout(held.park);
      timers.delete(held.hold);
      timers.delete(held.park);
      live.delete(id);
      try {
        held.res.write(`event: run.completed\ndata: ${JSON.stringify({ event: "run.completed", status: "completed", exit_code: 0, output: "the turn ended" })}\n\n`);
        held.res.end();
      } catch {
        /* the listener went away with the panel */
      }
      return json(res, 200, { ok: true });
    }
    const m = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const sub = m[2] || "";
      const script = settled.has(id) ? QUIET : scripts[id] || QUIET;
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
        seen.events.push(id);
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": attached\n\n");
        if (script === QUIET || settled.has(id)) {
          // Already over: say so at once and close, so a late attach cannot hold a listen of its own.
          setTimeout(() => {
            try {
              res.write(`event: ${QUIET.event}\ndata: ${JSON.stringify({ event: QUIET.event, ...QUIET.payload })}\n\n`);
              res.end();
            } catch {
              /* gone */
            }
          }, 50);
          return;
        }
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
        live.set(id, { res, hold, park });
        req.on("close", () => {
          clearInterval(hold);
          clearTimeout(park);
          timers.delete(hold);
          timers.delete(park);
          live.delete(id);
        });
        return;
      }
      // A GET of the run: pending_controls names the parked prompt, which is where the panel resolves a request id
      // the event did not carry.
      if (settled.has(id) || !scripts[id]) {
        return json(res, 200, { run_id: id, status: "completed", exit_code: 0, output: "settled by the stub" });
      }
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
      besideAssistant: Boolean(btn && btn.previousElementSibling && btn.previousElementSibling.id === "btn-assistant"),
      label: label ? label.textContent : null,
      badgeHidden: badge ? badge.hidden : null,
      badgeText: badge ? badge.textContent : null,
      badgeBg: badge ? getComputedStyle(badge).backgroundColor : null,
      title: btn ? btn.title : null,
      hasQuestions: btn ? btn.classList.contains("has-questions") : null,
      listLength: list.length,
      keys: list.map((q) => q.key),
      kinds: list.map((q) => q.kind),
      // The instrumented dock feed: what `/api/state` put in `state.approvals`, beside the turn approvals the
      // rotation also reads. Zero here with an approval in `kinds` is the proof the run feed carried the prompt.
      approvalsCount: state.approvals.size,
      approvalsSeen: state.approvalsSeen,
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

// What the rotation did INSIDE the assistant's card, read off the painted page: the float's frame, which of its
// tabs is on screen, the box that carries the red ring, where that box sits in the float's OWN scroller, and the
// caret. Nothing here is a copy of the fixture — a box that is not drawn reads as null.
const readAssistant = (page) =>
  page.evaluate(() => {
    const el = document.getElementById("assistant");
    const box = document.querySelector("#assistant .turn-question.human-flash, #assistant .turn-approval.human-flash");
    const chat = document.getElementById("as-chat");
    const body = box?.closest(".as-subpane[data-subpane='chat'] > .job > .job-body") || null;
    const card = box?.closest(".job") || null;
    const rect = box ? box.getBoundingClientRect() : null;
    const bodyRect = body ? body.getBoundingClientRect() : null;
    const active = document.activeElement;
    let view = null;
    try {
      view = JSON.parse(localStorage.getItem("wm.assistantView") || "null");
    } catch {
      view = null;
    }
    return {
      floatOpen: Boolean(el) && !el.hidden,
      view,
      chatVisible: Boolean(chat) && !chat.classList.contains("hidden"),
      flash: box
        ? {
            kind: box.classList.contains("turn-question") ? "question" : "approval",
            cls: box.className,
            thread: card?.dataset.thread || null,
            turnId: box.closest(".turn")?.dataset.turn || null,
            folded: Boolean(box.closest(".turn")?.classList.contains("folded")),
            text: box.textContent.replace(/\s+/g, " ").trim().slice(0, 90),
          }
        : null,
      cardHot: Boolean(card?.classList.contains("hot-flash")),
      centreY: rect ? Math.round(rect.top + rect.height / 2) : null,
      bodyCentreY: bodyRect ? Math.round(bodyRect.top + bodyRect.height / 2) : null,
      bodyTop: bodyRect ? Math.round(bodyRect.top) : null,
      bodyBottom: bodyRect ? Math.round(bodyRect.bottom) : null,
      page: (() => {
        try {
          return state.turnPage.get("panel-assistant") ?? 0;
        } catch {
          return 0;
        }
      })(),
      focus: active ? { tag: active.tagName.toLowerCase(), value: active.dataset?.qvalue || active.dataset?.choice || null } : null,
      boxes: document.querySelectorAll("#as-chat .turn-question").length,
    };
  });

// Press until the flash lands inside the float on the turn the predicate names (bounded): the rotation may put the
// board's question first, and this is the same "step until it is the one" the board checks use.
async function pressUntilFloat(page, predicate, { tries = 4 } = {}) {
  for (let i = 0; i < tries; i++) {
    await pressHuman(page);
    const now = await readAssistant(page);
    if (predicate(now)) return now;
  }
  return await readAssistant(page);
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
  // Six settled turns on the ASSISTANT's own thread too. Its card is the float's, and a tall one is what makes the
  // float's chat body scroll and its pager real — so the live seventh turn lands behind that pager, and the rotation
  // has to page the turn holding the question back in exactly as it does on a board card.
  for (let i = 1; i <= 6; i++) {
    jobs.push({
      ...seed(`seed-assistant-${i}`, "panel-assistant", i, now - (40 - i) * 60_000, { ownerPath: null, projectPath: null }),
      assistant: true,
      assistantId: "assistant-1",
    });
  }
  writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify({ savedAt: iso(now), jobs }), "utf8");

  const stub = makeStub({
    "stub-approve": {
      event: "approval.request",
      payload: { request_id: REQUEST_ID, command: APPROVAL_COMMAND, choices: ["once", "deny"], timeout_seconds: 600 },
      pendingKind: "approval",
      pendingText: APPROVAL_COMMAND,
    },
    "stub-ask": {
      event: "clarify.request",
      payload: { prompt_id: REQUEST_ID, question: QUESTION, choices: CHOICES, multi_select: false, timeout_s: 600 },
      pendingKind: "clarify",
      pendingText: `Which base should this branch use?\n\nReply "skip" to skip this question.`,
    },
    "stub-homeless": {
      event: "clarify.request",
      payload: { prompt_id: REQUEST_ID, question: "Should this branch be landed now?", choices: ["Yes", "Not yet"], multi_select: false, timeout_s: 600 },
      pendingKind: "clarify",
      pendingText: "Should this branch be landed now?",
    },
    // 9 and 10: the board question the assistant's own question is rotated beside, then the assistant's two turns.
    "stub-board-next": {
      event: "clarify.request",
      payload: { prompt_id: REQUEST_ID, question: "Should this one be landed beside it?", choices: ["Yes", "Not yet"], multi_select: false, timeout_s: 600 },
      pendingKind: "clarify",
      pendingText: "Should this one be landed beside it?",
    },
    "stub-assistant": {
      event: "clarify.request",
      payload: { prompt_id: REQUEST_ID, question: ASSISTANT_QUESTION, choices: ASSISTANT_CHOICES, multi_select: false, timeout_s: 600 },
      pendingKind: "clarify",
      pendingText: ASSISTANT_QUESTION,
    },
    "stub-assistant-end": {
      event: "clarify.request",
      payload: { prompt_id: REQUEST_ID, question: "Which one is the stalled one?", choices: ["The oldest (Recommended)", "The newest"], multi_select: false, timeout_s: 600 },
      pendingKind: "clarify",
      pendingText: "Which one is the stalled one?",
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
      // The assistant is ON, and quiet: the sentry's own clock is an hour, so the only turn it takes in this sandbox
      // is one the gate starts through /api/assistant/say. That turn is the thing under test — an assistant's clarify
      // prompt belongs in the same rotation, and on the same badge, as the board's.
      assistant: { enabled: true, autonomy: "draft", seconds: 3600, maxWakesPerHour: 20 },
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
    // Each reply carries its own marker, which is how the stub names the run (`runIdFor`): the assistant is enabled
    // in this sandbox, so a wake of its own must not be able to renumber these three.
    const started = [];
    for (const [thread, marker] of [["th-approve", "GATE-APPROVE"], ["th-ask", "GATE-ASK"], ["th-homeless", "GATE-HOMELESS"]]) {
      const reply = await POST("/api/agents/reply", { thread, text: `${marker} carry on until you need a decision` });
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

    // ---- where a permission prompt actually reaches the panel ------------------------------------------------
    // Two feeds carry approvals and they are not the same thing. `/api/approvals` is the approval-transport
    // plugin's long-poll feed: the plugin presents a redacted request and polls for the answer. A panel with no
    // plugin running has an empty list there even while a run is parked. The run feed is the other one: the
    // gateway's `approval.request` lands on the job (`lib/jobs.js`), rides `/api/state`, and is what
    // `humanQuestions()` reads. This section is the proof of which feed the reader's card came from — and an
    // empty plugin feed beside a live parked run is expected, not a lost prompt.
    section("office: the two approval feeds");
    const dockFeed = await (await fetch(`${panel.base}/api/approvals`)).json();
    const snapNow = await (await fetch(`${panel.base}/api/state`)).json();
    const jobApproval = (snapNow.jobs || []).find((j) => j.thread === "th-approve" && j.approval?.requestId === REQUEST_ID);
    note(`GET /api/approvals -> ${JSON.stringify(dockFeed)}`);
    note(`/api/state jobs[th-approve].approval -> ${JSON.stringify(jobApproval?.approval || null)}`);
    check("the plugin's /api/approvals feed is EMPTY while the run is genuinely parked", Array.isArray(dockFeed.pending) ? dockFeed.pending.length : -1, 0);
    ok("the run's own snapshot carries the approval (the run feed, not the plugin feed)", jobApproval?.approval?.command === APPROVAL_COMMAND, JSON.stringify(jobApproval?.approval || null));

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
        check("HUMAN is the control immediately after ✧ Assistant", first.besideAssistant, true);
        check("the label reads HUMAN while no question is being shown", first.label, "HUMAN");
        check("the badge is not hidden", first.badgeHidden, false);
        check("the badge counts every open question", first.badgeText, "3");
        check("the badge is red", first.badgeBg, "rgb(229, 83, 75)");
        check("the button wears the waiting look", first.hasQuestions, true);
        check("the panel's dock approval feed is empty (state.approvals.size)", first.approvalsCount, 0);
        ok("the approval still reaches HUMAN — on the turn, through the run feed", first.kinds.includes("approval"), JSON.stringify(first.kinds));
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

        // ---- 9. the assistant's own question is in the rotation ------------------------------------------
        section("9. an assistant's own question is in the rotation");
        // A board question and an assistant's turn are started side by side. The proof is not that the assistant
        // has a waiting list of its own: both threads are entries in ONE rotation, on one badge, and the press
        // opens each the way its home is opened — the row and card for a worker, the float and its own Chat pane
        // for the assistant, whose prompt used to be excluded here and so never reached the count.
        const boardNext = await POST("/api/agents/reply", { thread: "th-quiet", text: "GATE-BOARD-NEXT carry on until you need a decision" });
        const said = await POST("/api/assistant/say", { text: "GATE-ASSISTANT which queue should you fold first?" });
        check("a board run and an assistant turn are both started", [boardNext.status, said.status], [202, 202]);
        const pair = await waitFor(
          async () => {
            const all = await jobsNow();
            const board = all.find((j) => j.thread === "th-quiet" && j.question?.requestId === REQUEST_ID);
            const assistant = all.find((j) => j.thread === "panel-assistant" && j.id === said.body.job?.id && j.question?.requestId === REQUEST_ID);
            return board && assistant ? { board, assistant } : false;
          },
          { timeoutMs: 40_000, stepMs: 250, what: "the board's and the assistant's clarify questions" },
        );
        ok(
          "both park on a question",
          Boolean(pair),
          pair ? `${pair.board.id} on th-quiet · ${pair.assistant.id} on the assistant` : `never arrived (${JSON.stringify(said.body).slice(0, 200)})`,
        );
        if (pair) {
          await waitFor(
            async () => {
              const s = await read(page);
              return s.listLength === 2 && s.badgeText === "2";
            },
            { timeoutMs: 20_000, what: "two open questions" },
          );
          const both = await read(page);
          check("the badge counts the assistant's question with the board's", [both.listLength, both.badgeText], [2, "2"]);
          ok("the title splits them as two clarify questions", /0 permissions, 2 clarify questions/.test(both.title), both.title.slice(0, 160));
          ok("...and names the assistant among the agents holding them", /held by [^.]*Assistant #1/.test(both.title), both.title.slice(0, 240));
          check(
            "both threads are entries in the same rotation",
            [both.keys.includes(`question:${pair.board.id}:${REQUEST_ID}`), both.keys.includes(`question:${pair.assistant.id}:${REQUEST_ID}`)],
            [true, true],
          );
          const named = await page.evaluate((id) => (humanQuestions().find((q) => q.turnId === id) || {}).agent || null, pair.assistant.id);
          check("the assistant's entry is named for the assistant, not for its prompt", named, "Assistant #1");

          // The float is shut and has never been opened on this page. The press has to open it, put THAT assistant's
          // Chat on screen, unfold the turn holding the question, and land on the box there — not on the board.
          const shut = await readAssistant(page);
          check("the float starts shut on this board", shut.floatOpen, false);
          const inFloat = await pressUntilFloat(page, (s) => s.flash?.thread === "panel-assistant");
          check("a press lands on the assistant's question", [inFloat.flash?.thread, inFloat.flash?.kind], ["panel-assistant", "question"]);
          check("the float was opened for it", inFloat.floatOpen, true);
          check("...on that assistant's own Chat tab", [inFloat.view?.assistant, inFloat.view?.subTab, inFloat.chatVisible], ["assistant-1", "chat", true]);
          ok("the turn that owns it is unfolded", inFloat.flash?.folded === false, String(inFloat.flash?.folded));
          ok("the prompt wears the red ring inside the float", /human-flash/.test(inFloat.flash?.cls || ""), inFloat.flash?.cls);
          ok("its card wears the NOT-RUNNING amber ring too", inFloat.cardHot === true, String(inFloat.cardHot));
          ok(
            "the prompt is centred in the float's own scroller",
            Math.abs((inFloat.centreY ?? 0) - (inFloat.bodyCentreY ?? 0)) < 160 &&
              (inFloat.centreY ?? 0) > (inFloat.bodyTop ?? 0) &&
              (inFloat.centreY ?? 0) < (inFloat.bodyBottom ?? 0),
            `centre ${inFloat.centreY} of body ${inFloat.bodyTop}..${inFloat.bodyBottom}`,
          );
          ok("the question the stub asked is the box in the float", /Which queue should this assistant/.test(inFloat.flash?.text || ""), inFloat.flash?.text);
          check("the clarify answer's first choice owns the caret", inFloat.focus, { tag: "button", value: ASSISTANT_CHOICES[0] });
          const placed = await read(page);
          ok("the counter names the place in a two-question rotation", /^HUMAN \d\/2$/.test(placed.label), placed.label);

          // The float's own pager, exactly like a board card's: page the live turn off, press, and the rotation has
          // to page the turn that owns the question back in before it can centre it.
          const pagedFloat = await page.evaluate(() => {
            const btn = document.querySelector('#as-chat .turn-pager [data-turn-page="older"]');
            if (!btn) return { pager: false, page: 0 };
            if (!btn.disabled) btn.click();
            return { pager: true, page: state.turnPage.get("panel-assistant") ?? 0 };
          });
          check("the assistant's card has a pager that was used to page back", [pagedFloat.pager, pagedFloat.page > 0], [true, true]);
          check(
            "the question's console is off the float's page before the press",
            await page.evaluate((id) => Boolean(document.querySelector(`#as-chat pre.job-out[data-out="${id}"]`)), pair.assistant.id),
            false,
          );
          const rePaged = await pressUntilFloat(page, (s) => s.flash?.thread === "panel-assistant" && s.page === 0);
          check("the next press pages that turn back into the float", [rePaged.page, rePaged.flash?.folded], [0, false]);
          ok(
            "its console is on the page with it",
            await page.evaluate((id) => Boolean(document.querySelector(`#as-chat pre.job-out[data-out="${id}"]`)), rePaged.flash?.turnId),
            true,
          );

          // Answering it in the float is a real POST through the panel to the stub. The entry leaves the count; the
          // board's question — the other half of the pair — stays, so this is one question closing, not the list.
          await page.click(`#as-chat .job[data-thread="panel-assistant"] .turn-question button.tq-choice[data-qvalue="${ASSISTANT_CHOICES[0]}"]`);
          await waitFor(async () => (await read(page)).listLength === 1, { timeoutMs: 15_000, what: "the assistant's question to close" });
          const answeredFloat = await read(page);
          check("the answered assistant question is out of the count", answeredFloat.badgeText, "1");
          check("...and its box is gone from the float", await page.evaluate(() => document.querySelectorAll("#as-chat .turn-question").length), 0);
          check("...because the answer really reached the stub", stub.seen.answers.some((a) => a.id === pair.assistant.runId && String(a.answer).includes("The landed one")), true);
          ok("the board's question is the one still waiting", await page.evaluate((id) => humanQuestions().some((q) => q.turnId === id), pair.board.id), true);

          // ---- 10. a question whose turn ends is dropped ----------------------------------------------
          section("10. a question whose turn ends is dropped");
          // End the first assistant turn for real — the gateway's terminal event, not a deleted record — so the
          // assistant is free for a second turn whose question is then taken away UNDER the reader.
          const releaseA = await fetch(`${stubUrl}/release/${encodeURIComponent(pair.assistant.runId)}`, { method: "POST" });
          check("the stub ends the assistant's first run", releaseA.status, 200);
          await waitFor(
            async () => {
              const j = (await jobsNow()).find((x) => x.id === pair.assistant.id);
              return j && !["running", "starting", "waiting"].includes(String(j.status));
            },
            { timeoutMs: 20_000, what: "the assistant's first turn to settle" },
          );
          const secondSaid = await POST("/api/assistant/say", { text: "GATE-ASSISTANT-END and now which one is stalled?" });
          check("a second assistant turn starts once the first has ended", secondSaid.status, 202);
          const second = await waitFor(
            async () => (await jobsNow()).find((j) => j.thread === "panel-assistant" && j.question?.requestId === REQUEST_ID && j.id !== pair.assistant.id),
            { timeoutMs: 40_000, stepMs: 250, what: "the second assistant question" },
          );
          ok("the second assistant turn parks on its own question", Boolean(second), second ? second.id : "never arrived");
          if (second) {
            await waitFor(async () => (await read(page)).listLength === 2, { timeoutMs: 20_000, what: "two open questions again" });
            const atSecond = await pressUntilFloat(page, (s) => s.flash?.turnId === second.id);
            ok("the rotation reaches the second assistant question in the float", atSecond.flash?.thread === "panel-assistant", `${atSecond.flash?.thread} · ${atSecond.flash?.turnId}`);
            const releaseB = await fetch(`${stubUrl}/release/${encodeURIComponent(second.runId)}`, { method: "POST" });
            check("the stub ends that turn while its question is still open", releaseB.status, 200);
            const dropped = await waitFor(
              async () => {
                const s = await read(page);
                return s.listLength === 1 && s.badgeText === "1" ? s : false;
              },
              { timeoutMs: 20_000, what: "the ended turn's question to leave the rotation" },
            );
            ok("the question whose turn ended is out of the count", Boolean(dropped), dropped ? `${dropped.listLength} · ${dropped.badgeText}` : "still counted");
            check("...and out of the list by its key", await page.evaluate((key) => !humanQuestions().some((q) => q.key === key), `question:${second.id}:${REQUEST_ID}`), true);
            check("...with no box left drawn in the float", await page.evaluate(() => document.querySelectorAll("#as-chat .turn-question").length), 0);
            // A press now steps on to the question that is still open rather than opening a dead float.
            const stepOn = await pressUntil(page, (s) => s.flash?.thread === "th-quiet");
            check("the next press steps on to the board's question", [stepOn.flash?.thread, stepOn.flash?.kind], ["th-quiet", "question"]);
          }

          // Back to quiet, the way the board's own case ends: the float shut, the last question answered in its box.
          await page.evaluate(() => window.__assistantToggle(false));
          const last = await page.evaluate(() => {
            const box = document.querySelector('.job[data-thread="th-quiet"] .turn-question');
            const choice = box?.querySelector("button.tq-choice");
            return choice ? { box: true, value: choice.dataset.qvalue } : { box: Boolean(box), value: null };
          });
          if (last.value) await page.click(`.job[data-thread="th-quiet"] .turn-question button.tq-choice[data-qvalue="${last.value}"]`);
          await waitFor(async () => (await read(page)).listLength === 0, { timeoutMs: 15_000, what: "an empty rotation again" });
          const quietAgain = await read(page);
          check("the rotation ends empty with the assistant's turn still live", [quietAgain.listLength, quietAgain.badgeHidden], [0, true]);
        }

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
