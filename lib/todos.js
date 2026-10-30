// The TODO list of a worktree: written by the assistant, kept up to date by every agent in the tree, and read by
// the reader in the row.
//
// One list per WORKTREE, keyed the way the board's row already is (`keyOf(project, path)`, shared with
// public/app.js), not per thread: a tree outlives its threads, and the section the reader asked for is on the row.
// The store lives beside the panel's job store — never inside the worktree, where it would be git noise and a merge
// conflict — and it is written atomically like the panel's other stores.
//
// The file-race problem the other shared-task-list systems fight does not exist here: every writer in this fleet
// (the assistant, every worker's harvested final message, the reader's own edits in the page) goes through this one
// Node process, so this module is the single writer and serialises by construction.
//
// The schema, and why each field is there:
//
//   id         a monotonically increasing integer WITHIN this list, never reused. A stale report that says
//              `TODO DONE 3` months later cannot close a different item, because 3 is never handed out twice.
//   text       what has to happen, in the words of whoever wrote it.
//   status     todo | doing | done | dropped.
//   owner      the thread that claimed or completed it (null when nobody has).
//   claimedAt  when it was claimed — how a crashed agent's stale claim is spotted and taken over.
//   files      optional: what the item touches, so two agents do not edit the same thing.
//   note       optional: why it was dropped, what is left, what the reader said.
//   at         when the item last CHANGED (not when it was created).
//   by         who changed it: `worker:<thread>` | `assistant` | `reader`.
//
// Nothing here invents an item, and nothing here marks anything done on its own: a wrong auto-completion is worse
// than an unfinished line, so the panel only ever applies a change somebody actually wrote.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const TODOS_VERSION = 1;
export const TODO_STATUSES = ["todo", "doing", "done", "dropped"];
// What "incomplete" means for the collapsed line: the reader asked for the OLDEST item yet to be completed, and
// `doing` is not completed either.
export const TODO_OPEN = ["todo", "doing"];
export const TODO_JOURNAL_CAP = 60;
export const TODO_TEXT_CAP = 400;

// One key, two spellings of the same tree. `keyOf(project, path)` in public/app.js is exactly `${project}::${path}`
// over the row's forward-slashed path (lib/scan.js), so normalising here is what makes the page's key and the
// store's key the same string.
export const normTodoPath = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
export const todoKey = (project, treePath) => `${String(project ?? "")}::${normTodoPath(treePath)}`;
export const isTodoStatus = (s) => TODO_STATUSES.includes(String(s || "").toLowerCase());

const oneLine = (s, n = 200) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const clip = (s, n) => (String(s ?? "").length > n ? String(s).slice(0, n) : String(s ?? ""));
const nowIso = () => new Date().toISOString();

// ---- the pure half -----------------------------------------------------------------------------------------------
// Everything below is a pure function of the items, so the collapsed line, the counts and the proposals are testable
// without a panel, a store or a browser.

// The item the collapsed strip reads: the LOWEST id whose status is todo or doing. Out-of-order completion is the
// normal case — a later item finished first is not what the reader wants to be told about — so this is deliberately
// not "the most recently touched item".
export function oldestOpen(items = []) {
  let best = null;
  for (const item of items) {
    if (!TODO_OPEN.includes(String(item?.status || ""))) continue;
    if (!best || Number(item.id) < Number(best.id)) best = item;
  }
  return best;
}

export function todoCounts(items = []) {
  const out = { total: items.length, done: 0, dropped: 0, doing: 0, open: 0 };
  for (const item of items) {
    const s = String(item?.status || "");
    if (s === "done") out.done += 1;
    else if (s === "dropped") out.dropped += 1;
    else if (s === "doing") out.doing += 1;
    if (TODO_OPEN.includes(s)) out.open += 1;
  }
  return out;
}

// `ageMs` is measured against a caller-supplied clock so a test can drive it without waiting.
export function itemAge(item, now = Date.now()) {
  const at = Date.parse(String(item?.at || ""));
  if (!Number.isFinite(at)) return null;
  return Math.max(0, now - at);
}

