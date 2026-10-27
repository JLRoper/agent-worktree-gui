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
// The timing is the other half. The reader wants the rename the moment the session name is first known, not
// at the end of a later turn, so this is asked on EVERY job event that carries a title — the title sweep
// (jobs.sweepTitles) emits one the moment Hermes writes the name, and the run's own events carry it too.
// What is still true is physical: git will not move a directory a live run is standing in, and the panel's
// rename refuses while one is. So an attempt that arrives mid-turn is deferred — not forgotten — and the
// first event after the tree is free makes the same attempt. There is never a second rename, only a second
// attempt at the first one, which the ledger still allows until one lands.
import { autoNameRefusal, treeKey } from "./tree-names.js";

const norm = (p) =>
  String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();

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
      if (this.inFlight.has(key)) return null;
      const title = String(this.titleFor(job) || "").trim();
      if (!title) return null;
      // A live run holds the tree: git refuses to move a directory something is standing in. The attempt is
      // made again on the first event after it lets go (the run's own settle), and the ledger is untouched
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
          how: `Hermes named the session “${title}”`,
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
