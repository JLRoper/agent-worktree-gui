# Where a project's branches and pull requests live

The board draws two links on every row: the branch, and the pull request. Neither is a fact about this code — it is a
fact about the repository — so both come from a file the reader can edit, and a project nobody has mapped gets plain
text plus a sentence saying why, instead of a guessed URL that 404s.

| | |
|---|---|
| the file you edit | `logs/hosts.json` — created empty on first boot, gitignored |
| the defaults that ship | `hosts.seed.json` — committed, holds the two hosts this board has |
| the code | `lib/hosts.js` (templates, precedence, the file pair), `lib/project.js` (`prIndex`, `branchLink`), `lib/scheduler.js` (`decorate`), `lib/merge-prompt.js` (the landing doctrine) |
| the routes | `GET /api/hosts` (the whole mapping), `POST /api/hosts/propose` (read a remote, propose, write nothing), `POST /api/hosts/mapping` (write one project) |
| the tests | `test/hosts.test.js` (templates, the seed, the doctrines), `test/pr-cell.test.js` (the row the store keeps) |

`logs/hosts.json` is merged **over** the seed, per host id and per project. That is what lets a new host record ship in
the seed and reach an install whose live file already exists without anybody merging JSON by hand. Nothing but this
pair is read: there is no fallback to `github.com`, and no URL is ever derived from a host record that cannot resolve.

## A host record

```json
{
  "version": 1,
  "hosts": {
    "sefl-bitbucket": {
      "kind": "bitbucket-server",
      "base": "https://git.sefl.com",
      "coordinates": { "projectKey": "IT" },
      "links": {
        "repo":   "{base}/projects/{projectKey}/repos/{repoSlug}",
        "branch": "{base}/projects/{projectKey}/repos/{repoSlug}/browse?at=refs/heads/{branch}",
        "pull":   "{base}/projects/{projectKey}/repos/{repoSlug}/pull-requests/{pr}",
        "commit": "{base}/projects/{projectKey}/repos/{repoSlug}/commits/{sha}",
        "newPull": "{base}/projects/{projectKey}/repos/{repoSlug}/pull-requests?create&sourceBranch=refs%2Fheads%2F{branch}&targetBranch=refs%2Fheads%2F{main}"
      },
      "api": {
        "transport": "rest",
        "listOpenPrs":     "{base}/rest/api/1.0/projects/{projectKey}/repos/{repoSlug}/pull-requests?state=OPEN&limit=50",
        "listPullRequests": "{base}/rest/api/1.0/projects/{projectKey}/repos/{repoSlug}/pull-requests?state=ALL&limit=100",
        "tokenEnv": "BITBUCKET_SEFL_TOKEN"
      },
      "landing": "…the prose a landing agent is given…"
    }
  },
  "projects": {
    "email-multi": { "host": "sefl-bitbucket", "coordinates": { "repoSlug": "email-multi" } },
    "fleet-kafka": { "host": "sefl-bitbucket", "coordinates": { "projectKey": "SA", "repoSlug": "fleet-kafka" } }
  }
}
```

`kind` is `github` or `bitbucket-server`. `links.branch` and `links.pull` are **required** — they are the two cells — and
every link template must start from `{base}`. A record with a typo is dropped with a warning rather than taking the
board's links down with it: one bad host id is a project with plain text, not a panel that will not start. Warnings
travel to the page with `GET /api/hosts` and are logged at boot.

## The tokens

| token | comes from | example |
|---|---|---|
| `{base}` | the host record's `base`, trailing slashes trimmed | `https://git.sefl.com` |
| `{owner}` `{repo}` | coordinates (github shape) | `JLRoper` / `agent-worktree-gui` |
| `{projectKey}` `{repoSlug}` | coordinates (Bitbucket shape) | `IT` / `email-multi` |
| `{branch}` | the row's branch as git reports it | `20261023_1724_DMR-44452_internalFrom` |
| `{sha}` | the row's tip | `d55e04d` |
| `{pr}` | the PR number a row matched | `10` |
| `{main}` | the project's base branch | `master` |

