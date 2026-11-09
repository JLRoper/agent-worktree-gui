# Using the board

The main page is a board of git worktrees with one card per Hermes agent conversation. It is meant to be read
top to bottom: what the panel is doing at the top, the two fixed cards (start an agent, the agents with no
worktree of their own), then every project and its worktrees, then the agents working inside them.

Open the URL the panel was started on — `http://127.0.0.1:7331` by default (`port` in `config.json`). It binds
loopback only unless you change `host`, and it has no login: keep it on `127.0.0.1`.

The page is read-only towards git except for **Settings → Board → Read now → Fetch remotes** and the buttons that
explicitly write (a spawn cuts a worktree, a row's ✕ removes one, the folder **+** clones a repo). Everything else
is `rev-parse`, `rev-list`, `merge-base`, `cherry`, `diff`, `status` and `log`.

---

## The page at a glance

| Region | What it is |
| --- | --- |
| Top bar | Liveness dot, stream state and rate, and the page's own controls. Sticky: it stays on screen while you scroll. |
| Banner | A message floats under the top bar, over the board, and never moves it — the board's rows stay where they were. A **red** one is a failure: it goes away by itself after **Banner timeout** seconds in Settings → Board (5 s by default, `0` keeps it until you press its `✕`), and the clock pauses while the pointer or the keyboard focus is inside the bar — the `✕` always dismisses it at once. A **green** one is a confirmation and always goes by itself after four seconds. It is bounded by the board's column, so a docked assistant rail is never covered. |
| **New agent** | The spawn form. Its header line always says what a spawn will do (a new worktree, or a run in a directory as it is). |
| **Unattached agents** | Agent cards whose directory is not a worktree on the board — or none at all. |
| **Spawn cards waiting** | A strip above **New agent**, only while the assistant has proposed workers nobody has clicked yet (see *Spawn cards*). |
| Folders → projects → worktrees | One accordion per scan root, every git repo under it, a table row per worktree. |
| Cards | Inside an expanded worktree row: the conversation, its console, its reply box. |
| Approvals dock | Bottom-right, over the board, while a request is waiting outside a card or a remote write is on record. |
| Footer | The cadences the board is running at, what each gesture does to git, and any directories skipped. |

---

## Top bar

| Control | What it does |
| --- | --- |
| ● dot | Green while the live stream is healthy and snapshots apply. Amber on `reconnecting…`, red on `offline` (the panel server is unreachable). |
| **Worktree Agent Monitor** | Click it for Settings — the same panel as ⚙ Settings, handy when the page is zoomed in. |
| Config line | Version, how many projects are being watched, the two main cadences, scan threads, bind host — and `refresh on screen only` when that refresh mode is on. |
| Stream readout | `pool 1/3 · 3 conversations · 29 events · 2.4/s`: scan workers busy, how many conversations, and the event rate arriving over SSE. |
| **🙋 Human** | Every open permission and clarify question on the board, in one rotation. See below. |
| **✧ Assistant** | Opens the assistant panel beside the board (`A` or `Ctrl+Shift+A`) — a rail by default, and a floating window for an assistant whose own **Settings** says `floating`. Its purple badge counts the open alerts; the `⧗` pill beside it counts the **spawn cards** waiting for a click, amber once the oldest has waited over two minutes. |
| **Collapse all** | Folds the whole tree in one press — every folder, project, worktree row, card and turn. The button then reads **Expand all**. `Ctrl+]` also opens everything; `Ctrl+[` folds one tier per press instead. |
| **⚙ Settings** | The Settings panel (`Ctrl+,`). **Refresh now**, **Fetch remotes** and **Live updates → Pause** live in it too, under Board. |

### The HUMAN rotation

Click **HUMAN** (or press `H`) and the panel opens the next open question on the board — a turn parked on a
permission request, an agent parked on its own clarify question, or the dock's own permission card — unfolds the
project, row and turn that own it, centres the prompt, flashes it red and its card amber, and puts the caret on the
answer control. A permission box starts on **Deny**, deliberately: a stray key cannot approve a command.

- **H** (or another press) moves to the next question; the button counts its place (`Human 2/3`).
- The red badge is how many questions are waiting on you. Zero leaves no badge at all.
- A question that is answered, expires or whose turn ends drops out of the rotation as you go.

#### A question nobody answers is asked again — hourly, as one entry

A worker parked on a `clarify` question has stopped emitting anything: no event, no turn to end. It is the one
waiting state on the board that is invisible by its own silence, so the panel keeps asking on its own clock — not
on a turn, and not on every sweep:

- an hour after the question parked, the panel **asks again**; while it stays unanswered, once an hour after that;
- the question is the SAME one. Its box gains `↻ asked again N× · still unanswered`, its alert gains
  `↻ asked again N×` and moves back to the top of the list, and `HUMAN`'s title says how many open questions have
  been asked again. Nothing is re-posted to the gateway — the run is still parked on that prompt, and posting the
  question again would be a second question;
- there is **one entry per question**, everywhere: one alert, one room message, one row in the rotation. The count
  is a field on the entry (`reasks` on the question, `asks` on the alert), never part of its identity — which is why
  an ignored question is overwritten in place instead of piling up;
- the wake is your **question** rule's setting: at `alert` (its default) the entry is raised and counted quietly; at
  `wake`/`act` the assistant also gets one reminder an hour, which the hourly budget cannot refuse;
- answering closes it: the next sweep finds no question and there is nothing left to raise.

The old **NOT-RUNNING** rotation, and its `Alt+Right` / `Alt+Left` steps, are gone. The stopped-agent pills on the
cards are unchanged: the amber `not-running` pill still resumes that agent, and the green **▶** on a worktree row still
probes every stopped agent in it.

### The aggressive profile

**⚡ Aggressive** is at the top of an assistant's own **Settings** sub-pane (the assistant's tab → **Settings**), not
in the top bar. It is one switch for one mode, drawn for whichever assistant's tab is on screen — its state is the same
whichever assistant you are looking at. Its pill reads `on`/`off`, so the state does not depend on colour, and
`Alt+Shift+A` throws it from anywhere. While it is on it holds the waking, monitoring and acting settings; the controls
it holds are greyed and marked **held**, and switching it off puts your own values back exactly. Press it twice and the
no-op note says so.

### Renaming an assistant

An assistant's own tab has its own **Settings** sub-tab, and the first row there is **Its name**: a text box seeded
with the current name, **Save name** and **Cancel**. Save writes the name on that assistant's **record**, the same
file its role and rules live in, and its tab label and the panel's header repaint at once, with no reload. Cancel
puts the stored name back in the box and leaves the record alone.

The name is trimmed, capped at 40 characters, and a name that is empty or only spaces is refused with a line under
the box rather than silently ignored. Two assistants may share a name; what tells them apart is the id
(`assistant-2`, `assistant-3`, ...), and a rename never changes it, so it moves nothing: not the assistant's queue,
not its thread, not its charter file and not its state directory.

### A hard restart of one assistant

Its **Settings** sub-pane (its tab -> **Settings**) carries **Hard restart**, the one control there that throws context
away on purpose. The first press only **arms** it: it becomes **Cancel** and **Are you sure? Start a fresh thread**,
and nothing is sent. The second press clears that assistant's carried thread and starts it on a fresh one. The thread
id is the gateway's session id, so the next turn is the first turn of a new session and none of the old conversation
comes with it.

Nothing else is cleared or restarted. The queue, the watches, the charter, the rules, the settings and the alerts stay;
the panel and the gateway are not restarted, and no other assistant's thread or context is touched. The old thread
is kept on the record (`previousThreads`) so its turns are still read as that assistant's rather than as a worker's,
and its transcript stays in the panel's job store under the thread it ran on. A turn that is still running blocks the
press - stop it first; the thread never moves under a live run. **Cancel**, a change of tab, or closing the float puts
the single button back, and the row says in words what the last press did.

---

## Starting an agent

Everything happens on the **New agent** card.

| Field | Meaning |
| --- | --- |
| Prompt | The first turn. `Enter` spawns, `Shift+Enter` adds a line, `Up`/`Down` walk the prompts you have spawned before. Paste or drop a file into it to attach that file (see below). |
| **start in** | The directory. Usually filled in by aiming, but you can type any path. |
| **project** | Which project the work belongs to. Changing it points **start in** at that project and re-ticks **create workspace** — the picker is not a display field. |
| **model** | `(default)` uses the gateway's configured model. The list is what the provider advertises, grouped by provider, and each row carries the price per million tokens in and out, the context window, and a 0-10 Artificial Analysis rating where a benchmark has scored it — click the field to open it, type to filter, `Enter` takes the highlighted row. The assistant's own model setting and a card's model readout open the same list, from the same one price table. A model nothing has priced or scored shows no columns, not a zero. |
| **reasoning** | Per-agent effort: Hermes default, Off, Minimal, Low, Medium, High, Extra high, Maximum or Ultra. Default does not override Hermes settings; Medium is a useful starting point for quicker routine follow-ups. The choice survives panel restarts and is sent again on replies. Models may clamp unsupported levels. Disabled if the gateway does not advertise per-request model options (or the panel needs restarting). |
| **budget s** | The run's wall-clock budget (`1800` by default). |
| **max turns** | Optional ceiling on turns; blank means the gateway's own default. |
| **skills** | Disabled: a run does not carry a skills list yet. |
| **create workspace** | Ticked: cut a new worktree and branch under `.worktrees/` and run there. Unticked: run in **start in** as it is. |
| **Spawn agent** | Starts the run. The card says the run id and the worktree it made. |

The dim line under the card title is the promise: **run · new worktree under `…/.worktrees/` · project X** when a
workspace will be created, or **runs IN `…` (no new worktree); edits land in that tree** when it will not. That is
the line to read before clicking. The old disabled YOLO option is gone: this gateway exposes no per-run approve-all
setting, so changing reasoning does not change approval policy or bypass prompts.

### Aiming the card, and starting in place

- **The green + on a project** — "start work in this project": points **start in** at that project, ticks **create
  workspace**, puts the caret in the prompt, scrolls the card into view and flashes its border. A fresh worktree
  under `.worktrees/` will be cut.
