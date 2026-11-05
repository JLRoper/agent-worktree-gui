# Deliverables handback — the plan

**Re-measured against `origin/main` at `e88dc53` (`package.json` 0.94.0).** The plan first landed at `4f660d2`
(0.87.0) and was revised at `dc5bde2` (0.93.0); the 0.93.0 → 0.94.0 delta touches only the version tooling and
`lib/scan.js`, so every anchor below still reads on 0.94.0. The branch carries the bump this PR lands as **0.98.0** —
0.95.0, 0.96.0 and 0.97.0 are already anchored by live sibling branches (`v0.95.0` is on origin), and a version is
anchored once. It
re-reads its anchors against main as it stands because the branch the first draft deferred to
(`wtgui/three-ui-changes-main-is-8c936e`) landed as `f55fecb`/`f9f103d`. On main there is **no `#btn-hot`**, no
`#btn-aggressive` and **no `public/board/hot.js`**; §5.1, §5.7 and §6.2 are anchored to what is there now — Assistant,
HUMAN, Collapse all. This branch was cut from main and has been rebased onto it; the implementation re-reads every
anchor against main as it stands then.

Line numbers drift with every landing; every anchor below is given with the text to search for, so a later reader
re-locates a seam instead of trusting a number.

This is a plan. This commit touches one file — this document. Nothing under `public/`, `server.js` or `lib/` is edited
here; §8 says where each edit lands when the work starts, and the conclusion of the review that blocked it is in
§0.

**The ask.** A research agent hands its report back as a loose `.html` file in a worktree, and the reader finds it by
remembering it. He wants a header button beside HUMAN (`#btn-human`) — in the header main has now, which is Assistant,
HUMAN, Collapse all — that opens a scrollable, newest-first list of every deliverable produced on this panel: a link
opens in Chrome, a file opens in whatever this machine uses for that suffix, and clicking the row opens the agent that
produced it.

**The answer.** A worker says one line in its final message — `DELIVER <link|file|image> <target> | <title>` — and the
panel reads it at settle, on the same seam that already reads `TODO` and `RELEASE` (`Jobs.measureTree`). The worker
never learns a path, an id or an API: validation, dedupe, ordering, storage and the click behaviours are the panel's.
The store is `deliverables.json` beside `jobs.json`, capped at 200 entries and pruned on write.

---

## 0. What changed since the review

The review (`docs/plan/deliverables-handback-review.md`, `dc0391f`) returned **NEEDS CHANGES** — 3 blockers, 14
must-fixes. Every one is resolved below; two of its premises were stale and are corrected rather than inherited. The
review said the plan was waiting on `wtgui/three-ui-changes-main-is-8c936e`; that branch landed as `f55fecb`/`f9f103d`,
so the header it described no longer exists on main.

| finding | resolution |
| --- | --- |
| **B1** no try/catch in `measureTree`; the sketched `save()` throws | §3.2 point 1 (the function has no try/catch; `harvestDeliverables` owns one, `record()` never throws, `save()` catches) and §4.4 (the `save()` sketch with `mkdirSync`, a try/catch, and `return false`). |
| **B2** a relative target resolves against a stale `job.worktreePath` | §2.3 and §3.2: `record()` takes the `tree` this `measureTree` pass located, resolves relative targets against `tree.path` first, and falls back to the job fields only when there is no tree. `entry.treePath` is the measured path. |
| **B3** `deliverText` used before it exists | §3.3: `const deliverText = …` is defined at `lib/jobs.js:2137`, beside `releaseText` and with the same gate, before the template; `jobs.deliverBrief` is the override. |
| **M1** `authorised(req)` is the wrong precedent | §7.2: `authorised(req, config.token)`, with the two neighbouring routes cited and the reason. |
| **M2** the plan's header is the one the held branch deletes | Premise corrected: the branch landed (`f55fecb`), main's header is Assistant, HUMAN, Collapse all at `index.html:19-21`, and there is no `#btn-hot`. §5.1, "The ask" and §8 are rewritten against it. |
| **M3** `public/board/hot.js` is deleted by that branch | Premise corrected the same way: `hot.js` is gone on main; `hotRowFor`/`hotOpenPath`/`flashHotCard` are `app.js` globals at `:17780`/`:17790`/`:17812`. §5.7 and §6.2 re-anchor to those. |
| **M4** the brief's own template line is refused | §3.3: the brief prints `syntax:` and `example:` lines (neither starts with `DELIVER`) and a valid example; §2.1 makes a `<…>` placeholder target a silent template echo; §9.1 asserts `parseDeliverLines(DELIVER_BRIEF)` yields zero markers. |
| **M5** the mark is set before the write | §3.2: the mark is set only after `record()` returns `saved !== false`, and only when the message carried a marker; a failed write leaves it unset and says so. |
| **M6** the corrupt file is not preserved by the sketched `save()` | §4.4/§4.5: `save()` calls `moveCorrupt()` before it writes, so `deliverables.json.corrupt-*` holds the evidence. |
| **M7** the page's turn identity is the job id | §4.2 and §6.2: `jobId` is the key the click uses (`t.id === entry.jobId`); `turn` is display-only and is documented as moving backwards. |
| **M8** `defaultOpenerFor` duplicates `openerFor` | §6.1/§8: only `chromeFor` is new; a file/image goes through `openerFor`. |
| **M9** the gate's "process seam" does not exist | §9.2 item 4: there is none (`panel-testkit.mjs:89-91`); the gate calls the route itself and asserts 200/404, and never clicks the title (which would launch Chrome). |
| **M10** the plan both edits and does not edit `app.js` | §6.2/§8: **no edit**; `openAgentTurn` is a copy of `humanShow`'s five lines with a comment naming the original, not an extraction. |
| **M11** the paragraph rides every turn, not every spawn | §3.3 states the real cost (seven lines per message in a tree conversation); §4.3 adds the repeat rule that keeps a reply echoing the marker from bumping the row; §11 Q5 records the decision with that cost. |
| **M12** the restart rationale is not the code's behaviour | §3.2 point 3: a settled job is never re-measured at boot; the mark is a guard against a second read of one message, and the persisted copy is cheap insurance, not load-bearing. It also names the path the mark must not close: a restored live job measured empty at boot, then harvested when it settles later. |
| **M13** "H is the page's only bare letter" is false | §5.1: the bare `A` (`public/assistant.js:4201-4214`) and bare `H` (`app.js:18177`) precedents are named, and D copies H's `e.repeat`. |
| **M14** the `trees` provider has no job | §4.2/§4.3/§7.3: the entry gains `tag`; `list()` resolves `project`/`treePath`/`branch` through `trees()` at read time by tag, so a rename is followed rather than promised. |
| nits | N1–N15 are folded in: N1 `statePaths` at `:169`; N2 the five lines at `:17966-17970` and `humanShow` ending `:17997`; N3 `:1889` and the tail at `:737`; N4 ~80 KB; N5 `isFile` gone with the duplicate; N6 the lower-cased key is named as the house `pathKey` rule; N7 `load()` slices in memory only; N8 the duplicate row is gone; N9 `KEEP_JOBS` is jobs/turns; N10 `e.repeat`; N11 the red proof uses `startPanel({root})`; N12 the return shape is `{parsed, added, updated, refused, lines, saved, error}`, not RELEASE's; N13 `j.delivered` is diagnostic and not persisted; N14 the `logs/` sentence is corrected; N15 `verify.mjs:104-105`. |

