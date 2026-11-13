// Where an ANSWERED clarify card's answer lands.
//
// A parked question is asked by a turn that has already read the ticket, drafted the comment and measured the
// tree: the answer is a continuation of THAT work, and the thread that asked already holds the context it
// needs. Measured on this board: a thread did the ticket work in two turns for 597k tokens and produced a
// drafted comment, and the follow-up ran as a FRESH session in the same tree, spending 393k input re-deriving
// a one-line comment the asking thread still had in its transcript.
//
// So the default delivery is the asking thread, in this order:
//
//   resume  the run parked on the prompt takes the answer itself (`POST /v1/runs/<id>/clarify`). No new turn,
//           no new session, and the turn carries on with the context it asked from. This is the normal case and
//           it is why nothing here starts a run for a question that is still waiting.
//   reply   the asking run has ENDED under the card (it was stopped between the paint and the press, its cap
//           fired, the gateway dropped it). The answer is still a continuation, so it becomes a reply turn on
//           the ASKING thread: same thread, same session, the context intact. Before this rule the answer was
//           refused as undelivered and the follow-up went to whoever started a new session in that tree.
//   fresh   the caller says the answer changes gear - a different task, a different tree, a different repo - and
//           a new session is wanted. It is an explicit mode, never the default, and it is what keeps a thread
//           whose context is already large from being re-sent on every continuation.
//   refuse  the answer cannot be delivered AND must not start a turn: a run the reader STOPPED is not resumed by
//           an answer, and a refusal the gateway itself wrote (a malformed body, an answer already in flight) is
//           the gateway's verdict, not something to work around.
//
// Pure on purpose: the decision is a function of the card and of what the gateway said, so a test can pin all
// four modes without a gateway, a job store or a clock. `lib/assistant.js` owns the three deliveries; this module
// owns the choice between them.

/** The four things an answer can become. `resume` is the default, `fresh` is the only one that mints a session. */
export const ANSWER_MODES = ["resume", "reply", "fresh", "refuse"];

// The run statuses that were the READER's own act. A stopped run is not resumed by an answer: the stop is the
// decision, and starting a turn on that thread would take it back without saying so.
const STOPPED_STATUS = new Set(["cancelled", "canceled", "stopped", "killed"]);

/**
 * What to do with an answer.
 *
 * `job`     the card that asked (the panel's own job record: `thread`, `status`, `runId`, `question`).
 * `fresh`   the caller asked for a NEW session on purpose.
 * `resumed` the panel's attempt to hand the answer to the parked run, or null before it is made. Its shape is
 *           `Jobs.answerQuestion`'s: `{ok, undelivered?, code?, runStatus?, error?}`.
 *
 * @returns {{mode: "resume"|"reply"|"fresh"|"refuse", why: string}}
 */
export function answerDelivery({ job = {}, fresh = false, resumed = null } = {}) {
  if (fresh === true) {
    return { mode: "fresh", why: "the caller asked for a new session, so the answer starts one instead of continuing the asking thread" };
  }
  if (!resumed) {
    return { mode: "resume", why: "the run parked on the question takes the answer on the thread that asked" };
  }
  if (resumed.ok === true) {
    return { mode: "resume", why: "the parked run took the answer and carries on with the context it asked from" };
  }
  if (resumed.undelivered !== true) {
    // Not a delivery failure: the gateway refused the answer (a body it will not read, an answer already in
    // flight, an empty one). Re-sending it as a turn would report a decision the gateway never took.
    return { mode: "refuse", why: String(resumed.error || resumed.code || "the gateway refused the answer") };
  }
  const status = String(resumed.runStatus || job.status || "").trim().toLowerCase();
  if (STOPPED_STATUS.has(status) || job.stoppedBy) {
    return {
      mode: "refuse",
      why: `the reader stopped that run (${status || "stopped"}), and an answer does not restart it - a fresh session is the explicit way back`,
    };
  }
  return {
    mode: "reply",
    why: `the asking run had already ended (${status || "ended"}), so the answer continues the thread that asked instead of starting a new session in the same tree`,
  };
}

// The turn text for a delivery that is NOT the parked run's own resume: the answer alone ("yes") is not a
// prompt. It names the question, the answer, and the one fact a new turn cannot otherwise know - that this
// thread is the one that asked, so the work above it in the transcript is the work to carry on. No dash of any
// kind: this text rides in a prompt that is read back by other agents.
export function answerTurnText(job = {}, answer = "") {
  const q = String(job?.question?.question || "").trim();
  const said = Array.isArray(answer) ? answer.map((a) => String(a)).filter(Boolean).join(" · ") : String(answer ?? "").trim();
  return [
    `[answer] the reader has answered the question this thread asked: ${q ? `"${q}"` : "(the question is no longer on the card)"}`,
    `answer: ${said}`,
    "Carry on from where this thread stopped: this is the same session that asked, so the work above is yours and",
    "this answer is what it was waiting for. Do not re-derive what the thread already holds.",
  ].join("\n");
}

// One line for the card and the journal: the mode, in words a reader can act on. Never claims a run started
// when the parked run took the answer itself.
export function deliveryLine({ mode, thread = "", runId = "" } = {}) {
  const where = thread ? ` on ${thread}` : "";
  if (mode === "resume") return `continued${where}: the parked run took the answer`;
  if (mode === "reply") return `continued${where}: the asking run had ended, so the answer is a reply on its own thread`;
  if (mode === "fresh") return `started a fresh session${where} by request - the answer changed gear`;
  return "not delivered";
}
