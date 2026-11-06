#!/usr/bin/env node
// tools/render-pipeline-map.mjs — every pipeline the panel can put a tree on, as ONE page.
//
// WHY. The catalogue (pipelines.seed.json) is seven definitions and the bundle file (pipeline-bundle.seed.json)
// holds four more pipelines — the studio's thirteen-stage POC-to-UAT export beside three small ones; the Pipeline
// tab draws one definition at a time and a definition has no role field, no loop field and no page that says what
// the library looks like together. This renderer reads BOTH seed files — not a transcription of them — and writes
// one self-contained page whose nodes are the stages, whose arrows are the exit checks and gates, whose dashed
// edges are the loops the data carries (plus the one inference the SEFL review definition needs), and whose second
// line names who runs each stage. EVERY pipeline in the bundle file is drawn: the page must not read as "the
// bundle is one pipeline" when the file holds four.
//
// THE PAGE IS ONE FILE AND IT OPENS OFFLINE. tools/vendor/mermaid.min.js (11.4.1) is inlined verbatim; the
// page loads only its own sibling script, public/pipeline-map.js. No CDN, no font fetch, no API.
//
// WHAT IS DERIVED AND WHAT IS NOT. A catalogue stage has no role; its prompt does. deriveRole() below is a closed
// rule table over the prompt's own sentences: every derived line carries the rule id and the exact matched text,
// which the page shows in its inspector and the verifier re-checks against the prompt. A bundle stage has an
// owner.role and a roles[] entry, so its line is ASSIGNED, not derived: the owner's own name and kind.
//
// LOOPS. Each bundle pipeline's handoffs[] with kind:"loop" are the loops the data carries (the studio's H-10,
// H-12, H-15, plus ping-pong's capped round and author-review-revise's capped reject edge). A catalogue definition
// has no loops field; sefl-review-loop is iterative in its prompts only (next: null), so it gets ONE dashed edge
// from approve back to address, marked `inferred` and explained in the page's legend and in that card's loop list.
// If a live pipelines.json ever carries a `loops` array, it is read as source:"data".
//
//   node tools/render-pipeline-map.mjs                 write public/pipeline-map.html (the committed page)
//   node tools/render-pipeline-map.mjs --out <file>    write another file
//   node tools/render-pipeline-map.mjs --check         fail when the committed page no longer matches the seeds
//   node tools/render-pipeline-map.mjs --quiet         no summary lines
//
// Exit codes: 0 ok; 1 the catalogue could not be read or the page could not be written; 2 usage/no vendored mermaid.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SEED = path.join(REPO, "pipelines.seed.json");
const BUNDLE = path.join(REPO, "pipeline-bundle.seed.json");
const VENDOR_REL = "tools/vendor/mermaid.min.js";
const VENDOR = path.join(REPO, VENDOR_REL);
const OUT = path.join(REPO, "public", "pipeline-map.html");
const SCRIPT_REL = "public/pipeline-map.js";
const SCRIPT = path.join(REPO, SCRIPT_REL);
const IMPORT_REL = "public/core/pipeline-import.js";
const IMPORT = path.join(REPO, IMPORT_REL);
const PKG = path.join(REPO, "package.json");
const MERMAID_VERSION = "11.4.1";

class UsageError extends Error {}
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const bytes = (n) => n.toLocaleString("en-US");
const oneLine = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

