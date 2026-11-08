// public/core/pipeline-mermaid.js - the one card renderer, and the model it draws.
//
// The reader's question was why the popup could not have the map page's charts. The answer is this module: the map page
// (public/pipeline-map.html) and the dialog's Preview (public/pipeline-modal.js) hand it the same model and read back
// the same card. Node has no mermaid and no DOM, so what is pinned here is everything that decides what a card SAYS:
//
//   - the definition-to-card model: ordinal, title, the derived role (with its rule, its evidence and its quote), the
//     exit label on the edge that leaves the stage, the inferred review round, and the refusal to invent a role;
//   - the mermaid source: one line per stage, one per edge, one per loop, with mermaid's entity codes kept visible;
//   - the exit label vocabulary (`commits ≥ 1`, `file-exists <name>`, `command: <argv>`, ...);
//   - the page's own ledger names this module and hashes the bytes it has: the artefact and the source cannot drift
//     apart without this failing.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ladderDefinition } from "./fixtures/ladder-definitions.mjs";

await import("../public/core/pipeline-mermaid.js");
const M = globalThis.PipelineMermaid;

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const LF = (text) => text.replaceAll(String.fromCharCode(13), "").replaceAll(String.fromCharCode(13, 10), "\n");
// The ladder shapes a reader's own pipelines.json may still hold. The seed ships none now — every shipped pipeline is
// a PDL document — but `fromDefinition` is still the renderer for a definition, so it is driven against the fixture.
const def = ladderDefinition;
const sha256 = (text) => createHash("sha256").update(Buffer.from(LF(text), "utf8")).digest("hex");

test("a catalogue definition becomes the card's model: ordinal, title, derived role and the exit on the edge", () => {
  const item = M.fromDefinition(def("turnover"));
  assert.equal(item.id, "turnover");
  assert.equal(item.title, "Turnover");
  assert.equal(item.kind, "turnover");
  assert.equal(item.next, null);
  assert.deepEqual(item.stages.map((s) => s.id), ["commit", "push", "pr"]);
  assert.deepEqual(item.stages.map((s) => s.ordinal), [1, 2, 3]);
  assert.deepEqual(item.stages.map((s) => s.title), ["Commit", "Push the branch", "Open the pull request"]);
  assert.deepEqual(item.stages.map((s) => s.role.label), ["derived: worker · commits", "derived: worker · pushes", "derived: worker · opens the PR"]);
  assert.deepEqual(item.stages.map((s) => s.role.rule), ["commit", "push", "open-pr"]);
  assert.deepEqual(item.stages.map((s) => s.role.source), ["derived", "derived", "derived"]);
  // Every derived line carries the phrase it matched, and that phrase is IN that stage's prompt.
  for (const stage of item.stages) {
    assert.ok(stage.role.evidence && stage.prompt.includes(stage.role.evidence), `${stage.id}: evidence ${JSON.stringify(stage.role.evidence)}`);
    assert.ok(stage.role.quote && stage.role.quote.length <= 220, `${stage.id}: quote`);
  }
  assert.deepEqual(item.edges.map((e) => e.label), ["commits ≥ 1", "pushed"]);
  assert.deepEqual(item.lastExit, { stage: "pr", label: "pr-open", exit: { check: "pr-open" } });
  assert.deepEqual(item.loops, []);
});

test("the one inferred round trip is drawn for the definition that declares no loop, and named as an inference", () => {
  const item = M.fromDefinition(def("sefl-review-loop"));
  assert.equal(item.loops.length, 1);
  const [loop] = item.loops;
  assert.equal(loop.source, "inferred");
  assert.equal(loop.from, "approve");
  assert.equal(loop.to, "address");
  assert.match(loop.note, /declares no loop/i);
  // A definition that DOES declare a loop is read as data and keeps its own id and cap.
  const declared = M.fromDefinition({ id: "x", stages: [{ id: "a", prompt: "Do the work in this tree" }, { id: "b", prompt: "Do the work in this tree" }], loops: [{ id: "L1", from: "b", to: "a", cap: "2 rounds" }] });
  assert.equal(declared.loops[0].source, "data");
  assert.equal(declared.loops[0].short, "L1");
  assert.equal(declared.loops[0].cap, "2 rounds");
});

