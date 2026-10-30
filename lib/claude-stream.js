// Claude Code `stream-json` wire protocol -> panel events. Pure: no process, no network, no jobs.
//
// A Claude job is one `claude -p --input-format stream-json --output-format stream-json` process. It writes one
// JSON object per line on stdout. This module reads those lines and returns the events `Jobs.consume()` already
// understands (the same `{ event, ... }` shapes the Hermes SSE stream produces), so the card, the console and the
// notice code do not change for a Claude job.
//
// Protocol and shapes were proven live against the pinned CLI (2.1.310) — see tools/spike-claude-stream.mjs and
// tools/fixtures/claude-stream-*.jsonl. Unknown event and block types are NOT dropped silently: they come back as
// `claude.unparsed` so the card can print them (the CLI is undocumented and changes between releases).

// Claude's tool names mapped onto the names the panel's glyph table and tool-result code already know.
const TOOL_NAMES = {
  Bash: "terminal",
  PowerShell: "terminal",
  Read: "read_file",
  Write: "write_file",
  Edit: "patch",
  MultiEdit: "patch",
  NotebookEdit: "patch",
  Grep: "search_files",
  Glob: "search_files",
  WebSearch: "web_search",
  WebFetch: "web_extract",
  TodoWrite: "todo_list",
  Task: "delegate_task",
  Agent: "delegate_task",
  Skill: "skill_view",
};

export function panelToolName(claudeName) {
  const name = String(claudeName || "");
  if (TOOL_NAMES[name]) return TOOL_NAMES[name];
  // MCP tools arrive as mcp__<server>__<tool>; the glyph table already has a family for that prefix.
  return name || "tool";
}

// One line of a short preview for the call, drawn from whichever input field the tool carries.
export function previewFor(claudeName, input = {}) {
  if (!input || typeof input !== "object") return "";
  const pick = (...keys) => {
    for (const k of keys) if (typeof input[k] === "string" && input[k]) return input[k];
    return "";
  };
  switch (String(claudeName || "")) {
    case "Bash":
    case "PowerShell":
      return pick("command", "description");
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return pick("file_path", "notebook_path");
    case "Grep":
    case "Glob":
      return pick("pattern");
    case "WebSearch":
      return pick("query");
    case "WebFetch":
      return pick("url");
    case "Task":
    case "Agent":
      return pick("description", "prompt");
    default:
      return pick("file_path", "command", "query", "url", "pattern", "description");
  }
}

// Text of a tool_result block. Its `content` is a string or an array of { type: "text", text } blocks.
function resultText(content) {
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .filter((c) => c && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
  }
  // The Bash tool appends its own bookkeeping line ("Shell cwd was reset to …") to every result. It is the CLI's
  // note to itself, not the command's output, so it does not go on the card.
  return text.replace(/\n?Shell cwd was reset to [^\n]*/g, "").trimEnd();
}

// Map the CLI's `usage` block onto the shape `settle()` reads (`total_tokens`, `input_tokens`, `output_tokens`).
// Cache reads and writes are input the model was billed for, so they count toward input.
function usageFrom(u) {
  if (!u || typeof u !== "object") return null;
  const input = (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0);
  const output = Number(u.output_tokens) || 0;
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
}

// State that lives across lines of one process: the tool_use id -> name map (a tool_result names only its id),
// the tool start times (for duration), and whether the panel asked for the stop (decides cancelled vs failed).
export function newStreamState() {
  return { toolNames: new Map(), toolStarted: new Map(), stopRequested: false, sessionId: null };
}

