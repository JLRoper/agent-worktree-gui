# Every worktree's owning assistant was already landed — record of the re-check

The brief asked for a worktree's owning assistant, by role label (`Manager 1` / `Manager 2` …, default
Assistant #1), stored and displayed only: a `Controlled by: …` line in the row's detail bullet list, an
optional chart column that starts OFF, a setter route, tests, a version bump, a push and a PR. All of that
is already on `main`, landed by PR #194; this tree was cut from `main` **after** the landing and carried no
commits of its own, so nothing was re-implemented, no product code changed here, and this document is the
branch's only commit.

## What is on main, and where it came from

PR **#194** (`wtgui/assign-roles-to-worktree-assistants-25bdcb`, "feat: give every worktree an owning
assistant, shown as a role label") is `MERGED`, merged at `2026-11-02T04:39:18Z` as a rebase merge whose
merge commit is **`635404b`**. That oid is both `origin/main`'s tip and this tree's `HEAD`:

```
git rev-parse HEAD        -> 635404b1dd215ff6b25b2f463d39275aaa411ec2
git rev-parse origin/main -> 635404b1dd215ff6b25b2f463d39275aaa411ec2
git show 635404b:package.json | grep version -> "version": "0.52.0"
git merge-base --is-ancestor 635404b origin/main -> true
```

The landed commit's own accounting is `12 files changed, 717 insertions(+), 47 deletions(-)`, with
`lib/assistant.js` at **22 insertions and 0 deletions** — purely additive, which is what the "display only"
half of the brief turns on.

## The shape it has, against the brief's list

- **The row and the store.** The row is built by the scanner and the owner is overlaid on the snapshot the
  way the lock is: `server.js:1679` `withAssistantOwners()` calls `server.js:1661` `assistantForRow()`, which
  reads `Locks.owner()` and resolves the label. It persists beside the lock in `lib/locks.js` — the
  `owners` map (`:100`, saved at `:288` as `owners` in `logs/locks.json`), `DEFAULT_OWNER = "assistant-1"`
  (`:55`), `ownerKey()` (`:70`) and `setOwner()` (`:165`). The key is the tree's six-hex tag, not the path or
  the branch, because the panel renames both and keeps the tag.
- **The field.** Every row carries `assistant: { id, name, label }`; absence in the store is the read-time
  default, `DEFAULT_OWNER`, with **no record written and no migration** — a pre-owners `locks.json` simply has
  no `owners` key (`lib/locks.js:114-121`). The label is resolved on every read by `roleLabelOf()`
  (`lib/assistant.js:748`): the role's name with a leading `Agent ` dropped, then the assistant's position
  among the assistants on that role, so #1 is `Manager 1` and a second Manager is `Manager 2`.
- **The setter.** `POST /api/worktree/assistant` (`server.js:2439`), the same shape as
  `/api/settings/columns`: panel token, `{ project, path, assistant }`, unknown project/row → 404, an unknown
  id → 404 with the store unmoved, and the answer carries the updated row. Setting `assistant-1` **clears**
  the entry rather than writing a record that means what the absent key already means. Beyond the brief it
  also requires a same-origin `Origin` (`pageCaller`, `lib/http/transport.js:158`), so the reader's browser
  can press it and an agent's own `curl`/`fetch` is refused.
- **The detail line.** `public/app.js:12314` renders `<li class="git-owner">Controlled by: ${…label…}</li>`
  inside the same `ul.git-list` as the merge-state summary and the branch/verdict meta items, with the
  fallback sentence appended when the stored owner is gone. It reads `row.assistant.label`, never the id.
