// Agent spawning + supervision (Stage 1: `hermes chat -w` one-shot runs).
//
// Verified behaviour this wraps (probed live, not guessed):
//   hermes chat -q "<prompt>" -w -Q --format stream-json [--run-budget N] [--max-turns N] [-m model] [--yolo]
// emits newline-delimited JSON on stdout:
//   {"type":"system","subtype":"init","model":...,"session_id":...}
//   {"type":"text","text":"..."}
//   {"type":"result","session_id":...,"exit_code":0,"text":...,"tokens":{...},"duration_ms":...}
// followed by a plain `session_id: <id>` line. -w creates the git worktree itself
// under .worktrees/ and Hermes owns its later reclaim.
//
// The one non-obvious requirement: a spawned CLI does NOT inherit the OpenRouter
// key on this box (it lives in HKCU\Environment, and the process tree predates it),
// so without injection the agent dies instantly with "credentials or agent init
// failed". The key is therefore read from the registry and passed in the child's
// environment — never logged, never returned by the API.
import { spawn as spawnChild, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const pexec = promisify(execFile);
const MAX_LINES = 600;
const TAIL = 60;
let lineSeq = 0;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function defaultHome() {
  const local = process.env.LOCALAPPDATA || process.env.HOME || "";
  return path.join(local, "hermes");
}

// ---- credential -----------------------------------------------------------------
let keyCache = { at: 0, value: null };

async function openRouterKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  if (Date.now() - keyCache.at < 60_000) return keyCache.value;
  let value = null;
  try {
    const { stdout } = await pexec("reg", ["query", "HKCU\\Environment", "/v", "OPENROUTER_API_KEY"], { timeout: 10_000, windowsHide: true });
    const m = /REG_(?:SZ|EXPAND_SZ)\s+(.+)$/m.exec(stdout);
    value = m ? m[1].trim() : null;
  } catch {
    value = null;
  }
  keyCache = { at: Date.now(), value };
  return value;
}

export function keyStatus() {
  return { fromEnv: Boolean(process.env.OPENROUTER_API_KEY), cached: Boolean(keyCache.value) };
}

async function childEnv() {
  const env = { ...process.env };
  // Never hand a spawned native CLI an MSYS-shaped home — that is what produced
  // the "no dependency environment is committed" failure earlier today.
  if (env.HERMES_HOME && env.HERMES_HOME.startsWith("/")) delete env.HERMES_HOME;
  if (!env.HERMES_HOME) env.HERMES_HOME = defaultHome();
  const key = await openRouterKey();
  if (key) env.OPENROUTER_API_KEY = key;
  return env;
}

// ---- threads --------------------------------------------------------------------
// Every agent is given a NAMED thread so it can be continued later. Verified behaviour:
// `hermes chat -c <name> --create-if-missing -q "..."` starts session S; a later, separate
// `hermes chat -c <name> -q "..."` continues session S (same id, same context) — even after
// that first run's worktree has been cleaned up, provided we point it at a directory that
// exists (`--in`) and stop it from cd-ing into the removed tree (`--no-restore-cwd`).
export function makeThreadName(prompt) {
  const slug = String(prompt || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28)
    .replace(/-+$/, "");
  return `wtgui-${slug || "agent"}-${randomUUID().slice(0, 6)}`;
}

// ---- argv -----------------------------------------------------------------------
export function buildArgv(o = {}) {
  const args = ["chat"];
  if (o.thread) {
    args.push("-c", String(o.thread));
    if (!o.reply) args.push("--create-if-missing");
  }
  args.push("-q", String(o.prompt ?? ""));
  if (o.reply) {
    // A reply continues the thread where the agent actually is: no new worktree, an explicit
    // directory that still exists, and no cd into a worktree that cleanup may have removed.
    if (o.resumeDir) args.push("--in", String(o.resumeDir));
    args.push("--no-restore-cwd");
  } else if (o.worktree !== false) {
    args.push("-w");
  }
  args.push("-Q", "--format", "stream-json");
  if (o.model) args.push("-m", String(o.model));
  if (o.skills) args.push("-s", String(o.skills));
  if (o.budget) args.push("--run-budget", String(o.budget));
  if (o.maxTurns) args.push("--max-turns", String(o.maxTurns));
  if (o.yolo) args.push("--yolo");
  return args;
}

export function resolveBinary(config = {}) {
  if (config.hermesBin && existsSync(config.hermesBin)) return config.hermesBin;
  const guess = path.join(defaultHome(), "bin", "hermes.exe");
  if (existsSync(guess)) return guess;
  return "hermes";
}

// ---- line rendering -------------------------------------------------------------
// Spawned CLIs emit ANSI colour codes even with -Q; strip them so the panel shows
// readable text instead of escape soup.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
const stripAnsi = (s) => String(s ?? "").replace(ANSI_RE, "");

