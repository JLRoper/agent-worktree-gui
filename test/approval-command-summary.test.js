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

const ROOT = "C:/ProjectDevelopment/agent-worktree-gui";

// ---------- 1. the split ----------
test("the split follows the shell: && || ; | and a newline, but not inside quotes or a substitution", () => {
  assert.deepEqual(M.splitSteps("git add -A && git commit -m x"), ["git add -A", "git commit -m x"]);
  assert.deepEqual(M.splitSteps("a ; b | c || d"), ["a", "b", "c", "d"]);
  assert.deepEqual(M.splitSteps("git status\ngit diff"), ["git status", "git diff"]);
  // A pipe inside quotes is text; a pipe inside a substitution belongs to the inner command.
  assert.deepEqual(M.splitSteps('echo "a | b"'), ['echo "a | b"']);
  assert.deepEqual(M.splitSteps("git rm $(git ls-files -m | head -1)"), ["git rm $(git ls-files -m | head -1)"]);
  // A redirection is not a background job, and `2>&1` is not a separator either.
  assert.deepEqual(M.splitSteps("node x.mjs > out.log 2>&1"), ["node x.mjs > out.log 2>&1"]);
  // An empty step is not a step.
  assert.deepEqual(M.splitSteps("a && && b"), ["a", "b"]);
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
  // A commit message that quotes a drive letter is not a file being written.
  assert.equal(M.summarize('git commit -m "C:/Users/roper/notes"', { root: ROOT }).flags.some((f) => f.kind === "outside"), false);
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

test("an unknown command is described honestly, and a long one is cut with a count", () => {
  const unknown = M.summarize("frobnicate --now dist/widget.bin");
  assert.equal(unknown.steps[0].text, "frobnicate: dist/widget.bin");
  assert.equal(unknown.readOnly, false);
  const many = M.summarize(Array.from({ length: 12 }, (_, i) => `echo ${i}`).join(" && "));
  assert.equal(many.steps.length, M.MAX_STEPS);
  assert.equal(many.more, 2);
  assert.match(M.html(Array.from({ length: 12 }, (_, i) => `echo ${i}`).join(" && ")), /and 2 more steps/);
  // An empty command draws no block at all rather than an empty frame.
  assert.equal(M.html(""), "");
  assert.equal(M.html("   \n  "), "");
});

test("one summary per card, derived at paint time from the same string the card shows", () => {
  // The block is built from `command`, the same variable the <pre> is built from: a second source would let the
  // summary and the command drift.
  assert.match(app, /globalThis\.wtCommandSummary\.html\(command, \{ root, esc \}\)/);
});
