#!/usr/bin/env node
// THE LANE-COUNT GATE: the wave lane drawn at 2, 3, 4 and 6 lanes, at the panel's real wave column and at the 900px
// panel, measured from the rendered page.
//
// HARNESS: LIVE GATE
//
//   node tools/verify-wave-lane-counts.mjs                 the gate: exit 1 when a count wraps a title per character
//   node tools/verify-wave-lane-counts.mjs --shots <dir>   also keep one screenshot per drawing
//   node tools/verify-wave-lane-counts.mjs --json <file>   write the measurements beside the shots
//
// THE BRIEF IT ANSWERS. Row 491 implements the lane count as the drawing's own dimension: two lanes are the two-line
// card (the 2026-11-28 report's O4), three or more are the manifest table (its O3). The report's section 5 measured
// that at 2, 4 and 6 lanes; this gate measures the SHIPPED drawings on the real panel at the same wave-column widths,
// and it fails on the state the report exists to stop - a lane count whose title track collapses so the words wrap one
// character per line (O1 at three lanes: 0px titles, 75 to 95 lines each).
//
// WHAT IS MEASURED, per lane count and width: which drawing the count got, the wave box height, every member's title
// width and rendered line count, the lane column's width and whether its label is clipped, and the wave's horizontal
// overflow. The numbers are written to JSON so the report beside them quotes what this run measured, not a screenshot
// read by eye.
//
// THRESHOLDS ARE THE ARGUMENT. A healthy title is at least 400px wide with at most 3 lines at the real column, and at
// least 180px with at most 5 lines at the 900px panel. The failure this gate exists for is not near either bound: it is
// a title track of 0 to 4px and 70+ lines. Anything under 60px or over 12 lines is named as per-character wrapping in
// its own FAIL, so the reason is on the row rather than inside a number.
//
// Sandbox only: buildFixture writes a throwaway WAG_HOME under the OS temp dir and server.js is booted on a free port
// with it. The live panel on 7331 and ~/.wag are never read or written.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPlaywright, notRun, openPage, withBrowser, withPage } from "./browser.mjs";
import { buildFixture, startFixturePanel, waitForFixtureRows } from "./initiatives-fixture.mjs";
import { git } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SHOTS = path.resolve(opt("--shots", path.join(ROOT, "docs", "reports", "wave-lane-counts")));
const JSON_OUT = path.resolve(opt("--json", path.join(SHOTS, "lane-counts.json")));
const HOME = path.resolve(opt("--home", path.join(ROOT, "..", "wag-wave-lane-counts")));

