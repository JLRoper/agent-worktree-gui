# Per-assistant settings, role prompts and whitelists landed as 0.49.0 — this tree re-checks it

Read on branch `wtgui/give-each-assistant-its-dbf0ec`, cut from `main` at `8237843` (0.50.0), on 2026-11-01 at
20:52 EST. The tree carries **no commits of its own** at the start of this run: the feature below is already on main,
so nothing here re-implements it.

**Answer: all seven items of the brief are already on main, delivered by PR #184 (merge commit `554d1cd…`, 0.49.0).
This branch adds this record and a patch bump to 0.50.1, and no product change; the full suite passes on this tree
(735/735), including the ten tests in `test/assistant-profile.test.js` that pin the store, the prompt and the
whitelists.**

A sibling worktree (`wtgui/add-per-assistant-settings-and-role-prom-d0bb9b`) was given the same brief and landed it
before this tree was written in. Re-doing it would have been a second implementation of one data shape, a second
`settings.json` reader, and a version number (0.49.0) already spent — so this run verified the landed code item by item
instead, with the tests and the code pointers below.

## The data shape, as landed

```
state/assistants/assistant-N/settings.json
  { version: 1, savedAt, settings, rules, prompt, whitelists: { projects: [], worktrees: [] } }
```

- **One file per assistant, beside that assistant's charter.** Assistant #2 and later own
  `state/assistants/assistant-N/settings.json` (`profileRelFor`, `lib/assistant/profile.js:31`); Assistant #1's knobs
  stay in `state/assistant.json` and are not migrated.
- **`settings` and `rules` are the same picked shapes `assistant.json` already carries** (`pickSettings` /
  `pickRules`), and only the keys the reader chose are written, so an untouched knob keeps following its default. The
  wake knobs (`maxWakesPerHour`, `quietSeconds`, `childQuietSeconds`) are `pickSettings` keys and travel in that block,
  so #2's budget and quiet windows are its own numbers.
- **`prompt` is the default role prompt**, capped at 8000 characters (`PROMPT_CAP`), injected near the top of every
  turn of that assistant (`lib/assistant.js:2150`).
- **`whitelists.projects` and `whitelists.worktrees` are two short lists**, parsed from what the box posts
  (`parseWhitelist`: commas and newlines both separate, blanks dropped, duplicates folded case-insensitively, 24
  entries of up to 200 characters each). `*` survives as its own entry and is never expanded in the file, so the file
  says what the reader wrote.
- **Assistant #1 may carry this file too, but only the two fields `assistant.json` has never held** — `prompt` and
  `whitelists` — and only once the reader uses them. With no such file its `/api/assistant` answer is the payload it
  always was, and `assistant.json` is byte-identical.

The reading of a list is deliberately three-way (`whitelistMatches`, `lib/assistant/profile.js:91`): an **empty** list
means every name (a blank box must not hide the board from an assistant that was working before the box existed);
`*` anywhere in the list means every name; otherwise one entry has to equal one of the names the target is known by —
compared whole, never as a prefix, case-insensitively, with separators and a trailing slash normalised. A name that
matches nothing is allowed and simply matches nothing.

## Each item, against the code

| # | item | where it lives | the test that pins it |
|---|---|---|---|
| 1 | Per-assistant settings, own profile beside the charter, nothing migrated for #1 | `settingsFor` / `setSettingsFor` / `profilePathOf` (`lib/assistant.js:523`, `:577`, `:599`); the file module is `lib/assistant/profile.js` | *a second assistant's knobs are its own, and Assistant #1's file is not touched* — `assistant-profile.test.js:80`, including `assert.equal(sha(assistant.json), before)` at `:106` |
| 2 | Per-assistant default role prompt, saved by the Role tab, runs after a restart | `POST /api/assistant/profile` (`server.js:2132`), the pane's `#as-prompt-text` and *Save default prompt* (`public/assistant.js:1543`), injected at `lib/assistant.js:2150` | *the default role prompt is saved by the Role tab's route and read back after a restart* — `:128`, which boots a **second `Assistant` instance** over the same state directory and reads the prompt, the preamble and the Role payload back |
| 3 | Two whitelist inputs: `*` or blank is all, comma or newline separated | `#as-projects` / `#as-worktrees` and *Save whitelists* (`public/assistant.js:1556`–`:1568`); the parser is `parseWhitelist` (`profile.js:47`) | *whitelist matching: \*, an exact name, an empty list, and a name nothing matches* — `:167`; the parser's own cases at `:182` |
| 4 | Enforced where the assistant is shown projects and where SPAWN / SPAWN IN may target | the preamble filters the project list and says how many it is hiding (`lib/assistant.js:2130`); `spawnAllowed` (`:683`) is consulted where the SPAWN line is read, before a card exists (`:2619`), and re-checked when the card is pressed (`startSpawn`, `:3145`) — a card must not become a way around a list the reader has since tightened | *the preamble shows only the whitelisted projects…* `:261`; *a SPAWN outside the project list is refused where the line is read — no card, no run* `:218`; *a SPAWN IN outside the worktree list…* `:248` |
| 5 | Assistant #1 keeps byte-identical files, routes and behaviour | no `assistantId` on `POST /api/assistant/settings` still means #1 (`server.js:2186`); #1 writes only `prompt` and `whitelists` to the new file, and only when used (`lib/assistant.js:646`) | *Assistant #1 with no profile file answers the same payload it always did* `:277`, plus the sha assertion above |
| 6 | Unit tests: isolation, prompt save/restore across a restart, whitelist matching | `test/assistant-profile.test.js`, 302 lines | 10 tests, all passing (below) |
| 7 | Bump, `npm test`, push, PR | — | this commit and its PR |

A SPAWN is a choice of **project**, so the projects list decides it; a SPAWN IN is a choice of **tree**, so the
worktrees list decides it, and a project name counts as one of that tree's names — a reader who whitelists
`agent-worktree-gui` means its trees. `spawn: off` is not read in `spawnAllowed`: that switch is checked where the line
is carried out, so each refusal keeps its own message.

## Checks run in this tree

| what | command | result |
|---|---|---|
| the feature's own suite | `node --test test/assistant-profile.test.js` | **10 tests, 10 pass, 0 fail**, 440 ms |
| the whole suite | `npm test` (`node --test --test-concurrency=4 test/*.test.js`) | **735 tests, 735 pass, 0 fail, 0 skipped**, 75.9 s, `EXIT=0` |
| the merge of the feature is on main | `gh pr view 184 --json state,mergeCommit` | `MERGED`, `554d1cd6164e5a8f61a83ef78cf46500be9477de` |
| that merge's own version | `git show 554d1cd:package.json` | `0.49.0` |
| main still carries the feature unchanged | `git diff --stat 554d1cd origin/main -- lib/assistant/profile.js lib/assistant.js public/assistant.js server.js test/assistant-profile.test.js` | empty |
| the merge is an ancestor of main | `git merge-base --is-ancestor 554d1cd origin/main` | exit 0 |

## Why the level is patch, not the brief's minor

The brief asks for 0.49.0 as a minor "because it is a feature", and for the next free minor if main already carries
it. Main does carry it — 0.49.0 is the number PR #184 landed, and main has since moved to 0.50.0 for the Combined
output default. But this branch adds **no feature**: it adds this document. `docs/versioning.md` files a doc under
patch, and a minor here would spend 0.51.0 on a change that adds nothing a reader can use, pushing every later
feature's number up for it. So 0.49.0 → **0.50.1**, and the pre-push gate still sees a number strictly above main's.

The 0.49.0 that the feature itself carries is the merge commit's number, not main's current one.
