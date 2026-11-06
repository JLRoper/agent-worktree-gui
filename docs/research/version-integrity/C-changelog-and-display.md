# C — the changelog and what the reader sees

Status: **measured; read-only.** No renderer change, no push. Pinned to `origin/main` at **`603617b`** — the commit
the brief names, and the cut this lane was taken from — and re-read at **`f6f0c2f`**, then again at **`e06e119`**
(see the Addendum), because main moved twice while this lane ran. Every reading below names the commit it was taken
at.

Code read at `603617b`: `tools/changelog.mjs`, `tools/release-history.mjs`, `tools/land.mjs`, `server.js`,
`lib/build-version.js`, `lib/restart.js`, `public/app.js`, `public/core/update-check.js`, `docs/versioning.md`.

## Verdict

1. **At `603617b` the render was owed.** `node tools/changelog.mjs --check` exited **1**; the file carried **333**
   releases ending at v1.32.0; a render at that HEAD produced **334** releases (`1158 commits`), the new section
   being `## v1.32.1 — 2026-11-05 · 3 commits`.
2. **That render has since been paid, by a different run.** `f6f0c2f` (`docs: render the changelog — 334 releases`,
   2026-11-06T01:41:04Z) has `603617b` as its parent, touches only `CHANGELOG.md` (+15/−2), and has **no PR**
   (the commits-pulls API answers 0) — i.e. it reached main by the direct docs-only push `npm run land` makes.
   Its blob is `f85c4dc`, **byte-identical** to the render produced here from `603617b`, and `--check` at main's tip
   is green (`changelog: CHANGELOG.md is current — 334 releases`). Nothing in this lane needs to render again.
