// The automatic half of naming a worktree, with the git taken out of it.
//
// A tree is cut from the prompt, so its name is the prompt cut at 24 characters; Hermes names the session
// from the work a moment later, and the panel gives that name to the tree — the directory and its branch.
// It happens ONCE, and the record of it (lib/tree-names.js) is what makes the "once" a fact rather than a
// hope: the panel records the tree at the cut, with the id of the run that cut it, and that record is the
// only thing this path will act on. A tree the panel found rather than cut is seeded under the name it was
// found with, and a tree that has been named is named — neither is touched again, whatever a later run's
// status says and however many events it sends.
//
// WHEN it is allowed is the other half, and both gates live here rather than in the caller:
//
//   * A SETTLED run only. The panel used to offer a tree the session title the moment the title existed, and a
//     title can exist while the turn is still going — Hermes writes the name at the start of a session as often
//     as at the end. Measured by the panel's own dogfood run: a tree was moved and its branch renamed INSIDE the
//     first turn, to “Commit notes.txt and open PR”, and that run's conclusion was the opposite — nothing was
//     changed, so there was nothing to commit, push or open a PR for. The reader's path, the row and the job
//     record of the turn all moved for a sentence about work that never happened. So a title is considered only
//     when the panel watched THIS run end (`done`, `failed`, `cancelled`), and never while a live run is still
//     standing in the tree.
//   * A title that DESCRIBES the work, never one that PROMISES it. “Commit notes.txt and open PR” is a request,
//     not a name: the deliverable it names is one the panel verifies elsewhere (a commit on the branch, a branch
//     on the remote, a PR for the branch), and in the only window a rename is allowed none of those exist yet —
//     the branch has no commit of its own and is not published, which is exactly why the rename was allowed. A
//     refused title is written beside the cut record (`TreeNames.offer`) so the row can say it was offered and
//     declined, and the tree's one name is NOT spent: a later settled title that describes the work can still
//     take it.
//
// The timing question is asked on EVERY job event that carries a title — the title sweep (jobs.sweepTitles)
// emits one when Hermes writes the name, and the run's own events carry it too, the terminal one included. An
// attempt that arrives mid-turn is deferred — not forgotten — and the settle's own event (or the sweep, for a
// job whose last event arrived before the title) makes the same attempt. There is never a second rename, only a
// second attempt at the first one, which the ledger still allows until one lands.
import { LIVE_JOB_STATUS } from "./jobs.js";
import { autoNameRefusal, treeKey } from "./tree-names.js";

const norm = (p) =>
  String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();

// The statuses that say the panel WATCHED the run end. `interrupted` is deliberately not one of them: it is a
// card whose stream this panel lost, so it is not evidence that the agent stopped — and a directory moved under
// a shell that is still working in it is the one thing a rename must never do.
export const SETTLED_JOB_STATUS = new Set(["done", "failed", "cancelled"]);

// Why this run is not settled enough to name a tree, or "" when it is. Named so a skip says which case it hit
// instead of a bare "not done".
export function settleRefusal(job) {
  const status = String(job?.status || "").trim();
  if (LIVE_JOB_STATUS.has(status)) return `the run is still going (${status})`;
  if (!SETTLED_JOB_STATUS.has(status)) return `the panel cannot prove the run ended (${status || "no status"})`;
  return "";
}

// ---- titles that promise work -------------------------------------------------------------------
//
// A session title is one line Hermes writes about the session, and it is sometimes the REQUEST itself rather
// than a summary of what was done (“Commit notes.txt and open PR”). Nothing here tries to judge whether a fix
// fixed anything — that is not a fact a title can carry. What it can carry, and this refuses, is a DELIVERABLE:
// a commit, a push, a pull request, a merge, a landing, a deploy, a release. Those are the claims the panel
// verifies from git and from the remote, and a tree's name must not be one.
//
// The shape is read per clause, because a title is often two instructions joined by "and": the action has to be
// the clause's own verb (after an optional "will/going to/…"), so a title that merely MENTIONS a deliverable —
// “Read-only review of Bitbucket PR #1”, “Show the push guard chip” — is left alone. The cost of a false
// positive is only a tree that keeps its cut name (the reader can name it by hand); the cost of a false
// negative is the dogfood bug above, so the judgement leans towards refusing.
const REMOTE_ACTIONS = new Set(
  (
    "commit commits committed committing push pushes pushed pushing merge merges merged merging land lands landed landing " +
    "deploy deploys deployed deploying release releases released releasing publish publishes published publishing " +
    "ship ships shipped shipping rebase rebases rebased rebasing submit submits submitted submitting raise raises raised raising"
  ).split(" "),
);
// A verb that only promises a deliverable when the clause names one ("open PR", "create a branch").
const DELIVERABLE_ACTIONS = new Set("open opens opened opening create creates created creating".split(" "));
const DELIVERABLES = new Set(
  (
    "pr prs commit commits branch branches remote origin upstream main master trunk merge release releases deployment " +
    "deploy github gitlab bitbucket"
  ).split(" "),
);
// A clause that opens with one of these is about the future whatever verb follows it.
const FUTURE_LEAD = new Set("will would going about plan plans planning need needs should must todo to".split(" "));

