// Change 1 — the wake budget covers SWEEPS, never EVENTS.
//
// A wake is one of two classes. A SWEEP is a condition the sentry POLLS for (the eleven in `SWEEP_WAKE_RULES`:
// quiet, loop, errorloop, leftover, repeat, child, noevidence, context, collision, spawnidle, spawnlost) — the
// sentry's speculative read of a board that has not told us anything. An EVENT is something that HAPPENED to a run
// the assistant manages (a settle, an exit, an approval, a question, a watch finishing, an interruption) or a turn
// somebody asked for (a restart, a reader's press, a wake with no rule at all). An event is a single fact with no
// second chance: the hourly budget may not refuse it, because a refused event is news nobody ever reads.
//
// The session this change comes from lost settles to exactly that — `wake-suppressed: rate limit reached (6/h)`,
// `WAKE SUPPRESSED x1`, `x3` — while a quiet sweep kept its turn. So these tests put the budget at ZERO (the
// harshest hour) and prove the settle and the exited run still go out, a quiet sweep still does not, every other
// event class is delivered, and only a sweep spends the hour. Run against the pre-change tree this file fails at the
// first event that is not `settle`/`exited` (those two carried a `forceWake` flag there): `wake()` gated every kind
// the same way, so approval/question/watch are refused with the budget at zero.
//
// The class comes from the RULE, never from a caller's flag: `SWEEP_WAKE_RULES` is written as the sweeps on purpose,
// so a rule added later defaults to event and cannot silently become droppable (`invented-later` below proves it).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { completionPayload } from "../lib/completion.js";

const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const TREE = (n = 1) => ({
  exists: true,
  path: "C:/repo/.worktrees/event-or-sweep-aaa111",
  branch: "wtgui/event-or-sweep-aaa111",
  base: "aa11bb22",
  commits: n,
  subjects: n ? ["c0ffee1 budget the sweeps only"] : [],
  dirty: 0,
  untracked: 0,
  pending: false,
  at: Date.now() - 1_000,
});

// `maxWakesPerHour: 0` is the point of every test here: the clamp allows it ([0, 60]), and an hour that can spend
// nothing on a sweep is the strongest possible statement that an event does not go through that gate at all.
async function board(t, maxWakesPerHour = 0) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-event-wakes-"));
  const said = [];
  const rows = [];
  const assistant = new Assistant({
    config: {
      jobsFile: path.join(dir, "jobs.json"),
      assistantFile: path.join(dir, "assistant.json"),
      charterFile: path.join(dir, "assistant-charter.md"),
      defaultCwd: dir,
      assistant: { maxWakesPerHour },
    },
    jobs: { list: () => rows },
    getProjects: () => [],
    onEvent: () => {},
    onLog: () => {},
  });
  // What goes out instead of a real turn: the wake text and the origin it was sent with, which carries the class.
  assistant.say = async (text, opts = {}) => {
    said.push({ text: String(text), origin: opts.origin || null });
    return { id: `said-${said.length}` };
  };
  assistant.settleRetryMs = 80; // the retry clock is a second in the panel; a test cannot wait one
  t.after(async () => {
    if (assistant.wakeTimer) clearTimeout(assistant.wakeTimer);
    if (assistant.settleTimer) clearTimeout(assistant.settleTimer);
    if (assistant.timer) clearInterval(assistant.timer);
    for (const id of [...assistant.spawnTimers.keys()]) assistant.disarmSpawnWatch(id);
    await rm(dir, { recursive: true, force: true });
  });
  return { assistant, said, rows };
}

