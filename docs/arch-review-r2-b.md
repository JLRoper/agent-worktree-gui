# r2-b — adjudication of r1-a against r1-b

**Snapshot:** `cc61bb9`, same commit both drafts measured. `r1-a` = top-down by responsibility; `r1-b` (mine) =
bottom-up by coupling and churn. This document adjudicates four contested points, then names the seam list I would
sign, the one I would drop, and the one disagreement I will not concede.

**What I concede up front, so the rest reads cleanly.** Four of A's numbers beat mine, and I am replacing mine:

1. **187 internal edges, not 184.** My scrape was line-anchored and missed the two `;import` lines A found
   (`server.js:45`, `lib/jobs.js:52`), and my node set excluded `public/`, so the two `public/core/steerable.js`
   edges fell outside it. A's count is over the complete set; use 187.
2. **22 app.js names read by `sse.js`, not 23.** My 23rd was `dockGoto`, which appears at `sse.js:172` *only in a
   comment*. A's symbol-count is right; my textual count was inflated by one.
3. **123 branches / 48 left in `server.js`, not 122 / 47.** Mine counted only `if (route === …)`; A counts the
   `route.startsWith("/api/approvals/")` prefix branch too. Theirs is the correct denominator.
4. **75 branches to migrate, not 72** — but the correction runs the other way, and §3 shows why.

Everything else below is either confirmed independently or refuted with the measurement.

---

## 1. Two graphs, one word: "cycle"

The two claims do not conflict. They are about different graphs, and the word is doing damage in both directions.

| | A's claim | My claim |
|---|---|---|
| Graph | ESM import graph: `server.js` + 84 `lib/` files | browser global namespace: 16 classic scripts |
| Vertices / edges | 85 / **187** | 16 files / **78** distinct `app.js` names read elsewhere |
| Cycles | **0** (verified, DFS colouring; I re-verified with Tarjan: 0 SCCs, max depth 6) | **1 loop at call time** (`app.js` → `sse.connect()` → `app.js` names) |
| What breaks it | nothing needs to | load order, and only load order |

**Both measurements reproduce.** My Tarjan sweep independently returns 0 strongly-connected components and a maximum
depth of 6 from `server.js`. There is no import cycle to break on the server, and A is right that the extraction work
is not a cycle-breaking exercise.

**Is `sse.js` reading 22 `app.js` names a cycle?** No — it is a **namespace edge, bound late**. The evidence:

- All 22 reads are inside `connect()` (`public/core/sse.js:57–248`). Not one is at column 0.
- `sse.js`'s only top-level execution is two `function` declarations and two `window.WMApp` publication lines
  (`:38`, `:49`, `:57`, `:250–253`). Loading it executes nothing that touches a name it does not own.
- `connect()` is called by `app.js` (`:15,759`, `:21,349`), i.e. *after* every name it reads already exists.

So the dependency is: `sse.js` → (`app.js` names) **at call time**, and `app.js` → `sse.connect()` **at load time**.
That is a loop in a call graph and not a cycle in either load graph or import graph. My r1-b sentence "the client is a
cycle, not a layer" was the wrong word for the right observation: on the client there is no import graph at all, so
every edge is a late-bound name, and "cycle" should always be written as "call-time back-edge".

**What I keep from the claim, because A's own numbers support it:** the client's seams are cuts through a shared
namespace, not between modules. A measures 913 bare `esc(` call sites against one reader of `WMApp.core.domFormat`;
I measure 78 of 1,080 top-level names read across 12 files and 197 external `state.` property reads. Same structure,
two instruments. The namespace object exists and is unread — both of us say so; the difference is that A reads it as
"a promise the code has not kept", which frames a split as mechanical, and I read it as "the API is 78 names plus one
mutable object", which bounds what a split can achieve. §4 shows that bound biting.

