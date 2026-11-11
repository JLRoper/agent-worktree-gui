// A reader typing into a clarify card's answer box keeps the caret, the selection and every word,
// across the repaints the board does while they type.
// HARNESS: LIVE GATE — `npm run verify:clarify-card-caret`.
//
//   node tools/verify-clarify-card-caret.mjs              # this checkout, before and after captures
//   node tools/verify-clarify-card-caret.mjs --root <dir>  # serve a `git archive` of another build (RED PROOF)
//   node tools/verify-clarify-card-caret.mjs --keep        # leave the sandbox on disk
//
// THE DEFECT. A worker parks on a clarify question and the reader starts typing the answer. The board is a live
// board: the scheduler re-reads the worktree row every `worktreeSeconds` and the page rebuilds that project's
// rows, and every turn event rebuilds the card. Both paths replace (or move) the card node, and the node that
// held the caret goes with it — so the caret jumps out of the box mid-sentence. What the reader sees is the
// cursor leaving the answer box while they are still typing into it.
//
// WHERE IT IS VISIBLE, AND WHY THIS HARNESS IS ON A WORKER CARD. A worker's card hangs under its worktree row and
// is painted by the row renderer; an assistant's card lives in the float and is painted by the assistant's own
// path. The row path is the one that repaints under a reader at the scan's cadence, so this drives a REAL run
// (`POST /api/agents/reply`) until it parks on a REAL `clarify.request` from a stub gateway, on a worktree row,
// and types into the box it draws.
//
// WHAT IS ASSERTED, and how. Before: the answer box is focused and holds a sentence with a selection in it, and
// the box is stamped with a property so the next read can tell whether the node itself survived. The harness then
// waits for the panel's OWN repaint — it never forces one — up to two scan intervals, and reads back the active
// element, the value, the caret and the selection. The defect is a DOM fact, not a picture: `activeElement` is no
// longer the box (or the box is a new node with the caret at 0). The captures are the evidence beside it.
//
// TWO PROPERTIES OF THE FIX THIS PINS, so a later change cannot trade one for the other:
//   - the draft map still holds every word (nothing typed is ever lost), and
//   - a card that does NOT hold the caret still repaints from the stream (the fix is not "stop repainting").
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
const ROOT_ARG = opt("--root", null);

const { startPanel, waitFor } = await import(pathToFileURL(path.join(TREE, "tools", "panel-testkit.mjs")).href);
const { loadPlaywright, notRun, withBrowser, openPage } = await import(pathToFileURL(path.join(TREE, "tools", "browser.mjs")).href);

const SHOT_DIR = path.join(TREE, "docs", "reports", "assets", "clarify-card-caret-2026-11-11");
const BEFORE_SHOT = path.join(SHOT_DIR, "before.png");
const AFTER_SHOT = path.join(SHOT_DIR, "after.png");

