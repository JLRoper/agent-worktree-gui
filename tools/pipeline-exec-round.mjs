#!/usr/bin/env node
// A PIPELINE ROUND, END TO END, THROUGH THE PANEL'S OWN DRIVER.
//
//   node tools/pipeline-exec-round.mjs                 # rounds A and B, independent processes
//   node tools/pipeline-exec-round.mjs --round A       # one round (what the other is run as)
//   node tools/pipeline-exec-round.mjs --work <dir>    # where the fixture repos live (default: OS temp)
//   node tools/pipeline-exec-round.mjs --out <dir>     # where the ledger and the shots go
//
// WHAT IS REAL HERE, and what is a seat.
//
//   real   `Assistant.sweepQueues` — the panel's clock: the bundle read, `driveTaskPipelines`, `settleTasks`, the one
//          `writeQueueFile`, the journal, the tree cut through `jobs.makeWorktree` (`git worktree add`), and the stage
//          prompt the driver builds. Nothing in lib/ is stubbed or imported around.
//   real   every stage's work: a separate `node tools/pipeline-exec-worker.mjs` PROCESS per stage run, which drives
//          headless Chromium against the studio copy in the tree and writes the artifact the stage declares. The
//          worker is handed nothing but the prompt and its tree, so the only way it can know which stage it is in is
//          the provenance line the DRIVER put in that prompt.
//   seat   the model. There is no gateway and no token: the worker is a scripted seat with a stated remit, and the
//          job record it returns is what a gateway would have returned (`thread`, `status`, `finalMessage`).
//
// THE PIPELINE (three stages, one capped loop):
//
//   S1 probe  --probe--> S2 fix --fix--> S3 verify --verify--> loop back to S1, cap "2 rounds"
//
// so a round is: visit 1 of all three stages, a crossing, visit 2 of all three, a second crossing, visit 3 of all
// three, and then the cap refuses the third crossing and the row parks on `pipeline-cap`.
//
// THE TWO ROUNDS are separate PROCESSES, separate fixture repositories, separate queue files and separate Assistant
// instances. They are compared afterwards: same stage sequence, same visits, same crossings, same artifact bytes.
//
// Exit: 0 both rounds ran and the ledger was written; 1 a round did not reach its expected end; 2 the harness could
// not run (no git, no Playwright, a fixture that would not cut).
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Assistant } from "../lib/assistant.js";
import { currentThread, readQueueFile } from "../lib/assistant/queue.js";
import { parseBundle } from "../lib/pipeline-bundle.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] ?? fallback : fallback);
const WORK = path.resolve(opt("--work", path.join(os.tmpdir(), "wag-pipeline-exec")));
const OUT = path.resolve(opt("--out", path.join(REPO, "docs", "reviews", "pipeline-execution-round")));
const ROUND_ARG = String(opt("--round", "both")).toUpperCase();
// Resolved, never written as a literal: the studio is a SIBLING checkout, and a committed absolute path is the one
// thing tools/absolute-paths.mjs refuses (a landing is read on another machine).
const STUDIO_SRC = path.resolve(opt("--studio", path.join(REPO, "..", "..", "..", "ai-development-factory", "tools", "pipeline-studio")));
const PIPELINE_ID = "probe-fix-loop";
const PROJECT = "pipeline-studio-fixture";
const TASK_TITLE = "probe the pipeline studio and fix what the probe finds";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- the pipeline document --------------------------------------------------------------------------------------
// Three stages, three artifacts, one loop. `cap: "2 rounds"` is the studio's own sentence for the edge; the panel
// reads the whole number that opens it and counts CROSSINGS, so two crossings are allowed and the third is refused.
const STAGES = [
  {
    id: "S1",
    title: "Probe the studio",
    prompt:
      "Probe the Pipeline Studio copy in `studio/` for legibility defects, in a real headless browser. Measure the six " +
      "clauses the pipeline's contract names (seed rendered, no page errors, every card named, role/meta lines at 12px " +
      "or more, nothing inside a card below 10px, bundle.json carrying four documents) and write `out/probe.json`: one " +
      "finding per clause with the number that decided it. Do not fix anything — the next stage does that.",
    artifact: { id: "probe", path: "out/probe.json", schema: "probe/1", writer: "probe-seat" },
  },
  {
    id: "S2",
    title: "Fix what the probe found",
    prompt:
      "Read `out/probe.json` and fix ONLY the clauses that failed, in the tree's own copy of the studio. Each fix is a " +
      "real edit to `studio/app.css`; record the file, the rule, and the sha256 before and after in `out/fix.json`. A " +
      "clause the stylesheet does not hold in the shape you expect is reported as unfixable, never invented.",
    artifact: { id: "fix", path: "out/fix.json", schema: "fix/1", writer: "fix-seat" },
  },
  {
    id: "S3",
    title: "Verify the fix",
    prompt:
      "Re-measure every clause in the same browser and write `out/verify.json`: for each clause, what it measured " +
      "before, what it measures now, which previously-failing clauses are fixed, which are still open, and any clause " +
      "the fix broke that was passing before.",
    artifact: { id: "verify", path: "out/verify.json", schema: "verify/1", writer: "verify-seat" },
  },
];

