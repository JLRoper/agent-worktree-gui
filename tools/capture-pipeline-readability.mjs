#!/usr/bin/env node
// CAPTURE, not gate: the pipeline flow dialog at one, two, seven and thirteen stages, at 1280×800 and 1824×900,
// with the numbers a readability audit argues from — what carries the most ink, which text is legible, what the
// drawing puts on screen for order, loop-back, a gate's meaning and the live stage.
//
//   node tools/capture-pipeline-readability.mjs
//   node tools/capture-pipeline-readability.mjs --shots docs/reviews/pipeline-readability-audit
//   node tools/capture-pipeline-readability.mjs --json docs/reviews/pipeline-readability-audit/capture.json
//
// WHY A NEW FILE. `tools/capture-pipeline-flow.mjs` photographs thirteen stages against the Pipeline Studio at three
// widths and two colour schemes; `tools/verify-pipeline-flow-visible.mjs` is a gate and another run holds it. This
// harness does one thing: the dialog the reader opens from Settings → Pipeline, at four lengths and the two widths
// the brief names, with the same drawing photographed at both so the widths can be compared.
//
// THE FIXTURES. Three are the panel's own shipped definitions, read out of `pipelines.seed.json` rather than
// transcribed: `local` (1 stage), `investigate` (2), `sefl-review-loop` (7). The thirteen-stage definition is the
// Pipeline Studio's seed (`poc-to-uat`) re-expressed in the panel's schema — stage ids are slugs because the
// catalogue refuses `S0`; the painted titles, artifacts and writers are the studio's.
//
// THE MEASUREMENTS, all read off painted rects and computed styles in the page:
//   ink       rect area × (WCAG contrast − 1), per element group. A proxy for "where the eye lands", named as a
//             proxy in the report — the largest ink object is what the picture makes heaviest, not a fixation study.
//   contrast  WCAG ratio of a text colour over the first OPAQUE ancestor background (the mark chain is rgba).
//   lines     a text box's height ÷ its own line-height — how much of a title the column actually shows.
//   fit       scrollWidth against clientWidth, and how many stage cards and notches are fully inside the scroller.
//   states    every notch's `data-state`, its aria-label and title length, and its painted colour; every node's mark.
//
// Exit: 0 the captures and the ledger were written; 2 Playwright is not installed; 1 the browser half threw.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPlaywright, notRun, openSettingsGroup, withBrowser, openFlowEdit } from "./browser.mjs";
import { freePort, startPanel } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SHOTS = path.resolve(opt("--shots", path.join(os.tmpdir(), "wtgui-pipeline-readability")));
const JSON_OUT = path.resolve(opt("--json", path.join(SHOTS, "capture.json")));

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1824, height: 900 },
];

// ---- the fixtures ----------------------------------------------------------------------------------------------
// Three shipped definitions, read from the tree's own seed so the drawing under the audit is the one the panel
// ships. `next` is carried as the seed has it; the 7-stage definition's own name says "loop" and its stages are a
// straight chain, which is the fixture the loop-back finding is about.
const SEED = JSON.parse(readFileSync(path.join(TREE, "pipelines.seed.json"), "utf8"));
const shipped = (id) => {
  const found = (SEED.pipelines || []).find((p) => p.id === id);
  if (!found) throw new Error(`pipelines.seed.json no longer carries ${id}`);
  return found;
};

