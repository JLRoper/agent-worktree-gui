// Restarting the Hermes gateway, or this panel, from the board.
//
// A restart asked for during an assistant turn is a turn asking for its own process to be replaced: the
// turn itself runs in the gateway, so a synchronous restart kills it before its answer is sent. Every
// request is therefore QUEUED and runs only once the requesting turn has ended.
//
// Two failures this module exists to prevent.
//
//   1. A gateway started from a tool shell comes up with no provider credentials: it binds its port,
//      answers /health, and then every run it dispatches dies with "No LLM provider configured". The
//      provider key is therefore verified in `$HERMES_HOME/.env` BEFORE anything is stopped, and the
//      refusal is the answer when it is not there.
//   2. A run never left "running". Everything a restart kills is given one terminal status — interrupted,
//      with the restart recorded as the termination — before anything is stopped, so no card is left with
//      neither a done nor an interrupted verdict.
//
// After the new process is up it is proved with ONE REAL TURN through the gateway, never with its
// listening port, and only then is the assistant woken once with the completion payload of everything the
// restart interrupted. A gateway restart the panel did NOT ask for fires the same single wake — that path
// lives in lib/jobs.js (`sweepOrphanedRuns`) and calls `Assistant.wakeAfterRestart` with the runs it lost.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readBlockValue } from "./hermes-config.js";
import { ASSISTANT_THREAD } from "./assistant.js";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// The token the proof turn must produce. It is not a health check dressed up: the run has to be accepted,
// dispatched to a model and answered, which is the only thing that proves the provider credentials were
// loaded. A restarted gateway without them still answers this request and then fails the run.
export const PROOF_PROMPT = "Reply with exactly this token and nothing else: PANEL-RESTART-OK";

// Credential names Hermes reads from `$HERMES_HOME/.env`. The check wants a NAME with a value, never the
// value: nothing here logs or returns the key itself.
export const PROVIDER_KEY_NAMES = [
  "OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY",
  "GROQ_API_KEY", "DEEPSEEK_API_KEY", "MISTRAL_API_KEY", "XAI_API_KEY", "TOGETHER_API_KEY",
];

const TERMINAL_RUN = new Set(["completed", "failed", "cancelled", "interrupted"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// Where the panel remembers a restart that crosses its own death (only a panel restart needs it).
export function restartFilePath(config = {}) {
  const base = config.restartFile
    || path.join(path.dirname(config.jobsFile || path.join(config.defaultCwd || process.cwd(), "logs", "jobs.json")), "restart.json");
  return base;
}

export function gatewayRestartLogPath(config = {}) {
  return config.gatewayRestartLog
    || path.join(path.dirname(restartFilePath(config)), "gateway-restart.log");
}

// ---- does the gateway have a provider key to come back with? --------------------------------
// The .env file is the authority: the gateway loads it with override, so a key written there survives
// however the process was launched. The `model.api_key` line in config.yaml is read as a second source —
// the panel's own Settings surface writes there — and the answer always names which one was found.
export function providerKeyCheck(home = null) {
  const dir = home || process.env.HERMES_HOME || "";
  if (!dir) return { ok: false, source: null, path: null, name: null, reason: "no HERMES_HOME to look in for the gateway's .env" };
  const envPath = path.join(dir, ".env");
  let text = null;
  try {
    text = existsSync(envPath) ? readFileSync(envPath, "utf8") : null;
  } catch {
    text = null;
  }
  if (text !== null) {
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m || !PROVIDER_KEY_NAMES.includes(m[1])) continue;
      const value = m[2].trim().replace(/^["']|["']$/g, "").replace(/\s+#.*$/, "").trim();
      if (value) return { ok: true, source: "env", name: m[1], path: envPath, reason: null };
    }
  }
  const configPath = path.join(dir, "config.yaml");
  let cfg = null;
  try {
    cfg = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
  } catch {
    cfg = null;
  }
  const inFile = cfg === null ? null : readBlockValue(cfg, "model", "api_key");
  if (inFile) {
    return {
      ok: true,
      source: "config.yaml",
      name: "model.api_key",
      path: configPath,
      reason: null,
      note: `no provider key in ${envPath} — the gateway would only have the key written in ${configPath}`,
    };
  }
  return {
    ok: false,
    source: null,
    name: null,
    path: envPath,
    reason: `no provider key in ${envPath} (looked for ${PROVIDER_KEY_NAMES.slice(0, 4).join(", ")}…): a gateway started without one binds its port and then dies on every run with "No LLM provider configured"`,
  };
}

// What the gateway's own state file says. Corroboration for the log and for the status surface, never the
// proof: the proof is a real turn (a restarted gateway keeps answering /health either way).
export function gatewayIdentity(home = null) {
  const dir = home || process.env.HERMES_HOME || "";
  if (!dir) return null;
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, "gateway_state.json"), "utf8"));
    return { pid: raw.pid ?? null, startTime: raw.start_time ?? null, state: raw.gateway_state ?? null };
  } catch {
    return null;
  }
}