const PIPELINE = {
  id: PIPELINE_ID,
  title: "Probe, fix, verify — a capped repair loop",
  stages: STAGES,
  gates: [],
  handoffs: [
    { id: "H-1", from: "S1", to: "S2", artifact: "probe", kind: "sequence" },
    { id: "H-2", from: "S2", to: "S3", artifact: "fix", kind: "sequence" },
    { id: "H-3", from: "S3", to: "S1", artifact: "verify", kind: "loop", cap: "2 rounds" },
  ],
};

const BUNDLE_DOC = { bundleVersion: 1, name: "pipeline-execution-round", pipelines: [PIPELINE] };

// ---- one round --------------------------------------------------------------------------------------------------
async function runRound(round) {
  const dir = path.join(WORK, `round-${round}`);
  const repo = path.join(dir, "repo");
  const state = { board: [], cuts: [], started: [], live: new Map(), runs: [], exits: new Map(), prompts: [], seq: 0 };

  // 1. The fixture: the studio's own files, committed, so the panel cuts a real branch off a real HEAD.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(STUDIO_SRC, path.join(repo, "studio"), { recursive: true });
  writeFileSync(path.join(repo, ".gitignore"), ".worktrees/\n");
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true }).trim();
  git("init", "-b", "main");
  const GIT_ID = ["-c", "user.name=Round", "-c", `user.email=${["round", "example.invalid"].join(String.fromCharCode(64))}`];
  git(...GIT_ID, "add", "-A");
  git(...GIT_ID, "commit", "-m", "fixture: the studio as the round finds it");
  const head = git("rev-parse", "--short", "HEAD");

  // 2. The bundle, validated by the panel's own loader before anything is driven: a bundle that does not parse is a
  //    fixture bug, not a finding.
  const bundleFile = path.join(dir, "pipeline-bundle.json");
  writeFileSync(bundleFile, `${JSON.stringify(BUNDLE_DOC, null, 2)}\n`);
  const parsed = parseBundle(BUNDLE_DOC, { file: bundleFile });
  if (!parsed.ok) throw new Error(`the fixture bundle does not parse: ${parsed.reason}`);

  // 3. The panel's own clock, with a spawner that runs a real process per stage.
  const jobs = {
    list: () => state.board,
    firstOfThread: (thread) => state.board.find((j) => j.thread === thread) || null,
    busyFor: () => ({ held: false, where: null, by: [] }),
    modelFor: () => null,
    get: (id) => state.board.find((j) => j.id === id) || null,
    create: async (opts) => ({ id: `job-${opts.thread || "x"}`, ...opts }),
    answerQuestion: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    clarify: { state: () => null },
    // `git worktree add -b wtgui/<slug>-<tag>` from the fixture's HEAD — the same shape lib/jobs.js cuts, so the tree
    // the stages run in is a real branch in a real repository, not a directory named in a test.
    makeWorktree: async (repoDir, prompt) => {
      const slug = String(prompt || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24)
        .replace(/-+$/, "") || "agent";
      const tag = sha256(`${round}:${state.cuts.length}:${slug}`).slice(0, 6);
      const branch = `wtgui/${slug}-${tag}`;
      const treePath = path.join(repoDir, ".worktrees", `${slug}-${tag}`).replace(/\\/g, "/");
      execFileSync("git", ["-C", repoDir, "worktree", "add", "-b", branch, treePath, "HEAD"], { encoding: "utf8", windowsHide: true });
      state.cuts.push({ repoDir, prompt, branch, path: treePath, at: iso(Date.now()) });
      return { path: treePath, branch, startSha: head, startRef: "HEAD" };
    },
  };

  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile: path.join(dir, "assistant.json"), defaultCwd: dir, pipelineBundleFile: bundleFile },
    jobs,
    getProjects: () => [{ name: PROJECT, path: repo }],
    getRows: () => [],
    // One process per stage run. It is handed the prompt and the tree, nothing else: the stage it is in and the visit
    // it is on come out of the provenance line lib/task-pipeline-drive.js wrote into that prompt.
    spawner: async (spec) => {
      const found = /\(([\w-]+)\/(S\d+)\), visit (\d+)/.exec(String(spec.prompt || ""));
      if (!found) throw new Error("the stage prompt carries no provenance line — nothing can tell this seat which stage it is in");
      const [, pipelineId, stageId, visit] = found;
      state.seq += 1;
      const thread = `${round.toLowerCase()}-${String(state.seq).padStart(2, "0")}`;
      state.prompts.push({ stage: stageId, visit: Number(visit), prompt: String(spec.prompt || ""), target: spec.target });
      const job = {
        id: `job-${thread}`,
        thread,
        cwd: spec.target,
        worktreePath: spec.target,
        status: "running",
        startedAt: iso(Date.now()),
        assistantId: spec.assistantId || null,
        stage: stageId,
        visit: Number(visit),
      };
      state.board.push(job);
      state.live.set(thread, true);
      const startedAt = Date.now();
      const child = spawn(process.execPath, [path.join(HERE, "pipeline-exec-worker.mjs"), "--stage", stageId === "S1" ? "probe" : stageId === "S2" ? "fix" : "verify", "--tree", spec.target, "--visit", visit], {
        cwd: REPO,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (b) => (out += String(b)));
      child.stderr.on("data", (b) => (err += String(b)));
      const exited = new Promise((resolve) => {
        child.on("exit", (code) => {
          job.status = code === 0 ? "done" : "failed";
          job.finalMessage = code === 0 ? (out.trim().split("\n").at(-2) || "the stage finished") : `worker exited ${code}: ${err.trim().split("\n").at(-1) || ""}`;
          job.finishedAt = iso(Date.now());
          state.live.set(thread, false);
          try {
            const keep = path.join(dir, "artifacts");
            mkdirSync(keep, { recursive: true });
            for (const name of ["probe.json", "fix.json", "verify.json"]) {
              const from = path.join(spec.target, "out", name);
              if (existsSync(from)) cpSync(from, path.join(keep, name.replace(".json", `-visit${visit}.json`)));
            }
          } catch { /* the artifact is already recorded; a copy that fails is not a failed stage */ }
          state.runs.push({ round, thread, stage: stageId, pipeline: pipelineId, visit: Number(visit), exit: code, ms: Date.now() - startedAt, stdout: out.trim().split("\n").slice(0, 3), stderr: err.trim().slice(0, 400) });
          resolve(code);
        });
      });
      state.exits.set(thread, exited);
      return job;
    },
    now: () => Date.now(),
  });
  assistant.settings.spawn = "auto";

  // 4. One row, on S1.
  const added = assistant.queueMutate("assistant-1", "add", { title: TASK_TITLE, project: PROJECT, detail: "one tree, three stages, one capped loop" });
  if (!added.ok) throw new Error(`the row was refused: ${added.error}`);
  const id = added.task.id;
  const assigned = assistant.queueMutate("assistant-1", "pipeline", { id, pipeline: PIPELINE_ID, stage: "S1" });
  if (!assigned.ok) throw new Error(`the pipeline assignment was refused: ${assigned.error}`);

  const queueFile = assistant.queuePathOf(assistant.assistantRecord("assistant-1"));
  const rowOf = () => readQueueFile(queueFile).tasks.find((t) => t.id === id) || null;

  // 5. Sweep until the row parks or finishes. Between sweeps the harness WAITS for the stage's process to exit and
  //    only then flips the job to `done` — so every pass over a live run sees it live and moves nothing.
  const steps = [];
  const settle = async () => {
    for (let i = 0; i < 12; i += 1) await sleep(5);
  };
  for (let step = 1; step <= 60; step += 1) {
    const before = rowOf();
    const beforeThread = before ? currentThread(before) : null;
    assistant.sweepQueues();
    await settle();
    const row = rowOf();
    const thread = row ? currentThread(row) : null;
    const live = Boolean(thread && state.live.get(thread));
    steps.push({
      step,
      observed: row ? row.state : null,
      stage: stageOfRun(row),
      visit: visitOfRow(row),
      crossings: row && row.pipelineRun ? row.pipelineRun.crossings || {} : null,
      thread,
      started: thread && thread !== beforeThread ? thread : null,
      live,
      reason: row ? row.reason || null : null,
    });
    if (row && (row.state === "parked" || row.state === "done")) break;
    // A live run is the panel doing the right thing by doing nothing: wait for the process, then take the next pass.
    if (live) await state.exits.get(thread);
  }

  const row = rowOf();
  const run = row && row.pipelineRun ? row.pipelineRun : null;
  const stages = run && Array.isArray(run.stageRuns) ? run.stageRuns : [];
  const ledger = {
    round,
    fixture: { repo: repo.replace(/\\/g, "/"), head, studio_source: STUDIO_SRC },
    pipeline: { id: PIPELINE_ID, file: bundleFile.replace(/\\/g, "/"), sha256: sha256(readFileSync(bundleFile)), document: BUNDLE_DOC.pipelines[0] },
    row: {
      id,
      title: row.title,
      state: row.state,
      reason: row.reason || null,
      stage: run ? run.stage : null,
      via: run ? run.via || null : null,
      visits: run ? run.visits : null,
      crossings: run ? run.crossings || {} : null,
      tree: run ? run.tree || null : null,
      waitingFor: run ? run.waitingFor || null : null,
    },
    cuts: state.cuts,
    prompts: state.prompts,
    stageRuns: stages.map((s) => ({
      id: s.id,
      stage: s.stage,
      visit: s.visit,
      enteredAt: s.at || null,
      thread: s.thread || null,
      job: s.job || null,
      status: s.status || null,
      settledAt: s.settledAt || null,
      tree: s.tree || null,
      artifact: s.artifact || null,
      decision: s.decision ? { code: s.decision.code || null, trigger: s.decision.trigger, by: s.decision.by, reason: s.decision.reason } : null,
    })),
    workerRuns: state.runs,
    decisions: stages.filter((s) => s.decision).map((s) => ({ stage: s.stage, visit: s.visit, code: s.decision.code || null, trigger: s.decision.trigger, by: s.decision.by, reason: s.decision.reason })),
    journal: assistant.journal.filter((line) => ["queue", "pipeline", "pipeline-failed"].includes(line.kind)).map((line) => ({ at: line.at, kind: line.kind, thread: line.thread || null, text: line.text })),
    steps,
    finishedAt: iso(Date.now()),
  };
  return ledger;
}

