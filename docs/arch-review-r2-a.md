# R2-A — adjudicating r1-a (top-down) against r1-b (coupling and churn)

Round 2, draft A. I wrote `r1-a.md`; this is not a defence of it. Where r1-b is right I say so and drop my
claim. Where I keep mine I give the measurement that decides it.

**Everything below was re-measured on a 0.85.3 tree whose base is `97b17e1`** (the commit that carries r1-a is
`6d5d98d`), not copied from either draft. r1-a was measured at `cc61bb9`; r1-b was too. Every line number and
byte count in §4 is relative to that 0.85.3 snapshot.

`origin/main` has moved since, to 0.87.0, and it moved `public/app.js` (+84 lines), `server.js` and
`lib/assistant.js` while this round was being written. That is not a footnote to §4 — it is §4 happening in real
time, and it is the reason the merged document must cite versions and never bare line numbers. No source file
was touched in this round.

Where I re-ran r1-b's own method I say so, so the agreement is checkable rather than polite:

| r1-b's number (its window) | my re-run, my window | verdict |
|---|---|---|
| `package.json` in 120/200 commits | **124/200** | reproduces (±4) |
| four files = 46% of source touches | **45%** (121/267) | reproduces |
| 85% of source commits touch one of the four | **85%** (85/100) | reproduces exactly |
| 45 of 83 modules have in-degree 1 | **45 of 85** | reproduces exactly |
| 32 imported only by `server.js` | **32 of 85** | reproduces exactly |
| 0 SCCs in the ESM graph | **0 of 85** | reproduces |
| pair-collision 37% at K=12, 31% at K≥16 | **39% / 36% / 28%** (K=12/16/24) | reproduces |

Its churn and degree numbers are sound. I could not reproduce two things: its `lib/` totals (83 files / 32,581
lines — I measure 84 / 32,947 at the same commit) and its "143 marker boundaries" (141 `// ----` markers at
`cc61bb9`). Its *ranks* are usable; its *totals* are not. That matters in §4.

---

## 1. The cycle claim — two graphs, and one label each

**Verdict: r1-b is right about the client and I am right about the server, and the sentence "the tree has no
cycles" is false. Neither claim may travel to the other half.**

They are not two readings of one graph. They are two graphs that share a file list:

| | r1-a's claim | r1-b's claim |
|---|---|---|
| Graph | **ESM imports**, `server.js` + 84 `lib/` files | **name references** between 16 classic scripts |
| Edge means | `import … from "…"` (a loader dependency) | file A mentions a top-level name declared in B |
| Nodes / edges | 85 / 187 | 16 / 34 (file-level) |
| Cycles | **0 SCCs larger than one node** | **1 SCC of 9 files** |
| Depth | 6 from `server.js` | not applicable (no layering exists) |

I re-ran the client measurement with comments stripped and SCCs computed properly, because r1-b's prose
("the rest is a cycle") and its table (which counts *readers of app.js*, not cycle members) disagree:

**The client's cyclic core is 9 of 16 files:** `app.js`, `core/dom-format.js`, `core/console-format.js`,
`core/console-markdown.js`, `core/sse.js`, `core/transport.js`, `board/attachments.js`, `board/hot.js`,
`board/paste-chips.js`. Every one of those is both above and below `app.js`.

**Seven files are outside the cycle** (`model-menu`, `stream-merge`, `liveness`, `steerable`, `type-stream`,
`update-check`, `assistant`): they read `app.js` and nothing reads them. r1-b's list of twelve readers includes
four that are not in the cycle (`update-check`, `model-menu`, `liveness`, `steerable`), so "the rest is a cycle"
overstates the cycle and understates the leaves. The corrected
statement is: *nine files are a cycle, seven are consumers or leaves, and the layering that `index.html`'s
script order implies does not exist in the 9.*

And the sentence that must not be written anywhere: **"the tree has no import cycles" is true of `lib/` and
false of the product.** The correct pairing, which I am adopting into the merged text:

> `lib/` is acyclic (0 SCCs, depth 6) — the server split untangles nothing. The client is not: nine classic
> scripts form one name-reference cycle around a single mutable `state`, and the load order is the only thing
> that makes it executable.