// The thirteen-stage definition: the studio's own seed (`seed/pipeline.seed.json`, project `poc-to-uat`), with the
// same titles, artifacts and writers; ids are slugs because the catalogue refuses S0. Exits are from the closed
// vocabulary and differ per stage, so the notches are not thirteen copies of one word.
const THIRTEEN_ROWS = [
  ["s0", "Intake and charter", "charter", "ledger/charters/charter.md", "steward", { check: "commits", min: 1 }],
  ["s1", "POC build", "change-log", "ledger/change-log.json", "scribe", { check: "file-exists", path: "ledger/change-log.json" }],
  ["s2", "Freeze and export", "frozen-export", "exports/poc-0007/", "freeze-job", { check: "file-exists", path: "exports/poc-0007/crawl.json" }],
  ["s3", "Reverse-engineer", "semantic-layer", "layer/", "rulewright", { check: "commits", min: 3 }],
  ["s4", "Work breakdown", "module-plan", "ledger/module-plan.md", "architect", { check: "file-exists", path: "ledger/module-plan.md" }],
  ["s5", "Instantiate the model", "skeleton", "ledger/skeleton-manifest.json", "scaffolder", { check: "commits", min: 1 }],
  ["s6", "Implement per module", "module-build", "ledger/builds/S6-module.json", "implementer", { check: "clean" }],
  ["s7", "DAL review and SQL verify", "dal-verdict", "ledger/dal/V-0004.json", "dal-reviewer", { check: "file-exists", path: "ledger/dal/V-0004.json" }],
  ["s8", "Code review rounds", "finding-set", "ledger/findings/F-0018.json", "adjudicator", { check: "commits", min: 1 }],
  ["s9", "Rewrite to green", "verdict", "ledger/verdicts/V-0001.json", "verifier", { check: "clean" }],
  ["s10", "Playwright UI parity", "parity-report", "ledger/parity-report.md", "parity-agent", { check: "command", argv: ["node", "tools/verify-ui.mjs"] }],
  ["s11", "Delivery to UAT", "install-verdict", "ledger/install/V-0002.json", "release-driver", { check: "pushed" }],
  ["s12", "UAT sign-off", "signed-dod", "ledger/dod/V-0005.json", "user", { check: "file-exists", path: "ledger/dod/V-0005.json" }],
];

const THIRTEEN = {
  id: "acceptance-thirteen",
  kind: "turnover",
  title: "POC to UAT",
  description: "The studio's seed pipeline, drawn by the panel's flow: thirteen stages and thirteen exit checks.",
  next: null,
  stages: THIRTEEN_ROWS.map(([id, title, artifactId, artifactPath, writer, exit]) => ({
    id,
    title,
    prompt: `work ${id}`,
    artifact: { id: artifactId, path: artifactPath, schema: "1", writer },
    exit,
  })),
};

const FIXTURES = [
  { key: "one", stages: 1, def: shipped("local") },
  // `sefl-investigate` is one of the two shipped definitions whose `next` names another pipeline, so the two-stage
  // shot has a chain fact to show — the picture ends at stage 2 and only the header's 11 px fact says what follows.
  { key: "two", stages: 2, def: shipped("sefl-investigate") },
  { key: "seven", stages: 7, def: shipped("sefl-review-loop") },
  { key: "thirteen", stages: 13, def: THIRTEEN },
];

// The supporting position-mode drawing: the same seven stages as a bundle, with one capped loop back from the
// approval to the branch and two gates, parked at the review stage. It exists so the audit can say what the
// catalogue dialog cannot draw — a loop edge and a live mark — without claiming that dialog draws them.
const POSITION_BUNDLE = {
  id: "sefl-review-loop-bundle",
  kind: "turnover",
  title: "SEFL review loop",
  stages: shipped("sefl-review-loop").stages.map((s) => ({ id: s.id, title: s.title, artifact: s.artifact || null })),
  gates: [
    {
      id: "G1",
      name: "review green",
      after: "wait",
      artifact: "finding-set",
      decider: "reader",
      decision: { path: "decisions/review.json", outcomes: ["go", "again"] },
    },
    {
      id: "G2",
      name: "head approved",
      after: "approve",
      artifact: "verdict",
      decider: "reader",
      decision: { path: "decisions/approve.json", outcomes: ["go", "no-go"] },
    },
  ],
  handoffs: [
    { id: "H-10", kind: "loop", from: "address", to: "branch", cap: "2 of 3 rounds", artifact: "finding-set" },
  ],
};

const POSITION = {
  stage: "address",
  ran: ["branch", "push", "pr", "wait"],
  crossings: { "H-10": 1 },
  via: null,
};

