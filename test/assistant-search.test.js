// The assistant search: lib/assistant/search.js over a fixture store, and routes/assistant-search.js over that.
//
// WHAT THIS FILE IS FOR. The search reads three fields of a persisted turn - the prompt the assistant was given,
// the reply it ended on, and every console line - and the two things a reader can rely on are pinned here:
//
//   * a hit is in ONE of those three, and `scope: "input"` narrows it to what the reader typed;
//   * when the result cap bites, the reader's own input is kept FIRST, and the answer still reports how many
//     matched against how many it displayed. A cap that hid the thing he typed under a pile of tool lines would be
//     a cap that hides the answer.
//
// The escaping itself is test/turn-search.test.js's subject (the matcher both the page and the server compile);
// this file only proves the search engine refuses to throw on a bracket or a dot, which is the server-side half.
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SEARCH_LIMIT, SEARCH_LIMIT_MAX, normLimit, normScope, searchTurns } from "../lib/assistant/search.js";
import { SEARCH_PATH, createSearchRoutes } from "../routes/assistant-search.js";

const T1 = "2026-11-11T08:00:00.000Z";
const T2 = "2026-11-12T08:00:00.000Z";
const T3 = "2026-11-12T09:00:00.000Z";

// Three turns of one assistant thread, in the shape the job store keeps them: the summary carries the prompt, the
// record carries the reply and the console's lines.
const TURNS = [
  {
    id: "t1",
    thread: "panel-assistant",
    turn: 1,
    startedAt: T1,
    prompt: "hello there",
    finalMessage: "hi",
    lines: [],
  },
  {
    id: "t2",
    thread: "panel-assistant",
    turn: 2,
    startedAt: T2,
    prompt: "fix public/app.js [draft]",
    finalMessage: "done. see public/app.js",
    lines: [{ kind: "tool", text: "read public/app.js", at: 2 }],
  },
  {
    id: "t3",
    thread: "panel-assistant",
    turn: 3,
    startedAt: T3,
    prompt: "why did the sweeps pill go quiet",
    finalMessage: "The sweeps pill reads 0/30 because the sweep ran at 08:57.",
    lines: [
      { kind: "text", text: "looking at the sweeps route", at: 3 },
      { kind: "tool", text: "grep -n sweeps routes/assistant-queue.js", at: 3 },
    ],
  },
];

// What `Jobs.list()` and `Jobs.get()` answer, over the fixture: the summary drops the reply and the lines.
const store = (turns = TURNS) => ({
  summaries: turns.map((t) => ({ id: t.id, thread: t.thread, turn: t.turn, startedAt: t.startedAt, prompt: t.prompt })),
  records: (id) => turns.find((t) => t.id === id) || null,
});

const search = (query, over = {}) => searchTurns({ ...store(), query, ...over });

test("a hit is the prompt, the reply or a console line, and each says which", () => {
  const out = search("sweeps");
  assert.equal(out.matched, 4, "t3's prompt, its reply and its two console lines all say sweeps");
  assert.equal(out.displayed, 4);
  assert.equal(out.turns, 1, "all four hits belong to one turn");
  assert.deepEqual(new Set(out.hits.map((h) => h.field)), new Set(["input", "reply", "tool"]));
  // Every hit carries the one-line window it was found in, split so a row can mark the match without re-finding it.
  for (const hit of out.hits) {
    assert.equal(hit.id, "t3");
    assert.equal(hit.thread, "panel-assistant");
    assert.ok(hit.hit.length > 0, "a hit with an empty match cannot be marked");
  }
  const prompt = out.hits.find((h) => h.field === "input");
  assert.match(prompt.before + prompt.hit + prompt.after, /sweeps/);
  const tool = out.hits.filter((h) => h.field === "tool");
  assert.equal(tool.length, 2);
  assert.ok(tool.some((h) => h.kind === "text"), "a console text line is searched, not only tool calls");
  assert.ok(tool.every((h) => Number.isInteger(h.index)), "a line hit carries the index of its line");
});

