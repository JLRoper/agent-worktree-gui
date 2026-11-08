# What a turn is told: five prompt tiers and a twelve-kilobyte contract

**Status:** design, not built. Every claim about *today* is a symbol read at `7bc87bf` (`package.json` 1.60.3,
2026-11-08); every claim about *the design* is a decision with its cost stated beside it. Section 6 is the list of
what does not exist yet, and section 4 is a migration plan, not a record of one performed.

**The question.** A turn is handed a role prompt, a rule list, a charter, a project list and a queue digest in one
request. Which sentences belong in each, in what order do they arrive, how large may the part that rides every turn
be, and where do the forty rules already on disk go?

**The answer in one paragraph.** Five tiers, ordered by how often they have to be true. The **role prompt** is the
operating contract and rides every turn. **User rules** are the reader's decisions and ride every turn, in twelve
seats. **Project rules** are one repository's deploy, landing, build and test pattern, carried in full in that
project's worker briefs and indexed in the assistant's system block. **Assistant rules** are the model's own notes,
filling only the seats the user rules leave. The **charter** is the long tier, sent whole on the first turn of a
session, on a byte change and every twentieth turn. The four always-injected tiers share a 12,288-byte system block;
the charter is exempt and rides the turn block. A turn may add a rule but may never merge or delete one;
consolidation is a reader-pressed pass with provenance and a snapshot, not a model's edit.

Contents:

