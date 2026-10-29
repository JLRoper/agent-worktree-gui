// How much of a tool result actually reaches a consumer of this box's agent transports?
//
// A tool result is cut into a preview twice on the way out, at two different caps, and the panel's card
// body reads the SECOND one. Both are env-only knobs with no config.yaml key:
//
//   * `hermes chat -q … --format stream-json`  ->  hermes_cli/stream_json.py:19
//        `_DEFAULT_TOOL_OUTPUT_CAP = 5000`, raised/removed by HERMES_STREAM_TOOL_CAP (0 = full)
//   * the gateway's Runs API SSE `tool.completed`  ->  gateway/platforms/api_server_runs.py:98
//        `_DEFAULT_TOOL_COMPLETED_PREVIEW_MAX_CHARS = 500`, raised/removed by HERMES_RUN_PREVIEW_CHARS
//        (0 = full). THIS is the one the panel reads: lib/jobs.js:203 draws the truncation notice from
//        the unwrapped preview, and lib/tool-text.js:81 infers "cut" from a payload that does not end
//        with a quote or a brace.
//
// Both paths are measured here against a real tool call, because the cap is what the consumer SEES and
// nothing else proves it: the agent's own context and the stored row in state.db are NOT capped (a
// 400-line read_file is stored verbatim at ~44 kB), so the number this prints is purely the wire cap.
//
//   node tools/measure-tool-output-cap.mjs                  # the CLI path, default cap
//   node tools/measure-tool-output-cap.mjs --cap 0           # …and with HERMES_STREAM_TOOL_CAP=0
//   node tools/measure-tool-output-cap.mjs --runs            # the panel's path: POST /v1/runs + SSE
//   node tools/measure-tool-output-cap.mjs --runs --cap 0    # …and with HERMES_RUN_PREVIEW_CHARS=0
//   node tools/measure-tool-output-cap.mjs --worktree        # add `-w` to the CLI spawn (the old panel path)
//
// It costs ONE model call per run and writes nothing outside a temp dir it removes again. `--runs`
// creates a real run on the gateway this box is pointed at (that is the point — the live gateway is the
// thing being measured); it never starts, stops or restarts anything, and it never touches a worktree.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback = null) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const LINES = Number(valueOf("--lines", 400));
const CAP = valueOf("--cap", null); // null = leave the transport at its default
const RUNS = has("--runs");
const USE_WORKTREE = has("--worktree");

function hermesHome() {
  const env = process.env.HERMES_HOME;
  if (env && !env.startsWith("/")) return env; // an MSYS-shaped home is a mistake, not a path
  return path.join(process.env.LOCALAPPDATA || os.homedir(), "hermes");
}

// Same read the panel does (lib/jobs.js:readKeyFromEnvFile) — the key lives in $HERMES_HOME/.env.
function apiKeyFromEnvFile() {
  const envPath = path.join(hermesHome(), ".env");
  if (!existsSync(envPath)) return null;
  const m = /^\s*API_SERVER_KEY\s*=\s*(.+?)\s*$/m.exec(readFileSync(envPath, "utf8"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") || null : null;
}

const dir = mkdtempSync(path.join(os.tmpdir(), "toolcap-"));
const longFile = path.join(dir, "longfile.txt");
writeFileSync(longFile, Array.from({ length: LINES }, (_, i) => {
  const n = String(i + 1).padStart(4, "0");
  return `${n}  line ${i + 1} of the tool-output cap probe: 0123456789 abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ`;
}).join("\n") + "\n", "utf8");
const sourceBytes = Buffer.byteLength(readFileSync(longFile, "utf8"), "utf8");

const PROMPT = `Use the read_file tool exactly once to read the file ${longFile.split(path.sep).join("/")} with limit=${LINES}. Do not use any other tool. Then reply with exactly: DONE`;

// `source` is the raw file on disk; `received` is the JSON envelope the transport carried, which adds
// read_file's line-number prefixes, so an uncapped result legitimately lands slightly ABOVE 100%.
const report = (label, source, received, endsCut, note = "") => {
  console.log(`${label}`);
  console.log(`  source           ${source} bytes of raw file on disk`);
  console.log(`  received         ${received} chars of JSON envelope  (${(100 * received / source).toFixed(1)}% of it)`);
  console.log(`  cut marker       ${endsCut ? "yes — the payload ends with the transport's own \"...\"" : "no — the payload arrived whole"}`);
  if (note) console.log(`  ${note}`);
};

function finish(code) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* a busy file must not fail the run */ }
  process.exitCode = code;
}

