// The Clarify history's RE-ASK, proved end to end in a real page: a question the reader MISSED is sent back into the
// thread that asked it, in full, in one press, and the reader lands where the answer will appear.
// HARNESS: LIVE GATE. `npm run verify:clarify-reask`.
//
//   node tools/verify-clarify-reask.mjs              # this checkout
//   node tools/verify-clarify-reask.mjs --keep       # leave the sandbox on disk
//
// WHAT IS REAL. The server is this checkout's server.js on its own port and its own state folder; the page is the one
// it serves; the clarify records are the same `clarify-history.json` the panel writes in life; the runs are the
// panel's own `POST /v1/runs` bodies, posted through its own reply path to a loopback stub gateway. Nothing here
// fabricates a DOM fragment or a page variable: the button, the click, the banner and the card are the page's own.
//
// THE BRIEF, and the section that proves each line:
//
//   1. THE BUTTON IS ONLY ON A MISSED ROW. Four closed rows carry it (a timed-out question on a live thread, one on a
//      session that is gone, one on a thread with a live run, and one more for the double-press proof); the ANSWERED
//      row beside them carries none.
//   2. ONE PRESS SENDS THE FULL QUESTION. The press posts once and the stub gateway records the run's own body: it
//      carries the reader's line, the STORED question byte for byte (newlines, a fence and a tail past the popup's
//      400-character display line) and every choice - into the SAME thread (`session_id`).
//   3. THE READER LANDS WHERE THE ANSWER WILL APPEAR. The popup closes, the agent's row opens, the NEW turn is the open
//      one on the card, on screen - and when the stub's `clarify.request` arrives it paints the question box through
//      the panel's existing pending path (the job's own `question`), not through a second one.
//   4. A SECOND PRESS SENDS NOTHING. The item now draws "re-asked" instead of the button, a direct POST answers 409
//      already_reasked, and the stub has exactly one run for that question. Two CONCURRENT posts on another item
//      produce one run and one 409.
//   5. THE GUARDS SPEAK. A thread holding a LIVE run is refused by name, and a session the board no longer holds is
//      refused with its own sentence; neither sends a run.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const TREE = path.resolve(HERE, "..");
// The popup with its missed rows and their buttons, for the landing doc. Written only when the gate runs green; a red
// run's picture would be a picture of a defect.
const SHOT_DIR = path.join(TREE, "docs", "reports", "assets", "clarify-reask");
const SHOT = path.join(SHOT_DIR, "popup-with-reask.png");

const { startPanel, waitFor } = await import(pathToFileURL(path.join(TREE, "tools", "panel-testkit.mjs")).href);
const { loadPlaywright, notRun, withBrowser, openPage } = await import(pathToFileURL(path.join(TREE, "tools", "browser.mjs")).href);

