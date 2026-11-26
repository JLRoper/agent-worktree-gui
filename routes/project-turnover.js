// A project's turnover branches: the read the settings bar draws, and the one save that names them (or clears them).
// A project's TURNOVER POLICY rides the same read and the same save:
//
//   GET  /api/project-turnover                    every project's branches and policy, in one read
//   GET  /api/project-turnover?project=<name>     one project's branches, its policy and the caps the fields obey
//   POST /api/project-turnover                    { project, turnoverBranches: [...], turnoverPolicy, turnoverKey, baseRefKind }
//                                                 { project, turnoverBranch: "<name>" | "" } is still accepted (one entry)
//
// WHY A ROUTE AND NOT A SECOND FIELD ON THE SNAPSHOT. The snapshot already carries the turnover branch on each project
// record, because lib/projects.js normalises the config entry discovery merged (that is what the chip draws without a
// round trip). This route is the other half: the WRITE, which is a read-modify-write of one project's entry in the
// reader's own config.json, and a READ that answers the names for a caller with no board - a script, a harness, a page
// that wants to be sure what it just saved is what the server holds. The write is `setProjectTurnover` in the
// composition root, because it owns the atomic config writer; this module owns the status codes and the wire shape.
//
// THE ASK. A save that ADDS a turnover branch is a branch creation, and the project's `turnoverPolicy` decides whether
// it happens at once or parks on the panel's permission card (lib/remote-writes.js):
//
//   free              applied at once.
//   ask               parked; the answer runs the save it was asked about, and nothing else.
//   one-per-feature   parked for a new branch, BUT a second branch for a key that already has one is refused by name
//                     (409) with the existing branch offered - there is nothing to ask, the answer already exists.
//
// ONE GRANT COVERS ONE BRANCH CREATION. The parked request's `resume` is exactly this save; answering it again is a
// second question, and a save that adds two branches is still one question with one answer. The ask is written into
// the durable permissions history by lib/remote-writes.js, so the header's Permissions button counts it.
//
// THE OLD SINGLE KEY IS READ AS ONE ENTRY. `turnoverBranch` is accepted on the wire and in the file, and answered as
// a one-entry list; `turnoverBranches` is the list that replaces it. Reading is forgiving, writing is strict
// (lib/project-turnover.js owns both rules).
import {
  BASE_REF_KINDS,
  DEFAULT_TURNOVER_POLICY,
  TURNOVER_MAX_CHARS,
  TURNOVER_POLICIES,
  TURNOVER_POLICY_INFO,
  baseRefKindOf,
  planTurnoverSave,
  turnoverBranchesOf,
  turnoverBranchOf,
  turnoverKeyFrom,
  turnoverPolicyOf,
  validateTurnoverBranch,
  validateTurnoverBranches,
} from "../lib/project-turnover.js";
import { BASE_REF_KIND_LABELS } from "../lib/base-ref-kind.js";

/** The one path this prefix answers, and the row the mount table in server.js matches on. */
export const TURNOVER_PATH = "/api/project-turnover";

/** The shape every answer carries: the caps, the kinds, the policies, and (per project) the names. */
export function turnoverOut(registry, project = null) {
  const projects = registry?.projects || [];
  const base = {
    maxChars: TURNOVER_MAX_CHARS,
    kinds: [...BASE_REF_KINDS],
    kindLabels: { ...BASE_REF_KIND_LABELS },
    policies: [...TURNOVER_POLICIES],
    policyLabels: Object.fromEntries(TURNOVER_POLICY_INFO.map((row) => [row.id, row.label])),
    defaultPolicy: DEFAULT_TURNOVER_POLICY,
  };
  if (!project) {
    return {
      ...base,
      projects: Object.fromEntries(projects.map((p) => [p.name, turnoverBranchOf(p)])),
      turnoverBranches: Object.fromEntries(projects.map((p) => [p.name, turnoverBranchesOf(p)])),
      turnoverPolicies: Object.fromEntries(projects.map((p) => [p.name, turnoverPolicyOf(p)])),
      baseRefKinds: Object.fromEntries(projects.map((p) => [p.name, baseRefKindOf(p)])),
    };
  }
  const found = projects.find((p) => p.name === project) || null;
  if (!found) {
    return {
      ...base,
      project,
      turnoverBranch: null,
      turnoverBranches: null,
      turnoverPolicy: null,
      baseRefKind: null,
      error: `unknown project: ${project} - a turnover branch belongs to a project on this board`,
    };
  }
  return {
    ...base,
    project,
    turnoverBranch: turnoverBranchOf(found),
    turnoverBranches: turnoverBranchesOf(found),
    turnoverPolicy: turnoverPolicyOf(found),
    baseRefKind: baseRefKindOf(found),
  };
}

