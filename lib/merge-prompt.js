// The prompt a MERGING agent runs on, and the name its card carries.
//
// A worktree row's UNMERGED chip starts one of these: an agent in that worktree whose whole job is to land the
// branch on the project's base branch without losing a line of what is already there, prove it with the repo's
// own tests, and leave nothing running behind it. The script lives here, in one place, because every clause in it
// is a rule the panel cannot enforce from the outside - git and the tests are the only ones who can.
//
// Two things it is deliberately NOT:
//   - not a rebase-only script: `--ff-only` is attempted first, and a moved base is handled by a rebase (the
//     house convention) or a real merge commit when the repo keeps them, never by discarding either side;
//   - not a test runner with a hardcoded command list: the repo is asked what it has (package.json scripts,
//     playwright configs, gradle/maven, CI workflows) and a suite that cannot run is reported as not run.

// The card's name: the branch this merge lands on, in capitals, so every one of these reads as the same job
// ("MERGING into MAIN") no matter which branch or project it belongs to.
export function mergeLabel(base) {
  const b = String(base || "main").trim() || "main";
  return `MERGING into ${b.toUpperCase()}`;
}

// Plain text on purpose: it is read in a console by a model, not rendered as markdown.
export function mergePrompt(o = {}) {
  const project = String(o.project || "this project");
  const worktree = String(o.worktree || "").replace(/\\/g, "/");
  const root = String(o.root || "").replace(/\\/g, "/");
  const branch = String(o.branch || "HEAD");
  const base = String(o.base || "main");
  const remote = String(o.remote || "");
  const baseRef = String(o.baseRef || base);
  const ahead = Number.isFinite(o.ahead) ? o.ahead : null;
  const commits = Array.isArray(o.commits) ? o.commits.filter(Boolean).slice(0, 20) : [];
  const stamp = String(o.stamp || "merge").replace(/[^0-9A-Za-z_-]+/g, "-");
  const backup = `wtgui-merge-backup/${stamp}`;
  const label = mergeLabel(base);
  const remoteLine = remote
    ? `remote: ${remote}   base ref for comparisons: ${baseRef}`
    : "remote: none (this repo is local only - do not push)";
  const count = ahead === null ? "n" : String(ahead);
  const commitLines = commits.length ? commits.map((c) => `    ${c}`).join("\n") : "    (ask git: git log --oneline " + baseRef + "..HEAD)";

  return `MERGING into ${base.toUpperCase()} - ${project}: land ${branch} (${count} commit${count === "1" ? "" : "s"}) on ${base}, prove it with the tests, push, clean up.

You are the merge agent for ONE worktree of ${project}. This branch is about to land on the branch everyone else's
work sits on. Every "never" below exists because breaking it loses somebody's work, and a merge that breaks one of
them is worse than no merge at all.

WHERE THINGS ARE
  your worktree (on ${branch}): ${worktree}
  the project checkout where ${base} is checked out: ${root}
  base branch: ${base}
  ${remoteLine}
  commits to land (the board's own count): ${count}
${commitLines}

Start in your worktree and read before you touch:
  cd "${worktree}"
  git status --porcelain                        <- must be empty
  git worktree list --porcelain                 <- where ${base} is actually checked out
  git log --oneline ${baseRef}..HEAD
If ANY file is modified or untracked, stop and report: somebody's unfinished work must not be merged by you.
If the base branch is not checked out anywhere, stop and report - do not invent a second checkout of it.

PHASE 1 - a fresh base
  git fetch --prune ${remote || "(no remote)"}                  (skip when there is no remote)
  git rev-list --count ${baseRef}..HEAD        <- what you are landing
  git log --oneline HEAD..${base}              <- what ${base} has that you do not (this is what moves under you)
If the count is 0 there is nothing to land: report that and stop.

PHASE 1B - the version bump: you decide the level, and it lands with the change
The version lives once, in package.json, and it is the only thing that tells the board's config line which build
is running. Which level it moves by is YOUR judgement, made from the diff you are about to land - a tool advises,
a hook refuses, neither one decides. Read docs/versioning.md first, then:
  cd "${worktree}"
  node tools/version.mjs suggest                    <- the level it reads from the commit subjects, with the reason
                                                       for each commit; it also reads the PR's title and body when
                                                       gh has them, and says so when a commit has no prefix it can
                                                       read instead of guessing. ADVICE: it writes nothing.
  node tools/version.mjs apply <patch|minor|major>   <- writes the new version to package.json, the ONE place it
                                                       lives, and prints the old and the new value
The scale, in one line each: major breaks a contract someone outside this PR depends on (a store this panel reads
back, an action line's grammar, a route's payload, a config key removed); minor adds a capability that breaks
nothing (a section, an action line, a route, a harness that enforces something); patch is a fix, a doc, a refactor
that moves code without changing behaviour, or a test-only change. The suggestion is advice - if you disagree with
it, land the level you can defend and say why.
Land the bump as a commit ON ${branch}, before PHASE 2, with the level and the reason in its own message, and say
the same level and reason in the PR body: the squash merge composes main's commit body from this branch's subjects,
so a bump nobody explained is a version in main's history nobody can account for. Do not let a script pick it and
do not skip it because the diff "looks small" - a version that does not move with its change tells every reader
that nothing moved. A push of this branch without the bump is refused by .githooks/pre-push (which runs
node tools/version.mjs check); that refusal is a stop, not something to push past with --no-verify.

PHASE 2 - land it without losing anything on ${base}
1. Safety ref first, before any write, so a bad merge is recoverable:
     cd "${root}"
     git branch -f ${backup} ${base}
     BASE_BEFORE=$(git rev-parse ${base})
2. The project checkout must be safe to touch:
     git rev-parse --abbrev-ref HEAD              <- must be ${base}
     git status --porcelain                       <- must be empty
     test -f .git/MERGE_HEAD && echo mid-merge    <- must print nothing
   If any of the three fails: STOP and say which. Never stash, checkout, reset or clean the reader's tree to make
   it fit your merge - that tree is theirs.
3. Fast-forward first. This is the case that cannot lose anything: every commit ${base} had stays an ancestor.
     git merge --ff-only ${branch}
   Read the output, do not assume it. A refusal here usually means ${base} moved forward while the branch was open.
4. If --ff-only is refused because ${base} moved on, land the branch on top of it instead:
     a. rebase in YOUR worktree (linear history is this repo's convention):
          cd "${worktree}" && git rebase ${base}
     b. conflicts are resolved by keeping BOTH intentions. Read the file, keep ${base}'s lines and add the branch's
        change around them. Never resolve by deleting the other side's lines, never "git checkout --ours ." or
        "--theirs ." wholesale, never "-X ours"/"-X theirs". A conflict you cannot resolve correctly is a stop:
        "git rebase --abort", leave both trees exactly as you found them, and report the colliding paths.
     c. after a clean rebase, run PHASE 3 on the rebased tree FIRST, then retry step 3.
     d. only if this repo keeps merge commits (check: "git log --merges -5 ${base}" is non-empty) may you make one:
          cd "${root}" && git merge --no-edit ${branch}
        The conflict rule in (b) applies unchanged.
5. Prove nothing of ${base}'s was dropped - run both and read them:
     git diff --stat $BASE_BEFORE..${base}
     git diff --diff-filter=D --name-only $BASE_BEFORE..${base}
     grep -rn "^<<<<<<<\\|^>>>>>>>" --include=* . | head        <- no conflict markers anywhere
   Every deleted path must be one THIS branch deleted on purpose (git log --diff-filter=D --oneline -- <path> shows
   a commit of this branch). A path that exists on $BASE_BEFORE and is gone after the merge with no such commit is a
   broken merge: "git reset --hard $BASE_BEFORE", then report. Never leave ${base} in that state.

HARD RULES - any one of these broken and you undo instead of pushing
- Never force-push, never rewrite published history, never "git push --force"/"-f".
- Never "git reset --hard", "git clean -fd", "git checkout ." or "git stash" in ${root}: that tree is the reader's.
- Never delete a line, file, test or config that existed on ${base} to make a conflict or a failing test go away.
- Never land the branch by copying files ("git checkout ${branch} -- .", cp -r): a merge is a commit graph, not a diff.
- Never amend or rewrite a commit that ${baseRef} already carries.
- Do not touch other worktrees, other branches, or the panel's own tree.
- Ports: never bind one that is already listening, and never stop a process you did not start. The panel itself is on
  ${Number(o.panelPort) || 7473} - that port is off limits in every direction.

PHASE 3 - run the tests this repo actually has (after the merge, on the merged tree)
Discover the commands, do not invent them:
  package.json scripts (test, test:unit, test:integration, test:e2e, lint), playwright.config.{js,ts,mjs},
  gradlew tasks / pom.xml profiles / go test / pytest, and .github/workflows for what CI runs.
Run, and record the real result of each:
  - unit tests
  - integration tests (a script or profile named integration/e2e/api)
  - Playwright / browser tests when a config exists
A suite that cannot run for an environmental reason is reported as NOT RUN with the reason. It is never reported as
passing, and a failure is never fixed by deleting or skipping the test.

PLAYWRIGHT - on its own port, never a server somebody else started
  - Pick a free port above 7800 that nothing is listening on (netstat -ano | grep LISTENING, or a Node
    net.createServer().listen(0) probe). ${Number(o.panelPort) || 7473} and any port already in use are excluded.
  - Start the app under test yourself, on that port: the repo's own "npm run dev"/"node server.js" with PORT=<port>
    (read package.json / README for the variable), or "docker compose -p wtgui-merge-${stamp} up -d" with the port
    mapped <port>:<container port>.
  - Wait until it answers before Playwright starts: curl -fsS http://127.0.0.1:<port>/ (2xx, not a connection refused).
  - Point Playwright at it: PLAYWRIGHT_BASE_URL / the config's baseURL / a temp config with baseURL set and
    reuseExistingServer: true. If the config owns a webServer, give that server the same port so no second instance
    fights yours. Write reports under the OS temp dir, never into the repo.
  - Tear down in this order, even when the tests fail:
      the server you started (taskkill /PID <pid> /T /F on Windows, kill -TERM elsewhere),
      docker compose -p wtgui-merge-${stamp} down -v --remove-orphans
    then prove it: the port refuses connections and "docker ps -a --filter name=wtgui-merge-${stamp}" is empty.

PHASE 4 - publish, only when the tests passed
     cd "${root}"
     git push ${remote || "<remote>"} ${base}
     git fetch ${remote || "<remote>"} && git rev-parse ${base} ${baseRef}     <- both must print the same sha
Never push when a test failed, when either tree is dirty, or when step 5 showed a deletion you could not explain.

PHASE 5 - clean up after yourself
- Stop every server, container, network and volume you started in PHASE 3; remove temp configs and reports you wrote
  outside the repo. Nothing of yours may still be listening when you finish.
- "git status --porcelain" in the worktree and in ${root} must read exactly as you found them (the merge itself is
  committed by definition; nothing else).
- The safety branch ${backup} stays in place. Do not delete it: the push is the record, and deleting a branch is the
  reader's call, not an agent's. Name the ref and the one command that removes it in your report.
- Do not delete the worktree, the branch or the panel's row. The reader does that from the board.

PHASE 6 - report (the last thing you say, and the only summary that counts)
  ${label}: <branch> -> ${base}, ${count} commits, landed by {fast-forward | rebase+ff | merge commit}, pushed to ${remote || "no remote"}
  base: $BASE_BEFORE -> <sha now>   files: +A -D (from git diff --shortstat)
  version: <old> -> <new> (<patch|minor|major>: <the reason, one line, the same one in the PR body>)
  tests: one line per suite - <command> -> <pass/fail with counts>, or "not run: <reason>"
  playwright: port <port>, <passed/failed>, torn down: yes/no
  safety ref: ${backup} kept at $BASE_BEFORE (git branch -D ${backup} removes it)
  cleanup: what you stopped or removed
  open: anything you could not do, with the command and its output
A merge reported as done without these lines did not happen.`;
}
