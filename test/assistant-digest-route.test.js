// The digest tail's two GETs, driven through the module the way server.js mounts it.
//
// The routes are a READER and nothing else: the transcript is appended by every assistant turn, and the read tool
// answers a pointer with the sending turn. This file pins the wire: the pointer is required, a turn the store does
// not hold is a 404 (not an empty 200), a foreign thread is the module's own refusal carried through, and the
// transcript answer says which assistant it is and how full its cap is.
import assert from "node:assert/strict";
import test from "node:test";
import { DIGEST_PATH, READ_PATH, createDigestRoutes } from "../routes/assistant-digest.js";

const request = (method = "GET") => ({ method, headers: {} });
const answer = () => {
  const out = { status: null, body: null };
  // server.js's own signature: sendJson(res, status, body).
  out.send = (r, status, body) => {
    out.status = status;
    out.body = body;
  };
  return out;
};

const assistant = (over = {}) => ({
  readTurn: (pointer, { calls }) => {
    if (pointer === "assistant-1/t-old/aaaa1111") {
      return { ok: true, pointer: { assistant: "assistant-1", thread: "t-old", turn: "aaaa1111" }, turn: { id: "aaaa1111", thread: "t-old" }, finalMessage: "the older turn", calls: [{ tool: "terminal", input: "npm test", at: 1 }].slice(0, calls) };
    }
    if (pointer === "assistant-1/t-new/aaaa1111") return { ok: false, pointer: { assistant: "assistant-1", thread: "t-new", turn: "aaaa1111" }, why: "turn aaaa1111 ran on t-old, not t-new" };
    return { ok: false, pointer: { assistant: null, thread: null, turn: "nope" }, why: "no turn nope in the job store" };
  },
  digestTail: () => [{ version: 1, at: "2026-11-09T10:00:00.000Z", items: [], text: "Board tail 11-09T10:00:00Z | 0 changed, 0 same | prev none" }],
  ...over,
});

async function call(route, { method = "GET", query = "", token = "secret" } = {}) {
  const res = answer();
  const handler = createDigestRoutes({ assistant: assistant(), config: { token: "secret" }, sendJson: res.send, authorised: (req, t) => req.headers["x-panel-token"] === t });
  const req = { ...request(method), headers: { "x-panel-token": token } };
  const url = new URL(`http://localhost${route}${query}`);
  const handled = await handler(req, res, route, url);
  return { handled, ...res };
}

test("the read tool answers the pointer it is given", async () => {
  const out = await call(READ_PATH, { query: "?pointer=assistant-1/t-old/aaaa1111&calls=1" });
  assert.equal(out.handled, true);
  assert.equal(out.status, 200);
  assert.equal(out.body.finalMessage, "the older turn");
  assert.equal(out.body.calls.length, 1);
});

test("a pointer the store does not hold is a 404, not an empty 200", async () => {
  const out = await call(READ_PATH, { query: "?pointer=assistant-1/t-old/nope" });
  assert.equal(out.status, 404);
  assert.equal(out.body.ok, false);
  assert.match(out.body.why, /no turn nope/);
});

test("a pointer whose thread is not the turn's own carries the refusal", async () => {
  const out = await call(READ_PATH, { query: "?pointer=assistant-1/t-new/aaaa1111" });
  assert.equal(out.status, 404);
  assert.match(out.body.why, /ran on t-old/);
});

test("the pointer is required, and the route refuses a caller without the token", async () => {
  const missing = await call(READ_PATH);
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /pointer is required/);

  const denied = await call(READ_PATH, { query: "?pointer=assistant-1/t-old/aaaa1111", token: "wrong" });
  assert.equal(denied.status, 403);

  const post = await call(READ_PATH, { method: "POST" });
  assert.equal(post.status, 405);
});

test("the transcript read names the assistant and its cap", async () => {
  const out = await call(DIGEST_PATH, { query: "?assistantId=assistant-1" });
  assert.equal(out.status, 200);
  assert.equal(out.body.assistantId, "assistant-1");
  assert.equal(out.body.count, 1);
  assert.equal(out.body.cap > 0, true);
  assert.equal(out.body.last.text.startsWith("Board tail "), true);
});

test("a path that is not the module's is left for the rest of the handler", async () => {
  const out = await call("/api/assistant/say");
  assert.equal(out.handled, false);
});
