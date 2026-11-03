// test/e2e/minimized-composer.spec.mjs — the assistant chat's composer block in both of the reader's states, measured
// from the RENDERED BOX MODEL in headless Chromium.
//
// WHAT THIS IS, AND WHY IT IS A SEPARATE TEST. public/style.css stands the chat's pre-turn flex spacer down when no
// turn is open (`.job-body:not(:has(> .turn:not(.folded)))::before { content: none; }`): with every turn folded the
// folded rows, the reply box and its token strip sit directly under the agent head and the free room is painted BELOW
// them; one open turn puts the spacer back, the open console claims the room and the composer travels to the pane's
// foot. That change landed with its own mechanism gate (tools/verify-composer-top.mjs) and a stylesheet assertion in
// test/assistant-dock.test.js. THIS spec is the reader's ask and shares neither their fixture nor their reads: it
// drives the two states on its own seeded panel, at two window heights, and asserts the geometry the reader named —
// rects from getBoundingClientRect and hit tests with document.elementFromPoint. Nothing here reads style.css: a rule
// in the sheet is not evidence that the box on screen moved, so the sheet is what this spec refuses to trust.
//
//   RUN   node --test --test-reporter=spec test/e2e/minimized-composer.spec.mjs
//         npm run test:e2e:minimized-composer
//
//         MINIMIZED_COMPOSER_SHOTS=<dir>   where the screenshots go (default: <tmp>/wtgui-minimized-composer-shots)
//
// THE READER'S TWO STATES, and where each is measured:
//
//   folded   every turn minimised — 0 open. The first folded row starts at the scroll body's content top, with only
//            the card's own head chrome between it and the agent head (that is the room the spacer used to spend);
//            the reply box is under the last row and the token strip is under the box; the composer block ends high in
//            the pane; and document.elementFromPoint in the space beneath it returns the card's own .job-body — the
//            free room is grey panel BELOW the block, not above it.
//   open     one turn head pressed. Exactly one turn is open, the composer's top has MOVED DOWN from its folded
//            place, and its bottom is the scrollport's bottom (computed `position: sticky`, `bottom: 0px`). With the
//            now-long transcript scrolled back to its first line the composer's bottom is STILL the scrollport's
//            bottom, which is the state where sticky has work to do.
//
// BOTH AT A TALL AND A SHORT WINDOW (1000 px and 640 px of total height). A pane the folded block outgrows cannot
// paint grey room below it, so at the short height the folded claim is "the block still starts at the head and
// nothing is cut off above it"; the free-room hit test runs only where there is room, and the difference between
// the two heights is reported instead of being asserted away. That is the one place the two viewports may disagree,
// and the run's ledger names it.
//
// A FAILING CASE IS A FAILURE, NOT A TEST TO RE-AIM. If a case disagrees with the panel, the panel is what the
// report is about; the assertion is not made to fit.
//
// Exit is node:test's: 0 when every case passed, 1 when one failed, and the summary line counts them.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { attachPageCollectors, loadPlaywright } from "../../tools/browser.mjs";
import { freePort, startPanel } from "../../tools/panel-testkit.mjs";

// The reader's own panel. This run must never bind it, and never write its store.
const LIVE_PORT = 7331;

const PW = loadPlaywright();
const SKIP = PW ? null : "BROWSER-HALF-NOT-RUN: no Playwright install found (set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright)";
const it = (name, fn) => (PW ? test(name, fn) : test(name, { skip: SKIP }, () => {}));

// ---- the fixture: three settled turns in the assistant's own thread -----------------------------------------------
// The reader's ask is "at least three settled turns"; the long console inside each turn is what makes the OPEN state
// a transcript that overflows its pane at BOTH heights, so "scrolled back to the top" is a real scroll and not a
// no-op. Folding a turn does not draw its lines, so the folded block stays three compact rows.
const THREAD = "panel-assistant";
const TURNS = 3;
const LINES_PER_TURN = 24;
const WIDTH = 1440;
const VIEWPORTS = [
  { name: "tall", height: 1000 },
  { name: "short", height: 640 },
];

const at = (ms) => new Date(ms).toISOString();

// ---- the run's own state ------------------------------------------------------------------------------------------
let panel = null;
let browser = null;
let page = null;
let pageErrors = [];
let consoleErrors = [];
let shots = null;
let store = null;
const ledger = { viewports: {}, at: null };

