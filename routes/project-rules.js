// A project's own rules: the read the header's chip and the rules bar draw, and the one save that replaces the list.
//
//   GET  /api/project-rules                     every project's list, in one read
//   GET  /api/project-rules?project=<name>      one project's list, and the two caps the editor obeys
//   POST /api/project-rules                     { project, rules: [...] } - the WHOLE list, in the reader's order
//
// WHY A ROUTE AND NOT A SECOND FIELD ON THE SNAPSHOT. The snapshot already carries `rules` on each project record,
// because lib/projects.js normalises the config entry discovery merged (that is what the chip counts without a round
// trip). This route is the other half: the WRITE, which is a read-modify-write of one project's entry in the reader's
// own config.json, and a READ that answers the list for a caller with no board - a script, a harness, a page that
// wants to be sure what it just saved is what the server holds. The write is `setProjectRules` in the composition
// root, because it owns the atomic config writer; this module owns the status codes and the wire shape.
//
// THE LIST IS REPLACED, NEVER PATCHED. The editor's four gestures (add, edit, reorder, delete) are one operation from
// here: the reader's list, in the reader's order. A patch protocol would need an id per rule, and a rule is one line
// of text with no identity of its own - two identical lines are legal, and the row a reader dragged is the position,
// not the sentence.
//
// The caps travel with the read so the editor's `maxlength`, its "add" refusal and this route's 400 are the same two
// numbers (`RULE_MAX_CHARS`, `RULES_MAX` in lib/project-rules.js) rather than three copies.
import { RULES_MAX, RULE_MAX_CHARS, rulesFrom } from "../lib/project-rules.js";

/** The one path this prefix answers, and the row the mount table in server.js matches on. */
export const RULES_PATH = "/api/project-rules";

/** The shape every answer carries: the caps, and the lists. */
export function rulesOut(registry, project = null) {
  const projects = registry?.projects || [];
  const base = { max: RULES_MAX, maxChars: RULE_MAX_CHARS };
  if (!project) {
    return {
      ...base,
      projects: Object.fromEntries(projects.map((p) => [p.name, rulesFrom(p.rules)])),
    };
  }
  const found = projects.find((p) => p.name === project) || null;
  if (!found) return { ...base, project, rules: null, error: `unknown project: ${project} - the rules belong to a project on this board` };
  const rules = rulesFrom(found.rules);
  return { ...base, project, rules, count: rules.length };
}

export function createProjectRulesRoutes({ getConfig, registry, setProjectRules, sendJson, readBody, authorised } = {}) {
  // Every seam is named on the way in: a missing one is a boot-time error rather than a 500 on the first press, and
  // the message names the half the composition root forgot.
  if (typeof getConfig !== "function") throw new Error("createProjectRulesRoutes needs getConfig from the composition root");
  if (!registry) throw new Error("createProjectRulesRoutes needs registry from the composition root");
  if (typeof setProjectRules !== "function") throw new Error("createProjectRulesRoutes needs setProjectRules from the composition root");
  if (typeof sendJson !== "function" || typeof readBody !== "function" || typeof authorised !== "function") {
    throw new Error("createProjectRulesRoutes needs sendJson, readBody and authorised from the server's transport");
  }

  return async function projectRulesRoutes(req, res, route, url) {
    if (route !== RULES_PATH) return false;
    // The live config, asked for per request: POST /api/reload replaces the object, and the token lives on it.
    const config = getConfig() || {};
    const params = url?.searchParams || new URL(req.url || "/", "http://127.0.0.1").searchParams;

    if (req.method === "GET") {
      const project = String(params.get("project") || "").trim();
      const out = rulesOut(registry, project || null);
      // A named project the board does not carry is a 404, not an empty list: "this project has no rules" and "there
      // is no such project" are different answers, and a caller that saves against the second has a typo to find.
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
        sendJson(res, 400, { error: "project is required: these rules belong to one project on the board", ...rulesOut(registry) });
        return true;
      }
      if (payload.rules === undefined) {
        sendJson(res, 400, { error: "rules is required: send the whole list (an empty list clears it)", ...rulesOut(registry, project) });
        return true;
      }
      const out = await setProjectRules(project, payload.rules, { by: "the rules bar" });
      if (out.error) {
        const held = registry.projects.find((p) => p.name === project) || null;
        sendJson(res, out.status || 400, { ...rulesOut({ projects: held ? [held] : [] }, held ? project : null), error: out.error });
        return true;
      }
      sendJson(res, 200, {
        ok: true,
        project,
        rules: out.rules,
        count: out.rules.length,
        max: RULES_MAX,
        maxChars: RULE_MAX_CHARS,
        note: out.rules.length ? `${project}: ${out.rules.length} rule${out.rules.length === 1 ? "" : "s"} saved` : `${project}: no rules`,
      });
      return true;
    }

    sendJson(res, 405, { error: `${req.method} is not allowed on ${RULES_PATH}` });
    return true;
  };
}
