# Landing: `file-exists` reads the member's tree, else its landing commit (1.161.0)

A wave's exit gate could name `file-exists` from the first slice, and nothing read it: `pickWaveGate` validated the
name and `readWaveGate` answered cannot tell, with the sentence that says the name is validated and no evaluator reads
it yet. On a repo with a remote the other checks usually cover the same landing (`pr-merged`, `main-moved`), but on a
repo with NO remote they do not exist, and the three that remain each fail the same wave: `clean` is transient (the
next commit makes it false), `commits` needs an unmerged branch (a landed wave is even with main), and every PR check
needs a PR the local-only repo never had. A wave whose acceptance is an artefact therefore could not close at all.

This row gives that check a read. Nothing else moved: the vocabulary is still the closed 14, `pickWaveGate` is
unchanged, no wave stores a state, the two read routes answer the same shapes, and there is no new field, route, tab or
button.

## Rule 1: a path is read from the tree, and the tree is authoritative while it exists

`readMemberPath` (`lib/wave-evidence.js:238`) answers one of three states (`PATH_STATES`,
`lib/wave-evidence.js:182`): `present`, `absent`, `unknown`. The first thing it does is stat the path inside the
member's own worktree:

- the path is a file: `present`, `where: "tree"` (`:257`);
- the tree holds something at that path that is not a file (a directory): `absent`, and the sentence says "not a file"
  (`:259`);
- the tree exists and holds nothing at that path: `absent`, `where: "tree"` (`:262`), and MAIN IS NOT CONSULTED - the
  tree is the copy the work is in, so a member whose tree does not hold the artefact is not met by somebody else's
  landing. `test/wave-file-exists.test.js:151` pins this: a tree that exists without `docs/absent.md` reads not met even
  though the base commit on main does hold the artefact this wave is about;
- the tree itself cannot be read (a permission, a dead drive): `unknown`, never `absent` (`:253`). "Could not look" and
  "is not there" are different facts and the gate treats them differently.

The stat is `statAt` (`lib/wave-evidence.js:214`), which separates `ENOENT`/`ENOTDIR` from every other error for exactly
that reason.

## Rule 2: when the tree is gone, the path is read out of a commit on the wave's main

A landed wave's tree is removed - that cleanup is the normal end of the work - and the row in the queue still names the
tree that is gone. The read then moves to git, with no worktree on disk (`lib/wave-evidence.js:270`):

1. resolve the main ref (`rev-parse --verify <ref>^{commit}`);
2. take the NEWEST commit on that ref that touched the path (`git log -1 --format=%H <ref> -- <path>`);
3. list that commit's own entry for the path (`git ls-tree <commit> -- <path>`) and match the entry whose path is
   exactly this one - not a pathspec match, the entry's own path;
4. a `blob` entry is `present` and hands back the commit and the blob id; a `tree` entry (a directory) or no entry at
   all is `absent`.

That commit is an ancestor of main BY CONSTRUCTION: `git log <ref> -- <path>` walks `<ref>`'s own history, so a commit
that only exists on an unmerged branch is not in the list. This is the rule that keeps an unmerged branch from ever
reading met, and it is pinned twice: over a real branch in `test/wave-file-exists.test.js:177` (`docs/branch-only.md`
committed on `feature/unmerged`, never merged, reads `absent` with `where: "landing"`), and live in
`tools/verify-wave-file-exists.mjs` step 3, where the wave that names that path reads not met and never done.

## Rule 3: a repo with no remote falls back to its local main, and says which ref it read

`mainRef` is the caller's - the composition root passes `origin/<mainBranch>` (`server.js:1971`). A local-only repo has
no `origin/main`, which is the repo class this check exists for, so an unresolvable remote-tracking ref falls back to
the local branch of the same name (`lib/wave-evidence.js:288`), and the answer names the ref it actually read
(`ref: "main"`, `mainSha`) rather than pretending it read the one it was asked for. With no ref resolvable at all the
answer is `unknown` with the ref and git's own reason - never a throw, never an absence.

## Rule 4: unknown, never a throw, when there is nothing to read

Every failure is a sentence and `unknown`:

- the gate names no path: "the gate names no path" (`lib/wave-evidence.js:240`);
- a path that is not repo-relative (an absolute path, a drive letter, `~`, a `..` segment) is REFUSED rather than
  resolved (`repoRelativePath`, `lib/wave-evidence.js:203`, and the refusal at `:242`): a gate names an artefact in the
  tree, and a read that climbed out of it would be reading this machine;
