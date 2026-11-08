// The accept path: the press on a clarify answer or a permission, from the card to the gateway and back.
//
// Four defects, one shape. The boxes are drawn from a snapshot and a press POSTs, so between the press and the
// next repaint the box is still live: a second press (the other copy of the same question, or the click that
// follows the pointerup) spends a second POST, the gateway answers the first 200 and the second 409, and the
// loser's verdict was written over the decision the reader had just taken, and the transcript then read "not
// answered here" for a permission somebody did click. The same record can also outlive the gateway's own
// approval: `approval.request` is replayed on every reconnect, so a box with live buttons can sit over a request
// the run no longer holds, and the press can only be refused. And a question parked for an hour is re-asked by
// the sentry on its own clock, which knows nothing about the answer already on its way.
//
// The contract these cases pin, in one place:
//   1. the press greys and disables EVERY copy at once, and says it is sending;
//   2. one answer per request id, client and server: the second press is refused before it spends a POST;
//   3. an ok response clears both surfaces NOW (the board card and the assistant session), not on the next poll;
//   4. an approval the gateway no longer holds is dropped before a card offers it, and a drop never overwrites a
//      decision already recorded here;
//   5. the hourly re-ask does not re-publish a question whose answer is in flight.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { Jobs } from "../lib/jobs.js";
import { sliceBetween } from "../tools/panel-testkit.mjs";

const RUN = "run_4d1f9a2c7b0e";
const PROMPT = "p-accept-1";

// ── a page harness: the shipped source, sliced, with the DOM reduced to what it reads ────────────
// The page's own functions are what run here, not a rewrite of them. `document`, `state` and `apiFetch` are the
// only globals the sliced region touches, so each case hands in its own.
const pageSource = () => readFile(new URL("../public/app.js", import.meta.url), "utf8");
const settingsSource = () => readFile(new URL("../public/settings.js", import.meta.url), "utf8");

