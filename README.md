# agent-worktree-gui

A local panel that watches every git worktree across one or more projects, and — Stage 1 —
can spawn Hermes agents into fresh worktrees from the browser.

Zero dependencies. No `npm install` needed: plain Node (`node >= 18`) + stdlib, plus HTML/CSS/JS
served straight from `public/`.

    start.cmd              # foreground (Ctrl+C to stop)
    start-background.cmd   # detached, logs to logs\server.out.log / .err.log
    stop-background.cmd    # stop it

Then open **http://127.0.0.1:7331**.

## Running it on another machine

**Point an agent at it.** `SETUP.md` is written to be *executed* rather than read: exact commands, a
verification section, and what each failure mode means. The repo is private, so hand an agent on the
other machine this:

> Clone `JLRoper/agent-worktree-gui` with `gh` (it is private), follow `SETUP.md`, set `scanRoots` to
> where my repos live, verify it, and give me the URL to open.

Make the repo public and the raw URL works by itself:
https://raw.githubusercontent.com/JLRoper/agent-worktree-gui/main/SETUP.md

By hand — Node 18+ and nothing else, no dependencies, no build step:

    gh repo clone JLRoper/agent-worktree-gui
    cd agent-worktree-gui
    setup.cmd            # Windows: first-run checks (node / git / hermes)
    ./setup.sh           # macOS/Linux: same checks
    start.cmd            # or: node server.js

Edit `config.json` first: `scanRoots` is where your repos live (every git repo under it is
monitored), plus `host`/`port`. If `config.json` is missing the panel starts on defaults and says so.

The two gateway-connected bits are Windows-flavoured and degrade elsewhere:
`OPENROUTER_API_KEY` is taken from the process environment first and from `HKCU\Environment` as a
fallback (if your key lives in `$HERMES_HOME/.env`, the spawned CLI loads it itself, so injection is
not needed); cancelling a job uses `taskkill`, and the `:port` / `● board` liveness signals read
`netstat` / `tasklist`, so off Windows those two signals simply stay dark — everything else works.

`node tools/verify-verdicts.mjs [project]` re-derives every row's merge verdict straight from git and
diffs it against the panel (exit 1 on any mismatch) — useful after touching the scan logic.

## Two halves

### Monitor (read-only)

Worker threads scan the projects; the HTTP layer never runs git itself. Rows are patched
individually over SSE and flash when something changed.

**Projects are discovered, not hard-coded.** Every git repo under `scanRoots` (config.json) is
monitored, and the project list is ordered by how recently it was worked on — the newest of the
repo's last commit and the newest file edit inside any of its worktrees. Non-git directories are
listed in the footer as skipped rather than silently ignored. An entry in `projects` overrides what
discovery finds for that name (heroes-js carries a `prRepo`).

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
worktree whose branch has zero commits (a fresh `-w` tree, or a branch created and never committed
to) reports `NO COMMITS` instead — and is deliberately *not* counted as safe to remove, so a brand
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

### Agents (Stage 1: spawn)

The **New agent** card runs one Hermes agent in its own worktree and streams its output live.

**Start in** is an editable path field, pre-filled from the `project` picker (suggestions come from
one `<datalist>` of every discovered project path). Clicking the green **+** beside a project's name
sets both the picker and the `start in` field to that project and puts the cursor straight in the
prompt, so the agent works in the project whose `+` you clicked. Edit the field by hand and that
explicit path wins over the picker (the server prefers an explicit `cwd`); the line under the box
tells you where the new worktree will land and flags when the location differs from the picker. A
directory that is not a git repo cannot host a worktree, so it is not offered.

It builds exactly this (the `Preview command` button shows it before anything runs):

    <hermes> chat -q "<prompt>" -w -Q --format stream-json [--run-budget N] [--max-turns N] [-m model] [-s skills] [--yolo]

Semantics, all verified against real runs:

- **Refused up front**: a repo with no commits (unborn HEAD) cannot host a worktree, because
  `git worktree add` needs a HEAD to branch from. The card warns (with the exact remedy command)
  and disables Spawn, and the server refuses the request with the reason — rather than letting the
  run die inside the CLI with `fatal: invalid reference: HEAD`.
