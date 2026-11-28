// The panel watchdog's alert, delivered by OWNER.
//
// WHAT THIS FILE IS THE CONTRACT FOR. The panel has ONE watchdog. Its announce used to be one turn on Assistant
// #1's page whatever queue or thread the run came from, and the line named nobody: a reader looking at #1's
// transcript could not tell whose row a LONG RUN was about, and the assistant whose queue held the row never saw
// it. Row #412 asked for three things, and this file pins all three:
//
//   1. every line names the OWNING assistant, resolved from the row's queue first and the job's thread after it -
//      never guessed, and "owner unknown" when nothing on the board can say;
//   2. the alert is delivered to the owner's page AND wakes as well as to the sentry's own page, with the owner's
//      escalateTo entries as an EXTRA set of recipients;
//   3. one stored record, one alert id on every copy, one wake per assistant - so a later settle closes the one
//      record both pages point at.
//
// The assistant is driven directly, with `say` captured and the wake queue inspected: the routing decision is what
// is under test, not the HTTP route or the turn the wake would eventually send.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ASSISTANT_THREAD, Assistant } from "../lib/assistant.js";
import { PRIMARY_ASSISTANT, threadFor } from "../lib/assistants.js";
import { sweepBoard } from "../lib/panel-watch.js";

const T0 = Date.parse("2026-11-28T03:40:00.000Z");
const MINUTE = 60_000;
const iso = (ms = 0) => new Date(T0 + ms).toISOString();
const TREE = "C:/ProjectDevelopment/agent-worktree-gui/.worktrees/row-401-investigate";
const THREE = [
  { id: "assistant-1", name: "Assistant #1", threadId: ASSISTANT_THREAD, rules: [] },
  { id: "assistant-2", name: "Assistant #2", threadId: threadFor("assistant-2"), rules: [] },
  { id: "assistant-3", name: "Assistant #3", threadId: threadFor("assistant-3"), rules: [] },
];

// The run the reader's screenshot named: 64 minutes in, carrying row #401 of Assistant #3's queue.
const LONG = {
  id: "7a9f9a57",
  thread: "wtgui-row-401-investigate-4cd303",
  runId: "run_401_aaaaaaaa",
  title: "Investigate dropped SPAWN lines in row 401",
  status: "running",
  worktreePath: TREE,
  startedAt: iso(-64 * MINUTE),
};

const row = (over = {}) => ({
  id: 401,
  title: LONG.title,
  state: "running",
  thread: LONG.thread,
  threads: [LONG.thread],
  runId: LONG.runId,
  worktree: TREE,
  ...over,
});

async function panel(t, { jobs = [LONG], queues = {}, escalateTo = null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-watchdog-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  await writeFile(path.join(dir, "assistants.json"), JSON.stringify({ version: 1, assistants: THREE }));
  for (const [id, tasks] of Object.entries(queues)) {
    const file = path.join(dir, "assistants", id, "queue.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, nextId: 900, tasks }));
  }
  for (const [id, list] of Object.entries(escalateTo || {})) {
    const file = path.join(dir, "assistants", id, "settings.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ escalateTo: list }));
  }
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile },
    jobs: {
      list: () => jobs,
      get: (id) => jobs.find((j) => j.id === id) || null,
      firstOfThread: (thread) => jobs.find((j) => j.thread === thread) || null,
    },
    getProjects: () => [],
    onLog: () => {},
  });
  // The ledger turn is captured, not started: there is no gateway here. The real `wake` below still decides, so
  // the queue's per-assistant grouping is exercised rather than re-implemented.
  const said = [];
  assistant.say = async (text, opts = {}) => {
    said.push({ text, opts });
    return { id: "ledger-turn" };
  };
  const settled = () => {
    clearTimeout(assistant.wakeTimer);
    assistant.wakeTimer = null;
  };
  const ownerOf = (job) => assistant.sentryOwnerOf(job);
  return { assistant, said, settled, ownerOf, dir };
}

test("a long run in Assistant #3's queue alerts BOTH pages, names assistant-3, and carries one id", async (t) => {
  const { assistant, said, settled, ownerOf } = await panel(t, { queues: { "assistant-3": [row()] } });

  // The sweep, as the tool builds it: the line is labelled from the panel's own resolver.
  const pass = sweepBoard({ jobs: [LONG], store: { jobs: [LONG] }, state: null, now: T0, ownerOf });
  assert.equal(pass.items.length, 1);
  assert.equal(pass.items[0].owner, "assistant-3", "the queue row's directory is the owner");
  assert.match(pass.items[0].line, /^LONG RUN 7a9f9a57 - Investigate dropped SPAWN lines in row 401 has been running 64 min \(owner: assistant-3\)$/);

  const out = await assistant.announceWatchdog(pass.items);
  settled();

  // 1. The sentry's own page keeps its ledger turn, and the words name the owner.
  assert.equal(said.length, 1, "one ledger turn on the sentry's page");
  assert.match(said[0].text, /^Watchdog: LONG RUN 7a9f9a57 - /);
  assert.match(said[0].text, /\(owner: assistant-3\)/);
  assert.equal(said[0].opts.assistantId, PRIMARY_ASSISTANT, "the ledger turn is Assistant #1's");

  // 2. The owner is woken, with the SAME alert id the ledger turn names.
  const queued = assistant.pendingWake;
  assert.equal(queued.length, 1, "one wake, for the owner");
  assert.equal(queued[0].assistantId, "assistant-3");
  assert.equal(queued[0].rule, "watchdog");
  assert.equal(queued[0].alertId, out.alerts[0].id, "the wake carries the alert's own id");
  assert.ok(said[0].opts.origin.alerts.includes(out.alerts[0].id), "the ledger turn names the same id");
  assert.match(queued[0].reason, /assistant-3/, "the wake names the owner too");

  // 3. ONE stored record. Its page is the OWNER's: the alert row is drawn where the assistant that can act on it
  // reads its alerts. The sentry's page keeps the ledger turn above, which is the copy it has always had.
  assert.equal(assistant.alerts.length, 1, "one record, not one per recipient");
  const rows = assistant.state().alerts.filter((a) => a.id === out.alerts[0].id);
  assert.deepEqual(rows.map((a) => a.assistantId), ["assistant-3"], "the alert row is on the owner's page");
  assert.match(rows[0].title, /assistant-3/, "and its words name the owner");
  assert.deepEqual(assistant.alertDeliveries(assistant.alerts[0]), ["assistant-3", "assistant-1"], "owner first, then the ledger");

  // 4. A second pass keeps the one record and its id: a long run is a live condition, not a new alert each time.
  const again = await assistant.announceWatchdog(pass.items);
  settled();
  assert.deepEqual(again.alerts.map((a) => a.id), out.alerts.map((a) => a.id), "the record is re-used, same id");
  assert.equal(assistant.alerts.length, 1, "still one record");
});