// The real column and the 900px panel, as the panel measures them: a 1384px float gives the Initiatives pane a 1304px
// wave column, and a 900px float gives it 804px. The gate reads both back from the page and fails if they move, because
// a proof at a different width is a proof of a different drawing.
const WIDE = { viewport: { width: 1400, height: 1000 }, floatW: 1384, waveColumn: 1304 };
const NARROW = { viewport: { width: 900, height: 900 }, floatW: 900, waveColumn: 804 };
const COUNTS = [2, 3, 4, 6];
// The report's own titles: 131 characters is what makes a wrap count mean something, and reusing them keeps this gate's
// numbers comparable with section 5's.
// THE REPORT'S OWN FIXTURE, member for member. Its three members are 444 and 446 in one lane and 445 in the unlaned
// lane; the probe added one member per added lane (448, 449, 450, 451). Reusing the same ids and the same 85 to 131
// character titles is what makes this gate's numbers comparable with section 5's and with lane-scaling.json line for
// line: the drawing is the only variable.
const TITLES = {
  444: "Give the board table home sheet 46 of 316 rules live in board.css and 270 come from 11 others",
  446: "Dissolve late.css: 62 rules, 62 sole definitions - the cut file, the 316 window, the legend popover and the search",
  445: "Break the console eight-sheet surface into sub-sheets: 56 of its 102 rules live outside console.css",
  448: "Retry the rating consumer on a dead-letter replay: one idempotency key, two sources",
  449: "Rotate the Event Hubs certificate before the quarter window closes and prove the inbound hub still accepts it",
  450: "Dissolve late.css: 62 rules, 62 sole definitions - the cut file, the 316 window, the legend popover and the search",
  451: "Give the wave lane one host sheet: 46 of its 316 rules live in board.css and 270 come from 11 others",
};
const LANE_INDEX = "public/index.html";
const LANE_DOM = "public/core/dom.js";
const LANE_JAVA = "src/main/java/com/sefl/rating/RatingRetryConsumer.java";
const LANE_LATE = "late.css";
const LANE_WAVES = "public/core/waves-lane.js";
// One member list per lane count: the three-member two-lane wave, then one added lane and its member at each count.
const WAVE_MEMBERS = {
  2: [
    { lane: LANE_INDEX, tree: 0, title: 444, state: "running" },
    { lane: LANE_INDEX, tree: 0, title: 446, state: "queued" },
    { lane: null, tree: null, title: 445, state: "queued" },
  ],
  3: [
    { lane: LANE_INDEX, tree: 0, title: 444, state: "running" },
    { lane: LANE_INDEX, tree: 0, title: 446, state: "queued" },
    { lane: null, tree: null, title: 445, state: "queued" },
    { lane: LANE_DOM, tree: 1, title: 448, state: "queued" },
  ],
  4: [
    { lane: LANE_INDEX, tree: 0, title: 444, state: "running" },
    { lane: LANE_INDEX, tree: 0, title: 446, state: "queued" },
    { lane: null, tree: null, title: 445, state: "queued" },
    { lane: LANE_DOM, tree: 1, title: 448, state: "queued" },
    { lane: LANE_JAVA, tree: 2, title: 449, state: "queued" },
  ],
  6: [
    { lane: LANE_INDEX, tree: 0, title: 444, state: "running" },
    { lane: LANE_INDEX, tree: 0, title: 446, state: "queued" },
    { lane: null, tree: null, title: 445, state: "queued" },
    { lane: LANE_DOM, tree: 1, title: 448, state: "queued" },
    { lane: LANE_JAVA, tree: 2, title: 449, state: "queued" },
    { lane: LANE_LATE, tree: 3, title: 450, state: "done" },
    { lane: LANE_WAVES, tree: 4, title: 451, state: "done" },
  ],
};
const PROJECT = "agent-worktree-gui";

