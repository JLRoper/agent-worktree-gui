// THE WAKE LADDER — every assistant is on it, and a wake addressed to a failed one moves to a healthy one.
//
//   node tools/verify-wake-ladder.mjs
//   node tools/verify-wake-ladder.mjs --root C:/path/to/an/export/of/0.73.3     # the red proof
//
// Measured on a board with a second assistant: `wake()` took the caller's id and started a turn on THAT thread, so a
// wake addressed to an assistant whose last run had failed died at its door — the run it was about was never read.
// `fired()` resolved the same way, stamping its alert for the dead thread. And `supervise()` looked for a stalled turn
// on ONE hardcoded thread (`ASSISTANT_THREAD`), so a hung turn on Assistant #2's was never stopped and every wake for
// #2 queued behind it for ever.
//
// This gate drives the real `Assistant` (no stub gateway, no browser) and asks it four things:
//
//   1. THE WALK — #1 and #2 each have a failed last run, #3 has never run. A wake addressed to #1 must land on #3:
//      the first assistant, walking the roster from assistant-1 upward, whose own last run is not `failed`. The
//      journal line must name #3 and both skips with their reasons.
//   2. THE OWNER — #1 and #2 are both healthy, #2 owns the run. The wake must land on #2: the owner is PREFERRED,
//      not outranked by the roster number.
//   3. ALL FAILED — every assistant's last run failed. The owner (#2) must keep the wake rather than have it dropped,
//      and the line must say NOBODY was healthy; with no owner named, #1 keeps the fallback.
//   4. THE STALL SCAN — a silent live turn on #1's thread AND on #2's must both be stopped, each journalled on its own
//      thread. On 0.73.3 only #1's is found.
//
// A run is failed when the job store's status says so OR its outcome word does: a `done` card whose result carried
// exit code 2 is still a failed run, and the gate proves that half with #2's fixture. A run that never ran is eligible.
//
// The `--root` half is what makes this a gate rather than a demonstration: point it at an export of 0.73.3 and the
// walk, the journal lines and the second assistant's stall all FAIL. The export needs its own `lib/`, `data/` and
// `node_modules`; `git archive 0.73.3 | tar -x -C <dir>` is the shape used for the red proof in the PR.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";

const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
};
const ROOT = path.resolve(argOf("--root") || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const { Assistant } = await import(pathToFileURL(path.join(ROOT, "lib", "assistant.js")).href);

let checks = 0;
let failures = 0;
const check = (name, got, want) => {
  checks += 1;
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  return pass;
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
  return Boolean(cond);
};

const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const iso = (at) => new Date(at).toISOString();
const now = Date.now();
const run = ({ id, thread, status = "done", outcome = null, startedAt = now - 60_000, lines = [] }) => ({
  id,
  thread,
  status,
  startedAt: iso(startedAt),
  endedAt: iso(startedAt + 30_000),
  outcome,
  lines,
});
const failedRun = (id, thread, reason, startedAt = now - 60_000) =>
  run({ id, thread, status: "failed", startedAt, outcome: { word: "failed", exitCode: 1, reason } });
const doneRun = (id, thread, startedAt = now - 60_000) =>
  run({ id, thread, status: "done", startedAt, outcome: { word: "normal", exitCode: 0, reason: "" } });

async function board(rows = []) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-wake-ladder-gate-"));
  const said = [];
  const stopped = [];
  const assistant = new Assistant({
    config: {
      jobsFile: path.join(dir, "jobs.json"),
      assistantFile: path.join(dir, "assistant.json"),
      charterFile: path.join(dir, "assistant-charter.md"),
      defaultCwd: dir,
    },
    jobs: {
      list: () => rows,
      stop: async (id) => {
        stopped.push(id);
        return { ok: true };
      },
    },
    getProjects: () => [],
    onEvent: () => {},
    onLog: () => {},
  });
  assistant.say = async (text, opts = {}) => {
    said.push({ text: String(text), assistantId: opts.assistantId || null });
    return { id: `said-${said.length}` };
  };
  return { dir, assistant, said, stopped, rows };
}
const routes = (a) => a.journal.filter((j) => j.kind === "wake-route");
const lastRoute = (a) => routes(a).at(-1)?.text || "";

console.log(`wake ladder against ${ROOT}`);
console.log(`node ${process.version}\n`);

