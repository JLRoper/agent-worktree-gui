#!/usr/bin/env node
// The composer block at the TOP of the card when every turn is folded, and back at the foot the moment one is open.
//
//   node tools/verify-composer-top.mjs
//   node tools/verify-composer-top.mjs --root <export dir>     # serve a `git archive` of another build
//   node tools/verify-composer-top.mjs --shots <dir>           # where the screenshots go
//   node tools/verify-composer-top.mjs --json <file>           # keep the raw ledger
//
// THE ASK. `public/style.css` puts a flex spacer before the turns of the assistant's chat
// (`.job-body::before { content: ""; flex: 1 0 auto; }`) so a conversation shorter than the panel starts at its
// foot instead of leaving dead panel under the last line. With EVERY turn folded there is no console to read, so
// that spacer is the wrong way round: it spends the free room between the agent head and the first folded row, and
// pushes the one thing the reader came for — the reply box and its token strip — to the bottom of a panel whose
// top half is empty. The composer block belongs at the top of the card in that state, with the grey space below it.
//
// WHAT IS DRIVEN, in both states, at two window heights (1000 px of slack, 560 px where the block outgrows the
// pane), over a real sandbox panel and headless Chromium:
//
//   folded     every turn folded through the board's own turn head, one at a time. The spacer's own box is read
//              back as `content: none`; the first folded row sits at the pane's content top; the reply box and the
//              token strip sit under it, the strip UNDER the reply box; the free room is below the composer (and is
//              the body's own background there, not a row painted over it); the composer is still `position:
//              sticky; bottom: 0`; at 560 px the block starts at the top and the pane scrolls from its first row.
//   open       the newest turn opened again through the same head. The spacer returns (`content: ""`), the
//              composer's bottom is the pane's bottom, the composer has MOVED DOWN and the rows with it; the strip
//              is still under the reply box; and at 560 px, with the transcript scrolled back to its top, the
//              composer is still pinned to the pane's bottom — sticky, in the state where it has work to do.
//
// Nothing is synthesised in the page: the turns are a seeded `logs/jobs.json` in the assistant's own thread, and
// every gesture is the reader's own click on a turn head.
//
// EXIT CODES: 0 both states held at both heights; 1 a check failed; 2 the run did not measure what it claims (no
// Playwright, or a fixture that never reached the page) — a green run can never be a pass on an empty page.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SHOTS = path.resolve(opt("--shots", path.join(tmpdir(), "wtgui-composer-top-shots")));
const JSON_OUT = opt("--json");
// 1000 is a pane with room to spare (the state the reader reported); 560 is a pane the folded block outgrows, which
// is where "the grey falls below it" has to mean "nothing is cut off above it" instead.
const HEIGHTS = [1000, 560];
const WIDTH = 1440;
const THREAD = "panel-assistant";
const TURNS = 3;
const LINES_PER_TURN = 6;

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
const round = (n) => Math.round(n * 100) / 100;

// ---- the fixture: three settled turns in the assistant's own thread -----------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-composer-top-"));
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
      text: `turn ${i + 1} line ${n} — folded, this row is a line of the transcript and nothing else`,
      lid: i * 1000 + n,
      at: at + n * 1000,
    });
  }
  jobs.push({
    id: `tkcomposer${i + 1}`,
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
    tokens: { total: 51_234 },
    stats: { context_used: 42_000, context_max: 200_000, total_tokens: 51_234, cost_usd: 0.42, input_tokens: 40_000, output_tokens: 11_234 },
    lines,
  });
}
writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify({ savedAt: new Date(now).toISOString(), jobs }, null, 1));

// The kit beside the checkout being SERVED, not beside this file: `--root` has to boot the base's own server.js,
// lib/ and public/ or the comparison would prove nothing.
const { freePort, startPanel } = await import(pathToFileURL(path.join(TREE, "tools", "panel-testkit.mjs")).href);
const { loadPlaywright, notRun, withBrowser } = await import(pathToFileURL(path.join(TREE, "tools", "browser.mjs")).href);

