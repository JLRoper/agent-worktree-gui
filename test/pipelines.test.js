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
//      durable on the tree, copied onto the job, read back on /api/jobs and changed through POST /api/worktree/pipeline.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  unknownPlaceholders,
  validatePipeline,
} from "../lib/pipelines.js";
import { ROOT, configureRepo, git as runGit, post, startPanel } from "../tools/panel-testkit.mjs";

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

// ---- §1.5: the seed ---------------------------------------------------------------------------------------------
test("the shipped seed is a valid catalogue carrying the three built-in kinds", () => {
  const doc = readPipelinesFile(SEED);
  assert.deepEqual(doc.warnings, []);
  assert.deepEqual(doc.dropped, []);
  assert.equal(doc.version, PIPELINES_VERSION);
  assert.equal(doc.refused, null);
  for (const kind of Object.keys(BUILTIN_IDS)) {
    const builtin = doc.pipelines[BUILTIN_IDS[kind]];
    assert.ok(builtin, `the seed ships a ${kind} definition (${BUILTIN_IDS[kind]})`);
    assert.equal(builtin.kind, kind);
  }
  // Every check the seed uses is in §1.3's closed vocabulary, and every hole its prompts carry is in §1.4's list.
  for (const [id, def] of Object.entries(doc.pipelines)) {
    for (const stage of def.stages) {
      assert.ok(EXIT_CHECKS.includes(stage.exit.check), `${id}/${stage.id}: ${stage.exit.check} is a closed check`);
      for (const hole of promptPlaceholders(stage.prompt)) {
        assert.ok(PROMPT_PLACEHOLDERS.includes(hole), `${id}/${stage.id}: {{${hole}}} is a closed placeholder`);
      }
      assert.deepEqual(unknownPlaceholders(stage.prompt), []);
    }
  }
  // The two host turnover pipelines the document names by id are the data, not code paths.
  assert.equal(doc.pipelines["github-force-merge"].kind, "turnover");
  assert.equal(doc.pipelines["sefl-review-loop"].kind, "turnover");
  assert.deepEqual(doc.pipelines["sefl-review-loop"].stages.map((s) => s.id), ["branch", "push", "pr", "wait", "address", "approve", "merge"]);
  assert.match(doc.pipelines["sefl-review-loop"].stages[0].exit.pattern, /^\^\\d\{8\}_/);
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
    assert.ok(doc.pipelines[BUILTIN_IDS.local], "the seed is the catalogue");
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
    assert.ok(merged.pipelines[BUILTIN_IDS.turnover]);
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
    writeJson(live, { version: PIPELINES_VERSION, pipelines: [definition("mine", "turnover"), definition("theirs", "turnover"), definition("probe", "investigation"), definition("wrong-rung", "investigation")] });
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
  const config = JSON.parse(readFileSync(path.join(ROOT, "config.json"), "utf8"));
  assert.ok("remoteBranchPolicy" in config);
  assert.ok("defaultTurnover" in config, "config.json carries defaultTurnover beside remoteBranchPolicy");
  assert.ok("defaultInvestigation" in config, "config.json carries defaultInvestigation beside remoteBranchPolicy");
  const catalogue = readPipelinesFile(SEED);
  for (const project of config.projects || []) {
    const resolved = defaultsForProject(project, { catalogue, config });
    for (const kind of ["turnover", "investigation"]) {
      const got = resolved[kind];
      assert.ok(got.definition, `${project.name}'s ${kind} default resolves to a definition in force (${got.id})`);
      assert.equal(got.definition.kind, kind);
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

// ---- §3 + §4.1: the record read on /api/jobs, changed only through the one route --------------------------------
test("POST /api/worktree/pipeline climbs the ladder, /api/jobs reads it back, and a downgrade writes nothing", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-pipelines-route-"));
  const logs = path.join(dir, "logs");
  mkdirSync(logs, { recursive: true });
  const tree = path.join(dir, "repos", "tree-local");
  const ghostTree = path.join(dir, "repos", "tree-ghost");
  const jobsFile = path.join(logs, "jobs.json");
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
  writeJson(jobsFile, { savedAt: new Date().toISOString(), jobs: [card("in-tree", tree), card("on-ghost", ghostTree)] });
  // A record naming a definition the catalogue does not hold: the route must refuse to guess its rung.
  writeJson(path.join(logs, "pipeline-records.json"), {
    version: 1,
    trees: { [KEY(ghostTree)]: { id: "ghost-pipeline", stage: "probe", since: new Date().toISOString(), history: [] } },
  });

  const panel = await startPanel({ dir, config: { jobsFile, assistant: { enabled: false }, projects: [] } });
  t.after(async () => {
    await panel.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  const cards = async () => (await (await fetch(`${panel.base}/api/jobs`)).json()).jobs;
  const call = (body) => post(panel.base, "/api/worktree/pipeline", { body });

  // Before any change, the tree has no record: the card says so rather than inventing one.
  const before = (await cards()).find((c) => c.id === "in-tree");
  assert.ok(before, "the seeded card is on /api/jobs");
  assert.equal(before.pipeline, null);

  // The catalogue live file is created beside hosts.json, with the version stamp.
  const live = JSON.parse(readFileSync(path.join(logs, "pipelines.json"), "utf8"));
  assert.equal(live.version, PIPELINES_VERSION);
  assert.deepEqual(live.pipelines, [], "the live file starts empty: the defaults are the seed's");

  // local → turnover.
  const up = await call({ path: tree, id: "github-force-merge" });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.ok, true);
  assert.equal(up.json.from, "local");
  assert.equal(up.json.fromKind, "local");
  assert.equal(up.json.id, "github-force-merge");
  assert.equal(up.json.toKind, "turnover");
  assert.equal(up.json.stage, "commit", "the first stage of the definition is where the tree now stands");
  assert.deepEqual(up.json.pipeline, {
    id: "github-force-merge",
    stage: "commit",
    since: up.json.pipeline.since,
    history: [
      { from: "local", to: "turnover", stage: "commit", at: up.json.pipeline.since, by: "reader", why: "the reader chose github-force-merge" },
    ],
  });
  assert.ok(up.json.cards.includes("in-tree"), "the live card in that tree was handed the record");

  // The read side: /api/jobs carries the record, stage and all.
  const after = (await cards()).find((c) => c.id === "in-tree");
  assert.equal(after.pipeline.id, "github-force-merge");
  assert.equal(after.pipeline.stage, "commit");

  // The durable record is on disk, keyed by the tree.
  const onDisk = JSON.parse(readFileSync(path.join(logs, "pipeline-records.json"), "utf8"));
  assert.equal(onDisk.trees[KEY(tree)].id, "github-force-merge");

  // turnover → investigation: a 409 with the sentence, and the file is untouched.
  const down = await call({ path: tree, id: "sefl-investigate" });
  assert.equal(down.status, 409, down.text);
  assert.equal(down.json.code, "downgrade");
  assert.equal(down.json.error, "this tree is already a turnover; a turnover branch reported as an investigation would be reported as not landing");
  assert.equal(JSON.parse(readFileSync(path.join(logs, "pipeline-records.json"), "utf8")).trees[KEY(tree)].id, "github-force-merge");
  assert.equal((await cards()).find((c) => c.id === "in-tree").pipeline.id, "github-force-merge");

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
