// Pending human-approval requests from a Hermes approval transport (see ~/.hermes/plugins/
// worktree-panel). The host owns the policy: it hands over a redacted request, waits for a
// correlated decision, and fails closed on timeout. This module is only the human side —
// it never decides anything on its own, and a request it never hears back about is denied.
//
// The contract deliberately mirrors hermes_cli/approval_transport.py: request_id + digest bind
// an answer to one exact request, so a late click cannot authorise a different command.
const DECISIONS = new Set(["once", "session", "always", "deny"]);

export class Approvals {
  constructor({ onEvent = () => {}, ttlMs = 300_000 } = {}) {
    this.onEvent = onEvent;
    this.ttlMs = ttlMs;
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
    const timeoutSeconds = Number(input.timeout_seconds) || 300;
    const request = {
      id,
      digest: String(input.digest || ""),
      command: String(input.command || ""),
      description: String(input.description || ""),
      patternKey: input.pattern_key || null,
      surface: String(input.surface || ""),
      allowed: allowed.length ? allowed : ["once", "deny"],
      timeoutSeconds,
      receivedAt: new Date().toISOString(),
      deadline: Date.now() + Math.max(1, timeoutSeconds - 5) * 1000, // answer before the host gives up
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
  // the card must not sit on screen looking actionable after it expired.
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
