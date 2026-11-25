// The pre-flight a SPAWN gets BEFORE its line is written: would the cut refuse it, and what would fix it.
//
//   GET /api/assistant/spawn-check?task=<id>&project=<name>&tree=<path>&assistantId=<id>
//     -> { ok, reason, remedy, checks: [{check, code, reason, remedy}], task, project, tree, resolved }
//
// Why the route exists: on 2026-11-21 a SPAWN naming parked row 184 was refused with "task #184 is parked" AFTER the
// manager had already told the reader the run had started, and the same evening two SPAWNs were cut inside worktrees
// that still held unlanded commits. Every one of those answers was knowable before the line. The panel answered
// only at the cut, so the assistant wrote a line it could not check and the reader was told a thing that was not
// true.
//
// READ ONLY, by construction and on purpose: this module reads the queue file, the job store and the scanned rows,
// and nothing else. It starts nothing, writes nothing, cuts nothing and touches no state - the same restriction the
// digest's read route lives under. `ok` is exactly "the cut would accept this", and the checks it reports are
// the cut's own functions (lib/spawn-check.js), not a second opinion that could drift: the row check is
// `Assistant#spawnTaskRefusal`'s body, the held-tree check is the lookup `jobs.create` refuses on, the unlanded-work
// note reads the row through `unfinishedTree`, the function the reuse recommendation decides with, and the LANE
// check is `laneRefusal` over `taskLaneHolders` - the same sentence the digest prints as `SKIP:` and the cut throws.
// A lane a person explicitly allowed is a NOTE (`ok: true`, `code: "lane_allowed"`), naming who allowed it and which
// file, because that is what the recorded exception is for.
//
// A tree is resolved by the cut's own resolver (`lib/spawn-target.js`), so a path, a worktree directory name and a
// branch all mean here what they mean in a `SPAWN IN` line. A tree the resolver cannot find is answered as a
// refusal, because that is what the cut would do.
import { resolveExistingTarget } from "../lib/spawn-target.js";

export const SPAWN_CHECK_PATH = "/api/assistant/spawn-check";

// The remedy for a tree the cut cannot resolve, in the cut's own terms: name one of the three spellings, or cut a
// new tree. Kept here because lib/spawn-target.js owns the RESOLUTION and this route owns the answer.
const RESOLVE_REMEDY =
  "name a path that exists, a worktree directory name, or a branch of that project, or write SPAWN without IN to cut a new tree";

export function createSpawnCheckRoutes({ assistant, getProjects = null, config = {}, sendJson, authorised } = {}) {
  if (!assistant) throw new Error("createSpawnCheckRoutes needs the Assistant instance");
  if (typeof sendJson !== "function" || typeof authorised !== "function") {
    throw new Error("createSpawnCheckRoutes needs sendJson and authorised from the server's transport");
  }
  const projectsOf = () => {
    if (typeof getProjects === "function") return getProjects() || [];
    if (typeof assistant.getProjects === "function") return assistant.getProjects() || [];
    return [];
  };
  return async function spawnCheckRoutes(req, res, route, url) {
    if (route !== SPAWN_CHECK_PATH) return false;
    if (req.method !== "GET") {
      sendJson(res, 405, { error: `${req.method} is not allowed on ${route}` });
      return true;
    }
    if (!authorised(req, config.token)) {
      sendJson(res, 403, { error: "bad or missing x-panel-token" });
      return true;
    }
    const task = String(url.searchParams.get("task") || "")
      .replace(/^#/, "")
      .trim();
    const tree = String(url.searchParams.get("tree") || "").trim();
    const project = String(url.searchParams.get("project") || "").trim();
    const assistantId = String(url.searchParams.get("assistantId") || "").trim();
    if (!task && !tree) {
      sendJson(res, 400, {
        ok: false,
        error: "pass task=<id>, tree=<path>, or both: a SPAWN with no row and no tree is checked by neither",
      });
      return true;
    }
    if (task && !/^\d+$/.test(task)) {
      sendJson(res, 400, {
        ok: false,
        error: `task is a queue row id (a whole number, with or without #) - got ${JSON.stringify(task)}`,
      });
      return true;
    }
    const projects = projectsOf();
    const named = project ? projects.find((p) => String(p.name).toLowerCase() === project.toLowerCase()) || null : null;
    if (project && !named) {
      const reason = `unknown project: ${project}`;
      sendJson(res, 200, {
        ok: false,
        reason,
        remedy: "name a project the panel has (GET /api/state lists them), or leave the project out and pass the tree's own path",
        checks: [{ check: "tree", code: "project-unknown", reason, remedy: RESOLVE_REMEDY }],
        task: task || null,
        project,
        tree: tree || null,
        resolved: null,
      });
      return true;
    }
    let resolved = null;
    if (tree) {
      resolved = await resolveExistingTarget({ target: tree, project: named, projects });
      if (!resolved.ok) {
        sendJson(res, 200, {
          ok: false,
          reason: resolved.error,
          remedy: RESOLVE_REMEDY,
          checks: [{ check: "tree", code: resolved.reason || "tree-unresolved", reason: resolved.error, remedy: RESOLVE_REMEDY }],
          task: task || null,
          project: project || null,
          tree,
          resolved: null,
        });
        return true;
      }
    }
    // The checks themselves: the cut's own functions, on the resolved tree. `spawnCheck` is ASYNC because the
    // disruption re-issue is allowed only on the runs API's own DEAD verdict (queue row 323), and the route awaits
    // that read rather than answering from the card's stale word.
    const out = await assistant.spawnCheck({
      assistantId: assistantId || null,
      taskId: task || null,
      project: project || resolved?.project || null,
      tree: resolved?.path || null,
    });
    sendJson(res, 200, {
      ...out,
      task: task || null,
      project: project || resolved?.project || null,
      tree: resolved?.path || null,
      resolved: resolved ? { asked: resolved.asked || tree, path: resolved.path, branch: resolved.branch || null, project: resolved.project || null } : null,
    });
    return true;
  };
}
