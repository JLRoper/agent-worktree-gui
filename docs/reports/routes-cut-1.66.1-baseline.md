# Routes cut baseline, 1.66.1

Recorded 2026-11-08 16:33 -0500 in worktree `verify-the-landed-routes-cut-in-a-08ab98`, as run one
of the two-run verification. Run two reads this as the "before" side of its own pid and version reads.

## The checkout

- Primary checkout `C:/ProjectDevelopment/agent-worktree-gui`, branch `main`.
- Main tip `49982c19337c29fe68a21e5a413f7ea2d98ede64` (short `49982c1`), `package.json` version
  `1.66.1`. `main...origin/main` with nothing ahead or behind.
- No tracked changes. Six untracked artifacts are the reader's own and were left alone: `.kilo/`,
  `CODE_REVIEW.md`, `config.7330.json`, `docs/architecture.html`,
  `docs/reports/module-map-2026-11-07.html`,
  `docs/reviews/settings-pipeline-flow-2026-11-05.local-keep.html`.
- `git pull --ff-only` answered "Already up to date." because the fast-forward had already landed
  at 16:31:00 -0500 as a merge of `origin/main`. The reflog row is
  `49982c1 HEAD@{2026-11-08 16:31:00 -0500}: merge origin/main: Fast-forward`.

## The commits the cut arrived in

- `45a34b7` refactor: the pipelines prefix moves into routes/pipelines.js, mounted from the prefix table
- `49982c1` chore: 1.66.1 - the version this landing carries
- Delta over the previous tip: `package.json`, `routes/pipelines.js`, `server.js`.

## The modules

- `routes/state.js` 2745 bytes, `routes/jobs.js` 16595 bytes, `routes/pipelines.js` 9380 bytes.
- `server.js` imports them at lines 113, 117 and 133, and mounts the pipelines prefix as a row of
  the prefix table at line 1294.

## The panel

- Served version before: `1.60.4` (GET `/api/config`, read at 16:29).
- Served version after: `1.66.1` (GET `/api/config`, and `serving` on GET `/api/changelog?limit=1`).
- Pid before: 110608, booted 14:18:27. That process no longer exists.
- Pid after: 109544, booted 16:31:25, which is 25 seconds after `package.json` was written at
  16:31:00.932, so it booted after the pull rather than before it.
- Restart entry `5c98ccf2`, target `panel`, state `done` at `2026-11-08T21:31:32.621Z`; its proof
  run `run_2558091fa483402194606df81e915475` answered `PANEL-RESTART-OK` in 1674 ms.
- That restart was asked for by the operator's own turn ("pull agent-worktree-gui from remote main
  to local, then restart thes service"), not by this run.

## What it means for run two

- The served version equals the main tip, so the new routes modules are already live. The brief's
  step 3 premise, that the panel still serves an older build, no longer holds.
- No restart is queued: `queued[]` is empty, and `lib/restart.js` lines 631 to 635 refuse a panel
  restart when the checkout's `package.json` version equals the one being served. A RESTART panel
  line written now would come back 409, not fire.
- GET `/api/pipelines` answers 200 with 1054 bytes, so the catalogue route mounted out of
  `routes/pipelines.js` is answering on the live process.
- Run two does not have to wait for a bounce. Re-read the pid to confirm it is still 109544 and the
  served version still 1.66.1, then browser-verify the pipeline list, the flow map and one
  pipeline's detail, and rebuild the module report as an HTML page under `docs/reports/`.

## Update, 16:55 - main moved to 1.66.2 and the panel followed

Main moved again while run one was still reading, and the panel caught up on its own a second time.
Everything below was read after 16:47 and is the state run two should start from.

- At 16:47:03 the primary checkout fast-forwarded again: `git pull --ff-only origin main` moved
  `main` from `49982c1` to `499aa48` ("docs: render the changelog - 448 releases"), on top of
  `04c1b98` ("feat: consolidation is the assistant's job, under the reader's grant"). `package.json`
  now reads `1.66.2`, so the main tip and the served build agree again.
- The 1.66.2 delta touches `CHANGELOG.md`, `docs/design/prompt-tiers-2026-11-08.md`,
  `lib/assistant.js`, `lib/assistant/actions.js`, `lib/assistant/consolidate.js` (new, 412 lines),
  `lib/assistant/profile.js`, `lib/assistants.js`, `package.json`, `public/assistant.js`, `server.js`
  and `test/assistant-consolidate.test.js`. `routes/` is untouched by 1.66.2.
- At 16:47:25 a new panel process, pid `17560`, started 22 seconds after that pull. Its CommandLine
  is `"C:\Program Files\nodejs\node.exe" server.js`, and port 7331 listens on it. It serves `1.66.2`
  on GET `/api/config`, so the served version equals the main tip. Pid `109544` no longer exists.
  The new process's restart ledger is empty (`queued []`, `last null`), so this bounce did not arrive
  through the queue.
- GET `/api/pipelines` still answers 200 with 1054 bytes on the 1.66.2 build, so the routes prefix is
  mounted in the running graph as well as in the 1.66.1 one.
- Therefore the step 3 premise no longer holds in either direction: the served version is not behind
  the main tip now (`1.66.2` both sides), and the routes modules have been live since the 16:31:32
  bounce. A `RESTART panel` request written now is refused by `lib/restart.js`, because the
  checkout's `package.json` names the same `1.66.2` the panel already serves; the guard calls that a
  bounce for nothing.
- The branch is 2 commits behind `origin/main`. A push would be refused twice: base drift first, then
  `tools/version.mjs check`, because the branch still carries `1.66.1` while main carries `1.66.2`.
  Run two should rebase onto `origin/main`, apply a patch bump (`node tools/version.mjs apply patch`,
  which lands `1.66.3`), then push and open the pull request with the report commit.
- For the browser pass: `~/.wag/state/pipelines.json` and `pipelines.seed.json` both hold an empty
  `pipelines` list, while `~/.wag/state/pipeline-bundle.json` holds 4 pipelines. The bundle's own
  PDL check reports `incomplete-gate` on `author-review-revise`: gate G1 declares outcomes accept and
  reject with no routes map. The flow map may draw that as a validation error rather than a route.
