// Settings > Pipeline, against the pipeline list the panel actually holds.
//
// The tab used to count and list the LADDER store (pipelines.json over pipelines.seed.json) and nothing else, so an
// install whose ladder ships empty — which is every install, `pipelines.seed.json` holds no definition — read
// "0 definitions" and "(no pipeline is in force)" while `pipeline-bundle.seed.json` carried eleven PDL pipelines. This
// file pins the three things the fix has to keep true, against the REAL seed and the REAL loader:
//
//   ONE COUNT   the catalogue row counts the PDL catalogue (lib/pipeline-source.js, the same readPipelineSource the
//               queue's assignment control uses), so an empty ladder beside eleven pipelines reads "11 pipelines".
//   ONE LIST    the Pipeline dropdown offers those eleven, `pdl:<id>`, and the first is selected — a control with a
//               blank value and a dead flow button was the other half of "0 definitions".
//   THE REPAIR  a bundle the loader REFUSES keeps its own gate sentence, and the row offers the repair control. The
//               press is the import with this checkout's seed (`{seed: true}` — PR #566's repair path, where a live
//               file that does not load is replaced instead of refused), and when it lands the tab RE-READS: the
//               eleven appear and the control goes away, because a repaired bundle needs no second press.
//
// The page's own code is sliced out of public/app.js and driven against a DOM stub just big enough for this tab, the
// way test/pipeline-editor-repaint.test.js drives the editor.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseBundle } from "../lib/pipeline-bundle.js";
import { pdlCatalogue } from "../lib/pipeline-source.js";
import { sliceRegion } from "../tools/panel-testkit.mjs";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const region = sliceRegion(app, "settings > pipeline");

const SEED_DOC = JSON.parse(readFileSync(new URL("../pipeline-bundle.seed.json", import.meta.url), "utf8"));
// The file a reader's install carried before the repair: the seed with one gate's `routes` map missing, which the
// loader refuses whole as `incomplete-gate`. Built here rather than copied so the sentence under test is the loader's.
const STALE_DOC = JSON.parse(JSON.stringify(SEED_DOC));
delete STALE_DOC.pipelines[3].gates[0].decision.routes;

const refusedBundle = (file = "state/pipeline-bundle.json") => {
  const read = parseBundle(STALE_DOC, { file });
  assert.equal(read.ok, false, "the stale fixture must be refused");
  assert.equal(read.code, "incomplete-gate");
  // Through the catalogue, not a hand-built refusal: the locator is appended to the sentence by lib/pipeline-source.js
  // (bundleRefusal), and a fixture that skipped it would pin a sentence the panel never prints.
  const catalogue = pdlCatalogue(read);
  assert.equal(catalogue.ok, false);
  return { ...catalogue, file: catalogue.file || file };
};

const validBundle = (file = "state/pipeline-bundle.json") => {
  const catalogue = pdlCatalogue(parseBundle(SEED_DOC, { file }));
  assert.equal(catalogue.ok, true, "the shipped seed must parse");
  assert.equal(catalogue.pipelines.length, 11, "the shipped seed carries eleven pipelines");
  return { ...catalogue, file };
};