let failures = 0;
let checks = 0;
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` - ${extra}` : ""}`);
  }
};
const note = (s) => console.log(`      ${s}`);
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const hours = (n) => n * 3_600_000;

// ---- the fixture: one project, six lane trees, four waves of 2, 3, 4 and 6 lanes ---------------------------------
function seedLaneCounts(home) {
  buildFixture({ home, reset: true });
  const repo = path.join(home, "repos", PROJECT);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(repo, "README.md"), `# ${PROJECT}\n\nA throwaway project for the lane-count gate.\n`, "utf8");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "seed the lane-count project"]);
  const trees = [];
  for (let i = 0; i < 6; i += 1) {
    const name = `lane-${i + 1}`;
    const where = path.join(repo, ".worktrees", name);
    git(repo, ["worktree", "add", "-q", "-b", `wtgui/${name}`, where]);
    writeFileSync(path.join(where, `${name}.txt`), `work for ${name}\n`, "utf8");
    git(where, ["add", "-A"]);
    git(where, ["commit", "-q", "-m", `start ${name}`]);
    trees.push(where.replace(/\\/g, "/"));
  }
  const configFile = path.join(home, "config.json");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.projects.push({ name: PROJECT, path: repo, remote: "origin", mainBranch: "main" });
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  // The initiative the four waves hang on, and the six trees behind it, so the card is a card the board scanned.
  const initFile = path.join(home, "state", "initiatives.json");
  const doc = JSON.parse(readFileSync(initFile, "utf8"));
  doc.initiatives.unshift({
    id: "init_lanes",
    title: "The lane count decides the drawing: two lanes are cards, three or more are a manifest table",
    description: "Source: docs/reports/initiatives-wave-lane-options-2026-11-28.html section 5. The same wave at 2, 3, 4 and 6 lanes, drawn by public/core/waves-lane.js and measured by tools/verify-wave-lane-counts.mjs.",
    createdAt: ago(hours(40)),
    updatedAt: ago(hours(1)),
    createdBy: "reader",
    updatedBy: "reader",
    history: [{ at: ago(hours(40)), by: "reader", action: "create", detail: "the lane count decides the drawing" }],
  });
  for (const where of trees) {
    doc.trees[where.toLowerCase()] = {
      path: where,
      initiatives: ["init_lanes"],
      members: { init_lanes: { at: ago(hours(20)), by: "reader" } },
      at: ago(hours(20)),
      by: "reader",
    };
  }
  writeFileSync(initFile, `${JSON.stringify(doc, null, 1)}\n`, "utf8");

  // One assistant, so every member carries an owner chip and the lane's words are the ones the route serves.
  const assistFile = path.join(home, "state", "assistants.json");
  const assistants = JSON.parse(readFileSync(assistFile, "utf8"));
  assistants.assistants.push({ id: "assistant-3", name: "Manager 3", roleId: "assistant-agent-manager", threadId: "panel-assistant-3", rules: [], createdAt: ago(hours(400)) });
  writeFileSync(assistFile, `${JSON.stringify(assistants, null, 1)}\n`, "utf8");

  // FOUR WAVES, one per count, each shaped like the report's own fixture: three members in two lanes, then one member
  // per added lane. The first lane holds two members so the table's repeat cell is in the picture at every count.
  const base = {
    detail: "", owner: null, createdBy: "reader", createdAt: ago(hours(4)), startedAt: null, doneAt: null, doneBy: null,
    threads: [], project: PROJECT, files: [], lane: null, order: null, attempts: 0, reason: "", hold: null, movedFrom: [], runId: null,
  };
  const waves = [];
  const tasks = [];
  let id = 200;
  for (const count of COUNTS) {
    const waveId = `wave-${count}`;
    waves.push({
      id: waveId,
      initiativeId: "init_lanes",
      position: waves.length + 1,
      title: `${count} lanes: the same wave drawn as ${count === 2 ? "the two-line card" : "the manifest table"}`,
      entryGate: null,
      exitGate: null,
      template: null,
      auto: false,
    });
    WAVE_MEMBERS[count].forEach((m, k) => {
      id += 1;
      tasks.push({
        ...base,
        id,
        title: TITLES[m.title],
        state: m.state,
        thread: `wtgui-lane-${count}-${k}`,
        worktree: m.tree,
        waveId,
        lane: m.lane,
        startedAt: m.state === "running" ? ago(9 * 60_000) : null,
        doneAt: m.state === "done" ? ago(hours(1)) : null,
        doneBy: m.state === "done" ? "assistant-3" : null,
      });
    });
  }
  const qdir = path.join(home, "state", "assistants", "assistant-3");
  mkdirSync(qdir, { recursive: true });
  writeFileSync(path.join(qdir, "queue.json"), `${JSON.stringify({ version: 1, nextId: 400, tasks }, null, 1)}\n`, "utf8");
  writeFileSync(
    path.join(home, "state", "waves.json"),
    `${JSON.stringify({ version: 1, savedAt: new Date().toISOString(), byInitiative: { init_lanes: waves } }, null, 1)}\n`,
    "utf8",
  );
  return { trees, waves, tasks };
}