// ---- page-side measurement --------------------------------------------------------------------------------------
// The contrast walk and the rect helpers run in the page: a text colour can be rgba over a layered surface, and the
// first opaque ancestor is the only honest divisor. `ink` is area × (ratio − 1); the report names it a proxy.
const HELPERS = `
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
    const hi = Math.max(lum(fg), lum(bg)), lo = Math.min(lum(fg), lum(bg));
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
  const rectOf = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), right: +b.right.toFixed(1), bottom: +b.bottom.toFixed(1) };
  };
  const styleOf = (el) => {
    if (!el) return null;
    const s = getComputedStyle(el);
    const bg = opaqueBg(el);
    return {
      text: (el.textContent || "").replace(/\\s+/g, " ").trim(),
      size: parseFloat(s.fontSize),
      weight: s.fontWeight,
      lineHeight: s.lineHeight,
      color: hex(rgbOf(s.color)),
      bg: hex(bg),
      contrast: ratio(rgbOf(s.color), bg),
    };
  };
  const lineCount = (el) => {
    if (!el) return 0;
    const s = getComputedStyle(el);
    const lh = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.3;
    return Math.round((el.getBoundingClientRect().height / lh) * 10) / 10;
  };
  // rect area × (contrast − 1): the drawing's own weight, in one number per group. The rects come from a Range over
  // the element's TEXT, not from its border box — a flex row's box is the whole column even when the words in it are
  // short, and that made a one-line legend outweigh seven stage titles. The "skip" argument excludes a leading span
  // (the title's ordinal, measured on its own line of the ledger).
  const inkOf = (els, skip) => {
    let sum = 0;
    for (const el of els) {
      if (!el) continue;
      const s = getComputedStyle(el);
      const k = ratio(rgbOf(s.color), opaqueBg(el)) || 1;
      const range = document.createRange();
      const first = skip && el.querySelector && el.querySelector(skip);
      if (first && first.nextSibling) {
        range.setStartBefore(first.nextSibling);
        range.setEnd(el, el.childNodes.length);
      } else {
        range.selectNodeContents(el);
      }
      for (const r of range.getClientRects()) sum += r.width * r.height * Math.max(0, k - 1);
    }
    return Math.round(sum);
  };
  // Exact union area of boxes, each clipped to the scroller's client box — the drawing the reader can actually see.
  const clippedArea = (rects, clip) => {
    const boxes = rects
      .map((r) => ({ l: Math.max(r.left, clip.left), t: Math.max(r.top, clip.top), r: Math.min(r.right, clip.right), b: Math.min(r.bottom, clip.bottom) }))
      .filter((b) => b.r > b.l && b.b > b.t);
    if (!boxes.length) return 0;
    const xs = [...new Set(boxes.flatMap((b) => [b.l, b.r]))].sort((a, b) => a - b);
    let area = 0;
    for (let i = 0; i < xs.length - 1; i += 1) {
      const x0 = xs[i], x1 = xs[i + 1];
      const spans = boxes.filter((b) => b.l < x1 && b.r > x0).map((b) => [b.t, b.b]).sort((a, b) => a[0] - b[0]);
      if (!spans.length) continue;
      let covered = 0, from = spans[0][0], to = spans[0][1];
      for (const [t, b] of spans.slice(1)) {
        if (t > to) { covered += to - from; from = t; to = b; }
        else to = Math.max(to, b);
      }
      covered += to - from;
      area += covered * (x1 - x0);
    }
    return Math.round(area);
  };
  const inkBox = (els, bgOf) => {
    let sum = 0;
    for (const el of els) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const k = ratio(rgbOf(s.backgroundColor), opaqueBg(bgOf ? bgOf(el) : el)) || 1;
      sum += r.width * r.height * Math.max(0, k - 1);
    }
    return Math.round(sum);
  };
  const words = (s) => String(s || "").trim().split(/\\s+/).filter(Boolean).length;
  const median = (ns) => {
    const a = ns.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : Math.round(((a[m - 1] + a[m]) / 2) * 10) / 10;
  };
`;

