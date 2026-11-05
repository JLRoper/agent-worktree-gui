# The assistant reset — proof against the live panel

Status: measured, not designed. Seven calls to the live panel's `POST /api/assistants/:id/reset`, every
one of them `{"dryRun": true}`, between 2026-11-05T03:53:11Z and 03:57:35Z, plus read-only gateway
`GET /v1/runs/{id}` probes and one read-only `state.db` query. No code changed, no session was touched,
nothing was cleared. Where the brief's expected line is not what the endpoint does, §2.4, §5 and §6.4 say
so instead of smoothing it over.

Why this document exists: the design (`docs/research/assistant-reset-design.md`) and its tests were the
only evidence the feature had. `§5.3` of that design names the one measurement a build must make and
defers it. This run could not make that measurement either — the box has no clearable fence — and says
exactly which half is proven, which half is refused, and why.

## 0. Verdict

| the brief asks for | what the live panel answered |
|---|---|
| 1 · assistant-3 dry run lists one row per admission and per watch, with admission id + generation | **not reachable on this box.** The refusal is checked before the dry-run body (`lib/assistant/reset.js:387-406` sits above `:408-422`), so assistant-3 answers 409 and lists nothing. The two assistants that do answer 200 have `clear.admissions: []` — the box holds no clearable fence (§2). Watch rows are listed in full: 27 for Assistant #1, 12 for Assistant #2. |
| 2 · a dry run while a run is live refuses `assistant_live` and names the queued blockers | **reproduced, with one correction:** at 03:54:21Z Assistant #1 returned `409 assistant_live` naming `run_4e309a67…`, and the gateway read it `completed` two minutes later. The body does **not** carry a queued-blocker list — `block.queued` is a dry-run field, and no assistant's dry run on this box reaches it (§6.4). |
| 3 · `fence_unclearable` — an admission no card names — is refused, not faked | **reproduced three times, byte-identical:** `16e7a6a77b11413d9ef316e8c8ecb7e4` · generation 63 · seq 5851 · owner_epoch 18, copy `hermes --resume panel-assistant-3` (§4). |
| what a clear would send, from a fresh GET, and where | `{"admission_id":"16e7a6a77b11413d9ef316e8c8ecb7e4","execution_generation":63}` → `POST /v1/runs/run_bee7fd633e6a4821824ef01f7f650daa/resolve-unknown`, built in `lib/assistant/reset.js:427-454` from the GET at `:428`. **Never sent** — no card names that run (§3). |
| the honest gap | Recorded in full in §5.1: there is no clearable fence on this box to clear, so the admission-row half of item 1 is absent as a live body, by fact rather than by omission. |

## 1. The panel, and the code that served these calls

- PID **9880**, `node server.js`, started 22:33:35 local — the panel the brief names. Listening on
  `127.0.0.1:7331`.
- The serving checkout is the primary one, at commit **79e735b** — the same commit this branch is cut
  from. Its `lib/assistant/reset.js` is byte-identical to this tree's
  (`sha256 8a5a67fbc7ab5688024280be2c11118e753d80dc8ec04d0359e5b6d14cbc34e8`), and so is `server.js`
  (`6461a70b8d92e276b23ad5786341e46626f8facf69bc45d61ab606f8871aa575`). The serving checkout has
  uncommitted edits to `config.json` and `lib/jobs.js`; neither file is the reset's.
- `origin/main` was `4651ace` (1.12.2) when this run started and `dc16bcc` (1.12.3) when the doc was
  committed — parallel lanes land while a proof is being written. This branch carries 1.12.1 and adds no
  code, so the route proved here is the route that lands.
- The calls come from loopback, which `authorised()` admits without a token (`lib/http/transport.js:136-146`),
  so no secret was read for them and none appears in this document. The gateway probes in §3, §4 and §6
  read `API_SERVER_KEY` from the Hermes `.env` inside the probe and never print it.
- The route is mounted at `server.js:2551`, created at `server.js:962`; `POST` is the only method, and a
  dry run's whole mutating half is behind `dryRun === true` (`lib/assistant/reset.js:552-563`).

The seven calls, in order (bodies kept byte-for-byte):

