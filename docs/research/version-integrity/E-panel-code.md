# Lane E — the version in our own automation

Read-only trace at `603617b` (this tree, cut from `main`; `origin/main` was `f6f0c2f` when the trace was
taken), with `package.json` at **1.32.1**. The three artifacts are `lib/merge-prompt.js` (the prompt the
UNMERGED chip hands a merge agent), `tools/version.mjs` (suggest / check / apply / tag / backfill) and the
landing brief (`lib/branch-policy.js`, the `LANDING:` paragraph at the top of a run in a tree cut from a
landing branch). Line numbers are that commit's. Nothing in the widget was changed: §6 is this lane's own
passage through the same automation, run to observe it.

## 1. Who is told what

| artifact | what it does about the number | a version clause? |
|---|---|---|
| `lib/merge-prompt.js` | tells the merge agent to choose a level, land a bump commit, render at the merged tip and report the pair | yes — PHASE 1B (116–137), the render order (139–152), PHASE 4 (229–259), the report (280–281) |
| `tools/version.mjs` | suggests a level, gates a push, writes and commits the number, creates and moves the tag, backfills missing tags | yes — the whole file |
| `lib/branch-policy.js` (`branchLandingLine`) | tells a run in a tree cut from `main` to commit, push and open a PR | **no** — `grep -c version lib/branch-policy.js` is `0` |

The three do not name the same chooser. §5 is what falls out of that.

## 2. `lib/merge-prompt.js` — every point

| line | point | what it does with the version |
|---|---|---|
| 13–15 | file header | the doctrine the prompt is built on: the changelog is rendered "at the merged tip, in the same run", because a rebase or squash merge re-creates the shas a branch render would name |
| 19–22 | `mergeLabel()` | names the card only (`MERGING into MAIN`); no number |
| 86 | the prompt's first line | branch, commit count, base; no number |
| 102–108 | read before touching | `git status`, `git worktree list`, `git log <baseRef>..HEAD` — the commit list the level is judged from, read by the agent, not by the tool |
| 116–119 | PHASE 1B, the choice | "the version bump: you decide the level"; "a tool advises, a hook refuses, neither one decides"; the number "lives once, in package.json" |
| 121–124 | PHASE 1B, the advice | `node tools/version.mjs suggest` — level from commit subjects, plus the PR's title and body when `gh` has them; "ADVICE: it writes nothing" |
| 125–126 | PHASE 1B, the write | `node tools/version.mjs apply <level>` — described as writing the number and printing old and new. Narrower than the tool: `apply` also commits and tags (§3.3) |
| 127–131 | PHASE 1B, the scale | major / minor / patch in prose; "the suggestion is advice" |
| 132–137 | PHASE 1B, the commit | the bump is a commit **on the branch, before PHASE 2**, with level and reason in its message and in the PR body; `.githooks/pre-push` runs `version.mjs check` and its refusal "is a stop" |
| 139–152 | the render order | 1 bump (144, "the tag anchors that commit"), 2 push the branch and open the PR (145), 3 merge (146), 4 `npm run land` at the merged tip (147), 5 `npm run land:check` (148); "the render is its own docs commit and spends no version" (152) |
| 144 | the anchor, named once | "the tag anchors that commit" — an assertion about a tag the agent has not been told to create or move; PHASE 1B only hands it `apply` |
| 160–162 | PHASE 2 preamble | on the PR route "THAT PR is the merge" and the local merge is not run |
| 229–235 | PHASE 4 opening | the merge must read `MERGED` before anything is rendered; a local landing is PHASE 2's merge |
| 242–247 | PHASE 4 step 3 | `npm run land` "REPLACES `git push <remote> <base>`": renders from the tags the base carries now, "a render spends no version and creates no tag" |
| 248–251 | PHASE 4 step 4 | `npm run land:check` must read current and `git rev-parse <base> <baseRef>` must print the same sha |
| 265–266 | PHASE 5 | the render commit is part of the landing, and the only file it touched |
| 280–281 | PHASE 6 report | `version: <old> -> <new> (level: reason)` and `changelog: <N> releases … at the merged tip <sha>`; there is **no line for the tag**, the one thing PHASE 1B's `apply` created |

