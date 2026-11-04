// The DELIVERABLES store and the harvest seam — the backend half of the hand-back list.
//
// The button and its popover shipped in PR #319 over a backend that never landed: `GET /api/deliverables` and
// `POST /api/deliverables/open` 404ed, and the gate hid it by intercepting both routes. This file pins the missing
// half against docs/plan/deliverables-handback.md §2–§5 and §9.1:
//
//   1. the grammar, every failure said as a sentence (§2.3), and the brief that teaches it parsing as ZERO markers;
//   2. a relative target resolving against the tree THIS measure pass located (B2), not the job's stale copy;
//   3. the kind checks: a link is http(s), an image carries an image suffix, a file is a file;
//   4. the store: one row per target, a restart reading it back, `missingAt` set and cleared;
//   5. dedupe (M11): a repeat that changes nothing writes nothing, and does not bump the row;
//   6. the cap: 201 deliveries keep 200, the seq of a forgotten row is never handed out again;
//   7. a corrupt file is kept aside rather than overwritten (M6);
//   8. a failed write reports `saved: false`, and the harvest leaves its mark unset so the next pass retries (B1/M5);
//   9. the settle seam itself, driven on a bare `Jobs` prototype (the shape test/release-request.test.js uses);
//  10. read-time resolution by the six-hex tag (M14), and the job id as the click's key (M7).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Off this box's own Hermes install: importing lib/jobs.js must not read the reader's state.
process.env.HERMES_HOME = mkdtempSync(path.join(tmpdir(), "wtgui-deliver-home-"));
process.env.API_SERVER_KEY = "";

const { DELIVER_BRIEF, Jobs } = await import("../lib/jobs.js");
const { DELIVER_KEEP, Deliverables, dedupeKey, parseDeliverLines } = await import("../lib/deliverables.js");

function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-deliver-"));
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* a git handle on Windows; the OS temp is throwaway */
    }
  });
  return dir;
}

// A worktree-shaped folder with one report in it, and the store file beside it (as `statePaths()` lays them out).
function fixture(t, { branch = "wtgui/write-the-report-5db421" } = {}) {
  const dir = sandbox(t);
  const tree = path.join(dir, "tree");
  mkdirSync(path.join(tree, "docs"), { recursive: true });
  writeFileSync(path.join(tree, "docs", "report.html"), "<h1>the report</h1>\n");
  writeFileSync(path.join(tree, "docs", "shot.png"), "png-bytes\n");
  const file = path.join(dir, "logs", "deliverables.json");
  return { dir, tree, file, branch, store: new Deliverables({ file, log: () => {} }) };
}

const jobFor = (tree, extra = {}) => ({ id: "run-1", thread: "wtgui-write-the-report-5db421", turn: 1, project: "agent-worktree-gui", worktreePath: tree, branch: "wtgui/write-the-report-5db421", ...extra });
const treeAt = (tree, branch = "wtgui/write-the-report-5db421") => ({ path: tree, branch });
const at = (iso) => new Date(iso).getTime();

// ---- 1. the grammar ------------------------------------------------------------------------------------------------
test("every broken DELIVER shape comes back with the sentence the card says", () => {
  const one = (line) => parseDeliverLines(line)[0];
  assert.equal(one("DELIVER").error, "a DELIVER line needs `<link|file|image> <target> | <title>`");
  assert.equal(one("DELIVER file C:/x.md").error, "DELIVER needs `| <title>` after the target");
  assert.equal(one("DELIVER doc C:/x.md | t").error, "“doc” is not one of link / file / image");
  assert.equal(one("DELIVER file | t").error, "DELIVER names no target");
  assert.equal(one("DELIVER file C:/x.md |").error, "DELIVER names no title — say what the reader should do with it, in a few words");
});

test("a title may hold a pipe, a quoted path keeps its spaces, and the kind is case-insensitive", () => {
  const [line] = parseDeliverLines('deliver file "C:/My Projects/x/out/notes.md" | Landed | merged by the reader');
  assert.equal(line.error, null);
  assert.equal(line.kind, "file");
  assert.equal(line.target, "C:/My Projects/x/out/notes.md");
  assert.equal(line.title, "Landed | merged by the reader");
});

test("DELIVERED is not a marker, and neither is a fenced line", () => {
  assert.deepEqual(parseDeliverLines("DELIVERED file C:/x.md | t"), []);
  assert.deepEqual(parseDeliverLines("```DELIVER file C:/x.md | t```"), []);
});