| at (UTC) | call | status | bytes | body sha256 |
|---|---|---|---|---|
| 03:53:11 | assistant-3 · `{"dryRun":true}` | 409 | 763 | `5fb042c6…3952` |
| 03:53:17 | assistant-1 · `{"dryRun":true}` | 200 | 6762 | `adfb76fb…2737` |
| 03:53:17 | assistant-2 · `{"dryRun":true}` | 200 | 3072 | `83457029…f7d4` |
| 03:54:21 | assistant-1 · `{"dryRun":true}` while its run was live | 409 | 412 | `2c42b4d5…34a6` |
| 03:56:06 | assistant-3 · `{"dryRun":true}` | 409 | 763 | `5fb042c6…3952` |
| 03:56:06 | assistant-1 · `{"dryRun":true}` | 200 | 6758 | `a8503f23…ba67` |
| 03:57:35 | assistant-3 · `{"dryRun":true}` | 409 | 763 | `5fb042c6…3952` |

## 2. The dry runs, and the rows they list

### 2.1 Assistant #1 — 200, 27 watch rows, zero admission rows

Raw body, head (the whole `block`, `verdict`, `stillFenced`, and the start of `clear`):

```json
{"ok":true,"dryRun":true,"assistant":{"id":"assistant-1","name":"Assistant #1","threadId":"panel-assistant"},"block":{"unnameable":[],"queued":[],"unreadable":[]},"verdict":"clean","stillFenced":false,"clear":{"admissions":[],"wakes":[],"watches":[{"id":"7a6535e6","thread":"wtgui-two-gates-are-red-on-main-01-5b9b17","title":"spawned: Two gates are red on main 019ee58 (package.json 1.9.1); fix both, in this order. (1) node…","at":"2026-11-04T20:05:19.098Z","state":"done"},{"id":"2bf7ba6f","thread":"wtgui-main-6891028-carries-changel-4de640","title":"spawned: main 6891028 carries CHANGELOG v1.9.1 naming 6fc78bf, but the tag v1.9.1 now points at 6d…","at":"2026-11-04T20:14:00.776Z","state":"done"},…
```

The last row of that same body is this run's own watch:

```json
{"id":"464df8d2","thread":"wtgui-prove-the-reset-endpoint-aga-8503d9","title":"spawned: Prove the reset endpoint against a REAL fenced session and land the proof as docs/researc…","at":"2026-11-05T03:51:35.617Z","state":"watching"}
```

`keep` from the same 03:56:06Z body:

```json
{"queue":{"rows":196},"scratchpad":{"notes":8000,"rules":40,"journal":300,"alerts":58},"charter":{"chars":19955,"sha":"f8a08d837bbc"}}
```

Counted from the parsed body: `admissions` 0, `wakes` 0, `watches` 27. Every watch row is a row — id,
thread, title, `at`, `state` — not a count, which is what the dry run exists to give (§3.4 of the design).

The two calls a minute apart show the read is live, not cached: the 03:53:17Z body carried the same 27
watch ids with one row's `state` still `watching` (`096f08e9`) where the 03:56:06Z one reads `done`, and
`keep.scratchpad.alerts` moved 56 → 58 while `keep.queue.rows` (196) and the charter (`19955` chars,
`f8a08d837bbc`) did not move at all.

### 2.2 Assistant #2 — 200, 12 watch rows, zero admission rows

Raw body, head:

```json
{"ok":true,"dryRun":true,"assistant":{"id":"assistant-2","name":"Assistant #2","threadId":"panel-assistant-2"},"block":{"unnameable":[],"queued":[],"unreadable":[]},"verdict":"clean","stillFenced":false,"clear":{"admissions":[],"wakes":[],"watches":[{"id":"5d84a7b0","thread":"wtgui-undo-the-remote-for-the-poc-4a80e1","title":"sp…
```

`admissions` 0, `wakes` 0, `watches` 12.

### 2.3 Assistant #3 — 409, no rows at all

Its dry run is §4.1. The refusal is reached before the dry-run body, so `clear`, `keep` and `block` are
not in the answer — only the unnameable rows are.

### 2.4 Why item 1 cannot be shown as written