Why this is not pedantry: the two have opposite implications. An acyclic graph means a cut can be made at any
edge and the only cost is wiring. A cyclic graph means every cut leaves a back-reference that must survive as a
page global — which is exactly the 913-bare-`esc` problem in my draft and the 78-name surface in r1-b's.

**One correction to my own r1-a:** the bullet "85 modules, 187 internal edges, 0 import cycles" was scoped
correctly in §3.2 but scoped too loosely in the summary bullet, where a reader can carry it out of the
document. That is a real defect in my draft and r1-b's framing fixes it.

---

## 2. What a cut buys and what it costs — one statement, both numbers

r1-b's positional ceiling and my "every boundary is a cut you choose and pay for" are the same trade measured
on two axes, so I put both axes on the same cuts. I re-derived the K-curve (80 `app.js` commits, each hunk
bucketed by its own revision's length, so drift cannot contaminate it) and added the surface cost of the *same*
K equal-line cuts:

| parts K | pair-collision | commits in one part | names published across the boundary |
|---:|---:|---:|---:|
| 2 | 82% | 60% | 269 |
| 4 | 60% | 55% | 346 |
| 8 | 47% | 38% | 449 |
| 12 | 39% | 33% | 469 |
| 16 | 36% | 29% | 515 |
| 24 | 28% | 28% | 546 |

Then the same two axes on a *hand-placed* partition — the six responsibility ranges from r1-a plus the hub
remainder, deliberately non-uniform, boundaries at `9718`, `6624`, `7192`, `1517`, `11553`, `18376`:

| partition (7 parts) | pair-collision | commits in one part | names published |
|---|---:|---:|---:|
| six responsibility ranges + hub | **56%** | 45% | **320** |
| equal-line K=7 | **51%** | 43% | **444** |

The hand-placed boundaries are *worse* on collision and *28% cheaper* on surface. That is the whole argument in
one row, and it is the opposite of what either draft assumed.

**The one costed statement:**

> A cut buys the commits that stop sharing a file and costs the names that must stay visible across the new
> boundary; collision relief is bought by the **number** of parts (100% → 39% at K=12 → 28% at K=24) and is
> nearly independent of **where** the boundary falls (equal-line K=7 is 51% against 56% for a hand-placed
> partition), while surface cost is bought by **where** it falls (444 names equal-line against 320 hand-placed
> at the same K=7, a 28% saving) — so boundary choice is a cost decision, part count is a benefit decision, and
> the two are separable.

Consequences, and one of them costs me my own ordering:

- **"Split into more files" has a knee at K≈12, and it is in the marginal rate, not the total.** From K=8 to
  K=12, 8 points of collision relief cost 20 published names — 40 points per 100. From K=12 to K=24, 11 points
  cost 77 names — 14 per 100. Same direction, a third of the rate, which is why "more files" stops being the
  lever. r1-b's "stops improving past 16" is the same knee seen from one axis.
- **A good boundary is worth 28% of the boundary width and ~0 collision.** So a boundary should be chosen to be
  cheap (few names leaving), never sold as a contention fix. My r1-a's ranking by "lines per exported name" was
  the right instrument for the wrong reason: it measures cost, and I implied it measured benefit.
- **The benefit is real but bounded.** Even at K=24, 28% of commit pairs still share a file. No partition of
  this file by line gets below roughly a quarter, which is why the argument has to move to ownership
  (§5) and not to geometry.

---

## 3. The landing-concurrency rule: `package.json` is the lock

r1-b's 120/200 and my 124/200 are the same fact: **the one file every parallel worker must touch is three lines
of a monotonic counter.** The pre-push hook (`.githooks/pre-push`, which runs `tools/version.mjs check`) refuses
a branch that carries commits without a bump, and `docs/versioning.md:56-61` makes even a doc a patch. So the
bump cannot be avoided, only placed.

**The rule I would write into the plan:**

> Landing concurrency is **1**, and `package.json` is the lock. Bump on the landing tip, in the landing commit,
> after the rebase — never at branch cut. A branch that carries a bump taken from its cut is a guaranteed
> conflict for whoever lands next, and every branch is the next landing. Serialize on the bump, not on the code.

I have a live demonstration from this round. My round-1 branch was cut at 0.84.0 and bumped to **0.84.1** in the
same commit as the document. Main moved to 0.85.2 while the PR was open; the PR came back **CONFLICTING** on
`package.json` alone, with the document merging cleanly. The fix was a rebase and a re-bump to **0.85.3** — one
extra conflict resolution, on one file, for one PR. That is the *exact* cost, and at 124/200 commits the repo
pays it constantly.

Three corollaries that follow from the measurement rather than from taste:

- **The bump is a rebase-time edit, not a commit-time edit.** The round-1 commit message says "the patch bump a
  doc owes"; that sentence was true and still caused a conflict. The bump belongs in the commit that is
  *about to be pushed onto the current tip*.
- **Two landings cannot be truly parallel.** A module split changes what conflicts, never whether the landing
  serializes. Any parallelism plan that does not say "one landing at a time, bump last" is describing a
  different repository.
- **The version is read once, at boot** (`server.js:132` at this tip; `:129` at `cc61bb9`), so a stale version is
  not a running-process bug; it is a board-config-line bug. That is why the rule can be "bump at landing"
  without a restart story.

---

## 4. The drift, stated once, and what a reader can still trust from r1-b

r1-b measured at `cc61bb9` (0.84.0) and flagged that `origin/main` was then 6 commits ahead. Since then main
landed 8 more commits and my round-1 branch became PR #303 (still open, unmerged); the tip I measured is
`6d5d98d` (0.85.3). The drift is small but it is exactly the kind that invalidates line numbers:

| | `cc61bb9` (r1-b) | `6d5d98d` (now) | drift |
|---|---:|---:|---|
| `public/app.js` | 21,367 | 21,642 | **+275** (+1.3%) |
| `// ----` markers in it | 141 | 143 | +2 |
| `server.js` | 5,343 | 5,425 | **+82** |
| `if (route ===` branches | 122 | **126** | +4 |
| `public/style.css` | 3,761 | 3,763 | +2 |
| `lib/assistant.js` | 5,192 | 5,192 | 0 |
| `lib/` modules | 84 (`.js`) | 85 | +1 (`provider-profiles.js`) |
| `package.json` | 0.84.0 | 0.85.3 | +3 patches |

The drift is not uniform, which is the trap: the settings region moved **+56** lines while the region around
`sse.js` moved **+2**, because 0.85.0's Settings → Gateway feature inserted UI where it lives. I hit this myself
in this round — re-running my own A-range surface measurement with `cc61bb9`'s line numbers gave **35** names for
the settings region instead of **9**, purely from drift. Re-locating the range by marker text restored 9. So:

**What a reader can still trust from r1-b:** every ratio and every rank. The degree counts (45 modules
in-degree 1, 32 server-only, 12-module spine) reproduce *exactly* on a later tip; the co-change clusters
(A: board chrome, B: assistant vertical) are stable; `package.json` ≈60%; the four-files-46% and 85% figures;
the K-curve shape; 0 SCCs in the ESM graph. Use all of these.

**What a reader must not trust:** any absolute line number in it (off by 2 to 275), its "122 branches" (now
126), its "143 marker boundaries", its `lib/` totals, its singleton line citations in §5.3 (they point at
comment lines now — `store` is `:360`, `jobs` `:478`, `approvals` `:546`, `remoteWrites` `:712`, `locks`
`:757`), and its `app.js:20903` for the duplicate `fmtBytes` (now `:21162`). Its 78-name client surface is an
*upper bound*: with comments and strings stripped I measure **66**. Its own §7 says exactly this, so this is a
confirmation, not a correction.

**The one number of its own that r1-b should have flagged harder:** the window is 49 hours and 37 releases.
Every "untouched" in cluster D means "untouched this weekend". r1-b says so in §7 and then leans on it in S5
("leave the substrate") — see §7 below.

---

## 5. The merged seam list I would sign

Ordered by *contention removed per unit of risk*, which is r1-b's axis, with r1-a's surface cost attached. This
is the list I would put my name to. "Surface" is r1-a's measure: names defined inside the cut and read outside.

| # | Cut | Lines | Surface | Source | Why this position |
|---|---|---:|---:|---|---|
| 1 | **`server.js`: helpers out, routes out — one serialized PR** | 3,215 route lines + 44 header fns | — | **both** | The only cut that removes a *cross-workstream* collision: both clusters pass through this file (12 + 12 shared commits). r1-b's hunk data adds the half my draft missed: 51 of 92 hunks land in the 2,057-line header, not in the routes, so a routes-only PR would leave the file churning. Do both, once, by one agent — the groups are interleaved (worktree 2,662–4,915 with assistant inside it), so a second pass rewrites the same lines. |
| 2 | **`app.js` A1 settings** → `features/settings-*.js` | 3,179 (2,964 at `cc61bb9`; 0.85.0's Settings → Gateway panel added the rest) | **9** | r1-a | The lowest surface in the file — 9 names, against 12 for the model picker and 15 for the dock — for 3,179 lines: 353 lines per published name, the best ratio anywhere in `app.js`. Zero `state` writes at load; its 96 boot statements stay behind. It is a vertical (the settings panel's state, painters and handlers), not a layer. |
| 3 | **`style.css` moves with `app.js`, not after it** | 3,763 total | — | **r1-b** | I had this at step 6; the 38 commits it draws (23 of them with `app.js` in my window; r1-b measured 36 and 21) make it co-equal. Splitting `app.js` and leaving one stylesheet just relocates the UI collision. The `as-*` block (247 of 248 rule lines contiguous) is the first slice. |
| 4 | **`app.js` A5 dock** (approvals + remote writes) | 568 | 15 | r1-a | Small, coherent, one vocabulary, and its server half already exists (`lib/approvals.js`, `lib/remote-writes.js`). Cheapest *whole feature* in the file. |
| 5 | **`public/assistant.js` sections** (pipeline window 458, queue tab 732, messages 197) | 1,387 | 3 globals | r1-a | Already private inside an IIFE; only `applyAssistant` and two test hooks must survive. |
| 6 | **`app.js` A4 console, then A3 conversations** | 1,165 / 3,570 | 36 / 69 | r1-a | The console is where the type pacer and `state.type*` wiring live (12 of its 14 top-level statements write `state`), so it is not a cheap cut; the conversations block is 130 `state` reads. Both after the cheap verticals. |
| 7 | **`lib/assistant.js` rules engine** (`evaluate` + `fired` + `checkWatches` + `checkExit`) | 674 | 12 fields | r1-a | **Demoted.** r1-b is right that this is not a contention fix (74% collision at K=12, the worst of the four). It stays on the list for *testability* — a pure decision over (jobs, settings, rules) — and belongs after the contention work, not before it as my r1-a ordering had it. |
| 8 | **`app.js` A2 chart/ranking** | 3,716 | 59 (+76 deps) | r1-a, last | Still the worst cut: 9 of its 10 heaviest dependencies are the scroll/caret protocol. Only after that protocol is extracted as one unit. |

**What I drop from r1-a:** the ordering. My draft put `lib/assistant.js`'s rule engine at step 2 because it is
the cleanest *extraction*; on the contention axis it is step 7. Both statements are true of different
objectives, and a plan has to pick one. The plan picks contention, because that is the reader's complaint.

**What I add that neither draft has:** `server.js` must be cut **once**, in a single serialized PR that does
helpers *and* routes. r1-b says "do the route extraction as one serialized change"; its own hunk data says the
header is where the churn is. Those two together are one PR, not two.

---

## 6. Vertical or layer — the verdict

**Verdict: vertical, but nobody has measured one, including me.**

The recommendation is r1-b's and I sign it. The *evidence* for it is weaker than either draft implies, and the
merged document should say so.

- r1-b's K-curve cuts at **contiguous marker boundaries**. Every one of those cuts is horizontal by
  construction — it takes a run of lines, not a feature.
- My A1–A6 are **also contiguous ranges**. I chose their edges by responsibility, but the thing I measured was
  still "a band of lines".
- A true vertical — a feature's state, its renderer and its handler pulled out of line 1,000 and line 20,000
  into one file — was measured by neither of us. r1-b's hunk evidence (a median `app.js` commit edits 3 of 143
  sections) is the *reason to expect* it to win; it is not a measurement that it does.

