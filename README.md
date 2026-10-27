# agent-worktree-gui

A local panel that watches every git worktree across one or more projects, and runs Hermes agents in
their own worktrees — live output, mid-turn steering and approvals on the agent's card.

Zero dependencies. No `npm install` needed: plain Node (`node >= 22.5`) + stdlib, plus HTML/CSS/JS
served straight from `public/`.

    start.cmd              # foreground (Ctrl+C to stop)
    start-background.cmd   # detached, logs to logs\server.out.log / .err.log
    stop-background.cmd    # stop it

Then open **http://127.0.0.1:7331**. The page itself — every control, chip and gesture — is documented in
[docs/using-the-board.md](docs/using-the-board.md).

## Running it on another machine

**Point an agent at it.** `SETUP.md` is written to be *executed* rather than read: exact commands, a
verification section, and what each failure mode means. The repo is private, so hand an agent on the
other machine this:

> Clone `JLRoper/agent-worktree-gui` with `gh` (it is private), follow `SETUP.md`, set `scanRoots` to
> where my repos live, verify it, and give me the URL to open.

Make the repo public and the raw URL works by itself:
https://raw.githubusercontent.com/JLRoper/agent-worktree-gui/main/SETUP.md

By hand — Node 22.5+ and nothing else, no dependencies, no build step:

    gh repo clone JLRoper/agent-worktree-gui
    cd agent-worktree-gui
    setup.cmd            # Windows: first-run checks (node / git / hermes)
    ./setup.sh           # macOS/Linux: same checks
    start.cmd            # or: node server.js

Edit `config.json` first: `scanRoots` is where your repos live (every git repo under it is
monitored), plus `host`/`port`. If `config.json` is missing the panel starts on defaults and says so.

The two gateway-connected bits are Windows-flavoured and degrade elsewhere:
`API_SERVER_KEY` is read from the process environment, else `$HERMES_HOME/.env`; the `:port` /
`● board` liveness signals read `netstat` / `tasklist`, so off Windows those two signals simply stay
dark — everything else works.

`node tools/verify-verdicts.mjs [project]` re-derives every row's merge verdict straight from git and
diffs it against the panel (exit 1 on any mismatch) — useful after touching the scan logic.

`node tools/verify-subagent-turns.mjs` runs the chip-attribution out of `public/app.js` against the
card that mis-filed five reviewers, then the edges around it — useful after touching how a turn owns
the subagents it delegated.

`node tools/verify-spawn-target.mjs` cuts a worktree in a throwaway repo, renames it the way the panel
renames one, and makes `lib/spawn-target.js` find it again — by the stale path, a branch, a worktree
directory name, the tag alone and a thread's slug — then checks both refusals (several matches name their
candidates, none keeps the old wording) and that the card says which tree was picked — useful after
touching what a SPAWN IN line may name.

`node tools/verify-named-tree.mjs` proves the naming ledger (the once-per-tree rename, `lib/tree-names.js`)
and the `✦` name-from-the-work button against a panel of its own — sandbox `PANEL_CONFIG`, spare port,
sandbox `$HERMES_HOME`, stub gateway, throwaway repo — useful after touching anything that renames a tree.

`node tools/verify-description.mjs` proves the `DESCRIPTION` strip above MERGE STATE — the record's earliest-run
choice, the live half through a real spawn against a stub gateway, and the whole client half in headless Chromium
(bullets matching the merge state's own list, folded on a fresh expand, unfolded by a click and still unfolded
after a reload, folded again by a second click, a stale legacy key with no say, absent for a tree with no run) —
useful after touching `lib/descriptions.js`, the harvest in `server.js` or that strip in `public/app.js`.

`node tools/verify-merge-state.mjs` proves the `MERGE STATE` strip's own detail in a sandbox of its own — three
hand-cut worktrees (five commits off remote main and a dirty tree, fourteen commits and a clean tree, nothing at
all) over a throwaway repo with a bare `origin`, and headless Chromium over the running panel: every commit on its
own line at the full width of the row, a fourteen-commit list drawn whole and unclipped, the two file strips one
line each with their counts and their names hidden, every open/close combination of the three folds, the empty
strips absent on a clean tree, and the `DESCRIPTION` and `LIVENESS EVIDENCE` strips around it untouched — useful
after touching that strip in `public/app.js`. Point it at a Playwright install with `PANEL_PLAYWRIGHT_ROOT`;
without one it reports `BROWSER-HALF-NOT-RUN` and fails rather than passing on a half that never ran.

`node tools/verify-action-harvest.mjs` drives three real assistant turns through a stub gateway whose stream
carries the reply the way the live one does — one paragraph per text line — and then reads the job store and the
journal back: one turn carrying SPAWN, SPAWN IN, TO, WATCH, NOTE and RULE must produce one job per run-creating
action, a turn carrying a project that does not exist and a thread that is not on the board must journal each
drop with its reason and still start the spawn written after them, and a thread lookup that throws inside the
injected job store must cost only the line that touched it — useful after touching how a finished turn's lines
are read.

`node tools/verify-leftover-holder.mjs` proves the `leftover` rule's holder check end to end in a sandbox of its
own: a real panel from this worktree over two real git worktrees of a throwaway repo — one dirty with nobody in it,
one dirty with a live run in it — with the panel's own scanner and sentry, and headless Chromium over the served
board. The unheld tree must raise its leftover and the held tree must raise nothing, across a dozen ticks in which
the held tree's own counts move (which is how the false alert used to re-fire, once per count). The live holder is
seeded the way the board really gets one back: an interrupted card with a run id, re-attached by the boot reconcile
against a stub Runs API. Point it at a Playwright install with `PANEL_PLAYWRIGHT_ROOT`; without one the browser half
reports `BROWSER-HALF-NOT-RUN` and the rest still runs.

`node tools/merged-branches.mjs` lists every local branch with the merged or open PR that owns it, and
`--prune` deletes only the branches a **merged** PR accounts for. It decides from PR state because git
ancestry cannot see the merge: the repository ruleset requires linear history, so a PR lands as a squash or a
rebase and GitHub re-creates the commits, which leaves the branch's own SHAs off main and its tip a
non-ancestor forever. **"Ahead by N" is never a merge signal in this repo**, and "0 ahead" is not proof of a
merge either — a branch cut from main with nothing committed reads the same way. So a branch no merged PR
names is reported and left alone, as are the default branch, branches checked out in a worktree and branches
with an OPEN PR; `--prune` deletes local refs only, never a remote branch, a tag or a worktree — useful when
the fleet's merged worktrees start to pile up.

`.githooks/commit-msg` refuses a commit subject that does not name a symptom (`wip`, `fix`, `updates.`, a
trailing full stop, anything under 12 characters). This repo sets `squash_merge_commit_message =
COMMIT_MESSAGES`, so a squash lands the branch's own commit subjects as lines in main's history: a subject
written as a private note becomes permanent. Install it once per clone — `npm run hooks:install` runs
`git config core.hooksPath .githooks`, and that repo config covers every worktree of the clone — useful before
handing a branch to another agent. The hook is **local**: it binds this machine and this clone only, and this
repo has **no CI**, so nothing refuses a bad subject at PR time either; its own author can also bypass it with
`git commit --no-verify`. The index stores the script executable (mode 100755), so a non-Windows clone runs
it without a manual `chmod`; if a checkout ever loses the bit, `chmod +x .githooks/commit-msg`.

`.githooks/pre-push` refuses a push that carries commits with no version bump: it runs
`node tools/version.mjs check` (a branch whose `package.json` version is still its base's, and which carries
commits of its own, is refused; an already-bumped branch and a branch with nothing on it pass silently). The
level is a judgement the landing agent makes from the diff and lands in the same PR as the change —
`node tools/version.mjs suggest` advises, `apply <patch|minor|major>` writes the one place the version lives,
and `docs/versioning.md` is the scale. The merge prompt tells the landing agent to do it. Same install covers
both hooks, and the same `--no-verify` bypasses this one.

`node tools/verify-charter.mjs` seeds a charter from a store full of rules and notes, checks the prescribed
headings and the cap, checks that the whole file is in the per-turn briefing while the polled state carries
only its path, size and mtime, drives all three writers (the reader's save, a `CHARTER:` line through the
harvest, a standing rule changing) and both refusals (over the cap, and a save that read an older file) — then
boots a real instance on a scratch port and exercises `GET` and `PUT /api/assistant/charter` over HTTP,
including the `413` and the `409`, without touching the live panel — useful after touching the continuity file.

`node tools/verify-age-collapse.mjs` builds a throwaway repo with three worktrees whose activity ages are known
to the minute (one committed 45 days ago and left alone since, one committed 45 days ago but worked in half an
hour ago, one committed today) and drives a sandbox panel plus a headless Chromium over it: the default the
panel applies with no key in `config.json`, the chart at rest holding the stale tree back and saying so in a
chip, the arrow invisible and unclickable until the chart is hovered — with its computed style compared against
the console's own tail chip, built on the page by the panel's own renderer — one click drawing every tree, the
reload that has to come back with that choice, the Settings control writing `config.json` and the chart
redrawing from it, and `0` putting every tree back with no arrow left behind. Point it at a Playwright install
with `PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright>` (e.g. the `heroes-js` checkout on this box);
without one it prints `BROWSER-HALF-NOT-RUN` and **fails** rather than passing on a half that never ran —
useful after touching the chart or the age threshold.

