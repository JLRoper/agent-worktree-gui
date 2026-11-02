# What a stage hands its agent, and what a run receives

Analysis B of three on the stage contract. One question: **what does the authoring guide require a stage
to hand an agent, and what does this panel actually hand a run today.** Analysis A
(`analysis-stage-contract.md`) reads the same twelve fields against the model one by one; this one follows
them to the wire, and stops at what a run is given.

Measured on `main` at `1251c56`, version 0.68.5. The first pass was read at `a0ecde3` (0.68.3) and every
line number was re-checked after the rebase that produced this commit. The guide is the copy under version
control beside this file — `docs/pipeline-integration/stage-authoring-guide.html`, 111,947 bytes, sha256
`dbb75d4f…`, byte-identical to
`ai-development-factory/docs/pipeline/stage-authoring-guide.html` — whose masthead says it was written
against its own `main` at `ae431e5`. Section anchors below (`#s02`, `#s04`, `#s05`) are that page's, because
the page is one long HTML body and a line number in it means nothing to a reader. Everything on the panel
side is a `file:line` on this commit.

No run was started for this analysis. Claims about the run path are read from the code that composes the
run body, and one claim about the gateway's own vocabulary was measured off-repo against the build this
host runs (§5). Where a statement is an inference rather than a read, it says so.

---

## The answer, before the evidence

The guide requires five things to reach the agent working a stage: a prompt generated from the twelve
fields in field order; an enumerated read list *and* a non-read list; one artifact with a path, a schema, a
hash and exactly one writer; a grant whose deny list is issued per stage with a TTL; and stops drawn from a
seven-code vocabulary. It then requires the agent to return one envelope whose `status` is `OK` or one of
those seven codes (`#s04` "The envelope").

The panel hands a run: a text `input` composed of the reader's brief plus a landing paragraph, a "work in
this directory" sentence, the tree's TODO block, a release brief and an optional clarify hint
(`lib/jobs.js:2147`), posted with the body's other fields — `session_id`, `cwd`, `model`, `model_options`,
and `max_turns`/`run_budget` when the caller set them (`lib/jobs.js:2158-2162`). The board assistant's own
turn adds a preamble that carries its role, rules, scratchpad and charter (`lib/assistant.js:2626-2720` via
`:2775`) — a preamble no worker run ever receives.

The stage contributes four validated fields — `id`, `title`, `prompt`, `exit` (`lib/pipelines.js:191-203`) —
of the guide's twelve. Two of those four are the contract, and **neither reaches a run**: `prompt` has a
validator and no renderer (`docs/pipelines-audit.md:546-547`), and `exit` has a closed vocabulary and no
evaluator (`docs/pipelines-audit.md:511-537`). The route that would start a stage refuses before it writes
a record (`lib/pipelines.js:650-651`, `server.js:361`, `server.js:3173-3179`).

So on every axis the guide treats as a field, the panel has either a field nothing reads or no field at all.
The rest of this document is the per-axis evidence, and the two things that *are* enforced.

---

## The five axes at a glance

| # | Axis | The guide requires | The panel has | Reaches a run? | Enforceable today |
|---|---|---|---|---|---|
| 1 | Prompt | 14 slots projected from 12 fields, in order | `prompt` string, validated for placeholders only | No — no renderer, stage start is 501 | No |
| 2 | Reads / writes | `inputs.read[]` with location + sha256, `non[]`, one artifact path | No field; a queue task's advisory `files[]`; a ref-level push guard | No | Only tree-level exclusion and the push guard |
| 3 | Grants | Deny list, per stage, with a TTL | No field, and no wire field to carry one | No | One TTL'd grant: a one-shot push permission |
| 4 | Trigger / exit | `fires` + `when` predicate; `done` as commands | `exit` only, 14 names, nothing evaluates them | No | No |
| 5 | Stops | Seven codes, each with a destination | Four gateway words + a reason string | Partly — as `failed` | None of the seven |

---

## 1. The prompt: stored, validated, never rendered

