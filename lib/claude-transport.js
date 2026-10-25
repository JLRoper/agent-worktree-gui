// Claude Code CLI transport: one `claude -p` process per turn, spoken to in stream-json over stdio.
//
// The process is this panel's child, so unlike a Hermes run it does not outlive the panel and there is nothing to
// re-attach to. What the CLI writes on stdout goes through lib/claude-stream.js, which turns it into the same
// `{ event, ... }` shapes the Hermes SSE stream produces, so the card, console and notice code are shared.
//
// Phase 2c covers spawn, stream and stop; 2d adds reply and steer. A reply is a new process with `--resume <session>`
// (the CLI refuses `--session-id` beside `--resume` unless forking, so the session id is whatever `init` reports). A
// steer is a `user` message on stdin while the turn runs; the CLI reads it at the next tool boundary and folds it into
// the same turn. Approvals are 2e: those calls answer `not_in_2c` here rather than pretending.
// `--permission-prompt-tool stdio` is deliberately NOT passed: with it the
// CLI waits for a `can_use_tool` answer that nothing in this build gives, and the job would hang. Without it, `-p`
// mode denies a tool that needs permission and reports it in the result's `permission_denials`.
//
// Protocol proven on CLI 2.1.310 (tools/spike-claude-stream.mjs).

import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Transport } from "./transport.js";
import { translateLine, lineSplitter, newStreamState, initializeRequest, userTurn, interruptRequest } from "./claude-stream.js";

const KILL_AFTER_MS = 5_000;
const STDERR_TAIL = 2_000;
const NOT_IN_2C = (what) => ({ ok: false, code: "not_in_2c", error: `${what} is not available for Claude jobs yet` });

export class ClaudeTransport extends Transport {
  constructor({ jobs, onLog, spawnFn = spawn } = {}) {
    super({ onLog });
    this.jobs = jobs;
    this.spawnFn = spawnFn;
    // job id -> { child, state, held, stderr, exited, killTimer }. Kept off the job object: a job is persisted and
    // summarised, a process handle is neither.
    this.procs = new Map();
    this.state = { reachable: null, checkedAt: 0, version: null, error: null };
  }

  get config() {
    return this.jobs.config || {};
  }

  get bin() {
    return this.config.claudeBin || "claude";
  }

  info() {
    return { agent: "claude", bin: this.bin, ...this.state };
  }

  // `claude --version` answers without spending anything, so it is the reachability check.
  async probe({ fresh = false } = {}) {
    const now = Date.now();
    if (!fresh && this.state.checkedAt && now - this.state.checkedAt < 60_000) return this.state;
    this.state = await new Promise((resolve) => {
      execFile(this.bin, ["--version"], { timeout: 15_000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve({ reachable: false, checkedAt: now, version: null, error: `${this.bin} --version failed: ${String((err && err.message) || err)}` });
        resolve({ reachable: true, checkedAt: now, version: String(stdout || "").trim().split(/\s+/)[0] || null, error: null });
      });
    });
    return this.state;
  }

  // The permission mode a job runs with. `bypassPermissions` only for a job the reader started with yolo.
  permissionMode(j) {
    if (j.yolo) return "bypassPermissions";
    return String(this.config.claudePermissionMode || "default");
  }

  // A first turn names its session; a reply resumes the thread's (and must not name one: the CLI refuses both).
  args(j, sessionId, { resume = false } = {}) {
    const budget = Number(j.budget) > 0 ? Number(j.budget) : Number(this.config.claudeBudgetUsd) > 0 ? Number(this.config.claudeBudgetUsd) : 0.5;
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", resume ? "--resume" : "--session-id", sessionId];
    if (j.model) args.push("--model", String(j.model));
    args.push("--max-budget-usd", String(budget), "--permission-mode", this.permissionMode(j));
    return args;
  }

