// A landing may not name a folder on the machine that wrote it.
//
// The defect this file exists for: a doc, a probe's default argument or a changelog line can carry the author's own
// path, and nobody notices, because the line is true where it was written. It is not true anywhere else — the
// reader cannot open it, the scratch folder is pruned by the next run, and once it is a commit on main it is
// permanent history. Main already carries hundreds of them, from before the gate; tools/absolute-paths.allow
// records those and the gate refuses anything new.
//
// What the tests pin, in the order the tool learns it:
//   - the four shapes a path is written in (forward, backslash, JSON-escaped, file:// URL) and the code shapes
//     that only LOOK like one (https://, a timestamp regex, an identifier ending in `a:/`);
//   - the allowlist's four refusals — a line with no reason, a glob, a count that overflows, a path recorded twice;
//   - the verdict: a file nobody allowed fails, a file over its recorded count fails, a file under it does not;
//   - the command, on a fixture repository: each form is refused with its file and line, and recording it makes
//     the same tree pass;
//   - this repository's own tree passes, which is the thing that would break first if the allowlist were wrong;
//   - the shipped .githooks/pre-push refuses a push carrying one, and lets a clean push through.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ALLOW_FILE, FORMS, SELF, evaluate, findPaths, parseAllowlist, scanRev, scanText, scanWorktree } from "../tools/absolute-paths.mjs";
import { ROOT, configureRepo, git } from "../tools/panel-testkit.mjs";

// ---------- the matcher ----------

const forms = (line) => findPaths(line).map((h) => h.form);
const tokens = (line) => findPaths(line).map((h) => h.token);

test("all four shapes a drive-letter path is written in are found", () => {
  // One case per form. The JSON-escaped one is a string literal that stores two backslashes, which is what a .json
  // file holds after its own quoting — the form a `C:\\` search finds and a `C:\` search misses.
  const cases = [
    ["forward", String.raw`the note is at C:/Users/roper/AppData/Local/Temp/wag/x.html`, "C:/Users/roper/AppData/Local/Temp/wag/x.html"],
    ["backslash", String.raw`the note is at C:\Users\roper\AppData\Local\Temp\wag\x.html`, String.raw`C:\Users\roper\AppData\Local\Temp\wag\x.html`],
    ["json-escaped", String.raw`{"note": "C:\\Users\\roper\\AppData\\x.html"}`, String.raw`C:\\Users\\roper\\AppData\\x.html`],
    ["file-url", String.raw`[the note](file:///C:/Users/roper/x.html)`, "file:///C:/Users/roper/x.html"],
  ];
  for (const [form, line, token] of cases) {
    assert.deepEqual(forms(line), [form], `the ${form} form is found`);
    assert.deepEqual(tokens(line), [token], `the ${form} form is quoted as written`);
  }
  assert.deepEqual(cases.map((c) => c[0]), FORMS, "these are the four forms, and the tool names each of them");
});

test("a file:// URL with nothing after the drive is still a path", () => {
  // `file:///C:` is the form a doc uses to name a drive root, and the separator rule would otherwise pass it.
  assert.deepEqual(forms(String.raw`write to file:///C: and stop`), ["file-url"]);
});

test("code that only looks like a drive letter is not a path", () => {
  // Each of these ran a first version red. They matter more than the true positives: a gate that cries about a
  // URL, a timestamp or a worker id is a gate an agent turns off with --no-verify, and then it protects nothing.
  const notPaths = [
    "see https://example.com/a/b for the detail",          // the "s:" follows a "p"
    String.raw`ok(/^\d{4}-\d\d:\d\dZ$/.test(stamp))`,       // a drive letter does not follow a backslash
    String.raw`TO wtgui-worker-a:/m.test(turnProse(x))`,    // a drive letter does not end a hyphenated id
    String.raw`L=y==="$"?n:/[%p]/.test(T)?s:""`,            // a first segment does not start with a bracket
    String.raw`throw new Error("... in 25 s:\n" + out)`,    // `:\n` is a template literal's newline
    "ratio: 1/2 and a 3:4 split",                          // no separator after the colon
    "the drive is C: and nothing else",                    // a bare colon names no path
  ];
  for (const line of notPaths) assert.deepEqual(findPaths(line), [], `not a path: ${line}`);
});

