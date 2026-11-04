// ---- the Matrix bridge, from the panel's side ---------------------------------------------------
// A two-way Matrix <-> Hermes bridge already exists as a standalone Python program: it logs in, syncs
// E2EE rooms and shells out to the local Hermes CLI. None of that protocol work belongs here. What this
// module owns is the process LIFECYCLE around it, because the thing that starts it has to be the thing
// that can stop it:
//
//   start   spawn <pythonPath> <scriptPath> detached, windowsHide, an ARGV ARRAY and never a shell
//           string, with stdout+stderr appended to `<logsDir>/matrix-bridge.log`
//   state   whether the pid this panel recorded is a LIVE process, the paths, the room, and the log tail
//   stop    the process TREE (Windows: `taskkill /T /F`, so the Hermes CLI it spawned goes too)
//   test    `<pythonPath> <scriptPath> --self-test`, whose exit code is the answer
//
// Three facts shape the whole file:
//
//   1. A STALE PID FILE IS NOT A RUNNING BRIDGE. The pid file outlives the process it names (a crash, a
//      reboot, a task kill), so liveness is asked of the OS (`process.kill(pid, 0)` — the check the
//      panel's own restart controller already uses), never of the file's existence. A dead record is
//      reported as `stalePid`, cleared by the next start or stop, and never counts as running.
//   2. THE PANEL NEVER READS bridge.env. The credentials live beside the script and are the bridge's
//      own business; `credentialsPresent` is `existsSync` on that path and NOTHING else — no open, no
//      parse, no field of it in any answer. A password cannot leak through a file nobody reads.
//   3. THE PANEL NEVER STARTS IT ON ITS OWN. Nothing here runs at boot: `start()` is only ever reached
//      from POST /api/settings/matrix/start, and `--self-test` (a read-only config/dependency check)
//      only from POST /api/settings/matrix/test.
//
// The config block carries paths and the room id and nothing else. `matrixConfig` returns exactly
// those three keys, so a password pasted into config.json by mistake is not carried into any answer.
import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { statePaths } from "./paths.js";

const execFileP = promisify(execFile);

// What a `matrix` block may carry, in the order the tab shows them. `roomId` is not a secret (it is an
// opaque `!room:server` address), but the password is — and it belongs in bridge.env only. This list IS the
// filter: `matrixConfig` builds its answer by walking it, so a key nobody named here (a password pasted into
// config.json by mistake) cannot reach a route, a log line or the page.
export const MATRIX_KEYS = ["scriptPath", "pythonPath", "roomId"];

// A config with no `matrix` block is a panel that has never been pointed at a bridge: every field is an
// empty string and the tab says so instead of guessing a path that belongs to one machine.
export function matrixConfig(raw) {
  const block = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const key of MATRIX_KEYS) out[key] = String(block[key] == null ? "" : block[key]).trim();
  return out;
}

// Is `pid` a process this machine still has? `kill(pid, 0)` sends no signal and answers the only
// question asked here. EPERM means "alive, but not mine to signal", which is still alive; ESRCH is gone.
// A pid the OS has RECYCLED reads as alive too — that is the limit of a pid file, and it is the same
// check lib/restart.js asks before it signals a gateway.
export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return String((e && e.code) || "") === "EPERM";
  }
}

// The last `count` non-empty lines of a log, read from the END of the file: a bridge left running for a
// week can write megabytes, and a settings poll must not pull all of them into memory to show forty.
export function tailLines(file, count = 40) {
  const MAX_BYTES = 256 * 1024;
  let text = "";
  try {
    const size = statSync(file).size;
    const from = Math.max(0, size - MAX_BYTES);
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - from);
      readSync(fd, buf, 0, buf.length, from);
      text = buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  // A chunk cut mid-line loses only the partial first line, and the tail keeps the newest `count` whole
  // ones. `\r?` because the child may write CRLF (a Windows Python) or LF.
  const lines = text.split(/\r?\n/).filter((line) => line.length);
  return lines.slice(-Math.max(1, count));
}

