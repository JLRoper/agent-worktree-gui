# Project runbooks

One file per project the panel carries, at `docs/runbooks/<project>.md`: the operational how-to an agent needs
before it touches that repository. A runbook is not a decision (the reader's standing rules are) and not a status
report (those live under `docs/reports/`). It is the stable shape of the work: where a change lands, how it is built
and proved, and what the running thing looks like.

## Why they live here

The assistants that read a runbook are started from the panel, and a project's own `AGENTS.md` describes the code,
not the turnover. Keeping every runbook in this repository gives them one review, one diff and one landing flow,
the same flow as every other document in `docs/`.

## The shape

Every runbook carries the same four sections, in this order:

| section | what belongs in it |
|---|---|
| `## Landing and turnover` | the branch work lands on, the host it lands through, the rollup rule, and the table of rollups recorded so far |
| `## Deployment` | the build command, the artifact, where it runs, and how to redeploy it |
| `## Testing` | the focused commands, which of them need Docker, a database or a mail server, and what the pipeline runs |
| `## Runtime and config` | the URLs, path mappings, stores and config keys an agent will meet |

Prose stays short and factual: a command, a path, a fact measured on a named date. A section that would only
repeat `docs/hosts.md` links to it instead.

## The rollup table

`## Landing and turnover` holds one table, newest rollup first:

| rollup | worktree | branch | PR | proof |
|---|---|---|---|---|
| what was rolled up | the tree the fast-forward was made in | the turnover branch | the pull request number | the sha the remote branch reads |

Three rules make a row true:

- **One worktree per rollup**, cut from the turnover branch. A shared tree is reused by the next piece of work,
  and its index cannot take a second rollup's fast-forward.
- **The row names the branch and the PR number**, so a reader can open the request instead of searching for it.
- **The proof is the commit sha the remote branch reads**, taken with
  `git ls-remote origin refs/heads/<branch>`, never a local guess; the local branch in that worktree is
  fast-forwarded to it (`git merge --ff-only origin/<branch>`) and the tree is clean before the row is written.

A row whose local branch is behind its proof is a stale row: fast-forward it or do not record it.

## Adding a project

Copy the four headings from an existing runbook, fill only what is measured, and say nothing about a branch that
has not landed. Name the file after the panel project (`email-multi`), so the file and the board's row read the
same. `email-multi.md` is the first one, and is the example to copy.
