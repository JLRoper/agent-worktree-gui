// throwaway: reproduce the fixture and print what the backfill sees
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { backfillCandidates, resolveParents, ticketIds } from "../lib/parents.js";

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: GIT_ENV, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).replace(/\r\n/g, "\n").trim();
const commit = (repo, f, t, m) => { writeFileSync(path.join(repo, f), t); git(repo, "add", f); git(repo, "commit", "-q", "-m", m); return git(repo, "rev-parse", "HEAD"); };

const root = mkdtempSync(path.join(tmpdir(), "probe-"));
const repo = path.join(root, "repo");
mkdirSync(repo);
git(repo, "init", "-q", "-b", "master");
git(repo, "config", "user.email", "x@y.z");
git(repo, "config", "user.name", "x");
commit(repo, "a.txt", "one\n", "one");
const tree = (b, ref = "master") => { const wt = path.join(repo, ".worktrees", b); git(repo, "worktree", "add", "-q", "-b", b, wt, ref); return wt; };
const parentWt = tree("dmr-77-turnover");
commit(parentWt, "turn.txt", "turnover\n", "turnover base");
const cutWt = tree("dmr-77-child-cut", "dmr-77-turnover");
commit(cutWt, "cut.txt", "cut\n", "cut");
const guessWt = tree("dmr-77-child-guess", "dmr-77-turnover");
commit(guessWt, "guess.txt", "guess\n", "guess");

const branches = git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n");
console.log("branches", branches);
console.log("tickets guess", ticketIds("dmr-77-child-guess"));
console.log("merged-into guess:", git(repo, "for-each-ref", "--merged", "dmr-77-child-guess", "--format=%(refname:short)", "refs/heads"));
console.log("candidates guess:", JSON.stringify(await backfillCandidates(repo, "dmr-77-child-guess", branches), null, 1));
const resolved = await resolveParents({ repoDir: repo, branches, records: new Map(), mainBranch: "master" });
for (const [b, r] of resolved) console.log(b, "->", r.parent, r.parentSource, r.why || "");
