// The Queue row's stopped chip: the EXITED pill (and the not-running one) is the re-attach CONTROL, and what a press
// does with the route's answer.
//
// The renderer and the press are the page's own code, sliced out of public/assistant.js and driven against stubs — the
// same style as assistant-queue-ui.test.js. What this pins:
//
//   1. the markup: the stopped chip is a real <button> carrying `data-as-qreattach` (the thread), `data-as-qown` (the
//      assistant whose queue it is) and `data-as-qid` (the task), with the ↻ glyph the board's own stopped pill has —
//      a native button is the role, the Tab stop and Enter/Space in one element, which is why no span gained role= or
//      tabindex= here. A LIVE run's chip is still a word and nothing else: a press there could only start a second run;
//   2. the press: POST /api/assistants/<this card's assistant>/reset {dryRun:false, reason} and ONLY that with nothing
//      cleared — a healthy card says "nothing was wedged" and starts no run;
//   3. the wake: one /api/assistant/say on the SAME assistant with the short re-attach sentence, and the card's
//      sentence names the run it became;
//   4. the answers that are not a success: a refusal is printed verbatim, a 200 that is `ok:false` is the incomplete
//      verdict and starts nothing, and a wake refused after a clear never claims a run;
//   5. one press, one reset: a second press while the first is out sends nothing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sliceRegion } from "../tools/panel-testkit.mjs";

const assistant = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
const region = sliceRegion(assistant, "the queue sub-tab");

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// `answers` are consumed one per asPost call: a plain value is resolved, a function is CALLED (so it can throw a
// refusal, or hand back a promise this test releases when it wants the press to still be in flight). `apiFetch` and
// `hostFor` are stubs too, because the press's repaint runs the region's REAL `loadQueueJobs`/`renderAssistantQueue`
// and only their edges need a page: the /api/jobs read is recorded, and the pane's host is absent.
const build = ({ answers = [] } = {}) => {
  const posts = [];
  const fetches = [];
  const paints = [];
  const frames = answers.slice();
  const asPost = async (route, body) => {
    posts.push({ route, body });
    const next = frames.length ? frames.shift() : { ok: true, cleared: { admissions: [], wakes: [], watches: [] } };
    return typeof next === "function" ? await next(route, body) : next;
  };
  const apiFetch = async (route) => {
    fetches.push(route);
    return { ok: true, status: 200, json: async () => ({ jobs: [] }) };
  };
  const api = new Function(
    "esc",
    "assistantIds",
    "sessionById",
    "assistantThreadName",
    "asPost",
    "apiFetch",
    "state",
    "isAssistant",
    "hostFor",
    "showBanner",
    "document",
    `${region}
return { queueAgentChip, queueAgentHtml, queueTaskHtml, queueReattach, queueReattachNoteHtml, REATTACH_TEXT };`,
  )(
    esc,
    () => ["assistant-1", "assistant-2"],
    (id) => ({ id, name: `Assistant ${id}` }),
    (t) => t,
    asPost,
    apiFetch,
    { assistantView: null },
    () => false,
    (id, sub) => {
      paints.push(`${id}:${sub}`);
      return null;
    },
    () => {},
    { getElementById: () => null },
  );
  return { api, posts, fetches, paints };
};

const jobs = (pairs) => new Map(pairs);
const row = (threads, extra = {}) => ({ id: 7, title: "re-attach me", state: "queued", files: [], threads, ...extra });