test("the brief the worker is told parses as ZERO markers — and its example line does", () => {
  // The paragraph a model is handed must not, echoed verbatim, paint a refusal on its own card (M4).
  assert.deepEqual(parseDeliverLines(DELIVER_BRIEF), []);
  const example = DELIVER_BRIEF.split(/\r?\n/).find((l) => l.trim().startsWith("example:"));
  assert.ok(example, "the brief carries an example:");
  const copied = example.trim().replace(/^example:\s*/, "");
  const parsed = parseDeliverLines(copied);
  assert.equal(parsed.length, 1, "the example, without its prefix, is a real marker");
  assert.equal(parsed[0].kind, "file");
  assert.equal(parsed[0].error, null);
});

test("a <placeholder> target is a template echo, ignored rather than refused", () => {
  assert.deepEqual(parseDeliverLines("DELIVER <link|file|image> <target> | <title>"), []);
  assert.deepEqual(parseDeliverLines("DELIVER file <target> | a title"), []);
  assert.deepEqual(parseDeliverLines("DELIVER file C:/x.md | <title>"), []);
});

// ---- 2. resolution -------------------------------------------------------------------------------------------------
test("a relative target resolves against the tree this pass measured, even when the job names another directory", (t) => {
  const { dir, tree, store, branch } = fixture(t);
  const stale = path.join(dir, "the-old-name"); // what the job was created with, and what an auto-rename left behind
  const job = jobFor(stale);
  const out = store.record({ job, tree: treeAt(tree, branch), finalText: "DELIVER file docs/report.html | The report" });
  assert.equal(out.refused.length, 0);
  const [entry] = store.list().entries;
  assert.equal(entry.target, `${tree.replace(/\\/g, "/")}/docs/report.html`);
  assert.equal(entry.bytes, "<h1>the report</h1>\n".length);
  assert.equal(entry.branch, branch);
  assert.equal(entry.tag, "5db421");
});

test("without a tree the job's own path is the base, and `..` is resolved", (t) => {
  const { tree, store, dir } = fixture(t);
  writeFileSync(path.join(dir, "outside.md"), "outside\n");
  const out = store.record({ job: jobFor(tree), finalText: "DELIVER file ../outside.md | one file up" });
  assert.equal(out.refused.length, 0);
  assert.equal(store.list().entries[0].target, `${dir.replace(/\\/g, "/")}/outside.md`);
});

test("a target over 1024 characters is refused rather than stat'ed", (t) => {
  const { tree, store } = fixture(t);
  const long = "a".repeat(1100);
  const out = store.record({ job: jobFor(tree), tree: treeAt(tree), finalText: `DELIVER file ${long} | too long` });
  assert.equal(out.added, 0);
  assert.match(out.refused[0].error, /the target is \d+ characters; the panel keeps at most 1024/);
});

// ---- 3. the kinds -------------------------------------------------------------------------------------------------
test("a link must be http(s): ftp, mailto and a bare path are refused", (t) => {
  const { tree, store } = fixture(t);
  const out = store.record({
    job: jobFor(tree),
    tree: treeAt(tree),
    finalText: [
      "DELIVER link ftp://host/x | t",
      "DELIVER link mailto:someone@example.test | t",
      "DELIVER link C:/x.md | t",
      "DELIVER link not-a-url | t",
    ].join("\n"),
  });
  assert.equal(out.added, 0);
  assert.deepEqual(
    out.refused.map((r) => r.error),
    [
      "only http(s) links can be delivered (got “ftp:”)",
      "only http(s) links can be delivered (got “mailto:”)",
      "only http(s) links can be delivered (got “c:”)",
      "“not-a-url” is not a URL — a link needs http:// or https://",
    ],
  );
  // …and one good link is stored normalised, with no size.
  store.record({ job: jobFor(tree), tree: treeAt(tree), finalText: "DELIVER link https://localhost:7473/report.html?a=1&b=2 | The probe" });
  const link = store.list().entries[0];
  assert.equal(link.kind, "link");
  assert.equal(link.target, "https://localhost:7473/report.html?a=1&b=2");
  assert.equal(link.bytes, null);
  assert.equal(link.mtimeMs, null);
});

