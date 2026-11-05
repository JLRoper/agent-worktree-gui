# The reset names an admission by the store's request id

Status: measured on the live box, 2026-11-04/05. Lands as **1.12.8**.

The reset route could settle an unknown admission only through a run a *card* named. `panel-assistant-3`'s
fence had no such card, so every press answered `409 fence_unclearable` and the session stayed fenced.
The admissions store already held the run id the turn was admitted under (`request_id`), and the gateway
still answered for it. This report is the capture that decided the branch, the code that uses it, and the
proof that the name is verified rather than guessed.

## 1. The capture that decided it

One GET, the same call the route makes, against the live gateway on `127.0.0.1:8642`:

```
curl -s -H "Authorization: Bearer $API_SERVER_KEY" \
  http://127.0.0.1:8642/v1/runs/run_bee7fd633e6a4821824ef01f7f650daa
```

HTTP 200, 261 bytes, sha256 `82cd9c649b46bf2b932d3b1c3261956c1fb96a07ad77655dc23e28e2cf1f9082`:

```json
{"object": "hermes.run", "pending_controls": [], "run_id": "run_bee7fd633e6a4821824ef01f7f650daa", "status": "unknown", "session_id": "panel-assistant-3", "admission_id": "16e7a6a77b11413d9ef316e8c8ecb7e4", "execution_generation": 63, "output": "", "usage": {}}
```

Every condition the fallback requires is in that body:

| condition | value |
|---|---|
| the run exists (not 404) | `run_bee7fd633e6a4821824ef01f7f650daa` |
| `status` is `unknown` | `"unknown"` |
| `admission_id` matches the store row | `16e7a6a77b11413d9ef316e8c8ecb7e4` |
| the generation the resolve would carry | `63` |
| the session it belongs to | `panel-assistant-3` |

## 2. The store row behind it

`state.db` opened `mode=ro`, the same question `lib/assistant/reset-store.js` asks:

```
(5851, '16e7a6a77b11413d9ef316e8c8ecb7e4', 'run_bee7fd633e6a4821824ef01f7f650daa',
 'panel-assistant-3', 'unknown', 18, 63)
unknown rows total: 18
runtime_epoch: (1, 20, 'cb9436da131f402692e5209283140f58')
```

The row's `request_id` **is** a run id, and the gateway answers for it. That is the whole finding: the
route declined to take a run id the store already held.

## 3. The branch taken: matching

The GET is a match, so the fallback path is the live one — not the refusal. The route now:

1. enumerates cards as before, and probes each card's run once;
2. for a store row no card names, probes `row.request_id` (one GET per run id, cached for the enumeration);
3. accepts the name only when the answer is `status: "unknown"` **and** `admission_id === row.admissionId`;
4. sends the same paired `{admission_id, execution_generation}` resolve to **that** run id, after a fresh
   GET re-pins both values.

`lib/assistant/reset.js:207` is the fallback (`nameByStoreRequest`), `:279` is where a row no card names
reaches it, and `:505-529` is the real call's fresh GET, admission re-pin and resolve.

## 4. The refusals

The name is verified, never guessed. Each of these leaves the row unnameable, records the reason on the
row (`requestId`, `refusal`, `reason`), and falls through to the existing `fence_unclearable` copy:

| case | `refusal` | what the row says |
|---|---|---|
| the GET 404s | `run_not_found` | `the store's request id run_… is gone from the gateway (404)` |
| the status is not `unknown` | `not_unknown` | `the run at the store's request id run_… now reads completed, not unknown` |
| `admission_id` differs | `admission_mismatch` | `the run at the store's request id run_… owns another_admission, not 16e7…` |

The live-run rule is kept on the fallback too: a verified run that is `started`/`running` (or parked on a
control) still refuses with `409 assistant_live`, and a `queued` run is listed in `block.queued` and never
blocks the reset.

## 5. Tests

`test/assistant-reset.test.js` — 13/13 pass, six of them new:

```
✔ the store's request id names an admission no card names, and the resolve is the same paired body
✔ a 404 on the store's request id falls through to the existing fence_unclearable copy
✔ a run that no longer reads unknown falls through to fence_unclearable, not assistant_live
✔ a run that answers unknown for another admission is refused, not resolved
✔ a fallback run that is executing still refuses as assistant_live
✔ a queued fallback run is listed behind the fence and does not block a reset
```

The matching test asserts the wire body is exactly
`{"admission_id":"16e7a6a77b11413d9ef316e8c8ecb7e4","execution_generation":63}` on
`POST /v1/runs/run_bee7fd633e6a4821824ef01f7f650daa/resolve-unknown`, and that the dry run sends no POST.

`tools/verify-assistant-reset.mjs` — the real HTTP route against a sandboxed panel and stub gateway,
**82/82 checks**, including a new fallback section:

```
PASS  fallback: the run is the store's request id: "run_fb"
PASS  fallback: no card names it: null
PASS  fallback: the evidence says how it was named: "store-request-id"
PASS  fallback: the dry run sent no POST: 0
PASS  fallback: the resolve path is the store's run id: "run_fb"
PASS  fallback: the paired body: {"admission_id":"adm_fb","execution_generation":63}
PASS  fallback: the store row settled: []
```

## 6. The live enumeration, read-only

`enumerateReset` called against the real `state.db` and the real gateway, with no cards and no route —
so no POST and no mutation. Before this change the row was `unnameable`; now:

```json
{
  "verdict": "clearable",
  "admissions": [
    {
      "runId": "run_bee7fd633e6a4821824ef01f7f650daa",
      "admissionId": "16e7a6a77b11413d9ef316e8c8ecb7e4",
      "executionGeneration": 63,
      "card": null,
      "evidence": {
        "runStatus": "unknown",
        "storeGeneration": 63,
        "answers": [],
        "namedBy": "store-request-id",
        "requestId": "run_bee7fd633e6a4821824ef01f7f650daa"
      },
      "action": "resolve-unknown"
    }
  ],
  "unnameable": [],
  "live": [],
  "queued": []
}
```

## 7. What was not done

`panel-assistant-3`'s fence was **not** cleared. No `resolve-unknown` was sent to the live gateway, no
`/stop`, no `hermes --resume`, no panel or gateway restart. The store still holds its 18 `unknown` rows.
The proof is the code, the tests, and the captured GET body above — the press that would clear it is the
reader's.

## 8. Landing

- change: `88f4d42` — the fallback, its tests, the verifier section, the UI line and the design/proof docs
- version: `4534179` — `1.12.8`, one patch above `origin/main`'s `1.12.7` at push time; tag `v1.12.8`
- merge: `f280133` (PR #407, rebase merge — the branch's own shas were rewritten, so these are the ones
  `origin/main` carries)
- the design doc's §3.3 step 6 and the live proof's §5 update note describe the same rule
