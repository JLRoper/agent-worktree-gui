# Landing — split the assistant's settings into a Watchdog tab and per-assistant settings

Structure only. No wake behaviour changes in this PR: the same keys are read by the same code on the same
schedule. What changed is who draws which key and which file it is written to.

## Why

The float's Settings sub-tab mixed two scopes in one list. The alert switch, the pass clock, the command audit and
the per-rule escalation table are the panel's — there is one sentry for the whole board — but they sat beside each
assistant's own model, autonomy, spawn mode, wake budget and quiet windows. Once a second assistant existed, every
watchdog-wide control appeared twice, once per assistant, and each copy wrote a different file. Two controls for
one value is the defect this removes.

## What owns what

The ownership table lives in one place, `SETTINGS_SCOPE` in `lib/assistant/config.js`, next to `DEFAULTS`, so a key
added later cannot be owned by nobody or by both. `scopeOf(key)` answers from that table and nothing else; the page
and the server both read it.

Watchdog tab — the panel's, set once:

| key | what it is |
| --- | --- |
| `enabled` | the alert switch; while off no rule is evaluated |
| `commandAudit` | off / report / enforce — the journal's other half |
| `spawnAutoStart` | start a stuck spawn card once instead of only naming it |
| `seconds` | the pass clock |
| `rules.<id>` | each rule's level (log / alert / wake / act) |
| `repeatLimit`, `approvalSeconds`, `exitedSeconds`, `contextPercent`, `leftoverMinutes`, `repeatTurns`, `rearmSeconds` | the per-rule bars a pass measures |

Assistant's Settings tab — that assistant's own file:

| key | what it is |
| --- | --- |
| `prompt` | role prompt (edited in the Role tab) |
| `whitelists.projects`, `whitelists.worktrees` | the two whitelists (edited in the Role tab) |
| `maxWakesPerHour` | wake budget |
| `quietSeconds`, `childQuietSeconds` | quiet windows — the `quiet` and `child` rules' bars |
| `escalateTo` | its ordered escalation list (stored, inert) |
| `autonomy`, `spawn`, `model`, `cwd` | how its own turns run |

The role prompt and the two whitelists keep their existing home, the Role tab — they are the Role tab's subject and
moving them would have been a second structural change in one PR. The Settings tab's help names them so the reader
knows where they are.

## Stored but inert

`escalateTo` is stored and validated per assistant and the Settings tab renders an empty, ordered list for each —
but nothing reads it yet. The escalation ladder that runs every pass is still the per-rule `rules.*` table in the
Watchdog tab. Wiring the list into the wake decision would change wake behaviour, which this PR does not do. The
pane's help says so.

## Assistant #1 does not move

`settingsFor(1)` still returns the live settings object the panel booted with, out of the same file, on the same
legacy routes with no `assistantId` on them. Its scratchpad and journal paths are unchanged. A test asserts its
served settings payload is byte-identical to the pre-split shape.

## The second assistant writes its own file

An assistant's Settings tab edits `config.assistantSettings[id]` and posts it to `/api/assistant/<id>/settings`,
which the server stores in `config.assistantSettings[id]` and its own file. A POST carrying an `assistantId` never
touches #1's object. `GET /api/assistant/<id>/settings` answers that assistant's payload; `GET /api/settings`
carries all of them.

## Checks run

- `npm test` (`node --test --test-concurrency=4 test/*.test.js`) — 742 tests, 742 pass, 0 fail. The split's own
  facts are in `test/assistant-settings-split.test.js` (one owner per key; #1's served payload and byte-identical
  store; an assistant editing only its own file; the list stored, ordered and inert) and
  `test/assistant-thresholds.test.js` (each pass-owned bar under its rule; the two quiet windows in the session's
  pane; no `data-as-set` key in both tabs; bounds and the aggressive-mode disabled handling on both sides).
