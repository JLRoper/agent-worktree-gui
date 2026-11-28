// The LANE: the file a row claims is held by another LIVE job's row. Row 293's defect, pinned four ways.
//
// The defect: the digest derives a lane at read time and prints
//   SKIP: files in use by #286 ... waiting on #286 (lane public/style.css)
// while the cut ran lib/spawn-check.js through lib/assistant.js and refused only a ROW with a live worker or a TREE a
// live run stood in. A shared file was neither, so GET /api/assistant/spawn-check answered ok:true for a row the digest
// was printing SKIP for, and on 2026-11-24 two workers reached public/style.css because of it.
//
// What this file pins:
//
//   1. with a live job holding a file, the pre-flight refuses that file's next row and names the holder, the file and
//      the row;
//   2. a SPAWN attempted anyway is refused by the CUT in the same words, and nothing is cut;
//   3. a row on a DIFFERENT file still starts;
//   4. after the holder settles the row starts normally;
//   5. the digest's SKIP and the cut's refusal are ONE sentence: `SKIP: ` + the exact message the cut throws;
//   6. an explicit, recorded exception allows the overlap and says who allowed it and which file - and it is the only
//      way past the lane, one holder and one file at a time;
//   7. EVERY claimed file is in the lane, not the row's head file (queue row 483): two rows whose shared files are
//      BEHIND both heads are still one lane, the second is refused BY NAME with the shared file named, nothing is cut,
//      and the refusal raises the card row 419 added.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Jobs } from "../lib/jobs.js";
import { Assistant } from "../lib/assistant.js";
import { SPAWN_CHECK_PATH, createSpawnCheckRoutes } from "../routes/assistant-spawn-check.js";

const slash = (p) => String(p).replace(/\\/g, "/");

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-spawn-lane-"));
  const checkout = slash(path.join(dir, "checkout"));
  const held = slash(path.join(dir, "checkout", ".worktrees", "held-tree"));
  const free = slash(path.join(dir, "checkout", ".worktrees", "free-tree"));
  for (const at of [checkout, held, free]) mkdirSync(at, { recursive: true });
  writeFileSync(path.join(held, "README.md"), "held\n");
  writeFileSync(path.join(free, "README.md"), "free\n");
  const project = { name: "proj", path: checkout, mainBranch: "main" };
  const config = { jobsFile: path.join(dir, "jobs.json"), defaultCwd: dir };
  const jobs = new Jobs({ config, onEvent: () => {}, onLog: () => {} });
  const assistant = new Assistant({
    config: { ...config, assistantFile: path.join(dir, "assistant.json") },
    jobs,
    getProjects: () => [project],
    getRows: () => [],
    getChildren: () => ({}),
    onEvent: () => {},
    onLog: () => {},
  });
  t.after(() => {
    for (const timer of ["wakeTimer", "settleTimer", "timer", "persistTimer"]) if (assistant[timer]) clearTimeout(assistant[timer]);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return { dir, project, jobs, assistant, held, free, checkout };
}

async function ask(p, { task = "", tree = "", project = "proj", assistantId = "" } = {}) {
  const out = { status: null, body: null };
  const handler = createSpawnCheckRoutes({
    assistant: p.assistant,
    getProjects: () => [p.project],
    config: { token: "tok-test-alpha" },
    sendJson: (res, status, body) => {
      out.status = status;
      out.body = body;
    },
    authorised: (req, token) => req.headers["x-panel-token"] === token,
  });
  const query = new URLSearchParams();
  if (task) query.set("task", String(task));
  if (tree) query.set("tree", tree);
  if (project) query.set("project", project);
  if (assistantId) query.set("assistantId", assistantId);
  const url = new URL(`http://localhost${SPAWN_CHECK_PATH}${query.toString() ? `?${query}` : ""}`);
  await handler({ method: "GET", headers: { "x-panel-token": "tok-test-alpha" } }, {}, SPAWN_CHECK_PATH, url);
  return out;
}

// A live run on a row: the row names the run, and the store holds it. `status` is what the settle changes.
function standRun(p, { rowId, jobId, runId, thread, tree = p.held, status = "running" }) {
  p.assistant.queueMutate("assistant-1", "edit", { id: rowId, runId });
  p.jobs.jobs.set(jobId, {
    id: jobId,
    runId,
    thread,
    status,
    cwd: tree,
    prompt: "a run standing on a file",
    lines: [],
    origin: { kind: "assistant-spawn" },
  });
}

function queue(p, { title, files, thread = null }) {
  return p.assistant.queueMutate("assistant-1", "add", { title, files, ...(thread ? { thread } : {}) }).task;
}

function running(p, id) {
  p.assistant.queueMutate("assistant-1", "state", { id, state: "running" });
}

// The spawner the CUT calls. If a refusal is right, this is never reached; if the row starts, it answers a run.
function spawned(p) {
  const calls = [];
  p.assistant.spawner = async (spec) => {
    calls.push(spec);
    return { id: `job-new-${calls.length}`, thread: `t-new-${calls.length}`, cwd: p.free, status: "running", lines: [] };
  };
  return calls;
}

const sentence = (body) => `${body.reason}. ${body.remedy}.`;

test("the pre-flight refuses the next row on a file a live job holds, naming holder, file and row", async (t) => {
  const p = fixture(t);
  const holder = queue(p, { title: "the rule change", files: ["public/style.css"], thread: "t-holder" });
  running(p, holder.id);
  standRun(p, { rowId: holder.id, jobId: "job-holder", runId: "run_holder", thread: "t-holder" });
  const next = queue(p, { title: "the same rule, next", files: ["public/style.css"] });

  const out = await ask(p, { task: next.id });
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, false, "the digest says SKIP for this row, so the pre-flight cannot say ok");
  assert.equal(out.body.checks[0].check, "lane");
  assert.equal(out.body.checks[0].code, "file_busy");
  assert.match(out.body.reason, new RegExp(`files in use by #${holder.id} \\(job run_holder on thread t-holder, running\\)`), "the holder and its run are named");
  assert.match(out.body.reason, /public\/style\.css/, "the file is named");
  assert.match(out.body.reason, new RegExp(`#${next.id} also claims`), "the row being started is named");
  assert.match(out.body.remedy, /queue action allow-overlap/, "the remedy names the recorded way past the lane");
});

