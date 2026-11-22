// The waves of work: one READ, and only one, for this slice.
//
//   GET /api/waves?initiative=<id>   the waves of one initiative, each folded with its members, its derived state,
//                                    its gate reads and its LANES
//
// WHY A READ AND NOTHING ELSE. The design (docs/reports/waves-of-work.html, section 6) sizes the first slice so it can be
// judged before anything acts on it: no write route, no evaluator, no scheduler, no auto start. This module is the
// wire half of that read, and the same fold is what GET /api/initiatives carries into the Initiatives tab, so the lane
// and this route cannot disagree about a wave's state.
//
// THE LANES RIDE INSIDE EACH WAVE, AND COST THIS MODULE NOTHING. A wave's lanes are derived from its members by the
// same fold that gives its state (lib/waves.js `waveLanes`), so the payload carries `lanes`, `laneCount`,
// `laneJoinOwed` and `laneRefused` per wave without a second read, a store field or a cache to keep warm. The join a
// lane set owes is a CALL (`joinWaveLanes`), not a route: nothing here writes, and no scheduler was added.
//
// MEMBERS COME FROM EVERY ASSISTANT'S QUEUE, not from the initiative's tree keys. Membership is the task's own
// `waveId` (decision 2, 2026-11-21): a wave may span projects, so filtering by tree would silently drop a member whose
// worktree belongs to another initiative - the exact inference the design forbids.
//
// AN UNREADABLE STORE IS A 409 AND NOTHING IS WRITTEN. The sentence is the store's own, with the path in it, and this
// module has no writer to overwrite the bytes with; a refused read leaves the file for the reader to repair.
import { statSync } from "node:fs";

import { normTreePath } from "../lib/initiatives.js";
import { readBundle } from "../lib/pipeline-bundle.js";
import { WAVE_MEMBERS_MAX, WAVES_MAX, WAVES_VERSION, waveLane } from "../lib/waves.js";

/** The one path this prefix answers. */
export const WAVES_PATH = "/api/waves";

/**
 * Whether the bundle still holds a template id, cached by the bundle file's stamp.
 *
 * The lane must read a template that disappeared as UNRESOLVED rather than null it, and the bundle is 175 KB: parsing
 * it on every snapshot the tab takes would be a real cost for a boolean. The stamp makes a re-export visible on the
 * next read and nothing else re-parse.
 */
export function waveTemplateLookup(bundleFile) {
  let cache = { stamp: null, ids: new Set() };
  return (id) => {
    const wanted = String(id || "");
    if (!wanted) return null;
    let stamp = "missing";
    try {
      const st = statSync(bundleFile);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      stamp = "missing";
    }
    if (cache.stamp !== stamp) {
      const source = bundleFile ? readBundle(bundleFile) : null;
      const bundle = source && source.ok ? source.bundle : null;
      cache = { stamp, ids: new Set(bundle ? (bundle.pipelines || []).map((p) => p.id) : []) };
    }
    return cache.ids.has(wanted);
  };
}

/** One line per assistant's queue rows, flattened. A queue that cannot be read is an empty one FOR THIS READ. */
export function queueRows(assistant) {
  const out = [];
  const assistants = Array.isArray(assistant?.assistants) ? assistant.assistants : [];
  for (const rec of assistants) {
    let view = null;
    try {
      view = typeof assistant?.queueView === "function" ? assistant.queueView(rec.id) : null;
    } catch {
      view = null; // its own pane reports the error; a wave read must not fail because one queue did
    }
    for (const task of Array.isArray(view?.tasks) ? view.tasks : []) out.push(task);
  }
  return out;
}

export function createWavesRoutes({
  waves,
  assistant,
  store,
  sendJson,
  templateExists = () => null,
  // The evidence read behind a gate (lib/wave-evidence.js), supplied by the composition root because only it holds
  // the host mapping and the project registry. `waveEvidence({tasks, rowFor})` answers a Map keyed by
  // `waveMemberKey(task)`; absent, thrown or missing a member, the gate reads cannot tell and blocks.
  waveEvidence = null,
  log = () => {},
} = {}) {
  if (!waves) throw new Error("createWavesRoutes needs the Waves store");
  if (typeof sendJson !== "function") throw new Error("createWavesRoutes needs sendJson from the server's transport");

  const rowFor = (project, treePath) => {
    const key = normTreePath(treePath);
    if (!key) return null;
    const rows = typeof store?.rowsFor === "function" ? store.rowsFor(project) || [] : [];
    return rows.find((r) => normTreePath(r.path) === key) || null;
  };

  return async function wavesRoutes(req, res, route, url) {
    if (route !== WAVES_PATH && !route.startsWith(`${WAVES_PATH}/`)) return false;
    if (route !== WAVES_PATH) {
      sendJson(res, 404, { error: `no such waves route: ${route}` });
      return true;
    }
    if (req.method !== "GET") {
      sendJson(res, 405, { error: `${req.method} is not allowed on ${route} - this slice reads waves and writes none` });
      return true;
    }
    const params = url?.searchParams || new URL(req.url || "/", "http://127.0.0.1").searchParams;
    const initiativeId = String(params.get("initiative") || "").trim();
    if (!initiativeId) {
      sendJson(res, 400, { error: "a wave read needs ?initiative=<id> - a wave lives inside one initiative, and the store is keyed by it" });
      return true;
    }
    const status = waves.statusOf();
    if (!status.readable) {
      sendJson(res, 409, {
        refused: "unreadable",
        file: status.file,
        error: `${status.file || "the wave store"} could not be read (${status.error || "unknown error"}) - it was NOT overwritten. Fix or move that file, then try again: every wave on the board lives in it.`,
      });
      return true;
    }
    const tasks = queueRows(assistant);
    // ONE evidence read per request, consulted by the entry and exit gate of every wave in the answer. A collector
    // that answers no map, throws, or never reached a member leaves `evidenceOf` answering null for it, and the gate
    // reads cannot tell - the read is fail-closed by construction, never fail-open.
    let evidence = null;
    if (typeof waveEvidence === "function") {
      try {
        const map = await waveEvidence({ tasks, rowFor });
        evidence = map instanceof Map ? map : null;
        if (!evidence) log("waves: the evidence reader answered no map, so every gate reads cannot tell");
      } catch (error) {
        log(`waves: the evidence read failed, so every gate reads cannot tell: ${String((error && error.message) || error)}`);
      }
    }
    const lane = waveLane({
      waves,
      initiativeId,
      tasks,
      rowFor,
      templateExists,
      evidenceFor: (member) => (evidence ? evidence.get(member.key) || null : null),
    });
    log(`waves: read ${lane.waves.length} wave${lane.waves.length === 1 ? "" : "s"} for ${initiativeId}`);
    sendJson(res, 200, {
      at: new Date().toISOString(),
      file: status.file,
      found: status.found,
      readable: status.readable,
      error: status.error,
      initiative: initiativeId,
      caps: { waves: WAVES_MAX, members: WAVE_MEMBERS_MAX },
      store: { version: WAVES_VERSION },
      ...lane,
    });
    return true;
  };
}
