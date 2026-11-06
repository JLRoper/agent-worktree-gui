// The provenance card every rendered report ends with.
//
// Two claims are pinned here. First, the card carries what a reader needs to follow a number back to its
// source: the report's title, the run and thread that generated it, the commit the panel was running, the
// generation time in UTC, and the command or file the figures came from, with at least one of those a
// working link. A field the renderer cannot establish says "unknown" rather than printing a blank or a
// guess.
//
// Second, the card IS the panel's clarify card. A report page is one self-contained file and cannot link
// public/style.css, so the rules are copied into lib/report-footer.js; the parity case below fails the
// moment the panel's own card changes, which is what keeps this a reuse rather than a second card style.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  REPORT_FOOTER_CSS,
  UNKNOWN,
  commitUrlFor,
  liveRunFor,
  reportFooter,
  resolveReportProvenance,
} from "../lib/report-footer.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STYLE = readFileSync(path.join(ROOT, "public", "style.css"), "utf8");

// The scp-style remote a clone of this repo carries, spelled in two pieces so the file holds no literal
// address: the renderer has to read that shape, and a test that only ever sees an https URL would miss it.
const AT = String.fromCharCode(64);
const SCP_REMOTE = `git${AT}github.com:JLRoper/agent-worktree-gui.git`;
const SSH_REMOTE = `ssh://git${AT}github.com/JLRoper/agent-worktree-gui.git`;

const FIELDS = {
  title: "Pipeline catalogue - v1.36.1",
  runId: "run_fe00a1edfef747618e0fa43c7cce5cf7",
  thread: "wtgui-make-every-html-report-end-w-43cec3",
  commit: "3ab0427",
  commitUrl: "https://github.com/JLRoper/agent-worktree-gui/commit/3ab0427",
  generatedAt: "2026-11-06T17:20:00Z",
  source: "node tools/render-pipelines.mjs reading pipelines.seed.json",
};

// The card's own rules, as the panel writes them: selector -> declarations, whitespace collapsed.
function rulesOf(css) {
  const out = new Map();
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.set(m[1].replace(/\s+/g, " ").trim(), m[2].replace(/\s+/g, " ").trim());
  }
  return out;
}

test("the card carries the title, the run, the thread, the commit, the UTC time and the source line", () => {
  const html = reportFooter(FIELDS);
  assert.match(html, /class="turn-question report-provenance"/);
  assert.match(html, /data-report-footer="1"/);
  assert.ok(html.includes(FIELDS.title), "the report title is on the card");
  assert.ok(html.includes(FIELDS.runId), "the run id is on the card");
  assert.ok(html.includes(FIELDS.thread), "the thread is on the card");
  assert.ok(html.includes(FIELDS.commit), "the commit is on the card");
  assert.ok(html.includes(FIELDS.generatedAt), "the generation time is on the card");
  assert.ok(html.includes("UTC"), "the generation time says which clock it is");
  assert.ok(html.includes(FIELDS.source), "the source line is on the card");
});

test("the commit is a link a reader can follow, and it is the card's one link", () => {
  const html = reportFooter(FIELDS);
  const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(links, [FIELDS.commitUrl]);
  assert.match(html, /<a href="https:\/\/github\.com\/JLRoper\/agent-worktree-gui\/commit\/3ab0427"/);
});

