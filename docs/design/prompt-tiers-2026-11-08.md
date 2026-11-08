# What a turn is told: five prompt tiers and a twelve-kilobyte contract

**Status:** partly built. Every claim about *today* is a symbol read at `7bc87bf` (`package.json` 1.60.3,
2026-11-08) unless it names a later commit; every claim about *the design* is a decision with its cost stated beside
it. Section 5's consolidation facility is BUILT on this branch (`lib/assistant/consolidate.js`, its routes and its
test), and the rows of section 6 that name it say so. The tiers themselves - project rules, the 12,288-byte block,
the 200-character store cap - remain a design, and section 4 is a migration plan, not a record of one performed.

**The question.** A turn is handed a role prompt, a rule list, a charter, a project list and a queue digest in one
request. Which sentences belong in each, in what order do they arrive, how large may the part that rides every turn
be, and where do the forty rules already on disk go?

**The answer in one paragraph.** Five tiers, ordered by how often they have to be true. The **role prompt** is the
operating contract and rides every turn. **User rules** are the reader's decisions and ride every turn, in twelve
seats. **Project rules** are one repository's deploy, landing, build and test pattern, carried in full in that
project's worker briefs and indexed in the assistant's system block. **Assistant rules** are the model's own notes,
filling only the seats the user rules leave. The **charter** is the long tier, sent whole on the first turn of a
session, on a byte change and every twentieth turn. The four always-injected tiers share a 12,288-byte system block;
the charter is exempt and rides the turn block. A turn may add a rule. Consolidation is the assistant's job, under a
grant the reader gives once on the assistant record: a granted pass may merge rules, drop one, move one into the
charter and set the role prompt, refuses the four unsafe cases by name, and writes a snapshot of the before state
with `rewrittenFrom` provenance on every rule it produces, before it writes anything else.

Contents:

