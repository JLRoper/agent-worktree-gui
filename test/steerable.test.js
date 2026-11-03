// The parked turn's two defects, and the one predicate the card and the route share — proved against the store
// directly, with a stub gateway that records every request it is sent.
//
//   (1) a SECOND approval.request clears the first one's `approvalDone`, so `approvalPending()`, `summary().approval`
//       and the shared `steerable` verdict all say "parked" again (docs/steer-refusal.md §1.4/§1.7c). Before the
//       fix the second park was answered "nothing is parked": no box, dark row badge, and a steer posted to a
//       gateway that refuses it;
//   (2) `jobs.steer()` answers one reason per case from public/core/steerable.js — parked on an approval, past the
//       last tool boundary, and a run the gateway no longer has (404) — and a proven-gone run settles the row in the
//       same request instead of surfacing as a 400.
import assert from "node:assert/strict";
import test from "node:test";
import { Jobs } from "../lib/jobs.js";

await import("../public/core/steerable.js");
const { steerable, classifyRefusal } = globalThis.wtSteerable;

// A gateway whose answers this test decides, in the two shapes `Jobs` asks for: the steer POST and the run document
// it reads after a refusal.
function installGateway({ runs = {}, steer = {} } = {}) {
  const calls = [];
  const answer = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const m = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(u.pathname);
    calls.push({ method: opts.method || "GET", path: u.pathname, body: opts.body ? JSON.parse(opts.body) : null });
    if (!m) return answer(404, { error: { message: "not found", code: "not_found" } });
    const id = decodeURIComponent(m[1]);
    const sub = m[2] || "";
    if (sub === "/steer" && opts.method === "POST") {
      const said = steer[id] || { status: 200, body: { accepted: true } };
      return answer(said.status, said.body);
    }
    if (!sub) {
      const said = runs[id] || { status: 200, body: { run_id: id, status: "running" } };
      return answer(said.status, said.body);
    }
    return answer(404, { error: { message: "not found", code: "not_found" } });
  };
  return {
    calls,
    posts: () => calls.filter((c) => c.method === "POST"),
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

const store = () => new Jobs({ config: { apiServer: { url: "http://stub.invalid", key: "sandbox-key" } } });
const seed = (jobs, over) => {
  const j = {
    lines: [],
    thread: `wtgui-steerable-${over.id}`,
    turn: 1,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    status: "running",
    exitCode: null,
    endedAt: null,
    ...over,
  };
  jobs.jobs.set(j.id, j);
  return j;
};
const request = (jobs, j, command) =>
  jobs.consume(j, {
    event: "approval.request",
    command,
    choices: ["once", "deny"],
    timeout_seconds: 600,
    timestamp: Date.now() / 1000,
  });

test("the shared predicate answers exactly the three refusals, and nothing else", () => {
  const now = 1_800_000_000_000;
  const job = (over) => ({ status: "running", runId: "run_x", ...over });
  assert.deepEqual(steerable(job({}), now), { ok: true, why: null });
  assert.deepEqual(steerable(job({ approval: { command: "x", deadline: now + 600_000 } }), now), { ok: false, why: "parked" });
  // The window is the gateway's own: a park whose deadline has passed is a run the gateway has moved on.
  assert.deepEqual(steerable(job({ approval: { command: "x", deadline: now - 1 } }), now), { ok: true, why: null });
  assert.deepEqual(steerable(job({ runGone: true }), now), { ok: false, why: "gone" });
  assert.deepEqual(steerable(job({ status: "done" }), now), { ok: false, why: "not_running" });
  assert.deepEqual(steerable(job({ steerRefused: "past_boundary" }), now), { ok: false, why: "past_boundary" });
  assert.deepEqual(steerable(null, now), { ok: false, why: "not_running" });

  // The gateway's 404, its two 409 bodies, and the run status word that tells the two 409s apart.
  assert.equal(classifyRefusal({ status: 404 }), "gone");
  assert.equal(classifyRefusal({ status: 200, known: false }), "gone");
  assert.equal(classifyRefusal({ status: 409, code: "run_not_accepting_steer", runStatus: "waiting_for_approval" }), "parked");
  assert.equal(classifyRefusal({ status: 409, code: "run_not_accepting_steer", runStatus: "running" }), "past_boundary");
  assert.equal(classifyRefusal({ status: 409, code: "steer_not_accepted", runStatus: "running" }), "past_boundary");
  assert.equal(classifyRefusal({ status: 409, code: "steer_not_accepted", runStatus: "completed", terminal: true }), "not_running");
  // A 409 nobody can explain is left unclassified rather than guessed at.
  assert.equal(classifyRefusal({ status: 409 }), "");
});

test("a second approval.request clears the first answer, and the park is back on the card", async (t) => {
  const gw = installGateway();
  t.after(() => gw.restore());
  const jobs = store();
  const j = seed(jobs, { id: "two-parks", runId: "run_two" });

  request(jobs, j, "cd /repo && git log -1");
  assert.equal(jobs.approvalPending(j), true, "the first request parks the turn");
  const first = jobs.summary(j);
  assert.equal(first.approvalDone, null);
  assert.match(first.approval.command, /git log/);
  assert.equal(first.steerable.ok, false);
  assert.equal(first.steerable.why, "parked");

  jobs.consume(j, { event: "approval.responded", choice: "session" });
  assert.equal(j.approval, null, "answering clears the park");
  assert.equal(j.approvalDone.choice, "session", "…and leaves the record of what was decided");
  assert.equal(jobs.approvalPending(j), false);

  request(jobs, j, 'cmd //c "taskkill /F /PID 15920"');
  // THE DEFECT, in one line: the first answer used to survive into the second request.
  assert.equal(j.approvalDone, null, "the new request clears the previous answer");
  assert.equal(jobs.approvalPending(j), true, "the second park is a park");
  const second = jobs.summary(j);
  assert.match(second.approval.command, /taskkill/, "the card carries the second request");
  assert.equal(second.approvalDone, null, "…and nothing suppresses its box");
  assert.deepEqual(second.steerable, {
    ok: false,
    why: "parked",
    text: second.steerable.text,
  });
  assert.match(second.steerable.text, /parked on an approval/);
  // The steer the page drew a button for is refused before any round trip: a parked run costs the gateway nothing.
  const refused = await jobs.steer(j.id, "carry on");
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "parked");
  assert.equal(refused.code, "run_parked_on_approval");
  assert.match(refused.error, /parked on an approval/);
  assert.equal(gw.posts().length, 0, "no POST /v1/runs/<id>/steer while the run is held");
});

