// ---- what a branch was STARTED to do: the half that sees both stores ---------------------------
// lib/descriptions.js owns the extraction and the record file. What lives here is the glue it cannot
// have: a harvest needs a ROW (which tree, in which project) and a JOB (the brief, and when it
// started) in the same pass, and only the composition root holds both. It runs on the events that can
// add either, never on render — /api/state reads a record, it does not build one.
//
// Both stores are read through their RAW maps rather than through `jobs.list()` / `store.rowsFor()`:
// finding the earliest run in a tree needs the prompt and the start time off every job, and the
// projections those calls return deliberately trim exactly those fields. They arrive as getters
// because the stores belong to the composition root, and `normPathKey` arrives as an argument rather
// than being re-declared here, because two spellings of the same path key is how a tree stops matching
// its own run.
//
// No emitter's subscription wiring is in this file: `store.onEvent(...)` and the boot pass stay in
// server.js, in their original order relative to the job store's own fan-out.
import { Descriptions, describeFromPrompt } from "../descriptions.js";

export function createDescriptions({ getConfig, getJobs, getRows, normPathKey, snapshot, broadcast, guard, log }) {
  const descriptions = new Descriptions({ file: getConfig().descriptionsFile, log });
  let timer = null;

  // The earliest run in each tree, out of the panel's own job store. A tree is reached by the path a run CUT
  // (`worktreePath`) or by the directory it ran in (`cwd`); a follow-up run into an existing tree carries only the
  // latter, which is why both are tried.
  function earliestRunPerTree() {
    const earliest = new Map();
    for (const j of getJobs().values()) {
      const started = String(j.startedAt || "");
      for (const p of [j.worktreePath, j.cwd]) {
        const n = normPathKey(p);
        if (!n) continue;
        const prev = earliest.get(n);
        if (!prev || started < String(prev.startedAt || "")) earliest.set(n, j);
      }
    }
    return earliest;
  }

  // One pass: give every tree that HAS a run, and no record yet, the opening of its earliest run's brief.
  function harvestNow() {
    const earliest = earliestRunPerTree();
    if (!earliest.size) return 0;
    let added = 0;
    for (const [key, row] of getRows()) {
      const cut = key.indexOf("::");
      const where = { project: cut < 0 ? key : key.slice(0, cut), path: row.path, branch: row.branch };
      // Asked BEFORE any text is derived. An extraction per harvest is the per-render cost this module exists to
      // avoid, and it is the RECORD — not the job store — that decides what a tree's description is.
      if (descriptions.isDescribed(where)) continue;
      const j = earliest.get(normPathKey(row.path));
      const text = describeFromPrompt(j && j.prompt);
      if (!text) continue;
      const rec = descriptions.remember(where, {
        text,
        from: { thread: j.thread || null, job: j.id || null, at: j.startedAt || null },
        // Which tree the words describe, in full: the key is the identity a rename keeps, and this is what a reader of
        // the file (or a check comparing two trees) can actually look up.
        path: row.path,
        branch: row.branch || null,
      });
      if (rec) added += 1;
    }
    return added;
  }

  // Collapsed into one pass per couple of seconds — a scan writes a row per worktree and a live turn emits an event per
  // line, and neither is a reason to re-walk the store. A pass that recorded something broadcasts, so the new section
  // reaches the board without waiting for the next scan to happen to mention that row.
  function harvest(delay = 1500) {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      // The pass is one part of a job event's handling among five; a throw from it must not take the rest down.
      const added = guard("description harvest", harvestNow) || 0;
      if (added) broadcast({ type: "snapshot", data: snapshot() });
    }, delay);
    timer.unref?.();
  }

  // ONE tree, re-derived — the ⟳ on its row. The same source the harvest uses (the earliest run still in the job store,
  // through `describeFromPrompt`), and the record decides whether it is written: nothing on file, or the panel's own
  // record gone stale against the commits the branch carries now. `descriptions.refresh` owns that rule, so this
  // function cannot rewrite a reader's text by forgetting to check.
  function refreshTree({ project = null, path: treePath = null, branch = null, commits = [] } = {}) {
    const where = { project, path: treePath, branch };
    const j = earliestRunPerTree().get(normPathKey(treePath)) || null;
    const text = describeFromPrompt(j && j.prompt);
    const out = descriptions.refresh(where, {
      text,
      from: j ? { thread: j.thread || null, job: j.id || null, at: j.startedAt || null } : null,
      commits,
      path: treePath,
      branch,
    });
    // The record, re-read even when nothing was written: the caller shows the text that is on file now.
    return { ...out, text: descriptions.forTree(where)?.text || out.text || null, rec: descriptions.forTree(where) || out.rec || null };
  }

  // What a branch was STARTED to do travels with the snapshot the way its name does: the row carries the record's own
  // text and where it came from, and no row carries a description for a tree the panel has no run for — the section is
  // then simply absent, which is the honest answer, not an empty box.
  function withDescriptions(snap) {
    for (const project of snap.projects || []) {
      for (const row of project.worktrees || []) {
        const rec = descriptions.forTree({ project: project.name, path: row.path, branch: row.branch });
        if (!rec || !rec.text) {
          delete row.description;
          continue;
        }
        row.description = { text: rec.text, from: rec.from || null, at: rec.at || null };
      }
    }
    return snap;
  }

  return { descriptions, earliestRunPerTree, harvest, harvestNow, refreshTree, withDescriptions };
}
