#!/usr/bin/env node
// HARNESS: LIVE GATE — the dialog's width, its type and its drawing each have a number, and a case that breaks one exits 1.
// The pipeline DIALOG's shape, measured: how much of the frame is drawing, and at what type size.
//
// This round asked one question per case — "is the dialog as big as the picture it holds?" — and it wanted a number,
// not an adjective. So every case prints the drawing's painted area as a share of the dialog card's area, beside the
// card's width, the drawing's own width, whether the scroller is hiding anything, and the smallest type on screen.
// One stage should be a small panel (the card is sized from the drawing); thirteen should either fit or say what it
// hides, through the count the renderer measures for itself.
//
//   node tools/verify-pipeline-dialog-size.mjs                  # measure, write shots under the scratch dir
//   node tools/verify-pipeline-dialog-size.mjs --out <dir>      # where the shots and the JSON go
//
// It exits non-zero when a case breaks the round's own rules: a drawing scrolled while nothing overflows, type below
// 11 px, a stage title below 13 px or lighter than 500, a legend naming a state that is not on screen, a caption
// apologising for the picture, or a card whose width ignores the drawing it holds. Since the density round it also
// refuses a drawing under 55% of the card's area, a strip of the card taller than 8 px that holds nothing, a second
// close control, a stage ordinal that is not on its title's line, and a legend key whose number has no noun.
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
const OUT = path.resolve(opt("--out", path.join(os.tmpdir(), "wtgui-pipeline-dialog-size")));
const SHOTS = path.join(OUT, "shots");

// The ledger is committed beside the report, so it records the tree by its FOLDER NAME, never by the machine path it
// happened to sit at: tools/absolute-paths.mjs refuses a drive-letter path in a tracked file, and a scratch folder is
// gone by the next run, so the path would be a line no reader can open.
const TREE_NAME = path.basename(TREE) || TREE;

const say = (line = "") => console.log(line);
const out = { tree: TREE_NAME, at: new Date().toISOString(), viewports: [], cases: [], failures: [], pageErrors: [] };

// The acceptance fixture the seed does not carry: thirteen stages with real titles and exit checks, so the wide end
// of the round is measured on text a definition would actually hold.
const WORDS = ["intake", "scope", "shape", "build", "check", "review", "hand over", "archive", "audit", "sign off", "publish", "follow up", "close"];
const THIRTEEN = {
  id: "acceptance-thirteen",
  kind: "turnover",
  title: "Acceptance thirteen",
  description: "Thirteen stages, to judge whether a long definition stays visible and readable.",
  stages: Array.from({ length: 13 }, (_, i) => ({
    id: `st${i + 1}`,
    title: `Stage ${i + 1} — ${WORDS[i]}`,
    prompt: `Work stage ${i + 1}, ${WORDS[i]}: read what arrived, produce the artifact, and stop when the exit check passes.`,
    exit: i % 3 === 2 ? { check: "file-exists", path: `docs/stage-${i + 1}.md` } : { check: "commits", min: 1 },
  })),
};

const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-dialog-size-"));
mkdirSync(path.join(dir, "logs"), { recursive: true });
mkdirSync(SHOTS, { recursive: true });
const pipelinesFile = path.join(dir, "pipelines.json");
writeFileSync(pipelinesFile, JSON.stringify({ version: 1, pipelines: { [THIRTEEN.id]: THIRTEEN } }, null, 1), "utf8");

const pw = loadPlaywright();
if (!pw) {
  console.log(notRun("the dialog's shape was not measured", "Playwright is not installed in this checkout (tools/browser.mjs could not load it)."));
  process.exit(2);
}

