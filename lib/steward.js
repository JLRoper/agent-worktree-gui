// The project steward: what every local branch and worktree is, and the one plan that says what to do about it.
//
// The board tells the reader what one tree is doing. This answers the question the board never asks: of all the
// branches this project has left lying around, which are already IN something (so their tree and branch can go),
// which still hold work that its parent does not have (so they have to be rolled up first), and which the panel
// cannot judge at all (so a human has to say).
//
// The classification is deliberately about CONTENT, not history:
//   * ancestry is not evidence of landing — a squash merge into the main branch leaves the branch an ancestor of
//     nothing, and `ahead` counts commits the main branch never took;
//   * an ahead-count is not evidence either — a branch can be 40 commits ahead and every one of those patches
//     already be in the main branch under a different sha.
// So "landed" is asked two ways: the two tips have IDENTICAL TREES (`git diff --quiet A B`), or every commit of the
// branch has a patch-id already present in the ref (`git cherry A B` with no "+" line). Both are read-only and both
// survive squash merges, which is the case this project actually has.
//
// Five classes, and nothing else:
//   LANDED   its content is already in its parent or in the main branch
//   ROLLUP   ahead of its parent and absent from the main branch — the parent needs it
//   ORPHAN   no parent resolved (or no parent that may be written to) — a reader has to say where it goes
//   DIRTY    uncommitted changes: never touched, whatever else is true
//   LOCKED   the worktree is locked: skipped entirely, before anything is read about it
//
// Stage 3 of this feature is this file's plan: it writes a plan file and acts on nothing. Stage 4 is `apply()`,
// which may delete only LANDED + clean + unlocked trees and roll only through a parent's OWN worktree, serialised
// per parent branch, and never into the main branch. Nothing here edits a child's tree to reach its parent.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gitIn } from "./scan.js";
import { isMainName } from "./parents.js";
import { writerLocks, rollKey, stewardKey } from "./locks.js";

export const KINDS = ["LANDED", "ROLLUP", "ORPHAN", "DIRTY", "LOCKED"];

const norm = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
const lower = (p) => norm(p).toLowerCase();
const oneLine = (s, n = 200) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// ---- reading the repo -------------------------------------------------------------------------------------------

// `git worktree list --porcelain` is the only place a locked tree says so, and a locked tree is the one class that is
// not even read: it belongs to somebody else's session and the panel must not decide anything about it.
export async function worktrees(repoDir) {
  const r = await gitIn(repoDir, ["worktree", "list", "--porcelain"], 25000);
  if (!r.ok) return { ok: false, trees: [], error: r.err || r.out || "git worktree list failed" };
  const trees = [];
  let cur = null;
  for (const line of r.out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: norm(line.slice("worktree ".length).trim()), branch: null, locked: false, prunable: false, reason: "" };
      trees.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith("branch ")) cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    else if (line === "locked" || line.startsWith("locked ")) {
      cur.locked = true;
      cur.reason = line.slice("locked".length).trim();
    } else if (line === "prunable" || line.startsWith("prunable ")) cur.prunable = true;
  }
  return { ok: true, trees };
}

// Is `branch`'s content already in `ref`? Two independent proofs, both content-based:
//   identical  the two tips have the same tree, so there is nothing in the branch the ref lacks;
//   patches    every commit in `ref..branch` has a patch-id the ref already carries (squash/rebase/cherry-pick).
// A branch that is merely an ancestor of the ref also lands here — `cherry` prints nothing for it.
export async function contentIn(repoDir, ref, branch) {
  if (!ref || !branch || ref === branch) return { landed: true, how: "same branch" };
  const same = await gitIn(repoDir, ["diff", "--quiet", ref, branch], 25000);
  if (same.ok) return { landed: true, how: `identical content to ${ref}` };
  const cherry = await gitIn(repoDir, ["cherry", ref, branch], 30000);
  if (cherry.ok) {
    const lines = cherry.out ? cherry.out.split("\n").filter(Boolean) : [];
    const plus = lines.filter((l) => l.startsWith("+")).length;
    const minus = lines.filter((l) => l.startsWith("-")).length;
    if (plus === 0) {
      return { landed: true, how: minus > 0 ? `${minus} commit(s) already in ${ref} by patch-id (squash/rebase)` : `nothing of its own is missing from ${ref}` };
    }
  }
  const ahead = await gitIn(repoDir, ["rev-list", "--count", `${ref}..${branch}`], 20000);
  const behind = await gitIn(repoDir, ["rev-list", "--count", `${branch}..${ref}`], 20000);
  return {
    landed: false,
    how: `absent from ${ref}`,
    ahead: ahead.ok ? Number.parseInt(ahead.out, 10) : null,
    behind: behind.ok ? Number.parseInt(behind.out, 10) : null,
  };
}

