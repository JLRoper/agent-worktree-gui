#!/usr/bin/env node
// The Settings glossary: the two worktree kinds and the four project chips, explained on the tab that owns each one.
//
//   node tools/verify-settings-glossary.mjs
//
// WHAT THIS GATE IS FOR. The board's rows carry two letters and four chips, and a reader who has to guess what "R"
// means will either trust a research tree with a push or refuse a turnover child one. So the explanations are drawn
// where the controls they describe live: the two kinds and the turnover/rules/cleanup chips on Settings > Repo, the
// board chip on Settings > Board, and a short index on Settings > General that points at both. This gate drives a
// sandbox panel of this checkout in a real Chromium and checks four things, at 1440 wide (the window dragged to
// 640 px) and at 768 (the stylesheet's own 340 px window, the narrowest a reader reads it):
//
//   1. each block is on the tab that owns it and NOT on the others, and the General index names both tabs;
//   2. the words that carry the rule are present: what T and R mean, that R is local only and refused until lifted,
//      the lift's route, that a lifted tree keeps its R with a tick, and what a lift does NOT change;
//   3. no block overflows its own box horizontally at either width, and its prose is at least 12 px - a block that
//      clips a route is a block a reader cannot follow;
//   4. the strip still switches: every one of the fourteen tabs selects, exactly one panel is drawn, and the
//      glossary's own tab comes back after a walk of the whole strip.
//
// RED PROOF. Run it against a `git archive` export of the parent commit and it fails on the first block, so a green
// run here means the explanations are what answered. It prints BROWSER-HALF-NOT-RUN and exits 2 when Playwright is
// absent rather than passing a half that never ran.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPlaywright, notRun } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";
import { buildKindFixture } from "./kind-fixture.mjs";

