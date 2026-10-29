// Liveness evidence for worktrees. Four independent sources, each cheap and
// cached, so the composite can name WHICH signal fired instead of guessing.
//
//   files  - mtimes of the files git reports dirty (a *recent edit*, not a session)
//   hermes - Hermes' own session store: a session whose cwd is this worktree
//   claude - Claude Code's ~/.claude/sessions files (live pid) and transcripts, placed the same way
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
import { readFile, readdir, stat, open } from "node:fs/promises";
import path from "node:path";
import { hermesHome } from "./hermes-runtime.js";

const pexec = promisify(execFile);

const TTL = { ports: 4000, pids: 4000, hermes: 5000, claude: 5000, board: 5000, env: 15000 };
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

// One line per distinct failure, not one per tick: these readers run every few seconds, and a broken
// state.db must not become a log storm. memo() serves the previous value and forgets a rejection, so
// without a line here the error that explains every missing Hermes chip existed nowhere at all.
const warned = new Set();
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.error(new Date().toISOString().slice(11, 19), message);
}
const msgOf = (e) => String((e && e.message) || e);

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
// The home is read from lib/hermes-runtime.js, the one place this panel decides where Hermes is. This
// module used to carry its own copy and the two had drifted: that copy had no MSYS guard and no HOME
// fallback, so a HERMES_HOME written in `/c/...` form sent this reader to a state.db that does not
// exist while every other Hermes read in the panel fell back to the real home. The reader feeds the
// session chips and the driest liveness signal, so the symptom was a row that went quiet with nothing
// saying why.

