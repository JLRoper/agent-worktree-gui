#!/usr/bin/env node
// CAPTURE, not gate: the panel's flow chart and the Pipeline Studio's canvas, side by side, at three window
// widths in both colour schemes — with the six numbers that decide whether a drawing of thirteen stages is
// legible (column width, painted label size, label contrast, stages visible before scrolling, the gap-to-card
// ratio, and the words a card carries).
//
//   node tools/capture-pipeline-flow.mjs                        # shots + ledger into the OS temp dir
//   node tools/capture-pipeline-flow.mjs --shots docs/reviews/<dir> --json docs/reviews/<dir>/capture.json
//   node tools/capture-pipeline-flow.mjs --studio http://127.0.0.1:8095/   # where the studio is served
//   node tools/capture-pipeline-flow.mjs --no-studio             # the panel half only
//   node tools/capture-pipeline-flow.mjs --dsf 2                 # 2× device pixels, for zooming rather than reading
//
// WHY A NEW FILE. Round 5C's `tools/verify-pipeline-flow-visible.mjs` is a GATE: it judges a drawing against
// twenty-odd lines and another run is holding it. This harness shares nothing with it but the panel fixture's
// idea — it never asserts a line, it measures and photographs, and it writes one JSON ledger a report can be
// built from. Nothing under public/, lib/ or the other tools is touched.
//
// THE TWO SURFACES, and why they are comparable:
//   panel   public/pipeline-flow.js, drawn inside the pipeline modal (#pipeline-modal-card): a single row of
//           columns, one per stage, in a horizontal scroller, with a count of what is out of view and a `fit`
//           press that narrows the columns. Font sizes are fixed in CSS and painted 1:1.
//   studio  the SEFL Pipeline Studio served at :8095 (a different project — /ProjectDevelopment/ai-development-
//           factory/tools/pipeline-studio): a 2D lane canvas whose whole `.world` is CSS-scaled to fit, so the
//           type shrinks with the graph, and whose zoom control is the way back to actual size.
//
// BOTH DRAW THE SAME PIPELINE. The fixture below is the studio's own seed (`seed/pipeline.seed.json`, project
// `poc-to-uat`: thirteen stages S0–S12, five gates), re-expressed in the panel's definition schema, so a
// difference in the numbers is a difference in the two drawings and not in their content.
//
// WHAT IS MEASURED, per shot:
//   colW        the painted width of one stage column (median over the cards)
//   labelSize   the painted font size of the card's title. The panel paints at 1:1; the studio paints at
//               computed × the `.world` scale, so the studio's number is the one that shrinks.
//   contrast    WCAG ratio of the title's colour over the card's own (opaque) background
//   visible     how many of the thirteen cards are FULLY inside the scroller/canvas box at rest
//   gapRatio    the painted gap between two neighbouring cards ÷ the card's own width
//   words       the words the card carries (median), and the title's own words
//
// Exit: 0 the captures and the ledger were written; 2 the browser half could not run at all.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPlaywright, notRun, openSettingsGroup, withBrowser } from "./browser.mjs";
import { freePort, startPanel } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const flag = (name) => argv.includes(name);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SHOTS = path.resolve(opt("--shots", path.join(os.tmpdir(), "wtgui-pipeline-capture")));
const JSON_OUT = path.resolve(opt("--json", path.join(SHOTS, "capture.json")));
const STUDIO = String(opt("--studio", "http://127.0.0.1:8095/")).replace(/\/?$/, "/");
const NO_STUDIO = flag("--no-studio");
// 1 is the honest default for a legibility capture: the PNG is then a CSS-pixel-for-pixel picture of the screen, so a
// 1120 px card pasted into a report at 1120 px is 1:1 and the reader can read the label the numbers describe. Pass
// `--dsf 2` when the shots are for zooming rather than reading.
const DSF = Math.max(1, Number(opt("--dsf", 1)) || 1);

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1824, height: 1000 },
  { width: 2560, height: 1200 },
];
const SCHEMES = ["dark", "light"];
const STATES = ["unfitted", "fitted", "end"];