**One overstatement in A worth flagging:** §3.2 says "the load order is the cycle-breaker, and it works only because
every back-edge is a call-time read." True of `sse.js`; not true of `dom-format.js`, which A lists with 4 back-edges
including `state` at `:112`. `dom-format` loads *first* of all 16 scripts, so it cannot be reading `state` at load
either — the mechanism is the same, but the ordering argument there is not "the cycle-breaker", it is "this file
executes nothing at load at all". Minor, but it matters for §2: the invariant is not "load order breaks cycles", it
is "no top-level statement may read a name another file provides", which is exactly the load contract.

---

## 2. The load contract does bound my clusters — but not where the churn is

I reproduced A's load numbers independently and they hold exactly:

- **222** column-0 executable statements in `public/app.js` (my scanner: no indent, not a declaration, not a comment).
- **24** of them assign a `state.*` property.
- The console region `7,190–8,355`: **14** top-level statements, **12** of them `state` writes — six
  `state.think*` initialisers at `:7,195–7,200`, then `state.typePacer` `:7,367`, `state.typeGate` `:7,370`,
  `state.thinkFed` `:7,381`, `state.reasoningReads` `:7,398`, `state.typeHold` `:7,451`, and
  `state.subConsolePinned` `:8,072`.

So the constraint is real and I adopt it as a hard rule: **a region carrying a top-level `state` write cannot be
loaded before `app.js`.** Now the part A did not measure, because it needs the churn: applied to my hot regions, the
constraint lands almost entirely on regions the churn does not care about.

