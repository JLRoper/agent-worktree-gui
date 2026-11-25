// The four-direction shape check, proved on REAL CARDS in a real page: a live panel, a worker thread, and a stub
// gateway that raises one `clarify.request` per run through the panel's own SSE path.
// HARNESS: LIVE GATE - `npm run verify:clarify-shape`.
//
//   node tools/verify-clarify-shape.mjs            # this checkout, one browser launch
//   node tools/verify-clarify-shape.mjs --keep     # leave the sandbox on disk
//
// WHY A REAL RUN. The check lives at the `clarify.request` seam and the strip is drawn by the shipped
// `questionPrompt`, so the card under test has to be the card a reader gets: a worker turn started through the
// panel's own reply route, a question arriving from the run's stream, and the answer sent back by the card's button.
// A fixture handed straight to the classifier would prove the module and nothing about the card.
//
// THREE CARDS, ANSWERED ONE AT A TIME, and what each one proves:
//
//   1. four kinds        the strip names Finish, Deeper, Route, Ask in order, and the card is painted complete;
//   2. two plain choices the strip reads short and names the four missing kinds, and the choice buttons are live;
//   3. out of order      the recommended marker on the second choice is flagged, and every choice is still offered.
//
// THE HARD CONSTRAINT IS THE POINT OF THE GATE. Card 2 is answered through its own button and settles: a short card
// raises, answers and settles exactly like a complete one. Card 3 is answered after being flagged out of order, with
// the same result. The popup's count is read between cards, so "one more card asked" is one more in its denominator.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const TREE = path.resolve(HERE, "..");
const SHOT_DIR = path.join(TREE, "docs", "reports", "assets", "clarify-shape");
const STRIP_SHOT = path.join(SHOT_DIR, "card-strip.png");
const POPUP_SHOT = path.join(SHOT_DIR, "popup-count.png");

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

// ---- the three cards ----------------------------------------------------------------------------------------------
// ONE label set per card, in the order the panel receives them. The marker "(Recommended)" is what the gateway
// appends to the choice it wants first, so card 3 is a card whose recommended choice is genuinely second.
const FOUR = [
  "Finish: land the shape check and stop (Recommended)",
  "Deeper: build the seam check and the count",
  "Route: build the answer-to-row bridge",
  "Ask: park the build and put it to the assistants",
];
const TWO = ["the turn, and its tree", "only the agent"];
const ORDERED_WRONG = [
  "Deeper: build the seam check first",
  "Finish: land what is here and stop (Recommended)",
  "Route: build the answer-to-row bridge",
  "Ask: park the build",
];
const CARDS = [
  { id: "shape-req-1", question: "This landing is done. Which direction next?", choices: FOUR },
  { id: "shape-req-2", question: "The turn ended. Where should the record of it live?", choices: TWO },
  { id: "shape-req-3", question: "The docs pair is written. What is the next move?", choices: ORDERED_WRONG },
];
const THREAD = "th-shape";

