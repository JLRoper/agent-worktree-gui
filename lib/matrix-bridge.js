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
//   3. THE PANEL STARTS IT AT BOOT ONLY WHEN ASKED TO. `matrix.autoStart` (default true) spawns the bridge
//      once, during server boot, when credentials are present and no live pid is recorded; `false` leaves it
//      off until somebody presses Start. A boot spawn that FAILS is kept as `state().boot` — the Gateway tab
//      draws it — because a background spawn that only wrote a log line is a bridge that dies silently.
//      `--self-test` (a read-only config/dependency check) is only ever reached from
//      POST /api/settings/matrix/test.
//
// The config block carries paths, the room id and the auto-start flag and nothing else. `matrixConfig` returns
// exactly those four keys, so a password pasted into config.json by mistake is not carried into any answer, and
// `matrixPatchFrom` is the only way a save route may turn a request body into an answer: it reads those four keys
// and refuses or ignores everything else.
import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { statePaths } from "./paths.js";

const execFileP = promisify(execFile);

// What a `matrix` block may carry, in the order the tab shows them. `roomId` is not a secret (it is an
// opaque `!room:server` address), but the password is — and it belongs in bridge.env only. This list IS the
// filter: `matrixConfig` builds its answer by walking it, so a key nobody named here (a password pasted into
// config.json by mistake) cannot reach a route, a log line or the page. It is also the save route's whitelist.
export const MATRIX_KEYS = ["scriptPath", "pythonPath", "roomId", "autoStart"];

// A flag is a flag: `true`/`false`, or the words a JSON file or a form round-trips them as. Anything else is
// left to the config's own default rather than read as "off" — an unreadable value must not silently disable a
// bridge the reader asked for. This is the ONE place `autoStart` decides on when it is absent: an install that
// predates the flag auto-starts, which is what the reader decided.
export function autoStartFrom(value, fallback = true) {
  if (value === true || value === false) return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value == null ? "" : value).trim().toLowerCase();
  if (["true", "on", "yes", "1"].includes(text)) return true;
  if (["false", "off", "no", "0"].includes(text)) return false;
  return fallback;
}

// A config with no `matrix` block is a panel that has never been pointed at a bridge: every field is an
// empty string and the tab says so instead of guessing a path that belongs to one machine. `autoStart` is the
// exception: absent means ON, because a bridge the reader has configured is one they want running.
export function matrixConfig(raw) {
  const block = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const key of MATRIX_KEYS) {
    if (key === "autoStart") out.autoStart = autoStartFrom(block.autoStart, true);
    else out[key] = String(block[key] == null ? "" : block[key]).trim();
  }
  return out;
}

// THE SAVE ROUTE'S ONLY WAY IN. A request body is not a config file: it may carry a password, a typo'd key, a
// nested object — and none of that becomes a field of `matrix`. This reads the four whitelisted keys, checks the
// type of each, and returns what may be written (or a sentence saying what is wrong). A key nobody named here is
// IGNORED, not echoed: the route's answer is `matrixBridge.state()`, which walks MATRIX_KEYS itself, so a
// `password` in the body has nowhere to reappear.
export function matrixPatchFrom(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "send a JSON object with the fields to save" };
  const values = {};
  for (const key of MATRIX_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    if (key === "autoStart") {
      const v = body.autoStart;
      const ok = v === true || v === false || ["true", "false", "on", "off", "1", "0"].includes(String(v).trim().toLowerCase());
      if (!ok) return { error: "autoStart must be true or false" };
      values.autoStart = autoStartFrom(v, true);
      continue;
    }
    if (typeof body[key] !== "string") return { error: `${key} must be a string` };
    values[key] = body[key].trim();
  }
  if (!Object.keys(values).length) return { error: `nothing to save — send at least one of ${MATRIX_KEYS.join(", ")}` };
  return { values };
}

