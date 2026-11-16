# The approval card says what the command will do, before the command

A parked run shows its command and asks a yes-or-no question. `git reset --hard origin/main && git push --force
origin HEAD` is nine words of shell in which the only two facts a reader is deciding about - the branch's tip is
thrown away, and the result goes to origin - are carried by the flags. Up to `v1.106.1` the card drew the line and
the four choices and left that reading to the reader.

From `v1.107.0` the card carries a block above the command, headed `WHAT THIS WILL DO`, with one short sentence per
step, the effects a reader actually cares about, and the plain statement `reads only - nothing here is written,
deleted or pushed` when the command changes nothing. The reading is derived on the page from the same string the
card shows: no model call, no network, no lookup (`public/core/command-summary.js`, landed in PR #769).

The command is not replaced. It stays beneath the block byte for byte, with the four choices and the countdown it
had, and the section below is about the one invariant that matters: the summary is a reading of the thing being
allowed, never a substitute for it.

## One sentence per step, from a split the shell would agree with

The line is split on `&&`, `||`, a lone `;`, `|` and a newline - the five ways one line carries several steps -
quote-aware and parenthesis-aware, because `echo "a | b"` is one step and `git rm $(git ls-files -m | head -1)` is
one step too. Each step then names its program with its subject, counted where a count is the fact and named where
the fact is which thing:

- `git add` with twelve paths reads `git add: 12 paths`; with one, `git add: this one path`; with `-A`, `git add:
  everything that changed in this tree`.
- `git rm --cached vendored/x` reads `git rm --cached: this one path` - the flag is part of the name, and the step
  is not flagged as a delete, because unstaging is not deleting.
- `git rev-parse :docs/a.txt && git hash-object docs/a.txt` reads as the two ids it is:
  `git rev-parse: the object id this path has in the index` and `git hash-object: the blob hash git gives this
  path's bytes in the worktree`. `git diff -- docs/a.txt` says the same thing in one step: `compare the blob hashes
  of this path in the index and the worktree`.

A program the module does not know is described honestly - `frobnicate: dist/widget.bin`, and no claim that it only
reads - and a command with more than ten steps is drawn to ten with `and N more steps - read the command below`.

## The effects, one row each, and one chip

Deletes, history rewrites, pushes, anything naming PROD or a live port, a write outside the repo, and `sudo` are
drawn as their own warn rows under the steps. `git reset --hard HEAD~1 && git push --force origin main` carries
three: `discards uncommitted changes`, `moves this branch's history`, `pushes to origin`.

The head carries one chip: `reads only` in green, or `changes things` - in red once one of those effects is present.
A GET against `prod-api.prog.sefl.com:8443/health` is the case the two halves exist for: it writes nothing, and it
still touches PROD and a live port, so it is `reads only` and red at the same time.

Two false positives were worth the code: a value that is not a path is not a path (a commit message quoting a
folder is not a write outside the repo), and a write is judged against the tree the command runs in - `cp
build/app.jar <this tree>/dist/app.jar` is a write, not an escape. The tree comes from the caller: the turn's own
`cwd` on the card, the dock's worktree on the dock's card. Without a tree the block says nothing about
outside-writes rather than guessing.

## The agent's own words win, for the prose only

A command may lead with `[Clean the stale export]` or with a first-line `# ...` comment - the agent saying what the
step is for, which is better than anything a reading of the flags can infer. That line becomes the block's lead,
above the steps. It never suppresses a flag: a titled command that pushes still carries `pushes to origin`, because
hiding that behind a cheerful title is the one failure a reader could not forgive. A shebang is not a summary.

## What the reader sees, and what the page still runs

The block is drawn between the head and the command, in the card's own amber, as an inset note (`public/style.css`,
`.ta-summary` and its rows), and on the dock's cards it is the same block trimmed to the steps and the flags. The
callers pass the tree, and an old page served with a new `app.js` - no `wtCommandSummary` on the window - draws no
block at all, which is exactly what the card did before this landed.

## What was run

- `node --test test/approval-command-summary.test.js` - 15 tests: the split (quotes, `$(`, `2>&1`, empty steps),
  the three sentences the brief names, a read-only command's chip and sentence, a destructive command's three
  flags, PROD and a live port on a command that only reads, a write outside the repo and one inside it, the
  `[Title]` and first-line-comment leads, escaping, the markup order (summary, then command, then the four choices,
  then the countdown), and the absence of `fetch`, `require` and `Date.now`.
- `npm run verify:approval-summary` (`tools/verify-approval-summary.mjs`) - 64 checks, all pass: a throwaway panel
  of its own, a stub Runs API and three real runs started through `POST /api/agents/reply`, each parking on an
  `approval.request`. The card is read off the painted DOM at 1440x900 - the block above the command, the command
  byte for byte, the chip, every step, every flag, the four choices enabled, the countdown ticking, nothing clipped
  - and each case is answered through `POST /api/jobs/approve` afterwards.
- `npm test` - the full suite, once, before the pull request: 2916 tests, 2907 pass, 9 fail. Every failing file
  fails the same way on a pristine export of `main` (gateway permissions, the child route, the paths config keys,
  the scratch cleanup, `windowsHide`, the moved stream control), and none of them is a file this branch touches.

The three captures are the three cases, at 1440x900, in `docs/assets/approval-summary/`:

| case | command | what it reads as |
| --- | --- | --- |
| `read-only-1440x900.png` | `git status --short && git diff -- docs/readme.md` | two steps, `reads only` in green, the read sentence |
| `destructive-1440x900.png` | `git reset --hard origin/main && git push --force origin HEAD` | two steps, three flags, the chip red |
| `title-override-1440x900.png` | `[Clean the stale export] git rm --cached ... && git commit -m ...` | the agent's title as the lead, two steps, no delete flag |

## Reversing it

The block is additive presentation and nothing reads it back, so removing the `/core/command-summary.js` script line
from `public/index.html` returns the card to its `v1.106.1` look in one edit; `permissionBoxHtml` draws nothing when
the module is absent. Removing the call as well is two lines in `public/app.js`, and the stylesheet rules are inert
once nothing renders the markup.