---

## 1. What exists today, and why it does not answer the ask

Three facts, read from `origin/main` at `dc5bde2`.

**1.1 There is already a per-card deliverable list, and it is per card.** `Jobs.addArtifact` (`lib/jobs.js:1311`) keeps
`{kind:"file"|"url", path|url, at}` on one job; the card draws two buttons (`public/app.js:4782-4783`) and a popover
that says *"newest last"* (`artifactsPopHtml`, `public/app.js:3628`). It answers "what did THIS agent produce", and the
reader's complaint is the other question: he does not know which agent produced the file he is looking for. The list
also dies with the job (the store keeps 80 jobs/turns, `KEEP_JOBS` at `lib/jobs.js:75`), cannot be searched, and
records a URL the agent *printed* as readily as one it *meant* (`scanUrls`, `lib/jobs.js:1361`).

**1.2 The harvest seam already exists and already reads two grammars out of a run's last words.** `measureTree`
(`lib/jobs.js:1774`) is called when a run settles (and again after a restart for a turn a restart cut off,
`lib/jobs.js:678`). At `lib/jobs.js:1889` it hands `j.finalMessage` to `this.todos.harvest(...)`; at `lib/jobs.js:1917`
it calls `this.harvestRelease(j)`, whose whole body is at `lib/jobs.js:1930-1936`: mark the job, hand the same text to a
store's `record()`, push the sentences the store returns onto the card. The DELIVER line is parsed on exactly this
path; §3 names the line, and says what the seam does **not** have (a try/catch — B1).

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
  loud** (§2.3), never dropped — with one exception: a line whose target is a single `<…>` placeholder is a **template
  echo**, not a delivery. It is ignored, not refused, so a model repeating the syntax it was handed cannot paint a
  warning on a good turn. This is what makes the brief's own example safe to echo (M4, §3.3).

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

`image` is a *file* with two differences: the suffix is checked, and the row gets its own glyph (🖼). The thumbnail is
decided against (§11 Q4): the panel has no route that serves an arbitrary local file, and adding one is its own
security decision, not a rendering detail.

### 2.3 Every failure, and the sentence it produces

Each of these is **not stored** and produces one console line on the card the run just finished:
`⚠ DELIVER was NOT recorded — <reason>` (kind `raw`, so it is not mistaken for the panel's own prose; the same shape as
`lib/worktrees.js:329`). The line lives in `j.lines`, which is persisted (last 120 lines, `lib/jobs.js:737`), so a
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

- **A relative target resolves against `tree.path` — the directory this same `measureTree` pass located** — and only
  falls back to `job.worktreePath || job.ownerPath || job.cwd` when the run has no tree at all. The job fields are set
  once at creation (`lib/jobs.js:2056`) and go stale the moment the panel auto-names a finished tree; `measureTree`
  exists to read that move (`locate()` at `lib/jobs.js:1809`, `readTree()` at `:1827`), and a harvest that used the job
  copy would refuse `docs/report.html` while the file sat one directory over (B2). The refusal line names the directory
  that was used, so the reader can see which one it was.
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

It is called from `Deliverables.record({ job, tree, finalText, agent, now })`, which is the impure half: it resolves and
stats each target, upserts into the store, and returns `{parsed, added, updated, refused, lines, saved, error}` — the
console lines are `{kind, text}` in the panel's voice. It is the same **split** as `parseReleaseLines` (pure) versus
`ReleaseRequests.record` (store + lines), but not the same shape: `record` adds `updated` (a target can already be on
the list), `parsed` (how many markers the message carried, which is what decides the mark — §3.2), `saved` (whether the
write reached the file) and `error`.

### 3.2 Where it is called

In `lib/jobs.js`, in `measureTree`, **on the line after `this.harvestRelease(j)`** (`lib/jobs.js:1917`), before
`this.finalise(j)`, handing it the `tree` this pass already located:

```js
this.harvestRelease(j);
this.harvestDeliverables(j, tree);   // ← new
this.finalise(j);
```

and a new method beside `harvestRelease` (`lib/jobs.js:1930`):

```js
harvestDeliverables(j, tree = null) {
  if (!this.deliverables || !j || j.deliverHarvested) return null;
  let out;
  try {
    out = this.deliverables.record({
      job: j,
      tree,                                   // {path, branch} as locate() measured it, in THIS pass
      finalText: String(j.finalMessage || ""),
      agent: this.labelFor(j.thread) || this.sessionInfoFor(j.thread)?.title || j.thread || null,
    });
  } catch (e) {
    // `record()` is written not to throw; this is the belt to that brace. The mark stays unset.
    this.push(j, { kind: "raw", text: `⚠ DELIVER was NOT read — ${String((e && e.message) || e)}` });
    return null;
  }
  for (const line of out.lines) this.push(j, line);
  if (out.saved === false) {
    this.push(j, { kind: "raw", text: `⚠ DELIVER was NOT recorded — ${out.error || "the list could not be written"}` });
    return out;                                   // mark stays unset: the next pass retries
  }
  if (out.parsed > 0) j.deliverHarvested = true;  // a message with no DELIVER line stays re-readable
  j.delivered = { added: out.added, updated: out.updated, refused: out.refused };
  return out;
}
```

`j.delivered` is diagnostics only and is **not** in the persist map: the store is the record, and `refused` is the
array `record()` returned (`{raw, error}`), not a count (N13).

Five things about that placement are load-bearing:

1. **`measureTree` has no try/catch, so this must not throw into it.** The function's only `.catch` is the git call at
   `lib/jobs.js:1802`; it ends `this.harvestRelease(j); this.finalise(j); this.emit(j); return tree;`
   (`lib/jobs.js:1917-1921`), and both settle call sites are `void this.measureTree(j)` with no `.catch`
   (`lib/jobs.js:2756`, `:2959`); only the lost-run sweep attaches one (`:3269`). So `harvestDeliverables` owns a
   try/catch, `record()` never throws (every branch returns an error object), and `save()` catches its own write
   error. Three layers, because the alternative is an unhandled rejection in the settle path (B1). The first draft
   claimed the call was already "inside the existing `measureTree` try/catch"; there is no such try/catch.