- **A failed worktree is a failed job.** `hermes -w` prints the failure and then exits **0**, so the
  job registry treats a `Failed to create worktree…` line in the output as fatal and marks the job
  failed — otherwise the card would report `DONE` for a run that never started a session.
- **Worktree**: `-w` creates `.worktrees/<name>` on branch `hermes/<name>`, based on
  `github/main` **fetched fresh at spawn time** (so it starts from the remote tip, not a stale
  local main). Hermes owns the name and prints the path/branch/base in the output.
- **Cleanup**: if the run produced **no commits**, Hermes removes the worktree itself when it
  finishes. If it committed, the tree stays so you can review/push it — and it shows up as a new
  row in the monitor a few seconds later. `hermes worktree prune` reclaims it later (note: prune
  also deletes fully-merged local branches, so it sweeps more than just this run).
- **Output**: `--format stream-json` gives newline-delimited events — `system/init` (model +
  session id), `text` deltas, then `result` (`exit_code`, `tokens`, `duration_ms`). The panel
  strips ANSI codes and coalesces text deltas into one line. A failed init (bad credentials)
  arrives as a `result` with `exit_code: 1` and an `error`.
- **Cancel** kills the process tree (`taskkill /PID <pid> /T /F`), since the CLI spawns children.
- **Minimize**: click a card header to fold it, or use `Minimize all` / `Expand all`. Any number of
  cards can be folded independently, and a folded card keeps its status, pid, model, worktree and one
  live line showing what the agent is doing or last said. Folding is remembered in `localStorage`, so
  a reload — or the 30s resync, which rebuilds every card — does not spring everything back open.
- **Hard cap**: any job still running after `jobMaxRuntimeSeconds` is killed and marked failed.
- **A running job dies if the panel stops.** `stop-background.cmd` does
  `taskkill /PID <pid> /T /F`, which kills the panel's whole process tree — spawned agents included.
  The worktree and any files the agent wrote survive, but the tree stays `locked` by a now-dead pid,
  so clear it with `git worktree unlock <path>` (plain `hermes worktree prune` will not touch a
  locked tree). Restarting the panel therefore does not resurrect the job list either.
- **Jobs are in-memory.** Restarting the server clears the list (the worktrees and commits are
  unaffected). Persisting them is Stage 2 work.

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

This mapping is the panel's own, because Hermes records **no cwd** for the `-c` named-thread sessions
the panel starts (not in `sessions.cwd`, and `git_branch` / `git_repo_root` are empty too), and a
finished one-shot is marked closed — so the `⧉ hermes` signal, which matches on a session's cwd,
can never place a panel-started agent. `⧉ panel (done)` means the agent that ran there has finished
but is still in the panel's list.

#### Replying to an agent

Each card is a conversation, and you can keep talking to it. Every agent is started on a **named
Hermes thread** (`wtgui-<words>-<id>`), so a reply runs as another turn of the same session:

    hermes chat -c <thread> --create-if-missing -q "<first prompt>" -w -Q --format stream-json   # turn 1
    hermes chat -c <thread> -q "<your reply>" --in <dir> --no-restore-cwd -Q --format stream-json  # turn 2+

Verified: the reply reuses the same session id and remembers the earlier turn — even after turn 1's
worktree has been cleaned up, which is why replies pass an explicit `--in <dir>` and
`--no-restore-cwd`. That directory is the agent's worktree while it still exists, otherwise the
project it was started from. Replies inherit the first turn's model, budget and `--yolo` setting, run
without `-w` (no new worktree), and can be sent while a turn is still running — they queue behind it.
Threads are real Hermes sessions, so they show up in `hermes sessions list` like any other.

#### The `--yolo` checkbox

**Off by default.** A GUI-spawned agent has no TTY, so it cannot answer a dangerous-command
approval prompt — it would simply stall. `--yolo` runs it unattended with no approvals. Tick it
only when you mean it, and only with `--run-budget` set.

