#!/usr/bin/env node
// Playwright round 5A — BOTH routes into the pipeline flow chart, judged on whether everything is VISIBLE and
// whether it looks CLEAN. The two verdicts are separate, and a pass with an ugly drawing is a fail.
//
// ROUND 5B (the visual layer) runs this same harness with --strict and fixes the lines 5A left red on purpose: C1 now
// measures the width policy's CENTRING (the capped track is centred, so the space beside it matches on both sides and
// the 599 px dead band is gone), C3 the titles' contrast, C8 that nothing is painted past the track's own right edge,
// and the closing gate's notch is inside the scroller instead of on an 18 px stub past it.
//
// ROUND 5C (the count and the fit control) answers the six lines 5B left red — the thirteen-stage case. Its unfitted
// drawing scrolls by design, so the unfitted state is judged on what it OWES the reader: the count it prints (N1 at
// the start, N2 after the reader scrolls, both built from the measured rects rather than read back) and the control it
// offers (K1: Tab reaches it inside the dialog and it paints a ring). The FITTED drawing is then judged on visibility
// like every other case (V1-V6, C1-C4, C8), so the case goes green by the reader's own press rather than by deleting
// the lines — and N3 keeps the count honest while fitted: "all 13 stages and 13 notches in view". A pass that hides
// the count is a fail.
//
//   node tools/verify-pipeline-flow-visible.mjs                       # print the judgement, write shots to %TEMP%
//   node tools/verify-pipeline-flow-visible.mjs --shots <dir>         # where the screenshots go
//   node tools/verify-pipeline-flow-visible.mjs --json <file>         # the raw ledger
//   node tools/verify-pipeline-flow-visible.mjs --strict              # a FAILED judge line exits 1 as well
//
// WHY THIS IS NOT A RED GATE ON MAIN. The round's order is "fix nothing": this harness lands beside the gate that
// already pins the chart's behaviour (`tools/verify-pipeline-flow.mjs`, 49 checks), and its own job is to measure a
// drawing nobody changed. So the CONTRACT checks (both routes open the right dialog in the right mode, Escape closes
// the dialog and not Settings, focus is trapped and returns, a drag out of the card does not dismiss it) must pass,
// and the JUDGE lines record the visibility/cleanliness verdict with the number that decided it. The run exits 0 when
// every case was measured and the contract holds; `--strict` turns the judge verdicts into failures too, which is
// what the round that FIXES these findings will gate on.
//
// WHAT IS DRIVEN, per viewport (1280x800 and 1821x700), both at once:
//
//   route B  Settings > Pipeline. The dropdown selects a definition; `open the flow` opens the dialog in EDIT mode.
//            Four definitions: the seed's `local` (1 stage), `investigate` (2), `sefl-review-loop` (7), and a 13-stage
//            definition written into the catalogue for the thirteen-stage acceptance case.
//   route A  A queue row's ⇢ press (`[data-as-qflow]`, public/assistant.js:2286) opens the SAME dialog in POSITION
//            mode from the task's own answer plus the bundled pipeline: three stages done, one current, one not
//            reached, the gate as a notch and the loop as one arc labelled with its cap.
//
// The judge reads geometry, not impressions: every rect against its scroller's client box, the track's dead band
// against the card, pairwise intersections, the arc's ends against the stage centres it joins, the painted colours
// as contrast ratios, and the computed outline of whatever the keyboard focused.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPlaywright, notRun, openSettingsGroup, withBrowser } from "./browser.mjs";
import { freePort, startPanel } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SHOTS = path.resolve(opt("--shots", path.join(os.tmpdir(), "wtgui-pipeline-flow-visible")));
const JSON_OUT = opt("--json");
const STRICT = argv.includes("--strict");

let checks = 0;
let failures = 0;
let judged = 0;
let judgedBad = 0;
const out = { tree: TREE, checks: [], judgement: [], pageErrors: [], consoleErrors: [], viewports: [], errors: [] };

// A CONTRACT check: what the round does not change and must not break. Failing one exits 1.
const check = (ok, label, detail = "") => {
  checks += 1;
  if (!ok) failures += 1;
  out.checks.push({ ok: Boolean(ok), label, detail: String(detail ?? "") });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};
const equal = (label, actual, expected) => check(JSON.stringify(actual) === JSON.stringify(expected), label, `got ${JSON.stringify(actual)}`);

// A JUDGE line: the round's own verdict on the drawing. It is recorded with the number that decided it.
const judge = (id, ok, label, detail = "") => {
  judged += 1;
  if (!ok) judgedBad += 1;
  out.judgement.push({ id, ok: Boolean(ok), label, detail: String(detail ?? "") });
  console.log(`${ok ? "JUDGE PASS" : "JUDGE FAIL"}  ${id} ${label}${detail ? ` — ${detail}` : ""}`);
};
const note = (text) => console.log(`      ${text}`);

// ---- the fixture ------------------------------------------------------------------------------------------------
const stage = (n, title) => ({
  id: `S${n}`,
  title,
  prompt: `Work stage ${n}: ${title}.`,
  artifact: { id: `artifact-${n}`, path: `out/${n}.json`, schema: "out/1", writer: `worker-${n}` },
});

const BUNDLE = {
  bundleVersion: 1,
  name: "poc-flow",
  pipelines: [
    {
      id: "poc-flow",
      title: "POC flow",
      stages: [0, 1, 2, 3, 4].map((n) => stage(n, ["Intake and charter", "Scope it", "Shape the contract", "Build it", "Hand it over"][n])),
      gates: [
        {
          id: "g2",
          name: "contract signed",
          after: "S2",
          artifact: "artifact-2",
          decider: "reader",
          decision: { id: "d2", path: "decisions/2.json", schema: "decision/1", writer: "gate-2", outcomes: ["go", "no-go"] },
        },
      ],
      handoffs: [
        { id: "h1", from: "S0", to: "S1", artifact: "artifact-0", kind: "sequence" },
        { id: "h2", from: "S1", to: "S2", artifact: "artifact-1", kind: "sequence" },
        { id: "h3", from: "S2", to: "S3", artifact: "artifact-2", kind: "sequence" },
        { id: "h4", from: "S3", to: "S4", artifact: "artifact-3", kind: "sequence" },
        { id: "h5", from: "S4", to: "S2", artifact: "artifact-4", kind: "loop", cap: "2 rounds" },
      ],
    },
  ],
};

