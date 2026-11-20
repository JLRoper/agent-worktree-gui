# Landing: one row per clarify question, answered in a reply is not missed (1.138.0)

PR #809 merged into `main` as `a4384939`, and the render that followed is `090cbfee`. The Clarify popup drew one
row per stored ASK, so a question that was asked, closed unanswered and asked again stood as two rows, one of them
answered and the other still saying "closed unanswered" - which is what made an answered question look missed. A
row is now one QUESTION, with every attempt folded inside it. An item whose card closed unanswered and which the
reader then answered in the reply box reads "answered in a reply" and points at that turn, instead of being called
missed. The header button's count is now the items still waiting, not the asks on file.

## What landed

- `lib/clarify-history.js` - `collapseKey(entry)` (the question's own words plus the asking agent) and
  `collapseItems(entries)`, so the store answers items rather than asks; `items({ limit, replies })` returns
  `{ items, total, attempts, outstanding }`, where `outstanding` counts items still in state `open`;
  `readerReplies(jobs, thread, after, before)` and `outstandingOf(items)`. The rule order for a row is: an answer
  in ANY attempt wins, else an open attempt, else a reader reply after the ask and before the next question on
  that thread, else the closed word stands.
- `routes/clarify-history.js` - `GET /api/clarify/history` now answers
  `{ entries, items, total, attempts, outstanding, kept, cap }`; `limit` is a render cap only, so the header can
  read `?limit=1` for the count without changing what "60 questions" means.
- `lib/assistant.js` - `noteAnswerByReply(job, answer, by)` records the answer against the question (keyed by
  `job.question.key`, `via: "reply"`) when an answer reaches a turn through the reply box or a fresh session, so a
  real answer cannot leave "closed unanswered" behind it.
- `public/core/clarify-history.js` - a fourth state, `replied`; `stateOf` reads `entry.state || entry.status` so
  items and stored rows are read the same way; `answerText`, `replyText`, `closedLine` and `attemptLine` are the
  one place a row's words are built.
- `public/clarify-history.js` - one row per question (`chRowShell`), the attempts fold (`ch-attempt-toggle` /
  `ch-attempt-list`) whose open state lives in `clarifyHist.folds` rather than the DOM, because the list is rebuilt
  on every poll and a DOM-only fold shut under the reader; the rows are read from `body.items`; the count is read
  on a 4 s tick and again 1.2 s after a job frame (`setClarifyPending`, `clarifyPendingCount`).
- `public/app.js` - `paintCountBadge(btn, badge, count, cls)` is the one painter for the Human and Clarify badges
  (zero hides the badge and the wash, and the highlight follows the count), plus `paintClarifyButton` and the boot
  wiring that starts the count tick.
- `public/index.html`, `public/style.css` - `#clarify-badge`, `.topbar #btn-clarify.has-unanswered` (the header's
  violet wash), the replied row and mark, and the attempts fold.
- `test/clarify-history.test.js`, `test/human-kinds.test.js` - the collapse, the answered test, the reply evidence,
  the attempted-count rule and the shared painter.
- `tools/verify-clarify-history.mjs` - the fixture now carries the row's own cases: one question asked twice, a
  reader reply turn on the job store, and a question nobody answered; 75 checks at 1440x900 and 768 wide.
- 30 files, +1283/-55 across the four branch commits and the bump.

## What proves it

- `node tools/verify-clarify-history.mjs` - **75/75 checks passed**, 0 page errors, at 1440x900 and 768 wide. The
  gate asserts the asked-twice question is ONE answered row with both attempts folded and each attempt's own
  timestamp, that a repaint leaves the fold open, that the replied item reads "answered in a reply" with the
  reader's words and lands on that turn unfolded and on screen, that the genuinely missed item still reads "closed
  unanswered", that the route answers 61 asks as 60 items with 1 outstanding, that the badge reads 1 over the
  violet wash before the popup is opened, and that a second boot on a store with nothing waiting hides the badge
  and drops the wash while the popup still holds 60.
- `node --test --test-concurrency=4 test/clarify-history.test.js test/human-kinds.test.js` - **33 tests, 33 pass,
  0 fail**.
- `node --test --test-concurrency=4 test/clarify-answer-reuse.test.js test/clarify-cancelled-run.test.js
  test/clarify-reask.test.js test/clarify-card-caret.test.js test/hot-agent-header.test.js` - **31 tests, 31 pass,
  0 fail**.
- The full suite, once, on the branch: `npm test` - **3326 tests, 3317 pass, 9 fail**. Eight of the nine reproduce
  from a clean `git archive origin/main` export in this environment (assistant-profile, assistant-search-scroll,
  child-route, gateway-permissions, header-controls, paths-http, paths, reasoning-runs), so `main` already carries
  them here; the ninth, queue-sweep, is a load flake and reads 14/14 standalone in the branch and on `main`. The
  suite was attempted three times before that pass, each cancelled at the twenty-minute cap while three or four
  other suites ran on this host (the same two attachment tests read 45 s and 38 s under that load and 4 s and 8 s
  when it cleared).

## The version and the tag

The branch was cut from `1.132.0` and reached `origin/main` three numbers later: by the time it was ready, `main`
read `1.137.0`. `tools/version.mjs check` refused the push with "this branch's version is behind origin/main's",
the rebase took main's number in the `package.json` conflict, and `node tools/version.mjs apply minor` wrote
`1.138.0` as `a0134d46`, tagged `v1.138.0` there and claimed the number on origin.

An earlier `1.134.0` was claimed while the branch was still on `1.133.0`, and that tag was **retired**
(`git push origin :refs/tags/v1.134.0`) once the rebase dropped its commit: the number is not in the history
`main` carries, and 1.134.0 was skipped by the landings that followed. The scale is minor because the row changes
what the reader is handed: a different row per question, a new replied state, and a count that clears.

The rebase merge re-created the branch commits on `main`:

| branch | on `main` | commit |
| --- | --- | --- |
| `52d2e5f5` | `7dbd8987` | feat(clarify): collapse each clarify question to one item, and count only what is waiting |
| `470b28b9` | `99e64edb` | test(clarify): prove the collapse, the reply and the button count headless at 1440x900 |
| `a0134d46` | `f74fbf27` | chore: 1.138.0 - the version this landing carries |
| `2fcdd963` | `a4384939` | docs(clarify): the shots carry 1.138.0 |

## The landing

- `git fetch`: `origin/main` was `8e0c0187` (1.137.0); the branch rebased onto it, then `npm run land:pr -- 809`
  read the pull request, merged it with `--rebase --admin`, and fast-forwarded the primary checkout
  `1b9ccca -> a4384939`.
- It moved `v1.138.0` onto `f74fbf27c1` (the commit `main` shows first declaring the number), rendered the
  changelog at the merged tip as `090cbfee` (`docs: render the changelog - 651 releases`), and pushed `main`.
- `node tools/changelog.mjs --check` reads `CHANGELOG.md is current - 651 releases`.
- `node tools/verify-version-tags.mjs --ref origin/main` - 651 version bumps, 646 tagged and annotated at the
  commit that first declared them; no finding names `1.138.0`. The 7 findings it prints (two backwards moves, four
  wrong-commit tags and `missing v1.82.2`) are the ones `main` already carried.
- Screenshots refreshed under `docs/assets/clarify-history/`: `02b-fold-1440.png` (the fold open on the
  asked-twice question), `02c-replied-and-missed-1440.png` (the replied row beside a real miss),
  `06-reply-landed-1440.png` (the replied row's turn), `07-count-zero-1440.png` (the header with nothing waiting)
  and `08-answered-rows-1440.png`.

## The clock

- `date` - Fri, Nov 20, 2026 00:49:55 AM (EST); `date -u` - Fri, Nov 20, 2026 5:49:55 AM.
