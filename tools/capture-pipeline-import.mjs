#!/usr/bin/env node
// CAPTURE, not gate: the four photographs that prove this page can draw a document it did not build, and says
// which document it is drawing. tools/verify-pipeline-import.mjs is the gate that judges the same page; this file
// only measures and photographs, and writes one ledger a report can be built from.
//
//   node tools/capture-pipeline-import.mjs
//   node tools/capture-pipeline-import.mjs --live http://127.0.0.1:8090/api/pipelines \
//        --document <the factory's own studio export>/pipeline.json --shots <dir> --json <dir>/capture.json
//
// FOUR CASES, each a document the FACTORY produced — never one of this page's own seeds:
//   1. ?doc=<url>          the factory's own index, read through the panel's GET /api/pipeline-doc;
//   2. the same bytes      through the page's `open a document` file input — the round trip;
//   3. a second pipeline   the studio's export ({project, stages[], handoffs[], gates[], roles[]}), by file;
//   4. the refusal         a malformed document, which must print the red sentence and leave 3's drawing standing.
//
// WHAT IS MEASURED, per case: the document's id, its byte count and sha256 as the page printed them, the stage
// count the DOCUMENT declares, the stage nodes actually drawn, the card's own status sentence ("fits the card ·
// 9 of 9 in view"), and the sha256 of the PNG. A count is compared with the document, never with a constant:
// that is what makes case 3 able to certify a pipeline other than the one case 1 names.
//
// LAYOUT. A nine-stage chain at 1:1 is wider than the card, so a shot of the default row layout would show most
// of a chain. When the card overflows, the capture presses the page's own `book · rows of N` control (3 per row)
// and says so in the ledger; a document whose arrows converge cannot be cut into rows, and is photographed as it
// is, at its own width, with the card's own "N px past the card" sentence quoted rather than hidden.
//
// Exit: 0 every case measured and photographed; 1 a check failed; 2 the browser half could not run.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withBrowser } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TREE = path.resolve(HERE, "..");
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const LIVE = String(opt("--live", "http://127.0.0.1:8090/api/pipelines"));
const DOCUMENT = opt("--document", null);
const SHOTS = path.resolve(opt("--shots", path.join(process.cwd(), "pipelines-import-capture")));
const JSON_OUT = path.resolve(opt("--json", path.join(SHOTS, "capture.json")));
const QUIET = argv.includes("--quiet");

// A document that cannot parse: the first line of a real export, cut before its first closing brace.
const BAD = Buffer.from('{"stages": [ {"id": "S160",', "utf8");
const BAD_NAME = "broken.json";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const nf = (n) => Number(n).toLocaleString("en-US");

const failures = [];
const ledger = {
  at: new Date().toISOString(),
  tree: ".",
  live: LIVE,
  // A landing is read on another machine: the document is named by its file, never by the folder it sat in here.
  document: DOCUMENT ? path.basename(DOCUMENT) : null,
  panel: { base: null },
  cases: [],
  notes: [],
  errors: [],
};

function check(ok, message, detail) {
  if (!ok) {
    failures.push({ message, detail: detail == null ? "" : String(detail).slice(0, 1200) });
    console.log(`FAIL  ${message}${detail ? `\n      ${String(detail).replace(/\n/g, "\n      ")}` : ""}`);
  } else if (!QUIET) {
    console.log(`PASS  ${message}`);
  }
  return ok;
}