const ledger = {
  startedAt: new Date().toISOString(),
  tree: TREE,
  studio: NO_STUDIO ? null : STUDIO,
  shots: SHOTS,
  fixture: "poc-to-uat (13 stages, five gates) — the studio's own seed, in the panel's definition schema (stage ids are slugs: the panel refuses S0)",
  panel: { base: null, runs: [] },
  studio: { url: NO_STUDIO ? null : STUDIO, reachable: null, runs: [], schemeIdentity: [] },
  notes: [],
  errors: [],
};

const say = (line) => console.log(line);

// ---- the fixture: the studio's seed, in the panel's own definition shape ---------------------------------------
// Titles, ids, artifacts and writers are copied from seed/pipeline.seed.json so the two drawings describe one
// pipeline. The panel's definition schema wants `stages[].artifact` and `stages[].exit`; the studio's doc wants
// `artifact.id/path/writer` — the same four fields the panel prints as one truncated line.
// The panel refuses a stage id that is not a slug (`S0` is refused by the catalogue), so the ids are `s0`..`s12`.
// The id is not painted on a panel card — the ordinal, the title and the artifact are — so the drawing the reader
// sees is the studio's own thirteen names.
const SEED = [
  ["s0", "Intake and charter", "charter", "ledger/charters/charter.md", "steward"],
  ["s1", "POC build", "change-log", "ledger/change-log.json", "scribe"],
  ["s2", "Freeze and export", "frozen-export", "exports/poc-0007/", "freeze-job"],
  ["s3", "Reverse-engineer", "semantic-layer", "layer/", "rulewright"],
  ["s4", "Work breakdown", "module-plan", "ledger/module-plan.md", "architect"],
  ["s5", "Instantiate the model", "skeleton", "ledger/skeleton-manifest.json", "scaffolder"],
  ["s6", "Implement per module", "module-build", "ledger/builds/S6-module.json", "implementer"],
  ["s7", "DAL review and SQL verify", "dal-verdict", "ledger/dal/V-0004.json", "dal-reviewer"],
  ["s8", "Code review rounds", "finding-set", "ledger/findings/F-0018.json", "adjudicator"],
  ["s9", "Rewrite to green", "verdict", "ledger/verdicts/V-0001.json", "verifier"],
  ["s10", "Playwright UI parity", "parity-report", "ledger/parity-report.md", "parity-agent"],
  ["s11", "Delivery to UAT", "install-verdict", "ledger/install/V-0002.json", "release-driver"],
  ["s12", "UAT sign-off", "signed-dod", "ledger/dod/V-0005.json", "user"],
];

const THIRTEEN = {
  id: "poc-to-uat",
  kind: "turnover",
  title: "POC to UAT",
  description: "The studio's seed pipeline, drawn by the panel's flow chart: thirteen stages, five gates.",
  stages: SEED.map(([id, title, artifactId, artifactPath, writer]) => ({
    id,
    title,
    prompt: `work ${id}`,
    artifact: { id: artifactId, path: artifactPath, schema: "1", writer },
    exit: { check: "clean" },
  })),
  gates: [
    { id: "G0", name: "charter signed", after: "s0", artifact: "charter", decider: "reader", decision: { id: "d0", path: "decisions/0.json", schema: "decision/1", writer: "gate-0", outcomes: ["go", "no-go"] } },
    { id: "G1", name: "export frozen", after: "s2", artifact: "frozen-export", decider: "reader", decision: { id: "d1", path: "decisions/1.json", schema: "decision/1", writer: "gate-1", outcomes: ["go", "no-go"] } },
    { id: "G2", name: "layer agreed", after: "s4", artifact: "module-plan", decider: "reader", decision: { id: "d2", path: "decisions/2.json", schema: "decision/1", writer: "gate-2", outcomes: ["go", "no-go"] } },
    { id: "G3", name: "review green", after: "s8", artifact: "finding-set", decider: "reader", decision: { id: "d3", path: "decisions/3.json", schema: "decision/1", writer: "gate-3", outcomes: ["go", "no-go"] } },
    { id: "G4", name: "install verified", after: "s11", artifact: "install-verdict", decider: "reader", decision: { id: "d4", path: "decisions/4.json", schema: "decision/1", writer: "gate-4", outcomes: ["go", "no-go"] } },
  ],
};

