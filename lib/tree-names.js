// Which trees have already been named, by whom and when.
//
// A tree is cut from the prompt, so it starts life named after whatever the reader typed (24 characters,
// usually mid-word). Hermes then names the session from the work ("Fix delete worktree button not removing
// directory"), and the panel renames the tree after that title — the directory and its branch. That is right
// for one agent per tree and wrong the moment a second run is started into the same tree: every run (and every
// event of every run) brought another title, and the tree was renamed again and again, each rename moving the
// branch while the directory move is best-effort — so one worktree ended up with a directory named one thing,
// a branch named another, and three live cards each spelling a different branch.
//
// The guard that used to stand in for this was an in-memory Set of paths. A rename moves the directory, so the
// key it held was stale the moment the first rename landed, and every later event of the SAME run walked
// straight past it. This is the record that replaces it: keyed on the six-hex tag, which every rename keeps,
// written down beside the panel's job store so it survives a restart, and consulted (never duplicated) by both
// the automatic path and the deliberate one.
//
// The tag is the tree's identity here because it is the one part of the name a rename never changes: a tree cut
// from a prompt is `<slug>-<tag>`, its branch is `wtgui/<slug>-<tag>`, and every later rename keeps the tag and
// only rebuilds the slug. A tree that somehow carries no tag at all falls back to its normalised path, and the
// record is re-keyed when it is renamed.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const WORKTREE_TAG_RE = /-([0-9a-f]{6})$/i;
export const TREE_NAMES_VERSION = 1;

export const normTreePath = (p) =>
  String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();

// The six-hex tag of a directory or branch name, lowercased, or null when there is none. A name that IS six
// hex is the tag being named (the one part a rename keeps), which is the same answer.
export function tagOf(raw) {
  const base = normTreePath(raw).split("/").filter(Boolean).pop() || "";
  if (!base) return null;
  if (/^[0-9a-f]{6}$/i.test(base)) return base.toLowerCase();
  const m = WORKTREE_TAG_RE.exec(base);
  return m ? m[1].toLowerCase() : null;
}

// One tree's identity: its project and its tag. The path is only the fallback, for a tree that carries no tag
// (nothing the panel cut does), and the branch is only consulted when the path has none either.
export function treeKey({ project, path: dir, branch } = {}) {
  const projectName = String(project ?? "").trim();
  const tag = tagOf(dir) || tagOf(branch);
  if (tag) return `${projectName}::${tag}`;
  const p = normTreePath(dir);
  return p ? `${projectName}::path:${p}` : `${projectName}::unknown`;
}

// What the ledger says about a tree's name being still open, in one word:
//
//   absent  — nothing recorded. A tree nobody has seeded (see seed()) and nobody has cut (see claimCut()).
//   cut     — this panel cut the tree for a run, and that run has not given it its one name yet. The only
//             state the automatic rename may act on.
//   named   — the name is settled: seeded from what the tree was found under, renamed once by a run, or
//             renamed by the reader. Nothing automatic may touch it again, whatever a later run's status says.
export function namingState(rec) {
  if (!rec) return "absent";
  if (rec.cut === true && !rec.renamedAt) return "cut";
  return "named";
}

// Why the automatic half may not give this tree its name, or null when it may. It is deliberately not a
// question about the RUN (`job.existing`, `job.status`): a flag that can be set wrong is how a tree the reader
// considers fixed got moved. The ledger is the record of which run cut which tree, and that record — with the
// run's own id on it — is the whole proof that this name is this run's to give.
export function autoNameRefusal(rec, run = null) {
  const state = namingState(rec);
  if (state === "named") return `already named by ${rec.by || "the panel"}`;
  if (state === "absent") return "no cut record for this tree — its name is not this run's to give";
  // A tree cut by one run and then used by another: the second run must not name it, even before the first
  // has. Without this, a run started into a freshly cut tree (existing: true) could beat the cut run to it.
  if (rec.cutRun && run && String(rec.cutRun) !== String(run)) return `cut by another run (${rec.cutRun})`;
  return null;
}

