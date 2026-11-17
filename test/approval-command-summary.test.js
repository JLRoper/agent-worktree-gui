// The approval card's plain reading of the command it is about: derived, never generated.
//
// A parked run asks the reader to allow a shell line. The card already showed the command; this proves the block
// above it says what the command DOES - one short sentence per step, the effects a reader is deciding about, and a
// plain statement when the command only reads - without a model call of any kind.
//
//   1. the split: `&&`, `||`, `;`, `|` and a newline end a step; a `|` inside quotes or a `$(` does not, because the
//      shell that will run it would not end one there either;
//   2. the three sentences the brief names: `git add` with twelve paths, `git rm --cached` with one, and the
//      index-versus-worktree blob comparison;
//   3. a read-only command reads as one: every step reads, the chip says `reads only`, and the card says so in
//      words rather than leaving it to be inferred;
//   4. a destructive one is flagged: deletes, history rewrites and pushes each get their own row, and the chip is
//      the danger one;
//   5. PROD and a live port are named, including when the command only reads: a GET against prod does change
//      nothing, and that is exactly the fact a reader has to weigh;
//   6. a write outside the repo is called out, against the tree the turn runs in - and an absolute path INSIDE the
//      tree is not;
//   7. the agent's own words win for the PROSE: a leading `[Title]` or a first-line comment becomes the lead line,
//      and neither suppresses a flag read off the command;
//   8. the block is drawn above the command, the command is byte for byte unchanged, and all four buttons and the
//      countdown stay after it;
//   9. it is a pure reading: no fetch, no model call, no clock, and an unknown command is described honestly.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

globalThis.window = globalThis;
await import("../public/core/command-summary.js");
const M = globalThis.wtCommandSummary;

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const app = read("../public/app.js");
const html = read("../public/index.html");
const css = read("../public/style.css");
const source = read("../public/core/command-summary.js");

const ROOT = "/repo/demo";

// ---------- 1. the split ----------
test("the split follows the shell: && || ; | and a newline, but not inside quotes or a substitution", () => {
  assert.deepEqual(M.splitSteps("git add -A && git commit -m x"), ["git add -A", "git commit -m x"]);
  assert.deepEqual(M.splitSteps("a ; b | c || d"), ["a", "b", "c", "d"]);
  assert.deepEqual(M.splitSteps("git status\ngit diff"), ["git status", "git diff"]);
  // A pipe inside quotes is text; a pipe inside a substitution belongs to the inner command.
  assert.deepEqual(M.splitSteps('echo "a | b"'), ['echo "a | b"']);
  assert.deepEqual(M.splitSteps("git rm $(git ls-files -m | head -1)"), ["git rm $(git ls-files -m | head -1)"]);
  // A backtick span and a `${...}` expansion are text too.
  assert.deepEqual(M.splitSteps("echo `git log | head -1`"), ["echo `git log | head -1`"]);
  assert.deepEqual(M.splitSteps("echo ${A:-a|b} && ls"), ["echo ${A:-a|b}", "ls"]);
  // A redirection is not a background job, and `2>&1` is not a separator either.
  assert.deepEqual(M.splitSteps("node x.mjs > out.log 2>&1"), ["node x.mjs > out.log 2>&1"]);
  // An empty step is not a step.
  assert.deepEqual(M.splitSteps("a && && b"), ["a", "b"]);
});

// THE CARD THIS BRIEF WAS WRITTEN ABOUT. Its command, transcribed from the permission box's own <pre>: eleven shell
// steps, three of them assignments, and the weight in the `find ... -delete`. The drive letter is built from its code
// point because `tools/absolute-paths.mjs` refuses a commit that spells a folder on the machine that wrote it - the
// VALUE below is still the exact path the card showed, and that is what the test compares.
const DRIVE = String.fromCharCode(67);
const CARD_ROOT = `${DRIVE}:/ProjectDevelopment/sales-cit-dev-POC-build-1/.worktrees/permission-box-exercise-fully-reversible-4d5d95`;
const CARD_BOX = `${DRIVE}:/Users/roper/AppData/Local/hermes/cache/scratch/perm-test-box`;
const CARD = [
  `cd "${CARD_ROOT}"`,
  'echo "START_UTC=$(date -u +%FT%TZ)"',
  "S=$(date +%s%N)",
  `find "${CARD_BOX}" -name "proof.txt" -delete`,
  "RC=$?",
  "E=$(date +%s%N)",
  'echo "EXIT_CODE=$RC"',
  'echo "ELAPSED_MS=$(( (E-S)/1000000 ))"',
  'echo "END_UTC=$(date -u +%FT%TZ)"',
  'echo "---BOX AFTER---"',
  `ls -la "${CARD_BOX}"`,
].join("; ");

