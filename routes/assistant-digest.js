// The digest tail's read side: the transcript, and the READ TOOL behind a row's pointer.
//
//   GET /api/assistant/digest?assistantId=<id>       the transcript, oldest first, with its size
//   GET /api/assistant/read?pointer=<a>/<t>/<turn>   that sending turn's final message and last few tool calls
//
// The digest is appended by every assistant turn (lib/assistant.js `say`), so this module is a reader and nothing
// else: it never writes, never appends and never advances the comparison cursor. That is deliberate - a page that
// polled the tail must not change what the next turn says.
//
// The READ route is the one the digest's rows point at. It answers the turn the pointer NAMES, not the newest turn of
// the thread (`lib/assistant/digest-tail.js` owns that rule, and its test pins it), which is what makes a pointer
// worth carrying in the first place.
import { DIGEST_TAIL_CAP } from "../lib/assistant/digest-tail.js";

export const DIGEST_PATH = "/api/assistant/digest";
export const READ_PATH = "/api/assistant/read";

/** The one line the digest route says about a transcript that has been capped, so a reader is never told a tail is
 *  the whole story when it is not. */
const capNote = (count, cap) => (count >= cap ? `the transcript keeps its newest ${cap} messages` : null);

export function createDigestRoutes({ assistant, config = {}, sendJson, authorised } = {}) {
  if (!assistant) throw new Error("createDigestRoutes needs the Assistant instance");
  if (typeof sendJson !== "function" || typeof authorised !== "function") {
    throw new Error("createDigestRoutes needs sendJson and authorised from the server's transport");
  }
  return async function digestRoutes(req, res, route, url) {
    if (route !== DIGEST_PATH && route !== READ_PATH) return false;
    if (req.method !== "GET") {
      sendJson(res, 405, { error: `${req.method} is not allowed on ${route}` });
      return true;
    }
    if (!authorised(req, config.token)) {
      sendJson(res, 403, { error: "bad or missing x-panel-token" });
      return true;
    }
    if (route === READ_PATH) {
      const pointer = String(url.searchParams.get("pointer") || "").trim();
      if (!pointer) {
        sendJson(res, 400, { error: "pointer is required: <assistant>/<thread>/<turn>, copied from a digest row" });
        return true;
      }
      const calls = Math.max(1, Math.min(20, Number(url.searchParams.get("calls")) || 3));
      const out = assistant.readTurn(pointer, { calls });
      sendJson(res, out.ok ? 200 : 404, out);
      return true;
    }
    const id = String(url.searchParams.get("assistantId") || "").trim() || undefined;
    const messages = assistant.digestTail(id);
    const last = messages[messages.length - 1] || null;
    sendJson(res, 200, {
      assistantId: id || null,
      messages,
      count: messages.length,
      cap: DIGEST_TAIL_CAP,
      capNote: capNote(messages.length, DIGEST_TAIL_CAP),
      last,
    });
    return true;
  };
}
