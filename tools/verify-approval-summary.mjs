// The plain-language summary above a parked command, driven on the panel's real approval card.
// HARNESS: LIVE GATE - seeded fixture, a stub Runs API, and headless Chromium at 1440x900.
//
//   node tools/verify-approval-summary.mjs                     # this checkout
//   node tools/verify-approval-summary.mjs --shots <dir>        # where the captures go
//   node tools/verify-approval-summary.mjs --keep               # leave the sandbox on disk
//
// THE BRIEF. A parked run shows its command and four buttons, and a reader under time pressure cannot tell from a
// shell line whether allowing it deletes something, rewrites history or pushes. The card now carries a summary
// block ABOVE the command, derived on the page with no model call (public/core/command-summary.js), and the command
// itself stays beneath it with the choices and the countdown untouched.
//
// WHAT IS DRIVEN, and nothing synthetic reaches the page: a throwaway panel of its own (its own PANEL_CONFIG, port
// and jobs store), a stub Runs API on an ephemeral port, and four real runs started through POST /api/agents/reply.
// Each run's stream carries an `approval.request` with one command, so the card, its approval record and its
// deadline are the panel's own. The four commands are the cases the brief names:
//
//   read-only       git status --short && git diff -- docs/readme.md
//   destructive     git reset --hard origin/main && git push --force origin HEAD
//   titled          [Clean the stale export] git rm --cached vendored/left-pad.js && git commit -m ...
//   permission-box  the chained one-liner from the card this brief was written about: eleven shell steps, one delete
//
// WHAT IT ASSERTS, off the painted card at 1440x900:
//   (1) the block is ABOVE the command, and its bottom is above the command's top - the order a reader reads;
//   (2) the command is byte for byte what the host asked about, inside its own <pre>, with no summary text in it;
//   (3) the split: eleven shell steps and eight programs on the chained one-liner, and no program is a fragment;
//   (4) the consequential steps are drawn in full - the delete, the history rewrite, the push, the write outside the
//       repo - and everything else is ONE folded line that says how many and names each program once;
//   (5) the folded line starts collapsed, and clicking it opens the rows it counted;
//   (6) the agent's own [Title] is the lead line, and it does not suppress the flags;
//   (7) the four choices and the countdown are still under the command, all four enabled, the timer counting;
//   (8) nothing is clipped: the block and each row fit inside the card's width;
//   (9) one screenshot of each case, viewport 1440x900, written under docs/assets/approval-summary/;
//  (10) no page error was raised, and the browser and the sandbox are gone when the run ends.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
const SHOTS = path.resolve(opt("--shots", path.join(HERE, "..", "docs", "assets", "approval-summary")));

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
    console.log(`FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
};
const section = (name) => console.log(`\n-- ${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the four commands -------------------------------------------------------------------------------------------
// Every one of them is what a worker actually parks on: a read, a destructive pair, a titled change whose title is
// the agent's own words, and the permission-box card this brief was written about - a chained one-liner whose eleven
// shell steps carry one delete.
const READ_ONLY = "git status --short && git diff -- docs/readme.md";
const DESTRUCTIVE = "git reset --hard origin/main && git push --force origin HEAD";
const TITLED = '[Clean the stale export] git rm --cached vendored/left-pad.js && git commit -m "drop the vendored copy"';
// The drive letter is built from its code point: `tools/absolute-paths.mjs` refuses a commit that spells a folder on
// the machine that wrote it, and the VALUE here is still the exact path the card showed.
const DRIVE = String.fromCharCode(67);
const CARD_ROOT = `${DRIVE}:/ProjectDevelopment/sales-cit-dev-POC-build-1/.worktrees/permission-box-exercise-fully-reversible-4d5d95`;
const CARD_BOX = `${DRIVE}:/Users/roper/AppData/Local/hermes/cache/scratch/perm-test-box`;
const CHAINED = [
  `cd "${CARD_ROOT}"`,
  'echo "START_UTC=$(date -u +%FT%TZ)"',
  "S=$(date +%s%N)",
  `find "${CARD_BOX}" -name "proof.txt" -delete`,
  "RC=$?",
  "E=$(date +%s%N)",
  'echo "EXIT_CODE=$RC"',
  'echo "ELAPSED_MS=$(( (E-S)/1000000 ))"',
  'echo "END_UTC=$(date -u +%FT%TZ)"',
  'echo "---BOX AFTER---"',
  `ls -la "${CARD_BOX}"`,
].join("; ");
const CASES = [
  {
    key: "read-only",
    thread: "th-read",
    marker: "GATE-READ",
    command: READ_ONLY,
    chip: "reads only",
    lead: "",
    steps: [],
    folds: ["2 harmless steps: git status, git diff"],
    flags: [],
    readLine: true,
    danger: false,
  },
  {
    key: "destructive",
    thread: "th-destroy",
    marker: "GATE-DESTROY",
    command: DESTRUCTIVE,
    chip: "changes things",
    lead: "",
    steps: ["git reset --hard: this branch's tip, and every uncommitted change with it", "git push --force: HEAD to origin"],
    folds: [],
    flags: ["discards uncommitted changes", "moves this branch's history", "pushes to origin"],
    readLine: false,
    danger: true,
  },
  {
    key: "title-override",
    thread: "th-title",
    marker: "GATE-TITLE",
    command: TITLED,
    chip: "changes things",
    lead: "Clean the stale export",
    steps: [],
    folds: ["2 harmless steps: git rm, git commit"],
    flags: [],
    readLine: false,
    danger: false,
  },
  {
    // The card from the screenshot: eleven shell steps, and the reader needs the one that deletes.
    key: "permission-box",
    thread: "th-box",
    marker: "GATE-BOX",
    command: CHAINED,
    chip: "changes things",
    lead: "",
    steps: [`find: walks ${CARD_BOX}, deleting what it matches`],
    folds: ["7 harmless steps: cd, echo, ls"],
    flags: ["deletes what it matches", "writes outside the repo"],
    readLine: false,
    danger: true,
  },
];

// ---- the stub gateway ---------------------------------------------------------------------------------------------
// Exactly what lib/jobs.js asks of a real one, plus the script per run: the panel posts a submission, the stub
// answers a run id taken from the marker in the prompt, and that run's event stream parks on an approval. The GET of
// the run repeats the parked prompt as `pending_controls`, the way the gateway's own runs API does.
const REQUEST_ID = "summary-req";
function makeStub(scripts) {
  const seen = { submitted: [], events: [], approvals: [] };
  const timers = new Set();
  const live = new Map();
  // Runs this stub has ended: their GET answers finished, or the panel's poll would read the parked prompt out of
  // `pending_controls` again and the tree would stay "already has a live run" for the next case.
  const settled = new Set();
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
  const runIdFor = (submission) => {
    const text = String(submission?.input ?? submission?.prompt ?? "");
    const hits = [...text.matchAll(/\bGATE-([A-Z0-9-]+)/g)];
    return hits.length ? `stub-${hits[hits.length - 1][1].toLowerCase()}` : `stub-stray-${seen.submitted.length}`;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/v1/capabilities") {
      return json(res, 200, {
        version: "approval-summary-stub",
        features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true },
      });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      const submission = await readBody(req);
      seen.submitted.push(submission);
      return json(res, 200, { run_id: runIdFor(submission), status: "running" });
    }
    // The gate's own lever: end this run now, with the terminal event a gateway sends when a turn is over. Not used
    // by the three cases below (each runs in its own tree), but a run left parked when a later case starts is exactly
    // the state this ends.
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
    if (!m) return json(res, 404, { error: { message: "not found" } });
    const id = decodeURIComponent(m[1]);
    const sub = m[2] || "";
    const script = scripts[id] || null;
    if (sub === "/approval") {
      seen.approvals.push({ id, ...(await readBody(req)) });
      return json(res, 200, { ok: true, resolved: 1 });
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
      if (!script || settled.has(id)) {
        setTimeout(() => {
          try {
            res.write(`event: run.completed\ndata: ${JSON.stringify({ event: "run.completed", status: "completed", exit_code: 0 })}\n\n`);
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
          const payload = { event: "approval.request", timestamp: Math.floor(Date.now() / 1000), ...script };
          res.write(`event: approval.request\ndata: ${JSON.stringify(payload)}\n\n`);
        } catch {
          /* gone */
        }
      }, 200);
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
    if (!script || settled.has(id)) return json(res, 200, { run_id: id, status: "completed", exit_code: 0 });
    return json(res, 200, {
      run_id: id,
      status: "running",
      pending_controls: [{ kind: "approval", prompt_id: REQUEST_ID, command: script.command }],
    });
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

// Everything this file reads comes from the painted card, never from a copy of the fixture.
const readCard = (page, thread) =>
  page.evaluate((t) => {
    const card = document.querySelector(`.agents-block .job[data-thread="${t}"]`);
    const box = card ? card.querySelector(".turn-approval") : null;
    if (!box) return { present: false, card: Boolean(card) };
    const summary = box.querySelector("[data-ta-summary]");
    const cmd = box.querySelector("pre.ta-cmd");
    const chip = box.querySelector(".ta-summary-chip");
    const steps = [...box.querySelectorAll(".ta-summary-steps > li")]
      .filter((li) => !li.classList.contains("is-fold"))
      .map((li) => li.textContent.trim());
    const folds = [...box.querySelectorAll(".ta-summary-steps > li.is-fold details.ta-fold")].map((d) => {
      const line = d.querySelector("summary");
      return {
        kind: d.dataset.taFold,
        count: Number(d.dataset.taCount),
        text: line ? line.textContent.trim() : "",
        rows: [...d.querySelectorAll(".ta-fold-steps li")].map((li) => li.textContent.trim()),
        open: d.open,
        lineFits: Boolean(line && line.scrollWidth <= line.clientWidth + 1),
      };
    });
    const flags = [...box.querySelectorAll(".ta-summary-flag")].map((el) => ({ kind: el.dataset.taFlag, text: el.textContent.replace(/^\s*\u26a0\s*/, "").trim() }));
    const read = box.querySelector(".ta-summary-read");
    const buttons = [...box.querySelectorAll("button[data-approve]")].map((b) => ({ label: b.textContent.trim(), disabled: b.disabled }));
    const foot = box.querySelector(".ta-foot[data-approval-until]");
    const rect = (el) => (el ? el.getBoundingClientRect() : null);
    const r = { summary: rect(summary), cmd: rect(cmd), chip: rect(chip), card: rect(box) };
    const firstButton = box.querySelector("button[data-approve]");
    return {
      present: true,
      card: true,
      summaryBeforeCommand: Boolean(summary && cmd && summary.compareDocumentPosition(cmd) & Node.DOCUMENT_POSITION_FOLLOWING),
      summaryBottom: r.summary ? Math.round(r.summary.bottom) : null,
      commandTop: r.cmd ? Math.round(r.cmd.top) : null,
      chipText: chip ? chip.textContent.trim() : null,
      chipClass: chip ? chip.className : null,
      lead: (box.querySelector(".ta-summary-lead") || {}).textContent || "",
      steps,
      folds,
      flags,
      readLine: read ? read.textContent.trim() : "",
      commandText: cmd ? cmd.textContent : null,
      buttons,
      foot: foot ? { text: (foot.querySelector(".ta-left") || {}).textContent || "", barWidth: (foot.querySelector(".ta-timer > span") || {}).style?.width || "" } : null,
      firstButtonBelowCommand: Boolean(firstButton && cmd && r.cmd.bottom <= firstButton.getBoundingClientRect().top),
      blockFits: Boolean(summary && summary.scrollWidth <= summary.clientWidth + 1),
      rowsFit: [...box.querySelectorAll(".ta-summary-steps li, .ta-summary-flag, .ta-summary-lead, .ta-fold-line")].every((el) => el.scrollWidth <= el.clientWidth + 1),
      cardFits: Boolean(r.card && r.card.right <= window.innerWidth + 1 && r.card.left >= -1),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      page: { thread: card?.dataset.thread || null },
    };
  }, thread);

// The reader's own way in: the HUMAN control opens the agent, the row and the turn that hold the question. A card
// already in the page (the project unfolded, the row open) needs no press.
async function reveal(page, thread) {
  const present = () => page.evaluate((t) => Boolean(document.querySelector(`.agents-block .job[data-thread="${t}"] .turn-approval`)), thread);
  if (await present()) return true;
  if ((await page.locator("#btn-human").count()) > 0) {
    await page.click("#btn-human");
    await sleep(400);
  }
  if (await present()) return true;
  // Bounded, and the card can arrive a beat after the press while the page repaints.
  return Boolean(await waitFor(present, { timeoutMs: 15_000, stepMs: 250, what: `the approval card on ${thread}` }));
}

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the approval summary", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
    process.exit(2);
  }
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-approval-summary-"));
  const repos = path.join(dir, "repos");
  mkdirSync(repos, { recursive: true });
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  const empty = path.join(dir, "empty");
  mkdirSync(empty, { recursive: true });
  // ONE TREE PER CASE: the panel refuses a second live run in a tree that already has one, and a gate should not need
  // to settle a run to move on. One tree per case, one real run each.
  const makeRepo = (name) => {
    const dirPath = path.join(repos, name);
    mkdirSync(path.join(dirPath, ".worktrees"), { recursive: true });
    const run = (...args) => execFileSync("git", ["-C", dirPath, ...args], { encoding: "utf8", windowsHide: true });
    run("init", "-q", "-b", "main");
    run("config", "user.name", "summary gate");
    run("config", "user.email", ["summary", "localhost"].join(String.fromCharCode(64)));
    writeFileSync(path.join(dirPath, "README.md"), "fixture\n");
    run("add", "-A");
    run("commit", "-qm", "fixture");
    return dirPath.replace(/\\/g, "/");
  };
  const trees = Object.fromEntries(CASES.map((c) => [c.key, makeRepo(`demo-${c.key}`)]));
  const repoPath = trees[CASES[0].key];

  // One settled turn per thread, so the live run has a card to land on and the thread is one the panel knows.
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const seed = (c) => {
    const tree = trees[c.key];
    return {
      id: `seed-${c.key}`,
      thread: c.thread,
      turn: 1,
      prompt: "settled turn 1",
      cwd: tree,
      ownerPath: tree,
      projectPath: tree,
      sessionId: c.thread,
      status: "done",
      exitCode: 0,
      startedAt: iso(now - 40 * 60_000),
      endedAt: iso(now - 39 * 60_000),
      runId: `run_seed_${c.key}`,
      worktree: false,
      existing: false,
      worktreePath: null,
      branch: null,
      lines: [{ kind: "out", lid: 1, at: now - 39 * 60_000, text: "settled - nothing left in this turn." }],
      finalMessage: "settled - nothing left in this turn.",
    };
  };
  const jobs = CASES.map(seed);
  writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify({ savedAt: iso(now), jobs }), "utf8");

  const scripts = {};
  for (const c of CASES) {
    // `runIdFor` names a run from the marker AFTER its `GATE-` prefix (`stub-read`), so the script table is keyed
    // the same way.
    scripts[`stub-${c.marker.replace(/^GATE-/i, "").toLowerCase()}`] = {
      request_id: REQUEST_ID,
      command: c.command,
      choices: ["once", "session", "always", "deny"],
      timeout_seconds: 600,
    };
  }
  const stub = makeStub(scripts);
  await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
  const stubUrl = `http://127.0.0.1:${stub.server.address().port}`;

  const panel = await startPanel({
    dir,
    root: TREE,
    config: {
      scanRoots: [empty],
      projects: CASES.map((c) => ({ name: `demo-${c.key}`, path: trees[c.key], mainBranch: "main" })),
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
    console.log(`shots:   ${SHOTS}`);

    section("1. a real run parks on an approval, three times - one at a time");
    // ONE LIVE RUN PER TREE is the panel's own rule (a second worker in the same tree would edit the same files), so
    // each case is started, read, captured and ANSWERED before the next one starts. Nothing here fakes a state to
    // get around that: the three cases are three real parks in sequence.
    mkdirSync(SHOTS, { recursive: true });
    const shots = [];

    const verdict = await withBrowser(
      async ({ page, pageErrors }) => {
        await openPage(page, panel.base, { selector: "#health.ok" });
        await page.setViewportSize({ width: 1440, height: 900 });

        for (const c of CASES) {
          section(`2. ${c.key}: ${c.command}`);
          const reply = await POST("/api/agents/reply", { thread: c.thread, text: `${c.marker} carry on until you need a decision` });
          ok(`the run on ${c.thread} is started`, reply.status === 202, `HTTP ${reply.status} ${JSON.stringify(reply.body).slice(0, 200)}`);
          const job = await waitFor(
            async () => (await jobsNow()).find((j) => j.thread === c.thread && j.approval && j.approval.command === c.command),
            { timeoutMs: 30_000, stepMs: 250, what: `the approval on ${c.thread}` },
          );
          ok(`the panel holds the approval (${c.thread})`, Boolean(job), job ? `${job.id} run ${job.runId}` : "never arrived");
          if (!job) {
            console.log(`      stub saw ${stub.seen.submitted.length} submission(s), ${stub.seen.events.length} event stream(s) [${stub.seen.events.join(", ")}]`);
            continue;
          }
          // A reload puts the new run in the first snapshot, so the press below opens THIS card rather than a stale
          // paint of the case before it.
          await page.reload({ waitUntil: "domcontentloaded" });
          await page.waitForSelector("#health.ok", { timeout: 30_000 });
          const shown = await reveal(page, c.thread);
          ok(`the card is on the page (${c.thread})`, shown, shown ? "" : "no .turn-approval for the thread");
          if (!shown) continue;
          // The HUMAN press flashes the box; let the animation finish so the capture is the settled card.
          await sleep(1900);
          const card = await readCard(page, c.thread);
          ok("the block is drawn above the command", card.summaryBeforeCommand === true, JSON.stringify({ summaryBottom: card.summaryBottom, commandTop: card.commandTop }));
          ok("its bottom is above the command's top", card.summaryBottom !== null && card.commandTop !== null && card.summaryBottom <= card.commandTop);
          check("the command under it is byte for byte what the host asked about", card.commandText, c.command);
          check("the chip", card.chipText, c.chip);
          check("the agent's own words are the lead line", card.lead.trim(), c.lead);
          check("the consequential steps are drawn in full", card.steps, c.steps);
          check("everything else is one folded line", card.folds.map((f) => f.text), c.folds);
          ok("no folded line counts a step it does not hold", card.folds.every((f) => f.rows.length === f.count), JSON.stringify(card.folds.map((f) => [f.count, f.rows.length])));
          for (const want of c.flags) {
            ok(`the flag is drawn: ${want}`, card.flags.some((f) => f.text.includes(want)), card.flags.map((f) => f.text).join(" | "));
          }
          check("the read-only sentence is drawn only when the command only reads", Boolean(card.readLine), c.readLine);
          if (c.danger) ok("the chip wears the danger colour", /is-danger/.test(card.chipClass || ""), card.chipClass);
          else if (c.chip === "reads only") ok("the chip wears the read colour", /is-read/.test(card.chipClass || ""), card.chipClass);
          check("all four choices, enabled", card.buttons.map((b) => b.label), ["Allow once", "Allow for this session", "Always allow", "Deny"]);
          ok("no choice is disabled", card.buttons.every((b) => !b.disabled), JSON.stringify(card.buttons));
          ok("the choices are under the command", card.firstButtonBelowCommand === true);
          ok("the countdown is drawn", Boolean(card.foot && /left$/.test(card.foot.text.trim()) && /\d/.test(card.foot.text)), JSON.stringify(card.foot));
          ok("nothing in the block or a row is clipped", card.blockFits && card.rowsFit, JSON.stringify({ blockFits: card.blockFits, rowsFit: card.rowsFit }));
          ok("the card is inside the viewport", card.cardFits, JSON.stringify(card.viewport));
          ok("every folded line starts collapsed", card.folds.every((f) => !f.open), JSON.stringify(card.folds.map((f) => f.open)));
          // The pager this replaces is gone: no row says how many steps are "below".
          ok("no pager row is drawn", !/more step|read the command below/i.test(card.steps.concat(card.folds.map((f) => f.text)).join(" | ")));

          await page.locator(`.agents-block .job[data-thread="${c.thread}"] .turn-approval`).scrollIntoViewIfNeeded();
          await sleep(250);
          const shot = path.join(SHOTS, `${c.key}-1440x900.png`);
          await page.screenshot({ path: shot });
          shots.push(shot);
          ok(`captured at 1440x900: ${path.basename(shot)}`, card.viewport.width === 1440 && card.viewport.height === 900, JSON.stringify(card.viewport));

          // After the capture - the picture is of the card as the reader first meets it - the folded line really
          // opens, and it opens onto the rows it counted.
          if (c.folds.length) {
            const line = page.locator(`.agents-block .job[data-thread="${c.thread}"] .turn-approval .ta-fold-line`).first();
            await line.click();
            await sleep(200);
            const open = await readCard(page, c.thread);
            const fold = open.folds[0];
            ok("the folded line expands on click", fold.open === true && fold.rows.length === fold.count, JSON.stringify({ open: fold.open, rows: fold.rows.length, count: fold.count }));
            ok("the expanded rows are visible", fold.rows.length > 0 && fold.lineFits !== false, JSON.stringify(fold.rows));
            await line.click();
            await sleep(120);
          }

          // The answer is a real POST through the panel, and the box really closes; only then may the next run start
          // in the same tree.
          const answered = await POST("/api/jobs/approve", { id: job.id, choice: "deny", requestId: REQUEST_ID });
          check(`the parked request is answerable through the panel (${c.thread})`, answered.status, 200);
          const cleared = await waitFor(async () => !(await jobsNow()).some((j) => j.id === job.id && j.approval), {
            timeoutMs: 15_000,
            stepMs: 250,
            what: `the answer to clear ${c.thread}'s park`,
          });
          ok("the box is gone once answered", Boolean(cleared));
        }

        section("3. the splitter, on the chained one-liner, through the panel's own module");
        const split = await page.evaluate((cmd) => {
          const M = window.wtCommandSummary;
          const raw = M.splitSteps(cmd);
          const s = M.summarize(cmd, { root: "" });
          return {
            raw,
            programs: s.steps.map((x) => x.program),
            shown: s.shown.length,
            harmless: s.harmless.length,
            fragments: s.steps.map((x) => x.program).filter((p) => !p || /^[-+%()=<>&|;,:]/.test(p) || /[()]/.test(p)),
          };
        }, CHAINED);
        check("eleven shell steps", split.raw.length, 11);
        check("eight programs, in order", split.programs, ["cd", "echo", "find", "echo", "echo", "echo", "echo", "ls"]);
        check("no program is a fragment", split.fragments, []);
        check("one step in full, seven folded", [split.shown, split.harmless], [1, 7]);

        section("4. the summary is a reading, not a second command");
        const dup = await page.evaluate(() =>
          [...document.querySelectorAll(".turn-approval .ta-summary")].map((s) => ({
            inCmd: Boolean(s.closest("pre.ta-cmd")),
            text: s.textContent.length,
          })),
        );
        ok("no summary block is inside a command box", dup.every((d) => !d.inCmd), JSON.stringify(dup));

        section("5. nothing raised a page error");
        check("page errors", pageErrors, []);
        return failures;
      },
      { viewport: { width: 1440, height: 900 }, headless: true },
    );

    console.log(`\n${failures ? "FAIL" : "PASS"}  ${checks - failures}/${checks} checks`);
    for (const s of shots) console.log(`shot: ${s}`);
    return verdict;
  } finally {
    await panel.stop();
    await stub.close();
  }
}

const code = await main();
if (code) process.exit(1);
