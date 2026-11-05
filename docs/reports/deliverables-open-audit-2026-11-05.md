# The DELIVERABLES popup: which kinds actually open

Measured 2026-11-05 against the live panel at `http://127.0.0.1:7331`, not a build.
Nothing in this report changed code, and nothing was repaired while measuring.

- Panel: pid 9880, `"C:\Program Files\nodejs\node.exe" server.js`, started 2026-11-04 22:33:35 EST,
  the only listener on 7331. `GET /api/config` answers `version: "1.12.1"`.
- Serving checkout: `C:/ProjectDevelopment/agent-worktree-gui` (primary). Its `server.js` hashes
  `6461a70b8d92e276b23ad5786341e46626f8facf69bc45d61ab606f8871aa575`, the same bytes this worktree
  carried before the rebase; `lib/deliverables.js`, `lib/open-url.js` and `public/app.js` hash-match too.
- The open path is UNCHANGED between the serving 1.12.1 and `origin/main` at `659d73e` (1.15.2):
  `git diff 79e735b 659d73e -- server.js` has zero hunks mentioning `deliverable`, and
  `deliverOpenTarget` in `public/app.js` is byte-identical. The line numbers below are the landing
  branch's; the serving checkout's are noted where they differ.
- Store: `GET /api/deliverables`, read at 06:10:26Z and again at 06:20:41Z (both whole bodies kept).
- Sixteen samples: 5 link, 6 file, 5 image. Each got a direct `POST /api/deliverables/open {"seq":N}`
  with the full status and body recorded, and a real click on its Open control in the popup on 7331
  with console and page errors recorded.

## The brief's premises, checked against the store

