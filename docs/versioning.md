# Versioning this panel

The version is one number, declared once, in `package.json`'s `"version"`. The server reads that field and hands
it to the page, which prints it on the board's own config line (`v0.84.0 · 9 project(s) · …`), so a bump is a
one-line change and is visible where you already look. Two things anchor the number to history: an annotated
`v<version>` tag at the commit that first declared it, and `CHANGELOG.md`, rendered from the commits between
consecutive tags. `npm run verify:version-tags` fails when a bump has no tag; `npm run changelog` rewrites the
changelog and `npm run changelog:check` fails when it is stale.

## The tag, and the changelog it renders

A version number is anchored by an annotated tag, `v<version>`, at the commit on `main` that first declared it,
and `CHANGELOG.md` is rendered from the commits between consecutive tags — so the two cannot describe different
history. The gate is `npm run verify:version-tags`: it walks `git log -p --follow -- package.json` and fails when
a bump has no tag at its commit, when the tag points at another commit, when it is lightweight, or when it names
a version `package.json` never held.

A rebase merge re-creates the branch's commits on `main` with new shas, so the anchor has to move with them.
`node tools/version.mjs apply <level>` does the anchoring itself: on a clean tree it writes the number, commits it as
`chore: <version> — the version this landing carries`, and creates `v<version>` annotated on that commit — so the
branch carries a tag the gate can read. On a dirty tree it writes the number and stops, saying which it did,
because a tag belongs to a commit that carries the bump and nothing else; commit the change by hand, then
`node tools/version.mjs tag`. Once the PR has merged, move the anchor onto the commit `main` carries — never leave
it on the branch's pre-merge tip:

    node tools/version.mjs tag --ref origin/main --force
    git push origin v<version> --force

`node tools/version.mjs tag` refuses a dirty tree, refuses to move an existing tag without `--force`, and is a
no-op (exit 0) when the tag already names the right commit.

A bump that reached `main` without its tag is repaired by one idempotent pass:

    node tools/version.mjs backfill --push

It tags every version in `package.json`'s history that has none, at the commit the walk says first declared it,
and sends only the tags it created. An already-anchored version is counted and skipped, so a second run creates
nothing and exits 0 — it never duplicates a tag, and it will not rewrite a pushed one.

## The changelog lands with the bump

A PR that bumps `package.json` renders `CHANGELOG.md` in the same PR. The number is the promise and the changelog
is the account of it: one branch is one revertable unit, and a render that lands later is a follow-up nobody owns.
Both gates are executable, and both run before the push:

    node tools/changelog.mjs --check    # exit 1 unless CHANGELOG.md is what this branch's history renders
    node tools/land.mjs --check         # exit 1 when the base the PR lands into is stale at its merge base

The first must be green, with the render committed as its own `docs: render the changelog …` commit — never folded
into the bump it describes. The second must not be red: a base already missing a release cannot be repaired by a
section added on top of it, so render every missing section in this PR. One render emits them all.

A render that is the whole PR — a housekeeping commit that catches the file up — spends no number and creates no
tag: it lands at the base's own version.

**A section rendered on a branch is re-checked at the merged tip.** Every section links the shas of the commits it
lists, and a rebase or squash merge re-creates them. The branch render is the file the gate read and the PR carries;
it is not the landing's last word:

    git fetch origin main && git checkout -B main origin/main
    node tools/land.mjs --check         # a section names a sha main does not carry
    npm run land                        # re-render, commit only CHANGELOG.md, push, prove

`node tools/land.mjs` re-renders from the base's own history, refuses a branch, a dirty tree or a base that moved,
commits the render as its own docs commit (no version, no tag), pushes the base with it, and proves itself by
re-rendering (`land: CHANGELOG.md is current — N releases, nothing to render` on a second run). That is the repair
the merge made necessary, not a second landing: the section now names the shas `main` carries. The working proof is
one ancestry test per sha the newest section links:

    git merge-base --is-ancestor <sha> origin/main

## The bump is a judgement, made by the agent landing the change

A version number answers one question: *who outside this PR can this break, and how much?* That is a question
about the diff, and the only reader who has the diff is the agent landing it. So:

- **the level is the landing agent's call**, not the tool's and not the hook's. `node tools/version.mjs suggest`
  reads the commits and prints an advice; that advice is a floor to argue with, not an answer.
- **the bump goes in the same PR as the change it describes.** One branch is one revertable unit, landed as one
  commit on main, so the version that names the change has to travel with it. A bump landed separately cannot be
  reverted with the thing it was describing.
- **the same level, and the reason for it, go in the PR body and in the commit the change lands with** — the
  squash merge composes main's commit body out of this branch's own subjects, so a bump with no reason behind it
  becomes a version number in main's history that nobody can account for.

## The three levels

### major — a contract someone outside the PR depends on breaks

Someone else's file, habit or code stops working. In this panel that means, for example:

- **a store the panel reads back changes shape** — the job store it reloads on restart, the description record
  and its own `DESCRIPTIONS_VERSION` (`lib/descriptions.js`), `assistant.json`, the charter file. An old file
  that no longer loads, or loads as something else, is a broken contract.
