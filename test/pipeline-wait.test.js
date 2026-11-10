// The stage timer (docs/pipelines.md §6): a stage whose exit is the REVIEWER's answer ends its turn and registers a
// timed re-check on the tree, which wakes the same thread — and either advances the stage or schedules the next check.
//
// What this file drives, and why each part is here rather than asserted off the source:
//
//   1. the model — `reviewWaitFor`, `readReviewExit`, `settleWait`, `claimWait`, `renderPrompt` — as pure functions of
//      `now` and one host observation, so an hour of waiting is a number and not an hour;
//   2. the registration — a tree on a stage that exits on `pr-comments` gets a `pipelineWait` in the DURABLE book (with
//      the thread and the branch the wake will need), and a second settle in the same stage does not restart its clock;
//   3. the wake — one due record, one host read, one short turn on the SAME thread carrying the NEXT stage's prompt,
//      with the stage advanced and the wait gone. No timer, no sleep, no run held open: the whole hour is `now + 1h`;
//   4. the next check — nothing arrived is a reschedule (1h → 2h → 4h), not a wake, and the record is not due again
//      until its own interval has passed;
//   5. the failures that must not wake or must not advance twice — a second claim, a host read that throws, a PR that
//      was merged or declined, a stage whose prompt cannot be rendered;
//   6. the two host payloads, normalised once (lib/pipelines.js `observeGithubPr` / `observeBitbucketPr`) so the
//      decision above is exercised without a network.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Jobs } from "../lib/jobs.js";
import { nextStageOf } from "../lib/task-pipeline-drive.js";
import {
  QUIET_WAKE_AFTER_MS,
  WAIT_CLAIM_GRACE_MS,
  WAIT_FIRST_MS,
  WAIT_MAX_MS,
  HOLD_OWNER_MS,
  advanceStage,
  claimWait,
  isRunWait,
  observeBitbucketPr,
  observeGithubPr,
  readReviewExit,
  renderPrompt,
  reviewWaitFor,
  reviewExitOf,
  reviewGateFor,
  settleWait,
  stageRunWaitFor,
  waitDueAt,
  waitIsDue,
  waitKind,
  PipelineRecords,
} from "../lib/pipelines.js";
import { parseBundle, pipelineById } from "../lib/pipeline-bundle.js";

// Jobs reads this box's Hermes session store for counters; a suite about waits must not read the developer's own.
process.env.HERMES_HOME = mkdtempSync(path.join(os.tmpdir(), "wtgui-wait-home-"));
process.env.API_SERVER_KEY = "";

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-11-03T10:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const TREE = "c:/repo/.worktrees/build-the-stage-timer-0b37d7";
const THREAD = "wtgui/build-the-stage-timer-0b37d7";
const BRANCH = "wtgui/build-the-stage-timer-0b37d7";
// The review loop ships as a PDL document now (pipeline-bundle.seed.json), not as a ladder definition.
const BUNDLE = fileURLToPath(new URL("../pipeline-bundle.seed.json", import.meta.url));

// The review loop this panel ships (pipelines.seed.json's `sefl-review-loop`), cut down to the stages a wait touches:
// a `wait` that exits on `pr-comments`, the `address` its wake starts, and the `approve`/`merge` after it.
const LOOP = {
  id: "sefl-review-loop",
  kind: "turnover",
  title: "SEFL review loop",
  stages: [
    { id: "pr", title: "Open the pull request", prompt: "open the PR for {{branch}}", exit: { check: "pr-open" } },
    { id: "wait", title: "Wait for the reviewer", prompt: "read once and end the turn", exit: { check: "pr-comments" } },
    { id: "address", title: "Answer the review", prompt: "answer the new comments on {{branch}} and push", exit: { check: "pushed" } },
    { id: "approve", title: "Wait for the approval at the head", prompt: "wait for the approval at {{sha}}", exit: { check: "pr-approved" } },
    { id: "merge", title: "Merge", prompt: "merge {{branch}}", exit: { check: "pr-merged" } },
  ],
  order: ["pr", "wait", "address", "approve", "merge"],
  next: null,
};
const CATALOGUE = { get: (id) => (String(id) === LOOP.id ? LOOP : null) };

// The SAME loop with the graph the shipped document draws (H-04 wait → address as a capped loop, H-05 back to wait,
// H-06 on to approve), plus the gate that names the comment check. The ladder fixture above has no handoffs, which is
// why the sweep's reading-order fallback still covers it; these tests are what hold the timer to the SAME rail the
// driver walks when a definition DOES draw one.
const GRAPHED = {
  ...LOOP,
  id: "sefl-review-loop-graphed",
  gates: [{ id: "G4", after: "wait", verifiedBy: "pr-comments" }],
  handoffs: [
    { id: "H-03", from: "pr", to: "wait", kind: "sequence" },
    { id: "H-04", from: "wait", to: "address", kind: "loop", cap: "3 rounds" },
    { id: "H-05", from: "address", to: "wait", kind: "sequence" },
    { id: "H-06", from: "wait", to: "approve", kind: "sequence" },
    { id: "H-07", from: "approve", to: "merge", kind: "sequence" },
  ],
};
const GRAPHED_CATALOGUE = { get: (id) => (String(id) === GRAPHED.id ? GRAPHED : null) };

function waitRecord(over = {}) {
  return {
    stage: "wait",
    check: "pr-comments",
    who: [],
    thread: THREAD,
    branch: BRANCH,
    since: iso(T0),
    at: iso(T0),
    every: WAIT_FIRST_MS,
    attempts: 0,
    lastSeen: iso(T0 - HOUR),
    quietWakeSent: false,
    claimedAt: null,
    ...over,
  };
}

// A tree in the durable book, on the `wait` stage of the review loop, with the record the panel would have written.
function board(t, { stage = "wait", wait = waitRecord(), recordOver = {}, onStageSettled = null, catalogue = CATALOGUE, config = {} } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-wait-"));
  const records = new PipelineRecords({ file: path.join(dir, "pipeline-records.json") });
  const jobs = new Jobs({ config: { jobsFile: path.join(dir, "jobs.json"), defaultCwd: dir, ...config }, onLog: () => {}, onStageSettled });
  jobs.pipelineRecords = records;
  jobs.pipelines = catalogue;
  const record = {
    id: LOOP.id,
    stage,
    since: iso(T0),
    history: [{ from: "turnover", to: "turnover", stage, at: iso(T0), by: "stage", why: "test" }],
    ...(wait ? { pipelineWait: wait } : {}),
    ...recordOver,
  };
  assert.ok(records.set(TREE, record), "the fixture's own record must be written");
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return { dir, records, jobs };
}

