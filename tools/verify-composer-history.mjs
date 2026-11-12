// Up/Down in a composer walks ONE session's history, newest first, in a real browser with two composers.
// HARNESS: LIVE GATE
//
// WHY THIS EXISTS. The walk (`public/app.js` turnPrompts / recallReply) is the one composer gesture whose input is two
// records - the panel's turn store and this browser's own localStorage list - so a unit test can prove the merge but
// not the thing the reader sees: two composers side by side, each pressing Up. This gate boots a sandbox panel of THIS
// checkout holding two conversations, drives both boxes in Chromium, and captures the recalled text:
//
//   (a) alpha's newest entry is typed IN THE BOX (a real Enter, in the real composer) and Up reads it, not the turn
//       prompt above it;
//   (b) beta's newest turn carries NO turn number and Up still reads it, because its clock - not turn 0 - places it;
//   (c) neither walk ever shows the other session's text, at any step, and Down walks back toward the newest and then
//       to the empty draft without ever crossing into the other session;
//   (d) the panel's own collected-subagent paragraphs are still refused (the older rule, unchanged).
//
//   node tools/verify-composer-history.mjs                          boot a sandbox panel of this checkout
//   PROBE_CAPTURES=1 node tools/verify-composer-history.mjs         also write the before/after PNGs (PROBE_OUT dir)
//   node tools/verify-composer-history.mjs --base-app <app.js>      serve an OLDER public/app.js to the same page and
//                                                                   report these checks against it (the red proof:
//                                                                   max(0) failures on the fixed build, and beta's
//                                                                   no-turn check must fail on the old one)
//
// The browser half needs a Playwright install; without one this says BROWSER-HALF-NOT-RUN and exits 2 rather than
// passing on a half that never ran. Nothing here writes to the repository: the panel, its store and its captures all
// live in a scratch directory.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startPanel, ROOT } from "./panel-testkit.mjs";
import { loadPlaywright, notRun } from "./browser.mjs";

const TREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const BASE_APP = opt("--base-app");
const OUT = String(process.env.PROBE_OUT || "").trim() || path.join(tmpdir(), "wtgui-composer-history");
const WRITE_CAPTURES = String(process.env.PROBE_CAPTURES || "") === "1";

const ALPHA = "wtgui-alpha-1111";
const BETA = "wtgui-beta-2222";
const ALPHA_TYPED = "ALPHA typed here, in this box";
const BETA_NO_TURN = "BETA third, with no turn number";

