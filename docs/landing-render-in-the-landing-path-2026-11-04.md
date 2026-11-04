# The landing renders the changelog itself — proven on main's own tip

The brief asked for three things: put the render inside the landing path so no landing can finish with a stale
`CHANGELOG.md`; make it idempotent; and use the real defect as the proof, rendering v1.3.0 so
`changelog:check` is green at 250 releases on `main` with no hand-written changelog edit in the diff. This
branch carries the mechanism and this record; the render itself happens on the base after the merge, which is
what `docs/versioning.md` already required and what no landing path enforced.

## What was wrong

The render was a second step a landing agent had to remember: "now run `npm run changelog`, commit it, push
it". A rule in a document is not a pipeline. Landings finished with a `CHANGELOG.md` that named every release but
the one that had just landed, `npm run changelog:check` stayed red, and the next reader found a release with no
section. The v1.3.0 section was missing from `main` exactly that way.

## The fix

`node tools/land.mjs` (npm `land`) is the landing's last step, run on the base branch after the merge. It is the
whole step, not a reminder:

- renders `CHANGELOG.md` from the commits between consecutive tags **as the base carries them now** — the shas
  the merge just made, never the branch's, which a rebase or squash merge re-creates;
- commits only `CHANGELOG.md` as its own docs commit — no version bump, no tag;
- pushes the base with the render;
- proves itself by re-rendering: `changelog: CHANGELOG.md is current — N releases`.

It refuses on a branch (the render belongs to the base's history), on a dirty tree, on a base that has moved
(`HEAD is N commits behind`), and on a base render naming commits the base does not carry. `--check` is the gate
shape and writes nothing; `--render` is the branch preview. `tools/changelog.mjs` exports `renderRepo` so the CLI
and the landing cannot disagree about the same history.

The landing path itself changed in `lib/merge-prompt.js`: PHASE 4 runs `npm run land` instead of a bare
`git push`, and the prompt forbids rendering on the branch. `.githooks/pre-push` now refuses a push of the base
branch while `CHANGELOG.md` is stale, naming the one command. A worktree branch's changelog is the base's
business; only a base push is gated.

## The proof, measured on `main`'s own commits

The proof runs in a scratch clone (no worktree, no branch surgery), against two real states of `main`:

### At `58ab40a` — the brief's 250-release state (v1.3.0's tip)

This is the state the brief measured: `package.json` at `1.3.0`, `CHANGELOG.md` naming 249 sections while the
history holds 250 releases. The v1.3.0 section is missing — the real defect.

```
node tools/land.mjs --check --no-fetch      land: CHANGELOG.md is stale — it would add v1.3.0        (exit 1)
node tools/land.mjs --no-fetch --no-push    land: committed d6906f7 — docs: render the changelog — 250 releases (CHANGELOG.md)
                                            changelog: CHANGELOG.md is current — 250 releases       (exit 0)
node tools/land.mjs --no-fetch --no-push    land: CHANGELOG.md is current — 250 releases, nothing to render
                                            changelog: CHANGELOG.md is current — 250 releases       (exit 0)
git status --porcelain                      (empty)
git show --name-only --format= HEAD         CHANGELOG.md                                            (one file)
npm run changelog:check                     changelog: CHANGELOG.md is current — 250 releases       (exit 0)
```

The second run renders nothing, commits nothing, pushes nothing and leaves the tree clean — idempotent by
construction. The render commit's diff is one file. No hand-written changelog edit appears anywhere. The v1.3.0
section the render wrote opens with the two commits it carried and links `6ba1e85`, the bump commit `main`
actually has.

### At `5234a3c` — `main`'s current tip (254 releases, v1.5.0)

`main` moved while this run measured it: sibling landings took it to 1.5.0 and rendered v1.3.0/v1.4.0 on the way.
Its tip carries a second, sharper form of the same defect — the v1.5.0 section names `b06feb1`, a commit the
squash merge re-created as `4209390`, so the section's link points at a commit `main` does not carry. The gate
says so without being told:

```
node tools/land.mjs --check --no-fetch      land: CHANGELOG.md is stale — every release is named, but the text
                                            differs from what the history renders — a section names a sha this
                                            base does not carry, or the header moved                      (exit 1)
node tools/land.mjs --no-fetch --no-push    land: committed 99057c9 — docs: render the changelog — 254 releases (CHANGELOG.md)
                                            changelog: CHANGELOG.md is current — 254 releases       (exit 0)
node tools/land.mjs --no-fetch --no-push    land: CHANGELOG.md is current — 254 releases, nothing to render  (exit 0)
git status --porcelain                      (empty)
npm run changelog:check                     changelog: CHANGELOG.md is current — 254 releases       (exit 0)
```

The brief's "250 releases" is the count at its own tip; at `main`'s tip the same command closes the same class of
defect at 254. The brief's count moved with the base, which is the point: the command reads the base's history
when it runs.

## What an agent runs instead of remembering a second step

After the merge, on the base checkout:

```
npm run land            # render, commit only CHANGELOG.md, push the base, prove — the whole step
npm run land:check      # the gate alone: renders in memory, writes nothing, exits 1 when the base is stale
```

The landing prompt's PHASE 4 names `npm run land` where it used to say `git push`, and `.githooks/pre-push`
refuses a base push whose changelog is stale with that same command in the refusal. There is no second step to
remember because there is no second step.

## Tests

`test/land.test.js` pins the pure decision (`landPlan`) for every base state — dirty, moved, foreign shas,
current, stale, branch preview — and builds one real repository for the two runs: one render, a clean tree, a
green check. `test/merge-prompt.test.js` pins PHASE 4 to the command and the branch rule. The full suite passes
apart from `test/release-sweep.test.js`, whose "one uncommitted file refuses the release" case refuses here
because this worktree is dirty while its files are being committed — the gate doing its job, not a regression
(the same test passes on a clean clone of `main`'s tip).

## Version

`1.6.0`, a minor bump: a new command in the landing path and a hook that refuses a stale base push. The version
lives in `package.json` and travels in its own commit on this branch, as `docs/versioning.md` requires.