// ---- §6.1 the model ----------------------------------------------------------------------------------------------
test("reviewWaitFor: only the reviewer's three exits seed a wait, and reviewers-exact carries its who", () => {
  // The timer reads a LADDER definition's `stage.exit.check`. The seed ships no ladder definition any more — the review
  // loop is a PDL document, and a PDL stage carries an artifact, not an exit — so the shape is the fixture's, and the
  // PDL document is checked below for the stages the conversion had to keep.
  const loop = LOOP;

  const wait = reviewWaitFor(loop.stages.find((s) => s.id === "wait"), { at: iso(T0), lastSeen: iso(T0 - HOUR), thread: THREAD, branch: BRANCH });
  assert.equal(wait.check, "pr-comments", "the shipped wait stage is the reviewer's answer");
  assert.equal(wait.stage, "wait");
  assert.equal(wait.every, WAIT_FIRST_MS, "the first check is an hour out");
  assert.equal(wait.attempts, 0);
  assert.equal(wait.thread, THREAD, "the wake is a turn on this thread, so the thread is stored WITH the wait");
  assert.equal(wait.branch, BRANCH, "and the branch, because a day from now there is no card left to ask");
  assert.equal(wait.lastSeen, iso(T0 - HOUR));

  assert.equal(reviewWaitFor(loop.stages.find((s) => s.id === "branch")), null, "a branch-name exit is the worker's own progress");
  assert.equal(reviewWaitFor(loop.stages.find((s) => s.id === "merge")), null, "pr-merged is not a reviewer's answer");
  assert.equal(reviewWaitFor({ id: "x", exit: { check: "pr-approved" } }).check, "pr-approved");
  const exact = reviewWaitFor({ id: "r", exit: { check: "reviewers-exact", who: ["code_review_java"] } });
  assert.deepEqual(exact.who, ["code_review_java"], "reviewers-exact keeps the set it must match");
  assert.equal(reviewWaitFor(null), null);

  // The conversion kept the stages the timer is about: the PDL document carries the same seven ids, in the same order,
  // and the wait stage's instruction is the sentence the ladder shipped. What it does NOT carry is `exit` — a PDL stage
  // names the artifact it writes, not the check that ends it - so the timer reads the GATE after the stage instead
  // (`reviewGateFor`), and the same closed vocabulary comes back. One fact, two documents; see reviewWaitFor's comment.
  const pdl = JSON.parse(readFileSync(BUNDLE, "utf8")).pipelines.find((p) => p.id === "sefl-review-loop");
  assert.ok(pdl, "the review loop ships in the PDL bundle");
  assert.deepEqual(pdl.stages.map((s) => s.id), ["branch", "push", "pr", "wait", "address", "approve", "merge"]);
  assert.match(pdl.stages.find((s) => s.id === "wait").prompt, /END the turn/);
  assert.equal(pdl.stages.find((s) => s.id === "wait").exit, undefined, "a PDL stage carries no ladder exit");

  const waited = pdl.stages.find((s) => s.id === "wait");
  const gate = reviewGateFor(pdl, "wait");
  assert.equal(gate.id, "G4", "the gate after wait is what names the reviewer's check");
  assert.equal(reviewExitOf(waited, gate).check, "pr-comments", "the gate's verified_by is the SAME fact the ladder put on the exit");
  assert.equal(reviewExitOf(waited, null), null, "the stage alone names no review: a document read without its gates registers nothing");
  assert.equal(reviewGateFor(pdl, "address"), null, "G5 verifies `pushed`: the answer stage ends on the worker's own work");
  const seeded = reviewWaitFor(waited, { at: iso(T0), lastSeen: iso(T0 - HOUR), thread: THREAD, branch: BRANCH, pipeline: pdl.id, gate });
  assert.equal(seeded.check, "pr-comments");
  assert.equal(seeded.pipeline, pdl.id, "the wait names the document its stage belongs to, so a tree cut `local` can still be read");
  assert.equal(seeded.gate, "G4");
  // A gate the document ROUTES is its own two-outcome decision, not a wait: the same exclusion `reviewEdgeOutOf` makes.
  const routed = { ...pdl, gates: [{ ...gate, decision: { routes: { passed: "approve", failed: null } } }] };
  assert.equal(reviewExitOf(waited, reviewGateFor(routed, "wait")), null);
});

test("readReviewExit: an answer advances it; quiet, unreadable and an older approval do not; a merged PR closes it", () => {
  const wait = waitRecord();
  const exit = { check: "pr-comments" };
  const obs = (pr) => ({ ok: true, pr: { state: "OPEN", headRefOid: "a".repeat(40), reviewers: [], comments: [], approvals: [], ...pr } });

  // pr-comments: strictly newer than the wait's own lastSeen.
  const newer = readReviewExit(exit, obs({ comments: [{ at: iso(T0 - HOUR / 2) }] }), { lastSeen: wait.lastSeen });
  assert.equal(newer.advanced, true);
  assert.equal(newer.seen, iso(T0 - HOUR / 2), "the newest comment's stamp is what the next check compares against");
  assert.equal(readReviewExit(exit, obs({ comments: [{ at: iso(T0 - 2 * HOUR) }] }), { lastSeen: wait.lastSeen }).advanced, false, "an older comment is not new");
  assert.equal(readReviewExit(exit, obs({ comments: [{ at: iso(T0 - HOUR) }] }), { lastSeen: wait.lastSeen }).advanced, false, "the same instant is not newer");

  // Fail-closed: a host that could not be read does not exit the stage.
  const down = readReviewExit(exit, { ok: false, why: "HTTP 503 from the host" }, { lastSeen: wait.lastSeen });
  assert.equal(down.advanced, false);
  assert.equal(down.cannotTell, true);
  assert.match(down.why, /does not exit the stage/);
  assert.equal(readReviewExit(exit, obs({ comments: null }), { lastSeen: wait.lastSeen }).cannotTell, true, "no comments list is 'cannot tell', not 'nothing arrived'");
  assert.equal(readReviewExit(exit, obs({ comments: [{ at: iso(T0) }] }), { lastSeen: null }).cannotTell, true, "no lastSeen cannot be answered");

  // pr-approved: the approval must be AT the head. An approval at an older commit is the loop's whole reason.
  const approved = { check: "pr-approved" };
  const head = "b".repeat(40);
  assert.equal(readReviewExit(approved, obs({ headRefOid: head, approvals: [{ commit: head, by: "rev" }] })).advanced, true);
  assert.equal(readReviewExit(approved, obs({ headRefOid: head, approvals: [{ commit: "c".repeat(40), by: "rev" }] })).advanced, false, "an approval at an older commit is not an approval of the head");
  assert.equal(readReviewExit(approved, obs({ headRefOid: null, approvals: [] })).cannotTell, true, "no head, no answer");

  // reviewers-exact: the set, no more and no fewer.
  const exact = { check: "reviewers-exact", who: ["code_review_java"] };
  assert.equal(readReviewExit(exact, obs({ reviewers: ["code_review_java"] })).advanced, true);
  assert.equal(readReviewExit(exact, obs({ reviewers: ["code_review_java", "someone_else"] })).advanced, false, "a second reviewer fails the check");
  assert.equal(readReviewExit(exact, obs({ reviewers: [] })).advanced, false);

  // The PR ending is a close, not a wake and not an advance.
  const merged = readReviewExit(exit, obs({ state: "MERGED", comments: [{ at: iso(T0 - HOUR / 2) }] }), { lastSeen: wait.lastSeen });
  assert.deepEqual({ advanced: merged.advanced, closed: merged.closed }, { advanced: false, closed: "merged" });
  assert.equal(readReviewExit(exit, obs({ state: "DECLINED" })).closed, "declined");
  assert.equal(readReviewExit({ check: "pr-open" }, obs({})).cannotTell, true, "an exit that is not a review exit is refused by name");
});

test("settleWait: 1h → 2h → 4h, capped, with one status wake after six quiet hours and never a second", () => {
  let wait = waitRecord();
  const quietOutcome = { ok: true, advanced: false, closed: null, cannotTell: false, seen: iso(T0 - HOUR / 2), why: "nothing newer" };

  const first = settleWait(wait, { now: T0 + HOUR, outcome: quietOutcome });
  assert.equal(first.advance, false);
  assert.equal(first.wait.every, 2 * HOUR);
  assert.equal(first.wait.attempts, 1);
  assert.equal(first.wait.seen ?? first.wait.lastSeen, iso(T0 - HOUR / 2), "lastSeen follows the newest comment the read saw");
  assert.equal(first.wait.claimedAt, null, "a settled wait is claimable again");
  wait = first.wait;

  const second = settleWait(wait, { now: T0 + 3 * HOUR, outcome: quietOutcome });
  assert.equal(second.wait.every, 4 * HOUR, "2h → 4h");
  const third = settleWait(second.wait, { now: T0 + 7 * HOUR, outcome: quietOutcome });
  assert.equal(third.wait.every, WAIT_MAX_MS, "capped at four hours");
  assert.equal(third.quiet, true, "six quiet hours since the wait began is the one status wake");
  assert.equal(third.wait.quietWakeSent, true);
  const again = settleWait(third.wait, { now: T0 + 11 * HOUR, outcome: quietOutcome });
  assert.equal(again.quiet, false, "one status wake, not a heartbeat");

  const advanced = settleWait(wait, { now: T0 + 2 * HOUR, outcome: { ok: true, advanced: true, closed: null, seen: iso(T0), why: "a comment arrived" } });
  assert.deepEqual({ advance: advanced.advance, wait: advanced.wait }, { advance: true, wait: null });
  const closed = settleWait(wait, { now: T0 + 2 * HOUR, outcome: { ok: true, advanced: false, closed: "merged", why: "the pull request is MERGED" } });
  assert.deepEqual({ advance: closed.advance, wait: closed.wait }, { advance: false, wait: null });
  assert.equal(settleWait(null, { now: T0, outcome: quietOutcome }).ok, false);
});