// What a row carries: the counts, the OLDEST incomplete item, and nothing that would grow the row.
export function todoSummary(items = [], { now = Date.now() } = {}) {
  const counts = todoCounts(items);
  const oldest = oldestOpen(items);
  return {
    ...counts,
    nextId: items.reduce((n, i) => Math.max(n, Number(i?.id) || 0), 0) + 1,
    oldest: oldest
      ? {
          id: oldest.id,
          text: oldest.text,
          status: oldest.status,
          owner: oldest.owner || null,
          by: oldest.by || null,
          at: oldest.at || null,
          ageMs: itemAge(oldest, now),
        }
      : null,
  };
}

// The glyph the strip draws per status. Kept beside the statuses so the two cannot drift.
export const TODO_GLYPH = { todo: "□", doing: "▶", done: "✓", dropped: "⊘" };

// ---- the action lines --------------------------------------------------------------------------------------------
// ONE grammar, read by three callers: the assistant's own reply (lib/assistant/actions.js), a worker's final message
// (harvested at the end of a run) and the reader's edits (which do not go through text at all, but share the ops).
//
//   TODO <text>                     add, in the tree this reply is about
//   TODO IN <tree> | <text>         add, in the named tree
//   TODO ADD <text>                 the same as `TODO <text>`, spelled out
//   TODO DONE <id>                  mark done
//   TODO DOING <id>                 claim it
//   TODO DROP <id>                  drop it
//   TODO REOPEN <id>                put a done/dropped item back to todo
//   (each of the four id forms also accepts `IN <tree> | <id>`)
//
// Nothing is dropped in silence: a line that looks like a TODO line and cannot be read comes back with an `error`,
// and the caller is expected to SAY it (on the card, in the journal) rather than swallow it.
const TODO_OP_WORDS = ["ADD", "DONE", "DOING", "DROP", "REOPEN"];
const ID_OPS = { DONE: "done", DOING: "doing", DROP: "drop", REOPEN: "reopen" };

export function parseTodoLines(text) {
  const out = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^TODO\b/i.test(line)) continue;
    const body = line.replace(/^TODO\b/i, "").trim();
    if (!body) {
      out.push({ op: "add", id: null, text: "", target: null, raw: line, error: "a TODO line needs some text" });
      continue;
    }
    // `IN <tree> | <rest>` on any op. The pipe is the separator, exactly as SPAWN uses it: a Windows path carries
    // colons, so a colon cannot also be the field break.
    let target = null;
    let rest = body;
    const inMatch = /^IN\s+(.+?)\s*\|\s*([^]*)$/i.exec(body);
    if (inMatch) {
      target = inMatch[1].trim().replace(/^["']|["']$/g, "");
      rest = inMatch[2].trim();
      if (!target) {
        out.push({ op: "add", id: null, text: "", target: null, raw: line, error: "TODO IN needs a worktree (a path, a directory name, a branch or a thread)" });
        continue;
      }
    }
    const word = /^([A-Za-z]+)\b\s*([^]*)$/.exec(rest);
    const opWord = word && TODO_OP_WORDS.includes(word[1].toUpperCase()) ? word[1].toUpperCase() : null;
    if (opWord && ID_OPS[opWord]) {
      const arg = String(word[2] || "").trim().replace(/^#/, "");
      if (!/^\d+$/.test(arg)) {
        out.push({
          op: ID_OPS[opWord],
          id: null,
          text: "",
          target,
          raw: line,
          error: `TODO ${opWord} needs an item id${arg ? ` (got “${oneLine(arg, 40)}”)` : ""} — the ids are the numbers the panel lists with the items`,
        });
        continue;
      }
      out.push({ op: ID_OPS[opWord], id: Number(arg), text: "", target, raw: line, error: null });
      continue;
    }
    if (opWord === "ADD") rest = String(word[2] || "").trim();
    if (!rest) {
      out.push({ op: "add", id: null, text: "", target, raw: line, error: `TODO ${opWord || ""}`.trim() + " needs some text" });
      continue;
    }
    out.push({ op: "add", id: null, text: clip(rest, TODO_TEXT_CAP), target, raw: line, error: null });
  }
  return out;
}

// The block the panel prepends to a worker's brief (and to a steer). It carries the list WITH ITS IDS — an agent
// cannot mark an item done without knowing which number it is — and the standing instruction, whose last line is
// the one the reader named as the hard part: reconcile against your own commits before you finish.
export function todoBlock(items = [], { where = "", project = "", standing = true } = {}) {
  const lines = [];
  lines.push(`TODO — the list for this worktree${where ? ` (${where})` : ""}${project ? ` in project ${project}` : ""}, kept by the panel:`);
  if (!items.length) {
    lines.push("  (empty — nothing has been written down for this tree yet)");
  } else {
    for (const item of items) {
      const id = String(item.id).padStart(2, " ");
      const owner = item.owner ? ` · ${item.owner}` : "";
      const note = item.note ? ` — ${oneLine(item.note, 120)}` : "";
      lines.push(`  ${id}. [${String(item.status || "todo").padEnd(7)}] ${oneLine(item.text, 220)}${owner}${note}`);
    }
    const c = todoCounts(items);
    lines.push(`  (${c.done}/${c.total} done${c.dropped ? `, ${c.dropped} dropped` : ""})`);
  }
  if (!standing) return lines.join("\n");
  lines.push("Keep it current as you work — write these lines on their own lines in your FINAL message, because the panel reads the list out of your last words and not out of the middle of your transcript:");
  lines.push("  TODO DONE <id>      an item YOUR OWN work has just closed (do this as you go, not at the end)");
  lines.push("  TODO DOING <id>     you are starting it now");
  lines.push("  TODO ADD <text>     something you found that has to be fixed too");
  lines.push("  TODO DROP <id>      it no longer applies — say why in a TODO ADD or in your prose");
  lines.push("  (each of those also takes `IN <tree> | <id>` when you mean a different worktree)");
  lines.push("BEFORE YOU END YOUR TURN, RECONCILE THIS LIST AGAINST WHAT YOU ACTUALLY COMMITTED: run `git log --oneline <base>..HEAD` on this branch and mark done every item your own commits already closed. Nothing else closes them — the panel never marks an item done on its own, and a run that leaves commits while claiming nothing is reported to the reader as unfinished.");
  return lines.join("\n");
}

// What a run that left commits and claimed nothing may PROPOSE (never do). A commit subject and an item share a few
// long words is a hint worth showing the reader; it is a proposal and the card says so.
const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "when", "them", "then", "than", "over", "under", "item", "list", "todo", "done", "worktree", "branch", "commit", "commits", "panel", "agent", "agents", "file", "files", "code"]);
export function words(s) {
  return new Set(
    String(s ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !STOP.has(w)),
  );
}

