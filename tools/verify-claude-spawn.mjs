// Phase 2c check for the Claude process path (lib/claude-transport.js through lib/jobs.js). Offline: the CLI is
// tools/stub-claude.mjs, run with this node, so nothing is billed and no network is touched.
//
//   node tools/verify-claude-spawn.mjs
//
// Covers: spawn into a fresh worktree, the stdin protocol and argv, events onto the card, settle on process exit,
// stop -> cancelled (cooperative and forced kill), a crash -> failed with stderr, yolo, the 2d/2e stubs, and that a
// job with no agent is still a Hermes job.
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

const dir = mkdtempSync(path.join(tmpdir(), "verify-claude-spawn-"));
const repo = path.join(dir, "repo");
execFileSync("git", ["init", "-q", repo]);
execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
const logFile = path.join(dir, "stub-log.json");
process.env.STUB_CLAUDE_LOG = logFile;

const jobs = new Jobs({ config: { jobsFile: null, apiServer: { url: "http://127.0.0.1:9", key: "x" } }, onLog: () => {} });
// The stub is a node script, so it is started with this node; the transport's argv is passed through untouched.
const spawned = [];
jobs.claude.spawnFn = (bin, args, opts) => {
  const child = spawn(process.execPath, [stub, ...args], opts);
  spawned.push({ bin, args, opts, child });
  return child;
};
const job = (id) => jobs.jobs.get(id);
const settled = (id) => () => !["running", "starting"].includes(job(id)?.status);
const text = (id) => (job(id).lines || []).map((l) => l.text).join("\n");

