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
- **Spawn fails with "No API key found for provider 'openrouter'"** — the spawned CLI did not find a
  key: put it in `$HERMES_HOME/.env` (the CLI loads that itself) or export `OPENROUTER_API_KEY`
  before starting the panel. On Windows the panel also falls back to `HKCU\Environment`.
- **A row shows `ERROR`** — that worktree could not be read; the row detail names the reason.
- **Windows-only bits**: cancelling a job uses `taskkill`, and the `:port` / `● board` liveness
  signals read `netstat` / `tasklist`. Off Windows those two signals stay dark and Cancel is a no-op;
  scanning, verdicts, spawning and replies all still work.

## 7. Using it

- The green **+** beside a project name aims the spawn card at that project and puts the cursor in
  the prompt. **start in** is an editable path field if you want something else.
- Each agent runs in its own worktree (`hermes chat -w`) and gets a named Hermes thread; **reply to
  its card any time** to continue the same session. Turn 1's worktree is removed automatically if it
  made no commits.
- Projects are ordered most-recently-worked-on first and start minimized.
