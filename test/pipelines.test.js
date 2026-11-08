// The pipeline data model, docs/pipelines.md §1, §1.5, §2 and §3 — the spec this file is written against.
//
// Five things are driven rather than read off the source:
//
//   1. the catalogue — pipelines.seed.json as shipped, merged per id with the reader's pipelines.json, where the
//      reader's edit to an id wins and a seed record still reaches an install that already has a live file;
//   2. the refusal — a live file whose `version` is newer than PIPELINES_VERSION is refused WHOLE and the seed loads
//      read-only, never half-parsed into a catalogue that looks complete;
//   3. the drop — a definition with an unknown check, an uncompilable pattern, an unknown placeholder or no exit is
//      dropped BY ID and named, while every other definition in the same file still loads;
//   4. the ladder — local → investigation → turnover only ever climbs, and a downgrade is refused with the document's
//      own sentence rather than applied quietly;
//   5. the record — `{id, stage, since, history[]}` written at the cut (lib/jobs.js `makeWorktree`) always as local,
//      durable on the tree, copied onto the job, read back on /api/jobs and changed through POST /api/worktree/pipeline;
//   6. the four P0 findings in docs/pipelines-audit.md — an unreadable book is never rewritten from the empty document,
//      a write that fails is a null (and a 500), the seed's `local` prompt agrees with the landing paragraph every run
//      is handed, and a switch that cannot start its run is refused instead of spending the one-way ladder.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Jobs } from "../lib/jobs.js";
import {
  BUILTIN_IDS,
  EXIT_CHECKS,
  KIND_RANK,
  PIPELINES_VERSION,
  PROMPT_PLACEHOLDERS,
  PipelineRecords,
  Pipelines,
  advanceStage,
  changePipeline,
  cutPipeline,
  defaultForProject,
  defaultsForProject,
  ladderRefusal,
  mergeDocs,
  pipelinesDoc,
  presumedPipeline,
  promptPlaceholders,
  rankOf,
  readPipelinesFile,
  resetPipelinesCache,
  storeSwitch,
  unknownPlaceholders,
  validatePipeline,
} from "../lib/pipelines.js";
import { branchLandingLine } from "../lib/branch-policy.js";
import { ROOT, configureRepo, git as runGit, post, startPanel, waitFor, waitForRow } from "../tools/panel-testkit.mjs";
import { statePaths } from "../lib/paths.js";

// Jobs reads this box's Hermes session store for counters; a suite about records must not read the developer's own.
process.env.HERMES_HOME = mkdtempSync(path.join(os.tmpdir(), "wtgui-pipelines-home-"));
process.env.API_SERVER_KEY = "";

const SEED = path.join(ROOT, "pipelines.seed.json");
const git = (dir, args) => runGit(dir, args);
const KEY = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

function withDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-pipelines-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function withDirAsync(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-pipelines-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

const writeJson = (file, body) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
};

// The smallest valid definition: one stage with one exit from the closed vocabulary. `over` edits it into the
// invalid shapes the catalogue must drop.
function definition(id, kind, over = {}) {
  return {
    id,
    kind,
    title: `${id} title`,
    description: "a fixture",
    stages: [{ id: "work", title: "Work", prompt: "Do the thing in {{tree}} on {{branch}}.", exit: { check: "clean" } }],
    next: null,
    ...over,
  };
}

// The ladder definitions the switching route is driven against. The seed ships none now — every shipped pipeline is a
// PDL document — so a test that exercises the ladder route writes its own live file, the same file a reader edits,
// rather than depending on what the seed happens to hold.
const LADDER_FIXTURE = [
  { id: "github-force-merge", kind: "turnover", stages: ["commit", "version", "push", "pr", "merge", "main"] },
  { id: "sefl-review-loop", kind: "turnover", stages: ["branch", "push", "pr", "wait", "address", "approve", "merge"] },
  { id: "sefl-investigate", kind: "investigation", stages: ["probe", "conclude"] },
];
const ladderFixture = () =>
  LADDER_FIXTURE.map(({ id, kind, stages }) =>
    definition(id, kind, { stages: stages.map((s) => ({ id: s, title: s, prompt: `Do ${s} on {{branch}}.`, exit: { check: "clean" } })) }),
  );

// ---- §1.5: the seed ---------------------------------------------------------------------------------------------
// The ladder seed ships EMPTY. Every pipeline this board ships is a PDL document in pipeline-bundle.seed.json, so the
// seed's job is now to be a valid, empty catalogue — and the seven definitions that used to live in it are checked
// where they live, stage for stage, so a conversion that dropped a stage or a prompt fails here.
test("the shipped ladder seed is a valid, empty catalogue", () => {
  const doc = readPipelinesFile(SEED);
  assert.deepEqual(doc.warnings, []);
  assert.deepEqual(doc.dropped, []);
  assert.equal(doc.version, PIPELINES_VERSION);
  assert.equal(doc.refused, null);
  assert.deepEqual(doc.pipelines, {}, "nothing ships in the ladder catalogue");
  // The three built-in ids are still the closed defaults the code resolves to; they are simply PDL documents now.
  assert.deepEqual(Object.values(BUILTIN_IDS), ["local", "investigate", "turnover"]);
});

