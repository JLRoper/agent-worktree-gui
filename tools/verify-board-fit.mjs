// The worktree chart FITS the board when the assistant rail opens — proved by driving a panel of its own, in a real
// browser, with the snapshots the PR carries.
//
//   node tools/verify-board-fit.mjs [--shots <dir>]
//
// WHAT THIS GUARDS. The rail is a flex item beside `main`, so opening it takes 340-640px away from every table at
// once — and that is not a `resize` event. The chart used to keep the column split it had been planned at when the
// rail was closed: a `table-layout: fixed` table is never narrower than the sum of its column widths, so it grew past
// its card and the card clipped the overrun exactly at the rail's left edge, with no scrollbar to reach it. The owner
// cell made it worse on its own: it carried `class="assistant"`, the rail's own class, so it was a 480px sticky flex
// column in the middle of the chart.
//
// THE PROPERTIES, all measured from the DOM at 1954px and 1280px, rail open AND closed:
//
//   * the table is exactly as wide as its wrapper, and its columns add up to that — no rounding overrun;
//   * the table's right edge is inside its card, and the card's inside main, so nothing is clipped at the rail's edge;
//   * `main` is the page's only horizontal scroll container (nothing between it and the table scrolls or clips), and
//     in practice nothing overflows it either;
//   * the owner column draws a compact tag per row ("M1") and hides itself while every row is on Assistant #1 with no
//     second assistant; a second assistant brings it back without anyone touching Settings;
//   * opening and closing the rail re-plans the split (the columns' widths differ between the two states), and the
//     table still fits after the rail is dragged narrower.
//
// Sandbox only: a throwaway repo with hand-cut worktrees, its own HERMES_HOME, its own PANEL_CONFIG with its own port
// and logs, and an apiServer pointed at a dead port so nothing here can reach the live gateway. The live panel and the
// live gateway are never touched. Without a Playwright install the script says BROWSER-NOT-RUN and exits 2 rather
// than passing on a half that never ran.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { ROOT, freePort, git, startPanel } from "./panel-testkit.mjs";

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
const shotsDir = shotDirArg ? path.resolve(shotDirArg) : path.join(ROOT, ".worktrees", ".board-fit-shots");