What my numbers do establish is narrower and still useful: **the hand-placed boundary is 28% cheaper in surface
than an equal-line one at the same part count** (320 vs 444 names at K=7). That is the measurable advantage of
choosing boundaries by responsibility — a cost advantage, not a collision one. So the merged verdict is:

> Cut vertically, because the unit of work is vertical — but sell it on cost, not on collision. A vertical
> boundary publishes ~28% fewer names than an equal-line one; the collision relief comes from the number of
> parts, and it floors at roughly a quarter of commit pairs no matter how the file is cut.

And one thing the vertical recommendation collides with, which neither draft connected: **the 14 test files that
slice `app.js` are section-shaped.** `sliceRegion(src, "name")` reads from `// ---- name` to `// ---- end name`.
A vertical cut crosses three sections, so a vertical move needs *three* marker pairs to travel and the test's
slice to be re-pointed at three files (or at the one new file that now holds all three). r1-b's §5.1 mitigation
— "the marker pair travels with the code and only the path changes" — is true for a section move and false for a
vertical one. That is the real cost of the vertical, and it is the reason my step 2 above is A1 (whose range is
almost exactly one section) rather than a genuine vertical: the cheap surface and the test-shaped boundary
coincide there, and nowhere else in the file.

---

## 7. What I will not concede

