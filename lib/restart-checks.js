// The restart checks: the provider key a new gateway has to come back with, the version a bounce would put into
// service, and the proof turn that settles whether the gateway is really a different process.
//
// Cut out of lib/restart.js (row 511; module-separation plan entry 16) so a key check or a version comparison
// lands in a different file from the controller that queues and runs the restart. Every name here keeps its
// spelling, and lib/restart.js re-exports all of them, so no import site moved.
//
// The one direction matters: this module imports nothing from lib/restart.js. The proof prompt the turn defaults
// to moved with the turn rather than staying behind to be imported back, because a default parameter read at
// call time would otherwise make the two modules import each other.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readBlockValue } from "./hermes-config.js";
import { statePaths } from "./paths.js";

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

export const TERMINAL_RUN = new Set(["completed", "failed", "cancelled", "interrupted"]);
// How many consumed entries the ledger remembers. A queue entry is one-shot, and the ids a boot can
// plausibly be handed again are the recent ones — a bounded list keeps restart.json readable forever.
export const MAX_CONSUMED = 20;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nowIso = () => new Date().toISOString();
export const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// What the CHECKOUT's package.json names — the version a restart would put into service. It is not what this process
// serves: `server.js` reads the file once at boot and hands that number in, and the file may be bumped afterwards,
// which is exactly the restart worth queueing. Read per request by `RestartController` for the refusal below.
export function servedVersionFromDisk() {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || null;
  } catch {
    return null;
  }
}

// Numeric x.y.z only: this repo's versions are plain and a comparison that guessed at ranges would refuse a
// request for a version it cannot actually name. `null` means "not a version", never "equal".
export function versionParts(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i.exec(String(v ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

export const sameVersion = (a, b) => compareVersions(a, b) === 0;

// The versions a reason NAMES. The prose is never the test for a pointless bounce — the checkout's number and the
// running one are — but a controller with no reader for the checkout (`packageVersion` below) has only this to go on,
// and the shape it recognises is three components: a reason may quote a PR number, a run count or a port, and none of
// those is a version the panel could be serving.
export function versionsNamed(text) {
  return [...String(text ?? "").matchAll(/\bv?(\d+\.\d+\.\d+)\b/gi)].map((m) => m[1]);
}

// The one sentence every shape refusal repeats: a caller that guessed wrong is told what to write, not just "no".
export const RESTART_SHAPE = "RESTART <gateway|panel> | <why> — the target is the word after RESTART, the reason begins after the pipe";

// A restart with no reason is the entry the ledger can never explain after a death: restart.json once held
// `"reason": null` beside `"resumedAt": null`, so the bounce could say neither what it was for nor that it had
// already run. The check is shared by the request and the HTTP boundary so the two cannot word it differently.
export const REASON_REQUIRED = `a restart needs a reason — say what it is for, in the words the board should keep; ${RESTART_SHAPE}`;

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

// Where the panel remembers a restart that crosses its own death (only a panel restart needs it). The default is
// the data directory's state folder, resolved by lib/paths.js — this file used to sit beside the job store inside
// the checkout, which meant a panel restart wrote state into the repository it was restarting from.
export function restartFilePath(config = {}) {
  return config.restartFile || statePaths(config).restartFile;
}

export function gatewayRestartLogPath(config = {}) {
  return config.gatewayRestartLog || statePaths(config).gatewayRestartLog;
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