3. **The one defect the render cannot fix and its own gate cannot see** is the tag: `refs/tags/v1.32.1` peels to
   `39d2e52`, the pre-rebase head of `wtgui/untrack-config-json-land-8e3f5a` — a commit main never had. The
   version-tags gate FAILs at main's tip for exactly that (`wrong-commit v1.32.1 points at 39d2e523af, but 1.32.1
   first appeared at 946578704c`), while the changelog check is green on the same tree. The new section's compare
   link resolves with HTTP 200 but describes a different range: 2 commits / 7 files ending at `39d2e52`, where the
   section names 3 commits ending at `9465787`.
4. **The panel served 1.30.3 for 68m40s** (00:35:29Z → 01:44:09Z) while the checkout went through six releases to
   1.32.1, because the version the panel serves is a **boot-time constant** while the changelog it draws is **read
   from disk on every request**. Two halves of one tab, invalidated by different events.

## 1. Who renders, and when

The render is the landing's **last** step, not the branch's. `docs/versioning.md` §"The changelog lands at the
merged tip" and `tools/land.mjs`'s header state the order as one motion:

```
node tools/version.mjs apply <level>   # the bump on the branch; it commits and tags itself
git push -u origin HEAD && gh pr create
gh pr merge <n> --rebase --admin       # this rewrites every sha the branch carried
npm run land                           # at the merged tip: render, commit CHANGELOG.md only, push, prove
npm run land:check                     # "changelog: CHANGELOG.md is current — N releases"
```

`land.mjs:139` renders through `renderRepo({ root, ref: "HEAD" })` from `tools/changelog.mjs`, and the base commit is
refused when HEAD is behind the base or the tree is dirty. `--check` renders in memory and writes nothing
(`land.mjs:375`). A render spends no version and creates no tag; `.githooks/pre-push` is bypassed narrowly only when
every commit being sent touches nothing but `CHANGELOG.md`.

### What invalidates a render — five rules, each measured

**R1 — A new version declaration owes a section.** Sections are version ranges: `collectReleases`
(`changelog.mjs:72`) walks `package.json`'s history (`readVersionHistory`, `release-history.mjs:96`) and cuts
each release from the previous declaration's sha to this one's. A bump commit that lands with no render after it is
red immediately.

**R2 — A commit *after* the newest declaration is in no section at all, and `--check` stays green anyway.** This is
the `603617b` half of the brief. `603617b` landed at 01:37:14Z, thirteen seconds after `9465787` declared 1.32.1. The
renderer's newest range ends at `9465787`; `603617b` is not in any range, so a correct render of that HEAD still does
not mention it — and because `--check` compares the file to a render of the same HEAD, the commit is invisible to the
gate in both directions. It can only appear in the section of the *next* version declared after it. (The next number,
v1.32.2, is already held by an unmerged branch — see §3.)
So "the changelog is stale at `9465787` and `603617b`" is two different states: the first is a section owed (fixed by
a render), the second is a commit that no render can carry (fixed only by a bump).

**R3 — A rebase merge rewrites shas, so a branch render names dead commits.** Every section links the shas it lists.
`gh pr merge --rebase` re-creates the branch's commits on main; a section written before the merge points at commits
the reader cannot follow. That is why the render is post-merge and why `land.mjs` refuses a branch as its base.

**R4 — The renderer never reads tags, so the changelog gate cannot detect a mis-anchored tag.** `renderRepo` derives
versions from `package.json`'s history and prints the compare URL as a string built from the two version numbers
(`renderChangelog`, `changelog.mjs:133`). Tags enter the file only as text in the URL. Measured consequence at main's
tip: `changelog --check` **green** and `verify-version-tags` **red** on the same tree, both about v1.32.1. A green
changelog is not evidence that its compare links point at main.

**R5 — The render commit itself lands in the next release's range.** `3fe86f1` (`docs: render the changelog — 333
releases`) appears as the first bullet of the v1.32.1 section. That is expected: the render is a commit, and the next
release's range is everything after the previous declaration. It is not a defect and not worth editing around.

## 2. The timeline that produced the gap

| time (UTC) | event | sha |
|---|---|---|
| 01:29:51 | PR #458 merged (rebase) — v1.32.0's feature | `9123e8c` |
| 01:35:41 | PR #458's post-merge render — 333 releases | `3fe86f1` |
| 01:37:01 | PR #460 merged (rebase) — config.json untracked + 1.32.1 bump | `9465787` |
| 01:37:14 | PR #459 merged (rebase) — the v1.30.4 tag-repair doc | `603617b` |
| 01:41:04 | render at the merged tip — 334 releases, pushed straight to main | `f6f0c2f` |
| 01:43:23 | the panel process now serving started (pid 53868) | — |
| 01:48:53 | the primary checkout pulled `f6f0c2f` (`git reflog show main`) | `f6f0c2f` |

The gap is **4m03s** wide (`9465787` → `f6f0c2f`). Its mechanism is plain: `3fe86f1` was the render for #458's
release and was already committed when #460 and #459 merged thirteen seconds apart; neither of those two landings
left a render behind, so the tip read red until the next `land` run — four minutes later, by whichever run owned the
base at that moment. This is the exact failure `land.mjs`'s header describes ("the render used to be a second step a
landing agent had to remember"), still reachable when two landings merge back-to-back: the pipeline runs once per
landing run, not once per merge.

The render that `f6f0c2f` carries is reproducible: rendering `603617b` here wrote the same blob (`f85c4dc`) and the
same text — so the file main now has is not a hand-edit, and the numbers in it can be trusted as the render's own.

## 3. Compare links — a full audit, not a spot check

Method: parse every `## vX.Y.Z` heading in the committed `CHANGELOG.md`, take its commit link and its compare link,
then resolve both ends against `git ls-remote --tags origin` and check the section's anchor against its tag's peeled
commit; finally `git merge-base --is-ancestor` each anchor against `origin/main`.

Measured on `603617b` (`CHANGELOG.md` blob `0d3ce1a`):

| reading | value |
|---|---|
| sections | 333 |
| compare links (the oldest section has none) | 332 |
| links whose current tag exists on origin and peels to the section's own anchor | **332 / 332** |
| links whose current tag is absent on origin (a 404) | **0** |
| links whose previous tag is absent on origin | **0** |
| section anchors that are not ancestors of `origin/main` | **0** |
| tags on origin, all annotated (`ls-remote` = 334 refs × 2 lines) | 334 |

