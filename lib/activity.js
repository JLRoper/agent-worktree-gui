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

// One in-flight call per key, not one per caller. `signalsFor` runs for every row on every
// liveness tick (~100 rows every 5s), and every one of those callers misses a 4s TTL at the
// same instant: without sharing the pending promise the panel spawned ~100 concurrent
// `tasklist` + `netstat` processes per pass, which is what made the whole machine (and this
// server's own event loop) crawl. A stale value is still served as the fallback when the
// refresh fails, so a transient error never blanks a chip.
async function memo(key, ttlMs, factory) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit) {
    if (now - hit.at < ttlMs) return hit.value;
    if (hit.pending) return hit.pending; // a refresh is already running: share it
  }
  const prev = hit ? hit.value : null;
  const entry = { at: now, value: prev, pending: null };
  entry.pending = Promise.resolve()
    .then(factory)
    .catch(() => prev)
    .then((value) => {
      entry.at = Date.now();
      entry.value = value;
      entry.pending = null;
      return value;
    });
  cache.set(key, entry);
  return entry.pending;
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
      // `session_turn_leases` is the authoritative "a turn is executing right now" record: the row
      // exists only while a turn runs, carries the holder (pid=...) and expires on its own. cwd says
      // where a session started; the lease says whether it is busy at this instant.
      const rows = db
        .prepare(
          "select s.id, s.title, s.cwd, s.last_activity_at, s.ended_at, " +
            "exists(select 1 from session_turn_leases l where l.conversation_id = s.id and l.expires_at > ?) as leased " +
            "from sessions s order by s.last_activity_at desc limit 300",
        )
        .all(Date.now() / 1000);
      return rows.map((r) => ({
        id: r.id,
        title: r.title || null,
        cwd: norm(r.cwd),
        lastActivityAt: Number(r.last_activity_at) * 1000,
        open: !r.ended_at,
        running: Boolean(r.leased),
      }));
    } finally {
      db.close();
    }
  });
}

