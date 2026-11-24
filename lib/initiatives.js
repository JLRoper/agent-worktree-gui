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
//
// ORDER IS A FIELD ON THE RECORD (`order`, 1-based). The tab draws the reader's order and moves one card a place at a
// time; the numbers are seeded from the list AS IT STANDS the first time anything moves, so a store written before the
// field existed lists exactly as it did and only the moved card changes place. A record that carries no order is
// placed by its createdAt - after the ordered ones, newest first, and the whole list falls back to that older rule
// when nothing is numbered yet. Archived records keep their number, because the number is what Restore returns them to.
//
// ARCHIVED IS A STATE, NOT A DELETE (`archivedAt`/`archivedBy`). Every tree record, every wave and every task link is
// left exactly as it was: what changes is that `initiativeList`, `index` and the tab stop drawing it, so no chart chip,
// count or lane names an initiative the reader has put away. The liveness rule that decides whether it may be put away
// is NOT here - it is the wave fold's own (lib/waves.js `waveMemberOpen`/`waveIsOpen`), applied by the route that
// holds the waves and the queues, so the archive refusal and the wave drive cannot disagree about what "open" means.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const INITIATIVES_VERSION = 1;
export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 2000;
// A fleet is bounded by its worktrees; this only stops a runaway file. Initiatives themselves are never capped (the
// reader can create as many as the work has pieces), so only the tree index has a number.
export const TREES_MAX = 4000;
// How many events one initiative keeps. A history is a memory of who changed the map, not an audit trail that has to
// hold everything: the oldest events fall off, and the store stays a document a reader can open and read.
export const HISTORY_MAX = 80;


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

// One history event: who changed the initiative, what they did, and when. The action vocabulary is closed (the four
// changes the tier governs) so the page can draw a sentence without guessing at an unknown verb, and a hand-edited
// entry that does not fit is dropped rather than rendered as "undefined did something".
const HISTORY_ACTIONS = ["create", "edit", "attach", "detach"];
function pickHistoryEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const action = String(raw.action ?? "").trim().toLowerCase();
  if (!HISTORY_ACTIONS.includes(action)) return null;
  const at = typeof raw.at === "string" ? raw.at : null;
  if (!at) return null;
  return {
    at,
    by: String(raw.by || "reader"),
    action,
    tree: raw.tree ? displayTreePath(raw.tree) : null,
    detail: clip(raw.detail, TITLE_MAX),
  };
}

// The one shape a stored initiative has. Every field is read through this, so a hand-edited file cannot put an object
// where the page expects a string (a title rendered as "[object Object]" is the sort of thing a reader blames the
// feature for).
// The reader's position: a positive integer, or null for a record that carries none. A zero, a negative, a fraction
// and a string are all "no order" rather than a number that would sort the card somewhere arbitrary.
const orderOf = (raw) => {
  const n = Number(raw?.order);
  return Number.isInteger(n) && n > 0 ? n : null;
};

function pickInitiative(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id ?? "").trim();
  const title = clip(raw.title, TITLE_MAX);
  if (!id || !title) return null;
  const history = [];
  for (const ev of Array.isArray(raw.history) ? raw.history : []) {
    const picked = pickHistoryEntry(ev);
    if (picked) history.push(picked);
  }
  return {
    id,
    title,
    description: cleanDescription(raw.description),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    createdBy: raw.createdBy ? String(raw.createdBy) : null,
    updatedBy: raw.updatedBy ? String(raw.updatedBy) : null,
    // The reader's order, and who moved it last. A reorder is bookkeeping rather than an edit of the words, so it
    // carries its own stamps and leaves `updatedAt` (the "edited ... ago" line) alone.
    order: orderOf(raw),
    orderAt: typeof raw.orderAt === "string" ? raw.orderAt : null,
    orderBy: raw.orderBy ? String(raw.orderBy) : null,
    // Put away, not deleted: the trees, the waves and the task links stay exactly where they are.
    archivedAt: typeof raw.archivedAt === "string" ? raw.archivedAt : null,
    archivedBy: raw.archivedBy ? String(raw.archivedBy) : null,
    // Newest last on disk, oldest dropped past HISTORY_MAX. The page reads it newest first (`historyFor`).
    history: history.slice(-HISTORY_MAX),
  };
}

