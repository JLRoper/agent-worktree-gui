// Phase 2d check for Claude reply (`--resume`) and steer (a stdin `user` message mid-turn), through lib/jobs.js.
// Offline: the CLI is tools/stub-claude.mjs, run with this node, so nothing is billed and no network is touched.
//
//   node tools/verify-claude-reply.mjs
//
// Covers: a reply resumes the thread's session in the first turn's tree, without --session-id; the session id the
// CLI reports wins; the thread -> session mapping survives a panel restart; replies refused while a turn runs or with
// no session; steer delivered mid-turn and folded into one result; steer after the result refused with the Hermes
// code; two results in one process settle on the last; a Hermes reply still goes to the gateway on the thread name.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Jobs } from "../lib/jobs.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const stub = path.join(here, "stub-claude.mjs");
let failed = 0;
let total = 0;
const check = (name, got, want) => {
  total++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const dir = mkdtempSync(path.join(tmpdir(), "verify-claude-reply-"));
const repo = path.join(dir, "repo");
execFileSync("git", ["init", "-q", repo]);
execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
const logFile = path.join(dir, "stub-log.json");
const jobsFile = path.join(dir, "jobs.json");
process.env.STUB_CLAUDE_LOG = logFile;
const stubLog = () => JSON.parse(readFileSync(logFile, "utf8"));
const argAfter = (log, flag) => (log.argv.includes(flag) ? log.argv[log.argv.indexOf(flag) + 1] : null);

const spawned = [];
const makeJobs = () => {
  const jobs = new Jobs({ config: { jobsFile, apiServer: { url: "http://127.0.0.1:9", key: "x" } }, onLog: () => {} });
  // The stub is a node script, so it is started with this node; the transport's argv is passed through untouched.
  jobs.claude.spawnFn = (bin, args, opts) => {
    const child = spawn(process.execPath, [stub, ...args], opts);
    spawned.push({ bin, args, opts, child });
    return child;
  };
  return jobs;
};
let jobs = makeJobs();
const job = (id) => jobs.jobs.get(id);
const settled = (id) => () => !["running", "starting"].includes(job(id)?.status);
const text = (id) => (job(id).lines || []).map((l) => l.text).join("\n");
// What the reply route does: the thread's first turn, in its tree.
const reply = (thread, prompt, extra = {}) => {
  const first = jobs.firstOfThread(thread);
  return jobs.create({ prompt, thread, reply: true, cwd: first.worktreePath || first.cwd, resumeDir: first.worktreePath || first.cwd, ...extra });
};

try {
  // ── 1. a reply resumes the first turn's session, in its tree ────────────────────────────────────
  console.log("\n1. reply = --resume <session> in the same cwd");
  process.env.STUB_CLAUDE_MODE = "replay";
  const t1 = await jobs.create({ agent: "claude", prompt: "Remember the word KIWI. Reply OK.", cwd: repo, model: "haiku" });
  await waitFor(settled(t1.id));
  const first = job(t1.id);
  check("first turn done, in a worktree of its own", [first.status, Boolean(first.worktreePath)], ["done", true]);
  const firstLog = stubLog();
  check("first turn names its session and does not resume", [argAfter(firstLog, "--session-id"), firstLog.argv.includes("--resume")], [first.sessionId, false]);

  const t2 = await reply(first.thread, "What word did I ask you to remember?");
  check("the reply is a Claude turn on the same thread", [t2.agent, t2.thread, job(t2.id).turn], ["claude", first.thread, 2]);
  await waitFor(settled(t2.id));
  const r2 = job(t2.id);
  const log2 = stubLog();
  check("argv: --resume the first turn's session", argAfter(log2, "--resume"), first.sessionId);
  check("argv: no --session-id beside --resume (the CLI refuses it)", log2.argv.includes("--session-id"), false);
  check("the reply runs in the first turn's tree", path.resolve(log2.cwd), path.resolve(first.worktreePath));
  check("the reply made no tree of its own", [r2.worktreePath, r2.branch || null], [null, null]);
  check("the reply keeps the session, with a run id of its own", [r2.sessionId, r2.runId !== first.runId, r2.runId], [first.sessionId, true, `claude-${first.sessionId}-t2`]);
  check("stdin: initialize, then the reply as a user turn", [log2.stdin[0]?.request?.subtype, log2.stdin[1]?.message?.content], ["initialize", "What word did I ask you to remember?"]);
  check("the reply settles done", [r2.status, r2.finalMessage], ["done", "PONG"]);
  check("the command line on the card says --resume", /--resume /.test(text(t2.id)), true);

  // ── 2. the session the CLI reports is the one the next reply resumes ────────────────────────────
  console.log("\n2. the CLI's init wins");
  process.env.STUB_CLAUDE_SESSION = "33333333-3333-4333-8333-333333333333";
  const t3 = await reply(first.thread, "third");
  await waitFor(settled(t3.id));
  delete process.env.STUB_CLAUDE_SESSION;
  check("the turn records the session init reported", job(t3.id).sessionId, "33333333-3333-4333-8333-333333333333");
  const t4 = await reply(first.thread, "fourth");
  await waitFor(settled(t4.id));
  check("the next reply resumes that one, from the latest turn", argAfter(stubLog(), "--resume"), "33333333-3333-4333-8333-333333333333");

  // ── 3. a panel restart keeps the thread -> session mapping ─────────────────────────────────────
  console.log("\n3. the mapping survives a restart");
  await sleep(1500); // the store is written 700 ms after the last change
  jobs = makeJobs();
  check("the restored thread is still a Claude thread", jobs.firstOfThread(first.thread)?.agent, "claude");
  const t5 = await reply(first.thread, "after restart");
  await waitFor(settled(t5.id));
  check("a reply after the restart resumes the same session", [argAfter(stubLog(), "--resume"), job(t5.id).status], ["33333333-3333-4333-8333-333333333333", "done"]);

  // ── 4. replies that cannot be honest are refused ────────────────────────────────────────────────
  console.log("\n4. refusals");
  process.env.STUB_CLAUDE_MODE = "hang";
  const h1 = await jobs.create({ agent: "claude", prompt: "wait", cwd: repo, existing: true, worktree: false });
  await waitFor(() => /sleep 600/.test(text(h1.id)));
  let err = null;
  try {
    await reply(job(h1.id).thread, "too soon");
  } catch (e) {
    err = String(e.message);
  }
  check("a reply while a turn runs is refused (steer instead)", /turn running/.test(err || ""), true);
  await jobs.stop(h1.id);
  await waitFor(settled(h1.id));
  const saveSpawn = jobs.claude.spawnFn;
  jobs.claude.spawnFn = () => {
    throw new Error("simulated ENOENT");
  };
  const n1 = await jobs.create({ agent: "claude", prompt: "never ran", cwd: repo, existing: true, worktree: false });
  jobs.claude.spawnFn = saveSpawn;
  check("a turn that never started has no run", [job(n1.id).status, job(n1.id).runId], ["failed", null]);
  err = null;
  try {
    await reply(job(n1.id).thread, "anyone?");
  } catch (e) {
    err = String(e.message);
  }
  check("a reply with no session to resume is refused", /no session to resume/.test(err || ""), true);

  // ── 5. steer: folded into the running turn ─────────────────────────────────────────────────────
  console.log("\n5. steer mid-turn");
  process.env.STUB_CLAUDE_MODE = "steer";
  const s1 = await jobs.create({ agent: "claude", prompt: "sleep then answer", cwd: repo, existing: true, worktree: false });
  await waitFor(() => /sleep 600/.test(text(s1.id)));
  const sr = await jobs.steer(s1.id, "say BANANA instead");
  check("steer is accepted while the turn runs", [sr.ok, sr.accepted, sr.runId], [true, true, job(s1.id).runId]);
  check("the card says the steer was sent", /⇢ steer sent: say BANANA instead/.test(text(s1.id)), true);
  await waitFor(settled(s1.id));
  const steerLog = stubLog();
  check("stdin: the steer went in as a user message after the prompt", [steerLog.stdin.length, steerLog.stdin[2]?.type, steerLog.stdin[2]?.message?.content], [3, "user", "say BANANA instead"]);
  check("one result answers it, and the job settles done", [job(s1.id).status, job(s1.id).finalMessage], ["done", "STEERED: say BANANA instead"]);
  check("no 'answered N times' note for a folded steer", /answered \d+ times/.test(text(s1.id)), false);
  const late = await jobs.claude.steer(job(s1.id), "after exit");
  check("the transport refuses a steer once the process is gone", late.code, "run_not_accepting_steer");

  // ── 6. steer after the result, before the process exits ────────────────────────────────────────
  console.log("\n6. steer after the result");
  process.env.STUB_CLAUDE_MODE = "replay";
  process.env.STUB_CLAUDE_LINGER_MS = "1500";
  const s2 = await jobs.create({ agent: "claude", prompt: "quick", cwd: repo, existing: true, worktree: false });
  await waitFor(() => jobs.claude.procs.get(s2.id)?.held);
  check("the result is held and the job still running", job(s2.id).status, "running");
  const r6 = await jobs.steer(s2.id, "too late");
  check("steer is refused with the Hermes code", [r6.ok, r6.code], [false, "run_not_accepting_steer"]);
  check("...and nothing was written", /steer sent: too late/.test(text(s2.id)), false);
  await waitFor(settled(s2.id));
  delete process.env.STUB_CLAUDE_LINGER_MS;
  check("the job settles on exit", job(s2.id).status, "done");
  check("stdin never got the refused steer", stubLog().stdin.some((m) => m.message?.content === "too late"), false);

  // ── 7. two results in one process ──────────────────────────────────────────────────────────────
  console.log("\n7. two results settle on the last");
  process.env.STUB_CLAUDE_MODE = "twice";
  const w1 = await jobs.create({ agent: "claude", prompt: "twice", cwd: repo, existing: true, worktree: false });
  await waitFor(settled(w1.id));
  check("the job settles on the last result", [job(w1.id).status, job(w1.id).finalMessage], ["done", "SECOND"]);
  check("the card says it answered twice", /answered 2 times/.test(text(w1.id)), true);

  // ── 8. a Hermes reply is unchanged ─────────────────────────────────────────────────────────────
  console.log("\n8. Hermes reply path");
  const hz = await jobs.create({ prompt: "hermes first", cwd: repo, existing: true, worktree: false });
  const hr = await jobs.create({ prompt: "hermes reply", thread: job(hz.id).thread, reply: true, cwd: repo });
  check("a Hermes reply stays Hermes, on the thread name, with no resume", [hr.agent, job(hr.id).sessionId, job(hr.id).resumeSession], ["hermes", job(hz.id).thread, null]);
  check("...and goes to the gateway", /cannot reach the Hermes gateway/.test(job(hr.id).error || ""), true);
} finally {
  for (const s of spawned) if (alive(s.child.pid)) s.child.kill();
  try {
    execFileSync("git", ["-C", repo, "worktree", "prune"]);
  } catch {
    /* best effort */
  }
  await sleep(800); // let a pending store write land before the directory goes
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

console.log(`\n${total} checks, ${failed ? `${failed} FAILED` : "all passed"}`);
console.log(failed ? "RESULT: FAILED" : "RESULT: ALL PASS");
process.exit(failed ? 1 : 0);
