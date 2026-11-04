# The pipeline flow: what the chart is for, and the technology that draws it

**Scope.** `public/pipeline-flow.js` (297 lines), `public/pipeline-modal.js` (369), the flow's stylesheet
block `public/style.css:3972-4081`, the two presses that open it (`public/app.js:20064-20097`,
`public/assistant.js:3228-3260`), the two models it reads (`lib/pipeline-window.js`,
`lib/pipeline-bundle.js`) and the record the stage driver now writes (`lib/task-pipeline-drive.js`). The
question: is DOM-plus-CSS the right technology for this drawing, judged against what the chart must do
next — more than two stages, loop arcs, gate notches, a moving position token, keyboard operation, zoom
and scroll, legibility at 1280 px. The answer below is a recommendation, not a survey.

**Snapshot.** Cited from `2bc4dcf` (0.111.0 plus its changelog render), this tree's base. The drawing was
measured at `db52ecd` (0.110.0), the commit the branch was cut from, and `git diff --stat db52ecd..2bc4dcf
-- public/pipeline-flow.js public/pipeline-modal.js public/style.css lib/pipeline-window.js
lib/pipeline-bundle.js test/pipeline-flow.test.js` is empty — the same lines are under both. `lib/
task-pipeline-drive.js` is new in `a71453c` and is cited from `2bc4dcf`.

**Method.** Read, and measured in a browser. A throwaway panel (`tools/panel-testkit.mjs`, dead
apiServer, assistant off) was driven in Chromium and the drawing read back with
`getBoundingClientRect`/`getComputedStyle` at 1280×800 and 1821×700: the seed's two-stage
`investigate`, the seven-stage `sefl-review-loop`, and a 13-stage bundle with four gates and two loop
arcs. Nothing was written and no panel of the reader's was touched. The attachment is this same drawing
at 1.63× (1120 CSS px of card → 1821 px), so its proportions are the ones in the numbers table, not a
different build.

---

## Verdict

**DOM plus CSS is the right technology for the stage boxes and the wrong one for the structure between
them.** Draw the structure — the rail, the gate notches, the loop arcs, the position token — as one
inline SVG layer, keep the stage boxes as DOM nodes, and compute one layout in JavaScript that both
layers read. That is the recommendation; the four alternatives and their prices are below it.

Three reasons it is the structure, and not the boxes, that has to move:

1. **The data model is already a graph and the picture is a straight line.** The studio's handoffs are
   `sequence`, `loop` or `return` (`lib/pipeline-bundle.js:51`), and gates carry an optional decision
   that makes them either a barrier or a pause (`lib/pipeline-bundle.js:219-221`). The drawing keeps
   only the `loop` kind (`public/pipeline-flow.js:83-85`) and places the rest by an edge's index
   difference. Anything that is not "an arc between two columns of a fixed grid" has nowhere to go.
2. **Geometry by `calc()` against a fixed grid cannot survive the state the chart now has to show.** The
   arc's position is
   `calc((100% - (n-1)*gap) / n * (i + 0.5) + i*gap)` (`public/style.css:4025-4027`): a function of
   column index and one global gap. It is a small miracle that it works, and it works only because every
   edge so far spans a whole number of columns in one direction.
3. **The pixel defects the reader is looking at are all in the edge layer.** The gate notch is a 3×15 px
   amber bar (`public/style.css:4017`), its colour is taken from the *stage's* mark rather than the
   gate's own result (`public/style.css:4018-4019`), the last stage's gate stub pokes 15 px past the
   track and forces a scrollbar (`public/style.css:4014-4015`; measured below), and the arcs are
   rectangles with a top border and rounded corners (`public/style.css:4021-4032`). None of that is
   fixed by restyling; all of it is fixed by giving the drawing a coordinate system.