// A tree's record: the ids it belongs to, in the order they were added, and - for each one - who attached it and when.
// `members` is the record a removal is judged against (lib/initiative-permissions.js `own`); `at`/`by` beside it are
// the LAST change to the record, kept because a tree may be in several initiatives and the row's hint is about the
// move that happened last. An entry from a store written before `members` reads `at`/`by` as its attachment, so an
// older file is interpreted rather than thrown away. An unknown id is dropped on the way in (the initiative it named
// is not in this file any more, and a row must not draw a chip for a title nobody can read).
function pickTreeRecord(raw, knownIds) {
  if (!raw || typeof raw !== "object") return null;
  const list = Array.isArray(raw.initiatives) ? raw.initiatives : raw.initiative ? [raw.initiative] : [];
  const out = [];
  for (const idRaw of list) {
    const id = String(idRaw ?? "").trim();
    if (!id || out.includes(id) || !knownIds.has(id)) continue;
    out.push(id);
  }
  const rawMembers = raw.members && typeof raw.members === "object" && !Array.isArray(raw.members) ? raw.members : {};
  const members = {};
  for (const id of out) {
    const m = rawMembers[id] && typeof rawMembers[id] === "object" ? rawMembers[id] : null;
    members[id] = {
      at: typeof m?.at === "string" ? m.at : typeof raw.at === "string" ? raw.at : null,
      by: m?.by ? String(m.by) : raw.by ? String(raw.by) : null,
    };
  }
  return {
    path: displayTreePath(raw.path),
    initiatives: out,
    at: typeof raw.at === "string" ? raw.at : null,
    by: raw.by ? String(raw.by) : null,
    members,
  };
}


