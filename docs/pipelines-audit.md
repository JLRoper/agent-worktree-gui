# Pipeline data model — audit

Audited: `804ed4e` (the pipeline catalogue, its ladder, and the record a cut writes), against `docs/pipelines.md` as the
spec. Files read: `lib/pipelines.js`, `pipelines.seed.json`, the `POST /api/worktree/pipeline` route
(`server.js:3088-3159`), the cut record in `lib/jobs.js` (`recordCutPipeline` / `pipelineForJob` / `applyPipeline`,
`lib/jobs.js:1521-1567`, `lib/jobs.js:1607-1611`, `lib/jobs.js:2027-2029`), both cut paths — `makeWorktree` and the
child route (`server.js:2869-2933`, `lib/child-worktree.js:52-97`) — the two defaults in `config.json`,
`test/pipelines.test.js` and `test/child-route.test.js`.

Every claim below was checked by reading the cited lines and, where behaviour is in question, by running a probe
against the module. The probes are quoted where they matter; each is a throwaway Node script against `lib/pipelines.js`
and needs no git tree. The exception is P0-5: it boots the real `server.js` on a throwaway store
(`tools/panel-testkit.mjs`) and presses the child-cut route over HTTP, because "this route writes no record" is a claim
about the route and not about a function.

Ranks: **P0** is wrong today, on main, with no unbuilt component in the path. **P1** is wrong the moment a reader lands
on it — the chip, the tab, the #40 evaluator or the §6 timer. **P2** is fragile: it survives the happy
path and fails on an edit, a restart, a second panel, or a hand-written definition.

---

## P0 — wrong today

### P0-1. One unreadable book deletes every tree's record, and every live tree silently becomes `local`

`lib/pipelines.js:560-583` (`PipelineRecords.doc`) initialises an empty book (`{version: 1, trees: {}}`), and on any
parse or read error logs a line and returns that empty book (`lib/pipelines.js:575-578`). `set` then rewrites the
**whole file** from that empty document (`lib/pipelines.js:594-602`). The comment at `lib/pipelines.js:592-593` calls
this out and accepts it ("a failed parse has already produced an empty book that a caller may overwrite"), which is
exactly backwards: a book that could not be read is the one book that must never be overwritten.

`writeFileSync` (`lib/pipelines.js:602`) truncates before it writes, so a panel killed mid-write — which is the
restart `lib/jobs.js` `load()` already contemplates — leaves a truncated file. The next cut or switch then replaces
the book with a single record.

Probe (two trees in the book, file truncated to 43 bytes, then one `set`):

```
A1 after truncation, get(c:/b): null
A2 book after set(c:/c): keys = [ 'c:/c' ]   (c:/a and c:/b are gone)
```

The damage is not only the lost records. `pipelineForJob` falls back to `j.pipeline` (`lib/jobs.js:1548`), which is
the copy the cut wrote — always `local` (`lib/jobs.js:1611`) — so the card for the job that cut the tree silently starts
reporting `local · work`; and the route reads a missing record as `presumedPipeline()` and therefore as `local`
(`server.js:3120`), so every tree silently re-gains the right to climb from the bottom. A review loop in flight is
reported as never having started. This is the one failure §3 exists to prevent (`docs/pipelines.md:266-270`), and it
is reachable by a single kill at the wrong moment.

**Smallest fix:** two lines plus a flag. Keep `doc.loaded` (or `doc.corrupt`) false when the read threw; make `set`
refuse to write over an unloaded book and return `null`; write through `<file>.tmp` + `renameSync`. The route then
cannot turn a corrupt book into an empty one.

### P0-2. A switch reports `200 ok` and a durable record when the write failed

`set` catches the write error, logs "the record for … is not durable", and then falls through to
`this.cached = doc; …; return pipeline` (`lib/pipelines.js:603-610`). The route ignores the return value, updates the
live cards from memory, and answers `200 ok` with the record (`server.js:3144-3158`).

Probe, with a directory where the book should be (every write throws `EISDIR`):

```
B1 set() on an unwritable path returned: github-force-merge
   log: … could not write … — the record for c:/tree is not durable
B2 disk holds: <directory>
```

So a locked file on Windows, a full disk, or a read-only state folder produces a green switch, a card that reads
back `turnover`, and a restart that puts the tree back on `local` — with nothing in the response to say so. §3 makes
the tree's record the durable one (`docs/pipelines.md:266-270`); a 200 that means "not saved" is the opposite.

**Smallest fix:** `set` returns the record only on a successful write (`null` otherwise); the route answers 500 and
does not call `jobs.applyPipeline` when it gets `null`. `PipelineRecords.set` is the only writer, so the change is
local to it and the route.

### P0-3. `local`'s only stored instruction contradicts the instruction every run already receives

The document defines `local` as "commit; report. No push, no PR. Its prompt is the existing LANDING paragraph
(`lib/branch-policy.js` `branchLandingLine`) and nothing else" (`docs/pipelines.md:66`), and repeats that
`branchLandingLine` *is* the local pipeline's prompt (`docs/pipelines.md:416`). The seed's `local` definition instead
carries a hand-written paragraph ending "Do not push, do not open a pull request, and do not merge anything"
(`pipelines.seed.json:14`).

