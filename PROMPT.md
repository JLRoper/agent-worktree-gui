# PROMPT — close the four console-repaint gaps the flicker tree left open

Read this file first; it is the whole brief, and there is no second task in this tree.

Base: `main` @ `81496d9` (0.18.0), cut 2026-10-29. Branch: `wtgui/fix-console-repaint-gaps-6a695c1`.
This brief and everything measured in it were read at that sha. A number you did not read yourself is a claim, not a fact.

## Why this tree exists

`wtgui/catch-the-console-flicke-579251` was deleted on 2026-10-29 after #78 (`d63971f`) landed its fix. Four things that
tree measured were left open; two are reader-visible bugs and two are test/harness gaps. Fix those four. Do not re-open
the flicker work itself, which is on main, and do not replay anything from the deleted branch.

## Baseline, measured on this tree today

`npm test` at `81496d9`: **301 tests, 300 pass, 1 fail, 93.3 s**.

The single failure is item 4 below — `test/push-guard.test.js:179`, "an env-granted push neither asks the panel nor
parks", **6222 ms** against the `r.ms < 2500` assertion at `:205`. Run alone, the same test passes at **2325 ms**
(93 % of its own budget), so it is on the edge even solo. Nothing else in the suite failed.

## The four items

### 1. The 🌊 stream toggle does not repaint the card

- `public/app.js:5955-5961` — `setStreamMode()` writes the localStorage key and calls `renderConversation(thread)`.
- `public/app.js:6903` — `renderConversation` returns early (`paintCardMeta(el, conv)` only) when
  `el.dataset.sig === conversationSignature(conv)`.
- `public/app.js:6685` onward — `conversationSignature()`'s returned array carries
  `thinkingOn(conv.thread) ? "t" : "-"` and has no `streamOn` term, although `streamOn(thread)` (`:5946`, a
  localStorage read) decides which console renderer the card uses.
- Effect: the press changes state, asks for a repaint, and the repaint concludes nothing changed. The card flips only
  when an unrelated event moves the signature. The 🧠 button beside it works precisely because its state is in that
  array; lane B's `tools/verify-stream-mode.mjs` measured the same gap independently.
- Expected change: one term in that array (e.g. `streamOn(conv.thread) ? "s" : "-"`), placed with the other
  reader-choice terms, so a press rebuilds the card once and the existing scroll/caret restoration applies.

### 2. Rows re-cut by `groupLines()` lose their `data-lid`

- Writers stamp the id: `public/app.js:1207` (text lines) and `:1876` (tool lines) both emit `data-lid`.
- `public/app.js:1285-1300` — `groupLines()`' `read()` rebuilds each line as `{ kind, text }`, plus a `fold` stamp when
  a fold note is present and a swap for `data-lpair` diff rows. It never reads `data-lid`.
- Two live paths depend on the id: `paintTypedLines()` finds rows by `[data-lid]` (`:6060`) to finish a line word by
  word, and the append path looks up `existing` by `line.lid` (`:7105`) so a `"set"` update replaces the text in place
  (`:7107-7108`) instead of appending a new row.
- Effect: once a burst is re-cut from the DOM (a new call appended to a group, `storeOffsetsBefore`, any rebuild), the
  rows come back anonymous — a later `"set"` update appends a duplicate line instead of replacing the text, and a
  half-typed line can no longer be found to finish. The reader sees a doubled row or one stuck mid-word.
- Expected change: carry the id through `read()` (including both halves of a diff pair) and restore it wherever the
  line element is re-created, so identity survives a rebuild.

### 3. `tools/verify-console-flicker.mjs` does not exercise the other repainters

- `tools/verify-console-flicker.mjs:856` says it in its own words: the run is a scripted stub gateway, and
  "Approvals, questions, status flips and title landing were not exercised, though by the signature they are the same
  kind of repainter as a deliverable."
