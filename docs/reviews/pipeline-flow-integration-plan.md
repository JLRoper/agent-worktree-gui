# The pipeline flow's integration plan: ten commits, and the order they can land in

**Scope.** `docs/reviews/pipeline-flow-architecture.md` at `d3b3954` (`origin/main`, 361 lines), the critique of it
(`docs/reviews/pipeline-flow-architecture-critique.md`, 340 lines, last edited at `1036d5d`, read at `4ebaa62`), and
the code both judge:
`public/pipeline-flow.js` (297), `public/pipeline-modal.js` (369), `public/style.css:3976-4086`,
`lib/pipeline-window.js` (250), `lib/pipeline-bundle.js`, `lib/task-pipeline-drive.js` (452),
the two presses (`public/app.js:20064-20097`, `public/assistant.js:3228-3300`), `test/pipeline-flow.test.js` (11
tests), `test/pipeline-window.test.js`, `test/pipeline-modal.test.js` and `tools/verify-pipeline-flow.mjs` (376).
The question: given what comparable tools do, **which change comes first, which function carries it, and what does
it break**.

**Snapshot.** `origin/main` is `743789d` (0.113.0) and this branch is cut from it. The branch began at `9166869`
(0.109.0); between that base and `743789d` the drawing files did not move — `git diff 9166869 743789d --
public/pipeline-flow.js public/pipeline-modal.js lib/pipeline-window.js public/assistant.js
test/pipeline-flow.test.js tools/verify-pipeline-flow.mjs` is empty, and `public/style.css` gained four unrelated
lines for the Matrix bridge's log (`@@ -343` in the diff), so the flow block moved from `:3972` to `:3976` and every stylesheet
line below is `743789d`'s. `lib/task-pipeline-drive.js` came in with `a71453c` and is in this tree.

**Method.** Read both documents and the code they cite; ran `node --test test/pipeline-flow.test.js` (11 pass),
`test/pipeline-window.test.js` and `test/pipeline-modal.test.js` (35 pass together), and `npm test` at this tree
(**1 350 pass, 0 fail**, 293 s, at `743789d`) — the baseline every "lands green" below is measured against;
replayed the test file's two
markup regexes against the shipped string and against the two attribute changes the plan requires (results in *What
the tests pin*); read the comparable tools' own source and docs, cited in *Sources*. No browser was driven and no
panel was touched, so no measurement from the architecture document is confirmed or overturned here — where this
plan depends on one, it says so.

---

## Verdict

**The critique's order is right and the research says why: in every comparable tool the picture's state comes from
the run record, and a loop's bound is a field printed on the picture, never a shape invented by the renderer.**
Geometry is the last thing those tools build, and they buy it from a layout engine when they build it at all. So:
**state first, gate second, cap third, geometry fourth** — and the SVG layer becomes C9 with a named trigger,
not C2.

Two things the research changes in the critique's plan:

1. **The gate is not a mark, it is an object, and it lands early (commit 3).** Jenkins pauses on an `input` step
   that is a node in the graph with Proceed/Abort buttons [23]; Argo makes `suspend` a node genre [9]; GitHub makes
   approval a property of the job that uses the environment [4]. None of them recolours the stage before the gate.
   Our notch is a 3×15 px bar inside an `aria-hidden` span, coloured by the *stage's* mark
   (`public/pipeline-flow.js:190-196`, `public/style.css:4021-4023`) — the one object the reader is asking about is
   the one object with no state of its own.
2. **`refused` has no producer and the panel's contract forbids one.** The record's position carries `{stage}`
   (`public/assistant.js:3288`) and the only writer of `refused` is the preview checkbox
   (`public/pipeline-modal.js:284-287`). The driver checks only that a decision record *exists*; it never reads the
   outcome (`lib/task-pipeline-drive.js` rule 5). So the fourth mark cannot be lit by the record as the contract
   stands. This plan keeps `refused` as the preview's mark and gives the **gate** the live states instead
   (`open` / `ahead` / `waiting` / `answered`). That is the shape Jenkins and Argo draw: a wait, not a verdict.

The destination — a drawing that can say "this loop has two of three rounds left, that gate is waiting on
`decisions/2.json`, and the task is parked against it" — is not in dispute between the two documents. What this plan
adds is the commit boundary for each sentence, and the function that carries it.

---

## What the comparables actually do

Read from their own source where the source is public, and from their docs where the behaviour is documented. The
versions are whatever `main` held when this was written; the claim is about the approach, not the build.

