# What a panel turn actually sends

**Measured** on branch `wtgui/audit-the-panel-s-token-4e0755` at `82de359` (1.44.0), 2026-11-06 23:00 EST /
2026-11-07 04:00Z, against the live panel on `127.0.0.1:7331` and the gateway on `127.0.0.1:8642`
(Hermes 0.22.5). Every number below was printed by a probe in this run; the probes import the tree's own
`lib/assistant.js` over a **copy** of the panel's state directory, so nothing was written to the live store.
Character and byte counts are exact (`String.length` and `Buffer.byteLength(..., "utf8")`); token counts are the
gateway's own counters, read from its `state.db` read-only.

**The frame.** The gateway's own metrics for today say **241.6M tokens with a p95 of 49 minutes**. Re-read at
the end of this run the same counters read `tokens 285255526` over `requests 99` and
`latency_p95_ms 3641512.72` (60.7 minutes at the millisecond reading the 49-minute figure implies). The frame
moved while the report was written; the brief's snapshot is quoted above it and the live re-read here, because
both are the gateway's own figures and the shape of the finding does not depend on which one you take: about
2.9M tokens a request, tens of minutes a request, 99 requests today.

**The short answer.** Of every message a panel turn hands the model, **99.1% is standing context**: 18,534 bytes
of preamble around a median question of **167 characters**. The preamble is not a prefix of the provider request -
it is appended as the run's user message - so reordering its stable blocks ahead of the volatile digest saves
**0 bytes a turn** as the request is built today. It is worth **10,831 bytes of cacheable prefix** on a
queue-changing turn only if the preamble is moved to the system prompt first, which makes the reorder the
*precondition* of the biggest saving rather than the saving itself. The cheapest saving that exists today is the
queue digest: **5,397 bytes on every wake**, 29.1% of an ordinary turn, of which 8 of its 15 rows are parked work
that is not the assistant's to act on.

## 1. What `input_tokens` and `cache_read_tokens` count

No ratio in this report is computed before this section, because the two counters are not the two halves of a
prompt and the obvious division is wrong.

| Counter | What it counts | Where it is written |
|---|---|---|
| `input_tokens` | every **uncached** prompt token this session has ever spent, cumulative, never rewound by a compaction | `sessions.input_tokens`, summed from the session's own `session_model_usage` rows (`task = ''`) |
| `cache_read_tokens` | prompt tokens the provider served **from the prompt cache**, counted separately from the above | `sessions.cache_read_tokens`, same rows |
| `cache_write_tokens` | prompt tokens written **into** the cache; zero on this provider | `sessions.cache_write_tokens` |

The total prompt is `input_tokens + cache_read_tokens + cache_write_tokens`. That is the denominator the CLI
itself uses for the cache rate (`lib/session-usage.js:8`), and the gateway's own stats endpoint computes the same
figure and says why (`docs/hermes-runs-api-knobs.diff`, `_run_stats`): *"the prompt counter already includes
cache read + write, so the two halves are not disjoint"*.

Measured on the five assistant sessions, which is what makes the trap concrete:

| Reading | Value |
|---|---|
| total prompt tokens | 3,080,919,299 |
| uncached `input_tokens` | 212,984,663 (6.9%) |
| `cache_read_tokens` | 2,867,934,636 (93.1%) |
| prompt per API call | 290,982 |
| uncached per API call | 20,116 |
| **`cache_read_tokens / input_tokens`** | **1,347%** - the ratio that is not a ratio |
| `cache_read_tokens / (input + read + write)` | 93.1% - the only honest one |

So: **`input_tokens` is the new text a turn pays full price for, and `cache_read_tokens` is the transcript it
re-reads.** A cache rate over `input_tokens` alone can exceed 100% and is not a measurement of anything.

Three things the card's counters do **not** include, all of them real spend:

