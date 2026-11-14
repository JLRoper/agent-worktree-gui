// The reader's landing rules for ONE project: the field, the carry into every worker brief, and the carry into the
// board assistant's preamble.
//
// The two patterns these tests are written around are the real ones (see the sefl-branch-worktree and
// sefl-pull-request-format skills):
//
//   * a SEFL checkout lands ONE turnover branch: worker branches are cut from it, each is rolled back into it
//     LOCALLY, and only the turnover branch is ever pushed;
//   * this panel's own GitHub checkout lands a `wtgui/*` branch with `gh pr merge <n> --rebase --admin`.
//
// What is pinned, each one a way the carry could silently stop:
//
//   1. the module: absent, blank and non-string read as NO rules; a long text is capped; the project resolves by NAME
//      when a caller names it and by the TREE when it does not (a reply hands over a directory, not a project);
//   2. a brief for a project WITH rules carries them as a labelled paragraph, ahead of the work sentence;
//   3. a brief for a project WITHOUT rules carries nothing at all - no heading, no placeholder;
//   4. a REPLY that names no project still carries its tree's project rules, which is the path the panel's own
//      reply route takes;
//   5. the assistant's standing text carries each project's rules beside the standing rules, labelled per project,
//      and says so in one line when no project carries any.
//
// The brief is read off a stub Runs API that records what was actually POSTed: "what the worker reads" is the claim.
// This file is `lib/project-landing-rules.js`, NOT `lib/project-rules.js` - that one is the projects[].rules store
// the board's rules bar draws, and the two names are one character apart on disk and nothing alike in meaning.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Assistant } from "../lib/assistant.js";
import { PRIMARY_ASSISTANT } from "../lib/assistants.js";
import { Jobs } from "../lib/jobs.js";
import { ParentBook } from "../lib/parents.js";
import { PROJECT_RULES_MAX, projectForRun, projectRulesBrief, projectRulesOf, projectRulesPreambleLines } from "../lib/project-landing-rules.js";
import { configureRepo, git as runGit } from "../tools/panel-testkit.mjs";

// Off this box's own Hermes install: a run body is what is under test, and the developer's real session store is none
// of this suite's business. Set before any Jobs is constructed.
process.env.HERMES_HOME = mkdtempSync(path.join(tmpdir(), "wtgui-landing-rules-home-"));
process.env.API_SERVER_KEY = "";

const SEFL_RULES =
  "One turnover branch per feature, cut from master. Worker branches are cut from it and rolled back into it locally, never pushed. Only the turnover branch goes to the remote, and its pull request goes to master.";
const GITHUB_RULES =
  "One wtgui/* branch per worktree, cut from main. Push the branch, open one pull request, and land it with gh pr merge <n> --rebase --admin - never a merge commit and never a push to main.";

const git = (dir, args) => runGit(dir, args);

function makeRepo(tag = "repo") {
  const dir = mkdtempSync(path.join(tmpdir(), `wtgui-landing-${tag}-`));
  git(dir, ["init", "-q", "-b", "main"]);
  configureRepo(dir);
  writeFileSync(path.join(dir, "README.md"), `# ${tag}\n`);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "first"]);
  return dir;
}

const sweep = (...dirs) => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch {
      /* a background git handle on Windows; OS temp is throwaway */
    }
  }
};

// The smallest gateway that accepts a run and records its body (the shape test/git-brief.test.js uses).
async function stubGateway() {
  const submitted = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/v1/capabilities") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ version: "stub", features: { run_submission: true, run_events_sse: true } }));
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          submitted.push(JSON.parse(raw || "{}"));
        } catch {
          submitted.push({});
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ run_id: `stub-run-${submitted.length}`, status: "running" }));
      });
      return;
    }
    if (/^\/v1\/runs\/[^/]+\/events$/.test(url.pathname)) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(`event: run.completed\ndata: ${JSON.stringify({ event: "run.completed", output: "done", exit_code: 0 })}\n\n`);
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ run_id: "stub-run-0", status: "completed" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    submitted,
    last: () => String(submitted[submitted.length - 1]?.input || ""),
    stop: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