// The thirteen-stage case the architecture review's acceptance names. The seed's own `sefl-review-loop` is the seven.
const THIRTEEN = {
  id: "acceptance-thirteen",
  kind: "turnover",
  title: "Acceptance thirteen",
  description: "Thirteen stages, to judge whether a long definition stays visible and readable.",
  stages: Array.from({ length: 13 }, (_, i) => ({ id: `st${i + 1}`, title: `Stage ${i + 1} — ${["intake", "scope", "shape", "build", "check", "review", "hand over", "archive", "audit", "sign off", "publish", "follow up", "close"][i]}`, prompt: `work ${i + 1}`, exit: { check: "clean" } })),
};

const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-pipeline-visible-"));
const logs = path.join(dir, "logs");
mkdirSync(path.join(logs, "assistants", "assistant-1"), { recursive: true });
mkdirSync(SHOTS, { recursive: true });
const bundleFile = path.join(logs, "pipeline-bundle.json");
writeFileSync(bundleFile, JSON.stringify(BUNDLE, null, 1), "utf8");
writeFileSync(
  path.join(logs, "assistants", "assistant-1", "queue.json"),
  JSON.stringify(
    { version: 3, nextId: 8, tasks: [{ id: 7, title: "carry the contract", state: "running", thread: null, threads: [], files: [], pipelineRun: { pipeline: "poc-flow", stage: "S3", enteredAt: new Date(Date.now() - 2.5 * 3_600_000).toISOString() } }] },
    null,
    1,
  ),
  "utf8",
);
const pipelinesFile = path.join(dir, "pipelines.json");
writeFileSync(pipelinesFile, JSON.stringify({ version: 1, pipelines: { [THIRTEEN.id]: THIRTEEN } }, null, 1), "utf8");

const pw = loadPlaywright();
if (!pw) {
  console.log(notRun("the flow was not judged in a browser", "Playwright is not installed in this checkout (tools/browser.mjs could not load it)."));
  process.exit(2);
}