test("with no commit URL the run is the link instead, and with neither the card still reads", () => {
  const both = reportFooter({ ...FIELDS, runUrl: "http://127.0.0.1:7331/" });
  assert.deepEqual([...both.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((m) => m[1]), [FIELDS.commitUrl], "the commit wins the one link");
  const runOnly = reportFooter({ ...FIELDS, commitUrl: null, runUrl: "http://127.0.0.1:7331/" });
  assert.match(runOnly, /<a href="http:\/\/127\.0\.0\.1:7331\/"[^>]*>run_fe00a1edfef747618e0fa43c7cce5cf7<\/a>/);
  const bare = reportFooter({ ...FIELDS, commitUrl: null, runUrl: null });
  assert.equal((bare.match(/<a\b/g) || []).length, 0);
  assert.ok(bare.includes(FIELDS.commit), "the commit is still named, just not linked");
});

test("a field the renderer cannot establish says unknown, never a blank and never a guess", () => {
  const html = reportFooter({ title: "A report with nothing else known" });
  assert.equal((html.match(new RegExp(`>${UNKNOWN}<`, "g")) || []).length, 5, "run, thread, commit, time and source each say unknown");
  assert.ok(html.includes(">unknown<"), "the word is printed");
  assert.ok(!/class="tq-text"><\/span>/.test(html), "no value cell is empty");
  assert.ok(!/data-commit=""/.test(html), "no field is an empty attribute");
  assert.ok(html.includes("A report with nothing else known"));
});

test("the card's rules are the panel's clarify card, copied rule for rule", () => {
  const panel = rulesOf(STYLE);
  const card = rulesOf(REPORT_FOOTER_CSS);
  for (const selector of [".turn-question", ".tq-head", ".tq-question", ".tq-choices", ".tq-choice", ".tq-text", ".tq-note", ".tq-foot", ".tq-left"]) {
    assert.ok(panel.has(selector), `public/style.css still declares ${selector}`);
    assert.equal(card.get(selector), panel.get(selector), `${selector} is the panel's own rule, not a second style`);
  }
  const tint = /:root\s*\{[^}]*--q-line:[^}]*\}/.exec(STYLE.replace(/\/\*[\s\S]*?\*\//g, ""));
  assert.ok(tint, "the panel still declares the card's default tint");
  const vars = [...tint[0].matchAll(/--q-[a-z-]+:\s*[^;]+;/g)].map((m) => m[0].replace(/\s+/g, " ").trim());
  assert.ok(vars.length >= 15, `${vars.length} tint variables`);
  for (const decl of vars) assert.ok(REPORT_FOOTER_CSS.includes(decl), `the card carries ${decl}`);
});

test("commitUrlFor builds a commit page only for a host whose shape it knows", () => {
  assert.equal(commitUrlFor(SCP_REMOTE, "abc1234"), "https://github.com/JLRoper/agent-worktree-gui/commit/abc1234");
  assert.equal(commitUrlFor("https://github.com/JLRoper/agent-worktree-gui.git", "abc1234"), "https://github.com/JLRoper/agent-worktree-gui/commit/abc1234");
  assert.equal(commitUrlFor(SSH_REMOTE, "abc1234"), "https://github.com/JLRoper/agent-worktree-gui/commit/abc1234");
  assert.equal(commitUrlFor("https://bitbucket.org/team/repo.git", "abc1234"), "https://bitbucket.org/team/repo/commits/abc1234");
  assert.equal(commitUrlFor("https://git.example.test/team/repo.git", "abc1234"), null, "an unknown host is not guessed at");
  assert.equal(commitUrlFor("", "abc1234"), null);
  assert.equal(commitUrlFor(SCP_REMOTE, ""), null);
});

test("resolveReportProvenance reads the commit, the remote and the live run out of the tree", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-report-footer-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "probe");
  git("config", "user.email", "probe@localhost");
  writeFileSync(path.join(dir, "README.md"), "a tree to render from\n");
  git("add", "-A");
  git("commit", "-q", "-m", "the commit the panel was running");
  git("remote", "add", "origin", SCP_REMOTE);
  const sha = git("rev-parse", "HEAD");

  const jobsFile = path.join(dir, "jobs.json");
  writeFileSync(jobsFile, JSON.stringify({
    savedAt: new Date().toISOString(),
    jobs: [
      { id: "older", runId: "run_older", thread: "thread-older", cwd: dir, status: "running", startedAt: "2026-11-06T10:00:00.000Z" },
      { id: "61d14812", runId: "run_fe00a1edfef747618e0fa43c7cce5cf7", thread: "wtgui-make-every-html-report-end-w-43cec3", cwd: dir, status: "running", startedAt: "2026-11-06T17:04:47.305Z" },
      { id: "elsewhere", runId: "run_elsewhere", thread: "thread-elsewhere", cwd: path.join(dir, "..", "another-tree"), status: "running", startedAt: "2026-11-06T18:00:00.000Z" },
      { id: "settled", runId: "run_settled", thread: "thread-settled", cwd: dir, status: "done", startedAt: "2026-11-06T19:00:00.000Z" },
    ],
  }));

  const p = resolveReportProvenance({
    repo: dir,
    title: "A report",
    source: "node tools/render-pipelines.mjs reading pipelines.seed.json",
    now: new Date("2026-11-06T17:20:00.000Z"),
    jobsFile,
  });
  assert.equal(p.commit, sha.slice(0, 7));
  assert.equal(p.commitFull, sha);
  assert.equal(p.commitUrl, `https://github.com/JLRoper/agent-worktree-gui/commit/${sha}`);
  assert.equal(p.runId, "run_fe00a1edfef747618e0fa43c7cce5cf7", "the newest live run in THIS tree");
  assert.equal(p.thread, "wtgui-make-every-html-report-end-w-43cec3");
  assert.equal(p.generatedAt, "2026-11-06T17:20:00Z", "UTC, to the second");
  assert.equal(p.source, "node tools/render-pipelines.mjs reading pipelines.seed.json");

  const html = reportFooter(p);
  assert.ok(html.includes(`https://github.com/JLRoper/agent-worktree-gui/commit/${sha}`), "the card links the commit it read");
});

test("a tree with no live run, no remote and no store answers unknown rather than a guess", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-report-footer-bare-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = resolveReportProvenance({ repo: dir, title: "A report", source: "a command", jobsFile: path.join(dir, "missing.json") });
  assert.equal(p.commit, UNKNOWN, "no git history, no commit");
  assert.equal(p.commitUrl, null);
  assert.equal(p.runId, UNKNOWN);
  assert.equal(p.thread, UNKNOWN);
  assert.equal(p.runUrl, null);
  assert.equal(liveRunFor(dir, { jobsFile: path.join(dir, "missing.json") }), null);
  const html = reportFooter(p);
  assert.equal((html.match(/>unknown</g) || []).length, 3);
});

test("neither the card nor the module carries an em dash or an en dash", () => {
  const html = reportFooter(FIELDS);
  const source = readFileSync(path.join(ROOT, "lib", "report-footer.js"), "utf8");
  for (const [what, text] of [["the card", html], ["the module", source]]) {
    assert.equal((text.match(/\u2014/g) || []).length, 0, `${what} carries no em dash`);
    assert.equal((text.match(/\u2013/g) || []).length, 0, `${what} carries no en dash`);
  }
});