### What the guide requires

The stage file is the artifact; the prompt is a projection of it, one slot per field, in field order:

> Fourteen slots over the twelve fields — owner and inputs each split in two — in the same order as the
> fields. The bracketed names are the only places the generator substitutes; everything else in the
> skeleton is fixed. — `stage-authoring-guide.html#s05`

The skeleton it shows is not a brief. It opens `You are <owner.role>, a <owner.kind>. You work one stage:
<id> — <name>.`, carries `YOU MAY READ, AND ONLY READ`, `YOU MAY NOT READ`, `START ONLY WHEN`, `THE RULES
THAT BIND THIS WORK`, `METHOD, IN ORDER`, `YOU PRODUCE EXACTLY ONE ARTIFACT`, `DONE MEANS EVERY LINE BELOW
IS TRUE, WITH ITS OUTPUT RECORDED`, `YOU STOP, AND SAY SO, WHEN`, `YOU NEVER`, and closes with the envelope
fields and three prohibitions — do not choose the next stage, do not summarise, do not do work you were not
given (`#s05`). The page is explicit that the correspondence has to be exact: "A slot with no field is an
instruction nobody can review" (`#s05`, "The mapping, one to one").

### What the panel stores

A stage is four fields, and the validator is the whole of what happens to them:

- `id`, `title`, `prompt`, `exit` — `lib/pipelines.js:191-203`. Owner, purpose, inputs, trigger, binds,
  method, artifact, stops and forbidden have no key the validator knows: a definition that carries them
  survives the load (`readPipelinesFile` keeps each stage as `{...s, id}`, `lib/pipelines.js:283`) and not one
  of those keys is validated, rendered, or read anywhere.
- `prompt` is checked for one thing: that it is non-empty and that its `{{holes}}` are in the closed list
  of eleven (`lib/pipelines.js:197-202`, list at `:83`). `promptPlaceholders` and `unknownPlaceholders`
  (`:94-102`) are the only two functions that touch a prompt, and both are validation.
- Nothing substitutes a placeholder anywhere in `lib/`, `server.js` or `tools/`. Confirmed by reading, and
  already recorded in the audit: "`PROMPT_PLACEHOLDERS` is only a validator … and no code replaces `{{…}}`
  in a stage's prompt" (`docs/pipelines-audit.md:546-547`).

The seed shows what this buys: `local/work` is a hand-written paragraph that defers to a LANDING paragraph
the string does not contain (`pipelines.seed.json:14`), and `sefl-review-loop/approve` is a prompt that says
"Nothing to say: wait" with an exit the panel cannot read (`pipelines.seed.json:196-199`). Both are valid
data. Neither is a packet.

### What a run receives instead

The one place a worker's input is composed is `lib/jobs.js:2147`:

- the landing paragraph (`kindLine`, built at `:2136-2141` from `lib/branch-policy.js`),
- the caller's `prompt`,
- `Work in <dir> — run cd "…" before your first terminal command` (`:2147`),
- the scratch-directory sentence (`:2145`),
- the tree's TODO block, with ids (`:2109`, `:74`),
- the RELEASE brief (`:2113`, text at `:80-85`),
- and, after all of it, the clarify hint (`:2157-2158`).

`body.input` is then `pre + anchored + clarifyHint`, where `pre` is a preamble **only when the caller passed
one** (`:2151`, `:2158`) — and the only caller that passes one is `Assistant.say`
(`lib/assistant.js:2775`). A worker run has no preamble; what it has is the appendix above, which is the
panel's own paragraph about the tree rather than the stage's about the work.

