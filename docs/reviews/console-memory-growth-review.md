# Review: A long-lived tab keeps every turn's console

**Scope.** `docs/console-memory-growth.md` reviewed against `1.50.8` (`bb7b4df`), the code it names, and the surviving
harness from the run it reports. The harness (`measure.mjs`, `measure-results.json`) was still in the session scratch
directory, so section 4 was re-read from the raw results rather than taken on trust. This note is ASCII, with no em or
en dash.

**Verdict.** The central finding holds. `state.jobLines` is the one console structure with no global cap, and it
outlives both the job and the board:

- `recordJobLine` trims each turn's array at 1,000 (`public/board/console.js:2698`).
- `applySnapshot` only adds to `jobLines` (`public/app.js:12886`), and `updateJob` does the same (`public/app.js:6762`).
- The only `state.jobLines.delete` is the per-thread clear (`public/app.js:5643`).
- The measured tables reproduce from `measure-results.json`: 14 heap samples, snapshots at 0, 60 and 121 turns, 240
  client records, 19,982 lines in `jobLines`, 14,400 tail lines, 4,548 DOM nodes, 2,278,911 bytes of `/api/jobs` JSON,
  and the cap probe's 1,000 client lines against 60 server lines.

The "Clear finished" and panel-swap probes also match the code paths: `clearThread` deletes the buffer, `clearFinished`
does not (`lib/jobs.js:5209-5212`), and a snapshot never removes an unseen buffer.

**Findings.**

1. **The cap column was wrong for six books.** The doc said "none" for `toolStore`, `batchCalls`, `toolGroupOpen`,
   `codeBoxOpen`, `callOpen` and `callFolded`. Each is capped:
   - `toolStore`: 300 entries, oldest evicted (`public/board/console.js:330`).
   - `batchCalls`: 300 entries (`public/board/console.js:608`).
   - `toolGroupOpen`: 500 (`public/board/console.js:714`).
   - `codeBoxOpen` and `codeBoxShut`: 500 (`public/board/console.js:506`, `public/app.js:14589`).
   - `callOpen`: 500 (`public/app.js:14470`); `callFolded`: 500 (`public/app.js:14532`).
   - The turn books are pruned to the live turns (`public/core/turn-fold.js:196-206`, `public/app.js:14081`).
   `foldRows` and the thinking books remain uncapped, so "none" is right only for those. This does not weaken the
   `jobLines` finding; it sharpens the contrast.

2. **The headline calls total JS data growth "console data".** The 5,332,216 bytes are the heap snapshot's `data` self
   size (string + object + array + number + object shape + closure + concatenated string), which includes the job
   records' own fields, not only console lines. The per-line figure is an amortisation: 5,332,216 / 34,382 slots = 155
   bytes, where the slots include the records' 60-line tails. It is not a line object's own cost. The number is a
   measurement average, so this is left as a finding rather than rewritten.

3. **"44 KB per turn" is 44 KB per driven turn.** There were 241 turns, not 121: 121 driven turns and 120 assistant wake
   turns (`measure-results.json` `final.serverJobs = 241`, `clientJobs = 240`, `serverOnly = 1`). Dividing the
   5,332,216 bytes by 241 gives about 22 KB per turn. The headline already said per driven turn; section 6.1 now says
   it too. A reader who multiplies 44 KB by every turn on the board would double the cost.

4. **"Feel heavier" is not measured.** Section 3 measures heap after GC and heap snapshots only. There is no frame
   timing, allocation profile or responsiveness sample, so the claim that per-poll churn "is what makes a long-lived tab
   feel heavier" does not follow. The churn is real; the felt cost is not in the data. Left as a finding.

5. **The third proposed fix would empty a settled turn's console.** The doc suggests not copying `lines` into
   `jobLines` at all when the record carries the tail. `jobLines()` reads only `state.jobLines` (`public/app.js:348-350`);
   it has no fallback to the job record. Skipping the copy would leave a settled turn with no buffer to draw after a
   reload or a card rebuild. A workable version is to let a snapshot replace a settled turn's buffer with the record's
   60-line tail instead of only adding to it. Left as a finding because it is a design suggestion, not a wrong number.

6. **The line counts omitted the panel's own lines.** A normal turn's 76 lines are 4 x 17 tool lines, 4 prose lines, the
   `run.completed` result, and the panel's `cmd` and init lines, plus a workspace line on a thread's first turn
   (`lib/jobs.js:3106`, `3256`, `3110-3113`). The cap probe's 1,290 is 30 x (1 `tool.started` + 1 result header + 40
   shown preview lines + 1 fold note), with the note from `lib/jobs/console-lines.js:85-92`. Both are now stated with
   their components.

7. **Stale line references.** The doc was written at `461acb4`; main moved to `1.50.8`, and five references no longer
   pointed at the thing they named:
   - `server.js:4649-4651` -> `4655-4658` (the `/api/jobs` route; the old lines are `/api/stats`).
   - `server.js:2808` -> `2809` (`jobs: jobs.list()` in the snapshot).
   - `lib/jobs.js:1262-1377` -> `1255-1377` (`summary()` starts at 1255).
   - `public/index.html:717` -> `723` (`btn-clear-jobs`; the old line is the chevron).
   - `public/assistant.js:3632` -> `3688` (`apiFetch("/api/jobs")` in `loadQueueJobs`).
   One more is still off: section 6 cites `public/app.js:6315` for `thinkDefault`, but the function is at `6322` (6315
   is the `thinkCache` line). Left as a one-line citation in this note.

8. **The "one allowlist line" did not exist.** The doc said the landing gate added "the version bump and the one
   allowlist line". `git show --stat 5ad18dc` shows only the doc and `package.json`; `tools/absolute-paths.allow` has
   no entry for this doc, and the doc holds no absolute path. Corrected to "the version bump".

**Conclusion.** The measurement supports "`jobLines` has no global cap and outlives the job", and the doc names the
right primary fix: a global cap or age-out keyed by turn, plus dropping a buffer when the server no longer lists the
job. The 44 KB per driven turn is real as total JS data growth, not as console-only bytes, and the per-poll churn is
not measured as a felt cost. Read it as a retention finding, not a responsiveness one.

**What changed in the doc.** The table's six cap cells and the contrast paragraph; the 120-array sentence; the five
line references; the 76 and 1,290 compositions; the 290-line drop; the per-driven-turn wording in section 6.1; the
allowlist sentence; the `index.html` reference. The measured numbers, the title, the section structure and the central
finding are unchanged.

**What was not changed.** The headline's "console data" label, the 155 bytes per slot amortisation, the "feel heavier"
sentence, the third fix's premise, and the `thinkDefault` reference. Those are findings above, not code-proven number
errors; the first two are measurement labels, the third is unmeasured, the fourth is a design suggestion, and the
fifth is a one-line citation recorded here.
