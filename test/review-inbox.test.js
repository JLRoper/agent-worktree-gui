// The REVIEW LANE's backend half: the delivery inferred at a run's close, and the state one word per delivery.
//
// The lane exists because a finished result that a reader has to remember is a result nobody checks. Its contract,
// and what this file pins:
//
//   1. the PARSE, from the run's own last words and the row's close reason (§`parseDelivery`):
//        · one `docs/reports/*.html` path becomes the anchor - and when several are named the FIRST wins;
//        · a delivery with no report path and no next steps still records, with both absent;
//        · the lines under a "Next steps" heading become the chips, capped at four;
//        · the panel's own marker lines (TODO/DELIVER/RELEASE) are never the summary;
//   2. the STATE MACHINE: recorded => awaiting, reviewed => not, a repeated press changes nothing, a NEWER delivery
//      clears an older reviewed stamp, a close that leaves nothing to check leaves the entry exactly as it was;
//   3. the COUNT: awaiting entries only, so the header badge cannot claim work that was already checked;
//   4. the STORE: a restart reads it back, a corrupt file is not fatal, a failed write is reported rather than
//      thrown, and a row that stops being a row takes its delivery with it;
//   5. the SETTLE SEAM on a bare `Jobs` prototype - the shape test/deliverables.test.js and test/release-request.test.js
//      use - including the unanswered case: the run is untouched by a reader who never presses Reviewed.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Off this box's own Hermes install: importing lib/jobs.js must not read the reader's state.
process.env.HERMES_HOME = mkdtempSync(path.join(tmpdir(), "wtgui-review-home-"));
process.env.API_SERVER_KEY = "";

const { Jobs } = await import("../lib/jobs.js");
const {
  REVIEW_KEEP,
  REVIEW_NEXT_CAP,
  ReviewInbox,
  closeReason,
  findNextSteps,
  findReports,
  firstLine,
  normReviewPath,
  parseDelivery,
  reviewKey,
} = await import("../lib/review-inbox.js");

const TREE = "C:/ProjectDevelopment/agent-worktree-gui/.worktrees/lane-fixture-a1b2c3";

function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-review-"));
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* a Windows handle on the directory; the OS temp is throwaway */
    }
  });
  return dir;
}

const store = (t, dir, now = () => Date.parse("2026-11-18T12:00:00.000Z")) =>
  new ReviewInbox({ file: path.join(dir, "reviews.json"), log: () => {}, now });

// ---- 1. the parse -------------------------------------------------------------------------------------------

test("the report anchor is the first docs/reports path the run named", () => {
  const text = ["Done - the audit is written.", "Read it: docs/reports/turnover-audit.html", "Also docs/reports/appendix.html"].join("\n");
  assert.deepEqual(findReports(text), ["docs/reports/turnover-audit.html", "docs/reports/appendix.html"]);
  const d = parseDelivery({ text });
  assert.equal(d.report, "docs/reports/turnover-audit.html");
  assert.deepEqual(d.reports, ["docs/reports/turnover-audit.html", "docs/reports/appendix.html"]);
  assert.equal(d.summary, "Done - the audit is written.");
});

test("several reports: the first is the anchor and the order is the run's own", () => {
  const text = "report at `docs/reports/b.html`, earlier at docs/reports/a.html, absolute C:/work/docs/reports/c.html";
  assert.deepEqual(findReports(text), ["docs/reports/b.html", "docs/reports/a.html", "C:/work/docs/reports/c.html"]);
  assert.equal(parseDelivery({ text }).report, "docs/reports/b.html");
  // A backslash path is the same file, said the way Windows says it.
  assert.deepEqual(findReports("see docs\\reports\\win.html"), ["docs/reports/win.html"]);
});

test("no report path and no next steps still records - a summary and nothing else", () => {
  const d = parseDelivery({ text: "Rebuilt the fixture repo and left the tree clean." });
  assert.equal(d.report, null);
  assert.deepEqual(d.reports, []);
  assert.deepEqual(d.next, []);
  assert.equal(d.summary, "Rebuilt the fixture repo and left the tree clean.");
});