test("Assistant #1's own long run is unchanged: its page gets the alert and nobody else does", async (t) => {
  const { assistant, said, settled, ownerOf } = await panel(t, {
    queues: { "assistant-1": [row({ id: 405, thread: "wtgui-row-405-one-own", runId: "run_405_bbbbbbbb" })] },
  });
  const job = { ...LONG, id: "521eeae2", thread: "wtgui-row-405-one-own", runId: "run_405_bbbbbbbb", title: "one's own long run" };
  const pass = sweepBoard({ jobs: [job], store: { jobs: [job] }, state: null, now: T0, ownerOf });
  assert.match(pass.items[0].line, /\(owner: assistant-1\)$/);

  const out = await assistant.announceWatchdog(pass.items);
  settled();
  assert.match(said[0].text, /\(owner: assistant-1\)/);
  assert.equal(assistant.pendingWake.length, 0, "the ledger turn already is Assistant #1's copy");
  const rows = assistant.state().alerts.filter((a) => a.id === out.alerts[0].id);
  assert.deepEqual(rows.map((a) => a.assistantId), ["assistant-1"]);
});

test("a run nothing on the board can own says owner unknown, and is not handed to Assistant #1 by name", async (t) => {
  const { assistant, said, settled, ownerOf } = await panel(t, { queues: {} });
  const pass = sweepBoard({ jobs: [LONG], store: { jobs: [LONG] }, state: null, now: T0, ownerOf });
  assert.match(pass.items[0].line, /\(owner unknown\)$/);
  assert.equal(pass.items[0].owner, null);

  const out = await assistant.announceWatchdog(pass.items);
  settled();
  assert.match(said[0].text, /\(owner unknown\)$/);
  assert.doesNotMatch(said[0].text, /assistant-1/, "the text does not claim Assistant #1 owns it");
  assert.equal(assistant.pendingWake.length, 0, "there is nobody to wake");
  const rows = assistant.state().alerts.filter((a) => a.id === out.alerts[0].id);
  assert.deepEqual(rows.map((a) => a.assistantId), ["assistant-1"], "the sentry's page files an unowned alert, and says so in the words");
  assert.equal(assistant.alerts[0].watchdog.ownerUnknown, true);
});

test("the owner's escalateTo list is an EXTRA recipient, never a replacement", async (t) => {
  const { assistant, said, settled, ownerOf } = await panel(t, {
    queues: { "assistant-3": [row()] },
    escalateTo: { "assistant-3": ["assistant-2"] },
  });
  const pass = sweepBoard({ jobs: [LONG], store: { jobs: [LONG] }, state: null, now: T0, ownerOf });
  const out = await assistant.announceWatchdog(pass.items);
  settled();
  assert.match(said[0].text, /\(owner: assistant-3\)/, "the ledger still gets it");
  assert.deepEqual(
    assistant.pendingWake.map((w) => w.assistantId).sort(),
    ["assistant-2", "assistant-3"],
    "the owner and the escalation target are both woken",
  );
  assert.ok(assistant.pendingWake.every((w) => w.alertId === out.alerts[0].id), "all copies carry the one id");
  const rows = assistant.state().alerts.filter((a) => a.id === out.alerts[0].id);
  assert.deepEqual(rows.map((a) => a.assistantId), ["assistant-3"], "the owner's page holds the one row");
  assert.deepEqual(assistant.alertDeliveries(assistant.alerts[0]), ["assistant-3", "assistant-1", "assistant-2"]);
});

test("the record closes when the run stops running, and the owner's row goes with it", async (t) => {
  const { assistant, settled, ownerOf } = await panel(t, { queues: { "assistant-3": [row()] } });
  const pass = sweepBoard({ jobs: [LONG], store: { jobs: [LONG] }, state: null, now: T0, ownerOf });
  const out = await assistant.announceWatchdog(pass.items);
  settled();
  assert.equal(assistant.alerts.filter((a) => a.id === out.alerts[0].id && a.status === "open").length, 1);

  // The run settles. The next sentry pass sees it is no longer running and closes the one record.
  assistant.evaluate([{ ...LONG, status: "done", endedAt: iso(0) }], T0 + MINUTE);
  assert.equal(assistant.alerts[0].status, "done", "the condition stopped being true");
  assert.equal(assistant.state().alerts.filter((a) => a.id === out.alerts[0].id).length, 0, "no page shows it any more");
});