- **The + bar in a worktree's agents** — start an agent in that tree as it is, without leaving the row. Clicking
  the bar goes nowhere: it becomes a text field of the same footprint, so the row does not move. Type the first turn
  and press `Enter`; `Esc`, or leaving the field empty, puts the `+` back. The prompt is handed to the New agent card
  aimed at this worktree with **create workspace** unticked, and the run starts from there, so the card says
  `runs IN …`. The bar sits under the cards and is drawn even when the row has none — which is exactly when it is
  needed. If agents already work in that tree a dialog warns that they share it (index locks, and each sees the
  other's edits as its own dirty files); saying no keeps the text you typed.
- **The green ▶ beside a worktree's name probes; it does not start anything.** It sends
  `Continue if you can, exit if you are done` to every agent in that worktree that is not running, all at once, and
  the banner reports `probed N not-running agents in this worktree` (plus `· N failed to send` when some could not be
  reached). An agent that is mid-turn is skipped on purpose: a reply to it would queue behind its turn instead of
  arriving as a probe. With no agents in the tree, or with every one of them already running, it says so and sends
  nothing.

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

### Spawn cards

The assistant proposes a worker by writing a `SPAWN` line; with `create worktrees` set to **ask** (the default)
that line becomes a card, and **nothing has started** until you press its Start button. A card is not an agent:
it has no job, no row and no card on the board, so it is shown where you cannot miss it:

- **The strip at the top of the board** says `N spawn cards waiting`, one row per card, oldest first. A row shows
  the tree it would use, the prompt the worker would be given, how long it has waited, **Create worktree & start**
  (or **Start worker there**, for a card aimed at a tree that already exists) and **Open card**. Pressing Start is
  the same action as the button inside the assistant panel; nothing here starts by itself, and a refusal (a dirty
  tree, an unknown project, the gateway down) is printed on the row in red while the card stays for a retry.
- **The header's ✧ Assistant button** carries two counts: the open alerts, and a violet `N spawn` pill for the
  cards. Both are read at the scope the Alerts tab is showing — **All assistants**, the default, counts the whole
  board. The pill turns amber once the oldest card has waited more than two minutes. **Review in Alerts** in the
  strip opens the panel on its Alerts tab with the card in view.
- **The Alerts tab** draws spawn cards first, under `spawn cards waiting`, before the other alerts. Its chips across
  the top — **All assistants** first and on by default, then one chip per assistant — narrow the list, the two counts
  on the tab, the header's ✧ Assistant button and the spawn strip itself to a single assistant. An alert fired by a
  turn of an assistant's own thread is that assistant's, and Assistant #1's alerts are stamped like every other's;
  a record written before the split carries no owner and is resolved from its thread at read time, falling back to
  Assistant #1. **All assistants** hides nothing and is always one press away.

Two minutes is a watched deadline, not just a colour: a card still open raises **“spawn card unclicked for 2m”**
(naming the turn that proposed it and the first 60 characters of its prompt) so the assistant sees it in its own
digest; and a turn whose `SPAWN` line produced *neither* a worker nor a card is journaled as a lost line and
alerted the same way. Both are rules in **Settings → Per-rule escalation** (`spawn card not clicked`, `lost SPAWN
line`), so either can be raised to a wake. To clear a card without starting it, open it and press **Discard** —
that is the only thing that cancels a proposal.

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
- **All / 7d** - toggles between every project and only those whose last commit is inside the panel's window
  (7 days by default). A repo past it is on the hourly stat gate, so the 7d view is exactly the set the board
  reads on its scan cadence; the rest are checked once an hour by one signal read - the worktree's newest mtime
  plus a handful of `.git` files - and read when something moves, or when you open one. The chip count says how
  many are hidden.
- **Collapse all / Expand all** — folds or opens every project inside that folder, not the whole board.
- **+** — the folder's own row, with two actions. **Clone via ssh** clones a GitHub repo over SSH into that folder:
  type `name` or `owner/name` and press `Enter` (or click the button); `Escape` closes the row. The owner defaults to
  `cloneOwner` in `config.json`. **New local project** makes a brand-new repository in that folder instead: `git init`
  on `main` plus one `README.md` commit, so the folder is a project the board can read and spawn from — an empty
  repository with an unborn HEAD scans as `NO BASE REF` and refuses every spawn. Refusals (a name that is not one path
  segment, a folder that already exists, a folder that is no longer a scan root) print in the row and leave the cursor
  in the name box. Either action shows up on the board from the snapshot the panel broadcasts, with no reload.

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

**The host chip** (`host: sefl-bitbucket IT/email-multi`, or `no host`) says where this project's branch and PR links
go. Click it and the panel reads the project's own remote and offers the mapping that remote implies — the host id and
the coordinates — with **Use this mapping** to write it and **Cancel** to keep what is there; a project nobody has
mapped says `no host` and offers the strip the same way. Nothing is written until you press the button, and a remote
the panel cannot read is refused with the reason rather than guessed at. The tokens and the file behind it are in
[docs/hosts.md](hosts.md).

**Project colours.** `Ctrl+click` a project's title line to tint that project with a random hue; `Ctrl+click` again
rolls a new one; `Ctrl+Shift+click` clears it. The hue tints only the project's own surfaces (box, title row, column
header, row hover), so it answers "which project is this" and never changes what a badge means. A plain click still
opens and closes the project. Settings → Display → **Project colours** shows how many are coloured and resets them.

### The worktree table

Rows are the trees this project **owns**: its own checkout and the worktrees inside its folder. `git worktree list` answers for the whole *repository*, so a tree of the same repo that sits somewhere else on disk — a scratch comparison tree a landing run cut, a tree checked out beside the project — is in git's answer but is **not** a row here: it is left out of the header counts, the UNMERGED arithmetic and the merge / rename / delete controls, which belong to this project's work. The project record's `outsideTrees` in `/api/state` and a line in the panel log say how many the last discovery left off, so the exclusion is inspectable rather than silent.