test("an image must carry an image suffix, and a directory is not a file", (t) => {
  const { tree, store } = fixture(t);
  const out = store.record({
    job: jobFor(tree),
    tree: treeAt(tree),
    finalText: ["DELIVER image docs/report.html | not a picture", "DELIVER file docs | a folder", "DELIVER file docs/nope.md | absent"].join("\n"),
  });
  assert.equal(out.added, 0);
  assert.match(out.refused[0].error, /^an image must end in \.png \/ \.jpg/);
  assert.match(out.refused[1].error, /^that is a directory, not a file: /);
  assert.match(out.refused[2].error, /^no such file: .*nope\.md — resolved from “docs\/nope\.md” against /);
  // The image that IS one is a file row: same opener, its own glyph in the page.
  store.record({ job: jobFor(tree), tree: treeAt(tree), finalText: "DELIVER image docs/shot.png | The dock" });
  assert.equal(store.list().entries[0].kind, "image");
});

test("every refusal is ONE console line in the panel's voice", (t) => {
  const { tree, store } = fixture(t);
  const out = store.record({ job: jobFor(tree), tree: treeAt(tree), finalText: "DELIVER file docs/nope.md | absent" });
  assert.equal(out.lines.length, 1);
  assert.equal(out.lines[0].kind, "raw");
  assert.match(out.lines[0].text, /^⚠ DELIVER was NOT recorded — no such file: /);
});

// ---- 4. the store --------------------------------------------------------------------------------------------------
test("one good line is one entry with its kind, target, title, seq, age and origin", (t) => {
  const { tree, store, file, branch } = fixture(t);
  const out = store.record({ job: jobFor(tree), tree: treeAt(tree, branch), finalText: "done\nDELIVER file docs/report.html | The HTML report", agent: "write-the-report-5db421" });
  assert.equal(out.parsed, 1);
  assert.equal(out.added, 1);
  assert.equal(out.saved, true);
  const list = store.list();
  assert.deepEqual({ version: list.version, cap: list.cap, kept: list.kept, nextSeq: list.nextSeq }, { version: 1, cap: 200, kept: 1, nextSeq: 2 });
  const [entry] = list.entries;
  assert.equal(entry.seq, 1);
  assert.equal(entry.kind, "file");
  assert.equal(entry.title, "The HTML report");
  assert.equal(entry.agent, "write-the-report-5db421");
  assert.equal(entry.project, "agent-worktree-gui");
  assert.equal(entry.jobId, "run-1");
  assert.equal(entry.thread, "wtgui-write-the-report-5db421");
  assert.equal(entry.turn, 1);
  assert.equal(entry.missingAt, null);
  assert.ok(Number.isFinite(new Date(entry.at).getTime()), entry.at);
  // The file is the shape §4.2 names, newest-first, and the next constructor reads it back — the restart proof.
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.entries.length, 1);
  const reopened = new Deliverables({ file });
  assert.equal(reopened.list().kept, 1);
  assert.equal(reopened.list().entries[0].target, entry.target);
});

test("missingAt is stamped on a click that finds the file gone, and cleared when it is back", (t) => {
  const { tree, store } = fixture(t);
  store.record({ job: jobFor(tree), tree: treeAt(tree), finalText: "DELIVER file docs/report.html | The report" });
  const stamped = store.markMissing(1);
  assert.ok(stamped.missingAt, "the row says gone");
  assert.ok(store.list().entries[0].missingAt, "and the list reads it");
  assert.equal(store.clearMissing(1).missingAt, null);
});

// ---- 5. dedupe -----------------------------------------------------------------------------------------------------
test("the same run writing the line twice is one row, and only a changed title is written", (t) => {
  const { tree, store } = fixture(t);
  const treeNow = treeAt(tree);
  const first = store.record({ job: jobFor(tree), tree: treeNow, finalText: "DELIVER file docs/report.html | The report", now: at("2026-11-03T10:00:00.000Z") });
  assert.equal(first.added, 1);
  const again = store.record({ job: jobFor(tree), tree: treeNow, finalText: "DELIVER file docs/report.html | The HTML report", now: at("2026-11-03T10:05:00.000Z") });
  assert.equal(again.added, 0);
  assert.equal(again.updated, 1);
  const list = store.list();
  assert.equal(list.kept, 1);
  assert.equal(list.entries[0].title, "The HTML report");
  assert.equal(list.entries[0].at, "2026-11-03T10:00:00.000Z", "the row's age is when it was delivered, not when it was corrected");
  assert.equal(list.entries[0].seq, 1);
});

