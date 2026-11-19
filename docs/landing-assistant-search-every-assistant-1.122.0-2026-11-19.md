# Landing: the assistant search reads every assistant's turns (1.122.0)

PR #795 merged into `main` as `69453fad`. The assistant panel's header search box now answers over every
assistant's turns instead of only the tab the reader has selected: a phrase that exists in Assistant #2's turns is
found while Assistant #1 is on screen, each result row names the assistant it belongs to, and a press lands the
panel on that assistant's tab with the turn in view and ringed.

## What landed

- `lib/assistant/search.js` - the corpus became a MERGE. Each assistant's own threads (its current thread and any
  thread a hard restart left behind) are matched into their own list, and `mergeAssistantHits()` merges the lists
  into one ordered index while the question is answered. Inside the cap's field preference (your input, then
  replies, then console lines) the merge ranks newest first; a tie at the same millisecond is broken by the
  assistant id, then the thread, then the turn, so the order never depends on the order the groups were read in.
  Every hit carries `assistantId` and `assistant`. The excerpt is still built only for the rows the cap keeps, so a
  filter over a whole store costs one pass to count and a bounded number of windows.
- `lib/assistant.js` - `searchTurns()` builds the per-assistant groups from `this.assistants` and the job store the
  method already read; `assistantId`, when given, narrows the same read to one assistant and still refuses an id
  the panel does not hold.
- `public/assistant.js` - the request no longer sends the open tab's id, so the corpus is not the tab. `searchHitHtml`
  and `searchItemHtml` name the assistant; `assistantIdOfThread()` resolves a thread (current or previous) to its
  assistant once, for the row, the ring and the tab switch. `revealSearchHit()` switches to the hit's assistant
  first, then reveals and rings the turn; a keyboard step that crosses to another assistant's tab puts that turn in
  view, while a step inside one assistant still leaves the transcript where the reader had it.
- `public/core/search-items.js` - the walking order breaks a same-millisecond tie across two assistants by the
  assistant, then the thread, before the conversation's own numbering, and an item carries the assistant its header
  names.
- `public/style.css` - one rule set for the third cell on a row (`.as-search-row-who`), so the assistant's bar names
  its assistant and the Hot Agent rows beside it keep their two-cell grid.
- `test/assistant-search-merge.test.js` (new, 8 tests) - the merge, newest-first inside the field preference, the
  cap's honest `matched`/`displayed`/`turns`, a tie between two assistants decided both ways round, previous
  threads, an assistant with no thread, and the `Assistant`'s own method over a stub store including the refusal of
  an unknown id. `test/assistant-search-items.test.js` gained the page-order half of the tie.
- `tools/verify-assistant-search-all.mjs` (new) - the headless proof at 1440x900, six screenshots.
- `docs/assistant-search-keys.md` - the corpus, the row naming, the tab switch and the two new proofs.

## What proves it

- `node --test test/assistant-search-merge.test.js test/assistant-search-items.test.js test/assistant-search.test.js test/assistant-search-count.test.js test/search-popover.test.js` -
  **62 tests, 62 pass, 0 fail**.
- `node tools/verify-assistant-search-all.mjs` - **44/44 checks passed**, 0 page errors, 6 screenshots in
  `docs/assets/assistant-search-all/`. On Assistant #1's tab, `sextant` (which only Assistant #2 holds) answers one
  row naming Assistant #2, header `1 of 1`, footer `1 hit matched, 1 displayed, in 1 turn`; `Enter` switches to
  Assistant #2's tab, rings the turn, marks the text, and the turn sits inside the float's visible band and under
  the pointer; `beacon` (one turn in each assistant) answers both, Assistant #1's newest first, footer
  `2 hits matched, 2 displayed, in 2 turns`; one `Down` reads `2 of 2` and switches to Assistant #2; `common` (120
  turns across both) answers `120 hits matched, 10 displayed, in 120 turns`, draws exactly ten rows, amber cap, in
  285-764 ms from the last keystroke; `Ctrl+Shift+Q` still opens the Hot Agent search with no assistant cell on its
  rows.
- `node tools/verify-assistant-search-order.mjs` (44/44), `node tools/verify-assistant-search-keys.mjs` (54/54) and
  `node tools/verify-assistant-search-scroll.mjs` (117/117) - the existing gates still pass, and their pictures were
  re-rendered because the rows now name their assistant.
- `npm test` was started on the branch tip twice and did not finish inside the landing window: the machine was also
  running another row's 127-file suite, and the wall clock cut the second run at about 940 s. What is known from it:
  `npm run test:changed` ran 127 files and reported one failure, `test/reply-actions-container.test.js`, which was
  red on `main` before this branch (proved by running the file from a `git archive HEAD` export of the base commit:
  the stylesheet carries two `@container` blocks and the test counted every one). That file is repaired in this PR.
  The other pre-existing reds the 1.121.0 note listed (eight files) were not re-read here.

## The landing

The branch was cut from `22942bb6` (the 1.121.0 landing note), which was `origin/main` at the time, and carried
three commits over it plus the bump. `gh pr create --fill` opened **PR #795** against `main` with
`mergeable: MERGEABLE`, and the merge re-created the commits on `main`:

| branch | on `main` | commit |
| --- | --- | --- |
| `08aaaa41` | `dad731b6` | Search every assistant's turns, not only the open tab |
| `94a76539` | `1353b27e` | test: count the reply box's own container query, not every @container in the file |
| `5e1f5544` | `322d098c` | docs: the search pictures, re-rendered at 1440x900 |
| `04406f2e` | `69453fad` | chore: 1.122.0 - the version this landing carries |

`69453fadb7` is the PR's `mergeCommit.oid` and the commit `main` first declares 1.122.0 at. The merged-at stamp is
`2026-11-19T19:32:45Z`.

`npm run land:pr -- 795` merged the PR but its own follow-up stopped on `the merge was refused - EOF` (gh read a
closed stdin after the merge had already gone through), so its fast-forward and render did not run. The landing was
finished by hand, in `tools/land.mjs`'s own order:

1. the primary checkout `C:/ProjectDevelopment/agent-worktree-gui` was on `main`, 0 ahead and 4 behind, so
   `git merge --ff-only origin/main` carried it to `69453fad`;
2. `npm run land` rendered and committed `CHANGELOG.md` alone as `1de0cd0` -
   `docs: render the changelog - 637 releases` - and pushed `main` with `--no-verify`, the documented exception: a
   render spends no version;
3. the same command moved the published tag: `moved 04406f2ef1 -> 69453fadb7 on origin (--force)` - the commit
   `main` carries, not the branch's pre-merge sha;
4. `npm run changelog:check` reads `current - 637 releases`.

## The gates this push met

- **version gate** - `.githooks/pre-push` ran `node tools/version.mjs check` on the branch: 1.122.0 against
  `origin/main` at 1.121.0, so the bump travelled in the PR rather than after it.
- **absolute paths** - the hook's path gate passed; the new test, script and note name no folder on this machine
  beyond `os.tmpdir()` in the test's own sandbox.

## The version

The level is a **minor**, to 1.122.0. A new capability the panel could not do before (the search reads a corpus it
could not reach), added without moving what already exists: the route's old shape still answers, `assistantId` and
`assistant` on a hit are additive fields, no gesture changed, and the popover is the same one.

## The primary checkout's two edits

The primary carried two tracked edits belonging to another row (`lib/assistant.js`, the numbered-choice parser, and
`test/element-assist.test.js`). They were stashed before the fast-forward and restored after it; the restored diff
is the same work (32 and 60 changed lines, `+81 -11`), and it is the other row's to commit.