// ---- the five classes -------------------------------------------------------------------------------------------

// A pure decision over facts already read, so the whole classification is testable without a repo. The order IS the
// policy: locked is skipped before anything else, dirty is never anything but dirty, and a parent the panel is not
// allowed to write to (master/main, or a guess) is never a roll — it is a question for the reader.
export function classify(entry = {}) {
  const e = entry || {};
  if (e.locked) return { kind: "LOCKED", why: `worktree is locked${e.reason ? ` (${e.reason})` : ""} — skipped entirely` };
  // The project's own checkout is the one tree nothing here may touch, whatever its content says.
  if (e.isMain) return { kind: "LANDED", why: "the project's own checkout — kept, never deleted", landedIn: "checkout" };
  if ((Number(e.dirty) || 0) + (Number(e.untracked) || 0) > 0) {
    return { kind: "DIRTY", why: `${Number(e.dirty) || 0} modified and ${Number(e.untracked) || 0} untracked file(s) — somebody's unfinished work` };
  }
  const inMaster = Boolean(e.inMaster?.landed);
  const inParent = Boolean(e.inParent?.landed);
  if (inMaster) return { kind: "LANDED", why: `content already in ${e.mainBranch || "main"} — ${e.inMaster.how}`, landedIn: "main" };
  const parentUsable = e.parent && !isMainName(e.parent, e.mainBranch) && e.parentSource !== "unknown";
  if (!parentUsable) {
    if (inParent) return { kind: "LANDED", why: `content already in its parent — ${e.inParent.how}`, landedIn: "parent" };
    return {
      kind: "ORPHAN",
      why: e.parent
        ? `its parent is ${e.parent}${isMainName(e.parent, e.mainBranch) ? " (a main/turnover branch)" : ` (${e.parentSource || "unknown"} — a guess)`} and it is not in master`
        : `${e.parentWhy || "no parent resolved"} — nothing here can say where it goes`,
    };
  }
  if (inParent) return { kind: "LANDED", why: `content already in ${e.parent} — ${e.inParent.how}`, landedIn: "parent" };
  const ahead = Number(e.ahead);
  if (Number.isFinite(ahead) && ahead > 0) {
    return {
      kind: "ROLLUP",
      why: `${ahead} commit(s) ahead of ${e.parent}, absent from ${e.mainBranch || "main"}`,
      // A guessed parent can be shown, and can open the question, but it may never drive the merge.
      rollable: e.parentSource === "cut",
      needsConfirm: e.parentSource !== "cut",
    };
  }
  return {
    kind: "ORPHAN",
    why: `cannot prove its content landed (${e.mainBranch || "main"} and ${e.parent} both lack it) and it has no commits of its own to roll — needs a reader's answer`,
  };
}

