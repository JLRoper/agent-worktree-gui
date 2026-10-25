// A stand-in for `claude -p --input-format stream-json --output-format stream-json`, for offline tests of
// lib/claude-transport.js. It reads the host's stdin protocol and answers from a fixture. No network.
//
//   node tools/stub-claude.mjs <claude args...>
//
// Env:
//   STUB_CLAUDE_MODE     replay (default) | hang | deaf | crash
//     replay  after the user turn, write every line of STUB_CLAUDE_FIXTURE, then exit 0 once stdin closes
//     hang    write init and a tool call, then wait; an interrupt control_request is answered the way the real CLI
//             answers it (control_response, then an error_during_execution result, exit 1)
//     deaf    like hang, but ignores the interrupt (the transport has to kill it)
//     crash   write to stderr and exit 2 with no result
//   STUB_CLAUDE_FIXTURE  jsonl file for replay (default tools/fixtures/claude-stream-basic.jsonl)
//   STUB_CLAUDE_LOG      if set, a JSON record {argv, stdin[]} is written here on exit
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const mode = process.env.STUB_CLAUDE_MODE || "replay";
const fixture = process.env.STUB_CLAUDE_FIXTURE || path.join(here, "fixtures", "claude-stream-basic.jsonl");
const argv = process.argv.slice(2);
const sessionId = argv[argv.indexOf("--session-id") + 1] || "00000000-0000-4000-8000-000000000000";
const seen = [];

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const done = (code) => {
  if (process.env.STUB_CLAUDE_LOG) writeFileSync(process.env.STUB_CLAUDE_LOG, JSON.stringify({ argv, stdin: seen, mode }));
  process.exit(code);
};

if (mode === "crash") {
  process.stderr.write("stub-claude: simulated crash\n");
  setTimeout(() => done(2), 50);
}

let buf = "";
let started = false;
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
  if (mode === "replay") done(0);
});

function onMessage(msg) {
  if (msg.type === "control_request" && msg.request?.subtype === "initialize") {
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { commands: [] } } });
    return;
  }
  if (msg.type === "user" && !started) {
    started = true;
    if (mode === "replay") {
      for (const l of readFileSync(fixture, "utf8").split(/\r?\n/)) if (l.trim()) process.stdout.write(`${l}\n`);
      return;
    }
    out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sessionId, model: "stub-model" });
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_stub", name: "Bash", input: { command: "sleep 600" } }] } });
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
