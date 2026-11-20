// The cleanup chip's "drop all N suggested" button, proved without a browser.
//
// The button acts on a plan the cleanup chip printed: one row per worktree, each with a verdict (remove, merge, keep,
// skip) and a call (drop or keep). What this file pins is the one answer that decides which rows it may touch, and
// every number the button and its confirm show:
//
//   1. THE PREDICATE. `isDropSuggested` names a row that is labelled `drop` AND whose verdict is `remove`, and
//      nothing else: not a merge row, not a keep row, not a left-alone (skip) row, not a row with no call at all.
//      It is a named function, not a selector inside the click handler, so the guard can be asked here by name.
//   2. THE COUNT. The number on the button is exactly the drop rows; at zero the label says "nothing to drop" and
//      the button is disabled, and it is disabled too while another cleanup action is running.
//   3. THE CONFIRM. Its sentence states the exact count and names every class it will not touch, and the counts in it
//      add up to every row the plan printed.
//   4. THE FRESH CHECK. A row the plan called drop and a later read does not is REFUSED with that read's reason,
//      and a row only the later read calls drop is not acted on - nobody confirmed it.
//   5. THE RUN. One row at a time, a progress line before each, and a refusal (an answer of no, or a throw) never
//      stops the loop: every refusal lands in one list at the end.
//   6. THE WIRING. The page loads this module before board-scaffold.js, the press goes through these functions,
//      the drop is the panel's own single-row delete route, and the guard is the planner re-read rather than a
//      second deletion path. No em or en dash in any of it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

await import("../public/core/cleanup-drop-all.js");
const dropAll = globalThis.wtCleanupDropAll;

const here = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const scaffold = here("public/board-scaffold.js");
const app = here("public/app.js");
const core = here("public/core/cleanup-drop-all.js");
const html = here("public/index.html");
const css = here("public/style.css");
const doc = here("docs/using-the-board.md");
const DASHES = /[\u2013\u2014]/;

// A plan shaped like lib/cleanup-plan.js's answer: two trees it may drop and one of each class it may not touch.
const ROWS = [
  { path: "/p/.worktrees/landed-a", branch: "wtgui/landed-a", verdict: "remove", call: "drop", reason: "already in main by history, and the tree is clean" },
  { path: "/p/.worktrees/ahead", branch: "wtgui/ahead", verdict: "merge", call: "keep", reason: "1 commit main lacks" },
  { path: "/p/.worktrees/landed-b", branch: "wtgui/landed-b", verdict: "remove", call: "drop", reason: "every commit main lacks is cherry-equivalent, and the tree is clean" },
  { path: "/p/.worktrees/rollup", branch: "20261114_0930_DMR-1-rollup", verdict: "keep", call: "keep", reason: "turnover branch" },
  { path: "/p", branch: "main", verdict: "skip", call: "keep", reason: "the project's primary checkout" },
];
const pathsOf = (rows) => rows.map((r) => r.path);

// ---- 1. the predicate -----------------------------------------------------------------------------------------------
test("the predicate names the rows labelled drop, and never a merge, keep or left-alone row", () => {
  assert.equal(typeof dropAll.isDropSuggested, "function", "the guard is a function with a name the test can call");
  assert.deepEqual(
    ROWS.filter((r) => dropAll.isDropSuggested(r)).map((r) => r.path),
    ["/p/.worktrees/landed-a", "/p/.worktrees/landed-b"],
  );
  // Each class on its own, so a rule that stopped excluding one of them fails here rather than in the page.
  assert.equal(dropAll.isDropSuggested({ verdict: "merge", call: "keep" }), false, "a merge row is never dropped");
  assert.equal(dropAll.isDropSuggested({ verdict: "merge", call: "drop" }), false, "a `drop` call over a merge verdict is not a drop");
  assert.equal(dropAll.isDropSuggested({ verdict: "keep", call: "keep" }), false, "a keep row is never dropped");
  assert.equal(dropAll.isDropSuggested({ verdict: "skip", call: "keep" }), false, "a left-alone row is never dropped");
  assert.equal(dropAll.isDropSuggested({ verdict: "remove", call: "keep" }), false, "a `remove` verdict with no drop label is not acted on either");
  assert.equal(dropAll.isDropSuggested({ path: "/p/.worktrees/x", verdict: "remove" }), false, "an unlabelled row is never dropped");
  assert.equal(dropAll.isDropSuggested(null), false);
  assert.equal(dropAll.isDropSuggested("drop"), false, "a bare string is not a row");

  // The selection is that predicate and no second rule: one entry per path, in plan order.
  assert.deepEqual(pathsOf(dropAll.suggestedDropRows(ROWS)), ["/p/.worktrees/landed-a", "/p/.worktrees/landed-b"]);
  const twice = [...ROWS, { ...ROWS[0], branch: "wtgui/landed-a-again" }];
  assert.equal(dropAll.suggestedDropRows(twice).length, 2, "one row per path, however many times the plan lists it");
});

