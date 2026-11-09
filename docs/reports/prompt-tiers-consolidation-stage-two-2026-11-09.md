# The tiers pass, stage two: both role prompts written, Assistant #1 consolidated to twelve

Executed 2026-11-09 against the live panel store (`<dataDir>/state`, default `~/.wag` in this account), with the
panel stopped for the writes and restarted after them. Base: `main` at `9b672cf` (`package.json` 1.70.0 at the cut).
Main moved three times while this branch waited (1.70.2, 1.70.3, 1.70.5); the branch was rebased onto each tip and
carries 1.70.6, the next free patch above the 1.70.5 that main read at the push. The rule pass ran through the shipped
facility (`lib/assistant/consolidate.js`,
`Assistant.consolidateRulesFor`) driven by `tools/consolidate-rules.mjs`, from the plan beside the stage-one plans:
`docs/design/prompt-tiers-pass-2026-11-08/assistant-1.plan.json`. The role prompts are the seeded contracts in
`lib/roles.js`, applied to the live library by `tools/set-role-prompts.mjs`.

**Verdict: both role prompts are written and riding, and Assistant #1's forty rules are twelve.** Both reader rules
are in the list, pinned, and arrive whole. The twelve-seat window shows all twelve with nothing left out. Every
rule the pass produced that was not kept verbatim carries `rewritten: true` and its `rewrittenFrom` ids, and the
nine rules that left the every-turn tier are dated entries in the charter, not deletions. The Director's own forty
rules were not touched and are reported below as unchanged.

Paths are written relative, or as `<dataDir>` for the panel's data directory. Rule ids are the store's own.

## 1. The two operating contracts (tier 1)

The role prompt is the every-turn contract. Both built-in roles carried an empty one, so their turns began with an
identity line and an action grammar while the stance sat in a charter the panel sends once every twenty turns.

| role | chars | bytes | lines | sha256 of the prompt | source |
|---|---|---|---|---|---|
| `assistant-agent-manager` | 1,088 | 1,088 | 12 | `ae443c67c00e6db81b23ed6927790aa005fdbea8ceb92f399a9e716e3d95cd12` | charter's Role and remit + Hard guardrails + the twelve surviving rules |
| `assistant-director` | 1,125 | 1,125 | 12 | `31c2b6b7e59ba60882438cb3a06856d0cb9162250642d4583c4edb2d0463eda5` | its charter's job paragraph, boundary list and routing order |

Both fit the 1,472-character tier-1 seat the design budgets (section 3.2). The text lives in `lib/roles.js`
(`ASSISTANT_AGENT_MANAGER_PROMPT`, `ASSISTANT_DIRECTOR_PROMPT`) and is what a fresh panel seeds, so the tier is no
longer empty for a new library either. `tools/set-role-prompts.mjs` is the door onto a library written before the
contract existed: it copies the seed, snapshots `roles.json` first, refuses while a panel serves the port, and
refuses to overwrite a prompt that is not empty unless `--force` is given.

What the manager's contract carries: read the queue before the board; never do the work; say only what is written
down; read live state from `/api/jobs`; one worktree, one live agent; a failed row is judged by its outcome; done is
not landed until the PR reads MERGED; a reader's rule is rewritten or merged, never dropped; never answer an
approval; ask a numbered question when the next step is ambiguous; keep replies short.

What the Director's carries: read every queue first; the wake is a fresh pass; find the dead run, the row parked
past an hour and the work nobody started; its only powers are `QUEUE` and `MESSAGE`; name the assistant and why;
never SPAWN, never TO a worker, never do the work; never move another assistant's row; never answer an approval;
never claim a landing without evidence; when nothing is wrong say so and stop.

Two facts about the seat as it now behaves:

- **The role's prompt is live for every assistant that runs the role.** Assistant #3, which has no prompt of its
  own, now begins every turn with the manager's contract; its system block grew by the prompt and its header.
- **An assistant's own prompt still wins.** Assistant #2 carries its own 411-character contract from stage one, so
  it keeps that one and the role's text is not repeated under it.

## 2. The rules pass, before and after

| | Assistant #1 | Assistant #2 | Assistant #3 | Director (#5) |
|---|---|---|---|---|
| rules before | 40 (2 reader, 38 assistant) | 12 (1 reader, 11 assistant) | 12 (all reader) | 40 (1 reader, 39 assistant) |
| rules after | **12 (2 reader, 10 assistant)** | 12 (unchanged) | 12 (unchanged) | 40 (unchanged) |
| shown by the twelve-seat window | 12, left out 0 | 12, left out 0 | 12, left out 0 | 12, left out 28 |
| rewritten (`rewritten: true`) | 11 of 12 | 12 | 12 | 0 |
| pinned (`safety: true`) | 3 | 2 | 2 | 0 |
| charter before -> after | 19,904 -> 17,354 chars | 17,353 (unchanged) | 17,502 (unchanged) | 15,617 (unchanged) |
| role prompt | 1,088 chars (was 0) | 1,088 (its own 411 still wins) | 1,088 (was 0) | 1,125 (was 0) |
| system block before -> after | 10,730 -> 13,590 bytes | - | - | - |

