# Critique — the pipeline flow's architecture document

**Scope.** `docs/reviews/pipeline-flow-architecture.md` at `d3b3954` (361 lines), judged against the code it cites,
re-read at the same commit: `public/pipeline-flow.js` (297 lines), `public/pipeline-modal.js` (369),
`public/style.css:3972-4082`, `lib/pipeline-bundle.js` (391), `lib/pipeline-window.js` (250),
`lib/task-pipeline-drive.js` (452), `lib/task-pipeline.js`, the two presses (`public/app.js:20064-20097`,
`public/assistant.js:3228-3300`), `test/pipeline-flow.test.js` (183) and `tools/verify-pipeline-flow.mjs` (376).
The question is not whether the document is well argued — it is, and it is the best-written review in this folder —
but whether its recommendation follows from its own evidence, and whether the prices it quotes are the prices.

**Snapshot.** `d3b3954`, this branch's base. The document has not moved since `8371146`. Its snapshot claim holds:
`git diff --stat db52ecd..2bc4dcf` over the six files it says it measured is empty. Line numbers below are this
tree's. `node --test test/pipeline-flow.test.js` is 11 tests, all green; `npm test` is 1 342, all green.

**Method.** Read, and where a claim was arithmetic or a regex, executed rather than argued. Three things were run:
the arc formula recomputed against the seed's own columns; the test file's markup regexes run against the shipped
string and against the two markup changes the document's own phases require; and the stage driver walked over
`pipeline-bundle.seed.json`. No browser was driven, so no measurement of the document's is overturned by a
re-measurement — where a figure could not be reproduced I say so and leave it standing.

---

## Verdict

**Adopt-with-changes: keep the diagnosis, take the vocabulary table as the spec, and reject the recommendation as
the first move.**

The document's central observation is correct and it is worth the whole review: the chart carries sequence and not
state, every High finding is a state problem, and the picture cannot answer "what is it waiting on" because it has
nowhere to put the answer. That is true, it is evidenced, and it is the thing stages 3 and 4 should build.

What does not follow is the technology verdict — *"DOM plus CSS is the right technology for the stage boxes and the
wrong one for the structure between them"* — and the phasing that puts a new geometry layer first. Three reasons,
each taken from the document's own findings:

1. **Four of its five High findings need no coordinate system.** F1 (index-derived marks) is a reading of the
   record. F2 (a gate with no state, no accessible name) is markup and a `data-` attribute. F3 (a cap that cannot
   say "2 of 3") is a field the model does not carry. F4 (nothing focusable) is `tabindex` and a focus card. Not
   one of them is fixed by `x(i)`, and all four are fixed without it.
