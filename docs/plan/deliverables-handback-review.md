# Deliverables handback — the review

**Reviewed at `0d4e857` (`package.json` 0.87.0), in the tree the plan was written in.** Every anchor below was
re-read in this tree, not taken from the plan. Where the plan's number is stale I give the line the code is on now.
The plan was measured at `4f660d2`; this branch is 9 commits behind `origin/main` (0.91.0), and the live worker whose
tree the plan waits on (`wtgui/three-ui-changes-main-is-8c936e`) already has unlanded changes to all four of the files
the plan defers — including two anchors the plan names (see M2, M3).

Severity: **blocker** = the build fails or the plan is wrong; **must-fix** = it will work but the shape is wrong;
**nit** = prose, drift or a choice worth recording.

---

## 1. What is actually verified (so this review does not relitigate it)

These load-bearing claims hold in this tree:

- `harvestRelease` is at `lib/jobs.js:1930`, called at `lib/jobs.js:1917` inside `measureTree`, immediately before
  `this.finalise(j); this.emit(j);` — exactly the seam the plan names.
- `j.finalMessage` is set in `settle()` (`lib/jobs.js:2718`) and in the reconcile path (`lib/jobs.js:2950`), both
  before the `void this.measureTree(j)` calls (`lib/jobs.js:2756`, `:2959`). A DELIVER harvest at the seam reads a
  message that is already in memory; it needs no second read of the transcript.
- `parseReleaseLines` (`lib/worktrees.js:107-137`) trims each line, matches `/^RELEASE\b/i`, splits on the **first**
  pipe, and returns `{target, why, raw, error}` with `error` set rather than dropping the line. `/^DELIVER\b/i` would
  therefore not match `DELIVERED` (no word boundary between `R` and `E`), and a title containing `|` survives because
  only the first pipe is the separator.
- `statePaths()` is at `lib/paths.js:169`; `stateDir` is the directory of `jobs.json`, `releasesFile` is at `:190`,
  and `STATE_FILE_NAMES` is at `:54`. The one-time migration copies every name in `files` except `jobs.json` last
  (`lib/paths.js:440-447`), so adding `deliverables.json` there is necessary and sufficient for the legacy copy.
- `server.js:270` does `Object.assign(cfg, statePaths(cfg))`, so `config.deliverablesFile` will resolve the same way
  `config.releasesFile` does at `server.js:1089`.
- The held-files dependency is **real**: `git diff --stat main..HEAD` in
  `.worktrees/three-ui-changes-main-is-8c936e` shows `public/app.js` 393, `public/index.html` 28,
  `public/style.css` 43, `server.js` 112 — all four unlanded.
- On this base, `public/index.html:22` is `#btn-human` and `:23` is `#btn-collapse-all`; inserting a new button after
  `:22` does land between them.
- `D` is free: no `key === "d"`/`"D"`, `code === "KeyD"` or `keyCode 68` binding exists anywhere under `public/**`.
- Chrome exists at `C:/Program Files/Google/Chrome/Application/chrome.exe`, as the plan says.

---

## 2. Blockers

### B1. The "existing `measureTree` try/catch" does not exist, and the plan's own `save()` sketch throws

**Anchor:** `lib/jobs.js:1774-1920` (the whole `measureTree`), `lib/jobs.js:1802`, `lib/jobs.js:2756`,
`lib/jobs.js:2959`; plan §3.2 point 4, §4.4.

The plan says `record()` "never throws into `measureTree` (every branch returns an error object, and the whole call is
inside the existing `measureTree` try/catch)". There is no try/catch in `measureTree`: the only `.catch` is the git
`pexec(...).catch(() => null)` at `lib/jobs.js:1802`, and the function ends

```js
    this.harvestRelease(j);
    this.finalise(j);
    this.emit(j);
    return tree;
```

(`lib/jobs.js:1917-1920`). Both fire-and-forget call sites are `void this.measureTree(j);` (`lib/jobs.js:2756`,
`:2959`) with no `.catch`; only the lost-run sweep at `:3269` attaches one. A throw in
`Deliverables.record()`/`save()` is therefore an unhandled rejection, not a line on the card.

