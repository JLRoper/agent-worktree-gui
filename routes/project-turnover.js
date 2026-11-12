// A project's turnover branch: the read the settings bar draws, and the one save that names it (or clears it).
//
//   GET  /api/project-turnover                    every project's turnover branch, in one read
//   GET  /api/project-turnover?project=<name>     one project's branch, and the cap the field obeys
//   POST /api/project-turnover                    { project, turnoverBranch: "<name>" | "" } - "" clears it
//
// WHY A ROUTE AND NOT A SECOND FIELD ON THE SNAPSHOT. The snapshot already carries `turnoverBranch` on each project
// record, because lib/projects.js normalises the config entry discovery merged (that is what the chip draws without a
// round trip). This route is the other half: the WRITE, which is a read-modify-write of one project's entry in the
// reader's own config.json, and a READ that answers the name for a caller with no board - a script, a harness, a page
// that wants to be sure what it just saved is what the server holds. The write is `setProjectTurnover` in the
// composition root, because it owns the atomic config writer; this module owns the status codes and the wire shape.
//
// THE VALUE IS ONE BRANCH NAME, and "" is a real answer: a project that has stopped using a turnover branch clears
// the key, and a later cut starts where the checkout stands exactly as it did before the setting existed.
import { BASE_REF_KINDS, TURNOVER_MAX_CHARS, baseRefKindOf, turnoverBranchOf } from "../lib/project-turnover.js";
import { BASE_REF_KIND_LABELS } from "../lib/base-ref-kind.js";

/** The one path this prefix answers, and the row the mount table in server.js matches on. */
export const TURNOVER_PATH = "/api/project-turnover";

/** The shape every answer carries: the cap, the kinds, and the names. */
export function turnoverOut(registry, project = null) {
  const projects = registry?.projects || [];
  const base = { maxChars: TURNOVER_MAX_CHARS, kinds: [...BASE_REF_KINDS], kindLabels: { ...BASE_REF_KIND_LABELS } };
  if (!project) {
    return {
      ...base,
      projects: Object.fromEntries(projects.map((p) => [p.name, turnoverBranchOf(p)])),
      baseRefKinds: Object.fromEntries(projects.map((p) => [p.name, baseRefKindOf(p)])),
    };
  }
  const found = projects.find((p) => p.name === project) || null;
  if (!found) {
    return { ...base, project, turnoverBranch: null, baseRefKind: null, error: `unknown project: ${project} - a turnover branch belongs to a project on this board` };
  }
  return { ...base, project, turnoverBranch: turnoverBranchOf(found), baseRefKind: baseRefKindOf(found) };
}

export function createProjectTurnoverRoutes({ getConfig, registry, setProjectTurnover, sendJson, readBody, authorised } = {}) {
  // Every seam is named on the way in: a missing one is a boot-time error rather than a 500 on the first press, and
  // the message names the half the composition root forgot.
  if (typeof getConfig !== "function") throw new Error("createProjectTurnoverRoutes needs getConfig from the composition root");
  if (!registry) throw new Error("createProjectTurnoverRoutes needs registry from the composition root");
  if (typeof setProjectTurnover !== "function") throw new Error("createProjectTurnoverRoutes needs setProjectTurnover from the composition root");
  if (typeof sendJson !== "function" || typeof readBody !== "function" || typeof authorised !== "function") {
    throw new Error("createProjectTurnoverRoutes needs sendJson, readBody and authorised from the server's transport");
  }

  return async function projectTurnoverRoutes(req, res, route, url) {
    if (route !== TURNOVER_PATH) return false;
    // The live config, asked for per request: POST /api/reload replaces the object, and the token lives on it.
    const config = getConfig() || {};
    const params = url?.searchParams || new URL(req.url || "/", "http://127.0.0.1").searchParams;

    if (req.method === "GET") {
      const project = String(params.get("project") || "").trim();
      const out = turnoverOut(registry, project || null);
      // A named project the board does not carry is a 404, not an empty name: "this project has no turnover branch"
      // and "there is no such project" are different answers, and a caller that saves against the second has a typo
      // to find.
      sendJson(res, out.error ? 404 : 200, out);
      return true;
    }

    if (req.method === "POST") {
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
      const project = String(payload.project || "").trim();
      if (!project) {
        sendJson(res, 400, { error: "project is required: a turnover branch belongs to one project on the board", ...turnoverOut(registry) });
        return true;
      }
      if (payload.turnoverBranch === undefined && payload.baseRefKind === undefined) {
        sendJson(res, 400, { error: "turnoverBranch is required unless a baseRefKind is sent: send a branch name (or \"\" to clear it), a kind, or both", ...turnoverOut(registry, project) });
        return true;
      }
      const out = await setProjectTurnover(project, payload.turnoverBranch, { by: "the turnover bar", baseRefKind: payload.baseRefKind });
      if (out.error) {
        const held = registry.projects.find((p) => p.name === project) || null;
        sendJson(res, out.status || 400, { ...turnoverOut({ projects: held ? [held] : [] }, held ? project : null), error: out.error });
        return true;
      }
      sendJson(res, 200, {
        ok: true,
        project,
        turnoverBranch: out.turnoverBranch,
        baseRefKind: out.baseRefKind,
        maxChars: TURNOVER_MAX_CHARS,
        note: out.note || (out.turnoverBranch ? `${project}: turnover branch ${out.turnoverBranch}` : `${project}: no turnover branch`),
      });
      return true;
    }

    sendJson(res, 405, { error: `${req.method} is not allowed on ${TURNOVER_PATH}` });
    return true;
  };
}