const port = await freePort();
const panel = await startPanel({
  dir,
  port,
  root: TREE,
  keep: true,
  config: {
    pipelineBundleFile: path.join(TREE, "pipeline-bundle.seed.json"),
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
  writeFileSync(path.join(OUT, "ledger.json"), JSON.stringify(out, null, 1), "utf8");
  await panel.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  say(`\nLEDGER  ${path.join(OUT, "ledger.json")}`);
  say(`SHOTS   ${SHOTS}`);
  process.exit(code);
};

// ---- the reading -------------------------------------------------------------------------------------------------
// Every number comes from the painted page, in CSS pixels. "Drawn area" is the UNION of the boxes that carry the
// drawing - stage cards, their marks (the dot rides outside its tile's top edge) and notches, loop arcs, the legend,
// the count row - each clipped to the scroller's client box (a stage the browser is hiding is not drawn) and to the
// card. "Dialog area" is the card's own box. A card that keeps a fixed 1120 px frame around a one-stage picture
// scores low; a card that shrinks with the picture scores roughly the same at one stage as at thirteen, which is the
// whole point of the round.
const measure = (page) =>
  page.evaluate(() => {
    const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
    };
    const clipTo = (r, box) => {
      const x = Math.max(r.x, box.x);
      const y = Math.max(r.y, box.y);
      const right = Math.min(r.right, box.right);
      const bottom = Math.min(r.bottom, box.bottom);
      return right > x && bottom > y ? { x, y, right, bottom } : null;
    };
    // Exact union area of a small set of boxes: split on every edge and keep the cells some box covers.
    const unionArea = (boxes) => {
      const xs = [...new Set(boxes.flatMap((b) => [b.x, b.right]))].sort((a, b) => a - b);
      const ys = [...new Set(boxes.flatMap((b) => [b.y, b.bottom]))].sort((a, b) => a - b);
      let area = 0;
      for (let i = 0; i < xs.length - 1; i += 1) {
        for (let j = 0; j < ys.length - 1; j += 1) {
          const cx = (xs[i] + xs[i + 1]) / 2;
          const cy = (ys[j] + ys[j + 1]) / 2;
          if (boxes.some((b) => cx > b.x && cx < b.right && cy > b.y && cy < b.bottom)) area += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
        }
      }
      return area;
    };

    const card = document.getElementById("pipeline-modal-card");
    const body = card.querySelector(".pmodal-body");
    const scroll = card.querySelector(".pflow-scroll");
    const scrollBox = rect(scroll);
    const cardBox = rect(card);
    const track = rect(card.querySelector(".pflow-track"));
    const nodes = [...card.querySelectorAll(".pflow-node")];
    const ink = [];
    for (const el of card.querySelectorAll(".pflow-node, .pflow-dot, .pflow-notch, .pflow-arc")) {
      const inside = clipTo(rect(el), scrollBox);
      const box = inside && clipTo(inside, cardBox);
      if (box) ink.push(box);
    }
    for (const el of card.querySelectorAll(".pflow-legend, [data-pflow-status]")) {
      if (el.hidden) continue;
      const box = clipTo(rect(el), cardBox);
      if (box) ink.push(box);
    }
    // The smallest painted type: every text node in the card, measured on the element that paints it.
    let minFont = null;
    let minText = "";
    const walk = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const text = norm(n.textContent);
      if (!text || !n.parentElement) continue;
      const cs = getComputedStyle(n.parentElement);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
      const size = parseFloat(cs.fontSize);
      if (minFont == null || size < minFont) {
        minFont = size;
        minText = text.slice(0, 40);
      }
    }
    const title = nodes[0] && nodes[0].querySelector(".pflow-title");
    const tcs = title ? getComputedStyle(title) : null;
    const legendEl = card.querySelector(".pflow-legend");
    const legendBox = legendEl ? rect(legendEl) : null;
    // The card's own bottom is the last band there is: the footer that used to sit under the drawing is gone, so the
    // slack under the drawing is what the card keeps below its lowest painted box (the legend, the count row, a notch).
    const lastInk = ink.length ? Math.max(...ink.map((b) => b.bottom)) : cardBox.bottom;
    // Bands of the card that hold nothing. A strip is EMPTY when no holding box covers it: the drawing's own boxes
    // (stage cards, notches, arcs, legend, count row), every element that paints a word, and every control. A stage
    // tile's painted surface is not a band of the card — the space inside a tile IS the tile — so the room a tall tile
    // keeps between its title and its detail line is the drawing, not chrome.
    const holds = [...ink];
    for (const el of card.querySelectorAll("*")) {
      if (!el.getClientRects().length) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
      const ownWords = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && norm(n.textContent));
      if (!ownWords && !/^(BUTTON|SELECT|INPUT|TEXTAREA)$/.test(el.tagName)) continue;
      const r = rect(el);
      if (r.w > 0 && r.h > 0) holds.push(r);
    }
    const emptyBands = [];
    let openBand = null;
    for (let y = Math.ceil(cardBox.y) + 1; y < Math.floor(cardBox.bottom); y += 1) {
      if (!holds.some((b) => b.y <= y && b.bottom > y)) {
        if (!openBand) openBand = { top: Math.round(y - cardBox.y), h: 0 };
        openBand.h += 1;
      } else if (openBand) {
        emptyBands.push(openBand);
        openBand = null;
      }
    }
    if (openBand) emptyBands.push(openBand);
    const tallestBand = emptyBands.reduce((a, b) => (b.h > a.h ? b : a), { top: 0, h: 0 });
    // The ordinal has to sit ON its title's line, not in a line of its own: one row of numerals above one row of
    // words is two bands for one idea, and the numeral's band holds a single character.
    const ordinals = nodes.map((n) => {
      const num = n.querySelector(".pflow-n");
      const ttl = n.querySelector(".pflow-title");
      if (!num || !ttl) return { sameLine: false, why: "no ordinal or no title" };
      const a = num.getBoundingClientRect();
      const b = ttl.getBoundingClientRect();
      // The two boxes share the line when they OVERLAP vertically — baseline alignment puts an 11 px numeral's box a
      // few px lower than a 13 px title's, which is the same line, not a second one.
      const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      return { sameLine: overlap >= 0.8 * Math.min(a.height, b.height), numTop: +a.top.toFixed(1), titleTop: +b.top.toFixed(1) };
    });
    const keys = [...card.querySelectorAll(".pflow-key")].map((k) => ({ mark: k.dataset.mark, text: norm(k.textContent) }));
    const status = card.querySelector("[data-pflow-status]");
    const fit = status && status.querySelector("[data-pflow-fit]");
    return {
      vw: innerWidth,
      vh: innerHeight,
      mode: document.getElementById("pipeline-modal").dataset.mode,
      kicker: norm(card.querySelector(".pmodal-kicker")?.textContent),
      title: norm(document.getElementById("pipeline-modal-title")?.textContent),
      note: norm(card.querySelector(".pmodal-note")?.textContent),
      stages: nodes.length,
      card: { w: +cardBox.w.toFixed(1), h: +cardBox.h.toFixed(1) },
      legendBox: legendBox ? { y: Math.round(legendBox.y), h: Math.round(legendBox.h) } : null,
      slack: Math.round(cardBox.bottom - lastInk),
      emptyBands,
      tallestBand,
      closeControls: card.querySelectorAll("[data-pm-close]").length,
      ordinals,
      body: { w: +rect(body).w.toFixed(1) },
      track: { w: +track.w.toFixed(1) },
      column: nodes.length ? +nodes[0].getBoundingClientRect().width.toFixed(1) : 0,
      scroll: { client: scroll.clientWidth, width: scroll.scrollWidth },
      hiddenPx: Math.max(0, scroll.scrollWidth - scroll.clientWidth),
      drawnArea: Math.round(unionArea(ink)),
      titleFont: tcs ? { size: tcs.fontSize, weight: tcs.fontWeight } : null,
      minFont,
      minText,
      legend: keys,
      marks: [...new Set(nodes.map((n) => n.dataset.mark))],
      count: status ? { hidden: Boolean(status.hidden), text: norm(status.querySelector("[data-pflow-count]")?.textContent || ""), button: fit ? norm(fit.textContent) : null } : null,
    };
  });

