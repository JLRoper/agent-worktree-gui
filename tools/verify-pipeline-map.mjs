#!/usr/bin/env node
// tools/verify-pipeline-map.mjs — prove public/pipeline-map.html against the thing it claims to be.
//
// The page is generated (tools/render-pipeline-map.mjs) from pipelines.seed.json and pipeline-bundle.seed.json and
// loads mermaid from an INLINE copy of tools/vendor/mermaid.min.js. This harness does not re-render a fixture: it
// reads the committed page, drives it in Chromium, and asserts the four things the brief names:
//
//   1. every definition and the bundle render, with the right node count — 7 + 1 cards, 23 + 13 stage nodes;
//   2. every node is two lines: ordinal + title, then a role line — `derived:` for a catalogue stage, `role:` for
//      a bundle stage — and every derived line's evidence is a substring of that stage's own prompt;
//   3. the loop-backs: the bundle's three carried loops (caps included) and sefl-review-loop's ONE inferred edge,
//      drawn and named as an inference in the legend and the card;
//   4. both layouts (horizontal scroll and book rows of N) keep the smallest painted label at 11 px or more, with
//      zero console errors, zero page errors and zero network requests beyond the page and its own script.
//
//   node tools/verify-pipeline-map.mjs                 assert; exit 0 green, 1 red
//   node tools/verify-pipeline-map.mjs --shots <dir>   also write row/book at 1280 and 1824 (evidence)
//   node tools/verify-pipeline-map.mjs --quiet         only failures + the final line
//
// Exit codes: 0 pass; 1 a failed assertion; 2 the browser half could not run (no Playwright).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withBrowser } from "./browser.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = path.join(REPO, "public", "pipeline-map.html");
const SCRIPT = path.join(REPO, "public", "pipeline-map.js");
const RENDER = path.join(REPO, "tools", "render-pipeline-map.mjs");

const EXPECT = [
  ["local", 1],
  ["investigate", 2],
  ["turnover", 3],
  ["github-investigate", 2],
  ["sefl-investigate", 2],
  ["github-force-merge", 6],
  ["sefl-review-loop", 7],
  ["poc-to-uat", 13],
];

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
let shots = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--shots") shots = path.resolve(args[++i] || "");
  else if (args[i] === "--quiet") { quiet = true; }
  else if (args[i] === "--help" || args[i] === "-h") { console.log("node tools/verify-pipeline-map.mjs [--shots <dir>] [--quiet]"); process.exit(0); }
  else { console.error(`unknown argument ${JSON.stringify(args[i])}`); process.exit(2); }
}
if (args.includes("--shots") && (!shots || shots === REPO)) { console.error("--shots needs a directory"); process.exit(2); }

if (!existsSync(PAGE) || !existsSync(SCRIPT)) {
  console.error(`pipeline-map: ${existsSync(PAGE) ? "the script" : "the page"} is missing — run node tools/render-pipeline-map.mjs`);
  process.exit(1);
}

// The committed page must still describe the two seeds it names. The renderer owns that comparison.
const freshness = spawnSync(process.execPath, [RENDER, "--check", "--quiet"], { cwd: REPO, encoding: "utf8" });
check(freshness.status === 0, "the committed page is current against both seed files", (freshness.stderr || freshness.stdout || "").trim());

const markup = readFileSync(PAGE, "utf8");
const dataMatch = markup.match(/<script id="pipeline-map-data" type="application\/json">([\s\S]*?)<\/script>/);
const DATA = dataMatch ? JSON.parse(dataMatch[1].replace(/\\u003c/g, "<")) : null;

if (!DATA) {
  console.log("FAIL  the page carries no readable pipeline-map-data block");
  process.exit(1);
}

const roleRules = new Map(DATA.meta.roleRules.map((r) => [r.id, r]));
check(DATA.pipelines.length === 7, `seven catalogue definitions in the data (${DATA.pipelines.length})`);
check(DATA.meta.totalStages === 23, `23 catalogue stage nodes in the data (${DATA.meta.totalStages})`);
check(DATA.bundle.stages.length === 13, `13 bundle stage nodes in the data (${DATA.bundle.stages.length})`);
check(DATA.bundle.gates.length === 5, `5 bundle gates in the data (${DATA.bundle.gates.length})`);