- **an action line's grammar changes** — the lines a model is told to write and the panel is told to carry out
  (`lib/assistant/actions.js`). Every line a model already wrote stops meaning what it said.
- **a route's payload changes** — a route the page is built around (`/api/settings`' `settings` object, the SSE
  snapshot) losing a field or changing a shape, for anyone with a client, a bookmark or a script of their own.
- **a config key goes away** — `config.json` is the reader's file. Removing or renaming a key makes their file
  stop meaning what it says.
- **a gesture is swapped** — the shape of `Swap the reply box's gestures: Ctrl+Enter steers, Enter holds the
  reply`: muscle memory is a contract too, and everyone who learned the old one is broken by it.

No merge on main has been landed as a major yet: `0.2.0` was declared wholesale, not derived
(`Bump version to 0.2.0`), so the first major is the first real break.

### minor — a new capability that breaks nothing

Something the panel could not do before, added without moving what already exists:

- **a new section or strip** — `Add a Charter tab beside Scratchpad that reads and edits the file`.
- **a new source of rows** — `Monitor Claude Code sessions alongside Hermes`.
- **a new reader-facing affordance** — `Collapse a big paste into one inline chip the reader can quote, unfold
  and delete`.
- **a new route, or a new field on one** — additive, and the old shape still answers.
- **a new harness that enforces something** — a check that can now fail a landing (`Put the chart's age collapse
  under a browser proof`) is a capability the repo did not have. This is the one place the scale needs care: a
  *new* gate is a minor, while *changing an existing test* (below) is a patch.

### patch — a fix, a doc, a refactor, or a test-only change

Nothing new for a user and nothing broken for anyone:

- **a fix** — `Stop offering an approval the gateway has already decided`.
- **a doc** — anything under `docs/`, this file included.
- **a behaviour-preserving refactor** — `Lift the event-to-console translator into its own module`: the code
  moved, the panel behaves the same, and the module count is not a capability.
- **a test-only change** — adjusting, extending or repairing a harness, `A verify script's scratch store goes
  with its run`.

## What the tools do, and what they do not

| | |
|---|---|
| `node tools/version.mjs suggest` | reads the branch's commits (and its PR's title and body, when `gh` has them) against the base and prints the level it reads from the conventional-commit prefixes, with a reason per commit. It says so when a prefix is missing instead of guessing. **Advice — it writes nothing.** |
| `node tools/version.mjs check` | the pipeline's gate: it compares the number the branch would push (HEAD's `package.json`) with the number at the base ref's **current tip** (`origin/main`'s tree — never the merge-base, never this checkout's own file) and exits non-zero unless the branch is strictly above it. Two states are refused: the number unchanged while the branch carries commits to land, and the number **behind** a base that has moved (a branch cut before main bumped carries main's old number, and that is not a bump). It prints what it compared — branch version, base ref, base version — on **both** outcomes, so silence is never a pass. It exits 0 for a branch above the base, and for a branch with no commits of its own at the base's number (main itself). It refuses when it cannot resolve a base or read either version, rather than passing. It never writes. |
| `node tools/version.mjs apply <patch\|minor\|major>` | writes the new version to `package.json` — the one place it lives — and prints old and new. Run by the landing agent, deliberately; never by `check` and never by a hook. |
| `node tools/verify-version-tags.mjs` | the anchor's gate: walks `git log -p --follow -- package.json` and fails when a version that first appeared at a commit has no annotated `v<version>` tag there, when the tag points at another commit, when it is lightweight, or when it names a version `package.json` never held. `npm run verify:version-tags`. It exits 2, never a vacuous pass, when the walk comes back empty. |
| `node tools/changelog.mjs` | renders `CHANGELOG.md` from the commits between consecutive tags, newest first, grouped by the conventional-commit prefix; `--since v<version>` prints only what came after the build a tab is running, and `--check` fails when the file is stale. `npm run changelog`, `npm run changelog:check`. |
| `node tools/land.mjs` | **the merged-tip re-check and repair**, run on the base branch after the merge: re-renders the changelog from the base's own history (the shas the merge made), commits only `CHANGELOG.md` as a docs commit, pushes the base with the render, and proves itself by re-rendering. `--check` renders in memory and exits 1 when the base is stale or a section names a sha the base lacks (writes nothing); `--render` writes the file only, for a branch preview. Refuses on a branch, a dirty tree, or a base that moved. Idempotent: a second run commits nothing and leaves the tree clean. `npm run land`, `npm run land:check`. |
| `.githooks/pre-push` | makes forgetting impossible: it runs `check`, so a push cannot carry a bump-worthy branch with no bump. |
| the merge prompt (`lib/merge-prompt.js`) | tells the landing agent to decide the level from the diff, run `apply`, and state the level and the reason in the PR body and the commit. It makes `npm run land` PHASE 4 — the merged-tip re-check above — so a landing cannot finish with a stale changelog and a remembered second step is not part of the pipeline. |

The prefixes `suggest` reads are the ordinary ones: `feat:` → minor, `fix:`/`docs:`/`test:`/`chore:` → patch,
`!` after the type (or a `BREAKING CHANGE:` line in the body) → major. A commit with no prefix it can read is
reported as unclassified and the level it prints becomes a floor rather than an answer.
