# Deliverables handback — the plan

**Measured at `4f660d2` (`package.json` 0.87.0), the branch `wtgui/phase-1-of-a-build-resea-5db421` cut from `main`.**
Line numbers drift with every landing; every anchor below is given with the text to search for, so a later reader
re-locates a seam instead of trusting a number.

This is a plan. This commit touches one file — this document. None of `public/app.js`, `public/index.html`,
`public/style.css` or `server.js` is edited here: a live worker holds all four, and the sections below say exactly
where each edit lands when that worker's tree is free.

**The ask.** A research agent hands its report back as a loose `.html` file in a worktree, and the reader finds it by
remembering it. He wants a header button beside NOT-RUNNING (`#btn-hot`) and HUMAN (`#btn-human`) that opens a
scrollable, newest-first list of every deliverable produced on this panel: a link opens in Chrome, a file opens in
whatever this machine uses for that suffix, and clicking the row opens the agent that produced it.

**The answer.** A worker says one line in its final message — `DELIVER <link|file|image> <target> | <title>` — and the
panel reads it at settle, on the same seam that already reads `TODO` and `RELEASE` (`Jobs.measureTree`). The worker
never learns a path, an id or an API: validation, dedupe, ordering, storage and the click behaviours are the panel's.
The store is `deliverables.json` beside `jobs.json`, capped at 200 entries and pruned on write.

---

## 1. What exists today, and why it does not answer the ask

Three facts, read from this tree.

**1.1 There is already a per-card deliverable list, and it is per card.** `Jobs.addArtifact` (`lib/jobs.js:1311`) keeps
`{kind:"file"|"url", path|url, at}` on one job; the card draws two buttons (`public/app.js:4778-4779`) and a popover
that says *"newest last"* (`artifactsPopHtml`, `public/app.js:3624`). It answers "what did THIS agent produce", and the
reader's complaint is the other question: he does not know which agent produced the file he is looking for. The list
also dies with the job (the store keeps 80 conversations, `KEEP_JOBS` at `lib/jobs.js:76`), cannot be searched, and
records a URL the agent *printed* as readily as one it *meant* (`scanUrls`, `lib/jobs.js:1361`).

**1.2 The harvest seam already exists and already reads two grammars out of a run's last words.** `measureTree`
(`lib/jobs.js:1774`) is called when a run settles (and again after a restart for a turn a restart cut off,
`lib/jobs.js:678`). At `lib/jobs.js:1887` it hands `j.finalMessage` to `this.todos.harvest(...)`; at `lib/jobs.js:1917`
it calls `this.harvestRelease(j)`, whose whole body is at `lib/jobs.js:1930-1937`: mark the job, hand the same text to a
store's `record()`, push the sentences the store returns onto the card. The DELIVER line is parsed on exactly this
path; §3 names the line.

**1.3 The grammar precedent is `RELEASE`, and the shape is three parts.** `parseReleaseLines` (`lib/worktrees.js:107`)
splits a trimmed line on the **first pipe** — "a Windows path carries colons and spaces, so neither can also be the
field break" — and returns `{target, why, raw, error}` per line, with `error` set rather than the line dropped. A
malformed line becomes a `⚠ … was NOT recorded — <reason>` console line (`lib/worktrees.js:327-337`). DELIVER copies
that shape exactly, with one more field (the kind) and one more validation step (the target must be openable *now*).

**1.4 The clarify tool is the precedent for the channel, not for the transport.** `clarify` is a capability the panel
observes and, when the gateway build cannot deliver it, tells each run about *in the prompt* (`lib/clarify.js:26-33`).
The lesson taken here is the one the reader named: the panel states the protocol in the text the run definitely reads,
and the run never needs to know what the panel does with it. DELIVER is a line in that same text — not a tool call, not
an HTTP route a worker could reach, and not a file it must write somewhere in particular.

---

## 2. The marker: grammar, and every way it can fail

### 2.1 The grammar

```
DELIVER <kind> <target> | <title>
```

