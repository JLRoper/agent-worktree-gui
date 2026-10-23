// Exercises the assistant's sentry and action gating without a gateway, a browser or a git repo.
//
//   node tools/verify-assistant.mjs
//
// Every rule is fed a fabricated job summary of the same shape jobs.summary() emits, and the assertions
// are about what the sentry decided: which alert fired, once, with which evidence, and whether a draft
// was sent or only offered. The point is that the detection logic is testable at all - it reads the
// board, so a fake board is a faithful input.
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Assistant, ASSISTANT_THREAD, parseActions, looksLikeQuestion, detectRepeat, detectCycle, detectErrorRepeat, matchRule } from "../lib/assistant.js";

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
let board = [];
const jobs = {
  list: () => board,
  firstOfThread: (thread) => board.find((j) => j.thread === thread) || null,
  modelFor: () => null,
  create: async (opts) => {
    created.push(opts);
    return { id: `fake-${created.length}`, ...opts };
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
  const a = make();
  board = [job({ thread: "wtgui-worker-b", label: "worker b" })];
  const answer = "I read it as the second option.\nTO wtgui-worker-b: Go with option two — the QA target.\nNOTE: worker b prefers option two.\nWATCH wtgui-worker-b: the deploy finishes | 20";
  a.settings.autonomy = "draft";
  a.harvest({ thread: ASSISTANT_THREAD, lines: [line("text", answer)] });
  const st = a.state();
  const draft = st.alerts.find((x) => x.title === "the assistant drafted a reply");
  ok(draft && draft.draft.text.includes("option two"), "draft mode turns a TO line into a draft alert, not a reply", JSON.stringify(draft?.draft));
  eq(created.length, 0, "draft mode sent nothing");
  ok(st.notes.includes("option two") && st.watches.some((w) => w.thread === "wtgui-worker-b"), "NOTE and WATCH lines were carried out");

  a.settings.autonomy = "auto-safe";
  a.harvest({ thread: ASSISTANT_THREAD, lines: [line("text", "TO wtgui-worker-b: second option.")] });
  await new Promise((r) => setTimeout(r, 20));
  eq(created.length, 1, "auto-safe sends the assistant's own reply");
  ok(created[0].origin?.kind === "assistant-reply" && created[0].thread === "wtgui-worker-b", "the reply is tagged as the assistant's", JSON.stringify(created[0]?.origin));
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
  ok(JSON.parse(readFileSync(shared, "utf8")).version === 1, "the file says its version");
}

rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nall assistant checks passed");
process.exit(failures ? 1 : 0);