test("claimWait: one claim per wake, and a claim nobody acted on expires", () => {
  const wait = waitRecord({ at: iso(T0), every: WAIT_FIRST_MS });
  assert.equal(waitIsDue(wait, { now: T0 + WAIT_FIRST_MS - 1 }), false, "not due before its own interval");
  assert.equal(waitIsDue(wait, { now: T0 + WAIT_FIRST_MS }), true, "due exactly one interval later");
  assert.equal(waitDueAt(wait), T0 + WAIT_FIRST_MS);

  const claimed = claimWait(wait, { now: T0 + HOUR });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.wait.claimedAt, iso(T0 + HOUR));
  const second = claimWait(claimed.wait, { now: T0 + HOUR + 60_000 });
  assert.equal(second.ok, false, "a second tick (or a second panel) cannot wake the same thread twice");
  assert.match(second.why, /cannot wake the same thread twice/);
  assert.equal(claimWait(claimed.wait, { now: T0 + HOUR + WAIT_CLAIM_GRACE_MS + 1000 }).ok, true, "a claim older than the grace is reclaimed: a crash between the claim and the run must not strand the tree");
});

test("renderPrompt: the closed holes are filled, and an empty or unknown one refuses to start the stage", () => {
  const ok = renderPrompt("answer the comments on {{branch}} for {{ project }}", { branch: BRANCH, project: "agent-worktree-gui" });
  assert.equal(ok.ok, true);
  assert.equal(ok.text, `answer the comments on ${BRANCH} for agent-worktree-gui`);
  const empty = renderPrompt("answer on {{branch}} for {{ticket}}", { branch: BRANCH });
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.missing, ["ticket"]);
  assert.match(empty.why, /resolved to nothing/);
  assert.equal(renderPrompt("{{nope}}", {}).ok, false, "an unknown hole is refused even in a hand-written file");
});

// ---- §6.2 the registration ---------------------------------------------------------------------------------------
test("a settle on a review-waiting stage writes the timed re-check onto the TREE, and does not restart its clock", (t) => {
  const { dir, records, jobs } = board(t, { wait: null });
  const card = { ownerPath: TREE, thread: THREAD, branch: BRANCH };

  const wait = jobs.registerPipelineWait(card, { now: T0 });
  assert.ok(wait, "the stage's exit is the reviewer's answer, so the panel waits");
  assert.equal(wait.check, "pr-comments");
  assert.equal(wait.at, iso(T0));
  assert.equal(wait.thread, THREAD);
  assert.equal(wait.branch, BRANCH);
  assert.equal(wait.lastSeen, iso(T0), "the stage began at T0, so events newer than its own entry are what it looks for");

  // Durable on the tree, not only in memory: this is the record a restart and a second panel read.
  const onDisk = JSON.parse(readFileSync(path.join(dir, "pipeline-records.json"), "utf8"));
  assert.equal(onDisk.trees[TREE].pipelineWait.check, "pr-comments");
  assert.equal(onDisk.trees[TREE].pipelineWait.thread, THREAD);
  assert.equal(onDisk.trees[TREE].stage, "wait", "registering a wait never moves the stage by itself");

  // A second turn in the same stage keeps the clock: restarting the hour on every turn is how a wait never fires.
  const again = jobs.registerPipelineWait(card, { now: T0 + 10 * 60_000 });
  assert.equal(again.at, iso(T0), "the clock is the stage's, not the turn's");

  // A stage that ends on its own work registers nothing at all.
  records.set(TREE, { id: LOOP.id, stage: "merge", since: iso(T0), history: [] });
  assert.equal(jobs.registerPipelineWait(card, { now: T0 }), null, "pr-merged is not a reviewer's answer");
  assert.equal(jobs.pipelineRecordFor(TREE).pipelineWait, undefined);

  // A card with no tree (the board's own assistant) is never a pipeline wait.
  assert.equal(jobs.registerPipelineWait({ thread: "assistant" }, { now: T0 }), null);
});

// ---- §6.3 the wake that advances a stage, with no sleep -----------------------------------------------------------
test("a due wake reads the PR once and ADVANCES the stage with the next stage's prompt on the SAME thread", async (t) => {
  const { records, jobs } = board(t);
  const woke = [];
  const reads = [];
  const now = T0 + WAIT_FIRST_MS; // one hour later — a number, never a sleep

  const out = await jobs.sweepPipelineWaits({
    now,
    readReview: (item) => {
      reads.push(item);
      return { ok: true, pr: { number: 312, state: "OPEN", headRefOid: "d".repeat(40), reviewers: [], comments: [{ at: iso(T0 + HOUR / 2) }], approvals: [] } };
    },
    wake: (turn) => {
      woke.push(turn);
      return { ok: true, job: { id: "wake1" } };
    },
    promptValues: ({ wait }) => ({ branch: wait.branch, project: "agent-worktree-gui", pr: 312 }),
  });

  assert.equal(reads.length, 1, "one due record is one host read");
  assert.equal(out.advanced, 1);
  assert.equal(out.woke, 1, "the advance is a turn, and it was started");

  // The stage moved, the wait is gone, and the history records the hop as a path (§3).
  const record = records.get(TREE, { fresh: true });
  assert.equal(record.stage, "address", "the comment advanced wait → address");
  assert.equal(record.pipelineWait, undefined, "the wait is gone with the hop");
  assert.equal(record.history.at(-1).stage, "address");
  assert.equal(record.history.at(-1).by, "stage");
  assert.match(record.history.at(-1).why, /a comment arrived/);

  // One wake, on the same thread, carrying the NEXT stage's prompt with its hole filled — and the reason in one line.
  assert.equal(woke.length, 1);
  assert.equal(woke[0].thread, THREAD);
  assert.match(woke[0].text, /exited: a comment arrived/);
  assert.match(woke[0].text, new RegExp(`answer the new comments on ${BRANCH} and push`), "the address stage's own instruction, rendered");
  assert.ok(!woke[0].text.includes("{{branch}}"), "no hole is handed to the worker");
  assert.match(woke[0].displayPrompt, /address: a comment arrived/);
  assert.equal(jobs.jobs.size, 0, "the sweep itself starts no card and holds no run: the wake is the turn");
});

// ---- §6.3b gap 5.1: the timer advances through the rail ------------------------------------------------------------
// A wait stage draws TWO ways out, and the kind order takes the approval unless the review's own fact is read first.
// These tests are the timer's half of the rail: a comment newer than lastSeen must take H-04 to the answer stage,
// the answer stage returns by H-05, and the fourth crossing is refused by H-04's cap.
const commentAt = (at) => ({ ok: true, pr: { number: 312, state: "OPEN", headRefOid: "a".repeat(40), reviewers: [], comments: [{ at }], approvals: [] } });

test("a comment newer than lastSeen takes H-04 to the answer stage, not H-06 to approve; H-05 returns it to wait", async (t) => {
  const { records, jobs } = board(t, { catalogue: GRAPHED_CATALOGUE, recordOver: { id: GRAPHED.id } });
  const woke = [];

  const out = await jobs.sweepPipelineWaits({
    now: T0 + WAIT_FIRST_MS,
    readReview: () => commentAt(iso(T0 + HOUR / 2)),
    wake: (turn) => (woke.push(turn), { ok: true, job: { id: "wake1" } }),
    promptValues: ({ wait }) => ({ branch: wait.branch, project: "agent-worktree-gui", pr: 312 }),
  });

  assert.equal(out.advanced, 1);
  const record = records.get(TREE, { fresh: true });
  assert.equal(record.stage, "address", "a comment newer than lastSeen routes to the answer stage, ahead of any approval");
  assert.equal(record.crossings["H-04"], 1, "the timer counts the crossing it took, or the cap is not real");
  assert.equal(record.history.at(-1).stage, "address");
  assert.match(record.history.at(-1).why, /a comment arrived/);
  assert.equal(woke.length, 1);
  assert.match(woke[0].text, new RegExp(`answer the new comments on ${BRANCH} and push`), "the answer stage's own instruction");

  // The answer stage returns to wait on the rail's own edge, and the next wait is the one that can take an approval.
  const back = nextStageOf(GRAPHED, record);
  assert.equal(back.ok, true);
  assert.equal(back.stage.id, "wait");
  assert.equal(back.handoff.id, "H-05", "address rejoins at wait; nothing else is reachable from it");
});

