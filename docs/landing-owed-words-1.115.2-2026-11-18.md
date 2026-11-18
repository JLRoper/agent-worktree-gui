# Landing: the hold counts owed words, not characters (1.115.2)

PR #787 merged into `main` as `dd298a66`. The console's reasoning hold asked whether a segment had any unshown
character, and `advance()` ends a release at the last character of the last word - so a frame the wire ended with a
space kept that space unshown for ever, and the hold waited on a character no tick could release.

## The defect

Two places read the same wrong question.

**The hold.** `pendingBefore` (`public/core/type-stream.js`) returned true while any character of a segment ahead of
the call was undrawn. A paragraph whose last token was followed by a space never finished, so a tool call behind it
waited for a tick that could not come and the turn went only at its own two-minute fence. The console sat frozen for
the length of the fence and then took the whole turn in one frame.

**The head of the queue.** The same character test stood at the head of the queue: a segment one space short was
handed back on every tick, so no paragraph behind it typed and the clock never stopped.

## The fix

One predicate answers both, and `forgetOldest()` has always used it: a segment is complete when it owes no WORD,
whatever whitespace trails it. `owesWord()` now decides `pendingBefore`, and a segment whose remaining text is only
whitespace is complete.

The order rule is untouched. A call still waits for every segment stamped before it, by `(at, seq)` and by the
caller's floor; only "still being written" changed, from a character to a word. `public/board/console.js` carried a
comment that described the hold's question as "owed a character" and now says what it waits on.

## The numbers

`tools/measure-console-jitter-merge.mjs`, 32 s window, one fixed script whose own text frames end in a space, which
is how the defect reaches a real page:

- before (`6d723343`): the console sat at 2 rows for 30 s while the hold grew 18 -> 163 frames, then the whole turn
  landed in one frame - 3606 px biggest step, 240 mutations/s peak, one 200-element burst.
- after: the same turn walked in while it was written - 88 distinct scrollTop positions, biggest step 215 px, 31.2
  mutations/s average and 47/s peak.

## What proves it

`node --test test/type-stream.test.js test/console-ordered-stream.test.js` on the branch as it was pushed: 39 tests,
39 pass, 0 fail (type-stream 32 of 32, console-ordered-stream 7 of 7).

Red before the fix: a paragraph the wire ended with a space, driven through the real hold in
`test/console-ordered-stream.test.js`, with the hold taking the call (`push -> true`, nothing drawn) and a
whitespace-only frame stranding the paragraph behind it. Thirty-six tests could not see this because every other
fixture ends on a word.

## The landing

The branch carried three commits over `origin/main` (`ee8b4f77`) when this run started: the harness `6d723343`, the
fix `e95fb660`, the doc `5d35f441`. The version bump was minted as `760e2570`, and the branch went out as `760e2570`
with `v1.115.2` claimed on that commit.

`npm run land:pr -- 787` merged with `--rebase --admin`, so the three commits and the bump were re-created: the
harness is `a57d4974`, the fix `158a5e95`, the doc `25190bd8`, the bump `dd298a66`, which is the PR's merge commit
and the commit `v1.115.2` now names. The tag was moved from `760e2570` to `dd298a66` and pushed, and
`refs/tags/v1.115.2^{}` peels to `dd298a66` on origin.

`CHANGELOG.md` was rendered at the merged tip as `a888448f` (630 releases), and this note follows it. The primary
checkout fast-forwarded `ee8b4f77` -> `dd298a66` before the render and now sits on `a888448f`.

**The LANDING line.** The tree's LANDING block ordered this branch merged into
`wtgui/console-jitter-deep-dive-diagnose-do-not-1b5c8b` locally with nothing pushed, because that base has not
landed. That merge already existed: the base's tip `fc45334b` has `6d723343` and `5d35f441` as its parents and a
tree identical to this branch's tip, so `git diff --stat fc45334b HEAD` prints nothing and no merge was minted. The
base is left where it was at `fc45334b`.

The reader settled the rest in this run: the LANDING line names where the tree was cut from, not what the PR targets,
and a tree cut from a non-landing branch still lands by PR against `main`, which is this repo's standing rule. So the
push, the PR and the merge above are this landing, and the local merge is not the landing.

**The primary checkout's other work.** It carried two modified files that are not this landing's
(`lib/assistant.js`, `test/element-assist.test.js`, the element-assist worker's shortened-separator fix and its
test). `land:pr` refuses a primary with tracked changes, so they were stashed for the merge and restored onto the
merged tip immediately afterwards, byte for byte (2 files, 20 insertions, 1 deletion, the same diff before and
after). The stash from the PR 716 landing is untouched at `stash@{0}`.

`gh` calls used the token in the user environment (`GITHUB_PAT_JLR`); `gh` itself holds no token on this box.
