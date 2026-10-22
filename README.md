# agent-worktree-gui

A local panel that watches every git worktree across one or more projects, and runs Hermes agents in
their own worktrees — live output, mid-turn steering and approvals on the agent's card.

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
`API_SERVER_KEY` is read from the process environment, else `$HERMES_HOME/.env`; the `:port` /
`● board` liveness signals read `netstat` / `tasklist`, so off Windows those two signals simply stay
dark — everything else works.

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

### Agents

The **New agent** card starts one Hermes agent in its own worktree and streams the turn live. An agent
is a **run on the Hermes gateway's `api_server`**, not a spawned CLI:

    POST http://127.0.0.1:8642/v1/runs   {input, session_id, cwd, model?, max_turns?, run_budget?}
    GET  /v1/runs/<id>/events            SSE: tool.started / tool.completed / message.delta /
                                              approval.request / run.completed|failed|cancelled
    POST /v1/runs/<id>/steer             inject guidance into the live turn
    POST /v1/runs/<id>/stop              cooperative interrupt
    POST /v1/runs/<id>/approval          answer the flagged command a run is parked on

`Preview request` shows the exact body before anything is sent. The gateway has to be up and keyed:
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

While a turn is **still running** the reply box's primary button is **Steer turn** — Enter does the
same. The text goes into the LIVE run and is read at the agent's next tool boundary, so the turn
changes course instead of queueing behind it. **Queue reply** is the explicit "send this when the
current turn finishes" path. A steer that arrives after the last tool boundary comes back as
`pending_steer`, and the panel replays it as the next turn rather than dropping it.

When nothing is running the button is **Send reply**: it starts the next turn on the same session, in
the same directory. Replies inherit the first turn's model; threads are real Hermes sessions, so they
appear in `hermes sessions list` like any other.

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

#### Credentials

A run executes inside the gateway process, so the provider key is whatever that gateway is configured
with; this panel never touches it. What the panel needs is the api_server bearer token, read from
`API_SERVER_KEY` in `$HERMES_HOME/.env` (or `apiServer.key` in `config.json`) and sent as
`Authorization: Bearer …`. It is never logged and never returned by any endpoint.

`HERMES_HOME` is only used to find the gateway's own files — `.env` for that token, and `config.yaml`
for the approval window — agent processes are not spawned from here any more.

## Config (`config.json`)

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | 7331 | HTTP port |
| `scanRoots` | `["C:/ProjectDevelopment"]` | directories scanned for git repos; every repo found becomes a monitored project |
| `host` | `127.0.0.1` | bind address. **Loopback by default and it should stay that way** — this panel spawns processes, so exposing it on the LAN is unauthenticated remote code execution |
| `token` | *(unset)* | if set, write endpoints require an `x-panel-token` header |
| `defaultCwd` | most recently active project | fallback target for a spawned agent when no project is chosen |
| `hermesBin` | auto | explicit path to the hermes executable; used by the `hermes worktree` audits behind `/api/cleanup` (agent runs do not spawn it) |
| `apiServer` | `{"url":"http://127.0.0.1:8642"}` | `url` of the gateway's api_server, and optionally `key` (else `API_SERVER_KEY` from `$HERMES_HOME/.env`) |
| `jobMaxRuntimeSeconds` | 3600 | hard cap on a spawned job |
| `liveSeconds` | 5 | how often liveness evidence is re-read for every row (no git) |
| `worktreeSeconds` / `dormantSeconds` | 5 / 30 | active-row / dormant-row git scan cadence |
| `slowSeconds` | 60 | project meta, discovery, and expensive per-row fields |
| `fetchSeconds` | 600 | how often remotes are fetched |
| `refreshSeconds` | 30 | client resync interval |
| `liveMinutes` | 5 | how recent activity counts as live |
| `threads` | 4 (capped) | scan worker threads |
| `discovery.worktreeSource` | `git` | `git` probes each repo (6-7 calls, ~0.8s, the default) or `hermes` runs `hermes worktree list --json` (5.5-7.2s per repo, measured on Windows). `hermes` additionally reports per-tree `locked`/`missing` and a per-branch keep/reap verdict; it is opt-in because discovery sweeps every repo on `slowSeconds`. Either way `/api/cleanup?project=NAME` gives the full audit for one repo on demand |
| `cloneOwner` | `JLRoper` | GitHub owner used by `/api/clone` (and the folder **+** box) when the typed name has no `owner/` prefix |
| `projects[]` | — | `name`, `path`, `remote`, `mainBranch`, `prRepo` |