- The line starts with `DELIVER` at the beginning of a **trimmed** line, case-insensitive, and the word must end there
  (`/^DELIVER\b/i`, exactly `parseReleaseLines`' rule — `DELIVERED` is not a marker).
- `<kind>` is the first word after it: `link`, `file` or `image`, case-insensitive. It is the only word that is not
  free text, which is what lets a target contain spaces with no quoting.
- `<target>` is everything after that word up to the **first** `|`, trimmed; one pair of surrounding quotes or
  backticks is stripped, so a quoted path also works.
- `<title>` is everything after that first `|`: whitespace collapsed to single spaces, non-empty, at most 160
  characters. A title may itself contain a `|` — only the first one is the separator.
- A line that is not a marker is ignored, and a line that starts with `DELIVER` but cannot be read is **refused out
  loud** (§2.3), never dropped.

Examples, all valid:

```
DELIVER link https://localhost:7473/report.html | The 200-row probe report
DELIVER file C:/ProjectDevelopment/agent-worktree-gui/.worktrees/x/docs/plan/report.html | Where the panel loses a card
DELIVER file "C:/My Projects/x/out/notes.md" | Notes on the cut
DELIVER image C:/Users/roper/AppData/Local/Temp/wag/shot.png | The dock overlapping the console
DELIVER link https://example.test/a?b=1&c=2 | Landed | merged by the reader
```

### 2.2 The three kinds

| kind | target | validated at harvest | opened how |
| --- | --- | --- | --- |
| `link` | an `http:` or `https:` URL | `new URL(target)`; protocol is one of the two | Chrome (§6.1), falling back to the OS default browser |
| `file` | an absolute path, or one relative to the run's tree | resolved, then `stat` must say **file** | the OS handler for that suffix — ShellExecute, i.e. the associated program |
| `image` | a file whose suffix is one of `.png .jpg .jpeg .gif .webp .bmp .svg` | the same `stat`, plus the suffix test | the OS handler, i.e. the image viewer |

`image` is a *file* with two differences: the suffix is checked, and the row gets its own glyph (🖼) and, in a later
phase, a thumbnail (a non-goal here, §10 — the panel has no route that serves an arbitrary local file, and adding one
is its own security decision).

### 2.3 Every failure, and the sentence it produces

Each of these is **not stored** and produces one console line on the card the run just finished:
`⚠ DELIVER was NOT recorded — <reason>` (kind `raw`, so it is not mistaken for the panel's own prose; the same shape as
`lib/worktrees.js:329`). The line lives in `j.lines`, which is persisted (last 120 lines, `lib/jobs.js:735`), so a
reload still shows it.

| line written | reason, said verbatim on the card |
| --- | --- |
| `DELIVER` | a DELIVER line needs `<link\|file\|image> <target> \| <title>` |
| `DELIVER file C:/x.md` | DELIVER needs `\| <title>` after the target |
| `DELIVER doc C:/x.md \| t` | “doc” is not one of link / file / image |
| `DELIVER file \| t` | DELIVER names no target |
| `DELIVER file C:/x.md \|` | DELIVER names no title — say what the reader should do with it, in a few words |
| `DELIVER link ftp://host/x \| t` | only http(s) links can be delivered (got “ftp:”) |
| `DELIVER link not-a-url \| t` | “not-a-url” is not a URL — a link needs http:// or https:// |
| `DELIVER file C:/nope.md \| t` | no such file: C:/nope.md — resolved from “C:/nope.md” against C:/…/tree |
| `DELIVER file C:/some/dir \| t` | that is a directory, not a file: C:/some/dir |
| `DELIVER image C:/x/report.html \| t` | an image must end in .png / .jpg / .jpeg / .gif / .webp / .bmp / .svg — deliver it as a “file” if it is not one |
| a target over 1024 characters | the target is N characters; the panel keeps at most 1024 |

Two rules worth stating because they are choices, not accidents:

- **A relative target resolves against the run's tree root** (`job.worktreePath || job.ownerPath || job.cwd`, the same
  resolution `TodoLists.harvest` uses at `lib/todos.js:588`), never against the panel's own cwd. A worker that wrote a
  path relative to a subdirectory it happened to be in gets a refusal that names the resolved path, so the mistake is
  visible instead of mysterious.
- **Nothing is stripped from a target.** The pipe delimits it, so no punctuation heuristic is needed, and a URL's own
  trailing `/`, `?a=1` or `#frag` survives byte for byte. A stray trailing `.` stays in the URL and is the writer's
  mistake, visible in the row.

### 2.4 What is *not* validated, deliberately

- **A link is never fetched.** A dev server may not be up at settle, and a network call in the settle path would turn
  "the panel could not reach your page" into "your deliverable was refused". A dead link opens Chrome's own error page;
  the panel says nothing it did not measure.
- **A file's contents are never read.** Only `stat` (kind, size, mtime). A 2 GB video is a legal deliverable.
- **No `.git/` or `node_modules/` ban.** `isArtifactPath` (`lib/jobs.js:245`) uses an extension allowlist because it
  harvests every `write_file` a run makes; DELIVER is an explicit sentence by the agent, so the panel trusts the
  sentence and refuses only what it can prove is not openable.

---

## 3. The harvest seam, exactly

### 3.1 Where the line is parsed

`lib/deliverables.js` is new and holds the pure half first, mirroring the two grammars already in the tree:

```
export function parseDeliverLines(text) -> [{kind, target, title, raw, error}]
```

It is called from `Deliverables.record({ job, finalText, agent, now })`, which is the impure half: it resolves and
stats each target, upserts into the store, and returns `{added, updated, refused, lines}` where `lines` are
`{kind, text}` console lines in the panel's voice. This is the same split as `parseReleaseLines` (`pure`) versus
`ReleaseRequests.record` (`store + lines`), and the same return shape.

### 3.2 Where it is called

In `lib/jobs.js`, in `measureTree`, **on the line after `this.harvestRelease(j)`** (`lib/jobs.js:1917`), before
`this.finalise(j)`:

```js
this.harvestRelease(j);
this.harvestDeliverables(j);   // ← new
this.finalise(j);
```

and a new method beside `harvestRelease` (`lib/jobs.js:1930`):

```js
harvestDeliverables(j) {
  if (!this.deliverables || !j || j.deliverHarvested) return null;
  j.deliverHarvested = true;
  const agent = this.labelFor(j.thread) || this.sessionInfoFor(j.thread)?.title || j.thread || null;
  const out = this.deliverables.record({ job: j, finalText: String(j.finalMessage || ""), agent });
  for (const line of out.lines) this.push(j, line);
  j.delivered = { added: out.added, updated: out.updated, refused: out.refused };
  return out;
}
```

Four things about that placement are load-bearing:

1. **It runs once per run.** `j.deliverHarvested` is the guard, exactly like `releaseHarvested`
   (`lib/jobs.js:1931`). Unlike `todoHarvested`/`releaseHarvested`, the mark is **persisted** — one line in the
   `schedulePersist` map beside `finalMessage` (`lib/jobs.js:727`): `deliverHarvested: Boolean(j.deliverHarvested)`.
   The restore loop keeps every saved field on the job object (`lib/jobs.js:672`), so nothing else is needed. Without
   it, a restart re-reads an old run's final message, re-stats its files, and — if the reader has since moved one —
   prints a false `⚠ no such file` on a card that settled days ago.
2. **A second settle of the same run is a no-op.** `measureTree` is called again on a rename (the re-read at
   `lib/jobs.js:1871`), on a lost run (`lib/jobs.js:3269`) and at boot (`lib/jobs.js:678`); the mark makes all three
   silent.
3. **A refusal is said, not swallowed.** One `⚠` line per refused marker, in the same console the TODO refusals use
   (`lib/jobs.js:1895-1898`). The store keeps nothing for a refused line, so the console is the only place it can live —
   and it is persisted with the rest of the card's tail.
4. **Nothing is acted on.** Like `RELEASE`, this only records. There is no route, no delete, no side effect beyond the
   one JSON file; `record()` never throws into `measureTree` (every branch returns an error object, and the whole call
   is inside the existing `measureTree` try/catch).

### 3.3 The paragraph the worker is told

`lib/jobs.js` exports a `DELIVER_BRIEF` constant beside `RELEASE_BRIEF` (`lib/jobs.js:97`), and `create()` appends it
to `anchored` after `releaseText` (`lib/jobs.js:2177-2178`):

```js
${releaseText ? `\n\n${releaseText}` : ""}${deliverText ? `\n\n${deliverText}` : ""}
```

The text (six lines, one of which is the marker):

```
DELIVER — when this turn produced something the reader will open (a report, a page, a screenshot, a link), end your
FINAL message with one line per deliverable:
  DELIVER <link|file|image> <target> | <title>
The target is a URL for `link`, and a path for `file`/`image` — absolute, or relative to this worktree. The title is
one short sentence: what it is, not what you did. The panel checks the target exists, keeps the list and opens it; you
never need to know where the panel keeps anything. A line that cannot be read is said on this card, not dropped.
```

- It is **unconditional** for a tree run (`where && opts.anchorCwd !== false`), unlike RELEASE, because delivering a
  report is the point of a research tree rather than a grant a project has to opt into. (Question 5 in §11 asks the
  reader to confirm that, since it rides in every spawn.)
- It does **not** ride on the assistant's own turn (`anchorCwd: false`), because that turn has no tree to resolve a
  relative path against — the same structural reason the TODO block and the scratch line are skipped there
  (`lib/jobs.js:2138-2142`).
- It is **not** in `j.prompt`: the card shows the reader's own brief, and `lib/descriptions.js` derives a branch
  description from it. The paragraph rides in the input only, after the "Work in …" sentence, exactly as the TODO block
  and RELEASE paragraph do.

---

## 4. The store: where it lives, what it holds, how it is capped

### 4.1 "under `logs/` beside `jobs.json`" — the literal answer