That matters because the plan's own `save()` sketch (§4.4) is `writeFileSync(tmp, …); renameSync(tmp, this.file);`
with no try/catch — unlike `ReleaseRequests.save()` (`lib/worktrees.js:263-279`), which wraps the same two calls and
logs the failure. A full disk, an EPERM on the state folder, or a locked `deliverables.json` throws straight out of the
settle path. The plan's stated safety property is the opposite of what its code does.

**Severity: blocker.** Either wrap the harvest body in `try/catch` (and keep the mark unset on failure), or copy
`ReleaseRequests.save()`'s catch, or both; and correct the §3.2 claim.

### B2. A relative target resolves against a path the same pass has already proved stale

**Anchor:** `lib/jobs.js:2056` (`j.worktreePath = made.path` is the only assignment), `lib/jobs.js:1809-1828`
(`locate`/`tree.path`), `lib/jobs.js:1803-1808` (the auto-rename comment); plan §2.3, §4.2 (`treePath`), §7.3.

The plan resolves a relative target against `job.worktreePath || job.ownerPath || job.cwd` and calls that "the same
resolution `TodoLists.harvest` uses at `lib/todos.js:588`". The order matches `TodoLists.harvest`, but the premise does
not: `TodoLists.harvest` only keys a list, while DELIVER must `stat` a file. `measureTree` begins by locating the tree
*now* precisely because "a finished tree is auto-named after its agent — the panel moves the directory and renames its
branch — and a measurement that lands inside that move reads a path that is already gone" (`lib/jobs.js:1803-1808`).
`j.worktreePath` is set once at creation (`:2056`) and is not updated by that move; the authoritative path is
`tree.path`, already computed in this pass by `locate()` (`:1809-1828`).

So the common research-report case — a worker writes `docs/report.html`, the panel auto-names the tree at settle — is
refused with `no such file` while the file sits one directory over. The same stale path is written into the entry's
`treePath` and is what the open route later `stat`s, so the row keeps 404ing and stamping `missingAt` on a file that
exists. This is the one place the plan could have used the pass's own read and does not.

**Severity: blocker.** Pass `tree.path` (or `tree` itself) into `record()` and resolve against it first; keep the job
fields as the fallback for the no-tree case.

### B3. `deliverText` is used before it is defined

**Anchor:** `lib/jobs.js:2177-2178`; plan §3.3.

The plan's template change is

```js
${releaseText ? `\n\n${releaseText}` : ""}${deliverText ? `\n\n${deliverText}` : ""}
```

but `create()` has no `const deliverText = …` anywhere, and §3.3 never says where it comes from or how it is gated. As
written the snippet is a `ReferenceError` on every spawn; a literal implementation fails at the first run, not at a
review. (It also needs the same `where && opts.anchorCwd !== false` gate as `releaseText`, or a no-tree turn gets a
paragraph telling it to deliver a file into a tree it does not have.)

**Severity: blocker.** Add the assignment next to `releaseText` at `lib/jobs.js:2137` and state its gate.

---

## 3. Must-fix

### M1. `authorised(req)` is the wrong precedent — the neighbouring routes pass the token

**Anchor:** `server.js:3527` versus `server.js:4449`, `server.js:4469`; plan §7.2.

The plan says `authorised(req)` is "the POST convention every mutating route uses, `server.js:3527`". The route at
3527 does call it with one argument, but the routes this feature sits beside — `/api/open-url` (`server.js:4449`) and
`/api/jobs/artifact/delete` (`server.js:4469`) — call `authorised(req, config.token)`. `authorised` is
`export function authorised(req, token)` (`lib/http/transport.js:136`); with `token` undefined it refuses every
non-loopback write even when the request carries a correct `x-panel-token`. The new open route must pass
`config.token`, or a reader on another machine gets a 403 that looks like a bad token.

**Severity: must-fix.**

### M2. The worker the plan waits on deletes `#btn-hot` and `#btn-aggressive`

**Anchor:** `public/index.html:21-23` in this tree; `public/index.html:20-21` on
`wtgui/three-ui-changes-main-is-8c936e`; plan §2, §5.1.