test("a SPAWN attempted anyway is refused by the cut in the same words, and nothing is cut", async (t) => {
  const p = fixture(t);
  const holder = queue(p, { title: "the rule change", files: ["public/style.css"], thread: "t-holder" });
  running(p, holder.id);
  standRun(p, { rowId: holder.id, jobId: "job-holder", runId: "run_holder", thread: "t-holder" });
  const next = queue(p, { title: "the same rule, next", files: ["public/style.css"] });
  const before = await ask(p, { task: next.id });
  const calls = spawned(p);

  await assert.rejects(
    () => p.assistant.startSpawn({ prompt: "the same rule, next", taskId: next.id, existing: true, target: p.free, project: "proj", assistantId: "assistant-1" }),
    (err) => {
      assert.equal(err.code, "spawn-task");
      assert.equal(err.message, sentence(before.body), "the cut throws the pre-flight's sentence, word for word");
      return true;
    },
  );
  assert.equal(calls.length, 0, "no spawner ran");
  assert.equal(p.assistant.queueView("assistant-1").tasks.find((x) => x.id === next.id).state, "queued", "the row was not moved");
});

test("a row on a DIFFERENT file still starts while the holder is live", async (t) => {
  const p = fixture(t);
  const holder = queue(p, { title: "the rule change", files: ["public/style.css"], thread: "t-holder" });
  running(p, holder.id);
  standRun(p, { rowId: holder.id, jobId: "job-holder", runId: "run_holder", thread: "t-holder" });
  const other = queue(p, { title: "a different file", files: ["lib/other.js"] });

  const out = await ask(p, { task: other.id });
  assert.equal(out.body.ok, true, "a disjoint file is not in the lane");
  const calls = spawned(p);
  const job = await p.assistant.startSpawn({ prompt: "a different file", taskId: other.id, existing: true, target: p.free, project: "proj", assistantId: "assistant-1" });
  assert.equal(calls.length, 1, "the cut reached the spawner");
  assert.equal(job.id, "job-new-1");
  assert.equal(p.assistant.queueView("assistant-1").tasks.find((x) => x.id === other.id).thread, "t-new-1", "and the row was linked to the run");
});

