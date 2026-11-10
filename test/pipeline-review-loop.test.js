// gap 5.1 on the SHIPPED document: the review loop can answer a reviewer's comment.
//
// The executable document (pipeline-bundle.seed.json, `sefl-review-loop`) draws the answer as a capped loop
// (H-04: wait → address, "3 rounds") and the approval as a sequence (H-06: wait → approve). The driver's rail takes the
// sequence when both exist, so for as long as the rail could not read a review, H-04 was dead: a comment was read once
// at `wait` and never answered, and the row walked on to approve and merge (PictureViewer PR 7 carried nine open
// comments as the live proof).
//
// This file holds the SHIPPED graph to the three claims the report's P1 makes:
//
//   1. with nothing newer than lastSeen the order is branch, push, pr, wait, approve, merge - no stage skipped;
//   2. with a comment newer than lastSeen the next step enters address, and address returns to wait before approve;
//   3. H-04 is crossed at most three times: the fourth comment stops the row at the cap instead of looping again.
//
// It is deliberately a walk of the real bundle through the real `nextStageOf`. The timer's own half (the same rail,
// reached from a due wait record) is in test/pipeline-wait.test.js.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseBundle } from "../lib/pipeline-bundle.js";
import { nextStageOf } from "../lib/task-pipeline-drive.js";

const DOC = JSON.parse(readFileSync(new URL("../pipeline-bundle.seed.json", import.meta.url), "utf8"));
const PARSED = parseBundle(DOC, { file: "pipeline-bundle.seed.json" });
assert.equal(PARSED.ok, true, PARSED.reason || "the shipped seed must parse");
const LOOP = PARSED.bundle.pipelines.find((pipeline) => pipeline.id === "sefl-review-loop");
assert.ok(LOOP, "the review loop ships in the PDL bundle");

const T0 = Date.parse("2026-11-03T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const HEAD = "a".repeat(40);

// The observation `readReviewExit` reads, in the shape lib/pipelines.js normalises a host payload to.
const observation = ({ comment = null, approved = false } = {}) => ({
  ok: true,
  pr: {
    number: 7,
    state: "OPEN",
    headRefOid: HEAD,
    reviewers: [],
    comments: comment ? [{ at: comment, by: "rev" }] : [],
    approvals: approved ? [{ commit: HEAD, at: iso(T0), by: "rev" }] : [],
  },
});

// The driver's own walk, one `nextStageOf` per step, with the review fact supplied the way the timer supplies it: at a
// `wait` visit, an observation and that wait's lastSeen. The crossings are kept on the record, so a loop is bounded
// here exactly as it is on a live row.
function walk(from, { reviews = null, steps = 40 } = {}) {
  const record = { stage: from, crossings: {} };
  const hops = [];
  const visits = [from];
  let next = 0;
  for (let step = 0; step < steps; step += 1) {
    const review = reviews && record.stage === "wait" ? reviews[next] || null : null;
    const answer = nextStageOf(LOOP, record, { review });
    if (!answer.ok) return { hops, visits, stopped: answer, record };
    if (answer.done) return { hops, visits, done: answer, record };
    if (answer.handoff && answer.handoff.kind === "loop") {
      record.crossings[answer.handoff.id] = (record.crossings[answer.handoff.id] || 0) + 1;
    }
    hops.push({ from: record.stage, to: answer.stage.id, edge: answer.handoff ? answer.handoff.id : null });
    record.stage = answer.stage.id;
    visits.push(record.stage);
    if (review) next += 1;
  }
  throw new Error(`the walk from ${from} did not settle in ${steps} steps`);
}

test("with no comment the shipped loop walks branch, push, pr, wait, approve, merge - no stage skipped", () => {
  const walked = walk("branch");
  assert.deepEqual(walked.hops.map((hop) => `${hop.from}->${hop.to} ${hop.edge}`), [
    "branch->push H-01",
    "push->pr H-02",
    "pr->wait H-03",
    "wait->approve H-06",
    "approve->merge H-07",
  ]);
  assert.deepEqual(walked.visits, ["branch", "push", "pr", "wait", "approve", "merge"], "all six, in the document's order");
  assert.ok(walked.done, "the merge stage is the end of the document");
  assert.equal(walked.record.crossings["H-04"], undefined, "and the answer edge is not taken on an empty review");
});

test("a comment newer than lastSeen enters address after wait, returns to wait, and only then reaches approve", () => {
  const reviewed = walk("branch", {
    reviews: [
      { observation: observation({ comment: iso(T0 + HOUR / 2) }), lastSeen: iso(T0) },
      { observation: observation({ approved: true }), lastSeen: iso(T0 + HOUR / 2) },
    ],
  });
  assert.deepEqual(reviewed.hops.map((hop) => `${hop.from}->${hop.to} ${hop.edge}`), [
    "branch->push H-01",
    "push->pr H-02",
    "pr->wait H-03",
    "wait->address H-04",
    "address->wait H-05",
    "wait->approve H-06",
    "approve->merge H-07",
  ]);
  assert.deepEqual(
    reviewed.visits,
    ["branch", "push", "pr", "wait", "address", "wait", "approve", "merge"],
    "address is entered BEFORE approve, and every stage of the document is still visited",
  );
  assert.equal(reviewed.record.crossings["H-04"], 1);
  assert.ok(reviewed.done);
});

test("an older comment or no observation leaves the rail alone: answer is not invented", () => {
  const older = walk("branch", {
    reviews: [{ observation: observation({ comment: iso(T0 - HOUR) }), lastSeen: iso(T0) }],
  });
  assert.equal(older.hops.find((hop) => hop.from === "wait").to, "approve", "a comment at or before lastSeen is not new");

  const unreadable = walk("branch", {
    reviews: [{ observation: { ok: false, why: "HTTP 503 from the host" }, lastSeen: iso(T0) }],
  });
  assert.equal(unreadable.hops.find((hop) => hop.from === "wait").to, "approve", "fail-closed: a host that cannot be read does not route to the answer stage");
});

test("H-04 is crossed at most three times, and the fourth comment stops the walk at the cap", () => {
  const reviews = [1, 2, 3, 4].map((n) => ({
    observation: observation({ comment: iso(T0 + n * HOUR) }),
    lastSeen: iso(T0 + (n - 1) * HOUR),
  }));
  const walked = walk("branch", { reviews });
  const crossings = walked.hops.filter((hop) => hop.edge === "H-04");
  assert.equal(crossings.length, 3, "three rounds, the cap the document draws");
  assert.equal(walked.stopped.code, "pipeline-cap");
  assert.equal(walked.stopped.handoff.id, "H-04");
  assert.equal(walked.stopped.used, 3);
  assert.equal(walked.stopped.limit, 3);
  assert.match(walked.stopped.reason, /at its cap of 3 rounds/);
  assert.equal(walked.record.stage, "wait", "the row stops on wait, for a person, rather than looping again");
});