// Every derived role names a rule in the closed table, and its evidence is literally in the prompt.
let derivedOk = true;
const derivedBad = [];
for (const p of DATA.pipelines) {
  for (const stage of p.stages) {
    if (stage.role.source !== "derived") { derivedOk = false; derivedBad.push(`${p.id}/${stage.id}: source ${stage.role.source}`); continue; }
    const rule = roleRules.get(stage.role.rule);
    if (!rule) { derivedOk = false; derivedBad.push(`${p.id}/${stage.id}: unknown rule ${stage.role.rule}`); continue; }
    if (stage.role.label !== `derived: ${rule.label}`) { derivedOk = false; derivedBad.push(`${p.id}/${stage.id}: label does not match rule "${stage.role.rule}"`); continue; }
    if (!stage.prompt.includes(stage.role.evidence)) { derivedOk = false; derivedBad.push(`${p.id}/${stage.id}: evidence not in prompt: ${JSON.stringify(stage.role.evidence)}`); }
  }
}
check(derivedOk, "every catalogue role is derived from a known rule, with its phrase present in the prompt", derivedBad.join("\n"));

let assignedOk = true;
const assignedBad = [];
for (const stage of DATA.bundle.stages) {
  if (stage.role.source !== "assigned") { assignedOk = false; assignedBad.push(`${stage.id}: source ${stage.role.source}`); continue; }
  if (!stage.role.owner || !stage.role.kind) { assignedOk = false; assignedBad.push(`${stage.id}: no owner/kind`); continue; }
  if (!stage.role.label.startsWith("role: ")) { assignedOk = false; assignedBad.push(`${stage.id}: label ${JSON.stringify(stage.role.label)}`); }
}
check(assignedOk, "every bundle role is the owner's own name and kind (assigned, not derived)", assignedBad.join("\n"));

const carried = DATA.bundle.loops.filter((l) => l.source === "data");
const inferred = DATA.pipelines.flatMap((p) => p.loops).filter((l) => l.source === "inferred");
check(carried.length === 3 && carried.every((l) => l.cap), `the bundle carries its three capped loops (${carried.map((l) => l.id).join(", ")})`);
check(inferred.length === 1 && inferred[0].from === "approve" && inferred[0].to === "address", "sefl-review-loop carries exactly one inferred loop, approve → address", JSON.stringify(inferred));
check(/inference/i.test(markup) && /declares no loop/i.test(markup), "the page's legend and copy name the inferred edge as an inference, not a field");