test("after the holder settles the row starts normally", async (t) => {
  const p = fixture(t);
  const holder = queue(p, { title: "the rule change", files: ["public/style.css"], thread: "t-holder" });
  running(p, holder.id);
  standRun(p, { rowId: holder.id, jobId: "job-holder", runId: "run_holder", thread: "t-holder" });
  const next = queue(p, { title: "the same rule, next", files: ["public/style.css"] });
  assert.equal((await ask(p, { task: next.id })).body.ok, false);

  // The holder's run ends: the job is no longer live, so the row is STALE and it holds nothing. The row's state word
  // still says running (the panel does not rewrite it on a read), which is exactly the case the lane must not treat as
  // a hold - the same line the digest draws between LIVE and STALE.
  const job = p.jobs.jobs.get("job-holder");
  p.jobs.jobs.set("job-holder", { ...job, status: "done", endedAt: "2026-11-24T10:40:00.000Z" });

  const after = await ask(p, { task: next.id });
  assert.equal(after.body.ok, true, "the holder settled, so the row may start");
  assert.deepEqual(after.body.checks, []);
  const calls = spawned(p);
  const started = await p.assistant.startSpawn({ prompt: "the same rule, next", taskId: next.id, existing: true, target: p.free, project: "proj", assistantId: "assistant-1" });
  assert.equal(calls.length, 1, "the cut reached the spawner");
  assert.equal(started.id, "job-new-1");
});

test("the digest's SKIP and the cut's refusal are one sentence for the same pair", async (t) => {
  const p = fixture(t);
  const holder = queue(p, { title: "the rule change", files: ["public/style.css"], thread: "t-holder" });
  running(p, holder.id);
  standRun(p, { rowId: holder.id, jobId: "job-holder", runId: "run_holder", thread: "t-holder" });
  const next = queue(p, { title: "the same rule, next", files: ["public/style.css"] });

  const view = p.assistant.queueView("assistant-1");
  const line = view.digest.find((l) => l.includes(`#${next.id} queued`));
  assert.ok(line, "the row is in the digest");
  const cut = p.assistant.spawnTaskRefusal("assistant-1", next.id);
  assert.ok(cut, "the cut refuses the same row");
  assert.ok(line.includes(`SKIP: ${cut}`), `the digest prints the cut's sentence verbatim:\n${line}\n${cut}`);
  const pre = await ask(p, { task: next.id });
  assert.equal(pre.body.ok, false, "the pre-flight agrees with both");
  assert.equal(sentence(pre.body), cut, "and the pre-flight's reason+remedy is the same sentence");
});

