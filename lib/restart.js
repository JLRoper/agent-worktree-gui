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
//   3. A restart that never happened was reported as one. `hermes gateway restart` is a service-manager
//      verb and the board's gateway is a foreground `gateway run` process: the command exits successfully
//      having done nothing, and one proof turn through the UNRESTARTED gateway proves the opposite of what
//      it is asked. A restart is therefore accepted only when the gateway reports a DIFFERENT PID within
//      30 s; when it does not, the panel stops the recorded pid and starts the recorded argv itself, and if
//      the pid still does not move the outcome is a FAILURE ("the gateway process never changed"), written
//      into the restart log. A false success here cost sixteen hours of a board that kept saying the gateway
//      had just been restarted.
//
// After the new process is up it is proved with ONE REAL TURN through the gateway, never with its
// listening port, and only then is the assistant woken once with the completion payload of everything the
// restart interrupted. A gateway restart the panel did NOT ask for fires the same single wake — that path
// lives in lib/jobs.js (`sweepOrphanedRuns`) and calls `Assistant.wakeAfterRestart` with the runs it lost.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readBlockValue } from "./hermes-config.js";
import { gatewayIdentity, readGatewayState } from "./hermes-runtime.js";
import { ASSISTANT_THREAD } from "./assistant.js";
import { isLiveJobStatus } from "./jobs.js";

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

// The one sentence a restart whose pid did not change is recorded with. It is deliberately about the
// process and not about the proof turn: a gateway that was never restarted answers a turn perfectly well,
// and a verdict that says "the proof failed" sends the reader looking at provider keys instead of at the
// thing that did not happen.
export const NEVER_CHANGED_REASON = "the gateway process never changed";

// How to start the gateway again, from the argv the gateway itself recorded in `gateway_state.json`.
// Three shapes are in the wild and all of them end in `-m hermes_cli.main <subcommand…>`:
//
//   ["…/hermes-agent/hermes_cli/main.py", "gateway", "run", "…"]   the installed script
//   ["python", "…/hermes_cli/main.py", "gateway", "run", "…"]      an interpreter + the script
//   ["python", "-m", "hermes_cli.main", "gateway", "run", "…"]     the module form
//
// `root` is the checkout the script came from (…/hermes-agent), which is what `-m hermes_cli.main` needs on
// PYTHONPATH when the process is not launched by the install's own wrapper.
export function gatewayLaunchPlan(state = null, home = null) {
  const argv = (Array.isArray(state?.argv) ? state.argv : []).map((a) => String(a || "").trim()).filter(Boolean);
  let script = null;
  let rest = [];
  if (argv[0] && /\.py$/i.test(argv[0])) {
    script = argv[0];
    rest = argv.slice(1);
  } else if (argv[1] && /\.py$/i.test(argv[1])) {
    script = argv[1];
    rest = argv.slice(2);
  } else {
    rest = argv.slice(1);
  }
  const root = script && /[\\/]hermes_cli[\\/]main\.py$/i.test(script) ? path.dirname(path.dirname(script)) : null;
  if (!rest.length) return { args: [], root, cwd: root || home || undefined, command: "" };
  const args = rest[0] === "-m" ? rest : ["-m", "hermes_cli.main", ...rest];
  return { args, root, cwd: root || home || undefined, command: `python ${args.join(" ")}` };
}

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