// The card's own box is what a reader calls the dialog; the shot is clipped to it so the number and the picture are
// about the same rectangle.
const shot = async (page, file) => {
  const box = await page.evaluate(() => {
    const r = document.getElementById("pipeline-modal-card").getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight };
  });
  const clip = {
    x: Math.max(0, Math.floor(box.x)),
    y: Math.max(0, Math.floor(box.y)),
    width: Math.max(1, Math.min(Math.ceil(box.w), Math.ceil(box.vw) - Math.max(0, Math.floor(box.x)))),
    height: Math.max(1, Math.min(Math.ceil(box.h), Math.ceil(box.vh) - Math.max(0, Math.floor(box.y)))),
  };
  await page.screenshot({ path: path.join(SHOTS, file), clip });
};

const share = (m) => (m.card.w * m.card.h ? +((m.drawnArea / (m.card.w * m.card.h)) * 100).toFixed(1) : 0);

let failure = null;
try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 1824, height: 900 }]) {
    const label = `${viewport.width}x${viewport.height}`;
    out.viewports.push(label);
    await withBrowser(
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
          { id: "local", expect: 1 },
          { id: "investigate", expect: 2 },
          { id: "sefl-review-loop", expect: 7 },
          { id: THIRTEEN.id, expect: 13 },
        ];
        for (const one of cases) {
          if (!options.includes(one.id)) {
            out.failures.push(`${label}: ${one.id} is not in the catalogue (${options.join(", ")})`);
            continue;
          }
          await page.selectOption("#pipeline-select", one.id);
          await page.waitForTimeout(160);
          await page.click("#pipeline-flow-open");
          await page.waitForSelector("#pipeline-modal:not([hidden]) .pflow-node");
          await page.waitForTimeout(220);
          const m = await measure(page);
          m.case = `${label}/${one.id}`;
          m.expect = one.expect;
          m.share = share(m);
          // The frame this round replaced, measured on the same drawing: the old card was `min(1120px, 96vw)` at every
          // stage count. Setting that width on the live card and re-reading the same union is the honest before/after,
          // not an assumption about what a wider frame would have cost.
          await page.evaluate(() => {
            document.getElementById("pipeline-modal-card").style.setProperty("width", "min(1120px, 96vw)", "important");
          });
          await page.waitForTimeout(150);
          const was = await measure(page);
          m.before = { w: was.card.w, h: was.card.h, share: share(was) };
          await page.evaluate(() => {
            const card = document.getElementById("pipeline-modal-card");
            card.style.removeProperty("width");
          });
          await page.waitForTimeout(150);
          out.cases.push(m);
          say(`\n== ${label} · ${one.id} (${m.stages} stages)`);
          say(`   card ${m.card.w}×${m.card.h} · drawing ${m.drawnArea} px² · DRAWN ${m.share}% of the dialog (the old ${m.before.w}px frame measured ${m.before.share}%)`);
          say(`   track ${m.track.w}px · column ${m.column}px · scroller ${m.scroll.client}/${m.scroll.width} ${m.hiddenPx ? `(hides ${m.hiddenPx}px)` : "(nothing hidden)"}`);
          say(`   count: ${m.count ? (m.count.hidden ? "(row hidden)" : `${JSON.stringify(m.count.text)} · ${JSON.stringify(m.count.button)}`) : "(no row)"}`);
          say(`   type: title ${m.titleFont?.size}/${m.titleFont?.weight} · smallest ${m.minFont}px ${JSON.stringify(m.minText)}`);
          say(`   kicker ${JSON.stringify(m.kicker)} · note ${JSON.stringify(m.note || "")} · slack under the drawing ${m.slack}px`);
          say(`   empty bands ${m.emptyBands.length ? m.emptyBands.map((b) => `${b.top}px@${b.h}`).join(" ") : "none"} · TALLEST ${m.tallestBand.h}px at ${m.tallestBand.top}px · close controls ${m.closeControls}`);
          say(`   ordinals on the title line: ${m.ordinals.filter((o) => o.sameLine).length}/${m.ordinals.length} · legend ${m.legend.map((k) => JSON.stringify(k.text)).join(", ") || "(none)"}`);
          await shot(page, `${label}-${m.stages}-stages.png`);

          const fail = (why) => out.failures.push(`${m.case}: ${why}`);
          if (m.stages !== one.expect) fail(`drew ${m.stages} stages, expected ${one.expect}`);
          if (m.note) fail(`a caption explaining the picture is still printed: ${JSON.stringify(m.note)}`);
          if (/editing/i.test(m.kicker)) fail(`the header still says EDITING: ${JSON.stringify(m.kicker)}`);
          if (m.legend.map((k) => k.mark).sort().join() !== [...m.marks].sort().join()) fail(`the legend names states not on screen: legend ${m.legend.map((k) => k.mark)}, marks ${m.marks}`);
          if (m.minFont < 11) fail(`type below 11px: ${m.minFont}px ${JSON.stringify(m.minText)}`);
          if (parseFloat(m.titleFont?.size) < 13) fail(`the stage title is ${m.titleFont?.size}, below 13px`);
          if (Number(m.titleFont?.weight) < 500) fail(`the stage title's weight is ${m.titleFont?.weight}, below 500`);
          if (!m.hiddenPx && m.scroll.width > m.scroll.client + 1) fail(`a scrollbar under a drawing that fits`);
          if (one.expect === 1 && m.card.w > 380) fail(`one stage opens a ${m.card.w}px card — the dialog is not sizing to its content`);
          if (m.card.w > Math.min(1586, viewport.width * 0.96) + 1) fail(`the card is ${m.card.w}px, past its own ceiling`);

          // ---- the density rules this round adds, beside the thresholds the shape round already set ------------------
          // The drawing is the bigger half of the card, no strip of the card taller than 8 px holds nothing, ONE control
          // closes it, the ordinal shares its title's line, and every legend key names what its number counts.
          if (m.share < 55) fail(`the drawing is ${m.share}% of the card, under this round's 55% floor`);
          if (m.tallestBand.h > 8) fail(`a ${m.tallestBand.h}px band of the card holds nothing (at ${m.tallestBand.top}px)`);
          if (m.closeControls !== 1) fail(`the card offers ${m.closeControls} close controls, not one`);
          if (m.ordinals.some((o) => !o.sameLine)) fail(`a stage ordinal is not on its title's line: ${JSON.stringify(m.ordinals.filter((o) => !o.sameLine).slice(0, 2))}`);
          for (const k of m.legend) if (!/\d+ stages?$/.test(k.text)) fail(`the legend key ${JSON.stringify(k.text)} does not end in a count of stages`);

          // The fitted press: the long definition's other half of the promise.
          if (m.hiddenPx > 0) {
            const button = await page.$("[data-pflow-fit]");
            if (!button) {
              fail(`hides ${m.hiddenPx}px and offers no fit control`);
            } else {
              await button.click();
              await page.waitForTimeout(320);
              const f = await measure(page);
              f.case = `${label}/${one.id}-fit`;
              f.share = share(f);
              out.cases.push(f);
              say(`   fitted: ${JSON.stringify(f.count?.text || "")} · column ${f.column}px · hides ${f.hiddenPx}px · DRAWN ${f.share}%`);
              await shot(page, `${label}-${m.stages}-stages-fit.png`);
              if (f.minFont < 11) out.failures.push(`${f.case}: type below 11px: ${f.minFont}px`);
              if (f.hiddenPx > 0) out.failures.push(`${f.case}: the fit press still hides ${f.hiddenPx}px`);
              await page.click("[data-pflow-fit]");
              await page.waitForTimeout(200);
            }
          }
          await page.keyboard.press("Escape");
          await page.waitForFunction(() => document.getElementById("pipeline-modal").hidden === true, null, { timeout: 5_000 });
          await page.waitForTimeout(120);
        }
        out.pageErrors.push(...pageErrors);
        return 0;
      },
      { viewport, deviceScaleFactor: 2 },
    );
  }
} catch (e) {
  failure = e;
  out.failures.push(String((e && e.stack) || e));
  say(`\nERROR  ${String((e && e.stack) || e).split("\n").slice(0, 8).join("\n       ")}`);
} finally {
  say(`\n--- ${out.cases.length} measured, ${out.failures.length} failures`);
  for (const f of out.failures) say(`FAIL  ${f}`);
  await finish(failure || out.failures.length ? 1 : 0);
}
