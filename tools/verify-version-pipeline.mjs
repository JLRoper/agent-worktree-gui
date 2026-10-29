// Prove the version-bump pipeline end to end, in a throwaway repo of its own: the advice (suggest), the gate
// (check), the write (apply), and the pre-push hook that calls the gate — including a real `git push` into a
// real bare remote, refused while the branch is unbumped and allowed once the bump is committed.
//
// Nothing here touches the panel's own package.json: the sandbox has its own, starting at 1.0.0.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PANEL_VERSION_BEFORE = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")).version;
const results = [];

const tmp = mkdtempSync(path.join(os.tmpdir(), "wtgui-version-"));
const WORK = path.join(tmp, "work");
const REMOTE = path.join(tmp, "remote.git");
mkdirSync(WORK, { recursive: true });

// The hook shells out to `node`, so the push must run with the interpreter that is running this harness on PATH.
const env = { ...process.env, VERSION_NO_GH: "1", PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}` };

const git = (args, opts = {}) => spawnSync("git", args, { cwd: opts.cwd || WORK, encoding: "utf8", env, windowsHide: true });
const tool = (args) => spawnSync(process.execPath, [path.join(WORK, "tools", "version.mjs"), ...args], { cwd: WORK, encoding: "utf8", env, windowsHide: true });
const out = (r) => `${r.stdout || ""}${r.stderr || ""}`;
const write = (rel, text) => { const p = path.join(WORK, rel); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, text); };

function step(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
}

function commit(rel, text, subject) {
  write(rel, text);
  git(["add", "--", rel]);
  return git(["commit", "-q", "-m", subject]);
}

const version = () => JSON.parse(readFileSync(path.join(WORK, "package.json"), "utf8")).version;

try {
  // A repo with one commit on main, published to a bare remote, with this repo's hooks installed and the tool
  // copied in beside them — the pipeline as it runs for real.
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "harness@example.invalid"]);
  git(["config", "user.name", "version harness"]);
  git(["config", "core.autocrlf", "false"]);
  write("package.json", `{\n  "name": "sandbox",\n  "version": "1.0.0",\n  "private": true\n}\n`);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "Add the package manifest so the version has one home"]);
  spawnSync("git", ["init", "-q", "--bare", REMOTE], { encoding: "utf8", env, windowsHide: true });
  git(["remote", "add", "github", REMOTE]);
  git(["push", "-q", "-u", "github", "main"]);

  mkdirSync(path.join(WORK, ".githooks"), { recursive: true });
  mkdirSync(path.join(WORK, "tools"), { recursive: true });
  for (const h of ["commit-msg", "pre-push"]) {
    copyFileSync(path.join(REPO, ".githooks", h), path.join(WORK, ".githooks", h));
    chmodSync(path.join(WORK, ".githooks", h), 0o755);
  }
  copyFileSync(path.join(REPO, "tools", "version.mjs"), path.join(WORK, "tools", "version.mjs"));
  git(["config", "core.hooksPath", ".githooks"]);

  // ---- a branch that carries a doc, a feature, and one commit with no prefix at all ------------------
  git(["checkout", "-q", "-b", "work"]);
  commit("docs/notes.md", "the layout\n", "docs: describe how the panel reads its own layout");
  commit("feature.js", "export const chip = 1;\n", "feat(board): add a reattach chip for a restored run");
  commit("notes.txt", "tidy\n", "Tidy the worktree row");

  const dirtyBefore = git(["status", "--porcelain"]).stdout;
  const suggest = tool(["suggest"]);
  const suggestText = out(suggest);
  step("suggest exits 0 (advice, not a refusal)", suggest.status === 0, `exit=${suggest.status}`);
  step("suggest prints the level the commits read as", /suggested level: minor/.test(suggestText), suggestText.split("\n").find((l) => l.startsWith("suggested")));
  step("suggest gives a reason per commit", /docs:.*patch|patch/.test(suggestText) && /feat\(board\)/.test(suggestText), "per-commit lines present");
  step("suggest says so when a prefix is missing", /no conventional-commit prefix/.test(suggestText), "Tidy the worktree row reported unclassified");
  step("suggest writes nothing", git(["status", "--porcelain"]).stdout === dirtyBefore && version() === "1.0.0", "tree and version unchanged");

  const checkFail = tool(["check"]);
  const checkFailText = out(checkFail);
  step("check refuses an unbumped branch (non-zero)", checkFail.status !== 0, `exit=${checkFail.status}`);
  step("check names the commits it counted", /docs: describe/.test(checkFailText) && /feat\(board\)/.test(checkFailText) && /Tidy the worktree row/.test(checkFailText), "all three commits listed");
  step("check names the version it compared", /1\.0\.0 — unchanged from github\/main/.test(checkFailText), "package.json: 1.0.0 — unchanged from github/main");
  step("check suggests a level and calls it advice", /would suggest: minor/.test(checkFailText) && /advice/.test(checkFailText), "suggested minor");
  step("check wrote nothing", version() === "1.0.0", `package.json still ${version()}`);

  // ---- the push gate: a real push into a real bare remote --------------------------------------------
  const pushRefused = git(["push", "github", "work"]);
  const pushRefusedText = out(pushRefused);
  step("pre-push refuses a real push of an unbumped branch", pushRefused.status !== 0, `exit=${pushRefused.status}`);
  step("the refusal is legible", /pre-push: refused — work would go out with no version bump/.test(pushRefusedText) && /node tools\/version\.mjs apply/.test(pushRefusedText), pushRefusedText.split("\n").slice(0, 3).join(" | "));
  step("nothing reached the remote", (git(["ls-remote", "github", "refs/heads/work"]).stdout || "").trim() === "", "refs/heads/work absent on the remote");

  // ---- apply writes the one place the version lives ---------------------------------------------------
  const apply = tool(["apply", "minor"]);
  const applyText = out(apply);
  step("apply writes the level asked for", apply.status === 0 && version() === "1.1.0", `exit=${apply.status}, version=${version()}`);
  step("apply prints the old and the new value", /1\.0\.0 -> 1\.1\.0/.test(applyText), applyText.split("\n")[1]);
  const changed = git(["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  step("apply changed only package.json", changed.length === 1 && changed[0] === "package.json", `git diff --name-only -> ${changed.join(", ")}`);
  const hookSrc = readFileSync(path.join(REPO, ".githooks", "pre-push"), "utf8");
  const invocations = hookSrc.match(/node "\$TOOL"[^\n]*/g) || [];
  step("the hook invokes the tool with check, never apply", invocations.length === 1 && /check/.test(invocations[0]), invocations.join(" | "));

  // ---- the bump in the same branch: check is quiet, the push is allowed -------------------------------
  git(["add", "--", "package.json"]);
  git(["commit", "-q", "-m", "Bump the version to 1.1.0 for the reattach chip, a new capability"]);
  const checkPass = tool(["check"]);
  step("check is silent and zero on an already-bumped branch", checkPass.status === 0 && out(checkPass).trim() === "", `exit=${checkPass.status}, output=${JSON.stringify(out(checkPass))}`);

  const pushAllowed = git(["push", "github", "work"]);
  step("pre-push allows the same push once bumped", pushAllowed.status === 0, `exit=${pushAllowed.status}`);
  step("the bump is on the remote", /refs\/heads\/work/.test(git(["ls-remote", "github", "refs/heads/work"]).stdout || ""), "refs/heads/work present");

  // ---- a push that carries no new commits is not gated ------------------------------------------------
  const pushAgain = git(["push", "github", "work"]);
  step("an up-to-date push is silent", pushAgain.status === 0, `exit=${pushAgain.status}`);

  // ---- deletions and tags are not the hook's business -------------------------------------------------
  const pushDelete = git(["push", "github", ":work"]);
  step("a deletion push is allowed", pushDelete.status === 0, `exit=${pushDelete.status}`);
  step("a deletion really deleted the ref", (git(["ls-remote", "github", "refs/heads/work"]).stdout || "").trim() === "", "refs/heads/work gone");
  git(["tag", "-f", "v9.9.9"]);
  const pushTag = git(["push", "github", "v9.9.9"]);
  step("a tag push is not the hook's business", pushTag.status === 0, `exit=${pushTag.status}`);

  // ---- a branch with no commits of its own is never asked to bump -------------------------------------
  git(["checkout", "-q", "main"]);
  const checkMain = tool(["check"]);
  step("check is quiet on a branch with no commits", checkMain.status === 0 && out(checkMain).trim() === "", `exit=${checkMain.status}, output=${JSON.stringify(out(checkMain))}`);

  // ---- the prefixes, one branch each ------------------------------------------------------------------
  git(["checkout", "-q", "-b", "breaking", "main"]);
  commit("store.js", "export const FORMAT = 2;\n", "feat!: drop the flat job store for the record format");
  const breaking = out(tool(["suggest"]));
  step("a ! prefix reads as major", /suggested level: major/.test(breaking), breaking.split("\n").find((l) => l.startsWith("suggested")));

  git(["checkout", "-q", "main"]);
  git(["checkout", "-q", "-b", "breaking-body", "main"]);
  commit("store.js", "export const FORMAT = 2;\n", "fix: read the record format the store now writes");
  write("store.js", "export const FORMAT = 3;\n");
  git(["add", "--", "store.js"]);
  git(["commit", "-q", "-m", "fix: read the record format the store now writes\n\nBREAKING CHANGE: the flat job store is no longer read"]);
  const breakingBody = out(tool(["suggest"]));
  step("a BREAKING CHANGE: line reads as major", /suggested level: major/.test(breakingBody), breakingBody.split("\n").find((l) => l.startsWith("suggested")));

  git(["checkout", "-q", "main"]);
  git(["checkout", "-q", "-b", "patchy", "main"]);
  commit("chart.js", "export const columns = 9;\n", "fix: stop the chart squeezing ten columns onto one row");
  const patchy = out(tool(["suggest"]));
  step("a fix prefix reads as patch", /suggested level: patch/.test(patchy), patchy.split("\n").find((l) => l.startsWith("suggested")));

  git(["checkout", "-q", "main"]);
  git(["checkout", "-q", "-b", "unprefixed", "main"]);
  commit("misc.txt", "x\n", "Tidy the worktree row and the chart legend");
  const none = out(tool(["suggest"]));
  step("a branch of unclassified commits suggests no level", /suggested level: none/.test(none), none.split("\n").find((l) => l.startsWith("suggested")));

  // ---- apply is deliberate: a bad level is refused, and none of this wrote the panel's own version -----
  const badLevel = tool(["apply", "huge"]);
  step("apply refuses a level that is not part of the scale", badLevel.status !== 0, `exit=${badLevel.status}`);
  const noArgs = tool(["apply"]);
  step("apply with no level is refused", noArgs.status !== 0, `exit=${noArgs.status}`);
  step("the panel's own package.json was never touched", JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")).version === PANEL_VERSION_BEFORE, `still ${PANEL_VERSION_BEFORE}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ steps: results.length, passed: results.length - failed.length, failed }, null, 2));
console.log(failed.length ? "VERIFY-VERSION-BUMP-FAILED" : "VERIFY-VERSION-BUMP-OK");
process.exit(failed.length ? 1 : 0);
