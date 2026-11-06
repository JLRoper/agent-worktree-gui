#!/usr/bin/env node
// tools/render-pipelines.mjs — the pipeline catalogue, DRAWN: one self-contained HTML page.
//
// WHY. The catalogue is data (pipelines.seed.json, overridden per id by the reader's pipelines.json), and a data
// catalogue is easy to read one definition at a time and nearly impossible to hold in your head. The design page
// (docs/pipelines.md) states the rules; this page shows what the RULES HAVE PRODUCED: for every definition, the
// stages in order, the exit that ends each one with its parameters, the places a prompt can have a hole, and what
// the definition chains into. The drawing is derived from the same loader the panel runs (lib/pipelines.js
// `readPipelinesFile` + `mergeDocs`), so the picture cannot drift from the JSON: a stage the reader adds is a node
// on the next render, and an exit check the tab refuses is a stage that never appears.
//
// THE OUTPUT IS ONE FILE AND IT OPENS OFFLINE. Mermaid is vendored at tools/vendor/mermaid.min.js and inlined into
// the page; there is no CDN link, no font fetch, no network at all at open time. That is deliberate: a render is an
// artefact somebody may open on a laptop with no route out, months after it was made, and it still has to draw.
//
// TWO FILES, ONE OF THEM AN INDEX. A render is written as docs/pipelines/viz/pipelines-<version>.html and the index
// beside it (docs/pipelines/viz/index.html) is rewritten to list every render in the folder, newest first. The
// version in the name is the panel's own (package.json `version`), so the FOLDER is the history: nothing is ever
// overwritten by a later release, and an old render keeps drawing what the catalogue said then.
//
// AND IT SAYS WHAT IT READ. Every source file is named with its sha256, beside the version and the generation
// timestamp. A render whose sha256 no longer matches the file on disk is stale, and the page says so in one line —
// the alternative is a picture that looks authoritative and describes last week's catalogue.
//
//   node tools/render-pipelines.mjs                      the dated render + the index
//   node tools/render-pipelines.mjs --out <file>         one file, nothing else (what verify-pipelines-viz uses)
//   node tools/render-pipelines.mjs --live none          the seed alone, ignoring the panel's state folder
//   node tools/render-pipelines.mjs --seed <file>        a different seed (a fixture, a branch)
//   node tools/render-pipelines.mjs --fetch-mermaid      re-download the vendored bundle (build time only)
//   node tools/render-pipelines.mjs --quiet              no summary lines
//
// Exit codes: 0 rendered; 1 the catalogue could not be read or written; 2 a usage mistake (or no vendored mermaid).
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveLayout } from "../lib/paths.js";
import { REPORT_FOOTER_CSS, reportFooter, resolveReportProvenance } from "../lib/report-footer.js";
import {
  DEFAULT_SEED_FILE,
  KIND_RANK,
  PIPELINE_KINDS,
  PIPELINES_VERSION,
  mergeDocs,
  promptPlaceholders,
  readPipelinesFile,
} from "../lib/pipelines.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const VIZ_DIR = path.join(REPO, "docs", "pipelines", "viz");
const INDEX_NAME = "index.html";
const VENDOR_REL = "tools/vendor/mermaid.min.js";
const VENDOR_FILE = path.join(REPO, VENDOR_REL);
const MERMAID_VERSION = "11.4.1";
const MERMAID_URL = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js`;

// The one-line description of each rung, from docs/pipelines.md §1.2. The graph is drawn from PIPELINE_KINDS (data),
// but "what this rung may do" is a rule about the panel and has no field in the JSON to read it from.
const KIND_MAY = {
  local: "commit, report. No push, no pull request — the panel's behaviour before pipelines existed.",
  investigation: "read, probe, run things, commit evidence. Ends by concluding; may open a draft PR if the project allows it.",
  turnover: "push, open the PR, answer review, merge when the host's rule says it is merged.",
};

// ---- small utilities ---------------------------------------------------------------------------------------------

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (n) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} kB` : `${n} B`);
const oneLine = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

// HTML text and attributes. Everything a definition carries goes through this: a prompt with `<TICKET>` and a
// regex with `&&` are both ordinary text here, never markup.
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Mermaid label text. A label is delimited by `"` and read by a parser that also understands entity codes, so the
// five characters that would end or change the label are emitted as codes instead — and `_`/`*`/backtick go the
// same way because a v11 label is markdown, where a pair of underscores is an italic and a snake_case name loses
// them. Verified with a real mermaid render: every one of these round-trips to the character it replaces.
const MERMAID_CODES = { "&": "#amp;", "#": "#35;", "<": "#lt;", ">": "#gt;", '"': "#quot;", _: "#95;", "*": "#42;", "`": "#96;", "|": "#124;" };
const mermaidText = (text) => [...oneLine(text)].map((c) => MERMAID_CODES[c] ?? c).join("");

const firstLine = (prompt) => oneLine(String(prompt ?? "").split(/\r?\n/).find((line) => line.trim()) ?? "");

function exitCheck(exit) {
  const check = oneLine(exit?.check);
  return check || "(no check — a stage the loader refuses)";
}