| tool | how the picture is built | an edge routed around nodes | a capped loop | a gate / approval | where the task is | many stages |
|---|---|---|---|---|---|---|
| **GitHub Actions** | a graph per run: one box per job, status icon at its left, "lines between jobs indicate dependencies" [1] | not applicable: `needs` is a dependency set and the graph is a DAG [2] | none in the graph; a re-run is a run-level action capped at 50 [3] | an environment protection rule on the job — required reviewers, wait timer [4] | the job's own status icon, live [1] | the job list; no zoom documented |
| **Argo Workflows** | dagre (`@dagrejs/dagre ^3.1.1`) [5]; `rankdir` LR/TB, fixed `ranksep`/`nodesep`, and dagre's edge `points` are kept and stroked [6] | dagre routes; the UI draws the returned polyline [6] | loops are **expanded** (`withItems`, recursive template) [8]; a retry's bound is `retryStrategy.limit` on the node [8] | `suspend` is a node genre [9]; collapsed subtrees are a node genre too [9] | node phase from `wf.status.nodes` [7] | zoom in/out multiplies node size by 1.2 and **re-runs layout** [7] |
| **Tekton Dashboard** | ELK layered, direction RIGHT, `elk.edgeRouting: ORTHOGONAL`, `mergeEdges: true` [10][11]; edges are ELK `sections.bendPoints` into a d3 path with an arrow marker [12] | the engine's bend points; the UI never computes one [12] | none: `retries`, `when`, `matrix`, `finally` are task fields [13] | `when` expressions guard execution; no pause object [13] | per-node status from the TaskRun [10] | ELK + foreignObject cards |
| **n8n** | Vue Flow canvas (`@vue-flow/core 1.48`, plus background/controls/minimap/node-resizer) [14] | a free canvas; edges are Vue Flow's | a **Loop Over Items node** in the graph plus an ordinary connection back; the docs warn an unmatched termination condition leaves the run stuck forever [15] | an If node, i.e. a branch, not a pause [15] | node colour in the execution view [15] | pan, zoom and minimap are the canvas's [14] |
| **Airflow 3** | React Flow (`@xyflow/react ^12`) + ELK layered (`SIMPLE` placement, edge labels centred) [16][17] | ELK; React Flow renders the edges | node carries `is_loop` and `loop_max_iterations` and the badge's width is budgeted into the node [17] | trigger rules and sensors; no pause object in the graph | Graph View overlays the run's task states; click a task for metadata [18] | direction dropdown, group open/close, download [17][18] |
| **Mermaid** | ELK by default, dagre optional via `layout: dagre`; curves configurable [19] | engine | none; a back edge is just an edge | none | none — static | SVG scales |
| **Dagre / ELK** | layered (Sugiyama) layout: nodes need sizes, edges get `points`; cycles are normalised by an `acyclicer` that computes a feedback arc set [21] | the engine, not the caller | n/a | n/a | n/a | n/a |

**Dagre** hands back `points` and, when asked, an `acyclicer: greedy` feedback arc set "to make a graph acyclic"
[21]; **ELK layered** lists self loops, inside self loops, multi edges, edge labels and ports as supported features,
and offers straight, orthogonal or spline routing [22]. Both are saying the same thing: a cycle is a *global layout
problem*, not a decoration you attach to one edge.

### The five lessons, and what each one costs us

**L1 — State is read, never inferred.** GitHub reads a job's status [1]; Tekton reads the TaskRun [10]; Airflow
overlays the task instance's state on the graph [18]; Argo reads `wf.status.nodes` [7]. None of them computes "done"
from position. Our `marksFor` does (`public/pipeline-flow.js:149-163`), and the seed shows the cost: at S8 with
`crossings["H-10"] = 1`, S9 has run (that edge is how the task got back to S8) and the drawing marks it
`not-reached` — measured today, 8 done / 1 current / 4 not-reached; by hand-computation, 9 / 1 / 3 once the crossed
edge counts as evidence.

**L2 — A bounded loop prints its bound; it does not draw one.** Argo's `retryStrategy.limit` and Airflow's
`loop_max_iterations` are numbers on the node [8][17]; n8n has no bound at all and says so by warning about a hung
execution [15]. Nobody re-parses a sentence to draw a number. Our `capOf` is `/(\d+)/` over free text
(`lib/task-pipeline-drive.js:92-98`), so the architecture document's own proposed label "2 of 3 rounds" reads back
as a cap of **2** — replayed: `"3 rounds (P-50)" → 3`, `"2 re-deliveries" → 2`, `"2 of 3 rounds" → 2`. The arc may
print `used of limit` only if `limit` comes from the driver's reader, not the renderer's.

**L3 — A gate is an object with its own state.** Jenkins' `input` step "pauses Pipeline execution", is drawn in the
stage view with Proceed/Abort [23]; Argo's `suspend` is a node genre [9]; GitHub's approval is a job property with
"required reviewers" [4]. Ours is a colour borrowed from the stage, in an `aria-hidden` subtree, with a mouse-only
`title` (`public/pipeline-flow.js:192-195`).

**L4 — Zoom is a layout input, not a CSS transform.** Argo's zoom buttons change `nodeSize` and re-lay out [7];
Vue Flow and React Flow own pan/zoom [14][16]. A `transform` over a percentage grid re-rasterises every label and
still leaves the width policy unsolved. Our cheap equivalent is a column-width function plus `fit`, not a transform.

**L5 — Accessibility is not a by-product of a graph library.** Mermaid gives an `aria-roledescription` and an
optional svg-level `<title>`/`<desc>` and nothing per node [20] — which is exactly the ceiling we would hit by
vendoring it. The keyboard story is ours to build: one tab stop with a roving cursor (`aria-activedescendant` or
roving `tabindex`), `aria-current` on the position [25][26], and shape *and* colour for each mark, because colour
alone may not be the only means of conveying information [24].

