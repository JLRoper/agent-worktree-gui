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

// What a record says in one line, for a tooltip or a confirm box. A tree with a claim but no finished rename
// (the moment between claiming it and the git work landing) says so rather than reading as a name.
export function describeNaming(rec) {
  if (!rec) return "";
  const who = String(rec.by || "").trim() || "the panel";
  const when = rec.at ? new Date(rec.at) : null;
  const stamp = when && !Number.isNaN(when.getTime()) ? when.toISOString().replace("T", " ").slice(0, 19) : "";
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
    return Boolean(this.get(key));
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