// Every parameter of an exit, in the JSON's own order: `min 1`, `path docs/investigation.md`, `argv node ...`.
function exitParams(exit) {
  const out = [];
  for (const [key, value] of Object.entries(exit || {})) {
    if (key === "check") continue;
    out.push([key, Array.isArray(value) ? value.join(key === "argv" ? " " : ", ") : String(value)]);
  }
  return out;
}

// The edge label: the check and its parameters, and nothing else — this is the sentence the panel evaluates.
function exitLabel(exit) {
  const parts = exitParams(exit);
  return parts.length ? `${exitCheck(exit)} (${parts.map(([k, v]) => `${k} ${v}`).join(", ")})` : exitCheck(exit);
}

const versionCompare = (a, b) => {
  const parse = (v) => String(v).replace(/^v/, "").split(/[.+-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const [p, q] = [x[i] ?? 0, y[i] ?? 0];
    if (typeof p === "number" && typeof q === "number") {
      if (p !== q) return p - q;
    } else if (typeof p === "number") return 1;
    else if (typeof q === "number") return -1;
    else if (String(p).localeCompare(String(q))) return String(p).localeCompare(String(q));
  }
  return 0;
};

// ---- the catalogue, read the way the panel reads it ---------------------------------------------------------------
// `readPipelinesFile` validates and drops a bad definition BY ID; `mergeDocs` layers the live file over the seed per
// id and prunes chains. Doing the merge here rather than re-implementing it is the whole point: a render that
// disagreed with the panel about which definitions are in force would be a second, quieter catalogue.
function loadCatalogue({ seedFile, liveFile }) {
  const seedDoc = readPipelinesFile(seedFile);
  const liveDoc = liveFile ? readPipelinesFile(liveFile) : null;
  const doc = mergeDocs(seedDoc, liveDoc);
  const definitions = Object.values(doc.pipelines)
    .map((def) => ({ ...def, id: oneLine(def.id) }))
    .sort((a, b) => (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) || a.id.localeCompare(b.id));
  return { doc, definitions };
}

function describeFile(file, role, label) {
  if (!file) return { role, label, file: null, exists: false, why: "not named for this render" };
  const resolved = path.resolve(file);
  try {
    const st = statSync(resolved);
    return { role, label, file: resolved, exists: st.isFile(), bytes: st.size, modified: new Date(st.mtimeMs).toISOString(), sha256: sha256(readFileSync(resolved)) };
  } catch {
    return { role, label, file: resolved, exists: false, why: "not there" };
  }
}

// ---- the diagrams -------------------------------------------------------------------------------------------------
// A stage is a node; the edge OUT of a stage is labelled with that stage's exit, so the arrow itself is the
// condition the panel evaluates. The last stage's exit needs an edge to land on, so the graph has a terminal node:
// without it the final check would have nowhere to be drawn, and a checker could not see it in the picture at all.
function flowchartFor(def) {
  const lines = ["flowchart LR"];
  const ids = def.stages.map((_, index) => `s${index}`);
  def.stages.forEach((stage, index) => {
    // The number is written "1 · stage" and NOT "1. stage": a mermaid v11 label is markdown, and "1." at the start
    // of a line is an ordered-list marker — mermaid answers it with "Unsupported markdown: list" in place of the
    // label, which is exactly the drift this page exists to prevent.
    lines.push(`  ${ids[index]}["${mermaidText(`${index + 1} · ${oneLine(stage.title)} — ${firstLine(stage.prompt)}`)}"]`);
  });
  const endLabel = def.next ? `pipeline ends · next → ${def.next}` : "pipeline ends";
  lines.push(`  fin(["${mermaidText(endLabel)}"])`);
  def.stages.forEach((stage, index) => {
    const to = index + 1 < ids.length ? ids[index + 1] : "fin";
    lines.push(`  ${ids[index]} -->|"${mermaidText(exitLabel(stage.exit))}"| ${to}`);
  });
  lines.push("  classDef stage fill:#1b2029,stroke:#333b49,color:#e6e9ef,stroke-width:1px");
  lines.push(`  class ${ids.join(",")} stage`);
  lines.push("  classDef finish fill:#12261a,stroke:#2ea043,color:#d7f5df,stroke-width:1px");
  lines.push("  class fin finish");
  return lines.join("\n");
}

// The ladder, drawn once for the page: `flowchart BT` puts local at the BOTTOM and turnover at the top, so the
// arrows point the way a tree may move. A downgrade is not drawn because the panel refuses one (§3).
function ladderFor(definitions) {
  const lines = ["flowchart BT"];
  for (const kind of PIPELINE_KINDS) {
    const on = definitions.filter((def) => def.kind === kind).map((def) => def.id);
    const list = on.length ? on.join(", ") : "no definition of this kind";
    lines.push(`  k_${kind}["${mermaidText(`${kind} · rank ${KIND_RANK[kind]} — ${on.length} definition${on.length === 1 ? "" : "s"}: ${list}`)}"]`);
  }
  for (let i = 1; i < PIPELINE_KINDS.length; i += 1) {
    const from = PIPELINE_KINDS[i - 1];
    const to = PIPELINE_KINDS[i];
    lines.push(`  k_${from} -->|"upgrade · rank ${KIND_RANK[from]} → ${KIND_RANK[to]}"| k_${to}`);
  }
  lines.push("  classDef rung fill:#161a21,stroke:#333b49,color:#e6e9ef,stroke-width:1px");
  lines.push(`  class ${PIPELINE_KINDS.map((kind) => `k_${kind}`).join(",")} rung`);
  lines.push(`  classDef top fill:#12261a,stroke:#2ea043,color:#d7f5df,stroke-width:1px`);
  lines.push(`  class k_${PIPELINE_KINDS[PIPELINE_KINDS.length - 1]} top`);
  return lines.join("\n");
}

// ---- the page ----------------------------------------------------------------------------------------------------
const STYLE = `
:root {
  --bg: #0f1115; --panel: #161a21; --panel-2: #1b2029; --line: #262c37; --line-soft: #1f242e;
  --text: #e6e9ef; --dim: #9aa4b2; --dimmer: #6b7482;
  --green: #2ea043; --green-bg: #12261a; --red: #e5534b; --red-bg: #2a1618;
  --amber: #d29922; --amber-bg: #2a2312; --blue: #4a90d9; --blue-bg: #141f2c; --violet: #a371f7; --violet-bg: #1e1730;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --ui: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
* { box-sizing: border-box; }
html { background: var(--bg); }
body { margin: 0; padding: 32px 28px 64px; background: var(--bg); color: var(--text); font: 14px/1.55 var(--ui); max-width: 1240px; }
h1 { font-size: 26px; line-height: 1.15; margin: 0 0 6px; letter-spacing: -0.01em; }
h2 { font-size: 17px; margin: 0 0 4px; letter-spacing: -0.01em; }
h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.09em; color: var(--dim); margin: 26px 0 8px; font-weight: 600; }
p { margin: 0 0 10px; }
a { color: var(--blue); text-decoration: none; }
a:hover { text-decoration: underline; }
code, .mono { font-family: var(--mono); font-size: 12px; }
code { background: var(--panel-2); border: 1px solid var(--line-soft); border-radius: 4px; padding: 1px 5px; color: #cfd6e2; }
.lede { color: var(--dim); max-width: 78ch; }
.masthead { border-bottom: 1px solid var(--line); padding-bottom: 18px; margin-bottom: 26px; }
.facts { display: flex; flex-wrap: wrap; gap: 10px 34px; margin: 16px 0 0; padding: 0; }
.facts div { min-width: 150px; }
.facts dt { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.09em; color: var(--dimmer); }
.facts dd { margin: 2px 0 0; font-family: var(--mono); font-size: 12.5px; color: var(--text); }
section { margin: 0 0 34px; }
.caption { color: var(--dim); font-size: 12.5px; max-width: 96ch; }
table { width: 100%; border-collapse: collapse; margin: 10px 0 0; font-size: 12.5px; }
th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--dimmer); font-weight: 600; border-bottom: 1px solid var(--line); padding: 6px 10px 6px 0; white-space: nowrap; }
td { border-bottom: 1px solid var(--line-soft); padding: 7px 10px 7px 0; vertical-align: top; color: #cfd6e2; }
tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; padding-right: 16px; font-family: var(--mono); color: var(--dim); }
.hash { font-family: var(--mono); font-size: 11.5px; color: var(--dim); word-break: break-all; }
.note { border-left: 2px solid var(--line); padding: 2px 0 2px 12px; color: var(--dim); font-size: 12.5px; }
.callout { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 12px 14px; margin: 14px 0 0; font-size: 12.5px; color: var(--dim); }
.callout.warn { border-color: #4a3a12; background: var(--amber-bg); color: #f0d9a8; }
.callout.bad { border-color: #5a2424; background: var(--red-bg); color: #ffc9c4; }
.callout.ok { border-color: #1d3a26; background: var(--green-bg); color: #c9e9d2; }
.chip { display: inline-block; border-radius: 999px; padding: 1px 9px; font-size: 11px; font-family: var(--mono); vertical-align: 2px; margin-left: 8px; border: 1px solid; }
.kind-local { background: var(--blue-bg); border-color: #24466b; color: #a8cdf2; }
.kind-investigation { background: var(--amber-bg); border-color: #4a3a12; color: #f0d9a8; }
.kind-turnover { background: var(--green-bg); border-color: #1d3a26; color: #c9e9d2; }
.rung { background: var(--violet-bg); border-color: #3b2a5e; color: #d3c2fb; }
.pipeline { border: 1px solid var(--line); border-radius: 12px; background: var(--panel); padding: 18px 20px 20px; margin: 0 0 26px; }
.pipeline .desc { color: var(--dim); margin: 6px 0 0; max-width: 92ch; }
.pipeline .chain { color: var(--dim); font-size: 12.5px; margin: 10px 0 0; }
.graph { margin: 16px 0 0; overflow-x: auto; background: var(--bg); border: 1px solid var(--line-soft); border-radius: 10px; padding: 10px 6px; }
.graph pre.mermaid { margin: 0; background: transparent; color: var(--dim); font-family: var(--mono); font-size: 11.5px; white-space: pre; }
.graph svg { max-width: none !important; height: auto; }
#contents ol { margin: 6px 0 0; padding-left: 22px; columns: 2; column-gap: 40px; }
#contents li { margin: 0 0 3px; }
#contents .k { color: var(--dimmer); font-size: 11.5px; font-family: var(--mono); }
footer { border-top: 1px solid var(--line); margin-top: 40px; padding-top: 14px; color: var(--dimmer); font-size: 12px; }
.status { font-family: var(--mono); font-size: 12px; color: var(--dim); margin: 10px 0 0; }
.status.bad { color: #ffb4ab; }
`;

const BOOTSTRAP = `
(function () {
  var status = document.getElementById("render-status");
  var blocks = Array.prototype.slice.call(document.querySelectorAll("pre.mermaid"));
  function say(text, bad) {
    if (!status) return;
    status.textContent = text;
    if (bad) status.className = "status bad";
  }
  if (!window.mermaid) { say("the vendored mermaid bundle did not load — the diagram sources below are the page", true); return; }
  try {
    window.mermaid.initialize({
      startOnLoad: false,
      theme: "dark",
      securityLevel: "strict",
      fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      themeVariables: {
        background: "#0f1115", primaryColor: "#1b2029", primaryTextColor: "#e6e9ef", primaryBorderColor: "#333b49",
        lineColor: "#6b7482", secondaryColor: "#141f2c", tertiaryColor: "#1e1730", edgeLabelBackground: "#161a21",
        clusterBkg: "#12161d", fontSize: "13px"
      },
      flowchart: { useMaxWidth: false, htmlLabels: true, wrappingWidth: 380, curve: "basis", nodeSpacing: 42, rankSpacing: 70, padding: 12 }
    });
  } catch (e) { say("mermaid refused the configuration: " + e, true); return; }
  var done = 0, failed = [];
  blocks.forEach(function (block, index) {
    var id = "mmd-" + index;
    try {
      window.mermaid.render(id, block.textContent).then(function (result) {
        block.innerHTML = result.svg;
        block.setAttribute("data-rendered", "1");
        done += 1;
        settle();
      }).catch(function (err) { failed.push((block.getAttribute("data-diagram") || id) + ": " + err); settle(); });
    } catch (e) { failed.push((block.getAttribute("data-diagram") || id) + ": " + e); settle(); }
  });
  function settle() {
    if (done + failed.length < blocks.length) return;
    if (failed.length) say(done + " of " + blocks.length + " diagrams drew; " + failed.length + " did not — " + failed.join("; "), true);
    else say(done + " diagrams drawn from the catalogue (mermaid inlined, no network used)");
  }
  if (!blocks.length) say("no definitions to draw", true);
})();
`;

function sourceRow(source) {
  const status = source.exists ? source.role : `absent — ${source.why || "not there"}`;
  return `<tr>
      <td>${esc(source.label)}</td>
      <td class="hash">${esc(source.file || "—")}</td>
      <td>${esc(status)}</td>
      <td class="num">${source.exists ? esc(bytes(source.bytes)) : "—"}</td>
      <td class="mono">${source.exists ? esc(source.modified) : "—"}</td>
      <td class="hash">${source.exists ? esc(source.sha256) : "—"}</td>
    </tr>`;
}

function sourcesSection({ sources, configFile, doc, generatedAt, version }) {
  const seed = sources.find((s) => s.role === "seed");
  const live = sources.find((s) => s.role === "live");
  const mode = doc.refused
    ? `the live file was REFUSED (version ${esc(doc.refused.version)} &gt; this panel's ${esc(doc.refused.supported)}); the seed is in force read-only`
    : live.exists
      ? "the live file merged over the seed, per id"
      : "the seed alone — no live catalogue is in force";
  return `<section id="sources">
    <h2>What this page read</h2>
    <p class="caption">Both files are hashed with sha256 as they were read at ${esc(generatedAt)}. If either hash differs from the file on disk now, this render is stale — re-run <code>npm run render:pipelines</code>. The live path is the one <code>lib/paths.js</code> <code>statePaths()</code> gives for <code>pipelinesFile</code>, resolved from ${configFile ? `<code>${esc(configFile)}</code>` : "the default panel location"}.</p>
    <table>
      <thead><tr><th>source</th><th>file</th><th>status</th><th class="num">bytes</th><th>modified (UTC)</th><th>sha256</th></tr></thead>
      <tbody>${sources.map(sourceRow).join("\n")}</tbody>
    </table>
    <p class="note" style="margin-top:12px">Merging: ${mode}. The page was generated at panel version <code>v${esc(version)}</code>; the catalogue file's own version is <code>${doc.version == null ? "none" : esc(doc.version)}</code> and this panel supports <code>${esc(PIPELINES_VERSION)}</code>.</p>
    <div class="callout">A render is a snapshot, not a view: it keeps drawing the catalogue it read, on purpose. Two files with the same version differ only if the JSON changed under the same release — compare the sha256s above before trusting an older one.</div>
  </section>`;
}

function warningsSection(doc) {
  const out = [];
  if (doc.refused) out.push(`<div class="callout bad"><strong>Refused whole.</strong> ${esc(doc.refused.why)}. No definition from that file is in force.</div>`);
  if (doc.dropped.length) {
    out.push(`<div class="callout warn"><strong>Dropped by id.</strong> The loader refused ${doc.dropped.length} definition${doc.dropped.length === 1 ? "" : "s"}; the rest of the catalogue is in force.<ul>${doc.dropped.map((d) => `<li><code>${esc(d.id)}</code> — ${esc(d.why)}</li>`).join("")}</ul></div>`);
  }
  const rest = doc.warnings.filter((w) => !doc.dropped.some((d) => w.includes(d.id)) && !(doc.refused && w.includes("refused")));
  if (rest.length) out.push(`<div class="callout warn"><strong>The loader's log.</strong><ul>${rest.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>`);
  if (!out.length) out.push(`<div class="callout ok">Every definition loaded: nothing was dropped, and no live file was refused.</div>`);
  return `<section id="health"><h2>What the loader said</h2>${out.join("\n")}</section>`;
}

function ladderSection(definitions) {
  const rows = PIPELINE_KINDS.map((kind) => {
    const on = definitions.filter((def) => def.kind === kind).map((def) => def.id);
    return `<tr><td class="num">${esc(KIND_RANK[kind])}</td><td><code>${esc(kind)}</code></td><td>${esc(KIND_MAY[kind] || "")}</td><td>${on.length ? on.map((id) => `<code>${esc(id)}</code>`).join(" ") : "—"}</td></tr>`;
  }).join("\n");
  return `<section id="ladder">
    <h2>The ladder a tree climbs</h2>
    <p class="caption">Drawn bottom-up (<code>flowchart BT</code>): <code>local</code> at the bottom, <code>turnover</code> at the top, and every edge pointing the only way a tree may move. The panel refuses a downgrade with a sentence rather than applying it quietly (docs/pipelines.md §3), which is why there is no arrow down.</p>
    <div class="graph"><pre class="mermaid" data-diagram="ladder">${esc(ladderFor(definitions))}</pre></div>
    <table>
      <thead><tr><th class="num">rank</th><th>kind</th><th>what it may do</th><th>definitions on it</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function pipelineSection(def, definitions) {
  const rung = KIND_RANK[def.kind] ?? 0;
  const next = def.next ? definitions.find((d) => d.id === def.next) : null;
  const chain = def.next
    ? `<p class="chain">Chains into <code>${esc(def.next)}</code>${next ? ` (<code>${esc(next.kind)}</code>)` : ""} when its last stage exits — the same tree, the same branch, no new worktree (docs/pipelines.md §5).</p>`
    : "";
  const rows = def.stages
    .map((stage, index) => {
      const last = index === def.stages.length - 1;
      const placeholders = [...new Set(promptPlaceholders(stage.prompt))];
      const params = exitParams(stage.exit);
      return `<tr>
        <td class="num">${index + 1}</td>
        <td><code>${esc(stage.id)}</code> ${esc(oneLine(stage.title))}</td>
        <td><code>${esc(exitCheck(stage.exit))}</code></td>
        <td>${params.length ? params.map(([k, v]) => `<code>${esc(`${k} ${v}`)}</code>`).join(" ") : "—"}</td>
        <td>${placeholders.length ? placeholders.map((p) => `<code>{{${esc(p)}}}</code>`).join(" ") : "—"}</td>
        <td>${last && def.next ? `<code>next → ${esc(def.next)}</code>` : "—"}</td>
      </tr>`;
    })
    .join("\n");
  return `<section class="pipeline" id="p-${esc(def.id)}" data-pipeline-id="${esc(def.id)}" data-kind="${esc(def.kind)}">
    <h2><code>${esc(def.id)}</code> ${esc(oneLine(def.title))}<span class="chip kind-${esc(def.kind)}">${esc(def.kind)}</span><span class="chip rung">rung ${rung + 1} of ${PIPELINE_KINDS.length}</span></h2>
    <p class="desc">${esc(oneLine(def.description) || "no description")}</p>
    ${chain}
    <div class="graph"><pre class="mermaid" data-diagram="${esc(def.id)}">${esc(flowchartFor(def))}</pre></div>
    <h3>Stages, exit checks, holes and what follows</h3>
    <table class="stages">
      <thead><tr><th class="num">#</th><th>stage</th><th>exit check</th><th>parameters</th><th>prompt placeholders</th><th>next</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function contentsSection(definitions) {
  const items = definitions
    .map((def) => `<li><a href="#p-${esc(def.id)}"><code>${esc(def.id)}</code></a> <span class="k">${esc(def.kind)} · ${def.stages.length} stage${def.stages.length === 1 ? "" : "s"}</span></li>`)
    .join("\n");
  return `<nav id="contents"><h3>In this render</h3><ol>${items}</ol></nav>`;
}

function page({ definitions, doc, sources, configFile, version, generatedAt, vendor, provenance }) {
  const seed = sources.find((s) => s.role === "seed");
  const live = sources.find((s) => s.role === "live");
  const body = [
    `<header class="masthead">
      <h1>Pipeline catalogue</h1>
      <p class="lede">Every definition the panel can offer a tree, drawn from the JSON it loads: the stages in order, the exit that ends each one with its parameters, the holes a prompt may have, and what a definition chains into. One self-contained file — mermaid ${esc(MERMAID_VERSION)} is inlined below, so it draws with no network at all.</p>
      <dl class="facts">
        <div><dt>generated at</dt><dd><time datetime="${esc(generatedAt)}">${esc(generatedAt)}</time></dd></div>
        <div><dt>panel version</dt><dd>v${esc(version)}</dd></div>
        <div><dt>definitions</dt><dd>${definitions.length}</dd></div>
        <div><dt>catalogue version</dt><dd>${doc.version == null ? "none" : esc(doc.version)} · panel supports ${esc(PIPELINES_VERSION)}</dd></div>
        <div><dt>diagrams</dt><dd>${definitions.length} stage graphs + 1 ladder</dd></div>
      </dl>
    </header>`,
    `<p class="status" id="render-status">drawing the diagrams from the inlined mermaid bundle…</p>
    <noscript><p class="callout warn">This page draws with JavaScript, from a mermaid bundle embedded in the file itself — no network is used. With scripting off, every diagram's source is still in the page, in order, inside <code>&lt;pre class="mermaid"&gt;</code>.</p></noscript>`,
    sourcesSection({ sources, configFile, doc, generatedAt, version }),
    warningsSection(doc),
    ladderSection(definitions),
    contentsSection(definitions),
    definitions.length
      ? definitions.map((def) => pipelineSection(def, definitions)).join("\n")
      : `<section class="pipeline"><h2>No definitions</h2><p class="desc">The catalogue loaded but holds no definition. An empty board is the honest picture; check the loader's log above.</p></section>`,
    `<footer>
      <p>Generated by <code>tools/render-pipelines.mjs</code> at <code>${esc(generatedAt)}</code> from ${sources.filter((s) => s.exists).map((s) => `<code>${esc(path.basename(s.file))}</code> <span class="hash">${esc(s.sha256)}</span>`).join(" + ")}.</p>
      <p>Mermaid ${esc(MERMAID_VERSION)} inlined from <code>${esc(VENDOR_REL)}</code> — <span class="hash">${esc(sha256(vendor))}</span> (${esc(bytes(Buffer.byteLength(vendor)))}). No CDN, no font fetch, no network at open time.</p>
      <p>Sources of truth: <code>pipelines.seed.json</code>, the reader's <code>pipelines.json</code> (over it, per id), and <code>docs/pipelines.md</code> for why any of this exists.</p>
    </footer>`,
    reportFooter(provenance),
    `<script id="mermaid-vendor">\n${vendor}\n</script>`,
    `<script>${BOOTSTRAP}</script>`,
  ].join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pipeline catalogue — v${esc(version)} (${esc(generatedAt)})</title>
<meta name="generator" content="tools/render-pipelines.mjs">
<meta name="wtgui-generated-at" content="${esc(generatedAt)}">
<meta name="wtgui-pipelines-version" content="${esc(version)}">
<meta name="wtgui-pipelines-count" content="${definitions.length}">
<meta name="wtgui-catalogue-version" content="${doc.version == null ? "" : esc(doc.version)}">
<meta name="wtgui-source-seed-sha256" content="${esc(seed && seed.sha256 ? seed.sha256 : "")}">
<meta name="wtgui-source-live-sha256" content="${esc(live && live.sha256 ? live.sha256 : "")}">
<meta name="wtgui-mermaid" content="${esc(MERMAID_VERSION)}">
<meta name="wtgui-mermaid-sha256" content="${esc(sha256(vendor))}">
<style>${STYLE}${REPORT_FOOTER_CSS}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

// ---- the index ---------------------------------------------------------------------------------------------------
// Every render in the folder, newest first. The metadata is read out of the file's own <head> — a render states what
// it is, so the index does not need a second ledger that could disagree with it.
function headOf(file, limit = 16384) {
  let fd;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(limit);
    const read = readSync(fd, buffer, 0, limit, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function metaOf(head, name) {
  const match = new RegExp(`<meta name="${name}" content="([^"]*)"`).exec(head);
  return match ? match[1] : "";
}

function listRenders(dir) {
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => /^pipelines-.+\.html$/.test(name));
  } catch {
    return [];
  }
  const renders = names.map((name) => {
    const file = path.join(dir, name);
    const head = headOf(file);
    const st = statSync(file);
    return {
      name,
      file,
      version: (metaOf(head, "wtgui-pipelines-version") || name.replace(/^pipelines-/, "").replace(/\.html$/, "")),
      generatedAt: metaOf(head, "wtgui-generated-at"),
      count: Number(metaOf(head, "wtgui-pipelines-count")) || 0,
      catalogueVersion: metaOf(head, "wtgui-catalogue-version"),
      seed: metaOf(head, "wtgui-source-seed-sha256"),
      live: metaOf(head, "wtgui-source-live-sha256"),
      bytes: st.size,
      sha256: sha256(readFileSync(file)),
      mtime: st.mtimeMs,
    };
  });
  return renders.sort((a, b) => versionCompare(b.version, a.version) || String(b.generatedAt).localeCompare(String(a.generatedAt)) || b.mtime - a.mtime);
}

function indexPage(renders, { version, generatedAt, provenance }) {
  const rows = renders
    .map((render) => `<tr>
        <td><a href="${esc(render.name)}"><code>v${esc(render.version)}</code></a></td>
        <td class="mono">${esc(render.generatedAt || "—")}</td>
        <td class="num">${render.count || "—"}</td>
        <td class="num">${esc(bytes(render.bytes))}</td>
        <td class="hash">${esc(render.sha256.slice(0, 16))}…</td>
        <td>${render.seed ? `<span class="hash">seed ${esc(render.seed.slice(0, 12))}…</span>` : "—"}${render.live ? `<br><span class="hash">live ${esc(render.live.slice(0, 12))}…</span>` : ""}</td>
        <td><a href="${esc(render.name)}">open</a></td>
      </tr>`)
    .join("\n");
  const body = renders.length
    ? `<table>
        <thead><tr><th>render</th><th>generated (UTC)</th><th class="num">definitions</th><th class="num">size</th><th>sha256</th><th>catalogue sources</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : `<div class="callout warn">No render is in this folder yet. Run <code>npm run render:pipelines</code> and one will appear beside this index.</div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pipeline renders — newest first</title>
<meta name="generator" content="tools/render-pipelines.mjs">
<meta name="wtgui-generated-at" content="${esc(generatedAt)}">
<meta name="wtgui-pipelines-version" content="${esc(version)}">
<style>${STYLE}${REPORT_FOOTER_CSS}</style>
</head>
<body>
<header class="masthead">
  <h1>Pipeline renders</h1>
  <p class="lede">One file per version, newest first: each is a snapshot of the catalogue that version shipped with, with its source files' sha256s inside it. The folder is the history — a later render never overwrites an earlier one, so an old picture still explains an old release.</p>
  <dl class="facts">
    <div><dt>index written at</dt><dd><time datetime="${esc(generatedAt)}">${esc(generatedAt)}</time></dd></div>
    <div><dt>newest panel version</dt><dd>v${esc(renders[0] ? renders[0].version : version)}</dd></div>
    <div><dt>renders in folder</dt><dd>${renders.length}</dd></div>
  </dl>
</header>
<section>
  <h2>Renders</h2>
  <p class="caption">Sorted by version, then by generation time. Every row is a self-contained page: mermaid is inlined, so each one opens offline.</p>
  ${body}
</section>
<footer>
  <p>Written by <code>tools/render-pipelines.mjs</code>; the render itself is <code>pipelines-&lt;version&gt;.html</code>. Re-run <code>npm run render:pipelines</code> after a catalogue change, and after a version bump, so the newest release has its own picture.</p>
</footer>
${reportFooter(provenance)}
</body>
</html>
`;
}

// ---- the vendored mermaid ------------------------------------------------------------------------------------------
// Fetched at BUILD time and committed, so an opened render never reaches for a CDN. `--fetch-mermaid` is the only
// path that touches the network, and it names the exact version in the file it writes.
async function fetchVendor() {
  const response = await fetch(MERMAID_URL);
  if (!response.ok) throw new Error(`${MERMAID_URL} answered ${response.status}`);
  const text = await response.text();
  if (!/globalThis\.mermaid|window\.mermaid/.test(text)) throw new Error(`${MERMAID_URL} did not look like mermaid's UMD bundle — refusing to vendor it`);
  mkdirSync(path.dirname(VENDOR_FILE), { recursive: true });
  writeFileSync(VENDOR_FILE, text, "utf8");
  return text;
}

// The bundle is pasted into a <script> element verbatim, so it must not contain `</script>` anywhere — that would
// end the element early and leave the page with half a bundle. It does not (checked at fetch time and here); if a
// later bundle ever did, refusing loudly is the right answer, because escaping it would silently alter JavaScript.
function guard(text) {
  if (!/globalThis\.mermaid|window\.mermaid/.test(text)) throw new Error(`${VENDOR_REL} does not set window.mermaid — it is not the bundle this page can inline`);
  if (/<\/script/i.test(text)) throw new Error(`${VENDOR_REL} contains "</script" — it cannot be inlined verbatim; parse it instead of pasting it, or use a mermaid build that does not`);
  return text;
}

async function readVendor({ allowFetch = false } = {}) {
  if (allowFetch || !existsSync(VENDOR_FILE)) {
    if (!allowFetch) {
      throw new UsageError(`no vendored mermaid at ${VENDOR_REL} — it is fetched at build time, once, and committed:\n  node tools/render-pipelines.mjs --fetch-mermaid\n(or: curl -sSLo ${VENDOR_REL} ${MERMAID_URL})`);
    }
    return guard(await fetchVendor());
  }
  return guard(readFileSync(VENDOR_FILE, "utf8"));
}

// ---- arguments ----------------------------------------------------------------------------------------------------
class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { out: null, dir: null, index: true, seed: null, live: undefined, fetchMermaid: false, quiet: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") opts.out = String(argv[(i += 1)] || "");
    else if (arg === "--dir") opts.dir = String(argv[(i += 1)] || "");
    else if (arg === "--no-index") opts.index = false;
    else if (arg === "--seed") opts.seed = String(argv[(i += 1)] || "");
    else if (arg === "--live") opts.live = String(argv[(i += 1)] || "");
    else if (arg === "--fetch-mermaid") opts.fetchMermaid = true;
    else if (arg === "--quiet" || arg === "-q") opts.quiet = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new UsageError(`unknown argument: ${arg}`);
  }
  if (opts.out === "") throw new UsageError("--out needs a file");
  if (opts.dir === "") throw new UsageError("--dir needs a folder");
  if (opts.out) opts.index = false; // one file asked for: do not rewrite the folder's index behind the caller's back
  return opts;
}

const HELP = `node tools/render-pipelines.mjs [--out <file>] [--dir <folder>] [--no-index] [--seed <file>] [--live <file>|none] [--fetch-mermaid] [--quiet]

  --out <file>        write ONE render to that path and leave the index alone (the verify does this)
  --dir <folder>      write pipelines-<version>.html AND index.html into that folder (default docs/pipelines/viz)
  --no-index          write the render into the folder but not index.html
  --seed <file>       read a different seed (default: pipelines.seed.json at the repo root)
  --live <file>       read that live catalogue; "none" reads the seed alone (default: statePaths().pipelinesFile)
  --fetch-mermaid     re-download tools/vendor/mermaid.min.js from the pinned CDN URL (build time only)
  --quiet             print nothing on success
`;

// ---- main ----------------------------------------------------------------------------------------------------------
async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`render-pipelines: ${error.message}\n\n${HELP}`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const version = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")).version;
  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  let vendor;
  try {
    vendor = await readVendor({ allowFetch: opts.fetchMermaid });
  } catch (error) {
    process.stderr.write(`render-pipelines: ${error.message}\n`);
    return 2;
  }

  // The live file is wherever the server would look for it. Resolving it through lib/paths.js (rather than
  // guessing a folder) is what makes this page describe THIS panel's catalogue and not a default install's.
  let livePath = null;
  let configFile = null;
  if (opts.live === undefined) {
    try {
      const layout = resolveLayout({ here: REPO });
      livePath = layout.paths.pipelinesFile;
      configFile = layout.configFile.path;
    } catch (error) {
      process.stderr.write(`render-pipelines: could not resolve the panel's state folder (${error.message}) — reading the seed alone\n`);
    }
  } else if (opts.live && opts.live !== "none") {
    livePath = path.resolve(opts.live);
  }

  const seedPath = opts.seed ? path.resolve(opts.seed) : path.join(REPO, DEFAULT_SEED_FILE);
  const seed = describeFile(seedPath, "seed", "seed (shipped with the code)");
  if (!seed.exists) {
    process.stderr.write(`render-pipelines: no seed at ${seedPath} — nothing to draw\n`);
    return 1;
  }
  const live = livePath ? describeFile(livePath, "live", "live (panel state, overrides the seed per id)") : { role: "live", label: "live (panel state)", file: null, exists: false, why: "reading the seed alone" };

  const { doc, definitions } = loadCatalogue({ seedFile: seed.file, liveFile: live.exists ? live.file : null });
  const sources = [seed, live];

  const provenance = resolveReportProvenance({
    repo: REPO,
    title: `Pipeline catalogue - v${version}`,
    source: "node tools/render-pipelines.mjs reading pipelines.seed.json and the panel's pipelines.json",
    now: new Date(generatedAt),
  });
  const html = page({ definitions, doc, sources, configFile, version, generatedAt, vendor, provenance });
  const dir = opts.dir ? path.resolve(opts.dir) : VIZ_DIR;
  const target = opts.out ? path.resolve(opts.out) : path.join(dir, `pipelines-${version}.html`);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, html, "utf8");
  const written = statSync(target);

  let indexed = null;
  if (opts.index) {
    const renders = listRenders(dir);
    const indexPath = path.join(dir, INDEX_NAME);
    const indexHtml = indexPage(renders, {
      version,
      generatedAt,
      provenance: resolveReportProvenance({
        repo: REPO,
        title: "Pipeline renders - index",
        source: "node tools/render-pipelines.mjs reading the render folder",
        now: new Date(generatedAt),
      }),
    });
    writeFileSync(indexPath, indexHtml, "utf8");
    indexed = { file: indexPath, renders: renders.length, bytes: statSync(indexPath).size };
  }

  if (!opts.quiet) {
    const diagrams = definitions.length + 1;
    process.stdout.write(`render-pipelines: ${target} — ${bytes(written.size)}, sha256 ${sha256(html)}, ${definitions.length} definition${definitions.length === 1 ? "" : "s"}, ${diagrams} diagram${diagrams === 1 ? "" : "s"} (${definitions.length} stage graph${definitions.length === 1 ? "" : "s"} + the ladder)\n`);
    for (const warning of doc.warnings) process.stderr.write(`render-pipelines: ${warning}\n`);
    if (indexed) process.stdout.write(`render-pipelines: ${indexed.file} — ${indexed.renders} render${indexed.renders === 1 ? "" : "s"}, newest first, ${bytes(indexed.bytes)}\n`);
    process.stdout.write(`render-pipelines: sources — seed ${seed.sha256.slice(0, 16)}…${live.exists ? `, live ${live.sha256.slice(0, 16)}…` : " (no live file)"}; mermaid ${MERMAID_VERSION} inlined\n`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`render-pipelines: ${error && error.stack ? error.stack : error}\n`);
      process.exitCode = 1;
    });
}

export { flowchartFor, ladderFor, listRenders, loadCatalogue, page, sha256, mermaidText, exitLabel, VIZ_DIR, VENDOR_FILE, MERMAID_VERSION };