2. **The mark is set after the store accepted the lines, and only when the message carried one (M5).** A failed
   write leaves it unset so the next pass retries; a message with **zero** DELIVER lines leaves it unset too, because
   a live job restored at boot is measured once with no final message (`:678`) and again when the gateway confirms it
   completed — `settleRestoredRun` sets `finalMessage` at `:2950` and measures at `:2959`. Marking the empty first pass
   would swallow that job's real delivery.
3. **The mark is a guard, not the mechanism.** A second `measureTree` over the same message is a no-op. The two
   callers that can read a final message are the settle path (`:2756`) and the restored-run reconcile (`:2959`); the
   restore loop re-measures only jobs that were **live** at the restart — `:640-663` pushes only
   `running`/`starting`/`waiting` into `restored`, and only `restored` is measured at `:678` — so a settled job is not
   re-read at boot. The flag is persisted anyway (`deliverHarvested`, one boolean beside `finalMessage` in the
   `schedulePersist` map, `lib/jobs.js:727`) because it costs one field; it is **not** load-bearing today, and the first
   draft's claim that a restart would re-read an old message and print a false `no such file` was wrong (M12).
4. **A refusal is said, not swallowed.** One `⚠` line per refused marker, in the same console the TODO refusals use
   (`lib/jobs.js:1895-1898`). The store keeps nothing for a refused line, so the console is the only place it can live —
   and it is persisted with the rest of the card's tail.
5. **Nothing is acted on.** Like `RELEASE`, this only records: no route, no delete, no side effect beyond the one JSON
   file.

### 3.3 The paragraph the worker is told

`lib/jobs.js` exports a `DELIVER_BRIEF` constant beside `RELEASE_BRIEF` (`lib/jobs.js:97`), and `create()` appends it
to `anchored` after `releaseText` (`lib/jobs.js:2177-2178`). `deliverText` is defined **before** the template that uses
it, beside `releaseText` at `lib/jobs.js:2137` — the first draft's snippet used it without ever assigning it (B3):

```js
// …beside `const releaseText = …` at lib/jobs.js:2137
// The callback is where Q5's (b) opt-out would live; absent, the paragraph is on.
const deliverText = where && opts.anchorCwd !== false ? this.deliverBrief?.(opts) ?? DELIVER_BRIEF : "";
```

and in the template:

```js
${releaseText ? `\n\n${releaseText}` : ""}${deliverText ? `\n\n${deliverText}` : ""}
```

The text. **No line in it starts with `DELIVER`**, so a model that echoes the paragraph verbatim produces no marker at
all — the first draft printed a literal `DELIVER <link|file|image> <target> | <title>` that its own parser refused
(M4). The opening line is a heading, and the grammar and example are both prefixed:

```
HANDING SOMETHING BACK — when this turn produced something the reader will open (a report, a page, a screenshot, a
link), end your FINAL message with one line per deliverable. The line is:
  syntax: DELIVER <kind> <target> | <title>    — kind is link, file or image
  example: DELIVER file C:/path/to/docs/report.html | The HTML report
The target is a URL for `link`, and a path for `file`/`image` — absolute, or relative to this worktree. The title is
one short sentence: what it is, not what you did. The panel checks the target exists, keeps the list and opens it; you
never need to know where the panel keeps anything. A line that cannot be read is said on this card, not dropped.
```

Checked with the grammar above against this exact block: **7 lines, 0 markers**; the `example:` line with its prefix
removed parses as a valid `file` marker; the first draft's `DELIVER <link|file|image> <target> | <title>` line is
ignored as a placeholder echo rather than refused.

- **It is default-on for a tree run** (`where && opts.anchorCwd !== false`), unlike RELEASE, because delivering a report
  is the point of a research tree rather than a grant a project has to opt into. `jobs.deliverBrief` is the one line a
  later opt-out flips (Q5 is decided (a): every tree turn), wired in server.js beside `jobs.releaseBrief`
  (`server.js:1150-1156` on main).
- **It rides on every turn in a tree conversation, not once at the spawn.** `create()` is also the reply path
  (`lib/jobs.js:1940`, `reply` at `:1966`); `opts.reply` skips only the worktree cut (`:2044`) and a card note
  (`:2207`), and `releaseText`/`anchored` are recomputed on every call. So the cost is seven lines **per message**, and a
  thread of ten replies pays it ten times (M11). The store's repeat rule (§4.3) is what keeps a reply that merely
  repeats a marker from bumping the row to the top: the same target, title and mtime is a no-op.
- **It does not ride on the assistant's own turn** (`anchorCwd: false`), because that turn has no tree to resolve a
  relative path against — the same structural reason the TODO block and the scratch line are skipped there
  (`lib/jobs.js:2138-2142`).
- **It is not in `j.prompt`:** the card shows the reader's own brief, and `lib/descriptions.js` derives a branch
  description from it. The paragraph rides in the input only, after the "Work in …" sentence, exactly as the TODO block
  and RELEASE paragraph do.

---

## 4. The store: where it lives, what it holds, how it is capped

### 4.1 "under `logs/` beside `jobs.json`" — the literal answer