1. **The other task rows.** `sessions.input_tokens` is built from the session's `task = ''` rows only
   (`lib/session-usage.js:138-144`). Background review, compaction and title generation are separate rows.
   Measured: assistant-1's session row records 140,420,319 input tokens and $37.69; its `background_review` rows
   alone add 20,395,476 input + 688,329,515 cache-read tokens and $7.76, and `compression` adds $1.32. Across all
   five assistants the other tasks are **1,052,339,469 prompt tokens and $13.68**, against **$55.16** recorded on
   the session rows: real spend **$68.84**. Background review alone is 34% of the prompt-token volume and is
   invisible to the card's in/out counters. The panel does carry its dollars separately
   (`other_cost_usd`, `lib/session-usage.js:198`), but not its tokens.
2. **`total_tokens` on a run's `usage` is `input + output`.** The fence probe's own reading is
   `input_tokens 17012, output_tokens 8, total_tokens 17020` (`docs/research/gateway-fence-endpoints.md`), and
   `lib/jobs.js` stores only those three fields on the card. A run that reads 90% of its prompt from cache shows a
   `total_tokens` about one tenth of the prompt it was charged for.
3. **Cumulative vs per-turn.** The counters are the session's whole life. A card that says "40M in" is not saying
   what this turn cost; it is saying what this thread has cost since it began. `api_call_count` is the only
   divisor that turns them into a per-call figure, and it is 3.00 calls a turn here.

## 2. What actually reaches the model

A turn is one user message built by `Assistant.preamble()` and handed to `jobs.create()`; `lib/jobs.js:2997`
prepends it to the run's input (`pre + anchored`), and the gateway stores it as a **user** message in the
session's transcript (measured: message id 293038 of `panel-assistant`, role `user`, 19,830 chars, opening on
"You are the assistant watching this panel's agent board"). It is not a system prompt and it is not a prefix.

### The four shapes a turn takes

