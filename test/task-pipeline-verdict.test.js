// Two driver defects a three-stage round found, replayed as the round ran them: `probe → fix → verify`, one capped
// back edge from verify to probe, and the verify stage's verdict written where the pipeline document routes it.
//
// The round (docs/reviews/pipeline-execution-round.html) drove that shape end to end and found two things:
//
//   #1  visit 1's INPUTS block announced the loop into the FIRST stage (`handed on verify · out/verify.json ·
//       not in the tree`) for a stage that had never run — the block derived "the edge the row arrived by" from the
//       graph (the last handoff whose `to` is this stage) instead of from the record, so it named a hand-off the
//       sender never produced. The block now names an arrival only when the RECORD carries one (`pipelineRun.via`);
//       a first visit crossed nothing and says nothing.
//
//   #2  the loop had no exit but its cap: S3's only edge out was H-3, so a probe that found nothing to fix still
//       crossed it, and the row parked on `pipeline-cap` after re-probing a studio that was already at the bar. A
//       gate's decision record can now be ROUTED by the document (`decision.routes`: outcome → handoff id, or null
//       for "the pipeline ends here"), and the verdict is read BEFORE the cap — so a converged loop ends at its
//       verdict while a loop that keeps failing still spends its cap and parks on it.
//
// The sweep-level tests drive the panel's own clock (`Assistant.sweepQueues`) with a spawner that does each stage's
// work in its tree, so the shape under test is the one the round drove, not a hand-built record. The last three tests
// pin the driver's own answers: the routed edge wins over the kind order, a verdict the document cannot route is a
// park rather than a guess, and the seed's own review gate routes accept and reject.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Assistant } from "../lib/assistant.js";
import { readQueueFile } from "../lib/assistant/queue.js";
import { parseBundle } from "../lib/pipeline-bundle.js";
import { DRIVE_FAULTS, nextStageOf, routeFor, verdictOf } from "../lib/task-pipeline-drive.js";