test("the stopped chip is a real button carrying the thread, the assistant and the task", () => {
  const { api } = build({ jobs: jobs([["T-failed", { status: "failed", runId: "run_1" }]]) });
  const html = api.queueTaskHtml("assistant-2", row(["T-failed"]), jobs([["T-failed", { status: "failed", runId: "run_1" }]]));
  const m = /<button type="button" class="[^"]*pill-reattach[^"]*"[^>]*>exited<span class="pill-again"[^>]*>↻<\/span><\/button>/.exec(html);
  assert.ok(m, "the exited chip is a <button> carrying the ↻ glyph");
  const tag = m[0].slice(0, m[0].indexOf(">exited"));
  assert.ok(tag.includes('data-as-qreattach="T-failed"'), "the press names the thread it re-attaches");
  assert.ok(tag.includes('data-as-qown="assistant-2"'), "…the assistant whose queue this card is in");
  assert.ok(tag.includes('data-as-qid="7"'), "…and the task it sits on");
  assert.ok(/title="exited — re-attach this assistant: /.test(tag), "the hover text says what the press does");
  assert.ok(tag.includes('aria-label="exited — re-attach this assistant on T-failed"'), "the label names the thread");
  assert.ok(tag.includes("pill-notrunning") && tag.includes("is-failed"), "…and it is still the card's own red chip");
});

test("not-running is the same control; a live run and a finished one are not", () => {
  const { api } = build();
  const stopped = api.queueTaskHtml(
    "assistant-1",
    row(["T-gone", "T-live", "T-done"]),
    jobs([
      ["T-gone", { status: "cancelled" }],
      ["T-live", { status: "running" }],
      ["T-done", { status: "done" }],
    ]),
  );
  assert.ok(/<button type="button" class="pill pill-notrunning pill-reattach"[^>]*data-as-qreattach="T-gone"/.test(stopped), "a stopped run is the press");
  assert.ok(!/data-as-qreattach="T-live"/.test(stopped), "a LIVE run is a word, not a control — nothing to re-attach");
  assert.ok(/<span class="pill pill-running" title="[^"]*">running<\/span>/.test(stopped), "…and it is drawn as the plain pill");
  assert.ok(/<button type="button" class="pill pill-complete"[^>]*data-as-qopen="T-done"/.test(stopped), "COMPLETE still opens the card");
  assert.ok(!/data-as-qreattach="T-done"/.test(stopped), "…and is not the re-attach press");
});

test("the press clears the fence, starts ONE short turn, and the card names that run", async () => {
  const { api, posts, fetches, paints } = build({
    answers: [
      { ok: true, assistant: { id: "assistant-2" }, cleared: { admissions: [{ runId: "run_1" }, { runId: "run_3" }], wakes: [], watches: [] } },
      { job: { id: "job_9", runId: "run_new" }, assistant: { id: "assistant-2" } },
    ],
  });
  await api.queueReattach("assistant-2", "7");
  assert.deepEqual(posts.map((p) => p.route), ["/api/assistants/assistant-2/reset", "/api/assistant/say"], "the reset, then one turn");
  assert.deepEqual(posts[0].body, { dryRun: false, reason: "the reader pressed EXITED" }, "the call that worked tonight, verbatim");
  assert.deepEqual(posts[1].body, { text: "you were re-attached after an exit; continue", assistantId: "assistant-2" }, "the short turn, on the same assistant");
  assert.equal(api.REATTACH_TEXT, "you were re-attached after an exit; continue");
  assert.equal(
    api.queueReattachNoteHtml("assistant-2", "7"),
    '<div class="as-task-note is-good" role="status" title="cleared 2 wedged run(s), run run_new started">cleared 2 wedged run(s), run run_new started</div>',
    "the card says what happened, and which run it became",
  );
  assert.ok(fetches.includes("/api/jobs"), "the chip's word is re-read from /api/jobs");
  assert.ok(paints.includes("assistant-2:queue"), "…and the pane is repainted from it");
  assert.ok(!posts.some((p) => /restart/i.test(p.route)), "nothing restarts the panel or the gateway");
});

test("a healthy card says nothing was wedged and starts NO run", async () => {
  const { api, posts } = build({ answers: [{ ok: true, cleared: { admissions: [], wakes: [{ reason: "sweep" }], watches: [] } }] });
  await api.queueReattach("assistant-1", "3");
  assert.deepEqual(posts.map((p) => p.route), ["/api/assistants/assistant-1/reset"], "one reset — and no /say at all");
  const note = api.queueReattachNoteHtml("assistant-1", "3");
  assert.ok(note.includes("nothing was wedged"), "the no-op is said out loud");
  assert.ok(note.includes("no run was started"), "…including the part the reader needs: nothing started");
  assert.ok(note.includes("1 queued wake(s)"), "what the reset DID drop is said too, not hidden behind the headline");
  assert.ok(note.includes("is-info"), "…painted as the honest no-op, not as a failure");
});

test("a refusal is printed verbatim, and nothing is started", async () => {
  const refusal =
    "not reset — Assistant #1 has a run still executing (run_1 · started 2m ago). Wait for it or stop it on its card; a reset never touches an executing turn.";
  const { api, posts } = build({
    answers: [
      () => {
        const e = new Error(refusal);
        e.status = 409;
        throw e;
      },
    ],
  });
  await api.queueReattach("assistant-1", "4");
  assert.deepEqual(posts.map((p) => p.route), ["/api/assistants/assistant-1/reset"], "the wake is never reached");
  assert.equal(
    api.queueReattachNoteHtml("assistant-1", "4"),
    `<div class="as-task-note is-bad" role="status" title="${esc(refusal)}">${esc(refusal)}</div>`,
    "the route's own sentence, not a paraphrase",
  );
});

test("a 200 that is not ok is the incomplete verdict, and starts nothing", async () => {
  const error = "reset INCOMPLETE — 1 of 2 admission(s) cleared; the session is still fenced, so nothing local was cleared";
  const { api, posts } = build({ answers: [{ ok: false, verdict: "incomplete", cleared: { admissions: [{ runId: "run_1" }] }, error }] });
  await api.queueReattach("assistant-1", "5");
  assert.deepEqual(posts.map((p) => p.route), ["/api/assistants/assistant-1/reset"], "no wake after an incomplete reset");
  assert.ok(api.queueReattachNoteHtml("assistant-1", "5").includes(error), "the incomplete verdict is the answer");
});

test("a cleared fence with a refused wake never claims a run", async () => {
  const { api, posts } = build({
    answers: [
      { ok: true, cleared: { admissions: [{ runId: "run_1" }] } },
      () => {
        throw new Error("the assistant is switched off in settings");
      },
    ],
  });
  await api.queueReattach("assistant-1", "8");
  assert.equal(posts.length, 2, "the wake was attempted");
  const note = api.queueReattachNoteHtml("assistant-1", "8");
  assert.ok(note.includes("cleared 1 wedged run(s)"), "what happened is still said");
  assert.ok(note.includes("but the wake was refused — the assistant is switched off in settings"), "…and why nothing started");
  assert.ok(!note.includes("run  started") && !/run \S+ started/.test(note), "no run is claimed");
});

test("a second press while the first is out is ONE reset", async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const { api, posts } = build({ answers: [() => gate, { job: { runId: "run_new" } }] });
  const first = api.queueReattach("assistant-1", "6");
  await api.queueReattach("assistant-1", "6");
  assert.equal(posts.length, 1, "one reset on the wire — the second press sent nothing");
  assert.ok(api.queueReattachNoteHtml("assistant-1", "6").includes("one reset is already running"), "…and it says so");
  release({ ok: true, cleared: { admissions: [{ runId: "run_1" }] } });
  await first;
  assert.deepEqual(posts.map((p) => p.route), ["/api/assistants/assistant-1/reset", "/api/assistant/say"], "one reset, one wake");
  assert.ok(api.queueReattachNoteHtml("assistant-1", "6").includes("run run_new started"), "the flight's own answer is the card's");
});

test("another assistant is never touched", async () => {
  const { api, posts } = build({
    answers: [{ ok: true, cleared: { admissions: [{ runId: "run_9" }] } }, { job: { runId: "run_a2" } }],
  });
  await api.queueReattach("assistant-2", "1");
  assert.equal(posts[0].route, "/api/assistants/assistant-2/reset", "the card's own assistant is the only one reset");
  assert.equal(posts[1].body.assistantId, "assistant-2", "…and the only one woken");
  assert.ok(!posts.some((p) => p.route.includes("assistant-1") || p.body?.assistantId === "assistant-1"), "calls never reach #1");
});