// ---- the proof ------------------------------------------------------------------------------
// One real turn through the gateway. `wait` covers only the boot of the new process; the verdict is the
// turn. Returns { ok, stage, runId, status, output, ms, reason }.
export async function proveGatewayTurn({
  api,
  prompt = PROOF_PROMPT,
  sessionId = null,
  timeoutMs = 180_000,
  waitReachableMs = 120_000,
  pollMs = 1_500,
  waitMs = 2_000,
  sleepFn = sleep,
  onProgress = null,
} = {}) {
  const url = String(api?.url || "").replace(/\/+$/, "");
  const key = api?.key || null;
  if (!url) return { ok: false, stage: "config", reason: "no gateway url" };
  const headers = { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) };

  // The new process has to answer before a turn can be sent — but answering is not the proof.
  const until = Date.now() + waitReachableMs;
  let reachable = false;
  let lastError = "";
  for (;;) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4_000);
      const res = await fetch(`${url}/v1/capabilities`, { headers, signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) {
        reachable = true;
        break;
      }
      lastError = `HTTP ${res.status} from /v1/capabilities`;
    } catch (e) {
      lastError = String((e && e.message) || e);
    }
    if (Date.now() >= until) return { ok: false, stage: "unreachable", reason: `${url} did not answer /v1/capabilities within ${Math.round(waitReachableMs / 1000)}s: ${lastError}` };
    await sleepFn(waitMs);
  }
  if (onProgress) onProgress("reachable");

  const thread = sessionId || `panel-restart-proof-${Date.now().toString(36)}`;
  let runId = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20_000);
    const res = await fetch(`${url}/v1/runs`, { method: "POST", headers, body: JSON.stringify({ input: prompt, session_id: thread }), signal: ctrl.signal });
    clearTimeout(t);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, stage: "submit", reason: `the gateway refused the proof turn (HTTP ${res.status})${body?.error?.message ? `: ${body.error.message}` : ""}` };
    }
    runId = body.run_id || body.runId || null;
    if (!runId) return { ok: false, stage: "submit", reason: "the gateway accepted the proof turn but returned no run id" };
  } catch (e) {
    return { ok: false, stage: "submit", reason: `could not send the proof turn: ${String((e && e.message) || e)}` };
  }
  if (onProgress) onProgress(`run ${runId}`);

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let run = null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8_000);
      const res = await fetch(`${url}/v1/runs/${runId}`, { headers, signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) run = await res.json();
    } catch {
      /* keep polling */
    }
    if (run && TERMINAL_RUN.has(String(run.status))) {
      const output = String(run.output ?? run.final_message ?? "").trim();
      const ok = run.status === "completed" && output.length > 0;
      return {
        ok,
        stage: "turn",
        runId,
        thread,
        status: String(run.status),
        output,
        ms: Date.now() - started,
        reason: ok ? null : `the proof turn ended ${run.status}${output ? "" : " with no output"}`,
      };
    }
    await sleepFn(pollMs);
  }
  return { ok: false, stage: "timeout", runId, thread, ms: Date.now() - started, reason: `the proof turn did not reach a terminal result within ${Math.round(timeoutMs / 1000)}s` };
}