test("a path at the start of a line is found, not swallowed by the look-behind", () => {
  // The look-behind has no character to test at column 0, and `"\\-_".includes("")` is true — the bug this pins.
  assert.deepEqual(tokens(String.raw`C:\Users\roper\x`), [String.raw`C:\Users\roper\x`]);
  assert.deepEqual(tokens("C:/Users/roper/x"), ["C:/Users/roper/x"]);
});

test("a path a reader would call real is found even when a segment starts with an escape letter", () => {
  // `C:\new` is a folder called "new", not a newline: the escape only counts when nothing follows it.
  assert.deepEqual(tokens(String.raw`open C:\new folder`), [String.raw`C:\new`]);
  assert.deepEqual(tokens(String.raw`open C:\net`), [String.raw`C:\net`]);
});

test("scanText numbers lines the way an editor does", () => {
  const hits = scanText("one\ntwo\nC:/a/b\nfour\nfile:///C:/c/d\n", "docs/x.md");
  assert.deepEqual(
    hits.map((h) => [h.file, h.line, h.form]),
    [["docs/x.md", 3, "forward"], ["docs/x.md", 5, "file-url"]],
  );
});

// ---------- the allowlist ----------

test("an allowlist line is a path, a count and a reason", () => {
  const { entries, problems } = parseAllowlist(
    [
      "# a comment",
      "",
      "docs/a.md | 3 | a landing record: the scratch tree it measured",
      "test/b.test.js | 1 | a fixture | with a pipe in the reason",
    ].join("\n"),
  );
  assert.deepEqual(problems, []);
  assert.equal(entries.get("docs/a.md").max, 3);
  assert.equal(entries.get("test/b.test.js").reason, "a fixture | with a pipe in the reason");
});

test("the ways an allowlist line can be wrong are refused, not ignored", () => {
  // A record that can be broken quietly is not a record: an entry with no reason says nothing about why the path is
  // allowed, and a glob or an absolute path allows more than the one file it names.
  const { problems } = parseAllowlist(
    [
      "docs/noreason.md | 2 |",
      "docs/glob-*.md | 2 | a landing record",
      "C:/Users/roper/x.md | 2 | an absolute path",
      "docs/nocount.md | many | a record",
      "docs/twice.md | 1 | first",
      "docs/twice.md | 1 | second",
    ].join("\n"),
  );
  assert.equal(problems.length, 5, JSON.stringify(problems, null, 2));
  assert.match(problems[0].why, /no reason/);
  assert.match(problems[1].why, /not a repo-relative path/);
  assert.match(problems[2].why, /not a repo-relative path/);
  assert.match(problems[3].why, /whole number/);
  assert.match(problems[4].why, /twice/);
});

// ---------- the verdict ----------

const hit = (file, line) => ({ file, line, form: "forward", at: 0, token: "C:/x" });

test("a file nobody allowed fails; a file that grew fails; a file under its count does not", () => {
  const allow = new Map([["docs/known.md", { max: 2, reason: "a record", line: 1 }]]);
  const frozen = evaluate([hit("docs/known.md", 1), hit("docs/known.md", 2)], allow);
  assert.deepEqual(frozen.fresh, [], "exactly the recorded count passes");
  assert.deepEqual(frozen.grown, []);

  const shrunk = evaluate([hit("docs/known.md", 1)], allow);
  assert.deepEqual(shrunk.grown, [], "removing a path is always allowed");

  const grew = evaluate([hit("docs/known.md", 1), hit("docs/known.md", 2), hit("docs/known.md", 9)], allow);
  assert.equal(grew.grown.length, 1, "a third path in a file recorded with two is a refusal");
  assert.equal(grew.grown[0].max, 2);

  const fresh = evaluate([hit("docs/new.md", 4)], allow);
  assert.equal(fresh.fresh.length, 1);
  assert.equal(fresh.fresh[0].file, "docs/new.md");
});