test("an unmatched prompt is refused, never given an invented role - and the lenient reader says so instead", () => {
  const odd = { id: "odd", stages: [{ id: "s1", title: "Something else", prompt: "Do whatever this says." }] };
  assert.throws(() => M.fromDefinition(odd, { strict: true }), /refusing to invent a role/);
  const lenient = M.fromDefinition(odd);
  assert.equal(lenient.stages[0].role.source, "unstated");
  assert.equal(lenient.stages[0].role.label, "role: not stated");
  // The table itself is closed and each label is the one the model prints.
  const ids = M.ROLE_RULES.map((r) => r.id);
  assert.deepEqual(ids, [...new Set(ids)], "no rule id appears twice");
  for (const rule of M.ROLE_RULES) assert.ok(rule.label && rule.why, `rule ${rule.id} carries a label and a why`);
});

test("the exit label is the check the panel evaluates, compacted for an 11 px edge", () => {
  assert.equal(M.compactExit({ check: "commits", min: 1 }), "commits ≥ 1");
  assert.equal(M.compactExit({ check: "file-exists", path: "docs/investigation.md" }), "file-exists investigation.md");
  assert.equal(M.compactExit({ check: "command", argv: ["node", "tools/version.mjs", "check"] }), "command: node tools/version.mjs check");
  assert.equal(M.compactExit({ check: "branch-name" }), "branch-name");
  assert.equal(M.compactExit(null), "");
  assert.equal(M.compactExit({}), "");
});

test("a stage's label is two lines: the ordinal and title, then the role", () => {
  const label = M.labelFor({ ordinal: 2, title: "Push the branch", role: { label: "derived: worker · pushes" } });
  assert.equal(label, '<b>2</b> · Push the branch<br><span class="pm-role">derived: worker · pushes</span>');
});

test("mermaid's own punctuation is entity-coded, so a title's # _ * ` | are painted as themselves", () => {
  const label = M.labelFor({ ordinal: 1, title: "A & B #1 _x_ *y* `z` |q| <b>", role: { label: "role: not stated" } });
  assert.equal(label, '<b>1</b> · A #amp; B #35;1 #95;x#95; #42;y#42; #96;z#96; #124;q#124; #lt;b#gt;<br><span class="pm-role">role: not stated</span>');
  assert.ok(!/[<>]/.test(label.replace(/<b>|<\/b>|<br>|<span class="pm-role">|<\/span>/g, "")), "no raw angle bracket survives");
});

test("the row source is one flowchart LR: a node per stage, an arrow per edge, a dashed arrow per loop", () => {
  const item = {
    id: "demo",
    stages: [
      { id: "a", ordinal: 1, title: "Alpha", role: { label: "derived: worker · does the work" } },
      { id: "b", ordinal: 2, title: "Beta", role: { label: "derived: worker · commits" } },
    ],
    edges: [{ from: "a", to: "b", label: "commits ≥ 1" }],
    loops: [{ id: "L1", from: "b", to: "a", cap: "2 rounds", short: "L1", source: "data" }],
  };
  const lines = M.rowSource(item).split("\n");
  assert.equal(lines[0], "flowchart LR");
  assert.equal(lines.length, 5);
  assert.equal(lines[1], '  n_a["<b>1</b> · Alpha<br><span class="pm-role">derived: worker · does the work</span>"]');
  assert.equal(lines[3], '  n_a -->|"commits ≥ 1"| n_b');
  assert.equal(lines[4], '  n_b -.->|"L1 2→1 · 2 rounds"| n_a');
  // A node id is sanitised, because mermaid owns the id it derives from ours.
  assert.equal(M.nodeIdOf("a stage.id!"), "n_a_stage_id_");
});