const measure = (page) =>
  page.evaluate(`(() => {
    ${HELPERS}
    const card = document.getElementById("pipeline-modal-card");
    if (!card) return null;
    const q = (s) => card.querySelector(s);
    const flow = q(".pflow");
    const scroll = q(".pflow-scroll");
    const track = q(".pflow-track");
    const nodes = [...card.querySelectorAll(".pflow-node")];
    const notches = [...card.querySelectorAll(".pflow-notch")];
    const arcs = [...card.querySelectorAll(".pflow-arc")];
    const sr = scroll.getBoundingClientRect();
    const visible = nodes.filter((n) => { const r = n.getBoundingClientRect(); return r.left >= sr.left - 0.5 && r.right <= sr.right + 0.5; });
    const visibleNotches = notches.filter((n) => { const r = n.getBoundingClientRect(); return r.left >= sr.left - 0.5 && r.right <= sr.right + 0.5; });
    const nodeRects = nodes.map((n) => n.getBoundingClientRect());
    const colW = median(nodeRects.map((r) => r.width));
    const gaps = nodeRects.slice(1).map((r, i) => +(r.left - nodeRects[i].right).toFixed(1));
    const bar = q(".pmodal-bar");
    const wordsPerCard = nodes.map((n) => words(n.innerText));
    const titleWords = nodes.map((n) => words(n.querySelector(".pflow-title")?.innerText || ""));
    const detailEls = nodes.map((n) => n.querySelector(".pflow-art"));
    const detailTexts = detailEls.map((d) => (d?.textContent || "").trim());
    const statusRow = q(".pflow-status");
    const legend = q(".pflow-legend");
    const fit = q("[data-pflow-fit]");
    const countEl = q("[data-pflow-count]");
    const drawnRects = [
      ...nodeRects,
      ...notches.map((n) => n.getBoundingClientRect()),
      ...arcs.map((a) => a.getBoundingClientRect()),
      statusRow && !statusRow.hidden ? statusRow.getBoundingClientRect() : null,
      legend ? legend.getBoundingClientRect() : null,
    ].filter(Boolean);
    const cardBox = card.getBoundingClientRect();
    // The union is clipped to the card AND, for the track's own contents, to the scroller. Status and legend are
    // outside the scroller, so they are clipped to the card alone; the sum over-counts their overlap by at most a
    // few dozen pixels and the report quotes the share to one percent.
    const scrollClip = { left: sr.left, top: sr.top, right: sr.right, bottom: sr.bottom };
    const trackClip = { left: Math.max(cardBox.left, sr.left), top: Math.max(cardBox.top, sr.top), right: Math.min(cardBox.right, sr.right), bottom: Math.min(cardBox.bottom, sr.bottom) };
    const trackArea = clippedArea(drawnRects.slice(0, nodeRects.length + notches.length + arcs.length), trackClip);
    const chromeArea = clippedArea(drawnRects.slice(nodeRects.length + notches.length + arcs.length), { left: cardBox.left, top: cardBox.top, right: cardBox.right, bottom: cardBox.bottom });
    const ink = {
      barTitle: inkOf([q(".pmodal-title")].filter(Boolean)),
      barKicker: inkOf([q(".pmodal-kicker")].filter(Boolean)),
      barFacts: inkOf([q(".pmodal-facts")].filter(Boolean)),
      stageTitles: inkOf(nodes.map((n) => n.querySelector(".pflow-title")).filter(Boolean), ".pflow-n"),
      ordinals: inkOf(nodes.map((n) => n.querySelector(".pflow-n")).filter(Boolean)),
      details: inkOf(detailEls.filter(Boolean)),
      notches: inkBox(notches, (el) => el.closest(".pflow-node")),
      dots: inkBox(nodes.map((n) => n.querySelector(".pflow-dot")).filter(Boolean), (el) => el.closest(".pflow-node")),
      legend: inkOf([legend].filter(Boolean)),
      status: inkOf([countEl].filter(Boolean)),
    };
    return {
      viewport: { w: innerWidth, h: innerHeight },
      mode: card.closest("#pipeline-modal")?.dataset.mode || null,
      stages: nodes.length,
      card: rectOf(card),
      bar: rectOf(bar),
      barItems: bar ? [...bar.children].map((el) => ({ cls: String(el.className || ""), text: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 48), rect: rectOf(el) })) : [],
      body: rectOf(q(".pmodal-body")),
      flow: rectOf(flow),
      track: rectOf(track),
      fit: flow?.dataset.fit || "",
      marksFrom: flow?.dataset.marksFrom || null,
      position: flow?.dataset.position || "",
      scroller: { clientW: scroll.clientWidth, scrollW: scroll.scrollWidth, scrollLeft: scroll.scrollLeft, hiddenPx: scroll.scrollWidth - scroll.clientWidth },
      visibleStages: visible.length,
      visibleNotches: visibleNotches.length,
      colW,
      gap: median(gaps),
      count: {
        shown: Boolean(statusRow && !statusRow.hidden),
        text: (countEl?.textContent || "").trim(),
        size: countEl ? parseFloat(getComputedStyle(countEl).fontSize) : null,
        contrast: countEl ? ratio(rgbOf(getComputedStyle(countEl).color), opaqueBg(countEl)) : null,
      },
      fitButton: fit ? { shown: !fit.hidden, text: (fit.textContent || "").trim(), size: parseFloat(getComputedStyle(fit).fontSize) } : null,
      legend: legend ? { ...styleOf(legend), count: legend.querySelectorAll(".pflow-key").length } : null,
      title: styleOf(q(".pmodal-title")),
      kicker: styleOf(q(".pmodal-kicker")),
      facts: styleOf(q(".pmodal-facts")),
      factLabel: styleOf(q(".pmodal-facts i")),
      factValue: styleOf(q(".pmodal-facts b")),
      closeButton: styleOf(q(".pmodal-close")),
      stageTitle: nodes[0] ? { ...styleOf(nodes[0].querySelector(".pflow-title")), lines: lineCount(nodes[0].querySelector(".pflow-title")) } : null,
      ordinal: nodes[0] ? styleOf(nodes[0].querySelector(".pflow-n")) : null,
      detail: nodes[0] ? { ...styleOf(nodes[0].querySelector(".pflow-art")), lines: lineCount(nodes[0].querySelector(".pflow-art")) } : null,
      dot: nodes[0] ? { color: hex(rgbOf(getComputedStyle(nodes[0].querySelector(".pflow-dot")).backgroundColor)), w: +nodes[0].querySelector(".pflow-dot").getBoundingClientRect().width.toFixed(1), h: +nodes[0].querySelector(".pflow-dot").getBoundingClientRect().height.toFixed(1), contrast: ratio(rgbOf(getComputedStyle(nodes[0].querySelector(".pflow-dot")).backgroundColor), opaqueBg(nodes[0])) } : null,
      notchStyle: notches[0] ? { color: hex(rgbOf(getComputedStyle(notches[0]).backgroundColor)), w: +notches[0].getBoundingClientRect().width.toFixed(1), h: +notches[0].getBoundingClientRect().height.toFixed(1), contrast: ratio(rgbOf(getComputedStyle(notches[0]).backgroundColor), opaqueBg(notches[0].closest(".pflow-node"))) } : null,
      marks: nodes.map((n) => n.dataset.mark),
      notches: notches.map((n) => ({
        state: n.dataset.state,
        gate: n.dataset.gate,
        name: n.dataset.gateName,
        color: hex(rgbOf(getComputedStyle(n).backgroundColor)),
        ariaLen: (n.getAttribute("aria-label") || "").length,
        titleLen: (n.getAttribute("title") || "").length,
        aria: n.getAttribute("aria-label") || "",
        title: n.getAttribute("title") || "",
      })),
      arcs: arcs.map((a) => ({ loop: a.dataset.loop, from: a.dataset.from, to: a.dataset.to, cap: a.dataset.cap, label: (a.querySelector(".pflow-arc-label")?.textContent || "").trim(), rect: rectOf(a) })),
      link: (() => {
        const el = q(".pflow-link");
        if (!el) return null;
        const s = getComputedStyle(el);
        const head = getComputedStyle(el, "::before");
        return { w: +el.getBoundingClientRect().width.toFixed(1), h: +el.getBoundingClientRect().height.toFixed(1), color: hex(rgbOf(s.backgroundColor)), headW: parseFloat(head.width), headH: parseFloat(head.height), headBorder: head.borderLeftColor };
      })(),
      notchStates: notches.reduce((acc, n) => {
        const key = n.dataset.state || "none";
        acc[key] = acc[key] || { count: 0, color: hex(rgbOf(getComputedStyle(n).backgroundColor)) };
        acc[key].count += 1;
        return acc;
      }, {}),
      cards: nodes.map((n, i) => ({
        pos: n.dataset.pos,
        id: n.dataset.stage,
        mark: n.dataset.mark,
        title: (n.querySelector(".pflow-title")?.textContent || "").replace(/\\s+/g, " ").trim(),
        titleLines: lineCount(n.querySelector(".pflow-title")),
        titleWords: titleWords[i],
        words: wordsPerCard[i],
        detail: detailTexts[i],
        detailLines: lineCount(detailEls[i]),
        detailClamped: detailEls[i] ? detailEls[i].scrollHeight > detailEls[i].clientHeight + 1 : false,
        rect: rectOf(n),
        bg: hex(rgbOf(getComputedStyle(n).backgroundColor)),
        border: hex(rgbOf(getComputedStyle(n).borderTopColor)),
        titleColor: hex(rgbOf(getComputedStyle(n.querySelector(".pflow-title")).color)),
        titleWeight: getComputedStyle(n.querySelector(".pflow-title")).fontWeight,
        dotColor: hex(rgbOf(getComputedStyle(n.querySelector(".pflow-dot")).backgroundColor)),
        fullyVisible: visible.includes(n),
      })),
      areas: { card: Math.round(cardBox.width * cardBox.height), drawing: trackArea, chrome: chromeArea, scrollClip: Math.round(sr.width * sr.height) },
      ink,
      page: { bodyBg: hex(rgbOf(getComputedStyle(document.body).backgroundColor)), colorScheme: getComputedStyle(document.documentElement).colorScheme },
    };
  })()`);

