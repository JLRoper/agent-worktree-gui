// test/e2e/assistant-rail-width.spec.mjs - the docked assistant rail's width, dragged in a real browser.
//
// WHAT THIS IS. The rail (`#assistant`) is a sticky flex column beside `main`, and `#as-split` is the one grab on the
// edge it shares with the board. These four tests are the width contract, and each of them failed on the build this
// change started from:
//
//   1. DRAG. Dragging the edge left widens the rail and narrows the board by the same pixels, past the old 640px
//      ceiling, and the board's table is still planned to fit the card it is left with. The rail used to stop at
//      640px whatever the window was, so a reader on a 1600px monitor could never give the transcript more than 40%
//      of the row.
//   2. CAP. The rail may grow to half the window and no further: a drag far past it stops on the half, and the other
//      half is the board's. `clampDockWidth` is the one authority for that number (`public/assistant.js`).
//   3. FLOORS. On a small window both sides keep a minimum: the rail its 340px floor, the board its 420px floor. A
//      remembered width at either end of the band is drawn inside the band rather than collapsing the neighbour.
//   4. RELOAD. The width the drag left is the width the next boot draws - the same localStorage record the panel's
//      other view preferences use (`wm.assistantWidth`, beside `wm.assistantOpen` and `wtgui.zoom`).
//
//   RUN   node --test --test-reporter=spec test/e2e/assistant-rail-width.spec.mjs
//
// The panel is its own (tools/panel-testkit.mjs): a throwaway server.js from THIS checkout, a spare port, its own
// config and job store, `assistant.enabled` false and `fetchSeconds` off, so no gateway or worker can be reached and
// the reader's panel on 7331 is never started, read or written. The board is a hand-cut fixture repo with six
// worktrees, so the frame the rail is measured beside is a real chart with rows in it.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadPlaywright, openPage } from "../../tools/browser.mjs";
import { git, startPanel } from "../../tools/panel-testkit.mjs";

const PW = loadPlaywright();
const SKIP = PW
  ? null
  : "BROWSER-HALF-NOT-RUN: no Playwright install found (set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright)";
const it = (name, fn) => (PW ? test(name, fn) : test(name, { skip: SKIP }, () => {}));

// The rail's band, restated here so the browser half fails loudly when the source and this file disagree. The unit
// test (test/assistant-dock.test.js) pins the same numbers against `clampDockWidth` itself.
const RAIL_MIN = 340;
const BOARD_MIN = 420;
const WIDE = { width: 1600, height: 900 };
const SMALL = { width: 900, height: 700 };
const DEFAULT_W = 480;

const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-rail-width-"));
let panel = null;
let browser = null;
let page = null;