The reader's `logs/` is the folder the job store lives in. In this install that is
`C:\Users\roper\.wag\state\`: `jobs.json`, `assistant.json` and their siblings are there, and `~/.wag/logs/` holds the
panel's own server logs (`server.out.log`, `server.err.log`, `server.pid`). A `PANEL_CONFIG` instance keeps every state
file flat in `<config dir>/logs`, which is the layout the reader remembers.

So the file is **`deliverables.json` in `statePaths().stateDir`** — beside `jobs.json` and `assistant.json`, wherever
that directory is — and it is never inside a checkout, a worktree or a tracked file. It is not a `.gitignore` question
at all: the data directory is outside every repository.

`lib/paths.js` is the only module allowed to spell that path (`test/paths.test.js:239` greps for a literal `logs/` and
fails). Three edits, exactly as the state-file rule requires:

1. `statePaths()` (`lib/paths.js:190`, beside `releasesFile`):
   `deliverablesFile: config.deliverablesFile || file("deliverables.json")`.
2. `STATE_FILE_NAMES` (`lib/paths.js:54`): add `"deliverables.json"`, or the one-time migration from a legacy
   `<repo>/logs` install silently leaves the new file behind.
3. Nothing else: `ensureDirs` already makes the state folder, and the store takes its path as an option.

### 4.2 The shape

```json
{
  "version": 1,
  "savedAt": "2026-11-03T21:40:12.004Z",
  "nextSeq": 18,
  "entries": [
    {
      "seq": 17,
      "kind": "file",
      "target": "C:/ProjectDevelopment/agent-worktree-gui/.worktrees/phase-1-of-a-build-resea-5db421/docs/plan/deliverables-handback.md",
      "title": "The deliverables handback plan",
      "at": "2026-11-03T21:40:11.902Z",
      "project": "agent-worktree-gui",
      "treePath": "C:/ProjectDevelopment/agent-worktree-gui/.worktrees/phase-1-of-a-build-resea-5db421",
      "branch": "wtgui/phase-1-of-a-build-resea-5db421",
      "jobId": "f39e904c",
      "thread": "wtgui-phase-1-of-a-build-re-6b1a2c",
      "turn": 1,
      "agent": "phase-1-of-a-build-resea-5db421",
      "bytes": 18234,
      "missingAt": null
    }
  ]
}
```

Field by field, and why each is there:

| field | why |
| --- | --- |
| `seq` | the identity: a monotonically increasing integer, never reused, and the key the open route takes. It is also the tie-break when two deliveries share a millisecond — the same reason a TODO id is never handed out twice. |
| `kind` | what the click does: Chrome, the OS handler, or the image viewer; and the glyph. |
| `target` | a normalised URL, or a forward-slashed **absolute** path. Display and opening both read this one field. |
| `title` | the only thing the reader reads in a 200-row list; capped at 160. |
| `at` | when it was delivered (ISO). Newest-first ordering, and the "3m ago" the row shows. |
| `project`, `treePath`, `branch` | where it came from, so a row whose run is long gone can still open its worktree. |
| `jobId`, `thread`, `turn` | which console the row opens: the thread's card, the turn that produced it. |
| `agent` | the name the reader knows it by, resolved at harvest (`labelFor` → session title → thread). |
| `bytes` | `stat().size` for a file/image; `null` for a link. Shown on the meta line, so a 0-byte file is visible. |
| `missingAt` | set when a click finds the file gone (§6.2), cleared when a later click finds it. The row says "gone" instead of the reader wondering whether the click failed. |

### 4.3 Identity, ordering and dedupe

- **Ordering** is `at` descending, then `seq` descending. The store writes itself already sorted, so the file reads
  newest-first and a hand-edit does not scramble the list.
- **The dedupe key is derived, not stored**: `link:<URL as normalised by new URL()>` or `file:<lower-cased,
  forward-slashed absolute path>` (an `image` shares the `file:` key space, because the same bytes delivered once as
  `file` and once as `image` are one deliverable). Deriving it means a hand-edited path cannot create two spellings of
  one key.
- **One row per target.** A second delivery of the same target **updates** that row: `title`, `at`, `jobId`, `thread`,
  `turn`, `agent`, `branch`, `bytes` — and it therefore becomes the newest row. `seq` never changes, so a popover open
  across the update still points at the same row.
- **Same run, same target** (the agent wrote the line twice, or a restart re-read it): the title is updated and `at` is
  **not** touched. That is what makes a restart-harvest idempotent even if the persisted mark were ever lost.
- **What is given up:** the earlier producer's attribution. The row names the most recent run that delivered the
  target; the earlier run's own console still carries its `⇢ DELIVER` line. Question 2 in §11 asks the reader to
  confirm this over a stacking list.

### 4.4 Cap and pruning

`DELIVER_KEEP = 200`. Pruning happens in `save()` and nowhere else — a write is the only thing that grows the file, so
a write is the only thing that trims it:

```js
const kept = [...this.entries].sort(byNewest).slice(0, DELIVER_KEEP);
this.entries = kept;                    // memory and file agree
writeFileSync(tmp, JSON.stringify({version, savedAt, nextSeq, entries: kept}, null, 2));
renameSync(tmp, this.file);             // atomic: a reader never sees half a file
```

- **The oldest rows are forgotten, never their files.** Pruning drops a row from the list; it does not delete anything
  on disk, and the plan says so in the popover's footer when the cap is reached (§5.5).
- **`nextSeq` is `max(stored nextSeq, max(seq) + 1)` on load**, exactly like `TodoLists`' `nextId`
  (`lib/todos.js:281-283`): a hand-edited or older file can never hand a live `seq` out twice, even if the list is
  currently empty.
- **`load()` also sorts and slices**, so a file from a build with a larger cap (or hand-edited) is brought to the
  current cap on the next boot rather than on the next delivery.

### 4.5 Restart survival, and a corrupt file

- `load()` is lazy (the first read), then cached, like `ReleaseRequests` (`lib/worktrees.js:231`). After a restart the
  first `GET /api/deliverables` or the first harvest reads the file; the list is the same one the reader left.
- A file that cannot be parsed is **moved aside, not overwritten**: the first `save()` renames it to
  `deliverables.json.corrupt-<epoch-ms>`, logs one line, and writes a fresh file. `ReleaseRequests` starts empty and
  overwrites (`lib/worktrees.js:258`); a deliveries list is not worth less than the ability to look at what broke.
- A single unusable entry (no `target`, no `kind`, no `at`) is dropped on load with one log line naming the `seq`, and
  the rest of the list survives.

---

## 5. The button and the list

### 5.1 The button

`public/index.html:22`, immediately after `#btn-human`, before `#btn-collapse-all`:

```html
<button id="btn-deliver" type="button" title="DELIVERABLES — every deliverable produced on this panel, newest first. Click or press D to open the list: a link opens in Chrome, a file opens in the program this machine uses for it, and clicking a row opens the agent that produced it.">DELIVERABLES</button>
```

- **Label: `DELIVERABLES`.** The reader picked it over `DELIVERED` and `DELIVER`. It is a noun, so it does not read as
  a third queue the way the two buttons beside it do; the cost is that it is the longest word in the header, which is a
  wrapping risk on a narrow window.
- **No badge.** A permanent count of everything ever delivered reads as work outstanding, and the two buttons beside it
  taught the reader that a number there means "answer me". The head of the list says the count.
- **Placement** keeps the three waiting/handing-over controls together, and `#btn-collapse-all` (a layout action, not a
  queue) stays after them.