test("a second run repeating the same target, size and title writes nothing at all", (t) => {
  const { tree, store, file } = fixture(t);
  const treeNow = treeAt(tree);
  store.record({ job: jobFor(tree, { id: "run-1" }), tree: treeNow, finalText: "DELIVER file docs/report.html | The report", now: at("2026-11-03T10:00:00.000Z") });
  const before = readFileSync(file, "utf8");
  const echo = store.record({ job: jobFor(tree, { id: "run-2", turn: 2 }), tree: treeNow, finalText: "DELIVER file docs/report.html | The report", now: at("2026-11-03T11:00:00.000Z") });
  assert.equal(echo.updated, 0);
  assert.equal(echo.added, 0);
  assert.deepEqual(echo.lines, [], "a reply that echoes the marker is not a delivery");
  assert.equal(readFileSync(file, "utf8"), before, "nothing was written");
  assert.equal(store.list().entries[0].jobId, "run-1");
});

test("a changed title or a changed file updates the row in place and makes it newest", (t) => {
  const { tree, store } = fixture(t);
  const treeNow = treeAt(tree);
  store.record({ job: jobFor(tree, { id: "run-1" }), tree: treeNow, finalText: "DELIVER file docs/report.html | The report", now: at("2026-11-03T10:00:00.000Z") });
  store.record({ job: jobFor(tree, { id: "run-2", turn: 2 }), tree: treeNow, finalText: "DELIVER link https://x.test/a | A link", now: at("2026-11-03T11:00:00.000Z") });
  // Same target, new title, later run: updated, and it is the newest row again.
  store.record({ job: jobFor(tree, { id: "run-3", turn: 3 }), tree: treeNow, finalText: "DELIVER file docs/report.html | The HTML report", now: at("2026-11-03T12:00:00.000Z") });
  // Same title, a file that grew: the row is updated too.
  writeFileSync(path.join(tree, "docs", "report.html"), "<h1>the report, revised</h1>\n");
  store.record({ job: jobFor(tree, { id: "run-4", turn: 4 }), tree: treeNow, finalText: "DELIVER file docs/report.html | The HTML report", now: at("2026-11-03T13:00:00.000Z") });
  const list = store.list();
  assert.equal(list.kept, 2, "one row per target, throughout");
  assert.equal(list.entries[0].title, "The HTML report");
  assert.equal(list.entries[0].jobId, "run-4");
  assert.equal(list.entries[0].at, "2026-11-03T13:00:00.000Z");
  assert.equal(list.entries[0].bytes, "<h1>the report, revised</h1>\n".length);
});

test("an image and a file naming the same bytes are ONE row", (t) => {
  const { tree, store } = fixture(t);
  assert.equal(dedupeKey({ kind: "image", target: "C:/X/a.png" }), dedupeKey({ kind: "file", target: "C:/X/a.png" }));
  store.record({ job: jobFor(tree, { id: "run-1" }), tree: treeAt(tree), finalText: "DELIVER file docs/shot.png | The shot" });
  store.record({ job: jobFor(tree, { id: "run-2" }), tree: treeAt(tree), finalText: "DELIVER image docs/shot.png | The screenshot" });
  assert.equal(store.list().kept, 1);
});

// ---- 6. the cap ----------------------------------------------------------------------------------------------------
test("201 deliveries keep 200, the oldest is forgotten, and its seq is never handed out again", (t) => {
  const { tree, store, file } = fixture(t);
  mkdirSync(path.join(tree, "many"), { recursive: true });
  const lines = [];
  for (let i = 1; i <= 201; i += 1) {
    writeFileSync(path.join(tree, "many", `r${i}.md`), `${i}\n`);
    lines.push(`DELIVER file many/r${i}.md | Report ${i}`);
  }
  const out = store.record({ job: jobFor(tree), tree: treeAt(tree), finalText: lines.join("\n"), now: at("2026-11-03T10:00:00.000Z") });
  assert.equal(out.added, 201);
  const list = store.list();
  assert.equal(DELIVER_KEEP, 200);
  assert.equal(list.kept, 200);
  assert.equal(list.entries.length, 200);
  assert.equal(list.nextSeq, 202);
  assert.equal(list.entries.some((e) => e.seq === 1), false, "the oldest row is the one that went");
  assert.equal(list.entries.some((e) => e.seq === 201), true);
  // A reload does not resurrect it, and the next seq is not reused.
  const reopened = new Deliverables({ file });
  assert.equal(reopened.list().kept, 200);
  assert.equal(reopened.list().nextSeq, 202);
  const more = reopened.record({ job: jobFor(tree, { id: "run-2" }), tree: treeAt(tree), finalText: "DELIVER link https://x.test/one | one more" });
  assert.equal(more.added, 1);
  assert.equal(reopened.list().entries[0].seq, 202);
});