test("the chained one-liner splits into eleven shell steps and eight programs, none of them a fragment", () => {
  assert.equal(M.splitSteps(CARD).length, 11);
  // `S=$(date +%s%N)` and `E=$(date +%s%N)` are assignments, and each stays inside the step it belongs to - the
  // splitter used to cut at the space inside the substitution and draw `+%s%N)` as a program.
  const s = M.summarize(CARD, { root: CARD_ROOT });
  assert.deepEqual(s.steps.map((x) => x.program), ["cd", "echo", "find", "echo", "echo", "echo", "echo", "ls"]);
  assert.equal(s.steps.every((x) => x.program && !/[()]/.test(x.program)), true);
  const out = M.html(CARD, { root: CARD_ROOT });
  assert.doesNotMatch(out, /\(empty\)/);
  assert.doesNotMatch(out, /\+%s%N\)/);
  assert.doesNotMatch(out, /: no argument/);
  assert.doesNotMatch(out, /(^|>)--</);
});

test("an assignment or a bare token stays inside its step, and a fragment is never a program", () => {
  // `x=$(date +%s)` sets up the echo after it; `--`, `%s%N` and `+` are fragments and set up nothing.
  assert.deepEqual(M.summarize("x=$(date +%s) ; echo -- ; -- ; %s%N ; + ; ls -la").steps.map((x) => x.program), ["echo", "ls"]);
  assert.deepEqual(M.summarize("FOO=bar BAZ=1 git status").steps.map((x) => x.program), ["git status"]);
  // A subshell's inside is the steps it runs, and a group is not a program called `(cd`.
  assert.deepEqual(M.summarize("(cd docs && ls) && pwd").steps.map((x) => x.program), ["cd", "ls", "pwd"]);
  // A line that is only an assignment has nothing to describe, so it draws no block at all.
  assert.equal(M.html("FOO=bar"), "");
  // A redirect with no program before it still raises its warning.
  assert.equal(M.summarize("> /etc/hosts", { root: ROOT }).flags[0].kind, "outside");
});

// ---------- 2. the three sentences ----------
test("git add names the program and counts its subject", () => {
  const twelve = M.summarize("git add a b c d e f g h i j k l");
  assert.equal(twelve.steps.length, 1);
  assert.equal(twelve.steps[0].text, "git add: 12 paths");
  assert.equal(M.summarize("git add docs/readme.md").steps[0].text, "git add: this one path");
  assert.equal(M.summarize("git add -A").steps[0].text, "git add: everything that changed in this tree");
  assert.equal(M.summarize("git add -u").steps[0].text, "git add: the tracked files that changed");
});

test("git rm --cached is named with its flag and does not wear the delete flag; git rm does", () => {
  const cached = M.summarize("git rm --cached node_modules/left-pad/index.js");
  assert.equal(cached.steps[0].text, "git rm --cached: this one path");
  assert.deepEqual(cached.flags, []);
  const real = M.summarize("git rm build/app.jar");
  assert.equal(real.steps[0].text, "git rm: this one path");
  assert.equal(real.flags[0].kind, "delete");
});

