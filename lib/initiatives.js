// INITIATIVES: the big pieces of work, and which worktrees are behind each one.
//
// An initiative is a title, a description, and the worktrees that belong to it. Nothing about it is enforced: a tree
// with no initiative is the normal case, one initiative may span several projects and several assistants, and the
// board still does exactly what it did before for a fleet with no initiatives at all.
//
// WHY A SIDE STORE, KEYED BY TREE PATH. The board's rows are rebuilt from git on every scan: `store.putRow` replaces
// a row wholesale, and a scan knows nothing about a title somebody typed into the panel. A fact written onto a row
// therefore survives until the next scan and no longer. So the membership lives here, in one JSON document beside the
// panel's other state (lib/paths.js `initiativesFile`), keyed by the tree's path - the one spelling a scan and the
// reader both have - and is OVERLAID onto the rows on every read (server.js `withInitiatives`, `rowExtras`), exactly
// the way the lock and the assistant owner are.
//
// A TREE MAY BE IN MORE THAN ONE INITIATIVE. The chart column says "a row's initiatives", and there is no rule in the
// brief that would make the second one wrong: an SSO migration and a release-readiness push can share a tree. The
// record for a tree is therefore a LIST of initiative ids, and moving a tree asks about one (tree, initiative) pair.
//
// THE WRITE RULE, and the reason this module is not a two-line read-modify-write: a store that cannot be read is
// NEVER overwritten. A corrupt or unreadable file is reported to the reader (`readable: false`, with the sentence and
// the path), every write is refused with that same sentence, and the bytes on disk are left exactly as they were so
// the reader can fix or salvage them. Silently starting from `{}` would delete every initiative on the board the
// first time an agent wrote one, and the reader would have no way to tell that from "the feature did nothing".
//
// A REFUSED WRITE IS A STATUS, NOT AN EXCEPTION, for every caller: the route answers 409 with the sentence, the
// page draws it beside the form, and a test asserts the file did not move. The mutators below also never throw on a
// validation failure (an empty title, an unknown id) - they return `{ ok: false, error }` - so one shape covers every
// refusal and no caller has to guess which half of the API throws.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const INITIATIVES_VERSION = 1;
export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 2000;
// A fleet is bounded by its worktrees; this only stops a runaway file. Initiatives themselves are never capped (the
// reader can create as many as the work has pieces), so only the tree index has a number.
export const TREES_MAX = 4000;

// The key a tree is stored under: forward slashes, no trailing slash, lower case. This is the same normalisation
// lib/locks.js, lib/todos.js and lib/review-inbox.js use, and it is what makes a scan's path and a reader's path one
// key on Windows. The ORIGINAL spelling is kept on the record for display, never used for matching.
export const normTreePath = (p) =>
  String(p ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();

// What the panel writes as the display path: forward slashes, the caller's case kept, no trailing slash.
export const displayTreePath = (p) => String(p ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");

const nowIso = (now = Date.now()) => new Date(now).toISOString();
const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) : t;
};
// The description keeps its paragraphs (a reader writes one), so only runs of spaces are collapsed.
const cleanDescription = (s) => {
  const t = String(s ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  return t.length > DESCRIPTION_MAX ? t.slice(0, DESCRIPTION_MAX) : t;
};

// The id is the panel's to hand out and never the caller's: an assistant creating an initiative posts a title, not a
// number, so two callers cannot collide and a reload does not depend on remembering one.
export function newInitiativeId(now = Date.now(), rand = Math.random) {
  return `init_${now.toString(36)}_${rand().toString(36).slice(2, 8)}`;
}

// The one shape a stored initiative has. Every field is read through this, so a hand-edited file cannot put an object
// where the page expects a string (a title rendered as "[object Object]" is the sort of thing a reader blames the
// feature for).
function pickInitiative(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id ?? "").trim();
  const title = clip(raw.title, TITLE_MAX);
  if (!id || !title) return null;
  return {
    id,
    title,
    description: cleanDescription(raw.description),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    createdBy: raw.createdBy ? String(raw.createdBy) : null,
    updatedBy: raw.updatedBy ? String(raw.updatedBy) : null,
  };
}