**But the technology is the smaller half of the problem.** The chart's vocabulary is thinner than its
data. There is no mark for a gate, no "2 of 3 rounds" on an arc even though the driver now keeps
`pipelineRun.crossings` (`lib/task-pipeline-drive.js:25-30`), no position token with an age, and the four
marks are derived from the *index* of the current stage (`public/pipeline-flow.js:149-163`), which draws
a looped pipeline wrong: a stage that ran and was left is painted "not reached" the moment the task loops
back behind it. A technology change that carries all of that across unchanged is a repaint, not an
improvement. Stages 3 and 4 should treat F1, F2 and F5 below as the point of the work.

---

## Numbers

| thing | value | how |
|---|---|---|
| stage column, floor / ceiling | 78 px / 240 px, 26 px gap | `public/style.css:3979`, `:3985-3989` |
| 2-stage `investigate` at 1280 and 1821 | card 1120×248, track 506×52, node 240×52 | measured |
| … how much of the dialog that drawing uses | 45 %, 599 px of card empty to its right | measured (`track.right` vs `card.right`) |
| 7-stage `sefl-review-loop` at 1280 | node 133×52–67, track 1090 | measured |
| … its horizontal scroll | `scrollWidth` 1109 vs `clientWidth` 1094 | measured |
| … the element that causes it | `.pflow-link.is-end` right edge 1202, track right 1185 | measured |
| 13-stage bundle at 1280 | node 78×97, `scrollWidth` 1345 vs 1094 | measured |
| … columns the reader cannot see | 2 of 13, no indicator, no scroll affordance | measured + screenshot |
| … the two loop arcs | 239 px and 180 px wide, 74 px of reserved pad | measured |
| gate notch | 3×15 px | `public/style.css:4017`; measured 3×15 |
| focusable elements inside the drawing | 0 | measured (`[tabindex]` and natively focusable, in `.pflow-node`, `.pflow-notch`) |
| gate notches reachable by assistive tech | none — every notch is inside `aria-hidden="true"` | measured `closest('[aria-hidden="true"]')` = true; `public/pipeline-flow.js:192-195` |
| stage title / artifact type size | 11.5 px / 10 px | `public/style.css:3996-3998` |
| legend keys, and how many carry a count | 4; only the marks that occur | `public/pipeline-flow.js:247-254` |
| the drawing's markup | one string, `innerHTML` into a detached div | `public/pipeline-flow.js:256-274`, `:288-294` |
| a position change | replaces the whole flow element | `public/pipeline-modal.js:164-172` |
| modal card | `min(1120px, 96vw)`, body is the scroller | `public/style.css:4053`, `:4061` |

---

## What the chart is for

Not decoration, and not an editor. It is opened read-only from two places — the Pipeline tab's draft and a
queue row's flow press (`public/app.js:20064-20089`, `public/assistant.js:3228-3260`) — and its preview
control says so in words: "preview — this moves nothing" (`public/pipeline-modal.js:126`). It exists so a
reader can answer three questions in one glance, without reading the queue row's prose:

1. **Where is this task?** Which stage, how long it has been there, whether that stage refused it.
2. **What is it waiting on?** A gate's decision record, a person, or a loop's cap — the three ways a row
   parks (`lib/task-pipeline-drive.js:57-58`, `:199-222`).
3. **What has happened?** Which stages are behind it, how many rounds a loop has taken, where it came
   from.

Every later requirement in the brief is one of those three. "More than two stages" and "legibility at
1280" are question 1; "gate notches" and "loop arcs" are question 2; "the four marks" and "a moving
position token" are question 3. Keyboard operation and zoom are not questions of their own — they are how
a reader who cannot use a mouse, or who has thirteen stages, gets to the answers.

That framing is the test the technology has to pass: **can the picture carry state, or only sequence?**

---

## The vocabulary it must express