## Two halves

### Monitor (read-only)

Worker threads scan the projects; the HTTP layer never runs git itself. Rows are patched
individually over SSE and flash when something changed.

**Projects are discovered, not hard-coded.** Every git repo under `scanRoots` (config.json) is
monitored, and the project list is ordered by how recently it was worked on — the newest of the
repo's last commit and the newest file edit inside any of its worktrees. Non-git directories are
listed in the footer as skipped rather than silently ignored. An entry in `projects` overrides what
discovery finds for that name (heroes-js carries a `prRepo`).

**Where the branch and PR links come from.** Not from this code: a host record in
`logs/hosts.json` (merged over the committed `hosts.seed.json`) says which host a project lives on and
carries the templates every link is built from, so a GitHub repo and a `git.sefl.com` one link to their
own pages without either shape being written into the panel. A project with no mapping gets plain text
and the reason instead of a guessed URL, and its header chip is where you fill one in — press it to read
the project's remote and confirm the mapping it proposes. The tokens, the precedence, the `api` block
and the landing doctrine are in [docs/hosts.md](docs/hosts.md).

**Projects are grouped under their folder.** Each scan root is an accordion
(`C:\ProjectDevelopment\` by default) holding every project that is actually inside it; a project
that lives outside every configured root — an explicit `projects[]` entry can point anywhere —
gets its own sibling accordion for its parent folder, so nothing is ever filed under a folder it
is not in. The folder header carries the aggregate chips (projects, worktrees, unmerged, dirty,
live), a **Collapse all / Expand all** button for the projects inside it, and a green **+** that
opens a clone row: type a repo name (`name`, or `owner/name`) and press Enter to clone it over SSH
into that folder (`git@github.com:<owner>/<name>.git`). The folder itself collapses from its
title line; the collapsed set is remembered in localStorage.

**Every project starts minimized** to its title line — click the line (or its chevron) to open it,
and the projects you opened are remembered in `localStorage`, so a reload or a resync keeps your
layout. The title line keeps the per-project chips (merged / unmerged / no commits / dirty / live /
open idle / serving / safe to remove), so a minimized project still reports its state at a glance.

**Cadence is adaptive.** One 1-second ticker decides what is due per worktree:

| Cadence | Applies to | Default |
| --- | --- | --- |
| liveness | the evidence chips (files / hermes / board / port) on every row — no git involved | `liveSeconds` (5) |
| active | live session, open-but-idle session, dirty/untracked files, unmerged work, verdict not yet computed | `worktreeSeconds` (5) |
| dormant | merged / no-commits / on-main and clean | `dormantSeconds` (30) |
| full | project meta, worktree discovery, expensive per-worktree fields (cherry, reflog, commit list, PR) | `slowSeconds` (60) |
| fetch | `git fetch <remote> --prune` per project | `fetchSeconds` (600) |

Re-reading every dormant tree every 5 seconds cost ~100 git processes per pass and returned no new
information. The pool also refuses to duplicate a worktree's scan and serialises two scans of the
same worktree, so the cheap and expensive passes can never race into the same row.

**Rows are sticky.** A worktree is dropped only after `git worktree list` has omitted it on two
consecutive discovery passes, and never when that call itself failed or came back empty — a
transient git hiccup cannot blank the table. New worktrees appear on the next discovery pass.

Per-worktree verdict:

| Verdict | Meaning |
| --- | --- |
| `MERGED (N commits)` | the branch really did carry commits and they are now in remote main (reflog evidence; N counts only commits the branch itself made, not main commits it merged in) |
| `NO COMMITS` | the branch never moved off its creation commit — there is nothing to merge, and nothing was merged |
| `ON MAIN` | this is the primary checkout of the main branch |
| `UNMERGED (N commits)` | carries commits not on remote main |

`MERGED` is only claimed when the branch has commits of its own **and** they are in remote main. A
worktree whose branch has zero commits (a freshly made `wtgui/…` tree, or a branch created and never
committed to) reports `NO COMMITS` instead — and is deliberately *not* counted as safe to remove, so a
new worktree is not swept away. The discriminator is the branch reflog: `git reflog show <branch>`
has exactly one entry for a branch that never moved, and more for one that did.
| `?` (grey, dashed) | verdict not yet computed / reclassifying |

Liveness is **evidence-based**, never a generic "some process is running":

- `⧉ hermes` — a Hermes session in `$HERMES_HOME/state.db` whose `cwd` is this worktree and whose
  `last_activity_at` is within `liveMinutes`
- `● board` — an `.agentboard/{PID}.json` entry whose PID is alive right now
- `:port` — the `API_PORT` declared in this worktree's `.env` is actually listening
- `✎ files` — a dirty/untracked file was edited within `liveMinutes`

A row is **live** only if one of those fired. An open-but-idle session shows as grey `⧉ N idle`
and is counted separately ("open idle" chip). `MERGED` + clean + not live = "safe to remove".

#### What a worktree is called

A tree is cut from the prompt, so its name starts as the reader's first sentence cut at 24 characters —
usually mid-word. Hermes names the *session* from the work a moment later, and the panel gives the tree that
name the moment the title exists — the 10-second title sweep emits it, and the rename lands as soon as no run
is standing in the tree (git will not move a directory a live shell holds, so the first attempt inside a turn
is deferred, not lost): the directory (`git worktree move`) and its branch (`git branch -m
wtgui/<slug>-<tag>`, the six-hex tag kept). That name is set **once per tree** and the "once" is a record,
not a hope — `logs/tree-names.json` beside the job store (`config.treeNamesFile`, see `lib/tree-names.js`),
keyed on the tag every rename keeps, holding who named the tree and when. Three rules make the once a fact:

- **A tree the panel cut is written down at the cut**, before `git worktree add`, naming the run it was cut
  for — so a tree is never visible as "unnamed" while the run that owns its name is still starting, and only
  that run's first title may take it.
- **A tree the panel did not cut is seeded, never renamed.** Every tree `git worktree list` answers with that
  has no entry is written down at boot, and on every later listing, under the name it was found with: the
  fleet that existed before this ledger — every tree in this repository's own `.worktrees/`, every tree another
  tool cut — reads as named from its first moment. A run started into one of them cannot rename it, whatever
  `existing` it claims.
- **A landing settles it.** A rename that lands, a rename that finds its target directory already taken, and a
  reader's own rename all settle the record, so no later event of that run and no later run can move the tree
  again. The project's own checkout is never recorded: its name is the folder's.

The record is what the board's row reads, so the tooltip on `✎` says who named the tree and when. A second run
started into a named tree cannot rename it: it would move the directory and the branch out from under the run
that already lives there, which is how one worktree ended up with a directory named one thing, a branch named
another, and three live cards each spelling a different branch.

Two buttons sit beside the worktree name, and neither is automatic:

- `✎` — name it by hand. It opens a box with the session's title offered and takes anything typed; the
  rename itself is `POST /api/worktree/rename` (the branch always, the directory when nothing holds it
  open), and the result is written down as the reader's name.
- `✦` — name it **from the work**. `POST /api/worktree/suggest-name` reads the branch's own commits
  against the base branch and its diff (`<base>...HEAD`, plus anything uncommitted), reduces them to a
  name in the panel's own `<slug>-<tag>` shape (`lib/name-from-work.js`), and renames nothing at all: the
  name, the commits it came from and what the tree is called now go into a question under the row — the
  same shape as the delete question, with `Name it`, `✎ edit…` and `Cancel`. `Name it` calls the same
  rename route, and the record then names the reader instead of the run. Deciding what a thing *is* is not
  something to guess at from a prompt, which is why this is a button and not a behaviour.

The rename refuses with `409 an agent is running in that worktree (<id>) — stop it first` while a run is
live in the tree, whichever half asks, and `409 <name> already exists` when the target directory is taken.
Nothing else about a tree is touched: the branch and the files are always the reader's.

`node tools/verify-named-tree.mjs` drives all of this end to end in a sandbox of its own — its own
`PANEL_CONFIG`, its own port, its own `$HERMES_HOME` and a stub gateway — with a throwaway repo: run one
names the tree, run two into the same tree leaves the name alone, a restarted panel with a *different*
title for that tree's run still cannot rename it (with a tree nobody has named yet renamed by the same
sweeper in the same window, so "untouched" cannot mean "the sweeper was asleep"), the 409 holds while an
agent is running in the tree, and `✦` suggests a name from three real commits, renames once when answered,
keeps the tag, and records the reader. It prints which parts are driven rather than inspected. Nothing
outside the sandbox is touched: the live panel on 7331 and the gateway on 8642 are never used, and no
branch of this repository is renamed.

#### What a worktree was started to do

The other half of a row's git story sits above MERGE STATE: a `DESCRIPTION` strip quoting the opening of the
**earliest** run's brief in that tree — what the branch was started to do, in the reader's own words, rather
than what the branch looks like now. Two sentences of it, verbatim, as a **bullet list — one bullet per
sentence** — plus a dim line naming the run it came from.

The text is extracted once and written down beside the job store (`logs/descriptions.json`, see
`lib/descriptions.js`), keyed on the six-hex tag a rename keeps, for the same reason the naming ledger is: the
job store keeps only the most recent ~80 runs, so a description computed at render time would empty itself the
moment a tree's earliest brief aged out. The first record for a tree also **wins** — a follow-up run into the
same tree ("land it and write the report") is not what the branch was for, so it cannot rewrite the goal. The
record carries the tree's full path and branch alongside the tag, so the file says which tree it describes.

The strip is the same kind of thing as the two under it: `ul.git-list`, one fact per `<li>`, with the head's
own line repeated as the first bullet and riding on the head line while folded. It starts **folded** — the
first bullet is what a reader wants without opening anything, and three one-line heads cost a row far less
height than a block of prose above the agents. Unlike the two strips under it, the rows a reader **unfolded**
are remembered per row in `localStorage` (`wm.openDescs`, an absent key meaning every row folded). That is a
new key rather than an inversion of the older `wm.closedDescs`: the old set was written by a build where every
strip started open, so it describes a layout the board no longer has. Nothing is invented: a brief with no
sentences is cut at a word boundary, the panel's own "Work in …" wrapper is stripped, and a tree the panel has
no run for renders **no strip at all**.

`node tools/verify-description.mjs` proves it in a sandbox of its own — a seeded job store (two runs in one
tree, one in a hand-cut tree with no tag, and a tree with no runs at all), a real `POST /api/agents` against a
stub gateway for the live half, another into an existing tree to show the goal is not rewritten, and headless
Chromium (Playwright) over the running panel for the bullets and their measured family, size, colour and column
against the merge state's own list, the fold on a fresh expand, the click that unfolds it, the reload that
keeps it open, the click that folds it again, a stale legacy key, and the absent strip. Point it at a Playwright
install with `PANEL_PLAYWRIGHT_ROOT`; without one it reports `BROWSER-HALF-NOT-RUN` and fails rather than
passing on a half that never ran.

#### What the merge state strip unfolds to

`MERGE STATE` is the strip between those two — the row's verdict and the git facts behind it, folded to one line
until it is opened. Unfolded, it reads top to bottom as three things, in the order a reader wants them:

- the merge facts, one per line: the verdict, `cherry +N/−M`, the branch's reflog count, whether the branch ever
  carried its own commits, the remote branch, the last commit. The head's own summary is the first bullet while
  the strip is open, and only the head line while it is folded.
- **every commit the tree carries off remote main**, under a heading naming the remote and the diffstat, one
  commit per line — short sha, then subject — at the **full width of the row** and never clipped. A tree with
  fifty commits makes a long list and the panel scrolls; nothing is hidden to keep the row short. These used to
  be one of three `<div class="col">` blocks in a flex row (`tr.detail .cols`, `min-width: 300px`), where a long
  commit list was squeezed into a ribbon beside the changed files.
- `MODIFIED (N)` and `UNTRACKED (N)`: one line each, carrying their count, with the file names folded away until
  the strip is opened. Each folds **on its own** — opening `MODIFIED` moves neither `MERGE STATE` nor `UNTRACKED`,
  and folding `MERGE STATE` does not forget which of the two was open (the open set is keyed per row and per kind,
  `state.gitSubOpen`). A clean tree, or one with nothing unmerged, renders no strip at all rather than an empty one.

### Agents

The **New agent** card starts one Hermes agent in its own worktree and streams the turn live. An agent
is a **run on the Hermes gateway's `api_server`**, not a spawned CLI:

    POST http://127.0.0.1:8642/v1/runs   {input, session_id, cwd, model?, max_turns?, run_budget?}
    GET  /v1/runs/<id>/events            SSE: tool.started / tool.completed / message.delta /
                                              approval.request / run.completed|failed|cancelled
    POST /v1/runs/<id>/steer             inject guidance into the live turn
    POST /v1/runs/<id>/stop              cooperative interrupt
    POST /v1/runs/<id>/approval          answer the flagged command a run is parked on

`Preview request` shows the exact body before anything is sent. The **model** field is a menu built
from the provider list Hermes itself fetched (`provider_models_cache.json`, refreshed by
`hermes model --refresh`), grouped by provider, with `(default: <the configured model>)` first — that
entry sends no `model` field at all, so the run uses the gateway's own model. The menu's tooltip says
how many models and how old the list is; a provider that was never picked falls back to the catalogue
that ships with Hermes.

The gateway has to be up and keyed:
`POST /api/agents` answers **503** with the gateway's own reason rather than creating a card that
never starts. The New-agent header says which it is — `api: up · steer` plus the gateway address, or
`api: down`.

Semantics, all verified against real runs:

- **Refused up front**: a repo with no commits (unborn HEAD) cannot host a worktree, because
  `git worktree add` needs a HEAD to branch from. The server refuses with that reason instead of
  letting a run start in a tree that cannot exist.
- **The worktree is the panel's.** A run carries a directory, not a `-w` flag, so the panel runs
  `git worktree add -b wtgui/<slug>-<tag> <repo>/.worktrees/<slug>-<tag>` and passes that path as the
  run's `cwd`. Nothing removes it afterwards — the branch and tree are yours to keep, review or
  reclaim.
- **`cwd` is set twice, and both matter.** The tools resolve a directory per *task*
  (`register_task_env_overrides`), while the system prompt and context-file discovery read the
  *session* cwd (`agent.runtime_cwd.set_session_cwd`). A gateway without the local patch
  (`docs/hermes-runs-api-knobs.diff`) ignores `cwd` entirely and runs every agent in its own
  directory — the header chip warns when that is the case.
- **Output** is the run's event stream: each tool call with its argument preview, the assistant's text
  as it arrives, approval requests, and a closing line with tokens and exit. Tool results are the
  gateway's redacted, 500-character preview (the full payload stays in the session transcript).
- **A file is drawn as a file, not as lines.** A unified diff in a tool's output becomes one framed
  window per `@@` hunk: the `diff --git` / `--- ` / `+++ ` headers and the hunk line ride as labels, and
  the body is two sides — the before lines on the left (yellow where a line was modified, red where it
  was purely removed) and the after lines on the right in green, with unchanged context dim across
  both. Any other file body (`read_file`, `write_file`, a shell `cat` / `head` / `sed -n`) folds into a
  code box whose header names the file and counts its lines, so a reader can see that a file was
  printed, and which one, without reading it. Both wrap, so a 300-character line never forces the
  console sideways. The classification is made at render time from a line's own text and only ever
  looks at a tool's own output: a call line, the agent's sentences, a shell transcript, an `ls` listing
  and the gateway's own notes stay plain lines, in the colours they always had.
- **Cancel** posts `/v1/runs/<id>/stop`; stopping is cooperative, so the card settles as `cancelled`
  when the turn actually ends.
- **A run can outlive the panel.** Restarting the panel marks in-flight cards `interrupted` and keeps
  their run id — the run itself keeps going inside the gateway.
- **Hard cap**: anything still running after `jobMaxRuntimeSeconds` is stopped and marked failed.
- **Minimize**: click a card header to fold it, or use `Minimize all` / `Expand all`. Folding is
  remembered in `localStorage`, so a reload does not spring everything back open.

#### Starting an agent in an existing worktree

Every worktree row carries a small green **▶**. It aims the spawn card at that worktree and ticks
*run in that folder as-is*, so the agent works **there**: no new worktree, no new branch — which is
what you want when a worktree already exists and you just need a session inside it. The card says so
("runs IN … (no new worktree)"), the agent card is tagged `in existing worktree`, and replies keep
going to that same directory. Unticked (or started from the green **+** by a project name), the
behaviour is unchanged: a fresh worktree under `.worktrees/`.

#### Which agent is working in which worktree

A row whose worktree has an agent you started from this panel shows a green `⧉ panel` chip — click
it to jump straight to that conversation in the Agents section (it expands first if you minimized
it). While the agent runs, the row counts as live and is polled at the active cadence.

This mapping is the panel's own: each job records the worktree it was created for (`ownerPath`) and the
project it came from (`projectPath`), so a card is filed under its row the moment it exists instead of
waiting for a scan. The `⧉ hermes` signal (which matches on a session's recorded cwd) still cannot
place a panel-started agent on its own, because those sessions record no usable cwd. `⧉ panel (done)`
means the agent that ran there has finished but is still in the panel's list.

#### Reviving a session the board lost

A conversation outlives the panel's job store. The run lives in the gateway, so clearing a card, a
fresh clone or a reset `logs/jobs.json` leaves the row still saying *Hermes session open here but
idle (1)* with nothing to click — the count came from the session store, the card came from the
panel. The row detail now lists those sessions by name under **Sessions N here, no card on the
board**, each with a `revive` button.

Reviving writes one job record whose `thread` is the session id, so nothing is copied: the
conversation is already in the gateway, the card shows the last exchange so you recognise it, and the
reply box runs another turn on the same session — as if the card had never gone. It is deliberately
not automatic: a worktree collects every session ever run in it, so auto-attaching would refill the
board with months of finished conversations. One click, one session.

The list uses the same attribution as the row's own liveness claim, so a session appears only under
the row it is already being credited to (a `wtgui-*` session records no usable `cwd` and is placed by
its newest tool calls). `GET /api/sessions?path=` answers the same question for a script, and a
revive is refused (409) when that session already has a card.

#### How many sessions the CLI lists

`hermes`'s in-chat `/sessions` and `/resume` browser listed **ten**, whatever the store held — a
literal `10` at every call site, not a retention limit. Nothing is deleted at ten: the store on this
box holds 160 sessions, and nothing prunes them (`sessions.auto_prune` is off by default). Settings →
**CLI session list** sets `sessions.list_limit` (1–500), writes that line into `config.yaml`, and shows
what the store actually holds so the question answers itself.

Hermes has no such key upstream, so reading it is a local patch
(`docs/hermes-cli-session-limit.diff`; re-apply after `hermes update`). The row notices a missing patch
and says the number is being ignored instead of pretending it took effect.

#### Files an agent produced

An agent that writes something a person will *open* — a markdown doc, a SQL script, a key — gets a
`📄 N` button in its card head, right after the worktree name. The same list carries URLs the agent
hands over (a dev server it started, a page it built), in the order they were delivered, so a test
instance and the document explaining it sit together.

Each row is the name (or the URL) and three actions: click it to open (a file in an editor, a URL in
your browser), `copy` for the full path/URL, `✕` to delete — which asks first, and removes the file
from disk as well as from the list. The exact path is on hover rather than in a column, because the
name and the two buttons are what you actually use. Drag the corner of the popup to make it bigger;
it stays open while the card repaints under it.

Only deliverable extensions count (`.md .txt .sql .csv .json .yaml .key .pem .sh .ps1 …`) for files,
from two sources: every `write_file` result, and — once a turn ends — the untracked files git reports
in the run's directory, which catches `cat > x.sql` and `sqlplus @script`. URLs come from what the
agent says in its own words (tool output is full of links that are not deliverables), capped at 12.
Edits to existing tracked files are not artifacts. The list is persisted with the job, so it survives
a panel restart.

#### Replying to an agent, and steering it

Each card is a conversation. Every agent runs on a named thread (`wtgui-<words>-<id>`) which is the
run's `session_id`, so a reply continues the same Hermes session:

    run 1   POST /v1/runs {input: <prompt>, session_id: wtgui-...-abc123, cwd: <worktree>}
    run 2+  POST /v1/runs {input: <reply>,  session_id: wtgui-...-abc123, cwd: <same tree>}

While a turn is **still running** the reply box's primary button is **Steer turn** — `Ctrl+Enter`
(`⌘+Enter` on a Mac) does the same. The text goes into the LIVE run and is read at the agent's next tool
boundary, so the turn changes course instead of queueing behind it. **Queue reply** is the explicit "send
this when the current turn finishes" path — and `Enter` is that same press from the box, so a reply can be
held for the next turn without leaving the keyboard. Where there is nothing to wait for (no turn running,
no subagent out) `Enter` and `Ctrl+Enter` both send. A steer that arrives after the last tool boundary comes back as
`pending_steer`, and the panel replays it as the next turn rather than dropping it.

When nothing is running the button is **Send reply**: it starts the next turn on the same session, in
the same directory. Replies inherit the first turn's model; threads are real Hermes sessions, so they
appear in `hermes sessions list` like any other.

#### The turn's usage

Above the reply box, a turn shows the same readout the CLI prints above its prompt:

    ~357K/1M │ [████░░░░░░] ~36% │ ◎ 99.0% │ ◷ 4.2s │ ↑ 231 t/s │ compressed ×1

Context occupancy with a 10-cell bar, prompt-cache hit rate, mean model latency and throughput. It
arrives as `run.usage` after each `tool.completed` — so it follows a turn while it is still running —
and again inside the terminal event's `usage`. Every segment is optional and omitted when the gateway
has no figure behind it (`~` marks an estimated context, never a fabricated `0%`), and a card from a
gateway without the local patch shows no row at all instead of zeros. `compressed ×N` appears only
after a context compression.

These are projections of the gateway's agent object, not fields the run stream carries: the gateway
half is in `docs/hermes-runs-api-knobs.diff`, which has to be re-applied after `hermes update`
replaces `gateway/platforms/*.py`.

#### Approvals

A run that hits a flagged command parks at `waiting_for_approval` and emits `approval.request` with
the redacted command and the choices the host allows. The question appears **under that turn's console
output** as a raised box with those exact choices; answer it and the box collapses to one line
(`✓ approved once: <command>`, red `✕` for a denial). The panel never widens the choice list.

Two gateway settings decide whether anything asks at all:

- `security.approval.transport: builtin` — a selected plugin transport (e.g. `worktree-panel`) sends
  the question to the panel's legacy `/api/approvals` page instead of the run's stream.
- `approvals.mode: manual` — `smart` judges many flagged commands safe and waves them through.
- `approvals.timeout` — how long the ask waits for you before it fails closed (silence means the
  command does not run). That is the **gateway's** clock, not the panel's: the panel only ever sees
  the ask appear and expire. Settings shows it and writes it, and the write is the one line under
  `approvals:` in `<HERMES_HOME>/config.yaml` — the gateway re-reads that file, so the next prompt
  uses the new window with no restart. A gateway on another machine keeps its own file, so the
  control is refused there instead of editing the wrong one.

#### The agent's own questions

An agent that stops to ask something ("which of these three summaries do you want?") uses Hermes'
`clarify` tool, and that is a **control on the run** exactly like an approval: the gateway parks the
turn and emits `clarify.request` carrying `prompt_id`, the question, the choices and `multi_select`.
The card renders it under the parked turn's console as a **light-purple box** — the approval's
placement, a different colour, and room for sentence-long answers: every choice is a full-width row
that wraps, the first one carries the tool's `recommended` mark, multi-select choices are ticked and
sent together, and the box under them takes a typed answer of your own (`Enter` sends). Answered, it
collapses to `✓ answered: <what you said>`; a question that was answered elsewhere, withdrawn with the
turn or timed out leaves `· question closed without an answer here`.

Four pieces have to line up, and each one alone is a silent no-op:

- `platform_toolsets.api_server` must include `clarify` in `<HERMES_HOME>/config.yaml`. The stock
  `hermes-api-server` toolset deliberately drops interactive UI tools, so without this line a
  panel-spawned agent does not have `clarify` at all and its questions stay prose in the console:

  ```bash
  hermes config set platform_toolsets.api_server '["hermes-api-server","clarify"]'
  ```

  The gateway re-reads that file per run, so the next spawn has the tool; a running turn does not.
- **The gateway build must carry the Runs API half of the contract** — a clarify callback on an API
  run's agent and `POST /v1/runs/{run_id}/clarify` to answer the prompt. That is code, not
  configuration, and the line above cannot supply it. A build with the toolset line and without the
  route hands the model the tool and then refuses every call with the tool's own
  `Clarify tool is not available in this execution context.`, which reads like a permission problem
  and is a missing feature. Check the gateway you are pointed at:

  ```bash
  node tools/check-gateway-clarify.mjs --probe   # 0 = the route is there, 1 = it is not
  ```

  Until it is there the panel does not pretend: it records the refusal from the run's own stream,
  says so once on the card, and tells the agent to ask in prose at the end of its turn — which the
  `question` rule still escalates to you. See `docs/clarify-over-the-runs-api.md` for the code that
  decides it in each build.
- The panel answers through `POST /v1/runs/{run_id}/clarify` with the same fence as an approval —
  `{request_id, execution_generation, answer}` where `answer` is a string (a multi-select answer is a
  JSON array string, which the tool decodes). Both ids come from the run's `pending_controls[]`, not
  from the event; the panel re-reads and retries once on `invalid_params` / `stale_generation`.
- `POST /api/jobs/answer` on this panel is the one route the card posts to, so the gateway body is built
  and validated in one place.

The gateway also appends a messaging-only `Reply "skip" to skip this question.` line to the question;
the panel strips it, because a card has its own controls.

How the box looks is a browser preference, in Settings > Display: **Question tint** (five signal colours,
light purple by default — none of them the approval's amber, so the two parked states stay distinct;
`--q-*` variables on `:root`, one class per tint), **Question width** (0 = the console's own box, or a
pixel number that centres it under the console), **Question size** (11–18 px, clamped on entry),
**Compact answers** (tighter row padding and gaps) and **Typed answer box** (off hides the free-text row
for questions that have choices; an open-ended question always keeps it, and a multi-select question
keeps its Send button). The rows sit under a live sample — the real markup with the real classes, so the
preview is the setting.

By default the box is the console's box: the same 18 px inset the console wrapper carries (the `out-tab`
offset inside the turn's rail) and the same right edge, so it lines up with the output it follows. The
tool's `(Recommended)` suffix is drawn as a leading chip so it never floats away from the text.

A parked question also carries a purple countdown bar with a `~57m left` label. The gateway's
`clarify.request` names a timeout only for a local-viewer turn, so for an API run the panel measures the
window the gateway is configured with — `clarify.timeout`, else `agent.clarify_timeout`, else one hour,
and `0` means it waits indefinitely (then there is no bar). The deadline is counted from when the
question reached the panel, which is why the label says `~`; the bar brightens in its last eighth and
goes red reading `time is up` at zero. One page-wide 1 s ticker paints every countdown, so a repaint or a
board poll never drives it.

#### Credentials

A run executes inside the gateway process, so the provider key is whatever that gateway is configured
with; this panel never touches it. What the panel needs is the api_server bearer token, read from
`API_SERVER_KEY` in `$HERMES_HOME/.env` (or `apiServer.key` in `config.json`) and sent as
`Authorization: Bearer …`. It is never logged and never returned by any endpoint.

`HERMES_HOME` is only used to find the gateway's own files — `.env` for that token, and `config.yaml`
for the approval window — agent processes are not spawned from here any more.

### The assistant

**✧ Assistant** in the header opens a floating panel that can be dragged, resized and closed (position and
size are remembered; `Ctrl+Shift+A` toggles it, `Esc` closes it when the caret is in it). It is a window, not a
strip of content: `⤢` in its header maximizes it to the whole window, `⤡` puts the float back, double-clicking the
header toggles the two and `Esc` restores the float from fullscreen. Both shapes lay out the same way — header, tabs
and the card's own head are fixed rows, the transcript is the only scroller, and the composer is pinned at the foot,
so the box you type in is on screen at any panel height with the last message directly above it. A conversation
shorter than the panel starts at its foot instead of leaving empty panel under its last turn. It is two things:

- **A sentry** that runs in the panel's own process, on `settings.seconds` (default 5 s), over the same job
  summaries the cards are drawn from. It costs no tokens and it is always awake. Thirteen rules:
  `loop` (the same tool with the same input N times, read-only helpers held to a higher bar), `errorloop`
  (identical failing output), `quiet` (a running turn with no new output — a long build looks exactly like
  this, so it only journals by default), `approval` (parked longer than the threshold), `question` (a turn
  parked on the `clarify` tool, or ended on a question in prose), `noevidence` (an implementation-sounding
  turn that touched no file and left no deliverable), `collision` (two live turns in one tree), `context`
  (near the context ceiling), `watch`
  (a watch finished or missed its deadline), `repeat` (the same failure in consecutive turns of one thread — the
  failure is the call that produced it plus the failing line with its numbers masked, so "npm test, 3 failures" in
  three replies is one alert and a clean turn breaks the streak; a tool the gateway marks only in its result header
  — `↳ terminal · error` — counts too), `leftover` (a worker ended and its tree still holds modified or
  untracked files, and no live run holds that tree any more — read from the scanner's own row, never a second git
  pass; a tree a live run's cwd holds is that run's worktree, so a SPAWN IN into a just-finished tree edits files
  that are work in progress and raises nothing, which is the check standing rule 16 asks a reader to make by hand;
  commits that are not on main are the normal state of an agent's branch until you merge them, so they are named
  on the alert as context rather than being a trigger)
  and `child` (a delegated subagent that has written nothing for `childQuietSeconds` — the wording is "no
  activity for 6m", never "hung": a long tool call looks the same; read from the gateway's session store, and
  only for threads this board is showing), plus `interrupted` (a thread whose latest turn ended `interrupted` —
  a turn stopped without finishing, usually a panel restart; an interrupted turn a later turn has taken over is
  history and does not fire. It alerts rather than wakes by default, because one restart rewrites every running
  turn as interrupted at once and would spend the whole hourly wake budget in a single pass; raise it per rule
  under **Settings → Per-rule escalation** when a cut-off turn is worth the assistant's opinion). Every alert
  carries the evidence it was built from — counts,
  the repeated call, the failing line, the command being waited on — because "it looks stuck" is not
  actionable.
- **A real agent thread** (`panel-assistant`) rendered inside the panel by the panel's own card renderer:
  console, reply box, steering, usage, turns. It is not a second kind of chat. Its `input` carries a
  preamble the card does not show: its standing rules, its scratchpad notes, the watches and a digest of
  the board. It runs on the gateway default until you pick a smaller model under **Settings → model**.

Its turns run in a directory of its own (`assistant.cwd`, default `assistant-cwd` beside the job store,
created on demand), not in a project checkout: the gateway refuses a run without an existing cwd, and a panel
whose `defaultCwd` pointed at a deleted checkout refused every turn with `cwd is not an existing directory`.
Set it under **Settings → working dir**; an unusable path is kept as written, logged, and the turn falls back
to a directory that exists rather than failing. That directory is what the panel ASKS for: a stock gateway
ignores the `cwd` a run body carries (no `cwd` handling in `gateway/platforms/api_server*.py`, and
`GET /v1/capabilities` does not advertise `run_cwd`), so the run's working directory is the gateway's own
until the per-run-knobs patch in `docs/hermes-runs-api-knobs.diff` is applied and the gateway restarted.
Nothing the assistant does depends on it — it reads the board and starts workers, and a worker's own tree
comes from the `cd` line the spawn wrapper carries.

**The charter.** The rules and the scratchpad are short and clipped (each rule to 200 characters, and only
the last twelve ride along); the Hermes memory file has a character budget of its own. What neither holds is
the *reasoning* — why a convention exists, what was learned the hard way, what is still unanswered — so that
is what a compaction takes first. The **Charter** tab beside Scratchpad is that long tier: one markdown file,
`assistant-charter.md` beside `assistant.json` (override with `assistant.charterFile`), shown with its path,
its last-modified time and its size against the cap, in a box the reader can edit and save.

The panel injects the whole file into the assistant's input on every turn, exactly the way the standing rules
and the scratchpad are injected — and that is not a fallback, it is the mechanism. Hermes does have a native
project-context mechanism (an `AGENTS.md` chain from the git root down to a run's working directory, injected
into the system prompt), but it resolves that from the run's CONTEXT cwd, and the stock gateway does not take
a run body's `cwd` (above), so a file dropped in `assistant-cwd` is never read. The charter says so in its own
words, and the tab works either way.

A fresh panel seeds the file from what it already has: the standing rules in full (the tail of a long rule
exists nowhere else) and the scratchpad notes, under headings for the role, the hard guardrails, this repo's
git facts, the ownership splits, where things live, the open design questions and how to update the file. The
cap is **20,000 characters** and it is enforced rather than advisory: a save over it is refused with `413`
and the numbers in the message, and an appended entry prunes the OLDEST changelog entries first. The seed
leaves the last 1,200 characters free for that changelog — a seed filled to the cap would be a file nothing
could be added to, which is exactly what the live store produced before this was measured. There are two
writers — the reader's box (a `PUT /api/assistant/charter`, which carries the mtime it read so a save that
would silently overwrite a newer version is a `409` instead) and the assistant itself, which appends a dated
entry by ending a reply with a `CHARTER:` line. A standing rule being added or refined appends one
automatically, because a changed standing answer is exactly what the long tier is for.

**Answers are drafts.** A question alert that a standing rule covers arrives with the rule's answer
prefilled; one with no rule says so and leaves it to you. Nothing is posted into a worker's thread until you
press **Send reply**. The autonomy ladder (per panel, in the assistant's Settings tab):

| Autonomy | What it may send |
| --- | --- |
| `draft` (default) | nothing — every reply waits for a click |
| `auto-safe` | a reply the assistant itself wrote (a `TO` line); rule-derived drafts still wait |
| `auto` | any draft it has text for |

Per-rule escalation decides what happens when a rule fires: `log` (journal only) · `alert` (badge + list) ·
`wake` (also hands the assistant a digest; rate limited to `maxWakesPerHour`, coalesced while a turn runs) ·
`act` (wake, and let it send when autonomy allows). An approval is never answerable from the panel at any
setting — that boundary belongs to the gateway and the agent's own card.

A question a run is parked on is **not a reply**: the gateway is holding the turn open, so answering it is
a control call, not another message queued behind it. The alert carries the choices as buttons (ticks when
the tool takes several, because one click must not answer with only the first label), and **Send answer**
settles the prompt through the same endpoint the card's box uses. A standing rule that names exactly one
of the offered choices *is* the answer (`rule+choice`); a rule that names two is ambiguous and stays a
draft; at `auto` the assistant answers only the former, once per question. Answered on the card, withdrawn
with the turn or timed out, the alert closes itself. The same `question` rule still catches a turn that
merely *ended* on a question in prose, where a reply is the right shape.

`watch` ships at **wake**: a watch is the reader explicitly asking to be told, and an alert on its own is a notice
nobody reads. When a watch expires or its thread finishes, the assistant is woken with the watch, the deadline and
**the completion payload** — what the run actually produced, not just that it stopped: its own last words (or the
last forty lines of the transcript when it published none), its exit status in three words (`normal`, `failed`, or
`interrupted` when the panel's cap, a stop from the card or the gateway ended it — a killed run never reads `done`),
how long it ran, the branch and worktree it worked in, whether that tree holds commits over the commit the turn
started from, and the report a worker filed under `<repo>/.agentboard/settlers-reports/<thread>.md`. Rendered whole,
that is what a wake looks like:

    completion — wtgui-in-your-working-directory-ru-682d81 […], turn 1 ended normal
      exit: 0 (from the run's completed result)
      duration: 35s
      branch: wtgui/in-your-working-director-cdc050 · worktree: …/.worktrees/in-your-working-director-cdc050 ·
              left 1 commit not on 44a6a57c: 43bab99 feat: the payload worker's commit
      the worker's final message:
        PAYLOAD-SHOWCASE-OK
      report …/.agentboard/settlers-reports/wtgui-in-your-working-directory-ru-682d81.md:
        # Showcase report …

A tree that could not be read says so ("commits not measured") rather than reporting zero, and its notice is held
back one sentry pass until the measurement lands, so a reader never has to reopen the card to find out whether
there was anything to merge. Wakes fired by one sentry pass are collected for 150 ms and sent as one turn, so two
watches on the same worker are one answer, not two — and one finish is one wake however many rules notice it (a
watch closing and a turn cut off mid-flight are the same terminal result; the second alert is filed, journaled as
`wake-once`, not sent). A scratchpad written before this default changed is migrated once (file `version: 2`).

**Something supervises the supervisor.** The sentry cannot report its own clock stopping, so the server runs a
small watchdog outside it (every 10 s): a cleared timer is restarted, and a pass is run if the last one is older
than three intervals. The same call handles the assistant's own turn, which the sentry deliberately never looks at
— if it has produced no output for four quiet-windows (5 min minimum) it is stopped and the assistant is woken with
that fact, because `assistantLive()` would otherwise hold every future wake behind a hung turn. On boot the panel
also checks its own last turn: if the restart cut one in half (`jobs.load()` marks it `interrupted`), it is woken
once to say where it got to; a clean restart costs nothing. **Settings → How it behaves** shows the clock, the last
pass and whether that boot resumed anything.

**It can create worktrees.** `assistant.spawn` (also in its Settings tab) has its own ladder, because cutting a
tree is a bigger act than writing a reply: `ask` (default) turns a SPAWN line into a card showing the project,
where the tree goes, the exact prompt and the model — nothing runs until you press **Create worktree & start**;
`auto` starts it at once; `off` means it may not propose one and is told to say so. A confirmed spawn goes through
the same gate as the New-agent card: the gateway probe, the unborn-HEAD refusal, `git worktree add -b wtgui/…`,
then the run. The worker gets the gateway default model (the assistant's small model is for triage, not for the
work), the card is tagged `↳ started by the assistant`, and the new thread is put on the watchlist automatically
so "spawned" later reads as "and here is how it ended".

**A spawn card nobody starts is the panel's own silence, so the panel checks it.** An `ask` card changes nothing:
no job, no thread, no row — and until now nothing looked at it again, so one could sit open for hours and the
assistant only found out when it was asked. Every card now carries a deadline (`SPAWN_WATCH_MS`, two minutes) and
one timer; when it passes, the panel looks in the job store for a run that belongs to that card — the run recorded
on it, the thread it names, or a worker standing in its tree (a card that would cut a tree is matched on the same
ask under that project's `.worktrees/`, never on a job in the project's own checkout) — and there are two answers:

- **a run exists** — the card is closed against it silently. A worker that exists is not news, and a warning about
  one that was never missing teaches the reader to ignore the badge;
- **none exists** — the card goes red in place (`NEVER STARTED`, its age, and the worktree path), the count lands
  on its **own** header badge (`⧗ N`, beside the alert badge and not inside the alert count: a card is the reader's
  pending act, not a notice), the Alerts pane puts it above everything with a banner, and `spawn-unstarted` is
  written to the journal — `digest()` carries it into the assistant's preamble the way `spawn-failed` already is,
  because a model reading an empty board otherwise says the work is queued.

The deadline lives on the card as well as in the timer, so a panel restart re-arms it instead of losing a card that
was seconds from being reported, and the sentry asks the same question on every pass — including with the sentry
switched off, because a card on the board is a promise the panel made. `spawnAutoStart` (off by default, in the
assistant's Settings tab) is the other half: with it on, the deadline starts the pending card through the same
`startSpawn` the button uses — **one** attempt, recorded before it is made, so a refusal (gateway down, unborn
HEAD) goes back to the reader as a red card rather than a second try. A card the reader discarded is never started
by either path.

The assistant acts by writing plain lines in a reply, and every such line in it is read — wherever it sits among the paragraphs, not only the one the reply ends on:

    TO <thread>: the reply to that worker
    WATCH <thread>: what to watch for | 30        (minutes, optional)
    NOTE: something to remember
    CHARTER: a dated entry for the continuity file (one per changed standing answer or closed long task)
    RULE: a standing answer you are sure of
    SPAWN <project> | what the new worker should do
    SPAWN IN <directory, worktree directory name, or branch> | what the worker should do in that tree  (no new worktree)

**Every command line is reconciled against what the panel actually did with it.** Each kind already journals its own
refusals — a busy thread, a TODO id that does not exist, a WATCH with no such thread, a RESTART with no key — so the
audit is not a second vocabulary: it counts. Every turn of the assistant's own gets one ledger
(`lib/assistant/audit.js`, persisted in `assistant.json`): the lines `parseActions` read per kind, the outcome each
one got as it was carried out (applied, or refused — with the journal line that says why), and a third count for lines
that begin with a known prefix and miss its grammar, which used to be dropped with no journal line at all
(`TO wtgui-x without a colon` is recorded as unparsed instead of vanishing). When parsed exceeds applied plus refused,
the sentry raises a red card naming the turn, the kind and the missing count, and writes `command-unactioned` to the
journal, which `digest()` carries beside `spawn-unstarted` — the board cannot show a line that did nothing, and a
model re-reading its own prose otherwise believes it acted. The parsed side comes from the turn's own lines, which
outlive the process in the job store, so a turn a restart cut in half is reconciled by the **next** pass instead of
being carried out by nobody. **Settings → command audit** is `off` (the default: nothing is read), `report` (the red
card and the journal line), or `enforce` (the same, and the lines nothing accounted for are carried out once on the
following pass — a line that already ran is never replayed).

**A SPAWN IN name that is out of date is resolved, not refused.** The panel renames a run's worktree
directory and its branch after the session title once, on the run that got the tree first (`renameWorktree` — the
slug is rebuilt from the title, the six-hex tag kept; every later run in that tree leaves the name alone, see
*What a worktree is called*), so a path the assistant wrote down when that worker finished, or one typed from an older
report, stops existing while the tree is standing one directory over. So an existing-tree spawn no longer
requires the path to BE a directory before it looks further (`lib/spawn-target.js`, used by both
`/api/assistant/spawn` and the New-agent card): the path as written first — absolute, or relative to the panel,
the project's own checkout and that project's `.worktrees/` — then `git worktree list --porcelain` for the
project, matched on the worktree directory name, the branch, the tag a rename keeps, or the slug cut from the
same prompt. A branch may be named in place of a path (`SPAWN IN wtgui/fix-the-thing-1a2b3c`), and a thread's
slug counts as the same signal when a caller knows the thread. Exactly one match is used — and the card says
which and why (`resolved to …` on the assistant's card, a `SPAWN IN … → … (matched …)` line on the run's own
card, and the same in the origin chip's tooltip) — several is a refusal that names every candidate, and none
keeps the refusal the panel always gave, word for word: `<path> does not exist or is not a directory`. A match
that is not a directory when it is read back refuses too: this resolves a name, it never "starts anyway", and the
409 guards that keep the panel's index honest (`already being read`, `already merging this worktree`, `already
has commits`, `already exists`) are untouched by it.

    RESTART gateway        (restart the Hermes gateway — queued until this turn has ended)
    RESTART panel          (restart this panel — queued until this turn has ended)
`RULE:` lets the assistant maintain its own standing answers while it watches — the case that prompted it was
"an interrupted agent gets exactly one continue". Such a rule is part of the normal rules list from then on, so
it can answer a question (or, at `auto`, pick a choice) on the strength of it; the Scratchpad marks it
**assistant**, and it is deletable there. A near-identical restatement refines the assistant's own earlier rule
instead of adding a second; the reader's rules are never merged or edited by it.

**It can restart the thing that runs it.** `RESTART gateway` and `RESTART panel` map to `POST /api/restart`
and neither runs inside the turn that wrote it: that turn *is* a run inside the gateway, so the request is
queued and the action starts only once the assistant's thread has no turn running — a synchronous restart
would kill the very answer that asked for it. Nothing is stopped before the provider key is verified in
`$HERMES_HOME/.env`: a gateway that comes up without one binds its port, answers `/health`, and then dies on
every run with `No LLM provider configured`. A refusal is journaled, not thrown at the model. Everything the
restart will interrupt is given ONE terminal status first — `interrupted`, with the restart recorded as what
ended it — so no card is left with neither a done nor an interrupted verdict. Once the new process answers it
is proved with **one real turn through the gateway, never with its port**, and only then is the assistant woken
once with the completion payload of everything the restart interrupted.

A panel restart hands the port over: the outgoing process writes what was running into `restart.json` beside
the job store, spawns a detached helper (`lib/panel-restart.cjs`) that waits for the old pid to exit and only
then starts `server.js` (and writes `logs/server.pid`), and exits through the same path a signal uses. The
replacement reads that record, proves the gateway and fires the single wake. The SAME wake covers a restart the
panel did *not* ask for: if runs stop reporting while the panel is still up — the gateway was replaced and no
longer knows their run ids — each lost run is marked interrupted once and the assistant is told once, with the
same payload each time. A gateway restart is invisible from the outside (its port answers either way), which is
why the sweep asks the runs themselves and why the proof is a real turn.
Each finished turn is harvested exactly once (keyed by turn id, persisted): a turn's title landing or a panel
restart re-emits the same job, and re-reading its lines would otherwise start a second worker.

**Every action in that turn stands on its own.** The lines are read from the WHOLE reply (`turnProse`), because
the run stream opens a text line per paragraph: reading only the last one carried out whatever the turn ended on
and dropped everything above it with no job, no alert and no journal line (live, 2026-10-24: a SPAWN and a TO
vanished for hours while the NOTE under them applied). Each line is then carried out inside its own try — a
rejected promise and a synchronous throw are both caught — and a line that could not be carried out is journaled
with the line and the reason (`spawn-failed`, `send-failed`, `watch-failed`, `rule-failed`, `note-failed`,
`draft-skipped`, `watch-skipped`, `spawn-skipped`, `rule-skipped`). One failure never stops the others, and
`observe` never throws into the job store, so the panel keeps seeing the jobs that follow.

**The scratchpad** is one JSON file beside the job store (`assistantFile`, default
`logs/assistant.json`): `settings`, `notes` (freeform, read every turn), `rules` (standing answers),
`watches`, persisted `alerts` (so a restart does not shout twice) and a capped `journal`. It is written
through a temp file + rename, and a second panel instance with its own `jobsFile` keeps its own.
The panel's **Scratchpad** tab edits the notes and rules; **Watches** adds and removes watches; **Alerts**
dismisses one, hands it to the assistant, or opens the agent. A watch with a deadline carries a live countdown
(`29:48 left`, repainted once a second in place rather than by re-rendering the pane) and a bar that empties as the
deadline approaches — the last fifth turns amber, then red, and past zero it reads `overdue` in the same place.
Watches without a deadline, and finished ones, say so instead.

## Config (`config.json`)

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | 7331 | HTTP port |
| `scanRoots` | `["C:/ProjectDevelopment"]` | directories scanned for git repos; every repo found becomes a monitored project |
| `host` | `127.0.0.1` | bind address. Loopback keeps the board to this machine. `0.0.0.0` makes it reachable from the LAN or a tailnet — set `PANEL_TOKEN` in the same breath, because this panel spawns processes and can write files |
| `PANEL_TOKEN` | *(unset)* | **an environment variable, not a config key.** The shared secret for writes from **other** machines; loopback is never challenged, so a local browser needs nothing. With it missing (or empty) every off-machine write is refused — the door closes, it does not open. With one, a remote browser authenticates once by opening `http://<host>:7331/?token=…` (the client remembers it and sends `x-panel-token` from then on). Reads — `/api/state`, `/api/stream`, the static files — stay open to anyone who can reach the port, so keep it on a LAN or a tailnet and never a public network |
| `token` | — | *ignored.* A leftover `token` key in `config.json` is logged and then disregarded: that file is tracked by git, so a secret in it would be a secret in the repository. Use `PANEL_TOKEN` |
| `defaultCwd` | most recently active project | fallback target for a spawned agent when no project is chosen |
| `hermesBin` | auto | explicit path to the hermes executable; used by the `hermes worktree` audits behind `/api/cleanup` (agent runs do not spawn it) |
| `apiServer` | `{"url":"http://127.0.0.1:8642"}` | `url` of the gateway's api_server, and optionally `key` (else `API_SERVER_KEY` from `$HERMES_HOME/.env`) |
| `jobMaxRuntimeSeconds` | 3600 | hard cap on a spawned job |
| `assistantFile` | `logs/assistant.json` | the assistant's scratchpad: settings, notes, standing rules, watches, alerts and journal |
| `assistant` | `{}` | starting knobs for the assistant: `enabled`, `autonomy` (`draft`/`auto-safe`/`auto`), `spawn` (`off`/`ask`/`auto`), `spawnAutoStart` (boolean, default off — start a spawn card once when its two-minute check finds no run), `model`, `cwd` (its own working directory — created if missing; default `assistant-cwd` beside the job store), `seconds`, `repeatLimit`, `quietSeconds`, `approvalSeconds`, `contextPercent`, `maxWakesPerHour`, `rearmSeconds`, `rules:{id: log\|alert\|wake\|act}`. The panel writes changes back to `assistantFile`, so this is the first-run default |
| `liveSeconds` | 5 | how often liveness evidence is re-read for every row (no git) |
| `worktreeSeconds` / `dormantSeconds` | 5 / 30 | active-row / dormant-row git scan cadence |
| `slowSeconds` | 60 | project meta, discovery, and expensive per-row fields |
| `fetchSeconds` | 600 | how often remotes are fetched |
| `refreshSeconds` | 30 | client resync interval |
| `liveMinutes` | 5 | how recent activity counts as live |
| `hideOlderThanDays` | 7 | how old a worktree's **last activity** has to be before its chart stops drawing it. Activity, never the age of the directory: the newest of its last commit, its last edited file, the last moment the panel saw it alive and any event received about its agents — so a tree cut months ago that somebody is working in today stays. Nothing is lost: the arrow at the bottom of that project's chart (visible while the pointer is over it) shows every tree again, and each `older hidden` chip says how many are held back. `0` shows everything. Written back by `POST /api/settings/age` (Settings → **Hide stale worktrees**) |
| `threads` | 4 (capped) | scan worker threads |
| `discovery.worktreeSource` | `git` | `git` probes each repo (6-7 calls, ~0.8s, the default) or `hermes` runs `hermes worktree list --json` (5.5-7.2s per repo, measured on Windows). `hermes` additionally reports per-tree `locked`/`missing` and a per-branch keep/reap verdict; it is opt-in because discovery sweeps every repo on `slowSeconds`. Either way `/api/cleanup?project=NAME` gives the full audit for one repo on demand |
| `remoteBranchPolicy` | `local-only` | whether a branch may exist on a **remote** at all. `local-only` (the default): every tree the panel cuts stays on this box — the pre-push hook it installs refuses a `git push` out of one and asks you through the permission box instead (Allow once / this session / Always allow / Deny), and the panel's own merge flow asks before it starts. `allow`: remote writes go through without asking (this is what **Always allow** in the box writes, so the box and the setting are one fact). `deny`: refused outright, and the box is not even offered. Written back by `POST /api/settings/remote-branches` (Settings → **Branches on the remote**), so it survives a restart | 
| `remoteWriteSeconds` | 300 | how long a parked remote-write question waits before it is denied — the box's countdown and the guard's own poll window |
| `pushGuardFile` | `logs/push-guard.json` | the panel's record of which worktrees carry the pre-push guard and when it went in (git holds the hooks path itself) |
| `cloneOwner` | `JLRoper` | GitHub owner used by `/api/clone` (and the folder **+** box) when the typed name has no `owner/` prefix |
| `projects[]` | — | `name`, `path`, `remote`, `mainBranch` (the branch and PR links are not configured here: they come from the project's host record — `docs/hosts.md`) |

## Endpoints

| Method | Route | Notes |
| --- | --- | --- |
| GET | `/api/health`, `/api/config`, `/api/stats` | settings / scheduler / pool |
| GET | `/api/state` | full snapshot (projects, worktrees, jobs, spawn info) |
| GET | `/api/cleanup?project=NAME[&fresh=1]` | on-demand `hermes worktree list --json` audit for one repo: trees, external trees (`locked`/`missing`), per-branch keep/reap verdict + reason. ~6s, cached 10 min |
| GET/POST | `/api/hosts` · `/api/hosts/propose` · `/api/hosts/mapping` | where a project's branches and PRs live. GET: the merged mapping (`hosts` records, the file pair, warnings, and each project's `view`). POST `propose` `{project}`: read that project's own remote and return the mapping it implies — writes nothing. POST `mapping` `{project, host, coordinates}`: write ONE project into `logs/hosts.json`, leaving every other record alone. Tokens, precedence and the landing doctrine: `docs/hosts.md` |
| GET/POST | `/api/approvals`, `/api/approvals/answer`, `/api/approvals/<id>` | human side of the Hermes approval-transport contract: list pending requests, answer one (`{id, choice}` within the request's `allowed_choices`), poll one request's status. Requests expire to `deny` |
| POST | `/api/clone` | clone a GitHub repo over ssh into one configured scan root: `{root, name}` where `root` must equal a `scanRoots` entry and `name` is `repo` or `owner/repo`. Refuses anything else (no paths, no URLs), and a destination that already exists. Responds when git finishes; discovery picks the repo up on the next pass |
| GET | `/api/jobs` | job list plus `transport` (gateway URL, reachability, `capabilities`: runs/events/steer/stop/approval/runCwd/runBudget/maxTurns) |
| GET | `/api/stream` | SSE: `snapshot`, `row`, `project`, `drop`, `job`, `jobline`, `jobs`, `approval`, `approval-answered`, `remote-write`, `remote-write-answered`, `settings`, `heartbeat` |
| POST | `/api/agents/preview` | returns the exact run request that would be sent (`{transport, request, blocked}`), without sending it |
| POST | `/api/agents` | start a run (`{prompt, cwd?, project?, model?, budget?, maxTurns?, existing?}`); `{dryRun:true}` returns the request instead. **503** when the gateway's api_server is unreachable or unkeyed |
| POST | `/api/agents/reply` | `{thread, text}` → another turn on the same `session_id` |
| POST | `/api/worktree/rename` | `{project, path, name, by?, how?}` → rename one worktree: the branch always (`wtgui/<slug>-<tag>`, the six-hex tag kept), the directory when nothing holds it open. Writes down who named it and when (`logs/tree-names.json`), which is what stops the automatic rename for good. **400** for the project's own checkout, **404** for a path that is not a row, **409** when an agent is running in the tree or the target directory exists |
| POST | `/api/worktree/suggest-name` | `{project, path}` → what the tree should be called, read from the work in it: the branch's commits against the base branch and their diff, reduced to a `<slug>-<tag>` name and the evidence behind it. Renames nothing — the row's `✦` puts it in a question and the click answers it through `/api/worktree/rename`. Same **400**/**404** refusals as the rename |
| POST | `/api/jobs/steer` | `{id, text}` → `POST /v1/runs/{id}/steer`; read at the agent's next tool boundary. 409 when the turn already crossed it |
| POST | `/api/jobs/approve` | `{id, choice, requestId?}` → `POST /v1/runs/{id}/approval`; `choice` must be one the host offered |
| GET/POST | `/api/settings/approvals` | the gateway's `approvals.timeout`. GET reports the value, whether `config.yaml` sets it, the file's path, and whether this panel may change it. POST `{timeoutSeconds}` rewrites only that line under `approvals:` in `<HERMES_HOME>/config.yaml` — comments, indentation and line endings untouched — and re-reads the file before writing, refusing if it does not say what was asked. **400** outside 15–86400, **409** when the gateway is not on this machine |
| GET | `/api/sessions?path=` | the Hermes sessions the scheduler attributes to one worktree row: `{id, title, matched, lastActivityAt, onBoard}`. The same answer the row's "idle session" claim comes from |
| POST | `/api/sessions/revive` | `{sessionId, path}` → a job record for a session the board has no card for (the run itself lives in the gateway; a reply continues it). **404** when the store does not attribute that session to that row, **409** when it already has a card |
| GET/POST | `/api/settings/sessions` | the CLI's session-list length: GET reports `sessions.list_limit`, the store's real size (sessions, messages, by source) and whether the local CLI patch that reads the key is installed; POST `{listLimit}` rewrites that one line in `config.yaml`. **400** outside 1–500 |
| GET | `/api/models` | the New-agent model menu: `{defaultModel, provider, count, fetchedAt, staleDays, providers:[{id,label,models}]}` — the provider list Hermes itself fetched, grouped, with the configured default first in its group. Falls back to the shipped catalogue when no provider was ever picked |
| GET | `/api/assistant` | the sentry's whole state: settings, rule definitions, alerts, watches, notes, journal, wake counter and the current board digest |
| POST | `/api/assistant/say` | `{text}` → one turn on the assistant's own thread (`panel-assistant`), with the scratchpad and board digest attached to the input. **409** while its previous turn is still running |
| POST | `/api/assistant/settings` | `{autonomy, model, seconds, repeatLimit, quietSeconds, approvalSeconds, contextPercent, maxWakesPerHour, spawnAutoStart, rules:{id: escalation}}` — applied immediately, saved in the scratchpad |
| POST | `/api/assistant/alert` | `{id, action:"dismiss"\|"ask"}` — `ask` wakes the assistant with that alert's digest |
| POST | `/api/assistant/answer` | `{thread, text, alertId?}` — post a reply into a worker's thread from the panel (the only route that does it on your behalf) |
| POST | `/api/assistant/answer-question` | `{id, answer}` — settle a question a run is parked on (the `clarify` control), from a choice button or a typed answer; `answer` is a string, or an **array** for a multi-select question. Not a reply: a reply would queue behind the held turn |
| POST | `/api/assistant/spawn` | `{id}` confirms a spawn card the assistant proposed, or `{project\|target, prompt, existing?}` does the same without a card: cut a worktree in that project (or run in an existing directory) and start a worker. Same refusals as `/api/agents` — gateway unreachable **400**, unborn HEAD **400** |
| POST | `/api/assistant/watch` · `/api/assistant/watch/remove` | add `{thread, title, doneWhen?, minutes?}` / remove `{id}` |
| POST | `/api/assistant/rule` · `/api/assistant/rule/remove` | add `{text}` / remove `{id}` — the assistant's standing answers |
| POST | `/api/assistant/notes` | `{text}` — the freeform scratchpad, read on every turn |
| POST | `/api/assistant/check` | run one sentry pass now (used by the page after a change, and by probes instead of waiting for the clock) |
| POST | `/api/jobs/cancel` | `{id}` → `POST /v1/runs/{id}/stop` (cooperative interrupt) |
| POST | `/api/jobs/clear` | drop finished jobs from the list |
| GET/POST | `/api/restart` | restart the gateway or this panel. GET reports the queue, the last action, the provider-key preflight (`$HERMES_HOME/.env`, or the `model.api_key` line of `config.yaml`) and where `restart.json` is written; POST `{target:"gateway"\|"panel", reason?, waitFor?}` **queues** the action and answers **202** at once. It runs when `waitFor` (default `panel-assistant`) has no turn running, gives every interrupted run one `interrupted` status, proves the new process with one real turn and wakes the assistant once with the payloads. **400** for another target, **409** when one is already queued/running or when no provider key is present |
| POST | `/api/refresh` `/api/fetch` `/api/reload` | force a fast pass / fetch remotes / re-read config |
| POST | `/api/settings/age` | `{days}` → how old a worktree's last activity must be before the worktree chart holds its row back (`config.json`'s `hideOlderThanDays`; `0` shows everything). Rewrites only that key, answers with the settings the page then redraws from, and broadcasts the new snapshot to every open board |
| GET | `/api/remote-write/state` | the remote-write policy, what is parked on the permission box, which trees have a standing grant, and `guards` (which worktrees carry the pre-push hook, and where) |
| POST | `/api/remote-write/request` | **the guard asking.** `{worktree, branch, remote, refs, remoteUrl}` → `{allowed:true}` (the setting allows it, the tree was started to land, or a grant stands), `{refused:true}` (`deny` — no question is offered), or `{id, deadline}` — a question parked on the box. Local-only by nature: the hook runs on this machine, so it needs no token |
| GET | `/api/remote-write/status?id=` | what a parked hook long-polls: `pending`, or `answered` with the choice. A request nobody answered reads `deny` once its window closes |
| POST | `/api/remote-write/answer` | `{id, choice}` from the panel's permission box — `once` / `session` / `always` (which **writes the setting**) / `deny`. A granted panel-side write (a parked merge) is resumed by the same call |
| POST | `/api/remote-write/guard` | `{action:"install"\|"remove", path?, project?}` → put the pre-push guard in one worktree, a project's worktrees, or (with neither) every local-only tree on the board. Idempotent; the automatic path is the panel's own worktree creation |
| POST | `/api/settings/remote-branches` | `{policy:"local-only"\|"allow"\|"deny"}` → write `config.json`'s `remoteBranchPolicy`, push it into every installed guard's own copy, and broadcast `settings`. **400** for anything else |