after(async () => {
  if (browser) await browser.close().catch(() => {});
  if (panel) await panel.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

// A board with rows in it: one repo, six worktrees, commits in each so the panel draws a real chart rather than an
// empty project. Seeded before the panel boots - a running panel rewrites its own store and would race the fixture.
function seedBoard() {
  const repos = path.join(dir, "repos");
  const repo = path.join(repos, "rail-width-repo");
  mkdirSync(path.join(repo, ".worktrees"), { recursive: true });
  const commit = (where, message) => {
    git(where, ["add", "-A"]);
    return git(where, ["-c", "user.name=rail", "-c", "user.email=rail@localhost", "commit", "-q", "-m", message], {
      env: { GIT_TERMINAL_PROMPT: "0" },
    });
  };
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(repo, "README.md"), "# rail width\n", "utf8");
  commit(repo, "seed the sandbox repo");
  for (let i = 1; i <= 6; i += 1) {
    const name = `tree-${String(i).padStart(2, "0")}`;
    const where = path.join(repo, ".worktrees", name);
    git(repo, ["worktree", "add", "-q", "-b", `work/${name}`, where]);
    writeFileSync(path.join(where, `${name}.txt`), "sandbox work\n", "utf8");
    commit(where, `do the ${name} work`);
  }
}

// The rail, the board and the chart, in one read: every assertion below is a statement about these numbers.
const frame = (target) =>
  target.evaluate(() => {
    const rail = document.getElementById("assistant");
    const r = rail.getBoundingClientRect();
    const main = document.querySelector("main");
    const m = main.getBoundingClientRect();
    const section = [...document.querySelectorAll("section.project")].find((s) => s.querySelector("tr.row"));
    const wrap = section ? section.querySelector(":scope > .wt-scroll") : null;
    const table = wrap ? wrap.querySelector("table") : null;
    const t = table ? table.getBoundingClientRect() : null;
    const row = table ? table.tBodies[0].querySelector("tr.row") : null;
    const lastCell = row ? row.cells[row.cells.length - 1].getBoundingClientRect() : null;
    return {
      hidden: rail.hidden,
      railW: +r.width.toFixed(1),
      railLeft: +r.left.toFixed(1),
      railRight: +r.right.toFixed(1),
      mainW: +m.width.toFixed(1),
      mainLeft: +m.left.toFixed(1),
      mainRight: +m.right.toFixed(1),
      mainClientW: main.clientWidth,
      mainScrollW: main.scrollWidth,
      vw: document.documentElement.clientWidth,
      tableW: t ? +t.width.toFixed(1) : null,
      tableRight: t ? +t.right.toFixed(1) : null,
      wrapClientW: wrap ? wrap.clientWidth : null,
      lastCellRight: lastCell ? +lastCell.right.toFixed(1) : null,
      stored: localStorage.getItem("wm.assistantWidth"),
    };
  });

const near = (got, want, tol = 1) => Math.abs(got - want) <= tol;

// Boot the page at a viewport, with the rail open at `width` (undefined = leave the record alone, null = forget it)
// and the board expanded.
async function place(viewport, width) {
  await page.setViewportSize(viewport);
  await page.evaluate((w) => {
    if (w === null) localStorage.removeItem("wm.assistantWidth");
    else if (w !== undefined) localStorage.setItem("wm.assistantWidth", String(w));
    localStorage.removeItem("wtgui.zoom");
    localStorage.setItem("wm.assistantOpen", "1");
  }, width);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#assistant", { state: "visible", timeout: 30_000 });
  await page.waitForSelector("section.project > .project-head[data-toggle-project]", { timeout: 60_000 });
  for (const head of await page.locator("section.project > .project-head[data-toggle-project]").all()) {
    const section = head.locator("xpath=..");
    if (String((await section.getAttribute("class")) || "").includes("collapsed")) await head.click();
  }
  await page.waitForSelector("tr.row", { state: "visible", timeout: 60_000 });
  // The chart re-plans through a 140ms debounce after the row's box changes; give it one full window to settle.
  await page.waitForTimeout(400);
  return frame(page);
}

// Drag the rail's left edge by `dx` client px (negative = left = wider) in steps, and hand back the frame after the
// release. The pointer is captured by the handle, so the whole travel is delivered even past the window edge.
async function dragEdge(dx, steps = 8) {
  const box = await page.locator("#as-split").boundingBox();
  const sx = box.x + box.width / 2;
  const sy = box.y + Math.min(200, box.height / 2);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(sx + (dx * i) / steps, sy);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  await page.waitForTimeout(300);
  return frame(page);
}

it("dragging the rail's edge widens it and narrows the board beside it", async () => {
  if (!page) {
    seedBoard();
    panel = await startPanel({
      dir,
      config: {
        refreshSeconds: 4,
        worktreeSeconds: 2,
        midSeconds: 8,
        dormantSeconds: 15,
        slowSeconds: 20,
        fetchSeconds: 3600,
        scanMode: "all",
        apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
        assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
      },
    });
    browser = await PW.chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: WIDE });
    await openPage(page, panel.base, { selector: "body" });
  }

  const before = await place(WIDE, DEFAULT_W);
  assert.ok(!before.hidden, "the rail is open before the drag");
  assert.ok(near(before.railW, DEFAULT_W), `the rail starts at its default ${DEFAULT_W}px, got ${before.railW}`);
  assert.ok(near(before.mainRight, before.railLeft), "the board's right edge is the rail's left edge");

  const after = await dragEdge(-280);

  assert.ok(near(after.railW, before.railW + 280, 2),
    `the drag widens the rail by the pointer's travel: ${before.railW} -> ${after.railW}, want ${before.railW + 280}`);
  assert.ok(after.railW > 640,
    `the rail passes the old 640px ceiling on a ${after.vw}px window, got ${after.railW}`);
  assert.ok(near(after.mainW, before.mainW - 280, 2),
    `the board gives up exactly that width: ${before.mainW} -> ${after.mainW}, want ${before.mainW - 280}`);
  assert.ok(near(after.mainRight, after.railLeft), "and the two still share one edge, so the rail is beside it");
  assert.ok(after.tableW != null && after.tableRight <= after.mainRight + 1,
    `the chart stays inside the board: table ends ${after.tableRight}, main ends ${after.mainRight}`);
  assert.ok(after.tableW != null && after.tableW <= after.wrapClientW + 1,
    `and the table is planned to its wrapper: table ${after.tableW}, wrapper ${after.wrapClientW}`);
  assert.equal(after.stored, String(Math.round(after.railW)), "the width it drew is the width it stored");
});