// ---- the documents the factory produced ---------------------------------------------------------------------------
// The index: what GET <live> answers right now. Its bytes, not a fixture, are what the page must draw.
let liveBytes = null;
try {
  const res = await fetch(LIVE, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  liveBytes = Buffer.from(await res.arrayBuffer());
} catch (e) {
  console.error(`live: could not read ${LIVE} — ${String((e && e.message) || e)}`);
  process.exit(1);
}
const liveEntries = JSON.parse(liveBytes.toString("utf8"));
if (!Array.isArray(liveEntries) || !liveEntries.length) {
  console.error(`live: ${LIVE} is not a non-empty index — ${liveBytes.toString("utf8").slice(0, 200)}`);
  process.exit(1);
}
const liveStages = liveEntries.reduce((n, e) => n + (Number(e.stageCount) || 0), 0);
const liveIds = liveEntries.map((e) => String(e.id || "")).filter(Boolean);
ledger.liveIndex = { url: LIVE, bytes: liveBytes.length, sha256: sha(liveBytes), ids: liveIds, stages: liveStages };

let studioBytes = null;
let studioDoc = null;
if (DOCUMENT) {
  try {
    studioBytes = readFileSync(DOCUMENT);
    studioDoc = JSON.parse(studioBytes.toString("utf8"));
  } catch (e) {
    console.error(`--document: ${DOCUMENT} could not be read as JSON — ${String((e && e.message) || e)}`);
    process.exit(2);
  }
  if (!Array.isArray(studioDoc.stages) || !studioDoc.stages.length) {
    console.error(`--document: ${DOCUMENT} has no stages[] — it is not a studio export`);
    process.exit(2);
  }
  ledger.studioDocument = {
    file: path.basename(DOCUMENT),
    bytes: studioBytes.length,
    sha256: sha(studioBytes),
    id: String((studioDoc.project && studioDoc.project.id) || studioDoc.id || ""),
    stages: studioDoc.stages.length,
    titles: studioDoc.stages.map((s) => String(s.title || s.name || s.id || "")),
  };
}

mkdirSync(SHOTS, { recursive: true });

async function measure(page) {
  return page.evaluate(() => {
    const ds = document.documentElement.dataset;
    const card = document.querySelector(".pm-card");
    const draw = card ? card.querySelector("[data-draw]") : null;
    const vp = card ? card.querySelector(".pm-vp") : null;
    const prov = document.getElementById("provenance");
    const err = document.getElementById("doc-error");
    const nodes = [...document.querySelectorAll(".pm-card g.node[data-stage]")];
    const vpRect = vp ? vp.getBoundingClientRect() : null;
    return {
      ready: ds.pipelineMapReady || "",
      source: ds.pipelineSource || "",
      shape: ds.pipelineDocShape || "",
      ids: ds.pipelineDocIds || "",
      sha: ds.pipelineDocSha256 || "",
      docSource: ds.pipelineDocSource || "",
      stages: Number(ds.pipelineDocStages || 0),
      cards: Number(ds.pipelineDocCards || 0),
      loaded: ds.pipelineDocLoaded || "",
      error: ds.pipelineDocError || "",
      errorVisible: err ? !err.hidden : false,
      errorText: err ? err.innerText.replace(/\s+/g, " ").trim() : "",
      provenance: prov ? prov.innerText.replace(/\s+/g, " ").trim() : "",
      layout: draw ? draw.dataset.layout || "" : "",
      cardCount: document.querySelectorAll(".pm-card").length,
      nodes: nodes.length,
      nodeTitles: nodes.map((n) => n.getAttribute("aria-label") || ""),
      inView: vpRect
        ? nodes.filter((n) => {
            const b = n.getBoundingClientRect();
            return b.left >= vpRect.left - 0.5 && b.right <= vpRect.right + 0.5;
          }).length
        : 0,
      hiddenPx: vp ? Math.max(0, Math.round(vp.scrollWidth - vp.clientWidth)) : 0,
      status: card && card.querySelector("[data-status]") ? card.querySelector("[data-status]").innerText.replace(/\s+/g, " ").trim() : "",
      cardTitle: card ? String((card.querySelector("h2") || {}).textContent || "").trim() : "",
    };
  });
}

// The page's own control, pressed only when the drawing does not fit: a chain nine stages long at 1:1 is ~2.5 k
// px, and a shot clipped to the card proves neither the count nor the ends of the chain.
async function fitLayout(page) {
  const before = await page.evaluate(() => {
    const vp = document.querySelector(".pm-vp");
    const book = document.querySelector('#layout button[data-layout="book"]');
    return { hidden: vp ? Math.max(0, Math.round(vp.scrollWidth - vp.clientWidth)) : 0, book: book ? !book.disabled : false };
  });
  if (before.hidden <= 2) return { layout: "row", pressed: false, hiddenBefore: before.hidden };
  if (!before.book) return { layout: "row", pressed: false, hiddenBefore: before.hidden };
  await page.click('#layout button[data-layout="book"]');
  await page.waitForFunction(() => document.documentElement.dataset.pipelineMapReady === "1");
  const perRow = await page.evaluate(() => document.querySelector('#per-row button[data-n="3"]').getAttribute("aria-pressed") === "true");
  if (!perRow) {
    await page.click('#per-row button[data-n="3"]');
    await page.waitForFunction(() => document.documentElement.dataset.pipelineMapReady === "1");
  }
  await page.waitForTimeout(120);
  return { layout: "book", pressed: true, hiddenBefore: before.hidden, perRow: 3 };
}

// The evidence is the region a reader has to be able to read: the page's own kicker (which page this is), the
// summary row, the provenance line (document id + sha256), the controls, and the card with its own counts. The
// page's footer ledger and prose below that are the same on every shot and are read in the report instead.
async function evidenceClip(page) {
  return page.evaluate(() => {
    const top = document.querySelector("header .kicker") || document.querySelector("header");
    const card = document.querySelector(".pm-card");
    const wrap = document.querySelector(".wrap");
    if (!top || !card || !wrap) return null;
    const t = top.getBoundingClientRect();
    const b = card.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    const x = Math.max(0, Math.floor(w.left));
    const y = Math.max(0, Math.floor(t.top + window.scrollY) - 8);
    const right = Math.min(Math.ceil(w.right), document.documentElement.clientWidth);
    const height = Math.ceil(b.bottom + window.scrollY - y + 8);
    return { x, y, width: Math.max(200, right - x), height: Math.max(200, height) };
  });
}

async function shoot(page, name) {
  const file = path.join(SHOTS, name);
  // A clip is clamped to the viewport, so grow the window to hold the region first: the page's card is taller
  // than a 1000 px window once four named stages and the loop-backs row are in it.
  let clip = await evidenceClip(page);
  const size = page.viewportSize();
  if (clip && size && clip.y + clip.height + 8 > size.height) {
    await page.setViewportSize({ width: size.width, height: Math.min(2400, Math.ceil(clip.y + clip.height + 8)) });
    await page.waitForTimeout(150);
    clip = await evidenceClip(page);
  }
  await page.screenshot({ path: file, ...(clip ? { clip } : { fullPage: true }) });
  const bytes = readFileSync(file);
  return { file: name, bytes: bytes.length, sha256: sha(bytes), clip };
}

async function drawShot(page, name) {
  const el = await page.$(".pm-card [data-draw]");
  if (!el) return null;
  const file = path.join(SHOTS, name);
  await el.screenshot({ path: file });
  const bytes = readFileSync(file);
  return { file: name, bytes: bytes.length, sha256: sha(bytes) };
}

const record = (name, m, extra) => ({
  case: name,
  at: new Date().toISOString(),
  source: m.source,
  shape: m.shape,
  ids: m.ids,
  docSource: m.docSource,
  sha256: m.sha,
  stagesPrinted: m.stages,
  cards: m.cards,
  nodesDrawn: m.nodes,
  inView: m.inView,
  hiddenPx: m.hiddenPx,
  layout: m.layout,
  status: m.status,
  cardTitle: m.cardTitle,
  provenance: m.provenance,
  errorVisible: m.errorVisible,
  errorText: m.errorText,
  ...extra,
});

let panel = null;
let browserHalf = null;
try {
  panel = await startPanel({});
  ledger.panel.base = panel.base;
  const pageUrl = (q) => `${panel.base}/pipeline-map.html${q || ""}`;

  browserHalf = await withBrowser(
    async ({ page, pageErrors, consoleErrors }) => {
      const settle = (predicate, arg = null) => page.waitForFunction(predicate, arg, { timeout: 60000 });

      // ---- 1. the factory's index, by ?doc= -------------------------------------------------------------------
      await page.goto(pageUrl(`?doc=${encodeURIComponent(LIVE)}`), { waitUntil: "load" });
      await settle(() => document.documentElement.dataset.pipelineMapReady === "1" && document.documentElement.dataset.pipelineSource === "document");
      const fit1 = await fitLayout(page);
      const byUrl = await measure(page);
      check(byUrl.ids === liveIds.join(", "), `case 1 prints the document id the index names (${byUrl.ids || "none"})`);
      check(byUrl.sha === ledger.liveIndex.sha256, `case 1 prints the sha256 of the bytes served (${byUrl.sha || "none"})`);
      check(byUrl.stages === liveStages && byUrl.nodes === liveStages, `case 1 draws the ${liveStages} stages the index counts (printed ${byUrl.stages}, drawn ${byUrl.nodes})`);
      check(byUrl.source === "document" && byUrl.shape === "index", `case 1 is an imported index drawing (${byUrl.source}/${byUrl.shape})`);
      const shot1 = await shoot(page, "01-doc-url-index.png");
      const draw1 = await drawShot(page, "01-draw-url-index.png");
      ledger.cases.push(record("1 · ?doc=<url> — the factory index", byUrl, { docUrl: LIVE, fit: fit1, stagesInDocument: liveStages, shot: shot1, drawingShot: draw1 }));

      // ---- 2. the same bytes through the file input ------------------------------------------------------------
      const seqBefore = Number(await page.evaluate(() => document.documentElement.dataset.pipelineDocSeq || 0));
      await page.setInputFiles("#doc-file", { name: "factory-index.json", mimeType: "application/json", buffer: liveBytes });
      await settle((n) => Number(document.documentElement.dataset.pipelineDocSeq || 0) > n && document.documentElement.dataset.pipelineMapReady === "1", seqBefore);
      const fit2 = await fitLayout(page);
      const byFile = await measure(page);
      check(byFile.sha === byUrl.sha, "the file round trip carries the same sha256");
      check(byFile.nodeTitles.join("|") === byUrl.nodeTitles.join("|"), "the file round trip draws the same stage nodes");
      check(/^file: /.test(byFile.docSource), `case 2's source line names the file (${byFile.docSource})`);
      const shot2 = await shoot(page, "02-doc-file-index.png");
      const draw2 = await drawShot(page, "02-draw-file-index.png");
      const sameDrawing = Boolean(draw1 && draw2 && draw1.sha256 === draw2.sha256);
      check(sameDrawing, `the two drawings are the same picture (${draw1 ? draw1.sha256.slice(0, 16) : "none"} vs ${draw2 ? draw2.sha256.slice(0, 16) : "none"})`);
      ledger.cases.push(record("2 · the same bytes through the file input", byFile, { fit: fit2, stagesInDocument: liveStages, roundTrip: true, sameDrawing, shot: shot2, drawingShot: draw2 }));

      // ---- 3. a second factory pipeline: the studio's export ---------------------------------------------------
      if (studioBytes) {
        await page.goto(pageUrl(), { waitUntil: "load" });
        await settle(() => document.documentElement.dataset.pipelineMapReady === "1");
        const seq0 = Number(await page.evaluate(() => document.documentElement.dataset.pipelineDocSeq || 0));
        await page.setInputFiles("#doc-file", { name: path.basename(DOCUMENT), mimeType: "application/json", buffer: studioBytes });
        await settle((n) => Number(document.documentElement.dataset.pipelineDocSeq || 0) > n && document.documentElement.dataset.pipelineMapReady === "1", seq0);
        const fit3 = await fitLayout(page);
        const studio = await measure(page);
        check(studio.ids === ledger.studioDocument.id, `case 3 prints the studio document's own id (${studio.ids})`);
        check(studio.sha === ledger.studioDocument.sha256, `case 3 prints the file's sha256 (${studio.sha})`);
        check(studio.stages === studioDoc.stages.length && studio.nodes === studioDoc.stages.length, `case 3 draws its ${studioDoc.stages.length} named stages (printed ${studio.stages}, drawn ${studio.nodes})`);
        const ordered = studio.nodeTitles.every((t, i) => t.startsWith(`stage ${i + 1} of ${studioDoc.stages.length}: ${ledger.studioDocument.titles[i]}.`));
        check(ordered, `case 3's nodes are the document's stages, in its order (${studio.nodeTitles[0] || "none"})`);
        const shot3 = await shoot(page, "03-studio-document.png");
        const draw3 = await drawShot(page, "03-draw-studio-document.png");
        ledger.cases.push(record("3 · the studio's export of a second pipeline", studio, { fit: fit3, stagesInDocument: studioDoc.stages.length, roundTrip: false, shot: shot3, drawingShot: draw3 }));

        // ---- 4. the refusal, over that drawing ----------------------------------------------------------------
        const seqErr = Number(await page.evaluate(() => document.documentElement.dataset.pipelineDocSeq || 0));
        await page.setInputFiles("#doc-file", { name: BAD_NAME, mimeType: "application/json", buffer: BAD });
        await settle(() => Boolean(document.documentElement.dataset.pipelineDocError) && document.documentElement.dataset.pipelineMapReady === "1");
        const bad = await measure(page);
        check(bad.errorVisible && /not JSON/i.test(bad.errorText) && bad.errorText.includes(BAD_NAME), `case 4 prints the red sentence and names the document (${bad.errorText.slice(0, 180)})`);
        check(bad.nodes === studio.nodes && bad.sha === studio.sha && bad.ids === studio.ids, `case 4 leaves the previous drawing standing (${bad.nodes} nodes, ${bad.sha.slice(0, 16)})`, JSON.stringify({ nodes: bad.nodes, sha: bad.sha.slice(0, 16), ids: bad.ids }));
        check(bad.loaded === "0" && Number(await page.evaluate(() => document.documentElement.dataset.pipelineDocSeq || 0)) === seqErr, "case 4 did not draw anything (the sequence did not move)");
        const shot4 = await shoot(page, "04-refusal.png");
        ledger.cases.push(
          record("4 · the refusal — a malformed document over the studio drawing", bad, {
            refusal: true,
            previous: { nodes: studio.nodes, sha256: studio.sha, ids: studio.ids },
            shot: shot4,
          }),
        );
      }

      check(consoleErrors.length === 0, "zero console errors", consoleErrors.join("\n"));
      check(pageErrors.length === 0, "zero page errors", pageErrors.join("\n"));
      return { byUrl, byFile };
    },
    { viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 },
  );
} catch (e) {
  if (/no Playwright|BROWSER-HALF-NOT-RUN/i.test(String((e && e.message) || e))) {
    console.error(`BROWSER-HALF-NOT-RUN: ${String((e && e.message) || e)}`);
    if (panel) await panel.stop();
    process.exit(2);
  }
  ledger.errors.push(String((e && e.stack) || e));
  console.log(`FAIL  the browser half threw: ${String((e && e.stack) || e)}`);
  failures.push({ message: "browser half", detail: String((e && e.stack) || e) });
}

if (panel) await panel.stop();

// The intermediate drawing crops are for the ledger's round-trip comparison, not for the report: the two that
// matter are the case shots the reader opens. Drop them so a run leaves only the evidence it means to keep.
for (const c of ledger.cases) {
  if (c.drawingShot) {
    try {
      rmSync(path.join(SHOTS, c.drawingShot.file), { force: true });
    } catch {
      /* it is a scratch crop */
    }
  }
}

ledger.failures = failures;
writeFileSync(JSON_OUT, JSON.stringify(ledger, null, 1));

if (!QUIET) {
  for (const c of ledger.cases) {
    console.log(
      `case ${c.case}\n  document  ${c.ids || "(none)"} · ${c.shape || "?"} · ${c.stagesPrinted} stages in the document, ${c.nodesDrawn} drawn\n` +
        `  source    ${c.docSource}\n  sha256    ${c.sha256}\n  layout    ${c.layout} · ${c.status || "(no status)"}\n  shot      ${c.shot.file} (${nf(c.shot.bytes)} B, ${c.shot.sha256.slice(0, 16)})\n` +
        (c.errorVisible ? `  refusal   ${c.errorText}\n` : ""),
    );
  }
}
if (failures.length) {
  console.log(`\n${failures.length} failed, ${ledger.cases.length} case(s) photographed — the import capture is NOT evidence`);
  process.exit(1);
}
console.log(`\n${ledger.cases.length} case(s) photographed, 0 failed — ${JSON_OUT}`);