test("a gateway 409 on a live run is the past-boundary refusal, and the card stops offering the press", async (t) => {
  const gw = installGateway({
    steer: { run_past: { status: 409, body: { error: { message: "Run did not accept steer text", code: "steer_not_accepted" } } } },
    runs: { run_past: { status: 200, body: { run_id: "run_past", status: "running" } } },
  });
  t.after(() => gw.restore());
  const jobs = store();
  const j = seed(jobs, { id: "past", runId: "run_past" });

  const out = await jobs.steer(j.id, "too late");
  assert.equal(out.ok, false);
  assert.equal(out.reason, "past_boundary", "a 409 on a run the gateway still calls running is the last tool boundary");
  assert.equal(out.runStatus, "running");
  assert.match(out.error, /did not accept steer/i);
  assert.equal(gw.posts().length, 1, "the route did ask the gateway once");
  assert.equal(jobs.summary(j).steerable.ok, false);
  assert.equal(jobs.summary(j).steerable.why, "past_boundary", "the control is not drawn again for this turn");
  // A second press costs no second round trip: the refusal belongs to the turn now.
  const again = await jobs.steer(j.id, "again");
  assert.equal(again.ok, false);
  assert.equal(again.reason, "past_boundary");
  assert.equal(gw.posts().length, 1);
});

test("a gateway 409 on a run parked at the gateway is the parked refusal", async (t) => {
  const gw = installGateway({
    steer: { run_parked_remote: { status: 409, body: { error: { message: "Run is not currently accepting steer input", code: "run_not_accepting_steer" } } } },
    runs: { run_parked_remote: { status: 200, body: { run_id: "run_parked_remote", status: "waiting_for_approval" } } },
  });
  t.after(() => gw.restore());
  const jobs = store();
  // The card does not know about this park (it arrived on another surface), so the route has to classify it.
  const j = seed(jobs, { id: "remote-park", runId: "run_parked_remote" });

  const out = await jobs.steer(j.id, "answer it first");
  assert.equal(out.ok, false);
  assert.equal(out.reason, "parked");
  assert.equal(out.runStatus, "waiting_for_approval");
  assert.match(out.error, /not currently accepting steer input/);
  assert.equal(gw.posts().length, 1);
});

test("a 404 from the gateway is the gone refusal, and the row settles in the same request", async (t) => {
  const gw = installGateway({
    steer: { run_gone: { status: 404, body: { error: { message: "Run not found", code: "run_not_found" } } } },
    runs: { run_gone: { status: 404, body: { error: { message: "Run not found", code: "run_not_found" } } } },
  });
  t.after(() => gw.restore());
  const jobs = store();
  const j = seed(jobs, { id: "gone", runId: "run_gone" });

  const out = await jobs.steer(j.id, "anyone there");
  assert.equal(out.ok, false);
  assert.equal(out.reason, "gone", "the gateway's 404 is its own case, not a malformed request");
  assert.equal(out.code, "run_gone");
  assert.match(out.error, /no longer has this run/);
  assert.equal(j.status, "interrupted", "the row is settled by the same request");
  assert.equal(j.runGone, true);
  assert.ok(out.card, "the settled card rides back with the refusal");
  assert.equal(out.card.status, "interrupted");
  assert.equal(out.card.runGone, true);
  assert.equal(out.card.steerable.why, "gone");
});