it("the cap holds at half the window, and the board keeps the other half", async () => {
  assert.ok(page, "the panel booted in the first test");
  const start = await place(WIDE, DEFAULT_W);
  const half = Math.floor(start.vw / 2);
  const capped = await dragEdge(-1200);

  assert.ok(near(capped.railW, half, 1),
    `a drag far past the cap stops at half the ${capped.vw}px window: got ${capped.railW}, want ${half}`);
  assert.ok(near(capped.mainW, capped.vw - half, 2),
    `the board keeps the other half: got ${capped.mainW}, want ${capped.vw - half}`);
  assert.equal(capped.stored, String(Math.round(capped.railW)), "and the overshoot is not what is remembered");
  assert.ok(capped.railW > 640, `half of ${capped.vw} is wider than the old 640px ceiling, got ${capped.railW}`);
});

it("both sides keep a minimum at a small viewport", async () => {
  assert.ok(page, "the panel booted in the first test");
  const floor = await place(SMALL, 200);
  assert.ok(near(floor.railW, RAIL_MIN, 1), `a remembered 200px is drawn at the rail's floor: got ${floor.railW}, want ${RAIL_MIN}`);
  assert.ok(floor.mainW >= BOARD_MIN - 1, `and the board is still ${BOARD_MIN}px or wider: got ${floor.mainW}`);

  const cap = await place(SMALL, 900);
  const half = Math.floor(cap.vw / 2);
  assert.ok(cap.railW >= RAIL_MIN - 1, `a remembered 900px keeps the rail's floor: got ${cap.railW}, want ${RAIL_MIN} or more`);
  assert.ok(cap.railW <= half + 1, `and never more than half the window: got ${cap.railW}, half ${half}`);
  assert.ok(cap.mainW >= BOARD_MIN - 1,
    `the board keeps its ${BOARD_MIN}px floor on a ${cap.vw}px window: got ${cap.mainW}`);
  assert.ok(near(cap.mainRight, cap.railLeft), "the two still share one edge at the small size");
  // The chart's own box inside the board, so the rail is beside the board rather than over it. (The table's plan
  // against its wrapper is the fit code's business, and at this width its columns are on their floors: the wrapper
  // comes out 6px narrower than the planned table, where the old 60% cap left it 35px narrower.)
  assert.ok(cap.tableRight != null && cap.tableRight <= cap.mainRight + 1,
    `the chart stays inside the board: table ends ${cap.tableRight}, main ends ${cap.mainRight}`);
});

it("the width survives a reload", async () => {
  assert.ok(page, "the panel booted in the first test");
  const before = await place(WIDE, DEFAULT_W);
  const dragged = await dragEdge(-280);
  assert.ok(near(dragged.railW, before.railW + 280, 2),
    `the drag widens the rail first: ${before.railW} -> ${dragged.railW}`);

  // The open flag is remembered too, so the reload comes back with the rail already up - press nothing.
  const reloaded = await place(WIDE, undefined);
  assert.ok(near(reloaded.railW, dragged.railW, 1),
    `the reload draws the width the drag left: dragged ${dragged.railW}, reloaded ${reloaded.railW}`);
  assert.ok(near(reloaded.mainW, dragged.mainW, 1),
    `and the board comes back the same size: dragged ${dragged.mainW}, reloaded ${reloaded.mainW}`);
  assert.equal(reloaded.stored, String(Math.round(dragged.railW)), "the same number is still on the record");
});