test("a recorded exception allows the overlap, says who allowed it and which file, and starts the row", async (t) => {
  const p = fixture(t);
  const holder = queue(p, { title: "the rule change", files: ["public/style.css"], thread: "t-holder" });
  running(p, holder.id);
  standRun(p, { rowId: holder.id, jobId: "job-holder", runId: "run_holder", thread: "t-holder" });
  const next = queue(p, { title: "the same rule, next", files: ["public/style.css"] });

  const allowed = p.assistant.queueMutate("assistant-1", "allow-overlap", {
    id: next.id,
    file: "public/style.css",
    by: "reader",
    reason: "both rows are one edit to the same rule",
  });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  const record = allowed.task.laneAllow[0];
  assert.equal(record.file, "public/style.css");
  assert.equal(record.holder, holder.id, "the decision names the holder it was made about");
  assert.equal(record.by, "reader", "and who allowed it");
  assert.ok(record.at, "with a timestamp");
  assert.match(record.reason, /one edit to the same rule/);
  // Written to the file, not only answered: the schema carries it back on the next read.
  assert.deepEqual(p.assistant.queueView("assistant-1").tasks.find((x) => x.id === next.id).laneAllow.map((a) => [a.file, a.holder, a.by]), [["public/style.css", holder.id, "reader"]]);

  const pre = await ask(p, { task: next.id });
  assert.equal(pre.body.ok, true, "an allowed overlap is not a refusal");
  assert.equal(pre.body.checks[0].code, "lane_allowed");
  assert.equal(pre.body.checks[0].allowed, true);
  assert.match(pre.body.reason, /allowed by reader/);
  assert.match(pre.body.reason, /public\/style\.css/);

  const view = p.assistant.queueView("assistant-1");
  const line = view.digest.find((l) => l.includes(`#${next.id} queued`));
  assert.ok(!line.includes("SKIP"), `an allowed overlap is not a SKIP:\n${line}`);
  assert.match(line, /LANE ALLOWED by reader on public\/style\.css \(overlaps #\d+\)/, line);

  const calls = spawned(p);
  const job = await p.assistant.startSpawn({ prompt: "the same rule, next", taskId: next.id, existing: true, target: p.free, project: "proj", assistantId: "assistant-1" });
  assert.equal(calls.length, 1, "the cut carried the allowed row");
  assert.equal(job.id, "job-new-1");
  // The cut left the decision in the journal too, so the waiver is in the record the next turn reads.
  assert.ok(p.assistant.journal.some((entry) => String(entry.kind || "").includes("spawn-overlap")), "the allowed overlap was journalled at the cut");
});

test("an exception covers ONE holder and ONE file: another holder on the same file is still refused", async (t) => {
  const p = fixture(t);
  const holder = queue(p, { title: "the rule change", files: ["public/style.css"], thread: "t-holder" });
  running(p, holder.id);
  standRun(p, { rowId: holder.id, jobId: "job-holder", runId: "run_holder", thread: "t-holder" });
  const next = queue(p, { title: "the same rule, next", files: ["public/style.css"] });
  p.assistant.queueMutate("assistant-1", "allow-overlap", { id: next.id, file: "public/style.css", by: "reader" });
  assert.equal((await ask(p, { task: next.id })).body.ok, true);

  // A SECOND live holder on the same file, which nobody decided about. The exception names #holder, so this overlap is
  // not covered: the record is a decision about a pair, not a blanket waiver on the file.
  const second = queue(p, { title: "a third row in the rule", files: ["public/style.css"], thread: "t-second" });
  running(p, second.id);
  standRun(p, { rowId: second.id, jobId: "job-second", runId: "run_second", thread: "t-second" });

  const out = await ask(p, { task: next.id });
  assert.equal(out.body.ok, false, "the unrecorded holder is still a hold");
  assert.equal(out.body.checks[0].code, "file_busy");
  assert.match(out.body.reason, new RegExp(`files in use by #${second.id} `));
});

test("clearing the exception puts the lane back, and an exception needs a file the row claims and a live holder", async (t) => {
  const p = fixture(t);
  const holder = queue(p, { title: "the rule change", files: ["public/style.css"], thread: "t-holder" });
  running(p, holder.id);
  standRun(p, { rowId: holder.id, jobId: "job-holder", runId: "run_holder", thread: "t-holder" });
  const next = queue(p, { title: "the same rule, next", files: ["public/style.css"] });

  // A file the row does not claim cannot be allowed: the exception would be about work this row is not doing.
  const wrong = p.assistant.queueMutate("assistant-1", "allow-overlap", { id: next.id, file: "lib/elsewhere.js", by: "reader" });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /does not claim lib\/elsewhere\.js/);

  p.assistant.queueMutate("assistant-1", "allow-overlap", { id: next.id, file: "public/style.css", by: "reader" });
  assert.equal((await ask(p, { task: next.id })).body.ok, true);
  const cleared = p.assistant.queueMutate("assistant-1", "allow-overlap", { id: next.id, file: "public/style.css", clear: true });
  assert.equal(cleared.ok, true);
  assert.deepEqual(cleared.task.laneAllow, []);
  assert.equal((await ask(p, { task: next.id })).body.ok, false, "without the record the cut refuses again");

  // And an exception with no live holder has nothing to allow: it is refused rather than stored for a later row nobody
  // decided about. The holder settles first.
  const job = p.jobs.jobs.get("job-holder");
  p.jobs.jobs.set("job-holder", { ...job, status: "done", endedAt: "2026-11-24T10:40:00.000Z" });
  const late = p.assistant.queueMutate("assistant-1", "allow-overlap", { id: next.id, file: "public/style.css", by: "reader" });
  assert.equal(late.ok, false);
  assert.match(late.error, /no live run holds public\/style\.css/);
});

// ---- 7. every claimed file, not the head file ---------------------------------------------------------------
//
// The measured defect (queue row 483): the lane was keyed to a row's head file, so a row claiming
// `public/app.js, public/index.html, public/console.css` passed on the first while a live peer held the other two, and
// the collision was filed as a notice after both had run. The rows here share public/index.html and public/console.css
// and NEITHER names either as its head - #1's head is public/app.js and #2's is docs/notes.md - so a head-only guard
// would answer ok, cut a second worker, and never name the file.
test("the lane covers EVERY claimed file: an overlap behind both rows' heads is refused by name, and the card says it", async (t) => {
  const p = fixture(t);
  const holder = queue(p, {
    title: "the live row",
    files: ["public/app.js", "public/index.html", "public/console.css"],
    thread: "t-holder",
  });
  running(p, holder.id);
  standRun(p, { rowId: holder.id, jobId: "job-holder", runId: "run_holder", thread: "t-holder" });
  const next = queue(p, { title: "the second row", files: ["docs/notes.md", "public/index.html", "public/console.css"] });
  assert.deepEqual(holder.files[0], "public/app.js");
  assert.deepEqual(next.files[0], "docs/notes.md", "neither row names a shared file as its head - the pair this lane used to miss");

  const pre = await ask(p, { task: next.id });
  assert.equal(pre.status, 200);
  assert.equal(pre.body.ok, false, "a shared file behind the head refuses the row, exactly as a head file does");
  const check = pre.body.checks[0];
  assert.equal(check.check, "lane");
  assert.equal(check.code, "file_busy");
  assert.deepEqual(
    [...check.files].sort(),
    ["public/console.css", "public/index.html"],
    "the refusal carries BOTH files the rows share, not only the first one it found",
  );
  assert.match(pre.body.reason, new RegExp(`files in use by #${holder.id} \\(job run_holder on thread t-holder, running\\)`), "the live holder is named");
  assert.match(pre.body.reason, new RegExp(`#${next.id} also claims`), "the row being refused is named");
  assert.match(pre.body.reason, /public\/index\.html/, "and the file that holds it is named");
  assert.match(pre.body.reason, /public\/console\.css/, "both of them, not the head of either row");
  assert.doesNotMatch(pre.body.reason, /docs\/notes\.md/, "the row's own head file is not what holds it");

  // The CUT refuses in the same words and cuts nothing - the pre-flight cannot be stricter than the line.
  const calls = spawned(p);
  await assert.rejects(
    () => p.assistant.startSpawn({ prompt: "the second row", taskId: next.id, existing: true, target: p.free, project: "proj", assistantId: "assistant-1" }),
    (err) => {
      assert.equal(err.code, "spawn-task");
      assert.equal(err.message, sentence(pre.body), "the cut throws the pre-flight's sentence, word for word");
      assert.match(err.message, /public\/index\.html/, "the refusal names the file it found");
      return true;
    },
  );
  assert.equal(calls.length, 0, "no spawner ran");
  assert.equal(p.assistant.queueView("assistant-1").tasks.find((x) => x.id === next.id).state, "queued", "the row was not moved");

  // THE CARD (queue row 419): the refusal is visible where the reader looks, and its evidence labels the row and the
  // reason - a refusal the reader never sees is the absence row 419 is about.
  const card = p.assistant.alerts.find((a) => a.rule === "spawn-refused" && a.status === "open" && Number(a.taskId) === next.id);
  assert.ok(card, "the lane refusal raised a card for this row");
  assert.match(card.title, new RegExp(`SPAWN refused: SPAWN IN #${next.id}`));
  assert.match(card.detail, /public\/index\.html/, "the card carries the file the rows collide on");
  assert.match(card.detail, /the fix: wait for job run_holder/, "and the remedy that unsticks it");
  assert.equal(card.evidence.find((e) => e.label === "row")?.value, `#${next.id}`);
  assert.equal(card.evidence.find((e) => e.label === "what happened")?.value, "nothing was cut: no tree, no job and no thread exist for this line");

  // And the ORDER agrees with the refusal: the row is in the holder's lane and waits on it by name, even though the
  // holder is not the head it named.
  const view = p.assistant.queueView("assistant-1");
  const row = view.tasks.find((x) => x.id === next.id);
  assert.equal(row.lane, "public/console.css", "one lane for two rows that share a file behind both heads, named by the file they share");
  assert.equal(row.laneHead, false);
  assert.equal(row.laneHeadId, holder.id, "the live holder heads it");
  assert.ok(row.waitingOn, "a live peer in the lane is a wait, not only a SKIP");
  assert.equal(row.waitingOn.id, holder.id);
  assert.equal(row.waitingOn.file, "public/console.css", "the wait carries the file the pair collide on");
  const line = view.digest.find((l) => l.includes(`#${next.id} queued`));
  assert.ok(line.includes(`SKIP: ${sentence(pre.body)}`), `the digest prints the cut's sentence verbatim:\n${line}`);
  assert.match(line, /waiting on #1 \(lane public\/console\.css\)$/, `the order names the holder and the lane:\n${line}`);
});