// ---- measuring, in the page -------------------------------------------------------------------------------------
// One evaluate per surface, returning rects and computed colours only. The contrast maths runs in the page too,
// because the colour a glyph paints can be an rgba over a layered surface and the walk up to the first opaque
// ancestor is the only honest background to divide by.
const COLOR_HELPERS = `
  const rgbOf = (s) => {
    const m = String(s || "").match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (fg, bg) => {
    if (!fg || !bg) return null;
    const a = lum(fg), b = lum(bg);
    const hi = Math.max(a, b), lo = Math.min(a, b);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };
  const opaqueBg = (el) => {
    let e = el;
    while (e) {
      const c = rgbOf(getComputedStyle(e).backgroundColor);
      if (c && c.a >= 0.999) return c;
      e = e.parentElement;
    }
    return rgbOf(getComputedStyle(document.body).backgroundColor);
  };
  const hex = (c) => (c ? "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("") : null);
  const median = (ns) => {
    const a = ns.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : Math.round(((a[m - 1] + a[m]) / 2) * 10) / 10;
  };
  const rectOf = (el) => { const b = el.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), right: +b.right.toFixed(1), bottom: +b.bottom.toFixed(1) }; };
  const words = (s) => String(s || "").trim().split(/\\s+/).filter(Boolean).length;
`;

