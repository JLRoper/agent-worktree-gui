// Every helper process this panel starts goes through this file.
//
// WHY: `execFile` bounds the process it started and nothing else. A git push runs the chained pre-push
// hook, the hook runs `node tools/land.mjs --check` (it renders every release and takes minutes), and
// when the call's own timeout fires Node kills the git process it holds — the hook's node is not it, so
// it keeps running with no owner. That is the measured leak: a changelog check still working 50 minutes
// after the push that started it was abandoned, and a watch probe left behind by the same shape. A worker
// thread makes it worse: terminating the worker does not touch the git processes it spawned.
//
// So a child is REGISTERED when it starts, carries a HARD timeout for its kind (a caller may ask for
// less, never more), and is killed WITH ITS TREE:
//
//   * on its own timeout,
//   * when its scope settles (a finished or cancelled job, one scan, the panel itself),
//   * when the panel shuts down.
//
// The registry is the panel's single supervisor: one instance (`panelChildren`) shared by server.js, the
// job engine and every lib/ helper, so `killAll()` on the way out has one list to walk. A test builds its
// own instance, which is why nothing here reads global state.

import { execFile, spawn } from "node:child_process";
import { execFileSync } from "node:child_process";

// A helper's ceiling, in milliseconds, by kind. `run()` clamps the caller's own timeout to it: a caller
// may be stricter than its kind, never looser. `hook` is deliberately generous — the pre-push gate really
// does render the changelog — but it is a CEILING, which is the difference between a slow landing and an
// orphan nobody knows about.
export const HELPER_LIMITS = {
  scan: 30_000,
  git: 120_000,
  gh: 120_000,
  hook: 600_000,
  check: 600_000,
  bridge: 30_000,
  open: 30_000,
  helper: 120_000,
};

export const DEFAULT_LIMIT_MS = 120_000;
// The default cap for a child adopted straight from `spawn()` (the detached openers): long enough for an
// editor or a browser launch, short enough that a wedged launcher cannot sit in the registry forever.
export const ADOPTED_LIMIT_MS = 30_000;

export const SCOPE_PANEL = "panel";
export const scopeForJob = (id) => `job:${String(id ?? "")}`;
export const scopeForScan = (id) => `scan:${id}`;

// Is this pid still a process on this machine? `kill(pid, 0)` sends no signal; EPERM means it exists and
// belongs to somebody else, which is still alive. Never throws.
export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === "EPERM");
  }
}

// Kill ONE pid and everything it started. Windows has `taskkill /T /F`; a POSIX child is started in its
// own process group (see `run`'s options), so the group is the tree. Both are best effort: a process that
// died between the read and the kill is the outcome we wanted, not a failure.
export function killTree(pid, { platform = process.platform } = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, how: "no pid" };
  if (platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(n), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 15_000 });
      return { ok: true, how: "taskkill /T /F" };
    } catch (e) {
      // 128 is taskkill's "no such process": it went on its own, which is the same result.
      if (e && Number(e.status) === 128) return { ok: true, how: "taskkill (already gone)" };
      if (!pidAlive(n)) return { ok: true, how: "gone before the kill" };
      return { ok: false, how: `taskkill failed: ${String((e && e.message) || e)}` };
    }
  }
  try {
    process.kill(-n, "SIGKILL"); // the group this child leads
    return { ok: true, how: "process group SIGKILL" };
  } catch {
    /* no group of that number: fall back to the pid itself */
  }
  try {
    process.kill(n, "SIGKILL");
    return { ok: true, how: "SIGKILL" };
  } catch (e) {
    if (!pidAlive(n)) return { ok: true, how: "gone before the kill" };
    return { ok: false, how: `kill failed: ${String((e && e.message) || e)}` };
  }
}

// A child started by `exec`/`spawn` timed out. The error still carries what execFile would have given a
// caller (`stdout`, `stderr`, `code`), plus the two facts that make it diagnosable.
function timeoutError({ label, pid, ms, stdout = "", stderr = "" }) {
  const err = new Error(`${label} timed out after ${Math.round(ms / 1000)}s — its process tree was killed`);
  err.timedOut = true;
  err.killedTree = true;
  err.pid = pid;
  err.timeoutMs = ms;
  err.stdout = stdout;
  err.stderr = stderr;
  err.code = "ETIMEDOUT_TREE";
  return err;
}