// One entry per local branch that has a worktree: the facts git gives, then classify().
export async function inspectProject({ project, repoDir, rows = [], parents = new Map(), mainBranch = null } = {}) {
  const listing = await worktrees(repoDir);
  const byPath = new Map(listing.trees.map((t) => [lower(t.path), t]));
  const byBranch = new Map(listing.trees.filter((t) => t.branch).map((t) => [t.branch, t]));
  const entries = [];
  for (const row of rows) {
    const tree = byPath.get(lower(row.path)) || byBranch.get(row.branch) || null;
    const parentRec = parents.get(row.branch) || null;
    const parent = parentRec?.parent || null;
    const entry = {
      path: norm(row.path),
      branch: row.branch || null,
      head: row.head || null,
      verdict: row.verdict || null,
      dirty: Number(row.dirty) || 0,
      untracked: Number(row.untracked) || 0,
      locked: Boolean(tree?.locked),
      reason: tree?.reason || "",
      inWorktreeList: Boolean(tree),
      parent,
      parentSha: parentRec?.parentSha || null,
      parentSource: parentRec?.parentSource || "unknown",
      parentWhy: parentRec?.why || "",
      mainBranch: mainBranch || "main",
      isMain: Boolean(row.branch) && row.branch === (mainBranch || "main"),
      ahead: null,
      inParent: { landed: false, how: "" },
      inMaster: { landed: false, how: "" },
      worktreePath: tree?.path || null,
    };
    const gross = entry.locked || entry.dirty + entry.untracked > 0;
    if (!gross) {
      const [master, inParent, ahead] = await Promise.all([
        contentIn(repoDir, mainBranch || "main", entry.branch),
        parent && parent !== entry.branch ? contentIn(repoDir, parent, entry.branch) : Promise.resolve({ landed: false, how: "no parent" }),
        parent && parent !== entry.branch
          ? gitIn(repoDir, ["rev-list", "--count", `${parent}..${entry.branch}`], 20000)
          : Promise.resolve({ ok: false, out: "" }),
      ]);
      entry.inMaster = master;
      entry.inParent = inParent;
      entry.ahead = ahead.ok ? Number.parseInt(ahead.out, 10) : null;
    }
    const c = classify(entry);
    entries.push({ ...entry, kind: c.kind, why: c.why, landedIn: c.landedIn || null, rollable: Boolean(c.rollable), needsConfirm: Boolean(c.needsConfirm) });
  }
  return entries;
}

// The delete rule, in one place: LANDED, clean, unlocked, and landed on evidence that is not a guess. Landed in
// master is exact for everyone; landed in a parent is exact only when the parent was recorded at the cut.
export function deletable(entry) {
  if (!entry || entry.kind !== "LANDED") return false;
  if (entry.locked) return false;
  if (entry.landedIn === "checkout") return false; // the project's own checkout
  if ((Number(entry.dirty) || 0) + (Number(entry.untracked) || 0) > 0) return false;
  if (entry.landedIn === "main") return true;
  return entry.parentSource === "cut" && entry.landedIn === "parent";
}

// ---- the plan ---------------------------------------------------------------------------------------------------

export function buildPlan({ project, repoDir, entries = [], questions = [], mainBranch = null, at = null } = {}) {
  const sorted = [...entries].sort((a, b) => String(a.kind).localeCompare(String(b.kind)) || String(a.branch || "").localeCompare(String(b.branch || "")));
  const del = sorted.filter((e) => deletable(e));
  const roll = sorted.filter((e) => e.kind === "ROLLUP" && e.parentSource === "cut");
  const ask = sorted.filter((e) => e.kind === "ORPHAN" || (e.kind === "ROLLUP" && e.parentSource !== "cut"));
  // Skipped is everything the plan deliberately does not act on: dirty and locked trees, and a LANDED tree that the
  // delete rule still refuses (a guess for a parent, or the project's own checkout). Saying so is the point — a tree
  // that simply vanished from the plan would read as "handled".
  const skip = sorted.filter((e) => e.kind === "DIRTY" || e.kind === "LOCKED" || (e.kind === "LANDED" && !deletable(e)));
  const counts = { total: sorted.length, delete: del.length, roll: roll.length, ask: ask.length, skip: skip.length };
  for (const k of KINDS) counts[k] = sorted.filter((e) => e.kind === k).length;
  return {
    project: String(project ?? ""),
    repoDir: norm(repoDir),
    mainBranch: mainBranch || "main",
    at: at || new Date().toISOString(),
    counts,
    entries: sorted,
    delete: del.map((e) => ({ path: e.path, branch: e.branch, why: e.why, landedIn: e.landedIn })),
    roll: roll.map((e) => ({ path: e.path, branch: e.branch, parent: e.parent, ahead: e.ahead, why: e.why })),
    ask: ask.map((e) => ({ path: e.path, branch: e.branch, parent: e.parent, parentSource: e.parentSource, kind: e.kind, why: e.why })),
    skip: skip.map((e) => ({ path: e.path, branch: e.branch, kind: e.kind, why: e.why })),
    questions: questions.map((q) => ({ ...q })),
  };
}

const bullets = (list, line) => (list.length ? list.map((e) => `- ${line(e)}`).join("\n") : "- (none)");