const port = await freePort();
const panel = await startPanel({
  dir,
  port,
  root: TREE,
  keep: true,
  config: {
    pipelineBundleFile: bundleFile,
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
note(`panel ${panel.base} on ${TREE}`);
out.panel = panel.base;

const finish = async (code) => {
  await panel.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  if (JSON_OUT) writeFileSync(path.resolve(JSON_OUT), JSON.stringify(out, null, 1), "utf8");
  console.log(`\nCONTRACT ${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ""}`);
  console.log(`JUDGE    ${judged - judgedBad}/${judged} judge lines pass${judgedBad ? `, ${judgedBad} FAILED — the drawing is not finished` : ""}`);
  process.exit(code);
};

// Everything the round judges, read once from the DOM. No impression is stored here: rects, computed styles,
// scroll boxes and the painted colours, all in CSS pixels at the current viewport.
const measure = (page) =>
  page.evaluate(() => {
    const r = (el) => {
      const b = el.getBoundingClientRect();
      return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), right: +b.right.toFixed(1), bottom: +b.bottom.toFixed(1) };
    };
    const card = document.getElementById("pipeline-modal-card");
    const body = card.querySelector(".pmodal-body");
    const scroll = card.querySelector(".pflow-scroll");
    const track = card.querySelector(".pflow-track");
    const legend = card.querySelector(".pflow-legend");
    const nodes = [...card.querySelectorAll(".pflow-node")];
    const cr = card.getBoundingClientRect();
    const br = body.getBoundingClientRect();
    const sr = scroll.getBoundingClientRect();
    const tr = track.getBoundingClientRect();
    const colour = (el, prop = "color") => (el ? getComputedStyle(el)[prop] : null);
    const rgb = (value) => {
      const m = String(value || "").match(/rgba?\(([^)]+)\)/);
      return m ? m[1].split(",").slice(0, 3).map((v) => Number(v.trim())) : null;
    };
    const lum = (c) => {
      if (!c) return null;
      const lin = c.map((v) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    };
    const contrast = (a, b) => {
      const la = lum(rgb(a));
      const lb = lum(rgb(b));
      if (la == null || lb == null) return null;
      return +(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)).toFixed(2));
    };
    const first = nodes[0];
    const firstTitle = first && first.querySelector(".pflow-title");
    const note = card.querySelector(".pmodal-note");
    return {
      vw: innerWidth,
      vh: innerHeight,
      kicker: card.querySelector(".pmodal-kicker")?.textContent || "",
      title: document.getElementById("pipeline-modal-title")?.textContent || "",
      sub: card.querySelector(".pmodal-sub")?.textContent || "",
      facts: card.querySelector(".pmodal-facts")?.textContent?.replace(/\s+/g, " ").trim() || "",
      note: note ? note.textContent : "",
      mode: document.getElementById("pipeline-modal").dataset.mode,
      card: r(card),
      body: r(body),
      bodyScroll: { cw: body.clientWidth, ch: body.clientHeight, sw: body.scrollWidth, sh: body.scrollHeight },
      scroll: r(scroll),
      scrollBox: { cw: scroll.clientWidth, sw: scroll.scrollWidth, ch: scroll.clientHeight, sh: scroll.scrollHeight, overflowX: getComputedStyle(scroll).overflowX },
      scrollLeft: scroll.scrollLeft,
      track: r(track),
      nodes: nodes.map((n) => {
        const title = n.querySelector(".pflow-title");
        const num = n.querySelector(".pflow-n");
        const dot = n.querySelector(".pflow-dot");
        const rect = r(n);
        return {
          id: n.dataset.stage,
          mark: n.dataset.mark,
          pos: n.dataset.pos,
          rect,
          title: title
            ? {
                text: title.textContent,
                fs: getComputedStyle(title).fontSize,
                cw: title.clientWidth,
                sw: title.scrollWidth,
                rect: r(title),
                colour: colour(title),
                bg: colour(n, "backgroundColor"),
                contrast: contrast(colour(title), colour(n, "backgroundColor")),
              }
            : null,
          num: num ? { text: num.textContent.trim(), rect: r(num) } : null,
          dot: dot ? { rect: r(dot), bg: colour(dot, "backgroundColor") } : null,
          // `r()` names the left edge `x` (it is a rect, not a DOMRect); reading `rect.left` here silently made every
          // LEFT-side clip look visible, which is why the count's scrolled case is judged on both sides.
          outOfScroller: rect.right > sr.right + 0.5 || rect.x < sr.left - 0.5,
          outOfCard: rect.right > cr.right + 0.5 || rect.bottom > cr.bottom + 0.5,
          // Which way a clipped stage is: the side the reader has to scroll toward. Used by the count's own judge,
          // never by the renderer (the drawing does not read this).
          outSide: rect.right > sr.right + 0.5 ? "right" : rect.x < sr.left - 0.5 ? "left" : "",
          inScroller: rect.x < sr.right - 0.5 && rect.right > sr.left + 0.5,
        };
      }),
      notches: [...card.querySelectorAll(".pflow-notch")].map((nn) => ({
        gate: nn.dataset.gate,
        rect: r(nn),
        outOfScroller: r(nn).right > sr.right + 0.5 || r(nn).x < sr.left - 0.5 || r(nn).bottom > cr.bottom + 0.5,
        outSide: r(nn).right > sr.right + 0.5 ? "right" : r(nn).x < sr.left - 0.5 ? "left" : "",
      })),
      arcs: [...card.querySelectorAll(".pflow-arc")].map((a) => ({
        from: a.dataset.from,
        to: a.dataset.to,
        cap: a.dataset.cap,
        rect: r(a),
        label: { text: a.textContent.trim(), rect: r(a.querySelector(".pflow-arc-label")) },
        aboveTrack: r(a).bottom <= tr.top + 1,
        outOfCard: r(a).right > cr.right + 0.5 || r(a).top < cr.top - 0.5,
      })),
      keys: [...card.querySelectorAll(".pflow-key")].map((k) => ({ mark: k.dataset.mark, text: k.textContent.trim(), rect: r(k), inCard: r(k).right <= cr.right + 0.5 && r(k).bottom <= cr.bottom + 0.5 })),
      // The count and the `fit` control, as a reader meets them: the sentence the scroller prints, and whether the
      // control is offered, how it is labelled and what outline the keyboard focus paints on it.
      view: {
        fitMode: card.querySelector(".pflow")?.dataset.fit || "",
        count: card.querySelector("[data-pflow-count]")?.textContent || "",
        out: card.querySelector("[data-pflow-count]")?.dataset.out || "",
        row: (() => {
          const el = card.querySelector("[data-pflow-status]");
          return el ? { hidden: el.hidden, text: el.textContent.replace(/\s+/g, " ").trim() } : null;
        })(),
        fit: (() => {
          const el = card.querySelector("[data-pflow-fit]");
          if (!el) return null;
          const s = getComputedStyle(el);
          return { label: el.textContent.trim(), hidden: el.hidden, display: s.display, rect: r(el), outline: `${s.outlineStyle}/${s.outlineWidth}` };
        })(),
      },
      deadRight: +(br.right - tr.right).toFixed(1),
      deadLeft: +(tr.left - br.left).toFixed(1),
      // The arcs are placed as percentages of THIS layer, so it must be the track's own box in both regimes — the capped,
      // centred track and a track that fills the card. They were two independently-capped boxes before the width policy.
      arcsLayer: card.querySelector(".pflow-arcs") ? r(card.querySelector(".pflow-arcs")) : null,
      titleFs: firstTitle ? getComputedStyle(firstTitle).fontSize : null,
      titleContrast: firstTitle ? contrast(colour(firstTitle), colour(first, "backgroundColor")) : null,
      cardFits: cr.top >= -0.5 && cr.left >= -0.5 && cr.right <= innerWidth + 0.5 && cr.bottom <= innerHeight + 0.5,
      focus: {
        tag: document.activeElement?.tagName || "",
        id: document.activeElement?.id || "",
        cls: String(document.activeElement?.className || ""),
        inCard: card.contains(document.activeElement),
        outlineStyle: document.activeElement ? getComputedStyle(document.activeElement).outlineStyle : null,
        outlineWidth: document.activeElement ? getComputedStyle(document.activeElement).outlineWidth : null,
        outlineColor: document.activeElement ? getComputedStyle(document.activeElement).outlineColor : null,
      },
    };
  });

const marks = (m) => (m ? m.nodes.map((n) => `${n.id}:${n.mark}`) : []);
const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
const centre = (r) => +(r.x + r.w / 2).toFixed(1);
const cardClip = (m, viewport) => ({
  x: Math.max(0, m.card.x),
  y: Math.max(0, m.card.y),
  width: Math.min(m.card.w, viewport.width - Math.max(0, m.card.x)),
  height: Math.min(m.card.h, viewport.height - Math.max(0, m.card.y)),
});