// ---- 2. the count, the label and the disabled state -----------------------------------------------------------------
test("the number on the button is exactly the drop rows, and at zero it says so and is disabled", () => {
  assert.equal(dropAll.dropAllCount(ROWS), 2);
  assert.equal(dropAll.dropAllLabel(ROWS), "drop all 2 suggested");
  assert.equal(dropAll.dropAllDisabled(ROWS), false);
  assert.equal(dropAll.dropAllDisabled(ROWS, { busy: true }), true, "unavailable while another cleanup action is running");

  const none = ROWS.filter((r) => !dropAll.isDropSuggested(r));
  assert.equal(dropAll.dropAllCount(none), 0);
  assert.equal(dropAll.dropAllLabel(none), "nothing to drop");
  assert.equal(dropAll.dropAllDisabled(none), true, "at zero there is nothing to press");
  assert.equal(dropAll.dropAllLabel([]), "nothing to drop");
  assert.equal(dropAll.dropAllDisabled([], { busy: true }), true);

  // A plan read for a project with one drop prints "1", not "1 rows".
  const one = [ROWS[0], ROWS[1]];
  assert.equal(dropAll.dropAllLabel(one), "drop all 1 suggested");
  assert.equal(dropAll.dropAllCount(one), 1);
  // The tooltip says what the press does and never promises a force.
  assert.match(dropAll.dropAllTitle(ROWS), /2 worktrees labelled drop/);
  assert.match(dropAll.dropAllTitle(none), /nothing for this button to drop/);
  assert.doesNotMatch(dropAll.dropAllTitle(ROWS), /--force/, "the tooltip never offers a forced removal");
  assert.match(dropAll.dropAllTitle(ROWS), /never forced/, "and says a refusal is the answer, not a force");
});

// ---- 3. the confirm -------------------------------------------------------------------------------------------------
test("the confirm states the exact count and names every class it will not touch", () => {
  assert.equal(
    dropAll.dropAllConfirmText(ROWS),
    "2 worktrees will be removed; 1 merge row, 1 keep row and 1 left-alone row are not touched.",
  );
  // The counts in the sentence are the whole plan: nothing is dropped that is not counted, nothing is left out of
  // the exclusion list, and the predicate is what decides both sides.
  for (const rows of [ROWS, ROWS.slice(0, 1), ROWS.filter((r) => !dropAll.isDropSuggested(r)), []]) {
    const c = dropAll.excludedCounts(rows);
    assert.equal(
      dropAll.dropAllCount(rows) + c.merge + c.keep + c.skip + c.unlabelled,
      rows.length,
      "the confirm accounts for every row the plan printed",
    );
  }
  // Forty-one of them, the shape the row asked for: the big number first, then the classes held back.
  const many = [
    ...Array.from({ length: 41 }, (_, i) => ({ path: `/p/.worktrees/drop-${i}`, verdict: "remove", call: "drop", reason: "clean and landed" })),
    ...Array.from({ length: 3 }, (_, i) => ({ path: `/p/.worktrees/merge-${i}`, verdict: "merge", call: "keep", reason: "work main lacks" })),
    ...Array.from({ length: 2 }, (_, i) => ({ path: `/p/.worktrees/keep-${i}`, verdict: "keep", call: "keep", reason: "turnover branch" })),
  ];
  assert.equal(
    dropAll.dropAllConfirmText(many),
    "41 worktrees will be removed; 3 merge rows and 2 keep rows are not touched.",
  );
  assert.equal(dropAll.dropAllLabel(many), "drop all 41 suggested", "the button's count is the same 41");
  // An unlabelled row is a class too: it is refused by the predicate, so the sentence has to say so.
  assert.match(
    dropAll.dropAllConfirmText([...ROWS, { path: "/p/.worktrees/odd", verdict: "remove" }]),
    /1 unlabelled row are not touched/,
  );
  // One row, so the verb agrees with it.
  assert.equal(dropAll.dropAllConfirmText([ROWS[0], ROWS[1]]), "1 worktree will be removed; 1 merge row is not touched.");
});

