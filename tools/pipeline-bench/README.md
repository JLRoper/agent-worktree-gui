# The pipeline bench

Four tiny pipeline definitions and the scenarios that say what each one must do. `tools/bench-pipeline.mjs` walks
them — one real queue task per scenario, every stage boundary crossed by `Assistant.sweepQueues()` — and reports, per
pipeline and per stage, whether the assistant **staged**, **gated**, **queued** and **bounced** correctly.

```
node tools/bench-pipeline.mjs                      # walk all five scenarios, write the ledger + report
node tools/bench-pipeline.mjs --only gate-reject   # one scenario (or a pipeline id)
node tools/bench-pipeline.mjs --no-write --keep    # print, write nothing, keep the sandbox trees
```

The tool reads these two files on every run. It does not rebuild them, so an edited definition is the definition the
next run walks; the checked-in report under `docs/reviews/pipeline-bench/` is the output of the last run.

## What is here

| file | what it is |
|---|---|
| `bundle.json` | one panel bundle (`bundleVersion: 1`) holding the four documents below. It loads whole through `lib/pipeline-bundle.js`; the panel could import it. |
| `scenarios.json` | the bench's claim about each document: the task title, the decider's verdicts, and the expectation (stage order, visits, crossings, parks, end state). `loadBench` refuses a scenario that names a stage, edge, gate or route the bundle does not hold. |

## The four documents

- **`bench-handoff`** — `draft → stage`, one sequence edge. The first stage stages the work; the second receives it;
  the row finishes on the last stage's own verdict because its artifact is not a pull request. This is the plain
  handoff the other three are built on. Scenario: `handoff`.
- **`bench-gate`** — `draft → review → publish`, with `G1` after `review` routing `accept → H-02` (on to publish)
  and `reject → H-03` (the capped loop back to draft). The gate declares a per-round record,
  `bench/verdict-{{round}}.json`, so round 2 is asked its own question rather than reading round 1's answer.
  Scenarios: `gate-accept` (one park, no bounce) and `gate-reject` (park, bounce to a second draft, review again,
  accept).
- **`bench-queue`** — `queue-a → queue-b`, filed behind a row that is already running. The queue starts only its
  front row, so the pipeline must wait, name the row it waits behind, and start when that row settles. Scenario:
  `queue-behind-live`.
- **`bench-ping-pong`** — `ping ⇄ pong`, with a capped loop in each direction (`2 rounds`). The row must go back and
  forth until one cap is spent, then park for a decision. Anything past five starts is the loop this document exists
  to catch. Scenario: `ping-pong`.

## What the report's words mean

- **staged** — a stage run was started by the panel, settled `done`, and left the artifact the document declares in
  the tree, hashed to the bytes the seat wrote. The report names the stage run (`pipeline/stage#visit`), the job and
  the thread.
- **gated** — the row parked on a gate's decision record (`waitingFor.kind: "gate"`), the decider wrote the record
  while it waited, and the next sweep crossed it. The report names the gate, the record path, the outcome and the
  step of the park.
- **queued** — the row stood at its first stage while a live row ahead of it was the queue's front, and started
  nothing. The report names the row it waited behind and how many sweeps it waited.
- **bounced** — a gate's verdict routed the row along a loop edge back to an earlier stage, entering that stage a
  new visit. The report names the gate, the outcome, the edge and the step it entered.
- **FAIL** — the walk left the document: a start out of order, a stage entered without an edge, a gate crossed
  without waiting, a verdict that went forward instead of back, a cap that did not stop the row, a row that stayed
  queued with a start owed. Every failure names the row, the run and the step.

## Adding a document

Add the pipeline to `bundle.json` (it needs stages, each with an artifact; a gate needs `after`, `artifact` and — if
its stage has more than one way out — a `decision` with `outcomes` and `routes`), then add its scenario to
`scenarios.json`. Run the bench; a scenario the document cannot answer is refused before a task is filed.