const gitEnv = { GIT_TERMINAL_PROMPT: "0" };
const commit = (where, message) => {
  git(where, ["add", "-A"]);
  return git(where, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", message], { env: gitEnv });
};

// ---- the sandbox ---------------------------------------------------------------------------------
const dir = path.join(ROOT, ".worktrees", ".board-fit-sandbox");
rmSync(dir, { recursive: true, force: true });
const repos = path.join(dir, "repos");
const repo = path.join(repos, "board-fit-repo");
mkdirSync(path.join(repo, ".worktrees"), { recursive: true });
mkdirSync(shotsDir, { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# board fit\n", "utf8");
commit(repo, "seed the sandbox repo");
for (let i = 1; i <= 6; i += 1) {
  const name = `tree-${String(i).padStart(2, "0")}`;
  const where = path.join(repo, ".worktrees", name);
  git(repo, ["worktree", "add", "-q", "-b", `work/${name}`, where]);
  writeFileSync(path.join(where, `${name}.txt`), "sandbox work\n", "utf8");
  commit(where, `do the ${name} work`);
}

const port = await freePort();
// No `hiddenColumns` key: the panel's read-time default (empty) plus the owner column's own rule decide the chart,
// which is exactly the state this gate is about.
const panel = await startPanel({
  dir,
  port,
  keep: true,
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
      return { left: round(r.left), right: round(r.right), width: round(r.width) };
    };
    const main = document.querySelector("main");
    const rail = document.getElementById("assistant");
    const section = [...document.querySelectorAll("section.project")].find((s) => s.querySelector("tr.row"));
    const wrap = section.querySelector(":scope > .wt-scroll");
    const table = wrap.querySelector("table");
    const ths = [...table.tHead.rows[0].cells];
    const row = table.tBodies[0].querySelector("tr.row");
    const cs = (el) => getComputedStyle(el);
    const idx = ths.findIndex((th) => th.dataset.colId === "assistant");
    const ownerTd = idx >= 0 && row ? row.cells[idx] : null;
    return {
      viewport: { w: innerWidth, clientW: document.documentElement.clientWidth },
      rail: rail.hidden ? { hidden: true } : { hidden: false, ...rect(rail) },
      main: { ...rect(main), clientW: main.clientWidth, scrollW: main.scrollWidth, overflowX: cs(main).overflowX },
      section: { ...rect(section), clientW: section.clientWidth, scrollW: section.scrollWidth },
      wrap: {
        ...rect(wrap),
        clientW: wrap.clientWidth,
        scrollW: wrap.scrollWidth,
        overflowX: cs(wrap).overflowX,
        scrollClass: wrap.classList.contains("is-scroll"),
      },
      table: { ...rect(table), minWidth: table.style.minWidth || "", scrollW: table.scrollWidth },
      cols: ths.map((th) => th.dataset.colId),
      thWidths: ths.map((th) => Math.round(th.getBoundingClientRect().width)),
      thSum: Math.round(ths.reduce((s, th) => s + th.getBoundingClientRect().width, 0)),
      rows: table.tBodies[0].querySelectorAll("tr.row").length,
      cellsPerRow: row ? row.cells.length : 0,
      ownerTag: ownerTd ? ownerTd.textContent.trim() : null,
      ownerCellClass: ownerTd ? ownerTd.className : null,
      // Does the card still show the last cell whole? A clipped table is the bug; this is the reader's own test.
      lastCellRight: row ? Math.round(row.cells[row.cells.length - 1].getBoundingClientRect().right) : null,
    };
  });

const fits = (f) => {
  const out = [];
  if (f.table.width > f.wrap.clientW + 1) out.push(`table ${f.table.width} > wrapper ${f.wrap.clientW}`);
  if (Math.abs(f.thSum - f.table.width) > 1) out.push(`columns ${f.thSum} != table ${f.table.width}`);
  if (f.table.right > f.section.right + 1) out.push(`table ends ${f.table.right} past its card ${f.section.right}`);
  if (f.table.right > f.main.right + 1) out.push(`table ends ${f.table.right} past main ${f.main.right}`);
  if (!f.rail.hidden && f.table.right > f.rail.left + 1) out.push(`table ends ${f.table.right} under the rail ${f.rail.left}`);
  if (f.lastCellRight > f.section.right + 1) out.push(`last cell ${f.lastCellRight} past its card ${f.section.right}`);
  return out;
};

const playwright = loadPlaywright();
if (!playwright) {
  console.log(notRun("the chart fitting the board", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
  process.exit(2);
}

try {
  console.log(`sandbox: ${panel.base}`);
  let shots = 0;
  await withBrowser(
    async ({ page, pageErrors }) => {
      const shot = async (name) => {
        // The chart is what the snapshot is for: put its first rows under the topbar, never below the fold.
        await page.evaluate(() => {
          const section = [...document.querySelectorAll("section.project")].find((s) => s.querySelector("tr.row"));
          if (section) window.scrollTo({ top: Math.max(0, section.getBoundingClientRect().top + window.scrollY - 64) });
        });
        await page.waitForTimeout(120);
        shots += 1;
        const file = path.join(shotsDir, `${String(shots).padStart(2, "0")}-${name}.png`);
        await page.screenshot({ path: file });
        note(`screenshot ${file}`);
      };
      const expand = async () => {
        for (const head of await page.locator("section.project > .project-head[data-toggle-project]").all()) {
          const sec = head.locator("xpath=..");
          if (String((await sec.getAttribute("class")) || "").includes("collapsed")) await head.click();
        }
      };
      // A known width and a known rail state, booted from scratch: the open flag is remembered in localStorage, so a
      // reload is what makes "closed" and "open" the panel's own boot path rather than a leftover.
      const at = async (width, open) => {
        await page.setViewportSize({ width, height: 1080 });
        await page.evaluate((o) => localStorage.setItem("wm.assistantOpen", o ? "1" : "0"), open);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector("section.project", { timeout: 60000 });
        await expand();
        await page.waitForSelector("tr.row", { state: "visible", timeout: 60000 });
        if (open) await page.waitForSelector("#assistant", { state: "visible", timeout: 30000 });
        await page.waitForTimeout(1400);
        return frame(page);
      };

      await openPage(page, panel.base, { selector: "section.project" });

      // ---- one assistant: the owner column is silent, and the chart fits with the rail open ----
      const idleOpen = await at(1954, true);
      const idleBad = fits(idleOpen);
      check(idleBad.length === 0, "1954px, rail open, one assistant: the chart fits the board", idleBad.join(" · ") || `table ${idleOpen.table.width} in wrapper ${idleOpen.wrap.clientW}`);
      check(!idleOpen.cols.includes("assistant"), "1954px, rail open: the owner column hides itself on an idle board", idleOpen.cols.join(","));
      check(idleOpen.cellsPerRow === idleOpen.cols.length, "…and every row carries one cell per drawn column", `${idleOpen.cellsPerRow} cells / ${idleOpen.cols.length} headers`);
      await shot("1954-rail-open-idle");

      // ---- a second assistant: the owner column comes back on its own ----
      const made = await page.evaluate(async () => {
        const r = await fetch("/api/assistant/assistants", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roleId: "agent-manager" }) });
        return { status: r.status, error: (await r.json().catch(() => ({}))).error || "" };
      });
      check(made.status === 201, "a second assistant can be created on the sandbox panel", `${made.status} ${made.error}`);

      // ---- the chart with the owner column drawn, at both widths, rail open AND closed ----
      const states = [];
      for (const width of [1954, 1280]) {
        for (const open of [false, true]) {
          const f = await at(width, open);
          states.push({ width, open, f });
          const bad = fits(f);
          const where = `${width}px, rail ${open ? "open" : "closed"}`;
          check(bad.length === 0, `${where}: the chart fits the board`, bad.join(" · ") || `table ${f.table.width} in wrapper ${f.wrap.clientW}`);
          check(f.cols.includes("assistant"), `${where}: the owner column is drawn with a second assistant`, f.cols.join(","));
          check(f.ownerTag === "M1", `${where}: the owner cell is the compact tag for Manager 1`, String(f.ownerTag));
          check(/^owner\b/.test(String(f.ownerCellClass)), `${where}: the owner cell does not carry the rail's class`, String(f.ownerCellClass));
          check(f.thSum === f.table.width, `${where}: the columns add up to the table exactly`, `${f.thSum} vs ${f.table.width}`);
          check(f.cellsPerRow === f.cols.length, `${where}: every row carries one cell per drawn column`, `${f.cellsPerRow} cells / ${f.cols.length} headers`);
          check(f.main.overflowX === "auto" && f.main.scrollW === f.main.clientW, `${where}: main is the one horizontal scroll container, and nothing overflows it`, `${f.main.overflowX}, scroll ${f.main.scrollW} of ${f.main.clientW}`);
          check(f.wrap.overflowX === "visible" && !f.wrap.scrollClass && f.table.minWidth === "", `${where}: the card does not scroll or carry a floor width itself`, `${f.wrap.overflowX}${f.wrap.scrollClass ? " + is-scroll" : ""}${f.table.minWidth ? ` min-width ${f.table.minWidth}` : ""}`);
          await shot(`${width}-rail-${open ? "open" : "closed"}`);
        }
        const [closed, open] = states.slice(-2).map((s) => s.f);
        check(closed.wrap.clientW > open.wrap.clientW + 300, `${width}px: the rail really took the room away`, `${closed.wrap.clientW} → ${open.wrap.clientW}px of chart`);
        check(JSON.stringify(closed.thWidths) !== JSON.stringify(open.thWidths), `${width}px: opening the rail re-planned the split`, `${closed.thWidths.join(",")} → ${open.thWidths.join(",")}`);
      }

      // ---- and while the reader drags the rail's own edge, the split follows the live card width ----
      await at(1954, true);
      const beforeDrag = await frame(page);
      const box = await page.locator("#as-split").boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + 200);
      await page.mouse.down();
      for (let i = 1; i <= 8; i += 1) {
        await page.mouse.move(box.x + box.width / 2 - (80 * i) / 8, box.y + 200);
        await page.waitForTimeout(30);
      }
      await page.mouse.up();
      await page.waitForTimeout(1500);
      const dragged = await frame(page);
      const dragBad = fits(dragged);
      check(dragBad.length === 0, "after the rail is dragged 80px wider, the chart fits the narrower card", dragBad.join(" · ") || `table ${dragged.table.width} in wrapper ${dragged.wrap.clientW}`);
      check(dragged.wrap.clientW < beforeDrag.wrap.clientW - 60, "…which is the width the drag left", `${beforeDrag.wrap.clientW} → ${dragged.wrap.clientW}px`);
      await shot("1954-rail-dragged");

      for (const e of pageErrors || []) check(false, "no page error along the way", e);
    },
    { viewport: { width: 1954, height: 1080 } },
  );
} finally {
  await panel.stop();
}

console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
console.log(failures ? "BOARD-FIT-FAILED" : "BOARD-FIT-OK");
process.exit(failures ? 1 : 0);
