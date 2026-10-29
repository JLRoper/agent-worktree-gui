// The UNMERGED chip is the merge control, and "only when the tree is clean" is the rule the whole feature rests on:
// an agent that starts on a dirty tree commits somebody else's unfinished work. This replays the decision table out of
// the shipped code (read from public/app.js between its markers, not copied here) so the rule cannot drift.
//
//   node tools/verify-merge-chip.mjs
//
// Two halves:
//   - verdictHtml: the chip, its classes, its disabled states and the data attributes the pointerup handler reads;
//   - openMergeChooser: the five outcomes it offers. The fourth is the CHECKING agent, which is read-only in both
//     branches and ends in the tree going to the Recycle Bin when the answer is yes - so the popover has to SAY that,
//     and the button has to name the project's own base branch rather than a hardcoded "main". The fifth is the
//     REBASE, the one outcome that is a plain git command: it has to name the ref it would replay onto (the recorded
//     parent, else the base ref) and say that it writes only this branch.
//
// The colour class comes from the panel's existing verdictClass(); this stubs its rule and asserts the chip's own
// classes. The DOM the chooser touches is stubbed to exactly what it uses (createElement, appendChild, a null chip),
// so no browser is needed to prove the markup.
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const begin = src.indexOf("// ---- merge control: the UNMERGED chip");
const end = src.indexOf("// One click, one outcome. Nothing here runs on the press that opened the chooser.");
if (begin < 0 || end < 0 || end < begin) {
  console.error("public/app.js no longer has the merge control + chooser markers this test reads");
  process.exit(2);
}
const code = src.slice(src.indexOf("\n", begin) + 1, end);

const state = { projects: new Map(), jobs: new Map(), rows: new Map() };
const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const keyOf = (project, p) => `${project}::${p}`;
const verdictClass = (v) => {
  const s = String(v || "").toLowerCase();
  if (s.startsWith("unmerged")) return "unmerged";
  if (s.startsWith("merged")) return "merged";
  if (s.startsWith("on main")) return "onmain";
  return "nocommits";
};
const agents = new Map();
const agentsFor = (row) => agents.get(String(row.path).toLowerCase()) || [];
const convLive = (c) => (c.turns || []).some((t) => t.status === "running");

// The chooser is appended to the body and positioned against a chip; with no chip on this stubbed page it only has to
// build the element, and the element's innerHTML is the thing under test.
const made = [];
const el = () => ({
  className: "",
  dataset: {},
  style: {},
  innerHTML: "",
  offsetWidth: 300,
  offsetHeight: 180,
  setAttribute() {},
  remove() {},
});
const document = {
  createElement() {
    const node = el();
    made.push(node);
    return node;
  },
  body: { appendChild() {} },
  querySelector: () => null,
};
const window = { innerWidth: 1400, innerHeight: 900 };
const CSS = { escape: (s) => String(s) };

const { verdictHtml, mergeAgentLabel, baseBranchOf, mergeParentOf, mergeChooserTitle, checkAgentLabel, openMergeChooser, closeMergeChooser } =
  new Function(
    "state",
    "esc",
    "keyOf",
    "verdictClass",
    "agentsFor",
    "convLive",
    "document",
    "window",
    "CSS",
    `${code}; return { verdictHtml, mergeAgentLabel, baseBranchOf, mergeParentOf, mergeChooserTitle, checkAgentLabel, openMergeChooser, closeMergeChooser };`,
  )(state, esc, keyOf, verdictClass, agentsFor, convLive, document, window, CSS);

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
};
const tag = (html) => (/^<(\w+)/.exec(html) || [])[1] || null;
const has = (html, s) => html.includes(s);

state.projects.set("fixture", { name: "fixture", mainBranch: "main" });
const row = (over = {}) => ({
  project: "fixture",
  path: "C:/trees/wt",
  name: "wt",
  branch: "feat/x",
  verdict: "UNMERGED (2 commits)",
  dirty: 0,
  untracked: 0,
  verdictStale: false,
  ...over,
});

// ── a clean UNMERGED row is the button ──────────────────────────────────────────────────────────
{
  const html = verdictHtml(row());
  check("clean UNMERGED renders a button", tag(html), "button");
  check("…with the merged-action class", has(html, 'class="badge unmerged merge-start"'), true);
  check("…enabled", has(html, "disabled"), false);
  check("…carrying the row key the pointerup handler reads", has(html, 'data-merge-start="fixture::C:/trees/wt"'), true);
  check("…and the project + path for the POST", has(html, 'data-merge-project="fixture"') && has(html, 'data-merge-path="C:/trees/wt"'), true);
  check("…naming the check outcome in its tooltip", has(html, "have an agent check whether the change is already on main"), true);
  check("…and what that outcome costs", has(html, "this worktree goes to the Recycle Bin"), true);
  check("…and the glyph that says it is pressable", has(html, 'class="merge-glyph"'), true);
}

// ── a tree that is not clean is a statement, never a control ───────────────────────────────────
for (const [name, over, why] of [
  ["one modified file", { dirty: 1 }, "1 modified"],
  ["one untracked file", { untracked: 1 }, "1 untracked"],
  ["three of each", { dirty: 3, untracked: 2 }, "3 modified"],
]) {
  const html = verdictHtml(row(over));
  check(`${name} renders a span`, tag(html), "span");
  check(`…with no merge attributes at all`, has(html, "data-merge-start"), false);
  check(`…and a tooltip that says why (${why})`, has(html, why) && has(html, "button appears"), true);
}

