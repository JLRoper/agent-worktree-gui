# Landing: a stage's own run, held in the wait book (1.41.0)

PR #461 landed the five commits of work the branch already carried, plus this record. No implementation was
redone - the code, the docs and the walk report were on it.

## The base moved four times while this was being landed

The branch was cut at 1.34.0 and said 1.35.0. `main` was 1.36.2 (`9078bb9`) when the landing started and 1.40.1
(`0be4c06`) at the last fetch before the push: other lanes landed the pipeline-flow drag, a perf audit, two of
their own bumps and their changelog renders in between.

So the number is **1.41.0**, written by `node tools/version.mjs apply minor` against the base's own tip, which is
the next minor above whatever `main` holds (`docs/versioning.md`). The level is the branch's own judgement: a new
facility the panel acts on - a second kind of wait, and the ticker that owns the advance - not a reworded view.
The annotated `v1.41.0` tag sits on the bump commit, where `tools/verify-version-tags.mjs` reads it, and it is
moved onto the commit `main` carries after the merge.

    version check: ok - 1.41.0 above origin/main's 1.40.1 (0be4c06), 5 commits to land

## Both sides survived the rebase

One conflict, and it was only the version line in `package.json`. Everything else auto-merged, so the property was
checked rather than assumed: every line `main` added since the branch's original base (`9078bb9`) is present in the
rebased tree, except main's own `CHANGELOG.md` sections, which the landing re-renders at the merged tip.

    main lines added since 9078bb9: 1617   missing in HEAD: 10   (all ten in CHANGELOG.md)

Against `main`'s tip, per file:

| file | this branch | notes |
|---|---|---|
| `lib/jobs.js` | 106 added, 6 removed | the six are the branch's own replacements of the lines it rewrote |
| `lib/pipelines.js` | 63 added, 0 removed | main has not touched it |
| `server.js` | 5 added, 1 removed | the one is the sweep summary line the branch rewrites |
| `package.json` | 1 added, 1 removed | the version line only |
| `lib/assistant.js` | 62 added, 0 removed | |
| `lib/task-pipeline-drive.js` | 36 added, 1 removed | the driver signature, plus the hold's fallback check |
| `lib/projects.js`, `lib/push-guard.js`, `lib/push-permissions.js` | unchanged | the two red tests below live here, untouched |

The `v1/runs` submission path and the stage wait are both in `main`'s `lib/jobs.js` after the merge: the branch
never rewrote the runs code, and the merge is a replay of commits that add to it.

## Gates on the rebased tree

- `node tools/version.mjs check` - ok, 1.41.0 above `origin/main`'s 1.40.1.
- `npm run verify:pipeline-walk` - **34 / 34 checks passed**, exit 0. The timer walk crosses seven stage
  boundaries and the cap park with no hand-start and the queue untouched, and a restart mid-wait resumes from the
  book without starting a stage twice.
- `test/pipeline-wait.test.js`, `test/task-pipeline-drive.test.js`, `test/pipelines.test.js`,
  `test/task-pipeline-walk.test.js` - **68 / 68**.
- `npm test` - **1780 pass / 3 fail** of 1783. The three are named below; none of their files is touched by this
  branch.

## The three red tests, named

`git diff --name-only` against `main` lists neither `test/push-permissions.test.js` nor
`test/remote-writes-review.test.js`, nor `lib/push-permissions.js`, `lib/push-guard.js` or `lib/projects.js`.

1. `POST /api/settings/push-project round-trips one kind through config.json and /api/config`
   (86.3 s) - its `waitForRepo` window is 60 s and the discovery pass classifies the project after it. Run by
   name on this box the same test passes at 46-76 s (measured twice here, twice on `main`'s own tree at 63.8 s and
   55.2 s). The file's own comment says a tighter window turns the resolver's answer into a test of the machine.
2. `POST /api/settings/push-repo writes the repository defaults and its force-override` (82.7 s) - the same window,
   the same pass, on the same route family.
3. `under a policy of allow the hook reports the write and asks nobody` (35.9 s) - the harness kills the generated
   hook at 30 s. The same test fails identically on `main`'s own tree at the same commit this landing is based on
   (36.1 s, same assertion, same SIGTERM) and passes run by name at 16-17 s on both trees.

They are timeout races on a loaded Windows box, and the third fails on `main` itself. Reported, not papered over:
a red suite is not a green one, and these are the only three.

Two other findings, for the record:

- `tools/absolute-paths.mjs` refused every tree carrying `docs/perf/backend-2026-11-06.md` once that landed on
  `main` (five paths naming the machine that measured them). `main` recorded it in `tools/absolute-paths.allow`
  before this branch pushed (`0706653`), so this branch carries no allowlist change of its own: the duplicate a
  first attempt added here was dropped on the rebase.
- `npm run verify:version-tags` has one finding, older than this branch: `v1.32.1` points at `39d2e523`, while
  1.32.1 first appeared at `946578704c` (a `main` commit). That is the live wrong-commit tag
  `docs/research/version-integrity/A-version-numbers.md` already records; moving a pushed tag is a deliberate act
  and not part of this landing. `v1.41.0` is anchored at its own declaring commit.

## After the merge

The order is `docs/versioning.md`'s: bump on the branch, push, `gh pr merge --rebase --admin`, then render
`CHANGELOG.md` once at the merged tip (`npm run land`) and prove it (`npm run land:check`).
