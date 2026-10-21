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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const pexec = promisify(execFile);
const MAX_LINES = 600;
const TAIL = 60;
const KEEP_JOBS = 80; // persisted conversations, newest first
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
  // Where should it run?
  //   reply     -> continue the thread in place (its worktree if that survived, else the project)
  //   existing  -> run IN the directory given, no new worktree at all (an existing worktree)
  //   otherwise -> -w: create a fresh worktree + branch
  const runIn = o.reply ? o.resumeDir : o.existing ? o.cwd : null;
  if (runIn) {
    args.push("--in", String(runIn));
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
    // The registry is persisted so a restart does not lose the fact that an agent ran in a
    // worktree (the row's agent chip is derived from it) and does not empty the Agents list.
    this.storePath = config.jobsFile || null;
    this.persistTimer = null;
    this.load();
  }

  load() {
    if (!this.storePath || !existsSync(this.storePath)) return;
    try {
      const saved = JSON.parse(readFileSync(this.storePath, "utf8"));
      for (const j of saved.jobs || []) {
        // A job cannot still be running if the process that owned it is gone.
        if (j.status === "running" || j.status === "starting") {
          j.status = "interrupted";
          j.error = j.error || "the panel restarted while this was running";
        }
        j.child = null;
        j.timer = null;
        this.jobs.set(j.id, j);
        for (const l of j.lines || []) if (l.lid && l.lid > lineSeq) lineSeq = l.lid;
      }
      this.onLog(`restored ${this.jobs.size} job(s) from ${this.storePath}`);
    } catch (e) {
      this.onLog(`could not read ${this.storePath}: ${String((e && e.message) || e)}`);
    }
  }

  schedulePersist() {
    if (!this.storePath || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        const jobs = [...this.jobs.values()]
          .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
          .slice(0, KEEP_JOBS)
          .map((j) => ({
            id: j.id, thread: j.thread, turn: j.turn, reply: j.reply, existing: j.existing,
            prompt: j.prompt, cwd: j.cwd, worktree: j.worktree, worktreePath: j.worktreePath,
            sessionId: j.sessionId, status: j.status, exitCode: j.exitCode, fatal: j.fatal,
            startedAt: j.startedAt, endedAt: j.endedAt, model: j.model, yolo: j.yolo,
            budget: j.budget, maxTurns: j.maxTurns, tokens: j.tokens, error: j.error,
            durationMs: j.durationMs, lines: (j.lines || []).slice(-120),
          }));
        mkdirSync(path.dirname(this.storePath), { recursive: true });
        writeFileSync(this.storePath, JSON.stringify({ savedAt: new Date().toISOString(), jobs }, null, 0));
      } catch {
        /* persistence is a convenience: never let it break a run */
      }
    }, 700);
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
      ownerPath: j.ownerPath || null,
      ownerPending: Boolean(j.ownerPending),
      cwd: j.cwd || null,
      thread: j.thread,
      turn: j.turn,
      reply: Boolean(j.reply),
      existing: Boolean(j.existing),
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
    this.schedulePersist();
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
      existing: Boolean(opts.existing),
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
      // The worktree that OWNS this agent, fixed when it is created: the tree it was started in
      // ("existing"), or the tree `-w` made for it (filled in when the CLI prints it). null means
      // homeless: it runs somewhere that is not one of our worktrees, so it lives in the Agents
      // panel instead of under a row.
      ownerPath: opts.ownerPath ? String(opts.ownerPath).replace(/\\/g, "/").replace(/\/+$/, "") : null,
      ownerPending: Boolean(opts.ownerPending),
      maxTurns: opts.maxTurns || null,
      budget: opts.budget || null,
      tokens: null,
      durationMs: null,
      error: null,
      timer: null,
    };
    this.jobs.set(j.id, j);

    const env = { ...(await childEnv()), WTGUI_THREAD: thread };
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
          if (made) {
            j.worktreePath = made[1];
            // The spawn was waiting for this: the tree it created is now the agent's home.
            if (!j.ownerPath) {
              j.ownerPath = String(made[1]).replace(/\\/g, "/").replace(/\/+$/, "");
              j.ownerPending = false;
              this.emit(j);
            }
          }
          if (/Worktree cleaned up:/i.test(line.text || "")) {
            // The tree is gone, so the agent has no home to be shown under any more.
            j.worktreePath = null;
            if (j.ownerPath) {
              j.ownerPath = null;
              j.ownerPending = false;
              this.emit(j);
            }
          }
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

  // Where each agent is actually working, for the panel's own row <-> agent mapping.
  // A `-w` spawn works in the worktree it created (worktreePath); an existing-worktree run or a
  // reply works in its cwd. This matters because Hermes stores NO cwd for the `-c` named-thread
  // sessions the panel starts, so the session store cannot place them — the panel can.
  agentPaths() {
    const map = new Map();
    const add = (p, j) => {
      if (!p) return;
      const key = String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      const cur = map.get(key) || { running: 0, total: 0, threads: [], ids: [] };
      if (cur.ids.includes(j.id)) return; // ownerPath and worktreePath are usually the same tree
      cur.ids.push(j.id);
      cur.total += 1;
      if (j.status === "running" || j.status === "starting") cur.running += 1;
      if (!cur.threads.includes(j.thread)) cur.threads.push(j.thread);
      map.set(key, cur);
    };
    for (const j of this.jobs.values()) {
      // Ownership first: an agent belongs to the tree it was made for even if it later reads or
      // writes somewhere else. cwd is only the fallback for jobs created before ownership existed.
      if (j.ownerPath) add(j.ownerPath, j);
      else if (j.existing || j.reply) add(j.cwd, j);
      if (j.worktreePath) add(j.worktreePath, j);
    }
    return map;
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

  // Move an agent (every turn of its thread) under a worktree, or back to unattached with null.
  setOwner(thread, ownerPath) {
    const mine = [...this.jobs.values()].filter((j) => j.thread === thread);
    if (!mine.length) return { ok: false, error: "unknown thread", turns: 0 };
    const norm = ownerPath ? String(ownerPath).replace(/\\/g, "/").replace(/\/+$/, "") : null;
    for (const j of mine) {
      j.ownerPath = norm;
      j.ownerPending = false;
    }
    this.schedulePersist();
    this.emit(mine[mine.length - 1]);
    return { ok: true, ownerPath: norm, turns: mine.length };
  }

  clearFinished() {
    for (const [id, j] of [...this.jobs]) if (j.status !== "running") this.jobs.delete(id);
    this.schedulePersist();
  }

  // Forget ONE conversation: every turn of its thread, provided none of them is still running.
  // This drops the panel's record (and the transcript it persisted); the worktree and branch the
  // agent made are untouched — they are git's business, not the panel's.
  clearThread(thread) {
    const mine = [...this.jobs.values()].filter((j) => j.thread === thread);
    const running = mine.filter((j) => j.status === "running" || j.status === "starting");
    if (running.length) return { ok: false, running: running.length, removed: 0 };
    for (const j of mine) this.jobs.delete(j.id);
    this.schedulePersist();
    return { ok: true, removed: mine.length, running: 0 };
  }
}