const measurePanel = (page) =>
  page.evaluate(`(() => {
    ${COLOR_HELPERS}
    const card = document.getElementById("pipeline-modal-card");
    if (!card) return null;
    const flow = card.querySelector(".pflow");
    const scroll = card.querySelector(".pflow-scroll");
    const nodes = [...card.querySelectorAll(".pflow-node")];
    const box = rectOf(scroll);
    const sr = scroll.getBoundingClientRect();
    const visible = nodes.filter((n) => { const r = n.getBoundingClientRect(); return r.left >= sr.left - 0.5 && r.right <= sr.right + 0.5; });
    const partly = nodes.filter((n) => { const r = n.getBoundingClientRect(); return r.right > sr.left + 0.5 && r.left < sr.right - 0.5; });
    const rects = nodes.map(rectOf);
    const gaps = rects.slice(1).map((r, i) => +(r.x - rects[i].right).toFixed(1));
    const title = nodes[0] ? nodes[0].querySelector(".pflow-title") : null;
    const art = nodes[0] ? nodes[0].querySelector(".pflow-art") : null;
    const fit = card.querySelector("[data-pflow-fit]");
    const countEl = card.querySelector("[data-pflow-count]");
    const countBox = card.querySelector(".pflow-status");
    const cardWords = nodes.map((n) => words(n.innerText));
    const titleWords = nodes.map((n) => words(n.querySelector(".pflow-title")?.innerText || ""));
    // How many lines a title occupies, from its own box ÷ its line-height — the fitted column's real cost.
    const titleLines = nodes.map((n) => {
      const t = n.querySelector(".pflow-title");
      if (!t) return 0;
      const lh = parseFloat(getComputedStyle(t).lineHeight) || parseFloat(getComputedStyle(t).fontSize) * 1.3;
      return Math.round((t.getBoundingClientRect().height / lh) * 10) / 10;
    });
    return {
      surface: "panel",
      viewport: { w: innerWidth, h: innerHeight },
      mode: card.closest("#pipeline-modal")?.dataset.mode || null,
      fitMode: flow?.dataset.fit || "",
      total: nodes.length,
      visible: visible.length,
      partlyVisible: partly.length,
      firstVisible: visible.length ? visible[0].dataset.pos : null,
      lastVisible: visible.length ? visible[visible.length - 1].dataset.pos : null,
      colW: median(rects.map((r) => r.w)),
      gap: median(gaps),
      gapRatio: median(gaps) && median(rects.map((r) => r.w)) ? Math.round((median(gaps) / median(rects.map((r) => r.w))) * 1000) / 1000 : null,
      scroll: { clientW: scroll.clientWidth, scrollW: scroll.scrollWidth, scrollLeft: scroll.scrollLeft, hiddenPx: scroll.scrollWidth - scroll.clientWidth },
      card: rectOf(card),
      scroller: box,
      count: { text: (countEl?.textContent || "").trim(), out: countEl?.dataset.out || null, shown: countBox ? !countBox.hidden : null, size: countEl ? parseFloat(getComputedStyle(countEl).fontSize) : null, contrast: countEl ? ratio(rgbOf(getComputedStyle(countEl).color), opaqueBg(countBox)) : null },
      fitButton: fit ? { text: (fit.textContent || "").trim(), shown: !fit.hidden, size: parseFloat(getComputedStyle(fit).fontSize), contrast: ratio(rgbOf(getComputedStyle(fit).color), opaqueBg(fit)) } : null,
      label: title ? { text: (title.textContent || "").trim(), size: parseFloat(getComputedStyle(title).fontSize), weight: getComputedStyle(title).fontWeight, color: hex(rgbOf(getComputedStyle(title).color)), bg: hex(opaqueBg(nodes[0])), contrast: ratio(rgbOf(getComputedStyle(title).color), opaqueBg(nodes[0])), lineHeight: getComputedStyle(title).lineHeight } : null,
      secondary: art ? { text: (art.textContent || "").trim(), size: parseFloat(getComputedStyle(art).fontSize), color: hex(rgbOf(getComputedStyle(art).color)), contrast: ratio(rgbOf(getComputedStyle(art).color), opaqueBg(nodes[0])) } : null,
      ordinal: nodes[0] ? { size: parseFloat(getComputedStyle(nodes[0].querySelector(".pflow-n")).fontSize), contrast: ratio(rgbOf(getComputedStyle(nodes[0].querySelector(".pflow-n")).color), opaqueBg(nodes[0])) } : null,
      words: { median: median(cardWords), min: Math.min(...cardWords), max: Math.max(...cardWords), total: cardWords.reduce((a, b) => a + b, 0) },
      titleWords: { median: median(titleWords), min: Math.min(...titleWords), max: Math.max(...titleWords) },
      titleLines: { median: median(titleLines), max: Math.max(...titleLines) },
      page: { bodyBg: hex(rgbOf(getComputedStyle(document.body).backgroundColor)), colorScheme: getComputedStyle(document.documentElement).colorScheme },
      perCard: nodes.map((n, i) => ({ id: n.dataset.stage, pos: n.dataset.pos, mark: n.dataset.mark, title: (n.querySelector(".pflow-title")?.textContent || "").trim(), w: rects[i].w, h: rects[i].h, words: cardWords[i], titleWords: titleWords[i], lines: titleLines[i], fullyVisible: visible.includes(n) })),
    };
  })()`);

