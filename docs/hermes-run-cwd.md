# Prepared canonical Runs API cwd patch

Status: prepared for review and isolated testing only. Do not apply this to the running gateway or restart a service without separate approval. The panel's live cwd TODO remains open until an installed build passes a real post-restart cwd check.

## Scope

The companion `hermes-run-cwd.diff` targets the clean Hermes source at `bf0203a794a07aac3ff764972ab9087baa4e4f4e`. It adds an optional `cwd` to canonical `POST /v1/runs` for the local terminal backend. The panel already sends the assigned worktree in that field; stock Hermes ignores it. The diff is not committed to this repository yet — it was prepared and tested in the disposable export described below, so the name refers to that artifact until it is committed beside this doc; do not ask anyone to apply a file they cannot open.

This is not the historical `hermes-runs-api-knobs.diff`. That older combined patch hooks the legacy agent factory, which canonical runs bypass. Do not stack it onto this patch or infer that its max-turns, run-budget or approval behavior is part of this proposal.

No GUI behavior, global terminal cwd, approval policy, provider settings or live session data is changed by preparing this artifact.

## Contract

`cwd` must be a nonempty absolute path to an existing host directory. Null, booleans, arrays, objects, empty/relative paths, nonexistent paths and files are refused with HTTP 400 before run reservation or admission. Omitting the field keeps existing behavior; a previous run's cwd is not inherited.

The path is carried as a dedicated field in durable `api_turn_v1` admission, not as an inherited session setting. It is validated again in the physical worker. A directory removed while queued produces a failed, never-run turn naming the unavailable workspace, without a fallback directory or a model call.

The worker binds logical cwd and a copied terminal policy with ContextVars. A scoped terminal cwd record aligns the raw file-tool task id with the terminal route key, without changing persistent cwd records or installing global task overrides. The session's cached local environment cwd is restored when the physical worker returns. The agent cache key includes explicit cwd, so equal requests can reuse the agent while changing or dropping cwd rebuilds its frozen prompt.

The feature does not call `os.chdir` or write process environment variables. It relies on the canonical session FIFO's physical-worker serialization; it does not override native session, Bot Chat, hosted-room or legacy direct-worker workspaces. Non-local and refused terminal policies fail closed before any host-directory lookup. `features.run_cwd` is advertised only for a canonical local runtime.

## Verification method

Use a disposable `git archive` export, never another linked worktree and never the installed source as the write target. The included tests use a private HOME, USERPROFILE, HERMES_HOME and temp tree. Credentials and inherited session identity are stripped. A scripted loopback model drives the real canonical admission, real AIAgent and real terminal/read/write tools; no live provider is called and no tool result is synthesized.

The acceptance fixture separates sequential/cache, concurrent-process and policy/recovery cases into fresh processes. The concurrent terminal processes must both reach an absolute coordinator before release, then produce relative effects in their own directories. No prompt instructs an agent to cd and no terminal call supplies workdir.

AIAgent already updates the legacy `HERMES_SESSION_ID` display variable in both the unmodified baseline and candidate. Tests report that pre-existing exception explicitly; cwd/backend variables, process cwd and the private config must remain unchanged.

The baseline negative control runs the same I/O proof against the unmodified export. A valid failure is an observed default-directory read/pwd/write instead of the requested directory, not an import or setup error.

## Reproduce without installing

Build a disposable test environment through Hermes PM with the `messaging` extra and `dev`/`test` groups; the extra supplies aiohttp. Do not use bare pip or mutate the running gateway's environment.

From a clean exported copy of the pinned source, check then apply `hermes-run-cwd.diff` only inside that copy. Run `tests/gateway/test_api_run_cwd.py` and `tests/gateway/test_api_run_cwd_scope.py` through the canonical per-file test runner using that isolated interpreter. The fixture creates only ephemeral loopback listeners and private state.

An archive has no Git metadata: `scripts/run_tests.sh`'s optional `git ls-files` precompile can yield an empty argument list and walk the interpreter's sys.path. Invoke `scripts/run_tests_parallel.py` directly with an explicitly sanitized environment, or initialize a separate disposable repository for test metadata. Do not let precompilation write into the installed interpreter or gateway checkout.

On this Windows host, some long combined probes stalled while starting/waiting for Git Bash subprocesses. Those attempts are failures, not cwd passes. Keep their logs and run the separated acceptance cases; do not increase production timeouts or disable host security software to hide a test failure.

## Installation is a separate decision

After review, an operator must confirm the target source and clean state, retain a rollback copy, apply the checked patch to the intended profile's runtime source, and schedule a controlled gateway restart. Only then verify `features.run_cwd`, the first relative file read, terminal cwd and relative file write on two different workspaces and a continued session. This preparation does not perform or authorize those steps.