// ---- 7. a corrupt file ---------------------------------------------------------------------------------------------
test("an unreadable file starts empty, is kept aside at the first write, and is not overwritten in place", (t) => {
  const { tree, file } = fixture(t);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '{"version": 1, "entries": [ truncated', "utf8");
  const logged = [];
  const store = new Deliverables({ file, log: (m) => logged.push(m) });
  assert.equal(store.list().kept, 0, "a file that cannot be parsed is not a list");
  assert.equal(logged.length, 1, "and it is said once");
  store.record({ job: jobFor(tree), tree: treeAt(tree), finalText: "DELIVER file docs/report.html | The report" });
  const aside = readdirSync(path.dirname(file)).filter((n) => n.startsWith("deliverables.json.corrupt-"));
  assert.equal(aside.length, 1, "the evidence is beside the live file");
  assert.match(readFileSync(path.join(path.dirname(file), aside[0]), "utf8"), /truncated/);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).entries.length, 1);
});

// ---- 8. a failed write ---------------------------------------------------------------------------------------------
test("a write that cannot land reports saved:false, keeps the row in memory, and retries on the next pass", (t) => {
  const { tree } = fixture(t);
  const dir = sandbox(t);
  // A regular FILE where the store's folder should be: `mkdirSync` cannot make the folder, so the write cannot land.
  // (A directory at the store's own path would not do it — `load()` reads it as a corrupt file and `save()` moves it
  // aside, which is the repair path, not the failure path.)
  const blocker = path.join(dir, "not-a-folder");
  writeFileSync(blocker, "in the way\n");
  const blocked = path.join(blocker, "deliverables.json");
  const store = new Deliverables({ file: blocked, log: () => {} });
  const treeNow = treeAt(tree);
  const first = store.record({ job: jobFor(tree), tree: treeNow, finalText: "DELIVER file docs/report.html | The report" });
  assert.equal(first.saved, false);
  assert.ok(first.error, "the failure is reported, not swallowed");
  assert.equal(store.list().kept, 1, "the accepted row is still in memory");
  rmSync(blocker); // the fault is cleared
  const retry = store.record({ job: jobFor(tree), tree: treeNow, finalText: "DELIVER file docs/report.html | The report" });
  assert.equal(retry.saved, true, "a second pass writes the row it already accepted");
  assert.equal(JSON.parse(readFileSync(blocked, "utf8")).entries.length, 1);
});

// ---- 9. the settle seam --------------------------------------------------------------------------------------------
test("the settle seam records a run's DELIVER line once, and pushes one ⇢ line onto the card", (t) => {
  const { tree, store, branch } = fixture(t);
  const harness = Object.create(Jobs.prototype);
  harness.deliverables = store;
  harness.push = (job, line) => job.lines.push(line);
  const job = { ...jobFor(tree), finalMessage: "All done.\n\nDELIVER file docs/report.html | The HTML report\n", lines: [] };
  const out = harness.harvestDeliverables(job, treeAt(tree, branch));
  assert.equal(out.added, 1);
  assert.equal(job.deliverHarvested, true);
  assert.equal(job.lines.length, 1);
  assert.match(job.lines[0].text, /^⇢ DELIVER file recorded: The HTML report$/);
  assert.deepEqual(job.delivered, { added: 1, updated: 0, refused: [] });
  // A second measure of the same message is a no-op: no second row, no second line.
  assert.equal(harness.harvestDeliverables(job, treeAt(tree, branch)), null);
  assert.equal(store.list().kept, 1);
  assert.equal(job.lines.length, 1);
});

test("a malformed line leaves the store empty and says so on the card", (t) => {
  const { tree, store } = fixture(t);
  const harness = Object.create(Jobs.prototype);
  harness.deliverables = store;
  harness.push = (job, line) => job.lines.push(line);
  const job = { ...jobFor(tree), finalMessage: "DELIVER doc docs/report.html | t", lines: [] };
  const out = harness.harvestDeliverables(job, treeAt(tree));
  assert.equal(out.parsed, 1);
  assert.equal(out.added, 0);
  assert.equal(store.list().kept, 0);
  assert.equal(job.lines.length, 1);
  assert.match(job.lines[0].text, /^⚠ DELIVER was NOT recorded — “doc” is not one of link \/ file \/ image$/);
});