// The sentence the scroller owes its reader, rebuilt HERE from the measured rects rather than read back from the
// element: a count that disagrees with the drawing has to fail this run, not restate itself.
const countsOf = (m) => ({
  stages: m.nodes.filter((n) => n.outOfScroller),
  notches: m.notches.filter((n) => n.outOfScroller),
  totalStages: m.nodes.length,
  totalNotches: m.notches.length,
  overflow: m.scrollBox.sw > m.scrollBox.cw + 1,
});
const expectedCountText = (m) => {
  const c = countsOf(m);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  if (!c.stages.length && !c.notches.length) {
    return `all ${plural(c.totalStages, "stage", "stages")}${c.totalNotches ? ` and ${plural(c.totalNotches, "notch", "notches")}` : ""} in view`;
  }
  const shown = m.nodes.filter((n) => !n.outOfScroller).map((n) => Number(n.pos));
  const range = shown.length ? `showing stages ${Math.min(...shown)}–${Math.max(...shown)} of ${c.totalStages} — ` : "";
  const said = [`${c.stages.length} of ${c.totalStages} ${c.totalStages === 1 ? "stage" : "stages"}`];
  if (c.totalNotches) said.push(`${c.notches.length} of ${c.totalNotches} ${c.totalNotches === 1 ? "notch" : "notches"}`);
  return `${range}${said.join(" and ")} out of view`;
};

const openRouteB = async (page, id) => {
  await page.selectOption("#pipeline-select", id);
  await page.waitForTimeout(180);
  await page.click("#pipeline-flow-open");
  await page.waitForSelector("#pipeline-modal:not([hidden]) .pflow-node");
  await page.waitForTimeout(180);
};
const openRouteA = async (page) => {
  await page.click('#as-queue .as-task[data-as-qrow="7"] [data-as-qflow]');
  await page.waitForFunction(
    () => {
      const m = document.getElementById("pipeline-modal");
      return m && !m.hidden && m.dataset.mode === "position" && m.querySelectorAll(".pflow-node").length > 0;
    },
    null,
    { timeout: 20_000, polling: 60 },
  );
  await page.waitForTimeout(180);
};
const closeModal = async (page) => {
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.getElementById("pipeline-modal").hidden === true, null, { timeout: 5_000 });
  await page.waitForTimeout(120);
};

// Judge every stage, notch, legend mark and token of one drawing against the box that shows it.
const judgeVisibility = (m, where) => {
  const outNodes = m.nodes.filter((n) => n.outOfScroller);
  const outNotches = m.notches.filter((n) => n.outOfScroller);
  const hidden = m.scrollBox.sw - m.scrollBox.cw;
  judge("V1", outNodes.length === 0, `${where}: every stage is inside the scroller`, `${m.nodes.length} stages, ${outNodes.length} out (${outNodes.map((n) => n.id).join(",") || "none"})`);
  judge("V2", outNotches.length === 0, `${where}: every gate notch is inside the scroller`, `${m.notches.length} notches, ${outNotches.length} out (${outNotches.map((n) => n.gate).join(",") || "none"})`);
  judge("V3", hidden <= 1, `${where}: the drawing does not overflow its scroller`, `scrollWidth ${m.scrollBox.sw} vs clientWidth ${m.scrollBox.cw}${hidden > 1 ? ` — ${hidden} px hidden at scrollLeft ${m.scrollLeft}` : ""}`);
  judge("V4", m.keys.length === 4 && m.keys.every((k) => k.inCard), `${where}: every legend mark is inside the card`, m.keys.map((k) => `${k.mark}${k.inCard ? "" : "(out)"}`).join(" "));
  judge("V5", m.cardFits, `${where}: the card itself fits the viewport`, `card ${m.card.w}x${m.card.h} at ${m.card.x},${m.card.y} in ${m.vw}x${m.vh}`);
  const pairs = [];
  for (let i = 0; i < m.nodes.length; i += 1) for (let j = i + 1; j < m.nodes.length; j += 1) if (overlap(m.nodes[i].rect, m.nodes[j].rect) > 0.5) pairs.push(`${m.nodes[i].id}/${m.nodes[j].id}`);
  const arcClash = m.arcs.filter((a) => m.nodes.some((n) => overlap(a.rect, n.rect) > 0.5) || m.nodes.some((n) => overlap(a.label.rect, n.rect) > 0.5));
  judge("V6", pairs.length === 0 && arcClash.length === 0, `${where}: nothing paints under another`, pairs.length ? `stages overlap: ${pairs.join(", ")}` : arcClash.length ? `an arc or its label is over a stage` : "no stage/arc/card overlap");
  // An arc's geometry is a percentage of the arcs layer, so that layer has to BE the track's box. It used to be a second
  // box with its own 240 px cap and no centring, which is how a loop could land over the wrong stage.
  if (m.arcsLayer) {
    judge(
      "V7",
      Math.abs(m.arcsLayer.x - m.track.x) <= 0.5 && Math.abs(m.arcsLayer.w - m.track.w) <= 0.5,
      `${where}: the arcs layer is the track's own box`,
      `arcs ${m.arcsLayer.x}+${m.arcsLayer.w} vs track ${m.track.x}+${m.track.w}`,
    );
  }
};