- **`D`** opens and closes it: a document keydown handler, no modifiers, with the same text-entry guard HUMAN uses
  (`humanTextEntry`, `public/app.js:18082` — a page global, reused so a `d` typed into a reply box, a Settings search
  or a contenteditable never jumps the page). `D` is free: the page's only bare-letter shortcut is `H`.

### 5.2 The popover

A fixed-position panel anchored under the button, in the shape `.artifacts-pop` already uses
(`public/style.css:1949`) — the panel's own idiom for a list that hangs off a control:

- `position: fixed`, right-aligned under `#btn-deliver`, above the board (`z-index: 60`), closed on an outside click,
  on Esc, on a second press of the button, and on a board repaint that removes the button (it never is).
- `width: min(560px, 92vw)`, `max-height: min(70vh, 640px)`, `overflow-y: auto`.
- A **sticky head**: `17 deliverables — newest first`, a filter input (`filter…`, autofocus), and `✕`.
- The list, then a footer (§5.5).

A row:

```
📄  The deliverables handback plan                              docs/plan/…/deliverables-handback.md
    phase-1-of-a-build-resea-5db421 · agent-worktree-gui · 3m ago            [ open agent ]
```

- The **title is a button** (`.dl-name`): it opens the target. Full target on hover, and the last three path segments
  or the URL's host+path on a second line, so two reports called "report" are distinguishable.
- The **meta line** is the agent, the project, and `fmtAgo(at)` (`public/core/dom-format.js:71`, reused so "3m ago"
  means the same thing here as on every card).
- The **`open agent`** button (`.dl-agent`) is the keyboard/AT equivalent of clicking the row.
- A **`gone`** chip replaces nothing else when `missingAt` is set: the title is struck through, the chip's tooltip says
  when it was last seen and by which agent, and the click still tries (the file may have been restored).

### 5.3 The three click behaviours

| where | what happens |
| --- | --- |
| the **title** (`.dl-name`) | `POST /api/deliverables/open {seq}` → a **link** opens in Chrome, a **file** or **image** opens in the program this machine associates with that suffix (§6.1). |
| **anywhere else on the row** | the agent's console is opened at the turn that delivered it (§6.2), the popover closes, and the card flashes the NOT-RUNNING amber for 1.3 s so the eye lands on it. |
| the **`open agent`** button | the same as the row — its keyboard and screen-reader path. |

That split is deliberate: the row is a *pointer to the agent*, the title is a *pointer to the thing*. It also means a
mis-click in a 200-row list opens a console (cheap, reversible) rather than launching a browser window (not).

### 5.4 Keyboard

Focus lands in the filter input when the popover opens; the list is driven as a combobox (`role="combobox"` +
`aria-activedescendant`, `role="listbox"` rows), so the reader never has to Tab between two buttons per row.

| key | action |
| --- | --- |
| `D` | open / close (inert inside any text field — the HUMAN guard, reused) |
| `↓` / `↑` | next / previous row; the active row scrolls into view; stops at the ends (a 200-row list does not wrap) |
| `Home` / `End` | first / last row |
| `PageDown` / `PageUp` | forward / back ten rows |
| `Enter` | open the **target** of the active row |
| `Alt+Enter` | open the **agent** of the active row (the row click) |
| `Esc` | clear the filter if it has text; otherwise close and put focus back on `#btn-deliver` |
| `Tab` | close (do not trap focus in a header popover) |
| typing / `Backspace` | filter by title, target, agent or project (case-insensitive substring); the active row resets to the first |

`aria-expanded` on the button, `aria-label` on the popover, and the active row carries `aria-selected="true"`.

### 5.5 What happens with 200 entries

- **All of them are painted.** 200 rows is a bounded, small DOM — a few thousand nodes — and virtualising it would buy
  nothing but a scroll-position bug. The cap (§4.4) is what keeps that true; without it, "every deliverable" grows
  without limit and the popover becomes a second job store.
- **Day separators** (`TODAY`, `YESTERDAY`, `2026-11-01`) as non-interactive rows, so a long scroll has landmarks.
- **The filter is the answer to the 200th row**, not scrolling: `markdown` narrows to the three reports that mention it
  in title, path or agent.
- **The head and filter are sticky**; only the rows scroll.
- **A delivery that lands while the popover is open** arrives as one SSE `deliverable` event (§7.1); the page re-fetches
  the list, restores `scrollTop` and the active `seq`, and does not steal focus. If the new entry is the active one it
  stays active; otherwise the list simply has one more row above.
- **The cap line appears only at the cap**: `200 kept — older rows are forgotten; the files stay on disk.`

### 5.6 Empty, loading, and error states

- **Empty:** `Nothing has been delivered yet.` plus the marker in a `<code>` line — the one place the grammar is
  documented in the page, for the reader who wants to tell an agent by hand.
- **Loading:** the head says `reading…` and the body is one dim line; the fetch is a single GET and there is no spinner
  theatre for 40 KB.
- **Failed:** `could not read the list: <error>` and a `retry` button. A popover that silently shows nothing is
  indistinguishable from an empty one, which is the failure this feature exists to end.

### 5.7 Where the code lives

**A new file, `public/board/deliverables.js`, a classic script** like `public/board/hot.js` — which means the 1.1 MB
`public/app.js` is **not edited at all** for this feature. It is loaded after `core/transport.js` (it calls `apiFetch`)
and before `app.js` (index.html:748-750), registers the button's click listener at load (the button is static markup,
exactly like `#btn-hot`), and renders only at call time. Its dependencies are existing page globals:
`$`/`esc`/`tailPath`/`fmtAgo` (`core/dom-format.js`), `apiFetch` (`core/transport.js`), `conversations`,
`renderConversation`, `assistantSessionFor`, `hotRowFor`, `hotOpenPath`, `flashHotCard`, `scrollCardUnderBar`,
`showBanner`, `keyOf`, `toggleProject`, `humanTextEntry`.

