// The Hot Agent search: lib/hot-agent/search.js over a fixture store, routes/hot-agent-search.js over that, and the
// one setting both ends read (public/core/hot-agent-list.js).
//
// WHAT THIS FILE IS FOR. The bar promises a narrow thing - "the turns the READER wrote to worker agents" - and every
// way that promise can be broken is a fixture below:
//
//   * an ASSISTANT manager turn is not the reader's writing (`assistant: true`);
//   * a turn the assistant started on a worker's behalf is not either (`origin.kind` assistant-message/reply);
//   * an AGENT's reply is never indexed at all: a fixture whose finalMessage matches and whose prompt does not must
//     not appear, which is what "never an agent reply" means in this store;
//   * a reply the READER typed into a worker's card IS the reader's writing and stays in;
//   * the order is newest first, an equal clock is broken deterministically, and the empty box lists the newest N;
//   * `matched` counts every answer while `displayed` is the limit, so a count cannot claim the list is complete;
//   * the setting's default is 20 and its range is 1..100, on the server and in the browser alike.
//
// The matcher's own escaping is test/turn-search.test.js's subject (the file both searches compile); this file proves
// the engine refuses to throw on a bracket, which is the server-side half of that promise.
import assert from "node:assert/strict";
import test from "node:test";
import "../public/core/hot-agent-list.js";
import { HOT_AGENT_DEFAULT_LIMIT, HOT_AGENT_LIMIT_MAX, isReaderWorkerTurn, searchHotAgents } from "../lib/hot-agent/search.js";
import { HOT_AGENT_SEARCH_PATH, createHotAgentSearchRoutes } from "../routes/hot-agent-search.js";

const hotAgentList = globalThis.wtHotAgentList;

const T = (minutes) => new Date(Date.UTC(2026, 10, 18, 9, minutes, 0)).toISOString();

// A worker turn in the shape Jobs.list() answers it, copied from the store's own records: `thread`, `turn`, the
// clock, `prompt`, the `tree` measurement the turn wrote (`{path, branch, ...}`) and `projectPath` - which for a
// worktree job IS the worktree. `worktree`/`worktreePath` are the older fields and are null in the live store.
const MANAGER = "panel-assistant";
// A repo root with no drive letter: the labels only ever read the ./worktrees/<name> leaf and the segment before it.
const REPO = "/repos/agent-worktree-gui";
const turn = (id, minutes, prompt, extra = {}) => ({
  id,
  thread: `wtgui-${id}`,
  turn: 1,
  startedAt: T(minutes),
  prompt,
  assistant: false,
  reply: false,
  origin: null,
  tree: { path: `${REPO}/.worktrees/tree-${id}`, branch: `wtgui/tree-${id}`, exists: true },
  projectPath: `${REPO}/.worktrees/tree-${id}`,
  ownerPath: `${REPO}/.worktrees/tree-${id}`,
  ...extra,
});

const TURNS = [
  turn("a", 1, "write the saffron parser"),
  turn("b", 2, "run the saffron tests, then read public/app.js"),
  // The assistant's own turn: its prompt matches, its id must not appear.
  turn("c", 3, "saffron digest for the board", { assistant: true }),
  // The manager STARTED this one on a worker's behalf - the store's own word for it is `assistant-spawn`.
  turn("d", 4, "saffron: steer the worker", { origin: { kind: "assistant-spawn" } }),
  turn("e", 5, "the reader's reply to a worker", { reply: true, origin: { kind: "clarify-fresh" } }),
  // An agent's REPLY matched, the prompt did not: the row must not appear with the reply as its text.
  turn("f", 6, "unrelated prompt", { finalMessage: "saffron is done" }),
  // Two turns on one clock: the tie must not shuffle between reads.
  turn("g", 7, "saffron in the tie, first written"),
  turn("h", 7, "saffron in the tie, second written", { turn: 2 }),
  // A reader turn typed on the MANAGER's card: written to the manager, never to a worker.
  turn("m", 9, "saffron, but this one is on the manager's card", { thread: MANAGER, reply: true }),
  // The manager woke a worker: `assistant-wake` is the manager's writing too.
  turn("w", 10, "saffron: wake for the queue", { origin: { kind: "assistant-wake", reason: "[queue]" } }),
];
const MANAGER_THREADS = [MANAGER];