## 3. `tools/version.mjs` — every point

### 3.1 The choice

| line | point | what it decides |
|---|---|---|
| 73–77 | `TYPES` | the scale as code: `feat` → minor, every other prefix (`fix`, `docs`, `test`, `chore`, `refactor`, `perf`, `style`, `build`, `ci`, `revert`) → patch |
| 81–98 | `baseCandidates()` | the base ref, in order: `$VERSION_BASE`, each remote's own HEAD symref, remote-tracking refs sorted with `endsWith("/main")` first, then `main`, `master` |
| 100–108 | `resolveBase()` | the first candidate that resolves to a commit; when none does, `check` refuses (327–339) and `suggest` says there is nothing to compare against (276–279) |
| 112–120 | `branchCommits()` | `git log <base>..HEAD`, tip first — the same set the prompt shows |
| 124–141 | `classify()` | `!` or a `BREAKING CHANGE:` body line → major; a known prefix → its `TYPES` level; anything else → `null` with "nothing here says which level it is" |
| 143–152 | `overall()` | the highest rank wins; unclassified commits are counted, never folded into patch |
| 156–168 | `readPr()` | `gh pr view --json number,title,body`, best effort; no gh, no PR or no auth is a note |
| 204–215 | `semver()` / `compareVersions()` | three leading numbers; any suffix is ignored for the comparison |
| 217–224 | `nextVersion()` | `major` → `(M+1).0.0`, `minor` → `M.(m+1).0`, else patch+1; a `-pre`/`+build` suffix is stripped by the match and never carried |
| 274–316 | `modeSuggest()` | 281 reads the branch's commits, 287–289 classifies them and appends the PR as one more entry, 301–312 prints a level with the floor caveat, 314 "Advice only — nothing was written" |

### 3.2 The gate

| line | point | what it decides |
|---|---|---|
| 318–323 | `--base` parsing | an explicit ref wins; otherwise `resolveBase()` |
| 327–339 | no base | refuses (exit 1) rather than passing: "a gate that cannot name the branch's base cannot pass it" |
| 341–344 | the three reads | `baseSha`, `there = versionAt(base)` (`git show <base>:package.json`), `here = versionAtHead()` (`git show HEAD:package.json`), `work = versionIn(readWorking())` |
| 346–362 | unreadable either side | refuses; the branch/base pair is printed so silence is not a pass |
| 364 | the commits | `branchCommits(base)` — the gate's own count |
| 366–368 | the working-tree note | a number on disk that differs from HEAD is named, because "HEAD is what a push carries" |
| 385–394 | pass: above | exit 0, prints branch, base, sha, commit count |
| 397–404 | pass: equal and no commits | main itself, or a branch with nothing on it: "nothing to land, so nothing to bump" |
| 406–450 | the refusal | 407 behind vs unchanged-with-commits, 408–409 classifies the commits, 416–417 the pair, 427–429 the level it would suggest, 433–435 the "behind" advice, 442 the one `apply` command |
| 444–446 | where the reason goes | "State the level and the reason in the PR body" — plus the concession that `--no-verify` bypasses the gate and a local hook "only ever binds its own author" |

### 3.3 The write

| line | point | what it decides |
|---|---|---|
| 453–458 | the level argument | must be one of `patch`, `minor`, `major`; exit 2 otherwise |
| 459–468 | the old number | read from the **working tree** (`readWorking()`), not from HEAD |
| 469–473 | the new number | `nextVersion(old, want)`; a version that is not three plain numbers is refused |
| 476–483 | the anchor collision | refuses **before writing** when `v<next>` already exists anywhere: "a version is anchored once; move or delete that tag first" |
| 486 | the dirtiness read | `dirtyFiles()` before the write, so the bump's own line is never counted as somebody else's work |
| 490–498 | the write | the value is replaced in place on its `"version"` line (no JSON round-trip), then `writeFileSync` |
| 499–500 | the report | `package.json  <old> -> <new>` |
| 501–510 | dirty tree | the number is written, **no commit and no tag**, with the dirty paths and "commit the change, then anchor it: node tools/version.mjs tag" |
| 511–523 | clean tree | subject `chore: <next> — the version this landing carries`; `git add -- package.json`; `git commit -m <subject> -- package.json`; the new sha is printed |
| 524–529 | the tag | `createTag(next, sha)`; a refused tag is an error that says the commit carries the bump and names `version.mjs tag` |
| 531–533 | after the tag | "the board's config line reads this at its next start"; and the post-merge move: `node tools/version.mjs tag --ref origin/main --force && git push origin v<next> --force` |

