#!/usr/bin/env node
// Usability round — the pipeline flow measured as a READER reads it, not as a test asserts it.
//
// The visual rounds (5A, 5B) asked "is every box inside the scroller" and "is the drawing clean". Those lines pass
// now. This round asks the next question, the one the reader answered "unusable" to: standing in front of the
// drawing, can I tell where a stage sits, what it does, who acts in it, what its gate checks, what a refusal or a
// loop does, and how long a stage has run?
//
// So it measures CONTENT and PROPORTION, not containment: the words the drawing actually prints, their font size,
// the ink area against the card's own area, how many stages are on screen at once, and which of the six questions the
// data itself can answer at all. Nothing here is a fix; public/pipeline-flow.js, public/style.css and public/app.js
// are held by another branch and are not touched.
//
//   node tools/verify-pipeline-flow-usability.mjs                    # print the reading, write shots to %TEMP%
//   node tools/verify-pipeline-flow-usability.mjs --shots <dir>      # where the screenshots go
//   node tools/verify-pipeline-flow-usability.mjs --json <file>      # the raw ledger
//
// It exits 0 whenever every case was measured and the page stayed clean. The findings are DATA, not a red gate: this
// round is not allowed to fix them, so it must not pretend a measurement is a contract.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPlaywright, notRun, openSettingsGroup, withBrowser, openFlowEdit } from "./browser.mjs";
import { freePort, startPanel } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const TREE = path.resolve(opt("--root", REPO));
const SHOTS = path.resolve(opt("--shots", path.join(os.tmpdir(), "wtgui-pipeline-usability")));
const JSON_OUT = opt("--json");

// `tree` is provenance, not a measurement: it names where the harness was pointed, and that must read the same on
// every disk. Repo-relative and POSIX, so a run in this checkout writes "." wherever it is checked out; a --root
// outside the repo is a relative path too, and a different drive (where path.relative answers absolute) is labelled
// rather than published. The console line below still prints the real path for the operator.
const treeLabel = (() => {
  const rel = path.relative(REPO, TREE);
  if (!rel) return ".";
  return path.isAbsolute(rel) ? "<outside the repo>" : rel.split(path.sep).join("/");
})();

const out = { tree: treeLabel, viewports: [], cases: {}, pageErrors: [], consoleErrors: [], errors: [] };
const say = (line = "") => console.log(line);

// ---- the fixtures ------------------------------------------------------------------------------------------------
// Route A's bundle: the studio shape, with one real gate (name, decider, decision record, outcomes) and one capped
// loop, so the reader questions about gates and loops have something to be answered WITH or LEFT OUT.
// The thirteen-stage vocabulary is used by both fixtures (the definition and the long bundle), so it is defined first.
const WORDS = ["intake", "scope", "shape", "build", "check", "review", "hand over", "archive", "audit", "sign off", "publish", "follow up", "close"];
const stage = (n, title) => ({
  id: `S${n}`,
  title,
  prompt: `Work stage ${n}: ${title}. Read the tree, do the smallest thing that moves the artifact forward, and stop when the exit check passes.`,
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
    {
      // The long pipeline: a run parked at stage 11 of 13, so the reader question "can I see where I am" has a hard
      // case. The loop crosses six columns and carries a cap, which is the widest arc the drawing has to place.
      id: "long-flow",
      title: "Long flow",
      stages: WORDS.map((w, i) => ({
        id: `st${i + 1}`,
        title: `Stage ${i + 1} — ${w}`,
        prompt: `Work stage ${i + 1}, ${w}: read what arrived, produce the artifact, write down what you changed and what you ruled out, and stop when the exit check passes.`,
        artifact: { id: `long-artifact-${i + 1}`, path: `out/long-${i + 1}.json`, schema: "out/1", writer: `worker-${i + 1}` },
      })),
      gates: [
        {
          id: "L1",
          name: "scope agreed",
          after: "st6",
          artifact: "long-artifact-6",
          decider: "architect",
          decision: { id: "dL1", path: "decisions/long-1.json", schema: "decision/1", writer: "gate-L1", outcomes: ["go", "no-go"] },
        },
      ],
      handoffs: [
        ...WORDS.slice(0, 12).map((_, i) => ({ id: `LH${i}`, from: `st${i + 1}`, to: `st${i + 2}`, artifact: `long-artifact-${i + 1}`, kind: "sequence" })),
        { id: "L10", from: "st12", to: "st6", artifact: "long-artifact-12", kind: "loop", cap: "3 rounds" },
      ],
    },
  ],
};