So the **stale file's links are sound**. Staleness and broken links are different failures, and at `603617b` only the
first was present. The one named 404 in a sibling brief — `compare/v1.30.4...v1.30.5` — does not reproduce at this
state: HTTP **200**, and `v1.30.5` peels to `a1421c0`, which is that section's own anchor.

The **new** section is where the link goes wrong, and it is the only one:

```
## v1.32.1 — 2026-11-05 · 3 commits
[`9465787`](.../commit/946578704c…) · [compare v1.32.0...v1.32.1](.../compare/v1.32.0...v1.32.1)
```

- `refs/tags/v1.32.1` on origin: object `b3ebd9e` → peels to **`39d2e52`**, not `9465787`.
- `39d2e52` is the tip of `wtgui/untrack-config-json-land-8e3f5a`, still on origin, and `git merge-base
  --is-ancestor 39d2e52 origin/main` answers **no**.
- The link resolves — HTTP **200** — but the API shows what it resolves to: `ahead_by 2`, `total_commits 2`,
  `merge_base 9123e8c`, **7 files**, head `39d2e52`. The section beside it says **3 commits** and its own range
  (`9123e8c..9465787`) is those three shas: the render, the config.json untrack and the bump. A reader following the
  link sees two commits and seven files; a reader reading the section sees three commits. Both are on screen at once.
- Control: `compare/v1.31.0...v1.32.0` answers `total_commits 3`, head `9123e8c` — exactly its section's three
  commits and its anchor. The comparison is what the correct shape looks like.

Why the tag is there: PR #460 was a **rebase** merge. Its branch head was `39d2e52`, whose `package.json` already
declared 1.32.1, and `refs/tags/v1.32.1` on origin names that commit. The merge re-created it as `9465787`; the
published tag was never moved, because a rebase merge does not run the tag step and nothing after the merge
re-anchors a tag that already exists. `docs/versioning.md` requires the tag at the commit that **first declared** the
version on main; `9465787` is that commit, and it has no tag.

Live state of the tag map, quoted from the gate at main's tip. It moved during this read — the local `v1.32.2` tag
peeled to `980a8f9` earlier in the run and to `e0ef3ef2` in the gate's later line — which is why the line is quoted
rather than paraphrased:

```
version-tags: 334 version bumps in package.json's history (v0.1.0 .. v1.32.1), 333 tagged and annotated at the commit that first declared them
  5 tags name a version origin/main does not carry yet, each at a commit whose package.json declares it (held on a branch): v1.23.1@988d8494, v1.27.2@64115779, v1.32.2@e0ef3ef2, v1.33.0@e52a88c0, v1.8.3@ea16b282
  wrong-commit v1.32.1 points at 39d2e523af, but 1.32.1 first appeared at 946578704c
FAIL — 1 finding across 334 version bumps
```

The five "held" tags are not defects until their versions land: each is a branch tip whose own `package.json`
declares the number, and the gate says so. `v1.32.1` is the one that has already landed, which is why it is the one
reading as a wrong commit. It also means the next version to land will be 1.32.2 or above on someone else's branch,
and `603617b` will finally get a section under that number.

## 4. The checkout's version versus the panel's

Four different readers of "the version", with four different invalidation rules. The divergence is structural, not a
bug in any one of them.

| the reader sees | served by | read at | moves when |
|---|---|---|---|
| board config line `v1.32.1 · …` | `/api/config` → `settingsOut()` → `VERSION` (`server.js:169`, `1299`, `2966`) → `public/app.js:12194` | **once, at module load** | only a process restart |
| Settings → Updates, "Panel build" (a 12-char hash) | `/api/build` → `createBuild` (`lib/build-version.js`) | boot; re-read when a hashed file's mtime or size moves | a byte change under `public/` — **not** `package.json` |
| Settings → Updates, release notes | `/api/changelog`, which opens `CHANGELOG.md` per request (`server.js:2923-2965`); the tab refetches when older than 15 s (`app.js:16878`) | **per request** | the file changing on disk — no restart |
| the restart gate | `packageVersion()` (`server.js:174`) vs `VERSION`, `lib/restart.js:632-634` | per restart request | the checkout's `package.json` changing |

