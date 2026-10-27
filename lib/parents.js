// The branch a worktree was cut from — its PARENT — and the commit that ref resolved to at the moment it was cut.
//
// Why this is a store of its own and not a field read back from git: git records where HEAD is now, never where a
// worktree started. `git worktree add -b <branch> <path> <startRef>` resolves `<startRef>` once and throws the answer
// away. So the panel writes it down when it cuts the tree (source "cut", the only source allowed to drive a write).
// For trees cut before this landed there are two reconstructions, in this order:
//
//   1. THE REFLOG, when it still has the branch's creation line — `branch: Created from <ref>` is what git itself
//      wrote at the cut, so this is evidence rather than a guess. It is only accepted when <ref> is a local branch;
//      `Created from HEAD` says nothing (every `checkout -b` writes it) and a main branch or a remote ref is not a
//      parent a roll-up could ever use, so both are answered "unknown" outright — deliberately NOT handed on to the
//      heuristic, which would then be free to name a sibling instead.
//   2. THE TICKET ID, when the reflog has expired: a branch whose name carries the same DMR-1234 as exactly one other
//      branch, which this one descends from, is guessed to have been cut from it. A guess, marked "backfilled".
//
// A reconstruction is shown to the reader and can open the question, but it can never delete or merge anything: every
// write path in lib/steward.js refuses a parent that is not "cut".
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

