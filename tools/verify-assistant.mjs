// Exercises the assistant's sentry and action gating without a gateway, a browser or a git repo.
//
//   node tools/verify-assistant.mjs
//
// Every rule is fed a fabricated job summary of the same shape jobs.summary() emits, and the assertions
// are about what the sentry decided: which alert fired, once, with which evidence, and whether a draft
// was sent or only offered. The point is that the detection logic is testable at all - it reads the
// board, so a fake board is a faithful input.
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Assistant, ASSISTANT_THREAD, parseActions, looksLikeQuestion, detectRepeat, detectCycle, detectErrorRepeat, isFailureLine, matchRule } from "../lib/assistant.js";

const dir = mkdtempSync(path.join(tmpdir(), "assistant-test-"));
const file = path.join(dir, "assistant.json");
let failures = 0;
const ok = (cond, what, extra = "") => {
  if (cond) console.log(`  ok   ${what}`);
  else {
    failures += 1;
    console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ""}`);
  }
};
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), what, `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

// ---- fake board ---------------------------------------------------------------------------------
const t0 = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const line = (kind, text, at = t0 - 60_000) => ({ kind, text, at, lid: Math.random() });
const job = (over = {}) => ({
  id: over.id || Math.random().toString(16).slice(2, 10),
  thread: over.thread || "wtgui-worker-a",
  status: "running",
  prompt: "do the thing",
  startedAt: iso(t0 - 6 * 60_000),
  endedAt: null,
  lines: [],
  artifacts: [],
  approval: null,
  stats: null,
  ownerPath: null,
  cwd: "C:/work/a",
  label: null,
  title: "a worker",
  model: null,
  turn: 1,
  budget: 1800,
  maxTurns: null,
  ...over,
});

const created = [];
const answered = [];
const stopped = [];
let board = [];
const jobs = {
  list: () => board,
  firstOfThread: (thread) => board.find((j) => j.thread === thread) || null,
  modelFor: () => null,
  create: async (opts) => {
    created.push(opts);
    return { id: `fake-${created.length}`, ...opts };
  },
  answerQuestion: async (id, answer, requestId) => {
    answered.push({ id, answer, requestId });
    return { ok: true };
  },
  stop: async (id) => {
    stopped.push(id);
    return { ok: true };
  },
};

// Each section gets its own scratchpad file: alerts and rules are persisted by design, so a shared file
// would make one section's findings another section's fixtures. The restart check below reuses one file
// on purpose.
let seq = 0;
const make = (settings = {}, reuseFile = null) =>
  new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile: reuseFile || path.join(dir, `assistant-${++seq}.json`), defaultCwd: dir },
    jobs,
    onEvent: () => {},
    onLog: (m) => console.log("   log:", m),
    ...settings,
  });

console.log("detection primitives");
{
  const calls = Array.from({ length: 5 }, () => line("tool", "💻 terminal · npm test"));
  const rep = detectRepeat(calls, 3);
  ok(rep && rep.count === 5 && rep.tool === "terminal", "five identical terminal calls read as a repeat", JSON.stringify(rep));
  const reads = Array.from({ length: 3 }, () => line("tool", "📖 read_file · C:/a/one.js"));
  ok(!detectRepeat(reads, 3), "three reads of one file are not a loop (read-only bar is higher)");
  const cyc = detectCycle([..."abc".split("").flatMap(() => [line("tool", "💻 terminal · a"), line("tool", "📖 read_file · b"), line("tool", "🔧 patch · c")])]);
  ok(cyc && cyc.repeats >= 3 && cyc.len === 3, "a 3-call cycle repeated three times is a cycle", JSON.stringify(cyc && { repeats: cyc.repeats, len: cyc.len }));
  const errs = Array.from({ length: 4 }, () => line("tool-out", "  ↳ terminal · 0.21s"), line("tool-out", "TypeError: x is not a function"));
  const er = detectErrorRepeat([...errs, line("tool-out", "error: exit 1")], 3);
  ok(!er || er.count >= 3, "identical failures are counted", JSON.stringify(er));
  ok(looksLikeQuestion("Done. Should I deploy this to QA?")?.endsAsk, "a trailing question is a question");
  ok(!looksLikeQuestion("I fixed it. Why? Because the flag was unset."), "a question mark mid-answer is not");
  const m = matchRule("Should I deploy this to QA or prod?", [{ id: "r1", text: "Deploy to QA, never PROD, from a worktree agent." }]);
  ok(m && m.shared >= 2, "a standing rule matches the question it answers", JSON.stringify(m));
}

