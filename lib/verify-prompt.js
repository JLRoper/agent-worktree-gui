// The prompt a CHECKING agent runs on, the line it answers with, and nothing else.
//
// A worktree row's UNMERGED chip starts one of these: an agent in that tree whose whole job is to answer ONE
// question - is this branch's own change already on the base branch? - and then say so in a line the panel reads.
// The board's own verdict cannot answer it: it counts commits the base does not carry, and a branch that landed by
// squash, rebase, cherry-pick or a hand-rewritten patch carries commits of its own while the base holds the change
// under a different sha. So the check is by CONTENT, which is the only thing those landings preserve.
//
// It is deliberately NOT a merge script: it writes nothing to either branch, pushes nothing, and deletes nothing.
// The one act that follows the answer is the PANEL's - moving the tree to the Recycle Bin when the answer is YES
// and the tree is clean and unlocked (lib/worktree-remove.js) - because that act has to obey the reader's lock and
// the panel's own row bookkeeping, and neither can be honoured by an agent standing in the folder being deleted.

// The card's name, in capitals and keyed on the base branch, so every one of these reads as the same job
// ("CHECKING MAIN") whatever project or branch it belongs to - and so the route can refuse a second one in the
// same tree by looking at the label alone.
export function verifyLabel(base) {
  const b = String(base || "main").trim() || "main";
  return `CHECKING ${b.toUpperCase()}`;
}

// The label prefix every check agent carries. One word, read by the sweep (server.js) and by the page, so a card
// and the delete it causes cannot disagree about which run produced the answer.
export const VERIFY_LABEL_PREFIX = "CHECKING ";

// The four words the panel understands, and no fifth. A fifth word is not a verdict: the sweep deletes nothing
// and the card says it could not read the answer.
export const VERDICTS = ["YES", "PARTIAL", "NO", "SUPERSEDED"];