const RECORDS = new Map([
  ["f", { ...TURNS[5] }],
  // The store's record carries the prompt for a turn whose summary dropped it (a trimmed card): the search reads it.
  ["i", { id: "i", thread: "wtgui-i", turn: 1, startedAt: T(8), prompt: "saffron only in the record" }],
]);
const records = (id) => RECORDS.get(id) || null;

const search = (options = {}) => searchHotAgents({ summaries: TURNS, records, assistantThreads: MANAGER_THREADS, ...options });

test("only the reader's turns to worker agents are eligible", () => {
  assert.equal(isReaderWorkerTurn(TURNS[0]), true, "a plain worker turn is the reader's");
  assert.equal(isReaderWorkerTurn(TURNS[2]), false, "an assistant manager turn is never the reader's");
  assert.equal(isReaderWorkerTurn(TURNS[3]), false, "a turn the manager started (assistant-spawn) is not the reader's");
  assert.equal(isReaderWorkerTurn(TURNS[4]), true, "a reply the reader typed is still the reader's turn");
  assert.equal(isReaderWorkerTurn(TURNS[5]), true, "the reply fixture is eligible - it is its MATCH that must fail");
  assert.equal(isReaderWorkerTurn(TURNS[8], MANAGER_THREADS), false, "a turn on the manager's own card is written to the manager");
  assert.equal(isReaderWorkerTurn(TURNS[8]), true, "without the manager's threads there is nothing to compare it with");
  assert.equal(isReaderWorkerTurn(TURNS[9]), false, "an assistant-wake is the manager's writing");
  assert.equal(isReaderWorkerTurn(null), false);
  assert.equal(isReaderWorkerTurn({}), true, "a summary with no flags is a reader turn: the flags are the refusal");
});

test("a filter matches the prompt and nothing else", () => {
  const out = search({ query: "saffron" });
  const ids = out.hits.map((hit) => hit.id);
  assert.ok(ids.includes("a"));
  assert.ok(ids.includes("b"));
  assert.ok(!ids.includes("c"), "an assistant manager turn must not be listed");
  assert.ok(!ids.includes("d"), "a turn the manager started must not be listed");
  assert.ok(!ids.includes("m"), "a turn on the manager's card must not be listed");
  assert.ok(!ids.includes("w"), "a wake the manager sent must not be listed");
  assert.ok(!ids.includes("f"), "an agent's reply is not searchable: its prompt does not match");
  assert.equal(out.matched, 4, "a, b, g and h match; c, d and f are refused, and e carries no filter text");
});

test("newest first, and an equal clock is broken deterministically", () => {
  const out = search({ query: "saffron" });
  const stamps = out.hits.map((hit) => hit.at);
  assert.deepEqual([...stamps].sort((x, y) => y - x), stamps, "the clock never goes backwards down the list");
  // The tie: h (turn 2) is the later turn of the same clock, so it sits above g.
  const tie = out.hits.filter((hit) => hit.id === "g" || hit.id === "h").map((hit) => hit.id);
  assert.deepEqual(tie, ["h", "g"]);
  // ...and a second read of the same store answers the same order, which is what makes a Down walk repeatable.
  assert.deepEqual(search({ query: "saffron" }).hits.map((hit) => hit.id), out.hits.map((hit) => hit.id));
});