const judgeClean = (m, where) => {
  // The width policy (docs/reviews/pipeline-flow-integration-plan.md, C5) is `clamp(96, (usable - (n-1)*gap)/n, 400)`
  // with the capped track CENTRED. A two-stage drawing is 826 px in a 1094 px scroller with the leftover split evenly:
  // that is a symmetric margin, not the 599 px dead band a left-aligned 506 px track left. So the line judges what the
  // reader sees — the space beside the track is the same on both sides — and that the track uses the card up to its own
  // ceiling: from two stages up it is at least 70% of the body; a one-stage definition is ONE card, judged by sitting at
  // the 400 px ceiling rather than by how much empty card surrounds a single box.
  const symmetric = Math.abs(m.deadLeft - m.deadRight) <= 8;
  const widest = m.nodes.length ? Math.max(...m.nodes.map((n) => n.rect.w)) : 0;
  const fills = m.nodes.length >= 2 ? m.track.w >= 0.7 * m.body.w : Math.abs(widest - 400) <= 1;
  judge(
    "C1",
    symmetric && fills,
    `${where}: the track is centred and fills the card (no dead band)`,
    `dead space ${m.deadLeft} px left, ${m.deadRight} px right of a ${m.track.w} px track in a ${m.body.w} px body; widest column ${widest} px`,
  );
  const small = m.nodes.filter((n) => n.title && parseFloat(n.title.fs) < 11);
  judge("C2", small.length === 0, `${where}: no stage title is set below 11 px`, m.titleFs ? `title ${m.titleFs}` : "no title");
  const lowContrast = m.nodes.filter((n) => n.title && n.title.contrast != null && n.title.contrast < 4.5);
  judge("C3", lowContrast.length === 0, `${where}: stage titles clear 4.5:1`, lowContrast.length ? `${lowContrast.length}/${m.nodes.length} below AA, worst ${Math.min(...lowContrast.map((n) => n.title.contrast))}:1` : `worst ${Math.min(...m.nodes.map((n) => n.title && n.title.contrast).filter((v) => v != null))}:1`);
  const clipped = m.nodes.filter((n) => n.title && n.title.sw > n.title.cw + 1);
  judge("C4", clipped.length === 0, `${where}: no stage title is truncated`, clipped.length ? clipped.map((n) => `${n.id} ${n.title.sw}>${n.title.cw}`).join(", ") : "every title fits its column");
  // The last stage's gate used to be drawn on an 18 px stub at `left: 100%`, i.e. past the track: the drawing overflowed
  // its scroller by 15 px and the notch it labelled was clipped away. The line is the direct measurement of that defect,
  // and it is measured only while the drawing FITS (a long definition's columns legitimately run past the visible box;
  // V1-V3 judge the scrolling case).
  const scrolling = m.scrollBox.sw > m.scrollBox.cw + 1;
  const past = [...m.nodes.map((n) => ({ what: n.id, right: n.rect.right })), ...m.notches.map((n) => ({ what: `notch ${n.gate}`, right: n.rect.right })), ...m.arcs.map((a) => ({ what: `arc ${a.from}→${a.to}`, right: a.rect.right }))].filter((x) => x.right > m.track.right + 0.5);
  judge(
    "C8",
    scrolling || past.length === 0,
    `${where}: nothing is painted past the track's own right edge`,
    scrolling ? `not judged: the track scrolls (${m.scrollBox.sw} > ${m.scrollBox.cw})` : past.length ? past.map((x) => `${x.what} at ${x.right}`).join(", ") : `track ends at ${m.track.right}`,
  );
};

