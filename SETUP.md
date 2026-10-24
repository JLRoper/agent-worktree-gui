# Setup on a new machine (agent-executable)

Every command here is meant to be run verbatim — by a Hermes agent or by you. There is nothing to
install: **Node 18+ is the only hard requirement**, because the panel is zero-dependency.

---

## Point an agent at it

The repo is private, so an agent needs `gh` to reach it. Paste this, substituting that machine's
repo directory:

> Clone `JLRoper/agent-worktree-gui` with `gh` (it is private), then follow `SETUP.md` inside the
> clone: set `scanRoots` = `TODO: where your repos live`, start it, run the verification steps in
> section 5, and tell me the URL to open.

Make the repo public (`gh repo edit JLRoper/agent-worktree-gui --visibility public`) and one line is
enough instead, since raw URLs then work unauthenticated:

> Fetch https://raw.githubusercontent.com/JLRoper/agent-worktree-gui/main/SETUP.md and follow it.

One thing a clone does **not** carry: the panel's own operating skill lives in the **Hermes profile's
skills directory**, not in this repo — on the author's machine that is
`$HERMES_HOME/skills/autonomous-ai-agents/multi-agent-workspace/`, which carries the panel's
invariants, the fleet audit and the redeploy sequence. A machine that only clones this repo has never
read it, so a setup that stops at this file is only half the picture; point the agent at that skill
too when the profile has one.

---

## 1. Prerequisites

| need | check | required for |
| --- | --- | --- |
| Node 18+ | `node --version` | everything — no `npm install` is needed |
| git | `git --version` | every scan (the panel shells out to git) |
| Hermes CLI | `hermes --version` | **only** spawning agents; monitoring works without it |
| an OpenRouter key | `hermes auth`, or `$HERMES_HOME/.env` | **only** spawning agents |
| `gh` | `gh auth status` | cloning (the repo is private) and PR columns |

`setup.cmd` (Windows) or `./setup.sh` (macOS/Linux) checks the first three and tells you what is
missing.

## 2. Clone

    gh repo clone JLRoper/agent-worktree-gui        # private: needs gh auth
    # or, once public:  git clone https://github.com/JLRoper/agent-worktree-gui.git

## 3. Configure — one file

Edit `config.json`. Only `scanRoots` normally matters:

| key | what to set |
| --- | --- |
| `scanRoots` | the directory your repos live in. Every git repo directly under it becomes a project. Defaults to the folder the panel sits in. |
| `port`, `host` | bind address. `127.0.0.1` keeps it local. `0.0.0.0` puts the board on the LAN or tailnet: a remote browser authenticates once by opening `http://<this-machine>:7331/?token=…`, but only writes are gated — reads stay open to anyone who can reach the port, so never expose it to a public network. |
| `PANEL_TOKEN` (environment, not a key here) | the secret behind `?token=…`. Set it in the environment the panel inherits — `setx PANEL_TOKEN "<43 random chars>"` on Windows, then restart the panel — and keep it out of `config.json`, which is tracked by git. With it unset, writes from other machines are refused. |
| `projects` | optional per-repo overrides: `remote` name, `mainBranch`, `prRepo` (for PR lookups). |
| `hermesBin`, `defaultCwd` | optional; auto-detected. |

No `config.json`? The panel starts on defaults and logs that it did, so a bare `node server.js`
still comes up.

### The gateway settings the two popups need

The panel draws two kinds of parked turn: an **approval card** (amber — a command Hermes flagged) and
the agent's own **question box** (light purple — the `clarify` tool). The panel's half of both is in
this repo and needs no configuration. Hermes' half does, and it lives in `$HERMES_HOME/config.yaml`:

| setting | command | why |
| --- | --- | --- |
| the `clarify` toolset | `hermes config set platform_toolsets.api_server '["hermes-api-server","clarify"]'` | The stock `hermes-api-server` toolset drops interactive UI tools, so a panel-spawned agent has no `clarify` tool at all: its questions stay prose in the console and no box is ever drawn. |
| manual approvals | `hermes config set approvals.mode manual` | Every flagged command parks for a person. Under the `smart` default the ones Hermes judges safe are auto-approved, so a card appears only sometimes. |
| the builtin transport | `hermes config set security.approval.transport builtin` | The panel answers on the run's own SSE stream (`approval.request`, `clarify.request`). A plugin transport is superseded here and must not be selected. |

