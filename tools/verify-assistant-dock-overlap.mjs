#!/usr/bin/env node
// The assistant chat's last message, proved readable above the composer — in BOTH frames, at two widths.
//
//   node tools/verify-assistant-dock-overlap.mjs
//   node tools/verify-assistant-dock-overlap.mjs --root <export dir>     # serve a `git archive` of another build
//   node tools/verify-assistant-dock-overlap.mjs --shots <dir>           # where the screenshots go
//   node tools/verify-assistant-dock-overlap.mjs --json <file>           # keep the raw ledger
//
// THE DEFECT. With the assistant docked at the right, its chat sub-pane open and the transcript longer than the
// scrollport, the newest turn's message ended up UNDER the reply composer: the composer is `position: sticky;
// bottom: 0` (public/style.css, the chat block), and the newest turn — the one `public/assistant.js` marks
// `.is-slack` so that room the panel gains lands in its console — was `flex: 1 1 auto`. In an OVERFLOWING flex
// column there is no room to gain, so the shrink factor spent the overflow on that one turn: it collapsed to a
// zero-height box and its console (min-height 34px) painted OUTSIDE its own box, directly behind the sticky
// composer. The last line of the newest turn was the thing hidden, at every width and in both frames.
//
// WHAT IS MEASURED, per case: the newest message is the last painted line inside the newest turn's console. Its
// `getBoundingClientRect().bottom` against the composer's `top` is the overlap — positive means hidden, and the
// gate requires zero. The scroll container's `scrollHeight`, `clientHeight` and computed `padding-bottom` are
// reported beside it, so the numbers the report quotes can be read back from the run.
//
// MEASURED, on a `git archive` of 0.79.0 (the base), four cases — docked and floating, 1600 and 1280 px:
// the overlap was +31 px in every one (scrollHeight 3392 px, clientHeight 718 px docked / 631 px floating,
// padding-bottom 0), and the gate exits 1. On this branch the same four cases read −40.3 px (−40.05 px at
// floating 1280) with scrollHeight 4482 px, and it exits 0. The composer's top is unchanged (880.45 px docked,
// 779.7 px floating): the message moved above it, the composer did not move.
//
// THE FIX this gate pins is the `.is-slack` declaration: grow into spare room, never shrink below the turn's own
// content (`flex: 1 0 auto`). The turn then keeps its full height when the transcript overflows, the composer
// sits after it at the foot of the scrollport, and the last line is above the composer — no reserved pixel
// constant anywhere, so the two windows and the two frames are the same rule at different sizes.
//
// WHAT IS DRIVEN: a throwaway panel of its own (tools/panel-testkit.mjs — free port, own PANEL_CONFIG /
// HERMES_HOME / jobs.json / projects cache), a dead apiServer and the board assistant OFF so no gateway is
// called, and a seeded job store of FOUR settled turns in the rail's own thread. The two turns BEFORE the newest
// are expanded through the board's own turn head, the newest is open by default, so the transcript is longer
// than the viewport and the newest message is the last thing in it. The transcript is then taken to its foot the
// way the page's own pin does (`scrollTop = scrollHeight`), which is the state a reader lands in when a new
// message arrives.
//
// EXIT CODES: 0 every case held; 1 a case failed; 2 the run did not measure what it claims (no Playwright, or a
// case that never got its fixture on the page) — a green run can never be a pass on an empty page.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SHOTS = path.resolve(opt("--shots", path.join(tmpdir(), "wtgui-assistant-dock-overlap-shots")));
const JSON_OUT = opt("--json");
const WIDTHS = [1600, 1280];
const HEIGHT = 1000;
const THREAD = "panel-assistant";
const TURNS = 4;
const LINES_PER_TURN = 30;
const RAIL_PX = 480;

let checks = 0;
let failures = 0;
let measured = 0;
const out = { tree: TREE, cases: [], errors: [], notMeasured: [] };

function check(ok, label, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}
const note = (text) => console.log(`      ${text}`);