console.log("rules fire once, with evidence, at their escalation");
{
  const a = make();
  a.settings.rules.quiet = "alert";
  a.settings.rules.noevidence = "alert";
  board = [
    job({
      thread: "wtgui-loop",
      lines: Array.from({ length: 4 }, () => line("tool", "💻 terminal · npm test")),
    }),
  ];
  a.tick();
  const loop = a.state().alerts.filter((x) => x.rule === "loop");
  eq(loop.length, 1, "one loop alert");
  ok(loop[0].evidence.some((e) => e.label === "repeats" && e.value === "4"), "the alert carries the repeat count", JSON.stringify(loop[0]?.evidence));
  a.tick();
  eq(a.state().alerts.filter((x) => x.rule === "loop").length, 1, "a second pass does not repeat it");

  board = [job({ thread: "wtgui-err", lines: [line("tool-out", "  ↳ terminal · 0.1s"), line("tool-out", "error: boom"), line("tool", "💻 terminal · x"), line("tool-out", "error: boom"), line("tool", "💻 terminal · y"), line("tool-out", "error: boom")] })];
  a.tick();
  eq(a.state().alerts.filter((x) => x.rule === "errorloop").length, 1, "same error three times fires errorloop");

  // quiet: running, nothing new for 10 minutes
  board = [job({ thread: "wtgui-quiet", startedAt: iso(t0 - 20 * 60_000), lines: [line("tool", "💻 terminal · npm run build", t0 - 11 * 60_000)] })];
  a.tick();
  const quiet = a.state().alerts.find((x) => x.rule === "quiet");
  ok(quiet && /no new output/.test(quiet.title), "a silent running turn is reported as quiet, not as stuck", quiet?.title);

  // approval parked
  board = [job({ thread: "wtgui-park", approval: { command: "rm -rf build", at: iso(t0 - 5 * 60_000) } })];
  a.tick();
  const park = a.state().alerts.find((x) => x.rule === "approval");
  ok(park && /parked on approval/.test(park.title) && park.thread === "wtgui-park", "a parked approval is reported with the command", park?.title);

  // collision: two live turns in one tree
  board = [job({ thread: "wtgui-c1", ownerPath: "C:/work/a" }), job({ thread: "wtgui-c2", ownerPath: "C:/work/a" })];
  a.tick();
  const coll = a.state().alerts.find((x) => x.rule === "collision");
  ok(coll && /2 agents live in one tree/.test(coll.title), "two agents in one tree collide once", coll?.title);

  // ...but two turns of one thread are that agent's own queue
  const solo = make();
  board = [job({ thread: "wtgui-solo", turn: 1, ownerPath: "C:/work/solo" }), job({ thread: "wtgui-solo", turn: 2, ownerPath: "C:/work/solo" })];
  solo.tick();
  eq(solo.state().alerts.filter((x) => x.rule === "collision").length, 0, "a thread's own two turns are not a collision");
  board = [];

  // context pressure
  board = [job({ thread: "wtgui-ctx", stats: { context_percent: 94 } })];
  a.settings.rules.context = "alert";
  a.tick();
  ok(a.state().alerts.some((x) => x.rule === "context" && /94%/.test(x.title)), "context pressure is reported at the threshold");
}

console.log("questions: confident means a written-down answer");
{
  const a = make();
  a.addRule("Deploy to QA, never PROD, from a worktree agent.");
  board = [job({ thread: "wtgui-q1", status: "done", endedAt: iso(t0 - 60_000), lines: [line("text", "I can do that. Should I deploy this to QA or prod?")] })];
  a.tick();
  const q = a.state().alerts.find((x) => x.rule === "question");
  ok(q && q.draft?.confidence === "rule" && /QA/.test(q.draft.text), "a rule-covered question arrives with its draft", JSON.stringify(q?.draft));

  board = [job({ thread: "wtgui-q2", status: "done", endedAt: iso(t0 - 60_000), lines: [line("text", "Which of the three hosting shapes do you want?")] })];
  a.tick();
  const q2 = a.state().alerts.find((x) => x.rule === "question" && x.thread === "wtgui-q2");
  ok(q2 && q2.draft?.confidence === "none" && !q2.draft.text, "a question with no standing answer is left for the reader", JSON.stringify(q2?.draft));
}