// The clause of `title` that promises a deliverable, or "" when the title only describes work. Exported because
// the tests want the same answer the policy uses.
export function titlePromise(raw) {
  const title = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!title) return "";
  // Split on the joins a title uses between two instructions. A "." is NOT a separator: “notes.txt” is a file
  // name, and cutting it in half would lose the only noun in the clause.
  const hits = [];
  for (const clause of title.split(/\s*(?:[;,]|\band\b|\bthen\b|&)\s*/i)) {
    const words = clause.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (!words.length) continue;
    let i = 0;
    while (i < words.length && FUTURE_LEAD.has(words[i])) i += 1;
    const verb = words[i];
    if (!verb) continue;
    const namesDeliverable = words.slice(i + 1).some((w) => DELIVERABLES.has(w));
    if (REMOTE_ACTIONS.has(verb)) hits.push({ clause, namesDeliverable });
    else if (DELIVERABLE_ACTIONS.has(verb) && namesDeliverable) hits.push({ clause, namesDeliverable });
  }
  // The clause that names the deliverable is the useful one to quote ("open PR" over "Commit notes.txt"), and it is
  // the one a reader would recognise as the promise. Fall back to the first clause that promised anything.
  const picked = hits.find((h) => h.namesDeliverable) || hits[0];
  return picked ? picked.clause : "";
}

export class WorktreeNaming {
  constructor({
    ledger,
    projectForPath,
    titleFor,
    isBusy,
    rename,
    log = () => {},
    // Resolves once the boot backfill has written down every tree the panel already knows (see
    // seedTreeNamesAtBoot in server.js). Until then a tree that WAS there before this process has no entry
    // yet, and "no entry" is the one state that would let a restored run's title rename it.
    ready = null,
  } = {}) {
    this.ledger = ledger;
    this.projectForPath = projectForPath;
    this.titleFor = titleFor;
    this.isBusy = isBusy;
    this.rename = rename;
    this.log = log;
    this.ready = ready;
    // The same-tick guard the ledger cannot be: a rename's first await is a git call, so two events of one
    // turn can both be inside renameWorktree before either has written anything down. Added synchronously,
    // before the first await in consider(), and only for the length of one attempt.
    this.inFlight = new Set();
  }

  // Called for every job event. Never throws: a name is not worth failing a turn's event over.
  async consider(job) {
    try {
      if (!job || !job.worktreePath) return null;
      // A reply has no tree of its own, and a base-checkout run lives in the project's own checkout, whose
      // name is the folder's. Neither is ever the agent's to take.
      if (job.reply || job.baseCheckout) return null;
      const project = this.projectForPath(job.worktreePath);
      if (!project || !project.name) return null;
      // The project's own checkout is the parent of every tree cut from it and keeps the folder's name.
      if (norm(project.path) === norm(job.worktreePath)) return null;
      if (this.ready) await this.ready.catch(() => {});
      const key = treeKey({ project: project.name, path: job.worktreePath });
      // The ledger decides, and it decides about the TREE — never about the run's own claims about itself.
      // `job.existing` is not consulted here on purpose: a flag that can be set wrong is exactly how a tree
      // the reader considers fixed was moved.
      const refusal = autoNameRefusal(this.ledger.get(key), job.id);
      if (refusal) return { skipped: refusal };
      // A settled run only: a title can land mid-turn, and a tree moved under a live turn takes the reader's
      // path and the turn's own record with it. The event that settles the run asks again below.
      const unsettled = settleRefusal(job);
      if (unsettled) return { skipped: unsettled };
      if (this.inFlight.has(key)) return null;
      const title = String(this.titleFor(job) || "").trim();
      if (!title) return null;
      // A title is a name only when it describes the work. One that promises a commit, a push, a PR, a merge or
      // a deploy is a request, and the panel can verify it — so it is declined and WRITTEN DOWN beside the cut
      // record, without spending the tree's one name.
      const promised = titlePromise(title);
      if (promised) {
        const why = `the title promises work that has not been done (“${promised}”)`;
        this.ledger.offer?.(key, {
          title,
          why,
          by: `run ${job.id} (${job.thread})`,
          at: new Date().toISOString(),
        });
        this.log(`auto-naming ${job.worktreePath}: declined — ${why}; a tree is named after what its run did, not after what it set out to do`);
        return { skipped: why, offered: title };
      }
      // A live run holds the tree: git refuses to move a directory something is standing in, and the branch
      // half can land while the directory half cannot, which is the split name this whole path exists to avoid.
      // The attempt is made again on the next event (the other run's own settle), and the ledger is untouched
      // in the meantime — so this is a delay, never a lost name.
      if (this.isBusy(job.worktreePath)) return { skipped: "a run is still in the tree" };
      this.inFlight.add(key);
      try {
        const out = await this.rename({
          projectName: project.name,
          target: job.worktreePath,
          name: title,
          once: true,
          run: job.id,
          by: `run ${job.id} (${job.thread})`,
          how: `Hermes named the session “${title}” at the end of its turn`,
        }).catch((e) => ({ error: String((e && e.message) || e) }));
        if (out?.error) this.log(`auto-naming ${job.worktreePath}: ${out.error}`);
        else if (out?.skipped) this.log(`auto-naming ${job.worktreePath}: ${out.skipped}`);
        else if (out?.collision) this.log(`auto-naming ${job.worktreePath}: ${out.warning}`);
        return out;
      } finally {
        this.inFlight.delete(key);
      }
    } catch (e) {
      this.log(`auto-naming ${job?.worktreePath || "a tree"} failed: ${String((e && e.message) || e)}`);
      return null;
    }
  }
}