// ---- the measurement: one wave, read off the rendered page ---------------------------------------------------------
function measureWave(waveId) {
  const pane = document.getElementById("as-initiatives");
  const wave = pane.querySelector(`[data-wave-id="${waveId}"]`);
  if (!wave) return { error: "no wave" };
  const lanesEl = wave.querySelector(".wave-lanes");
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const members = [...wave.querySelectorAll("[data-wave-member]")].map((m) => {
    const t = m.querySelector(".wave-member-title");
    const cs = t ? getComputedStyle(t) : null;
    const r = t ? t.getBoundingClientRect() : null;
    const lh = cs ? parseFloat(cs.lineHeight) : 0;
    return {
      id: m.getAttribute("data-wave-member"),
      draw: m.getAttribute("data-member-draw"),
      titleW: r ? Math.round(r.width) : null,
      lines: lh && r ? Math.round(r.height / lh) : null,
      overflow: t ? Math.round(t.scrollWidth - t.clientWidth) : 0,
      memberH: Math.round(m.getBoundingClientRect().height),
    };
  });
  const laneCells = [...wave.querySelectorAll(".wave-lane-cell:not(.is-rep)")].map((c) => {
    const name = c.querySelector(".wave-lane-name");
    const cs = name ? getComputedStyle(name) : null;
    const r = name ? name.getBoundingClientRect() : null;
    const lh = cs ? parseFloat(cs.lineHeight) : 0;
    return {
      full: c.getAttribute("data-lane-full"),
      shown: name ? String(name.textContent || "").trim() : "",
      colW: Math.round(c.getBoundingClientRect().width),
      labelW: r ? Math.round(r.width) : null,
      clipped: name ? name.scrollWidth > name.clientWidth + 1 : null,
      lines: lh && r ? Math.round(r.height / lh) : null,
    };
  });
  return {
    drawing: lanesEl ? lanesEl.getAttribute("data-lane-drawing") : null,
    lanes: lanesEl ? Number(lanesEl.getAttribute("data-wave-lanes")) : null,
    waveW: box(wave)?.w,
    waveH: box(wave)?.h,
    waveOverflow: Math.round(wave.scrollWidth - wave.clientWidth),
    paneOverflow: Math.round(pane.scrollWidth - pane.clientWidth),
    sums: wave.querySelectorAll(".wave-lane-sum").length,
    head: Boolean(wave.querySelector(".wave-manifest-head")),
    // The wave's own parts, so a box-height difference from the report's O4/O3 row can be named rather than guessed.
    // Each part is its offset from the wave's top edge and its height: the gaps between them are the difference of the
    // two, which is what tells a drawing from the station chrome around it.
    parts: (() => {
      const top = wave.getBoundingClientRect().top;
      const at = (sel) => {
        const el = wave.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { y: Math.round(r.top - top), h: Math.round(r.height) };
      };
      return {
        head: at(".wave-head"),
        gates: at(".wave-gates"),
        close: at(".wave-close"),
        actions: at(".wave-actions"),
        lanes: at(".wave-lanes"),
        lane: at(".wave-lane"),
        sums: at(".wave-lane-sums"),
        manifest: at(".wave-manifest"),
        join: at(".wave-join"),
      };
    })(),
    members,
    laneCells,
    widestTitle: Math.max(0, ...members.map((m) => m.titleW || 0)),
    maxLines: Math.max(0, ...members.map((m) => m.lines || 0)),
    maxOverflow: Math.max(0, ...members.map((m) => m.overflow || 0)),
  };
}

const linesOf = (m) => (m?.members || []).map((x) => x.lines).join(" / ");
const titlesOf = (m) => [...new Set((m?.members || []).map((x) => x.titleW))].join(" / ");
// THE FAILURE THIS GATE EXISTS FOR, as one predicate: a title track that collapsed to a character column, or a title
// that fell apart into more lines than words. It is used by every count's assertion AND by the self-check below, so
// the check that fires on a real collapse is the same code that runs against the shipped page.
const perCharTitles = (m) => (m?.members || []).filter((x) => (x.titleW || 0) < PER_CHAR_W || (x.lines || 0) > PER_CHAR_LINES);

// The thresholds, and the failure they are drawn against. O1 at three lanes measured 0px titles and 75 to 95 lines;
// the shipped drawings measure hundreds of pixels and one to three lines. A gate whose bound is between those two
// states cannot pass by drift.
const FLOOR = { wide: { w: 400, lines: 3, box: 560 }, narrow: { w: 180, lines: 5, box: 900 } };
const PER_CHAR_W = 60;
const PER_CHAR_LINES = 12;

const seed = seedLaneCounts(HOME);
const ledger = { at: new Date().toISOString(), root: ROOT.replace(/\\/g, "/"), home: HOME.replace(/\\/g, "/"), version: JSON.parse(openPackage()).version, widths: {}, waves: {}, checks: 0, failures: 0 };

function openPackage() {
  return readFileSync(path.join(ROOT, "package.json"), "utf8");
}

