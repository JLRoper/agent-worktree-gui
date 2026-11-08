# Step 8: the first route prefix out of server.js

Step 8 of `docs/reports/module-map-2026-11-07.html` is: "routes/*.js in server.js, one prefix at a time, mounting from a
table." The report names no prefix to do first, so the landing brief's fallback decided it: the assistant queue,
`/api/assistant/queue`.

The premise in that fallback was already true, and this landing says so rather than pretending the work was larger:
the queue's handlers lived in `lib/assistant/queue.js` (`createQueueRoutes`), and `server.js` held one line for the
prefix, `if (await queueRoutes(req, res, route, url)) return;`. So there was no branch in the if-chain to lift. The cut
is the one step 8 still had left for this prefix: the HTTP adapter moves into `routes/assistant-queue.js`, and
`server.js` mounts it from a table it iterates.

## What changed

| File | Change |
| --- | --- |
| `routes/assistant-queue.js` | New. Holds the prefix's handler (`GET`, `POST`, the 405), lifted verbatim from `lib/assistant/queue.js`, plus `QUEUE_PATH`. |
| `server.js` | `PREFIX_MOUNTS` is the mount table; the request handler loops over it instead of the single `queueRoutes(...)` branch. The import points at `routes/`. |
| `lib/assistant/queue.js` | Loses the adapter and keeps the schema, the transitions and the file. The tests' import follows the adapter. |
| `lib/assistant/reset.js` | One comment now points at the adapter's new home. |
| `test/assistant-queue.test.js` | Imports `createQueueRoutes` from `routes/assistant-queue.js`. |

Two edits inside the lifted handler, both behaviour-free: the path literal became the exported `QUEUE_PATH` in the
match and in the 405 sentence, which renders the same bytes.

## Proof

`node --check` passes on every file touched: `server.js`, `routes/assistant-queue.js`, `lib/assistant/queue.js`,
`lib/assistant/reset.js`, `test/assistant-queue.test.js`.

The suite (`node --test --test-concurrency=4 test/*.test.js`, 246 files, run in ten shards because this session kills a
single call at 420 s):

- On the branch as cut from `4a63afa`: 1,994 tests, 1,987 pass, 7 fail.
- After the rebase onto `1.57.10` (`91c1ae9`), six of the ten shards were re-run before landing: 1,235 tests, 1,229
  pass, 6 fail, and the six are the same four files, all red at that base as well (the same four files at the base:
  16 tests, 10 pass, 6 fail). The last four shards were not re-run: the landing was stopped there, and none of the
  files in them is touched by this cut.
- The failures, every one of them red on a clean `git archive origin/main` export:
  - `test/gateway-permissions.test.js` (1): reads the checkout's `config.json`, which is gitignored and absent from any
    clean export, so the file throws `ENOENT` before a test runs.
  - `test/tool-call-rows.test.js` (1): its `part("function conversationSignature(", ...)` end marker no longer appears
    after the function in `public/app.js`.
  - `test/harness.test.js` (1): `tools/verify-child-rows.mjs` is not wired to a `package.json` script.
  - `test/settings-enter-key.test.js` (3) and `test/tail-chip-shared-rule.test.js` (1): source-text assertions on
    `public/app.js` and the settings markup that main no longer matches.

None of the five files was touched by this landing.

The differential (`diff-queue3.mjs`, kept in this run's scratch directory, not in the repo) boots two real panels, one
from a clean `origin/main` export and one from this worktree, over identically seeded state, and drives 12 requests at
both: GET list, GET one, GET an unknown id, POST on loopback with no token, POST with no action, POST add, POST state,
POST an unknown action, PUT, DELETE, a lookalike path that must fall through, and a final GET after the writes.

- All 12: same status, same `content-type`/`cache-control`, same body. Bodies are compared as bytes with only the
  throwaway state path and clock values (ISO strings, epoch milliseconds) normalised; every differing JSON path would
  have been named.
- The queue file the writes produced is identical across the two panels under the same normalisation.
- Positive control: the same harness pointed at a copy with `400` changed to `418` on the missing-action branch reports
  that one case as DIFF, so an all-SAME result is a measurement and not a harness that cannot fail.
- The 403 branch is not reachable over loopback by design (`authorised` returns true for loopback), so the differential
  cannot see it; `test/assistant-queue.test.js` drives the handler with `authorised` handed in and still passes.

## Owed

A panel restart is owed: `server.js` and `lib/**` changed, so the running panel is serving the old module graph.

No em dash (U+2014) and no en dash (U+2013) appear in this document: count zero.
