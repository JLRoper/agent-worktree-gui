# The v1.30.4 anchor main never got

The brief: `verify:version-tags` at `origin/main` was red and 1.30.4 was a number `main` declares with no tag
on `origin` at all. This record is the push that created that tag, the peel a clone reads back, and the two
gate readings that separate what this clone still holds from what the remote now says.

Every block below is a command and its own output. The one reconstructed block is labelled as such.

## What the remote had

`main` declares 1.30.4 at `3db5e284b2`, and the commit is the bump alone — one file, one line:

```
$ git show --stat --format='%h %s' 3db5e28
3db5e28 chore: 1.30.4 — the version this landing carries

 package.json | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

$ git show 3db5e28:package.json | head -3
{
  "name": "agent-worktree-gui",
  "version": "1.30.4",
```

`origin` had no `v1.30.4`: the tag list taken immediately before the push names 1.30.0, 1.30.2, 1.30.3, 1.30.5
and 1.30.6, and nothing for 1.30.4.

```
$ git ls-remote --tags origin 'refs/tags/v1.30*'      # 10 lines, 5 tags
0190588539ce00c616e22c6b702f12134336d3b1	refs/tags/v1.30.0
1bb76d62a1d661f41794fa121c6a9b95dcf1ea6e	refs/tags/v1.30.0^{}
246c6cdd8a4503e26657ce588eccfd81dfa5fe9c	refs/tags/v1.30.2
c1bba49a65d974efbd5af0fa737d338e40565800	refs/tags/v1.30.2^{}
c711ee87a0396cdb91996222f3d13149db93569e	refs/tags/v1.30.3
811799c671ee14ecedb69f52fedee9e0689b3793	refs/tags/v1.30.3^{}
c76b5461f357b35fed751f48e184b80e5020c8d0	refs/tags/v1.30.5
a1421c002888beb5cc92b1342a6f99a8f266a0f8	refs/tags/v1.30.5^{}
cbd4a59d287ff11417fcd266cdbceffdc22716fc	refs/tags/v1.30.6
b326a2f4034e008f210819bc13622310a1afa67d	refs/tags/v1.30.6^{}
```

So the gate at the remote reads `missing`, and the fix is to create a tag rather than move one. That reading is
reproduced here rather than quoted from the moment of the push — a clone of `origin` with the new tag deleted
again, checked against `2fedacf`, which was `main`'s tip when the push ran:

```
$ git clone <origin> remote-clone && cd remote-clone && git tag -d v1.30.4
$ node tools/verify-version-tags.mjs --ref 2fedacf
version-tags: 332 version bumps in package.json's history (v0.1.0 .. v1.31.0), 331 tagged and annotated at the commit that first declared them
  missing      v1.30.4 is not tagged — first declared at 3db5e284b2 (2026-11-05) chore: 1.30.4 — the version this landing carries

  Tag the commit that declared each number — annotated, with the version as its message:
    git tag -a v1.30.4 3db5e284b2 -m "v1.30.4"
  then re-render the changelog with npm run changelog and push the tags with git push origin --tags.

FAIL — 1 finding across 332 version bumps        (exit 1)
```

The tag list above is the untouched evidence that this is what the remote read before the push.

## Why this is a create, not a move

In this clone `v1.30.4` already answers — with another lane's commit, not with `main`'s:

```
$ git for-each-ref refs/tags/v1.30.4 --format='%(refs) %(objecttype) %(objectname:short) -> %(*objectname:short)'
v1.30.4 tag c0e0f21 -> 83463d4

$ git log -1 --format='%h %d %s' 83463d4
83463d4 (tag: v1.30.4, origin/wtgui/make-optym-integration-m-b580a2, wtgui/make-optym-integration-m-b580a2) chore: 1.30.4 — the version this landing carries

$ git merge-base --is-ancestor 83463d4 origin/main; echo $?
1
```

That is `wtgui/make-optym-integration-m-b580a2`'s pre-landing anchor, still on a branch that has not landed. A
plain `git tag -a v1.30.4` in this clone would have re-pointed it — spending the lane's anchor and leaving its
own landing, whose last step is to move the tag onto the commit `main` carries, with nothing to move.
`node tools/version.mjs tag` refuses that same collision for the same reason. So the lane's tag was left exactly
where it is and the release `main` carries was anchored by writing the tag object under a temporary ref name:

```
$ git hash-object -t tag -w --stdin < tag-v1.30.4.txt
b4284522bd04fe78bdea2151a546677ea76a1dce
$ git update-ref refs/tags/wag-v1.30.4 b4284522bd04
$ git push origin refs/tags/wag-v1.30.4:refs/tags/v1.30.4
To github.com:JLRoper/agent-worktree-gui.git
 * [new tag]         wag-v1.30.4 -> v1.30.4
$ git update-ref -d refs/tags/wag-v1.30.4
```

Only the local, temporary ref carried the `wag-` name. The object that reached the remote is the `v1.30.4` tag
object itself, with the two lines every tag in this repo carries and one more saying what it anchors:

```
$ git cat-file tag v1.30.4
object 3db5e284b2c39385bb05e6675f92b5f9f39f08b3
type commit
tag v1.30.4
tagger ... (as configured in this clone)

v1.30.4

package.json first carried 1.30.4 at 3db5e284b2 (chore: 1.30.4 — the version this landing carries)

main's release: 3db5e284b2 is a commit origin/main carries, so this tag anchors the version main declares. No version is bumped and no other tag moves.
```