// ── an agent already merging that tree: still a button, disabled, naming the agent ─────────────
{
  agents.set("c:/trees/wt", [
    { thread: "t1", turns: [{ id: "j1", status: "running" }], latest: { label: "MERGING into MAIN" } },
  ]);
  const html = verdictHtml(row());
  check("a live merge agent disables the button", has(html, 'class="badge unmerged merge-start is-merging"') && has(html, "disabled"), true);
  check("…and says who is working it", has(html, "MERGING into MAIN is working this tree now"), true);
  agents.clear();
}

// ── every other verdict keeps the plain badge ──────────────────────────────────────────────────
for (const verdict of ["MERGED (2 commits)", "MERGED (content identical)", "ON MAIN", "NO COMMITS", "EMPTY REPO", "NO BASE REF", "…"]) {
  const html = verdictHtml(row({ verdict, dirty: 0, untracked: 0 }));
  check(`"${verdict}" stays a span`, tag(html), "span");
  check(`…with no merge affordance`, has(html, "merge-start"), false);
}

// ── a stale verdict still offers the button: the route is what refuses a tree that moved ──────
{
  const html = verdictHtml(row({ verdictStale: true }));
  check("a stale UNMERGED row is still a button", tag(html), "button");
  check("…and says it is stale in its class", has(html, "stale"), true);
}

// ── a master repo names master, not main ──────────────────────────────────────────────────────
{
  state.projects.set("old", { name: "old", mainBranch: "master" });
  const html = verdictHtml(row({ project: "old", path: "C:/trees/old" }));
  check("a master project's tooltip says master", has(html, "already on master"), true);
  check("…and never claims main", has(html, "already on main"), false);
  state.projects.delete("old");
}

// ── a row whose project is unknown falls back to main rather than inventing a branch ──────────
{
  const html = verdictHtml(row({ project: "missing" }));
  check("no project meta falls back to main", has(html, "already on main"), true);
}

// ── the chooser: five outcomes, and the check is the one that says what it costs ──────────────
{
  const r = row();
  state.rows.set(keyOf(r.project, r.path), r);
  openMergeChooser(keyOf(r.project, r.path));
  const pop = made.at(-1)?.innerHTML || "";
  const choices = [...pop.matchAll(/data-merge-choice="([a-z]+)"/g)].map((m) => m[1]);
  check("the popover offers five outcomes, in order", choices, ["roll", "rebase", "pr", "check", "ask"]);
  check("…the check names the base branch", has(pop, ">Check whether it is on main<"), true);
  check("…and the note says the tree goes to the Recycle Bin", has(pop, "moves this worktree to the Recycle Bin"), true);
  check("…and that the branches are not written", has(pop, "writes nothing to either branch"), true);
  check("…and the check class is on its button", has(pop, "mc-choice is-check"), true);
  // The rebase: no parent recorded on this row, so the base ref is what it names — and it has to say it is mechanical.
  check("…the rebase names the base ref when no parent is recorded", has(pop, ">Rebase on main<"), true);
  check("…and its own class", has(pop, "mc-choice is-rebase"), true);
  check("…and it says it replays this branch's own commits", has(pop, "rebase replays this branch's own commits onto main"), true);
  check("…and that no agent is started", has(pop, "no agent, nothing else is written"), true);
  check("…and that a conflict aborts", has(pop, "a conflict aborts leaving the tree exactly as it was"), true);
  closeMergeChooser();
}

// ── a check already running: the button is disabled and says who ──────────────────────────────
{
  const r = row();
  state.rows.set(keyOf(r.project, r.path), r);
  agents.set("c:/trees/wt", [
    { thread: "t2", turns: [{ id: "j2", status: "running" }], latest: { label: "CHECKING MAIN" } },
  ]);
  openMergeChooser(keyOf(r.project, r.path));
  const pop = made.at(-1)?.innerHTML || "";
  const checkBtn = /<button[^>]*data-merge-choice="check"[^>]*>/.exec(pop)?.[0] || "";
  check("a live check disables its button", has(checkBtn, "disabled"), true);
  check("…and names the agent in its tooltip", has(checkBtn, "CHECKING MAIN is already reading this tree"), true);
  check("…while the merge outcomes stay available", /data-merge-choice="pr"(?![^>]*disabled)/.test(pop), true);
  check("…and the note repeats who is reading it", has(pop, "CHECKING MAIN is reading it now"), true);
  agents.clear();
  closeMergeChooser();
}

// ── a roll-up is still offered only for a recorded cut ────────────────────────────────────────
{
  const r = row({ branch: "feat/child", parent: "feature/turnover", parentSource: "cut" });
  state.rows.set(keyOf(r.project, r.path), r);
  openMergeChooser(keyOf(r.project, r.path));
  const pop = made.at(-1)?.innerHTML || "";
  check("a recorded cut offers the roll", has(pop, ">Roll into feature/turnover<") && !/is-roll"[^>]*disabled/.test(pop), true);
  // The rebase follows the same parent, and it is offered on a guess too: it writes only this branch, so a parent the
  // panel will not MERGE into is still a legal place to replay this one's commits onto.
  check("a recorded cut offers the rebase on that parent", has(pop, ">Rebase on feature/turnover<"), true);
  closeMergeChooser();
  const guessed = row({ branch: "feat/child", parent: "feature/turnover", parentSource: "backfilled" });
  state.rows.set(keyOf(guessed.project, guessed.path), guessed);
  openMergeChooser(keyOf(guessed.project, guessed.path));
  const pop2 = made.at(-1)?.innerHTML || "";
  check("a guessed parent draws the roll disabled", /is-roll"[^>]*disabled/.test(pop2), true);
  closeMergeChooser();
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