// The block a save writes: the four whitelisted keys, current values overlaid with the accepted ones. Nothing
// else survives — a password pasted into the file by hand is dropped by the next save, which is the direction a
// writer should fail in when the alternative is carrying it forward.
export function matrixBlock(current, values = {}) {
  const next = matrixConfig(current);
  for (const key of MATRIX_KEYS) if (Object.prototype.hasOwnProperty.call(values, key)) next[key] = values[key];
  return next;
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
    // What the BOOT spawn did, and nothing else writes it. `null` until autoStart() has been asked (a panel whose
    // boot never reached it, or a test that constructs the object directly). A failed spawn lands here and the
    // Gateway tab draws it: a background start that only appended to a log file is a bridge that dies silently.
    this.boot = null;
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

  // The PATH of the credentials file. The Bridge tab shows this and nothing else about it: the panel never
  // opens the file, so a password cannot reach a route, a log line or the page. Empty when no script is set,
  // because a path derived from nothing would invent a file that is not there.
  envPath() {
    const { scriptPath } = this.settings;
    return scriptPath ? path.join(path.dirname(scriptPath), "bridge.env") : "";
  }

  // The bridge has no per-sender allow-list of its own: it serves exactly one room and accepts a message from
  // any member of it. The panel states that instead of inventing a list the bridge would not enforce. The
  // shape is here rather than in the page so a future bridge that grows a sender filter has one place to say so.
  senderAllowList() {
    const { roomId } = this.settings;
    return {
      mode: "room",
      roomId: roomId || null,
      senders: [],
      detail: roomId
        ? "the bridge serves this one room — any member of it may talk to the bridge; bridge.env has no per-sender list"
        : "no room is set, so no sender can reach the bridge",
    };
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
      // The PATH of bridge.env, never its contents. The page draws it as text; no route echoes a key.
      envPath: this.envPath(),
      senderAllowList: this.senderAllowList(),
      pidFile: this.pidFile,
      logFile: this.logFile,
      // Forty lines of the child's own stdout+stderr. `{ ok: null, output: "" }` until somebody presses
      // Run self-test: the panel does not run one on its own, and a GET must not start a process.
      selfTest: this.lastSelfTest || { ok: null, output: "", exitCode: null, at: null },
      // What the boot spawn did — `attempted`, `started`, and the refusal's own sentence when it failed. `null`
      // on a panel whose boot never asked (a unit test's own object), so the tab can tell "not asked" from "asked
      // and skipped". This is the one place a failed auto-start is visible.
      boot: this.boot,
      log: tailLines(this.logFile, 40),
    };
  }

  // The boot spawn, and the whole of the panel's auto-start: it runs ONCE from server.js's boot, behind the
  // settings the tab can now edit. It spawns when every one of these is true, and it records WHY when one is not:
  //
  //   autoStart                 the reader's flag (default true)
  //   credentialsPresent         bridge.env beside the script — without it the bridge cannot log in
  //   no live pid                a bridge this panel already started is not started twice; a STALE record is not
  //                              live, so it does not block the boot (start() clears it)
  //
  // A failure — a missing interpreter, a child that dies at once — is kept in `this.boot` and returned, never
  // thrown into the boot path: the panel must come up even when the bridge cannot. It is also logged, so the panel
  // log and the tab say the same thing.
  async autoStart() {
    const at = new Date().toISOString();
    const settings = this.settings;
    const before = this.state();
    const skip = (why) => {
      this.boot = { at, attempted: false, started: false, error: null, note: why };
      return this.boot;
    };
    if (!settings.autoStart) return skip("auto-start is off — the bridge starts only when Start is pressed");
    if (!settings.scriptPath) return skip("no bridge script is configured — nothing to start at boot");
    if (!before.scriptPresent) return skip(`the bridge script is not at ${settings.scriptPath} — nothing to start at boot`);
    if (!settings.pythonPath) return skip("no interpreter is configured — nothing to start at boot");
    if (!before.pythonPresent) return skip(`the interpreter is not at ${settings.pythonPath} — nothing to start at boot`);
    if (!this.credentialsPresent()) return skip("bridge.env is missing beside the script — the bridge would refuse to log in, so it was not started");
    if (!settings.roomId) return skip("no room is set (matrix.roomId is empty) — the bridge would launch into nothing, so it was not started");
    if (before.running) return skip(`the bridge is already running as pid ${before.pid}`);
    const out = await this.start();
    if (out.status === 200 && out.running) {
      this.boot = { at, attempted: true, started: true, error: null, note: `started at boot as pid ${out.pid}` };
    } else {
      const error = out.error || `the boot spawn answered ${out.status}`;
      this.boot = { at, attempted: true, started: false, error, note: "the auto-start at boot FAILED" };
      this.onLog(`matrix bridge auto-start FAILED: ${error}`);
    }
    return this.boot;
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
    // An empty room is "no room set", not "the bridge's own default": a start here would spawn a program that has
    // nowhere to talk, so it is refused with the reason the tab can draw. The id is not guessed or hard-coded —
    // the reader pastes it into Settings → Gateway (or config.json).
    if (!settings.roomId) {
      return {
        status: 400,
        ...before,
        error: "no room is set — matrix.roomId is empty, so a start would launch the bridge into nothing; put the room id in Settings → Gateway (an encrypted DM is !id:server) and press Start again",
      };
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
    // The same "no room set" rule as start: a self-test that passes on a config with nowhere to talk is the
    // reassuring answer this tab exists not to give.
    if (!settings.roomId) return refuse("no room is set — matrix.roomId is empty, so the bridge has nowhere to run; put the room id in Settings → Gateway and run this again");
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