| My hot region (hunks / 309) | Top-level stmts | `state` writes | Load-blocked? |
|---|---:|---:|---|
| `14,001–14,500` — chart columns, split width, column drag (**30**) | 2 | 0 | no |
| `17,501–18,000` — settings tail (**28**) | 10 | 0 | no |
| `10,001–10,500` — worktrees banner, remove, lock (**23**) | 0 | 0 | no |
| `6,001–6,500` — naming, add-agent field, previous turn (**21**) | 6 | 0 | no |
| `17,001–17,500` — settings rows (**20**) | 23 | 0 | no (wiring only) |
| `18,001–18,500` — settings tabs/search (**15**) | 4 | 0 | no |
| console `7,190–8,355` (A's A4) — 17 hunks, 5.5% | 14 | **12** | **yes** |

**Which of my seams cannot move first.** Exactly the verticals that own one of the 24 writes:

- *console / thinking* — `7,195–7,451` (11 of the console region’s 12 writes; the twelfth is `state.subConsolePinned` at `:8,072`), *cannot* be phase 1 or 2.
- *remote-write dock* — `6,682–6,685` (`state.rwPending/rwDecided/rwReviews/rwPolicy`), cannot move before `app.js`.
- *collecting results / sub-consoles* — `4,218`, `4,434–4,442`, `8,072`, same.
- *reply and previous turn* — `4,888` (`state.justSent`), same.
- *console input pinning* — `8,571` (`state.outPinned`), same.

Everything else in my list — S1 (`server.js` route groups), S3 (the assistant vertical as one owner), S4
(`dom-format` as the client's one real leaf), S5 (the `lib/` substrate) — is server-side or already a separate file,
and the client load contract does not touch it. **Exactly one of my seven proposals (S1–S5, R3, R4) is blocked by it
— R3, the `app.js` vertical split — and the block is not uniform inside R3:** two of the verticals it would create
are phase-3 only and the rest are clean.

**Two corrections to A's framing of the same fact.**

1. **"After `app.js` needs a third phase, which nothing else uses" is a one-line choice, not a constraint.** Two
   scripts already load after `app.js` (`core/update-check.js:733`, `assistant.js:736`); adding a third `<script>`
   line is the cheapest possible change, and it is the *correct* home for every region carrying a top-level `state`
   write. The contract is two-sided: **phase 1 (before `app.js`) = pure declarations; phase 3 (after) = anything that
   executes at load.** Stated that way, the 24 writes stop being a list of exceptions and become the definition of a
   phase the page already has two examples of.
2. **The console is the worst risk-to-value cut in the file, and the load contract is only half of why.** It carries
   **17 of 309 hunks (5.5%)** and is **1,166 of 21,368 lines (5.5%)** — perfectly average churn at maximal blast
   radius (the surface a reader stares at all day, 1 named section plus the copy-button anchor at its edge, and the
 type pacer). A says "the cut a reasonable person makes
   first"; the measurement says it is the cut that buys nothing first. That is a convergence, not a disagreement:
   we both say do not cut it first, and now there is a ratio behind it.

**The consequence for my cluster model.** My cluster A ("board chrome": `app.js` + `style.css` + `index.html`,
101 commit appearances) is not blocked *as an ownership rule* — no code moves — but the vertical cuts inside it are
now ordered by the table above: settings tail and chart first (load-clean), console and dock last (load-blocked,
phase 3). That is a real amendment to r1-b §4.2 R3, which named the hot regions without checking their load cost.

---

## 3. The router factory: adopted, with the count corrected and the other half named

A is right on the substance and I am adopting it: `createQueueRoutes`, `createPipelineWindowRoutes`,
`createPipelineCatalogueRoutes` are a proven idiom — deps as named arguments, `async (req, res, route, url) =>
boolean`, mounted in three lines at `server.js:2068–2074`. The route migration is a migration, not a design.

Three corrections, all measured.

**(a) The idiom is one-path RPC, not group dispatch — so the first group factory is an extension, not a copy.**
Each existing factory guards on a single path and dispatches on an `action` field in the body:

```
lib/assistant/queue.js:1196            if (route !== "/api/assistant/queue") return false;
lib/pipeline-window.js:212             if (route !== "/api/assistant/task-pipeline") return false;
lib/task-pipeline-assign.js:181        if (route !== "/api/assistant/pipeline-catalogue") return false;
```

Three factories, three paths, one dispatch shape. A route *group* has 13, 14, 23 paths and method variants, so
`lib/routes/worktree.js` needs a method+path table the existing three do not have. That is a small design decision,
and it should be made once, on the first group, with the other four copied from it — not improvised five times.

**(b) 75 to migrate, not 72.** The arithmetic matters because it changes what "already migrated" means. The three
factory paths do **not appear in the chain at all** (`/api/assistant/queue`, `/api/assistant/task-pipeline`,
`/api/assistant/pipeline-catalogue`: 0 occurrences of each as a `route ===` branch). They are intercepted before the
dispatcher, so they are not among the 75 branches in A's eight groups. The three are **precedent, not progress**:
75 branches remain, 48 stay in `server.js`, and the first extraction is the first one.

**(c) The plan fixes the smaller half of `server.js`, by churn.** I mapped every hunk in `server.js` over the
200-commit window to its band:

| Band | Lines | Hunks | Commits |
|---|---:|---:|---:|
| import block | 1–100 | **17** | 14 |
| header (config, object graph, 44 helpers, `broadcast`, boot pass) | 101–2,057 | **34** | 15 |
| route chain | 2,058–3,509 | 32 | 19 |
| tail (post-chain helpers) | 3,510–5,343 | 9 | 7 |
| **total** | | **92** | **30** |

**51 of 92 hunks (55%) are above the dispatcher**, and 14 of the 30 commits touch the import block — because adding a
module is how this file grows. The five factory extractions remove at most the chain's 32 hunks (35% — some of those
land in the 48 branches that stay) and *add* five lines to a block that 14 commits already edit. So: adopt step 4, and schedule the header extraction as its own step
(which A acknowledges in passing — "minus the 44 helpers that belong in `lib/` anyway" — but does not put in the
table). Without it, the file that is #4 by commits stays #4 by commits.

**Adopted cautions, made precise.**

- A's auth caution is correct, and the mechanism is narrower than stated: `authorised` is called once at
  `server.js:2061`, and the boot-pass flag `bootPassCanSatisfyReload = false` is set at `:2062–2064` — both *before*
  the factories mount at `:2068–2074`. A factory mounted at the same point inherits both. A factory hoisted out of
  the callback (or mounted above those two lines) silently loses them. That is the rule to write down: **mount point
  is part of the contract.**
- My interleaving caution stands and A's "one factory per PR" contradicts it. The 13 worktree branches span lines
  2,662–4,915 with the 23 assistant branches *inside* that span (2,369–2,661) and settings split across 2,105 and
  4,356. Five parallel PRs on the same chain conflict with each other; the extraction has to be one serialized
  gather, then five independent files afterwards. A's step 4 lists five modules in one row — which is the right
  *outcome* and the wrong *concurrency*.

So: **adopt the seam, correct the count to 75, add the header step, and serialize the gather.**

---

## 4. The marker API: which of my seams it forbids

The marker constraint is real and larger than A's number. Measured at `cc61bb9`:

- **19 files slice `public/app.js` through `sliceRegion`**, pinning **10 named sections / 850 lines**.
- **11 more** cut their own `indexOf` anchors on `// ----` text; one (`ahead-behind-cell.test.js`) does both, so
  **29 files pin `app.js`'s text**.
- **7 files slice `public/assistant.js`** — 4 sections: `the queue sub-tab` (733 L), `the float's two rows` (143 L),
  `the task pipeline window` (459 L), `dock width` (7 L).
- **0 files slice `server.js` or any `lib/` module by marker.** (My earlier "1" was a false positive: a harness
  fixture named `alpha`.)

A says "14 test files"; my 19/29 counts test *and* tool files and includes own-`indexOf` cuts. A's is a lower bound
on the same fact. Both conclusions hold: the markers are an API, and it is bigger than either number suggests.

**Which of my seams violate it.**

| Seam (r1-b) | Violates? | Why, measured |
|---|---|---|
| **R3 — `app.js` split by feature vertical** | **Yes** | 66 of 309 hunks (21%) land in regions that contain a pinned section: `14,001` (chart columns 13,988–14,106), `6,001` (previous turn 6,390–6,440), `18,001` (settings tabs 18,473–18,598 + search 18,600–18,744). A vertical takes a helper from one section and a renderer from another, so code crosses a pinned boundary by construction. |
| **My hot-region cut order** (`14,001`, `17,501`, `10,001`) | **Yes, partially** | Three of the six hottest regions are pinned or sit inside a pinned section's span. Any cut there must carry the marker pair *and* keep the two anchor-to-closer ranges intact (below). |
| **S1 — `server.js` route groups** | No | 0 marker slicers target `server.js`. |
| **S3 — assistant as one owner** | No — it *protects* | Not splitting `public/assistant.js` is what keeps its 4 pinned sections (1,342 lines) intact. **A's step 5 is the one exposed**, not this seam: it would move the queue sub-tab and the pipeline window into new files, and the queue sub-tab is the most-sliced section in the client (4 files). |
| **S4 — `dom-format` cut** | No | No test slices it by marker; it is already a separate file and already publishes its surface. |
| **S5 — leave the substrate** | No | No moves. |
| **R4 — `lib/assistant.js` → concerns** | No | No test slices any `lib/` file by marker (all 25 tests that touch it import it as a module). |

**A sharper failure mode than either draft names.** `test/ahead-behind-cell.test.js` pins two ranges
that are *not* section slices:

```js
// :108
const cols = src.slice(src.indexOf("const CHART_COLUMNS = ["), src.indexOf("// ---- end chart columns"));
// :114
const vh   = src.slice(src.indexOf("function verdictHtml"),     src.indexOf("// ---- end merge control"));
```

The first pins `CHART_COLUMNS` (line 14,006) to the chart-columns closer (14,106) — 100 lines. The second pins
`verdictHtml` (10,954) to the **merge-control** closer (11,000) — 46 lines, and `verdictHtml` belongs to a different
section than the marker that bounds it. These two ranges do not depend on the moved section's own markers at all;
they depend on **what sits between an anchor and an unrelated closer**. A vertical cut that moves `verdictHtml`
toward the row renderer, or `CHART_COLUMNS` toward the chart module, changes both slices without touching either
marker — and the failure is a failed `assert.match`, not a thrown "missing region". A's step 0 ("make the markers
honest") does not fix this: the markers are honest, the *anchors* are positional.

That is the sharpest form of the constraint and it belongs in the plan: **two ranges in the client are pinned by
anchor-to-closer spans, and they must be re-expressed as section slices before any vertical cut moves code between
them.**

---

## 5. The seam list I would sign

Order = what removes contention soonest per unit of risk, with the load contract (§2) and the marker API (§4) as
hard gates. Merged from both drafts; the evidence column says which measurement puts it there.

| # | Cut | Size | Evidence it is the right next step |
|---|---|---:|---|
| 0 | **Make the markers honest** (A's step 0) | comment-only | 850 lines pinned across 10 sections; 2 anchor-to-closer ranges (§4); this is what makes steps 3 and 6 reversible. Adopted outright. |
| 1 | **`server.js` → `lib/routes/*.js`, one serialized gather** | 1,814 L in the top five groups | 75 branches, 48 left; idiom proven 3× (one-path form); both clusters meet here (12 shared commits with `lib/assistant.js`, 12 with `app.js`); groups interleaved, so one landing, not five. |
| 2 | **`server.js` header → `lib/` (object graph + the 44 helpers above the dispatcher)** | 1,957-line band | 51 of 92 `server.js` hunks and 21 of 30 commits are above the dispatcher; **absent from A's plan**, and it is the larger half by churn. |
| 3 | **`app.js` settings tail (A's A1)** | 2,964 L, 9-name surface | 63 hunks in 17,001–18,500 (20% of the file's churn), **0 load-time `state` writes**, 2 pinned sections that travel with their marker pairs. The hottest contiguous block in the file and the cheapest by surface. |
| 4 | **`lib/assistant.js` → rules engine, then queue host** (A's S1, S4) | 674 + 1,018 L | The assistant cluster is 114 commit appearances; these two cuts are inside it, so they belong to its owner. Rules engine is pure and testable without a clock. |
| 5 | **`lib/jobs.js` → gateway transport** (A's J1) | ~850 L | Pure move of already-exported retry policy; 15 test files import `jobs.js` directly, so the move is proved by the existing suite. |
| 6 | **`public/assistant.js` → pipeline-window, queue-tab, messages** (A's step 5) | 459 + 733 + 197 L | Already private (one IIFE, 3 globals); carries its 4 pinned sections; **must follow step 0**, and the most-sliced section in the client (the queue sub-tab, 4 files) is in this move. |
| 7 | **`public/style.css` → `assistant.css`** (A's) | ~600 L | Not my measurement, adopted as stated: 247 of 248 `as-*` rule lines already adjacent; the prefix is a written contract. |
| — | *(dropped — see §5.1: the 119-line `chart columns` section move has **0** of the region's 30 hunks)* | — | Not signed. |

### 5.1 The one I would drop: A2, the 3,710-line chart/ranking cut

A already says "do not cut this first"; I would drop it as a *unit*, not defer it. On the three gates this round
established:

- **Surface:** 58 exported names, 76 outer dependencies — A's own numbers, the worst ratio in their table.
- **Load:** 3 statements, 0 `state` writes — the only gate it passes, and passing it buys nothing when the surface
  is that wide.
- **Markers:** it contains the `chart columns` section (pinned) and the anchor-to-closer range at `:108`.
- **Churn:** its sub-region 14,107–14,500 carries 30 hunks and 14,501–15,260 four more — **34 hunks in A2's range,
  and 0 of them inside the 119-line `chart columns` section** (13,988–14,106). So the section is churn-cold and
  moving it would be motion without value; the churn sits in the split-width and column-drag handlers beside it.

A cut that produces "the same file with a longer relative path" (A's own phrase) is not a seam. **I also withdraw
my own fallback** — I proposed keeping the 119-line `chart columns` section as what survives of A2, and the hunk map
refutes it: 0 of the region's 30 hunks land inside that section. The honest entry is no entry: the 14,107–14,500
band is real churn, but its surface (inside A2's 58 names / 76 outer deps) makes it a late cut, and it should be
re-measured as its own candidate before anyone signs it. Dropping A2 means leaving 34 hunks in place; pretending a
119-line move absorbs them would be worse than leaving them.

### 5.2 The disagreement I will not concede: the client cannot be step 7

A's extraction order puts every client cut after six server-side steps, and justifies it by blast radius — a Node
mistake is `ERR_MODULE_NOT_FOUND` in seconds, a classic-script mistake is a `ReferenceError` in a browser. That is
true and I am not arguing with the risk assessment.

I am arguing with the *sequence*, on the one measure A does not use: churn. In the same 200 commits, the client trio
is the busiest thing in the repo — `public/app.js` 42 commits, `public/style.css` 36, `public/index.html` 23 —
against `server.js` 30, `lib/assistant.js` 28, `lib/jobs.js` 7. Two of A's first three steps (`lib/jobs.js` gateway,
`lib/assistant.js` rules engine) touch files with 7 and 28 commits between them; they will not reduce a single
collision in `app.js`/`style.css`/`index.html`, which is where 101 commit appearances and the 21 `app+style` pairs
live. A plan whose first six landings leave the top three churn files untouched has optimized revertability at the
cost of the thing the reader complained about.

My order puts the first client cut at step 3, after the marker work (step 0) and the one serialized server change
(step 1) — i.e. as soon as it is *reversible*, not as soon as it is *safe*. That is the disagreement I will not
concede: **the client is not the last thing to do; it is the first thing that can be done safely once the markers are
honest.**

### 5.3 What would change my mind

- If the 24 load-time `state` writes turn out to sit inside the settings tail after all (they do not: 0 in
  17,001–18,500), step 3 would move behind the console work.
- If a vertical cut in the settings tail cannot keep the two pinned sections (`settings tabs`, `settings search`)
  intact as marker pairs, step 3 is blocked on step 0 and nothing else — which is why step 0 is first for both of
  us.
- If the server-header extraction (step 2) turns out to require moving `broadcast` and the boot-pass promise, it
  becomes a two-landing step; I would still keep it at #2, because 21 of 30 commits touch that band.

---

## 6. Where the two drafts now agree, in one line each

- The server import graph is acyclic and shallow (0 SCCs, depth 6) — no cycle work, only extraction.
- The client has no module system; its seams are cuts through late-bound names, and the namespace object is
  written but unread.
- The section markers are an API; the honest-marker landing comes before any client cut.
- The route-factory idiom is the right instrument for `server.js`, and the auth/boot-pass guards must be inherited
  by mount point, not re-implemented.
- The console is not the first cut, and the chart/ranking block is not a seam.
- `package.json` is the one shared file no split removes (mine, uncontested by A, and it is the top churn file at 120
  of 200 commits).

## 7. What neither draft measured

- **Runtime cost.** No profile, no frame timing. Both drafts say so.
- **The 120 `tools/verify-*.mjs` harnesses.** A ran the node suite (1,165/1,165, their run, not repeated here); the
  browser proof is elsewhere.
- **CSS, on my side.** A's `as-*` block is the only measured CSS seam in either draft, and I adopted it unverified.
- **The snapshot is 6 commits behind `origin/main`** (`bf41b2f`, 0.85.0); A measured the same `cc61bb9`, so every
  number in both drafts shares that base — and shares the same 274-line drift if a reader checks against main.
