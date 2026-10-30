// Phase 2e check for Claude approvals (`can_use_tool`), through lib/jobs.js. Offline: the CLI is
// tools/stub-claude.mjs (mode `approval`), run with this node, so nothing is billed and no network is touched.
// The shapes it answers with (deny, allow-for-session) were proven live first — see tools/spike-claude-stream.mjs
// `deny`/`session` and the "2e shapes" section of docs/claude-phase2-handoff.md.
//
//   node tools/verify-claude-approval.mjs
//
// Covers: the request becomes an approval.request with the choices the shapes support; `once` writes the exact
// allow shape and the card gets approval.responded; `deny` writes the deny shape; `session` writes updatedPermissions
// copied from the suggestion; an answer after the window closed is refused with approval_expired; the deadline
// itself writes a deny with no reader action; stop denies every pending request and ends cancelled; an unknown
// request_id is refused rather than silently answering the real one; nothing is ever answered without a reader
// action or the deadline.
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

const dir = mkdtempSync(path.join(tmpdir(), "verify-claude-approval-"));
const repo = path.join(dir, "repo");
execFileSync("git", ["init", "-q", repo]);
execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
process.env.STUB_CLAUDE_MODE = "approval";

const spawned = [];
let logCounter = 0;
// A short, controllable approval window: real deadlines are minutes, this suite needs one that closes inside its
// own runtime. Each spawn gets its own log path so two jobs never race on the same file.
const makeJobs = (approvalWindowSeconds = 600) => {
  const jobs = new Jobs({
    config: { jobsFile: path.join(dir, `jobs-${Math.random().toString(36).slice(2)}.json`), apiServer: { url: "http://127.0.0.1:9", key: "x" } },
    onLog: () => {},
    approvalWindow: () => approvalWindowSeconds,
  });
  jobs.claude.spawnFn = (bin, args, opts) => {
    const logFile = path.join(dir, `stub-log-${++logCounter}.json`);
    const env = { ...process.env, STUB_CLAUDE_LOG: logFile };
    const child = spawn(process.execPath, [stub, ...args], { ...opts, env });
    child.__logFile = logFile;
    spawned.push({ bin, args, opts, child });
    return child;
  };
  return jobs;
};
const job = (jobs, id) => jobs.jobs.get(id);
const settled = (jobs, id) => () => !["running", "starting"].includes(job(jobs, id)?.status);
const parked = (jobs, id) => () => Boolean(job(jobs, id)?.approval);

