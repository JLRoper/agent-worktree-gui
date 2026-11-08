// The jobs prefix: GET /api/jobs and the ten writes beside it, lifted out of server.js's if-chain.
//
// Step 8 of docs/reports/module-map-2026-11-08.html moves one route prefix at a time into routes/, mounted from
// the PREFIX_MOUNTS table. routes/assistant-queue.js and routes/assistant-delete.js were the two rows cut out of
// lib/ modules; routes/state.js was the first lifted out of server.js's own chain, and this is the second: the
// eleven blocks below stood in that chain, and they stand here in the same order, with the same literals, the
// same status codes and the same body sentences.
//
//   GET  /api/jobs                  every card, the transport probe and the default cwd. READ-ONLY, not token-gated.
//   POST /api/jobs/cancel           {id} - stop a run.
//   POST /api/jobs/steer            {id, text, attachments?} - inject text at the run's next tool boundary.
//   POST /api/jobs/reattach         {id} - ask the gateway about ONE interrupted card and settle it.
//   POST /api/jobs/ask-complete     {id} - queue one ask for the board assistant.
//   POST /api/jobs/approve          {id, choice, requestId} - answer a parked run's approval.
//   POST /api/jobs/answer           {id, answer, requestId} - answer a clarify prompt the run is blocked on.
//   POST /api/jobs/attach           {thread, path|detach} - give a conversation a tree, or take one back.
//   POST /api/jobs/label            {thread, label} - a panel-side display name; the thread id stays the identity.
//   POST /api/jobs/clear            {thread?} - forget one conversation, or every finished one.
//   POST /api/jobs/artifact/delete  {key|path|url} - delete one recorded deliverable.
//
// The seam is the store and the four things that are the composition root's own: `jobs` owns every card and every
// transition, `config` carries the token, `assistant` answers ask-complete out of its own wake queue, `broadcast`
// repaints the board after attach and clear, and `gonePointers` reads the tree and PR a reattach has to name from
// the board's rows. All five travel in, so this file owns no state and no scheduler. The transport helpers travel
// in beside them, imported from lib/http/respond.js by the composition root rather than redefined here: this module
// imports no HTTP layer and defines none of sendJson, readBody or authorised, so a test can drive a route with a
// recorder and the wire bytes are the ones lib/http/respond.js writes.
//
// Every path is an exact compare - the mount table's prefix test is only what decides whether this file is asked at
// all - and a path or method this file does not answer falls through (`return false`) to the rest of server.js's
// chain, which is where the unmatched method answered before the cut, so `POST /api/jobs` is still the chain's own
// 404 rather than a 405 invented here.

import path from "node:path";
import { stat, unlink } from "node:fs/promises";
import { gitIn } from "../lib/scan.js";
// The one answer to "may this run take a steer right now?", the same file the page loads as a classic script and
// lib/jobs.js imports for its own status guard (public/core/steerable.js, published on globalThis).
import "../public/core/steerable.js";

const { PARKED: STEER_PARKED, PAST_BOUNDARY: STEER_PAST_BOUNDARY, GONE: STEER_GONE } = globalThis.wtSteerable;

/** The prefix every path below sits under, and the row the mount table in server.js matches on. */
export const JOBS_PATH = "/api/jobs";