// A tree's record: the ids it belongs to, in the order they were added. An unknown id is dropped on the way in (the
// initiative it named is not in this file any more, and a row must not draw a chip for a title nobody can read).
function pickTreeRecord(raw, knownIds) {
  if (!raw || typeof raw !== "object") return null;
  const list = Array.isArray(raw.initiatives) ? raw.initiatives : raw.initiative ? [raw.initiative] : [];
  const out = [];
  for (const idRaw of list) {
    const id = String(idRaw ?? "").trim();
    if (!id || out.includes(id) || !knownIds.has(id)) continue;
    out.push(id);
  }
  return {
    path: displayTreePath(raw.path),
    initiatives: out,
    at: typeof raw.at === "string" ? raw.at : null,
    by: raw.by ? String(raw.by) : null,
  };
}

export class Initiatives {
  constructor({ file = null, log = () => {}, now = () => Date.now() } = {}) {
    this.file = file ? String(file) : null;
    this.log = log;
    this.now = now;
    this.doc = { initiatives: [], trees: {} };
    this.status = { found: false, readable: true, error: null, at: null };
    // Cache stamp: `mtimeMs:size`, so a file edited by hand (or by the other panel instance a reader runs) is noticed
    // on the next read without re-parsing the document on every row of every snapshot.
    this.stamp = null;
    this.indexCache = null;
  }