1. **That a vertical split buys collision relief.** Neither draft measured one. At the same part count, my
   responsibility-aligned contiguous partition is *worse* on collision than an equal-line cut (56% vs 51%) and
   better only on surface (320 vs 444 names). The vertical hypothesis is plausible and unproven; it must not be
   written as a finding.
2. **That `public/core/dom-format.js` is "the only genuine leaf" and a cut point.** It is inside the 9-file
   cycle — it reads `state`, `normPath`, `panelFor` and `isRowLive` back out of `app.js`
   (`core/dom-format.js:38,94,95,112`), which its own header declares. And it is *already extracted*: 183 lines,
   in its own file, since the M2 move. There is nothing left to cut. Its real property is that it is the
   **cheapest member of the cycle** (4 back-edges, 5 names), which is a different claim and a more useful one.
3. **That cluster D's silence is health.** 50 of 83 modules untouched in 49 hours and 37 releases proves they
   are not where *this weekend's* contention is; it cannot prove they are sound. r1-b says this in §7 and then
   uses it as "leave the substrate" in S5. As a contention statement I agree and I sign it; as an architectural
   verdict I do not, and the merged text should carry the qualifier.
4. **That the 78-name client surface is a number.** It is 66 with comments and strings stripped and 78 with them
   counted. Both are true of different questions; the plan needs the lower one (what must remain callable) and
   the upper one is a mention count.