test("H-04 is crossed at most three times; the fourth comment closes the wait instead of looping again", async (t) => {
  const { records, jobs } = board(t, { catalogue: GRAPHED_CATALOGUE, recordOver: { id: GRAPHED.id } });
  const woke = [];
  // Each round reseeds the wait the way the driver's own pass would after address -> wait, carrying the crossings the
  // timer wrote. The comment is always newer than that round's lastSeen.
  const round = (n, lastSeen, crossings) => {
    const now = T0 + n * WAIT_FIRST_MS;
    records.set(TREE, {
      id: GRAPHED.id,
      stage: "wait",
      since: iso(now - WAIT_FIRST_MS),
      history: [],
      ...(crossings ? { crossings: { ...crossings } } : {}),
      pipelineWait: waitRecord({ at: iso(now - WAIT_FIRST_MS), lastSeen }),
    });
    return jobs.sweepPipelineWaits({
      now,
      readReview: () => commentAt(iso(now - WAIT_FIRST_MS / 2)),
      wake: (turn) => (woke.push(turn), { ok: true }),
      promptValues: () => ({ branch: BRANCH }),
    });
  };

  assert.equal((await round(1, iso(T0 - HOUR), null)).advanced, 1);
  assert.equal(records.get(TREE, { fresh: true }).crossings["H-04"], 1);
  assert.equal((await round(2, iso(T0), { "H-04": 1 })).advanced, 1);
  assert.equal(records.get(TREE, { fresh: true }).crossings["H-04"], 2);
  assert.equal((await round(3, iso(T0 + HOUR), { "H-04": 2 })).advanced, 1);
  assert.equal(records.get(TREE, { fresh: true }).crossings["H-04"], 3, "three crossings, the cap's own number");

  const fourth = await round(4, iso(T0 + 2 * HOUR), { "H-04": 3 });
  assert.equal(fourth.advanced, 0, "a fourth crossing is past the cap");
  assert.equal(fourth.refused, 1);
  assert.equal(woke.length, 3, "the fourth comment wakes nobody");
  const held = records.get(TREE, { fresh: true });
  assert.equal(held.stage, "wait", "the row stops where it is, for a person");
  assert.equal(held.pipelineWait, undefined, "and the wait is closed, so no tick keeps asking the same question");
});

// ---- §6.4 the next check, and nothing else -----------------------------------------------------------------------
test("nothing arrived: no run, the next check is scheduled (1h → 2h) and is not due before it", async (t) => {
  const { records, jobs } = board(t);
  const woke = [];
  const quietRead = { ok: true, pr: { number: 312, state: "OPEN", headRefOid: "e".repeat(40), reviewers: [], comments: [{ at: iso(T0 - HOUR) }], approvals: [] } };

  const first = await jobs.sweepPipelineWaits({ now: T0 + WAIT_FIRST_MS, readReview: () => quietRead, wake: (turn) => (woke.push(turn), { ok: true }), promptValues: () => ({ branch: BRANCH }) });
  assert.equal(first.rescheduled, 1);
  assert.equal(first.woke, 0, "a quiet reviewer costs a tick, not a turn");
  assert.equal(woke.length, 0);

  const after = records.get(TREE, { fresh: true });
  assert.equal(after.stage, "wait", "nothing arrived, so the stage stays");
  assert.equal(after.pipelineWait.every, 2 * HOUR, "the backoff doubled");
  assert.equal(after.pipelineWait.attempts, 1);
  assert.equal(after.pipelineWait.at, iso(T0 + WAIT_FIRST_MS));

  // The record is not due again until its own interval has passed: 2h from the check, not a minute later.
  const early = await jobs.sweepPipelineWaits({ now: T0 + 2 * HOUR - 1, readReview: () => quietRead, wake: () => (woke.push("early"), { ok: true }) });
  assert.deepEqual({ checked: early.checked, woke: early.woke }, { checked: 0, woke: 0 });
  const due = await jobs.sweepPipelineWaits({ now: T0 + 3 * HOUR, readReview: () => quietRead, wake: () => (woke.push("due"), { ok: true }) });
  assert.equal(due.checked, 1, "and it is due exactly two hours after the last check");
  assert.equal(woke.length, 0);
});

test("a host read that throws (or a second claim) never advances the stage and never wakes", async (t) => {
  const { records, jobs } = board(t);
  const woke = [];
  const out = await jobs.sweepPipelineWaits({
    now: T0 + WAIT_FIRST_MS,
    readReview: () => {
      throw new Error("ECONNRESET from git.sefl.com");
    },
    wake: (turn) => (woke.push(turn), { ok: true }),
    promptValues: () => ({ branch: BRANCH }),
  });
  assert.equal(out.advanced, 0);
  assert.equal(out.rescheduled, 1, "fail-closed: the stage stays and is re-checked");
  assert.equal(woke.length, 0, "a check that cannot be read does not exit the stage — and does not wake a worker to guess");
  assert.equal(records.get(TREE, { fresh: true }).stage, "wait");

  // A record already claimed a minute ago is not claimed again: two ticks meeting one hour cannot double-wake.
  records.set(TREE, { id: LOOP.id, stage: "wait", since: iso(T0), history: [], pipelineWait: waitRecord({ at: iso(T0), claimedAt: iso(T0 + WAIT_FIRST_MS - 60_000) }) });
  const claimed = await jobs.sweepPipelineWaits({ now: T0 + WAIT_FIRST_MS, readReview: () => ({ ok: true, pr: { state: "OPEN", comments: [{ at: iso(T0 + HOUR / 2) }], approvals: [], reviewers: [] } }), wake: (turn) => (woke.push(turn), { ok: true }) });
  assert.equal(claimed.wanted, 1);
  assert.equal(claimed.advanced, 0);
  assert.equal(woke.length, 0);
});

test("a merged PR closes the wait, and a prompt whose hole is empty refuses to advance", async (t) => {
  const { records, jobs } = board(t);
  const woke = [];
  const merged = await jobs.sweepPipelineWaits({
    now: T0 + WAIT_FIRST_MS,
    readReview: () => ({ ok: true, pr: { number: 312, state: "MERGED", headRefOid: "f".repeat(40), reviewers: [], comments: [], approvals: [] } }),
    wake: (turn) => (woke.push(turn), { ok: true }),
  });
  assert.equal(merged.closed, 1);
  assert.equal(woke.length, 0, "there is nothing left to answer on a merged PR");
  assert.equal(records.get(TREE, { fresh: true }).pipelineWait, undefined, "the wait is closed, not re-checked forever");

  // The next stage needs {{desc}}, which nothing in this fixture can resolve: the tree must NOT advance into a prompt
  // the worker cannot act on — §1.4 — and it must stay on the stage to be re-checked.
  const noHole = LOOP.stages.find((s) => s.id === "address");
  noHole.prompt = "answer {{desc}} on {{branch}}";
  try {
    records.set(TREE, { id: LOOP.id, stage: "wait", since: iso(T0), history: [], pipelineWait: waitRecord() });
    const refused = await jobs.sweepPipelineWaits({
      now: T0 + WAIT_FIRST_MS,
      readReview: () => ({ ok: true, pr: { number: 312, state: "OPEN", headRefOid: "1".repeat(40), reviewers: [], comments: [{ at: iso(T0 + HOUR / 2) }], approvals: [] } }),
      wake: (turn) => (woke.push(turn), { ok: true }),
      promptValues: ({ wait }) => ({ branch: wait.branch }),
    });
    assert.equal(refused.advanced, 0);
    assert.equal(refused.refused, 1);
    assert.equal(woke.length, 0);
    const rec = records.get(TREE, { fresh: true });
    assert.equal(rec.stage, "wait");
    assert.ok(rec.pipelineWait, "the wait is kept: the tree is re-checked, not abandoned");
  } finally {
    noHole.prompt = "answer the new comments on {{branch}} and push";
  }
});

