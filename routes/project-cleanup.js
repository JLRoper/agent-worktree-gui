// The cleanup route behind the project card's chip.
//
//   POST /api/projects/:id/cleanup   { dryRun: true }   -> the plan, and the page it wrote
//   POST /api/projects/:id/cleanup   { dryRun: false }  -> the plan applied, what each row did, and the page
//
// WHY A ROUTE and not another field on the snapshot: a plan is a READ of every tree of one project (a `git status`,
// a `rev-list` and a `git cherry` per tree), and an apply is a WRITE that removes worktrees and writes refs. Neither
// belongs on the board's polling path. The chip asks for one project, on a press, and the answer carries everything
// the bar and the page need.
//
// `dryRun` is OPT-IN to the write: anything that is not the literal `false` is a dry run, so a caller that forgets
// the flag cannot delete a tree by accident.
//
// The route owns the wire shape and the status codes only. The plan is lib/cleanup-plan.js, the measuring and the
// acts are lib/cleanup-run.js, the remover is lib/worktree-remove.js (injected by the composition root, which owns
// the platform and the panel's own switches), and the page is lib/cleanup-report.js.
import { applyCleanup, readCleanup } from "../lib/cleanup-run.js";
import { renderCleanupReport, reportRelPath, writeCleanupReport } from "../lib/cleanup-report.js";

/** The prefix the server's mount table matches on, and the one path this module answers. */
export const CLEANUP_PREFIX = "/api/projects/";
export const CLEANUP_PATH_RE = /^\/api\/projects\/([^/]+)\/cleanup$/;

export function createProjectCleanupRoutes({
  getConfig = () => ({}),
  registry,
  jobs = null,
  locks = null,
  removeTree,
  sendJson,
  readBody,
  authorised,
  log = () => {},
  ownPath = () => process.cwd(),
  platform = process.platform,
  onApplied = () => {},
} = {}) {
  if (!registry) throw new Error("createProjectCleanupRoutes needs registry from the composition root");
  if (typeof sendJson !== "function" || typeof readBody !== "function" || typeof authorised !== "function") {
    throw new Error("createProjectCleanupRoutes needs sendJson, readBody and authorised from the server's transport");
  }

  return async function projectCleanupRoutes(req, res, route, url) {
    const match = CLEANUP_PATH_RE.exec(String(route || ""));
    if (!match) return false;
    if (req.method !== "POST") {
      sendJson(res, 405, { error: `${req.method} is not allowed on ${route} - use POST with { dryRun }` });
      return true;
    }
    const name = decodeURIComponent(match[1]);
    // The live config, asked for per request: POST /api/reload replaces the object and the token lives on it.
    if (!authorised(req, (getConfig() || {}).token)) {
      sendJson(res, 403, { error: "bad or missing x-panel-token" });
      return true;
    }
    const body = await readBody(req).catch(() => ({}));
    const dryRun = body?.dryRun !== false;
    const project = (registry.projects || []).find((p) => p.name === name) || null;
    if (!project) {
      sendJson(res, 404, { error: `unknown project: ${name}` });
      return true;
    }

    const read = await readCleanup({ project, jobs, locks, ownPath: ownPath() });
    if (!read.ok) {
      log(`cleanup: could not read ${project.name}: ${read.error}`);
      sendJson(res, 502, { project: project.name, dryRun, error: read.error });
      return true;
    }

    const at = new Date();
    if (dryRun) {
      // A dry run still leaves the page behind: the first press has to produce something the reader can open, and
      // the plan is written by the same renderer the apply uses.
      const reportPath = reportRelPath(at);
      const html = renderCleanupReport({ project, plan: read.plan, run: null, at, reportPath });
      const written = await writeCleanupReport({ repo: project.path, html, at });
      sendJson(res, 200, {
        ok: true,
        project: project.name,
        dryRun: true,
        plan: read.plan,
        report: written.ok ? { path: written.path, absPath: written.absPath, bytes: written.bytes, error: null } : { path: null, absPath: null, bytes: 0, error: written.error },
      });
      return true;
    }

    const run = await applyCleanup({
      project,
      plan: read.plan,
      jobs,
      locks,
      removeTree,
      platform,
      onLog: log,
      now: at,
    });
    if (!run.ok) {
      sendJson(res, 500, { project: project.name, dryRun: false, error: run.error, plan: read.plan });
      return true;
    }
    const reportPath = reportRelPath(at);
    const html = renderCleanupReport({ project, plan: read.plan, run, at, reportPath });
    const written = await writeCleanupReport({ repo: project.path, html, at });
    // The board only repaints rows it is told about: a removed tree needs the same `drop` event the row's x sends,
    // and a merge writes a ref no row carries yet. The composition root owns both, so it is told here.
    try {
      onApplied({ project: project.name, rows: run.rows });
    } catch (e) {
      log(`cleanup: the board could not be told about ${project.name}'s run (${String((e && e.message) || e)})`);
    }
    sendJson(res, 200, {
      ok: true,
      project: project.name,
      dryRun: false,
      plan: read.plan,
      run: { rows: run.rows, counts: run.counts, main: run.main },
      report: written.ok ? { path: written.path, absPath: written.absPath, bytes: written.bytes, error: null } : { path: null, absPath: null, bytes: 0, error: written.error },
    });
    return true;
  };
}