test("an EMPTY final message does not close the door: the later one is harvested", (t) => {
  const { tree, store } = fixture(t);
  const harness = Object.create(Jobs.prototype);
  harness.deliverables = store;
  harness.push = (job, line) => job.lines.push(line);
  // The restored-live path: a job measured at boot has no final message yet, and is measured again when it settles.
  const job = { ...jobFor(tree), finalMessage: "", lines: [] };
  const boot = harness.harvestDeliverables(job, treeAt(tree));
  assert.equal(boot.parsed, 0);
  assert.equal(job.deliverHarvested, undefined, "the empty pass leaves the mark unset");
  job.finalMessage = "DELIVER file docs/report.html | The report";
  const settled = harness.harvestDeliverables(job, treeAt(tree));
  assert.equal(settled.added, 1);
  assert.equal(job.deliverHarvested, true);
});

test("a failed write leaves the harvest mark unset, so the next pass records it", (t) => {
  const { tree } = fixture(t);
  const dir = sandbox(t);
  const blocker = path.join(dir, "not-a-folder");
  writeFileSync(blocker, "in the way\n");
  const blocked = path.join(blocker, "deliverables.json");
  const store = new Deliverables({ file: blocked, log: () => {} });
  const harness = Object.create(Jobs.prototype);
  harness.deliverables = store;
  harness.push = (job, line) => job.lines.push(line);
  const job = { ...jobFor(tree), finalMessage: "DELIVER file docs/report.html | The report", lines: [] };
  const out = harness.harvestDeliverables(job, treeAt(tree));
  assert.equal(out.saved, false);
  assert.equal(job.deliverHarvested, undefined);
  assert.match(job.lines.at(-1).text, /^⚠ DELIVER was NOT recorded — /);
  rmSync(blocker);
  const retry = harness.harvestDeliverables(job, treeAt(tree));
  assert.equal(retry.saved, true);
  assert.equal(job.deliverHarvested, true);
  assert.equal(store.list().kept, 1);
});

// ---- 10. read-time resolution, and the click's key ------------------------------------------------------------------
test("a row follows a renamed tree by its six-hex tag, and keeps its stored origin when the tree is gone", (t) => {
  const { tree, store, branch } = fixture(t);
  store.record({ job: jobFor(tree), tree: treeAt(tree, branch), finalText: "DELIVER file docs/report.html | The report" });
  const moved = "C:/ProjectDevelopment/agent-worktree-gui/.worktrees/the-report-at-last-5db421";
  const provider = { trees: [{ project: "agent-worktree-gui", path: moved, branch: "wtgui/the-report-at-last-5db421" }] };
  const renamed = new Deliverables({ file: store.file, trees: () => provider.trees });
  const row = renamed.list().entries[0];
  assert.equal(row.treePath, moved);
  assert.equal(row.branch, "wtgui/the-report-at-last-5db421");
  assert.equal(row.tag, "5db421");
  // The tree is removed: what was recorded stands.
  provider.trees = [];
  const gone = renamed.list().entries[0];
  assert.equal(gone.treePath, tree.replace(/\\/g, "/"));
  assert.equal(gone.branch, branch);
});

test("the row carries the job id the click uses, and `turn` for display only", (t) => {
  const { tree, store } = fixture(t);
  store.record({ job: jobFor(tree, { id: "a1b2c3d4", turn: 3 }), tree: treeAt(tree), finalText: "DELIVER file docs/report.html | The report" });
  const [entry] = store.list().entries;
  assert.equal(entry.jobId, "a1b2c3d4");
  assert.equal(entry.turn, 3);
  assert.equal(store.get(1).target, entry.target, "the open route reads the store by seq");
  assert.equal(store.get(99), null);
});

test("the store's onChange fires once per new delivery and never for a repeat that changed nothing", (t) => {
  const { tree, store } = fixture(t);
  const seen = [];
  store.onChange = (entry) => seen.push({ seq: entry.seq, kind: entry.kind, title: entry.title, at: entry.at });
  const treeNow = treeAt(tree);
  store.record({ job: jobFor(tree, { id: "run-1" }), tree: treeNow, finalText: "DELIVER file docs/report.html | The report", now: at("2026-11-03T10:00:00.000Z") });
  store.record({ job: jobFor(tree, { id: "run-2", turn: 2 }), tree: treeNow, finalText: "DELIVER file docs/report.html | The report", now: at("2026-11-03T11:00:00.000Z") });
  assert.deepEqual(seen, [{ seq: 1, kind: "file", title: "The report", at: "2026-11-03T10:00:00.000Z" }]);
});