// ---- 4. the plan re-checked at press time ---------------------------------------------------------------------------
test("a row the fresh read no longer calls drop is refused, and a row only the fresh read calls drop is not acted on", () => {
  const planned = ROWS;
  const fresh = [
    // landed-a is unchanged.
    { ...ROWS[0] },
    // landed-b acquired an uncommitted file: the planner's own rule keeps it now, and its sentence says why.
    { ...ROWS[2], verdict: "keep", call: "keep", dirty: true, reason: "its commits are in main but its tree holds uncommitted work (1 file)" },
    // a tree the plan had not seen, which this read calls drop: nobody confirmed it.
    { path: "/p/.worktrees/new", branch: "wtgui/new", verdict: "remove", call: "drop", reason: "already in main" },
    // and one planned drop row that has vanished from disk entirely.
  ];
  const { rows, refused } = dropAll.confirmAgainstFresh({ planned, fresh });
  assert.deepEqual(pathsOf(rows), ["/p/.worktrees/landed-a"], "only the row both reads call drop is acted on");
  assert.deepEqual(refused.map((r) => r.name), ["landed-b"], "the dirtied row is refused, by name");
  assert.match(refused[0].why, /holds uncommitted work/, "and the fresh plan's own sentence is the reason");
  assert.equal(refused[0].path, "/p/.worktrees/landed-b");

  // A row that is gone from the fresh read is refused too, rather than dropped on a path that no longer exists.
  const gone = dropAll.confirmAgainstFresh({ planned, fresh: [ROWS[0]] });
  assert.equal(gone.refused.length, 1);
  assert.match(gone.refused[0].why, /does not list this worktree any more/);

  // Nothing changed: every drop row survives, in plan order.
  const same = dropAll.confirmAgainstFresh({ planned, fresh: ROWS });
  assert.deepEqual(pathsOf(same.rows), ["/p/.worktrees/landed-a", "/p/.worktrees/landed-b"]);
  assert.deepEqual(same.refused, []);
});

// ---- 5. the run -----------------------------------------------------------------------------------------------------
test("the run carries on past a refusal, collects every one, and paints progress in place", async () => {
  const seen = [];
  const dropOne = async (row) => {
    seen.push(row.path);
    if (row.path.endsWith("landed-b")) return { ok: false, why: "an agent is running in that worktree (job-7)" };
    if (row.path.endsWith("landed-c")) throw new Error("HTTP 409 from the panel");
    return { ok: true };
  };
  const rows = [
    ...ROWS,
    { path: "/p/.worktrees/landed-c", branch: "wtgui/landed-c", verdict: "remove", call: "drop", reason: "already in main" },
    { path: "/p/.worktrees/landed-d", branch: "wtgui/landed-d", verdict: "remove", call: "drop", reason: "already in main" },
  ];
  const progress = [];
  const { outcomes, summary } = await dropAll.runDropAll({
    rows,
    refused: [{ path: "/p/.worktrees/landed-z", name: "landed-z", why: "its commits are in main but its tree holds uncommitted work" }],
    onProgress: ({ done, total, name }) => progress.push(`dropping ${done} of ${total} - ${name}`),
    dropOne,
  });

  // Every drop row was attempted, in plan order, and the answer of no did not end the run.
  assert.deepEqual(seen, ["/p/.worktrees/landed-a", "/p/.worktrees/landed-b", "/p/.worktrees/landed-c", "/p/.worktrees/landed-d"]);
  assert.deepEqual(progress, [
    "dropping 1 of 4 - landed-a",
    "dropping 2 of 4 - landed-b",
    "dropping 3 of 4 - landed-c",
    "dropping 4 of 4 - landed-d",
  ]);
  assert.deepEqual(outcomes.map((o) => o.ok), [true, false, false, true]);

  // One list of everything that did not go: the pre-run refusal first, then each drop that was refused.
  assert.equal(summary.attempted, 5, "four rows handed over plus the one the plan check refused");
  assert.equal(summary.dropped, 2);
  assert.equal(summary.refused, 3);
  assert.equal(summary.dropped + summary.refused, summary.attempted, "the three numbers add up, as the sentence reads");
  assert.deepEqual(summary.failures.map((f) => f.name), ["landed-z", "landed-b", "landed-c"]);
  assert.match(summary.failures[1].why, /an agent is running/);
  assert.match(summary.failures[2].why, /HTTP 409/, "a throw is collected as a refusal, not as a crash");
  assert.equal(summary.note, "dropped 2 of 5; 3 rows were refused");
  assert.equal(dropAll.dropAllNote({ attempted: 4, dropped: 4, refused: 0 }), "dropped 4 of 4; nothing was refused");
  assert.equal(dropAll.dropAllNote({ attempted: 1, dropped: 0, refused: 1 }), "dropped 0 of 1; 1 row was refused");
  assert.equal(dropAll.dropAllNote({ attempted: 0, dropped: 0, refused: 0 }), "nothing to drop");

  // A paint that throws is not a reason to stop dropping either.
  const stubborn = await dropAll.runDropAll({
    rows: ROWS.slice(0, 1),
    onProgress: () => {
      throw new Error("the bar is gone");
    },
    dropOne: async () => ({ ok: true }),
  });
  assert.equal(stubborn.summary.dropped, 1);
  // No dropOne at all is an empty run, not a crash: the button's own guard is what stops it ever being pressed.
  const bare = await dropAll.runDropAll({ rows: ROWS });
  assert.equal(bare.summary.dropped, 0);
  assert.equal(bare.summary.attempted, 0);
});

