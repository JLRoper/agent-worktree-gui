// A TO line starts at most one run, and a thread carries at most one run at a time - across a restart, and across
// two TOs released together.
//
// The defect this file is the contract for, measured on the 05:26:25Z boot (listener PID 58580, up since 05:25:55Z):
// the panel re-read two stored replies on wtgui-read-row-169-in-c-users-rope-d2c545 - the 03:50 TO and the 03:55
// landing TO - and started TWO run rows on that thread in the same second. The replayed landing instruction would
// have re-landed PR #806, which had merged at 03:55:40Z; it only stopped at a 401.
//
// Two holes, one property:
//   1. THE KEY. QUEUE and MESSAGE are keyed by the turn that wrote them and the line's place in it, and a second
//      carry of the same key is refused by name (lib/assistant.js `carryKeyFor` / `carriedLine`). The TO block had
//      no key at all, and `harvested` is a 50-id window a boot starts empty, so a stored turn whose delivery had
//      ENDED read as never delivered.
//   2. THE GUARD. `Jobs.busyFor` is right about the store, but it is consulted before the run is IN the store:
//      `jobs.create` awaits a session probe and a lost-session read, so two TOs released in one pass both read
//      "free". The claim has to be taken synchronously, before the send.
//
// What is pinned:
//   · a replay after a store restart delivers nothing and says `to-replay-refused`, naming the thread, the turn and
//     the delivery that already happened;
//   · two TOs to one thread in one harvest start ONE run and say `to-skipped` for the second;
//   · a thread whose run is live still refuses a TO, and still with `to-skipped` (the guard this file must not
//     weaken);
//   · the key is the LINE, not its words: the same instruction from a new turn is delivered again.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ASSISTANT_THREAD, Assistant } from "../lib/assistant.js";
import { isLiveJobStatus } from "../lib/jobs.js";

const run = promisify(execFile);
const wait = (ms = 160) => new Promise((r) => setTimeout(r, ms));
const THREAD = "wtgui-read-row-169-in-c-users-rope-d2c545";

// A job store with the ONE property the defect needs: `create` is asynchronous, exactly like `Jobs.create`, which
// awaits `lostSessionOf` and a gateway probe before the run exists in `this.jobs`. `busyFor` is the real store's
// rule, read off the same rows, so the guard is the shipped one and only its TIMING is in question.
function store() {
  const rows = [];
  const created = [];
  let seq = 0;
  const firstOfThread = (thread) => rows.find((r) => r.thread === thread) || null;
  const busyFor = (thread) => {
    const live = rows.filter((r) => isLiveJobStatus(r.status));
    const onThread = live.filter((r) => r.thread === thread);
    if (onThread.length) return { held: true, where: "thread", thread, by: onThread };
    const first = firstOfThread(thread);
    const tree = first ? first.cwd || null : null;
    if (!tree) return { held: false, where: null, thread, by: [] };
    const inTree = live.filter((r) => r.thread !== thread && r.cwd === tree);
    if (inTree.length) return { held: true, where: "tree", thread, tree, by: inTree };
    return { held: false, where: null, thread, tree, by: [] };
  };
  return {
    rows,
    created,
    list: () => rows,
    get: (id) => rows.find((r) => r.id === id) || null,
    firstOfThread,
    busyFor,
    modelFor: () => null,
    async create(body = {}) {
      // The window the second TO used to slip through: the run exists only after this await, and nothing else the
      // panel holds says a run for this thread is on its way.
      await wait(8);
      seq += 1;
      const row = {
        id: `job-${seq}`,
        thread: body.thread,
        status: "starting",
        cwd: body.cwd || null,
        prompt: String(body.prompt || ""),
      };
      rows.push(row);
      created.push(row);
      return row;
    },
  };
}

async function panel(t, { dir: given = null, seedRows = null } = {}) {
  const dir = given || (await mkdtemp(path.join(os.tmpdir(), "wtgui-to-replay-")));
  if (!given) {
    t.after(() => rm(dir, { recursive: true, force: true }));
    // A real git tree: `answerThread` resolves the thread's tree through own-tree.js, which asks git, so an empty
    // folder would be refused as "not a tree of its own" and the TO would never reach the store.
    await run("git", ["init", "-q", dir]);
    await run("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root"]);
  }
  const jobs = store();
  // The thread a TO replies to, in its own tree, with its run ENDED: the ordinary state a stored turn is re-read in.
  jobs.rows.push(...(seedRows || [{ id: "job-seed", thread: THREAD, status: "done", cwd: dir }]));
  const assistantFile = path.join(dir, "assistant.json");
  if (!given) {
    await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  }
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile, defaultCwd: dir },
    jobs,
    getProjects: () => [],
    getRows: () => [],
    onEvent: () => {},
    onLog: () => {},
  });
  // `auto` is the autonomy that SENDS: at `draft` a TO only raises a card, and a card is not the run this file counts.
  assistant.setSettings({ autonomy: "auto" });
  t.after(() => {
    for (const timer of [assistant.persistTimer, assistant.wakeTimer, assistant.timer, assistant.settleTimer]) clearTimeout(timer);
  });
  return { assistant, dir, jobs };
}

