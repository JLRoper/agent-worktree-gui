// The 🧠 on each of the four assistant cards, pressed once in a real browser, with the reasoning read the way the
// store really answers.
//
//   node tools/verify-think-toggle-cards.mjs                 # this checkout, print the checks
//   node tools/verify-think-toggle-cards.mjs --base <dir>    # the same probe against a `git archive` of the base
//                                                            # commit (the run is EXPECTED to fail there)
//
// WHAT THE BUG WAS. The press wrote `wtgui.think.<card thread>` and the block drew itself when
// `thinkingOn(turn.thread || turn.id)` said so, while the reasoning was read from the store under that same
// turn-derived value. An assistant's turns do not run under the panel's thread: the gateway names their session from
// the prompt (`wtgui-continue-...`), so three of the four cards asked the store for a session that recorded nothing in
// that turn's window and drew "none recorded" while their reasoning sat in the store under the session they actually
// ran under. Only the assistant whose session happened to equal its thread - #2 - looked like it toggled.
//
// WHAT IS DRIVEN. A sandbox panel of its own (spare port, own config and HERMES_HOME, no gateway key), four cards
// mounted in the page's own `state` and painted by the shipped `renderJobs()`: Assistant #1, #2, #3 and the Director,
// each with two turns whose `sessionId` is the session the real panel records for that thread. `/api/thinking` is
// answered with the store's own rule - rows exist under the SESSION, none under the panel thread - and every request
// is recorded, so the run can say which value the page asked for. Each press is the reader's: a click on the card's
// own 🧠 button, through the shipped handler.
//
// WHAT IT ASSERTS (exit 1 while any check fails)
//   (1) every card draws a reasoning block after one press
//   (2) every block holds the reasoning the store holds for that turn (not "none recorded")
//   (3) the value the page asked the store for is the turn's SESSION, on every card
//   (4) a second press takes the block away again, on every card
//
// HARNESS: LIVE GATE - it tracks main (a fresh sandbox panel, no recorded commit), and `npm run verify:think-toggle-cards`
// runs it by name.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installFakeEventSource, loadPlaywright } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The four assistants on the reading panel, as its store records them: the panel thread, the session its turns ran
// under, and how many reasoning blocks the store holds for that turn's window (measured against the live store).
const CARDS = [
  { thread: "panel-assistant", session: "wtgui-continue-if-you-can-exit-if-d24702", blocks: 2 },
  { thread: "panel-assistant-2", session: "panel-assistant-2", blocks: 3 },
  { thread: "panel-assistant-3", session: "wtgui-continue-if-you-can-exit-if-8c0a35", blocks: 15 },
  { thread: "panel-assistant-5", session: "wtgui-continue-if-you-can-exit-if-062ff1", blocks: 5 },
];
const WAIT_MS = 12_000;

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const BASE = opt("--base");

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

let browserRef = null;
let panel = null;
let tmp = null;
async function cleanup() {
  try {
    if (browserRef) await browserRef.close();
  } catch {
    /* already gone */
  }
  try {
    if (panel) await panel.stop();
  } catch {
    /* already gone */
  }
  try {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* a locked scratch file is not worth failing the run */
  }
}
process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