const T0 = Date.parse("2026-11-05T09:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const PROJECT = { name: "agent-worktree-gui", path: "/projects/agent-worktree-gui" };
const THREAD = "wtgui-probe-the-pipeline-studi-4ab3c1";

const stage = (id, title, artifact) => ({
  id,
  title,
  prompt: `Do the ${title} work.`,
  artifact: { id: artifact, path: `out/${artifact}.json`, schema: "out/1", writer: `${artifact}-seat` },
});

// The round's pipeline document, as a bundle: three stages, two sequence edges, one capped back edge, and the gate
// that turns the verify stage's verdict into a route (fail loops, pass ends).
const probeFixLoop = () => ({
  bundleVersion: 1,
  name: "probe-fix-loop",
  pipelines: [
    {
      id: "probe-fix-loop",
      title: "Probe, fix, verify — a capped repair loop",
      stages: [stage("S1", "Probe the studio", "probe"), stage("S2", "Fix what the probe found", "fix"), stage("S3", "Verify the fix", "verify")],
      handoffs: [
        { id: "H-1", from: "S1", to: "S2", artifact: "probe", kind: "sequence" },
        { id: "H-2", from: "S2", to: "S3", artifact: "fix", kind: "sequence" },
        { id: "H-3", from: "S3", to: "S1", artifact: "verify", kind: "loop", cap: "2 rounds" },
      ],
      gates: [
        {
          id: "G-3",
          name: "Converged?",
          after: "S3",
          artifact: "verify",
          decider: "verify-seat",
          decision: {
            id: "verify-verdict",
            path: "out/verdict.json",
            schema: "verdict/1",
            writer: "verify-seat",
            outcomes: ["fail", "pass"],
            routes: { fail: "H-3", pass: null },
          },
        },
      ],
    },
  ],
});

const parsed = parseBundle(probeFixLoop(), { file: "probe-fix-loop.json" });
assert.equal(parsed.ok, true, parsed.reason || "the round's document must parse");
const BUNDLE = parsed.bundle;
const PIPELINE = BUNDLE.pipelines[0];

// The panel's clock, as the round used it: a real queue file, a real tree cut by `makeWorktree`, and a spawner that
// does the stage's work in that tree. `verdicts` is what each S3 visit writes as its verdict.
function harness(t, { verdicts = ["fail", "pass"] } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wag-verdict-"));
  const bundleFile = path.join(dir, "pipeline-bundle.json");
  writeFileSync(bundleFile, JSON.stringify(probeFixLoop()));
  const state = { board: [], started: [], rows: [], cuts: [], verdicts, tree: path.join(dir, "trees", "probe-the-pipeline-studi-0cd7da") };
  const jobs = {
    list: () => state.board,
    firstOfThread: (thread) => state.board.find((job) => job.thread === thread) || null,
    busyFor: () => ({ held: false, where: null, by: [] }),
    modelFor: () => null,
    create: async (opts) => ({ id: "job-created", ...opts }),
    answerQuestion: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    get: () => null,
    clarify: { state: () => null },
    makeWorktree: async (repoDir, prompt) => {
      state.cuts.push({ repoDir, prompt });
      mkdirSync(state.tree, { recursive: true });
      return { path: state.tree, branch: "wtgui/probe-the-pipeline-studi-0cd7da", startSha: "9d98d4a" };
    },
  };
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile: path.join(dir, "assistant.json"), defaultCwd: dir, pipelineBundleFile: bundleFile },
    jobs,
    getProjects: () => [PROJECT],
    getRows: () => state.rows,
    // Each stage writes the one artifact it declares; the verify stage also writes its verdict, which is the file the
    // gate declares and the wording the document routes. A worker is handed its prompt and nothing else, so the stage
    // and the visit come out of the provenance line the driver put there — exactly as the round's seat read them.
    spawner: async (spec) => {
      const marks = spec.prompt.match(/\(([\w.-]+)\/([\w.-]+)\)(?:, visit (\d+))?/) || [];
      const stageId = marks[2];
      const visit = Number(marks[3] || 1);
      const artifact = stageId === "S1" ? "probe" : stageId === "S2" ? "fix" : "verify";
      mkdirSync(path.join(spec.target, "out"), { recursive: true });
      writeFileSync(path.join(spec.target, "out", `${artifact}.json`), JSON.stringify({ stage: stageId, visit }));
      if (stageId === "S3") {
        const outcome = state.verdicts[Math.min(visit - 1, state.verdicts.length - 1)] || "fail";
        writeFileSync(path.join(spec.target, "out", "verdict.json"), JSON.stringify({ outcome }));
      }
      const job = { id: `job-${state.started.length + 1}`, thread: THREAD, cwd: spec.target, worktreePath: spec.target, status: "running", startedAt: iso(T0) };
      state.started.push({ ...spec, stage: stageId, visit });
      state.board.push(job);
      return job;
    },
    now: () => T0,
  });
  assistant.settings.spawn = "auto";
  t.after(() => {
    clearTimeout(assistant.persistTimer);
    if (assistant.timer) clearInterval(assistant.timer);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const rowOf = (id) => readQueueFile(assistant.queuePathOf(assistant.assistantRecord("assistant-1"))).tasks.find((x) => x.id === id) || null;
  const nap = () => new Promise((resolve) => setTimeout(resolve, 5));
  // A start is fire-and-forget in the sweep, so a test that marks the live job done has to wait for the row to read
  // "running" in the new stage before it can mark that run's job done. Waiting on the ROW (not a fixed sleep) is what
  // makes each pass act on the stage the previous one started.
  const waitForRow = async (id, { moved = false, before = 0 } = {}) => {
    for (let i = 0; i < 200; i += 1) {
      const row = rowOf(id);
      if (row.state === "parked" || row.state === "done") return row;
      // "Linked" is the ledger's own fact: the stage run the start created has learned its thread.
      const entry = row.pipelineRun && Array.isArray(row.pipelineRun.stageRuns) ? row.pipelineRun.stageRuns.at(-1) : null;
      const linked = Boolean(entry && entry.thread);
      if (linked && row.state === "running" && (!moved || state.board.length > before)) return row;
      await nap();
    }
    return rowOf(id);
  };
  // The cut, then the first start — the same two passes the round's first sweep and its next one made.
  const begin = async () => {
    assistant.queueMutate("assistant-1", "add", { title: "probe the pipeline studio and fix what the probe finds", project: "agent-worktree-gui" });
    const row = readQueueFile(assistant.queuePathOf(assistant.assistantRecord("assistant-1"))).tasks.at(-1);
    assistant.queueMutate("assistant-1", "pipeline", { id: row.id, pipeline: "probe-fix-loop", stage: "S1" });
    assistant.sweepQueues();
    await nap();
    assistant.sweepQueues();
    await waitForRow(row.id, { moved: true });
    return row.id;
  };
  // One stage run: mark the live job done, sweep, and wait for the panel to finish acting on it.
  const runStage = async (id) => {
    const before = state.board.length;
    const live = state.board[state.board.length - 1];
    if (live) live.status = "done";
    assistant.sweepQueues();
    await waitForRow(id, { moved: true, before });
    await nap();
  };
  return { assistant, state, rowOf, begin, runStage };
}

test("a converged loop ends at its verdict — the cap is never charged for the round that was not needed", async (t) => {
  const { state, rowOf, begin, runStage } = harness(t, { verdicts: ["fail", "pass"] });
  const id = await begin();

  // Visit 1's block: nothing has been handed on. No `handed on` line, no verify artifact, no "not in the tree".
  const first = state.started[0];
  assert.equal(first.stage, "S1");
  assert.match(first.prompt, /\nINPUTS\n/, "the block is still there for the tree facts");
  assert.doesNotMatch(first.prompt, /handed on/, "a first visit has crossed no edge, so it is handed nothing");
  assert.doesNotMatch(first.prompt, /out\/verify\.json/, "the loop's artifact is not named before the loop has been crossed");
  assert.doesNotMatch(first.prompt, /not in the tree|nothing written yet/);
  assert.match(first.prompt, /tree {8}.*probe-the-pipeline-studi-0cd7da/);

  await runStage(id); // S1 settles → S2 starts
  const second = state.started[1];
  assert.equal(second.stage, "S2");
  const handed = second.prompt.match(/handed on[^\n]*/)[0];
  assert.match(handed, /probe/, "the block names the artifact the record says this stage arrived by");
  assert.match(handed, /out\/probe\.json/);

  await runStage(id); // S2 settles → S3 visit 1 starts
  assert.equal(state.started[2].stage, "S3");
  await runStage(id); // S3 visit 1 settles: verdict "fail" routes H-3, the first crossing
  let row = rowOf(id);
  assert.equal(row.pipelineRun.stage, "S1");
  assert.equal(row.pipelineRun.visits.S1, 2, "the loop re-entered the first stage");
  assert.equal(row.pipelineRun.crossings["H-3"], 1, "the failed round spent one crossing");

  // Visit 2's block names the earlier visit's artifact — that is the loop-back input, and it IS there.
  await runStage(id); // S1 visit 2 → S2 visit 2
  await runStage(id); // S2 visit 2 → S3 visit 2
  const verifyStart = state.started.at(-1);
  assert.equal(verifyStart.stage, "S3");
  assert.equal(verifyStart.visit, 2);
  assert.match(verifyStart.prompt, /earlier {5}verify/, "the loop back names the visit that produced the artifact it reads");
  assert.match(verifyStart.prompt, /this stage, visit 1/);

  await runStage(id); // S3 visit 2 settles: verdict "pass" routes nowhere
  row = rowOf(id);
  assert.equal(row.state, "running", "the pipeline is over; the settle, not the driver, finishes the row");
  assert.equal(row.hold, null, "no cap park: the verdict ended the loop before it was charged");
  assert.equal(row.pipelineRun.stage, "S3");
  assert.equal(row.pipelineRun.crossings["H-3"], 1, "the converged round spent no second crossing");
  const last = row.pipelineRun.stageRuns.at(-1);
  assert.equal(last.stage, "S3");
  assert.equal(last.decision.trigger, "verdict");
  assert.equal(last.decision.code, null);
  assert.equal(last.decision.fact.kind, "verdict");
  assert.equal(last.decision.fact.outcome, "pass");
  assert.equal(last.decision.fact.ended, true);
  assert.equal(last.decision.fact.edge, "H-3", "the sentence names the loop the verdict ended");
  assert.match(last.decision.reason, /"pass"/);
  assert.match(last.decision.reason, /pipeline is over/);
  assert.equal(row.pipelineRun.waitingFor ?? null, null, "a converged row is not waiting on a decision");

  // And the settle finishes it on the rule it has always had: the tree's PR reads MERGED.
  state.rows.push({ path: state.tree, verdict: "MERGED" });
  await runStage(id);
  row = rowOf(id);
  assert.equal(row.state, "done");
  assert.match(row.reason, /PR reads MERGED/);
  assert.equal(state.started.length, 6, "three stages, twice — and no third round for a converged pipeline");
});

test("a loop that has not converged still spends its cap and parks on it", async (t) => {
  const { state, rowOf, begin, runStage } = harness(t, { verdicts: ["fail", "fail", "fail"] });
  const id = await begin();

  await runStage(id); // S1
  await runStage(id); // S2
  await runStage(id); // S3 #1 → H-3, crossing 1
  await runStage(id); // S1 #2
  await runStage(id); // S2 #2
  await runStage(id); // S3 #2 → H-3, crossing 2
  await runStage(id); // S1 #3
  await runStage(id); // S2 #3
  await runStage(id); // S3 #3 settles: the cap refuses the third crossing

  const row = rowOf(id);
  assert.equal(row.state, "parked");
  assert.equal(row.hold.kind, "manual", "a cap is a decision; nothing the panel can test releases it");
  assert.equal(row.pipelineRun.stage, "S3");
  assert.equal(row.pipelineRun.crossings["H-3"], 2, "two crossings were taken; the third was refused");
  assert.equal(row.pipelineRun.waitingFor.kind, "cap");
  assert.equal(row.pipelineRun.waitingFor.edge, "H-3");
  assert.equal(row.pipelineRun.waitingFor.used, 2);
  assert.equal(row.pipelineRun.waitingFor.limit, 2);
  const last = row.pipelineRun.stageRuns.at(-1);
  assert.equal(last.decision.code, DRIVE_FAULTS.CAP);
  assert.equal(last.decision.trigger, "cap");
  assert.match(last.decision.reason, /at its cap of 2 rounds/);
  assert.equal(state.started.length, 9, "the round's nine stage runs, exactly as the review recorded them");
});

test("the routed edge wins over the kind order: a verdict can send a stage down its loop, or end it", (t) => {
  const bundle = parseBundle(
    {
      bundleVersion: 1,
      name: "author-review-revise",
      pipelines: [
        {
          id: "author-review-revise",
          title: "Author, review, revise",
          stages: [stage("author", "Author", "manuscript"), stage("review", "Review", "review-notes"), stage("revise", "Revise", "revised")],
          handoffs: [
            { id: "H-01", from: "author", to: "review", artifact: "manuscript", kind: "sequence" },
            { id: "H-02", from: "review", to: "author", artifact: "review-notes", kind: "loop", cap: "2 rejects" },
            { id: "H-03", from: "review", to: "revise", artifact: "review-notes", kind: "sequence" },
          ],
          gates: [
            {
              id: "G1",
              name: "Accept or reject",
              after: "review",
              artifact: "review-notes",
              decision: {
                id: "review-verdict",
                path: "ledger/verdict.json",
                schema: "verdict/1",
                writer: "reviewer",
                outcomes: ["accept", "reject"],
                routes: { accept: "H-03", reject: "H-02" },
              },
            },
          ],
        },
      ],
    },
    { file: "author-review-revise.json" },
  );
  assert.equal(bundle.ok, true, bundle.reason || "the document must parse");
  const pipeline = bundle.bundle.pipelines[0];
  const dir = mkdtempSync(path.join(os.tmpdir(), "wag-route-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "ledger"), { recursive: true });
  const run = { pipeline: "author-review-revise", stage: "review", enteredAt: T0, visits: { review: 1 }, crossings: {} };

  // A rejection takes the LOOP even though the kind order would take the sequence: the verdict is the document's
  // route, not the drawing's default.
  writeFileSync(path.join(dir, "ledger", "verdict.json"), JSON.stringify({ outcome: "reject" }));
  const rejected = nextStageOf(pipeline, run, { worktree: dir });
  assert.equal(rejected.ok, true, rejected.reason || "");
  assert.equal(rejected.stage.id, "author");
  assert.equal(rejected.handoff.id, "H-02");
  assert.equal(rejected.verdict.ended, false);
  assert.equal(rejected.verdict.outcome, "reject");

  // An acceptance takes the sequence edge, which happens to be the kind order's answer too.
  writeFileSync(path.join(dir, "ledger", "verdict.json"), JSON.stringify({ outcome: "accept" }));
  const accepted = nextStageOf(pipeline, run, { worktree: dir });
  assert.equal(accepted.ok, true, accepted.reason || "");
  assert.equal(accepted.stage.id, "revise");
  assert.equal(accepted.handoff.id, "H-03");
});

test("a verdict the document cannot route parks pipeline-verdict instead of guessing an edge", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wag-verdict-bad-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "out"), { recursive: true });
  const run = { pipeline: "probe-fix-loop", stage: "S3", enteredAt: T0, visits: { S3: 1 }, crossings: {} };
  const gate = PIPELINE.gates[0];

  // A record with no outcome at all: there is no word to route.
  writeFileSync(path.join(dir, "out", "verdict.json"), JSON.stringify({ fixed: ["L4", "L5"] }));
  assert.equal(verdictOf(gate, { worktree: dir }).outcome, null);
  let step = nextStageOf(PIPELINE, run, { worktree: dir });
  assert.equal(step.ok, false);
  assert.equal(step.code, DRIVE_FAULTS.VERDICT);
  assert.match(step.reason, /names no outcome/);

  // A word the gate does not declare: the panel refuses rather than ending a loop on a verdict nobody wrote.
  writeFileSync(path.join(dir, "out", "verdict.json"), JSON.stringify({ outcome: "maybe" }));
  step = nextStageOf(PIPELINE, run, { worktree: dir });
  assert.equal(step.ok, false);
  assert.equal(step.code, DRIVE_FAULTS.VERDICT);

  // A record that is not JSON is the same refusal, and says so.
  writeFileSync(path.join(dir, "out", "verdict.json"), "not json");
  step = nextStageOf(PIPELINE, run, { worktree: dir });
  assert.equal(step.code, DRIVE_FAULTS.VERDICT);
  assert.match(step.reason, /not JSON/);

  assert.deepEqual(routeFor(gate.decision, "PASS"), { routed: true, outcome: "pass", handoff: null }, "a route is matched by word, not by case");
});

test("the seed's review gate routes accept and reject, and its loop charges only the rejection", () => {
  const seed = parseBundle(JSON.parse(readFileSync(new URL("../pipeline-bundle.seed.json", import.meta.url), "utf8")), { file: "seed" });
  assert.equal(seed.ok, true, seed.reason || "the shipped seed must load");
  const author = seed.bundle.pipelines.find((pipeline) => pipeline.id === "author-review-revise");
  const gate = author.gates.find((entry) => entry.id === "G1");
  assert.deepEqual(gate.decision.routes, { accept: "H-03", reject: "H-02" }, "the shipped review gate routes both outcomes");
});
