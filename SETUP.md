# Setup on a new machine (agent-executable)

Every command here is meant to be run verbatim — by a Hermes agent or by you. There is nothing to
install: **Node 22.5+ is the only hard requirement**, because the panel is zero-dependency. The
floor is 22.5, not 18: the server reads Hermes' `state.db` through `node:sqlite`, which does not
exist before 22.5, and five modules import it statically — on an older Node the process fails to
start at all.

---

## Point an agent at it

The repo is public, so raw URLs work unauthenticated and one line is enough — paste this, substituting
that machine's repo directory:

> Fetch https://raw.githubusercontent.com/JLRoper/agent-worktree-gui/main/SETUP.md and follow it.

If it is ever made private again the raw URL stops working and the agent needs `gh` to clone instead
(`gh repo edit JLRoper/agent-worktree-gui --visibility public` is the way back):

> Clone `JLRoper/agent-worktree-gui` with `gh` (it is private), then follow `SETUP.md` inside the
> clone: set `scanRoots` = `TODO: where your repos live`, start it, run the verification steps in
> section 5, and tell me the URL to open.

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
| Node 22.5+ | `node --version` | everything — `node:sqlite` needs 22.5, and no `npm install` is needed |
| git | `git --version` | every scan (the panel shells out to git) |
| Hermes CLI | `hermes --version` | **only** spawning agents; monitoring works without it |
| an OpenRouter key | `hermes auth`, or `$HERMES_HOME/.env` | **only** spawning agents |
| `gh` | `gh auth status` | **only** PR columns: the panel runs `gh pr list` for a project that names a `prRepo`. Missing or unauthenticated, the PR column reads none and every other column still works — measured on a box with no `gh` installed at all. Cloning does not need it; the repo is public |
| the commit-subject hook | in the **clone root**, `git config core.hooksPath` prints `.githooks`; nothing printed means `npm run hooks:install` was never run | keeping `wip`-style subjects out of main's history — one install covers every worktree of the clone |
| the version-bump hook | the same `core.hooksPath` check, and `node tools/version.mjs suggest` runs | refusing a push of a branch whose own commits carry no version bump (`docs/versioning.md` is the scale). Install it **before** the panel cuts a worktree — see below |

`setup.cmd` (Windows) or `./setup.sh` (macOS/Linux) checks the first three and tells you what is
missing.

Read the `core.hooksPath` check from the clone root, never from inside a worktree. A worktree the
panel cut prints an absolute `<common-dir>/wtgui-hooks` — that is the panel's own push guard, which is
what the worktree is supposed to run, and not evidence that the two hooks are missing. Whether the
guard still runs the version gate is written beside it: `wtgui-guard.json` records the hooks path the
guard found (`previousHooksPath`) and `chain` holds the `pre-push` it chains. An empty `chain` means
that worktree pushes with no version gate — the state of every worktree cut before `hooks:install`
ran, because the guard can only chain a `pre-push` that existed when it took the hooks path.

## 2. Clone

    git clone https://github.com/JLRoper/agent-worktree-gui.git
    gh repo clone JLRoper/agent-worktree-gui        # only if it is private again: needs gh auth

Then install the hooks once per clone — it is repo config, so one install covers every worktree of the
clone. Both hooks live under `.githooks/` (the commit-subject one, and the pre-push one that refuses a branch
whose own commits carry no version bump — see `docs/versioning.md`):

    npm run hooks:install          # git config core.hooksPath .githooks
    # the index stores the scripts executable (100755); run chmod +x .githooks/commit-msg and
    # chmod +x .githooks/pre-push only if a non-Windows checkout ever loses the bit

## 3. Configure — one file

Edit `config.json`. Only `scanRoots` normally matters:

| key | what to set |
| --- | --- |
| `scanRoots` | the directory your repos live in. Every git repo directly under it becomes a project. Defaults to the folder the panel sits in. |
| `port`, `host` | bind address. `127.0.0.1` keeps it local. `0.0.0.0` puts the board on the LAN or tailnet: a remote browser authenticates once by opening `http://<this-machine>:7331/?token=…`, but only writes are gated — reads stay open to anyone who can reach the port, so never expose it to a public network. |
| `PANEL_TOKEN` (environment, not a key here) | the secret behind `?token=…`. Set it in the environment the panel inherits — `setx PANEL_TOKEN "<43 random chars>"` on Windows, then restart the panel — and keep it out of `config.json`, which is tracked by git. With it unset, writes from other machines are refused. |
| `projects` | optional per-repo overrides: `remote` name, `mainBranch`, `prRepo` (for PR lookups — that column needs `gh` on PATH) |
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
whichever machine runs the gateway — not only the one where you first saw the box. The `clarify` line
decides whether the tool is *offered*; the gateway **build** decides whether a question it asks can be
delivered, and install is not configuration:

