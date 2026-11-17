// core/command-summary.js - the permission card's plain reading of the command it is about.
//
// WHAT THIS IS. A parked run shows `git add -A && git commit -m "..." && git push -u origin HEAD` and asks the
// reader to allow it. The reader can read the command, but a reader under time pressure reads the SHAPE of it at
// best, and the two things that matter - what each step is about, and whether one of them deletes something,
// rewrites history, pushes, or reaches PROD - are exactly the things a shell line hides. This module derives a
// few short sentences from the command and nothing more: no model call, no network, no lookup. It is a reading of
// the string, computed on the page, every time the card is painted.
//
// THE RULE IT MUST NEVER BREAK. The full command stays on the card beneath the summary, byte for byte, and the
// buttons and countdown are untouched. Nothing here decides anything: a step this module does not understand is
// described honestly as unknown and the card's choices are whatever the host offered. A summary that could be
// mistaken for the thing being approved would be worse than no summary, so every line here is either a fact read
// off the command or a plain statement that the command could not be read.
//
// HOW THE COMMAND IS SPLIT. On `&&`, `||`, a lone `;` or `|`, and on a newline - the real separators, the ways one
// shell line carries several steps. The split is quote-aware, substitution-aware and parenthesis-aware, because
// `echo "a | b"` is one step, `git rm $(git ls-files -m | head -1)` is one step, and `S=$(date +%s%N)` is one
// assignment: a splitter that cut inside any of those would invent steps that do not exist. A card is a display of
// what will run, so the split has to follow the same shell the command will.
//
// A STEP IS ONLY A STEP WHEN IT HAS A PROGRAM. An assignment (`RC=$?`, `S=$(date +%s%N)`) belongs to the step it
// sets up and rides along with it; a fragment (a lone `--`, `+`, `%s%N)`, the tail of an arithmetic expansion)
// belongs to nothing and is dropped. Neither is drawn as a row: the card used to show `+%s%N): no argument` and
// `(empty): no argument` for an eleven-step command whose weight was in two of them.
//
// EACH STEP IS A PROGRAM AND ITS SUBJECT. `git add` with twelve paths is `git add: 12 paths`; `git rm --cached`
// with one is `git rm --cached: this one path`; `git rev-parse :a.txt` beside `git hash-object a.txt` is the two
// blob hashes that compare the index against the worktree. The subject is counted from the arguments where a
// count is the fact (paths, directories) and named where the fact is which thing (a branch, a remote, a file).
//
// THE LIST EARNS ITS LENGTH. At most four CONSEQUENTIAL steps are drawn in full - a delete, a history rewrite, a
// push, a write outside the repo, a PROD or live-port action, a network fetch, a package install, and a step that
// runs as root, which is never harmless. Every other step folds into ONE line that says how many there are and
// names each program once (`7 harmless steps: cd, echo, ls`), expanding on click. A command that only reads
// therefore draws no rows at all: one line, and the reader is done.
//
// THE EFFECTS A READER CARES ABOUT. Deletes, history rewrites, pushes, anything naming PROD or a live port, a
// write outside the repo, and sudo. Those are drawn as their own rows under the steps, in the order that matters,
// and the head carries one chip: `reads only` when no step writes and there is no redirect to a real file,
// `changes things` otherwise. A command that only reads says so in plain words, because "this one is safe to
// allow" is the judgement the reader is being asked to make.
//
// THE AGENT'S OWN WORDS WIN, FOR THE PROSE ONLY. A command may lead with `[Title]` or with a first-line comment
// (`# ...`, `// ...`, never a shebang): that is the agent saying what the step is for, and it is better than
// anything this module can infer, so it becomes the summary's lead line. It never suppresses the flags: those are
// read off the command itself, and hiding "this pushes to origin" because a title was present would be the one
// failure a reader could not forgive.
//
// Published on globalThis as `wtCommandSummary`, loaded before public/app.js in public/index.html, and imported
// by test/approval-command-summary.test.js.
(function (root) {
  "use strict";

  // A step list longer than this is not a prompt any more: four rows carry what a reader is deciding about, and
  // the rest of the command folds behind one line that still says what is in there.
  const MAX_CONSEQUENTIAL = 4;
  const SUBJECT_MAX = 72;
  const LEAD_MAX = 160;

  const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const clip = (s, n = SUBJECT_MAX) => {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    return t.length > n ? `${t.slice(0, Math.max(0, n - 3))}...` : t;
  };

  const isDevNull = (p) => /^\/(dev\/)?null$/i.test(String(p || "")) || /^nul$/i.test(String(p || ""));

  // ---------- the split ----------
  // A span that must be copied whole, because a separator inside it belongs to the inner command: `$(...)`,
  // `${...}` and a backtick pair. Each returns the index just past the closing character, or the end of the text
  // when the span is never closed - the reader is looking at a broken command, and inventing a step for the tail
  // would be worse than keeping it.
  function skipBalanced(text, at, open, close) {
    let depth = 0;
    let quote = "";
    for (let j = at; j < text.length; j += 1) {
      const ch = text[j];
      if (quote) {
        if (ch === "\\" && quote === '"') {
          j += 1;
          continue;
        }
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (ch === "\\") {
        j += 1;
        continue;
      }
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) return j + 1;
      }
    }
    return text.length;
  }

  function skipBacktick(text, at) {
    for (let j = at + 1; j < text.length; j += 1) {
      if (text[j] === "\\") {
        j += 1;
        continue;
      }
      if (text[j] === "`") return j + 1;
    }
    return text.length;
  }

  // One pass, because the same characters decide both where a step ends and what is text: a quote opened before a
  // pipe closes after it, and a `$(` opened before one closes after it. `&>` is a redirect and `2>&1` duplicates a
  // file descriptor - neither is a background job, so neither ends a step.
  function splitSteps(text) {
    const out = [];
    let buf = "";
    let quote = "";
    let depth = 0;
    const push = () => {
      const s = buf.trim();
      if (s) out.push(s);
      buf = "";
    };
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      const next = text[i + 1] || "";
      if (quote) {
        buf += ch;
        if (ch === "\\" && quote === '\"' && next) {
          buf += next;
          i += 1;
          continue;
        }
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === "'" || ch === '\"') {
        quote = ch;
        buf += ch;
        continue;
      }
      if (ch === "\\" && next) {
        buf += ch + next;
        i += 1;
        continue;
      }
      if (ch === "$" && next === "(") {
        const end = skipBalanced(text, i + 1, "(", ")");
        buf += text.slice(i, end);
        i = end - 1;
        continue;
      }
      if (ch === "$" && next === "{") {
        const end = skipBalanced(text, i + 1, "{", "}");
        buf += text.slice(i, end);
        i = end - 1;
        continue;
      }
      if (ch === "`") {
        const end = skipBacktick(text, i);
        buf += text.slice(i, end);
        i = end - 1;
        continue;
      }
      if (ch === "(") {
        depth += 1;
        buf += ch;
        continue;
      }
      if (ch === ")") {
        depth = Math.max(0, depth - 1);
        buf += ch;
        continue;
      }
      if (depth === 0 && ch === "&") {
        if (next === ">" || buf.endsWith(">")) {
          buf += ch;
          continue;
        }
        if (next === "&") i += 1;
        push();
        continue;
      }
      if (depth === 0 && ch === "|") {
        if (next === "|" || next === "&") i += 1;
        push();
        continue;
      }
      if (depth === 0 && (ch === ";" || ch === "\n" || ch === "\r")) {
        push();
        continue;
      }
      buf += ch;
    }
    push();
    return out;
  }

  // ---------- one step as words ----------
  // A word keeps whatever a shell glues to it: a quoted string, a `$(...)` substitution, a `${...}` expansion or a
  // backtick span. `S=$(date +%s%N)` is ONE word, which is why the assignment reads as an assignment and not as a
  // program called `+%s%N)`.
  function tokenize(step) {
    const out = [];
    let buf = "";
    let quote = "";
    let any = false;
    for (let i = 0; i < step.length; i += 1) {
      const ch = step[i];
      const next = step[i + 1] || "";
      if (quote) {
        if (ch === "\\" && quote === '"' && next) {
          buf += next;
          i += 1;
          continue;
        }
        if (ch === quote) {
          quote = "";
          continue;
        }
        buf += ch;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        any = true;
        continue;
      }
      if (ch === "\\" && next) {
        buf += next;
        i += 1;
        any = true;
        continue;
      }
      if (ch === "$" && next === "(") {
        const end = skipBalanced(step, i + 1, "(", ")");
        buf += step.slice(i, end);
        i = end - 1;
        any = true;
        continue;
      }
      if (ch === "$" && next === "{") {
        const end = skipBalanced(step, i + 1, "{", "}");
        buf += step.slice(i, end);
        i = end - 1;
        any = true;
        continue;
      }
      if (ch === "`") {
        const end = skipBacktick(step, i);
        buf += step.slice(i, end);
        i = end - 1;
        any = true;
        continue;
      }
      if (/\s/.test(ch)) {
        if (buf || any) out.push(buf);
        buf = "";
        any = false;
        continue;
      }
      buf += ch;
      any = true;
    }
    if (buf || any) out.push(buf);
    return out;
  }

  // Redirections are removed from the arguments and remembered as writes: `> out.txt` is a write outside any
  // program's own description, and `2>&1` or `> /dev/null` are not writes at all.
  const REDIRECT = /^(?:\d?>>?|&>>?|>\|)$/;
  function stripRedirects(tokens) {
    const kept = [];
    const writes = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i];
      if (REDIRECT.test(t)) {
        const target = tokens[i + 1] || "";
        if (target && !isDevNull(target)) writes.push(target);
        i += 1;
        continue;
      }
      const inline = /^(\d?>>?|&>)(.+)$/.exec(t);
      if (inline && inline[2] && !inline[2].startsWith("&")) {
        if (!isDevNull(inline[2])) writes.push(inline[2]);
        continue;
      }
      kept.push(t);
    }
    return { tokens: kept, writes };
  }

  // Wrappers that are not the program: sudo (remembered, because running as root is an effect), env and its
  // assignments, and the time/nohup/command prefixes.
  function unwrap(tokens) {
    let sudo = false;
    let i = 0;
    while (i < tokens.length) {
      const t = tokens[i];
      const low = t.toLowerCase();
      if (low === "sudo" || low === "doas") {
        sudo = true;
        i += 1;
        while (/^-[A-Za-z]+$/.test(tokens[i] || "")) i += 1;
        continue;
      }
      if (low === "env" || low === "time" || low === "nohup" || low === "command" || low === "exec") {
        i += 1;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
        i += 1;
        continue;
      }
      break;
    }
    return { sudo, index: i };
  }

  // A program is a word the shell would try to run: not a flag, not a redirection, not a shell operator, and not the
  // tail of an expansion. `+`, `%s%N`, `--`, `)` and an empty word are exactly the five fragments the old parse
  // drew as programs, and every one of them fails this test.
  function isProgramName(token) {
    const t = String(token || "");
    if (!t) return false;
    if (/^[-+%()=<>&|;,:]/.test(t)) return false;
    if (/[()]/.test(t)) return false;
    return true;
  }

  function describeTokens(tokens, redirects, sudo) {
    const un = unwrap(tokens);
    const head = tokens[un.index] || "";
    const display = head.split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, "") || head;
    return {
      head,
      display,
      program: display.toLowerCase(),
      args: tokens.slice(un.index + 1),
      tokens,
      redirects,
      sudo: sudo || un.sudo,
    };
  }

  // A `( ... )` group is not a program: its inside is the steps. `(cd docs && ls) && pwd` is three steps in the
  // shell, and a group that is not closed at its own end (`(a) && (b)`) never reaches here.
  function innerGroup(raw) {
    const t = String(raw || "").trim();
    if (!t.startsWith("(") || !t.endsWith(")")) return null;
    return skipBalanced(t, 0, "(", ")") === t.length ? t.slice(1, -1) : null;
  }

  function splitAll(text, depth = 0) {
    const out = [];
    for (const raw of splitSteps(text)) {
      const inner = depth < 4 ? innerGroup(raw) : null;
      if (inner && inner.trim()) out.push(...splitAll(inner, depth + 1));
      else out.push(raw);
    }
    return out;
  }

  // THE STEPS A READER IS SHOWN. A step with no program of its own is not a step: its assignments ride along with
  // the next program (`RC=$?; echo "EXIT_CODE=$RC"` is one row about an echo), and a bare fragment is dropped -
  // `S=$(date +%s%N)` sets up the step after it, while a lone `--` sets up nothing. Anything left over at the end of
  // the line joins the last step rather than becoming a row called `(empty)`, and is handed back when there is no
  // last step so a redirect at the end of a line still raises its own warning.
  function assembleSteps(text) {
    const out = [];
    let carry = null;
    for (const raw of splitAll(text)) {
      const redirect = stripRedirects(tokenize(raw));
      const un = unwrap(redirect.tokens);
      const head = redirect.tokens[un.index] || "";
      if (!isProgramName(head)) {
        const held = carry || { tokens: [], redirects: [], sudo: false };
        held.tokens = held.tokens.concat(redirect.tokens.slice(0, un.index));
        held.redirects = held.redirects.concat(redirect.writes);
        held.sudo = held.sudo || un.sudo;
        carry = held;
        continue;
      }
      const held = carry || { tokens: [], redirects: [], sudo: false };
      carry = null;
      out.push({
        raw,
        ...describeTokens(held.tokens.concat(redirect.tokens), held.redirects.concat(redirect.writes), held.sudo || un.sudo),
      });
    }
    if (carry && out.length) {
      const last = out[out.length - 1];
      last.tokens = last.tokens.concat(carry.tokens);
      last.redirects = last.redirects.concat(carry.redirects);
      last.sudo = last.sudo || carry.sudo;
      carry = null;
    }
    return { steps: out, trailing: carry };
  }

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

  // ---------- programs outside git ----------
  const READS = new Set([
    "cat", "bat", "head", "tail", "less", "more", "wc", "ls", "dir", "pwd", "echo", "printf", "true", "false",
    "date", "which", "whereis", "grep", "egrep", "fgrep", "rg", "ag", "ack", "find", "jq", "sort", "uniq", "cut",
    "tr", "diff", "cmp", "file", "stat", "du", "df", "tree", "sleep", "test", "printenv", "whoami", "hostname",
    "nslookup", "dig", "ping", "traceroute", "uname", "id", "groups", "ps", "top", "history", "cd", "set",
    "export", "unset", "true",
  ]);
  const HTTP_READS = new Set(["curl", "wget", "http", "httpie"]);
  const HTTP_WRITE_METHODS = /^(POST|PUT|PATCH|DELETE)$/i;

  function hostOf(token) {
    const m = /^(?:https?|ftp):\/\/([^/\s]+)/i.exec(token) || /^([a-z0-9_.-]+\.[a-z]{2,})(?::\d+)?/i.exec(token);
    return m ? m[1].replace(/^.*@/, "") : "";
  }

  function nonGitStep(program, args, display) {
    const paths = pathsOf(args);
    const first = paths[0] || "";
    switch (program) {
      case "rm":
      case "rmdir":
      case "unlink":
      case "del":
      case "erase":
        return { text: `${program}: ${countOf(paths) || "nothing named here"}`, writes: true, kinds: [["delete", "deletes files or directories"]] };
      case "mv":
        return { text: `mv: ${paths.length > 1 ? "this path, to a new name" : "nothing named here"}`, writes: true, kinds: [] };
      case "cp":
        return {
          text: `cp: ${paths.length > 1 ? "this path, to that one" : paths.length ? "this path, to a copy" : "nothing named here"}`,
          writes: true,
          kinds: [],
        };
      case "mkdir":
        return { text: `mkdir: ${countOf(paths, "directory") || "nothing named here"}`, writes: true, kinds: [] };
      case "touch":
      case "chmod":
      case "chown":
      case "ln":
        return { text: `${program}: ${countOf(paths) || "nothing named here"}`, writes: true, kinds: [] };
      case "sed": {
        const inPlace = args.some((a) => /^-[a-z]*i/.test(a) || a === "--in-place" || a.startsWith("--in-place="));
        return {
          text: inPlace ? `sed -i: rewrites ${countOf(paths) || "this file"} in place` : "sed: rewrites these lines on their way through",
          writes: inPlace,
          kinds: [],
        };
      }
      case "grep":
      case "rg":
      case "ag":
      case "ack": {
        const pattern = args.find((a) => !a.startsWith("-"));
        return {
          text: `${program}: a search${pattern ? ` for "${clip(pattern, 40)}"` : ""}${paths.length > 1 ? ` in ${paths.length - (pattern ? 1 : 0)} paths` : ""}`,
          writes: false,
          kinds: [],
        };
      }
      case "find": {
        const del = args.some((a) => a === "-delete");
        return {
          text: `find: walks ${first || "this tree"}${del ? ", deleting what it matches" : ""}`,
          writes: del,
          kinds: del ? [["delete", "deletes what it matches"]] : [],
        };
      }
      case "curl":
      case "wget":
      case "http":
      case "httpie": {
        const url = args.find((a) => /^(?:https?|ftp):\/\//i.test(a)) || first;
        const host = hostOf(url);
        const methodFlag = args.find((a) => a === "-X" || a === "--request");
        const methodAt = methodFlag ? args[args.indexOf(methodFlag) + 1] || "" : "";
        const body = args.some((a) => a === "-d" || a === "--data" || a.startsWith("--data") || a === "-F" || a === "--form");
        const writes = HTTP_WRITE_METHODS.test(methodAt) || body;
        const what = writes ? "sends a change to" : "a request to";
        return {
          text: `${program}: ${what} ${host || "a URL"}`,
          writes,
          kinds: writes ? [["server", `sends a change to ${host || "the server"}`]] : [],
          host,
          port: portOf(url),
        };
      }
      case "ssh":
      case "scp":
      case "sftp":
      case "rsync": {
        const host = hostOf(first) || first;
        return {
          text: `${program}: ${program === "ssh" ? "a shell on" : "copies to"} ${host || "a host"}`,
          writes: program !== "ssh",
          kinds: program === "ssh" ? [] : [["outside", `writes on ${host || "another machine"}`]],
          host,
          port: portOf(first),
        };
      }
      case "kubectl": {
        const verb = first;
        const name = paths[1] || "";
        return {
          text: `kubectl: ${verb || "reads"}${name ? ` ${name}` : ""} on this cluster`,
          writes: !/^(get|describe|logs|top|explain|version|api-resources|config)$/i.test(verb),
          kinds: [],
        };
      }
      case "docker":
      case "podman": {
        const verb = first;
        return {
          text: `${program}: ${verb || "no subcommand"}${paths[1] ? ` ${paths[1]}` : ""}`,
          writes: !/^(ps|images|logs|inspect|version|top|stats)$/i.test(verb),
          kinds: [],
        };
      }
      case "npm":
      case "pnpm":
      case "yarn":
      case "npx": {
        const verb = first;
        const script = paths[1] || "";
        return {
          text: `${program}${verb ? ` ${verb}` : ""}: ${script || "this tree's scripts"}`,
          writes: true,
          kinds: [],
        };
      }
      case "node":
      case "python":
      case "python3":
      case "ruby":
      case "perl":
      case "bash":
      case "sh":
      case "zsh":
      case "powershell":
      case "pwsh": {
        const script = paths[0] || "";
        return {
          text: `${program}: ${script ? `runs ${clip(script, 50)}` : "runs a script inline"}`,
          writes: true,
          kinds: [],
        };
      }
      case "psql":
      case "sqlplus":
      case "mysql":
      case "sqlcmd":
        return { text: `${program}: a query on ${first || "a database"}`, writes: true, kinds: [] };
      case "systemctl":
      case "service":
        return { text: `${program}: ${first || "a unit"}`, writes: true, kinds: [] };
      case "kill":
      case "taskkill":
      case "pkill":
        return { text: `${program}: stops a process`, writes: true, kinds: [] };
      case "cd":
        return { text: `cd: into ${first || "this directory"}`, writes: false, kinds: [] };
      default:
        break;
    }
    const reads = READS.has(program) || HTTP_READS.has(program);
    // A step whose first word is a file (./tools/verify.mjs, ../scripts/x.sh) is a script being run, not a program
    // with a subject: naming the file is the plain reading of it.
    if (/\.(mjs|cjs|js|ts|sh|bash|py|rb|pl|ps1)$/i.test(display)) {
      return { text: `${display}: runs this script`, writes: true, kinds: [] };
    }
    const subject = first ? clip(first, 48) : args.length ? clip(args[0], 48) : "no argument";
    return { text: `${display}: ${subject}`, writes: !reads, kinds: [] };
  }

  // ---------- the effects ----------
  const KIND_TEXT = {
    delete: "deletes files",
    rewrite: "rewrites history",
    push: "pushes to a remote",
    outside: "writes outside the repo",
    root: "runs as root (sudo)",
    server: "sends a change to a server",
  };
  const KIND_ORDER = ["delete", "rewrite", "push", "prod", "port", "outside", "root", "server"];
  const DANGER = new Set(["delete", "rewrite", "push", "prod", "outside", "root"]);

  // WHAT EARNS A ROW OF ITS OWN. The brief's seven: a delete, a history rewrite, a push, a write outside the repo, a
  // PROD or live-port action, a network fetch, a package install - and root, because a step that runs as sudo can
  // change anything the reader owns and folding it into `harmless` would be a lie. Everything else folds.
  const CONSEQUENTIAL = new Set(["delete", "rewrite", "push", "prod", "port", "outside", "root", "server"]);
  const NETWORK = new Set(["curl", "wget", "http", "httpie", "ssh", "scp", "sftp", "rsync", "nc", "telnet", "gh"]);
  const NETWORK_GIT = new Set(["fetch", "pull", "clone", "ls-remote", "push", "submodule"]);
  const PACKAGE_MANAGERS = new Set([
    "npm", "pnpm", "yarn", "bun", "pip", "pip3", "pipx", "apt", "apt-get", "brew", "choco", "winget", "gem", "cargo",
    "go", "dotnet", "nuget", "composer", "poetry", "conda", "mvn", "gradle",
  ]);
  const INSTALL_VERB = /^(install|i|ci|add|sync|update|upgrade|restore|get|fetch)$/i;

  function portOf(token) {
    const t = String(token || "");
    const url = /^[a-z]+:\/\/[^\s/:]+:(\d{2,5})\b/i.exec(t);
    if (url) return url[1];
    const hostPort = /(?:^|[/@])(?:[a-z0-9_.-]+|\[[0-9a-f:]+\]):(\d{2,5})\b/i.exec(t);
    return hostPort ? hostPort[1] : "";
  }

  // The port a step names: an explicit `--port 8642`, or a host:port in any of its words. `-p` is left alone here
  // because half the programs in a shell take it for something else; the whole-line search still reads it.
  function stepPortOf(text) {
    const flag = /--port[= ](\d{2,5})\b/.exec(String(text || ""));
    if (flag) return flag[1];
    for (const token of String(text || "").split(/\s+/)) {
      const p = portOf(token);
      if (p) return p;
    }
    return "";
  }

  function prodToken(text) {
    const m = /\b(prod(?:uction)?(?:[-_.]?[a-z0-9]+)*)\b/i.exec(String(text || ""));
    return m ? m[1] : "";
  }

  function normalizePath(p) {
    return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
  }

  function outsideRepo(path, rootDir) {
    const p = normalizePath(path);
    if (!p) return false;
    if (isDevNull(p)) return false;
    if (!p.startsWith("/") && !/^[a-z]:\//i.test(p)) return false;
    const root = normalizePath(rootDir);
    if (!root) return true;
    return !(p.toLowerCase() === root.toLowerCase() || p.toLowerCase().startsWith(`${root.toLowerCase()}/`));
  }

  // ---------- the summary ----------
  function summarize(command, { root: rootDir = "" } = {}) {
    const text = String(command || "");
    if (!text.trim()) return null;

    let lead = "";
    let leadKind = "";
    let body = text;
    const title = /^\s*\[([^\]\n]{1,140})\]\s*/.exec(text);
    if (title) {
      lead = clip(title[1], LEAD_MAX);
      leadKind = "title";
      body = text.slice(title[0].length);
    } else {
      const firstLine = text.split(/\r?\n/)[0].trim();
      const comment = /^(#(?!!)|\/\/)\s*(.*)$/.exec(firstLine);
      if (comment && comment[2].trim()) {
        lead = clip(comment[2], LEAD_MAX);
        leadKind = "comment";
        body = text.split(/\r?\n/).slice(1).join("\n");
      }
    }

    // A shebang names the interpreter the file is written with; it is not a step this card is asking about.
    body = body.replace(/^\s*#![^\n]*(?:\n|$)/, "");
    const steps = [];
    const kinds = new Map();
    const seen = (kind, detail) => {
      if (!kinds.has(kind)) kinds.set(kind, detail || KIND_TEXT[kind] || kind);
    };
    let writes = false;
    let prod = "";
    let port = "";

    // A line that ends in an assignment or a redirect, with no program after it: there is no step to fold it into,
    // so its write is read here rather than being lost. `> /etc/hosts` on its own is a write outside the repo even
    // though it names no program.
    const { steps: assembled, trailing } = assembleSteps(body);
    for (const target of (trailing && trailing.redirects) || []) {
      writes = true;
      if (outsideRepo(target, rootDir)) seen("outside", `writes outside the repo (${clip(target, 40)})`);
    }
    if (trailing && trailing.sudo) seen("root");

    for (const parsed of assembled) {
      const git = parsed.program === "git";
      const { sub, rest } = git ? gitParts(parsed.args) : { sub: "", rest: [] };
      const described = git ? gitStep(sub, rest) : nonGitStep(parsed.program, parsed.args, parsed.display);
      const reasons = [];
      const reason = (kind) => {
        if (!reasons.includes(kind)) reasons.push(kind);
      };

      if (described.writes || parsed.redirects.length) writes = true;
      for (const [kind, detail] of described.kinds || []) {
        seen(kind, detail);
        if (CONSEQUENTIAL.has(kind)) reason(kind);
      }
      for (const target of parsed.redirects) {
        writes = true;
        if (outsideRepo(target, rootDir)) {
          seen("outside", `writes outside the repo (${clip(target, 40)})`);
          reason("outside");
        }
      }
      if (parsed.sudo) {
        seen("root");
        reason("root");
      }
      // A write target the program itself names (cp, mv) is judged the same way as a redirect: a destination
      // outside the tree is the fact a reader needs, whoever wrote the file. A FLAG'S VALUE is not a path - a
      // commit message quoting a drive letter is the one false positive that would make this block cry wolf.
      if (described.writes) {
        const VALUE_FLAG = /^(-m|--message|--body|--title|--description|-c|--comment|-H|--header|-d|--data|--arg|--author|--grep|-S|--filter)$/;
        for (let i = 0; i < parsed.args.length; i += 1) {
          const arg = parsed.args[i];
          if (VALUE_FLAG.test(arg)) {
            i += 1;
            continue;
          }
          if (arg.startsWith("-") || !outsideRepo(arg, rootDir)) continue;
          seen("outside", `writes outside the repo (${clip(arg, 40)})`);
          reason("outside");
          break;
        }
      }
      // A port the step itself named (a URL or host:port) outranks one found anywhere else in the line.
      const stepHost = described.host || "";
      const stepPort = described.port || portOf(stepHost) || stepPortOf(parsed.raw) || "";
      if (stepPort && !port) port = stepPort;
      if (stepHost && !prod) prod = prodToken(stepHost);
      if (stepPort) reason("port");
      if (prodToken(stepHost || parsed.raw)) reason("prod");
      // The two ways a step reaches past this machine's own files: a network fetch, and a package install.
      if (NETWORK.has(parsed.program) || (git && NETWORK_GIT.has(sub))) reason("network");
      const verb = (git ? rest : parsed.args).find((a) => !a.startsWith("-")) || "";
      if (PACKAGE_MANAGERS.has(parsed.program) && INSTALL_VERB.test(verb)) reason("install");
      else if (/^python3?$/i.test(parsed.program) && /\b(pip|pip3)\b/.test(parsed.raw) && /\binstall\b/.test(parsed.raw)) reason("install");

      steps.push({
        program: git && sub ? `git ${sub}` : parsed.display,
        text: described.text,
        reasons,
        consequential: reasons.length > 0,
      });
    }

    // The whole line is searched for PROD and for a port: `-H "Host: prod..."`, a `--port 8642`, a cluster name
    // in an argument - the flag is about the command's target, not about which program spelled it.
    if (!prod) prod = prodToken(body);
    if (!port) {
      const portFlag = /(?:--port[= ]|-p\s+)(\d{2,5})\b/i.exec(body);
      if (portFlag) port = portFlag[1];
      else {
        for (const token of body.split(/\s+/)) {
          const p = portOf(token);
          if (p) {
            port = p;
            break;
          }
        }
      }
    }
    if (prod) seen("prod", `touches PROD (${clip(prod, 32)})`);
    if (port) seen("port", `talks to a live port ${port}`);

    const flags = [...kinds.entries()]
      .sort((a, b) => KIND_ORDER.indexOf(a[0]) - KIND_ORDER.indexOf(b[0]))
      .map(([kind, text]) => ({ kind, text }));

    // Four rows at most carry the weight; the rest of the line is one folded row. A command that only reads draws
    // no row at all - `harmless` holds every step, and the reader gets one line naming the programs.
    const consequential = steps.filter((step) => step.consequential);
    const harmless = steps.filter((step) => !step.consequential);

    return {
      lead,
      leadKind,
      steps,
      shown: consequential.slice(0, MAX_CONSEQUENTIAL),
      folded: consequential.slice(MAX_CONSEQUENTIAL),
      consequential,
      harmless,
      flags,
      readOnly: !writes,
      danger: flags.some((f) => DANGER.has(f.kind)),
      root: normalizePath(rootDir),
    };
  }

  function html(command, { root: rootDir = "", esc = escapeHtml } = {}) {
    const s = summarize(command, { root: rootDir });
    // An empty command draws nothing. A command with no program step but a write of its own (`> /etc/hosts`) still
    // draws - its warning is the whole reason the block exists.
    if (!s || (!s.steps.length && !s.flags.length)) return "";
    const e = (v) => esc(v);
    const chip = s.readOnly ? "reads only" : "changes things";
    const chipClass = s.danger ? "is-danger" : s.readOnly ? "is-read" : "is-write";
    const row = (step) => `<li>${e(step.text)}</li>`;
    // ONE LINE FOR EVERYTHING THAT DOES NOT MATTER, naming each program once: five `echo`s are one `echo` here and
    // five rows when the line opens. `<details>` is the expansion, so the card needs no script of its own.
    const fold = (steps, kind, label) => {
      if (!steps.length) return "";
      const names = steps.map((step) => step.program).filter((name, i, all) => name && all.indexOf(name) === i);
      const count = steps.length;
      const line = `${count} ${label}${count === 1 ? "" : "s"}: ${names.join(", ")}`;
      return (
        `<li class="is-fold"><details class="ta-fold" data-ta-fold="${kind}" data-ta-count="${count}">` +
        `<summary class="ta-fold-line mono">${e(line)}</summary>` +
        `<ul class="ta-fold-steps">${steps.map(row).join("")}</ul></details></li>`
      );
    };
    const steps =
      s.shown.map(row).join("") +
      fold(s.harmless, "harmless", "harmless step") +
      fold(s.folded, "consequential", "more consequential step");
    const flags = s.flags.map((f) => `<div class="ta-summary-flag mono" data-ta-flag="${e(f.kind)}">&#9888; ${e(f.text)}</div>`).join("");
    const read = s.readOnly ? `<div class="ta-summary-read mono">reads only - nothing here is written, deleted or pushed</div>` : "";
    const lead = s.lead ? `<div class="ta-summary-lead">${e(s.lead)}</div>` : "";
    return `<div class="ta-summary" data-ta-summary="${e(s.leadKind || "derived")}" role="group" aria-label="what this will do">
    <div class="ta-summary-head mono"><span class="ta-summary-label">what this will do</span><span class="ta-summary-chip ${chipClass}">${chip}</span></div>
    ${lead}
    <ul class="ta-summary-steps">${steps}</ul>
    ${flags}
    ${read}
  </div>`;
  }

  root.wtCommandSummary = { summarize, html, splitSteps, MAX_CONSEQUENTIAL };
})(typeof window !== "undefined" ? window : globalThis);