The plan restates the ask as a button "beside NOT-RUNNING (`#btn-hot`) and HUMAN (`#btn-human`)", and justifies the
placement with "the three waiting/handing-over controls together" and "the two buttons beside it". The held branch's
`public/index.html` deletes both `#btn-hot` and `#btn-aggressive`; after it lands the row is Assistant, HUMAN,
Collapse all (lines 20-21 of that version). The insertion point after HUMAN still works, but the ask, the "three
controls" rationale, the "two buttons beside it" sentence and the "no badge" argument about a number meaning
"answer me" are all measured against a header that will not exist. The button's title attribute and §5.1 should be
rewritten against the landed header, not the old one.

**Severity: must-fix** (the position survives; the text that explains it does not).

### M3. The worker also deletes `public/board/hot.js`, and the plan's anchor points into it

**Anchor:** `public/board/hot.js:97`; the held branch's `public/board/hot.js` is deleted and its functions live at
`public/app.js:17780` (`hotRowFor`), `:17790` (`hotOpenPath`), `:17812` (`flashHotCard`); plan §5.7, §6.2.

`git ls-tree HEAD public/board/hot.js` on `wtgui/three-ui-changes-main-is-8c936e` is empty, and its `index.html` drops
the `/board/hot.js` script tag. The plan's §5.7 calls `public/board/hot.js` "a classic script like" the new module and
§6.2 anchors `hotOpenPath` at `public/board/hot.js:97`; neither will exist after the landing the plan itself orders.
The functions do survive as globals in `app.js`, so the feature still works — but the file reference and the line
anchor cannot be "re-read then" because the file is gone. Name the functions in `app.js`, not the deleted module.

**Severity: must-fix.**

### M4. The brief's own template line is a refused DELIVER marker

**Anchor:** `lib/jobs.js:97-102` (the RELEASE precedent), `lib/worktrees.js:107-137` (the parser); plan §2.1, §3.3.

The paragraph the plan puts in every tree spawn contains the literal line

```
  DELIVER <link|file|image> <target> | <title>
```

After `trim()` it starts with `DELIVER` and is matched by `/^DELIVER\b/i`; the first word after the marker is
`<link|file|image>`, which is not `link`/`file`/`image`, so the parser refuses it out loud. A model that echoes the
template it was just given — the ordinary behaviour the plan relies on for the marker itself — puts a
`⚠ DELIVER was NOT recorded — "<link|file|image>" is not one of link / file / image` line on a perfectly successful
turn. Because DELIVER is unconditional in every tree run (while RELEASE is per-project), this is the common case, not
an edge. The RELEASE brief has the same hole (`RELEASE <this worktree path> | …`), so "parity with RELEASE" reproduces
a known noise source rather than solving it.

**Severity: must-fix.** Either show a concrete valid example in the brief (`DELIVER file C:/…/report.html | …`) or
have the parser ignore a target that is exactly a `<…>` placeholder; the plan's unit list should test the brief's own
line.

### M5. The harvest mark is set before the write, so a failure loses the delivery for good

**Anchor:** plan §3.2 (the `harvestDeliverables` sketch); `lib/jobs.js:1931-1935` (the
`releaseHarvested` precedent it copies).

`harvestDeliverables` sets `j.deliverHarvested = true` before `this.deliverables.record(...)`. If `record()` throws
(B1) or `save()` fails, the mark is already set; the job is persisted with `deliverHarvested: true`, and no later
`measureTree` will retry. The reference implementation is careful about exactly this: `ReleaseRequests.save()` catches
its own write error, so `record()` completes even when the file cannot be written. The plan's store must either catch
and return a refusal (with the mark unset) or the mark must move after a successful `record()`.

**Severity: must-fix** (silent, permanent data loss on the one failure the plan says it handles).

### M6. The corrupt file the plan promises to preserve is not in the `save()` it sketches

**Anchor:** plan §4.4 (`save()`) versus §4.5 (corrupt file); `lib/worktrees.js:263-279` (the precedent).