// ---- the controller -------------------------------------------------------------------------
export class RestartController {
  constructor({
    config = {},
    jobs,
    assistant = null,
    home = null,
    hermesBin = null,
    credentials = () => null,
    log: onLog = log,
    onState = () => {},
    shutdown = null,
    // Everything below is injectable so the queueing, the health wait and the resume can be proved
    // without bouncing the live gateway or the live panel.
    runGatewayRestart = null,
    proveGateway = null,
    spawnPanel = null,
    sleepFn = sleep,
    now = () => Date.now(),
    pollMs = 1_000,
    waitMaxMs = 30 * 60_000,
    bootWaitMs = 90_000,
  } = {}) {
    this.config = config;
    this.jobs = jobs;
    this.assistant = assistant;
    this.home = home || process.env.HERMES_HOME || "";
    this.hermesBin = hermesBin || null;
    this.credentials = credentials;
    this.onLog = onLog;
    this.onState = onState;
    this.shutdown = shutdown;
    this.runGatewayRestart = runGatewayRestart;
    this.proveGateway = proveGateway;
    this.spawnPanel = spawnPanel;
    this.sleepFn = sleepFn;
    this.now = now;
    this.pollMs = pollMs;
    this.waitMaxMs = waitMaxMs;
    this.bootWaitMs = bootWaitMs;
    this.file = restartFilePath(config);
    this.queue = [];
    this.running = null;
    this.last = null;
    this.journal = [];
  }

  // ---- reading and writing the record --------------------------------------------------------
  readRecord() {
    try {
      if (!existsSync(this.file)) return null;
      return JSON.parse(readFileSync(this.file, "utf8"));
    } catch (e) {
      this.onLog(`could not read ${this.file}: ${String((e && e.message) || e)}`);
      return null;
    }
  }