**What I concede, plainly.** The client cycle is r1-b's finding and it is better stated than mine. The
`package.json` landing lock is r1-b's and it is the most operationally useful thing in either draft. The
`fmtBytes` duplicate — `core/dom-format.js:171` (KB/MB only) against `app.js:21162` (B→TB, `"0 B"` for zero) —
is r1-b's, is real, and is the sharpest single hazard in a client split: I measured the two implementations, and
they disagree at every magnitude (`0` → `1 KB` vs `0 B`; `500` → `1 KB` vs `500 B`; `1536` → `2 KB` vs
`1.5 KB`; `3 GiB` → `3072.0 MB` vs `3.0 GB`). Any move that makes a call site resolve to the other declaration
changes every byte figure in the UI with no test failure. My extraction order was wrong about where to start;
r1-b's contention order is right.

---

## 8. Limits of this adjudication

- I re-ran r1-b's method, not its scripts; where we differ on 200-commit windows (2 hours apart, 8 commits) I
  say so at each number rather than averaging.
- The K-curve buckets each hunk by its own revision's line count, so drift cannot move a hunk between regions
  in *relative* terms; absolute region identity still drifts and I do not use it.
- The responsibility partition is contiguous ranges, which is the same shape as r1-b's cuts — see §6. A true
  vertical remains unmeasured by both drafts.
- No source file was modified in this round either.
