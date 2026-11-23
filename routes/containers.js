// The panel's container action: what a tree left running, and the press that stops and removes it.
//
//   GET  /api/containers?tree=<path>   every labelled container this panel can see, for one tree or for all of them
//   POST /api/containers/teardown      { tree, dryRun? } -> stop and remove every container carrying that tree's label
//
// WHY A ROUTE. The settle cleanup (lib/jobs.js -> lib/container-teardown.js) covers the tree a run just ended in. This
// is the same teardown ON DEMAND, for a tree whose run is long gone: a released worktree whose containers outlived it,
// a tree a worker left one container behind in, a reader who wants the list before the press. It is one read and one
// write, neither of which belongs on the board's polling path, so neither is a field of the snapshot.
//
// THE TREE IS THE WHOLE KEY, and it is exact: lib/container-teardown.js matches the wag.worktree label in the panel's
// own tree spelling. A missing or relative tree is a 400 - a guessed key would silently clean nothing, and the reader
// would read that silence as "nothing was running".
//
// `dryRun: true` answers the plan and touches nothing. Any other body ACTS, because a press on a teardown route is
// already the decision; the write is authorised like every other write on this panel, and a loopback request with no
// token passes (the same door as the rest).
import { labelledFor, labelTree, listLabelled, teardownPlan, teardownTree } from "../lib/container-teardown.js";
import { normTree } from "../lib/push-guard.js";

/** The read, and the one write under it. */
export const CONTAINERS_PATH = "/api/containers";
export const CONTAINERS_TEARDOWN_PATH = "/api/containers/teardown";

const wire = (c) => ({ id: c.id, name: c.name, running: c.running, tree: c.tree, row: c.row });

export function createContainerRoutes({
  getConfig = () => ({}),
  sendJson,
  readBody,
  authorised,
  log = () => {},
  list = null,
  teardown = null,
} = {}) {
  if (typeof sendJson !== "function" || typeof readBody !== "function" || typeof authorised !== "function") {
    throw new Error("createContainerRoutes needs sendJson, readBody and authorised from the server's transport");
  }

  return async function containerRoutes(req, res, route, url) {
    if (route !== CONTAINERS_PATH && route !== CONTAINERS_TEARDOWN_PATH) return false;

    if (route === CONTAINERS_PATH) {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: `${req.method} is not allowed on ${route} - use GET` });
        return true;
      }
      const asked = String(url?.searchParams?.get("tree") || "").trim();
      if (asked && !normTree(asked)) {
        sendJson(res, 400, { error: `the tree must be an absolute path - got ${JSON.stringify(asked)}` });
        return true;
      }
      const found = list ? await list({ all: true }) : await listLabelled({ all: true });
      if (!found.ok) {
        sendJson(res, 502, { tree: labelTree(asked) || null, error: found.error || "docker did not answer", containers: [] });
        return true;
      }
      const containers = asked ? labelledFor(found.containers, asked) : found.containers;
      sendJson(res, 200, { ok: true, tree: labelTree(asked) || null, containers: containers.map(wire) });
      return true;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: `${req.method} is not allowed on ${route} - use POST with { tree, dryRun }` });
      return true;
    }
    if (!authorised(req, (getConfig() || {}).token)) {
      sendJson(res, 403, { error: "bad or missing x-panel-token" });
      return true;
    }
    const body = await readBody(req).catch(() => ({}));
    const asked = String(body?.tree || "").trim();
    if (!asked) {
      sendJson(res, 400, { error: 'a tree is required - {"tree": "<the worktree\'s absolute path>"}' });
      return true;
    }
    if (!normTree(asked)) {
      sendJson(res, 400, { error: `the tree must be an absolute path - got ${JSON.stringify(asked)}` });
      return true;
    }
    const tree = labelTree(asked);
    if (body?.dryRun === true) {
      const found = list ? await list({ all: true }) : await listLabelled({ all: true });
      if (!found.ok) {
        sendJson(res, 502, { dryRun: true, tree, error: found.error || "docker did not answer", containers: [] });
        return true;
      }
      const plan = teardownPlan(found.containers, tree);
      sendJson(res, 200, {
        ok: true,
        dryRun: true,
        tree,
        containers: plan.matched.map(wire),
        wouldStop: plan.stop.length,
        wouldRemove: plan.remove.length,
        stopped: [],
        removed: [],
        left: [],
      });
      return true;
    }
    const out = teardown ? await teardown(tree) : await teardownTree(tree, { log });
    if (!out || out.ok !== true) log(`containers: teardown for ${tree} failed: ${(out && out.error) || "unknown error"}`);
    sendJson(res, out && out.ok === true ? 200 : 502, { ...(out || { ok: false, error: "the teardown did not answer" }), dryRun: false, tree });
    return true;
  };
}
