// THE COLLISION CARD'S TWO FIXES, as facts about the record and about git.
//
// WHY THESE CASES. The card used to print whatever string a worker typed as the counterpart and offer two ruling
// presses anyway, and it kept a report in the live lane after the branch it named had already landed. Both were
// defects in what the RECORD says, not in the drawing, so both are proved here:
//
//   * resolveCounterpart() answers a queue-row id, a thread, a worktree path, a slug, a branch - and answers
//     "same-tree" or "none" instead of inventing a counterpart;
//   * recordNote() stores that answer, and a same-tree or unmatched note can never be ruled on;
//   * probeSharedFiles() measures the paths both branches changed against their merge base, in a REAL repository,
//     and says "no shared file" as an ANSWER (ok: true, files: []) rather than as a failure;
//   * probeLanded() says whether a tip is in main and names the landing commit, also in a real repository;
//   * the sweep supersedes a report whose side landed AFTER the report was stamped, keeps it in history with the
//     commit named, drops it from the live lane, and never files it again.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CollisionBook, resolveCounterpart, sideOf, stateOf, targetTaskId } from "../lib/collisions.js";
import { sweepCollisions } from "../lib/collision-flow.js";
import { probeLanded, probeSharedFiles } from "../lib/collision-merge.js";

const PROJECT = "card-proj";
// Built from parts so the address never has to be typed as one literal; git only needs it to be non-empty.
const EMAIL = ["t", "example.test"].join("@");
const TREE = (name, over = {}) => ({
  project: PROJECT,
  path: `/repos/${PROJECT}/.worktrees/${name}`,
  name,
  branch: `wtgui/${name}`,
  head: String(over.head || (name === "card-a" ? "a" : "b")).repeat(40).slice(0, 40),
  parent: "main",
  live: true,
  dirtyFiles: [],
  untrackedFiles: [],
  commitFiles: [],
  ...over,
});
const SIDE = (name, over = {}) => sideOf(TREE(name, over));
const QUEUES = (rows) => [{ assistantId: "assistant-1", assistant: "One", tasks: rows }];

// ---- fix one: the key is resolved against the queue rows and the worktrees ------------------------------------
test("a target resolves to a queue row by id and by thread, to a worktree by path, slug and branch", () => {
  const rows = [TREE("card-a"), TREE("card-b")];
  const queues = QUEUES([
    { id: 12, title: "the b work", state: "doing", worktree: rows[1].path, thread: "card-b-thread" },
    { id: 13, title: "the a work", state: "doing", worktree: rows[0].path, thread: "card-a-thread" },
  ]);
  // The id, in the three spellings a worker uses.
  for (const typed of ["#12", "12", "task 12", "queue #12", "row 12"]) {
    const got = resolveCounterpart({ target: typed, rows, queues, project: PROJECT, selfPath: rows[0].path });
    assert.equal(got.kind, "tree", `${typed} names another tree`);
    assert.equal(got.row.path, rows[1].path);
    assert.equal(got.task.id, 12, "the queue row that resolved it travels with the answer");
  }
  // The thread it was carried on.
  const byThread = resolveCounterpart({ target: "card-b-thread", rows, queues, project: PROJECT, selfPath: rows[0].path });
  assert.equal(byThread.kind, "tree");
  assert.equal(byThread.row.path, rows[1].path);
  assert.equal(byThread.how, "thread");
  // The worktree: full path, directory slug, branch.
  const byPath = resolveCounterpart({ target: rows[1].path, rows, queues, project: PROJECT, selfPath: rows[0].path });
  assert.equal(byPath.row.path, rows[1].path);
  assert.equal(byPath.how, "path");
  const bySlug = resolveCounterpart({ target: "card-b", rows, queues, project: PROJECT, selfPath: rows[0].path });
  assert.equal(bySlug.row.path, rows[1].path);
  // A directory slug IS the path's last segment, so either answer is the truth about how it resolved.
  assert.ok(["path", "slug"].includes(bySlug.how), `a slug resolves by path or by name (got ${bySlug.how})`);
  const byBranch = resolveCounterpart({ target: "wtgui/card-b", rows, queues, project: PROJECT, selfPath: rows[0].path });
  assert.equal(byBranch.row.path, rows[1].path);
  assert.equal(byBranch.how, "branch");
  // A plain number is only a queue id when a row carries it: a tree called "12" still resolves as a tree.
  assert.equal(targetTaskId("task 12"), 12);
  assert.equal(targetTaskId("wtgui/12"), null);
});