const stageOfRun = (row) => (row && row.pipelineRun ? row.pipelineRun.stage || null : null);
const visitOfRow = (row) => {
  const run = row && row.pipelineRun;
  if (!run || !run.stage || !run.visits) return null;
  return run.visits[run.stage] ?? null;
};

// ---- the comparison ---------------------------------------------------------------------------------------------
// Two independent rounds are only evidence if they did the SAME thing. The routing (stage ids, visits, crossings) and
// the artifact bytes must match; ids, threads, timestamps and tree paths must not, and saying so is part of the claim.
function compare(a, b) {
  const seq = (l) => l.stageRuns.map((s) => s.id);
  const hashes = (l) => Object.fromEntries(l.stageRuns.map((s) => [s.id, s.artifact ? s.artifact.sha256 : null]));
  const ha = hashes(a);
  const hb = hashes(b);
  const sameHashes = Object.keys(ha).every((k) => ha[k] && ha[k] === hb[k]);
  return {
    same_stage_sequence: JSON.stringify(seq(a)) === JSON.stringify(seq(b)),
    sequence: seq(a),
    same_crossings: JSON.stringify(a.row.crossings) === JSON.stringify(b.row.crossings),
    crossings: a.row.crossings,
    same_end_state: a.row.state === b.row.state && a.row.reason === b.row.reason,
    end_state: a.row.state,
    same_artifact_bytes: sameHashes,
    artifact_sha256: ha,
    one_tree_each: a.cuts.length === 1 && b.cuts.length === 1,
    trees: [a.row.tree && a.row.tree.path, b.row.tree && b.row.tree.path],
    same_tree_all_stages: a.stageRuns.every((s) => s.tree && s.tree.path === (a.row.tree && a.row.tree.path)) && b.stageRuns.every((s) => s.tree && s.tree.path === (b.row.tree && b.row.tree.path)),
    different_runs: a.workerRuns.every((r, i) => b.workerRuns[i] && r.thread !== b.workerRuns[i].thread),
  };
}