test("a DECLINED read is stamped on the tree's record and outlives the wait it closes", async (t) => {
  // Row 67: the pull request read DECLINED, the wait closed, and the driver - which has no reader of its own - walked
  // the row on to approve and merge. The read is stamped BEFORE the wait is cleared, so the fact the driver needs is
  // still on the record after the wait it came from is gone.
  const { records, jobs } = board(t);
  const woke = [];
  const out = await jobs.sweepPipelineWaits({
    now: T0 + WAIT_FIRST_MS,
    readReview: () => ({ ok: true, pr: { number: 7, state: "DECLINED", headRefOid: "9".repeat(40), reviewers: [], comments: [], approvals: [] } }),
    wake: (turn) => (woke.push(turn), { ok: true }),
  });
  assert.equal(out.closed, 1);
  assert.equal(out.advanced, 0, "a declined PR advances nothing");
  assert.equal(woke.length, 0, "and wakes nobody: there is nothing left to answer");

  const record = records.get(TREE, { fresh: true });
  assert.equal(record.pipelineWait, undefined, "the wait is closed");
  assert.ok(record.reviewRead, "the read is on the record, not inside the wait that was just cleared");
  assert.equal(record.reviewRead.stage, "wait");
  assert.equal(record.reviewRead.check, "pr-comments");
  assert.equal(record.reviewRead.state, "DECLINED", "the host's own word");
  assert.equal(record.reviewRead.closed, "declined");
  assert.equal(record.reviewRead.advanced, false);
  assert.equal(record.reviewRead.at, iso(T0 + WAIT_FIRST_MS), "stamped at the read, so a later visit can tell itself apart");

  const read = jobs.reviewReadFor(TREE, "wait", { enteredAt: iso(T0) });
  assert.equal(read.state, "DECLINED", "the driver's question answers with the same fact");
  assert.equal(jobs.reviewReadFor(TREE, "approve", { enteredAt: iso(T0) }), null, "a read of one stage is not an answer about another");
  assert.equal(jobs.reviewReadFor(TREE, "wait", { enteredAt: iso(T0 + 2 * HOUR) }), null, "nor about a later visit of the same stage");
});

test("six quiet hours is ONE status wake that does not advance the stage", async (t) => {
  const { records, jobs } = board(t, { wait: waitRecord({ at: iso(T0 + 5 * HOUR), every: 4 * HOUR }) });
  const woke = [];
  const quiet = { ok: true, pr: { number: 312, state: "OPEN", headRefOid: "2".repeat(40), reviewers: [], comments: [{ at: iso(T0 - HOUR) }], approvals: [] } };
  const out = await jobs.sweepPipelineWaits({ now: T0 + 9 * HOUR, readReview: () => quiet, wake: (turn) => (woke.push(turn), { ok: true }) });
  assert.equal(out.woke, 1, "a card waiting six hours on a person says so once");
  assert.equal(woke[0].quiet, true);
  assert.match(woke[0].text, /nothing from the reviewer in six hours/);
  assert.match(woke[0].text, /do not poll/, "and the wake tells the worker to end the turn, not to wait");
  const rec = records.get(TREE, { fresh: true });
  assert.equal(rec.stage, "wait", "a status wake is a sentence, not an advance");
  assert.equal(rec.pipelineWait.quietWakeSent, true);
  assert.equal(rec.pipelineWait.every, 4 * HOUR, "and it does not reset the backoff");

  const next = await jobs.sweepPipelineWaits({ now: T0 + 13 * HOUR, readReview: () => quiet, wake: (turn) => (woke.push(turn), { ok: true }) });
  assert.equal(next.woke, 0, "the second quiet check is not a second wake");
});

// ---- §6.5 the two host payloads -----------------------------------------------------------------------------------
test("the host payloads normalise into one observation: GitHub's reviews and Bitbucket's reviewers", () => {
  // GitHub: an APPROVED review names the commit it approved; the requested team is the reviewer the PR carries.
  const gh = observeGithubPr({
    state: "OPEN",
    headRefOid: "9".repeat(40),
    reviewRequests: [{ slug: "code_review_java" }],
    reviews: [{ state: "APPROVED", submittedAt: iso(T0), author: { login: "rev" }, commit: { oid: "8".repeat(40) } }],
    comments: [{ id: 1, createdAt: iso(T0 - HOUR), author: { login: "rev" } }],
  });
  assert.equal(gh.ok, true);
  assert.deepEqual(gh.pr.reviewers, ["code_review_java", "rev"]);
  assert.deepEqual(gh.pr.approvals, [{ commit: "8".repeat(40), at: iso(T0), by: "rev" }]);
  assert.equal(readReviewExit({ check: "pr-approved" }, gh).advanced, false, "APPROVED at an older commit is not an approval of the head");
  assert.equal(readReviewExit({ check: "reviewers-exact", who: ["code_review_java", "rev"] }, gh).advanced, true);
  assert.equal(readReviewExit({ check: "pr-comments" }, gh, { lastSeen: iso(T0 - 2 * HOUR) }).advanced, true);

  // Bitbucket Server: the PR record carries the head and the reviewers' lastReviewedCommit; the activities page the
  // comments. An approval's commit is the reviewer record's, because the activity does not name one.
  const bbRecord = {
    id: 312,
    state: "OPEN",
    fromRef: { latestCommit: "7".repeat(40) },
    reviewers: [{ name: "code_review_java", approved: true, lastReviewedCommit: "7".repeat(40) }, { name: "someone_else" }],
  };
  const bbActivities = { values: [{ action: "COMMENTED", createdDate: iso(T0 + HOUR / 2), comment: { id: 9 }, user: { name: "rev" } }, { action: "APPROVED", createdDate: iso(T0 + HOUR) }] };
  const bb = observeBitbucketPr(bbRecord, bbActivities);
  assert.equal(bb.ok, true);
  assert.equal(bb.pr.number, 312);
  assert.equal(bb.pr.headRefOid, "7".repeat(40));
  assert.deepEqual(bb.pr.reviewers, ["code_review_java", "someone_else"]);
  assert.equal(readReviewExit({ check: "pr-approved" }, bb).advanced, true, "the reviewer's lastReviewedCommit IS the head");
  assert.equal(readReviewExit({ check: "pr-comments" }, bb, { lastSeen: iso(T0) }).advanced, true);
  assert.equal(readReviewExit({ check: "reviewers-exact", who: ["code_review_java"] }, bb).advanced, false, "a second reviewer is not exact");

  // The SAME host, in the shape it ACTUALLY sends: reviewers under `user`, and `createdDate`/`approvedAt` as epoch
  // milliseconds numbers. The fixture above is ISO and top-level names, which is why a live comment read as "no
  // comment carries a timestamp yet" and a live reviewer list read as empty. Both shapes must answer the same way.
  const liveRecord = {
    id: 7,
    state: "OPEN",
    fromRef: { latestCommit: "6".repeat(40) },
    reviewers: [{ user: { name: "code_review_java", displayName: "Java Code Review", slug: "code_review_java" }, role: "REVIEWER", approved: true, lastReviewedCommit: "6".repeat(40), approvedAt: T0 + HOUR }],
  };
  const liveActivities = { values: [{ action: "COMMENTED", createdDate: T0 + 2 * HOUR, comment: { id: 101 }, user: { name: "rev" } }] };
  const live = observeBitbucketPr(liveRecord, liveActivities);
  assert.equal(live.ok, true);
  assert.deepEqual(live.pr.reviewers, ["code_review_java"], "the host nests the reviewer under user");
  assert.equal(live.pr.comments[0].at, iso(T0 + 2 * HOUR), "an epoch-ms createdDate is a timestamp, not a string to drop");
  assert.equal(live.pr.comments[0].id, 101);
  assert.deepEqual(live.pr.approvals, [{ commit: "6".repeat(40), at: iso(T0 + HOUR), by: "code_review_java" }], "an epoch-ms approvedAt is a timestamp");
  assert.equal(readReviewExit({ check: "pr-comments" }, live, { lastSeen: iso(T0) }).advanced, true, "a live comment after lastSeen advances the wait");
  assert.equal(readReviewExit({ check: "pr-comments" }, live, { lastSeen: iso(T0 + 3 * HOUR) }).advanced, false, "the same comment is not newer than a later lastSeen");
  assert.equal(readReviewExit({ check: "reviewers-exact", who: ["code_review_java"] }, live).advanced, true, "the shipped reviewer is exactly the required one");

  // A payload this module cannot parse is a refusal, never an empty PR.
  assert.equal(observeGithubPr(null).ok, false);
  assert.equal(observeBitbucketPr({ state: "OPEN" }, null).ok, false);
  assert.equal(observeGithubPr({ reviews: [] }).ok, false, "no state is not an open PR");
});

