# Every worktree's owning assistant was already landed — record of the re-check

The brief asked for a worktree's owning assistant, by role label (`Manager 1` / `Manager 2` …, default
Assistant #1), stored and displayed only: a `Controlled by: …` line in the row's detail bullet list, an
optional chart column that starts OFF, a setter route, tests, a version bump, a push and a PR. All of that
is already on `main`, landed by PR #194; this tree was cut from `main` **after** the landing and carried no
commits of its own, so nothing was re-implemented, no product code changed here, and this document was the
branch's only commit. The brief has been re-issued twice since; the last section is the second re-check, written
after a later landing (`622940f`) renamed what both owner surfaces draw.

## What is on main, and where it came from

PR **#194** (`wtgui/assign-roles-to-worktree-assistants-25bdcb`, "feat: give every worktree an owning
assistant, shown as a role label") is `MERGED`, merged at `2026-11-02T04:39:18Z` as a rebase merge whose
merge commit is **`635404b`**. That oid was both `origin/main`'s tip and the re-check tree's `HEAD` when this
record was first written — `main` has moved on since (`28bad77`, 0.53.3, at the second re-check):

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
  way the lock is: `server.js:1698` `withAssistantOwners()` calls `server.js:1680` `assistantForRow()`, which
  reads `Locks.owner()` and resolves the label. It persists beside the lock in `lib/locks.js` — the
  `owners` map (`:100`, saved at `:288` as `owners` in `logs/locks.json`), `DEFAULT_OWNER = "assistant-1"`
  (`:55`), `ownerKey()` (`:70`) and `setOwner()` (`:165`). The key is the tree's six-hex tag, not the path or
  the branch, because the panel renames both and keeps the tag.
- **The field.** Every row carries `assistant: { id, name, label, role }` — the stored (or default) id, the
  assistant's own name ("Assistant #1"), the numbered role label ("Manager 1") and the bare role name
  ("Manager"). Absence in the store is the read-time default, `DEFAULT_OWNER`, with **no record written and no
  migration** — a pre-owners `locks.json` simply has no `owners` key (`lib/locks.js:114-121`). The three
  strings are resolved on every read (`server.js:1677` `ownerFields`): `roleNameOf()`
  (`lib/assistant.js:994`) is the role's name with a leading `Agent ` dropped, and `roleLabelOf()`
  (`lib/assistant.js:1006`) builds the numbered label on top of it — that name plus the assistant's position
  among the assistants on the same role, so #1 is `Manager 1` and a second Manager is `Manager 2`.
- **The setter.** `POST /api/worktree/assistant` (`server.js:2464`), the same shape as
  `/api/settings/columns`: panel token, `{ project, path, assistant }`, unknown project/row → 404, an unknown
  id → 404 with the store unmoved, and the answer carries the updated row. Setting `assistant-1` **clears**
  the entry rather than writing a record that means what the absent key already means. Beyond the brief it
  also requires a same-origin `Origin` (`pageCaller`, `lib/http/transport.js:158`), so the reader's browser
  can press it and an agent's own `curl`/`fetch` is refused.
- **The detail line.** `public/app.js:10366` `ownerDetailHtml()` renders
  `<li class="git-owner">Controlled by: Assistant #1 — Manager</li>` inside the same `ul.git-list` as the
  merge-state summary and the branch/verdict meta items, with the fallback sentence in its own span when the
  stored owner is gone. It reads the name and the role, never the id. **This is narrower than item 4's literal
  `Controlled by: Manager 1`:** `622940f` renamed both owner surfaces from the role label to the assistant's own
  name, on the finding that a label names a seat on a role rather than the assistant that controls the tree, and
  moved the numbered label into the chart cell's tooltip. The brief's intent — a bullet in that list that names
  the owner instead of drawing `assistant-1` — holds; its exact string does not, and `622940f` is a later
  landing, not something this branch may revert.
