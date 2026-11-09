// The ARTIFACT VIEW: what the drawing puts between the stages, and the three edge kinds it says it draws.
//
// The brief's second item: thin for `inputs.read`, thick for a handoff, dashed for the `external_inputs` boundary —
// and all of it from data the document already holds. So this file pins three things about the REAL seed and one
// hand-written fixture:
//
//   1. the node count is DERIVED — every artifact named as an input somewhere (a stage's `inputs.read[]`, a handoff's
//      `artifact`, the document's `external_inputs`) and nothing else. A drawing that invents an artifact, or drops
//      one, fails here;
//   2. a connector the document hands an artifact across is thick, and a read of something written further back is a
//      thin line — the two are not the same mark;
//   3. a read naming an artifact NOTHING here writes is drawn and MARKED missing, with the word painted: a drawing
//      that quietly dropped it would certify a graph the document does not have.
//
// The view is markup-and-a-list, not a screenshot: `flow.artifacts` is the list and `<span class="pflow-artifact">` is
// the drawing, so a test reads the same facts a reader sees.
//
// The last two cases are about the artifact's OTHER reader, the settle: which TREE it resolves a stage's artifact
// against. They live here because this is the file the artifact rules are proved in, and the rule they pin is the same
// one the drawing follows - an artifact is the file its writer wrote, not whatever sits at that path elsewhere.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseBundle } from "../lib/pipeline-bundle.js";
import { pipelineCatalogue } from "../lib/task-pipeline-assign.js";
import { START_GRACE_MS, driveTaskPipelines } from "../lib/task-pipeline-drive.js";
import { ladderDefinition } from "./fixtures/ladder-definitions.mjs";

await import("../public/pipeline-flow.js");
const { fromBundle, fromDefinition, fromWindowModel, markup } = globalThis.PipelineFlow;

// The seed is the panel's multi-pipeline wrapper; the 13-stage studio export is its `poc-to-uat` entry.
const SEED_DOC = JSON.parse(readFileSync(new URL("../pipeline-bundle.seed.json", import.meta.url), "utf8"));
const SEED = SEED_DOC.pipelines.find((p) => (p.id || (p.project && p.project.id)) === "poc-to-uat");
const SEED_FLOW = fromBundle(SEED);

const chips = (html) =>
  [...html.matchAll(/<span class="pflow-artifact" role="note" data-artifact="([^"]*)" data-at="(\d+)" data-side="([^"]*)" data-kind="([^"]*)"/g)].map((m) => ({
    id: m[1],
    at: Number(m[2]),
    side: m[3],
    kind: m[4],
  }));

const edges = (html) =>
  [...html.matchAll(/<span class="pflow-artifact-edge" data-edge="([^"]*)" data-artifact="([^"]*)" data-to="([^"]*)"/g)].map((m) => ({
    kind: m[1],
    artifact: m[2],
    to: m[3],
  }));

const dots = (html) =>
  [...html.matchAll(/<i class="pflow-artifact-dot" data-edge="([^"]*)" data-artifact="([^"]*)" data-to="([^"]*)"/g)].map((m) => ({
    kind: m[1],
    artifact: m[2],
    to: m[3],
  }));

// Every artifact the document names as somebody's input, from the document's own fields — the number the drawing
// must produce without being told.
function inputsOf(doc) {
  const ids = new Set();
  for (const handoff of doc.handoffs || []) if (handoff.artifact) ids.add(handoff.artifact);
  for (const stage of doc.stages || []) for (const read of (stage.inputs && stage.inputs.read) || []) if (read.artifact) ids.add(read.artifact);
  for (const entry of doc.external_inputs || []) if (entry.artifact) ids.add(entry.artifact);
  return ids;
}

test("the seed draws one node per artifact it names as an input, and no other", () => {
  const expected = inputsOf(SEED);
  const html = markup(SEED_FLOW, null);
  const drawn = chips(html);
  assert.equal(drawn.length, expected.size, `the seed names ${expected.size} input artifacts`);
  assert.deepEqual(
    drawn.map((chip) => chip.id).sort(),
    [...expected].sort(),
    "every artifact named as an input is drawn, and nothing invented",
  );
  assert.match(html, new RegExp(`data-artifacts="${expected.size}"`), "the root says how many nodes the view drew");
  assert.match(html, /<div class="pflow-artifacts" data-pflow-artifacts="\d+"/, "the layer is on the canvas, under the track");
  // A handoff's artifact is a node: the picture is a chain, so every edge the studio drew has something on it.
  for (const handoff of SEED.handoffs) assert.ok(drawn.some((chip) => chip.id === handoff.artifact), `handoff ${handoff.id} carries ${handoff.artifact}`);
});