// ---- §6.7 the HOLD: the stage's own run, in the same book ---------------------------------------------------------
// The second kind of wait. The reviewer's wait is a clock; a hold is the stage's own worker, and its answer is the job
// store's. These pin the model, the registration, the one advance seam and the compare-and-set that keeps two owners
// from moving one stage.
test("a hold names its stage AND its run, and a wait with no run is not a hold", () => {
  const hold = stageRunWaitFor("draft", { pipeline: "ping-pong", visit: 2, thread: THREAD, job: "job-7", branch: BRANCH, at: iso(T0) });
  assert.equal(hold.kind, "run");
  assert.equal(isRunWait(hold), true);
  assert.equal(hold.stage, "draft");
  assert.equal(hold.visit, 2);
  assert.equal(hold.job, "job-7");
  assert.equal(hold.thread, THREAD);
  assert.equal(hold.settledAt, null, "the settle stamps it; the cut does not pretend the run has ended");

  assert.equal(stageRunWaitFor("", { job: "job-7" }), null, "a hold with no stage holds nothing");
  assert.equal(stageRunWaitFor("draft", { visit: 1 }), null, "a hold that names no run is not a hold");
  assert.equal(waitKind(waitRecord()), "review", "a record written before the kinds existed is the reviewer's");
  assert.equal(isRunWait(waitRecord()), false);
  // A hold's clock is the run, not the calendar: it is worth one job-store read on every tick.
  assert.equal(waitIsDue(hold, { now: T0 }), true);
  assert.equal(waitIsDue(hold, { now: T0 - 10 * HOUR }), true);
});

test("the cut writes the hold; a live run keeps it, and the settle hands the row to the advance seam exactly once", async (t) => {
  const { records, jobs } = board(t, { wait: null });
  const card = { id: "job-7", thread: THREAD, status: "running" };
  jobs.jobs.set(card.id, card);
  const never = () => {
    throw new Error("a hold reads the job store, never the host");
  };
  const calls = [];
  const advance = (item) => {
    calls.push(item);
    return { ok: true, moved: true, from: "draft", to: "critique", state: "queued" };
  };

  const written = jobs.holdPipelineStageRun({ tree: TREE, pipeline: "ping-pong", stage: "draft", visit: 1, thread: THREAD, job: card.id, at: iso(T0) });
  assert.equal(written.kind, "run");
  assert.equal(written.job, "job-7");
  const book = records.get(TREE, { fresh: true });
  assert.equal(book.pipelineWait.kind, "run", "the hold is in the DURABLE book, not on a card");
  assert.equal(book.pipelineWait.stage, "draft");
  assert.equal(book.pipelineWait.job, "job-7", "and it is keyed to the run, not to the stage alone");

  const heldSweep = await jobs.sweepPipelineWaits({ now: T0 + 60_000, readReview: never, wake: () => ({ ok: true }), advance });
  assert.equal(heldSweep.held, 1, "a live run keeps the hold");
  assert.equal(calls.length, 0, "nothing is advanced while the worker is still working");
  assert.equal(records.get(TREE, { fresh: true }).pipelineWait.job, "job-7");

  // The run ends. The settle stamps the hold (the driver's fallback runs from that stamp, not from the cut), and the
  // panel's timer is the one that reads it.
  card.status = "done";
  jobs.stampPipelineHold({ id: "job-7", thread: THREAD, worktreePath: TREE }, { now: T0 + 2 * 60_000 });
  assert.equal(records.get(TREE, { fresh: true }).pipelineWait.settledAt, iso(T0 + 2 * 60_000));

  const out = await jobs.sweepPipelineWaits({ now: T0 + 3 * 60_000, readReview: never, wake: () => ({ ok: true }), advance });
  assert.equal(out.advanced, 1);
  assert.equal(calls.length, 1, "one settle is one advance");
  assert.equal(calls[0].stage, "draft");
  assert.equal(calls[0].wait.job, "job-7");
  assert.equal(records.get(TREE, { fresh: true }).pipelineWait, undefined, "the hold is gone with the advance");

  // The hold WAS the claim: a second tick a minute later finds nothing to advance.
  const again = await jobs.sweepPipelineWaits({ now: T0 + 4 * 60_000, readReview: never, wake: () => ({ ok: true }), advance });
  assert.deepEqual({ checked: again.checked, advanced: again.advanced }, { checked: 0, advanced: 0 });
  assert.equal(calls.length, 1, "the stage is started once, never twice");
});

// The settle lag (docs/reviews/ping-pong-round-6-2026-11-08.html, "The settle lags the run by about a minute"): the
// drafter's run ended at 22:58:31.719Z and the stage settled at 22:59:23.923Z — 52.2 s, because the hold's only owner
// was the panel's MINUTE ticker. The run's own end is the event the hold was written for, so the settle now asks the
// sweep at once. This test drives the hook the way server.js wires it: the stamp fires the hook, the hook runs the
// one sweep, and the row is advanced on the settle's own instant — no clock, no night's wait.
test("a run's end asks the sweep AT ONCE — the stage does not wait for the next minute", async (t) => {
  const never = () => {
    throw new Error("a hold reads the job store, never the host");
  };
  const calls = [];
  let advanced = 0;
  let jobs = null;
  // What server.js does with the hook: `void tickPipelineWaits()`. The sweep is given the SETTLE's instant, so this
  // test cannot pass by waiting for a later clock.
  const kick = (info) => {
    calls.push(info);
    void jobs
      .sweepPipelineWaits({
        now: Date.parse(info.at),
        readReview: never,
        wake: () => ({ ok: true }),
        advance: () => ({ ok: true, moved: true, from: "wait", to: "address", state: "queued" }),
      })
      .then((out) => {
        advanced = out.advanced;
      });
  };
  const made = board(t, { wait: null, onStageSettled: kick });
  jobs = made.jobs;
  const stamp = T0 + 1000;
  jobs.holdPipelineStageRun({ tree: TREE, pipeline: LOOP.id, stage: "wait", visit: 1, thread: THREAD, job: "job-7", at: iso(T0) });
  jobs.jobs.set("job-7", { id: "job-7", thread: THREAD, status: "done" });

  const stored = jobs.stampPipelineHold({ id: "job-7", thread: THREAD, worktreePath: TREE }, { now: stamp });
  assert.equal(stored.pipelineWait.settledAt, iso(stamp), "the settle is stamped as it always was");
  assert.equal(calls.length, 0, "the hook is DEFERRED: it must not run inside the run's own settle");

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1, "one settle asks the panel once");
  assert.equal(calls[0].tree, TREE);
  assert.equal(calls[0].job, "job-7");
  assert.equal(calls[0].stage, "wait");

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(advanced, 1, "the sweep it asked for advanced the row on the settle's own stamp");
  assert.equal(made.records.get(TREE, { fresh: true }).pipelineWait, undefined, "and the hold is gone with the advance");
});

test("a hold whose card the store no longer has is still the timer's to advance, and the seam is required", async (t) => {
  const { records, jobs } = board(t, { wait: null });
  const never = () => {
    throw new Error("a hold reads the job store, never the host");
  };
  jobs.holdPipelineStageRun({ tree: TREE, pipeline: "ping-pong", stage: "draft", visit: 1, thread: THREAD, job: "job-gone", at: iso(T0) });

  // No advance seam: the hold is KEPT and the sweep says why. Clearing it here would delete the row's only record of the
  // condition and advance nothing.
  const refused = await jobs.sweepPipelineWaits({ now: T0 + 60_000, readReview: never, wake: () => ({ ok: true }) });
  assert.equal(refused.errors.length, 1);
  assert.match(refused.errors[0].error, /advance seam/);
  assert.equal(records.get(TREE, { fresh: true }).pipelineWait.job, "job-gone", "the hold survives a tick that cannot act on it");

  // A card the 80-job ring dropped (a restart) is not a live run: the timer hands the row over and the seam decides.
  const out = await jobs.sweepPipelineWaits({ now: T0 + 120_000, readReview: never, wake: () => ({ ok: true }), advance: () => ({ ok: true, moved: true, from: "draft", to: "critique", state: "queued" }) });
  assert.equal(out.advanced, 1);
  assert.equal(records.get(TREE, { fresh: true }).pipelineWait, undefined);
});

