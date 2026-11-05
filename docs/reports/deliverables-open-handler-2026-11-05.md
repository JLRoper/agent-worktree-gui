# The DELIVERABLES row now answers a 200 handler

Measured 2026-11-05 against the live store served on `http://127.0.0.1:7331` and against a real page
served from this branch. The change is the PAGE's answer to one route answer; `server.js` is untouched,
so every refusal keeps the sentence it had.

## The defect

`POST /api/deliverables/open` answers a file or image it can reach with
`200 {ok:true, kind, target, open:"handler", opener:"explorer.exe", bytes}`. The page cleared the row's
refusal and said nothing else: the only evidence a reader got was a viewer window he might not have been
looking at. The audit of the same store (`docs/reports/deliverables-open-audit-2026-11-05.md`) measured
the silence on **29 of 111 files and 7 of 32 images** at 06:20:41Z, and named it the one place a click
looks like nothing: "that silence is the one place a click can look like nothing."

## The answer, on the row

A 200 `{open:"handler"}` now paints a `.dl-opened` line under the row's meta line:

```
opened 02-canvas.png with explorer.exe — the panel started the opener; it cannot see whether a window appeared
```

It names the file the route's answer named and the opener's basename it returned, and stops there. A
detached `explorer.exe` reports no exit code that means anything (the route answers from the spawn), so the
row does not claim a window; it claims the spawn. The line is `role="status"` — polite news, beside the
refusal's `role="alert"` — and a later refusal on the same row replaces it.

## The store, at three reads

The store is capped at 200 rows and pruned on write by `at`, so a number names the minute it was read:

| read | rows | link | file | image | file → handler | image → handler |
| --- | --- | --- | --- | --- | --- | --- |
| the audit, 06:20:41Z | 200 | 57 | 111 | 32 | 29 | 7 |
| this proof's live read, 06:40:05Z | 200 | 55 | 114 | 31 | 28 | 7 |
| this proof's snapshot, 06:50Z | 200 | 62 | 109 | 29 | 27 | 5 |

The turnover is the cap doing its job, not the change: the audit's file samples 88 and 90 were pruned
before this proof ran; 243 and 251 survived. At the snapshot's read the route's four classes were 32 rows
inside their tree and no href (`200 handler`), 55 outside the recorded tree (`403`), 51 missing (`404`),
and 62 links with an href (`200 tab`) — the same classifier the audit used, re-run against the store.

## How the row was proved

1. **The store is the live store.** `~/.wag/state/deliverables.json` was copied byte for byte while the
   panel on 7331 was live; the copy and the original hashed identically
   (`b2431220bed17861138f0c66ea0ce81d765eac77333b61a36b2cd1594d7a77c6`). The sandbox panel on 7476 read
   that copy: 200 rows, `nextSeq` 295, `seenSeq` 276.
2. **The page is this branch's.** `git archive` of the change commit `2431b27` into a scratch folder, the panel
   started from there; the served `/app.js` hash (`3d62a64e…`, the checkout's CRLF bytes) equalled the build's
   `public/app.js` and contained `dl-opened`. That commit's `public/app.js` blob is `48c4777…`, which is the blob
   this branch carries after its rebase onto 1.17.0 — the rebase moved the commits, not the page.
3. **Every handler row was clicked, on that page.** 32 rows (27 files, 5 images): each click's
   `POST /api/deliverables/open` was observed on the network as **200** with `open:"handler"` and
   `opener:"explorer.exe"`, and each row's own `.dl-opened` read back exactly
   `opened <basename> with explorer.exe — the panel started the opener; it cannot see whether a window appeared`.
   **32 / 32**, 0 failures, no page error, no console error.

The 32 seqs were `285 282 281 271 251 246 244 243 242 241 240 238 237 233 198 189 188 187 186 185 175
174 169 166 155 126 125 124 123 122 120 119`. A separate read of the live panel at the same time produced
the identical handler set. The only rows the two views did not share are the cap's edge: the copy holds seq 97, a
link the live panel pruned a moment later, and the live panel holds seq 295, a file that arrived after the copy.

**The opener was stubbed for the 32 clicks, and only the opener.** A three-line compiled stub named
`explorer.exe` sat first on the sandbox's search path and appended each argument it was given to a log;
32 of its 33 launches named the 32 targets, so no viewer windows were opened for the proof. The route, its
`spawn`, and its 200 are the real ones; the child's identity is the one thing no reader can see anyway.
The repo's own gate (`tools/verify-deliverables-ui.mjs`) clicks the same path with the REAL `explorer.exe`
and reads the line back, so the real-opener half is covered there.

## The refusals are unchanged

Six samples were asked through the same sandbox route and compared with the audit's own recorded bodies:

| seq | answer | compared with the audit |
| --- | --- | --- |
| 146 | 404 | exactly the same sentence, `gone` stamped by the route |
| 259 | 403 | exactly the same sentence |
| 262 | 403 | exactly the same sentence |
| 266 | 403 | exactly the same sentence |
| 270 | 403 | exactly the same sentence |
| 9999 | 404 | exactly the `no deliverable 9999 …` sentence |

None of the six carried an `opener`. `git diff 6a84dfd..HEAD -- server.js lib/deliverables.js` is empty, so
the route's classification and its three sentences are the bytes the audit measured. A test now pins those
sentences byte for byte (`test/deliverables.test.js`).

## What this does not prove

- **That a viewer window appeared.** No process on this side can see the desktop; with the stub it is
  deliberately not exercised. The real-`explorer.exe` row click is the browser gate's, not this run's.
- **A row the store no longer holds.** The cap forgot seq 88 and 90 while the proof ran; the set proved is
  the one the store held at 06:50Z, not every row the audit ever saw.
- **The blank project column in the screenshot.** The sandbox registers one project, so the store's
  `project` is resolved only for that project's trees; the target, tree, kind, age and the answer line are
  the live store's.

## Reproducing

```bash
# the store the page paints, and its kinds (newest first, one row per target)
curl -s http://127.0.0.1:7331/api/deliverables -o deliverables.json
node -e "const d=require('./deliverables.json');const c={};for(const e of d.entries)c[e.kind]=(c[e.kind]||0)+1;console.log(d.kept,JSON.stringify(c))"

# one row's answer, exactly as the page reads it (a refusal launches nothing)
curl -s -D - -X POST http://127.0.0.1:7331/api/deliverables/open \
  -H 'Content-Type: application/json' -d '{"seq":243}'
```

The handler count itself comes from the route's own order, run per file/image row: `stat`, then the served-root
`href`, then `deliverableRepoRoot`/`insideRepo` against the recorded `treePath` — the classifier the audit used.

The screenshot is `docs/assets/deliverables-open-audit/panel-handler-says-opened.png`. The second one, `docs/assets/deliverables-open-audit/panel-handler-says-opened-origin-main.png`, was taken from origin/main's own page — not from this branch — so the line it shows is the one main already ships.