// The plan is written where the reader can open it in an editor and read it without the panel, and beside it the
// same plan as JSON so a route (or a test) never has to parse prose.
export function planText(plan) {
  const c = plan.counts || {};
  return [
    `# Steward plan — ${plan.project}`,
    ``,
    `generated: ${plan.at}`,
    `repo: ${plan.repoDir}`,
    `main branch: ${plan.mainBranch} (never a roll target)`,
    ``,
    `${c.total || 0} local branch(es): ${KINDS.map((k) => `${c[k] || 0} ${k}`).join(" · ")}`,
    `nothing here has been acted on: writing a plan touches no tree. Acting on it is a separate press that names THIS`,
    `plan (its generated stamp), re-reads everything first, and deletes only what the fresh pass still calls landed.`,
    ``,
    `## Would delete (${plan.delete.length}) — LANDED, clean, unlocked`,
    bullets(plan.delete, (e) => `\`${e.branch}\` at ${e.path} — ${oneLine(e.why, 160)}`),
    ``,
    `## Would roll (${plan.roll.length}) — rolled inside the parent's own worktree, serialised per parent`,
    bullets(plan.roll, (e) => `\`${e.branch}\` → \`${e.parent}\` (${e.ahead ?? "?"} commit(s)) — ${oneLine(e.why, 140)}`),
    ``,
    `## Needs you to answer (${plan.ask.length})`,
    bullets(plan.ask, (e) => `\`${e.branch}\` — ${oneLine(e.why, 200)}${e.parent ? ` (suggested parent: ${e.parent}, ${e.parentSource})` : ""}`),
    ``,
    `## Left alone (${plan.skip.length})`,
    bullets(plan.skip, (e) => `\`${e.branch}\` — ${e.kind}: ${oneLine(e.why, 160)}`),
    ``,
    ...(plan.questions?.length
      ? [`## Questions already asked (${plan.questions.length})`, bullets(plan.questions, (q) => `\`${q.branch}\` — ${oneLine(q.note || "where should this go?", 200)} (${q.by}${q.at ? `, ${q.at}` : ""})`), ``]
      : []),
  ].join("\n");
}

export function planPaths(dir, project) {
  const safe = String(project || "project").replace(/[^A-Za-z0-9._-]+/g, "-");
  const root = path.join(dir, "steward");
  return { dir: root, md: path.join(root, `${safe}.plan.md`), json: path.join(root, `${safe}.plan.json`) };
}

export function writePlan(dir, plan) {
  const paths = planPaths(dir, plan.project);
  mkdirSync(paths.dir, { recursive: true });
  const text = planText(plan);
  writeFileSync(paths.md, text);
  const tmp = `${paths.json}.tmp`;
  writeFileSync(tmp, JSON.stringify(plan, null, 2));
  renameSync(tmp, paths.json);
  return { ...paths, text };
}

export function readPlan(dir, project) {
  const paths = planPaths(dir, project);
  if (!existsSync(paths.json)) return null;
  try {
    const plan = JSON.parse(readFileSync(paths.json, "utf8"));
    return { ...plan, file: paths.md };
  } catch {
    return null;
  }
}

// ---- the questions ----------------------------------------------------------------------------------------------

// "Where should this go?" — the third outcome of the chip, and the only thing it does: record the question, start
// nothing. The file is small and append-only, keyed by tree, so asking twice replaces the note rather than piling up.
export class Questions {
  constructor({ file = null } = {}) {
    this.file = file;
    this.records = new Map();
    this.load();
  }

  load() {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      for (const q of saved.records || []) if (q && q.key) this.records.set(q.key, q);
    } catch {
      /* a ledger we cannot read is a ledger we start again — it holds questions, not state git depends on */
    }
  }

  save() {
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), records: [...this.records.values()] }, null, 2));
      renameSync(tmp, this.file);
    } catch {
      /* best effort: a lost question must not fail the press that asked it */
    }
  }

  ask({ project, path: treePath, branch, note = "", by = "reader" }) {
    const key = `${project}::${norm(treePath)}::${branch || ""}`;
    const rec = { key, project, path: norm(treePath), branch: branch || null, note: oneLine(note || "where should this go?", 300), by, at: new Date().toISOString() };
    this.records.set(key, rec);
    this.save();
    return rec;
  }

  list(project) {
    return [...this.records.values()].filter((q) => !project || q.project === project);
  }
}

// ---- stage 4: act -----------------------------------------------------------------------------------------------