test("scope input searches only what the reader typed", () => {
  const out = search("sweeps", { scope: "input" });
  assert.equal(out.scope, "input");
  assert.equal(out.matched, 1);
  assert.equal(out.hits[0].field, "input");
  // And the reply and the lines are still there for the default scope.
  assert.equal(search("sweeps").matched, 4);
});

test("the cap keeps the reader's own input first and still reports both numbers", () => {
  const out = search("sweeps", { limit: 2 });
  assert.equal(out.matched, 4, "every match is counted");
  assert.equal(out.displayed, 2, "the list holds only what the cap allows");
  assert.deepEqual(
    out.hits.map((h) => h.field),
    ["input", "reply"],
    "the two kept hits are the input and the reply, not a tool line",
  );
  // The newest of the same field comes first: two turns that both match, capped to one, keep the newer prompt.
  const capped = searchTurns({ ...store(), query: "public", limit: 1 });
  assert.equal(capped.displayed, 1);
  assert.equal(capped.matched > capped.displayed, true);
  assert.match(capped.hits[0].before + capped.hits[0].hit + capped.hits[0].after, /public/);
});

test("an input hit outranks a newer reply hit, which is the whole point of the preference", () => {
  const turns = [
    { id: "a", thread: "panel-assistant", turn: 1, startedAt: T1, prompt: "sweeps please", finalMessage: "ok", lines: [] },
    { id: "b", thread: "panel-assistant", turn: 2, startedAt: T3, prompt: "something else", finalMessage: "sweeps finished", lines: [] },
  ];
  const out = searchTurns({ ...store(turns), query: "sweeps", limit: 1 });
  assert.equal(out.matched, 2);
  assert.equal(out.displayed, 1);
  assert.equal(out.hits[0].id, "a", "the input from the older turn beats the newer reply");
  assert.equal(out.hits[0].field, "input");
});

test("a query for a bracket or a dot answers zero, never an exception", () => {
  // t1 holds neither a bracket nor a dot in any field the search reads.
  const plain = store([TURNS[0]]);
  assert.doesNotThrow(() => searchTurns({ ...plain, query: "[" }));
  assert.equal(searchTurns({ ...plain, query: "[" }).matched, 0);
  assert.doesNotThrow(() => searchTurns({ ...plain, query: "." }));
  assert.equal(searchTurns({ ...plain, query: "." }).matched, 0);
  // A partial wildcard pattern made of metacharacters is also a query, not a crash.
  assert.equal(searchTurns({ ...plain, query: "[(" }).matched, 0);
  assert.equal(searchTurns({ ...plain, query: "\\" }).matched, 0);
  // Where the bracket IS in the text, the same query finds it: escaping is not dropping.
  assert.equal(search("[").matched, 1);
  assert.equal(search("[").hits[0].field, "input");
});

test("* and ? are wildcards, and a plain query is a substring", () => {
  const star = search("public*js");
  assert.equal(star.wildcard, true);
  assert.equal(star.matched, 3, "the prompt, the reply and the tool line all hold public/app.js");
  assert.equal(search("public.app").matched, 0, "a dot is not any-character");
  assert.equal(search("blic/app").matched, 3, "a plain query is a substring, not a prefix");
  assert.equal(search("PUBLIC/APP").matched, 3, "case is not part of the query's meaning");
  assert.equal(search("hello?").matched, 1, "? is exactly one character");
});

test("the threads given bound the search, so a worker's turn cannot answer as the assistant's", () => {
  const turns = [
    ...TURNS,
    { id: "w1", thread: "worker-thread", turn: 1, startedAt: T3, prompt: "sweeps in a worker", finalMessage: "", lines: [] },
  ];
  assert.equal(searchTurns({ ...store(turns), query: "sweeps" }).matched, 5, "unbounded, the worker's turn is found");
  const bounded = searchTurns({ ...store(turns), query: "sweeps", threads: ["panel-assistant"] });
  assert.equal(bounded.matched, 4);
  assert.ok(bounded.hits.every((h) => h.thread === "panel-assistant"));
});

test("an empty query is an empty answer with both counts at zero", () => {
  for (const query of ["", "   ", null, undefined]) {
    const out = search(query);
    assert.equal(out.matched, 0);
    assert.equal(out.displayed, 0);
    assert.deepEqual(out.hits, []);
  }
});