The block grows by 2,860 bytes on #1: the tier-1 contract arriving (about 1,170 bytes with its header) and the
rules block widening, because before the pass the window could show only 10 of the assistant's 38 rules and left
28 out, while after it shows all twelve. The before column is the dry run's measure, taken before the role prompts
were written; the after column is the pass's own report.

Assistant #1's op counts: **1 kept, 3 rewritten, 8 merged, 0 dropped, 9 moved to the charter, 0 prompted**. The
eight merges absorb 27 ids; the three rewrites are the two reader rules and the oauth2-multi boundary; the one kept
rule is the SPAWN rule, kept verbatim on purpose (section 5); the nine chartered rules leave the every-turn tier
and their full text lands in the charter as a dated entry naming the rule id.

Charter moves: the `NO BASE REF` artefact, the fail-closed gate precedent, the queue route's mechanics, "a lane is
not a queue object", the Director's own liveness job, the superseded `04b1e584` self-quote, the law of this pass,
the task/row/run vocabulary, and the ambiguous-next-step rule whose decision is now the manager role's contract.
The trim ran after the pass, as it did in stage one: it dropped the two frozen seed sections and the seven oldest
changelog entries, and never a line above the changelog heading.

## 3. The twelve rules, as the store now holds them

Injected order: the reader's first, then the assistant's in list order.

| # | id | by | pin | rewrittenFrom | chars |
|---|---|---|---|---|---|
| 1 | `f5906e09` | reader | yes | `f5906e09` | 190 |
| 2 | `d2aecae2` | reader | yes | `d2aecae2` | 199 |
| 3 | `9f8fcec1` | assistant | | `9f8fcec1, c0bbb585, 9b4239ea` | 241 |
| 4 | `9b850bac` | assistant | | `95501040, 9b850bac` | 272 |
| 5 | `f1fa6596` | assistant | | `f1fa6596, 847590ac, c64760c1, 76d22f69, b8317c43` | 279 |
| 6 | `25e72e9d` | assistant | | `25e72e9d, af73dd43, d1c3f2aa, 22ac5ac7` | 283 |
| 7 | `12426ee2` | assistant | | `12426ee2, 955e80b1, 8b29762a, e2d5e72a` | 285 |
| 8 | `0e6b1ff0` | assistant | yes | `0e6b1ff0` | 269 |
| 9 | `c19ed160` | assistant | | `fc9b1457, c19ed160, c715a29f, bed1a11f` | 259 |
| 10 | `3194d22e` | assistant | | `8229ed4a, 0b73a0d7, 3194d22e` | 282 |
| 11 | `2bf7cc4b` | assistant | | `49315e64, 2bf7cc4b` | 288 |
| 12 | `1f352493` | assistant | | (kept verbatim) | 319 |

The two reader rules, whole (both under the 200-character injection clip, so neither arrives truncated):

- `f5906e09`: "Never write U+2014 or U+2013 anywhere - replies, commits, PR titles and bodies, comments, docs, logs
  or shell output. Use a plain ASCII hyphen; those characters become mojibake under cp1252."
- `d2aecae2`: "Outside oauth2-multi, a tree cut from a non-landing branch still lands by PR against the landing
  branch, merged with gh pr merge --rebase --admin; the LANDING header names the source, not the target."

## 4. The window proof

Driven from the panel's own classes over a copy of the live store (`Assistant.rulesFor`, `briefingRules`,
`systemBriefing`, `preamble`), not from a reimplementation. Sixteen checks, all pass:

- the stored list is twelve, the window carries twelve, and `leftOut` is 0;
- both reader rules are in the window and arrive whole (190 and 199 characters, equal to their stored text);
- twenty-eight of the forty source ids were consumed and did not survive as rules;
- **no consumed rule's full text rides the block** (0 of 28), so no dropped wording came back inside a merged rule;
- all nine chartered ids are absent from the window and from the stored list;
- all nine chartered rules' text is present in the charter, and none of it rides the system block;
- the manager contract rides Assistant #1's preamble and the Director's contract rides the Director's, and the
  Director does not inherit the manager's.

Window ids, in the order the block lists them: `f5906e09, d2aecae2, 9f8fcec1, 9b850bac, f1fa6596, 25e72e9d,
12426ee2, 0e6b1ff0, c19ed160, 3194d22e, 2bf7cc4b, 1f352493`.

