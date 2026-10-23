// Which turn owns which subagent chip.
//
// The children carry only their parent thread, so the card attributes them by the clock: the turn whose window holds
// the moment a child started. A turn that was interrupted never wrote an endedAt, and the first version read that as
// "still open until now" - so on a five-turn card the five reviewers a LATER turn delegated were filed under turn 1,
// whose only job had been to rename a branch. This replays that card, then the edges: a child during the first turn, a
// child after the last turn ended, clock skew at a boundary, and a thread with one turn.
//
//   node tools/verify-subagent-turns.mjs
import { readFileSync } from "node:fs";

// The attribution is pure and lives in public/app.js (a plain browser script, so it cannot be imported): read the
// shipped source out of the file between its markers rather than copying it here, so this test tracks what ships.
const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const begin = src.indexOf("// ---- subagents: attribution");
const end = src.indexOf("// ---- end attribution");
if (begin < 0 || end < 0) {
  console.error("public/app.js no longer has the attribution markers this test reads");
  process.exit(2);
}
const code = src.slice(src.indexOf("\n", begin) + 1, end);
const childOwner = new Function(`${code}; return childOwner;`)();

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
};

// ── the card from 2026-10-23, as it sat in the store ────────────────────────────────────────────
// Turns 1-3 were interrupted by a panel restart and have no endedAt at all; turn 5 is the one that ran delegate_task.
const T = (s) => Date.parse(s);
const turns = [
  { id: "t1", turn: 1, startedAt: "2026-10-23T21:24:25.268Z", endedAt: null, status: "interrupted" },
  { id: "t2", turn: 2, startedAt: "2026-10-23T21:37:44.681Z", endedAt: null, status: "interrupted" },
  { id: "t3", turn: 3, startedAt: "2026-10-23T21:44:27.936Z", endedAt: null, status: "interrupted" },
  { id: "t4", turn: 4, startedAt: "2026-10-23T23:08:07.865Z", endedAt: "2026-10-23T23:08:37.424Z", status: "done" },
  { id: "t5", turn: 5, startedAt: "2026-10-23T23:13:47.349Z", endedAt: "2026-10-23T23:14:34.625Z", status: "done" },
];
// The five reviewers, from sessions where parent_session_id was this thread (started_at 1792797270.9 = 23:14:30Z).
const children = ["email-core", "queue", "email-lib-immediate", "test-suite", "docs"].map((goal, i) => ({
  id: `s${i}`,
  goal,
  running: i > 1,
  startedAt: T("2026-10-23T23:14:30.842Z") + i * 12,
  endedAt: i > 1 ? null : T("2026-10-23T23:16:06.485Z"),
}));

const owners = childOwner(children, turns);
const under = (id) => (owners.get(id) || []).map((c) => c.goal);
check("the delegating turn owns all five", under("t5"), children.map((c) => c.goal));
for (const id of ["t1", "t2", "t3", "t4"]) check(`${id} owns none of them`, under(id), []);

// ── a child that really did start during the first turn stays there ────────────────────────────
const early = { id: "e1", goal: "early", startedAt: T("2026-10-23T21:30:00Z") };
const withEarly = childOwner([early, ...children], turns);
check("a child during turn 1", (withEarly.get("t1") || []).map((c) => c.goal), ["early"]);
check("...and turn 5 still has its own", (withEarly.get("t5") || []).length, 5);

// ── a child of the last turn that started after that turn finished (parent left early) ────────
const late = { id: "l1", goal: "late", startedAt: T("2026-10-23T23:14:40Z"), running: true };
check("a child after the last turn ended stays with it", (childOwner([late], turns).get("t5") || []).map((c) => c.goal), ["late"]);

// ── clock skew: a child stamped 1.5s before the turn that started it ──────────────────────────
const skewed = { id: "k1", goal: "skewed", startedAt: T("2026-10-23T23:13:45.8Z") };
check("skew at a boundary goes to the newer turn", (childOwner([skewed], turns).get("t5") || []).map((c) => c.goal), ["skewed"]);

// ── a child of a middle turn is not stolen by the newest one ──────────────────────────────────
const mid = { id: "m1", goal: "mid", startedAt: T("2026-10-23T21:50:00Z") };
check("a child during turn 3 between two interrupted turns", (childOwner([mid], turns).get("t3") || []).map((c) => c.goal), ["mid"]);

// ── one turn, no end: everything on that thread is its own ────────────────────────────────────
const solo = [{ id: "only", startedAt: "2026-10-23T21:00:00Z", endedAt: null }];
check("one running turn owns everything", (childOwner(children, solo).get("only") || []).length, 5);

// ── a child older than every turn still lands somewhere: the first turn, not nothing ──────────
// A card adopted from a store that has already pruned the turn that delegated cannot show the child under a turn it
// no longer has; the oldest turn it does have is the least misleading place for it.
const before = { id: "b1", goal: "before", startedAt: T("2026-10-23T20:00:00Z") };
check("a child older than every turn goes to the first", (childOwner([before], turns).get("t1") || []).map((c) => c.goal), ["before"]);

// ── an empty roster is not an owner ───────────────────────────────────────────────────────────
check("no children, no owners", childOwner([], turns).size, 0);

console.log(failed ? `RESULT: ${failed} FAILED` : "RESULT: ALL PASS");
process.exit(failed ? 1 : 0);