// The two appliers that clear the cards were cut out of app.js into settings.js (step 6 of the module
// map), so a slice of the page's own answer path brings the one function it calls across with it.
function declaredIn(source, name) {
  const at = source.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} is in public/settings.js`);
  return source.slice(at, source.indexOf("\nfunction ", at + 10));
}

function pageHarness(source, params, names) {
  const fn = new Function(...params, `${source}\nreturn { ${names.join(", ")} };`);
  return fn;
}

// One box on one surface. `dataset` is what the shipped selectors read; `closest` finds the box it belongs to.
// In the real DOM `data-question-for` sits on the box and `data-qrequest` sits on its buttons, which is why the
// two are on different objects here too.
function fakeCard({ kind, turnId, copy = "", requestId = "" }) {
  const controls = [{ tag: "button", disabled: false }, { tag: "input", disabled: false }, { tag: "textarea", disabled: false }];
  const warn = { textContent: "" };
  const note = { textContent: "", dataset: { qnote: "click a choice above" } };
  const flight = { hidden: true };
  const classes = new Set();
  const card = {
    dataset: { questionFor: `${turnId}${copy}` },
    classes,
    attrs: new Map(),
    classList: {
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name),
      add(name) {
        classes.add(name);
      },
    },
    setAttribute(k, v) {
      this.attrs.set(k, v);
    },
    removeAttribute(k) {
      this.attrs.delete(k);
    },
    querySelector(sel) {
      if (kind === "question") {
        if (sel === "[data-qwarn]") return warn;
        if (sel === "[data-qnote]") return note;
        return null;
      }
      if (sel === "[data-ta-flight]") return flight;
      return null;
    },
    querySelectorAll(sel) {
      if (kind === "question" && sel === "button, textarea, input") return controls;
      if (kind === "approval" && sel === "button") return controls;
      return [];
    },
  };
  const el = {
    dataset: { qrequest: requestId, approve: turnId, request: requestId },
    closest: (sel) => (sel === (kind === "question" ? ".turn-question" : ".turn-approval") ? card : null),
  };
  return { card, el, controls, warn, note, flight };
}

function fakeDocument(cards) {
  return {
    querySelectorAll(sel) {
      if (sel === "[data-qrequest]" || sel === "[data-approve]") return cards.map((c) => c.el);
      if (sel === "[data-question-for]") return cards.map((c) => c.card);
      return [];
    },
  };
}

// A POST that does not answer until the case releases it, so the in-flight window is real and observable.
function gatedFetch(body) {
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  const calls = [];
  const apiFetch = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
    await gate;
    return { ok: true, status: 200, json: async () => body };
  };
  return { apiFetch, calls, release: () => open() };
}

const jobsState = (rows) => ({ jobs: new Map(rows.map((j) => [j.id, j])), rwPending: new Map(), rwDecided: new Map() });
const tick = () => new Promise((resolve) => setImmediate(resolve));

// ── 1. the clarify card: one answer, every copy greyed, both surfaces cleared ───────────────────
test("one press answers a question once, greys every copy, and clears both surfaces on ok", async () => {
  const page = await pageSource();
  const settings = await settingsSource();
  const decls = sliceBetween(page, "const questionPicks = new Map();", "const RECOMMENDED_RE");
  const helpers = sliceBetween(page, "// Every card that draws this question", "function turnBlock(conv, turn, index");
  const build = pageHarness(
    `${decls}\n${helpers}\n${declaredIn(settings, "applyQuestionAnswered")}`,
    ["document", "state", "apiFetch", "renderConversation", "assistantSessionFor", "window", "paintHumanButton", "showBanner"],
    ["answerRunQuestion", "questionFlights"],
  );

  // The SAME question on two surfaces: the worktree session and the assistant session. Each turn has its own
  // card, and both carry the gateway's request id, which is what makes them one question.
  const surfaceA = fakeCard({ kind: "question", turnId: "job-1", copy: "", requestId: PROMPT });
  const surfaceB = fakeCard({ kind: "question", turnId: "job-2", copy: "", requestId: PROMPT });
  const state = jobsState([
    { id: "job-1", thread: "t-worktree", question: { requestId: PROMPT, question: "Ship it?" }, questionDone: null },
    { id: "job-2", thread: "t-assistant", question: { requestId: PROMPT, question: "Ship it?" }, questionDone: null },
  ]);
  const { apiFetch, calls, release } = gatedFetch({ ok: true, answer: "yes" });
  const rendered = [];
  const chats = [];
  const drawn = build(
    fakeDocument([surfaceA, surfaceB]),
    state,
    apiFetch,
    (thread) => rendered.push(thread),
    (thread) => thread === "t-assistant",
    { __assistantRenderChat: (thread) => chats.push(thread) },
    () => {},
    () => {},
  );

  const first = drawn.answerRunQuestion("job-1", "yes", PROMPT, null);
  // The second press is the click that follows the pointerup, on the other copy: it must be refused at once.
  const second = drawn.answerRunQuestion("job-2", "no", PROMPT, null);
  await second;

  assert.equal(calls.length, 1, "one request id, one POST: the second press never reaches the route");
  assert.deepEqual(calls[0].body, { id: "job-1", answer: "yes", requestId: PROMPT });
  for (const [name, surface] of [["worktree", surfaceA], ["assistant", surfaceB]]) {
    assert.ok(surface.card.classes.has("is-sending"), `${name}: the card says it is sending`);
    assert.equal(surface.card.attrs.get("aria-busy"), "true", `${name}: and is busy to a screen reader`);
    assert.ok(surface.controls.every((c) => c.disabled), `${name}: every control on it is disabled`);
    assert.equal(surface.note.textContent, "sending your answer, one moment...", `${name}: the note says what is happening`);
  }

  release();
  const out = await first;
  assert.equal(out, undefined, "the first press reports through the card, not a return value");
  assert.equal(drawn.questionFlights.size, 0, "the flight is released when the POST settles");
  for (const id of ["job-1", "job-2"]) {
    const j = state.jobs.get(id);
    assert.equal(j.question, null, `${id}: the box goes on ok`);
    assert.equal(j.questionDone.answer, "yes", `${id}: the decision is recorded`);
  }
  assert.deepEqual(rendered.sort(), ["t-assistant", "t-worktree"], "both surfaces are drawn again");
  assert.deepEqual(chats, ["t-assistant"], "and the assistant chat is cleared through its own renderer");
});

// ── 2. the permission card: the same flight, keyed on the gateway's request id ─────────────────
test("one press answers a permission once, greys every copy, and clears both copies on ok", async () => {
  const page = await pageSource();
  const settings = await settingsSource();
  const flights = sliceBetween(page, "const approvalFlights = new Map();", "// The permission box itself:");
  const sent = sliceBetween(page, "const approvalSent = new Map();", "async function answerApproval(");
  const handlers = sliceBetween(page, "async function answerRunApproval(", "// Take the decision away from a card");
  const build = pageHarness(
    `${flights}\n${sent}\n${handlers}\n${declaredIn(settings, "applyApprovalAnswered")}`,
    ["document", "state", "apiFetch", "renderConversation", "assistantSessionFor", "window", "paintHumanButton", "showBanner", "answerRemoteWrite", "closeApprovalCard"],
    ["answerRunApproval", "approvalFlights"],
  );

  // The board card and the pinned copy of the same turn: two boxes, one request id.
  const board = fakeCard({ kind: "approval", turnId: "job-1", copy: "", requestId: PROMPT });
  const pinned = fakeCard({ kind: "approval", turnId: "job-1", copy: "@pin", requestId: PROMPT });
  const state = jobsState([
    {
      id: "job-1",
      thread: "t-1",
      runId: RUN,
      approval: { requestId: PROMPT, command: "git push --force", choices: ["once", "deny"] },
      approvalDone: null,
    },
  ]);
  const { apiFetch, calls, release } = gatedFetch({ ok: true, choice: "once" });
  const rendered = [];
  const drawn = build(
    fakeDocument([board, pinned]),
    state,
    apiFetch,
    (thread) => rendered.push(thread),
    () => false,
    {},
    () => {},
    () => {},
    async () => {},
    () => {},
  );

  const press = (surface, choice) => {
    const btn = {
      dataset: { approve: "job-1", choice, request: PROMPT, until: "" },
      closest: (sel) => (sel === ".turn-approval" ? surface.card : null),
    };
    return drawn.answerRunApproval(btn);
  };
  const first = press(board, "once");
  const second = press(pinned, "deny");
  await second;

  assert.equal(calls.length, 1, "one permission, one POST: the pinned copy's press is refused");
  assert.equal(calls[0].body.choice, "once", "and the answer sent is the one the reader pressed first");
  for (const [name, surface] of [["board", board], ["pinned", pinned]]) {
    assert.ok(surface.card.classes.has("is-sending"), `${name}: the box says it is sending`);
    assert.ok(surface.controls.every((c) => c.disabled), `${name}: every choice on it is disabled`);
    assert.equal(surface.flight.hidden, false, `${name}: the flight line is shown`);
  }

  release();
  await first;
  const j = state.jobs.get("job-1");
  assert.equal(j.approval, null, "the box goes on ok");
  assert.deepEqual({ choice: j.approvalDone.choice, command: j.approvalDone.command }, { choice: "once", command: "git push --force" });
  assert.deepEqual(rendered, ["t-1"], "the card is drawn again without waiting for a snapshot");
});

// ── 3. the server fence: a second answer for the same prompt is refused, not spent ────────────
async function gatewayPanel(t, { run = {}, post = null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-accept-path-"));
  const jobs = new Jobs({
    config: { jobsFile: path.join(dir, "jobs.json"), apiServer: { url: "http://gateway.test", key: "k" }, defaultCwd: dir },
    onEvent: () => {},
    onLog: () => {},
  });
  const real = globalThis.fetch;
  const posts = [];
  const approvals = [];
  let releasePost = null;
  const gate = new Promise((resolve) => (releasePost = resolve));
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = String(init.method || "GET").toUpperCase();
    if (u.endsWith("/v1/capabilities")) return { ok: true, status: 200, json: async () => ({ features: {}, version: "test" }) };
    if (u.includes("/clarify") && method === "POST") {
      posts.push(JSON.parse(String(init.body || "{}")));
      if (post === "hold") {
        await gate;
        return { ok: true, status: 200, json: async () => ({ status: "resolved" }) };
      }
      return { ok: true, status: 200, json: async () => ({ status: "resolved" }) };
    }
    if (u.includes("/approval") && method === "POST") {
      approvals.push(JSON.parse(String(init.body || "{}")));
      if (post === "hold") {
        await gate;
        return { ok: true, status: 200, json: async () => ({ status: "resolved" }) };
      }
      return { ok: true, status: 200, json: async () => ({ status: "resolved" }) };
    }
    if (u.includes(`/v1/runs/${RUN}`)) return { ok: true, status: 200, json: async () => ({ run_id: RUN, status: "running", execution_generation: 1, pending_controls: [], ...run }) };
    throw new Error(`unexpected fetch ${u}`);
  };
  t.after(async () => {
    globalThis.fetch = real;
    clearInterval(jobs.approvalSweep);
    clearInterval(jobs.approvalReconcile);
    clearInterval(jobs.titleSweep);
    clearTimeout(jobs.persistTimer);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { jobs, posts, approvals, release: () => releasePost(), dir };
}

const questionCard = (over = {}) => ({
  id: "job-1",
  thread: "t-1",
  runId: RUN,
  status: "running",
  prompt: "ask once",
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  lines: [],
  question: {
    key: `clarify:job-1:${PROMPT}`,
    requestId: PROMPT,
    question: "Ship it?",
    choices: ["yes", "no"],
    at: new Date(Date.now() - 60_000).toISOString(),
    reasks: 0,
    lastAskedAt: null,
  },
  questionDone: null,
  ...over,
});

test("a second answer for the same request id is refused while the first is in flight", async (t) => {
  const { jobs, posts, release } = await gatewayPanel(t, { post: "hold" });
  jobs.jobs.set("job-1", questionCard());

  const first = jobs.answerQuestion("job-1", "yes", PROMPT);
  assert.equal(jobs.questionAnswerInFlight("job-1", PROMPT), true, "the flight is visible before the POST is even sent");
  const second = await jobs.answerQuestion("job-1", "no", PROMPT);

  assert.equal(second.ok, false, "the second press changes nothing");
  assert.equal(second.code, "answer_in_flight");
  assert.match(second.error, /already on its way/);
  await tick();
  assert.equal(posts.length, 1, "and spends no second POST");

  release();
  assert.equal((await first).ok, true);
  assert.equal(jobs.questionAnswerInFlight("job-1", PROMPT), false, "the flight is released in `finally`");
  assert.equal(jobs.jobs.get("job-1").questionDone.answer, "yes");
});

test("the same fence serves a permission, and a refusal leaves it answerable again", async (t) => {
  const { jobs, approvals, release } = await gatewayPanel(t, { post: "hold" });
  const card = {
    id: "job-1",
    thread: "t-1",
    runId: RUN,
    status: "running",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    lines: [],
    approval: {
      requestId: PROMPT,
      command: "git push --force",
      choices: ["once", "deny"],
      deadline: Date.now() + 120_000,
      at: new Date().toISOString(),
    },
    approvalDone: null,
  };
  jobs.jobs.set("job-1", card);

  const first = jobs.approve("job-1", "once", PROMPT);
  const second = await jobs.approve("job-1", "deny", PROMPT);
  assert.equal(second.code, "answer_in_flight", "the second press is refused by the panel, not by a 409 from the gateway");
  await tick();
  assert.equal(approvals.length, 1, "only the first press spent a POST on the gateway");

  release();
  assert.equal((await first).ok, true);
  assert.equal(card.approval, null);
  assert.equal(card.approvalDone.choice, "once", "the decision the reader did take is the one recorded");
});

// ── 4. the phantom approval: reconciled before it is offered, and never over a decision ────────
const approvalCard = (over = {}) => ({
  id: "job-1",
  thread: "t-1",
  runId: RUN,
  status: "running",
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  lines: [],
  approval: {
    requestId: PROMPT,
    command: "git push --force",
    choices: ["once", "deny"],
    deadline: Date.now() + 300_000,
    timeoutSeconds: 600,
    at: new Date().toISOString(),
  },
  approvalDone: null,
  ...over,
});

test("an approval the run no longer holds is dropped, and a decision already taken stands", async (t) => {
  const { jobs } = await gatewayPanel(t, { run: { pending_controls: [] } });
  jobs.jobs.set("job-1", approvalCard());

  assert.equal(jobs.summary(jobs.get("job-1")).approval.answerable, true, "a fresh request is offered while nothing says otherwise");

  await jobs.reconcileApprovals(Date.now());
  const card = jobs.get("job-1");
  assert.equal(card.approval, null, "the box is gone before the next card is drawn");
  assert.equal(card.approvalDone.expired, true, "and the record says nothing was decided here");
  assert.equal(jobs.summary(card).approval, null, "no phantom is offered by the summary");

  // The same reconcile, on a card whose decision was already taken here: the BOX goes, the decision does not.
  const decided = approvalCard({ approvalDone: { choice: "once", command: "git push --force", at: new Date().toISOString() } });
  jobs.jobs.set("job-2", decided);
  await jobs.reconcileApprovals(Date.now() + 10_000);
  assert.equal(jobs.get("job-2").approval, null);
  assert.equal(jobs.get("job-2").approvalDone.choice, "once", "a late duplicate cannot turn 'approved once' into 'not answered here'");
});

test("an approval the run still holds stays offered, and one this panel cannot send is drawn without choices", async (t) => {
  const { jobs } = await gatewayPanel(t, {
    run: { pending_controls: [{ kind: "approval", prompt_id: PROMPT, command: "git push --force", execution_generation: 1 }] },
  });
  jobs.jobs.set("job-1", approvalCard());
  await jobs.reconcileApprovals(Date.now());
  assert.ok(jobs.get("job-1").approval, "a request the gateway still lists is not dropped");
  assert.equal(jobs.summary(jobs.get("job-1")).approval.answerable, true);

  // No run to post to, and no permitted choice: both are drawn as the note, never as buttons.
  jobs.jobs.set("job-2", approvalCard({ id: "job-2", runId: null }));
  assert.equal(jobs.summary(jobs.get("job-2")).approval.answerable, false, "a turn with no run cannot be answered here");
  jobs.jobs.set("job-3", approvalCard({ id: "job-3", approval: { ...approvalCard().approval, choices: [] } }));
  assert.equal(jobs.summary(jobs.get("job-3")).approval.answerable, false, "a record with no allowed choice has nothing to send");
});

// ── 5. the re-ask: a question being answered is not a question nobody answered ─────────────────
test("the hourly re-ask is not published while the answer is in flight", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-accept-reask-"));
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  let clock = Date.now();
  const asked = [];
  const card = questionCard();
  card.question.at = new Date(clock - 2 * 60 * 60_000).toISOString();
  let answering = true;
  const stub = {
    list: () => [card],
    questionAnswerInFlight: () => answering,
    reaskQuestion: (id, rid) => {
      asked.push([id, rid]);
      card.question.reasks = (Number(card.question.reasks) || 0) + 1;
      return card.question;
    },
  };
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile },
    jobs: stub,
    getProjects: () => [],
    onLog: () => {},
    now: () => clock,
  });
  t.after(async () => {
    clearTimeout(assistant.timer);
    clearTimeout(assistant.wakeTimer);
    clearTimeout(assistant.persistTimer);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  assistant.evaluate([card], clock);
  assert.equal(asked.length, 0, "an answer on its way is not a silent reader");
  assert.equal(card.question.reasks, 0, "and the count on the question does not move");
  assert.equal(assistant.alerts.filter((a) => a.rule === "question").length, 1, "the question itself is still one alert");

  // The answer failed and the box stayed up: the clock asks again as it always did.
  answering = false;
  clock += 5000;
  assistant.evaluate([card], clock);
  assert.deepEqual(asked, [["job-1", PROMPT]], "with nothing in flight, the re-ask resumes");
  assert.equal(card.question.reasks, 1);
});
