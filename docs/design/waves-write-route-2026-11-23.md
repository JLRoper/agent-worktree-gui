# The wave write route: a design

This page is a design, not a description. It specifies the write half of the wave slice - the routes that create,
edit, reorder and delete a wave - in a repo where today there is no writer at all. Section 1 is the current-state
read and closes with a gap table; section 2 is the invariant any writer has to keep; sections 3 to 5 are the
proposal; section 6 is failure modes; sections 7 to 9 are the surface, the tests and the rollout; section 10 lists
the decisions a person has to make before the first line is written.

Measured at `origin/main` `fcfc0637` (1.157.7) plus this branch's three commits, and every claim about today's code
names a symbol that was read in this session.

## 1. Where waves stand today

The wave slice shipped as a READ, deliberately. `routes/waves.js:1-24` states the reason in its header: the first
slice is sized so it can be judged before anything acts on it, "no write route, no evaluator, no scheduler, no auto
start". Everything the Initiatives tab draws - the spine, the stations, the gate chips, the lanes, the closing note -
is folded on each read from two sources: the wave records in `waves.json`, and the task rows in every assistant's
queue.

What exists, and how it was counted:

| Half | Where | What it does |
| --- | --- | --- |
| one route | `routes/waves.js` (`WAVES_PATH`) | `GET /api/waves?initiative=<id>` only; every other method is a 405 (`:109-112`) |
| the store | `lib/waves.js` `Waves` class (`:198-345`) | `load`, `statusOf`, `wavesFor`, `waveById`, `skippedFor` - five methods, no `save` |
| the record door | `lib/waves.js` `pickWave` (`:156-196`) | validates one record: id, initiativeId, position, title, both gates, template, auto |
| the gate door | `lib/waves.js` `pickWaveGate` (`:102-151`) | the closed exit-check vocabulary and its parameter spec, shared with the pipelines |
| the fold | `lib/waves.js` `waveLane` (`:1156`), `waveView` (`:1086`), `deriveWaveState` (`:885`), `waveAutoOpens` (`:960-1010`), `waveLanes` (`:691`), `currentWaveId` (`:1135`) | every state, gate answer, lane and current station the tab draws |
| the caps | `lib/waves.js:61-72` | `WAVES_VERSION` 1, `WAVES_MAX` 50, `WAVE_TITLE_MAX`/`WAVE_TEMPLATE_MAX`/`WAVE_ID_MAX` 120 |
| the store's file | `Waves.load` (`:223-311`) | `{ savedAt, byInitiative: { <initiativeId>: [record, ...] } }` |
| the store's refusals | `Waves.load` | a duplicate id anywhere, a duplicate position inside one initiative, a bad gate: each record is SKIPPED with its sentence, never the whole file |
| the tab's read | `public/core/waves-lane.js` `laneHtml` (`:190-214`) | draws the lanes from `init.waves`, and nothing else |

The absence, beside that list:

- **No writer.** `lib/waves.js` holds 25 exports and not one of them writes. Its only `node:fs` import is
  `{ existsSync, readFileSync, statSync }` (`:51`), so the module cannot write a file even by accident; the `Waves`
  class has five read methods (`load`, `statusOf`, `wavesFor`, `waveById`, `skippedFor`) and no `save`; and the one
  line in the module that mentions saving is the loader reading `at: raw.savedAt` (`:301`).
- **No route.** `routes/waves.js` has one path, one method, and the 405 sentence "this slice reads waves and writes
  none" is the whole of its write behaviour.
- **No actor and no history.** An initiative records who changed it: `lib/initiatives.js:151-155` appends one event
  (`at`, `by`, `action`, `tree`, `detail`) capped at `HISTORY_MAX` (80, `:39`). A wave record has no `by`, no `at` and
  no history, and the store keeps only `savedAt`.
- **No test for a write.** Eight test files name waves today - `test/waves-route.test.js`, `test/waves-store.test.js`,
  `test/waves-derive.test.js`, `test/waves-lane.test.js`, `test/waves-lanes-join.test.js`, `test/waves-auto.test.js`,
  `test/wave-evidence.test.js`, `test/queue-wave-id.test.js` - and not one of them posts a record, because no route
  accepts one. `waves-route.test.js` tests the GET and the 405.

The gap table, which is the rest of this page:

| Question | Answered today | By what | Gap |
| --- | --- | --- | --- |
| Can a person make a wave? | No | `routes/waves.js:109-112` | a create route, and a control in the tab |
| Can a title or a gate be edited? | Only by hand-editing the file | `pickWave` validates on load | an edit route that calls the same door |
| Can waves be reordered? | Only by hand-editing `position` | `load` sorts by position, refuses duplicates | a reorder that cannot create a duplicate |
| Can a wave be deleted? | Only by hand | nothing | a delete that says what happens to its members |
| Who made this wave? | Nobody knows | no `by` field | provenance, and the tier that reads it |
| Does a write reach the tab? | n/a | `GET /api/initiatives` folds on each read | nothing: the read already does this |

The last row is the good news and it constrains the design: the tab needs no new read. `init.waves` is folded from the
store on every snapshot, so a wave created through a route appears in the tab on its next read, with its stations,
gates and lanes, without a websocket, a cache or a client change.

## 2. The invariant: a writer changes the RECORD and nothing else

The wave module's header (`lib/waves.js:1-40`) states seven rules; five of them are about what a wave must never
store, and they are the whole difficulty of adding a writer:

1. **A wave never owns a tree.** Membership is the task's `waveId`. A write route has nothing to say about trees.
2. **A wave never stores its own state.** `deriveWaveState` computes it from the members and one live gate read on
   every read. A `state` field posted to a write route must be REFUSED, not ignored: a stored state is believed after
   the rows move, which is the defect rule 2 exists to prevent.
3. **Gates reuse the closed exit-check vocabulary**, and `pickWaveGate` is the single door. The gate door's own
   comment (`lib/waves.js:102-105`) already anticipates this design: "the loader calls it, and a later write route
   would call the same one, so a hand-edited file and a posted record cannot be validated two different ways."
4. **A gate opens only on a live read-back.** A write route may store a gate's definition; it may never store an
   answer. The answer is `readWaveGate`'s, on the read.
5. **A wave's lanes are derived, and its close is one join.** A lane is the member's own field
   (`TASK_LANE_MAX`, `TASK_STATES` imported at `lib/waves.js:57`; `waveLanes` at `:691` reads it). A `lanes` field on
   a wave record must be refused, and a write route must not accept "put this member in that lane" - that is the
   queue's edit of the task.
6. **The auto switch is authored, and only the switch is.** `auto` is a stored boolean; `autoOpen` is derived from the
   wave before it (`waveAutoOpens`) and must never be stored.
7. **The join is a call** (`joinWaveLanes`, `:764`), not a route. A write route must not close a wave.

So the shape of the whole design in one sentence: **the writer writes the seven fields `pickWave` already validates,
plus provenance; every other word the tab draws is still computed.**

## 3. The write surface

Four routes under the existing prefix, mirroring `routes/initiatives.js` (which is the repo's settled pattern for a
map the reader edits: one path per verb, a payload cap, a 409 when the store cannot be read, an `asked` branch when the
tier interrupts, and a 200 carrying the fresh view).

| Route | Body | Answers |
| --- | --- | --- |
| `POST /api/waves` | `{ initiativeId, title, entryGate?, exitGate?, template?, auto?, position?, by }` | 200 `{ ok, changed, wave, ...laneView }`; 400 with the door's sentence; 404 unknown initiative; 409 unreadable store |
| `POST /api/waves/update` | `{ initiativeId, id, title?, entryGate?, exitGate?, template?, auto?, by }` | as above, for one record; an unchanged record answers `changed: false` |
| `POST /api/waves/move` | `{ initiativeId, id, to }` (`to` = the position it should end at, 1-based) | 200 with the new order; 409 if the store cannot be read |
| `POST /api/waves/remove` | `{ initiativeId, id, by }` | 200 `{ ok, changed, members }` - `members` counts the task rows still naming it |

Rules the four share:

- **`GET /api/waves` is untouched.** The 405 on other methods moves onto the four new paths, and the sentence
  `this slice reads waves and writes none` is replaced by one that names the writer.
- **The store is re-read before every write** (`load({ fresh: true })`), exactly as `lib/initiatives.js` `move` does,
  so a hand edit between two requests is not overwritten blind.
- **An unreadable store is a 409 and nothing is written.** The sentence is `statusOf().error` with the path in it,
  because the file may be salvageable and the panel will not be the thing that destroys it.
