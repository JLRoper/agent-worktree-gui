#!/usr/bin/env node
// Prove the catalogue's drawn page, tools/render-pipelines.mjs, against the thing it claims to be: ONE
// self-contained HTML file whose picture is the JSON, with mermaid inlined and nothing fetched at open time.
//
// The render is produced HERE, into a temp file, from the same seed + live catalogue the panel loads — so this
// harness cannot pass on a stale committed artefact, and a change to the renderer that quietly dropped a stage or
// an exit check fails before it can be committed.
//
// What it asserts, in the order the requirement names it:
//
//   1. the html PARSES — a tag-stack walk over the whole file, with <script>/<style> treated as raw text (that is
//      where the 2.5 MB bundle lives, and a `</script>` inside it would end the element early and break the page);
//   2. exactly one `flowchart LR` per pipeline definition — counted in the diagram blocks AND in the file, and
//      each block names a definition the loader actually holds;
//   3. every exit check name appears as an EDGE LABEL — per definition, per stage, the label is the check plus its
//      parameters, because that arrow is the condition the panel evaluates;
//   4. the mermaid blob is INLINED rather than linked — the vendored bytes are present verbatim, and no script,
//      link or stylesheet points at a URL;
//   5. the source sha256s are PRESENT — computed here from the files on disk, so a page whose hash disagrees with
//      the file it names fails instead of looking authoritative;
//   6. the ladder and the timestamp — `flowchart BT` with the upgrade direction marked, and an ISO generation time
//      that is actually now.
//
// A second, smaller pass writes a synthetic seed + live file and renders them, because the interesting half of the
// loader is the MERGE: a live definition must win per id, and a definition only the live file has must appear.
//
//   node tools/verify-pipelines-viz.mjs          quiet when green except the summary
//   VERIFY_KEEP=1 node tools/verify-pipelines-viz.mjs   keep the temp folder (the render, the fixtures)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mergeDocs, readPipelinesFile } from "../lib/pipelines.js";
import { resolveLayout } from "../lib/paths.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RENDER = path.join(REPO, "tools", "render-pipelines.mjs");
const VENDOR = path.join(REPO, "tools", "vendor", "mermaid.min.js");
const VIZ = path.join(REPO, "docs", "pipelines", "viz");
const seedPath = path.join(REPO, "pipelines.seed.json");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const norm = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const decode = (text) => String(text).replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m]);
// Mermaid's own entity codes, which the renderer writes so a label cannot be ended by a quote or eaten by a
// markdown pair of underscores. Reading a diagram source means decoding them the way mermaid will.
const MERMAID_CODES = { "#amp;": "&", "#35;": "#", "#lt;": "<", "#gt;": ">", "#quot;": '"', "#95;": "_", "#42;": "*", "#96;": "`", "#124;": "|" };
const mermaidDecode = (text) => String(text).replace(/#(?:amp|35|lt|gt|quot|95|42|96|124);/g, (m) => MERMAID_CODES[m]);

let checks = 0;
let failures = 0;
function ok(name, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`ok    ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function same(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// ---- 1. a real parse ----------------------------------------------------------------------------------------------
// A stack walk, not a regex: it is the only way to answer "does this document hold together" for a file whose bulk
// is one enormous <script>. Raw-text elements are skipped wholesale, which is exactly the rule a browser applies.
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
function parseHtml(text) {
  const errors = [];
  const stack = [];
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      if (end < 0) { errors.push("an unterminated comment"); break; }
      i = end + 3;
      continue;
    }
    if (text.startsWith("<!", lt)) {
      const end = text.indexOf(">", lt);
      if (end < 0) { errors.push("an unterminated declaration"); break; }
      i = end + 1;
      continue;
    }
    const gt = text.indexOf(">", lt);
    if (gt < 0) { errors.push(`an unterminated tag at ${lt}`); break; }
    const inner = text.slice(lt + 1, gt);
    const closing = inner.startsWith("/");
    const name = (closing ? inner.slice(1) : inner).trim().split(/[\s/]/)[0].toLowerCase();
    if (!name) { errors.push(`a tag with no name at ${lt}`); i = gt + 1; continue; }
    if (closing) {
      const top = stack.pop();
      if (top !== name) errors.push(`</${name}> at ${lt} closes <${top ?? "nothing"}>`);
    } else if (!inner.trimEnd().endsWith("/") && !VOID.has(name)) {
      stack.push(name);
      if (RAW_TEXT.has(name)) {
        const closeAt = text.toLowerCase().indexOf(`</${name}`, gt + 1);
        if (closeAt < 0) { errors.push(`<${name}> is never closed`); break; }
        const closeGt = text.indexOf(">", closeAt);
        if (closeGt < 0) { errors.push(`<${name}> is never closed`); break; }
        stack.pop();
        i = closeGt + 1;
        continue;
      }
    }
    i = gt + 1;
  }
  if (stack.length) errors.push(`never closed: ${stack.join(", ")}`);
  if (!/^<!doctype html>/i.test(text.trimStart())) errors.push("no doctype");
  return errors;
}

// ---- the catalogue the page must agree with, read here and not from the renderer ----------------------------------
const layout = resolveLayout({ here: REPO });
const livePath = layout.paths.pipelinesFile;
const doc = mergeDocs(readPipelinesFile(seedPath), existsSync(livePath) ? readPipelinesFile(livePath) : null);
const definitions = Object.values(doc.pipelines);
const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));

// The edge label this harness expects, built from the definition object: the check, then each parameter, and
// nothing else. Spelled out here (rather than imported from the renderer) so a renderer that stopped drawing
// parameters would fail instead of agreeing with itself.
const paramsOf = (exit) => Object.entries(exit || {})
  .filter(([key]) => key !== "check")
  .map(([key, value]) => `${key} ${Array.isArray(value) ? value.join(key === "argv" ? " " : ", ") : value}`)
  .join(", ");
const labelOf = (exit) => norm(`${exit?.check}${paramsOf(exit) ? ` (${paramsOf(exit)})` : ""}`);

const blocksOf = (html) => [...html.matchAll(/<pre[^>]*class="mermaid"[^>]*data-diagram="([^"]+)"[^>]*>([\s\S]*?)<\/pre>/g)]
  .map((match) => ({ id: match[1], text: mermaidDecode(decode(match[2])) }));

const dirStamp = (dir) => {
  try {
    return readdirSync(dir).sort().map((name) => {
      const st = statSync(path.join(dir, name));
      return `${name}:${st.size}:${Math.round(st.mtimeMs)}`;
    });
  } catch {
    return [];
  }
};

const tmp = mkdtempSync(path.join(os.tmpdir(), "wtgui-viz-"));
const render = (args) => spawnSync(process.execPath, [RENDER, ...args, "--quiet"], { cwd: REPO, encoding: "utf8", timeout: 120000 });

try {
  const out = path.join(tmp, "pipelines.html");
  const before = dirStamp(VIZ);
  const run = render(["--out", out]);
  ok("the renderer exits 0 and writes the file it was asked for", run.status === 0 && existsSync(out), `${(run.stderr || "").trim() || `exit ${run.status}`}`);
  same("--out leaves docs/pipelines/viz untouched (the index is not rewritten behind a caller's back)", dirStamp(VIZ), before);
  const html = readFileSync(out, "utf8");

  // 1. it parses
  same("the html parses: every element closes in order, rawness of <script> respected", parseHtml(html), []);
  ok("it is one document with a head and a body", /<html[\s>]/i.test(html) && /<head>/i.test(html) && /<body>/i.test(html));

  // 2. one flowchart LR per definition
  const blocks = blocksOf(html);
  const stageGraphs = blocks.filter((block) => block.id !== "ladder");
  same("one stage graph per definition, in the catalogue's own ids", stageGraphs.map((b) => b.id).sort(), definitions.map((d) => d.id).sort());
  same("each stage graph is a `flowchart LR`", [...new Set(stageGraphs.map((b) => (b.text.trim().split("\n")[0] || "")))], definitions.length ? ["flowchart LR"] : []);
  same("exactly one `flowchart LR` per definition in the diagram blocks", stageGraphs.map((b) => (b.text.match(/flowchart LR/g) || []).length), definitions.map(() => 1));
  same("...and the same count in the whole file (the bundle carries none)", (html.match(/flowchart LR/g) || []).length, definitions.length);
  ok("the vendor bundle contains no `flowchart LR` (so that count is the diagrams' own)", !readFileSync(VENDOR, "utf8").includes("flowchart LR"));

  // 3. every exit check as an edge label
  const missing = [];
  for (const def of definitions) {
    const block = stageGraphs.find((b) => b.id === def.id);
    if (!block) { missing.push(`${def.id}: no graph`); continue; }
    const labels = [...block.text.matchAll(/\|"([^"]+)"\|/g)].map((m) => norm(m[1]));
    def.stages.forEach((stage, index) => {
      const want = labelOf(stage.exit);
      if (!labels.includes(want)) missing.push(`${def.id} stage ${index + 1}: no edge labelled ${JSON.stringify(want)} (labels: ${JSON.stringify(labels)})`);
      else if (!labels.some((label) => label.startsWith(`${norm(stage.exit?.check)} `) || label === norm(stage.exit?.check))) missing.push(`${def.id} stage ${index + 1}: ${stage.exit?.check} appears nowhere as an edge label`);
    });
  }
  same("every stage's exit check is on an edge, with its parameters", missing, []);
  const checksOnPage = new Set(definitions.flatMap((d) => d.stages.map((s) => norm(s.exit?.check))));
  const edgeLabels = stageGraphs.flatMap((b) => [...b.text.matchAll(/\|"([^"]+)"\|/g)].map((m) => norm(m[1])));
  ok(`all ${checksOnPage.size} distinct exit checks are drawn as edge labels`, [...checksOnPage].every((check) => edgeLabels.some((label) => label === check || label.startsWith(`${check} `))), [...checksOnPage].join(", "));

  // 4. mermaid inlined, not linked
  const vendor = readFileSync(VENDOR, "utf8");
  ok("the vendored mermaid is inlined byte for byte", html.includes(vendor), `${vendor.length} bytes`);
  same("exactly two <script> elements: the bundle and its bootstrap", (html.match(/<script/gi) || []).length, 2);
  const outsideScripts = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  ok("no script, stylesheet, image or import points at a URL", !/<script[^>]+src=/i.test(html) && !/<link\b/i.test(outsideScripts) && !/<img\b/i.test(outsideScripts) && !/@import/i.test(outsideScripts) && !/url\(\s*['"]?(?:https?:)?\/\//i.test(html));
  ok("no attribute loads anything over the network", !/\b(?:src|href)\s*=\s*["'](?:https?:)?\/\//i.test(html));
  ok("the page still carries the diagram SOURCE, so it reads with scripting off", stageGraphs.every((block) => block.text.includes("-->")));

  // 5. the source hashes, and what they identify
  const seedSha = sha256(readFileSync(seedPath));
  ok("the seed's sha256 is on the page", html.includes(seedSha), seedSha);
  ok("...and the seed is named by path", html.includes("pipelines.seed.json"));
  if (existsSync(livePath)) {
    const liveSha = sha256(readFileSync(livePath));
    ok("the live catalogue's sha256 is on the page", html.includes(liveSha), `${livePath} ${liveSha}`);
    ok("...and the live path is named", html.includes(livePath) || html.includes(path.basename(livePath)));
  } else {
    ok("with no live file, the page says it is absent and reads the seed alone", /absent/i.test(html) && /seed alone/i.test(html), livePath);
  }

  // 6. the ladder, the version, the clock
  const ladder = blocks.find((block) => block.id === "ladder");
  ok("the ladder is drawn bottom-up (`flowchart BT`)", Boolean(ladder) && /^flowchart BT/.test(ladder.text.trim()), ladder ? ladder.text.split("\n")[0] : "missing");
  ok("...with all three rungs in order and the upgrade marked", Boolean(ladder) && ["local", "investigation", "turnover"].every((kind) => ladder.text.includes(kind)) && /upgrade/.test(ladder.text));
  ok("the page states the version it was generated at", html.includes(`v${pkg.version}`) && html.includes(`name="wtgui-pipelines-version" content="${pkg.version}"`), `v${pkg.version}`);
  const generatedAt = (/<meta name="wtgui-generated-at" content="([^"]+)"/.exec(html) || [])[1] || "";
  ok("the generation timestamp is ISO-8601 and is now", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(generatedAt) && Math.abs(Date.now() - Date.parse(generatedAt)) < 10 * 60 * 1000, generatedAt);
  same("the page numbers its definitions", (/<meta name="wtgui-pipelines-count" content="(\d+)"/.exec(html) || [])[1], String(definitions.length));

  // ---- the merge, driven with fixtures: the live file must win per id ----------------------------------------------
  const fixtureSeed = path.join(tmp, "seed.json");
  const fixtureLive = path.join(tmp, "live.json");
  const fixtureOut = path.join(tmp, "fixture.html");
  writeFileSync(fixtureSeed, JSON.stringify({
    version: 1,
    pipelines: [
      { id: "alpha", kind: "local", title: "Alpha", stages: [{ id: "only", title: "Seed stage", prompt: "Do the seed thing.", exit: { check: "clean" } }] },
      { id: "beta", kind: "turnover", title: "Beta", stages: [{ id: "land", title: "Land", prompt: "Land it.", exit: { check: "pr-merged" } }] },
    ],
  }, null, 2));
  writeFileSync(fixtureLive, JSON.stringify({
    version: 1,
    pipelines: [
      { id: "alpha", kind: "local", title: "Alpha (live)", stages: [
        { id: "first", title: "Live one", prompt: "First live stage.", exit: { check: "commits", min: 2 } },
        { id: "second", title: "Live two", prompt: "Second live stage.", exit: { check: "file-exists", path: "docs/x.md" } },
      ] },
      { id: "gamma", kind: "local", title: "Gamma", stages: [{ id: "g", title: "Gamma stage", prompt: "Gamma.", exit: { check: "clean" } }] },
    ],
  }, null, 2));
  const fixtureRun = render(["--seed", fixtureSeed, "--live", fixtureLive, "--out", fixtureOut]);
  ok("a fixture seed + live file render", fixtureRun.status === 0 && existsSync(fixtureOut), (fixtureRun.stderr || "").trim());
  if (existsSync(fixtureOut)) {
    const fixtureHtml = readFileSync(fixtureOut, "utf8");
    const fixtureBlocks = blocksOf(fixtureHtml).filter((block) => block.id !== "ladder");
    same("the merge takes the live override, keeps the seed-only definition and adds the live-only one", fixtureBlocks.map((b) => b.id).sort(), ["alpha", "beta", "gamma"]);
    ok("the live definition wins per id (its two stages, not the seed's one)", !fixtureHtml.includes("Do the seed thing.") && fixtureHtml.includes("First live stage.") && fixtureHtml.includes("Second live stage."));
    ok("the live strategy's own exit is drawn", fixtureBlocks.find((b) => b.id === "alpha").text.includes("commits (min 2)"));
    ok("the fixture page hashes the fixture live file, not the panel's", fixtureHtml.includes(sha256(readFileSync(fixtureLive))) && !fixtureHtml.includes(sha256(readFileSync(seedPath))));
  }

  // ---- the index: the folder IS the history, so it has to list every render in it, newest first -------------------
  const indexDir = path.join(tmp, "viz");
  mkdirSync(indexDir, { recursive: true });
  const datedName = `pipelines-${pkg.version}.html`;
  const first = render(["--dir", indexDir, "--seed", fixtureSeed, "--live", fixtureLive]);
  ok("--dir writes the dated render and an index beside it", first.status === 0 && existsSync(path.join(indexDir, datedName)) && existsSync(path.join(indexDir, "index.html")), (first.stderr || "").trim());
  if (existsSync(path.join(indexDir, datedName))) {
    // An older release's render, already in the folder: the index must keep it and must put it second.
    const current = readFileSync(path.join(indexDir, datedName), "utf8");
    const older = current
      .replace(`<meta name="wtgui-pipelines-version" content="${pkg.version}">`, '<meta name="wtgui-pipelines-version" content="0.0.1">')
      .replace(/<meta name="wtgui-generated-at" content="[^"]+">/, '<meta name="wtgui-generated-at" content="2020-01-01T00:00:00Z">');
    writeFileSync(path.join(indexDir, "pipelines-0.0.1.html"), older, "utf8");
    render(["--dir", indexDir, "--seed", fixtureSeed, "--live", fixtureLive]);
    const indexHtml = readFileSync(path.join(indexDir, "index.html"), "utf8");
    ok("the index links every render in the folder, the older one included", indexHtml.includes(datedName) && indexHtml.includes("pipelines-0.0.1.html"));
    ok("...newest first: the current version's row comes before 0.0.1's", indexHtml.indexOf(datedName) < indexHtml.indexOf("pipelines-0.0.1.html"));
    ok("...and it dates each row from the render's own timestamp", indexHtml.includes("2020-01-01T00:00:00Z"));
    ok("the index is self-contained too (no external script or stylesheet)", !/<script[^>]+src=/i.test(indexHtml) && !/<link\b/i.test(indexHtml));
  }
} catch (error) {
  failures += 1;
  console.log(`FAIL  the harness threw: ${String((error && error.stack) || error)}`);
} finally {
  if (process.env.VERIFY_KEEP === "1") console.log(`\n      VERIFY_KEEP=1 — the render and fixtures are at ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

console.log(`\n${checks} checks, ${failures} failed.`);
process.exit(failures ? 1 : 0);