// The thirteen-stage definition the acceptance names. Each stage carries the prose a real definition carries
// (a prompt and a parameterised exit check), so "what the drawing leaves out" is measured against text that exists.
const THIRTEEN = {
  id: "acceptance-thirteen",
  kind: "turnover",
  title: "Acceptance thirteen",
  description: "Thirteen stages, to judge whether a long definition stays visible and readable.",
  stages: Array.from({ length: 13 }, (_, i) => ({
    id: `st${i + 1}`,
    title: `Stage ${i + 1} — ${WORDS[i]}`,
    prompt: `Work stage ${i + 1}, ${WORDS[i]}: read what arrived, produce the artifact, write down what you changed and what you ruled out, and stop when the exit check passes.`,
    exit: i % 3 === 2 ? { check: "file-exists", path: `docs/stage-${i + 1}.md` } : { check: "commits", min: 1 },
  })),
};

const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-pipeline-usability-"));
const logs = path.join(dir, "logs");
mkdirSync(path.join(logs, "assistants", "assistant-1"), { recursive: true });
mkdirSync(SHOTS, { recursive: true });
const bundleFile = path.join(logs, "pipeline-bundle.json");
writeFileSync(bundleFile, JSON.stringify(BUNDLE, null, 1), "utf8");
writeFileSync(
  path.join(logs, "assistants", "assistant-1", "queue.json"),
  JSON.stringify(
    {
      version: 3,
      nextId: 9,
      tasks: [
        { id: 7, title: "carry the contract", state: "running", thread: null, threads: [], files: [], pipelineRun: { pipeline: "poc-flow", stage: "S3", enteredAt: new Date(Date.now() - 2.5 * 3_600_000).toISOString() } },
        { id: 8, title: "the long run", state: "running", thread: null, threads: [], files: [], pipelineRun: { pipeline: "long-flow", stage: "st11", enteredAt: new Date(Date.now() - 6 * 3_600_000).toISOString() } },
      ],
    },
    null,
    1,
  ),
  "utf8",
);
const pipelinesFile = path.join(dir, "pipelines.json");
writeFileSync(pipelinesFile, JSON.stringify({ version: 1, pipelines: { [THIRTEEN.id]: THIRTEEN } }, null, 1), "utf8");

