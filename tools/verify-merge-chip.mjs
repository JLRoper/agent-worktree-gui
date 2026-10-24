// The UNMERGED chip is the merge control, and "only when the tree is clean" is the rule the whole feature rests on:
// an agent that starts on a dirty tree commits somebody else's unfinished work. This replays the decision table out of
// the shipped `verdictHtml` (read from public/app.js between its markers, not copied here) so the rule cannot drift.
//
//   node tools/verify-merge-chip.mjs
//
// The colour class comes from the panel's existing verdictClass(); this stubs its rule and asserts the chip's own
// classes, the tag, the disabled state and the data attributes the pointerup handler reads.
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const begin = src.indexOf("// ---- merge control: the UNMERGED chip");
const end = src.indexOf("// ---- end merge control");
if (begin < 0 || end < 0) {
  console.error("public/app.js no longer has the merge-control markers this test reads");
  process.exit(2);
}
const code = src.slice(src.indexOf("\n", begin) + 1, end);

const state = { projects: new Map(), jobs: new Map(), rows: new Map() };
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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

const { verdictHtml } = new Function(
  "state",
  "esc",
  "keyOf",
  "verdictClass",
  "agentsFor",
  "convLive",
  `${code}; return { verdictHtml, mergeAgentLabel, baseBranchOf };`,
)(state, esc, keyOf, verdictClass, agentsFor, convLive);

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
  check("…naming the base branch in its tooltip", has(html, "merges feat/x into main"), true);
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
  agents.set(
    "c:/trees/wt",
    [{ thread: "t1", turns: [{ id: "j1", status: "running" }], latest: { label: "MERGING into MAIN" } }],
  );
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
  check("a master project's tooltip says master", has(html, "into master"), true);
  check("…and never claims main", has(html, "into main"), false);
  state.projects.delete("old");
}

// ── a row whose project is unknown falls back to main rather than inventing a branch ──────────
{
  const html = verdictHtml(row({ project: "missing" }));
  check("no project meta falls back to main", has(html, "into main"), true);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