async function main() {
  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN: no playwright on this box (set PANEL_PLAYWRIGHT_ROOT)");
    process.exit(2);
  }
  tmp = mkdtempSync(path.join(os.tmpdir(), "wtgui-toggle-cards-"));
  panel = await startPanel({ root: BASE || undefined, config: { scanRoots: [path.join(tmp, "repos")] } });
  const browser = await pw.chromium.launch({
    headless: true,
    args: [
      "--disable-features=OverlayScrollbar,FluentOverlayScrollbar,FluentScrollbar",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
    ],
  });
  browserRef = browser;
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message)));

  await installFakeEventSource(context);
  await context.addInitScript(
    ({ cards }) => {
      // A window this probe cannot see is not a window the reader sees: Chromium never paints an occluded page and
      // `document.hidden` turns the pacing off.
      try {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      } catch {
        /* a browser that refuses just runs the hidden path, and the run will say so */
      }
      const probe = { cards, asks: [], served: [] };
      window.__probe = probe;
      const realFetch = window.fetch.bind(window);
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      // The store's own rule, measured on the live panel: reasoning rows hang off the SESSION a turn ran under. The
      // panel thread answers nothing, which is exactly what made three of four cards read "none recorded".
      window.fetch = async (url, opts = {}) => {
        const u = String(url);
        if (String((opts && opts.method) || "GET").toUpperCase() !== "POST" && u.includes("/api/thinking")) {
          const asked = new URL(u, location.origin).searchParams.get("thread") || "";
          const card = cards.find((c) => c.session === asked || c.thread === asked);
          probe.asks.push(asked);
          const found = card && asked === card.session ? card : null;
          const blocks = found
            ? Array.from({ length: found.blocks }, (_, i) => ({ at: 1_760_000_000_000 + i * 4000, text: `${found.thread} thought ${i + 1}, recorded under the session it ran in` }))
            : [];
          if (found) probe.served.push(found.thread);
          return json({ blocks, error: null });
        }
        if (String((opts && opts.method) || "GET").toUpperCase() !== "POST" && u.includes("/api/state")) {
          try {
            const d = await realFetch(url, opts).then((r) => r.json());
            return json({ ...d, jobs: [...state.jobs.values()] });
          } catch {
            return json({ jobs: [...state.jobs.values()] });
          }
        }
        return realFetch(url, opts);
      };

      // The four cards, in the page's own state, painted by the shipped renderer. Two turns each so the card is a
      // conversation and not a single row, and the newest turn is the one drawn open.
      probe.mount = () => {
        state.assistant = { assistants: [] };
        state.assistantThread = null;
        state.jobs.clear();
        state.jobLines.clear();
        state.thinkCache.clear();
        state.thinkOpen.clear();
        state.thinkClosed.clear();
        state.pinnedTurns?.clear?.();
        state.typeStream?.releaseAll?.();
        const now = Date.now();
        for (const c of cards) {
          const shape = (n, age) => ({
            id: `${c.thread}-t${n}`,
            thread: c.thread,
            sessionId: c.session,
            turn: n,
            status: "done",
            prompt: `${c.thread} probe turn ${n}`,
            cwd: null,
            worktree: false,
            worktreePath: null,
            projectPath: null,
            ownerPath: null,
            branch: null,
            runId: null,
            startedAt: new Date(now - age).toISOString(),
            endedAt: new Date(now - age + 20_000).toISOString(),
            model: "probe/model",
            exitCode: 0,
            lines: [],
            artifacts: [],
            attachments: [],
            subagents: [],
          });
          const older = shape(1, 120_000);
          const latest = shape(2, 60_000);
          state.jobs.set(older.id, older);
          state.jobs.set(latest.id, latest);
        }
        renderJobs();
        return document.querySelectorAll(".job[data-thread]").length;
      };

      // What the reader sees on one card: the switch's own state, the block, and the reasoning rows inside it.
      probe.read = (thread) => {
        const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
        const det = card?.querySelector("details.think");
        return {
          card: Boolean(card),
          on: typeof thinkingOn === "function" ? thinkingOn(thread) : null,
          btnOn: Boolean(card?.querySelector("[data-think-thread]")?.classList.contains("is-on")),
          details: card ? card.querySelectorAll("details.think").length : -1,
          blocks: det ? [...det.querySelectorAll(".think-block[data-lid]")].map((el) => el.dataset.lid) : [],
          meta: det?.querySelector(".think-meta")?.textContent || "",
          storeKey: card?.querySelector("[data-think-thread]")?.dataset.thinkThread || "",
        };
      };

      // The press the reader makes: the card's own 🧠 button, through the shipped delegated handler.
      probe.press = (thread) => {
        const btn = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"] [data-think-thread]`);
        if (!btn) return false;
        btn.click();
        return true;
      };
    },
    { cards: CARDS },
  );

  await page.goto(panel.base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof renderJobs === "function" && typeof state === "object", null, { timeout: 30_000 });
  await sleep(400);
  const mounted = await page.evaluate(() => window.__probe.mount());
  check("(0) the four cards draw", mounted === CARDS.length, `${mounted} of ${CARDS.length} cards`);
  if (mounted !== CARDS.length) throw new Error("the probe could not draw four cards - the render contract moved");
  await sleep(1500);

  // (1) ONE PRESS ON EACH CARD, INCLUDING THE DIRECTOR'S.
  const drawn = [];
  for (const card of CARDS) {
    const before = await page.evaluate((t) => window.__probe.read(t), card.thread);
    check(`(1) ${card.thread}: no block before the press`, before.details === 0 && before.on === false, `details ${before.details}, switch ${before.on}`);
    const pressed = await page.evaluate((t) => window.__probe.press(t), card.thread);
    if (!pressed) throw new Error(`no 🧠 button on ${card.thread}`);
    const began = Date.now();
    let after = null;
    while (Date.now() - began < WAIT_MS) {
      after = await page.evaluate((t) => window.__probe.read(t), card.thread);
      if (after.details === 1 && after.blocks.length >= card.blocks) break;
      await sleep(150);
    }
    drawn.push({ card, after, ms: Date.now() - began });
    check(
      `(1) ${card.thread}: one press draws its reasoning block`,
      after.details === 1,
      `${after.details} block(s) after ${Date.now() - began} ms`,
    );
    check(
      `(2) ${card.thread}: the block holds the reasoning the store holds`,
      after.blocks.length === card.blocks,
      `${after.blocks.length} of ${card.blocks} blocks, meta "${(after.meta || "").trim()}" after ${Date.now() - began} ms`,
    );
    check(`(1) ${card.thread}: the switch and the block are on the card's own thread`, after.storeKey === card.thread && after.on === true, `button key ${after.storeKey}`);
  }

  // (3) THE STORE WAS ASKED FOR THE SESSION THE TURN RAN UNDER, on every card.
  const asks = await page.evaluate(() => window.__probe.asks);
  const served = await page.evaluate(() => window.__probe.served);
  for (const card of CARDS) {
    check(
      `(3) ${card.thread}: the store was read under the turn's session`,
      asks.includes(card.session),
      `asked ${JSON.stringify([...new Set(asks.filter((a) => a === card.thread || a === card.session))])}`,
    );
  }
  check("(3) every card's reasoning was served", served.length >= CARDS.length && CARDS.every((c) => served.includes(c.thread)), `${served.length} served: ${[...new Set(served)].join(", ")}`);

  // (4) THE SECOND PRESS TAKES IT AWAY AGAIN, on every card.
  for (const { card } of drawn) {
    await page.evaluate((t) => window.__probe.press(t), card.thread);
    const began = Date.now();
    let after = null;
    while (Date.now() - began < WAIT_MS) {
      after = await page.evaluate((t) => window.__probe.read(t), card.thread);
      if (after.details === 0 && after.on === false) break;
      await sleep(150);
    }
    check(
      `(4) ${card.thread}: a second press takes the block away`,
      after.details === 0 && after.on === false,
      `details ${after.details}, switch ${after.on} after ${Date.now() - began} ms`,
    );
  }

  check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | ") || "0");

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks pass${failed.length ? `, ${failed.length} FAIL` : ""}${BASE ? ` (against ${BASE})` : ""}`);
  return failed.length ? 1 : 0;
}

try {
  const code = await main();
  await cleanup();
  process.exit(code);
} catch (err) {
  console.error(`\nVERIFY FAILED: ${err?.message || err}`);
  await cleanup();
  process.exit(1);
}
