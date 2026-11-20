// The cleanup chip: its pill, its five states, and the two presses (a dry run, then an apply).
//
// Read out of public/board-scaffold.js and run with no browser, like test/ahead-behind-cell.test.js: the section is
// cut by its `// ---- the cleanup chip` markers and executed against stubs, so the chip's own logic is what is under
// test rather than whether a browser happened to be booted.
//
// What is pinned here, each one a way this looks right and is wrong:
//
//   1. the chip is drawn in the project head's second line BESIDE host, rules, turnover and board, and it is in the
//      repaint path those chips are in (`refreshChips`), so a phase that moved is redrawn by a snapshot;
//   2. the pill is the SAME pill: the CSS block sets the same padding, mono size, radius and left gap as the board
//      chip - a control with its own height breaks the line it sits on;
//   3. the five states are drawn from the last answer the server sent and nothing else: idle, busy on a read, armed
//      with the count, busy on an apply, done, and an error that NAMES the failing repo;
//   4. the first press is a DRY RUN (`dryRun: true`) and it changes nothing; the second press is `dryRun: false` and
//      only becomes possible once the first answered armed;
//   5. the run's page is opened through the panel's own opener when the run ends;
//   6. the bar's keep-or-drop calls only do what the server can do: `drop` posts the panel's own delete route,
//      `keep` writes nothing at all.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { sliceRegion } from "../tools/panel-testkit.mjs";

// The drop-all selection is the real module the page loads, not a stand-in: the chip's bar draws its button and its
// confirm from these answers, so a harness that stubbed them could pass while the page showed something else.
await import("../public/core/cleanup-drop-all.js");
const wtCleanupDropAll = globalThis.wtCleanupDropAll;

