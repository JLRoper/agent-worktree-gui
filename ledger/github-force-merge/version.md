# github-force-merge / version

Stage: version (2 of 6)
Artifact: package.json at 1.77.1, and this record
Base: origin/main 57de1d54, reading 1.77.0

## Level

Patch. The branch is docs-only: one report page and its stage record. Per
docs/versioning.md, a new gate that can fail a landing is a minor; a docs-only
change is a patch.

## The tool, as run

node tools/version.mjs suggest
  patch - "docs: walk the GitHub ladder and file its two next moves"

node tools/version.mjs apply patch
  package.json  1.76.28 -> 1.77.1
  base          origin/main reads 1.77.0, so the number was taken above the
                base, not above this branch
  commit        54355c6174 "chore: 1.77.1 - the version this landing carries"
  tag           v1.77.1 (annotated) at 54355c6174
  claim         v1.77.1 is on origin at 54355c6174

node tools/version.mjs check
  ok - branch 1.77.1, base origin/main 1.77.0, 2 commits to land

## Why 1.77.1 and not 1.76.29

The branch was cut at 4dd79438, where package.json read 1.76.28. Main moved to
1.77.0 (a feature landing and its changelog render) while this page was being
written. A patch above the base is 1.77.1. The local tag v1.76.29 belongs to the
parked sanity branch, is not on origin, and is not this landing's number.

## After the rebase

The branch was rebased onto origin/main to avoid a package.json conflict at the
merge. That rewrote the bump commit; this file rides the rebased bump commit.
The claim is moved onto it with:

  node tools/version.mjs tag --ref HEAD --force --push

## Gate G2

verified_by: command node tools/version.mjs check
The command exits 0: the branch's number is strictly above the base's. That is
the gate's whole test. It never writes.
