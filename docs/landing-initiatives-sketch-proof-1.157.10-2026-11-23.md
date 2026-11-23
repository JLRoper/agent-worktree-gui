# Landing: The Route proved against the sketch (1.157.10)

The brief: prove the Initiatives tab's Route against the sketch the reader holds, on an initiative that actually has
waves, put the render beside the sketch element by element, and implement only the deltas that table finds. The report
is `docs/reports/initiatives-route-sketch-proof-2026-11-23.html`; this note is what landed and how it was proved.

The version is 1.157.10 for the reason 1.157.6 skipped 1.157.5 in the round before it: landings that are not this
one keep taking the number this branch was cut at. The cut was 1.157.8 on `fcfc0637` (1.157.7); 1.157.9 was taken
while this branch was open by `ed29a2a6` (a boot reads rows before the remote answers) and the changelog render
above it, so the branch was rebased onto `cf72e299` and the version moves one past the tip it now sits on.
The branch was cut from `0ffebed` (1.157.6), rebased onto `fcfc0637`, and every gate below was re-run after the rebase
on the bumped tree.

## The measured cause, reproduced first

On the reader's panel (7331, 1.157.6), read only: 7 initiatives, 7 folded title cards, `.init-status` reading "no waves"
on all seven, 0 route dots, `has-route` false on all seven, 0 `.wave-row`, 0 `.wave-lanes`, and
`waveStatus.found:false` for ``<home>` + `\.wag\state\waves.json``. The spine, the gates, the lanes and the closing
note are all folded from that file (`lib/waves.js:323` `wavesFor`, `:885` `deriveWaveState`, `:691` `waveLanes`), so the
tab drew exactly what it is allowed to draw.

## The throwaway, and the one thing the panel cannot do

A copy of the reader's state was served on 7332 with its own `WAG_HOME`, so no write could reach 7331. The throwaway
initiative ("Sketch proof: Menu SSO migration") was created through `POST /api/initiatives`, two real worktrees were
attached through `POST /api/initiatives/move`, and four task cards were filed and moved through
`POST /api/assistant/queue` (`action:"add"`, then `action:"state"`). Two of those tasks name a lane, which is how the
two-lane wave exists at all: a lane is the member's own field (`lib/waves.js:691`), not a wave record.

The three wave records could not go through a route: `routes/waves.js:110` answers 405 to every write ("this slice reads
waves and writes none") and `lib/waves.js` has readers only. They were written into the copy's `state/waves.json` by
`seed.py`, and the report says so in a note rather than presenting it as a route. That gap is the structural finding of
the round and is section 8 of the report: until a wave write route (or a named author) exists, every real initiative
stays at "no waves" and every restyle is a restyle of a file nobody can create from the panel.

The read folded, from that data: W1 done (auto on, opened by a person), W2 done (auto off, "opened by w.callback"
because w.callback's auto is on and its exit gate reads met), W3 running with two lanes (`callback` on the
oauth2-multi tree, `login` on the Menu tree), both lanes reading ok, `laneJoinOwed:true`. The sketch's own example
(1.2 "opened by w.callback", 1.3 "auto off" with no opener) is reproduced exactly.

## The table, and the one delta it found

21 rows in the report's section 3: 13 match, 1 fixed, 7 deliberately different with the reason and a citation.

- The fixed element is the closing note. The sketch draws it as a boxed note at the right of the lanes, with "2 lanes"
  as a bold lead. The shipped lane drew a bare full-width 11.5px `--tab-ink-3` line above them (4.84:1 on the row fill),
  which reads as a caption for the lane block rather than as the note about closing it.
- The seven differences each keep a fact the sketch's picture does not have to carry, and each cites what decided it.
  The two that matter: the station's state word sits beside the title, not at the far right of a 1382px row, because
  round B's own token sheet settles it (`docs/assets/initiatives-redesign/b/tokens.css:400`, repeated at
  `public/style.css:5481`) - measured, the chip starts 209px into a 1282px head; and the station reads "W1" rather than
  "1.1" because the leading number in the sketch is the card's ordinal in a list that reorders by edit time, so the same
  wave would change its number under the reader.

## The change, and what it costs

`public/core/waves-lane.js`: the lanes and the note are wrapped in one `.wave-close` block when both are owed; the count
is a `<b>` lead; `data-wave-join` and the words are unchanged; a refused lane set still draws its lanes and no note.
`public/style.css`: the note's box (border, 2px lead edge, `--tab-sunken` fill) and a `@container (min-width:900px)`
rule that turns the block into a row with a 196px note. `test/waves-lane.test.js`: one new test (the block wraps, the
count leads, a refusal draws neither).

Measured on the proof panel, before and after, same DOM read at each width:

- 1382 pane: note 1282x17 line at y=497 -> 196x87 box at x=1157; lanes 637 each -> 535 each; the sentence's contrast
  4.84:1 -> 9.14:1. One member title wraps, so the lane row grows 70 -> 87px (+17px). That is the whole cost.
- 479 docked, 347 and 239: the note is full width under the lanes, nothing narrows; the wave block's height is
  unchanged at 479 apart from the note's own 53px (891px at 347, 1289px at 239 - the same as before).

## Cleanup, and the seven

Deleted in three writes, because the panel has routes for two of the three things the seed made: the four queue tasks
through `POST /api/assistant/queue` `action:"delete"` (200 x4), the wave file removed whole, and the initiative record
removed from the copy's store (there is no delete route: `lib/initiatives.js` has create, update and move). The re-read
proves 7 initiatives with 0 waves, `waveStatus.found:false`, 0 tasks naming a wave, and the id absent; the reader's 7331
answered the same 7 and the same 7 zero counts before and after. The copy's ledger after cleanup is byte-identical to
the reader's panel capture (md5 `68eac45f46d0eec68e242abd95daec9f`), so the throwaway left no trace.