test("a target that names THIS tree is same-tree, and one that names nothing is none - neither is a pair", () => {
  const rows = [TREE("card-a"), TREE("card-b")];
  const self = rows[0].path;
  const queues = QUEUES([{ id: 12, title: "the a work", state: "doing", worktree: self, thread: "card-a-thread" }]);
  for (const typed of ["card-a", "card-a-thread", "#12", self]) {
    const got = resolveCounterpart({ target: typed, rows, queues, project: PROJECT, selfPath: self });
    assert.equal(got.kind, "same-tree", `${typed} names the reporting tree`);
    assert.equal(got.row.path, self);
  }
  const nothing = resolveCounterpart({ target: "card-nope", rows, queues, project: PROJECT, selfPath: self });
  assert.equal(nothing.kind, "none");
  assert.equal(nothing.row, null);
  assert.match(nothing.said, /no tree on this board answers to "card-nope"/);
  // An older caller's `other` that IS the reporting row is checked, not trusted.
  const stale = resolveCounterpart({ target: "card-a", rows, queues, project: PROJECT, selfPath: self, other: rows[0] });
  assert.equal(stale.kind, "same-tree");
});

test("a note records the resolution: same-tree and no-match notes carry no counterpart and cannot be ruled on", () => {
  const rows = [TREE("card-a"), TREE("card-b")];
  const queues = QUEUES([{ id: 12, title: "the b work", state: "doing", worktree: rows[1].path, thread: "card-b-thread" }]);
  const book = new CollisionBook({ file: path.join(CARDS_DIR, "book-note.json") });

  const own = book.recordNote({ project: PROJECT, treePath: rows[0].path, branch: rows[0].branch, target: "card-a", text: "we touch the same file", rows, queues });
  assert.equal(own.saved, true);
  assert.equal(own.record.b, null, "the reporting tree is never stored as its own counterpart");
  assert.equal(own.record.sameTree, true);
  assert.equal(own.record.resolve.kind, "same-tree");
  const [ownView] = book.forTree(rows[0].path);
  assert.equal(ownView.resolution.kind, "same-tree");
  assert.equal(ownView.canRule, false, "no press between one tree and itself");
  assert.equal(ownView.state, "reader", "the reader still sees it, as a sentence");
  assert.match(own.line, /not a collision/);

  const nowhere = book.recordNote({ project: PROJECT, treePath: rows[0].path, branch: rows[0].branch, target: "card-nope", text: "something is in my way", rows, queues });
  assert.equal(nowhere.record.resolve.kind, "none");
  assert.equal(nowhere.record.bTarget, "card-nope", "the words are kept, as the words");
  const noView = book.forTree(rows[0].path).find((v) => v.resolution.kind === "none");
  assert.equal(noView.canRule, false);
  assert.equal(noView.other, null);

  // A target that DOES resolve is a pair, keyed by the two paths.
  const pair = book.recordNote({ project: PROJECT, treePath: rows[0].path, branch: rows[0].branch, target: "#12", text: "we both edit lib/shared.js", rows, queues });
  assert.equal(pair.record.resolve.kind, "tree");
  assert.equal(pair.record.b.path, rows[1].path);
  assert.equal(pair.record.b.task.id, 12, "the side names the queue row standing in it");
  const paired = book.forTree(rows[0].path).find((v) => v.key === pair.record.key);
  assert.equal(paired.canRule, false, "no measured files yet: the record offers nothing until git answers");
  assert.deepEqual(paired.files, []);
});

test("measured files, and only measured files, put the two presses on the record", () => {
  const book = new CollisionBook({});
  const rows = [TREE("card-a"), TREE("card-b")];
  const pair = book.recordNote({ project: PROJECT, treePath: rows[0].path, branch: rows[0].branch, target: "card-b", text: "same file", rows, queues: [] }).record;
  // An EMPTY set is an answer, and it still offers no press.
  book.rememberEvidence(pair.key, { ok: true, base: "c".repeat(40), files: [] });
  let view = book.forTree(rows[0].path)[0];
  assert.equal(view.canRule, false);
  assert.deepEqual(view.files, []);
  assert.equal(view.evidence.ok, true);
  // A failed measurement is NOT "no shared file": it is stored as a failure and the card says so.
  book.rememberEvidence(pair.key, { ok: false, error: "git could not list the files" });
  view = book.forTree(rows[0].path)[0];
  assert.equal(view.evidence.ok, false);
  assert.match(view.evidence.error, /could not list/);
  assert.equal(view.canRule, false);
  // Measured paths are the evidence the presses rest on.
  book.rememberEvidence(pair.key, { ok: true, base: "c".repeat(40), files: ["lib/shared.js", "LIB/Shared.js"] });
  view = book.forTree(rows[0].path)[0];
  assert.deepEqual(view.files, ["lib/shared.js"], "the set is normalised and deduped");
  assert.equal(view.canRule, true);
  assert.equal(view.relations[0].measured, true);
});