§4.5 says a file that cannot be parsed is "moved aside, not overwritten: the first `save()` renames it to
`deliverables.json.corrupt-<epoch-ms>`, logs one line, and writes a fresh file." The §4.4 `save()` sketch does
`writeFileSync(tmp, …); renameSync(tmp, this.file);` — which overwrites the corrupt file and destroys the evidence the
plan says it is preserving. It also omits `mkdirSync(path.dirname(this.file), { recursive: true })` and the try/catch
that `ReleaseRequests.save()` has. The stated behaviour has to appear in the code sketch, or the sketch has to say
where it lives.

**Severity: must-fix.**

### M7. The page's turn identity is the job id, not the `turn` counter

**Anchor:** `public/app.js:17877` (`conv.turns.find((t) => t.id === q.turnId)`), `public/app.js:1526-1546`
(`conversations` groups jobs; the comment at 1538-1540 says `turn` is `siblings.length + 1`), `public/app.js:1859`
(`state.jobs.get(turnId)`), plan §4.2 (`turn: 1`), §6.2 step 3.

The plan's store records both `jobId` and `turn`, and §6.2 step 3 says `state.turnOpen.set(turnId, true)` without
saying what `turnId` is. The page finds a turn by `turn.id`, which is the **job id** (`state.jobs.get(turnId)` at
`public/app.js:1859`; each turn is a job). `j.turn` is a per-thread counter that moves backwards when old jobs are
trimmed (the comment at 1538-1540 documents exactly that), so an entry paged by `turn` opens the wrong turn or none
after a trim. The entry's `jobId` is the right key; `turn` is display-only and should be labelled that way.

**Severity: must-fix** (the click path is one of the three behaviours the plan exists to deliver).

### M8. `defaultOpenerFor` is `openerFor` under a new name

**Anchor:** `lib/open-url.js:34-38`; plan §6.1, §8.

`openerFor(url, platform)` already returns `{bin: "explorer.exe", args: [url]}`, `{bin: "open", …}` or
`{bin: "xdg-open", …}` — exactly what the plan's `defaultOpenerFor(target, { platform })` returns. The plan says "no
change to `safeUrl` or `openerFor`" and then adds a second function with the same body. Only `chromeFor` is new; the
file/image path should call `openerFor`, or the plan should say why the duplicate exists.

**Severity: must-fix** (the shape is wrong; a second opener resolver is how two routes drift).

### M9. The live gate's "process seam" does not exist

**Anchor:** `tools/panel-testkit.mjs:89-95` (the kit "can answer HTTP but it cannot spawn anything"), `server.js:4458`
(the route calls `spawn` directly); plan §9.2 item 4.

§9.2 says "the spawn is observed through the testkit's process seam, not by launching Chrome on the test box". There is
no process seam: the kit boots `server.js` as a child (`tools/panel-testkit.mjs:147`) and the route calls
`spawn(bin, args, { detached: true, … })` inline, with no injectable opener. A gate that runs against the real panel
will launch Chrome/explorer on the test box, which the plan explicitly forbids. Either add an explicit seam in
`server.js` (a config/env opener the gate can point at a recorder — a held file, so it belongs in the landing order) or
change item 4 to assert the route's 200/404 contract and leave the spawn unobserved.

**Severity: must-fix** (the proof cannot be built as written).

### M10. The plan both edits and does not edit `public/app.js`

