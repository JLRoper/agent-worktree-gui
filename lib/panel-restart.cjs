// The detached helper a panel restart leaves behind.
//
// The panel cannot spawn its own replacement and then exit: the replacement would try to bind the port the
// outgoing process is still holding, and the restart would leave the board down. So the panel starts THIS
// process detached instead, and it waits for the outgoing pid to disappear before launching server.js.
//
//   node lib/panel-restart.cjs <server.js> <server.pid> <out.log> <err.log> <parentPid>
//
// It writes the new process's pid into the pid file (the same file start-background.cmd and
// stop-background.cmd use), appends the replacement's output to the panel's own logs, and exits.
"use strict";
const { spawn } = require("node:child_process");
const { mkdirSync, openSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const [serverPath, pidFile, outLog, errLog, parentPidArg] = process.argv.slice(2);
const parentPid = Number(parentPidArg) || 0;
const waitMaxMs = Number(process.env.HERMES_PANEL_RESTART_WAIT_MS) || 60_000;

const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM"; // exists but not ours to signal
  }
};

const launch = () => {
  const root = path.dirname(path.resolve(serverPath));
  mkdirSync(path.dirname(outLog), { recursive: true });
  const out = openSync(outLog, "a");
  const err = openSync(errLog, "a");
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, err],
    env: { ...process.env },
  });
  child.unref();
  try {
    writeFileSync(pidFile, String(child.pid));
  } catch {
    /* the pid file is a convenience for the stop script */
  }
  try {
    process.stdout.write(`panel-restart: launched ${serverPath} as pid ${child.pid}\n`);
  } catch {
    /* no console */
  }
  process.exit(0);
};

const tick = () => {
  if (!alive(parentPid)) return launch();
  if (Date.now() - started > waitMaxMs) return launch(); // a stuck exit must not leave the board down
  setTimeout(tick, 200).unref();
};

const started = Date.now();
tick();
setTimeout(() => {}, waitMaxMs + 5_000); // keep the process alive while it waits