test("scope and limit normalize, with the ceiling the route advertises", () => {
  assert.equal(normScope(undefined), "all");
  assert.equal(normScope("INPUT"), "input");
  assert.equal(normScope("everything"), "all");
  assert.equal(normLimit(undefined), DEFAULT_SEARCH_LIMIT);
  assert.equal(normLimit(0), DEFAULT_SEARCH_LIMIT);
  assert.equal(normLimit("7"), 7);
  assert.equal(normLimit(1000), SEARCH_LIMIT_MAX);
});

// ---- the route ----------------------------------------------------------------------------------------------

const sendTo = () => {
  const out = { status: null, body: null };
  out.send = (res, status, body) => {
    out.status = status;
    out.body = body;
  };
  return out;
};

const assistantOver = (turns = TURNS) => ({
  searchTurns: ({ query = "", scope, limit, assistantId = null } = {}) => {
    if (assistantId === "assistant-9") {
      const err = new Error("no assistant assistant-9");
      err.code = "assistant-unknown";
      throw err;
    }
    return { ...searchTurns({ ...store(turns), query, scope, limit }), assistantId };
  },
});

async function call({ path = SEARCH_PATH, query = "", method = "GET", turns = TURNS } = {}) {
  const res = sendTo();
  const handler = createSearchRoutes({ assistant: assistantOver(turns), sendJson: res.send });
  const url = new URL(`http://localhost${path}${query}`);
  const handled = await handler({ method, headers: {} }, res, path, url);
  return { handled, ...res };
}

test("the route answers query, scope, limit and both counts", async () => {
  const out = await call({ query: "?q=sweeps&limit=2" });
  assert.equal(out.handled, true);
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.query, "sweeps");
  assert.equal(out.body.scope, "all", "scope defaults to everything");
  assert.equal(out.body.limit, 2);
  assert.equal(out.body.matched, 4);
  assert.equal(out.body.displayed, 2);
  assert.equal(out.body.hits.length, 2);
});

test("the route carries the input scope and an assistant id through", async () => {
  const out = await call({ query: "?q=sweeps&scope=input&assistantId=assistant-1" });
  assert.equal(out.status, 200);
  assert.equal(out.body.scope, "input");
  assert.equal(out.body.assistantId, "assistant-1");
  assert.equal(out.body.matched, 1);
});

test("a missing query is a 400, and a bad scope or limit is refused rather than coerced", async () => {
  const missing = await call({ query: "" });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /q/);

  const blank = await call({ query: "?q=%20%20" });
  assert.equal(blank.status, 400);

  const scope = await call({ query: "?q=sweeps&scope=everything" });
  assert.equal(scope.status, 400);
  assert.match(scope.body.error, /scope/);

  const limit = await call({ query: "?q=sweeps&limit=lots" });
  assert.equal(limit.status, 400);
  assert.match(limit.body.error, /limit/);

  const zero = await call({ query: "?q=sweeps&limit=0" });
  assert.equal(zero.status, 400);
});

test("a limit over the ceiling is clamped and reported clamped", async () => {
  const out = await call({ query: "?q=sweeps&limit=9999" });
  assert.equal(out.status, 200);
  assert.equal(out.body.limit, SEARCH_LIMIT_MAX);
});

test("an assistant the panel does not hold is a 404, not empty results", async () => {
  const out = await call({ query: "?q=sweeps&assistantId=assistant-9" });
  assert.equal(out.status, 404);
  assert.match(out.body.error, /no assistant assistant-9/);
});

test("the route answers only its own path and only GET", async () => {
  const other = await call({ path: "/api/assistant/queue", query: "?q=sweeps" });
  assert.equal(other.handled, false);
  assert.equal(other.status, null);

  const post = await call({ method: "POST", query: "?q=sweeps" });
  assert.equal(post.handled, true);
  assert.equal(post.status, 405);
});

test("the factory refuses to be built without its two dependencies", () => {
  assert.throws(() => createSearchRoutes({}), /Assistant/);
  assert.throws(() => createSearchRoutes({ assistant: { searchTurns() {} } }), /sendJson/);
});