const pw = loadPlaywright();
if (!pw) {
  console.log(notRun("the flow was not read in a browser", "Playwright is not installed in this checkout (tools/browser.mjs could not load it)."));
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
say(`panel ${panel.base} on ${TREE}`);

const finish = async (code) => {
  await panel.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  if (JSON_OUT) writeFileSync(path.resolve(JSON_OUT), JSON.stringify(out, null, 1), "utf8");
  say(`\nSHOTS  ${SHOTS}`);
  process.exit(code);
};

// ---- the reading -------------------------------------------------------------------------------------------------
// Every number below is read from the rendered page in CSS pixels. Ink area is the union of the text's own line
// boxes (a Range), not the block box: a flex item stretches to the column, so its rect is not the text.
const measure = (page, meta) =>
  page.evaluate((meta) => {
    const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
    const words = (s) => (norm(s) ? norm(s).split(" ").length : 0);
    const r = (el) => {
      const b = el.getBoundingClientRect();
      return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), right: +b.right.toFixed(1), bottom: +b.bottom.toFixed(1) };
    };
    const ink = (el) => {
      if (!el) return null;
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()].filter((x) => x.width > 0 && x.height > 0);
      if (!rects.length) return { w: 0, h: 0, area: 0, lines: 0, rect: null };
      const left = Math.min(...rects.map((x) => x.left));
      const right = Math.max(...rects.map((x) => x.right));
      const top = Math.min(...rects.map((x) => x.top));
      const bottom = Math.max(...rects.map((x) => x.bottom));
      return {
        w: +(right - left).toFixed(1),
        h: +(bottom - top).toFixed(1),
        area: +rects.reduce((sum, x) => sum + x.width * x.height, 0).toFixed(1),
        lines: rects.length,
        rect: { x: +left.toFixed(1), y: +top.toFixed(1), w: +(right - left).toFixed(1), h: +(bottom - top).toFixed(1) },
      };
    };
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
    const card = document.getElementById("pipeline-modal-card");
    const body = card.querySelector(".pmodal-body");
    const scroll = card.querySelector(".pflow-scroll");
    const track = card.querySelector(".pflow-track");
    const nodes = [...card.querySelectorAll(".pflow-node")];
    const cr = card.getBoundingClientRect();
    const sr = scroll.getBoundingClientRect();
    const tr = track.getBoundingClientRect();
    const drawing = card.querySelector(".pmodal-flow") || card;
    const drawingText = norm(drawing.textContent);
    const drawingWords = words(drawingText);
    // The prose a definition or a bundle holds is supplied by the caller (meta.totalWords) because the page's copy of
    // it is not the drawing's copy: the flow is normalised before it is drawn, and the normaliser drops most of it.
    const nodeRows = nodes.map((n) => {
      const title = n.querySelector(".pflow-title");
      const num = n.querySelector(".pflow-n");
      const art = n.querySelector(".pflow-art");
      const rect = r(n);
      const titleInk = ink(title);
      const numInk = ink(num);
      const artInk = ink(art);
      const areas = [titleInk, numInk, artInk].filter(Boolean).map((x) => x.area);
      const inkArea = +areas.reduce((a, b) => a + b, 0).toFixed(1);
      const nodeArea = +(rect.w * rect.h).toFixed(1);
      const notch = n.querySelector(".pflow-notch");
      return {
        id: n.dataset.stage,
        mark: n.dataset.mark,
        pos: n.dataset.pos,
        rect,
        titleAttr: n.getAttribute("title") || "",
        title: title
          ? {
              text: norm(title.textContent),
              words: words(title.textContent),
              fs: getComputedStyle(title).fontSize,
              lh: getComputedStyle(title).lineHeight,
              rect: r(title),
              ink: titleInk,
              colour: getComputedStyle(title).color,
              bg: getComputedStyle(n).backgroundColor,
              contrast: contrast(getComputedStyle(title).color, getComputedStyle(n).backgroundColor),
              truncated: title.scrollWidth > title.clientWidth + 1,
            }
          : null,
        num: num ? { text: norm(num.textContent), fs: getComputedStyle(num).fontSize, ink: numInk } : null,
        art: art ? { text: norm(art.textContent), fs: getComputedStyle(art).fontSize, ink: artInk } : null,
        inkArea,
        nodeArea,
        emptyRatio: nodeArea ? +(1 - inkArea / nodeArea).toFixed(3) : null,
        notch: notch ? { visibleText: norm(notch.textContent), hasAria: Boolean(notch.getAttribute("aria-label")), ariaLen: (notch.getAttribute("aria-label") || "").length } : null,
        fullyInside: rect.x >= sr.left - 0.5 && rect.right <= sr.right + 0.5,
        partlyInside: rect.right > sr.left && rect.x < sr.right,
      };
    });
    const visibleNodes = nodeRows.filter((n) => n.fullyInside);
    return {
      ...meta,
      vw: innerWidth,
      vh: innerHeight,
      mode: document.getElementById("pipeline-modal").dataset.mode,
      kicker: norm(card.querySelector(".pmodal-kicker")?.textContent),
      title: norm(document.getElementById("pipeline-modal-title")?.textContent),
      sub: norm(card.querySelector(".pmodal-sub")?.textContent),
      facts: norm(card.querySelector(".pmodal-facts")?.textContent),
      note: norm(card.querySelector(".pmodal-note")?.textContent),
      card: r(card),
      body: r(body),
      scroll: r(scroll),
      scrollBox: { cw: scroll.clientWidth, sw: scroll.scrollWidth, ch: scroll.clientHeight, sh: scroll.scrollHeight },
      scrollLeft: scroll.scrollLeft,
      track: r(track),
      trackHeight: +tr.height.toFixed(1),
      nodes: nodeRows,
      drawingText,
      drawingWords,
      stageWords: +nodeRows.reduce((a, n) => a + (n.title?.words || 0) + (n.num ? 1 : 0) + (n.art ? n.art.text.split(" ").length : 0), 0),
      legendWords: +[...card.querySelectorAll(".pflow-key")].reduce((a, k) => a + norm(k.textContent).split(" ").filter(Boolean).length, 0),
      keys: [...card.querySelectorAll(".pflow-key")].map((k) => ({ mark: k.dataset.mark, text: norm(k.textContent), fs: getComputedStyle(k).fontSize })),
      notches: [...card.querySelectorAll(".pflow-notch")].map((x) => ({
        gate: x.dataset.gate,
        name: x.dataset.gateName,
        state: x.dataset.state,
        aria: x.getAttribute("aria-label") || "",
        title: x.getAttribute("title") || "",
        visibleText: norm(x.textContent),
        rect: r(x),
      })),
      links: [...card.querySelectorAll(".pflow-link")].map((x) => r(x)),
      arcs: [...card.querySelectorAll(".pflow-arc")].map((a) => ({
        loop: a.dataset.loop,
        from: a.dataset.from,
        to: a.dataset.to,
        cap: a.dataset.cap,
        label: norm(a.textContent),
        labelFs: getComputedStyle(a.querySelector(".pflow-arc-label")).fontSize,
        rect: r(a),
        aria: a.getAttribute("aria-label") || "",
      })),
      // Which of the reader's questions the DRAWING can answer in words it prints. These are substring tests on the
      // drawing's text, with the gate/actor strings the caller supplies; a hit means the reader can read it without
      // hovering, opening devtools, or leaving the picture.
      answerable: {
        gateName: meta.gateNames.filter((s) => s && drawingText.toLowerCase().includes(s.toLowerCase())),
        decider: meta.deciders.filter((s) => s && drawingText.toLowerCase().includes(s.toLowerCase())),
        decisionPath: meta.decisionPaths.filter((s) => s && drawingText.includes(s)),
        officialOutcome: meta.outcomes.filter((s) => s && drawingText.toLowerCase().includes(s.toLowerCase())),
        duration: /(\d+\s*(?:h|m|s)\b|\d{1,2}:\d{2})/i.test(drawingText),
      },
      visibleStages: visibleNodes.length,
      partlyVisibleStages: nodeRows.filter((n) => n.partlyInside && !n.fullyInside).length,
      hiddenPx: Math.max(0, scroll.scrollWidth - scroll.clientWidth),
      marksFrom: card.querySelector(".pflow")?.dataset.marksFrom || "",
      currentVisible: nodeRows.some((n) => n.mark === "current" && n.fullyInside),
      fit: card.querySelector(".pflow")?.dataset.fit || "",
      status: (() => {
        const s = card.querySelector("[data-pflow-status]");
        const b = s && s.querySelector("[data-pflow-fit]");
        return s
          ? { hidden: Boolean(s.hidden), text: norm(s.querySelector("[data-pflow-count]")?.textContent), button: b ? norm(b.textContent) : null }
          : null;
      })(),
      /** total ink area of the visible cards' text, against their own area */
      visibleInk: +visibleNodes.reduce((a, n) => a + n.inkArea, 0).toFixed(1),
      visibleArea: +visibleNodes.reduce((a, n) => a + n.nodeArea, 0).toFixed(1),
    };
  }, meta);