let panel = null;
try {
  mkdirSync(SHOTS, { recursive: true });
  panel = await startFixturePanel({ home: HOME, root: ROOT });
  ok("the fixture panel boots off the live 7331", panel.port !== 7331, `${panel.base} (pid ${panel.pid})`);
  await waitForFixtureRows(panel.base);
  // THE PANEL'S FLOATING FRAME is what gives the Initiatives pane the reader's real width; docked, the rail is narrow
  // at every viewport and the proof would measure a 300px wave column instead of 1304px.
  const dock = await fetch(`${panel.base}/api/settings/general`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dockMode: "floating" }),
    signal: AbortSignal.timeout(8000),
  });
  ok("the fixture panel is in its floating frame", dock.ok, String(dock.status));

  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the lane-count gate", "playwright is not installed for this node (see tools/browser.mjs)"));
    failures += 1;
  } else {
    const openLaneCard = async (page) => {
      await openPage(page, panel.base, { selector: "#btn-assistant" });
      const open = await page.evaluate(() => {
        const el = document.getElementById("assistant");
        return Boolean(el) && !el.hidden && getComputedStyle(el).display !== "none";
      });
      if (!open) await page.click("#btn-assistant");
      await page.waitForSelector("#assistant:not([hidden])", { timeout: 20_000 });
      await page.click('#as-tabs [data-as-tab="initiatives"]');
      await page.waitForSelector("#as-initiatives:not(.hidden)", { timeout: 20_000 });
      await page.waitForSelector('[data-init-card="init_lanes"]', { timeout: 60_000 });
      const card = page.locator('[data-init-card="init_lanes"]');
      if (await card.evaluate((el) => el.classList.contains("is-titlecard"))) await card.locator(".init-head-btn").click();
      await page.waitForSelector('[data-init-card="init_lanes"] [data-wave-id="wave-2"]', { timeout: 60_000 });
      await page.waitForSelector('[data-init-card="init_lanes"] [data-wave-id="wave-6"] [data-wave-member]', { timeout: 60_000 });
      await page.evaluate(() => document.fonts.ready.catch(() => {}));
    };

    // The reader's floating frame, seeded before the first navigation: the same geometry at both widths.
    const floatInit = (width) => [
      [
        (w) => {
          localStorage.setItem("wm.assistantOpen", "1");
          localStorage.setItem("wm.assistantFloat", JSON.stringify({ x: 8, y: 60, w, h: 860 }));
        },
        width,
      ],
    ];

    const runWidth = async (browser, spec, tag) => {
      await withPage(
        browser,
        async ({ page }) => {
          await openLaneCard(page);
          const waveColumn = await page.evaluate(() => document.querySelector('#as-initiatives [data-init-card="init_lanes"] .init-waves').clientWidth);
          ledger.widths[tag] = { viewport: spec.viewport.width, float: spec.floatW, waveColumn };
          note(`${tag}: panel ${spec.viewport.width}px, wave column ${waveColumn}px`);
          ok(`${tag}: the wave column is the report's width`, Math.abs(waveColumn - spec.waveColumn) <= 6, `${waveColumn}px vs ${spec.waveColumn}px`);
          ledger.waves[tag] = {};
          for (const count of COUNTS) {
            const m = await page.evaluate(measureWave, `wave-${count}`);
            ledger.waves[tag][count] = m;
            console.log(`      ${count} lanes: ${m.drawing}, title ${titlesOf(m)}px, wraps ${linesOf(m)}, box ${m.waveH}px, overflow ${m.waveOverflow}px, sums ${m.sums}, head ${m.head}`);
            // WHICH DRAWING: the count is the module's choice, and the page must show the one the report recommended.
            ok(`${tag} ${count} lanes: the drawing is ${count === 2 ? "the two-line card" : "the manifest table"}`, m.drawing === (count === 2 ? "cards" : "table"), String(m.drawing));
            ok(`${tag} ${count} lanes: the block carries the count a gate reads`, m.lanes === count, String(m.lanes));
            ok(`${tag} ${count} lanes: no member row is missing its drawing`, (m.members || []).every((x) => x.draw === (count === 2 ? "card" : "table")), JSON.stringify((m.members || []).map((x) => x.draw)));
            // THE GATE ITSELF: no title may collapse to a per-character column, and none may overflow its track.
            const floor = FLOOR[tag];
            const perChar = perCharTitles(m);
            ok(`${tag} ${count} lanes: no title wraps per character`, perChar.length === 0, perChar.length ? `${perChar.length} title(s) at ${perChar.map((x) => `${x.titleW}px/${x.lines} lines`).join(", ")} - the O1-at-three-lanes failure` : `${titlesOf(m)}px, ${linesOf(m)} lines`);
            ok(`${tag} ${count} lanes: every title keeps at least ${floor.w}px`, (m.members || []).every((x) => (x.titleW || 0) >= floor.w), titlesOf(m));
            ok(`${tag} ${count} lanes: every title stays within ${floor.lines} lines`, (m.members || []).every((x) => (x.lines || 0) <= floor.lines), linesOf(m));
            ok(`${tag} ${count} lanes: the title and the wave do not overflow sideways`, m.maxOverflow === 0 && m.waveOverflow === 0, `titles ${m.maxOverflow}px, wave ${m.waveOverflow}px`);
            ok(`${tag} ${count} lanes: the wave box holds its own bound`, (m.waveH || 0) <= floor.box, `${m.waveH}px of ${floor.box}px`);
            // THE LANE COLUMN, at three or more: one summary cell per lane, a header, a short label that is not clipped,
            // and the whole path still in the DOM for the hover.
            if (count >= 3) {
              ok(`${tag} ${count} lanes: the summary strip keeps one cell per lane`, m.sums === count, `${m.sums} of ${count}`);
              ok(`${tag} ${count} lanes: the manifest has the head row`, m.head === true);
              ok(`${tag} ${count} lanes: every lane cell keeps its whole path`, (m.laneCells || []).every((c) => Boolean(c.full)), JSON.stringify((m.laneCells || []).map((c) => c.full)));
              ok(`${tag} ${count} lanes: no lane label is clipped or broken`, (m.laneCells || []).every((c) => c.clipped === false && (c.lines || 0) <= 1), JSON.stringify((m.laneCells || []).map((c) => ({ shown: c.shown, w: c.labelW, col: c.colW, clipped: c.clipped, lines: c.lines }))));
            }
            await page.locator(`[data-init-card="init_lanes"] [data-wave-id="wave-${count}"]`).screenshot({ path: path.join(SHOTS, `${count}lanes-${tag}.png`) });
          }
        },
        {
          viewport: spec.viewport,
          deviceScaleFactor: 1,
          initScripts: floatInit(spec.floatW),
        },
      );
    };

    await withBrowser(
      async ({ browser }) => {
        await runWidth(browser, WIDE, "wide");
        await runWidth(browser, NARROW, "narrow");

        // THE GATE'S OWN FAILURE PATH. A gate nobody has watched fail is a gate that might only know how to print PASS.
        // This pass injects the O1 collapse into the 3-lane manifest - seven fixed columns that leave the title a few
        // dozen pixels - and requires the SAME predicate the gate runs to fire. Nothing is written to the page after
        // this read: the style tag lives in a throwaway context that closes with the pass.
        await withPage(
          browser,
          async ({ page }) => {
            await openLaneCard(page);
            await page.addStyleTag({
              content:
                '#as-initiatives [data-wave-id="wave-3"] .wave-manifest, #as-initiatives [data-wave-id="wave-3"] .wave-member[data-member-draw="table"] { grid-template-columns: 200px 200px 200px 200px minmax(0,1fr) 200px 200px; }',
            });
            await page.waitForTimeout(120);
            const collapsed = await page.evaluate(measureWave, "wave-3");
            const fired = perCharTitles(collapsed);
            ledger.selfCheck = { titleW: collapsed.widestTitle, maxLines: collapsed.maxLines, fired: fired.length, members: collapsed.members };
            ok("the gate's failure path fires when a title track collapses", fired.length > 0, `title ${collapsed.widestTitle}px, ${collapsed.maxLines} lines, ${fired.length} of ${collapsed.members.length} titles flagged`);
          },
          { viewport: WIDE.viewport, deviceScaleFactor: 1, initScripts: floatInit(WIDE.floatW) },
        );
      },
      { viewport: WIDE.viewport, deviceScaleFactor: 1 },
    );

    // THE TWO-LANE DRAWING IS THE REPORT'S O4, and the drawing's own numbers must not move: 475px titles and two wraps
    // at the real column (707px and one wrap at the 900px panel), with the lane box at 184px and a member row at 69px.
    // THE WAVE BOX IS NOT THE DRAWING: it also holds the station's head, its gate strip, its padding and its action row,
    // which the report's stage draws 19px tighter. The box is compared with that allowance and the parts are printed,
    // so a moved drawing cannot hide inside a chrome difference.
    const o4w = ledger.waves.wide?.[2];
    const o4n = ledger.waves.narrow?.[2];
    const near = (got, want, tol) => Math.abs((got || 0) - want) <= tol;
    const laneH = (m) => m?.parts?.lane?.h ?? null;
    const memberH = (m) => Math.max(0, ...(m?.members || []).map((x) => x.memberH || 0));
    ok("two lanes at the real column keep O4's title width", near(o4w?.widestTitle, 475, 14), `${o4w?.widestTitle}px vs the report's 475px`);
    ok("two lanes at the real column keep O4's two wraps", o4w?.maxLines === 2, `${linesOf(o4w)} vs the report's 2 / 2 / 2`);
    ok("two lanes at the real column keep O4's lane box", near(laneH(o4w), 184, 4), `${laneH(o4w)}px vs the report's 184px`);
    ok("two lanes at the real column keep O4's member row", near(memberH(o4w), 69, 4), `${memberH(o4w)}px vs the report's 69px`);
    ok("two lanes at the real column keep O4's wave box, within the station chrome", near(o4w?.waveH, 288, 26), `${o4w?.waveH}px vs the report's 288px; head ${JSON.stringify(o4w?.parts?.head)}, gates ${JSON.stringify(o4w?.parts?.gates)}, close ${JSON.stringify(o4w?.parts?.close)}, actions ${JSON.stringify(o4w?.parts?.actions)}`);
    ok("two lanes at the 900px panel keep O4's title width", near(o4n?.widestTitle, 707, 14), `${o4n?.widestTitle}px vs the report's 707px`);
    ok("two lanes at the 900px panel keep O4's one wrap", o4n?.maxLines === 1, `${linesOf(o4n)} vs the report's 1 / 1 / 1`);
    ok("two lanes at the 900px panel keep O4's lane box", near(laneH(o4n), 148, 4), `${laneH(o4n)}px vs the report's 148px`);
    ok("two lanes at the 900px panel keep O4's member row", near(memberH(o4n), 51, 4), `${memberH(o4n)}px vs the report's 51px`);
    ok("two lanes at the 900px panel keep O4's wave box, within the station chrome", near(o4n?.waveH, 413, 26), `${o4n?.waveH}px vs the report's 413px; head ${JSON.stringify(o4n?.parts?.head)}, gates ${JSON.stringify(o4n?.parts?.gates)}, close ${JSON.stringify(o4n?.parts?.close)}, actions ${JSON.stringify(o4n?.parts?.actions)}`);

    // AND THE TABLE IS THE REPORT'S O3: one title width at every count, and a box that grows with members only.
    const sameWidth = (tag) => {
      const set = COUNTS.filter((c) => c >= 3).map((c) => ledger.waves[tag]?.[c]?.widestTitle);
      return new Set(set).size === 1;
    };
    ok("three or more lanes keep one title width at the real column", sameWidth("wide"), COUNTS.filter((c) => c >= 3).map((c) => `${c}:${ledger.waves.wide?.[c]?.widestTitle}px`).join(", "));
    ok("three or more lanes keep one title width at the 900px panel", sameWidth("narrow"), COUNTS.filter((c) => c >= 3).map((c) => `${c}:${ledger.waves.narrow?.[c]?.widestTitle}px`).join(", "));
  }

  ledger.checks = checks;
  ledger.failures = failures;
  writeFileSync(JSON_OUT, `${JSON.stringify(ledger, null, 1)}\n`, "utf8");
  note(`measurements ${JSON_OUT.replace(/\\/g, "/")}`);
  note(`shots ${SHOTS.replace(/\\/g, "/")}`);
  console.log(`\n${failures ? `FAILED (${failures} of ${checks})` : `all ${checks} checks passed`}`);
  process.exitCode = failures ? 1 : 0;
} catch (err) {
  failures += 1;
  console.error(`GATE FAILED: ${String((err && err.stack) || err)}`);
  process.exitCode = 1;
} finally {
  if (panel) await panel.stop().catch(() => {});
  process.exit(process.exitCode || 0);
}