test("next steps come from under the heading, capped at four, checkboxes stripped", () => {
  const text = [
    "Landed the lane and proved the marker.",
    "",
    "## Next steps",
    "- [ ] open the report and check the counts",
    "* decide whether the amber mark is too close to the lock",
    "3. move the chips under the anchor",
    "+ ask the reader about the rotation order",
    "- this fifth line is dropped, the lane shows four",
    "",
    "## Notes",
    "not a step",
  ].join("\n");
  const next = findNextSteps(text);
  assert.equal(next.length, REVIEW_NEXT_CAP);
  assert.deepEqual(next, [
    "open the report and check the counts",
    "decide whether the amber mark is too close to the lock",
    "move the chips under the anchor",
    "ask the reader about the rotation order",
  ]);
  assert.deepEqual(parseDelivery({ text }).next, next);
});

test("a heading with no bullets is no next steps, and a plain sentence is not a chip", () => {
  assert.deepEqual(findNextSteps("Next steps\nnothing here"), []);
  assert.deepEqual(findNextSteps("Next steps: read it then close the row"), []);
  assert.deepEqual(findNextSteps("Next steps\n\n- one\n\ntrailing prose\n- never reached"), ["one"]);
});

test("the panel's own marker lines are never the summary", () => {
  const text = ["TODO DONE 4", "TODO DONE 5", "RELEASE C:/tree | merged", "DELIVER file docs/reports/x.html | the report", "The lane is landed and green."].join("\n");
  assert.equal(firstLine(text), "The lane is landed and green.");
  assert.equal(parseDelivery({ text }).summary, "The lane is landed and green.");
});

test("an empty final message falls back to the close reason, and says that it did", () => {
  assert.equal(closeReason({ status: "done", outcome: { word: "done" } }), "done");
  assert.equal(closeReason({ status: "failed", outcome: { word: "failed", reason: "exit 3" } }), "failed - exit 3");
  const d = parseDelivery({ text: "   ", reason: "failed - exit 3" });
  assert.equal(d.summary, "failed - exit 3");
  assert.equal(d.from, "the row's close reason");
  // Nothing at all is nothing to check: a run that left no word gets no marker.
  assert.equal(parseDelivery({ text: "", reason: "" }), null);
});

test("a long summary and a long step are clipped, not wrapped", () => {
  const d = parseDelivery({ text: `${"x".repeat(400)}\nNext steps\n- ${"y".repeat(400)}` });
  assert.ok(d.summary.length <= 220, `summary is ${d.summary.length}`);
  assert.ok(d.next[0].length <= 160, `step is ${d.next[0].length}`);
});

// ---- 2. the state machine ------------------------------------------------------------------------------------

test("recorded is awaiting, reviewed is not, and a second press changes nothing", (t) => {
  const dir = sandbox(t);
  const inbox = store(t, dir);
  const rec = inbox.record({ project: "proj", path: TREE, runId: "abc123", text: "Fixed the flaky test.\nNext steps\n- rerun the suite" });
  assert.equal(rec.saved, true);
  assert.equal(inbox.count(), 1);
  const row = inbox.forRow("proj", TREE);
  assert.equal(row.awaiting, true);
  assert.equal(row.summary, "Fixed the flaky test.");
  assert.deepEqual(row.next, ["rerun the suite"]);

  const first = inbox.markReviewed({ project: "proj", path: TREE, by: "reader" });
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.equal(inbox.count(), 0);
  const after = inbox.forRow("proj", TREE);
  assert.equal(after.awaiting, false);
  assert.ok(after.reviewedAt, "the stamp is the record of the check");
  assert.equal(after.summary, "Fixed the flaky test.", "reviewing keeps the delivery readable");

  const again = inbox.markReviewed({ path: TREE });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false, "a second press is an answer, not an error");
  assert.equal(inbox.forRow("proj", TREE).reviewedAt, after.reviewedAt, "and it does not move the stamp");
});