let checks = 0;
let failures = 0;
const ok = (label, cond, detail = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${label}${detail ? `: ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
  return Boolean(cond);
};
const note = (text) => console.log(`      ${text}`);
const section = (name) => console.log(`\n-- ${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the question, and the trap it is built to catch -------------------------------------------------------------
// Longer than the popup's ONE LINE (400 chars), with newlines, a fenced block and a tail that only the STORED record
// holds. A body built from the display line loses the fence, the newlines and everything past character 400.
const QUESTION = [
  "The turnover branch is two commits ahead of main and the pair of docs pages I drafted are not in either of them.",
  "",
  "Here is the block I mean (it is inside the tree, at docs/reports/plan.html):",
  "",
  "```",
  "<h1>the plan</h1>",
  "```",
  "",
  "The first commit is a version bump and the second is a changelog render, and neither one names the rows the reader",
  "asked about. Should the next turn land the docs pair on this branch before the PR, or wait for the render to catch",
  "up with main so the PR reads one commit instead of three? I have the branch checked out and the tree is clean.",
  "",
  "One more line after the blank, so the LAST byte of the question is past anything a 400-character cut could keep.",
].join("\n");
const CHOICES = ["land the docs pair first", "wait for the render to catch up", "land it as it is"];
const REASK_LINE = "Can you please re-ask this clarify question if it is still valid?";
const REASKED_QUESTION = "Should the runner skip the cached build when the tree is clean?";
const REQUEST_ID = "p-reask-1";

// ---- the fixture: one project, one finished turn, one live one, and four missed questions -------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-clarify-reask-"));
const empty = path.join(dir, "empty");
mkdirSync(path.join(dir, "logs"), { recursive: true });
mkdirSync(empty, { recursive: true });

// Each thread that must be FREE for its own re-ask gets a tree of its own: one live run in a tree (correctly) holds
// every thread in that tree as `tree_busy`, which is a guard of its own and would hide the per-thread one here.
const mkrepo = (name) => {
  const dirOf = path.join(dir, "repos", name);
  mkdirSync(dirOf, { recursive: true });
  const run = (...args) =>
    execFileSync("git", ["-C", dirOf, "-c", "user.name=reask gate", "-c", `user.email=${["reask", "example.invalid"].join(String.fromCharCode(64))}`, ...args], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  run("init", "-q", "-b", "main");
  writeFileSync(path.join(dirOf, "README.md"), `the ${name} tree\n`, "utf8");
  run("add", "-A");
  run("commit", "-qm", "fixture");
  return dirOf.replace(/\\/g, "/");
};
const repoPath = mkrepo("demo");
const otherPath = mkrepo("other");
const secondPath = mkrepo("second");

const now = Date.now();
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const THREAD = "th-reask";
const BUSY = "th-busy";
const GONE = "th-gone";
const SECOND = "th-second";

const turn = (id, thread, over = {}) => ({
  id,
  thread,
  turn: 1,
  origin: "worker",
  status: "done",
  exitCode: 0,
  prompt: `${id}: the turn that asked`,
  finalMessage: `${id} finished`,
  cwd: repoPath,
  ownerPath: repoPath,
  projectPath: repoPath,
  worktree: false,
  existing: false,
  worktreePath: null,
  branch: null,
  lines: [{ kind: "out", lid: 1, at: now - 10 * MIN, text: "the turn's own output" }],
  startedAt: iso(now - 40 * MIN),
  endedAt: iso(now - 30 * MIN),
  lastActiveAt: iso(now - 30 * MIN),
  ...over,
});
const jobs = [
  turn("t-old", THREAD, { runId: "run-seed-done" }),
  turn("t-second", SECOND, { runId: "run-seed-second", cwd: secondPath, ownerPath: secondPath, projectPath: secondPath }),
  // The LIVE thread: a running card the stub keeps running, which is what a re-ask into it must refuse.
  turn("t-busy", BUSY, {
    status: "running",
    runId: "run-busy",
    endedAt: null,
    lastActiveAt: iso(now - 2 * MIN),
    prompt: "the turn that is still working",
    cwd: otherPath,
    ownerPath: otherPath,
    projectPath: otherPath,
  }),
];
writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify({ version: 3, savedAt: iso(now), jobs }, null, 1), "utf8");

// Four MISSED items and one ANSWERED one. `seq` is the draw order, newest first.
const entry = (seq, over) => ({
  seq,
  key: `clarify:${over.jobId || "t-old"}:seed-${seq}`,
  requestId: `seed-${seq}`,
  jobId: "t-old",
  thread: THREAD,
  agent: "the re-ask gate's agent",
  tree: "demo",
  treePath: repoPath,
  project: "demo",
  assistantId: "assistant-1",
  assistantName: "Assistant #1",
  question: `seeded question ${seq}?`,
  choices: ["yes", "no"],
  multiSelect: false,
  links: [],
  base: "",
  askedAt: iso(now - 2 * 60 * MIN),
  deadline: null,
  timeoutSeconds: null,
  reasks: 0,
  status: "closed",
  answer: "",
  answeredBy: "",
  answeredAt: null,
  closedWhy: "timed out",
  closedAt: iso(now - 90 * MIN),
  ...over,
});
const history = {
  version: 1,
  seq: 40,
  entries: [
    entry(40, { question: QUESTION, choices: CHOICES, multiSelect: true, askedAt: iso(now - 55 * MIN), closedAt: iso(now - 50 * MIN) }),
    entry(39, {
      key: "clarify:t-old:seed-39",
      question: "Which side of the merge goes first?",
      choices: ["the tree", "main"],
      askedAt: iso(now - 60 * MIN),
      status: "answered",
      answer: "the tree, then main",
      answeredBy: "reader",
      answeredAt: iso(now - 59 * MIN),
      closedWhy: "",
      closedAt: iso(now - 59 * MIN),
    }),
    entry(38, { key: "clarify:t-old:seed-38", question: "Was the tag pushed for the docs pair?", thread: GONE, closedWhy: "the turn ended" }),
    entry(37, { key: "clarify:t-busy:seed-37", jobId: "t-busy", thread: BUSY, question: "Should the runner keep waiting on the reader?" }),
    entry(36, { key: "clarify:t-second:seed-36", jobId: "t-second", thread: SECOND, question: "Did the runner report the cached build?" }),
  ],
};
writeFileSync(path.join(dir, "logs", "clarify-history.json"), JSON.stringify(history, null, 1), "utf8");

// ---- the stub gateway ---------------------------------------------------------------------------------------------
function makeStub() {
  const seen = { submitted: [], attached: [], questions: [] };
  const timers = new Set();
  let runs = 0;
  const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
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
        version: "clarify-reask-stub",
        features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_cwd: true },
      });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      const body = await readBody(req);
      seen.submitted.push(body);
      runs += 1;
      return json(res, 200, { run_id: `run-reask-${runs}`, status: "running" });
    }
    const m = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const sub = m[2] || "";
      if (sub === "/events") {
        seen.attached.push(id);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(": attached\n\n");
        // The re-asked card: the run's own clarify.request, the ONE way a question reaches the board. The hold after
        // it keeps the run live so nothing settles the card under the assertion.
        if (/^run-reask-/.test(id)) {
          const ask = setTimeout(() => {
            timers.delete(ask);
            try {
              seen.questions.push(id);
              res.write(
                `event: clarify.request\ndata: ${JSON.stringify({
                  event: "clarify.request",
                  prompt_id: REQUEST_ID,
                  question: REASKED_QUESTION,
                  choices: ["skip the cache", "rebuild anyway"],
                  multi_select: false,
                  timeout_s: 600,
                  timestamp: Math.floor(Date.now() / 1000),
                })}\n\n`,
              );
            } catch {
              /* the listener went away with the panel */
            }
          }, 300);
          timers.add(ask);
        }
        const hold = setInterval(() => {
          try {
            res.write(": hold\n\n");
          } catch {
            clearInterval(hold);
            timers.delete(hold);
          }
        }, 800);
        timers.add(hold);
        req.on("close", () => {
          clearInterval(hold);
          timers.delete(hold);
        });
        return;
      }
      if (sub === "/clarify") {
        await readBody(req);
        return json(res, 200, { ok: true, run_id: id });
      }
      if (sub === "/stop" || sub === "/steer") {
        await readBody(req);
        return json(res, 200, { ok: true, run_id: id });
      }
      // One PARKED run the boot reconcile must leave live; every other id is answered as a finished run.
      if (id === "run-busy") return json(res, 200, { run_id: id, status: "running", pending_controls: [] });
      return json(res, 200, { run_id: id, status: "done", pending_controls: [] });
    }
    json(res, 404, { error: { message: "not found", code: "not_found" } });
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

