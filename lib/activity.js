// Liveness evidence for worktrees. Four independent sources, each cheap and
// cached, so the composite can name WHICH signal fired instead of guessing.
//
//   files  - mtimes of the files git reports dirty (a *recent edit*, not a session)
//   hermes - Hermes' own session store: a session whose cwd is this worktree
//   board  - the repo's .agentboard/{PID}.json coordination claim, PID alive now
//   ports  - the dev server declared in that worktree's .env, actually listening
//
// Note on what is deliberately absent: process->worktree matching by command
// line. On this box hermes.exe exposes no cwd and Kilo runs as a generic node
// process, so a "some process is running" signal would be guesswork. The two
// authoritative identity sources (Hermes' session store, the repo's board) are
// used instead.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const pexec = promisify(execFile);

const TTL = { ports: 4000, pids: 4000, hermes: 5000, board: 5000, env: 15000 };
const cache = new Map();

async function memo(key, ttlMs, factory) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return hit.value;
  const value = await Promise.resolve()
    .then(factory)
    .catch(() => hit?.value ?? null);
  cache.set(key, { at: now, value });
  return value;
}

const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// ---- ports actually listening ----
export function listeningPorts() {
  return memo("ports", TTL.ports, async () => {
    const { stdout } = await pexec("netstat", ["-ano"], { timeout: 15000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    const set = new Set();
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.includes("LISTENING")) continue;
      const m = /:(\d+)\s+\S+\s+LISTENING/i.exec(line);
      if (m) set.add(Number(m[1]));
    }
    return set;
  });
}

// ---- running PIDs (one cheap call, reused for board liveness) ----
export function runningPids() {
  return memo("pids", TTL.pids, async () => {
    const { stdout } = await pexec("tasklist", ["/FO", "CSV", "/NH"], { timeout: 15000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    const set = new Set();
    for (const m of stdout.matchAll(/","(\d+)","/g)) set.add(Number(m[1]));
    return set;
  });
}

// ---- the repo's own coordination claim ----
export async function boardEntries(rootPath) {
  const key = norm(rootPath);
  return memo(`board:${key}`, TTL.board, async () => {
    const dir = path.join(rootPath, ".agentboard");
    let files = [];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const out = [];
    for (const f of files) {
      try {
        let text = await readFile(path.join(dir, f), "utf8");
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        const j = JSON.parse(text);
        out.push({
          pid: Number(j.pid) || Number(f.replace(/\.json$/, "")) || null,
          goal: j.goal || null,
          status: j.status || null,
          current: j.current || null,
          progress: j.progress || null,
          started: j.started || null,
        });
      } catch {
        /* unreadable entry: ignore rather than fail the scan */
      }
    }
    return out;
  });
}

// ---- Hermes' session store: cwd -> worktree, authoritative for Hermes ----
function hermesHome() {
  return process.env.HERMES_HOME || path.join(process.env.LOCALAPPDATA || "", "hermes");
}

export function hermesSessions() {
  return memo("hermes", TTL.hermes, async () => {
    const dbPath = path.join(hermesHome(), "state.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare("select id,title,cwd,last_activity_at,ended_at from sessions order by last_activity_at desc limit 300").all();
      return rows.map((r) => ({
        id: r.id,
        title: r.title || null,
        cwd: norm(r.cwd),
        lastActivityAt: Number(r.last_activity_at) * 1000,
        open: !r.ended_at,
      }));
    } finally {
      db.close();
    }
  });
}

// ---- ports the worktree itself declares (WS_PORT is reserved/dormant: skip it) ----
export function declaredPorts(worktreePath) {
  const key = norm(worktreePath);
  return memo(`env:${key}`, TTL.env, async () => {
    try {
      const text = await readFile(path.join(worktreePath, ".env"), "utf8");
      const out = [];
      for (const line of text.split(/\r?\n/)) {
        const m = /^(API_PORT|PORT|VITE_PORT|SERVER_PORT)\s*=\s*(\d+)/.exec(line.trim());
        if (m) out.push(Number(m[2]));
      }
      return [...new Set(out)];
    } catch {
      return [];
    }
  });
}

// ---- the composite ----
export async function signalsFor(worktreePath, { lastEdit, liveMinutes = 5 }) {
  const wt = norm(worktreePath);
  const windowMs = liveMinutes * 60_000;
  const now = Date.now();

  const edited = lastEdit ? now - Date.parse(lastEdit) < windowMs : false;

  const [sessions, ports, pids, boardE, declared] = await Promise.all([
    hermesSessions(),
    listeningPorts(),
    runningPids(),
    boardEntries(worktreePath),
    declaredPorts(worktreePath),
  ]);

  const mine = (sessions || []).filter((s) => s.open && s.cwd === wt);
  const hermes = mine.filter((s) => now - s.lastActivityAt < windowMs);
  const stale = mine.filter((s) => now - s.lastActivityAt >= windowMs);

  const boardLive = (boardE || []).filter((e) => e.pid && pids && pids.has(e.pid) && String(e.status || "").toUpperCase() !== "DEAD");
  const boardDead = (boardE || []).filter((e) => e.pid && (!pids || !pids.has(e.pid) || String(e.status || "").toUpperCase() === "DEAD"));

  const openPorts = (declared || []).filter((p) => ports && ports.has(p));

  const signals = {
    files: { on: edited, at: lastEdit || null },
    // No per-session timestamps on purpose: they'd change every scan and flag the
    // row as "changed" constantly. The substance is on/idle/titles.
    hermes: { on: hermes.length > 0, titles: hermes.map((s) => s.title), idle: stale.length },
    board: { on: boardLive.length > 0, entries: boardLive.map((e) => ({ pid: e.pid, goal: e.goal, current: e.current })), dead: boardDead.length },
    ports: { on: openPorts.length > 0, listening: openPorts, declared: declared || [] },
  };

  const why = [];
  if (signals.hermes.on) why.push(`hermes(${hermes.length})`);
  if (signals.board.on) why.push(`board(${boardLive.length})`);
  if (signals.ports.on) why.push(`port:${openPorts.join(",")}`);
  if (signals.files.on) why.push("files");

  // A session that is OPEN but idle is a weaker claim than one that is working: it
  // stays visible as an idle chip, but it is not live evidence on its own.
  const working = why.length > 0;
  const open = !working && stale.length > 0;
  if (open) why.push(`hermes-open-idle(${stale.length})`);

  return { signals, live: working, open, liveWhy: why.join(" ") };
}

export function projectBoardSummary(rootPath) {
  return (async () => {
    const [entries, pids] = await Promise.all([boardEntries(rootPath), runningPids()]);
    const live = entries.filter((e) => e.pid && pids && pids.has(e.pid) && String(e.status || "").toUpperCase() !== "DEAD");
    return { total: entries.length, live: live.map((e) => ({ pid: e.pid, goal: e.goal })), dead: entries.length - live.length };
  })();
}