- `node tools/verify-assistant-subtabs.mjs` — 110 checks, 0 failed, over a sandbox panel and a real headless
  Chromium (the row's new Watchdog tab included).
- A headless Chromium probe against a sandbox panel: 20/20 checks — both panes render (Watchdog groups *The
  watchdog*, *Every pass*, *Per-rule escalation*, *Now*; the session's *How it behaves*, *Its wake budget and quiet
  windows*, *Escalate to* with the empty list drawn), and a Watchdog value round-trips through a page reload:
  `seconds` set to 7 in the browser reached `/api/assistant` as 7 and came back as 7 in the input after the reload,
  while the assistant's own `maxWakesPerHour`/`quietSeconds` did not move.

## Re-verification on 0.52.0 (2026-11-02)

This brief was re-issued after the split landed, so this section is a re-check rather than a second
implementation. The split is PR #189, merge commit `65f1e8e` (2026-11-02T02:48:34Z), version 0.51.0.
`git diff --stat 65f1e8e origin/main -- lib/assistant/config.js lib/assistant/profile.js public/assistant.js
public/index.html test/assistant-settings-split.test.js test/assistant-thresholds.test.js` is empty: the code
this document describes is byte for byte what main carries, so nothing below needed re-doing.

| the brief's item | where it lives | the read on 0.52.0 |
| --- | --- | --- |
| the Watchdog tab holds exactly the watchdog-scope keys | `SETTINGS_SCOPE` (`lib/assistant/config.js:159`), `WATCHDOG_KEYS`/`ASSISTANT_KEYS` derived at `:189-190`, served as `state.settingScope` (`lib/assistant.js:1016`), drawn by `renderWatchdog` (`public/assistant.js:1701`) | 12 keys: `enabled`, `rules`, `commandAudit`, `spawnAutoStart`, `seconds`, `repeatLimit`, `approvalSeconds`, `exitedSeconds`, `contextPercent`, `leftoverMinutes`, `repeatTurns`, `rearmSeconds` — 10 `data-as-set` inputs plus the 17-rule escalation table |
| an assistant's tab holds only assistant-scope keys | `renderAssistantSettings` (`public/assistant.js:1814`) | 10 keys: `autonomy`, `spawn`, `model`, `cwd`, `maxWakesPerHour`, `quietSeconds`, `childQuietSeconds`, `prompt`, `whitelists`, `escalateTo` — 7 `data-as-set` inputs, with the role prompt and the two whitelists still edited in the Role tab and named in the pane's help |
| an empty-but-rendered per-assistant escalation list | `escalateTo` in `lib/assistant/profile.js` (`pickEscalation`, `ESCALATION_MAX` 8), served at `lib/assistant.js:1019` | drawn under *Escalate to*, empty and ordered, with the pane saying nothing acts on it yet |
| Assistant #1 byte-identical | `settingsFor(1)` returns `this.settings` (`lib/assistant.js:579`); the legacy routes carry no `assistantId` | `test/assistant-settings-split.test.js` pins the 19-key payload literally and hashes the store |
| unit tests for the split | `test/assistant-settings-split.test.js` (7), `test/assistant-thresholds.test.js` (8) | 15 tests, 15 pass |
| `npm test` green | `node --test --test-concurrency=4 test/*.test.js` | 752 tests, 752 pass, 0 fail |
| both tabs render, a Watchdog value round-trips a reload | `tools/verify-assistant-subtabs.mjs` plus a probe | 110 checks, 0 failed; the probe 14/14 |

The probe booted a sandbox panel of its own and drove headless Chromium over it. It measured: the Watchdog
pane draws *The watchdog*, *Every pass* and *Per-rule escalation* with 10 `data-as-set` keys and 17
`data-as-rule` selects; the session's Settings pane draws 7 `data-as-set` keys and the empty *Escalate to*
list; no `data-as-set` key appears in both panes; `seconds` set to 7 in the browser reached `/api/assistant`
as 7 and came back as 7 in the input after a page reload, while `maxWakesPerHour` (0) and `quietSeconds`
(240) did not move; no page errors.

## Version

`0.50.2 → 0.51.0`, minor: two new panes and a new stored field, with the old routes and payloads still answering.

The re-verification record above is `0.52.0 → 0.52.1`, patch: a doc and nothing a reader can use, per
`docs/versioning.md`'s "a doc". The brief that asked for this work named 0.51.0, but that number was spent by
the merge that landed the split itself, so a fresh minor here would inflate main's number for a re-check.

## Re-verification on 0.53.2 (2026-11-02, at `622940f`)

The brief was issued a second time with its list all `todo` and its number `0.51.0`, and the branch arrived carrying
none of its own commits: `git rev-list --left-right --count origin/main...HEAD` printed `1 0` (one behind origin,
none ahead), and fast-forwarding onto `origin/main` made that `0 0`. `package.json` reads **0.53.2**. The split
landed as PR #189 (`65f1e8e`, 0.51.0) and a first re-check recorded 0.52.1, so this pass is a re-read at a moved
base, not a second implementation.

The split's own table is unchanged; later landings added to the files around it. `git diff --stat 65f1e8e origin/main
-- lib/assistant/config.js lib/assistant/profile.js public/assistant.js test/assistant-settings-split.test.js
test/assistant-thresholds.test.js` is 3 files, 252 insertions, 2 deletions: the queue's two knobs
(`queueDigestSize`, `queueSweepEveryNWakes`) in the assistant half of the table, the escalation list's editor in
`public/assistant.js`, and their tests. No key changed owner.

| anchor | at `65f1e8e` (0.51.0) | at `622940f` (0.53.2) |
| --- | --- | --- |
| `SETTINGS_SCOPE` | `lib/assistant/config.js:159` | `lib/assistant/config.js:165` |
| `WATCHDOG_KEYS` / `ASSISTANT_KEYS` | `lib/assistant/config.js:189` / `:190` | `lib/assistant/config.js:199` / `:200` |
| `settingsFor` | `lib/assistant.js:578` | `lib/assistant.js:827` |
| `state()` | `lib/assistant.js:959` | `lib/assistant.js:1238` |
| …its `settingScope` | `lib/assistant.js:994` | `lib/assistant.js:1273` |
| `renderWatchdog` | `public/assistant.js:1701` | `public/assistant.js:1704` |
| `renderAssistantSettings` | `public/assistant.js:1798` | `public/assistant.js:1801` |

(THEN read with `git show 65f1e8e:<path> | grep -n`; the 0.52.0 section above quoted a render line rather than the
declaration for two of these, which is why its numbers differ by a few.)

| the brief's item | the read at `622940f` |
| --- | --- |
| the Watchdog tab holds exactly the watchdog-scope keys | 12 keys in the table — `enabled`, `rules`, `commandAudit`, `spawnAutoStart`, `seconds`, `repeatLimit`, `approvalSeconds`, `exitedSeconds`, `contextPercent`, `leftoverMinutes`, `repeatTurns`, `rearmSeconds`. The pane draws 10 `data-as-set` inputs plus the 17-rule table; `rearmSeconds` is a knob with no control and always has been (`test/assistant-thresholds.test.js:73-75`) |
| an assistant's tab holds only assistant-scope keys | 12 keys — `autonomy`, `spawn`, `model`, `cwd`, `maxWakesPerHour`, `quietSeconds`, `childQuietSeconds`, `queueDigestSize`, `queueSweepEveryNWakes`, `prompt`, `whitelists`, `escalateTo`. The pane draws 7 inputs; the role prompt and the two whitelists stay in the Role tab, the escalation list has its own editor, and the queue's two knobs have no control yet |
| an empty-but-rendered per-assistant escalation list | drawn under *Escalate to — the assistants this one would hand a subject to*, reading `(empty — this assistant hands nothing to another one)`, with the pane saying nothing acts on it yet |
| Assistant #1 byte-identical | `settingsFor(1)` returns `this.settings` (`lib/assistant.js:827-829`); the 21-key payload is pinned literally and the store hashed by `test/assistant-settings-split.test.js`; its scratchpad and journal are still the one `assistant.json` beside the job store, with no `assistants/assistant-1/` file |
| legacy routes carry no `assistantId` | the page sends `assistantId` only when the control carries `data-as-for` (`public/assistant.js:2657-2661`), which #1's pane never sets; `POST /api/assistant/settings` with no id calls `setSettingsFor(undefined, …)` (`server.js:2268-2282`) |
| unit tests for the split | `test/assistant-settings-split.test.js` 6 + `test/assistant-thresholds.test.js` 9 = 15, 15 pass |
| `npm test` green | `node --test --test-concurrency=4 test/*.test.js` — 787 tests, 787 pass, 0 fail (74.6 s), `EXIT=0` |
| both tabs render, a Watchdog value round-trips a reload | `tools/verify-assistant-subtabs.mjs` 110 checks, 0 failed; a probe of its own 22 checks, 0 failed |

The probe (`%TEMP%/wag/a79d4c1e/watchdog-split-probe3.mjs`, booting this tree's own `server.js` through
`tools/panel-testkit.mjs` on a sandbox port) measured: the float's row is `Assistant #1, Alerts, Watches, Messages,
Scratchpad, Role, Watchdog` with no Settings among them; the Watchdog pane draws *THE WATCHDOG*, *EVERY PASS*,
*PER-RULE ESCALATION* and *NOW*, its 10 inputs all `scopeOf === "watchdog"`, and 17 rule selects; the session's
Settings pane draws its 7 inputs, all `scopeOf === "assistant"`; the two drawn sets do not intersect; `seconds` set
to 7 in the browser reached `/api/assistant` as 7 and came back as 7 in the input after a reload, while
`maxWakesPerHour` (0) and `quietSeconds` (240) did not move; no page errors. A `seconds: 3600` in the sandbox config
clamps to the knob's own 120 s bound on the way in, which is the bound doing its job, not a moved default.

### The gate this pass had to correct

`tools/verify-assistant-subtabs.mjs` deep-equalled the session's sub-tab row to `["chat", "settings"]`. Commit
`935bfc4` (the per-assistant task queue) added a third sub-tab, `queue`, and updated
`test/assistant-subtabs.test.js:242` to expect `["chat", "settings", "queue"]` — but left the shipped gate asserting
two, so the gate was red on main: 110 checks, 2 failed, on `the session's own row` and `…labelled`. That is stale copy
from a later landing, not a defect in the split and not this branch's regression; the assertion is corrected here to
the three-tab list (the header comment with it) and the gate then reads 110 checks, 0 failed. No product code is
touched by this pass.

### Version (`0.53.2 → 0.53.3`)

Patch: a doc and a stale assertion in a verification script, nothing a reader can use — `docs/versioning.md`'s "a
doc". The brief named 0.51.0, but that number was spent by the merge that landed the split itself, and main has since
moved to 0.53.2, so this branch takes the next patch over main rather than re-spending a minor.
