#!/usr/bin/env node
// The worktree chart's TWO edges: the thin rule down each side of the table, and the room the action column's last
// control keeps from the right-hand one.
//
// HARNESS: LIVE GATE
//
//   node tools/verify-chart-edges.mjs [--shots <dir>]
//
// WHAT THIS GUARDS. The chart drew its left boundary as a 1px rule on the wrapper
// (`#projects section.project > .wt-scroll`, public/chart.css) and nothing at all on the right: the table stopped,
// 24px short of the card's own edge, and the right side read as unfinished beside the left rail. The fix is one
// border plus the padding the last control needs to clear it, so these are the properties that make "matching" and
// "comfortable" numbers rather than adjectives:
//
//   * both boundaries are the same 1px rule in the same colour, drawn on the wrapper;
//   * each rule is FLUSH with the table: the table's left edge is the left rule's inner edge and the table's right
//     edge is the right rule's inner edge, to within half a pixel;
//   * the header row and the row separators reach both rules: the first and last header cell, and the first and last
//     cell of a row, start and end on the table's own edges;
//   * the last control in the action column (the ✕, or the + on a row that carries all three) keeps at least
//     ACTION_ROOM px of clear space from the right rule, at 1440x900 and at 1280x800. At 1024x800 the board is
//     narrower than the sum of its columns' floors, so every column is scaled down and only "the control does not
//     cross the rule" is promised - which is still measured;
//   * the table still fits its wrapper and its columns still add up to it. A border that shrinks the content box is
//     exactly the kind of change that leaves a `table-layout: fixed` table one pixel proud of its card.
//
// The captures are of the same page the numbers come from: 1440x900 and a narrow window at 1x, then the two edges and
// the action column clipped at 3x, because a 1px rule is not visible in a 1440px-wide picture.
//
// Sandbox only: a throwaway repo with hand-cut worktrees, its own HERMES_HOME, its own PANEL_CONFIG with its own port
// and logs, and an apiServer pointed at a dead port so nothing here can reach the live gateway. The live panel and the
// live gateway are never touched. Without a Playwright install the script says BROWSER-NOT-RUN and exits 2 rather
// than passing on a half that never ran.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { ROOT, freePort, git, startPanel } from "./panel-testkit.mjs";

// The clear space the last control owes the right rule. Ten is the gutter every other cell already keeps on its right
// (`tbody td` padding in public/chart.css), so the newest edge is not the one column that crowds its own control.
const ACTION_ROOM = 8;

let failures = 0;
let checks = 0;
function check(ok, label, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
}
const note = (text) => console.log(`      ${text}`);
const args = process.argv.slice(2);
const shotDirArg = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : null;
const shotsDir = shotDirArg ? path.resolve(shotDirArg) : path.join(ROOT, ".worktrees", ".chart-edge-shots");