  writeRecord(record) {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(record, null, 1));
      renameSync(tmp, this.file);
    } catch (e) {
      this.onLog(`could not write ${this.file}: ${String((e && e.message) || e)}`);
    }
  }

  note(text) {
    this.journal.push({ at: nowIso(), text: clip(text, 300) });
    if (this.journal.length > 60) this.journal.splice(0, this.journal.length - 60);
    this.onLog(`restart: ${text}`);
  }

  state() {
    return {
      provider: providerKeyCheck(this.home),
      gateway: gatewayIdentity(this.home),
      queued: this.queue.map((e) => ({ id: e.id, target: e.target, state: e.state, queuedAt: e.queuedAt, waitFor: e.thread, waitedMs: e.waitedMs || 0, reason: e.reason || "" })),
      running: this.running ? { id: this.running.id, target: this.running.target, state: this.running.state, at: this.running.at || null } : null,
      last: this.last || null,
      pending: (() => {
        const rec = this.readRecord();
        return rec && !rec.resumedAt ? { id: rec.id, target: rec.target, requestedAt: rec.requestedAt, running: (rec.runningIds || []).length } : null;
      })(),
      journal: this.journal.slice(-20).reverse(),
      file: this.file,
      at: this.now(),
    };
  }

  emitState() {
    try {
      this.onState(this.state());
    } catch {
      /* a state broadcast must never fail a restart */
    }
  }

  // ---- the request ---------------------------------------------------------------------------
  // Answers at once and never waits for the restart itself: the caller is usually a turn that the restart
  // would kill. Throws { status } for a refusal.
  request({ target, reason = "", waitFor = null, requestedBy = "reader" } = {}) {
    const t = String(target || "").trim().toLowerCase();
    if (t !== "gateway" && t !== "panel") {
      throw Object.assign(new Error('target must be "gateway" or "panel"'), { status: 400 });
    }
    if (this.running) throw Object.assign(new Error(`a ${this.running.target} restart is already running (${this.running.id})`), { status: 409 });
    const queued = this.queue.find((e) => e.state === "queued" || e.state === "waiting");
    if (queued) throw Object.assign(new Error(`a ${queued.target} restart is already queued (${queued.id})`), { status: 409 });
    const provider = providerKeyCheck(this.home);
    if (!provider.ok) throw Object.assign(new Error(`restart refused — ${provider.reason}`), { status: 409, provider });
    const entry = {
      id: randomUUID().slice(0, 8),
      target: t,
      reason: clip(reason, 300),
      requestedBy,
      thread: waitFor || ASSISTANT_THREAD,
      state: "queued",
      queuedAt: nowIso(),
      provider,
    };
    this.queue.push(entry);
    this.note(`${t} restart queued (${entry.id}) by ${entry.requestedBy}${entry.reason ? `: ${entry.reason}` : ""} — it runs when ${entry.thread} has no turn running`);
    this.emitState();
    // Deliberately not awaited: the request that queued it must be able to return.
    void this.loop(entry).catch((e) => {
      entry.state = "failed";
      entry.error = String((e && e.message) || e);
      this.note(`${entry.id} failed: ${entry.error}`);
      this.finish(entry);
    });
    return { ...entry, accepted: true, waitingFor: entry.thread };
  }

  livesOn(thread) {
    const t = String(thread || "");
    if (!t) return false;
    return this.jobs.list().some((j) => j.thread === t && (j.status === "running" || j.status === "starting"));
  }

  async loop(entry) {
    entry.state = "waiting";
    this.emitState();
    const started = this.now();
    while (this.livesOn(entry.thread)) {
      if (this.now() - started > this.waitMaxMs) {
        entry.waitedMs = this.now() - started;
        this.note(`${entry.id}: gave up waiting for ${entry.thread} after ${Math.round(entry.waitedMs / 1000)}s — running the restart anyway`);
        break;
      }
      await this.sleepFn(this.pollMs);
    }
    entry.waitedMs = this.now() - started;
    if (entry.waitedMs > 1_500) this.note(`${entry.id}: ${entry.thread} had no turn running after ${Math.round(entry.waitedMs / 1000)}s — the queued restart starts now`);
    await this.execute(entry);
  }

  async execute(entry) {
    entry.state = "running";
    entry.at = nowIso();
    this.running = entry;
    this.emitState();
    try {
      if (entry.target === "gateway") await this.executeGateway(entry);
      else await this.executePanel(entry);
      if (entry.state === "running") entry.state = entry.outcome?.ok === false ? "failed" : "done";
    } catch (e) {
      entry.state = "failed";
      entry.error = String((e && e.message) || e);
      this.note(`${entry.id} failed: ${entry.error}`);
    }
    if (entry.state !== "restarting") this.finish(entry);
  }

  finish(entry) {
    this.running = null;
    entry.finishedAt = nowIso();
    this.last = {
      id: entry.id,
      target: entry.target,
      state: entry.state,
      at: entry.finishedAt,
      proof: entry.proof || null,
      interrupted: (entry.interrupted || []).map((j) => ({ id: j.id, thread: j.thread })),
      error: entry.error || null,
    };
    this.queue = this.queue.filter((e) => e.id !== entry.id);
    this.emitState();
  }

  // ---- one terminal status for everything the restart will kill -------------------------------
  // Asked BEFORE anything is stopped. A run the gateway has already finished is adopted as its own verdict
  // (done/failed), never rewritten as interrupted; every run still going gets exactly one interrupted
  // status, recorded as the restart's doing. Returns the jobs it interrupted.
  async interruptRunning({ by = "gateway", detail = "" } = {}) {
    const running = this.jobs.runningJobs();
    const interrupted = [];
    for (const j of running) {
      let verdict = null;
      try {
        verdict = await this.jobs.runProbe(j);
      } catch {
        verdict = null;
      }
      if (verdict?.known === true && TERMINAL_RUN.has(String(verdict.run?.status))) {
        this.jobs.adoptRun(j, verdict.run);
        this.jobs.emit?.(j);
        continue;
      }
      if (this.jobs.markInterruptedByRestart(j, { by, detail })) interrupted.push(j);
    }
    for (const j of interrupted) {
      try {
        await this.jobs.measureTree(j);
      } catch {
        /* the notice is not held up by a git read that will not answer */
      }
    }
    return interrupted;
  }

  // ---- gateway ------------------------------------------------------------------------------
  async executeGateway(entry) {
    const identityBefore = gatewayIdentity(this.home);
    entry.identityBefore = identityBefore;
    const interrupted = await this.interruptRunning({ by: "gateway", detail: `the gateway was restarted from the panel (${entry.id})` });
    entry.interrupted = interrupted.map((j) => ({ id: j.id, thread: j.thread, word: j.completion?.word || "interrupted" }));
    this.note(`${entry.id}: ${interrupted.length} run(s) given an interrupted verdict before the gateway stops${interrupted.length ? ` (${interrupted.map((j) => j.id).join(", ")})` : ""}`);
    entry.restart = await this.restartGateway(entry);
    const proof = await this.proveGatewayTurn(entry);
    entry.proof = { ok: proof.ok, stage: proof.stage, runId: proof.runId || null, status: proof.status || null, output: clip(proof.output || "", 400), ms: proof.ms || null, reason: proof.reason || null, at: nowIso() };
    entry.outcome = { ok: proof.ok, proof: entry.proof, interrupted: entry.interrupted.length };
    this.note(proof.ok
      ? `${entry.id}: the gateway is back and answered a real turn in ${proof.ms}ms (run ${proof.runId})`
      : `${entry.id}: the gateway did NOT pass the real-turn proof — ${proof.reason}`);
    this.wakeOnce(entry, interrupted, entry.proof, { target: "gateway", detected: false });
  }

  async restartGateway(entry) {
    if (typeof this.runGatewayRestart === "function") return this.runGatewayRestart(entry, this);
    const bin = this.hermesBin || this.config.hermesBin || "hermes";
    const logPath = gatewayRestartLogPath(this.config);
    mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = openSync(logPath, "a");
    try {
      const child = spawn(bin, ["gateway", "restart"], {
        cwd: this.home || undefined,
        env: { ...process.env, HERMES_HOME: this.home || process.env.HERMES_HOME || "" },
        detached: true,
        windowsHide: true,
        stdio: ["ignore", fd, fd],
      });
      child.unref();
      this.note(`${entry.id}: ran \`${bin} gateway restart\` (pid ${child.pid}, log ${logPath}) — detached so the gateway's own shutdown cannot take the command with it`);
      return { command: `${bin} gateway restart`, pid: child.pid || null, log: logPath, at: nowIso() };
    } finally {
      try {
        closeSync(fd);
      } catch {
        /* the child holds its own copy of the handle */
      }
    }
  }

  proveGatewayTurn(entry) {
    if (typeof this.proveGateway === "function") return this.proveGateway(entry, this);
    const api = typeof this.credentials === "function" ? this.credentials() : this.credentials;
    return proveGatewayTurn({ api, sleepFn: this.sleepFn, onProgress: (s) => this.note(`${entry.id}: proof ${s}`) });
  }

  // ---- panel ---------------------------------------------------------------------------------
  // The panel cannot prove anything after it has exited, so the replacement does: the record names what was
  // running, and `resumePending()` on the next boot proves the gateway and wakes the assistant once.
  async executePanel(entry) {
    const runningIds = this.jobs.runningJobs().map((j) => j.id);
    const record = {
      id: entry.id,
      target: "panel",
      reason: entry.reason || "",
      requestedBy: entry.requestedBy,
      requestedAt: nowIso(),
      runningIds,
      thread: entry.thread,
      provider: entry.provider,
      resumedAt: null,
    };
    this.writeRecord(record);
    entry.runningIds = runningIds;
    entry.record = record;
    entry.state = "restarting";
    entry.restart = await this.spawnPanelReplacement(entry);
    this.note(`${entry.id}: panel replacement launched${entry.restart?.pid ? ` (pid ${entry.restart.pid})` : ""} — this process now exits; the replacement proves the gateway and wakes the assistant`);
    this.emitState();
    if (typeof this.shutdown === "function") await this.shutdown(0);
    else process.exit(0);
  }

  async spawnPanelReplacement(entry) {
    if (typeof this.spawnPanel === "function") return this.spawnPanel(entry, this);
    const here = path.dirname(fileURLToPath(import.meta.url));
    const root = path.join(here, "..");
    const logs = path.join(root, "logs");
    mkdirSync(logs, { recursive: true });
    const helper = path.join(here, "panel-restart.cjs");
    const child = spawn(
      process.execPath,
      [helper, path.join(root, "server.js"), path.join(logs, "server.pid"), path.join(logs, "server.out.log"), path.join(logs, "server.err.log"), String(process.pid)],
      { detached: true, windowsHide: true, stdio: "ignore", cwd: root, env: { ...process.env } },
    );
    child.unref();
    return { command: `${process.execPath} ${helper}`, pid: child.pid || null, at: nowIso() };
  }

  // ---- after a panel restart ------------------------------------------------------------------
  // Called on boot. Reads the record the old process left, waits for the gateway to be usable again, proves
  // it with one real turn, and wakes the assistant once with the payload of everything that was running when the
  // panel went down and is STILL interrupted now — a run the gateway finished in the meantime is not one, and a
  // run the gateway still HAS is re-attached rather than reported: it is going on, and so is its card.
  async resumePending() {
    const rec = this.readRecord();
    if (!rec || rec.resumedAt || rec.target !== "panel") return null;
    this.note(`a panel restart (${rec.id}) left a resume to prove: waiting for the gateway`);
    const api = typeof this.credentials === "function" ? this.credentials() : this.credentials;
    const reach = await this.waitForGateway(api);
    // Let the boot path settle the runs the panel lost before deciding which are still interrupted.
    let reconciled = [];
    try {
      reconciled = await this.jobs.reconcileRestored();
    } catch {
      reconciled = [];
    }
    const proof = await this.proveGatewayTurn({ id: rec.id });
    const summaries = this.jobs.list();
    const wasRunning = (rec.runningIds || []).map((id) => summaries.find((j) => j.id === id)).filter(Boolean);
    const interrupted = wasRunning.filter((j) => j.status === "interrupted");
    // ...and the mirror image of it: a run the gateway STILL HAS was re-attached by the reconcile above, so it is
    // not an interrupted turn and must never be reported as one. It is not quietly dropped either — a restart
    // that loses the one turn it did NOT kill is the same lie the other way round, and the reader is left
    // wondering where it went. It is named as a run that is still going.
    const resumed = wasRunning.filter((j) => j.status === "running" || j.status === "starting");
    rec.proof = { ok: proof.ok, stage: proof.stage, runId: proof.runId || null, status: proof.status || null, output: clip(proof.output || "", 400), ms: proof.ms || null, reason: proof.reason || null, at: nowIso() };
    rec.reachable = reach;
    rec.reconciled = reconciled;
    rec.interrupted = interrupted.map((j) => ({ id: j.id, thread: j.thread }));
    rec.reattached = resumed.map((j) => ({ id: j.id, thread: j.thread, runId: j.runId || null }));
    rec.resumedAt = nowIso();
    rec.resume = { interrupted: rec.interrupted.length, reattached: rec.reattached.length, proofOk: proof.ok };
    this.writeRecord(rec);
    this.note(proof.ok ? `panel resume ${rec.id}: the gateway answered a real turn in ${proof.ms}ms` : `panel resume ${rec.id}: the proof turn FAILED — ${proof.reason}`);
    this.last = { id: rec.id, target: "panel", state: proof.ok ? "done" : "failed", at: rec.resumedAt, proof: rec.proof, interrupted: rec.interrupted, error: proof.ok ? null : proof.reason };
    this.wakeOnce(rec, interrupted, rec.proof, { target: "panel", detected: false, reattached: resumed });
    this.emitState();
    return { record: rec, proof, interrupted, reattached: resumed, reconciled };
  }

  async waitForGateway(api) {
    if (typeof this.proveGateway === "function") return { ok: true, reason: "injected" };
    const url = String(api?.url || "").replace(/\/+$/, "");
    if (!url) return { ok: false, reason: "no gateway url" };
    const headers = { "Content-Type": "application/json", ...(api?.key ? { Authorization: `Bearer ${api.key}` } : {}) };
    const until = Date.now() + this.bootWaitMs;
    for (;;) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4_000);
        const res = await fetch(`${url}/v1/capabilities`, { headers, signal: ctrl.signal });
        clearTimeout(t);
        if (res.ok) return { ok: true, at: nowIso() };
      } catch {
        /* keep waiting */
      }
      if (Date.now() >= until) return { ok: false, reason: `${url} did not answer within ${Math.round(this.bootWaitMs / 1000)}s` };
      await this.sleepFn(2_000);
    }
  }

  // ---- the one wake ---------------------------------------------------------------------------
  wakeOnce(entry, interrupted, proof, { target = "gateway", detected = false, reattached = [] } = {}) {
    if (!this.assistant || typeof this.assistant.wakeAfterRestart !== "function") return null;
    try {
      return this.assistant.wakeAfterRestart(interrupted, {
        target,
        proof,
        detected,
        reattached,
        reason: entry.reason || "",
        requested: entry.requestedBy || null,
        recordId: entry.id || null,
      });
    } catch (e) {
      this.note(`the resume wake could not be sent: ${String((e && e.message) || e)}`);
      return null;
    }
  }
}