// `sessions.cwd` is written once, when the session starts, and is NULL for a resumed (-c) thread.
// An agent that cd's into a worktree, or that was resumed somewhere else, therefore never matches
// the worktree it is actually editing — the panel sees its file edits and nothing else. The only
// per-turn placement Hermes records is the absolute paths in the tool calls it streamed, so that
// is what we read: the newest tool arguments of the open sessions, reduced to paths.
const WIN_PATH = /[A-Za-z]:[\\/][^\s"'`,;:)\]}]+/g;
const MSYS_PATH = /\/(?:mnt\/)?[a-z]\/[A-Za-z0-9_.\-/]+/g;

function pathsIn(text) {
  const out = [];
  for (const m of String(text || "").matchAll(WIN_PATH)) out.push(m[0]);
  for (const m of String(text || "").matchAll(MSYS_PATH)) out.push(m[0]);
  return out.map((p) => {
    let s = p.replace(/\\{1,}/g, "/").replace(/\/{2,}/g, "/");
    const m = /^\/(?:mnt\/)?([a-z])\/(.*)$/i.exec(s);
    if (m) s = `${m[1]}:/${m[2]}`;
    return s.replace(/[\\/]+$/, "").toLowerCase();
  });
}

export function hermesTouchedPaths() {
  return memo("hermesPaths", 10_000, async () => {
    const dbPath = path.join(hermesHome(), "state.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const cutoff = Date.now() / 1000 - 20 * 60; // only recent turns can say where a session is now
      const rows = db
        .prepare(
          "select session_id, tool_calls, timestamp from messages " +
            "where timestamp > ? and tool_calls is not null and length(tool_calls) > 16 " +
            "order by timestamp desc limit 250",
        )
        .all(cutoff);
      // Per session, the newest tool calls in order, each with the paths it named. Attribution
      // needs the ORDER: "what did it touch last" is the answer, not "everything it ever touched"
      // (a single `git -C <other repo> status` must not relocate the session).
      const map = new Map();
      for (const r of rows) {
        const paths = pathsIn(r.tool_calls);
        if (!paths.length) continue;
        const list = map.get(r.session_id) || [];
        if (list.length < 40) list.push({ at: Number(r.timestamp) * 1000, paths: paths.slice(0, 60) });
        map.set(r.session_id, list);
      }
      return map;
    } finally {
      db.close();
    }
  });
}

// Attribute each open session to the ONE worktree it is working in: score the newest few tool calls
// by which known worktree their paths fall under, most frequent wins, ties to the most recent.
// Falls back to the directory the session started in when its recent calls name no worktree.
export async function hermesSessionRoots(knownWorktrees) {
  const roots = (knownWorktrees || []).map(norm).filter(Boolean);
  const [sessions, touched] = await Promise.all([hermesSessions(), hermesTouchedPaths()]);
  const out = new Map(); // root -> [{ id, title, matched }]
  const deepest = (paths) => {
    let best = null;
    for (const p of paths) {
      for (const w of roots) {
        if (p !== w && !p.startsWith(`${w}/`)) continue;
        if (!best || w.length > best.length) best = w;
      }
    }
    return best;
  };
  for (const s of sessions) {
    if (!s.open) continue;
    let root = s.cwd || null;
    let matched = "cwd";
    const score = new Map(); // root -> { count, at }
    for (const entry of (touched.get(s.id) || []).slice(0, 6)) {
      const hit = deepest(entry.paths);
      if (!hit) continue;
      const cur = score.get(hit) || { count: 0, at: 0 };
      cur.count += 1;
      cur.at = Math.max(cur.at, entry.at);
      score.set(hit, cur);
    }
    let bestHit = null;
    let bestScore = null;
    for (const [w, sc] of score) {
      if (!bestScore || sc.count > bestScore.count || (sc.count === bestScore.count && sc.at > bestScore.at)) {
        bestHit = w;
        bestScore = sc;
      }
    }
    if (bestHit) {
      root = bestHit;
      matched = "work";
    }
    if (!root) continue;
    const list = out.get(root) || [];
    list.push({ id: s.id, title: s.title, lastActivityAt: s.lastActivityAt, matched, running: s.running });
    out.set(root, list);
  }
  return out;
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
export async function signalsFor(worktreePath, { lastEdit, liveMinutes = 5, sessionsByRoot = null } = {}) {
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

  // Prefer the attribution the scheduler computed for this pass (which follows the session's newest
  // tool calls); fall back to the session's start directory when it was not supplied.
  const mine = sessionsByRoot
    ? sessionsByRoot.get(wt) || []
    : (sessions || []).filter((s) => s.open && s.cwd === wt);
  const hermes = mine.filter((s) => now - s.lastActivityAt < windowMs);
  const stale = mine.filter((s) => now - s.lastActivityAt >= windowMs);

  const boardLive = (boardE || []).filter((e) => e.pid && pids && pids.has(e.pid) && String(e.status || "").toUpperCase() !== "DEAD");
  const boardDead = (boardE || []).filter((e) => e.pid && (!pids || !pids.has(e.pid) || String(e.status || "").toUpperCase() === "DEAD"));

  const openPorts = (declared || []).filter((p) => ports && ports.has(p));

  const signals = {
    files: { on: edited, at: lastEdit || null },
    // No per-session timestamps on purpose: they'd change every scan and flag the
    // row as "changed" constantly. The substance is on/idle/titles — plus how the session was
    // placed here: "cwd" (it started in this worktree) or "work" (its newest tool calls touched it).
    hermes: {
      on: hermes.length > 0,
      titles: hermes.map((s) => s.title),
      idle: stale.length,
      // A leased turn means the session is executing THIS instant, not merely recently active.
      running: hermes.filter((s) => s.running).length,
      matched: hermes.length && hermes.every((s) => s.matched === "work") ? "work" : "cwd",
    },
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
