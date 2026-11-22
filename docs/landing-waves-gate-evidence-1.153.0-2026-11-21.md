# Landing: the wave exit gate reads evidence (1.153.0)

Step 1 landed the record, the explicit membership and the derived state, and its gate read was honest about how little
it could see: `pr-merged` believed the `pr.state` word the last scan had copied onto the row, and `main-moved` had no
evaluator at all. This row is step 2 of the waves plan: the gate now reads the two facts a closure needs, from the
places that hold them, and answers cannot tell when it cannot read them. It adds no scheduler, no write route, no
automatic advance and no new check name.

## What a member closes on

`lib/wave-evidence.js` is the read; `lib/waves.js` `readWaveGate` is the decision.

**The pull request reads MERGED through the host's API.** `readWavePrForEvidence` (`server.js:1873`) reads the same PR
index the board's PR cell reads, finds the number the member recorded, and takes its `state`, `mergedAt` and
`headRefOid`. The row's stored `pr.state` is still what the lane draws, and it is never what the gate believes: a test
pins that the API's answer wins when the stored word and the live read disagree in either direction.

**The member's content is on main, judged BY CONTENT.** `readLanding` (`lib/wave-evidence.js:92`) resolves the recorded
sha and the main ref, takes the merge base, lists the files the change touched, and diffs only those files between the
sha and `origin/main`. Equal content is the landing. This repo lands by squash, which REWRITES the sha: the commit a
member recorded is not an ancestor of main and never will be, so ancestry and an "ahead by N" count are not evidence
here. Ancestry is recorded on the answer (`ancestor: false` for a squash landing) and never decides it.

The sha that is judged is the pull request's own head (`headRefOid`), because that is the head the host merged. A
member whose PR read failed or gave no head falls back to the sha its own run recorded: the round's assembly commit
first, else the newest settled stage run's commit (`recordedShaOf`, `lib/wave-evidence.js:38`).

**A named abandonment closes the gate as abandoned.** A member abandoned for a reason is a decision, not work that
landed. The gate closes as abandoned and its sentence names the member and the reason (`lib/waves.js:356, 374, 420`),
and the lane draws the member as abandoned rather than the stale state word. An unnamed abandonment is a status word:
`normAbandoned` (`lib/assistant/queue.js:496`) normalises a bare `true`, a blank reason or an empty object to none, so
it cannot close a gate, and it cannot dodge a running member either.

**Every unreadable read answers cannot tell, and cannot tell blocks.** The API down, a host with no PR endpoint, a
number the list does not hold, a member with no PR, no sha, a sha the clone does not hold, a main ref that does not
resolve, a git call that throws or answers nothing, an evidence reader that throws or answers no map: all of them are
`unknown` on the gate, and none of them is a pass.

One definite `unmet` still outranks one `unknown`: if a member's PR definitely reads OPEN, the gate is definitely not
closed, whatever another read could not see. With no `unmet`, any blindness is cannot tell.

## The vocabulary stayed closed

Both checks this row needed already exist in the pipeline's 14 names: `pr-merged` and `main-moved`
(`lib/pipelines.js:43-58`), with `main-moved`'s `{remote, main}` parameters at `lib/pipelines.js:63-81`. No fifteenth
name was added and `EXIT_PARAM_SPEC` was not extended.

Five of the 14 now have an evaluator in this slice: `clean`, `commits`, `pr-open`, `pr-merged`, `main-moved`. The other
nine still answer cannot tell, with the sentence that says the name is validated and no evaluator reads it yet. A gate
naming a different `remote`/`main` than the evidence was read against answers cannot tell rather than comparing two
different branches.

## The state is still derived on every read

No `state`, `doneAt`, `abandonedAt` or percentage reaches `waves.json`. The fold runs on every `GET /api/waves` and on
every `GET /api/initiatives`, from the same task objects and the same evidence map, so the lane and the route cannot
disagree. `routes/initiatives.js` `view()` became async to carry the live read; it is awaited at every call site,
including the write responses, so a POST's answer draws the same lane the next GET would.

