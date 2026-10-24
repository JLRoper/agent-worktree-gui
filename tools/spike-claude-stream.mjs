// Phase 2a spike: how does a host drive `claude -p` over stream-json? Evidence for docs/claude-phase2-handoff.md,
// not product code. Each scenario is one real (cheap, haiku, budget-capped) Claude run, so run it on purpose.
//
//   node tools/spike-claude-stream.mjs <scenario> <cwd> [session-id]
//     approval   a Write that needs permission: answered over stdin via --permission-prompt-tool stdio
//     steer      a user message sent mid-turn, 3s after the first tool call
//     interrupt  a control_request interrupt, 3s after the first tool call
//     resume     --resume <session-id> in <cwd>
//
// <cwd> should be a throwaway git repo. The transcript is also written to <tmpdir>/spike-claude-<scenario>.log.
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

const [scenario, cwd, resumeId] = process.argv.slice(2);
if (!["approval", "steer", "interrupt", "resume"].includes(scenario) || !cwd) {
  console.error("usage: node tools/spike-claude-stream.mjs <approval|steer|interrupt|resume> <cwd> [session-id]");
  process.exit(2);
}
const logFile = path.join(os.tmpdir(), `spike-claude-${scenario}.log`);
writeFileSync(logFile, "");
const t0 = Date.now();
const log = (...a) => {
  const line = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${a.join(" ")}`;
  console.log(line);
  appendFileSync(logFile, `${line}\n`);
};

const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", "haiku", "--max-budget-usd", "0.30"];
if (scenario === "approval") args.push("--session-id", randomUUID(), "--permission-mode", "default", "--permission-prompt-tool", "stdio");
if (scenario === "steer" || scenario === "interrupt") args.push("--session-id", randomUUID(), "--permission-mode", "acceptEdits", "--allowedTools", "PowerShell", "Bash");
if (scenario === "resume") args.push("--resume", resumeId, "--permission-mode", "acceptEdits");

log("spawn: claude", args.join(" "), "| cwd", cwd);
const child = spawn("claude", args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
const timer = setTimeout(() => { log("TIMEOUT 90s: killing"); child.kill(); }, 90_000);
child.stderr.on("data", (d) => log("STDERR", String(d).trim().slice(0, 300)));
child.on("exit", (code, signal) => {
  log(`process exit code=${code} signal=${signal}`);
  clearTimeout(timer);
  setTimeout(() => process.exit(0), 200);
});

const send = (obj) => {
  log("-> stdin", JSON.stringify(obj).slice(0, 200));
  child.stdin.write(`${JSON.stringify(obj)}\n`);
};
const user = (text) => send({ type: "user", message: { role: "user", content: text } });

let results = 0;
let armed = false;
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\n")) !== -1; ) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try {
      onEvent(JSON.parse(line));
    } catch {
      log("RAW", line.slice(0, 200));
    }
  }
});

function onEvent(ev) {
  if (ev.type === "rate_limit_event" || (ev.type === "system" && ev.subtype !== "init")) return;
  if (ev.type === "system") return log(`init session_id=${ev.session_id} cwd=${ev.cwd} permissionMode=${ev.permissionMode}`);
  if (ev.type === "control_response") return log("<- control_response", JSON.stringify(ev.response?.subtype), JSON.stringify(ev.response?.response || {}).slice(0, 120));
  if (ev.type === "control_request") {
    log("<- control_request", JSON.stringify(ev).slice(0, 700));
    const r = ev.request || {};
    if (r.subtype === "can_use_tool") {
      send({ type: "control_response", response: { subtype: "success", request_id: ev.request_id, response: { behavior: "allow", updatedInput: r.input } } });
    }
    return;
  }
  if (ev.type === "result") {
    results += 1;
    log(`<- result#${results} subtype=${ev.subtype} is_error=${ev.is_error} turns=${ev.num_turns} cost=${ev.total_cost_usd} denials=${JSON.stringify(ev.permission_denials)} text=${JSON.stringify(String(ev.result).slice(0, 120))}`);
    // A background task finishing later wakes the session with a second result, so a steer run waits for one.
    if (scenario !== "steer" || results >= 2) child.stdin.end();
    return;
  }
  const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
  const tool = content.find((c) => c.type === "tool_use");
  const text = content.filter((c) => c.type === "text").map((c) => c.text).join("").slice(0, 120);
  log(`<- ${ev.type} [${content.map((c) => c.type + (c.name ? `:${c.name}` : "")).join(",")}]${tool ? ` input=${JSON.stringify(tool.input).slice(0, 120)}` : ""}${text ? ` text=${JSON.stringify(text)}` : ""}`);
  if (tool && !armed) {
    armed = true;
    if (scenario === "steer") setTimeout(() => user("STEER: stop waiting. Do not run anything else. Reply with exactly: STEER-OK"), 3000);
    if (scenario === "interrupt") setTimeout(() => send({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } }), 3000);
  }
}

// The SDK sends `initialize` before anything else; do the same.
send({ type: "control_request", request_id: randomUUID(), request: { subtype: "initialize" } });
if (scenario === "approval") user("Create a file named approved.txt containing the word APPROVAL-TEST in the current directory (use the Write tool), then reply with exactly: DONE-APPROVAL");
if (scenario === "steer") user("Run a shell command that waits 25 seconds (Start-Sleep -Seconds 25), then reply with exactly: DONE-ORIGINAL");
if (scenario === "interrupt") user("Run a shell command that waits 40 seconds (Start-Sleep -Seconds 40), then reply with exactly: DONE-ORIGINAL");
if (scenario === "resume") user("In the previous conversation I asked you to create a file. What word did it contain? Reply with just that word.");