// ---- the measurement ---------------------------------------------------------------------------------------
// Every number below is read off the painted card: rects from getBoundingClientRect, the pseudo's own computed
// `content`, and computed `position`/`bottom` on the composer.
function measure(thread) {
  const round = (n) => Math.round(n * 100) / 100;
  const rail = document.getElementById("assistant");
  const job = rail?.querySelector(`.job[data-thread="${thread}"]`);
  if (!job) return { missing: "the assistant's card is not on the page" };
  const body = job.querySelector(":scope > .job-body");
  const composer = body?.querySelector(":scope > .reply");
  if (!body || !composer) return { missing: "the card has no scroll body or no composer" };
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: round(r.top), bottom: round(r.bottom), height: round(r.height), left: round(r.left), right: round(r.right) };
  };
  const cs = getComputedStyle(body);
  const padTop = parseFloat(cs.paddingTop) || 0;
  const padBottom = parseFloat(cs.paddingBottom) || 0;
  const turns = [...body.querySelectorAll(":scope > .turn")];
  const open = turns.filter((t) => !t.classList.contains("folded"));
  const firstTurn = turns[0] || null;
  const stats = composer.querySelector(".job-stats-slot");
  const replyInput = composer.querySelector(".reply-box");
  const bodyBox = box(body);
  const composerBox = box(composer);
  const statsRect = box(stats);
  const replyInputRect = box(replyInput);
  // The free room under the composer, and what is painted in the middle of it: the body itself means grey panel,
  // a `.turn` or `.reply` there would mean the block did not actually end where its own box says.
  const freeBelow = composerBox ? round(bodyBox.bottom - composerBox.bottom) : null;
  const probeY = composerBox ? composerBox.bottom + Math.min(40, Math.max(8, (bodyBox.bottom - composerBox.bottom) / 2)) : null;
  const at = probeY != null && probeY < bodyBox.bottom - 1 ? document.elementFromPoint(bodyBox.left + 24, probeY) : null;
  return {
    body: bodyBox,
    paddingTop: padTop,
    paddingBottom: padBottom,
    pseudo: String(getComputedStyle(body, "::before").content),
    turns: turns.map((t) => ({ id: t.dataset.turn || null, folded: t.classList.contains("folded"), slack: t.classList.contains("is-slack"), ...box(t) })),
    turnCount: turns.length,
    openTurns: open.length,
    slackTurns: turns.filter((t) => t.classList.contains("is-slack")).length,
    firstTurn: firstTurn ? box(firstTurn) : null,
    gapUnderHead: firstTurn ? round(box(firstTurn).top - (bodyBox.top + padTop)) : null,
    // The rect's own bottom is where the composer ENDS; the computed `bottom` is the sticky offset. Both are kept,
    // under names that cannot be mistaken for each other.
    composer: { ...composerBox, position: getComputedStyle(composer).position, bottomStyle: getComputedStyle(composer).bottom || "0px" },
    replyBox: replyInputRect,
    strip: statsRect,
    stripUnderBox: Boolean(statsRect && replyInputRect && statsRect.top >= replyInputRect.bottom - 1 && statsRect.bottom <= composerBox.bottom + 1 && statsRect.height > 0),
    freeBelow,
    freeAtBody: at ? at === body || at === job : null,
    freeProbe: at ? `${at.tagName.toLowerCase()}${at.className ? "." + String(at.className).split(/\s+/).join(".") : ""}` : null,
    scrollTop: round(body.scrollTop),
    scrollHeight: body.scrollHeight,
    clientHeight: body.clientHeight,
    overflowing: body.scrollHeight > body.clientHeight + 1,
  };
}