const cardsHtml = (m) => m.nodes.map((n) => `${n.id} ${n.rect.w}x${n.rect.h} ink ${n.inkArea} (${Math.round((1 - n.emptyRatio) * 100)}% filled) title ${JSON.stringify(n.title?.text)} ${n.title?.fs} ${n.title?.words}w`).join("\n      ");
// How far an arc's two ends sit from the centres of the stages it claims to join. Zero is correct; a non-zero number
// is the drawing pointing at a different stage than the data names.
const arcOffsets = (m) =>
  m.arcs.map((a) => {
    const from = m.nodes.find((n) => n.id === a.from);
    const to = m.nodes.find((n) => n.id === a.to);
    return {
      loop: `${a.from}→${a.to}`,
      left: from && to ? +(a.rect.x - (to.rect.x + to.rect.w / 2)).toFixed(1) : null,
      right: from && to ? +(a.rect.right - (from.rect.x + from.rect.w / 2)).toFixed(1) : null,
      correctWidth: from && to ? +((from.rect.x + from.rect.w / 2) - (to.rect.x + to.rect.w / 2)).toFixed(1) : null,
      drawnWidth: a.rect.w,
    };
  });

const openRouteB = async (page, id) => {
  await page.selectOption("#pipeline-select", id);
  await page.waitForTimeout(160);
  await page.click("#pipeline-flow-open");
  await openFlowEdit(page);
  await page.waitForTimeout(160);
};
const openRouteA = async (page, taskId = 7) => {
  await page.click(`#as-queue .as-task[data-as-qrow="${taskId}"] [data-as-qflow]`);
  await page.waitForFunction(
    () => {
      const m = document.getElementById("pipeline-modal");
      return m && !m.hidden && m.dataset.mode === "position" && m.querySelectorAll(".pflow-node").length > 0;
    },
    null,
    { timeout: 20_000, polling: 60 },
  );
  await page.waitForTimeout(160);
};
const closeModal = async (page) => {
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.getElementById("pipeline-modal").hidden === true, null, { timeout: 5_000 });
  await page.waitForTimeout(100);
};
const shotCard = async (page, m, file) => {
  const clip = { x: Math.max(0, m.card.x), y: Math.max(0, m.card.y), width: Math.min(m.card.w, m.vw - Math.max(0, m.card.x)), height: Math.min(m.card.h, m.vh - Math.max(0, m.card.y)) };
  await page.screenshot({ path: path.join(SHOTS, file), clip });
};
const shotPage = async (page, file) => page.screenshot({ path: path.join(SHOTS, file) });