// Plain text on purpose: it is read in a console by a model, not rendered as markdown.
export function verifyPrompt(o = {}) {
  const project = String(o.project || "this project");
  const worktree = String(o.worktree || "").replace(/\\/g, "/");
  const root = String(o.root || "").replace(/\\/g, "/");
  const branch = String(o.branch || "HEAD");
  const base = String(o.base || "main");
  const baseRef = String(o.baseRef || base);
  const remote = String(o.remote || "");
  const ahead = Number.isFinite(o.ahead) ? o.ahead : null;
  const commits = Array.isArray(o.commits) ? o.commits.filter(Boolean).slice(0, 20) : [];
  const stamp = String(o.stamp || "check").replace(/[^0-9A-Za-z_-]+/g, "-");
  const scratchBase = String(o.scratchBase || "").replace(/\\/g, "/");
  const scratch = `${scratchBase || "<the OS temp dir>"}/wtgui-landed-check-${stamp}`;
  const count = ahead === null ? "n" : String(ahead);
  const remoteLine = remote
    ? `remote: ${remote}   base ref for the comparison: ${baseRef}`
    : "remote: none (this repo is local only - there is nothing to fetch and nothing to push)";
  const fetchLine = remote
    ? `git fetch --prune ${remote}                        <- read-only: it writes no ref on the remote`
    : "(no remote: skip the fetch)";
  const commitLines = commits.length ? commits.map((c) => `    ${c}`).join("\n") : `    (ask git: git log --oneline ${baseRef}..HEAD)`;
  // The reader's lock (lib/locks.js) is enforced by the panel, but a check agent must not even suggest the delete
  // it would trigger: the lock is why the answer is the end of the job.
  const locked = o.locked && o.locked.locked ? o.locked : null;
  const lockLine = locked
    ? `\n  lock: this worktree is LOCKED by the reader (${locked.by === "branch" ? `branch ${locked.branch}` : "this worktree"}).\n        A LANDED: YES line changes nothing: the panel refuses every delete here. Say the lock is why the tree stays.`
    : "";
  const dirty = Number(o.dirty) || 0;
  const untracked = Number(o.untracked) || 0;
  const dirtyLine = dirty || untracked
    ? `\n  the board last saw this tree with ${dirty} modified and ${untracked} untracked file(s). Read "git status --porcelain"\n  yourself before you report, and report what you see: the panel will not delete a tree holding uncommitted work.`
    : "";

  return `CHECKING ${base.toUpperCase()} - ${project}: is ${branch}'s own change already on ${base}? Read only, and answer in one line.

You are the check agent for ONE worktree of ${project}. The board says this branch carries commits ${base} does not
have. That count cannot tell a branch that never landed from one that landed by squash, rebase, cherry-pick or a
hand-written patch: each of those leaves the branch with commits of its own while ${base} holds the change under a
different sha. Your job is to decide from CONTENT which of those it is, prove it with commands whose output you
quote, and say so in the line the panel reads at the end. Nothing you do here lands anything.

WHERE THINGS ARE
  your worktree (on ${branch}): ${worktree}
  the project checkout where ${base} is checked out: ${root}
  base branch: ${base}
  ${remoteLine}
  commits the board counted against it: ${count}${lockLine}${dirtyLine}
${commitLines}

THE ONE ACT THAT FOLLOWS YOUR ANSWER - and it is the panel's, not yours
If your last line is "LANDED: YES", the panel moves this worktree's folder to the Windows Recycle Bin and prunes
git's record of it. It does that only when the tree is clean, unlocked and has no other agent running in it, and it
re-reads all three itself at that moment. So:
  - never delete, move or empty anything yourself; never run "git worktree remove", "rm -rf", or anything that
    edits the worktree's .git file;
  - never commit, stash, clean, checkout, switch or reset anything - in this tree or in ${root}. A dirty tree is a
    finding to report, not a mess for you to tidy, and tidying it is exactly the act that would lose somebody's work;
  - a LANDED: YES you are not sure of is worse than a LANDED: PARTIAL. If two proofs disagree, say PARTIAL and name
    which files you could not read.

PHASE 1 - read the two sides before you judge anything
  cd "${worktree}"
  git status --porcelain                        <- read it, do not change it
  ${fetchLine}
  git rev-parse --verify --quiet ${baseRef}    <- must print a sha; if it prints nothing, STOP and report
  git log --oneline ${baseRef}..HEAD             <- the commits under question
  git merge-base ${baseRef} HEAD                 <- MB: where this branch left the base
  git log --oneline -20 ${baseRef}               <- what the base has done since
If ${baseRef} cannot be read, the honest answer is that the comparison could not be made: finish with
"LANDED: PARTIAL - ${baseRef} could not be read here" and say the command that failed. Never answer YES on a ref you
could not read.

PHASE 2 - the content test: reverse-apply this branch's own change to a pristine export of the base
This is the only test a squash merge survives, so it is the one that decides. Build ONE export, under the OS temp
dir - never inside either tree:
  SCRATCH="${scratch}"
  rm -rf "$SCRATCH"; mkdir -p "$SCRATCH/export"
  cd "${worktree}"
  git archive ${baseRef} | tar -x -C "$SCRATCH/export"
  cd "$SCRATCH/export" && git init -q . && git add -A \\
    && git -c user.email=check@local -c user.name=check commit -qm base
Then this branch's OWN patch - its change against where it left the base, with package.json's version line excluded
because a bump is not work:
  cd "${worktree}"
  MB=$(git merge-base ${baseRef} HEAD)
  FILES=$(git diff --name-only "$MB" HEAD | grep -v '^package.json$')
  git diff "$MB" HEAD -- $FILES > "$SCRATCH/p.patch"
  wc -c "$SCRATCH/p.patch"                       <- 0 bytes means this branch changed nothing but package.json
Then ask the base's own tree, from inside the export:
  cd "$SCRATCH/export"
  git apply --check --reverse ../p.patch && echo "PRESENT"    <- the base ALREADY HAS this change
  git apply --check ../p.patch && echo "MISSING"              <- the base does not have it
  # neither prints: PARTIAL - the base drifted inside the hunks, so score it (PHASE 3)
Windows note: git is a native binary and this shell does not translate MSYS paths, so an absolute "/tmp/..." path
answers "can't open patch". Run the apply from inside the export and hand it ../p.patch, or pass a C:/... path.
Never write the export, the patch or anything else inside ${worktree} or ${root}: they must be exactly as you found
them when you finish.

PHASE 3 - the second reading, and the argument that settles a PARTIAL
  cd "${worktree}"
  git cherry ${baseRef} HEAD                     <- "-" = that patch is already in ${base}; "+" = it is not
  git diff --quiet ${baseRef} HEAD && echo "identical trees"   <- the branch adds NOTHING at all
For every path this branch ADDS, ask the base for the file itself - an ABSENT file cannot be a context-drift
artefact, and that is what closes a failed reverse-apply:
  for f in $(git diff --diff-filter=A --name-only "$MB" HEAD); do
    git cat-file -e "${baseRef}:$f" 2>/dev/null && echo "PRESENT $f" || echo "ABSENT  $f"
  done
For a patch that neither applies nor reverses, score it: the share of the patch's own ADDED lines (longer than 25
characters) that appear verbatim in the base's copy of each file. 90%+ is landed-and-reworded; a low share is work
that is missing.
Subjects, PR titles and dates are corroboration, never proof: a squash merge may have reworded the subject, and a
branch may carry the same words with none of the change.

THE FOUR VERDICTS - pick one, do not split the difference
  LANDED      the base carries this branch's own change. Proved by a clean reverse-apply, or an identical tree, or
              every commit of the branch marked "-" by git cherry with no "+" left.
  PARTIAL     part of it is there. Name which commits or files landed and which did not - the reader's next action
              depends on that difference.
  NO          the branch's own change is absent from the base.
  SUPERSEDED  the base delivers the same reader-facing behaviour by a different route. Name the route with a
              file:line, and what of this branch is still worth salvaging. Superseded is NOT landed: the panel
              deletes nothing on it.

HARD RULES
- Read only. No commit, merge, rebase, cherry-pick, revert, push, tag, branch or worktree command that writes.
- Never touch ${root}: the base branch is checked out there and it is the reader's tree.
- No server, container or dev process, and no port - the panel itself is on ${Number(o.panelPort) || 7473}, and that
  port is off limits in every direction.
- The scratch export is the only thing you may create, and it goes under the OS temp dir. Remove it before you
  report (rm -rf "$SCRATCH") and say that you did.
- Do not edit ${worktree} to make the answer easier: no formatting, no lockfile, no "just this one file".

PHASE 4 - report, and the line the panel reads
Write the report first, then the answer as the LAST line of your message - exactly once, exactly one of the four
words after "LANDED:":

  CHECKING ${base.toUpperCase()}: ${branch} -> ${base}
    verdict: LANDED | PARTIAL | NO | SUPERSEDED - one sentence, and why
    reverse-apply: PRESENT | MISSING | PARTIAL (<x>/<y> added lines present) - with the command output you read
    added files: PRESENT/ABSENT per path, or "none added"
    patch-id: <n> "-" and <n> "+" from git cherry
    tree: clean | <n> modified, <n> untracked - what the panel will refuse if it is not clean
    scratch: what you created and that you removed it
    open: anything you could not read, with the command and its output

  LANDED: YES

An answer reported without those lines did not happen.`;
}

// The answer, read out of the run's own final message.
//
// ONE line, and the LAST one that starts with "LANDED:", is the answer: a report above it may quote the grammar, and
// a model that writes the line twice (a draft, then the real one) means the last. Anything else - no line, a word
// outside the four, an answer only present in the transcript tail and not in a final message - is null, and the
// panel then deletes nothing. That asymmetry is deliberate: a missing answer costs the reader one click, and a wrong
// YES costs them a worktree.
export function verdictFromText(text) {
  const clean = String(text ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  if (!clean.trim()) return null;
  let found = null;
  for (const raw of clean.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^LANDED\s*:\s*([A-Za-z]+)\b(.*)$/.exec(line);
    if (!m) continue;
    const word = m[1].toUpperCase();
    if (!VERDICTS.includes(word)) continue;
    found = { verdict: word, line, note: m[2].replace(/^[\s\u2014-]+/, "").trim() };
  }
  return found;
}