export function createProjectTurnoverRoutes({ getConfig, registry, setProjectTurnover, sendJson, readBody, authorised, remoteWrites = null, log = null } = {}) {
  // Every seam is named on the way in: a missing one is a boot-time error rather than a 500 on the first press, and
  // the message names the half the composition root forgot.
  if (typeof getConfig !== "function") throw new Error("createProjectTurnoverRoutes needs getConfig from the composition root");
  if (!registry) throw new Error("createProjectTurnoverRoutes needs registry from the composition root");
  if (typeof setProjectTurnover !== "function") throw new Error("createProjectTurnoverRoutes needs setProjectTurnover from the composition root");
  if (typeof sendJson !== "function" || typeof readBody !== "function" || typeof authorised !== "function") {
    throw new Error("createProjectTurnoverRoutes needs sendJson, readBody and authorised from the server's transport");
  }
  const say = typeof log === "function" ? log : () => {};

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
      // A project the board does not carry is a 404 BEFORE anything is validated or asked: a card whose answer could
      // only fail is a question the panel should never have asked.
      const found = registry.projects.find((p) => p.name === project) || null;
      if (!found) {
        sendJson(res, 404, { ...turnoverOut(registry, project), error: `unknown project: ${project} - a turnover branch belongs to a project on this board` });
        return true;
      }
      const hasList = payload.turnoverBranches !== undefined;
      const hasSingle = payload.turnoverBranch !== undefined;
      const hasPolicy = payload.turnoverPolicy !== undefined;
      if (!hasList && !hasSingle && !hasPolicy && payload.baseRefKind === undefined) {
        sendJson(res, 400, {
          error: "turnoverBranch is required unless a turnoverBranches list, a turnoverPolicy or a baseRefKind is sent: send a branch name (or \"\" to clear it), a list, a policy, a kind, or several of them",
          ...turnoverOut(registry, project),
        });
        return true;
      }
      // EVERYTHING IS VALIDATED BEFORE A QUESTION IS PARKED. A card whose answer could only fail is the defect this
      // ordering exists to prevent: the reader answers, and the write refuses for a reason the card could have said.
      let entries;
      if (hasList) {
        const checked = validateTurnoverBranches(payload.turnoverBranches);
        if (checked.error) {
          sendJson(res, 400, { ...turnoverOut(registry, project), error: checked.error });
          return true;
        }
        entries = checked.entries;
      } else if (hasSingle) {
        const checked = validateTurnoverBranch(payload.turnoverBranch);
        if (checked.error) {
          sendJson(res, 400, { ...turnoverOut(registry, project), error: checked.error });
          return true;
        }
        entries = checked.branch ? [{ branch: checked.branch }] : [];
      }
      let policy;
      if (hasPolicy) {
        const asked = String(payload.turnoverPolicy ?? "").trim().toLowerCase();
        if (!TURNOVER_POLICIES.includes(asked)) {
          sendJson(res, 400, { ...turnoverOut(registry, project), error: `turnoverPolicy must be one of ${TURNOVER_POLICIES.join(", ")}` });
          return true;
        }
        policy = asked;
      }
      const key = turnoverKeyFrom(payload.turnoverKey);
      // The one-per-feature refusal, decided from the record the save starts from: no card, because the answer is the
      // branch the project already has.
      let plan = null;
      if (entries) {
        plan = planTurnoverSave({ project: found, entries, key });
        if (!plan.ok) {
          say(`turnover: refused to add ${plan.added?.map((e) => e.branch).join(", ") || "a branch"} to ${project} - ${plan.error}`);
          sendJson(res, 409, {
            ...turnoverOut(registry, project),
            ok: false,
            asked: false,
            refused: plan.refused,
            key: plan.key,
            existing: plan.existing,
            error: plan.error,
          });
          return true;
        }
      }
      // The save as its own function: the answer's resume and the direct path run the SAME write. The OLD single key
      // keeps writing the old single field (one name, one key) so a caller that never heard of the list sees the same
      // file it always did; the list is what writes `turnoverBranches`.
      const apply = async () =>
        setProjectTurnover(project, hasSingle && !hasList ? String(payload.turnoverBranch ?? "") : entries, {
          by: "the turnover bar",
          baseRefKind: payload.baseRefKind,
          policy,
        });
      if (plan?.ask && remoteWrites && typeof remoteWrites.request === "function") {
        const names = plan.added.map((entry) => entry.branch);
        const request = remoteWrites.request({
          kind: "turnover",
          worktree: String(found?.path || ""),
          project,
          branch: names.join(", "),
          title: `${project}: ${names.length === 1 ? `new turnover branch ${names[0]}` : `${names.length} new turnover branches`}`,
          command: `add turnover ${names.length === 1 ? "branch" : "branches"} ${names.join(", ")} to ${project}${key ? ` (key ${key})` : ""}`,
          description:
            "this project's turnover policy says a new turnover branch waits for you. Allow adds exactly this branch (or this list) to the project and creates nothing else on the remote; Deny leaves the project as it is.",
          allowed: ["once", "deny"],
          // The answer is permission for THIS branch creation, not a remote write: no push grant may be left behind.
          grants: false,
          resume: apply,
        });
        say(`turnover: asked (${request.id}) to add ${names.join(", ")} to ${project}${key ? ` for ${key}` : ""} (policy ${plan.policy})`);
        sendJson(res, 202, {
          ok: true,
          asked: true,
          id: request.id,
          deadline: request.deadline,
          timeoutSeconds: request.timeoutSeconds,
          ...turnoverOut(registry, project),
          added: names,
          key: key || null,
          note: "the question is in the dock, bottom right - the branch is added when you answer it",
        });
        return true;
      }
      const out = await apply();
      if (out.error) {
        const held = registry.projects.find((p) => p.name === project) || null;
        sendJson(res, out.status || 400, { ...turnoverOut({ projects: held ? [held] : [] }, held ? project : null), error: out.error });
        return true;
      }
      sendJson(res, 200, {
        ok: true,
        asked: false,
        project,
        turnoverBranch: out.turnoverBranch,
        turnoverBranches: out.turnoverBranches,
        turnoverPolicy: out.turnoverPolicy,
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
