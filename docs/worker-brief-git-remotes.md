# The worker brief's git-remote line

`GIT_BRIEF` in `lib/jobs.js` is the paragraph that tells every worker to reach a remote over ssh. It rides the
assembled brief of a tree run, beside `TERMINAL_BRIEF` and `PAGE_BRIEF`, and it is off for a turn with
`anchorCwd: false` (the board assistant's own reads), because that turn works in no tree and fetches nothing.

## What it says

- A `git clone`, and any remote a run adds, uses an ssh URL: `git@host:path` or `ssh://`. Never an `https://` one.
- Where an existing checkout's `origin` is https, the run switches it with
  `git remote set-url origin git@host:path` BEFORE it fetches, then fetches.

The reason is mechanical, not stylistic: an https remote asks a headless worker for a password nobody is there to
type, and a token pasted into a URL stays in `git remote -v` and in the reflog's remote lines afterwards.

## Why a brief paragraph and not a project rule

`projects[].rules` (lib/project-rules.js, routes/project-rules.js) is only a STORE today. The board's rules bar
reads it and writes it through `POST /api/project-rules`, the snapshot carries the list on each project record, and
that is the whole journey: no code path passes a project's rules into any brief, prompt or run body. So a rule typed
into the bar does not reach a worker, and claiming otherwise would be a lie about what the panel does.

That is what makes `GIT_BRIEF` the one panel-wide lever for this rule: it is appended unconditionally for every tree
run, so it reaches every project's workers without a rules save, a config edit or a per-project runbook. When rules
DO gain an injection path, this paragraph is the wording that path should reuse rather than duplicate.

## Proof

`test/git-brief.test.js` reads the body a stub Runs API actually received and asserts three things: a tree run
carries the paragraph exactly once (`countOf(body, HEADING) === 1`), it names both ssh forms and the `git remote
set-url` step, and an assistant turn (`anchorCwd: false`) carries neither the heading nor the text.

## Adding another paragraph

The shape is the settled one: an exported constant joined with newlines, a `this.<name>Brief?.(opts) ?? CONSTANT`
line in the assembly, gated on `where && opts.anchorCwd !== false`, and a splice in the `anchored` template. Keep it
to the length and voice of `TERMINAL_BRIEF`: this text rides every worker turn forever, so it earns its lines.
