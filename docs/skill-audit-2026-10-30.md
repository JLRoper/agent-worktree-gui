# Skill audit — agent-worktree-gui — 2026-10-30

The user noticed that every agent and every worktree he starts opens by loading the `agent-worktree-gui`
skill, that it is large, and asked what is in it, what it is for, whether it earns its place, and whether it
should be broken up so things load faster. This is the answer, measured.

The skill is **not in this repository** — it lives at
`C:/Users/roper/AppData/Local/hermes/skills/software-development/agent-worktree-gui/` (1.0 MB across 93 files,
no version control). Nothing here is a work order: the split in §6 is a proposal, and the file it would edit
is outside this tree's diff.

---

## 1. What it is

An operating manual for this panel, written across roughly 100 agent sessions. Three kinds of content:

- **The shape of the thing** — `server.js` / `lib/*` / `public/*`, which module owns which fact, the routes.
- **Rules that hold on every change** — separators are `·`, the agent glyph is `⧉`, destructive
  confirmations read Cancel then Delete, a behaviour that is a judgment call ships as a Settings row,
  present UI alternatives through `clarify` before coding.
- **Post-mortems of bugs already paid for** — 43 numbered entries, nearly all of which carry the symptom the
  reader reported and the number that was measured while fixing it (a 14,000 px scroll jump, `55.0k` vs
  `55k`, 18.2 s → 866 requests at 18 ms mean, 15 details for 14 keys).

It is loaded for any change to the panel, any question about what the board shows, and by this repo's own
landing/TODO protocol. That is why "every agent starts by loading it": the skill's `When to Use` covers the
whole surface of the project, and the project is where all these agents work.

## 2. Measured shape

Every number here is a reading taken during this session. **The directory is being written to while you read
this**: `SKILL.md` went from 96,883 B / 960 lines to **97,385 B / 971 lines** and the reference count from 74 to
75 in about twenty minutes, with no commit and no author. That drift is not an error in the measurement — it is
the finding. The figures below are the later reading; a reader re-running the block in §8 will get a larger
file, which is the point of the size guard in §6.

| Part | Files | On disk | Loaded when |
|---|---|---|---|
| `SKILL.md` | 1 | 97,385 B (971 lines) | **every session, in full** |
| `references/*.md` | 75 | 855 KB | on demand, one file at a time |
| `scripts/*` | 17 | 76 KB | only when run |
| total | 93 | 1.00 MB | |

`skill_view(name='agent-worktree-gui')` returned **100,786 characters** for a session that only needs the
index — about **25k tokens** before any work starts, in a 200k window. That figure is from the earlier reading,
when the file was 96,883 B; the load is now larger still.

## 3. Where the always-loaded bytes go

| Section | Lines | Bytes | ~tokens |
|---|---|---|---|
| Pitfalls (43 entries) | 411 | 42,604 | 10.6k |
| Always-on UI conventions | 204 | 21,946 | 5.5k |
| Run and verify the live panel | 115 | 10,873 | 2.7k |
| The assistant (floating panel) | 90 | 8,101 | 2.0k |
| Delivery | 57 | 5,866 | 1.5k |
| References index | 39 | 3,496 | 0.9k |
| Layout | 15 | 1,107 | 0.3k |
| When to Use | 12 | 828 | 0.2k |
| Documenting the page | 6 | 363 | 0.1k |
| Reviewing the code | 6 | 372 | 0.1k |

