# The cross-project report is out of the changelog, and the next one cannot get in

`v1.76.24` listed a retest report for **PictureViewer** and **Picture Manager** as this panel's work. It was a real
report about real work - SSO retest on `dev`, DMR-39015 - but it is not this repository's work, and it got here
because a landing agent copied the report it had just written for two other applications into this repo's `docs/`
and pushed it. Two reports came that way, in fact: the retest report named in the brief (`719425b4`, 193 lines,
in `v1.76.24`) and a deploy evidence report (`6f31b5c`, in `v1.8.5`).

Main's history is not rewritten for it. The reports are preserved outside this repository, deleted here in a new
commit, and the changelog is repaired by a render that cannot list a docs commit naming another project.

## The reports are preserved, byte for byte

`pictureviewer` and `picture-manager-web` are not repositories this agent can commit to: neither carries the
report, and neither has a landing branch for it. So both reports went to a local path outside every repository,
`~/.wag/reports/`, written from the committed blob rather than from a checkout, so the file is the record and not
a CRLF copy of it:

| report | preserved as | proved by |
| --- | --- | --- |
| `docs/landing-pictureviewer-pmw-sso-retest-2026-11-09.html` | `~/.wag/reports/landing-pictureviewer-pmw-sso-retest-2026-11-09.html` | sha256 of the copy equals sha256 of `git cat-file blob HEAD:<path>` |
| `docs/landing-pictureviewer-pmw-sso-deploy-2026-11-04.html` | `~/.wag/reports/landing-pictureviewer-pmw-sso-deploy-2026-11-04.html` | same |

A local path is the honest destination: it keeps the evidence, it is not a claim that this repo owns it, and it
does not require a commit into a project whose own landing rules this agent has not been given.

## One list, read by the renderer and by the gate

`tools/changelog-scope.json` names the projects whose reports do not belong in this changelog. `PictureViewer`,
`Picture Manager` and `PMW` are there today. A token is matched case-insensitively on a word boundary, with
`-`, `_`, `.`, `/` and `\` read as word separators, so `PictureViewer`, `picture-viewer` and `picture_viewer` all
match one entry, and the ordinary English word "picture" does not.

The rule is one sentence: **a docs commit that names another project, in its subject or in a path it adds or
edits, is out of scope**. Two halves keep it honest:

- **A deletion is not a match.** Removing another project's report is this repository's own cleanup, and the
  commit that removes the reports must be able to say so. That is why the two deletions are in this branch's
  changelog and the two additions are not.
- **The subject and the path are one rule.** A neutral subject such as `docs: name the retest evidence without
  machine paths` was enough to get the first report listed, because the path was foreign even when the subject was
  not. The gate judges the staged path as well as the subject.

`tools/changelog-scope.mjs` is the module both halves use, and `tools/changelog.mjs` now filters each release's
commits through it, so the omission is a printed fact on every render (`... 3 docs commits named another project
and were left out`) rather than a section that quietly got shorter.

The repair has a second half, for a file that already carries the report: a section `CHANGELOG.md` already holds
is normally kept byte for byte, and re-rendering 515 sections is the `--full` walk this landing cannot afford. So
a kept section whose bullets name another project is **not** kept; it is rendered again from its own range, where
the filter leaves the foreign commits out. That is what removes the report from `v1.76.24` (and `6f31b5c` from
`v1.8.5`) in a forward render of `3` sections instead of a full walk.

## The stop, at the commit

`.githooks/commit-msg` reads the same list, through the same module, against the message and the staged paths, and
refuses the commit with the project and the route named:

```
commit-msg: refused - this docs commit names another project
  subject: "docs: PictureViewer and Picture Manager SSO retest on dev with deploy evidence (DMR-39015)"
  it names pictureviewer in its subject, which is not this repository's work.
```

Only exit `1` refuses: a hook that cannot run its own check must not block a commit, so a missing `node`, a missing
tool or any other exit passes. The changelog half is the repair; this half is the stop, so a second report cannot
follow the first by the same route.

## What was run

- `node --test test/changelog-scope.test.js` - 8 tests, all pass: the vocabulary, the rule (subject, path,
  deletion), the renderer's control (no list means no filtering), the forward repair of a kept section, and the
  real `.githooks/commit-msg` driving real `git commit` refusals in a sandbox.
- `npm run test:changed` - the tests that name the diff.
- `npm test` - the full suite, once, before the pull request.
- The served changelog: the panel started from this tree, `GET /api/changelog` read back and the `v1.76.24`
  section checked to carry no report.

## Reversing it

If a project's reports do belong here after all, remove its token from `tools/changelog-scope.json` and render
again: the sections the filter shortened are re-rendered only while they name the project, so the list is the one
switch. The rule is deliberately about the project's NAME, because no git fact says "this path belongs to another
repository" - the subject and the path are the only evidence a commit carries.
