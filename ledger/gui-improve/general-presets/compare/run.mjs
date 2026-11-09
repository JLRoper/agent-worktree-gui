// gui-improve compare — boots a throwaway instance of THIS checkout, captures the AFTER set, then diffs.
//
// Usage (from the worktree root):
//   PLAYWRIGHT_BROWSERS_PATH=C:/Users/roper/AppData/Local/ms-playwright \
//   NODE_PATH=C:/Users/roper/AppData/Roaming/npm/node_modules \
//   node ledger/gui-improve/compare/run.mjs
//
// The instance is a sandbox from tools/panel-testkit.mjs: its own PANEL_CONFIG and store under the scratch dir,
// no projects, assistant/gateway off. It never touches the live panel on 7331, and nothing is written outside
// this worktree's ledger/ and the scratch dir.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startPanel } from "../../../tools/panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const SCRATCH = process.env.GUI_COMPARE_SCRATCH || "C:/Users/roper/AppData/Local/Temp/wag/349317f5";
const PORT = Number(process.env.GUI_COMPARE_PORT || 7393);

const run = (script, env = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited ${code ?? signal}`));
    });
  });

const panel = await startPanel({
  root: ROOT,
  port: PORT,
  dir: path.join(SCRATCH, "panel"),
  keep: true,
  config: {
    threads: 3,
    worktreeSeconds: 15,
    briefingBudgetChars: 0,
    fetchSeconds: 1800,
    refreshSeconds: 60,
    projects: [],
    matrix: { autoStart: false },
  },
});

try {
  const health = await (await fetch(new URL("api/health", panel.base + "/"))).json().catch(() => null);
  const cfg = await (await fetch(new URL("api/config", panel.base + "/"))).json();
  console.log(JSON.stringify({ base: panel.base, port: panel.port, dir: panel.dir, version: cfg.version, health }, null, 2));
  await run("ledger/gui-improve/compare/capture.mjs", { PANEL_BASE: panel.base + "/" });
  await run("ledger/gui-improve/compare/diff.mjs");
} finally {
  await panel.stop();
  console.log("panel stopped");
}
