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
//
// TWO KINDS OF EVIDENCE, and they answer different halves of the question:
//
//   - a RUN's stream is the round trip: `clarify.request` proves the callback is bound AND the route
//     answers; the tool's refusal proves the callback is not bound (the route may or may not exist —
//     a refused call never reaches it).
//   - a ROUTE PROBE is the endpoint alone: one POST to `/v1/runs/<probe-id>/clarify`, which answers
//     `run_not_found` (JSON) when the route is there and a plain 404 when it is not. It starts
//     nothing, answers nothing and changes nothing — the id is one this panel made up.
//
// The probe is what makes the instruction CONDITIONAL rather than one-way: a run that never happens
// to call clarify says nothing about the build, so without a probe the panel can only ever learn
// "broken" (from a refusal) and never "works" (until somebody's question parks). The probe settles
// the route half up front, on the panel's own clock, so a worker that needs a decision is told to
// CALL the tool — which is the whole point: a worker that asks in prose ends its turn and stops,
// while one that asks with clarify stays parked and can be answered.

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

// Said to the run when the build has been PROVED to deliver a question (a run's own `clarify.request`,
// or a route probe that found the endpoint). The opposite instruction, and the reason it exists: a
// worker that asks in prose ENDS ITS TURN — the run stops, the question sits in a finished card and
// whatever it was in the middle of is abandoned. A worker that asks with `clarify` parks, stays alive,
// and the answer comes back into the same turn. Same three-sentence budget as the one above, plus one
// sentence for the `links` field: a question that needs the reader to look at a file or a page should
// carry it as a link, and the field is worthless if the only place it is named is a schema.
const USE_CLARIFY =
  "Note: this gateway build delivers a `clarify` question. If you need a decision from the reader, " +
  "call the clarify tool with your question and the choices you would accept, and wait — the answer " +
  "comes back into this same turn. Do not end your turn on the question in prose: that stops the run " +
  "with the work unfinished. If the decision needs the reader to look at something, pass it as `links` " +
  "(one `{ label, url|path }` per thing) and the card draws an anchor for it; a bare path or URL in the " +
  "question text is linked too.";

// The probe's own made-up run id. A route that finds no such run answers `run_not_found`; an id that
// could collide with a real run would make the probe's meaning depend on somebody else's board.
export const CLARIFY_PROBE_RUN = "wtgui-clarify-route-probe";


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
  //
  // route: true = the answer endpoint answered for a made-up run id; false = it is not there;
  // null = no probe has settled it (or the probe could not tell — an auth layer answering first).
  // `available` is about the ROUND TRIP, `route` is about the ENDPOINT; see the header for why the
  // two are recorded separately and which one outranks the other.
  let state = {
    available: null, at: null, evidence: null, version: null, refusals: 0,
    route: null, routeAt: null, routeEvidence: null,
  };

  // The run is told to use the tool when EITHER half has been proved and nothing has disproved it.
  // A refusal outranks a present route on purpose: the refusal means the callback is not bound, so a
  // present endpoint would still have nothing to deliver and the run must not be sent at it.
  const usable = () => state.available === true || (state.route === true && state.available !== false);

  return {
    state: () => ({ ...state }),

    unavailable: () => state.available === false,

    // Is a question worth ASKING here? True only on proof, never on a guess.
    usable,

    // A different gateway version means a different build, so what the old one did says nothing
    // about this one. Called from Jobs.probe() with the version the capabilities endpoint reports.
    // Both records clear: an upgrade can add the route as easily as it can drop it.
    noteVersion(version) {
      const v = version == null ? null : String(version);
      if (!v) return false;
      if (state.version && state.version !== v) {
        state = {
          available: null, at: null, evidence: null, version: v, refusals: 0,
          route: null, routeAt: null, routeEvidence: null,
        };
        return true;
      }
      state.version = v;
      return false;
    },

    // The endpoint's own verdict, from `probeClarifyRoute` below. Returns true only when this
    // CHANGED the answer, so the caller logs one line rather than one per probe.
    noteRoute({ present, evidence = null, at = null } = {}) {
      if (present !== true && present !== false) return false;
      const was = state.route;
      state = {
        ...state,
        route: present,
        routeAt: at || new Date().toISOString(),
        routeEvidence: evidence ? String(evidence).slice(0, 200) : state.routeEvidence,
      };
      return was !== present;
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

    // What to append to a run's input. Empty unless the build has been PROVED one way or the other —
    // an unknown build gets the old behaviour, because guessing here would be a lie in the prompt.
    //   broken (a refusal, or a probed-absent route) -> ask in prose and end the turn;
    //   working (a clarify.request, or a probed-present route) -> call the tool and stay parked;
    //   unknown -> nothing at all.
    instruction: () => {
      if (state.available === false) return INSTRUCTION;
      if (state.route === false && state.available !== true) return INSTRUCTION;
      if (usable()) return USE_CLARIFY;
      return "";
    },

    describe: () => ({ ...state }),
  };
}