  async create(j, { prompt, opts = {}, cwd }) {
    const jobs = this.jobs;
    const resume = Boolean(j.resumeSession);
    const sessionId = j.resumeSession || randomUUID();
    const args = this.args(j, sessionId, { resume });
    // The prompt goes on stdin, never in argv: argv is visible to every process on the machine and has a length cap.
    const pre = opts.preamble ? `${String(opts.preamble).trim()}\n\n---\n\n` : "";
    if (opts.note) jobs.push(j, { kind: "dim", text: String(opts.note) });
    jobs.push(j, { kind: "cmd", text: `${this.bin} ${args.join(" ")} · cwd ${cwd}` });
    if (opts.maxTurns) jobs.push(j, { kind: "dim", text: "⇢ max turns is not a Claude CLI option — the budget cap applies instead" });
    if (pre) jobs.push(j, { kind: "dim", text: "⇢ assistant context attached — scratchpad, watches and the board digest ride with this turn" });
    jobs.onLog(`run ${j.id}: claude session ${sessionId}${resume ? " (resumed)" : ""} cwd ${cwd}`);

    let child;
    try {
      child = this.spawnFn(this.bin, args, { cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return this.failBeforeStart(j, `could not start ${this.bin}: ${String((e && e.message) || e)}`);
    }
    const p = { child, state: newStreamState(), held: null, results: 0, steers: 0, stderr: "", exited: false, killTimer: null };
    this.procs.set(j.id, p);

    // The session is what a reply resumes, the run id is what the card shows. A first turn's run id is its session
    // uuid; a reply shares the session, so its run id carries the turn number to stay unique.
    j.sessionId = sessionId;
    j.runId = resume ? `claude-${sessionId}-t${j.turn}` : `claude-${sessionId}`;
    j.status = "running";
    jobs.push(j, { kind: "init", text: `run ${j.runId} · claude ${j.model || "default model"} · cwd ${cwd}` });
    jobs.emit(j);
    jobs.armRuntimeCap(j);

    const split = lineSplitter((line) => this.onLine(j, p, line));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => split.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      p.stderr = (p.stderr + chunk).slice(-STDERR_TAIL);
      for (const l of String(chunk).split(/\r?\n/)) if (l.trim()) jobs.onLog(`run ${j.id} stderr: ${l.slice(0, 300)}`);
    });
    // A dead pipe must not throw out of the panel: the exit handler is where the job is settled.
    child.stdin.on("error", () => {});
    child.on("error", (e) => {
      // ENOENT and friends arrive here instead of from spawn() itself. No exit event follows.
      if (p.exited) return;
      p.exited = true;
      this.procs.delete(j.id);
      this.finish(j, p, { code: null, why: `could not start ${this.bin}: ${String((e && e.message) || e)}` });
    });
    child.on("close", (code, signal) => {
      split.flush();
      if (p.exited) return;
      p.exited = true;
      clearTimeout(p.killTimer);
      this.procs.delete(j.id);
      this.finish(j, p, { code, signal });
    });

    this.write(p, initializeRequest(randomUUID()));
    this.write(p, userTurn(pre + prompt));
    return jobs.summary(j);
  }