// Fold every turn through the board's own head. The head's text is the click target: the star button sits inside the
// same head and a click on its centre would pin the turn instead of folding it.
async function foldEveryTurn(page) {
  for (let guard = 0; guard < 12; guard += 1) {
    const openIds = await page.evaluate(
      (thread) => [...document.querySelectorAll(`#assistant .job[data-thread="${thread}"] .job-body > .turn:not(.folded)`)].map((t) => t.dataset.turn),
      THREAD,
    );
    if (!openIds.length) break;
    for (const id of openIds) {
      await page.locator(`#assistant .job[data-thread="${THREAD}"] [data-toggle-turn="${id}"] .turn-text`).click();
      await page.waitForFunction(
        ([tid, th]) => document.querySelector(`#assistant .job[data-thread="${th}"] .turn[data-turn="${tid}"]`)?.classList.contains("folded"),
        [id, THREAD],
        { timeout: 10_000 },
      ).catch(() => {});
      await page.waitForTimeout(150);
    }
  }
  await page.waitForTimeout(300);
}

// Open the newest turn again, the same gesture the reader uses.
async function openNewestTurn(page) {
  const id = await page.evaluate((thread) => {
    const turns = [...document.querySelectorAll(`#assistant .job[data-thread="${thread}"] .job-body > .turn`)];
    const t = turns[turns.length - 1];
    return t ? t.dataset.turn : null;
  }, THREAD);
  if (!id) return;
  await page.locator(`#assistant .job[data-thread="${THREAD}"] [data-toggle-turn="${id}"] .turn-text`).click();
  await page.waitForFunction(
    ([tid, th]) => !document.querySelector(`#assistant .job[data-thread="${th}"] .turn[data-turn="${tid}"]`)?.classList.contains("folded"),
    [id, THREAD],
    { timeout: 10_000 },
  ).catch(() => {});
  await page.waitForTimeout(350);
}

const playwright = loadPlaywright({ root: TREE });
if (!playwright) {
  console.log(notRun("the composer block at the top of a folded card", "Playwright is not installed here (set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright)"));
  process.exit(2);
}

// ---- the mechanism, as written in THIS checkout (inspected, not the browser's word for it) -------------------
// A browser running a build whose stylesheet lost the rule cannot prove the rule; these two lines say what the
// served CSS was supposed to carry, beside the numbers that show it taking effect.
const cssSource = readFileSync(path.join(TREE, "public", "style.css"), "utf8");
const SPACER = /\n\.as-subpane\[data-subpane="chat"\] > \.job > \.job-body::before \{ content: ""; flex: 1 0 auto; \}/;
const MIRROR = /\n\.as-subpane\[data-subpane="chat"\] > \.job > \.job-body:not\(:has\(> \.turn:not\(\.folded\)\)\)::before \{ content: none; \}/;

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

