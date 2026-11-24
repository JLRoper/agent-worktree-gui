// The waves of work: one READ, and the four WRITES that author them.
//
//   GET  /api/waves?initiative=<id>   the waves of one initiative, each folded with its members, its derived state,
//                                    its gate reads and its LANES
//   POST /api/waves                   create one wave: { initiativeId, title, entryGate?, exitGate?, template?,
//                                    auto?, position?, id?, by? }
//   POST /api/waves/update            edit one record: { initiativeId, id, title?, entryGate?, exitGate?, template?,
//                                    auto?, by? }
//   POST /api/waves/move              reorder one record: { initiativeId, id, to, by? } - `to` is 1-based and is
//                                    clamped into 1..n
//   POST /api/waves/remove            delete one record: { initiativeId, id, by? } - answers how many task rows
//                                    still name it
//
// THE READ IS UNCHANGED. Everything the Initiatives tab draws - the spine, the stations, the gate chips, the lanes,
// the closing note - is folded on each read from two sources: the wave records in `waves.json`, and the task rows in
// every assistant's queue. `init.waves` is folded from the store on every snapshot, so a wave created here appears in
// the tab on its next read, with its stations and lanes, without a websocket, a cache or a client change.
//
// A WRITER CHANGES THE RECORD AND NOTHING ELSE. The seven fields `pickWave` validates, plus provenance, are the whole
// of what these routes can write. A wave never owns a tree, never stores its state, never stores a lane, and its auto
// open is a fact about a read: a posted `state` or `lanes` is REFUSED BY NAME by the same door the loader uses, never
// ignored, because a stored state is believed after the rows move. The gate door (`pickWaveGate`) is the same one,
// so a hand-edited file and a posted record cannot be validated two different ways. No route here opens, closes,
// joins or starts anything, and no route here writes a task row: membership is the task's own `waveId`.
//
// THE STORE IS RE-READ BEFORE EVERY WRITE, and an unreadable one is a 409 with its own sentence and its path - the
// bytes are left for the reader to repair. The store refuses a write while it holds a record the loader skipped
// (decision 3 of the design), because a write serialises the document it loaded and would drop that record silently.
//
// WHO MAY WRITE is the initiative tier, reused rather than given a second switch: `all` asks about all four wave
// changes, `remove` asks about a wave delete, `own` asks about a delete of a wave somebody else made (the record's
// own `by`), and `none` asks nothing. The tier decides only whether the panel asks - never what the change does - and
// an answered question's resume is the same store call the unasked path makes.
import { statSync } from "node:fs";

import { normTreePath } from "../lib/initiatives.js";
import { initiativeAsks, initiativeTierFrom, initiativeTierInfo } from "../lib/initiative-permissions.js";
import { readBundle } from "../lib/pipeline-bundle.js";
// The read's phase clock (lib/read-profile.js), off unless `?profile=1`.
import { profileReport, timeAsync, timeSync, withProfile } from "../lib/read-profile.js";
import {
  WAVE_GATE_CHOICES,
  WAVE_MEMBERS_MAX,
  WAVE_TITLE_MAX,
  WAVES_MAX,
  WAVES_VERSION,
  taskWithOwner,
  waveEvidenceNeeds,
  waveFileExistsPaths,
  waveLane,
} from "../lib/waves.js";

/** The one path this prefix answers, and the three writes under it. */
export const WAVES_PATH = "/api/waves";
export const WAVES_UPDATE_PATH = "/api/waves/update";
export const WAVES_MOVE_PATH = "/api/waves/move";
export const WAVES_REMOVE_PATH = "/api/waves/remove";