- **The chart column.** `public/app.js:12918-12928` adds
  `{ id: "assistant", label: "Assistant", min: 92, give: 0.8 }` to `CHART_COLUMNS`, so it is wired through
  `/api/settings/columns` (`lib/chart-columns.js:11` `CHART_COLUMN_IDS`) like every other switch. It is the one
  shipped default: `DEFAULT_HIDDEN_COLUMNS = ["assistant"]` (`lib/chart-columns.js:18`), which is the id
  stored when the reader turns it off. It is drawn only when switched on — `cells.assistant`
  (`public/app.js:10451`) is `ownerCellHtml(row)`, the assistant's NAME, with the numbered role label in its
  tooltip — counted in the settings group's `N/11` badge (`public/app.js:17783`) and the "N of 11 columns"
  sentence (`:17762`, text at `:17765`), and
  its 92 px minimum is part of the horizontal-scroll floor computed from the **shown** columns
  (`public/app.js:13135`).
- **Tests.** `test/worktree-assistant.test.js` (11 tests) pins the default, the setter round-trip through a
  restart, the `assistant-1` clears-it case, the unknown-id refusal, the tag-keyed store, the rename
  survival, two roles reading as two labels, the gone-owner fallback, the missing-`Origin` refusal and — added
  with the row-event fix below — that a tree's FIRST `row` frame already carries the owner; one test also reads
  the page's own marked region to check the cell draws the name and the role the server resolved.
  `test/owner-cell.test.js` (7 tests, added by `622940f`) builds the cell and the bullet out of that
  region: a row with no stored owner still names `Assistant #1` and never draws a bare dash, a reassigned row
  draws its own assistant's name with that role's numbered label in the tooltip, and the bullet reads the name
  then the role. `test/chart-columns.test.js` asserts `DEFAULT_HIDDEN_COLUMNS` is `["assistant"]` and drives
  the hidden subset through the header, the colspan and the order.
- **Wake untouched.** `git show 635404b --numstat` shows `lib/assistant.js` at `22 0`; the added field is
  `roleLabel` in `assistantList()` (`lib/assistant.js:1214`), and `rolePayload()` — the wake payload — is not
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

## Re-checked again on this tree, at `origin/main` `e379dc5` (0.56.0)

`date` read `Mon, Nov  2, 2026 12:46:52 AM` EST / `date -u` `Mon, Nov  2, 2026  5:46:52 AM` UTC, from
`C:/ProjectDevelopment/agent-worktree-gui/.worktrees/give-every-worktree-an-o-307c0f`. The tree was cut on
`622940f` (0.53.2) with `git rev-list --left-right --count origin/main...HEAD` reading `2 0`; it carried no
commits of its own, so it was fast-forwarded onto `28bad77` (0.53.3) before anything was measured. `main` then
moved twice while this branch was open — the assistant-dock landing and the queue gate, to `e379dc5` (0.56.0) —
so the branch was rebuilt there (its fix and its record re-created over `e379dc5`, `0.56.1`) and every number
below was re-measured on that tip. None of the code this branch touches moved with the base:
`git diff --stat 28bad77 e379dc5 -- server.js test/worktree-assistant.test.js public/app.js lib/locks.js
lib/chart-columns.js lib/scan.js` is empty.

- The eight brief items, against the code that ships: the store is `lib/locks.js` `owners` in `logs/locks.json`
  keyed by the tree's six-hex tag (`ownerKey`, `:70`), overlaid on each scanned row by `server.js:1703`
  `withAssistantOwners()` — the row itself is still built in `lib/scan.js:65` `scanWorktree()`, which knows
  nothing about owners. The row field, the setter and its refusals, the detail line and the column all exist as
  described above. The one place the brief's wording and the code differ is item 4, explained in the detail-line
  bullet: `622940f` deliberately replaced the role-label string with the assistant's name plus its role, and this
  re-check does not revert it.
- **Wake untouched.** `git grep -n "row.assistant" -- lib/assistant.js` finds nothing, and neither landing's diff
  contains `rolePayload()` (`lib/assistant.js:1092`); the only field `assistantList()` (`:1214`) gained is
  `roleLabel` (22 insertions, 0 deletions in `635404b`). `622940f`'s `lib/assistant.js` change only factors
  `roleNameOf()` out of `roleLabelOf()`, so the role and wake payloads are unchanged.