console.log("a question the run is parked on (the clarify tool)");
{
  const a = make();
  a.settings.rules.question = "alert";
  const parkedJob = (over = {}) =>
    job({
      id: "turn-parked-1",
      thread: "wtgui-parked",
      question: {
        requestId: "req-1",
        question: "Should I deploy this to QA or PROD?",
        choices: ["QA", "PROD"],
        multiSelect: false,
        at: iso(t0 - 3 * 60_000),
      },
      ...over,
    });

  board = [parkedJob()];
  a.tick();
  const q = a.state().alerts.find((x) => x.rule === "question" && x.parked);
  ok(q && /waiting on your answer/.test(q.title), "a parked question is reported as waiting on you", q?.title);
  eq(q?.choices, ["QA", "PROD"], "the choices travel with the alert");
  ok(q?.evidence.some((e) => e.label === "choices" && /QA · PROD/.test(e.value)), "the alert shows the choices", JSON.stringify(q?.evidence));
  ok(q?.draft?.confidence === "none" && !q.draft.text, "with no matching rule it is left for the reader", JSON.stringify(q?.draft));

  // A rule that names exactly one offered choice IS the answer; a rule naming two is not (the reader's
  // intent is ambiguous, so it stays a draft).
  a.addRule("Deploy to QA only, from a worktree agent.");
  a.tick();
  const pick = a.state().alerts.find((x) => x.rule === "question" && x.parked);
  ok(pick?.draft?.confidence === "rule+choice" && pick.draft.text === "QA", "a rule naming one choice is a confident answer", JSON.stringify(pick?.draft));

  const b = make();
  b.settings.rules.question = "alert";
  b.addRule("Deploy to QA, never PROD, from a worktree agent.");
  board = [parkedJob({ id: "turn-parked-2" })];
  b.tick();
  const both = b.state().alerts.find((x) => x.rule === "question" && x.parked);
  ok(both?.draft?.confidence === "rule" && /never PROD/.test(both.draft.text), "a rule naming both choices stays a draft, not a pick", JSON.stringify(both?.draft));

  // The turn is parked, not stalled: the quiet rule must not stack a second alert on the same fact.
  const quietBoard = make();
  quietBoard.settings.rules.quiet = "alert";
  board = [parkedJob({ startedAt: iso(t0 - 30 * 60_000), lines: [line("tool", "💻 terminal · x", t0 - 25 * 60_000)] })];
  quietBoard.tick();
  eq(quietBoard.state().alerts.filter((x) => x.rule === "quiet").length, 0, "a parked question is not reported as quiet");

  // Answering from the float settles the prompt (one call, with the request id) and closes the alert.
  answered.length = 0;
  const c = make();
  c.settings.rules.question = "alert";
  board = [parkedJob({ id: "turn-parked-3" })];
  c.tick();
  const alert = c.state().alerts.find((x) => x.rule === "question" && x.parked);
  const r = await c.answerParked(alert.id, "QA");
  ok(r.ok, "the answer was accepted");
  eq(answered[0], { id: "turn-parked-3", answer: "QA", requestId: "req-1" }, "it answers the parked run with its request id");
  eq(c.state().alerts.find((x) => x.id === alert.id), undefined, "the alert closes with the answer");

  // A multi-select answer goes through as an array; flattening it would answer with one label.
  answered.length = 0;
  const m = make();
  m.settings.rules.question = "alert";
  board = [parkedJob({ id: "turn-parked-4", question: { requestId: "req-4", question: "Which surfaces ship?", choices: ["QA", "Docs"], multiSelect: true, at: iso(t0 - 60_000) } })];
  m.tick();
  const malert = m.state().alerts.find((x) => x.rule === "question" && x.parked);
  ok(malert?.multiSelect === true, "the alert says the question takes several answers");
  await m.answerParked(malert.id, ["QA", "Docs"]);
  eq(answered[0].answer, ["QA", "Docs"], "a multi-select answer stays an array");

  // At auto autonomy the assistant answers a rule-picked choice itself; a draft is still never sent.
  answered.length = 0;
  const d = make();
  d.settings.rules.question = "alert";
  d.settings.autonomy = "auto";
  d.addRule("Deploy to QA only, from a worktree agent.");
  board = [parkedJob({ id: "turn-parked-5" })];
  d.tick();
  await new Promise((r) => setTimeout(r, 30));
  eq(answered.length, 1, "auto autonomy answers a choice a standing rule named");
  eq(answered[0]?.answer, "QA", "with the choice, not the rule's prose");

  // Answered elsewhere (the card, another surface) or withdrawn: the alert closes without a click.
  const e = make();
  e.settings.rules.question = "alert";
  board = [parkedJob({ id: "turn-parked-6" })];
  e.tick();
  eq(e.state().alerts.filter((x) => x.rule === "question" && x.status === "open").length, 1, "open while the question is");
  board = [job({ id: "turn-parked-6", thread: "wtgui-parked", status: "running" })];
  e.tick();
  eq(e.state().alerts.filter((x) => x.rule === "question" && x.status === "open").length, 0, "and closed when it is gone");
}

console.log("a turn that sounds like work and left no trace");
{
  const a = make();
  a.settings.rules.noevidence = "alert";
  board = [
    job({
      thread: "wtgui-bare",
      status: "done",
      prompt: "implement the retry in client.js",
      endedAt: iso(t0 - 30_000),
      lines: [line("tool", "📖 read_file · C:/work/a/client.js"), line("text", "Done — the retry is in place.")],
    }),
  ];
  a.tick();
  const b = a.state().alerts.find((x) => x.rule === "noevidence");
  ok(b && b.evidence.some((e) => e.label === "deliverables"), "a bare implementation turn is flagged", JSON.stringify(b?.evidence));
}

console.log("watches: finished and overdue");
{
  const a = make();
  a.settings.rules.watch = "alert"; // detection only here; the wake path is tested below
  board = [job({ thread: "wtgui-w", status: "running", startedAt: iso(t0 - 30 * 60_000) })];
  const w = a.addWatch({ thread: "wtgui-w", title: "the deploy finishes", minutes: 10 });
  // A watch that has been standing for longer than its own deadline: the clock is the watch's age, not
  // the turn's.
  w.at = iso(t0 - 20 * 60_000);
  a.tick();
  const over = a.state().alerts.find((x) => x.rule === "watch" && /overdue/.test(x.title));
  ok(over, "an overdue watch fires", over?.title);

  board = [job({ thread: "wtgui-w2", status: "done", endedAt: iso(t0 - 10_000), startedAt: iso(t0 - 5 * 60_000) })];
  const w2 = a.addWatch({ thread: "wtgui-w2", title: "the second one" });
  w2.at = iso(t0 - 60_000); // watched since before the turn ended
  a.tick();
  const fin = a.state().alerts.find((x) => x.rule === "watch" && /finished/.test(x.title));
  ok(fin && a.state().watches.find((x) => x.thread === "wtgui-w2")?.state === "done", "a watch whose thread finishes closes itself", fin?.title);

  // A restart mid-run leaves the job `interrupted` with no endedAt: still over, still a finish.
  board = [job({ thread: "wtgui-w3", status: "interrupted", endedAt: null, startedAt: iso(t0 - 10 * 60_000), lines: [line("tool", "💻 terminal · x", t0 - 2 * 60_000)] })];
  const w3 = a.addWatch({ thread: "wtgui-w3", title: "the interrupted one" });
  w3.at = iso(t0 - 5 * 60_000);
  a.tick();
  const fin3 = a.state().alerts.find((x) => x.rule === "watch" && /interrupted one/.test(x.title || ""));
  ok(fin3 && /interrupted/.test(fin3.detail || ""), "an interrupted turn closes its watch too", fin3?.detail);
}

