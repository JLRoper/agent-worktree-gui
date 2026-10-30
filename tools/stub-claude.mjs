// A stand-in for `claude -p --input-format stream-json --output-format stream-json`, for offline tests of
// lib/claude-transport.js. It reads the host's stdin protocol and answers from a fixture. No network.
//
//   node tools/stub-claude.mjs <claude args...>
//
// Env:
//   STUB_CLAUDE_MODE     replay (default) | hang | deaf | crash | steer
//     replay  after the user turn, write every line of STUB_CLAUDE_FIXTURE, then exit 0 once stdin closes. The
//             fixture's session id is replaced by the one in argv (--session-id, or --resume), as the real CLI reports
//     steer   write init and a tool call, then wait for a second user message (the steer); answer it in the same
//             turn with one result that quotes it, then exit 0 once stdin closes
//     twice   write two results back to back (a late steer, or a background task waking the session), exit 0 on close
//     hang    write init and a tool call, then wait; an interrupt control_request is answered the way the real CLI
//             answers it (control_response, then an error_during_execution result, exit 1)
//     deaf    like hang, but ignores the interrupt (the transport has to kill it)
//     crash   write to stderr and exit 2 with no result
//   STUB_CLAUDE_FIXTURE  jsonl file for replay (default tools/fixtures/claude-stream-basic.jsonl)
//   STUB_CLAUDE_LOG      if set, a JSON record {argv, stdin[], cwd, resume} is written here on exit
//   STUB_CLAUDE_SESSION  if set, the session id init and result report, whatever argv asked for (a fork, say)
//   STUB_CLAUDE_LINGER_MS  wait this long between stdin closing and exit (the window after a result, before exit)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const mode = process.env.STUB_CLAUDE_MODE || "replay";
const fixture = process.env.STUB_CLAUDE_FIXTURE || path.join(here, "fixtures", "claude-stream-basic.jsonl");
const argv = process.argv.slice(2);
const argAfter = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
const resume = argAfter("--resume");
const sessionId = process.env.STUB_CLAUDE_SESSION || argAfter("--session-id") || resume || "00000000-0000-4000-8000-000000000000";
const FIXTURE_SESSION = "22222222-2222-4222-8222-222222222222";
const seen = [];

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const done = (code) => {
  if (process.env.STUB_CLAUDE_LOG) writeFileSync(process.env.STUB_CLAUDE_LOG, JSON.stringify({ argv, stdin: seen, mode, cwd: process.cwd(), resume }));
  process.exit(code);
};

if (mode === "crash") {
  process.stderr.write("stub-claude: simulated crash\n");
  setTimeout(() => done(2), 50);
}

let buf = "";
let started = false;
let answered = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    seen.push(msg);
    onMessage(msg);
  }
});
process.stdin.on("end", () => {
  if (["replay", "steer", "twice"].includes(mode)) setTimeout(() => done(0), Number(process.env.STUB_CLAUDE_LINGER_MS) || 0);
});

function onMessage(msg) {
  if (msg.type === "control_request" && msg.request?.subtype === "initialize") {
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { commands: [] } } });
    return;
  }
  if (msg.type === "user" && !started) {
    started = true;
    if (mode === "replay") {
      for (const l of readFileSync(fixture, "utf8").split(/\r?\n/)) if (l.trim()) process.stdout.write(`${l.split(FIXTURE_SESSION).join(sessionId)}\n`);
      return;
    }
    out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sessionId, model: "stub-model" });
    if (mode === "twice") {
      out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "FIRST" }] } });
      out({ type: "result", subtype: "success", is_error: false, result: "FIRST", num_turns: 1, session_id: sessionId, total_cost_usd: 0.001, usage: { input_tokens: 10, output_tokens: 2 } });
      out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "SECOND" }] } });
      out({ type: "result", subtype: "success", is_error: false, result: "SECOND", num_turns: 2, session_id: sessionId, total_cost_usd: 0.002, usage: { input_tokens: 20, output_tokens: 4 } });
      return;
    }
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_stub", name: "Bash", input: { command: "sleep 600" } }] } });
    return;
  }
  if (msg.type === "user" && mode === "steer" && !answered) {
    // Folded into the running turn at the tool boundary: the tool finishes, then the agent answers the steer.
    answered = true;
    const said = String(msg.message?.content ?? "");
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_stub", content: "slept" }] } });
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `STEERED: ${said}` }] } });
    out({ type: "result", subtype: "success", is_error: false, result: `STEERED: ${said}`, num_turns: 3, session_id: sessionId, total_cost_usd: 0.002, usage: { input_tokens: 20, output_tokens: 5 } });
    return;
  }
  if (msg.type === "control_request" && msg.request?.subtype === "interrupt") {
    if (mode === "deaf") return;
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id } });
    out({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, session_id: sessionId, total_cost_usd: 0.001, usage: { input_tokens: 10, output_tokens: 2 } });
    setTimeout(() => done(1), 20);
  }
}

// Never outlive a test that forgot about us.
setTimeout(() => done(3), 120_000).unref();