## Roadmap

- **Stage 1 (done):** agents as gateway runs — worktree per agent, live event stream, steering,
  approvals on the card, threads as `session_id`.
- **Next:** worktree reclamation for `wtgui/*` trees (nothing removes them now), per-run `skills`
  once the Runs API carries them, and a `worktree` field so the panel can name the branch.
- **Later:** durable queue — `hermes kanban create --workspace worktree` + `dispatch`, with review
  handoffs (`request-review` / `request-changes`) surfaced in the panel.

## Troubleshooting

- **`503 the Hermes gateway API is not usable at http://127.0.0.1:8642`** — the gateway is down, or
  `API_SERVER_KEY` is missing from `$HERMES_HOME/.env`. Start it with `hermes gateway restart`; the
  chip in the New-agent header tells you which of the two it is.
- **The agent works in the gateway's directory instead of its worktree** — the local gateway patch
  (`docs/hermes-runs-api-knobs.diff`) is not applied, or was lost to `hermes update`. The chip says
  `gateway ignores per-run cwd` when this is the case.
- **A tool result in the console is cut short** — the run stream carries a *preview* of each tool
  result, not all of it. The gateway caps it at **500 chars** by default (`preview[:497] + "..."`, cut
  mid-line); `HERMES_RUN_PREVIEW_CHARS` on the gateway process raises it — `0` = full — and a running
  gateway needs a restart for that to take effect. The console unwraps the JSON envelope, prints the
  text, and ends with `… result truncated by the gateway` when it was cut. Nothing is lost: the whole
  result is stored verbatim in `state.db` (`messages.content`, `role='tool'`) and `lib/tool-results.js`
  already reads it back. Measured numbers, the exact lines, and the CLI spawn path's own separate
  5,000-char cap (`HERMES_STREAM_TOOL_CAP`): [docs/tool-output-truncation.md](docs/tool-output-truncation.md),
  re-measurable with `node tools/measure-tool-output-cap.mjs`.