| word | what the data says | what the picture must show | what it shows today |
|---|---|---|---|
| **stage** | `{id, title, prompt, artifact, exit}` — a unit of work with a machine-checkable exit (`docs/pipelines.md:26-52`) | a cell with its ordinal, its title and the artifact it writes | a box with number, title, artifact id and a dot (`public/pipeline-flow.js:183-205`) |
| **gate** | `after` a stage, decides on an artifact, one of `sequence/loop/return` outcomes, optionally a decision record — a barrier, or a pause with no decision (`lib/pipeline-bundle.js:190-221`) | a notch on the rail *between* cells, with its own state: open, waiting on a record, refused with an outcome | a 3×15 bar coloured by the **stage's** mark, with a mouse-only `title` (`public/pipeline-flow.js:185-196`, `public/style.css:4017-4019`) |
| **handoff** | `{from, to, artifact, kind: sequence \| loop \| return, cap}` (`lib/pipeline-bundle.js:51`, `:228-258`) | sequence as the rail itself; `loop` as an arc above; `return` as an edge that goes back without being a cap | only `loop` is drawn (`public/pipeline-flow.js:83-85`); a `return` edge does not exist in the picture, and a forward-pointing `loop` is dropped silently (`:219-221`) |
| **loop cap** | a sentence in the studio's words, plus `pipelineRun.crossings[id]` on the record (`lib/task-pipeline-drive.js:25-30`, `:92-99`, `:200`) | "2 of 3 rounds" and an arc that looks spent at the cap | the cap alone, as a static label (`public/pipeline-flow.js:21-23`, `:236-245`) |
| **position** | `{stage, refused}` at the drawing's edge (`public/pipeline-flow.js:18-19`); the record also has `enteredAt` and `via` (`lib/task-pipeline-drive.js:256-258`) | a token at the current cell, carrying its age, and a refused mark tied to the gate that refused it | a colour and a dot; the age appears only as a fact line above the drawing (`public/assistant.js:3290-3294`) |
| **the four marks** | a projection of the record's history | per-stage state, from evidence | `refused` wins, then `current`, then "index < current ⇒ done" (`public/pipeline-flow.js:149-163`); `refused` itself is only ever set by the preview checkbox (`public/pipeline-modal.js:284-287`) |

Two mismatches in that table are worth stating plainly because they decide the design:

- **A gate is a first-class object in the data and a decoration in the picture.** It has an id, a name, a
  decider, an artifact and optionally a decision with outcomes; the drawing keeps its id in a data
  attribute and its detail in a `title`. Its aria-label is inside an `aria-hidden` span, so the one word
  a screen reader should hear about a gate is unreachable (`public/pipeline-flow.js:192-195`; measured).
- **"Done" is an assumption about ordering, not a reading of the record.** `marksFor` returns `done` for
  every stage before the current index. After a loop back to S5, S9 — which ran — is drawn `not-reached`.
  The four marks are right for a straight line and wrong for the graph the studio actually sends.

---

## Findings the analysis rests on

Ranked by what they cost a reader, not by how hard they are to fix. S = severity, E = effort.

| id | finding | S | E | where |
|---|---|---|---|---|
| F1 | The four marks are index-derived, so a looped pipeline is drawn wrong (a stage that ran shows "not reached") | High | M | `public/pipeline-flow.js:149-163` |
| F2 | A gate has no state and no accessible name; the notch takes the stage's colour, its `aria-label` sits inside `aria-hidden`, and the `refused` mark has no producer outside the preview checkbox | High | M | `public/pipeline-flow.js:192-195`, `public/style.css:4017-4019`, `public/pipeline-modal.js:284-287` |
| F3 | A cap is a static label; the record now carries `crossings`, so "why is it stuck" cannot be read off the arc | High | M | `public/pipeline-flow.js:21-23`, `:236-245`; `lib/task-pipeline-drive.js:25-30` |
| F4 | Nothing in the drawing is focusable: 0 elements, and gate detail is a mouse-only `title` | High | M | `public/pipeline-flow.js:183-205`; `public/pipeline-modal.js:36` |
| F5 | `return` handoffs are not drawn at all, and a forward `loop` is dropped without a note | Medium | S | `public/pipeline-flow.js:83-85`, `:219-221` |
| F6 | Two gates after one stage are allowed by the loader but three readers pick different ones: `fromBundle` keeps the last, `fromWindowModel` the first, the driver the first *with a decision* | Medium | S | `public/pipeline-flow.js:91-95`, `:139`; `lib/pipeline-window.js:67-70`; `lib/task-pipeline-drive.js:147-150` |
| F7 | No zoom, and no scroll affordance: at 13 stages two columns are off-screen with nothing saying so | Medium | M | `public/style.css:3980` |
| F8 | The last stage's gate stub overflows the canvas by 15 px and forces a scrollbar at 7 stages | Low | S | `public/style.css:4014-4015` (measured 1202 vs 1185) |
| F9 | One fixed width policy serves neither end: 2 stages waste 599 px of the dialog, 13 stages cram titles into 78 px columns | Medium | M | `public/style.css:3985-3989` (measured) |