// Translate one parsed JSON object. Returns an array of events (possibly empty). `now` is injectable for tests.
export function translateLine(obj, state = newStreamState(), now = Date.now()) {
  if (!obj || typeof obj !== "object") return [{ event: "claude.unparsed", text: String(obj) }];
  switch (obj.type) {
    case "system": {
      if (obj.subtype === "init") {
        state.sessionId = obj.session_id || state.sessionId;
        return [{ event: "claude.init", sessionId: obj.session_id || null, model: obj.model || null, cwd: obj.cwd || null }];
      }
      // Hooks (`hook_started`, `hook_response`), `commands_changed`, `thinking_tokens`: headless noise, not for the card.
      return [];
    }
    case "rate_limit_event":
    case "control_response":
    case "keep_alive":
      return [];
    case "assistant": {
      const blocks = Array.isArray(obj.message?.content) ? obj.message.content : [];
      const out = [];
      for (const b of blocks) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "thinking") continue; // the reasoning is not shown, same as the Hermes stream
        if (b.type === "text") {
          if (b.text) out.push({ event: "message.delta", delta: String(b.text) });
        } else if (b.type === "tool_use") {
          if (b.id) {
            state.toolNames.set(b.id, b.name);
            state.toolStarted.set(b.id, now);
          }
          out.push({ event: "tool.started", tool: panelToolName(b.name), preview: previewFor(b.name, b.input) });
        } else {
          out.push({ event: "claude.unparsed", text: `assistant block ${b.type}` });
        }
      }
      return out;
    }
    case "user": {
      const blocks = Array.isArray(obj.message?.content) ? obj.message.content : [];
      const out = [];
      for (const b of blocks) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "tool_result") {
          const raw = state.toolNames.get(b.tool_use_id);
          const started = state.toolStarted.get(b.tool_use_id);
          state.toolStarted.delete(b.tool_use_id);
          out.push({
            event: "tool.completed",
            tool: panelToolName(raw),
            preview: resultText(b.content),
            error: b.is_error ? resultText(b.content) || "tool error" : null,
            duration: started ? Math.max(0, (now - started) / 1000) : undefined,
          });
        }
      }
      return out;
    }
    case "result": {
      const usage = usageFrom(obj.usage);
      const base = {
        output: typeof obj.result === "string" ? obj.result : "",
        usage,
        totalCostUsd: Number.isFinite(Number(obj.total_cost_usd)) ? Number(obj.total_cost_usd) : null,
        sessionId: obj.session_id || state.sessionId || null,
        turns: Number(obj.num_turns) || 0,
        permissionDenials: Array.isArray(obj.permission_denials) ? obj.permission_denials.length : 0,
      };
      // A stop is answered with `error_during_execution` (and exit code 1). The user asked for that, so it is a
      // cancel, not a failure. Any other error result is a failure.
      if (state.stopRequested && obj.subtype === "error_during_execution") {
        return [{ event: "run.cancelled", ...base }];
      }
      if (obj.is_error) {
        const err = obj.subtype && obj.subtype !== "success" ? `${obj.subtype}${obj.result ? `: ${String(obj.result).slice(0, 300)}` : ""}` : String(obj.result || "run failed").slice(0, 300);
        return [{ event: "run.failed", ...base, error: err }];
      }
      return [{ event: "run.completed", ...base }];
    }
    case "control_request": {
      const req = obj.request || {};
      if (req.subtype === "can_use_tool") {
        // A permission prompt. Proven live (tools/spike-claude-stream.mjs `deny`/`session`, 2e): `once` and `deny`
        // always work; `session` only makes sense when the CLI offered a `permission_suggestions` entry to copy
        // into `updatedPermissions` — with no suggestion there is nothing for a session grant to write.
        const suggestions = Array.isArray(req.permission_suggestions) ? req.permission_suggestions : [];
        const choices = suggestions.length ? ["once", "session", "deny"] : ["once", "deny"];
        const preview = previewFor(req.tool_name, req.input);
        return [
          {
            event: "approval.request",
            request_id: String(obj.request_id || ""),
            command: preview ? `${req.tool_name || "tool"} · ${preview}` : String(req.tool_name || "tool"),
            choices,
            // Epoch seconds: Jobs.consume() multiplies by 1000 to get its own deadline. There is no arrival time
            // on the wire, so this is the translator's own clock — the same thing Jobs falls back to when a
            // Hermes event carries none.
            timestamp: Math.floor(now / 1000),
            toolUseId: req.tool_use_id || null,
            toolName: req.tool_name || null,
            input: req.input || {},
            permissionSuggestions: suggestions,
            // The raw request, so the transport can answer it on stdin without reparsing anything.
            control: obj,
          },
        ];
      }
      // Other control_request subtypes (none seen live besides `initialize`/`interrupt`, which this host sends
      // itself, never receives) are reported rather than answered, same as before 2e.
      return [{ event: "claude.unparsed", text: `control_request ${req.subtype || "?"} (not handled in this build)`, control: obj }];
    }
    default:
      return [{ event: "claude.unparsed", text: `unknown message type ${obj.type || "?"}` }];
  }
}

// Turn a stream of arbitrary stdout chunks into whole lines. Returns { push(chunk), flush() } and calls onLine(text)
// for each complete line. A partial final line waits for the next chunk; flush() emits it when the process exits.
export function lineSplitter(onLine) {
  let buf = "";
  const emit = (raw) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim()) onLine(line);
  };
  return {
    push(chunk) {
      buf += String(chunk);
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        emit(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    },
    flush() {
      if (buf.trim()) emit(buf);
      buf = "";
    },
  };
}

// Convenience for a whole text blob (a fixture, a captured transcript): every line through the translator.
export function translateText(text, state = newStreamState(), now = Date.now()) {
  const events = [];
  const split = lineSplitter((line) => {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      events.push({ event: "claude.unparsed", text: line.slice(0, 300) });
      return;
    }
    events.push(...translateLine(obj, state, now));
  });
  split.push(text);
  split.flush();
  return events;
}

// The control_request a host sends first (the SDK does the same). Shape proven in the spike.
export function initializeRequest(requestId) {
  return { type: "control_request", request_id: requestId, request: { subtype: "initialize" } };
}

// A turn: the prompt as one user message on stdin.
export function userTurn(text) {
  return { type: "user", message: { role: "user", content: String(text) } };
}

// Stop: interrupt the running turn. The process then ends with error_during_execution and exit code 1.
export function interruptRequest(requestId) {
  return { type: "control_request", request_id: requestId, request: { subtype: "interrupt" } };
}