function makeJobs(dir, url, projects = []) {
  const jobs = new Jobs({
    config: { apiServer: { url }, jobsFile: path.join(dir, "logs", "jobs.json"), jobMaxRuntimeSeconds: 3600, projects },
    onEvent: () => {},
    onLog: () => {},
  });
  jobs.parents = new ParentBook({ file: path.join(dir, "logs", "parents.json") });
  jobs.dispose = () => {
    for (const j of jobs.jobs.values()) {
      clearTimeout(j.timer);
      clearTimeout(j.persistTimer);
      clearInterval(j.poller);
      clearInterval(j.statsTimer);
      try {
        j.ctrl?.abort();
      } catch {
        /* an aborted stream is the point */
      }
    }
    clearTimeout(jobs.persistTimer);
  };
  return jobs;
}

// ---- 1. the module -------------------------------------------------------------------------------------------

test("the field reads as one optional rules text, and a project resolves by name or by its tree", () => {
  assert.equal(projectRulesOf({}), "", "no key is no rules");
  assert.equal(projectRulesOf({ landingRules: "   " }), "", "blank is no rules");
  assert.equal(projectRulesOf({ landingRules: 42 }), "", "a number is not a rules text");
  assert.equal(projectRulesOf({ landingRules: `\n  ${SEFL_RULES}  \n` }), SEFL_RULES, "trimmed, newlines kept");
  const long = projectRulesOf({ landingRules: "r".repeat(PROJECT_RULES_MAX + 50) });
  assert.equal(long.length, PROJECT_RULES_MAX, "a long text is capped at the field's own maximum");
  assert.ok(long.endsWith("…"), "and the cap says so");

  const sefl = { name: "optym-integration-multi", path: "/repos/optym-integration-multi", landingRules: SEFL_RULES };
  const nested = { name: "inner", path: "/repos/optym-integration-multi/.nested", landingRules: "nested rules" };
  const gui = { name: "agent-worktree-gui", path: "/trees/agent-worktree-gui", landingRules: GITHUB_RULES };
  const projects = [sefl, nested, gui];

  assert.equal(projectForRun({ projects, name: "optym-integration-multi" }), sefl, "the name is the first answer");
  assert.equal(projectForRun({ projects, tree: "/trees/agent-worktree-gui/.worktrees/x-aaaaaa" }), gui, "a tree under a project resolves to it");
  assert.equal(projectForRun({ projects, tree: "\\trees\\agent-worktree-gui\\.worktrees\\x-aaaaaa" }), gui, "and the backslash spelling is the same tree");
  assert.equal(projectForRun({ projects, tree: "/repos/optym-integration-multi/.nested/tree" }), nested, "the longest matching root wins, so a nested project is not shadowed");
  assert.equal(projectForRun({ projects, name: "not-a-project", tree: "/elsewhere/tree" }), null, "nothing is guessed");

  assert.equal(projectRulesBrief({ name: "plain" }), "", "a project with no rules has no paragraph");
  const brief = projectRulesBrief(sefl);
  assert.match(brief, /^LANDING RULES FOR optym-integration-multi: /);
  assert.ok(brief.includes(SEFL_RULES), "the reader's words are carried verbatim, not summarised");
  assert.match(brief, /Follow them over the general landing paragraph above where the two differ/);
  assert.match(brief, /push guard still has the last word/, "the rules decide the branch shape, not the guard");

  assert.deepEqual(projectRulesPreambleLines([]), ["(none - no project carries landing rules)"]);
  const lines = projectRulesPreambleLines(projects);
  assert.equal(lines.length, 3, "one line per project that carries rules");
  assert.match(lines[0], /^- optym-integration-multi: One turnover branch/);
  assert.match(lines[2], /^- agent-worktree-gui: One wtgui\/\* branch/);
});

// ---- 2 and 3. the brief -------------------------------------------------------------------------------------