That is already two instructions, because `branchLandingLine` is not silent about pushing. For a tree cut from `main`
— the common case for the two configured projects — it says "commit on …, push it and open a pull
request: `git push -u origin HEAD` then `gh pr create --fill`" (`lib/branch-policy.js:46-52`, `LANDING_BRANCHES` at
`lib/branch-policy.js:17`), and `lib/jobs.js` appends that paragraph to every worker's prompt
(`lib/jobs.js:2118-2126`, `lib/jobs.js:2138-2139`).

So the rung the document calls "the panel's behaviour today" is not the panel's behaviour today: a local tree is
already told to push and open a PR, subject only to `remoteBranchPolicy`. The moment a renderer hands the definition's
prompt to the worker, the tree receives both sentences and the model has to choose. And §3's claim that the kinds
carry different landing rules — "`turnover` may push and merge, `local` may not push at all"
(`docs/pipelines.md:263-264`) — is false for the common cut.

**Smallest fix:** decide which paragraph is authoritative. The smallest code change is to make the seed's `local`
prompt the landing paragraph's *fallback* (the renderer composes `{{landing}}`, and `jobs.js` stops appending
`kindLine` when the prompt already carries it), or delete the "Do not push" clause from the seed and amend §1.2. What
cannot stay is the doc saying one thing, the seed another, and `jobs.js` a third.

### P0-4. A switch burns the one-way ladder without starting the work it records

*The abandoned draft of this audit numbered this same defect P0-5; it is P0-4 here. The numbering did not carry
over — do not re-file it.*

§4.1 says the route "re-reads the tree's record from disk …, validates the ladder, appends the history entry with
`by: "reader"`, and starts the new pipeline's first stage as a turn in the SAME tree on the SAME thread"
(`docs/pipelines.md:295-299`). The route does everything except the last clause, and says so in a comment: "NOT here,
deliberately: starting the new pipeline's first stage as a turn … needs the prompt renderer and the exit-check
evaluator, which are later tasks" (`server.js:3094-3096`).

The consequence is not a missing nicety, because the ladder only climbs (`docs/pipelines.md:260-264`). One POST
(`server.js:3139-3147`) moves a tree from `local` to `turnover`, writes `stage: "commit"`, `since: <now>`, returns
200, and starts nothing. The tree is now permanently a turnover — the route will refuse every later downgrade
(`lib/pipelines.js:478-493`) — with no run, no commit, no push and no PR, and a `since` that clocks a stage that never
began. A second POST cannot undo it.

