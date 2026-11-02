# The stage contract against the panel's pipeline model

Analysis A of 3 — **evidence only**. What the panel's pipeline model already carries of the authoring guide's twelve
stage fields and two rubrics, what it does not, and where the two models say different things. No plan, no proposed
diff, no code.

**Measured against** `b4ee813` (`origin/main` at the fetch; `package.json` 0.68.4), 2026-11-02 16:58 EST / 21:58 UTC.

**The guide** `docs/pipeline-integration/stage-authoring-guide.html`, 111,947 bytes, sha256
`dbb75d4fe83ae11a687e7af4bfe3157d61161ef0f84814abc8f93f5424581860` — a byte-for-byte copy, taken at 16:41 EST the
same day, of `C:/ProjectDevelopment/ai-development-factory/.worktrees/write-docs-pipeline-stag-b32d0e/docs/pipeline/stage-authoring-guide.html`,
before that worktree was evicted. The copy is under version control beside this file so every citation stays checkable.
The guide states its own corpus baseline as `ae431e5`.

**This side**, sha256 of the four files measured: `docs/pipelines.md` `46c2fec7…`; `lib/pipelines.js` `a09eaca0…`;
`pipelines.seed.json` `06c39450…`; `docs/pipelines-audit.md` `08c6487c…`.

**On the version in the brief.** The brief named 0.68.2. The base moved twice while this ran: `a0ecde3` (0.68.3, a new
`docs/pipelines.md` §1.6 drawing the catalogue) and `b4ee813` (0.68.4, which fixes the audit's P0-5 and P0-6 — the child
cut now writes its rung, and `{{ nope }}` is refused). The 0.68.2 → 0.68.3 change touched no contract text: the whole
of it is §1.6. Every anchor below was read at `b4ee813`, not carried over from either landing.

## How a verdict is read

- **already there** — the model has a named, validated slot that answers the field's question, even if the guide's
  required shape asks for more attributes on it.
- **absent** — no slot. The nearest carrier is free prose, a different object, or nothing.
- **contradicts** — the model answers the field's question, and its answer is the opposite of the guide's required
  shape, so extending it is not enough.

Citations are `file:line` on this side and the guide's own section id on that side (`sNN fNN`, `sNN CNN`, `sNN ANN`,
`sNN AP-NN`). Ranges name the first line of a block that was read whole. The guide has no line numbers here on purpose:
its sections are the stable thing, its line numbers are not.

One structural fact belongs before the twelve blocks, because it recurs in all of them: **a stage on this side is four
keys** — `id`, `title`, `prompt`, `exit`. The design's own sample says so (`docs/pipelines.md:28-43`, "each stage
carrying a `title`, a `prompt` template and an `exit` condition", `:51-53`), the validator reads exactly those four
(`lib/pipelines.js:191-203`), and the catalogue payload strips stages to ids (`lib/pipelines.js:711`). A key outside
those four is neither refused nor read: it survives the loader only because the record is spread (`lib/pipelines.js:283`).
There are 7 definitions and 23 stages in `pipelines.seed.json`, and 23 of 23 stages carry exactly those four keys.

---

## 1. The twelve fields (guide §02, anchors f01–f12)

### f01 `id` — **already there**

**Carries.** A stage must have an id, it must be a slug, and a repeat inside one definition is refused:
`const sid = clean(stage.id);` (`lib/pipelines.js:191`), "id is required (the record names the stage it is in)"
(`:192`), "id must be a slug" (`:193`), "duplicate stage id" (`:194`). The tree record stores that string as `stage`
(`lib/pipelines.js:509`, `:530`), so the record addresses a stage by id rather than by position.

**Does not carry.** Permanence. The uniqueness set is created inside `validatePipeline` (`lib/pipelines.js:184`), so it
spans one definition, not the catalogue, and stage ids repeat freely across definitions — `commit` at
`pipelines.seed.json:48` and `:117`, `push` at `:54` and `:172`. Nothing refuses a rename, and one id is hard-coded:
`cutPipeline` writes `stage: "work"` (`lib/pipelines.js:467`) regardless of what the `local` definition's first stage is
called, so a reader who overrides `local` gets a record naming a stage its own definition does not contain.

**Disagree.** The guide's id is a permanent number — "`S<n>`, unique and never reused", and "a renamed stage keeps its
own" (s02 f01). The panel's is a per-definition slug with no rename or tombstone rule, and the one id it writes without
asking the definition is `work`. A ledger can cite the panel's stage id, but only relative to a definition, and the
definition is reader-editable.

**Verdict: already there** — a required slug id is the record's address; permanence and never-reuse are unenforced.

### f02 `name` — **already there**

**Carries.** `title` is required and non-empty (`lib/pipelines.js:196`, "title is required"), and most seed titles are
verb phrases: "Name the branch" (`pipelines.seed.json:163`), "Push the branch" (`:173`), "Answer the review" (`:191`).

**Does not carry.** The rule stops at non-empty: no word count, no verb test. The record carries the id, never the
title (`lib/pipelines.js:509`, `:513`), so there is no ledger in which the name could appear. Two shipped titles miss
the guide's own shape: "Version" is a noun (`pipelines.seed.json:124`) and "Wait for the approval at the head" is seven
words (`:197`).

**Disagree.** f02 wants one string, "identical in table, anchor and ledger" (s02 f02). The panel names a stage twice —
a display `title` and an address `id` — and nothing equates them; the chip and the record speak in ids
(`docs/pipelines.md:305`, `lib/pipelines.js:711`). The guide's named failure ("the same stage referred to three ways")
is institutionalised here as two, with no rule tying them.

**Verdict: already there** — `title` is required and is the act's name; name identity across table and ledger is
unenforced because the ledger carries the id.

### f03 `purpose` — **absent**

**Carries.** Nothing at stage level. The nearest one-liner is the pipeline's `description` — validated as a string when
present (`lib/pipelines.js:179`) and written per definition (`pipelines.seed.json:9`, "Work in this tree and stop") —
which describes the whole definition, not one stage's question.