let browserHalf = null;
try {
  const result = await withBrowser(async ({ page, pageErrors, consoleErrors }) => {
    const requests = [];
    page.on("request", (r) => requests.push(r.url()));
    await page.goto("file:///" + PAGE.replace(/\\/g, "/"), { waitUntil: "load" });
    await page.waitForFunction(() => document.documentElement.dataset.pipelineMapReady === "1", null, { timeout: 60000 });

    async function readLayout(layout, perRow) {
      return page.evaluate(({ expected, layoutName }) => {
        const cards = [...document.querySelectorAll(".pm-card")].map((c) => {
          const draw = c.querySelector("[data-draw]");
          const nodes = [...draw.querySelectorAll("g.node[data-stage]")];
          const roles = nodes.map((n) => ({
            id: n.getAttribute("data-stage"),
            source: n.getAttribute("data-role-source"),
            label: n.getAttribute("data-role-label"),
            title: n.getAttribute("title") || "",
            svgTitle: n.querySelector(":scope > title")?.textContent || "",
            roleText: n.querySelector(".pm-role")?.textContent || "",
            lines: (() => {
              const p = n.querySelector(".nodeLabel p");
              if (!p) return null;
              const cs = getComputedStyle(p);
              const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
              return Math.round(p.getBoundingClientRect().height / lh);
            })(),
          }));
          return {
            id: c.dataset.card,
            stages: Number(c.dataset.stages),
            nodeCount: Number(c.dataset.nodeCount),
            loopCount: Number(c.dataset.loopCount),
            min: Number(c.dataset.minLabel),
            hidden: Number(c.dataset.hidden),
            rows: Number(c.dataset.rows),
            ready: c.dataset.ready,
            svgs: draw.querySelectorAll("svg").length,
            edges: draw.querySelectorAll("g.edgePath, path.flowchart-link").length,
            loops: [...draw.querySelectorAll("path[data-loop-source]")].map((p) => p.getAttribute("data-loop-source")),
            loopText: [...draw.querySelectorAll(".edgeLabel, .pm-arcs text")].map((t) => t.textContent.trim()).filter(Boolean),
            roleLines: roles,
            loopsList: c.querySelector(".pm-loops")?.textContent || "",
            gatesList: c.querySelector(".pm-gates")?.textContent || "",
          };
        });
        return { layout: layoutName, cards, ready: document.documentElement.dataset.pipelineMapReady, drawCount: document.getElementById("draw-count").textContent };
      }, { expected: EXPECT, layoutName: layout });
    }

    const row = await readLayout("row");
    check(row.ready === "1", "row layout finished drawing");
    check(row.cards.length === EXPECT.length, `row layout has ${EXPECT.length} cards (${row.cards.length})`);
    check(row.drawCount.includes(`${EXPECT.length} of ${EXPECT.length}`), `row layout reports all cards drawn (${row.drawCount})`);
    let rowCounts = true;
    const rowCountsBad = [];
    for (const [id, n] of EXPECT) {
      const card = row.cards.find((c) => c.id === id);
      if (!card) { rowCounts = false; rowCountsBad.push(`${id}: card missing`); continue; }
      if (card.stages !== n || card.nodeCount !== n) { rowCounts = false; rowCountsBad.push(`${id}: data ${card.stages}, drawn ${card.nodeCount}, expected ${n}`); }
      if (card.min < 11) { rowCounts = false; rowCountsBad.push(`${id}: smallest label ${card.min}px`); }
      if (card.roleLines.length !== n) { rowCounts = false; rowCountsBad.push(`${id}: ${card.roleLines.length} nodes with a role, expected ${n}`); }
    }
    check(rowCounts, "row layout draws every stage of all seven pipelines and the bundle at 11 px or more", rowCountsBad.join("\n"));
    check(row.cards[0].min >= 11, `row layout's smallest painted label is ${row.cards[0].min} px`);

    // two lines: ordinal + title, then the role. Every node in both the catalogue and the bundle.
    let twoLines = true;
    const twoBad = [];
    for (const card of row.cards) {
      for (const role of card.roleLines) {
        const okay = role.lines === 2 && /^(derived|role): /.test(role.roleText) && role.roleText === role.label;
        if (!okay) { twoLines = false; twoBad.push(`${card.id}/${role.id}: lines=${role.lines}, role=${JSON.stringify(role.roleText)}, label=${JSON.stringify(role.label)}`); }
      }
    }
    check(twoLines, "every node is exactly two lines: ordinal + title, then the role line", twoBad.join("\n"));

    // prompt on hover: the title attribute AND the SVG <title> child carry the stage's own prompt (or purpose).
    let hover = true;
    const hoverBad = [];
    for (const card of row.cards) {
      const model = card.id === "poc-to-uat" ? DATA.bundle : DATA.pipelines.find((p) => p.id === card.id);
      for (const role of card.roleLines) {
        const stage = model.stages.find((s) => s.id === role.id);
        if (!stage) { hover = false; hoverBad.push(`${card.id}/${role.id}: no stage`); continue; }
        const source = stage.prompt || stage.purpose || "";
        if (!source || !role.title.includes(source.slice(0, Math.min(60, source.length)))) {
          hover = false; hoverBad.push(`${card.id}/${role.id}: title does not carry the prompt/purpose`);
        }
        if (!role.svgTitle || role.svgTitle !== role.title) { hover = false; hoverBad.push(`${card.id}/${role.id}: SVG <title> differs`); }
      }
    }
    check(hover, "each node's prompt (or bundle purpose) is on hover — title attribute and SVG <title>", hoverBad.join("\n"));

    // loops: each one has a drawn path and the card's list names it; the bundle's own loops carry their cap.
    let loopsOk = true;
    const loopsBad = [];
    for (const card of row.cards) {
      const model = card.id === "poc-to-uat" ? DATA.bundle : DATA.pipelines.find((p) => p.id === card.id);
      if (card.loopCount !== (model.loops || []).length) { loopsOk = false; loopsBad.push(`${card.id}: ${card.loopCount} loop paths, expected ${(model.loops || []).length}`); }
      for (const loop of model.loops || []) {
        if (!card.loops.includes(loop.source)) { loopsOk = false; loopsBad.push(`${card.id}/${loop.id}: no ${loop.source} path`); }
        if (!card.loopsList.includes(loop.short)) { loopsOk = false; loopsBad.push(`${card.id}/${loop.id}: not named in the loop list`); }
      }
    }
    check(loopsOk, "row layout draws every loop the data carries, and names each one", loopsBad.join("\n"));
    const bundleCard = row.cards.find((c) => c.id === "poc-to-uat");
    check(carried.every((l) => row.cards.find((c) => c.id === "poc-to-uat").loopText.some((t) => t.includes(l.id))), "the bundle's three loop edges carry H-10/H-12/H-15 labels", JSON.stringify(row.cards.find((c) => c.id === "poc-to-uat").loopText));
    check(/3 rounds \(P-50\)/.test(bundleCard.loopsList) && /2 re-deliveries/.test(bundleCard.loopsList), "the bundle's caps are printed in its loop list (3 rounds (P-50), 2 re-deliveries)");
    check(DATA.bundle.gates.every((g) => bundleCard.gatesList.includes(g.id)) && /13 UAT sign-off/.test(bundleCard.gatesList), "the bundle's five gates are listed, including G4 after stage 13", bundleCard.gatesList.slice(0, 280));

    // one inferred edge, amber, exactly one, in the definition named in the legend.
    const review = row.cards.find((c) => c.id === "sefl-review-loop");
    check(review.loops.filter((s) => s === "inferred").length === 1, "sefl-review-loop has exactly one inferred loop path in the drawing", JSON.stringify(review.loops));
    check(/inferred/i.test(review.loopsList) && /declares no loop/i.test(review.loopsList), "sefl-review-loop's loop list says it is inferred and why", review.loopsList.slice(0, 240));

    // ---- book layout ------------------------------------------------------------------------------------------
    await page.click('#layout button[data-layout="book"]');
    await page.waitForFunction(() => document.documentElement.dataset.pipelineMapReady === "1", null, { timeout: 60000 });
    const book = await readLayout("book");
    check(book.cards.length === EXPECT.length, `book layout has ${EXPECT.length} cards (${book.cards.length})`);
    let bookCounts = true;
    const bookBad = [];
    for (const [id, n] of EXPECT) {
      const card = book.cards.find((c) => c.id === id);
      if (!card) { bookCounts = false; bookBad.push(`${id}: card missing`); continue; }
      if (card.nodeCount !== n) { bookCounts = false; bookBad.push(`${id}: drawn ${card.nodeCount}, expected ${n}`); }
      if (card.min < 11) { bookCounts = false; bookBad.push(`${id}: smallest label ${card.min}px`); }
      if (card.rows !== Math.ceil(n / 3)) { bookCounts = false; bookBad.push(`${id}: ${card.rows} rows, expected ${Math.ceil(n / 3)}`); }
    }
    check(bookCounts, "book layout draws every stage, in rows of 3, at 11 px or more", bookBad.join("\n"));
    check(book.cards.every((c) => c.min >= 11), "book layout's smallest painted label is 11 px or more");
    const bookBundle = book.cards.find((c) => c.id === "poc-to-uat");
    check(bookBundle.loops.filter((s) => s === "data").length === 3, "book layout draws the bundle's three carried loops in the margin", JSON.stringify(bookBundle.loops));
    check(book.cards.find((c) => c.id === "sefl-review-loop").loops.filter((s) => s === "inferred").length === 1, "book layout draws sefl-review-loop's one inferred loop in the margin");
    check(bookBundle.min >= 11 && book.cards.find((c) => c.id === "sefl-review-loop").min >= 11, "book mode keeps the arc tags and node roles at 11 px or more");

    // the 4-per-row control is a real layout, not a label
    await page.click('#per-row button[data-n="4"]');
    await page.waitForFunction(() => document.documentElement.dataset.pipelineMapReady === "1", null, { timeout: 60000 });
    const four = await readLayout("book");
    check(four.cards.find((c) => c.id === "poc-to-uat").rows === 4, "rows-of-4 control re-wraps the 13-stage bundle into 4 rows");
    check(four.cards.every((c) => c.nodeCount === EXPECT.find(([id]) => id === c.id)[1]), "rows-of-4 keeps every stage node");

    // back to the row layout, then click a node: the inspector must carry the full prompt.
    await page.click('#layout button[data-layout="row"]');
    await page.waitForFunction(() => document.documentElement.dataset.pipelineMapReady === "1", null, { timeout: 60000 });
    await page.click('.pm-card[data-card="local"] g.node[data-stage="work"]');
    const ins = await page.evaluate(() => ({
      hidden: document.getElementById("inspector").hidden,
      title: document.getElementById("inspector-title").textContent,
      who: document.getElementById("inspector-who").textContent,
      prompt: document.getElementById("inspector-prompt").textContent,
      why: document.getElementById("inspector-why").textContent,
    }));
    check(!ins.hidden && /Work in this tree/.test(ins.title) && /^derived: /.test(ins.who) && ins.prompt.includes("Do the work in this tree") && /rule "work"/.test(ins.why), "clicking a node opens the inspector with the full prompt and the derivation", JSON.stringify(ins).slice(0, 400));
    await page.keyboard.press("Escape");
    check(await page.evaluate(() => document.getElementById("inspector").hidden), "Escape closes the inspector");

    // no network: the page and its own script are file URLs; no CDN, no API, no font fetch.
    const external = requests.filter((u) => !u.startsWith("file://") && !u.startsWith("data:"));
    check(external.length === 0, "the page makes no network request (mermaid is inlined, no CDN)", external.join("\n"));
    check(requests.length >= 2 && requests.some((u) => u.endsWith("pipeline-map.js?v=" + DATA.meta.version)), `the page loads its own script (${requests.length} request(s))`);

    check(consoleErrors.length === 0, "zero console errors", consoleErrors.join("\n"));
    check(pageErrors.length === 0, "zero page errors", pageErrors.join("\n"));

    if (shots) {
      mkdirSync(shots, { recursive: true });
      for (const [w, h] of [[1280, 900], [1824, 900]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.click('#layout button[data-layout="row"]');
        await page.waitForFunction(() => document.documentElement.dataset.pipelineMapReady === "1", null, { timeout: 60000 });
        await page.screenshot({ path: path.join(shots, `pipeline-map-row-${w}.png`), fullPage: true });
        await page.click('#layout button[data-layout="book"]');
        await page.waitForFunction(() => document.documentElement.dataset.pipelineMapReady === "1", null, { timeout: 60000 });
        await page.click('#per-row button[data-n="3"]');
        await page.waitForFunction(() => document.documentElement.dataset.pipelineMapReady === "1", null, { timeout: 60000 });
        await page.screenshot({ path: path.join(shots, `pipeline-map-book-${w}.png`), fullPage: true });
      }
      console.log(`wrote 4 screenshots to ${shots}`);
    }

    return { cards: row.cards.length, nodes: row.cards.reduce((n, c) => n + c.nodeCount, 0) };
  }, { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  browserHalf = result;
} catch (e) {
  if (/no Playwright|BROWSER-HALF-NOT-RUN/i.test(String(e && e.message))) {
    console.error(`BROWSER-HALF-NOT-RUN: ${String(e && e.message)}`);
    process.exit(2);
  }
  console.log(`FAIL  the browser half threw: ${String((e && e.stack) || e)}`);
  failures.push({ message: "browser half", detail: String((e && e.stack) || e) });
}

if (browserHalf) {
  check(browserHalf.cards === 8 && browserHalf.nodes === 36, `36 stage nodes across 8 cards (${browserHalf.nodes} across ${browserHalf.cards})`);
}

if (failures.length) {
  console.log(`\n${failures.length} failed, ${passes} passed — pipeline-map NOT proven`);
  process.exit(1);
}
console.log(`\n${passes} passed, 0 failed — pipeline-map proven`);