Anything else in a template is refused, at load time and at render time, instead of producing a URL with `{branch}` still
in it. A token is encoded **by where it sits**, because the same branch name wants two different answers: a path segment
keeps its slashes (GitHub's `tree/feature/foo`, one segment per branch segment), while a query value is encoded whole
(Bitbucket's `browse?at=refs/heads/feature/foo` becomes `refs%2Fheads%2Ffeature%2Ffoo`). `{base}` is never encoded.

## Which coordinates win

Most specific last:

1. the host record's own `coordinates` (github's `owner`, Bitbucket's `projectKey`) are the defaults;
2. a project's `coordinates` on the record the discovery sweep keeps;
3. `projects.<name>.coordinates` in `logs/hosts.json` — the reader's ruling, and the only one the scan never rewrites.

That is how one repo in `IT` and another in `SA` are told apart without a second host record: `fleet-kafka` above
overrides `projectKey` and inherits everything else.

## The api block, or: what the board fetches to know a PR

`transport` says how the panel reads the list: `gh` for a GitHub checkout with the CLI installed (`gh pr list --state all`
in one call), `rest` for a JSON API reached with a bearer token from the env var named by `tokenEnv`.

`listPullRequests` (all states) wins over `listOpenPrs` when both exist, because an OPEN-only list reads a merged branch
as "none" forever. A missing token, a host that refuses the request and a `gh` that is logged out all look identical from
the cell, so the failure is logged once per fetch — `PR list for email-multi (sefl-bitbucket) failed: …` — and never
silently.

A row finds its PR by three names, cheapest-to-be-wrong first: the branch as it is now, the remote ref its upstream
names, and the six-hex tag the panel's own rename keeps. The tag is an identity for the **tree**, not for the work, so a
tag match is only allowed while the tree still carries that PR's own commit.

## The landing doctrine

`landing` is prose, not a template that has to render into a URL: it keeps its tokens (`git push origin {branch}`) and
`lib/merge-prompt.js` fills them in with this project's coordinates and the branch being landed. It is the host's
doctrine, not the project's — what merging means on `git.sefl.com` (a pull request into `master` reviewed by
`code_review_java`, merged by a human) is not what it means on GitHub — and it is injected as a `LANDING` section that
says so: where it disagrees with the mechanical phases about the remote, the doctrine wins.

A project with no mapping gets a prompt that says no host is mapped, and that PHASE 4's push is not authorised.

## From the page

The project header carries a **host chip** — `host: sefl-bitbucket IT/email-multi`, or `no host` with the reason in its
tooltip. Pressing it opens the Discover strip:

- the server reads the project's own remote (`git remote get-url`), parses host `+` two path segments out of
  `ssh://git@host/it/repo.git`, `https://host/scm/IT/repo.git` and `git@host:owner/repo.git`, and matches the hostname
  against the host records it already has;
- it proposes a host id and coordinates, or says why it cannot (a local path, an unknown hostname, one path segment);
- nothing is written until **Use this mapping** is pressed, which writes only that one project into `logs/hosts.json`,
  leaving every host record and every other project exactly as it was.

A remote the panel cannot map is a proposal it refuses, not a host it invents.

## What a row carries, and what it means

`decorate()` puts these fields on every row, and they are what `/api/state` shows:

| field | meaning |
|---|---|
| `pr` | `{number, state, mergedAt, title, matched}`, or `null` when no PR owns the branch |
| `prUrl` | the PR's page from `links.pull`, or `null` |
| `prWhy` | the sentence saying why `prUrl` is `null` while `pr` exists |
| `branchUrl` / `branchWhy` / `branchLinkFrom` | the branch page, why there is none, and whether it came from `ls-remote` or the last fetch's refs. `branchWhy` quotes the project's `fetchNote` when the reason is a failed fetch |
| `branchChip` | the one word the branch cell draws, or `null`: `local` (the remote listed its heads and this branch was not among them), `unverified` (the panel could not get an answer — the sentence behind it quotes the project's `fetchNote`), or nothing at all for a linked branch |
| `branchLocalOnly` | `true` only for `branchChip === "local"` — the one state that word is allowed to describe. `unknown` (unreachable remote, row not read yet) and a project with no remote are `false` |

The chip is drawn from `branchChip`, not from `remoteBranch`: a row whose remote could not be reached wears
`unverified`, never `local`, because "cannot tell whether the remote has this branch yet" and "this branch exists only
on this box" are different claims and the cell must not show the stronger one — nor, as it once did, nothing at all,
which made an unverifiable branch look like one nobody had pushed.

All of them are computed from the ROW'S BRANCH, so a tree that switches branch (a follow-up cut in place, a `git
branch -m` rename the panel made) is decorated again on the read that sees the new name — see `scanOne` in
`lib/scheduler.js`. Otherwise the row wears the page and the PR of the branch it left.

A PR number with no page to open is still useful, so the cell keeps the number as plain text and puts the reason in its
tooltip. A guessed page is not: nothing here falls back to a host it cannot resolve.

## Verifying a mapping

```bash
# what the panel resolves for every project, and why not when it cannot
curl -s http://127.0.0.1:7473/api/hosts | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);for(const [n,v] of Object.entries(d.projects))console.log(n,'->',v.host||'unmapped',JSON.stringify(v.coordinates||{}),v.why||'')})"

# the row as the board reads it: pr, prUrl, branchUrl
curl -s http://127.0.0.1:7473/api/state | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);for(const p of d.projects)for(const w of p.worktrees)if(w.pr)console.log(p.name,String(w.branch),'#'+w.pr.number,w.pr.state,w.prUrl)})"
```

If a PR cell is empty while the branch is in the fetched list, read the panel's own log first: a `PR list … failed` line
means the fetch, a row with no `pr` at all means the row was never decorated — which is what a throw between `prFor` and
`putRow` looks like, and `test/pr-cell.test.js` is the test that fails when it happens.