The assistant's preamble is the panel's existing machinery for "a standing packet", and it is worth naming
what it carries, because it is exactly the shape the guide asks a stage to project: its role
(`lib/assistant.js:2654`), its own saved role prompt (`:2657`), the queue directive and digest
(`:2663-2665`), autonomy and spawn mode (`:2672-2673`), the projects it may spawn in (`:2680-2681`), the
twelve standing rules clipped to 200 characters each (`:2687-2688`), the scratchpad clipped to 1200
(`:2690-2691`), the charter in full (`:2695`), its watches (`:2697-2700`), the board digest (`:2713-2714`),
the action grammar (`:2716`) and two closing rules (`:2717-2718`). It is bounded on purpose ("a preamble
that grows into a briefing is a preamble nobody reads", `:2620-2621`). None of it is a stage's; all of it is
the board assistant's, and a worker never sees it.

### The panel's own document says the opposite

`docs/pipelines.md:131-133`: "**The prompt is the stage's whole instruction.** It is handed to the worker as
the turn's text … and the panel does not append a second paragraph of its own." The panel appends five
(landing, work-in, TODO, RELEASE, clarify hint). That sentence describes a run path that has never existed,
and it is the sentence the rest of the document is written on top of.

### Exists / stub / would have to be built

- **Exists**: the stage's `prompt` as validated data; the single composition point (`lib/jobs.js:2147-2158`)
  that any renderer would have to feed; the closed placeholder list with a refusal for unknown names.
- **Stub**: the prompt itself. It is stored, checked and never used. The switch that would hand it to a
  worker is refused with `501 no-turn-start` before the record is written, twice over:
  `PIPELINE_SWITCH_STARTS_TURN = false` (`server.js:361`), the route's own "NOT here yet" comment
  (`server.js:3111-3119`), `storeSwitch`'s first branch (`lib/pipelines.js:650-651`) and the card's
  explanation of the refusal (`server.js:3173-3179`).
- **Would have to be built**: a renderer that refuses on a hole that resolves to nothing
  (`docs/pipelines.md:128-130` requires the refusal, not an empty substitution); a run-start that takes the
  rendered stage prompt; and a decision on order — the appendix before the prompt, or after it.

**Smallest honest change.** One function that returns the run's text from a stage definition plus the
tree record, and is the only producer of `body.input`; the panel's anchor block appended after it, never
before, with a hole that resolves to nothing refusing the start. The property that buys is the one the guide
asks for: what the agent was given is a diff of the definition (`#s05`), not a paragraph someone wrote
beside it.

---

## 2. Reads and writes: two literal-path schemes, neither of them a boundary

### What the guide requires

`F05 inputs` wants an enumerated list, each entry with artifact, schema, location, sha256 and mutability,
plus a `non:` list, because "the list is also a non-list: what the stage may not read is part of the field"
(`#s02`, F05). The locations are literal, scheme-qualified strings, not prose:

```
location: "ledger#L-0042"                      sha256: "9f2c…"
location: "oracle://<schema>#all_tab_columns@<snapshot-id>"
location: "bitbucket:IT/<repo>@<sha>"
```

`F09 artifact` is the write side: one artifact, `path: "ledger/verdicts/V-0001.json"`, a schema, a hash
computed on write, and exactly one writer (`#s02`, F09). The rubric's C4 and C8 make it a hard boundary:
"every input has a schema, location and hash; the export is read-only; additions are a breach" (`#s03`), and
the anti-pattern is named — "The input that is a path. A branch head, a repository, 'the previous stage' —
the same packet run tomorrow reads different code" (`#s07`, AP-04).

### What the panel has

- **In a stage: nothing.** No `inputs`, no `non`, no `artifact` (`lib/pipelines.js:191-203`). The only path
  a stage may carry is `exit.path` for the `file-exists` check (`lib/pipelines.js:77`), which is a claim
  about the tree, not a grant to read it.
- **In the queue: a file list that is a label.** A task carries `files[]` (`lib/assistant/queue.js:170`),
  normalised to one comparable form (`:74-86`), compared by boundary match so that `lib/a.js` and `lib/ab.js`
  are not a clash while `lib/assistant.js` and `lib/assistant` are (`:91-106`), and used to derive a
  `conflict`/`skipped` pair (`:477-487`). It is explicitly advisory: "a queued task that touches a running
  task's files is still queued, just shown as skipped" (`:16`). The two call sites of `decorateTasks` are the
  digest and the queue briefing (`:560`, `lib/assistant.js:671`); nothing refuses a start on it.
- **At tree level: a real exclusion.** `liveRunIn` returns the live run whose `cwd` or `ownerPath` is the
  tree (`lib/refresh-row.js:134-143`), and the two places that would start a second run refuse on it —
  `server.js:1992-1994` with a 409, `server.js:4344-4349` as the refresh pass's recorded refusal. That is one
  writer per *tree*, which is the panel's strongest file-shaped rule — and it is coarser than one writer per
  *artifact*.
- **Writes: a ref, not a file.** The push guard is installed at cut (`lib/jobs.js:2045-2063`), keyed on the
  project's `remoteBranchPolicy`, and answered by `remoteWrites.decision` (`lib/remote-writes.js:100-113`).
  It bounds `git push`. It says nothing about which paths a run may write.
- **After the fact: an inventory.** The card's "N files" list is built from `write_file` results and the
  untracked files `git status` reports, filtered by an extension whitelist (`lib/jobs.js:214-222`). It is a
  report about what was written, not a boundary on what may be.
- **And the directory itself is not applied.** The gateway this panel posts to does not advertise
  `run_cwd` (measured, §5), `docs/hermes-run-cwd.md:7` says "stock Hermes ignores it", and the panel repeats
  the directory in the prompt for exactly that reason — "Sending `cwd` is not proof that the gateway applied
  it to tools" (`lib/jobs.js:2084-2087`). The panel's file boundary is, at the last mile, a sentence.

### Exists / stub / would have to be built

- **Exists**: a tested overlap comparison over claimed paths (`lib/assistant/queue.js:98-106`); a tree-level
  exclusion that is enforced (`lib/refresh-row.js:134-143`); a ref-level write guard that is enforced.
- **Stub**: the queue's `files[]`. The claim is collected, normalised, compared and displayed — and the
  worker starts anyway.
- **Would have to be built**: `inputs.read[]`, `inputs.non[]` and `artifact` (path, schema, hash, writer) in
  the stage schema; resolution of those locations against a tree record; and a per-run file-write boundary
  in the runner, which does not exist on either side of the wire (§3).

**Smallest honest change.** Make the conflict that is already computed a refusal at the one place a run
starts: the spawn path answers 409 with the blocking task's id, and the claimed paths ride into the run's
input as one boundary sentence. That makes *a* file list enforceable at the granularity the panel actually
has — a task — and leaves the guide's literal-path read list as a second, separate build rather than
something a stage record can pretend to have.

---

## 3. Grants: a deny list with a TTL, and a runner with no field to carry it

### What the guide requires

> The deny list is the architecture. Indicative grants; the control plane issues them per stage with a TTL.
> — `ai-development-factory/docs/pipeline/agents.md:391-393`, quoted by the guide at `#s04` "The grant"

The grant is per role and per stage, it is an allow *and* a deny (Implementer: write its module and its
tests / not contracts, boundaries, frozen files, the layer), and the guide's A3 criterion makes it the test
of a boundary: "Every line is Enforced by a grant, hash or check, or Judged with the alternative named"
(`#s04`). Four roles are forbidden outright, including an orchestrator that can pick the next stage
(`#s04`, and `ai-development-factory/docs/pipeline/agents.md` §12).

### What the runner can enforce

The panel's run body has five fields — `input`, `session_id`, `cwd`, `model`, `model_options` — plus
`max_turns` and `run_budget` when the caller set them (`lib/jobs.js:2158-2162`). There is no tool, toolset,
allow-list or deny-list field. Measured against the build this host runs, `/v1/capabilities` advertises 31
feature keys and none of them is a tool policy; the endpoints it lists include `toolsets` and `skills` beside
the run and session routes (§5). The gateway can *describe* a toolset; nothing in the run body selects one, so
a grant has no wire to travel on.

What the panel does own, and what each thing can actually say no to:

| Mechanism | What it is | Bound | Keyed to | `file:line` |
|---|---|---|---|---|
| `remoteWrites` | a one-shot push permission, consumed by the write | 300 s answer window, fail-closed on timeout; one use | a **tree** | `lib/remote-writes.js:77`, `:83`, `:109`, `:115`, `:393-395` |
| `Approvals` | the host's tool-approval transport, human side | `ttlMs` 300 s, digest-bound per request, deny on timeout | a request id | `lib/approvals.js:11`, `:28`, `:42` |
| `Locks` | a reader's tree/branch lock | until removed | a tree or a branch | `lib/locks.js:1-13` |
| `liveRunIn` | one live run per tree | for the run's life | a tree | `lib/refresh-row.js:134-143` |
| push guard | a `pre-push` hook installed at cut | per project policy | a tree | `lib/jobs.js:2045-2063` |

So the panel has exactly one grant with a TTL and a deny default — the push permission — and it is about a
command on a tree, not about a tool in a stage. The guide's object (a set of tools, per stage, expiring)
exists on neither side.

### Exists / stub / would have to be built

- **Exists**: one enforced, one-shot, time-limited grant (push); one enforced, time-limited human approval;
  one enforced exclusion (a second run in a tree).
- **Stub**: nothing, because there is no field to stub. A `forbidden` list in a stage definition survives
  the load (`lib/pipelines.js:283`) but is never validated and never read, so the closest thing to a stub is
  the seed's prompts, which phrase prohibitions as prose the model is asked to honour.
- **Would have to be built**: a per-run tool policy in the runner (upstream, and not something a panel patch
  can supply), and, before that, a grant record the panel can check at its own boundaries —
  `{stage, role, allow[], deny[], expires_at}` — because those boundaries (push, delete, second run) are the
  only ones it can enforce.

**Smallest honest change.** Stop calling it a capability and write it against the two mechanisms that
exist: every line of a stage's `forbidden` list is marked Enforced-by-the-push-guard, Enforced-by-tree-
exclusion, or Judged, with the alternative named — which is precisely what `F12` and `A3` ask for, and it
is true. A deny list the runner cannot see is a preference wearing a grant's clothes, and the panel's own
audit already found the corpus's version of that defect (`#s07`, AP-08).

---

## 4. Trigger and exit: the vocabulary the panel kept, and the one it never had

### What the guide requires

`F06 trigger` is two parts: who fires the stage, and the condition that must hold.

> `trigger: fires: control-plane when: "envelope.status == OK and all(inputs[].sha256) resolve"` — `#s02`, F06
> "Refuse: a trigger expressed as a position in a list rather than a predicate."

The prompt carries it as `START ONLY WHEN … If an input hash does not resolve, or the condition is false,
return REFUSE-INPUT and stop.` (`#s05`). The exit side is `F10 done`: "one record per line: an id, a command,
a pass condition and the evidence the command leaves", every line a command or a set operation (`#s02`).

### What the panel has

- **A closed exit vocabulary, and no trigger.** `EXIT_CHECKS` is fourteen names
  (`lib/pipelines.js:43-58`) with a per-check parameter spec (`:64-79`) — a real, validated vocabulary, and
  the best-shaped thing in the pipeline module. A stage may carry exactly one (`:203`). There is no
  `trigger` key anywhere in the module.
- **Nothing evaluates an exit.** No evaluator exists (`docs/pipelines-audit.md:511-537`), `lib/jobs.js`
  imports one function from the module (`cutPipeline`, `lib/jobs.js:41`), and `advanceStage` — the only
  function that builds a stage hop — has no caller outside `test/pipelines.test.js`
  (`lib/pipelines.js:523-534`, `docs/pipelines-audit.md:513`).
- **The seed's exits are therefore assertions about stages that never run.** `commits` on `local/work`
  (`pipelines.seed.json:15`), `file-exists` on both `conclude` stages, `pushed`/`pr-open`/`pr-merged` on
  the turnover chains, `pr-approved` on `sefl-review-loop/approve` (`pipelines.seed.json:199`). Of the
  fourteen checks, four have no data source anywhere in `lib/` and five are genuinely ready
  (`docs/pipelines-audit.md:511-537`).
- **What fires a run today** is a person or the board assistant: a POST that spawns (`server.js:3582`),
  a reply on a thread (`server.js:3690`), or a `SPAWN` line the assistant writes
  (`lib/assistant.js:3818-3868`). The nearest thing to a start condition is "no live run holds this tree"
  (`lib/refresh-row.js:134-143`). None of them reads a predicate over input hashes, and the input hashes do
  not exist to read (§2).
- **And the switch cannot start a stage at all**: 501 before the record is written
  (`lib/pipelines.js:650-651`, `server.js:361`, `:3173-3179`), so a tree cannot even enter a stage by hand
  today without the ladder spending a rung it cannot undo.

### Exists / stub / would have to be built

- **Exists**: the exit vocabulary and its validator; five checks with a ready data source (`pushed`,
  `pr-open`, `pr-merged`, `file-exists`, `command` — `docs/pipelines-audit.md:536`); the fail-closed rule
  the document already states ("a check that cannot be read … does NOT exit the stage",
  `docs/pipelines.md:107-109`).
- **Stub**: `exit` itself — a string in a catalogue that nothing reads, beside a trigger field that does
  not exist.
- **Would have to be built**: an evaluator for the five usable checks, a trigger predicate over resolved
  inputs, and one place that decides "the stage is done" which is not the model saying DONE
  (`docs/pipelines.md:110-111`).

**Smallest honest change.** One evaluator over the five checks that already have a data source, called at
exactly one point — where a run settles (`lib/jobs.js:1726 finalise`) — returning true / false / cannot-tell,
and a stage hop that only accepts true. That makes the exit the only thing that moves a stage, which is what
turns a stored check into a trigger.

---

## 5. Stops: seven codes, and the words a run actually ends on

### What the guide requires

`F11 stops` draws from a seven-code vocabulary — `REFUSE-INPUT`, `ESCALATE-AMBIGUITY`,
`ESCALATE-NO-PROGRESS`, `REJECT-SCOPE`, `STOP-BUDGET`, `RECLASSIFY`, `HANDOFF-HUMAN` — each with a
destination and, for a loop, a cap; two of the seven are success, not failure (`#s02`, F11). The source
table is `ai-development-factory/docs/pipeline/agents.md:344-362`, and the envelope's `status` is "one of
the seven stop codes, or OK" (`#s04`). The rubric's C7 is blunt about why: "a stage with no state for 'the
check could not run' has a cheap path that reads it as green" (`#s03`).

### How a run ends here

The card's word is the gateway's terminal status, mapped once and applied twice:

- `TERMINAL_RUN = {completed, failed, cancelled, interrupted}` — `lib/jobs.js:89`
- `TERMINAL_STATUS = {completed: "done", failed: "failed", cancelled: "cancelled", interrupted:
  "interrupted"}`, and anything else becomes `failed` — `lib/jobs.js:126`, applied at `:2669` and `:2887`
- the completion notice uses a narrower three-word vocabulary — `normal` / `failed` / `interrupted`
  (`lib/completion.js:33-35`), decided in `outcomeFrom` (`:91-132`)

`max_iterations_reached` is not a status; it is a turn exit reason. The gateway sets `completed=False` when
the iteration budget runs out (`$HERMES_HOME/hermes-agent/agent/turn_finalizer.py:138`) and maps "a turn
that ended without finishing" to `failed`, carrying `turn_exit_reason` on the wire whenever the turn did not
finish (`$HERMES_HOME/hermes-agent/gateway/platforms/api_server_runs.py:188-204`). The panel keeps that
reason as text in the notice (`lib/completion.js:125`, `:131`) and the card still says **failed**.

`max_turns` is not an ending either; it is the knob (`lib/jobs.js:2161`) whose exhaustion produces the
above — and on the gateway this panel posts to, `max_turns` is not advertised at all (measured above), so
the cap is ignored and the run ends at the build's own iteration budget.

The mapping, against the five words a run ends on here:

| The guide's code | What a run does today |
|---|---|
| `OK` | `done` — the gateway's `completed` (`lib/jobs.js:126`) |
| `REFUSE-INPUT` | **no state.** A missing input is a hole in a placeholder, which is only validated (`lib/pipelines.js:197-202`); a run that cannot start is a `failed` card |
| `ESCALATE-AMBIGUITY` | the clarify box, when the build carries the route (`lib/jobs.js:2598-2618`, `lib/clarify.js`); otherwise a sentence in prose |
| `ESCALATE-NO-PROGRESS` | **no state.** A second failed run is just a second `failed` card |
| `REJECT-SCOPE` | **no state.** The push guard refuses a ref (`lib/remote-writes.js:100-113`), not a patch's scope |
| `STOP-BUDGET` | `failed`, with `turn_exit_reason` naming `max_iterations_reached` — or `interrupted` when the panel's wall-clock cap did it (`lib/completion.js:79-84`) |
| `RECLASSIFY` | **no state.** |
| `HANDOFF-HUMAN` | the approval box — "a wait state with a timeout and a record" (`lib/approvals.js:11-43`) — but keyed to a command, not a gate |

| The task's word | What it is | Where |
|---|---|---|
| `done` | the gateway's `completed` | `lib/jobs.js:126` |
| `failed` | the gateway's `failed`, **and** every unmatched status | `lib/jobs.js:126`, `:2669`, `:2887` |
| `cancelled` | a stop, from the panel or another surface | `lib/jobs.js:126`, `:3521-3532` |
| `max_iterations_reached` | a reason string on a `failed` result, not a status | `$HERMES_HOME/hermes-agent/agent/turn_finalizer.py:138`; `lib/completion.js:131` |
| `max_turns` | a request field the gateway ignores; not a status at all | `lib/jobs.js:2161`; measured above |

`interrupted` is a fifth word the panel has and the task's list omits: it is how the panel says *it* ended
the turn, and `lib/completion.js:104-109` is careful to keep it distinct from `failed`. That distinction is
the panel's own version of the guide's point that "something other than the turn finishing ended this".

### Exists / stub / would have to be built

- **Exists**: four terminal words, correctly separated; `turn_exit_reason` on the wire, already read into
  the notice; the clarify box for one code and the approval box for another, both with a timeout and a
  record.
- **Stub**: none of the seven — the vocabulary is absent rather than stubbed. The nearest stub is
  `outcomeFrom`'s `reason`, which carries the code string and folds it into `failed`
  (`lib/completion.js:131`).
- **Would have to be built**: a per-run outcome record written from the terminal event (status, reason,
  code), the mapping from the runner's words to the seven, and a stage hop that accepts only `OK`.

**Smallest honest change.** Map the one code the wire already carries — a `turn_exit_reason` beginning
`max_iterations_reached(` → `STOP-BUDGET` — inside `outcomeFrom`, and let that outcome rather than `failed`
be what a stage hop reads. One branch and one condition, and "the run ran out of budget" stops being
indistinguishable from "the run broke", which is the exact flattening C7 exists to prevent.

---

## Where the five axes meet

Every axis ends at the same two missing ends of the last mile: **a run-start that reads the stage**, which
is refused today (`lib/pipelines.js:650-651`), and **a run-settle that writes the stage back**, which has no
evaluator (`docs/pipelines-audit.md:511-537`) and no caller (`lib/pipelines.js:523-534`). Both are recorded
as missing in the design document's §8 (`docs/pipelines.md:455-477`) — a section that is now half stale (the
catalogue, the loader, the record, the chip and the route all exist, as the audit's P1-13 notes at
`docs/pipelines-audit.md:419-427`), but whose two load-bearing lines, "no exit-check evaluator" and "no
chaining", are still true.