// ---- the role table ------------------------------------------------------------------------------------------------
// Every rule is a sentence the PROMPT actually says. The label names the actor in the prompt's own vocabulary.
// `why` is the sentence a reader gets when they ask how the line was derived. A rule whose regex does not match
// the prompt is never used; there is no fallback that invents a role — an unmatched stage is an error, not a guess.
const ROLE_RULES = [
  { id: "merge", re: /Merge the (?:pull request|PR) for/i, label: "worker · merges", why: "the prompt tells the stage to merge the PR on the host" },
  { id: "wait", re: /Read the PR's activities once/i, label: "panel · waits for reviewer", why: "the prompt ends the turn and the panel re-checks on its own clock" },
  { id: "approve", re: /wait for the head to be reviewed/i, label: "reviewer · approves at head", why: "the stage ends only when an approval exists at the head" },
  { id: "answer", re: /For each new comment/i, label: "worker · answers comments", why: "the prompt answers every comment on the PR" },
  { id: "open-pr", re: /Open ONE pull request/i, label: "worker · opens the PR", why: "the prompt opens one PR from the branch into main on the project's host" },
  { id: "push", re: /Push the branch/i, label: "worker · pushes", why: "the prompt pushes the branch and names the panel's permission box as the grant" },
  { id: "branch", re: /Rename this tree's branch/i, label: "worker · renames branch", why: "the prompt renames this tree's branch and nothing else" },
  { id: "version", re: /tools\/version\.mjs suggest/i, label: "worker · version check", why: "the prompt runs node tools/version.mjs suggest and check" },
  { id: "main", re: /git fetch origin/i, label: "worker · confirms main", why: "the prompt fetches origin's main and confirms the merge is reachable" },
  { id: "commit", re: /Commit (?:everything|it on|the evidence)/i, label: "worker · commits", why: "the prompt commits in this tree on the branch" },
  { id: "conclude", re: /Write the conclusion down/i, label: "worker · writes conclusion", why: "the prompt writes the conclusion into docs/investigation.md" },
  { id: "probe", re: /Read, run and probe/i, label: "worker · probes", why: "the prompt reads, runs and probes this tree" },
  { id: "work", re: /Do the work in this tree/i, label: "worker · does the work", why: "the prompt tells the stage to do the work in this tree" },
];

function deriveRole(stage) {
  const prompt = String(stage.prompt || "");
  for (const rule of ROLE_RULES) {
    const m = rule.re.exec(prompt);
    if (!m) continue;
    const at = m.index;
    const start = Math.max(0, prompt.lastIndexOf(". ", at) + (prompt.lastIndexOf(". ", at) >= 0 ? 2 : 0));
    const endDot = prompt.indexOf(". ", at);
    const sentence = prompt.slice(start, endDot >= 0 ? endDot + 1 : Math.min(prompt.length, at + 240)).trim();
    return {
      source: "derived",
      rule: rule.id,
      label: `derived: ${rule.label}`,
      why: rule.why,
      evidence: m[0],
      quote: oneLine(sentence).slice(0, 220),
    };
  }
  throw new Error(`stage ${stage.id}: no role rule matched its prompt — refusing to invent a role`);
}

// ---- exit labels ---------------------------------------------------------------------------------------------------
// The edge is the condition the panel evaluates; its label names the check exactly and only carries parameters that
// fit on an 11 px edge label. The full exit object travels in the data and is printed in the inspector.
const basename = (p) => String(p || "").split(/[\\/]/).pop();
function compactExit(exit) {
  if (!exit || !exit.check) return "";
  const e = exit;
  if (exit.check === "commits") return `${exit.check} ≥ ${Number(exit.min) || 1}`;
  if (exit.check === "file-exists") return `${exit.check} ${basename(exit.path)}`;
  if (exit.check === "command") return `${exit.check}: ${(exit.argv || []).join(" ")}`;
  if (exit.check === "branch-name") return exit.check;
  return String(exit.check);
}

// ---- read the two seeds -------------------------------------------------------------------------------------------
function readJson(file, what) {
  if (!existsSync(file)) throw new Error(`${what} is not there: ${path.relative(REPO, file)}`);
  try {
    return JSON.parse(readFileSync(file, "utf8").split(String.fromCharCode(13, 10)).join(String.fromCharCode(10)));
  } catch (e) {
    throw new Error(`${path.basename(file)} is not JSON: ${String((e && e.message) || e)}`);
  }
}

// The page quotes each source with its sha256. That identity must survive a checkout: core.autocrlf turns a
// committed LF blob into CRLF in the working tree, and a raw read would make the page stale on the next clone
// (or fresh on one and stale on another). Every source is read, and hashed, as its LF-normalized bytes — the
// git blob's bytes — and the footer says so.
function readSource(file) {
  const raw = readFileSync(file);
  const text = raw.toString("utf8").split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
  return { buf: Buffer.from(text, "utf8"), text };
}

// One bundle pipeline, normalised. The studio export names its id and title under `project`; the small pipelines
// carry `id`/`title` at the top level. Both shapes are read here, and a stage's owner is looked up in that
// pipeline's own roles[] — a bundle stage is ASSIGNED a role, never derived from a prompt.
function bundleOf(def, index) {
  const id = oneLine(def.id || (def.project && def.project.id)) || `bundle-${index + 1}`;
  const title = oneLine(def.title || (def.project && def.project.name)) || id;
  const description = oneLine(def.description || (def.project && def.project.description));
  if (!Array.isArray(def.stages) || !def.stages.length) throw new Error(`bundle pipeline ${id} has no stages[]`);
  if (!Array.isArray(def.roles)) throw new Error(`bundle pipeline ${id} has no roles[]`);

  const roleById = new Map(def.roles.filter((r) => r && r.id).map((r) => [r.id, r]));
  const stages = def.stages.map((st, i) => {
    const owner = roleById.get(st.owner && st.owner.role);
    if (!owner) throw new Error(`bundle stage ${id}/${st.id} names owner.role ${JSON.stringify(st.owner && st.owner.role)}, which roles[] does not hold`);
    const others = def.roles.filter((r) => r.stage === st.id && r.id !== owner.id);
    return {
      id: st.id,
      ordinal: i + 1,
      title: oneLine(st.name || st.title || st.id),
      role: {
        source: "assigned",
        ownerId: owner.id,
        owner: oneLine(owner.name || owner.id),
        kind: oneLine(owner.kind || "role"),
        others: others.map((r) => oneLine(r.name || r.id)),
        label: `role: ${oneLine(owner.name || owner.id)} · ${oneLine(owner.kind || "role")}${others.length ? ` + ${others.length}` : ""}`,
        remit: oneLine(owner.remit),
        instructions: oneLine(owner.instructions),
      },
      purpose: oneLine(st.purpose),
      artifact: oneLine(st.artifact && st.artifact.id),
      gates: (st.gates || []).slice(),
    };
  });

  const gates = (def.gates || []).map((g) => ({
    id: g.id,
    after: g.after,
    name: oneLine(g.name),
    decider: oneLine(g.decider),
    artifact: oneLine(g.artifact),
    verifiedBy: oneLine(g.verified_by),
    refusesWhen: oneLine(g.refuses_when),
    timebox: oneLine(g.timebox),
    reads: (g.reads || []).map(oneLine),
    mayNotRead: (g.may_not_read || []).map(oneLine),
  }));
  const gateAfter = new Map(gates.map((g) => [g.after, g]));
  const order = new Map(stages.map((s, i) => [s.id, i]));

  // The sequence edges are handoffs[] of kind "sequence", in stage order; a loop handoff is drawn as the dashed arc.
  const seq = (def.handoffs || []).filter((h) => h && h.kind === "sequence" && h.from && h.to);
  const edges = seq.slice().sort((a, b) => (order.get(a.from) ?? 0) - (order.get(b.from) ?? 0)).map((h) => {
    const g = gateAfter.get(h.from);
    return {
      from: h.from,
      to: h.to,
      artifact: oneLine(h.artifact),
      label: g ? `${g.id} · ${g.name} (${g.decider})` : "",
      gate: g ? g.id : null,
    };
  });
  const loops = (def.handoffs || []).filter((h) => h && h.kind === "loop" && h.from && h.to).map((h) => ({
    id: h.id || "",
    from: h.from,
    to: h.to,
    cap: oneLine(h.cap),
    label: `${h.id ? h.id + " · " : ""}${oneLine(h.cap) || "loop"}`,
    short: h.id || "loop",
    source: "data",
    note: oneLine(h.note),
  }));

  return { id, title, description, stages, gates, edges, loops };
}

function build() {
  const seed = readJson(SEED, "the pipeline catalogue");
  // The bundle file is the panel's multi-pipeline wrapper (`{bundleVersion, name, pipelines: [...]}`); a bare studio
  // document is still read, because a reader may point this renderer at an older export. EVERY pipeline in the file
  // is drawn — the studio's 13-stage POC-to-UAT export first, then the small ones — because the panel ships all of
  // them and a page that drew one would be a picture of a library that no longer exists.
  const bundleFile = readJson(BUNDLE, "the bundle file");
  const bundleList = Array.isArray(bundleFile.pipelines) ? bundleFile.pipelines.filter((p) => p && typeof p === "object") : [bundleFile];
  if (!bundleList.length) throw new Error("pipeline-bundle.seed.json holds no pipeline");
  if (!Array.isArray(seed.pipelines)) throw new Error("pipelines.seed.json has no pipelines[]");

  const bundles = bundleList.map(bundleOf);
  const studio = bundles.find((b) => b.id === "poc-to-uat") || bundles[0];
  const bundleStages = bundles.reduce((n, b) => n + b.stages.length, 0);
  const bundleLoops = bundles.reduce((n, b) => n + b.loops.length, 0);

  const pipelines = seed.pipelines.map((def, pi) => {
    const stages = def.stages.map((st, i) => ({
      id: st.id,
      ordinal: i + 1,
      title: oneLine(st.title || st.id),
      prompt: String(st.prompt || ""),
      role: deriveRole(st),
      exit: st.exit ? { check: st.exit.check, ...Object.fromEntries(Object.entries(st.exit).filter(([k]) => k !== "check")) } : null,
      exitLabel: compactExit(st.exit),
    }));
    const loops = [];
    // A live/edited definition may carry loops[]; the seed does not. Read it when it is there, never invent one.
    for (const loop of Array.isArray(def.loops) ? def.loops : []) {
      if (!loop || !loop.from || !loop.to) continue;
      loops.push({
        id: oneLine(loop.id) || "",
        from: oneLine(loop.from),
        to: oneLine(loop.to),
        cap: oneLine(loop.cap),
        label: `${oneLine(loop.id) ? oneLine(loop.id) + " · " : ""}${oneLine(loop.label) || oneLine(loop.cap) || "loop"}`,
        short: oneLine(loop.id) || "loop",
        source: "data",
        note: oneLine(loop.note),
      });
    }
    // sefl-review-loop is iterative in its prompts: an approval at an older commit is not an approval of the head,
    // so a change request sends the head back to Answer the review. ONE dashed edge, marked inferred.
    if (def.id === "sefl-review-loop" && !loops.length) {
      const approve = stages.find((s) => s.id === "approve");
      const address = stages.find((s) => s.id === "address");
      if (approve && address) {
        loops.push({
          id: "inferred-review-round",
          from: "approve",
          to: "address",
          cap: "",
          label: "inferred · another review round",
          short: "inferred",
          source: "inferred",
          note: "the definition declares no loop (next: null); the round trip is read from the prompts — a change request at Wait for the approval at the head sends the head back to Answer the review",
        });
      }
    }
    return {
      id: def.id,
      ordinal: pi + 1,
      title: oneLine(def.title || def.id),
      kind: oneLine(def.kind),
      description: oneLine(def.description),
      next: def.next == null || def.next === "" ? null : oneLine(def.next),
      stages,
      loops,
      edges: stages.slice(0, -1).map((s, i) => ({ from: s.id, to: stages[i + 1].id, label: s.exitLabel, exit: s.exit })),
      lastExit: stages.length ? { stage: stages[stages.length - 1].id, label: stages[stages.length - 1].exitLabel, exit: stages[stages.length - 1].exit } : null,
    };
  });

  const model = {
    meta: {
      version: readJson(PKG, "package.json").version,
      generatedAt: new Date().toISOString(),
      totalPipelines: pipelines.length,
      totalStages: pipelines.reduce((n, p) => n + p.stages.length, 0),
      // Every stage in the bundle file, and the studio's own count beside it: the page draws all four pipelines, so
      // one number for "the bundle" would be a lie about three of them.
      bundleStages,
      studioStages: studio.stages.length,
      totalLoops: pipelines.reduce((n, p) => n + p.loops.length, 0) + bundleLoops,
      bundlePipelines: bundles.length,
      roleRules: ROLE_RULES.map((r) => ({ id: r.id, label: r.label, why: r.why })),
      sources: [
        sourceRow(SEED, "pipelines.seed.json", "the catalogue of definitions"),
        sourceRow(BUNDLE, "pipeline-bundle.seed.json", "the bundle file's pipelines"),
        sourceRow(VENDOR, VENDOR_REL, "mermaid, inlined"),
        sourceRow(SCRIPT, SCRIPT_REL, "this page's own script"),
        sourceRow(IMPORT, IMPORT_REL, "the importer a document is read through"),
      ],
      mermaidVersion: MERMAID_VERSION,
    },
    pipelines,
    bundles,
  };
  return model;
}

function sourceRow(file, rel, role) {
  if (!existsSync(file)) return { file: rel, role, exists: false, bytes: 0, sha256: "" };
  const buf = readSource(file).buf;
  return { file: rel, role, exists: true, bytes: buf.length, sha256: sha256(buf) };
}

// ---- the page ------------------------------------------------------------------------------------------------------
const escHtml = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function html(model, vendor) {
  if (!/globalThis\.mermaid|window\.mermaid/.test(vendor)) throw new Error(`${VENDOR_REL} does not set window.mermaid`);
  if (/<\/script/i.test(vendor)) throw new Error(`${VENDOR_REL} contains "</script" — it cannot be inlined verbatim`);
  const data = JSON.stringify(model).replace(/</g, "\\u003c");
  const meta = model.meta;
  const srcRows = meta.sources
    .map((s) => `<tr><td><code>${escHtml(s.file)}</code></td><td>${escHtml(s.role)}</td><td class="num">${s.exists ? bytes(s.bytes) : "—"}</td><td><code>${s.exists ? s.sha256.slice(0, 16) : "absent"}</code></td></tr>`)
    .join("\n        ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Every pipeline the panel can put a tree on — drawn</title>
<meta name="wtgui-version" content="${escHtml(meta.version)}">
<meta name="wtgui-generated" content="${escHtml(meta.generatedAt)}">
<meta name="wtgui-mermaid" content="${escHtml(meta.mermaidVersion)}">
<meta name="wtgui-sources" content="${escHtml(meta.sources.map((s) => `${s.file}:${s.sha256.slice(0, 16)}`).join(" "))}">
<style>
  :root {
    --bg: #0e1116; --panel: #151a21; --panel2: #1b212a; --line: #2a3340; --line-soft: #222a35;
    --text: #e6e9ef; --dim: #9aa4b2; --dimmer: #6f7a89; --green: #7ee787; --red: #ff9c94;
    --amber: #f0c674; --blue: #9ecbff; --purple: #c8a6ff; --violet: #b9a2e0;
    --mono: ui-monospace, "Cascadia Mono", Consolas, "SF Mono", Menlo, monospace;
    --ui: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  html { background: var(--bg); }
  body { margin: 0; color: var(--text); font: 14.5px/1.6 var(--ui); }
  .wrap { max-width: 1400px; margin: 0 auto; padding: 30px 24px 72px; }
  .kicker { color: var(--dimmer); font-size: 12px; text-transform: uppercase; letter-spacing: 0.12em; margin: 0 0 6px; }
  h1 { font-size: 27px; line-height: 1.22; margin: 0 0 10px; letter-spacing: -0.2px; max-width: 30ch; }
  .lede { color: var(--dim); font-size: 15.5px; max-width: 96ch; margin: 0 0 14px; }
  .lede b { color: var(--text); font-weight: 600; }
  .sources { color: var(--dimmer); font-size: 11.5px; font-family: var(--mono); margin: 0 0 18px; }
  .sources code { color: var(--dim); font-size: 11.5px; }

  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 18px 0 8px; }
  .stat { background: var(--panel); border: 1px solid var(--line); border-radius: 9px; padding: 10px 12px; }
  .stat b { display: block; font-size: 22px; line-height: 1.15; font-variant-numeric: tabular-nums; }
  .stat span { color: var(--dim); font-size: 12px; }
  .chains { color: var(--dim); font-size: 12.5px; margin: 6px 0 20px; }
  .chains code { color: var(--text); }

  /* The source line. It is not decoration: a drawing that does not name its source and its sha256 cannot be told
     apart from the catalogue the page was built from, so it sits above the cards and is the first thing read. */
  .provenance { margin: 0 0 12px; padding: 5px 0 5px 11px; border-left: 3px solid var(--line); font: 11.5px/1.65 var(--mono); color: var(--dim); }
  .provenance[data-kind="document"] { border-left-color: var(--blue); color: #cfe0f5; }
  .provenance b { color: var(--text); font-weight: 600; }
  .provenance code { color: var(--text); font-size: 11.5px; }
  .provenance code.sha { color: var(--green); word-break: break-all; }
  .provenance .pv-tag { display: inline-block; margin-right: 7px; font-size: 10px; letter-spacing: 0.09em; text-transform: uppercase; color: var(--dimmer); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; }
  .provenance[data-kind="document"] .pv-tag { color: var(--blue); border-color: #29405a; }
  .doc-error { margin: 0 0 14px; padding: 9px 12px; border: 1px solid #6b2b2b; border-radius: 8px; background: #2a1517; color: var(--red); font: 12.5px/1.55 var(--mono); }
  .doc-error[hidden] { display: none; }
  .docbtn { position: relative; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 7px; background: transparent; color: var(--dim); font: 12px var(--mono); padding: 6px 10px; cursor: pointer; }
  .docbtn:hover { color: var(--text); border-color: #3b4656; }
  .docbtn:focus-within, .docbtn:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
  .docbtn input[type="file"] { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
  .docbtn.ghost[hidden] { display: none; }
  .sep { width: 1px; height: 18px; background: var(--line); display: inline-block; }

  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; margin: 22px 0 10px; padding: 10px 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 9px; position: sticky; top: 0; z-index: 8; }
  .controls .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.09em; color: var(--dimmer); }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 7px; overflow: hidden; }
  .seg button { appearance: none; border: 0; background: transparent; color: var(--dim); font: 12px var(--mono); padding: 6px 11px; cursor: pointer; }
  .seg button + button { border-left: 1px solid var(--line); }
  .seg button[aria-pressed="true"] { background: var(--panel2); color: var(--text); }
  .seg button:focus-visible, .key:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
  .seg button[disabled] { opacity: 0.4; cursor: default; }

  .legend { display: flex; flex-wrap: wrap; gap: 6px 20px; margin: 10px 2px 22px; font-size: 12px; color: var(--dim); }
  .key { display: inline-flex; align-items: center; gap: 7px; }
  .key i { width: 30px; height: 0; border-top: 2px solid var(--dim); display: inline-block; }
  .key[data-kind="loop"] i { border-top-style: dashed; border-top-color: var(--violet); }
  .key[data-kind="inferred"] i { border-top-style: dashed; border-top-color: var(--amber); }
  .key[data-kind="gate"] i { border-top: 2px solid var(--green); }
  .key b { color: var(--text); font-weight: 600; }

  .pm-card { border: 1px solid var(--line); border-radius: 11px; background: #12161c; margin: 0 0 22px; overflow: hidden; }
  .pm-card[data-bundle="1"] { border-color: #3a3348; }
  .pm-card-head { display: flex; gap: 12px; align-items: flex-start; padding: 13px 16px 9px; border-bottom: 1px solid var(--line-soft); }
  .pm-idx { font: 600 12px var(--mono); color: var(--dimmer); padding-top: 4px; min-width: 24px; }
  .pm-card-head h2 { font-size: 16px; margin: 0 0 2px; letter-spacing: -0.1px; }
  .pm-card-head .pm-desc { margin: 0; color: var(--dim); font-size: 12.8px; max-width: 96ch; }
  .pm-chips { margin-left: auto; display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; max-width: 46%; }
  .chip { font: 11px var(--mono); color: var(--dim); border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; white-space: nowrap; }
  .chip.kind { color: var(--blue); border-color: #29405a; }
  .chip.next { color: var(--purple); border-color: #40325c; }
  .chip.last { color: var(--dim); }
  .pm-vp { overflow-x: auto; padding: 4px 0 2px; scrollbar-width: thin; }
  .pm-draw { position: relative; display: flex; justify-content: flex-start; padding: 6px 12px 4px; min-height: 60px; }
  .pm-draw svg { max-width: none !important; height: auto; display: block; flex: 0 0 auto; }
  .pm-draw .pm-node { cursor: pointer; }
  .pm-draw .pm-node:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; border-radius: 6px; }
  .pm-draw .pm-node[data-selected="1"] rect { stroke: var(--blue) !important; stroke-width: 2px !important; }
  .pm-draw .pm-role { color: var(--dim) !important; font-size: 11px !important; }
  .pm-draw .nodeLabel p, .pm-draw .nodeLabel span { white-space: nowrap !important; }
  .pm-draw .pm-node[data-role-source="derived"] .pm-role { color: #a8b6c9 !important; }
  .pm-draw .pm-node[data-role-source="assigned"] .pm-role { color: var(--blue) !important; }
  .pm-draw .edgeLabel, .pm-draw .edgeLabel span, .pm-draw .edgeLabel p { color: var(--dim) !important; font: 11px var(--mono) !important; background: #12161c !important; }
  .pm-draw .flowchart-link, .pm-draw .edgePath path { stroke: #5b6675 !important; stroke-width: 1.4px !important; }
  .pm-draw marker path { fill: #5b6675 !important; stroke: #5b6675 !important; }
  .pm-draw .pm-loop { stroke-dasharray: 5 4 !important; }
  .pm-draw .pm-loop[data-loop-source="inferred"] { stroke: var(--amber) !important; }
  .pm-draw .pm-loop[data-loop-source="data"] { stroke: var(--violet) !important; }

  .pm-row { display: block; margin: 0; }
  .pm-row + .pm-row { margin-top: 30px; }
  .pm-row-label { display: block; font: 11px var(--mono); color: var(--dimmer); padding: 0 0 2px 2px; }
  .pm-draw[data-layout="book"] { display: block; width: max-content; min-width: 100%; padding: 4px 12px 6px; }
  .pm-draw[data-layout="book"] .pm-row + .pm-row { margin-top: 48px; }
  .pm-draw[data-layout="book"] .pm-row svg { margin: 0; }
  .pm-arcs { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
  .pm-arcs text { font: 11px var(--mono); }
  .pm-arcs .pm-arc-label { fill: var(--amber); }
  .pm-arcs .pm-arc-label[data-loop-source="data"] { fill: var(--violet); }
  .pm-arcs .pm-cont { stroke: #4a5568; stroke-dasharray: 4 4; fill: none; }
  .pm-arcs .pm-cont-label { fill: var(--dimmer); }
  .pm-arcs .pm-arc-bg { fill: #12161c; }

  .pm-status { display: flex; flex-wrap: wrap; gap: 4px 18px; border-top: 1px solid var(--line-soft); padding: 7px 14px; font: 11.5px var(--mono); color: var(--dim); }
  .pm-status b { color: var(--text); font-weight: 600; }
  .pm-status .warn { color: var(--amber); }
  .pm-loops { border-top: 1px solid var(--line-soft); padding: 8px 14px 10px; font-size: 12px; color: var(--dim); }
  .pm-loops h3 { font: 11px var(--ui); text-transform: uppercase; letter-spacing: 0.08em; color: var(--dimmer); margin: 0 0 5px; }
  .pm-loops ul { margin: 0; padding: 0; list-style: none; }
  .pm-loops li { margin: 3px 0; }
  .pm-loops .tag { font: 10.5px var(--mono); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; color: var(--violet); }
  .pm-loops .tag[data-loop-source="inferred"] { color: var(--amber); border-color: #6b5726; }
  .pm-gates .tag { color: var(--green); border-color: #2f5f38; background: #12261a; }
  .pm-loops code { color: var(--text); font-size: 11.5px; }

  #inspector { position: fixed; right: 18px; bottom: 18px; width: min(440px, calc(100vw - 36px)); max-height: min(62vh, 620px); overflow: auto; background: var(--panel); border: 1px solid #35506b; border-radius: 11px; box-shadow: 0 16px 44px #0008; padding: 13px 15px 15px; z-index: 20; }
  #inspector[hidden] { display: none; }
  #inspector h2 { font-size: 14px; margin: 0 0 2px; padding-right: 26px; }
  #inspector .close { position: absolute; right: 10px; top: 8px; background: transparent; border: 0; color: var(--dim); font: 16px var(--mono); cursor: pointer; }
  #inspector .who { font: 11.5px var(--mono); color: var(--blue); margin: 0 0 8px; }
  #inspector .who[data-role-source="derived"] { color: var(--amber); }
  #inspector .exit { font: 11.5px var(--mono); color: var(--dim); margin: 0 0 8px; }
  #inspector .why { font-size: 12px; color: var(--dim); margin: 0 0 8px; }
  #inspector .prompt { white-space: pre-wrap; font: 12px/1.55 var(--mono); color: #cfd6e2; margin: 0; }
  #inspector .prompt-h { font: 10.5px var(--ui); text-transform: uppercase; letter-spacing: 0.08em; color: var(--dimmer); margin: 10px 0 4px; }

  footer { margin-top: 40px; padding-top: 14px; border-top: 1px solid var(--line); color: var(--dimmer); font-size: 12px; }
  footer code { font: 11.5px var(--mono); color: var(--dim); }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  @media (max-width: 760px) {
    .pm-chips { max-width: 100%; justify-content: flex-start; margin-left: 0; }
    .pm-card-head { flex-wrap: wrap; }
    #inspector { left: 12px; right: 12px; width: auto; }
  }
</style>
</head>
<body>
<div class="wrap">
<header>
  <p class="kicker">agent-worktree-gui · the pipeline library</p>
  <h1>Every pipeline the panel can put a tree on, drawn</h1>
  <p class="lede">${meta.totalPipelines} catalogue definitions and ${meta.bundlePipelines} bundle pipelines (${meta.bundleStages} stages, the studio's ${meta.studioStages} among them), each stage a node: <b>its ordinal and title</b>, <b>who runs it</b> on the second line, and the <b>exit check or gate</b> on the arrow that leaves it. Solid arrows are the chain; dashed violet arrows are loops the data carries, with their cap; the one amber dashed arrow is an <b>inference</b>, named where it is drawn. It can also draw <b>a document it did not build</b> — a file, or <code>?doc=&lt;url|path&gt;</code> — and names that source and its sha256 above the cards. Mermaid ${escHtml(meta.mermaidVersion)} is inlined below — this page opens with no network at all.</p>
  <p class="sources">version ${escHtml(meta.version)} · generated ${escHtml(meta.generatedAt.replace("T", " ").slice(0, 19))} UTC · sources: ${meta.sources.map((s) => `<code>${escHtml(s.file)}</code> ${escHtml(s.sha256.slice(0, 12))}`).join(" · ")}</p>
</header>

<section class="summary" id="summary" aria-label="what this page covers"></section>
<p class="chains" id="chains"></p>
<p class="provenance" id="provenance" data-kind="built-in" aria-live="polite"></p>
<div class="doc-error" id="doc-error" role="alert" hidden></div>

<div class="controls">
  <span class="label" id="layout-label">layout</span>
  <div class="seg" id="layout" role="group" aria-labelledby="layout-label">
    <button type="button" data-layout="row" aria-pressed="true" title="one row per pipeline, 1:1 scale, horizontally scrollable">horizontal scroll</button>
    <button type="button" data-layout="book" aria-pressed="false" title="the same chain wrapped into rows of N stages, like a book page — no horizontal scroll">book · rows of N</button>
  </div>
  <span class="label" id="per-row-label">stages per row</span>
  <div class="seg" id="per-row" role="group" aria-labelledby="per-row-label">
    <button type="button" data-n="2" aria-pressed="false">2</button>
    <button type="button" data-n="3" aria-pressed="true">3</button>
    <button type="button" data-n="4" aria-pressed="false">4</button>
  </div>
  <span class="label" id="draw-count" aria-live="polite">drawing…</span>
  <span class="sep" aria-hidden="true"></span>
  <span class="label" id="import-label">document</span>
  <label class="docbtn" id="doc-open" title="draw a pipeline document this page did not build: an exported studio document, the panel's catalogue, or the factory's index">
    open a document<input type="file" id="doc-file" accept="application/json,.json" aria-labelledby="import-label">
  </label>
  <button type="button" class="docbtn ghost" id="doc-restore" hidden>back to the built-in catalogue</button>
  <span class="label" id="doc-status" aria-live="polite"></span>
</div>

<div class="legend" aria-label="how to read the drawing">
  <span class="key" data-kind="seq"><i></i><b>solid</b> — the next stage</span>
  <span class="key" data-kind="gate"><i></i><b>edge label</b> — the exit check that ends the stage on its left (a gate in the bundle)</span>
  <span class="key" data-kind="loop"><i></i><b>dashed violet</b> — a loop the data carries, labelled with its id and cap</span>
  <span class="key" data-kind="inferred"><i></i><b>dashed amber</b> — an inference, not a field: sefl-review-loop declares no loop</span>
  <span class="key" data-kind="role"><i style="border-top:0;width:auto;height:auto"><b>2nd line</b></i> — who runs it: <b>derived</b> from the prompt, or <b>role:</b> from the bundle's own roles[]</span></div>

<main id="cards"></main>

<aside id="inspector" hidden role="dialog" aria-modal="false" aria-labelledby="inspector-title" aria-live="polite">
  <button type="button" class="close" id="inspector-close" aria-label="close the stage inspector">✕</button>
  <h2 id="inspector-title"></h2>
  <p class="who" id="inspector-who"></p>
  <p class="exit" id="inspector-exit"></p>
  <p class="why" id="inspector-why"></p>
  <p class="prompt-h" id="inspector-prompt-h">prompt</p>
  <p class="prompt" id="inspector-prompt"></p>
</aside>

<footer>
  <p><b>What this page is.</b> One self-contained artefact rendered from <code>pipelines.seed.json</code> and <code>pipeline-bundle.seed.json</code> by <code>tools/render-pipeline-map.mjs</code>; its own script is <code>public/pipeline-map.js</code>. Every node, edge and loop is read from the JSON — nothing about a stage's role, its exit or its loop is typed into this page by hand. The one exception is named in the legend and on the card: <code>sefl-review-loop</code> is iterative only in its prompts, so its round trip is an inference.</p>
  <p>The derivation is a closed table: each catalogue stage's second line carries a rule id and the exact phrase from its prompt that chose it; the inspector shows the phrase, and <code>tools/verify-pipeline-map.mjs</code> re-checks it against the seed. A bundle stage is not derived at all — it prints the name and kind of its own <code>owner.role</code>, plus the count of other roles the bundle assigns to that stage.</p>
  <p><b>Drawing a document this page did not build.</b> <code>open a document</code> reads a JSON file straight from disk; <code>?doc=&lt;url|path&gt;</code> draws one the page can reach — a path on the page's own origin, or an http(s) URL, which is read through the panel's own <code>GET /api/pipeline-doc</code> because a browser will not read another origin's JSON without CORS. Three shapes are understood: an exported studio document (<code>project</code> + <code>stages[]</code>), the panel's catalogue (<code>pipelines</code>), and the factory's index (<code>[{id, title, stageCount}]</code> — whose cards say the stage names are not served). The importer is <code>public/core/pipeline-import.js</code>. Every drawing prints its source and the sha256 of the exact bytes above the cards, so an imported picture can never be mistaken for the catalogue; a document that does not parse prints one visible sentence and leaves the page as it was.</p>
  <p><b>Source ledger.</b> The ${meta.sources.length} files this page was built from, with their sha256 over LF-normalized bytes (the git blob's bytes, so a CRLF checkout does not make this ledger stale):</p>
  <table style="border-collapse:collapse;font:11.5px var(--mono);color:var(--dim);margin-top:6px">
    <thead><tr><th style="text-align:left;padding:3px 14px 3px 0">file</th><th style="text-align:left;padding:3px 14px 3px 0">role</th><th style="text-align:right;padding:3px 14px 3px 0">bytes</th><th style="text-align:left;padding:3px 0">sha256 (first 16)</th></tr></thead>
    <tbody>
        ${srcRows}
    </tbody>
  </table>
  <p style="margin-top:10px">No run state is drawn: this is the catalogue and the bundle file's pipelines, not a task's position. The pipeline modal's four marks belong to a record, and this page deliberately does not invent one.</p>
</footer>
</div>

<script id="pipeline-map-data" type="application/json">${data}</script>
<script id="mermaid-vendor">${vendor}</script>
<script src="core/pipeline-import.js?v=${escHtml(meta.version)}"></script>
<script src="pipeline-map.js?v=${escHtml(meta.version)}"></script>
</body>
</html>
`;
}

// ---- cli -----------------------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { out: OUT, quiet: false, check: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") { const v = argv[++i]; if (!v) throw new UsageError("--out needs a file"); opts.out = path.resolve(v); }
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "--check") opts.check = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new UsageError(`unknown argument ${JSON.stringify(a)}`);
  }
  return opts;
}

const HELP = `node tools/render-pipeline-map.mjs [--out <file>] [--check] [--quiet]

  --out <file>   write the page somewhere other than public/pipeline-map.html
  --check        compare the committed page with a fresh build of the two seeds; exit 1 when it is stale
  --quiet        no summary lines

The page is public/pipeline-map.html; its own script is public/pipeline-map.js. Mermaid is inlined from
${VENDOR_REL} (${MERMAID_VERSION}), so the page needs no network.`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return 0; }
  if (!existsSync(VENDOR)) {
    throw new UsageError(`no vendored mermaid at ${VENDOR_REL} — this page inlines it, it is not fetched at open time`);
  }
  const vendor = readSource(VENDOR).text;
  const model = build();
  const page = html(model, vendor);

  if (opts.check) {
    if (!existsSync(opts.out)) throw new Error(`${path.relative(REPO, opts.out)} is not there — run the renderer`);
    const current = readFileSync(opts.out, "utf8");
    const m = current.match(/<script id="pipeline-map-data" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) throw new Error("the committed page has no pipeline-map-data block");
    let committed;
    try { committed = JSON.parse(m[1].replace(/\\u003c/g, "<")); } catch (e) { throw new Error(`the committed data block is not JSON: ${String((e && e.message) || e)}`); }
    const fresh = JSON.parse(JSON.stringify(model));
    delete fresh.meta.generatedAt;
    delete committed.meta.generatedAt;
    const a = JSON.stringify(fresh);
    const b = JSON.stringify(committed);
    if (a !== b) throw new Error("the committed page is stale: its data block no longer matches the two seeds — run node tools/render-pipeline-map.mjs");
    for (const src of model.meta.sources) {
      if (!src.exists) throw new Error(`a source is missing: ${src.file}`);
      const named = current.match(new RegExp(`${src.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*</code></td><td>[^<]*</td><td class="num">[^<]*</td><td><code>([0-9a-f]{16})`));
      if (named && !src.sha256.startsWith(named[1])) throw new Error(`the committed page names a stale ${src.file} — run node tools/render-pipeline-map.mjs`);
    }
    if (!opts.quiet) console.log(`current — ${model.pipelines.length} definitions, ${model.meta.totalStages} stages, ${model.meta.bundlePipelines} bundle pipelines (${model.meta.bundleStages} stages), ${model.meta.totalLoops} loops`);
    return 0;
  }

  writeFileSync(opts.out, page);
  if (!opts.quiet) {
    console.log(`wrote ${path.relative(REPO, opts.out)} — ${bytes(Buffer.byteLength(page))} bytes`);
    console.log(`  ${model.pipelines.length} definitions, ${model.meta.totalStages} stage nodes; ${model.meta.bundlePipelines} bundle pipelines, ${model.meta.bundleStages} stage nodes; ${model.meta.totalLoops} loops (${model.bundles.reduce((n, b) => n + b.loops.length, 0)} carried, ${model.pipelines.reduce((n, p) => n + p.loops.filter((l) => l.source === "inferred").length, 0)} inferred)`);
    console.log(`  sources: ${model.meta.sources.map((s) => `${s.file} ${s.sha256.slice(0, 12)}`).join(", ")}`);
  }
  return 0;
}

try {
  process.exitCode = await main();
} catch (e) {
  if (e instanceof UsageError) {
    console.error(`usage: ${e.message}\n\n${HELP}`);
    process.exitCode = 2;
  } else {
    console.error(`pipeline-map: ${String((e && e.message) || e)}`);
    process.exitCode = 1;
  }
}