- Expected change: add phases for an approval arriving mid-turn and a status flip (running → done) with the console
  scrolled away from the bottom, asserting the same property the deliverable phase asserts — the line the reader was
  reading stays put. Keep the existing phases and their thresholds; do not replace the stub with a live gateway.

### 4. `test/push-guard.test.js`'s 2.5 s budget measures the host, not the guard

- `test/push-guard.test.js:179` is the test, `:205` is `assert.ok(r.ms < 2500, ...)`. Today: 6222 ms under the full
  suite, 2325 ms alone. Each `git`/`sh` spawn costs about a second on this Windows host, so a wall-clock bound of
  2500 ms is a flake generator — it is the repeat offender named in this repo's own brief-doctrine notes.
- Expected change: make the assertion say what it means — measure an ungranted/baseline path in the same run and
  compare against it, or raise the bound to a number you measured and write that measurement in the test. Do **not**
  delete the assertion, skip the test, or loosen what it proves: a granted push must still neither ask the panel nor
  park, and the bypass line must still be on stderr.

## Endpoint — one, and it is this

**Commit the work on this tree's branch and report the SHA.** Do not push, do not create a remote branch, do not open a
pull request and do not merge into `main`: this tree is LOCAL-ONLY and the reader decides when it lands. If a version
bump is needed for a later push, say which level you would apply and why rather than leaving it implicit.

## Verification bar

- `node --check server.js` and `node --check public/app.js` — clean.
- `npm test > "$TMPDIR/npm-test.log" 2>&1 < /dev/null` run in the FOREGROUND with stdin redirected, then read the
  counts. Expected: 301 tests, 0 failures. The suite has known load-dependent flakes (`test/verify-sweep.test.js` has
  an 85 s timeout under parallel load and passes alone in about 10 s, and item 4 is one). If something fails, run that
  file alone and quote both numbers — never weaken a gate to get green, and never report only the green run.
- `PANEL_PLAYWRIGHT_ROOT="C:/Users/roper/AppData/Roaming/npm" node tools/verify-console-flicker.mjs < /dev/null` —
  quote the check counts. Without the variable it prints BROWSER-HALF-NOT-RUN and exits non-zero; that is a missing
  install, not a broken change. `VERIFY_KEEP=1` keeps its sandbox (own port, own `PANEL_CONFIG`, store, logs).
- Items 1 and 2 are judged on the served page, not on the diff: start a panel from this tree on a spare port with its
  own `PANEL_CONFIG`, press 🌊 on a live card, watch a burst grow and a group get re-cut, and say what the console did.
  A green unit test is not evidence that the card repainted.

## Do not touch

- `main`, checked out at `C:/ProjectDevelopment/agent-worktree-gui` and serving the reader's panel — no `checkout`,
  `reset`, `merge` or `stash` in it, and leave its untracked files (`config.json`'s ` M` state, `config.7330.json`,
  `.kilo/`, `CODE_REVIEW.md`) exactly as they are.
- Any other tree or branch: `add-a-per-row-refresh-bu-51ab7d`, `i-really-like-these-opti-2370e9`,
  `move-local-main-onto-origin-main-47786e`, `playwright-lane-a-long-t-7dbdfb`,
  `playwright-lane-b-stream-f1411d`, `delete-finished-worktree-and-branch-refs-3440e4`, and the scratch tree under
  `C:/Users/roper/AppData/Local/Temp/wtgui-429-control-1MjsdW`.
- Both stashes (`stash@{0}`, `stash@{1}`), and this tree's own branch or directory — do not rename or remove either.
- Stop conditions in their own right, not numbered steps: no `git push`, no `gh pr create`, no `gh pr merge`, no
  `git reset --hard` outside this tree, no force-delete of a branch.

## Report back

The commit SHA; one line per item with the file:line you changed; `npm test` counts before and after; the verifier's
check counts; and what the page did when you pressed 🌊 and watched a group re-cut. Quote the commands you ran.
"Done" is not a report.
