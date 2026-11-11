"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");

const MAX_BYTES = 20 * 1024 * 1024;
const SEGMENT_BYTES = 2 * 1024 * 1024;
const HOUR = 60 * 60 * 1000;
const ARCHIVE = /^server\.(?:out|err)\.log\.\d{8}T\d{9}Z-[0-9a-f]{8}$/;

function regular(file, missing = true) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1) throw new Error(`unsafe log file: ${file}`);
    return st;
  } catch (e) {
    if (missing && e.code === "ENOENT") return null;
    throw e;
  }
}

// Never truncate on open. Check the opened inode before writing, including on Windows where O_NOFOLLOW is absent.
function openSafe(file, flags, allowCreate = true) {
  const before = regular(file);
  if (!before && !allowCreate) throw Object.assign(new Error(`missing log file: ${file}`), { code: "ENOENT" });
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const create = before ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL;
  const fd = fs.openSync(file, flags | noFollow | create, 0o600);
  try {
    const actual = fs.fstatSync(fd);
    const after = regular(file, false);
    if (!actual.isFile() || actual.nlink > 1 || actual.dev !== after.dev || actual.ino !== after.ino ||
        (before && (before.dev !== actual.dev || before.ino !== actual.ino))) throw new Error(`unsafe log file: ${file}`);
    return fd;
  } catch (e) { fs.closeSync(fd); throw e; }
}

function writePid(file, pid) {
  const fd = openSafe(file, fs.constants.O_WRONLY);
  try { fs.ftruncateSync(fd, 0); fs.writeFileSync(fd, String(pid)); } finally { fs.closeSync(fd); }
}

function readPid(file) {
  if (!regular(file)) return null;
  const fd = openSafe(file, fs.constants.O_RDONLY, false);
  try {
    if (fs.fstatSync(fd).size > 32) throw new Error(`invalid panel pid file: ${file}`);
    const text = fs.readFileSync(fd, "utf8").trim();
    if (!text) return null;
    if (!/^[1-9]\d{0,9}$/.test(text) || Number(text) > 0x7fffffff) throw new Error(`invalid panel pid file: ${file}`);
    return Number(text);
  } finally { fs.closeSync(fd); }
}

