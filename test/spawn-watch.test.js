// The spawn watchdog: a card that never becomes a worker.
//
// A SPAWN line at `ask` produces an alert and stops — no job, no thread, no row, no git command — so the card
// was the one thing on the board nothing ever looked at again. These four cases are the contract: a run that
// appears in time is silent, a card with nothing behind it is named once with its age and its tree, the
// auto-start switch starts it exactly once, and a card the reader cancelled is never revived.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";

// Two minutes is the panel's deadline and a test cannot wait for it: the timer reads this field when it arms,
// so shortening it here is the whole of the fake clock. The sweep takes a `now`, which is how the "it does not
// fire twice" half is driven without waiting at all.
const WATCH_MS = 25;
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

async function board(t, { jobs = { list: () => [] }, spawner = null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-spawn-watch-"));
  const assistant = new Assistant({
    config: {
      jobsFile: path.join(dir, "jobs.json"),
      defaultCwd: dir,
      assistantFile: path.join(dir, "assistant.json"),
      charterFile: path.join(dir, "assistant-charter.md"),
    },
    jobs,
    getProjects: () => [{ name: "wtgui", path: path.join(dir, "wtgui"), mainBranch: "main", remote: "origin" }],
    spawner,
    onEvent: () => {},
    onLog: () => {},
  });
  assistant.spawnWatchMs = WATCH_MS;
  t.after(async () => {
    for (const id of [...assistant.spawnTimers.keys()]) assistant.disarmSpawnWatch(id);
    if (assistant.timer) clearInterval(assistant.timer);
    await rm(dir, { recursive: true, force: true });
  });
  return { assistant, dir };
}

const cardOf = (assistant, id) => assistant.alerts.find((a) => a.id === id);
const kinds = (assistant, kind) => assistant.journal.filter((j) => j.kind === kind);

test("a card whose run appears before the deadline is closed without a word", async (t) => {
  const rows = [];
  const { assistant, dir } = await board(t, { jobs: { list: () => rows } });
  const tree = path.join(dir, "wtgui", ".worktrees", "write-the-docs-abc123");
  const card = assistant.addSpawnAlert({ target: tree, existing: true, prompt: "write the docs" });
  // The reader presses Start (or starts the same work from the New-agent card): the run exists before the
  // watchdog's deadline, and the card says so on its own.
  rows.push({ id: "job-1", thread: "wtgui-write-the-docs", status: "running", cwd: tree, ownerPath: tree, prompt: "write the docs" });
  await settle();

  const after = cardOf(assistant, card.id);
  assert.equal(after.status, "done", "the card is closed against the run that exists");
  assert.equal(after.startedJob, "job-1");
  assert.equal(after.stuck, undefined, "nothing was raised against it");
  assert.equal(kinds(assistant, "spawn-unstarted").length, 0, "silent: no journal line either");
  assert.equal(kinds(assistant, "spawn-started").length, 1, "only the quiet record that it was settled");
  assert.equal(assistant.spawnTimers.size, 0, "and its timer is gone");
  assert.equal(assistant.state().spawnCards.open, 0, "nothing left waiting on the reader");
});

test("a card with no run behind it is named after the deadline — age, tree and all", async (t) => {
  const { assistant } = await board(t);
  const card = assistant.addSpawnAlert({ target: "wtgui", existing: false, prompt: "write the docs" });
  await settle();

  const after = cardOf(assistant, card.id);
  assert.equal(after.status, "open", "the card is still the reader's to press");
  assert.equal(after.stuck, true, "and it is marked as the thing the watchdog found");
  assert.equal(after.severity, "bad");
  assert.match(after.detail, /NEVER STARTED/, "the card says it in words");
  const tree = after.evidence.find((e) => e.label === "tree");
  assert.ok(tree && /wtgui\/\.worktrees\//.test(tree.value), `the evidence names the tree it would have cut: ${JSON.stringify(tree)}`);
  assert.ok(after.evidence.some((e) => e.label === "card age"), "and how old the card is");

  const raised = kinds(assistant, "spawn-unstarted");
  assert.equal(raised.length, 1, "journaled once, as spawn-unstarted");
  assert.match(raised[0].text, /write the docs/, "naming the card");
  assert.match(raised[0].text, /wtgui\/\.worktrees\//, "and the worktree path");

  // The digest is what the assistant reads on every turn: a card nobody started has to be in it, or a small
  // model reads the silence as "queued" and tells the reader the work is under way.
  assert.match(assistant.digest(), /Spawn cards the reader has NOT started/);

  // Its own count, not the alerts inbox: the header badge reads `spawnCards`, and the alert count that the
  // bell badge shows leaves these out.
  const st = assistant.state();
  assert.equal(st.spawnCards.open, 1);
  assert.equal(st.spawnCards.unstarted, 1);
  assert.equal(st.alerts.filter((a) => !a.spawn).length, 0, "no non-spawn alert was invented");

  // One pass per deadline, however often the clock is asked: the mark lives on the card.
  assistant.checkSpawnWatches(Date.now() + 600_000);
  assert.equal(kinds(assistant, "spawn-unstarted").length, 1);
  assert.equal(cardOf(assistant, card.id).evidence.filter((e) => e.label === "card age").length, 1);
});

test("auto-start starts the pending spawn exactly once", async (t) => {
  const calls = [];
  const { assistant } = await board(t, {
    spawner: async (spec) => {
      calls.push(spec);
      return { id: "job-9", thread: "wtgui-write-the-docs", origin: { kind: "assistant-spawn", project: spec.project } };
    },
  });
  assistant.setSettings({ spawnAutoStart: true });
  assert.equal(assistant.settings.spawnAutoStart, true, "the switch is a real setting");

  const card = assistant.addSpawnAlert({ target: "wtgui", existing: false, prompt: "write the docs" });
  await settle();

  assert.equal(calls.length, 1, "started once, through the same spawner the Start button uses");
  assert.equal(calls[0].project, "wtgui", "with the project name resolved, not the bare path the card holds");
  assert.equal(cardOf(assistant, card.id).status, "done", "the card closes on the run it started");
  assert.equal(cardOf(assistant, card.id).startedJob, "job-9");
  assert.equal(kinds(assistant, "spawn-unstarted").length, 0);

  // A later pass must not find anything to do: the card is closed, and the attempt is recorded on it.
  assistant.checkSpawnWatches(Date.now() + 600_000);
  await settle(40);
  assert.equal(calls.length, 1, "never a second press");
});

test("auto-start never retries a spawn it already tried", async (t) => {
  const calls = [];
  const { assistant } = await board(t, {
    spawner: async () => {
      calls.push(1);
      throw new Error("the Hermes gateway API is not usable at http://127.0.0.1:8642");
    },
  });
  assistant.setSettings({ spawnAutoStart: true });
  const card = assistant.addSpawnAlert({ target: "wtgui", existing: false, prompt: "write the docs" });
  await settle();

  assert.equal(calls.length, 1, "one attempt");
  const after = cardOf(assistant, card.id);
  assert.equal(after.stuck, true, "a refusal goes back to the reader as a loud card");
  assert.match(after.detail, /auto-start refused/);
  assert.equal(kinds(assistant, "spawn-unstarted").length, 1);

  assistant.checkSpawnWatches(Date.now() + 600_000);
  await settle(40);
  assert.equal(calls.length, 1, "and no second attempt, however often the clock is asked");
});

test("a spawn card the reader cancelled is never auto-started", async (t) => {
  const calls = [];
  const { assistant } = await board(t, {
    spawner: async (spec) => {
      calls.push(spec);
      return { id: "job-x", thread: "wtgui-x" };
    },
  });
  assistant.setSettings({ spawnAutoStart: true });
  const card = assistant.addSpawnAlert({ target: "wtgui", existing: false, prompt: "write the docs" });
  assistant.alertAction(card.id, "dismiss");
  await settle();

  assert.equal(calls.length, 0, "a discarded card is not a pending spawn");
  assert.equal(cardOf(assistant, card.id).status, "dismissed");
  assert.equal(kinds(assistant, "spawn-unstarted").length, 0, "and it is not reported as never started either");
  assert.equal(assistant.state().spawnCards.open, 0);

  // Even a stale pass, as a restart could produce, cannot revive it.
  assistant.checkSpawnWatches(Date.now() + 600_000);
  await settle(40);
  assert.equal(calls.length, 0);
});

test("a panel restart re-arms the deadline and does not report the same card twice", async (t) => {
  const { assistant: first, dir } = await board(t);
  const card = first.addSpawnAlert({ target: "wtgui", existing: false, prompt: "write the docs" });
  await settle();
  assert.equal(kinds(first, "spawn-unstarted").length, 1);
  first.writeNow(); // the scratchpad the next process will read

  // A second process on the same file: the watchdog's mark is on the card, so its deadline is history rather
  // than a second report — and with auto-start off nothing is started either.
  const second = new Assistant({
    config: {
      jobsFile: path.join(dir, "jobs.json"),
      defaultCwd: dir,
      assistantFile: path.join(dir, "assistant.json"),
      charterFile: path.join(dir, "assistant-charter.md"),
    },
    jobs: { list: () => [] },
    getProjects: () => [{ name: "wtgui", path: path.join(dir, "wtgui"), mainBranch: "main", remote: "origin" }],
    spawner: null,
    onEvent: () => {},
    onLog: () => {},
  });
  second.spawnWatchMs = WATCH_MS;
  t.after(() => {
    for (const id of [...second.spawnTimers.keys()]) second.disarmSpawnWatch(id);
  });
  // The journal itself is persisted with the card, so the first process's line is loaded — what a restart must
  // not do is add another one.
  const carried = kinds(second, "spawn-unstarted").length;
  const journalLength = second.journal.length;
  assert.equal(carried, 1, "the file carries the one line the first process wrote");
  second.checkSpawnWatches(Date.now() + 600_000);
  await settle(40);

  assert.equal(cardOf(second, card.id).stuck, true, "the card is still the loud one it was");
  assert.equal(kinds(second, "spawn-unstarted").length, carried, "and the restart did not shout a second time");
  assert.equal(second.journal.length, journalLength, "no new journal line at all");
  assert.equal(kinds(second, "spawn-started").length, 0);
});