**Does not carry.** No `purpose` key is read: the four stage keys are id/title/prompt/exit (`lib/pipelines.js:191-203`)
and `state()` reduces each stage to its id (`:711`). The prompt is operational prose with shell commands and holes
(`pipelines.seed.json:14`: "Commit what you changed in one revertable commit on `{{branch}}`…"), not one sentence
naming owner, act and artifact.

**Disagree.** f03 refuses "a purpose with no artifact in it, or a second sentence" (s02 f03). The shipped prompt is
three sentences, names no owner, and names an artifact only in some stages ("Write the conclusion down in
`docs/investigation.md`", `pipelines.seed.json:35`).

**Verdict: absent** — the stage has no purpose field, and the prompt is an ownerless instruction rather than a purpose.

### f04 `owner` — **absent**

**Carries.** No actor field. The only who-shaped facts are the pipeline's `kind` (`lib/pipelines.js:30`, a landing rung
described at `docs/pipelines.md:62-72`) and `history[].by` (`lib/pipelines.js:509`, `:513`), whose values are
`cut | reader | stage | assistant` — the mover of the record, not the doer of the work.

**Does not carry.** No `owner`, no role reference; the prompt addresses "the worker" (`lib/pipelines.js:197`). The panel
does have a role object — "A role is `{id, name, description, charter}`" (`lib/roles.js:3`) — but it is a
20,000-character charter for a board assistant, with no kind, no grant and no stage pointing at it
(`grep -n role pipelines.seed.json` returns nothing).

**Disagree.** f04 wants exactly one roster role, with its kind — agent, service, job, seat — and refuses two owners, an
unnamed owner, or an owner that also owns the stage's check (s02 f04). The panel can express none of it: no stage names
an actor, so a model cannot be barred from choosing the next stage by a field, and a service's "no discretion" has
nowhere to be stated. The panel's nearest identity object is a persona, which the guide's prompt skeleton deliberately
excludes (s05, "No persona, no encouragement").

**Verdict: absent** — no stage names a role or a kind of actor; `kind` labels the pipeline and `by` labels a transition.

### f05 `inputs` — **absent**

**Carries.** A closed substitution list of eleven holes — `PROMPT_PLACEHOLDERS = ["tree", "branch", "main", "project",
"remote", "host", "ticket", "desc", "pr", "sha", "lastSeen"]` (`lib/pipelines.js:83`) — with unknown holes refused at
save time (`:197-201`), the whitespace spelling treated as the same hole (`lib/pipelines.js:89`,
`docs/pipelines.md:123-125`), and (in the design) a hole that resolves to nothing refusing to start the stage
(`docs/pipelines.md:128-130`). Values are "resolved from the tree record and the project" (`docs/pipelines.md:118`).

**Does not carry.** No artifact, schema, location, sha256, mutability or read-only flag, and no non-input list.
`{{sha}}` is the tree's HEAD at render (`docs/pipelines.md:121`), not a hash of a declared artifact. A substitution set
cannot say what a stage may not read.

**Disagree.** The guide's 0 anchor for C4 is literally "the input is a branch, a URL, or 'the previous stage'"
(s03 C4), and f05 refuses "a path without a hash" (s02 f05). The panel hands the stage `{{tree}}` on `{{branch}}`
(`pipelines.seed.json:98`) and reads them live, so "the same packet run tomorrow reads different code" is the normal
case rather than a defect the model could detect.

**Verdict: absent** — inputs are live tree and project substitutions; no artifact, hash, mutability or non-input list.

### f06 `trigger` — **contradicts**

**Carries.** A firing rule, but no field. A cut writes `stage: "work"` with `by: "cut"` (`lib/pipelines.js:467-469`);
a switch writes the definition's first stage id (`server.js:3158`); the next stage is entered when the current exit
passes — stated only in a comment: "The exit-check evaluator (#38) is what calls this when a stage exits"
(`lib/pipelines.js:521-522`).

**Does not carry.** No `trigger`, `fires` or `when`; `advanceStage`'s whole signature is `{kind, stage, by, why, at}`
(`lib/pipelines.js:523`) — no predicate, and no input hash to predicate over (f05). The one route that would fire stage 1
is switched off: `PIPELINE_SWITCH_STARTS_TURN = false` (`server.js:361`), so `storeSwitch` answers 501 and writes
nothing (`lib/pipelines.js:651`).

**Disagree.** f06's own refusal is "a trigger expressed as a position in a list rather than a predicate" (s02 f06), and
the panel's `stages[]` is "an ordered list" (`docs/pipelines.md:51`) whose successor is simply the next element. s01's
first question — what must be true before it starts — is answered "the previous stage exited", which s01 refuses by
name ("not 'the previous stage'", s01).

**Verdict: contradicts** — the stage is fired by its predecessor's exit, the positional trigger f06 refuses, and stage
1's firer is disabled.

### f07 `binds` — **absent**

**Carries.** Nothing. No rule id of any namespace exists on this side: `grep -rn 'P-[0-9]\|SEFL-[A-Z]*-[0-9]' lib/
pipelines.seed.json docs/pipelines.md` returns no match. The nearest thing is prose naming a doctrine without an id —
"following this project's landing doctrine" (`pipelines.seed.json:62`).

**Does not carry.** No `binds`, no per-rule check string, no tag regime, no `on_fail`. A hand-written `binds:` array
would load and be read by nobody (`lib/pipelines.js:283` spreads the stage record; `:711` drops it from the payload).
The checks the panel does name are rule-free (`EXIT_CHECKS`, `lib/pipelines.js:43-58`).

**Disagree.** f07's test is "each id names the check that enforces it", and it refuses "the standards pack" as a value
(s02 f07). The panel keeps the two halves apart: its checks exist without rules, its rules exist as prose without ids,
and nothing joins them.

**Verdict: absent** — no rule slot on a stage, and an id typed into one loads silently with nothing reading it.

### f08 `method` — **absent**