const firstWord = (bin) => String(bin || "").replace(/\\/g, "/").split("/").pop().replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();

// The kind a call site did not name: the binary is the honest guess, because that is what decides which
// ceiling applies. A git subcommand is not `args[0]`: every call in this repo writes `git -C <dir> <verb>`,
// so the first argument is the flag. The verb is the first token that is neither a flag nor a flag's value
// (`-C <dir>`, `--no-pager`, `-c <k=v>`), which is what lets a push find the generous `hook` ceiling while a
// plain read stays on `git`.
export function kindOf(bin, args = []) {
  const name = firstWord(bin);
  if (name === "git") {
    const takesValue = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
    for (let i = 0; i < args.length; i += 1) {
      const a = String(args[i] ?? "");
      if (!a) continue;
      if (takesValue.has(a)) {
        i += 1; // its value is not the verb
        continue;
      }
      if (a.startsWith("-")) continue;
      if (a.toLowerCase() === "push") return "hook";
      return "git";
    }
    return "git";
  }
  if (name === "gh") return "gh";
  return "helper";
}

export class ChildTree {
  // `onTrack` / `onDone` are how a registry that lives in another thread reaches this one: a worker's
  // registry reports each pid up and each release, so the process that owns the panel also owns the kill
  // list. Both are bystanders — a throw in either cannot fail the supervision.
  constructor({ log = () => {}, limits = HELPER_LIMITS, defaultLimitMs = DEFAULT_LIMIT_MS, alive = pidAlive, kill = killTree, onTrack = null, onDone = null } = {}) {
    this.log = log;
    this.limits = { ...HELPER_LIMITS, ...limits };
    this.defaultLimitMs = defaultLimitMs;
    this.alive = alive;
    this.killTree = kill;
    this.onTrack = onTrack;
    this.onDone = onDone;
    this.entries = new Map(); // pid -> entry
    this.started = 0;
    this.timedOut = 0;
    this.killed = 0;
    this.closed = false;
  }

  setLog(fn) {
    if (typeof fn === "function") this.log = fn;
    return this;
  }

  // The ceiling for one child: the caller's own timeout when it asks for less than its kind allows.
  limitFor(kind, asked) {
    const cap = Number(this.limits[kind] ?? this.defaultLimitMs) || this.defaultLimitMs;
    const n = Number(asked);
    return Number.isFinite(n) && n > 0 ? Math.min(n, cap) : cap;
  }