function validatePaths(pidFile, outLog, errLog) {
  const dir = path.dirname(path.resolve(pidFile));
  for (const [file, name] of [[pidFile, "server.pid"], [outLog, "server.out.log"], [errLog, "server.err.log"]]) {
    if (!file || path.resolve(file) !== path.join(dir, name)) throw new Error(`invalid panel log path: ${file}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const dirStat = fs.lstatSync(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error(`unsafe log directory: ${dir}`);
  for (const file of [pidFile, outLog, errLog]) regular(file);
  return dir;
}

// One owner serializes startup, pruning and rolling. A dead owner can be recovered; an unknown owner fails closed.
async function acquire(dir, timeoutMs = 15000) {
  const lock = path.join(dir, ".server-log-lock");
  const ownerFile = path.join(lock, "owner");
  const until = Date.now() + timeoutMs;
  while (true) {
    try {
      fs.mkdirSync(lock);
      try { fs.writeFileSync(ownerFile, String(process.pid), { flag: "wx" }); }
      catch (e) { fs.rmdirSync(lock); throw e; }
      return () => { fs.unlinkSync(ownerFile); fs.rmdirSync(lock); };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    let st;
    try { st = fs.lstatSync(lock); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`unsafe log lock: ${lock}`);
    let dead = false;
    try {
      regular(ownerFile, false);
      const text = fs.readFileSync(ownerFile, "utf8").trim();
      if (!/^[1-9]\d*$/.test(text)) throw new Error(`invalid log lock owner: ${lock}`);
      try { process.kill(Number(text), 0); } catch (e) { if (e.code === "ESRCH") dead = true; else if (e.code !== "EPERM") throw e; }
    } catch (e) {
      // Allow an owner time to create its metadata, or a crashed creator to become stale.
      if (e.code !== "ENOENT") throw e;
      dead = Date.now() - st.mtimeMs > 30000;
    }
    if (dead) {
      // Serialize reclaimers and recheck: another starter may already have replaced the dead owner.
      const recovery = path.join(dir, ".server-log-recovery");
      let fd;
      try { fd = fs.openSync(recovery, "wx"); } catch (e) { if (e.code !== "EEXIST") throw e; }
      if (fd !== undefined) {
        try {
          let stillDead = false;
          try {
            const current = fs.lstatSync(lock);
            if (!current.isDirectory() || current.isSymbolicLink()) throw new Error(`unsafe log lock: ${lock}`);
            try {
              regular(ownerFile, false);
              const text = fs.readFileSync(ownerFile, "utf8").trim();
              if (!/^[1-9]\d*$/.test(text)) throw new Error(`invalid log lock owner: ${lock}`);
              try { process.kill(Number(text), 0); } catch (e) { if (e.code === "ESRCH") stillDead = true; else if (e.code !== "EPERM") throw e; }
            } catch (e) { if (e.code !== "ENOENT") throw e; stillDead = Date.now() - current.mtimeMs > 30000; }
            if (stillDead) {
              try { fs.unlinkSync(ownerFile); } catch (e) { if (e.code !== "ENOENT") throw e; }
              fs.rmdirSync(lock);
            }
          } catch (e) { if (e.code !== "ENOENT") throw e; }
        } finally { fs.closeSync(fd); fs.unlinkSync(recovery); }
        continue;
      }
    }
    if (Date.now() >= until) throw new Error(`panel log is still owned by another process: ${lock}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

class RotatingPanelLog {
  constructor(dir, { maxBytes = MAX_BYTES, segmentBytes = SEGMENT_BYTES, now = () => Date.now() } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(segmentBytes) || segmentBytes < 1 || segmentBytes > maxBytes) throw new Error("invalid panel log limits");
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.segmentBytes = segmentBytes;
    this.now = now;
    this.hour = Math.floor(now() / HOUR);
    this.roll(); // Preserve a previous run, even if it was within the same hour.
    this.prune(0);
  }

  active(kind) { return path.join(this.dir, `server.${kind}.log`); }

  files() {
    return fs.readdirSync(this.dir).filter((name) => name === "server.out.log" || name === "server.err.log" || ARCHIVE.test(name)).map((name) => {
      const file = path.join(this.dir, name);
      const st = regular(file, false);
      return { name, file, size: st.size, mtime: st.mtimeMs };
    });
  }

  roll() {
    const suffix = `${new Date(this.now()).toISOString().replace(/[-:.]/g, "")}-${randomBytes(4).toString("hex")}`;
    for (const kind of ["out", "err"]) {
      const file = this.active(kind);
      const st = regular(file);
      if (st && st.size) {
        const dest = `${file}.${suffix}`;
        if (regular(dest)) throw new Error(`panel log archive already exists: ${dest}`);
        fs.renameSync(file, dest);
      }
    }
    this.hour = Math.floor(this.now() / HOUR);
  }

  // Discard oldest archives first. Oversized legacy files keep only their newest bytes.
  prune(reserve) {
    const active = new Set(["server.out.log", "server.err.log"]);
    const files = this.files().sort((a, b) => (active.has(b.name) - active.has(a.name)) || b.mtime - a.mtime || b.name.localeCompare(a.name));
    let left = this.maxBytes - reserve;
    for (const f of files) {
      if (f.size <= left) { left -= f.size; continue; }
      if (left <= 0) { fs.unlinkSync(f.file); continue; }
      const fd = openSafe(f.file, fs.constants.O_RDWR);
      const tail = Buffer.alloc(left);
      try {
        let read = 0;
        while (read < left) {
          const n = fs.readSync(fd, tail, read, left - read, f.size - left + read);
          if (!n) throw new Error(`short read from panel log: ${f.file}`);
          read += n;
        }
        fs.ftruncateSync(fd, 0);
        fs.writeFileSync(fd, tail);
      } finally { fs.closeSync(fd); }
      left = 0;
    }
  }

  tick() {
    if (Math.floor(this.now() / HOUR) !== this.hour) this.roll();
  }

  write(kind, data) {
    if (kind !== "out" && kind !== "err") throw new Error("invalid panel log stream");
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let offset = 0;
    while (offset < bytes.length) {
      this.tick();
      const size = ["out", "err"].reduce((sum, k) => sum + (regular(this.active(k))?.size || 0), 0);
      if (size >= this.segmentBytes) { this.roll(); continue; }
      if (bytes.length - offset <= this.segmentBytes && bytes.length - offset > this.segmentBytes - size) { this.roll(); continue; }
      const take = Math.min(bytes.length - offset, this.segmentBytes - size);
      this.prune(take);
      const file = this.active(kind);
      const fd = openSafe(file, fs.constants.O_WRONLY | fs.constants.O_APPEND);
      try { fs.writeFileSync(fd, bytes.subarray(offset, offset + take)); } finally { fs.closeSync(fd); }
      offset += take;
    }
  }
}

function launchSupervisor(serverPath, pidFile, outLog, errLog) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "panel-log-supervisor.cjs"), serverPath, pidFile, outLog, errLog], {
      cwd: path.dirname(path.resolve(serverPath)), detached: true, windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env },
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error("panel log supervisor did not start")); }, 20000);
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`panel log supervisor exited before launch (${code})`)); });
    child.once("message", (msg) => {
      clearTimeout(timer);
      if (!msg || !msg.pid) { child.disconnect(); reject(new Error(msg?.error || "panel log supervisor failed")); return; }
      child.unref();
      resolve({ supervisor: child, pid: msg.pid });
    });
  });
}

module.exports = { RotatingPanelLog, acquire, launchSupervisor, validatePaths, readPid, writePid, MAX_BYTES, SEGMENT_BYTES };