console.log("escalation: log stays in the journal");
{
  const a = make();
  a.settings.rules.loop = "log";
  board = [job({ thread: "wtgui-log", lines: Array.from({ length: 5 }, () => line("tool", "💻 terminal · same")) })];
  a.tick();
  eq(a.state().alerts.filter((x) => x.rule === "loop").length, 0, "no alert at escalation log");
  ok(a.state().journal.some((j) => j.kind === "loop"), "the journal still has it");
}

console.log("the assistant's own actions: draft by default, sent only when allowed");
{
  created.length = 0;
  const a = make();
  board = [job({ thread: "wtgui-worker-b", label: "worker b" })];
  const answer = "I read it as the second option.\nTO wtgui-worker-b: Go with option two — the QA target.\nNOTE: worker b prefers option two.\nWATCH wtgui-worker-b: the deploy finishes | 20";
  a.settings.autonomy = "draft";
  a.harvest({ id: "asst-turn-1", thread: ASSISTANT_THREAD, lines: [line("text", answer)] });
  const st = a.state();
  const draft = st.alerts.find((x) => x.title === "the assistant drafted a reply");
  ok(draft && draft.draft.text.includes("option two"), "draft mode turns a TO line into a draft alert, not a reply", JSON.stringify(draft?.draft));
  eq(created.length, 0, "draft mode sent nothing");
  ok(st.notes.includes("option two") && st.watches.some((w) => w.thread === "wtgui-worker-b"), "NOTE and WATCH lines were carried out");

  a.settings.autonomy = "auto-safe";
  a.harvest({ id: "asst-turn-2", thread: ASSISTANT_THREAD, lines: [line("text", "TO wtgui-worker-b: second option.")] });
  await new Promise((r) => setTimeout(r, 20));
  eq(created.length, 1, "auto-safe sends the assistant's own reply");
  ok(created[0].origin?.kind === "assistant-reply" && created[0].thread === "wtgui-worker-b", "the reply is tagged as the assistant's", JSON.stringify(created[0]?.origin));
}

console.log("creating worktrees: ask, auto and off");
{
  const projects = [{ name: "agent-worktree-gui", path: "C:/ProjectDevelopment/agent-worktree-gui" }];
  const spawned = [];
  const a = make();
  a.getProjects = () => projects;
  a.spawner = async (spec) => {
    spawned.push(spec);
    return { id: "job-spawn", thread: "wtgui-docs-1" };
  };

  const acts = parseActions("SPAWN agent-worktree-gui | write the docs");
  eq(acts.spawn.length, 1, "a SPAWN line is an action");
  eq(acts.spawn[0], { target: "agent-worktree-gui", existing: false, prompt: "write the docs" }, "SPAWN <project> | <prompt>");
  const inTree = parseActions("SPAWN IN C:/ProjectDevelopment/agent-worktree-gui/.worktrees/x | fix the tests");
  eq(inTree.spawn[0].existing, true, "SPAWN IN marks an existing tree");
  eq(inTree.spawn[0].target, "C:/ProjectDevelopment/agent-worktree-gui/.worktrees/x", "a Windows path survives the pipe split");
  ok(parseActions("SPAWN: no pipe").spawn.length === 0, "a SPAWN line with no pipe is not an action");

  a.settings.spawn = "ask";
  a.harvest({ id: "spawn-turn-1", thread: ASSISTANT_THREAD, lines: [line("text", "SPAWN agent-worktree-gui | write .md documentation for the main gui page")] });
  const alert = a.state().alerts.find((x) => x.rule === "spawn");
  ok(alert && alert.spawn?.project === "agent-worktree-gui" && /documentation/.test(alert.spawn.prompt), "ask mode leaves a spawn card", JSON.stringify(alert?.spawn));
  ok(alert?.evidence?.some((e) => e.label === "where" && /new worktree/.test(e.value)), "the card says a worktree would be cut", JSON.stringify(alert?.evidence));
  eq(spawned.length, 0, "ask mode starts nothing by itself");
  await a.startSpawn(a.pendingSpawn(alert.id), { alertId: alert.id });
  eq(spawned.length, 1, "confirming the card starts the worker");
  ok(spawned[0].project === "agent-worktree-gui" && spawned[0].existing === false, "the spawner got the resolved project", JSON.stringify(spawned[0]));
  ok(!a.state().alerts.some((x) => x.id === alert.id), "the card closes once it has started");
  ok(a.state().journal.some((j) => j.kind === "spawned"), "the journal records it");
  ok(a.state().watches.some((w) => w.thread === "wtgui-docs-1" && /spawned:/.test(w.title)), "the worker it started is watched from then on", JSON.stringify(a.state().watches));
  // The same finished turn is re-emitted on every title sweep and every reload; its SPAWN must not come back.
  a.harvest({ id: "spawn-turn-1", thread: ASSISTANT_THREAD, lines: [line("text", "SPAWN agent-worktree-gui | write .md documentation for the main gui page")] });
  eq(a.state().alerts.filter((x) => x.rule === "spawn").length, 0, "a turn is harvested exactly once");

  a.settings.spawn = "auto";
  a.harvest({ id: "spawn-turn-2", thread: ASSISTANT_THREAD, lines: [line("text", "SPAWN agent-worktree-gui | second worker")] });
  await new Promise((r) => setTimeout(r, 20));
  eq(spawned.length, 2, "auto starts at once");

  a.settings.spawn = "off";
  a.harvest({ id: "spawn-turn-3", thread: ASSISTANT_THREAD, lines: [line("text", "SPAWN agent-worktree-gui | third worker")] });
  await new Promise((r) => setTimeout(r, 20));
  eq(spawned.length, 2, "off starts nothing");
  ok(a.state().journal.some((j) => j.kind === "spawn-skipped"), "off is journaled, not silently dropped");
}

