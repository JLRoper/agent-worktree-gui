# Landing: the auto switch, off by default, and it opens the next wave on a read (1.155.0)

Step 1 landed the wave record, the explicit membership and the state folded on every read. Step 2 made the gates read
live evidence. Step 3 derived lanes and closed a wave in one join. This row, step 4 and the last wave step, adds the
thing the design's first slice deliberately left out: one switch per wave, `auto`, and when it is ON the NEXT wave in
the sequence opens by itself - on a green live read-back, and on a READ.

The switch does exactly one thing. It does not start a member, cut a tree, write a row, or run in the background. It
answers one question on every read of the lane: did the wave before this one close on evidence a reader can go and
look at, with its switch on? If yes, this wave reads open, and the record says which wave opened it and what that
wave's gate read. If the gate cannot be read, nothing opens and the sentence names what was unreadable.

No scheduler, no cron, no timer, no write route, no new tab, no new gate name and no new field on the stored wave.

## Rule 1: one switch per wave, and absent or false is today's behaviour

`pickWave` already kept the field this row needs: `auto: raw.auto === true` (`lib/waves.js:192`). A record with no
`auto`, `auto: false`, or a hand-edited `auto: "yes"` reads false, and a wave with auto false is not a lesser case -
it never opens the next one, whatever its exit gate reads.

Nothing about the default-off path changed. The lane draws the auto chip it always drew, and the auto-open chip is
drawn only when a previous wave's switch was actually read; `test/waves-lane.test.js:107` asserts the markup for a
wave whose predecessor has the switch off is byte-identical to the markup for a wave with no `autoOpen` at all.

## Rule 2: a met exit gate from real evidence, and cannot tell blocks

`waveAutoOpens` (`lib/waves.js:973`) takes the ordered views the fold already built and returns one record per wave.
For every wave after the first it reads the PREDECESSOR's own answer:

- the predecessor's `auto` must be `true`, or the gate is not consulted at all (`lib/waves.js:983`);
- it must name an exit gate - a wave with none is closed by a person, and there is no read that can say met;
- that exit gate must answer `met` (`lib/waves.js:994`). `cannot tell` opens nothing and carries the evidence
  reader's own sentence, so the reader sees "the member names no pull request" rather than a bare "blocked". A gate
  that reads not met opens nothing, and an exit closed as abandoned opens nothing: an abandonment is a decision about
  the work, not a landing;
- the predecessor must read `done` (`lib/waves.js:1004`). A met exit alone is not enough: `deriveWaveState` keeps a
  wave open while a member runs or a park holds it, and a successor must not overtake a run the previous wave still
  holds. This is the fold's own clause, applied rather than gone around, and `test/waves-auto.test.js:171` proves the
  met-gate-under-a-running-wave case with a hand-built gate answer.

THE GATE ANSWER IS NOT A SECOND READ. `waveView` already made the exit read with the live evidence map for this
request, and `waveAutoOpens` judges that same object (`second.gate === one.gates.exit`, asserted at
`test/waves-auto.test.js:119`). A stored `pr.state` is never consulted, exactly as on the gate itself - the route test
puts `MERGED` on the member's row and the sandbox's exit still reads cannot tell, so nothing opens
(`test/waves-route.test.js:228`).

## Rule 3: membership stays explicit

An auto-opened wave is the wave record with the tasks that name its `waveId`, and nothing else. No member is copied
from the predecessor, no tree is cut and no lane is invented: `test/waves-auto.test.js:250` opens an empty wave and
finds `state: "empty"`, `members: []` and zero lanes. The store test beside it asserts the opened wave holds its own
member and the predecessor holds its own (`test/waves-auto.test.js:216`).

## Rule 4: the same lane, in the same tab

No tab was added and no route was written. `waveLane` (`lib/waves.js:1178`) attaches `autoOpen` to each view it was
already building, so the field rides on `GET /api/waves` (`routes/waves.js:16`) and on the board's
`GET /api/initiatives` (`routes/initiatives.js:172`) with no second read. `public/core/waves-lane.js:126-129` draws
it: `opened by wave_01` when a switch opened the wave, or `auto wait - cannot tell` (or `not met`, `no gate`,
`abandoned`, `not closed`) when the switch is on and did not, with the sentence on the title. `test/waves-route.test.js:228`
asserts the tab's wave list is deep-equal to the route's.

## Where the read happens, and what happens when nobody is looking