// What the gateway's own state file says about the process running now: pid, the process-start fingerprint
// Hermes uses as a PID-reuse guard, and its state. The READER lives in lib/hermes-runtime.js (lib/jobs.js
// needs the same answer without importing this module, which would be a cycle) and is re-exported here
// because this is where every caller has always got it from.
//
// It is corroboration for the log and for the status surface, and — since the pid guard below — the
// evidence that a restart happened at all. A fresh pid is a fact only the gateway can report; one
// successful turn is not, because the gateway that was never restarted answers it too.
export { gatewayIdentity };

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
    //
    // `runGatewayRestart` replaces the COMMAND only (`hermes gateway restart`). The verdict is not
    // injectable: the pid guard, the stop-and-start fallback and the pid comparison run either way,
    // because a test that could stub the verdict would be a test of nothing.
    runGatewayRestart = null,
    proveGateway = null,
    spawnPanel = null,
    // The gateway's own identity, and the raw state it wrote (pid + argv). Both default to the real
    // `$HERMES_HOME/gateway_state.json`; a test moves the pid by handing in a function.
    identity = null,
    gatewayState = null,
    // The stop-and-start fallback: stopping the recorded pid, and launching the recorded argv again.
    stopProcess = null,
    spawnGateway = null,
    // How long a restart is given to show a NEW pid at each stage (the command first, then the fallback).
    identityWaitMs = 30_000,
    identityPollMs = null, // defaults to pollMs
    pythonBin = null,
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
    this.identity = typeof identity === "function" ? identity : () => gatewayIdentity(this.home);
    this.gatewayState = typeof gatewayState === "function" ? gatewayState : () => readGatewayState(this.home);
    this.stopProcess = stopProcess;
    this.spawnGateway = spawnGateway;
    this.identityWaitMs = identityWaitMs;
    this.identityPollMs = identityPollMs || pollMs;
    this.pythonBin = pythonBin || config.pythonBin || process.env.HERMES_PYTHON || "python";
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
      gateway: this.identity(),
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
    // `waiting` counts: a turn held on the gateway's 429 cap is still this thread's turn, and a restart that
    // did not wait for it would kill the one thing holding the retry.
    return this.jobs.list().some((j) => j.thread === t && isLiveJobStatus(j.status));
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
      // The probe above already decided whether the gateway still holds this run: a 404 is the one interruption that
      // also settles "there is nothing left to re-attach", so that card must not keep offering to ask again.
      if (this.jobs.markInterruptedByRestart(j, { by, detail, gone: verdict?.known === false })) interrupted.push(j);
    }
    for (const j of interrupted) {
      try {
        await this.jobs.measureTree(j);
      } catch {
        /* the notice is not held up by a git read that will not answer */
      }
    }
    // A card this panel has given up on is not a run the gateway has stopped. Without this the gateway keeps
    // executing the turn for a client that is gone — measured on this box: nine abandoned runs held every
    // concurrency slot and their session_turn_leases never cleared. Best effort by contract: the interrupt
    // verdict is already on every card, so a stop that fails is journalled and never rethrown.
    try {
      await this.jobs.stopInterruptedRuns?.(interrupted, { reason: `${by} restart${detail ? ` (${clip(detail, 120)})` : ""}` });
    } catch (e) {
      this.note(`could not ask the gateway to stop the interrupted run(s): ${String((e && e.message) || e)}`);
    }
    return interrupted;
  }

  // ---- gateway ------------------------------------------------------------------------------
  // The verdict of a gateway restart is TWO facts, and neither alone is enough:
  //
  //   * the pid the gateway reports is not the pid it reported before — a restart that leaves the same pid
  //     running has restarted nothing, however successfully the command exited;
  //   * one real turn still goes through the new process — a gateway that came back without its provider
  //     credentials binds its port and then dies on every run.
  //
  // Believing the command alone is what cost sixteen hours: `hermes gateway restart` is a service-manager
  // verb, the board's gateway is a foreground `gateway run` process, and the command returns success having
  // done nothing at all. The proof turn passed too, because the gateway answering it was never restarted.
  async executeGateway(entry) {
    const identityBefore = this.identity() || null;
    entry.identityBefore = identityBefore;
    const interrupted = await this.interruptRunning({ by: "gateway", detail: `the gateway was restarted from the panel (${entry.id})` });
    entry.interrupted = interrupted.map((j) => ({ id: j.id, thread: j.thread, word: j.completion?.word || "interrupted" }));
    this.note(`${entry.id}: ${interrupted.length} run(s) given an interrupted verdict before the gateway stops${interrupted.length ? ` (${interrupted.map((j) => j.id).join(", ")})` : ""}`);
    entry.restart = await this.restartGateway(entry);
    const changed = entry.restart?.pidChanged === true;
    // A pid that never changed means the gateway answering the proof turn is the one that was there
    // before, so asking it to answer proves nothing about a restart. The verdict is settled here, and the
    // reason is the sentence the reader needs — not a proof failure that sends them to the provider key.
    const proof = changed
      ? await this.proveGatewayTurn(entry)
      : { ok: false, stage: "restart", runId: null, status: null, output: "", ms: null, reason: NEVER_CHANGED_REASON };
    entry.proof = { ok: proof.ok, stage: proof.stage, runId: proof.runId || null, status: proof.status || null, output: clip(proof.output || "", 400), ms: proof.ms || null, reason: proof.reason || null, at: nowIso() };
    const ok = changed && proof.ok === true;
    entry.outcome = {
      ok,
      reason: ok ? null : entry.proof.reason || "the proof turn did not pass",
      pidBefore: entry.restart?.pidBefore ?? identityBefore?.pid ?? null,
      pidAfter: entry.restart?.pidAfter ?? null,
      restartedBy: entry.restart?.attempt || null,
      proof: entry.proof,
      interrupted: entry.interrupted.length,
    };
    if (!ok) entry.error = entry.outcome.reason;
    if (!changed) {
      // The restart log is where a false success used to be indistinguishable from a real one: the command's
      // own output went there and said nothing was wrong. Say it plainly, in that file and in the journal.
      this.writeRestartLog(`${entry.id}: ${NEVER_CHANGED_REASON} — pid ${entry.outcome.pidBefore ?? "unknown"} before, ${entry.outcome.pidAfter ?? "unknown"} after; ${entry.restart?.attempt || "no attempt"} left it running. A successful turn is not proof of a restart.`);
      this.note(`${entry.id}: ${NEVER_CHANGED_REASON} — ${entry.restart?.attempt || "the restart"} left pid ${entry.outcome.pidBefore ?? "unknown"} running; recorded as a FAILED restart, not a successful one`);
    } else {
      this.note(ok
        ? `${entry.id}: the gateway is back as pid ${entry.outcome.pidAfter} and answered a real turn in ${proof.ms}ms (run ${proof.runId})`
        : `${entry.id}: the gateway DID change pid (${entry.outcome.pidBefore} → ${entry.outcome.pidAfter}) but did NOT pass the real-turn proof — ${proof.reason}`);
    }
    this.wakeOnce(entry, interrupted, entry.proof, { target: "gateway", detected: false });
  }

  // ---- the restart, and the pid it has to change -------------------------------------------
  // Step one stays `hermes gateway restart`, because a real service install is the one case where it works.
  // Step two is the panel doing the job itself: read the pid and argv the gateway recorded, stop THAT
  // process, and start the same argv again, detached, with HERMES_HOME set. Both steps are given the same
  // window to show a new pid; only a new pid ends the wait.
  async restartGateway(entry) {
    const before = entry.identityBefore || this.identity() || null;
    const first = await this.runRestartCommand(entry);
    const firstWait = await this.waitForNewPid(before);
    if (firstWait.pidChanged) return { ...first, ...firstWait, attempt: first.command || "hermes gateway restart" };

    this.note(`${entry.id}: \`${first.command || "hermes gateway restart"}\` left pid ${before?.pid ?? "unknown"} running ${Math.round(firstWait.waitedMs / 1000)}s later — a foreground \`gateway run\` is not a service, so the panel stops and starts it itself`);
    const fallback = await this.stopAndStartGateway(entry, { before });
    // A skipped fallback means the pid moved on its own while it was starting, so the second wait is the
    // question again rather than "we spawned nothing, therefore nothing changed".
    const secondWait = fallback.spawned || fallback.skipped
      ? await this.waitForNewPid(before)
      : { pidChanged: false, pidBefore: before?.pid ?? null, pidAfter: (this.identity() || null)?.pid ?? null, waitedMs: 0 };
    return {
      command: fallback.command || first.command,
      pid: fallback.spawned?.pid ?? null,
      log: gatewayRestartLogPath(this.config),
      at: nowIso(),
      attempt: "stop-and-start",
      command1: first,
      fallback,
      ...secondWait,
    };
  }

  // The command that does the restart when a service manager owns the gateway. Injectable so a test can
  // drive the guard without spawning `hermes`; it never decides the verdict.
  async runRestartCommand(entry) {
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

  // Poll the gateway's own record until the pid it names is not the one that was running before. A pid is
  // the only evidence a restart happened that the restarted process cannot fake by answering a turn.
  async waitForNewPid(before, { timeoutMs = this.identityWaitMs } = {}) {
    const began = Date.now();
    const beforePid = before?.pid ?? null;
    let last = null;
    for (;;) {
      last = this.identity() || null;
      const afterPid = last?.pid ?? null;
      // No pid before means there is nothing a new one can differ FROM: "unchanged" is the honest answer,
      // and the stop-and-start below then has the recorded pid to work from (or fails saying why).
      if (beforePid != null && afterPid != null && String(afterPid) !== String(beforePid)) {
        return { pidChanged: true, pidBefore: beforePid, pidAfter: afterPid, identity: last, waitedMs: Date.now() - began };
      }
      if (Date.now() - began >= timeoutMs) {
        return { pidChanged: false, pidBefore: beforePid, pidAfter: afterPid, identity: last, waitedMs: Date.now() - began };
      }
      await this.sleepFn(this.identityPollMs);
    }
  }

  // The stop-and-start. Nothing here is a service-manager call: the pid in `gateway_state.json` is the
  // process to stop, and the argv in the same record is the process to start again — `python -m
  // hermes_cli.main <recorded argv minus the executable>`, detached, with HERMES_HOME set, in the checkout
  // the argv came from so the module resolves.
  async stopAndStartGateway(entry, { before = null } = {}) {
    const state = this.gatewayState() || null;
    // The last look before anything is stopped: a service manager that answered late is a restart that
    // happened, and stopping the process it just started would leave two gateways fighting for the port.
    const nowIdentity = this.identity() || null;
    if (before?.pid != null && nowIdentity?.pid != null && String(nowIdentity.pid) !== String(before.pid)) {
      this.note(`${entry.id}: the gateway changed pid (${before.pid} → ${nowIdentity.pid}) while the fallback was starting — nothing was stopped`);
      return { method: "stop-and-start", ok: true, skipped: true, reason: "the gateway changed pid before the fallback could stop it" };
    }
    if (state?.kind && state.kind !== "hermes-gateway") {
      this.note(`${entry.id}: the fallback refused — ${this.gatewayStatePath()} names a ${state.kind}, not a hermes gateway`);
      return { method: "stop-and-start", ok: false, reason: `${this.gatewayStatePath()} records a ${state.kind}, not a gateway` };
    }
    const pid = Number(state?.pid) || Number(before?.pid) || null;
    const plan = gatewayLaunchPlan(state, this.home);
    if (!pid) {
      this.note(`${entry.id}: the fallback could not run — gateway_state.json records no pid to stop`);
      return { method: "stop-and-start", ok: false, reason: "gateway_state.json records no pid to stop" };
    }
    if (!plan.args.length) {
      this.note(`${entry.id}: the fallback could not run — gateway_state.json records no argv to start again`);
      return { method: "stop-and-start", ok: false, reason: "gateway_state.json records no argv to start again" };
    }
    const stopped = await this.stopGatewayProcess(pid);
    if (!stopped.ok) {
      this.note(`${entry.id}: the fallback could not stop pid ${pid} — ${stopped.reason || "it is still running"}`);
      return { method: "stop-and-start", ok: false, pid, reason: stopped.reason || `pid ${pid} did not stop`, plan, stopped };
    }
    this.note(`${entry.id}: stopped pid ${pid}${stopped.forced ? " (forced after the polite signal)" : ""} — starting \`${plan.command}\` detached`);
    const spawned = await this.spawnGatewayProcess(plan);
    return { method: "stop-and-start", ok: Boolean(spawned?.pid), pid, stopped, plan, spawned, command: plan.command };
  }

  async stopGatewayProcess(pid) {
    if (typeof this.stopProcess === "function") return this.stopProcess(pid);
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      process.kill(pid);
    } catch (e) {
      // ESRCH is the process already being gone, which is what this wanted.
      if (String(e?.code || "") !== "ESRCH") return { ok: false, reason: `could not signal pid ${pid}: ${String((e && e.message) || e)}` };
    }
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      if (!alive()) return { ok: true, forced: false };
      await this.sleepFn(200);
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* it may have gone between the check and the signal */
    }
    await this.sleepFn(500);
    return alive() ? { ok: false, reason: `pid ${pid} is still running after SIGKILL` } : { ok: true, forced: true };
  }

  async spawnGatewayProcess(plan) {
    if (typeof this.spawnGateway === "function") return this.spawnGateway(plan, this);
    const logPath = gatewayRestartLogPath(this.config);
    mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = openSync(logPath, "a");
    try {
      const child = spawn(this.pythonBin, plan.args, {
        cwd: plan.cwd || this.home || undefined,
        env: {
          ...process.env,
          HERMES_HOME: this.home || process.env.HERMES_HOME || "",
          ...(plan.root ? { PYTHONPATH: [plan.root, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) } : {}),
        },
        detached: true,
        windowsHide: true,
        stdio: ["ignore", fd, fd],
      });
      child.unref();
      return { pid: child.pid || null, command: plan.command, log: logPath, at: nowIso() };
    } finally {
      try {
        closeSync(fd);
      } catch {
        /* the child holds its own copy of the handle */
      }
    }
  }

  gatewayStatePath() {
    return path.join(this.home || process.env.HERMES_HOME || "", "gateway_state.json");
  }

  // The restart log a reader goes to after a restart: the command's own output goes there, and so does the
  // verdict when the pid never changed — the one line that used to be missing.
  writeRestartLog(text) {
    try {
      const logPath = gatewayRestartLogPath(this.config);
      mkdirSync(path.dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${nowIso()} ${clip(text, 600)}\n`);
    } catch (e) {
      this.onLog(`could not write the restart log: ${String((e && e.message) || e)}`);
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