The route's order is fixed: enumerate → refuse → dry-run body → real resolve
(`lib/assistant/reset.js:344-454`). `fence_unclearable` is a refusal, so an assistant whose every unknown
row is unnameable never reaches the branch that lists rows. On this box that is assistant-3, and assistant-3
is the only assistant with a fence at all (§4.2). The two that answer 200 have nothing to name.

The row shape the endpoint builds when a fence *is* nameable is pinned by the committed test, run here from
this tree:

```
✔ the dry run reports every row and the queued run behind the fence, and sends no POST (149.4658ms)
✔ 409 assistant_live names the executing run, and a queued run is not executing (44.4219ms)
✔ 409 assistant_live also refuses on a parked control, even when the status is not started/running (33.1677ms)
✔ 409 fence_unclearable when every unknown row is unnameable, and nothing local is touched (44.0731ms)
✔ the resolve body is built from a fresh GET, never the card's cache, and the local half runs after the store re-read (51.5406ms)
✔ a partly blocked session is not 409: it resolves what it can, re-reads, and leaves the local half alone (51.3676ms)
✔ the route refuses a non-boolean dryRun, an unknown field, a GET and an id not in the roster (28.0478ms)
ℹ tests 7
ℹ pass 7
ℹ fail 0
```

`test/assistant-reset.test.js` asserts, for a seeded clearable row: `clear.admissions.length === 1`, its
`runId`, `admissionId`, `executionGeneration` ("the generation the fresh GET returned", while the card's
cached generation is deliberately wrong at 99), `action: "resolve-unknown"`, the card and its evidence; and
that the dry run's gateway calls are `["GET","GET"]` — no POST. That is the shape, proven at the unit
level; §5.1 is why it has no live twin on this machine.

## 3. What a clear WOULD send, and where the code sends it

A fresh `GET /v1/runs/{id}` — read here at 03:57:35Z, with the panel's own gateway key — for the run that
owns the one admission on this box:

```
run_bee7fd633e6a4821824ef01f7f650daa → HTTP 200
{"status":"unknown","admission_id":"16e7a6a77b11413d9ef316e8c8ecb7e4","execution_generation":63,"session_id":"panel-assistant-3"}
```

That is exactly the pair the resolve needs, and the body the route would build from it:

```json
{"admission_id":"16e7a6a77b11413d9ef316e8c8ecb7e4","execution_generation":63}
```

sent to:

```http
POST /v1/runs/run_bee7fd633e6a4821824ef01f7f650daa/resolve-unknown
```

Where the code does it:

- `lib/assistant/reset.js:113-141` — `resolveUnknown(runId, body)`. Line 115 serialises **exactly** two
  keys (`admission_id`, `execution_generation`); a third is 400 `invalid_params`
  (`gateway-fence-endpoints.md` row #3). The exact body is retried once, on a transport error only.
- `lib/assistant/reset.js:427-454` — the real call's loop: one **fresh** `GET /v1/runs/{runId}` per
  candidate (`:428`), a re-check that the run still reads `unknown` (`:433`), the both-ids check (`:439`),
  then the resolve at `:443` with `{admission_id: admissionId, execution_generation: generation}` read from
  that GET. The card's cached `executionGeneration` is never used — the design watched the generation move
  1 → 3 → 4 across one session.
- `lib/assistant/reset.js:203-214` — the dry run's admission row: `runId`, `admissionId`,
  `executionGeneration`, the `card`, the `evidence` (store generation and the card's `unknownAnswers`),
  `action: "resolve-unknown"`. `:186-201` is the split: a store row with no card whose run answers
  `unknown` goes to `unnameable`, one with such a card goes to `admissions`.

**None of this was sent.** No card on the panel names `run_bee7fd…` (§4.3), so the loop above never ran:
the values in this section were read directly from the gateway with the same GET the loop would make, and
they are the values a clear would put on the wire — not a receipt, and not a claim that a clear happened.

## 4. The `fence_unclearable` case

### 4.1 Three calls, byte-identical

03:53:11Z, 03:56:06Z and 03:57:35Z, each `{"dryRun":true}` for assistant-3, each 409, each 763 bytes with
sha256 `5fb042c6cb04a1131554ef15a375d2269bea6974c124ea96c6917e92c7dd3952`. Raw body, the 03:57:35Z one:

```json
{"ok":false,"code":"fence_unclearable","error":"not reset — the fence on panel-assistant-3 is held by an admission no card here names (admission 16e7a6a77b11413d9ef316e8c8ecb7e4 · generation 63). This endpoint can only settle an admission through the run that owns it; there is no session-keyed resolve. Nothing would be cleared, including the watches. Continue that session in a terminal: hermes --resume panel-assistant-3","thread":"panel-assistant-3","assistant":{"id":"assistant-3","name":"Assistant #3","threadId":"panel-assistant-3"},"admissions":[{"admissionId":"16e7a6a77b11413d9ef316e8c8ecb7e4","generation":63,"seq":5851,"ownerEpoch":18,"threadId":"panel-assistant-3","reason":"no card here names a run that owns this admission"}],"stillFenced":true}
```

Every value the brief names is there, from the call and not from the design: `16e7a6a77b11413d9ef316e8c8ecb7e4`,
generation `63`, `seq 5851`, `ownerEpoch 18`, and the copy pointing at `hermes --resume panel-assistant-3`.
The three identical hashes are themselves the proof that the two earlier calls changed nothing.

### 4.2 The store behind it, read-only

`state.db` opened `mode=ro`, the same question `lib/assistant/reset-store.js` asks:

```
unknown rows: 18
(5851, '16e7a6a77b11413d9ef316e8c8ecb7e4', 'run_bee7fd633e6a4821824ef01f7f650daa',
 'panel-assistant-3', 'unknown', None, 18, 63)
runtime_epoch: (1, 20, 'cb9436da131f402692e5209283140f58')
```

- 18 `unknown` admissions, **one per session**, 18 distinct sessions. Exactly one of them is a panel
  assistant's: `panel-assistant-3`. The other 17 are worker sessions (`wtgui-*`), which this route cannot
  address at all — it is scoped by `:id` → `rec.threadId` (`lib/assistant/reset.js:147-151`).
- the row's `owner_epoch` is 18 and the store's `runtime_epoch` is now **20** (the design read 19) — the
  store has advanced two epochs with the row untouched, which is the direct proof that a restart does not
  clear this: the fence is a store read, not a process's memory.
- after all seven calls the store still held 18 rows, the same 18. Nothing was written.

The journal agrees: no entry of kind `reset` (the panel's journal holds `queue` 8, `said` 5, `watch` 5,
`spawned` 5, `wake-route` 4, `rule-skipped` 3, `note` 3, `replay-skipped` 3, `queuesweep` 2,
`settle-watch` 2, and no `reset`). A real reset journals one (`lib/assistant/reset.js:328-333`).

### 4.3 Why no card names it

- 0 of the panel's 106 job cards carry `runId: run_bee7fd633e6a4821824ef01f7f650daa`.
- assistant-3 has 11 cards; the 10 with run ids are all `failed` (`run_30dd9558…`, `run_46cfd620…`,
  `run_7e226838…`, `run_9edc9174…`, `run_3f04f798…`, `run_e743877f…`, `run_236ff721…`, `run_cdb735e6…`,
  `run_e60d26d0…`, `run_3146ae8f…`), none of them the run the admission belongs to.
- The enumeration only ever sees runs through cards: `lib/assistant/reset.js:151` filters the job list to
  `thread === rec.threadId && runId`, probes each with a GET, and `:186-215` cross-references the store
  rows against those answers. No card → no GET → no name → `unnameable`, and with every row unnameable,
  the 409 at `:387-406`.

### 4.4 Refused, not faked

The body is a refusal: `ok:false`, `stillFenced:true`, the row carried in `admissions`, and a copy that
names the terminal command instead of a workaround. Nothing local was cleared — no watch dropped, no wake
dropped, no journal line — because the local half runs only after a store re-read shows no `unknown` row
(`lib/assistant/reset.js:456-479`, design §3.7).

What was **not** sent in this run: any non-dry reset for assistant-3 (or anyone), any
`resolve-unknown`, any `stop`, any `hermes --resume`, any panel or gateway restart. All seven calls were
`dryRun:true`; the mutating half of the route never executed.

## 5. The design limit, plainly

The gateway's resolve is **run-keyed**. `POST /v1/runs/{run_id}/resolve-unknown` needs a run id in the
path, and a session id in that slot is 404 `run_not_found` (`gateway-fence-endpoints.md` row #14). There
is no session-keyed resolve, and this route does not invent a run id: it names an admission only through a
card whose run still answers `unknown`. A fence whose owning run no card holds is outside what the endpoint
can address, so it refuses — and it refuses *before* touching the watches, because dropping the promises
around a fence that is still standing would be a lie (design §3.6).

The measured version is sharper than "the run id is gone", and worth recording precisely:

- the run id is **not** missing. The store's own `request_id` for the row is a run id —
  `run_bee7fd633e6a4821824ef01f7f650daa` — and the gateway still answers for it with the full pair
  (§3). This is not a session-keyed resolve; it is a run-keyed one whose run id the endpoint declined to
  take from the store.
- the limit is therefore the route's naming rule, not the gateway's memory: `lib/assistant/reset.js` has
  no path from a store row to a resolve. Adding one is a code change with a product question attached —
  should a panel turn settle a fence left by a previous gateway epoch, for a run no card ever owned? — and
  it is out of scope for this docs landing.
- it must not be simulated by hand. A `resolve-unknown` on that run is a real mutation of the live store
  and of `panel-assistant-3`'s FIFO, which the brief forbids and which would make this document's
  "nothing was cleared" false.

So, as measured on the build this document covers: **this fence could not be cleared from the panel at
all**, and the only remedy the panel could honestly offer was the one its copy gives — `hermes --resume
panel-assistant-3` (design §2).

> **Update — the fallback naming path landed.** The second bullet above is now history, not a limit:
> `lib/assistant/reset.js` names a row no card holds through the store's own `request_id` →
> `GET /v1/runs/{id}`, and accepts it only when that run reads `status: "unknown"` with the same
> `admission_id`. A 404, any other status, or another admission still refuses with this section's
> `fence_unclearable`. The GET in §3 is the exact evidence the fallback is built on. Nothing in this
> file's measurements changed — the mutation described above was still not performed.

### 5.1 The honest gap

There is **no clearable fence on this box**. `clear.admissions` is `[]` for both assistants that answer
200, and the one assistant with a fence answers 409. Consequently this document has no live dry-run body
containing an admission row, and the admission-row half of brief item 1 is absent as a live measurement —
by fact, not by omission. What stands in its place is: the live watch rows (§2.1), the exact live values a
clear would send (§3, read from the same GET the route makes), the row-construction code (`:203-214`), and
the committed test that asserts the row and the resolve body (7/7, §2.4).

The clear path itself — a real resolve through this route followed by a fresh `POST /v1/runs` accepted on
the same session — remains **unproven live**, and this document does not claim it. It is the measurement
design §7 still owes, and it needs a session whose fence has a card.

## 6. The live-run refusal

### 6.1 The call

03:54:21Z, assistant-1, `{"dryRun":true}`, 409, 412 bytes,
sha256 `2c42b4d599b284ceb67213464cb0fa22e6f642c1745d7c9a24ad03f1e41234a6`:

```json
{"ok":false,"code":"assistant_live","error":"not reset — Assistant #1 has a run still executing (run_4e309a67453a4a74b86fe4f2f024f714 · started 0m ago). Wait for it or stop it on its card; a reset never touches an executing turn.","runId":"run_4e309a67453a4a74b86fe4f2f024f714","thread":"panel-assistant","assistant":{"id":"assistant-1","name":"Assistant #1","threadId":"panel-assistant"},"stillFenced":false}
```

### 6.2 The window was real

- 03:54:15Z: `GET /api/assistant` read `running: true` for the assistant.
- 03:54:21Z: the dry run refused, naming `run_4e309a67…`.
- 03:57:35Z: `GET /v1/runs/run_4e309a67453a4a74b86fe4f2f024f714` read
  `{"status":"completed","admission_id":"b92af5934ed442118ad7a4306410b4ef","execution_generation":1849,"session_id":"panel-assistant"}`.

So the refusal was the gateway's own answer at the moment of the call, not a stale card: the same call a
minute earlier (03:53:17Z) had answered 200 `clean`, and the next one (03:56:06Z) did too. The live check
is per run, from `GET /v1/runs/{id}` (`lib/assistant/reset.js:366-382`), which is why the window is exactly
as long as the run.

### 6.3 Nothing was cleared

The call is a dry run and the refusal precedes every mutation. The committed test pins the same shape for a
refusal: `gateway.calls.map((c) => c.method)` equals `["GET","GET"]` — "a refusal mutates nothing".

### 6.4 What the refusal does not name

The brief expects the refusal to name "the queued blockers". It does not, and the code is deliberate about
that:

- the `assistant_live` body carries `runId`, `thread`, `assistant`, `stillFenced` and one sentence — no
  `block`, no queued rows (`lib/assistant/reset.js:372-380`);
- a `queued` run is explicitly **not** a refusal reason (`:31-35`, design §3.5): a queued run is admitted
  work behind the fence, and refusing on it would make the reset permanently refused by the very fence it
  exists to clear;
- queued runs are named in a **dry-run** body instead — `block.queued`, `{runId, executionGeneration, card}`
  (`:168-174`, `:349`), and the test seeds exactly that (`{runId:"run_2", executionGeneration:null,
  card:"card_2"}`).

On this box no assistant's dry run reaches that body with a queued row: Assistant #3 owns the only queued
card (`run_30dd955861fa460383ba196d7541054d`, gateway `{"status":"queued","execution_generation":null}`)
and its refusal is `fence_unclearable`, which carries no `block`. Recorded as a finding: the queue shows up
in the confirmation the reader reads, not in the live refusal.

## 7. Reproduce

```sh
# the panel the proof ran against: PID, boot, and the code it serves
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CreationDate,CommandLine"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7331/api/state

# 1 · assistant-3: the fence, three times (409 fence_unclearable, byte-identical)
curl -s -X POST http://127.0.0.1:7331/api/assistants/assistant-3/reset \
  -H 'Content-Type: application/json' -d '{"dryRun":true}'

# 2 · a dry run that answers 200 and lists its rows
curl -s -X POST http://127.0.0.1:7331/api/assistants/assistant-1/reset \
  -H 'Content-Type: application/json' -d '{"dryRun":true}'

# 3 · assistant_live: fire this while Assistant #1 has a run in flight
curl -s -X POST http://127.0.0.1:7331/api/assistants/assistant-1/reset \
  -H 'Content-Type: application/json' -d '{"dryRun":true}'
```

The live window in §6 was ~2 minutes wide; Assistant #1 runs often enough that a loop of the third call for
a few minutes will land inside one. A `200` there means the run finished — try again, do not change the call.

The gateway read in §3 and §6 needs the same key the panel sends — `API_SERVER_KEY` from the Hermes
`.env`, or `apiServer.key` in `config.json` — and is a plain read:

```sh
curl -s -H "Authorization: Bearer $(grep -m1 '^API_SERVER_KEY=' "$LOCALAPPDATA/hermes/.env" | cut -d= -f2-)" \
  http://127.0.0.1:8642/v1/runs/run_bee7fd633e6a4821824ef01f7f650daa
```

The store read is read-only and answers one question:

```sh
sqlite3 -readonly "$LOCALAPPDATA/hermes/state.db" \
  "SELECT seq, admission_id, request_id, target_session_id, status, owner_epoch, generation
     FROM session_admissions WHERE status='unknown' ORDER BY seq;"
```

## 8. What this proves, and what it does not

| | |
|---|---|
| **proven live** | the route is reachable and answers as designed; `fence_unclearable` names the right admission, generation, seq and epoch, three times, and clears nothing; `assistant_live` refuses a genuinely executing run and stops refusing when the run completes; a dry run lists every watch row and every kept count, and no POST is sent; the store still holds its 18 `unknown` rows and the journal has no `reset` line afterwards |
| **proven at unit level** | the admission row's fields and the exact `{admission_id, execution_generation}` resolve body, from a fresh GET, with the card's cached generation as a decoy (`test/assistant-reset.test.js`, 7/7) |
| **not proven** | a real clear through this route, and the `POST /v1/runs` that would follow it on the same session — there is no clearable fence on this box (§5.1) |
| **not this endpoint's behaviour** | a dry run that lists admission rows for assistant-3 (§2.4), and an `assistant_live` refusal that names queued blockers (§6.4) |
| **not done, by design** | no non-dry reset, no `resolve-unknown`, no `--resume`, no restart, no write outside this worktree |