// Why this tree must NOT be renamed, or "" when it may be. The rename path keeps the six-hex tag and rebuilds
// only the slug, and the tag is the ledger key (treeKey above). A directory with no tag has no key: the record
// would be written against a normalised PATH, and the rename moves that path (`keyAfter !== key`), so the next
// run's "is this tree named?" question is asked of a key nothing holds and the tree is renamed a second time —
// exactly the drift the ledger exists to stop. It would also have to INVENT a tag (`worktreeDirName` needs one),
// which is a new identity for a tree that already had one. So an untagged directory never enters the naming or
// rename path, and both callers ask here rather than each deciding for itself.
export function renameRefusal(dir) {
  if (tagOf(dir)) return "";
  const name = normTreePath(dir).split("/").filter(Boolean).pop() || String(dir ?? "");
  return `"${name}" carries no -<hex6> tag, so there is no tree identity to rename it by — the panel only renames a tree it cut (or one already named <slug>-<hex6>). Rename the directory by hand if it needs another name`;
}

// What a record says in one line, for a tooltip or a confirm box. A tree with a claim but no finished rename
// (the moment between claiming it and the git work landing) says so rather than reading as a name.
export function describeNaming(rec) {
  if (!rec) return "";
  const who = String(rec.by || "").trim() || "the panel";
  if (namingState(rec) === "cut") {
    // A title that was offered and declined is part of what the record knows: it is why the tree still carries
    // the name it was cut with, and the row says so rather than looking like a naming that never happened.
    const off = rec.offered;
    const declined = off?.title
      ? ` — “${off.title}” was offered and declined${off.why ? ` (${off.why})` : ""}`
      : "";
    return `cut by ${who} — its one name is still to come${declined}`;
  }
  const when = rec.at ? new Date(rec.at) : null;
  const stamp = when && !Number.isNaN(when.getTime()) ? when.toISOString().replace("T", " ").slice(0, 19) : "";
  // A skipped record is not a name: the panel looked and left the tree alone because the branch already carried
  // its own commits. "named by …" there would credit a rename that never happened.
  if (rec.skipped) {
    return [`naming declined by ${who}`, stamp ? `on ${stamp}` : null, rec.how ? `— ${rec.how}` : null].filter(Boolean).join(" ");
  }
  const bits = [`named by ${who}`, stamp ? `on ${stamp}` : null, rec.how ? `— ${rec.how}` : null].filter(Boolean);
  return bits.join(" ");
}

export class TreeNames {
  constructor({ file, log = () => {} } = {}) {
    this.file = file || null;
    this.log = log;
    this.trees = new Map();
    this.loaded = false;
  }