// The words a definition holds, counted the way a reader would have to read them if the drawing printed them.
const definitionWords = (def) => {
  const parts = [def.title, def.description, def.kind, def.next];
  for (const s of def.stages || []) parts.push(s.title, s.prompt, s.exit?.check, ...Object.entries(s.exit || {}).filter(([k]) => k !== "check").map(([, v]) => String(v)));
  return { total: parts.filter(Boolean).join(" ").split(/\s+/).filter(Boolean).length, prompts: (def.stages || []).reduce((a, s) => a + String(s.prompt || "").split(/\s+/).filter(Boolean).length, 0) };
};
const bundleWords = (p) => {
  const parts = [p.title];
  for (const s of p.stages) parts.push(s.title, s.prompt, s.artifact?.id);
  for (const g of p.gates || []) parts.push(g.name, g.decider, g.decision?.path, ...(g.decision?.outcomes || []));
  for (const h of p.handoffs || []) parts.push(h.cap);
  return parts.filter(Boolean).join(" ").split(/\s+/).filter(Boolean).length;
};

let failure = null;
try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 1821, height: 700 }]) {
    const label = `${viewport.width}x${viewport.height}`;
    out.viewports.push(label);
    const verdict = await withBrowser(
      async ({ page, pageErrors }) => {
        page.setDefaultTimeout(20_000);
        await page.goto(panel.base, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("#job-prompt", { state: "visible", timeout: 30_000 });
        await openSettingsGroup(page, "pipeline");
        await page.waitForFunction(() => {
          const el = document.getElementById("pipeline-summary");
          return el && !/reading/.test(el.textContent || "");
        }, null, { timeout: 20_000 });
        const catalogue = await (await page.request.get(`${panel.base}/api/pipelines`)).json();
        const options = Object.keys(catalogue.pipelines || {});

        const cases = [
          { id: "investigate", expect: 2, shots: true },
          { id: "sefl-review-loop", expect: 7, shots: true },
          { id: "acceptance-thirteen", expect: 13, shots: true },
        ];
        for (const one of cases) {
          if (!options.includes(one.id)) {
            say(`MISSING  ${label} ${one.id} is not in the catalogue (${options.join(", ")})`);
            continue;
          }
          const def = catalogue.pipelines[one.id];
          const words = definitionWords(def);
          await openRouteB(page, one.id);
          const meta = {
            case: `B/${one.id}`,
            stagesDeclared: one.expect,
            totalWords: words.total,
            promptWords: words.prompts,
            gateNames: (def.stages || []).map((s) => s.exit?.check),
            deciders: [],
            decisionPaths: (def.stages || []).map((s) => s.exit?.path).filter(Boolean),
            outcomes: [],
          };
          const m = await measure(page, meta);
          out.cases[`${label}/${one.id}`] = m;
          say(`\n== ${label} · route B · ${one.id} (${one.expect} stages, edit mode)`);
          say(`   card ${m.card.w}x${m.card.h} · track ${m.track.w}x${m.trackHeight} · scroller ${m.scrollBox.cw}/${m.scrollBox.sw} · hidden ${m.hiddenPx}px`);
          say(`   visible stages ${m.visibleStages}/${m.nodes.length} (${m.partlyVisibleStages} partly) · drawing prints ${m.drawingWords} words (${m.stageWords} on cards, ${m.legendWords} in the legend) of ${m.totalWords} in the definition (${Math.round((m.drawingWords / Math.max(1, m.totalWords)) * 100)}%)`);
          say(`   count: ${m.status ? (m.status.hidden ? "(row hidden)" : `"${m.status.text}" · button ${JSON.stringify(m.status.button)}`) : "(no row)"}`);
          say(`   gate names visible as words: ${m.answerable.gateName.length ? m.answerable.gateName.join(", ") : "NONE"} · notches ${m.notches.length}`);
          say(`   cards:\n      ${cardsHtml(m)}`);
          if (one.shots) {
            await shotPage(page, `${label}-b-${one.id}-page.png`);
            await shotCard(page, m, `${label}-b-${one.id}.png`);
            if (m.hiddenPx > 0) {
              await page.evaluate(() => {
                const s = document.querySelector(".pflow-scroll");
                s.scrollLeft = s.scrollWidth;
              });
              await page.waitForTimeout(120);
              const end = await measure(page, meta);
              out.cases[`${label}/${one.id}-end`] = end;
              say(`   at the far end: scrollLeft ${end.scrollLeft} · first stage on screen ${end.nodes.find((n) => n.partlyInside)?.id || "-"} · stages fully visible ${end.visibleStages}`);
              await shotCard(page, end, `${label}-b-${one.id}-end.png`);
              await page.evaluate(() => {
                const s = document.querySelector(".pflow-scroll");
                s.scrollLeft = 0;
              });
            }
            // round 5C's fit press: the same grid one step narrower, all stages in view. Measured, not assumed.
            const fitBtn = await page.$("[data-pflow-fit]");
            if (m.hiddenPx > 0 && fitBtn) {
              await fitBtn.click();
              await page.waitForTimeout(260);
              const fitted = await measure(page, meta);
              out.cases[`${label}/${one.id}-fit`] = fitted;
              say(`   fitted: ${fitted.status?.text || "(no count)"} · visible ${fitted.visibleStages}/${fitted.nodes.length} · columns ${fitted.nodes[0]?.rect.w} px · hidden ${fitted.hiddenPx}px`);
              await shotCard(page, fitted, `${label}-b-${one.id}-fit.png`);
              await page.click("[data-pflow-fit]");
              await page.waitForTimeout(180);
            }
          }
          await closeModal(page);
        }

        // ---- route A: a queue row, position mode ------------------------------------------------------------
        say(`\n== ${label} · route A — the queue row's ⇢ press (position mode)`);
        await page.click("#btn-settings");
        await page.waitForTimeout(200);
        await page.click("#btn-assistant");
        await page.waitForSelector("#assistant:not([hidden])");
        await page.click('#as-subtabs [data-as-subtab="queue"]');
        await page.waitForSelector("#as-queue:not(.hidden)");
        await page.waitForFunction(() => document.querySelectorAll("#as-queue .as-task").length === 2, null, { timeout: 20_000 });
        await openRouteA(page);
        const p = BUNDLE.pipelines[0];
        const metaA = {
          case: "A/position",
          stagesDeclared: p.stages.length,
          totalWords: bundleWords(p),
          promptWords: p.stages.reduce((a, s) => a + s.prompt.split(/\s+/).length, 0),
          gateNames: p.gates.map((g) => g.name),
          deciders: p.gates.map((g) => g.decider),
          decisionPaths: p.gates.map((g) => g.decision?.path).filter(Boolean),
          outcomes: p.gates.flatMap((g) => g.decision?.outcomes || []),
        };
        const a = await measure(page, metaA);
        a.arcOffsets = arcOffsets(a);
        out.cases[`${label}/A-position`] = a;
        say(`   mode ${a.mode} · ${JSON.stringify(a.title)} · sub ${JSON.stringify(a.sub)}`);
        say(`   facts: ${a.facts}`);
        say(`   note: ${a.note}`);
        say(`   marks rule: ${a.marksFrom} · current stage on screen: ${a.currentVisible ? "yes" : "NO"}`);
        say(`   cards:\n      ${cardsHtml(a)}`);
        say(`   gate name visible: ${a.answerable.gateName.length ? a.answerable.gateName.join(", ") : "NONE"} · decider visible: ${a.answerable.decider.length ? a.answerable.decider.join(", ") : "NONE"} · decision path visible: ${a.answerable.decisionPath.length ? a.answerable.decisionPath.join(", ") : "NONE"}`);
        say(`   duration on a card: ${a.answerable.duration ? "yes" : "no"} · loop label ${JSON.stringify(a.arcs.map((x) => x.label))} at ${a.arcs[0]?.labelFs || "-"} · arc ends ${JSON.stringify(a.arcOffsets)}`);
        say(`   drawing prints ${a.stageWords} stage words of ${a.totalWords} in the bundle (${Math.round((a.stageWords / Math.max(1, a.totalWords)) * 100)}%)`);
        await shotPage(page, `${label}-a-position-page.png`);
        await shotCard(page, a, `${label}-a-position.png`);

        // the preview's REFUSED state — the only producer of a refusal in the whole app
        const sel = await page.$("[data-pm-stage]");
        if (sel) {
          await page.selectOption("[data-pm-stage]", "S2");
          await page.check("[data-pm-refused]");
          await page.waitForTimeout(200);
          const refused = await measure(page, metaA);
          out.cases[`${label}/A-refused`] = refused;
          say(`\n   refused preview at S2: marks ${refused.nodes.map((n) => `${n.id}:${n.mark}`).join(" ")} · drawing text AFTER a refusal names a gap or a reason: ${refused.drawingText.toLowerCase().includes("refus") ? "only the legend's word" : "NONE"}`);
          await shotCard(page, refused, `${label}-a-refused.png`);
        }
        await closeModal(page);

        // ---- the long run: 13 stages, parked at st11 ------------------------------------------------
        const lp = BUNDLE.pipelines[1];
        const metaLong = {
          case: "A/long",
          stagesDeclared: lp.stages.length,
          totalWords: bundleWords(lp),
          promptWords: lp.stages.reduce((a, s) => a + s.prompt.split(/\s+/).length, 0),
          gateNames: lp.gates.map((g) => g.name),
          deciders: lp.gates.map((g) => g.decider),
          decisionPaths: lp.gates.map((g) => g.decision?.path).filter(Boolean),
          outcomes: lp.gates.flatMap((g) => g.decision?.outcomes || []),
        };
        say(`\n== ${label} · route A — the long run (13 stages, st11 current)`);
        await openRouteA(page, 8);
        const long = await measure(page, metaLong);
        long.arcOffsets = arcOffsets(long);
        out.cases[`${label}/A-long`] = long;
        say(`   mode ${long.mode} · ${JSON.stringify(long.title)} · sub ${JSON.stringify(long.sub)}`);
        say(`   card ${long.card.w}x${long.card.h} · scroller ${long.scrollBox.cw}/${long.scrollBox.sw} · scrollLeft ${long.scrollLeft} · hidden ${long.hiddenPx}px`);
        say(`   visible stages ${long.visibleStages}/${long.nodes.length} · current stage on screen: ${long.currentVisible ? "yes" : "NO"} · marks rule ${long.marksFrom}`);
        say(`   count: ${long.status ? (long.status.hidden ? "(row hidden)" : `"${long.status.text}" · button ${JSON.stringify(long.status.button)}`) : "(no row)"}`);
        say(`   marks: ${long.nodes.map((n) => `${n.id}:${n.mark}`).join(" ")}`);
        say(`   arcs: ${long.arcs.map((x) => `${x.from}→${x.to} ${JSON.stringify(x.label)}`).join("; ") || "none"} · notches ${long.notches.length} · arc ends ${JSON.stringify(long.arcOffsets)}`);
        await shotPage(page, `${label}-a-long-page.png`);
        await shotCard(page, long, `${label}-a-long.png`);
        const lfit = await page.$("[data-pflow-fit]");
        if (lfit) {
          await lfit.click();
          await page.waitForTimeout(260);
          const lf = await measure(page, metaLong);
          lf.arcOffsets = arcOffsets(lf);
          out.cases[`${label}/A-long-fit`] = lf;
          say(`   fitted: ${lf.status?.text || "(no count)"} · visible ${lf.visibleStages}/${lf.nodes.length} · current on screen: ${lf.currentVisible ? "yes" : "NO"} · columns ${lf.nodes[0]?.rect.w} px · hidden ${lf.hiddenPx}px · arc ends ${JSON.stringify(lf.arcOffsets)}`);
          await shotCard(page, lf, `${label}-a-long-fit.png`);
          await page.click("[data-pflow-fit]");
          await page.waitForTimeout(180);
        }
        await closeModal(page);
        out.pageErrors.push(...pageErrors);
        return 0;
      },
      { viewport, deviceScaleFactor: 2 },
    );
    void verdict;
  }
} catch (e) {
  failure = e;
  out.errors.push(String((e && e.stack) || e));
  say(`\nERROR  ${String((e && e.stack) || e).split("\n").slice(0, 8).join("\n       ")}`);
} finally {
  await finish(failure ? 1 : 0);
}