export class MatrixBridge {
  // `sleep` is injectable so a test can run the wait the stop path does without spending its seconds.
  constructor({ config = {}, onLog = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.config = config;
    const paths = statePaths(config);
    // The config keys win (a sandbox names its own files), and lib/paths.js derives the rest — this module
    // never builds a state path from a literal.
    this.pidFile = config.matrixPidFile || paths.matrixPidFile;
    this.logFile = config.matrixLogFile || paths.matrixLogFile;
    this.onLog = onLog;
    this.sleep = sleep;
    // The last `--self-test` this process ran, and the one request that is running it now. The browser only
    // ever sees the RESULT: a GET must never spawn a Python process, or every settings poll would.
    this.lastSelfTest = null;
    this.testing = null;
  }

  get settings() {
    return matrixConfig(this.config.matrix);
  }

  // The record the panel wrote when it spawned the bridge. A hand-edited or half-written file reads as no
  // record at all — the only thing a pid file may do is name a pid, and a guess here is a kill elsewhere.
  readPid() {
    try {
      const doc = JSON.parse(readFileSync(this.pidFile, "utf8"));
      const pid = Number(doc && doc.pid);
      if (!Number.isInteger(pid) || pid <= 0) return null;
      return { ...doc, pid };
    } catch {
      return null;
    }
  }

  writePid(pid, settings) {
    mkdirSync(path.dirname(this.pidFile), { recursive: true });
    // Written beside the target and renamed over it: a GET that lands in the same tick as a start must read the
    // whole record or none, never half of one (the same rule config.json's writer follows).
    const tmp = `${this.pidFile}.${process.pid}.tmp`;
    writeFileSync(
      tmp,
      `${JSON.stringify({ pid, startedAt: new Date().toISOString(), scriptPath: settings.scriptPath, pythonPath: settings.pythonPath }, null, 2)}\n`,
      "utf8",
    );
    renameSync(tmp, this.pidFile);
  }

  clearPid() {
    try {
      unlinkSync(this.pidFile);
      return true;
    } catch {
      return false;
    }
  }

  // bridge.env sits beside the script. This is the WHOLE of the panel's knowledge about it: whether the
  // file is there. No key is read, and no value derived from it is ever put in an answer.
  credentialsPresent() {
    const { scriptPath } = this.settings;
    if (!scriptPath) return false;
    return existsSync(path.join(path.dirname(scriptPath), "bridge.env"));
  }

  // The GET answer, and the shape every POST answers with after acting: one object, so the page never has
  // to merge two half-truths. `pid` is the LIVE pid or null; `stalePid` names a record whose process is
  // gone, which is then cleared lazily rather than trusted.
  state() {
    const settings = this.settings;
    const rec = this.readPid();
    const live = Boolean(rec && pidAlive(rec.pid));
    return {
      running: live,
      pid: live ? rec.pid : null,
      stalePid: rec && !live ? rec.pid : null,
      ...settings,
      scriptPresent: Boolean(settings.scriptPath) && existsSync(settings.scriptPath),
      pythonPresent: Boolean(settings.pythonPath) && existsSync(settings.pythonPath),
      credentialsPresent: this.credentialsPresent(),
      pidFile: this.pidFile,
      logFile: this.logFile,
      // Forty lines of the child's own stdout+stderr. `{ ok: null, output: "" }` until somebody presses
      // Run self-test: the panel does not run one on its own, and a GET must not start a process.
      selfTest: this.lastSelfTest || { ok: null, output: "", exitCode: null, at: null },
      log: tailLines(this.logFile, 40),
    };
  }

  // Spawn the bridge. Refusals come back with a status so the route can answer 409/400 without a second
  // check, and they always carry the full state: the page repaints from whichever answer it got.
  async start() {
    const settings = this.settings;
    const before = this.state();
    if (before.running) {
      return { status: 409, ...before, error: `the bridge is already running (pid ${before.pid}) — press Stop before starting it again` };
    }
    if (!settings.scriptPath) {
      return { status: 400, ...before, error: "no bridge script is configured — set matrix.scriptPath in config.json" };
    }
    if (!before.scriptPresent) {
      return { status: 400, ...before, error: `the bridge script is not at ${settings.scriptPath} — set matrix.scriptPath in config.json` };
    }
    if (!settings.pythonPath) {
      return { status: 400, ...before, error: "no interpreter is configured — set matrix.pythonPath in config.json" };
    }
    if (!before.pythonPresent) {
      return { status: 400, ...before, error: `the interpreter is not at ${settings.pythonPath} — set matrix.pythonPath in config.json` };
    }
    // A dead run's record is removed BEFORE the spawn, so the new child is the only pid file this start can
    // produce and a start that dies cannot leave the old one looking like it.
    this.clearPid();
    mkdirSync(path.dirname(this.logFile), { recursive: true });
    // The log is per-run history, not an append-only ledger: keep it, but cap it, so a bridge restarted for a
    // week cannot grow a file the settings poll has to bisect.
    try {
      if (statSync(this.logFile).size > 5 * 1024 * 1024) writeFileSync(this.logFile, "", "utf8");
    } catch {
      /* no log yet */
    }
    const fd = openSync(this.logFile, "a");
    let child;
    try {
      writeFileSync(fd, `\n=== ${new Date().toISOString()} panel start: ${settings.pythonPath} ${settings.scriptPath} ===\n`, "utf8");
      // An argv array and `windowsHide`, exactly like the panel's other detached spawns. `detached` is the
      // point: the bridge must outlive this request, and a panel restart must not take the bot offline.
      child = spawn(settings.pythonPath, [settings.scriptPath], {
        cwd: path.dirname(settings.scriptPath),
        detached: true,
        windowsHide: true,
        stdio: ["ignore", fd, fd],
        env: { ...process.env },
      });
    } catch (e) {
      return { status: 500, ...this.state(), error: `could not start ${settings.pythonPath}: ${String((e && e.message) || e)}` };
    } finally {
      // The child holds its own copy of the handle; the parent's is closed before this request returns.
      closeSync(fd);
    }
    child.on("error", (e) => this.onLog(`matrix bridge: ${String((e && e.message) || e)}`));
    if (!child.pid) {
      return { status: 500, ...this.state(), error: `could not start ${settings.pythonPath} — the OS gave no pid` };
    }
    child.unref();
    this.writePid(child.pid, settings);
    this.onLog(`matrix bridge started (pid ${child.pid}): ${settings.pythonPath} ${settings.scriptPath}`);
    // A child that dies at once (a missing dependency, a syntax error, a bad bridge.env) must not be reported
    // as running: the pid is checked once the interpreter has had a moment, and the log tail says why.
    const died = await this.exitedWithin(child, 800);
    if (died) {
      this.clearPid();
      const after = this.state();
      const why = after.log.slice(-3).join(" · ") || "no output";
      return { status: 502, ...after, error: `the bridge exited ${died.ms}ms after it started (${died.how}) — ${why}` };
    }
    return { status: 200, ...this.state(), started: true };
  }

  // Resolve true when the child is gone within `ms`. `exit` is the normal path; `error` covers a binary the
  // OS could not execute at all, which never produces a pid worth keeping.
  exitedWithin(child, ms) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (how, code, signal, at) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ms: Date.now() - at, how: `${how}${code == null ? "" : ` ${code}`}${signal ? ` ${signal}` : ""}` });
      };
      const at = Date.now();
      const timer = setTimeout(() => {
        done = true;
        resolve(null);
      }, ms);
      child.once("exit", (code, signal) => finish("exited", code, signal, at));
      child.once("error", (e) => finish("failed", String((e && e.code) || e.message), null, at));
      if (!pidAlive(child.pid)) finish("no pid", null, null, at);
    });
  }

  // Stop the process tree. Nothing running is a success with a sentence, never an error: the button is safe
  // to press on an empty board, and a second press after a stop says so plainly.
  async stop() {
    const rec = this.readPid();
    if (!rec) {
      const after = this.state();
      return { status: 200, ...after, stopped: false, note: "nothing was running — there is no pid file to stop" };
    }
    if (!pidAlive(rec.pid)) {
      this.clearPid();
      const after = this.state();
      return { status: 200, ...after, stopped: false, note: `pid ${rec.pid} was already gone — the stale pid file has been cleared` };
    }
    const killed = await this.killTree(rec.pid);
    const until = Date.now() + 10_000;
    while (Date.now() < until && pidAlive(rec.pid)) await this.sleep(150);
    const alive = pidAlive(rec.pid);
    if (!alive) this.clearPid();
    const after = this.state();
    if (alive) {
      return { status: 500, ...after, stopped: false, error: `pid ${rec.pid} is still running after ${killed.how}` };
    }
    this.onLog(`matrix bridge stopped (pid ${rec.pid}) via ${killed.how}`);
    return { status: 200, ...after, stopped: true, note: `stopped pid ${rec.pid} (${killed.how})` };
  }

  // The process TREE, not just the pid: a bridge that shells out to the Hermes CLI has children, and leaving
  // them behind leaves a bot answering half of its messages. Windows is `taskkill /T /F`; elsewhere the
  // child was spawned detached (its own process group), so the group gets the polite signal first.
  async killTree(pid) {
    if (process.platform === "win32") {
      try {
        await execFileP("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 15_000 });
        return { how: "taskkill /T /F" };
      } catch (e) {
        // 128 is taskkill's "no such process": the tree went between the liveness check and this call.
        if (!pidAlive(pid)) return { how: "taskkill (already gone)" };
        return { how: `taskkill failed: ${String((e && e.message) || e)}` };
      }
    }
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* gone between the check and the signal */
      }
    }
    const until = Date.now() + 5_000;
    while (Date.now() < until && pidAlive(pid)) await this.sleep(150);
    if (!pidAlive(pid)) return { how: "SIGTERM" };
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* it may have gone in the gap */
      }
    }
    return { how: "SIGTERM then SIGKILL" };
  }

  // `<pythonPath> <scriptPath> --self-test`: the bridge's own checks (config, matrix-nio, the hermes binary),
  // no network, exit 0 when they pass. One at a time — a reader who presses the button twice gets the run
  // already in flight rather than a second interpreter.
  async selfTest() {
    if (this.testing) return this.testing;
    this.testing = this.runSelfTest().finally(() => {
      this.testing = null;
    });
    return this.testing;
  }

  async runSelfTest() {
    const settings = this.settings;
    const at = new Date().toISOString();
    const started = Date.now();
    const refuse = (why) => {
      this.lastSelfTest = { ok: false, exitCode: null, output: why, at, ms: 0 };
      return this.lastSelfTest;
    };
    if (!settings.scriptPath) return refuse("no bridge script is configured — set matrix.scriptPath in config.json");
    if (!existsSync(settings.scriptPath)) return refuse(`the bridge script is not at ${settings.scriptPath}`);
    if (!settings.pythonPath) return refuse("no interpreter is configured — set matrix.pythonPath in config.json");
    if (!existsSync(settings.pythonPath)) return refuse(`the interpreter is not at ${settings.pythonPath}`);
    let res;
    try {
      const out = await execFileP(settings.pythonPath, [settings.scriptPath, "--self-test"], {
        cwd: path.dirname(settings.scriptPath),
        windowsHide: true,
        timeout: 45_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env },
      });
      res = { ok: true, exitCode: 0, output: `${out.stdout || ""}${out.stderr || ""}`.trim() };
    } catch (e) {
      // execFile rejects on a non-zero exit AND on a timeout; both carry what the child managed to print.
      const code = typeof (e && e.code) === "number" ? e.code : null;
      const printed = `${(e && e.stdout) || ""}${(e && e.stderr) || ""}`.trim();
      const why = (e && e.killed) ? `the self-test was killed after the ${Math.round(45_000 / 1000)}s budget` : String((e && e.message) || e);
      res = { ok: false, exitCode: code, output: printed || why };
    }
    this.lastSelfTest = { ...res, at, ms: Date.now() - started };
    this.onLog(`matrix bridge self-test: ${res.ok ? "ok" : `FAILED (exit ${res.exitCode == null ? "?" : res.exitCode})`}`);
    return this.lastSelfTest;
  }
}