### The re-check found a defect: a tree's first row event lost the owner

The browser gate failed **2 of its first 4 runs on the base the fix was written on**, on exactly the two checks this feature owns — the
cell's tooltip and the detail bullet — while a fresh `/api/state` fetched at the failing moment carried
`label: "Manager 1", role: "Manager"` for every row. The panel was right and the page was drawing from a row
object that had no `assistant` at all:

- The overlay lived only in `withAssistantOwners` (`server.js:1703`), which walks the rows a SNAPSHOT carries.
- The page also replaces one row wholesale from a `row` frame (`public/core/sse.js:73` `queueRow` ->
  `placeRow`, `public/app.js:13538`), and those frames come from `lib/store.js:143` `putRow` — the scanner's own
  row, which knows nothing about owners.
- So a tree whose first scan reached the page before any snapshot had seen it drew `Assistant #1` with no
  `(Manager 1)` in its tooltip and `Controlled by: Assistant #1` with no `— Manager`, until the next full
  snapshot. A row that HAD been through a snapshot carries the field (the overlay mutates the store's own row
  objects), which is why the gate passed whenever no new row arrived early — the flake.
- `server.js:3995` had the same hole: the ⟳ reconcile route's own `row` frame was built as `{ ...after }`.

The fix is `ownerOnRow()` (`server.js:1713`), the same overlay applied where a row event is broadcast
(`server.js:386`) and to the reconcile answer (`server.js:3995`), so every row a browser receives carries
`assistant` — the brief's "every worktree row reports it", on both paths a row travels. No store, route or
payload shape changed.

- `node --test test/worktree-assistant.test.js` → the new test
  `a tree's FIRST row event carries the owner, before any snapshot has overlaid it` cuts a worktree after the
  board is up, reads the panel's own SSE and asserts the frame carries id/name/label/role. **Red on the previous
  tip** (`actual: undefined` for `assistant.id`), green here; the three owner suites were 26 tests, 26 pass on
  the base it was written on, and that file is inside the 802-test run at this tip.
- `node tools/verify-chart-columns.mjs` (a real Chromium over its own sandbox panel) → **41 checks, 0 failed on
  two consecutive runs at this tip**, and on three more at the base it was fixed on (before the fix:
  41/41, then 37/41, 39/41, 41/41 over four runs on the same product code). It drives ten of eleven headers at
  rest with no key in `config.json`, the owner column switched
  on to `11/11` with its header between Branch and Tip and its cell reading `Assistant #1` (tooltip
  `Assistant #1 (Manager 1) owns this worktree. Display only: …`), the expanded row's
  `Controlled by: Assistant #1 — Manager` beside the branch and the verdict, the stored list written in the
  chart's order, and a reload drawing what was stored.
- `npm test` on the final tip → **802 tests, 802 pass, 0 fail, 0 cancelled, 0 skipped**, 65.1 s (801 without this
  branch's new test; the 65 s run recorded against `e379dc5`).

## Version

`0.52.2`. Patch, not the 0.52.0 the brief names: the minor was spent by the merge that landed the feature
(`0.51.4 → 0.52.0`, `635404b`), and a commit that adds only this record adds nothing a reader can use — a
fresh minor would inflate `main`'s number and push every later feature up for it. `docs/versioning.md` files
a docs-only change under patch. The feature's own bump travelled with PR #194.

The first cut of this record took `0.52.1`; while it was open, `3d17063` landed the assistant-settings
record and took `0.52.1` as well, leaving `main` on that number. The branch was rebased onto that tip and
re-bumped one patch above it, so `package.json` here reads `0.52.2` and `node tools/version.mjs check` passes
against `origin/main`.

This branch spends **one patch over `main`'s `0.56.0` (`e379dc5`) — `0.56.1`** — for the same reason the
earlier record took a patch: the feature's minor travelled with PR #194 (`0.51.4 → 0.52.0`) and the rename with
`622940f` (`0.53.1 → 0.53.2`), while a display fix, its test and the record that explains it are patches under
`docs/versioning.md`. It rides in the commit that carries the fix.