Detail on the two that are easy to read as cosmetic and are not:

**F2.** The notch is 3 px wide, 15 px tall, amber, with a 2 px panel-coloured ring
(`public/style.css:4017`). Two of its three states are recolours of *its own stage*
(`public/style.css:4018-4019`), and the "refused" state is expressed by painting the stage red — the gate
that said no is never itself drawn as having said no. A reader asked "what is it waiting on" is pointed at
the box, which is the wrong object. The `refused` mark itself has no producer either: the record's position
is `{ stage }` (`public/assistant.js:3288`), and the only writer of `refused` is the preview checkbox
(`public/pipeline-modal.js:286`). So the fourth mark is a preview fiction today; a gate that refused a task
in the record is drawn as an ordinary current stage.

**F8.** At 1280 the seven-stage drawing fits its track (1090 px) but scrolls anyway, because the final
stage's gate stub — 18 px of decorative line at `left: 100%` — reaches 1202 px against a track that ends
at 1185. That is a scrollbar produced by a decoration, and it is the cheapest possible proof that the
drawing has no geometry owner: no element knows how wide the picture is.

---

## The alternatives, priced

**1. Stay with DOM and CSS, and improve inside it.** The cheapest option, and it is not nothing: text
wrapping, focus rings, `aria-current`, list semantics and the stage boxes' own CSS all come free, and the
existing tests that parse the markup (`test/pipeline-flow.test.js:27-42`) keep passing.
*What it costs:* the arcs stay `calc()` expressions over a fixed grid, so a `return` edge (which must be
drawn below the rail, not above it), a join where two edges enter one stage, or two gates at one notch
each need another pseudo-element and another formula. Zoom means a CSS `transform` over a grid whose
sizes are percentages of a container — workable, but every label is then re-rastered text. The ceiling is
"the same drawing, less wrong".

**2. Inline SVG for the structure, DOM boxes for the stages — recommended.** One SVG holds the rail, the
notch glyphs, the arcs and the position token; the stage boxes stay real elements positioned from the same
numbers. *What it buys:* a coordinate system — `x(i)`, `y(lane)`, `path(d)` — so every edge shape the data
model can name is drawable, including the ones it cannot draw today; a `viewBox` for zoom
without re-laying out text; hit areas and `tabindex` on `<g>` elements for the notches and the token; and
one `layout()` returning numbers a unit test can assert, which today's markup-string tests cannot.
*What it costs:* two rendering models in one component, so the layer's z-order and the box positions must
come from the same function or they drift; the SVG is a second thing to keep in the panel's palette; and
about 95 of the renderer's 297 lines are rewritten (`stageHtml`, `arcsHtml`, `markup`), while the three
adapters and `marksFor` (≈120 lines) survive untouched. The modal's 369 lines are not touched at all.