The reader's `logs/` means the folder the job store lives in — and in this install that folder is
`C:\Users\roper\.wag\state\`, not `~/.wag/logs\`: `jobs.json`, `assistant.json` and their siblings are in `state/`,
while `~/.wag/logs/` holds the panel's own server logs (`server.out.log`, `server.err.log`, `server.pid`). A
`PANEL_CONFIG` instance keeps every state file flat in `<config dir>/logs`, which is the layout the reader remembers.

So the file is **`deliverables.json` in `statePaths().stateDir`** — beside `jobs.json` and `assistant.json`, wherever
that directory is — and it is never inside a checkout, a worktree or a tracked file. It is not a `.gitignore` question
at all: the data directory is outside every repository.

`lib/paths.js` is the only module allowed to spell that path (`test/paths.test.js:239` greps for a literal `logs/` and
fails). Three edits, exactly as the state-file rule requires:

1. `statePaths()` (`lib/paths.js:169`; add beside `releasesFile` at `:190`):
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
      "tag": "5db421",
      "jobId": "f39e904c",
      "thread": "wtgui-phase-1-of-a-build-re-6b1a2c",
      "turn": 1,
      "agent": "phase-1-of-a-build-resea-5db421",
      "bytes": 18234,
      "mtimeMs": 1762201211902,
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
| `project`, `treePath`, `branch` | where it came from, stored as of harvest so a row whose tree is gone still says where it was; `list()` re-resolves them through `trees()` by tag (§4.3). |
| `tag` | the six-hex tag of the tree/branch — the one part of a name an auto-rename keeps (`tagOf`, used for exactly this at `lib/worktrees.js:171-175`). It is how a row follows a moved tree; `null` when neither the branch nor the directory leaf carries one, and then only the exact-path match applies. |
| `jobId` | the console turn this delivery belongs to. The page's turn identity is the **job id** (`conversations()` groups jobs and `humanShow` looks up `t.id`), so this is the key the click uses (M7). |
| `thread` | the card's thread, for the conversation lookup. |
| `turn` | **display only, never a key**: `turn` is `siblings.length + 1` and moves backwards when old jobs are trimmed (`public/app.js:1538-1540`), so it must not address anything. |
| `agent` | the name the reader knows it by, resolved at harvest (`labelFor` → session title → thread). |
| `bytes`, `mtimeMs` | `stat()` of a file/image; both `null` for a link. `bytes` is shown on the meta line; both are the repeat signature (§4.3). |
| `missingAt` | set when a click finds the file gone (§6.2), cleared when a later click finds it. The row says "gone" instead of the reader wondering whether the click failed. |

### 4.3 Identity, ordering and dedupe

- **Ordering** is `at` descending, then `seq` descending. The store writes itself already sorted, so the file reads
  newest-first and a hand-edit does not scramble the list.
- **The dedupe key is derived, not stored**: `link:<URL as normalised by new URL()>` or `file:<lower-cased,
  forward-slashed absolute path>` (an `image` shares the `file:` key space, because the same bytes delivered once as
  `file` and once as `image` are one deliverable). Deriving it means a hand-edited path cannot create two spellings of
  one key.
- **One row per target, and a repeat has to be a repeat.** A second delivery of the same target updates that row in
  place (`seq` never changes, so a popover open across the update still points at the same row). What "update" means
  depends on what arrived:
  - **same `jobId` + same target** — the agent wrote the line twice, or a second pass re-read it: a changed title is
    written; `at`, `jobId` and the row's place are not touched.
  - **a different run** — compare the repeat signature (`mtimeMs` + `bytes` for a file/image; the normalised URL for a
    link) **and** the title. If both are unchanged, nothing is written at all: a reply that echoes the marker is not a
    new delivery, which is what keeps a thread of replies from bumping the same report to the top every turn (M11). If
    either changed, the row is updated (`title`, `at`, `jobId`, `thread`, `turn`, `agent`, `branch`, `bytes`,
    `mtimeMs`) and becomes the newest.
- **Read-time resolution (M14).** The store is constructed with `trees: panelTrees` and that provider has one job:
  `list()` maps every entry through the **current** tree list, matching by `tag` first (the six-hex tag survives an
  auto-rename) and then by exact path; when a tree matches, the row's `project`, `treePath` and `branch` are the
  current ones, otherwise the stored ones stand. That is what makes "a rename moves it with the row" a behaviour
  rather than a sentence — the first draft named the provider and never used it.
- **What is given up:** the earlier producer's attribution. The row names the most recent run that delivered the
  target; the earlier run's own console still carries its `⇢ DELIVER` line. Question 2 in §11 records the reader's
  answer to this (one row, updated).
- **A note on case (N6):** the file key lower-cases, which is right on Windows and is what `pathKey` does everywhere in
  this repo; on a case-sensitive filesystem two files differing only in case would collapse into one row. The panel is
  Windows-first, and this follows the house key rather than claiming portability.

### 4.4 Cap, pruning, and the write

`DELIVER_KEEP = 200`. Pruning happens in `save()` and nowhere else — a write is the only thing that grows the file, so
a write is the only thing that trims it. `save()` is also where the failure handling lives, because it is the only
part that touches the disk (B1, M6):

```js
save() {
  if (!this.file) return false;
  this.load();
  try {
    mkdirSync(path.dirname(this.file), { recursive: true });
    if (this.corrupt) this.moveCorrupt();            // the file we could not parse, moved aside ONCE
    const kept = [...this.entries].sort(byNewest).slice(0, DELIVER_KEEP);
    this.entries = kept;                             // memory and file agree
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version, savedAt: nowIso(), nextSeq, entries: kept }, null, 2)}\n`, "utf8");
    renameSync(tmp, this.file);                      // atomic: a reader never sees half a file
    return true;
  } catch (err) {
    this.error = String((err && err.message) || err);
    this.log(`deliverables: could not write ${this.file} (${this.error})`);
    return false;                                    // record() reports saved: false; the harvest retries later
  }
}

moveCorrupt() {
  try {
    renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
    this.log(`deliverables: ${this.file} was not readable — moved aside`);
  } catch (err) {
    this.log(`deliverables: could not move ${this.file} aside (${err.message}) — writing over it`);
  }
  this.corrupt = false;
}
```

- **The oldest rows are forgotten, never their files.** Pruning drops a row from the list; it does not delete anything
  on disk, and the popover's footer says so when the cap is reached (§5.5).
- **`nextSeq` is `max(stored nextSeq, max(seq) + 1)` on load**, exactly like `TodoLists`' `nextId`
  (`lib/todos.js:281-283`): a hand-edited or older file can never hand a live `seq` out twice, even if the list is
  currently empty.
- **`load()` sorts and slices in memory only (N7).** A file from a build with a larger cap is brought to the current
  cap in memory on the next boot, and the file itself is rewritten at the next `save()` — the next delivery — not at
  boot. The first draft said "on the next boot"; the file does not change until someone writes it.
- **A failed write never loses the in-memory list.** `save()` returns `false` with `this.error` set; `record()` passes
  that through and `harvestDeliverables` leaves the mark unset (§3.2), so the next pass tries again.

### 4.5 Restart survival, and a corrupt file

- `load()` is lazy (the first read), then cached, like `ReleaseRequests` (`lib/worktrees.js:231`). After a restart the
  first `GET /api/deliverables` or the first harvest reads the file; the list is the same one the reader left.
- A file that cannot be parsed is remembered (`this.corrupt = true`) and **moved aside at the next write**:
  `save()` calls `moveCorrupt()` before it writes, so `deliverables.json.corrupt-<epoch-ms>` holds the evidence and the
  live path is then replaced. `ReleaseRequests` starts empty and overwrites (`lib/worktrees.js:258`); a deliveries list
  is not worth less than the ability to look at what broke. (M6: the first draft promised this behaviour in prose and
  then sketched a `save()` that overwrote the file.)
- A single unusable entry (no `target`, no `kind`, no `at`) is dropped on load with one log line naming the `seq`, and
  the rest of the list survives.

---

## 5. The button and the list

### 5.1 The button

`public/index.html:20`, immediately after `#btn-human`, before `#btn-collapse-all` (`:21`) — on main as it stands,
where the header is Assistant (`:19`), HUMAN (`:20`), Collapse all (`:21`). There is no `#btn-hot` any more: the branch
that owned it landed as `f55fecb`.

```html
<button id="btn-deliver" type="button" title="DELIVERABLES — every deliverable produced on this panel, newest first. Click or press D to open the list: a link opens in Chrome, a file opens in the program this machine uses for it, and clicking a row opens the agent that produced it.">DELIVERABLES</button>
```

