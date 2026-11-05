# The four orphan tags: where each commit is, and what made the gate red

The brief: `verify:version-tags` at `origin/main` (`2ffb933`) read FAIL with four `orphan-tag` findings, and the
question was whether a rebase or squash landing rewrites the commit that first declared a version, orphaning a
tag placed before the landing — and whether the admin-bypass true merges defeat an ancestry assumption in the
gate. Everything below was measured in this worktree with `git merge-base --is-ancestor`, `git show
<commit>:package.json`, `git cat-file -t` and the gate itself. No tag was created, moved or deleted, and
`package.json` was not edited.

The first answer is the one that changes the question: **none of the four tagged commits is on `main`** — not at
`2ffb933`, not at `origin/main` when this ran. The premise that two of them are on `main` does not hold. All four
tags are annotated (`git cat-file -t` reads `tag`), so none of the four was a `lightweight` finding either.

## The four, as they stood when the brief was written

| tag | peels to | on `main`? | `package.json` at that commit | what the walk says `main` did |
| --- | --- | --- | --- | --- |
| `v1.8.3` | `ea16b282d3` | no | `"version": "1.8.3"` | `1.8.2`@`45e2bf08`, then `1.8.4`@`fb8b63a8` — 1.8.3 never landed |
| `v1.23.1` | `988d8494f5` | no | `"version": "1.23.1"` | `1.23.0`@`5d8b1cf2`, then `1.23.2`@`6537c653` — 1.23.1 never landed |
| `v1.27.1` | `c485717626` | no | `"version": "1.27.1"` | `1.27.0`@`77033508` was the newest |
| `v1.28.0` | `e989fd4aaa` | no | `"version": "1.28.0"` | `1.27.0`@`77033508` was the newest |

`git merge-base --is-ancestor <sha> 2ffb933` exits non-zero for all four. Two are branch tips — `c485717626` is
`wtgui/hey-get-me-some-screensh-b7a6e6`, `e989fd4aaa` is `wtgui/replace-the-push-permiss-588511` (PR #445 open at
the time) — and two are on no ref but their tag at all: `git for-each-ref --contains ea16b282d3` and the same for
`988d8494f5` name only `refs/tags/v...`.

That splits the four into two faults, and neither one is "the merge did it":

- **`v1.27.1` and `v1.28.0` were pre-landing anchors.** Each was created by `tools/version.mjs apply` on its
  branch, which is exactly what `docs/versioning.md` asks for ("the branch carries a tag the gate can read").
  A branch-tip tag is only an orphan while the branch has not landed.
- **`v1.8.3` and `v1.23.1` are numbers `main` skipped.** `main` went `1.8.2` → `1.8.4` and `1.23.0` → `1.23.2`;
  the two bump commits were made on branches that never landed those numbers, and are now reachable from nothing
  but their tags. Their rows are closed; nothing has re-pointed them, and the gate is the only thing that still
  names them.

## The rebase landing did rewrite one declaring commit — after the fact