### What does not transfer

- **A layout engine.** Dagre and ELK are for graphs whose order is unknown; ours is fixed by the document's stage
  list, and the one geometry rule worth keeping — the greedy lane assignment at `public/pipeline-flow.js:223-231`,
  pinned by `test/pipeline-flow.test.js:96-104` — is already correct. Buying an engine would replace a correct
  ordering with a heuristic one.
- **"No cycles".** GitHub can draw a clean DAG because `needs` cannot express a cycle [2]. The studio's data can:
  `loop` is one of its three handoff kinds (`lib/pipeline-bundle.js:51`). We do not get to choose that away.
- **A canvas.** Vue Flow and React Flow are the right answer for an editor; this dialog is read-only, opened from two
  surfaces, and its gates are DOM readers (`tools/verify-pipeline-flow.mjs:148-181`). A canvas could not be proved
  by the harness that exists.

---

## The plan, in ten commits

Each commit lands green on its own: `node --test` and `npm run verify:pipeline-flow` where a browser is available.
"Breaks" lists only assertions that must be edited in the same commit; anything omitted is expected to keep passing.

**The smallest first commit is C1**, and it is about forty lines across `lib/pipeline-window.js`,
`public/assistant.js` and one test, with no pixel changed. It is first because it is the only one that can land
while stage 3 is the sole writer of `public/pipeline-flow.js` and `public/pipeline-modal.js`, and because every
later truth claim reads the fields it adds. If the reader needs to *see* the direction move before believing it,
C2 is the smallest visible commit — but C2 needs C1's pass-through, and only stage 3 may write the renderer, so the
pair is the smallest honest unit of *visible* work.

### C0 — Settle which edge a stage leaves by (owner: the bundle contract)

**Files.** `lib/task-pipeline-drive.js` (`nextStageOf`, `gateAfter`), possibly `lib/pipeline-bundle.js`.
**Change.** `nextStageOf` takes the first handoff leaving a stage whatever its kind
(`lib/task-pipeline-drive.js:172`), so on the seed S9 leaves by H-10 (the loop) every time and S10–S12 are
unreachable. Decide the rule — kind order, or "the sequence edge unless the loop is the only one" — and say it in
the bundle contract.
**Why first.** Until this is decided, every later commit draws a graph the panel does not run. The research is
blunt about it: n8n is the only tool that lets the author draw an unbounded back edge, and its own docs warn the
execution hangs [15]. A picture of a machine that cannot run is worse than a plain one.
**Green when.** A unit test walks the seed from S0 to S12 and names the edge taken at each step.
**Breaks.** Nothing in `public/`.

### C1 — The record reaches the drawing's edge (no pixels)

**Files.** `lib/pipeline-window.js` (`stageRows`, `buildTaskPipelineWindow`, `previousOf`), `public/assistant.js`
(`openTaskPipelineFlow`), `test/pipeline-window.test.js`.
**Change.** Add to the model, read-only and additive:
- per stage: `gates` — every gate whose `after` is this stage (the last-wins Map is F6, and two gates after one
  stage is legal in the loader); `gateEnding` stays for the tests at `test/pipeline-window.test.js:114-133`;
- at the model level: `ran` (computed once, not per row), `run: { crossings, waitingFor, via, enteredAt }` and
  `loops: [{id, from, to, kind, cap, limit, used}]`, with `limit` and `used` from `capOf` and `run.crossings` —
  one reader, shared with the driver. `capOf` moves from `lib/task-pipeline-drive.js` to `lib/pipeline-bundle.js`
  (beside the handoff normaliser) so the window model can read it without importing the driver, which imports
  `lib/assistant/queue.js`;
- `position` passed by the press gains `ran`, `crossings`, `waitingFor`, `via` (`public/assistant.js:3288`).
`ran` is a derivation with evidence, not a guess: every stage at or before the current position **plus** every stage
between `to` and `from` of any loop edge whose `crossings > 0`, plus the `from` stage of the edge named by `via`.
A crossed edge proves both its ends ran.
**Why now.** This is the only phase that can land while stage 3 holds `public/pipeline-flow.js` and
`public/pipeline-modal.js` — no second writer in those files. It is also the precondition for C2–C4: L1 says the
marks cannot be true until the evidence is in the model.
**Green when.** A new test on `buildTaskPipelineWindow` with `crossings: { "H-10": 1 }` and `stage: "S8"` asserts
`ran` contains S0–S8 **and S9**, and `loops` carries H-10 with `used: 1, limit: 3`.
**Breaks.** Nothing: `phase` is untouched, which is what `test/pipeline-window.test.js:94` pins.

### C2 — The marks read the record (first visible truth)