| Shape | Who decides | chars | bytes |
|---|---|---|---|
| session's first turn (charter in full, board in full) | `charterBriefing` turn 1, `boardForTurn` event/reader | 40,936 | 41,444 |
| ordinary sweep (charter marker, board marker) | `CHARTER_RESEND_EVERY = 20`, `digestSweepEveryNWakes = 2` | 18,282 | **18,534** |
| sweep where the board is due | `digestSweepEveryNWakes` (unset here, so the code's 2) | 21,801 | 22,145 |
| sweep where a queue row moved | `queueSweepEveryNWakes` (unset here, so the code's 1) | 18,133 | 18,379 |

`queueSweepEveryNWakes` is unset on every assistant in this panel, so the `|| 1` in `lib/assistant.js:1084` puts
the queue digest in **every** wake. `digestSweepEveryNWakes` is likewise unset, so `|| 2` at `lib/assistant.js:1125`
sends the board in full every second sweep. The charter's marker is one line (`lib/assistant.js:653`) and the board's
is one line (`lib/assistant.js:1140`), which is why the steady-state turn is 18.5 KB and not 41 KB.

### The question is not the message

Over the last hour the gateway's store shows 24 user messages on the assistant threads, and the panel's job store
holds 25 assistant jobs from that hour (it keeps 80). Their question texts: **median 167 chars, mean 209, min 82,
max 655**. Against an ordinary sweep's 18,534 bytes of preamble and
the `\n\n---\n\n` separator, the question is **0.9%** of the message. The prior audit measured 36,434 chars around
an 81-char question, 53% of that preamble being the charter re-sent in full; this run's ordinary turn is half the
size because the charter is one line on 19 turns in 20 (`lib/assistant.js:647`). The standing share of the message
is 99.1% either way in those two measurements - what changed is the size of the message, not its composition.

### The append tax

The preamble is appended to the transcript every turn, so it is not paid once - it is re-sent by every later API
call in that session:

| Reading | Value |
|---|---|
| retained message text, five assistant sessions | 111,762,304 chars |
| of which user messages (the turn inputs) | 92,866,985 chars = **83.1%** |
| mean user message | 26,323 chars |
| turns | 3,528 |
| preamble share of the turn inputs | 3,528 x 18,282 = 64.5M chars = **69%** of them |

That is why a 93.1% cache hit rate still costs $55.16 and 3.08B prompt tokens: the cache is being read, not
avoided, and each compaction re-ingests the whole thing. Assistant-1 has 54 compression runs recorded, and they
alone spent 3,207,313 uncached input and 988,009 output tokens.

### Does the measured model match the wire?

Yes, within 4.5%. Predicted mean turn input from the four shapes and the observed mix (45% ordinary sweep, 50%
board due, 5% first turn) is **21,807 chars**; the gateway's store for the last hour shows **22,844 chars** over
24 turns (548 KB an hour). The turn shapes above are the turn shapes that ran.

## 3. The 40 rules: 12 ride, 28 fall off

`lib/assistant.js:4446` renders the standing rules as `rules.slice(-12).map((r, i) => \`${i + 1}. ${clip(r.text, 200)}\`)`.
The live store holds **40 rules** - the cap (`lib/assistant.js:4793` refuses a 41st) - totalling **15,219 chars**.

| Measure | Value |
|---|---|
| rules written down | 40, 15,219 chars (15,349 bytes) |
| rules that reach the model | 12 (the newest 12) |
| chars of rule text that reach the model | 2,400 = **15.8%** of what is written |
| rules that fall off entirely | **28**, 10,437 chars (10,531 bytes) |
| chars clipped off the 12 that do ride | 2,382 of 4,782 written (49.8%) |

At 40 rules the window is rules **29 to 40**. Everything from 1 to 28 is dropped, and the dropped set is the
**oldest** - which is the set that holds the landing, restart and gateway rules this panel is actually governed by:

| # | id | chars | rides | what it says |
|---|---|---|---|---|
| 1 | 587f332a | 9 | dropped | `recorded:` - a fragment, no rule |
| 2 | e3f2a020 | 400 | dropped | GitHub-remote repos land through a GitHub PR |
| 3 | f2e7c533 | 400 | dropped | a SPAWN line is not a started worker |
| 4 | ec5090a7 | 400 | dropped | after a restart, sweep `logs/jobs.json` before re-starting |
| 5 | 5acc2ee2 | 400 | dropped | supersedes the earlier restart rule; assert the boot first |
| 6 | 5b9c0b85 | 400 | dropped | after a restart, re-attach each session the restart killed |
| 7 | b51d40ee | 400 | dropped | every turn, establish whether a thread is live before reporting |
| 8 | 3d661fe2 | 400 | dropped | landing is judged against the branch's PARENT |
| 9 | 205dbcc7 | 400 | dropped | split landing by whether we own the repo |
| 10 | 3bc54874 | 400 | dropped | a worktree cut with SPAWN starts from the parent's branch |
| 11 | 4c27cdd2 | 400 | dropped | a gateway restart is proved by a changed pid |
| 12 | 5a3083a2 | 367 | dropped | never create a git worktree to compare a branch |
| 13 | f930bc32 | 400 | dropped | a quiet run is stalled when three things hold together |
| 14 | 3fc43b5d | 400 | dropped | the oauth2-multi review remediation sequence |
| 15 | a79b69c6 | 400 | dropped | a worktree is deleted the moment its work is in its parent |
| 16 | 4b4e0bc6 | 400 | dropped | after a restart, resolve the killed run before re-starting |
| 17 | 157dbf62 | 335 | dropped | an approval `/api/approvals` does not list is not a card |
| 18 | ceebc516 | 400 | dropped | this repo has no Jenkins job and never will |
| 19 | 62bf5ee2 | 343 | dropped | a patch loop is a stale `old_string` |
| 20 | a65db958 | 400 | dropped | after a squash-merge, judge a landing by tree equality |
| 21 | 6dcf300d | 400 | dropped | a branch with no commits is not evidence its work is absent |
| 22 | 248a9487 | 400 | dropped | a squash land never zeroes AHEAD here |
| 23 | a60a69dd | 400 | dropped | this repo's own `remoteBranchPolicy` is `allow` |
| 24 | 0ba6fcd2 | 331 | dropped | a fix brief names exactly one endpoint, once |
| 25 | 56c403b9 | 259 | dropped | verify a spawn from `GET /api/jobs`, not from a card |
| 26 | 70695257 | 400 | dropped | a run of patches is not a loop until the diff says so |
| 27 | 563e58b4 | 393 | dropped | a quiet `npm test` is the pipe, not the suite |
| 28 | 5092163d | 400 | dropped | the gateway holds an approval open for 600 s |
| 29 | 92574f20 | 400 | rides | cleanup never justifies a new worktree |
| 30 | 074c57ac | 400 | rides | supersedes the wording of the earlier cleanup rule |
| 31 | da688bd4 | 400 | rides | a row that ends `failed` is assessed the same turn |
| 32 | 2db83f5d | 400 | rides | a live `--test` child is evidence of a healthy run only if |
| 33 | b1d77961 | 400 | rides | a run that ends `done` is not a finished job until its branch |
| 34 | 21fa5721 | 400 | rides | a RELEASE line is a request, not an eviction |
| 35 | bf273d58 | 400 | rides | an approval in an api_server session is not a person |
| 36 | 06e7066f | 400 | rides | `MERGED (N commits)` is not N unmerged commits |
| 37 | b0426cd0 | 400 | rides | never push the oauth2-multi turnover branch |
| 38 | 360b57a3 | 400 | rides | `NO BASE REF` is a project-config artefact |
| 39 | 1981abda | 400 | rides | when a completion wakes the assistant, the next step |
| 40 | 0f49e2bb | 382 | rides | never write the em dash or the en dash |

Two further defects the table makes visible:

- **The window is ordered by nothing.** `slice(-12)` keeps the newest, so a rule's survival is decided by when it
  was written, not by whether it still applies. Rules 4, 5 and 6 are three successive restart rules; 30 says it
  supersedes 29, and both ride. Rule 1 is a 9-char fragment (`recorded:`), the residue of a mis-split.
- **The clip cuts the reasoning off every rule that rides.** The cap is 200 chars and 11 of the 12 carried rules
  are 367-400 chars: what the model reads is the first clause of each rule and none of its justification. Carrying
  all 40 would add 10,437 chars, but carrying them deduplicated and ordered by subject is the change worth making:
  the text is stable, and a stable block is the cheapest text in the prompt (see section 5).

## 4. Prefix stability, field by field

The table below is one ordinary sweep's preamble, built by `Assistant.preamble("assistant-2")` at 18,282 chars /
18,534 bytes. `offset` is the byte offset of the block's first byte, so a block's cost to a prefix cache is
`offset + 0` - everything from the first changed byte on.

| Block | chars | bytes | offset | stable? | what moves it |
|---|---|---|---|---|---|
| opening + job description | 622 | 624 | 0 | yes | a role change only |
| **queue directive + queue digest** | 5,278 | 5,397 | **624** | **no** | any queue row, including the done count |
| restart note | 324 | 326 | 6,021 | yes | never (standing text) |
| autonomy + spawn + one-run rule | 488 | 492 | 6,347 | yes | a settings change |
| projects you can spawn in | 3,632 | 3,675 | 6,839 | yes | a discovery pass |
| standing rules | 2,548 | 2,580 | 10,514 | yes | the reader writing a rule |
| scratchpad | 1,214 | 1,218 | 13,094 | semi | a NOTE line - clipped at 1,200 chars |
| charter (marker this turn) | 433 | 439 | 14,312 | yes | the file changing, turn 20, or a new session |
| **watches** | 318 | 322 | 14,751 | **no** | a watch state or its deadline |
| **board digest (marker this turn)** | 143 | 145 | 15,073 | **no** | the board moving, or the sweep that makes it due |
| action grammar | 2,679 | 2,709 | 15,218 | yes | a feature adding an action |
| charter explanation line | 485 | 489 | 17,927 | yes | never |
| never-write closing line | 118 | 118 | 18,416 | yes | never |
| **whole preamble** | **18,282** | **18,534** | - | - | - |

The same preamble on a session's first turn is 41,444 bytes: the charter block alone is 19,738 bytes instead of
439, and it sits at offset 14,312.

### Where each change breaks the text

Two preambles were built by the same instance with one thing moved at a time; `first diff` is the byte at which
they stop matching.

| Transition | first diff (byte) | of |
|---|---|---|
| sweep -> next sweep, nothing moved | none - byte-identical | 18,534 |
| sweep -> board due (marker becomes the full digest) | 15,096 | 18,534 |
| board due -> board due, one minute later (elapsed minutes inside the digest) | 15,448 | 22,145 |
| sweep -> one queue row moved | **2,224** | 18,534 |
| session's first turn -> ordinary sweep (charter full becomes its marker) | 14,339 | 41,444 |

The queue is the expensive one: it sits at offset 624 and changes whenever any row does, so 16,310 bytes of text
that never changed - the restart note, the settings lines, 40 projects, all 12 rules, the charter, the watches,
the grammar and the closing lines - sit behind a block that moves on a normal wake.

### What reordering would actually buy

Keeping the block texts fixed and moving the stable ones ahead of the volatile four
(queue, scratchpad, watches, board):

| Transition | valid prefix now | valid prefix reordered | delta |
|---|---|---|---|
| sweep -> board due | 15,096 B | 18,415 B | **+3,319** |
| board due -> board due, +1 min | 15,448 B | 18,767 B | +3,319 |
| sweep -> one queue row moved | 2,224 B | 13,055 B | **+10,831** |
| sweep -> next sweep | byte-identical | byte-identical | 0 |
| stable blocks available to lead with | 11,452 B of 18,534 | - | - |

**Those deltas are a hypothetical, and the measurement says so.** The preamble is not the beginning of the
provider request: it is the run's user message, appended after the whole transcript (`lib/jobs.js:2997`, and the
stored `role = user` message in section 2). The provider's cacheable prefix ends at the previous turn's last
message, which is byte-identical from one turn to the next; the current turn's preamble is new text wherever it
sits inside that message. Reordering the blocks inside it therefore **saves nothing** - the only text that could
be served from cache is the text the cache already had, and that is all outside the preamble.

Reordering becomes worth 10,831 bytes the moment the preamble is moved **out** of the per-turn message and into
the system prompt (or another block that leads the request). At that point the offsets above are the map of what
becomes cacheable: everything before the first change, and today that is 624 bytes because the queue is second.

## 5. Ranked savings

Per turn, in bytes, measured on the ordinary sweep unless stated. "Lost" is what the change costs the model's
information.

| Rank | Change | Saves per turn | % of 18,534 B | What is lost |
|---|---|---|---|---|
| 1 | **Gate the queue digest to rows that are yours to act on** (8 of its 15 rows are `parked` with their full reasons) | up to 5,397 B | 29.1% | the parked rows' reasons; they are visible on the board and in the queue tab |
| 2 | **Send the projects list only when the turn may spawn** (40 of 177 projects, every turn) | 3,675 B | 19.8% | the assistant cannot name a project it was not shown; it can still ask |
| 3 | **Board digest less often** (`digestSweepEveryNWakes` 2 -> 4) | 903 B average | 4.9% | a staler board between sweeps; the marker still says it moved |
| 4 | **Charter** (`CHARTER_RESEND_EVERY` 20 -> 40) | 482 B average | 2.6% | the full file is read half as often |
| - | **Standing rules** (2,580 B) | **do not cut** | 13.9% | this is the block that is already losing 84% of its text |
| 5 | **Reorder stable text before the volatile digest** | **0 B as sent today**; 10,831 B of cacheable prefix *if* the preamble moves to the system prompt | 0% (hypothetical 58%) | nothing - same text, different order |

Ranking, read the way the brief asks: **reordering is last as a saving of its own (0 bytes a turn) and first as
the thing that makes a larger saving possible.** On its own it is a text shuffle inside a message that is new
either way. Combined with moving the preamble to the system prompt it is worth 10,831 bytes on a queue-changing
turn and 3,319 on a board-due turn, because 58% of the preamble would then sit in the cacheable prefix instead of
3.4%. The move itself is the change that needs a design (a system prompt that changes per turn is a different
trade: it invalidates the whole cache when it changes, which is why the ordering matters once it is there).

Two things are not savings but are the same budget:

- **The 28 dropped rules are a loss, not a saving.** Carrying them deduplicated adds 10,437 chars to a stable
  block; at rank 2's prices that is about two queue digests of text, and it returns the panel's governance.
- **The append tax is the multiplier.** Every byte above is also appended to the transcript, where every later
  API call re-reads it: 69% of the 92.9M chars of turn input is preamble. Cutting 5.4 KB a turn cuts the growth
  of the transcript by the same 5.4 KB a turn, and the re-read after each compaction with it.

## 6. What this report does not measure

- **Provider token counts for the preamble.** No tokenizer is installed here (`tiktoken` and `tokenizers` both
  absent), and the store's `messages.token_count` is null for every one of the 23,466 assistant messages. The
  preamble is therefore reported in chars and bytes, exactly; the gateway's token counters are reported as
  tokens, exactly; the two are never divided into a ratio.
- **What a worker run sends.** The same `pre + anchored` path builds it (`lib/jobs.js:2997`), but the measurements
  here are the five assistant threads. A worker's preamble is the same shape with a different role and no board.
- **The cost of one cache miss.** The store records dollars per session, not per call, so the report prices
  nothing in dollars beyond the recorded figures in section 1. The saving is stated in bytes of prompt.
- **Why `latency_p95_ms` is what it is.** The field's unit is unconfirmed (ms and µs readings differ by 1000x);
  the brief's 49 minutes and this run's 60.7 are both the millisecond reading, quoted as the gateway wrote them.

## 7. Reproduce it

The probes lived outside the repo, under the run's scratch directory, and are not committed (this landing adds no
code). Each one imports the tree's own module against a copy of the live state:

1. Copy `<state>/assistant.json`, `assistant-charter.md`, `assistants.json`, `roles.json`, `jobs.json`,
   `projects.json` and `<state>/assistants/` into a scratch directory.
2. `new Assistant({ config: { dataDir: <copy> }, jobs: { list: () => jobs }, getProjects: () => projects, ... })`,
   then `load`, `loadCharter`, `loadRoles`, `loadAssistants`, `loadProfiles`, `loadQueues`.
3. `preamble("assistant-2", { queue: true, board: assistant.digest() })` for the first turn;
   `assistant.markerDigest(sig, 0)` for an ordinary sweep; shift every job's `startedAt` by 60 s to age the
   digest by a minute; flip one queue row's `state` and `loadQueues()` again for a queue change. Split the text on
   the section headings and measure with `Buffer.byteLength`.
4. The counters are one read-only `node:sqlite` query over
   `%LOCALAPPDATA%/hermes/state.db`: `sessions` for the counters, `session_model_usage` for the task split,
   `messages` for the transcript and the role of the preamble message.

## 8. The base moved while this was written

The report measured `82de359` (1.44.0). `origin/main` then took two commits - the flow dialog's read-only
preview (`49c2998`) and its verify gate (`6040979`) - and a sibling landing took the number this branch had
bumped to, so main declares 1.44.1 and this landing spends **1.44.2**.

The measurement is pinned to the code, not the branch tip:
`git diff --stat 82de359 HEAD -- lib/assistant.js lib/jobs.js lib/session-usage.js lib/assistant/` prints
nothing, and the ordinary sweep re-run at the new tip is **18,282 chars / 18,534 bytes** - byte-identical to the
table in section 4. Every number above describes the code this commit lands.
