#!/usr/bin/env node
// HARNESS: LIVE GATE — it drives the committed page in Chromium, so a red run means the reader's drawing is wrong.
// tools/verify-pipeline-import.mjs — prove the map can draw a document it did not build, and says where it came from.
//
// The page is generated from two seeds, so drawing anything else is the import path: `?doc=<url|path>` and the file
// input, both through public/core/pipeline-import.js. This harness drives the committed page in Chromium and
// asserts the three proofs the brief names, plus the richer one a real document gives:
//
//   1. `?doc=<url>` draws the factory's index — poc-breaking-suite, nine counted stage nodes — through the panel's
//      own GET /api/pipeline-doc, and the provenance line names that URL and the sha256 of the bytes it served;
//   2. the same JSON through the FILE INPUT draws the same nine nodes, with the same sha256, and the source line
//      says it is a file;
//   3. a malformed document is a VISIBLE error and the page is otherwise unchanged — the built-in 8 cards and 36
//      stage nodes are still there, and so is the built-in provenance line. A blank canvas is a failure here.
//
//   --live <url>      use a running service's index (e.g. http://127.0.0.1:8090/api/pipelines) instead of the
//                     fixture below; the bytes fetched at gate time are what the page must draw
//   --document <file> also import a full studio document from disk and assert its named stages and sha256
//   --shots <dir>     write PNG evidence (the index drawing, the file import, the refusal)
//   --quiet           only failures and the final line
//
// Exit codes: 0 pass; 1 a failed assertion; 2 the browser half could not run (no Playwright).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withBrowser } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = path.join(REPO, "public", "pipeline-map.html");
const IMPORT = path.join(REPO, "public", "core", "pipeline-import.js");

// The factory's own answer on 2026-11-05, byte for byte (GET http://127.0.0.1:8090/api/pipelines). It is an INDEX:
// it names one pipeline and counts its nine stages, and does not carry a stage name.
const INDEX = '[{"id":"poc-breaking-suite","title":"POC-breaking suite — six layer questions, two answered","stageCount":9}]';
const BAD = '{"stages": [ {"id": "S160",';
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

const failures = [];
let passes = 0;
let quiet = false;
function check(ok, message, detail) {
  if (ok) {
    passes++;
    if (!quiet) console.log(`PASS  ${message}`);
    return true;
  }
  failures.push({ message, detail });
  console.log(`FAIL  ${message}${detail ? `\n      ${String(detail).replace(/\n/g, "\n      ")}` : ""}`);
  return false;
}

