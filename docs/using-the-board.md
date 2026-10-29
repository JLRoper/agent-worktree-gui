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
| **Spawn cards waiting** | A strip above **New agent**, only while the assistant has proposed workers nobody has clicked yet (see *Spawn cards*). |
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
| Config line | Version, how many projects are being watched, the two main cadences, scan threads, bind host — and `refresh on screen only` when that refresh mode is on. |
| Stream readout | `pool 1/3 · 3 conversations · 29 events · 2.4/s`: scan workers busy, how many conversations, and the event rate arriving over SSE. |
| **NOT-RUNNING** | Steps through the agents that are not running and are waiting on you. See below. |
| **✧ Assistant** | Opens the floating assistant panel (`A` or `Ctrl+Shift+A`). Its purple badge counts the open alerts; the `⧗` pill beside it counts the **spawn cards** waiting for a click, amber once the oldest has waited over two minutes. |
| **Collapse all** | Folds the whole tree — every folder, project, worktree row, card and turn. The button then reads **Expand all**. Same as `Ctrl+[` / `Ctrl+]`. |
| **⚡ Aggressive** | Switches the assistant's aggressive profile on or off. Its pill reads `on`/`off`, so the state does not depend on colour. |
| **Refresh now** | Forces a fast scan now instead of waiting for the next tick. With Settings → Board → **Refresh** set to "only on screen", it reads only the projects in view. |
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
| **model** | `(default)` uses the gateway's configured model. The list is what the provider advertises, grouped by provider, and each row carries the price per million tokens in and out, the context window, and a 0-10 Artificial Analysis rating where a benchmark has scored it — click the field to open it, type to filter, `Enter` takes the highlighted row. The assistant's own model setting and a card's model readout open the same list, from the same one price table. A model nothing has priced or scored shows no columns, not a zero. |
| **budget s** | The run's wall-clock budget (`1800` by default). |
| **max turns** | Optional ceiling on turns; blank means the gateway's own default. |
| **skills** | Disabled: a run does not carry a skills list yet. |
| `--yolo` | Disabled on purpose. A run is never blind to a flagged command, so there is nothing to bypass — approvals come to the card. |
| **create workspace** | Ticked: cut a new worktree and branch under `.worktrees/` and run there. Unticked: run in **start in** as it is. |
| **Spawn agent** | Starts the run. The card says the run id and the worktree it made. |

The dim line under the card title is the promise: **run · new worktree under `…/.worktrees/` · project X** when a
workspace will be created, or **runs IN `…` (no new worktree); edits land in that tree** when it will not. That is
the line to read before clicking.

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
  cards. The pill turns amber once the oldest card has waited more than two minutes. **Review in Alerts** in the
  strip opens the panel on its Alerts tab with the card in view.