test("the tool, its allowlist and its own test are the only files the scan skips", () => {
  // Those three files ARE the pattern, so a scan of them finds its own examples. Exact names, not a glob: widening
  // the hole has to be an edit a reviewer sees.
  assert.deepEqual([...SELF].sort(), ["test/absolute-paths.test.js", "tools/absolute-paths.allow", "tools/absolute-paths.mjs"]);
  assert.equal(ALLOW_FILE, "tools/absolute-paths.allow");
});

// ---------- the command, on a fixture ----------

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wtgui-paths-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  git(root, "init", "-q", "-b", "main", repo);
  configureRepo(repo);
  return { root, repo };
}

// Writes files, commits them, and returns what the tool said about that commit. `--rev HEAD` is the same read the
// pre-push hook makes: the tree being pushed, not the working tree beside it.
async function runAtHead(repo, files, allow = null) {
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await writeFile(path.join(repo, name), body, "utf8");
  }
  if (allow !== null) {
    await mkdir(path.dirname(path.join(repo, ALLOW_FILE)), { recursive: true });
    await writeFile(path.join(repo, ALLOW_FILE), allow, "utf8");
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "docs: a note about what the run wrote");
  const args = [path.join(ROOT, "tools", "absolute-paths.mjs"), "--rev", "HEAD"];
  const r = spawnSync(process.execPath, args, { cwd: repo, encoding: "utf8", windowsHide: true });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

test("each form in a fixture is refused by name, and recording it makes the same tree pass", async (t) => {
  const { repo } = await fixture(t);
  const body = [
    "the shots are in C:/Users/roper/AppData/Local/Temp/wag/x",       // forward
    String.raw`and in C:\Users\roper\AppData\Local\Temp\wag\x`,       // backslash
    String.raw`and {"p": "C:\\Users\\roper\\AppData\\x"}`,            // json-escaped
    "and file:///C:/Users/roper/AppData/x",                          // file-url
    "",
  ].join("\n");

  const refused = await runAtHead(repo, { "docs/landing.md": body }, "# nothing recorded yet\n");
  assert.equal(refused.status, 1, `four paths on one line each is a refusal\n${refused.out}`);
  for (const line of [1, 2, 3, 4]) {
    assert.match(refused.out, new RegExp(`docs/landing\\.md:${line}\\b`), `the refusal names line ${line}\n${refused.out}`);
  }
  for (const form of ["forward", "backslash", "json-escaped", "file-url"]) {
    assert.match(refused.out, new RegExp(`\\[${form}\\]`), `the refusal says which form ${form} it found\n${refused.out}`);
  }

  // The allowlist is a decision, and the same tree passes once the decision is recorded — count and reason both.
  const allowed = await runAtHead(
    repo,
    { "docs/second.md": "nothing here\n" },
    "docs/landing.md | 4 | a landing record: the scratch tree it measured\n",
  );
  assert.equal(allowed.status, 0, `the recorded file passes\n${allowed.out}`);
  assert.match(allowed.out, /absolute-paths: clean/, allowed.out);

  // And one MORE path in the file that was recorded with four is the refusal the count exists for: a frozen record
  // cannot quietly grow a newer path.
  const grew = await runAtHead(
    repo,
    { "docs/landing.md": `${body}and one more C:/Users/roper/Desktop/y\n` },
    "docs/landing.md | 4 | a landing record: the scratch tree it measured\n",
  );
  assert.equal(grew.status, 1, `a fifth path in a file recorded with four is refused\n${grew.out}`);
  assert.match(grew.out, /5 paths, 4 recorded/, grew.out);
});

test("--draft prints the line to paste, and a line with no reason is still refused", async (t) => {
  const { repo } = await fixture(t);
  await runAtHead(repo, { "docs/landing.md": "the shots are in C:/Users/roper/x\n" }, "# empty\n");
  const draft = spawnSync(process.execPath, [path.join(ROOT, "tools", "absolute-paths.mjs"), "--draft"], {
    cwd: repo, encoding: "utf8", windowsHide: true,
  });
  assert.equal(draft.status, 0, draft.stderr);
  assert.match(draft.stdout, /^docs\/landing\.md \| 1 \| $/m, `the draft is the allowlist line\n${draft.stdout}`);

  // Pasted unchanged it says nothing, and a decision that says nothing is not one.
  await writeFile(path.join(repo, ALLOW_FILE), "docs/landing.md | 1 | \n", "utf8");
  const blank = spawnSync(process.execPath, [path.join(ROOT, "tools", "absolute-paths.mjs")], {
    cwd: repo, encoding: "utf8", windowsHide: true,
  });
  assert.equal(blank.status, 1, `an empty reason is a refusal\n${blank.stdout}${blank.stderr}`);
  assert.match(blank.stderr, /no reason/);
});