### 3.4 The anchor

| line | point | what it decides |
|---|---|---|
| 544–566 | `modeTag()` ref and number | `--ref` (default `HEAD`) resolves to a commit; the number is read out of **that ref's tree** |
| 570–580 | the walk | `findDeclaration({ root, ref: tip, version })` — the commit whose `package.json` patch first wrote this number, not the ref's tip |
| 581–599 | no declaration | refuses and says what it looked for: a merge resolution, a shallow clone or a graft can leave a value with no commit that wrote it |
| 601–613 | dirty tree, declaring commit is HEAD | refuses: a tag names a commit, not a working tree |
| 622–625 | already right | annotated at the declaring commit → exit 0, "nothing to do" |
| 626–632 | lightweight, same commit | refuses without `--force` |
| 633–640 | exists elsewhere | refuses without `--force`, naming both shas and the declaring subject |
| 641–649 | the write | `createTag(version, commit, { force })`; prints the new anchor and, when moved, the old one |
| 264–270 | `createTag()` | one **annotated** tag with two messages: `v<version>`, then `package.json first carried <version> at <sha10> (<subject>)` |
| 656–678 | `modeBackfill()` history | `readReleaseHistory`; no history at all is a refusal, not a cheerful zero |
| 682–697 | the pass | creates the missing tags; existing tags that name the wrong commit or are lightweight are **reported, not rewritten** |
| 704–711 | `--push` | sends only the tags this run created |
| 712–720 | repairs | any wrong-commit or lightweight tag makes the run exit 1 with `FAIL` |

### 3.5 What the number is rendered as

| line | point | what it shows |
|---|---|---|
| `server.js:167–170` | `VERSION` | `package.json` read once at boot; the process serves that number until it restarts |
| `server.js:172–177` | `packageVersion()` | re-read on every request — the number a restart would put into service |
| `server.js:1230–1232` | the restart gate | a restart is refused only while the two are equal |
| `server.js:1299` | `settingsOut()` | ships `version: VERSION` to the page |
| `public/app.js:12194` | the config line | `v${cfg.version} · N project(s) · …` — the board's visible number |
| `tools/changelog.mjs:131` | the section heading | `## v${r.version}` — rendered from the **tag**, not from `package.json` |
| `tools/release-history.mjs:66,76,82–90,148–150` | the release list | versions come from the commits whose patch first writes the line, joined to the tag of the same name |
| `lib/build-version.js` | the static bundle | a second, unrelated build version: a sha256 fold of the served files' hashes, in the `panel-build` meta and every `?v=` URL |

## 4. The landing brief

`lib/branch-policy.js:45–59` is the whole paragraph. The landing-branch arm (53–59) reads, with its
interpolations shown as placeholders:

> LANDING: this worktree (`<tree>`) is on `<branch>`, cut from `<parent>` — a landing branch, so do not merge into it. When the work is done, commit on `<branch>`, push it and open a pull request: `git push -u <remote> HEAD` then `gh pr create --fill`.

| line | point | what it says about the version |
|---|---|---|
| 17–19 | `LANDING_BRANCHES` / `isLandingBranch` | decides which arm runs; `main` and `master` only |
| 25–43 | `guardTail()` | whether the push is **asked about** (deny / allow / the Allow-without-asking switch / the permission box); never whether it should happen, and never what it carries |
| 45–52 | the arguments | tree, parent, branch, remote — no version, and no way to pass one in |
| 53–59 | the landing arm | commit, push, open a PR. No bump, no tag, no render, no `docs/versioning.md`, no `tools/version.mjs` |
| 61–67 | the non-landing arm | merge into the parent locally and do not push — the same silence about the number |