1. [What a turn carries today](#1-what-a-turn-carries-today)
2. [The five tiers](#2-the-five-tiers)
3. [Injection order and the twelve-kilobyte budget](#3-injection-order-and-the-twelve-kilobyte-budget)
4. [The migration](#4-the-migration)
5. [Consolidation: a turn adds, the assistant consolidates under the reader's grant](#5-consolidation-a-turn-adds-the-assistant-consolidates-under-the-readers-grant)
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
withholding. No turn writes it: the model may add to its own list and append to the charter, and when the reader has
granted consolidation (section 5) the assistant may rewrite or merge a reader's rule - its intent survives in the
produced text - but it may never delete one, and the grant itself is the reader's press, not a turn's.

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
supersedes it. Every rewritten rule is marked `rewritten: true` with `rewrittenFrom: [ids]` by the consolidation
pass that rewrote it (section 5), and the pass's snapshot holds the originals, so a summary is never mistaken for
the reader's wording.

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
another rule. Row 20 is the reader's, row 33 is the reader's, and both are rewritten by a GRANTED consolidation pass
(section 5), not by a turn that adds.

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

## 5. Consolidation: a turn adds, the assistant consolidates under the reader's grant

### 5.1 What a turn can do

`addRuleToList` (`lib/assistant/rules.js`) is the door a turn has onto the list, and it has four answers:

- **duplicate** - the exact text is already there; the list is returned untouched, with no journal and no write;
- **refined** - for an assistant rule only, a near-duplicate (Jaccard 0.75) rewrites that rule in place;
- **added** - a new rule appended, with the oldest **assistant** rule traded when the list is at `RULE_MAX` 40;
- **refused** - a list full of the reader's rules has nothing of the assistant's to trade, and the add throws
  `rule-full` rather than silently dropping a reader's rule.

A turn writes `RULE:` lines, which the panel applies as `by: "assistant"`. The reader's Add rule form in the Notes
tab posts `POST /api/assistant/rule` as `by: "reader"`, and the ✕ beside any rule posts
`POST /api/assistant/rule/remove`.

### 5.2 The grant

A turn used to have no way to merge, drop, move or promote a rule, and the design answered that with a
reader-pressed pass. The answer is honest about the risk and wrong about the cost: tidying the list is exactly the
work the reader does not want to do again, and most of the list is the model's own output. What the reader needs is
not to be the hand; it is to be the judgement, applied once and undoable.

So the door is a **grant**, stored on the assistant record (`lib/assistant.js` `setConsolidationGrant`):

```json
{ "consolidate": { "by": "reader", "at": "2026-11-08T21:00:00.000Z" } }
```

`POST /api/assistant/consolidate/grant` with `{ "assistantId": "assistant-2", "granted": true }` writes it;
`granted: false` takes it back. The record is read as a grant only in that exact shape: a hand-edited
`"consolidate": true` is no grant, and a pass reads the RECORD rather than a boolean handed in by its caller, so no
caller can pass `granted: true` around the reader's answer.

### 5.3 The four doors, and the unsafe case each refuses

Built in `lib/assistant/consolidate.js`. Every refusal throws a code, so the route, the page and the test assert the
same word.

| door | does | refuses |
|---|---|---|
| `mergeRules` / `rewriteRule` | several rules become one at the earliest source's position; `rewrittenFrom` names every id it replaced; `by` stays the source's, and is `"reader"` when any source was the reader's | fewer than two ids; an unknown id; an empty or over-400-character text; **a pinned source merged into a rule that is not `safety: true`** (`consolidate-safety-lost`) |
| `deleteRule` | an assistant's own unpinned rule leaves the list | an unknown id; **a reader's rule** (`consolidate-reader`); **a `safety: true` rule** (`consolidate-pinned`) |
| `moveRuleToCharter` | the rule's text lands in the charter as one dated entry naming the id, and leaves the every-turn list | an unknown id; **a pinned rule** (a boundary must not ride a file sent every twentieth turn); **a charter with no room** (`charter-full`: the text is never truncated) |
| `setRolePrompt` | sets the tier-1 seat, stamped `promptBy: "assistant"` with `promptAt` and `promptFrom` provenance | **over 1,472 characters** (the tier's own seat, §3.2); **empty** (the absence of a contract is not a shorter one); **a prompt that already says something without the assistant's stamp** (`consolidate-prompt-reader`) |

Two of these are the safety decisions, stated plainly. A reader's rule is rewritten or merged, never dropped: a
rewrite keeps the answer's intent in the produced text, and a drop keeps nothing. And a pinned rule never changes
tier, because the pin means "the twelve-seat window never leaves this out", while the charter is a file sent once
every twenty turns. The pin itself is part of the record: `safety` and the three rewrite fields survive a reload
(`lib/assistants.js` `normaliseAssistants`), which a test proves by building a second Assistant over the same
directory.

### 5.4 The pass: validate, snapshot, write once, journal

The pass is `POST /api/assistant/consolidate` with `{ assistantId, dryRun, plan }`. `Assistant.consolidateRulesFor`
is the only caller of the module's `consolidatePlan`:

```json
{
  "assistantId": "assistant-2",
  "dryRun": false,
  "plan": {
    "version": 1,
    "ops": [
      { "op": "keep", "id": "cc83737d" },
      { "op": "merge", "from": ["9b850bac", "847590ac"], "text": "A quiet test run is not evidence: match the test child's start time to its launch.", "safety": false },
      { "op": "rewrite", "from": ["d2aecae2"], "text": "Outside oauth2-multi, a tree cut from a non-landing branch still lands by PR.", "safety": true },
      { "op": "charter", "id": "18ab73f1", "because": "one repository's history" },
      { "op": "prompt", "from": ["44f0c1aa"], "text": "Read the queue before the board. Answer a worker only from something written down." },
      { "op": "drop", "id": "f1fa6596", "because": "merged into 9b850bac" }
    ]
  }
}
```

An excerpt, not a whole plan: every rule in the list must be named by exactly one op, whether it is kept,
rewritten, merged, dropped, moved or absorbed into the prompt. A plan that leaves one unaccounted for is refused
with the ids, because a silent skip is how a pass loses a rule.

The pass does five things, in this order:

1. **Validate** the plan: every id exists, no id is consumed by two ops, and every rule is accounted for.
2. **Snapshot** the before state to `<dataDir>/logs/rule-consolidations/<iso>-<assistant>.json`: the whole list, the
   charter, the prompt and the plan. This is the FIRST write, and a pass whose snapshot cannot be written does not
   run.
3. **Write once per store**: the rules array, the charter (the moved entries plus one summary naming the counts and
   the snapshot path) and the profile's prompt. No store is written twice.
4. **Journal** one line per op, then one line naming the counts, the three sizes and the snapshot.
5. **Report** the before and after rule counts and characters, the counts per op, the ids still pinned, how many
   rules the twelve-seat window now leaves out, the charter and prompt sizes, and the snapshot path.

`dryRun: true` is the same validation and the same report with steps 2-4 removed: the counts, the safety rows and
the snapshot it would take. The report is what a Notes tab would print before Apply; the route is what the assistant
calls, and the grant is what the reader presses.

### 5.5 Why the grant is worth the trust

The failure the old design guarded against is real: a model that condenses "never push the oauth2-multi turnover
branch" into "never push a turnover branch" has kept the shape and lost the key material. The grant does not deny
that failure; it makes it (a) named, by the refusal that will not let a pinned rule be merged into an unpinned text,
and (b) reversible, by a snapshot written before anything else and named in the charter and the journal. The reader
still holds the judgement - the grant is theirs to give and to take back, and an ungranted pass is refused at the
record - but they are no longer the only hand that can tidy a list. That is the trade the tiers exist to make: the
short tier has to stay small, and the party that writes most of it is the party that should be able to keep it
small, under a permission that costs one press and an undo that costs none.

---

## 6. What is missing

Each line is an absence measured at `7bc87bf` unless it says it was built on this branch, beside what does exist:

| what the design needs | what is on main today | evidence |
|---|---|---|
| 12 seats, reader-first, left-out count | **built**: `RULE_BRIEFING_MAX` 12 and `briefingRules` | `lib/assistant/rules.js`, landed at `2623e8c` |
| `projects[].landingRules` | **in flight, uncommitted**: `lib/project-rules.js` in the sibling tree `add-per-project-landing-rules-the-carry-4cc45c`, one field, 2,000-character cap, 12-project preamble digest | `git grep landingRules` on main returns 0 |
| `projects[].deployRules`, `buildRules`, `testRules` | **absent** | `git grep deployRules`, `buildRules`, `testRules` over `lib/`, `server.js`, `test/` and `config.example.json`: 0 |
| `safety: true`, `rewritten: true`, `rewrittenFrom` | **built** on this branch: the record schema keeps all four fields across a reload, the consolidation pass writes them, and a test proves the round trip | `lib/assistants.js` `normaliseAssistants`, `lib/assistant/consolidate.js`, `test/assistant-consolidate.test.js` |
| the consolidation route | **built** on this branch: `POST /api/assistant/consolidate` (a plan, a dry run) and `POST /api/assistant/consolidate/grant` (the reader's permission) | `server.js`, `lib/assistant.js` `consolidateRulesFor` |
| a 200-character store cap | **absent**: `RULE_TEXT_MAX` is 400, injected clipped to 200; a consolidation refuses a text over 400, not over 200 | `lib/assistant/rules.js`, `lib/assistant/consolidate.js` |
| a 1,472-character role prompt | **partly**: the reader's form still writes up to `PROMPT_CAP` 8,000; a consolidation may write at most `ROLE_PROMPT_MAX` 1,472 | `lib/assistant/profile.js`, `lib/assistant/consolidate.js` |
| a 12,288-byte system block | **absent**: `briefingBudgetChars` caps the turn half only, defaults to 0 (off), maximum 40,000; nothing measures the system text | `lib/assistant.js` `clipTurnBriefing`, `lib/assistant/config.js` |
| a 10-project list | **absent**: `known.slice(0, 40)` | `lib/assistant.js` `briefingParts` |
| watches off the system block | **absent**: the watches block is 617 bytes of it | `lib/assistant.js` `briefingParts` |
| the charter's own header | **not true today**: it says the panel "injects it in full" | the charter file's first paragraph |
| a Notes tab that can consolidate | **partly**: the tab draws the reader's grant switch and the `rewritten`/`safety` chips; the plan box and its dry-run preview are not built | `public/assistant.js` `renderAssistantPad`, `test/assistant-consolidate.test.js` |
| a test that measures the block | **absent**: the briefing tests read the rules window and the turn budget, not the system total | `test/assistant-rules-briefing.test.js`, `test/briefing-budget.test.js` |

The reader-first window was the first piece, and the consolidation facility is the second: the tier-2 behaviour and
the tidy-up that keeps it inside its twelve seats. Everything else in the table is a plan.

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
- **The consolidation facility**, built on this branch: `lib/assistant/consolidate.js` (the grant read, the four
  doors, the plan, the snapshot), `lib/assistant.js` (`consolidationGrantFor`, `setConsolidationGrant`,
  `consolidateRulesFor`, `consolidationDir`), `lib/assistants.js` (`normaliseAssistants` keeps `safety`, `rewritten`,
  `rewrittenFrom`, `rewrittenAt` and the grant), `lib/assistant/profile.js` (`promptBy`, `promptAt`, `promptFrom`),
  `server.js` (the two routes), and `test/assistant-consolidate.test.js` (13 tests, one per door and one per
  refusal).
- **The measurement**: the live state directory was copied to a scratch sandbox and `Assistant.briefingParts`,
  `systemBriefing` and `turnBriefing` were driven directly, so the numbers in §1.2 are the panel's own functions on
  the panel's own bytes, not a reimplementation. The registry held 177 projects; the preamble listed 40.
- **The in-flight shape**: `lib/project-rules.js` and the `lib/assistant.js` / `lib/jobs.js` diff in the sibling
  worktree `add-per-project-landing-rules-the-carry-4cc45c`, read but not copied. It is uncommitted and not on main.
- **The rules and the charter**: the 40 rules in `assistant.json`, the 30 in Assistant #3's record, and the charter
  text at 19,773 characters, all read through the panel's own store at the same commit. The rewrites in §4.3 are the
  design's text, not a claim about what the store holds.