// A card, shaped the way `jobs.summary` hands it to the observer — the same fixture the settle and exited tests
// drive, so this file is about the budget and not about a payload shape of its own.
function settled({
  id = "job-1",
  thread = "wtgui-event-or-sweep-aaa111",
  turn = 1,
  status = "done",
  assistant = false,
  finalMessage = "Done — the suite is green.",
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

const suppressions = (assistant) => assistant.journal.filter((j) => j.kind === "wake-suppressed");

// The brief's case, at the harshest setting: budget 0, so every sweep is refused and nothing but the class can
// decide whether a wake survives.
test("with the budget at zero, a settle and an exited run still go out, and a quiet sweep still does not", async (t) => {
  const { assistant, said, rows } = await board(t, 0);
  assert.equal(assistant.settings.maxWakesPerHour, 0, "the hour can spend nothing — the setting landed");

  // 1. The sweep: a live turn that has said nothing for ten minutes, on a rule the reader left at `wake`.
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

  assert.equal(suppressions(assistant).length, 1, "the quiet sweep is refused, exactly as it was before");
  assert.match(suppressions(assistant)[0].text, /rate limit reached/, "with the line the settles used to be dropped on");
  assert.match(suppressions(assistant)[0].text, /no new output/, "and it names the quiet rule");
  assert.equal(assistant.pendingWake.length, 0, "nothing from the sweep was queued");

  // 2. A settle — the run the budget used to eat.
  const done = settled({ id: "job-done", thread: "wtgui-finished-worker-666666", finalMessage: "done: the suite is green" });
  rows.push(done);
  assistant.observe({ type: "job", job: done });
  await wait();

  assert.equal(said.length, 1, "the settle left the panel with the budget at zero");
  assert.match(said[0].text, /\[settle\]/, "and it is the settle's wake");
  assert.match(said[0].text, /done: the suite is green/, "carrying the worker's own last words");
  assert.equal(said[0].origin?.event, true, "the turn is told it is an EVENT — what the digest gate reads");

  // 3. An exited run — the other arm the brief names.
  const failed = settled({ id: "job-failed", thread: "wtgui-exited-worker-777777", status: "failed" });
  rows.push(failed);
  assistant.checkExit(failed, Date.parse(failed.endedAt) + 31_000);
  await wait();

  assert.equal(said.length, 2, "the exited run went out too");
  assert.match(said[1].text, /\[exited\]/, "with its own rule's name on it");
  assert.equal(said[1].origin?.event, true, "and it is an event as well");
  assert.equal(suppressions(assistant).length, 1, "neither event was ever suppressed — one refusal, and it was the sweep's");
  assert.equal(assistant.wakes.length, 0, "and neither event spent the sweep budget: the hour is still at zero");
});

// The rest of the event vocabulary, driven through `fired` the way the sentry's own rules reach a wake. These are the
// rules the pre-change tree refused with the budget at zero, so this test is the failing-first one against HEAD.
test("every event class is admitted with the budget at zero: approval, question, watch, an interruption, no rule at all", async (t) => {
  const { assistant, said } = await board(t, 0);
  Object.assign(assistant.settings.rules, { approval: "wake", question: "wake", watch: "wake", interrupted: "wake" });

  for (const [i, rule] of ["approval", "question", "watch", "interrupted"].entries()) {
    assistant.fired(rule, `subject-${i}`, { thread: `worker-${i}`, title: `${rule} news` });
  }
  // The claim that used to be false: with the hour spent, every one of these is on the queue. On the pre-change tree
  // all four are refused here with `rate limit reached (0/h)` and this reads 0.
  assert.equal(assistant.pendingWake.length, 4, "approval, question, watch and an interruption are all on the queue");

  const ruleless = assistant.wake("the panel restarted while a turn was running", null, null);
  assert.equal(ruleless.queued, true, "a wake with no rule at all is an event, not a sweep with no name");
  assert.equal(assistant.pendingWake.length, 5, "four fired events and the rule-less wake are all on the queue");

  await assistant.flushWake();

  assert.equal(said.length, 1, "one 150 ms batch is one turn, however many events arrived in it");
  assert.equal(said[0].origin?.event, true, "the batch is an event turn");
  for (const rule of ["approval", "question", "watch", "interrupted"]) {
    assert.match(said[0].text, new RegExp(`\\[${rule}\\]`), `the ${rule} event rode in the batch`);
  }
  assert.match(said[0].text, /the panel restarted while a turn was running/, "and so did the rule-less one");
  assert.equal(suppressions(assistant).length, 0, "not one event was journalled as suppressed");
  assert.equal(assistant.wakes.length, 0, "and none of them spent the sweep budget");
});

// The cap still works, and only sweeps pay it. This is the half that must not regress: the budget exists to stop a
// noisy board spending every turn, and the sentry's own polls are what it bounds.
test("the cap still binds sweeps: one sweep spends the hour, the next is refused, and a settle between them spends nothing", async (t) => {
  const { assistant, said, rows } = await board(t, 1);

  const first = assistant.wake("quiet: nothing said for a while", null, "quiet");
  assert.equal(first.queued, true, "the hour's one sweep is queued");
  await assistant.flushWake();
  assert.equal(assistant.wakes.length, 1, "a sweep spends the counter");
  assert.equal(said[0]?.origin?.event, false, "and the turn is told it is a SWEEP");

  const second = assistant.wake("quiet: still nothing", null, "quiet");
  assert.equal(second.refused, "budget", "the second sweep in the same hour is refused");
  assert.match(suppressions(assistant).at(-1)?.text || "", /rate limit reached/, "and says so in the journal");

  // An event in the same spent hour: delivered, and the counter does not move for it.
  const done = settled({ id: "job-after-budget", thread: "wtgui-after-budget-888888" });
  rows.push(done);
  assistant.observe({ type: "job", job: done });
  await wait();
  assert.equal(said.length, 2, "the settle went out in the hour the sweeps were spent");
  assert.match(said[1].text, /\[settle\]/);
  assert.equal(assistant.wakes.length, 1, "and it neither spent nor refilled the sweep counter");

  const third = assistant.wake("quiet: a third time", null, "quiet");
  assert.equal(third.refused, "budget", "the hour is still spent for sweeps — an event does not buy one back");
  assert.equal(assistant.wake("quiet: and again", null, "quiet").refused, "budget");
});

// The list, and the direction it fails in. `SWEEP_WAKE_RULES` names the budgeted class; anything else — including a
// rule somebody adds next year — is an event, so the safe half is the default.
test("the class is a list of SWEEPS, and a kind nobody has classified is an event", async (t) => {
  const { SWEEP_WAKE_RULES, RULE_DEFS } = await import("../lib/assistant/config.js");
  assert.ok(SWEEP_WAKE_RULES instanceof Set, "the sweeps are one named list, exported beside RULE_DEFS");
  assert.deepEqual(
    [...SWEEP_WAKE_RULES].sort(),
    ["child", "collision", "context", "errorloop", "leftover", "loop", "noevidence", "quiet", "repeat", "spawnidle", "spawnlost"],
    "the eleven conditions the sentry polls, written as the sweeps",
  );
  for (const rule of SWEEP_WAKE_RULES) {
    assert.ok(RULE_DEFS[rule], `${rule} is a real rule id, not a typo that would budget nothing`);
  }
  for (const rule of ["settle", "exited", "approval", "question", "watch", "interrupted", "queuesweep"]) {
    assert.equal(SWEEP_WAKE_RULES.has(rule), false, `${rule} is an event and must never be droppable`);
  }

  // A rule added later defaults to event: the list is the sweeps, never the events.
  const { assistant } = await board(t, 0);
  const invented = assistant.wake("a rule added next year", null, "invented-later");
  assert.equal(invented.queued, true, "an unclassified kind is admitted — it cannot silently become droppable");
  assert.equal(assistant.pendingWake.length, 1);
});