  stampOf() {
    if (!this.file) return "no-file";
    try {
      const st = statSync(this.file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  }

  // Read the document, from disk when it changed (or when the caller insists). A missing file is the normal first-run
  // answer: no initiatives, nothing to repair. A file that exists and cannot be read is the one answer that is NOT
  // "empty" - it is an unreadable store, and every write is refused until it is fixed.
  load({ fresh = false } = {}) {
    if (!this.file) {
      this.status = { found: false, readable: true, error: null, at: null };
      this.doc = { initiatives: [], trees: {} };
      this.indexCache = null;
      return this;
    }
    const stamp = this.stampOf();
    if (!fresh && stamp && stamp === this.stamp) return this;
    this.stamp = stamp;
    if (!existsSync(this.file)) {
      this.status = { found: false, readable: true, error: null, at: null };
      this.doc = { initiatives: [], trees: {} };
      this.indexCache = null;
      return this;
    }
    let raw;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (err) {
      const error = String((err && err.message) || err);
      this.status = { found: true, readable: false, error, at: null };
      this.doc = { initiatives: [], trees: {} };
      this.indexCache = null;
      return this;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      this.status = { found: true, readable: false, error: "the file does not hold an object", at: null };
      this.doc = { initiatives: [], trees: {} };
      this.indexCache = null;
      return this;
    }
    const initiatives = [];
    const seen = new Set();
    for (const rec of Array.isArray(raw.initiatives) ? raw.initiatives : []) {
      const picked = pickInitiative(rec);
      if (!picked || seen.has(picked.id)) continue;
      seen.add(picked.id);
      initiatives.push(picked);
    }
    const knownIds = new Set(initiatives.map((i) => i.id));
    const trees = {};
    const rawTrees = raw.trees && typeof raw.trees === "object" && !Array.isArray(raw.trees) ? raw.trees : {};
    for (const [keyRaw, rec] of Object.entries(rawTrees)) {
      const picked = pickTreeRecord(rec, knownIds);
      if (!picked) continue;
      const key = normTreePath(keyRaw || picked.path);
      if (!key || !picked.initiatives.length) continue;
      trees[key] = { ...picked, path: picked.path || displayTreePath(keyRaw) };
    }
    this.status = {
      found: true,
      readable: true,
      error: null,
      at: typeof raw.savedAt === "string" ? raw.savedAt : null,
    };
    this.doc = { initiatives, trees };
    this.indexCache = null;
    return this;
  }

  // What a caller sees of the store itself: the file, whether it exists, whether it could be read, and the sentence a
  // reader can act on. `readable: true` with `found: false` is the empty board, not a problem.
  statusOf() {
    this.load();
    return {
      file: this.file,
      found: this.status.found,
      readable: this.status.readable,
      error: this.status.error,
      at: this.status.at,
    };
  }

  // Tree key -> [{ id, title }], built once per load. The snapshot overlays every row from this one map: building it
  // per row would be one walk of the document per worktree.
  index() {
    this.load();
    if (this.indexCache) return this.indexCache;
    const titles = new Map(this.doc.initiatives.map((i) => [i.id, i.title]));
    const out = new Map();
    for (const [key, rec] of Object.entries(this.doc.trees)) {
      const list = rec.initiatives.map((id) => ({ id, title: titles.get(id) || "" })).filter((i) => i.title);
      if (list.length) out.set(key, list);
    }
    this.indexCache = out;
    return out;
  }

  // What one tree belongs to, for a per-row event (server.js `rowExtras`). An absent tree is `[]`, which is the whole
  // representation of "no initiative" - nothing is stored for it and nothing is enforced.
  forTree(treePath) {
    const key = normTreePath(treePath);
    if (!key) return [];
    return this.index().get(key) || [];
  }

  initiativeList() {
    this.load();
    return this.doc.initiatives
      .slice()
      .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
  }

  initiativeById(id) {
    this.load();
    return this.doc.initiatives.find((i) => i.id === String(id || "")) || null;
  }

  // Every initiative that carries at least one tree, with the tree records that point at it. The route builds the
  // projects/assistants view on top of this; nothing here knows about a registry or a queue.
  treesFor(initiativeId) {
    this.load();
    const id = String(initiativeId || "");
    const out = [];
    for (const [key, rec] of Object.entries(this.doc.trees)) {
      if (!rec.initiatives.includes(id)) continue;
      out.push({ key, path: rec.path, at: rec.at, by: rec.by });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  // ---- writes ------------------------------------------------------------------------------------------------------

  // The one gate every write goes through. A store that exists and cannot be read is a refusal with the file and the
  // reason in the sentence; the caller answers 409 and the bytes stay where they are.
  refuse() {
    const status = this.statusOf();
    if (!status.readable) {
      return {
        ok: false,
        refused: "unreadable",
        file: status.file,
        error: `${status.file || "the initiative store"} could not be read (${status.error || "unknown error"}) - it was NOT overwritten. Fix or move that file, then try again: every initiative on the board lives in it.`,
      };
    }
    return null;
  }

  // Temp file + rename, like every other store in this panel: a reader never sees half a list, and a crash mid-write
  // leaves the previous document in place.
  save() {
    if (!this.file) return { ok: false, error: "no initiatives file is configured" };
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const trees = {};
      for (const [key, rec] of Object.entries(this.doc.trees)) {
        if (!rec.initiatives.length) continue;
        trees[key] = { path: rec.path, initiatives: rec.initiatives.slice(), at: rec.at, by: rec.by };
        if (Object.keys(trees).length >= TREES_MAX) break;
      }
      const body = {
        version: INITIATIVES_VERSION,
        savedAt: nowIso(this.now()),
        initiatives: this.doc.initiatives,
        trees,
      };
      const tmp = `${this.file}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
      renameSync(tmp, this.file);
      // The stamp has to move with the write, or the next read re-parses a document this process already holds.
      this.stamp = this.stampOf();
      this.status = { found: true, readable: true, error: null, at: body.savedAt };
      return { ok: true, file: this.file };
    } catch (err) {
      const error = String((err && err.message) || err);
      this.log(`initiatives: could not write ${this.file} (${error})`);
      return { ok: false, error };
    }
  }

  create({ title = "", description = "", by = "reader" } = {}) {
    this.load({ fresh: true });
    const refused = this.refuse();
    if (refused) return refused;
    const clean = clip(title, TITLE_MAX);
    if (!clean) return { ok: false, error: "an initiative needs a title - one line saying what the work is" };
    const at = nowIso(this.now());
    const initiative = {
      id: newInitiativeId(this.now()),
      title: clean,
      description: cleanDescription(description),
      createdAt: at,
      updatedAt: at,
      createdBy: String(by || "reader"),
      updatedBy: String(by || "reader"),
    };
    this.doc.initiatives = [...this.doc.initiatives, initiative];
    const wrote = this.save();
    if (!wrote.ok) {
      // Memory-first would let this process draw an initiative the next boot forgets. The document is re-read from
      // disk so what the page paints is what a restart will read.
      this.load({ fresh: true });
      return { ok: false, error: `the initiative was not saved: ${wrote.error}` };
    }
    this.indexCache = null;
    this.log(`initiatives: created "${initiative.title}" (${initiative.id}) by ${initiative.createdBy}`);
    return { ok: true, initiative, file: this.file };
  }

  // The title and the description are the two fields a reader - or an assistant - may edit freely. Membership is the
  // one field that is not: it goes through the permission box (the route `move` half), because it is the reader's map.
  update({ id = "", title = undefined, description = undefined, by = "reader" } = {}) {
    this.load({ fresh: true });
    const refused = this.refuse();
    if (refused) return refused;
    const cur = this.doc.initiatives.find((i) => i.id === String(id || ""));
    if (!cur) return { ok: false, error: `no such initiative: ${id || "(none)"}` };
    if (title === undefined && description === undefined) return { ok: false, error: "nothing to change: send a title, a description, or both" };
    const next = { ...cur };
    if (title !== undefined) {
      const clean = clip(title, TITLE_MAX);
      if (!clean) return { ok: false, error: "an initiative needs a title - one line saying what the work is" };
      next.title = clean;
    }
    if (description !== undefined) next.description = cleanDescription(description);
    next.updatedAt = nowIso(this.now());
    next.updatedBy = String(by || "reader");
    this.doc.initiatives = this.doc.initiatives.map((i) => (i.id === cur.id ? next : i));
    const wrote = this.save();
    if (!wrote.ok) {
      this.load({ fresh: true });
      return { ok: false, error: `the change was not saved: ${wrote.error}` };
    }
    this.indexCache = null;
    this.log(`initiatives: edited "${next.title}" (${next.id}) by ${next.updatedBy}`);
    return { ok: true, initiative: next, file: this.file };
  }

  // ADD or REMOVE one tree, for one initiative. Called by the permission box's resumed action, never by a plain POST:
  // the route asks first and passes THIS in as the resume, so nothing here runs until the reader answered.
  move({ tree = "", initiative = "", action = "add", by = "reader" } = {}) {
    this.load({ fresh: true });
    const refused = this.refuse();
    if (refused) return refused;
    const key = normTreePath(tree);
    if (!key) return { ok: false, error: "a move needs a worktree path" };
    const rec = this.initiativeById(initiative);
    if (!rec) return { ok: false, error: `no such initiative: ${initiative || "(none)"}` };
    const verb = String(action || "add").toLowerCase();
    if (verb !== "add" && verb !== "remove") return { ok: false, error: `a move is add or remove, not ${action || "(none)"}` };
    const cur = this.doc.trees[key] || { path: displayTreePath(tree), initiatives: [], at: null, by: null };
    const has = cur.initiatives.includes(rec.id);
    if (verb === "add" && has) return { ok: true, changed: false, initiative: rec, tree: { ...cur }, file: this.file };
    if (verb === "remove" && !has) return { ok: true, changed: false, initiative: rec, tree: { ...cur }, file: this.file };
    const next = {
      path: cur.path || displayTreePath(tree),
      initiatives: verb === "add" ? [...cur.initiatives, rec.id] : cur.initiatives.filter((id) => id !== rec.id),
      at: nowIso(this.now()),
      by: String(by || "reader"),
    };
    const trees = { ...this.doc.trees };
    if (next.initiatives.length) trees[key] = next;
    else delete trees[key];
    this.doc.trees = trees;
    const wrote = this.save();
    if (!wrote.ok) {
      this.load({ fresh: true });
      return { ok: false, error: `the move was not saved: ${wrote.error}` };
    }
    this.indexCache = null;
    this.log(`initiatives: ${verb} ${next.path} ${verb === "add" ? "to" : "from"} "${rec.title}" (${rec.id}) by ${next.by}`);
    return { ok: true, changed: true, initiative: rec, tree: next, file: this.file };
  }
}