// ── the CLI path: `hermes chat -q … --format stream-json`, newline-delimited events on stdout ────────
function measureCli() {
  const env = { ...process.env, HERMES_HOME: hermesHome() };
  if (CAP !== null) env.HERMES_STREAM_TOOL_CAP = CAP;
  else delete env.HERMES_STREAM_TOOL_CAP;
  const args = ["chat", "-q", PROMPT, "-Q", "--format", "stream-json", "--max-turns", "4"];
  if (USE_WORKTREE) args.push("-w");
  const hermes = process.env.HERMES_BIN || "hermes";
  console.log(`CLI path: ${hermes} ${args.join(" ")}${CAP === null ? "" : `   [HERMES_STREAM_TOOL_CAP=${CAP}]`}`);
  const out = execFileSync(hermes, args, { env, cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const result = out.split("\n").map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).find((o) => o && o.type === "tool_result");
  if (!result) {
    console.error("FAIL  no tool_result event on the stream — the model did not call read_file");
    return finish(1);
  }
  const text = String(result.output ?? "");
  report(`stream-json tool_result (${result.name})`, sourceBytes, text.length, text.endsWith("..."),
    "cap: hermes_cli/stream_json.py:19 (5000) via HERMES_STREAM_TOOL_CAP");
  console.log("");
  console.log("  raw event (output trimmed to what proves the point):");
  console.log("  " + JSON.stringify({ ...result, output: text.slice(0, 60) + "   <<<CUT>>>   " + text.slice(-80) }));
  console.log("");
  console.log("  the full text is not lost: the same result is stored verbatim in $HERMES_HOME/state.db");
  console.log("  (messages.content, role='tool') and lib/tool-results.js already reads it back.");
  return finish(0);
}

// ── the panel's path: POST /v1/runs, then the SSE stream its card body is drawn from ─────────────────
async function measureRuns() {
  const url = String(process.env.API_SERVER_URL || "http://127.0.0.1:8642").replace(/\/+$/, "");
  const key = process.env.API_SERVER_KEY || apiKeyFromEnvFile();
  if (!key) {
    console.error(`FAIL  no API_SERVER_KEY (add it to ${path.join(hermesHome(), ".env")})`);
    return finish(1);
  }
  console.log(`Runs API path: POST ${url}/v1/runs + SSE   ${CAP === null ? "[gateway default]" : `[HERMES_RUN_PREVIEW_CHARS=${CAP} on the GATEWAY, not here]`}`);
  if (CAP !== null) {
    console.log("  note: this process cannot change the running gateway's environment — set the var where the");
    console.log("  gateway is launched and restart it (docs/tool-output-truncation.md). The number below is the");
    console.log("  gateway's own cap, whatever it is.");
  }
  const started = await (await fetch(`${url}/v1/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ input: PROMPT, cwd: dir, max_turns: 4, run_budget: 240 }),
  })).json();
  const runId = started.run_id || started.id;
  if (!runId) {
    console.error(`FAIL  no run id back: ${JSON.stringify(started).slice(0, 200)}`);
    return finish(1);
  }
  const res = await fetch(`${url}/v1/runs/${runId}/events`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "text/event-stream" },
  });
  let completed = null;
  for await (const chunk of res.body) {
    for (const line of Buffer.from(chunk).toString("utf8").split("\n")) {
      if (!line.startsWith("data:")) continue;
      let ev;
      try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (ev.event === "tool.completed") completed = ev;
      if (["run.completed", "run.failed", "run.cancelled", "run.interrupted"].includes(ev.event)) {
        if (!completed) {
          console.error(`FAIL  run ended without a tool.completed event (${ev.event})`);
          return finish(1);
        }
        const preview = String(completed.preview ?? "");
        report(`run-stream tool.completed.preview (${completed.tool})`, sourceBytes, preview.length, preview.endsWith("..."),
          "cap: gateway/platforms/api_server_runs.py:98 (500) via HERMES_RUN_PREVIEW_CHARS");
        console.log("");
        console.log("  raw event (preview trimmed to what proves the point):");
        console.log("  " + JSON.stringify({ ...completed, preview: preview.slice(0, 60) + "   <<<CUT>>>   " + preview.slice(-80) }));
        console.log("");
        console.log(`  run_id ${runId} — this is the cap the panel's card body reads, so a 46-line patch reaches`);
        console.log("  the console as a header plus a couple of lines (lib/jobs.js:203 says so out loud).");
        return finish(0);
      }
    }
  }
  console.error("FAIL  the event stream closed before the run reached a terminal state");
  return finish(1);
}

console.log(`probe file: ${longFile}  (${LINES} lines, ${sourceBytes} bytes)`);
console.log(`cap under test: ${CAP === null ? "transport default" : CAP}${CAP === "0" ? " (0 = full output)" : ""}`);
console.log("");
(RUNS ? measureRuns() : Promise.resolve(measureCli())).catch((err) => {
  console.error(`FAIL  ${err?.message || err}`);
  finish(1);
});