// ---- the fixture: four settled turns in the assistant's own thread -------------------------------
// Thirty lines a turn is the reader's condition, not a stress case: two of them open blow past any window,
// which is what makes the newest turn compete for room in the first place.
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-dock-overlap-"));
mkdirSync(path.join(dir, "logs"), { recursive: true });
const now = Date.now();
const fixtureTree = path.join(dir, "fixture-tree");
const jobs = [];
for (let i = 0; i < TURNS; i += 1) {
  const at = now - (TURNS - i) * 600_000;
  const lines = [];
  for (let n = 1; n <= LINES_PER_TURN; n += 1) {
    lines.push({
      kind: "out",
      text: `turn ${i + 1} line ${n} — the newest line of the newest turn is the one the composer must never cover`,
      lid: i * 1000 + n,
      at: at + n * 1000,
    });
  }
  jobs.push({
    id: `tkoverlap${i + 1}`,
    thread: THREAD,
    turn: i + 1,
    prompt: `fixture turn ${i + 1}`,
    status: "done",
    exitCode: 0,
    startedAt: new Date(at).toISOString(),
    endedAt: new Date(at + 30_000).toISOString(),
    durationMs: 30_000,
    finalMessage: "done",
    cwd: fixtureTree,
    ownerPath: fixtureTree,
    worktreePath: fixtureTree,
    worktree: path.basename(fixtureTree),
    lines,
  });
}
writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify({ savedAt: new Date(now).toISOString(), jobs }, null, 1));

// The kit beside the checkout being SERVED, not beside this file: `--root` has to boot the base's own
// server.js, lib/ and public/ or the comparison would prove nothing.
const { freePort, startPanel } = await import(pathToFileURL(path.join(TREE, "tools", "panel-testkit.mjs")).href);
const { loadPlaywright, notRun, withBrowser } = await import(pathToFileURL(path.join(TREE, "tools", "browser.mjs")).href);

// ---- the measurement ---------------------------------------------------------------------------
// The newest message is the last line the newest turn's console paints; the composer is the `.reply` box.
// `overlap` is exactly the brief's number: last message bottom − composer top.
function measure(thread) {
  const rail = document.getElementById("assistant");
  const job = rail?.querySelector(`.job[data-thread="${thread}"]`);
  if (!job) return { missing: "the assistant's card is not on the page" };
  const body = job.querySelector(":scope > .job-body");
  const composer = body?.querySelector(":scope > .reply");
  const turns = [...(body?.querySelectorAll(":scope > .turn") || [])];
  const newest = turns[turns.length - 1] || null;
  const pre = newest?.querySelector(".job-out") || null;
  if (!body || !composer || !newest || !pre) return { missing: "the card has no scroll body, composer, newest turn or console" };
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const round = (n) => Math.round(n * 100) / 100;
    return { top: round(r.top), bottom: round(r.bottom), height: round(r.height), left: round(r.left), right: round(r.right) };
  };
  // The console's own last painted line: its last descendant with a non-zero box. `pre` itself is the fallback
  // for a console that has no line elements (an empty turn), so the number is always the console's own content.
  const painted = [...pre.querySelectorAll("*")].filter((el) => el.getBoundingClientRect().height > 0);
  const lastLine = painted[painted.length - 1] || pre;
  const cs = getComputedStyle(body);
  const openTurns = turns.filter((t) => !t.classList.contains("folded"));
  const openConsoles = openTurns.filter((t) => t.querySelector(".job-out"));
  const previousOpen = openConsoles.filter((t) => t !== newest).length;
  const rect = box(lastLine);
  const composerBox = box(composer);
  const bodyBox = box(body);
  // Where the transcript ends: the newest console must be the LAST console on the page, so no other turn's
  // console may paint below its top. `job-foot` and the composer are card chrome, not transcript, and are
  // excluded — the claim is about the newest message being the last thing in the conversation.
  const otherConsoles = turns.filter((t) => t !== newest).map((t) => t.querySelector(".job-out")).filter(Boolean);
  const otherConsolesBottom = otherConsoles.length ? Math.max(...otherConsoles.map((el) => el.getBoundingClientRect().bottom)) : null;
  const consoleBox = box(pre);
  return {
    frame: rail.classList.contains("is-floating") ? "floating" : "docked",
    rail: box(rail),
    body: bodyBox,
    composer: { ...composerBox, position: getComputedStyle(composer).position },
    newest: { turn: newest.dataset.turn || null, ...box(newest) },
    lastMessage: {
      text: String(lastLine.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90),
      ...rect,
    },
    overlap: rect && composerBox ? Math.round((rect.bottom - composerBox.top) * 100) / 100 : null,
    scrollTop: body.scrollTop,
    scrollHeight: body.scrollHeight,
    clientHeight: body.clientHeight,
    paddingBottom: cs.paddingBottom,
    paddingTop: cs.paddingTop,
    atFoot: body.scrollTop + body.clientHeight >= body.scrollHeight - 1,
    overflowing: body.scrollHeight > body.clientHeight + 1,
    turns: turns.length,
    openConsoles: openConsoles.length,
    previousOpen,
    console: consoleBox,
    otherConsolesBottom: otherConsolesBottom == null ? null : Math.round(otherConsolesBottom * 100) / 100,
    // The console must stay inside its own turn's box. A shrunk turn is zero-height while its console (min-height
    // 34px) paints out of it — that escape is what put the last line behind the composer.
    consoleContained: consoleBox != null && consoleBox.bottom <= box(newest).bottom + 1,
  };
}