let failures = 0;
let checks = 0;
const check = (cond, label, detail = "") => {
  checks += 1;
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const note = (text) => console.log(`      ${text}`);
// A tree other than this checkout, for the RED PROOF: point it at a `git archive` export of the parent commit and the
// first block is absent, so a green run here is the explanations answering rather than an empty page.
const argv = process.argv.slice(2);
const rootAt = argv.indexOf("--root");
const ROOT = rootAt >= 0 && argv[rootAt + 1] ? path.resolve(argv[rootAt + 1]) : null;

const pw = loadPlaywright();
if (!pw) {
  console.log(notRun("the Settings glossary was not checked.", "no Playwright install found"));
  console.log("  re-run with PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-settings-glossary.mjs");
  process.exit(2);
}

const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-glossary-gate-"));
const fx = buildKindFixture(dir);
const panel = await startPanel({
  root: ROOT || undefined,
  dir,
  config: {
    branchParentsFile: fx.bookFile,
    sameRepoScan: true,
    scanMode: "all",
    defaultCwd: fx.repo,
    worktreeSeconds: 60,
    midSeconds: 60,
    dormantSeconds: 60,
    slowSeconds: 60,
    fetchSeconds: 3600,
    threads: 1,
    apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
    assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
  },
});

const RECT_KEY = "wtgui.settingsRect";
const TAB_KEY = "wtgui.settingsTab";
const KEYS = ["general", "prompt", "display", "cards", "board", "human", "repo", "data", "gateway", "skills", "updates", "permissions", "pipeline", "bundles"];
const WIDTHS = [
  { w: 1440, h: 900, label: "1440 (window 640)", rect: { x: 12, y: 12, w: 640, h: 876 } },
  { w: 768, h: 900, label: "768 (window 340)", rect: null },
];
// Where each block belongs, and what it must say. The "not on" keys are the tabs that must NOT carry it: one block,
// one owner, or the reader finds two half-answers that can drift.
const BLOCKS = [
  { id: "settings-glossary-index", tab: "general", notOn: ["repo", "board"], say: [/Settings > Repo/, /Settings > Board/, /turnover child/, /research tree/, /lift/i] },
  { id: "settings-glossary-kinds", tab: "repo", notOn: ["general", "board"], say: [/turnover child/, /research tree/, /LOCAL ONLY/, /local only/, /POST \/api\/worktree\/kind-lift/, /keeps its R with a tick/, /does not beat a repository's never/] },
  { id: "settings-glossary-chips", tab: "repo", notOn: ["general", "board"], say: [/turnover:/, /rules:/, /cleanup:/, /removes nothing/, /merges the branches that still hold work/, /locked tree/] },
  { id: "settings-glossary-board-chip", tab: "board", notOn: ["general", "repo"], say: [/\.agentboard/, /PID/, /stale count/] },
];

let browser = null;
try {
  browser = await pw.chromium.launch({ headless: true }).catch(async (err) => {
    if (!/Executable doesn't exist|headless[_-]shell/i.test(String((err && err.message) || err))) throw err;
    return pw.chromium.launch({ headless: true, channel: "chromium" });
  });
  for (const { w, h, label, rect } of WIDTHS) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.addInitScript(
      ({ rectKey, tabKey, rect }) => {
        try {
          if (rect) localStorage.setItem(rectKey, JSON.stringify(rect));
          else localStorage.removeItem(rectKey);
          localStorage.setItem(tabKey, "general");
        } catch {
          /* a browser that refuses storage still paints */
        }
      },
      { rectKey: RECT_KEY, tabKey: TAB_KEY, rect },
    );
    await page.goto(panel.base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("section.project[data-project]", { timeout: 60_000 }).catch(() => null);
    await page.waitForSelector("#btn-settings", { timeout: 30_000 });
    await page.click("#btn-settings");
    await page.waitForSelector("#settings:not(.hidden)", { timeout: 10_000 });

    note(`at ${w}`);
    // 1 + 2: each block on its own tab, with the words that carry the rule.
    for (const { id, tab, notOn, say } of BLOCKS) {
      await page.click(`[data-settings-tab="${tab}"]`);
      await page.waitForSelector(`[data-settings-group="${tab}"]:not([hidden])`, { timeout: 10_000 });
      if (await page.locator(`#${id}`).count()) await page.locator(`#${id}`).scrollIntoViewIfNeeded();
      const text = await page.evaluate((blockId) => {
        const el = document.getElementById(blockId);
        return el ? (el.textContent || "").replace(/\s+/g, " ").trim() : null;
      }, id);
      check(Boolean(text), `${id} is on the ${tab} tab`, text ? `${text.length} chars` : "absent");
      if (!text) continue;
      for (const wanted of say) check(wanted.test(text), `  it says ${wanted}`, "");
      for (const other of notOn) {
        const elsewhere = await page.evaluate(
          ({ blockId, group }) => Boolean(document.querySelector(`[data-settings-group="${group}"] #${blockId}`)),
          { blockId: id, group: other },
        );
        check(!elsewhere, `  and not on the ${other} tab`, "");
      }
    }

    // 3: no horizontal overflow, and prose a reader can read at this width.
    for (const { id, tab } of BLOCKS) {
      await page.click(`[data-settings-tab="${tab}"]`);
      await page.waitForSelector(`[data-settings-group="${tab}"]:not([hidden])`, { timeout: 10_000 });
      const box = await page.evaluate((blockId) => {
        const el = document.getElementById(blockId);
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const cs = getComputedStyle(el);
        return { client: el.clientWidth, scroll: el.scrollWidth, font: parseFloat(cs.fontSize), width: Math.round(el.getBoundingClientRect().width) };
      }, id);
      if (!box) continue;
      check(box.scroll <= box.client + 1, `${id} does not overflow at ${label}`, `scroll ${box.scroll} / client ${box.client}, width ${box.width}`);
      check(box.font >= 12, `${id} reads at 12 px or more at ${label}`, `${box.font} px`);
    }

    // 4: the strip still switches, and comes back to the glossary's own tab.
    const count = await page.locator('[data-settings-tab]').count();
    check(count === 14, `the strip still has fourteen tabs at ${label}`, `${count} found`);
    let switched = true;
    for (const key of KEYS) {
      await page.click(`[data-settings-tab="${key}"]`);
      const state = await page.evaluate((k) => {
        const selected = document.querySelector(`[data-settings-tab="${k}"]`)?.getAttribute("aria-selected") === "true";
        const drawn = [...document.querySelectorAll("[data-settings-group]")].filter((p) => !p.hidden).map((p) => p.dataset.settingsGroup);
        return { selected, drawn };
      }, key);
      if (!state.selected || state.drawn.length !== 1 || state.drawn[0] !== key) {
        switched = false;
        note(`${key}: selected=${state.selected} drawn=${JSON.stringify(state.drawn)}`);
      }
    }
    check(switched, `every tab selects and draws exactly its own panel at ${label}`, "");
    await page.click('[data-settings-tab="repo"]');
    const back = await page.evaluate(() => ({
      selected: document.querySelector('[data-settings-tab="repo"]')?.getAttribute("aria-selected") === "true",
      drawn: !document.getElementById("settings-panel-repo")?.hidden,
      remembered: localStorage.getItem("wtgui.settingsTab"),
    }));
    check(back.selected && back.drawn && back.remembered === "repo", `a walk of the strip leaves Repo selected and remembered at ${label}`, "");

    // The marks the index and the kinds block draw: the letter is present, and it is the chart's own kind mark.
    await page.click('[data-settings-tab="general"]');
    const marks = await page.evaluate(() => {
      const el = document.getElementById("settings-glossary-index");
      return [...(el?.querySelectorAll(".kind-mark") || [])].map((m) => ({ letter: m.textContent.trim(), label: m.getAttribute("aria-label") }));
    });
    check(marks.length === 2 && marks[0].letter === "T" && marks[1].letter === "R", `the index draws the same T and R the row draws at ${label}`, JSON.stringify(marks));
    await page.close();
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  await panel.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
