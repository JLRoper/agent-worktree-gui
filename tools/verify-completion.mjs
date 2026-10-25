// The completion notice: what a worker this panel spawned actually produced.
//
//   node tools/verify-completion.mjs
//
// Three parts, because three separate things have to be true for the notice to be worth reading:
//
//   1. The payload's own facts — the exit status (the run's terminal result plus the process's own
//      termination), the last words, the report a worker filed, the commits its tree holds.
//   2. The notice the board assistant is actually woken with, driven through the real Assistant over a fake
//      board: a wake IS the text handed to `jobs.create`, so a fake job manager is a faithful place to read it.
//   3. The git measurement, through the real Jobs class against a throwaway repo — including the shape the
//      requirement calls out: a run whose tree is gone with nothing committed, which must not read like one
//      that committed and finished.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Assistant, ASSISTANT_THREAD } from "../lib/assistant.js";
import { Jobs } from "../lib/jobs.js";
import {
  commitsLine,
  completionPayload,
  durationText,
  lastWords,
  outcomeFrom,
  readReport,
  renderCompletionNotice,
  TAIL_LINES,
  wordForStatus,
} from "../lib/completion.js";

const pexec = promisify(execFile);

// A live reading, for a panel that is actually running: the payload it built for a thread's latest turn, and
// the notice that payload renders to — the same text a wake carries. Points at its own instance, never 7331:
//
//   node tools/verify-completion.mjs --notice http://127.0.0.1:7437 wtgui-…
if (process.argv[2] === "--notice") {
  const base = String(process.argv[3] || "").replace(/\/+$/, "");
  const thread = String(process.argv[4] || "");
  const res = await fetch(`${base}/api/jobs`);
  const body = await res.json();
  const mine = (body.jobs || [])
    .filter((j) => j.thread === thread)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  const latest = mine[0];
  if (!latest) {
    console.log(`no job on ${base} for thread ${thread}`);
    process.exit(1);
  }
  const payload = latest.completion;
  console.log(`job ${latest.id} · status ${latest.status} · exit ${latest.exitCode} · outcome ${payload?.word || "(none)"}`);
  console.log(`commits ${JSON.stringify(payload?.commits || null)} · branch ${payload?.branch || "(none)"} · treeExists ${payload?.treeExists}`);
  console.log(`final ${JSON.stringify((payload?.final?.text || "").slice(0, 120))} (${payload?.final?.source || "none"})`);
  console.log(`report ${payload?.report ? `${payload.report.path} · ${payload.report.bytes} bytes` : "(none)"}`);
  console.log("--- notice ---");
  console.log(renderCompletionNotice(payload) || "(no completion payload)");
  process.exit(payload ? 0 : 1);
}