- no tree and no clone to ask: "no tree and no clone are named" (`:272`);
- a git reader that throws: "git threw: ..." (`:277`), which is cannot tell for the member and never a pass;
- a read that was never made for this path - the evidence carries no entry for it:
  "no read of <path> was made for #<id>" (`lib/waves.js:1005`). The gate never reads unmet because a caller forgot to
  ask.

`test/wave-file-exists.test.js:195` proves all five, and the last one is what keeps the route wiring honest: the gate
is judged on a read the request carries, not on a path it hopes somebody read.

## Rule 5: no board row is required, and that is the point of this check

`clean` and `commits` read the board row because the row IS the fact. An artefact's fact is the read, so the gate does
not require `hasRow` (`lib/waves.js:991`): a landed wave whose tree the scan has dropped - its own cleanup - must still
close on its landing commit, or the wave would come open the moment it was cleaned. `test/wave-file-exists.test.js:195`
asserts both halves: a member with no row and a `present` read is met, and a member with no row and no read is cannot
tell. The live gate proves the same thing twice: the removed tree (step 2) and a member whose tree the board never saw
(step 2b) both keep the wave done.

A NAMED abandonment still closes the gate as abandoned, above the switch, exactly as the other checks do
(`lib/waves.js:920`; `test/wave-file-exists.test.js:238`), and an unnamed one is cannot tell.

## Rule 6: the paths the gates read are handed to the read, and they are part of the memo key

Only the request knows which waves it is about to fold, so both read routes gather the artefact paths of the waves
they are reading and hand them to the evidence read: `GET /api/waves` at `routes/waves.js:158` (per initiative) and the
board's `GET /api/initiatives` at `routes/initiatives.js:323` (every initiative in the answer). The gatherer is
`waveFileExistsPaths` (`lib/waves.js:853`): unique, in the order the gates name them, capped by
`WAVE_ARTEFACT_PATHS_MAX` (`lib/waves.js:106`, 8), and it reads both gates - a wave may gate its ARTEFACT on entry as
well as exit.

`readMemberEvidence` carries one read per path as `files`, keyed by the path exactly as the gate wrote it
(`lib/wave-evidence.js:361`), and `collectWaveEvidence` forwards `paths` unchanged (`lib/wave-evidence.js:512`). The
composition root's 30 s memo includes the path list in its fingerprint (`server.js:1944`): the same member read for a
different gate path is a different read, so a memo hit that answered for one path is never handed to a gate asking
about another. The wave driver, which folds a lane right after a settle, hands the same paths in
(`lib/waves-driver.js:367`), so a close the panel is deciding to advance is not held by an artefact gate nobody read.
`test/wave-file-exists.test.js:249` pins the wiring - two waves, three gate paths, one read, paths unique and in order
- and folds the answer it gets back into a done wave.

## Rule 7: the record and the routes are unchanged

- No state is stored: the store still holds `version`, `savedAt` and `byInitiative` only, asserted live
  (`tools/verify-wave-file-exists.mjs` step 1).
- The vocabulary is still the closed 14 (`lib/pipelines.js`), and `file-exists` keeps its one required parameter,
  `path`: the store refuses a gate with no path by name (`test/wave-file-exists.test.js:285`).
- The two write routes and their bodies are untouched. The only route change is the extra argument the read routes
  pass to the evidence reader, which is optional and defaults to no paths - a fixture that composes the route without
  it still works, and its gates read cannot tell rather than absent.

## Proof, as tests

`test/wave-file-exists.test.js` (8 tests), every case a real git read in a temp directory, because the facts are ones a
stub cannot settle:

1. a landed local-only wave closes on an artefact in the member's tree (`:105`) - gate met, wave done, and no state
   written;
2. the artefact in the landing commit keeps the wave closed after the tree is gone (`:129`) - the read names the commit
   on main, the fallback ref and the main sha;
3. a path that is absent is unmet (`:151`) - in a tree that exists, for a directory at the path, and in a landing that
   does not hold it;
4. a file that exists only on an unmerged branch is never met (`:177`);
5. unknown, and never a throw, when there is nothing to read (`:195`) - no member, no row and no read, no tree and no
   clone, a throwing git reader, and a path that is not repo-relative;
6. a named abandonment still closes as abandoned, not met (`:238`);
7. the route hands the gate's paths to the evidence reader and folds the read it answers (`:249`);
8. the store refuses a `file-exists` gate with no path and keeps one the read can name (`:285`).