const measureStudio = (page) =>
  page.evaluate(`(() => {
    ${COLOR_HELPERS}
    const canvas = document.querySelector(".canvas");
    if (!canvas) return null;
    const world = document.querySelector(".world");
    const nodes = [...document.querySelectorAll(".node")];
    const cr = canvas.getBoundingClientRect();
    const scale = (() => {
      const m = getComputedStyle(world).transform;
      const n = m && m !== "none" ? m.match(/matrix\\(([^)]+)\\)/) : null;
      return n ? Number(n[1].split(",")[0]) : 1;
    })();
    const visible = nodes.filter((n) => { const r = n.getBoundingClientRect(); return r.left >= cr.left - 0.5 && r.right <= cr.right + 0.5 && r.top >= cr.top - 0.5 && r.bottom <= cr.bottom + 0.5; });
    const rects = nodes.map(rectOf);
    // The gaps: two cards on the same lane row, left to right. Cards in different rows are not a gap.
    const rows = new Map();
    nodes.forEach((n, i) => { const key = Math.round(rects[i].y); if (!rows.has(key)) rows.set(key, []); rows.get(key).push(rects[i]); });
    const gaps = [];
    for (const row of rows.values()) { row.sort((a, b) => a.x - b.x); row.slice(1).forEach((r, i) => gaps.push(+(r.x - row[i].right).toFixed(1))); }
    const name = nodes[0] ? nodes[0].querySelector(".node-name") : null;
    const art = nodes[0] ? nodes[0].querySelector(".node-artifact") : null;
    const cardWords = nodes.map((n) => words(n.innerText));
    const titleWords = nodes.map((n) => words(n.querySelector(".node-name")?.innerText || ""));
    const titleLines = nodes.map((n) => {
      const t = n.querySelector(".node-name");
      if (!t) return 0;
      // The box is measured in SCREEN pixels (the world is scaled), the line-height in WORLD pixels: divide by both.
      const lh = (parseFloat(getComputedStyle(t).lineHeight) || parseFloat(getComputedStyle(t).fontSize) * 1.3) * scale;
      return Math.round((t.getBoundingClientRect().height / lh) * 10) / 10;
    });
    const zoomLabel = document.getElementById("zoomLabel");
    const canvasWords = document.querySelector(".canvas-hint");
    const status = document.querySelector(".statusbar, .status, [class*='status']");
    const rowCount = new Set(rects.map((r) => Math.round(r.y))).size;
    return {
      surface: "studio",
      viewport: { w: innerWidth, h: innerHeight },
      total: nodes.length,
      visible: visible.length,
      partlyVisible: nodes.filter((n) => { const r = n.getBoundingClientRect(); return r.right > cr.left + 0.5 && r.left < cr.right - 0.5 && r.bottom > cr.top + 0.5 && r.top < cr.bottom - 0.5; }).length,
      scale: Math.round(scale * 10000) / 10000,
      zoom: (zoomLabel?.textContent || "").trim(),
      colW: median(rects.map((r) => r.w)),
      gap: median(gaps),
      gapRatio: median(gaps) && median(rects.map((r) => r.w)) ? Math.round((median(gaps) / median(rects.map((r) => r.w))) * 1000) / 1000 : null,
      canvas: { w: Math.round(cr.width), h: Math.round(cr.height), scrollW: canvas.scrollWidth, scrollH: canvas.scrollHeight, overflow: getComputedStyle(canvas).overflow },
      label: name ? { text: (name.textContent || "").trim(), size: parseFloat(getComputedStyle(name).fontSize), painted: Math.round(parseFloat(getComputedStyle(name).fontSize) * scale * 100) / 100, weight: getComputedStyle(name).fontWeight, color: hex(rgbOf(getComputedStyle(name).color)), bg: hex(opaqueBg(nodes[0])), contrast: ratio(rgbOf(getComputedStyle(name).color), opaqueBg(nodes[0])) } : null,
      secondary: art ? { text: (art.textContent || "").trim(), size: parseFloat(getComputedStyle(art).fontSize), painted: Math.round(parseFloat(getComputedStyle(art).fontSize) * scale * 100) / 100, contrast: ratio(rgbOf(getComputedStyle(art).color), opaqueBg(nodes[0])) } : null,
      idLabel: nodes[0] ? { size: parseFloat(getComputedStyle(nodes[0].querySelector(".node-id")).fontSize), painted: Math.round(parseFloat(getComputedStyle(nodes[0].querySelector(".node-id")).fontSize) * scale * 100) / 100 } : null,
      words: { median: median(cardWords), min: Math.min(...cardWords), max: Math.max(...cardWords), total: cardWords.reduce((a, b) => a + b, 0) },
      titleWords: { median: median(titleWords), min: Math.min(...titleWords), max: Math.max(...titleWords) },
      titleLines: { median: median(titleLines), max: Math.max(...titleLines) },
      page: { bodyBg: hex(rgbOf(getComputedStyle(document.body).backgroundColor)), colorScheme: getComputedStyle(document.documentElement).colorScheme, prefersDark: matchMedia("(prefers-color-scheme: dark)").matches },
      hint: (canvasWords?.textContent || "").replace(/\\s+/g, " ").trim() || null,
      status: (status?.textContent || "").replace(/\\s+/g, " ").trim() || null,
      rowCount,
      perCard: nodes.map((n, i) => ({ id: n.dataset.id || n.getAttribute("data-id"), title: (n.querySelector(".node-name")?.textContent || "").trim(), x: rects[i].x, y: rects[i].y, w: rects[i].w, h: rects[i].h, words: cardWords[i], titleWords: titleWords[i], lines: titleLines[i], fullyVisible: visible.includes(n) })),
    };
  })()`);

