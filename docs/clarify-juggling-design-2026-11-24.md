# Clarify juggling: the card is the end of every piece of work

This page is a design, not a description. It says where a clarify card is raised today, what the panel can prove about it, and the exact text or code change that makes a four-direction card the default end of every piece of work. Nothing here changes agent behaviour: the only code that ships with it is the gitignore rule for the report page and the gate that would otherwise call an ignored page lost work. Section 6 lists what to build first.

Measured against `5997d923` (agent-worktree-gui 1.168.1, 2026-11-24), on the worktree branch `wtgui/read-queue-row-311-first-88efbf`. Every `file:line` below was printed in this tree at that commit; symbols are named where the claim is structural.

> Verdict: four options can be validated as SHAPE at the panel's seam - four choices, four distinct kind prefixes, the recommended one first - and counted afterwards, but never validated as substance. The .secret.html page is opened by an ABSOLUTE path through `POST /api/open-file`, not by `/api/reports/view`, which is the wave member's chip. And the reader's next-step answer is filed as a queue row by the PANEL at the moment it arrives, so the assistant adjudicates a row instead of remembering a message.

## Contents

1. [Where a card is raised, and what the raise site can validate](#1-where-a-card-is-raised-and-what-the-raise-site-can-validate)
2. [The .secret.html report and the one link that opens it](#2-the-secrethtml-report-and-the-one-link-that-opens-it)
3. [Who offers the next step](#3-who-offers-the-next-step)
4. [Waves: the current wave and the next ones](#4-waves-the-current-wave-and-the-next-ones)
5. [The seven pieces of standing text](#5-the-seven-pieces-of-standing-text)
6. [What to build first: four options](#6-what-to-build-first-four-options)
7. [Appendix A: measurements](#appendix-a-measurements)
8. [Appendix B: files and symbols](#appendix-b-files-and-symbols)

## 1. Where a card is raised, and what the raise site can validate

### 1.1 One raise site for agent cards

Every agent card in the fleet is one tool call, in the gateway, made by the model: `clarify`. The panel does not build the choices and has no route that can refuse them. It hears the prompt on the run's stream and writes the record the page draws:

| step | where | what it does |
| --- | --- | --- |
| the model calls the tool | gateway `tools/clarify_tool.py` (`CLARIFY_SCHEMA`) | validates the call, caps the choices, marks the first one recommended, waits on the platform callback |
| the prompt arrives | `lib/jobs.js:4851`, the `clarify.request` branch | writes `j.question`: key, question, choices, links, base, window |
| the choices are copied | `lib/jobs.js:4889` | `choices: (Array.isArray(evt.choices) ? evt.choices : []).map(String)` - verbatim, never repaired |
| the durable record | `lib/jobs.js` `noteQuestionAsked`, `lib/clarify-history.js` | one row per prompt, updated in place by a re-ask |
| the card | `public/app.js` `questionPrompt`, `questionLinks` | the question, the Links block, the choices, the typed box, the countdown |
| the room | `lib/jobs.js` `waitsOf` (lettered choices) | the same question on the Matrix surface |

Two facts about the gateway end are load-bearing, and both are measured on the installed build at `<HERMES_HOME>/hermes-agent/tools/clarify_tool.py`:

- `MAX_CHOICES = 4`, and the schema says it: "single-select (up to 4 choices - put your recommended option FIRST, the UI marks it '(Recommended)' and auto-appends an 'Other' free-text row)". A four-option rule is exactly at the ceiling, not over it. The fifth row the reader sees is the typed box, not a fifth choice.
- `mark_recommended` suffixes the FIRST choice with "(Recommended)". The panel already reads that suffix (`RECOMMENDED_TAIL` in `lib/jobs.js`, used by `waitsOf`), so "recommended first" is a fact the panel can see, not a hope.

The two panel-owned card shapes are different things and must not be confused with an agent card:

- `lib/branch-kind.js:99` returns `{kind: "clarify", question, choices: kindChoices()}` when a cut names no kind. That is a closed factual question with two correct answers (turnover, local only). Four options there would invent two false ones. It is out of the rule's scope, and the design says so rather than quietly exempting it.
- The assistant's own turns call the same gateway tool, so an assistant card and a worker card reach the panel through the same seam and get the same validation.

### 1.2 The prose ask, which is not a card

A worker that asks in its final paragraph is caught by `looksLikeQuestion` (`lib/assistant/match.js:19`, the `ASK_RE` at :18) and fired as an alert for an assistant whose thread ended in the last fifteen minutes (`lib/assistant.js:4785`). That path has no choices, no link and no record beyond the alert. It is the fallback the design keeps, not the path it promises: an answer to it becomes a reply on the worker's thread, and the worker's thread is the record that dies (section 3).

### 1.3 Can four options be validated at the raise site?

Partly, and the split matters.

**What cannot be validated.** The tool call itself is in the gateway process. The panel cannot refuse a pending prompt: the run is parked, the reader must be able to answer, and a panel that dropped the card would strand the turn the clarify call exists to keep alive. The panel also must not synthesise a choice to make up a fourth: its stated invariant is that a label can never drift from what the tool offered (`lib/jobs.js:4848`), and a made-up label posts an answer the model was never shown.

**What can be validated, at the seam the panel does own.** The `clarify.request` handler is a real raise site for the record, and it can check shape if shape is machine-readable. Choices are plain strings, so the only carrier is a label prefix from a closed vocabulary. That converts prose into a field:

- the four kinds are `Finish:`, `Deeper:`, `Route:`, `Ask:` at the start of the label, one per kind;
- the rule is exactly four choices, four distinct kinds, each prefix present once, recommended first;
- `lib/clarify-shape.js` (new, pure) exports `CLARIFY_KINDS = ["finish", "deeper", "route", "ask"]` and `checkChoices(choices)` returning `{ok, count, kinds, missing, repeated, why}`.

The call site is one line beside the choices copy at `lib/jobs.js:4889`:

```js
choices: (Array.isArray(evt.choices) ? evt.choices : []).map(String).filter((c) => c.trim()),
shape: checkChoices(evt.choices),
```

and the record's `shape` travels to three places: the card (a one-line strip under the question, "this card offers 3 of the 4 directions: no stop-and-ask"), the clarify history row (`lib/clarify-history.js` records it with the question), and the journal. That gives the reader a card that still answers, and gives the panel a number: of the cards asked this week, how many offered four distinct directions. The number is what makes the habit real; a rule in prose has no denominator.

**What "validated" cannot mean.** No prefix check can tell whether four options really differ in kind - four labels reading `Finish: ...` are caught, but `Route: rename it`, `Route: move it`, `Route: delete it`, `Ask: ...` passes the count and repeats the kind only if the prefix repeats. The vocabulary is the whole defence against four shades of one step, which is why the kind is at the front of the label where the reader sees it too, and why the first choice - the one the gateway marks recommended - must be the safe finish unless the agent gives a reason in the question.

**Where the rule can be enforced rather than measured:**

- `lib/clarify.js` `USE_CLARIFY` is appended to every run's input and is the only clarify guidance this repo controls (section 5, piece 1). `tools/verify-clarify.mjs` asserts the exact sentence in the POSTed run body, so the wording cannot drift unnoticed.
- `lib/assistant/actions.js` `actionGrammar` is the assistant's vocabulary. It is the one place a rule about what a card must offer can be stated next to the parser that acts on its answer (piece 4).
- A panel-authored direction card, if one is ever added, gets `checkChoices` in its constructor and refuses to build a bad card. That is the only place a hard refusal is honest, because the panel is the author.

**Verdict.** The four-option rule can be validated as shape at the panel's seam (count, four distinct kinds from a closed prefix set, recommended first) and cannot be validated as substance. The design therefore does three things at once: states the rule where the model reads it, parses it where the panel receives it, and counts it where the reader can see the count.

## 2. The .secret.html report and the one link that opens it

### 2.1 There is no rule today, and one local habit that looks like one

Measured in this tree:

- `.gitignore` is 36 lines and carries no `*.secret.html` and no `*.secret.*` rule. The report the row asks for would be committed by any plain `git add docs/reports/...`.
- `.git/info/exclude:14` in the parent clone carries `docs/reports/*.html`. That is this clone's local habit, shared by every worktree of it, and it is why `git status` never names a report that was written and not added. It is not a convention that travels: a fresh clone, another machine or another project does not carry it.
- The machine's global exclude file is set: `core.excludesFile` is set to a file under the user's home (`<home>/.config/git/ignore`), and it already carries `*.secret.*`. That covers every repository on THIS machine, and no clone anywhere else.

So the row's premise is right: there is no `*.secret.html` rule in the repo, and `docs/reports/*.html` in `info/exclude` is not it.

### 2.2 The rule

One line in `.gitignore`, at the end, under its own comment:

```
# A reader-only page: local by design, never committed - any directory, every clone.
*.secret.html
```

Why the suffix and not the directory: a secret page may sit beside its evidence (`docs/reports/<round>/evidence.json`) or next to a design doc, and a rule tied to `docs/reports/` breaks the first time a page moves. The suffix is the only part of the name that means "this page is for the reader's eyes and not for the history", so the suffix is the rule. `*.secret.html` matches at any depth in any directory of this clone.

"Everywhere" is two layers, and both are needed:

| layer | what it covers | where it lives | travels? |
| --- | --- | --- | --- |
| the repo rule | every clone, worktree and CI checkout of agent-worktree-gui | `.gitignore`, committed | yes |
| the machine rule | every repository this machine touches | `core.excludesFile` (`<home>/.config/git/ignore`, already `*.secret.*`) | no, it is a machine setting |

The fleet convention for other SEFL projects is the same one-line repo rule; a later row can have the panel check a project's `.gitignore` for `*.secret.html` at boot the way it already checks other project rules. Nothing in this design depends on the global file: the page is ignored on a machine that has only the repo rule.

### 2.3 Where the page may be written

Under `docs/reports/` in the run's own worktree, named `<design>-<date>.secret.html`. Three routes and a boundary decide it:

- `POST /api/open-file` opens a file only inside an open project, the panel's own checkout, or the two scratch roots (`server.js:7190`, the roots built by `lib/paths.js` `openFileRoots`). A page under a project worktree is inside the boundary; a page in the home directory is not.
- `routes/reports.js` knows `docs/reports` as `REPORTS_DIR` and lists a branch's pages from the tree, so the page is in the one folder the reports feature already reads.
- The tree is what the reader deletes. A page in the panel's data directory would outlive the work it describes and would be state pretending to be source.

Not the scratch directory, for the page the card is about: `SCRATCH` is where throwaway files go and the panel prunes it; a page the reader is asked to open later must sit where the reader expects the work to be. Not the panel's state directory: it is not a project root, so the opener refuses it anyway.

### 2.4 How the card links it, and which route survives

The card already has the mechanism, and this section settles which of the two candidate routes the link uses.

**The surviving route: an absolute path in `links`, through `POST /api/open-file`.**

| step | code | result |
| --- | --- | --- |
| the agent writes the link | `clarify(question, choices, links: [{label: "the report", path: "<tree>/docs/reports/<name>.secret.html"}])` | one label, one absolute path |
| the panel normalises it | `lib/clarify-links.js` `linksOf` -> `linkOf` | `{kind: "file", target: "<tree>/docs/reports/<name>.secret.html", label}` (a drive path is recognised before the URL-scheme test, `lib/clarify-links.js:87`) |
| the card draws it | `public/app.js` `questionLinks` -> `fileAnchor` (`public/core/dom-format.js:213`) | an anchor with `data-open-file`, no href, and the reserved Links block names the browser |
| the click | `POST /api/open-file` (`server.js:7165`) | `resolveFileTarget` (`lib/open-url.js`) resolves an absolute path as given, stats it, checks the roots, then `openFileWith` |
| the tab | `lib/open-url.js` `openFileWith` | `file:///` URL, one argv element, the registered browser (`GET /api/open-file` answers `MSEdgeHTM` on this box), a second click within five minutes answers `reused` |

**The route that does not survive as the card link: `/api/reports/view`.** It stays, for the wave member's reports chip, and the reasons it cannot be the card link are all in its own code:

- it needs `thread` AND `task` (`routes/reports.js:395` `find`), and a worker's prompt does not carry its thread id; the task id it may know, the pair it does not;
- it resolves a RELATIVE path under the task's tree and refuses an absolute one by name (`routes/reports.js:98`);
- it 404s when the queue row is gone, so a card clicked after the row was pruned loses the page even though the file is still there;
- it serves under `sandbox allow-scripts` with `default-src 'none'` (`REPORTS_CSP`, `routes/reports.js:50`), which is right for a page the panel lists, and irrelevant for a self-contained one the reader opens from the card.

The two are complementary, not rivals: the chip answers "which reports did this task leave", keyed on the row; the card answers "open this page now", keyed on the file. The design uses both and keeps one meaning for each.

One measured nuance the implementation must state: a `.secret.html` page is invisible to `git status --untracked-files=all`, so `routes/reports.js` `treeReports` (which reads exactly that) will not list it while it is new. The chip still finds it after settle through the deliverables store, because the `DELIVER` line records its path; the card's link does not depend on either read.

### 2.5 The proofs, as run

Four checks were run on this tree, and the answers are quoted rather than summarised:

| proof | the command | the answer |
| --- | --- | --- |
| the rule really ignores the page | `git check-ignore -v docs/reports/clarify-juggling-design-2026-11-24.secret.html` | `.gitignore:44:*.secret.html` - the committed rule, not the clone's `info/exclude` |
| the rule travels alone | a scratch repo with only `*.secret.html` in its `.gitignore`, global excludes disabled | both the top-level and the nested secret page are absent from `git status`; `docs/reports/plain.html` is still `??` |
| the card's link opens THIS file | `lib/clarify-links.js` `linksOf({label, path})` then `lib/open-url.js` `openFileWith` with a stub `spawn` | `{kind: "file"}`, then one argv element reading `file:///...clarify-juggling-design-2026-11-24.secret.html`, `via: "default browser"`, and no process started |
| the page renders | headless Edge on the `file:///` URL, `--dump-dom` | exit 0, the `<title>` present and `checkChoices` found in the rendered DOM |

The card itself was drawn by the shipped renderer, not by hand: `questionPrompt` and `questionLinks` sliced out of `public/app.js`, the record's `links` through `linksOf`, and this is the anchor it produced for the report (the tree is shortened here; the run printed the absolute path):

```
<a class="tq-link" href="#" data-open-file="<tree>/docs/reports/clarify-juggling-design-2026-11-24.secret.html"
   title="open <tree>/docs/reports/clarify-juggling-design-2026-11-24.secret.html in Microsoft Edge">the report
   <span class="tq-link-where mono"><tree>/docs/reports/clarify-juggling-design-2026-11-24.secret.html</span></a>
```

The four choices the same call drew were `Finish: land this design and the .gitignore rule, and stop there`, `Deeper: build the seam check (lib/clarify-shape.js) and the count first`, `Route: build the answer-to-row bridge and the wave ask first` and `Ask: park the build and put the design to the assistants`. That is the card this run ends on, and it is the four kinds section 1 asks for.

The two negative results matter as much as the positives. `/api/reports?thread=<row>&task=311` answers `count: 0` with `skipped: [{source: "tree", why: "no .html report under docs/reports was added or changed on this branch"}]` - the page is right there and the git read cannot see it, which is why the card's link is the reliable path. And `GET /api/reports/view` on the same row DOES serve the page (200, the sandbox CSP), which is what keeps it a valid chip and not a valid card link.

### 2.6 What every secret page carries

The page is the whole case behind the decision, not a summary of it. Six blocks, in this order, because a reader reads the first two before deciding whether to read the rest:

1. What the agent just did, in three to six sentences, and the tree, branch and commit it did it at.
2. The evidence, inline: the commands run and their real output, the `file:line` citations, the counts. A claim without a command belongs in section 3 as guidance, not here as evidence.
3. The guidance behind the options: what the reader would need to know to prefer one, including the one thing the agent is unsure about.
4. The four options, each with what it costs and what it forecloses. The card's labels match these headings word for word, so a choice on the card can be read in full on the page.
5. Drafted comments, only when the card is a review decision: one comment as the reviewer (ready to post) and one as the reviewee (the reply to a finding), each labelled with the comment id or the file and line it answers. Never posted by the agent.
6. The decision record: what was chosen, when, and where the resulting row or wave member lives. Empty until the card is answered.

The four labels are the same four kinds as section 1: `Finish:`, `Deeper:`, `Route:`, `Ask:`.

## 3. Who offers the next step

### 3.1 The position, stated

The position to test: a worker may PROPOSE next steps in its card, but the answer must route through the assistant that owns the queue, which files the row or the wave member, because a card is answered into the thread that raised it and that thread's record dies with its tree.

### 3.2 What the code says

Four measured facts decide the argument.

- **The answer goes to the asking thread by default.** `lib/clarify-answer.js` `answerDelivery` returns `resume` when the parked run takes the answer, `reply` when it had ended (a reply on the asking thread), `fresh` only when the caller asks, and `refuse` when the run was stopped or the gateway refused. In every non-refused mode the answer continues the WORKER's session. Nothing in that path writes a queue.
- **The worker's record is bounded and can go.** The job store keeps `KEEP_JOBS = 80` conversations, newest first (`lib/jobs.js:195`); the message view is a seven-day window over that store (`lib/assistant/messages.js`); the tree can be released and removed when its row lands. The queue file is the durable record: `state/assistants/<id>/queue.json`, `TASK_CAP = 200`, every row carrying `createdBy`, `thread`, `runId` and `waveId` (`lib/assistant/queue.js:64`, `:66`).
- **The panel already records what a worker says at settle.** `lib/jobs.js` harvests TODO, RELEASE, DELIVER, REVIEW and COLLISION lines from the run's final message (`harvestRelease`, `harvestDeliverables`, `harvestReview`, `harvestCollisions`). The precedent is exactly "the worker writes a sentence, the panel writes the record".
- **The panel already files rows as itself, idempotently.** The collision sweep files a row with `assistant.queueMutate(..., { by: "panel", carriedKey })` (`server.js:3369`, `fileCollisionRow`), so a replay cannot double-file. That is the shape the answer seam needs.
- **A worker can reach the panel on loopback.** `authorised` returns true for a loopback request (`lib/http/transport.js:136`). So "a worker cannot write its own row" is false; the rule that a worker must not is a rule about provenance, not a permission, and the design must not pretend otherwise.

### 3.3 The verdict: defend the split, and move the recorder

The position is right about WHO may not file: the worker. It is wrong about WHERE the recording happens, if "route through the assistant" means "send the answer to the assistant's thread and let it file". A message to an assistant is not a record:

- the assistant may be asleep, between wakes;
- its thread may be live, and a second run on that thread is refused by the panel's own one-run-per-thread rule;
- a message is a turn, and a turn is not a row: the queue's `add` is the only write that survives the thread.

So the refined split has three roles, not two:

| who | may | may not | why |
| --- | --- | --- | --- |
| the worker | propose the four directions, name the report, state the evidence | file a queue row, open a wave member, attach an initiative | its thread's record dies (80 jobs, 7 days, a removable tree) and its proposal would be lost with it |
| the panel | record the chosen direction as a queue row in the owning assistant's queue, at the moment the answer arrives | invent a direction the card did not offer | it is the only actor present at the answer, and it already files rows as `by: "panel"` with a carried key |
| the assistant | adjudicate that row on its next wake: keep, edit, merge, park or close it; add wave members | need to remember the answer to file it | the queue is the record; the assistant decides what the work is, not whether the record exists |

The write itself is one call in `lib/assistant.js` `deliverClarifyAnswer`, after the delivery mode is chosen and before the method returns:

```js
// The reader's choice is a piece of work, and a piece of work is a row. Filed by the PANEL, in the queue of the
// assistant that owns the asking thread, with the question's own key as the carried key: a replayed answer or a
// second click cannot file it twice, and the assistant adjudicates it on its next wake instead of remembering it.
const filed = this.fileAnsweredDirection(job, answerText, { by: "panel", origin: "clarify-answer" });
```

`fileAnsweredDirection` is new on the assistant; it resolves the owning assistant with the same lookup the queue digest uses (`historyNamesFor(j).assistantId`), refuses when the answer is a refusal mode or a `Finish:` that ends with no next step, and calls `queueMutate(<owner>, "add", { title, detail, waveId }, { by: "panel", carriedKey: filingKey("clarify-answer", job.question.key, owner) })`. The row's title is the chosen label with its kind prefix stripped; its detail names the question, the report link and the asking thread; its `waveId` is lifted from the asking row when that row is a wave member.

This beats the original split on the failure the reader actually worries about: work described in a card and answered by the reader is documented even if the assistant never wakes, even if its thread is busy, and even if the worker's tree is removed ten minutes later. It also keeps the deterministic half (the row) out of the probabilistic half (the assistant's memory).

One rule the design does NOT add: the panel does not file a row for `Ask:`. The stop-and-ask kind is a request for a different question, not a piece of work, and a row that reads "ask again" is noise the assistant has to close.

## 4. Waves: the current wave and the next ones

### 4.1 Where the offer belongs

The wave driver is the only clock a wave has. `lib/waves-driver.js` `advanceSettle` is called once per settle by the job store's `onTurnSettled`, and `planWaveAdvance` already decides every case. Three of its outcomes are exactly the moments a card should end the wave's movement:

| outcome | line | state | what a person would do |
| --- | --- | --- | --- |
| `no-queued` | `lib/waves-driver.js:242` | the wave is open and holds no queued member | add a member to THIS wave, or close it |
| `next-empty` | `lib/waves-driver.js:184` | the wave is done and the next wave has no members | say what the next wave is, or finish |
| `done` (last wave) | `lib/waves-driver.js:177` | the wave is done and there is no next wave | propose the next waves, or close the initiative |
| `next-no-queued` | `lib/waves-driver.js:212` | the next wave opened and holds nothing queued | the same question, one wave later |

The driver must not answer any of them itself: it has no evidence for a direction, and a driver that invents a member is the "undocumented work" defect with a machine's face. So the plan grows one field and one stamp action, and nothing else:

```js
// The plan's new field, set at no-queued / next-empty / done / next-no-queued and null everywhere else.
ask: { waveId, initiativeId, kind: "top-up" | "next", why, evidence: { ... }, owner: { assistantId } }
```

The stamp action is `"asked"`, added to `WAVE_ADVANCE_ACTIONS` (`lib/assistant/queue.js:535`). A stamp is evidence, never state: the wave's own state is still the fold's.

### 4.2 Who is asked, and how the card gets raised

The owner is the assistant of the row that settled (`settleCard(rows, settle).assistantId`), because that is the assistant whose queue holds the work and whose tree is about to be free. The driver's job ends at a wake: it hands the owner a wave line built from the same fold the board reads (`waveLane`, `lib/waves.js:1820`), and the owner raises the card with its own `clarify` call in that turn. That keeps one raise site (section 1) and one author for the four options (the agent that has the evidence).

The wave line the driver writes into the wake is the why, not a summary: `W2 has no members (initiative <id>, position 2 of 4). W1 closed on membership: #311 done. The next direction is a card: Finish / Deeper / Route / Ask.` The assistant's turn then has the wave id, the position, the members and the reason in front of it, which is what its four options need.

### 4.3 Where the wave state reaches the assistant

`lib/assistant.js` `queueBriefing` is the turn half of the queue digest, gated by `queueSweepEveryNWakes`. A `waveBriefing` block belongs beside it, built from the same fold:

```js
// In the queue digest's turn block, after the rows: one line per wave the assistant's rows belong to.
"Waves in your initiatives (position, state, members open/done, next wave):",
"- W1 \"<title>\" -> done (2 members, 0 open); W2 -> empty (no members); auto off, so W2 opens by hand",
"- W3 \"<title>\" -> blocked: #498, #499 are parked; entry gate pr not named"
```

Same source as `GET /api/waves` and the initiatives tab, so a prompt cannot disagree with the board. The block is not standing text: it moves when a member moves, and it rides the digest for the same reason the rows do.

### 4.4 What evidence makes an option worth offering

An option with no evidence behind it is a guess wearing a choice's clothes. Each of the four names one read field and one sentence, and the card offers only the options its evidence supports; an option that cannot be supported is dropped (and the card is then visibly short of four, which section 1's shape check reports):

| kind | the evidence that makes it worth offering | where it comes from |
| --- | --- | --- |
| `Finish:` | the wave's own fold says done or holds nothing open, and the settled row's PR reads MERGED or the work is landed | `waveLane` `state`, `stateWhy`, `members`; the row's `pr` and verdict |
| `Deeper:` | the settled run's final message names an open concern (a review finding, a failing test, a TODO it could not close) AND a concrete file or task the fix would touch | the job's `finalMessage`, the tree's TODO list, the row's `reason` |
| `Route:` | a different wave exists (next position) or a different lane set with no shared tree, or the work can move to another initiative | `waves[index + 1]`, `wave.lanes`, `waveLane.laneRefused` |
| `Ask:` | a gate reads cannot tell, a hold is manual, or the fold's `stateWhy` names a condition the panel cannot read | `gates.*.cannotTell`, `hold.kind`, `autoOpen.why` |

The current-wave top-up is the same four options with the wave held fixed: `Deeper:` is the one that adds a member to THIS wave. The member is a queue row that names the wave in the same write, which already works: `addTask` passes `waveId` through `pickTask` (`lib/assistant/queue.js:964`, `:830`), so `queueMutate(owner, "add", { title, detail, waveId })` is one write, and the following `SPAWN #<id> <project> | ...` carries it.

When no next wave exists at all, the four options are about the initiative, not a wave: `Finish:` closes it, `Deeper:` opens one more wave on the same subject, `Route:` names a different subject or initiative, `Ask:` parks the initiative and lets the reader choose. The card's page carries the proposal for each (a wave title and its first member), so the reader is choosing a shape, not a word.

## 5. The seven pieces of standing text

Seven pieces shape the habit. Each row names the file, the exact insert and what would prove it took effect. The wording is written to be pasted, not paraphrased: a rule restated in different words at each site is how the fleet ends up with four vocabularies.

### Piece 1: the instruction every run carries

File: `lib/clarify.js`, the `USE_CLARIFY` constant at :63 (the sentence appended to every run's input on a gateway that delivers a question). Replace the third sentence and keep the links sentence:

```
Note: this gateway build delivers a `clarify` question. If you need a decision from the reader, call the clarify tool with your question and the choices you would accept, and wait - the answer comes back into this same turn. Do not end your turn on the question in prose: that stops the run with the work unfinished. A card that ends a piece of work offers FOUR choices that differ in kind, each labelled with its kind first - `Finish: ...` the safe finish, `Deeper: ...` the deeper fix, `Route: ...` the different route, `Ask: ...` the stop-and-ask - with the one you recommend first; four shades of one step is not a card. If the decision needs the reader to look at something, pass it as `links` (one `{ label, url|path }` per thing) and the card draws an anchor for it; a bare path or URL in the question text is linked too.
```

This is the panel's stand-in for the tool description. The gateway's own `CLARIFY_SCHEMA` text says "up to 4 choices" and marks the first recommended, but it is not this repo's file and the panel cannot ship a change to it; the fleet gets the four-kind rule through the sentence the panel controls. A separate ask to the Hermes repo can put the same words in `CLARIFY_SCHEMA`, and that is the only way the tool description itself stops being silent about kind.

Proof: `tools/verify-clarify.mjs` reads the body POSTed to the stub Runs API and asserts the sentence, so the wording is already under a gate. Add one assertion there: the body contains `Finish:` and `Ask:`, not only "delivers a `clarify` question".

### Piece 2: the worker brief the panel writes at a SPAWN

File: `lib/jobs.js`, `CLARIFY_LINKS_BRIEF` at :279. Add one sentence after the links example:

```
A page the reader may need to look at twice is written as `docs/reports/<name>.secret.html` and linked with its ABSOLUTE path: the `*.secret.html` suffix is ignored by git, so the page is never committed, and the card opens it in the reader's browser tab.
```

File: `lib/jobs.js`, `REPORT_BRIEF` at :298. Replace the third line:

```
Declare the report on a `clarify` card as a `links` entry with an absolute `path` and a label that says what it is (`the report`, `the audit`, `the benchmark`), and turn the recommended next steps into that card's FOUR choices, one per kind (`Finish:`, `Deeper:`, `Route:`, `Ask:`), the recommended one first.
```

File: `lib/jobs.js`, the SPAWN brief sentence in the assembled text at :4298 ("Use `clarify` when a genuine direction decision is needed ..."). Replace "offers two to four numbered next directions as the choices" with:

```
offers FOUR next directions as the choices, one per kind - a safe finish, a deeper fix, a different route and a stop-and-ask, the recommended one first
```

Proof: `test/report-brief.test.js` already reads the rendered brief off a stub Runs API; add an assertion that the rendered body carries `Finish:` and the four-kind phrase, and one that `CLARIFY_LINKS_BRIEF` names `.secret.html` and the absolute path.

### Piece 3: the standing directive every assistant preamble carries

File: `lib/assistant.js`, `queueDirectiveLines` at :377. Add one bullet after the "Mark a task done only when its PR reads MERGED" line:

```
- When a piece of work ends, its card offers four directions - `Finish:`, `Deeper:`, `Route:`, `Ask:` - and the direction the reader picks is a ROW in a queue before your turn ends. A choice that lives only in your reply is work nobody will do, and a prose answer to a worker is not a record.
```

Proof: `test/assistant-queue-directive.test.js` pins the directive's lines for Assistant #1 and a second assistant; add the phrase to its list. `test/assistant-system-briefing.test.js` already asserts the directive rides the system briefing and is absent from the turn half.

### Piece 4: the assistant's action grammar

File: `lib/assistant/actions.js`, `actionGrammar` at :166. Add two lines before the TODO line:

```
A worker's card may PROPOSE the next step, but YOU are the one who records it: when an answer names a direction, file the row in the same turn (`QUEUE <assistant> | ...` or carry it with `SPAWN #<id> ...`) and say which row you filed. A proposal with no row is a suggestion the tree takes with it.
When a wave has no queued member, or has ended and the next wave is empty or missing, ask the reader with FOUR directions for that wave (`Finish:`, `Deeper:`, `Route:`, `Ask:`) and carry the answer into the wave: a member is a `QUEUE` row that names the wave, then `SPAWN #<id> <project> | ...`.
```

The second line assumes `QUEUE` is available. It is today only to the Assistant Director (`actionGrammar` lists `QUEUE` under `director`). The implementation adds `QUEUE` for every assistant, scoped to its own queue (the resolver already refuses an assistant it cannot place); that is a small widening of a power with a named refusal, and it is what lets a non-director assistant top up its own wave.

Proof: `test/assistant-system-briefing.test.js` asserts the grammar appears in the system briefing; add the four-kind line to its expected strings. `tools/verify-action-harvest.mjs` drives `parseActions`; a `QUEUE` line for a non-director must file exactly one row in the test's harness, which is the failing-first test for the widening.

### Piece 5: the charter seed

File: `lib/charter.js`, `charterTemplate` (the `## Role and remit` section is where a new section belongs, after it). Insert:

```
## Every finished piece of work ends in a card

- The card is the decision, and the report behind it is a `docs/reports/<name>.secret.html` page linked with its absolute path: ignored by git, opened in the reader's browser tab, carrying what was done, the evidence, the guidance and the four options.
- The four options differ in kind: `Finish:` the safe finish, `Deeper:` the deeper fix, `Route:` the different route, `Ask:` the stop-and-ask. The recommended one is first, because the card marks it.
- A worker may propose; the panel records the chosen direction as a row in the owning assistant's queue; the assistant adjudicates it. No one else files work, and no choice stays only in a reply.
- A wave that has no queued member, or ends with an empty next wave, gets the same four directions about the wave before anyone opens another one.
```

Proof: `tools/verify-charter.mjs` and `test/assistant-charter-line.test.js` read a seeded charter; add an assertion that a fresh seed contains `Finish:` and the word "adjudicates".

### Piece 6: the role charters

Files: `data/roles/assistant-agent-manager.md` (the agent manager's long tier) and `data/roles/assistant-director.md` (the director's). Both are seeded into the role library by `lib/roles.js` (the two `SEED_*_CHARTER_URL` constants) and become an assistant's charter at creation. Add the same section to both, worded for the role:

For the agent manager, after "## Role and remit":

```
## The card ends the work

When a worker finishes, the thing it hands over is a card: four directions that differ in kind (`Finish:`, `Deeper:`, `Route:`, `Ask:`), the recommended one first, and a `docs/reports/<name>.secret.html` page behind it. You file the row the reader picks; the worker never does. A worker that ends on a prose question has left you an alert, not a record, and you should turn it into a card rather than answer it in the reply.
```

For the director, after "## What counts as work for you":

```
## The card is the record

A row that ends with a card has a next direction, and the direction the reader picks is a row in the queue of the assistant that owns the work. Read for the card that was never raised: a row marked done by a reply, a wave with no members, a worker that ended on a question. Those are your passes, and each one ends with a card of four directions, not with a sentence in your reply.
```

Proof: `test/assistant-role-resolution.test.js` and `tools/verify-assistant-role-picker.mjs` read the role library; add an assertion that a role created from either seed carries its section. The role files are copied at creation, so the proof must create an assistant from the seed, not read the source file only.

### Piece 7: the contract docs, and the tool description that is not ours

Files: `docs/clarify-over-the-runs-api.md` (append a "The four directions" section stating the vocabulary, the seam check and the count), `docs/worker-brief-report-cards.md` (replace "the recommended next steps as that card's choices, in the order the agent recommends them" with the four-kind wording), and a new `docs/worker-brief-clarify-cards.md` that explains pieces 1, 2 and 4 the way `docs/worker-brief-report-cards.md` explains the report paragraph.

The gateway's `CLARIFY_SCHEMA` in `hermes-agent/tools/clarify_tool.py` is the tool description the agents actually read, and it is not this repository's file. It already says "up to 4 choices" and "put your recommended option FIRST"; it does not say the four must differ in kind. The panel cannot change it, so the design does not pretend to: piece 1 carries the rule into every run, and a separate request to the Hermes repository adds one sentence to the schema and its `description` string for the builds that adopt it.

Proof: a doc test is a link check plus a quote check. `tools/absolute-paths.mjs` must stay clean on the new docs, and `docs/worker-brief-clarify-cards.md` should quote the same sentences as piece 1 and piece 2 so a later edit that changes one and not the other is visible in review.

## 6. What to build first: four options

The design is complete enough to build from. These are the four next directions, in the order this report recommends them, and they are the same four kinds the design asks every card to offer.

### `Finish:` land the rule and the report mechanism, stop there

This landing already carries the `.gitignore` line and the gate exemption. The next two commits add the design doc's own claims as tests: `*.secret.html` is ignored in a scratch repo, and `untrackedReports` does not call a secret page lost. Nothing else changes. The fleet keeps its current card behaviour, and the report page has a home that git will not commit.

Cost: two commits, no behaviour change. Forecloses nothing.

### `Deeper:` build the seam check and the count

Add `lib/clarify-shape.js` with `checkChoices`, call it at `lib/jobs.js:4889`, store `question.shape`, draw the one-line strip on the card, record `shape` in the clarify history and add the "cards offering four directions this week" count to the Clarify popup. This is the smallest change that turns the rule from prose into a measurement, and it is the one that tells the reader whether the wording in piece 1 works before any further text changes.

Cost: one pure module, one call site, one card line, one history field, one counter. It cannot block a card, so it cannot strand a run.

### `Route:` build the answer-to-row bridge first

Implement `fileAnsweredDirection` and the wave `ask` in the same landing, before the vocabulary changes. That makes every answered card leave a row (or a wave member) even while cards still have two or three choices, which is the reader's real worry answered first. The four-kind wording then lands on top of a mechanism that already records.

Cost: the seam in `deliverClarifyAnswer`, the driver's `ask` field and `"asked"` stamp, the wave block in the digest, and the `QUEUE` widening in the grammar. This is the largest of the four and the one that changes behaviour most.

### `Ask:` park the implementation and put the design to the assistants

No code beyond this landing. The two role charters and the director's pass are asked to read this page and answer one question: is there a case where a worker's card must file its own row because no assistant is awake and the work is urgent? If the answer is no, the split in section 3 stands and the build order above is the plan. If it is yes, the exception is named before the seam is written, not after.

Cost: a round trip with the reader, and the build waits. It is the right choice only if the recording rule is still contested after this page.

## Appendix A: measurements

| what | how it was measured | result |
| --- | --- | --- |
| no secret rule in the repo | `grep -n "secret" .gitignore` and reading the 36 lines | no `*.secret.html`, no `*.secret.*` |
| what ignores a secret page today | `git check-ignore -v docs/reports/<name>.secret.html` | `.git/info/exclude:14 docs/reports/*.html` (clone-local), nothing from `.gitignore` |
| the machine's global rule | `git config --get core.excludesFile` and reading the file | a path under the user's home, and the file carries `*.secret.*` |
| the gateway caps choices at four | reading `<HERMES_HOME>/hermes-agent/tools/clarify_tool.py` | `MAX_CHOICES = 4`, first choice marked `(Recommended)`, "Other" appended by the UI |
| the panel copies choices verbatim | `lib/jobs.js:4889` | `.map(String)`, no repair |
| the answer continues the asking thread | `lib/clarify-answer.js` `answerDelivery` | `resume` / `reply` / `fresh` / `refuse`, default `resume` |
| the worker's record is bounded | `KEEP_JOBS` in `lib/jobs.js:195`, `MESSAGE_WINDOW_DAYS` in `lib/assistant/messages.js` | 80 jobs, 7 days, a removable tree |
| the queue is the durable record | `TASK_CAP` and the task shape in `lib/assistant/queue.js:64` | 200 rows, `createdBy` / `thread` / `waveId` on every row |
| the panel already files as itself | `server.js:3369` `fileCollisionRow` | `by: "panel"`, `carriedKey` idempotency |
| loopback writes need no token | `lib/http/transport.js:136` | `isLoopback(req)` returns true before the token check |
| the card link route | `server.js:7165` and `lib/open-url.js` `openFileWith` | absolute path, roots check, registered browser, `file:///` tab |
| the view route is row-keyed | `routes/reports.js:395` `find`, `:98` absolute refusal | needs `thread` + `task`, relative path only |
| the wave driver's three moments | `lib/waves-driver.js:242`, `:184`, `:177` | `no-queued`, `next-empty`, `done` |
| the rule ignores the page | `git check-ignore -v docs/reports/clarify-juggling-design-2026-11-24.secret.html` | `.gitignore:44:*.secret.html` |
| the tree scan cannot see it | `GET /api/reports?thread=<row>&task=311` | `count: 0`, tree source skipped: "no .html report ... was added or changed on this branch" |
| the view route does serve it | `GET /api/reports/view?thread=<row>&task=311&path=docs/reports/...secret.html` | 200, `Content-Security-Policy: sandbox allow-scripts; default-src 'none' ...` |
| a row can name a wave on add | `lib/assistant/queue.js:964` -> `pickTask` `waveId` | one write creates a member |

## Appendix B: files and symbols

| file | symbols this design touches | role in the design |
| --- | --- | --- |
| `.gitignore` | the new `*.secret.html` line | the rule that makes the page local |
| `tools/reports-tracked.mjs` | `untrackedReports` | the gate that must not call an ignored secret page lost |
| `test/reports-are-tracked.test.js` | the tree scan and the fixture | proof that the exemption is a decision, not a hole |
| `lib/clarify-shape.js` | new: `CLARIFY_KINDS`, `checkChoices` | the seam check |
| `lib/jobs.js` | `clarify.request` handler, `CLARIFY_LINKS_BRIEF`, `REPORT_BRIEF`, the SPAWN brief, `waitsOf` | the record and the brief |
| `lib/clarify.js` | `USE_CLARIFY` | the sentence every run reads |
| `lib/assistant.js` | `queueDirectiveLines`, `deliverClarifyAnswer`, `queueBriefing`, `historyNamesFor` | the directive, the answer-to-row bridge, the wave block |
| `lib/assistant/actions.js` | `actionGrammar` | the assistant's vocabulary |
| `lib/assistant/queue.js` | `addTask`, `WAVE_ADVANCE_ACTIONS`, `TASK_STATES` | the row the answer becomes |
| `lib/waves-driver.js` | `planWaveAdvance` | the three moments the card is raised |
| `lib/waves.js` | `waveLane` | the evidence the four options cite |
| `lib/charter.js` | `charterTemplate` | the seeded rule |
| `data/roles/assistant-agent-manager.md`, `data/roles/assistant-director.md` | the long tier | the role charters |
| `lib/clarify-links.js` | `linkOf`, `linksOf` | the card's link field |
| `public/app.js` | `questionLinks`, `questionPrompt` | the Links block and the card |
| `server.js` | `POST /api/open-file`, `fileCollisionRow` | the opener and the filing precedent |
| `routes/reports.js` | `REPORTS_VIEW_PATH`, `find`, `resolveReportPath` | the chip, and why it is not the card link |
