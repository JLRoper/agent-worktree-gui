// THE COLLISIONS ROUTE. One read and three writes on `/api/collisions`:
//
//   GET  /api/collisions                 every record, its state (assistants | reader | ruled | superseded | absent),
//                                        and the evidence
//   POST /api/collisions {op:"sweep"}    look now, instead of waiting for the panel's own tick
//   POST /api/collisions {op:"ask", key} the reader saying "bring this one to me" - the third of the three conditions
//   POST /api/collisions {op:"rule", key, pick:"a"|"b"|"clear", note}
//                                        the reader's ruling: which side goes first. Stored AGAINST THE PAIR, so a
//                                        re-detected collision renders as already ruled, and broadcast to both
//                                        assistants as a queue row (routes/assistant-queue.js's own writer).
//
// WHY A RULING IS A WRITE AND AN ASK IS NOT A DECISION. The ask only moves the pair in front of the reader; it decides
// nothing and changes no work. The ruling decides who yields, so it goes through the book (the one durable record) and
// then through the queue, and the row the queue carries is what both assistants actually read on their next wake - a
// ruling that lived only in the panel's memory would be a decision nobody was told about.
//
// The file is deliberately thin: the book owns the records and the wording, and `fileRuling` is this composition
// root's own writer, so the route cannot invent a task, a state or an assistant.
import { COLLISION_STATES, stateOf } from "../lib/collisions.js";

export const COLLISIONS_PATH = "/api/collisions";

const pickOne = (body, ...names) => {
  for (const name of names) {
    if (body && body[name] !== undefined && body[name] !== null && String(body[name]).trim() !== "") return body[name];
  }
  return null;
};

export function createCollisionsRoutes({ book, getConfig = () => ({}), sweep = null, fileRuling = null, refresh = null, sendJson, readBody, authorised, log = () => {} }) {
  const view = () => {
    const state = book.state();
    // The count the Human button's collision switch reads is the READER's list, not every pair the panel knows about:
    // a pair still in the assistants' pass is not waiting on the reader. `total` is the whole book, for the tab.
    return { ...state, counts: state.byState, states: COLLISION_STATES };
  };
  return async function handle(req, res, { url } = {}) {
    const route = String(url?.pathname || req.url || "").split("?")[0].replace(/\/+$/, "") || "/";
    if (route !== COLLISIONS_PATH) {
      sendJson(res, 404, { error: `no such route: ${route}` });
      return true;
    }
    if (req.method === "GET") {
      sendJson(res, 200, view());
      return true;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: `${req.method} is not allowed on ${route}` });
      return true;
    }
    if (!authorised(req, (getConfig() || {}).token)) {
      sendJson(res, 403, { error: "bad or missing x-panel-token" });
      return true;
    }
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, 400, { error: String((err && err.message) || err) });
      return true;
    }
    const op = String(pickOne(body, "op", "action") || "").trim().toLowerCase();
    const key = String(pickOne(body, "key", "pairKey", "pair") || "").trim();
    try {
      if (op === "sweep") {
        const report = typeof sweep === "function" ? sweep({ why: "asked" }) : null;
        sendJson(res, 200, {
          ok: true,
          say: report
            ? `swept ${report.pairs} pair${report.pairs === 1 ? "" : "s"}, settled ${(report.settled || []).length} automatically, filed ${report.filed.length}, handed over ${report.escalated.length}`
            : "no sweep is wired",
          report,
          state: view(),
        });
        return true;
      }
      if (!key) {
        sendJson(res, 400, { error: "this write needs the pair `key` it is about (GET /api/collisions lists them)" });
        return true;
      }
      const rec = book.get(key);
      if (!rec) {
        sendJson(res, 404, { error: `no collision is recorded for ${key}` });
        return true;
      }
      if (op === "ask") {
        const asked = book.ask(key, { by: "reader" });
        const saved = book.save();
        if (typeof refresh === "function") refresh();
        log(`collisions: the reader asked for ${key}`);
        sendJson(res, 200, {
          ok: true,
          say: `brought to you: ${rec.a?.name || "one tree"} and ${rec.b?.name || rec.bTarget || "the other"} on ${rec.files.length} shared file${rec.files.length === 1 ? "" : "s"}`,
          record: asked ? { ...asked, state: stateOf(asked) } : null,
          error: saved.ok ? null : saved.error,
          state: view(),
        });
        return true;
      }
      if (op === "rule") {
        const pick = String(pickOne(body, "pick", "priority", "first", "side") || "").trim().toLowerCase();
        const out = book.rule(key, { pick, note: pickOne(body, "note", "say", "why") || "", by: "reader" });
        if (!out.ok) {
          sendJson(res, 400, { error: out.error });
          return true;
        }
        const saved = book.save();
        if (pick !== "clear" && typeof fileRuling === "function") {
          try {
            fileRuling(out.record);
          } catch (err) {
            log(`collisions: could not broadcast the ruling on ${key} (${String((err && err.message) || err)})`);
          }
        }
        if (typeof refresh === "function") refresh();
        log(`collisions: the reader ruled ${key} (${pick})`);
        sendJson(res, 200, {
          ok: true,
          say: out.say,
          record: { ...out.record, state: stateOf(out.record) },
          error: saved.ok ? null : saved.error,
          state: view(),
        });
        return true;
      }
      if (op === "forget") {
        // A reported note whose target named no row can be dropped once the reader has read it: there is no pair left
        // to keep. A DETECTED pair is never forgotten this way - it comes back on the next sweep, and a ruling is the
        // way to settle one.
        const out = book.forget(key);
        if (!out.ok) {
          sendJson(res, 409, { error: out.error });
          return true;
        }
        if (typeof refresh === "function") refresh();
        sendJson(res, 200, { ok: true, say: out.say, error: out.error, state: view() });
        return true;
      }
      sendJson(res, 400, { error: `unknown op "${op}" - one of sweep, ask, rule, forget` });
      return true;
    } catch (err) {
      sendJson(res, 500, { error: String((err && err.message) || err) });
      return true;
    }
  };
}