// Does the stylesheet branch on the reader's colour scheme at all? Read every same-origin sheet's rules and look
// for the query, plus the root's `color-scheme`. A surface with no query is not "failing" dark mode: it has one
// palette and never asked.
const measureThemeSource = (page) =>
  page.evaluate(() => {
    const sheets = [...document.styleSheets];
    let queries = 0;
    const found = [];
    for (const sheet of sheets) {
      let rules = [];
      try {
        rules = [...sheet.cssRules];
      } catch {
        continue; // cross-origin: cannot read, and it cannot be the panel's own sheet either
      }
      for (const rule of rules) {
        if (rule.media && /prefers-color-scheme/i.test(rule.conditionText || rule.media.mediaText || "")) {
          queries += 1;
          found.push(rule.conditionText || rule.media.mediaText);
        }
      }
    }
    const root = getComputedStyle(document.documentElement);
    return {
      sheets: sheets.length,
      darkQueries: queries,
      mediaQueries: found.slice(0, 6),
      rootColorScheme: root.colorScheme,
      themeAttr: document.documentElement.getAttribute("data-theme"),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyColor: getComputedStyle(document.body).color,
      rootBg: getComputedStyle(document.documentElement).backgroundColor,
    };
  });

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);

const shoot = async (page, selector, file) => {
  const el = await page.$(selector);
  if (!el) throw new Error(`no element for ${selector}`);
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.screenshot({ path: file });
  return file;
};

const settle = async (page, ms = 220) => page.waitForTimeout(ms);

// ---- boot the throwaway panel -----------------------------------------------------------------------------------
const pw = loadPlaywright();
if (!pw) {
  console.log(notRun("the flow chart was not photographed", "Playwright is not installed in this checkout (tools/browser.mjs could not load it)."));
  process.exit(2);
}

const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-pipeline-capture-"));
const logs = path.join(dir, "logs");
mkdirSync(logs, { recursive: true });
mkdirSync(SHOTS, { recursive: true });
const pipelinesFile = path.join(dir, "pipelines.json");
writeFileSync(pipelinesFile, JSON.stringify({ version: 1, pipelines: { [THIRTEEN.id]: THIRTEEN } }, null, 1), "utf8");

const port = await freePort();
const panel = await startPanel({
  dir,
  port,
  root: TREE,
  keep: true,
  config: {
    pipelinesFile,
    dataDir: path.join(dir, "data"),
    refreshSeconds: 3600,
    worktreeSeconds: 3600,
    midSeconds: 3600,
    dormantSeconds: 3600,
    slowSeconds: 3600,
    fetchSeconds: -1,
    projects: [],
    assistant: { enabled: false },
    apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
  },
});
ledger.panel.base = panel.base;
say(`panel ${panel.base} — throwaway config in ${dir}`);