**Carries.** The whole method is one free-text prompt (`lib/pipelines.js:197`, "the stage's whole instruction to the
worker"), and order, where it exists, is paragraph order — "Rename this tree's branch … Then report the new name"
(`pipelines.seed.json:164`). One seed stage states a tool and a judgement in one line: "Run `node tools/version.mjs
suggest`, judge the level against what changed" (`pipelines.seed.json:125`).

**Does not carry.** No `method`, no `deterministic:`/`judgement:` split, no `on_ambiguity`; the only mechanical element
in the record is the exit's check name (`lib/pipelines.js:43`). Nothing distinguishes a model step from a mechanical
one, and nothing renders the prompt: the only readers of `def.stages` outside the validator are the switch route taking
`stages[0].id` (`server.js:3158`) and `state()` taking the ids (`lib/pipelines.js:711`).

**Disagree.** f08 refuses "a method that names tools but not order, or a model step with no citation rule" (s02 f08).
The `version` stage does both: a tool, a judgement, no citation rule, no ambiguity route (`pipelines.seed.json:125`).
And because no renderer exists, even that prose has never reached a worker as a stage instruction.

**Verdict: absent** — the method is prose in `prompt`, with no order, no deterministic/judgement split and no
ambiguity code.

### f09 `artifact` — **absent**

**Carries.** Nothing named as an artifact. What a stage hands over is the working tree and a branch name — "Commit the
evidence on `{{branch}}` in one revertable commit" (`pipelines.seed.json:29`) — and the record carries position, not
product: `{id, stage, since, history[]}` (`lib/pipelines.js:507-515`).

**Does not carry.** No artifact id, path, schema, sha256 or writer; the module imports no hashing at all
(`lib/pipelines.js:19`). The only free-form output is `why` inside a history entry (`lib/pipelines.js:513`) — the
guide's "prose in a report" case.

**Disagree.** f09 requires one artifact with schema, location, hash and exactly one writer, and refuses "two writers,
no schema, or an artifact identified only by a directory" (s02 f09). The panel's handoff is identified by a branch
name, one step weaker than a directory, and the guide's `sha256: "<computed by the signer>"` has no counterpart.

**Verdict: absent** — no artifact contract exists; a stage hands over a branch and a prose sentence.

### f10 `done` — **already there**

**Carries.** A mandatory `exit` per stage — a single object with one `check` from a closed vocabulary of fourteen names
(`EXIT_CHECKS`, `lib/pipelines.js:43-58`), typed and required-checked parameters (`:64-79`, `:161`), a stage without one
refused with the guide's own reason ("a stage that ends when a model says it is done cannot be resumed, re-checked or
audited", `:120`), and `command` taking an argv list rather than a shell line (`:78`, `:155`).

**Does not carry.** No `check_id`, no `pass_when`, no recorded evidence: the seed's exits are bare, e.g.
`{"check": "commits", "min": 1}` (`pipelines.seed.json:15`). Nothing evaluates them — `advanceStage` has no production
caller (`lib/pipelines.js:523`; only `test/pipelines.test.js:382`), and the module says so in its own comment: "nothing
here evaluates one yet (the evaluator is a later task)" (`lib/pipelines.js:40-41`). Four of the fourteen names have no
reader in `lib/` at all — `main-moved`, `reviewers-exact`, `pr-comments`, `pr-approved` (`lib/project.js:251-265`
carries no reviewer field and no `lastReviewedCommit`; nothing records a main baseline or a last-seen event).

**Disagree.** f10 is "one record per line: an id, a command, a pass condition and the evidence the command leaves"
(s02 f10), and the worked verifier runs eight checks with ids (s06). The panel's exit is one unnamed, unevidenced check
per stage — and the design claims the panel evaluates it "from git or from the host's API, with no model in the loop"
(`docs/pipelines.md:85-86`) while §8 says there is no evaluator (`:471`).

**Verdict: already there** — the machine-checkable exit is the right field and is validated; it carries no id, pass
condition or evidence, and a quarter of its vocabulary cannot be answered today.

### f11 `stops` — **absent**

**Carries.** Prose only: "If the write is refused, report the refusal and stop" (`pipelines.seed.json:56`), "then END
the turn" (`:186`), and the permission park those sentences name.

**Does not carry.** None of the seven stop codes exists anywhere: `grep -rn 'REFUSE-INPUT\|ESCALATE-AMBIGUITY\|
ESCALATE-NO-PROGRESS\|REJECT-SCOPE\|STOP-BUDGET\|RECLASSIFY\|HANDOFF-HUMAN' lib/ docs/pipelines.md` returns zero. No
destination, no cap, and no state for "the check could not run". The panel's real refusals are HTTP answers — 409
`unknown-current` (`server.js:3152`), 409 `downgrade` (`lib/pipelines.js:503`), 501 `no-turn-start` (`:651`), 500
`not-durable` (`:658`) — each with a message, none with a destination or a cap.

**Disagree.** f11 wants a code, a condition, a destination and, for a loop, a cap, drawn from the seven-code vocabulary,
and warns that a stage with no state for "the check could not run" reads it as green (s02 f11). The panel has that hole
in numbers: `approve` exits on `pr-approved` (`pipelines.seed.json:199`), a check with no reader, so "not approved yet"
and "cannot be read" are the same state.

**Verdict: absent** — 0 of the 7 codes exist; the panel's refusals are route status codes with no destination or cap.

### f12 `forbidden` — **contradicts**

**Carries.** Must-nots, in the only channel there is — the prompt: "Do not push `{{main}}` and do not open a pull
request" (`pipelines.seed.json:29`), "Do not push yet" (`:50`), "do not merge" (`:186`), "Never push `{{main}}` directly"
(`:204`). One mechanism exists outside the record: the pre-push guard (`lib/push-guard.js:1`), keyed to the tree's
policy (`lib/remote-writes.js:24`, `:101-112`), never to a stage.

**Does not carry.** No `forbidden`, no `enforced_by`, no `judged`; not one line is mapped to a mechanism. The two
boundaries f12 says must be mechanical — a frozen manifest and a blast-radius set comparison — have no object here.

**Disagree.** f12 refuses "a must-not with neither an enforcement nor a judgement" and deletes such a line (s02 f12).
The panel keeps them as prose and then composes a landing paragraph into the same turn that says the opposite:
`branchLandingLine` returns "commit on …, push it and open a pull request" (`lib/branch-policy.js:49`) and
`lib/jobs.js` prepends it to every worker's prompt (`:2134`, `:2146-2147`) — so `github-force-merge`'s commit stage
receives both "Do not push yet" (`pipelines.seed.json:50`) and "push it and open a pull request" in one input. Where
the guard does apply it is "a speed bump on the DEFAULT path, not a lock" (`lib/push-guard.js:18-19`), it lets a
landing tree through (`:356-360`), and `WTGUI_PUSH_GRANT=1` bypasses it with a message (`:336-340`).

**Verdict: contradicts** — must-nots are unenforced prose, and one is contradicted by the landing paragraph appended to
the same turn.

---

## 2. The stage rubric (guide §03, C1–C8)

The rubric scores what is written. On this side four keys mean several criteria have nothing to score, and one of the
guide's three locked criteria (C3, with C2 and C5) has no object at all. Scores below are the panel's model, not the
seed's prose quality.

### C1 — One act — **already there**

**Carries.** One exit per stage is structural: `exit` is a single object with one `check`, an unknown parameter is
refused ("is not a parameter of the … check", `lib/pipelines.js:133`), and the design states the rule — "No composite
checks. Two conditions are two stages" (`docs/pipelines.md:112-114`).

**Does not carry.** No artifact and no method, so "one verb, one artifact, one exit" cannot be tested. The act lives in
prose, and shipped stages chain verbs behind one exit: `address` — "make the smallest change … commit on `{{branch}}`,
push, and reply on that comment" — exits on `{"check":"pushed"}` (`pipelines.seed.json:192-193`).

**Disagree.** The design's own stage tables write composites — `clean` + `commits` (`docs/pipelines.md:217`),
`pr-open` + `pr-head` (`:220`), `pr-open` + `pr-head` + `reviewers-exact` (`:238`), `pr-comments` or `pr-approved`
(`:239`) — while §1.3 forbids them (`:112-114`); the seed keeps one check and silently drops the rest (`pr-open`,
`pipelines.seed.json:138`, `:181`). Spec and data disagree inside one document, which is the criterion's 1 anchor.

**Verdict: already there** — one exit per stage is enforced (1 anchor); "one act" is undefined and unenforced.

### C2 — Done is a command — **already there**

**Carries.** A mandatory, machine-shaped exit per stage, refused at load with a stated reason (`lib/pipelines.js:120`),
ten of fourteen check names backed by a real reader in `lib/` (see the table below), and one check that is a genuine
command as argv (`lib/pipelines.js:78`; used at `pipelines.seed.json:126`).

**Does not carry.** No id per exit line and no recorded evidence: the history entry has a free-text `why` and no
outcome (`lib/pipelines.js:513`), and the evaluator that would write one does not exist (`:40-41`). Three of the 23
seed stages end on a check nothing can read (`pipelines.seed.json:150`, `:187`, `:199`).

**Disagree.** The 2 anchor asks for "an id and recorded evidence" (s03 C2); the panel has neither, and its own guard —
"the model's claim is never the exit" (`docs/pipelines.md:110`) — is currently unenforceable because nothing evaluates
the check.

**Verdict: already there** — the exit is machine-decodable and mandatory (1 anchor); it has no id, no evidence, and
four names with no reader.

### C3 — Artifact contract — **absent**

**Carries.** A record schema and one keyed store: `{version: 1, trees: {}, file, loaded}` (`lib/pipelines.js:572`),
written through `<file>.tmp` and `renameSync` (`:619-623`).

**Does not carry.** No artifact identity: no schema id, location, hash or ledger for what a stage produces. The one
free-form output is `why` (`lib/pipelines.js:513`); a stage's real product is a commit on a branch
(`pipelines.seed.json:29`).

**Disagree.** The 2 anchor is "schema, location, hash and exactly one writer; the hash is in the ledger" (s03 C3). The
panel has a schema for the *position*, two write sites for it (`lib/jobs.js:1525`, `lib/pipelines.js:609`), and no
ledger at all — the book is rewritten whole (`lib/pipelines.js:623`).

**Verdict: absent** — no artifact contract exists; a stage hands over a branch name and a prose sentence.

### C4 — Inputs frozen — **absent**

**Carries.** The closed hole list and the save-time refusal of an unknown one (`lib/pipelines.js:83`, `:197-201`), which
is name-level discipline only.

**Does not carry.** Nothing freezes anything: no schema, location, hash or mutability per input, no read-only export, no
non-input list, no "additions are a breach". `{{sha}}` is a live HEAD (`docs/pipelines.md:121`).

**Disagree.** The 0 anchor is "the input is a branch" (s03 C4), which is the panel's model exactly: the stage is handed
a working tree and told to read it ("Read, run and probe in this tree", `pipelines.seed.json:29`).

**Verdict: absent** — no input carries schema, location, hash or mutability; the inputs are the live tree and branch.

### C5 — Author ≠ judge — **absent**

**Carries.** An exit cannot be an opinion (`lib/pipelines.js:120-125`), `by` distinguishes a reader's move from a
stage's (`:513`), two check names are about another identity's evidence (`reviewers-exact`, `pr-approved`,
`lib/pipelines.js:73`; `docs/pipelines.md:100`), and the panel computes its own merge verdict from git and the host
(`lib/scan.js:262-281`).

**Does not carry.** No owner, no second role, no verdict artifact: the durable record is
`{id, stage, since, history[{from,to,stage,at,by,why}]}` (`lib/pipelines.js:507-515`), with no signature, hash or
verdict file. No exit is evaluated (`:40-41`), so the run's own end is the only sign-off the model has. And the two
checks that would read a *different* identity's judgement are dead for want of data: `normalisePr` returns
`{number, state, mergedAt, headRefName, headRefOid, title}` (`lib/project.js:251-265`), so `reviewers-exact` and
`pr-approved` cannot be evaluated as written.

**Disagree.** The guide's 1 anchor is "a separate role judges, but the instrument is writable by the producer"
(s03 C5); the panel is below it — there is no separate judging role at all, and the instrument (`git` state, the PR the
checks would read) is written by the same run that commits, pushes and opens the PR. The guide's own S4 scores 1 for
exactly the shape the panel has at best (`s03`, the scored-stages table).

**Verdict: absent** — no judging identity exists in the model, and nothing evaluates an exit yet.

### C6 — Rules bind with ids — **absent**

**Carries.** Nothing: no rule id in any namespace (`grep` over `lib/`, `pipelines.seed.json`, `docs/pipelines.md`
returns zero), and no rule tag regime.

**Does not carry.** No `binds`, no check per rule, no PROPOSED/ADOPTED handling; the save-time refusal list in the design
(`docs/pipelines.md:343-350`) has five entries and none is a rule id.

**Disagree.** The 2 anchor is "every id resolves to a check; the tag regime is stated for any PROPOSED rule" (s03 C6).
The panel's checks are named and rule-free (`lib/pipelines.js:43-58`); its rules are unnamed prose
(`pipelines.seed.json:62`). Nothing can resolve.

**Verdict: absent** — the criterion has no object: no ids, no checks bound to them, no tags.

### C7 — Stops are named — **absent**

**Carries.** Prompt prose that names a stop in words (`pipelines.seed.json:56`, `:186`) and a permission park the same
sentence names.

**Does not carry.** No code, condition, destination or cap; the stage object has no field to hold one
(`lib/pipelines.js:191-203`). "Cannot tell" exists as design prose ("It reports 'cannot tell' and the stage stays where
it is", `docs/pipelines.md:107-109`) and as ad-hoc message text, never as a state value.

**Disagree.** The 2 anchor is "each stop has a code, a condition, a destination and a cap; 'cannot run' is its own
state" (s03 C7). The panel's refusals are HTTP status codes with messages (`server.js:3152`, `lib/pipelines.js:651`,
`:658`) — the 1 anchor's "at least one has no destination or no cap", not the 2.

**Verdict: absent** — no stop codes exist, escalation is prose, and "cannot run" is not a state.

### C8 — Context is bounded — **contradicts**

**Carries.** A closed set of eleven substitutions (`lib/pipelines.js:83`), an unknown hole refused at save
(`:197-201`), and a design statement that the prompt is the stage's whole instruction and the panel appends nothing of
its own (`docs/pipelines.md:131-133`).

**Does not carry.** No input list, no non-input list, no rule subset. The prompt points at the repository — "Read, run
and probe in this tree" (`pipelines.seed.json:29`) — and the run is one thread: the turn is sent with
`session_id: thread` (`lib/jobs.js:2158`), so every prior stage's transcript is in context by construction
(`docs/pipelines.md:414`, "The thread is what makes it the same agent with the same context").

**Disagree.** The 2 anchor is "the input list is the whole world; non-inputs are named; no context holds the trifecta"
(s03 C8). The panel's model is the 0 anchor — the repository and the session — and its own sentence
(`docs/pipelines.md:414`) is the criterion's 1-anchor failure ("an adjacent role's reasoning is reachable") stated as a
feature. The design's "the panel does not append a second paragraph" (`:131-133`) is false in code as well: `lib/jobs.js`
composes the landing paragraph, `Work in <path>`, the scratch line, the todo block and the release block ahead of every
anchored prompt (`:2146-2147`), and the landing paragraph is the one the design itself calls authoritative for every
worker (`docs/pipelines.md:74-75`).

**Verdict: contradicts** — the stage's context is the tree, the shared thread and panel-composed text; the input list is
not the world and no non-input is named.

---

## 3. The agent rubric (guide §04, A1–A5)

The guide's agent rubric is about a role card. On this side there is no role card for a stage — a stage names no worker
(f04) — so these five score the panel's generic worker, not a stage worker. That is the finding, not a scoring choice.

### A1 — Capability match — **already there**

**Carries.** Capability is real and per tree: the run is anchored in the tree with a terminal (`lib/jobs.js:2146-2147`,
"run `cd "<path>"` before your first terminal command") and the host credential is a project token
(`hosts.seed.json:43`); one stage states the push command it needs (`pipelines.seed.json:56`).

**Does not carry.** No grant table on a role and none on a stage: a role is `{id, name, description, charter}`
(`lib/roles.js:3`), a stage is four keys (`lib/pipelines.js:191-203`). The grant is written at the tree and the project
(`lib/remote-writes.js:24`, `:101-112`), so it is broader than any one stage's method and is not derived from the
pipeline at all (`lib/jobs.js:2126`).

**Disagree.** The 2 anchor is "every method step maps to a grant; every grant maps to a step" (s04 A1); the panel's
grant maps to a tree, and a landing tree may push from a stage whose prompt says "Do not push yet"
(`pipelines.seed.json:50`, `lib/push-guard.js:356-360`). That is the 1 anchor — capability sufficient, grant broader
than the method.

**Verdict: already there** — capability and a grant both exist (1 anchor); neither is mapped to a method step.

### A2 — Bounded context — **absent**

**Carries.** Eleven placeholder values and a closed list (`lib/pipelines.js:83`); the context is the whole tree
(`pipelines.seed.json:29`) and the session survives between turns (`lib/jobs.js:2158`).

**Does not carry.** No input list, no hashes, no non-inputs; no such key exists on a stage (`lib/pipelines.js:191-203`).

**Disagree.** The 2 anchor is "reads exactly its artifacts plus its rule subset; the non-inputs are named" (s04 A2).
The panel's instruction is the opposite — the repository is the context and the session persists — which is the 0
anchor.

**Verdict: absent** — a closed placeholder list is not an input list; the prompt points at the repository.

### A3 — Forbidden actions — **absent**

**Carries.** Prose must-nots (`pipelines.seed.json:29`, `:50`, `:186`, `:204`) and one mechanism: the pre-push guard
(`lib/push-guard.js:1`).

**Does not carry.** No `enforced_by`/`judged` pairing anywhere, so no line can satisfy "Enforced by a grant, hash or
check, or Judged with the alternative named" (s04 A3). The guard covers push only; "do not merge", "do not decline or
close the PR" and "do not poll in a loop" have neither a rule nor an evaluator behind them
(`lib/pipelines.js:40-41`).

**Disagree.** The 2 anchor requires every line enforced or judged; the only enforced line is enforced by something that
documents its bypass and lets a landing tree through (`lib/push-guard.js:18-19`, `:336-340`, `:356-360`).

**Verdict: absent** — must-nots exist as prose with nothing behind them, which is the 0 anchor.

### A4 — Mandatory self-check — **absent**

**Carries.** Every stage has an exit from a closed vocabulary (`lib/pipelines.js:43-58`) and some prompts ask the worker
to read its work back (`pipelines.seed.json:137`, `:180`) or name the command that ends the stage (`:125`).

**Does not carry.** No command/exit-code/output-hash record and no rule→test map; the report shape is a sentence
("report what you did: the files you touched, the commands you ran and their real results", `pipelines.seed.json:14`).
The only `exitCode` in the panel is the run's, not a check's (`lib/jobs.js:1739`), and the stage exit is validated, never
run (`lib/pipelines.js:40-41`).

**Disagree.** The 2 anchor wants `{command, exit_code, stdout_sha256}` and the rule→test map (s04 A4); the panel has no
field for either and does not evaluate the exit it does have, so "green" is whatever the model says.

**Verdict: absent** — it asks for a read-back and gets a sentence; no command, exit code or output hash is recorded.

### A5 — One escalation rule — **absent**

**Carries.** Refusal-and-stop sentences (`pipelines.seed.json:56`, `:143`, `:186`).

**Does not carry.** No stop code, no attempt recorded as an artifact, no destination field — the only destination is the
word "report" (`pipelines.seed.json:56`), which means the card the reader happens to be looking at.

**Disagree.** The 2 anchor is "a stop code carries the attempt as an artifact and names the seat it goes to" (s04 A5).
The panel has the 1 anchor — a stop condition with no code — and cannot name a seat, because no stage names an actor
(f04).

**Verdict: absent** — a stop condition exists only as prose; no code, attempt artifact or seat.

---

## 4. Where the two models part company

Four differences generate most of the verdicts above, and none of them is a missing line of code.

1. **A stage is four keys against a twelve-field contract.** `id`, `title`, `prompt`, `exit`
   (`lib/pipelines.js:191-203`) answer f01, f02, f08-by-prose and f10. The other eight fields have no slot, and most of
   them are carried only as prose inside `prompt` — purpose-shaped, method-shaped, stop-shaped and must-not-shaped
   sentences. That is the
   guide's own thesis applied to this repo: the stage has been described, not designed.

2. **Position is the only dataflow.** `stages[]` is an ordered list (`docs/pipelines.md:51`), `next` is a chain into
   another definition (`:54`, `lib/pipelines.js:206-215`), and there is no stage edge, no input and no artifact
   (`lib/pipelines.js:521-522`). So the four questions s01 asks a stage — what must be true first, what one thing it
   does, what it hands over, what can fail it — each need an object the model does not have, and the answer to the
   first is "the previous stage exited", the answer f06 refuses.

3. **The worker is a persona on a shared thread.** The panel's identity unit is a 20,000-character charter
   (`lib/roles.js:3`), and every stage of a pipeline is a turn on one `session_id` (`lib/jobs.js:2158`, described as a
   feature at `docs/pipelines.md:414`). The guide's bounded context and author≠judge both fail by construction rather
   than by omission: there is no second identity to judge, and the previous stage's reasoning is always reachable.

4. **Nothing is evaluated.** The exit vocabulary is validated and never run (`lib/pipelines.js:40-41`;
   `advanceStage` has only test callers, `:523`), and the switch that would start a stage is switched off
   (`server.js:361`). So every field that assumes a machine reader — f10's evidence, f11's "cannot run", C2's recorded
   evidence, C5's separate judge — is currently a promise about the model, not a description of behaviour.

A fifth difference is about this side's own documents, and it matters for anyone using them as evidence:
`docs/pipelines.md` still says "Nothing in this page runs today" (`:457`), lists the catalogue, the loader, the record,
the route and the tests as missing (`:457-477`), says the panel evaluates the exit (`:85-86`) while also saying there is
no evaluator (`:471`), and says the panel appends no paragraph of its own (`:131-133`) while `lib/jobs.js:2146-2147`
appends several. The audit records the §8 staleness at `docs/pipelines-audit.md:419-434`. Several "carries" above are
therefore carries-in-spec: the schema exists, the behaviour behind it may not.

---

## 5. Counts

### The twelve fields

| Field | Verdict | Strongest anchor |
|---|---|---|
| f01 id | already there | `lib/pipelines.js:191-194` — required slug id, unique per definition |
| f02 name | already there | `lib/pipelines.js:196` — `title` required; record carries the id |
| f03 purpose | absent | `lib/pipelines.js:191-203` — four keys, no purpose |
| f04 owner | absent | `lib/pipelines.js:30` — `kind` is a pipeline rung; no role on a stage |
| f05 inputs | absent | `lib/pipelines.js:83` — substitutions, not artifacts |
| f06 trigger | contradicts | `lib/pipelines.js:521-522` — predecessor's exit is the trigger |
| f07 binds | absent | `lib/pipelines.js:43-58` — checks without rules; no id anywhere |
| f08 method | absent | `lib/pipelines.js:197` — prose prompt, never rendered |
| f09 artifact | absent | `lib/pipelines.js:507-515` — position, not product |
| f10 done | already there | `lib/pipelines.js:43-58`, `:120` — mandatory machine check, no evidence |
| f11 stops | absent | `lib/pipelines.js:651`, `:658` — HTTP refusals, no stop codes |
| f12 forbidden | contradicts | `pipelines.seed.json:50` vs `lib/jobs.js:2134` — both in one turn |

**Twelve fields: 3 already there, 7 absent, 2 contradicts.**

### The rubrics

| Criterion | Verdict | Anchor score on this model |
|---|---|---|
| C1 one act | already there | 1 — one exit enforced, the act undefined |
| C2 done is a command | already there | 1 — machine check, no id or evidence, 4 of 14 unreadable |
| C3 artifact contract | absent | 0 — no artifact, branch name as the handoff |
| C4 inputs frozen | absent | 0 — the input is a branch and a tree |
| C5 author ≠ judge | absent | 0 — no second identity; nothing evaluated |
| C6 rules bind with ids | absent | 0 — no rule ids |
| C7 stops are named | absent | 0 — no codes, no destinations, no "cannot run" |
| C8 context bounded | contradicts | 0 — the repository, the shared thread, appended panel text |
| A1 capability match | already there | 1 — capability and grant exist, unmapped to the method |
| A2 bounded context | absent | 0 — closed placeholders, not an input list |
| A3 forbidden actions | absent | 0 — prose must-nots, one mechanism (push) |
| A4 mandatory self-check | absent | 0 — a sentence, no command or hash |
| A5 one escalation rule | absent | 0 — prose stop, no code or seat |

**Thirteen criteria: 3 already there (C1, C2, A1), 9 absent, 1 contradicts (C8).**

**All 25 verdicts: 6 already there, 16 absent, 3 contradicts.**

The guide's pass rule is 12 of 16 on the stage rubric with C2, C3 and C5 each at 2 (s03), and 8 of 10 on the agent
rubric with A3 and A5 at 2 (s04). On the anchor scores above the panel's model would score **C: 2 of 16**, with C3 and
C5 at 0 — two of the three the guide locks — and **A: 1 of 10**, with A3 and A5 at 0, the two it locks. Those totals are a
comparison of the model as written, not of the panel as a tool: nothing here is evaluated yet, so several criteria are
scored on their schema rather than on a run.

---

## 6. The thirteen anti-patterns, cross-checked (guide §07)

"Present" means the panel's model contains the hole the anti-pattern names, today, at the cited line. "n-a" means the
object the anti-pattern critiques does not exist on this side at all, and the named object is stated — an absent object
is a different finding, not a cleared one.

| # | Guide field | The hole on this side | Verdict |
|---|---|---|---|
| AP-01 | purpose, done | one exit over several acts is legal and shipped: `address` changes, commits, pushes and replies, ending on `pushed` (`pipelines.seed.json:192-193`) | present |
| AP-02 | done | refused structurally: no stage without an exit, unknown check refused (`lib/pipelines.js:120-125`) | absent |
| AP-03 | artifact | a stage's output is a sentence plus an exit check; no schema, location or hash (`lib/pipelines.js:191-203`, `:507-515`) | present |
| AP-04 | inputs | the de-facto input list is `{{tree}} {{branch}} {{sha}}` — a path, a branch head and a commit (`lib/pipelines.js:83`, `pipelines.seed.json:98`) | present |
| AP-05 | owner, binds | no owner and no measured judge; `by` is a mover kind (`lib/pipelines.js:513`) | present |
| AP-06 | forbidden | the run that writes the work is the run whose evidence the exit reads (commits, branch, PR head); only the push is out of reach (`lib/remote-writes.js:101-112`) | present |
| AP-07 | inputs, forbidden | no instrument manifest and no hash set exists, so "edits but not additions" cannot be expressed (`lib/pipelines.js:43-58`) | n-a (no manifest) |
| AP-08 | forbidden | must-nots are prompt prose (`pipelines.seed.json:29`, `:50`, `:186`, `:204`); the guard enforces the policy, not the line (`lib/push-guard.js:356-360`) | present |
| AP-09 | stops | no stop, refusal or cap field; a stage moves only by an exit passing or a reader switch (`lib/pipelines.js:507-534`) | present |
| AP-10 | inputs, done | no oracle, no generated assertion, no provenance object (`pipelines.seed.json:126`) | n-a (no oracle) |
| AP-11 | binds | no rule citation exists to be unfaithful (`lib/pipelines.js:191-203`) | n-a (no rule citation) |
| AP-12 | binds, done | no tolerance table; the only tolerance is `commits.min`, fixed at save time (`lib/pipelines.js:66`, `:148`) | n-a (no tolerance table) |
| AP-13 | inputs, artifact | the handoff record is `{from,to,stage,at,by,why}` — no sha, no artifact version, no consumed inputs (`lib/pipelines.js:513`) | present |

**Eight present, one absent (AP-02), four not-applicable of thirteen.** The four n-a rows are the guide's own
observation read from this side: an anti-pattern about a hash set or an oracle needs the object to exist before it can
be wrong, and on this side the object is missing outright, which is f05/f07's finding rather than these rows'.

---

## 7. What the audit holds at this base

The audit is one of the four files this analysis reads, so its state is part of the evidence. All six of its P0s are
now closed on main, and knowing that prevents re-reporting a fixed defect as a live one:

| Audit item | State at `b4ee813` | Where |
|---|---|---|
| P0-1 unreadable book wiped | fixed — `doc.loaded` refuses the write | `lib/pipelines.js:612-616` |
| P0-2 `200` on a failed write | fixed — `set` returns null, route 500 | `lib/pipelines.js:620-634`, `:654-658` |
| P0-3 `local`'s prompt contradicted | fixed — the seed names the LANDING paragraph | `pipelines.seed.json:14` |
| P0-4 a switch starts no turn | fixed — the switch is 501 and writes nothing | `server.js:361`, `lib/pipelines.js:651` |
| P0-5 child cut writes no record | fixed — the route writes the rung | `server.js:2923` |
| P0-6 padded hole invisible | fixed — the expression allows padding | `lib/pipelines.js:89` |

Still open, and load-bearing for the fields above: the catalogue payload still drops every prompt and exit
(`lib/pipelines.js:711`, P1-1); a project with no default still resolves to the built-in turnover
(`lib/pipelines.js:430-439`, P1-2); the merge has no tombstone (P1-3); a stage has no edge, only position (P1-5); nothing
records a main baseline (P1-6) or a `lastSeen` (P1-7); `branch-name`'s `branch` parameter is still ambiguous
(`lib/pipelines.js:68`, P1-8); the ladder grants no permission (`lib/jobs.js:2126`, P1-11); the card says `null` where
the route says `local` (`lib/jobs.js:1556` vs `server.js:3140`, P1-12).

---

## 8. Appendix — what each subagent covered

Four subagents were dispatched by field cluster; their findings were consolidated here, and **every cited line was
re-read by this run at `b4ee813` before it entered this file**. Where a subagent's anchor moved or its premise had gone
stale under the two landings, this document carries the re-read anchor, not the child's.

| Subagent | Cluster | Covered | What changed on consolidation |
|---|---|---|---|
| 1 | the stage's own fields | f01, f02, f03, f04, f05, f06; C1, C4, C8 | Kept its four absences and its two contradictions; added `cutPipeline`'s hard-coded `work` (`lib/pipelines.js:467`), which it had not cited |
| 2 | the agent's fields | f07, f08, f12; A1–A5 | Its worktree was removed mid-run and it re-read the tree from a sibling copy; every anchor it gave was re-verified here. Its A1–A5 scores were kept as bounds, and its verdict words were re-derived (it used scores where the brief asked for already there / absent / contradicts) |
| 3 | the exits and stops | f09, f10, f11; C2, C3, C7 | Kept its per-check data-source table, condensed into f10; corrected its "f10 absent" to **already there**, because the `exit` slot answers f10's question even without the guide's id/evidence attributes |
| 4 | the rubric cross-check | C5, C8; AP-01…AP-13 | Kept the C8 contradiction and the 13-row table; re-checked all thirteen rows against the current seed and `lib/` |

The guide copy, the text extraction used to read it, the base re-anchor after `a0ecde3` and `b4ee813`, every verdict,
the counts and the anti-pattern table's verdict words are this run's own work.

## 9. Second independent reading, and where the two passes part

Added by the retry tree `task-48-retry-analysis-a-974632`, which was tasked with the same analysis and did not read
this document while doing it: it read the same guide, `lib/pipelines.js`, `pipelines.seed.json`, `docs/pipelines.md`
and `docs/pipelines-audit.md` at the same base (`b4ee813`), and the four model files are byte-identical here (§10,
the same sha256s). Its full text is not reproduced because it repeats §1–§5; this section records where it agrees,
where it scored differently, and how the difference was settled.

**The two passes agree on the fields, verdict for verdict.** The same 3 already there (f01, f02, f10), the same 7
absent (f03, f04, f05, f07, f08, f09, f11) and the same 2 contradicts (f06 trigger-as-position, f12 unenforced prose
must-nots). They also agree on the structural facts behind the verdicts — a stage is four keys, no prompt renderer
exists, nothing evaluates an exit, `PIPELINE_SWITCH_STARTS_TURN` is false — and on the three disagreements that would
hurt most: f10's single unevidenced exit against the composite s02 f10 and s06 require, f09's missing artifact with
C3 locked at 2, and f06's position in place of a predicate, which is why `wait → address → wait` has no edge.

**They scored C5 and A4 differently, and the stricter reading here stands on re-check.**

- **C5, author ≠ judge.** The retry pass scored 1, reading panel-side code as the "separate role" of the 1 anchor.
  Nothing evaluates an exit (`lib/pipelines.js:40-41`) and no judging identity exists in the record
  (`lib/pipelines.js:507-515`), so there is no judge at all — and s03 C5 says *role*. 0, as §2 has it.
- **A4, mandatory self-check.** The retry pass scored 1, crediting the exit check as the agent's self-check. The check
  belongs to the panel; the worker is never asked to run it, and the report shape is a sentence
  (`pipelines.seed.json:14`). The 1 anchor is "runs the check but reports a sentence"; the worker does not run it. 0,
  as §3 has it.

So the retry pass's totals — 3 of 16 and 2 of 10 — are one point high on each rubric, and its corrections land exactly
on this document's **2 of 16** and **1 of 10**. That is the useful result of a second pass: the field verdicts are
independently reproduced, and the two soft scores were the only place the two readings diverged.

## 10. Sources

| File | sha256 | What it supplied |
|---|---|---|
| `docs/pipeline-integration/stage-authoring-guide.html` | `dbb75d4fe83ae11a687e7af4bfe3157d61161ef0f84814abc8f93f5424581860` | the twelve fields (s02), both rubrics (s03, s04), YAML and prompt (s05), worked verifier (s06), anti-patterns (s07), standards citation (s08) |
| `docs/pipelines.md` | `46c2fec794595627bb137d3a885678570b8bd52e0f47042022b4760c17f875aa` | the design: stage shape, exit vocabulary, prompt holes, record, switching, chaining, §8 UNBUILT |
| `lib/pipelines.js` | `a09eaca0432cdee5695a3d9dbcf2503e109729aa142f8060e3b0f85442692bf6` | validation, the closed vocabularies, the record class, the ladder |
| `pipelines.seed.json` | `06c394500ac79e3c462693c6faf16b4a53cf6c9d30f6fbdab1a44135ba164947` | 7 definitions, 23 stages, every shipped prompt and exit |
| `docs/pipelines-audit.md` | `08c6487c4b61e05b07f467591c330ff6c52b1cd8a04b032518e8d97491081d5d` | the defect ledger, used as a checklist; §7 above re-checks its P0 state |
