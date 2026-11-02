# The Combined output default was already landed — record of the re-check

The brief asked for a Settings default for combined (🌊 one-stream) consoles, in the **Agent cards**
group beside **Show thinking**, persisting the way that row does and overridden by a card's own 🌊, then
a version bump, the tests, a push and a PR. All of that is already on `main`, landed by PR #183; this
tree was cut from `main` after the landing and carried no commits of its own, so nothing was re-landed
and no product code changed here.

## What is on main, and where it came from

PR #183 (`wtgui/add-a-settings-default-f-b64888`, "feat: a Combined output default for the one-stream
console (0.49.1)") landed as a rebase merge. Its three commits sit on `origin/main` in order:

| commit | subject |
| --- | --- |
| `e69b6be` | feat: a Combined output default beside Show thinking, for the one-stream console |
| `3cb5d55` | test: pin the Combined output default at build, over both per-card answers, and through a save |
| `29d5375` | test: gate the Combined output default across two runs and two presses, in a real browser |

`git show 29d5375:package.json` reads `0.49.1`, and `git merge-base --is-ancestor 29d5375 origin/main`
is true. Later landings took `main` to `0.50.0` (`8237843`) while this tree was being measured, and then
to `0.50.1` (`cea6dfe`, #187) before the rebase below; those are the versions its `package.json` held
before the bump.

## The shape it has, against the brief's list

- **The row.** `public/index.html:269-272`: `<label class="settings-row" for="stream-default">`, the
  first row after `show-thinking` and before `group-tools`, with the same `ⓘ` span and the same
  `settings-unit mono">default for cards` pill. Its `title` says the per-card button wins.
- **The store.** `public/app.js:6420` `STREAM_KEY = "wtgui.stream"` is the global answer, exactly the
  way `THINK_KEY` is for 🧠; `public/app.js:6445` `setStreamMode` writes `wtgui.stream.<thread>` for a
  press on a card.
- **Read at build.** `public/app.js:6434` `streamOn(thread)` reads the card's own key first and falls
  back to `streamDefault()` (`public/app.js:6422`), so a session that never pressed 🌊 follows the
  switch — on gives one stream, off gives the separate thinking block and condensed tool groups.
- **The override survives a rebuild.** The conversation signature includes `streamOn(conv.thread)`
  (`public/app.js:8132`), so a card whose answer differs from the default is repainted when the
  signature moves, and its own key is never rewritten by the switch: the handler at
  `public/app.js:18178` saves only `STREAM_KEY` and repaints only the cards with no key of their own,
  the loop the 🧠 handler above it already runs. The switch is painted at start-up at
  `public/app.js:18255`.
- **Docs.** `docs/using-the-board.md:519` (the 🌊 row) and `:832` (the Agent cards table) both describe
  the switch and that a card's own press wins.

## Re-checked on this tree, at `origin/main` `cea6dfe` (0.50.1)

Run between 19:50 and 19:54 EST, 2026-11-01 (`date` read 19:56 EST, `date -u`
2026-11-02 00:56Z when the rebase below was done), from
`C:/ProjectDevelopment/agent-worktree-gui/.worktrees/add-a-settings-default-f-226287`:

- `git rev-list --left-right --count origin/main...HEAD` → `0 1` on this commit, and `0 0` before it:
  the tree was cut on `main`'s tip and had nothing of its own to land, so this record is its only
  commit.
- `node --test test/stream-default.test.js` → 7 tests, 7 pass, 0 fail. The file pins the four facts the
  brief's list asks for: nothing stored is the condensed console and building a card writes nothing; a
  session that never chose follows the switch; a card's own answer wins in both directions; the handler
  saves the global key and touches only the cards without one — plus the row's position and its
  start-up paint.
- `npm test` → **735 tests, 735 pass, 0 fail, 0 skipped**: 78.8 s at `0.50.0` before the first bump,
  60.4 s at the `0.50.1` tip, and 55.5 s again on the rebased `0.50.2` tip. `node tools/version.mjs
  check` exits 0 against `origin/main`.
- `npm run verify:stream-default` → **21/21 checks held** against a live panel. The off default renders
  the separate thinking block and the condensed bursts with no separated pieces; the switch then saves
  the global default and the card that never chose follows it with no reload; a new run under the on
  default is ONE stream (`aria-pressed true` with no press); the stream survives the 3 s repaint sweep;
  a 🌊 press saves `wtgui.stream.<thread>`, leaves the global default untouched, and the card goes back
  to the separate block; a reload rebuilds it from its own answer, not the default; pressing the switch
  back off moves the still-undecided card with it; and a press the other way makes that card a stream
  over an off default, which a reload keeps.

## Version

`0.50.2`. The first cut of this record bumped `0.50.0` → `0.50.1`; while it was open, #187 landed the
per-assistant record (`ae3d9c1`) and took `0.50.1` as well, leaving `main` at `0.50.1` (`cea6dfe`). The
branch was rebased onto that tip and re-bumped one patch above it, so `package.json` here reads
`0.50.2` and `node tools/version.mjs check` passes against `origin/main`. Patch, not minor: this commit
adds a document and moves no product code, which `docs/versioning.md` files under patch. The
reader-visible control itself landed as `0.49.1`; the feature's own bump travelled with it.