- **Label: `DELIVERABLES`.** The reader picked it over `DELIVERED` and `DELIVER`. It is a noun, so it does not read as
  a queue the way HUMAN does; the cost is that it is the longest word in the header, which is a wrapping risk on a
  narrow window.
- **No badge.** A permanent count of everything ever delivered reads as work outstanding, and the one count the header
  carries (HUMAN's) is a queue. This list is an archive; its head says the count.
- **Placement** is after HUMAN because both are about what an agent handed over, and before `#btn-collapse-all`, which
  is a layout action rather than a list. It is the third control in the header, after Assistant and HUMAN.
- **`D`** opens and closes it: a document keydown handler, no modifiers, `e.repeat` ignored, and the same text-entry
  guard HUMAN uses (`humanTextEntry`, `public/app.js:18168`; the H handler at `:18177`). `D` is free — no `d`/`D`,
  `KeyD` or keyCode 68 binding exists under `public/**` — but the precedent is not "H is the only bare letter": the
  assistant also opens on a bare `A` (`public/assistant.js:4201-4214`, guarded by `inTextField`). Two bare letters with
  two guards; D copies HUMAN's, including the `e.repeat` check (M13, N10).

### 5.2 The popover

A fixed-position panel anchored under the button, in the shape `.artifacts-pop` already uses
(`public/style.css:1942`) — the panel's own idiom for a list that hangs off a control:

- `position: fixed`, anchored under `#btn-deliver`, above the board (`z-index: 60`), closed on an outside click,
  on Esc, on a second press of the button, and on a board repaint that removes the button (it never is).
- `width: min(560px, 92vw)`, `max-height: min(70vh, 640px)`, `overflow-y: auto` — the size it OPENS at. It is a
  window, not a fixed sheet: the reader drags it by the **head** (never by the body, so text still selects and the
  list still scrolls) and resizes it by the **corner grip**. Min 320×180, max 900×820, and every gesture is
  clamped so no part of the panel leaves the viewport; the margin on every side is 8 px.
- **The first-paint rectangle is computed, not nudged.** `deliverPosition()` measures the button and the panel's own
  box in VISUAL px (`getBoundingClientRect`, `window.innerWidth`) and divides by the page zoom only when it writes
  `style.left/top/width/height`, which are LAYOUT lengths — mixing those two units is what used to open the panel
  off the right edge (and below the foot of the window) at any page zoom above 100%. The height is capped to the
  room below the button, and the whole rectangle is re-clamped on `resize`, size included.
- **The rectangle is remembered in `localStorage`** (`wtgui.deliverables.rect`) when the reader drags or resizes it,
  and restored on the next open only while it still fits the window. One that no longer fits is DROPPED, not
  quietly clamped, so that open is the default under the button.
- A **sticky head**: `17 deliverables — newest first`, a filter input (`filter…`, autofocus), one chip per kind, and
  `✕`.
- The list, then a footer (§5.5).

The head carries **one kind chip per kind** — `🔗 link`, `📄 file`, `🖼 image`, the store's `DELIVER_KINDS` — beside the
filter, because the two are the same narrowing done two ways. All three start pressed (`aria-pressed="true"`): a press
hides that kind from the VIEW and changes nothing in the store, and a second press puts it back. A kind with **no rows
in this list** has no chip — hidden, never greyed — so the header never offers a control that cannot do anything. The
chips are page state (`deliver.kindsOff`) that the paint READS: the header is built once and the whole list re-renders
on every `deliverable` frame, so a state that the paint rebuilt would snap back to all-on mid-scroll. While anything
is narrowed the head says the filtered set — `12 of 30 · link file image`, `199 of 200 · link file` — and names the
kinds still on, so the numbers and the chips never disagree.

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
- An **answer line** (`.dl-opened`, `role="status"`) appears under the meta line after a `200 {open:"handler"}`:
  `opened report.html with explorer.exe — the panel started the opener; it cannot see whether a window appeared`.
  It names what was handed over and which opener took it, which are the two facts the route's 200 carries. It does
  NOT claim a window: a detached `explorer.exe` reports no exit code, so the spawn is the whole of the evidence. A
  later refusal on the same row replaces it, and the refusal's own sentence is never composed by the page.

### 5.3 The three click behaviours

| where | what happens |
| --- | --- |
| the **title** (`.dl-name`) | `POST /api/deliverables/open {seq}` → a **link** opens in Chrome, a **file** or **image** opens in the program this machine associates with that suffix (§6.1). |
| **anywhere else on the row** | the agent's console is opened at the turn that delivered it (§6.2), the popover closes, and the card wears the board's amber flash (`flashHotCard`, `public/app.js:17812`) for 1.3 s so the eye lands on it. |
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
| `Tab` | move across the head's own controls — filter → chips → `✕` — so every chip is reachable; from either edge it closes the popover and returns focus to `#btn-deliver` (it never traps focus) |
| typing / `Backspace` | filter by title, target, agent or project (case-insensitive substring); the active row resets to the first |

`aria-expanded` on the button, `aria-label` on the popover, and the active row carries `aria-selected="true"`.

### 5.5 What happens with 200 entries

- **All of them are painted.** 200 rows is a bounded, small DOM — a few thousand nodes — and virtualising it would buy
  nothing but a scroll-position bug. The cap (§4.4) is what keeps that true; without it, "every deliverable" grows
  without limit and the popover becomes a second job store.
- **Day separators** (`TODAY`, `YESTERDAY`, `2026-11-01`) as non-interactive rows, so a long scroll has landmarks.
- **The filter and the kind chips are the answer to the 200th row**, not scrolling: `markdown` narrows to the three
  reports that mention it in title, path or agent, and the chips narrow the same list to the kinds left on. They
  compose by intersection — a word and a kind both have to match — so neither can widen what the other narrowed.
- **The head and filter are sticky**; only the rows scroll.
- **A delivery that lands while the popover is open** arrives as one SSE `deliverable` event (§7.1); the page re-fetches
  the list, restores `scrollTop` and the active `seq`, and does not steal focus. If the new entry is the active one it
  stays active; otherwise the list simply has one more row above.
- **The cap line appears only at the cap**: `200 kept — older rows are forgotten; the files stay on disk.`

### 5.6 Empty, loading, and error states

- **Empty:** `Nothing has been delivered yet.` plus one valid example in a `<code>` line —
  `DELIVER file C:/path/to/report.html | The report` — the one place the grammar is documented in the page, for the
  reader who wants to tell an agent by hand.
- **Loading:** the head says `reading…` and the body is one dim line; the fetch is a single GET of roughly 80 KB at
  the cap, and there is no spinner theatre for it.
- **Failed:** `could not read the list: <error>` and a `retry` button. A popover that silently shows nothing is
  indistinguishable from an empty one, which is the failure this feature exists to end.

### 5.7 Where the code lives

**A new file, `public/board/deliverables.js`, a classic script** like `public/board/attachments.js` — which means the
`public/app.js` is **not edited at all** for this feature. On main `public/board/` holds only `attachments.js` and
`paste-chips.js`: `hot.js` was deleted when the NOT-RUNNING rotation was removed (`f55fecb`), and its three surviving
functions — `hotRowFor` (`public/app.js:17780`), `hotOpenPath` (`:17790`), `flashHotCard` (`:17812`) — are page
globals inside `app.js`. The new script is loaded after `app.js` (`public/index.html:747`) and before
`update-check.js` (`:750`), so every global it borrows is defined at parse time; at load it only registers the
button's click listener (the button is static markup, exactly like `#btn-human`), and every other call is made at
click time. Its dependencies are existing page globals: `$`/`esc`/`tailPath`/`fmtAgo` (`core/dom-format.js`),
`apiFetch` (`core/transport.js`), `conversations`, `renderConversation`, `assistantSessionFor`, `hotRowFor`,
`hotOpenPath`, `flashHotCard`, `scrollCardUnderBar`, `showBanner`, `keyOf`, `toggleProject`, `humanTextEntry`.

It keeps its own state in a module-level object, not in `state` (`app.js:55`): nothing else in the page reads it, so
adding a `state.deliver` slice would be an edit to app.js for no reader — unlike `state.hotFlash`, which app.js's own
renderer reads at `public/app.js:4762`.

---

## 6. What a click actually opens

### 6.1 The target: Chrome, or this machine's handler

`lib/open-url.js` is the module that already opens things without a shell, and it explains why that matters (a
`cmd.exe /c start` re-parses `&`; `lib/open-url.js:1-15`). **One** function is added beside `openerFor`:

```js
export function chromeFor(url, { platform, env, exists }) -> {bin, args} | null
```

- **Chrome** on Windows, in order: `%CHROME_PATH%` when it is set and names a real file, then
  `%ProgramFiles%/Google/Chrome/Application/chrome.exe`,
  `%ProgramFiles(x86)%/Google/Chrome/Application/chrome.exe`, `%LOCALAPPDATA%/Google/Chrome/Application/chrome.exe`.
  On this machine the first candidate exists. On macOS, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`;
  elsewhere, `google-chrome`. No flags: Chrome reuses its window and opens a tab, so the reader keeps his session.
  **When none is found the link still opens** — through `openerFor` (the OS default browser) — and the route's answer
  says `chrome: false`, which the page turns into one banner line: `Chrome was not found — opened your default
  browser`. A missing Chrome must not become a missing deliverable. (N5: the first draft's `isFile` parameter was
  unused; Chrome is links-only.)
- **A file or image already has its opener.** `openerFor(target)` (`lib/open-url.js:34`) already returns exactly the
  one-argv handoff this needs: `explorer.exe <path>` on Windows, `open <path>` on macOS, `xdg-open <path>` elsewhere.
  A path and a URL are the same handoff to the OS, so the file/image branch calls `openerFor` — no `defaultOpenerFor`
  (M8: the first draft's second resolver was `openerFor` with a different name, which is how two routes drift).
  It is ShellExecute, i.e. *the program this machine uses for that suffix* — `.html` in Chrome, `.pdf` in the reader's
  PDF app, `.md` in whatever owns it. **Deliberately not `editorFor`** (`server.js:103`), the Notepad++ resolver
  `/api/open-path` uses: that route opens a file *to edit it*, and a delivered `.html` is a thing to *look at*. Two
  routes, two intents, and the plan says so where both are defined.
- Both spawn `detached: true, stdio: "ignore", windowsHide: true` and `unref()`, exactly like `/api/open-url`
  (`server.js:4505`): neither `explorer.exe` nor a detached Chrome reports an exit code that means anything, so the
  route answers from the spawn, not from the child.

### 6.2 Which console a row opens

The row carries `thread`, `jobId`, `project` and `treePath`. The open path is HUMAN's own path (`humanShow`,
`public/app.js:17958-17997`), because that is the one function in the page that already knows how to put a specific
turn in front of the reader:

1. `conversations().find(c => c.thread === entry.thread)`. A delivery from an **assistant's own run** is a session, not
   a row: `assistantSessionFor(thread)` → `window.__assistantShowThread(thread)` → `renderConversation(thread)` → the
   float's Chat pane, exactly as HUMAN does for an assistant's question.
2. A board delivery: `hotRowFor(thread)` → `hotOpenPath(row)` (unfolds the project, its root folder and the row —
   `public/app.js:17790`), then unfold the card if it is collapsed.
3. **Page the turn in by JOB ID, not by `turn`**: `state.turnOpen.set(entry.jobId, true)`,
   `state.turnCompact.delete(entry.jobId)`, and `state.turnPage.set(thread, pages - 1 - floor(index / TURNS_PER_PAGE))`
   — the five lines at `public/app.js:17966-17970`. `humanShow` looks a turn up as `t.id === q.turnId` (`:17962`), and
   each turn's `id` is its **job id**; the `turn` counter moves backwards when old jobs are trimmed, so an entry keyed
   by it would open the wrong turn or none (M7).
4. `renderConversation(thread)`, re-query the card (the render replaces the node), `scrollCardUnderBar(card)`, and
   `flashHotCard(thread)` so the reader sees where he landed.
5. The popover closes before the scroll, so it cannot cover the card it just opened.

Three fallbacks, each said in a banner rather than a silent no-op:

- **The turn is gone** (the store keeps 80 jobs/turns): open the thread's newest turn and say
  `that turn is no longer on the board — opened the newest one`.
- **The thread is gone**: open the worktree row from `project` + `treePath`
  (`toggleProject` if needed, then the row's own click) and say `the run that delivered this is no longer on the board
  — opened its worktree`. The file itself still opens from the title; only the agent link degrades.
- **Everything is gone**: `that deliverable's agent and worktree are both gone` — and the target still opens.

That five-step sequence is the *only* duplicated code in this plan, and it is copied into the new module as
`openAgentTurn(thread, jobId)` with a comment naming `humanShow` as the original — **not** extracted. Extracting it
would mean editing `public/app.js`, and §8 says no edit; the first draft said both things at once (M10).

---

## 7. Routes and wiring

### 7.1 The list

`GET /api/deliverables` — read-only, no token (the same convention as `GET /api/jobs`, `server.js:3533`):

```json
{ "version": 1, "cap": 200, "kept": 17, "nextSeq": 18, "at": "…", "entries": [ … newest first … ] }
```

`kept` and `cap` are what the footer reads; `entries` is the array the page paints.

`DELIVER` lines also broadcast one SSE event, so a list open in another tab (or the reader's own) moves without a
reload: `{ type: "deliverable", seq, kind, title, at }` — a one-line `broadcast()` from the store's `onChange` hook,
wired in server.js beside `assistant.todosChanged` (`server.js:1129`). The handler in `public/core/sse.js` is three
lines (re-fetch if the popover is open — §5.5).

### 7.2 The open

`POST /api/deliverables/open` `{ seq }`, authorised with the token: **`authorised(req, config.token)`**, not
`authorised(req)`. `authorised` is `export function authorised(req, token)` (`lib/http/transport.js:136`); called with
one argument it refuses every non-loopback write even when the request carries a correct `x-panel-token`, so a reader
on another machine would get a 403 that looks like a bad token (M1). The two routes this one sits beside —
`/api/open-url` (`server.js:4505`) and `/api/jobs/artifact/delete` (`server.js:4525`) — both pass the token. The page
never sends a path: **the route opens only what the store recorded**, the same rule the artifact delete follows, so a
stray string from a page cannot launch an arbitrary file.

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

The page answers the `200 {open:"handler"}` too, with the two facts that answer carries: the target's name and the
opener's basename, under the row (§5.2). It says no more than the spawn proves — a detached handler reports no exit
code — so the sentence ends `it cannot see whether a window appeared`; the route's classification and its 403/404
sentences are untouched. The audit (`docs/reports/deliverables-open-audit-2026-11-05.md`) measured that branch silent
on 29 of 111 files and 7 of 32 images; `docs/reports/deliverables-open-handler-2026-11-05.md` is the proof against a
`page` served from `public/app.js` and the same store.

### 7.3 Server wiring, in order

Beside the release store (`server.js:1145`):

```js
const deliverables = new Deliverables({ file: config.deliverablesFile, log, trees: panelTrees });
jobs.deliverables = deliverables;
deliverables.onChange = (entry) => broadcast({ type: "deliverable", seq: entry.seq, kind: entry.kind, title: entry.title, at: entry.at });
```

`panelTrees()` (`server.js:1083`) is handed over exactly as `TodoLists` and `ReleaseRequests` get it, and here it has a
stated job: `list()` resolves each entry's `project`/`treePath`/`branch` against the current rows by six-hex tag, so an
auto-rename moves the row with the tree (§4.3, M14). The `deliverBrief` callback (Q5 is decided (a); it is where a
later opt-out flips) is wired beside `jobs.releaseBrief` (`server.js:1150-1156`):

```js
jobs.deliverBrief = () => DELIVER_BRIEF;   // Q5(a): every tree turn. The one-line flip to (b) returns "" unless the project opts in.
```

---

## 8. Every file this work touches

New:

| file | what it is |
| --- | --- |
| `lib/deliverables.js` | `parseDeliverLines`, `normaliseTarget`/`dedupeKey`, the `Deliverables` store (`load`, `save`, `moveCorrupt`, `record`, `list`, `get`, `markMissing`), `DELIVER_KEEP`. |
| `public/board/deliverables.js` | the button listener, the popover, the fetch, the filter, the keyboard model, the three click behaviours, `openAgentTurn`. |
| `test/deliverables.test.js` | §9.1. |
| `tools/verify-deliverables.mjs` | §9.2, `// HARNESS: LIVE GATE` (the runner reads that declaration at `tools/verify.mjs:104-105`). |
| `docs/plan/deliverables-handback.md` | this document. |

Edited:

| file | anchor (main) | change |
| --- | --- | --- |
| `lib/paths.js` | `STATE_FILE_NAMES` at `:54`; beside `releasesFile` at `:190` | add `"deliverables.json"`; add `deliverablesFile`. |
| `lib/jobs.js` | `RELEASE_BRIEF` at `:97`; `measureTree` call at `:1917`; `harvestRelease` at `:1930`; `deliverText` beside `releaseText` at `:2137`; `anchored` at `:2177`; persist map at `:727` | add `DELIVER_BRIEF`; call `harvestDeliverables(j, tree)` after `harvestRelease`; add the method; define `deliverText` **before** the template; append it; persist `deliverHarvested`. |
| `lib/open-url.js` | beside `openerFor` at `:34` | add `chromeFor` only. A file/image is opened by `openerFor`; `safeUrl` and `openerFor` are unchanged. |
| `server.js` | import at `:54`; `panelTrees` at `:1083`; store at `:1145`; SSE hook at `:1129`; GET near `:3575`; POST near `:4505` | construct the store, wire `jobs.deliverables` and `jobs.deliverBrief`, the broadcast hook, and the two routes (`authorised(req, config.token)`). |
| `public/index.html` | button after `:20`; scripts at `:745-750` | the `#btn-deliver` markup; `<script src="/board/deliverables.js"></script>` after `app.js` (`:747`), before `update-check.js` (`:750`). |
| `public/style.css` | after `#btn-human` at `:119`; after `.artifacts-pop` at `:1942` | `#btn-deliver` and the `.deliver-pop` block. |
| `public/core/sse.js` | `connect()`'s handler list at `:62-120` | one `deliverable` listener. |
| `package.json` | `version` and `scripts` | `0.94.0` → `0.98.0` (the landing bump; 0.95–0.97 are anchored on sibling branches) and `"verify:deliverables": "node tools/verify-deliverables.mjs"`. |
| `public/app.js` | — | **no edit.** The module is a classic script that calls app.js's globals at call time; `openAgentTurn` is a copy of `humanShow`'s five lines (§6.2), not an extraction. |

**Landing order.** The four-file blocker is gone: `f55fecb`/`f9f103d` landed, and `public/app.js` has a live writer
from another row **this turn** — which is why the plan needs nothing from it. The implementation re-reads each anchor
against main as it stands then (0.94.0 at this writing; this branch carries the 0.98.0 bump); every anchor above is
text, not just a number.

---

## 9. How it is proved

### 9.1 Unit (`test/deliverables.test.js`, run by `npm test`)

1. **The grammar, and the brief that teaches it**: every row of §2.3 as a separate assertion on `error` and on the
   reason's wording; a title containing a `|`; a quoted path with spaces; `deliver` in lower case; `DELIVERED` not
   matching; a Markdown fence line not matching (parity with RELEASE). Plus **`parseDeliverLines(DELIVER_BRIEF)`
   returns zero markers** — the paragraph a model is told to copy must not parse as a delivery (M4) — the brief's
   `example:` line copied without its prefix parses as a valid marker, and a `<…>` placeholder target is ignored
   rather than refused.
2. **Resolution (B2)**: `C:/x/report.md` stays as written; `docs/report.md` becomes `<tree.path>/docs/report.md`
   **even when `job.worktreePath` names a different directory** (the auto-rename case), and falls back to the job
   fields only when no tree is passed; `..` is resolved and shown; a target over 1024 chars is refused.
3. **Kind validation**: `link` refuses `ftp:`, `mailto:` and a bare path; `image` refuses `.html`; `file` refuses a
   directory by name.
4. **The store**: one good line → one entry with kind/target/title/seq/at/agent/bytes/mtimeMs/tag; a second
   constructor over the same file reads it back (**the restart proof**, the same second-instance rule
   `assistant.json`'s mapper needed); `missingAt` set and cleared.
5. **Dedupe (M11)**: same run twice → one entry, `at` unchanged, title updated; a second run with the same title and
   the same mtime/bytes → **nothing written, `at` unchanged** (a reply that echoes the marker); a changed title or a
   changed mtime → the row updates and becomes newest; a link delivered twice with the same title is a no-op.
6. **Cap**: 201 deliveries → 200 entries, the oldest gone, `nextSeq` never reused, and a reload does not resurrect it.
7. **Corrupt (M6)**: a truncated file logs once and starts empty; the first `save()` leaves
   `deliverables.json.corrupt-*` beside a freshly written file.
8. **A failed write (B1/M5)**: a store whose `writeFileSync` throws (or whose target is a directory) returns
   `saved:false`; `harvestDeliverables` pushes one `⚠`, leaves `deliverHarvested` **unset**, and a second call after
   the fault is cleared writes the entries and sets it.
9. **The settle seam**, driven on `Object.create(Jobs.prototype)` with `deliverables` and `push` — the exact shape of
   `test/release-request.test.js:196-221`: one entry, `deliverHarvested`, one `⇢` line, a second call is a no-op, a
   malformed line leaves the store empty and one `⚠` line. Plus: an **empty** `finalMessage` leaves the mark unset,
   so a later message carrying a DELIVER line is harvested (the restored-live path, §3.2 point 2).
10. **The brief**, on a stub gateway (the 40-line `stubGateway()` in `test/brief-follows-the-policy.test.js:76-110`
    records every submitted `input`): a tree run's input carries `DELIVER_BRIEF`; the assistant's own run
    (`anchorCwd: false`) carries neither it nor the marker.
11. **Read-time resolution (M14)**: store an entry with `tag: "5db421"`; point the provider at a tree whose path and
    branch have both changed but whose tag is the same; `list()` returns the new `treePath`/`branch`/`project`.
    Remove the tree and the stored values stand.
12. **The turn key (M7)**: the store keeps `jobId` and `turn`; a store entry whose `turn` is stale still returns the
    `jobId` the route/click uses, and the page's `openAgentTurn` is asserted to look up `t.id === entry.jobId`
    (`public/app.js:17962`) — the live gate covers the same path end to end.

### 9.2 The live gate (`tools/verify-deliverables.mjs`)

A real panel of its own (`PANEL_CONFIG`, its own port and jobs store, `tools/panel-testkit.mjs`), a stub Runs API that
streams a final message containing two `DELIVER` lines (one good file, one missing file), and headless Chromium over
the page it serves. It asserts, and prints one line per check:

1. `#btn-deliver` sits between `#btn-human` and `#btn-collapse-all`, and `D` opens it while a `d` typed into a reply
   box does not.
2. The settle harvest put exactly one entry in `deliverables.json` beside `jobs.json`, and the card carries the `⇢`
   line and the `⚠` refusal for the missing file.
3. The list is newest-first, the row shows title/agent/project/age, and the target line is the file it was given.
4. **The open route's contract, without launching anything.** The kit boots `server.js` as a child and the route calls
   `spawn` inline — there is no process seam (`tools/panel-testkit.mjs:89-91`: "it can answer HTTP but it cannot spawn
   anything"; M9). So the gate calls `POST /api/deliverables/open` itself with the recorded `seq` and asserts
   `200 {ok, kind, opener}` for a file that exists, `404` for an unknown `seq`, and `404 + missingAt` for a file
   deleted between harvest and click. It **does not click the title**, because a click would launch Chrome or
   Explorer on the test box.
5. Clicking the row opens the agent: the project, its root folder and the row unfold, the card unfolds, the turn is
   paged in, and the card wears the flash.
6. A delivery of the same target from a second run with the same mtime/title updates nothing; a changed file updates
   the row and does not add one.
7. 200 seeded entries paint, the filter narrows them, `End` reaches the oldest, and the cap line appears.
8. `missingAt`: a file deleted between harvest and click answers 404, the row says `gone`, and a restored file clears
   it on the next click.

The **red proof** is the same gate run against a `git archive` of the base: every check fails by name because
`#btn-deliver` and the route do not exist there. The mechanism already exists — `startPanel({ root })`
(`tools/panel-testkit.mjs:106`) boots a different checkout, so the export needs no second worktree (N11: the first
draft pointed at a `.agentboard` notes folder that is not in the repo).

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
- **No per-project switch today.** Q5 is decided (a): the paragraph rides every tree turn. A flip to (b) is the one
  `jobs.deliverBrief` line in `server.js`, not a new mechanism.
- **No badge, no unread marker.** Both are a queue's language, and this is an archive.
- **No changelog entry.** The render lands with the next release's bump (the repo's rule), not with this plan; the
  version bump itself is 0.98.0 and travels in this PR.
- **No implementation this turn.** Only this document and the version bump changed; `public/app.js` has a live writer
  from another row.

---

## 11. The decisions

All five are settled. 1–3 were answered in the session; 4–5 were left to the plan's default and are now decided as
recommended (2026-11-03). Each records the place a later flip changes, so a reversal is a one-line edit, not a new
design.

1. **The button's word.** — **DECIDED: `DELIVERABLES`.** The alternatives offered were `DELIVERED` and `DELIVER`;
   §5.1 carries the label and its cost (the longest word in the header).
2. **A target delivered twice.** — **DECIDED: one row, updated in place.** §4.3 is the design: `seq` is the identity
   and never changes; a genuinely new delivery (`at`, `mtime` or title changed) moves the row to newest; a repeat that
   echoes the same marker with the same title and the same file signature writes nothing.
3. **A malformed or missing `DELIVER`.** — **DECIDED: a console line on the card only.** §2.3 and §3.2 already stand:
   one `⚠ DELIVER was NOT recorded — <reason>` line, nothing in the store, and the line survives a reload.
4. **`image`.** — **DECIDED: (1) a glyph and the OS image viewer.** No new route and no bytes through the panel; the
   kind is the same `stat` + suffix check as `file` and the same `openerFor` (§2.2). A flip to a row thumbnail is a
   change at the `image` case in `lib/deliverables.js`'s kind handling plus a read-only
   `GET /api/deliverables/thumbnail?seq=` route that serves only a recorded image path (capped and cached) — that
   route is the whole reason it is deferred, not the rendering.
5. **The `DELIVER` paragraph.** — **DECIDED: (1) every tree turn.** The real cost, corrected from the first draft:
   `create()` is also the reply path (`lib/jobs.js:1940`, `reply` at `:1966`), so the paragraph rides on **every
   message in a tree conversation**, seven lines per turn, not once per spawn. A flip to (2) — only a project that
   opts in with `deliverables: true` — is the single `jobs.deliverBrief` line in `server.js` (§7.3): return `""` for a
   project without the flag. Nothing else in the plan changes.
