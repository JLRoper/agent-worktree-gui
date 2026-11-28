// core/command-summary-git.js - the git side of the permission card's reading: what a `git ...` step is about,
// and whether that step reads this repo or changes it.
//
// CUT 1 of public/core/command-summary.js (row 523, Wave A rank 22 of
// docs/reports/module-separation-2026-11-28.html, whose card names the range 439-630: gitStep alone). Moved
// verbatim from that file at f22b1c78, lines 407-630: pathsOf, countOf, GIT_GLOBAL_VALUE, gitParts, GIT_READS and gitStep.
// The declarations above gitStep travelled with it because gitStep and the parent's non-git steps BOTH read
// pathsOf and countOf, and gitParts is the git subcommand parser that gitStep is dispatched from. A helper shared
// across the boundary cannot stay on one side of it, so this module starts 32 lines above the card's number, and
// that one deviation from the card is named in the commit and the report.
//
// Published on globalThis as `wtCommandSummaryGit`, loaded BEFORE public/core/command-summary.js in
// public/index.html. In a classic script the page global is the import statement: the entry point reads countOf,
// gitParts, gitStep and pathsOf off this object, and keeps publishing `wtCommandSummary` with exactly its four
// names (MAX_CONSEQUENTIAL, html, splitSteps, summarize) for public/board/approvals.js and
// test/approval-command-summary.test.js.
(function (root) {
  "use strict";

  const pathsOf = (args) => args.filter((a) => a !== "--" && !a.startsWith("-"));
  function countOf(paths, what = "path") {
    if (!paths.length) return "";
    if (paths.length === 1) return paths[0] === "." ? "everything under this directory" : `this one ${what}`;
    return `${paths.length} ${what}s`;
  }

  // A git subcommand may sit behind a global flag that takes a value (-C dir, -c key=val, --git-dir dir).
  const GIT_GLOBAL_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
  function gitParts(args) {
    let i = 0;
    while (i < args.length) {
      const a = args[i];
      if (GIT_GLOBAL_VALUE.has(a)) {
        i += 2;
        continue;
      }
      if (a.startsWith("-")) {
        i += 1;
        continue;
      }
      break;
    }
    return { sub: String(args[i] || "").toLowerCase(), rest: args.slice(i + 1) };
  }

  const GIT_READS = new Set([
    "status", "diff", "log", "show", "rev-parse", "hash-object", "cat-file", "ls-files", "ls-tree", "blame",
    "grep", "shortlog", "describe", "merge-base", "for-each-ref", "show-ref", "count-objects", "fsck", "whatchanged",
    "reflog", "version", "help", "check-ignore", "check-attr", "name-rev", "var", "config",
  ]);

  function gitStep(sub, rest) {
    const paths = pathsOf(rest);
    const flagSet = (names) => rest.some((a) => names.includes(a));
    const anyFlag = (re) => rest.some((a) => re.test(a));
    switch (sub) {
      case "status":
        return { text: "git status: what has changed in this tree", writes: false, kinds: [] };
      case "diff": {
        const staged = flagSet(["--cached", "--staged"]);
        // `git diff` IS a comparison of blobs by hash: saying so is the plain sentence a reader who does not read
        // git's own vocabulary can act on, and it is exactly what the index-versus-worktree pair does.
        const what = !paths.length
          ? staged
            ? "the staged blobs against the last commit"
            : "the worktree against the index"
          : `${paths.length === 1 ? "the blob hashes of this path" : `the blob hashes of ${paths.length} paths`} ${staged ? "in the index and the last commit" : "in the index and the worktree"}`;
        return { text: `git diff${staged ? " --cached" : ""}: compare ${what}`, writes: false, kinds: [] };
      }
      case "log":
        return { text: `git log: the recent commits${countOf(paths) ? `, for ${countOf(paths)}` : ""}`, writes: false, kinds: [] };
      case "show":
        return { text: "git show: one commit's contents", writes: false, kinds: [] };
      case "rev-parse": {
        const ofIndex = rest.some((a) => a.startsWith(":"));
        return {
          text: ofIndex
            ? "git rev-parse: the object id this path has in the index"
            : "git rev-parse: the commit ids and refs this tree resolves to",
          writes: false,
          kinds: [],
        };
      }
      case "hash-object":
        return {
          text: `git hash-object${anyFlag(/^-w/) ? " -w" : ""}: the blob hash git gives this path's bytes in the worktree`,
          writes: anyFlag(/^-w/),
          kinds: anyFlag(/^-w/) ? [["write", "writes a blob into the object database"]] : [],
        };
      case "ls-files": {
        const staged = flagSet(["-s", "--stage"]);
        const where = countOf(paths);
        return {
          text: staged
            ? `git ls-files -s: the index entries${where ? ` for ${where}` : ""}`
            : `git ls-files: the paths git is tracking${where ? `, ${where}` : ""}`,
          writes: false,
          kinds: [],
        };
      }
      case "cat-file":
        return { text: "git cat-file: an object out of the object database", writes: false, kinds: [] };
      case "blame":
        return { text: "git blame: who last touched each line", writes: false, kinds: [] };
      case "grep":
        return { text: "git grep: a search through the tracked files", writes: false, kinds: [] };
      case "add": {
        const all = flagSet(["-A", "--all", "-a"]);
        const update = flagSet(["-u", "--update"]);
        const subject = countOf(paths) || (all ? "everything that changed in this tree" : update ? "the tracked files that changed" : "nothing named here");
        return { text: `git add: ${subject}`, writes: true, kinds: [] };
      }
      case "rm": {
        const cached = flagSet(["--cached"]);
        const label = `git rm${cached ? " --cached" : ""}`;
        return {
          text: `${label}: ${countOf(paths) || "nothing named here"}`,
          writes: true,
          kinds: cached ? [] : [["delete", "deletes files from the worktree"]],
        };
      }
      case "mv":
        return { text: `git mv: ${paths.length > 1 ? "this path, to a new name" : "this one path, to a new name"}`, writes: true, kinds: [] };
      case "commit": {
        const amend = flagSet(["--amend"]);
        const all = flagSet(["-a", "--all"]);
        return {
          text: amend
            ? "git commit --amend: the last commit, replaced"
            : `git commit${all ? " -a" : ""}: ${all ? "every tracked change" : "the staged changes"}`,
          writes: true,
          kinds: amend ? [["rewrite", "rewrites the last commit"]] : [],
        };
      }
      case "push": {
        const force = rest.some((a) => a === "-f" || a === "--force" || a.startsWith("--force-with-lease") || a === "--mirror");
        const del = flagSet(["--delete", "-d"]);
        const remote = paths[0] || "";
        const branch = paths[1] || "";
        const to = remote || "origin";
        if (del) {
          return {
            text: `git push --delete: ${branch || "this branch"} on ${to}`,
            writes: true,
            kinds: [["delete", "deletes a branch on the remote"], ["push", `pushes to ${to}`]],
          };
        }
        return {
          text: `git push${force ? " --force" : ""}: ${branch || "this branch"} to ${to}`,
          writes: true,
          kinds: force ? [["rewrite", "rewrites the remote branch"], ["push", `pushes to ${to}`]] : [["push", `pushes to ${to}`]],
        };
      }
      case "pull":
        return { text: `git pull: ${paths[0] || "origin"}'s commits into this branch`, writes: true, kinds: [] };
      case "fetch":
        return { text: `git fetch: ${paths[0] || "the remote"}'s refs`, writes: false, kinds: [] };
      case "reset": {
        const hard = flagSet(["--hard"]);
        return {
          text: hard
            ? "git reset --hard: this branch's tip, and every uncommitted change with it"
            : `git reset${flagSet(["--soft"]) ? " --soft" : ""}: this branch's tip`,
          writes: true,
          kinds: hard ? [["delete", "discards uncommitted changes"], ["rewrite", "moves this branch's history"]] : [["rewrite", "moves this branch's history"]],
        };
      }
      case "rebase":
        return { text: "git rebase: replays this branch's commits onto a new base", writes: true, kinds: [["rewrite", "rewrites this branch's commits"]] };
      case "merge":
        return { text: `git merge: ${paths[0] || "another branch"} into this one`, writes: true, kinds: [] };
      case "cherry-pick":
      case "revert":
      case "am":
      case "apply":
        return { text: `git ${sub}: commits applied to this branch`, writes: true, kinds: [] };
      case "checkout": {
        // A checkout names a branch OR a path, and only one of the two throws work away. `--` settles it, and so
        // does a first argument that reads as a path (a slash, or a leading dot): `git checkout main` switches.
        const dashDash = rest.includes("--");
        const first = paths[0] || "";
        const discards = dashDash || (Boolean(first) && (first === "." || first.includes("/") || first.startsWith("./")));
        const what = paths.length > 1 ? `${paths.length} paths` : "this path";
        return {
          text: discards ? `git checkout: discards the uncommitted changes in ${what}` : "git checkout: switches this tree to another branch",
          writes: true,
          kinds: discards ? [["delete", "discards uncommitted changes"]] : [],
        };
      }
      case "switch":
        return { text: `git switch: this tree onto ${paths[0] || "another branch"}`, writes: true, kinds: [] };
      case "restore": {
        const staged = flagSet(["--staged"]);
        return {
          text: staged
            ? `git restore --staged: ${countOf(paths) || "this path"} back out of the index`
            : `git restore: discards the changes in ${countOf(paths) || "this path"}`,
          writes: true,
          kinds: staged ? [] : [["delete", "discards uncommitted changes"]],
        };
      }
      case "clean":
        return { text: `git clean${anyFlag(/^-.*[fdx]/) ? " -fd" : ""}: every untracked file this pattern matches`, writes: true, kinds: [["delete", "deletes untracked files"]] };
      case "stash":
        return { text: "git stash: the uncommitted changes, put aside", writes: true, kinds: [] };
      case "branch": {
        const del = rest.some((a) => a === "-d" || a === "-D" || a === "--delete");
        if (del) return { text: `git branch -D: ${paths[0] || "the branch named here"}`, writes: true, kinds: [["delete", "deletes a local branch"]] };
        if (paths.length) return { text: `git branch: creates ${paths[0]}`, writes: true, kinds: [] };
        return { text: "git branch: the branches in this repo", writes: false, kinds: [] };
      }
      case "tag": {
        const del = rest.some((a) => a === "-d" || a === "--delete");
        if (del) return { text: `git tag -d: ${paths[0] || "the tag named here"}`, writes: true, kinds: [["delete", "deletes a tag"]] };
        return { text: paths.length ? `git tag: ${paths[0]}` : "git tag: the tags in this repo", writes: Boolean(paths.length), kinds: [] };
      }
      case "worktree": {
        const verb = paths[0] || "";
        const removing = verb === "remove" && rest.some((a) => a === "--force" || a === "-f");
        return {
          text: `git worktree${verb ? ` ${verb}` : ""}: ${removing ? "this tree, and its uncommitted files" : "a checkout of this repo"}`,
          writes: true,
          kinds: removing ? [["delete", "deletes a worktree"]] : [],
        };
      }
      case "filter-branch":
      case "filter-repo":
        return { text: `git ${sub}: every commit, rewritten`, writes: true, kinds: [["rewrite", "rewrites this repo's history"]] };
      case "gc":
      case "prune":
        return { text: `git ${sub}: unreachable objects, swept`, writes: true, kinds: [["delete", "deletes unreachable objects"]] };
      case "submodule":
        return { text: "git submodule: this repo's submodules", writes: true, kinds: [] };
      case "config": {
        const reading = rest.some((a) => a === "--get" || a === "--get-all" || a === "--list" || a === "-l");
        return { text: `git config: ${reading ? "this repo's settings" : "this repo's settings, written"}`, writes: !reading, kinds: [] };
      }
      default:
        if (!sub) return { text: "git: no subcommand", writes: false, kinds: [] };
        if (GIT_READS.has(sub)) return { text: `git ${sub}: reads this repo`, writes: false, kinds: [] };
        return { text: `git ${sub}: ${countOf(paths) || "changes this repo"}`, writes: true, kinds: [] };
    }
  }

  root.wtCommandSummaryGit = { countOf, gitParts, gitStep, pathsOf };
})(typeof window !== "undefined" ? window : globalThis);