**3. Inline SVG all the way down, text included.** *What it buys:* a single coordinate system and a
picture that can be exported as one `.svg` — a real artifact for a review or a bug report. *What it
costs:* text wrapping by hand (`<text>` does not wrap; `foreignObject` is a DOM island that gives the
advantage back), truncation and line counting by measurement, and accessibility re-implemented (roles,
focus order, list semantics) where HTML gives it away. Every selector in `tools/verify-pipeline-flow.mjs`
(`:154-170`) and every regex in `test/pipeline-flow.test.js:27-42` would be rewritten.
*Verdict:* right if the chart must also be exported; not for this dialog.

**4. Canvas.** *What it buys:* pixels and speed — pan and zoom at no cost, no DOM churn at thirteen
nodes. *What it costs:* no accessibility tree, no text selection, manual hit testing and DPR scaling, and —
decisive here — the panel's own gates are DOM readers (`tools/verify-pipeline-flow.mjs:148-181`), so a
canvas drawing could not be proved by the harness that exists. Thirteen nodes need none of the speed.

**5. A layout library** (dagre, elkjs, or the Mermaid bundle this repo already vendors at 2 571 900 bytes,
`tools/vendor/mermaid.min.js`, used by `tools/render-pipelines.mjs:10-12`). *What it buys:* layered layout,
edge routing, arrowheads, and a precedent in this repo. *What it costs:* the graph is a chain with
back-edges — its layout is one-dimensional and already known (the stage's index), so the engine buys the
routing only; Mermaid renders asynchronously, has no per-node state API (state is applied by
post-processing the SVG), is not keyboard-operable, and 2.5 MB is a large price for one dialog.
*Verdict:* rejected for the dialog; keep it for the static catalogue page, where a build-time render and
an offline artifact are exactly what is wanted.

**Why not "just fix the CSS".** Because the sentence the chart must be able to draw next is "this loop has
two of its three rounds left, that gate refused on `no-go`, and the task is parked against it" — three
objects at three different places on the picture, one of them not on the rail at all. CSS can position
boxes in a grid; it cannot own a picture that has to say that.

---

## The shape that expresses the vocabulary

**The rail.** One horizontal track, one column per stage, in document order. `x(i) = i * (colW + gap)`,
computed once, never measured. `colW = clamp(minColumn(n), usable / n, maxColumn)` with a width policy
rather than the browser's: two stages get 320–360 px cells and the track is centred in the dialog; thirteen
get the 96 px floor and the track scrolls. The point of the policy is that F9 is decided in one place
instead of emerging from `minmax(78px, 1fr)` over a 240 px cap.

**Gates as notches on the rail, between columns.** A gate belongs to the edge, so its glyph sits at the
middle of the gap and is *not* part of the stage box. Three states, each with shape as well as colour:
open (a small diamond on the rail), waiting on a decision record (a hollow diamond with a short tick, and
the record's path in the focus card), refused (a filled diamond with the outcome word — `no-go` — beside
it in 9.5 px mono). A gate with no decision is a *pause* (`lib/pipeline-bundle.js:219-221`) and gets the
hollow glyph with no tick. Two gates after one stage stack along the rail; F6's three-readers problem
disappears because the drawing stops pretending a stage has one gate.

**Handoffs.** `sequence` is the rail itself — no separate line, which is what the current picture already
does well. `loop` is an arc above the rail, in a lane, labelled with its cap and its crossings
("2 of 3 rounds"); a spent arc is dashed and its label takes the refused colour. `return` is an arc
*below* the rail with a plain arrowhead and no cap: below says "this goes back", the absent cap says "this
is not a bound". Lanes are assigned by the existing greedy rule (`public/pipeline-flow.js:219-234`) —
it is correct and it is the one piece of geometry worth keeping.

**The position token.** A ring that sits in the current stage's cell, over the stage's own mark, carrying
the elapsed time in its focus card and `aria-current="step"` on the stage. Refused: the token moves to the
notch that refused the stage and the stage takes the refused mark — the picture then says *what* refused
it, which today it cannot.

**The four marks, shape first.** `not-reached` hollow dot; `done` filled dot plus a check glyph; `current`
ring plus the token; `refused` cross plus the outcome word. Colour stays the panel's language, but shape
carries the mark so a 1× screenshot, a colour-blind reader and a printed page all read the same.

**Keyboard.** The track is a single tab stop with a roving cursor (`role="listbox"`-like, stages as
`role="option"`, `aria-current` on the position). Arrow keys move the cursor; Enter opens the focus card
for the stage's gate or its loop; Escape closes the card before it closes the dialog — the modal already
owns Escape in the capture phase (`public/pipeline-modal.js:293-316`), so the card is a layer inside that
handler rather than a second listener.

**Zoom.** One scale applied to the SVG layer's `viewBox` and to the boxes' container by the same number, so
a fractional zoom is crisp for the vector and legible for the HTML. A `fit` control, because the reader's
question at thirteen stages is "show me all of it", and an edge fade at the scroller's ends so a cut
column is visibly cut rather than merely absent (F7).

**Motion.** Unchanged: `data-motion` stays on the root and the stylesheet keeps restating the rule
(`public/style.css:4044-4047`, `:4080-4081`).

---

## The implementation shape

- **Keep the boundary.** `pipeline-flow.js` is data-in, markup-out (`public/pipeline-flow.js:3-5`). The
  new renderer keeps that contract: `layout(flow, {width})` → `{columns, lanes, arcs, width, height}` is a
  pure function, and `markup()` emits the SVG layer plus the same `.pflow-node` boxes. The modal still
  calls `PipelineFlow.markup` (`public/pipeline-modal.js:114-119`) and `setPosition` still replaces one
  element (`:164-172`); nothing about focus trapping, Escape, the backdrop or reduced motion changes.
- **Keep the selectors that tests and gates already read.** `.pflow-node` with `data-stage`, `data-mark`,
  `data-pos` (`public/pipeline-flow.js:198`), `.pflow-notch` with `data-gate`/`data-gate-name`,
  `.pflow-arc` with `data-loop`/`data-from`/`data-to`/`data-cap` (`:240`), `.pflow-key` with `data-mark`
  (`:252`). `tools/verify-pipeline-flow.mjs:154-170` and `test/pipeline-flow.test.js:27-42` keep working;
  what moves is where the edges are drawn, not what they are called.
- **Delete the calc geometry.** `public/style.css:4014-4032` (link, stub, notch, arc, label) is replaced by
  SVG presentation; the mark rules `:3995-4012` and the legend `:4033-4040` stay.
- **Give the model the state the picture must draw.** `lib/pipeline-window.js` carries `gateEnding`,
  `handoffIn`, `handoffOut` and `phase` (`:86-101`) and nothing about crossings or a gate wait. Until it
  carries `pipelineRun.crossings` and `waitingFor` (`lib/task-pipeline-drive.js:65-71`, `:200`), F1 and F3
  cannot be fixed by any renderer. This is the one change outside `public/`, and it is a read-only
  addition to an existing response.
- **Tests.** Keep the twelve in `test/pipeline-flow.test.js`; add geometry assertions (`x` of stage 3, a
  lane's `y`, an arc's two endpoints), one looped-fixture mark assertion (F1's regression), and one
  accessibility assertion (the notch's accessible name is not inside an `aria-hidden` subtree — the exact
  check that fails today).

---

## Migration, in phases that each leave the gate green

1. **Layout module only.** `layout()` returning numbers, no visual change, asserted directly. The current
   markup stays; the tests prove the numbers before anything is drawn from them.
2. **SVG edge layer.** Rail, notches, arcs and their labels move into one `<svg>`; the calc rules are
   deleted; the stage boxes are positioned from `layout()`. This is the phase that changes pixels.
3. **The vocabulary gaps.** Gate states (F2), crossings on the arc (F3), `return` edges (F5), the position
   token with its age (F1's visible half) — each needs the model addition above, so it lands with it.
4. **Zoom, scroll affordance, keyboard cursor and focus card** (F4, F7).

Phase 2 is separable and is where the reader's eye will land; phases 3–4 are what the chart is *for*.
If only one phase can land, land 3: a plainer drawing that tells the truth beats a beautiful one that
draws a looped pipeline wrong.

---

## Acceptance, as stage 4 can run it

At 1280×800 and 1821×700, with `tools/verify-pipeline-flow.mjs` green and `node --test` green:

- **Visible.** Every stage, every gate, every loop and every legend key is inside the card's box; no
  element's rect exceeds its scroller's client box (this fails today: 1202 > 1187 at seven stages);
  the number of drawn stages equals the document's; at thirteen stages the scroller states how many
  columns are out of view and `fit` brings all of them in.
- **Readable.** No dead band wider than 80 px beside the track at two stages (today 599 px); no stage
  title set below 11 px; titles at thirteen stages are not squeezed under 96 px per column.
- **Truthful.** A fixture where the task has looped back draws the stages it has already run as `done`
  (today it draws them `not-reached`); an arc whose record has crossings reads "n of m"; a refused gate
  is drawn at the notch, with its outcome.
- **Operable.** Tab reaches the track once; arrows move a visible focus cursor across every stage; Enter
  opens the gate's card; Escape closes the card, then the dialog; one Esc never closes two surfaces.
- **Accessible.** Each notch exposes its gate's name to the accessibility tree (today: none do); the
  current stage carries `aria-current`; the legend's counts are named ("3 done of 13").
- **Unchanged.** Reduced motion still yields `data-motion="off"` and no animation; the position preview
  still writes nothing; the modal's z-index, focus trap and backdrop behaviour are untouched.

---

## What this document does not decide

- Whether the flow ever becomes an editor (moving a task from the chart). Every surface today is a read
  (`public/pipeline-modal.js:5-8`), and making it a control changes the modal's audit story, not its
  drawing.
- Whether the task pipeline window (`public/assistant.js:3368`) and this dialog merge into one
  surface. They carry the same model today; that is a separate decision.
- The exact palette for the three gate states and the spent arc; the panel's existing language
  (`public/style.css:4000-4012`) is the starting point, not a constraint.
- Whether `docs/pipelines.md` §8 ("UNBUILT", `docs/pipelines.md:485-511`) is rewritten: it still lists the
  catalogue, the record, the tab and the tests as missing, all of which exist at `75e648c`. Noticed while
  reading; out of scope here, and worth its own patch.

---

## Checked and deliberately not filed

- **The `--pflow-n`/`--pflow-i`/`--pflow-j` arc formula is not a bug.** It is exact for the case it was
  written for (a loop spanning whole columns, one direction), and the comment at `public/style.css:3973-3978`
  says why it was chosen: no measurement, no resize handler. It is the ceiling of the approach, not a
  defect in it.
- **`fromDefinition`'s all-`not-reached` drawing is correct.** A definition has no position
  (`public/pipeline-flow.js:17-19`, `public/app.js:20084-20086`); marking every stage grey is the honest
  answer, and the note above the drawing says so in words.
- **The lane rule is sound.** Two loops that meet on one stage cannot share a lane, and the greedy
  assignment at `public/pipeline-flow.js:223-231` gets that right; the test at
  `test/pipeline-flow.test.js:96-104` pins it. It should survive the rewrite unchanged.
- **The 1120 px card cap is not the problem.** `public/style.css:4053` caps the dialog at `min(1120px,
  96vw)`; the reader's picture is that card at 1.63×. The dead space at two stages comes from the track's
  own width policy (F9), not from the card being narrow.
- **Mermaid is not misused.** `tools/render-pipelines.mjs` renders a static, offline, dated artifact from
  the catalogue; that is the right use of a build-time graph library, and it is why the dialog does not
  need one.
