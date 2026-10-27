// The branch a worktree was cut from — its PARENT — and the commit that ref resolved to at the moment it was cut.
//
// Why this is a store of its own and not a field read back from git: git records where HEAD is now, never where a
// worktree started. `git worktree add -b <branch> <path> <startRef>` resolves `<startRef>` once and throws the answer
// away; the reflog has it until it expires, and after that the only evidence left is the merge-base against every
// other branch — which is a guess. So the panel writes it down when it cuts the tree (source "cut", the only source
// allowed to drive a write) and, for trees cut before this landed, reconstructs it from the branch names ("DMR-1234"
// appearing in a sibling branch) with a merge-base sanity check, marked "backfilled". A guess is shown to the reader
// and can open the question, but it can never delete or merge anything: every write path in lib/steward.js refuses a
// parent that is not "cut".
//
// The other rule here is what a parent is NOT: master and main are the turnover branch's destination, never a
// child's parent. A row whose parent resolves to one of those is "unknown" for every purpose that writes, and the
// chip asks the reader instead.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gitIn } from "./scan.js";

export const PARENT_FILE_VERSION = 1;
export const PARENT_SOURCES = ["cut", "backfilled", "unknown"];
// `master`, `main` and whatever the project calls its main branch. A child is never rolled into one of these.
export const MAIN_NAMES = ["master", "main", "trunk", "develop"];

const norm = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
export const parentKey = (project, branch) => `${String(project ?? "")}::${String(branch ?? "").trim()}`;

// A ticket id in a branch name: DMR-1234, PROJ-88, abc-7 — a short letters prefix, a dash, digits. Everything the
// panel itself names (`wtgui/<slug>-<6 hex>`, `<slug>-<5 digits>`) deliberately does not match: a hex tag is not a
// ticket, and treating it as one would pair two unrelated trees that happen to share a tag.
export function ticketIds(branch) {
  const out = new Set();
  const text = String(branch ?? "");
  for (const m of text.matchAll(/(?:^|[^A-Za-z0-9])([A-Za-z]{2,6})-(\d{1,7})(?![0-9])/g)) {
    out.add(`${m[1].toUpperCase()}-${m[2]}`);
  }
  return [...out];
}

export function isMainName(name, mainBranch = null) {
  const b = String(name ?? "").trim();
  if (!b) return true;
  if (mainBranch && b === String(mainBranch).trim()) return true;
  return MAIN_NAMES.includes(b);
}

// The heuristic, as a pure decision over facts the caller has already read from git, so it is testable without a
// repo: `candidates` is one entry per OTHER branch sharing a ticket id, with what git said about it.
//
//   [{ branch, sharesBase, isAncestor, behind }]   behind = commits from that branch's tip to this branch's tip
//
// The strongest answer is a single candidate this branch descends from. Several ancestors means the branch could
// have been cut from any of them: the nearest one wins (fewest commits between its tip and ours), and a tie is not
// a tie-break, it is "unknown" — two equally near parents is exactly the case a guess must not pick from.
export function pickBackfill({ candidates = [], branch = "" } = {}) {
  const usable = (candidates || []).filter((c) => c && c.branch && c.branch !== branch && c.sharesBase !== false);
  if (!usable.length) return { parent: null, why: "no other branch carries the same ticket id" };
  const ancestors = usable.filter((c) => c.isAncestor);
  if (ancestors.length === 1) return { parent: ancestors[0].branch, why: `the only branch this one descends from with ticket ${ancestors[0].branch}` };
  if (ancestors.length > 1) {
    const sorted = [...ancestors].sort((a, b) => Number(a.behind ?? 0) - Number(b.behind ?? 0));
    if (Number(sorted[0].behind ?? 0) === Number(sorted[1].behind ?? 0)) {
      return { parent: null, why: `ambiguous: ${sorted.map((c) => c.branch).join(", ")} are all equally near` };
    }
    return { parent: sorted[0].branch, why: `nearest of ${sorted.length} ancestors sharing the ticket (${sorted[0].behind} commit(s) behind)` };
  }
  if (usable.length === 1) {
    return { parent: usable[0].branch, why: "the only branch sharing the ticket id and a merge-base" };
  }
  return { parent: null, why: `ambiguous: ${usable.map((c) => c.branch).join(", ")} share the ticket but none is an ancestor` };
}

