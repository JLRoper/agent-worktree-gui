// The queue sweep: the board's guarantee that the QUEUE gets minded, not only the run.
//
// What this file is the contract for, written from row #99's own detail:
//
//   1. ONE NEW RULE — `queuesweep` in RULE_DEFS. It fires on a run that ended `done` AND was linked to a row of
//      that assistant's queue, de-duplicated on the settle's JOB id (a card is re-emitted as its tree is measured,
//      as a title lands and on every reload; one finish is one sweep).
//   2. A FAILED run is not its trigger — the failed half is the `exited` rule's assessment, and the row is judged
//      there or by the failsafe below.
//   3. THE WAKE CARRIES THE FOUR CHECKS — running rows against /api/jobs, queued rows against main, parked rows
//      against their named blocker, then start or report clean — appended whole, never clipped into the hint.
//   4. THE IDLE FAILSAFE — no live run of the assistant for `queueIdleMinutes` (default 30, 0 disables) with an
//      open row on its queue is one sweep, and it never fires while a run is live.
//   5. NEVER A SECOND TURN — a sweep that lands while the assistant is still thinking queues behind that turn and
//      goes out when it ends, rather than opening a run on a live thread.
//
// The settle and the sweep are two rules on one finish, so both go out in ONE turn: the panel coalesces the two
// `wake()` calls 150 ms apart, and the assertion is on the turn as well as on the alerts.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ASSISTANT_THREAD, Assistant, QUEUE_SWEEP_CHECKS, RULE_DEFS } from "../lib/assistant.js";
import { DEFAULTS, SETTINGS_SCOPE, pickSettings } from "../lib/assistant/config.js";
import { queuePathOf, writeQueueFile } from "../lib/assistant/queue.js";
import { completionPayload } from "../lib/completion.js";

const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const MINUTE = 60_000;
const TREE = (n = 1) => ({
  exists: true,
  path: "C:/repo/.worktrees/sweep-the-queue-aaa111",
  branch: "wtgui/sweep-the-queue-aaa111",
  base: "aa11bb22",
  commits: n,
  subjects: n ? ["c0ffee1 wire the sweep"] : [],
  dirty: 0,
  untracked: 0,
  pending: false,
  at: Date.now() - 1_000,
});

// The row a cut writes: `state` running, the thread that carries it, the tree it was cut in.
const ROW = {
  id: 7,
  title: "land the sweep",
  state: "running",
  thread: "wtgui-sweep-the-queue-aaa111",
  threads: ["wtgui-sweep-the-queue-aaa111"],
  worktree: TREE().path,
  files: ["lib/assistant.js"],
};

async function board(t, { rows = [], tasks = [ROW], settings = {} } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-qsweep-"));
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
  Object.assign(assistant.settings, settings);
  // The queue the panel seeds for #1 at boot, with the row this run is carrying.
  writeQueueFile(queuePathOf(dir, "assistant-1"), tasks, null);
  t.after(async () => {
    if (assistant.settleTimer) clearTimeout(assistant.settleTimer);
    if (assistant.timer) clearInterval(assistant.timer);
    await rm(dir, { recursive: true, force: true });
  });
  return { assistant, said, rows, dir };
}

// A settled card, shaped the way `jobs.summary` hands it to the observer.
function settled({
  id = "job-1",
  thread = ROW.thread,
  turn = 1,
  status = "done",
  assistant = false,
  finalMessage = "Done — the sweep is wired and the suite is green.",
  tree = TREE(),
  at = Date.now(),
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
      status === "done"
        ? { word: "normal", exitCode: 0, source: "the run's completed result", reason: "" }
        : { word: "failed", exitCode: 1, source: "the run's result event", reason: "exit code 1 (max_turns)" },
  };
  job.completion = completionPayload(job);
  return job;
}

const sweeps = (assistant) => assistant.alerts.filter((a) => a.rule === "queuesweep");