Two sections are 68% of the payload and neither is always-on: the pitfall log is a **symptom→cause index**
(it only pays when that symptom appears) and the UI conventions are mostly **per-feature** rules (the
add-agent bar, the context ladder, project hues, the reply box's growth, the assistant panel) rather than
universal ones.

## 4. Is it useful

Yes, and by a measurement rather than an opinion. The corpus has **no duplication to delete**:

- Highest 8-gram Jaccard overlap between any two of the 75 references is **0.01**. The similarly named files
  (`assistant-panel-ops` / `assistant-panel-operation` / `assistant-panel-operator` / `assistant-duty` /
  `assistant-watching-the-board`; `landing-a-drifted-main` / `landing-a-lane-when-local-main-has-drifted` /
  `squash-landing-and-drifted-main`) are distinct documents that were named from different angles — confusing
  to a human, not redundant.
- Only **1%** of `SKILL.md`'s text appears anywhere in the references: the always-loaded file is a third body
  of knowledge, not a summary of the other two.
- Every pitfall states a mechanism, not a preference. That is the one thing an agent cannot re-derive from the
  code, and it is why the same bug is not fixed three times.

So the cost is real but the content is not padding. It also has two defects worth fixing before anything else:

- **It is not in version control.** 1 MB of measured knowledge with no history, no diff, and no rollback.
  File mtimes show 75 of the 75 references were written in the last 8 days — the growth is ongoing and
  unattended.
- **Half the references are unreachable.** 37 of the 75 are never named in `SKILL.md` (≈254 KB of the 855 KB).
  They are real, unique content that no future agent will open unless it guesses the filename out of the
  loader's file listing. The documented half is the one that gets read; the other half is what the panel's
  own history cost to learn and is now, in practice, lost.

The pitfall numbering also shows the accretion: entries run `… 26a, 26b, 26, 27, 29, 28, 30 … 36, 36c, 37 …`,
with `36a`/`36b` absent. Cosmetic, but it is the signature of a file that is appended to instead of organised.

## 5. The load cost, correctly attributed

Breaking the references up further would not save a single token: they are already off the load path and are
read one at a time. **`SKILL.md` is the payload.** Splitting it is the only lever, and the target is not
"smaller files" — it is "the index loads, the detail does not".

## 6. Proposal

Target: `SKILL.md` from **97,385 B (~24k tokens) to 25–30 KB (~7k tokens)**, lossless — nothing deleted,
everything reachable.

1. **Keep in `SKILL.md`:** frontmatter, one paragraph of what the panel is, `When to Use`, `Layout`, `Delivery`,
   the always-true UI rules (separators, glyphs, the clarify-before-coding rule, evidence-not-the-diff,
   settings-row rule, doc-change rule), and a **symptom → file routing table** in the reader's own words
   ("it jumps to the top" → `pitfalls-repaint.md`; "the pill says not-running but it is working" →
   `pitfalls-liveness.md`).
2. **Move the 43 pitfalls out**, grouped by domain rather than by number — repaint/scroll/caret, console and
   tool output, run lifecycle and the Runs API, attribution and rows, settings and persistence, the assistant.
   **Keep the numeric ids**: only two cross-references exist (`pitfall 38` in the usage-readout rule, `see 33`
   in the anchor rule) and both must be repointed, not renumbered.
3. **Wire up the 37 orphans** — either into the routing table or, after reading them, deleted as superseded.
   That is a separate read of 260 KB and the highest-value half of this work; do not guess at it.
4. **Ship a size guard** so this does not regrow: a check that fails when `SKILL.md` exceeds ~30 KB, in the
   skill's own `scripts/` beside `doccheck.py`. Accretion is the cause; nothing else prevents the repeat.
5. **Put the skill under git** (its own repo, or a `skills/` tree the panel repo can see). Independent of the
   split, and cheap.

## 7. Risks

- The pitfall entries are the value; move the measured numbers **verbatim**. A summarised pitfall is a lost bug.
- An agent mid-task may have already loaded the old file; the split takes effect on the next `skill_view`.
  Nothing else reads it, so there is no runtime coupling.
- Do not reorganise by section name alone. The routing table is what makes a split file findable, and a
  reference nobody can name is how the 37 orphans happened.

## 8. Re-measure

```bash
SK=C:/Users/roper/AppData/Local/hermes/skills/software-development/agent-worktree-gui
cd "$SK" && wc -c -l SKILL.md && ls references/*.md | wc -l
python -c "import glob,os;t=open('SKILL.md',encoding='utf-8').read();r=[os.path.basename(p) for p in glob.glob('references/*.md')];print(len([x for x in r if x in t]),'named of',len(r))"
```

The last number is the reachability pair, and it has to be counted against bare basenames: only 22 of the
references are written as `references/<file>.md` (a grep for that prefix reports 22 and hides the rest), while
38 are named somewhere in the file. **38 named of 75** is the defect in §4. After the split they should be
equal, and `wc -c` on `SKILL.md` should read under 30,000.