export function proposeClosed(items = [], subjects = [], { max = 3 } = {}) {
  const commits = (subjects || []).map((s) => ({ raw: String(s), words: words(String(s).replace(/^[0-9a-f]{7,}\s+/i, "")) }));
  const out = [];
  for (const item of items) {
    if (!TODO_OPEN.includes(String(item?.status || ""))) continue;
    const mine = words(item.text);
    if (!mine.size) continue;
    for (const c of commits) {
      let shared = 0;
      for (const w of mine) if (c.words.has(w)) shared += 1;
      if (shared >= 2) {
        out.push({ id: item.id, text: item.text, because: oneLine(c.raw, 90), shared });
        break;
      }
    }
    if (out.length >= max) break;
  }
  return out;
}

// ---- the store ---------------------------------------------------------------------------------------------------
export class TodoLists {
  // `trees` and `jobs` are the two things this store cannot know by itself: which worktrees the panel has (to turn
  // a name, a branch or a tag into a project+path) and the job store (to turn a THREAD into the tree it ran in).
  // Both are providers rather than values, so they can be wired after construction (server.js).
  constructor({ file = null, log = () => {}, trees = null, jobs = null } = {}) {
    this.file = file;
    this.log = log;
    this.treesProvider = trees;
    this.jobsProvider = jobs;
    this.lists = new Map();
    this.loaded = false;
  }