// A SPAWN line names a project, not a path. The server's spawner resolves a registry *name* for a new
// worktree and a real directory for SPAWN IN; a bare name left in `target` used to be read as a path and
// refused as "unknown project" on the auto path only, which is how a card could work and auto could not.
console.log("a bare project name reaches the spawner as a name");
{
  const projects = [{ name: "agent-worktree-gui", path: "C:/ProjectDevelopment/agent-worktree-gui" }];
  const spawned = [];
  const a = make();
  a.getProjects = () => projects;
  a.spawner = async (spec) => {
    spawned.push(spec);
    return { id: "job-name", thread: "wtgui-name-1" };
  };
  a.settings.spawn = "auto";

  a.harvest({ id: "name-turn-1", thread: ASSISTANT_THREAD, lines: [line("text", "SPAWN agent-worktree-gui | second worker")] });
  await new Promise((r) => setTimeout(r, 20));
  ok(spawned[0]?.project === "agent-worktree-gui", "auto hands the spawner the registry name", JSON.stringify(spawned[0]));
  eq(spawned.length, 1, "exactly one worker started");

  a.harvest({ id: "name-turn-2", thread: ASSISTANT_THREAD, lines: [line("text", "SPAWN no-such-project | do a thing")] });
  await new Promise((r) => setTimeout(r, 20));
  eq(spawned.length, 1, "an unknown project starts nothing");
  ok(a.state().journal.some((j) => j.kind === "spawn-failed" && /unknown project: no-such-project/.test(j.text)), "and is journaled with the name it was given");
  ok(/Spawn attempts that FAILED/.test(a.digest()) && /no-such-project/.test(a.digest()), "the next turn's digest carries the failure, so it cannot call it queued", a.digest().split("\n").slice(-2).join(" | "));

  a.harvest({ id: "name-turn-3", thread: ASSISTANT_THREAD, lines: [line("text", "SPAWN IN agent-worktree-gui | tidy the root")] });
  await new Promise((r) => setTimeout(r, 20));
  ok(spawned[1]?.existing === true && spawned[1]?.target === "C:/ProjectDevelopment/agent-worktree-gui", "SPAWN IN a project name resolves to its path", JSON.stringify(spawned[1]));
}

console.log("a watch that expires wakes the assistant");
{
  created.length = 0;
  const a = make(); // no override: the shipped default is that a watch wakes
  board = [job({ thread: "wtgui-w9", status: "running", startedAt: iso(t0 - 30 * 60_000) })];
  const w = a.addWatch({ thread: "wtgui-w9", title: "the deploy", minutes: 10 });
  w.at = iso(t0 - 20 * 60_000);
  a.tick();
  await new Promise((r) => setTimeout(r, 300));
  eq(created.length, 1, "the deadline starts an assistant turn");
  const wake = created[0] || {};
  ok(/needs a look/.test(wake.prompt || "") && /\[watch\]/.test(wake.prompt || ""), "the turn is the wake digest", (wake.prompt || "").slice(0, 160));
  ok(/latest output/.test(wake.prompt || ""), "the wake asks the watch-specific question", (wake.prompt || "").slice(0, 320));
  ok(wake.thread === ASSISTANT_THREAD && wake.origin?.kind === "assistant-wake", "it goes to the assistant's own thread as a wake", JSON.stringify(wake.origin));
  ok(a.state().alerts.some((x) => x.rule === "watch" && /overdue/.test(x.title)), "the alert stays in the list beside the wake");

  // Two reasons collected in one pass are one turn, not two.
  created.length = 0;
  a.wake("one thing", null, "watch");
  a.wake("another thing", null, "watch");
  await new Promise((r) => setTimeout(r, 300));
  eq(created.length, 1, "two wakes in one pass are one turn");
  ok(/one thing/.test(created[0].prompt) && /another thing/.test(created[0].prompt), "both reasons ride in that turn", (created[0].prompt || "").slice(0, 200));
}