let checks = 0;
let failures = 0;
const check = (name, got, want) => {
  checks += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  const brief = (v) => {
    const s = JSON.stringify(v);
    return s && s.length > 160 ? `${s.slice(0, 110)} ...(${s.length} chars)` : s;
  };
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${brief(got)}${ok ? "" : ` (wanted ${brief(want)})`}`);
};
const note = (msg) => console.log(`        ${msg}`);

// ---- the fixture: two conversations, their clocks interleaved ------------------------------------------------------
// Both cards are DONE (nothing is running, so Up is the only thing driving either box) and homeless (no tree), which
// is the shape the board draws in its unattached list. `startedAt` is the clock the walk merges on.
function fixture() {
  const now = Date.now();
  const ago = (mins) => new Date(now - mins * 60_000).toISOString();
  const line = (text) => [{ kind: "text", text }];
  const job = (o) => ({
    status: "done",
    yolo: false,
    origin: null,
    runId: null,
    cwd: null,
    ownerPath: null,
    projectPath: null,
    lines: line(o.prompt),
    ...o,
  });
  return {
    savedAt: new Date(now).toISOString(),
    jobs: [
      job({ id: "a1", thread: ALPHA, turn: 1, prompt: "ALPHA first, sent as a turn", startedAt: ago(30), endedAt: ago(29) }),
      job({ id: "b1", thread: BETA, turn: 1, prompt: "BETA first, sent as a turn", startedAt: ago(25), endedAt: ago(24) }),
      job({ id: "a2", thread: ALPHA, turn: 2, prompt: "ALPHA second, sent as a turn", startedAt: ago(20), endedAt: ago(19) }),
      job({ id: "b2", thread: BETA, turn: 2, prompt: "BETA second, sent as a turn", startedAt: ago(15), endedAt: ago(14) }),
      // The number was never written for this one. `(turn || 0)` sorted it in front of beta's whole history; its
      // clock is what says it is the newest turn in the session.
      job({ id: "b3", thread: BETA, prompt: BETA_NO_TURN, startedAt: ago(5), endedAt: ago(4) }),
    ],
  };
}

const boxSel = (thread) => `.reply-box[data-reply="${thread}"]`;
const cardSel = (thread) => `.job[data-thread="${thread}"]`;
const readBox = (page, thread) =>
  page.evaluate((sel) => {
    const api = window.WMApp?.board?.pasteChips;
    const box = document.querySelector(sel);
    return api && box ? api.readBox(box) : box?.textContent ?? null;
  }, boxSel(thread));

// A capture of one card, so the recalled text is visible beside the composer it came from.
const shot = async (page, thread, name) => {
  if (!WRITE_CAPTURES) return null;
  mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, name);
  const card = await page.$(cardSel(thread));
  if (card) await card.screenshot({ path: file });
  else await page.screenshot({ path: file });
  note(`capture ${file}`);
  return file;
};

// Press Up/Down the way the reader does: with the box focused and the caret where the walk left it.
async function press(page, thread, key) {
  await page.focus(boxSel(thread));
  await page.keyboard.press(key);
  await page.waitForTimeout(60);
}
// A real send from the real composer. With no gateway in the sandbox the reply is refused, and the acceptance is the
// panel's own: what the reader typed is in the browser's history the moment the press lands.
async function typeAndSend(page, thread, text) {
  await page.click(boxSel(thread));
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
  // Clear whatever the refusal left behind (a refused reply comes back as the draft), so the walk starts from empty.
  await page.click(boxSel(thread));
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await page.waitForTimeout(60);
}

let panel = null;
let browser = null;
try {
  const dir = path.join(OUT, "panel");
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify(fixture(), null, 0), "utf8");
  panel = await startPanel({ dir, keep: true, config: { assistant: { enabled: false, seconds: 3600, maxWakesPerHour: 0 } } });
  note(`panel ${panel.base} (${TREE})`);
  note(`store ${path.join(dir, "logs", "jobs.json")}`);

  const pw = loadPlaywright({ root: TREE });
  if (!pw) {
    console.log(notRun("composer history", "no Playwright install found; set PANEL_PLAYWRIGHT_ROOT"));
    process.exitCode = 2;
  } else {
    browser = await pw.chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    // --base-app: the same page, the same fixture, an older app.js. A real browser read of the build this fixes,
    // without touching a file in the tree.
    if (BASE_APP) {
      const src = readFileSync(path.resolve(BASE_APP), "utf8");
      let served = 0;
      await page.route(/\/app\.js(\?.*)?$/, (route) => {
        served += 1;
        return route.fulfill({ status: 200, contentType: "application/javascript", headers: { "cache-control": "no-store" }, body: src });
      });
      note(`app.js SERVED FROM ${path.resolve(BASE_APP)} (base-build proof)`);
      page.on("close", () => note(`base app.js requests answered: ${served}`));
    }
    await page.goto(`${panel.base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction((sel) => Boolean(window.WMApp?.board?.pasteChips) && Boolean(document.querySelector(sel)), cardSel(ALPHA), { timeout: 30_000 });
    await page.waitForSelector(boxSel(BETA), { state: "visible", timeout: 30_000 });
    note(`two composers on the board: alpha and beta`);
    // Which app.js the page is running. Without this, a --base-app run whose route did not take would report the FIXED
    // build's results as the base build's, which is the one way a red proof can lie.
    const shape = await page.evaluate(() => ({ entries: typeof window.replyHistoryEntries, clock: typeof window.promptClock }));
    check(
      "the page is running the build this run means to test",
      [shape.entries, shape.clock],
      BASE_APP ? ["undefined", "undefined"] : ["function", "function"],
    );

    // ---- (a) the newest entry was typed here --------------------------------------------------
    console.log("\n== (a) alpha: the newest entry is typed in the box, and Up reads it ==");
    await typeAndSend(page, ALPHA, ALPHA_TYPED);
    await press(page, ALPHA, "ArrowUp");
    check("alpha Up 1: the words typed here, not the turn below them", await readBox(page, ALPHA), ALPHA_TYPED);
    await shot(page, ALPHA, "1-alpha-newest-typed-here.png");
    check("alpha Up 1 carries nothing from beta", /BETA/.test(await readBox(page, ALPHA)), false);

    // ---- (b) a turn with no number ------------------------------------------------------------
    console.log("\n== (b) beta: its newest turn has no turn number and is still the newest ==");
    await press(page, BETA, "ArrowUp");
    check("beta Up 1: the turn with no number", await readBox(page, BETA), BETA_NO_TURN);
    await shot(page, BETA, "2-beta-newest-no-turn.png");
    check("beta Up 1 carries nothing from alpha", /ALPHA/.test(await readBox(page, BETA)), false);
    // And alpha's box is untouched by beta's press: two composers, two walks.
    check("beta's press left alpha's box alone", await readBox(page, ALPHA), ALPHA_TYPED);

    // ---- (c) the rest of both walks, step by step ---------------------------------------------
    console.log("\n== (c) both walks: newest first, then older, never the other session ==");
    const alphaWalk = [await readBox(page, ALPHA)];
    for (let i = 0; i < 2; i += 1) {
      await press(page, ALPHA, "ArrowUp");
      alphaWalk.push(await readBox(page, ALPHA));
    }
    check("alpha Up 1..3: typed here, then its two turns, newest first", alphaWalk, [
      ALPHA_TYPED,
      "ALPHA second, sent as a turn",
      "ALPHA first, sent as a turn",
    ]);
    check("alpha's walk never reads beta's words", alphaWalk.some((t) => /BETA/.test(t)), false);
    await shot(page, ALPHA, "3-alpha-oldest-step.png");

    const betaWalk = [await readBox(page, BETA)];
    for (let i = 0; i < 2; i += 1) {
      await press(page, BETA, "ArrowUp");
      betaWalk.push(await readBox(page, BETA));
    }
    check("beta Up 1..3: the unnumbered turn, then the two numbered ones", betaWalk, [
      BETA_NO_TURN,
      "BETA second, sent as a turn",
      "BETA first, sent as a turn",
    ]);
    check("beta's walk never reads alpha's words", betaWalk.some((t) => /ALPHA/.test(t)), false);
    await shot(page, BETA, "4-beta-oldest-step.png");

    // ---- Down: back toward the newest, then the empty draft, never across sessions -------------
    await press(page, ALPHA, "ArrowDown");
    check("alpha Down from the oldest steps toward the newest", await readBox(page, ALPHA), "ALPHA second, sent as a turn");
    await press(page, ALPHA, "ArrowDown");
    await press(page, ALPHA, "ArrowDown");
    check("alpha Down past the newest is the empty draft again", await readBox(page, ALPHA), "");
    await press(page, ALPHA, "ArrowDown");
    check("alpha Down at the draft stays at the draft", await readBox(page, ALPHA), "");
    check("and beta's box was not moved by alpha's Downs", /BETA/.test(await readBox(page, BETA)), true);

    // ---- (d) the panel's own paragraphs are still refused --------------------------------------
    console.log("\n== (d) the panel's own collected-subagent text is not on the walk ==");
    check("no walk of either session carries the panel's subagent prompt", [...alphaWalk, ...betaWalk].some((t) => /subagents? you delegated/.test(t)), false);
    check("the page threw nothing while the two composers walked", pageErrors, []);
    await shot(page, ALPHA, "5-alpha-back-at-draft.png");
  }
} catch (e) {
  failures += 1;
  console.log(`FAIL  the gate itself stopped: ${String((e && e.message) || e)}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (panel) await panel.stop().catch(() => {});
}

console.log(`\n${checks - failures}/${checks} checks passed${BASE_APP ? " (base-build proof)" : ""}`);
if (BASE_APP) {
  console.log(failures ? `RED AS EXPECTED on ${path.basename(BASE_APP)}: ${failures} check(s) failed` : "the base build passed every check, which means this gate cannot see the defect");
  process.exitCode = failures ? 0 : 3;
} else {
  process.exitCode = failures ? 1 : 0;
}