// What the card draws, read from the DOM the reader sees. Every number is a painted rect; the only computed styles
// are the composer's own `position`/`bottom` (the sticky offset the box model alone cannot report).
function readCard(thread) {
  const round = (n) => Math.round(n * 100) / 100;
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: round(r.top), bottom: round(r.bottom), left: round(r.left), right: round(r.right), width: round(r.width), height: round(r.height) };
  };
  const rail = document.getElementById("assistant");
  const job = rail && rail.querySelector(`.job[data-thread="${thread}"]`);
  if (!job) return { missing: "the assistant's card is not on the page" };
  const head = job.querySelector(":scope > .job-head");
  const body = job.querySelector(":scope > .job-body");
  if (!head || !body) return { missing: "the card has no head or no scroll body" };
  const composer = body.querySelector(":scope > .reply");
  if (!composer) return { missing: "the card has no composer" };

  const replyBox = composer.querySelector(":scope > .reply-wrap .reply-box");
  const strip = composer.querySelector(":scope > .job-stats-slot");
  const foot = body.querySelector(":scope > .job-foot");
  const turns = [...body.querySelectorAll(":scope > .turn")];
  const headBox = box(head);
  const bodyBox = box(body);
  const composerBox = box(composer);
  const replyBoxBox = box(replyBox);
  const stripBox = box(strip);
  const rows = turns.map((t) => ({ id: t.dataset.turn || null, folded: t.classList.contains("folded"), ...box(t) }));
  const firstRow = rows[0] || null;
  const lastRow = rows[rows.length - 1] || null;
  const paddingTop = parseFloat(getComputedStyle(body).paddingTop) || 0;
  const composerMarginTop = parseFloat(getComputedStyle(composer).marginTop) || 0;
  const freeBelow = round(bodyBox.bottom - composerBox.bottom);
  // The hit test the reader asked for: a point in the free room UNDER the composer, half way down it (capped at 40px
  // so a tall pane is sampled near the block rather than at its far edge), on the block's own left edge.
  const probeY = freeBelow > 8 ? round(Math.min(composerBox.bottom + 40, composerBox.bottom + freeBelow / 2)) : null;
  const hit = probeY != null && probeY < bodyBox.bottom - 1 ? document.elementFromPoint(composerBox.left + 24, probeY) : null;
  const name = (el) =>
    el ? `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : ""}` : null;

  return {
    job: box(job),
    head: headBox,
    body: bodyBox,
    paddingTop,
    turns: rows,
    turnCount: turns.length,
    openTurns: turns.filter((t) => !t.classList.contains("folded")).length,
    firstRow,
    lastRow,
    // The body starts at the card's head chrome (a head, then the cwd line the card always draws); the number that
    // matters for the folded state is the row's distance from the BODY's own content top, which is where the spacer
    // used to sit. Both are reported so the top chrome is not mistaken for dead panel.
    headToBody: round(bodyBox.top - headBox.bottom),
    headToFirstRow: firstRow ? round(firstRow.top - headBox.bottom) : null,
    bodyToFirstRow: firstRow ? round(firstRow.top - (bodyBox.top + paddingTop)) : null,
    composer: { ...composerBox, position: getComputedStyle(composer).position, cssBottom: getComputedStyle(composer).bottom || "" },
    composerMarginTop,
    replyBox: replyBoxBox,
    strip: stripBox,
    // With every turn folded the block is contiguous: the card's outcome line (when it draws one) ends where the
    // composer begins, and the last folded row ends where that line begins. A spacer between any two of them would
    // show up here as a positive gap.
    blockGap: lastRow ? round(composerBox.top - lastRow.bottom) : null,
    foot: foot ? box(foot) : null,
    footGap: foot ? round(composerBox.top - box(foot).bottom) : lastRow ? round(composerBox.top - lastRow.bottom) : null,
    stripUnderBox: Boolean(replyBoxBox && stripBox && stripBox.top >= replyBoxBox.bottom - 1),
    stripInsideComposer: Boolean(stripBox && composerBox && stripBox.top >= composerBox.top - 1 && stripBox.bottom <= composerBox.bottom + 1),
    freeBelow,
    probeY,
    probe: name(hit),
    probeIsBody: hit === body,
    scrollTop: round(body.scrollTop),
    scrollHeight: body.scrollHeight,
    clientHeight: body.clientHeight,
    overflowing: body.scrollHeight > body.clientHeight + 1,
  };
}

const measure = () => page.evaluate(readCard, THREAD);

