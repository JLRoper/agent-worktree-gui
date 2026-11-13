// The thinking toggle, switched on mid-stream, in a real browser: does it draw what is already there again?
//
//   node tools/verify-think-toggle-replay.mjs                 # drive this checkout, print the checks
//   node tools/verify-think-toggle-replay.mjs --base <dir>    # the same fixture against a `git archive` of the base
//                                                             # commit (the run is EXPECTED to fail there)
//
// WHAT THE BUG WAS. Pressing 🧠 while a turn runs repaints the card, and with the toggle off nothing had ever been
// handed to the word pacer, so every block the store already held was fed to it as NEW text: the pacer queued the
// turn's whole reasoning window and wrote it out from the first word. The reader asked for the pane to be switched
// on and got the transcript they were already reading, re-typed.
//
// WHAT IS DRIVEN. A sandbox panel of its own (spare port, own config/HERMES_HOME, no gateway key) serving the chosen
// checkout, a live turn fabricated in the page's own `state` and painted by the shipped `renderJobs()`, three
// 400-word reasoning blocks fulfilled from `/api/thinking` so the sweep's real `loadThinking` -> `paintThink` path
// runs, and the toggle pressed through the shipped `setThinking` (the 🧠 button's own click). The pacer, its clock
// and the DOM are the page's.
//
// WHAT IT ASSERTS (exit 1 while any check fails)
//   (1) every line already on the console before the press is still there, character for character, after it
//   (2) the blocks the store already held paint WHOLE at the press: only the newest thought is written
//   (3) the pacer holds ONE block, not the whole window (the count the old build failed on)
//   (4) a thought that arrives AFTER the press is still written word by word, and the older ones do not move
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installFakeEventSource, loadPlaywright } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const THREAD = "verify-toggle-thread";
const words = (tag, n) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");
// A live turn's blocks are 1-8 kB each (measured on this box: 58 blocks / 183 kB in one window). They have to be this
// long for a reason: at 40 words a second the pacer is still deep inside a block minutes after it arrived, so "the
// whole text" and "the prefix the clock reached" are two visibly different transcripts.
const BLOCK_A = words("alpha", 400);
const BLOCK_B = words("beta", 400);
const BLOCK_C = words("gamma", 400);
const BLOCK_D = words("delta", 400);
const AT_A = 1_760_000_000_000;
const AT_B = AT_A + 4_000;
const AT_C = AT_A + 8_000;
const AT_D = AT_A + 12_000;

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
  tmp = mkdtempSync(path.join(os.tmpdir(), "wtgui-toggle-replay-"));
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message)));

  await installFakeEventSource(context);
  await context.addInitScript(
    ({ thread, blocks: seed }) => {
      // A window this probe cannot see is not a window the reader sees: Chromium never paints an occluded page, and
      // `document.hidden` turns the pacing off, which would make every check pass for the wrong reason.
      try {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      } catch {
        /* a browser that refuses just runs the hidden path, and the run will say so */
      }
      const probe = { blocks: seed.map((b) => ({ at: b.at, text: b.text })) };
      window.__probe = probe;
      const realFetch = window.fetch.bind(window);
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      window.fetch = async (url, opts = {}) => {
        const u = String(url);
        if (String((opts && opts.method) || "GET").toUpperCase() !== "POST") {
          if (u.includes("/api/state")) {
            try {
              const d = await realFetch(url, opts).then((r) => r.json());
              return json({ ...d, jobs: [...state.jobs.values()] });
            } catch {
              return json({ jobs: [...state.jobs.values()] });
            }
          }
          if (u.includes("/api/thinking")) return json({ blocks: probe.blocks.map((x) => ({ at: x.at, text: x.text })) });
          return realFetch(url, opts);
        }
        return json({ ok: true });
      };
      // The toggle OFF before the reader presses it, and the 🌊 console on: a stream is where the reasoning joins the
      // transcript, and 40 words/s is the shipped default.
      try {
        localStorage.setItem("wtgui.think", "0");
        localStorage.setItem(`wtgui.think.${thread}`, "0");
        localStorage.setItem("wtgui.stream", "1");
        localStorage.setItem(`wtgui.stream.${thread}`, "1");
        localStorage.setItem("wtgui.autoCollect", "0");
        localStorage.setItem("wtgui.streamWords", "40");
      } catch {
        /* the page will just not remember it */
      }

      // A LIVE turn whose console already holds prose, a tool burst and the console's reasoning preview: the output
      // the reader is looking at when they press 🧠.
      probe.mount = () => {
        const id = "probe-toggle-turn";
        const lines = [
          { kind: "text", text: "Reading the tree before anything else.", lid: "t1" },
          { kind: "tool", text: "▸ read · public/app.js", at: Date.now() - 9000 },
          { kind: "tool-out", text: "  ↳ read · 0.42s" },
          { kind: "think", text: "a preview of a thought, one line of it" },
          { kind: "text", text: "Nothing odd so far.", lid: "t2" },
        ];
        state.jobs.clear();
        state.jobLines.clear();
        state.thinkCache.clear();
        state.thinkOpen.clear();
        state.thinkClosed.clear();
        state.pinnedTurns?.clear?.();
        state.typeStream?.releaseAll();
        state.jobLines.set(id, lines);
        state.jobs.set(id, {
          id,
          thread,
          turn: 1,
          status: "running",
          prompt: "toggle replay probe",
          displayPrompt: "toggle replay probe",
          cwd: null,
          worktree: false,
          worktreePath: null,
          projectPath: null,
          ownerPath: null,
          branch: null,
          runId: "run_probe_toggle",
          startedAt: new Date(Date.now() - 90_000).toISOString(),
          endedAt: null,
          model: "probe/model",
          lines: [],
          artifacts: [],
          attachments: [],
          subagents: [],
        });
        renderJobs();
        return document.querySelectorAll("pre.job-out").length;
      };

      // The console as the reader sees it: every row's own words, and the reasoning rows by lid.
      probe.read = () => {
        const out = document.querySelector("pre.job-out");
        const rows = out ? [...out.children] : [];
        const reasoning = [];
        for (const el of rows) {
          const lid = el.dataset.lid || "";
          if (!lid.startsWith("think:")) continue;
          reasoning.push({ lid, len: (el.innerText || "").length });
        }
        return {
          rows: rows.map((el) => ({ cls: el.className, lid: el.dataset.lid || "", text: el.innerText || "" })),
          reasoning,
          pacer: { size: state.typeStream.size(), pending: state.typeStream.pendingWords(), rate: state.typeStream.rate() },
          fed: [...state.thinkFed],
        };
      };

      // The 🧠 press, through the page's own handler: the button is the reader's control, not a function call.
      probe.press = () => {
        const btn = document.querySelector("[data-think-thread]");
        if (!btn) return false;
        btn.click();
        return true;
      };

      // A thought written AFTER the press: the store appends a block, the sweep's clock re-reads it, its own draw
      // path types it.
      probe.think = () => {
        probe.blocks.push({ at: probe.nextAt, text: probe.nextText });
        return probe.blocks.length;
      };
      probe.nextAt = 0;
      probe.nextText = "";
    },
    {
      thread: THREAD,
      blocks: [
        { at: AT_A, text: BLOCK_A },
        { at: AT_B, text: BLOCK_B },
        { at: AT_C, text: BLOCK_C },
      ],
    },
  );

  await page.goto(panel.base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof renderJobs === "function" && typeof state === "object", null, { timeout: 30_000 });
  await sleep(500);
  const mounted = await page.evaluate(() => window.__probe.mount());
  check("(0) the fabricated live turn draws its console", mounted === 1, `console boxes: ${mounted}`);
  if (mounted !== 1) throw new Error("the probe could not draw a card - the render contract moved");

  // Let the sweep read the store once and paint the console with the turn's own lines (the toggle is still off).
  await sleep(2500);
  const before = await page.evaluate(() => window.__probe.read());
  check(
    "(0) the transcript is on screen before the press",
    before.rows.length >= 4 && before.pacer.size === 0 && before.reasoning.length === 0,
    `${before.rows.length} rows, pacer ${before.pacer.size}, reasoning rows ${before.reasoning.length}`,
  );

  const pressed = await page.evaluate(() => window.__probe.press());
  check("(0) the 🧠 button is there and is what was pressed", pressed === true);
  await sleep(400);
  const after = await page.evaluate(() => window.__probe.read());

  // (1) NOTHING ALREADY ON SCREEN IS RE-EMITTED. Every row the reader could see before the press is still there with
  // exactly its own words; the reasoning rows are additions, never replacements.
  const lost = before.rows.filter((b) => b.text && !after.rows.some((a) => a.text === b.text));
  check(
    "(1) every line already on the console is untouched by the press",
    lost.length === 0,
    lost.length ? `${lost.length} row(s) changed: ${lost.map((l) => JSON.stringify(l.text.slice(0, 40))).join(", ")}` : `${before.rows.length} rows identical`,
  );

  // (2) ONLY THE NEWEST THOUGHT IS WRITTEN. The two older blocks paint whole at once; the newest starts at its first word.
  const len = (at) => after.reasoning.find((r) => r.lid === `think:${at}`)?.len ?? -1;
  check(
    "(2) the block the store already held paints whole",
    len(AT_A) === BLOCK_A.length && len(AT_B) === BLOCK_B.length,
    `oldest ${len(AT_A)}/${BLOCK_A.length} chars, next ${len(AT_B)}/${BLOCK_B.length}`,
  );
  check(
    "(2) the newest thought is the one being written",
    len(AT_C) >= 0 && len(AT_C) < BLOCK_C.length,
    `newest ${len(AT_C)}/${BLOCK_C.length} chars 400 ms after the press`,
  );

  // (3) THE COUNT THE OLD BUILD FAILED ON: one paced block, not the window.
  check(
    "(3) the pacer holds ONE block, not the whole reasoning window",
    after.pacer.size === 1 && after.fed.length === 1 && after.fed[0] === `think:${AT_C}`,
    `pacer ${after.pacer.size}, ${after.pacer.pending} words queued, fed ${JSON.stringify(after.fed)}`,
  );

  // (4) THE TOGGLE STILL DOES ITS JOB: output that arrives after it is written, and the history does not move for it.
  const historyAtPress = { a: len(AT_A), b: len(AT_B), c: len(AT_C) };
  await sleep(2600);
  const grew = await page.evaluate(() => window.__probe.read());
  const len2 = (at) => grew.reasoning.find((r) => r.lid === `think:${at}`)?.len ?? -1;
  check(
    "(4) the newest thought keeps being written after the press",
    len2(AT_C) > historyAtPress.c,
    `${historyAtPress.c} -> ${len2(AT_C)} chars in 2.6 s at 40 words/s`,
  );
  check(
    "(4) the history does not move while it does",
    len2(AT_A) === BLOCK_A.length && len2(AT_B) === BLOCK_B.length,
    `oldest ${len2(AT_A)}, next ${len2(AT_B)} chars`,
  );

  // The turn thinks again: a fourth block lands in the store and the sweep re-reads it. It is the newest, so it is the
  // one written now - and the block that was the live edge keeps the prefix it had.
  const cAtPress = len2(AT_C);
  await page.evaluate(
    ({ at, text }) => {
      window.__probe.nextAt = at;
      window.__probe.nextText = text;
      window.__probe.think();
    },
    { at: AT_D, text: BLOCK_D },
  );
  await sleep(3000);
  const arrived = await page.evaluate(() => window.__probe.read());
  const len3 = (at) => arrived.reasoning.find((r) => r.lid === `think:${at}`)?.len ?? -1;
  check(
    "(4) a thought that arrives after the switch is written",
    len3(AT_D) > 0 && len3(AT_D) < BLOCK_D.length,
    `newest ${len3(AT_D)}/${BLOCK_D.length} chars`,
  );
  check(
    "(4) and the thought it followed is not re-written for it",
    len3(AT_C) >= cAtPress,
    `${cAtPress} -> ${len3(AT_C)} chars (never shorter)`,
  );

  check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | ") || "0");

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks pass${failed.length ? `, ${failed.length} FAIL` : ""}${BASE ? ` (against ${BASE})` : ""}`);
  await cleanup();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error("VERIFY FAILED", e);
  await cleanup();
  process.exit(1);
});