  // ---- the one door ---------------------------------------------------------------------------------
  // Signature-compatible with `promisify(execFile)(bin, args, opts)` so a call site changes by one name:
  // resolves `{ stdout, stderr }`, rejects with execFile's own error (code, stdout, stderr) or with a
  // timeout error that says the tree was killed.
  exec(scope, bin, args = [], opts = {}) {
    const { kind: asked, label, timeoutMs: askedTimeout, timeout, onSpawn, onTimeout, ...rest } = opts || {};
    // `timeout` is what every existing call site passes; it is now the REQUEST, not the enforcement.
    const kind = asked || kindOf(bin, args);
    const limit = this.limitFor(kind, askedTimeout ?? timeout);
    const name = label || [firstWord(bin), ...args.slice(0, 2)].join(" ").trim();
    return new Promise((resolve, reject) => {
      let child;
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      try {
        child = execFile(
          bin,
          args,
          {
            maxBuffer: 16 * 1024 * 1024,
            windowsHide: true,
            // No `timeout` here on purpose: execFile would kill only THIS pid and leave the hook it ran
            // alive. The deadline is ours, so the kill is ours too.
            ...rest,
            detached: process.platform === "win32" ? Boolean(rest.detached) : true,
          },
          (err, stdout, stderr) => {
            const entry = this.entries.get(child?.pid);
            if (entry) this.release(child.pid);
            if (err) {
              if (entry?.timedOut) {
                // Our own timeout already rejected; the callback only reports what the child had written.
                finish(reject, timeoutError({ label: name, pid: entry.pid, ms: entry.limit, stdout: String(stdout || ""), stderr: String(stderr || "") }));
              } else finish(reject, err);
              return;
            }
            finish(resolve, { stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), pid: child?.pid ?? null });
          },
        );
      } catch (e) {
        finish(reject, e);
        return;
      }
      if (child?.pid) {
        this.track(scope, child, {
          kind,
          label: name,
          timeoutMs: limit,
          // The deadline and an explicit `killScope` are the same decision: the tree dies, then the
          // promise settles with the reason a caller can act on.
          onTimeout: (info) => {
            finish(reject, timeoutError({ label: name, pid: info.pid, ms: limit }));
            try {
              onTimeout?.(info);
            } catch {
              /* the caller's hook cannot fail the supervision */
            }
          },
        });
        try {
          onSpawn?.(child.pid);
        } catch {
          /* a reporter is a bystander, never the call */
        }
      }
    });
  }

  // Adopt a child somebody else started (`spawn`). The entry is the same shape, so one `killAll` covers a
  // detached launcher and a git call alike.
  track(scope, child, { kind = "helper", label = null, timeoutMs = null, onTimeout = null } = {}) {
    if (!child || !child.pid || this.entries.has(child.pid)) return child;
    const limit = this.limitFor(kind, timeoutMs ?? ADOPTED_LIMIT_MS);
    // A child asked to start after the registry closed (a shutdown in flight) must not be left running
    // while it waits for a killAll that already happened.
    if (this.closed) {
      try {
        this.killTree(child.pid);
      } catch {
        /* the outcome we wanted either way */
      }
      return child;
    }
    const entry = {
      pid: child.pid,
      scope: String(scope || SCOPE_PANEL),
      kind,
      label: label || firstWord(child.spawnfile || "") || `pid ${child.pid}`,
      startedAt: Date.now(),
      limit,
      child,
      timedOut: false,
      killed: false,
      timer: null,
      onTimeout,
    };
    entry.timer = setTimeout(() => this.expire(entry.pid), limit);
    entry.timer.unref?.();
    this.entries.set(child.pid, entry);
    this.started += 1;
    child.once("close", () => this.release(child.pid));
    child.once("error", () => this.release(child.pid));
    this.reported("track", entry);
    return child;
  }

  // A pid-only child: one a worker thread started and reported up. There is no ChildProcess handle here, so
  // there is no "close" to release it and no timer to expire it — the thread that owns the handle enforces
  // the deadline and reports the release. This entry exists so a settle or a shutdown still kills it.
  adopt(scope, pid, { kind = "helper", label = null } = {}) {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0 || this.entries.has(n)) return null;
    if (this.closed) {
      try {
        this.killTree(n);
      } catch {
        /* already the answer */
      }
      return null;
    }
    const entry = {
      pid: n,
      scope: String(scope || SCOPE_PANEL),
      kind,
      label: label || `pid ${n}`,
      startedAt: Date.now(),
      limit: this.limitFor(kind),
      child: null,
      timedOut: false,
      killed: false,
      timer: null,
    };
    this.entries.set(n, entry);
    this.started += 1;
    this.reported("track", entry);
    return entry;
  }

  // A bystander reporter, never the call: the panel's log or another thread's port.
  reported(what, entry) {
    const fn = what === "track" ? this.onTrack : this.onDone;
    if (typeof fn !== "function") return;
    try {
      fn({ pid: entry.pid, scope: entry.scope, kind: entry.kind, label: entry.label, limit: entry.limit });
    } catch {
      /* a reporter cannot fail the supervision */
    }
  }

  // A helper's own spawn convenience: tracked, same ceilings, caller owns the ChildProcess.
  spawn(scope, bin, args = [], opts = {}) {
    const { kind: asked, label, timeoutMs, onTimeout, ...rest } = opts || {};
    const kind = asked || kindOf(bin, args);
    const child = spawn(bin, args, {
      windowsHide: true,
      ...rest,
      detached: process.platform === "win32" ? Boolean(rest.detached) : true,
    });
    this.track(scope, child, { kind, label, timeoutMs: timeoutMs ?? this.limitFor(kind), onTimeout });
    return child;
  }

  // The deadline fired: kill the tree FIRST, then record it, so a `killScope` racing the timer cannot
  // report a child as killed twice.
  expire(pid) {
    const entry = this.entries.get(pid);
    if (!entry || entry.killed) return;
    entry.timedOut = true;
    this.timedOut += 1;
    const out = this.killPid(pid, `timed out after ${Math.round(entry.limit / 1000)}s`);
    this.log(`child ${pid} (${entry.label}, ${entry.scope}) ${out.how}`);
    try {
      entry.onTimeout?.({ pid, reason: "timeout", ...out });
    } catch {
      /* the caller's hook cannot fail the supervision */
    }
    // A live handle releases itself on "close"; a pid-only entry has no close to wait for, so the deadline
    // is the last word it gets. Delete either way: a killed pid left in the map is a pid a later killAll
    // would send a signal to after the OS may have handed the number to something else.
    this.entries.delete(pid);
  }

  release(pid) {
    const entry = this.entries.get(pid);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.entries.delete(pid);
    this.reported("done", entry);
    return true;
  }

  // One pid, its tree, and the bookkeeping. Never throws.
  killPid(pid, reason = "killed") {
    const entry = this.entries.get(pid);
    if (entry?.killed) return { ok: true, how: "already killed" };
    if (entry) {
      entry.killed = true;
      clearTimeout(entry.timer);
    }
    this.killed += 1;
    const out = this.killTree(pid);
    if (!out.ok) this.log(`child ${pid} could not be killed (${reason}): ${out.how}`);
    // A kill that worked ends the entry here. The "close" a live handle fires a tick later finds nothing to
    // release, which is fine: waiting for it left killed pids in the map, and a map that still names them is
    // a map a second killAll sends a signal through after the OS may have reused the number.
    if (out.ok) this.entries.delete(pid);
    return out;
  }

  // Everything started for one job, one scan, or the panel. This is what a job's settle calls.
  killScope(scope, reason = "its scope settled") {
    const want = String(scope || "");
    const hit = [...this.entries.values()].filter((e) => e.scope === want);
    for (const e of hit) {
      const out = this.killPid(e.pid, reason);
      this.log(`child ${e.pid} (${e.label}) killed with ${want} — ${reason} (${out.how})`);
      this.reported("done", e);
    }
    return hit.length;
  }

  // A scope that finished on its own: forget its pids without sending a signal. Called when a scan or a
  // turn completed normally, so a pid cannot linger in the map and be killed later by a stale number.
  releaseScope(scope) {
    const want = String(scope || "");
    let n = 0;
    for (const e of [...this.entries.values()]) {
      if (e.scope !== want) continue;
      n += 1;
      this.release(e.pid);
    }
    return n;
  }

  // Shutdown. Every scope, oldest first, one log line per child.
  killAll(reason = "the panel is shutting down") {
    this.closed = true;
    const hit = [...this.entries.values()];
    for (const e of hit) {
      const out = this.killPid(e.pid, reason);
      this.log(`child ${e.pid} (${e.label}, ${e.scope}) killed — ${reason} (${out.how})`);
      this.reported("done", e);
    }
    return hit.length;
  }

  // The synchronous half `process.on("exit")` can use: no promises, no timers, taskkill only.
  killAllSync(reason = "process exit") {
    let n = 0;
    for (const e of [...this.entries.values()]) {
      n += 1;
      this.killTree(e.pid);
      clearTimeout(e.timer);
      this.entries.delete(e.pid);
    }
    if (n) this.log(`${n} child process(es) killed on ${reason}`);
    return n;
  }

  // What is running now, for a log line, a route or a test's ledger.
  list() {
    return [...this.entries.values()].map((e) => ({
      pid: e.pid,
      scope: e.scope,
      kind: e.kind,
      label: e.label,
      startedAt: e.startedAt,
      limit: e.limit,
      timedOut: e.timedOut,
    }));
  }

  stats() {
    const scopes = {};
    for (const e of this.entries.values()) scopes[e.scope] = (scopes[e.scope] || 0) + 1;
    return { live: this.entries.size, started: this.started, killed: this.killed, timedOut: this.timedOut, scopes };
  }

  // Is this pid still in the registry? Used by a caller that keeps a second index of the same children.
  has(pid) {
    return this.entries.has(Number(pid));
  }

  get size() {
    return this.entries.size;
  }
}

// The panel's own registry. server.js points its log at the panel's log and passes this instance to the
// job engine, so a settle and a shutdown walk the same list.
// The single supervisor every module uses. A module that just wants "exec, but tracked" calls this with the
// same arguments as `child.promisify(execFile)` and gets `{stdout, stderr}` back.
export const panelChildren = new ChildTree();
export const childExec = (bin, args, opts = {}) => panelChildren.exec(SCOPE_PANEL, bin, args, opts);