- **The Alerts tab** draws spawn cards first, under `spawn cards waiting`, before the other alerts.

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
| **Branch** | The checked-out branch. A link to the branch's page on its host when the remote actually has the branch; plain text with a `local` chip when the remote answered its head list and this branch was not in it, and the reason in the tooltip. When the remote could not be reached the cell is plain text with an `unverified` chip and a tooltip that says how far the panel got ("cannot tell whether the remote has this branch yet", or "not on the remote as of the last fetch" when its refs were checked) and then quotes the project's last fetch failure — so a row the panel could not check is visibly not the same as one nobody ever pushed, and the reason is on the row. A chip is never drawn on a row the last fetch's refs did resolve to a page. "unknown" is not "local". The link follows the branch: a tree that switches or renames its branch is read again and wears the new branch's page and PR, not the old one's. |
| **Tip** | Short SHA of the branch tip. |
| **Ahead / Behind** | The branch against its **own copy on the remote**, counted the way `git status` counts it: `↑N` is commits here that the copy does not have (not pushed), `↓M` is commits on the copy that are not here (not pulled). The side with work to do is lit (↑ amber, ↓ blue), a side with none is dim, and `↑0 ↓0` is level. When there is no copy to count against the cell is a word: `—` the branch has no copy on the remote (never pushed; a worktree cut from `origin/main` tracks main until its first `git push -u`, and main is not its copy), `gone` the copy was deleted (a merged PR's branch usually is), `?` the remote has a branch of that name but this tree is not set to track it (the tooltip gives the `git branch -u` that fixes it). The counts are as of the last fetch: a dotted count with a `?` after it was taken while the project's last fetch was failing, and the tooltip quotes the failure. The count against the project's main — what the verdict is built from — is in the verdict's tooltip (`Against origin/main: 3 ahead, 1 behind.`) and at the end of this cell's tooltip. A page served by a board process older than the page draws the old numbers as `N / M` with a tooltip that says to restart the board. |
| **Cherry** | `+N/−N` from `git cherry`: `+` commits with no equivalent upstream, `−` commits already upstream by patch id (the evidence that a squash or rebase landed them). |
| **PR** | `#123 OPEN` / `#123 MERGED`, `none`, or `none · branch gone` when the branch existed remotely and no longer does. The number is a link to the pull request's own page on the project's host; it stays plain text (with the reason in its tooltip) when no page can be built. Hover it for the title. |
| **Dirty** | Modified files, and `+N?` untracked, or `clean`. |
| **Life / next read** | Time since anything last said this worktree is alive, the evidence chips, and a ring that fills toward the next scheduled read. Click the ring to read the row **now**. |
| **Verdict** | See below. |
| ✕ | Remove the worktree (not offered on the project's own checkout row). |

**Column widths are measured, not fixed.** Each column is sized from the widest thing it actually holds — its
header, the longest branch name, the chips on a row — so the columns that say little (`Cherry`'s `+0/−0`, `PR`'s
`none`) stay narrow and the room they gave up goes to the two columns whose text truncates: **Worktree** and
**Branch**. In the worktree cell the name is what ellipsizes; the agent badge and the evidence chips keep their
whole width, so what a row is doing is never the part that gets cut.

Drag the edge between two column headers to set those columns by hand: the pair trades width, so the rest of the
row does not move. The choice is remembered in this browser and applies to every project. **Double-click** any
column edge to hand the board back to the measurement.

**On a narrow window the chart scrolls sideways.** Ten columns need ~846px before each one is under the width its
own text needs, and below that there is no smaller readable version of the table — every column at 24px is a row of
overlapping words. So under that width the table keeps those widths and its box scrolls left and right (one finger,
and the swipe does not trigger the browser's back gesture). Two rows do **not** scroll with the columns: an expanded
worktree and the delete question both stay the width of the visible area, so the transcript is not read through a
letterbox and **Delete** stays where the thumb is. The one thing given up is the column header's stickiness — inside
a sideways scroller it can no longer follow the page down, which on a phone costs nothing because the wrapped
toolbar already covers that line.

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
| `UNMERGED (N commits)` | Carries `N` commits that are not on remote main. On a clean tree the badge **is a button** (`⇥` on its face): it opens five outcomes for that row — roll it into its parent, **rebase it onto its parent's newest commit**, open a PR, have an agent **check whether the change is already on main** (which deletes the tree when it is), or ask where it should go. See [Merging a branch from the board](#merging-a-branch-from-the-board), [Rebasing a branch onto its parent](#rebasing-a-branch-onto-its-parent) and [Checking whether a branch already landed](#checking-whether-a-branch-already-landed). |
| `EMPTY REPO` / `NO BASE REF` | There is nothing to judge against: the repo has no commits yet, or its remote base ref does not exist here. |
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

- **Merge state** — folded to one line (`ON MAIN · branch main · 2 untracked · last commit 6m ago`). Open it for the
  full list: ancestor of remote main, cherry counts, branch reflog, whether the branch ever carried its own commits,
  the remote branch, and then **every commit not on remote main** — one per line, short sha and subject, the full
  width of the row, all of them however many there are (the list extends and the panel scrolls; nothing is clipped)
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
| Turn pager | `▲`/`▼` and `6–10 / 23` when a thread has more turns than fit on a page. |
| Thread name | The Hermes session id (or your label for it) — the thing a reply continues. |
| `📌` | Pin this card: it keeps its screen position while cards above it grow. One pin at a time; clicking again releases it, and clearing the thread releases it too. |
| `🧠` | Show this session's reasoning (see below). |
| `🌊` | Draw this session as **one stream**: what the agent thought (while `🧠` is on), said, called and got back, in the order it happened, with nothing folded. Per session, remembered in this browser; off, the card is the separate thinking block and the condensed tool bursts it always was. |
| `✎` | Rename the session **in the panel only**. The Hermes thread id never changes. |
| `⤢` | Maximize the card to the window (`Esc` closes). |
| `✕` | Forget this session: the first click arms it (`✕ sure?`), the second removes its turns and transcript from the panel. The worktree it made stays on disk. |

Under every head — titled or not — is one dim line: `cwd …/project/.worktrees/<name>`, the directory the agent
actually runs in (the last three segments; hover for the whole path). When the row it is filed under is a different
folder, a `row …` chip follows it. It is a reference, not a heading: smallest size, dimmest ink.

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
- The open turn holds, in order: the thinking block (if on), the console, the subagent strip, and any approval or
  question box for that turn.
- Sending a reply folds the earlier turns to a **compact** summary — the last tool line, the answer's first lines, and
  one dim line saying what folded. A turn you opened by hand is compacted the same way, not closed.
- A failed turn that is worth retrying (a timeout, a 5xx, a dropped connection) shows **retry** beside its outcome; it
  sends that turn's prompt again as a new turn, because the failed turn's edits are already on disk.

### The console

Output streams into a `<pre>`. It follows the newest line unless you scroll up; a `↓` button brings you back and
re-pins it. A tool result is a **preview** of what the tool returned, not the full payload — when it was cut the
console ends it with `… result truncated by the gateway` (the gateway's `HERMES_RUN_PREVIEW_CHARS` raises the cap;
set to `0` on this box, so the stream carries the whole result). When the preview was empty — routine for `patch`
and `write_file` — the panel reads that call's result back out of the session store and draws it under the result
line **as text**: a patch's diff, a terminal's output, never the JSON envelope it travelled in. Each burst in a turn
pairs with its own results, so a second run of the same tool later in the turn shows its own output rather than the
first run's. A call the store has nothing for says `no output recorded for this call` — or `no output in the session
store yet` while the turn is still running.

A long result is folded by the panel itself: the card keeps its **first 40 lines** (and shortens any line past 400
characters), because a whole 5,000-line read in the console would push every other line of the card out of its
600-line ring buffer. The fold ends with a sentence you can click — `… 214 lines hidden — click to read`, or
`… 12 lines hidden, 3 lines shortened — click to read` when the head wore the line cap too. The click reads **that
one result** back out of the session store, uncapped, and draws the whole thing in place; nothing is added to the
console's own lines, so the card stays as long as it was. A store with no copy of the result says so instead of
inventing output: `… the session store has no copy of this result — the lines above are all of it here`. Both
truncation notes are honest about which cap cut: `… result truncated by the gateway` is the gateway's preview cap,
the `… N lines hidden — click to read` sentence is this panel's fold, and each only appears when its own cap really
dropped something.

**How fast it fills in** is yours to set, because the wire's pace is not a reading pace: prose arrives in coalesced
bursts, and a burst of tool lines lands all at once. Settings → Display → **Stream display speed** types a paragraph —
and a 🧠 reasoning block — out at that many words a second, and **Stream line rate** walks whole new lines into the
console one at a time. A reasoning block only types the first time the panel sees it on a live turn, so opening an
old card or reloading draws history whole; both settings
are `0` = off, which is the console filling exactly as the run sent it, and both are saved in this browser. A line
still held back is not in the console yet, so a repaint in the middle of one (a scan, a pinned turn's second copy)
shows the transcript as far as it has got — and a turn that settles, or a tab that goes to the background, releases
everything at once, so nothing is ever left waiting in a buffer.

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
  from the box itself.
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
scrolls; every explanation is the row's own tooltip on the `ⓘ`.

**Stored in this browser** (per browser, not shared; the one exception is **Refresh**, which is the panel's own
setting):

| Group | Row | Meaning |
| --- | --- | --- |
| Display | Page zoom | `Ctrl+` / `Ctrl-` / `Ctrl+0` (reset), or the `−`/`+` buttons here. `Ctrl+wheel` zooms the page too, except over a console, where it sizes that console's text. |
| Display | Panel font | Headings, labels, buttons and the text you type. |
| Display | Terminal font · Console size · Console weight | The console and the tool lines inside it. |
| Display | Stream display speed | Words a second at which an agent's own prose and reasoning blocks type out, 0–200 (`off`/10/20/40/80 presets, 40 by default — what a long answer here streams at). `0` is off — the console fills exactly as the run sent it. Whatever is still queued is released when the turn settles. |
| Display | Stream line rate | Lines a second at which whole new lines join a console, 0–40 (`off`/2/4/8/16 presets). A tool burst walks in instead of landing in one paint; a held line is not in the console's record yet, and a settled turn flushes what is left. `0` is off. |
| Display | Panel contrast | How far apart the layered surfaces sit: 0% flattens them, 100% pushes the page to near-black and lifts the panels. The swatch strip below previews the layers. |
| Display | Add-agent bar | The green of the **+** bar in a worktree's agents, 0% (deep and quiet) to 100% (vivid). Lightness and saturation move together; the swatch below the row is the bar itself, so the preview cannot disagree with the button. |
| Display | Add-agent bar at top | Draw the **+** bar above a worktree's agent cards instead of under them. On by default; off restores the old position. |
| Display | Project colours | Count in the tooltip, **reset colours** clears every project's hue. |
| Display | Question tint | The colour of the agent's question box: light purple (the default), sky, mint, rose or slate. Signal colours, never the approval's amber. |
| Display | Question size | Type size of the question and its choices, 11–18px (the choices are half a point smaller). A typed value is clamped when you leave the field. |
| Display | Compact answers | Tighter padding and gaps between the answer rows, so a question takes less room in a card. The type size is separate. |
| Display | Typed answer box | Shows the free-text row under the choices. An open-ended question keeps it whatever this says, or there would be nothing to answer with. |
| Agent cards | Show thinking | The default for cards' `🧠`; a card's own toggle wins. |
| Agent cards | Collect subagent results | Hand a parent the results of children that outlived its turn, once per turn. |
| Board | Board reorder | Seconds between re-sorts of closed folders and projects (`off`/5/15/30/60 presets). A project you have open keeps its slot. |
| Board | Hover anchor | The card the pointer moves over keeps its screen position while others grow; the seconds are how long it lingers after the pointer stops. Off falls through to the next rule. |
| Board | Touched anchor | The card you last clicked, focused or typed in keeps its position for its own number of seconds. Off clears that signal. |
| Board | Flash time | How long the green (and grey) row flash, the project outline and the landing ring last. `0` turns them off. |
| Board | Grey flash | A row that was re-read with nothing changed flashes grey. Green — a sign of life — always flashes. |
| Board | Flash on events | An event about the worktree (a console line, a job starting or finishing, an approval) counts as life and flashes the row; off, the ring still restarts but the board does not pulse. |
| Board | Refresh | Which projects the panel re-reads: **everything**, or **only on screen** (the window plus half a screen either side). In "only on screen" it reads nothing while no page is open, and scrolling a stale project into view reads it at once. Saved in this panel's `config.json`, so it applies to every browser and survives a restart. |
| Updates | Update check | What this tab does when the panel is serving a different build than the one it loaded: **off**, **prompt** (the default — a chip offers the reload), or **auto** (reload as soon as the page is idle). Both modes hold the reload while a reply box or a held draft has text, or while a turn is streaming. Saved in this browser. |
| Updates | Panel build · Check now | The build this tab is running, and what the panel serves now. **Check now** asks `GET /api/build` at once — it works even with the check set to off. |

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
| `Enter` | Reply box | **Queue reply** while the card offers that button (a turn is running, or a finished turn's subagents are still out); otherwise send the next turn. |
| `Ctrl+Enter` (⌘+Enter) | Reply box | **Steer turn** — send the text into the live turn. With no live turn to steer it means what `Enter` means. |
| `Alt+Right` / `Alt+Left` | During NOT-RUNNING | Skip forward / go back. |
| `Ctrl+,` | Anywhere | Settings. |
| `Esc` | Anywhere | Close what is open: an artifacts list, Settings, a maximized card, a clone row, or a folder filter. |
| `Ctrl+wheel` | Over a console or a thinking block | Size that text for that card; anywhere else it zooms the page. |
| `Ctrl+` / `Ctrl-` / `Ctrl+0` | Anywhere | Page zoom in, out, reset. |
| `Ctrl+[` / `Ctrl+]` | Anywhere | Collapse / expand the whole tree. |
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
project does not, because its rows are already on screen saying what happened. The number in **Life / next read** is
time since the last evidence; the ring fills toward the next read
and turns amber/red if a row is overdue — a long ring usually means the panel is busy, not that the row is stuck.

With Settings → Board → **Refresh: only on screen**, those cadences apply only to projects in view: off-screen
projects are not scanned at all, nothing is scanned while no page is open, and a project scrolled into view is read
immediately. The config line then ends with `refresh on screen only`.

Configured in `config.json` (`liveSeconds`, `worktreeSeconds`, `dormantSeconds`, `slowSeconds`, `fetchSeconds`,
`refreshSeconds`), and the footer prints the values in use.

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
| A verdict badge stays empty (grey) | It is computed on the slow pass; **Refresh now** forces one. A dashed grey badge is a verdict being reclassified. |
| Rows stop moving | The page may be paused, or the stream `reconnecting…`/`offline`. **Resume** or **Refresh now**. |
| A project's numbers look old while it is off screen | With Settings → Board → Refresh: **only on screen**, off-screen projects are not read until you scroll them into view — and nothing is read at all while no page is open. |
| A worktree will not delete | An agent run is live in it — stop the run first. |
| The assistant says it started a worker but nothing appeared | Look at the strip above **New agent** and at the `N spawn` pill on ✧ Assistant: in **ask** mode a SPAWN line is a card waiting for a click, not a run. If neither a card nor a worker exists two minutes after the turn, the journal carries a **lost SPAWN line** and the Alerts tab an alert naming the turn. |
| A column is too narrow or too wide | Drag the edge between two column headers (the pair trades width); **double-click** any edge to go back to the measured split. Widths are remembered in this browser, so a reset is per browser too. |
| `revive` is refused | That session already has a card on the board. |
| A console result is cut short | The run stream carries a preview, not the full payload. See the README's troubleshooting section. |

More in the [README](../README.md#troubleshooting) and [SETUP.md](../SETUP.md). The panel's internals — how rows are
produced, what each route does, the gateway protocol — are in the README.