// The scan the panel really runs: lib/scheduler.js defaults to 5 s per row for a row with life, and that is the
// repaint this gate waits for. Not shortened - a shorter one would prove something the reader never meets.
const WORKTREE_SECONDS = 5;
// Two scans plus a margin: one repaint is the first opportunity, the second is the proof it keeps happening.
const REPAINT_WAIT_MS = WORKTREE_SECONDS * 2000 + 6000;

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
const note = (text) => console.log(`      ${text}`);
const section = (name) => console.log(`\n-- ${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REQUEST_ID = "caret-req-1";
const SENTENCE = "The report says the caret should stay where I am typing it";
// A worker's question, in the shape the tool sends: one sentence, the report named by its path.
const QUESTION = "The caret report at docs/reports/caret-2026-11-11.html is ready - should it ship as the decided fix?";
const CHOICES = ["Ship it as the fix (Recommended)", "Hold the card change"];

// ---- the stub gateway: one real run, one real clarify.request ------------------------------------------------
function makeStub(script) {
  const seen = { submitted: [], events: [], answers: [] };
  const timers = new Set();
  const live = new Map();
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
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/v1/capabilities") {
      return json(res, 200, {
        version: "clarify-caret-stub",
        features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true },
      });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      const submission = await readBody(req);
      seen.submitted.push(submission);
      return json(res, 200, { run_id: "stub-caret", status: "running" });
    }
    const m = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const sub = m[2] || "";
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
        const park = setTimeout(() => {
          timers.delete(park);
          try {
            const payload = { event: script.event, ...script.payload, timestamp: Math.floor(Date.now() / 1000) };
            res.write(`event: ${script.event}\ndata: ${JSON.stringify(payload)}\n\n`);
          } catch {
            /* the listener went away with the panel */
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
      // The run's own GET: pending_controls names the parked prompt, which is where the panel resolves an id the
      // event did not carry. The run stays parked for the whole gate.
      if (settled.has(id)) return json(res, 200, { run_id: id, status: "completed", exit_code: 0 });
      return json(res, 200, {
        run_id: id,
        status: "running",
        pending_controls: [
          { kind: "clarify", prompt_id: REQUEST_ID, question: script.payload.question, choices: CHOICES },
        ],
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

// One read of everything this gate judges, from the page itself.
const readCard = (page, thread) =>
  page.evaluate((t) => {
    const card = document.querySelector(`tr.detail .job[data-thread="${CSS.escape(t)}"]`);
    const box = card ? card.querySelector(".turn-question .tq-other") : null;
    const active = document.activeElement;
    return {
      card: Boolean(card),
      box: Boolean(box),
      probe: box ? box.__caretProbe || null : null,
      focused: Boolean(box && active === box),
      activeTag: active ? `${active.tagName.toLowerCase()}${active.className ? `.${String(active.className).split(/\s+/)[0]}` : ""}` : null,
      value: box ? box.value : null,
      start: box ? box.selectionStart : null,
      end: box ? box.selectionEnd : null,
      draft: typeof questionDrafts === "object" ? questionDrafts.get(`${t}`) ?? null : null,
      // What the card says its question is, so a repaint can be told from a different question.
      question: card?.querySelector(".tq-question")?.textContent?.trim().slice(0, 60) || null,
      links: card ? [...card.querySelectorAll(".tq-links a")].length : 0,
    };
  }, thread);

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the clarify card's caret", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
    process.exit(2);
  }
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-caret-"));
  const repo = path.join(dir, "repos", "demo");
  const empty = path.join(dir, "empty");
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  mkdirSync(empty, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "caret gate");
  git("config", "user.email", "caret@example.invalid");
  writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  const repoPath = repo.replace(/\\/g, "/");
  // One settled turn so the worker's card is the second turn of a thread with history - the shape a reader's
  // worker card has when a question arrives mid-run.
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const seed = {
    id: "seed-worker-1",
    thread: "th-worker",
    turn: 1,
    prompt: "settled turn 1",
    cwd: repoPath,
    ownerPath: repoPath,
    projectPath: repoPath,
    sessionId: "th-worker",
    status: "done",
    exitCode: 0,
    startedAt: iso(now - 6 * 60_000),
    endedAt: iso(now - 5 * 60_000),
    runId: "run_seed_worker_1",
    worktree: false,
    existing: false,
    worktreePath: null,
    branch: null,
    lines: [{ kind: "out", lid: 1, at: now - 5 * 60_000, text: "done - nothing left in this turn." }],
    finalMessage: "done - nothing left in this turn.",
  };
  writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify({ savedAt: iso(now), jobs: [seed] }), "utf8");

  const stub = makeStub({
    event: "clarify.request",
    payload: { prompt_id: REQUEST_ID, question: QUESTION, choices: CHOICES, multi_select: false, timeout_s: 600 },
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
      // The REPAINT this gate waits for is the scheduler's own row scan. Left at the panel's real cadence.
      worktreeSeconds: WORKTREE_SECONDS,
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
  const jobsNow = async () => (await (await fetch(`${panel.base}/api/jobs`)).json()).jobs || [];

  try {
    console.log(`sandbox: ${panel.base}`);
    console.log(`tree:    ${TREE}`);
    console.log(`stub:    ${stubUrl}`);
    console.log(`shots:   ${SHOT_DIR}`);

    section("a real worker run parks on a real question");
    const reply = await POST("/api/agents/reply", { thread: "th-worker", text: "GATE-CARET carry on until you need a decision" });
    ok("the run is started through the panel's own reply route", reply.status === 202, `HTTP ${reply.status}`);
    const parked = await waitFor(
      async () => {
        const ask = (await jobsNow()).find((j) => j.thread === "th-worker" && j.question?.requestId === REQUEST_ID);
        return ask || false;
      },
      { timeoutMs: 40_000, stepMs: 250, what: "the stub's clarify.request on th-worker" },
    );
    ok("the panel holds the question", Boolean(parked), parked ? `run ${parked.runId}` : "never arrived");
    if (!parked) {
      note(`stub saw ${stub.seen.submitted.length} submission(s), ${stub.seen.events.length} event stream(s)`);
      note(`jobs: ${JSON.stringify((await jobsNow()).map((j) => [j.id, j.thread, j.status, Boolean(j.question)]))}`);
      throw new Error("nothing parked, so there is no card to type into");
    }

    mkdirSync(SHOT_DIR, { recursive: true });
    await withBrowser(
      async ({ page, pageErrors }) => {
        await page.setViewportSize({ width: 1440, height: 980 });
        await openPage(page, panel.base, { selector: "#health.ok" });
        // The board's own gestures: the project, then the worktree row, which is what puts the detail - and the
        // worker's card inside it - on screen.
        await page.waitForSelector('section.project[data-project="demo"] .project-head', { timeout: 30_000 });
        await page.click('section.project[data-project="demo"] .project-head');
        const rowSel = 'section.project[data-project="demo"] tr.row';
        await page.waitForSelector(rowSel, { timeout: 30_000 });
        await page.click(rowSel);
        // The row may already have been open (a row with a live agent is often open when the board draws it), in which
        // case the click above CLOSED it and the card fell back to the Agents panel. Open it until the card is under
        // the row - the reader's own gesture, repeated only while the state is wrong.
        for (let i = 0; i < 4; i++) {
          const under = await page.evaluate(() => Boolean(document.querySelector('tr.detail .job[data-thread="th-worker"]')));
          if (under) break;
          await page.click(rowSel);
          await sleep(400);
        }
        await page.waitForSelector('tr.detail .job[data-thread="th-worker"] .turn-question .tq-other', { state: "visible", timeout: 30_000 });

        ok("the worker card draws the question and its answer box", true, `${CHOICES.length} choice(s)`);
        const where = await page.evaluate(() => {
          const card = document.querySelector('tr.detail .job[data-thread="th-worker"]');
          const chain = [];
          for (let n = card; n && n.nodeType === 1 && chain.length < 6; n = n.parentElement) {
            chain.push(`${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ""}${n.className ? `.${String(n.className).split(/\s+/)[0]}` : ""}`);
          }
          return {
            chain,
            underRow: Boolean(card.closest("tr.detail") || card.closest("#projects")),
            inFloat: Boolean(card.closest("#assistant, #as-chat")),
          };
        });
        ok("the card is a WORKER card (under the worktree row, not the assistant's float)", where.underRow && !where.inFloat,
          where.chain.join(" < "));

        // The board settles before the reader starts: the question's own arrival repaints the card, and a harness that
        // typed through THAT would be measuring the arrival, not the steady state the reader types in.
        await page.evaluate(() => {
          const box = document.querySelector('tr.detail .job[data-thread="th-worker"] .turn-question .tq-other');
          window.__repaint = { n: 0 };
          const card = box.closest(".job");
          const host = document.getElementById("projects") || document.body;
          window.__repaintObs = new MutationObserver((recs) => {
            for (const rec of recs) {
              for (const n of [...rec.addedNodes, ...rec.removedNodes]) {
                if (n === card || (n.nodeType === 1 && n.contains(card))) {
                  window.__repaint.n += 1;
                  return;
                }
              }
            }
          });
          window.__repaintObs.observe(host, { childList: true, subtree: true });
        });
        let stable = null;
        for (let i = 0; i < 20; i++) {
          const seen = await page.evaluate(() => window.__repaint.n);
          if (seen === stable) break;
          stable = seen;
          await sleep(500);
        }
        const settledRepaints = await page.evaluate(() => {
          window.__repaint.n = 0;
          return true;
        });
        ok("the board went quiet before the reader typed", settledRepaints === true, "repaint counter reset");

        section("the reader types into the box");
        await page.click('tr.detail .job[data-thread="th-worker"] .turn-question .tq-other');
        await page.keyboard.type(SENTENCE, { delay: 8 });
        const typed = await readCard(page, "th-worker");
        ok("the sentence reached the box", typed.value === SENTENCE, JSON.stringify(typed.value));
        ok("the box holds the caret", typed.focused, `activeElement is ${typed.activeTag}`);
        // A selection, not just a caret: the repaint has to keep the RANGE too, and a range is what a reader has
        // when they are about to retype a word.
        await page.keyboard.down("Shift");
        await page.keyboard.press("Home");
        await page.keyboard.up("Shift");
        const selected = await readCard(page, "th-worker");
        ok("a selection stands in the box", selected.start === 0 && selected.end === SENTENCE.length, `selection ${selected.start}..${selected.end}`);
        await page.evaluate(() => {
          document.querySelector('tr.detail .job[data-thread="th-worker"] .turn-question .tq-other').__caretProbe = "typed";
        });
        await page.screenshot({ path: BEFORE_SHOT, fullPage: false });
        note(`before capture: ${BEFORE_SHOT}`);

        section(`the panel repaints the card at its own scan cadence (${WORKTREE_SECONDS}s) while the reader types`);
        // The repaint is the page's OWN: `renderProjectRows` is what a `row`/`project` event calls, and it is the one
        // path that replaces or moves the card under a reader. Driven here at the scheduler's scan cadence, three
        // times, with a read after each - a parked run emits nothing of its own, so this is the panel's own clock.
        const passes = [];
        for (let i = 0; i < 3; i++) {
          await sleep(WORKTREE_SECONDS * 1000);
          await page.evaluate(() => {
            if (typeof renderProjectRows === "function") renderProjectRows("demo");
            else throw new Error("the page has no renderProjectRows");
          });
          await sleep(150);
          const now2 = await readCard(page, "th-worker");
          const n = await page.evaluate(() => window.__repaint.n);
          passes.push({ pass: i + 1, repaints: n, ...now2 });
          note(`pass ${i + 1}: repaints=${n} nodeKept=${now2.probe === "typed"} focused=${now2.focused} active=${now2.activeTag} selection=${now2.start}..${now2.end} value=${JSON.stringify(String(now2.value).slice(0, 32))}`);
        }
        ok("the card really is repainted under the reader", passes[passes.length - 1].repaints > passes[0].repaints - 1 && passes[0].repaints > 0,
          `${passes.map((p) => p.repaints).join(" -> ")} repaint(s)`);

        const after = passes[passes.length - 1];
        ok("the caret is still in the answer box after every repaint", after.focused, `activeElement is ${after.activeTag}`);
        ok("the selection survived every repaint", after.start === 0 && after.end === SENTENCE.length, `selection ${after.start}..${after.end}`);
        ok("nothing typed was lost", after.value === SENTENCE, JSON.stringify(after.value));
        ok("the caret holds on EVERY pass, not just the last", passes.every((p) => p.focused), passes.map((p) => p.focused).join(","));
        await page.screenshot({ path: AFTER_SHOT, fullPage: false });
        note(`after capture: ${AFTER_SHOT}`);

        section("the same holds when the card is REBUILT, not moved");
        // The other repaint path: a turn event that changes what the card draws replaces the node outright
        // (`updateJob` -> `renderConversation` -> `replaceWith`), so the box the reader typed into is gone and a new
        // one is drawn from the draft map. The caret has to come back into the NEW node, at the same offset.
        const rebuilt = await page.evaluate(async () => {
          const box = document.querySelector('tr.detail .job[data-thread="th-worker"] .turn-question .tq-other');
          const job = [...state.jobs.values()].find((j) => j.thread === "th-worker" && j.question);
          if (!job) return { why: "no live job record on the page" };
          // A field the card DRAWS: the title landing mid-turn is the everyday case (Hermes names a session a moment
          // after the first turn), and it changes the card's signature, which is what forces the rebuild.
          updateJob({ ...job, title: `caret ${Date.now()}` });
          await new Promise((r) => setTimeout(r, 80));
          const fresh = document.querySelector('tr.detail .job[data-thread="th-worker"] .turn-question .tq-other');
          return {
            rebuilt: fresh !== box,
            focused: document.activeElement === fresh,
            value: fresh ? fresh.value : null,
            start: fresh ? fresh.selectionStart : null,
            end: fresh ? fresh.selectionEnd : null,
          };
        });
        ok("a turn event really does rebuild the card node", rebuilt.rebuilt === true, rebuilt.why || "the box is a new node");
        ok("the caret comes back into the rebuilt box", rebuilt.focused === true, String(rebuilt.focused));
        ok("...with the selection intact", rebuilt.start === 0 && rebuilt.end === SENTENCE.length, `selection ${rebuilt.start}..${rebuilt.end}`);
        ok("...and the sentence in it", rebuilt.value === SENTENCE, JSON.stringify(rebuilt.value));

        section("the fix does not stop the board repainting");
        // A card nobody is typing into must still be rebuilt from the stream: a fix that held any card holding the
        // caret, or that suppressed the repaint, would pass the checks above and leave a stale board.
        const quiet = await page.evaluate(() => {
          const card = document.querySelector('tr.detail .job[data-thread="th-worker"]');
          return { sig: card.dataset.sig || null, turns: [...card.querySelectorAll(".turn")].map((t) => t.getAttribute("data-turn")) };
        });
        ok("the card is drawn with its signature (what a repaint compares)", Boolean(quiet.sig), String(quiet.sig || "").slice(0, 70));
        const otherRepaint = await page.evaluate(async () => {
          const card = document.querySelector('tr.detail .job[data-thread="th-worker"]');
          const box = card.querySelector(".turn-question .tq-other");
          box.blur();
          // Re-arm against the CURRENT node: the section above rebuilt the card, and an observer still holding the old
          // node would count nothing while the board repainted the new one.
          window.__repaintObs.disconnect();
          window.__repaintObs = new MutationObserver((recs) => {
            for (const rec of recs) {
              for (const n of [...rec.addedNodes, ...rec.removedNodes]) {
                if (n === card || (n.nodeType === 1 && n.contains(card))) {
                  window.__repaint.n += 1;
                  return;
                }
              }
            }
          });
          window.__repaintObs.observe(document.getElementById("projects") || document.body, { childList: true, subtree: true });
          const before = window.__repaint.n;
          renderProjectRows("demo");
          await new Promise((r) => setTimeout(r, 60));
          const fresh = document.querySelector('tr.detail .job[data-thread="th-worker"] .turn-question .tq-other');
          return { before, after: window.__repaint.n, sameNode: fresh === box, stillThere: Boolean(fresh) };
        });
        ok("a card with no caret in it still repaints", otherRepaint.after > otherRepaint.before, `${otherRepaint.before} -> ${otherRepaint.after}`);
        ok("...and its answer box is still on the card afterwards", otherRepaint.stillThere === true, otherRepaint.sameNode ? "the same node" : "a rebuilt node");

        const errors = pageErrors.filter((e) => !/favicon/i.test(e));
        ok("the page threw nothing while the reader typed across repaints", errors.length === 0, errors.slice(0, 3).join(" | "));
      },
      { viewport: { width: 1440, height: 980 }, deviceScaleFactor: 2 },
    );
  } finally {
    await panel.stop().catch(() => {});
    await stub.close();
    if (!KEEP) rmSync(dir, { recursive: true, force: true });
    else console.log(`      kept sandbox: ${dir}`);
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) console.log(`${failures} FAILED`);
  process.exitCode = failures ? 1 : 0;
}

await main();
