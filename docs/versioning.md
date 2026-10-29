# Versioning this panel

The version is one number, declared once, in `package.json`'s `"version"`. Nothing else carries it: there is no
tag (`git tag` lists nothing on this repo), no changelog to keep in step, and no second copy in the code — the
server reads that field and hands it to the page, which prints it on the board's own config line
(`v0.3.0 · 9 project(s) · …`). A bump is therefore a one-line change and is visible where you already look.

## The bump is a judgement, made by the agent landing the change

A version number answers one question: *who outside this PR can this break, and how much?* That is a question
about the diff, and the only reader who has the diff is the agent landing it. So:

- **the level is the landing agent's call**, not the tool's and not the hook's. `node tools/version.mjs suggest`
  reads the commits and prints an advice; that advice is a floor to argue with, not an answer.
- **the bump goes in the same PR as the change it describes.** One branch is one revertable unit, landed as one
  commit on main, so the version that names the change has to travel with it. A bump landed separately cannot be
  reverted with the thing it was describing.
- **the same level, and the reason for it, go in the PR body and in the commit the change lands with** — the
  squash merge composes main's commit body out of this branch's own subjects, so a bump with no reason behind it
  becomes a version number in main's history that nobody can account for.

## The three levels

### major — a contract someone outside the PR depends on breaks

Someone else's file, habit or code stops working. In this panel that means, for example:

- **a store the panel reads back changes shape** — the job store it reloads on restart, the description record
  and its own `DESCRIPTIONS_VERSION` (`lib/descriptions.js`), `assistant.json`, the charter file. An old file
  that no longer loads, or loads as something else, is a broken contract.
- **an action line's grammar changes** — the lines a model is told to write and the panel is told to carry out
  (`lib/assistant/actions.js`). Every line a model already wrote stops meaning what it said.
- **a route's payload changes** — a route the page is built around (`/api/settings`' `settings` object, the SSE
  snapshot) losing a field or changing a shape, for anyone with a client, a bookmark or a script of their own.
- **a config key goes away** — `config.json` is the reader's file. Removing or renaming a key makes their file
  stop meaning what it says.
- **a gesture is swapped** — the shape of `Swap the reply box's gestures: Ctrl+Enter steers, Enter holds the
  reply`: muscle memory is a contract too, and everyone who learned the old one is broken by it.

No merge on main has been landed as a major yet: `0.2.0` was declared wholesale, not derived
(`Bump version to 0.2.0`), so the first major is the first real break.

### minor — a new capability that breaks nothing

Something the panel could not do before, added without moving what already exists:

- **a new section or strip** — `Add a Charter tab beside Scratchpad that reads and edits the file`.
- **a new source of rows** — `Monitor Claude Code sessions alongside Hermes`.
- **a new reader-facing affordance** — `Collapse a big paste into one inline chip the reader can quote, unfold
  and delete`.
- **a new route, or a new field on one** — additive, and the old shape still answers.
- **a new harness that enforces something** — a check that can now fail a landing (`Put the chart's age collapse
  under a browser proof`) is a capability the repo did not have. This is the one place the scale needs care: a
  *new* gate is a minor, while *changing an existing test* (below) is a patch.

### patch — a fix, a doc, a refactor, or a test-only change

Nothing new for a user and nothing broken for anyone:

- **a fix** — `Stop offering an approval the gateway has already decided`.
- **a doc** — anything under `docs/`, this file included.
- **a behaviour-preserving refactor** — `Lift the event-to-console translator into its own module`: the code
  moved, the panel behaves the same, and the module count is not a capability.
- **a test-only change** — adjusting, extending or repairing a harness, `A verify script's scratch store goes
  with its run`.

## What the tools do, and what they do not

| | |
|---|---|
| `node tools/version.mjs suggest` | reads the branch's commits (and its PR's title and body, when `gh` has them) against the base and prints the level it reads from the conventional-commit prefixes, with a reason per commit. It says so when a prefix is missing instead of guessing. **Advice — it writes nothing.** |
| `node tools/version.mjs check` | the pipeline's gate: exits non-zero when the branch carries commits and `package.json` still holds the base's version, naming the commits. Silent and zero on an already-bumped branch, and on a branch with no commits. It never writes. |
| `node tools/version.mjs apply <patch\|minor\|major>` | writes the new version to `package.json` — the one place it lives — and prints old and new. Run by the landing agent, deliberately; never by `check` and never by a hook. |
| `.githooks/pre-push` | makes forgetting impossible: it runs `check`, so a push cannot carry a bump-worthy branch with no bump. |
| the merge prompt (`lib/merge-prompt.js`) | tells the landing agent to decide the level from the diff, run `apply`, and state the level and the reason in the PR body and the commit. |

The prefixes `suggest` reads are the ordinary ones: `feat:` → minor, `fix:`/`docs:`/`test:`/`chore:` → patch,
`!` after the type (or a `BREAKING CHANGE:` line in the body) → major. A commit with no prefix it can read is
reported as unclassified and the level it prints becomes a floor rather than an answer.