## 5. The replay, and why one rule is kept verbatim

The first apply produced the intended twelve. Within a minute of the restart the list read thirteen: the panel's
boot re-harvests stored assistant turns whose ids have aged out of the 50-id `harvested` window, and a RULE line,
unlike a SPAWN or a QUEUE line, has no per-line record, so it is carried out again. The replayed turn added the
original SPAWN rule (`1f352493`) beside the merged rule that had absorbed it. The journal shows the burst that
carries it (`2026-11-09T05:25:16Z` and again at `05:27:33Z`: `note`, `spawn-replay-refused`, `queue-replay-refused`,
`message-replay-refused`, then the rule and charter entries re-applied).

Two writes followed, both undoable:

1. The store was restored from the first pass's own snapshot (the pass's before state: 40 rules, the 19,904-char
   charter), after copying the thirteen-rule state to `<dataDir>/logs/tier-cleanup-2026-11-09/pre-restore-*`.
2. The plan was re-cut so the SPAWN rule is **kept verbatim** rather than merged. A replay of its RULE line is now
   an exact duplicate, which `addRuleToList` answers with no write, and the ambiguous-next-step rule moved to the
   charter with its decision recorded as the role prompt's.

A second restart and a settled boot later, the list is still twelve: the replayed line is a no-op. What the replay
still does every boot is re-append old `CHARTER:` lines, which `appendEntry` does not de-duplicate: the charter read
17,354 characters after the pass and 18,323 after the boot, and it prunes its oldest entries to stay under the cap.
That is a pre-existing defect of the same family (NOTE and CHARTER lines have no per-line record either), it is why
this report quotes both charter numbers, and it is recorded as unfinished work rather than papered over.

## 6. Snapshots

| what | path under `<dataDir>/logs/` | holds |
|---|---|---|
| the applied pass | `rule-consolidations/2026-11-09T05-31-07-384Z-assistant-1.json` | the 40 rules, the 19,904-char charter, the empty prompt, the 21-op plan |
| the first attempt (restored from) | `rule-consolidations/2026-11-09T05-24-21-775Z-assistant-1.json` | the same before state for the first plan |
| the corrective drop | `rule-consolidations/2026-11-09T05-27-07-888Z-assistant-1.json` | the thirteen-rule state and the one-op drop |
| the role prompts | `role-prompts/2026-11-09T05-24-14-207Z-roles.json` | `roles.json` before the two prompts were written |
| the replay state | `tier-cleanup-2026-11-09/pre-restore-*` | the thirteen-rule list, the 18,983-char charter and `roles.json` with the prompts, copied before the restore |

The pass writes its snapshot before anything else and refuses to run if it cannot: that is what made the restore
possible, and it is the property the design's section 5 promises.

## 7. What this pass did not do

- **The Director's forty rules are untouched.** The brief named Assistant #1's list; the Director's copy is still
  40 rules with a window that leaves 28 out. It is the obvious next pass, and it now has a contract to draw one from.
- **The project tier is still not on main.** The design sends five of the forty to per-project rules; `git grep`
  over `lib/`, `server.js` and `test/` finds no `landingRules`, `deployRules`, `buildRules` or `testRules` at this
  base, so those decisions stayed in the assistant list, narrowed, with their repository reasoning in the charter.
- **The store cap is still 400 characters, not 200.** The rules produced are 190 to 319 characters and the block
  clips an assistant rule to 200 at injection; the narrower store cap is still a design row.
- **The 12,288-byte system block is still unenforced.** #1's block is 13,590 bytes, over the design ceiling, and
  nothing measures it yet.

## 8. How it ran

1. `tools/set-role-prompts.mjs --dry-run` against the live store; both roles read 0 and both seeds fit the seat.
2. `stop-background.cmd`, the port confirmed closed, then `node tools/set-role-prompts.mjs` (snapshot, then one
   write per role) and `node tools/consolidate-rules.mjs --assistant assistant-1 --plan <the plan> --grant`
   (snapshot, the pass, the charter trim).
3. `start-background.cmd`, the port answering, `GET /api/config` reading version 1.70.0.
4. `GET /api/assistant/role/charter?roleId=...` for both roles: 1,088 and 1,125 characters, twelve lines each.
5. `GET /api/state`: 12 / 12 / 12 / 40 rules, the grant on #1's record, the safety and rewritten flags intact.
6. The window proof and the counts table over a copy of the store.
7. `node --test test/roles.test.js test/assistant-consolidate.test.js test/assistant-rules-briefing.test.js
   test/assistant-role-resolution.test.js` - **37 tests, 37 pass, 0 fail**, including the new assertion that both
   built-in roles carry a ten-to-twenty-line contract inside the 1,472-character seat and that it rides a turn.
