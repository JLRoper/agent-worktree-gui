# Landing: the generated report pile is pruned and indexed (1.112.1)

PR #776 removes what the board generated and stopped reading, keeps what a test, a doc or a standing decision still
cites, and records every judgement in `docs/reports/INDEX.md`. Out of 252 files judged, **152 are kept, 19 are
folded and 81 are dropped**. `docs/reports/` carries 147 tracked files before the pass and 68 after; its top level
goes from 80 entries to 38 (35 pages plus the three capture directories that stay).

Merge `eb69d9b`, tag `v1.112.1` at `eb69d9b`, `origin/main` at `bec8a9b` (the render), `changelog --check` reads
current - 619 releases. What a reader can open: `docs/reports/INDEX.md`.

## The judgement, in the order it was made

Three criteria, applied in order, on every tracked file under `docs/reports/` and every file directly under `docs/`:

1. **Keep** anything a test, a code comment or a live doc cites; anything that records a standing decision, a
   landing record, or a measurement still in force.
2. **Fold** a draft or a duplicate into the surviving report: the finding that still matters moves there, the file
   goes.
3. **Drop** a one-off measurement whose finding has landed and been fixed, and a cleanup record whose actions are
   done.

The pile divides as 119 pages and 33 captures kept, 19 folded, 81 dropped. `INDEX.md` gives one line per kept
report on what it records and why it stays, names each folded and dropped file with the reason it went, and counts
the nested collections under `docs/` (`reviews/`, `research/`, `snapshots/`, `design/`, `perf/`, `cleanup/`,
`rounds/`, `pipeline-integration/`, `plan/`, `runbooks/`, `pipelines/`) at the end rather than pruning them in this
pass: those are review ledgers, captures and research series a running row reads, not the generated pile.

## Two gaps the index names rather than papering over

1. **`docs/reports/module-map-2026-11-07.html` is cited and absent.** Twenty-one references across thirteen files
   name it as the module split's order of work. No commit in this clone ever deleted it, so the page was renamed to
   `module-map-2026-11-08.html` (which stays) without the references following. A later pass should repoint them at
   the page that exists. The primary checkout also still holds three untracked pages under `docs/reports/` that no
   commit has ever carried, `module-map-2026-11-07.html` among them, so a bare listing there reads 41 entries
   against the 38 tracked.
2. **The pre-push absolute-paths gate refused every push from this base.** `origin/main`'s own tree carried two
   drive-letter paths: a provenance line in `docs/reports/held-reply-restart-2026-11-16.html` and a placeholder in
   `tools/verify-held-reply-restart.mjs`. `41b6bd7` allowlisted both so the gate could run again; this branch goes
   one step further on the placeholder, rewriting it to a path a reader can type and dropping its allowlist line,
   and leaves the report line allowlisted with its reason because it records what ran.

## The proof

The pass itself was proved when it was made and was not re-run for this landing. What the landing verified is that
the changed set and the index are intact:

- `node tools/absolute-paths.mjs --rev 4d3e9836` - clean: 1690 files, 1345 paths in 250 allowlisted files, none new.
- The focused test set the diff names, 18 files (`absolute-paths`, `land`, `land-pr`, `land-subject-dashes`,
  `changelog-incremental`, `changelog-links`, `changelog-scope`, `release-tags`, `version-claim`,
  `version-subject-dashes`, `version-tags`, `version-check`, `static-page-roots`, `push-guard`, `test-select`,
  `pipeline-wait`, `terminal-brief`, `tool-timing`): **155 tests, 155 pass, 0 fail**. The pages a test reads are
  still there - `pipeline-execution-next-moves-2026-11-10.html`, `terminal-call-latency-2026-11-11.html` and
  `jitter-synthesis.md` all survive - and the capture paths the verify tools write into are output directories the
  tools create, not reads of the files this pass dropped.
- No reference in code or tests points at a deleted page: the only mentions left are a comment in
  `tools/verify-console-jitter.mjs` naming two investigation files that were folded into `jitter-synthesis.md`.

The push went through the hook. Nothing was pushed with `--no-verify`: the gate was already green at `4d3e9836`, so
there was nothing to bypass. The one `--no-verify` push in this landing's record is `tools/land.mjs` sending the
changelog render commit, which is the tool's documented path - every commit it sent touches only `CHANGELOG.md`,
and a render spends no version.

## Where it stands

- PR #776: MERGED, merge commit `eb69d9b`.
- `origin/main`: `bec8a9b` (the render), `changelog --check` current at 619 releases.
- `v1.112.1`: annotated, on `origin`, peeled to `eb69d9b` - the commit that first declared the number.
- The worktree that did the work is clean and can be released.