console.log("a changed default reaches files written before it");
{
  const v1 = path.join(dir, "assistant-v1.json");
  writeFileSync(v1, JSON.stringify({ version: 1, settings: { rules: { watch: "alert" } } }));
  const a = make({}, v1);
  eq(a.settings.rules.watch, "wake", "a v1 file carrying the old default moves to wake");
  a.writeNow();
  ok(JSON.parse(readFileSync(v1, "utf8")).version === 2, "the file is stamped v2");

  const v2 = path.join(dir, "assistant-v2.json");
  writeFileSync(v2, JSON.stringify({ version: 2, settings: { rules: { watch: "alert" } } }));
  eq(make({}, v2).settings.rules.watch, "alert", "a v2 file keeps a deliberate alert");

  const v1log = path.join(dir, "assistant-v1-log.json");
  writeFileSync(v1log, JSON.stringify({ version: 1, settings: { rules: { watch: "log" } } }));
  eq(make({}, v1log).settings.rules.watch, "log", "a non-default value is never migrated");
}

console.log("the same failure across turns");
{
  const failLines = (n) => [
    line("tool", "💻 terminal · npm test"),
    line("tool-out", "  ↳ terminal · 1.2s"),
    line("tool-out", `Tests failed: ${n}`),
    line("tool-out", "(exit 1)"),
  ];
  const a = make();
  board = [
    job({ thread: "wtgui-stuck", turn: 1, status: "failed", endedAt: iso(t0 - 9 * 60_000), lines: failLines(2) }),
    job({ thread: "wtgui-stuck", turn: 2, status: "failed", endedAt: iso(t0 - 6 * 60_000), lines: failLines(3) }),
    job({ thread: "wtgui-stuck", turn: 3, status: "failed", endedAt: iso(t0 - 2 * 60_000), lines: failLines(2) }),
  ];
  a.tick();
  const al = a.state().alerts.find((x) => x.rule === "repeat");
  ok(al && /same failure in 3 turns/.test(al.title), "three turns on the same failure are reported", al?.title);
  ok(al.evidence.some((e) => e.label === "failure" && /npm test/.test(e.value)), "the alert names the failing call", JSON.stringify(al?.evidence));

  const b = make();
  board = [
    job({ thread: "wtgui-ok", turn: 1, status: "failed", endedAt: iso(t0 - 9 * 60_000), lines: failLines(2) }),
    // A turn that came back clean is a reply that did change the outcome: the streak ends there.
    job({
      thread: "wtgui-ok",
      turn: 2,
      status: "done",
      endedAt: iso(t0 - 6 * 60_000),
      lines: [line("tool", "🔧 patch · a.js"), line("tool-out", "  ↳ patch · 0.1s"), line("text", "Fixed it.")],
    }),
    job({ thread: "wtgui-ok", turn: 3, status: "failed", endedAt: iso(t0 - 2 * 60_000), lines: failLines(2) }),
  ];
  b.tick();
  eq(b.state().alerts.filter((x) => x.rule === "repeat").length, 0, "a clean turn breaks the streak");

  // The gateway marks a failed tool in the result header when the preview is empty - the only signal there is.
  ok(isFailureLine("  ↳ terminal · error") && isFailureLine("(exit 1)") && !isFailureLine("  ↳ terminal · 1.2s"), "a result header marks a failure, a normal result does not");
  const c = make();
  const headerFail = () => [line("tool", "💻 terminal · node -e \"process.exit(1)\""), line("tool-out", "  ↳ terminal · error")];
  board = [1, 2, 3].map((n) => job({ thread: "wtgui-head", turn: n, status: "done", endedAt: iso(t0 - n * 60_000), lines: headerFail() }));
  c.tick();
  ok(c.state().alerts.some((x) => x.rule === "repeat"), "three turns whose only failure signal is the header are reported", JSON.stringify(c.state().alerts.map((x) => x.rule)));
}

console.log("work left in a finished tree");
{
  const rows = [
    { path: "C:/work/left", branch: "wtgui/left", verdict: "AHEAD", ahead: 2, dirtyFiles: [{ code: " M", path: "a.md" }], untrackedFiles: [{ path: "b.md" }] },
  ];
  const a = make();
  a.getRows = () => rows;
  board = [job({ thread: "wtgui-left", status: "done", endedAt: iso(t0 - 60_000), worktreePath: "C:/work/left" })];
  a.tick();
  const al = a.state().alerts.find((x) => x.rule === "leftover");
  ok(al && /uncommitted work/.test(al.title), "a finished worker with dirty files is reported", al?.title);
  ok(al.evidence.some((e) => e.label === "left" && /modified/.test(e.value) && /untracked/.test(e.value)), "the alert says what is left", JSON.stringify(al?.evidence));
  a.tick();
  eq(a.state().alerts.filter((x) => x.rule === "leftover").length, 1, "it fires once for the same tree state");

  const b = make();
  // Three commits ahead of main and nothing uncommitted: the normal state of an agent branch, not a leftover.
  b.getRows = () => [{ path: "C:/work/clean", branch: "wtgui/clean", verdict: "AHEAD", ahead: 3, dirtyFiles: [], untrackedFiles: [] }];
  board = [job({ thread: "wtgui-clean", status: "done", endedAt: iso(t0 - 60_000), worktreePath: "C:/work/clean" })];
  b.tick();
  eq(b.state().alerts.filter((x) => x.rule === "leftover").length, 0, "a clean tree with unmerged commits says nothing");

  const c = make();
  c.getRows = () => rows;
  board = [job({ thread: "wtgui-old", status: "done", endedAt: iso(t0 - 3 * 3600_000), worktreePath: "C:/work/left" })];
  c.tick();
  eq(c.state().alerts.filter((x) => x.rule === "leftover").length, 0, "work that ended hours ago is not re-raised");
}