It keeps its own state in a module-level object, not in `state` (`app.js:55`): nothing else in the page reads it, so
adding a `state.deliver` slice would be an edit to app.js for no reader — the opposite of what `state.hot` needed,
because app.js's own renderers read that one.

---

## 6. What a click actually opens

### 6.1 The target: Chrome, or this machine's handler

`lib/open-url.js` is the module that already opens things without a shell, and it explains why that matters (a
`cmd.exe /c start` re-parses `&`; `lib/open-url.js:1-15`). Two functions are added beside `openerFor`:

```js
export function chromeFor(url, { platform, env, isFile }) -> {bin, args} | null
export function defaultOpenerFor(target, { platform }) -> {bin, args}
```

- **Chrome** on Windows, in order: `%CHROME_PATH%` when it is set and names a real file, then
  `%ProgramFiles%/Google/Chrome/Application/chrome.exe`,
  `%ProgramFiles(x86)%/Google/Chrome/Application/chrome.exe`, `%LOCALAPPDATA%/Google/Chrome/Application/chrome.exe`.
  On this machine the first candidate exists. On macOS, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`;
  elsewhere, `google-chrome`. No flags: Chrome reuses its window and opens a tab, so the reader keeps his session.
  **When none is found the link still opens** — through `openerFor` (the OS default browser) — and the route's answer
  says `chrome: false`, which the page turns into one banner line: `Chrome was not found — opened your default
  browser`. A missing Chrome must not become a missing deliverable.
- **A file or image** goes to `explorer.exe <path>` on Windows (`open` on macOS, `xdg-open` elsewhere): ShellExecute,
  i.e. *the program this machine uses for that suffix* — `.html` in Chrome, `.pdf` in the reader's PDF app, `.md` in
  whatever owns it. **Deliberately not `editorFor`** (`server.js:103`), the Notepad++ resolver `/api/open-path` uses:
  that route opens a file *to edit it*, and a delivered `.html` is a thing to *look at*. Two routes, two intents, and
  the plan says so where both are defined.
- Both spawn `detached: true, stdio: "ignore", windowsHide: true` and `unref()`, exactly like `/api/open-url`
  (`server.js:4449`): neither `explorer.exe` nor a detached Chrome reports an exit code that means anything, so the
  route answers from the spawn, not from the child.

### 6.2 Which console a row opens

The row carries `thread`, `turn`, `jobId`, `project` and `treePath`. The open path is HUMAN's own path
(`humanShow`, `public/app.js:17872-17912`), because that is the one function in the page that already knows how to put
a specific turn in front of the reader:

1. `conversations().find(c => c.thread === entry.thread)`. A delivery from an **assistant's own run** is a session, not
   a row: `assistantSessionFor(thread)` → `window.__assistantShowThread(thread)` → `renderConversation(thread)` → the
   float's Chat pane, exactly as HUMAN does for an assistant's question.
2. A board delivery: `hotRowFor(thread)` → `hotOpenPath(row)` (unfolds the project, its root folder and the row —
   `public/board/hot.js:97`), then unfold the card if it is collapsed.
3. **Page the turn in**: `state.turnOpen.set(turnId, true)`, `state.turnCompact.delete(turnId)`, and
   `state.turnPage.set(thread, pages - 1 - floor(index / TURNS_PER_PAGE))` — the five lines at `public/app.js:17890-17895`.
4. `renderConversation(thread)`, re-query the card (the render replaces the node), `scrollCardUnderBar(card)`, and
   `flashHotCard(thread)` so the reader sees where he landed.
5. The popover closes before the scroll, so it cannot cover the card it just opened.

Three fallbacks, each said in a banner rather than a silent no-op:

- **The turn is gone** (the store keeps 80 conversations): open the thread's newest turn and say
  `that turn is no longer on the board — opened the newest one`.
- **The thread is gone**: open the worktree row from `project` + `treePath`
  (`toggleProject` if needed, then the row's own click) and say `the run that delivered this is no longer on the board
  — opened its worktree`. The file itself still opens from the title; only the agent link degrades.
- **Everything is gone**: `that deliverable's agent and worktree are both gone` — and the target still opens.

That five-step sequence is the *only* duplicated code in this plan. The right home for it is one
`openAgentTurn(thread, turnId)` helper extracted from `humanShow`; extracting it means editing `public/app.js`, which
is held this turn (§8), so phase 2 starts with that extraction or copies the five lines with a comment naming
`humanShow` as the original.

---

## 7. Routes and wiring

### 7.1 The list

`GET /api/deliverables` — read-only, no token (the same convention as `GET /api/jobs`, `server.js:3477`):

```json
{ "version": 1, "cap": 200, "kept": 17, "nextSeq": 18, "at": "…", "entries": [ … newest first … ] }
```

`kept` and `cap` are what the footer reads; `entries` is the array the page paints.

