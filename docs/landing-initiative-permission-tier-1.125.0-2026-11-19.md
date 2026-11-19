# Landing: an initiative permission tier, a recorded actor, and a brief that uses the map (1.125.0)

PR #799 merged into `main` as `81829f6c` (rebase; five commits: `e41b056f` the tier and the record, `0c50a196` the
brief, `a9c897fe` the headless proof, `2b3a5991` the bump, `81829f6c` the changelog). The branch was cut from
`467fe21d` and rebased over `1.123.1` and `1.124.0` on the way in; `main` read `1.124.0` at the merge, so the rebase
touched two files - `package.json`, where the version line collided and `1.125.0` won, and `CHANGELOG.md`, where the
old render was dropped and re-run against the new base (641 releases).

## What the setting decides, and what it does not

Settings, Board carries one select, four levels, in the reader's words: everything, only removals, only removals of
the trees I attached, nothing. The level decides **only whether the panel parks the question**. It is not a second
permission system: the card that appears is the same shared permission box the initiatives page has always used - the
same once/deny answer, the same deadline, the same resume closure, still `grants: false`, still no remote write. What
moved is one predicate, `initiativeAsks(tier, action, { actor, attachedBy })` in `lib/initiative-permissions.js`.

The level is read from the live config at the top of every request, so a save applies to the next press rather than
the next boot, and it is written to `config.json` under `initiativePermissions` so a restart and every other browser
agree. An absent key normalises to `everything` - which is the behaviour the page had before this landing - and is not
written to disk until the reader picks.

## The fact a level needed, and the record it left behind

The third level - ask me only about the trees I attached - needs a fact the removal request does not carry: who put the
tree there. So the store records `members[tree][initiative] = { at, by }` on every attachment, and one bounded history
(`HISTORY_MAX = 80`, oldest first on disk, reversed for the page) per initiative for create, edit, attach and detach.

Two choices in that record are worth naming. It is written at **every** level, so a change nobody was asked about is
still a recorded one - "not asked (tier <level>)" goes to the log and the history says who and when. And an attachment
with no recorded actor is judged as **somebody else's**, so the third level asks rather than guessing in the remover's
favour: the opposite reading would let an assistant remove the reader's tree unprompted, which is the case the level
exists to stop.

The Initiatives tab draws the level it is reading, names the attachment's actor on the Remove control ("you attached it
12m ago", or the assistant's id, or "no record of who attached it, so every level that asks about removals asks"), and
shows the history behind an accordion fold - "you" for the reader, the assistant's id for a worker, a time on every row.
A 200 that was not asked is drawn as done; a 202 is drawn as a question in the dock.

## The brief

`WORKTREE_BRIEF` sits beside `GIT_BRIEF` and `REPORT_BRIEF` and goes into every tree run: read `/api/initiatives`,
attach the tree where an initiative plainly covers it with `by`, do not create an initiative yourself - raise a clarify
card naming the tree and the initiative you would create, because a card is a question the reader can answer while a
write is a silent decision - and never hand-edit the store. A 202 is described as the question being in the dock and not
to be sent again. It deliberately does **not** tell the worker what the level is: the panel decides that, and the POST's
answer (202 asked, 200 changed) tells the worker what happened. There is no second opinion about the reader's setting.
`worktreeBriefFor` writes the run's own assistant id into `by`, or says to send `agent` when the run has none.

## What was checked

- Unit and route tests: `initiative-permissions` (the decision, four levels by four actions), `initiative-history` (the
  record across a reload, an older file with no `members` block, the bounded newest-first history), `initiative-tier-route`
  (the four levels end to end over a real server and store, including a tree attached under one level judged by the
  record when the level changes), `worktree-brief` (the paragraph in the body actually POSTed, exactly once, and absent
  from the assistant's own turn), and the fold's actor line in `initiative-fold`.
- `tools/verify-initiative-tier.mjs` (`npm run verify:initiative-tier`), a live gate at 1440x900 over a sandbox of its
  own: 33 checks, zero page errors, zero console errors. The same attach press at each level, the third level's own case,
  the fold naming `you` and `scout` with a time on every row, and a worker-role edit arriving as the newest row while the
  page is open. Shots: `01-settings-row-all`, `02-settings-row-none`, `03-card-at-all`, `04-history-fold`,
  `05-history-fold-worker-change`.
- `npm test`: 3,222 tests, 3,213 pass, 9 fail - and all nine reproduce on pristine `origin/main` extracted with
  `git archive` (assistant-profile, assistant-search-scroll, child-route, gateway-permissions, header-controls,
  paths-http, paths, reasoning-runs, scan-roots). This branch adds no failure.

Two page defects the gate found, fixed in the same landing: the Add form said "Ask to add" at levels that never ask,
and an "answer in the dock" note outlived the card it described. And one defect the suite found in this branch's own
work: two new test files carried literal drive-letter paths, which the repository's `absolute-paths` gate refuses - the
first `npm test` run failed on exactly that, the paths are assembled from their parts now, and the gate reads clean.

## Read this before the next landing

At the default level, the reader's own "New initiative" and "Save words" presses now ask first. That is what "ask me for
everything" means, and the two lighter levels exist for a reader who does not want it - but a reader who liked the old
free create and edit has to say so by choosing a level. The existing route tests were updated to name the level each one
needs rather than leaning on a default that no longer leaves create and edit free.

The number is `1.125.0`: a new setting with a new route, a new state shape in the store, and a new paragraph in every
worker brief is a feature, and `main` was at `1.124.0`. The tag `v1.125.0` is anchored at `2b3a5991`, the commit that
declared it.