1. [What a turn carries today](#1-what-a-turn-carries-today)
2. [The five tiers](#2-the-five-tiers)
3. [Injection order and the twelve-kilobyte budget](#3-injection-order-and-the-twelve-kilobyte-budget)
4. [The migration](#4-the-migration)
5. [Consolidation: a turn adds, the reader consolidates](#5-consolidation-a-turn-adds-the-reader-consolidates)
6. [What is missing](#6-what-is-missing)
7. [Open questions](#7-open-questions)
8. [Sources and measurement](#8-sources-and-measurement)

---

## 1. What a turn carries today

### 1.1 Two carriers, and one decision that explains both

`Assistant.say()` builds a turn from two strings and hands them to `Jobs.create` (`lib/jobs.js`):

- `system` is `Assistant.systemBriefing()`, the standing half: identity, role, role prompt, the queue directive,
  autonomy and spawn lines, the projects list, the standing rules, notes, watches and the action grammar. It is sent
  as `instructions` on `POST /v1/runs`, which the gateway applies as the run's ephemeral system prompt and never
  writes into the transcript. Nothing in it depends on the question.
- `preamble` is `Assistant.turnBriefing()`, the moving half: the queue digest when its sweep is due, the board's
  digest or its one-line marker, and the charter's text or its marker. `Jobs.create` puts it *ahead of* the brief in
  the input (`const body = { input: pre + anchored + ... }`), so the model reads the turn block and then the question.

The split is a caching decision, and it is the reason the tiers below are ordered the way they are: a provider's
prefix cache reuses only the bytes a request shares with the previous one, up to the first that moved. The system
half is the same bytes turn after turn; the board and the charter move on a schedule, so they ride *after* it, in
the input, where a change costs only the bytes it adds. Measured before the split, the first call of a turn read
1,536 of 326,319 prompt tokens from cache (0.5%); the comment at `Assistant.briefingParts` carries that number.

### 1.2 The block, measured

The panel's live state holds four assistants: #1 and #2 on the Agent Manager role, #3 on the same role, and the
Director on the Assistant Director role. At `7bc87bf`, with that state copied to a sandbox and
`Assistant.briefingParts()` driving the same code the panel runs:

| assistant | role | role prompt | rules stored | reader's | assistant's | charter | system block |
|---|---|---|---|---|---|---|---|
| Assistant #1 | Agent Manager | 0 chars | 40 | 2 | 38 | 19,685 chars | **15,052 bytes** |
| Assistant #2 | Agent Manager | 0 chars | 40 | 1 | 39 | 19,773 chars | **14,348 bytes** |
| Assistant #3 | Agent Manager | 0 chars | 30 | 30 | 0 | 19,773 chars | **13,680 bytes** |
| Director | Assistant Director | 0 chars | 40 | 1 | 39 | 15,617 chars | **13,093 bytes** |

The system block's sections, for Assistant #2 (the largest rule store):

| section | bytes | lines |
|---|---|---|
| identity, role line and prompt (`before`) | 624 | 5 |
| queue directive | 1,439 | 6 |
| restart, autonomy and spawn | 840 | 7 |
| projects you can spawn in (40 of 177 known) | 3,674 | 43 |
| standing rules (the twelve seats) | 2,623 | 15 |
| notes (1,200-character clip) | 1,210 | 3 |
| watches | 617 | 6 |
| action grammar | 2,697 | 16 |
| the charter sentence and the close | 615 | 2 |
| **assembled system block** | **14,348** | |

The turn half, on the same assistant: the charter's full send is **20,174 bytes**; every withheld turn is a
**458-byte** marker carrying the sha, the length and the cadence.

### 1.3 Five facts the design answers

1. **The role prompt is empty.** All three roles carry `prompt: ""` (the library held three records at this commit;
   the `agent-manager` id was retired at `4a982b0`, and its replacement keeps the same name, charter and empty
   prompt). The every-turn contract is therefore the
   identity line and the action grammar, while the stance (role and remit, hard guardrails) sits in a charter that
   is withheld on nineteen turns out of twenty. Anything that must fire every turn is in the wrong tier if it lives
   only in the charter.
2. **The rules block is the only decision list that rides every turn, and it is a window.** `RULE_BRIEFING_MAX` is
   12 and `briefingRules` takes the reader's rules first (all of them when they fit, the newest twelve when they do
   not) and lets the assistant's newest fill only the places that remain. The block ends with a line naming how many
   rules the window left out. That fix landed at `2623e8c`; before it the block was `rules.slice(-12)` by position,
   and thirty assistant rules pushed every reader rule out. The store holds 40 rules, most at the 400-character cap;
   a rule is injected clipped to 200.
3. **There are no project rules.** `projectRulesOf`, `landingRules`, `deployRules`, `buildRules` and `testRules`
   return nothing in `lib/`, `server.js`, `test/` and `config.example.json`; the per-project config carries the
   remote, `prRepo`, `mainBranch`, `remoteBranchPolicy`, `defaultTurnover` and the two push controls, and no rules
   field. A repository's landing pattern is today a *standing rule* that names the repository, which is how one
   SEFL rule can read as if it governed this panel's own GitHub checkout.
4. **The projects list is the block's largest variable.** 40 projects at about 85 bytes each is 3,674 bytes, 26% of
   the block, and it grows with the estate (177 projects are known). Nothing reads it every turn except a SPAWN
   decision, which needs a name and a path, not forty of them.
5. **The charter is the only long-tier memory, and its own header is stale.** `CHARTER_MAX_CHARS` is 20,000 and
   `CHARTER_RESEND_EVERY` is 20: sent whole on the first turn of a session, whenever the file's bytes move, and
   every twentieth turn, otherwise a marker. The charter file still says the panel "injects it in full" on every
   turn. That sentence describes the build before the cadence and is part of the migration.

---

## 2. The five tiers

The test that decides a tier is one sentence: **does this sentence change what the turn does on a turn where
nothing particular has come up?** If yes, it is the role prompt or a rule. If it only matters when a particular
repository, question or precedent arises, it is a project rule or the charter. If it is a fact about what this
assistant has already learned, it is an assistant rule. The tiers:

| tier | subject | who writes it | where it is stored | carrier and cadence | cap |
|---|---|---|---|---|---|
| 1 | the role prompt | the reader, in the Role tab | the role's `prompt`, or the assistant's own `prompt` as an override | system block, **every turn** | 1,472 chars |
| 2 | user rules | the reader | the `rules` array, `by: "reader"` | system block, **every turn**, 12 seats | 12 x 200 chars |
| 3 | project rules | the reader, in the project's config entry | `projects[].deployRules`, `landingRules`, `buildRules`, `testRules` | full text in every brief in that project; a one-line index in the system block | 1,000 chars per field, 2,000 per brief |
| 4 | assistant rules | the assistant, through a `RULE:` line | the `rules` array, `by: "assistant"` | the system block's **spare seats only** | what tier 2 leaves |
| 5 | the charter | the reader and the assistant | the role's charter, copied per assistant | input block, **turn 1, on a byte change, every 20th turn** | 20,000 chars |

### 2.1 Tier 1: the role prompt is the every-turn contract

The role prompt is the short instruction a turn of that role begins with. `Assistant.briefingParts` reads
`role.prompt` and falls back from an assistant's own `prompt` (the profile file) to it; the role's prompt is live for
every assistant that runs the role. It rides the standing half, so it is in the same bytes on every turn of a
session and never changes with the question.

The design makes it the operating contract: what this job is for, the stance it takes, and the hard guardrails it
never crosses. It is where "read the queue first", "never do the work yourself", "answer only from something written
down" and "never write in a worktree" belong, because those are the sentences that must fire on a turn where nothing
has come up. The test for a sentence is §2's question, and the cost of failing it is the other way round: a contract
that is too long is a charter with a worse cadence.

Cost, stated: the stored cap drops from `PROMPT_CAP` 8,000 to 1,472 characters, which is the tier's budget line in
§3. Anything that does not fit is a fact or a precedent, and both have a home in the charter. The migration cost
today is zero: every role's prompt is empty.

### 2.2 Tier 2: user rules are the reader's decisions, always injected

A user rule is a decision the reader has made once and does not want to give twice: a boundary ("never PROD"), a
correction ("a quiet test run is not evidence"), a preference ("mark a rewritten rule as rewritten"). It is stored
in the assistant's `rules` array with `by: "reader"` and injected on **every turn**, with no cadence and no
withholding. No turn writes it: the model may add to its own list and append to the charter, but the reader's rules
are the one list it may never change.

The window is twelve seats (`RULE_BRIEFING_MAX`). The reader's rules hold their own seats: all of them when they
fit, the newest twelve when they do not, and the block ends with the left-out count so twelve cannot read as the
whole store. The design adds one field, `safety: true`, to a rule: a pinned rule is never the one the window leaves
out, and the window drops the oldest unpinned reader rule first. The three safety intents in §4.5 are pinned at
migration.

The text cap becomes 200 characters **at storage**, not only at injection. A rule that needs more than 200
characters is not a decision, it is a paragraph, and a paragraph that rides every turn belongs in the charter or the
role prompt. The 400-character store cap (`RULE_TEXT_MAX`) is what makes the current list unquotable in a turn: 39 of
the 40 rules in Assistant #1's store are longer than 200 characters, so most of the list is sent as a clipped
sentence.

### 2.3 Tier 3: project rules are one repository's deploy, landing, build and test pattern

A project rule is a sentence that is true of one repository and false of another: how its work lands, where its
artifacts may go, how it is built, and which tests prove a change. It is the tier that makes a SEFL turnover read
differently from this panel's own GitHub PR, instead of one standing rule that names a repository and quietly governs
the others.

The shape is one optional text per subject on the `projects[]` entry in `config.json`, beside the fields the entry
already carries (`lib/projects.js` merges an explicit entry onto the scanned repository by name):

```json
{
  "projects": [
    {
      "name": "optym-integration-multi",
      "deployRules": "Deploy only to DEV, and only the WAR whose bundled jars changed. Never PROD.",
      "landingRules": "One turnover branch per feature, cut from master. Worker branches are rolled back into it locally and never pushed; only the turnover branch is pushed, and its PR goes to master.",
      "buildRules": "Build with the project's Gradle wrapper; the build must pass before a deploy.",
      "testRules": "Run the module's own test file and the gate script; the full suite is not a turn's work."
    }
  ]
}
```

Four rules make the shape load-bearing:

- **Absent is absent.** A field the entry does not carry produces no paragraph, not an empty heading. A repository
  that lands the ordinary way stays invisible to the tier.
- **Each field is capped at 1,000 characters; the brief block is capped at 2,000.** The brief carries the subjects
  that exist in the order deploy, landing, build, test, and ends with a line naming the fields that did not fit. The
  order is a safety decision: a deploy or landing boundary is never the part that is cut.
- **The full text is carried, not remembered.** `projectForRun` resolves the project by name or by the run's tree
  (longest matching root wins, the same containment rule as `isInsideProject`), and `projectRulesBrief` puts the
  text in the brief ahead of the prompt, saying whose rules these are and that they win over the panel's general
  landing paragraph. The assistant is not asked to reproduce the text in its SPAWN line.
- **The system block carries an index, not the text.** A line per project that carries rules (name and subjects,
  about 55 bytes each), ten projects plus a count, 768 bytes. That is enough for the assistant to know that a
  project has a pattern and to write a brief that does not contradict it; the panel appends the pattern itself.

The field names keep `landingRules`, which is the one field already being built in a sibling tree
(`lib/project-rules.js`, uncommitted, 2,000-character cap, a 12-project preamble digest). The design generalises
that field into four and holds the same 2,000-character budget for the brief. The other three do not exist on main;
§6 states that with the grep that proves it.

### 2.4 Tier 4: assistant rules fill only what user rules leave

An assistant rule is the model's own note to itself: a mechanism it learned, a trap it fell into, a correction it
had to make. It is stored with `by: "assistant"` and is second class by construction:

- it may only occupy seats the reader's rules leave (`briefingRules` fills the remainder after the reader's rules);
- it is the first thing the window leaves out when the reader's rules fill the twelve;
- a near-duplicate of one of its own rules refines that rule in place rather than adding a second (`refinedRule`,
  Jaccard 0.75); the reader's rules are never refined this way, because an agent that paraphrased one would be
  editing the reader's mind;
- at the 40-rule store cap, the rule traded for room is the oldest the assistant wrote, never one of the reader's.

The tier has no byte allocation of its own: it spends whatever tier 2 leaves, and the block's ceiling already counts
it. Its value is that it lets the model improve without letting it govern. A model that writes thirty-nine rules for
itself cannot push the reader's one answer out of the text; that is the bug `2623e8c` fixed and the reason this tier
is defined by subtraction rather than by a cap.

### 2.5 Tier 5: the charter is the long tier on its twenty-turn cadence

The charter is the reasoning: why a convention exists, what a past incident taught, which repository has which
history, what is still unsettled. It is 20,000 characters at most, one per role with a copy per assistant, and it
rides the input block rather than the system block. It is sent **whole** on the first turn of a session, whenever
the file's bytes move, and every twentieth turn (`CHARTER_RESEND_EVERY`); on every other turn a 458-byte marker
carries the sha, the length and the cadence, and says the short tier above is never withheld by it.

The charter is the only tier that survives a compaction by being re-sent. That is its whole job: nineteen turns after
the model last read it, the marker is a claim about a file it may no longer hold in context, and the twentieth turn
is the safety net that puts the text back. It is therefore the right home for anything that only matters when a
particular question arises, and the wrong home for anything that must fire on every turn.

It must not carry a second copy of the rules or the notes. The live charter does: "Standing rules carried over (as
they stood on 2026-10-26)" and "Scratchpad notes carried over" are frozen copies of two stores that have moved
since. The migration drops both sections; the store is the authority, and a frozen copy is a second answer that
drifts.

### 2.6 What each tier must never carry

| tier | must never carry | where it belongs instead |
|---|---|---|
| role prompt | paths, commands, repo history, anything that changes | project rules, the charter |
| user rules | a repository's pattern, a paragraph of reasoning, a self-note | project rules, the charter, assistant rules |
| project rules | a decision that applies everywhere, the reason behind the pattern | user rules, the charter |
| assistant rules | a reader's decision, a safety boundary | user rules |
| charter | a rule that must fire every turn, current board state, a copy of the rules or notes | role prompt, the turn block, the stores |

---

## 3. Injection order and the twelve-kilobyte budget

### 3.1 The order

The order is what the model reads, not the order the code assembles it. Positions 1-11 are the system text
(`instructions`); positions 12-15 are the input, with the turn block ahead of the question.

| # | block | carrier | tier |
|---|---|---|---|
| 1 | "You are ..." (identity) | system | - |
| 2 | "Your role: <name> - <description>" | system | - |
| 3 | the role prompt, or the assistant's own prompt | system | **1** |
| 4 | the queue directive | system | - |
| 5 | restart re-attach, autonomy, spawn | system | - |
| 6 | projects you can spawn in (10 + count) | system | - |
| 7 | standing rules: the reader's, in their own seats | system | **2** |
| 8 | standing rules: the assistant's, in the seats left | system | **4** |
| 9 | the per-project rules index | system | **3** |
| 10 | notes (800-character clip) | system | - |
| 11 | the action grammar | system | - |
| 12 | the queue digest, when its sweep is due | input, before the question | - |
| 13 | the board digest, or its marker | input | - |
| 14 | the charter, in full or its marker | input | **5** |
| 15 | the question | input | - |

The order answers four questions in the order a turn asks them: who am I and what am I for (1-3), what do I act on
(4-5), where may I act (6), what has already been decided (7-9), what have I noticed (10), how do I act (11), what is
true this minute (12-13), what do I remember (14), and what was I asked (15). Two details are load-bearing:

- **The reader's rules come before the assistant's in one numbered list**, not two blocks. The turn reads one list of
  answers, with the reader's first and the assistant's filling the rest; two headings would make the model weigh two
  authorities.
- **The project index comes after the rules**, because it qualifies them: a project rule can disagree with a general
  landing rule, and the brief that carries the full text says the project's rules win where they differ. The index
  only tells the turn that the disagreement exists.

### 3.2 The budget

The four always-injected tiers and the furniture they ride in share **12,288 bytes** (twelve kilobytes) of UTF-8
system text. The charter is not in it: it is the long tier, it rides the input on its cadence, and its own 20,000
character cap is a separate budget. The turn half keeps `briefingBudgetChars` (default 0, off; maximum 40,000) and
is not counted here either.

The allocation, against today's measured block for Assistant #2:

| block | today (bytes) | ceiling (bytes) | what changes |
|---|---|---|---|
| tier 1: role prompt | 0 | 1,472 | new text; stored cap 8,000 -> 1,472 |
| tier 2: user rules (12 seats) | 2,623 | 2,688 | 200-character store cap, safety pins, the rewritten count |
| tier 3: project rules index | 0 | 768 | ten projects plus a count |
| tier 4: assistant rules | (inside 2,623) | (the spare seats) | no separate bytes |
| identity, role, autonomy, spawn | 1,464 | 1,280 | one line each, the same words tightened |
| queue directive | 1,439 | 1,390 | the same instruction, one sentence shorter |
| projects you can spawn in | 3,674 | 1,152 | 40 -> 10, plus "(N more ...)" |
| notes | 1,210 | 850 | clip 1,200 -> 800 |
| watches | 617 | 0 | move to the turn block, where state that moves belongs |
| action grammar and the charter sentence | 3,312 | 2,688 | the charter sentence is removed; the grammar keeps its words |
| **total** | **14,348** | **12,288** | **-2,060** |

The today column sums to 14,339 rather than 14,348: the assembled block counts the join newlines between sections,
and the section table in §1.2 counts them once each. The ceiling column sums to 12,288 exactly. The change comes from
the projects list (2,522), the watches block (617), the charter sentence (615), the notes clip (360) and the
tightened identity and directive lines (233), against the new role prompt and project index (2,240) and the wider
rules block (65). Those sum to a 2,042-byte cut; the remaining 18 bytes are the join-newline difference between the
two totals.

Three decisions inside the table are worth naming:

- **The projects list drops from 40 to 10 plus a count.** The capability is unchanged: a SPAWN may name any project
  the panel knows, and the count line says how many are not shown. A turn that needs a path it cannot see reads it
  from the board, which is where it already reads everything else about a row.
- **Watches move to the turn block.** A watch is state that moves (it is set, it alerts, it settles), and the system
  block is supposed to be the same bytes turn after turn. Moving it also removes the last block that changed on a
  watch event from the prefix-cache head.
- **The charter sentence leaves the system block.** The charter's marker already says what the long tier is, what
  the sha is and when it is sent; a second paragraph explaining it in the standing text is 615 bytes spent on a
  sentence the marker repeats.

### 3.3 Enforcement and the cut order

A `briefingBudget` check measures the assembled system text in bytes before `Jobs.create` posts it. Over the
ceiling, the panel cuts in this order, stopping as soon as the block fits:

1. the notes tail, to a floor of 200 characters;
2. the project index's tail, to a floor of three projects;
3. the projects list, to a floor of five plus the count;
4. the assistant's own rule seats, oldest first (tier 4 is already the spare capacity);
5. the oldest **unpinned** reader rules, which is the window's own behaviour, with the left-out count.

It never cuts the role prompt, the action grammar, a pinned safety rule, or the newest reader rule. If the block is
still over after all five cuts, the turn proceeds and the journal records `briefing-over-budget` with the byte count
and the blocks that were cut, because a turn that cannot start is worse than a turn that runs with a shorter list.
A test asserts the budget on a fixture assembled from the live store's shapes, and the panel journals any live
assistant whose block is over it. A second test pins the cut order on a fixture with every block over its ceiling.

---

## 4. The migration

### 4.1 The test

Each existing rule is read with §2's question and one more: **would this sentence still be true in a different
repository?** If yes, it is a rule (user or assistant, by who wrote it). If no, it is a project rule, and the
repository it names is the project. If it only matters when a particular question arises, it is the charter. A rule
that restates another is merged into the one that survives; a rule that is superseded is merged into the one that
supersedes it. Every rewritten rule is marked `rewritten: true` with `rewrittenFrom: [ids]`, and the Notes tab shows
the chip and the original, so a summary is never mistaken for the reader's wording.

The table covers Assistant #1's store, the canonical one: `assistant.json` holds its 40 rules, and #2, #3 and #5
carry seeded copies on their own records. Assistant #3's copy is the reader's own 30-rule condensation of the same
corpus; it maps by intent to the rows below, with about a dozen rules that exist only there (restart assessment,
re-attach through the EXITED chip, the resolve-unknown path, the approval that `/api/approvals` does not list, the
quiet-run criteria, and the two repository landing patterns). Those stay assistant rules by the same test; the two
repository patterns are the project rules in §4.3.

### 4.2 The forty rules

| # | rule, first clause | by | destination | rewritten |
|---|---|---|---|---|
| 1 | an empty branch is not proof work landed | assistant | assistant rule | rewritten |
| 2 | a squash land never zeroes AHEAD; main carries `required_linear_history` | assistant | project: agent-worktree-gui (landing) | rewritten |
| 3 | this repo's `remoteBranchPolicy` is `allow`; the push guard stops a worker | assistant | project: agent-worktree-gui (landing) | rewritten |
| 4 | a fix brief names one endpoint, once | assistant | assistant rule | rewritten |
| 5 | read live job state from `/api/jobs`, never `logs/jobs.json` | assistant | assistant rule | rewritten |
| 6 | a run of patches is not a loop until the diff says so | assistant | assistant rule | rewritten |
| 7 | a quiet `npm test` is evidence of nothing | assistant | merged into 12 | rewritten |
| 8 | a 600-second approval expiring is a loop, not a stall | assistant | assistant rule | rewritten |
| 9 | cleanup never justifies a new worktree | assistant | assistant rule | rewritten |
| 10 | `RELEASE` is a marker line, not a command | assistant | merged into 14 | rewritten |
| 11 | a failed row is judged by outcome and tree | assistant | assistant rule | rewritten |
| 12 | a live `--test` child must match its launch time | assistant | assistant rule (absorbs 7) | rewritten |
| 13 | done is not finished until the branch is landed | assistant | assistant rule | rewritten |
| 14 | a `RELEASE` line is a request, not an eviction | assistant | assistant rule (absorbs 10) | rewritten |
| 15 | an api_server approval is not a person seeing it | assistant | assistant rule | rewritten |
| 16 | `MERGED (N commits)` is a receipt | assistant | assistant rule | rewritten |
| 17 | never push the oauth2-multi turnover branch | assistant | project: oauth2-multi (landing, safety) | rewritten, reason kept |
| 18 | `NO BASE REF` is a config artefact | assistant | charter | rewritten |
| 19 | ambiguous next step: ask numbered options | assistant | assistant rule | rewritten |
| 20 | no em dash, no en dash, anywhere | reader | user rule (safety, pinned) | rewritten |
| 21 | after a restart, prove the served version changed | assistant | project: agent-worktree-gui (build) | rewritten |
| 22 | a watchdog failure naming an ended run is stale | assistant | assistant rule | rewritten |
| 23 | before spawning a queued row, check merged PRs | assistant | assistant rule | rewritten |
| 24 | a parked row cannot be spawned | assistant | assistant rule (absorbs 26) | rewritten |
| 25 | a tier or gate default must fail closed | assistant | assistant rule | rewritten |
| 26 | a held park is not released by its blocker landing | assistant | merged into 24 | rewritten |
| 27 | the assistant can work its own queue through `POST /api/assistant/queue` | assistant | charter | rewritten |
| 28 | a throwaway load generator is bound to loopback and torn down | assistant | assistant rule | rewritten |
| 29 | a lane is not a queue object | assistant | charter | rewritten |
| 30 | keeping the assistants moving is the Director's job | assistant | charter | rewritten |
| 31 | a refs-only task produces no commit and no PR | assistant | assistant rule | rewritten |
| 32 | this checkout is CRLF, the blob is LF | assistant | project: agent-worktree-gui (build) | rewritten |
| 33 | outside oauth2-multi, a non-landing parent does not make work local | reader | user rule (safety, pinned) | rewritten |
| 34 | the oauth2-multi remediation is local-only off the turnover branch | assistant | project: oauth2-multi (landing) | merged into 17 |
| 35 | a worker follows the panel's LANDING block over the brief | assistant | assistant rule | rewritten |
| 36 | landing depends on the remote (GitHub vs SEFL) | assistant | merged into 2, 3, 17 and 34 | rewritten |
| 37 | a `MESSAGE` line is a request, not a delivery | assistant | assistant rule | rewritten |
| 38 | a worker brief names its test files and forbids the full suite | assistant | assistant rule | rewritten |
| 39 | condensing rules must preserve intent and mark a rewrite | assistant | charter | rewritten |
| 40 | a row is in flight only with a running job | assistant | assistant rule | rewritten |

Tally: 2 stay user rules, 23 stay assistant rules, 5 become project rules, 5 move to the charter, and 5 merge into
another rule. Row 20 is the reader's, row 33 is the reader's, and both are rewritten by the reader's own
consolidation pass, not by a turn.

### 4.3 Worked rewrites

The rows that carry a safety intent, and the project rules they become. The originals are quoted from the store; the
rewrites are the design's text.

**Row 20, the dash rule, original (382 characters):** "Never write the em dash (U+2014) or the en dash (U+2013) in
anything you produce: replies, commit messages, PR titles and bodies, code comments, docs, log lines or shell output.
Use a plain ASCII hyphen-minus '-' instead, or rewrite the sentence with a comma, colon or full stop. Those
characters are not in cp1252 and turn into mojibake in Windows console capture and in log files."

**Rewritten (190 characters, `safety: true`):** "Never write U+2014 or U+2013 anywhere - replies, commits, PR titles
and bodies, comments, docs, logs or shell output. Use a plain ASCII hyphen; those characters become mojibake under
cp1252." Every surface, both codepoints, the replacement and the reason survive; the original stays in the
consolidation snapshot and behind the rewritten chip.

**Row 17, the oauth2-multi turnover branch, project: oauth2-multi (landing), `safety: true`:** "Never push the
oauth2-multi turnover branch `20260710_1338_DMR-39015_authorizationCodeFlowPCKE` for a docs, config or review task.
Its history carries a real JWT private key (`oauth2-lib/src/manualTest/resources/sefl-gateway/jwt-private-key.pem`)
in 25 commits plus a named `OKTA_CLIENT_SECRET_VALUE` constant, so a push publishes key material even when the tip
tree is clean." The branch name, the key path and the secret constant all survive because a project rule has 1,000
characters, not 200.

**Row 2, project: agent-worktree-gui (landing):** "A squash or rebase land rewrites the SHAs, so an empty
`git diff <merge> HEAD` is the proof, never an ahead count: this repo's main carries `required_linear_history`, and
`MERGED (N commits)` on a row is a receipt for work already landed. Land with `gh pr merge <n> --rebase --admin`,
then diff content against `origin/main`."

**Row 3, project: agent-worktree-gui (landing):** "This checkout's `remoteBranchPolicy` is `allow`: a worker in a
`wtgui/*` tree may push its branch and open a PR. What stops it is the push guard wanting an approval or
`WTGUI_PUSH_GRANT=1`, not a local-only policy."

**From the charter's Ownership splits, project: heroes-js (deploy):** "The local Docker Desktop stack (heroes-js api
+ web + postgres) is ours to deploy and restart. Deploy nothing else in this repository, and never promise a deploy
of the shared harvester dev server - that half is James's and ends with the rolling harvester issue."

**Designed, project: oauth2-multi (deploy):** "Deploy only to DEV, and only the WAR whose bundled jars changed;
`-service` JARs are never deployed. QA, UAT and PROD require the brief to name the environment and the reader to
approve it." The `deploy-to-dev` skill is the source of the artifact rule, not a standing rule on disk.

**Designed, project: agent-worktree-gui (build):** "`node tools/version.mjs check` before a push; a docs or fix
change is a patch. `server.js`, `lib/**` and `public/**` change the running panel, `tools/**` does not, and a
restart is owed only for the first three."

### 4.4 The charter, section by section

The charter is both a destination and a source. The migration moves four sections out of it, rewrites two in place
and drops two:

| charter section | what it is | destination |
|---|---|---|
| the header, "how it reaches a turn" | says the panel "injects it in full" | rewritten in place: the cadence, the marker and the sha |
| Role and remit | stance | **role prompt** (tier 1), condensed |
| Hard guardrails | stance and safety | **role prompt** (tier 1), condensed; "never edit or delete the reader's rules" becomes the consolidation law in §5.3 |
| Git facts of this repo (agent-worktree-gui) | repo landing and build facts | **project: agent-worktree-gui** (landing, build); the reasoning and the incident history stay in the charter |
| Ownership splits | deploy scope | **project: heroes-js** (deploy); the repository identity line stays |
| Where things live | reference | charter, unchanged |
| Design questions still unanswered | open questions | charter, unchanged |
| How to update this file | procedure | charter, rewritten for the cadence and §5.3 |
| Standing rules carried over (2026-10-26) | a frozen copy of the rules | **dropped**: the rules store is the authority |
| Scratchpad notes carried over | a frozen copy of the notes | **dropped**: the notes file is the authority |
| Changelog | dated history | charter, unchanged; the oldest entries prune first |

The two dropped sections are the clearest evidence that the tiers were needed: a long tier that also carries a copy
of the short tiers is a second answer to a question the stores already answer, and it is the copy that goes stale
first.

### 4.5 The three safety intents

| intent | where it lives today | where it lands | why it survives |
|---|---|---|---|
| no em dash, no en dash | rule 20 (reader, 382 characters), #3's rule 18, and the composing habit | user rule 20, rewritten to 190 characters, `safety: true` | the rewritten text names both codepoints, every surface, the ASCII replacement and the reason; the window never leaves a pinned rule out; the original is in the snapshot |
| never push the oauth2-multi turnover branch | rule 17 (assistant, 400 characters), #3's rule 30 | project: oauth2-multi (landing), `safety: true`, 1,000-character field | the branch name, the key path, the 25 commits and the `OKTA_CLIENT_SECRET_VALUE` constant are all still in the text; the project's brief block is ordered deploy, landing, build, test, so a landing rule is never the part cut |
| deploy only where stated | the action grammar's example ("for example: deploy to QA, never PROD"), the Notes form's placeholder, and the charter's Ownership splits | project: heroes-js (deploy) and each SEFL project's `deployRules`; the grammar keeps its example | heroes-js names the Docker stack as the only thing we deploy; oauth2-multi names DEV and the changed WAR only; no rule anywhere says "deploy" unqualified, and the project rule is carried in every brief in that repository |

The third intent is the one with no standing rule behind it: it lives in an example, a placeholder and a charter
paragraph, none of which a worker's brief carries. Moving it into `deployRules` is what turns it from a habit into a
sentence the worker is handed.

---

## 5. Consolidation: a turn adds, the reader consolidates

### 5.1 What a turn can do today

`addRuleToList` (`lib/assistant/rules.js`) is the only door a turn has onto the list, and it has four answers:

- **duplicate** - the exact text is already there; the list is returned untouched, with no journal and no write;
- **refined** - for an assistant rule only, a near-duplicate (Jaccard 0.75) rewrites that rule in place;
- **added** - a new rule appended, with the oldest **assistant** rule traded when the list is at `RULE_MAX` 40;
- **refused** - a list full of the reader's rules has nothing of the assistant's to trade, and the add throws
  `rule-full` rather than silently dropping a reader's rule.

A turn writes `RULE:` lines, which the panel applies as `by: "assistant"`. The reader's Add rule form in the Notes
tab posts `POST /api/assistant/rule` as `by: "reader"`, and the ✕ beside any rule posts
`POST /api/assistant/rule/remove`. Those are the only two writes the reader has.

### 5.2 What a turn cannot do

A turn **cannot merge two rules into one, cannot delete a rule, and cannot edit the reader's**. That is not a policy
the prompt asks the model to respect; it is the shape of the code. There is no route that takes a rule id and a new
text, no route that takes two ids and produces one, and `addRuleToList` only appends or refines the assistant's own.
A model that wants a rule gone can only say so in its reply; the reader presses the ✕ or the consolidation pass
does it.

That boundary is the answer to "why not let the model tidy the list": a merge is a decision about what the reader
meant, and the model is the one party that cannot be trusted to decide which of two of its own guesses the reader
actually holds. It can propose the merge; it cannot be the write.

### 5.3 The consolidation pass

Consolidation is a reader-pressed pass, `POST /api/assistant/rules/consolidate`, with a plan and a dry run:

```json
{
  "assistantId": "assistant-1",
  "dryRun": true,
  "plan": [
    { "op": "keep", "id": "cc83737d" },
    { "op": "rewrite", "from": ["d2aecae2"], "text": "Outside oauth2-multi, a tree cut from a non-landing branch still lands by PR ...", "safety": true },
    { "op": "merge", "from": ["9b850bac", "847590ac"], "text": "A quiet test run is not evidence: match the test-runner child's start time to its launch ...", "safety": false },
    { "op": "drop", "id": "f1fa6596", "because": "merged into 847590ac" }
  ]
}
```

This is an excerpt, not a whole plan: the pass requires every id to appear, and a real plan names all forty.

The pass does five things, in this order:

1. **Snapshot** the current list to `logs/rule-consolidations/<iso>.json` before any write.
2. **Validate** the plan: every id exists; every removed rule is named by a `merge`, a `rewrite` or a `drop`; a
   `drop` of a reader's rule is refused (a reader's rule can be rewritten, never dropped); a rewrite over 200
   characters is refused; a rewrite that replaces a `safety: true` rule must carry `safety: true` itself; a plan
   that leaves a rule unaccounted for is refused with the ids.
3. **Write once**: one `persist()` of the new array, with `rewritten: true`, `rewrittenFrom: [ids]` and
   `rewrittenAt` on every rule the pass produced. The reader's rules keep `by: "reader"`; the assistant's keep
   `by: "assistant"`.
4. **Journal and charter**: one journal line per operation and one charter entry naming the counts (kept, rewritten,
   merged, dropped) and the snapshot path.
5. **Report** the before and after bytes of the injected block, the pinned rules and their destinations, and the
   ids the twelve-seat window now leaves out.

The dry run is the same validation and the same report with the write removed. Its report is what the Notes tab
prints before Apply: the counts, the safety rows and the snapshot it would take. A plan the model drafts is a
document or a queue row; the reader pastes it into the Consolidate box (or presses Draft, which asks the assistant
for a plan and shows it) and presses Apply. The model never holds the button.

The pass is also how a rewritten rule is marked. A `rewrite` or `merge` operation sets `rewritten: true` and
`rewrittenFrom`; the Notes tab draws the chip and a "show the original" line that reads the snapshot; and the
injected block ends with one line naming how many of its rules are rewritten summaries and where the originals are.
That line is about 70 bytes, which is what the 2,688-byte tier-2 ceiling in §3.2 has room for; a per-rule marker
would cost 132 bytes and push the block over.

### 5.4 Why the boundary is worth the friction

The alternative is a model that can merge and delete, and the failure is not hypothetical: a model that condenses
"never push the oauth2-multi turnover branch" into "never push a turnover branch" has preserved the shape and lost
the key material. The intent check cannot be mechanical, so the reader's press is the judgement, and the snapshot is
what makes a wrong judgement reversible. The model's contribution is real and stays: it reads the list, groups it,
drafts the rewrites and the merges, and files them as a plan. It just cannot be the hand that writes.

---

## 6. What is missing

Every line here is an absence measured at `7bc87bf`, beside what does exist:

| what the design needs | what is on main today | evidence |
|---|---|---|
| 12 seats, reader-first, left-out count | **built**: `RULE_BRIEFING_MAX` 12 and `briefingRules` | `lib/assistant/rules.js`, landed at `2623e8c` |
| `projects[].landingRules` | **in flight, uncommitted**: `lib/project-rules.js` in the sibling tree `add-per-project-landing-rules-the-carry-4cc45c`, one field, 2,000-character cap, 12-project preamble digest | `git grep landingRules` on main returns 0 |
| `projects[].deployRules`, `buildRules`, `testRules` | **absent** | `git grep deployRules`, `buildRules`, `testRules` over `lib/`, `server.js`, `test/` and `config.example.json`: 0 |
| `safety: true`, `rewritten: true`, `rewrittenFrom` | **absent**: a rule is `{id, text, at, by}` | `lib/assistant/rules.js`, `lib/assistants.js` |
| the consolidation route | **absent**: add and remove only | `server.js` has `/api/assistant/rule` and `/api/assistant/rule/remove`; `git grep consolidate` over `lib/` and `server.js`: 0 |
| a 200-character store cap | **absent**: `RULE_TEXT_MAX` is 400, injected clipped to 200 | `lib/assistant/rules.js` |
| a 1,472-character role prompt | **absent**: `PROMPT_CAP` is 8,000 | `lib/assistant/profile.js`, `lib/roles.js` |
| a 12,288-byte system block | **absent**: `briefingBudgetChars` caps the turn half only, defaults to 0 (off), maximum 40,000; nothing measures the system text | `lib/assistant.js` `clipTurnBriefing`, `lib/assistant/config.js` |
| a 10-project list | **absent**: `known.slice(0, 40)` | `lib/assistant.js` `briefingParts` |
| watches off the system block | **absent**: the watches block is 617 bytes of it | `lib/assistant.js` `briefingParts` |
| the charter's own header | **not true today**: it says the panel "injects it in full" | the charter file's first paragraph |
| a Notes tab that can consolidate | **absent**: add, delete and read only | `public/assistant.js` `renderAssistantPad` |
| a test that measures the block | **absent**: the briefing tests read the rules window and the turn budget, not the system total | `test/assistant-rules-briefing.test.js`, `test/briefing-budget.test.js` |

The one built piece is the most important one: the reader-first window is the tier-2 behaviour this design assumes,
and it landed before the design did. The rest is a plan.

---

## 7. Open questions

1. **Refuse or cut when the block is over budget?** The design cuts in a stated order and journals the cut. A hard
   refusal would make an over-long role prompt a panel-wide outage; the cut keeps the turn running and the journal
   names the cost. Which is read depends on whether the reader would rather see a short turn or no turn.
2. **Is `safety` reader-set only, or inferred?** The design has it reader-set, with the three rows in §4.5 set at
   migration. Inferring it from words like "never" would pin half the list and defeat the window.
3. **Do deploy rules belong on the project or the remote repository?** The design says the project, because the
   environment and the artifact live with the checkout and the flow, not with the remote. Two projects on one remote
   can deploy differently.
4. **Does the role prompt belong to the role or the assistant?** The design keeps it on the role with the
   assistant's own prompt as an override that shares the same 1,472-character cap, so a role change cannot silently
   double the budget.
5. **Should the charter keep a copy of the rules?** The design drops the frozen copies and says the store is the
   authority. The counter-argument is that a compaction can lose the rules; the answer is that the rules are in the
   system block on every turn, which is stronger than a copy in a file read once every twenty turns.
6. **What happens to an assistant's rules when its role changes?** The design leaves them with the assistant: the
   role prompt changes, the self-notes are the assistant's own history, and a migration that moved them would lose
   the lessons of the old job.

---

## 8. Sources and measurement

- **The code**, read at `7bc87bf` (`package.json` 1.60.3, 2026-11-08): `lib/assistant.js` (`briefingParts`,
  `systemBriefing`, `turnBriefing`, `preamble`, `charterBriefing`, `clipTurnBriefing`, `say`), `lib/assistant/rules.js`
  (`RULE_TEXT_MAX`, `RULE_BRIEFING_MAX`, `briefingRules`, `addRuleToList`, `refinedRule`), `lib/assistants.js`
  (`RULE_MAX`, `withRuleAdded`), `lib/assistant/profile.js` (`PROMPT_CAP`), `lib/roles.js` (the role shape and
  `ROLE_CHARTER_MAX_CHARS`), `lib/charter.js` (`CHARTER_MAX_CHARS`, `CHARTER_RESEND_EVERY`), `lib/jobs.js`
  (`body.input` and `pre`), `lib/projects.js` (the explicit-entry merge), `public/assistant.js` (`renderAssistantPad`,
  the Add rule form and the ✕).
- **The measurement**: the live state directory was copied to a scratch sandbox and `Assistant.briefingParts`,
  `systemBriefing` and `turnBriefing` were driven directly, so the numbers in §1.2 are the panel's own functions on
  the panel's own bytes, not a reimplementation. The registry held 177 projects; the preamble listed 40.
- **The in-flight shape**: `lib/project-rules.js` and the `lib/assistant.js` / `lib/jobs.js` diff in the sibling
  worktree `add-per-project-landing-rules-the-carry-4cc45c`, read but not copied. It is uncommitted and not on main.
- **The rules and the charter**: the 40 rules in `assistant.json`, the 30 in Assistant #3's record, and the charter
  text at 19,773 characters, all read through the panel's own store at the same commit. The rewrites in §4.3 are the
  design's text, not a claim about what the store holds.
