// The Settings -> General "Storage & cleanup" prefix: what this panel's own machinery leaves on disk, and one bounded
// clean per target.
//
//   GET  /api/maintenance         no token, like every other Settings read — the three targets, their sizes, and a
//                                 read-only census of sandbox panels and test runners.
//   POST /api/maintenance/clean   { target, dryRun } — the panel token, like every other Settings write.
//
// The mount table in server.js matches on `MAINTENANCE_PATH`; `POST` lands on the same prefix (`/api/maintenance/clean`
// starts with it), and this module owns the exact compares. A path or method it does not answer returns `false`, so
// the chain's own 404 answers it, exactly as routes/settings.js does.
//
// NO TERMINATION ROUTE EXISTS, AND THERE MUST NOT BE ONE IN v1. `processes` is evidence for a human: pids, ages and CPU
// seconds. A coordinator sweep once matched the live panel's supervisor and took the live instance down; this module
// therefore imports nothing that can signal a pid and exposes no verb that could. See lib/process-census.js.
//
// The transport helpers (`sendJson`, `readBody`, `authorised`) and the live config travel in from the composition root,
// so this module owns no HTTP layer and a test can drive it with stubs. The work itself is lib/maintenance.js, and the
// census is lib/process-census.js.
import {
  MAINTENANCE_TARGET_IDS,
  cleanMaintenanceTarget,
  readMaintenanceTargets,
} from "../lib/maintenance.js";
import { processCensus } from "../lib/process-census.js";

/** The prefix the server's mount table matches on. */
export const MAINTENANCE_PATH = "/api/maintenance";
/** The one write. It shares the prefix above on purpose: one mount row owns both. */
export const MAINTENANCE_CLEAN_PATH = "/api/maintenance/clean";

export function createMaintenanceRoutes({
  getConfig,
  jobs = null,
  registry = null,
  here = "",
  configDir = "",
  sendJson,
  readBody,
  authorised,
  log = () => {},
  census = processCensus,
  now = Date.now,
} = {}) {
  const functions = { getConfig, sendJson, readBody, authorised, census };
  for (const [name, fn] of Object.entries(functions)) {
    if (typeof fn !== "function") throw new Error(`createMaintenanceRoutes needs ${name} from the composition root`);
  }

  // The folders a mistyped scratchDir could be an ancestor of: this checkout, the config's folder, the panel's own
  // state, its working folder, the scan roots and every project the registry knows. Asked per request because the
  // registry changes as projects come and go, and `scratchProblem` needs the CURRENT list, not a boot-time copy.
  const keepPaths = (config) => [
    here,
    configDir,
    config.stateDir,
    config.attachmentsDir,
    config.logsDir,
    config.defaultCwd,
    ...(Array.isArray(config.scanRoots) ? config.scanRoots : []),
    ...(Array.isArray(registry?.projects) ? registry.projects.map((p) => p && p.path) : []),
  ].filter(Boolean);

  const liveJobs = () => {
    try {
      return typeof jobs?.list === "function" ? jobs.list() : [];
    } catch {
      return [];
    }
  };

  return async function maintenanceRoutes(req, res, route) {
    if (route === MAINTENANCE_PATH && req.method === "GET") {
      const config = getConfig() || {};
      const at = now();
      // Both halves are measured on demand: the targets are a directory read each, the census one process-table read.
      const [targets, processes] = await Promise.all([
        readMaintenanceTargets({ config, jobs: liveJobs(), keep: keepPaths(config), now: at }),
        census({ ownPid: process.pid, now: at }),
      ]);
      sendJson(res, 200, { ok: true, targets, processes });
      return true;
    }

    if (route === MAINTENANCE_CLEAN_PATH && req.method === "POST") {
      const config = getConfig() || {};
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = (await readBody(req).catch(() => ({}))) || {};
      const target = String(body.target || "").trim();
      if (!MAINTENANCE_TARGET_IDS.includes(target)) {
        sendJson(res, 400, { error: `target must be one of: ${MAINTENANCE_TARGET_IDS.join(", ")}` });
        return true;
      }
      // The same safe default the project cleanup uses: anything but a literal `false` is a dry run, so a caller that
      // forgets the flag cannot delete a file by accident.
      const dryRun = body.dryRun !== false;
      const out = await cleanMaintenanceTarget({
        target,
        config,
        jobs: liveJobs(),
        keep: keepPaths(config),
        dryRun,
        now: now(),
      });
      log(
        `maintenance: ${dryRun ? "dry run" : "clean"} ${target} — ${
          out.refused
            ? `refused: ${out.refused}`
            : `${out.removedFiles} file(s), ${out.removedBytes} byte(s) removed, ${out.remaining} remaining (${out.ms} ms)`
        }`,
      );
      // A refusal is a 409 with the reason in `refused`; the shape stays the contract's — `ok` is true because the
      // request was answered, not because anything was deleted.
      sendJson(res, out.refused ? 409 : 200, out);
      return true;
    }

    return false;
  };
}