  // A missing file is the normal first-run answer, and a file that does not parse is not worth failing a rename
  // over: it is read once at construction and rewritten on the next record.
  load() {
    if (this.loaded) return this;
    this.loaded = true;
    if (!this.file) return this;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      const trees = raw && typeof raw === "object" && raw.trees && typeof raw.trees === "object" ? raw.trees : {};
      for (const [key, rec] of Object.entries(trees)) {
        if (rec && typeof rec === "object") this.trees.set(key, rec);
      }
    } catch (err) {
      if (existsSync(this.file)) this.log(`tree-names: could not read ${this.file} (${String((err && err.message) || err)}) — starting empty`);
    }
    return this;
  }

  get size() {
    this.load();
    return this.trees.size;
  }

  get(key) {
    this.load();
    return (key && this.trees.get(key)) || null;
  }

  isNamed(key) {
    // A cut record is NOT a name: the tree is this run's to name and nobody has yet.
    return namingState(this.get(key)) === "named";
  }

  // The record for a tree reached by path or branch rather than by key — what the board's rows are.
  forTree(where) {
    return this.get(treeKey(where));
  }

  // Write the record for one tree. Called twice in a tree's life at most: once to CLAIM it (before the git work,
  // so two events on the same tree cannot both rename it) and once when the rename has actually landed. Last
  // write wins, and the whole file is rewritten — a handful of trees, never enough to be worth more.
  record(key, entry) {
    this.load();
    if (!key) return null;
    const prev = this.trees.get(key) || {};
    const rec = { ...prev, ...entry, key };
    this.trees.set(key, rec);
    this.save();
    return rec;
  }

  // A tree the panel did NOT cut, recorded the moment the scanner (or the boot backfill) first lists it:
  // its current directory name IS its name, written down before any run can reach the automatic rename.
  // This is what closes the hole the ledger shipped with — every tree cut before the ledger existed had no
  // entry, and to the automatic half "no entry" looked exactly like "a tree waiting for its one name".
  //
  // Never overwrites: a tree with any entry at all (a cut record from this panel, a name from a run, a name
  // from the reader) keeps the entry it has. Returns the entry when this call wrote it, null otherwise.
  seed(key, entry = {}) {
    this.load();
    if (!key || this.trees.has(key)) return null;
    const rec = {
      ...entry,
      key,
      seeded: true,
      cut: false,
      claimedOnly: false,
      renamedAt: null,
    };
    this.trees.set(key, rec);
    this.save();
    return rec;
  }

  // The panel cut this tree for a run (lib/jobs.js calls this BEFORE `git worktree add`, so nothing — not a
  // scan, not a second run — can see the directory and decide it is a tree nobody has named). It is not a
  // rename and not a claim of one: it is the record that this run, and only this run, may give the tree its
  // one name. An existing entry is never replaced: a tree the panel already knows is not this run's to cut.
  claimCut(key, entry = {}) {
    this.load();
    if (!key) return null;
    const prev = this.trees.get(key);
    if (prev) return prev;
    const rec = {
      ...entry,
      key,
      seeded: false,
      cut: true,
      claimedOnly: false,
      renamedAt: null,
    };
    this.trees.set(key, rec);
    this.save();
    return rec;
  }

  // A title the automatic half LOOKED AT and declined. Not a name and not a claim: the record keeps its `cut`
  // marker, so the tree's one name is still this run's to give — a later settled title that describes the work
  // may still take it. Written so the refusal is a fact on disk rather than a log line that scrolls away: the
  // row reads it back, and the next reader can see that the tree kept its cut name on purpose.
  offer(key, { title, why, by = null, at = null } = {}) {
    this.load();
    const prev = key ? this.trees.get(key) : null;
    // Only a tree still waiting for its name has anything to offer. A named tree is not moved by any title, and
    // writing an offer against it would suggest a name that was never on the table.
    if (!prev || namingState(prev) !== "cut") return null;
    return this.record(key, {
      offered: { title: String(title ?? ""), why: String(why ?? ""), by, at: at || new Date().toISOString() },
    });
  }

  // The name is settled: the rename landed, the reader renamed it by hand, or the automatic half found the
  // name it wanted already taken. Clears the cut marker — this is the write that turns "this run may name it"
  // into "nothing may name it again" — and stamps the moment it happened.
  settle(key, entry = {}) {
    return this.record(key, {
      ...entry,
      cut: false,
      claimedOnly: false,
      renamedAt: entry.renamedAt || new Date().toISOString(),
    });
  }

  // A claim that never became a rename: the tree was going to be named after a title and the git half did not
  // land, so the next run may try again rather than the tree being frozen under a name it never got.
  forget(key) {
    this.load();
    if (!key || !this.trees.delete(key)) return false;
    this.save();
    return true;
  }

  save() {
    if (!this.file) return false;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const body = { version: TREE_NAMES_VERSION, savedAt: new Date().toISOString(), trees: Object.fromEntries(this.trees) };
      // Written beside the target and renamed over it: a reader (or a crash) never sees half a file.
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
      renameSync(tmp, this.file);
      return true;
    } catch (err) {
      // The ledger is a guard, not a source of truth for anything else: losing a write costs one extra rename,
      // and the in-memory map still holds the answer for this process.
      this.log(`tree-names: could not write ${this.file} (${String((err && err.message) || err)})`);
      return false;
    }
  }
}