The brief cannot be extended by its caller either: `branchLandingLine(o, where)` reads only `cwd`, `parent`,
`parentBranch`, `branch`, `remote`, `policy` / `branchPolicy` and `allowPushWithoutAsking`.

The neighbouring brief is `lib/jobs.js:306–343`: `remoteWriteLine()` emits `WILL LAND: … push it and open a
pull request` (315) for a landing run, and, for an `allow` policy or the switch, "push a branch or open a pull
request when the reader asks for one or when the work is meant to land, **and not for a probe or a piece of
research**" (327, repeated 341). In a tree cut from `main` the LANDING clause (55–58) says push and open a PR
unconditionally, so the two sentences can disagree about a research tree; nothing in either one mentions the
number.

The consequence is mechanical: for a tree cut from `main`, the version enters the run at **push** time, as a
refusal from a hook the brief never names.

## 5. What the trace shows

**S1 — three artifacts, three choosers.** `docs/versioning.md` puts the level on "the agent landing the
change"; `merge-prompt.js:116–137` puts it on the **merge** agent, on the branch, before PHASE 2;
`version.mjs:442–445` tells whoever reads the refusal to `apply` it "in the PR body", which is the PR author's
job. A run in a tree cut from `main` gets none of the three sentences — only the hook.

**S2 — a docs-only branch cannot pass the gate, by design.** `version.mjs:397–404` allows an equal number
only when the branch adds **no** commits; one docs commit at the base's number is refused (406–414). Yet
`docs/versioning.md:67` says a render "spends no number and creates no tag", and `tools/land.mjs:346` says
"A landing that spends no version (a docs-only merge) is refused by .githooks/pre-push on purpose — push it
deliberately with `git push <remote> <base> --no-verify` and say why in the PR". The documented no-number
landing and the gate that enforces numbers meet only at the bypass.

**S3 — the anchor is shared with branches that have not landed.** `apply` creates `v<next>` on the branch
(524–529) so the branch's own gate can read it, and refuses any number whose tag exists anywhere (476–483).
Parallel landings from one base therefore collide by construction: at the time of this trace `main` read
1.32.1, `v1.32.2` named `e0ef3ef204` on `wtgui/fix-the-push-settings-wr-161f16`, and `v1.33.0` named
`e52a88c` on `wtgui/let-each-assistant-be-re-b279a4`. The next patch and the next minor from this base are
both taken by work that has not landed (§6).

**S4 — `apply` bumps the working number and never reads the base; `check` compares HEAD against it.**
`modeApply` reads `readWorking()` (459–468) and calls `nextVersion` (469); `versionAt(base)` exists (189–193)
and is called from `modeCheck` only (342). On a branch cut before the base moved, `apply patch` writes a
number relative to the **stale** one, and `check` then refuses it as "behind" (413). The refusal's advice —
bump above `<there>` (433–435) — is the only place the base's number reaches the writer, and by then the
write has happened.

**S5 — the anchor is created before the merge and nothing in the merge prompt moves it.** `apply` prints the
post-merge move (532–533); `merge-prompt.js` has no `version.mjs tag --ref origin/main --force` step in
PHASE 2, 4 or 5, and PHASE 6's report (280–284) has a line for the version and none for the tag. A merge
agent that follows the prompt literally can land a bump whose tag still names the branch's pre-merge commit —
the orphan `verify:version-tags` exists to catch.

**S6 — the report asserts the merged tip but not the anchor.** PHASE 6 asks for `version: old -> new` (280)
and `changelog: … at the merged tip <sha>` (281); a tag on the wrong commit is invisible in the one summary
the prompt says "counts" (277).