test("the seven converted pipelines are PDL documents, stage for stage, with their prompts kept", () => {
  const bundle = JSON.parse(readFileSync(path.join(ROOT, "pipeline-bundle.seed.json"), "utf8"));
  const byId = new Map(bundle.pipelines.map((p) => [p.id, p]));
  // The ladder's own stage lists, in the ladder's own order. A conversion that renamed, merged or dropped a stage
  // fails on the first line of this table.
  const LADDER = {
    local: ["work"],
    investigate: ["probe", "conclude"],
    turnover: ["commit", "push", "pr"],
    "github-investigate": ["probe", "conclude"],
    "sefl-investigate": ["probe", "conclude"],
    "github-force-merge": ["commit", "version", "push", "pr", "merge", "main"],
    "sefl-review-loop": ["branch", "push", "pr", "wait", "address", "approve", "merge"],
  };
  for (const [id, stages] of Object.entries(LADDER)) {
    const pdl = byId.get(id);
    assert.ok(pdl, `${id} ships as a PDL pipeline`);
    assert.deepEqual(pdl.stages.map((s) => s.id), stages, `${id}: the ladder's stages, in the ladder's order`);
    // Every stage keeps an instruction, and it is prose: the PDL driver hands stage.prompt verbatim, so a ladder
    // {{placeholder}} left in it would reach the agent as braces.
    for (const stage of pdl.stages) {
      assert.ok(typeof stage.prompt === "string" && stage.prompt.trim().length > 20, `${id}/${stage.id}: a prompt`);
      assert.deepEqual(promptPlaceholders(stage.prompt), [], `${id}/${stage.id}: no ladder hole survives the conversion`);
      assert.ok(stage.artifact && stage.artifact.id && stage.artifact.path && stage.artifact.writer, `${id}/${stage.id}: an artifact`);
      assert.ok(pdl.roles.some((r) => r.id === stage.owner.role), `${id}/${stage.id}: its owner is on the roster`);
    }
    // A pipeline with no round trip carries the ladder's stage order as consecutive handoffs. The review loop does not:
    // its path is wait -> address -> wait -> approve, so its edges are asserted by name below.
    const carried = pdl.handoffs.map((h) => `${h.from}->${h.to}`);
    if (!pdl.handoffs.some((h) => h.kind === "loop")) {
      const expected = stages.slice(0, -1).map((s, i) => `${s}->${stages[i + 1]}`);
      for (const edge of expected) assert.ok(carried.includes(edge), `${id}: a handoff carries ${edge}`);
    }
    for (const gate of pdl.gates) assert.ok(stages.includes(gate.after), `${id}: gate ${gate.id} ends a stage the document holds`);
  }
  // The review loop's round trip is a DECLARED capped loop now, not the map's inference.
  const review = byId.get("sefl-review-loop");
  const loop = review.handoffs.find((h) => h.kind === "loop");
  assert.ok(loop, "the review loop declares its round trip");
  assert.equal(loop.from, "wait");
  assert.equal(loop.to, "address");
  assert.match(loop.cap, /^\d+ rounds$/);
  // The two chains the ladder carried in `next` survive in the description's own words, because PDL has no chain field.
  assert.match(byId.get("github-investigate").description, /chain into a turnover/);
  assert.match(byId.get("sefl-investigate").description, /chain into the review loop/);
});

test("the merge is per id: the reader's edit wins, and a seed record still arrives", () =>
  withDir((dir) => {
    resetPipelinesCache();
    const live = path.join(dir, "pipelines.json");
    writeJson(live, {
      version: PIPELINES_VERSION,
      pipelines: [
        {
          ...definition("turnover", "turnover"),
          title: "the reader's own turnover",
          stages: [{ id: "mine", title: "Mine", prompt: "Only mine, on {{branch}}.", exit: { check: "pushed" } }],
        },
        definition("reader-only", "investigation"),
      ],
    });
    const doc = pipelinesDoc({ file: live, seedFile: SEED, ttlMs: 0 });
    assert.equal(doc.readOnly, false);
    assert.equal(doc.refused, null);
    // The edit wins...
    assert.equal(doc.pipelines.turnover.title, "the reader's own turnover");
    assert.deepEqual(doc.pipelines.turnover.stages.map((s) => s.id), ["mine"]);
    // ...the reader's new definition is there...
    assert.equal(doc.pipelines["reader-only"].kind, "investigation");
    // ...and every seed record the reader did NOT edit is still in force, without anybody merging JSON by hand.
    for (const id of Object.keys(readPipelinesFile(SEED).pipelines)) assert.ok(doc.pipelines[id], `seed ${id} still reaches this install`);
    // The live file's version is the catalogue's version.
    assert.equal(doc.version, PIPELINES_VERSION);
  }));

// ---- §1.5: a newer file is refused whole ------------------------------------------------------------------------
test("a live file newer than this code is refused whole, and the seed loads read-only", () =>
  withDir((dir) => {
    resetPipelinesCache();
    const live = path.join(dir, "pipelines.json");
    writeJson(live, {
      version: PIPELINES_VERSION + 1,
      pipelines: [definition("from-the-future", "turnover")],
    });
    const liveDoc = readPipelinesFile(live);
    assert.ok(liveDoc.refused, "the newer file is refused");
    assert.equal(liveDoc.refused.version, PIPELINES_VERSION + 1);
    assert.equal(liveDoc.refused.supported, PIPELINES_VERSION);
    assert.deepEqual(liveDoc.pipelines, {}, "nothing in a refused file is half-parsed");
    assert.match(liveDoc.warnings.join("\n"), /refused whole/);

    const doc = mergeDocs(readPipelinesFile(SEED), liveDoc);
    assert.equal(doc.readOnly, true);
    assert.ok(doc.refused);
    assert.equal(doc.pipelines["from-the-future"], undefined, "no definition from the newer file is in force");
    // The seed is the catalogue, and the seed ships nothing: a refused live file leaves an EMPTY ladder, not a
    // half-parsed one and not a resurrected default.
    assert.deepEqual(doc.pipelines, {}, "the seed contributes no definition");
    assert.ok(!doc.pipelines.gone, "and nothing was invented");

    // The loader (what the server holds) refuses it the same way, not only the pure merge.
    const throughLoader = pipelinesDoc({ file: live, seedFile: SEED, ttlMs: 0 });
    assert.equal(throughLoader.readOnly, true);
    assert.equal(throughLoader.pipelines["from-the-future"], undefined);
  }));

