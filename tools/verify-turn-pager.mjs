// The turn pager's count holds one line in the docked rail, and the pager keeps its own width there.
//
//   node tools/verify-turn-pager.mjs                       # this checkout
//   node tools/verify-turn-pager.mjs --root <export dir>    # serve a `git archive` of another build
//   node tools/verify-turn-pager.mjs --shots <dir>          # where the screenshots go (default: a temp dir)
//   node tools/verify-turn-pager.mjs --json <file>          # keep the raw ledger
//
// THE REPORT. In the docked rail the pager's count drew as a column: "3–7 / 7" broke to four lines and the card's head
// read like a stacked list. Measured on the pre-change stylesheet the count's box was 11.5 x 60.9 px, identical at a
// 1600 and a 1280 window — the rail is 480px whatever the window is, so the head had the same width to give it.
//
// THE MECHANISM. `.job-head` is `flex-wrap: nowrap` (:859) and every direct button and pill in it is `flex: none`
// (:870). `.turn-pager` (:2113) was a flex item with no `flex: none`, so it was free to SHRINK, and with
// `white-space: normal` on its count (:2117) its min-content width is the widest word: the count was squeezed to
// 11.5px and each word took its own line. The fix is `flex: none` on the pager and `white-space: nowrap` on the
// count. The arrows keep their size, their place and their order.
//
// WHAT IS DRIVEN (nothing synthetic reaches the page): a throwaway panel of its own (tools/panel-testkit.mjs — spare
// port, own PANEL_CONFIG / HERMES_HOME / jobs.json, API_SERVER_KEY empty), a dead apiServer and the board assistant
// OFF, so no gateway is called at all; a job store seeded with SEVEN settled turns in ONE thread — two pages of five,
// which is the only condition under which the pager is drawn; the rail opened the way the panel remembers it
// (`wm.assistantOpen`), which paints that thread's card into `#assistant` through `conversationHtml` — the same
// renderer the board uses, not a lookalike.
//
// WHAT IT ASSERTS, off the painted rail at 1600 and at 1280 (480px rail in both):
//   (1) the count is one line high — its box is within one and a half line-heights;
//   (2) the pager is NOT at its min-content width: its used width is the width its own children need on one line,
//       measured from a max-content clone of the same node beside it, not the 58.8px it was squeezed to;
//   (3) the arrows are unmoved — older, newer, then the count, all on the pager's own row, older to the left;
//   (4) a screenshot of the rail per width, and no page error.
//
// THE FAILING-FIRST PROOF is the `--root` flag, on the rule the other gates use — the same harness, the base's own
// server.js, lib/ and public/:
//   mkdir -p "$SCRATCH/main" && git archive origin/main | tar -x -C "$SCRATCH/main"
//   git -C "$SCRATCH/main" init -q -b main && git -C "$SCRATCH/main" add -A && git -C "$SCRATCH/main" commit -qm export
//   node tools/verify-turn-pager.mjs --root "$SCRATCH/main"
// main's stylesheet carries neither declaration, so (1) and (2) fail there and this checkout passes. The export needs
// its own one-commit repository because server.js reads `git rev-parse` at boot and dies on a bare export.
//
// Exit codes: 0 held; 1 a check failed; 2 the run did not measure what it claims (no Playwright, no rail, no pager).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright, notRun, withBrowser } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SHOTS = path.resolve(opt("--shots", path.join(tmpdir(), "wtgui-turn-pager-shots")));
const JSON_OUT = opt("--json");
const WIDTHS = [1600, 1280];
// The rail is the reader's default dock; both windows have to give the head the same 480px, which is the point.
const RAIL_PX = 480;
const THREAD = "panel-assistant";
const TURNS = 7;