let browserRun = null;
try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 1821, height: 700 }]) {
    const label = `${viewport.width}x${viewport.height}`;
    out.viewports.push(label);
    const verdict = await withBrowser(
      async ({ page, pageErrors }) => {
        page.setDefaultTimeout(20_000);
        await page.goto(panel.base, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("#job-prompt", { state: "visible", timeout: 30_000 });

        // ---- route B, edit mode, from Settings > Pipeline ---------------------------------------------------
        console.log(`\n== ${label} · route B — Settings > Pipeline > a definition > open the flow ==`);
        await openSettingsGroup(page, "pipeline");
        await page.waitForFunction(() => {
          const el = document.getElementById("pipeline-summary");
          return el && !/reading/.test(el.textContent || "");
        }, null, { timeout: 20_000 });
        const options = await page.$$eval("#pipeline-select option", (els) => els.map((el) => el.value));
        check(options.length >= 4, "the merged catalogue is in the dropdown", `${options.length} definitions: ${options.slice(0, 9).join(", ")}${options.length > 9 ? "…" : ""}`);

        const cases = [
          { id: "local", expect: 1, shots: true },
          { id: "investigate", expect: 2, shots: true },
          { id: "turnover", expect: 3, shots: false },
          { id: "sefl-review-loop", expect: 7, shots: true },
          // The thirteen-stage acceptance: its own branch below takes both states (unfitted for the count, fitted for
          // visibility), so it does not use the generic card shot.
          { id: THIRTEEN.id, expect: 13, shots: false, fit: true },
        ];
        for (const one of cases) {
          if (!options.includes(one.id)) {
            check(false, `the catalogue carries ${one.id}`, options.join(", "));
            continue;
          }
          await openRouteB(page, one.id);
          const m = await measure(page);
          const defined = await page.evaluate(async (id) => (await (await fetch("/api/pipelines")).json()).pipelines[id], one.id);
          check(m.mode === "edit", `${one.id}: the dialog is in edit mode`, m.mode);
          check(/pipeline flow · editing/.test(m.kicker), `${one.id}: the dialog says it is editing`, m.kicker);
          check(m.title === (defined.title || one.id), `${one.id}: it names the definition`, m.title);
          equal(`${one.id}: every stage of the definition is drawn, in order`, m.nodes.map((n) => n.id), defined.stages.map((s) => s.id));
          equal(`${one.id}: every stage's exit check is a notch`, m.notches.map((n) => n.gate), defined.stages.map((s) => `exit:${s.id}`));
          equal(`${one.id}: a definition has no position`, m.nodes.map((n) => n.mark), defined.stages.map(() => "not-reached"));
          check(m.nodes.length === one.expect, `${one.id}: the drawn stage count is the declared one`, `${m.nodes.length} drawn, ${one.expect} declared`);
          check(!m.sub, `${one.id}: no position subtitle on a definition`, m.sub || "(none)");

          if (one.fit) {
            // ---- the thirteen-stage acceptance: the count, the control, and the fitted drawing --------------------
            // The unfitted drawing legitimately scrolls; what it owes the reader is the COUNT. The fitted drawing is
            // then judged on visibility like every other case, so the six red lines this case carried are answered by
            // the control the plan's C8 names rather than by deleting the lines.
            const c = countsOf(m);
            check(c.overflow, `${one.id}: the drawing scrolls unfitted — the case the control exists for`, `${m.scrollBox.sw} > ${m.scrollBox.cw}, ${c.stages.length} stages and ${c.notches.length} notches out`);
            judge("N1", m.view.count === expectedCountText(m), `${one.id} unfitted: the scroller counts what is out of view`, `"${m.view.count}" against ${c.stages.length} of ${c.totalStages} stages and ${c.notches.length} of ${c.totalNotches} notches measured out`);
            check(Boolean(m.view.fit && !m.view.fit.hidden), `${one.id}: a fit control is offered while stages are out of view`, m.view.fit ? `"${m.view.fit.label}" ${m.view.fit.rect.w}x${m.view.fit.rect.h}` : "no control");
            await page.screenshot({ path: path.join(SHOTS, `${label}-route-b-${one.id}-unfitted.png`), clip: cardClip(m, viewport) });
            // The count follows the reader: scroll to the far end and read the sentence again.
            await page.evaluate(() => {
              const s = document.querySelector("#pipeline-modal-card .pflow-scroll");
              s.scrollLeft = s.scrollWidth;
            });
            await page.waitForTimeout(220);
            const scrolled = await measure(page);
            judge(
              "N2",
              scrolled.view.count === expectedCountText(scrolled) && scrolled.view.count !== m.view.count,
              `${one.id} scrolled: the count follows the reader`,
              `start "${m.view.count}" → at scrollLeft ${scrolled.scrollLeft} "${scrolled.view.count}" (expected "${expectedCountText(scrolled)}": ${countsOf(scrolled).stages.length} stages and ${countsOf(scrolled).notches.length} notches out of the box ${scrolled.scroll.x}..${scrolled.scroll.right})`,
            );
            // Keyboard reach: Tab from the card, without leaving the dialog, must land on the control, and the ring
            // has to be painted on it. The scroller is its own tab stop (Chromium makes a scrollable region
            // focusable), so the press is the third stop, not the second — the run reads where it lands, not a guess.
            const tabbed = [];
            for (let i = 0; i < 8; i += 1) {
              await page.keyboard.press("Tab");
              const at = await page.evaluate(() => {
                const card = document.getElementById("pipeline-modal-card");
                const el = document.activeElement;
                const s = el ? getComputedStyle(el) : null;
                return {
                  inCard: Boolean(el && card.contains(el)),
                  fit: Boolean(el && el.hasAttribute && el.hasAttribute("data-pflow-fit")),
                  tag: el?.tagName || "",
                  outline: s ? `${s.outlineStyle}/${s.outlineWidth}` : "",
                };
              });
              tabbed.push(at);
              if (at.fit) break;
            }
            const atFit = tabbed.find((t) => t.fit);
            check(tabbed.every((t) => t.inCard) && Boolean(atFit), `${one.id}: Tab reaches the fit control and stays in the dialog`, tabbed.map((t) => `${t.tag}${t.fit ? "(fit)" : ""}`).join(" > "));
            judge("K1", Boolean(atFit && !/none\/0px/.test(atFit.outline)), `${one.id}: the fit control draws a ring when the keyboard reaches it`, atFit ? atFit.outline : "never reached");
            await page.keyboard.press("Enter");
            await page.waitForTimeout(220);
            const fitted = await measure(page);
            check(fitted.view.fitMode === "1", `${one.id}: the press fits the drawing`, `data-fit="${fitted.view.fitMode}"`);
            judge("N3", fitted.view.count === expectedCountText(fitted) && !/out of view/.test(fitted.view.count), `${one.id} fitted: the count still says what is in view`, `"${fitted.view.count}" over ${fitted.scrollBox.sw}/${fitted.scrollBox.cw}`);
            judgeVisibility(fitted, `route B/${one.id} fitted`);
            judgeClean(fitted, `route B/${one.id} fitted`);
            await page.screenshot({ path: path.join(SHOTS, `${label}-route-b-${one.id}-fitted.png`), clip: cardClip(fitted, viewport) });
            // the closing notch, at the fitted scale: the last gap, the last stage and the card's right edge
            const last = fitted.nodes[fitted.nodes.length - 1];
            const prev = fitted.nodes[fitted.nodes.length - 2] || last;
            if (last) {
              const left = Math.max(0, prev.rect.x - 24);
              const top = Math.max(0, last.rect.y - 26);
              const width = Math.min(viewport.width - left, fitted.card.right - left);
              const height = Math.min(viewport.height - top, last.rect.bottom - top + 14);
              await page.screenshot({ path: path.join(SHOTS, `${label}-route-b-${one.id}-fitted-last-notch.png`), clip: { x: left, y: top, width, height } });
            }
            // and the press restores the readable columns: the control is a toggle, not a one-way zoom.
            await page.keyboard.press("Enter");
            await page.waitForTimeout(220);
            const restored = await measure(page);
            check(restored.view.fitMode === "0" && restored.scrollBox.sw > restored.scrollBox.cw + 1, `${one.id}: pressing it again restores the readable columns`, `data-fit="${restored.view.fitMode}", ${restored.scrollBox.sw}/${restored.scrollBox.cw}`);
            check(restored.nodes.every((n) => n.mark === "not-reached"), `${one.id}: the marks survive the fit and the restore`, restored.nodes.map((n) => n.mark).join(","));
            out[`${label}/route-b/${one.id}-fitted`] = fitted;
            out[`${label}/route-b/${one.id}-scrolled`] = scrolled;
          } else {
            judgeVisibility(m, `route B/${one.id}`);
            judgeClean(m, `route B/${one.id}`);
          }
          if (one.shots) {
            const clip = cardClip(m, viewport);
            await page.screenshot({ path: path.join(SHOTS, `${label}-route-b-${one.id}.png`), clip });
            // the seven-stage case: the right edge, where the last stage's own notch is drawn
            if (one.id === "sefl-review-loop") {
              // the last gap, the last stage, and the card's right edge: a notch, then none
              const last = m.nodes[m.nodes.length - 1];
              const prev = m.nodes[m.nodes.length - 2] || last;
              const left = Math.max(0, prev.rect.x - 24);
              const top = Math.max(0, last.rect.y - 26);
              const width = Math.min(viewport.width - left, m.card.right - left);
              const height = Math.min(viewport.height - top, last.rect.bottom - top + 14);
              await page.screenshot({ path: path.join(SHOTS, `${label}-route-b-7-last-notch.png`), clip: { x: left, y: top, width, height } });
            }
          }
          out[`${label}/route-b/${one.id}`] = m;
          await closeModal(page);
        }

        // ---- route B's dialog behaviour: Esc against the window it opens over, focus, and a drag out --------
        console.log(`\n== ${label} · route B — Esc, focus trap, return, and a drag that must not dismiss ==`);
        await openRouteB(page, "investigate");
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => document.getElementById("pipeline-modal").hidden === true, null, { timeout: 5_000 });
        const afterEsc = await page.evaluate(() => ({
          closed: document.getElementById("pipeline-modal").hidden,
          settingsOpen: !document.getElementById("settings").classList.contains("hidden"),
          focusId: document.activeElement?.id || "",
          locked: document.body.classList.contains("pipeline-modal-open"),
        }));
        check(afterEsc.closed, "Escape closes the dialog");
        check(afterEsc.settingsOpen, "and does NOT close the Settings window underneath");
        check(afterEsc.focusId === "pipeline-flow-open", "focus returns to the control that opened it", afterEsc.focusId || "(none)");
        check(!afterEsc.locked, "and the page is unlocked");

        await openRouteB(page, "investigate");
        const tabbed = [];
        for (let i = 0; i < 8; i += 1) {
          await page.keyboard.press("Tab");
          tabbed.push(
            await page.evaluate(() => {
              const card = document.getElementById("pipeline-modal-card");
              return card.contains(document.activeElement) ? "in" : `out:${document.activeElement?.tagName || ""}`;
            }),
          );
        }
        equal("eight Tabs never leave the card", [...new Set(tabbed)], ["in"]);
        const ringed = await page.evaluate(() =>
          [...document.querySelectorAll("#pipeline-modal-card button, #pipeline-modal-card select, #pipeline-modal-card input")].map((el) => {
            el.focus();
            const s = getComputedStyle(el);
            return `${el.tagName}:${s.outlineStyle}/${s.outlineWidth}`;
          }),
        );
        check(ringed.some((r) => !/none\/0px/.test(r)), "a keyboard-reached control draws an outline", ringed.join(" "));

        const drag = await page.evaluate(() => {
          const c = document.getElementById("pipeline-modal-card").getBoundingClientRect();
          return { x: c.x + 40, y: c.y + 40, bx: 6, by: 6 };
        });
        await page.mouse.move(drag.x, drag.y);
        await page.mouse.down();
        await page.mouse.move(drag.bx, drag.by, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(200);
        check(!(await page.evaluate(() => document.getElementById("pipeline-modal").hidden)), "a press that begins inside the card and ends on the backdrop does NOT dismiss it");
        await page.mouse.click(drag.bx, drag.by);
        await page.waitForFunction(() => document.getElementById("pipeline-modal").hidden === true, null, { timeout: 5_000 });
        const afterBackdrop = await page.evaluate(() => ({ closed: document.getElementById("pipeline-modal").hidden, settingsOpen: !document.getElementById("settings").classList.contains("hidden") }));
        check(afterBackdrop.closed, "a press that begins and ends on the backdrop closes it");
        await page.screenshot({ path: path.join(SHOTS, `${label}-after-backdrop.png`) });
        judge("C7", afterBackdrop.settingsOpen, "the backdrop press leaves the Settings window it was opened over", afterBackdrop.settingsOpen ? "Settings still open" : "Settings was closed by the same press");
        if (!afterBackdrop.settingsOpen) {
          await page.click("#btn-settings");
          await page.waitForTimeout(250);
          await openSettingsGroup(page, "pipeline");
          await page.waitForFunction(() => {
            const el = document.getElementById("pipeline-summary");
            return el && !/reading/.test(el.textContent || "");
          }, null, { timeout: 20_000 });
        }

        // the focus ring, captured where a reader would see it
        await openRouteB(page, "investigate");
        await page.keyboard.press("Tab");
        const focusShot = await page.evaluate(() => {
          const r = document.activeElement.getBoundingClientRect();
          return { x: Math.max(0, r.x - 16), y: Math.max(0, r.y - 16), width: Math.min(180, r.width + 32), height: r.height + 32 };
        });
        await page.screenshot({ path: path.join(SHOTS, `${label}-focus.png`), clip: { x: focusShot.x, y: focusShot.y, width: focusShot.width, height: focusShot.height } });
        const focusRing = await page.evaluate(() => {
          const s = getComputedStyle(document.activeElement);
          return { tag: document.activeElement.tagName, outline: `${s.outlineStyle}/${s.outlineWidth}`, colour: s.outlineColor };
        });
        judge("C5", !/none\/0px/.test(focusRing.outline), `the focused control shows a ring (${focusRing.tag})`, `${focusRing.outline} ${focusRing.colour}`);
        out[`${label}/focus`] = { ringed, focusRing };
        await closeModal(page);
        await page.click("#btn-settings");
        await page.waitForTimeout(250);

        // ---- route A, position mode, from a queue row -------------------------------------------------------
        console.log(`\n== ${label} · route A — the queue row's ⇢ press ==`);
        await page.click("#btn-assistant");
        await page.waitForSelector("#assistant:not([hidden])");
        await page.click('#as-subtabs [data-as-subtab="queue"]');
        await page.waitForSelector("#as-queue:not(.hidden)");
        await page.waitForFunction(() => document.querySelectorAll("#as-queue .as-task").length === 1, null, { timeout: 20_000 });
        const press = await page.$eval('#as-queue .as-task[data-as-qrow="7"] [data-as-qflow]', (b) => ({ tag: b.tagName, title: b.getAttribute("title") || "", own: b.dataset.asQown, task: b.dataset.asQflow }));
        check(press.own === "assistant-1" && press.task === "7", "the queue row carries a flow press of its own", JSON.stringify({ own: press.own, task: press.task }));
        check(Boolean(press.title), "and it says what it opens", press.title.slice(0, 80));

        await openRouteA(page);
        const pos = await measure(page);
        check(pos.mode === "position", "the same dialog is in position mode", pos.mode);
        check(/pipeline flow · position/.test(pos.kicker), "and says it is a position", pos.kicker);
        check(pos.title === "#7 carry the contract", "it names the task", pos.title);
        check(/4 of 5/.test(pos.sub), "its subtitle names the position", pos.sub);
        equal("five stages, left to right", pos.nodes.map((n) => n.id), ["S0", "S1", "S2", "S3", "S4"]);
        equal("three done, one current, one not reached", marks(pos), ["S0:done", "S1:done", "S2:done", "S3:current", "S4:not-reached"]);
        equal("the gate that ends S2 is one notch", pos.notches.map((n) => n.gate), ["g2"]);
        equal("the capped loop is one arc, labelled with its cap only", pos.arcs.map((a) => ({ cap: a.cap, label: a.label.text, from: a.from, to: a.to })), [{ cap: "2 rounds", label: "2 rounds", from: "S4", to: "S2" }]);
        check(pos.arcs[0]?.aboveTrack, "the arc is drawn above the track", pos.arcs[0] ? `arc bottom ${pos.arcs[0].rect.bottom} vs track top ${pos.track.y}` : "no arc");
        equal("the legend counts the marks", pos.keys.map((k) => `${k.mark}:${k.text}`), ["not-reached:not reached 1", "current:current 1", "done:done 3", "refused:refused"]);
        const token = pos.nodes.find((n) => n.mark === "current");
        check(Boolean(token && token.num && token.dot && token.dot.bg !== "rgba(0, 0, 0, 0)"), "the current stage carries a position token and a painted dot", token ? `${token.id} #${token.num?.text} dot ${token.dot?.bg}` : "no current stage");

        judgeVisibility(pos, "route A");
        judgeClean(pos, "route A");
        const source = pos.nodes.find((n) => n.id === pos.arcs[0]?.from);
        const arcsOk = pos.arcs.map((a) => {
          const from = pos.nodes.find((n) => n.id === a.from);
          const to = pos.nodes.find((n) => n.id === a.to);
          return { id: `${a.from}→${a.to}`, left: from ? +(a.rect.x - centre(to.rect)).toFixed(1) : null, right: from ? +(a.rect.right - centre(from.rect)).toFixed(1) : null };
        });
        const offCentre = arcsOk.filter((a) => Math.abs(a.left) > 3 || Math.abs(a.right) > 3);
        judge("C6", offCentre.length === 0, "route A: each arc's ends sit on the stage centres it joins", offCentre.length ? arcsOk.map((a) => `${a.id} left ${a.left} px, right ${a.right} px off the centre`).join("; ") : arcsOk.map((a) => `${a.id} on centre`).join("; "));
        out[`${label}/route-a`] = pos;
        out[`${label}/route-a-note`] = pos.note;

        // the card shot for route A
        await page.screenshot({ path: path.join(SHOTS, `${label}-route-a.png`), clip: { x: Math.max(0, pos.card.x), y: Math.max(0, pos.card.y), width: Math.min(pos.card.w, viewport.width - Math.max(0, pos.card.x)), height: Math.min(pos.card.h, viewport.height - Math.max(0, pos.card.y)) } });
        // the arc, on its own, where a reader looks for it
        const arc = pos.arcs[0];
        if (arc) {
          const left = Math.max(0, arc.rect.x - 30);
          const top = Math.max(0, arc.label.rect.y - 8);
          const width = Math.min(pos.card.right - left, arc.rect.right - arc.rect.x + 60);
          const height = Math.min(viewport.height - top, pos.track.bottom - top + 6);
          await page.screenshot({ path: path.join(SHOTS, `${label}-route-a-arc.png`), clip: { x: left, y: top, width, height } });
        }

        // route A's own close: one Esc, and the caret goes back to the row's press
        await closeModal(page);
        const backToRow = await page.evaluate(() => String(document.activeElement?.className || ""));
        check(/as-qflow/.test(backToRow), "route A: Escape closes the dialog and hands focus back to the ⇢ press", backToRow || "(none)");

        out.pageErrors.push(...pageErrors);
        check(pageErrors.length === 0, `${label}: no page error`, pageErrors.slice(0, 3).join(" | "));
        return failures;
      },
      { viewport },
    );
    browserRun = verdict == null ? browserRun : verdict;
  }

  out.consoleErrors.push(...out.pageErrors);
  check(out.pageErrors.length === 0, "no page error in any viewport", out.pageErrors.slice(0, 3).join(" | "));
} catch (e) {
  failures += 1;
  out.errors.push(String((e && e.stack) || e));
  console.log(`FAIL  the run threw: ${String((e && e.stack) || e).split("\n").slice(0, 6).join("\n      ")}`);
} finally {
  console.log(`\nSCREENSHOTS  ${SHOTS}`);
  await finish(failures || (STRICT && judgedBad) ? 1 : 0);
}