console.log("a delegated child that has gone quiet");
{
  const a = make();
  a.getChildren = () => ({
    "wtgui-parent": [
      { id: "kid-1", title: "write the docs", running: true, lastSeen: t0 - 10 * 60_000, msgs: 4, preview: "patch · README.md" },
      { id: "kid-2", title: "a child that finished", running: false, lastSeen: t0 - 10 * 60_000, msgs: 9 },
    ],
  });
  board = [job({ thread: "wtgui-parent", status: "running", label: "the parent", lines: [line("tool", "🔀 delegate_task · x")] })];
  a.tick();
  const al = a.state().alerts.find((x) => x.rule === "child");
  ok(al && /produced nothing/.test(al.title), "a silent running child is reported", al?.title);
  ok(al.evidence.some((e) => e.label === "silent"), "with how long it has been quiet", JSON.stringify(al?.evidence));
  ok(!/hung/i.test(`${al?.title} ${al?.detail}`), "the wording is no-activity, never hung");
  a.tick();
  eq(a.state().alerts.filter((x) => x.rule === "child").length, 1, "one alert per child, not one per tick");
}

console.log("a restart resumes an interrupted turn, and a watchdog repairs the clock");
{
  // `jobs.load()` turns a running job into `interrupted` — including the assistant's own turn — and the
  // sentry only ever looks at worker threads. So the resume is the only thing that would pick it back up.
  const a = make();
  a.settings.enabled = true;
  created.length = 0;
  // The board lists newest first; the interrupted turn is first in the array and there is an older done turn
  // after it. Picking by position resumed the oldest (done) turn and did nothing.
  board = [
    job({ id: "asst-1", thread: ASSISTANT_THREAD, status: "interrupted", startedAt: iso(t0 - 10 * 60_000), lines: [line("text", "half a thought")] }),
    job({ id: "asst-0", thread: ASSISTANT_THREAD, status: "done", startedAt: iso(t0 - 60 * 60_000), endedAt: iso(t0 - 59 * 60_000) }),
  ];
  eq(a.resumeAfterRestart(), "asst-1", "the interrupted turn is the one it resumes, not the last in the list");
  await new Promise((r) => setTimeout(r, 220));
  eq(created.length, 1, "a restart that cut a turn in half wakes the assistant once");
  ok(/restarted while your last turn/.test(created[0]?.prompt || ""), "the wake says why it is awake", created[0]?.prompt);
  eq(a.resumeAfterRestart(), null, "a second call in the same process does nothing");

  // A clean restart costs nothing: the last turn finished, so no speculative turn and no tokens.
  const b = make();
  created.length = 0;
  board = [job({ id: "asst-2", thread: ASSISTANT_THREAD, status: "done", endedAt: iso(t0 - 60_000) })];
  eq(b.resumeAfterRestart(), null, "a finished last turn is not resumed");
  await new Promise((r) => setTimeout(r, 200));
  eq(created.length, 0, "and nothing is spent");

  // The clock that runs the sentry cannot report its own death; the server calls supervise() from outside.
  const c = make();
  ok(c.state().health.timerAlive === false, "no clock before start");
  c.start();
  ok(c.state().health.timerAlive === true, "the clock is reported running");
  c.stop();
  ok(c.state().health.timerAlive === false, "and reported stopped once stopped");
  const h = c.supervise();
  ok(h.restarted && c.state().health.timerAlive === true, "the watchdog restarts a dead clock", JSON.stringify(h));
  c.stop();
  c.lastTickAt = Date.now() - 60_000;
  const h2 = c.supervise();
  ok(h2.stale, "an old tick is reported stale", JSON.stringify(h2));
  c.stop();

  // Its own turn is invisible to the sentry and `assistantLive()` blocks every wake behind it, so a hung
  // assistant turn is stopped by the watchdog rather than left to sit there.
  const d = make();
  d.settings.quietSeconds = 60;
  stopped.length = 0;
  board = [job({ id: "asst-hung", thread: ASSISTANT_THREAD, status: "running", startedAt: iso(t0 - 40 * 60_000), lines: [line("tool", "💻 terminal · x", t0 - 30 * 60_000)] })];
  const h3 = d.supervise();
  eq(h3.stalled, "asst-hung", "a silent assistant turn is reported stalled");
  await new Promise((r) => setTimeout(r, 30));
  eq(stopped[0], "asst-hung", "and it is stopped, not just noticed");
  ok(d.state().journal.some((j) => j.kind === "stalled"), "the journal says why it was stopped");
  d.stop();
}

