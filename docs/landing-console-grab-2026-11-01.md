# The console-grab measurement was already landed — record of the re-check

The brief asked for a Playwright measurement of the console's bottom-right resize grab: what a pointerdown does to
the height, every step of a down-then-up drag with the pointer-to-corner gap, the following / parked / streaming
consoles, a drag past the viewport edge and one released outside the card, findings in
`C:/CodeReviews/agent-worktree-gui/resize/grab.md` with pixel numbers and a PASS/FAIL per case — built on
`tools/verify-console-resize.mjs`, read-only, no edit under `public/`.

All of that is already on `main`. The harness landed as PR #180 and its record-side checks as PR #185; this tree was
cut from `main` after both and carried no commits of its own, so nothing was re-landed and no product code changed
here. What this commit adds is the re-check at the current tip: the harness re-run on `65f1e8e` (0.51.0), and the
out-of-repo report refreshed with the numbers it printed.

## What is on main, and where it came from

| commit | subject | `package.json` there |
| --- | --- | --- |
| `b7d9ecb` | test: measure the console grab's corner tracking on following, parked and streaming consoles | 0.48.2 → the PR's bump took it to 0.48.3 |
| `c063405` | test: read the height a console grab records, and pin it per case | 0.49.3 |

PR #180 (`wtgui/playwright-measure-the-c-00b4b5`, "the console grab holds the corner at 0 px drift, on following,
parked and streaming consoles (0.48.3)") merged as **`8e7c01e`**, which reads `0.48.3`. PR #185
(`wtgui/playwright-measure-the-c-545668`) was rebase-merged, so its merge commit **is** its tip `c063405`, reading
`0.49.3`. `git merge-base --is-ancestor` is true for both, and
`git diff --stat c063405 origin/main -- tools/measure-console-grab.mjs` is empty: the harness on `main` is byte for
byte the one measured below.

## The shape it has, against the brief's list

- **The tool.** `tools/measure-console-grab.mjs` (580 lines) keeps the verifier's sandbox shape — throwaway
  `PANEL_CONFIG` / `HERMES_HOME` / jobs store / projects cache, ephemeral port, assistant off, `fetchSeconds: -1` —
  and adds a stub Runs API over real SSE, so three consoles on one board are live while they are dragged. It reads the
  cap the page is using (`320 px` inside `.agents-block`, `public/style.css:472`) instead of assuming the base 230.
- **Pointerdown changes no height.** Case 1 measures each console before and after the press, and what the press
  leaves in the inline style.
- **One gesture, down then up.** Case 2 records `gap` = console bottom − pointer y at all 16 steps and reports the
  largest |`gap` − opening gap| as the drift.
- **Following, parked, streaming.** Case 3 drags one of each: a console on its tail, one the reader parked 137 px up,
  and one whose transcript grows while the pointer is down.
- **Outside the card, and past the viewport edge.** Case 4a releases 115 px left of the card and proves a further
  unbuttoned move changes nothing; 4b drags to 200 px below the 900 px viewport.
- **The record.** Every case also reads `state.outHeights[pre.dataset.out]`, the height the drag's own `pointerup`
  writes (`rememberOutHeight`, `public/app.js:372`, called at `public/app.js:14289`).
- **The report** lives outside the repo, at `C:/CodeReviews/agent-worktree-gui/resize/grab.md`, with the capture, the
  run log and a copy of the harness beside it.

## Re-checked on this tree, at `65f1e8e` (0.51.0)

Run from `C:/ProjectDevelopment/agent-worktree-gui/.worktrees/playwright-measure-the-c-54fd7a`; the tool's own clock
read `2026-11-02T02:50:12Z` (21:50:12 EST, 2026-11-01) at its start, and `date -u` read `02:50:59Z` during the run.

- `git rev-list --left-right --count origin/main...HEAD` → `0 0` before this commit (the tree was cut on `main`'s
  tip), `0 1` with it: this document is the branch's only commit.
- `command node tools/measure-console-grab.mjs --json <capture>` → **`RESULT: PASS`, exit 0, five cases PASS, 0
  failed checks**. Panel `http://127.0.0.1:55512`, viewport 1440×900, `public/app.js` sha256
  `f26b696be9933f5fe7a3aabc66c3f63deb9bbfa32b71c582e1903d84153eaffa` (972,997 bytes).
  - **case 1**, three consoles: **320 → 320 px, delta 0.0 px** each; inline `height: 320px` / `max-height: none`
    during the press; released with no drag → `height: ""`, `max-height: 320px`, no stored height (`null`).
  - **case 2**, 8 steps down and 8 back up: heights **320 → 480 → 320**, exactly 20 px per step; every `gap`
    **4.9 px**; **max drift 0.0 px over 16 steps**; records nothing, because it closed where it opened.
  - **case 3**: drift **0.0 / 0.0 / 0.0 px**; the follower was 0 px off its tail at press and at release (one 17 px
    sample mid-drag); the parked console's `scrollTop` **372 → 372**; the streaming console's transcript grew
    **138 px** while the pointer was down; none recorded a height.
  - **case 4a**: 320 → 380 px, `gap` 4.9 px at the press, 60 px down and 115 px left of the card; the release moved
    the height **0.0 px**, a further unbuttoned move **0.0 px**, and **380 px** was recorded.
  - **case 4b**: y=890 → 807 px, y=960 → 877 px, y=1100 (200 px below the edge) → **1017 px**, `gap` 4.9 px at every
    step; the release held and recorded **1017 px**.
- `command node --test --test-concurrency=4 test/*.test.js` → **742 tests, 742 pass, 0 fail, 0 skipped**, 82.6 s.
- `node tools/version.mjs check` → exit 0 against `origin/main`.

## What moved since the last measurement

The report's previous revision was taken on `de6c384` (0.49.2). `de6c384` → `65f1e8e` is six commits, one of them in
`public/app.js`: `8237843` "one console size drives normal, reasoning and tool text". The gesture numbers did not move —
same 0.0 px press delta, same 4.9 px gap, same 0.0 px drift, same 320 → 480 → 320 heights, same 380 and 1017 px
recorded releases. The transcript in each console reads 620 px now (620–637 px then), and the drag block moved ten
lines up (`public/app.js:14268-14286` → `:14258-14293`, pinning at `:14266-14267`, the pointerup write at `:14289`).
That revision is archived beside the report as `resize/archive/grab-0.49.2-de6c384.md`, with its capture and log.

## Version

`0.51.1`. `main` is at `0.51.0` (`65f1e8e`), so this is one patch above it. Patch, not minor: the commit adds a
document and moves no product code, which `docs/versioning.md:56` files under patch ("patch — a fix, a doc, a
refactor, or a test-only change"). The harness's own bumps travelled with its landings, 0.48.3 and 0.49.3.
