// A SPAWN IN line used to be taken on trust: the path had to BE a directory, and the spawn was refused with
// "<path> does not exist or is not a directory" when it was not. But the panel renames a finished run's worktree
// directory AND its branch after the thread title (server.js `renameWorktree` — the slug is rebuilt from the
// title, the six-hex tag is kept), so the path the assistant wrote down when that worker finished is one rename
// out of date while the tree is still standing. Every SPAWN IN line pointing at it failed from then on.
//
//   node tools/verify-spawn-target.mjs
//
// This cuts a real worktree in a throwaway repo, renames it the way the panel does, and asks
// lib/spawn-target.js — the module server.js calls at BOTH doors that can start a worker in an existing tree
// (/api/assistant/spawn and /api/agents) — to find it again: by the stale path, by a branch, by the tag alone,
// and by the thread's slug. It also proves the two refusals are still refusals (nothing matched, and several
// matched), that the refusal for an unmatched path is word for word what the panel always said, and that the
// card a reader judged carries the answer: `addSpawnAlert` keeps the tree the line named (not the project root)
// and `startSpawn` writes the resolved tree onto that card.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Jobs } from "../lib/jobs.js";
import { Assistant, parseActions } from "../lib/assistant.js";
import { nameParts, resolutionNote, resolveExistingTarget } from "../lib/spawn-target.js";

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
};
const ok = (name, got) => check(name, Boolean(got), true);
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

