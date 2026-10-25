// What this panel knows about the `clarify` tool on the gateway it is pointed at.
//
// A clarify question needs TWO gates, and only one of them is configuration:
//
//   1. The toolset the gateway resolves for the API platform must offer `clarify`
//      (`platform_toolsets.api_server` in <HERMES_HOME>/config.yaml). The stock
//      `hermes-api-server` toolset drops interactive UI tools on purpose.
//   2. The gateway BUILD must carry the Runs API half of the contract: a callback set on an API
//      run's agent, and a route to answer the prompt (`POST /v1/runs/{run_id}/clarify`). That is
//      code. `hermes config set` cannot supply it, and neither can this repo.
//
// A build with gate 1 and without gate 2 hands the model the tool and then refuses every call with
// the tool's own message — "Clarify tool is not available in this execution context" — which reads
// like a permission problem and is actually a missing feature. Measured 2026-10-25 against the
// installed build: every `gateway/platforms/api_server*.py` carried zero mentions of clarify and
// there was no `api_server_authority_runs.py` at all, while upstream's main carried the route and
// the callback. So the panel records what it OBSERVES, not what it hopes:
//
//   - a `clarify.request` event is proof the round trip works;
//   - the refusal text in a clarify tool result is proof it does not.
//
// The record is keyed to the gateway version, so installing a build that has the route clears it
// without a panel restart. Until then the panel tells each run to ask in prose instead of burning a
// tool call that can only fail. Nothing here invents a capability: when the state is unknown the
// panel says nothing and behaves exactly as before.

// The tool's own wording (tools/clarify_tool.py: `_UNAVAILABLE`), matched loosely because it can
// arrive wrapped in a JSON envelope or a sentence around it.
export const CLARIFY_REFUSAL = "Clarify tool is not available in this execution context";
const REFUSAL_RE = /clarify tool is not available in this execution context/i;

// Said to the run itself, in the input the panel posts. Kept to three sentences: it rides in every
// turn while the build is broken, and a long lecture in the prompt costs tokens on each spawn.
const INSTRUCTION =
  "Note: this gateway build cannot deliver a `clarify` question — the tool is present but every " +
  "call is refused with \"Clarify tool is not available in this execution context\". If you need a " +
  "decision from the reader, ask it in prose in your final message and end the turn with the " +
  "question; the answer arrives as your next turn. Do not call the clarify tool here.";

// Pull every field a tool event might carry the result in. The Runs API's `tool.completed` puts the
// text in `preview` and flags `error`; other shapes carry `error`, `result` or `output`. Reading all
// of them costs nothing and means a shape change does not silently stop the detection.
function textOf(evt) {
  const parts = [evt?.preview, evt?.result, evt?.output, evt?.error, evt?.message];
  const out = [];
  for (const part of parts) {
    if (part == null) continue;
    if (typeof part === "string") out.push(part);
    else {
      try {
        out.push(JSON.stringify(part));
      } catch {
        /* a value that cannot be stringified cannot be read either */
      }
    }
  }
  return out.join("\n");
}

// The tool name in a `tool.completed` event. The gateway sends the bare name (`clarify`); a bridged
// tool arrives as `mcp__server__clarify`, so the tail is what identifies it.
export function isClarifyTool(name) {
  const n = String(name || "").toLowerCase();
  return n === "clarify" || n.endsWith("__clarify");
}

export function createClarifyCapability() {
  // available: true = a clarify.request came through; false = the tool refused as unavailable;
  // null = nothing observed yet (the panel must not claim either way).
  let state = { available: null, at: null, evidence: null, version: null, refusals: 0 };

  return {
    state: () => ({ ...state }),

    unavailable: () => state.available === false,

    // A different gateway version means a different build, so what the old one did says nothing
    // about this one. Called from Jobs.probe() with the version the capabilities endpoint reports.
    noteVersion(version) {
      const v = version == null ? null : String(version);
      if (!v) return false;
      if (state.version && state.version !== v) {
        state = { available: null, at: null, evidence: null, version: v, refusals: 0 };
        return true;
      }
      state.version = v;
      return false;
    },

    // Fold one run event in. Returns true only when this event CHANGED the answer, so the caller can
    // write one line to the board instead of one per tool call.
    observeEvent(evt) {
      if (!evt || typeof evt !== "object") return false;
      if (evt.event === "clarify.request") {
        if (state.available === true) return false;
        state = { ...state, available: true, at: new Date().toISOString(), evidence: "the gateway delivered a clarify.request" };
        return true;
      }
      const toolEvent = evt.event === "tool.completed" || evt.event === "tool.error" || evt.event === "tool.failed";
      if (!toolEvent || !isClarifyTool(evt.tool)) return false;
      if (!REFUSAL_RE.test(textOf(evt))) return false;
      const was = state.available;
      state = {
        ...state,
        available: false,
        at: new Date().toISOString(),
        evidence: "the clarify tool refused with its own unavailable message",
        refusals: state.refusals + 1,
      };
      return was !== false;
    },

    // What to append to a run's input. Empty unless the build is known to refuse — an unknown build
    // gets the old behaviour, because guessing here would be a lie in the prompt.
    instruction: () => (state.available === false ? INSTRUCTION : ""),

    describe: () => ({ ...state }),
  };
}