The switch is evaluated in `waveLane`, once per initiative, and `waveLane` is called by exactly two reads:
`GET /api/waves` (`routes/waves.js`, the lane's own query) and the board snapshot behind `GET /api/initiatives`
(`routes/initiatives.js`, the Initiatives tab). There is no other caller in the panel.

So the honest answer is the one the row is required to state, and it is stated here rather than hidden behind a
promise of a background loop:

- **If nobody is looking, nothing opens.** There is no scheduler process, no cron entry and no timer. The panel does
  not open a wave while no request is being served, and this row does not add anything that would.
- **The next read is the next evaluation**, and its answer is that read's answer. An open is a fact about the read,
  not a row written somewhere that a later read would believe.
- **Nothing is written.** `autoOpen` rides on the view; `waves.json` is byte-identical after a read, and a record
  carrying `openedBy`, `openedAt` or `autoOpen` is not read back (`test/waves-route.test.js:269`).
- **The evidence has the panel's own 30 s memo** (`server.js:1855`). A read inside that window sees the same evidence
  it saw a moment ago, so an open can lag the host's answer by up to the memo - that is the evidence read's existing
  behaviour, inherited rather than changed here.

## No runaway: an auto-opened wave inherits nothing

Opening wave 2 does not set anything on wave 2. Its own `auto` is its record's, absent is false, so wave 3 stays
shut (`test/waves-auto.test.js:148`). Switching wave 1's `auto` back off shuts wave 2 on the very next read, with the
same store and the same evidence (`test/waves-auto.test.js:162`). Both are read-time facts, so neither needs a write
to undo: the record is the only input, and the switch is the only difference.

## Proof, as tests

`test/waves-auto.test.js` (11 tests) is the derivation, rule by rule:

1. the first wave is opened by a person (`:76`), and a position gap is stepped over - the sequence is the records the
   store read (`:86`);
2. auto absent or false never opens the next wave even when its exit gate reads met (`:97`);
3. auto true with a met exit opens the next wave, and the record names the wave and the evidence (`:119`);
4. auto true with a cannot-tell gate opens nothing, and the reason names the unreadable evidence (`:136`);
5. an auto-opened wave is default-off, so the chain stops (`:148`), and switching auto back off shuts the next one
   (`:162`);
6. a met exit under a running wave opens nothing (`:171`); no exit gate and an abandoned exit open nothing (`:187`);
7. over a real `waves.json`, the lane answers `autoOpen`, the file is byte-identical afterwards, the opened wave holds
   its own members, and an empty wave opens as empty with no lanes (`:216`, `:250`).

`test/waves-route.test.js` (8) proves it over a real server and a real queue: the switch rides the read, cannot tell
opens nothing, `MERGED` on the row is not evidence, switching off shuts the next wave, and no open is written
(`:228`, `:269`). `test/waves-lane.test.js` (20) proves the markup: the chip off by default (`:102`), the byte-identical
default-off case (`:107`), the open chip and its sentence (`:114`), and the wait chip with the gate's own word,
never drawn as an open (`:137`).

The focused set on the final tree, `npm run test:changed` (14 test files, 188 tests): 188 pass, exit 0, 46.7 s.
Run file by file, the nine files the diff names or imports answer 132 tests, 132 pass (wave-evidence 13,
waves-auto 11, waves-derive 22, waves-lane 20, waves-lanes-join 10, waves-route 8, waves-store 17, branch-link 13,
initiative-tasks 18).

The live gate, `node tools/verify-waves-lane.mjs`, run on this branch: **OK 40/40 checks passed** at 1440 and 768,
including "the lane is drawn inside an initiative card", "the auto chip reads off" and zero page or console errors -
so the lane this row extends is still one lane in the Initiatives tab, and the added chip changed no width.

The full sweep, `npm test` (`node --test --test-concurrency=4` over the whole test directory, 3,536 tests):
**3,525 pass, 11 fail.** None of the eleven is in the wave, gate, evidence, pin or lane machinery, and every one is
accounted for by measurement rather than assertion:

- nine are the failures step 3 measured at its base commit, by name: `assistant-profile` (the `dock` field),
  `assistant-search-scroll`, `child-route`, `gateway-permissions`, `header-controls`, `junctioned-node-modules`,
  `paths-http`, `paths` and `reasoning-runs`;
- `scan-roots` ("a folder added from the settings is written, re-scanned, and drawn under its own card") also fails
  ALONE on this branch, and fails identically at the base commit `afe58ea7`, measured by extracting `origin/main` with
  `git archive` into a scratch directory and running that one file there: pre-existing at this base, not this row's;
- `task-pipeline-walk` ("author-review-revise crosses a sequence...", 69 s inside the sweep) passes alone on this
  branch (4 tests, 4 pass), so it is a load flake under four concurrent files - the same class as the tenth failure
  step 3 recorded.

## What this row does not do

- **No background loop.** No scheduler, cron, interval or watcher evaluates the switch; only a read does, and a read
  with nobody behind it does not happen. Stated in the section above, in the module header (`lib/waves.js:35`) and in
  the route header (`routes/waves.js:16`).
- **No start.** An open is not a dispatch: it starts no member and runs no pipeline. It also therefore cannot override
  the Assistant's own `spawn` setting - it has nothing to start. A later row that drives a wave can consume
  `autoOpen.open`; this row only answers it.
- **No write route and no authoring UI.** The switch is authored in `waves.json` by the reader, like every other wave
  field, and `auto` defaults false for a record that does not carry it.
- **No change to the state table.** `ready`, `unentered`, `unknown`, `running`, `blocked`, `done`, `abandoned` and
  `empty` still mean what `docs/reports/waves-of-work.html` says they mean. `autoOpen` is drawn beside the state, not
  instead of it, and a wave whose own entry gate reads not met still reads unentered while the switch that opened it
  is named beside the word.
- **No new gate name and no new parameter.** `EXIT_CHECKS` is still the closed 14.