## Endpoints

| Method | Route | Notes |
| --- | --- | --- |
| GET | `/api/health`, `/api/config`, `/api/stats` | settings / scheduler / pool |
| GET | `/api/state` | full snapshot (projects, worktrees, jobs, spawn info) |
| GET | `/api/cleanup?project=NAME[&fresh=1]` | on-demand `hermes worktree list --json` audit for one repo: trees, external trees (`locked`/`missing`), per-branch keep/reap verdict + reason. ~6s, cached 10 min |
| GET/POST | `/api/approvals`, `/api/approvals/answer`, `/api/approvals/<id>` | human side of the Hermes approval-transport contract: list pending requests, answer one (`{id, choice}` within the request's `allowed_choices`), poll one request's status. Requests expire to `deny` |
| POST | `/api/clone` | clone a GitHub repo over ssh into one configured scan root: `{root, name}` where `root` must equal a `scanRoots` entry and `name` is `repo` or `owner/repo`. Refuses anything else (no paths, no URLs), and a destination that already exists. Responds when git finishes; discovery picks the repo up on the next pass |
| GET | `/api/jobs` | job list plus `transport` (gateway URL, reachability, `capabilities`: runs/events/steer/stop/approval/runCwd/runBudget/maxTurns) |
| GET | `/api/stream` | SSE: `snapshot`, `row`, `project`, `drop`, `job`, `jobline`, `jobs`, `heartbeat` |
| POST | `/api/agents/preview` | returns the exact run request that would be sent (`{transport, request, blocked}`), without sending it |
| POST | `/api/agents` | start a run (`{prompt, cwd?, project?, model?, budget?, maxTurns?, existing?}`); `{dryRun:true}` returns the request instead. **503** when the gateway's api_server is unreachable or unkeyed |
| POST | `/api/agents/reply` | `{thread, text}` → another turn on the same `session_id` |
| POST | `/api/jobs/steer` | `{id, text}` → `POST /v1/runs/{id}/steer`; read at the agent's next tool boundary. 409 when the turn already crossed it |
| POST | `/api/jobs/approve` | `{id, choice, requestId?}` → `POST /v1/runs/{id}/approval`; `choice` must be one the host offered |
| GET/POST | `/api/settings/approvals` | the gateway's `approvals.timeout`. GET reports the value, whether `config.yaml` sets it, the file's path, and whether this panel may change it. POST `{timeoutSeconds}` rewrites only that line under `approvals:` in `<HERMES_HOME>/config.yaml` — comments, indentation and line endings untouched — and re-reads the file before writing, refusing if it does not say what was asked. **400** outside 15–86400, **409** when the gateway is not on this machine |
| GET | `/api/sessions?path=` | the Hermes sessions the scheduler attributes to one worktree row: `{id, title, matched, lastActivityAt, onBoard}`. The same answer the row's "idle session" claim comes from |
| POST | `/api/sessions/revive` | `{sessionId, path}` → a job record for a session the board has no card for (the run itself lives in the gateway; a reply continues it). **404** when the store does not attribute that session to that row, **409** when it already has a card |
| POST | `/api/jobs/cancel` | `{id}` → `POST /v1/runs/{id}/stop` (cooperative interrupt) |
| POST | `/api/jobs/clear` | drop finished jobs from the list |
| POST | `/api/refresh` `/api/fetch` `/api/reload` | force a fast pass / fetch remotes / re-read config |

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
  result, not all of it. The gateway caps it at 8000 chars by default (`HERMES_RUN_PREVIEW_CHARS` on
  the gateway process changes it); the console unwraps the JSON envelope, prints the text, and ends
  with `… result truncated by the gateway` when it was cut.
- **A flagged command runs without asking** — check `approvals.mode` (`smart` waves many through)
  and `security.approval.transport` (must be `builtin` for runs).
- **`fatal: cannot change to ...: No such file or directory`** — native git can't take MSYS
  `/c/...` paths; use `C:/...`.
- **Port already in use** — `stop-background.cmd`, or `netstat -ano | grep 7331` and kill the PID.
