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
| `port`, `host` | bind address. Keep `127.0.0.1` — this panel spawns processes, so exposing it is remote code execution. |
| `projects` | optional per-repo overrides: `remote` name, `mainBranch`, `prRepo` (for PR lookups). |
| `hermesBin`, `defaultCwd` | optional; auto-detected. |

No `config.json`? The panel starts on defaults and logs that it did, so a bare `node server.js`
still comes up.

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

## 6. Failure modes and what they mean

- **`EADDRINUSE` on start** — something already has the port. `stop-background.cmd`, or change `port`.
- **No projects listed** — `scanRoots` is wrong, or the directories in it are not git repos. Non-git
  directories are named in the footer as "skipped" rather than hidden.
- **Spawn refused: "has no commits yet (unborn HEAD)"** — `git worktree add` needs a HEAD to branch
  from, so that repo needs an initial commit before it can host worktrees.
- **Spawn fails with `503 the Hermes gateway API is not usable at …`** — the gateway is not running,
  or `API_SERVER_KEY` is missing from `$HERMES_HOME/.env`. `hermes gateway restart`, and check the
  `api: up / api: down` chip in the New-agent header for which one it is.
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