`v1.27.1` is the case the question describes, and it is real. PR #379 merged the branch by rebase: its commits
were re-created on `main` under new shas. The bump was `c485717626` ("chore: 1.27.1 — the version this landing
carries", `package.json` `1.27.1`); the commit `main` now carries is `dfae827e`, whose diff is exactly

```
-  "version": "1.27.0",
+  "version": "1.27.1",
```

so the declaring commit was rewritten, and the tag placed before the landing named a commit `main` does not
contain. That is the orphaning the question asks about — but it is not what the four findings said. At
`2ffb933` the number `1.27.1` was not in `main`'s history at all yet, so the gate called the tag an `orphan-tag`;
once the landing was on the ref, a tag left on the pre-merge commit would instead read `wrong-commit` ("points at
`c485717626`, but 1.27.1 first appeared at `dfae827e`"). The post-merge move `docs/versioning.md` prescribes
(`node tools/version.mjs tag --ref origin/main --force`) has since been done: `v1.27.1` now peels to `dfae827e`,
and `v1.28.0` likewise moved to `600fbc46` when its branch landed.

So: a rebase or squash landing does re-create the declaring commit, and the tag must move with it — but the move
is a documented step of the landing, and when it is skipped the gate's finding is `wrong-commit`, not
`orphan-tag`. The brief's four were all `orphan-tag`.

## The admin-bypass merges do not defeat the walk here

The three true merge commits on `main` each carry a version one of their parents already declared, so the walk
sees every version and no tag is misjudged because of a merge:

```
merge 504f2cd  Merge pull request #427 ...   merge pkg 1.18.0   p1 f7abde0 1.17.3   p2 d1f8df0 1.18.0
merge c02d249  Merge wtgui/buffer-output...  merge pkg 0.15.0   p1 7d888ce 0.14.0   p2 df7513e 0.15.0
merge edadc79  Merge branch 'main' into ...  merge pkg 0.1.0    p1 2735471 0.1.0    p2 2f4b380 0.1.0
```

`504f2cd` is a true merge (parents `f7abde05` and `d1f8df0b`), and its resolution picked `d1f8df0b`'s `1.18.0`;
`git log -p` shows no diff for the merge, but it does visit `d1f8df0b`, whose own patch writes `1.18.0`, so the
walk anchors the version there. No merge on `main` declares a version in a resolution that neither parent wrote
— the latent case `tools/release-history.mjs` warns about (a merge resolution invisible to `git log -p`) does not
occur in this history, and no `v1.18.0`-style finding appears.

## The assumption the gate actually makes — and the fix

`tools/release-history.mjs` computed the orphan set as "every `v<version>` tag whose name is not in the version
list this ref's walk found", and `tools/verify-version-tags.mjs` printed that as "package.json does not declare
<version>". Those are different claims. The second is about **the commit the tag names**; the first is about the
**ref's history**. For a tag on a live branch they disagree: `ea16b282d3`'s `package.json` does declare `1.8.3`,
and `dfae827e`'s does declare `1.27.1`, yet the gate said otherwise because `2ffb933`'s walk never reached them.
That is why the gate kept failing after a landing: every landing leaves the other live branches' bump tags
outside `main`, each one honest about its own commit, each one reported as a false claim. The repo's own
`docs/versioning.md` asks the branch to carry the tag before the landing, so the gate was contradicting the
process it exists to check.

The fix is the second option, implemented in the two tools the gate already reads:

- `tools/release-history.mjs` gains `readVersionAtCommit()` and attaches `declares` to every tag outside the
  walk: true only when `package.json` **at that commit** reads exactly the tag's version.
- `tools/verify-version-tags.mjs` reports `orphan-tag` only when `declares` is false, prints the rest as a note
  ("held on a branch"), keeps `missing` / `wrong-commit` / `lightweight` / `backwards` unchanged, and reports a
  held tag that carries no message as `lightweight` (held does not excuse a lightweight anchor).
- `test/release-tags.test.js` pins the three shapes: held is not a finding, a commit that does not declare the
  number is still an orphan, and a landed version tagged at another commit is still `wrong-commit`.

Why not the other two:

- **Move the tag (`node tools/version.mjs tag --ref <sha> --force`)** cannot repair two of the four: `origin/main`
  has no commit that declares `1.8.3` or `1.23.1` (its walk jumps `1.8.2` → `1.8.4` and `1.23.0` → `1.23.2`), so
  the tool refuses — correctly, because there is no anchor to move to. For `v1.27.1` and `v1.28.0` the tags
  belong to live workers mid-landing; re-pointing an orphan by hand attaches a version to a commit `main` never
  carried, which is the argument `docs/tag-retirement-2026-11-04.md` already made against it.
- **Make the landing move the tag** is the right post-merge step, and the docs already require it — but it cannot
  repair a tag whose landing never happened (`v1.8.3`, `v1.23.1` have no landing to ride), and it turns every
  landing into a tag force-push that races the workers holding the next numbers. The gate must still read a
  branch's honest anchor correctly whether or not the landing step ran.

The remaining judgment is a policy one and is left explicit: a tag for a number `main` skipped is now held, not a
failure, so retiring it stays a deliberate act for its closed row (as `docs/tag-retirement-2026-11-04.md` did for
`v0.112.0`/`v0.113.1`) rather than something the gate forces.

## The proof, on the same ref

At the start of this run, `node tools/verify-version-tags.mjs --ref HEAD` at `2ffb933` read exactly the brief's
four:

```
version-tags: 319 version bumps in package.json's history (v0.1.0 .. v1.27.0), 319 tagged and annotated at the commit that first declared them
  orphan-tag   v1.23.1 points at 988d8494f5, where package.json does not declare 1.23.1
  orphan-tag   v1.27.1 points at c485717626, where package.json does not declare 1.27.1
  orphan-tag   v1.28.0 points at e989fd4aaa, where package.json does not declare 1.28.0
  orphan-tag   v1.8.3 points at ea16b282d3, where package.json does not declare 1.8.3
FAIL — 4 findings across 319 version bumps
```

The repo moved while this ran — another worker landed 1.27.1 and 1.28.0 and moved their tags — so the
reproducible pair below is the same ref (`2ffb933`), the same tag state, and the pristine `HEAD` tools against
the working tree's:

```
$ node <pristine HEAD tools>/verify-version-tags.mjs --ref 2ffb933   # BEFORE
version-tags: 319 version bumps in package.json's history (v0.1.0 .. v1.27.0), 319 tagged and annotated at the commit that first declared them
  orphan-tag   v1.23.1 points at 988d8494f5, where package.json does not declare 1.23.1
  orphan-tag   v1.27.1 points at dfae827e8a, where package.json does not declare 1.27.1
  orphan-tag   v1.27.2 points at 6411577947, where package.json does not declare 1.27.2
  orphan-tag   v1.28.0 points at 600fbc4640, where package.json does not declare 1.28.0
  orphan-tag   v1.28.1 points at ef671a66c0, where package.json does not declare 1.28.1
  orphan-tag   v1.29.0 points at 61fa1d682d, where package.json does not declare 1.29.0
  orphan-tag   v1.8.3 points at ea16b282d3, where package.json does not declare 1.8.3
FAIL — 7 findings across 319 version bumps
$ echo $?
1

$ node tools/verify-version-tags.mjs --ref 2ffb933                        # AFTER
version-tags: 319 version bumps in package.json's history (v0.1.0 .. v1.27.0), 319 tagged and annotated at the commit that first declared them
  7 tags name a version 2ffb933 does not carry yet, each at a commit whose package.json declares it (held on a branch): v1.23.1@988d8494, v1.27.1@dfae827e, v1.27.2@64115779, v1.28.0@600fbc46, v1.28.1@ef671a66, v1.29.0@61fa1d68, and 1 more
  every bump carries an annotated tag at its own commit, and no v<version> tag points elsewhere
PASS
$ echo $?
0
```

`origin/main` reads `PASS` too (321 bumps, five held tags). `node --test test/release-tags.test.js
test/version-tags.test.js` is 22/22 green. `package.json` is untouched (`git diff -- package.json` is empty), and
no tag was created, moved or deleted by this run.