2. **The two findings that do need geometry are priced at one pseudo-element each.** F5 (`return` edges) and F8
   (the stub's 18 px) are the only two that are genuinely about owning coordinates, and F8 is a one-line CSS fix
   while F5 is one more shape below the rail. The document says this itself, under alternative 1, and then does not
   let it move the verdict.
3. **The document already concedes the point and buries the concession.** "If only one phase can land, land 3: a
   plainer drawing that tells the truth beats a beautiful one that draws a looped pipeline wrong." That sentence is
   the plan. It appears at the end of the migration section as a hedge, when it should be the first line of the
   recommendation, because it says the technology change is not the priority.

So: adopt the analysis, adopt the vocabulary, adopt the acceptance tests (they are excellent and testable), and
reverse the order — the drawing learns to tell the truth in the DOM it has, and the SVG layer waits for an edge
shape the grid provably cannot draw. Today there is no such shape in the data; the seed's three loops are all
one column, and a one-column loop is exactly what the current CSS draws.

---

## What the document gets right

Worth stating, because a critique that only lists errors is a worse guide than the document it attacks.

- **The line cites are exact.** Fourteen of them were spot-checked against `public/style.css:3972-4082` and
  `public/pipeline-flow.js`, including every style cite in the numbers table (`:3979`, `:3985-3989`, `:3996-3998`,
  `:4014-4015`, `:4017`, `:4018-4019`, `:4025-4027`, `:4033-4040`, `:4053`, `:4061`) and all of them land on the
  rule they name. This is rarer than it should be and it is why the document can be attacked at all.
- **F1 is right.** `marksFor` (`public/pipeline-flow.js:149-163`) returns `done` for every stage before the current
  index. After a loop back to S8, S9 — which ran — is drawn `not-reached`. Verified.
- **F2 is right, including the sharp half.** Every notch sits inside `<span class="pflow-link" aria-hidden="true">`
  (`public/pipeline-flow.js:190-196`), so the `aria-label` written on it is unreachable. And `refused` has no
  producer outside the preview checkbox: `public/assistant.js:3288` passes `{ stage: current.id }` and nothing
  else. Verified.
- **F4 is right.** No `tabindex` exists anywhere in the renderer. Zero focusable elements inside the drawing.
- **F6 is right about the three readers**, and the load-time check confirms the loader allows two gates after one
  stage (`normaliseGates` has no uniqueness rule on `after`): `fromBundle` keeps the last (`:91-95`),
  `gateEnding` in the window takes the first (`lib/pipeline-window.js:67-70`), `gateAfter` in the driver takes the
  first that declares a decision (`lib/task-pipeline-drive.js:147-150`).
- **The vocabulary table is the best artifact in the document.** Six words, what the data says, what the picture
  must show, what it shows today. If stage 3 takes one thing from stage 1, take that table — it is a spec, and it
  is written in the form a test can be derived from.
- **The instinct to file what it checked and rejected** is right, and the "Mermaid is not misused" entry is a
  correct judgement about a 2.5 MB dependency.

---

## The price is wrong, and wrong in the direction that favours the recommendation

The document's cost accounting is the part a reader is most likely to act on, so it is the part that has to hold.

| the document says | what the code says | effect |
|---|---|---|
| "about 95 of the renderer's 297 lines are rewritten (`stageHtml`, `arcsHtml`, `markup`)" | `stageHtml` 23 lines (`:183-205`), `arcsHtml` 10 (`:236-245`), `markup` 19 (`:256-274`) = **52**; with `layout` 19 (`:216-234`) = **71** | overstated by 24–43 lines |
| "the three adapters and `marksFor` (≈120 lines) survive untouched" | adapters `:56-143` = 88, `marksFor` `:149-163` = 15 = **103** | understated by 17 lines |
| "The modal's 369 lines are not touched at all." | its own keyboard phase edits the Escape handler (`public/pipeline-modal.js:298-316`, which closes unconditionally today), the Tab trap's `TABBABLE` list (`:36`), and `paintFlow` (`:164-172`), which replaces the flow subtree and so cannot preserve a cursor inside it | the single largest line item in the recommendation is priced at zero |
| no figure at all for new code | an SVG builder, hit areas and `<g>` tabindex, a focus card (markup, wiring, CSS), zoom and `fit` controls, a scroll affordance, and — see below — a width policy that needs the container measured | the additions are not counted |

The deleted lines are the small half of it. What the table has no row for is the code the recommendation adds.

The arithmetic on deletions is a small thing on its own; the omission of additions is not. A layout that returns
`{columns, lanes, arcs, width, height}` needs `usable` to compute `colW = clamp(minColumn(n), usable / n,
maxColumn)`, and `usable` is the container's width — measured. The current stylesheet was written specifically to
avoid that: *"no measurement, no resize handler, and an arc cannot drift from the stage it joins"*
(`public/style.css:3976-3978`). The recommendation's headline benefit is "a coordinate system"; its cost includes
a `ResizeObserver` and a re-layout on every resize, and the document never says so. That is not a detail — it is
the trade the current design already made, and the document prices the alternative as if the trade were free.

**The structural error is that the prices are not comparable.** Both options need phases 3 and 4: the vocabulary,
the keyboard cursor, the zoom, the scroll affordance. In alternative 1 those gaps are the reason CSS fails; in
alternative 2 they are folded into the coordinate system as if they came with it. A fair price for option 2 is
"option 1's price, plus a new geometry layer, minus the `calc()` rules" — and the document never computes it, so a
reader comparing 1 and 2 is comparing a bill with a brochure.

---

## Three defects the document does not name, and one of them changes the verdict

### 1. The driver walks a different graph than the picture draws — on the seed, at three stages

This is the finding the document should have led with, because it is the one that makes "the chart must carry
state" a correctness problem rather than a legibility one.

`nextStageOf` takes **the first handoff leaving a stage, whatever its kind**
(`lib/task-pipeline-drive.js:172`): `handoffs.find((h) => h.from === stageId)`. The seed's S9 has two edges, and
the loop is first:

```
H-10  S9 -> S8   kind: loop       cap: "3 rounds (P-50)"
H-11  S9 -> S10  kind: sequence
```

Walked over `pipeline-bundle.seed.json`, the driver answers:

```
S8  -> S9   (H-09)
S9  -> S8   (H-10)          <- the loop, every time
S10 -> S9   (H-12)
S12 -> S11  (H-15)
S9 with 3 crossings -> pipeline-cap
```

So the seed's 13-stage pipeline can only ever oscillate S8↔S9 and then park at the cap. S10, S11 and S12 are
unreachable by the driver, and the cap is not "the loop's bound" — it is the only exit from S9. Meanwhile the
drawing shows a rail with S9 and S10 adjacent and connected, which is a claim that the next step is S10, and it is
never true. The picture and the driver disagree about the graph, and the picture is the one that is wrong.

Nothing in the recommendation fixes this. A coordinate system draws the same wrong claim more precisely, and the
`layout()` the document proposes would take `flow.loops` — the loops the *renderer* kept — as its input, so it
would encode the renderer's reading of the graph rather than the driver's. The document's own opening line — "the
data model is already a graph and the picture is a straight line" — is right, and it stops one step short: the
*driver* is not walking that graph either, and it is the driver that decides where the task goes next.

**Consequence for the plan:** the first question stage 3 must answer is not "how do we draw an edge" but "which
edge does a stage leave by". Until a stage with a loop edge can also take its sequence edge, the chart is being
asked to draw a machine that does not run.

### 2. A gate after the last stage is drawn as a barrier and is never consulted

`nextStageOf` returns `{ ok: true, done: true }` when there is no next stage (`:178`) — **before** it looks for a
gate (`:183`). So a gate after the final stage is a notch the drawing shows, with an `aria-label` that says "gate
after X — the last stage" (`public/pipeline-flow.js:190`), for a gate the driver cannot reach. A UAT sign-off that
could return the task for rework is, today, decoration on both sides.

The document sees this object twice and calls it an overflow: F8 is "the last stage's gate stub overflows the
canvas by 15 px", and the code's own comment ("so the gate that ends the whole pipeline is still a notch on a
connector rather than a fact the drawing dropped") is quoted approvingly. The pixel defect is real and is the
cheapest thing in the review to fix. The truthfulness defect is the one that matters: the picture promises a
decision the panel will not wait for.

### 3. The cap is read as the first integer anywhere in a sentence

`capOf` (`lib/task-pipeline-drive.js:92-98`) is `/(\d+)/` over the studio's free-text cap. Run against four
sentences:

```
"3 rounds (P-50)"   -> 3
"2 of 3 rounds"     -> 2      <- the document's own proposed label
"P-50, 3 rounds"    -> 50
"three rounds"      -> null   <- and a null limit means the loop is never taken at all
```

The document's F3 proposes that the arc read "2 of 3 rounds", and gives the record's `crossings` as the source of
the "n". It never says where the "m" comes from — and if a studio author wrote that sentence, the driver would read
a cap of 2. A label the driver would misparse is not a label the drawing should print.

This is the same class of defect as F1 and it is in the same layer: the picture is asked to show a number that the
model does not hold in a form anyone can trust. The fix belongs with F3 and it is a bundle-contract question, not a
rendering one — which is another argument against putting the geometry first.

---

## The one claim filed under "not a bug" that is a bug

> "The `--pflow-n`/`--pflow-i`/`--pflow-j` arc formula is not a bug. It is exact for the case it was written for
> (a loop spanning whole columns, one direction) … It is the ceiling of the approach, not a defect in it."

It is not exact, and the ceiling is lower than the document thinks. The arc is placed at

```
left  = colW * (i + 0.5) + i * gap
width = colW * (j - i)
```

so its right edge is `colW * (j + 0.5) + i * gap`, while the centre of the stage it re-enters is
`colW * (j + 0.5) + j * gap`. The two differ by exactly `(j - i) * gap` — the formula drops every gap between the
columns it spans. Recomputed on the seed's own 13-column track (78 px columns, 26 px gap):

| loop | left | width | right edge | centre of target | short by |
|---|---|---|---|---|---|
| S8 → S9 (H-10) | 871 | 78 | 949 | 975 | 26 |
| S9 → S10 (H-12) | 975 | 78 | 1 053 | 1 079 | 26 |
| S11 → S12 (H-15) | 1 183 | 78 | 1 261 | 1 287 | 26 |
| S8 → S12, if one existed | 871 | 312 | 1 183 | 1 287 | **104** |

For the seed's one-column loops the arc ends 13 px inside the re-entered box, which reads as "pointing at that
stage" and is why nobody has complained. For a loop spanning four columns it ends 104 px short — inside S11's box
when it means S12 — i.e. the arc points at the wrong stage, by a full column. The formula is exact only for an arc
of zero width.

This matters to the verdict twice. First, it means the current drawing already lies about any loop wider than one
column, and the brief names loop arcs as a thing the chart must do next — so the case is not hypothetical, it is
unbuilt. Second, it removes the document's strongest defence of the status quo: if the formula were exact for the
case it was written for, "improve inside CSS" would be defensible; since it is exact for no case with width, the
one shape the data can currently express is already mis-drawn. That is an argument for a coordinate system, and the
document had it in its hand and filed it as sound.

---

## What the tests actually pin, and why phase 2 breaks them

The document says: *"Keep the selectors that tests and gates already read. `.pflow-node` with `data-stage`,
`data-pos`, `data-mark` … `tools/verify-pipeline-flow.mjs:154-170` and `test/pipeline-flow.test.js:27-42` keep
working; what moves is where the edges are drawn, not what they are called."*

`tools/verify-pipeline-flow.mjs` does read selectors and would survive. `test/pipeline-flow.test.js:27-31` does
not — it is a regex over the serialized string, with the tag and the attribute order baked in:

```js
/<li class="pflow-node" data-stage="([^"]*)" data-pos="(\d+)" data-mark="([^"]*)"/g
/<div class="pflow-arc" data-loop="([^"]*)" data-from="([^"]*)" data-to="([^"]*)" data-cap="([^"]*)"/g
```

Run against the shipped markup and against the two changes the document's own phases require:

| markup | nodes matched | arcs matched |
|---|---|---|
| as it ships | 13 | 3 |
| `+ role="option" tabindex="-1"` after `class` (its keyboard phase) | **0** | 3 |
| arcs emitted as `<path class="pflow-arc" …>` (its SVG phase) | 13 | **0** |

So "keep the selectors" keeps nothing: the node regex fails the moment the stage box gains the role the keyboard
phase requires, and the arc regex fails the moment the arc stops being a `<div>`. Both are one-line fixes to the
test file, and the document should say so instead of claiming the tests survive untouched — a migration whose first
phase turns eleven passing tests red without warning is a migration that gets reverted.

(Also: there are **eleven** tests in that file, not twelve. `node --test test/pipeline-flow.test.js` reports
`tests 11`.)

---

## What stage 1 missed

| id | missed | evidence | why it matters |
|---|---|---|---|
| M1 | The driver takes the first handoff out of a stage, so a loop edge shadows the sequence edge | `lib/task-pipeline-drive.js:172`; seed S9 → S8, never S10 | the picture and the driver disagree about the graph; S10-S12 unreachable on the seed |
| M2 | A gate after the last stage is drawn and never consulted | `lib/task-pipeline-drive.js:178` precedes `:183` | the picture promises a barrier the panel skips |
| M3 | The cap is the first integer in a sentence | `lib/task-pipeline-drive.js:92-98`; `"2 of 3 rounds"` → 2 | F3's proposed label is one the driver would misread |
| M4 | The arc formula drops the gaps, so it is exact only for zero width | `public/style.css:4025-4026`; 26 px short per column | the document files this as "not a bug" |
| M5 | The stage box and the arc are drawn from two different notions of width (`minmax(78px, 1fr)` vs the `240px` cap) | `public/style.css:3985`, `:3989`, `:4021` | this is the actual cause of F9, and it is a width policy, not a coordinate system |
| M6 | Position mode prefers the catalogue bundle and falls back to the window model | `public/assistant.js:3276` | the same task gets a different gate notch when a request fails — F6 is a primary/fallback split, not three peers |
| M7 | The document's keyboard plan needs three edits to the file it says is untouched | `public/pipeline-modal.js:298-316`, `:36`, `:164-172` | the cost table's largest omission |
| M8 | `layout()` already exists, is already pure, and is already pinned | `public/pipeline-flow.js:216-234`; `test/pipeline-flow.test.js:96-104` | phase 1 is an export, not a build — the "geometry a test can assert" benefit is smaller than claimed |
| M9 | The `position` it proposes does not carry where the task came from, though the record does | `via` is written at `lib/task-pipeline-drive.js:258`; `public/assistant.js:3288` passes only `stage` | the document's own question 3 ("where it came from") is unanswerable by its own design |

M5 deserves a sentence more, because it is where the document's diagnosis and its prescription come apart. F9 —
"one fixed width policy serves neither end" — is not a missing coordinate system; it is two caps (a 78 px floor on
the grid, a 240 px cap on the track and again on the arcs layer) that were written in three places and never
reconciled. That is fixed by one function returning a column width, which is `layout()` as it exists plus a policy
argument. It does not need SVG, and the document uses it as evidence for SVG.

---

## The plan I would adopt

Same destination, different order. Each phase lands green and each is worth landing alone.

1. **The model carries the record** (F1, F3, M3, M9). `lib/pipeline-window.js` gains `crossings`, `waitingFor`,
   `via` and the gate's own ending; `assistant.js` passes them into `position`. No pixels change. This is the phase
   that makes the drawing capable of being true, and it is the one the document correctly identifies as outside
   `public/`.
2. **The marks read the record** (F1's visible half). `marksFor` stops inferring `done` from an index and reads
   what the record says ran. Add the looped fixture the document asks for at the end of its tests section — it is
   the single most valuable test in the review and it fails today.
3. **The gate becomes an object** (F2, M2). The notch leaves the `aria-hidden` wrapper, gets `data-state`, its own
   accessible name, and a shape as well as a colour. Decide, in the same patch, whether a gate after the last stage
   is a barrier the driver honours or a notch the drawing drops — the current answer is neither.
4. **The chart becomes operable** (F4). One tab stop, a roving cursor, a focus card, Escape layered inside the
   modal's existing capture handler. This is where the modal's three edits live, and they should be named in the
   plan rather than discovered.
5. **The width policy** (F9, F8). One function, one column width, the stub inside the track, the scroll affordance
   and `fit`. Still DOM and CSS; still no measurement beyond the one `usable` the policy needs.
6. **A coordinate system, only if 5 cannot draw it.** The trigger should be named in advance: the first edge the
   grid cannot express — a `return` below the rail, or a join where two edges enter one stage. At that point the
   document's option 2 is the right answer, priced honestly, and its own phase-2 migration is the right shape.

And one phase zero, which is not a drawing task at all: **decide which edge a stage leaves by** (M1). Until that is
settled, phases 1-5 draw a graph the panel does not run, and phase 6 would draw it beautifully.

---

## What this critique does not decide

- Whether the driver's first-edge rule or the studio's authoring is what should change. It is the same question
  from two ends and it is a contract question (`lib/pipeline-bundle.js` rule 2 already says the panel does not
  judge the graph's shape), so it belongs to whoever owns the bundle contract — not to this review, and not to a
  renderer.
- The palette for the three gate states and the spent arc.
- Whether the flow becomes an editor, and whether the two pipeline surfaces merge. The document is right to leave
  both open.
- Whether `docs/pipelines.md` §8 should be rewritten. The document notices it is stale and declines it; that is
  correct, and it is still worth its own patch.

---

## Checked and deliberately not filed

- **The 15 px / 18 px / 17 px stub figure.** The document gives three numbers for one defect: "pokes 15 px past
  the track" (verdict), "overflows the canvas by 15 px" (F8 table), "18 px of decorative line" (F8 detail), and
  "1202 vs 1185" = 17 px (measurement). The rule is `width: 18px` at `left: 100%` (`public/style.css:4015`), so
  18 is the intended number and 17 is what a scrollbar's rounding measures. Cosmetic, and not worth a finding.
- **"A 13-stage bundle with four gates and two loop arcs."** The seed is 13 stages, **five** gates and **three**
  loops (`G0..G4`; `H-10`, `H-12`, `H-15`), and the 74 px pad the numbers table reports is exactly two lanes of
  three arcs — so the measurement is of the seed and the sentence undercounts it. One word, but it is the sentence
  that tells a reader what was measured.
- **"The two loop arcs | 239 px and 180 px wide."** Not reproducible from that fixture: at the 78 px floor every
  seed arc is one column, 78 px wide. The row should be re-measured or re-captioned; it does not change any
  conclusion, which is why it is here and not above.
- **`fromDefinition`'s all-`not-reached` drawing, the lane rule, the 1120 px card cap, Mermaid's use at build
  time.** The document's four judgements here are right and I would keep all four, including the lane rule — the
  greedy assignment at `public/pipeline-flow.js:223-231` is the one piece of geometry in this file that is correct
  and it should survive whatever comes next.
- **The `aria-label` on the notch being written and then hidden.** Called out by the document as F2 and confirmed;
  listed here only to note that the fix is two lines — drop `aria-hidden` from the connector wrapper, keep it on
  the visual span — and that its "High severity / Medium effort" rating is really "High severity / two lines".