const args = process.argv.slice(2);
let live = null;
let documentPath = null;
let shots = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--live") live = args[++i];
  else if (args[i] === "--document") documentPath = path.resolve(args[++i] || "");
  else if (args[i] === "--shots") shots = path.resolve(args[++i] || "");
  else if (args[i] === "--quiet") quiet = true;
  else if (args[i] === "--help" || args[i] === "-h") {
    console.log("node tools/verify-pipeline-import.mjs [--live <url>] [--document <file>] [--shots <dir>] [--quiet]");
    process.exit(0);
  } else {
    console.error(`unknown argument ${JSON.stringify(args[i])}`);
    process.exit(2);
  }
}
if (live && !/^https?:\/\//i.test(live)) { console.error("--live needs an http(s) URL"); process.exit(2); }
if (documentPath && !existsSync(documentPath)) { console.error(`--document: ${documentPath} is not there`); process.exit(2); }
if (!existsSync(PAGE) || !existsSync(IMPORT)) {
  console.error(`pipeline-map: ${existsSync(PAGE) ? "the importer" : "the page"} is missing — run node tools/render-pipeline-map.mjs`);
  process.exit(1);
}

// ---- the fixture ---------------------------------------------------------------------------------------------------
// A service on loopback that answers the shapes the gate needs. It is ALWAYS started: even in `--live` mode the
// refusal case needs a URL that serves malformed JSON, and the factory has no such route.
let fixture = null;
let fixtureBase = null;
let indexBytes = Buffer.from(INDEX, "utf8");
let indexSource = null;

fixture = createServer((req, res) => {
  if (req.url === "/api/pipelines") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": indexBytes.length });
    return res.end(indexBytes);
  }
  if (req.url === "/bad.json") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return res.end(BAD);
  }
  if (req.url === "/empty.json") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return res.end("{}");
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end('{"error":"not_found"}');
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
fixtureBase = `http://127.0.0.1:${fixture.address().port}`;
indexSource = live || `${fixtureBase}/api/pipelines`;

if (live) {
  try {
    const res = await fetch(live, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    indexBytes = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    console.error(`live: could not read ${live} — ${String((e && e.message) || e)}`);
    await new Promise((resolve) => fixture.close(resolve));
    process.exit(1);
  }
}

const indexSha = sha(indexBytes);
// The id the page must print beside that hash: whatever the document itself names, never a constant.
const indexIds = (() => {
  try {
    const v = JSON.parse(indexBytes.toString("utf8"));
    return Array.isArray(v) ? v.map((e) => String((e && e.id) || "")).filter(Boolean).join(", ") : "";
  } catch {
    return "";
  }
})();

// ---- the panel that serves the page --------------------------------------------------------------------------------
const panel = await startPanel({});
const pageUrl = (query) => `${panel.base}/pipeline-map.html${query || ""}`;

const settle = (page, predicate, arg = null) => page.waitForFunction(predicate, arg, { timeout: 60000 });

async function stateOf(page) {
  return page.evaluate(() => {
    const ds = document.documentElement.dataset;
    const cards = [...document.querySelectorAll(".pm-card")];
    return {
      ready: ds.pipelineMapReady || "",
      source: ds.pipelineSource || "",
      shape: ds.pipelineDocShape || "",
      sha: ds.pipelineDocSha256 || "",
      docSource: ds.pipelineDocSource || "",
      docIds: ds.pipelineDocIds || "",
      stages: ds.pipelineDocStages || "",
      docCards: ds.pipelineDocCards || "",
      seq: ds.pipelineDocSeq || "0",
      loaded: ds.pipelineDocLoaded || "",
      error: ds.pipelineDocError || "",
      provenance: document.getElementById("provenance").innerText.trim(),
      provenanceKind: document.getElementById("provenance").dataset.kind || "",
      errorVisible: !document.getElementById("doc-error").hidden,
      errorText: document.getElementById("doc-error").innerText.trim(),
      cards: cards.map((c) => ({ id: c.dataset.card, stages: Number(c.dataset.stages), nodes: Number(c.dataset.nodeCount), ready: c.dataset.ready })),
      nodes: cards.reduce((n, c) => n + c.querySelectorAll("g.node[data-stage]").length, 0),
      titles: cards.flatMap((c) => [...c.querySelectorAll("g.node[data-stage]")].map((n) => n.getAttribute("aria-label") || "")),
    };
  });
}

async function gotoAndSettle(page, query, predicate) {
  await page.goto(pageUrl(query), { waitUntil: "load" });
  await settle(page, predicate || (() => document.documentElement.dataset.pipelineMapReady === "1" && document.documentElement.dataset.pipelineSource === "document"));
}

let browserHalf = null;
try {
  browserHalf = await withBrowser(async ({ page, pageErrors, consoleErrors }) => {
    const requests = [];
    page.on("request", (r) => requests.push(r.url()));

    // ---- 1. ?doc=<url> through the panel's own reader --------------------------------------------------------------
    await gotoAndSettle(page, `?doc=${encodeURIComponent(indexSource)}`);
    const byUrl = await stateOf(page);
    check(byUrl.ready === "1" && byUrl.source === "document", "?doc= finished drawing and the page says it is a document", JSON.stringify({ ready: byUrl.ready, source: byUrl.source }));
    check(byUrl.shape === "index", `the factory's answer is read as an index (${byUrl.shape})`);
    check(byUrl.cards.length === 1 && byUrl.cards[0].id === "poc-breaking-suite", `one card, poc-breaking-suite (${byUrl.cards.map((c) => c.id).join(", ")})`);
    check(byUrl.cards[0].stages === 9 && byUrl.cards[0].nodes === 9, `nine stage nodes are drawn (data ${byUrl.cards[0].stages}, drawn ${byUrl.cards[0].nodes})`);
    check(byUrl.stages === "9" && byUrl.docCards === "1", `the page reports 9 stage nodes in 1 card (${byUrl.stages}/${byUrl.docCards})`);
    check(byUrl.sha === indexSha, `the provenance carries the sha256 of the served bytes (${byUrl.sha || "none"})`);
    check(byUrl.docSource === indexSource, `the source line names the URL that was asked for (${byUrl.docSource})`);
    check(byUrl.docIds === indexIds && byUrl.provenance.includes(indexIds), `the provenance prints the document id the index names (${byUrl.docIds || "none"})`);
    check(byUrl.provenance.includes(indexSource) && byUrl.provenance.includes(indexSha), "the provenance line prints the source and its full sha256", byUrl.provenance.slice(0, 320));
    check(/counted only/.test(byUrl.provenance) || /no stage names/.test(byUrl.provenance), "the page says an index counts stages instead of naming them", byUrl.provenance.slice(0, 320));
    check(byUrl.provenanceKind === "document", `the provenance line is the imported one (${byUrl.provenanceKind})`);
    const book = await page.evaluate(() => {
      const b = document.querySelector('#layout button[data-layout="book"]');
      return { disabled: b.disabled, title: b.title };
    });
    check(!book.disabled, "the counted index is a chain, so book mode stays available", JSON.stringify(book));

    if (shots) {
      mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: path.join(shots, "pipeline-import-url.png"), fullPage: false });
    }

    // ---- 2. the same JSON through the file input -------------------------------------------------------------------
    const before = Number(byUrl.seq);
    await page.setInputFiles("#doc-file", { name: "factory-index.json", mimeType: "application/json", buffer: indexBytes });
    await settle(page, (n) => Number(document.documentElement.dataset.pipelineDocSeq || 0) > n && document.documentElement.dataset.pipelineMapReady === "1", before);
    const byFile = await stateOf(page);
    check(byFile.cards.length === 1 && byFile.cards[0].nodes === 9, `the file input draws the same nine stage nodes (${byFile.nodes} nodes)`, JSON.stringify(byFile.cards));
    check(byFile.sha === indexSha, `the file's sha256 is the same hash the URL produced (${byFile.sha || "none"})`);
    check(/^file: /.test(byFile.docSource) && byFile.docSource.includes("factory-index.json"), `the source line says it is a file, and which one (${byFile.docSource})`);
    check(byFile.provenance.includes(indexSha) && byFile.provenance.includes("factory-index.json"), "the provenance line names the file and its sha256", byFile.provenance.slice(0, 320));

    if (shots) await page.screenshot({ path: path.join(shots, "pipeline-import-file.png"), fullPage: false });

    // ---- 3a. a malformed document by file input: visible error, page unchanged --------------------------------------
    await page.goto(pageUrl(), { waitUntil: "load" });
    await settle(page, () => document.documentElement.dataset.pipelineMapReady === "1");
    const builtIn = await stateOf(page);
    check(builtIn.source === "built-in" && builtIn.cards.length === 8 && builtIn.nodes === 36, `a plain open is the built-in catalogue (${builtIn.cards.length} cards, ${builtIn.nodes} nodes)`);
    check(/built in/i.test(builtIn.provenance) && builtIn.provenanceKind === "built-in", "the built-in drawing names its own two seed files", builtIn.provenance.slice(0, 260));

    await page.setInputFiles("#doc-file", { name: "broken.json", mimeType: "application/json", buffer: Buffer.from(BAD, "utf8") });
    await settle(page, () => Boolean(document.documentElement.dataset.pipelineDocError) && document.documentElement.dataset.pipelineMapReady === "1");
    const bad = await stateOf(page);
    check(bad.errorVisible, "a malformed file shows a visible error", bad.errorText);
    check(/not JSON/i.test(bad.errorText) && /broken\.json/.test(bad.errorText), `the error names the document and the parse failure (${bad.errorText.slice(0, 160)})`);
    check(bad.cards.length === 8 && bad.nodes === 36 && bad.cards.every((c) => c.ready === "1"), `the built-in drawing is untouched — ${bad.cards.length} cards, ${bad.nodes} stage nodes`, JSON.stringify(bad.cards));
    check(bad.source === "built-in" && /built in/i.test(bad.provenance), "the provenance line still says the drawing is the built-in catalogue", bad.provenance.slice(0, 160));

    if (shots) await page.screenshot({ path: path.join(shots, "pipeline-import-error.png"), fullPage: false });

    // ---- 3b. a malformed document by ?doc= ------------------------------------------------------------------------
    const badUrl = `${fixtureBase}/bad.json`;
    await page.goto(pageUrl(`?doc=${encodeURIComponent(badUrl)}`), { waitUntil: "load" });
    await settle(page, () => Boolean(document.documentElement.dataset.pipelineDocError) && document.documentElement.dataset.pipelineMapReady === "1");
    const badBoot = await stateOf(page);
    check(badBoot.errorVisible && /not JSON/i.test(badBoot.errorText), `?doc= with a malformed document errors visibly (${badBoot.errorText.slice(0, 160)})`);
    check(badBoot.cards.length === 8 && badBoot.nodes === 36, `?doc= that fails leaves the built-in drawing in place — ${badBoot.cards.length} cards, ${badBoot.nodes} nodes`);
    check(badBoot.source === "built-in", `a refused document does not claim to be drawn (${badBoot.source})`);

    // ---- 4. a real exported studio document, when one is given -----------------------------------------------------
    if (documentPath) {
      const bytes = readFileSync(documentPath);
      const docSha = sha(bytes);
      // Everything this block asserts comes from THE DOCUMENT, not from a constant: it used to hard-code the nine
      // stages of one pipeline, so it could not certify a second factory pipeline at all.
      const doc = JSON.parse(bytes.toString("utf8"));
      const docId = String((doc.project && doc.project.id) || doc.id || "");
      const docStages = Array.isArray(doc.stages) ? doc.stages.length : 0;
      const docTitles = (doc.stages || []).map((s) => String((s && (s.title || s.name || s.id)) || ""));
      const seqHandoffs = (Array.isArray(doc.handoffs) ? doc.handoffs : []).filter((h) => h && String(h.kind || "") === "sequence");
      const docIds = (doc.stages || []).map((s) => String((s && s.id) || ""));
      const chain =
        seqHandoffs.length === 0 ||
        (seqHandoffs.length === Math.max(0, docStages - 1) &&
          docIds.every((id, i) => i === docStages - 1 || seqHandoffs.some((h) => String(h.from) === id && String(h.to) === docIds[i + 1])));
      await page.goto(pageUrl(), { waitUntil: "load" });
      await settle(page, () => document.documentElement.dataset.pipelineMapReady === "1");
      await page.setInputFiles("#doc-file", { name: path.basename(documentPath), mimeType: "application/json", buffer: bytes });
      await settle(page, () => document.documentElement.dataset.pipelineSource === "document" && document.documentElement.dataset.pipelineMapReady === "1");
      const studio = await stateOf(page);
      check(studio.shape === "studio", `the exported document is read as a studio document (${studio.shape})`);
      check(studio.cards.length === 1 && studio.nodes === docStages, `it draws the document's ${docStages} stages (${studio.nodes} nodes)`, JSON.stringify(studio.cards));
      check(studio.sha === docSha, `its provenance is the file's own sha256 (${studio.sha})`);
      check(studio.docIds === docId && studio.provenance.includes(docId), `its provenance names the document it drew (${studio.docIds || "none"})`);
      check(
        studio.titles.every((t, i) => t.startsWith(`stage ${i + 1} of ${docStages}: ${docTitles[i]}.`)),
        "each node's accessible name is the document's own stage title, in its order",
        studio.titles.slice(0, 3).join(" | "),
      );
      check(studio.provenance.includes(docSha) && studio.provenance.includes(path.basename(documentPath)), "the provenance line names the file and its sha256", studio.provenance.slice(0, 320));
      const book = await page.evaluate(() => {
        const b = document.querySelector('#layout button[data-layout="book"]');
        return { disabled: b.disabled, title: b.title };
      });
      if (chain) check(!book.disabled, "a chain stays cuttable into rows, so book mode is offered", JSON.stringify(book));
      else check(book.disabled && /not one chain/.test(book.title), "book mode is refused for a document whose arrows converge, and says why", JSON.stringify(book));
      if (shots) await page.screenshot({ path: path.join(shots, "pipeline-import-studio.png"), fullPage: false });
    }

    check(consoleErrors.length === 0, "zero console errors", consoleErrors.join("\n"));
    check(pageErrors.length === 0, "zero page errors", pageErrors.join("\n"));
    check(requests.some((u) => u.includes("/api/pipeline-doc?url=")), "an http(s) ?doc= is read through the panel's /api/pipeline-doc, not fetched cross-origin", requests.filter((u) => u.includes("pipeline-doc")).join("\n"));

    return { byUrl, byFile, bad, nodes: byUrl.nodes };
  }, { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
} catch (e) {
  if (/no Playwright|BROWSER-HALF-NOT-RUN/i.test(String(e && e.message))) {
    console.error(`BROWSER-HALF-NOT-RUN: ${String(e && e.message)}`);
    if (fixture) fixture.close();
    await panel.stop();
    process.exit(2);
  }
  console.log(`FAIL  the browser half threw: ${String((e && e.stack) || e)}`);
  failures.push({ message: "browser half", detail: String((e && e.stack) || e) });
}

if (fixture) await new Promise((resolve) => fixture.close(resolve));
await panel.stop();

if (browserHalf) {
  check(browserHalf.nodes === 9, `the drawn document has nine stage nodes (${browserHalf.nodes})`);
}

if (failures.length) {
  console.log(`\n${failures.length} failed, ${passes} passed — pipeline import NOT proven`);
  process.exit(1);
}
console.log(`\n${passes} passed, 0 failed — pipeline import proven${live ? ` against ${live}` : " against the fixture"}`);
