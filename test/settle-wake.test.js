// The default settle notice: a worker's run ending is news, even when nobody asked for a watch.
//
// What this file is the contract for: a run that ends `done` (the case the board used to answer with a changed row
// and nothing else) or `failed` wakes the assistant ONCE, carrying the completion payload — the worker's final
// message included, because that is what "is this branch ready to land" is judged on. And the three ways that
// could become noise: the assistant waking on its own turn (a self-loop), N runs settling together (N notices),
// and a thread the reader already has a watch on (two notices for one finish).
//
// `observe` is the same call the server makes for every job event (`onEvent` -> `assistant.observe`), and the
// settle is deliberately driven through it rather than through a private method: the wiring is half the claim.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant, ASSISTANT_THREAD, RULE_DEFS } from "../lib/assistant.js";
import { Jobs } from "../lib/jobs.js";
import { completionPayload } from "../lib/completion.js";

const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const TREE = (n = 1) => ({
  exists: true,
  path: "C:/repo/.worktrees/wake-the-panel-aaa111",
  branch: "wtgui/wake-the-panel-aaa111",
  base: "aa11bb22",
  commits: n,
  subjects: n ? ["c0ffee1 stub the wake"] : [],
  dirty: 0,
  untracked: 0,
  pending: false,
  at: Date.now() - 1_000,
});

async function board(t, rows = []) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-settle-"));
  const said = [];
  const assistant = new Assistant({
    config: {
      jobsFile: path.join(dir, "jobs.json"),
      assistantFile: path.join(dir, "assistant.json"),
      charterFile: path.join(dir, "assistant-charter.md"),
      defaultCwd: dir,
    },
    jobs: { list: () => rows },
    getProjects: () => [],
    onEvent: () => {},
    onLog: () => {},
  });
  // What goes out instead of a real turn: the wake text and the origin it was sent with.
  assistant.say = async (text, opts = {}) => {
    said.push({ text: String(text), origin: opts.origin || null });
    return { id: `said-${said.length}` };
  };
  assistant.settleRetryMs = 80; // the retry clock is a second in the panel; a test cannot wait one
  t.after(async () => {
    if (assistant.settleTimer) clearTimeout(assistant.settleTimer);
    if (assistant.timer) clearInterval(assistant.timer);
    await rm(dir, { recursive: true, force: true });
  });
  return { assistant, said, rows };
}

// A settled card, shaped the way `jobs.summary` hands it to the observer: the completion payload is built by
// `jobs.finalise` at the settle, from the run's own result and the tree measured after it.
function settled({
  id = "job-1",
  thread = "wtgui-wake-the-panel-aaa111",
  turn = 1,
  status = "done",
  assistant = false,
  finalMessage = "Done — the wake is wired and the suite is green.",
  tree = TREE(),
  at = Date.now(),
  outcome = null,
} = {}) {
  const job = {
    id,
    thread,
    turn,
    status,
    assistant,
    label: null,
    startedAt: new Date(at - 61_000).toISOString(),
    endedAt: new Date(at).toISOString(),
    cwd: "C:/repo",
    worktreePath: tree.path,
    branch: tree.branch,
    finalMessage,
    lines: [],
    tree,
    outcome:
      outcome ||
      (status === "done"
        ? { word: "normal", exitCode: 0, source: "the run's completed result", reason: "" }
        : { word: "failed", exitCode: 1, source: "the run's result event", reason: "exit code 1 (max_turns)" }),
  };
  job.completion = completionPayload(job);
  return job;
}

const settles = (assistant) => assistant.alerts.filter((a) => a.rule === "settle");

test("the rule ships at wake: a clean completion is the board's default news", () => {
  assert.equal(RULE_DEFS.settle?.default, "wake");
});

