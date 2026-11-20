// core/cleanup-drop-all.js - the selection behind the cleanup chip's "drop all N suggested" button.
//
// WHAT THIS IS. The cleanup chip reads a project and prints one row per worktree with a keep-or-drop call on it
// (lib/cleanup-plan.js decides, public/board-scaffold.js draws). The plan says `remove` for a tree whose branch is
// landed and whose working tree is clean, and the row prints the word `drop` for it. This module answers the one
// question the button asks: WHICH rows, out of everything the plan printed, may this button act on?
//
// THE PREDICATE IS THE GUARD, and it is a function with a name rather than a selector inside a click handler:
//
//   isDropSuggested(row)   the row is labelled `drop` AND the plan's verdict is `remove`. Both, because the label is
//                          what the reader sees and the verdict is what the plan meant; a row where the two disagree
//                          is a row nothing should act on. Never a merge row, never a keep row, never a left-alone
//                          (skip) row, never a row with no call at all.
//
// Everything else here is arithmetic over that predicate, so a unit test can name each answer without a browser:
//
//   suggestedDropRows      the selection, in plan order, one row per path
//   dropAllCount           the number on the button, which must equal the drop rows and nothing else
//   dropAllLabel           "drop all 41 suggested", or "nothing to drop"
//   dropAllDisabled        at zero, and while another cleanup action is running
//   dropAllConfirmText     the sentence the confirm shows: the exact count, and the classes it will not touch
//   confirmAgainstFresh    the plan the confirm was written from, re-checked against the read taken at press time:
//                          a row that is no longer labelled drop is REFUSED with the fresh plan's own reason, and a
//                          row that only the fresh read calls drop is not acted on (nobody confirmed it)
//   runDropAll             the loop: one row at a time, progress after each step, carry on past a refusal, collect
//                          every refusal into one list, and never stop at the first
//
// NO DELETION PATH LIVES HERE. `runDropAll` takes `dropOne` as an argument; public/board-scaffold.js hands it the
// panel's own single-row delete (POST /api/worktree/delete), which is the same route the row's x and the per-row
// drop button use, so every removal records the same history entry and passes the same guards: a locked tree, a
// tree a live job holds, and a tree the planner no longer calls drop are all refused and reported, never forced.
//
// No DOM and no network in this file. Published on globalThis as `wtCleanupDropAll`; loaded before
// public/board-scaffold.js in public/index.html, used by public/board-scaffold.js, imported by
// test/cleanup-drop-all.test.js.
(function (root) {
  "use strict";

  const DROP = "drop";
  const REMOVE = "remove";
  const MERGE = "merge";
  const KEEP = "keep";
  const SKIP = "skip";

  const lower = (v) => String(v == null ? "" : v).trim().toLowerCase();

  /** The path key every row is found by: forward slashes, no tail, as the plan itself writes it. */
  function pathOf(row) {
    return String((row && row.path) || "")
      .replace(/\\/g, "/")
      .replace(/\/+$/, "");
  }

  /** The short name a progress line or a failure list shows, so a list of trees reads as names and not as paths. */
  function nameOf(row) {
    const p = pathOf(row);
    return p.slice(p.lastIndexOf("/") + 1) || p;
  }

  /**
   * THE predicate. A row this button may drop: labelled `drop` AND the plan's verdict is `remove`.
   *
   * Anything else is not acted on, whatever else it carries: a merge row (its branch has work main lacks, so its tree
   * stays and only a branch moves), a keep row, a left-alone (skip) row, and a row with no call at all.
   */
  function isDropSuggested(row) {
    if (!row || typeof row !== "object") return false;
    return lower(row.call) === DROP && lower(row.verdict) === REMOVE;
  }

  /** The selection: every row the predicate names, in plan order, one entry per path. */
  function suggestedDropRows(rows) {
    const out = [];
    const seen = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!isDropSuggested(row)) continue;
      const key = pathOf(row).toLowerCase();
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      out.push(row);
    }
    return out;
  }

  /** The count on the button: exactly the number of rows labelled drop. */
  function dropAllCount(rows) {
    return suggestedDropRows(rows).length;
  }

  /**
   * The classes the button will not touch, counted from the rows it is NOT acting on, in a fixed order. `unlabelled`
   * is the row that carries a verdict this file does not know or no call at all: it is refused by the same predicate,
   * so it has to be accounted for in the sentence rather than left out of it.
   */
  function excludedCounts(rows) {
    const counts = { merge: 0, keep: 0, skip: 0, unlabelled: 0 };
    for (const row of Array.isArray(rows) ? rows : []) {
      if (isDropSuggested(row)) continue;
      const verdict = lower(row && row.verdict);
      if (verdict === MERGE) counts.merge += 1;
      else if (verdict === KEEP) counts.keep += 1;
      else if (verdict === SKIP) counts.skip += 1;
      else counts.unlabelled += 1;
    }
    return counts;
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  /** The button's own words: the live count, or "nothing to drop" when the predicate names no row. */
  function dropAllLabel(rows) {
    const n = dropAllCount(rows);
    return n ? `drop all ${n} suggested` : "nothing to drop";
  }

  /** The tooltip: what the press does, and the classes it leaves alone. */
  function dropAllTitle(rows) {
    const n = dropAllCount(rows);
    if (!n) return "no worktree on this plan is labelled drop, so there is nothing for this button to drop";
    const c = excludedCounts(rows);
    const held = c.merge + c.keep + c.skip + c.unlabelled;
    return (
      `remove the ${n} worktree${n === 1 ? "" : "s"} labelled drop, one at a time through the panel's own delete route, ` +
      `after a confirm that names the count${held ? ` and the ${held} row${held === 1 ? "" : "s"} it will not touch` : ""} - ` +
      "a tree the plan no longer calls drop is refused and listed, never forced"
    );
  }

  /** At zero, and while another cleanup action is running, the button is not pressable. */
  function dropAllDisabled(rows, options) {
    const busy = Boolean(options && options.busy);
    return busy || dropAllCount(rows) === 0;
  }

  /**
   * The confirm's sentence. It states the exact count and names every class the run will not touch, so a reader can
   * check the arithmetic before pressing: the drop count plus the excluded counts is every row on the plan.
   *
   * "41 worktrees will be removed; 3 merge rows, 2 keep rows and 1 left-alone row are not touched."
   */
  function dropAllConfirmText(rows) {
    const n = dropAllCount(rows);
    const c = excludedCounts(rows);
    const parts = [];
    if (c.merge) parts.push(plural(c.merge, "merge row", "merge rows"));
    if (c.keep) parts.push(plural(c.keep, "keep row", "keep rows"));
    if (c.skip) parts.push(plural(c.skip, "left-alone row", "left-alone rows"));
    if (c.unlabelled) parts.push(plural(c.unlabelled, "unlabelled row", "unlabelled rows"));
    const removed = n ? `${plural(n, "worktree", "worktrees")} will be removed` : "no worktree will be removed";
    if (!parts.length) return `${removed}; every row on the plan carries the drop label.`;
    const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
    const excluded = c.merge + c.keep + c.skip + c.unlabelled;
    return `${removed}; ${list} ${excluded === 1 ? "is" : "are"} not touched.`;
  }

  /**
   * The confirm, checked against the read taken at press time.
   *
   * A plan is a read of the disk, and the reader may sit on the confirm for a minute: a tree that was clean and
   * landed when the plan was printed can have a commit or an uncommitted file in it by the time the button is
   * pressed. That is exactly the case the planner refuses to call drop (lib/cleanup-plan.js rules 7, 8 and 11), so
   * the run asks the planner again and acts only where both reads agree.
   *
   *   rows      the rows to act on, taken from the FRESH read (its path and branch are the current ones)
   *   refused   the planned drop rows the fresh read no longer calls drop, each with the fresh plan's own sentence
   *
   * A row that only the fresh read calls drop is deliberately NOT in `rows`: the confirm named a count, and a run
   * that removed a tree nobody confirmed is a worse outcome than one that leaves it for the next press.
   */
  function confirmAgainstFresh(input) {
    const planned = suggestedDropRows(input && input.planned);
    const fresh = Array.isArray(input && input.fresh) ? input.fresh : [];
    const now = new Map();
    for (const row of fresh) {
      const key = pathOf(row).toLowerCase();
      if (key && !now.has(key)) now.set(key, row);
    }
    const rows = [];
    const refused = [];
    for (const row of planned) {
      const key = pathOf(row).toLowerCase();
      const cur = key ? now.get(key) : null;
      if (cur && isDropSuggested(cur)) {
        rows.push(cur);
        continue;
      }
      refused.push({
        path: pathOf(row),
        name: nameOf(row),
        why: cur
          ? String(cur.reason || "the fresh read of the project no longer calls this row drop")
          : "the fresh read of the project does not list this worktree any more",
      });
    }
    return { rows, refused };
  }

  /** "dropped 4 of 5; 1 row was refused", or "dropped 5 of 5; nothing was refused". */
  function dropAllNote(summary) {
    const dropped = Number(summary && summary.dropped) || 0;
    const attempted = Number(summary && summary.attempted) || 0;
    const refused = Number(summary && summary.refused) || 0;
    if (!attempted && !refused) return "nothing to drop";
    const base = `dropped ${dropped} of ${attempted}`;
    if (!refused) return `${base}; nothing was refused`;
    return `${base}; ${refused} ${refused === 1 ? "row was" : "rows were"} refused`;
  }

  /**
   * The run.
   *
   * `dropOne(row)` answers `{ ok: true }` or `{ ok: false, why }`; it may also throw, which is a refusal like any
   * other. `refused` arrives already refused (the plan check above) and is carried into the same list, so the reader
   * gets ONE list of everything that did not go and why. `onProgress` is called before each drop with
   * `{ done, total, name, path, row }`, so the caller can paint "dropping 12 of 41 - name" in place.
   *
   * A failure never stops the loop: the next row is dropped and the failure is collected.
   */
  async function runDropAll(input) {
    const selection = suggestedDropRows(input && input.rows);
    const dropOne = input && input.dropOne;
    const onProgress = typeof (input && input.onProgress) === "function" ? input.onProgress : () => {};
    const failures = [];
    const preRefused = Array.isArray(input && input.refused) ? input.refused : [];
    for (const row of preRefused) {
      failures.push({ path: String(row.path || ""), name: String(row.name || ""), why: String(row.why || "refused") });
    }
    if (typeof dropOne !== "function") {
      const empty = { attempted: preRefused.length, dropped: 0, refused: failures.length, failures };
      return { outcomes: [], summary: { ...empty, note: dropAllNote(empty) } };
    }
    const outcomes = [];
    let done = 0;
    for (const row of selection) {
      done += 1;
      try {
        onProgress({ done, total: selection.length, name: nameOf(row), path: pathOf(row), row });
      } catch {
        /* a paint that throws is not a reason to stop dropping */
      }
      let answer = null;
      try {
        answer = await dropOne(row);
      } catch (e) {
        answer = { ok: false, why: String((e && e.message) || e) };
      }
      const ok = Boolean(answer && answer.ok === true);
      if (ok) {
        outcomes.push({ path: pathOf(row), name: nameOf(row), ok: true, why: "" });
        continue;
      }
      const why = String((answer && answer.why) || "the panel's delete route refused it");
      outcomes.push({ path: pathOf(row), name: nameOf(row), ok: false, why });
      failures.push({ path: pathOf(row), name: nameOf(row), why });
    }
    const dropped = outcomes.filter((o) => o.ok).length;
    const summary = {
      // Every row the run accounted for: the ones it was handed and the ones already refused by the plan check.
      // `dropped + refused === attempted` always, so the three numbers in the sentence add up for the reader.
      attempted: selection.length + preRefused.length,
      dropped,
      refused: failures.length,
      failures,
    };
    summary.note = dropAllNote(summary);
    return { outcomes, summary };
  }

  root.wtCleanupDropAll = {
    isDropSuggested,
    suggestedDropRows,
    dropAllCount,
    excludedCounts,
    dropAllLabel,
    dropAllTitle,
    dropAllDisabled,
    dropAllConfirmText,
    confirmAgainstFresh,
    dropAllNote,
    runDropAll,
    pathOf,
    nameOf,
  };
})(globalThis);