// POSTs `/v1/runs/<made-up id>/clarify` and reads the ERROR, not a success: this only ever asks a
// route that has nothing to answer. Three answers are possible, and only two of them are verdicts:
//
//   `run_not_found` in the gateway's own JSON envelope  -> the route is there (its handler ran and
//                                                          refused the id). present: true
//   a plain 404/405 (no envelope, no code)              -> no such route.                present: false
//   401/403, a timeout, a transport failure, anything else -> the probe learned nothing.  present: null
//
// The distinction matters: "404" alone is what a missing route AND an unknown run both say, so the
// body is read. `invalid_params`, `stale_generation`, `approval_not_pending` and a 200 all mean the
// route answered too — a build may word its refusal differently without becoming a no.
//
// READ-ONLY in the only sense this panel can promise: no run is created, no prompt is answered and
// nothing on the gateway changes. It costs one request per panel probe.
export async function probeClarifyRoute({ url, headers = {}, fetchImpl = null, timeoutMs = 4000 } = {}) {
  const base = String(url || "").replace(/\/+$/, "");
  if (!base) return { present: null, evidence: "no gateway url to probe" };
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") return { present: null, evidence: "no fetch available" };
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  let res;
  try {
    res = await doFetch(`${base}/v1/runs/${CLARIFY_PROBE_RUN}/clarify`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: "{}",
      signal: ctrl ? ctrl.signal : undefined,
    });
  } catch (e) {
    return { present: null, evidence: `the probe did not complete: ${String((e && e.message) || e)}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
  const status = Number(res?.status) || 0;
  if (status === 401 || status === 403) {
    return { present: null, evidence: `HTTP ${status} — an auth layer answered before the router, so the probe settles nothing` };
  }
  let body = null;
  try {
    body = typeof res.json === "function" ? await res.json() : null;
  } catch {
    body = null;
  }
  const code = String(body?.error?.code || body?.code || "").trim();
  if (status >= 200 && status < 300) return { present: true, evidence: `HTTP ${status} — the route answered` };
  if (code === "run_not_found" || code === "invalid_params" || code === "stale_generation" || code === "approval_not_pending") {
    return { present: true, evidence: `HTTP ${status} ${code} — the route's own handler answered for a made-up run id` };
  }
  if (body && body.error) {
    // A JSON error envelope from something that is not this route's handler is still an answer from
    // the router — but it is not this route's answer, so it is reported as undecided rather than no.
    return { present: null, evidence: `HTTP ${status} with an unrecognised error envelope (${code || "no code"})` };
  }
  if (status === 404 || status === 405) {
    return { present: false, evidence: `HTTP ${status} with no JSON envelope — this build has no clarify route` };
  }
  return { present: null, evidence: `HTTP ${status} — not a verdict this probe can read` };
}