test("this repository's own tree passes — the allowlist matches what is really there", () => {
  // The claim that would break first if the record were wrong: a count too low refuses main itself, and a count too
  // high means a file grew without anyone noticing. Run in the working tree so the answer does not depend on whether
  // the allowlist has been committed yet.
  const r = spawnSync(process.execPath, [path.join(ROOT, "tools", "absolute-paths.mjs")], {
    cwd: ROOT, encoding: "utf8", windowsHide: true,
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /absolute-paths: clean — \d+ tracked files, \d+ paths in \d+ allowlisted files, none new/);
});

test("the commit being pushed is what is judged, and its own allowlist goes with it", () => {
  // `--rev` reads the allowlist out of THAT commit, so a branch that widens the record shows the widening in its
  // diff — and a tree whose HEAD predates the allowlist is judged with no allowlist at all, which is the honest
  // answer for that commit. So the answer depends on what HEAD carries: clean when HEAD carries the allowlist,
  // refused when it does not, and not asserted at all while the record itself is being edited (a working tree with
  // uncommitted allowlist changes is a commit that has not been made yet).
  const atHead = spawnSync(process.execPath, [path.join(ROOT, "tools", "absolute-paths.mjs"), "--rev", "HEAD"], {
    cwd: ROOT, encoding: "utf8", windowsHide: true,
  });
  const allowAtHead = spawnSync("git", ["-C", ROOT, "cat-file", "-e", `HEAD:${ALLOW_FILE}`], { windowsHide: true });
  const dirty = spawnSync("git", ["-C", ROOT, "status", "--porcelain"], { encoding: "utf8", windowsHide: true })
    .stdout.trim().length > 0;
  if (dirty) {
    assert.match(`${atHead.stdout}${atHead.stderr}`, /absolute-paths: (clean|refused)/, "it answers either way");
  } else if (allowAtHead.status === 0) {
    assert.equal(atHead.status, 0, `${atHead.stdout}${atHead.stderr}`);
    assert.match(atHead.stdout, /files at HEAD, \d+ paths/);
  } else {
    assert.equal(atHead.status, 1, "a HEAD without the allowlist refuses every path it finds");
  }
});

test("scanRev reads the tree it is given, not the working tree", async (t) => {
  const { repo } = await fixture(t);
  await runAtHead(repo, { "docs/clean.md": "a note that names nothing\n" }, "# empty\n");
  const before = scanRev(repo, "HEAD");
  assert.equal(before.hits.length, 0, JSON.stringify(before.hits));
  // Both reads count the same tracked files, the three SELF files included — the number a run prints is the size of
  // the tree, not of what got scanned, so the two modes cannot report different sizes for the same commit.
  assert.equal(before.files, scanWorktree(repo).files, "a tree read two ways is the same size");

  // A path written but not committed is not in HEAD's tree, so the push that would carry it is not silently wrong.
  await writeFile(path.join(repo, "docs/clean.md"), "now it says C:/Users/roper/x\n", "utf8");
  assert.equal(scanRev(repo, "HEAD").hits.length, 0, "uncommitted work is not what a push sends");
});

// ---------- the hook ----------

// git runs a hook with the sh its own installation ships, so `sh` is on PATH inside a hook but a suite started from
// cmd.exe may have none. Look for one instead of failing on the harness's environment.
function findSh() {
  const candidates = [process.env.WTGUI_SH, "sh", "C:/Program Files/Git/usr/bin/sh.exe", "C:/Program Files/Git/bin/sh.exe"];
  for (const c of candidates) {
    if (!c) continue;
    const r = spawnSync(c, ["-c", "exit 0"], { stdio: "ignore", windowsHide: true });
    if (r.status === 0) return c;
  }
  return null;
}
const SH = findSh();
const NO_SH = SH ? false : "no sh on PATH — the hook itself runs under the sh git ships, so set WTGUI_SH to one";

// A clone of the shape that matters: a bare origin, a main already on it, and the REAL .githooks/pre-push and tools
// copied in — the gate under test is the shipped one. version.mjs travels with it because the hook runs that gate
// first and would stop before this one; package.json is above origin's version so the version gate is satisfied and
// the refusal a test sees can only be this gate's.
async function hookFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wtgui-absgate-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "init", "-q", "-b", "main", work);
  configureRepo(work);
  await mkdir(path.join(work, ".githooks"), { recursive: true });
  await mkdir(path.join(work, "tools"), { recursive: true });
  await writeFile(path.join(work, ".githooks", "pre-push"), await readFile(path.join(ROOT, ".githooks", "pre-push")));
  for (const tool of ["version.mjs", "release-history.mjs", "absolute-paths.mjs"]) {
    await writeFile(path.join(work, "tools", tool), await readFile(path.join(ROOT, "tools", tool)));
  }
  await writeFile(path.join(work, ALLOW_FILE), "# nothing recorded yet\n", "utf8");
  await writeFile(path.join(work, "package.json"), `${JSON.stringify({ name: "absgate", version: "0.34.0" }, null, 2)}\n`, "utf8");
  await writeFile(path.join(work, "README.md"), "fixture\n", "utf8");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "first");
  git(work, "remote", "add", "origin", origin.split(path.sep).join("/"));
  git(work, "push", "-q", "-u", "origin", "main");
  git(work, "config", "core.hooksPath", ".githooks");
  return { root, origin, work };
}