| Column | Meaning |
| --- | --- |
| **Worktree** | The directory name, a green **▶** that **probes** the agents already in it (see below), and the `⧉ N` badge for agents this panel has in it (with `running` / `awaiting approval` when they are busy). Clicking the badge opens the row and its cards; the **+** bar in the row starts a new agent there. |
| **Owner** | The assistant that **controls** this worktree, as a compact tag: `M1` for Manager 1, `M2` for the second Manager, `CR2` for the second Code Reviewer, `A1` for a row the panel could not label. A tag rather than the assistant's name because the column answers "whose tree is this" beside ten others, so `Assistant #2` would cost a column of width to say two characters; the cell's tooltip carries the long form — `M2 — Assistant #2 (Manager 2) owns this worktree. Display only…` — and the row's detail keeps the same fact as its own line, `Controlled by: Assistant #2 — Manager` (the name, then the role it runs). The panel resolves the number and the role from that assistant's record on every read, so renaming a role renames the tag with it. **The column hides itself while it has nothing to say**: every tree on Assistant #1 and no second assistant on the board is a column of identical `M1`s, so it is not drawn — and it comes back on its own the moment a tree is given to another assistant (or a stored owner has been removed, which falls back to Assistant #1 and says so on the row). Its switch in Settings still turns it off for good. Display only in this version: it does not change who wakes or runs. |
| **Branch** | The checked-out branch. A link to the branch's page on its host when the remote actually has the branch; plain text with a `local` chip when the remote answered its head list and this branch was not in it, and the reason in the tooltip. When the remote could not be reached the cell is plain text with an `unverified` chip and a tooltip that says how far the panel got ("cannot tell whether the remote has this branch yet", or "not on the remote as of the last fetch" when its refs were checked) and then quotes the project's last fetch failure — so a row the panel could not check is visibly not the same as one nobody ever pushed, and the reason is on the row. A chip is never drawn on a row the last fetch's refs did resolve to a page. "unknown" is not "local". The link follows the branch: a tree that switches or renames its branch is read again and wears the new branch's page and PR, not the old one's. |
| **Tip** | Short SHA of the branch tip. |
| **Ahead / Behind** | The branch against its **own copy on the remote**, counted the way `git status` counts it: `↑N` is commits here that the copy does not have (not pushed), `↓M` is commits on the copy that are not here (not pulled). The side with work to do is lit (↑ amber, ↓ blue), a side with none is dim, and `↑0 ↓0` is level. When there is no copy to count against the cell is a word: `—` the branch has no copy on the remote (never pushed; a worktree cut from `origin/main` tracks main until its first `git push -u`, and main is not its copy), `gone` the copy was deleted (a merged PR's branch usually is), `?` the remote has a branch of that name but this tree is not set to track it (the tooltip gives the `git branch -u` that fixes it). The counts are as of the last fetch: a dotted count with a `?` after it was taken while the project's last fetch was failing, and the tooltip quotes the failure. The count against the project's main — what the verdict is built from — is in the verdict's tooltip (`Against origin/main: 3 ahead, 1 behind.`) and at the end of this cell's tooltip. A page served by a board process older than the page draws the old numbers as `N / M` with a tooltip that says to restart the board. |
| **Cherry** | `+N/−N` from `git cherry`: `+` commits with no equivalent upstream, `−` commits already upstream by patch id (the evidence that a squash or rebase landed them). |
| **PR** | `#123 OPEN` / `#123 MERGED`, or `none` when this branch has no pull request. The number is a link to the pull request's own page on the project's host; it stays plain text (with the reason in its tooltip) when no page can be built. Hover it for the title. A branch whose copy is gone from the remote is answered by the **Branch** column beside it — plain text instead of the blue link, with the `local` chip — so this cell does not repeat it: `none` is the whole answer. |
| **Dirty** | Modified files, and `+N?` untracked, or `clean`. |
| **Life** | Time since anything last said this worktree is alive, then the evidence chips (`⧉` a hermes session, `●` a board PID, `:port` a dev server, `✎` files edited). |
| **Next read** | A ring that fills toward the next scheduled read, with the figure beside it: `4s` while the read is owed and the lateness once it is past (`12s`, the ring amber, then red). The wording is in the cell's tooltip; click the ring to read the row **now**. |
| **Verdict** | See below. |
| ＋ | Cut a **child worktree** from THIS row's branch: a new tree on a new branch cut from it, on its own row, which the child's `UNMERGED` chip then rolls back into this branch. Asks for an optional name (empty = the branch's last word) and always keeps its own `-<hex6>` tag. Not offered on the project's own checkout (a child of the landing branch has nothing to roll into) or on a detached row. Starts nothing and pushes nothing. See [Cutting a child worktree off this branch](#cutting-a-child-worktree-off-this-branch). |
| ⟳ | Reconcile this one worktree now: re-read its git state, then its TODO list and its description against what the tree now holds (see **Reconciling one row** below). Not offered on the project's own checkout row. |
| ✕ | Remove the worktree (not offered on the project's own checkout row). |

**Column widths are measured, not fixed.** Each column is sized from the widest thing it actually holds — its
header, the longest branch name, the chips on a row — so the columns that say little (`Cherry`'s `+0/−0`, `PR`'s
`none`) stay narrow and the room they gave up goes to the two columns whose text truncates: **Worktree** and
**Branch**. In the worktree cell the name is what ellipsizes; the agent badge and the evidence chips keep their
whole width, so what a row is doing is never the part that gets cut.

Drag the edge between two column headers to set those columns by hand: the pair trades width, so the rest of the
row does not move. The choice is remembered in this browser and applies to every project. **Double-click** any
column edge to hand the board back to the measurement.

**Any column can be turned off.** Settings → Board → **Chart columns** has one switch per column, and every switch
starts ON. The **Owner** column is the one that can be on and still not drawn: it hides itself while every tree is on
Assistant #1 and no second assistant exists (a column of identical `M1` tags), and the row's own sentence says so
beside the count, so a ticked switch over a missing column is explained rather than read as a bug. Hiding one removes
its header and its cell from every row — the rows are built from the same list, so a table never has a header without
matching cells — and the width it gave up goes to the columns that remain, which is also how a narrow window stops
needing the sideways scroll below. The choice is the panel's, not the tab's: it lives in this panel's `config.json`, so
every browser draws the same chart and a restart keeps it. **show all** puts every column back; the switches never take
the last column away.

**A narrow window squeezes the chart; it never clips it.** With every column on, the chart is planned to whatever width
the card has: the columns that read the same at any width give their room up first, a column the reader sized by hand
keeps its width, and when even the floors no longer fit the whole split scales down — cells ellipsize (a branch, a
verdict, the worktree's name) or wrap (the evidence chips) rather than running past the card. A fixed-layout table can
never be narrower than the sum of its column widths, so a plan that rounds up would be a table that outgrows its card;
the widths are normalised to the card exactly for that reason. The page's one horizontal scroll container is `main`,
so an overflow that ever did happen would be reachable there instead of being cut at the card's edge — and opening the
assistant rail, which takes 340-640px from the board without resizing the window, re-plans every table at once
(`main`'s own box is what is watched).

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
| `MERGED (N commits)` | The branch carried commits of its own and they are in remote main. `MERGED (squash/rebase, N commits)` is the same claim proved by patch id instead of ancestry; `MERGED (content identical)` says the branch's tree already matches main. All three require a `commit:` line in the branch's own reflog: a branch that never made a commit is never said to have been merged. |
| `NO COMMITS` | The branch never committed anything of its own. That is a pristine branch nobody touched, and equally one that was only pointed at main — a fast-forward, a reset, a re-cut — because moving a branch is not merging it. Nothing to land, nothing was merged; on a clean, idle tree it is offered for removal, since there is nothing on the branch to lose. `NO COMMITS?` means the reflog is missing or expired, so the panel cannot tell whether the branch ever moved and will not claim it did. |
| `ON MAIN` | This is the primary checkout of the main branch. |
| `UNMERGED (N commits)` | Carries `N` commits that are not on remote main. On a clean tree the badge **is a button** (`⇥` on its face): it opens five outcomes for that row — roll it into its parent, **rebase it onto its parent's newest commit**, open a PR, have an agent **check whether the change is already on main** (which deletes the tree when it is), or ask where it should go. See [Merging a branch from the board](#merging-a-branch-from-the-board), [Rebasing a branch onto its parent](#rebasing-a-branch-onto-its-parent) and [Checking whether a branch already landed](#checking-whether-a-branch-already-landed). |
| `EMPTY REPO` / `NO BASE REF` | There is nothing to judge against: the repo has no commits yet, or its remote base ref does not exist here. |
| `RELEASED` | The row's path is not a worktree of its own any more. A release can leave the folder behind, and `git -C` in it does not fail: it walks up and answers for the project's own checkout — its branch, its head, *the reader's* dirty files. So the row carries **no counts at all** (the dirty cell shows `—`, never `clean`), and its tooltip says which checkout git would have answered for. It is not counted as unmerged work: nothing is there to merge. |
| *(empty, grey)* | Not computed yet. A dashed grey badge is a verdict being reclassified after a change. |

`MERGED` + clean + not live is what the project's **safe to remove** chip counts.

### Merging a branch from the board

A clean `UNMERGED (N commits)` badge is a button; the `⇥` on its face is the whole affordance. One press starts a
Hermes agent **in that worktree**, named `MERGING into MAIN` (`MERGING into MASTER`, or whatever the project's base
branch is called — the label is set the moment the run is created, so the card says it before it draws), whose only
job is to land the branch:

- it re-reads the tree and stops if anything is modified or untracked;
- it tries `git merge --ff-only` in the project's own checkout, so a branch that is simply ahead cannot lose a line of
  what the base already has; a base that moved on is handled by rebasing the branch and retrying, or by a real merge
  commit in a repo that keeps them — conflicts are resolved by keeping both sides, never by dropping the base's code;
- it proves nothing was lost (`git diff --diff-filter=D` against the pre-merge sha) and will not leave a merge that
  deleted a file the branch itself did not delete;
- it runs the repo's own unit, integration and Playwright tests — Playwright against a server **it starts on a free
  port of its own** (or a compose project named `wtgui-merge-<stamp>`), never this panel's port and never a server it
  did not start;
- it pushes only when the tests pass, and stops every server, container, network and volume it started before it
  writes its report.

The button is only drawn while the tree is clean. A row with modified or untracked files keeps the plain badge and its
tooltip says what to do first — a merge agent commits what it finds, so a half-finished tree would land somebody
else's work. A row that already has a merge agent working it draws a disabled `MERGING into …` chip whose tooltip
names the agent. The route (`POST /api/worktree/merge {project, path}`) refuses all of those cases again from git, so
a board that is a scan behind cannot start one by accident; `{dryRun: true}` returns the prompt without starting
anything, and the script itself is `lib/merge-prompt.js`.

### Cutting a child worktree off this branch

The **＋** at the right-hand end of a row (left of the ⟳ and the ✕) cuts a new worktree **from that row's branch**, so
the panel can make the parent a roll-up needs. One press asks for a name — optional, empty means "name it after the
branch's last word" — and then:

- `git worktree add -b wtgui/<slug>-<tag> .worktrees/<slug>-<tag> <the row's branch>` in the project's checkout, with
  the start ref **stated**: the cut is from the branch, never from the checkout's HEAD;
- the cut is written down where the roll-up reads a parent from (`logs/parents.json`: `parentSource: "cut"` and the
  tip the parent resolved to at that moment), and the name is settled in the naming ledger, so no later run's title
  renames it;
- the tree is boarded at once — it is a row with its own ＋ / ⟳ / ✕ in the same breath as the banner — and **nothing
  is started in it, nothing is pushed, and the parent's tree is not touched**.

It is not offered on the project's own checkout (a child of the landing branch has nothing to roll into — use the
New-agent card for that), on a detached row, or on a branch the panel calls main. A second press is a second child:
every cut carries its own six-hex tag. Route: `POST /api/worktree/child {project, path, name?}`.

### Rolling a child into its parent

The `UNMERGED` chooser's first outcome. It merges the child into **the branch it was cut from**, inside that branch's
own worktree, and it is the one landing in the panel that writes neither main nor the remote:

- `git merge --ff-only <child>` in the parent's worktree — the normal case for a child that stayed current, leaving
  **no merge commit**; if the parent has moved on, `git merge --no-edit <child>`, a real merge commit;
- a **conflict is an abort**: the parent's tree is put back exactly as it was and the banner names the merge that
  conflicted. Nothing is half-merged and nothing is reported as rolled;
- the parent's tree must be **clean** and **on its own branch**, the parent must be a **recorded cut** (never a guess),
  never a main branch, and it must be **checked out in a worktree** — otherwise the refusal says which of those failed;
- two rolls into one parent are serialised, so the second waits for the first.

What it does **not** do: no agent, no push, no PR, no delete, and no rewrite of the child — the child's tree, branch
and tip stay exactly as they were. Afterwards the parent's row moves to the new tip, but the child's row still reads
`UNMERGED`: the verdict counts it against `origin/main`, and the roll only put its work on the parent. The steward's
plan (`POST /api/steward`, which writes a plan and acts on nothing) then reads the rolled child as landed in its
parent and would offer to delete its tree.

Route: `POST /api/worktree/rollup {project, path, parent?, confirm}` — without `confirm` it answers **428** with the
parent it would write into and rolls nothing. The worked example, with a fast-forward, a conflicted roll and a merge
commit from one test instance, is [child-worktrees-and-rollups.md](child-worktrees-and-rollups.md).

### Rebasing a branch onto its parent

The chooser's second outcome, **Rebase on `<parent>`**, is the one that starts no agent. `git rebase <target>` is a
single deterministic command that reports its own outcome in about a tenth of a second, so the server runs it directly:
no run, no gateway, no bill. It writes **exactly one branch** — the one checked out in that worktree. The parent, the
base branch, the remote and every other worktree's index are untouched, and nothing is pushed. Catching a child up to
its parent is also what makes a later roll a fast-forward instead of a merge commit in the parent.

The button names the ref it would replay onto: the recorded parent when the panel has one, otherwise the ref the board
already measures the branch against (`origin/main`). That is a label, not the decision — the route picks the target by
**proof**, and its answer names the ref it actually used:

- a candidate ref is accepted only when every commit the replay would move belongs to this branch alone. One
  `rev-list <merge-base>..HEAD --not <every other local branch>` per candidate buys that, and the first-parent spine
  decides which shared commits are inherited history (a wrong target would replay them as new work) rather than a side
  branch this one merged on purpose. A ref that fails is refused by name — `replaying onto main would carry 1 commit
  this branch does not own (feature/parent)` — because that history belongs to another branch;
- a branch that already contains the target's tip is refused with the sentence rather than "rebased" over a no-op;
- a branch carrying merge commits of its own is replayed with `--rebase-merges`, so the resolutions somebody did by
  hand are not flattened away.

The route refuses, in sentences, a tree that is on the base branch itself, a tree with modified or untracked files
(the replay would carry unfinished work), a locked tree, a branch with no commits of its own, a rebase already open in
that worktree (`git rebase --continue` or `--abort` first), and a second replay of the same branch while the first is
running. A **conflict is an abort**, not a half-rebased tree: the tree was clean when the replay started, so the abort
puts it back byte for byte and the banner names the colliding paths. A branch with its own copy on the remote has just
had its shas rewritten, so the popover's note says before the press that the copy will need a force-push, and the
banner repeats it afterwards. After a successful replay the row is re-read so the board shows the new tip, not the one
the scan drew before the press.

The route is `POST /api/worktree/rebase {project, path}`; `{dryRun: true}` answers with the plan (target, commits to
replay, why) and writes nothing, and the engine is `lib/rebase.js`.

### Checking whether a branch already landed

The `UNMERGED` count is a count of **commits**, not a verdict on content: a branch that landed by squash, rebase,
cherry-pick or a hand-rewritten patch keeps commits of its own while main holds the change under another sha, so it
reads `UNMERGED` forever. The chooser's check outcome answers that. **Check whether it is on main** (or `… on
master`, or whatever the project's base branch is called) starts a Hermes agent in that worktree, named
`CHECKING MAIN`, and it reads only:

- it reverse-applies the branch's own patch to a pristine `git archive` export of the base, under the OS temp dir. A
  patch that reverses cleanly is content the base already has, whatever the sha or the subject says — which is the
  one test a squash merge survives;
- it corroborates with `git cherry` (patch ids), `git diff --quiet` for an identical tree, and `git cat-file -e` for
  every file the branch adds: an absent file is what settles a half-landed branch;
- it answers in one line, on its own: `LANDED: YES`, `LANDED: PARTIAL`, `LANDED: NO` or `LANDED: SUPERSEDED` (the base
  delivers the same behaviour another way — that is not landed, and it deletes nothing);
- on `LANDED: YES` the panel moves the worktree's folder to the Windows Recycle Bin and prunes git's record of it,
  exactly as the row's ✕ does. A **locked** tree is refused with the lock named, a tree with modified or untracked
  files is refused with that reason on the card, and a tree an agent is still running in is refused too;
- every other answer deletes nothing, and the card's console carries the word the agent read and why.

The agent writes nothing: no commit, no stash, no checkout, no push — a dirty tree is reported, never tidied. The
route (`POST /api/worktree/verify-landed {project, path}`) refuses a tree that is on the base branch itself, a branch
with no commits off the base, and a second check in the same tree; `{dryRun: true}` returns the script without
starting anything, and the script is `lib/verify-prompt.js`.

### Opening a row

Click a row to expand it. The detail is built not to bury the agents:

- **Release** — one line at the top of the detail, drawn only on a tree a worker asked to release:
  `⇢ release removed 3m ago · run ab12cd34 · <why it said it was finished>`, or `⇢ release refused: the tree is not
  clean (1 changed path) …`. A worker can never remove its own worktree — its shell is inside it, and Windows keeps a
  busy directory — so it ends its turn with one `RELEASE <tree> | <why it is finished>` line. The panel records that
  request on the row and decides it AFTER the turn has settled, from its own git and `gh` reads: the tree must be
  clean, the branch's PR must read **MERGED**, nothing on the branch may be missing from that merge commit, and no run
  may still be holding the tree. A tree that never had a PR — a documentation or review tree that carries nothing main
  does not already have — is accepted the other way: no pull request is recorded for the branch **and**
  `git rev-list --count origin/main..HEAD` is 0 (or, when that count cannot be read, `git diff origin/main HEAD` is
  empty), with the same clean-tree, registered-worktree and no-run-holding gates. A branch that *is* ahead of main with
  no merged PR is still refused, and says so. Only then does it remove the worktree, delete the branch locally and on
  the remote, and write `removed` (or `refused: <the gate that said no>`) back onto the row. With the project's
  `releaseWorktrees` off — the default — every request is refused with that reason and nothing is touched.
  Settings → Board → **Agents clean up** is the switch above all of that: off, no prompt carries the `RELEASE`
  paragraph, every request is refused with that reason, and a check agent's `LANDED: YES` is only a line in the
  console. It is the row to press when you want to read the trees and remove them yourself; the ✕ keeps working
  either way.
- **Merge state** — folded to one line (`ON MAIN · branch main · 2 untracked · last commit 6m ago`). Its list opens
  with `Controlled by: Assistant #1 — Manager` — the assistant that owns this tree by its name, then the role it
  runs, with the fallback sentence when the owner it names is no longer on the board. Under that line is the rest:
  ancestor of remote main,
  cherry counts, branch reflog, whether the branch ever carried its own commits, the remote branch, and then
  **every commit not on remote main** — one per line, short sha and subject, the full width of the row, all of them
  however many there are (the list extends and the panel scrolls; nothing is clipped)
  — under a heading carrying the diff summary. **Modified** and **Untracked** sit under that as one-line strips with
  their counts: open either one to see its file names, and each folds on its own, without moving the other or the
  strip the two of them sit in. A tree with nothing unmerged, or a clean one, shows no empty strip.
- **Liveness evidence** — folded, with its strongest line still visible on the header. Open it to see why the row is
  live, or why it is not.
- **TODO** — the worktree's list, folded to one line: the OLDEST item still open and a `done/total` count. Open it for
  every item with its status glyph and its controls (add, edit, claim, complete, drop, reopen), the journal of who
  changed what, and a **+ add** for a new item. Each item's facts — `owner`, `by`, `updated`, its note and its files —
  are folded behind the small `▸` in front of the item's line: click it, or `Tab` to it and press `Enter` or `Space`,
  to unfold that one item. A worktree's open items are remembered in this browser, so a repaint or a reload leaves
  them as you left them, and an item you never opened stays folded.
- **Agents** — the cards owned by this worktree, each moved into place rather than rebuilt, so a running console keeps
  its scroll. The **+** bar in the row starts another agent in this tree; it is drawn even when the row has no cards,
  and it sits above the cards by default (Settings → Display → **Add-agent bar at top** moves it back under them).
- **Sessions with revive** — Hermes sessions attributed to this worktree that have no card, one row each (glyph, when
  it was last used, its name) with **revive**. Reviving writes a card whose reply box continues that session. It is
  one at a time on purpose: a worktree collects every session ever run in it, and auto-attaching would refill the
  board with months of finished conversations. A revive is refused (409) if that session already has a card.

Rows sort by what is worth reading first — a running panel agent, then the most recent sign of life — and a row you
have open keeps its exact slot while the closed ones re-sort around it. Settings → Board → **Board reorder** controls
how often that happens (default 5 s; off is allowed).

### Reconciling one row

The ⟳ in a row's actions cell (left of the ✕) reconciles **that one worktree**: it re-reads it instead of waiting for
the sweep, and then checks the things the sweep cannot — the TODO list against what the branch actually carries, and
the description against the commits it has since gained. It is the same request the next-read ring sends, asked one
depth deeper (`reconcile: true` on `POST /api/refresh/row`), so there is one refresh path and not two. It does five
things, journalling each:

1. **Merge state.** `git status`, the counts against the branch's base, `git cherry`, the verdict and the PR are all
   re-read, and the row is repainted from the answer. The journal line names what actually moved — `verdict MERGED -> UNMERGED`,
   `0 -> 3 ahead`, `dirty 0 -> 2`, `PR #12 OPEN -> #12 MERGED` — or says `re-read, nothing moved`.
2. **TODO.** The tree's commits and the files those commits touched are matched against the open items (the same
   `proposeClosed` rule a finished run's harvest uses, plus the item's own `files`). A proposal is written **beside** the
   list, never into it: the TODO badge shows `N look closed`, the tooltip lists them with the evidence, and nothing is
   marked done until you press ✓. The list's own journal records the reconcile.
3. **Description.** Re-derived only when there is none, or when it shares no significant word with any commit the branch
   now carries — and never when you wrote it by hand. The panel owns that text (`lib/descriptions.js`), so a refresh can
   ask for it again but cannot invent it or overwrite yours.
4. **The agent pass.** When the cheap pass finds a mismatch it may also **offer one agent**: Settings → Board →
   **Row refresh → agent** is `never` / **ask first** (the default) / `start it`. In *ask first* a single card appears
   under the row — **not now** / **start agent**, left to right — and starting it runs one agent **in that worktree**
   to double-check the TODO, the description and the merge state and report back; its turn is marked `↳ from the row's
   ⟳`. It is refused while any run is already live in the tree (409), and it is told to change nothing — no commits, no
   push, no merge. *Never* leaves the cheap pass and its journal; *start it* skips the card. The start is its own request
   (`POST /api/refresh/row/agent`) because it spawns, the way checking a row against main does.
5. **Journal.** One line per action, kept with the row (beside the panel's other stores) and shown under **Merge state**,
   newest first. It survives a reload — a reconcile that changed nothing leaves that record too.

The ring in the **Life** column is the same read without the reconcile: click it to refresh that row's git facts now,
and the ⟳ when you are deciding whether to land or drop the tree.

### Removing a worktree

The row's ✕ asks in place: *Remove worktree `<name>` on `<branch>`? Its files go to the Recycle Bin (recoverable
there) and git's record of it is pruned.* — **Cancel** then **Delete**, left to right. While any agent run is live in
that directory the request is refused (409); stop the run first. A directory that is already gone counts as removed.

**A merged, clean worktree does not ask.** When the row's verdict is `MERGED …`, nothing is modified or untracked, and
the verdict is not stale, the ✕ deletes on the first click — there is nothing in that folder `main` does not already
have. Those ✕ are drawn grey instead of red (hover says so in the tooltip). Everything else keeps the question:
unmerged commits, any dirty or untracked file, a stale verdict, and `ON MAIN` / the project's own checkout, which is
never deleted from this table.

The files and git's record always go; whether the *folder* can go in the same click depends on what else is using it.
Windows refuses to delete a directory that a process holds as its working directory, and a worktree often is one (the
agent that built it, an editor, or a panel started from inside it). In that case the row still disappears at once and
the banner says so, and the panel keeps retrying the empty folder in the background for ten minutes — it is removed
as soon as the holder exits. A panel started from that very worktree is called out by name, because only a restart
releases it.

**A `node_modules` that is a junction is unlinked first, on every path that removes a tree.** `git worktree remove`
recurses *through* a directory link, so a tree prepared by this fleet — `node_modules` junctioned onto the project's
own checkout — used to come off the disk with the **primary checkout's** `node_modules` emptied: every entry deleted,
dot-prefixed ones first, with git reporting success. The ✕, the release a `RELEASE` line asks for, and the steward's
apply now take every link out of the tree before anything walks it, and the removal says so on its own step. A link
that cannot be unlinked **refuses** the removal instead — the tree stays and the reason names the link, because the
next thing to touch it would delete through it.

---

## Reading an agent card

### The head

| Element | Meaning |
| --- | --- |
| `⧉` and the chevron | An agent session. Click the head to fold or unfold the card. |
| Pill | `running` (hover for its clock, `· 12s`). While the agent is stopped the pill is a **button**: `not-running`, or `exited` in red after a failure, with a `↻` on its right — clicking anywhere on it sends `Continue if you can, exit if you are done` and starts the next turn. The `↻` turns while the nudge is out, and the label does not become `starting…`, because the panel cannot see that yet. A turn that ended while the subagents it started are still working still reads `running`. |
| `just now` / `2m` | How long since the thread was last used. |
| `waiting on you →` | The run is parked on a permission request — click to jump to the box. `waiting on your answer →` is the agent's own question. |
| Title | The Hermes session's name, with the worktree, run id and turn count beside it in dim text. |
| `📄 N` / `🔗 N` | Deliverables: files and links, as two separate buttons. |
| Turn pager | `▲`/`▼` and `6–10 / 23` when a thread has more turns than fit on a page. The arrows are the collapse gesture: every turn on the page you leave folds. |
| Thread name | The Hermes session id (or your label for it) — the thing a reply continues. |
| `📌` | Pin this card: it keeps its screen position while cards above it grow. One pin at a time; clicking again releases it, and clearing the thread releases it too. |
| `🧠` | Show this session's reasoning (see below). |
| `🌊` | Draw this session as **one stream**: what the agent thought (while `🧠` is on), said, called and got back, in the order it happened, with no burst to open — each run of calls is one **tool-usage group** (a rule above its rows and a rule below them, one row per call: the tool, the file and range or the command it was given, and how long it took), and each row opens the shut box that call returned. Per session, remembered in this browser — a card that never pressed it follows Settings → Agent cards → **Combined output**; off, the card is the separate thinking block and the condensed tool bursts it always was. |
| `✎` | Rename the session **in the panel only**. The Hermes thread id never changes. |
| `⤢` | Maximize the card to the window (`Esc` closes). |
| `✕` | Forget this session: the first click arms it (`✕ sure?`), the second removes its turns and transcript from the panel. The worktree it made stays on disk. |

Under every head — titled or not — is one dim line: `cwd …/project/.worktrees/<name>`, the directory the agent
actually runs in (the last three segments; hover for the whole path). When the row it is filed under is a different
folder, a `row …` chip follows it. It is a reference, not a heading: smallest size, dimmest ink.

On a **minimized** card that line is the row's identity line, and it reads left to right: the path, then the
session's name, then the card's own buttons (`📌 🧠 🌊 ✎ ⤢ ✕`). The name is the only thing that gives up width — it
truncates with an ellipsis (the whole name is in its tooltip) and never runs under the buttons, while the path keeps
a floor of its own. A card with no cwd line has nowhere to put them, so it keeps the name and the buttons in its head.

A `yolo` pill appears only if a run was started with that flag elsewhere; the panel never sends it.

### The pulse on a live card

While a turn is live the head carries a small pulsing chip, right of the `running` pill. It is the panel's
**heartbeat on that run's event stream**, not a reading of the agent's mind — the tooltip says so — and it shows
one of five honest states:

| The chip | What is true |
|---|---|
| `● thinking 2s` (green) | text is streaming: a delta arrived 2 s ago. The console line under it is growing in place — one line per paragraph, not one per token. |
| `● terminal · 4s` (blue) | a tool is running; it is named, and the number is how long ago the stream last said anything. Waiting on a command is not the same as waiting on tokens. |
| `● thinking 1m 10s` (grey) | the stream has been quiet that long. The run is still live and the panel still holds its stream; the dot keeps pulsing because the panel is still listening. |
| `● no events yet · 12s` (amber) | the run is live and the panel subscribed, but the gateway has sent **no event at all** since it started. That is a gateway not sending — not an agent thinking — and the chip says so. |
| `● polled · every 15s` (dashed) | this gateway does not advertise `run_events_sse`, so the card is read every 15 s and there is no stream to judge. Nothing here can tell you what the model is doing. |

It never carries reasoning text. A finished turn leaves no chip at all, and the age is the time since the last event
the panel actually received — never a number the panel made up.

Folded, the card keeps one line under its head: a status chip in the turn's own words — `done`, `failed`,
`interrupted`, `cancelled`, `running`, or `revived` for a turn rebuilt from the session store (which has no duration
this panel measured) — then how long it ran, then **the error when there is one**; otherwise the last thing the turn
said. `interrupted` is the one to read twice: the panel stopped tracking that run (a restart, a dead stream) and the
gateway may still be working on it, so the line says so instead of pretending the turn ended.

### Turns

Each turn is an accordion inside the card:

- `☆ turn 3 · running 12s` — the star pins that turn above the paged turns (it stays in its page as well), the chevron
  opens it, and the line carries how long it ran.
- The pager's arrows walk the thread a page at a time, newest page first (`▲`/`▼` beside `3–7 / 7`). Paging **is**
  the collapse gesture: every turn on the page you just left folds, so going up and back down leaves the thread
  closed behind you. The one thing it does not touch is a starred turn's **pinned** copy above the page — that copy is
  on screen on every page, so it stays as you left it until you click it.
- The open turn holds, in order: the thinking block (if on), the console, the subagent strip, and any approval or
  question box for that turn.
- Sending a reply draws the earlier turns the way **Settings → Agent cards → Previous turn on send** says: a
  **compact** summary — the last tool line, the answer's first lines, and one dim line saying what folded (the
  default); the turn **left as is**, its console still open above the new turn; or **minimized** to its one-line
  peek before the new turn's output is drawn. A turn you opened by hand follows the same answer, not a separate
  rule.
- A failed turn that is worth retrying (a timeout, a 5xx, a dropped connection) shows **retry** beside its outcome; it
  sends that turn's prompt again as a new turn, because the failed turn's edits are already on disk.

### The console

A reply submits a new run with the **same session id**: it continues the saved conversation, not a new agent
conversation or a gateway restart. The stored startup record says `continuing session` and names the turn and run id;
protocol bookkeeping is kept in the job data, not drawn in the console. The workspace setup note appears only on the
first turn. Every run still gets the working directory and explicit `cd`
instruction, because conversation history persists but a previous run's tool working directory need not. This is a
safeguard, not a claim that the gateway accepted or applied `cwd`.

Output streams into a `<pre>`. It follows the newest line unless you scroll up; a `↓` button brings you back and
re-pins it. A tool result is a **preview** of what the tool returned, not the full payload — when it was cut the
console ends it with `… result truncated by the gateway` (the gateway's `HERMES_RUN_PREVIEW_CHARS` raises the cap;
set to `0` on this box, so the stream carries the whole result). When the preview was empty — routine for `patch`
and `write_file` — the panel reads that call's result back out of the session store and draws it under the result
line **as text**: a patch's diff, a terminal's output, never the JSON envelope it travelled in. Each burst in a turn
pairs with its own results, so a second run of the same tool later in the turn shows its own output rather than the
first run's. A call the store has nothing for says `no output recorded for this call` — or `no output in the session
store yet` while the turn is still running.

**Every tool result is one folded box with one read control.** Whatever a call returned — a shell transcript, a
search, a file, a skill, a diff — sits under its `↳ tool · 3.27s` line. The header names the tool or file, counts its
lines and says `click to read`; a diff also says what it adds and removes (`patch · …/package.json +3 −2`). Clicking
that header opens the complete recorded output, wrapped with no inner scroll. A second click folds the same box.
The choice survives a repaint, a burst rebuild and a switch between condensed and one-stream (🌊) views.

Opening one does **not** carry the console with it. The box unfolds under the header you pressed, which stays exactly
where it was, and the console's reading position does not move — a console that is following the newest line stops
following at that press (the ↓ chip appears, and a scroll back to the end or a press on it follows the run again).
The rule is the same for every fold a card draws: a result box's head, a call's own row, a row inside a 🌊 tool-usage
group, the run's `N lines` / `all N` button, and a fold note that reads the store. Settings → Agent cards →
**Jump to an opened result** is the old behaviour — the console slides down to the end of what was just opened — and it
is **off** by default; the setting is saved in this browser.

**In the 🌊 view a run of calls is one tool-usage group.** Nothing is condensed there, so the run is drawn as a
**rule above its rows and a rule below them**, and inside it **one row per call**: the tool's glyph and name, the
target the call was given — the file and its line range (`docs/a.md L1-40`) or the command (`wc -l docs/a.md`) — and
how long it took. The `↳ tool` line the condensed view draws is not repeated: the row *is* that record, and the time
it used to carry is on the row. A call still running keeps its live clock on that row instead of a time. Pressing a
row opens **that call's box** under it, whole — one press, one box, the same box the condensed view opens — and a
press again shuts it; the open rows are remembered across repaints like every other fold. A parallel batch
interleaves its calls, and each row still opens the output of *its* call. Bursts are cut by what the agent said in
between: prose or a reasoning row ends a run, so the next one starts its own group with its own two rules.

For a long result the card's ring buffer still keeps only its **first 40 lines**, shortening preview lines past
400 characters, so one huge read cannot evict the rest of the turn. The header says `40 of 64 lines` when the total
is known, or `40 lines · preview` when a character-capped store read cannot tell. On the first open, that same header
reads **one complete result** from the session store and replaces its preview in the existing box; the count becomes
`64 lines`. There is no separate hidden-lines link, no second result box and no repeated first 40 lines. The tool
is not rerun, and the fetched text is not added to the console's own ring buffer. These are logical output lines,
not wrapped screen rows or a count of calls.

Opening a long result shows `reading the stored result…` in its header. A missing copy, empty stored text or failed
read leaves the preview intact and offers a retry there. Closing and reopening uses the cached full text while it
is retained; already-open results are not evicted just because another result is read. A parked console keeps its
reading position through the initial load and subsequent repaints. The gateway's own `… result truncated` note
still stays outside the box: it describes data that was cut upstream, not the preview this panel can read back.
A diff's framed windows (one per hunk) remain inside the one box. Copy copies visible output, so a box that has not
been opened does not contribute its hidden body. See [the original investigation and its replacement behavior](tool-output-hidden-lines.md).

**How fast it fills in** is yours to set, because the wire's pace is not a reading pace: prose arrives in coalesced
bursts, and a burst of tool lines lands all at once. Settings → Display → **Stream display speed** types a paragraph —
a 🧠 reasoning block, and the result of a **skill** (`skill_view`, `skills_list`, `skill_manage`: the longest thing a
run hands the console in one go, typed out line by line inside its box) — out at that many words a second, and
**Stream line rate** walks whole new lines into the console one at a time (a skill's lines included, like every
other line). Every other tool's result is drawn whole. A reasoning block or a skill's result only types the first time
the panel sees it on a live turn, so opening an old card or reloading draws history whole; both settings
are `0` = off, which is the console filling exactly as the run sent it, and both are saved in this browser. A line
still held back is not in the console yet, so a repaint in the middle of one (a scan, a pinned turn's second copy)
shows the transcript as far as it has got — and a turn that settles, or a tab that goes to the background, releases
everything at once, so nothing is ever left waiting in a buffer. A reasoning block's text never goes **backwards**:
once it has typed a word the block keeps it, so a settled turn that comes back, or a tab returning to the foreground,
finishes the block instead of rewinding it to where the clock had got to. See
[why the reasoning block collapsed and reopened](thinking-block-redraw.md).

**A tool's output waits for the thought in front of it.** With **Stream display speed** on, a tool call (and the
output that answers it) is not written into the console until the reasoning that came before it has finished being
typed. A reply's reasoning reaches the panel from the session store a moment *after* the call it made is already on
the run's stream, and then types at your words a second — so left alone the call landed first and the thought
filled in above it afterwards. The panel now reads the store again the moment a call arrives, holds that call and
everything behind it (in order, as one queue per card) until the thought is written, and lets the lot go together.
Only the thoughts written since the last tool result count, so a card you open halfway through a turn does not wait
on its backlog. It holds nothing when there is nothing to wait for: **Stream display speed** at `0`, reasoning
switched off (🧠), a 🧠 block you have folded, a turn that is not running, or a tab in the background. The turn
ending releases whatever is held. A call with no thought in front of it is at most one store read (~50 ms) late.
`node tools/verify-reasoning-first.mjs` measures it on a sandbox panel, in both the 🌊 stream and the 🧠 block.

**Reasoning, skill output and the console each have a colour — and the console has ONE size for all of its text.**
Settings → Display → **Thinking text**, **Skill output** and **Console text** each carry a colour picker. The colours
are separate on purpose: the agent's reasoning, what a skill prints (the box a `skill_view`, `skills_list` or
`skill_manage` result is drawn in) and everything else the console says (the agent's own words and a tool's output).
**Default** keeps the look the console always had — reasoning a quiet italic lavender in the 🌊 stream and dim grey in
the 🧠 block, a skill's rows the console's tool-output grey — and **use defaults** under each row removes your choice
rather than writing the old colour back. A skill's colour falls back to the console's, then to the line's own; a diff
inside a skill's box keeps its green and red; the tool-call line, notes and errors keep theirs. There is only one
size: the **Console size** in the **Console text** row, which the console's own words, a tool's output *and* the
reasoning all read, so the three can never drift apart. Thinking text has no size of its own any more (a size chosen
there before this version now follows Console size). Ctrl+wheel over any of a card's console text — its words, a
tool's output or the reasoning, in the 🧠 block or the 🌊 stream — sizes that card, all three kinds together. Every
reasoning section stands an empty line below whatever came before it — a thought is not glued to the tool output above
it — except the first line of a console. `node tools/verify-text-styles.mjs` reads the computed colours and sizes off
a real page, through the real controls, and `node tools/verify-console-zoom.mjs` measures the Ctrl+wheel step on all
three.

**A run of tool calls is condensed.** Consecutive calls between two pieces of prose become one group, one row per
tool name: `💻 terminal ×11 curl …` with the last input and either a duration or a live clock. Click a row to filter
the group to that one tool; the button then reads **all N** and clears the filter. **`N lines`** opens the whole
group — every call with its output — and the N is the number of console lines it holds; opening it asks the session
store for every tool in the group, and a group left open on a turn that is still running refreshes itself as later
results land. Text ends a group, so the next call starts a fresh tally.

The gateway folds a parallel batch into one summary line — `first command + 3 commands` — so that tail is a button:
click **`+ 3 commands`** to read all four calls out of the session transcript, listed under the group with the call
that stood in for them. It is a lookup, not a re-run.

### Approvals and questions

A run that hits a flagged command parks, and the question appears **under that turn's console** as a raised box
saying `⚠ waiting on you — this turn is parked until you answer`, the command, and exactly the choices the host
offered (`Allow once`, `Allow for this session`, `Always allow`, `Deny` on a standard host). Answering collapses it to
one line: `✓ approved once: <command>`, or a red `✕ denied: <command>`. The panel never widens the choice list.

An agent's **own question** (the `clarify` tool) is the same kind of control in a light-purple box, drawn as a
centred 900px column under the console rather than a full-width band: each choice is a full-width row, the
recommended one is marked by a leading `recommended` chip, multi-select choices are ticked and sent together, and a
box under them takes a typed answer (`Enter` sends, `Shift+Enter` adds a line). The look lives in Settings → Display:
**Question tint** (light purple by default; the five are signal colours, never the approval's amber, so the two
parked states stay distinct), **Question size**, **Compact answers**, and **Typed answer box** (off hides the
free-text row for questions that offer choices; an open-ended question always keeps it, and a multi-select question
keeps its **Send answer** button). Answered, it reads `✓ answered: …`; a question answered elsewhere, withdrawn or
expired leaves `· question closed without an answer here`.

**A question whose run has already ended is not answered — it says so.** A run can end while its question is still
drawn: a stop, a failed turn, the gateway dropping it. Answering then used to collapse the box with
`✓ answered: …` even though no turn was left to read the answer, because the gateway's clarify route accepts the
answer and resolves the prompt anyway. The panel now reads the run's own status first: when it is `cancelled`,
`failed`, `completed` or `interrupted`, the box **stays** and reads
`the run had already ended (cancelled) — the answer was not delivered` in its warn line, the question is not
cleared, and the card settles on the run's own status on the next sweep — the sweep is the reconciliation pass, so a
run the gateway has already ended never leaves a card reading `running` (LIVE, blocking sends to its thread) for
more than one tick. The jobs log carries the reason beside the run id.

**The dock.** Approvals that do not come over a run's own stream (a selected approval transport, the legacy CLI
contract) land in a stack pinned bottom-right, with a `▾` that folds it and one card per request naming the agent,
the command and `expires in Ns`. Answering there sends the choice within the host's list; an expiry means the command
does not run. **The head counts only what is pending:** `⚠ waiting on you` and the amber count chip while a request is
really open, `✓ nothing pending` in green once none is — a record of something already decided never sits under the
waiting label. Below the pending cards sit two groups that are over. `auto-allowed · review` holds the writes a
standing permission let through without asking: each has **Keep**, and an **Unwind** that names exactly what it would
run — deleting a named remote branch, where that click is the confirmation, or drafting a message to the agent when
there is no safe inverse, so nothing runs on its own (the panel never invents an inverse). `decided` holds the
receipts of answered requests, the last three, one line each with its own `✕` and a `clear` for the group. Both are
receipts, not fixtures: each ages out after 90 s whether or not another event arrives. Clicking the head or any card
unfolds the dock and jumps to the agent that asked, opening its root, project and row on the way; a write whose agent
is not on this board says so on the card and in the banner instead of doing nothing. With nothing pending and no
records left, the dock hides.

### Thinking

`🧠` on a card turns on that session's reasoning; Settings → Agent cards → **Show thinking** sets the default for
cards that have not chosen. The block sits above each turn's console and reads `🧠 thinking · N blocks` — open and
refreshed while a turn runs, folded once it ends. It is off by default because each block is real bytes.

### Subagents

A turn that delegated shows a strip under its console: `⧉ N subagents · N running` (or `all done`). Open it for each
child's goal, its status and how long it ran, with the last line it wrote — click a child for its console. Status is
the point; the full child transcript is one click further. A folded turn keeps the one-line tally so you can see where
the agents came from. A child is filed under **the turn that started it** — the turn whose window contains its start —
so a delegation made in a later turn is never shown under the card's first one.

If a parent's turn ended before its children finished, Settings → Agent cards → **Collect subagent results** (on by
default) hands the parent their results as one more turn, once per turn, so a delegation is not left finishing into
nothing. **collect** on the strip does the same on demand, and reads `✓ collected` once the results were sent.

### The usage strip

Above the reply box: the model that will run next, and — when the gateway reported usage — what the turn used:

```
deepseek-v4.1-flash-1017 │ 101K/1.05M⌄ │ █········· 10% │ ◎ 92.6% │ ◷ 4.2s │ ↑ 231 t/s │ ⇊ 1
```

- **model** — double-click for the model picker (search as you type; the current choice is marked; the next turn uses
  it). Each row shows a `★` 0-10 Artificial Analysis rating when one exists, the context window, and `$input/$output`
  per 1M tokens; the tooltip says which index the rating came from and gives the average price.
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
  agent's next tool boundary, so the turn changes course. `Ctrl+Enter` (`⌘+Enter` on a Mac) is that button's press
  from the box itself, and either press greys the box and the button at once — before the gateway answers. A refusal
  puts both back with the words still in the box; an accepted steer keeps them greyed and empties it.
- **Queue reply** holds the text and sends it when the current turn finishes; queued replies show as ghost turns
  (`queued · sends when the current turn finishes`). While subagents are out, queueing also waits for them. `Enter`
  is that button's press: while the card offers it, `Enter` holds the reply instead of sending it. With no live turn
  to steer, `Ctrl+Enter` means the same thing there.
- **Click a held reply to edit it.** The held text becomes a textarea in place — `Tab` to the line and press `Enter`, or
  click it. `Enter` saves, `Shift+Enter` adds a line, `Escape` or **Cancel** puts the entry back exactly as it was, and a
  click anywhere outside the editor means the same one thing every time — what `Escape` means. A save writes back to
  that one held reply, whose age keeps counting from when it was first held: editing is not re-queueing, and an edit
  never sends. An entry being edited stays held — a turn (and its subagents) finishing under the editor does not shoot
  your half-written reply off, and the held line says so — and it sends when you save. Saving an empty box removes that
  held reply; nothing is sent.
- **Send reply** when nothing is running: the next turn on the same session, in the same directory. There is nothing
  to steer and nothing to hold, so `Enter` and `Ctrl+Enter` both send. `Shift+Enter` adds a line, `Up`/`Down` walk
  earlier prompts for that thread, shell style.
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
scrolls; every explanation is the row's own tooltip on the `ⓘ`. The panel is a **strip of tabs** — Display, Cards,
Board, Branches, Data, Gateway, Skills, Updates, Permissions, Pipeline, Bundles — and one panel is on screen at a
time: click a tab (or press `Enter`/`Space` on it) and its rows appear. That list is the strip's own: one tab per
`data-settings-group`, no more and no fewer, and `npm run verify:settings-tabs` fails when the two disagree. The
strip is one Tab stop, and `←`/`→` walk it (wrapping), `Home`/`End` take the ends. What this browser remembers is the
**tab** you chose, so the panel reopens where you left it; a stored tab this build no longer carries falls back to
Display rather than to an empty window.

The **search box** in the fixed head narrows the panel to the rows that answer it — on every tab, not only the one
you are looking at. It reads each row's own words and its tooltip, so `zoom out` finds Page zoom through the `−`
button's explanation as readily as `Panel font` finds itself. A row with no match goes away, each tab carries the
count of the rows that answer it, and a match on a tab you are not on switches the window to that tab while you
type. The matched text is highlighted, and nothing in the panel is rebuilt as you type — a select keeps its value
and a half-typed number keeps its caret. `Esc`, or the `✕` beside the box, clears the search and puts you back on the
tab you had chosen; on an empty box `Esc` closes the panel as usual.

The **Skills** tab is the one tab with nothing to set: it is a read-only inventory of what an agent started from this
panel can load. Every place a skill is absorbed from is a heading — the profile's own `skills/` folder, a
**junctioned** folder as a source of its own with the target it points at (so the same skills are never listed
twice), `skills.create_dir`, `skills.external_dirs`, and a trusted project's `.hermes/skills` — and under each heading
is one row per `SKILL.md` carrying its name, description, category and path. The `link` chip marks a row reached
through a junction, and a source that is not there, or that Hermes is told not to read, says why on its own heading
line. The line under the summary is the gateway's `GET /v1/skills` — what a run is actually **served**, with shadowed,
disabled and platform-gated names resolved: a row it does not serve says `not served`, a name it serves that no folder
carries (a plugin's `plugin:skill`) gets its own Gateway row, and a gateway that cannot answer leaves every row
`unverified` with its reason. Nothing in the tab edits a skill.

The **Pipeline** tab edits what a worktree is for, one definition at a time: a dropdown selects it (`id — title`,
with `kind` and the stage count), the form under it is that definition's title, kind, description, `next` and every
stage's prompt and exit check, and **open the flow** draws it — stages left to right, each stage's exit check as a
notch on the connector after it, a capped loop as an arc labelled with its cap. A definition has no position, so
every stage is drawn *not reached*. The dialog is a real modal: it sits above the Settings window, Tab stays inside
it, `Esc` or a press outside closes it, and focus goes back to the button. A draft with unsaved changes is not
replaced by a repaint, and switching the dropdown away from it is refused until you save or reload.

The same dialog opens from a **queue row's `⇢`** beside its `pipeline …` chip, in position mode: the task's own
sequence with its finished stages green, the stage it is in blue, the ones ahead grey, a gate that said no red, and
the time it entered the stage. The `position` select and the `stage refused` box move that DRAWING only — nothing is
written, and the chip's window is still where a task is put on a pipeline or moved.

The **Board** tab opens with **Read now**, the two gestures that read the board at once instead of on the clock:
**Refresh now** re-reads every worktree row of the projects in view (the same cheap pass the board runs every few
seconds, so a row that already matches stays as it is, and a row whose verdict is stale is read in full), and
**Fetch remotes** runs `git fetch <remote> --prune` in every project and then re-reads the rows — the only routine
gesture that touches git refs. Each says in the banner what it started, with the number of rows or projects it
covers, and the rows repaint as the reads land.

**Live updates** sits under **Read now**: a press freezes the page by closing the live stream, so nothing updates —
no card, countdown, badge or console moves — and what was last read stays on screen. The button then reads
**Resume**, which reconnects and re-syncs every row. It is the same control the top bar used to carry; it lives here
now, beside the rows it freezes.

**Stored in this browser** (per browser, not shared; the exceptions are the rows the table marks as this panel's own
`config.json` — **Refresh**, **Hide stale worktrees** and **Chart columns** — which apply to every browser and survive
a restart):

| Tab | Row | Meaning |
| --- | --- | --- |
| Display | Page zoom | `Ctrl+` / `Ctrl-` / `Ctrl+0` (reset), or the `−`/`+` buttons here. `Ctrl+wheel` zooms the page too, except over a card's console text, where it sizes that card's console — its words, a tool's output and the reasoning together. |
| Display | Panel font | Headings, labels, buttons and the text you type. |
| Display | Terminal font · Console weight | The console and the tool lines inside it. |
| Display | Thinking text · Skill output · Console text | A colour picker for each of the agent's reasoning, what a skill prints, and the rest of the console (its words and a tool's output), plus the console's **size** — the one size its words, a tool's output and the reasoning all read. Unset is the default look; **use defaults** under each row puts it back. Saved in this browser. |
| Display | Stream display speed | Words a second at which an agent's own prose, its reasoning blocks and the results of the skills it loads type out, 0–200 (`off`/10/20/40/80 presets, 40 by default — what a long answer here streams at). `0` is off — the console fills exactly as the run sent it. Whatever is still queued is released when the turn settles. While it is on, a tool call waits for the reasoning in front of it to finish typing. |
| Display | Stream line rate | Lines a second at which whole new lines join a console, 0–40 (`off`/2/4/8/16 presets). A tool burst walks in instead of landing in one paint; a held line is not in the console's record yet, and a settled turn flushes what is left. `0` is off. |
| Display | Panel contrast | How far apart the layered surfaces sit: 0% flattens them, 100% pushes the page to near-black and lifts the panels. The swatch strip below previews the layers. |
| Display | Add-agent bar | The green of the **+** bar in a worktree's agents, 0% (deep and quiet) to 100% (vivid). Lightness and saturation move together; the swatch below the row is the bar itself, so the preview cannot disagree with the button. |
| Display | Add-agent bar at top | Draw the **+** bar above a worktree's agent cards instead of under them. On by default; off restores the old position. |
| Display | Project colours | Count in the tooltip, **reset colours** clears every project's hue. |
| Display | Question tint | The colour of the agent's question box: light purple (the default), sky, mint, rose or slate. Signal colours, never the approval's amber. |
| Display | Question size | Type size of the question and its choices, 11–18px (the choices are half a point smaller). A typed value is clamped when you leave the field. |
| Display | Compact answers | Tighter padding and gaps between the answer rows, so a question takes less room in a card. The type size is separate. |
| Display | Typed answer box | Shows the free-text row under the choices. An open-ended question keeps it whatever this says, or there would be nothing to answer with. |
| Cards | Show thinking | The default for cards' `🧠`; a card's own toggle wins. |
| Cards | Combined output | The default for cards' `🌊`: on, a session that never pressed the button comes up as one stream (reasoning while `🧠` is on, the calls, and the agent's words, in the order they happened); off — the default — it is the separate thinking block and the condensed tool bursts. A card's own `🌊` wins. Saved in this browser. |
| Cards | Jump to an opened result | Off by default: opening a folded tool output holds the console where it is, so the box unfolds under the header you pressed. On restores the old follow-the-growth behaviour, where the console slides down to the end of what was just opened. Saved in this browser. |
| Cards | Collect subagent results | Hand a parent the results of children that outlived its turn, once per turn. |
| Cards | Previous turn on send | What the turn you were reading becomes when you send a reply: **freeze a snippet** (the default — the last tool line, the answer it ended on, and what folded), **leave as is** (its console stays open above the new turn), or **minimize it** (folded to its one-line peek first). Saved in this browser. |
| Board | Board reorder | Seconds between re-sorts of closed folders and projects (`off`/5/15/30/60 presets). A project you have open keeps its slot. |
| Board | Hover anchor | The card the pointer moves over keeps its screen position while others grow; the seconds are how long it lingers after the pointer stops. Off falls through to the next rule. |
| Board | Touched anchor | The card you last clicked, focused or typed in keeps its position for its own number of seconds. Off clears that signal. |
| Board | Flash time | How long the green (and grey) row flash, the project outline and the landing ring last. `0` turns them off. |
| Board | Grey flash | A row that was re-read with nothing changed flashes grey. Green — a sign of life — always flashes. |
| Board | Flash on events | An event about the worktree (a console line, a job starting or finishing, an approval) counts as life and flashes the row; off, the ring still restarts but the board does not pulse. |
| Board | Banner timeout | How long a red failure banner stays before it hides itself, 0–30 s (5 s by default). `0` keeps every failure until its `✕`. The clock pauses while the pointer or the keyboard focus is inside the bar, so a failure can be read at your pace; the `✕` always dismisses it at once, and a green confirmation keeps its own four seconds. Saved in this browser (`wtgui.bannerSeconds`). |
| Board | Refresh | Which projects the panel re-reads: **everything**, or **only on screen** (the window plus half a screen either side). In "only on screen" it reads nothing while no page is open, and scrolling a stale project into view reads it at once. Saved in this panel's `config.json`, so it applies to every browser and survives a restart. |
| Board | Chart columns | One switch per column of the worktree table — **Worktree**, **Branch**, **Owner**, **Tip**, **Ahead / Behind**, **Cherry**, **PR**, **Dirty**, **Life**, **Next read**, **Verdict** and **Actions** (the row's ⟳ and ✕). Every switch starts ON; the **Owner** column is the one that can be on and not drawn, because it hides itself while every tree is on Assistant #1 and there is no second assistant (a column of identical `M1` tags), and the sentence beside the count says so. A switch that is off takes that column's header and its cell out of every project's table and gives the width back to the columns that are left, so a narrow window squeezes rather than clips while the columns you do not read are gone. An expanded worktree and the delete question still span the whole chart. At least one column always stays, and the row's own controls are the last thing to go. Saved in this panel's `config.json` (`hiddenColumns`, the columns to hide), so it applies to every browser and survives a restart. **show all** turns every column back on. |
| Board | Row refresh → agent | What a row's ⟳ does after its cheap pass finds a mismatch: **never** (re-read and journal only), **ask first** (one card under the row, the default), or **start it** (the click starts the agent itself). Refused while a run is already live in that tree. Saved in this browser. |
| Board | Collapse cascade | How long a parent you folded — a folder, a project, a worktree row or one of the fixed cards — has to stay folded before everything under it is minimized too: its cards are written into the remembered fold set, so opening the parent again draws them minimized, and they come back minimized after a reload. 30 s by default; `0` turns the cascade off and leaves the cards as they were. Opening the parent before the time is up cancels its clock, folding it again restarts it, and opening a parent never takes a card out of the set — the cascade only ever adds folds. Saved in this panel's `config.json` (`collapseAfterSeconds`), so it applies to every browser and survives a restart. |
| Board | Agents clean up | Whether an agent may take a worktree off this disk once the work has landed — the worker’s `RELEASE` line, and a check agent’s `LANDED: YES`. **on** (the default) leaves each project’s own `releaseWorktrees` grant deciding, and the line under the row names the projects that carry it; **off** closes every project at once — no `RELEASE` paragraph reaches a prompt, a request that arrives is refused on its row, and a `LANDED: YES` is only a line in the console. The row’s **✕** is not affected. Saved in this panel’s `config.json` (`agentCleanup`), so it applies to every browser and survives a restart. |
| Updates | Update check | What this tab does when the panel is serving a different build than the one it loaded: **off**, **prompt** (the default — a chip offers the reload), or **auto** (reload as soon as the page is idle). Both modes hold the reload while a reply box or a held draft has text, or while a turn is streaming. Saved in this browser. |
| Updates | Panel build · Check now | The build this tab is running, and what the panel serves now. **Check now** asks `GET /api/build` at once — it works even with the check set to off. |

**The Prompt tab** is read-only, and it is the picture behind the General tab's **Turn briefing budget**. Three
box-in-box diagrams draw the prompt one assistant turn is built from: the **first turn of a session** (the charter
sent whole), an **ordinary turn** (the charter's one-line marker, the board's marker and no queue digest) and the
**fourth wake** (the queue digest and the board's full digest both due, so it is the largest ordinary turn). The
outer box is the whole prompt, the two inside it are its carriers — the standing `system` text and the `turn` text
appended to the question — and every section inside them is labelled with its characters and its share of that
turn. The caps are the panel's own constants, not the drawing's: the charter's 20,000 characters, the twelve rule
seats at 200 characters each, the notes' 1,200-character clip, ten watches at 120, forty project lines, the role
prompt's 8,000-character cap, the queue digest's rows and the board's 8,000-character budget. The sizes are measured
by the same `Assistant.briefingParts` a real turn uses (`GET /api/settings/prompt-budget`) and opening the tab
advances neither the charter's send record nor the board's sweep tick, so looking at the budget cannot turn the next
real turn into a marker for text nobody was sent.

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

**Models & prices** is the one Gateway row that is a gesture rather than a setting. The model menu shows two columns —
in/out price per million tokens and a 0-10 rating — and they come from two different places, so the row dates both. One
press of **Refresh models & prices** makes the gateway re-fetch every authenticated provider's live model list
(`provider_models_cache.json`, the file `hermes model --refresh` writes and the menu lists from) and then rebuilds this
panel's own price cache from that same answer: one gateway call, not two, which is why there is one button and not a
separate "refresh prices" beside it. The line under the row reads the list's age and the price cache's age side by side,
then how many rows the committed OpenRouter snapshot fills and the date it was fetched. That snapshot
(`data/openrouter-model-prices.json`) is the only source of the ratings, and of prices for OpenRouter models the gateway
does not price; no press can re-fetch it — `python tools/openrouter-prices.py` does, and its result is committed.

---

## Keyboard and mouse

| Gesture | Where | Effect |
| --- | --- | --- |
| `Enter` | Spawn prompt | Spawn the agent. |
| `Shift+Enter` | Spawn prompt, reply box, question answer | A newline instead of sending. |
| `Up` / `Down` | Spawn prompt, reply box | Walk earlier prompts for this thread/board. |
| `Enter` | Reply box | **Queue reply** while the card offers that button (a turn is running, or a finished turn's subagents are still out); otherwise send the next turn. |
| `Ctrl+Enter` (⌘+Enter) | Reply box | **Steer turn** — send the text into the live turn. With no live turn to steer it means what `Enter` means. |
| `Alt+Shift+A` | Anywhere | Switch the assistant's aggressive profile on or off. |
| `Ctrl+,` | Anywhere | Settings. |
| `Esc` | In the Settings search box | Clear the search and put every group back as you had it. On an empty box it closes Settings. |
| `Esc` | Anywhere | Close what is open: an artifacts list, Settings, a maximized card, a clone row, or a folder filter. |
| `Ctrl+wheel` | Over a card's console text — its words, a tool's output or the reasoning | Size that card's console, all three kinds of text together; anywhere else it zooms the page. |
| `Ctrl+` / `Ctrl-` / `Ctrl+0` | Anywhere | Page zoom in, out, reset. |
| `Ctrl+[` | Anywhere | Fold one tier — the lowest with anything open, in the order turn bodies, cards, worktree rows, projects, folders and the two fixed cards. Nothing open: no-op. |
| `Ctrl+]` | Anywhere | Expand the whole tree. |
| Click | Worktree row | Open its detail (description, TODO, merge state, liveness, agents, sessions). |
| Click | Project or folder title | Open or close it. |
| `Ctrl+click` | Project title | Give it a theme colour; again re-rolls. |
| `Ctrl+Shift+click` | Project title | Clear its theme colour. |
| Click | Row's `⧉ N` badge | Open the row and jump to its agents. |
| Click | Row's ring | Read that worktree now. |
| Click | Row's green ▶ | Probe every agent in that worktree that is not running, all at once. |
| Click | **+** bar in a row's agents | Turn it into a field; `Enter` starts the agent there, `Esc` puts the `+` back. |
| Click | Not-running pill on a card | Send `Continue if you can, exit if you are done` and start the next turn. |
| Double-click | Model on the usage strip | Model picker. |
| Click / right-click | `used/ceiling⌄` | Cycle the context ceiling / open the full picker. |
| Click | `📄 N` / `🔗 N` | Open the file or link list. |
| Click | Turn head | Open or fold that turn. |
| Click / `Tab`+`Enter`/`Space` | The `▸` in front of a TODO item | Unfold that one item's owner / by / updated facts; again folds them. |
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
| Panel build | `GET /api/build` — the version this tab loaded vs the one the panel is serving | every 30 s (setting: off / prompt / auto) |

Rows flash when something moved: green for a sign of life or a row that moved up the order, grey for a re-read with
nothing new. A **collapsed** project's outline and title bar flash green along with the row inside it; an open
project does not, because its rows are already on screen saying what happened. The number in **Life** is
time since the last evidence; the ring in **Next read** fills toward the next read
and turns amber/red if a row is overdue — a long ring usually means the panel is busy, not that the row is stuck.

With Settings → Board → **Refresh: only on screen**, those cadences apply only to projects in view: off-screen
projects are not scanned at the frequent cadence, and nothing is scanned while no page is open. That is a cadence, not
a promise of invisibility: a recent project whose rows have not been **read** for `projectStaleSeconds` (15 minutes)
is due for one full pass anyway, and a project's rows are read once at boot. Without that floor a board nobody was
looking at served a ten-hour-old row set — and every worktree cut in those ten hours had no row, so its cards fell to
the unattached list. A tree cut after a scan is also picked up by the panel's own job pass, which matches a card's
directory against `git worktree list` and attaches the card to the real tree.

Configured in `config.json` (`liveSeconds`, `worktreeSeconds`, `dormantSeconds`, `slowSeconds`, `projectStaleSeconds`,
`fetchSeconds`, `refreshSeconds`), and the footer prints the values in use.

`projects[].releaseWorktrees` is the one key that lets a worker's `RELEASE` line be acted on, and it is off unless it
is literally `true` — a string, a `1` or a missing key all leave it closed. With it on, the panel still refuses
unless the tree is clean, the branch's PR reads MERGED, nothing on the branch is missing from that PR's merge commit,
and no run is still holding the tree — or, for a tree that never had a PR, unless the branch is 0 commits ahead of
`origin/main` (measured, with the tree-equal diff as the fallback) and every other gate still passes. The row carries
the answer either way (`removed`, or `refused: <gate>`).

That key is a PROJECT grant, and `agentCleanup` (Settings → Board → **Agents clean up**) is the board’s veto
above it: off, no project’s grant is acted on, no prompt carries the `RELEASE` paragraph, and a check agent’s
`LANDED: YES` deletes nothing. On, the grant still decides, so the row’s own line names the projects that carry
it (`settings.releaseProjects`).

The panel's own build is separate from all of that. `index.html` is served `no-store` and every script and stylesheet
it loads carries a `?v=` hash of the bytes; a restarted panel (or an edit under `public/` while it runs) is a new
version, and the open tab learns it from `GET /api/build`. Settings → **Updates** decides what happens: **off** never
looks, **prompt** (the default) offers a reload chip, **auto** takes it. Either mode **holds** the reload while a reply
box or a held draft has text, or while a turn is still streaming — the chip says which — so a reload never throws away
something you typed or an agent is writing. **Check now** asks at once, even with the setting off.

---

## When something looks wrong

| Symptom | Check |
| --- | --- |
| `api: down`, or a spawn answers 503 | The gateway is down or `API_SERVER_KEY` is missing from `$HERMES_HOME/.env`. Start it with `hermes gateway restart`; the New-agent header says which of the two it is. |
| The agent works in the gateway's directory instead of its worktree | The gateway is missing the local patch (`docs/hermes-runs-api-knobs.diff`, lost after `hermes update`). The gateway chip's tooltip says `the gateway ignores per-run cwd`. |
| No usage strip above a reply box | Same missing patch: no `run.usage` events, so the panel shows nothing rather than zeros. |
| A verdict badge stays empty (grey) | It is computed on the project's slow pass; **Settings → Board → Read now → Refresh now** re-reads the rows at once, and a row whose verdict is stale is read in full. A dashed grey badge is a verdict being reclassified. |
| Rows stop moving | The page may be paused, or the stream `reconnecting…`/`offline`. **Settings → Board → Live updates → Resume**, or **Settings → Board → Read now → Refresh now**. |
| A project's numbers look old while it is off screen | With Settings → Board → Refresh: **only on screen**, off-screen projects are not read until you scroll them into view — and nothing is read at all while no page is open. |
| A worktree will not delete | An agent run is live in it — stop the run first. |
| The assistant says it started a worker but nothing appeared | Look at the strip above **New agent** and at the `N spawn` pill on ✧ Assistant: in **ask** mode a SPAWN line is a card waiting for a click, not a run. If neither a card nor a worker exists two minutes after the turn, the journal carries a **lost SPAWN line** and the Alerts tab an alert naming the turn. |
| A column is too narrow or too wide | Drag the edge between two column headers (the pair trades width); **double-click** any edge to go back to the measured split. Widths are remembered in this browser, so a reset is per browser too. |
| `revive` is refused | That session already has a card on the board. |
| A restart seems to have changed nothing — the board is still the build you started | The bounce's own lines are in the panel's `server.out.log` (`panel-restart: stopped pid …`, `launched … as pid …`, `pid … is serving on …`). The replacement is started only after the outgoing panel and any stray `server.js` on the port are stopped, so a line saying `exited before it bound port` names the failure instead of leaving the old build answering. |
| A console result is cut short | The run stream carries a preview, not the full payload. See the README's troubleshooting section. |

More in the [README](../README.md#troubleshooting) and [SETUP.md](../SETUP.md). The panel's internals — how rows are
produced, what each route does, the gateway protocol — are in the README.