const turn = (id, text) => ({
  id,
  thread: ASSISTANT_THREAD,
  assistantId: "assistant-1",
  turn: 1,
  status: "done",
  startedAt: new Date(Date.now() - 300_000).toISOString(),
  endedAt: new Date().toISOString(),
  lines: [{ kind: "text", text, at: Date.now() - 120_000 }],
});

const kinds = (assistant, kind) => assistant.journal.filter((j) => j.kind === kind);

test("a restart re-reads an old turn and its TO is not delivered twice", async (t) => {
  const first = await panel(t);
  const text = `The landing came back clean, so the row is closed.\nTO ${THREAD}: carry on with the tests and land them`;
  await first.assistant.harvest(turn("turn-old", text));
  await wait();
  assert.equal(first.jobs.created.length, 1, "the TO started one run");
  assert.equal(first.jobs.created[0].thread, THREAD);
  assert.equal(kinds(first.assistant, "sent").length, 1, "and the panel said so");
  // The delivery has ENDED by the time a boot re-reads the turn: that is exactly the state `busyFor` cannot answer
  // for, and why the key has to.
  first.jobs.rows.find((r) => r.id === first.jobs.created[0].id).status = "done";
  first.assistant.writeNow();

  // The next boot: same state directory, the ledger read back from assistant.json, no remembered turn ids.
  const boot = await panel(t, { dir: first.dir, seedRows: first.jobs.rows });
  boot.assistant.harvested = new Set();
  assert.equal(boot.assistant.carriedLines.length, 1, "the delivered line is on disk");
  await boot.assistant.harvest(turn("turn-old", text));
  await wait();

  assert.equal(boot.jobs.created.length, 0, "the replay started no run");
  const refused = kinds(boot.assistant, "to-replay-refused");
  assert.equal(refused.length, 1, "and the refusal was said by name");
  assert.match(refused[0].text, new RegExp(THREAD), "it names the thread");
  assert.match(refused[0].text, /turn-old/, "the turn that wrote the line");
  assert.match(refused[0].text, /job-1/, "and the delivery that already happened");
  assert.equal(refused[0].thread, THREAD, "the journal line sits on the thread it is about");
});

test("two TOs to one thread in one harvest start one run", async (t) => {
  const { assistant, jobs } = await panel(t);
  const text = [
    "Two things to say, and they must not both become a run.",
    `TO ${THREAD}: first, the row is still yours`,
    `TO ${THREAD}: second, and land it when the tests pass`,
  ].join("\n");
  await assistant.harvest(turn("turn-two", text));
  await wait(320);

  assert.equal(jobs.created.length, 1, "one thread, one run");
  assert.equal(kinds(assistant, "to-skipped").length, 1, "the second TO is refused by name");
  assert.equal(kinds(assistant, "to-replay-refused").length, 0, "a second line of the same turn is not a replay");
  assert.equal(kinds(assistant, "sent").length, 1);
});

test("a TO to a thread whose run is live still refuses, with to-skipped", async (t) => {
  const { assistant, jobs } = await panel(t);
  jobs.rows.push({ id: "job-live", thread: THREAD, status: "running", cwd: jobs.rows[0].cwd });
  await assistant.harvest(turn("turn-live", `TO ${THREAD}: are you still there?`));
  await wait();

  assert.equal(jobs.created.length, 0, "nothing was sent into a live thread");
  assert.equal(kinds(assistant, "to-skipped").length, 1, "the shipped refusal, unchanged");
  assert.equal(kinds(assistant, "to-replay-refused").length, 0, "a live thread is not a replay");
});

test("the key is the line, not its words: a new turn writing the same TO is delivered", async (t) => {
  const { assistant, jobs } = await panel(t);
  const text = `TO ${THREAD}: the tests pass, so land it`;
  await assistant.harvest(turn("turn-a", text));
  await wait();
  // The first delivery ended, which is the ordinary state between two turns.
  jobs.rows.find((r) => r.id === jobs.created[0].id).status = "done";
  await assistant.harvest(turn("turn-b", text));
  await wait();

  assert.equal(jobs.created.length, 2, "the same words in a new turn are a new instruction");
  assert.equal(kinds(assistant, "to-replay-refused").length, 0);
  assert.deepEqual(
    assistant.carriedLines.filter((x) => x.kind === "to").map((x) => x.key),
    ["turn-a|to|0", "turn-b|to|0"],
    "each delivery names its own turn",
  );
});
