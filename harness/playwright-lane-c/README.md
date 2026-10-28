# Playwright lane C — the branch and PR cells against `/api/state`

Read-only browser verification of the two columns a worktree table is read for: **which branch this tree is on and
whether the remote has it**, and **which PR owns it**. It loads a running panel, expands every project, and compares
each row's cell with the same row in `GET /api/state`. It never posts, restarts the server, or writes its logs.

```bash
node harness/playwright-lane-c/verify.mjs                       # the live panel on 127.0.0.1:7331
node harness/playwright-lane-c/verify.mjs --base http://127.0.0.1:7331 --out C:/CodeReviews/agent-worktree-gui/playwright-lane-c
```

Exit code 0 when every check passes, 1 otherwise. It writes `results.json` plus one PNG per pinned cell into `--out`
(default `C:/CodeReviews/agent-worktree-gui/playwright-lane-c`).

`playwright` is installed globally (`npm -g`); this repo stays zero-dependency, so the script resolves it through a
CJS `require` rooted at `WTGUI_GLOBAL_MODULES` (default `C:/Users/roper/AppData/Roaming/npm/node_modules/`) — ESM
ignores `NODE_PATH`.

## What it checks

| State | Requirement |
|---|---|
| `exists` | an `<a class="branch-link">` whose `href` is `row.branchUrl` (the `…/tree/<branch>` page), no chip |
| `gone` | no link; a `.branch-local` chip reading **LOCAL**; the tooltip is the API's `branchWhy`, naming the remote that does not list it |
| `unknown` | never a `local` chip; a chip whose title quotes the project's `fetchNote` |
| no branch | `—`, no link, no chip |
| whole board | no cell says "local" on a row the API calls remote-backed (`remoteBranch !== "gone"`); every `branchUrl` is drawn verbatim |
| PR cell | `#<number> <state>`, `href === row.prUrl`, `pr-open`/`pr-merged`, and `none` where the API has no PR |
| hard refresh | a full `page.reload()` leaves every pinned cell's text/href/chip/tooltip unchanged, with the API re-read in between |

Notes that cost time:

- A `section.project` exists in the DOM before its head does, and a `tr.row` does not exist at all inside a collapsed
  section. Wait for `[data-toggle-project]`, then press every `[data-age-toggle]` arrow — rows older than the
  "hide stale worktrees" threshold are not built, and 19 of 157 were held back on the first pass.
- The board rebuilds a project's `tbody` on every scan, so a locator resolved a moment ago can be detached before the
  shutter opens. `shoot()` re-resolves and retries rather than reporting a repaint as a render bug.
- The page's model is `state.rows` (a `Map` keyed `project::path`) and `state.expandedProjects` (a `Set`), not the
  `/api/state` payload's shape. The "no branch" fixture inserts a row there and calls `renderProjectRows(project)`;
  no live row has an empty branch, and creating a detached worktree for one would write product state.
- The screenshot of a cell is evidence of the word, not of the `href` — read the attribute, and follow the link
  separately if the claim is that its page exists.