let checks = 0;
let failures = 0;
const out = { tree: TREE, widths: {}, notMeasured: [], errors: [] };
function check(ok, label, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
const note = (text) => console.log(`      ${text}`);

// ---- the fixture: seven settled turns of the rail's own conversation -------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-turn-pager-"));
mkdirSync(path.join(dir, "logs"), { recursive: true });
const now = Date.now();
const seedPath = "C:/ProjectDevelopment/agent-worktree-gui/.worktrees/turn-pager-fixture-0001";
const jobs = [];
for (let i = 0; i < TURNS; i++) {
  const at = now - (TURNS - i) * 600_000;
  jobs.push({
    id: `tkpager${i + 1}`,
    thread: THREAD,
    turn: i + 1,
    prompt: `fixture turn ${i + 1}`,
    status: "done",
    exitCode: 0,
    startedAt: new Date(at).toISOString(),
    endedAt: new Date(at + 30_000).toISOString(),
    durationMs: 30_000,
    finalMessage: "done",
    cwd: seedPath,
    ownerPath: seedPath,
    worktreePath: seedPath,
    worktree: "turn-pager-fixture-0001",
    lines: [{ kind: "out", text: `turn ${i + 1} output`, lid: i + 1, at: at + 1000 }],
  });
}
writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify({ savedAt: new Date(now).toISOString(), jobs }, null, 1));

// The kit beside the checkout being SERVED, not beside this file: `--root` has to boot the base's own server.js,
// lib/ and public/ or the comparison would prove nothing.
const { freePort, startPanel } = await import(pathToFileURL(path.join(TREE, "tools", "panel-testkit.mjs")).href);
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

// ---- the measurement -------------------------------------------------------------------------------------------
// Both natural widths come from clones of the SAME node, laid out beside it: max-content ignores wrapping (the width
// the contents need on one line), min-content is the narrowest the node can go under its own white-space. On the
// pre-change sheet that min-content is 58.8px and it is exactly what the flex line made the pager.
function measure() {
  const rail = document.getElementById("assistant");
  const pager = rail?.querySelector(".job[data-thread=\"panel-assistant\"] .turn-pager") || null;
  const count = pager?.querySelector(".pager-n") || null;
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const round = (n) => Math.round(n * 100) / 100;
    return { w: round(r.width), h: round(r.height), l: round(r.left), r: round(r.right), t: round(r.top), b: round(r.bottom) };
  };
  const natural = (mode) => {
    if (!pager) return null;
    const clone = pager.cloneNode(true);
    Object.assign(clone.style, {
      position: "absolute",
      left: "-9999px",
      top: "0",
      visibility: "hidden",
      width: mode,
      minWidth: "0",
      maxWidth: "none",
      margin: "0",
    });
    pager.parentElement.appendChild(clone);
    const w = clone.getBoundingClientRect().width;
    clone.remove();
    return Math.round(w * 100) / 100;
  };
  const lineHeight = count ? parseFloat(getComputedStyle(count).lineHeight) : null;
  return {
    rail: rail ? { hidden: rail.hidden, w: Math.round(rail.getBoundingClientRect().width) } : null,
    pager: box(pager),
    count: box(count),
    countText: count ? count.textContent : null,
    countWhiteSpace: count ? getComputedStyle(count).whiteSpace : null,
    lineHeight,
    maxContent: natural("max-content"),
    minContent: natural("min-content"),
    arrows: pager
      ? [...pager.querySelectorAll("button.pager-btn")].map((b) => ({ dir: b.dataset.turnPage || "", ...box(b) }))
      : [],
  };
}

const playwright = loadPlaywright({ root: TREE });
if (!playwright) {
  console.log(notRun("the turn pager's count in the docked rail", "Playwright is not installed here (set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright)"));
  process.exit(2);
}