// A roll-up is a merge inside the PARENT's worktree. Three hard rules, each of which used to be a way to lose work:
//   1. never into master/main — a child's work belongs on its turnover parent, and master is only ever written by
//      the merge agent the panel already has;
//   2. never by checking the parent out inside the child's tree — the child is somebody's live checkout;
//   3. never two at once per parent branch — the second `git merge` would fight the first (lib/locks.js).
// The gate every roll-up passes through, in one place because the route and the steward must refuse for the SAME
// reasons (a second copy of these rules is a second answer to "may I write here"). `parentSource` is the whole point:
// only "cut" is a fact, and a guess may never drive a merge.
export function rollGate({ parentBranch = null, parentSource = "unknown", mainBranch = null, prodBranch = null, parentWorktree = null } = {}) {
  if (!parentBranch) return { ok: false, refused: "none", error: "refused: no parent branch resolved — there is nothing to roll into" };
  if (isMainName(parentBranch, mainBranch)) {
    return { ok: false, refused: "main", error: `refused: ${parentBranch} is a main branch — a roll-up never merges into ${parentBranch}` };
  }
  if (String(parentSource) !== "cut") {
    return { ok: false, refused: "guess", error: `refused: ${parentBranch} is a ${parentSource} guess, not a recorded cut — a guess may not drive a merge` };
  }
  if (prodBranch && String(parentBranch) === String(prodBranch)) {
    return { ok: false, refused: "prod", via: "worker", error: `refused: ${parentBranch} is the production branch — a roll-up there is handed to a worker, never done by editing a tree` };
  }
  if (!parentWorktree) {
    return { ok: false, refused: "no-tree", via: "worker", error: `refused: ${parentBranch} is checked out in no local worktree — the roll needs a worker (or the reader) to make one` };
  }
  return { ok: true };
}

export async function rollUp({ repoDir, parentBranch, parentWorktree = null, childBranch, mainBranch = null, prodBranch = null, parentSource = "cut", dryRun = false } = {}) {
  if (!childBranch) return { ok: false, error: "no child branch" };
  const gate = rollGate({ parentBranch, parentSource, mainBranch, prodBranch, parentWorktree });
  if (!gate.ok) return gate;
  const status = await gitIn(parentWorktree, ["status", "--porcelain"], 20000);
  if (!status.ok) return { ok: false, error: `cannot read ${parentWorktree}: ${status.err || status.out}` };
  if (status.out) return { ok: false, error: `refused: ${parentWorktree} (${parentBranch}) has uncommitted work — a roll would bury it` };
  const head = await gitIn(parentWorktree, ["symbolic-ref", "--short", "HEAD"], 15000);
  if (!head.ok || head.out !== parentBranch) {
    return { ok: false, error: `refused: ${parentWorktree} is on ${head.out || "a detached HEAD"}, not ${parentBranch}` };
  }
  if (dryRun) return { ok: true, dryRun: true, parentBranch, parentWorktree, childBranch, method: "ff-or-merge" };
  return writerLocks.with(rollKey(repoDir, parentBranch), async () => {
    const ff = await gitIn(parentWorktree, ["merge", "--ff-only", "--no-edit", childBranch], 60000);
    if (ff.ok) {
      const sha = await gitIn(parentWorktree, ["rev-parse", "--short", "HEAD"], 15000);
      return { ok: true, method: "ff", parentBranch, parentWorktree, childBranch, sha: sha.ok ? sha.out : null };
    }
    // Not fast-forwardable: the parent has moved since the child was cut. A real merge commit is the panel's house
    // rule for that (never a rebase of somebody else's branch, never a reset), and a conflict aborts cleanly.
    const merge = await gitIn(parentWorktree, ["merge", "--no-edit", childBranch], 90000);
    if (merge.ok) {
      const sha = await gitIn(parentWorktree, ["rev-parse", "--short", "HEAD"], 15000);
      return { ok: true, method: "merge", parentBranch, parentWorktree, childBranch, sha: sha.ok ? sha.out : null };
    }
    await gitIn(parentWorktree, ["merge", "--abort"], 30000);
    return { ok: false, error: `the merge conflicted and was aborted: ${oneLine(merge.err || merge.out, 300)}`, conflict: true };
  }, { holder: `rollup ${childBranch}`, waitMs: 120000 });
}