const pushResult = (work, branch) =>
  spawnSync("git", ["push", "origin", branch], {
    cwd: work, encoding: "utf8", windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
  });

test("the hook refuses a push that adds one, and the remote never learns the ref", { skip: NO_SH }, async (t) => {
  const { origin, work } = await hookFixture(t);
  git(work, "checkout", "-q", "-b", "landing-bad");
  await writeFile(path.join(work, "docs.md"), "the report is at C:/Users/roper/AppData/Local/Temp/wag/8a6b6ca1/x.html\n", "utf8");
  await writeFile(path.join(work, "package.json"), `${JSON.stringify({ name: "absgate", version: "0.34.1" }, null, 2)}\n`, "utf8");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "docs: a note that names where the report sat, with its bump");

  const refused = pushResult(work, "landing-bad");
  const where = `status=${refused.status}\n--- stdout ---\n${refused.stdout}\n--- stderr ---\n${refused.stderr}`;
  assert.notEqual(refused.status, 0, `the push is refused\n${where}`);
  assert.match(refused.stderr, /a commit being pushed names a folder on this machine/, `the refusal names the gate\n${where}`);
  assert.match(refused.stderr, /docs\.md:1/, `the refusal names the file and line\n${where}`);
  assert.equal(
    spawnSync("git", ["-C", origin, "rev-parse", "--verify", "--quiet", "refs/heads/landing-bad"], { windowsHide: true }).status === 0,
    false,
    `the remote never received the ref\n${where}`,
  );
});

test("the same hook lets a clean push through — the control", { skip: NO_SH }, async (t) => {
  const { origin, work } = await hookFixture(t);
  git(work, "checkout", "-q", "-b", "landing-good");
  await writeFile(path.join(work, "docs.md"), "the report the run wrote, described rather than located\n", "utf8");
  await writeFile(path.join(work, "package.json"), `${JSON.stringify({ name: "absgate", version: "0.34.2" }, null, 2)}\n`, "utf8");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "docs: a note that describes the report, with its bump");

  const allowed = pushResult(work, "landing-good");
  const where = `status=${allowed.status}\n--- stdout ---\n${allowed.stdout}\n--- stderr ---\n${allowed.stderr}`;
  assert.equal(allowed.status, 0, `a clean push goes out\n${where}`);
  assert.equal(
    spawnSync("git", ["-C", origin, "rev-parse", "--verify", "--quiet", "refs/heads/landing-good"], { windowsHide: true }).status,
    0,
    `the remote has it\n${where}`,
  );
});