test("a newer hold is never cleared by a sweep that read the older one", async (t) => {
  const { records, jobs } = board(t, { wait: null });
  // The hold in force is the NEXT stage's cut: a sweep that read `draft` must not clear it.
  jobs.holdPipelineStageRun({ tree: TREE, pipeline: "ping-pong", stage: "critique", visit: 1, thread: "t2", job: "job-2", at: iso(T0 + 1000) });
  assert.equal(jobs.clearPipelineHold(TREE, { job: "job-1", stage: "draft", visit: 1 }), null);
  assert.equal(records.get(TREE, { fresh: true }).pipelineWait.stage, "critique", "the newer hold is untouched");
  const cleared = jobs.clearPipelineHold(TREE, { job: "job-2", stage: "critique", visit: 1 });
  assert.equal(cleared.cleared, true);
  assert.equal(records.get(TREE, { fresh: true }).pipelineWait, undefined);
});

test("the hold is read back out of the file, so a restart waits on the same run rather than starting the stage", (t) => {
  const { dir, records, jobs } = board(t, { wait: null });
  jobs.holdPipelineStageRun({ tree: TREE, pipeline: "ping-pong", stage: "draft", visit: 1, thread: THREAD, job: "job-9", at: iso(T0) });
  // A second book over the same file is a restarted panel: nothing of the first process is in memory here.
  const restarted = new PipelineRecords({ file: path.join(dir, "pipeline-records.json") });
  const back = restarted.get(TREE, { fresh: true });
  assert.equal(back.pipelineWait.kind, "run");
  assert.equal(back.pipelineWait.job, "job-9");
  assert.equal(back.pipelineWait.settledAt, null, "a restart between the cut and the settle sees a live hold");
});

// ---- §6.6 the seed's own review loop is the shape this was built for ---------------------------------------------
test("the wait's advance keeps the definition and appends one hop, so wait → address → wait is a path", () => {
  const at = iso(T0);
  const waiting = advanceStage({ id: LOOP.id, stage: "pr", since: at, history: [{ from: "turnover", to: "turnover", stage: "pr", at, by: "stage" }] }, { kind: "turnover", stage: "wait", at, why: "pr-open matched" });
  const addressed = advanceStage(waiting, { kind: "turnover", stage: "address", at, why: "a comment arrived" });
  const back = advanceStage(addressed, { kind: "turnover", stage: "wait", at, why: "the comment was answered" });
  assert.equal(back.id, LOOP.id);
  assert.deepEqual(back.history.map((h) => h.stage), ["pr", "wait", "address", "wait"]);
});

// ---- §6.7 the PDL row: the other half of gap 5.1 ----------------------------------------------------------------
// Every pipeline the panel SHIPS is a PDL document (pipelines.seed.json is empty), and a PDL stage declares an artifact,
// not an exit. PR #677 made the rail take wait → address on a comment newer than lastSeen, but the timer registered no
// wait for a PDL row, so a reviewer's comment still could not be answered. These tests are the registration and the
// sweep on a row the panel actually has: the tree was cut `local`, and only the hold names the document and the stage.
const PDL_SEED = parseBundle(readFileSync(BUNDLE, "utf8"));
const PDL_LOOP = pipelineById(PDL_SEED.bundle, "sefl-review-loop");

test("a PDL row's wait stage registers the gate's review fact, naming the document the tree record cannot", (t) => {
  const { dir, records, jobs } = board(t, {
    stage: "work",
    wait: null,
    recordOver: { id: "local" },
    catalogue: { get: () => null },
    config: { pipelineBundleFile: BUNDLE },
  });
  // What a live PDL row's book really holds: the cut wrote `local · work` and the hold wrote the run's document and stage.
  jobs.holdPipelineStageRun({ tree: TREE, pipeline: "sefl-review-loop", stage: "wait", visit: 1, thread: THREAD, job: "job-pdl-1", at: iso(T0 - 30 * 60_000) });

  const wait = jobs.registerPipelineWait({ id: "job-pdl-1", ownerPath: TREE, thread: THREAD, branch: BRANCH }, { now: T0 });
  assert.ok(wait, "the gate after the PDL wait stage names pr-comments, so the row waits");
  assert.equal(wait.check, "pr-comments");
  assert.equal(wait.stage, "wait");
  assert.equal(wait.pipeline, "sefl-review-loop", "the wait carries the document: the tree record never leaves `local`");
  assert.equal(wait.gate, "G4");
  assert.equal(wait.lastSeen, iso(T0 - 30 * 60_000), "the clock is the stage's entry (the hold), not the tree's cut");
  assert.equal(records.get(TREE, { fresh: true }).id, "local", "registering a wait does not rewrite the tree's rung");

  // Durable on the tree, where a restart and a second panel read it.
  const onDisk = JSON.parse(readFileSync(path.join(dir, "pipeline-records.json"), "utf8"));
  assert.equal(onDisk.trees[TREE].pipelineWait.check, "pr-comments");
  assert.equal(onDisk.trees[TREE].pipelineWait.pipeline, "sefl-review-loop");

  // Idempotent within the stage: a second turn keeps the clock already running.
  const again = jobs.registerPipelineWait({ id: "job-pdl-2", ownerPath: TREE, thread: THREAD, branch: BRANCH }, { now: T0 + 10 * 60_000 });
  assert.equal(again.at, iso(T0), "the clock is the stage's, not the turn's");

  // A PDL stage that ends on its own work registers nothing: G5 verifies `pushed`, not a reviewer.
  jobs.holdPipelineStageRun({ tree: TREE, pipeline: "sefl-review-loop", stage: "address", visit: 1, thread: THREAD, job: "job-pdl-3", at: iso(T0) });
  assert.equal(jobs.registerPipelineWait({ ownerPath: TREE, thread: THREAD }, { now: T0 }), null, "address ends on the push");
  assert.equal(records.get(TREE, { fresh: true }).pipelineWait.stage, "address", "and the hold it was reading is left in force");
});

test("a PDL row's comment newer than lastSeen takes the next sweep to address, and H-05 returns it to wait", async (t) => {
  assert.equal(PDL_SEED.ok, true, "the shipped document parses");
  assert.ok(PDL_LOOP, "and holds the review loop");
  // The book a live PDL row has: `local · work`, and the review wait the registration above just wrote, naming the
  // document and the stage. The tree record's stage is NOT the wait's, which is the defect this test exists for.
  const { records, jobs } = board(t, {
    stage: "work",
    wait: waitRecord({ pipeline: "sefl-review-loop", gate: "G4", lastSeen: iso(T0 - HOUR), thread: THREAD, branch: BRANCH }),
    recordOver: { id: "local" },
    catalogue: { get: () => null },
    config: { pipelineBundleFile: BUNDLE },
  });
  const woke = [];
  const out = await jobs.sweepPipelineWaits({
    now: T0 + WAIT_FIRST_MS, // one hour later, a number and never a sleep
    readReview: () => ({ ok: true, pr: { number: 677, state: "OPEN", headRefOid: "e".repeat(40), reviewers: [], comments: [{ at: iso(T0 - HOUR / 2) }], approvals: [] } }),
    wake: (turn) => {
      woke.push(turn);
      return { ok: true, job: { id: "wake-pdl" } };
    },
  });

  assert.equal(out.advanced, 1, "a comment newer than lastSeen entered the answer stage");
  assert.equal(out.woke, 1, "and the wake is a turn on the same thread");
  const moved = records.get(TREE, { fresh: true });
  assert.equal(moved.stage, "address", "wait → address, read off the PDL document's H-04");
  assert.equal(moved.pipelineWait, undefined, "the wait is gone with the hop");
  assert.equal(moved.crossings["H-04"], 1, "the loop's crossing is counted on the record, so the cap is real");
  assert.match(woke[0].text, /sefl-review-loop · address/, "the wake names the document, not the tree's `local` rung");

  // The SAME rail returns it: address draws H-05 back to wait, so wait → address → wait is a path on the document.
  const back = nextStageOf(PDL_LOOP, moved);
  assert.equal(back.ok, true);
  assert.equal(back.stage.id, "wait");
  assert.equal(back.handoff.id, "H-05");
});