**S7 — the PR body is asked for at a moment the PR does not exist.** `apply` runs before the push
(`merge-prompt.js:132`); `gh pr create --fill` runs after it (145). "State the level and the reason in the PR
body" (`version.mjs:444–445`) is therefore a step no tool performs and `check` cannot see; it is the sentence
that keeps the level a judgement rather than a gate.

**S8 — suffixes compare as equal and bump as absent.** `semver()` (204–207) matches the first three numbers
and ignores `-rc.1`; `nextVersion()` (217–224) requires a plain three-part and strips `[-+].*`. `1.2.3-rc.1`
therefore compares equal to `1.2.3` and `apply patch` from it yields `1.2.4`. None of the 341 tags in this
clone carries such a suffix; the behaviour is latent.

**S9 — the base is whichever ref sorts first.** `baseCandidates()` (81–98) ranks remote-tracking refs by
`endsWith("/main")`, so a remote branch named `<anything>/main` ranks with `origin/main` and is separated
only by `localeCompare`; the local `main` is reached only when no remote ref resolves. At this commit the
local `main` was `603617b` and `origin/main` `f6f0c2f`, and `check` correctly reported `base origin/main 1.32.1 (f6f0c2f)`.

**S10 — the PR is counted as one more commit.** `modeSuggest` appends the PR's title and body as one more
entry (289). With `gh pr create --fill` the title is usually the branch's own subject, so one change can be
classified twice; the level is a max so the answer does not move, but the "N of M commits could not be
classified" denominator (309–312) counts the PR as a commit.

## 6. This lane's own passage through it

Measured on this tree, before and after this document's commit. Four commands, unedited output.

`node tools/version.mjs suggest` (0 commits on the branch, before the document):

```
version suggest — 0 commits on this branch since origin/main
  no commits to read. Nothing to bump for. See docs/versioning.md.
```

`node tools/version.mjs check` (before the document):

```
version check: ok — nothing to land, so nothing to bump
  branch  1.32.1  (HEAD's package.json)
  base    origin/main  1.32.1  (f6f0c2f)
  this branch adds no commits on top of origin/main; there is no change here for a number to name
```

`node tools/version.mjs apply patch` — refused before writing (S3), and `package.json`'s sha256 was
`a2bf2398…` both before and after, with `git status --porcelain` empty:

```
version apply: package.json would declare 1.32.2, and v1.32.2 already names e0ef3ef204 — a version is anchored once; move or delete that tag first
```

`node tools/version.mjs check` (after the document's commit):

```
version check: refused — 1 commit is about to land with no version bump

  branch  1.32.1  (HEAD's package.json)
  base    origin/main  1.32.1  (f6f0c2f)

  commits this branch adds:
    e8c754e9  patch docs: trace every version point in the panel's own automation

  the tool would suggest: patch  (advice — the level is the landing agent's judgement)

  a version that does not move with its change tells a reader nothing moved, and the squash merge puts
  this branch's own subjects into main's history. Fix it in the same PR as the change:

    node tools/version.mjs apply patch

  apply writes the number, commits it as its own commit and tags that commit. State the level and the reason
  in the PR body. The scale is docs/versioning.md.
  (git push --no-verify bypasses this check, and a local hook only ever binds its own author.)
```

The `e8c754e9` in that output is the branch commit the gate read; the landing's rebase re-creates it on
`main` under a new sha, so it is quoted as the evidence for that reading, not as a pointer that survives the
merge.

So this lane's disposition: the document is committed with nothing else in it — the first commit carries the
trace, the second folds this refusal into the same file — no number is spent, and the branch is pushed
with `git push --no-verify` — the disposition `tools/land.mjs:346` names for a landing that spends no version,
and the only one available here: the two numbers the scale would pick from this base (1.32.2, 1.33.0) are
already anchored on branches that have not landed, and moving or deleting someone else's tag is not this
lane's call. The refusal above is recorded rather than silently bypassed: it is the seam S2/S3 describe.

## 7. Scope

No code changed, no `package.json` edit, no tag created or moved, no changelog rendered. The number's meaning,
the tag namespace, the changelog, the gates, the outside designs and the instructions are lanes A, B, C, D, F,
G and H; this is the view from the panel's own automation.
