// ---- what ONE row's own re-read found ------------------------------------------------------------
// The ⟳ in a row's actions cell is a per-row refresh, not a sweep: it re-reads this one tree's git facts, reconciles
// its TODO list against what the tree now holds, and decides whether the branch's description is still true. None of
// that is allowed to happen silently — a refresh that changed nothing and one that failed are the same pixels — so
// every action comes back as one journal line with the fact in it ("verdict MERGED -> UNMERGED", "0 -> 3 ahead").
//
// Everything here is either a pure function over two row objects (so a `node:test` can prove the decision without a
// panel, a repo or a browser) or the small store that keeps the lines the click wrote. The route and the page hold the
// wiring; the wording and the arithmetic live here, once.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { proposeClosed, TODO_OPEN } from "./todos.js";

export const REFRESH_VERSION = 1;
// Lines kept per row, and how many of them the row's detail shows: a click writes a handful, and the strip is there to
// answer "what did the last refresh find", not to become a second console.
export const REFRESH_JOURNAL_CAP = 60;
export const REFRESH_LINES_SHOWN = 3;
// How many items the reconcile may OFFER to close. Same number proposeClosed has always used.
export const REFRESH_PROPOSAL_MAX = 3;

// `off` — never; `ask` (the default) — one card, the reader starts it; `auto` — start it with the click.
export const REFRESH_AGENT_MODES = ["off", "ask", "auto"];
export const REFRESH_AGENT_DEFAULT = "ask";
export function normaliseRefreshAgent(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return REFRESH_AGENT_MODES.includes(s) ? s : REFRESH_AGENT_DEFAULT;
}

const show = (v) => (v === null || v === undefined || v === "" ? "—" : String(v));

// ---- what moved ---------------------------------------------------------------------------------
// One line per fact that actually changed, in the row's own vocabulary: the verdict badge, the ahead/behind pair, the
// cherry tally, the dirty and untracked counts, the tip, the branch and the PR. A field that did not move says nothing,
// which is what makes "re-read, nothing moved" trustworthy instead of a sentence written on every click.
export function mergeDelta(prev = {}, next = {}) {
  const out = [];
  const moved = (field) => show(prev[field]) !== show(next[field]);
  if (moved("verdict")) out.push(`verdict ${show(prev.verdict)} -> ${show(next.verdict)}`);
  if (moved("ahead")) out.push(`${show(prev.ahead)} -> ${show(next.ahead)} ahead`);
  if (moved("behind")) out.push(`${show(prev.behind)} -> ${show(next.behind)} behind`);
  if (moved("dirty")) out.push(`dirty ${show(prev.dirty)} -> ${show(next.dirty)}`);
  if (moved("untracked")) out.push(`untracked ${show(prev.untracked)} -> ${show(next.untracked)}`);
  const cherry = (r) => `+${show(r.cherryPlus ?? 0)}/−${show(r.cherryMinus ?? 0)}`;
  if (cherry(prev) !== cherry(next)) out.push(`cherry ${cherry(prev)} -> ${cherry(next)}`);
  if (moved("head")) out.push(`tip ${show(prev.head)} -> ${show(next.head)}`);
  if (moved("branch")) out.push(`branch ${show(prev.branch)} -> ${show(next.branch)}`);
  const pr = (r) => (r.pr ? `#${r.pr.number} ${r.pr.state}` : "none");
  if (pr(prev) !== pr(next)) out.push(`PR ${pr(prev)} -> ${pr(next)}`);
  return out;
}

// ---- what the tree now holds --------------------------------------------------------------------
// `git log --name-only --format=%h %s <base>..HEAD`, read once: the commit subjects the TODO proposals match on, and
// how many commits touched each file. One parser for both, because a second walk of git is a second answer that can
// disagree with the first.
const SHA_LINE = /^([0-9a-f]{7,40})\s+(.*)$/i;
export function parseCommitFiles(text) {
  const commits = [];
  const touched = new Map();
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = SHA_LINE.exec(line);
    // A commit line is `<sha> <subject>`; anything else is a path the commit touched. A root-level file whose name
    // starts with seven hex characters and a space cannot exist as a path here, so the shape is unambiguous.
    if (m) {
      commits.push({ sha: m[1], subject: m[2] });
      continue;
    }
    if (!commits.length) continue;
    const key = line.replace(/\\/g, "/");
    touched.set(key, (touched.get(key) || 0) + 1);
  }
  return {
    commits,
    // The form proposeClosed expects: it strips a leading hex itself, so the sha travels with the subject.
    subjects: commits.map((c) => `${c.sha} ${c.subject}`),
    touched: [...touched].map(([p, commits]) => ({ path: p, commits })).sort((a, b) => b.commits - a.commits),
  };
}

