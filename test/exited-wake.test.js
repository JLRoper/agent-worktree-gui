// The EXITED rule: a failed run is the card's EXITED chip, and it wakes the assistant once — not on a repaint,
// not again after a reload, and not at all when a repair turn has taken the failure over.
//
// The detector is `Assistant.checkExit` in lib/assistant.js. It keys off the run's own `status` (the store's
// summary), never the page's DOM: the float can be closed, the page reloaded, and the sweep still sees the run.
// `evaluate` calls it on the sentry's own clock, and `observe` calls it at the settle so a threshold of 0 wakes on
// the transition itself. This file drives both paths, because the wiring is half the claim.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant, ASSISTANT_THREAD, RULE_DEFS } from "../lib/assistant.js";
import { AGGRESSIVE, DEFAULTS } from "../lib/assistant/config.js";
import { completionPayload, terminalKey } from "../lib/completion.js";

const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const TREE = (n = 1) => ({
  exists: true,
  path: "C:/repo/.worktrees/exited-the-panel-aaa111",
  branch: "wtgui/exited-the-panel-aaa111",
  base: "aa11bb22",
  commits: n,
  subjects: n ? ["c0ffee1 stub the exit"] : [],
  dirty: 0,
  untracked: 0,
  pending: false,
  at: Date.now() - 1_000,
});

function configFor(dir) {
  return {
    jobsFile: path.join(dir, "jobs.json"),
    assistantFile: path.join(dir, "assistant.json"),
    charterFile: path.join(dir, "assistant-charter.md"),
    defaultCwd: dir,
  };
}

function assistantFor(dir, rows, said, extra = {}) {
  const assistant = new Assistant({
    config: configFor(dir),
    jobs: { list: () => rows },
    getProjects: () => [],
    onEvent: () => {},
    onLog: () => {},
    ...extra,
  });
  assistant.say = async (text, opts = {}) => {
    said.push({ text: String(text), origin: opts.origin || null });
    return { id: `said-${said.length}` };
  };
  return assistant;
}