test("a handoff is thick, a read is thin, and the document's boundary is dashed", () => {
  const html = markup(SEED_FLOW, null);
  // The connector after a stage that hands an artifact on carries the edge's id — that is the thick mark.
  const thick = [...html.matchAll(/<span class="pflow-link" aria-hidden="true" data-handoff="([^"]*)" data-artifact="([^"]*)"/g)].map((m) => ({ edge: m[1], artifact: m[2] }));
  assert.equal(thick.length, 12, "the seed's twelve sequence handoffs are drawn thick");
  assert.deepEqual(
    thick.map((link) => link.edge).sort(),
    SEED.handoffs.filter((handoff) => handoff.kind === "sequence").map((handoff) => handoff.id).sort(),
    "and each names a sequence edge the document holds",
  );
  // A read of an artifact written further back is a thin route to the furthest column it reaches, with a dot under
  // every column that reads it — `semantic-layer` is written at S3 and read again at S5..S8. One line, four dots: a
  // fan-out drawn as four nested lines would paint over itself and say the same thing four times.
  const longRead = edges(html).filter((edge) => edge.artifact === "semantic-layer");
  assert.deepEqual(longRead.map((edge) => [edge.kind, edge.to]), [["read", "S8"]], "one thin route, to the furthest reader");
  assert.deepEqual(
    dots(html).filter((dot) => dot.artifact === "semantic-layer").map((dot) => [dot.kind, dot.to]),
    [["read", "S5"], ["read", "S6"], ["read", "S7"], ["read", "S8"]],
    "and a dot under every stage that reads it (S4 is the handoff, and an adjacent handoff has no line)",
  );
  // The external inputs sit on the document's own left boundary, dashed, and their edges are dashed too.
  const external = chips(html).filter((chip) => chip.kind === "external");
  assert.deepEqual(external.map((chip) => [chip.id, chip.at, chip.side]).sort(), [["branch-head", 0, "left"], ["poc-crawl", 0, "left"], ["poc-snapshot", 0, "left"]].sort());
  assert.ok(edges(html).filter((edge) => edge.kind === "external").length >= 3, "each external read is a dashed edge");
  // Nothing is missing in a document that declares all three: `missing` must not be invented either.
  assert.doesNotMatch(html, /data-missing="1"/);
  // The key names the styles the picture uses, and only those.
  const key = (html.match(/<div class="pflow-artifact-key"[\s\S]*?<\/div>/) || [""])[0];
  assert.deepEqual([...key.matchAll(/data-edge="([^"]*)"/g)].map((m) => m[1]), ["read", "handoff", "external"]);
});

test("a read of an artifact nothing writes is drawn and marked missing, and the word is painted", () => {
  const doc = {
    id: "gaps",
    title: "Gaps",
    stages: [
      { id: "S1", title: "One", prompt: "one", artifact: { id: "a1", path: "a1.json", schema: "a/1", writer: "w1" } },
      {
        id: "S2",
        title: "Two",
        prompt: "two",
        artifact: { id: "a2", path: "a2.json", schema: "a/1", writer: "w2" },
        // `ghost` is read and declared nowhere: not a stage artifact, not an external input.
        inputs: { read: [{ artifact: "a1" }, { artifact: "ghost" }] },
      },
    ],
    gates: [],
    handoffs: [{ id: "H-1", from: "S1", to: "S2", artifact: "a1", kind: "sequence" }],
  };
  const html = markup(fromBundle(doc), null);
  const drawn = chips(html);
  assert.deepEqual(drawn.map((chip) => chip.id).sort(), ["a1", "ghost"], "two nodes: the artifact handed on, and the one nobody writes");
  const ghost = drawn.find((chip) => chip.id === "ghost");
  assert.equal(ghost.kind, "missing");
  assert.match(html, /data-artifact="ghost"[^>]*data-missing="1"/, "the node says it is missing in the DOM");
  // The mark is VISIBLE, not only an attribute: the chip's painted text carries the word.
  const chipHtml = (html.match(/<span class="pflow-artifact"[^>]*data-artifact="ghost"[^>]*>[^<]*<\/span>/) || [""])[0];
  assert.match(chipHtml.replace(/<[^>]*>/g, ""), /ghost — missing/, "the reader sees the word");
  assert.match(chipHtml, /aria-label="[^"]*missing[^"]*"/, "and a screen reader is told the same thing");
  assert.match(html, /<span class="pflow-artifact-key-item" data-edge="missing"><i aria-hidden="true"><\/i>missing — nothing writes it<\/span>/, "the key explains the mark");
  // The artifact handed on across the connector is still thick, beside the missing one.
  assert.equal((html.match(/class="pflow-link" aria-hidden="true" data-handoff="H-1"/g) || []).length, 1);
});

test("a pipeline with no artifacts draws no layer and no key, and a definition has none to draw", () => {
  const bare = { id: "bare", title: "Bare", stages: [{ id: "S1", title: "One", prompt: "one", artifact: { id: "a1", path: "a1", schema: "a/1", writer: "w" } }], gates: [], handoffs: [] };
  const html = markup(fromBundle(bare), null);
  assert.doesNotMatch(html, /class="pflow-artifacts"/);
  assert.doesNotMatch(html, /data-pflow-artifact-key/);
  assert.match(html, /data-artifacts="0"/);
  // A ladder definition has no artifact layer to draw. The seed ships none now, so the shape comes from the fixture.
  const def = ladderDefinition("local");
  assert.doesNotMatch(markup(fromDefinition(def), null), /class="pflow-artifacts"/);
});

test("the catalogue the live flow is handed carries what the drawing needs — nothing reads as missing", () => {
  // The live row's flow is drawn from `/api/assistant/pipeline-catalogue`, not from the document. When that answer
  // omitted the stage's artifact, every node it drew was `missing` — a claim about the DOCUMENT made by a gap in the
  // ANSWER. The catalogue now carries the artifact and the reads, and this pins it.
  const parsed = parseBundle(SEED, { file: "pipeline-bundle.seed.json" });
  assert.equal(parsed.ok, true, parsed.reason);
  const catalogue = pipelineCatalogue(parsed);
  assert.equal(catalogue.ok, true);
  const html = markup(fromBundle(catalogue.pipelines[0]), { stage: "S4" });
  const drawn = chips(html);
  assert.equal(drawn.length, inputsOf(SEED).size, "the live answer draws the same node count as the document");
  assert.deepEqual(drawn.filter((chip) => chip.kind === "missing"), [], "and claims nothing is missing");
  assert.equal((html.match(/class="pflow-link" aria-hidden="true" data-handoff=/g) || []).length, 12, "the thick connectors survive the catalogue too");
});

test("the window model draws the same view from its own stages, when no bundle is available", () => {
  const model = {
    pipeline: { id: "p", title: "P" },
    count: 2,
    externalInputs: [{ artifact: "outside", source: "a checkpoint" }],
    stages: [
      { id: "S1", title: "One", position: 1, phase: "before", artifact: { id: "a1", path: "a1", schema: "a/1", writer: "w1" }, reads: [], handoffOut: { id: "H-1", from: "S1", to: "S2", artifact: "a1", kind: "sequence" } },
      { id: "S2", title: "Two", position: 2, phase: "current", artifact: { id: "a2", path: "a2", schema: "a/1", writer: "w2" }, reads: [{ artifact: "a1" }, { artifact: "outside" }], handoffOut: null },
    ],
  };
  const html = markup(fromWindowModel(model), { stage: "S2" });
  assert.deepEqual(chips(html).map((chip) => chip.id).sort(), ["a1", "outside"]);
  assert.equal(chips(html).find((chip) => chip.id === "outside").kind, "external");
  assert.deepEqual(edges(html).map((edge) => [edge.kind, edge.to]), [["external", "S2"]], "adjacent handoffs are the thick connector, not a line");
});

// ---- the settle's artifact tree ----------------------------------------------------------------------------------
//
// #260 parked on a false verdict: the gui-improve implement stage settled with "its artifact change-set
// (ledger/gui-improve/change-set.patch) is not in the tree", while the change-set sat committed in that stage's OWN
// tree at 49278bee. The settle resolved the artifact against `pipelineRun.tree`, which under a round is the tree the
// ROUND began in - a parent's checkout - so a stage that wrote only in its own workspace was refused on a directory
// it never touched (lib/assistant.js `cutPipelineTree`: a stage's tree is never promoted to the row's).
//
// Both cases pin the rule that replaced it: a stage's artifact is read in the tree its stage run records, and the
// row's tree is the LAST answer, never the first.
const CLOCK = "2026-11-09T10:00:00.000Z";
const EMAIL = ["stage", "example.invalid"].join(String.fromCharCode(64));
const CHANGE_SET = "ledger/gui-improve/change-set.patch";

const GUI_IMPROVE = {
  bundleVersion: 1,
  name: "gui-improve",
  pipelines: [
    {
      id: "gui-improve",
      title: "Gui improve",
      stages: [
        {
          id: "baseline",
          title: "Baseline",
          prompt: "Take the baseline.",
          artifact: { id: "baseline", path: "ledger/gui-improve/baseline/capture.json", schema: "capture/1", writer: "surveyor", kind: "file" },
        },
        {
          id: "implement",
          title: "Implement",
          prompt: "Write the change set.",
          inputs: { read: [{ artifact: "baseline" }] },
          artifact: { id: "change-set", path: CHANGE_SET, schema: "change-set/1", writer: "implementer", kind: "file" },
        },
        {
          id: "compare",
          title: "Compare",
          prompt: "Compare it.",
          inputs: { read: [{ artifact: "baseline" }, { artifact: "change-set" }] },
          artifact: { id: "comparison", path: "ledger/gui-improve/compare/comparison.json", schema: "comparison/1", writer: "surveyor", kind: "file" },
        },
      ],
      gates: [],
      handoffs: [
        { id: "H-01", from: "baseline", to: "implement", artifact: "baseline", kind: "sequence" },
        { id: "H-02", from: "implement", to: "compare", artifact: "change-set", kind: "sequence" },
      ],
    },
  ],
};
const GUI = parseBundle(GUI_IMPROVE, { file: "gui-improve.json" });
assert.equal(GUI.ok, true, GUI.reason || "the fixture bundle must parse");

// A real repository with one commit, and the stage trees the panel cuts from it: `git worktree` directories of the
// SAME repository, so the commit one stage settles at is in the object store every other stage's tree reads. The reads
// under test are git readings (the pin is a blob at a commit), so a fixture that faked one would prove nothing.
function workspace(t) {
  const base = mkdtempSync(path.join(tmpdir(), "wag-artifacts-"));
  const root = path.join(base, "repo");
  mkdirSync(root);
  const git = (where, ...args) =>
    execFileSync("git", ["-C", where, "-c", "user.name=Stage Fixture", "-c", `user.email=${EMAIL}`, "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (where, rel, body) => {
    const at = path.join(where, ...rel.split("/"));
    mkdirSync(path.dirname(at), { recursive: true });
    writeFileSync(at, body);
  };
  git(root, "init", "-q", "-b", "main");
  write(root, "seed.txt", "the round began here\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "the round's parent");
  const cut = (name) => {
    const dir = path.join(base, name);
    git(root, "worktree", "add", "-q", "-b", `stage/${name}`, dir, "main");
    return dir;
  };
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { dir: root, git, write, cut, head: (where) => git(where, "rev-parse", "HEAD") };
}

// A row at the implement stage in the shape #260's ledger carries: the row's tree is one live directory, and the
// implement stage's own run records the directory that stage actually ran in. The record has no `round` - that is a
// record written before rounds existed, and it is exactly where the row's tree and the stage's own tree disagree,
// which is the disagreement the lookup has to settle in the stage's favour.
function implementRow({ rowTree, stageTree, stageSha }) {
  return {
    id: 260,
    title: "the gui-improve round",
    detail: "",
    state: "running",
    thread: "T-impl",
    threads: ["T-impl"],
    worktree: stageTree,
    project: "agent-worktree-gui",
    files: [],
    attempts: 0,
    reason: "",
    hold: null,
    pipelineRun: {
      pipeline: "gui-improve",
      stage: "implement",
      enteredAt: CLOCK,
      via: "H-01",
      visits: { baseline: 1, implement: 1 },
      tree: { path: rowTree, branch: "wtgui/the-round" },
      stageRuns: [
        { id: "gui-improve/baseline#1", stage: "baseline", visit: 1, status: "done", thread: "T-base", artifact: { id: "baseline", path: "ledger/gui-improve/baseline/capture.json", present: true } },
        { id: "gui-improve/implement#1", stage: "implement", visit: 1, status: null, thread: "T-impl", tree: { path: stageTree, branch: "wtgui/the-implement-stage", commit: stageSha } },
      ],
    },
  };
}

const settle = (task) =>
  driveTaskPipelines([task], {
    bundle: GUI.bundle,
    jobs: [{ id: "j-impl", thread: "T-impl", status: "done", startedAt: CLOCK }],
    isLive: () => false,
    at: CLOCK,
    unattended: true,
  });

test("a stage whose artifact is only in its OWN stage tree settles present and hands it on", (t) => {
  const w = workspace(t);
  const rowTree = w.cut("round");
  const stageTree = w.cut("implement");
  w.write(stageTree, CHANGE_SET, "diff --git a/public/style.css b/public/style.css\n");
  w.git(stageTree, "add", "-A");
  w.git(stageTree, "commit", "-qm", "the change set");
  const stageSha = w.head(stageTree);

  const row = implementRow({ rowTree, stageTree, stageSha });

  const out = settle(row);
  const settled = out.tasks[0];
  const entry = settled.pipelineRun.stageRuns.find((run) => run.stage === "implement");

  assert.equal(settled.state, "queued", "the row is not parked");
  assert.equal(settled.pipelineRun.stage, "compare", "the settle moved it to the stage the handoff names");
  assert.equal(entry.artifact.present, true, "the change-set IS in the tree the stage ran in");
  assert.equal(entry.artifact.commit, stageSha, "and it is pinned to that tree's commit");
  assert.match(entry.artifact.blob || "", /^[0-9a-f]{40}$/, "the blob the commit holds is recorded");
  assert.equal(entry.tree.path, stageTree, "the ledger names the tree the artifact was read in, not the row's");

  // Handed on: the next stage's brief names the artifact and the commit to read it at, and its STORED manifest carries
  // the same pin. The round tree is a live directory that never held the file, so a lookup that read there could
  // produce neither.
  const later = new Date(Date.parse(CLOCK) + START_GRACE_MS + 1000).toISOString();
  const next = driveTaskPipelines([{ ...settled, state: "queued" }], { bundle: GUI.bundle, jobs: [], isLive: () => false, at: later, unattended: true });
  assert.equal(next.starts.length, 1, "the compare stage is asked for");
  const start = next.starts[0];
  assert.equal(start.stage, "compare");
  assert.match(start.prompt, /handed on\s+change-set/, "the brief names the change-set it was handed");
  assert.ok(start.prompt.includes(`git show ${stageSha.slice(0, 12)}:${CHANGE_SET}`), "and the commit and path to read it at");
  const compareEntry = next.tasks[0].pipelineRun.stageRuns.find((run) => run.stage === "compare");
  const carried = (compareEntry.inputs || []).find((input) => input.artifact === "change-set");
  assert.ok(carried, "the compare stage's manifest carries the change-set");
  assert.equal(carried.commit, stageSha, "pinned to the commit the implement stage settled at");
  assert.match(carried.blobSha256 || "", /^[0-9a-f]{64}$/, "with the blob's hash, so the bytes are the writer's");
});

test("a stage whose artifact is absent from its OWN stage tree refuses, even when a parent tree holds it", (t) => {
  const w = workspace(t);
  const rowTree = w.cut("round");
  const stageTree = w.cut("implement");
  // The trap: the file exists at the same path in the row's tree (the round's) and nowhere in the stage's own. A
  // lookup that reads the row's directory settles this stage PRESENT and hands on an artifact this stage never wrote.
  w.write(rowTree, CHANGE_SET, "diff --git a/public/style.css b/public/style.css\n");
  w.git(rowTree, "add", "-A");
  w.git(rowTree, "commit", "-qm", "a parent's copy, not the stage's");

  const out = settle(implementRow({ rowTree, stageTree, stageSha: w.head(stageTree) }));
  const parked = out.tasks[0];
  const entry = parked.pipelineRun.stageRuns.find((run) => run.stage === "implement");

  assert.equal(parked.state, "parked", "the row stops");
  assert.equal(parked.pipelineRun.stage, "implement", "at the stage that settled");
  assert.equal(entry.artifact.present, false, "the artifact is not in the stage's own tree");
  assert.match(
    parked.reason,
    /its artifact change-set \(ledger\/gui-improve\/change-set\.patch\) is not in the tree, so handoff H-02 has nothing to pass/,
    "the refusal is the same sentence the panel already prints",
  );
  assert.equal(out.starts.length, 0, "nothing is handed on");
});