try {
  console.log(`turn pager gate on ${TREE}`);
  console.log(`  sandbox: ${panel.base} · ${TURNS} seeded turns in ${THREAD} · no gateway · shots ${SHOTS}`);
  mkdirSync(SHOTS, { recursive: true });
  await withBrowser(
    async ({ page, pageErrors }) => {
      // The rail is the panel's remembered state, not a press: after a reload it is already open and a press would
      // close it (assistant.js `toggleAssistant`).
      await page.addInitScript(() => {
        try {
          localStorage.setItem("wm.assistantOpen", "1");
        } catch {
          /* a browser with storage off still draws the rail on its own default */
        }
      });
      await page.goto(panel.base, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(`#assistant .job[data-thread="${THREAD}"] .turn-pager`, { timeout: 45_000 });
      await page.waitForTimeout(900);

      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 1000 });
        await page.waitForTimeout(600);
        const m = await page.evaluate(measure);
        out.widths[width] = m;

        const tag = `${width}px window`;
        if (!m.pager || !m.count || !m.rail) {
          out.notMeasured.push(`${tag}: the rail, the card or its pager was not on the page`);
          continue;
        }
        // (0) the thing under test is the docked rail, not a floating frame: same 480px in both windows.
        check(
          m.rail.hidden === false && Math.abs(m.rail.w - RAIL_PX) <= 1,
          `${tag}: the card is measured in the docked rail`,
          `#assistant ${m.rail.hidden ? "hidden" : "visible"}, ${m.rail.w}px wide (want ${RAIL_PX})`,
        );
        // (1) the count is one line high.
        const lines = m.lineHeight ? Math.round((m.count.h / m.lineHeight) * 10) / 10 : null;
        check(
          Boolean(m.lineHeight) && m.count.h <= m.lineHeight * 1.5,
          `${tag}: the count is one line high`,
          `${m.count.h}px tall at a ${m.lineHeight}px line-height (${lines} line(s)); text ${JSON.stringify(m.countText)}`,
        );
        // (2) the pager is not at its min-content width.
        check(
          m.pager.w >= m.maxContent - 0.5,
          `${tag}: the pager is not shrunk to its min-content — it is as wide as its one-line contents`,
          `pager ${m.pager.w}px · contents need ${m.maxContent}px · min-content ${m.minContent}px`,
        );
        // (3) the arrows are unmoved: older, newer, count, on the pager's own row, older to the left.
        const order = m.arrows.map((a) => a.dir).join(",");
        const onRow = m.arrows.every((a) => a.t >= m.pager.t - 1 && a.b <= m.pager.b + 1);
        const olderFirst = m.arrows.length === 2 && m.arrows[0].l < m.arrows[1].l;
        check(
          order === "older,newer" && onRow && olderFirst && m.count.l >= m.arrows[1].r - 1,
          `${tag}: the arrows are unmoved — older, newer, then the count, on one row`,
          `${order || "none"}; tops ${m.arrows.map((a) => a.t).join("/")} against pager ${m.pager.t}-${m.pager.b}; count at ${m.count.l}px`,
        );
        // The fixture itself: the pager is only drawn with more than one page, and this is page 2 of 2.
        check(
          m.countText === "3–7 / 7",
          `${tag}: the pager is drawn on the second page of a seven-turn thread`,
          JSON.stringify(m.countText),
        );

        // (4) the picture the report is about: the docked rail, count and all.
        const railBox = await page.locator("#assistant").boundingBox().catch(() => null);
        const shot = path.join(SHOTS, `turn-pager-${width}.png`);
        await page.screenshot(
          railBox
            ? { path: shot, clip: { x: railBox.x, y: railBox.y, width: railBox.width, height: Math.min(railBox.height, 900) } }
            : { path: shot },
        );
        note(`screenshot ${shot}`);
      }
      out.errors = (pageErrors || []).slice(0, 3);
      check(out.errors.length === 0, "no page error along the way", out.errors[0] || "clean");
    },
    { viewport: { width: WIDTHS[0], height: 1000 } },
  );
} finally {
  await panel.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 1), "utf8");
for (const f of out.notMeasured) console.log(`  ? ${f}`);
if (out.notMeasured.length) {
  console.log(`RESULT: NOT MEASURED (${out.notMeasured.length} reason(s))`);
  process.exit(2);
}
console.log(failures ? `RESULT: ${failures}/${checks} FAILED` : `RESULT: ALL PASS (${checks} checks)`);
process.exit(failures ? 1 : 0);