// The branch's own creation line, out of its reflog: `git worktree add -b foo .worktrees/foo dmr-7-turnover` leaves
// exactly `branch: Created from dmr-7-turnover` behind, written by git at the moment of the cut. That is the closest
// thing to a record git keeps, and it is the first reconstruction tried — a tree is only GUESSED at when this is gone.
//
// Returns null when the reflog says nothing usable (`Created from HEAD`, a remote ref, a sha, or no reflog at all), so
// the caller falls through to the ticket heuristic. `parent` is only set for a local, non-main branch: anything else
// answers "unknown" with the reason, because handing `Created from master` to the heuristic would let it name a
// SIBLING as the parent of every branch in the repo — the one answer that must never come out of a reconstruction.
export async function reflogCut(repoDir, branch, localBranches = null) {
  const r = await gitIn(repoDir, ["reflog", "show", "--format=%gs", branch], 15000);
  if (!r.ok || !r.out) return null;
  let ref = null;
  for (const line of r.out.split("\n")) {
    const m = /^branch: Created from (.+)$/.exec(line.trim());
    if (m) ref = m[1].replace(/^['"]|['"]$/g, "").trim(); // the LAST one wins: the creation is the oldest entry
  }
  if (!ref) return null;
  if (/^HEAD$/.test(ref)) return null; // every `checkout -b` writes this: it names no branch
  const locals = Array.isArray(localBranches) ? localBranches : null;
  const isLocal = locals ? locals.includes(ref) : true;
  if (!isLocal) return { parent: null, ref, why: `its reflog says it was created from ${ref}, which is not a local branch — nothing here can roll into it` };
  if (isMainName(ref)) return { parent: null, ref, why: `its reflog says it was created from ${ref} — a main branch, never a child's parent` };
  if (ref === branch) return null;
  return { parent: ref, ref, why: `its reflog still records \`Created from ${ref}\`` };
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
  // A reflog candidate is not a guess among equals: it is the ref git itself wrote at the cut, so it wins outright.
  const exact = usable.find((c) => c.reflog);
  if (exact) return { parent: exact.branch, why: exact.why || `its reflog records it created from ${exact.branch}` };
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
// THE REFLOG IS ASKED FIRST, and it is one process: `branch: Created from dmr-7-turnover` is git's own note of the cut,
// so a legacy tree is only GUESSED at once that line is gone (or says `HEAD`, which names nothing). The guess is the
// fallback, and it is deliberately the weaker of the two — hence "backfilled" for both: neither may drive a write.
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
  // The ticket id is only the FALLBACK's business now: a reflog creation line answers for a branch whose name carries
  // no ticket at all, so nothing is rejected before the reflog has been read.
  const mine = ticketIds(branch);
  const list = Array.isArray(branches) && branches.length
    ? branches
    : tips?.branches
      || (await gitIn(repoDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"], 20000)).out?.split("\n").filter(Boolean)
      || [];
  // The reflog's own creation line first: it is what git wrote at the cut, so it does not need a ticket id, a sibling,
  // or a merge-base to be believed. `null` means it has nothing usable and the heuristic below is the last resort.
  const cut = await reflogCut(repoDir, branch, list);
  if (cut) {
    if (!cut.parent) return { ids: mine, candidates: [], why: cut.why };
    return { ids: mine, candidates: [{ branch: cut.parent, sharesBase: true, isAncestor: true, behind: null, reflog: true, why: cut.why }], why: "" };
  }
  if (!mine.length) return { ids: [], candidates: [], why: "no ticket id in this branch's name" };
  const named = [];
  for (const other of list) {
    if (!other || other === branch) continue;
    if (isMainName(other)) continue;
    if (!ticketIds(other).some((id) => mine.includes(id))) continue;
    named.push(other);
  }
  if (!named.length) return { ids: mine, candidates: [], why: `no other branch carries ${mine.join(", ")}` };
  // `%(objectname)` in the same call as the merged list, so "which branches are behind me" and "which branch is at my
  // exact commit" are answered by ONE process. A branch whose tip IS my tip is not behind me in any useful sense — it
  // is a second name for the same commit (a tree cut from this one and nothing committed yet, or an alias). Letting it
  // through as an "ancestor at distance 0" is how a turnover branch came to advertise its own landed CHILD as its
  // parent, so it is dropped here rather than ranked later.
  const merged = await gitIn(repoDir, ["for-each-ref", "--merged", branch, "--format=%(refname:short) %(objectname)", "refs/heads"], 20000);
  const tipsOf = new Map();
  for (const line of merged.ok ? merged.out.split("\n").filter(Boolean) : []) {
    const at = line.lastIndexOf(" ");
    if (at > 0) tipsOf.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  const myTip = tipsOf.get(branch) || null;
  const out = [];
  for (const other of named) {
    const isAncestor = tipsOf.has(other);
    if (isAncestor && myTip && tipsOf.get(other) === myTip) continue; // same commit as me: never a parent
    let behind = null;
    if (isAncestor) {
      const n = await gitIn(repoDir, ["rev-list", "--count", `${other}..${branch}`], 15000);
      behind = n.ok ? Number.parseInt(n.out, 10) : null;
    }
    out.push({ branch: other, sharesBase: true, isAncestor, behind: Number.isFinite(behind) ? behind : null });
  }
  // No ancestor at all, and exactly one branch carries the ticket: it is still worth two calls, because a rebased
  // sibling shares this branch's history without being an ancestor of it — and the answer stays a GUESS, which no
  // write ever acts on. The direction is re-checked first: the turnover branch and the tree cut from it are exactly
  // this shape, and "the branch this one came from is its child" is the guess that would make every turnover row show
  // a parent it can never be rolled into.
  // Every candidate sat at this branch's own commit: they are the trees cut from it (or aliases), and a branch cannot
  // be rolled into a copy of itself. Saying so beats handing pickBackfill an empty list that reads "no shared ticket".
  if (!out.length) return { ids: mine, candidates: [], why: `${named.join(", ")} sit at this branch's own commit — they are trees cut FROM it, not its parent` };
  if (!out.some((c) => c.isAncestor) && out.length === 1) {
    const desc = await gitIn(repoDir, ["merge-base", "--is-ancestor", branch, out[0].branch], 15000);
    if (desc.ok) return { ids: mine, candidates: [], why: `${out[0].branch} was cut FROM this branch, so it is not its parent` };
    const base = await gitIn(repoDir, ["merge-base", branch, out[0].branch], 15000);
    if (!base.ok || !base.out) return { ids: mine, candidates: [], why: `${out[0].branch} shares the ticket but no history` };
    out[0].mergeBase = base.out;
  }
  return { ids: mine, candidates: out, why: "" };
}

// Work out the parent of every local branch of one project, from the cut records plus the heuristic. Returns one
// entry per branch, so the caller can put it on a row without a second lookup. Read-only: the book saves what it
// learns, nothing else.
export async function resolveParents({ repoDir, branches = [], only = null, records = new Map(), mainBranch = null } = {}) {
  const out = new Map();
  // `branches` is the CANDIDATE universe; `only` is what needs an answer. Resolving every branch of a big repo on a
  // clock spends a process per branch to re-derive answers it already has.
  const todo = Array.isArray(only) && only.length ? only : branches;
  for (const branch of todo) {
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
  //
  // `branches` narrows WHICH branches are resolved; it never narrows the candidate universe. That distinction is the
  // difference between a guess and a wrong guess: called mid-boot with only half the board's rows yet, the one branch
  // that happened to be in the list became "the only branch sharing this ticket" and a child was pointed at its own
  // sibling. One `for-each-ref` is the price of never asking that question of a partial list.
  async refresh({ project, repoDir, mainBranch = null, branches = null, save = true }) {
    const all = (await gitIn(repoDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"], 20000)).out?.split("\n").filter(Boolean) || [];
    const wanted = Array.isArray(branches) && branches.length ? branches.filter((b) => all.includes(b)) : all;
    const list = all;
    const known = new Map();
    for (const b of list) {
      const rec = this.get(project, b);
      if (rec) known.set(b, rec);
    }
    const resolved = await resolveParents({ repoDir, branches: list, only: wanted, records: known, mainBranch });
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