function parseLine(raw) {
  const t = stripAnsi(raw).replace(/\r$/, "").trim();
  if (!t) return null;
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t);
      if (j.type === "system") return { kind: "init", text: `init · model ${j.model || "?"} · session ${j.session_id || "?"}`, json: j };
      if (j.type === "text") return { kind: "text", text: String(j.text ?? ""), json: j };
      if (j.type === "result") {
        const tk = j.tokens || {};
        return {
          kind: "result",
          text: `result · exit ${j.exit_code} · ${j.duration_ms}ms · tokens ${tk.total ?? "?"} (in ${tk.input ?? "?"} / out ${tk.output ?? "?"})${j.error ? ` · ${j.error}` : ""}`,
          json: j,
        };
      }
      if (j.type === "tool" || j.tool || j.name) return { kind: "tool", text: `${j.type || "tool"}${j.name ? ` · ${j.name}` : ""}`, json: j };
      return { kind: "json", text: [j.type, j.subtype].filter(Boolean).join("/") || "event", json: j };
    } catch {
      return { kind: "raw", text: t };
    }
  }
  return { kind: "raw", text: t };
}

const WT_RE = /\.worktrees[\\/]([^\\/\s"']+)/;

// ---- registry -------------------------------------------------------------------
export class Jobs {
  constructor({ config = {}, onEvent = () => {}, onLog = log } = {}) {
    this.config = config;
    this.onEvent = onEvent;
    this.onLog = onLog;
    this.jobs = new Map();
    this.binary = resolveBinary(config);
    this.maxRuntimeSeconds = Number(config.jobMaxRuntimeSeconds) || 3600;
  }

  summary(j) {
    return {
      id: j.id,
      status: j.status,
      pid: j.pid,
      prompt: j.prompt,
      yolo: j.yolo,
      model: j.model,
      worktree: j.worktree,
      worktreePath: j.worktreePath || null,
      cwd: j.cwd || null,
      thread: j.thread,
      turn: j.turn,
      reply: Boolean(j.reply),
      replyTo: j.replyTo || null,
      maxTurns: j.maxTurns || null,
      budget: j.budget || null,
      sessionId: j.sessionId,
      startedAt: j.startedAt,
      endedAt: j.endedAt,
      exitCode: j.exitCode,
      tokens: j.tokens,
      durationMs: j.durationMs,
      binary: this.binary,
      error: j.error || null,
      lines: j.lines.slice(-TAIL),
    };
  }

  list() {
    return [...this.jobs.values()]
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .map((j) => this.summary(j));
  }

  emit(j) {
    this.onEvent({ type: "job", job: this.summary(j) });
  }

  push(j, line) {
    line.lid = ++lineSeq;
    // The CLI streams the agent's prose one fragment at a time ("A", " git worktree gives
    // each", …) and interleaves it with tool events, so merging only *adjacent* text left a
    // wall of shards. Instead keep one open line per PARAGRAPH and grow it in place no
    // matter what lands in between. Fragments are usually deltas, but some phases resend
    // everything so far — detect that and replace instead of appending.
    if (line.kind === "text") {
      const fragment = stripAnsi(line.text ?? "");
      if (j.curText && !/^\s*\r?\n\s*\r?\n/.test(fragment)) {
        const prev = j.curText.text;
        const cumulative = fragment.length >= prev.length && fragment.trimStart().startsWith(prev.trimStart());
        j.curText.text = cumulative ? fragment.replace(/^\s*\n+/, "") : prev + fragment;
        this.onEvent({ type: "jobline", id: j.id, line: { kind: "text", lid: j.curText.lid, text: j.curText.text, mode: "set" } });
        return;
      }
      j.curText = { kind: "text", lid: line.lid, text: fragment.replace(/^\s*\n+/, "") };
      j.lines.push(j.curText);
      if (j.lines.length > MAX_LINES) j.lines.splice(0, j.lines.length - MAX_LINES);
      this.onEvent({ type: "jobline", id: j.id, line: { ...j.curText, mode: "new" } });
      return;
    }
    if (line.kind === "result" || line.kind === "init") j.curText = null;
    j.lines.push(line);
    if (j.lines.length > MAX_LINES) j.lines.splice(0, j.lines.length - MAX_LINES);
    this.onEvent({ type: "jobline", id: j.id, line });
  }

  async create(opts = {}) {
    const prompt = String(opts.prompt ?? "").trim();
    if (!prompt) throw new Error("prompt is required");
    // One conversation per thread: turns share the thread name, so the CLI continues the same
    // session and the UI can group them into a single card.
    const thread = opts.thread || makeThreadName(prompt);
    const siblings = [...this.jobs.values()].filter((x) => x.thread === thread);
    const argv = buildArgv({ ...opts, prompt, thread });
    const j = {
      id: randomUUID().slice(0, 8),
      thread,
      turn: siblings.length + 1,
      replyTo: siblings[0]?.id || null,
      reply: Boolean(opts.reply),
      prompt,
      argv,
      yolo: Boolean(opts.yolo),
      model: opts.model || null,
      status: "starting",
      pid: null,
      child: null,
      lines: [],
      worktree: null,
      cwd: null,
      sessionId: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      fatal: null,
      worktreePath: null,
      maxTurns: opts.maxTurns || null,
      budget: opts.budget || null,
      tokens: null,
      durationMs: null,
      error: null,
      timer: null,
    };
    this.jobs.set(j.id, j);

    const env = await childEnv();
    const cwd = opts.cwd || this.config.defaultCwd || process.cwd();
    j.cwd = cwd;
    this.onLog(`spawn ${j.id}: ${this.binary} ${argv.join(" ").slice(0, 160)} (cwd ${cwd})`);
    j.lines.push({ kind: "cmd", text: `${this.binary} ${argv.join(" ")}` });

    let child;
    try {
      child = spawnChild(this.binary, argv, { cwd, env, windowsHide: true, shell: false });
    } catch (e) {
      j.status = "failed";
      j.error = `spawn failed: ${e.message}`;
      j.endedAt = new Date().toISOString();
      this.emit(j);
      return this.summary(j);
    }

    j.child = child;
    j.pid = child.pid;
    j.status = "running";
    this.emit(j);

    // hard cap so a runaway agent cannot outlive its budget by much
    j.timer = setTimeout(() => {
      if (j.status === "running") {
        j.error = `killed: exceeded ${this.maxRuntimeSeconds}s panel cap`;
        this.cancel(j.id);
      }
    }, this.maxRuntimeSeconds * 1000);

    const consume = (buf, stream) => {
      for (const raw of String(buf).split(/\r?\n/)) {
        const line = parseLine(raw);
        if (!line) continue;
        if (line.kind === "init" && line.json?.session_id) j.sessionId = line.json.session_id;
        if (line.kind === "result") {
          j.tokens = line.json?.tokens || null;
          j.durationMs = line.json?.duration_ms ?? null;
          j.exitCode = line.json?.exit_code ?? j.exitCode;
          if (line.json?.session_id) j.sessionId = line.json.session_id;
        }
        if (!j.worktree) {
          const m = WT_RE.exec(line.text || "") || (line.json ? WT_RE.exec(JSON.stringify(line.json)) : null);
          if (m) j.worktree = m[1];
        }
        // `hermes -w` exits 0 even when it never created a worktree (measured: prints the error
        // at ~3.8s, closes at ~4.1s with code 0). Without this the card would claim "done" for a
        // run that never started, so the CLI's own output decides the outcome.
        if (line.kind === "raw") {
          const made = /Worktree created:\s*(.+?)\s*$/i.exec(line.text || "");
          if (made) j.worktreePath = made[1];
          if (/Worktree cleaned up:/i.test(line.text || "")) j.worktreePath = null;
        }
        if (line.kind === "raw" && /\bFailed to (create|switch|add)\b/i.test(line.text || "")) {
          j.fatal = line.text;
          j.error = line.text;
          j.status = "failed";
        }
        this.push(j, { ...line, stream });
      }
    };
    let outBuf = "";
    let errBuf = "";
    child.stdout.on("data", (d) => {
      outBuf += d.toString();
      const parts = outBuf.split(/\r?\n/);
      outBuf = parts.pop();
      consume(parts.join("\n"), "stdout");
    });
    child.stderr.on("data", (d) => {
      errBuf += d.toString();
      const parts = errBuf.split(/\r?\n/);
      errBuf = parts.pop();
      consume(parts.join("\n"), "stderr");
    });
    child.on("error", (e) => {
      j.status = "failed";
      j.error = e.message;
      j.endedAt = new Date().toISOString();
      clearTimeout(j.timer);
      this.emit(j);
    });
    child.on("close", (code, signal) => {
      if (outBuf.trim()) consume(outBuf, "stdout");
      if (errBuf.trim()) consume(errBuf, "stderr");
      clearTimeout(j.timer);
      j.exitCode = code;
      if (j.status !== "cancelled") j.status = j.fatal ? "failed" : code === 0 ? "done" : "failed";
      if (signal) j.error = j.error || `signal ${signal}`;
      j.endedAt = new Date().toISOString();
      this.onLog(`job ${j.id} ${j.status} (exit ${code})${j.worktree ? ` worktree ${j.worktree}` : ""}`);
      this.emit(j);
    });

    return this.summary(j);
  }

  // The first turn of a conversation (its cwd, model, flags are the defaults for replies).
  firstOfThread(thread) {
    if (!thread) return null;
    return [...this.jobs.values()].filter((j) => j.thread === thread).sort((a, b) => (a.turn || 1) - (b.turn || 1))[0] || null;
  }

  cancel(id) {
    const j = this.jobs.get(id);
    if (!j || !j.pid || j.status !== "running") return false;
    try {
      // kill the tree: hermes spawns python/node children
      spawnChild("taskkill", ["/PID", String(j.pid), "/T", "/F"], { windowsHide: true });
    } catch {
      /* fall through to the status update */
    }
    j.status = "cancelled";
    j.endedAt = new Date().toISOString();
    clearTimeout(j.timer);
    this.emit(j);
    return true;
  }

  clearFinished() {
    for (const [id, j] of [...this.jobs]) if (j.status !== "running") this.jobs.delete(id);
  }
}
