// Transport abstraction for different agent backends (Hermes HTTP Runs API, Claude CLI stream-json, etc.)
//
// Each transport implements the same interface, allowing Jobs to support multiple agent types
// without embedding backend-specific code. The interface is event-driven: transports call
// jobs.consume(j, evt) to feed events into the job's state machine, and call jobs.emit(j)
// to signal UI updates.

export class Transport {
  constructor(opts = {}) {
    this.onLog = opts.onLog || (() => {});
  }

  // Prepare headers for API requests (for HTTP transports)
  headers(extra = {}) {
    return { "Content-Type": "application/json", ...extra };
  }

  // Check if the transport backend is reachable and has required capabilities.
  // Returns { reachable, error, capabilities, ... }
  async probe({ fresh = false } = {}) {
    throw new Error("probe() not implemented");
  }

  // Spawn a new agent run. The run begins in "starting" status, and callers should
  // watch via follow() or poll() for status changes.
  // Returns the run (j) with runId set.
  async create(j, opts = {}) {
    throw new Error("create() not implemented");
  }

  // Subscribe to a run's event stream. Calls jobs.consume(j, evt) for each event.
  // Called after follow() returns, jobs should check poll() for the final status.
  async follow(j, opts = {}) {
    throw new Error("follow() not implemented");
  }

  // Send a text message to steer the run at the next tool boundary.
  async steer(j, text) {
    throw new Error("steer() not implemented");
  }

  // Answer an approval prompt (a flagged command or similar gate).
  // choice is one of the choices the approval offered (e.g. "once", "deny", "always").
  // requestId identifies the approval in the run's event stream.
  async approve(j, choice, requestId) {
    throw new Error("approve() not implemented");
  }

  // Send a clarify answer (response to an agent's clarify.request).
  async clarify(j, answer, requestId) {
    throw new Error("clarify() not implemented");
  }

  // Interrupt the run. Cooperative: the run may take a moment to stop.
  async stop(j) {
    throw new Error("stop() not implemented");
  }

  // Check the run's current status in the backend.
  // Returns { status, error, usage?, ... } or null if not found.
  async poll(j) {
    throw new Error("poll() not implemented");
  }
}