- **The door is `pickWave`, exported.** It is module-private today (`:156`). Exporting it and calling it from the
  route is the whole validation story; a route that re-implemented the checks would be the second answer to a settled
  question.
- **`position` may be omitted on create** and lands at `max(position) + 1` for that initiative. A posted position that
  collides is refused by name, not renumbered: `load` already refuses a duplicate with a sentence, and a writer that
  renumbered silently would make the file and the reader disagree.
- **The id is derived on create** from the title: lowercased, hyphenated, clipped to `WAVE_ID_MAX`, and suffixed
  (`-2`, `-3`) when the id is already in the store, because `load`'s duplicate check is on ids and a refused create
  with no sentence a person can act on is worse than a suffix. A posted `id` is validated by `pickWave` like any other
  field; a route never invents one when the caller gave one.
- **The reorder is positional, not structural.** `move` renumbers the list 1..n inside one store write, so a
  duplicate position is impossible by construction; a gap the reader made by hand is closed by the first reorder, and
  that is the one thing a write is allowed to normalise.
- **`remove` does not touch a task.** It deletes the record and answers how many task rows still name the id; those
  rows read as members of no wave on the next read (`waveMemberKey` is the task's `waveId`). The alternative -
  rewriting task rows - is a second writer on the queue, and the design refuses it.

## 4. The record and the store after the change

Three fields are added to a stored wave, and one to the document. Nothing the tab reads changes shape.

```json
{
  "version": 2,
  "savedAt": "2026-11-23T05:12:00.000Z",
  "byInitiative": {
    "init_mwrhmpv3_g96jpk": [
      {
        "id": "w.callback",
        "initiativeId": "init_mwrhmpv3_g96jpk",
        "position": 1,
        "title": "Prove the Okta callback on the VIP",
        "entryGate": { "check": "clean" },
        "exitGate": { "check": "clean" },
        "template": null,
        "auto": true,
        "at": "2026-11-23T05:12:00.000Z",
        "by": "assistant-3",
        "history": [
          { "at": "2026-11-23T05:11:58.000Z", "by": "assistant-3", "action": "create", "detail": "W1, position 1" }
        ]
      }
    ]
  }
}
```

- **`by` and `at` are provenance, not state.** They answer "who made this wave" - the question the `own` tier needs
  for a delete (section 5) - and they are written once on create, then on every edit. They are the same pair the
  initiative's attachment record keeps (`lib/initiatives.js` `members[id] = { at, by }`).
- **`history` is the initiative's pattern at a smaller cap** (`WAVE_HISTORY_MAX` 20, against `HISTORY_MAX` 80):
  newest last on disk, oldest dropped, `{at, by, action, detail}` with a closed action list (`create`, `edit`,
  `move`, `remove`). A wave is a smaller object than an initiative and its story is shorter.
- **`version` goes to 2, and `load` keeps reading a version 1 file**: a missing `by`/`at`/`history` is not an error,
  and a version 1 file is written back as a version 2 file on the first write. The loader's refusals do not change.
- **`pickWave` gains the three fields**, with `by` clipped like an actor and `history` validated as a list of events,
  so a hand-edited file and a posted record still go through one door.

The cost, stated plainly: a wave file becomes more than a list of five fields, and the fold must ignore the new ones.
That is the price of the `own` tier and of a reader who can see who made a wave. If the reader would rather keep the
record at seven fields, the alternative is `own` treating every wave delete as free - which is section 5's decision 2.

## 5. Who may write

The initiative map already has a four-level tier over four actions (`lib/initiative-permissions.js:20-56`):
`all` asks about every create, edit, attach and detach; `remove` asks about detaching; `own` asks about detaching
something somebody else attached; `none` asks nothing. The default is `all` (`:23`), and the tier decides only whether
the panel asks - never what the change does.

A wave write is a map change of the same kind, so the design reuses the tier and adds four actions rather than a
second setting:

| Action | `all` | `remove` | `own` | `none` |
| --- | --- | --- | --- | --- |
| `wave-create` | asks | free | free | free |
| `wave-edit` | asks | free | free | free |
| `wave-move` | asks | free | free | free |
| `wave-remove` | asks | asks | asks unless the wave's `by` is this actor | free |

The `own` reading of a delete is the same reading as a detach, stated once: it is asking when the actor removing the
wave is NOT the actor who made it, so an assistant's own wave comes out without a question and a person's wave does
not. An attachment with no recorded actor is treated as somebody else's and asks; a wave with no `by` is treated the
same way, which is why section 4's provenance fields are load-bearing rather than decorative.

Two things stay outside the tier:

- **A gate is not a permission event.** An entry or exit gate is a definition the read evaluates; posting one asks at
  `all` like any edit and never asks again when the read's answer changes.
- **No route may be reachable at a tier the tab cannot show.** The snapshot already carries `tier: tierOf()`
  (`routes/initiatives.js:320`) and the settings page already words all four levels
  (`lib/initiative-permissions.js:28-56`), so the wave section reads the same value the tree controls do rather than
  inventing a second switch. The tab draws the tier nowhere today; with a writer it should say, once, which level is
  in force, or a person will not know why a create waited.

## 6. Failure modes

Four beats each: the scenario, what happens today, what the design does, and what remains open.

**A wave posted with a duplicate title.** Today a hand edit creates two records with the same title and different ids,
and both draw. The design does not make a title unique: `nameId` derives an id from the title plus a suffix, and the
store's duplicate check is on ids, not titles. Remaining: two waves may read alike, which the position number
disambiguates on screen and nothing disambiguates in the store.

**A wave deleted while its tasks are running.** Today impossible (no delete). The design deletes the record, leaves the
task rows alone, answers `members: 3`, and the three rows stop being drawn as members. Remaining: the tasks run on with
no wave, and nothing on the task row says so - a task row could learn to draw "its wave was deleted" in a later slice.

**The store cannot be read.** Today a read is a 409 with the store's sentence (`routes/waves.js:118-126`). The design
adds nothing: every write re-reads, refuses with the same 409, and writes nothing. Remaining: a file that is readable
but holds one bad record loses that record on the next write, because the writer serialises the loaded document - the
record's sentence is still emitted on the read (`skipped`) but the write is where it disappears. The mitigation is to
refuse a write while `skipped` is non-empty, with the sentences named; the design recommends that and it is decision 3.

**Two writes in the same second.** Today impossible. The design's writes are synchronous, one document per request,
with the atomic `tmp` + `rename` the initiative store uses (`lib/initiatives.js:347-380`), so the second write reads
the first's file. Remaining: two panel processes on one state directory would still race, which is true of the
initiative store today and is not this design's to fix.

**A reorder that names a position past the end.** Today impossible. The design clamps `to` into `1..n` and answers the
clamped position, because a reorder's intent is "put it last", not an index error. Remaining: a client that wanted an
error gets a move; the answer carries the position it landed at.

**A wave with a template the bundle no longer holds.** Today the read says unresolved (`waves-lane.js` draws "the
bundle does not hold this id") and the record keeps the id. The design validates only the field's shape on write, not
the bundle, for the same reason: the next bundle may bring the id back. Remaining: a typo in a template id is stored
and reads unresolved, which is the correct read of a wrong value.

**A person opens the tab while the store is missing.** Today `found: false` is an empty board and the tab draws no wave
section at all (`laneHtml` returns `""` at `:195`). With a writer this state needs a control (section 7), so the empty
case stops being invisible.

## 7. What the tab gains, and what it must keep

Gains, all small because the read already does the work:

1. **An "Add a wave" control on an open card**, beside the "Waves N" section head. On a card with no waves it is the
   only thing in the section, which is the one case the tab currently draws nothing for.
2. **Edit, move and delete on each station**, behind the station's own menu: the same controls the tree rows already
   use, so the card does not grow a second visual language.
3. **The note's tooltip stops saying there is no writer.** The `init-wave-note` title in `laneHtml` currently says
   "this tab has no write route - nothing here opens, closes or starts a wave". After this design the true sentence is
   narrower: the tab authors waves, and still opens nothing, closes nothing and starts nothing. That sentence is the
   promise the read keeps, and it must survive the change.
4. **The waves header's provenance line** ("read from the wave store") keeps its meaning: it says the words below are
   a read, which is still true when the store has a writer.

Must keep, unchanged: every word in `public/core/waves-lane.js`'s header; the state fold; the five gate answers; the
lane block only at two or more lanes; the join only when the set can close; the member manifest; the folded row's
dots and status; the 27px glyph slot. The proof report
(`docs/reports/initiatives-route-sketch-proof-2026-11-23.html`) records what each of those draws from, and none of it
is a stored field a writer could set.

## 8. Tests

One failing-first test per behaviour, in a new `test/waves-write.test.js`, against a `Waves` store pointed at a temp
file:

| Behaviour | The assertion |
| --- | --- |
| create | a posted record lands, `save` writes it, a fresh `load` returns it, and the file's `version` is 2 |
| the door | a posted `state` is refused by name; a gate outside `EXIT_CHECKS` is refused by name; a title over 120 is clipped, not refused |
| position | a create with no position lands last; a create with a taken position is refused; a `move` renumbers 1..n |
| provenance | a create records `by`/`at` and one history event; an edit appends a second; the cap drops the oldest |
| remove | the record is gone, the tasks still name it, and the answer counts them |
| unreadable | a corrupt file answers 409 and its bytes are unchanged after the request |
| skipped | with one bad record on disk, a write refuses and names it (decision 3) |
| the tier | each of the four levels over the four actions, including `own` on an assistant's wave versus a person's |
| no second writer | after a wave write, `initiatives.json` is byte-identical |

Then the four browser gates, all of which already exist and must stay green with the control added:
`verify-initiatives-tab` (102/102 today), `verify-waves-lane` (40/40), `verify-initiatives-redesign` (11/11),
`verify-initiatives-scroll` (35/35). The tab gate's counts will change when the card gains a control, and the change
is the evidence that the control is drawn at 347 and 239 as well as 1440.

The end-to-end proof is the one this branch already ran by hand: create a wave through the route on a copy of the
state, read `GET /api/initiatives`, and capture the station at 1440, 768 and 480. The scripts for that are in
`docs/reports/initiatives-route-sketch-proof/` and the only change they need is to call the create route instead of
writing `waves.json`.

## 9. Rollout

| Step | Size | What it changes | Depends on |
| --- | --- | --- | --- |
| 1. `Waves.save` + `pickWave` exported + provenance fields | S | `lib/waves.js` only; version 2 with a version 1 read | decision 1 |
| 2. the four routes + the tier actions | M | `routes/waves.js`, `lib/initiative-permissions.js`, the composition root | step 1, decision 2 |
| 3. the tab's controls | M | `public/core/waves-lane.js`, `public/assistant.js`, `public/style.css` | step 2 |
| 4. the write tests + the four gates | S | `test/waves-write.test.js`, the gate counts | step 2 |
| 5. the store's own migration, if wanted | S | a version 1 file rewritten as version 2 on first write | step 1 |

The default tier is already the strictest (`all`), so shipping the routes changes nothing for a person who has never
touched the setting: every wave write is a question until they move it. That is the right default for a writer that
did not exist yesterday, and it is why this design does not need a dark-mode flag.

## 10. Decisions

1. **Does a wave record gain `by`, `at` and `history`?** Recommended: yes (section 4), because the `own` tier's delete
   rule and a reader's "who made this" both need it, and the initiative's attachment record is the precedent. The
   alternative is a store with no provenance and an `own` tier that cannot judge a delete.
2. **Is a wave delete governed at `remove` and `own` like a detach?** Recommended: yes, with `own` reading the wave's
   `by`. The alternative is a new literal action that always asks, which makes the strictest tier the only honest one.
3. **Does a write refuse while the store holds a skipped record?** Recommended: yes, naming the record's sentence,
   because the write serialises the loaded document and would drop it. The alternative is to write the skipped
   records through untouched - which means carrying their raw bytes, and is a bigger change than it looks.
4. **Does the tab's control create a wave with a default title?** Recommended: no - the control opens a one-line form
   with the title and both gates, because a wave with a made-up title is a wave someone has to rename. The alternative
   is a "New wave" that lands "Wave 4" and is edited immediately.
5. **Are lanes editable from the tab?** Recommended: no, not in this slice. A lane is the task's field; the tab would
   be writing the queue. The tab shows lanes and says where they come from, which is what it does today.

## What this design does not do

- It does not make the tab start, open, close or join anything. The auto switch still opens a wave on a READ, and the
  join is still a call.
- It does not touch the queue. A lane, a member's state and a member's files stay the task's own fields.
- It does not change the fold, the lane derivation or the closing note.
- It does not give the wave store a scheduler, a timer or a background writer.
