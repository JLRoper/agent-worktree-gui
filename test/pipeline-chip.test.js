// The card's pipeline chip — the three states, and the one thing it must never invent.
//
// The record is the server's: `lib/jobs.js` writes `pipeline: {id, stage, since, history[]}` on every job row
// (`pipelineForJob`, docs/pipelines.md §3). This file drives the page's own region (`// ---- pipeline chip` … `// ----
// end pipeline chip` in public/app.js) rather than a copy of it, because the failure this guards is a renderer that
// draws a fourth state nobody asked for: a "local" stand-in on a card with no record, or a pill with no words in it.
//
// The browser half — where the chip sits, that the head stays one row at 1280/1600 and in the 480px docked rail, and
// that it takes the host chip's pill height and type scale — is tools/verify-pipeline-chip.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// conversationHtml, the card head the chip is drawn in, moved to public/render-jobs.js in step 7 of
// docs/reports/module-map-2026-11-07.html; the chip builder itself stayed in app.js.
const src = `${readFileSync(path.join(root, "public/app.js"), "utf8")}\n${readFileSync(path.join(root, "public/render-jobs.js"), "utf8")}`;
const css = readFileSync(path.join(root, "public/style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const begin = src.indexOf("// ---- pipeline chip");
const end = src.indexOf("// ---- end pipeline chip");
assert.ok(begin > 0 && end > begin, "the pipeline chip region is in public/app.js");
const region = src.slice(src.indexOf("\n", begin) + 1, end);

// The page's own escaper is a global from public/core/dom-format.js; this sandbox passes a strict stand-in so an id
// carrying markup proves it goes through `esc` rather than into the template raw.
const escape = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const sandbox = vm.createContext({ esc: escape });
const { pipelineChipHtml } = vm.runInContext(`(() => { ${region}; return { pipelineChipHtml }; })()`, sandbox);

test("a record with a stage draws the id and the stage", () => {
  const html = pipelineChipHtml({ id: "turnover", stage: "push", since: "2026-11-02T14:31:07.412Z", history: [] });
  const text = html.replace(/<[^>]*>/g, "");
  assert.equal(text, "pipeline: turnover · push");
  assert.match(html, /class="pipeline-chip"/);
  assert.match(html, /data-pipeline="turnover"/);
  assert.match(html, /data-pipeline-stage="push"/);
  assert.match(html, /title="pipeline turnover, stage push/);
});

test("a record with no stage draws the id alone, with no separator left behind", () => {
  for (const stage of [null, undefined, "", "   "]) {
    const html = pipelineChipHtml({ id: "investigation", stage, history: [] });
    const text = html.replace(/<[^>]*>/g, "");
    assert.equal(text, "pipeline: investigation", `stage ${JSON.stringify(stage)}`);
    assert.doesNotMatch(text, /·/, `stage ${JSON.stringify(stage)}`);
    assert.doesNotMatch(html, /data-pipeline-stage/, `stage ${JSON.stringify(stage)}`);
    assert.match(html, /title="pipeline investigation, no stage recorded/);
  }
});

test("no record draws nothing at all — never a local stand-in, never an empty pill", () => {
  for (const record of [null, undefined, {}, { id: "" }, { id: "   " }, { stage: "push" }]) {
    const html = pipelineChipHtml(record);
    assert.equal(html, "", `record ${JSON.stringify(record)}`);
    assert.doesNotMatch(html, /local/i);
    assert.doesNotMatch(html, /pipeline-chip/);
  }
});

test("an id is escaped, and so is the stage", () => {
  const html = pipelineChipHtml({ id: "<script>", stage: "\"onerror=" });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /data-pipeline="&lt;script&gt;"/);
  // On the page the browser decodes these entities back to the text; the markup itself never carries a live tag.
  assert.equal(html.replace(/<[^>]*>/g, ""), "pipeline: &lt;script&gt; · &quot;onerror=");
});

test("the head draws it from the job row the card already holds", () => {
  // The function is useless without its caller: assert the call sits inside the `.job-head` template of
  // `conversationHtml`, fed by `latest.pipeline` — the field `/api/jobs` sends — not by a re-read or a second fetch.
  const headAt = src.indexOf('<div class="job-head"');
  const headEnd = src.indexOf("${cwdHtml}", headAt);
  assert.ok(headAt > 0 && headEnd > headAt, "the card head template is in public/app.js");
  const head = src.slice(headAt, headEnd);
  assert.match(head, /\$\{pipelineChipHtml\(latest\.pipeline\)\}/);
  assert.ok(head.indexOf("pipelineChipHtml(latest.pipeline)") < head.indexOf("${livePulseHtml(latest)}"), "the chip sits beside the state pill");
});

test("the chip has a stylesheet rule, and it is the host chip's shape", () => {
  const rule = css.match(/(?:^|\n)\.pipeline-chip\s*\{([^}]*)\}/);
  assert.ok(rule, ".pipeline-chip has a rule in public/style.css");
  assert.match(rule[1], /padding:\s*1px 7px/);
  assert.match(rule[1], /font:\s*10\.5px\/1\.6 var\(--mono\)/);
  assert.match(rule[1], /border-radius:\s*9px/);
  assert.match(rule[1], /white-space:\s*nowrap/);
  assert.match(rule[1], /min-width:\s*0/);
  assert.ok(css.includes(":has(> .pipeline-chip)"), "the meta line gives its width up before the chip does");
});