// ---- §1.5: one bad definition is dropped by id, the rest of the catalogue loads ---------------------------------
test("an invalid definition is dropped by id and named, while the rest of the file still loads", () =>
  withDir((dir) => {
    resetPipelinesCache();
    const live = path.join(dir, "pipelines.json");
    writeJson(live, {
      version: PIPELINES_VERSION,
      pipelines: [
        definition("good-one", "investigation"),
        definition("unknown-check", "turnover", {
          stages: [{ id: "only", title: "Only", prompt: "{{desc}}", exit: { check: "looks-done" } }],
        }),
        definition("bad-pattern", "turnover", {
          stages: [{ id: "name", title: "Name", prompt: "{{desc}}", exit: { check: "branch-name", pattern: "(unclosed" } }],
        }),
        definition("unknown-hole", "investigation", {
          stages: [{ id: "probe", title: "Probe", prompt: "Read {{ticket}} and {{ticketId}}", exit: { check: "clean" } }],
        }),
        definition("no-exit", "turnover", { stages: [{ id: "work", title: "Work", prompt: "{{desc}}" }] }),
        definition("bad-params", "turnover", {
          stages: [{ id: "run", title: "Run", prompt: "{{desc}}", exit: { check: "command", argv: "node tools/x.mjs check" } }],
        }),
        // The same id twice: the array form carries ids, so a duplicate is a real (and detected) mistake.
        definition("doubled", "investigation"),
        definition("doubled", "turnover", { title: "the second one" }),
      ],
    });
    const doc = readPipelinesFile(live);
    const dropped = new Set(doc.dropped.map((d) => d.id));
    for (const id of ["unknown-check", "bad-pattern", "unknown-hole", "no-exit", "bad-params"]) {
      assert.ok(dropped.has(id), `${id} is dropped by id`);
      assert.ok(!doc.pipelines[id], `${id} is not in force`);
    }
    assert.equal(doc.pipelines["good-one"].kind, "investigation", "the valid definition still loads");
    assert.equal(doc.pipelines.doubled.title, "doubled title", "the first of a duplicate id is the one in force");
    assert.equal(dropped.has("doubled"), true, "the duplicate is named");
    // Every drop is a sentence saying which id and why.
    const said = doc.warnings.join("\n");
    assert.match(said, /pipeline "unknown-check": stage 1: exit\.check "looks-done" is not one of the closed vocabulary/);
    assert.match(said, /pipeline "bad-pattern": stage 1: exit\.pattern does not compile as a regex/);
    assert.match(said, /pipeline "unknown-hole": stage 1: prompt uses unknown placeholder \{\{ticketId\}\}/);
    assert.match(said, /pipeline "no-exit": stage 1: no exit/);
    assert.match(said, /pipeline "bad-params": stage 1: exit\.argv must be a single argv list/);
    // The merged catalogue — what the panel actually offers — is the seed plus only the valid record.
    resetPipelinesCache();
    const merged = pipelinesDoc({ file: live, seedFile: SEED, ttlMs: 0 });
    assert.ok(merged.pipelines["good-one"]);
    // The seed ships nothing, so the merged catalogue is exactly the live file's valid records.
    assert.deepEqual(Object.keys(merged.pipelines).sort(), ["doubled", "good-one"]);
    assert.equal(merged.pipelines["unknown-check"], undefined);
  }));

test("validation refuses the shapes §1.1/§1.3/§1.4/§5 name, one sentence each", () => {
  const healthy = definition("healthy", "turnover");
  assert.deepEqual(validatePipeline("healthy", healthy), []);
  const cases = [
    [definition("not-a-slug!", "local"), /the id must be a slug/],
    [definition("wrong-kind", "probe"), /kind must be one of local, investigation, turnover/],
    [definition("no-stages", "local", { stages: [] }), /stages must be a non-empty list/],
    [definition("dotted", "turnover", { stages: [{ id: "s", title: "S", prompt: "{{desc}}", exit: { check: "pr-approved", who: ["a"] } }] }), /exit\.who is not a parameter of the pr-approved check/],
    [definition("needs-who", "turnover", { stages: [{ id: "s", title: "S", prompt: "{{desc}}", exit: { check: "reviewers-exact" } }] }), /exit\.who is required/],
    [definition("needs-path", "turnover", { stages: [{ id: "s", title: "S", prompt: "{{desc}}", exit: { check: "file-exists" } }] }), /exit\.path is required/],
    [definition("bad-min", "turnover", { stages: [{ id: "s", title: "S", prompt: "{{desc}}", exit: { check: "commits", min: 0 } }] }), /exit\.min must be a positive integer/],
    [definition("no-prompt", "turnover", { stages: [{ id: "s", title: "S", exit: { check: "clean" } }] }), /prompt is required/],
    [definition("dup-stage", "turnover", { stages: [{ id: "s", title: "S", prompt: "x", exit: { check: "clean" } }, { id: "s", title: "S2", prompt: "y", exit: { check: "clean" } }] }), /duplicate stage id/],
  ];
  for (const [def, wants] of cases) {
    const errors = validatePipeline(def.id, def);
    assert.ok(errors.length, `${def.id} is refused`);
    assert.match(errors.join("; "), wants, def.id);
  }
  // A chain may not go backwards: the cross-reference needs the catalogue, and a lower kind is refused.
  const catalogue = { local: definition("local", "local"), high: definition("high", "turnover", { next: "local" }) };
  const errors = validatePipeline("high", catalogue.high, { catalogue });
  assert.match(errors.join("; "), /a chain may not go backwards \(turnover → local\)/);
});