// ---- 1. the walk ----------------------------------------------------------------------------------------------
{
  const { dir, assistant, said, rows } = await board();
  const two = assistant.createAssistant({}).created;
  const three = assistant.createAssistant({}).created;
  rows.push(failedRun("a1-run", "panel-assistant", "exit code 1 (max_turns)"));
  // #2's card says `done`; its own result says failed. The outcome is the run's verdict — the status alone would have
  // read #2 as healthy and the gate would have proved the wrong thing.
  rows.push(run({ id: "a2-run", thread: two.threadId, status: "done", outcome: { word: "failed", exitCode: 2, reason: "the gateway lost the run" } }));
  // #3 has never run: an assistant that never ran is eligible, not failed.

  console.log("== 1. a wake addressed to failed #1 walks up to #3, the first healthy assistant ==");
  ok("the ladder exists on this build", typeof assistant.wakeTarget === "function", typeof assistant.wakeTarget);
  const out = assistant.wake("a worker settled in #1's tree", null, "settle", { assistantId: "assistant-1" });
  ok("the wake is queued, not refused", out && out.queued === true, JSON.stringify(out));
  await wait(350);
  check("the turn was started for Assistant #3", said.map((s) => s.assistantId), ["assistant-3"]);
  const line1 = lastRoute(assistant);
  console.log(`      journal: ${line1 || "(no wake-route line)"}`);
  ok("…and the journal names Assistant #3 as the recipient", /Assistant #3 took the wake/.test(line1), line1);
  ok("…names #1 as skipped with its reason", /skipped as failed: Assistant #1 \(exit code 1 \(max_turns\)\)/.test(line1), line1);
  ok("…and names #2 as skipped from its OUTCOME, though its card read done", /Assistant #2 \(the gateway lost the run\)/.test(line1), line1);
  await rm(dir, { recursive: true, force: true });
}

// ---- 2. the owner is preferred --------------------------------------------------------------------------------
{
  const { dir, assistant, said, rows } = await board();
  const two = assistant.createAssistant({}).created;
  rows.push(doneRun("a1-run", "panel-assistant"));
  rows.push(doneRun("a2-run", two.threadId, now - 30_000));

  console.log("\n== 2. a healthy owner keeps its wake, even with a healthy #1 below it ==");
  assistant.wake("the owner's worker settled", null, "settle", { assistantId: "assistant-2" });
  await wait(350);
  check("the turn was started for Assistant #2, the tree's owner", said.map((s) => s.assistantId), ["assistant-2"]);
  const line2 = lastRoute(assistant);
  console.log(`      journal: ${line2 || "(no wake-route line)"}`);
  ok("the journal names Assistant #2 as the recipient", /Assistant #2 took the wake/.test(line2), line2);
  ok("…and says nobody was skipped", /no assistant was skipped as failed/.test(line2), line2);
  await rm(dir, { recursive: true, force: true });
}

// ---- 3. every assistant failed --------------------------------------------------------------------------------
{
  const { dir, assistant, said, rows } = await board();
  const two = assistant.createAssistant({}).created;
  rows.push(failedRun("a1-run", "panel-assistant", "exit code 1"));
  rows.push(failedRun("a2-run", two.threadId, "the gateway refused the turn"));

  console.log("\n== 3. when every assistant failed, the owner keeps the wake and the journal says nobody was healthy ==");
  assistant.wake("a wake addressed to a failed owner", null, "settle", { assistantId: "assistant-2" });
  await wait(350);
  check("the owner kept the wake rather than losing it", said.map((s) => s.assistantId), ["assistant-2"]);
  const line3 = lastRoute(assistant);
  console.log(`      journal: ${line3 || "(no wake-route line)"}`);
  ok("the journal says NOBODY was healthy", /Assistant #2 kept the wake though NOBODY was healthy/.test(line3), line3);
  ok("…and lists every failed assistant with its reason", /every assistant's last run failed: Assistant #1 \(exit code 1\); Assistant #2 \(the gateway refused the turn\)/.test(line3), line3);

  assistant.wake("a second thing, with nobody named", null, "resume");
  await wait(350);
  check("with no owner named, #1 keeps the fallback wake", said.map((s) => s.assistantId), ["assistant-2", "assistant-1"]);
  await rm(dir, { recursive: true, force: true });
}

// ---- 4. the stall scan ----------------------------------------------------------------------------------------
{
  const { dir, assistant, rows, stopped } = await board();
  const two = assistant.createAssistant({}).created;
  assistant.settings.enabled = true;
  rows.push({
    id: "a1-hung",
    thread: "panel-assistant",
    status: "running",
    startedAt: iso(now - 40 * 60_000),
    lines: [{ kind: "tool", text: "💻 terminal · x", at: now - 30 * 60_000 }],
  });
  rows.push({
    id: "a2-hung",
    thread: two.threadId,
    status: "running",
    startedAt: iso(now - 50 * 60_000),
    lines: [{ kind: "tool", text: "💻 terminal · y", at: now - 40 * 60_000 }],
  });

  console.log("\n== 4. every assistant's own thread is checked for a silent turn ==");
  const health = assistant.supervise();
  const turns = Array.isArray(health.stalledTurns) ? health.stalledTurns.map((x) => `${x.assistantId}|${x.turnId}`) : null;
  check("both silent turns are reported", turns, ["assistant-1|a1-hung", "assistant-2|a2-hung"]);
  await wait(60);
  check("both are stopped", stopped, ["a1-hung", "a2-hung"]);
  await rm(dir, { recursive: true, force: true });
}

console.log(`\nRESULT: ${checks} checks, ${failures} failed`);
if (failures) {
  console.log("WAKE-LADDER-FAILED");
  process.exit(1);
}
console.log("WAKE-LADDER-OK");