try {
  // ── 1. a whole turn, replayed from the captured fixture ─────────────────────────────────────────
  console.log("\n1. spawn, stream, settle on exit");
  process.env.STUB_CLAUDE_MODE = "replay";
  const s1 = await jobs.create({ agent: "claude", prompt: "Reply with exactly: PONG", cwd: repo, model: "haiku" });
  check("summary says claude", s1.agent, "claude");
  check("job is running once spawned", s1.status, "running");
  check("it got a worktree of its own", Boolean(job(s1.id).worktreePath && job(s1.id).branch?.startsWith("wtgui/")), true);
  check("the process runs in that worktree, with no shell", [path.resolve(spawned[0].opts.cwd), spawned[0].opts.shell], [path.resolve(job(s1.id).worktreePath), false]);
  await waitFor(settled(s1.id));
  const r1 = job(s1.id);
  check("it settles done after the process exits", r1.status, "done");
  check("the answer is the final message", r1.finalMessage, "PONG");
  check("the tool call reached the card", /terminal · echo hi-from-tool/.test(text(s1.id)), true);
  check("the tool output reached the card, without the CLI's cwd note", [/hi-from-tool/.test(text(s1.id)), /Shell cwd was reset/.test(text(s1.id))], [true, false]);
  check("the result line carries tokens", /run completed · tokens \d+/.test(text(s1.id)), true);
  check("the cost is on the card", /cost \$0\.0069/.test(text(s1.id)), true);
  check("tokens recorded", r1.tokens?.output > 0, true);
  const log1 = JSON.parse(readFileSync(logFile, "utf8"));
  check("session id is the one passed to the CLI", log1.argv[log1.argv.indexOf("--session-id") + 1], r1.sessionId);
  check("run id is derived from it", r1.runId, `claude-${r1.sessionId}`);
  check("argv: headless stream-json both ways", ["-p", "--input-format", "--output-format", "--verbose"].every((a) => log1.argv.includes(a)), true);
  check("argv: model, budget default, permission mode", [log1.argv[log1.argv.indexOf("--model") + 1], log1.argv[log1.argv.indexOf("--max-budget-usd") + 1], log1.argv[log1.argv.indexOf("--permission-mode") + 1]], ["haiku", "0.5", "default"]);
  check("argv: no --permission-prompt-tool in 2c, and the prompt is not in argv", [log1.argv.includes("--permission-prompt-tool"), log1.argv.some((a) => a.includes("PONG"))], [false, false]);
  check("stdin: initialize, then the prompt as a user turn", [log1.stdin[0]?.request?.subtype, log1.stdin[1]?.type, log1.stdin[1]?.message?.content], ["initialize", "user", "Reply with exactly: PONG"]);
  check("no process left in the registry", jobs.claude.procs.size, 0);

  // ── 2. stop: the CLI answers the interrupt ──────────────────────────────────────────────────────
  console.log("\n2. stop -> cancelled (cooperative)");
  process.env.STUB_CLAUDE_MODE = "hang";
  const s2 = await jobs.create({ agent: "claude", prompt: "wait", cwd: repo, existing: true, worktree: false });
  await waitFor(() => /terminal · sleep 600/.test(text(s2.id)));
  check("the long tool call is showing", /sleep 600/.test(text(s2.id)), true);
  const t0 = Date.now();
  check("stop is accepted", await jobs.stop(s2.id), true);
  await waitFor(settled(s2.id));
  check("it ends cancelled, not failed", job(s2.id).status, "cancelled");
  check("...recorded as the reader's doing", job(s2.id).termination?.by, "reader");
  check("...without waiting for the kill timer", Date.now() - t0 < 4000, true);
  const log2 = JSON.parse(readFileSync(logFile, "utf8"));
  check("the interrupt went over stdin", log2.stdin.some((m) => m.request?.subtype === "interrupt"), true);

  // ── 3. stop: the CLI ignores the interrupt, so the tree is killed ────────────────────────────────
  console.log("\n3. stop -> cancelled (forced kill)");
  process.env.STUB_CLAUDE_MODE = "deaf";
  const s3 = await jobs.create({ agent: "claude", prompt: "wait", cwd: repo, existing: true, worktree: false });
  await waitFor(() => /sleep 600/.test(text(s3.id)));
  const pid3 = spawned.at(-1).child.pid;
  await jobs.stop(s3.id);
  await waitFor(settled(s3.id), 12_000);
  check("it ends cancelled after the kill", job(s3.id).status, "cancelled");
  check("no orphan process", alive(pid3), false);

  // ── 4. a crash ───────────────────────────────────────────────────────────────────────────────
  console.log("\n4. crash -> failed");
  process.env.STUB_CLAUDE_MODE = "crash";
  const s4 = await jobs.create({ agent: "claude", prompt: "x", cwd: repo, existing: true, worktree: false });
  await waitFor(settled(s4.id));
  check("it fails", job(s4.id).status, "failed");
  check("...with the exit code and the stderr tail", [/code 2/.test(job(s4.id).error || ""), /simulated crash/.test(job(s4.id).error || "")], [true, true]);

  // ── 5. options and the calls that are later phases ──────────────────────────────────────────────
  console.log("\n5. yolo, budget, 2d/2e stubs, routing");
  process.env.STUB_CLAUDE_MODE = "replay";
  const s5 = await jobs.create({ agent: "claude", prompt: "y", cwd: repo, existing: true, worktree: false, yolo: true, budget: 0.05 });
  await waitFor(settled(s5.id));
  const log5 = JSON.parse(readFileSync(logFile, "utf8"));
  check("yolo runs with bypassPermissions", log5.argv[log5.argv.indexOf("--permission-mode") + 1], "bypassPermissions");
  check("a job budget overrides the default", log5.argv[log5.argv.indexOf("--max-budget-usd") + 1], "0.05");
  process.env.STUB_CLAUDE_MODE = "hang";
  const s6 = await jobs.create({ agent: "claude", prompt: "z", cwd: repo, existing: true, worktree: false });
  await waitFor(() => /sleep 600/.test(text(s6.id)));
  check("steer is not in 2c", (await jobs.steer(s6.id, "hi")).code, "not_in_2c");
  let replyErr = null;
  try {
    await jobs.create({ prompt: "again", thread: job(s6.id).thread, reply: true, cwd: repo, existing: true });
  } catch (e) {
    replyErr = String(e.message);
  }
  check("a reply to a Claude thread is refused until 2d", /2d/.test(replyErr || ""), true);
  await jobs.stop(s6.id);
  await waitFor(settled(s6.id));
  let unknown = null;
  try {
    await jobs.create({ agent: "gpt", prompt: "x", cwd: repo, existing: true });
  } catch (e) {
    unknown = String(e.message);
  }
  check("an unknown agent is refused", /unknown agent/.test(unknown || ""), true);
  const h = await jobs.create({ prompt: "hermes job", cwd: repo, existing: true, worktree: false });
  check("no agent means hermes, and it goes to the gateway", [h.agent, /cannot reach the Hermes gateway/.test(job(h.id).error || "")], ["hermes", true]);
  check("transportFor routes by agent", [jobs.transportFor(job(s1.id)) === jobs.claude, jobs.transportFor(job(h.id)) === jobs.hermes, jobs.transportFor({}) === jobs.hermes], [true, true, true]);
  check("restart sweep: Claude jobs are not asked of the gateway", (await jobs.runProbe(job(s1.id))).known, null);
} finally {
  for (const s of spawned) if (alive(s.child.pid)) s.child.kill();
  try {
    execFileSync("git", ["-C", repo, "worktree", "prune"]);
  } catch {
    /* best effort */
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

console.log(`\n${total} checks, ${failed ? `${failed} FAILED` : "all passed"}`);
console.log(failed ? "RESULT: FAILED" : "RESULT: ALL PASS");
process.exit(failed ? 1 : 0);