## Gates, in one sitting on this tree after the rebase

| Gate | Command | Answer |
| --- | --- | --- |
| tab | `node tools/verify-initiatives-tab.mjs` | 102/102 checks (04:37:02Z) |
| waves-lane | `node tools/verify-waves-lane.mjs` | 40/40 checks (04:37:14Z) |
| redesign | `node tools/verify-initiatives-redesign.mjs` | 11/11 claims; docked 18/18 of the 16-check rubric (before 4/16); wide 17/18, the one miss being the deliberate second-column alignment (04:37:50Z) |
| scroll | `node tools/verify-initiatives-scroll.mjs` | 35/35 checks (04:38:22Z) |

The four stamps are also in `docs/reports/initiatives-redesign/gates-1.157.10.json`, with the rule that a red gate is
listed red and never left out.

The unit suite (`npm test`, once, in one sitting after the gates): **3,595 tests, 3,587 pass, 8 fail, 0 skipped**. The
eight, and why each is not this diff:

- `absolute-paths`, "this repository's own tree passes - the allowlist matches what is really there" - **this diff's**,
  and the only one. The sweep found it: the four capture scripts, the report and the gate's own refreshed ledger named
  folders on this machine. Fixed rather than allowlisted - the scripts import `tools/browser.mjs` relatively and default
  `OUT` to `shots`; the two python scripts take `WAG_PROOF_HOME`, `WAG_PROOF_OUT`, `TREE_A` and `TREE_B` from the
  environment; the report and this note name `<home>`; and `tools/verify-initiatives-redesign.mjs:207` writes the
  ledger's home as `$SCRATCH`. The file answers **17/17** after the fix.
- `child-tree`, "a job's settle kills what its turn started, grandchild included" - fails on a clean
  `git archive origin/main` extract run in this sitting, so it is main's, not this branch's.
- `gateway-permissions`, the junctioned-node_modules worktree removal, "Clean scratch over HTTP", the
  `*File`/`*Dir`/`*Log` path derivation and "main moving on changes the count against main" - the five the 1.157.6
  landing recorded as its pre-existing set.
- `scan-roots`, "a folder added from the settings is written, re-scanned, and drawn under its own card" - also fails on
  the same clean extract.

Seven of the eight are therefore pre-existing on this host (two proved by running them against the archive, five named by
the previous landing's own note), and the eighth is fixed and green.

The suite was not re-run at the new base - it is one node process per test file, and the four gates below are the
round's own set. The one file this landing had touched was re-checked there: `node --test test/absolute-paths.test.js`
answers **16/17** on this tree, and the failure names `test/boot-rows-before-answers.test.js:19` and `:23`, which
arrived on main with the boot-reads landing (`ed29a2a6`, 1.157.9). A clean `git archive cf72e299` extract, run in this
sitting, answers **15/17** with the same file named - so that red is main's, not this branch's, and no file in this
diff names a folder on this machine.

`npm run test:changed` on the same tree selects **71 files** and answers **164.0s, exit 1**, with two failures:
`absolute-paths` (main's boot-rows file, above) and `git worktree remove walks THROUGH a junctioned node_modules - the
measurement this fix exists for`, which is one of the seven the 1.157.6 landing recorded as its pre-existing set. No
file this diff touches fails.

The four answers are the same as the 1.157.6 landing's (102/102, 40/40, 11/11, 35/35), so the note's box changed no
gate claim; the redesign gate's own ledger `docs/reports/initiatives-redesign/gate.json` had been stale since 1.144.0
(16/16) and now carries this tree's run (18/18 docked).

## Captures

Twelve PNGs in `docs/assets/initiatives-redesign/sketch-proof-2026-11-23/`: the reader's panel (the measured cause), the
wide pair before/after, the docked pair before/after, 347 and 239 (top and note), the ledger with the throwaway open,
the folded route row at 1440 and 480, and the copy after cleanup. The six scripts that produced every number are in
`docs/reports/initiatives-route-sketch-proof/`.

## The forensics page: what happened to the original implementation

The reader asked, after this landing, what became of the original implementation of the tab's rewrite. The answer is a
page, `docs/reports/initiatives-tab-original-implementation-2026-11-23.html`, and its finding in one line: no code was
lost.

- Nine commits touching `public/core/initiative-fold.js` or `routes/initiatives.js` are not ancestors of main, and
  every one of them has a twin on main with an identical tree (nine pairs, trees named in the page). Each landing
  branch was rebased onto main rather than merged, so the branch keeps the pre-rebase copy; `reachable by hash` and
  `lost` are not the same thing.
- The redesign's first implementation (1.144.0, PR 818) was evolved in place by The Route, not replaced: the
  two-column grid at `public/style.css:5658` is the same `@container (min-width: 1000px)` grid as
  `3d3241fd:public/style.css:4825`, its empty states still draw, and its gate is still the gate. Its 4px spacing and
  four-step type scale are the part that did not survive.
- The one artifact that was destroyed is a page: the original implementation report, written untracked by row 205's
  worker and killed with its worktree, and invisible to `git status` because `.git/info/exclude:12-13` ignores
  `docs/reports/*.html` in every worktree. PR 854 rebuilt it and force-added it. The rule is still armed today, which
  is why this page and the forensics page were both committed with `git add -f`.

## The gate stamps on this tree

The four gates were re-run after the rebase onto `cf72e299` (1.157.9), because the boot-reads change landed between
this branch's cut and its landing. The answers and their stamps are in
`docs/reports/initiatives-redesign/gates-1.157.10.json`, which is the record this note points at.