const scaffold = readFileSync(new URL("../public/board-scaffold.js", import.meta.url), "utf8");
const projects = readFileSync(new URL("../public/render-projects.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
const code = sliceRegion(scaffold, "the cleanup chip");

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const NAMES = [
  "cleanupChipHtml",
  "cleanupChipSig",
  "refreshCleanupChip",
  "cleanupBarHtml",
  "cleanupRowHtml",
  "cleanupTreeName",
  "cleanupOf",
  "cleanupRuns",
  "runCleanupChip",
  "answerCleanupCall",
  "closeCleanupBar",
];

// The stubs are the page the section would run in: a banner sink, the panel's fetch, the opener, and the bar stack.
// `document` answers nothing and `wtCleanupDropAll` is the real selection module, so the drop-all button beside the
// chip is drawn from the same answers the page uses without needing a DOM.
function harness({ answer = () => ({ ok: true, status: 200, body: {} }) } = {}) {
  const seen = { banners: [], fetches: [], opened: [], bars: [], opened_bars: [] };
  const stubs = {
    esc,
    wtCleanupDropAll,
    document: { querySelectorAll: () => [], querySelector: () => null },
    CSS: { escape: (s) => String(s ?? "").replace(/["\\]/g, "\\$&") },
    apiFetch: async (url, opts = {}) => {
      seen.fetches.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
      const r = await answer(seen.fetches.length, url, opts);
      return { ok: r.ok !== false, status: r.status || 200, json: async () => r.body || {} };
    },
    showBanner: (m) => seen.banners.push(String(m)),
    openQuestionFile: (p) => seen.opened.push(String(p)),
    barsOf: (name) => (seen.bars.includes(name) ? ["cleanup"] : []),
    projectNode: () => null,
    openBar: (name, kind) => {
      if (!seen.bars.includes(name)) seen.bars.push(name);
      seen.opened_bars.push(kind);
    },
    closeBar: (name) => {
      seen.bars = seen.bars.filter((x) => x !== name);
    },
    repaintBars: () => {},
    refreshCleanupChip: () => {},
    resync: async () => {},
  };
  const api = new Function(...Object.keys(stubs), `${code}\nreturn { ${NAMES.join(", ")} };`)(...Object.values(stubs));
  return { ...api, seen };
}

const text = (html) => html.replace(/<[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const title = (html) => /title="([^"]*)"/.exec(html)[1];
const PLAN = {
  main: "main",
  turnoverBranch: null,
  rows: [
    { path: "/r/.worktrees/a", branch: "wtgui/a", verdict: "remove", call: "drop", proof: { kind: "ancestor", detail: "already there" }, reason: "already in main", dirty: false, dirtyFiles: [] },
    { path: "/r/.worktrees/b", branch: "wtgui/b", verdict: "merge", call: "keep", proof: { kind: "none", detail: "1 commit" }, reason: "one commit main lacks", dirty: true, dirtyFiles: ["x.txt"] },
    { path: "/r", branch: "main", verdict: "skip", call: "keep", proof: { kind: "none", detail: "" }, reason: "the project's primary checkout", dirty: false, dirtyFiles: [] },
  ],
  counts: { remove: 1, merge: 1, keep: 0, skip: 1 },
  droppable: 1,
};

test("the chip is drawn beside host, rules, turnover and board, and is in the same repaint path", () => {
  // The drop-all button is drawn immediately BEFORE the cleanup chip, because the chip is the last pill of the line
  // (test/e2e/cleanup-chip.spec.mjs asserts that), and a control that drops everything belongs beside the control
  // that reads the plan rather than at a screen's remove from it.
  assert.match(
    projects,
    /\$\{hostChipHtml\(name\)\}\$\{rulesChipHtml\(name\)\}\$\{turnoverChipHtml\(name\)\}\$\{boardChipHtml\(name\)\}\$\{cleanupDropAllButtonHtml\(name\)\}\$\{cleanupChipHtml\(name\)\}/,
  );
  // ...and refreshChips (the strip's repaint) is where the chip's own phase is redrawn, the way the other four are;
  // the drop-all button beside it is redrawn from the same call, so the two can never show two different plans.
  assert.match(projects, /refreshTurnoverChip\(name\);\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*refreshCleanupUi\(name\);/);
});

test("the pill is the board chip's pill: same padding, mono size, radius and left gap", () => {
  const block = (sel) => {
    const i = css.indexOf(`button.${sel} {`);
    assert.ok(i > 0, `missing ${sel}`);
    return css.slice(i, css.indexOf("}", i));
  };
  const pick = (src, prop) => (new RegExp(`${prop}:\\s*([^;]+);`).exec(src) || [, ""])[1].trim();
  const board = block("btn-board");
  const chip = block("btn-cleanup");
  for (const prop of ["margin-left", "padding", "border-radius", "background", "white-space"]) {
    assert.equal(pick(chip, prop), pick(board, prop), `${prop} must match the board chip`);
  }
  // The type scale is a shorthand (`font: 10.5px/1.6 var(--mono)`), so it is compared whole.
  assert.equal(pick(chip, "font"), pick(board, "font"));
});

test("at rest the chip says cleanup and offers the dry run first, in the same button class as its neighbours", () => {
  const h = harness();
  const html = h.cleanupChipHtml("demo");
  assert.equal(text(html), "cleanup");
  assert.match(html, /class="btn-cleanup"/);
  assert.match(html, /data-cleanup-chip="demo"/);
  assert.match(title(html), /nothing is removed until a second press/);
});

test("the states are drawn from the last answer: busy on a read, armed with the count, busy on an apply, done, and an error that names the repo", async () => {
  const h = harness({
    answer: (n) =>
      n === 1
        ? { body: { ok: true, dryRun: true, plan: PLAN, report: { path: "docs/reports/worktree-cleanup-2026-11-14-0930.html", absPath: "/repos/demo/docs/reports/worktree-cleanup-2026-11-14-0930.html" } } }
        : { body: { ok: true, dryRun: false, plan: PLAN, run: { ...PLAN, counts: { remove: 1, merge: 1, keep: 1, skip: 0 } }, report: { path: "docs/reports/worktree-cleanup-2026-11-14-0931.html", absPath: "/repos/demo/docs/reports/worktree-cleanup-2026-11-14-0931.html" } } },
  });

  // The busy state is what the chip draws while the answer is in flight; the press itself sets it before it asks.
  const pending = h.runCleanupChip("demo");
  const busy = h.cleanupChipHtml("demo");
  assert.match(text(busy), /cleanup: reading/);
  assert.match(busy, /is-busy/);
  await pending;

  const armed = h.cleanupChipHtml("demo");
  assert.equal(text(armed), "cleanup: 1 to drop, 1 to merge · apply");
  assert.match(armed, /is-armed/);
  assert.match(title(armed), /press to APPLY/);
  assert.equal(h.seen.opened[0], "/repos/demo/docs/reports/worktree-cleanup-2026-11-14-0930.html", "the plan page opens when the read ends");

  const applying = h.runCleanupChip("demo");
  const during = h.cleanupChipHtml("demo");
  assert.match(text(during), /cleanup: applying/);
  assert.match(during, /is-busy/);
  await applying;

  const done = h.cleanupChipHtml("demo");
  assert.equal(text(done), "cleanup: 1 dropped · 1 merged");
  assert.match(done, /is-done/);
  assert.equal(h.seen.opened[1], "/repos/demo/docs/reports/worktree-cleanup-2026-11-14-0931.html");

  // The error state: the label and the tooltip both name the repo that failed.
  const bad = harness({ answer: () => ({ ok: false, status: 502, body: { error: "could not list the worktrees of demo" } }) });
  await bad.runCleanupChip("demo");
  const failed = bad.cleanupChipHtml("demo");
  assert.equal(text(failed), "cleanup failed: demo");
  assert.match(failed, /is-error/);
  assert.match(title(failed), /could not list the worktrees of demo/);
  assert.match(bad.seen.banners.join(" "), /demo: cleanup failed/);
});

test("the armed label says what the press will do, merges included, and a plan with nothing to act on offers no apply", async () => {
  // Only merges: the press still moves two branches, so the pill says the merges rather than "0 to drop".
  const mergesOnly = { ...PLAN, counts: { remove: 0, merge: 2, keep: 1, skip: 1 }, droppable: 0 };
  const h = harness({ answer: () => ({ body: { ok: true, dryRun: true, plan: mergesOnly, report: { path: "p", absPath: "/repos/demo/p" } } }) });
  await h.runCleanupChip("demo");
  assert.equal(text(h.cleanupChipHtml("demo")), "cleanup: 2 to merge · apply");
  assert.match(h.cleanupChipHtml("demo"), /is-armed/);

  // Nothing to act on: no apply is offered, and the second press reads the project again instead of writing an
  // "APPLIED" page about an empty plan.
  const nothing = {
    ...PLAN,
    counts: { remove: 0, merge: 0, keep: 2, skip: 1 },
    droppable: 0,
    rows: PLAN.rows.map((r) => ({ ...r, verdict: r.verdict === "remove" ? "keep" : r.verdict, call: "keep" })),
  };
  const empty = harness({ answer: () => ({ body: { ok: true, dryRun: true, plan: nothing, report: { path: "p", absPath: "/repos/demo/p" } } }) });
  await empty.runCleanupChip("demo");
  const quiet = empty.cleanupChipHtml("demo");
  assert.equal(text(quiet), "cleanup: nothing to do");
  assert.equal(/is-armed|is-done/.test(quiet), false, "neither an apply nor a finished run is claimed");
  assert.match(title(quiet), /a second press only reads the project again/);
  await empty.runCleanupChip("demo");
  assert.deepEqual(empty.seen.fetches.map((f) => f.body.dryRun), [true, true], "both presses are dry runs");
  assert.equal(empty.cleanupOf("demo").run, null, "no run was applied");
});

test("the first press is a dry run and the second is the apply: the write is not sent until the plan came back armed", async () => {
  const h = harness({
    answer: () => ({ body: { ok: true, dryRun: true, plan: PLAN, run: null, report: { path: "p", absPath: "/repos/demo/p" } } }),
  });
  await h.runCleanupChip("demo");
  assert.equal(h.seen.fetches.length, 1);
  assert.equal(h.seen.fetches[0].url, "/api/projects/demo/cleanup");
  assert.deepEqual(h.seen.fetches[0].body, { dryRun: true });
  await h.runCleanupChip("demo");
  assert.equal(h.seen.fetches.length, 2);
  assert.deepEqual(h.seen.fetches[1].body, { dryRun: false }, "the second press asks for the apply, and only the second");
});

test("a press while a read or an apply is in flight is ignored: one run per project at a time", async () => {
  let release;
  const h = harness({
    answer: () =>
      new Promise((resolve) => {
        release = () => resolve({ body: { ok: true, dryRun: true, plan: PLAN, report: { path: "p", absPath: "/repos/demo/p" } } });
      }),
  });
  // The harness's apiFetch is awaited by the chip, so a promise-returning answer parks the run mid-flight.
  const first = h.runCleanupChip("demo");
  const second = h.runCleanupChip("demo");
  assert.equal(h.seen.fetches.length, 1, "the second press must not start a second read");
  release();
  await Promise.all([first, second]);
});

test("a drop call posts the panel's own delete route with the project and the tree path", async () => {
  const h = harness({ answer: () => ({ body: { ok: true } }) });
  const button = { dataset: { cleanupProject: "demo", cleanupPath: "/r/.worktrees/a", cleanupBranch: "wtgui/a" }, disabled: false, textContent: "drop" };
  await h.answerCleanupCall("drop", button);
  assert.equal(h.seen.fetches.length, 1);
  assert.equal(h.seen.fetches[0].url, "/api/worktree/delete");
  assert.deepEqual(h.seen.fetches[0].body, { project: "demo", path: "/r/.worktrees/a", branch: "wtgui/a" });
});

test("a keep call writes nothing at all, and takes its row off the list", async () => {
  const h = harness();
  await h.runCleanupChip("demo").catch(() => {});
  const button = { dataset: { cleanupProject: "demo", cleanupPath: "/r/.worktrees/b" }, disabled: false, textContent: "keep" };
  const before = h.seen.fetches.length;
  await h.answerCleanupCall("keep", button);
  assert.equal(h.seen.fetches.length, before, "keep must not talk to the server");
});

test("the bar draws one row per worktree, each with its call as a button and the report's own link", async () => {
  const h = harness({
    answer: () => ({
      body: {
        ok: true,
        dryRun: true,
        plan: PLAN,
        report: { path: "docs/reports/worktree-cleanup-2026-11-14-0930.html", absPath: "/repos/demo/docs/reports/worktree-cleanup-2026-11-14-0930.html" },
      },
    }),
  });
  // Nothing has been read yet, so there is no bar to draw.
  assert.equal(h.cleanupOf("demo"), null);
  assert.equal(h.cleanupBarHtml("demo"), "", "an empty state draws no bar at all");

  await h.runCleanupChip("demo");
  const bar = h.cleanupBarHtml("demo");
  assert.match(bar, /data-cleanup-bar="demo"/);
  // One row per worktree, including the skipped primary checkout.
  assert.equal((bar.match(/<div class="cleanup-row"/g) || []).length, PLAN.rows.length, "one row per worktree");
  // The drop call carries everything the panel's delete route needs: project, tree path and branch.
  assert.match(
    bar,
    /class="cleanup-call is-drop" data-cleanup-call="drop" data-cleanup-project="demo" data-cleanup-path="\/r\/\.worktrees\/a" data-cleanup-branch="wtgui\/a"/,
  );
  // The plan's keep calls are buttons too, and they name no branch: keep writes nothing at all.
  assert.equal((bar.match(/data-cleanup-call="keep"/g) || []).length, 2, "the merge row and the skipped row both read keep");
  for (const verdict of ["remove", "merge", "skip"]) assert.match(bar, new RegExp(`cleanup-verdict v-${verdict}`));
  // The merge row shows the child it would land in, and the line says the run has not touched anything yet.
  assert.match(bar, /data-cleanup-open="demo"/, "the page the run wrote is reachable from the bar");
  assert.match(bar, /docs\/reports\/worktree-cleanup-2026-11-14-0930\.html/);
  assert.match(text(bar), /1 to drop, 1 to merge, 0 kept, 1 left alone - nothing has been touched yet/);
  // A keep call takes its row off the list and never talks to the server.
  const keep = { dataset: { cleanupProject: "demo", cleanupPath: "/r/.worktrees/b" }, disabled: false, textContent: "keep" };
  const before = h.seen.fetches.length;
  await h.answerCleanupCall("keep", keep);
  assert.equal(h.seen.fetches.length, before, "keep must not talk to the server");
  assert.equal((h.cleanupBarHtml("demo").match(/<div class="cleanup-row"/g) || []).length, PLAN.rows.length - 1);
});

test("an apply whose row failed puts the chip in the error state and names the tree that failed", async () => {
  // The route answers 200 for a run in which one row refused: the counts carry `failed`. The chip must not read that
  // as done - the repo that failed is the row's tree, and its reason is the tooltip.
  const h = harness({
    answer: (n) =>
      n === 1
        ? { body: { ok: true, dryRun: true, plan: PLAN, report: { path: "p1", absPath: "/repos/demo/p1" } } }
        : {
            body: {
              ok: true,
              dryRun: false,
              plan: PLAN,
              run: {
                rows: [
                  { ...PLAN.rows[0], result: { acted: false, ok: false, why: "an agent is running in that worktree (job-9)" } },
                  { ...PLAN.rows[1], result: { acted: true, ok: true, why: "merged --no-ff into cleanup/wtgui-b" } },
                ],
                counts: { remove: 1, merge: 1, keep: 0, skip: 0, failed: 1 },
              },
              report: { path: "p2", absPath: "/repos/demo/p2" },
            },
          },
  });
  await h.runCleanupChip("demo");
  await h.runCleanupChip("demo");
  const chip = h.cleanupChipHtml("demo");
  assert.equal(text(chip), "cleanup failed: a", "the label names the tree that failed, not the project");
  assert.match(chip, /is-error/);
  assert.match(title(chip), /an agent is running in that worktree \(job-9\)/);
  assert.match(h.seen.banners.join(" "), /1 failed/);
});

test("a run whose report could not be written says so instead of opening nothing", async () => {
  const h = harness({
    answer: () => ({
      body: { ok: true, dryRun: true, plan: PLAN, report: { path: null, absPath: null, bytes: 0, error: "could not write /repos/demo/docs/reports/x.html: EPERM" } },
    }),
  });
  await h.runCleanupChip("demo");
  assert.equal(h.seen.opened.length, 0, "there is no page to open");
  assert.match(h.seen.banners.join(" "), /report was not written - could not write/);
});
