// #69 — a wake REFUSED before it was queued must not spend the finish's claim.
//
// A finish is handed over ONCE. The claim for that is `terminalWakes` (thread -> terminal key, persisted): the first
// rule to see a finished turn takes it and wakes; a second rule that sees the same finish files its alert and
// journals `wake-once` instead of starting a second turn. `fired()` used to take the claim BEFORE `wake()` decided
// anything, and `wake()` refuses at its own door — the hourly budget for a sweep, an assistant switched off — without
// queueing a thing. The claim was then spent on a turn that never started, so every later attempt read that finish
// as already delivered and the completion was lost in silence: the case a live panel's journal records as
// `wake-suppressed: rate limit reached` beside a finish no turn ever mentioned.
//
// These tests pin the ordering from the outside: after a refusal the claim is UNPAID, the alert it filed is still
// there (a refusal costs the wake, never the record), and once the wake is admitted the SAME finish goes out exactly
// once — after which the claim is spent and a second rule about it cannot wake again.
//
// Run against the pre-change tree this file fails at the first `terminalWakes` assertion in each test: the claim is
// already the key, and the later pass journals `wake-once` with no turn behind it.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";

const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));

// `maxWakesPerHour: 0` is the harshest hour the clamp allows ([0, 60]) and the setting the rate-limit branch was
// reported from: nothing a sweep asks for is admitted, and an event is not touched by that gate at all.
async function board(t, maxWakesPerHour = 0) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-wake-claim-"));
  const said = [];
  const assistant = new Assistant({
    config: {
      jobsFile: path.join(dir, "jobs.json"),
      assistantFile: path.join(dir, "assistant.json"),
      charterFile: path.join(dir, "assistant-charter.md"),
      defaultCwd: dir,
      assistant: { maxWakesPerHour },
    },
    jobs: { list: () => [] },
    getProjects: () => [],
    onEvent: () => {},
    onLog: () => {},
  });
  // What goes out instead of a real turn.
  assistant.say = async (text, opts = {}) => {
    said.push({ text: String(text), origin: opts.origin || null });
    return { id: `said-${said.length}` };
  };
  t.after(async () => {
    if (assistant.wakeTimer) clearTimeout(assistant.wakeTimer);
    if (assistant.settleTimer) clearTimeout(assistant.settleTimer);
    if (assistant.timer) clearInterval(assistant.timer);
    await rm(dir, { recursive: true, force: true });
  });
  return { assistant, said };
}

const suppressed = (assistant) => assistant.journal.filter((j) => j.kind === "wake-suppressed");
const once = (assistant) => assistant.journal.filter((j) => j.kind === "wake-once");

test("a wake the budget refuses leaves the finish unclaimed, and the SAME finish goes out once the hour admits it", async (t) => {
  const { assistant, said } = await board(t, 0);
  // A rule at `wake`: the alert is the rule's own, the terminal key is the finish it is about.
  assistant.settings.rules.quiet = "wake";
  // The reader has dealt with the first alert; the rearm window is not what this test is about.
  assistant.settings.rearmSeconds = 0;
  const thread = "wtgui-refused-finish-bbb222";
  const key = "job-9|2026-11-03T00:22:50.655Z";
  const alertOf = () =>
    assistant.fired("quiet", `${thread}|job-9`, {
      thread,
      turnId: "job-9",
      title: "no new output for 4m",
      detail: "Task #10 — propose how rules attach to stages: still marked running but nothing new printed.",
      terminal: { thread, key },
    });

  // 1. The hour is spent: the wake is refused at the rate-limit branch and says so in the journal.
  const first = alertOf();
  assert.ok(first, "the alert is still FILED — a refusal costs the wake, not the record of what happened");
  assert.equal(said.length, 0, "no turn was started for the refused wake");
  assert.equal(suppressed(assistant).length, 1, "the refusal is journalled");
  assert.match(suppressed(assistant)[0].text, /rate limit reached \(0\/h\)/);
  assert.equal(
    assistant.terminalWakes.get(thread),
    undefined,
    "the refused wake did not spend the finish's claim — a later pass must still be able to hand it over",
  );

  // 2. The hour admits it again (the reader raised the budget): the same finish, one turn, carrying its own words.
  assistant.settings.maxWakesPerHour = 4;
  first.status = "dismissed";
  const second = alertOf();
  assert.ok(second, "the later pass files its alert again");
  await wait();
  assert.equal(said.length, 1, "the same finish is delivered once the budget admits it — and only once");
  assert.match(said[0].text, /\[quiet\] no new output for 4m/);
  assert.match(said[0].text, /Task #10 — propose how rules attach to stages/);
  assert.equal(assistant.terminalWakes.get(thread), key, "now that it WAS delivered, the claim is spent");

  // 3. Delivered means delivered: a second rule seeing the same finish files its alert and journals `wake-once`.
  assistant.settings.rules.interrupted = "wake";
  assistant.fired("interrupted", thread, {
    thread,
    turnId: "job-9",
    title: "a turn that did not finish",
    detail: "the same finish, seen by another rule",
    terminal: { thread, key },
  });
  await wait();
  assert.equal(said.length, 1, "one finish is still one turn");
  assert.equal(once(assistant).length, 1, "and the journal says why the second rule did not wake");
});

test("a finish notice refused by a switched-off assistant is delivered when it is switched back on", async (t) => {
  const { assistant, said } = await board(t, 6);
  assistant.settings.rearmSeconds = 0;
  assistant.settings.enabled = false;
  const thread = "wtgui-off-finish-ccc333";
  const key = "job-11|2026-11-03T00:22:54.748Z";
  const alertOf = () =>
    assistant.fired("watch", "the watch lands|finished", {
      thread,
      turnId: "job-11",
      title: "watch finished: the watch lands",
      detail: "Task #10 — propose how rules attach to stages ended normal",
      terminal: { thread, key },
    });

  const first = alertOf();
  assert.ok(first, "the watch's alert is filed even with the assistant off");
  assert.equal(said.length, 0, "a switched-off assistant starts no turn");
  assert.equal(assistant.terminalWakes.get(thread), undefined, "and the refusal did not spend the finish's claim");

  assistant.settings.enabled = true;
  first.status = "dismissed";
  alertOf();
  await wait();
  assert.equal(said.length, 1, "switching it back on delivers the finish it was never told about");
  assert.match(said[0].text, /\[watch\] watch finished: the watch lands/);
  assert.equal(assistant.terminalWakes.get(thread), key);
});

// The two pieces #69 must NOT move: the class still comes from the RULE (#252), and the 150 ms window still makes
// one turn out of the wakes that arrive together. Both are asserted here because a claim moved around the queue is
// exactly where a "send it now" shortcut would creep in.
test("the event/sweep class and the coalescing window are untouched", async (t) => {
  const { assistant, said } = await board(t, 0);
  const event = assistant.wake("Something settled", null, "watch");
  const sweep = assistant.wake("a quiet thing", null, "quiet");
  assert.equal(event.queued, true, "an event is admitted with the hour at zero");
  assert.equal(sweep.refused, "budget", "a sweep is still budgeted");
  assert.equal(assistant.wakes.length, 0, "and the event spent nothing — an event is not a sweep");
  await wait();
  assert.equal(said.length, 1, "the 150 ms window still turns the tick's wakes into one turn");
  assert.equal(said[0].origin?.event, true, "and the turn is told which class it is");
});