// Every local branch that could be a parent of `branch`, with the git facts pickBackfill() reads. Read-only.
//
// COST IS THE DESIGN HERE. The obvious version asks git four questions per candidate (`merge-base`, is-ancestor in both
// directions, a commit count) and on this fleet that is a second of process spawn each: a board with a dozen legacy
// branches took minutes to fill in, on the panel's own slow clock. `for-each-ref --merged <branch>` answers the
// ancestor question for EVERY local branch in ONE process, and it answers the direction question at the same time —
// a branch whose tip is not merged into `branch` is either a sibling or a descendant, and neither may be given as a
// parent (without that rule the turnover branch itself gets "guessed" as a child of the trees cut from it, and every
// turnover row advertises a parent it can never be rolled into). `behind` is only needed to break a tie among several
// ancestors, so only then is a second process spent.
export async function backfillCandidates(repoDir, branch, branches = null, { tips = null } = {}) {
  const mine = ticketIds(branch);
  if (!mine.length) return { ids: [], candidates: [], why: "no ticket id in this branch's name" };
  const list = Array.isArray(branches) && branches.length
    ? branches
    : tips?.branches
      || (await gitIn(repoDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"], 20000)).out?.split("\n").filter(Boolean)
      || [];
  const named = [];
  for (const other of list) {
    if (!other || other === branch) continue;
    if (isMainName(other)) continue;
    if (!ticketIds(other).some((id) => mine.includes(id))) continue;
    named.push(other);
  }
  if (!named.length) return { ids: mine, candidates: [], why: `no other branch carries ${mine.join(", ")}` };
  const merged = await gitIn(repoDir, ["for-each-ref", "--merged", branch, "--format=%(refname:short)", "refs/heads"], 20000);
  const ancestors = new Set(merged.ok ? merged.out.split("\n").filter(Boolean) : []);
  const out = [];
  for (const other of named) {
    const isAncestor = ancestors.has(other);
    let behind = null;
    if (isAncestor) {
      const n = await gitIn(repoDir, ["rev-list", "--count", `${other}..${branch}`], 15000);
      behind = n.ok ? Number.parseInt(n.out, 10) : null;
    }
    out.push({ branch: other, sharesBase: true, isAncestor, behind: Number.isFinite(behind) ? behind : null });
  }
  // No ancestor at all, and exactly one branch carries the ticket: it is still worth one merge-base call, because a
  // rebased sibling shares this branch's history without being an ancestor of it — and the answer stays a GUESS, which
  // no write ever acts on.
  if (!out.some((c) => c.isAncestor) && out.length === 1) {
    const base = await gitIn(repoDir, ["merge-base", branch, out[0].branch], 15000);
    if (!base.ok || !base.out) return { ids: mine, candidates: [], why: `${out[0].branch} shares the ticket but no history` };
    out[0].mergeBase = base.out;
  }
  return { ids: mine, candidates: out, why: "" };
}

// Work out the parent of every local branch of one project, from the cut records plus the heuristic. Returns one
// entry per branch, so the caller can put it on a row without a second lookup. Read-only: the book saves what it
// learns, nothing else.
export async function resolveParents({ repoDir, branches = [], records = new Map(), mainBranch = null } = {}) {
  const out = new Map();
  for (const branch of branches) {
    if (!branch) continue;
    const rec = records.get(branch) || null;
    if (rec && rec.parent && PARENT_SOURCES.includes(rec.parentSource) && rec.parentSource !== "unknown") {
      out.set(branch, { ...rec, parentSource: rec.parentSource });
      continue;
    }
    if (isMainName(branch, mainBranch)) {
      out.set(branch, { parent: null, parentSha: null, parentSource: "unknown", why: `${branch} is a main/turnover branch` });
      continue;
    }
    const { ids, candidates, why } = await backfillCandidates(repoDir, branch, branches);
    const picked = pickBackfill({ candidates, branch });
    if (!picked.parent) {
      out.set(branch, { parent: null, parentSha: null, parentSource: "unknown", why: why || picked.why, ticket: ids.join(",") || null });
      continue;
    }
    const tip = await gitIn(repoDir, ["rev-parse", picked.parent], 15000);
    out.set(branch, {
      parent: picked.parent,
      parentSha: tip.ok ? tip.out : null,
      parentSource: "backfilled",
      why: picked.why,
      ticket: ids.join(",") || null,
    });
  }
  return out;
}

// The panel's parent book: one JSON file beside the job store, so a restart comes back with the trees it cut and
// what they were cut from. Written atomically (rename), like the panel's other stores, because a half-written file
// here would lose the only record that separates a parent from a guess.
export class ParentBook {
  constructor({ file = null, onLog = () => {} } = {}) {
    this.file = file;
    this.log = onLog;
    this.records = new Map(); // "project::branch" -> record
    this.why = new Map(); // "project::branch" -> the last resolution's reason, when it is "unknown"
    this.load();
  }

  load() {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      for (const rec of saved.records || []) {
        if (rec && rec.project && rec.branch) this.records.set(parentKey(rec.project, rec.branch), rec);
      }
    } catch (e) {
      this.log(`parent book: ${this.file} is unreadable (${String((e && e.message) || e)}) — starting empty`);
    }
  }

  save() {
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: PARENT_FILE_VERSION, savedAt: new Date().toISOString(), records: [...this.records.values()] }, null, 0));
      renameSync(tmp, this.file);
    } catch (e) {
      this.log(`parent book: could not save ${this.file}: ${String((e && e.message) || e)}`);
    }
  }

  get(project, branch) {
    return this.records.get(parentKey(project, branch)) || null;
  }

  // A tree the panel just cut. `startRef` is the ref it branched from and `startSha` what that ref resolved to —
  // both read at the cut, because both are unrecoverable later.
  record({ project, branch, path: treePath = null, startRef, startSha = null, by = "panel", at = null }) {
    const ref = String(startRef ?? "").trim();
    const parent = ref && !isMainName(ref) && !/^[0-9a-f]{7,40}$/i.test(ref) ? ref : null;
    const rec = {
      project: String(project ?? ""),
      branch: String(branch ?? ""),
      path: treePath ? norm(treePath) : null,
      parent,
      parentSha: startSha ? String(startSha) : null,
      parentRef: ref || null,
      parentSource: parent ? "cut" : "unknown",
      why: parent ? "" : `cut from ${ref || "an unnamed ref"} — that is not a local branch to roll into`,
      by,
      at: at || new Date().toISOString(),
    };
    this.records.set(parentKey(rec.project, rec.branch), rec);
    this.save();
    return rec;
  }

  // Remember a heuristic answer. Kept in the same file so a restart does not re-guess the same tree a different
  // way, and so the reader can see that it was a guess.
  noteBackfill({ project, branch, parent, parentSha = null, why = "", at = null }) {
    const rec = {
      project: String(project ?? ""),
      branch: String(branch ?? ""),
      path: null,
      parent: parent || null,
      parentSha: parentSha || null,
      parentRef: parent || null,
      parentSource: parent ? "backfilled" : "unknown",
      why: why || "",
      by: "backfill",
      at: at || new Date().toISOString(),
    };
    // Never overwrite a cut record: it is the only exact answer there is.
    const cur = this.get(project, branch);
    if (cur && cur.parentSource === "cut") return cur;
    this.records.set(parentKey(rec.project, rec.branch), rec);
    return rec;
  }

  // What one project's rows read: a compact array, because it is postMessage'd into the scan worker.
  rowsFor(project) {
    const out = [];
    for (const rec of this.records.values()) {
      if (rec.project !== project) continue;
      if (!rec.branch) continue;
      out.push({ path: rec.path || null, branch: rec.branch, parent: rec.parent || null, parentSha: rec.parentSha || null, parentSource: rec.parentSource || "unknown" });
    }
    return out;
  }

  // Fill in every branch of a project that has no exact record. Cost is git calls per unresolved branch, so this
  // runs on a slow clock (or on demand from the steward), never per scan.
  async refresh({ project, repoDir, mainBranch = null, branches = null, save = true }) {
    const list = Array.isArray(branches) && branches.length
      ? branches
      : (await gitIn(repoDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"], 20000)).out?.split("\n").filter(Boolean) || [];
    const known = new Map();
    for (const b of list) {
      const rec = this.get(project, b);
      if (rec) known.set(b, rec);
    }
    const resolved = await resolveParents({ repoDir, branches: list, records: known, mainBranch });
    let learned = 0;
    for (const [branch, rec] of resolved) {
      const cur = this.get(project, branch);
      if (cur && cur.parentSource === "cut") continue;
      if (rec.parentSource === "unknown") {
        const why = rec.why || "";
        this.why.set(parentKey(project, branch), why);
        if (!cur || cur.parentSource !== "unknown" || (cur.why || "") !== why) {
          this.noteBackfill({ project, branch, parent: null, why });
          learned += 1;
        }
        continue;
      }
      this.noteBackfill({ project, branch, parent: rec.parent, parentSha: rec.parentSha, why: rec.why || "" });
      this.why.set(parentKey(project, branch), rec.why || "");
      learned += 1;
    }
    if (learned && save) this.save();
    return { branches: list.length, learned };
  }

  forget(project, branch) {
    const key = parentKey(project, branch);
    if (this.records.delete(key)) this.save();
    this.why.delete(key);
  }

  state(project = null) {
    return [...this.records.values()].filter((r) => !project || r.project === project);
  }
}