test("the PDL row's 3-crossing cap is the same one the ladder pays: the fourth comment closes the wait", async (t) => {
  const { records, jobs } = board(t, {
    stage: "work",
    wait: waitRecord({ pipeline: "sefl-review-loop", gate: "G4", lastSeen: iso(T0 - HOUR), thread: THREAD, branch: BRANCH }),
    recordOver: { id: "local", crossings: { "H-04": 3 } },
    catalogue: { get: () => null },
    config: { pipelineBundleFile: BUNDLE },
  });
  const out = await jobs.sweepPipelineWaits({
    now: T0 + WAIT_FIRST_MS,
    readReview: () => ({ ok: true, pr: { number: 677, state: "OPEN", headRefOid: "e".repeat(40), reviewers: [], comments: [{ at: iso(T0 - HOUR / 2) }], approvals: [] } }),
    wake: () => {
      throw new Error("a capped loop must not wake");
    },
  });
  assert.equal(out.advanced, 0, "the fourth crossing is refused, not taken");
  assert.equal(out.refused, 1);
  const record = records.get(TREE, { fresh: true });
  assert.equal(record.stage, "work", "the row stays where it was for a decision");
  assert.equal(record.pipelineWait, undefined, "the wait is closed rather than looped forever");
});

// Rung 3 of docs/reports/pipeline-execution-next-moves-2026-11-10.html section 2.3. The approval at the head: a live
// PDL row at `approve` registers its wait from G6 (`pr-approved`) - the stage carries no `exit`, and that is not a
// reason to skip the wait - and an approval is the exit only when it is AT the PR's current head. Two observations go
// through the SAME settle path: an approval at the previous head (no advance, no wake, the wait stays on the timer),
// then an approval at the current head (the row enters merge by H-07, the record naming the reviewer and the head, and
// the wait cleared). A sweep after the advance must not re-enter merge.
test("an approval gates approve only at the PR's current head", async (t) => {
  const APPROVE = PDL_LOOP.stages.find((s) => s.id === "approve");
  const G6 = reviewGateFor(PDL_LOOP, "approve");
  assert.ok(APPROVE && G6, "the shipped document holds the approve stage and the gate after it");
  assert.equal(APPROVE.exit, undefined, "a PDL stage declares an artifact, not an exit: G6 is where the check is named");
  assert.equal(G6.verifiedBy, "pr-approved");
  assert.equal(G6.decider, "reviewer");

  const HEAD = "b7c1d2e3" + "f".repeat(32);
  const PREVIOUS = "0a1b2c3d" + "e".repeat(32);
  const HOLD_AT = T0 - 30 * 60_000;
  const { dir, records, jobs } = board(t, {
    stage: "work",
    wait: null,
    recordOver: { id: "local" },
    catalogue: { get: () => null },
    config: { pipelineBundleFile: BUNDLE },
  });
  // The book a live PDL row has at approve: the cut wrote `local · work`, and the hold names the document and stage.
  jobs.holdPipelineStageRun({ tree: TREE, pipeline: "sefl-review-loop", stage: "approve", visit: 1, thread: THREAD, job: "job-approve-1", at: iso(HOLD_AT) });

  // (1) the settle registers the wait from G6, with the HOLD's clock - not the tree's cut - as lastSeen.
  const wait = jobs.registerPipelineWait({ id: "job-approve-1", ownerPath: TREE, thread: THREAD, branch: BRANCH }, { now: T0 });
  assert.ok(wait, "the stage has no exit of its own and G6 still names the reviewer's check, so the row waits");
  assert.equal(wait.check, "pr-approved");
  assert.equal(wait.stage, "approve");
  assert.equal(wait.gate, "G6", "the wait names the gate it read, not an exit the stage does not have");
  assert.equal(wait.pipeline, "sefl-review-loop", "a `local` tree record cannot name the document the stage came from");
  assert.equal(wait.thread, THREAD);
  assert.equal(wait.branch, BRANCH);
  assert.equal(wait.lastSeen, iso(HOLD_AT), "the clock is the stage's entry (the hold), not the tree's cut at T0");
  assert.equal(records.get(TREE, { fresh: true }).id, "local", "registering the wait does not rewrite the tree's rung");
  const onDisk = JSON.parse(readFileSync(path.join(dir, "pipeline-records.json"), "utf8"));
  assert.equal(onDisk.trees[TREE].pipelineWait.check, "pr-approved", "the wait is durable on the tree");
  assert.equal(onDisk.trees[TREE].pipelineWait.gate, "G6");

  // Two observations, one settle path. The older approval is the negative case and runs first.
  const observations = [
    { ok: true, pr: { number: 42, state: "OPEN", headRefOid: HEAD, reviewers: [], comments: [], approvals: [{ by: "code_review_java", commit: PREVIOUS, at: iso(T0 - 2 * HOUR) }] } },
    { ok: true, pr: { number: 42, state: "OPEN", headRefOid: HEAD, reviewers: [], comments: [], approvals: [{ by: "code_review_java", commit: HEAD, at: iso(T0 + 2 * HOUR) }] } },
  ];
  let read = 0;
  const woke = [];
  const sweep = (now) =>
    jobs.sweepPipelineWaits({
      now,
      readReview: () => observations[read++],
      wake: (turn) => {
        woke.push(turn);
        return { ok: true, job: { id: `wake-approve-${woke.length}` } };
      },
    });

  // (2) an approval at the PREVIOUS head is not an approval of this head: no advance, no wake, and the wait stays on
  // the timer for the next check rather than being cleared.
  const older = await sweep(T0 + WAIT_FIRST_MS);
  assert.equal(older.advanced, 0, "an approval at the previous head did not advance the stage");
  assert.equal(older.woke, 0, "and nothing was started: the answer is a reschedule, not a run");
  assert.equal(older.rescheduled, 1);
  assert.equal(woke.length, 0);
  const still = records.get(TREE, { fresh: true }).pipelineWait;
  assert.ok(still, "the wait is still on the record");
  assert.equal(still.stage, "approve", "the row stays at approve");
  assert.equal(still.check, "pr-approved");
  assert.equal(still.attempts, 1);
  assert.equal(still.lastSeen, iso(HOLD_AT), "an unapproved head does not move the clock the approval is measured against");
  assert.equal(waitDueAt(still), T0 + WAIT_FIRST_MS + 2 * HOUR, "the wait stays due, on its doubled interval");
  assert.equal(records.get(TREE, { fresh: true }).history.length, 1, "the record did not hop");

  // (3) the head approval: the rail's only edge out of approve is H-07, and that is the edge the settle takes.
  const step = nextStageOf(PDL_LOOP, { ...records.get(TREE, { fresh: true }), stage: "approve" }, { review: { observation: observations[1], lastSeen: still.lastSeen } });
  assert.equal(step.ok, true);
  assert.equal(step.stage.id, "merge");
  assert.equal(step.handoff.id, "H-07", "the approval crosses the approval edge, not the comment loop");

  const head = await sweep(waitDueAt(still));
  assert.equal(head.advanced, 1, "the approval at the head advanced the stage");
  assert.equal(head.woke, 1, "the advance is a wake on the same thread, not a second run of approve");
  assert.equal(woke.length, 1);
  assert.equal(woke[0].thread, THREAD);
  assert.match(woke[0].displayPrompt, /sefl-review-loop · merge/, "the wake names the document's next stage");
  const moved = records.get(TREE, { fresh: true });
  assert.equal(moved.stage, "merge", "approve → merge, read off the PDL document's H-07");
  assert.equal(moved.id, "local", "the tree record's rung is still the cut's");
  assert.equal(moved.pipelineWait, undefined, "the wait is cleared with the hop");
  assert.equal(moved.history.length, 2);
  const hop = moved.history[1];
  assert.equal(hop.stage, "merge");
  assert.match(hop.why, /^code_review_java approved b7c1d2e3$/, "the record names the reviewer and the head (its 8-character sha, the abbreviation the report's own records use)");
  assert.ok(!hop.why.includes(PREVIOUS.slice(0, 8)), "and the sha it names is the head's, not the earlier approval's");
  assert.equal(moved.crossings, undefined, "the approval took the sequence, so no loop crossing was charged");

  // (4) a sweep after the advance: nothing is due, the host is not read, no second run starts, and merge is not
  // entered again.
  const after = await jobs.sweepPipelineWaits({
    now: T0 + 4 * HOUR,
    readReview: () => {
      throw new Error("no wait is due, so the host must not be read");
    },
    wake: () => {
      throw new Error("no wait is due, so no run may be started");
    },
  });
  assert.equal(after.checked, 0);
  assert.equal(after.advanced, 0);
  assert.equal(after.woke, 0);
  assert.equal(woke.length, 1, "no second run");
  const settled = records.get(TREE, { fresh: true });
  assert.equal(settled.stage, "merge");
  assert.equal(settled.history.length, 2, "merge was entered once");
  assert.equal(settled.pipelineWait, undefined);
});