// ---- §2: the defaults, resolved like policyForProject -----------------------------------------------------------
test("a project's default resolves project → global → the built-in, and a bad id falls back with the reason", () =>
  withDir((dir) => {
    resetPipelinesCache();
    const live = path.join(dir, "pipelines.json");
    // The seed ships no definition, so the fixture carries the two built-in ids the resolver falls back to as well as
    // the reader's own: the fallback is a property of the resolver, not of what the seed happens to hold.
    writeJson(live, {
      version: PIPELINES_VERSION,
      pipelines: [
        definition("mine", "turnover"),
        definition("theirs", "turnover"),
        definition("probe", "investigation"),
        definition("wrong-rung", "investigation"),
        definition(BUILTIN_IDS.turnover, "turnover"),
        definition(BUILTIN_IDS.investigation, "investigation"),
      ],
    });
    const catalogue = pipelinesDoc({ file: live, seedFile: SEED, ttlMs: 0 });

    // 1. the project's own value wins.
    const own = defaultForProject({ name: "Menu", defaultTurnover: "mine", defaultInvestigation: "probe" }, "turnover", { catalogue, config: { defaultTurnover: "theirs" } });
    assert.equal(own.id, "mine");
    assert.equal(own.source, "project");
    assert.equal(own.fallback, false);
    assert.equal(own.why, "");

    // 2. the global config value when the project names none.
    const global = defaultForProject({ name: "Menu" }, "turnover", { catalogue, config: { defaultTurnover: "theirs" } });
    assert.equal(global.id, "theirs");
    assert.equal(global.source, "global");

    // 3. the built-in of that kind when nothing names one.
    const builtin = defaultForProject({ name: "Menu" }, "turnover", { catalogue, config: {} });
    assert.equal(builtin.id, BUILTIN_IDS.turnover);
    assert.equal(builtin.kind, "turnover");
    assert.equal(builtin.source, "builtin");
    assert.equal(builtin.fallback, false, "using the closed default is not a fallback-with-a-complaint");

    // An id that names nothing falls back to the built-in AND says so — never a guessed pipeline.
    const nothing = defaultForProject({ name: "Menu", defaultTurnover: "no-such-thing" }, "turnover", { catalogue, config: {} });
    assert.equal(nothing.id, BUILTIN_IDS.turnover);
    assert.equal(nothing.fallback, true);
    assert.match(nothing.why, /this project's defaultTurnover names "no-such-thing", which is not in the catalogue — the built-in "turnover" is in force/);

    // The wrong KIND is the same refusal, with the definition's own kind named.
    const wrongKind = defaultForProject({ name: "Menu", defaultTurnover: "wrong-rung" }, "turnover", { catalogue, config: {} });
    assert.equal(wrongKind.id, BUILTIN_IDS.turnover);
    assert.equal(wrongKind.fallback, true);
    assert.match(wrongKind.why, /which is a pipeline of kind investigation, not turnover/);

    // Both defaults at once, the shape a chip's menu reads.
    const both = defaultsForProject({ name: "Menu", defaultTurnover: "mine", defaultInvestigation: "probe" }, { catalogue, config: {} });
    assert.deepEqual([both.turnover.id, both.investigation.id], ["mine", "probe"]);
  }));

test("config.json carries the two defaults beside remoteBranchPolicy, and they name definitions in force", () => {
  // config.json is the reader's own file — machine paths and their board — so it is gitignored and a fresh worktree has
  // only the tracked template. The template is what ships, so it is what must carry the two keys.
  const checkout = path.join(ROOT, "config.json");
  const file = existsSync(checkout) ? checkout : path.join(ROOT, "config.example.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  assert.ok("remoteBranchPolicy" in config);
  assert.ok("defaultTurnover" in config, `${path.basename(file)} carries defaultTurnover beside remoteBranchPolicy`);
  assert.ok("defaultInvestigation" in config, `${path.basename(file)} carries defaultInvestigation beside remoteBranchPolicy`);
  // The definitions in force are the seven PDL documents in the bundle — the ladder seed ships empty — so an id a
  // project names has to resolve to one of those (or to a ladder definition a reader still keeps in the seed).
  const bundle = JSON.parse(readFileSync(path.join(ROOT, "pipeline-bundle.seed.json"), "utf8"));
  const inForce = new Set([...bundle.pipelines.map((p) => p.id), ...Object.keys(readPipelinesFile(SEED).pipelines)]);
  for (const project of config.projects || []) {
    for (const key of ["defaultTurnover", "defaultInvestigation"]) {
      const id = project[key];
      if (id == null) continue;
      assert.ok(inForce.has(id), `${project.name}'s ${key} names a definition in force (${id})`);
    }
  }
});

// ---- §3: the ladder ----------------------------------------------------------------------------------------------
test("the ladder only climbs: an upgrade appends the transition, a downgrade is refused with the sentence", () => {
  assert.deepEqual(KIND_RANK, { local: 0, investigation: 1, turnover: 2 });
  assert.equal(rankOf("turnover"), 2);
  assert.equal(rankOf("nonsense"), null);

  const at = "2026-11-02T13:02:11.004Z";
  const cut = cutPipeline({ at });
  assert.deepEqual(cut, {
    id: "local",
    stage: "work",
    since: at,
    history: [{ from: "local", to: "local", stage: "work", at, by: "cut", why: "every tree is cut local" }],
  });

  // local → turnover: the record moves, `since` is the change's clock, and the path gains one entry.
  const toTurnover = changePipeline(cut, { fromKind: "local", toKind: "turnover", id: "sefl-review-loop", stage: "branch", by: "reader", why: "the chip: this is a turnover", at: "2026-11-02T14:28:40.119Z" });
  assert.equal(toTurnover.ok, true, toTurnover.error);
  assert.equal(toTurnover.pipeline.id, "sefl-review-loop");
  assert.equal(toTurnover.pipeline.stage, "branch");
  assert.equal(toTurnover.pipeline.since, "2026-11-02T14:28:40.119Z");
  assert.equal(toTurnover.pipeline.history.length, 2);
  assert.deepEqual(toTurnover.pipeline.history[1], {
    from: "local",
    to: "turnover",
    stage: "branch",
    at: "2026-11-02T14:28:40.119Z",
    by: "reader",
    why: "the chip: this is a turnover",
  });

  // A same-kind change is not a change on this ladder: the chip offers nothing on a turnover, and the route refuses
  // a sideways swap rather than letting one definition silently replace another at the same rung.
  const sideways = changePipeline(toTurnover.pipeline, { fromKind: "turnover", toKind: "turnover", id: "sefl-review-loop", stage: "push", by: "stage", why: "branch-name matched", at: "2026-11-02T14:29:55.870Z" });
  assert.equal(sideways.ok, false);
  assert.match(sideways.error, /only ever climbs/);

  // turnover → investigation: refused, and with the document's own sentence.
  const down = changePipeline(toTurnover.pipeline, { fromKind: "turnover", toKind: "investigation", id: "sefl-investigate", stage: "probe", by: "reader", at });
  assert.equal(down.ok, false);
  assert.equal(down.code, "downgrade");
  assert.equal(down.error, "this tree is already a turnover; a turnover branch reported as an investigation would be reported as not landing");
  assert.equal(down.pipeline.id, "sefl-review-loop", "a refused change hands the record back untouched");

  // turnover → local says the same thing about not landing, and investigation → local explains the push.
  assert.match(ladderRefusal("turnover", "local"), /reported as not landing/);
  assert.match(ladderRefusal("investigation", "local"), /local may not push/);
  assert.equal(ladderRefusal("local", "investigation"), null);
  assert.equal(ladderRefusal("local", "turnover"), null);
  assert.equal(ladderRefusal("investigation", "turnover"), null);

  // A tree that predates pipelines is presumed local, and its first change is a real transition from local.
  const presumed = presumedPipeline();
  const first = changePipeline(presumed, { fromKind: "local", toKind: "turnover", id: "github-force-merge", stage: "commit", at });
  assert.equal(first.ok, true);
  assert.deepEqual(first.pipeline.history.map((h) => [h.from, h.to, h.by]), [["local", "turnover", "reader"]]);

  // A hop INSIDE a definition is not a pipeline change: the ladder does not see it, the id stays, and every hop of a
  // loop is appended (wait → address → wait → approve is one path of four entries, not a set of two).
  const atWait = "2026-11-02T15:00:00.000Z";
  const waiting = advanceStage(first.pipeline, { kind: "turnover", stage: "wait", at: atWait, why: "pr-open matched" });
  const addressed = advanceStage(waiting, { kind: "turnover", stage: "address", at: atWait, why: "a comment arrived" });
  const backToWait = advanceStage(addressed, { kind: "turnover", stage: "wait", at: atWait, why: "the comment was answered" });
  assert.equal(backToWait.id, "github-force-merge", "a stage hop never changes the definition");
  assert.equal(backToWait.stage, "wait");
  assert.deepEqual(backToWait.history.map((h) => h.stage), ["commit", "wait", "address", "wait"]);
  assert.equal(backToWait.history.at(-1).by, "stage");
  assert.equal(advanceStage(cut, { kind: "sideways", stage: "x" }), null, "an unknown kind is not a hop");
});

// ---- §3: the record at the cut -----------------------------------------------------------------------------------
test("makeWorktree writes the pipeline at the cut, always as local, onto the tree and its book", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-pipelines-cut-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const repo = path.join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  configureRepo(repo);
  writeFileSync(path.join(repo, "README.md"), "# cut\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "first"]);

  const records = new PipelineRecords({ file: path.join(dir, "pipeline-records.json") });
  const jobs = new Jobs({ config: { jobsFile: path.join(dir, "jobs.json"), defaultCwd: repo } });
  jobs.pipelineRecords = records;

  const made = await jobs.makeWorktree(repo, "find out why the probe stalls");
  assert.equal(made.pipeline.id, "local", "a tree is cut local");
  assert.equal(made.pipeline.stage, "work");
  assert.equal(made.pipeline.history.length, 1);
  assert.deepEqual(
    { from: made.pipeline.history[0].from, to: made.pipeline.history[0].to, by: made.pipeline.history[0].by, why: made.pipeline.history[0].why },
    { from: "local", to: "local", by: "cut", why: "every tree is cut local" },
  );
  assert.equal(made.pipeline.since, made.pipeline.history[0].at, "`since` is when the stage began, which at the cut is the cut");
  assert.ok(!Number.isNaN(Date.parse(made.pipeline.since)));

  // The durable record is the TREE's, keyed by its path, in the panel's state folder — not only on a job.
  const onDisk = JSON.parse(readFileSync(path.join(dir, "pipeline-records.json"), "utf8"));
  assert.equal(onDisk.version, 1);
  assert.deepEqual(onDisk.trees[KEY(made.path)], made.pipeline);
  assert.equal(records.get(made.path)?.id, "local", "and it reads back by the tree it was keyed on");

  // A card in that tree reads the same record through the book, whether or not it ever saw the cut.
  assert.equal(jobs.pipelineForJob({ ownerPath: made.path }).id, "local");
});

// ---- P0-1 (docs/pipelines-audit.md): an unreadable book is never rewritten ----------------------------------------
test("P0-1: an unreadable pipeline-records.json is never rewritten from the empty document", () =>
  withDir((dir) => {
    const file = path.join(dir, "pipeline-records.json");
    const a = { id: "local", stage: "work", since: "2026-11-01T00:00:00.000Z", history: [] };
    const b = { id: "github-force-merge", stage: "commit", since: "2026-11-01T01:00:00.000Z", history: [] };
    // A book that exists and parses, truncated the way a panel killed mid-write leaves one: two trees are in it.
    const book = `${JSON.stringify({ version: 1, trees: { "c:/a": a, "c:/b": b } }, null, 2)}\n`;
    const truncated = book.slice(0, 43);
    writeFileSync(file, truncated, "utf8");
    const lines = [];
    const records = new PipelineRecords({ file, log: (line) => lines.push(line) });

    assert.equal(records.doc({ fresh: true }).loaded, false, "a book that threw is not a loaded book");
    assert.equal(records.set("c:/c", a), null, "set refuses to write over a book it could not read");
    assert.equal(readFileSync(file, "utf8"), truncated, "the unreadable book is left byte-for-byte as it was");
    assert.match(lines.join("\n"), /could not read/);
    assert.match(lines.join("\n"), /refusing to write/);
    assert.equal(records.get("c:/c"), null, "nothing is in force for the tree that tried");

    // A book that CAN be read is still written, and the tree already in it survives the write.
    writeFileSync(file, `${JSON.stringify({ version: 1, trees: { "c:/b": b } }, null, 2)}\n`, "utf8");
    assert.deepEqual(records.set("c:/c", a), a);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8")).trees).sort(), ["c:/b", "c:/c"]);
  }));

// ---- P0-2 (docs/pipelines-audit.md): a write that fails is never reported as a record ------------------------------
test("P0-2: a write that fails returns null, and the switch answers 500 with no record", () =>
  withDir((dir) => {
    const file = path.join(dir, "pipeline-records.json");
    const b = { id: "local", stage: "work", since: "2026-11-01T00:00:00.000Z", history: [] };
    const book = `${JSON.stringify({ version: 1, trees: { "c:/b": b } }, null, 2)}\n`;
    writeFileSync(file, book, "utf8");
    // The book reads fine, and the write still fails: `set` writes through `<file>.tmp` and a directory sits there.
    mkdirSync(`${file}.tmp`, { recursive: true });
    const lines = [];
    const records = new PipelineRecords({ file, log: (line) => lines.push(line) });
    const rec = { id: "github-force-merge", stage: "commit", since: "2026-11-02T00:00:00.000Z", history: [] };

    assert.equal(records.set("c:/tree", rec), null, "set returns the record only when the write happened");
    assert.equal(readFileSync(file, "utf8"), book, "the book on disk was not touched, and no other tree was dropped");
    assert.match(lines.join("\n"), /is not durable and nothing was changed/);

    // The route's own step: a ladder-approved switch whose write fails is a 500 carrying no record, so a card can
    // never be told a switch was stored. While the turn start is missing it is the 501 refusal — never a 200.
    const failed = storeSwitch(records, "c:/tree", rec, { turnStart: true });
    assert.equal(failed.status, 500);
    assert.equal(failed.code, "not-durable");
    assert.equal(failed.pipeline, null, "there is no record to hand a card");
    assert.equal(storeSwitch(records, "c:/tree", rec).status, 501, "the turn-start gate answers first, and never 200");
  }));

// ---- P0-3 (docs/pipelines-audit.md): one landing instruction, not three -------------------------------------------
test("P0-3: the local pipeline's prompt and the landing paragraph a run is handed agree", () => {
  // `local` is a PDL document now, so the prompt this pins is the one in the bundle — the same sentence the ladder
  // shipped, with its {{desc}} hole dropped (the driver appends the task's own detail) and {{branch}} spelled out.
  const bundle = JSON.parse(readFileSync(path.join(ROOT, "pipeline-bundle.seed.json"), "utf8"));
  const local = bundle.pipelines.find((p) => p.id === "local");
  assert.ok(local, "the local pipeline ships in the PDL bundle");
  const prompt = local.stages[0].prompt;
  // What a local run on a tree cut from main is actually handed (lib/jobs.js composes this ahead of the prompt).
  const landing = branchLandingLine({ parent: "main", branch: "wtgui/x", policy: "allow", remote: "origin" }, "C:/tree");
  assert.match(landing, /git push -u origin HEAD/, "a tree cut from main is told to push");
  assert.match(landing, /gh pr create --fill/);

  // The seed must not contradict that paragraph...
  assert.doesNotMatch(prompt, /do not push/i);
  assert.doesNotMatch(prompt, /do not open a pull request/i);
  assert.doesNotMatch(local.description, /no push/i);
  // ...it must name the one paragraph that decides, and the document must say the same.
  assert.match(prompt, /LANDING paragraph/);
  assert.match(prompt, /only instruction about pushing and opening a pull request/);
  const design = readFileSync(path.join(ROOT, "docs/pipelines.md"), "utf8");
  assert.match(design, /\*\*One landing instruction\.\*\*/);
  assert.match(design, /branchLandingLine` renders is the authoritative/);
});

// ---- §3 + §4.1: the record read on /api/jobs, changed only through the one route --------------------------------
test("the switching route reads the tree's record back on /api/jobs and refuses every non-climb without writing", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-pipelines-route-"));
  const logs = path.join(dir, "logs");
  mkdirSync(logs, { recursive: true });
  const tree = path.join(dir, "repos", "tree-turnover");
  const ghostTree = path.join(dir, "repos", "tree-ghost");
  const jobsFile = path.join(logs, "jobs.json");
  const since = "2026-11-01T12:00:00.000Z";
  const turnoverRecord = {
    id: "github-force-merge",
    stage: "commit",
    since,
    history: [{ from: "local", to: "turnover", stage: "commit", at: since, by: "reader", why: "seeded" }],
  };
  const card = (id, ownerPath) => ({
    id,
    thread: `wtgui-pipeline-${id}`,
    turn: 1,
    prompt: "work",
    cwd: ownerPath,
    sessionId: `wtgui-pipeline-${id}`,
    status: "interrupted",
    exitCode: null,
    fatal: null,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    endedAt: new Date(Date.now() - 30_000).toISOString(),
    error: "the panel restarted while this was running",
    worktree: path.basename(ownerPath),
    worktreePath: ownerPath,
    ownerPath,
    lines: [],
  });
  writeJson(jobsFile, { savedAt: new Date().toISOString(), jobs: [card("on-turnover", tree), card("on-ghost", ghostTree)] });
  // A turnover record for one tree, and a record naming a definition the catalogue does not hold for the other: the
  // route must read the first back and must refuse to guess the second's rung.
  writeJson(path.join(logs, "pipeline-records.json"), {
    version: 1,
    trees: {
      [KEY(tree)]: turnoverRecord,
      [KEY(ghostTree)]: { id: "ghost-pipeline", stage: "probe", since: new Date().toISOString(), history: [] },
    },
  });

  // The ladder the route reads: the seed ships none, so the live file carries the three ids this test switches between.
  const pipelinesFile = path.join(logs, "pipelines.json");
  writeJson(pipelinesFile, { version: PIPELINES_VERSION, pipelines: ladderFixture() });
  const panel = await startPanel({ dir, config: { jobsFile, pipelinesFile, assistant: { enabled: false }, projects: [] } });
  t.after(async () => {
    await panel.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  const cards = async () => (await (await fetch(`${panel.base}/api/jobs`)).json()).jobs;
  const call = (body) => post(panel.base, "/api/worktree/pipeline", { body });

  // The read side: the card carries the record the book holds, stage and all.
  const onBoard = (await cards()).find((c) => c.id === "on-turnover");
  assert.ok(onBoard, "the seeded card is on /api/jobs");
  assert.equal(onBoard.pipeline.id, "github-force-merge");
  assert.equal(onBoard.pipeline.stage, "commit");

  // The live file is the catalogue: the seed ships nothing, so what the route can switch to is exactly what is written
  // here, and the version stamp is the one this panel reads.
  const live = JSON.parse(readFileSync(pipelinesFile, "utf8"));
  assert.equal(live.version, PIPELINES_VERSION);
  assert.deepEqual(live.pipelines.map((p) => p.id).sort(), ["github-force-merge", "sefl-investigate", "sefl-review-loop"]);

  // turnover → investigation: a 409 with the sentence, and the file is untouched.
  const down = await call({ path: tree, id: "sefl-investigate" });
  assert.equal(down.status, 409, down.text);
  assert.equal(down.json.code, "downgrade");
  assert.equal(down.json.error, "this tree is already a turnover; a turnover branch reported as an investigation would be reported as not landing");
  assert.equal(JSON.parse(readFileSync(path.join(logs, "pipeline-records.json"), "utf8")).trees[KEY(tree)].id, "github-force-merge");
  assert.equal((await cards()).find((c) => c.id === "on-turnover").pipeline.id, "github-force-merge");

  // A sideways swap is refused too: only a strictly higher rung is a change.
  const sideways = await call({ path: tree, id: "sefl-review-loop" });
  assert.equal(sideways.status, 409, sideways.text);
  assert.match(sideways.json.error, /only ever climbs/);

  // An id the catalogue does not hold is a 404 naming the catalogue it asked.
  const unknown = await call({ path: tree, id: "no-such-pipeline" });
  assert.equal(unknown.status, 404, unknown.text);
  assert.match(unknown.json.error, /no pipeline "no-such-pipeline" in the catalogue/);
  assert.match(unknown.json.error, /github-force-merge/);

  // A record whose definition vanished cannot be judged on the ladder, so it is refused rather than guessed.
  const ghost = await call({ path: ghostTree, id: "github-force-merge" });
  assert.equal(ghost.status, 409, ghost.text);
  assert.equal(ghost.json.code, "unknown-current");
  assert.match(ghost.json.error, /ghost-pipeline/);

  // The two 400s: a request the route cannot act on at all.
  assert.equal((await call({ id: "turnover" })).status, 400);
  assert.equal((await call({ path: tree })).status, 400);
});

// ---- P0-4 (docs/pipelines-audit.md): a switch that cannot start its run is refused ---------------------------------
test("P0-4: a switch that cannot start its run is refused and the record is unchanged", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-pipelines-refuse-"));
  const logs = path.join(dir, "logs");
  mkdirSync(logs, { recursive: true });
  const tree = path.join(dir, "repos", "tree-local");
  const jobsFile = path.join(logs, "jobs.json");
  const card = {
    id: "in-tree",
    thread: "wtgui-pipeline-in-tree",
    turn: 1,
    prompt: "work",
    cwd: tree,
    sessionId: "wtgui-pipeline-in-tree",
    status: "interrupted",
    exitCode: null,
    fatal: null,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    endedAt: new Date(Date.now() - 30_000).toISOString(),
    error: "the panel restarted while this was running",
    worktree: path.basename(tree),
    worktreePath: tree,
    ownerPath: tree,
    lines: [],
  };
  writeJson(jobsFile, { savedAt: new Date().toISOString(), jobs: [card] });
  // The climb this test refuses is a real one, so the target has to be in the catalogue the route reads.
  const pipelinesFile = path.join(logs, "pipelines.json");
  writeJson(pipelinesFile, { version: PIPELINES_VERSION, pipelines: ladderFixture() });

  const panel = await startPanel({ dir, config: { jobsFile, pipelinesFile, assistant: { enabled: false }, projects: [] } });
  t.after(async () => {
    await panel.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  const cards = async () => (await (await fetch(`${panel.base}/api/jobs`)).json()).jobs;
  assert.equal((await cards()).find((c) => c.id === "in-tree").pipeline, null, "the tree has no record to begin with");

  // local → turnover is a legal climb, and it is still refused: the route cannot start the turnover's first stage, and
  // the ladder only climbs, so writing `{stage: "commit", since: now}` would spend the tree's one move on a run that
  // never began.
  const res = await post(panel.base, "/api/worktree/pipeline", { body: { path: tree, id: "github-force-merge" } });
  assert.equal(res.status, 501, res.text);
  assert.equal(res.json.code, "no-turn-start");
  assert.match(res.json.error, /not yet wired to a turn start/);
  assert.equal(res.json.pipeline.id, "local", "the answer describes the record that is still in force");

  // Nothing was recorded: no rung, no `since` clocking a stage, no history entry.
  const bookFile = path.join(logs, "pipeline-records.json");
  const onDisk = existsSync(bookFile) ? JSON.parse(readFileSync(bookFile, "utf8")) : { trees: {} };
  assert.equal(onDisk.trees[KEY(tree)], undefined);
  assert.equal((await cards()).find((c) => c.id === "in-tree").pipeline, null, "and the live card was not handed a record");
});

// ---- P0-5 (docs/pipelines-audit.md): the second cut path writes the tree's rung -----------------------------------
// A real parent worktree on its own branch, and the real server on a throwaway store: the claim is about what
// `POST /api/worktree/child` writes to disk, so a unit stub that calls the writer proves nothing.
async function childCutFixture(t) {
  const base = mkdtempSync(path.join(os.tmpdir(), "wtgui-pipelines-child-"));
  const scanRoot = path.join(base, "repos");
  const repo = path.join(scanRoot, "proj");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  configureRepo(repo);
  writeFileSync(path.join(repo, "base.txt"), "base\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "main: base"]);

  const parentTree = path.join(repo, ".worktrees", "feat-parent");
  git(repo, ["worktree", "add", "-q", "-b", "feat/parent", parentTree]);
  writeFileSync(path.join(parentTree, "parent.txt"), "the parent's work\n", "utf8");
  git(parentTree, ["add", "."]);
  git(parentTree, ["commit", "-q", "-m", "parent: its own commit"]);

  // The ladder the later switch reads: the seed ships none, so the fixture is the catalogue.
  const pipelinesFile = path.join(base, "pipelines.json");
  writeJson(pipelinesFile, { version: PIPELINES_VERSION, pipelines: ladderFixture() });
  const panel = await startPanel({ config: { scanRoots: [scanRoot], pipelinesFile } });
  t.after(async () => {
    await panel.stop();
    rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const reload = await post(panel.base, "/api/reload", { body: {} });
  assert.equal(reload.status, 200, `reload must succeed: ${reload.text.slice(0, 200)}`);
  const parentRow = await waitForRow(panel.base, "proj", parentTree);
  const cfg = JSON.parse(readFileSync(panel.configPath, "utf8"));
  return { panel, parentRow, recordsFile: statePaths(cfg).pipelineRecordsFile };
}

test("P0-5: POST /api/worktree/child writes the child's local record, and a later switch keeps it", async (t) => {
  const { panel, parentRow, recordsFile } = await childCutFixture(t);

  const cut = await post(panel.base, "/api/worktree/child", { body: { project: "proj", path: parentRow.path } });
  assert.equal(cut.status, 200, `the cut must answer 200: ${cut.text.slice(0, 400)}`);
  const made = cut.json;
  assert.equal(made.pipeline?.id, "local", "the cut answers with the rung it just wrote");
  assert.equal(made.pipeline?.stage, "work");

  // The book on disk, at the path statePaths() resolves for this sandbox — what a restart, a wake or a second panel
  // reads, not the in-memory copy the route happened to hand back.
  const book = JSON.parse(readFileSync(recordsFile, "utf8"));
  const rec = book.trees[KEY(made.path)];
  assert.ok(rec, `the child tree has a record: ${JSON.stringify(book.trees)}`);
  assert.equal(rec.id, "local");
  assert.equal(rec.stage, "work");
  assert.equal(rec.history.length, 1);
  assert.equal(rec.history[0].by, "cut", "§3's history starts at the cut, not at the first switch");
  assert.equal(rec.history[0].why, "every tree is cut local");
  assert.equal(rec.since, rec.history[0].at, "`since` is when the first rung began, which at the cut is the cut");

  // A later switch keeps that entry: the route reads the same record and (with no turn start yet) writes nothing.
  const switched = await post(panel.base, "/api/worktree/pipeline", { body: { path: made.path, id: "sefl-investigate" } });
  assert.equal(switched.status, 501, switched.text);
  const after = JSON.parse(readFileSync(recordsFile, "utf8"));
  assert.deepEqual(after.trees[KEY(made.path)], rec, "the cut entry is exactly the record the switch read back");
});

test("P0-5: a cut whose pipeline record is refused still cuts, says so, and never claims the rung", async (t) => {
  const { panel, parentRow, recordsFile } = await childCutFixture(t);

  // A book that exists and cannot be parsed, the shape a kill mid-write leaves. 0195d75's `set` refuses to write over
  // it; this route must pass that refusal on rather than replace the book or report a rung that is not there.
  const truncated = `${JSON.stringify({ version: 1, trees: { "c:/a": { id: "github-force-merge", stage: "commit", since: "2026-11-01T00:00:00.000Z", history: [] } } }, null, 2)}\n`.slice(0, 47);
  mkdirSync(path.dirname(recordsFile), { recursive: true });
  writeFileSync(recordsFile, truncated, "utf8");

  const cut = await post(panel.base, "/api/worktree/child", { body: { project: "proj", path: parentRow.path } });
  assert.equal(cut.status, 200, `the tree exists, so the cut itself stands: ${cut.text.slice(0, 400)}`);
  assert.equal(cut.json.ok, true);
  assert.equal(cut.json.pipeline, null, "the answer never claims a rung the book refused to store");
  assert.equal(readFileSync(recordsFile, "utf8"), truncated, "the unreadable book is left byte-for-byte, not replaced with an empty one");

  // The refusal is in the cut's own log, not only in a corner of the record book.
  const said = await waitFor(() => /(was not recorded as local|pipeline record was refused)/.test(panel.log()), {
    timeoutMs: 5_000,
    what: "the cut's log to say the rung was refused",
    silent: true,
  });
  assert.equal(said, true, `the refusal is said where the cut reports:\n${panel.log().slice(-2_000)}`);
});

// ---- P0-6 (docs/pipelines-audit.md): a hole written with spaces is still a hole -----------------------------------
test("P0-6: the five hole spellings are judged by the name inside the braces, padding included", () => {
  const shape = (hole) => ({
    id: "shapes",
    kind: "investigation",
    title: "shapes",
    description: "a fixture",
    stages: [{ id: "probe", title: "Probe", prompt: `Read ${hole} before you start.`, exit: { check: "clean" } }],
    next: null,
  });
  // The audit's table, all five spellings: two are refused because the name is unknown, one is accepted because the
  // name is known — with the padding that used to make the scanner blind to it — and the last two keep their answers.
  const cases = [
    { hole: "{{nope}}", name: "nope", accepted: false },
    { hole: "{{ nope }}", name: "nope", accepted: false },
    { hole: "{{ ticket }}", name: "ticket", accepted: true },
    { hole: "{{TICKET}}", name: "TICKET", accepted: false },
    { hole: "{{ticketId}}", name: "ticketId", accepted: false },
  ];
  for (const { hole, name, accepted } of cases) {
    const prompt = `Read ${hole} before you start.`;
    assert.deepEqual(promptPlaceholders(prompt), [name], `${hole} is scanned as the bare name ${name}`);
    const errors = validatePipeline("shapes", shape(hole));
    if (accepted) {
      assert.deepEqual(errors, [], `${hole} is a known hole, so the definition is saved`);
      assert.deepEqual(unknownPlaceholders(prompt), [], `${hole} is not unknown`);
    } else {
      assert.equal(errors.length, 1, `${hole} is refused: ${errors.join("; ")}`);
      assert.match(errors[0], new RegExp(`uses unknown placeholder \\{\\{${name}\\}\\}`), `${hole} is refused by name`);
    }
  }
  // A padded known placeholder resolves to its parameter, including the mixed-case name in the closed list.
  assert.deepEqual(promptPlaceholders("{{ ticket }} and {{ lastSeen }} and {{tree}}"), ["ticket", "lastSeen", "tree"]);
  assert.deepEqual(unknownPlaceholders("{{ ticket }} and {{ lastSeen }}"), []);
  assert.deepEqual(validatePipeline("shapes", shape("{{ ticket }}")), []);
});