const gitEnv = { GIT_TERMINAL_PROMPT: "0" };
const commit = (where, message) => {
  git(where, ["add", "-A"]);
  return git(where, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", message], { env: gitEnv });
};

// ---- the sandbox ---------------------------------------------------------------------------------
const dir = path.join(ROOT, ".worktrees", ".chart-edge-sandbox");
rmSync(dir, { recursive: true, force: true });
const repos = path.join(dir, "repos");
const repo = path.join(repos, "chart-edge-repo");
mkdirSync(path.join(repo, ".worktrees"), { recursive: true });
mkdirSync(shotsDir, { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# chart edges\n", "utf8");
commit(repo, "seed the sandbox repo");
// Rows with a REAL branch, because the + (cut a child worktree) only draws when the row has one: the widest the
// action column ever gets is those three controls side by side.
for (let i = 1; i <= 4; i += 1) {
  const name = `edge-${String(i).padStart(2, "0")}`;
  const where = path.join(repo, ".worktrees", name);
  git(repo, ["worktree", "add", "-q", "-b", `work/${name}`, where]);
  writeFileSync(path.join(where, `${name}.txt`), "sandbox work\n", "utf8");
  commit(where, `do the ${name} work`);
}

const port = await freePort();
const panel = await startPanel({
  dir,
  port,
  config: {
    refreshSeconds: 4,
    worktreeSeconds: 2,
    midSeconds: 8,
    dormantSeconds: 15,
    slowSeconds: 20,
    fetchSeconds: 3600,
    scanMode: "all",
    defaultCwd: repo,
    apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
    assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
  },
});

// Every number below is read from the page as it paints, never inferred from the CSS.
const frame = (page) =>
  page.evaluate(() => {
    const round = (n) => Math.round(n * 10) / 10;
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { left: round(r.left), right: round(r.right), top: round(r.top), bottom: round(r.bottom), width: round(r.width), height: round(r.height) };
    };
    const section = [...document.querySelectorAll("section.project")].find((s) => s.querySelector("tr.row"));
    const wrap = section.querySelector(":scope > .wt-scroll");
    const table = wrap.querySelector("table");
    const cs = getComputedStyle(wrap);
    const ths = [...table.tHead.rows[0].cells];
    const rows = [...table.tBodies[0].querySelectorAll("tr.row")];
    const row = rows[0];
    const tds = [...row.cells];
    const actIdx = ths.findIndex((th) => th.dataset.colId === "actions");
    // The WIDEST action cell on the board: the row whose cell holds the most controls (the +, the ⟳ and the ✕).
    let widest = null;
    for (const tr of rows) {
      const cell = actIdx >= 0 ? tr.cells[actIdx] : null;
      if (!cell) continue;
      const controls = [...cell.querySelectorAll("button")].map((b) => ({ cls: b.className, ...rect(b) }));
      if (!widest || controls.length > widest.controls.length) widest = { key: tr.dataset.key || "", cell: rect(cell), controls };
    }
    return {
      viewport: { w: innerWidth, h: innerHeight },
      section: rect(section),
      wrap: {
        ...rect(wrap),
        clientW: wrap.clientWidth,
        scrollW: wrap.scrollWidth,
        borderLeftWidth: cs.borderLeftWidth,
        borderLeftColor: cs.borderLeftColor,
        borderLeftStyle: cs.borderLeftStyle,
        borderRightWidth: cs.borderRightWidth,
        borderRightColor: cs.borderRightColor,
        borderRightStyle: cs.borderRightStyle,
      },
      table: { ...rect(table), thSum: Math.round(ths.reduce((s, th) => s + th.getBoundingClientRect().width, 0)) },
      head: { first: rect(ths[0]), last: rect(ths[ths.length - 1]), cols: ths.map((th) => th.dataset.colId) },
      cells: { count: tds.length, first: rect(tds[0]), last: rect(tds[tds.length - 1]) },
      row: rect(row),
      actions: widest,
    };
  });

const near = (a, b, slack = 0.5) => Math.abs(a - b) <= slack;

// The edges, as one list of complaints so a failing width prints every property it broke. `room` is the clear space
// the last control owes the right rule at THIS width: a board narrower than the sum of its columns' floors scales every
// column down (columnPlan), so below that width only "nothing crosses the rule" can be promised.
const edges = (f, room = ACTION_ROOM) => {
  const out = [];
  if (f.wrap.borderLeftWidth !== "1px") out.push(`left rule ${f.wrap.borderLeftWidth}`);
  if (f.wrap.borderRightWidth !== "1px") out.push(`right rule ${f.wrap.borderRightWidth}`);
  if (f.wrap.borderRightColor !== f.wrap.borderLeftColor) out.push(`colours differ (${f.wrap.borderLeftColor} left, ${f.wrap.borderRightColor} right)`);
  if (f.wrap.borderRightStyle !== f.wrap.borderLeftStyle) out.push(`styles differ (${f.wrap.borderLeftStyle} left, ${f.wrap.borderRightStyle} right)`);
  const leftInset = f.table.left - f.wrap.left;
  const rightInset = f.wrap.right - f.table.right;
  const bwL = parseFloat(f.wrap.borderLeftWidth);
  const bwR = parseFloat(f.wrap.borderRightWidth);
  // FLUSH, within the one pixel a fixed-layout table can wobble by: the plan hands out integer column widths and the
  // table renders at the content box's fractional width, so its right edge lands up to a pixel either side of the
  // rule. What is never allowed is a rule with a gap in the margin (inset < 0) or a table that stops short of it
  // (inset > border + 1) - either way the line would no longer be the chart's boundary.
  if (!(leftInset >= 0 && leftInset <= bwL + 1)) out.push(`left rule ${leftInset}px from the table`);
  if (!(rightInset >= 0 && rightInset <= bwR + 1)) out.push(`right rule ${rightInset}px from the table`);
  if (Math.abs(leftInset - rightInset) > 1) out.push(`the pair is not symmetric: ${leftInset} left, ${rightInset} right`);
  if (!near(f.head.first.left, f.table.left)) out.push(`first header cell starts ${f.head.first.left}, table ${f.table.left}`);
  if (!near(f.head.last.right, f.table.right)) out.push(`last header cell ends ${f.head.last.right}, table ${f.table.right}`);
  if (!near(f.cells.first.left, f.table.left)) out.push(`first row cell starts ${f.cells.first.left}, table ${f.table.left}`);
  if (!near(f.cells.last.right, f.table.right)) out.push(`last row cell ends ${f.cells.last.right}, table ${f.table.right}`);
  if (!f.actions || !f.actions.controls.length) out.push("no action control on the board");
  else {
    const last = f.actions.controls[f.actions.controls.length - 1];
    const gap = Math.round((f.table.right - last.right) * 10) / 10;
    if (gap < room) out.push(`last control ${last.cls} keeps ${gap}px, wants ${room}`);
    for (const c of f.actions.controls) if (c.right > f.table.right + 0.5) out.push(`${c.cls} crosses the right rule at ${c.right}`);
  }
  if (f.table.width > f.wrap.clientW + 1) out.push(`table ${f.table.width} > wrapper ${f.wrap.clientW}`);
  if (f.table.thSum !== Math.round(f.table.width)) out.push(`columns ${f.table.thSum} != table ${Math.round(f.table.width)}`);
  if (f.table.right > f.section.right + 1) out.push(`table ends ${f.table.right} past its card ${f.section.right}`);
  return out;
};

const playwright = loadPlaywright();
if (!playwright) {
  console.log(notRun("the chart's two edges", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
  process.exit(2);
}

const shotName = (n, name) => path.join(shotsDir, `${String(n).padStart(2, "0")}-${name}.png`);

try {
  console.log(`sandbox: ${panel.base}`);
  console.log(`panel pid: ${panel.pid}`);
  await withBrowser(
    async ({ browser, page, pageErrors, withPage }) => {
      let shots = 0;
      const expand = async (p) => {
        for (const head of await p.locator("section.project > .project-head[data-toggle-project]").all()) {
          const sec = head.locator("xpath=..");
          if (String((await sec.getAttribute("class")) || "").includes("collapsed")) await head.click();
        }
      };
      // A known width with the rail CLOSED: the chart's own edges, not the rail's. The open flag is remembered in
      // localStorage, so a reload is what makes it the panel's own boot path rather than a leftover.
      const at = async (p, width, height) => {
        await p.setViewportSize({ width, height });
        await p.evaluate(() => localStorage.setItem("wm.assistantOpen", "0"));
        await p.reload({ waitUntil: "domcontentloaded" });
        await p.waitForSelector("section.project", { timeout: 60000 });
        await expand(p);
        await p.waitForSelector("tr.row", { state: "visible", timeout: 60000 });
        await p.waitForTimeout(1400);
        return frame(p);
      };
      const toTop = async (p) => {
        await p.evaluate(() => {
          const section = [...document.querySelectorAll("section.project")].find((s) => s.querySelector("tr.row"));
          if (section) window.scrollTo({ top: Math.max(0, section.getBoundingClientRect().top + window.scrollY - 64) });
        });
        await p.waitForTimeout(120);
      };

      await openPage(page, panel.base, { selector: "section.project" });

      // ---- the numbers, at the brief's two widths (and one below them, where only the crossing is gated) -----
      const seen = [];
      for (const [width, height, room] of [
        [1440, 900, ACTION_ROOM],
        [1280, 800, ACTION_ROOM],
        [1024, 800, 0],
      ]) {
        const f = await at(page, width, height);
        seen.push({ width, f, room });
        const where = `${width}x${height}`;
        const bad = edges(f, room);
        check(bad.length === 0, `${where}: both edges are the one matching rule, flush with the table`, bad.join(" · ") || `${f.wrap.borderLeftWidth}/${f.wrap.borderRightWidth} ${f.wrap.borderRightColor}`);
        check(f.wrap.borderLeftColor === f.wrap.borderRightColor, `${where}: the two rules are the same colour`, `${f.wrap.borderLeftColor} / ${f.wrap.borderRightColor}`);
        const last = f.actions.controls[f.actions.controls.length - 1];
        check(
          f.table.right - last.right >= room,
          `${where}: the last control clears the right rule${room ? "" : " (below the board's floor sum: no crossing)"}`,
          `${f.actions.controls.length} controls, ${Math.round((f.table.right - last.right) * 10) / 10}px of room`,
        );
        note(
          `${where}: action cell ${f.actions.cell.width}px, table ${Math.round(f.table.width)}px, ` +
            `controls ${f.actions.controls.map((c) => `${c.cls.replace(/ .*/, "")}=${Math.round(c.width * 10) / 10}`).join(" ")}`,
        );
        note(
          `${where}: wrap ${f.wrap.left}..${f.wrap.right} (client ${f.wrap.clientW}), table ${f.table.left}..${f.table.right}, ` +
            `insets L${Math.round((f.table.left - f.wrap.left) * 100) / 100} R${Math.round((f.wrap.right - f.table.right) * 100) / 100}`,
        );
        await toTop(page);
        shots += 1;
        const file = shotName(shots, `${where}-chart`);
        await page.screenshot({ path: file });
        note(`screenshot ${file}`);

        // ---- the same two edges and the action column, clipped at 3x -----------------------------------------
        // A 1px rule is invisible in a 1440px-wide picture, so the clip is rastered at three times its CSS size by
        // CDP's own `Page.captureScreenshot`, whose clip carries a `scale`. Emulation.setDeviceMetricsOverride does
        // NOT survive Playwright's own page.screenshot (it hands back the CSS-pixel size), which is why this half
        // writes the PNG from the CDP bytes. The clips hang off the WIDEST action row, not the first row: a project's
        // own checkout row draws no action cell at all.
        const top = Math.min(f.head.first.top, f.actions.cell.top) - 12;
        const height_ = Math.min(220, f.actions.cell.bottom - top + 14);
        const boxes = {
          "left-edge": { x: f.wrap.left - 12, y: top, width: 96, height: height_ },
          "right-edge": { x: f.table.right - 96, y: top, width: 112, height: height_ },
          "action-column": { x: f.actions.cell.left - 10, y: top, width: f.table.right - f.actions.cell.left + 16, height: height_ },
        };
        const cdp = await page.context().newCDPSession(page);
        try {
          for (const [name, box] of Object.entries(boxes)) {
            const clip = {
              x: Math.max(0, Math.floor(box.x)),
              y: Math.max(0, Math.floor(box.y)),
              width: Math.max(20, Math.ceil(box.width)),
              height: Math.max(20, Math.ceil(box.height)),
              scale: 3,
            };
            const shot = await cdp.send("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: false });
            shots += 1;
            const file = shotName(shots, `${width}-${name}-3x`);
            writeFileSync(file, Buffer.from(shot.data, "base64"));
            note(`zoom ${name} @3x  ${file}  (${clip.width * 3}x${clip.height * 3})`);
          }
        } finally {
          await cdp.detach().catch(() => {});
        }
      }

      // ---- the plan still holds: the border did not push the table past its wrapper -------------------------
      const [wide] = seen;
      note(`columns at 1440: ${wide.f.head.cols.join(",")}`);
      check(wide.f.head.cols.includes("actions"), "the action column is the last column on the board", wide.f.head.cols[wide.f.head.cols.length - 1]);
      check(wide.f.wrap.scrollW === wide.f.wrap.clientW, "the wrapper is not a scroller: nothing overflows it", `${wide.f.wrap.scrollW} of ${wide.f.wrap.clientW}`);

      for (const e of pageErrors || []) check(false, "no page error along the way", e);
    },
    { viewport: { width: 1440, height: 900 } },
  );
} finally {
  await panel.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` - ${failures} FAILED` : ""}`);
console.log(failures ? "CHART-EDGES-FAILED" : "CHART-EDGES-OK");
process.exit(failures ? 1 : 0);