try {
  console.log(`composer-top gate on ${TREE}`);
  console.log(`  sandbox: ${panel.base} · ${TURNS} seeded turns × ${LINES_PER_TURN} lines in ${THREAD} · no gateway · shots ${SHOTS}`);
  mkdirSync(SHOTS, { recursive: true });

  check(SPACER.test(cssSource), "the spacer the rule stands down is still in the stylesheet");
  check(MIRROR.test(cssSource), "the no-open-turn rule is in the stylesheet");

  await withBrowser(
    async ({ page, pageErrors }) => {
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

      for (const height of HEIGHTS) {
        const slack = height === HEIGHTS[0];
        await page.setViewportSize({ width: WIDTH, height });
        await page.waitForTimeout(500);

        // ---- state 1: every turn folded ------------------------------------------------------------------
        await foldEveryTurn(page);
        let f = await page.evaluate(measure, THREAD);
        if (f.missing) {
          await page.waitForTimeout(600);
          await foldEveryTurn(page);
          f = await page.evaluate(measure, THREAD);
        }
        out.cases.push({ case: `folded, ${height}px window`, state: "folded", height, ...f });
        if (f.missing) {
          out.notMeasured.push(`folded, ${height}px: ${f.missing}`);
          check(false, `folded, ${height}px window: the fixture reached the page`, f.missing);
          continue;
        }
        measured += 1;
        console.log(`\n== folded, ${height}px window ==`);
        note(`body ${f.body.top}–${f.body.bottom}px · padding-top ${f.paddingTop}px · scroll ${f.scrollTop} of ${f.scrollHeight}/${f.clientHeight}`);
        note(`turns ${f.turnCount} (${f.openTurns} open) · first row at ${f.firstTurn?.top}px · gap under the head ${f.gapUnderHead}px`);
        note(`composer ${f.composer.top}–${f.composer.bottom}px · ${f.composer.position} bottom ${f.composer.bottom} · free below ${f.freeBelow}px · ::before content ${JSON.stringify(f.pseudo)}`);

        check(f.turnCount === TURNS && f.openTurns === 0, `folded, ${height}px: every turn is folded`, `${f.turnCount} turns, ${f.openTurns} open`);
        check(f.pseudo === "none" && f.slackTurns === 0, `folded, ${height}px: the spacer's box is gone and no turn claims the room`, `::before content ${JSON.stringify(f.pseudo)}, ${f.slackTurns} slack turn(s)`);
        check(f.gapUnderHead != null && f.gapUnderHead <= 2, `folded, ${height}px: the folded rows start at the head`, `first row ${f.gapUnderHead}px below the content top`);
        check(f.composer.position === "sticky" && f.composer.bottomStyle === "0px", `folded, ${height}px: the composer is still sticky to the bottom`, `position ${f.composer.position}, bottom ${f.composer.bottomStyle}`);
        check(f.stripUnderBox, `folded, ${height}px: the token strip sits UNDER the reply box, inside the composer`, `strip ${f.strip?.top}–${f.strip?.bottom}px, reply box ${f.replyBox?.top}–${f.replyBox?.bottom}px, composer ends ${f.composer.bottom}px`);
        if (slack) {
          check(f.freeBelow >= 120, `folded, ${height}px: the free room is BELOW the block (grey under it)`, `${f.freeBelow}px under the composer, ${f.body.bottom - f.body.top}px pane`);
          check(!f.overflowing, `folded, ${height}px: the slack is free room, not scrollable content`, `scrollHeight ${f.scrollHeight}px vs clientHeight ${f.clientHeight}px`);
          check(f.freeAtBody === true, `folded, ${height}px: what paints there is the panel's own background`, `elementFromPoint → ${f.freeProbe}`);
        } else {
          check(f.scrollTop === 0, `folded, ${height}px: the block starts at the pane's top (nothing cut off above it)`, `scrollTop ${f.scrollTop}px`);
          check(f.firstTurn != null && f.firstTurn.top >= f.body.top - 1, `folded, ${height}px: the first folded row is inside the scrollport`, `row ${f.firstTurn?.top}px, body top ${f.body.top}px`);
        }
        await page.screenshot({ path: path.join(SHOTS, `composer-top-folded-${height}.png`) });

        // ---- state 2: one turn open again ---------------------------------------------------------------
        await openNewestTurn(page);
        let o = await page.evaluate(measure, THREAD);
        if (o.missing) {
          await page.waitForTimeout(600);
          o = await page.evaluate(measure, THREAD);
        }
        out.cases.push({ case: `open, ${height}px window`, state: "open", height, ...o, foldedComposerTop: f.composer.top, foldedGapUnderHead: f.gapUnderHead });
        if (o.missing) {
          out.notMeasured.push(`open, ${height}px: ${o.missing}`);
          check(false, `open, ${height}px window: the fixture reached the page`, o.missing);
          continue;
        }
        measured += 1;
        console.log(`\n== open, ${height}px window ==`);
        note(`body ${o.body.top}–${o.body.bottom}px · scroll ${o.scrollTop} of ${o.scrollHeight}/${o.clientHeight}`);
        note(`turns ${o.turnCount} (${o.openTurns} open) · first row at ${o.firstTurn?.top}px · gap under the head ${o.gapUnderHead}px`);
        note(`composer ${o.composer.top}–${o.composer.bottom}px · ${o.composer.position} bottom ${o.composer.bottom} · free below ${o.freeBelow}px · ::before content ${JSON.stringify(o.pseudo)}`);

        check(o.turnCount === TURNS && o.openTurns === 1, `open, ${height}px: exactly the newest turn is open`, `${o.turnCount} turns, ${o.openTurns} open`);
        check(Math.abs(o.composer.bottom - o.body.bottom) <= 2, `open, ${height}px: the composer is at the pane's foot`, `composer bottom ${o.composer.bottom}px vs body bottom ${o.body.bottom}px`);
        check(o.composer.top > f.composer.top + 20, `open, ${height}px: the composer MOVED DOWN from the folded place`, `${f.composer.top}px → ${o.composer.top}px`);
        // Today's behaviour, spelled out: the open turn is the item that claims the room the spacer used to take, so
        // the composer is pushed to the foot by a console that is on the page — not by blank space again.
        const lastFolded = f.turns[f.turns.length - 1] || null;
        const lastOpen = o.turns[o.turns.length - 1] || null;
        check(o.slackTurns === 1 && lastOpen?.slack === true, `open, ${height}px: the open turn is the one claiming the room`, `${o.slackTurns} slack turn(s), newest open turn slack=${lastOpen?.slack}`);
        check(lastFolded != null && lastOpen != null && lastOpen.height > lastFolded.height + 40, `open, ${height}px: the open console takes the room the folded card left below it`, `newest turn ${lastFolded?.height}px folded → ${lastOpen?.height}px open`);
        check(o.composer.position === "sticky" && o.composer.bottomStyle === "0px", `open, ${height}px: the composer is still sticky to the bottom`, `position ${o.composer.position}, bottom ${o.composer.bottomStyle}`);
        check(o.stripUnderBox, `open, ${height}px: the token strip sits UNDER the reply box, inside the composer`, `strip ${o.strip?.top}–${o.strip?.bottom}px, reply box ${o.replyBox?.top}–${o.replyBox?.bottom}px`);
        if (!slack) {
          // The state where sticky has work to do: the transcript is longer than the pane and the reader has scrolled
          // back to its first line. The composer must still be pinned at the pane's foot, over the turns it covers.
          await page.evaluate((thread) => {
            const body = document.querySelector(`#assistant .job[data-thread="${thread}"] > .job-body`);
            body.scrollTop = 0;
          }, THREAD);
          await page.waitForTimeout(250);
          const top = await page.evaluate(measure, THREAD);
          out.cases.push({ case: `open, ${height}px window, scrolled to the top`, state: "open-scrolled", height, ...top });
          note(`scrolled to the top: scrollTop ${top.scrollTop}px · composer bottom ${top.composer.bottom}px vs body bottom ${top.body.bottom}px`);
          check(top.overflowing, `open, ${height}px: there is transcript above the fold to scroll`, `scrollHeight ${top.scrollHeight}px vs clientHeight ${top.clientHeight}px`);
          check(Math.abs(top.composer.bottom - top.body.bottom) <= 2, `open, ${height}px: the composer stays pinned while the transcript is scrolled away`, `composer bottom ${top.composer.bottom}px vs body bottom ${top.body.bottom}px`);
        }
        await page.screenshot({ path: path.join(SHOTS, `composer-top-open-${height}.png`) });
      }

      check(pageErrors.length === 0, "no page errors anywhere in the run", pageErrors.join(" | "));
    },
    { viewport: { width: WIDTH, height: HEIGHTS[0] } },
  );
} finally {
  await panel.stop();
}

if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ ...out, checks, failures }, null, 1), "utf8");

console.log(`\n${checks} checks, ${failures} failed, ${measured}/${HEIGHTS.length * 2} states measured`);
if (!failures && measured === HEIGHTS.length * 2) console.log("COMPOSER-TOP-OK");
else if (!measured) console.log("COMPOSER-TOP-NOT-RUN");
process.exitCode = failures || measured !== HEIGHTS.length * 2 ? 1 : 0;