// ---- 11. the seen watermark ----------------------------------------------------------------------------------------
// The badge counts what arrived AFTER the reader last looked. That is one persisted number beside the entries — not a
// per-page flag and not a `seen` field on every row — so a restart, a second tab and a refreshed page agree, and a
// cleared badge cannot come back by itself.
test("a fresh store counts every row as unseen and has no watermark yet", (t) => {
  const { tree, store } = fixture(t);
  store.record({ job: jobFor(tree), tree: treeAt(tree), finalText: "DELIVER file docs/report.html | The report" });
  store.record({ job: jobFor(tree, { id: "run-2", turn: 2 }), tree: treeAt(tree), finalText: "DELIVER image docs/shot.png | The shot" });
  const list = store.list();
  assert.equal(list.seenSeq, 0);
  assert.equal(list.seenAt, null);
  assert.equal(list.unseenCount, 2, "never opened means both rows are new");
});

test("markSeen persists the watermark, never moves it backwards, and a fresh delivery re-lights it", (t) => {
  const { tree, store, file } = fixture(t);
  const treeNow = treeAt(tree);
  store.record({ job: jobFor(tree, { id: "run-1" }), tree: treeNow, finalText: "DELIVER file docs/report.html | The report" });
  const seen = store.markSeen(1, { now: at("2026-11-03T12:00:00.000Z") });
  assert.deepEqual(seen, { seenSeq: 1, seenAt: "2026-11-03T12:00:00.000Z", unseenCount: 0, moved: true, saved: true });
  // The file carries it beside the entries: the restart proof.
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(onDisk.seenSeq, 1);
  assert.equal(onDisk.seenAt, "2026-11-03T12:00:00.000Z");
  assert.equal(onDisk.entries.length, 1);
  // Older than the watermark is a no-op that still answers with the truth.
  const older = store.markSeen(0);
  assert.equal(older.moved, false);
  assert.equal(older.seenSeq, 1);
  assert.equal(older.unseenCount, 0);
  // A restart reads the cleared watermark back: it does not resurrect the badge.
  const reopened = new Deliverables({ file });
  assert.equal(reopened.list().seenSeq, 1);
  assert.equal(reopened.list().seenAt, "2026-11-03T12:00:00.000Z");
  assert.equal(reopened.list().unseenCount, 0);
  // A delivery ABOVE it re-lights exactly one row, never the row below.
  reopened.record({ job: jobFor(tree, { id: "run-2", turn: 2 }), tree: treeNow, finalText: "DELIVER link https://x.test/later | Later" });
  assert.equal(reopened.list().kept, 2);
  assert.equal(reopened.list().unseenCount, 1);
});