// Where the parent branch is checked out, if anywhere. A branch checked out in no worktree cannot be merged into
// without making one, and the steward does not make trees: it says so and hands the reader the choice.
export function parentWorktreeOf(trees = [], branch) {
  const hit = (trees || []).find((t) => t.branch && t.branch === branch && !t.locked);
  return hit ? hit.path : null;
}

// The whole act pass. Everything is re-read first (the plan on disk is a statement, not an instruction), nothing is
// deleted that the fresh pass does not still call LANDED+clean+unlocked, and a roll whose parent is not an exact
// "cut" record is refused here even if a plan file says otherwise.
export async function applyPlan({ plan, fresh, expectedAt = null, repoDir, trees = [], dryRun = false, confirm = false, prodBranch = null, onLog = () => {} } = {}) {
  if (!fresh) return { ok: false, error: "no plan" };
  // The confirm names the plan the reader was looking at. A file that has moved on since (another confirm, a fresh
  // POST /api/steward) is not the thing they clicked, so the press is answered with a refusal instead of an action.
  if (!plan) return { ok: false, error: "refused: no plan file to confirm — write one with POST /api/steward first" };
  if (expectedAt && plan.at !== expectedAt) {
    return { ok: false, error: `refused: the plan on screen is from ${expectedAt} and the file now holds ${plan.at} — look again and confirm the new plan` };
  }
  const wouldDelete = fresh.delete || [];
  const wouldRoll = fresh.roll || [];
  const dry = { ok: true, dryRun: true, project: fresh.project, delete: wouldDelete, roll: wouldRoll, counts: fresh.counts };
  if (dryRun) return dry;
  // The refusal carries the same lists (so the reader can still see what WOULD have happened), but its own ok:false
  // has to win — a spread over it would hand back ok:true and read as a dry run that had acted.
  if (!confirm) return { ...dry, dryRun: false, ok: false, error: "refused: nothing is deleted or rolled without an explicit confirm" };

  return writerLocks.with(stewardKey(repoDir), async () => {
    const deleted = [];
    const rolled = [];
    const refused = [];
    for (const entry of wouldDelete) {
      const branch = entry.branch;
      const treePath = entry.path;
      if (!branch || !treePath) {
        refused.push({ ...entry, error: "no branch or path — nothing to remove" });
        continue;
      }
      const fresh2 = await gitIn(repoDir, ["status", "--porcelain"], 20000);
      if (!fresh2.ok) {
        refused.push({ ...entry, error: `cannot read the repo: ${fresh2.err || fresh2.out}` });
        continue;
      }
      const rm = await gitIn(repoDir, ["worktree", "remove", treePath], 60000);
      if (!rm.ok) {
        refused.push({ ...entry, error: `git worktree remove refused: ${oneLine(rm.err || rm.out, 240)}` });
        continue;
      }
      // The branch goes only when it is not the main branch and no other worktree still holds it — deleting a
      // branch somebody else has checked out fails, and `-D` on the wrong branch loses landable work.
      let branchGone = false;
      if (!isMainName(branch, fresh.mainBranch)) {
        const holders = (await worktrees(repoDir)).trees.filter((t) => t.branch === branch);
        if (!holders.length) {
          const dl = await gitIn(repoDir, ["branch", "-D", branch], 30000);
          branchGone = dl.ok;
          if (!dl.ok) onLog(`steward: branch ${branch} kept — ${oneLine(dl.err || dl.out, 160)}`);
        }
      }
      deleted.push({ ...entry, branchGone });
      onLog(`steward: removed worktree ${treePath} (${branch})${branchGone ? " and its branch" : ""}`);
    }
    for (const entry of wouldRoll) {
      const parentWorktree = parentWorktreeOf(trees, entry.parent);
      const out = await rollUp({
        repoDir,
        parentBranch: entry.parent,
        parentWorktree,
        childBranch: entry.branch,
        mainBranch: fresh.mainBranch,
        prodBranch,
      });
      if (out.ok) {
        rolled.push({ ...entry, method: out.method, sha: out.sha });
        onLog(`steward: rolled ${entry.branch} into ${entry.parent} (${out.method}${out.sha ? ` ${out.sha}` : ""})`);
      } else {
        refused.push({ ...entry, via: out.via || null, error: out.error });
      }
    }
    return { ok: true, project: fresh.project, at: new Date().toISOString(), deleted, rolled, refused, counts: fresh.counts };
  }, { holder: "steward apply", waitMs: 180000 });
}