Without those two ends, any field added to the twelve is a field nothing reads. With only those two ends,
four of the five axes here become enforceable in the shape the panel already has: the prompt is what
`body.input` is composed from, the exit is what decides a hop, the outcome is what the hop reads, and the
file list is what the spawn path refuses on. The grant is the one axis that needs the runner to change, not
the panel.

### What is enforceable today, versus aspirational

| Axis | Enforceable today | By what | Aspirational because |
|---|---|---|---|
| Prompt | No | — | no renderer; stage start is 501 |
| Reads / non-reads | No | — | no field; a task's `files[]` is a label |
| Writes | **Partly** | one run per tree (`lib/refresh-row.js:134-143`); the push guard at ref level | no artifact path, no per-file scope |
| Grants | **One line only** | the one-shot push permission (`lib/remote-writes.js:83-115`) | the runner takes no tool policy |
| Trigger / exit | No | — | no evaluator, no caller, no trigger field |
| Stops | No | — | four gateway words; none of the seven |

Two things a stage can rely on today, and both are the panel's rather than the stage's: **one live run per
tree**, and **a push that is either permitted once or refused**. Everything else the guide calls a stage's
contract reaches no run at all.

---

## Evidence, and what would falsify it

**Read at `1251c56`, version 0.68.5** (the first pass was `a0ecde3`, 0.68.3; every reference above was
re-checked after the rebase). sha256 of the four files this rests on most: `lib/pipelines.js` `a09eaca0…`,
`pipelines.seed.json` `06c39450…`, `docs/pipelines.md` `46c2fec7…`, and the guide `dbb75d4f…` — the same
four hashes analysis A records, which is the cross-check that both analyses read the same bytes.
`lib/pipelines.js` (715 lines), `lib/jobs.js` (3711),
`lib/assistant.js` (4590), `lib/assistant/queue.js` (731), `lib/completion.js` (384),
`lib/remote-writes.js` (451), `lib/approvals.js` (87), `lib/refresh-row.js` (225), `lib/locks.js` (383),
`pipelines.seed.json`, `docs/pipelines.md` (477), `docs/pipelines-audit.md` (603), `docs/hermes-run-cwd.md`.
The guide's own sources were read at their heads: `ai-development-factory/docs/pipeline/agents.md` §9–§12.