// Append one event, oldest dropped past HISTORY_MAX. Kept newest-LAST on disk so a reader opening initiatives.json
// reads the story forwards; `historyFor` reverses it for the page.
function withHistory(initiative, event) {
  const history = [...(Array.isArray(initiative.history) ? initiative.history : []), event].slice(-HISTORY_MAX);
  return { ...initiative, history };
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
  //
  // AN ARCHIVED INITIATIVE IS NOT IN THIS MAP. This is the one place the chart, the project table and the per-row frame
  // read a tree's initiatives from (server.js `withInitiatives` and `rowExtras`), so dropping the archived ids here is
  // what makes the chip, the chart column's count and every per-row refresh forget an initiative the reader put away -
  // while its tree records stay exactly as they are, which is what Restore needs.
  index() {
    this.load();
    if (this.indexCache) return this.indexCache;
    const titles = new Map(this.doc.initiatives.filter((i) => !i.archivedAt).map((i) => [i.id, i.title]));
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

  // THE LIST'S ORDER. `order` first; a record that carries none - one this panel wrote before the field existed, or a
  // hand edit - is placed AFTER the ordered ones by its createdAt, newest first. When NO record carries an order (the
  // store as this panel wrote it until now) the whole list falls back to the rule it has always drawn with: the newest
  // edit first, createdAt standing in for a record nobody has edited. That fallback is what makes the ten cards the
  // reader sees today come back in the same sequence the moment this lands, and the first move is what numbers them.
  sortedInitiatives(list) {
    const all = Array.isArray(list) ? list : [];
    const anyOrdered = all.some((i) => i.order != null);
    const byEdited = (a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""));
    const byCreated = (a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    return all.slice().sort((a, b) => {
      if (!anyOrdered) return byEdited(a, b);
      if (a.order != null && b.order != null) return a.order - b.order || byEdited(a, b);
      if (a.order != null) return -1;
      if (b.order != null) return 1;
      return byCreated(a, b);
    });
  }

  // The active list: what the tab draws, what the chart counts and what a reorder moves. Archived records are absent.
  initiativeList() {
    this.load();
    return this.sortedInitiatives(this.doc.initiatives.filter((i) => !i.archivedAt));
  }

  // The archived list: the same records with their own saved order, drawn only by the tab's Archived view.
  archivedList() {
    this.load();
    return this.sortedInitiatives(this.doc.initiatives.filter((i) => Boolean(i.archivedAt)));
  }

  initiativeById(id) {
    this.load();
    return this.doc.initiatives.find((i) => i.id === String(id || "")) || null;
  }

  // One initiative's history, NEWEST FIRST, which is the order the fold draws: the change a reader is looking for is
  // almost always the last one. A copy, so a caller cannot mutate the document through it.
  historyFor(id) {
    const rec = this.initiativeById(id);
    if (!rec) return [];
    return (Array.isArray(rec.history) ? rec.history : []).slice().reverse();
  }

  // Who attached this tree to this initiative, and when. `null` means there is no record - the tree is not in the
  // initiative, or the entry predates the field - and the `own` tier reads that as somebody else's (so it asks).
  attachmentInfo(treePath, initiativeId) {
    this.load();
    const rec = this.doc.trees[normTreePath(treePath)];
    const id = String(initiativeId || "");
    if (!rec || !rec.initiatives.includes(id)) return null;
    const m = rec.members?.[id] || null;
    return { at: m?.at || null, by: m?.by || null };
  }

  // Every initiative that carries at least one tree, with the tree records that point at it. The route builds the
  // projects/assistants view on top of this; nothing here knows about a registry or a queue.
  treesFor(initiativeId) {
    this.load();
    const id = String(initiativeId || "");
    const out = [];
    for (const [key, rec] of Object.entries(this.doc.trees)) {
      if (!rec.initiatives.includes(id)) continue;
      const m = rec.members?.[id] || null;
      // `at`/`by` are the last change to the record; `attachedAt`/`attachedBy` are the attachment itself. The page
      // shows the second on the tree's Remove hint and in the history, because that is what the `own` tier reads.
      out.push({ key, path: rec.path, at: rec.at, by: rec.by, attachedAt: m?.at || null, attachedBy: m?.by || null });
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
        const members = {};
        for (const id of rec.initiatives) {
          const m = rec.members?.[id];
          if (m) members[id] = { at: m.at || null, by: m.by || null };
        }
        trees[key] = { path: rec.path, initiatives: rec.initiatives.slice(), at: rec.at, by: rec.by, members };
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
    const actor = String(by || "reader");
    // WHERE A NEW CARD LANDS. A list the reader has ordered gets the new card at the TOP: every number moves up one
    // and the new record takes 1, so the numbers stay a positive 1..n (a zero or a negative would be "no order" to
    // `orderOf` and the card would lose its place on the next read). A store nothing has ordered yet leaves the field
    // empty: every record is then orderless and the list keeps the newest-first rule it draws today, which puts the
    // new card on top without renumbering anything.
    const numbered = this.doc.initiatives.some((i) => i.order != null);
    if (numbered) {
      this.doc.initiatives = this.doc.initiatives.map((i) => (i.order == null ? i : { ...i, order: i.order + 1 }));
    }
    const initiative = {
      id: newInitiativeId(this.now()),
      title: clean,
      description: cleanDescription(description),
      createdAt: at,
      updatedAt: at,
      createdBy: actor,
      updatedBy: actor,
      order: numbered ? 1 : null,
      orderAt: null,
      orderBy: null,
      archivedAt: null,
      archivedBy: null,
      history: [{ at, by: actor, action: "create", tree: null, detail: clean }],
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
    const fields = [];
    if (title !== undefined) {
      const clean = clip(title, TITLE_MAX);
      if (!clean) return { ok: false, error: "an initiative needs a title - one line saying what the work is" };
      if (clean !== cur.title) fields.push("title");
      next.title = clean;
    }
    if (description !== undefined) {
      const clean = cleanDescription(description);
      if (clean !== cur.description) fields.push("description");
      next.description = clean;
    }
    // An edit that changes nothing is not an event: a card whose sentence says the reader edited the description when
    // the description is the same one would make the history a list of presses rather than a list of changes.
    if (!fields.length) return { ok: true, changed: false, initiative: cur, file: this.file };
    const at = nowIso(this.now());
    const actor = String(by || "reader");
    next.updatedAt = at;
    next.updatedBy = actor;
    next.history = withHistory(cur, {
      at,
      by: actor,
      action: "edit",
      tree: null,
      detail: fields.length === 2 ? "the title and the description" : `the ${fields[0]}`,
    }).history;
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
    const cur = this.doc.trees[key] || { path: displayTreePath(tree), initiatives: [], at: null, by: null, members: {} };
    const has = cur.initiatives.includes(rec.id);
    if (verb === "add" && has) return { ok: true, changed: false, initiative: rec, tree: { ...cur }, file: this.file };
    if (verb === "remove" && !has) return { ok: true, changed: false, initiative: rec, tree: { ...cur }, file: this.file };
    const at = nowIso(this.now());
    const actor = String(by || "reader");
    const members = { ...(cur.members || {}) };
    if (verb === "add") members[rec.id] = { at, by: actor };
    else delete members[rec.id];
    const next = {
      path: cur.path || displayTreePath(tree),
      initiatives: verb === "add" ? [...cur.initiatives, rec.id] : cur.initiatives.filter((id) => id !== rec.id),
      at,
      by: actor,
      members,
    };
    const trees = { ...this.doc.trees };
    if (next.initiatives.length) trees[key] = next;
    else delete trees[key];
    this.doc.trees = trees;
    // The initiative keeps the same event the attachment records: one history, whoever moved what, so a removal can be
    // read against the actor who put the tree there instead of guessed (lib/initiative-permissions.js).
    this.doc.initiatives = this.doc.initiatives.map((i) =>
      i.id === rec.id
        ? withHistory(i, { at, by: actor, action: verb === "add" ? "attach" : "detach", tree: next.path, detail: rec.title })
        : i,
    );
    const wrote = this.save();
    if (!wrote.ok) {
      this.load({ fresh: true });
      return { ok: false, error: `the move was not saved: ${wrote.error}` };
    }
    this.indexCache = null;
    this.log(`initiatives: ${verb} ${next.path} ${verb === "add" ? "to" : "from"} "${rec.title}" (${rec.id}) by ${next.by}`);
    return { ok: true, changed: true, initiative: rec, tree: next, file: this.file };
  }

  // ---- the reader's order -----------------------------------------------------------------------------------------

  // MOVE ONE ACTIVE INITIATIVE to a 1-based position. `to` is the index in the ACTIVE list the tab draws - the same
  // contract the waves route answers with (POST /api/waves/move) - and the numbers are seeded from the list as it
  // stands on the first move, so the ten cards do not rearrange themselves when one of them is moved.
  reorder({ id = "", to = undefined, by = "reader" } = {}) {
    this.load({ fresh: true });
    const refused = this.refuse();
    if (refused) return refused;
    const rec = this.doc.initiatives.find((i) => i.id === String(id || "")) || null;
    if (!rec) return { ok: false, notFound: true, error: `no such initiative: ${id || "(none)"}` };
    if (rec.archivedAt) return { ok: false, error: `"${rec.title}" is archived - restore it before moving it in the list` };
    const active = this.initiativeList();
    const index = active.findIndex((i) => i.id === rec.id);
    if (index < 0) return { ok: false, error: `"${rec.title}" is not in the active list` };
    const wanted = Number(to);
    if (!Number.isInteger(wanted)) return { ok: false, error: "a move needs `to`, the 1-based position the initiative should end at" };
    const target = Math.min(Math.max(wanted, 1), active.length);
    const numbered = (list) => list.map((i, at) => ({ id: i.id, position: at + 1 }));
    if (index === target - 1) {
      return { ok: true, changed: false, to: target, order: numbered(active), file: this.file };
    }
    // THE SEQUENCE. The full list is the new active order with every archived record back at the slot it holds, so a
    // record's number is still the place Restore returns it to. Everything is renumbered 1..n in ONE write, exactly
    // the way the wave lane renumbers its records: no duplicate numbers, no holes, and one atomic document.
    const full = this.sortedInitiatives(this.doc.initiatives);
    const slots = full.map((i, at) => ({ i, at })).filter((x) => Boolean(x.i.archivedAt));
    const next = active.slice();
    const [moved] = next.splice(index, 1);
    next.splice(target - 1, 0, moved);
    const merged = next.slice();
    for (const { i, at } of slots) merged.splice(Math.min(at, merged.length), 0, i);
    const numbers = new Map(merged.map((i, at) => [i.id, at + 1]));
    const at = nowIso(this.now());
    const actor = String(by || "reader");
    this.doc.initiatives = this.doc.initiatives.map((i) => {
      const order = numbers.get(i.id);
      if (order == null) return i;
      // The moved record carries who moved it and when. The rest only take their new number: those fields describe a
      // press the reader did not make, and a stamp copied onto ten records would make the history unreadable.
      if (i.id === moved.id) return { ...i, order, orderAt: at, orderBy: actor };
      return i.order === order ? i : { ...i, order };
    });
    const wrote = this.save();
    if (!wrote.ok) {
      this.load({ fresh: true });
      return { ok: false, error: `the move was not saved: ${wrote.error}` };
    }
    this.log(`initiatives: moved "${rec.title}" (${rec.id}) to position ${target} of ${active.length} by ${actor}`);
    return { ok: true, changed: true, to: target, order: numbered(this.initiativeList()), file: this.file };
  }

  // ---- archived: put away, not deleted ----------------------------------------------------------------------------

  // PUT AN INITIATIVE AWAY. The liveness check is the caller's (routes/initiatives.js `archiveBlockers`, which reads
  // the wave fold's own rule), because only the route holds the waves and the queues; this write touches exactly two
  // fields and leaves every tree record, every wave and every task link exactly where it is, so Restore has nothing to
  // rebuild. The number is untouched on purpose: it is the position the card returns to.
  archive({ id = "", by = "reader" } = {}) {
    this.load({ fresh: true });
    const refused = this.refuse();
    if (refused) return refused;
    const rec = this.doc.initiatives.find((i) => i.id === String(id || "")) || null;
    if (!rec) return { ok: false, notFound: true, error: `no such initiative: ${id || "(none)"}` };
    if (rec.archivedAt) return { ok: true, changed: false, initiative: rec, file: this.file };
    const at = nowIso(this.now());
    const actor = String(by || "reader");
    const next = { ...rec, archivedAt: at, archivedBy: actor };
    this.doc.initiatives = this.doc.initiatives.map((i) => (i.id === rec.id ? next : i));
    const wrote = this.save();
    if (!wrote.ok) {
      this.load({ fresh: true });
      return { ok: false, error: `the archive was not saved: ${wrote.error}` };
    }
    this.indexCache = null;
    this.log(`initiatives: archived "${rec.title}" (${rec.id}) by ${actor}`);
    return { ok: true, changed: true, initiative: next, file: this.file };
  }

  // PUT IT BACK, at the number it went away with - the place it held in the list the reader had.
  restore({ id = "", by = "reader" } = {}) {
    this.load({ fresh: true });
    const refused = this.refuse();
    if (refused) return refused;
    const rec = this.doc.initiatives.find((i) => i.id === String(id || "")) || null;
    if (!rec) return { ok: false, notFound: true, error: `no such initiative: ${id || "(none)"}` };
    if (!rec.archivedAt) return { ok: true, changed: false, initiative: rec, file: this.file };
    const next = { ...rec, archivedAt: null, archivedBy: null };
    this.doc.initiatives = this.doc.initiatives.map((i) => (i.id === rec.id ? next : i));
    const wrote = this.save();
    if (!wrote.ok) {
      this.load({ fresh: true });
      return { ok: false, error: `the restore was not saved: ${wrote.error}` };
    }
    this.indexCache = null;
    this.log(`initiatives: restored "${rec.title}" (${rec.id}) by ${String(by || "reader")}`);
    return { ok: true, changed: true, initiative: next, file: this.file };
  }
}