const sha = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 12);

const ledger = {
  startedAt: new Date().toISOString(),
  // The ledger is committed, so it names the tree it measured relative to itself: an absolute worktree path is
  // stale the moment the tree is released, and the repo's absolute-paths gate refuses one.
  tree: ".",
  head: (() => { try { return execFileSync("git", ["-C", TREE, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch { return null; } })(),
  version: JSON.parse(readFileSync(path.join(TREE, "package.json"), "utf8")).version,
  viewports: VIEWPORTS,
  fixtures: FIXTURES.map((f) => ({ key: f.key, id: f.def.id, title: f.def.title, stages: f.stages, kind: f.def.kind, next: f.def.next ?? null })),
  shots: [],
  notes: [],
  errors: [],
};

const say = (line) => console.log(line);

const settle = (page, ms = 260) => page.waitForTimeout(ms);

const pw = loadPlaywright();
if (!pw) {
  console.log(notRun("the pipeline flow dialog was not photographed", "Playwright is not installed in this checkout (tools/browser.mjs could not load it)."));
  process.exit(2);
}

const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-pipeline-readability-"));
mkdirSync(path.join(dir, "logs"), { recursive: true });
mkdirSync(SHOTS, { recursive: true });
const pipelinesFile = path.join(dir, "pipelines.json");
const catalogue = {};
for (const f of FIXTURES) catalogue[f.def.id] = f.def;
writeFileSync(pipelinesFile, JSON.stringify({ version: 1, pipelines: catalogue }, null, 1), "utf8");

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
ledger.panel = panel.base;
say(`panel ${panel.base} — throwaway config in ${dir}`);

const openDefinition = async (page, id) => {
  await page.goto(panel.base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#job-prompt", { state: "visible", timeout: 30_000 });
  await openSettingsGroup(page, "pipeline");
  await page.waitForFunction(() => {
    const el = document.getElementById("pipeline-summary");
    return el && !/reading/i.test(el.textContent || "");
  }, null, { timeout: 20_000 });
  await page.selectOption("#pipeline-select", id);
  await page.waitForSelector("#pipeline-editor:not([hidden]) .pipeline-stage", { timeout: 15_000 });
  await page.click("#pipeline-flow-open");
  await openFlowEdit(page);
  // The modal measures after layout: wait for the count element to have been read, not for a timer.
  await page.waitForFunction(() => {
    const el = document.querySelector("[data-pflow-count]");
    return el && (el.textContent || "").trim().length > 0;
  }, null, { timeout: 10_000, polling: 50 });
  await settle(page);
};

const shootCard = async (page, file) => {
  const el = await page.$("#pipeline-modal-card");
  if (!el) throw new Error("no pipeline-modal-card");
  await el.screenshot({ path: file });
  return file;
};

const closeModal = async (page) => {
  await page.keyboard.press("Escape");
  await page.waitForSelector("#pipeline-modal", { state: "hidden", timeout: 5_000 });
};

// Position mode, opened through the page's own API with the arguments a caller passes: the bundle adapter plus a
// position record. This is the supporting drawing for what the catalogue dialog cannot show, not a second reading
// of route A.
const openPosition = async (page) => {
  await page.goto(panel.base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#job-prompt", { state: "visible", timeout: 30_000 });
  await page.evaluate(
    ([bundle, position]) => {
      const flow = window.PipelineFlow.fromBundle(bundle);
      window.PipelineModal.open({
        mode: "position",
        title: bundle.title,
        subtitle: "at the review",
        pipeline: flow,
        position,
        preview: false,
        facts: [
          { label: "pipeline", value: bundle.id },
          { label: "kind", value: bundle.kind },
          { label: "stages", value: String(flow.stages.length) },
          { label: "next", value: "end of the chain" },
        ],
      });
    },
    [POSITION_BUNDLE, POSITION],
  );
  await page.waitForSelector("#pipeline-modal:not([hidden]) .pflow-node", { timeout: 15_000 });
  await settle(page, 500);
};

try {
  await withBrowser(
    async ({ withPage }) => {
      for (const viewport of VIEWPORTS) {
        for (const fixture of FIXTURES) {
          await withPage(
            async ({ page }) => {
              const errors = [];
              page.on("pageerror", (e) => errors.push(String(e.message || e)));
              page.on("console", (m) => { if (m.type() === "error" && !/favicon/i.test(m.text())) errors.push(m.text()); });
              await openDefinition(page, fixture.def.id);
              const n = String(FIXTURES.indexOf(fixture) + 1).padStart(2, "0");
              const file = path.join(SHOTS, `${n}-${fixture.key}-${viewport.width}.png`);
              await shootCard(page, file);
              const m = await measure(page);
              ledger.shots.push({ file: path.basename(file), fixture: fixture.key, defId: fixture.def.id, viewport, mode: "edit", ...m, pageErrors: errors });
              say(`  ${fixture.key.padEnd(8)} ${viewport.width}  ${m.visibleStages}/${m.stages} stages, ${m.visibleNotches}/${m.notches.length} notches, col ${m.colW}px, card ${Math.round(m.card.w)}×${Math.round(m.card.h)}, count "${m.count.text}"`);
              await closeModal(page);
            },
            { viewport },
          );
        }

        // The supporting position-mode drawing at the seven-stage length.
        await withPage(
          async ({ page }) => {
            const errors = [];
            page.on("pageerror", (e) => errors.push(String(e.message || e)));
            page.on("console", (m) => { if (m.type() === "error" && !/favicon/i.test(m.text())) errors.push(m.text()); });
            await openPosition(page);
            const file = path.join(SHOTS, `09-seven-position-${viewport.width}.png`);
            await shootCard(page, file);
            const m = await measure(page);
            ledger.shots.push({ file: path.basename(file), fixture: "seven", defId: POSITION_BUNDLE.id, viewport, mode: "position", ...m, pageErrors: errors });
            say(`  position ${viewport.width}  ${m.stages} stages, ${m.arcs.length} arc(s), current "${m.position}", marks ${[...new Set(m.marks)].join("/")}`);
          },
          { viewport },
        );
      }
    },
    { viewport: VIEWPORTS[0], deviceScaleFactor: 1 },
  );
} catch (e) {
  ledger.errors.push(String((e && e.stack) || e));
  console.log(`FAIL  the capture threw: ${String((e && e.stack) || e).split("\n").slice(0, 8).join("\n      ")}`);
} finally {
  await panel.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

// A cheap integrity line: the PNG bytes the page was asked to draw, hashed, so a reader can prove a later edit
// changed the picture.
for (const shot of ledger.shots) {
  try {
    shot.sha256 = sha(readFileSync(path.join(SHOTS, shot.file))).slice(0, 12);
  } catch {
    /* a shot that did not land is already an error in the ledger */
  }
}

ledger.finishedAt = new Date().toISOString();
ledger.shotCount = ledger.shots.length;
writeFileSync(JSON_OUT, JSON.stringify(ledger, null, 1), "utf8");

say(`\nSHOTS  ${SHOTS} (${ledger.shotCount} files)`);
say(`LEDGER ${JSON_OUT}`);
if (ledger.errors.length) {
  say(`ERRORS ${ledger.errors.length}`);
  process.exit(1);
}