export function createJobsRoutes({ jobs, config = {}, assistant, broadcast, gonePointers, sendJson, readBody, authorised } = {}) {
  if (!jobs) throw new Error("createJobsRoutes needs the Jobs store");
  if (typeof sendJson !== "function" || typeof readBody !== "function" || typeof authorised !== "function") {
    throw new Error("createJobsRoutes needs sendJson, readBody and authorised from the server's transport");
  }
  if (typeof broadcast !== "function") throw new Error("createJobsRoutes needs broadcast from the composition root");
  if (typeof gonePointers !== "function") throw new Error("createJobsRoutes needs gonePointers from the composition root");
  if (!assistant) throw new Error("createJobsRoutes needs the Assistant instance");

  return async function jobsRoutes(req, res, route) {
    if (route === "/api/jobs" && req.method === "GET") {
      await jobs.probe();
      sendJson(res, 200, { jobs: jobs.list(), transport: jobs.transportInfo(), defaultCwd: config.defaultCwd });
      return true;
    }

    if (route === "/api/jobs/cancel" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = await readBody(req);
      sendJson(res, 200, { ok: jobs.cancel(String(body.id || "")) });
      return true;
    }

    // Steer a turn that is already running: the text is injected at the agent's next tool boundary,
    // so it can change course without ending the turn. 409 means it crossed the last boundary.
    if (route === "/api/jobs/steer" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = await readBody(req);
      const r = await jobs.steer(String(body.id || ""), body.text ?? body.input);
      // A steer lands inside the turn that is already running, so its documents belong to that turn's
      // card rather than to a new one.
      if (r.ok && Array.isArray(body.attachments) && body.attachments.length) jobs.addAttachments(String(body.id || ""), body.attachments);
      // One status per case, and the body's `reason` says which: 409 for a run that EXISTS and will not take a steer
      // right now (parked on an approval, or past its last tool boundary), 404 for a run the gateway no longer has
      // (the row has already been settled in this same answer), and 400 only for a request this route cannot act on
      // at all (no such card, no text, a card that is not running).
      const why = String(r.reason || "");
      const refused =
        why === STEER_PARKED ||
        why === STEER_PAST_BOUNDARY ||
        ["run_not_accepting_steer", "steer_not_accepted", "run_parked_on_approval"].includes(String(r.code || "")) ||
        Number(r.gatewayStatus) === 409;
      const status = r.ok ? 200 : why === STEER_GONE ? 404 : refused ? 409 : 400;
      sendJson(res, status, r);
      return true;
    }

    // The NOT-RUNNABLE chip's press: ask the gateway about ONE interrupted card's run and take the same decision
    // the boot reconcile takes (lib/jobs.js settleRestoredRun - one implementation, not two). The pointers are
    // looked up only here, because only this answer leaves the reader with nothing left to click: a run the gateway
    // has forgotten settles as interrupted, and the card has to name the tree the work is in and its PR.
    if (route === "/api/jobs/reattach" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = await readBody(req);
      const id = String(body?.id || "").trim();
      const r = await jobs.reattachNow(id, { pointers: gonePointers(id) });
      // 400 for a card this route cannot ask about at all (unknown, no run id, not interrupted), and for a gateway
      // that will not answer: the press is a question the panel understood and cannot settle, and the card keeps its
      // verdict. A decision always comes back as 200 with the card it left behind.
      sendJson(res, r.ok ? 200 : 400, r);
      return true;
    }

    // The press on a finished card's COMPLETE chip: queue ONE ask for the board assistant and send nothing to the
    // agent. It goes through the assistant's own wake queue - the path an alert handed over uses - and never through
    // /api/assistant/say, which starts a turn at once and would talk over a run already in flight. The answer carries
    // what the queue decided, so the chip can say the ask landed or say why it did not; a card this route cannot ask
    // about (unknown, or no longer `done`) is a 400 with the reason.
    if (route === "/api/jobs/ask-complete" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = await readBody(req);
      try {
        sendJson(res, 200, assistant.askAboutComplete(String(body?.id || "").trim()));
      } catch (e) {
        sendJson(res, 400, { error: String((e && e.message) || e), ok: false });
      }
      return true;
    }

    // Answer a parked run's approval. The gateway validates the choice a second time, so a stale
    // card cannot widen what the host allows.
    if (route === "/api/jobs/approve" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = await readBody(req);
      const r = await jobs.approve(String(body.id || ""), body.choice, body.requestId ?? body.request_id);
      // 409 for "there is nothing to answer any more" - the gateway's own verdict on a prompt it has let go, and
      // the panel's on one whose window closed (`gone`), so a client can tell it from a malformed request.
      // `answer_in_flight` is a conflict too: the first press owns the answer, and this one changed nothing.
      sendJson(res, r.ok ? 200 : r.gone || r.code === "approval_not_pending" || r.code === "answer_in_flight" ? 409 : 400, r);
      return true;
    }

    // Answer a question the agent's `clarify` tool is blocked on. Same fence as an approval: the
    // gateway re-validates the prompt id against the run's pending controls and its execution
    // generation, so a stale card cannot answer a question that has already been settled.
    if (route === "/api/jobs/answer" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = await readBody(req);
      const r = await jobs.answerQuestion(String(body.id || ""), body.answer, body.requestId ?? body.request_id);
      // `answer_in_flight` is the single-flight fence refusing a second press for a question the first one is
      // already answering: a conflict, not a malformed body.
      sendJson(res, r.ok ? 200 : r.code === "approval_not_pending" || r.code === "answer_in_flight" ? 409 : 400, r);
      return true;
    }

    if (route === "/api/jobs/attach" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = await readBody(req);
      const thread = String(body.thread || "").trim();
      const target = String(body.path || "").trim();
      if (!thread) {
        sendJson(res, 400, { error: "thread is required" });
        return true;
      }
      if (!jobs.firstOfThread(thread)) {
        sendJson(res, 404, { error: `unknown thread: ${thread}` });
        return true;
      }
      // detach: the agent goes back to the unattached workspace.
      if (body.detach === true || !target) {
        const r = jobs.setOwner(thread, null);
        broadcast({ type: "jobs", jobs: jobs.list() });
        sendJson(res, 200, { ok: true, ownerPath: null, turns: r.turns, jobs: jobs.list() });
        return true;
      }
      try {
        if (!(await stat(target)).isDirectory()) {
          sendJson(res, 400, { error: `${target} is not a directory` });
          return true;
        }
      } catch {
        sendJson(res, 400, { error: `${target} does not exist` });
        return true;
      }
      // Only a real worktree can own an agent, and only at its root - a subdirectory or a plain
      // folder would file the agent somewhere no row can ever show.
      const isWt = await gitIn(target, ["rev-parse", "--is-inside-work-tree"]);
      const top = await gitIn(target, ["rev-parse", "--show-toplevel"]);
      const normTarget = path.resolve(target).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      const normTop = String(top.out || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      if (!isWt.ok || isWt.out !== "true" || normTop !== normTarget) {
        sendJson(res, 400, { error: `${target} is not the root of a git worktree` });
        return true;
      }
      const r = jobs.setOwner(thread, target);
      broadcast({ type: "jobs", jobs: jobs.list() });
      sendJson(res, 200, { ok: true, ownerPath: r.ownerPath, turns: r.turns, jobs: jobs.list() });
      return true;
    }

    if (route === "/api/jobs/label" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = await readBody(req).catch(() => ({}));
      const thread = String(body.thread || "").trim();
      if (!thread) {
        sendJson(res, 400, { error: "thread is required" });
        return true;
      }
      if (!jobs.firstOfThread(thread)) {
        sendJson(res, 404, { error: `unknown thread: ${thread}` });
        return true;
      }
      // A panel-side display name only. The Hermes thread id stays the identity (it is what resumes
      // the session), so renaming can never orphan a conversation.
      const label = jobs.setLabel(thread, body.label);
      if (!label.ok) {
        sendJson(res, 400, { error: label.error });
        return true;
      }
      sendJson(res, 200, { ok: true, thread, label: label.label, jobs: jobs.list() });
      return true;
    }

    if (route === "/api/jobs/clear" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = await readBody(req).catch(() => ({}));
      const thread = String(body.thread || "").trim();
      if (thread) {
        // Forget one conversation only. Refused while it is working: cancelling is a deliberate,
        // separate action, and a "clear" that silently killed a turn would be a trap.
        const r = jobs.clearThread(thread);
        if (!r.ok) {
          sendJson(res, 409, { error: `a turn is still running in this agent - cancel it first`, running: r.running });
          return true;
        }
        broadcast({ type: "jobs", jobs: jobs.list() });
        sendJson(res, 200, { ok: true, removed: r.removed, jobs: jobs.list() });
        return true;
      }
      jobs.clearFinished();
      broadcast({ type: "jobs", jobs: jobs.list() });
      sendJson(res, 200, { ok: true, jobs: jobs.list() });
      return true;
    }

    // Delete a deliverable. The confirmation lives in the UI; this only acts on a path or URL the panel
    // itself recorded, so a stray string from the page can never delete an arbitrary file.
    if (route === "/api/jobs/artifact/delete" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = await readBody(req).catch(() => ({}));
      const key = String(body.key || body.path || body.url || "").trim();
      const hit = jobs.findArtifact(key);
      if (!hit) {
        sendJson(res, 404, { error: `not a recorded deliverable: ${key}` });
        return true;
      }
      let removedFile = false;
      if (hit.artifact.kind !== "url" && hit.artifact.path) {
        try {
          await unlink(hit.artifact.path);
          removedFile = true;
        } catch (e) {
          // Already gone is the same outcome for the reader; anything else is worth reporting.
          if (e.code !== "ENOENT") {
            sendJson(res, 500, { error: String((e && e.message) || e) });
            return true;
          }
        }
      }
      jobs.removeArtifact(hit.job, key);
      sendJson(res, 200, { ok: true, removedFile, kind: hit.artifact.kind || "file" });
      return true;
    }

    return false;
  };
}