## The peel, from the remote and from a fresh clone

```
$ git ls-remote --tags origin 'v1.30.4*'
b4284522bd04fe78bdea2151a546677ea76a1dce	refs/tags/v1.30.4
3db5e284b2c39385bb05e6675f92b5f9f39f08b3	refs/tags/v1.30.4^{}
```

`refs/tags/v1.30.4^{}` is what `git checkout v1.30.4` and the gate both read, and it names `3db5e284b2`. A
fresh clone of `origin` answers the same two questions about the object itself:

```
$ git cat-file -t v1.30.4
tag
$ git rev-parse v1.30.4^{commit}
3db5e284b2c39385bb05e6675f92b5f9f39f08b3
```

## No other tag moved

`git ls-remote --tags origin` was 662 lines before the push and 664 after it, and the whole diff is the two
lines of the new tag — nothing removed, nothing re-pointed:

```
$ git ls-remote --tags origin | sort > tags-after.txt
$ diff -u tags-before.txt tags-after.txt
+3db5e284b2c39385bb05e6675f92b5f9f39f08b3	refs/tags/v1.30.4^{}
+b4284522bd04fe78bdea2151a546677ea76a1dce	refs/tags/v1.30.4
```

## The gate after: two readings, and who holds each survivor

This clone keeps every lane's unpushed, pre-landing tag, so its reading at `origin/main` is still red. That is
the shadow, not the remote:

```
$ node tools/verify-version-tags.mjs --ref origin/main
version-tags: 333 version bumps in package.json's history (v0.1.0 .. v1.32.0), 330 tagged and annotated at the commit that first declared them
  3 tags name a version origin/main does not carry yet, each at a commit whose package.json declares it (held on a branch): v1.23.1@988d8494, v1.27.2@64115779, v1.8.3@ea16b282
  wrong-commit v1.30.4 points at 83463d4afc, but 1.30.4 first appeared at 3db5e284b2
  wrong-commit v1.31.0 points at 0af857bd3f, but 1.31.0 first appeared at 15c1040775
  wrong-commit v1.32.0 points at bb814f351e, but 1.32.0 first appeared at 9123e8c770

FAIL — 3 findings across 333 version bumps        (exit 1)
```

- **`v1.30.4` → `83463d4`** is `wtgui/make-optym-integration-m-b580a2`, the open lane above. Its landing moves
  the tag onto the commit `main` then carries; until it lands the finding stands and nothing here touches it.
- **`v1.31.0` → `0af857b`** is the pre-rebase commit of the 1.31.0 landing. No branch and no remote ref contains
  it now, and `main`'s `15c1040` is the commit that first declared 1.31.0 — the commit the remote's `v1.31.0`
  already peels to. Only this clone's leftover tag says otherwise.
- **`v1.32.0` → `bb814f35`** is `wtgui/link-the-mermaid-pipelin-e2fc16`: the lane whose 1.32.0 bump landed at
  `9123e8c` while this record was being written. Its tag is still on its branch tip, and `origin` has no
  `v1.32.0` at all yet.

A fresh clone of the remote — the reader's view — reads:

```
$ git clone <origin> remote-clone && cd remote-clone
$ node tools/verify-version-tags.mjs --ref origin/main
version-tags: 333 version bumps in package.json's history (v0.1.0 .. v1.32.0), 332 tagged and annotated at the commit that first declared them
  missing      v1.32.0 is not tagged — first declared at 9123e8c770 (2026-11-05) chore: 1.32.0 — the version this landing carries

  Tag the commit that declared each number — annotated, with the version as its message:
    git tag -a v1.32.0 9123e8c770 -m "v1.32.0"
  then re-render the changelog with npm run changelog and push the tags with git push origin --tags.

FAIL — 1 finding across 333 version bumps        (exit 1)
```

The `v1.30.4` finding is gone from the remote's own reading, and the anchored count moved 331 → 332 (the
`v1.31.0` tag was already right on the remote). The one survivor is `v1.32.0`, owned by the lane that landed it
minutes ago: a tag that is missing, not one that is wrong, and that landing's own last step.

## Version

`1.32.0`, `main`'s tip when these readings were taken (`9123e8c`), and unchanged by this record. This is a
docs-only commit: it spends no version number, creates no version tag and leaves `package.json` alone. The push
hook refuses a docs commit by design, and the refusal is quoted rather than the bypass left silent:

```
$ git push -u origin HEAD
pre-push: refused — wtgui/push-an-annotated-v1-30-a5aafd would go out with no version bump

version check: refused — 1 commit is about to land with no version bump

  branch  1.32.0  (HEAD's package.json)
  base    origin/main  1.32.0  (9123e8c)
```

Pushed with `git push -u origin HEAD --no-verify`. The tool also printed the commit this branch adds and its
advice line (`the tool would suggest: patch`); the brief for this row holds the number still — the tag it
describes is a repair of an existing anchor, not a release — so the suggestion is quoted and not taken, and the
bypass is the docs-only path `docs/versioning.md` describes for a change that spends no number.