The only new memo is a 30 s cache of EVIDENCE per member in `server.js` (`WAVE_EVIDENCE_TTL_MS`, keyed by PR number and
recorded sha): the Initiatives tab reloads every 4 s, and six local git calls per member per repaint would make the tab
the busiest thing on the box. It caches evidence, never a state word, and a member whose number or sha changes misses
it at once.

Running is still settled before any gate is read, so a wave cannot close while a member is running, even an abandoned
one. A named abandonment no longer reads as `blocked` just because the row is parked: the park is over by decision, and
the exit gate is what says whether the wave may close.

## Proof, as tests

`test/wave-evidence.test.js` (13 tests) builds a real repository: a bare origin, a clone, and a squash landing it makes
itself. The first test measures the premise before it measures the fix - `git merge-base --is-ancestor <member> <main>`
exits 1, so the sha really was rewritten - then asserts `readLanding` answers `landed` with `ancestor: false`. The rest
pin: a wave whose member was squash-merged closes (from real git, with a stubbed API); content that did not land is not
met; a PR that reads MERGED whose content is not on main blocks; every unreadable landing read answers cannot tell; a
member with no PR answers cannot tell and its stored state word is not evidence; a PR read that throws is cannot tell; a
PR read that answers `ok:false` keeps its sentence; the API head wins over a run's recorded sha; and the route itself
answers unmet for an OPEN PR, unknown for no PR, unknown for a throwing reader and unknown for no reader, never done.

`test/waves-derive.test.js` (22) pins the fold: a running member holds the wave; a MERGED word with no live read is
cannot tell and never done; named vs unnamed abandonment; an abandoned member closes any exit gate as abandoned; an
abandoned member that is still running still holds the wave; main-moved judged by content with a rewritten sha; and a
throwing evidence read is cannot tell and never met.

`test/waves-lane.test.js` (17) pins the abandoned member chip and the abandoned gate chip. `test/queue-wave-id.test.js`
(8) pins that an abandonment round-trips through the queue file, a bare flag normalises to none, and the edit door sets
and clears it. `test/waves-route.test.js` (7) keeps its fail-closed case: an exit nobody can see reads unknown and the
wave reads ready, never green.

The focused runs, all on this branch and all passing: `node --test test/wave-evidence.test.js test/waves-derive.test.js
test/waves-lane.test.js test/queue-wave-id.test.js test/waves-route.test.js test/branch-link.test.js
test/initiative-tasks.test.js` - 98 tests, 98 pass. The live gate `node tools/verify-waves-lane.mjs` answers 40/40 on
a sandbox panel at 1440 and 768: the lane is inside an initiative card, the wave reads running and current, entry
`clean - met`, exit `pr-merged - cannot tell` (the sandbox's members have no PR, so the gate fails closed), every
member's own state is drawn, there is no horizontal overflow, and there are no page or console errors.

## What the changed-set sweep answered

`npm run test:changed` names 210 test files against this diff. It was killed at the standing 20-minute cap with
1,841 tests passed and 7 failed and no final summary printed. Five of the seven reproduce on a `git archive` of
`origin/main` unchanged, measured in a scratch export with the same files: `test/paths.test.js` "every *File / *Dir /
*Log config key..." (`pipelineBundleSeedFile`), `test/assistant-profile.test.js` "the whitelists are gone...",
`test/junctioned-node-modules.test.js`, `test/paths-http.test.js` "Clean scratch over HTTP...", and
`test/reasoning-runs.test.js` "the latest reasoning level survives a jobs-store restart...". The other two,
`test/assistant-director.test.js` "no interval and an empty queue means no cadence..." and
`test/assistant-system-briefing.test.js` "the standing briefing is the run's system text...", pass alone in this tree
and under a concurrent run fail on state another file leaves behind. None of the seven is in this row's code.

No full `npm test` was run: this is a worker tree and the standing budget is targeted tests, with a suite run
cancelled past 20 minutes.

## What this row does not do

No write route for waves, no start button, no automatic advance: those stay the design's later rows. A member is
abandoned through the task edit door (`editTask`, `lib/assistant/queue.js:951`) - the field is recorded and read, and
there is no new button for it in this row. The exit gate still reads only on request; nothing polls a wave in the
background.

The reader's page is `docs/reports/waves-gate-evidence.html`, with the evidence table, the squash measurement and the
fail-closed list.
