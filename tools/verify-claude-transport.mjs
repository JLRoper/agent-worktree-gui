// Phase 2c check for the Claude stream translator (lib/claude-stream.js). No network, no API calls: it replays a
// captured run (tools/fixtures/claude-stream-basic.jsonl, from a real haiku run on CLI 2.1.310) and checks the
// panel events, then exercises the edge cases with small synthetic lines.
//
//   node tools/verify-claude-transport.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  translateLine,
  translateText,
  newStreamState,
  lineSplitter,
  initializeRequest,
  userTurn,
  interruptRequest,
} from "../lib/claude-stream.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};

// ── 1. the captured run, end to end ──────────────────────────────────────────────────────────────
const fixture = readFileSync(path.join(here, "fixtures", "claude-stream-basic.jsonl"), "utf8");
const events = translateText(fixture, newStreamState(), 1_000_000);
check(
  "captured run: event sequence",
  events.map((e) => e.event),
  ["claude.init", "tool.started", "tool.completed", "message.delta", "run.completed"],
);
check("init carries the session id", events[0].sessionId, "22222222-2222-4222-8222-222222222222");
check("Bash maps to the panel's terminal tool", [events[1].tool, events[1].preview], ["terminal", "echo hi-from-tool"]);
check("tool result drops the CLI's cwd note", events[2].preview, "hi-from-tool");
check("tool result is not an error", events[2].error, null);
check("text block becomes a delta", [events[3].event, events[3].delta], ["message.delta", "PONG"]);
check("result is a completion with the answer", events[4].output, "PONG");
check("usage counts cache as input", events[4].usage, { input_tokens: 60117, output_tokens: 167, total_tokens: 60284 });
check("cost is carried through", events[4].totalCostUsd, 0.00689062);
check("result keeps the session id for resume (2d)", events[4].sessionId, "22222222-2222-4222-8222-222222222222");

// ── 2. chunk boundaries: a line split across two reads ───────────────────────────────────────────
{
  const got = [];
  const split = lineSplitter((l) => got.push(l));
  const text = fixture;
  const cut = Math.floor(text.length / 2);
  split.push(text.slice(0, cut));
  split.push(text.slice(cut));
  split.flush();
  check("splitter: same line count whatever the chunking", got.length, fixture.trimEnd().split("\n").length);
  check("splitter: no line is cut in half", got.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }), true);
}

// ── 3. things that must not reach the card ───────────────────────────────────────────────────────
check("hook events are dropped", translateLine({ type: "system", subtype: "hook_started" }), []);
check("rate-limit events are dropped", translateLine({ type: "rate_limit_event", rate_limit_info: {} }), []);
check("thinking blocks are not shown", translateLine({ type: "assistant", message: { content: [{ type: "thinking", thinking: "x" }] } }), []);

// ── 4. things that must be shown rather than dropped ─────────────────────────────────────────────
{
  const [e] = translateText('{"type":"mystery","x":1}\nnot json at all');
  check("unknown type comes back as unparsed", e.event, "claude.unparsed");
}
{
  const out = translateText('not json at all');
  check("non-JSON line comes back as unparsed", out[0].event, "claude.unparsed");
}

// ── 5. a permission prompt is never answered by the translator ───────────────────────────────────
{
  const out = translateLine({
    type: "control_request",
    request_id: "r1",
    request: { subtype: "can_use_tool", tool_name: "Write", input: {} },
  });
  check("can_use_tool is reported, not auto-allowed (2e owns approvals)", out.map((e) => e.event), ["claude.unparsed"]);
  check("...and the transport gets the raw request to decide on", out[0].control?.request_id, "r1");
}

// ── 6. stop vs failure: the same result line means different things depending on who asked ───────
{
  const stopped = newStreamState();
  stopped.stopRequested = true;
  const [e] = translateLine(
    { type: "result", subtype: "error_during_execution", is_error: true, result: "", session_id: "s", usage: {} },
    stopped,
  );
  check("interrupt the user asked for is a cancel, not a failure", e.event, "run.cancelled");
}
{
  const [e] = translateLine(
    { type: "result", subtype: "error_during_execution", is_error: true, result: "boom", session_id: "s", usage: {} },
    newStreamState(),
  );
  check("the same result nobody asked for is a failure", e.event, "run.failed");
}

// ── 7. the tool name map covers the tools the spike runs, and falls back without losing the name ──
{
  const st = newStreamState();
  const [start] = translateLine(
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t9", name: "mcp__x__do_it", input: {} }] } },
    st,
  );
  check("unknown tool keeps its own name (glyph falls back by family)", start.tool, "mcp__x__do_it");
}

// ── 8. the host's own messages have the shape the SDK sends ──────────────────────────────────────
check("initialize is a control_request", initializeRequest("i1").request.subtype, "initialize");
check("a turn is one user message", userTurn("hi"), { type: "user", message: { role: "user", content: "hi" } });
check("stop is an interrupt control_request", interruptRequest("x").request.subtype, "interrupt");

console.log(failed ? `\n${failed} FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
