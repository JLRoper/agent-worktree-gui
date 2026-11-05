// Pending human-approval requests from a Hermes approval transport (see ~/.hermes/plugins/
// worktree-panel). The host owns the policy: it hands over a redacted request, waits for a
// correlated decision, and fails closed on timeout. This module is only the human side —
// it never decides anything on its own, and a request it never hears back about is denied.
//
// The contract deliberately mirrors hermes_cli/approval_transport.py: request_id + digest bind
// an answer to one exact request, so a late click cannot authorise a different command.
import { approvalWindowSeconds } from "./hermes-config.js";

const DECISIONS = new Set(["once", "session", "always", "deny"]);

// The fallback window for a request that names none is not a number of this module's own: it is the
// same `approvals.timeout` the gateway reads (lib/hermes-config.js, the value the Settings row writes),
// resolved once when the panel constructs this object, so a card tracks the knob the reader can turn.
// No file or no readable value means HOST_APPROVAL_HOLD_SECONDS — the gateway's own hold, 600 s on this
// board. A copied-in 300 s is what used to sweep the card at 4m55s while the gateway still held the
// request for another five minutes, so the waiting worker read the swept `deny` as its answer and the
// command had to be asked for again. A host that knows its own window sends `timeout_seconds` per
// request, and that always wins.
const HOST_APPROVAL_HOLD_SECONDS = 600;

// The answer has to reach the host before it stops waiting, so the panel's deadline sits this far
// INSIDE the request's own window. Subtracted with a floor of zero, never a minimum of one second: a 0 s
// window means "deny at once" (lib/hermes-config.js), and a card that outlives it would offer a decision
// the gateway no longer honours.
const ANSWER_GRACE_SECONDS = 5;

export class Approvals {
  constructor({ onEvent = () => {}, home } = {}) {
    this.onEvent = onEvent;
    // Resolved here, once: `home` is the Hermes home the config is read from (absent = the live one).
    // A config that names a window is the host's own hold and wins; no file, or no readable value,
    // means the host's documented hold.
    const configured = approvalWindowSeconds({ home });
    this.windowSeconds = configured.fromFile ? configured.seconds : HOST_APPROVAL_HOLD_SECONDS;
    this.pending = new Map(); // id -> request (+ local: receivedAt, deadline)
    this.decisions = new Map(); // id -> { choice, at, by }
    this.timer = setInterval(() => this.sweep(), 5000);
    if (this.timer.unref) this.timer.unref();
  }

  // Plugin -> panel. `request_id` is the host's, and `allowed_choices` is the host's policy:
  // anything outside it is refused, so the UI can never offer a scope the host would reject.
  present(input = {}) {
    const id = String(input.request_id || "").trim();
    if (!id) throw new Error("request_id is required");
    const allowed = (Array.isArray(input.allowed_choices) ? input.allowed_choices : ["once", "deny"])
      .map((c) => String(c).toLowerCase())
      .filter((c) => DECISIONS.has(c));
    const asked = typeof input.timeout_seconds === "string" ? input.timeout_seconds.trim() : input.timeout_seconds;
    const askedSeconds = asked == null || asked === "" ? NaN : Number(asked);
    // The window is the request's own when it names one — the host's `approvals.timeout`, carried through
    // the transport — and the host's held window when it does not. 0 is a real window ("deny at once"),
    // so only a value that cannot be read as a number falls back.
    const timeoutSeconds = Number.isFinite(askedSeconds) && askedSeconds >= 0 ? askedSeconds : this.windowSeconds;
    const now = Date.now();
    const request = {
      id,
      digest: String(input.digest || ""),
      command: String(input.command || ""),
      description: String(input.description || ""),
      patternKey: input.pattern_key || null,
      surface: String(input.surface || ""),
      // The panel sets WTGUI_THREAD for every child it spawns; the transport plugin echoes it back so
      // an approval can be tied to the agent that is blocked on it.
      thread: String(input.thread || ""),
      allowed: allowed.length ? allowed : ["once", "deny"],
      timeoutSeconds,
      receivedAt: new Date(now).toISOString(),
      // Answer before the host gives up, and never earlier than the request's own window minus the grace.
      // A 0 s window lands here as a deadline of now: denied at the next sweep, never pushed into the future.
      deadline: now + Math.max(0, timeoutSeconds - ANSWER_GRACE_SECONDS) * 1000,
    };
    this.pending.set(id, request);
    this.decisions.delete(id);
    this.onEvent({ type: "approval", request });
    return request;
  }

  answer(id, choice, by = "panel") {
    const req = this.pending.get(String(id));
    if (!req) return { ok: false, error: "unknown or already-resolved request" };
    const clean = String(choice || "").toLowerCase();
    if (!req.allowed.includes(clean)) {
      return { ok: false, error: `${clean} is not one of the allowed choices: ${req.allowed.join(", ")}` };
    }
    this.pending.delete(id);
    this.decisions.set(id, { choice: clean, at: Date.now(), by });
    this.onEvent({ type: "approval-answered", id, choice: clean });
    return { ok: true, choice: clean };
  }

  // What the plugin long-polls for. A request that timed out reads as "deny".
  status(id) {
    const key = String(id);
    if (this.pending.has(key)) return { status: "pending", choice: null };
    const d = this.decisions.get(key);
    if (d) return { status: "answered", choice: d.choice, at: new Date(d.at).toISOString() };
    return { status: "unknown", choice: null };
  }

  list() {
    return [...this.pending.values()];
  }

  // Nothing answered by the deadline is a denial, not a wait: the host would deny anyway, and
  // the card must not sit on screen looking actionable after it expired. The deadline sits
  // ANSWER_GRACE_SECONDS inside the request's window, so the answer still reaches the host before it
  // stops waiting, and a zero window is denied at once rather than granted a card of its own.
  sweep() {
    const now = Date.now();
    for (const [id, req] of this.pending) {
      if (now < req.deadline) continue;
      this.pending.delete(id);
      this.decisions.set(id, { choice: "deny", at: now, by: "timeout" });
      this.onEvent({ type: "approval-answered", id, choice: "deny", timeout: true });
    }
  }
}