// Every field a POST body may name across the four writes: the record's own seven, the two routes' keys (`id`, `to`,
// `position`) and the actor. Anything else is refused by name before a mutator sees it.
const WAVE_POST_KEYS = new Set(["initiativeId", "initiative", "id", "title", "entryGate", "exitGate", "template", "auto", "position", "to", "by", "actor"]);

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
    // THE OWNER IS STAMPED HERE, where the queue is: the file's directory is the only place a task's assistant is
    // known, and every assistant numbers its own tasks from one (lib/waves.js `taskWithOwner`). The role label is the
    // one the worktree column's owner chip draws, read through the Assistant so a renamed role renames both chips.
    const label = typeof assistant?.roleLabelOf === "function" ? assistant.roleLabelOf(rec) : "";
    for (const task of Array.isArray(view?.tasks) ? view.tasks : []) out.push(taskWithOwner(task, rec, label));
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
  // the host mapping and the project registry. `waveEvidence({tasks, rowFor, paths})` answers a Map keyed by
  // `waveMemberKey(task)`, and `paths` are the artefact paths this lane's `file-exists` gates read; absent, thrown or
  // missing a member, the gate reads cannot tell and blocks.
  waveEvidence = null,
  // The write half's dependencies, all supplied by the composition root. They are optional so a fixture that only
  // reads waves still composes the route (test/wave-evidence.test.js does); a POST without them is a 500 with the
  // reason rather than a half-write.
  initiatives = null,
  getConfig = null,
  readBody = null,
  authorised = null,
  remoteWrites = null,
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
  // The level in force is read from the live config on EVERY request, not captured at boot: the settings route writes
  // `config.initiativePermissions`, and a card that still asked under a level the reader has just relaxed would be a
  // setting that only applies after a restart.
  const tierOf = () => initiativeTierFrom(getConfig?.()?.initiativePermissions);
  // Who is making the change. The page sends nothing and means the reader; an assistant sends its own id, which is
  // what the record's `by` keeps and what the `own` tier compares against.
  const actorOf = (payload) => String(payload?.by || payload?.actor || "").trim() || "reader";
  const initiativeOf = (id) => {
    if (!initiatives || typeof initiatives.initiativeById !== "function") return null;
    return initiatives.initiativeById(id);
  };
  const initiativeTitle = (id) => {
    const rec = initiativeOf(id);
    return rec && rec.title ? `"${rec.title}"` : id;
  };
  const whoText = (by) => (by === "reader" ? "you are" : `${by} is`);

  // One lane read, shared by GET and by every write's answer: a POST answers the same view the next GET would, so the
  // tab cannot draw a wave the route just said it saved differently. The unreadable branch is the caller's: a write
  // has already 409'd by the time this runs, and GET draws the 409 in its own shape.
  const laneView = async (initiativeId) => {
    const status = waves.statusOf();
    const tasks = timeSync("queues", () => queueRows(assistant));
    // The wave records THIS answer folds. Their gates decide both halves of the read: the artefact paths a
    // `file-exists` gate names, and which members owe an evidence read at all.
    const records = timeSync("gate-paths", () => waves.wavesFor(initiativeId));
    const needs = timeSync("gate-paths", () => waveEvidenceNeeds(records));
    const paths = timeSync("gate-paths", () => waveFileExistsPaths(records));
    // Only the members a gate here can read: a task in no wave, or in a wave whose gates judge its board row, has no
    // field this answer draws from an evidence read. The fold below still gets every task, so the lane is unchanged.
    const wanted = new Set(needs.waveIds);
    const members = wanted.size ? tasks.filter((task) => wanted.has(String(task?.waveId ?? ""))) : [];
    // ONE evidence read per request, consulted by the entry and exit gate of every wave in the answer. A collector
    // that answers no map, throws, or never reached a member leaves `evidenceOf` answering null for it, and the gate
    // reads cannot tell - the read is fail-closed by construction, never fail-open. `checks` narrows the halves the
    // read asks the host and git for to the ones a gate in THIS answer consumes.
    let evidence = null;
    if (typeof waveEvidence === "function") {
      try {
        const map = await timeAsync("evidence", () => waveEvidence({ tasks: members, rowFor, paths, checks: needs.checks }));
        evidence = map instanceof Map ? map : null;
        if (!evidence) log("waves: the evidence reader answered no map, so every gate reads cannot tell");
      } catch (error) {
        log(`waves: the evidence read failed, so every gate reads cannot tell: ${String((error && error.message) || error)}`);
      }
    }
    const lane = timeSync("lane", () =>
      waveLane({
        waves,
        initiativeId,
        tasks,
        rowFor,
        templateExists,
        evidenceFor: (member) => (evidence ? evidence.get(member.key) || null : null),
      }),
    );
    log(`waves: read ${lane.waves.length} wave${lane.waves.length === 1 ? "" : "s"} for ${initiativeId}`);
    return {
      at: new Date().toISOString(),
      file: status.file,
      found: status.found,
      readable: status.readable,
      error: status.error,
      initiative: initiativeId,
      caps: { waves: WAVES_MAX, members: WAVE_MEMBERS_MAX },
      // The gate names a one-line form can offer (lib/waves.js `WAVE_GATE_CHOICES`), so a client's picker cannot drift
      // from `pickWaveGate`: a gate WITH parameters is still postable and is validated by the same door.
      checks: WAVE_GATE_CHOICES,
      store: { version: WAVES_VERSION },
      ...lane,
    };
  };

  // The question a write parks when the tier says it must ask. The card names the change and the initiative; Deny
  // leaves the store exactly as it is; the resume is the same store call the unasked path makes.
  const ask = (res, { action, title, command, description, resume, initiativeId, by }) => {
    if (!remoteWrites || typeof remoteWrites.request !== "function") {
      sendJson(res, 500, { ok: false, error: "this server was composed without RemoteWrites, so a wave change cannot ask" });
      return true;
    }
    const request = remoteWrites.request({
      kind: "wave",
      worktree: "",
      project: "",
      title,
      command,
      description,
      allowed: ["once", "deny"],
      grants: false,
      resume,
    });
    log(`waves: asked (${request.id}) to ${command} on ${initiativeId} as ${by || "reader"}`);
    sendJson(res, 202, {
      ok: true,
      asked: true,
      id: request.id,
      deadline: request.deadline,
      timeoutSeconds: request.timeoutSeconds,
      action,
      title,
      tier: tierOf(),
      note: "the question is in the dock, bottom right - the wave changes when you answer it, and Deny leaves the store exactly as it is",
    });
    return true;
  };

  const notFound = (res, out) => sendJson(res, 404, { ok: false, notFound: true, error: out.error });

  return async function wavesRoutes(req, res, route, url) {
    if (route !== WAVES_PATH && !route.startsWith(`${WAVES_PATH}/`)) return false;
    const known = route === WAVES_PATH || route === WAVES_UPDATE_PATH || route === WAVES_MOVE_PATH || route === WAVES_REMOVE_PATH;
    if (!known) {
      sendJson(res, 404, { error: `no such waves route: ${route}` });
      return true;
    }

    // ---- the read --------------------------------------------------------------------------------------------------
    if (req.method === "GET") {
      if (route !== WAVES_PATH) {
        sendJson(res, 405, { error: `GET is not allowed on ${route} - only ${WAVES_PATH} is a read, and a wave is changed with POST` });
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
      // `?profile=1` asks the read for its own phases (lib/read-profile.js); the tab never sends it.
      const wanted = String(params.get("profile") || "") === "1";
      sendJson(
        res,
        200,
        await withProfile(wanted, async () => {
          const document = await laneView(initiativeId);
          if (wanted) document.profile = profileReport();
          return document;
        }),
      );
      return true;
    }

    // ---- the writes ------------------------------------------------------------------------------------------------
    if (req.method !== "POST") {
      sendJson(res, 405, {
        error: `${req.method} is not allowed on ${route} - a wave is read with GET and changed with POST, and there is no third verb`,
      });
      return true;
    }
    if (typeof readBody !== "function" || typeof authorised !== "function" || typeof getConfig !== "function") {
      sendJson(res, 500, {
        error: "the wave writer is not composed on this server: it needs readBody, authorised and getConfig from the composition root",
      });
      return true;
    }
    const config = getConfig() || {};
    if (!authorised(req, config.token)) {
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
    const payload = body && typeof body === "object" ? body : {};
    // THE POSTED BODY IS A CLOSED SET TOO. A `state`, a `lanes`, a `members` or a `trees` in a body is refused by
    // name, with the same reason the loader gives a file that carries one: those facts are folded from the members on
    // every read, and a posted one that was silently dropped would look like it had been accepted.
    const extra = Object.keys(payload).find((key) => !WAVE_POST_KEYS.has(key));
    if (extra) {
      sendJson(res, 400, {
        ok: false,
        error: `a wave change carries no ${JSON.stringify(extra)} field - a state, a lane, a member list and a tree list are folded from the members on every read, never written`,
      });
      return true;
    }
    const initiativeId = String(payload.initiativeId || payload.initiative || "").trim();
    if (!initiativeId) {
      sendJson(res, 400, { error: "a wave lives inside one initiative - send initiativeId" });
      return true;
    }
    // AN UNREADABLE STORE IS A 409 AND NOTHING IS WRITTEN, before the body is judged: the file may be salvageable and
    // the panel will not be the thing that destroys it. A store holding a skipped record refuses for the same reason.
    const refused = waves.refuse();
    if (refused) {
      sendJson(res, 409, refused);
      return true;
    }
    const initiative = initiativeOf(initiativeId);
    if (initiatives && typeof initiatives.initiativeById === "function" && !initiative) {
      sendJson(res, 404, { ok: false, error: `no such initiative: ${initiativeId} - a wave lives inside one, and nothing was written` });
      return true;
    }
    const tier = tierOf();
    const by = actorOf(payload);

    // ---- create ----------------------------------------------------------------------------------------------------
    if (route === WAVES_PATH) {
      const title = String(payload.title ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!title) {
        sendJson(res, 400, { ok: false, error: "a wave needs a title - one line saying what this wave is" });
        return true;
      }
      const label = title.slice(0, WAVE_TITLE_MAX);
      if (initiativeAsks(tier, "wave-create", { actor: by })) {
        return ask(res, {
          action: "wave-create",
          initiativeId,
          by,
          title: `Create wave "${label}"`,
          command: `create wave "${label}"`,
          description: `${whoText(by)} adding a wave to ${initiativeTitle(initiativeId)}. Nothing is created until you answer; Deny leaves the wave store exactly as it is.`,
          resume: () =>
            waves.create({
              initiativeId,
              id: payload.id,
              title: payload.title,
              entryGate: payload.entryGate,
              exitGate: payload.exitGate,
              template: payload.template,
              auto: payload.auto,
              position: payload.position,
              by,
            }),
        });
      }
      const out = waves.create({
        initiativeId,
        id: payload.id,
        title: payload.title,
        entryGate: payload.entryGate,
        exitGate: payload.exitGate,
        template: payload.template,
        auto: payload.auto,
        position: payload.position,
        by,
      });
      if (!out.ok) {
        sendJson(res, out.refused ? 409 : 400, out);
        return true;
      }
      log(`waves: "${out.wave.title}" created (${out.wave.id}) at W${out.wave.position} of ${initiativeId} by ${out.wave.by}, not asked (tier ${tier})`);
      sendJson(res, 200, { ok: true, asked: false, changed: true, wave: out.wave, ...(await laneView(initiativeId)) });
      return true;
    }

    // ---- edit ------------------------------------------------------------------------------------------------------
    if (route === WAVES_UPDATE_PATH) {
      const id = String(payload.id || "").trim();
      if (!id) {
        sendJson(res, 400, { ok: false, error: "an edit needs the wave id" });
        return true;
      }
      const existing = waves.wavesFor(initiativeId).find((wave) => wave.id === id) || null;
      if (!existing) {
        const elsewhere = waves.waveById(id);
        sendJson(res, 404, {
          ok: false,
          notFound: true,
          error: elsewhere ? `${id} belongs to ${elsewhere.initiativeId}, not ${initiativeId}` : `no such wave in ${initiativeId}: ${id}`,
        });
        return true;
      }
      if (initiativeAsks(tier, "wave-edit", { actor: by })) {
        return ask(res, {
          action: "wave-edit",
          initiativeId,
          by,
          title: `Edit wave "${existing.title}"`,
          command: `edit wave "${existing.title}"`,
          description: `${whoText(by)} changing a wave's words, gates, template or switch on ${initiativeTitle(initiativeId)}. Nothing changes until you answer; Deny leaves the wave store exactly as it is.`,
          resume: () =>
            waves.update({
              initiativeId,
              id,
              title: payload.title,
              entryGate: payload.entryGate,
              exitGate: payload.exitGate,
              template: payload.template,
              auto: payload.auto,
              by,
            }),
        });
      }
      const out = waves.update({
        initiativeId,
        id,
        title: payload.title,
        entryGate: payload.entryGate,
        exitGate: payload.exitGate,
        template: payload.template,
        auto: payload.auto,
        by,
      });
      if (out.notFound) return notFound(res, out);
      if (!out.ok) {
        sendJson(res, out.refused ? 409 : 400, out);
        return true;
      }
      log(`waves: ${id} ${out.changed === false ? "was already as asked" : "edited"} by ${by}, not asked (tier ${tier})`);
      sendJson(res, 200, { ok: true, asked: false, changed: out.changed !== false, wave: out.wave, ...(await laneView(initiativeId)) });
      return true;
    }

    // ---- move ------------------------------------------------------------------------------------------------------
    if (route === WAVES_MOVE_PATH) {
      const id = String(payload.id || "").trim();
      if (!id) {
        sendJson(res, 400, { ok: false, error: "a move needs the wave id" });
        return true;
      }
      const existing = waves.wavesFor(initiativeId).find((wave) => wave.id === id) || null;
      if (!existing) {
        const elsewhere = waves.waveById(id);
        sendJson(res, 404, {
          ok: false,
          notFound: true,
          error: elsewhere ? `${id} belongs to ${elsewhere.initiativeId}, not ${initiativeId}` : `no such wave in ${initiativeId}: ${id}`,
        });
        return true;
      }
      if (initiativeAsks(tier, "wave-move", { actor: by })) {
        return ask(res, {
          action: "wave-move",
          initiativeId,
          by,
          title: `Move wave "${existing.title}" to position ${payload.to ?? "?"}`,
          command: `move wave "${existing.title}"`,
          description: `${whoText(by)} reordering the waves of ${initiativeTitle(initiativeId)}. Nothing moves until you answer; Deny leaves the order exactly as it is.`,
          resume: () => waves.move({ initiativeId, id, to: payload.to, by }),
        });
      }
      const out = waves.move({ initiativeId, id, to: payload.to, by });
      if (out.notFound) return notFound(res, out);
      if (!out.ok) {
        sendJson(res, out.refused ? 409 : 400, out);
        return true;
      }
      const view = await laneView(initiativeId);
      log(`waves: ${id} moved to position ${out.to} of ${initiativeId} by ${by}, not asked (tier ${tier})`);
      sendJson(res, 200, {
        ok: true,
        asked: false,
        changed: out.changed !== false,
        to: out.to,
        // The new order, plainly: the lane below carries the same list folded, and this is the one line a caller can
        // assert a reorder against without reading the fold.
        order: view.waves.map((wave) => ({ id: wave.id, position: wave.position })),
        ...view,
      });
      return true;
    }

    // ---- remove ----------------------------------------------------------------------------------------------------
    if (route === WAVES_REMOVE_PATH) {
      const id = String(payload.id || "").trim();
      if (!id) {
        sendJson(res, 400, { ok: false, error: "a delete needs the wave id" });
        return true;
      }
      const existing = waves.wavesFor(initiativeId).find((wave) => wave.id === id) || null;
      if (!existing) {
        const elsewhere = waves.waveById(id);
        sendJson(res, 404, {
          ok: false,
          notFound: true,
          error: elsewhere ? `${id} belongs to ${elsewhere.initiativeId}, not ${initiativeId}` : `no such wave in ${initiativeId}: ${id}`,
        });
        return true;
      }
      // The `own` level reads the WAVE's actor here, exactly as a detach reads the attachment's: an assistant's own
      // wave comes out without a question, and a wave the reader made asks when somebody else deletes it.
      if (initiativeAsks(tier, "wave-remove", { actor: by, attachedBy: existing.by || null })) {
        return ask(res, {
          action: "wave-remove",
          initiativeId,
          by,
          title: `Delete wave "${existing.title}"`,
          command: `delete wave "${existing.title}"`,
          description: `${whoText(by)} deleting a wave from ${initiativeTitle(initiativeId)}. Its task rows keep their wave id and read as members of no wave; nothing else is touched. Deny leaves the store exactly as it is.`,
          resume: () => waves.remove({ initiativeId, id, by }),
        });
      }
      const out = waves.remove({ initiativeId, id, by });
      if (out.notFound) return notFound(res, out);
      if (!out.ok) {
        sendJson(res, out.refused ? 409 : 400, out);
        return true;
      }
      // How many task rows still name the id. The route counts the same queues the read folds, and the delete itself
      // touched none of them: membership is the task's own field, and rewriting a queue is a second writer.
      const members = queueRows(assistant).filter((task) => String(task?.waveId ?? "") === id).length;
      log(`waves: "${out.wave.title}" (${id}) removed from ${initiativeId} by ${by}, not asked (tier ${tier}); ${members} task row${members === 1 ? "" : "s"} still name it`);
      sendJson(res, 200, { ok: true, asked: false, changed: true, members, wave: out.wave, ...(await laneView(initiativeId)) });
      return true;
    }

    sendJson(res, 404, { error: `no such waves route: ${route}` });
    return true;
  };
}
