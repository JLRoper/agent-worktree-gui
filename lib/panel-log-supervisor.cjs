// Own the pipes, not the panel's stdout/stderr file handles: Windows can then rename closed log files.
"use strict";
const path = require("node:path");
const { spawn } = require("node:child_process");
const { RotatingPanelLog, acquire, validatePaths, writePid } = require("./panel-log.cjs");

const [serverPath, pidFile, outLog, errLog] = process.argv.slice(2);
let child;
let release;
let log;
let timer;
let finished = false;
let childClosed = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child?.pid) return finish(new Error(`stopped by ${signal}`));
    child.kill();
    const deadline = setTimeout(() => { if (!childClosed) child.kill("SIGKILL"); }, 2000);
    deadline.unref();
  });
}

function finish(error) {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  if (error && log) {
    try { log.write("err", `panel-log-supervisor: ${String(error.message || error)}\n`); } catch { /* storage itself failed */ }
  }
  if (error && child?.pid) child.kill();
  try { release?.(); } catch (e) { error ||= e; }
  if (error && process.connected) process.send({ error: String(error.message || error) }, () => process.exit(1));
  else process.exit(error ? 1 : 0);
}

async function main() {
  const dir = validatePaths(pidFile, outLog, errLog);
  release = await acquire(dir);
  // Recheck after the lock, including against a log path substituted while waiting.
  validatePaths(pidFile, outLog, errLog);
  log = new RotatingPanelLog(dir);
  const env = { ...process.env };
  delete env.PANEL_PARENT_WATCH_STDIN;
  child = spawn(process.execPath, [serverPath], {
    cwd: path.dirname(path.resolve(serverPath)), windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"], env,
  });
  child.once("error", finish);
  child.stdout.on("data", (data) => { try { log.write("out", data); } catch (e) { finish(e); } });
  child.stderr.on("data", (data) => { try { log.write("err", data); } catch (e) { finish(e); } });
  child.stdout.on("error", finish);
  child.stderr.on("error", finish);
  child.once("spawn", () => {
    try {
      validatePaths(pidFile, outLog, errLog);
      writePid(pidFile, child.pid);
      if (process.connected) process.send({ pid: child.pid });
    } catch (e) { finish(e); }
  });
  // A descendant may inherit a pipe. Do not keep the old logger and its lock forever after the panel exits.
  child.once("exit", (code, signal) => {
    if (code !== 0 || signal) {
      try { log.write("err", `panel-log-supervisor: panel ${child.pid} exited (${signal || `code ${code}`})\n`); } catch (e) { return finish(e); }
    }
    const deadline = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, 2000);
    deadline.unref();
  });
  child.once("close", () => { childClosed = true; if (!process.connected) finish(); });
  process.on("disconnect", () => { if (childClosed) finish(); });
  process.on("message", (msg) => {
    if (msg && typeof msg.log === "string") {
      try { log.write("out", msg.log); if (process.connected) process.send({ logged: true }); } catch (e) { finish(e); }
    }
  });
  timer = setInterval(() => { try { log.tick(); } catch (e) { finish(e); } }, 1000);
  timer.unref();
}

main().catch(finish);