const normFile = (p) => String(p ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
// An item's `files` entry and a path git reported are the same file when they are equal, or when one is the tail of the
// other on a path boundary — an item written from the project root (`public/app.js`) versus the tree's own report, and
// the reverse. A bare basename never matches on its own: two `index.js` in one tree are different work.
function sameFile(a, b) {
  const x = normFile(a);
  const y = normFile(b);
  if (!x || !y) return false;
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

// The file half of the proposal: an item that names its files, where a commit in this branch touched one of them. The
// commit half is lib/todos.js's own proposeClosed — this file adds the evidence it cannot see and nothing else.
export function proposeFromFiles(items = [], touched = []) {
  const out = [];
  for (const item of items) {
    if (!TODO_OPEN.includes(String(item?.status || ""))) continue;
    const files = Array.isArray(item.files) ? item.files : [];
    if (!files.length) continue;
    const hit = (touched || []).find((t) => t && t.path && files.some((f) => sameFile(f, t.path)));
    if (!hit) continue;
    out.push({
      id: item.id,
      text: item.text,
      because: `${hit.commits} commit${hit.commits === 1 ? "" : "s"} touched ${normFile(hit.path)}`,
      shared: 0,
      matched: "files",
    });
  }
  return out;
}

// Both halves, deduped by item id and capped. A proposal is a QUESTION for the reader: nothing here marks an item done,
// and the caller may only show it (lib/todos.js `propose` writes it onto the list, statuses untouched).
export function todoProposals({ items = [], subjects = [], touchedFiles = [] } = {}, { max = REFRESH_PROPOSAL_MAX } = {}) {
  const byCommit = proposeClosed(items, subjects, { max: Math.max(max * 2, max) }).map((p) => ({ ...p, matched: "commits" }));
  const byFile = proposeFromFiles(items, touchedFiles);
  const out = [];
  for (const p of [...byCommit, ...byFile]) {
    if (!p || !Number.isFinite(Number(p.id))) continue;
    if (out.some((o) => Number(o.id) === Number(p.id))) continue;
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

// ---- which run, if any, already holds this tree --------------------------------------------------
// The delete route refuses while an agent is live in the directory, and so must a refresh that wants to START one: a
// second turn in a tree somebody is already editing is how two agents fight over the same files. `isLive` and `norm`
// are passed in so this stays a pure function over the job list.
export function liveRunIn(jobs = [], target, { isLive = () => false, norm = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() } = {}) {
  const want = norm(target);
  if (!want) return null;
  for (const j of jobs || []) {
    if (!j || !isLive(j.status)) continue;
    const paths = [j.cwd, j.ownerPath].filter(Boolean).map(norm);
    if (paths.includes(want)) return j;
  }
  return null;
}

// ---- the journal the click writes ----------------------------------------------------------------
// One line per action, kept beside the panel's other stores (never inside the worktree, where it would be git noise) and
// written atomically like them. A row's last few lines ride with the snapshot, so the row's detail can say what its ⟳
// found without a second request — and a reload comes back to the same record.
export class RefreshJournal {
  constructor({ file = null, log = () => {} } = {}) {
    this.file = file;
    this.log = log;
    this.rows = new Map();
    this.loaded = false;
  }

  load() {
    if (this.loaded) return this;
    this.loaded = true;
    if (!this.file) return this;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      const rows = raw && typeof raw === "object" && raw.rows && typeof raw.rows === "object" ? raw.rows : {};
      for (const [key, rec] of Object.entries(rows)) {
        if (!rec || typeof rec !== "object") continue;
        const lines = (Array.isArray(rec.lines) ? rec.lines : [])
          .filter((l) => l && String(l.text || "").trim())
          .map((l) => ({ at: l.at || null, text: String(l.text) }))
          .slice(-REFRESH_JOURNAL_CAP);
        if (!lines.length) continue;
        this.rows.set(key, { key, project: rec.project || null, path: rec.path || null, at: rec.at || lines[lines.length - 1].at || null, lines });
      }
    } catch (err) {
      if (existsSync(this.file)) this.log(`refresh journal: could not read ${this.file} (${String((err && err.message) || err)}) — starting empty`);
    }
    return this;
  }

  // The lines already written for one row, oldest first.
  lines(key) {
    this.load();
    return (key && this.rows.get(key)?.lines) || [];
  }

  // The newest few, for the row's detail: newest first, the way the journal strip reads.
  recent(key, n = REFRESH_LINES_SHOWN) {
    return this.lines(key).slice(-Math.max(1, n)).reverse();
  }

  // Append one click's lines and save. `entries` are plain strings — the route has already put the fact in each one.
  append({ project = null, path: treePath = null, key = null, lines = [] } = {}) {
    this.load();
    const k = key || (project && treePath ? `${project}::${String(treePath).replace(/\\/g, "/").replace(/\/+$/, "")}` : null);
    const text = (Array.isArray(lines) ? lines : []).map((t) => String(t ?? "").trim()).filter(Boolean);
    if (!k || !text.length) return { key: k, added: 0, lines: [] };
    const at = new Date().toISOString();
    const prev = this.rows.get(k) || { key: k, project, path: treePath || null, at: null, lines: [] };
    const added = text.map((t) => ({ at, text: t }));
    const rec = { ...prev, project: project || prev.project, path: treePath || prev.path, at, lines: [...prev.lines, ...added].slice(-REFRESH_JOURNAL_CAP) };
    this.rows.set(k, rec);
    this.save();
    return { key: k, added: added.length, lines: added };
  }

  save() {
    if (!this.file) return false;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const body = {
        version: REFRESH_VERSION,
        savedAt: new Date().toISOString(),
        rows: Object.fromEntries([...this.rows].map(([k, v]) => [k, { key: v.key, project: v.project, path: v.path, at: v.at, lines: v.lines }])),
      };
      // Written beside the target and renamed over it, so a reader (or a crash) never sees half a file.
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
      renameSync(tmp, this.file);
      return true;
    } catch (err) {
      // The click has already happened; losing its note costs one re-read, not the refresh.
      this.log(`refresh journal: could not write ${this.file} (${String((err && err.message) || err)})`);
      return false;
    }
  }
}