async function board(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-exited-"));
  const said = [];
  const rows = [];
  const assistant = assistantFor(dir, rows, said);
  t.after(async () => {
    if (assistant.timer) clearInterval(assistant.timer);
    if (assistant.settleTimer) clearTimeout(assistant.settleTimer);
    if (assistant.wakeTimer) clearTimeout(assistant.wakeTimer);
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, assistant, said, rows };
}

// A settled card, shaped the way `jobs.summary` hands it to the observer: the completion payload is built by
// `jobs.finalise` at the settle, from the run's own result and the tree measured after it.
function settled({
  id = "job-1",
  thread = "wtgui-exited-the-panel-aaa111",
  turn = 1,
  status = "failed",
  assistant = false,
  finalMessage = "blocked: no gateway key in .env",
  tree = TREE(),
  at = Date.now(),
  startedAt = null,
  outcome = null,
} = {}) {
  const job = {
    id,
    thread,
    turn,
    status,
    assistant,
    label: null,
    startedAt: startedAt || new Date(at - 61_000).toISOString(),
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

const exits = (assistant) => assistant.alerts.filter((a) => a.rule === "exited");

test("the rule ships at wake, with a threshold and an aggressive profile that fires at once", () => {
  assert.equal(RULE_DEFS.exited?.default, "wake", "a failed run with no watch is the board's news");
  assert.equal(RULE_DEFS.exited?.label, "Run exited");
  assert.equal(DEFAULTS.exitedSeconds, 30, "the default waits long enough for a repair to take over");
  assert.equal(AGGRESSIVE.exitedSeconds, 0, "aggressive mode notices at the transition");
});

test("a failed run wakes once, after its threshold, carrying the EXITED payload", async (t) => {
  const { assistant, said } = await board(t);
  const job = settled();
  const at = Date.parse(job.endedAt);

  assert.equal(assistant.checkExit(job, at + 1_000), null, "under the threshold it is not a wake yet");
  assert.equal(said.length, 0);
  assert.equal(exits(assistant).length, 0);

  const alert = assistant.checkExit(job, at + 31_000);
  await wait();

  assert.equal(said.length, 1, "one failed run is one wake");
  const text = said[0].text;
  assert.match(text, /\[exited\]/, "the wake names the rule it came from");
  assert.match(text, /is EXITED/, "it uses the card's own word");
  assert.match(text, /exit code 1 \(max_turns\)/, "the reason the run ended that way");
  assert.match(text, /the worker's final message:/, "the completion payload rides with the wake");
  assert.match(text, /blocked: no gateway key in \.env/, "and it is the worker's own words");
  assert.match(text, /left 1 commit not on aa11bb22/, "what the branch now holds");
  assert.equal(said[0].origin?.kind, "assistant-wake", "it goes out as a wake, not as a reply");

  assert.equal(alert?.rule, "exited");
  assert.equal(alert?.thread, job.thread);
  assert.equal(alert?.turnId, job.id);
  assert.equal(alert?.severity, "warn");
  assert.ok(assistant.exitSeen.has(terminalKey(job)), "the terminal key is taken exactly once");
});

test("the same failed run seen again is not a second wake", async (t) => {
  const { assistant, said, rows } = await board(t);
  const job = settled();
  const at = Date.parse(job.endedAt);
  rows.push(job);

  assistant.checkExit(job, at + 31_000);
  await wait();
  assert.equal(said.length, 1, "the transition woke it once");

  // The card is re-emitted as its measurement lands, as a title arrives and on every reload; the sweep sees it
  // again on the next pass. None of those is a second finish.
  const same = { ...job, completion: completionPayload({ ...job, tree: TREE() }) };
  assistant.checkExit(same, at + 40_000, rows);
  assistant.evaluate(rows, at + 40_000);
  assistant.observe({ type: "job", job: same });
  await wait();

  assert.equal(said.length, 1, "one failed run is one wake, however many times the card is drawn");
  assert.equal(exits(assistant).length, 1, "and one alert");
});

test("a repair run on the same thread takes the failure over, and the failed card wakes nobody", async (t) => {
  const { assistant, said, rows } = await board(t);
  const failed = settled({ id: "job-broken", thread: "wtgui-repair-the-panel-bbb222" });
  const repair = settled({
    id: "job-repair",
    thread: failed.thread,
    turn: 2,
    status: "done",
    finalMessage: "Done — the fix is in and the suite is green.",
    at: Date.now() + 6_000,
  });
  rows.push(failed, repair);

  assistant.checkExit(failed, Date.now() + 31_000, rows);
  await wait();

  assert.equal(said.length, 0, "a newer run on the thread is a repair, not a failure to report");
  assert.equal(exits(assistant).length, 0);
  assert.ok(assistant.exitSeen.has(terminalKey(failed)), "the failed card is recorded as taken over");

  // A done run is never this rule's, whichever way it is seen.
  assistant.checkExit(repair, Date.now() + 31_000, rows);
  assistant.evaluate([repair], Date.now() + 31_000);
  await wait();
  assert.equal(said.length, 0, "the repair's own completion is the settle rule's, not an EXITED wake");
});

test("turning the rule off keeps it in the journal and sends no wake", async (t) => {
  const { assistant, said } = await board(t);
  const job = settled({ id: "job-off" });
  const at = Date.parse(job.endedAt);

  assistant.settings.rules.exited = "log";
  assistant.checkExit(job, at + 31_000);
  await wait();

  assert.equal(said.length, 0, "a rule the reader left at log wakes nobody");
  assert.equal(exits(assistant).length, 0, "and files no alert");
  assert.ok(
    assistant.journal.some((j) => j.kind === "exited" && /EXITED/.test(j.text)),
    "the transition is still in the journal the digest reads",
  );

  // The transition happened while the rule was off; turning it back on must not back-fill an old failure.
  assistant.settings.rules.exited = "wake";
  assistant.checkExit(job, at + 32_000);
  await wait();
  assert.equal(said.length, 0, "a rule switched on later does not wake about a finish it missed");
});

test("a threshold of 0 fires on the settle event itself — the transition, not a later sweep", async (t) => {
  const { assistant, said } = await board(t);
  assistant.settings.exitedSeconds = 0;
  const job = settled({ id: "job-event" });

  assistant.observe({ type: "job", job });
  await wait();

  assert.equal(said.length, 1, "the event is the transition, and the zero threshold takes it at once");
  assert.match(said[0].text, /\[exited\]/);

  assistant.observe({ type: "job", job });
  await wait();
  assert.equal(said.length, 1, "the same event twice is still one finish");
});

test("the sentry's own pass notices a failed run it did not see settle", async (t) => {
  const { assistant, said, rows } = await board(t);
  const job = settled({ id: "job-sweep" });
  const at = Date.parse(job.endedAt);
  rows.push(job);

  assistant.evaluate(rows, at + 1_000);
  await wait();
  assert.equal(said.length, 0, "under the threshold the sweep says nothing");

  assistant.evaluate(rows, at + 31_000);
  await wait();
  assert.equal(said.length, 1, "the per-turn pass is what carries the rule when the float is closed");
  assert.match(said[0].text, /\[exited\]/);
});

test("a failed run the assistant started, or one that ended before this process, wakes nobody", async (t) => {
  const { assistant, said } = await board(t);
  const mine = settled({ id: "own-1", thread: "wtgui-some-worker-111111", assistant: true });
  const named = settled({ id: "own-2", thread: ASSISTANT_THREAD });
  const old = settled({ id: "job-old", at: Date.now() - 3 * 3600_000 });

  assistant.checkExit(mine, Date.now() + 31_000);
  assistant.checkExit(named, Date.now() + 31_000);
  assistant.checkExit(old, Date.now() + 31_000);
  await wait();

  assert.equal(said.length, 0, "a self-wake or a card from the store's history is not news");
  assert.equal(exits(assistant).length, 0);
});

test("the rule's bar and its escalation survive a reload", async (t) => {
  const { dir, assistant } = await board(t);
  const rows = [];
  const said = [];
  assistant.setSettings({ exitedSeconds: 5, rules: { exited: "log" } });
  assistant.writeNow();

  const reloaded = assistantFor(dir, rows, said);
  t.after(() => {
    if (reloaded.timer) clearInterval(reloaded.timer);
    if (reloaded.settleTimer) clearTimeout(reloaded.settleTimer);
    if (reloaded.wakeTimer) clearTimeout(reloaded.wakeTimer);
  });

  assert.equal(reloaded.settings.exitedSeconds, 5, "the bar came back off disk");
  assert.equal(reloaded.settings.rules.exited, "log", "and so did the escalation");
});