test("a newer delivery replaces the entry and clears the reviewed stamp", (t) => {
  const dir = sandbox(t);
  const inbox = store(t, dir);
  inbox.record({ path: TREE, text: "first result" });
  inbox.markReviewed({ path: TREE });
  assert.equal(inbox.count(), 0);
  inbox.record({ path: TREE, text: "second result" });
  assert.equal(inbox.count(), 1, "the thing to check is the new result, not the old one");
  const row = inbox.forRow(null, TREE);
  assert.equal(row.summary, "second result");
  assert.equal(row.reviewedAt, null);
});

test("a close that leaves nothing to check leaves the entry exactly as it was", (t) => {
  const dir = sandbox(t);
  const inbox = store(t, dir);
  inbox.record({ path: TREE, text: "a result worth checking" });
  inbox.markReviewed({ path: TREE });
  const before = inbox.forRow(null, TREE);
  const none = inbox.record({ path: TREE, text: "", reason: "" });
  assert.equal(none.saved, false);
  assert.equal(none.skipped, "nothing to check");
  assert.deepEqual(inbox.forRow(null, TREE), before, "a chat turn with no final word cannot take the record away");
  assert.equal(inbox.count(), 0, "and cannot make a reviewed row amber again");
});

test("a delivery needs a tree: no path records nothing and says so", (t) => {
  const dir = sandbox(t);
  const inbox = store(t, dir);
  const r = inbox.record({ project: "proj", path: "", text: "a result" });
  assert.equal(r.saved, false);
  assert.equal(r.skipped, "no row");
  assert.equal(inbox.count(), 0);
  assert.equal(inbox.markReviewed({ path: "" }).ok, false);
  assert.match(inbox.markReviewed({ path: "" }).error, /worktree is required/);
});

test("mark all reviewed stamps every awaiting entry in one write", (t) => {
  const dir = sandbox(t);
  const inbox = store(t, dir);
  inbox.record({ path: `${TREE}-a`, text: "one" });
  inbox.record({ path: `${TREE}-b`, text: "two" });
  inbox.record({ path: `${TREE}-c`, text: "three" });
  inbox.markReviewed({ path: `${TREE}-b` });
  const all = inbox.markAll({ by: "reader" });
  assert.equal(all.ok, true);
  assert.equal(all.changed, 2, "the reviewed one is not re-stamped");
  assert.equal(inbox.count(), 0);
  const state = inbox.state();
  assert.equal(state.count, 0);
  assert.equal(state.total, 3);
  assert.equal(new Set(state.entries.map((e) => e.reviewedAt)).size, 1, "one stamp for the set");
  assert.equal(inbox.markAll().changed, 0, "a second bulk press is a no-op");
});

// ---- 3. the count --------------------------------------------------------------------------------------------

test("the count is awaiting entries only, and the state carries the split", (t) => {
  const dir = sandbox(t);
  const inbox = store(t, dir);
  assert.equal(inbox.count(), 0);
  inbox.record({ path: `${TREE}-a`, text: "one" });
  inbox.record({ path: `${TREE}-b`, text: "two" });
  assert.equal(inbox.count(), 2);
  inbox.markReviewed({ path: `${TREE}-a` });
  assert.equal(inbox.count(), 1);
  const state = inbox.state();
  assert.equal(state.count, 1);
  assert.equal(state.total, 2);
  assert.deepEqual(state.entries.map((e) => e.awaiting).sort(), [false, true]);
});

test("the key is the tree path, normalised, so two spellings of one tree are one delivery", () => {
  assert.equal(normReviewPath("C:\\Work\\Tree\\"), "c:/work/tree");
  assert.equal(reviewKey("proj", "C:\\Work\\Tree\\"), reviewKey("other-project", "c:/work/tree"));
  assert.equal(reviewKey("proj", ""), null);
  assert.equal(reviewKey("proj", "   "), null);
});

// ---- 4. the store --------------------------------------------------------------------------------------------