// ---- the stub gateway: one run at a time, one card per run -------------------------------------------------------
function makeStub() {
  const seen = { submitted: [], answers: [], questions: [] };
  const timers = new Set();
  const live = new Map();
  let runIndex = 0;
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
  const cardFor = (runId) => {
    const n = Number(String(runId).replace(/^run-shape-/, ""));
    return CARDS[Math.max(0, n - 1)] || null;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/v1/capabilities") {
      return json(res, 200, {
        version: "clarify-shape-stub",
        features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true },
      });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      const body = await readBody(req);
      seen.submitted.push(body);
      runIndex += 1;
      return json(res, 200, { run_id: `run-shape-${runIndex}`, status: "running" });
    }
    const m = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const sub = m[2] || "";
      if (sub === "/clarify") {
        const body = await readBody(req);
        seen.answers.push({ id, ...body });
        // The answer ends this run: the stub closes the stream and reports it done, so the panel finalises the turn
        // and the next reply on the thread is free to start. That is what makes the NEXT card raisable.
        const held = live.get(id);
        if (held) {
          clearInterval(held.hold);
          timers.delete(held.hold);
          try {
            held.res.write("event: run.completed\ndata: {\"event\":\"run.completed\",\"status\":\"done\"}\n\n");
            held.res.end();
          } catch {
            /* the listener went away */
          }
          live.delete(id);
        }
        seen.done = seen.done || new Set();
        seen.done.add(id);
        return json(res, 200, { ok: true, run_id: id });
      }
      if (sub === "/stop") return json(res, 200, { ok: true });
      if (sub === "/steer") {
        await readBody(req);
        return json(res, 200, { accepted: true, run_id: id });
      }
      if (sub === "/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": attached\n\n");
        const card = cardFor(id);
        const park = setTimeout(() => {
          timers.delete(park);
          if (!card) return;
          try {
            seen.questions.push(card.id);
            res.write(
              `event: clarify.request\ndata: ${JSON.stringify({
                event: "clarify.request",
                prompt_id: card.id,
                question: card.question,
                choices: card.choices,
                multi_select: false,
                timeout_s: 600,
                timestamp: Math.floor(Date.now() / 1000),
              })}\n\n`,
            );
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
      return json(res, 200, { run_id: id, status: seen.done?.has(id) ? "done" : "running", pending_controls: [] });
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

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the clarify shape gate", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
    process.exit(2);
  }
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-shape-"));
  const repo = path.join(dir, "repos", "demo");
  const empty = path.join(dir, "empty");
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  mkdirSync(empty, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "shape gate");
  git("config", "user.email", ["shape", "gate.local"].join(String.fromCharCode(64)));
  writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  const repoPath = repo.replace(/\\/g, "/");

  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const seed = {
    id: "seed-shape-1",
    thread: THREAD,
    turn: 1,
    prompt: "settled turn 1",
    cwd: repoPath,
    ownerPath: repoPath,
    projectPath: repoPath,
    sessionId: THREAD,
    status: "done",
    exitCode: 0,
    startedAt: iso(now - 6 * 60_000),
    endedAt: iso(now - 5 * 60_000),
    runId: "run_seed_shape_1",
    worktree: false,
    existing: false,
    lines: [{ kind: "out", lid: 1, at: now - 5 * 60_000, text: "done - nothing left in this turn." }],
    finalMessage: "done - nothing left in this turn.",
  };
  writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify({ savedAt: iso(now), jobs: [seed] }), "utf8");

  const stub = makeStub();
  await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
  const stubUrl = `http://127.0.0.1:${stub.server.address().port}`;

  const panel = await startPanel({
    dir,
    root: TREE,
    config: {
      scanRoots: [empty],
      projects: [{ name: "demo", path: repoPath, mainBranch: "main" }],
      refreshSeconds: 3600,
      worktreeSeconds: 5,
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
  const HISTORY = async () => await (await fetch(`${panel.base}/api/clarify/history`)).json();
  const ask = async (promptId) =>
    (await JOBS()).find((j) => j.thread === THREAD && j.question?.requestId === promptId) || null;
  const settled = async (promptId) =>
    (await JOBS()).find((j) => j.thread === THREAD && j.questionDone?.key?.includes(promptId) && !j.question) || null;

  let verdict = 1;
  try {
    console.log(`sandbox: ${panel.base}`);
    console.log(`stub:    ${stubUrl}`);
    section("a real worker run parks on the four-direction card");

    const reply = await POST("/api/agents/reply", { thread: THREAD, text: "GATE-SHAPE carry on until you need a decision" });
    ok("the run is started through the panel's own reply route", reply.status === 202, `HTTP ${reply.status} ${reply.body?.error || ""}`);
    const parked = await waitFor(() => ask(CARDS[0].id), { timeoutMs: 40_000, stepMs: 250, what: "the first card's clarify.request" });
    ok("the panel holds the first question", Boolean(parked), parked ? `run ${parked.runId}` : "never arrived");
    if (!parked) throw new Error("nothing parked, so there is no card to look at");
    ok("the seam stored the verdict as question.shape", Boolean(parked.question?.shape), JSON.stringify(parked.question?.shape || null));
    ok("the verdict reads complete", parked.question?.shape?.ok === true, parked.question?.shape?.line || "(no line)");

    mkdirSync(SHOT_DIR, { recursive: true });
    await withBrowser(
      async ({ page, pageErrors }) => {
        await page.setViewportSize({ width: 1440, height: 980 });
        await openPage(page, panel.base, { selector: "#health.ok" });
        await page.waitForSelector('section.project[data-project="demo"] .project-head', { timeout: 30_000 });
        await page.click('section.project[data-project="demo"] .project-head');
        const rowSel = `tr.row[data-key="demo::${repoPath}"]`;
        await page.waitForSelector(rowSel, { timeout: 30_000 });
        await page.click(rowSel);
        const card = async (index) => {
          const all = await page.$$('.job[data-thread="th-shape"] .turn-question');
          return all[index] || all[all.length - 1] || null;
        };
        const readCard = () =>
          page.evaluate(() => {
            const q = document.querySelector('.job[data-thread="th-shape"] .turn-question');
            if (!q) return null;
            const strip = q.querySelector(".tq-shape");
            return {
              visible: q.getBoundingClientRect().height > 0,
              shape: strip ? strip.textContent.replace(/\s+/g, " ").trim() : null,
              complete: Boolean(strip && strip.classList.contains("is-complete")),
              strips: q.querySelectorAll(".tq-shape").length,
              choices: [...q.querySelectorAll("button.tq-choice")].map((b) => ({ text: b.textContent.replace(/\s+/g, " ").trim(), disabled: b.disabled })),
            };
          });

        await page.waitForSelector('.job[data-thread="th-shape"] .turn-question', { state: "visible", timeout: 30_000 });
        let seen = await readCard();
        ok("the card is painted", Boolean(seen) && seen.visible === true);
        ok("there is exactly ONE strip on the card", seen.strips === 1, `${seen.strips} strip(s)`);
        ok(
          "the four directions are named in order",
          seen.shape === "four directions, in order: Finish, Deeper, Route, Ask",
          seen.shape || "(no strip)",
        );
        ok("the card is painted as complete", seen.complete === true);
        ok("all four choices are offered and enabled", seen.choices.length === 4 && seen.choices.every((c) => !c.disabled), JSON.stringify(seen.choices.map((c) => c.disabled)));

        const first = await card(0);
        if (first) await first.screenshot({ path: STRIP_SHOT });
        note(`capture: ${STRIP_SHOT}`);

        // ---- the popup's count after one card ---------------------------------------------------------------
        const openPopup = async () => {
          if (!(await page.evaluate(() => Boolean(document.querySelector("#clarify-pop:not([hidden])"))))) await page.click("#btn-clarify");
          await page.waitForSelector("#clarify-pop .ch-row", { timeout: 20_000 });
        };
        const popupStrip = () =>
          page.evaluate(() => {
            const el = document.querySelector("#clarify-pop #ch-shapes");
            return el && !el.hidden ? el.textContent.replace(/\s+/g, " ").trim() : null;
          });
        const popupShot = async () => {
          await page.locator("#clarify-pop").screenshot({ path: POPUP_SHOT });
          note(`capture: ${POPUP_SHOT}`);
        };
        await page.click("#btn-clarify");
        await openPopup();
        await waitFor(async () => Boolean(await popupStrip()), { timeoutMs: 20_000, stepMs: 200, what: "the popup's four-direction count" });
        let count = await popupStrip();
        ok("the popup prints the week's count", count === "four directions: 1 of 1 card this week", count || "(no count)");
        await popupShot();
        const historyOne = await HISTORY();
        ok("the history row carries the shape", historyOne.items[0]?.shape?.ok === true, JSON.stringify(historyOne.items[0]?.shape || null));
        ok("the route counts one four-direction card", historyOne.fourDirections?.week === 1 && historyOne.fourDirections?.weekCards === 1, JSON.stringify(historyOne.fourDirections));

        // ---- answer the four-kind card, the ordinary path --------------------------------------------------
        section("the complete card answers and settles");
        await page.click('.job[data-thread="th-shape"] .turn-question button.tq-choice[data-qvalue="Finish: land the shape check and stop (Recommended)"]');
        const answeredOne = await waitFor(async () => Boolean(await settled(CARDS[0].id)), { timeoutMs: 30_000, stepMs: 250, what: "the first card's answer to settle" });
        ok("the card settles with the chosen answer", Boolean(answeredOne) && stub.seen.answers.some((a) => a.id === "run-shape-1"), answeredOne ? `history: ${(await HISTORY()).items.find((i) => String(i.question).includes("Which direction next"))?.answer || "(no answer)"}` : "(no settlement)");
        ok("the stub received the answer for that run", stub.seen.answers.some((a) => String(a.value || a.answer || "").includes("Finish: land the shape check")), JSON.stringify(stub.seen.answers.at(-1) || null));

        // ---- card 2: two plain choices --------------------------------------------------------------------
        section("a two-choice card: short, and still a card");
        const reply2 = await POST("/api/agents/reply", { thread: THREAD, text: "GATE-SHAPE second pass" });
        ok("the next run starts on the same thread", reply2.status === 202, `HTTP ${reply2.status} ${reply2.body?.error || ""}`);
        const parked2 = await waitFor(() => ask(CARDS[1].id), { timeoutMs: 40_000, stepMs: 250, what: "the second card's clarify.request" });
        ok("the two-choice card is raised at all", Boolean(parked2), parked2 ? "parked" : "never arrived");
        if (!parked2) throw new Error("the two-choice card was never raised, which is the defect this gate exists to catch");
        ok("the verdict reads short", parked2.question?.shape?.ok === false, parked2.question?.shape?.line || "(no line)");
        await page.waitForFunction(
          (id) => [...document.querySelectorAll('.job[data-thread="th-shape"] .turn-question button.tq-choice')].some((b) => b.dataset.qrequest === id),
          CARDS[1].id,
          { timeout: 30_000 },
        );
        seen = await readCard();
        ok(
          "the strip reads short and names the missing kinds",
          seen.shape === "short: none of the 4 directions in 2 choices · missing Finish, Deeper, Route, Ask",
          seen.shape || "(no strip)",
        );
        ok("a short card is not painted as complete", seen.complete === false);
        ok("both of its choices are live", seen.choices.length === 2 && seen.choices.every((c) => !c.disabled), JSON.stringify(seen.choices));
        await openPopup();
        count = await waitFor(async () => ((await popupStrip()) === "four directions: 1 of 2 cards this week" ? await popupStrip() : false), { timeoutMs: 25_000, stepMs: 250, what: "the popup's count after the second card" });
        ok("the count moved to two cards", count === "four directions: 1 of 2 cards this week", count || "(no count)");

        // ---- answer it: the hard constraint, end to end ----------------------------------------------------
        section("the two-choice card answers and settles, as it always did");
        await page.click('.job[data-thread="th-shape"] .turn-question button.tq-choice[data-qvalue="the turn, and its tree"]');
        const answeredTwo = await waitFor(async () => Boolean(await settled(CARDS[1].id)), { timeoutMs: 30_000, stepMs: 250, what: "the two-choice card's answer to settle" });
        ok("a short card settles with the chosen answer", Boolean(answeredTwo) && stub.seen.answers.some((a) => a.id === "run-shape-2" && String(a.answer || "").includes("the turn")), answeredTwo ? `stub answer: ${stub.seen.answers.filter((a) => a.id === "run-shape-2").at(-1)?.answer || "(none)"}` : "(no settlement)");
        const historyTwo = await HISTORY();
        const rowTwo = historyTwo.items.find((i) => String(i.question).includes("Where should the record"));
        ok("its history row is answered", rowTwo?.state === "answered" && rowTwo?.answer === "the turn, and its tree", `${rowTwo?.state} / ${rowTwo?.answer}`);
        ok("and it still says the card was short", rowTwo?.shape?.ok === false, rowTwo?.shape?.line || "(no shape)");
        ok("the count is still one of two four-direction cards", historyTwo.fourDirections?.week === 1 && historyTwo.fourDirections?.weekCards === 2, JSON.stringify(historyTwo.fourDirections));

        // ---- card 3: out of order --------------------------------------------------------------------------
        section("an out-of-order card: flagged, never blocked");
        const reply3 = await POST("/api/agents/reply", { thread: THREAD, text: "GATE-SHAPE third pass" });
        ok("the third run starts", reply3.status === 202, `HTTP ${reply3.status} ${reply3.body?.error || ""}`);
        const parked3 = await waitFor(() => ask(CARDS[2].id), { timeoutMs: 40_000, stepMs: 250, what: "the third card's clarify.request" });
        ok("the out-of-order card is raised", Boolean(parked3), parked3 ? "parked" : "never arrived");
        if (!parked3) throw new Error("the out-of-order card was never raised");
        ok("the verdict flags the order, not the choices", parked3.question?.shape?.ordered === false && parked3.question?.shape?.missing?.length === 0, parked3.question?.shape?.line || "(no line)");
        await page.waitForFunction(
          (id) => [...document.querySelectorAll('.job[data-thread="th-shape"] .turn-question button.tq-choice')].some((b) => b.dataset.qrequest === id),
          CARDS[2].id,
          { timeout: 30_000 },
        );
        seen = await readCard();
        ok(
          "the strip says out of order and still names all four",
          seen.shape === "four directions, out of order: Deeper, Finish, Route, Ask · the recommended choice is not first",
          seen.shape || "(no strip)",
        );
        ok("every choice is still offered, none disabled", seen.choices.length === 4 && seen.choices.every((c) => !c.disabled), JSON.stringify(seen.choices.map((c) => c.disabled)));
        await openPopup();
        count = await waitFor(async () => ((await popupStrip()) === "four directions: 1 of 3 cards this week" ? await popupStrip() : false), { timeoutMs: 25_000, stepMs: 250, what: "the popup's count after the third card" });
        ok("the count moved to three cards, still one of them four-direction", count === "four directions: 1 of 3 cards this week", count || "(no count)");
        await popupShot();

        section("the out-of-order card answers and settles too");
        await page.click('.job[data-thread="th-shape"] .turn-question button.tq-choice[data-qvalue="Finish: land what is here and stop (Recommended)"]');
        const answeredThree = await waitFor(async () => Boolean(await settled(CARDS[2].id)), { timeoutMs: 30_000, stepMs: 250, what: "the third card's answer to settle" });
        ok("a flagged card settles with the chosen answer", Boolean(answeredThree) && stub.seen.answers.some((a) => a.id === "run-shape-3"), answeredThree ? `stub answer: ${stub.seen.answers.filter((a) => a.id === "run-shape-3").at(-1)?.answer || "(none)"}` : "(no settlement)");

        const finalHistory = await HISTORY();
        ok("every card asked this week is counted", finalHistory.fourDirections?.weekCards === 3, JSON.stringify(finalHistory.fourDirections));
        ok("and one of the three offered four directions", finalHistory.fourDirections?.week === 1, JSON.stringify(finalHistory.fourDirections));
        ok("the answered cards keep their verdicts in the store", finalHistory.items.filter((i) => i.shape && i.state === "answered").length === 3, `${finalHistory.items.filter((i) => i.shape && i.state === "answered").length} answered rows with a shape`);
        ok("the page threw nothing while drawing or answering the cards", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
      },
      { timeoutMs: 180_000 },
    );

    verdict = failures === 0 ? 0 : 1;
  } catch (e) {
    console.log(`FAIL  the gate threw: ${String((e && e.stack) || e)}`);
    failures += 1;
    verdict = 1;
  } finally {
    console.log(`\n${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ""}`);
    await panel.stop().catch(() => {});
    await stub.close().catch(() => {});
    if (!argv.includes("--keep")) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    else console.log(`kept: ${dir}`);
  }
  process.exit(verdict);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