**Anchor:** plan §5.7 and §8 ("public/app.js … **no edit**") versus §6.2 ("extracting it means editing
`public/app.js` … phase 2 starts with that extraction or copies the five lines").

`public/app.js` is in the held set and §8 lists it as "no edit"; §6.2 then makes the `openAgentTurn` extraction the
first thing phase 2 does, which is an edit. The two cannot both be the plan. Since §8's landing order already defers
app.js until the worker lands, the only consistent choice with "no edit" is to copy the five lines
(`public/app.js:17881-17885`) into the new module with a comment naming `humanShow`; if the extraction is wanted, §8
must say so and the held-set sentence must change.

**Severity: must-fix.**

### M11. The paragraph rides on every turn, not every spawn

**Anchor:** `lib/jobs.js:1940` (`create` is also the reply path), `:1966` (`reply: Boolean(opts.reply)`), `:2044`
(the worktree cut is skipped for a reply), `:2207` (the only `opts.reply` gate is a note), `:2137`/`:2177` (the
`releaseText`/`anchored` computation is not gated on reply); plan §3.3, §11 Q5.

The plan's Q5 asks about "the `DELIVER` paragraph in every spawn" and §3.3 says it is unconditional for a tree run.
`create()` is called for replies as well as spawns; `releaseText`, `todoText` and `anchored` are recomputed on every
call, and `opts.reply` only skips the worktree cut and a card note. So a six-line paragraph is appended to **every
message in a tree conversation**, not once at the spawn — the prompt cost the question is about is per-turn and grows
with the thread. The default may still be right, but the question must be asked with the real cost, and the
implementation should decide explicitly whether replies carry it.

**Severity: must-fix** (the open question is misstated; the default's cost is not the one described).

### M12. The restart rationale is not what the restore loop does

**Anchor:** `lib/jobs.js:640-663` (only running/starting/waiting jobs are pushed to `restored`), `:678`
(`for (const j of restored) void this.measureTree(j)`), `:1868`/`:1874` (two `readTree()` calls inside one
`measureTree`); plan §3.2 points 1 and 2.

§3.2 says a restart "re-reads an old run's final message, re-stats its files, and — if the reader has since moved one
— prints a false `⚠ no such file` on a card that settled days ago". The restore loop only marks jobs whose status was
`running`/`starting`/`waiting` as `restored`, and only `restored` is re-measured at boot; a settled job is never
re-measured at boot, so that failure mode cannot happen. Point 2 also calls `lib/jobs.js:1871` a "re-read on a rename"
and a second `measureTree`; it is the second `readTree()` inside the same `measureTree` (1868, 1874), not a second
invocation. The persisted mark is still reasonable (a second `measureTree` in one process, and a live job that settles
after a restart), but the plan's stated reason is not the code's behaviour.

**Severity: must-fix** (a load-bearing guard justified by a failure that cannot occur as described).

### M13. "The page's only bare-letter shortcut is H" is false

**Anchor:** `public/assistant.js:4166-4176` (bare `A`/`a` → `toggleAssistant(true)`, guarded by `inTextField`),
`public/app.js:18089-18096` (bare `H`/`h`, `e.repeat` guard, `humanTextEntry`); plan §5.1.

`D` is free — no `d`/`D` binding exists under `public/**` — but the justification is wrong: the assistant opens on a
bare `A` as well as `H`. That matters because the plan says D is safe *because* only H is bound; the real precedent
is two bare letters with two different guards (`inTextField` for A, `humanTextEntry` for H). The plan should cite the
actual precedent (and copy HUMAN's `e.repeat` check, which its D description omits), not a page-wide claim that a grep
contradicts.

**Severity: must-fix** (the claim is the whole argument for a bare key).

### M14. The store's `trees` provider has no stated job, and `treePath` is never re-resolved

**Anchor:** `server.js:1027` (`panelTrees`), `server.js:1089` (how `ReleaseRequests` uses it), plan §7.3/§4.2.

§7.3 constructs `new Deliverables({ file, log, trees: panelTrees })` and says "a delivery's project is resolved by
the same list of trees every other store uses, and a rename moves it with the row." But §4.2 stores `project`,
`treePath` and `branch` **at harvest**, and §4.3's update list never re-resolves them; nothing in the plan says what
the store does with `trees`. `ReleaseRequests` uses its provider to *resolve a marker target* at record time
(`lib/worktrees.js:296-311`), which is a different job. Either the entry should store a tree key and resolve
project/treePath at read time through `trees`, or the constructor should not take a provider it never uses. As
written, "a rename moves it with the row" is not a behaviour the design implements.

**Severity: must-fix.**

---

## 4. Nits

- **N1.** Plan §4.1 calls `statePaths()` "`lib/paths.js:190`"; `statePaths` starts at `:169` and `:190` is
  `releasesFile` inside it. The §8 row is right; the §4.1 parenthetical is not. **nit**
- **N2.** Plan §6.2 cites "the five lines at `public/app.js:17890-17895`"; they are `:17881-17885`, and `humanShow`
  ends at `:17914`, not `:17912`. **nit**
- **N3.** Plan §1.2 cites `lib/jobs.js:1887` for the TODO harvest; it is `:1889`. Plan §2.3 cites `:735` for the
  120-line tail; it is `:749`. **nit**
- **N4.** Plan §5.5 says "no spinner theatre for 40 KB"; 200 entries with a full absolute target each are closer to
  80 KB. **nit**
- **N5.** `chromeFor(url, { platform, env, isFile })` — `isFile` is unused; Chrome is links-only. **nit**
- **N6.** The dedupe key lower-cases file paths. On Windows that is right; the plan also promises macOS/Linux openers
  (§6.1), where `/tmp/A` and `/tmp/a` are different files and would collapse into one row. `pathKey` in this repo
  lowercases unconditionally, so it is the house convention — say so rather than implying it is correct everywhere.
  **nit**
- **N7.** Plan §4.4 says `load()` brings an oversized file "to the current cap on the next boot"; `load()` slices in
  memory only, and the file is not rewritten until the next `save()`. **nit**
- **N8.** §8 lists `lib/deliverables.js` in both the "New" and "Edited" tables. **nit**
- **N9.** §1.1 says "the store keeps 80 conversations, `KEEP_JOBS`"; `KEEP_JOBS = 80` is jobs/turns
  (`lib/jobs.js:76`), not conversations (threads). **nit**
- **N10.** The D handler description omits `e.repeat`; the HUMAN handler it says it copies has it
  (`public/app.js:18092`), and a held D otherwise toggles repeatedly. **nit**
- **N11.** §9.2's red-proof recipe points at "`.agentboard`'s state-file notes"; `.agentboard` does not exist in
  this checkout or the repo root. The mechanism it needs already exists: `tools/panel-testkit.mjs:107` boots a
  different `root` (a `git archive`), so cite that. **nit**
- **N12.** §3.1 says the return shape is "the same" as `ReleaseRequests.record`; that one returns
  `{requests, refused, lines}` (`lib/worktrees.js:317`), the plan's returns `{added, updated, refused, lines}`. Not
  the same; harmless, but the sentence is false. **nit**
- **N13.** `j.delivered = { added, updated, refused }` is set but not added to the `schedulePersist` map, so it dies
  on restart; and `refused` is an array of `{raw, error}` in the precedent, not a count. **nit**
- **N14.** §4.1 opens "The reader's `logs/` is the folder the job store lives in"; in this install the job store is
  `~/.wag/state/jobs.json` and `~/.wag/logs/` holds the server logs, which the next sentence says. The first sentence
  is the one a reader quotes. **nit**
- **N15.** §9.2 cites `tools/verify.mjs:8` for the runner's discovery; the declaration is read at `:104-105` and the
  comment at `:10`. **nit**

---

## 5. The two open questions

**Q4 — `image` as a glyph plus the OS viewer (default a).** The default is the right one and the code supports it:
the reader's ask is "a file opens in whatever this machine uses for that suffix", which is the OS handler, and the
panel has no route that serves an arbitrary local file. A thumbnail would need a new file-serving surface, a cap and a
cache — a security decision of its own, correctly deferred. The glyph is a one-line branch on `kind`. Nothing here
blocks; the question is taste, and the plan should say the default is recommended rather than merely "open".

**Q5 — the paragraph in every tree spawn (default a).** The default is defensible, but the question is misstated:
the paragraph rides on every `create()` call, including replies (M11), so the cost is per-turn. If the reader wants
the low-prompt-cost option, (b) is cheap and already has a shape: a project flag checked by a `deliverBrief(opts)`
callback, exactly as `jobs.releaseBrief` is wired at `server.js:1094-1100`. The plan should put the real cost in
front of the reader (six lines × every message in every tree conversation) before asking for (a).

---

## 6. Verdict

**NEEDS CHANGES — clear B1, B2, B3, M1, M4, M5, M6, M7, M9, M10, M11, M12, M13 and M14 before implementing; M2/M3 and
the nits are re-anchoring and prose that must be corrected when the held branch lands.**