// ---------- a DOM stub, only as large as this tab ----------
// The paint writes text and one run of option markup; nothing here needs a parser, so `innerHTML` keeps its string and
// the assertions read the options out of it.
class El {
  constructor(id) {
    this.id = id;
    this.attrs = {};
    this._text = "";
    this._html = "";
    this.disabled = false;
    this.listeners = {};
    const words = () => String(this.attrs.class || "").split(/\s+/).filter(Boolean);
    this.classList = {
      contains: (name) => words().includes(name),
      add: (name) => {
        this.attrs.class = [...new Set([...words(), name])].join(" ");
      },
      remove: (name) => {
        this.attrs.class = words().filter((w) => w !== name).join(" ");
      },
      toggle: (name, on) => {
        const want = on === undefined ? !words().includes(name) : Boolean(on);
        if (want) this.classList.add(name);
        else this.classList.remove(name);
      },
    };
  }
  get textContent() {
    return this._text;
  }
  set textContent(v) {
    this._text = String(v);
  }
  get innerHTML() {
    return this._html;
  }
  set innerHTML(v) {
    this._html = String(v);
  }
  get hidden() {
    return "hidden" in this.attrs;
  }
  set hidden(on) {
    if (on) this.attrs.hidden = "";
    else delete this.attrs.hidden;
  }
  get value() {
    // A select's value is the option it marks selected, else "" — what the browser would hold after the paint writes
    // its markup. The paint only assigns when the two disagree, so this is the whole of what it reads.
    const m = this._html.match(/<option value="([^"]*)"[^>]*\bselected\b/);
    return m ? m[1] : "";
  }
  set value(v) {
    this.attrs.value = String(v);
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  dispatch(type) {
    for (const fn of this.listeners[type] || []) fn({ type, target: this, preventDefault() {} });
  }
}

function makePage() {
  const ids = [
    "pipeline-summary",
    "pipeline-source",
    "pipeline-list",
    "pipeline-select",
    "pipeline-flow-open",
    "pipeline-pdl-summary",
    "pipeline-pdl-source",
    "pipeline-pdl-list",
    "pipeline-pdl-pick",
    "pipeline-pdl-repair",
    "pipeline-pdl-repair-note",
    "pipeline-map-open",
    "pipeline-editor",
  ];
  const page = {};
  for (const id of ids) page[id] = new El(id);
  page.getElementById = (id) => page[id] || null;
  return page;
}

// The page's own code, against the stub. `ladder` is the /api/pipelines ladder half; `pdl` is the answer this install
// gives for the bundle, and `repaired` flips it to the seed — the same move the route makes when the import lands.
function makePanel({ ladder = { version: 1, supported: 1, pipelines: {}, dropped: [] }, pdl = validBundle() } = {}) {
  const doc = makePage();
  const calls = { reads: 0, posts: [] };
  let current = pdl;
  const apiFetch = async (url, opts = {}) => {
    if (url === "/api/pipelines" && (!opts.method || opts.method === "GET")) {
      calls.reads += 1;
      return { ok: true, status: 200, json: async () => ({ ...ladder, pdl: current }) };
    }
    if (url === "/api/assistant/pipeline-bundle/import" && opts.method === "POST") {
      calls.posts.push(JSON.parse(opts.body));
      current = validBundle();
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          repair: { code: "incomplete-gate", where: "pipelines[3].gates[0].decision.routes" },
          added: validBundle().pipelines.map((p) => ({ id: p.id, title: p.title, stages: p.stageCount })),
          pipelines: validBundle().pipelines.map((p) => ({ id: p.id, title: p.title, stages: p.stageCount })),
          reason: "repaired the bundle: the file it replaces cannot be read; imported 11 pipelines — the bundle now holds 11 pipelines",
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({ error: "no route in this stub" }) };
  };
  const api = new Function(
    "document",
    "apiFetch",
    "esc",
    "confirm",
    `${region}
     return {
       get index() { return pipelinesIndex; },
       set index(v) { pipelinesIndex = v; },
       paintPipelines,
       paintPdlPipelines,
       repairPipelineBundle,
     };`,
  )(doc, apiFetch, (s) => String(s ?? ""), () => true);
  api.index = null;
  return { doc, api, calls };
}