console.log("the assistant's own working directory");
{
  // It does no file work, but the gateway refuses a run without an existing cwd. Borrowing a project
  // checkout is what failed on a live panel once that checkout had been deleted, so it gets its own.
  const a = make();
  board = []; // the stall section left a live assistant turn on the fake board
  const def = a.ensureCwd();
  eq(def, path.join(dir, "assistant-cwd"), "the default is a folder beside the scratchpad");
  ok(existsSync(def), "and it is created on demand");
  eq(a.state().settings.cwd, "", "the setting stays empty until the reader picks one");

  const custom = path.join(dir, "cwd-custom", "nested");
  a.setSettings({ cwd: custom });
  eq(a.state().settings.cwd, custom, "a chosen path is accepted as written");
  ok(existsSync(custom), "and created when chosen, not on the first turn");

  created.length = 0;
  await a.say("hello");
  eq(created[0]?.cwd, custom, "a turn runs in it");

  // A path that cannot be created must not take every turn down with it: fall back to one that exists.
  // It has to be under a real FILE, or mkdir -p happily makes it.
  const blocker = path.join(dir, "not-a-dir.txt");
  writeFileSync(blocker, "x");
  const bad = path.join(blocker, "nested");
  a.setSettings({ cwd: bad });
  const used = a.ensureCwd();
  ok(used !== bad && existsSync(used), "an unusable path falls back to one that exists", used);
  eq(a.state().settings.cwd, bad, "the setting is kept as written, so the mistake is visible");
  await a.say("hello again");
  eq(created[1]?.cwd, used, "and the next turn still runs", created[1]?.cwd);
}

console.log("the assistant may add a standing rule");
{
  const a = make();
  a.settings.autonomy = "draft";
  board = [];
  a.harvest({ id: "rule-turn-1", thread: ASSISTANT_THREAD, lines: [line("text", "Noted.\nRULE: An interrupted turn gets one continue, never a second.\nNOTE: kept")] });
  const r = a.state().rules;
  ok(r.length === 1 && /interrupted turn gets one continue/.test(r[0].text), "a RULE line becomes a rule", JSON.stringify(r));
  eq(r[0]?.by, "assistant", "tagged as written by the assistant");
  ok(a.state().journal.some((j) => j.kind === "rule" && /assistant wrote/.test(j.text)), "the journal says who wrote it");

  const before = a.state().rules.length;
  a.harvest({ id: "rule-turn-2", thread: ASSISTANT_THREAD, lines: [line("text", "RULE - An interrupted turn gets one continue, never a second.")] });
  eq(a.state().rules.length, before, "the same rule is not added twice");

  // Models restate a rule with a word changed; that is a refinement of its own rule, not a second one.
  a.harvest({ id: "rule-turn-3", thread: ASSISTANT_THREAD, lines: [line("text", "RULE: An interrupted turn is given one continue, and never a second.")] });
  eq(a.state().rules.filter((x) => x.by === "assistant").length, 1, "a near-identical restatement replaces the assistant's own rule");
  ok(/is given one continue/.test(a.state().rules.find((x) => x.by === "assistant")?.text || ""), "and the newer wording wins");
  eq(a.state().rules.filter((x) => x.by === "reader").length, 0, "the reader's rules are untouched by it");

  // A model writes the separator three ways; all three are the same action.
  const forms = parseActions("RULE: one\nRULE - two\nRULE three\nRULES are not this");
  eq(forms.rule.length, 3, "colon, dash and bare forms all parse", JSON.stringify(forms.rule));
  eq(parseActions("RULES are not this").rule.length, 0, "RULES is not RULE");

  // The reader's own rules still come from the reader, and are marked as such.
  a.addRule("Deploy to QA, never PROD");
  eq(a.state().rules.find((x) => /Deploy to QA/.test(x.text))?.by, "reader", "a rule the reader adds is theirs");
}

console.log("the action grammar");
{
  const acts = parseActions("hello\nTO abc-1: do x\nWATCH abc-1: deploy | 15\nNOTE: remembered");
  eq(acts.to.length, 1, "one TO");
  eq(acts.watch[0].minutes, 15, "a WATCH minute count");
  eq(acts.note[0], "remembered", "a NOTE");
  ok(parseActions("TO: nothing here").to.length === 0, "a TO line with no thread is not an action");
}

console.log("the scratchpad survives a restart");
{
  const shared = path.join(dir, "assistant-shared.json");
  const a = make({}, shared);
  a.addRule("never touch prod");
  a.setNotes("watching the deploy");
  a.addWatch({ thread: "wtgui-x", title: "the deploy" });
  a.writeNow();
  const b = make({}, shared);
  eq(b.state().rules.length, 1, "rules reload");
  eq(b.state().notes, "watching the deploy", "notes reload");
  eq(b.state().watches.length, 1, "watches reload");
  ok(JSON.parse(readFileSync(shared, "utf8")).version === 2, "the file says its version");
}

rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nall assistant checks passed");
process.exit(failures ? 1 : 0);