const git = (repo, args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore", windowsHide: true });
const dirOf = (p) => String(p).replace(/\\/g, "/").split("/").filter(Boolean).pop();

const dir = mkdtempSync(path.join(tmpdir(), "spawn-target-"));
// No gateway listens on this port: a run posted here fails immediately, which is what the card-only assertions
// need — a card's lines are pushed before the request goes out.
// The constructor destructures its argument, so the config has to arrive UNDER `config`: a flat
// { jobsFile, apiServer } drops both keys, apiConfig falls back to the live gateway on 8642, and the
// create() at the bottom of this file then starts a REAL run in this throwaway tree that `finally`
// deletes a second later — an agent left standing in a directory that is gone.
const jobs = new Jobs({ config: { jobsFile: null, apiServer: { url: "http://127.0.0.1:9" } } });
const tmpLogs = path.join(dir, "logs");
mkdirSync(tmpLogs, { recursive: true });

try {
  // ---- a throwaway repo, and a worktree cut the way the panel cuts one ---------------------------
  const repo = path.join(dir, "throwaway");
  mkdirSync(repo, { recursive: true });
  mkdirSync(path.join(repo, ".worktrees"), { recursive: true });
  git(repo, ["init", "-q"]);
  writeFileSync(path.join(repo, "README.md"), "# throwaway\n");
  git(repo, ["add", "."]);
  git(repo, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "first"]);
  const project = { name: "throwaway", path: repo.replace(/\\/g, "/"), mainBranch: "main" };
  const projects = [project];

  const cut = await jobs.makeWorktree(repo, "in your working directory");
  const stale = cut.path;
  const tag = nameParts(stale).tag;
  check("the panel cut a worktree as <slug>-<tag>", [dirOf(stale).replace(/-[0-9a-f]{6}$/, ""), Boolean(tag)], ["in-your-working-director", true]);

  // ---- renamed the way renameWorktree renames one: the directory after the thread's title, the branch with
  //      it, and the SAME six-hex tag kept, because that is what tells two trees named alike apart ----------
  const renamed = path.join(repo, ".worktrees", `finish-the-report-${tag}`).replace(/\\/g, "/");
  git(repo, ["worktree", "move", stale, renamed]);
  git(repo, ["branch", "-m", cut.branch, `wtgui/finish-the-report-${tag}`]);
  check("the path the assistant recorded is gone", existsSync(stale), false);
  check("the tree the panel renamed is there", existsSync(renamed), true);

  // ---- the reported failure: a stale SPAWN IN path, resolved instead of refused ------------------
  const byPath = await resolveExistingTarget({ target: stale, project: null, projects });
  check("a stale path resolves to the renamed tree", [byPath.ok, same(byPath.path, renamed)], [true, true]);
  check("and the card is told why", byPath.how, `the six-hex tag ${tag} (a rename keeps it)`);
  check("the run says it was resolved", resolutionNote(byPath), `${stale} → ${renamed} (matched the six-hex tag ${tag} (a rename keeps it))`);
  check("the branch it is on comes back with it", byPath.branch, `wtgui/finish-the-report-${tag}`);

  // ---- a branch instead of a path: what a SPAWN IN line can carry now ----------------------------
  const byBranch = await resolveExistingTarget({ target: `wtgui/finish-the-report-${tag}`, projects });
  check("a branch names the tree", [byBranch.ok, same(byBranch.path, renamed), byBranch.resolved], [true, true, true]);
  check("and the card says what tied them", byBranch.how, `the branch wtgui/finish-the-report-${tag}`);

  const byOldBranch = await resolveExistingTarget({ target: cut.branch, project, projects });
  check("the branch name that was renamed away still finds it", [byOldBranch.ok, same(byOldBranch.path, renamed)], [true, true]);

  // A worktree directory name on its own (the assistant's report files name trees that way), and the tag alone —
  // the one part a rename keeps.
  const byName = await resolveExistingTarget({ target: `finish-the-report-${tag}`, project, projects });
  check("a bare worktree directory name finds it", [byName.ok, same(byName.path, renamed)], [true, true]);
  const byTag = await resolveExistingTarget({ target: tag, projects });
  check("the tag alone finds it", [byTag.ok, same(byTag.path, renamed)], [true, true]);

  // The thread whose slug named the tree, when a caller knows it: the same slug rule as a written-down name.
  const byThread = await resolveExistingTarget({ target: "nowhere-at-all", thread: `wtgui-finish-the-report-${tag}`, projects });
  check("the thread's slug finds it", [byThread.ok, same(byThread.path, renamed)], [true, true]);
  check("what the line said is what the card spells back", [byPath.asked, byThread.asked], [stale, "nowhere-at-all"]);

  // ---- several matches is a refusal that names them ----------------------------------------------
  const twinA = await jobs.makeWorktree(repo, "write the tests");
  const twinB = await jobs.makeWorktree(repo, "write the tests");
  const twinSlug = dirOf(twinA.path).replace(/-[0-9a-f]{6}$/, "");
  check("two trees cut from one prompt share a slug", twinSlug, dirOf(twinB.path).replace(/-[0-9a-f]{6}$/, ""));
  const ambiguous = await resolveExistingTarget({ target: twinSlug, project, projects });
  check("a slug that matches twice refuses", [ambiguous.ok, ambiguous.reason], [false, "ambiguous"]);
  check("and it names both candidates", ambiguous.candidates.map((c) => c.path).sort(), [twinA.path, twinB.path].sort());
  ok("the error carries the paths and their branches", ambiguous.error.includes(twinA.path) && /matches 2 worktrees/.test(ambiguous.error) && /\(wtgui\//.test(ambiguous.error));
  const exactName = await resolveExistingTarget({ target: twinB.path, project, projects });
  check("the full name of one of them resolves without being resolved", [exactName.ok, same(exactName.path, twinB.path), exactName.resolved], [true, true, false]);
  check("and nothing was picked for it", resolutionNote(exactName), "");

  // ---- nothing matched keeps the refusal the panel always gave ------------------------------------
  const gone = path.join(repo, ".worktrees", "never-existed-zzzzzz").replace(/\\/g, "/");
  const nothing = await resolveExistingTarget({ target: gone, project, projects });
  check("an unmatched path is still refused", [nothing.ok, nothing.reason], [false, "missing"]);
  check("word for word as before", nothing.error, `${path.resolve(gone)} does not exist or is not a directory`);
  check("with no candidates invented", nothing.candidates, []);
  const nonsense = await resolveExistingTarget({ target: "no-such-tree-or-branch", projects });
  check("an unmatched name says what it looked for", [nonsense.ok, nonsense.error], [false, "no-such-tree-or-branch is not a directory, a worktree directory name, or a branch of any known project"]);
  // A path that belongs to no configured project cannot be placed in a repository, and a worktree list is per
  // repository: that is a refusal, not a name match inside somebody else's repo.
  const outside = path.join(dir, "outside", `finish-the-report-${tag}`).replace(/\\/g, "/");
  const elsewhere = await resolveExistingTarget({ target: outside, projects });
  check("a path outside every project is refused rather than guessed", [elsewhere.ok, elsewhere.error], [false, `${path.resolve(outside)} does not exist or is not a directory`]);
  check("an empty target is refused with its own reason", (await resolveExistingTarget({ target: "  ", projects })).reason, "empty");
  // The tree is verified as a directory on the way out, so a worktree list that has gone stale cannot start a run.
  const lies = await resolveExistingTarget({ target: stale, projects, listTrees: () => [{ path: path.join(dir, "vanished"), branch: `wtgui/finish-the-report-${tag}` }] });
  check("a listed tree that is not there refuses", [lies.ok, lies.reason], [false, "missing"]);
  check("no refusal ever came back as a start-anyway", [nothing.ok, ambiguous.ok, nonsense.ok, lies.ok, elsewhere.ok], [false, false, false, false, false]);

  // ---- the assistant's own lines -----------------------------------------------------------------
  const acts = parseActions("SPAWN IN wtgui/finish-the-report-abc123 | carry on in that tree");
  check("a SPAWN IN line may name a branch", acts.spawn[0], { target: "wtgui/finish-the-report-abc123", existing: true, prompt: "carry on in that tree" });
  check("a SPAWN IN path is still a path", parseActions(`SPAWN IN ${stale} | carry on`).spawn[0].target, stale);

  const assistant = new Assistant({
    config: { jobsFile: path.join(tmpLogs, "jobs.json"), defaultCwd: repo, assistantFile: path.join(tmpLogs, "assistant.json") },
    jobs: { list: () => [] },
    getProjects: () => projects,
    spawner: async (spec) => ({
      id: "job1",
      thread: "wtgui-finish-the-report",
      origin: { kind: "assistant-spawn", where: "existing", resolvedFrom: spec.target, resolvedPath: byPath.path, resolvedHow: byPath.how },
    }),
  });
  const alert = assistant.addSpawnAlert(parseActions(`SPAWN IN ${stale} | finish the work in that tree`).spawn[0]);
  check("the card carries the tree the line named, not the project root", alert.spawn.target, stale);
  await assistant.startSpawn(assistant.pendingSpawn(alert.id), { alertId: alert.id });
  const card = assistant.alerts.find((x) => x.id === alert.id);
  check("the card says which tree was picked", card.evidence[card.evidence.length - 1], { label: "resolved to", value: byPath.path });
  ok("and why it picked that one", card.detail.includes(`${stale} no longer exists — started in ${byPath.path}`));
  check("the card is closed against its run", [card.status, card.startedJob, card.thread], ["done", "job1", "wtgui-finish-the-report"]);
  ok("the journal names the tree it actually ran in", assistant.journal.filter((j) => j.kind === "spawned")[0].text.includes(byPath.path));

  // ---- the same answer on the run's own card ------------------------------------------------------
  const run = await jobs.create({ prompt: "finish the work", cwd: renamed, existing: true, ownerPath: renamed, ownerPending: false, note: `SPAWN IN ${resolutionNote(byPath)}` });
  check("the run's card leads with the resolution", run.lines[0].text, `SPAWN IN ${resolutionNote(byPath)}`);
  check("then the request it sent", run.lines[1].text.startsWith("POST "), true);
  check("and the run really was in the tree that was picked", same(run.cwd, renamed), true);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `RESULT: ${failed} FAILED` : "RESULT: ALL PASS");
process.exit(failed ? 1 : 0);