test("a restart reads the record back, reviewed stamp and all", (t) => {
  const dir = sandbox(t);
  const one = store(t, dir);
  one.record({ path: TREE, text: "the result", runId: "run-1", thread: "lane-thread" });
  one.markReviewed({ path: TREE });
  const two = store(t, dir);
  const row = two.forRow(null, TREE);
  assert.equal(row.summary, "the result");
  assert.equal(row.runId, "run-1");
  assert.equal(row.thread, "lane-thread");
  assert.equal(row.awaiting, false);
  assert.ok(row.reviewedAt);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "reviews.json"), "utf8")).version, 1);
});

test("a corrupt file is not fatal: the lane starts empty and says so", (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, "reviews.json");
  writeFileSync(file, "{ this is not json", "utf8");
  const said = [];
  const inbox = new ReviewInbox({ file, log: (m) => said.push(m), now: () => Date.parse("2026-11-18T12:00:00Z") });
  assert.equal(inbox.count(), 0);
  assert.match(said.join("\n"), /could not read/);
  // …and it can still be written over, so a corrupt read never blocks the lane.
  assert.equal(inbox.record({ path: TREE, text: "a result" }).saved, true);
});

test("a delivery that cannot be written is reported, never thrown, and stays readable in this process", (t) => {
  const dir = sandbox(t);
  // A directory where the file should be: the write cannot land.
  const file = path.join(dir, "reviews.json");
  mkdirSync(file, { recursive: true });
  const inbox = new ReviewInbox({ file, log: () => {}, now: () => Date.parse("2026-11-18T12:00:00Z") });
  const rec = inbox.record({ path: TREE, text: "a result" });
  assert.equal(rec.saved, false);
  assert.ok(rec.error, "the failure is named");
  assert.equal(inbox.forRow(null, TREE).summary, "a result", "the entry stands for this process");
});

test("the store keeps the newest entries and forgets the oldest", (t) => {
  const dir = sandbox(t);
  let clock = Date.parse("2026-11-01T00:00:00Z");
  const inbox = new ReviewInbox({ file: path.join(dir, "reviews.json"), log: () => {}, now: () => (clock += 1000) });
  for (let i = 0; i < REVIEW_KEEP + 5; i += 1) inbox.record({ path: `${TREE}-${i}`, text: `result ${i}` });
  const raw = JSON.parse(readFileSync(path.join(dir, "reviews.json"), "utf8"));
  assert.equal(raw.entries.length, REVIEW_KEEP);
  assert.equal(raw.entries.at(-1).summary, `result ${REVIEW_KEEP + 4}`, "the newest is kept");
  assert.equal(raw.entries[0].summary, "result 5", "the oldest five are gone");
});

test("a row that stops being a row takes its delivery with it - and only that one", (t) => {
  const dir = sandbox(t);
  const inbox = store(t, dir);
  inbox.record({ path: `${TREE}-gone`, text: "a tree somebody deleted", at: "2026-11-18T06:00:00.000Z" });
  inbox.record({ path: `${TREE}-here`, text: "a tree that still stands" });
  // Nothing is swept: a delivery for a tree the scan has not reached yet is not a delivery for a tree that is gone.
  assert.equal(inbox.forget({ path: `${TREE}-never-seen` }).removed, 0);
  assert.equal(inbox.state().total, 2);
  // A drop names its row, so exactly that row's delivery goes - the other one is untouched, reviewed or not.
  const r = inbox.forget({ project: "proj", path: `${TREE}-gone` });
  assert.equal(r.removed, 1);
  assert.equal(inbox.forRow(null, `${TREE}-gone`), null);
  assert.ok(inbox.forRow(null, `${TREE}-here`));
  // A second drop for the same tree is a no-op rather than an error, because two scans can both report it.
  assert.equal(inbox.forget({ path: `${TREE}-gone` }).removed, 0);
  assert.equal(inbox.state().total, 1);
});

// ---- 5. the settle seam --------------------------------------------------------------------------------------
// A bare prototype, the shape test/deliverables.test.js uses: the seam is what is under test, not the whole engine.