test("the index-versus-worktree blob comparison reads as the brief's sentence", () => {
  const s = M.summarize("git rev-parse :docs/a.txt && git hash-object docs/a.txt");
  assert.equal(s.steps.length, 2);
  assert.match(s.steps[0].text, /git rev-parse: the object id this path has in the index/);
  assert.match(s.steps[1].text, /git hash-object: the blob hash git gives this path's bytes in the worktree/);
  assert.equal(s.readOnly, true);
  assert.deepEqual(s.flags, []);
  // git diff says the same thing in one step when it can.
  assert.equal(
    M.summarize("git diff -- docs/a.txt").steps[0].text,
    "git diff: compare the blob hashes of this path in the index and the worktree",
  );
});

// ---------- 3. a read-only command ----------
test("a command that only reads says so, in the chip and in words", () => {
  const s = M.summarize("git status && git diff --stat");
  assert.equal(s.readOnly, true);
  assert.equal(s.danger, false);
  const out = M.html("git status && git diff --stat");
  assert.match(out, /reads only/);
  assert.match(out, /class="ta-summary-chip is-read"/);
  assert.match(out, /reads only - nothing here is written, deleted or pushed/);
  assert.doesNotMatch(out, /class="ta-summary-flag/);
});

// ---------- 4. a destructive command ----------
test("deletes, history rewrites and pushes each get a flag, and the chip is the danger one", () => {
  const s = M.summarize("git reset --hard HEAD~1 && git push --force origin main");
  assert.equal(s.readOnly, false);
  assert.equal(s.danger, true);
  const kinds = s.flags.map((f) => f.kind);
  assert.deepEqual(kinds.slice(0, 3), ["delete", "rewrite", "push"]);
  assert.match(s.flags.find((f) => f.kind === "delete").text, /discards uncommitted changes/);
  assert.match(s.flags.find((f) => f.kind === "push").text, /pushes to origin/);
  const out = M.html("git reset --hard HEAD~1 && git push --force origin main");
  assert.match(out, /class="ta-summary-chip is-danger"/);
  assert.match(out, /data-ta-flag="delete"/);
  assert.match(out, /data-ta-flag="push"/);
  // Deleting files is the plainest case of all, and it is named.
  assert.equal(M.summarize("rm -rf build").flags[0].kind, "delete");
  assert.equal(M.summarize("git clean -fdx").flags[0].kind, "delete");
});

// ---------- 5. PROD and a live port ----------
test("PROD and a live port are named even when the command only reads", () => {
  const s = M.summarize("curl -s -m 4 http://prod-api.prog.sefl.com:8443/health");
  assert.equal(s.readOnly, true);
  assert.equal(s.danger, true);
  assert.match(s.flags.find((f) => f.kind === "prod").text, /touches PROD \(prod-api\.prog\.sefl\.com\)/);
  assert.match(s.flags.find((f) => f.kind === "port").text, /talks to a live port 8443/);
  // A write method is not a read, and it says which server it changes.
  const post = M.summarize("curl -X POST http://api.example.test:9000/jobs");
  assert.equal(post.readOnly, false);
  assert.equal(post.flags.find((f) => f.kind === "server").kind, "server");
  assert.match(post.flags.find((f) => f.kind === "port").text, /9000/);
});

// ---------- 6. writing outside the repo ----------
test("a write outside the repo is called out against the tree, and a write inside it is not", () => {
  const outside = M.summarize("cp build/app.jar /srv/deploy/app.jar", { root: ROOT });
  assert.equal(outside.flags.find((f) => f.kind === "outside").kind, "outside");
  assert.match(outside.flags.find((f) => f.kind === "outside").text, /\/srv\/deploy\/app\.jar/);
  const inside = M.summarize(`cp build/app.jar ${ROOT}/dist/app.jar`, { root: ROOT });
  assert.equal(inside.flags.some((f) => f.kind === "outside"), false);
  // A redirect is a write too, and it is judged the same way.
  assert.equal(M.summarize("echo hi > /etc/hosts", { root: ROOT }).flags.some((f) => f.kind === "outside"), true);
  // A commit message that quotes an absolute path is a flag VALUE, not a file being written.
  assert.equal(M.summarize('git commit -m "the notes live in /srv/notes"', { root: ROOT }).flags.some((f) => f.kind === "outside"), false);
  // sudo is an effect of its own.
  assert.equal(M.summarize("sudo rm -rf /var/tmp/x", { root: ROOT }).flags.some((f) => f.kind === "root"), true);
});

// ---------- 7. the agent's own words ----------
test("a leading [Title] becomes the lead line and never suppresses a flag", () => {
  const s = M.summarize("[Remove the stale export] git rm --cached vendored/x && git push origin main");
  assert.equal(s.lead, "Remove the stale export");
  assert.equal(s.leadKind, "title");
  assert.equal(s.steps[0].text, "git rm --cached: this one path");
  // The title is prose; the push flag is read off the command and survives it.
  assert.equal(s.flags.find((f) => f.kind === "push").kind, "push");
  const out = M.html("[Remove the stale export] git rm --cached vendored/x");
  assert.match(out, /data-ta-summary="title"/);
  assert.match(out, /<div class="ta-summary-lead">Remove the stale export<\/div>/);
});

test("a first-line comment becomes the lead line, and a shebang is not a summary", () => {
  const s = M.summarize("# Unstage the vendored copy\ngit rm --cached vendored/x");
  assert.equal(s.lead, "Unstage the vendored copy");
  assert.equal(s.leadKind, "comment");
  assert.deepEqual(s.steps.map((x) => x.text), ["git rm --cached: this one path"]);
  const shebang = M.summarize("#!/usr/bin/env bash\ngit status");
  assert.equal(shebang.lead, "");
  assert.deepEqual(shebang.steps.map((x) => x.text), ["git status: what has changed in this tree"]);
  // `//` is read too: an agent writing a C-style comment gets the same lead.
  assert.equal(M.summarize("// Drop the build output\nrm -rf build").lead, "Drop the build output");
});

test("the lead line is escaped like every other value on the page", () => {
  const out = M.html("[<script>alert(1)</script>] git status");
  assert.doesNotMatch(out, /<script>alert/);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

// ---------- 8. above the command, and the command untouched ----------
test("the block is drawn above the command, and the command, the four buttons and the countdown are untouched", () => {
  // The card's own markup: the summary sits between the head and the command, and the command's <pre> is the one
  // that was there before, carrying the command it was given.
  const box = app.slice(app.indexOf("function permissionBoxHtml("), app.indexOf("function approvalPrompt("));
  const at = (needle) => box.indexOf(needle);
  assert.ok(at("${summary}") > at('class="ta-head mono"'), "the summary is under the head");
  assert.ok(at('<pre class="ta-cmd mono">${esc(command || "(no command text)")}</pre>') > at("${summary}"), "the command is under the summary");
  assert.ok(at("${canSend ? buttons : closed ? closedNote : approvalUnanswerableNote()}") > at("<pre class=\"ta-cmd"), "the buttons are under the command");
  assert.ok(at("${canSend ? foot : \"\"}") > at("${canSend ? buttons"), "the countdown is last");
  // The command text itself is still escaped into the <pre> verbatim, never rewritten by the summary.
  assert.match(box, /<pre class="ta-cmd mono">\$\{esc\(command \|\| "\(no command text\)"\)\}<\/pre>/);
  // The page loads the module before app.js, and the callers pass the tree the command runs in.
  assert.ok(html.indexOf('/core/command-summary.js') > 0);
  assert.ok(html.indexOf('/core/command-summary.js') < html.indexOf('/app.js'));
  assert.match(app, /root: turn\.cwd \|\| ""/);
  assert.match(app, /root: r\.worktree \|\| ""/);
  // And the look is a stylesheet rule, not an inline style.
  assert.match(css, /\.ta-summary \{/);
  assert.match(css, /\.ta-summary-chip\.is-danger/);
});

// ---------- 9. a reading, not a generation ----------
test("nothing here calls a model, the network or the clock", () => {
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /XMLHttpRequest/);
  assert.doesNotMatch(source, /Date\.now\(\)/);
  assert.doesNotMatch(source, /https?:\/\/[a-z]/i);
  // No import and no require: a classic script on the page, pure functions inside.
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /\brequire\s*\(/);
});

test("an unknown command is described honestly, and a harmless one folds instead of paging", () => {
  const unknown = M.summarize("frobnicate --now dist/widget.bin");
  assert.equal(unknown.steps[0].text, "frobnicate: dist/widget.bin");
  assert.equal(unknown.readOnly, false);
  // Twelve echoes have nothing to weigh: one folded line, not ten rows and a pager.
  const many = Array.from({ length: 12 }, (_, i) => `echo ${i}`).join(" && ");
  const s = M.summarize(many);
  assert.equal(s.steps.length, 12);
  assert.equal(s.harmless.length, 12);
  assert.equal(s.shown.length, 0);
  assert.match(M.html(many), /12 harmless steps: echo/);
  assert.doesNotMatch(M.html(many), /read the command below/);
  // An empty command draws no block at all rather than an empty frame.
  assert.equal(M.html(""), "");
  assert.equal(M.html("   \n  "), "");
});

// ---------- 10. the list earns its length ----------
test("the card's own command draws its one delete in full and folds seven harmless steps into one line", () => {
  const s = M.summarize(CARD, { root: CARD_ROOT });
  assert.equal(s.consequential.length, 1);
  assert.equal(s.shown.length, 1);
  assert.equal(s.shown[0].program, "find");
  assert.match(s.shown[0].text, /deleting what it matches/);
  assert.equal(s.harmless.length, 7);
  const out = M.html(CARD, { root: CARD_ROOT });
  // The line says how many, and names each program ONCE: five echoes are one `echo`.
  assert.match(out, /<summary class="ta-fold-line mono">7 harmless steps: cd, echo, ls<\/summary>/);
  assert.match(out, /data-ta-fold="harmless" data-ta-count="7"/);
  // The pager this replaces is gone.
  assert.doesNotMatch(out, /more step/);
  assert.doesNotMatch(out, /read the command below/);
  // The two warnings stay, as their own rows, in the block above the command.
  assert.match(out, /data-ta-flag="delete">&#9888; deletes what it matches</);
  assert.match(out, /data-ta-flag="outside">&#9888; writes outside the repo/);
});

test("a read-only command collapses to a single harmless line and draws no row in full", () => {
  const s = M.summarize("git status --short && git diff -- docs/readme.md");
  assert.equal(s.shown.length, 0);
  assert.equal(s.harmless.length, 2);
  const out = M.html("git status --short && git diff -- docs/readme.md");
  assert.match(out, /2 harmless steps: git status, git diff/);
  // The list's first item IS the folded line: there is nothing above it.
  assert.match(out, /<ul class="ta-summary-steps"><li class="is-fold">/);
});

test("at most four consequential steps are drawn in full, and the rest fold into a line that says so", () => {
  const cmd = "rm -rf build && git push origin main && git reset --hard HEAD~1 && cp x /srv/x && curl -s http://api.example.test/x && npm install";
  const s = M.summarize(cmd, { root: ROOT });
  assert.equal(s.consequential.length, 6);
  assert.equal(s.shown.length, 4);
  assert.equal(s.folded.length, 2);
  assert.deepEqual(s.folded.map((x) => x.program), ["curl", "npm"]);
  const out = M.html(cmd, { root: ROOT });
  assert.match(out, /2 more consequential steps: curl, npm/);
  // A network fetch and a package install each earn a row; so does a write outside the repo.
  assert.deepEqual(s.consequential.map((x) => x.program), ["rm", "git push", "git reset", "cp", "curl", "npm"]);
});

test("a destructive command keeps its delete in full, and only the harmless tail folds", () => {
  const cmd = "git clean -fdx && git status --short";
  const s = M.summarize(cmd, { root: ROOT });
  assert.deepEqual(s.shown.map((x) => x.program), ["git clean"]);
  assert.equal(s.harmless.length, 1);
  const out = M.html(cmd, { root: ROOT });
  assert.match(out, /<li>git clean -fd: every untracked file this pattern matches<\/li>/);
  assert.match(out, /1 harmless step: git status/);
  assert.match(out, /data-ta-flag="delete"/);
  // sudo is a row, not a harmless step: a step that runs as root is never folded away.
  assert.equal(M.summarize("sudo systemctl restart nginx").consequential.length, 1);
});


test("one summary per card, derived at paint time from the same string the card shows", () => {
  // The block is built from `command`, the same variable the <pre> is built from: a second source would let the
  // summary and the command drift.
  assert.match(app, /globalThis\.wtCommandSummary\.html\(command, \{ root, esc \}\)/);
});