  load() {
    if (this.loaded) return this;
    this.loaded = true;
    if (!this.file) return this;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      const lists = raw && typeof raw === "object" && raw.lists && typeof raw.lists === "object" ? raw.lists : {};
      for (const [key, rec] of Object.entries(lists)) {
        if (!rec || typeof rec !== "object") continue;
        const items = (Array.isArray(rec.items) ? rec.items : [])
          .filter((i) => i && Number.isFinite(Number(i.id)) && String(i.text || "").trim())
          .map((i) => ({
            id: Number(i.id),
            text: String(i.text),
            status: isTodoStatus(i.status) ? String(i.status).toLowerCase() : "todo",
            owner: i.owner || null,
            claimedAt: i.claimedAt || null,
            files: Array.isArray(i.files) ? i.files.map(String) : [],
            note: i.note ? String(i.note) : "",
            at: i.at || null,
            by: i.by || null,
          }));
        // `nextId` is DERIVED on load rather than trusted: a file written by an older build (or edited by hand)
        // must never be able to hand the same id out twice, which is the one property the whole scheme rests on.
        const nextId = Math.max(Number(rec.nextId) || 1, items.reduce((n, i) => Math.max(n, i.id), 0) + 1);
        this.lists.set(key, {
          key,
          project: rec.project || String(key).split("::")[0] || null,
          path: normTodoPath(rec.path || String(key).slice(String(key).indexOf("::") + 2)),
          nextId,
          items,
          // A reconcile's proposal is a QUESTION kept beside the list, not a change to it: it survives a reload so a
          // reader who comes back still sees what the ⟳ thought looked closed, and it is cleared by the first real
          // change to the list (see `write`).
          proposal: (Array.isArray(rec.proposal) ? rec.proposal : [])
            .filter((p) => p && Number.isFinite(Number(p.id)))
            .map((p) => ({ id: Number(p.id), text: String(p.text || ""), because: String(p.because || ""), matched: p.matched || null, at: p.at || null })),
          journal: (Array.isArray(rec.journal) ? rec.journal : []).slice(-TODO_JOURNAL_CAP),
        });
      }
    } catch (err) {
      if (existsSync(this.file)) this.log(`todos: could not read ${this.file} (${String((err && err.message) || err)}) — starting empty`);
    }
    return this;
  }

  get size() {
    this.load();
    return this.lists.size;
  }

  list(key) {
    this.load();
    return (key && this.lists.get(key)) || null;
  }

  items(key) {
    return this.list(key)?.items || [];
  }

  // Create-on-demand: a list is a fact about a tree, not something the reader has to make first.
  ensure({ project, path: treePath } = {}) {
    this.load();
    const key = this.keyFor({ project, path: treePath });
    if (!key) return null;
    const prev = this.lists.get(key);
    if (prev) {
      if (project && !prev.project) prev.project = String(project);
      return prev;
    }
    const at = this.canonical({ project, path: treePath });
    const rec = { key, project: String(project || at.project || key.split("::")[0]), path: at.path, nextId: 1, items: [], proposal: [], journal: [] };
    this.lists.set(key, rec);
    return rec;
  }

  // One tree, one key, one path. A caller may hand over a directory INSIDE a tree (a job's cwd can be `…/lib`), so
  // the path is canonicalised to the tree the panel knows before it becomes part of a key or of a record.
  canonical({ project = null, path: treePath = null } = {}) {
    const p = normTodoPath(treePath);
    if (!p) return { key: null, project: project || null, path: null };
    const found = this.treeFor(p);
    const resolvedProject = project || found?.project || this.projectForPath(p);
    const resolvedPath = found?.path ? normTodoPath(found.path) : p;
    return { key: resolvedProject ? todoKey(resolvedProject, resolvedPath) : null, project: resolvedProject, path: resolvedPath };
  }

  // `${project}::${path}`, with the project resolved from the panel's own trees when the caller does not know it
  // (a worker's card carries a path; the assistant's line may name only a directory).
  keyFor(args = {}) {
    return this.canonical(args).key;
  }

  trees() {
    if (typeof this.treesProvider !== "function") return [];
    try {
      const out = this.treesProvider() || [];
      return out.filter((t) => t && t.path);
    } catch {
      return [];
    }
  }

  // The tree a path names: exact, then "a directory inside it" (a job's cwd can be `…/lib`).
  treeFor(treePath) {
    const want = normTodoPath(treePath).toLowerCase();
    if (!want) return null;
    const all = this.trees();
    return (
      all.find((t) => normTodoPath(t.path).toLowerCase() === want) ||
      all
        .filter((t) => want.startsWith(`${normTodoPath(t.path).toLowerCase()}/`))
        .sort((a, b) => normTodoPath(b.path).length - normTodoPath(a.path).length)[0] ||
      null
    );
  }

  // A tree named the way an agent writes it: a path, a directory name, a branch, a six-hex tag, a project::path key,
  // or a THREAD (which is how the assistant can name a tree it only knows by its card). Several matches are refused
  // with every candidate named — never silently picked.
  resolve(target) {
    const asked = String(target ?? "").trim().replace(/^["']|["']$/g, "");
    if (!asked) return { ok: false, error: "no worktree named" };
    const jobs = typeof this.jobsProvider === "function" ? this.jobsProvider() : null;
    const found = [];
    const push = (how, t) => {
      if (!t?.path) return;
      const key = todoKey(t.project, t.path);
      if (!found.some((f) => f.key === key)) found.push({ key, project: t.project, path: normTodoPath(t.path), branch: t.branch || null, how });
    };
    // 1. The key as written, then a real path (exact, then a directory inside a tree).
    if (asked.includes("::")) {
      const [project, ...rest] = asked.split("::");
      const t = this.treeFor(rest.join("::"));
      if (t) push("the row's own key", { ...t, project: t.project || project });
    }
    if (/[\\/]/.test(asked)) {
      const t = this.treeFor(asked);
      if (t) push("that path", t);
      else if (path.isAbsolute(asked) || /^[A-Za-z]:/.test(asked)) {
        // A tree the panel has not scanned into a row yet (a worktree cut a second ago): its project comes from the
        // registry, and the path is the tree.
        const project = this.projectForPath(asked);
        if (project) push("that path (no row for it yet)", { project, path: asked });
      }
    }
    // 2. A six-hex tag — the one part of a name a rename keeps.
    const tag = /(?:^|[^0-9a-z])([0-9a-f]{6})(?:$|[^0-9a-z])/i.exec(asked);
    if (tag) {
      const hex = tag[1].toLowerCase();
      for (const t of this.trees()) {
        if (normTodoPath(t.path).split("/").filter(Boolean).pop()?.toLowerCase().endsWith(`-${hex}`)) push("its six-hex tag", t);
      }
    }
    // 3. A branch name, and 4. a directory leaf.
    for (const t of this.trees()) {
      const leaf = normTodoPath(t.path).split("/").filter(Boolean).pop() || "";
      if (t.branch && String(t.branch).toLowerCase() === asked.toLowerCase()) push("its branch", t);
      else if (leaf.toLowerCase() === asked.toLowerCase()) push("its directory name", t);
    }
    // 5. A thread: the tree that thread ran in (its first turn's own record).
    if (jobs) {
      const job = [...jobs.jobs.values()].find((j) => j.thread === asked) || null;
      if (job) {
        for (const p of [job.worktreePath, job.ownerPath, job.cwd]) {
          if (!p) continue;
          const t = this.treeFor(p);
          push(`the tree thread ${asked} ran in`, t || { project: job.project ? job.project : this.projectForPath(p), path: p });
          break;
        }
      }
    }
    // 6. A project name, when that project has exactly ONE tree: the assistant's `TODO IN <project>`.
    const proj = this.trees().filter((t) => String(t.project).toLowerCase() === asked.toLowerCase());
    if (proj.length === 1) push("the only tree in that project", proj[0]);
    const unique = [...new Map(found.filter((f) => f.project).map((f) => [f.key, f])).values()];
    if (unique.length === 1) return { ok: true, ...unique[0] };
    if (unique.length > 1) return { ok: false, error: `“${asked}” names ${unique.length} worktrees`, candidates: unique.map((f) => f.path) };
    return { ok: false, error: `no worktree matches “${asked}”` };
  }

  // The project a path belongs to, from the panel's own registry/rows: the last resort when a caller knows only a
  // directory. Prefix match, longest first, so a worktree inside a project is still that project's.
  projectForPath(treePath) {
    const want = normTodoPath(treePath).toLowerCase();
    if (!want) return null;
    const all = this.trees();
    const exact = all.find((t) => normTodoPath(t.path).toLowerCase() === want);
    if (exact?.project) return exact.project;
    return (
      all
        .filter((t) => want.startsWith(`${normTodoPath(t.path).toLowerCase()}/`))
        .sort((a, b) => normTodoPath(b.path).length - normTodoPath(a.path).length)[0]?.project || null
    );
  }

  // ---- writes ----------------------------------------------------------------------------------------------------
  // Every write goes through here: it stamps the item, journals who did it and why, saves, and returns a result the
  // caller is expected to SAY. `by` is `worker:<thread>` / `assistant` / `reader` — never guessed.
  write({ project = null, path: treePath = null, op, id = null, text = "", status = null, by = null, owner = null, files = null, note = null, from = null }) {
    this.load();
    const key = this.keyFor({ project, path: treePath });
    if (!key) return { ok: false, error: `no project could be worked out for ${treePath || "(no path)"} — the list is keyed on the row` };
    const rec = this.ensure({ project, path: treePath });
    const at = nowIso();
    const who = String(by || owner || "unknown");
    const journal = (entry) => {
      rec.journal.push({ at, by: who, op, id: entry?.id ?? id ?? null, text: entry?.text ?? oneLine(text, 160), from: from || null });
      if (rec.journal.length > TODO_JOURNAL_CAP) rec.journal = rec.journal.slice(-TODO_JOURNAL_CAP);
    };

    if (op === "add") {
      const body = oneLine(text, TODO_TEXT_CAP);
      if (!body) return { ok: false, error: "an item needs some text" };
      const item = {
        id: rec.nextId,
        text: body,
        status: isTodoStatus(status) ? String(status).toLowerCase() : "todo",
        owner: owner || null,
        claimedAt: TODO_OPEN.includes(String(status || "todo")) && owner ? at : null,
        files: Array.isArray(files) ? files.map(String) : [],
        note: note ? oneLine(note, 400) : "",
        at,
        by: who,
      };
      rec.nextId += 1;
      rec.items.push(item);
      journal(item);
      this.save();
      return { ok: true, op, key, list: rec, item };
    }

    const item = rec.items.find((i) => Number(i.id) === Number(id));
    if (!item) {
      // Said, never swallowed: an id that does not exist in this list is the one line a stale report writes.
      const highest = rec.items.reduce((n, i) => Math.max(n, i.id), 0);
      return {
        ok: false,
        op,
        key,
        list: rec,
        error: `no item ${id} in this list${highest ? ` — its ids run 1..${highest}` : " — it has no items yet"}`,
      };
    }

    if (op === "edit") {
      const body = oneLine(text, TODO_TEXT_CAP);
      if (!body) return { ok: false, op, key, list: rec, error: "an item needs some text" };
      item.text = body;
    } else if (op === "note") {
      item.note = note ? oneLine(note, 400) : "";
    } else if (op === "files") {
      item.files = Array.isArray(files) ? files.map(String) : [];
    } else if (op === "status") {
      const want = String(status || "").toLowerCase();
      if (!isTodoStatus(want)) return { ok: false, op, key, list: rec, error: `“${status}” is not one of ${TODO_STATUSES.join(" / ")}` };
      item.status = want;
      if (TODO_OPEN.includes(want)) item.claimedAt = want === "doing" ? at : item.claimedAt || null;
      else item.claimedAt = null;
    } else {
      return { ok: false, op, key, list: rec, error: `unknown todo op “${op}”` };
    }
    item.at = at;
    item.by = who;
    if (owner) item.owner = owner;
    if (note !== null && op !== "note") item.note = note ? oneLine(note, 400) : "";
    if (files !== null && op !== "files") item.files = Array.isArray(files) ? files.map(String) : [];
    // The list moved, so a reconcile's proposal no longer describes it: any change to an item settles it. An `add` is
    // the one write that leaves the proposal standing — a new line does not answer a question about the old ones.
    rec.proposal = [];
    journal(item);
    this.save();
    return { ok: true, op, key, list: rec, item };
  }

  // The four status changes the action lines map to, plus the reader's own buttons.
  setStatus(args) {
    const map = { done: "done", doing: "doing", drop: "dropped", dropped: "dropped", reopen: "todo", todo: "todo" };
    const want = map[String(args?.op || "").toLowerCase()];
    if (!want) return { ok: false, error: `unknown todo op “${args?.op}”` };
    return this.write({ ...args, op: "status", status: want });
  }

  // Apply a batch of parsed action lines (parseTodoLines) to this tree's list — the ONE path every writer takes:
  // the assistant's reply, a worker's harvested final message, and the reader's page all end up here. Each line
  // comes back with its own result, so the caller can say the refusals instead of dropping them: a line whose id
  // is not in the list, or whose text is empty, is a failure with a reason and never a silent no-op.
  //
  // A line that carries its own `IN <tree>` is resolved first; when it names nothing the panel knows, or names
  // several trees, THAT is the refusal — a change is never guessed into a tree.
  applyLines({ project = null, path: treePath = null, lines = [], by = "assistant", owner = null, from = null } = {}) {
    const results = [];
    for (const line of Array.isArray(lines) ? lines : []) {
      if (!line || typeof line !== "object") continue;
      const base = { project, path: treePath, by, owner, from: from || line.op || null };
      let args = base;
      if (line.target) {
        const hit = this.resolve(line.target);
        if (!hit.ok) {
          results.push({ ok: false, op: line.op, id: line.id ?? null, text: line.text || "", raw: line.raw || "", error: hit.error, candidates: hit.candidates || null });
          continue;
        }
        args = { ...base, project: hit.project, path: hit.path };
      }
      if (line.error) {
        results.push({ ok: false, op: line.op, id: line.id ?? null, text: line.text || "", raw: line.raw || "", error: line.error });
        continue;
      }
      let r;
      if (line.op === "add") r = this.write({ ...args, op: "add", text: line.text });
      else r = this.setStatus({ ...args, op: line.op, id: line.id });
      results.push({ ...r, op: line.op, id: line.id ?? null, text: line.text || "", raw: line.raw || "" });
    }
    return results;
  }

  // A run's last words, harvested. This is the worker half of the protocol: an agent cannot call the panel, so it
  // writes `TODO DONE 3` on its own line and the panel reads it out of the message when the run settles. The lines
  // are applied under `by: "worker:<thread>"`, with the thread as the owner, and the journal records it.
  //
  // Returns the changes it made and the lines it refused, in the caller's own words — the card is where a refusal
  // is said. It never marks anything done on its own: only a line the worker actually wrote closes an item.
  harvest({ job = {}, finalText = "", by = null, owner = null } = {}) {
    const treePath = job.worktreePath || job.ownerPath || job.cwd || null;
    const project = job.project || this.projectForPath(treePath);
    const who = by || (job.thread ? `worker:${job.thread}` : "worker");
    const lines = parseTodoLines(finalText);
    if (!lines.length) return { lines: 0, changes: [], refused: [], key: this.keyFor({ project, path: treePath }) };
    const results = this.applyLines({ project, path: treePath, lines, by: who, owner: owner ?? job.thread ?? null, from: "worker" });
    return {
      lines: lines.length,
      key: this.keyFor({ project, path: treePath }),
      changes: results.filter((r) => r.ok).map((r) => ({ id: r.item?.id ?? r.id ?? null, op: r.op, text: r.item?.text || r.text || "", status: r.item?.status || null })),
      refused: results.filter((r) => !r.ok).map((r) => ({ op: r.op, id: r.id ?? null, text: r.text || "", raw: r.raw || "", error: r.error })),
    };
  }

  // The assistant's seeding of a new tree: the acceptance items of a brief, in order, as the list. One call, ids
  // handed out in order, and the journal says where they came from.
  seed({ project, path: treePath, texts = [], by = "assistant", owner = null, from = null }) {
    const out = [];
    for (const text of texts) {
      const r = this.write({ project, path: treePath, op: "add", text, by, owner, from });
      if (r.ok) out.push(r.item);
      else if (r.error) this.log(`todos: could not seed “${oneLine(text, 60)}” — ${r.error}`);
    }
    return out;
  }

  // The reconcile the ⟳ runs: what this tree's commits and touched files make look CLOSED. It writes a proposal beside
  // the list — shown on the row's TODO badge — and never touches a status: a wrong auto-completion is worse than an
  // unfinished line, so the only thing this method can do is ask. It journals the proposal once, so the list's own
  // journal carries the evidence, and an unchanged proposal writes nothing (a click that finds the same answer twice is
  // not two events).
  propose({ project = null, path: treePath = null, proposals = [], by = "panel" } = {}) {
    this.load();
    const key = this.keyFor({ project, path: treePath });
    const rec = key ? this.list(key) : null;
    if (!rec) return { ok: false, key, changed: false, proposals: [], error: `no TODO list for ${treePath || "(no path)"} — nothing to reconcile` };
    const at = nowIso();
    const next = (Array.isArray(proposals) ? proposals : [])
      .filter((p) => p && Number.isFinite(Number(p.id)) && String(p.because || "").trim())
      .map((p) => ({ id: Number(p.id), text: String(p.text || ""), because: oneLine(p.because, 120), matched: p.matched || null, at }));
    const sig = (list) => JSON.stringify((list || []).map((p) => [Number(p.id), String(p.because || "")]));
    const changed = sig(rec.proposal) !== sig(next);
    rec.proposal = next;
    if (changed) {
      const sentence = next.length
        ? `${next.length} item${next.length === 1 ? "" : "s"} look closed: ${next.map((p) => `#${p.id} “${oneLine(p.text, 60)}” (${p.because})`).join("; ")} — nothing marked done`
        : "no open item is named by this tree's commits or touched files";
      rec.journal.push({ at, by: String(by || "panel"), op: "reconcile", id: null, text: sentence, from: "refresh" });
      if (rec.journal.length > TODO_JOURNAL_CAP) rec.journal = rec.journal.slice(-TODO_JOURNAL_CAP);
      this.save();
    }
    return { ok: true, key, changed, proposals: next };
  }

  summary(key, { now = Date.now() } = {}) {
    const rec = this.list(key);
    if (!rec) return null;
    return { key: rec.key, project: rec.project, path: rec.path, ...todoSummary(rec.items, { now }) };
  }

  // Everything a row needs to draw the strip, journal included (the expanded strip quotes it).
  forRow(project, treePath, { now = Date.now(), journal = 6 } = {}) {
    const key = this.keyFor({ project, path: treePath });
    const rec = key ? this.list(key) : null;
    if (!rec || !rec.items.length) return null;
    return {
      ...todoSummary(rec.items, { now }),
      // What the last ⟳ thought looked closed. On the row's badge, never applied: the reader's click is the only thing
      // that closes an item.
      proposal: rec.proposal || [],
      items: rec.items.map((i) => ({
        id: i.id,
        text: i.text,
        status: i.status,
        owner: i.owner || null,
        claimedAt: i.claimedAt || null,
        files: i.files || [],
        note: i.note || "",
        at: i.at || null,
        by: i.by || null,
        ageMs: itemAge(i, now),
      })),
      journal: rec.journal.slice(-journal),
    };
  }

  // A renamed worktree: the directory moved, so the key the row is drawn with moved with it. The list follows the
  // tree — that is the whole point of keying it on the row — and the old key is dropped.
  repointPath(oldPath, newPath) {
    this.load();
    const from = normTodoPath(oldPath).toLowerCase();
    const to = normTodoPath(newPath);
    if (!from || !to) return 0;
    let moved = 0;
    for (const [key, rec] of [...this.lists]) {
      if (normTodoPath(rec.path).toLowerCase() !== from) continue;
      const next = todoKey(rec.project, to);
      if (next === key) continue;
      this.lists.delete(key);
      rec.key = next;
      rec.path = to;
      rec.journal.push({ at: nowIso(), by: "panel", op: "repoint", id: null, text: `the worktree was renamed to ${to}`, from: null });
      this.lists.set(next, rec);
      moved += 1;
    }
    if (moved) this.save();
    return moved;
  }

  forget(key) {
    this.load();
    if (!key || !this.lists.delete(key)) return false;
    this.save();
    return true;
  }

  save() {
    if (!this.file) return false;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const body = {
        version: TODOS_VERSION,
        savedAt: nowIso(),
        lists: Object.fromEntries([...this.lists].map(([k, v]) => [k, { key: v.key, project: v.project, path: v.path, nextId: v.nextId, items: v.items, proposal: v.proposal || [], journal: v.journal }])),
      };
      // Written beside the target and renamed over it, so a reader (or a crash) never sees half a file.
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
      renameSync(tmp, this.file);
      return true;
    } catch (err) {
      this.log(`todos: could not write ${this.file} (${String((err && err.message) || err)})`);
      return false;
    }
  }
}