```bash
node tools/check-gateway-clarify.mjs --probe   # 0 = route there, 1 = absent, 2 = undecided (see section 5)
```

**Current builds ship the route.** Measured on Hermes Agent v0.22.4: `gateway/platforms/api_server_runs.py`
registers `POST /v1/runs/{run_id}/clarify`, so a current install needs the config line above and no
patch. The probe cannot confirm that on this box — an auth layer answers `403` to the `OPTIONS` probe
and to its approval control alike, so it exits `2` and settles nothing (section 5 says how to settle
it against the source). Older builds are the case the next paragraph covers.

A build without the Runs API clarify route hands the agent the tool and refuses every call with
`Clarify tool is not available in this execution context.` — the box can never appear, however the
config file reads. Until the gateway has it, the panel says so on the card once and tells agents to
ask in prose at the end of the turn, which the `question` rule still escalates to you. Everything
behind that is in `docs/clarify-over-the-runs-api.md`. Verify both halves (section 5).

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
5. `hermes config get platform_toolsets.api_server` → the list **contains `clarify`**. This decides
   whether the tool is offered, and it is easy to miss because everything else works without it
   (section 6). It is **not** sufficient on its own: the installed build must also carry the Runs API
   clarify route, or the tool is offered and refuses every call. Check that half too —
   `node tools/check-gateway-clarify.mjs --probe` → exit `0` the route is there, `1` it is absent,
   `2` undecided. Read the exit code before the verdict line: `2` means something in front of the
   router answered `403` to both the clarify probe and its approval control, so the probe settled
   nothing and it is not a verdict against the build. Settle that case against the build itself —
   the route is a line in the gateway's runs module:
   `grep -c 'v1/runs/{run_id}/clarify' "$HERMES_HOME/hermes-agent/gateway/platforms/api_server_runs.py"`
   → nonzero means it is there.
6. `node tools/merged-branches.mjs` → every local branch, the PR that owns it and a verdict. Read the
   verdicts; never `git branch --merged main`. The ruleset requires linear history, so a merged PR's commits
   are re-created and its branch stays "ahead by N" forever — **"ahead by N" is never a merge signal in this
   repo**. `--prune` deletes the branches a merged PR accounts for (local refs only; open PRs, the default
   branch, worktrees and branches with no PR are kept).
7. `git commit --allow-empty -m wip` in a scratch clone → refused by the hook; a subject that names the
   change goes through. Then remove the scratch clone. The hook is local: it binds this machine only, and this
   repo has no CI, so nothing refuses a bad subject at PR time either.
8. `node tools/verify-version-bump.mjs` → `VERIFY-VERSION-BUMP-OK`. It builds a throwaway repo with a bare
   remote and proves the whole bump pipeline in it: `suggest` reads the level off the commit prefixes and says
   so when one is missing, `check` refuses an unbumped branch and goes quiet once it is bumped, `apply` writes
   `package.json` and nothing else, and a real `git push` is refused by `.githooks/pre-push` until the bump is
   committed. Then bump your own branch — `node tools/version.mjs apply <level>` — in the same PR as the
   change. `docs/versioning.md` has the scale.

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
- **The PR column reads `none` for a project that has pull requests** — `gh` is missing or
  unauthenticated (`gh auth status`), or that project names no `prRepo` in `config.json`. The panel
  runs `gh pr list --repo <prRepo>` and swallows the failure, so the column goes quiet rather than
  showing a wrong state. This is the only thing `gh` is for.
- **A commit landed with a subject like "wip"** — the hook is not installed in this clone: run
  `npm run hooks:install`. A local hook binds this machine and this clone only — this repo has no CI, so
  nothing refuses a bad subject at PR time either — and its own author can bypass it with
  `git commit --no-verify`. On a non-Windows clone also check `ls -l .githooks/commit-msg` for the
  executable bit.
- **`pre-push: refused — <branch> would go out with no version bump`** — this branch's own commits carry a
  code change but `package.json` still holds the version its base has: decide the level from the diff
  (`docs/versioning.md`), run `node tools/version.mjs apply <patch|minor|major>`, commit it, push again. That
  is deliberate, not something to go around: `git push --no-verify` bypasses it if the refusal is wrong.
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