Two commits landed between the first pass and this one, and neither changes an axis here: the placeholder
scanner now treats `{{ nope }}` as the hole `{{nope}}` (`lib/pipelines.js:85-89`, `docs/pipelines.md:123-125`),
and the panel's child cut now writes its rung (`lib/jobs.js:1522-1538`). A hole refused at save time is still
not a `REFUSE-INPUT` state at run time, and a rung written by the second cut path is still a rung no prompt
is rendered for.

**Measured off-repo, on this host:**

- `GET http://127.0.0.1:8642/v1/capabilities` — the default gateway URL (`lib/hermes-runtime.js:84`) —
  answered with 31 feature keys. None is a tool policy, an allow/deny list, or a per-run toolset selector.
  `run_cwd`, `max_turns` and `run_budget` are **absent**, so the panel's own transport probe would report
  all three false (`lib/jobs.js:596-600`) and the `cwd`/`max_turns` it sends are ignored by this build,
  exactly as `docs/hermes-run-cwd.md:7` says.
- The gateway's terminal vocabulary — `completed` / `failed` / `cancelled` / `interrupted`, with
  `turn_exit_reason` on a turn that did not finish — read from
  `$HERMES_HOME/hermes-agent/gateway/platforms/api_server_runs.py:188-204` and
  `$HERMES_HOME/hermes-agent/agent/turn_finalizer.py:138`.

**Not executed:** no run was started for this analysis, so nothing here is a claim about what a live model
would *do* with the text it is handed; every claim is about what is composed, sent and read back.

**What would falsify this document:** a `body.input` built from a stage definition — a `POST /v1/runs` whose
input contains a rendered `pipelines.seed.json` stage prompt, or a route that returns anything but 501 from
`POST /api/worktree/pipeline`. Neither exists on this commit.