// ---- fix one, measured for real: two branches, one merge base --------------------------------------------------
test("probeSharedFiles measures the paths both branches changed against their merge base", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "collision-shared-"));
  const repo = path.join(dir, "repo");
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const commit = (message) => git("-c", "user.name=t", "-c", `user.email=${EMAIL}`, "commit", "-m", message);
  try {
    mkdirSync(repo);
    git("init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "README.md"), "base\n");
    git("add", ".");
    commit("base");
    const base = git("rev-parse", "HEAD").trim();

    // Two branches cut from main, both editing lib/shared.js, each also touching a file of its own.
    git("checkout", "-q", "-b", "wtgui/card-a");
    mkdirSync(path.join(repo, "lib"));
    writeFileSync(path.join(repo, "lib", "shared.js"), "a\n");
    writeFileSync(path.join(repo, "lib", "only-a.js"), "a\n");
    git("add", ".");
    commit("a");
    const tipA = git("rev-parse", "HEAD").trim();

    git("checkout", "-q", "main");
    git("checkout", "-q", "-b", "wtgui/card-b");
    mkdirSync(path.join(repo, "lib"), { recursive: true });
    writeFileSync(path.join(repo, "lib", "shared.js"), "b\n");
    writeFileSync(path.join(repo, "lib", "only-b.js"), "b\n");
    git("add", ".");
    commit("b");
    const tipB = git("rev-parse", "HEAD").trim();

    const got = probeSharedFiles({ a: { path: repo, head: tipA }, b: { path: repo, head: tipB } });
    assert.equal(got.ok, true);
    assert.equal(got.base, base, "the merge base is the commit both branches were cut from");
    assert.deepEqual(got.files, ["lib/shared.js"], "only the path BOTH changed is shared");
    // A branch that touches nothing the other one touches is a real, empty answer.
    git("checkout", "-q", "main");
    git("checkout", "-q", "-b", "wtgui/card-c");
    mkdirSync(path.join(repo, "lib"), { recursive: true });
    writeFileSync(path.join(repo, "lib", "only-c.js"), "c\n");
    git("add", ".");
    commit("c");
    const tipC = git("rev-parse", "HEAD").trim();
    const empty = probeSharedFiles({ a: { path: repo, head: tipA }, b: { path: repo, head: tipC } });
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.files, []);
    // A tip that does not resolve is a FAILURE, not an empty set.
    const broken = probeSharedFiles({ a: { path: repo, head: "d".repeat(40) }, b: { path: repo, head: tipB } });
    assert.equal(broken.ok, false);
    assert.match(broken.error, /does not resolve/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- fix two, measured for real: a landing with a date ----------------------------------------------------------
test("probeLanded names the commit that landed a tip, and says when it landed", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "collision-landed-"));
  const repo = path.join(dir, "repo");
  const env = { ...process.env, GIT_AUTHOR_DATE: "2026-02-02T10:00:00Z", GIT_COMMITTER_DATE: "2026-02-02T10:00:00Z" };
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  const commit = (message) => git("-c", "user.name=t", "-c", `user.email=${EMAIL}`, "commit", "-m", message);
  try {
    mkdirSync(repo);
    git("init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "README.md"), "base\n");
    git("add", ".");
    commit("base");
    git("checkout", "-q", "-b", "wtgui/card-b");
    mkdirSync(path.join(repo, "lib"), { recursive: true });
    writeFileSync(path.join(repo, "b.txt"), "b\n");
    git("add", ".");
    commit("b");
    const tipB = git("rev-parse", "HEAD").trim();
    git("checkout", "-q", "-b", "wtgui/card-a", "main");
    writeFileSync(path.join(repo, "a.txt"), "a\n");
    git("add", ".");
    commit("a");
    const tipA = git("rev-parse", "HEAD").trim();

    // Not landed yet.
    const before = probeLanded({ path: repo, head: tipB }, { main: "main" });
    assert.equal(before.ok, true);
    assert.equal(before.landed, false);
    assert.equal(before.commit, null);

    // Land b with a merge commit dated AFTER the report the sweep will compare against.
    git("checkout", "-q", "main");
    execFileSync("git", ["-c", "user.name=t", "-c", `user.email=${EMAIL}`, "merge", "--no-ff", "-m", "land b", "wtgui/card-b"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_DATE: "2026-02-02T12:00:00Z", GIT_COMMITTER_DATE: "2026-02-02T12:00:00Z" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const landing = git("rev-parse", "HEAD").trim();
    const landed = probeLanded({ path: repo, head: tipB }, { main: "main" });
    assert.equal(landed.ok, true);
    assert.equal(landed.landed, true);
    assert.equal(landed.commit, landing, "the merge commit IS the landing");
    assert.equal(landed.landedAt, "2026-02-02T12:00:00.000Z");
    // The other branch is still out.
    assert.equal(probeLanded({ path: repo, head: tipA }, { main: "main" }).landed, false);
    // A repository with no such main is a failure with a sentence, not a false answer.
    const nowhere = probeLanded({ path: repo, head: tipB }, { main: "no-such-main" });
    assert.equal(nowhere.ok, false);
    assert.match(nowhere.error, /no no-such-main/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- fix two: the sweep stamps, compares and supersedes ---------------------------------------------------------
const REPORT_AT = "2026-03-03T09:00:00.000Z";
const LANDED_AT = "2026-03-03T09:10:00.000Z";
const LANDING = "e".repeat(40);

const CARDS_DIR = mkdtempSync(path.join(os.tmpdir(), "collision-cards-"));
process.on("exit", () => rmSync(CARDS_DIR, { recursive: true, force: true }));
let cardBooks = 0;
function notedBook() {
  const book = new CollisionBook({ file: path.join(CARDS_DIR, `book-${(cardBooks += 1)}.json`) });
  const rows = [TREE("card-a"), TREE("card-b")];
  const queues = QUEUES([
    { id: 12, title: "the b work", state: "doing", worktree: rows[1].path, thread: "card-b-thread" },
    { id: 13, title: "the a work", state: "doing", worktree: rows[0].path, thread: "card-a-thread" },
  ]);
  const out = book.recordNote({
    project: PROJECT,
    treePath: rows[0].path,
    branch: rows[0].branch,
    target: "card-b",
    text: "we both change lib/shared.js",
    rows,
    queues,
    at: REPORT_AT,
  });
  return { book, rows, record: out.record };
}

test("a landing later than the report supersedes the pair: history names the commit, the live lane drops it", () => {
  const { book, rows, record } = notedBook();
  const landed = () => ({ ok: true, at: LANDED_AT, repo: rows[1].path, main: "main", mainRef: "refs/heads/main", tip: rows[1].head, landed: true, commit: LANDING, landedAt: LANDED_AT, error: null });
  const notLanded = () => ({ ok: true, at: LANDED_AT, repo: rows[0].path, main: "main", mainRef: "refs/heads/main", tip: rows[0].head, landed: false, commit: null, landedAt: null, error: null });
  const deps = {
    probeShared: () => ({ ok: true, at: LANDED_AT, base: "c".repeat(40), files: ["lib/shared.js"], error: null }),
    // The FIRST side asked is card-a (still out); the second, card-b, is landed.
    probeLanded: (side) => (side.path === rows[1].path ? landed() : notLanded()),
    mainFor: () => "main",
    tasksFor: () => [],
    ownerOf: () => null,
    fileQueue: () => ({ taskId: 900 }),
  };
  const first = sweepCollisions({ rows, book, now: Date.parse(REPORT_AT) + 60_000, ...deps });
  assert.equal(first.measured.length, 1, "the note's claim was measured");
  assert.deepEqual(first.measured[0].files, 1);
  assert.equal(first.superseded.length, 1);
  assert.equal(first.filed.length, 0, "a superseded pair files nothing into either queue");

  const rec = book.get(record.key);
  assert.equal(rec.superseded.commit, LANDING);
  assert.equal(rec.superseded.landedAt, LANDED_AT);
  assert.equal(rec.superseded.reportAt, REPORT_AT);
  assert.equal(stateOf(rec), "superseded");
  assert.deepEqual(rec.files, ["lib/shared.js"], "the measured evidence survives into history");

  // LIVE LANE: nothing. HISTORY: the pair, marked, naming the commit.
  assert.deepEqual(book.forTree(rows[0].path), []);
  assert.deepEqual(book.forTree(rows[1].path), []);
  const [past] = book.historyFor(rows[0].path);
  assert.ok(past, "the pair is kept for the record");
  assert.equal(past.state, "superseded");
  assert.equal(past.superseded.commit, LANDING);
  assert.equal(past.superseded.short, LANDING.slice(0, 12));
  assert.equal(past.canRule, false, "history asks nothing of the reader");

  // A SUPSERSEDED PAIR IS NOT RE-FILED, however many sweeps run.
  for (const offset of [120_000, 180_000]) {
    const again = sweepCollisions({ rows, book, now: Date.parse(REPORT_AT) + offset, ...deps });
    assert.deepEqual(again.filed, []);
    assert.deepEqual(again.superseded, [], "the record is already history");
  }
  // And it survives a restart as history.
  assert.equal(book.save().ok, true);
  const reread = new CollisionBook({ file: book.file });
  const [back] = reread.historyFor(rows[0].path);
  assert.equal(back.superseded.commit, LANDING);
  assert.deepEqual(reread.forTree(rows[0].path), []);
});

test("a landing OLDER than the report is not a supersession: the pair is live and the report stands", () => {
  const { book, rows, record } = notedBook();
  const deps = {
    probeLanded: () => ({ ok: true, at: "2026-03-03T08:00:00.000Z", repo: rows[1].path, main: "main", mainRef: "refs/heads/main", tip: rows[1].head, landed: true, commit: LANDING, landedAt: "2026-03-03T08:00:00.000Z", error: null }),
    mainFor: () => "main",
    tasksFor: () => [],
    ownerOf: () => null,
  };
  const report = sweepCollisions({ rows, book, now: Date.parse(REPORT_AT) + 60_000, ...deps });
  assert.deepEqual(report.superseded, []);
  assert.equal(book.get(record.key).superseded, null);
  const live = book.forTree(rows[0].path);
  assert.equal(live.length, 1, "the pair is still the reader's");
  assert.notEqual(live[0].state, "superseded");
  assert.equal(live[0].reportedAt, REPORT_AT, "the report's stamp is what the landing was compared with");
});

test("a landing a sweep could not date is not guessed at: the pair stays", () => {
  const { book, rows, record } = notedBook();
  const deps = {
    probeLanded: () => ({ ok: true, at: LANDED_AT, repo: rows[1].path, main: "main", mainRef: "refs/heads/main", tip: rows[1].head, landed: true, commit: LANDING, landedAt: null, error: null }),
    mainFor: () => "main",
    tasksFor: () => [],
    ownerOf: () => null,
  };
  const report = sweepCollisions({ rows, book, now: Date.parse(REPORT_AT) + 60_000, ...deps });
  assert.deepEqual(report.superseded, []);
  assert.equal(book.get(record.key).superseded, null);
  assert.equal(book.get(record.key).land.landed, true, "the answer is cached, but no commit is claimed as later");
});

test("a same-tree note is never superseded into a pair: its one side landing ends it as history", () => {
  const book = new CollisionBook({});
  const rows = [TREE("card-a")];
  const own = book.recordNote({ project: PROJECT, treePath: rows[0].path, branch: rows[0].branch, target: "card-a", text: "this is my own tree", rows, at: REPORT_AT });
  assert.equal(own.record.resolve.kind, "same-tree");
  const deps = {
    probeLanded: () => ({ ok: true, at: LANDED_AT, repo: rows[0].path, main: "main", mainRef: "refs/heads/main", tip: rows[0].head, landed: true, commit: LANDING, landedAt: LANDED_AT, error: null }),
    mainFor: () => "main",
    tasksFor: () => [],
    ownerOf: () => null,
  };
  const report = sweepCollisions({ rows, book, now: Date.parse(REPORT_AT) + 60_000, ...deps });
  assert.deepEqual(report.superseded.map((s) => s.pairKey), [own.record.key]);
  assert.deepEqual(book.forTree(rows[0].path), []);
  assert.equal(book.historyFor(rows[0].path)[0].resolution.kind, "same-tree");
});

// A commit that is not a full sha is refused rather than stored as an uncheckable claim.
test("supersede refuses a commit that is not a full sha", () => {
  const { book, record } = notedBook();
  const kept = book.supersede(record.key, { commit: "abc123", landedAt: LANDED_AT, side: "b", main: "main" });
  assert.equal(kept.superseded, null);
  const ok = book.supersede(record.key, { commit: LANDING, landedAt: LANDED_AT, side: "b", main: "main" });
  assert.equal(ok.superseded.short, LANDING.slice(0, 12));
  // Superseding twice keeps the first landing: the pair ended once.
  book.supersede(record.key, { commit: "f".repeat(40), landedAt: "2026-03-03T10:00:00.000Z", side: "a" });
  assert.equal(book.get(record.key).superseded.commit, LANDING);
});