const playwright = loadPlaywright();
if (!playwright) {
  console.log(notRun("the clarify re-ask", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
  process.exit(2);
}

const stub = makeStub();
await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${stub.server.address().port}`;

const panel = await startPanel({
  dir,
  keep,
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
    assistant: { enabled: false, seconds: 3600, maxWakesPerHour: 0 },
    apiServer: { url: stubUrl, key: "sandbox-key" },
  },
});

const POST = async (route, body) => {
  const r = await fetch(`${panel.base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const JOBS = async () => (await (await fetch(`${panel.base}/api/jobs`)).json()).jobs || [];
const HISTORY = async () => (await (await fetch(`${panel.base}/api/clarify/history`)).json());

let verdict = 1;
try {
  console.log(`sandbox: ${panel.base}`);
  console.log(`stub:    ${stubUrl}`);
  note(`fixture: ${jobs.length} turns, ${history.entries.length} history rows, the missed question ${QUESTION.length} chars over ${QUESTION.split("\n").length} lines`);

  await waitFor(
    async () => {
      const s = await (await fetch(`${panel.base}/api/state`)).json();
      return (s.projects || []).some((p) => p.name === "demo");
    },
    { timeoutMs: 40_000, stepMs: 250, what: "the fixture project on the board" },
  );
  const before = await HISTORY();
  ok("the route answers the seeded history", before.total === 5, `total ${before.total}`);
  const asked = before.items.find((i) => i.seq === 40);
  ok("the missed question is CLOSED, so a re-ask may be offered", asked?.state === "closed", asked?.state);

  await withBrowser(async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
    await page.setViewportSize({ width: 1440, height: 980 });
    await openPage(page, panel.base, { selector: "#health.ok" });
    await page.waitForSelector('section.project[data-project="demo"] .project-head', { timeout: 45_000 });
    await page.evaluate(() => {
      if (!state.expandedProjects.has("demo")) document.querySelector('.project-head[data-toggle-project="demo"]')?.click();
    });
    await page.waitForSelector('section.project[data-project="demo"] tr.row', { timeout: 30_000 });

    // The popup, opened the way a reader opens it.
    await page.click("#btn-clarify");
    await page.waitForSelector("#clarify-pop .ch-row", { timeout: 20_000 });
    await page.waitForFunction(() => document.querySelectorAll("#clarify-pop .ch-row").length >= 5, { timeout: 20_000 });

    const rows = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("#clarify-pop .ch-row")].map((r) => ({
          seq: Number(r.dataset.seq),
          state: r.className.replace(/\s+/g, " ").trim(),
          question: r.querySelector(".ch-q")?.textContent?.replace(/\s+/g, " ").trim() || "",
          reask: Boolean(r.querySelector("button.ch-reask")),
          note: r.querySelector(".ch-reask-note")?.textContent?.replace(/\s+/g, " ").trim() || "",
          marker: r.querySelector(".ch-mark")?.textContent?.replace(/\s+/g, " ").trim() || "",
        })),
      );
    const banner = () => page.evaluate(() => document.getElementById("banner-text")?.textContent?.replace(/\s+/g, " ").trim() || "");
    // The popup is a toggle: open it only when it is shut, so a press meant to open never closes it under the next step.
    const ensurePopup = async () => {
      if (!(await page.evaluate(() => Boolean(document.querySelector("#clarify-pop:not([hidden])"))))) await page.click("#btn-clarify");
      await page.waitForSelector("#clarify-pop .ch-row", { timeout: 20_000 });
    };

    // ---- 1. the button is only on a missed row ---------------------------------------------------------------
    section("1. the re-ask button, on missed rows only");
    const drawn = await rows();
    const bySeq = (n) => drawn.find((r) => r.seq === n) || null;
    ok("the missed question draws the button", bySeq(40)?.reask === true, bySeq(40)?.state);
    ok("the answered question draws NO button", bySeq(39)?.reask === false, `${bySeq(39)?.marker} / ${bySeq(39)?.state}`);
    ok("…and it still reads as answered, not as a miss", /is-answered/.test(bySeq(39)?.state || ""), bySeq(39)?.marker);
    is_count("every closed row that is not answered or re-asked draws one", drawn.filter((r) => r.reask).length, 4);
    ok("no row draws a re-ask note yet", drawn.every((r) => !r.note), JSON.stringify(drawn.map((r) => r.note).filter(Boolean)));
    mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: SHOT });
    note(`capture: ${SHOT}`);

    // ---- 2. two presses that arrive together send once -------------------------------------------------------
    section("2. the double press: two concurrent posts, one run");
    const runsBefore = stub.seen.submitted.length;
    const [one, two] = await Promise.all([POST("/api/clarify/reask", { seq: 36 }), POST("/api/clarify/reask", { seq: 36 })]);
    const statuses = [one.status, two.status].sort();
    is_list("one accepted, one refused", statuses, [202, 409]);
    is_count("exactly one run was started", stub.seen.submitted.length - runsBefore, 1);
    const recorded = (await HISTORY()).items.find((i) => i.seq === 36);
    ok("the accepted send is recorded on the item", Boolean(recorded?.reask?.jobId), JSON.stringify(recorded?.reask || null));

    // ---- 3. one press sends the whole stored question --------------------------------------------------------
    section("3. one press, the full question, the same thread");
    await ensurePopup();
    await page.waitForSelector('#clarify-pop .ch-row[data-seq="40"] button.ch-reask', { timeout: 20_000 });
    const runsBeforeClick = stub.seen.submitted.length;
    await page.click('#clarify-pop .ch-row[data-seq="40"] button.ch-reask');
    const landed = await waitFor(() => stub.seen.submitted.length > runsBeforeClick, { timeoutMs: 30_000, stepMs: 150, what: "the re-ask's POST /v1/runs" });
    ok("the press posted exactly one run", landed && stub.seen.submitted.length - runsBeforeClick === 1, `${stub.seen.submitted.length - runsBeforeClick} run(s)`);
    const sent = stub.seen.submitted[stub.seen.submitted.length - 1] || {};
    const input = String(sent.input || "");
    ok("the body carries the reader's line", input.includes(REASK_LINE));
    ok("the body carries the STORED question byte for byte", input.includes(QUESTION), `${QUESTION.length} chars, ${QUESTION.split("\n").length} lines`);
    ok("the body keeps the question's newlines", input.includes("\n```\n<h1>the plan</h1>\n```\n"), "the fence and its blank lines survive");
    for (const c of CHOICES) ok(`the body carries the choice ${JSON.stringify(c)}`, input.includes(c));
    ok("the body is more than the popup's 400-character display line", input.length > 400 && QUESTION.length > 400, `input ${input.length} chars`);
    is_str("the run continues the SAME thread", sent.session_id, THREAD);
    // The record names the turn the card will be asked in.
    const afterAsk = (await HISTORY()).items.find((i) => i.seq === 40);
    ok("the item records the turn its re-ask started", Boolean(afterAsk?.reask?.jobId), JSON.stringify(afterAsk?.reask || null));
    const reaskJob = afterAsk?.reask?.jobId || "";

    // ---- 4. the reader lands where the answer will appear ---------------------------------------------------
    section("4. the landing: the new turn, on screen, open");
    const readLanding = () =>
      page.evaluate((id) => {
        const card = document.querySelector('.job[data-thread="th-reask"]');
        const turn = id ? card?.querySelector(`.turn[data-turn="${id}"]`) : null;
        if (!turn) return null;
        const r = turn.getBoundingClientRect();
        return {
          folded: turn.classList.contains("folded"),
          inView: r.top < window.innerHeight && r.bottom > 0,
          top: Math.round(r.top),
          popupClosed: Boolean(document.querySelector("#clarify-pop[hidden]")),
          note: document.getElementById("banner-text")?.textContent?.replace(/\s+/g, " ").trim() || "",
        };
      }, reaskJob);
    // The landing is a short watchdog over the card's own settling (the row opens, the detail is fetched, the turns are
    // drawn, then the turn is scrolled to), so the wait is on the FINISHED state - painted, open and on screen - not on
    // the first frame the turn exists.
    const landedTurn = await waitFor(async () => {
      const seen = await readLanding();
      return seen && seen.inView ? seen : false;
    }, { timeoutMs: 30_000, stepMs: 200, what: "the new turn painted and on screen" });
    if (!landedTurn) note(`landing read: ${JSON.stringify(await readLanding())}`);
    ok("the agent's card is open and the new turn is painted", Boolean(landedTurn), reaskJob || "(no turn id)");
    ok("the new turn is the OPEN one on the card", landedTurn && landedTurn.folded === false, `folded=${landedTurn?.folded}`);
    ok("the new turn is on screen", landedTurn && landedTurn.inView === true, `inView=${landedTurn?.inView}`);
    ok("the popup closed behind the press", landedTurn && landedTurn.popupClosed === true);
    ok("the page says what it did", /re-asked in th-reask/i.test(landedTurn?.note || ""), landedTurn?.note || "(no banner)");

    // ---- 5. the card surfaces through the EXISTING pending path ---------------------------------------------
    section("5. the re-asked card, through the panel's own pending mechanism");
    const parked = await waitFor(
      async () => {
        const all = await JOBS();
        return all.find((j) => j.id === reaskJob && j.question?.requestId === REQUEST_ID) || false;
      },
      { timeoutMs: 40_000, stepMs: 250, what: "the job record's own question" },
    );
    ok("the run's clarify.request becomes the job's question", Boolean(parked), parked ? `key ${parked.question?.key}` : "never arrived");
    ok("the question is the one the run asked", String(parked?.question?.question || "") === REASKED_QUESTION, String(parked?.question?.question || ""));
    const box = await waitFor(
      () =>
        page.evaluate((id) => {
          const turn = id ? document.querySelector(`.job[data-thread="th-reask"] .turn[data-turn="${id}"]`) : null;
          const q = turn?.querySelector(".turn-question");
          if (!q) return false;
          return { text: q.textContent.replace(/\s+/g, " ").trim(), visible: q.getBoundingClientRect().height > 0 };
        }, reaskJob),
      { timeoutMs: 30_000, stepMs: 200, what: "the question box on the re-asked turn" },
    );
    ok("the question box is painted on the new turn", Boolean(box) && box.visible === true, box ? box.text.slice(0, 60) : "no box");
    ok("…and it asks the question the run asked", String(box?.text || "").includes(REASKED_QUESTION), box?.text || "");

    // ---- 6. a second press sends nothing --------------------------------------------------------------------
    section("6. the double click, after the record exists");
    const beforeSecond = stub.seen.submitted.length;
    await ensurePopup();
    await page.waitForSelector('#clarify-pop .ch-row[data-seq="40"]', { timeout: 20_000 });
    const again = await rows();
    const rowAgain = again.find((r) => r.seq === 40);
    ok("the row draws the record instead of the button", rowAgain?.reask === false && /re-asked/.test(rowAgain?.note || ""), rowAgain?.note || rowAgain?.state);
    const direct = await POST("/api/clarify/reask", { seq: 40 });
    is_count("a direct second POST is refused", direct.status, 409);
    is_str("…with the code that says why", direct.body?.code, "already_reasked");
    is_count("…and no run was started", stub.seen.submitted.length - beforeSecond, 0);

    // ---- 7. the guards speak: a live thread, a session that is gone ------------------------------------------
    section("7. a live run and a dead session, refused by name");
    await page.waitForSelector('#clarify-pop .ch-row[data-seq="37"] button.ch-reask', { timeout: 20_000 });
    await page.click('#clarify-pop .ch-row[data-seq="37"] button.ch-reask');
    const busySaid = await waitFor(async () => (/live run/i.test(await banner()) ? await banner() : false), {
      timeoutMs: 15_000,
      stepMs: 200,
      what: "the live-run refusal",
    });
    ok("a thread holding a live run is refused by its own name", Boolean(busySaid) && /th-busy/.test(busySaid) && /live run/.test(busySaid), busySaid || "(no banner)");
    is_count("…and nothing was sent", stub.seen.submitted.length - beforeSecond, 0);

    await page.evaluate(() => document.querySelector("#banner")?.classList.add("hidden"));
    await page.waitForSelector('#clarify-pop .ch-row[data-seq="38"] button.ch-reask', { timeout: 20_000 });
    await page.click('#clarify-pop .ch-row[data-seq="38"] button.ch-reask');
    const goneSaid = await waitFor(async () => (/no longer on this board/i.test(await banner()) ? await banner() : false), {
      timeoutMs: 15_000,
      stepMs: 200,
      what: "the dead-session refusal",
    });
    ok("a session the board no longer holds is refused plainly", Boolean(goneSaid) && /th-gone/.test(goneSaid), goneSaid || "(no banner)");
    is_count("…and nothing was sent into it", stub.seen.submitted.length - beforeSecond, 0);

    ok("no page error was raised by any of it", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  });

  verdict = failures === 0 ? 0 : 1;
} catch (e) {
  console.log(`FAIL  the gate threw: ${String((e && e.stack) || e)}`);
  failures += 1;
  verdict = 1;
} finally {
  console.log(`\n${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ""}`);
  if (!keep) {
    await panel.stop().catch(() => {});
    await stub.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } else {
    console.log(`kept: ${dir}`);
    await panel.stop().catch(() => {});
    await stub.close().catch(() => {});
  }
}
process.exit(verdict);

// ---- tiny assertions with the gate's own wording ---------------------------------------------------------------
function is_count(label, got, want) {
  return ok(label, Number(got) === Number(want), `got ${got}${Number(got) === Number(want) ? "" : ` want ${want}`}`);
}
function is_str(label, got, want) {
  return ok(label, String(got ?? "") === String(want ?? ""), `got ${JSON.stringify(got)}${String(got ?? "") === String(want ?? "") ? "" : ` want ${JSON.stringify(want)}`}`);
}
function is_list(label, got, want) {
  return ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}${JSON.stringify(got) === JSON.stringify(want) ? "" : ` want ${JSON.stringify(want)}`}`);
}
