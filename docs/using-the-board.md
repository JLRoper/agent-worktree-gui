# Using the board

The main page is a board of git worktrees with one card per Hermes agent conversation. It is meant to be read
top to bottom: what the panel is doing at the top, the two fixed cards (start an agent, the agents with no
worktree of their own), then every project and its worktrees, then the agents working inside them.

Open the URL the panel was started on — `http://127.0.0.1:7331` by default (`port` in `config.json`). It binds
loopback only unless you change `host`, and it has no login: keep it on `127.0.0.1`.

The page is read-only towards git except for **Fetch remotes** and the buttons that explicitly write (a spawn
cuts a worktree, a row's ✕ removes one, the folder **+** clones a repo). Everything else is `rev-parse`,
`rev-list`, `merge-base`, `cherry`, `diff`, `status` and `log`.

---

## The page at a glance

| Region | What it is |
| --- | --- |
| Top bar | Liveness dot, stream state and rate, and the page's own controls. Sticky: it stays on screen while you scroll. |
| **New agent** | The spawn form. Its header line always says what a spawn will do (a new worktree, or a run in a directory as it is). |
| **Unattached agents** | Agent cards whose directory is not a worktree on the board — or none at all. |
| Folders → projects → worktrees | One accordion per scan root, every git repo under it, a table row per worktree. |
| Agent cards | Inside an expanded worktree row: the conversation, its console, its reply box. |
| Approvals dock | Bottom-right, over the board, only while something is waiting on you outside a card. |
| Footer | The cadences the board is running at, what each gesture does to git, and any directories skipped. |

---

## Top bar

| Control | What it does |
| --- | --- |
| ● dot | Green while the live stream is healthy and snapshots apply. Amber on `reconnecting…`, red on `offline` (the panel server is unreachable). |
| **Worktree Agent Monitor** | Click it for Settings — the same panel as ⚙ Settings, handy when the page is zoomed in. |
| Config line | Version, how many projects are being watched, the two main cadences, scan threads, bind host. |
| Stream readout | `pool 1/3 · 3 conversations · 29 events · 2.4/s`: scan workers busy, how many conversations, and the event rate arriving over SSE. |
| **NOT-RUNNING** | Steps through the agents that are not running and are waiting on you. See below. |
| **Collapse all** | Folds the whole tree — every folder, project, worktree row, card and turn. The button then reads **Expand all**. Same as `Ctrl+[` / `Ctrl+]`. |
| **Refresh now** | Forces a fast scan of every project instead of waiting for the next tick. |
| **Fetch remotes** | Runs `git fetch <remote> --prune` in every project. The only routine gesture that touches git refs. |
| **Pause** | Freezes the page: closes the live stream, so nothing updates. The button reads **Resume**, which reconnects and resyncs. |
| **⚙ Settings** | The Settings panel (`Ctrl+,`). |

### The NOT-RUNNING rotation

Click **NOT-RUNNING** and the panel opens the first agent that is not running, focuses its reply box and flashes
its card amber. The button counts its place (`NOT-RUNNING 2/5`).

- **Enter** sends the reply and moves straight to the next waiting agent — the quickest way to clear a queue.
- **Alt+Right** skips forward without sending; **Alt+Left** goes back.
- Click the button again to stop; the counter disappears.

An agent that starts running, or that you answer, drops out of the rotation as it goes. When nothing is waiting,
the button says so in a banner rather than pretending to step.

---

## Starting an agent

Everything happens on the **New agent** card.

| Field | Meaning |
| --- | --- |
| Prompt | The first turn. `Enter` spawns, `Shift+Enter` adds a line, `Up`/`Down` walk the prompts you have spawned before. Paste or drop a file into it to attach that file (see below). |
| **start in** | The directory. Usually filled in by aiming, but you can type any path. |
| **project** | Which project the work belongs to. Changing it points **start in** at that project and re-ticks **create workspace** — the picker is not a display field. |
| **model** | `(default)` uses the gateway's configured model. The list is what the provider advertises, grouped by provider. |
| **budget s** | The run's wall-clock budget (`1800` by default). |
| **max turns** | Optional ceiling on turns; blank means the gateway's own default. |
| **skills** | Disabled: a run does not carry a skills list yet. |
| `--yolo` | Disabled on purpose. A run is never blind to a flagged command, so there is nothing to bypass — approvals come to the card. |
| **create workspace** | Ticked: cut a new worktree and branch under `.worktrees/` and run there. Unticked: run in **start in** as it is. |
| **Spawn agent** | Starts the run. The card says the run id and the worktree it made. |

The dim line under the card title is the promise: **run · new worktree under `…/.worktrees/` · project X** when a
workspace will be created, or **runs IN `…` (no new worktree); edits land in that tree** when it will not. That is
the line to read before clicking.

### Two ways to aim the card

- **The green + on a project** — "start work in this project": points **start in** at that project, ticks **create
  workspace**, and puts the caret in the prompt. A fresh worktree under `.worktrees/` will be cut.
- **The green ▶ on a worktree row** — "run an agent in this tree": fills **start in** with that worktree, selects its
  project, and **unticks** create workspace, because the tree already exists. The card says `runs IN …`.
  If agents already work in that tree, a dialog warns that they share it (index locks and each other's edits) before
  aiming.

Both gestures scroll the card into view and flash its border, so a filled-in form is never out of sight.

The two chips at the right of the New-agent header are the gateway's state: `api: up · steer` (hover for the address)
or **api: down**, and the gateway's `host:port`. A spawn is refused with a reason rather than leaving a card that
never starts:

- **No commits in the repo** (unborn HEAD) — no HEAD to branch from. Spawn is disabled and the card offers
  **make the first commit**, which creates an empty initial commit locally and pushes nothing.
- **Gateway down or unkeyed** — `503` with the gateway's own message; start it with `hermes gateway restart`.
- **A brand-new repo** appears on the board on the next discovery pass, so a just-cloned project may take a moment.

### Attachments

Paste or drop a file into the spawn prompt or any reply box. The file is stored by the panel and a chip appears
above the box: `[name]×`. The agent is handed the path and told to `read_file` it (images: `vision_analyze`) before
answering. The chip's `✕` removes it before sending.

### Where the card lands

The card appears under the row of the worktree it was created for, immediately — not after the next scan. An agent
started in a project's own checkout (no new worktree) is filed on the project's base row and tagged *in the project
checkout (no worktree)*.

---

## Unattached agents

Cards whose agent ran outside any scanned worktree: a directory the board does not know, or no directory at all
(an agent started from somewhere else). The section header counts them:

- `N unattached` · `N in worktrees` · `N turns` · `N running` · `N minimized` — each appears when it applies.
- **Minimize all** folds every agent card on the board, not only these (it reads **Expand all** when they all are);
  **Clear finished** drops every finished turn the panel holds, keeping anything still running. Neither touches a
  worktree.
- A homeless card has an **attach** button: if its own directory is a worktree the board knows, it attaches there in
  one click; otherwise a picker asks which row it belongs under.

---

## The board

### Folders

Each configured scan root is a folder (for example `C:\ProjectDevelopment\`). The title line folds it and carries
the aggregate state: `12 projects · 41 worktrees · 6 unmerged · 9 dirty · 4 live`, plus `N hidden` while the folder
is showing only the last seven days.

- **Filter** — type to narrow that folder's projects by name or path; the box reports `N/M`, `✕` clears it, and
  `Escape` clears it too. The filter is not remembered across a reload, deliberately: reopening to a board missing
  ninety projects reads as if they were lost.
- **All / 7d** — toggles between every project and only those touched in the last seven days (a commit, a file edit,
  or any liveness evidence). The chip count then says how many are hidden.
- **Collapse all / Expand all** — folds or opens every project inside that folder, not the whole board.
- **+** — clone a GitHub repo over SSH into that folder. Type `name` or `owner/name` and press `Enter` (or click
  **Clone via ssh**); `Escape` closes the row. The owner defaults to `cloneOwner` in `config.json`. The new repo
  shows up on the next discovery pass.

### Projects

Every git repo under the folders is a project, ordered by how recently it was worked on. A project starts folded to
its title line; click the line (or its chevron) to open it, and the projects you open are remembered in this browser.

The title line carries:

- **The green +** — aim the spawn card at this project (see above).
- **The path.**
- **Chips**: `N worktrees` · `N merged` · `N no commits` · `N unmerged` · `N dirty` · `N serving` (a dev server
  declared in a worktree's `.env` is listening) · `N hermes` (Hermes sessions from outside this panel, with `N
  running` when one is executing) · `⧉ N panels` (this panel's own agent cards, with a running count) · `⚠ N awaiting
  approval` · `N safe to remove` · `N reclassifying` (verdict still being computed).

The line beneath it says where local `main` is against the remote (`0 behind / 0 ahead of remote`), any live `.agentboard`
PID, the remote tip with its subject and age, and when the project was last fetched.

**Project colours.** `Ctrl+click` a project's title line to tint that project with a random hue; `Ctrl+click` again
rolls a new one; `Ctrl+Shift+click` clears it. The hue tints only the project's own surfaces (box, title row, column
header, row hover), so it answers "which project is this" and never changes what a badge means. A plain click still
opens and closes the project. Settings → Display → **Project colours** shows how many are coloured and resets them.

### The worktree table

| Column | Meaning |
| --- | --- |
| **Worktree** | The directory name, a green **▶** to start an agent in it, and the `⧉ N` badge for agents this panel has in it (with `running` / `awaiting approval` when they are busy). Clicking the badge opens the row and its cards. |
| **Branch** | The checked-out branch. |
| **Tip** | Short SHA of the branch tip. |
| **Ahead / Behind** | Commits the branch has that the project's base ref (remote main) does not, and commits main has that it does not. `—` when there is no base ref yet. |
| **Cherry** | `+N/−N` from `git cherry`: `+` commits with no equivalent upstream, `−` commits already upstream by patch id (the evidence that a squash or rebase landed them). |
| **PR** | `#123 OPEN` / `#123 MERGED`, `none`, or `none · branch gone` when the branch existed remotely and no longer does. Hover the number for the title. |
| **Dirty** | Modified files, and `+N?` untracked, or `clean`. |
| **Life / next read** | Time since anything last said this worktree is alive, the evidence chips, and a ring that fills toward the next scheduled read. Click the ring to read the row **now**. |
| **Verdict** | See below. |
| ✕ | Remove the worktree (not offered on the project's own checkout row). |

The evidence chips are the only definition of "live" the board uses:

| Chip | Evidence |
| --- | --- |
| `⧉ hermes` | A Hermes session in the gateway's `state.db` whose directory is this worktree and whose last activity is recent. |
| `● board` | An `.agentboard/<pid>.json` entry whose process is alive right now. |
| `:port` | The `API_PORT` in this worktree's `.env` is listening. |
| `✎ files` | A dirty or untracked file was edited recently. |

If none of them fired, the row is not live — whatever processes may be running elsewhere on the machine.

### Verdicts

| Badge | Meaning |
| --- | --- |
| `MERGED (N commits)` | The branch carried commits of its own and they are in remote main. `MERGED (squash/rebase, N commits)` is the same claim proved by patch id instead of ancestry; `MERGED (content identical)` says the branch's tree already matches main. |
| `NO COMMITS` | The branch never moved off the commit it was created at. Nothing to merge; nothing was merged — and it is deliberately *not* counted as safe to remove. `NO COMMITS?` means the reflog is missing or expired, so the panel cannot tell whether the branch ever moved and will not claim it did. |
| `ON MAIN` | This is the primary checkout of the main branch. |
| `UNMERGED (N commits)` | Carries `N` commits that are not on remote main. |
| `EMPTY REPO` / `NO BASE REF` | There is nothing to judge against: the repo has no commits yet, or its remote base ref does not exist here. |
| *(empty, grey)* | Not computed yet. A dashed grey badge is a verdict being reclassified after a change. |

`MERGED` + clean + not live is what the project's **safe to remove** chip counts.

### Opening a row

Click a row to expand it. The detail is built not to bury the agents:

- **Merge state** — folded to one line (`ON MAIN · branch main · 2 untracked · last commit 6m ago`). Open it for the
  full list: ancestor of remote main, cherry counts, branch reflog, whether the branch ever carried its own commits,
  the remote branch, and columns for **Modified**, **Untracked** and **Commits not on remote main** with the diff
  summary.
- **Liveness evidence** — folded, with its strongest line still visible on the header. Open it to see why the row is
  live, or why it is not.
- **Agents** — the cards owned by this worktree, each moved into place rather than rebuilt, so a running console keeps
  its scroll.
- **Sessions with revive** — Hermes sessions attributed to this worktree that have no card, one row each (glyph, when
  it was last used, its name) with **revive**. Reviving writes a card whose reply box continues that session. It is
  one at a time on purpose: a worktree collects every session ever run in it, and auto-attaching would refill the
  board with months of finished conversations. A revive is refused (409) if that session already has a card.

Rows sort by what is worth reading first — a running panel agent, then the most recent sign of life — and a row you
have open keeps its exact slot while the closed ones re-sort around it. Settings → Board → **Board reorder** controls
how often that happens (default 5 s; off is allowed).

### Removing a worktree

The row's ✕ asks in place: *Remove worktree `<name>` on `<branch>`? Its files go to the Recycle Bin (recoverable
there) and git's record of it is pruned.* — **Cancel** then **Delete**, left to right. While any agent run is live in
that directory the request is refused (409); stop the run first. A directory that is already gone counts as removed.

---

## Reading an agent card

### The head

| Element | Meaning |
| --- | --- |
| `⧉` and the chevron | An agent session. Click the head to fold or unfold the card. |
| Pill | `running` (hover for its clock), `not-running`, or `exited` (failed). A turn that ended while the subagents it started are still working still reads `running`. |
| `just now` / `2m` | How long since the thread was last used. |
| `waiting on you →` | The run is parked on a permission request — click to jump to the box. `waiting on your answer →` is the agent's own question. |
| Title | The Hermes session's name, with the worktree, run id and turn count beside it in dim text. |
| `📄 N` / `🔗 N` | Deliverables: files and links, as two separate buttons. |
| Turn pager | `▲`/`▼` and `6–10 / 23` when a thread has more turns than fit on a page. |
| Thread name | The Hermes session id (or your label for it) — the thing a reply continues. |
| `📌` | Pin this card: it keeps its screen position while cards above it grow. One pin at a time; clicking again releases it, and clearing the thread releases it too. |
| `🧠` | Show this session's reasoning (see below). |
| `✎` | Rename the session **in the panel only**. The Hermes thread id never changes. |
| `⤢` | Maximize the card to the window (`Esc` closes). |
| `✕` | Forget this session: the first click arms it (`✕ sure?`), the second removes its turns and transcript from the panel. The worktree it made stays on disk. |

A `yolo` pill appears only if a run was started with that flag elsewhere; the panel never sends it.

### Turns

Each turn is an accordion inside the card:

- `☆ turn 3 · running 12s` — the star pins that turn above the paged turns (it stays in its page as well), the chevron
  opens it, and the line carries how long it ran.
- The open turn holds, in order: the thinking block (if on), the console, the subagent strip, and any approval or
  question box for that turn.
- Sending a reply folds the earlier turns to a **compact** summary — the last tool line, the answer's first lines, and
  one dim line saying what folded. A turn you opened by hand is compacted the same way, not closed.
- A failed turn that is worth retrying (a timeout, a 5xx, a dropped connection) shows **retry** beside its outcome; it
  sends that turn's prompt again as a new turn, because the failed turn's edits are already on disk.

### The console

Output streams into a `<pre>`. It follows the newest line unless you scroll up; a `↓` button brings you back and
re-pins it. A tool result is a **preview** of what the tool returned, not the full payload — when it was cut the
console ends it with `… result truncated by the gateway` (the gateway's `HERMES_RUN_PREVIEW_CHARS` raises the cap).
Opening a specific tool can fetch the stored result from the session store.

**A run of tool calls is condensed.** Consecutive calls between two pieces of prose become one group, one row per
tool name: `💻 terminal ×11 curl …` with the last input and either a duration or a live clock. Click a row to filter
the group to that one tool; the button then reads **all N** and clears the filter. **`N lines`** opens every call and
its output in that group. Text ends a group, so the next call starts a fresh tally.

### Approvals and questions

A run that hits a flagged command parks, and the question appears **under that turn's console** as a raised box
saying `⚠ waiting on you — this turn is parked until you answer`, the command, and exactly the choices the host
offered (`Allow once`, `Allow for this session`, `Always allow`, `Deny` on a standard host). Answering collapses it to
one line: `✓ approved once: <command>`, or a red `✕ denied: <command>`. The panel never widens the choice list.

An agent's **own question** (the `clarify` tool) is the same kind of control in a light-purple box: each choice is a
full-width row, the recommended one is marked, multi-select choices are ticked and sent together, and a box under
them takes a typed answer (`Enter` sends, `Shift+Enter` adds a line). Answered, it reads `✓ answered: …`; a question
answered elsewhere, withdrawn or expired leaves `· question closed without an answer here`.

**The dock.** Approvals that do not come over a run's own stream (a selected approval transport, the legacy CLI
contract) land in a stack pinned bottom-right: `⚠ waiting on you`, a count chip, a `▾` to fold it, and one card per
request naming the agent, the command and `expires in Ns`. Answering there sends the choice within the host's list;
an expiry means the command does not run.

### Thinking

`🧠` on a card turns on that session's reasoning; Settings → Agent cards → **Show thinking** sets the default for
cards that have not chosen. The block sits above each turn's console and reads `🧠 thinking · N blocks` — open and
refreshed while a turn runs, folded once it ends. It is off by default because each block is real bytes.

### Subagents

A turn that delegated shows a strip under its console: `⧉ N subagents · N running` (or `all done`). Open it for each
child's goal, its status and how long it ran, with the last line it wrote — click a child for its console. Status is
the point; the full child transcript is one click further. A folded turn keeps the one-line tally so you can see where
the agents came from.

If a parent's turn ended before its children finished, Settings → Agent cards → **Collect subagent results** (on by
default) hands the parent their results as one more turn, once per turn, so a delegation is not left finishing into
nothing. **collect** on the strip does the same on demand, and reads `✓ collected` once the results were sent.

### The usage strip

Above the reply box: the model that will run next, and — when the gateway reported usage — what the turn used:

```
deepseek-v4.1-flash-1017 │ 101K/1.05M⌄ │ █········· 10% │ ◎ 92.6% │ ◷ 4.2s │ ↑ 231 t/s │ ⇊ 1
```

- **model** — double-click for the model picker (search as you type; the current choice is marked; the next turn uses
  it).
- **used/ceiling⌄** — click to step the ceiling the card measures against. The ladder is built from the model's real
  window: the window itself, then three quarters, a half and a quarter of it, plus whichever of 1M, 400K, 200K and
  128K fit under it — biggest first, wrapping back to the window (which stores "no ceiling"). Sizes above the model's
  window are never offered. **Right-click** opens the full picker (type a size, or blank it); a hand-typed size that
  is not on the ladder steps to the next smaller tier.
- **the bar and `%`** — context occupancy against that ceiling.
- **`◎`** — prompt-cache hit rate. **`◷`** — mean model latency. **`↑`** — throughput. **`⇊`** — how many times the
  transcript was compacted.

`~` marks a figure the panel had to estimate; anything the gateway did not report is omitted rather than shown as
`0`, so a card with no usage can end up showing only the model (and the ceiling control once one is known) rather than
a row of zeros. Token counts read in three significant digits, truncated (`636k tok`), and only ever grow.

### The reply box

- It grows with the draft (up to about 18 lines, or 45% of the window) and the buttons ride its bottom edge.
- **While a turn runs**, the primary button is **Steer turn**: the text goes into the live run and is read at the
  agent's next tool boundary, so the turn changes course. `Enter` does the same.
- **Queue reply** holds the text and sends it when the current turn finishes; queued replies show as ghost turns
  (`queued · sends when the current turn finishes`). While subagents are out, queueing also waits for them.
- **Send reply** when nothing is running: the next turn on the same session, in the same directory. `Enter` sends,
  `Shift+Enter` adds a line, `Up`/`Down` walk earlier prompts for that thread, shell style.
- **Cancel turn** stops the live run (cooperative — the card settles as `cancelled` when the turn actually ends).
- A steer that arrives after the last tool boundary comes back as `⇢ that steer missed the turn — it is in the box,
  unsent`; send it again to continue on the same thread.

Above the box, paste or drop a file to attach it to the reply; the chip shows what is attached and `✕` removes it.

### Deliverables

`📄 N` lists the files the agent produced that a person would open (`.md`, `.sql`, `.csv`, `.sh`, `.pem` …), and
`🔗 N` lists URLs it handed over — a dev server, a page it built. Each is its own popup, one visible at a time,
newest last:

- Click the name to open it (a file in your editor, a URL in your browser); hover for the exact path.
- **copy** puts the full path or URL on the clipboard.
- **✕** asks once, in place (`Delete <name>?` · cancel · **yes, delete**) — files are deleted from disk, links are
  only removed from the list.

Edits to existing tracked files are not deliverables. Both lists are persisted with the job, so they survive a panel
restart.

---

## Settings

`⚙ Settings`, the title, or `Ctrl+,`. `Esc`, the `✕`, or a click outside closes it. The head is fixed and the body
scrolls; every explanation is the row's own tooltip on the `ⓘ`.

**Stored in this browser** (per browser, not shared):

| Group | Row | Meaning |
| --- | --- | --- |
| Display | Page zoom | `Ctrl+` / `Ctrl-` / `Ctrl+0` (reset), or the `−`/`+` buttons here. `Ctrl+wheel` zooms the page too, except over a console, where it sizes that console's text. |
| Display | Panel font | Headings, labels, buttons and the text you type. |
| Display | Terminal font · Console size · Console weight | The console and the tool lines inside it. |
| Display | Panel contrast | How far apart the layered surfaces sit: 0% flattens them, 100% pushes the page to near-black and lifts the panels. The swatch strip below previews the layers. |
| Display | Project colours | Count in the tooltip, **reset colours** clears every project's hue. |
| Agent cards | Show thinking | The default for cards' `🧠`; a card's own toggle wins. |
| Agent cards | Collect subagent results | Hand a parent the results of children that outlived its turn, once per turn. |
| Board | Board reorder | Seconds between re-sorts of closed folders and projects (`off`/5/15/30/60 presets). A project you have open keeps its slot. |
| Board | Hover anchor | The card the pointer moves over keeps its screen position while others grow; the seconds are how long it lingers after the pointer stops. Off falls through to the next rule. |
| Board | Touched anchor | The card you last clicked, focused or typed in keeps its position for its own number of seconds. Off clears that signal. |
| Board | Flash time | How long the green (and grey) row flash, the project outline and the landing ring last. `0` turns them off. |
| Board | Grey flash | A row that was re-read with nothing changed flashes grey. Green — a sign of life — always flashes. |
| Board | Flash on events | An event about the worktree (a console line, a job starting or finishing, an approval) counts as life and flashes the row; off, the ring still restarts but the board does not pulse. |

**Written to the gateway's `config.yaml`** (the gateway re-reads them; a row whose file is not reachable from this
machine is disabled, and its note gives the reason):

| Row | What it writes |
| --- | --- |
| Approval window | `approvals.timeout` — how long a permission prompt waits for you before it fails closed. Presets: 2 min … 1 h. |
| CLI session list | `sessions.list_limit` — how many sessions `/sessions` and `/resume` list in the CLI. Nothing is deleted; only the view changes. |
| OpenRouter URL | `model.base_url` — the endpoint the next run talks to. A run already in flight keeps the one it started with. |
| OpenRouter key | `model.api_key`. A stored key is never shown back: the field says only that one is set and its last four characters. **clear key** falls back to `OPENROUTER_API_KEY` in `.env`; **default URL** restores the stock endpoint. |

Every gateway write re-reads the file and refuses the change if the file does not say what was asked, and it edits
only its own line so your comments and formatting survive.

---

## Keyboard and mouse

| Gesture | Where | Effect |
| --- | --- | --- |
| `Enter` | Spawn prompt | Spawn the agent. |
| `Shift+Enter` | Spawn prompt, reply box, question answer | A newline instead of sending. |
| `Up` / `Down` | Spawn prompt, reply box | Walk earlier prompts for this thread/board. |
| `Enter` | Reply box | Send — or **steer** when the turn is running. |
| `Alt+Right` / `Alt+Left` | During NOT-RUNNING | Skip forward / go back. |
| `Ctrl+,` | Anywhere | Settings. |
| `Esc` | Anywhere | Close what is open: an artifacts list, Settings, a maximized card, a clone row, or a folder filter. |
| `Ctrl+wheel` | Over a console or a thinking block | Size that text for that card; anywhere else it zooms the page. |
| `Ctrl+` / `Ctrl-` / `Ctrl+0` | Anywhere | Page zoom in, out, reset. |
| `Ctrl+[` / `Ctrl+]` | Anywhere | Collapse / expand the whole tree. |
| Click | Worktree row | Open its detail (merge state, liveness, agents, sessions). |
| Click | Project or folder title | Open or close it. |
| `Ctrl+click` | Project title | Give it a theme colour; again re-rolls. |
| `Ctrl+Shift+click` | Project title | Clear its theme colour. |
| Click | Row's `⧉ N` badge | Open the row and jump to its agents. |
| Click | Row's ring | Read that worktree now. |
| Double-click | Model on the usage strip | Model picker. |
| Click / right-click | `used/ceiling⌄` | Cycle the context ceiling / open the full picker. |
| Click | `📄 N` / `🔗 N` | Open the file or link list. |
| Click | Turn head | Open or fold that turn. |
| Click | `☆` on a turn | Pin the turn above the paged turns. |
| Click | Tool group row | Filter the group to that tool (`all N` clears). |

---

## What updates, and when

| Cadence | Covers | Default |
| --- | --- | --- |
| Liveness | The evidence chips on every row — no git involved | every 5 s |
| Active rows | Branch, tip, ahead/behind, dirty, last commit on a live, dirty or unmerged row | every 5 s |
| Dormant rows | The same fields on merged / no-commits / clean-on-main rows | every 30 s |
| Verdict / PR / commit detail | The expensive per-row fields | every 60 s |
| Fetch | `git fetch --prune` per project | every 10 min |
| Client resync | Full snapshot fallback (also every 30 s if the stream goes quiet) | every 30 s |

Rows flash when something moved: green for a sign of life or a row that moved up the order, grey for a re-read with
nothing new. The number in **Life / next read** is time since the last evidence; the ring fills toward the next read
and turns amber/red if a row is overdue — a long ring usually means the panel is busy, not that the row is stuck.

Configured in `config.json` (`liveSeconds`, `worktreeSeconds`, `dormantSeconds`, `slowSeconds`, `fetchSeconds`,
`refreshSeconds`), and the footer prints the values in use.

---

## When something looks wrong

| Symptom | Check |
| --- | --- |
| `api: down`, or a spawn answers 503 | The gateway is down or `API_SERVER_KEY` is missing from `$HERMES_HOME/.env`. Start it with `hermes gateway restart`; the New-agent header says which of the two it is. |
| The agent works in the gateway's directory instead of its worktree | The gateway is missing the local patch (`docs/hermes-runs-api-knobs.diff`, lost after `hermes update`). The gateway chip's tooltip says `the gateway ignores per-run cwd`. |
| No usage strip above a reply box | Same missing patch: no `run.usage` events, so the panel shows nothing rather than zeros. |
| A verdict badge stays empty (grey) | It is computed on the slow pass; **Refresh now** forces one. A dashed grey badge is a verdict being reclassified. |
| Rows stop moving | The page may be paused, or the stream `reconnecting…`/`offline`. **Resume** or **Refresh now**. |
| A worktree will not delete | An agent run is live in it — stop the run first. |
| `revive` is refused | That session already has a card on the board. |
| A console result is cut short | The run stream carries a preview, not the full payload. See the README's troubleshooting section. |

More in the [README](../README.md#troubleshooting) and [SETUP.md](../SETUP.md). The panel's internals — how rows are
produced, what each route does, the gateway protocol — are in the README.