async function ensureChat() {
  await page.waitForSelector(`#assistant .job[data-thread="${THREAD}"]`, { state: "visible", timeout: 45_000 });
}

async function setHeight(height) {
  await page.setViewportSize({ width: WIDTH, height });
  await page.waitForTimeout(400);
}

// Fold every turn through the board's own head. The head's text is the press target: the star button sits in the same
// head and a press on its centre would pin the turn instead of folding it.
async function ensureFolded() {
  for (let guard = 0; guard < 10; guard += 1) {
    const openIds = await page.evaluate(
      (thread) => [...document.querySelectorAll(`#assistant .job[data-thread="${thread}"] .job-body > .turn:not(.folded)`)].map((t) => t.dataset.turn),
      THREAD,
    );
    if (!openIds.length) break;
    for (const id of openIds) {
      await page.locator(`#assistant .job[data-thread="${THREAD}"] [data-toggle-turn="${id}"] .turn-text`).click();
    }
    await page
      .waitForFunction(
        (thread) => !document.querySelector(`#assistant .job[data-thread="${thread}"] .job-body > .turn:not(.folded)`),
        THREAD,
        { timeout: 10_000 },
      )
      .catch(() => {});
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(250);
}

// Press the newest turn's head, unless that turn is already open. The gesture the reader uses, once.
async function ensureOpen() {
  const newest = await page.evaluate((thread) => {
    const turns = [...document.querySelectorAll(`#assistant .job[data-thread="${thread}"] .job-body > .turn`)];
    const t = turns[turns.length - 1];
    return t ? { id: t.dataset.turn, folded: t.classList.contains("folded") } : null;
  }, THREAD);
  assert.ok(newest, "the card has a turn to open");
  if (newest.folded) {
    await page.locator(`#assistant .job[data-thread="${THREAD}"] [data-toggle-turn="${newest.id}"] .turn-text`).click();
  }
  await page.waitForFunction(
    ([tid, th]) => {
      const t = document.querySelector(`#assistant .job[data-thread="${th}"] .turn[data-turn="${tid}"]`);
      return Boolean(t) && !t.classList.contains("folded");
    },
    [newest.id, THREAD],
    { timeout: 10_000 },
  );
  await page.waitForTimeout(350);
  return newest.id;
}

// The folded state at one height, measured fresh: the state is asserted from the box, never from a remembered number.
async function foldedAt(height) {
  await setHeight(height);
  await ensureFolded();
  const m = await measure();
  assert.equal(m.missing, undefined, `the fixture reached the page (${m.missing || "ok"})`);
  ledger.viewports[height] = { ...(ledger.viewports[height] || {}), folded: m };
  return m;
}

async function openedAt(height) {
  await setHeight(height);
  await ensureOpen();
  const m = await measure();
  assert.equal(m.missing, undefined, `the fixture reached the page (${m.missing || "ok"})`);
  ledger.viewports[height] = { ...(ledger.viewports[height] || {}), open: m };
  return m;
}

async function shoot(name) {
  const file = path.join(shots, name);
  await page.screenshot({ path: file });
  const bytes = statSync(file).size;
  return { file, bytes };
}

// Put the thread scroller at `y` and read the card again. The scroll is a page action, not a synthetic wheel gesture:
// the claim under test is the sticky composer's position, not which pointer sequence a reader used to get there.
async function scrollTo(y) {
  await page.evaluate(
    ([thread, top]) => {
      const body = document.querySelector(`#assistant .job[data-thread="${thread}"] > .job-body`);
      body.scrollTop = top;
    },
    [THREAD, y],
  );
  await page.waitForTimeout(220);
  return measure();
}

const px = (n) => (n == null ? "—" : `${n}px`);

// ---- boot ---------------------------------------------------------------------------------------------------------
before(async () => {
  if (!PW) return;
  store = mkdtempSync(path.join(os.tmpdir(), "wtgui-minimized-composer-"));
  mkdirSync(path.join(store, "logs"), { recursive: true });
  const fixtureTree = path.join(store, "fixture-tree");
  const now = Date.now();
  const jobs = [];
  for (let i = 0; i < TURNS; i += 1) {
    const startedAt = now - (TURNS - i) * 600_000;
    const lines = [];
    for (let n = 1; n <= LINES_PER_TURN; n += 1) {
      lines.push({
        kind: "out",
        text: `turn ${i + 1} line ${n} — a settled turn's own transcript, long enough that opening it gives the pane something to scroll`,
        lid: i * 1000 + n,
        at: startedAt + n * 1000,
      });
    }
    jobs.push({
      id: `tkmin${i + 1}`,
      thread: THREAD,
      turn: i + 1,
      prompt: `fixture turn ${i + 1}`,
      status: "done",
      exitCode: 0,
      startedAt: at(startedAt),
      endedAt: at(startedAt + 30_000),
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
  writeFileSync(path.join(store, "logs", "jobs.json"), JSON.stringify({ savedAt: at(now), jobs }, null, 1), "utf8");

  shots = path.resolve(process.env.MINIMIZED_COMPOSER_SHOTS || path.join(os.tmpdir(), "wtgui-minimized-composer-shots"));
  mkdirSync(shots, { recursive: true });

  const port = await freePort();
  assert.notEqual(port, LIVE_PORT, "the OS handed out the reader's own port — refusing to boot over a live panel");
  panel = await startPanel({
    dir: store,
    port,
    config: {
      refreshSeconds: 3600,
      worktreeSeconds: 3600,
      midSeconds: 3600,
      dormantSeconds: 3600,
      slowSeconds: 3600,
      fetchSeconds: -1,
      discoverSeconds: 3600,
      // No gateway: a dead port and the assistant's own rules off, so nothing in this fixture can start a run.
      assistant: { enabled: false },
      apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
    },
  });
  console.log(`      minimized-composer spec: panel ${panel.base} (store ${store}), shots ${shots}`);

  browser = await PW.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: WIDTH, height: VIEWPORTS[0].height } });
  // The rail is a remembered state, not a press: seed it open before the first line of the page runs.
  await context.addInitScript(() => {
    try {
      localStorage.setItem("wm.assistantOpen", "1");
      localStorage.removeItem("wtgui.zoom");
    } catch {
      /* a browser with storage off still draws the rail on its own default */
    }
  });
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  ({ pageErrors, consoleErrors } = attachPageCollectors(page));
  await page.goto(panel.base, { waitUntil: "domcontentloaded" });
  await ensureChat();
  await page.waitForTimeout(700);
});

after(async () => {
  ledger.at = new Date().toISOString();
  if (shots) {
    try {
      writeFileSync(path.join(shots, "minimized-composer-ledger.json"), JSON.stringify(ledger, null, 1), "utf8");
    } catch {
      /* the report still carries the numbers printed below */
    }
  }
  for (const [height, states] of Object.entries(ledger.viewports)) {
    for (const [state, m] of Object.entries(states)) {
      console.log(
        `      ${state} @${height}px: head ${px(m.head?.bottom)} · body ${px(m.body?.top)}–${px(m.body?.bottom)} · ` +
          `first row ${px(m.firstRow?.top)} (head→row ${px(m.headToFirstRow)}, row→box ${px(m.blockGap)}, foot→reply ${px(m.footGap)}) · ${m.turnCount} turns/${m.openTurns} open · ` +
          `composer ${px(m.composer?.top)}–${px(m.composer?.bottom)} (${m.composer?.position} ${m.composer?.cssBottom}) · ` +
          `box ${px(m.replyBox?.top)}–${px(m.replyBox?.bottom)} · strip ${px(m.strip?.top)}–${px(m.strip?.bottom)} · ` +
          `free below ${px(m.freeBelow)} · probe → ${m.probe} · scroll ${m.scrollTop} of ${m.scrollHeight}/${m.clientHeight}`,
      );
    }
  }
  if (browser) await browser.close().catch(() => {});
  if (panel) await panel.stop();
  if (shots) console.log(`      minimized-composer spec: screenshots + ledger in ${shots}`);
});

// ---- the run's own hygiene ----------------------------------------------------------------------------------------
it("the run's panel bound its own port, not the reader's 7331", async () => {
  assert.notEqual(panel.port, LIVE_PORT, "the spec never binds the live panel's port");
  assert.match(panel.base, /^http:\/\/127\.0\.0\.1:\d+$/, `the panel is a loopback listener of this run (${panel.base})`);
  assert.equal((await fetch(`${panel.base}/api/health`)).status, 200, "…and it is the panel this run started");
});

// ---- the reader's two states, at each height ----------------------------------------------------------------------
for (const vp of VIEWPORTS) {
  const tag = `${vp.name} ${vp.height}px`;

  it(`[${tag}] every turn in the chat is minimised`, async () => {
    const m = await foldedAt(vp.height);
    assert.equal(m.turnCount, TURNS, `the seeded ${TURNS} settled turns are drawn`);
    assert.equal(m.openTurns, 0, `${m.openTurns} turn(s) are still open — the folded state is every turn minimised`);
    assert.ok(m.turns.every((t) => t.folded), "every .turn carries .folded");
  });

  it(`[${tag}] the folded rows start directly under the agent head`, async () => {
    const m = await foldedAt(vp.height);
    // The card's head chrome (its head plus the cwd line it always draws) is fixed; what the folded state must not do is
    // push the first row away from the body's top, which is where the spacer used to sit.
    assert.ok(
      m.bodyToFirstRow != null && m.bodyToFirstRow >= 0 && m.bodyToFirstRow <= 2,
      `the first folded row starts at the body's content top (${px(m.bodyToFirstRow)} below it)`,
    );
    assert.ok(
      m.headToFirstRow != null && m.headToFirstRow <= m.paddingTop + m.headToBody + 2,
      `nothing but the card's own top chrome stands between the head and the first row (head→row ${px(m.headToFirstRow)}, chrome ${px(m.headToBody)}, padding ${px(m.paddingTop)})`,
    );
    assert.ok(m.firstRow.top >= m.body.top - 1, `the row is inside the scroll body, not painted above it (${px(m.firstRow.top)} vs ${px(m.body.top)})`);
  });

  it(`[${tag}] the folded rows, reply box and token strip form one block`, async () => {
    const m = await foldedAt(vp.height);
    assert.equal(m.openTurns, 0, "the block this test reads is the all-folded one");
    assert.ok(
      m.footGap >= 0 && m.footGap <= m.composerMarginTop + 1,
      `the composer follows the card's outcome line with only its own ${px(m.composerMarginTop)} margin between them (gap ${px(m.footGap)}; rows to composer ${px(m.blockGap)}, the line itself ${px(m.foot?.height)})`,
    );
  });

  it(`[${tag}] the reply box sits under the rows and the token strip under the box`, async () => {
    const m = await foldedAt(vp.height);
    assert.ok(m.lastRow && m.replyBox, "the card draws a last folded row and a reply box");
    assert.ok(m.replyBox.top >= m.lastRow.bottom - 1, `the reply box is below the last folded row (box ${px(m.replyBox.top)}, row ends ${px(m.lastRow.bottom)})`);
    assert.ok(m.replyBox.height > 0 && m.strip && m.strip.height > 0, `both the box and the strip paint (${px(m.replyBox.height)} / ${px(m.strip?.height)})`);
    assert.ok(m.stripUnderBox, `the token strip is UNDER the reply box (box ends ${px(m.replyBox.bottom)}, strip starts ${px(m.strip?.top)})`);
    assert.ok(m.stripInsideComposer, "the strip is the composer's own last child, not a second pinned item");
  });

  it(`[${tag}] the free room under the block is the panel's own body`, async () => {
    const m = await foldedAt(vp.height);
    if (vp.height === VIEWPORTS[0].height) {
      assert.ok(m.freeBelow >= 120, `the composer block ends high, with ${px(m.freeBelow)} of grey under it (pane ${px(m.body.height)})`);
      assert.ok(!m.overflowing, `the slack is free room, not scrollable content (scrollHeight ${m.scrollHeight} vs clientHeight ${m.clientHeight})`);
    }
    if (m.freeBelow > 8) {
      assert.ok(m.probeY != null && m.probeY < m.body.bottom - 1, `the probe point is inside the body (${px(m.probeY)} vs foot ${px(m.body.bottom)})`);
      assert.equal(m.probeIsBody, true, `elementFromPoint in the space beneath the strip returns the panel body — it returned ${m.probe}`);
    } else {
      // No room to paint grey in: the claim that still has to hold is that the block starts at the head and the pane
      // scrolls FROM its first row, so nothing above the block is cut off.
      assert.equal(m.scrollTop, 0, `the pane the block outgrows starts at its first row (scrollTop ${m.scrollTop})`);
      assert.ok(m.firstRow && m.firstRow.top >= m.body.top - 1, `the first folded row is inside the scrollport (${px(m.firstRow?.top)} vs ${px(m.body.top)})`);
    }
  });

  it(`[${tag}] the folded state is captured for the report`, async () => {
    await foldedAt(vp.height);
    const shot = await shoot(`minimized-composer-folded-${vp.height}.png`);
    assert.ok(shot.bytes > 10_000, `the folded capture is a real image (${shot.bytes} bytes at ${shot.file})`);
    console.log(`      folded shot: ${shot.file} (${shot.bytes} bytes)`);
  });

  it(`[${tag}] pressing a turn head opens exactly that turn`, async () => {
    await foldedAt(vp.height);
    const id = await ensureOpen();
    const m = await measure();
    ledger.viewports[vp.height] = { ...(ledger.viewports[vp.height] || {}), open: m };
    assert.equal(m.turnCount, TURNS, "the same three turns are on the card");
    assert.equal(m.openTurns, 1, `one turn is open, not ${m.openTurns}`);
    assert.equal(m.turns.find((t) => !t.folded)?.id, id, `the turn that opened is the head this case pressed (${id})`);
  });

  it(`[${tag}] the composer moves down and is pinned to the pane's bottom`, async () => {
    const folded = await foldedAt(vp.height);
    const opened = await openedAt(vp.height);
    assert.ok(opened.composer.top > folded.composer.top + 20, `the composer MOVED DOWN (${px(folded.composer.top)} → ${px(opened.composer.top)})`);
    assert.ok(Math.abs(opened.composer.bottom - opened.body.bottom) <= 2, `its bottom is the scrollport's bottom (${px(opened.composer.bottom)} vs ${px(opened.body.bottom)})`);
    assert.equal(opened.composer.position, "sticky", `the composer is still position: sticky (${opened.composer.position})`);
    assert.equal(opened.composer.cssBottom, "0px", `…at bottom: 0 (${opened.composer.cssBottom})`);
    assert.ok(opened.stripUnderBox, `the token strip is still under the reply box (box ends ${px(opened.replyBox.bottom)}, strip starts ${px(opened.strip.top)})`);
  });

  it(`[${tag}] scrolled to the transcript's top, the composer is still pinned`, async () => {
    const opened = await openedAt(vp.height);
    assert.ok(opened.overflowing, `opening the turn made the transcript longer than the pane (scrollHeight ${opened.scrollHeight} vs clientHeight ${opened.clientHeight})`);
    const footY = opened.scrollHeight - opened.clientHeight;
    // Scroll to the transcript's FOOT first: the point of the leg is that the pin holds while the transcript moves, so
    // the scroll has to be seen to happen rather than the pane already being at its top when it opens.
    const foot = await scrollTo(footY);
    ledger.viewports[vp.height] = { ...(ledger.viewports[vp.height] || {}), scrolledFoot: foot };
    assert.ok(foot.scrollTop >= footY - 1, `the transcript really scrolled to its foot (scrollTop ${foot.scrollTop} of ${footY})`);
    assert.ok(Math.abs(foot.composer.bottom - foot.body.bottom) <= 2, `the composer is at the pane's foot there too (${px(foot.composer.bottom)} vs ${px(foot.body.bottom)})`);
    // Then back to its first line: still pinned, and the oldest row is once again inside the scrollport.
    const top = await scrollTo(0);
    ledger.viewports[vp.height] = { ...(ledger.viewports[vp.height] || {}), scrolledTop: top };
    assert.equal(top.scrollTop, 0, `the transcript is at its first line (scrollTop ${top.scrollTop})`);
    assert.ok(top.firstRow.top >= foot.firstRow.top + 200, `the transcript moved by the scroll (first row ${px(foot.firstRow.top)} → ${px(top.firstRow.top)})`);
    assert.ok(Math.abs(top.composer.bottom - top.body.bottom) <= 2, `the composer is still at the pane's foot (${px(top.composer.bottom)} vs ${px(top.body.bottom)})`);
    assert.ok(top.turns.some((t) => !t.folded), "the open turn is still open while the transcript is scrolled away");
  });

  it(`[${tag}] the open state is captured for the report`, async () => {
    await openedAt(vp.height);
    const shot = await shoot(`minimized-composer-open-${vp.height}.png`);
    assert.ok(shot.bytes > 10_000, `the open capture is a real image (${shot.bytes} bytes at ${shot.file})`);
    console.log(`      open shot: ${shot.file} (${shot.bytes} bytes)`);
  });
}

// ---- the run's own errors -----------------------------------------------------------------------------------------
it("the page logged no errors", async () => {
  assert.deepEqual(pageErrors, [], "no uncaught error reached the page");
});

it("the console logged no errors", async () => {
  assert.deepEqual(consoleErrors, [], "no console.error was written");
});