`VERSION` is the process's own number and is deliberately frozen: `server.js:167-172` says so ("`VERSION` above is
what this process serves and never moves; this is what a restart would put into service"). `packageVersion` exists
only for the guard that refuses a restart which would put the same number back — so **the panel can tell that the
checkout moved, and still not be restarted**. There is no route that reports `packageVersion` to the page: the only
UI read of staleness is `/api/build`'s bundle hash, and `package.json` is not in that bundle (`ALWAYS = [SHELL,
"app.js", "style.css"]` plus index.html's tags plus `core/`). A `lib/**` or `server.js` change — or a version bump —
moves nothing the reload chip watches.

### The measured episode

From `~/.wag/state/restart.json`, the panel's own restart record:

- **00:35:29Z** — restart `5e8c8b43` resumed: "pulled origin/main to 208620a (1.30.3) into the primary checkout —
  the running panel is 1.28.3 …". This is the boot that began serving **1.30.3**.
- **01:43:18Z** — restart `0d75345a` requested: "The primary checkout is at 1.32.1 (603617b) while the running panel
  still serves 1.30.3, so eight landed changes are not live; restart to serve the pulled build."
- **01:44:09Z** — resumed, with the proof turn `PANEL-RESTART-OK`. Since then `/api/config` answers `1.32.1`.

Duration served on 1.30.3: **68m40s**. What moved underneath it, measured `208620a..603617b`: **15 commits**, **six
releases** (v1.30.4, v1.30.5, v1.30.6, v1.31.0, v1.32.0, v1.32.1) and **six PR merges** (#455, #456, #457, #458,
#460, #459). The record's "eight landed changes" does not match any of those counts; the measured figures are the
three above.

What the reader saw during the window, from the code paths above: the board's config line said `v1.30.3`, the
release-notes block listed sections rendered to v1.32.0 and put the `serving` badge on the **v1.30.3** section, the
sixth one down (`releaseNotesSectionHtml`, `app.js:16962-16984`), and the "Panel build" row showed a bundle hash that
**had** moved, because `public/app.js`, `public/assistant.js`, `public/index.html`, `public/pipeline-modal.js` and
`public/style.css` all changed in the window. So the reload chip was live and honest about the client, and silent
about the server: a reader who took the offered reload after 01:29 would run **new client code against the 1.30.3
server process**, still labelled `v1.30.3`, with `lib/assistant.js` and `server.js` from 1.30.3 behind it. That is the
worst shape the split produces — the page and the process disagreeing while the label names the older half.

Why it is not simply "fixed by reloading the page": the page's config read is a fresh `GET /api/config`, but that
route answers from `VERSION`, which is the process, not the file. Only a restart moves it. The panel's own restart
path is the only thing that can, and it is the thing that had to be asked for by hand — which is what happened at
01:43:18Z.

## 5. What is still owed

- **Nothing to render at main's tip.** `changelog --check` is green at `f6f0c2f`; a re-render produces the same blob.
- **The v1.32.1 tag is still wrong.** Fixing it is a remote write and out of scope for this lane: the gate names the
  anchor, and the house command is `node tools/version.mjs tag --ref 9465787 --force` followed by
  `git push origin v1.32.1 --force` — but a published tag should be moved only with the reader's decision, because a
  clone that already fetched `39d2e52` keeps the old object and any consumer of the tag sees the move as history.
- **`603617b` cannot appear in the changelog until the next bump.** The next release's section will carry it; that
  section's anchor and tag will be whatever commit declares that number first, which is currently another branch's
  claim (v1.32.2 / v1.33.0 are both held).
- **No code change is proposed here.** The report is read-only by design; the two candidates worth a separate design
  (a surface that reports `packageVersion` beside `VERSION`, and a `changelog --check` variant that also verifies the
  tags it names) are named in §4 and §3 as consequences, not implemented.

## Addendum — main moved again before this was filed

Measured at `e06e119` (main's tip while this was being committed), after the body above was written against
`f6f0c2f`.

- **Main is now at 1.32.4**, and the render is current there: rendering `origin/main` from this worktree produced
  blob `38b6eaf`, identical to `origin/main:CHANGELOG.md` (335 releases). No render is owed at this tip either.
- **R2's prediction held: `603617b` now has a section.** The v1.32.4 section (range `9465787..3dfeb3a`, 4 commits)
  lists `603617b`, `f6f0c2f` and `82e0d17`. It needed a version declared after it — 1.32.4 is that version. Nothing
  about the commit changed; it was always going to appear under the *next* release.
- **The compare link for that section is `v1.32.1...v1.32.4`.** v1.32.2 and v1.32.3 were declared only on branches and
  never landed, so main's changelog jumps from 1.32.1 to 1.32.4 with no section for either number. That is correct for
  main's own history, and it is the other reason a tag held by an unlanded branch matters: the numbers a reader sees
  in the file are not consecutive.
- **The tag finding is unchanged and still the only one.** `verify-version-tags --ref origin/main` at `e06e119`:
  `335 version bumps … 334 tagged and annotated`, `wrong-commit v1.32.1 points at 39d2e523af, but 1.32.1 first
  appeared at 946578704c`, `FAIL — 1 finding`. The held-tag list grew to seven (v1.32.2, v1.32.3, v1.33.0, v1.33.1
  and three older); the gate reports those as held, not as findings.
- **The display half closed itself the same way it opened.** The panel restarted again at 02:29:49Z and now serves
  **1.32.4**; `/api/config` reads 1.32.4. Its `/api/build` bundle hash is still `a2eb73e6d5dd` — the same value it
  had at 01:43 while serving 1.32.1 — because the three releases in between changed only `package.json` and `docs/`.
  That is §4's point measured end to end: a version bump moves neither the hash the reload chip watches nor anything
  the page can see; only the next process boot moves the number.

## Evidence appendix

All commands run from the worktree at `603617b`, except where `origin/main` is named.

```
$ node tools/changelog.mjs --check
changelog: CHANGELOG.md is out of date — run npm run changelog and commit the result
exit=1

$ node tools/changelog.mjs --out <scratch>/CHANGELOG.now.md
changelog: wrote …/CHANGELOG.now.md — 334 releases, 1158 commits, 296784 chars, links from origin
exit=0

$ git diff --no-index CHANGELOG.md <scratch>/CHANGELOG.now.md
@@ -4,17 +4,30 @@
-333 releases from v0.1.0 (2026-10-20) to v1.32.0 (2026-11-05), 1155 commits between the tags.
+334 releases from v0.1.0 (2026-10-20) to v1.32.1 (2026-11-05), 1158 commits between the tags.
+## v1.32.1 — 2026-11-05 · 3 commits
+… commit/946578704c0cae579ba25eed91ca74bb50164be6 … compare/v1.32.0...v1.32.1
+### Docs & tests
+- docs: render the changelog — 333 releases (3fe86f1)
+### Other
+- chore: config.json is the reader's own file, not the repo's (3ae7223)
+- chore: 1.32.1 — the version this landing carries (9465787)
```

```
$ git rev-parse origin/main:CHANGELOG.md
f85c4dc614b4f4925a0e3f48a302177ac0d974a4
$ git hash-object <scratch>/CHANGELOG.now.md
f85c4dc614b4f4925a0e3f48a302177ac0d974a4

$ git rev-parse f6f0c2f^
603617b0296c4f75b5fef9005fe26ec7b41fdc80
$ git show --stat --format='%h %cd %s' f6f0c2f
f6f0c2f 2026-11-05 20:41:04 -0500 docs: render the changelog — 334 releases
 CHANGELOG.md | 17 +++++++++++++++--
 1 file changed, 15 insertions(+), 2 deletions(-)
$ gh api repos/JLRoper/agent-worktree-gui/commits/f6f0c2f/pulls --jq length
0
```

```
$ node tools/changelog.mjs --check        # in the primary checkout, at f6f0c2f
changelog: CHANGELOG.md is current — 334 releases
exit=0

$ node tools/verify-version-tags.mjs --ref origin/main
version-tags: 334 version bumps in package.json's history (v0.1.0 .. v1.32.1), 333 tagged and annotated at the commit that first declared them
  5 tags name a version origin/main does not carry yet, … : v1.23.1@988d8494, v1.27.2@64115779, v1.32.2@e0ef3ef2, v1.33.0@e52a88c0, v1.8.3@ea16b282
  wrong-commit v1.32.1 points at 39d2e523af, but 1.32.1 first appeared at 946578704c
FAIL — 1 finding across 334 version bumps
exit=1
```

```
$ git ls-remote --tags origin 'refs/tags/v1.32.*'
d13055ae0bf79d81139ba292f4631b69f7826ab4  refs/tags/v1.32.0
9123e8c770fb8e74fa0899b6f9926675a03c4fc7  refs/tags/v1.32.0^{}
b3ebd9e0297f010f4f7e9556e39b9112de8d93f2  refs/tags/v1.32.1
39d2e523af3055ec456fde90f1a8029e12d2df16  refs/tags/v1.32.1^{}

$ git branch -a --contains 39d2e52
+ wtgui/untrack-config-json-land-8e3f5a
  remotes/origin/wtgui/untrack-config-json-land-8e3f5a

$ gh api repos/JLRoper/agent-worktree-gui/compare/v1.32.0...v1.32.1 --jq '{status,total_commits,ahead_by,merge_base:.merge_base_commit.sha[0:7],head:.commits[-1].sha[0:7],files:(.files|length)}'
{"ahead_by":2,"behind_by":0,"files":7,"head":"39d2e52","merge_base":"9123e8c","status":"ahead","total_commits":2}

$ gh api repos/JLRoper/agent-worktree-gui/compare/v1.31.0...v1.32.0 --jq '{status,total_commits,merge_base:.merge_base_commit.sha[0:7],head:.commits[-1].sha[0:7]}'
{"ahead_by":3,"behind_by":0,"head":"9123e8c","merge_base":"15c1040","status":"ahead","total_commits":3}

$ curl -s -o /dev/null -w '%{http_code}' .../compare/v1.32.0...v1.32.1
200
```

```
$ curl -s http://127.0.0.1:7331/api/config
{"version":"1.32.1", …}
$ curl -s http://127.0.0.1:7331/api/build
{"version":"a2eb73e6d5dd","bootedAt":"2026-11-06T01:43:23.652Z","computedAt":"2026-11-06T01:43:23.685Z","uptimeSeconds":1782}
$ curl -s 'http://127.0.0.1:7331/api/changelog?limit=2'
{serving: '1.32.1', state: 'ok', mtime: '2026-11-06T01:48:53.443Z', size: 302781, limit: 2}
[('1.32.1','2026-11-05',3), ('1.32.0','2026-11-05',3)]

# pid 53868: StartTime 11/5/2026 8:43:23 PM; CommandLine …/server.js (the primary checkout)
```

```
$ git reflog show main --date=iso
f6f0c2f main@{2026-11-05 20:48:53 -0500}: pull --ff-only origin main: Fast-forward
603617b main@{2026-11-05 20:38:45 -0500}: merge origin/main: Fast-forward
9465787 main@{2026-11-05 20:37:10 -0500}: merge origin/main: Fast-forward

$ git rev-list --count 208620a..603617b
15
$ git rev-list --count 208620a..9465787
14
```

```
$ gh pr list --state merged --limit 4 --json number,mergeCommit,mergedAt,headRefName
460 2026-11-06T01:37:01Z 9465787 wtgui/untrack-config-json-land-8e3f5a
459 2026-11-06T01:37:14Z 603617b wtgui/push-an-annotated-v1-30-a5aafd
458 2026-11-06T01:29:51Z 9123e8c wtgui/link-the-mermaid-pipelin-e2fc16
457 2026-11-06T01:02:03Z 15c1040 wtgui/add-a-role-picker-to-the-a115e3
```
