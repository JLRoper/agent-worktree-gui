// A RUN's own approval, in the permission history.
//
// WHY THIS FILE EXISTS. The panel shows a permission in two shapes. The CLI approval transport (lib/approvals.js)
// presents a redacted request and waits for an answer; a RUN parked at `waiting_for_approval` gets its request on
// the run's own stream and the card is drawn from `j.approval` (lib/jobs.js). Both are the same thing to a reader:
// a command that will not run until somebody decides. But only the transport ever wrote to the permission history
// (lib/permissions-history.js, served to the header's Permissions popup by routes/permissions-history.js), so a run's
// approval was visible on the card and invisible to the button. Measured 2026-11-26: the console counted down "6m
// left" on a live request while the popup said "No permission request has reached this panel yet" and
// GET /api/permissions/history answered `total 0` with `outstanding 0`.
//
// So this module is the run's half of the ONE record, in three parts and no more:
//
//   onApproval(evt)   what a run's approval asks, answers or expires writes to the store (lib/jobs.js calls it).
//   live()            the run approvals a person can answer RIGHT NOW, for the popup's pending list and the
//                     header button's count. The transport's own queue stays its own feed; the route merges both.
//   answer(id, ch)    the popup's press, routed back to the run that is parked on it through the same
//                     `jobs.approve` the board's card uses. Null means "not a run approval" and the caller falls
//                     through to the transport's answer route.
//
// NO POLICY LIVES HERE. The choices are the ones the host allowed (lib/jobs.js mirrors them), the window is the
// gateway's own, and an expiry is recorded as EXPIRED - never as the `deny` the gateway's fail-closed rule sends the
// waiting host, because no person pressed that.

const slashed = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * Where one run's approval belongs, from the job's own record (lib/jobs.js `summary()`): the turn, the gateway run,
 * the thread, the tree and the assistant. The field names are the ones routes/permissions-history.js and
 * lib/permissions-history.js already read, so a stored record and a popup row cannot disagree about who was asked.
 */
export function placeOfJob(job = {}) {
  const j = job || {};
  const treePath = slashed(j.worktreePath || j.cwd);
  const projectPath = slashed(j.projectPath);
  return {
    jobId: j.id ? String(j.id) : null,
    runId: j.runId ? String(j.runId) : null,
    thread: j.thread ? String(j.thread) : null,
    // The panel's own name for the session first (a rename is what the reader sees), then the gateway's title, then
    // the thread: the row always names the agent.
    agent: String(j.label || j.title || j.thread || "").trim(),
    tree: j.branch || (treePath ? treePath.split("/").pop() : ""),
    treePath,
    project: projectPath ? projectPath.split("/").pop() : "",
    assistantId: j.assistantId ? String(j.assistantId) : null,
  };
}

/**
 * The bridge. `jobs` is the run store (lib/jobs.js), `permissions` the durable history (lib/permissions-history.js),
 * and `nameForAssistant` the panel's current display name for an assistant id - read per event so a rename shows up
 * on the next row instead of on the next restart.
 */
export function createRunApprovalBridge({ jobs = null, permissions = null, nameForAssistant = null, log = null } = {}) {
  if (!jobs) throw new Error("createRunApprovalBridge needs the Jobs store");
  if (!permissions) throw new Error("createRunApprovalBridge needs the PermissionsHistory store");
  const nameFor = typeof nameForAssistant === "function" ? nameForAssistant : () => null;
  const say = typeof log === "function" ? log : () => {};

  const assistantNameOf = (place) => {
    if (!place?.assistantId) return "";
    try {
      return String(nameFor(place.assistantId) || "");
    } catch {
      return "";
    }
  };

  function onApproval(evt = {}) {
    const key = String(evt.key || "").trim();
    if (!key) return null;
    const place = placeOfJob(evt.job || {});
    const assistantName = assistantNameOf(place);
    if (evt.type === "ask") {
      const a = evt.approval || {};
      // The record is written when the request ARRIVES and updated in place while it is open (the store dedupes by
      // the request's own id), so a request replayed off the run's buffer is one row, not two.
      return permissions.ask({
        requestId: key,
        command: String(a.command || ""),
        choices: (Array.isArray(a.choices) ? a.choices : []).map(String),
        timeoutSeconds: Number(a.timeoutSeconds) || null,
        receivedAt: a.at || null,
        deadline: Number(a.deadline) || null,
        surface: "gateway run",
        ...place,
        assistantName,
      });
    }
    if (evt.type === "answered") {
      return permissions.answered(key, {
        choice: String(evt.choice || ""),
        by: String(evt.by || "reader"),
        at: evt.at || null,
        via: "gateway run",
      });
    }
    if (evt.type === "expired") {
      return permissions.expired(key, { why: String(evt.why || "timed out"), at: evt.at || null });
    }
    return null;
  }

  /** The run approvals a person can answer right now, in the shape the live list reads. */
  function live() {
    try {
      return typeof jobs.liveApprovals === "function" ? jobs.liveApprovals() : [];
    } catch (e) {
      say(`run approvals: could not list the live requests (${String((e && e.message) || e)})`);
      return [];
    }
  }

  /**
   * The popup's press. `null` is the answer for an id that is not a run approval (the transport's route owns it);
   * anything else is the same verdict `jobs.approve` gives the board's card, because it IS that call.
   */
  async function answer(id, choice, by = "reader") {
    const found = typeof jobs.approvalByKey === "function" ? jobs.approvalByKey(id) : null;
    if (!found) return null;
    const out = await jobs.approve(found.jobId, choice, found.requestId);
    return { ...out, runApproval: true, id: String(id), by: String(by || "reader") };
  }

  return { onApproval, live, answer };
}