// ---- main ------------------------------------------------------------------------------------------------------
async function main() {
  if (!existsSync(path.join(STUDIO_SRC, "index.html"))) {
    console.error(`pipeline-exec-round: no studio at ${STUDIO_SRC} — pass --studio <dir>`);
    process.exit(2);
  }
  if (ROUND_ARG === "BOTH") {
    // Two processes, one after the other: the second round shares nothing with the first but the document.
    for (const round of ["A", "B"]) {
      execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--round", round, "--work", WORK, "--out", OUT, "--studio", STUDIO_SRC], { stdio: "inherit", cwd: REPO });
    }
    const read = (r) => JSON.parse(readFileSync(path.join(OUT, "rounds", `round-${r}.json`), "utf8"));
    const a = read("A");
    const b = read("B");
    const compared = compare(a, b);
    mkdirSync(OUT, { recursive: true });
    writeFileSync(path.join(OUT, "compare.json"), `${JSON.stringify(compared, null, 2)}\n`);
    console.log(JSON.stringify({ compared }));
    return;
  }

  const ledger = await runRound(ROUND_ARG);
  mkdirSync(path.join(OUT, "rounds"), { recursive: true });
  const kept = path.join(WORK, `round-${ROUND_ARG}`, "artifacts");
  if (existsSync(kept)) cpSync(kept, path.join(OUT, "rounds", `round-${ROUND_ARG}`), { recursive: true });
  // The ledger is written with NO folder from this machine in it (tools/absolute-paths.mjs): the work root, the
  // fixture and the studio checkout become <work>, <repo> and <studio>. A reader can still see which tree each stage
  // ran in; what they cannot see is a path that exists only on the machine that ran the round.
  const portable = (value) => {
    let text = JSON.stringify(value, null, 2);
    for (const [from, to] of [
      [path.join(WORK, `round-${ROUND_ARG}`, "repo"), "<repo>"],
      [WORK, "<work>"],
      [STUDIO_SRC, "<studio>"],
    ]) {
      // Three forms, because the text is already serialized: forward slashes, one backslash, and the doubled
      // backslash JSON escapes it to. A form left out is a drive letter left in the committed ledger.
      const B = String.fromCharCode(92);
      const forms = [from.split(B).join(B + B), from.split(B).join("/"), from.split("/").join(B)];
      for (const form of forms) text = text.split(form).join(to);
    }
    return text;
  };
  writeFileSync(path.join(OUT, "rounds", `round-${ROUND_ARG}.json`), `${portable(ledger)}\n`);
  // The screenshots each claim rests on: the probe's shot, the fix's, the verify's — one per visit, straight out of
  // the tree the stage ran in, copied under the round's own directory.
  const shotsDir = path.join(OUT, "shots", `round-${ROUND_ARG}`);
  mkdirSync(shotsDir, { recursive: true });
  const tree = ledger.row.tree && ledger.row.tree.path;
  if (tree) {
    const shotName = { S1: "probe", S2: "fix", S3: "verify" };
    for (const entry of ledger.stageRuns) {
      const shot = path.join(tree, "out", `${shotName[entry.stage] || "probe"}-visit${entry.visit}.png`);
      if (existsSync(shot)) cpSync(shot, path.join(shotsDir, `${entry.id.replace(/[\/#]/g, "-")}.png`));
    }
  }
  console.log(JSON.stringify({ round: ROUND_ARG, state: ledger.row.state, stage: ledger.row.stage, crossings: ledger.row.crossings, runs: ledger.stageRuns.length, cuts: ledger.cuts.length }));
  const expected = ledger.row.state === "parked";
  if (!expected) {
    console.error(`pipeline-exec-round: round ${ROUND_ARG} ended ${ledger.row.state}, not parked — the cap was not reached`);
    process.exit(1);
  }
}

await main().catch((err) => {
  console.error(`pipeline-exec-round: ${err && err.stack ? err.stack : err}`);
  process.exit(2);
});