test("the watermark is clamped to the newest row, and a non-integer seq is refused", (t) => {
  const { tree, store } = fixture(t);
  store.record({ job: jobFor(tree), tree: treeAt(tree), finalText: "DELIVER file docs/report.html | The report" });
  const far = store.markSeen(9999);
  assert.equal(far.seenSeq, 1, "a page cannot claim a row the store never had");
  assert.equal(far.unseenCount, 0);
  const bad = store.markSeen("whenever");
  assert.match(bad.error, /`seq` must be the integer a deliverable's row carries/);
  assert.equal(store.list().seenSeq, 1, "a refused write changes nothing");
});

test("an empty store has no watermark, and marking it seen records nothing", (t) => {
  const { store, file } = fixture(t);
  const seen = store.markSeen(7);
  assert.equal(seen.seenSeq, 0);
  assert.equal(seen.seenAt, null);
  assert.equal(seen.moved, false);
  assert.equal(store.list().unseenCount, 0);
  assert.equal(existsSync(file), false, "no rows and no watermark means nothing was written");
});

test("POST /api/deliverables/seen is a token-carrying write beside the open, and the page drives both doors", () => {
  const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const at_ = server.indexOf('route === "/api/deliverables/seen"');
  assert.ok(at_ > 0, "POST /api/deliverables/seen is not wired");
  const block = server.slice(at_, server.indexOf('route === "/api/deliverables/open"', at_));
  assert.match(block, /req\.method === "POST"/);
  assert.match(block, /authorised\(req, config\.token\)/, "the token must be passed, not omitted");
  assert.match(block, /deliverables\.markSeen\(body\.seq\)/, "the watermark is the store's, keyed by the seq the page sent");
  assert.match(block, /seen\.error\) return sendJson\(res, 400/, "a non-integer seq is a 400, not a silent clear");
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /function deliverUnseenCount\(\)[\s\S]{0,200}?Number\(e\.seq\) > floor/, "the count is rows ABOVE the watermark");
  assert.match(app, /classList\.toggle\("has-unseen"/, "the highlight is a class, not an inline style");
  assert.match(app, /apiFetch\("\/api\/deliverables\/seen"/, "the page posts the watermark");
  assert.match(app, /\$\("deliver-badge"\)\?\.addEventListener\("click"[\s\S]{0,200}?deliverMarkSeen\(\)/, "the dismiss is the same mechanism");
  assert.match(app, /function openDeliverPop\(\)[\s\S]{0,900}?deliverMarkSeen\(\)/, "opening the list writes it too");
  assert.match(app, /aria-label[\s\S]{0,200}?new deliverable/, "the aria-label carries the number");
});


// ---- 12. the panel's wiring -----------------------------------------------------------------------------------------
// The two routes and the SSE frame are one-liners in server.js, and a one-liner is exactly what went missing: the
// button shipped over a backend that was never written. These read the wiring, so a route deleted or an authorisation
// slipped back to the one-argument form fails HERE rather than at a reader's first click.
test("server.js serves the list without a token, and opens with one (authorised(req, config.token))", () => {
  const source = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const getAt = source.indexOf('route === "/api/deliverables"');
  assert.ok(getAt > 0, "GET /api/deliverables is not wired");
  const getBlock = source.slice(getAt, source.indexOf('route === "/api/approvals"', getAt));
  assert.match(getBlock, /req\.method === "GET"/);
  assert.match(getBlock, /deliverables\.list\(\)/);
  assert.doesNotMatch(getBlock, /authorised\(/, "a read is not token-gated — the GET /api/jobs convention");

  const openAt = source.indexOf('route === "/api/deliverables/open"');
  assert.ok(openAt > 0, "POST /api/deliverables/open is not wired");
  const openBlock = source.slice(openAt, source.indexOf('route === "/api/jobs/artifact/delete"', openAt));
  assert.match(openBlock, /authorised\(req, config\.token\)/, "the token must be passed, not omitted (M1)");
  assert.doesNotMatch(openBlock, /authorised\(req\)/, "the one-argument form refuses every off-machine write");
  assert.match(openBlock, /deliverables\.get\(body\.seq\)/, "the target comes from the store, never from the page");
  assert.match(openBlock, /chromeFor\(entry\.target\)/, "a link goes to Chrome");
  assert.match(openBlock, /openerFor\(entry\.target\)/, "a file/image goes through the OS association");
  assert.match(openBlock, /markMissing\(entry\.seq\)/, "a file gone at click time is stamped");
});

test("the store's onChange is one SSE frame, and the page listens for exactly that event", () => {
  const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(
    server,
    /deliverables\.onChange[\s\S]{0,200}?broadcast\(\{\s*type: "deliverable", seq: entry\.seq, kind: entry\.kind, title: entry\.title, at: entry\.at\s*\}\)/,
    "the frame carries seq, kind, title and at, and nothing else",
  );
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /state\.es\.addEventListener\("deliverable"/, "the page re-reads the list on the frame");
});

test("chromeFor prefers %CHROME_PATH%, then the install roots, and says null when there is none", async () => {
  const { chromeFor } = await import("../lib/open-url.js");
  const env = { CHROME_PATH: "C:/chrome/chrome.exe", ProgramFiles: "C:/PF", "ProgramFiles(x86)": "C:/PF86", LOCALAPPDATA: "C:/LA" };
  eqBin(chromeFor("https://x.test/a", { platform: "win32", env, exists: (p) => p === "C:/chrome/chrome.exe" }), "C:/chrome/chrome.exe");
  const byPf86 = chromeFor("https://x.test/a", { platform: "win32", env, exists: (p) => /PF86/.test(p) && /chrome\.exe$/.test(p) });
  assert.ok(byPf86 && byPf86.bin.includes("PF86"), JSON.stringify(byPf86));
  assert.deepEqual(byPf86.args, ["https://x.test/a"], "one argv element, no flags");
  assert.equal(chromeFor("https://x.test/a", { platform: "win32", env, exists: () => false }), null, "no Chrome is the caller's fallback, not an error");
  assert.deepEqual(chromeFor("https://x.test/a", { platform: "linux" }), { bin: "google-chrome", args: ["https://x.test/a"] });
});

function eqBin(got, want, url = "https://x.test/a") {
  assert.ok(got, "no opener found");
  assert.equal(got.bin, want);
  assert.deepEqual(got.args, [url], "one argv element: the URL, no shell and no flags");
}