try {
  // ── 1. the request becomes an approval.request with the choices the shapes support ────────────
  console.log("\n1. the card sees the request");
  const jobs1 = makeJobs();
  const t1 = await jobs1.create({ agent: "claude", prompt: "write a file", cwd: repo, model: "haiku" });
  await waitFor(parked(jobs1, t1.id));
  const a1 = job(jobs1, t1.id).approval;
  check("approval has once/session/deny (a suggestion was offered)", a1.choices, ["once", "session", "deny"]);
  check("approval carries a request id", typeof a1.requestId === "string" && Boolean(a1.requestId), true);
  check("approval's command names the tool and the file", /^Write · /.test(a1.command), true);
  check("the job is still running, parked on the approval", job(jobs1, t1.id).status, "running");

  // ── 2. once: the exact allow shape, and the card gets approval.responded ───────────────────────
  console.log("\n2. once -> allow");
  const r1 = await jobs1.approve(t1.id, "once", a1.requestId);
  check("approve accepts", [r1.ok, r1.choice], [true, "once"]);
  await waitFor(settled(jobs1, t1.id));
  check("the box is gone and the record says once", [Boolean(job(jobs1, t1.id).approval), job(jobs1, t1.id).approvalDone?.choice], [false, "once"]);
  check("the turn finished because the write was allowed", job(jobs1, t1.id).finalMessage, "FILE_WRITTEN");

  // ── 3. deny: the exact deny shape ───────────────────────────────────────────────────────────────
  console.log("\n3. deny");
  const jobs2 = makeJobs();
  const t2 = await jobs2.create({ agent: "claude", prompt: "write a file", cwd: repo, existing: true, worktree: false });
  await waitFor(parked(jobs2, t2.id));
  const a2 = job(jobs2, t2.id).approval;
  const r2 = await jobs2.approve(t2.id, "deny", a2.requestId);
  check("deny accepts", [r2.ok, r2.choice], [true, "deny"]);
  await waitFor(settled(jobs2, t2.id));
  check("the turn finished with the file NOT written", job(jobs2, t2.id).finalMessage, "FILE_NOT_WRITTEN");
  check("the record says deny", job(jobs2, t2.id).approvalDone?.choice, "deny");

  // ── 4. session: updatedPermissions copied from the suggestion ─────────────────────────────────
  console.log("\n4. session -> allow with updatedPermissions");
  const jobs3 = makeJobs();
  const t3 = await jobs3.create({ agent: "claude", prompt: "write a file", cwd: repo, existing: true, worktree: false });
  await waitFor(parked(jobs3, t3.id));
  const a3 = job(jobs3, t3.id).approval;
  const p3 = jobs3.claude.procs.get(t3.id);
  const pendingId3 = [...p3.pending.keys()][0];
  const suggestions3 = p3.pending.get(pendingId3)?.suggestions;
  const logFile3 = p3.child.__logFile; // capture before finish() deletes the proc entry
  const r3 = await jobs3.approve(t3.id, "session", a3.requestId);
  check("session accepts", [r3.ok, r3.choice], [true, "session"]);
  await waitFor(settled(jobs3, t3.id));
  await waitFor(() => {
    try {
      JSON.parse(readFileSync(logFile3, "utf8"));
      return true;
    } catch {
      return false;
    }
  });
  const log3 = JSON.parse(readFileSync(logFile3, "utf8"));
  const sentResponse3 = log3?.stdin?.find((m) => m.type === "control_response" && m.response?.response?.behavior === "allow");
  check("the allow shape carries updatedInput", Boolean(sentResponse3?.response?.response?.updatedInput), true);
  check("...and updatedPermissions copied verbatim from the suggestion", sentResponse3?.response?.response?.updatedPermissions, suggestions3?.slice(0, 1));
  check("the turn finished because the write was allowed", job(jobs3, t3.id).finalMessage, "FILE_WRITTEN");

  // ── 5. an unknown request_id is refused, not silently answered as the real one ────────────────
  console.log("\n5. unknown request_id");
  const jobs4 = makeJobs();
  const t4 = await jobs4.create({ agent: "claude", prompt: "write a file", cwd: repo, existing: true, worktree: false });
  await waitFor(parked(jobs4, t4.id));
  const bogus = await jobs4.approve(t4.id, "once", "not-a-real-request-id");
  check("an unknown request id is refused", [bogus.ok, bogus.code], [false, "approval_expired"]);
  check("the real request is still parked and unanswered", Boolean(job(jobs4, t4.id).approval), true);
  const p4 = jobs4.claude.procs.get(t4.id);
  check("...and nothing was written to the CLI on its behalf", p4.pending.size, 1);
  // Clean it up so the process does not linger into the next section.
  await jobs4.approve(t4.id, "once", job(jobs4, t4.id).approval.requestId);
  await waitFor(settled(jobs4, t4.id));

  // ── 6. an answer after the window closed is refused with approval_expired ──────────────────────
  console.log("\n6. answered after expiry");
  const jobs5 = makeJobs(1); // a 1s window
  const t5 = await jobs5.create({ agent: "claude", prompt: "write a file", cwd: repo, existing: true, worktree: false });
  await waitFor(parked(jobs5, t5.id));
  const a5 = job(jobs5, t5.id).approval;
  await sleep(1300); // past the 1s window
  const late5 = await jobs5.approve(t5.id, "once", a5.requestId);
  check("answering late is refused as expired", [late5.ok, late5.code], [false, "approval_expired"]);
  await waitFor(settled(jobs5, t5.id), 20_000);
  check("nobody answered it, but the turn still finished (the deadline denied it)", job(jobs5, t5.id).finalMessage, "FILE_NOT_WRITTEN");
  check("the card's own record says nothing was decided here", job(jobs5, t5.id).approvalDone?.expired, true);

  // ── 7. the deadline itself writes a deny — no reader action at all ─────────────────────────────
  console.log("\n7. the deadline denies on its own");
  const jobs6 = makeJobs(1);
  const t6 = await jobs6.create({ agent: "claude", prompt: "write a file", cwd: repo, existing: true, worktree: false });
  await waitFor(parked(jobs6, t6.id));
  // No approve() call at all — just wait past the window and the sweep.
  await waitFor(settled(jobs6, t6.id), 20_000);
  check("the turn finished denied, with no reader action", job(jobs6, t6.id).finalMessage, "FILE_NOT_WRITTEN");
  check("the record says expired, not a choice", [job(jobs6, t6.id).approvalDone?.choice, job(jobs6, t6.id).approvalDone?.expired], ["", true]);

  // ── 8. stop denies every pending request and ends cancelled ────────────────────────────────────
  console.log("\n8. stop denies pending, ends cancelled");
  const jobs7 = makeJobs();
  const t7 = await jobs7.create({ agent: "claude", prompt: "write a file", cwd: repo, existing: true, worktree: false });
  await waitFor(parked(jobs7, t7.id));
  check("stop is accepted while an approval is parked", await jobs7.stop(t7.id), true);
  await waitFor(settled(jobs7, t7.id));
  check("it ends cancelled, not failed or done", job(jobs7, t7.id).status, "cancelled");
  check("the approval box is gone", Boolean(job(jobs7, t7.id).approval), false);
  const p7 = jobs7.claude.procs.get(t7.id);
  check("no pending request survives a stop", p7 ? p7.pending.size : 0, 0);
} finally {
  for (const s of spawned) if (alive(s.child.pid)) s.child.kill();
  try {
    execFileSync("git", ["-C", repo, "worktree", "prune"]);
  } catch {
    /* best effort */
  }
  await sleep(800);
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

console.log(`\n${total} checks, ${failed ? `${failed} FAILED` : "all passed"}`);
console.log(failed ? "RESULT: FAILED" : "RESULT: ALL PASS");
process.exit(failed ? 1 : 0);