`DELIVER` lines also broadcast one SSE event, so a list open in another tab (or the reader's own) moves without a
reload: `{ type: "deliverable", seq, kind, title, at }` — a one-line `broadcast()` from the store's `onChange` hook,
wired in server.js beside `assistant.todosChanged` (`server.js:1073`). The handler in `public/core/sse.js` is three
lines (re-fetch if the popover is open — §5.5).

### 7.2 The open

`POST /api/deliverables/open` `{ seq }`, authorised (`authorised(req)` — the POST convention every mutating route uses,
`server.js:3527`). The page never sends a path: **the route opens only what the store recorded**, the same rule
`/api/jobs/artifact/delete` follows (`server.js:4469`), so a stray string from a page cannot launch an arbitrary file.

| case | answer |
| --- | --- |
| no such `seq` | `404 {error: "no deliverable 17 on this panel — the list was pruned, or this page is older than the store"}` |
| `link` | `200 {ok:true, kind:"link", target, opener:"chrome.exe", chrome:true}` |
| `link`, no Chrome | `200 {…, opener:"explorer.exe", chrome:false}` |
| `file`/`image` that exists | `200 {ok:true, kind, target, opener:"explorer.exe", bytes}` and `missingAt` cleared if it was set |
| `file`/`image` that is gone | stamp `missingAt`, save, `404 {error: "no such file: <target> — it was there when <agent> delivered it (<at>); it has since been moved or deleted"}` |
| a spawn that throws | `500 {error: "<message>"}` |

The `missingAt` stamp is what makes the second click honest: the row says `gone` instead of pretending, and the list
does not silently accumulate dead rows that look alive.

### 7.3 Server wiring, in order

Beside the release store (`server.js:1089`):

```js
const deliverables = new Deliverables({ file: config.deliverablesFile, log, trees: panelTrees });
jobs.deliverables = deliverables;
deliverables.onChange = (entry) => broadcast({ type: "deliverable", seq: entry.seq, kind: entry.kind, title: entry.title, at: entry.at });
```

`panelTrees()` (`server.js:1027`) is handed over exactly as `TodoLists` and `ReleaseRequests` get it, so a delivery's
project is resolved by the same list of trees every other store uses, and a rename moves it with the row.

---

## 8. Every file this work touches

New:

| file | what it is |
| --- | --- |
| `lib/deliverables.js` | `parseDeliverLines`, `normaliseTarget`/`dedupeKey`, the `Deliverables` store (`load`, `save`, `record`, `list`, `get`, `markMissing`), `DELIVER_KEEP`. |
| `public/board/deliverables.js` | the button listener, the popover, the fetch, the filter, the keyboard model, the three click behaviours, `openAgentTurn`. |
| `test/deliverables.test.js` | §9.1. |
| `tools/verify-deliverables.mjs` | §9.2, `// HARNESS: LIVE GATE` (the runner discovers it — `tools/verify.mjs:8`). |
| `docs/plan/deliverables-handback.md` | this document. |

Edited:

| file | anchor | change |
| --- | --- | --- |
| `lib/paths.js` | `STATE_FILE_NAMES` at `:54`; beside `releasesFile` at `:190` | add `"deliverables.json"`; add `deliverablesFile`. |
| `lib/deliverables.js` | — | new, above. |
| `lib/jobs.js` | `RELEASE_BRIEF` at `:97`; `measureTree` at `:1917`; `harvestRelease` at `:1930`; `anchored` at `:2177`; persist map at `:727` | add `DELIVER_BRIEF`; call `harvestDeliverables(j)` after `harvestRelease`; add the method; append `deliverText`; persist `deliverHarvested`. |
| `lib/open-url.js` | beside `openerFor` at `:34` | add `chromeFor` and `defaultOpenerFor`; no change to `safeUrl` or `openerFor`. |
| `server.js` **(held this turn)** | import at `:54`; store at `:1089`; SSE at `:1218`; GET at `:3519`; POST at `:4449` | construct the store, wire `jobs.deliverables`, the broadcast hook, and the two routes. |
| `public/index.html` **(held this turn)** | button after `:22`; scripts at `:748-750` | the `#btn-deliver` markup; `<script src="/board/deliverables.js"></script>` after `transport.js`. |
| `public/style.css` **(held this turn)** | after `#btn-human` at `:128`; after `.artifacts-pop` at `:2003` | `#btn-deliver` and the `.deliver-pop` block. |
| `public/core/sse.js` | `connect()`'s handler list at `:62-120` | one `deliverable` listener. |
| `package.json` | `scripts` | `"verify:deliverables": "node tools/verify-deliverables.mjs"`. |
| `public/app.js` | — | **no edit.** The module is a classic script that calls app.js's globals at call time. |

**Landing order.** `lib/*`, the new scripts, the tests and the gate can be written while the worker holds the four
files; `server.js`, `index.html`, `style.css` and `app.js` are patched only after that worker's change is on the
branch, re-reading each anchor then (every anchor above is text, not just a number). `app.js` is on the list only
because the four are held as a set — this plan asks nothing of it.

---

## 9. How it is proved

### 9.1 Unit (`test/deliverables.test.js`, run by `npm test`)

1. **The grammar**: every row of §2.3 as a separate assertion on `error` and on the reason's wording; a title
   containing a `|`; a quoted path with spaces; `deliver` in lower case; `DELIVERED` not matching; a Markdown fence
   line not matching (parity with RELEASE).
2. **Resolution**: `C:/x/report.md` stays as written; `docs/report.md` becomes `<tree>/docs/report.md`; `..` cannot
   escape without being resolved and shown; a target over 1024 chars is refused.
3. **Kind validation**: `link` refuses `ftp:`, `mailto:` and a bare path; `image` refuses `.html`; `file` accepts a
   directory? — no: it refuses one, by name.
4. **The store**: one good line → one entry with kind/target/title/seq/at/agent/bytes; a second constructor over the
   same file reads it back (**the restart proof**, the same second-instance rule `assistant.json`'s mapper needed);
   `missingAt` set and cleared.
5. **Dedupe**: same run twice → one entry, `at` unchanged, title updated; a second run → one entry, `at`/agent updated,
   `seq` unchanged.
6. **Cap**: 201 deliveries → 200 entries, the oldest gone, `nextSeq` never reused, and a reload does not resurrect it.
7. **Corrupt**: a truncated file logs once, starts empty, and the first save leaves `deliverables.json.corrupt-*`.
8. **The settle seam**, driven on `Object.create(Jobs.prototype)` with `deliverables` and `push` — the exact shape of
   `test/release-request.test.js:196-221`: one entry, `deliverHarvested`, one `⇢` line, a second call is a no-op, a
   malformed line leaves the store empty and one `⚠` line.
9. **The brief**, on a stub gateway (the 40-line `stubGateway()` in `test/brief-follows-the-policy.test.js:76-110`
   records every submitted `input`): a tree run's input carries the `DELIVER` paragraph and the marker; the
   assistant's own run (`anchorCwd: false`) carries neither.

### 9.2 The live gate (`tools/verify-deliverables.mjs`)

A real panel of its own (`PANEL_CONFIG`, its own port and jobs store, `tools/panel-testkit.mjs`), a stub Runs API that
streams a final message containing two `DELIVER` lines (one good file, one missing file), and headless Chromium over
the page it serves. It asserts, and prints one line per check:

1. `#btn-deliver` sits between `#btn-human` and `#btn-collapse-all`, and `D` opens it while a `d` typed into a reply
   box does not.
2. The settle harvest put exactly one entry in `deliverables.json` beside `jobs.json`, and the card carries the `⇢`
   line and the `⚠` refusal for the missing file.
3. The list is newest-first, the row shows title/agent/project/age, and the target line is the file it was given.
4. Clicking the title calls the open route with the `seq` and the server opens the **recorded** path (the spawn is
   observed through the testkit's process seam, not by launching Chrome on the test box).
5. Clicking the row opens the agent: the project, its root folder and the row unfold, the card unfolds, the turn is
   paged in, and the card wears the flash.
6. A delivery of the same target from a second run updates the row and does not add one.
7. 200 seeded entries paint, the filter narrows them, `End` reaches the oldest, and the cap line appears.
8. `missingAt`: a file deleted between harvest and click answers 404, the row says `gone`, and a restored file clears
   it on the next click.

The **red proof** is the same gate run against a `git archive` of `main`: every check fails by name because
`#btn-deliver` and the route do not exist there — the recipe in
`.agentboard`'s state-file notes (copy the tool into the export, `git init -q -b main`, commit, run).

---

## 10. What this plan does not do

- **No thumbnail for an image.** It needs a route that serves bytes from a path the store holds; that is a new
  file-serving surface, and it is not worth one in a phase that adds no reader-facing risk. The glyph and the OS
  viewer answer the click.
- **No delete/forget.** The cap prunes; a row the reader wants gone is gone within 200 deliveries. A `✕` per row is
  the obvious follow-up and needs a confirmation (the artifact pop's ✕ deletes a file — this one would only forget a
  row, so the two would look alike and mean different things).
- **No backfill from `job.artifacts`.** Every `write_file` a run ever made is in those lists, including scratch files;
  importing them would fill the list with noise and claim the reader "delivered" things he never asked for.
- **No per-project switch.** Question 5 in §11 asks whether the paragraph should be unconditional.
- **No badge, no unread marker.** Both are a queue's language, and this is an archive.
- **No version bump and no changelog entry.** The reader asked for the plan, not a release.
- **No edit to the four held files in this turn.** The plan is the deliverable.

---

## 11. Open questions for the reader

These are the choices the plan cannot make for him. Each was asked in the session with these options. Three are
answered (recorded here, and folded into the sections above); two were left to the plan's default and are still open.

1. **The button's word.** — **ANSWERED: `DELIVERABLES`.** The alternatives offered were `DELIVERED` and `DELIVER`;
   §5.1 now carries the chosen label and its cost (the longest word in the header).
2. **A target delivered twice.** — **ANSWERED: one row, updated in place.** §4.3 is the design: `seq` is the identity
   and never changes, `at` moves the row to the newest delivery, and the earlier producer's attribution is given up.
3. **A malformed or missing `DELIVER`.** — **ANSWERED: a console line on the card only.** §2.3 and §3.2 already stand:
   one `⚠ DELIVER was NOT recorded — <reason>` line, nothing in the store, and the line survives a reload.
4. **`image`.** — **OPEN.** The plan's default is (a): a glyph and the OS image viewer, no new route, no bytes through
   the panel (§2.2, §10). The alternative is (b): a thumbnail in the row, which needs a read-only route that serves a
   recorded image path, capped and cached.
5. **The `DELIVER` paragraph in every spawn.** — **OPEN.** The plan's default is (a): always, for every tree run (§3.3).
   The alternative is (b): only when the project opts in with `deliverables: true`, mirroring `releaseWorktrees` — less
   prompt cost, and a project that has not opted in never learns the marker.