const root = mkdtempSync(path.join(tmpdir(), "completion-test-"));
let failures = 0;
const ok = (cond, what, extra = "") => {
  if (cond) console.log(`  ok   ${what}`);
  else {
    failures += 1;
    console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ""}`);
  }
};
const check = (name, got, want) => ok(JSON.stringify(got) === JSON.stringify(want), name, `${JSON.stringify(got)} !== ${JSON.stringify(want)}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ESC = String.fromCharCode(27);
const painted = (s) => `${ESC}[31m${s}${ESC}[0m`;

// ── 1. the exit status, in three words ─────────────────────────────────────────────────────────────
console.log("the exit status is read, not inferred");
{
  const normal = outcomeFrom({ runStatus: "completed", run: { completed: true, output: "ok" } });
  check("a turn that completed is normal", normal.word, "normal");
  check("...at exit 0, from the result event", normal.exitCode, 0);

  const bad = outcomeFrom({ runStatus: "failed", run: { exit_code: 3 } });
  check("a published non-zero exit is failed", bad.word, "failed");
  check("...and the number is kept", bad.exitCode, 3);
  check("...and the notice says where it came from", bad.source, "the run's result event");

  const zero = outcomeFrom({ runStatus: "completed", run: { exit_code: 0 } });
  check("a published exit 0 is normal", zero.word, "normal");

  // The old bug in one line: nothing was reported, so it must not read as finished.
  const silent = outcomeFrom({ runStatus: "failed", run: {} });
  check("no result and no error is NOT a clean finish", silent.word, "failed");
  check("...and it says the run ended as failed", /ended as failed/.test(silent.reason), true);

  const budget = outcomeFrom({ runStatus: "failed", run: { partial: true, turn_exit_reason: "max_iterations" } });
  check("a turn that ran out of iterations is failed", budget.word, "failed");
  check("...with the reason the run gave", budget.reason, "max_iterations");

  const cap = outcomeFrom({ runStatus: "cancelled", run: { interrupted: true }, termination: { by: "cap", seconds: 900 } });
  check("the panel's wall-clock cap is interrupted", cap.word, "interrupted");
  check("...and the reason names the cap", /passed its 900s wall-clock cap/.test(cap.reason), true);

  const stopped = outcomeFrom({ runStatus: "cancelled", run: {}, termination: { by: "reader" } });
  check("a stop from the card is interrupted", stopped.word, "interrupted");
  check("...and says the panel asked for it", stopped.reason, "stopped from the panel");

  const shutdown = outcomeFrom({ runStatus: "interrupted", run: { interrupted: true, error: "Gateway shutdown interrupted the run." } });
  check("a gateway shutdown is interrupted", shutdown.word, "interrupted");
  check("...with the gateway's own words", /Gateway shutdown/.test(shutdown.reason), true);

  const words = [normal, bad, silent, budget, cap, stopped, shutdown].map((o) => o.word);
  check("no path produces the word done any more", words.every((w) => w !== "done"), true);
  check("the card's word for a cancelled run maps to interrupted, not done", wordForStatus("cancelled"), "interrupted");
  check("...and so does a killed one", wordForStatus("done"), "normal");
}

// ── 2. the worker's final message, or its transcript ───────────────────────────────────────────────
console.log("the last words: the run's message, or the tail of its transcript");
{
  const said = lastWords({ finalMessage: `Shipped it.\n${painted("Both nodes green.")}` });
  check("the run's final message wins when there is one", said.source, "the worker's final message");
  ok(/Both nodes green\./.test(said.text) && !said.text.includes(ESC), "and it is ANSI-stripped", JSON.stringify(said.text));

  const lines = Array.from({ length: 60 }, (_, i) => ({ kind: "tool", text: `${painted("💻 call")} ${i}`, at: 1000 + i }));
  const tail = lastWords({ finalMessage: "", lines });
  check("with no final message the last forty lines are used", tail.text.split("\n").length, TAIL_LINES);
  ok(/last 40 lines of its transcript/.test(tail.source), "and the notice says which of the two it is", tail.source);
  ok(!tail.text.includes(ESC), "the tail is stripped of colour too");
  ok(/call 59/.test(tail.text) && !/call 19/.test(tail.text), "it keeps the NEWEST lines, not the oldest");

  // A phase that re-sends everything so far must not duplicate the paragraph: the same rule the console
  // applies to a streamed delta when a tool line lands in the middle of one.
  const resent = lastWords({
    lines: [
      { kind: "text", text: "half a par" },
      { kind: "tool", text: "💻 terminal · git status" },
      { kind: "text", text: "half a paragraph, finished" },
    ],
  });
  check("a re-sent cumulative delta replaces instead of appending", resent.text.split("\n").filter((l) => /half a par/.test(l)).length, 1);
  ok(/finished/.test(resent.text), "and the finished text is the one kept", resent.text);

  check("a run with nothing to say invents nothing", lastWords({ finalMessage: "", lines: [] }).text, "");
}

// ── 3. the report a worker filed ───────────────────────────────────────────────────────────────────
console.log("the report file, inlined when it exists");
{
  const repo = path.join(root, "repo-with-report");
  const thread = "wtgui-settlers-game-mode-phase-0-r-837f42";
  const reports = path.join(repo, ".agentboard", "settlers-reports");
  mkdirSync(reports, { recursive: true });
  writeFileSync(path.join(reports, `${thread}.md`), "# Phase 0 report\n\n- three commits, tree clean\n");
  const job = { thread, projectPath: repo, branch: "wtgui/settlers-837f42", worktreePath: path.join(repo, "tree") };

  const found = readReport(job);
  check("the report is found under the thread's own slug", found && path.basename(found.path), `${thread}.md`);
  ok(/three commits, tree clean/.test(found.text), "and its contents are inlined", found.text);

  const big = path.join(reports, "big.md");
  writeFileSync(big, "x".repeat(20000));
  const capped = readReport({ thread: "big", projectPath: repo });
  check("a report past the cap is marked truncated", capped.truncated, true);
  ok(/report truncated at 12000 characters/.test(capped.text), "and says so in the text", capped.text.slice(-60));

  check("a run with no report says nothing", readReport({ thread: "nobody", projectPath: repo }), null);
}

// ── 4. what was left behind, and the notice built from all of it ───────────────────────────────────
console.log("the notice itself");
{
  const finished = {
    id: "j-1",
    thread: "wtgui-report-x1",
    turn: 2,
    label: "the settler",
    status: "done",
    startedAt: "2026-10-24T10:00:00.000Z",
    endedAt: "2026-10-24T10:01:32.000Z",
    worktreePath: "C:/repo/.worktrees/settler-abc123",
    branch: "wtgui/settler-abc123",
    outcome: { word: "normal", exitCode: 0, source: "the run's completed result", reason: "" },
    tree: { exists: true, path: "C:/repo/.worktrees/settler-abc123", branch: "wtgui/settler-abc123", commits: 2, base: "9f1a2b3c", subjects: ["1a2b3c4 stub the seams", "5d6e7f8 wire the report"] },
    finalMessage: "Stubbed the seams and filed the report.",
    lines: [{ kind: "text", text: "Stubbed the seams and filed the report." }],
    report: { path: "C:/repo/.agentboard/settlers-reports/wtgui-report-x1.md", text: "# Report\n\ntwo commits, clean tree", bytes: 32, truncated: false },
  };
  const payload = completionPayload(finished);
  const notice = renderCompletionNotice(payload);
  check("duration is measured from the turn's own clock", payload.duration, durationText(92_000));
  check("...and reads as minutes and seconds", payload.duration, "1m 32s");
  ok(/ended normal/.test(notice), "the notice names the word it ended on", notice.split("\n")[0]);
  ok(/exit: 0 \(from the run's completed result\)/.test(notice), "the exit code and its source", notice);
  ok(/duration: 1m 32s/.test(notice), "the duration", notice);
  ok(/branch: wtgui\/settler-abc123/.test(notice), "the branch", notice);
  ok(/worktree: C:\/repo\/\.worktrees\/settler-abc123/.test(notice), "the worktree path", notice);
  ok(/left 2 commits not on 9f1a2b3c: 1a2b3c4 stub the seams · 5d6e7f8 wire the report/.test(notice), "the commits left behind", notice);
  ok(/the worker's final message:\n {4}Stubbed the seams/.test(notice), "the worker's final message, inlined", notice);
  ok(/report C:\/repo\/\.agentboard\/settlers-reports\/wtgui-report-x1\.md/.test(notice) && /two commits, clean tree/.test(notice), "the report, inlined with its path", notice);

  // The two cases the requirement says must be distinguishable.
  const nothing = renderCompletionNotice(completionPayload({ ...finished, tree: { exists: false, commits: 0, base: "9f1a2b3c", subjects: [], note: "", path: "C:/repo/.worktrees/gone" }, report: null, outcome: { word: "normal", exitCode: 0, source: "the run's result event (completed)", reason: "" } }));
  ok(/left no commits — nothing to merge \(its worktree is no longer on disk\)/.test(nothing), "a run whose tree is gone and committed nothing says exactly that", nothing);
  ok(!/left 2 commits/.test(nothing), "...and it does not read like the run that committed", nothing);
  ok(/left 2 commits not on/.test(commitsLine(payload)) && /left no commits/.test(commitsLine({ commits: { count: 0 }, treeExists: true })), "the two shapes never render the same way");

  // A tree that could not be read is NOT a tree that held nothing. `Number(null)` is 0, and a notice that says
  // "left no commits" about a tree nobody could read is exactly the inference this payload exists to prevent.
  const unmeasured = completionPayload({
    ...finished,
    report: null,
    tree: { exists: true, base: "9f1a2b3c", path: "C:/repo/.worktrees/settler-abc123", commits: null, dirty: null, untracked: null, subjects: [], note: "git could not count 9f1a2b3c..HEAD in C:/repo/.worktrees/settler-abc123" },
  });
  check("an unread tree reports no commit count at all", unmeasured.commits, null);
  ok(/commits not measured \(git could not count/.test(commitsLine(unmeasured)), "...and says so rather than reporting zero", commitsLine(unmeasured));
  ok(!/left no commits/.test(renderCompletionNotice(unmeasured)), "...which never reads like a run that left nothing", renderCompletionNotice(unmeasured));
  ok(!/uncommitted in the tree/.test(renderCompletionNotice(unmeasured)), "...and an unread dirty count is not \"0 modified\"", renderCompletionNotice(unmeasured));

  const killed = renderCompletionNotice(
    completionPayload({
      ...finished,
      status: "cancelled",
      outcome: { word: "interrupted", exitCode: 4, source: "the run's result event", reason: "killed by the panel: the run passed its 900s wall-clock cap" },
      finalMessage: "",
      lines: [{ kind: "tool", text: "💻 terminal · npm test" }, { kind: "text", text: "halfway through the suite" }],
      report: null,
    }),
  );
  ok(/ended interrupted/.test(killed) && !/ended done/.test(killed), "a killed run's notice never uses the word done", killed.split("\n")[0]);
  ok(/killed by the panel: the run passed its 900s wall-clock cap/.test(killed), "it says the panel killed it, not that it failed", killed);
  ok(/the last \d+ lines? of its transcript/.test(killed) && /halfway through the suite/.test(killed), "with the transcript tail where a final message would be", killed);
}

// ── 5. what the board assistant is woken with ─────────────────────────────────────────────────────
// A fake board and a fake job manager: the wake IS `jobs.create({prompt})`, so this reads the notice the
// assistant receives, through the real rule engine, with no gateway and no repo.
const created = [];
let board = [];
const jobsStub = {
  list: () => board,
  firstOfThread: (t) => board.find((j) => j.thread === t) || null,
  modelFor: () => null,
  create: async (opts) => {
    created.push(opts);
    return { id: `fake-${created.length}`, thread: opts.thread };
  },
  stop: async () => true,
};
let seq = 0;
const make = (settings = {}) =>
  new Assistant({
    config: { jobsFile: path.join(root, "jobs.json"), assistantFile: path.join(root, `assistant-${++seq}.json`), defaultCwd: root, assistant: settings },
    jobs: jobsStub,
    getProjects: () => [],
    getRows: () => [],
    getChildren: () => ({}),
    onEvent: () => {},
    onLog: () => {},
  });

const t0 = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const line = (kind, text, at) => ({ kind, text, at: at ?? t0 - 60_000, lid: Math.random() });
const boardJob = (over = {}) =>
  ({
    id: over.id || "j-1",
    thread: "wtgui-settler-a",
    status: "done",
    prompt: "stub the settlers seams",
    startedAt: iso(t0 - 5 * 60_000),
    endedAt: iso(t0 - 60_000),
    lines: [line("text", "Done — the seams are stubbed.")],
    artifacts: [],
    approval: null,
    label: null,
    title: "the settler",
    turn: 1,
    cwd: "C:/repo/.worktrees/settler-a",
    worktreePath: "C:/repo/.worktrees/settler-a",
    ownerPath: null,
    projectPath: "C:/repo",
    completion: null,
    ...over,
  });

const payloadFor = (job, over = {}) =>
  completionPayload({
    ...job,
    outcome: { word: "normal", exitCode: 0, source: "the run's completed result", reason: "" },
    tree: { exists: true, branch: job.branch || "wtgui/settler-a", commits: 1, base: "aa11bb22", subjects: ["c0ffee1 stub the seams"], path: job.worktreePath },
    finalMessage: "Done — the seams are stubbed.",
    report: { path: "C:/repo/.agentboard/settlers-reports/wtgui-settler-a.md", text: "# Report\n\none commit on wtgui/settler-a", bytes: 38, truncated: false },
    ...over,
  });

console.log("a watched worker finishing wakes the assistant with the payload");
{
  created.length = 0;
  const a = make(); // the shipped default: a watch wakes
  const job = boardJob({ id: "j-fin", turn: 3, label: "the settler", completion: null });
  job.completion = payloadFor(job, { turn: 3 });
  board = [job];
  const w = a.addWatch({ thread: job.thread, title: "the settlers seams land", doneWhen: "a commit exists" });
  w.at = iso(t0 - 10 * 60_000); // watched since before the turn ended
  a.tick();
  await wait(400);

  check("exactly one wake goes out", created.length, 1);
  const notice = created[0]?.prompt || "";
  const alert = a.state().alerts.find((x) => x.rule === "watch" && /finished/.test(x.title));

  ok(/\[watch\] watch finished: the settlers seams land/.test(notice), "the notice keeps the title it always had", notice.split("\n")[0]);
  ok(/ended normal/.test(notice), "it carries the status word (three words, not done)", notice.split("\n")[0]);
  ok(/was watching for: a commit exists/.test(notice), "and the watch text", notice.split("\n")[0]);
  ok(/^completion — .*ended normal$/m.test(notice), "the payload rides under it", notice.split("\n").slice(0, 3).join(" / "));
  ok(/exit: 0 \(from the run's completed result\)/.test(notice), "1) the exit status and where it came from", notice);
  ok(/duration: \d+m \d+s/.test(notice), "3) the duration", notice);
  ok(/branch: wtgui\/settler-a/.test(notice) && /worktree: C:\/repo\/\.worktrees\/settler-a/.test(notice), "3) the branch and the worktree path", notice);
  ok(/left 1 commit not on aa11bb22: c0ffee1 stub the seams/.test(notice), "3) whether it left commits", notice);
  ok(/the worker's final message:\n {4}Done — the seams are stubbed\./.test(notice), "1) the worker's final message", notice);
  ok(/report C:\/repo\/\.agentboard\/settlers-reports\/wtgui-settler-a\.md/.test(notice) && /one commit on wtgui\/settler-a/.test(notice), "4) the report file, inlined", notice);

  ok(alert, "the alert is in the list beside the wake");
  const ev = new Map((alert?.evidence || []).map((e) => [e.label, e.value]));
  check("...its evidence carries the outcome", ev.get("outcome"), "normal");
  check("...the exit code", ev.get("exit"), "0");
  check("...the duration", ev.get("duration"), payloadFor(job, { turn: 3 }).duration);
  check("...the branch", ev.get("branch"), "wtgui/settler-a");
  check("...the commits", ev.get("commits"), "1 not on base");
  check("...the final message", ev.get("final"), "Done — the seams are stubbed.");
  check("...and the report's path", ev.get("report"), "C:/repo/.agentboard/settlers-reports/wtgui-settler-a.md");
  ok(a.state().watches.find((x) => x.thread === job.thread)?.state === "done", "the watch closes itself");
}

console.log("a killed run is announced as interrupted, never as done");
{
  created.length = 0;
  const a = make();
  a.settings.rules.interrupted = "wake"; // the shipped default is alert; this section wants both rules hot
  const job = boardJob({
    id: "j-killed",
    thread: "wtgui-settler-kill",
    status: "interrupted",
    error: "killed: exceeded 900s panel cap",
    lines: [line("tool", "💻 terminal · npm test"), line("text", "the suite is halfway")],
  });
  job.outcome = { word: "interrupted", exitCode: 4, source: "the run's result event", reason: "killed by the panel: the run passed its 900s wall-clock cap" };
  job.termination = { by: "cap", seconds: 900, at: iso(t0) };
  job.completion = payloadFor(job, { outcome: job.outcome, finalMessage: "", report: null, branch: "wtgui/settler-kill", tree: { exists: false, branch: "wtgui/settler-kill", commits: 0, base: "aa11bb22", subjects: [], note: "", path: job.worktreePath } });
  board = [job];
  const w = a.addWatch({ thread: job.thread, title: "the suite finishes" });
  w.at = iso(t0 - 30 * 60_000);
  a.tick();
  await wait(400);

  // Both rules see the same terminal result: the interrupted alert and the watch finishing.
  check("one wake for one finish, however many rules noticed it", created.length, 1);
  const notice = created[0].prompt;
  ok(/ended interrupted/.test(notice), "the wake says interrupted", notice.split("\n")[0]);
  ok(!/ended done/.test(notice) && !/\bended as done\b/.test(notice), "and never done", notice.split("\n")[0]);
  ok(/killed by the panel: the run passed its 900s wall-clock cap/.test(notice), "the reason is the cap, not a guess", notice);
  ok(/left no commits — nothing to merge \(its worktree is no longer on disk\)/.test(notice), "a tree that is gone with nothing committed is called out", notice);
  ok(/the last \d+ lines? of its transcript/.test(notice) && /the suite is halfway/.test(notice), "with the transcript tail instead of a final message", notice);

  const st = a.state();
  const alerts = st.alerts.filter((x) => /interrupted|watch/.test(x.rule));
  ok(alerts.length >= 1, "the alerts are still listed", JSON.stringify(alerts.map((x) => x.title)));
  ok(st.journal.some((j) => j.kind === "wake-once"), "the second rule says it did not wake again", JSON.stringify(st.journal.slice(-6).map((j) => `${j.kind}:${String(j.text).slice(0, 60)}`)));
  const again = a.state().watches.length;
  created.length = 0;
  a.tick();
  await wait(400);
  check("a later pass does not wake again for the same finish", created.length, 0);
  check("...and the watch is still closed", a.state().watches.length, again);
}

console.log("a run merely idle at its prompt is not a completion");
{
  created.length = 0;
  const a = make();
  const job = boardJob({ id: "j-idle", status: "running", endedAt: null, completion: null, error: null, lines: [line("text", "working on it")] });
  board = [job];
  const w = a.addWatch({ thread: job.thread, title: "the seams land" });
  w.at = iso(t0 - 30 * 60_000);
  a.tick();
  await wait(400);
  check("a live turn, quiet or not, wakes nobody", created.length, 0);
  check("...and produces no completion notice", a.state().alerts.filter((x) => x.rule === "watch").length, 0);
  check("...and the watch stays open", a.state().watches.find((x) => x.thread === job.thread)?.state, "watching");

  // A watch added AFTER the turn ended: the finish it was made about is not this one.
  const done = boardJob({ id: "j-already", thread: "wtgui-settler-b", completion: payloadFor({ thread: "wtgui-settler-b" }) });
  board = [done];
  const late = a.addWatch({ thread: done.thread, title: "too late" });
  ok(Date.parse(late.at) > Date.parse(done.endedAt), "the watch was added after the turn ended", `${late.at} vs ${done.endedAt}`);
  a.tick();
  await wait(400);
  check("a watch made after a turn ended does not wake for it", created.length, 0);

  // ...but a NEW turn of the same thread that finishes is news again. Its clock is taken from the watch's
  // own stamp: a turn that ends after the watch was filed is the finish that watch is about.
  const after = Date.parse(late.at) + 30_000;
  const second = boardJob({
    id: "j-second",
    thread: "wtgui-settler-b",
    turn: 2,
    startedAt: iso(after - 20_000),
    endedAt: iso(after),
    completion: payloadFor({ id: "j-second", thread: "wtgui-settler-b", turn: 2, startedAt: iso(after - 20_000), endedAt: iso(after) }),
  });
  // A finish whose tree facts are still being measured is filed on the NEXT sentry pass, not this one: a
  // notice that says "commits not measured" is worse than one that arrives a tick later.
  second.tree = { pending: true, at: Date.now(), commits: null, note: "", path: second.worktreePath };
  board = [second, done];
  a.tick();
  await wait(400);
  check("a finish whose tree is still being measured is held back a pass", created.length, 0);
  second.tree.pending = false;
  second.tree.commits = 2;
  second.tree.subjects = ["aa11bb2 a commit that landed while the tree was being read"];
  // The job store rebuilds the payload when the measurement lands (jobs.measureTree), so the notice then
  // carries what the tree actually held.
  second.completion = payloadFor(
    { id: "j-second", thread: "wtgui-settler-b", turn: 2, startedAt: iso(after - 20_000), endedAt: iso(after), worktreePath: second.worktreePath, branch: "wtgui/settler-b" },
    { tree: { ...second.tree, branch: "wtgui/settler-b", exists: true } },
  );
  a.tick();
  await wait(400);
  check("...and filed on the next pass, with the tree facts in it", created.length, 1);
  ok(/completion — .*turn 2 ended normal$/m.test(created[0]?.prompt || ""), "and the notice names which turn it is", created[0]?.prompt || "");
  ok(/left 2 commits not on/.test(created[0]?.prompt || ""), "...and carries what the tree held", created[0]?.prompt || "");
}

// ── 6. the git half, through the real Jobs class ───────────────────────────────────────────────────
console.log("what the job store measures about a finished turn");
const jobsRoot = path.join(root, "jobs");
{
  const repo = path.join(root, "worker-repo");
  mkdirSync(repo, { recursive: true });
  const git = (args, cwd = repo) => pexec("git", ["-C", cwd, ...args], { windowsHide: true, timeout: 60_000 }).then((r) => String(r.stdout || "").trim());
  await git(["init", "-q"]);
  await git(["-c", "user.email=t@example.com", "-c", "user.name=test", "commit", "-q", "--allow-empty", "-m", "base"]);
  const base = await git(["rev-parse", "HEAD"]);
  const tree = path.join(repo, ".worktrees", "settler-a");
  await git(["worktree", "add", "-q", "-b", "wtgui/settler-a", tree]);
  const reports = path.join(repo, ".agentboard", "settlers-reports");
  mkdirSync(reports, { recursive: true });
  const thread = "wtgui-settler-a";
  writeFileSync(path.join(reports, `${thread}.md`), "# Settler report\n\nnothing committed yet.\n");

  const jobs = new Jobs({ config: { jobsFile: path.join(jobsRoot, "jobs.json") }, onLog: () => {} });
  const make2 = (over = {}) => {
    const j = {
      id: "j-git",
      thread,
      turn: 1,
      prompt: "stub the seams",
      status: "done",
      startedAt: iso(t0 - 60_000),
      endedAt: iso(t0),
      cwd: tree,
      projectPath: repo,
      worktreePath: tree,
      ownerPath: tree,
      branch: "wtgui/settler-a",
      baseSha: base,
      existing: false,
      lines: [{ kind: "text", text: "Stubbed and reported.", at: t0 - 1000 }],
      finalMessage: "Stubbed and reported.",
      artifacts: [],
      ...over,
    };
    jobs.jobs.set(j.id, j);
    return j;
  };

  const ran = make2();
  await jobs.measureTree(ran);
  check("a turn that committed nothing counts zero", ran.completion.commits.count, 0);
  check("...its tree is still there", ran.completion.treeExists, true);
  check("...its branch is the one the panel cut", ran.completion.branch, "wtgui/settler-a");
  check("...the duration comes off the turn's clock", ran.completion.duration, durationText(Date.parse(iso(t0)) - Date.parse(iso(t0 - 60_000))));
  ok(/left no commits — nothing to merge$/.test(commitsLine(ran.completion)), "and the notice says nothing is left to merge", commitsLine(ran.completion));
  check("the report the worker filed is inlined", ran.completion.report && path.basename(ran.completion.report.path), `${thread}.md`);
  ok(/nothing committed yet/.test(ran.completion.report.text), "...with its contents", ran.completion.report.text);
  check("the exit status of a completed run is 0", ran.completion.exitCode, 0);
  check("...in the word the notice uses", ran.completion.word, "normal");

  // Now a turn that DID commit: two commits on the branch, and one file left uncommitted.
  writeFileSync(path.join(tree, "seams.js"), "export const stubbed = true;\n");
  await git(["add", "seams.js"], tree);
  await git(["-c", "user.email=t@example.com", "-c", "user.name=test", "commit", "-q", "-m", "feat: stub the seams"], tree);
  writeFileSync(path.join(tree, "notes.txt"), "uncommitted\n");
  const worked = make2({ id: "j-git2" });
  await jobs.measureTree(worked);
  check("a turn that committed counts them", worked.completion.commits.count, 1);
  ok(/feat: stub the seams/.test(worked.completion.commits.subjects.join(" ")), "with the subjects", JSON.stringify(worked.completion.commits.subjects));
  check("...and the uncommitted file is reported separately", worked.completion.untracked, 1);
  ok(/left 1 commit not on/.test(commitsLine(worked.completion)), "the notice says what is left to merge", commitsLine(worked.completion));

  // The shape the requirement calls out: the tree is gone at the end. A run that cut a tree, committed
  // nothing and had that tree removed must not read like the one above that committed and finished.
  const treeB = path.join(repo, ".worktrees", "settler-b");
  await git(["worktree", "add", "-q", "-b", "wtgui/settler-b", treeB]);
  const gone = make2({ id: "j-git3", thread: "wtgui-settler-b", branch: "wtgui/settler-b", worktreePath: treeB, ownerPath: treeB, cwd: treeB });
  await git(["worktree", "remove", "--force", treeB]);
  await jobs.measureTree(gone);
  check("a removed tree is reported as gone", gone.completion.treeExists, false);
  check("...and its branch still counts, so zero commits is a measurement", gone.completion.commits.count, 0);
  ok(/left no commits — nothing to merge \(its worktree is no longer on disk\)/.test(commitsLine(gone.completion)), "the notice says both halves of it", commitsLine(gone.completion));
  ok(/\(gone\)/.test(renderCompletionNotice(gone.completion)), "and the worktree line says it is gone", renderCompletionNotice(gone.completion).split("\n")[3]);
  ok(commitsLine(gone.completion) !== commitsLine(worked.completion), "which never reads like the run that committed and finished");
}

rmSync(root, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nall completion checks passed");
process.exit(failures ? 1 : 0);