| The brief says | The store and the code say |
|---|---|
| seq 77 is "a link whose target is `worktree-gui/blob/main/docs/...`, not http(s)" | The stored target is `https://github.com/JLRoper/agent-worktree-gui/blob/main/docs/landing-pr-359-and-changelog-2026-11-04.md`. `deliverableHref` returns that URL, and the page opens it as a tab. The row's visible label strips the scheme (`deliverLinkLabel`, `public/app.js:15849`), so the popup shows `github.com/JLRoper/agent-worktree-gui/blob/main/docs/...` — a display, not the target. The file exists on `origin/main`. |
| file/image targets are "RELATIVE into trees that no longer exist" | No target in the 200 rows is relative. Every file/image target is an absolute `C:/...` path; relative targets are resolved at harvest and never stored (`lib/deliverables.js`, `resolveTarget`). The row shows `tailPath(target, 3)` — the last three segments with a leading `…` — which is a truncation of an absolute path, not a relative one. |
| the trees `82/…`, `next-directions-for-the-703e9e/…`, `pipeline-execut-10939c/…` no longer exist | `next-directions-for-the-703e9e` is gone: seq 73 answers 404. `next-directions-for-reve-92d082` (seq 82's recorded tree) is gone, but seq 82's target survives in the main checkout, so it answers 403. `land-the-pipeline-execut-10939c` was present at measurement time: seq 88 and 90 answer 200 in the handler branch, and `git worktree list` carries the tree. |
| the store held 200 entries: 112 file, 56 link, 32 image | True at the 06:10:26Z read. It moved during the audit: at 06:20:41Z it held 111 file, 57 link, 32 image, still 200 rows, `nextSeq` 276. |

The brief's two "suspicious" shapes are real defects of the popup's READING surface — a scheme-less
link label and a three-segment path tail — but neither is the stored target, and neither reaches
`Open`. What `Open` does is decided by `entry.href` and, when that is null, by the route's stat.

## The code that decides

Three decisions, one per layer.

1. **`GET /api/deliverables`** (`server.js:4311`) returns `deliverables.list()` with one field added per
   row: `href: deliverableHref(e)` (`server.js:4311-4320`). That `href` in the GET body IS
   `deliverableHref`'s answer, not a value stored in the file.
2. **`deliverableHref`** (`server.js:1639`; serving checkout `:1518`) returns the absolute http(s) URL
   for a link, and for a file/image only a URL under the SERVING panel's `PUBLIC_DIR`
   (`server.js:1650-1659`). Anything else is `null`. In this store it is `null` for all 143
   file/image rows, including `seq 246`'s `public/pipeline-map.html` in another tree: the test is
   against this panel's own `public/`, not the delivering tree's.
3. **The page's one Open control** (`deliverOpenTarget`, `public/app.js:15939`) opens `entry.href`
   synchronously with `window.open(..., "_blank")` when it is non-null, and otherwise POSTs
   `/api/deliverables/open`. On a non-2xx it writes the body's `error` into the row
   (`sayDeliverWhy`, `:15989`). On a 2xx it clears any sentence and says nothing else (`:15978-15981`).

The route (`server.js:5323`; serving checkout `:5091`) answers in this order:

| Branch | Line | Answer |
|---|---|---|
| unknown/pruned seq | `:5327-5333` | 404 `no deliverable … the list was pruned` |
| link, no href | `:5347-5351` | 400 `only http(s) links can be opened …` |
| link, default | `:5352` | 200 `{open:"tab", url}` |
| link, `mode:"launch"` (blocked tab) | `:5359-5366` | 200 `{open:"launch", opener}` |
| file/image, stat fails | `:5371-5380` | 404 `no such file: …`, and `markMissing(seq)` |
| file/image, not a file | `:5382-5388` | 400 `that is a directory, not a file …` |
| file/image with href | `:5390-5393` | 200 `{open:"tab", url, bytes}` |
| file/image outside its recorded tree | `:5396-5401` | 403 `outside the repo: …` |
| file/image inside its recorded tree | `:5406-5408` | 200 `{open:"handler", opener:"explorer.exe", bytes}` |

`deliverableRepoRoot` (`:1667`) returns `entry.treePath` when it is set, and `insideRepo`
(`:1681`) compares case-folded, forward-slashed paths. So a file that exists in a checkout the
recorded tree no longer names is refused even though it is a perfectly good file.

## The store at read time, and the cap

| Read | kept | nextSeq | seq range | file | link | image |
|---|---|---|---|---|---|---|
| 06:10:26Z | 200 | 271 | 42–270 | 112 | 56 | 32 |
| 06:20:41Z | 200 | 276 | 42–275 | 111 | 57 | 32 |

The list is capped at 200 (`DELIVER_KEEP`, `lib/deliverables.js:40`) and pruned ON WRITE by
`byNewest` (`:177`, `at` descending, then seq), not by seq. Between the two reads five rows arrived
(271–275) and five left — exactly the five oldest by `at`: 72, 73, 74, 76, 77. **seq 77, one of the
brief's named samples, was still on the page at 06:18:04Z and pruned by 06:20:41Z**, and seq 73 was
gone from the page before it could be clicked. A row named in a brief is not a stable fixture on a
board with live agents; the timing of each reading is part of its evidence.

At 06:20:41Z the 143 file/image rows fell into four classes, and the 57 links into one:

| kind | class | count |
|---|---|---|
| link | http(s), `href` non-null | 57 |
| file | inside its tree, no href → handler | 29 |
| file | exists, outside its recorded treePath → 403 | 36 |
| file | missing, recorded tree still on disk → 404 | 8 |
| file | missing, recorded tree retired → 404 | 38 |
| image | inside its tree, no href → handler | 7 |
| image | exists, outside its recorded treePath → 403 | 19 |
| image | missing, recorded tree still on disk → 404 | 1 |
| image | missing, recorded tree retired → 404 | 5 |

No row in the store is a directory, and no file/image row has a non-null `href`. The route's
directory branch and its "served file → tab" branch are therefore code-only truths here, unexercised.

## The sixteen samples

Summary. `href` is the GET's `deliverableHref` answer; POST is the status of
`POST /api/deliverables/open {"seq":N}`; "page" is what the popup did when Open was pressed.

| seq | kind | target (last segments) | stat | in recorded tree | href | POST | page |
|---|---|---|---|---|---|---|---|
| 77 | link | `…/blob/main/docs/landing-pr-359-and-changelog-2026-11-04.md` | — | — | URL | 200 tab | new tab |
| 268 | link | `…/commit/3295fcea374bbe0147d05cb6460f866d86cee1d2` | — | — | URL | 200 tab | new tab |
| 236 | link | `127.0.0.1:8090/api/pipelines` | — | — | URL | 200 tab | new tab |
| 256 | link | `…/blob/main/docs/reports/retired-worktrees-2026-11-05.md` | — | — | URL | 200 tab | new tab |
| 42 | link | `…/blob/main/CHANGELOG.md` | — | — | URL | 200 tab | new tab |
| 73 | file | `…/next-directions-for-the-703e9e/docs/reports/next-directions/index.html` | absent | yes (tree gone) | null | 404 | row already pruned |
| 82 | file | `…/ai-development-factory/docs/reports/next-directions/index.html` | 40,279 B | no | null | 403 | sentence |
| 88 | file | `…/land-the-pipeline-execut-10939c/docs/evidence/landing-execution-page.txt` | 3,988 B | yes | null | 200 handler | silence |
| 251 | file | `…/retire-the-landed-clean-d34518/docs/reports/retired-worktrees-2026-11-05.md` | 25,527 B | yes | null | 200 handler | silence |
| 266 | file | `…/ai-development-factory/docs/reports/README.md` | 12,444 B | no | null | 403 | sentence |
| 270 | file | `…/Temp/wag/7d902204/verify-import-live.log` | 2,257 B | no | null | 403 | sentence |
| 90 | image | `…/land-the-pipeline-execut-10939c/docs/evidence/landing-execution-page-top.png` | 64,003 B | yes | null | 200 handler | silence |
| 146 | image | `…/the-deliverables-button-763f28/.shots/deliverables-badge.png` | absent | yes (tree gone) | null | 404 | sentence |
| 243 | image | `…/capture-stage-documents-5bd532/docs/reviews/stage-chromium-capshots/order-to-cash/02-canvas.png` | 51,101 B | yes | null | 200 handler | silence |
| 259 | image | `…/Temp/wag/dba5b786/shots/pipeline-import-error.png` | 120,992 B | no | null | 403 | sentence |
| 262 | image | `…/Temp/wag/3b5397a1/origin-main-reminders.png` | 15,368 B | no | null | 403 | sentence |

Every body, whole, in the order the route returned it. `stat` and the tree checks were taken at
06:22Z; the POSTs at the timestamps shown (from the response `Date` header).

### seq 77 — link, POST 200 at 06:14:20Z

- Agent: "Land PR #359 and render 1.4.2 changelog #2". Tree: `…/.worktrees/land-pr-359-and-render-t-d126f8` (gone).
- `href`: `https://github.com/JLRoper/agent-worktree-gui/blob/main/docs/landing-pr-359-and-changelog-2026-11-04.md`
- Body:

```json
{"ok":true,"kind":"link","target":"https://github.com/JLRoper/agent-worktree-gui/blob/main/docs/landing-pr-359-and-changelog-2026-11-04.md","open":"tab","url":"https://github.com/JLRoper/agent-worktree-gui/blob/main/docs/landing-pr-359-and-changelog-2026-11-04.md"}
```

Page: a new tab at that URL, no sentence on the row, no console or page error. The tab is a
GitHub blob URL; the file is present on `origin/main`, so the destination is not a 404.

### seq 268 — link, POST 200 at 06:14:23Z

- Tree: `…/.worktrees/let-the-panel-import-an-925c4b` (present).
- `href`: `https://github.com/JLRoper/agent-worktree-gui/commit/3295fcea374bbe0147d05cb6460f866d86cee1d2`

```json
{"ok":true,"kind":"link","target":"https://github.com/JLRoper/agent-worktree-gui/commit/3295fcea374bbe0147d05cb6460f866d86cee1d2","open":"tab","url":"https://github.com/JLRoper/agent-worktree-gui/commit/3295fcea374bbe0147d05cb6460f866d86cee1d2"}
```

Page: new tab, no sentence, no error. This is the newest link in the store at the first read.

### seq 236 — link, POST 200 at 06:14:21Z

- `href`: `http://127.0.0.1:8090/api/pipelines`

```json
{"ok":true,"kind":"link","target":"http://127.0.0.1:8090/api/pipelines","open":"tab","url":"http://127.0.0.1:8090/api/pipelines"}
```

Page: new tab. The panel does not fetch the URL and does not know whether anything is listening on
8090; the tab's destination is the browser's fact, not the panel's.

### seq 256 — link, POST 200 at 06:14:22Z

- `href`: `https://github.com/JLRoper/agent-worktree-gui/blob/main/docs/reports/retired-worktrees-2026-11-05.md`

```json
{"ok":true,"kind":"link","target":"https://github.com/JLRoper/agent-worktree-gui/blob/main/docs/reports/retired-worktrees-2026-11-05.md","open":"tab","url":"https://github.com/JLRoper/agent-worktree-gui/blob/main/docs/reports/retired-worktrees-2026-11-05.md"}
```

Page: new tab, no sentence, no error. The target exists on `origin/main`.

### seq 42 — link, POST 200 at 06:14:19Z

- `href`: `https://github.com/JLRoper/agent-worktree-gui/blob/main/CHANGELOG.md`

```json
{"ok":true,"kind":"link","target":"https://github.com/JLRoper/agent-worktree-gui/blob/main/CHANGELOG.md","open":"tab","url":"https://github.com/JLRoper/agent-worktree-gui/blob/main/CHANGELOG.md"}
```

Page: new tab, no sentence, no error. Oldest seq in the store, but one of the newest by `at`
(2026-11-05T03:53:58Z), which is why the cap kept it and dropped 77.

### seq 73 — file, POST 404 at 06:14:24Z

- Target: `C:/ProjectDevelopment/ai-development-factory/.worktrees/next-directions-for-the-703e9e/docs/reports/next-directions/index.html`
- Tree: `C:/ProjectDevelopment/ai-development-factory/.worktrees/next-directions-for-the-703e9e` — **absent**
- stat: none. The path is inside the recorded tree's spelling, but the tree is gone.
- `href`: `null`

```json
{"error":"no such file: C:/ProjectDevelopment/ai-development-factory/.worktrees/next-directions-for-the-703e9e/docs/reports/next-directions/index.html — it was there when Close three pipeline language gaps delivered it (2026-11-04T08:22:29.328Z); it has since been moved or deleted"}
```

Page: the row was already pruned from the 200-row list by the time the popup opened at 06:17:55Z,
so there was nothing to click. The 404 also stamped `missingAt` on the row, which is why a reader
who saw it earlier would see the `gone` chip.

### seq 82 — file, POST 403 at 06:14:25Z

- Target: `C:/ProjectDevelopment/ai-development-factory/docs/reports/next-directions/index.html`
- Tree: `C:/ProjectDevelopment/ai-development-factory/.worktrees/next-directions-for-reve-92d082` — **absent**
- stat: 40,279 B, regular file, mtime 2026-11-04T08:27:29.093Z. **Not inside the recorded treePath.**
- `href`: `null`

```json
{"error":"outside the repo: C:/ProjectDevelopment/ai-development-factory/docs/reports/next-directions/index.html — it is not inside C:/ProjectDevelopment/ai-development-factory/.worktrees/next-directions-for-reve-92d082; a deliverable is the file an agent put in its own tree"}
```

Page: the sentence above appears in the row, no tab, and the row is not marked `gone`. The file is
there and readable; the refusal is about where it is, not whether it exists. This is the clearest
case of the panel calling a live file unopenable because its delivery tree was retired.

### seq 88 — file, POST 200 at 06:14:26Z

- Target: `C:/ProjectDevelopment/ai-pipeline-factory/.worktrees/land-the-pipeline-execut-10939c/docs/evidence/landing-execution-page.txt`
- Tree: same path — present. **Inside** it.
- stat: 3,988 B, regular file, mtime 2026-11-04T08:41:12.283Z.
- `href`: `null`

```json
{"ok":true,"kind":"file","target":"C:/ProjectDevelopment/ai-pipeline-factory/.worktrees/land-the-pipeline-execut-10939c/docs/evidence/landing-execution-page.txt","open":"handler","opener":"explorer.exe","bytes":3988}
```

Page: no tab, no sentence, no error — silence. On the host, an `explorer.exe` process started at
01:18:08 local, within a second of the click; the same happened for each 200 handler click (see
"The popup, clicked"). Note the disagreement in readings: an `os.path.exists` pass earlier in this
audit (06:12Z) reported this tree and its files absent, and the route's own `stat` at 06:14:26Z found them. The
tree is registered in `git worktree list` with a 2026-11-04 03:35 EST directory mtime. The route's
answer is a stat at the second it is asked; the cause of the earlier disagreement was not
established.

### seq 251 — file, POST 200 at 06:14:27Z

- Target: `C:/ProjectDevelopment/agent-worktree-gui/.worktrees/retire-the-landed-clean-d34518/docs/reports/retired-worktrees-2026-11-05.md`
- Tree: same — present. **Inside** it.
- stat: 25,527 B, regular file, mtime 2026-11-05T05:18:54.201Z.
- `href`: `null`

```json
{"ok":true,"kind":"file","target":"C:/ProjectDevelopment/agent-worktree-gui/.worktrees/retire-the-landed-clean-d34518/docs/reports/retired-worktrees-2026-11-05.md","open":"handler","opener":"explorer.exe","bytes":25527}
```

Page: silence; one `explorer.exe` at 01:18:09 local.

### seq 266 — file, POST 403 at 06:14:28Z

- Target: `C:/ProjectDevelopment/ai-development-factory/docs/reports/README.md`
- Tree: `C:/ProjectDevelopment/ai-development-factory/.worktrees/roll-the-finished-branch-edd193` — **absent**
- stat: 12,444 B, regular file, mtime 2026-11-05T05:47:59.910Z. **Not inside the recorded treePath.**
- `href`: `null`

```json
{"error":"outside the repo: C:/ProjectDevelopment/ai-development-factory/docs/reports/README.md — it is not inside C:/ProjectDevelopment/ai-development-factory/.worktrees/roll-the-finished-branch-edd193; a deliverable is the file an agent put in its own tree"}
```

Page: sentence in the row, no tab. This is the landing-on-main pattern: the agent delivered the
same file again from the main checkout, which has a different path from the recorded worktree, and
the route treats that as outside the repo.

### seq 270 — file, POST 403 at 06:14:29Z

- Target: `C:/Users/roper/AppData/Local/Temp/wag/7d902204/verify-import-live.log`
- Tree: `…/.worktrees/let-the-panel-import-an-925c4b` — present, but the target is in the scratch dir.
- stat: 2,257 B, regular file, mtime 2026-11-05T05:48:31.383Z. **Not inside the recorded treePath.**
- `href`: `null`

```json
{"error":"outside the repo: C:/Users/roper/AppData/Local/Temp/wag/7d902204/verify-import-live.log — it is not inside C:/ProjectDevelopment/agent-worktree-gui/.worktrees/let-the-panel-import-an-925c4b; a deliverable is the file an agent put in its own tree"}
```

Page: sentence, no tab. This is the newest file at the first read and the most common file class in
the store: 40 of 143 file/image rows live under `%LOCALAPPDATA%/Temp/wag`, outside every tree — part
of the 56 outside-tree rows; the rest are files re-delivered from a main checkout.

### seq 90 — image, POST 200 at 06:14:32Z

- Target: `C:/ProjectDevelopment/ai-pipeline-factory/.worktrees/land-the-pipeline-execut-10939c/docs/evidence/landing-execution-page-top.png`
- Tree: present. **Inside** it.
- stat: 64,003 B, regular file, mtime 2026-11-04T08:39:15.960Z.
- `href`: `null`

```json
{"ok":true,"kind":"image","target":"C:/ProjectDevelopment/ai-pipeline-factory/.worktrees/land-the-pipeline-execut-10939c/docs/evidence/landing-execution-page-top.png","open":"handler","opener":"explorer.exe","bytes":64003}
```

Page: silence; one `explorer.exe` at 01:18:14 local.

### seq 146 — image, POST 404 at 06:14:33Z

- Target: `C:/ProjectDevelopment/agent-worktree-gui/.worktrees/the-deliverables-button-763f28/.shots/deliverables-badge.png`
- Tree: `…/.worktrees/the-deliverables-button-763f28` — **absent**
- stat: none. `href`: `null`

```json
{"error":"no such file: C:/ProjectDevelopment/agent-worktree-gui/.worktrees/the-deliverables-button-763f28/.shots/deliverables-badge.png — it was there when Add seen counter to deliverables button delivered it (2026-11-04T18:30:18.366Z); it has since been moved or deleted"}
```

Page: the sentence above in the row, `gone` chip, no tab. This row also proves the 404 does not
clear `missingAt`.

### seq 243 — image, POST 200 at 06:14:35Z

- Target: `C:/ProjectDevelopment/ai-development-factory/.worktrees/capture-stage-documents-5bd532/docs/reviews/stage-chromium-capshots/order-to-cash/02-canvas.png`
- Tree: present. **Inside** it.
- stat: 51,101 B, regular file, mtime 2026-11-05T05:04:16.023Z.
- `href`: `null`

```json
{"ok":true,"kind":"image","target":"C:/ProjectDevelopment/ai-development-factory/.worktrees/capture-stage-documents-5bd532/docs/reviews/stage-chromium-capshots/order-to-cash/02-canvas.png","open":"handler","opener":"explorer.exe","bytes":51101}
```

Page: silence; one `explorer.exe` at 01:18:16 local.

### seq 259 — image, POST 403 at 06:14:37Z

- Target: `C:/Users/roper/AppData/Local/Temp/wag/dba5b786/shots/pipeline-import-error.png`
- Tree: `…/.worktrees/let-the-panel-import-an-925c4b` — present; target outside it.
- stat: 120,992 B, regular file, mtime 2026-11-05T05:43:31.326Z.
- `href`: `null`

```json
{"error":"outside the repo: C:/Users/roper/AppData/Local/Temp/wag/dba5b786/shots/pipeline-import-error.png — it is not inside C:/ProjectDevelopment/agent-worktree-gui/.worktrees/let-the-panel-import-an-925c4b; a deliverable is the file an agent put in its own tree"}
```

Page: sentence, no tab.

### seq 262 — image, POST 403 at 06:14:38Z

- Target: `C:/Users/roper/AppData/Local/Temp/wag/3b5397a1/origin-main-reminders.png`
- Tree: `…/.worktrees/make-the-bridge-obey-the-b8ec43` — present; target outside it.
- stat: 15,368 B, regular file, mtime 2026-11-05T05:45:56.844Z.
- `href`: `null`

```json
{"error":"outside the repo: C:/Users/roper/AppData/Local/Temp/wag/3b5397a1/origin-main-reminders.png — it is not inside C:/ProjectDevelopment/agent-worktree-gui/.worktrees/make-the-bridge-obey-the-b8ec43; a deliverable is the file an agent put in its own tree"}
```

Page: sentence, no tab.

## The text files, first 200 bytes

Read from disk at 06:22Z; `repr` of the first 200 bytes, so line endings are visible.

| seq | first 200 bytes |
|---|---|
| 82 | `b'<!DOCTYPE html>\r\n<html lang="en">\r\n<head>\r\n<meta charset="utf-8">\r\n<meta name="viewport" content="width=device-width, initial-scale=1">\r\n<title>Next directions for the stage language \xe2\x80\x94 three finding'` |
| 88 | `b'LANDING RECORD \xe2\x80\x94 the pipeline execution design page on main\n===========================================================\nDate: 2026-11-04 (local, EST)\nLanded by: landing branch wtgui/land-the-pipelin'` |
| 251 | `b'# Retired worktrees \xe2\x80\x94 2026-11-05\n\nBase: `origin/main` at `ea7dc4d` (1.12.9). Measured and retired 2026-11-04 23:42 \xe2\x80\x93 2026-11-05 00:15 EST\nfrom the primary checkout of this repo.\n\n**Result: 108 reg'` |
| 266 | `b'# Reports index\r\n\r\nEvery report in `docs/reports/`, one row each: the date, what kind of page it is, and one sentence on what it says. Newest first.\r\n\r\nThe **Date** is the date in the filename where t'` |
| 270 | `b"PASS  ?doc= finished drawing and the page says it is a document\nPASS  the factory's answer is read as an index (index)\nPASS  one card, poc-breaking-suite (poc-breaking-suite)\nPASS  nine stage nodes ar"` |
| 73 | absent — nothing to read |

## Images: the file decodes

Each image sample was navigated to in its own Playwright tab as `file:///<absolute path>` — no panel
URL is involved in this measurement. `naturalWidth × naturalHeight` is the file's own decode by
Chromium; it is a fact about the PNG, not a claim that the panel served it. The panel serves none of
these: every image row's `href` is `null`.

| seq | file bytes | content-type | naturalWidth × naturalHeight | complete | result |
|---|---|---|---|---|---|
| 90 | 64,003 | `image/png` | 1258 × 566 | true | decodes |
| 146 | — | — | — | — | `net::ERR_FILE_NOT_FOUND` |
| 243 | 51,101 | `image/png` | 1128 × 359 | true | decodes |
| 259 | 120,992 | `image/png` | 1280 × 900 | true | decodes |
| 262 | 15,368 | `image/png` | 463 × 202 | true | decodes |

So the four images that exist are valid PNGs a reader could see, and three of them (90, 259, 262)
are refused by the popup all the same — 90 because the panel has no URL for a file in a worktree,
and 259/262 because they sit outside their recorded tree.

## The popup, clicked

The live page (1.12.1) opened with `200 deliverables — newest first`, 200 rows, one `gone` chip
(146), and no kind chips — the live build predates the chips in `public/app.js` on main. The footer
reads `200 kept — older rows are forgotten; the files stay on disk.`

| kind | clicks | new tab | sentence on the row | silence | row gone before the click |
|---|---|---|---|---|---|
| link | 5 | 5 | 0 | 0 | 0 |
| file | 6 | 0 | 3 (82, 266, 270) | 2 (88, 251) | 1 (73, pruned) |
| image | 5 | 0 | 3 (146, 259, 262) | 2 (90, 243) | 0 |

- **Links.** Each of the five clicks produced exactly one new page at the stored URL, with the row
  left unmarked and no sentence. The tab is `window.open(entry.href, "_blank")` inside the click;
  the panel's route is never called for a link (`public/app.js:15942-15956`).
- **Files and images, 200 handler.** The click POSTed, the route spawned `explorer.exe`, the row
  stayed clean and the card said nothing (`public/app.js:15978-15981`). `Get-Process` shows exactly
  four `explorer.exe` starts in the second round — 01:18:08 for 88 (clicked .549), 01:18:09 for 251
  (.497), 01:18:14 for 90 (13.771), 01:18:16 for 243 (15.855) — and four in the first round
  (01:16:18, :20, :25, :29) for the same four rows. The six 403/404 clicks in that window produced
  no start. That is the panel's act — the viewer window itself is not visible to a headless probe.
- **Files and images, 403/404.** The body's `error` is written into the row by `sayDeliverWhy`
  (`:15989`), the row is not marked `gone` for a 403, and `gone` for a 404. The only console ERRORS
  are the browser's own `Failed to load resource: the server responded with a status of 403/404
  (Forbidden/Not Found)` for that POST; the two warnings sample 77 carried are the panel's
  duplicate-card note, unrelated to Open. `pageerror` was empty for all sixteen.
- **Screenshots.** One per kind:
  `docs/assets/deliverables-open-audit/panel-link.png` (seq 77: tab, no sentence),
  `panel-file-refused.png` (seq 82: the 403 sentence),
  `panel-image-refused.png` (seq 259: the 403 sentence).

## Per-kind verdict

| kind | verdict | rows at 06:20:41Z | the code path that explains it |
|---|---|---|---|
| link | **opens as a tab** | 57/57 | `deliverableHref` returns the http(s) URL for every stored link; the page `window.open`s it in the click. The route's link branch is unreachable from the page unless a popup blocker returns null, in which case `mode:"launch"` hands the URL to Chrome/`explorer.exe`. |
| file | **launches a viewer (29/111) or is refused with a sentence (82/111)** | 29 handler, 36 403, 46 404 | `href` is null for every file; the route stats the absolute target. Inside `treePath` → `openerFor` → `explorer.exe`, 200 `{open:"handler"}` and the page says nothing. Missing → 404 + `markMissing`; existing but outside `treePath` → 403. Both sentences are written on the row. |
| image | **launches a viewer (7/32) or is refused with a sentence (25/32)** | 7 handler, 19 403, 6 404 | Identical path: an image is a file with an image suffix; nothing in the open route branches on the suffix. The 19 outside-tree refusals are the scratch-dir shots agents deliver. |

No sample was "swallowed with no feedback" in the strong sense: every click either opened a tab,
spawned the OS handler, or wrote a sentence. The 200-handler branch is silent BY DESIGN on the
page — the only evidence a reader gets that anything happened is the viewer window — and that
silence is the one place a click can look like nothing.

Two code paths are not exercised by any row in this store:

- the **directory refusal** (`server.js:5382`), because no target is a directory;
- the **served-file tab** (`server.js:5390`), because no delivered file lives under the serving
  panel's `public/`, not even the one delivered from a worktree's own `public/` (seq 246).

## What this audit does not prove

- **Where a link lands.** The panel never fetches a URL, and no HTTP client is in this path; the tab
  is opened and the destination's status is the browser's. seq 236 (`127.0.0.1:8090`) may be dead.
- **That a viewer window appeared.** The observable on this host is the `explorer.exe` spawn and the
  route's 200 `{open:"handler"}`; a headless Playwright run cannot see the desktop.
- **The `mode:"launch"` link branch.** No page in this run had its tab blocked, so `chromeFor` was
  never reached.
- **The 400-directory and served-file branches.** Code-only, as above.
- **A row that is not in the 200.** The route answers 404 `no deliverable … the list was pruned` for
  a seq the store no longer has; the sample that would have shown it, 73, was pruned before the page
  was opened rather than clicked.

## Reproducing

```bash
# the store and its movement
curl -s http://127.0.0.1:7331/api/deliverables -o deliverables.json
python -c "import json;d=json.load(open('deliverables.json'));print(d['kept'],d['nextSeq'],[ (e['seq'],e['kind']) for e in d['entries'][:3]])"

# one sample's full answer
curl -s -D - -X POST http://127.0.0.1:7331/api/deliverables/open \
  -H 'Content-Type: application/json' -d '{"seq":82}'

# the file's own decode, no panel in the path
node -e "const {chromium}=require('playwright');(async()=>{const b=await chromium.launch();const p=await b.newPage();await p.goto('file:///C:/ProjectDevelopment/ai-pipeline-factory/.worktrees/land-the-pipeline-execut-10939c/docs/evidence/landing-execution-page-top.png');console.log(await p.evaluate(()=>{const i=document.querySelector('img');return [i.naturalWidth,i.naturalHeight]}));await b.close()})()"
```

The bodies above are `curl -o file -D headers -w '%{http_code}'` output, one file per seq; the page
half is a Playwright script that clicked `[data-dl-open="<seq>"]` and read back `.dl-why`,
`context.pages()` and the `POST /api/deliverables/open` response.