#### Credentials

A spawned Hermes CLI does **not** inherit `OPENROUTER_API_KEY` on this box (the key lives in
`HKCU\Environment`, and this process tree predates it), so an unmodified child dies instantly with
"No API key found for provider 'openrouter'" (`exit_code: 1`). The server therefore reads the key
from the User environment at spawn time and passes it in the child's environment only. It is never
logged and never returned by any endpoint. `key: env` in the card header means the value came from
this process's own environment; `key: from registry` means it was looked up in `HKCU\Environment`.

`HERMES_HOME` is normalised to native form before spawning — handing a native CLI an MSYS-shaped
`/c/...` path makes it falsely report a missing dependency environment.

## Config (`config.json`)

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | 7331 | HTTP port |
| `scanRoots` | `["C:/ProjectDevelopment"]` | directories scanned for git repos; every repo found becomes a monitored project |
| `host` | `127.0.0.1` | bind address. **Loopback by default and it should stay that way** — this panel spawns processes, so exposing it on the LAN is unauthenticated remote code execution |
| `token` | *(unset)* | if set, write endpoints require an `x-panel-token` header |
| `defaultCwd` | most recently active project | fallback target for a spawned agent when no project is chosen |
| `hermesBin` | auto | explicit path to the hermes executable; auto-detects `$LOCALAPPDATA/hermes/bin/hermes.exe`, else `hermes` on PATH |
| `jobMaxRuntimeSeconds` | 3600 | hard cap on a spawned job |
| `liveSeconds` | 5 | how often liveness evidence is re-read for every row (no git) |
| `worktreeSeconds` / `dormantSeconds` | 5 / 30 | active-row / dormant-row git scan cadence |
| `slowSeconds` | 60 | project meta, discovery, and expensive per-row fields |
| `fetchSeconds` | 600 | how often remotes are fetched |
| `refreshSeconds` | 30 | client resync interval |
| `liveMinutes` | 5 | how recent activity counts as live |
| `threads` | 4 (capped) | scan worker threads |
| `projects[]` | — | `name`, `path`, `remote`, `mainBranch`, `prRepo` |

## Endpoints

| Method | Route | Notes |
| --- | --- | --- |
| GET | `/api/health`, `/api/config`, `/api/stats` | settings / scheduler / pool |
| GET | `/api/state` | full snapshot (projects, worktrees, jobs, spawn info) |
| GET | `/api/jobs` | job list with streamed output tails |
| GET | `/api/stream` | SSE: `snapshot`, `row`, `project`, `drop`, `job`, `jobline`, `jobs`, `heartbeat` |
| POST | `/api/agents/preview` | returns the exact argv without spawning |
| POST | `/api/agents` | spawn (`{prompt, model, budget, maxTurns, skills, yolo, cwd}`); `{dryRun:true}` also supported |
| POST | `/api/jobs/cancel` | `{id}` → kill the tree |
| POST | `/api/jobs/clear` | drop finished jobs from the list |
| POST | `/api/refresh` `/api/fetch` `/api/reload` | force a fast pass / fetch remotes / re-read config |

## Roadmap

- **Stage 1 (this):** `hermes chat -w` spawn + job registry + live output + cancel + preview. Done.
- **Stage 2:** first-class "create worktree" with an editable branch name and base ref (instead of
  letting `-w` name it), plus job persistence across restarts.
- **Stage 3:** durable queue — `hermes kanban create --workspace worktree` + `dispatch`, with
  review handoffs (`request-review` / `request-changes`) surfaced in the panel. Requires
  `hermes project create` first.

## Troubleshooting

- **`exit 1 · No API key found for provider 'openrouter'`** — the key wasn't found in
  `HKCU\Environment`. Set it there, or run the server with it exported.
- **`fatal: cannot change to ...: No such file or directory`** — native git can't take MSYS
  `/c/...` paths; use `C:/...`.
- **Port already in use** — `stop-background.cmd`, or `netstat -ano | grep 7331` and kill the PID.