test("the book source only carries the edges whose both ends are inside the slice", () => {
  const item = {
    id: "demo",
    stages: [
      { id: "a", ordinal: 1, title: "Alpha", role: { label: "role: not stated" } },
      { id: "b", ordinal: 2, title: "Beta", role: { label: "role: not stated" } },
      { id: "c", ordinal: 3, title: "Gamma", role: { label: "role: not stated" } },
    ],
    edges: [
      { from: "a", to: "b", label: "commits ≥ 1" },
      { from: "b", to: "c", label: "" },
    ],
    loops: [],
  };
  const row = M.bookRowSource(item, 0, 2).split("\n");
  assert.equal(row.length, 4, "two nodes and one edge");
  assert.ok(row[1].includes("· Alpha") && row[2].includes("· Beta"));
  assert.ok(!row.join("\n").includes("n_c"), "the stage outside the slice is not drawn");
  assert.equal(row[3], '  n_a -->|"commits ≥ 1"| n_b');
});

test("the map page's ledger names this module and its stylesheet, hashed over the bytes on disk", () => {
  const page = LF(read("public/pipeline-map.html"));
  const block = /<script id="pipeline-map-data" type="application\/json">([\s\S]*?)<\/script>/.exec(page);
  assert.ok(block, "the page carries its data block");
  const data = JSON.parse(block[1].replace(/\\u003c/g, "<"));
  const sources = new Map(data.meta.sources.map((s) => [s.file, s]));
  for (const [rel, role] of [
    ["public/core/pipeline-mermaid.js", /card renderer/],
    ["public/core/pipeline-card.css", /stylesheet/],
  ]) {
    const row = sources.get(rel);
    assert.ok(row, `${rel} is in the page's source ledger`);
    assert.ok(row.exists, `${rel} exists on disk`);
    assert.match(row.role, role);
    assert.equal(row.bytes, Buffer.byteLength(LF(read(rel))), `${rel}: the ledger's byte count is the LF-normalised file`);
    assert.equal(row.sha256, sha256(read(rel)), `${rel}: the ledger's hash is the file's`);
  }
  // The page loads the shared renderer BEFORE its own script, and the card stylesheet is INLINED (the page stays one
  // file that opens offline), so no <link> to it appears there.
  const moduleAt = page.indexOf('<script src="core/pipeline-mermaid.js?v=');
  const pageAt = page.indexOf('<script src="pipeline-map.js?v=');
  assert.ok(moduleAt > 0 && pageAt > moduleAt, "the renderer loads before the page's own script");
  assert.ok(page.includes(".pm-card {"), "the card's stylesheet is inlined into the page");
});

test("the panel loads the same renderer and the same card stylesheet", () => {
  const html = LF(read("public/index.html"));
  const moduleAt = html.indexOf('<script src="/core/pipeline-mermaid.js"></script>');
  const flowAt = html.indexOf('<script src="/pipeline-flow.js"></script>');
  const modalAt = html.indexOf('<script src="/pipeline-modal.js"></script>');
  assert.ok(moduleAt > 0 && flowAt > moduleAt && modalAt > flowAt, "the card renderer loads before the modal that draws it");
  assert.ok(html.includes('<link rel="stylesheet" href="/core/pipeline-card.css" />'), "the card stylesheet is linked");
  // The panel serves the vendored mermaid the dialog's Preview loads on its first open. The route is a read of the
  // repo's own tools/vendor copy, never a CDN.
  const server = LF(read("server.js"));
  assert.match(server, /if \(route === "\/vendor\/mermaid\.min\.js" && req\.method === "GET"\)/);
  assert.match(server, /tools", "vendor", "mermaid\.min\.js"/);
});