// Open every turn before the newest through the board's own head, then take the transcript to its foot.
async function openPreviousTurns(page) {
  const ids = await page.evaluate((thread) => [...document.querySelectorAll(`#assistant .job[data-thread="${thread}"] .job-body > .turn`)].map((t) => t.dataset.turn), THREAD);
  if (!ids.length) return;
  for (const id of ids.slice(0, -1)) {
    const folded = async () => (await page.locator(`#assistant .job[data-thread="${THREAD}"] .turn[data-turn="${id}"]`).getAttribute("class").catch(() => ""))?.includes("folded") ?? false;
    if (!(await folded())) continue;
    await page.locator(`#assistant .job[data-thread="${THREAD}"] [data-toggle-turn="${id}"]`).click();
    await page.waitForFunction(
      ([tid, th]) => !document.querySelector(`#assistant .job[data-thread="${th}"] .turn[data-turn="${tid}"]`)?.classList.contains("folded"),
      [id, THREAD],
      { timeout: 10_000 },
    ).catch(() => {});
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(300);
}
async function toFoot(page) {
  await page.evaluate((thread) => {
    const body = document.querySelector(`#assistant .job[data-thread="${thread}"] > .job-body`);
    body.scrollTop = body.scrollHeight;
  }, THREAD);
  await page.waitForTimeout(250);
}

const playwright = loadPlaywright({ root: TREE });
if (!playwright) {
  console.log(notRun("the assistant chat's last message above its composer", "Playwright is not installed here (set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright)"));
  process.exit(2);
}

const port = await freePort();
const panel = await startPanel({
  dir,
  port,
  root: TREE,
  config: {
    refreshSeconds: 3600,
    worktreeSeconds: 3600,
    midSeconds: 3600,
    dormantSeconds: 3600,
    slowSeconds: 3600,
    fetchSeconds: -1,
    discoverSeconds: 3600,
    // No gateway: the URL is a dead port and the assistant's own rules are off, so nothing here can start a run.
    assistant: { enabled: false },
    apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
  },
});

const CASE_NAME = (frame, width) => `${frame}, ${width}px window`;

async function measureCase(page, frame, width) {
  await page.setViewportSize({ width, height: HEIGHT });
  await page.waitForTimeout(500);
  await openPreviousTurns(page);
  await toFoot(page);
  let m = await page.evaluate(measure, THREAD);
  if (m.missing) {
    // A repaint can drop the card between the gesture and the read; ask once more before calling it unmeasured.
    await page.waitForTimeout(600);
    await openPreviousTurns(page);
    await toFoot(page);
    m = await page.evaluate(measure, THREAD);
  }
  return m;
}

try {
  console.log(`assistant dock overlap gate on ${TREE}`);
  console.log(`  sandbox: ${panel.base} · ${TURNS} seeded turns × ${LINES_PER_TURN} lines in ${THREAD} · no gateway · shots ${SHOTS}`);
  mkdirSync(SHOTS, { recursive: true });

  await withBrowser(async ({ page, pageErrors }) => {
    // The rail is the panel's remembered state, not a press: after a reload it is already open.
    await page.addInitScript(() => {
      try {
        localStorage.setItem("wm.assistantOpen", "1");
        localStorage.removeItem("wtgui.zoom");
      } catch {
        /* a browser with storage off still draws the rail on its own default */
      }
    });
    await page.goto(panel.base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(`#assistant .job[data-thread="${THREAD}"]`, { timeout: 45_000 });
    await page.waitForTimeout(900);

    const runFrame = async (frame) => {
      for (const width of WIDTHS) {
        const name = CASE_NAME(frame, width);
        const m = await measureCase(page, frame, width);
        out.cases.push({ case: name, frame, width, ...m });
        if (m.missing) {
          out.notMeasured.push(`${name}: ${m.missing}`);
          check(false, `${name}: the fixture reached the page`, m.missing);
          continue;
        }
        measured += 1;
        console.log(`\n== ${name} ==`);
        note(`scroll: scrollHeight ${m.scrollHeight}px · clientHeight ${m.clientHeight}px · padding-bottom ${m.paddingBottom} · scrollTop ${Math.round(m.scrollTop)}px`);
        note(`composer: top ${m.composer.top}px · bottom ${m.composer.bottom}px · height ${m.composer.height}px · position ${m.composer.position}`);
        note(`newest message: bottom ${m.lastMessage.bottom}px · ${JSON.stringify(m.lastMessage.text)}`);
        note(`overlap (last message bottom − composer top): ${m.overlap}px`);

        // (0) the case is the frame it claims to be, and the transcript really is longer than the pane.
        const frameOk = frame === "floating"
          ? m.frame === "floating" && m.rail.right <= width + 1
          : m.frame === "docked" && Math.abs(m.rail.right - m.rail.left - RAIL_PX) <= 1;
        check(frameOk, `${name}: measured in the ${frame} frame`, `frame=${m.frame} rail ${m.rail.left}–${m.rail.right}px`);
        check(m.overflowing, `${name}: the transcript is longer than the scrollport`, `scrollHeight ${m.scrollHeight}px vs clientHeight ${m.clientHeight}px`);
        check(m.atFoot, `${name}: the transcript is at its foot (the reader's landing state)`, `scrollTop ${Math.round(m.scrollTop)} of ${m.scrollHeight - m.clientHeight} reachable`);
        check(m.previousOpen >= 2, `${name}: at least two previous turns' consoles are open`, `${m.previousOpen} of ${m.turns - 1} previous turn(s) open, ${m.openConsoles} consoles on the page`);

        // (1) the newest message IS the last thing in the conversation: no other turn's console paints below the
        // newest console, and the console's own box reaches its last line (a collapsed turn's console escapes its
        // box, which is the shape the defect took).
        check(
          m.otherConsolesBottom != null && m.otherConsolesBottom <= m.console.top + 1,
          `${name}: the newest console is the last thing in the transcript`,
          `previous consoles end at ${m.otherConsolesBottom}px, newest console starts ${m.console.top}px`,
        );
        check(
          m.consoleContained,
          `${name}: the newest turn's box holds its console (no overflow out of the turn)`,
          `console ends ${m.console.bottom}px, turn ends ${m.newest.bottom}px`,
        );

        // (2) THE CLAIM: zero overlap. A positive number is the last message painted under the composer.
        check(m.overlap <= 0.5, `${name}: the last message is fully above the composer (no overlap)`, `overlap ${m.overlap}px`);

        // (3) readable, not merely un-overlapped: the line is inside the scrollport, above the composer's top,
        // and the composer is still at the pane's foot where the reader types.
        check(
          m.lastMessage.top >= m.body.top - 1 && m.lastMessage.bottom <= m.body.bottom + 1,
          `${name}: the last message is inside the scrollport the reader is looking at`,
          `message ${m.lastMessage.top}–${m.lastMessage.bottom}px inside body ${m.body.top}–${m.body.bottom}px`,
        );
        check(
          Math.abs(m.composer.bottom - m.body.bottom) <= 2,
          `${name}: the composer still sits at the scrollport's foot`,
          `composer bottom ${m.composer.bottom}px vs body bottom ${m.body.bottom}px`,
        );

        await page.screenshot({ path: path.join(SHOTS, `assistant-dock-overlap-${frame}-${width}.png`) });
      }
    };

    await runFrame("docked");

    // The float is ONE ASSISTANT'S OWN setting, not the panel's: flip it through the route the Settings pane
    // posts to, then reload so the boot path paints the floating frame.
    const flip = await fetch(`${panel.base}/api/assistant/profile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assistantId: "assistant-1", dock: "floating" }),
    });
    check(flip.status === 200, "assistant #1 is switched to its floating frame", `HTTP ${flip.status}`);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(`#assistant .job[data-thread="${THREAD}"]`, { timeout: 45_000 });
    await page.waitForTimeout(900);
    await runFrame("floating");

    check(pageErrors.length === 0, "no page errors anywhere in the run", pageErrors.join(" | "));
  }, { viewport: { width: WIDTHS[0], height: HEIGHT } });
} finally {
  await panel.stop();
}

if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ ...out, checks, failures }, null, 1), "utf8");

console.log(`\n${checks} checks, ${failures} failed, ${measured}/${WIDTHS.length * 2} cases measured`);
if (!failures && measured === WIDTHS.length * 2) console.log("ASSISTANT-DOCK-OVERLAP-OK");
else if (!measured) console.log("ASSISTANT-DOCK-OVERLAP-NOT-RUN");
process.exitCode = failures || measured !== WIDTHS.length * 2 ? 1 : 0;
