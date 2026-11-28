#!/usr/bin/env node
// THE LANE-COUNT PROBE: what each mechanism in docs/reports/initiatives-wave-lane-options-2026-11-28.html does when
// the SAME wave holds more lanes. The report's fixture is two lanes; a lane is a file, and a wave can hold one per
// surface, so this probe adds lanes to the report's own stages - one member each, one of them from a second project -
// and measures the CSS that is already in the page. No new styles, no fixture, no panel: the drawing under test is the
// report's.
//
// WHY IT IS A SEPARATE TOOL. The capture tool boots the initiatives fixture and photographs the report's two-lane
// stages; this one only needs the report file, so it can be rerun in a second without a panel. It writes the PNGs the
// report's "more lanes" section embeds and docs/reports/wave-lane-options/lane-scaling.json, the numbers behind them.
//
// WHAT IS MEASURED, per option and lane count: the wave box height, the lane widths and how many rows of lanes the
// grid produced, each member's title width (the widest is quoted), its wrap count and any horizontal overflow. A title
// width of 0 is not a rounding: at three lanes the six fixed columns (404px) no longer fit a 344px lane, so the title
// track collapses and the words wrap one character per line. That is the failure this probe exists to show.
//
// Exit: 0 written; 2 Playwright missing; 1 anything threw.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright, notRun, withBrowser, withPage } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const REPORT = path.join(ROOT, "docs", "reports", "initiatives-wave-lane-options-2026-11-28.html");
const OUT = path.join(ROOT, "docs", "reports", "wave-lane-options");
const STAGE_W = 1304;

// The three members the report starts with, plus one per added lane. Two of the added lanes are agent-worktree-gui
// files and one is an optym-integration-multi Java file, so the probe covers the multi-project case the reader named.
const EXTRA = [
  { id: 448, lane: "public/core/dom.js", project: "agent-worktree-gui", title: "Retry the rating consumer on a dead-letter replay: one idempotency key, two sources" },
  { id: 449, lane: "src/main/java/com/sefl/rating/RatingRetryConsumer.java", project: "optym-integration-multi", title: "Rotate the Event Hubs certificate before the quarter window closes and prove the inbound hub still accepts it" },
  { id: 450, lane: "late.css", project: "agent-worktree-gui", title: "Dissolve late.css: 62 rules, 62 sole definitions - the cut file, the 316 window, the legend popover and the search" },
  { id: 451, lane: "public/core/waves-lane.js", project: "agent-worktree-gui", title: "Give the wave lane one host sheet: 46 of its 316 rules live in board.css and 270 come from 11 others" },
];

// RUNS: the wave's lane count to add. O1 is run at three lanes because that is the count where its title collapses;
// every mechanism is run at four, and the three that survive are also run at six.
const RUNS = [["O1", 3], ["O1", 4], ["O2", 4], ["O2", 6], ["O3", 4], ["O3", 6], ["O4", 4], ["O4", 6]];
const SHOTS = new Set(["O1:3", "O2:4", "O3:4", "O4:4"]);