  write(p, obj) {
    if (p.exited || !p.child.stdin.writable) return false;
    try {
      p.child.stdin.write(`${JSON.stringify(obj)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  onLine(j, p, line) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      this.jobs.push(j, { kind: "raw", text: line.slice(0, 400) });
      return;
    }
    for (const evt of translateLine(obj, p.state)) {
      if (evt.event === "claude.init") {
        if (evt.model && !j.model) j.model = evt.model;
        // The CLI's word on the session is the one the next reply resumes (a resume keeps the id; a fork would not).
        if (evt.sessionId && evt.sessionId !== j.sessionId) {
          this.jobs.onLog(`run ${j.id}: claude reports session ${evt.sessionId} (asked for ${j.sessionId})`);
          j.sessionId = evt.sessionId;
          this.jobs.emit(j);
        }
        continue;
      }
      if (evt.event === "claude.unparsed") {
        this.jobs.push(j, { kind: "raw", text: String(evt.text || "").slice(0, 400) });
        continue;
      }
      if (/^run\.(completed|failed|cancelled)$/.test(evt.event)) {
        // The turn has answered, but the job ends when the process exits: a background task can still wake the
        // session for a second result. Closing stdin is what tells the CLI there is no next turn, and it is also
        // where steering ends. A steer that crossed the turn's last tool boundary on its way in is answered as a
        // turn of its own after this result, so a later result replaces the held one: the job settles on the last.
        p.held = evt;
        p.results++;
        try {
          p.child.stdin.end();
        } catch {
          /* already closed */
        }
        continue;
      }
      this.jobs.consume(j, evt);
    }
  }

  // The process is gone. Settle on the last result it wrote, or say why there was none.
  finish(j, p, { code = null, signal = null, why = "" } = {}) {
    const jobs = this.jobs;
    if (j.status !== "running" && j.status !== "starting") return; // a restart sweep already gave it a verdict
    let evt = p.held;
    if (!evt) {
      const tail = p.stderr.trim().split(/\r?\n/).slice(-3).join(" | ");
      if (p.state.stopRequested) evt = { event: "run.cancelled", output: "" };
      else evt = { event: "run.failed", output: "", error: why || `claude exited (code ${code}${signal ? `, ${signal}` : ""}) without a result${tail ? `: ${tail}` : ""}` };
    } else if (p.state.stopRequested && evt.event === "run.failed") {
      evt = { ...evt, event: "run.cancelled" };
    }
    if (p.results > 1) jobs.push(j, { kind: "dim", text: `⇢ claude answered ${p.results} times in this turn (a late steer or a background task) — the last answer is the turn's` });
    if (evt.totalCostUsd !== null && evt.totalCostUsd !== undefined) {
      jobs.push(j, { kind: "dim", text: `cost $${Number(evt.totalCostUsd).toFixed(4)} · ${evt.turns || 0} turn(s)${evt.permissionDenials ? ` · ${evt.permissionDenials} tool call(s) denied (approvals are not wired for Claude jobs yet)` : ""}` });
    }
    if (evt.totalCostUsd !== undefined) j.costUsd = evt.totalCostUsd;
    jobs.consume(j, evt);
  }

  failBeforeStart(j, error) {
    const jobs = this.jobs;
    j.status = "failed";
    j.error = error;
    j.endedAt = new Date().toISOString();
    jobs.push(j, { kind: "raw", text: error });
    jobs.finalise(j);
    jobs.emit(j);
    return jobs.summary(j);
  }

  // Interrupt the turn, then make sure the process is gone. The CLI answers an interrupt with an
  // `error_during_execution` result and exit 1, which the translator reads as a cancel because we asked for it.
  async stop(j) {
    const p = this.procs.get(j.id);
    if (!p) return false;
    p.state.stopRequested = true;
    const sent = this.write(p, interruptRequest(randomUUID()));
    this.jobs.push(j, { kind: "raw", text: sent ? "stop requested — interrupting the claude process" : "stop requested — ending the claude process" });
    clearTimeout(p.killTimer);
    p.killTimer = setTimeout(() => this.kill(p), sent ? KILL_AFTER_MS : 0);
    p.killTimer.unref?.();
    return true;
  }

  // The whole tree: the CLI starts its own children (shells, MCP servers).
  kill(p) {
    if (p.exited) return;
    const pid = p.child.pid;
    if (process.platform === "win32" && pid) {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
    } else {
      try {
        p.child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }

  // A restart has given this job its verdict; the process must not outlive it.
  abandon(j) {
    const p = this.procs.get(j.id);
    if (!p) return;
    p.state.stopRequested = true;
    this.kill(p);
  }

  // The stream is attached at spawn, so there is nothing to re-follow; and the process is the status.
  async follow() {}

  async poll(j) {
    if ((j.status === "running" || j.status === "starting") && !this.procs.has(j.id) && j.runId) {
      this.finish(j, { held: null, stderr: "", state: { stopRequested: false } }, { why: "the claude process is gone and left no result" });
    }
  }

  async runStatus() {
    return null;
  }

  // A Claude run has no record outside this process: there is no gateway to ask.
  async runProbe(j) {
    return { known: null, reachable: false, error: this.procs.has(j?.id) ? "claude process alive" : "no claude process" };
  }

  async controlContext() {
    return { promptId: null, generation: 0 };
  }

  // A `user` message on the running process's stdin. Only before the turn's result: by then stdin is closed (that is
  // what lets the process exit), and the answer is the same 409 a Hermes run gives past its last tool boundary.
  async steer(j, clean) {
    const p = this.procs.get(j.id);
    if (!p || p.exited || p.held || p.state.stopRequested || !p.child.stdin.writable) {
      return { ok: false, code: "run_not_accepting_steer", error: "this Claude turn has already answered — reply instead" };
    }
    if (!this.write(p, userTurn(clean))) return { ok: false, code: "run_not_accepting_steer", error: "the claude process is no longer reading input" };
    p.steers++;
    this.jobs.push(j, { kind: "dim", text: `⇢ steer sent: ${clean.slice(0, 200)}` });
    return { ok: true, accepted: true, runId: j.runId };
  }

  async approve() {
    return NOT_IN_2C("answering an approval");
  }

  async clarify() {
    return NOT_IN_2C("answering a question");
  }
}
