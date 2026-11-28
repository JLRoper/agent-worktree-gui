// The Settings -> General "Storage & cleanup" prefix: what this panel's own machinery leaves on disk, and one bounded
// clean per target.
//
//   GET  /api/maintenance         no token, like every other Settings read — the five targets, their sizes, and a
//                                 read-only census of sandbox panels and test runners.
//   POST /api/maintenance/clean   { target, dryRun, olderThanHours? } — the panel token, like every other Settings
//                                 write. `olderThanHours` applies to `hermes-sessions` only; the lib clamps it.
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
// so this module owns no HTTP layer and a test can drive it with stubs. The work itself is lib/maintenance.js, the
// census is lib/process-census.js, and the two Hermes targets delegate to the `hermes` CLI through
// lib/hermes-maintenance.js (`runHermes` is injected here exactly like `census`, so a test never prunes a real store).
import { runHermesCli } from "../lib/hermes-maintenance.js";
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
  // The two Hermes targets: where its home is, and the CLI runner. `runHermes` is the same seam `census` is — a
  // test hands in a canned dry-run table rather than pruning a real 8 GB store. `hermes.bin` may be null to pin
  // "the binary is missing" without touching this machine's PATH.
  hermes = {},
  runHermes = runHermesCli,
} = {}) {
  const functions = { getConfig, sendJson, readBody, authorised, census, runHermes };
  for (const [name, fn] of Object.entries(functions)) {
    if (typeof fn !== "function") throw new Error(`createMaintenanceRoutes needs ${name} from the composition root`);
  }

  // The census walks the whole process table (2-3 s on Windows) and the section can be re-read while a reader
  // refreshes it; the process list does not need to be live to the second, while the FILE SIZES do. So only the
  // census is memoised — the targets are measured on every read — and a census that throws is never remembered.
  const CENSUS_TTL_MS = 30_000;
  let censusAt = 0;
  let censusValue = null;
  const censusCached = async (options) => {
    if (censusValue !== null && now() - censusAt < CENSUS_TTL_MS) return censusValue;
    const value = await census(options);
    censusValue = value;
    censusAt = now();
    return value;
  };

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
        readMaintenanceTargets({ config, jobs: liveJobs(), keep: keepPaths(config), now: at, hermes }),
        censusCached({ ownPid: process.pid, now: at }),
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
        hermes,
        runHermes,
        // Only the session target reads it, and the lib clamps it (default 24h, 1..8760) — the route does not
        // second-guess a body field whose meaning belongs to that target.
        olderThanHours: body.olderThanHours,
      });
      log(
        `maintenance: ${dryRun ? "dry run" : "clean"} ${target} — ${
          out.refused
            ? `refused: ${out.refused}`
            : `${out.removedFiles} file(s), ${out.removedBytes} byte(s) removed, ${out.remaining} remaining (${out.ms} ms)`
        }`,
      );
      // A refusal answers 200 with the reason in `refused`: the request WAS answered and nothing was deleted — which is
      // what `ok: true` relays — and the General tab paints that sentence in red (`maintenanceResultText`). Only a bad
      // request (an unknown target, a missing token) is a non-2xx.
      sendJson(res, 200, out);
      return true;
    }

    return false;
  };
}