const optionsOf = (doc) => [...doc.getElementById("pipeline-select").innerHTML.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
const until = async (what, fn, tries = 200) => {
  for (let i = 0; i < tries; i += 1) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
};

// ---------- an empty ladder and a valid bundle: the eleven are counted AND offered ----------

test("an empty ladder store and a valid bundle: the tab counts eleven and the dropdown offers them", () => {
  const { doc, api } = makePanel({ pdl: validBundle() });
  api.index = { version: 1, supported: 1, pipelines: {}, dropped: [], pdl: validBundle() };
  api.paintPipelines();

  assert.equal(doc.getElementById("pipeline-summary").textContent, "11 pipelines · 0 definitions", "the count leads with the PDL catalogue");
  const options = optionsOf(doc);
  assert.equal(options.length, 11, "the dropdown offers the eleven PDL pipelines");
  assert.deepEqual(options, validBundle().pipelines.map((p) => `pdl:${p.id}`));
  assert.equal(doc.getElementById("pipeline-select").disabled, false, "a control with eleven options is not disabled");
  // The tab opens on the first of them, so the flow button has a pipeline to draw and the row under it says which.
  assert.equal(doc.getElementById("pipeline-select").value, `pdl:${validBundle().pipelines[0].id}`);
  assert.equal(doc.getElementById("pipeline-flow-open").disabled, false, "the flow button follows the selection");
  assert.match(doc.getElementById("pipeline-pdl-pick").textContent, /PDL pipeline "poc-to-uat"/);
  // Nothing is refused, so nothing offers a repair.
  assert.equal(doc.getElementById("pipeline-pdl-repair").hidden, true);
});

// ---------- a refused bundle: the sentence stays, and the repair control appears ----------

test("a bundle refused for the route-less gate: the loader's sentence and the repair control", () => {
  const pdl = refusedBundle();
  const { doc, api } = makePanel({ pdl });
  api.index = { version: 1, supported: 1, pipelines: {}, dropped: [], pdl };
  api.paintPipelines();

  assert.equal(doc.getElementById("pipeline-pdl-summary").textContent, "refused — incomplete-gate", "the code is named");
  const sentence = doc.getElementById("pipeline-pdl-source").textContent;
  assert.match(sentence, /gate G1 of pipeline author-review-revise declares outcomes accept, reject and no "routes" map/);
  assert.match(sentence, /the stage it follows \(review\) has 2 ways out \(H-02, H-03\)/);
  assert.match(sentence, /\(at pipelines\[3\]\.gates\[0\]\.decision\.routes\)$/, "the locator travels with it");
  assert.equal(doc.getElementById("pipeline-pdl-repair").hidden, false, "the row offers the repair");
  assert.equal(doc.getElementById("pipeline-pdl-repair").disabled, false);
  // The dropdown cannot offer a pipeline the loader refused; that is the state the repair exists to leave.
  assert.deepEqual(optionsOf(doc), [""]);
  assert.equal(doc.getElementById("pipeline-select").disabled, true);
});

// ---------- the press: the import with the seed, then the tab re-reads ----------

test("the repair imports the seed, replaces the file, and the list appears", async () => {
  const pdl = refusedBundle();
  const { doc, api, calls } = makePanel({ pdl });
  api.index = { version: 1, supported: 1, pipelines: {}, dropped: [], pdl };
  api.paintPipelines();
  assert.deepEqual(optionsOf(doc), [""], "the refused bundle offers nothing before the press");

  // The control is a real press, not a direct call: the listener the tab wires at load is what runs.
  doc.getElementById("pipeline-pdl-repair").dispatch("click");
  await until("the tab to offer the eleven", () => optionsOf(doc).length === 11);

  assert.deepEqual(calls.posts, [{ seed: true }], "the import is asked for THIS checkout's seed, and nothing else");
  assert.equal(calls.reads, 1, "the tab re-read the catalogue after the write landed");
  assert.equal(doc.getElementById("pipeline-summary").textContent, "11 pipelines · 0 definitions");
  assert.deepEqual(optionsOf(doc), validBundle().pipelines.map((p) => `pdl:${p.id}`));
  assert.equal(doc.getElementById("pipeline-pdl-summary").textContent.startsWith("11 pipelines"), true);
  assert.equal(doc.getElementById("pipeline-pdl-repair").hidden, true, "a repaired bundle needs no second press");
  // The route's own sentence is printed — it is the only record the reader gets that the refused file was replaced.
  assert.match(doc.getElementById("pipeline-pdl-repair-note").textContent, /^repaired the bundle: the file it replaces cannot be read/);
  assert.equal(doc.getElementById("pipeline-pdl-repair-note").hidden, false);
});
