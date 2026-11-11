// Detached launcher with an acknowledgement containing the actual server pid, not the supervisor pid.
import path from "node:path";
import { existsSync, lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import panelLog from "../lib/panel-log.cjs";
import { resolveLayout } from "../lib/paths.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logs = resolveLayout({ here: root }).paths.logsDir;
try {
  const pidFile = path.join(logs, "server.pid");
  panelLog.validatePaths(pidFile, path.join(logs, "server.out.log"), path.join(logs, "server.err.log"));
  const legacyDir = path.join(root, "logs");
  const legacyPid = path.join(legacyDir, "server.pid");
  let candidate = pidFile;
  if (!existsSync(pidFile) && existsSync(legacyDir)) {
    const st = lstatSync(legacyDir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`unsafe legacy log directory: ${legacyDir}`);
    candidate = legacyPid;
  }
  const oldPid = panelLog.readPid(candidate);
  if (oldPid) {
    let alive = true;
    try { process.kill(oldPid, 0); } catch (e) { if (e.code === "ESRCH") alive = false; else if (e.code !== "EPERM") throw e; }
    if (alive) throw new Error(`already running as PID ${oldPid} -- use stop-background.cmd first`);
  }
  const { supervisor, pid } = await panelLog.launchSupervisor(path.join(root, "server.js"), pidFile, path.join(logs, "server.out.log"), path.join(logs, "server.err.log"));
  supervisor.disconnect();
  console.log(`started PID ${pid} -- log: ${path.join(logs, "server.out.log")}`);
} catch (e) {
  console.error(`could not start panel: ${e.message}`);
  process.exitCode = 1;
}