- **A flagged command runs without asking** — check `approvals.mode` (`smart` waves many through)
  and `security.approval.transport` (must be `builtin` for runs).
- **No stats row above a reply box, or an agent writing outside its worktree** — the same cause:
  `gateway/platforms/*.py` is the stock file again (`hermes update` replaces them). Check the running
  gateway, not the source: `curl -s -H "Authorization: Bearer $API_SERVER_KEY"
  http://127.0.0.1:8642/v1/capabilities | grep run_cwd` — absent means the process has no local patch,
  so `cwd` / `max_turns` / `run_budget` are silently ignored and no `run.usage` is ever emitted.
  Re-apply `docs/hermes-runs-api-knobs.diff` and restart the gateway.
- **`fatal: cannot change to ...: No such file or directory`** — native git can't take MSYS
  `/c/...` paths; use `C:/...`.
- **A restart is refused: `no provider key in <HERMES_HOME>/.env`** — that is the preflight, not a failure of the
  route. A gateway started without a provider key binds its port, answers `/health`, and then every run it
  dispatches dies with `No LLM provider configured`. Write the key where the gateway loads it —
  `hermes config set OPENROUTER_API_KEY <key>` puts it in `$HERMES_HOME/.env` — and ask again. `GET /api/restart`
  reports the same check, plus the queue and the last action, so a refused request is visible without reading a log.
- **Port already in use** — `stop-background.cmd`, or `netstat -ano | grep 7331` and kill the PID.