function bareJobs(inbox) {
  const jobs = Object.create(Jobs.prototype);
  jobs.reviewInbox = inbox;
  jobs.pushed = [];
  jobs.push = (j, line) => jobs.pushed.push(line);
  return jobs;
}

test("harvestReview records the run's delivery once, and pushes the panel's own line", (t) => {
  const dir = sandbox(t);
  const inbox = store(t, dir);
  const jobs = bareJobs(inbox);
  const j = {
    id: "run7",
    thread: "lane-thread",
    project: "agent-worktree-gui",
    finalMessage: "The lane is built.\n\nThe report is docs/reports/review-lane.html\n\nNext steps\n- open the report\n- press Reviewed",
    status: "done",
    outcome: { word: "done" },
    endedAt: "2026-11-18T12:00:00.000Z",
  };
  const tree = { path: TREE };
  const first = jobs.harvestReview(j, tree);
  assert.equal(first.saved, true);
  assert.equal(j.reviewHarvested, true);
  const row = inbox.forRow("agent-worktree-gui", TREE);
  assert.equal(row.report, "docs/reports/review-lane.html");
  assert.deepEqual(row.next, ["open the report", "press Reviewed"]);
  const line = jobs.pushed.find((l) => l.kind === "dim");
  assert.match(line.text, /result ready for review/);
  // A second pass does not record a second delivery.
  const again = jobs.harvestReview(j, tree);
  assert.equal(again, null);
  assert.equal(jobs.pushed.filter((l) => l.kind === "dim").length, 1);
});

test("an unanswered card costs the run nothing: the row stays amber and counted", (t) => {
  const dir = sandbox(t);
  const inbox = store(t, dir);
  const jobs = bareJobs(inbox);
  const j = { id: "run8", finalMessage: "A result nobody looked at.", status: "done" };
  const before = JSON.stringify({ status: j.status, lines: j.lines });
  jobs.harvestReview(j, { path: TREE });
  assert.equal(inbox.count(), 1, "the lane holds it");
  // Nothing about the run waited on the card: no throw, no pending state, no line the run depends on.
  assert.equal(JSON.stringify({ status: j.status, lines: j.lines }), before, "the run record is untouched");
  assert.equal(inbox.forRow(null, TREE).awaiting, true);
});

test("a run with no final word and no reason records nothing at all", (t) => {
  const dir = sandbox(t);
  const inbox = store(t, dir);
  const jobs = bareJobs(inbox);
  const j = { id: "run9", finalMessage: "", status: "" };
  const out = jobs.harvestReview(j, { path: TREE });
  assert.equal(out.saved, false);
  assert.equal(out.skipped, "nothing to check");
  assert.equal(inbox.count(), 0);
  assert.equal(jobs.pushed.length, 0, "and nothing is said that the reader has to dismiss");
});

test("a run measured before its tree exists is not marked, so its real close still records", (t) => {
  const dir = sandbox(t);
  const inbox = store(t, dir);
  const jobs = bareJobs(inbox);
  const j = { id: "run10", finalMessage: "work in progress", status: "running", worktreePath: null };
  assert.equal(jobs.harvestReview(j, null), null);
  assert.equal(j.reviewHarvested, undefined, "the mark is left unset");
  // The close, when the tree is known.
  const later = jobs.harvestReview({ ...j, status: "done" }, { path: TREE });
  assert.equal(later.saved, true);
  assert.equal(inbox.count(), 1);
});

test("a store that cannot write says so on the run, and the read stays honest", (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, "reviews.json");
  mkdirSync(file, { recursive: true });
  const inbox = new ReviewInbox({ file, log: () => {}, now: () => Date.parse("2026-11-18T12:00:00Z") });
  const jobs = bareJobs(inbox);
  const out = jobs.harvestReview({ id: "run11", finalMessage: "a result", status: "done" }, { path: TREE });
  assert.equal(out.saved, false);
  assert.match(jobs.pushed.at(-1).text, /the delivery was NOT recorded/);
  assert.ok(inbox.forRow(null, TREE), "the in-process record still answers");
});