function probe({ option, count, extra, stageW }) {
  const sec = document.querySelector(`[data-option="${option}"]`);
  const wave = sec?.querySelector('[data-wave-id="wave-split"]');
  if (!wave) return { error: "no wave" };
  const laneSel = option === "O2" ? ".bandlanes > .wave-lane" : ".wave-lane";
  let lanes = [...wave.querySelectorAll(laneSel)];
  while (lanes.length > count) {
    lanes[lanes.length - 1].remove();
    lanes = [...wave.querySelectorAll(laneSel)];
  }
  const host = lanes[0]?.parentElement;
  let n = 2;
  while (lanes.length < count && host) {
    const e = extra[n - 2];
    if (!e) break;
    const clone = lanes[1].cloneNode(true);
    clone.setAttribute("data-wave-lane", e.lane);
    clone.setAttribute("data-lane-state", "queued");
    const chip = clone.querySelector(".chip.mstate");
    if (chip) {
      chip.className = "chip mstate is-queued";
      chip.textContent = `lane ${e.lane} - queued`;
    }
    [...clone.querySelectorAll(".wave-member")].slice(1).forEach((m) => m.remove());
    const m = clone.querySelector(".wave-member");
    if (m) {
      m.setAttribute("data-wave-member", String(e.id));
      const id = m.querySelector(".wave-member-id, .mid");
      if (id) id.textContent = `#${e.id}`;
      const t = m.querySelector(".wave-member-title, .mtitle");
      if (t) t.textContent = e.title;
      const p = m.querySelector(".proj");
      if (p) p.textContent = e.project;
      const st = m.querySelector(".chip.mstate");
      if (st) {
        st.className = "chip mstate is-queued";
        st.textContent = "queued";
      }
    }
    host.appendChild(clone);
    lanes = [...wave.querySelectorAll(laneSel)];
    n += 1;
  }
  // The join sentence counts the lanes it is about; the probe must not leave it saying "2 lanes" over a four-lane drawing.
  const join = wave.querySelector(".wjoin b");
  if (join) join.textContent = `${count} lanes`;
  const laneSet = wave.querySelector(".wave-lanes");
  if (laneSet) laneSet.setAttribute("data-wave-lanes", String(count));
  // O3 keeps the lane as a column, not a box: its new lanes are a row each, plus a cell in the summary strip.
  if (option === "O3") {
    const manifest = wave.querySelector(".manifest");
    const lsum = wave.querySelector(".lsum");
    const rowTpl = manifest?.querySelector(".mrow.wave-member");
    const sumTpl = lsum?.querySelector(".lsum-cell");
    const baseLanes = 2;
    for (let i = baseLanes; i < count; i += 1) {
      const e = extra[i - baseLanes];
      if (!e || !rowTpl) break;
      const row = rowTpl.cloneNode(true);
      row.setAttribute("data-wave-member", String(e.id));
      const laneCell = row.querySelector(".lane-cell");
      if (laneCell) {
        laneCell.classList.remove("rep");
        laneCell.innerHTML = `<i class="dot is-queued"></i>${e.lane}`;
      }
      const id = row.querySelector(".mid");
      if (id) id.textContent = `#${e.id}`;
      const t = row.querySelector(".wave-member-title");
      if (t) t.textContent = e.title;
      const p = row.querySelector(".proj");
      if (p) p.textContent = e.project;
      const st = row.querySelector(".chip.mstate");
      if (st) {
        st.className = "chip mstate is-queued";
        st.textContent = "queued";
      }
      manifest.appendChild(row);
      if (sumTpl && lsum) {
        const s = sumTpl.cloneNode(true);
        const chip = s.querySelector(".chip.mstate");
        if (chip) {
          chip.className = "chip mstate is-queued";
          chip.textContent = `lane ${e.lane} - queued`;
        }
        lsum.appendChild(s);
      }
    }
  }
  const members = [...wave.querySelectorAll("[data-wave-member]")].map((m) => {
    const t = m.querySelector(".wave-member-title");
    const cs = t ? getComputedStyle(t) : null;
    const r = t ? t.getBoundingClientRect() : null;
    const lh = cs ? parseFloat(cs.lineHeight) : 0;
    return {
      id: m.getAttribute("data-wave-member"),
      titleW: r ? Math.round(r.width) : null,
      lines: lh && r ? Math.round(r.height / lh) : null,
      overflow: t ? Math.round(t.scrollWidth - t.clientWidth) : null,
    };
  });
  const now = [...wave.querySelectorAll(laneSel)].map((l) => ({ w: Math.round(l.getBoundingClientRect().width), top: Math.round(l.getBoundingClientRect().top) }));
  return {
    option,
    lanes: count,
    stageW,
    waveH: Math.round(wave.getBoundingClientRect().height),
    laneW: now.map((l) => l.w),
    laneRows: new Set(now.map((l) => l.top)).size,
    members,
    widestTitle: Math.max(0, ...members.map((m) => m.titleW || 0)),
    maxLines: Math.max(0, ...members.map((m) => m.lines || 0)),
    maxOverflow: Math.max(0, ...members.map((m) => m.overflow || 0)),
  };
}

let panel = null;
try {
  mkdirSync(OUT, { recursive: true });
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the lane scaling probe", "playwright is not installed for this node (see tools/browser.mjs)"));
    process.exitCode = 2;
  } else {
    const results = [];
    await withBrowser(
      async ({ browser }) => {
        await withPage(
          browser,
          async ({ page }) => {
            for (const [option, count] of RUNS) {
              await page.goto(pathToFileURL(REPORT).href, { waitUntil: "load" });
              await page.evaluate((w) => document.documentElement.style.setProperty("--stage-w", `${w}px`), STAGE_W);
              await page.evaluate(() => document.body.classList.add("capture"));
              await page.waitForTimeout(80);
              const r = await page.evaluate(probe, { option, count, extra: EXTRA, stageW: STAGE_W });
              results.push(r);
              console.log(`${option} at ${count} lanes: title ${r.widestTitle}px, wraps ${r.maxLines}, box ${r.waveH}px, lane ${r.laneW[0]}px x${r.laneRows} row(s), overflow ${r.maxOverflow}px`);
              if (SHOTS.has(`${option}:${count}`)) {
                await page.locator(`[data-option="${option}"] .stage`).screenshot({ path: path.join(OUT, `${option.toLowerCase()}-${count}lanes.png`) });
              }
            }
          },
          { viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 },
        );
      },
      { viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 },
    );
    writeFileSync(path.join(OUT, "lane-scaling.json"), `${JSON.stringify({ at: new Date().toISOString(), stageW: STAGE_W, data: "three members in two lanes, plus one member per added lane (one from optym-integration-multi)", runs: results }, null, 1)}\n`, "utf8");
    const o1three = results.find((r) => r.option === "O1" && r.lanes === 3);
    const o1four = results.find((r) => r.option === "O1" && r.lanes === 4);
    if (!(o1three && o1three.widestTitle === 0 && o1three.maxLines > 40)) {
      console.log("FAIL  O1 at three lanes should collapse its title track");
      process.exitCode = 1;
    } else {
      console.log(`PASS  O1 at three lanes collapses: title ${o1three.widestTitle}px, ${o1three.maxLines} wraps, box ${o1three.waveH}px`);
      console.log(`      O1 at four lanes: box ${o1four.waveH}px, ${o1four.laneRows} rows of lanes`);
    }
    const o3 = results.find((r) => r.option === "O3" && r.lanes === 4);
    console.log(`      O3 at four lanes: title ${o3.widestTitle}px, box ${o3.waveH}px`);
    console.log(`wrote ${path.join(OUT, "lane-scaling.json").replace(/\\/g, "/")}`);
  }
} catch (err) {
  console.error(`PROBE FAILED: ${String((err && err.stack) || err)}`);
  process.exitCode = 1;
} finally {
  process.exit(process.exitCode || 0);
}