test("a run that ends done with no watch wakes the assistant with its final message", async (t) => {
  const { assistant, said } = await board(t);
  const job = settled();
  assistant.observe({ type: "job", job });
  await wait();

  assert.equal(said.length, 1, "one settle is one wake");
  const text = said[0].text;
  assert.match(text, /\[settle\]/, "the wake names the rule it came from");
  assert.match(text, /ended normal/, "the status word is the notice's three-word one, never the card's `done`");
  assert.match(text, /the worker's final message:/, "the payload's final-message block rides with the wake");
  assert.match(text, /Done — the wake is wired and the suite is green\./, "and it is the worker's own words");
  assert.match(text, /left 1 commit not on aa11bb22/, "what the branch actually holds, so the landing call is made on evidence");
  assert.equal(said[0].origin?.kind, "assistant-wake", "it goes out as a wake, not as a reply");

  const alert = settles(assistant)[0];
  assert.equal(alert?.thread, job.thread);
  assert.equal(alert?.turnId, "job-1");
  assert.equal(alert?.severity, "info");
});

test("a failed run wakes too, on the exit code that failed it", async (t) => {
  const { assistant, said } = await board(t);
  assistant.observe({ type: "job", job: settled({ id: "job-f", status: "failed", finalMessage: "blocked: no gateway key in .env" }) });
  await wait();

  assert.equal(said.length, 1, "a run that failed needs its thread's next turn, which is the same judgement");
  assert.match(said[0].text, /ended failed/);
  assert.match(said[0].text, /exit: 1/);
  assert.match(said[0].text, /blocked: no gateway key in \.env/, "its last words are what says why");
  assert.equal(settles(assistant)[0]?.severity, "warn");
});

test("a card that is emitted again as its measurement lands wakes nobody twice", async (t) => {
  const { assistant, said } = await board(t);
  const job = settled();
  assistant.observe({ type: "job", job });
  await wait();
  // The same settle seen again: the tree measurement's own emit, a title landing, a reload.
  const same = { ...job, completion: completionPayload({ ...job, tree: TREE() }) };
  assistant.observe({ type: "job", job: same });
  assistant.observe({ type: "job", job: same });
  await wait();
  assert.equal(said.length, 1, "one finish is one wake, however many times the card is re-emitted");
});

test("the assistant's own run never wakes it — no self-loop", async (t) => {
  const { assistant, said } = await board(t);
  // Both halves of the identification: the explicit mark, and the thread a card written before the mark carries.
  assistant.observe({ type: "job", job: settled({ id: "own-1", thread: "wtgui-some-worker-111111", assistant: true }) });
  assistant.observe({ type: "job", job: settled({ id: "own-2", thread: ASSISTANT_THREAD }) });
  await wait();

  assert.equal(said.length, 0, "a wake that answered every wake with another wake would never stop");
  assert.equal(assistant.pendingSettles.size, 0, "and it is not even queued");
  assert.equal(settles(assistant).length, 0);
});

test("several runs settling together are one wake, not one each", async (t) => {
  const { assistant, said, rows } = await board(t);
  const jobs = [
    settled({ id: "job-a", thread: "wtgui-alpha-111111" }),
    settled({ id: "job-b", thread: "wtgui-bravo-222222", status: "failed", finalMessage: "the suite failed: 2 of 41" }),
    settled({ id: "job-c", thread: "wtgui-charlie-333333" }),
  ];
  rows.push(...jobs);
  for (const job of jobs) assistant.observe({ type: "job", job });
  await wait();

  assert.equal(said.length, 1, "three runs ending in one pass is one thought for the reader");
  const text = said[0].text;
  assert.match(text, /3 runs settled/);
  for (const job of jobs) assert.match(text, new RegExp(job.thread), `${job.thread} is named in the one notice`);
  assert.equal(settles(assistant).length, 1, "one alert, too");
  assert.equal(settles(assistant)[0].thread, null, "a batch of threads has no single thread to be filed under");
  assert.equal(settles(assistant)[0].severity, "warn", "one failure makes the batch worth a look");
});

test("a thread with an open watch gets the watch's notice and not a second one", async (t) => {
  const { assistant, said, rows } = await board(t);
  const job = settled({ id: "job-w" });
  rows.push(job);
  const watch = assistant.addWatch({ thread: job.thread, title: "the wake lands" });
  // Watched since before the turn ended: this finish is the one the watch is about.
  watch.at = new Date(Date.parse(job.endedAt) - 60_000).toISOString();

  assistant.observe({ type: "job", job });
  await wait();
  assert.equal(said.length, 0, "the default notice stays silent while a watch covers the thread");
  assert.ok(
    assistant.journal.some((j) => j.kind === "settle-watch"),
    "and the journal says why it stayed unsent",
  );

  // The watch's own pass is the one that speaks, with the same finish and the same payload.
  assistant.checkWatches(rows);
  await wait();
  assert.equal(said.length, 1, "one run, one notice");
  assert.match(said[0].text, /\[watch\] watch finished: the wake lands/);
  assert.match(said[0].text, /the worker's final message:/);

  // The re-emit that follows every settle must not turn into a second notice once the watch has closed.
  assistant.observe({ type: "job", job: { ...job } });
  await wait();
  assert.equal(said.length, 1, "a closed watch does not reopen the default notice for the same finish");
});

test("a finish whose tree is still being measured is held back until the measurement lands", async (t) => {
  const { assistant, said, rows } = await board(t);
  // The event arrives as `jobs.settle` emits it: before `measureTree` has written the tree, so the payload it
  // carries cannot say what the branch holds yet.
  const measuring = { ...TREE(2), pending: true, at: Date.now() };
  const job = settled({ id: "job-m", tree: measuring, finalMessage: "two commits, ready to land" });
  rows.push(job);
  assistant.observe({ type: "job", job });
  await wait(200);
  assert.equal(said.length, 0, "a notice that says \"commits not measured\" cannot answer the landing question");
  assert.equal(assistant.pendingSettles.size, 1, "it waits instead of being dropped");

  // The measurement lands: the store's card now carries it, and the retry reads the store, not the event.
  job.tree = TREE(2);
  job.completion = completionPayload(job);
  await wait(300);
  assert.equal(said.length, 1, "the notice goes out once the facts are in");
  assert.match(said[0].text, /left 2 commits not on aa11bb22/);
  assert.doesNotMatch(said[0].text, /commits not measured/);
});

test("a card that settled before this process started is history, not a notice", async (t) => {
  const { assistant, said } = await board(t);
  // The store boots holding every card it had; a sweep that re-emits one is not a fresh finish.
  assistant.observe({ type: "job", job: settled({ id: "job-old", at: Date.now() - 3 * 3600_000 }) });
  await wait();
  assert.equal(said.length, 0);
});

// The budget is for noise, not for the board's news.
//
// A settle used to go through `wake(reason, alertId, rule)` with no `force`, so it shared `maxWakesPerHour` with the
// quiet, loop and watch alerts — and once that hour was spent the settle was refused with
// `wake-suppressed: rate limit reached` and the notice never left the panel. A failed worker was then invisible until
// the reader happened to look. This is the case that was missed: the budget spent, a quiet wake still refused, and a
// settle still queued anyway.
test("a spent wake budget still refuses a quiet wake, but a settle goes out", async (t) => {
  const { assistant, said, rows } = await board(t);
  // Spent exactly the way `flushWake` spends it: one timestamp per wake that actually went out.
  const limit = assistant.settings.maxWakesPerHour;
  for (let i = 0; i < limit; i += 1) assistant.wakes.push(Date.now());
  assert.equal(assistant.wakes.length, limit, "the hour's budget is spent, to the last wake");

  // A quiet rule at `wake` is exactly the noise the budget exists for, and it is still refused.
  assistant.settings.rules.quiet = "wake";
  assistant.settings.quietSeconds = 240;
  rows.push({
    id: "job-quiet",
    thread: "wtgui-quiet-555555",
    runId: "run_quiet_1",
    status: "running",
    startedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    lines: [{ kind: "text", text: "still working", at: Date.now() - 10 * 60_000 }],
  });
  assistant.evaluate(rows, Date.now());

  const suppressed = assistant.journal.filter((j) => j.kind === "wake-suppressed");
  assert.equal(suppressed.length, 1, "the quiet wake hit the limit and said so in the journal");
  assert.match(suppressed[0].text, /rate limit reached/, "the line the settle used to be dropped with");
  assert.match(suppressed[0].text, /no new output/, "and it was the quiet rule's wake that was refused");
  assert.equal(assistant.pendingWake.length, 0, "nothing from the quiet rule was queued");

  // The settle — a FAILED run, the case the budget silently ate — is exempt and goes out anyway.
  const job = settled({ id: "job-budget", thread: "wtgui-failed-worker-666666", status: "failed", finalMessage: "blocked: the suite failed 2 of 41" });
  rows.push(job);
  assistant.observe({ type: "job", job });
  await wait();

  assert.equal(assistant.pendingWake.length, 0, "the settle's wake was taken off the queue and sent");
  assert.equal(said.length, 1, "one wake left the panel: the settle's");
  assert.match(said[0].text, /\[settle\] wtgui-failed-worker-666666 ended failed/);
  assert.match(said[0].text, /blocked: the suite failed 2 of 41/, "with the worker's own last words");
  assert.equal(
    assistant.journal.filter((j) => j.kind === "wake-suppressed").length,
    1,
    "the settle added no second suppression — the budget did not touch it",
  );
  // The exemption is the settle's alone: the next quiet sweep of the same silence is one key and re-arms later, so
  // prove the general case directly, with a rule that is not the settle.
  const refused = assistant.wake("a quiet thing", null, "quiet");
  assert.equal(refused?.refused, "budget", "every other rule is still budgeted");
});

// The other arm of the spent budget: a run that ended `done`. The failed-run case above is the one that was
// invisible; this one proves the same exemption covers a completion, and — the part worth pinning — that a settle
// spends what it is allowed to ignore without refilling the hour for the quiet rule behind it.
test("a completion still wakes with the hour's budget spent, and the budget stays spent", async (t) => {
  const { assistant, said } = await board(t);
  const limit = assistant.settings.maxWakesPerHour;
  // Spent exactly the way `flushWake` spends it: one timestamp per wake that actually went out.
  for (let i = 0; i < limit; i += 1) assistant.wakes.push(Date.now());

  const quiet = assistant.wake("quiet: nothing said for a while", null, "quiet");
  assert.equal(quiet.refused, "budget", "the budget binds every rule but the settle");
  assert.equal(assistant.pendingWake.length, 0, "and nothing from the quiet rule was queued");
  assert.match(
    assistant.journal.find((j) => j.kind === "wake-suppressed")?.text || "",
    /rate limit reached/,
    "the refusal is journalled, with the line the settle used to be dropped on",
  );

  // A completion, `done` and not `failed`, is the case the brief's own default path produces all day.
  assistant.observe({ type: "job", job: settled({ id: "job-budget-done" }) });
  await wait();

  assert.equal(assistant.pendingWake.length, 0, "the settle's wake was taken off the queue and sent");
  assert.equal(said.length, 1, "one wake left the panel: the completion's");
  assert.match(said[0].text, /\[settle\] wtgui-wake-the-panel-aaa111 ended normal/);
  assert.equal(assistant.wakes.length, limit + 1, "and the settle spent what it was allowed to ignore");
  assert.equal(
    assistant.journal.filter((j) => j.kind === "wake-suppressed").length,
    1,
    "no second suppression — the budget did not touch the settle",
  );

  // The exemption is the settle's alone: with the list now one past the limit, the next quiet wake is still refused.
  const again = assistant.wake("quiet: still nothing", null, "quiet");
  assert.equal(again.refused, "budget", "every other rule is still budgeted");
});

// The unit cases above prove the judgement. This one proves the WIRING, with the real store: `jobs.settle` is where
// a run ends, and it must reach the assistant without anything else standing in — server.js wires
// `onEvent -> assistant.observe`, which is the only join between the two.
test("the real settle path reaches the assistant: a job store settling a run", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-settle-store-"));
  const said = [];
  let assistant = null;
  const jobs = new Jobs({
    config: { jobsFile: path.join(dir, "jobs.json"), scratchDir: dir, defaultCwd: dir },
    onEvent: (evt) => assistant?.observe(evt),
    onLog: () => {},
  });
  assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile: path.join(dir, "assistant.json"), charterFile: path.join(dir, "c.md"), defaultCwd: dir },
    jobs,
    getProjects: () => [],
    onEvent: () => {},
    onLog: () => {},
  });
  assistant.say = async (text) => {
    said.push(String(text));
    return {};
  };
  t.after(async () => {
    clearInterval(jobs.titleSweep);
    for (const id of [...assistant.spawnTimers.keys()]) assistant.disarmSpawnWatch(id);
    if (assistant.settleTimer) clearTimeout(assistant.settleTimer);
    if (assistant.timer) clearInterval(assistant.timer);
    await rm(dir, { recursive: true, force: true });
  });

  // A worker's card, mid-run, exactly as `create` leaves it: no tree of its own in this sandbox (its `cwd` is not
  // a checkout), so the measurement says so and the notice goes out at once.
  const job = {
    id: "job-real",
    thread: "wtgui-real-settle-444444",
    turn: 1,
    reply: false,
    existing: false,
    prompt: "wire the settle wake",
    status: "running",
    runId: "run_real_1",
    lines: [],
    startedAt: new Date(Date.now() - 30_000).toISOString(),
    endedAt: null,
    cwd: dir,
    worktree: null,
    worktreePath: null,
    ownerPath: null,
    sessionId: "wtgui-real-settle-444444",
  };
  jobs.jobs.set(job.id, job);
  jobs.settle(job, "completed", { output: "Done — the wake is wired; nothing was left uncommitted." });
  await wait();

  assert.equal(job.status, "done", "the run settled");
  assert.equal(said.length, 1, "and the panel woke the assistant about it with no watch and no hand-written WATCH");
  assert.match(said[0], /\[settle\] wtgui-real-settle-444444 ended normal/);
  assert.match(said[0], /Done — the wake is wired; nothing was left uncommitted\./, "the worker's final message, carried");
});
