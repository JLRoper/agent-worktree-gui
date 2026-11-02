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

The ownership table lives in one place, `SETTING_SCOPE` in `lib/assistant/config.js`, next to `DEFAULTS`, so a key
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

## Version

`0.50.2 → 0.51.0`, minor: two new panes and a new stored field, with the old routes and payloads still answering.