const openFlow = async (page) => {
  await page.goto(panel.base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#job-prompt", { state: "visible", timeout: 30_000 });
  await openSettingsGroup(page, "pipeline");
  await page.waitForFunction(() => {
    const el = document.getElementById("pipeline-summary");
    return el && !/reading/i.test(el.textContent || "");
  }, null, { timeout: 20_000 });
  await page.selectOption("#pipeline-select", THIRTEEN.id);
  await page.waitForSelector("#pipeline-editor:not([hidden]) .pipeline-stage", { timeout: 15_000 });
  await page.click("#pipeline-flow-open");
  await page.waitForSelector("#pipeline-modal:not([hidden]) .pflow-node", { timeout: 15_000 });
  // The count row is unhidden by the modal's own measurement, after layout: wait for its sentence, not for a timer.
  await page.waitForFunction(() => {
    const el = document.querySelector("[data-pflow-count]");
    return el && (el.textContent || "").trim().length > 0;
  }, null, { timeout: 10_000, polling: 50 });
  await settle(page);
};

let studioReachable = false;
try {
  const probe = await fetch(STUDIO, { signal: AbortSignal.timeout(4000) });
  studioReachable = probe.ok && /Pipeline Studio/i.test(await probe.text());
  ledger.studio.reachable = studioReachable;
} catch (e) {
  ledger.notes.push(`studio not reachable at ${STUDIO}: ${String(e.message || e)}`);
}
if (!NO_STUDIO && !studioReachable) say(`studio ${STUDIO} is not answering — capturing the panel half only`);
if (NO_STUDIO) say("--no-studio: panel half only");
ledger.studio.reachable = Boolean(studioReachable);

try {
  await withBrowser(
    async ({ browser, withPage }) => {
      for (const viewport of VIEWPORTS) {
        for (const scheme of SCHEMES) {
          const label = `${viewport.width}x${viewport.height}/${scheme}`;

          // ---- the panel ------------------------------------------------------------------------------------
          await withPage(
            async ({ page }) => {
              await openFlow(page);
              const base = `panel-${scheme}-${viewport.width}`;
              const run = { viewport, scheme, surface: "panel", shots: {} };

              // 1. unfitted, at the left edge: what the reader meets, with the count
              run.shots.unfitted = await shoot(page, "#pipeline-modal-card", path.join(SHOTS, `${base}-unfitted.png`));
              run.unfitted = await measurePanel(page);

              // 2. scrolled to the far end: the count must say something else
              await page.evaluate(() => {
                const s = document.querySelector("#pipeline-modal-card .pflow-scroll");
                s.scrollLeft = s.scrollWidth;
              });
              await settle(page, 320);
              run.shots.end = await shoot(page, "#pipeline-modal-card", path.join(SHOTS, `${base}-end.png`));
              run.end = await measurePanel(page);

              // 3. back to the start, then the fit press
              await page.evaluate(() => {
                const s = document.querySelector("#pipeline-modal-card .pflow-scroll");
                s.scrollLeft = 0;
              });
              await settle(page, 200);
              await page.click("#pipeline-modal-card [data-pflow-fit]");
              await page.waitForFunction(() => document.querySelector("#pipeline-modal-card .pflow")?.dataset.fit === "1", null, { timeout: 10_000 });
              await settle(page, 320);
              run.shots.fitted = await shoot(page, "#pipeline-modal-card", path.join(SHOTS, `${base}-fitted.png`));
              run.fitted = await measurePanel(page);

              if (scheme === "dark" && viewport.width === 1280) {
                await page.evaluate(() => {
                  const s = document.querySelector("#pipeline-modal-card .pflow-scroll");
                  s.scrollLeft = 0;
                });
                await settle(page, 150);
                run.shots.page = path.join(SHOTS, `${base}-page.png`);
                await page.screenshot({ path: run.shots.page });
                ledger.panel.theme = await measureThemeSource(page);
              }
              ledger.panel.runs.push(run);
              say(`  panel ${label}: ${run.unfitted.visible}/${run.unfitted.total} visible, col ${run.unfitted.colW}px, label ${run.unfitted.label?.size}px`);
            },
            { viewport, contextOptions: { colorScheme: scheme }, deviceScaleFactor: DSF },
          );

          // ---- the studio -----------------------------------------------------------------------------------
          if (NO_STUDIO || !studioReachable) continue;
          await withPage(
            async ({ page }) => {
              await page.goto(STUDIO, { waitUntil: "domcontentloaded", timeout: 20_000 });
              await page.waitForFunction(() => document.querySelectorAll(".node").length > 0, null, { timeout: 20_000, polling: 100 });
              await settle(page, 700); // the fit runs on a 30 ms timer after the first render, then the fonts settle
              const base = `studio-${scheme}-${viewport.width}`;
              const run = { viewport, scheme, surface: "studio", shots: {} };

              // 1. as it loads: the studio's own answer to thirteen stages (it fits the width and scales the world)
              run.shots.fit = await shoot(page, ".canvas", path.join(SHOTS, `${base}-fit.png`));
              run.fit = await measureStudio(page);

              // 2. actual size: the zoom reset is the reader's way out of the fit
              await page.click('[data-act="zoom-reset"]');
              await settle(page, 350);
              run.shots.actual = await shoot(page, ".canvas", path.join(SHOTS, `${base}-actual.png`));
              run.actual = await measureStudio(page);

              // 3. panned to the far end at actual size — the studio's equivalent of the panel's scroll. The pan is
              // unbounded (the canvas is overflow:hidden and the drag writes panX directly), so a fixed delta can
              // throw the whole drawing off the canvas and leave a shot of empty dots. Travel exactly the overflow
              // that hides the LAST card, measured, and never more than the canvas can hold.
              const pan = await page.evaluate(() => {
                const c = document.querySelector(".canvas").getBoundingClientRect();
                const rights = [...document.querySelectorAll(".node")].map((n) => n.getBoundingClientRect().right);
                return { x: c.x, y: c.y, w: c.width, h: c.height, need: Math.max(...rights) + 24 - c.right, room: c.width - 80 };
              });
              const box = pan;
              const dx = Math.max(0, Math.min(pan.need, pan.room));
              if (dx > 2) {
                await page.mouse.move(box.x + box.w - 60, box.y + box.h - 40);
                await page.mouse.down();
                await page.mouse.move(box.x + box.w - 60 - dx, box.y + box.h - 40, { steps: 12 });
                await page.mouse.up();
                await settle(page, 350);
              }
              run.panDelta = Math.round(dx);
              run.shots.end = await shoot(page, ".canvas", path.join(SHOTS, `${base}-end.png`));
              run.end = await measureStudio(page);

              if (scheme === "dark" && viewport.width === 1280) {
                run.shots.page = path.join(SHOTS, `${base}-page.png`);
                await page.screenshot({ path: run.shots.page });
                ledger.studioTheme = await measureThemeSource(page);
              }
              ledger.studio.runs.push(run);
              say(`  studio ${label}: ${run.fit.visible}/${run.fit.total} visible at ${run.fit.zoom}, label ${run.fit.label?.painted}px painted (scale ${run.fit.scale})`);
            },
            { viewport, contextOptions: { colorScheme: scheme }, deviceScaleFactor: DSF },
          );
        }
      }
    },
    { viewport: VIEWPORTS[0], deviceScaleFactor: DSF },
  );
} catch (e) {
  ledger.errors.push(String((e && e.stack) || e));
  console.log(`FAIL  the capture threw: ${String((e && e.stack) || e).split("\n").slice(0, 8).join("\n      ")}`);
} finally {
  await panel.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

// The dark/light question, answered by bytes: two schemes that produce the same PNG produced the same drawing.
const identity = (runs, surface) => {
  const out = [];
  for (const viewport of VIEWPORTS) {
    for (const state of surface === "panel" ? STATES : ["fit", "actual", "end"]) {
      const dark = runs.find((r) => r.viewport.width === viewport.width && r.scheme === "dark")?.shots?.[state];
      const light = runs.find((r) => r.viewport.width === viewport.width && r.scheme === "light")?.shots?.[state];
      if (!dark || !light) continue;
      out.push({ width: viewport.width, state, dark: sha(dark), light: sha(light), identical: sha(dark) === sha(light) });
    }
  }
  return out;
};
ledger.panel.schemeIdentity = identity(ledger.panel.runs, "panel");
ledger.studio.schemeIdentity = identity(ledger.studio.runs, "studio");
ledger.finishedAt = new Date().toISOString();
ledger.shotCount = ledger.panel.runs.reduce((n, r) => n + Object.keys(r.shots).length, 0) + ledger.studio.runs.reduce((n, r) => n + Object.keys(r.shots).length, 0);
writeFileSync(JSON_OUT, JSON.stringify(ledger, null, 1), "utf8");

say(`\nSHOTS  ${SHOTS} (${ledger.shotCount} files)`);
say(`LEDGER ${JSON_OUT}`);
if (ledger.errors.length) {
  say(`ERRORS ${ledger.errors.length}`);
  process.exit(1);
}