export function hermesSessions() {
  return memo("hermes", TTL.hermes, async () => {
    const dbPath = path.join(hermesHome(), "state.db");
    // The open is the step that fails when node:sqlite is missing or state.db cannot be read. Caught
    // here, where the reason is known, rather than left to memo(): that resolved to `null`, and the
    // caller then threw "sessions is not iterable" a layer later - the error explaining the missing
    // chips replaced by a confusing one.
    let db;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      db = new DatabaseSync(dbPath, { readOnly: true });
    } catch (e) {
      warnOnce("hermesSessions", `Hermes session store unreadable (${dbPath}): ${msgOf(e)} — hermes chips stay off until it opens`);
      return [];
    }
    try {
      // `session_turn_leases` is the authoritative "a turn is executing right now" record: the row
      // exists only while a turn runs, carries the holder (pid=...) and expires on its own. cwd says
      // where a session started; the lease says whether it is busy at this instant.
      //
      // `last_activity_at` is NULL for one-shot `hermes chat -q` sessions (measured on this build), so
      // it cannot be the only clock: fall back to the newest message the session wrote. Sorting on the
      // raw column also pushed those rows to the end of the limit and could drop them entirely.
      const activity = "coalesce(s.last_activity_at, (select max(m.timestamp) from messages m where m.session_id = s.id))";
      const rows = db
        .prepare(
          "select s.id, s.title, s.cwd, " + activity + " as last_activity_at, s.ended_at, " +
            "exists(select 1 from session_turn_leases l where l.conversation_id = s.id and l.expires_at > ?) as leased " +
            "from sessions s order by " + activity + " desc limit 300",
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

// The last thing said in a session, so a revived card reads like the conversation it brings back
// instead of an empty shell. History, not a live feed — read straight from the store on demand.
export async function hermesSessionTail(sessionId, limit = 2) {
  if (!sessionId) return [];
  const dbPath = path.join(hermesHome(), "state.db");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        "select role, content from messages where session_id = ? and role in ('user','assistant') " +
          "and content is not null and length(content) > 0 order by timestamp desc, id desc limit ?",
      )
      .all(String(sessionId), Math.max(1, Number(limit) || 2));
    return rows.reverse().map((r) => ({ role: r.role, text: String(r.content).trim().slice(0, 1500) }));
  } finally {
    db.close();
  }
}

export function hermesTouchedPaths() {
  return memo("hermesPaths", 10_000, async () => {
    const dbPath = path.join(hermesHome(), "state.db");
    let db;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      db = new DatabaseSync(dbPath, { readOnly: true });
    } catch (e) {
      warnOnce("hermesTouchedPaths", `Hermes tool history unreadable (${dbPath}): ${msgOf(e)} — session->worktree attribution falls back to the session's cwd`);
      return new Map();
    }
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
export async function hermesSessionRoots(knownWorktrees, { exclude = null } = {}) {
  const [sessions, touched] = await Promise.all([hermesSessions(), hermesTouchedPaths()]);
  return placeSessions(sessions, touched, knownWorktrees, { exclude });
}

// The attribution itself, shared by every agent whose sessions carry a start cwd and a trail of touched paths.
function placeSessions(sessions, touched, knownWorktrees, { exclude = null } = {}) {
  const roots = (knownWorktrees || []).map(norm).filter(Boolean);
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
  // `sessions` is `[]` when its reader failed (see hermesSessions) and used to be `null`, which made
  // this loop throw instead of simply drawing no chips.
  for (const s of sessions || []) {
    if (!s.open) continue;
    // A session the panel started already has a card; reporting it here too is what put "⧉ hermes" and
    // "⧉ panel" on the same row for the same agent. `exclude` is the set of panel job threads.
    if (exclude && exclude.has(s.id)) continue;
    let root = s.cwd || null;
    let matched = "cwd";
    const score = new Map(); // root -> { count, at }
    for (const entry of ((touched instanceof Map ? touched.get(s.id) : null) || []).slice(0, 6)) {
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

// ---- Claude Code's session files: cwd -> worktree, read-only ----
// `~/.claude/sessions/<pid>.json` is written by each running CLI (pid, sessionId, cwd, name, and a
// busy/idle `status`); the transcript is `~/.claude/projects/<cwd with non-alphanumerics as "-">/<id>.jsonl`.
// Neither is a documented interface, so every read is defensive: a file that does not parse, or a field
// that moved, drops that one session instead of the whole signal.
function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(process.env.USERPROFILE || process.env.HOME || "", ".claude");
}

const claudeTranscript = (s) => path.join(claudeHome(), "projects", String(s.rawCwd).replace(/[^A-Za-z0-9]/g, "-"), `${s.id}.jsonl`);

export function claudeSessions() {
  return memo("claude", TTL.claude, async () => {
    const dir = path.join(claudeHome(), "sessions");
    const [names, pids] = await Promise.all([readdir(dir).catch(() => []), runningPids()]);
    const out = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      let o;
      try {
        o = JSON.parse(await readFile(path.join(dir, name), "utf8"));
      } catch {
        continue;
      }
      // A crashed CLI leaves its file behind; the pid is what says the session is still there.
      if (!o || !o.sessionId || !o.cwd || !o.pid || !pids || !pids.has(Number(o.pid))) continue;
      const s = { id: String(o.sessionId), rawCwd: String(o.cwd), pid: Number(o.pid), title: o.name || null, cwd: norm(o.cwd) };
      const written = await stat(claudeTranscript(s)).then((st) => st.mtimeMs, () => 0);
      out.push({
        id: s.id,
        title: s.title,
        cwd: s.cwd,
        rawCwd: s.rawCwd,
        pid: s.pid,
        lastActivityAt: Math.max(Number(o.statusUpdatedAt) || 0, Number(o.updatedAt) || 0, written),
        open: true,
        running: o.status === "busy",
      });
    }
    return out;
  });
}

// What a Claude session touched last: the paths in its newest tool calls, newest first, in the same shape
// as `hermesTouchedPaths` so one attribution serves both. Only the tail of each transcript is read.
const CLAUDE_TAIL_BYTES = 256 * 1024;
const claudePathKeys = ["file_path", "path", "notebook_path", "command", "cwd"];

async function transcriptTail(file) {
  let fh;
  try {
    fh = await open(file, "r");
    const { size } = await fh.stat();
    const start = Math.max(0, size - CLAUDE_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split(/\r?\n/);
    if (start > 0) lines.shift(); // the first line is cut mid-record
    return lines;
  } catch {
    return [];
  } finally {
    await fh?.close().catch(() => {});
  }
}

export function claudeTouchedPaths() {
  return memo("claudePaths", 10_000, async () => {
    const sessions = (await claudeSessions()) || [];
    const map = new Map();
    for (const s of sessions) {
      const calls = [];
      for (const line of (await transcriptTail(claudeTranscript(s))).reverse()) {
        if (calls.length >= 40) break;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        const content = ev?.message?.content;
        if (!Array.isArray(content)) continue;
        const at = Date.parse(ev.timestamp || "") || 0;
        for (const c of content) {
          if (c?.type !== "tool_use" || !c.input) continue;
          const text = claudePathKeys.map((k) => (typeof c.input[k] === "string" ? c.input[k] : "")).join(" ");
          const paths = pathsIn(text);
          if (paths.length) calls.push({ at, paths: paths.slice(0, 60) });
        }
      }
      if (calls.length) map.set(s.id, calls);
    }
    return map;
  });
}

export async function claudeSessionRoots(knownWorktrees) {
  const [sessions, touched] = await Promise.all([claudeSessions(), claudeTouchedPaths()]);
  return placeSessions(sessions, touched, knownWorktrees);
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
export async function signalsFor(worktreePath, { lastEdit, liveMinutes = 5, sessionsByRoot = null, claudeByRoot = null } = {}) {
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
  // A leased turn is executing this instant. That beats every timestamp, and it is the ONLY clock a
  // session that never wrote `last_activity_at` (one-shot `-q` runs, resumed threads) ever offers.
  const isLive = (s) => Boolean(s.running) || (s.lastActivityAt > 0 && now - s.lastActivityAt < windowMs);
  const hermes = mine.filter(isLive);
  const stale = mine.filter((s) => !isLive(s));
  // Claude Code sessions are placed by the scheduler's pass; without it there is nothing to attribute.
  const claudeMine = claudeByRoot ? claudeByRoot.get(wt) || [] : [];
  const claude = claudeMine.filter(isLive);
  const claudeStale = claudeMine.filter((s) => !isLive(s));

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
      // WHICH sessions those are, so the row can offer to bring one back. The count alone told the
      // reader a session existed and gave them nothing to act on, while the card that would have
      // held it died with the panel's job store. The absolute timestamp is carried, not a rendered
      // "4h ago": a string would change on every scan and flag the row as changed constantly, while
      // the timestamp only moves when the session is actually used.
      idleList: stale.slice(0, 8).map((s) => ({ id: s.id, title: s.title || null, lastActivityAt: s.lastActivityAt || null })),
      // A leased turn means the session is executing THIS instant, not merely recently active.
      running: hermes.filter((s) => s.running).length,
      // The newest real activity among those sessions. Unlike the time of the scan this moves ONLY when
      // the session does something, which is what makes it usable as an ordering key: stamping every scan
      // made two live rows swap places every few seconds with no work done in either.
      at: hermes.reduce((n, s) => Math.max(n, Number(s.lastActivityAt) || 0), 0) || null,
      matched: hermes.length && hermes.every((s) => s.matched === "work") ? "work" : "cwd",
    },
    // Same shape and the same no-per-scan-timestamps rule as `hermes`. No idleList: that feeds "bring this
    // session back", which resumes through Hermes and cannot resume a Claude session.
    claude: {
      on: claude.length > 0,
      titles: claude.map((s) => s.title),
      idle: claudeStale.length,
      running: claude.filter((s) => s.running).length,
      at: claude.reduce((n, s) => Math.max(n, Number(s.lastActivityAt) || 0), 0) || null,
      matched: claude.length && claude.every((s) => s.matched === "work") ? "work" : "cwd",
    },
    board: { on: boardLive.length > 0, entries: boardLive.map((e) => ({ pid: e.pid, goal: e.goal, current: e.current })), dead: boardDead.length },
    ports: { on: openPorts.length > 0, listening: openPorts, declared: declared || [] },
  };

  const why = [];
  if (signals.hermes.on) why.push(`hermes(${hermes.length})`);
  if (signals.claude.on) why.push(`claude(${claude.length})`);
  if (signals.board.on) why.push(`board(${boardLive.length})`);
  if (signals.ports.on) why.push(`port:${openPorts.join(",")}`);
  if (signals.files.on) why.push("files");

  // A session that is OPEN but idle is a weaker claim than one that is working: it
  // stays visible as an idle chip, but it is not live evidence on its own.
  const working = why.length > 0;
  const open = !working && (stale.length > 0 || claudeStale.length > 0);
  if (open && stale.length) why.push(`hermes-open-idle(${stale.length})`);
  if (open && claudeStale.length) why.push(`claude-open-idle(${claudeStale.length})`);

  return { signals, live: working, open, liveWhy: why.join(" ") };
}

export function projectBoardSummary(rootPath) {
  return (async () => {
    const [entries, pids] = await Promise.all([boardEntries(rootPath), runningPids()]);
    const live = entries.filter((e) => e.pid && pids && pids.has(e.pid) && String(e.status || "").toUpperCase() !== "DEAD");
    return { total: entries.length, live: live.map((e) => ({ pid: e.pid, goal: e.goal })), dead: entries.length - live.length };
  })();
}
