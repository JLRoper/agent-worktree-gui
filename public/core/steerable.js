// core/steerable.js — "may this run take a steer right now?" asked once, by the card and by the route.
//
// The card used to draw its Steer turn button from the status word alone (`turnLive`), so a run parked on an
// approval — and a run the gateway no longer has — offered a control the gateway answers with a 409/404. The three
// cases behind one sentence (docs/steer-refusal.md §2.2):
//
//   parked         the run is parked on an approval: the gateway holds it at `waiting_for_approval`, and a steer
//                  cannot land until the reader answers. The card draws the approval box instead.
//   past_boundary  the run crossed its last tool boundary: `agent.steer(text)` refused the text and the turn is
//                  already finishing, so nothing can be steered into it. The text belongs in a held reply.
//   gone           the gateway has no record of the run any more (404): there is no turn to steer and nothing to
//                  queue behind, so the row settles.
//
// Pure, and published on globalThis as `wtSteerable`: public/app.js draws the control from it, lib/jobs.js answers
// the route from the same object, and test/steerable.test.js imports this file.
(function (root) {
  const PARKED = "parked";
  const PAST_BOUNDARY = "past_boundary";
  const GONE = "gone";
  const NOT_RUNNING = "not_running";

  // Is the gateway still holding this approval? The window is the gateway's own: past the deadline it has denied the
  // command by itself and moved the run on, so the park is over even before the sweep takes the box away.
  function approvalOpen(approval, now = Date.now()) {
    if (!approval) return false;
    const deadline = Number(approval.deadline);
    return !Number.isFinite(deadline) || now < deadline;
  }

  // The ONE answer to "may this run take a steer right now". `runGone` is the panel's own record of a proven 404,
  // which no later press can undo; a status other than `running` has no live agent to steer; an open approval holds
  // the run at the gateway; and `steerRefused` is the gateway's own last-tool-boundary refusal for this turn.
  function steerable(job, now = Date.now()) {
    if (!job) return { ok: false, why: NOT_RUNNING };
    if (job.runGone) return { ok: false, why: GONE };
    if (String(job.status || "") !== "running" || !job.runId) return { ok: false, why: NOT_RUNNING };
    if (approvalOpen(job.approval, now)) return { ok: false, why: PARKED };
    if (job.steerRefused === PAST_BOUNDARY) return { ok: false, why: PAST_BOUNDARY };
    return { ok: true, why: null };
  }

  // One sentence per reason, so the route's body and the page's warn line cannot describe the same refusal two
  // different ways.
  const TEXT = {
    [PARKED]: "this turn is parked on an approval — answer it above and Steer works again; a steer cannot land while the run is held",
    [PAST_BOUNDARY]: "this turn is past its last tool boundary — it is already finishing, so a steer cannot land in it",
    [GONE]: "the gateway no longer has this run — there is no turn left to steer, so this card settles instead",
    [NOT_RUNNING]: "this turn is not running — there is nothing to steer",
  };

  function refusalText(why) {
    return TEXT[why] || TEXT[NOT_RUNNING];
  }

  // The stable code the route carries for each reason. Parked keeps the code the route has always answered with, so
  // a client that only knows the old name still reads it.
  const CODE = {
    [PARKED]: "run_parked_on_approval",
    [PAST_BOUNDARY]: "steer_past_boundary",
    [GONE]: "run_gone",
    [NOT_RUNNING]: "run_not_running",
  };

  // What a refused `POST /v1/runs/{id}/steer` actually was. The gateway has exactly two 409 bodies and one 404, and
  // the STATUS alone cannot tell "parked" from "past its last tool boundary" (docs/steer-refusal.md §2.1), so the
  // run document read once after the refusal supplies the status word. A refusal the panel cannot classify answers
  // "" rather than guessing a case.
  function classifyRefusal({ status, code, runStatus, known, terminal } = {}) {
    const c = String(code || "");
    const s = Number(status) || 0;
    const said = String(runStatus || "");
    if (s === 404 || c === "run_not_found" || known === false) return GONE;
    if (terminal) return NOT_RUNNING;
    if (said === "waiting_for_approval" || said === "waiting") return PARKED;
    if (s === 409 || c === "run_not_accepting_steer" || c === "steer_not_accepted") {
      return said === "running" ? PAST_BOUNDARY : "";
    }
    return "";
  }

  root.wtSteerable = { PARKED, PAST_BOUNDARY, GONE, NOT_RUNNING, approvalOpen, steerable, refusalText, CODE, classifyRefusal };
})(globalThis);