The one existing test this row had to change is the vocabulary test that named `file-exists` among the checks with no
evaluator: it now names the eight that still have none, and says where `file-exists` is proved
(`test/waves-derive.test.js:146`).

The focused set, run file by file on the final tree: wave-file-exists 8, wave-evidence 13, waves-derive 22,
waves-auto 12, waves-write 22, waves-lane 40, waves-route 8, waves-store 17, waves-lanes-join 10, waves-drive 11,
queue-wave-id 8, initiative-fold 26, initiative-tasks 18, initiatives-route 9, initiative-tier-route 7 - **231 tests,
231 pass**.

RED FIRST, and the counts: `test/wave-file-exists.test.js` was written before the read existed, and `npm test` on that
tree answered **3,658 tests, 3,643 pass, 15 fail** - the seven `file-exists` cases above failing for the reason the row
names (the gate answering "no evaluator reads it yet", and the evidence carrying no artefact read at all), plus eight
failures that are this machine, not this diff (below). The final tree was swept one file per child process because the
shared runner wedges on a panel route test at this base: **424 files, 3,673 tests, 3,656 pass, 17 fail, 1 file killed by
the loop's own 150 s bound**. Every failure is accounted for and none is in the wave, gate, evidence, route or driver
machinery:

- THE BASE'S SNAPSHOT DROPPED THE PANES, and seven fixtures still read them out of it: the assistant roster from
  `.assistant.assistants`, the question a move parks from `.remoteWrites.pending`. Five of those fixtures are this row's
  own route tests (`waves-route`, `initiatives-route`, `initiative-tier-route`, `waves-write`, `reports-route`) and are
  repaired in the commit before this one - all five are green here (8, 9, 7, 22 and 1 tests). The other three are not
  this row's subject and are left to the row that owns them, proved to fail identically at `origin/main` on an archive
  copy with none of these commits: `worktree-assistant` 6 of 11, `worktree-naming` 15 of 16,
  `assistant-queue-reattach` 13 of 14;
- the same eight that failed on this machine before any of this row's work, at the old base: `gateway-permissions`,
  `paths` (`every *File / *Dir / *Log config key`), `paths-http` (`Clean scratch over HTTP`), `reasoning-runs`,
  `scan-roots`, `scan-upstream`, and the junctioned-node-modules measurement that `harness` and
  `junctioned-node-modules` each report;
- `push-permissions` was killed at the loop's 150 s bound (exit 124) after 14 of its 17 tests, and it passes alone on
  this branch: 17 tests, 17 pass. Load, not this diff.

The live gate, `node tools/verify-wave-file-exists.mjs`: **OK 52/52 checks passed** through the real API in a sandbox
panel - a throwaway row filed with a `waveId` by `POST /api/assistant/queue`, a wave created by `POST /api/waves` whose
exit gate is `file-exists` on a file already on the local-only main, `GET /api/waves` reading **done** with the gate
**met** from the tree, the tab's `GET /api/initiatives` agreeing, the tree removed and the same read **still done** with
the gate **met** from the landing commit, a member with no board row at all still **met** from the landing, a second
wave on a path that exists only on an unmerged branch reading **unmet** and never done, and the store put back: both
waves removed through `POST /api/waves/remove`, the rows closed, the wave store an empty map and the initiative store
byte-identical to its snapshot.

## What this row does not do

- **No new gate name and no new parameter.** `EXIT_CHECKS` is still the closed 14; `file-exists` still takes `path`
  and nothing else.
- **No evaluator for the other eight.** `command`, `branch-exists`, `pushed`, `pr-head`, `pr-approved`, `pr-comments`,
  `reviewers-exact` and `branch-name` still answer cannot tell by name. `pushed` and `branch-exists` are the obvious
  next ones for a local-only repo, and each needs the same kind of live read.
- **No pipeline change.** The 14 names are shared with the pipeline stages, and this row adds no evaluator to
  `lib/pipelines.js`: the pipeline's own `file-exists` gate is still not asked (`docs/pipelines-audit.md:550`).
- **No write, no UI, no background loop.** The gate is read on the two reads that fold waves and nowhere else. Nothing
  polls, nothing watches a path, and no wave state is written.
- **No change to the 30 s evidence memo.** It is inherited, path list included in the key, so a gate can lag a fresh
  file on disk by up to the memo - stated here rather than papered over.