**Files.** `public/pipeline-flow.js` (`marksFor`, `fromWindowModel`), `public/assistant.js` (the note's sentence),
`test/pipeline-flow.test.js`.
**Change.** `marksFor(stages, position)`:
1. `refused` for its own id (unchanged);
2. `current` for the record's stage (unchanged);
3. `done` when the id is in `position.ran`;
4. otherwise `not-reached`.
When `ran` is absent — a definition, a bundle with no record — fall back to the index rule and say so in the
comment; `fromWindowModel` always supplies `ran`, so the looped case is never the fallback.
`fromWindowModel` also stops reconstructing loops from `handoffOut` (which prefers the sequence edge and so drops
S9→S8) and reads `model.loops` — the same shape `fromBundle` reads.
**Why now.** It is the smallest change that makes the picture say something true that it says wrongly today, and the
seed is the fixture: at S8, S9 flips from `not-reached` to `done`.
**Green when.** A looped fixture asserts `S0..S7:done, S8:current, S9:done, S10..S12:not-reached`, and the
existing linear assertions at `test/pipeline-flow.test.js:106-127` still pass unchanged.
**Breaks.** Nothing in the test file if the fallback is kept; the note at `public/assistant.js:3281` ("everything
before this stage is done") must be reworded in the same commit, or it is false for a looped row.

### C3 — The gate becomes an object

**Files.** `public/pipeline-flow.js` (`stageHtml`, `normalize`), `public/style.css` (`:4018-4023`), the model from
C1, `test/pipeline-flow.test.js`.
**Change.**
- `normalize` keeps a **list** of gates per stage (`byAfter` becomes `Map<string, Gate[]>`); the last-wins Map is
  F6, and two gates after one stage is legal in the loader.
- `stageHtml` emits each notch as a real focusable element outside the `aria-hidden` wrapper:
  `<button type="button" class="pflow-notch" data-gate="G2" data-gate-name="contract signed" data-state="waiting"
  aria-label="gate G2 · contract signed — waiting on decisions/2.json since 14:20">`. The connector span keeps
  `aria-hidden`; the button does not inherit it.
- Four states, each with shape and colour: `open` (no decision declared — small diamond), `ahead` (declares a
  record, the row has not reached it — hollow diamond), `waiting` (the record's `waitingFor.gate` names it — hollow
  diamond plus a tick and the path in the accessible name), `answered` (the row is past it, so the record was found
  — filled diamond). Never "refused": the panel does not read the outcome (rule 5).
- The last stage's gate stays a notch but stops being an 18 px stub that overflows (`public/style.css:4018-4019`);
  it sits at the track's right edge and the width policy accounts for it (C5 completes this).
**Why now.** F2 and M2 are the two findings a reader feels first, and L3 says the gate is the object the picture
exists to explain. It needs C1's model, so it cannot be earlier.
**Green when.** The notch is reachable by Tab, its accessible name is not inside `aria-hidden`, and the seed's five
gates render five notches with `data-state="open"`. The verify fixture's row sits past `g2`, so that notch reads
`answered`; the new parked fixture (see *The fixture the gate needs*) reads `waiting` with `decisions/2.json` in
its accessible name.
**Breaks.** `test/pipeline-flow.test.js:57-73` counts notches by `data-gate`/`data-gate-name` — unchanged
attributes, so it passes; the `/pflow-link is-end/` match at `:72` must be re-pointed, because the stub is replaced
by a notch at the track's edge. Nothing else in that file reads the notch's parent.

### C4 — The cap on the arc

**Files.** `public/pipeline-flow.js` (`layout`, `arcsHtml`), model from C1, `public/style.css` (`:4025-4036`).
**Change.** Each arc's label becomes `${used} of ${limit}` when `limit` is a whole number, and the studio's own
sentence when it is not, with `title` saying which edge and that it is uncapped. `used` and `limit` ride on the
loop object from C1 — the renderer never parses the cap. A loop at its limit gets `data-spent="1"`, a dashed
stroke and the refused colour on the label only.
**Why.** F3, and L2's rule that the number is printed from a field. This is also where the architecture document's
label is made safe: printing "2 of 3" is fine; reading it back as a cap is not, and only one reader does that.
**Green when.** The verify fixture (cap `2 rounds`, no crossing) draws `0 of 2`; a fixture at the cap draws `2 of 2`
and `data-spent="1"`.
**Breaks.** `test/pipeline-flow.test.js:75-94` asserts `labels === loops.map(h => h.cap)` and
`tools/verify-pipeline-flow.mjs:287` asserts `label: "2 rounds"` — both change to the new string in this commit.

### C5 — One width policy, and the arc formula that follows it

**Files.** `public/pipeline-flow.js` (new `columnWidth(n, usable)` exported beside `layout`), `public/style.css`
(`:3983-3996`, `:4025-4031`), `test/pipeline-flow.test.js`.
**Change.** Replace the three unreconciled widths — `minmax(78px, 1fr)`, the 240 px cap on the track, the 240 px cap
on the arcs layer (`public/style.css:3989-3993`, `:4025`) — with one pure function:

```
columnWidth(n, usable) = clamp(96, (usable - (n - 1) * gap) / n, 400)
```

evaluated at the card's body width (1092 px at the 1120 px cap): 2 → 400 (the ceiling; track 826), 3 → 346, 4 →
253, 5 → 197, 6 → 160, 7 → 133, 8 → 113, 9 → 98, 10 and up → 96 (track 1194, so it scrolls). The track takes
`--pflow-col`, its `max-width` from the same function, and `margin-inline: auto`; `layout()` returns
`x(i) = i * (colW + gap)` and every arc is placed from `x`, which removes the `(j - i) * gap` deficit the critique
found (26 px per column; 104 px on a four-column arc).
**Why a function and not a table.** A table keyed on `n` alone would be wrong at 96vw; one call at open with the
card's measured width is exact, and it is a measurement, not a `ResizeObserver` — the cost the critique priced was
the observer and the re-layout on every resize, not one `clientWidth` read. No resize listener: a resize while the
dialog is open leaves the columns at the width it opened with, and the next open is exact. The trade is explicit:
below the 96 px floor the track scrolls rather than shrinking into unreadable columns, which is the trade the
current stylesheet already made (`public/style.css:3980-3982`).
**One acceptance line amended.** The architecture document asks for "no dead band wider than 80 px beside the track
at two stages". With the 400 px ceiling the two-stage track is 826 px and the leftover is 133 px *on each side* —
symmetric margin, not a dead band. The plan measures `|left margin - right margin| <= 8` instead, and says so
rather than stretching a 2-stage box to 533 px to satisfy a sentence written about a left-aligned track.
**Green when.** A test asserts `columnWidth(2, 1092) === 400`, `columnWidth(7, 1092) === 133`,
`columnWidth(13, 1092) === 96`, and that an arc's computed `left`/`width` ends at the target's centre for a
1-column and a 4-column loop.
**Breaks.** `test/pipeline-flow.test.js:96-104` reads `--pflow-lane` and `--pflow-pad`; keep both attributes or
update the test in this commit. `tools/verify-pipeline-flow.mjs` asserts nothing about width, so it holds.

### C6 — `return` edges, below the rail

**Files.** `public/pipeline-flow.js` (`layout`, `arcsHtml`), `public/style.css` (a second arc lane group).
**Change.** `loopsOf` stops filtering `kind` away: `sequence` is the rail, `loop` an arc above with a cap, `return`
an arc **below** with an arrowhead and no cap, labelled with its artifact only in the `title`. Lanes below are
negative and assigned by the same greedy rule.
**Why now.** It is the first shape the grid provably cannot draw, and C5 has just given the grid the coordinates to
draw it. Doing it before C5 would draw a second wrong shape.
**Green when.** A fixture with one `return` handoff draws `data-kind="return"` below the track with its endpoints at
the two stage centres, and the seed (zero returns) is byte-identical.
**Breaks.** The arc regex (again) — it is the same commit's test edit; `arcAboveTrack` in the verify tool is
asserted for the loop arc only, so it still holds.

### C7 — Operable: one tab stop, a cursor, a focus card

**Files.** `public/pipeline-flow.js` (`markup`, `stageHtml`, new `cardHtml`), `public/pipeline-modal.js`
(`TABBABLE`, the Escape handler `:298-316`, `paintFlow` `:164-172`), `public/style.css`, tests.
**Change.** The track becomes a composite widget: `role="listbox"`, one tab stop (`tabindex="0"`),
`aria-activedescendant` pointing at the cursor stage; stages are `role="option"` with ids, and the position carries
`aria-current="step"` rather than `aria-selected` (nothing is selected — it is where the task is). Arrows move the
cursor, Home/End jump, Enter opens a focus card (`role="region"`), Escape closes the card first and the dialog
second. The notch buttons move out of the list items into a sibling `.pflow-gates` layer, because an `option` must
not contain interactive children; they are positioned from C5's `x()`. `paintFlow` remembers the cursor stage id and
restores it after the re-render. The track already matches `TABBABLE`'s `[tabindex]` clause, so the trap needs no
edit; the Escape layering is decided in `keyIntent`, so it stays pure and testable.
**Why now.** F4, and L5: this is the part a graph library would not have given us. It comes after the picture is
true, because a keyboard cursor over a wrong drawing is a faster way to read a wrong drawing.
**Green when.** Tab reaches the track once; ten arrow presses visit every stage; Enter opens the card for a gate and
for a loop; Escape closes the card, then the dialog, and never both.
**Breaks.** Every node regex (`role` lands after `class` → 0 matches, measured). The verify tool's
`readModal` reads `card.querySelectorAll(".pflow-node")`, which survives; its `focusInCard` and ten-Tab loop still
hold.

### C8 — `fit`, the scroll affordance, and the legend's counts

**Files.** `public/pipeline-flow.js` (`markup`, `legendHtml`), `public/pipeline-modal.js` (the `fit` press),
`public/style.css`.
**Change.** The scroller gets an edge fade and a `n of m columns` statement when `scrollWidth > clientWidth`; a
`fit` control relaxes the same width function for one render — `gap: 12`, floor `56`, which gives 13 columns of 70
px in 1054 px — so the whole chain is visible, at the cost of the titles; pressing it again restores the default
policy. Legend keys gain `data-count` and an `aria-label` of `"9 done of 13"` while their visible text stays exactly
as today.
**Why.** F7 and F9's reader-facing half, and the cheapest possible answer to L4: no transform, no re-layout on
resize, and `fit` is a deliberate legibility-for-overview trade rather than a zoom that pretends to be free.
**Green when.** At 13 stages the scroller says `2 of 13 columns out of view` (13 × 96 + 12 × 26 = 1560 in 1092) and
`fit` brings all of them in; the legend's textContent is unchanged, so the verify tool's exact strings still pass.
**Breaks.** Nothing if the visible legend text is left alone — that is why the count moves to `aria-label` and
`data-count` rather than into the string.

### C9 — A coordinate system, only on the named trigger

**Files.** `public/pipeline-flow.js` (`layout`, `stageHtml`, `arcsHtml`, `markup`), `public/style.css`
(`:4018-4036` deleted), the test regexes.
**Trigger, named now:** the first shape the column grid cannot express — a join where two edges enter one stage, two
gates stacked in one gap with labels, or a third loop that needs a lane the reserved pad cannot hold without pushing
the track out of the card. C6 puts a `return` below the rail rather than across it, so a bare return is not a
trigger.
**Change.** One `<svg>` for the rail, notches, arcs and token; the boxes stay DOM and are positioned from the same
`layout()`. Price it honestly, as the critique demands: C5's width read becomes a `ResizeObserver` and a re-layout on
every resize (the cost the current stylesheet was written to avoid, `public/style.css:3980-3982`), two rendering
models in one component, a second palette to keep, and the test file's regexes replaced by a parser. About 71 lines
of the renderer are replaced, not 95; the three adapters and `marksFor` (103 lines) survive; the modal is not
untouched — C7 already edited it.
**Green when.** Every acceptance line in the architecture document's last section passes at 1280×800 and 1821×700,
including "no element's rect exceeds its scroller's client box".

---

## The four marks, the gate and the legend

The marks keep their four names (the tests, the palette and the legend's order are pinned to them) and gain a shape,
because colour alone may not be the only means [24]. `data-mark` stays the single source; the legend reads the same
attribute.

| mark | evidence | shape on the stage | colour | legend key |
|---|---|---|---|---|
| `not-reached` | not in `ran`, not current | hollow ring, 1 px, no fill | `--dimmer` | hollow ring + "not reached" |
| `done` | id in `ran` (C1) | filled disc | `--green` | filled disc + "done" |
| `current` | `stage === position.stage` | ring, 2 px, plus the position token (halo) and `aria-current="step"` | `#58a6ff` | ring + "current" |
| `refused` | `position.refused` only (preview) | cross (two 1 px bars) in the 9 px dot | `--red` | cross + "refused", muted in edit mode, where no preview can set it |

The legend: four keys in fixed order, visible text unchanged (`not reached`, `current`, `done`, `refused`, count in
`<b>` only when non-zero), plus `data-count` and an `aria-label` of `"<n> <word> of <total>"`. It is not a tab stop;
it is a legend, and a reader who needs it in the keyboard path gets the same words from the focus card.

The gate, in the notch's own vocabulary:

| state | evidence | drawing | accessible name |
|---|---|---|---|
| `open` | no `decision` on the gate | small diamond, `--amber` | `gate G0 · Charter` |
| `ahead` | `decision` declared, row before it | hollow diamond | `gate G2 · contract signed — decides decisions/2.json` |
| `waiting` | `waitingFor.gate === id` | hollow diamond + tick, pulsing only under `data-motion="on"` | `… — waiting since 14:20 on decisions/2.json` |
| `answered` | row is past the gate | filled diamond | `… — answered` |

Two gates after one stage stack in the gap, in document order, each its own button. `data-gate` on the stage box
becomes the first gate's id (the existing test reads the notch attributes, not the box's).

---

## What the tests pin, and what each phase breaks

`test/pipeline-flow.test.js` is a regex over the serialised string, with tag and attribute order baked in:

```js
/<li class="pflow-node" data-stage="([^"]*)" data-pos="(\d+)" data-mark="([^"]*)"/g
/<div class="pflow-arc" data-loop="([^"]*)" data-from="([^"]*)" data-to="([^"]*)" data-cap="([^"]*)"/g
```

Replayed against the shipped seed markup and the two changes this plan requires:

| markup | nodes matched | arcs matched |
|---|---|---|
| as it ships | 13 | 3 |
| any attribute added after `class` on the node (C7's `role`, or a `data-ran`) | **0** | 3 |
| the arc as `<path class="pflow-arc" …>` (C9) | 13 | **0** |

So the arc regex must be replaced in C6 (the first commit that stops emitting a `<div>`), and the node regex in C7
(the first commit that adds an attribute to the stage box). The replacement is a two-step parse —
`/<li class="pflow-node"([^>]*)>/g` then an attribute map — which survives every later attribute and is worth doing
once.

What else is pinned, and by whom:

| assertion | where | survives |
|---|---|---|
| 11 tests, all green | `node --test test/pipeline-flow.test.js` | yes, if each commit edits its own regex |
| nodes in document order, positions 1..n | `test/pipeline-flow.test.js:44-55` | yes |
| one notch per gate, in document order; the last stage's gate is a stub | `:57-73` | C3 changes `pflow-link is-end`'s drawing, not the notch attributes — the `/pflow-link is-end/` match must be re-pointed |
| arc label is the cap and nothing else; no id or title painted | `:75-94` | **breaks in C4** (label becomes `0 of 2`) |
| lanes 0,1,0 and `--pflow-pad >= 44` | `:96-104` | breaks in C5 if the style variables go; keep them |
| marks for a linear position (4 done, 1 current, 8 not-reached) | `:106-114` | yes — the linear case is the same under `ran` |
| refused wins for its own stage; 5 done | `:116-127` | yes |
| a definition is all `not-reached` | `:129-138` | yes |
| the window model draws the same sequence | `:154-169` | C2 changes it to read `model.loops`; the fixture gains `loops` |
| reduced motion is one attribute | `:171-178` | yes |
| `phase` is `before/current/after` and `gateEnding` per stage | `test/pipeline-window.test.js:94`, `:114-133` | yes — C1 adds fields, changes none |
| `keyIntent` closes on Escape and wraps Tab | `test/pipeline-modal.test.js:31-43` | yes if the card layer defaults to `close` when no card is open; add a `card` case |
| legend text `not-reached:not reached 1` etc. | `tools/verify-pipeline-flow.mjs:285`, `:300`, `:306` | yes if C8 keeps the visible string |
| one arc, `label: "2 rounds"`, above the track | `:287-288` | **breaks in C4** |
| the gate that ends S2 is one notch (`g2`) | `:286` | yes |
| 0 focusable elements today | measured, not asserted | C7 changes it; the verify tool never asserts the old zero |

---

## The fixture the gate needs

The seed cannot prove any of this: 13 stages, **five gates and not one declares a decision**, **zero `return`
edges**, three loops all one column wide. `tools/verify-pipeline-flow.mjs`'s own bundle is five stages, one gate
(with a decision) and one loop. Before C2–C6 can be accepted, the fixture grows by:

1. a queue row at S2 of a pipeline whose S4→S2 loop has `crossings: { h5: 1 }` — the looped-mark regression;
2. a second row parked with `waitingFor: { gate: "g2", path: "decisions/2.json", stage: "S2", since: … }` — the
   gate's `waiting` state;
3. a bundle with a `return` handoff and a second gate after one stage — C3's stacking and C6's lower arc;
4. a 13-stage bundle with a `cap` of `"2 of 3 rounds"` — to prove the label prints from `limit`, not from a
   re-parse.

Assertions to add, in the tool's own style: `marks()` after the loop reads
`["S0:done","S1:done","S2:current","S3:done","S4:done"]`; the notch's `aria-label` contains `waiting`;
`card.querySelectorAll('.pflow-notch[aria-hidden], [aria-hidden] .pflow-notch')` is empty; the track is
`document.querySelectorAll('.pflow-track[tabindex="0"]').length === 1`; and
`[...card.querySelectorAll('*')].every(el => el.getBoundingClientRect().right <= scroller.clientWidth + 1)`
for the no-overflow acceptance line.

---

## Acceptance, as stage 4 can run it

Unchanged from the architecture document, because its acceptance section is the best artifact in it. The one
addition this plan makes: **truth is asserted from the record, not from the drawing** — the looped fixture's marks
come from `crossings`, and a test that passes with `crossings: {}` must fail with `crossings: { "H-10": 1 }` under
the old `marksFor`. That is the regression the whole plan exists to prevent.

---

## What this plan does not decide

- **Whether the driver's first-edge rule or the studio's authoring changes** (C0). It is a bundle-contract question,
  and both ends of it are outside `public/`.
- **Whether `refused` ever gets a producer.** That would mean the panel reading a decision record's outcome, which
  rule 5 forbids today. Until then the fourth mark is the preview's, and the gate carries the live wait.
- **The exact palette** for the gate's four states and the spent arc. The panel's language is the starting point.
- **Whether the two pipeline surfaces merge** (`public/assistant.js:3368`'s window and this dialog). They carry the
  same model; that is a product decision, not a drawing one.
- **`docs/pipelines.md` §8**, still marked UNBUILT (`docs/pipelines.md:485-511`) though the catalogue, the record,
  the tab and the tests all exist. Worth its own patch; noticed, not taken.

---

## Sources

1. GitHub Docs — Using the visualization graph. https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/using-the-visualization-graph
2. GitHub Docs — Workflow syntax, `jobs.<job_id>.needs`. https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds
3. GitHub Docs — Re-running workflows and jobs (50 re-runs). https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs
4. GitHub Docs — Managing environments for deployment (required reviewers, wait timer). https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
5. Argo Workflows — `ui/package.json` (`@dagrejs/dagre ^3.1.1`). https://github.com/argoproj/argo-workflows/blob/main/ui/package.json
6. Argo Workflows — `ui/src/shared/components/graph/pretty-layout.ts` (rankdir, ranksep, edge `points`). https://github.com/argoproj/argo-workflows/blob/main/ui/src/shared/components/graph/pretty-layout.ts
7. Argo Workflows — `ui/src/shared/components/graph/graph-panel.tsx` (zoom = `nodeSize * 1.2`, re-layout) and `ui/src/widgets/workflow-graph.tsx` (nodes from `wf.status.nodes`). https://github.com/argoproj/argo-workflows/blob/main/ui/src/shared/components/graph/graph-panel.tsx · https://github.com/argoproj/argo-workflows/blob/main/ui/src/widgets/workflow-graph.tsx
8. Argo Workflows — `examples/loops-dag.yaml` (`withItems`), `examples/recursive-for-loop.yaml`, `examples/retry-on-error.yaml` (`retryStrategy.limit`). https://github.com/argoproj/argo-workflows/tree/main/examples
9. Argo Workflows — `ui/src/workflows/components/workflow-dag/genres.ts` (`Suspend`, `Collapsed`). https://github.com/argoproj/argo-workflows/blob/main/ui/src/workflows/components/workflow-dag/genres.ts
10. Tekton Dashboard — `packages/graph/src/components/Graph/Graph.jsx` (ELK layered, `ORTHOGONAL`, `mergeEdges`) and `Node/Node.jsx` (status icon). https://github.com/tektoncd/dashboard/blob/main/packages/graph/src/components/Graph/Graph.jsx
11. Tekton Dashboard — `packages/graph/package.json` (`elkjs ^0.12.1`). https://github.com/tektoncd/dashboard/blob/main/packages/graph/package.json
12. Tekton Dashboard — `packages/graph/src/components/Edge/Edge.jsx` (`sections.bendPoints` → d3 path). https://github.com/tektoncd/dashboard/blob/main/packages/graph/src/components/Edge/Edge.jsx
13. Tekton docs — Pipelines (`retries`, `when`, `matrix`, `finally`). https://tekton.dev/docs/pipelines/pipelines/
14. n8n — `packages/frontend/editor-ui/package.json` (`@vue-flow/core 1.48`, controls, minimap). https://github.com/n8n-io/n8n/blob/master/packages/frontend/editor-ui/package.json
15. n8n docs — Loop Over Items (Split in Batches), including the infinite-loop warning. https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.splitinbatches/
16. Airflow — `airflow-core/src/airflow/ui/package.json` (`@xyflow/react ^12`, `elkjs ^0.12`). https://github.com/apache/airflow/blob/main/airflow-core/src/airflow/ui/package.json
17. Airflow — `airflow-core/src/airflow/ui/src/components/Graph/elkGraphUtils.ts` (`is_loop`, `loop_max_iterations`, ELK options). https://github.com/apache/airflow/blob/main/airflow-core/src/airflow/ui/src/components/Graph/elkGraphUtils.ts
18. Airflow docs — UI Overview, Graph View (run states overlaid, click for metadata). https://airflow.apache.org/docs/apache-airflow/stable/ui.html
19. Mermaid docs — Flowcharts (ELK default, `layout: dagre`, curve styling). https://mermaid.js.org/syntax/flowchart.html
20. Mermaid docs — Accessibility (`aria-roledescription`, svg `title`/`desc`). https://mermaid.js.org/config/accessibility.html
21. Dagre wiki — `acyclicer: greedy` feedback arc set; edge `points`. https://github.com/dagrejs/dagre/wiki
22. ELK — Layered algorithm reference (self loops, edge labels, routing styles). https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html
23. Jenkins — Pipeline: Input Step (`input` pauses execution; Proceed/Abort in the stage view). https://www.jenkins.io/doc/pipeline/steps/pipeline-input-step/
24. W3C — WCAG 2.2 SC 1.4.1 Use of Color. https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html
25. W3C — WAI-ARIA Authoring Practices, Listbox pattern. https://www.w3.org/WAI/ARIA/apg/patterns/listbox/
26. W3C — WAI-ARIA 1.2, `aria-current`. https://www.w3.org/TR/wai-aria-1.2/#aria-current

---

## Checked and deliberately not filed

- **The dagre/ELK choice for the dialog.** Rejected as a dependency, not as a technique. The plan steals their
  *shape* (a layout function returning coordinates) without their weight; the catalogue page keeps Mermaid, where a
  build-time render is the right use (and the architecture document says the same).
- **Argo's `withItems` expansion as a model for loops.** Wrong for us: the studio's loop is a capped edge back to a
  named stage, and the record counts crossings of that edge, so there is nothing to expand — only something to
  draw. Cited because it explains why Argo never has to draw a back edge.
- **n8n's missing cap.** Not a defect to copy or to fix; cited because its own warning is the strongest argument
  that a bound belongs in the data and on the picture.
- **The 240 px track cap.** Not the problem, as both documents say; C5 replaces it as a consequence of the width
  policy, not as a finding.
- **The preview checkbox.** Stays exactly as it is. It is the only producer of `refused`, and this plan does not
  pretend otherwise.
