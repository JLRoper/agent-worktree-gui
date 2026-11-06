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
  settleWait,
  stageRunWaitFor,
  waitDueAt,
  waitIsDue,
  waitKind,
  PipelineRecords,
} from "../lib/pipelines.js";

// Jobs reads this box's Hermes session store for counters; a suite about waits must not read the developer's own.
process.env.HERMES_HOME = mkdtempSync(path.join(os.tmpdir(), "wtgui-wait-home-"));
process.env.API_SERVER_KEY = "";

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-11-03T10:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const TREE = "c:/repo/.worktrees/build-the-stage-timer-0b37d7";
const THREAD = "wtgui/build-the-stage-timer-0b37d7";
const BRANCH = "wtgui/build-the-stage-timer-0b37d7";
const SEED = fileURLToPath(new URL("../pipelines.seed.json", import.meta.url));

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
function board(t, { stage = "wait", wait = waitRecord(), recordOver = {} } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-wait-"));
  const records = new PipelineRecords({ file: path.join(dir, "pipeline-records.json") });
  const jobs = new Jobs({ config: { jobsFile: path.join(dir, "jobs.json"), defaultCwd: dir }, onLog: () => {} });
  jobs.pipelineRecords = records;
  jobs.pipelines = CATALOGUE;
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
  const seed = (id) => JSON.parse(readFileSync(SEED, "utf8")).pipelines.find((p) => p.id === id);
  const loop = seed("sefl-review-loop");

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