test("an empty box lists the most recent turns, and the cap reports both numbers", () => {
  const all = search({});
  assert.equal(all.query, "");
  assert.equal(all.matched, 6, "a, b, e, f, g and h are all eligible with no filter");
  assert.equal(all.displayed, 6);
  const capped = search({ limit: 3 });
  assert.equal(capped.limit, 3);
  assert.equal(capped.matched, 6, "matched counts every answer, not the slice");
  assert.equal(capped.displayed, 3);
  assert.deepEqual(capped.hits.map((hit) => hit.id), ["h", "g", "f"], "the newest three");
});

test("the limit is the shared default, clamped, and refuses to be zero", () => {
  assert.equal(HOT_AGENT_DEFAULT_LIMIT, 20);
  assert.equal(search({}).limit, 20);
  assert.equal(search({ limit: 500 }).limit, HOT_AGENT_LIMIT_MAX);
  assert.equal(search({ limit: 0 }).limit, 1, "norm() clamps rather than returning nothing");
  assert.equal(search({ limit: "abc" }).limit, HOT_AGENT_DEFAULT_LIMIT);
});

test("a row names the agent, its thread and the project tree", () => {
  const out = search({ query: "saffron" });
  const row = out.hits.find((hit) => hit.id === "b");
  assert.equal(row.thread, "wtgui-b");
  assert.equal(row.agent, "wtgui-b", "no label and no title: the thread is the honest name");
  assert.equal(row.tree, "tree-b", "the tree is the worktree the turn ran in");
  assert.equal(row.project, "agent-worktree-gui");
  assert.match(row.treePath, /[\/]tree-b$/);
  assert.equal(row.hit.toLowerCase(), "saffron", "the match is split out so the row can mark it");
  assert.ok(row.before.includes("run the"));
  // A label, when the panel has one, names the agent instead.
  const labelled = searchHotAgents({ summaries: [{ ...TURNS[0], label: "saffron agent" }], records, query: "" });
  assert.equal(labelled.hits[0].agent, "saffron agent");
  const titled = searchHotAgents({ summaries: [{ ...TURNS[0], title: "Titled session" }], records, query: "" });
  assert.equal(titled.hits[0].agent, "Titled session", "the session's own title beats the panel's label");
});

test("a prompt only the record holds is still searched", () => {
  const out = searchHotAgents({ summaries: [{ id: "i", thread: "wtgui-i", turn: 1, startedAt: T(8), prompt: "" }], records, query: "saffron" });
  assert.equal(out.matched, 1, "Jobs.get() answered a prompt the summary had dropped");
  assert.equal(out.hits[0].id, "i");
});

test("a bracket is a literal, not a crash", () => {
  const out = search({ query: "public/app.js [draft]" });
  assert.equal(out.matched, 0);
  assert.doesNotThrow(() => search({ query: "[" }));
  assert.doesNotThrow(() => search({ query: ".*" }));
});

test("a wildcard is a wildcard", () => {
  const out = search({ query: "saff*parser" });
  assert.deepEqual(out.hits.map((hit) => hit.id), ["a"]);
});

// ---- the route -------------------------------------------------------------------------------
function store(turns) {
  return { list: () => turns, get: (id) => RECORDS.get(id) || turns.find((t) => t.id === id) || null };
}

async function call({ path = HOT_AGENT_SEARCH_PATH, query = "", method = "GET", turns = TURNS, jobs = store(turns), assistant = { assistants: [{ id: "assistant-1", threadId: MANAGER }] } } = {}) {
  const res = {
    status: 0,
    body: null,
    send(status, body) {
      this.status = status;
      this.body = body;
    },
  };
  const sendJson = (r, status, body) => {
    r.status = status;
    r.body = body;
  };
  const handler = createHotAgentSearchRoutes({ jobs, assistant, sendJson });
  const url = new URL(`http://localhost${path}${query}`);
  const handled = await handler({ method, headers: {}, url: reqUrl(path, query) }, res, path, url);
  return { handled, ...res };
}

// The handler takes the query off the url it is handed; this is the same object the server builds.
function reqUrl(path, query) {
  return new URL(`http://localhost${path}${query}`);
}