test("a worker's brief carries its project's rules, and a project without any carries nothing", async (t) => {
  const stub = await stubGateway();
  const withRules = makeRepo("with-rules");
  const withoutRules = makeRepo("without-rules");
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-landing-jobs-"));
  const jobs = makeJobs(dir, stub.url, [
    { name: "sefl-fixture", path: withRules.replace(/\\/g, "/"), landingRules: SEFL_RULES },
    { name: "plain-fixture", path: withoutRules.replace(/\\/g, "/"), landingRules: "   " },
  ]);
  t.after(async () => {
    jobs.dispose();
    await stub.stop();
    sweep(dir, withRules, withoutRules);
  });

  const carrying = await jobs.create({ prompt: "cut the turnover work", cwd: withRules, existing: false, project: "sefl-fixture" });
  assert.notEqual(carrying.status, "failed", `the run was accepted: ${carrying.error || ""}`);
  const body = stub.last();
  assert.ok(body.includes("LANDING RULES FOR sefl-fixture"), `the rules paragraph is in the brief:\n${body}`);
  assert.ok(body.includes(SEFL_RULES), "with the reader's own words in it");
  assert.ok(body.indexOf("LANDING RULES FOR sefl-fixture") < body.indexOf("Work in "), "it rides ahead of the work sentence, beside the landing paragraph");

  const bare = await jobs.create({ prompt: "no pattern here", cwd: withoutRules, existing: false, project: "plain-fixture" });
  assert.notEqual(bare.status, "failed", `the run was accepted: ${bare.error || ""}`);
  const bareBody = stub.last();
  assert.doesNotMatch(bareBody, /LANDING RULES/, `a project without rules gets no paragraph at all:\n${bareBody}`);
  assert.ok(bareBody.includes("Work in "), "and the rest of the brief is unchanged");
});

// ---- 4. the reply path, which names a tree and not a project --------------------------------------------------

test("a reply that names no project carries the rules of the tree it works in", async (t) => {
  const stub = await stubGateway();
  const repo = makeRepo("reply");
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-landing-reply-"));
  const jobs = makeJobs(dir, stub.url, [{ name: "sefl-fixture", path: repo.replace(/\\/g, "/"), landingRules: SEFL_RULES }]);
  t.after(async () => {
    jobs.dispose();
    await stub.stop();
    sweep(dir, repo);
  });

  // The shape the panel's reply route posts: a directory, a thread and no project name anywhere.
  const job = await jobs.create({ prompt: "Keep going", cwd: repo, ownerPath: repo, reply: true });
  assert.notEqual(job.status, "failed", `the reply was accepted: ${job.error || ""}`);
  const body = stub.last();
  assert.ok(body.includes("LANDING RULES FOR sefl-fixture"), `the reply is briefed like the first turn:\n${body}`);
  assert.ok(body.includes(SEFL_RULES));
});

// ---- 5. the assistant's standing text ------------------------------------------------------------------------

test("the assistant's standing text carries each project's rules beside the standing rules", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-landing-preamble-"));
  const assistantFile = path.join(dir, "assistant.json");
  writeFileSync(
    assistantFile,
    JSON.stringify({
      version: 2,
      settings: {},
      notes: "",
      rules: [{ id: "r1", text: "answer in one line", at: new Date().toISOString(), by: "reader" }],
      watches: [],
      alerts: [],
      journal: [],
    }),
  );
  let projects = [
    { name: "optym-integration-multi", path: "/repos/optym-integration-multi", landingRules: SEFL_RULES },
    { name: "plain-repo", path: "/repos/plain-repo" },
    { name: "agent-worktree-gui", path: "/repos/agent-worktree-gui", landingRules: GITHUB_RULES },
  ];
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile, charterFile: path.join(dir, "charter.md") },
    jobs: { list: () => [], firstOfThread: () => null, create: async (body) => ({ id: "job-1", ...body }) },
    getProjects: () => projects,
    getRows: () => [],
    onLog: () => {},
  });
  t.after(() => sweep(dir));

  const text = assistant.systemBriefing(PRIMARY_ASSISTANT);
  const standing = text.indexOf("Standing rules (written by the reader");
  const landing = text.indexOf("Per-project landing rules");
  assert.ok(standing >= 0, "the standing rules are there");
  assert.ok(landing > standing, "and the project rules sit beside them, after them");
  assert.match(text, /- optym-integration-multi: One turnover branch per feature/, "the SEFL pattern is labelled by project");
  assert.match(text, /- agent-worktree-gui: One wtgui\/\* branch per worktree/, "and the GitHub pattern reads differently");
  assert.doesNotMatch(text, /- plain-repo: /, "a project without rules has no line of its own");

  // A panel where nothing carries rules says so in one line, and still carries the heading's neighbours untouched.
  projects = [{ name: "plain-repo", path: "/repos/plain-repo" }];
  const bare = assistant.systemBriefing(PRIMARY_ASSISTANT);
  assert.match(bare, /Per-project landing rules[^\n]*\n\(none - no project carries landing rules\)/);
  assert.doesNotMatch(bare, /LANDING RULES FOR /, "no project rules, no paragraphs");
});