// ---- 6. the wiring --------------------------------------------------------------------------------------------------
test("the page loads the selection before the scaffolding that presses it", () => {
  const coreTag = html.indexOf('/core/cleanup-drop-all.js');
  const scaffoldTag = html.indexOf('/board-scaffold.js');
  assert.ok(coreTag > 0, "index.html loads the module");
  assert.ok(scaffoldTag > 0, "index.html loads board-scaffold.js");
  assert.ok(coreTag < scaffoldTag, "the selection is loaded before the file that presses it");
  // One implementation, named once: board-scaffold.js calls these, it does not re-spell the predicate.
  assert.match(scaffold, /wtCleanupDropAll\.runDropAll\(/, `board-scaffold.js calls wtCleanupDropAll.runDropAll`);
  // Every answer the button shows is asked of the module, not recomputed in the page.
  for (const name of ["suggestedDropRows", "dropAllCount", "dropAllLabel", "dropAllDisabled", "dropAllConfirmText", "confirmAgainstFresh"]) {
    assert.match(scaffold, new RegExp(`wtCleanupDropAll\\.${name}\\(`), `board-scaffold.js calls wtCleanupDropAll.${name}`);
  }
  // No hand-rolled selection inside the drop-all region: the predicate is the one answer. (`row.call === "drop"` in
  // the ROW renderer is the label itself, which is what the button reads, not a second rule.)
  const region = scaffold.slice(scaffold.indexOf("// ---- the cleanup chip's drop-all"), scaffold.indexOf("// ---- end the cleanup chip's drop-all"));
  assert.doesNotMatch(region, /call\s*===\s*"drop"/, "no hand-rolled drop test in the drop-all handler");
  assert.doesNotMatch(app, /call\s*===\s*"drop"/, "and none in the click router either");
});

test("the press is the panel's own single-row drop, with the plan re-read first", () => {
  const begin = scaffold.indexOf("// ---- the cleanup chip's drop-all");
  const end = scaffold.indexOf("// ---- end the cleanup chip's drop-all");
  assert.ok(begin > 0 && end > begin, "the drop-all region is in public/board-scaffold.js");
  const region = scaffold.slice(begin, end);
  assert.match(region, /\/api\/worktree\/delete/, "one removal per row goes through the existing delete route");
  assert.match(region, /dryRun: true/, "the run re-reads the plan before it acts");
  assert.match(region, /confirmAgainstFresh\(/, "and acts only where the fresh read agrees");
  assert.match(region, /data-cleanup-confirm-go/, "the confirm carries its own confirm button");
  assert.match(region, /\.focus\(\)/, "and the confirm is focused when it opens, so the button is reachable by keyboard");
  assert.doesNotMatch(region, /--force|worktree", "remove"/, "no second, forced deletion path");
  // The page routes all three of its attributes to those functions.
  for (const attr of ["data-cleanup-drop-all", "data-cleanup-confirm-go", "data-cleanup-confirm-cancel"]) {
    assert.ok(app.includes(attr), `public/app.js routes ${attr}`);
  }
});

test("the button, its confirm and its failure list have styles of their own", () => {
  for (const sel of [".btn-cleanup-drop-all", ".cleanup-confirm", ".cleanup-drop-all-result", ".cleanup-drop-failures"]) {
    assert.ok(css.includes(sel), `style.css styles ${sel}`);
  }
  assert.ok(doc.includes("drop all"), "docs/using-the-board.md documents the button");
});

test("nothing this row ships uses an em dash or an en dash", () => {
  const region = scaffold.slice(scaffold.indexOf("// ---- the cleanup chip's drop-all"), scaffold.indexOf("// ---- end the cleanup chip's drop-all"));
  for (const [what, text] of [
    ["public/core/cleanup-drop-all.js", core],
    ["public/board-scaffold.js drop-all region", region],
    ["test/cleanup-drop-all.test.js", here("test/cleanup-drop-all.test.js")],
  ]) {
    assert.doesNotMatch(text, DASHES, `${what} carries no em or en dash`);
  }
});