**Smallest fix:** until the turn start exists, refuse the switch (409/501 with "the pipeline switch is not wired to a
turn yet") *before* writing the record. One guard, and the ladder stays honest. The alternative — move the record
write behind the turn start — is the real fix but is not small.

### P0-5. The panel's own child cut writes no pipeline record, so the tree it just made has no rung

`POST /api/worktree/child` is the panel's second cut path, added for the roll-up. It cuts the tree
(`server.js:2883-2888`, `cutChildWorktree` at `lib/child-worktree.js:52-97`), writes the parent down in both books
(`server.js:2894`, `server.js:2906`), settles the naming ledger (`server.js:2911`), boards the row
(`server.js:2925`) — and never writes the pipeline record.

The write has exactly one call site in the repo. `recordCutPipeline` is defined at `lib/jobs.js:1523` and called once,
from `makeWorktree` at `lib/jobs.js:1611`; `pipelineRecords` appears in `server.js` only at the constructor (`:355`),
the injection into Jobs (`:1008`), and the two lines of the switch route (`:3120`, `:3144`). Nothing backfills it:
`cutChildWorktree` says in its own header that it "knows nothing about the panel's books"
(`lib/child-worktree.js:10-11`), and `scheduler.adoptWorktree` writes a row and scans it (`lib/scheduler.js:826-859`),
no record.

§3 is unconditional and names `makeWorktree` as the only writer: "**Always `local` at cut time.** … `makeWorktree`
writes `{id: "local", stage: "work", since: <cut>, history: [one entry]}` before the first turn exists"
(`docs/pipelines.md:255-258`). The document has one cut path; the code grew a second, and the rule did not cross.

Probe — the real server on a throwaway store, a parent worktree cut by hand, then the ＋ route over HTTP:

```
A2 pipeline-records.json before any cut: (absent)
B1 child cut status: 200   branch wtgui/probe-child-6ac469   parent feat/parent
B3 pipeline-records.json immediately after the child cut: (absent — no record was written)
C2 the switch route's read of that tree: { from: "local", fromKind: "local" }
C3 history the route then wrote: [ { from: "local", to: "investigation", stage: "probe", by: "reader" } ]
```

C2 is the read side: the card for such a tree reads `pipeline: null` (`lib/jobs.js:1548`, P1-12) until a switch writes
one, and the route presumes `local` (`server.js:3120`). C3 is the second half: §3's history starts at the cut
(`docs/pipelines.md:240-253`), so the record such a tree does eventually get begins mid-air — no `by: "cut"` entry, no
`since` for its first rung, and the first climb recorded as if the tree had been `local` by choice.

**Smallest fix:** one line beside the landing parent at `server.js:2906`:

```js
jobs.recordCutPipeline(out.path);
```

`recordCutPipeline` logs and swallows a write failure (`lib/jobs.js:1523-1533`), so it cannot fail a cut that has
already happened, and `jobs.pipelineRecords` is injected at `server.js:1008`. Writing it inside `cutChildWorktree`
would break that module's own contract — it deliberately knows no books. The record is stamped milliseconds after git
made the tree, at the moment of the write; `recordCutPipeline` takes `at` if the exact cut time is ever wanted, which
would need `cutChildWorktree` to return one. The record is what matters here, not the millisecond.

### P0-6. A hole written with spaces inside the braces is invisible to the validator, so `{{ nope }}` is accepted

`PLACEHOLDER_RE = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g` (`lib/pipelines.js:85`) allows no whitespace between the braces
and the name. `promptPlaceholders` therefore returns `[]` for `{{ nope }}`, `unknownPlaceholders` filters an empty list
(`lib/pipelines.js:90-98`), and `validatePipeline` reads the prompt as prose with no hole in it
(`lib/pipelines.js:194-198`; the same pair guards every `text` exit parameter through `checkTextParam`,
`lib/pipelines.js:104-112`).

Probe, the five spellings through `validatePipeline` (one stage, prompt `Read <hole> before you start.`):

| hole | `promptPlaceholders` | `unknownPlaceholders` | `validatePipeline` |
|---|---|---|---|
| `{{nope}}` | `["nope"]` | `["nope"]` | refused |
| `{{ nope }}` | `[]` | `[]` | **accepted — wrong** |
| `{{ ticket }}` | `[]` | `[]` | **accepted — wrong** |
| `{{TICKET}}` | `["TICKET"]` | `["TICKET"]` | refused |
| `{{ticketId}}` | `["ticketId"]` | `["ticketId"]` | refused |

The two wrongly accepted are the two a person types. `{{ nope }}` is exactly the unknown hole §1.4 promises to refuse
— "An unknown placeholder is **refused** when the definition is saved" (`docs/pipelines.md:114-118`) — and the
definition is saved with the literal text `{{ nope }}` in the worker's brief. `{{ ticket }}` is the mirror image: a
known name the scanner pretends is not there, so a definition carrying it is blessed and no renderer is obliged to
resolve it; the closed list prints `{{ticket}}` (`lib/pipelines.js:83`), not this. The two refusals are correct
outcomes from a scanner that only sees its own spelling — `{{TICKET}}` and `{{ticketId}}` match the expression and are
then rejected by name — which isolates the scanner as the only thing deciding, and it is blind to whitespace.

This is P2-8's regex seen from the P0 side: P2-8 records the non-identifier holes (`{{ticket-id}}`, `{{}}`) that slip
through the same expression. The spaced hole is the one a reader editing a prompt will actually produce, so it is
ranked here and not there.

**Smallest fix:** one pair of characters, in one line:

```js
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;
```

The capture stays the bare name, so `promptPlaceholders`, `unknownPlaceholders` and the two error messages that print
`{{${name}}}` are all fixed at once: `{{ nope }}` is refused by name, and `{{ ticket }}` validates as `ticket` — at
which point the renderer must tolerate the padding as well (or normalise the name before replacing it), or the hole is
validated and still rendered literally. Widening the capture to `([^{}]*?)` in the same line also catches
`{{ticket-id}}` and `{{}}` (P2-8); the narrower one is the smallest change that makes the hole visible at all.

---

## P1 — wrong when the chip, the tab, the evaluator or the timer reads it

### P1-1. There is no HTTP shape for the catalogue, and the one that exists drops every prompt and exit

`Pipelines.state()` (`lib/pipelines.js:656-671`) is the only candidate for a settings/board payload, and it maps each
definition to `{id, kind, title, description, stages: [ids], next}` (`lib/pipelines.js:667-669`). The tab is supposed
to edit "the stage list, each stage's prompt, each stage's exit check and its parameters" (`docs/pipelines.md:301-307`).
None of those three fields survives `state()`. Its own comment claims "the tab reads the whole definition from
`pipelines[id]`" (`lib/pipelines.js:654-655`), but `pipelines[id]` in that object is the same stripped record — the
prompts and exits are not in the payload at all.

Worse, nothing serves it: `server.js` has no `pipelines.state(` and no `pipelines.defaultsFor(` call. The catalogue's
warnings and drops are logged once at boot only (`server.js:356`), so a definition broken by a live edit is invisible
until someone happens to POST that id and gets the 404 at `server.js:3106-3115`. §4.1's menu reads "what the project
allows … from the resolved defaults" (`docs/pipelines.md:283-293`); `defaultsForProject` exists
(`lib/pipelines.js:449-454`) and has no caller either.

**Smallest fix:** add the read route the chip and tab both need — `GET /api/pipelines` returning
`{catalogue: pipelines.state(), definitions: {id: fullDef}, defaults: {project: defaultsForProject(...)}}`, with full
stages (prompt + exit) for the tab and the resolved defaults for the menu. Re-log warnings when the live file changes,
not only at boot.

### P1-2. "This project has no turnover default" cannot be expressed, so §5's refusal to chain cannot happen

`defaultForProject` walks project → global → built-in (`lib/pipelines.js:409-436`) and always returns a definition:
with nothing named anywhere it returns the seed's `turnover` with `source: "builtin"`, `fallback: false`, and a live
definition (probe E: `{id: "turnover", hasDefinition: true, stages: ["commit", "push", "pr"]}`). That is what §2's rung 3
asks for (`docs/pipelines.md:169-175`).

But §5 says "If the project has no `defaultTurnover`, the chain does not happen … Inventing a turnover — or falling
back to another project's — would be the panel landing work nobody asked it to land"
(`docs/pipelines.md:344-346`), and §4.1 says "a project with no turnover default offers no turnover at all"
(`docs/pipelines.md:291-293`). Both states are unreachable: a project with no default gets the built-in `turnover`
offered and chained into. The document contradicts itself (§2 vs §4.1/§5), and the code follows §2.

**Smallest fix:** add `named` (or `source: "none"`) to the resolution result — whether a project-or-global value was
actually present — and let the chip's menu and the chain require it, leaving the built-in as a display fallback only.
Alternatively amend §5 to say the built-in is chained. One of the two, in the same commit as the chain.

### P1-3. A definition cannot be deleted, so §4.2's delete rule has no implementation

`mergeDocs` is `{...seed.pipelines, ...live.pipelines}` (`lib/pipelines.js:332`). Removing an id from `pipelines.json`
does not remove it from the catalogue; it resurrects the seed's record. Probe J, with a live file whose `pipelines` is
empty, still yields all seven seed ids in force.

§4.2 requires the tab to refuse "deleting a definition a project's default names, or one a live tree is on — 409"
(`docs/pipelines.md:321`), which presumes deletion exists. On this model a delete is a no-op that silently reinstates
the shipped definition — the worst of both: no error, and the definition the reader tried to remove is back.

**Smallest fix:** a tombstone in the live document (`deleted: ["id"]`, or `{id: null}`) that `mergeDocs` honours after
the spread. Then the tab's 409 can be implemented against a real delete.

### P1-4. Breaking an id in `pipelines.json` reinstates the seed's version while reporting the id as dropped

Per-id validation drops a bad live definition (`lib/pipelines.js:273-278`), then `mergeDocs` fills the same id from
the seed (`lib/pipelines.js:332`). Probe C — a live `turnover` whose one stage uses an unknown check — gives:

```
C1 dropped ids: [ 'turnover' ]
C2 turnover in force is: Turnover | stages: [ 'commit', 'push', 'pr' ]   (the seed's)
```

So the reader's edit did not win (contrary to `docs/pipelines.md:126-127`), and `pipelines.state().dropped` names an
id that `pipelines.state().pipelines` still offers. The panel is telling two readers two different things about the
same id, and the reader who broke `turnover` gets a turnover anyway.

**Smallest fix:** a live id that fails validation should shadow the seed id — delete the merged id after the drop —
rather than fall back. "Dropped by id" should mean the id is not in force, whichever file supplied it.

### P1-5. The review loop has no transition edges: the second comment round, and an approval that arrives while waiting, are unrepresentable

`sefl-review-loop` is an ordered list `branch, push, pr, wait, address, approve, merge` (`pipelines.seed.json:160-208`).
The document's loop is `wait → address → wait → approve` (`docs/pipelines.md:225-227`) and its `wait` exit is
"`pr-comments` or `pr-approved`" (`docs/pipelines.md:215`). Nothing in the data model names the stage to enter: a
stage has `title`, `prompt`, `exit` (`docs/pipelines.md:51-53`) and no `goto`; the definition has one `next`, which
is the pipeline chain, not a stage edge (`docs/pipelines.md:54`).

Two concrete failures follow even with a correct #40:

- Read as §1.3 says ("the host's activities"), an approval is an event, so `pr-comments` fires on it; the ordered list
  sends the tree to `address`
  (`pipelines.seed.json:184-193`), whose prompt is "for each new comment … make the smallest change", when there is no
  comment and nothing to answer. The `approve` stage is entered only after `address` exits on `pushed`.
- A second comment round, or a comment that arrives while the tree is in `approve`, has no edge back to `address` or
  `wait`: `approve`'s only exit is `pr-approved` (`pipelines.seed.json:199`), so the tree sits in `approve` until the
  head is approved — the comment is never answered.

The document's "or" is also a composite check, which §1.3 forbids (`docs/pipelines.md:103-105`); the seed resolves the
contradiction by keeping one check and losing the edge.

**Smallest fix:** give a stage an `on` map to another stage id (`{"pr-approved": "merge", "pr-comments": "address"}`),
or per-stage `next` — a closed map of check → stage, not an expression. The evaluator then has a target to write, and
`advanceStage` already accepts any stage id (`lib/pipelines.js:519-530`).

### P1-6. `main-moved` has no baseline anywhere in the record

The check exits when the remote main sha "differs from the one recorded when the stage began"
(`docs/pipelines.md:86`). Nothing records it. The record schema is `{id, stage, since, history[]}`
(`docs/pipelines.md:233-246`), `cutPipeline` writes only those four (`lib/pipelines.js:460-467`), `changePipeline`
rewrites `since` and appends a history line (`lib/pipelines.js:497-513`), and `advanceStage` does the same
(`lib/pipelines.js:519-530`). There is no `baseline`, no `sha`, no `mainSha`.

The seed uses `main-moved` as the last stage of `github-force-merge` (`pipelines.seed.json:150`), so that pipeline can
never report completion; the evaluator would have to invent a baseline (the PR's merge commit? the stage's `since`?)
and whichever it picks, a re-check after a restart re-reads a different remote and can pass on the wrong comparison.

**Smallest fix:** one field on the record — `baseline` (a sha), written when a stage is entered, and read by
`main-moved` (and by `commits`, which needs `base` for the same reason, `docs/pipelines.md:82`). `advanceStage` is the
only writer today and has no caller, so the field can be added without a migration.

### P1-7. `pr-comments` has no `lastSeen`, and the only object that could hold it is not in the schema

The check's truth condition is "there is an event newer than `lastSeen`" (`docs/pipelines.md:90`). `lastSeen` is an
optional parameter (`lib/pipelines.js:74`), and the seed's `wait` stage omits it (`pipelines.seed.json:187`); the seed
still validates (probe F1). The value §6 shows lives in `pipelineWait.lastSeen`
(`docs/pipelines.md:367-377`), and `pipelineWait` appears nowhere in code: not in `lib/pipelines.js`, not in
`lib/jobs.js`, not in `lib/paths.js` (grep: the only occurrence in the repo is the document).

So the wait stage's exit has no baseline, and the timer's record has no home. A definition with `pr-comments` is
accepted today and cannot be evaluated by anything, including a correct #40 that has not been told where `lastSeen`
lives.

**Smallest fix:** make `lastSeen` required on `pr-comments`, defaulted to the stage's `since` by the evaluator, and add
`pipelineWait` to the record schema (`PipelineRecords` already writes an arbitrary object; only the doc and the
validator need the field).

### P1-8. `branch-name`'s `branch` parameter is dead or poisonous

§1.3 says `branch-name` "reads the tree's current branch" (`docs/pipelines.md:84`). §1.1's own example passes
`"branch": "{{branch}}"` (`docs/pipelines.md:39`), `EXIT_PARAM_SPEC` accepts it (`lib/pipelines.js:68`), and the seed
passes it (`pipelines.seed.json:165-169`).

If the evaluator follows §1.3, the parameter is dead data that the validator blesses. If it follows the parameter,
`{{branch}}` resolves to the tree's branch **before** the rename — the whole point of the stage — and the pattern can
never match, so `sefl-review-loop` never leaves its first stage. The two readings are both defensible from the files,
which is the bug.

**Smallest fix:** delete `branch` from `branch-name` in `EXIT_PARAM_SPEC` and from the seed, and let the check read the
tree's HEAD. If the parameter is wanted (to check a ref that is not HEAD), say so in §1.3 and resolve it live.

### P1-9. Both turnover pipelines drop the conditions the document says gate the PR, and `clean`

`github-force-merge`'s `pr` stage exits on `pr-open` alone (`pipelines.seed.json:138`); `sefl-review-loop`'s exits on
`pr-open` alone (`pipelines.seed.json:181`). The document's tables require `pr-open` + `pr-head`
(`docs/pipelines.md:196`) and `pr-open` + `pr-head` + `reviewers-exact` (`docs/pipelines.md:214`, and again at 220-223:
"`reviewers-exact` fails a PR that carries a second reviewer"). Both `commit` stages exit on `commits` only
(`pipelines.seed.json:51`, `:120`), while the document's commit stage is `clean` + `commits`
(`docs/pipelines.md:193`).

The implementation is consistent with §1.3's "no composite checks" (`docs/pipelines.md:103-105`) and inconsistent with
the tables. The effect at the exit: a PR opened at a head sha that does not contain the pushed commit passes; a SEFL PR
carrying a second reviewer passes, so the review queue's group filter is prose in a prompt and nothing else; and a
turnover tree can be declared committed with uncommitted work, which the next stage then pushes as a branch that does
not carry it.

**Smallest fix:** one check per stage, as §1.3 requires: `commit` (`commits`), then a `clean` stage before the push,
then `pr` (`pr-open`), `pr-head` (`pr-head`), `reviewers` (`reviewers-exact`, SEFL only). Five small stages instead of
three composites the document forbids.

### P1-10. A definition's `kind` can be edited with no ladder consequence, so a live tree can be downgraded with no history entry

The route derives `fromKind` from the definition the record *names*, not from the record's history
(`server.js:3120-3128`). `pipelines.json` is reader-edited and reloaded (`docs/pipelines.md:125-127`), and validation
accepts any of the three kinds on any definition (`lib/pipelines.js:172-173`); nothing refuses a kind change on a
definition a live tree is on — §4.2's refusal list (`docs/pipelines.md:315-321`) covers a stage, a pattern, a
placeholder, a lower `next`, and a delete, not a kind edit.

Edit `sefl-review-loop` from `turnover` to `local` in the live file and every tree on it becomes `local` at the next
read, with its record still saying `{id: "sefl-review-loop", …}` and its history still saying it climbed to turnover.
A tree that pushed and opened a PR is now reported as local and may climb again; the `from` on the next history entry
will be `local`, so the path lies about where the tree came from. This is the silent downgrade §3 forbids
(`docs/pipelines.md:260-264`), reached through the catalogue instead of the route.

**Smallest fix:** refuse a `kind` change on any definition a live tree is on (the tab's 409, reusing
`PipelineRecords.doc()` to find them), or derive `fromKind` from the last history entry's `to` and treat a kind edit
as a change requiring a migration.

### P1-11. The ladder grants nothing: no run path reads the pipeline kind

§3 says the kinds "have different landing rules — `turnover` may push and merge, `local` may not push at all"
(`docs/pipelines.md:263-264`), and §1.2's table is the same claim (`docs/pipelines.md:64-68`). No code on the run path
reads it: `lib/jobs.js` imports only `cutPipeline` from the module (`lib/jobs.js:41`), and the paragraph a run gets is
built from `opts.remoteWrite`, `opts.landing` and the tree's parent branch (`lib/jobs.js:2118-2133`), never from
`pipeline.id` or the definition's kind. The push guard is keyed on `remoteBranchPolicy`
(`docs/pipelines.md:411-415`), not on the pipeline.

So switching a tree to `turnover` changes a label and a record; it does not grant a push, and `local` does not withhold
one. The chip will present a permission the panel does not enforce, and the card will say a tree "may" do something
that is decided elsewhere.

**Smallest fix:** one call in the run path — `const kind = this.pipelineForJob(j)?.id` resolved through the catalogue —
and compose `remoteWrite` from it, so `turnover` is what turns a `local-only` push into the permission path and
`local` is what refuses it. That is the "a pipeline never grants itself a write" rule read the other way round.

### P1-12. The card and the route disagree about the same tree: `null` versus `local`

`pipelineForJob` returns `j.pipeline || null` when the tree book has no entry (`lib/jobs.js:1548`). The route, reading
the same absence, returns `presumedPipeline()` — always `local` (`server.js:3120`, `lib/pipelines.js:472-474`). The
test asserts the card's `null` explicitly (`test/pipelines.test.js:465-468`), so the disagreement is encoded.

The chip draws from the card (`docs/pipelines.md:278-281`), so a tree cut before pipelines shows no pipeline while the
route will happily climb it as local; and a card whose job has fallen out of the ring but whose book entry was lost in
P0-1 shows nothing rather than the truth. §3 says a tree with no record "is local — that is the panel's behaviour
today" (`lib/pipelines.js:469-471`); the card should say so.

**Smallest fix:** return `presumedPipeline({ at: j.startedAt || null })` from `pipelineForJob` when the book has no
entry, and have the route use the same function so there is one answer.

### P1-13. §8 and the page's opening are false after `804ed4e`

`docs/pipelines.md:7-9` says "the pipeline machinery itself does not exist yet", and §8 (`docs/pipelines.md:427-449`)
lists as missing: the catalogue, `pipelines.seed.json`, `PIPELINES_VERSION`, the loader, `statePaths().pipelinesFile`,
the record on a job and in `makeWorktree`, `POST /api/worktree/pipeline`, the config keys, and `test/pipelines*.test.js`.

All of those exist: `lib/pipelines.js:24` and `:26`; `pipelines.seed.json`; `lib/paths.js:79-80` and `:212-213`;
`lib/jobs.js:1523-1533` and `:1611`; `server.js:3097`; `config.json:26-27`, `:36-37`, `:47-48`; `test/pipelines.test.js`.

Still true in §8: no chip, no tab, no `/api/settings/pipelines` or `/api/settings/pipeline-defaults`, no exit-check
evaluator, no re-check ticker, no chaining. A reader (or the next agent) who trusts §8 will rebuild what is on main and
skip what is not.

**Smallest fix:** rewrite the opening sentence and §8 to the five items that are actually missing, and mark the
catalogue/record/route/defaults as built with their file:line. It is a documentation-only change and it is the map the
next task needs.

---

## P2 — fragile

### P2-1. The record is trusted exactly as read

`doc()` copies every entry from `pipeline-records.json` without checking that it has `{id, stage, since, history[]}`
(`lib/pipelines.js:565-574`). A hand-edited or half-written entry with `history: []`, a future `since`, or a stage id
the definition does not have is served to the card, and the route derives the ladder rung from its `id`
(`server.js:3120-3128`). The catalogue is validated per definition; the record is not validated per tree. **Fix:**
validate on read — id present, `since` parseable, `history` an array — and drop-and-name per tree the way the catalogue
does.

### P2-2. `next` may name itself, a same-kind pipeline, or form a cycle

`validatePipeline` refuses only a *lower* kind (`lib/pipelines.js:205-211`), and `pruneChains` the same
(`lib/pipelines.js:308-313`). So `next: <its own id>` passes, and an `investigation → investigation` pair passes; both
would chain forever once #40 reads `next`. §5 only ever describes a chain into the project's turnover
(`docs/pipelines.md:327-337`), and §4.2 only names the lower-kind refusal (`docs/pipelines.md:320`). **Fix:** refuse
`next === id`, refuse a cycle, and require the target to be a turnover.

### P2-3. `cutPipeline` hard-codes `stage: "work"`

`lib/pipelines.js:462` writes `stage: "work"` regardless of the `local` definition in force. A reader who overrides
`local` with a stage id other than `work` gets a cut record naming a stage that does not exist (probe D: definition
`["do-it"]`, record `"work"`). The document itself writes `stage: "work"` (`docs/pipelines.md:255`), so this is a doc
and code agreement on a hard-coded id — but it is a record that cannot be resolved against its own definition.
**Fix:** `cutPipeline` takes the local definition's first stage id, or `recordCutPipeline` passes it in.

### P2-4. `changePipeline` and `advanceStage` do not cross-check the id, the kind, or the stage

`changePipeline(cut, {fromKind: "local", toKind: "turnover", id: "investigate", stage: "probe"})` returns `ok: true`
and a history entry claiming a local→turnover transition into an investigation pipeline (probe G). `advanceStage`
accepts `stage: "wait"` for `github-force-merge`, which has no such stage (probe H). Both functions trust their caller;
today the route is a correct caller, and #40's chain is the next one. **Fix:** pass the definition (or its stage ids)
and refuse an unknown stage or a kind/id mismatch.

### P2-5. A live file with no `version` is parsed and merged

`readPipelinesFile` treats `Number(raw.version)` of `undefined` as `NaN`, skips the newer-than refusal, and loads the
file with `doc.version = null` (`lib/pipelines.js:243-253`). Probe I: a versionless file loads its definitions. The one
whole-file refusal §1.5 describes is for a *newer* file, and a file whose `version` key was renamed or dropped by a
later panel is exactly the "half-parsed into a catalogue that looks complete" case the refusal exists to prevent
(`docs/pipelines.md:129-131`). **Fix:** require an integer `version`; a missing or non-numeric one is refused whole.

### P2-6. The book is a whole-file read-modify-write with no lock and no claim

`set` re-reads with `doc({fresh: true})` and writes the entire `trees` map (`lib/pipelines.js:594-611`). Two panels, or
a cut and a switch in the same second, are last-writer-wins on every tree, not just the one being written — the same
mechanism as P0-1 without the corruption. §6 promises a second panel "cannot double-wake" because the record is
claimed (`docs/pipelines.md:396-399`); the book has no `claimedAt`, no `pipelineWait`, and no compare-and-swap, so the
claim has nowhere to live. **Fix:** one file per tree keyed by a hash of the path, or a lock file around the
read-modify-write plus an atomic rename.

### P2-7. The route writes a record for any path string, and released trees are never pruned

The route takes `body.path` with no check that it is a row, a known project, or an existing directory
(`server.js:3100-3101`), and `PipelineRecords` has no `delete` at all (grep: `set`, `get`, `doc`, `state` only). A typo,
a released tree, or a path from a deleted project leaves a record that lives in the book forever; a later cut at the
same path overwrites it (`recordCutPipeline`, P2-3), so the phantom only bites until the next cut — but the file grows
without bound and a released path can be read by a row that reuses it. **Fix:** require the path to be a known row
(`store.rowsFor`) or an existing worktree; hook the release path (`agentCleanupFrom` / `releaseWorktree`) to delete the
key.

### P2-8. The placeholder scanner misses every hole that is not an identifier

`PLACEHOLDER_RE = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g` (`lib/pipelines.js:85`) only sees `{{word}}`. `{{ticket-id}}`,
`{{ project }}` and `{{}}` are not matched, so they pass validation (`lib/pipelines.js:195-197`) and render literally —
the exact failure §1.4 refuses ("a prompt with a silently missing `{{ticket}}` is the brief that produces a branch
called `_`", `docs/pipelines.md:114-115`). **Fix:** after the known-hole scan, refuse any remaining `{{` or `}}` in a
prompt. The spaced hole — `{{ nope }}`, which this scanner also cannot see — is carved out as P0-6 above; the one-line
regex change there fixes this entry too, so do not file it twice.

---

## Which exit checks are dead weight today

Nothing evaluates any check: the evaluator is #40, and `advanceStage` — the only function that builds a stage hop — has
no caller outside `test/pipelines.test.js:376-383`. Beyond that, four of the fourteen checks have no data source
anywhere in `lib/` on main, so #40 cannot evaluate them without extending a host reader or the record:

| check | used by a seed stage | data on main | state |
|---|---|---|---|
| `clean` | none | `git status` | vocabulary only |
| `commits` | `local/work`, the three `probe` stages, `github-force-merge/commit` | `git rev-list`, but the **base** is not in the record (`lib/pipelines.js:66`) | usable only if the evaluator reads the parent book |
| `branch-exists` | none | `git rev-parse` | vocabulary only |
| `branch-name` | `sefl-review-loop/branch` | `git`, but the `branch` param is ambiguous (P1-8) | usable only if the param is ignored |
| `pushed` | three stages: both `push` and `address` | `git ls-remote` | usable |
| `main-moved` | `github-force-merge/main` | **nothing records the baseline** (P1-6) | dead |
| `pr-open` | both `pr` | `lib/project.js` `prIndex` (`lib/project.js:286-299`) | usable |
| `pr-head` | none | `prIndex` carries `headRefOid` (`lib/project.js:251-265`) | usable, unused |
| `reviewers-exact` | none | **no reviewer field**: `normalisePr` returns `{number,state,mergedAt,headRefName,headRefOid,title}` (`lib/project.js:251-265`) | dead |
| `pr-comments` | `sefl-review-loop/wait` | **no activities reader** and no `lastSeen` (P1-7) | dead |
| `pr-approved` | `sefl-review-loop/approve` | **no `lastReviewedCommit`** anywhere in `lib/` | dead |
| `pr-merged` | both `merge` | `prIndex.state` | usable |
| `file-exists` | both `conclude` | the tree | usable |
| `command` | `github-force-merge/version` | the tree; `tools/version.mjs check` exists (`tools/version.mjs:314-321`) | usable |

So today's dead weight is: `main-moved`, `reviewers-exact`, `pr-comments`, `pr-approved` (no source), `clean`,
`branch-exists`, `pr-head` (no stage uses them), and the `branch` parameter of `branch-name` (P1-8). `commits` is
half-dead until the base is recorded. Five checks are genuinely plug-in-ready: `pushed`, `pr-open`, `pr-merged`, `file-exists`
and `command`.

## Can `local → investigate → turnover` be walked end to end on main?

As **labels**, yes: two POSTs to `/api/worktree/pipeline` move the record local → investigation → turnover, and the
route refuses to go back. As **work**, no, and the gaps are not only the missing evaluator:

1. **Cut** writes `local/work` (`lib/jobs.js:1611`) — works.
2. **Switch to the investigation** writes `{id, stage: probe, since}` and starts nothing (P0-4). No prompt renderer
   exists: `PROMPT_PLACEHOLDERS` is only a validator (`lib/pipelines.js:83-98`), and no code replaces `{{…}}` in a
   stage's prompt. The probe never runs.
3. **The second stage is unreachable by any route.** `changePipeline` refuses a same-kind change
   (`lib/pipelines.js:486`), so `probe → conclude` cannot be a POST, and `advanceStage` has no route at all. The
   investigation can never leave stage 1; `conclude`'s `file-exists` is never asked.
4. **The chain does not exist.** Nothing reads `next`; `changePipeline` is never called with `by: "stage"`; and the
   built-in `investigate` carries `next: null` (`pipelines.seed.json:39`), so even the data is absent for a project
   that does not name the GitHub/SEFL investigation. The named ones do carry `next`
   (`pipelines.seed.json:87`, `:108`), and for the two configured projects that target agrees with their
   `defaultTurnover` (`config.json:36-37`, `:47-48`) — so the data is ready and the code is not.
5. **Switch to the turnover** writes `{id, stage: commit, since}` and starts nothing. The turnover's stages never run, `pr-merged` is never asked, and the record sits at `commit` forever.

What can be walked with only what is on main is: cut → (hand) switch to investigation → stop. Everything after that
is either a hand-written record or absent.

## Would the suite have caught the P0s?

`node --test test/pipelines.test.js` → 10 passed, 0 failed (2.4s). `npm test` → 908 passed, 0 failed (112s).

| P0 | caught? | why not |
|---|---|---|
| P0-1 book wiped after an unreadable file | **no** | no test ever writes an unreadable `pipeline-records.json`; `test/pipelines.test.js:387-421` starts from a fresh writable path, and the route test seeds a valid book (`:451-454`). The read failure path (`lib/pipelines.js:575-578`) is never executed. |
| P0-2 `200` on a failed write | **no** | no test makes the book unwritable; the `PipelineRecords` in `:398` and the one the panel builds both sit in a writable temp dir. `set`'s catch (`lib/pipelines.js:603-605`) is never executed. |
| P0-3 `local`'s prompt vs the landing line | **no** | `:94-120` asserts the seed's checks and placeholders only. The suite never imports `lib/branch-policy.js` and never compares `pipelines.seed.json`'s `local` prompt to `branchLandingLine`. |
| P0-4 a switch starts no turn | **no — encoded** | `:476-492` asserts the 200, the record, the stage and `cards`, and never looks for a job or a run. It passes *because* the route does no turn. |
| P0-5 the child cut writes no record | **no** | `test/child-route.test.js:87-96` drives that route and asserts the parent book and the row; it never reads `pipeline-records.json`. `test/pipelines.test.js:387-421` drives `makeWorktree`, the path that does write it. |
| P0-6 `{{ nope }}` passes validation | **no** | the only unknown-hole case is `{{ticketId}}`, with no spaces (`test/pipelines.test.js:195-197`). No test writes a spaced hole, so the regex gap is never exercised. |

Two tests encode wrong behaviour as expected: `:465-468` asserts `before.pipeline === null` for a pre-pipeline card
(P1-12), and `:492` treats "the live card was handed the record" as the whole of a switch (P0-4). A restart test for
the book does not exist at all, which is the gap behind P0-1 and P0-2.

## Verdict

The schema is the right one: `{id, stage, since, history[]}` answers "what is this tree for, where is it, since when,
and how did it get here", the ladder's three rungs are implementable, and `history` as a path is the correct shape for
a review loop. The seed is a real catalogue, not a stub, and the route's refusal of a downgrade is the right spine.

The model is **not** sound enough to build the chip, the tab and the timer on yet, but it is close, and the fixes are
local rather than a redesign:

- **The chip** would draw a label that no run path honours (P1-11), from an HTTP payload that does not exist (P1-1),
  over a card that reports `null` where the route says `local` (P1-12), and it would offer a turnover to a project that
  has no turnover default (P1-2). Build it after those four; none changes the schema.
- **The tab** cannot edit a prompt or an exit because neither is in `state()` (P1-1), cannot delete a definition
  because the merge has no tombstone (P1-3), and cannot prevent the one edit that silently downgrades a live tree
  (P1-10). It also needs the `kind`/`stage` cross-checks (P2-4) before it writes.
- **The timer** rests on `since`, which is written correctly today (`lib/pipelines.js:503-511`), but it has nowhere to
  put `pipelineWait` (P1-7), no claim to stop a second panel (P2-6), no baseline for `main-moved` (P1-6), and a book
  that a restart can empty (P0-1). The clock is right; the storage is not.

Fix P0-1 and P0-2 first — they are the difference between "a record" and "a record that survives a restart", which is
the premise of the whole page. P0-5 and P0-6 are one line each and belong in that same first pass: the second cut path
must write the record the first one writes, and the validator must see the hole it is supposed to refuse. Then P0-4,
because the route currently spends the ladder's one-way move for nothing. P0-3 and P1-5/P1-9 are the model's semantic
debts: until they are settled, the chip would be a truthful view of a record that does not describe the work. With
those done, the chip, the tab and the timer are three readers of a record that can be trusted; without them, each
would be a new surface over the same six lies.