test("the route answers an empty box as a real read", async () => {
  const out = await call();
  assert.equal(out.handled, true);
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.query, "");
  assert.equal(out.body.limit, HOT_AGENT_DEFAULT_LIMIT);
  assert.equal(out.body.matched, 6);
  assert.equal(out.body.displayed, 6);
  assert.ok(Array.isArray(out.body.hits));
});

test("the route carries q and limit through, and counts both numbers", async () => {
  const out = await call({ query: "?q=saffron&limit=2" });
  assert.equal(out.status, 200);
  assert.equal(out.body.query, "saffron");
  assert.equal(out.body.limit, 2);
  assert.equal(out.body.matched, 4);
  assert.equal(out.body.displayed, 2);
  assert.equal(out.body.hits.length, 2);
});

test("the route hands the manager's threads in, so a manager-card turn is refused there too", async () => {
  const withManager = await call({ query: "?q=saffron" });
  assert.ok(!withManager.body.hits.some((hit) => hit.thread === MANAGER), "the manager's card is never a row");
  // Without the Assistant instance there is no thread set: the module cannot tell, and must not pretend it can.
  const blind = await call({ query: "?q=saffron", assistant: null });
  assert.ok(blind.body.hits.some((hit) => hit.thread === MANAGER), "no assistant, no thread set - the flag still governs");
});

test("a limit outside the range is refused, not coerced", async () => {
  for (const bad of ["0", "-1", "101", "2.5"]) {
    const out = await call({ query: `?limit=${bad}` });
    assert.equal(out.status, 400, `limit=${bad} must be a 400`);
    assert.match(out.body.error, /1 to 100/);
  }
  assert.equal((await call({ query: "?limit=100" })).status, 200);
});

test("the route owns its path and refuses every other method", async () => {
  const other = await call({ path: "/api/jobs" });
  assert.equal(other.handled, false, "a path this module does not own is not handled");
  const post = await call({ method: "POST" });
  assert.equal(post.handled, true);
  assert.equal(post.status, 405);
});

test("a store that throws is a 500, not a dropped request", async () => {
  const jobs = {
    list() {
      throw new Error("store is unreadable");
    },
    get() {
      return null;
    },
  };
  const out = await call({ jobs });
  assert.equal(out.status, 500);
  assert.match(out.body.error, /store is unreadable/);
});

// ---- the setting -----------------------------------------------------------------------------
function storageOf(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    map,
  };
}

test("the setting's default is 20 and its range is 1 to 100", () => {
  assert.equal(hotAgentList.DEFAULT, 20);
  assert.equal(hotAgentList.MAX, 100);
  assert.equal(hotAgentList.norm(null), 20);
  assert.equal(hotAgentList.norm(""), 20);
  assert.equal(hotAgentList.norm("  "), 20);
  assert.equal(hotAgentList.norm("abc"), 20);
  assert.equal(hotAgentList.norm(0), 1);
  assert.equal(hotAgentList.norm(-5), 1);
  assert.equal(hotAgentList.norm(1e6), 100);
  assert.equal(hotAgentList.norm(12.6), 13, "a fractional value is rounded, not refused");
});

test("the setting reads this browser's value and writes what it stored", () => {
  const store = storageOf();
  assert.equal(hotAgentList.read(store), 20, "nothing saved yet");
  assert.equal(hotAgentList.write(store, 35), 35);
  assert.equal(store.map.get(hotAgentList.KEY), "35");
  assert.equal(hotAgentList.read(store), 35);
  assert.equal(hotAgentList.write(store, 500), 100, "a write clamps and answers the clamped value");
  assert.equal(hotAgentList.read(storageOf({ [hotAgentList.KEY]: "junk" })), 20);
  assert.equal(hotAgentList.read(null), 20, "a caller with no storage answers the default");
  // A browser that refuses storage must not throw out of a read or a write.
  const refusing = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
  };
  assert.equal(hotAgentList.read(refusing), 20);
  assert.equal(hotAgentList.write(refusing, 30), 30);
});