- **The chart column.** `public/app.js:12903` adds `{ id: "assistant", label: "Assistant", min: 92, give: 0.8 }`
  to `CHART_COLUMNS`, so it is wired through `/api/settings/columns` (`lib/chart-columns.js:11`
  `CHART_COLUMN_IDS`) like every other switch. It is the one shipped default: `DEFAULT_HIDDEN_COLUMNS =
  ["assistant"]` (`lib/chart-columns.js:18`), which is the id stored when the reader turns it off. It is
  drawn only when switched on, counted in `N/11` (`public/app.js:17764`) and the "N of 11 columns" sentence
  (`:17746`), and its 92 px floor is part of the horizontal-scroll floor computed from the **shown** columns
  (`:13116`).
- **Tests.** `test/worktree-assistant.test.js` (10 tests) pins the default, the setter round-trip through a
  restart, the `assistant-1` clears-it case, the unknown-id refusal, the tag-keyed store, the rename
  survival, two roles reading as two labels, the gone-owner fallback and the missing-`Origin` refusal.
  `test/chart-columns.test.js` asserts `DEFAULT_HIDDEN_COLUMNS` is `["assistant"]` and drives the hidden
  subset through the header, the colspan and the order.
- **Wake untouched.** `git show 635404b --numstat` shows `lib/assistant.js` at `22 0`; the added field is
  `roleLabel` in `assistantList()` (`lib/assistant.js:967`), and `rolePayload()` — the wake payload — is not
  in the diff at all. Nothing in `fired()`/`wake()`/`noteSettle` names `row.assistant`; the landed test
  asserts `lib/assistant.js` contains neither `row.assistant` nor `setOwner`.

## Re-checked on this tree, at `origin/main` `635404b` (0.52.0)

`date` read `Sun, Nov  1, 2026 11:49:46 PM` EST / `date -u` `Mon, Nov  2, 2026  4:49:46 AM` UTC, from
`C:/ProjectDevelopment/agent-worktree-gui/.worktrees/give-every-worktree-an-o-4c6918`. These numbers describe
the code this commit lands: the branch was rebased onto `3d17063` (0.52.1) after the measurement, and
`git diff --stat 635404b 3d17063 -- public test tools` is empty — that landing changed only its own record
document and the version line — so nothing the gate measured moved.

- `git rev-list --left-right --count origin/main...HEAD` → `0 0` before this commit (`0 1` with it): the
  tree was cut on the landing's own commit and had nothing of its own to land.
- `npm test` → **752 tests, 752 pass, 0 fail, 0 cancelled, 0 skipped**, 62.0 s.
- `node --test test/worktree-assistant.test.js` → **10 tests, 10 pass, 0 fail**, 14.0 s, one green line per
  brief item listed above.
- `node tools/verify-chart-columns.mjs` (real Chromium over its own sandbox panel) → **39 checks, 0 failed**,
  twice in a row. It drives the owner column absent at rest and `10/11`, switched on to `11/11` with the
  header between Branch and Tip and the cell reading `Manager 1` (never `assistant-1`), the expanded row's
  `Controlled by: Manager 1` line beside the branch and the verdict, the stored list written in the chart's
  order, and the reload drawing what was stored.
- **One honest caveat:** the first run of that browser gate failed 2 of 36 checks — `the chart draws the
  sandbox repo's rows` timed out after 60 s, so every check that needs a row passed vacuously and the
  role-label check saw an empty list. It was run immediately after the 62 s suite on a cold `%TEMP%` sandbox.
  The two runs after it, from their own new sandboxes, were 39/39. Nothing was changed between them.

## Version

`0.52.2`. Patch, not the 0.52.0 the brief names: the minor was spent by the merge that landed the feature
(`0.51.4 → 0.52.0`, `635404b`), and a commit that adds only this record adds nothing a reader can use — a
fresh minor would inflate `main`'s number and push every later feature up for it. `docs/versioning.md` files
a docs-only change under patch. The feature's own bump travelled with PR #194.

The first cut of this record took `0.52.1`; while it was open, `3d17063` landed the assistant-settings
record and took `0.52.1` as well, leaving `main` on that number. The branch was rebased onto that tip and
re-bumped one patch above it, so `package.json` here reads `0.52.2` and `node tools/version.mjs check` passes
against `origin/main`.