**These are per machine and per profile.** The three lines belong in the `$HERMES_HOME/config.yaml` of
whichever machine runs the gateway — not only the one where you first saw the box — and the `clarify`
line is the one that decides whether the box appears at all. Verify it there (section 5).

The box itself is host-agnostic and lives in this repo: `lib/jobs.js` turns the gateway's
`clarify.request` event into a pending question on the job, `public/app.js` draws the box, and the
answer returns through `POST /api/jobs/answer` to `POST /v1/runs/{id}/clarify`.

### A sandbox to click around in

A second instance can run from the same code with its own config and port, so you can try spawning
agents into throwaway worktrees without touching real projects:

    set PANEL_CONFIG=C:\path\to\panel-config.json
    node server.js

Point that config's `scanRoots` at a scratch directory containing a dummy repo (plus a worktree or
two) and `port` at something free; `start.cmd` / `stop-background.cmd` in the repo still work, they
just read whatever `PANEL_CONFIG` names.

## 4. Run

    start.cmd          # Windows: detached, logs to logs\server.out.log, stop with stop-background.cmd
    node server.js     # any OS: foreground (Ctrl+C to stop)
    npm start          # same as node server.js

Then open **http://127.0.0.1:7331**.

## 5. Verify — do not assume

1. `curl -s http://127.0.0.1:7331/api/health` → `{"ok":true,...}`
2. `curl -s http://127.0.0.1:7331/api/state` → your projects are listed and `worktrees` is non-empty
   for the ones that have worktrees.
3. `node tools/verify-verdicts.mjs <project>` → `mismatches: 0`. This re-derives every row's merge
   verdict straight from git and diffs it against what the panel reports.
4. In the UI: each project is minimized to its title line; open one and check the rows carry a
   branch, tip, ahead/behind and a verdict.
5. `hermes config get platform_toolsets.api_server` → the list **contains `clarify`**. This is the one
   setting that decides whether an agent's question can become a box, and it is easy to miss because
   everything else works without it (section 6).

## 6. Failure modes and what they mean

- **`EADDRINUSE` on start** — something already has the port. `stop-background.cmd`, or change `port`.
- **No projects listed** — `scanRoots` is wrong, or the directories in it are not git repos. Non-git
  directories are named in the footer as "skipped" rather than hidden.
- **Spawn refused: "has no commits yet (unborn HEAD)"** — `git worktree add` needs a HEAD to branch
  from, so that repo needs an initial commit before it can host worktrees.
- **Spawn fails with `503 the Hermes gateway API is not usable at …`** — the gateway is not running,
  or `API_SERVER_KEY` is missing from `$HERMES_HOME/.env`. `hermes gateway restart`, and check the
  `api: up / api: down` chip in the New-agent header for which one it is.
- **The agent asks you something in prose and no light-purple box appears** — `clarify` is missing
  from `platform_toolsets.api_server` on the machine running the gateway, so the panel-spawned agent
  has no `clarify` tool and its question is only text in the console. Set the line in section 3 and
  restart the gateway. A question already asked in prose cannot be retro-answered — the run has to ask
  again.
- **A row shows `ERROR`** — that worktree could not be read; the row detail names the reason.
- **Windows-only bits**: the `:port` / `● board` liveness signals read `netstat` / `tasklist`. Off
  Windows those two stay dark; scanning, verdicts, spawning and replies all still work.

## 7. Using it

- The green **+** beside a project name aims the spawn card at that project and puts the cursor in
  the prompt. **start in** is an editable path field if you want something else.
- Each agent runs in its own worktree (the panel creates `wtgui/…` under `.worktrees/`) and gets a
  named Hermes session. **Reply to its card** to continue that session — while a turn is still
  running the button reads **Steer turn** and the text reaches the live turn instead of waiting.
  Worktrees are yours to keep: nothing removes them automatically.
- Projects are ordered most-recently-worked-on first and start minimized.