test("the rule ships at wake, and its failsafe is a watchdog knob defaulting to 30 minutes", () => {
  assert.equal(RULE_DEFS.queuesweep?.default, "wake", "a settle is the board's news, so the sweep rides it at wake");
  assert.ok(RULE_DEFS.queuesweep?.hint.includes("four checks"), "the row the reader tunes names what the wake is");
  assert.equal(DEFAULTS.queueIdleMinutes, 30, "the failsafe's default is 30 minutes");
  assert.equal(SETTINGS_SCOPE.queueIdleMinutes, "watchdog", "it is drawn beside the other watchdog settings, not per assistant");
  // The bounds `pickSettings` enforces, and 0 surviving as 0 — the one value that means "off" and must not be
  // coerced to a default by an `||` somewhere downstream.
  assert.equal(pickSettings({ queueIdleMinutes: 0 }).queueIdleMinutes, 0, "0 is a value, not an absent knob");
  assert.equal(pickSettings({ queueIdleMinutes: 5000 }).queueIdleMinutes, 1440, "a day is the ceiling");
  assert.equal(pickSettings({ queueIdleMinutes: "soon" }).queueIdleMinutes, 30, "nonsense falls back to the default");
});

test("a successful settle on a queue row fires exactly one sweep, and the wake carries the four checks", async (t) => {
  const { assistant, said } = await board(t);
  assert.equal(QUEUE_SWEEP_CHECKS.split("\n").length, 6, "four numbered checks, the header and the closing line");

  assistant.observe({ type: "job", job: settled() });
  await wait();

  const fired = sweeps(assistant);
  assert.equal(fired.length, 1, "one successful settle on a row is one sweep");
  assert.equal(fired[0].thread, ROW.thread, "the sweep is filed on the thread whose row it is about");
  assert.equal(fired[0].turnId, "job-1", "and on the run's own id");
  assert.ok(
    fired[0].evidence.some((e) => e.label === `#${ROW.id}`),
    "the row it is sweeping is named on the sweep",
  );

  // The settle and the sweep are TWO rules on ONE finish, and the panel's coalescing makes them one turn.
  assert.equal(said.length, 1, "one settle is one wake, even when two rules answer it");
  const text = said[0].text;
  assert.match(text, /\[settle\]/, "the landing judgement leads");
  assert.match(text, /\[queuesweep\]/, "and the queue's half rides with it");
  assert.match(text, /#7 land the sweep/, "the row is named");
  // The four checks, verbatim: an unconstrained "mind the queue" wake is the vibe the row forbids.
  assert.match(text, /Sweep your queue now, in this order:/);
  assert.match(text, /1\. Read the queue first/);
  assert.match(text, /2\. Every RUNNING row: does \/api\/jobs hold a live job for its thread\?/);
  assert.match(text, /3\. Every QUEUED row: is its deliverable already on main\?/);
  assert.match(text, /4\. Every PARKED row: is the row it names as its blocker done\?/);
  assert.match(text, /Then start what can be started, or say plainly that the queue is clean\./);
});

test("a failed run fires no sweep — the failure has its own assessment", async (t) => {
  const { assistant, said } = await board(t);
  assistant.observe({ type: "job", job: settled({ id: "job-f", status: "failed", finalMessage: "blocked: no gateway key" }) });
  await wait();
  assert.equal(sweeps(assistant).length, 0, "a failed run is the `exited` rule's, not the sweep's");
  assert.equal(said.length, 0, "and nothing went out (the EXITED bar has not elapsed)");
});

test("a settle that carried no queue row fires no sweep", async (t) => {
  const { assistant, said } = await board(t, { tasks: [] });
  assistant.observe({ type: "job", job: settled({ id: "job-n", thread: "wtgui-nobody-carries-bbb222", tree: TREE() }) });
  await wait();
  assert.equal(sweeps(assistant).length, 0, "the rule is for a row in THIS assistant's queue, not for every finish");
  assert.equal(said.length, 1, "the settle notice still goes out on its own");
  assert.match(said[0].text, /\[settle\]/);
  assert.doesNotMatch(said[0].text, /Sweep your queue now/, "and it does not carry a checklist for a queue it was not asked about");
});

test("the same settle re-emitted is one sweep — de-duplicated on the job id", async (t) => {
  const { assistant, said } = await board(t);
  const job = settled();
  assistant.observe({ type: "job", job });
  await wait();
  // The re-emits a settled card gets: the tree measurement landing, a title arriving, a reload.
  const again = { ...job, completion: completionPayload({ ...job, tree: TREE(2) }) };
  assistant.observe({ type: "job", job: again });
  assistant.observe({ type: "job", job: again });
  await wait();
  assert.equal(sweeps(assistant).length, 1, "one job id is one sweep");
  assert.equal(said.length, 1, "and one turn");
});

test("the idle failsafe fires on the first pass past N minutes with work open, then not again for N", async (t) => {
  const { assistant, said } = await board(t);
  const start = assistant.bootedAt;

  assert.equal(assistant.checkQueueIdle(start + 29 * MINUTE, []), null, "one minute short of the window is not a sweep");
  const first = assistant.checkQueueIdle(start + 31 * MINUTE, []);
  assert.ok(first && first.rule === "queuesweep", "30 minutes of nothing with a row open is a sweep");
  await wait();
  assert.equal(said.length, 1);
  assert.match(said[0].text, /2\. Every RUNNING row/, "the failsafe's wake carries the same four checks");

  assert.equal(assistant.checkQueueIdle(start + 40 * MINUTE, []), null, "the next pass does not repeat it — the clock restarted");
  const second = assistant.checkQueueIdle(start + 62 * MINUTE, []);
  assert.ok(second, "a second window of silence is a second sweep: the cadence is N minutes, not one per boot");
});

test("the failsafe never fires while a run of that assistant is live", async (t) => {
  const { assistant, rows } = await board(t);
  const start = assistant.bootedAt;
  const live = {
    id: "job-live",
    thread: "wtgui-live-worker-ccc333",
    status: "running",
    startedAt: new Date().toISOString(),
    lines: [{ kind: "text", text: "still working", at: Date.now() - 30_000 }],
  };
  rows.push(live);

  assert.equal(assistant.checkQueueIdle(start + 90 * MINUTE, rows), null, "a live run is the clock, however long it has been up");
  // The run ends: the window starts from the END, not from the boot.
  live.status = "done";
  live.endedAt = new Date().toISOString();
  assert.equal(assistant.checkQueueIdle(start + 91 * MINUTE, rows), null, "the moment it is seen, the window restarts");
  const after = assistant.checkQueueIdle(start + 121 * MINUTE, rows);
  assert.ok(after && after.rule === "queuesweep", "and N minutes after the end, the sweep goes");
});

test("0 disables the timer and leaves the settle trigger", async (t) => {
  const { assistant, said } = await board(t, { settings: { queueIdleMinutes: 0 } });
  const start = assistant.bootedAt;
  assert.equal(assistant.checkQueueIdle(start + 500 * MINUTE, []), null, "0 is off, however long the board is quiet");
  assert.equal(said.length, 0);

  assistant.observe({ type: "job", job: settled({ id: "job-zero" }) });
  await wait();
  assert.equal(sweeps(assistant).length, 1, "the settle half of the rule is its own level, not this clock");
});

test("an idle queue with nothing open is not a wake", async (t) => {
  const { assistant, said } = await board(t, { tasks: [{ ...ROW, state: "done", doneAt: new Date().toISOString() }] });
  const start = assistant.bootedAt;
  assert.equal(assistant.checkQueueIdle(start + 90 * MINUTE, []), null, "a queue that is already correct is not swept");
  assert.equal(said.length, 0);
});

// A MANUAL PARK IS A DECISION, NOT WORK. Nothing about it can become false, so no sweep can ever act on it, and
// counting it as open made the failsafe spend a full turn every queueIdleMinutes to answer that the queue is
// clean. The board this row was written from held three of them (#116, #175, #213) and fired four such turns in
// one day.
test("a queue of only manual parks fires no idle alert, at any interval", async (t) => {
  const parks = [
    { id: 116, title: "parked for the reader", state: "parked", hold: { kind: "manual", value: "" }, reason: "not before the release" },
    { id: 175, title: "parked again", state: "parked", hold: { kind: "manual", value: "" }, reason: "waiting on a human" },
    { id: 213, title: "and once more", state: "parked", hold: { kind: "manual", value: "" }, reason: "later" },
  ];
  const { assistant, said } = await board(t, { tasks: parks });
  assert.equal(assistant.openQueueRows("assistant-1").length, 0, "a manual park is not a row that needs a decision");
  const start = assistant.bootedAt;
  for (const minutes of [1, 29, 31, 60, 240, 1440]) {
    assert.equal(
      assistant.checkQueueIdle(start + minutes * MINUTE, []),
      null,
      `${minutes} min: three manual parks are not a queue with work left`,
    );
  }
  await wait(250);
  assert.equal(said.length, 0, "and no turn was spent saying the queue is clean");
});

test("one queued row still fires the alert, and a manual park beside it is not counted", async (t) => {
  const rows = [
    { id: 42, title: "start the sweep", state: "queued" },
    { id: 116, title: "parked for the reader", state: "parked", hold: { kind: "manual", value: "" } },
  ];
  const { assistant, said } = await board(t, { tasks: rows });
  const alert = assistant.checkQueueIdle(assistant.bootedAt + 31 * MINUTE, []);
  assert.ok(alert && alert.rule === "queuesweep", "a queued row is work left on a quiet board");
  assert.match(alert.title, /1 row still open/, "the park does not make it two");
  assert.match(alert.detail, /#42/, "the row that is work is named");
  assert.doesNotMatch(alert.detail, /#116/, "and the manual park is not");
  await wait();
  assert.equal(said.length, 1, "the sweep still goes out");
  assert.match(said[0].text, /2\. Every RUNNING row/, "carrying the same four checks");
});

// The other half of the rule: a park that NAMES a blocker row is a row the sweep can unpark, so it stays open
// and the alert names it.
test("a parked row that names its blocker is still open work, and is named in the alert", async (t) => {
  const rows = [
    { id: 60, title: "the blocker", state: "queued" },
    { id: 61, title: "waits on the blocker", state: "parked", hold: { kind: "task", value: "#60" }, reason: "after #60" },
  ];
  const { assistant, said } = await board(t, { tasks: rows });
  const alert = assistant.checkQueueIdle(assistant.bootedAt + 31 * MINUTE, []);
  assert.ok(alert && alert.rule === "queuesweep", "a park with a named blocker is work a sweep can act on");
  assert.match(alert.title, /2 rows still open/);
  assert.match(alert.detail, /#61/, "the parked row is named, so the sweep knows which park to test");
  assert.ok(
    alert.evidence.some((e) => e.label === "#61" && /parked/.test(e.value)),
    "and it reads as parked on its blocker",
  );
  await wait();
  assert.equal(said.length, 1);
  assert.match(said[0].text, /4\. Every PARKED row: is the row it names as its blocker done\?/, "the four checks are unchanged");
});

test("a sweep never becomes a second run on a live thread", async (t) => {
  const { assistant, said, rows } = await board(t);
  // The assistant is mid-turn: a run of its own is live on its thread.
  const own = { id: "panel-turn", thread: ASSISTANT_THREAD, status: "running", startedAt: new Date().toISOString(), assistant: true };
  rows.push(own);

  assistant.observe({ type: "job", job: settled({ id: "job-live-thread" }) });
  await wait();
  assert.equal(said.length, 0, "nothing is opened on a thread that already has a run");
  assert.ok(assistant.pendingWake.length >= 1, "the wake waits for the turn to end instead of being dropped");

  own.status = "done";
  own.endedAt = new Date().toISOString();
  await assistant.flushWake();
  assert.equal(said.length, 1, "and it goes out when the turn ends");
  assert.match(said[0].text, /\[queuesweep\]/);
  assert.match(said[0].text, /1\. Read the queue first/);
});

test("it is an event, so the hourly sweep budget cannot drop it", async (t) => {
  const { assistant } = await board(t);
  const limit = assistant.settings.maxWakesPerHour;
  for (let i = 0; i < limit; i += 1) assistant.wakes.push(Date.now());
  const sent = assistant.wake("a sweep nobody may drop", null, "queuesweep");
  assert.equal(sent?.queued, true, "a settle-driven sweep is a single fact with no second chance");
  assert.equal(assistant.wake("a quiet pass", null, "quiet").refused, "budget", "while the sentry's own sweeps stay budgeted");
});
