// Two four-way controls, and the one rule that decides whether a push is asked about.
//
// The panel used to answer this with three overlapping settings: a global `remoteBranchPolicy`
// (local-only / allow / deny), a per-project `remoteBranchPolicy`, and a per-project
// `allowPushWithoutAsking` switch. That was three words for one question, and a reader could not tell which
// of them was in force. This module is the replacement: ONE pair of controls — one for a NEW branch, one for
// an EXISTING branch — with the same four values on both:
//
//   allow-all        a push goes through without asking.
//   allow-name-gate  a push goes through without asking ONLY when the branch name passes the gate the
//                    pre-push hook already enforces: the base branch (main/master), or
//                    YYYYMMDD_HHMM_<TICKET>_<desc>. A name that fails the gate parks on the permission box,
//                    which is what makes this value useful: it is "publish turnover work freely, ask about
//                    anything else".
//   always-ask       the push parks on the reader's permission box.
//   never            refused outright, no box. ABSOLUTE: it beats the project's own value, the repo's value,
//                    a repo force-override and the legacy keys. A reader who wrote `never` meant it.
//
// WHERE THE VALUES COME FROM, most specific first:
//
//   * a project's own `pushNewBranches` / `pushExistingBranches` (config.json's `projects[]`);
//   * the defaults for the remote REPOSITORY the project pushes to (`pushPermissions.repos[<key>]`), which
//     are what the Settings → Repo tab edits;
//   * the shipped default, `always-ask` — absence is never permission.
//
// A repo section can carry `force: true`, and then its values win over every project's own in that repo.
// `never` is the one thing force cannot beat; see `resolvePushPermissions`.
//
// THE NAME GATE LIVES HERE AND NOWHERE ELSE. `BRANCH_NAME_GATE_PATTERN` is the single string the resolver
// matches and the string the installed hook matches (`lib/push-guard.js` writes it into the guard's own
// `namegate` file at install/refresh, so the hook can grep it without a JS runtime). A second copy of the
// pattern — in the hook, in the page, in a test — is how the two halves come to disagree about which branch
// is named well enough to publish.

// The four values, in the order the page draws them. Exported because both the Settings tab and the card's
// selects must move with this list rather than carry a copy of it.
export const PUSH_CHOICES = ["allow-all", "allow-name-gate", "always-ask", "never"];
export const DEFAULT_PUSH_CHOICE = "always-ask";

// What each value means, in the reader's words. The same sentence is the option label on the card and in the
// Settings tab, so a select and the panel's help line cannot describe the value differently.
export const PUSH_CHOICE_LABELS = {
  "allow-all": "allow all — push without asking",
  "allow-name-gate": "allow the name gate — ask for anything else",
  "always-ask": "always ask — park on the box",
  never: "never — refuse, no box",
};

// The remote repositories the Settings tab carries a section for, in the order it draws them. `other` is every
// project whose remote is none of the named ones; `none` is a project with no remote at all (it can be given
// controls, and they decide nothing until a remote exists — the section says so rather than hiding the project).
export const PUSH_REPOS = [
  { key: "git.sefl.com/IT", label: "git.sefl.com/IT", host: "git.sefl.com", group: "IT" },
  { key: "git.sefl.com/SA", label: "git.sefl.com/SA", host: "git.sefl.com", group: "SA" },
  { key: "github/JLRoper", label: "github/JLRoper", host: "github.com", group: "JLRoper" },
  { key: "other", label: "any other remote" },
  { key: "none", label: "no remote at all" },
];
export const OTHER_REPO = "other";
export const NO_REMOTE_REPO = "none";
export const PUSH_REPO_KEYS = PUSH_REPOS.map((r) => r.key);

// THE gate, once. `main`/`master` are allowed by name (a base branch is not "work in progress"), and a
// turnover branch is the pipeline's own naming rule: the cut's local date and time, the ticket, lowercase
// words joined by underscores. This is the pattern `pipelines.seed.json` ships as the `branch-name` exit
// check, kept in step deliberately: a branch the pipeline accepts is a branch this gate accepts.
//
// WRITTEN IN THE PORTABLE SUBSET: this one string is compiled as a JS RegExp by the resolver AND handed to
// `grep -E` by the pre-push hook, so it must mean the same thing in both. That is why it says `[0-9]` and not
// `\d` — grep's ERE has no `\d`, and the two halves silently disagreeing about a branch name is the exact
// failure this constant exists to prevent.
export const BRANCH_NAME_GATE_PATTERN = "^[0-9]{8}_[0-9]{4}_[A-Z][A-Z0-9]+-[0-9]+_[a-z0-9._-]+$";
export const BASE_BRANCHES = ["main", "master"];
const NAME_GATE_RE = new RegExp(BRANCH_NAME_GATE_PATTERN);

// Would this branch name pass the gate the pre-push hook enforces? The hook asks the same question with
// `grep -qE "$(cat namegate)"` against the pattern above; that is why the pattern travels as a file rather
// than being written into the hook's source a second time.
export function branchNamePassesGate(name) {
  const branch = String(name || "")
    .trim()
    .replace(/^refs\/heads\//, "");
  if (!branch) return false;
  if (BASE_BRANCHES.includes(branch.toLowerCase())) return true;
  return NAME_GATE_RE.test(branch);
}

const CHOICE_SET = new Set(PUSH_CHOICES);

// A value read from a file is either one of the four or it is not a value. Anything else — "yes", "on", 1, a
// typo — falls back rather than guessing, the same rule the two switches it replaces used.
export function pushChoiceFrom(value, fallback = DEFAULT_PUSH_CHOICE) {
  const v = String(value ?? "").trim().toLowerCase();
  if (CHOICE_SET.has(v)) return v;
  return CHOICE_SET.has(String(fallback ?? "").trim().toLowerCase()) ? String(fallback).trim().toLowerCase() : DEFAULT_PUSH_CHOICE;
}

// The stated value, or null when the record does not state one — the difference between "the project said
// always-ask" and "nobody said" is what precedence is made of.
export function pushChoiceOrNull(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return CHOICE_SET.has(v) ? v : null;
}

// THE projects[] ROW, as the settings writer leaves it. Given the row the file already holds (or null) and the pair
// the route was asked to set, answer the row to store: the SAME row with only the keys the request named, or — for a
// project config.json does not name yet — `{ name }` plus those keys.
//
// A new row carries NO PATH, and that is the whole point of this function. The board keys a project by NAME, and
// discovery merges the row onto the repository it scanned by that name (`lib/projects.js`:
// `merged.push({ ...p, ...(explicit.get(name) || {}) })`), so the path is a fact the scan already owns. A path written
// here is a second copy of it — and the path of the ONE machine that wrote the file. It was also what broke this
// repo's gate: while config.json was tracked, tools/absolute-paths.mjs froze it at the paths it already carried, so
// the entry this route wrote made it over the count and landing one project's push setting meant deleting the path
// by hand.
//
// A row that ALREADY has a path keeps every field it had: this writer adds the two keys it was asked to set and never
// rewrites the rest of the record, so a file written before this rule keeps answering as it did.
export function projectPushRow(existing, name, patch = {}) {
  const row = existing && typeof existing === "object" ? existing : { name: String(name ?? "").trim() };
  if (patch?.newBranches !== undefined) row.pushNewBranches = pushChoiceFrom(patch.newBranches, DEFAULT_PUSH_CHOICE);
  if (patch?.existingBranches !== undefined) row.pushExistingBranches = pushChoiceFrom(patch.existingBranches, DEFAULT_PUSH_CHOICE);
  return row;
}

// ---- which remote repository is this? ---------------------------------------------------------------
// The page shows `host: sefl-bitbucket IT/email-multi` for a project; this is the same fact reduced to the
// repository SECTION a default belongs to. The three named ones are the repositories this box pushes to, and
// a URL parser here beats a hand-written list of project names: a new IT project must land in the IT section
// without anybody editing a table.
export function repoKeyForRemoteUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  const u = raw.replace(/\\/g, "/");
  // An explicit port is part of the HOST, not of the path: this box reaches the same server as both
  // `ssh://git@git.sefl.com/it/x.git` and `ssh://git@git.sefl.com:7999/it/x.git` (the Bitbucket port), and reading
  // the port as a path segment filed every `:7999` project under `other`, where no section could reach it.
  if (/(?:^|[@/])git\.sefl\.com(?::\d+)?[:/]+IT(?:\/|$)/i.test(u)) return "git.sefl.com/IT";
  if (/(?:^|[@/])git\.sefl\.com(?::\d+)?[:/]+SA(?:\/|$)/i.test(u)) return "git.sefl.com/SA";
  if (/(?:^|[@/])github\.com[:/]+JLRoper(?:\/|$)/i.test(u)) return "github/JLRoper";
  return OTHER_REPO;
}

// The section a PROJECT belongs to. `remoteUrl` is discovery's own read of the configured remote (lib/projects.js
// carries it); a project whose record predates that field is classified by its `prRepo` (GitHub) and otherwise
// lands in `other` while it still has a remote, and in `none` when it has neither.
export function repoKeyForProject(project) {
  const url = String(project?.remoteUrl || "").trim();
  if (url) return repoKeyForRemoteUrl(url);
  const prRepo = String(project?.prRepo || "").trim();
  if (prRepo && /^JLRoper\//i.test(prRepo)) return "github/JLRoper";
  const remote = String(project?.remote || "").trim();
  return remote ? OTHER_REPO : NO_REMOTE_REPO;
}

export function repoLabel(key) {
  return PUSH_REPOS.find((r) => r.key === key)?.label || key;
}

// ---- the legacy keys, read once and mapped ------------------------------------------------------------
// An install that never named the new controls keeps behaving as it did: `deny` meant never, `allow` (or the
// per-remote switch turned on) meant without asking, and local-only meant ask. This runs at READ time and
// writes nothing, so the old keys stay exactly where the reader put them and a downgrade still finds them.
export function legacyDefaults(gate = {}) {
  const policy = String(gate?.remoteBranchPolicy ?? "").trim().toLowerCase();
  if (policy === "deny") return { newBranches: "never", existingBranches: "never", stated: true };
  if (policy === "allow" || gate?.allowPushWithoutAsking === true) {
    return { newBranches: "allow-all", existingBranches: "allow-all", stated: true };
  }
  return { newBranches: DEFAULT_PUSH_CHOICE, existingBranches: DEFAULT_PUSH_CHOICE, stated: policy === "local-only" };
}

// A project's legacy answer, or null when it never gave one. The project's own `deny` is absolute, and its
// own `allow`/switch means both controls were "without asking".
export function legacyProjectChoices(project = {}) {
  const policy = String(project?.remoteBranchPolicy ?? "").trim().toLowerCase();
  if (policy === "deny") return { newBranches: "never", existingBranches: "never" };
  if (policy === "allow" || project?.allowPushWithoutAsking === true) return { newBranches: "allow-all", existingBranches: "allow-all" };
  if (policy === "local-only") return { newBranches: DEFAULT_PUSH_CHOICE, existingBranches: DEFAULT_PUSH_CHOICE };
  return null;
}

// ---- the resolver -------------------------------------------------------------------------------------
// One walk, both controls, and every scope that can speak about them. `forced` is reported for the PAGE (the
// card's selects render disabled and say why); the effective values are reported for the guard and for any
// reader that wants to know what a push would meet.
//
// `never` is handled AFTER the walk, deliberately: a project that says never must not be opened by a repo
// that forces allow-all, and a repo that says never must not be opened by a project that says allow-all.
export function resolvePushPermissions(project = {}, gate = {}) {
  const repo = repoKeyForProject(project);
  const repoRec = gate?.pushPermissions?.repos?.[repo] || {};
  const force = repoRec.force === true;
  const defaults = legacyDefaults(gate);
  const legacy = legacyProjectChoices(project);

  const projectNew = pushChoiceOrNull(project?.pushNewBranches) ?? legacy?.newBranches ?? null;
  const projectExisting = pushChoiceOrNull(project?.pushExistingBranches) ?? legacy?.existingBranches ?? null;
  const repoNew = pushChoiceOrNull(repoRec.newBranches);
  const repoExisting = pushChoiceOrNull(repoRec.existingBranches);

  const walk = (projectValue, repoValue, fallback) => {
    if (force && repoValue) return { choice: repoValue, source: "repo-force" };
    if (projectValue) return { choice: projectValue, source: "project" };
    if (repoValue) return { choice: repoValue, source: "repo" };
    return { choice: fallback, source: "default" };
  };

  const newWalk = walk(projectNew, repoNew, defaults.newBranches);
  const existingWalk = walk(projectExisting, repoExisting, defaults.existingBranches);

  // `never` is absolute. The source still names where the never came from, so the page can say which setting
  // refused a push instead of a bare "refused".
  const absolute = (walked, projectValue, repoValue, fallback) => {
    if (projectValue === "never") return { choice: "never", source: "project" };
    if (repoValue === "never") return { choice: "never", source: "repo" };
    if (fallback === "never") return { choice: "never", source: "default" };
    return walked;
  };

  const newFinal = absolute(newWalk, projectNew, repoNew, defaults.newBranches);
  const existingFinal = absolute(existingWalk, projectExisting, repoExisting, defaults.existingBranches);

  return {
    repo,
    repoLabel: repoLabel(repo),
    forced: force,
    // The repo section's own values (null when it states none), so the Settings tab can show what the toggle
    // would force and the card can name the repo's answer in its note.
    repoNewBranches: repoNew,
    repoExistingBranches: repoExisting,
    // The project's own values (null when it states none), so the page can show what a force-override is
    // replacing without pretending the project's answer went away.
    projectNewBranches: projectNew,
    projectExistingBranches: projectExisting,
    newBranches: newFinal.choice,
    existingBranches: existingFinal.choice,
    newSource: newFinal.source,
    existingSource: existingFinal.source,
    defaults,
    legacy: Boolean(defaults.stated || project?.remoteBranchPolicy || project?.allowPushWithoutAsking !== undefined || legacy),
  };
}

// What ONE branch meets: "allow" (go through), "ask" (park on the box), "refuse" (no box, no push).
// Exported because both the panel's routes and the tests ask this exact question, and a second matrix in a
// test would be a second rule.
export function branchPermission(choice, branch) {
  const c = pushChoiceFrom(choice);
  if (c === "allow-all") return "allow";
  if (c === "never") return "refuse";
  if (c === "allow-name-gate") return branchNamePassesGate(branch) ? "allow" : "ask";
  return "ask";
}

// The control that applies to a push of `branch`: a NEW branch is one the remote does not have yet. A caller
// that does not know (a hand-run hook with nothing on stdin) is answered as EXISTING — the more conservative
// control of the two only when the reader set them differently, and never a silent "new branch, allow-all".
export function permissionForPush(resolved, { branch = "", isNew = false } = {}) {
  const choice = isNew ? resolved?.newBranches : resolved?.existingBranches;
  return branchPermission(choice, branch);
}

// The branches in a git pre-push ref list ("<local ref> <local sha> <remote ref> <remote sha>" per line).
// A branch is NEW when the remote side carries no sha for it (all zeros, or empty); a deleted ref is not a
// push at all. The hook and the request route read the SAME list through this function, so "which control
// applies" cannot differ between the pre-check and the panel's answer.
export function branchesInPushRefs(refs) {
  const out = [];
  for (const line of String(refs || "").split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const [lref, lsha, , rsha] = parts;
    if (!lref || !lsha) continue;
    if (!lref.startsWith("refs/heads/")) continue;
    if (/^0+$/.test(lsha)) continue; // deleting the local ref: nothing goes to the remote
    const branch = lref.slice("refs/heads/".length);
    out.push({ branch, isNew: !rsha || /^0+$/.test(rsha) });
  }
  return out;
}

// The strictest of several answers: a push carrying three branches is allowed only when every one of them
// is. `never` on any branch refuses the whole push — a partial push is not a thing git offers.
const RANK = { allow: 0, ask: 1, refuse: 2 };
export function strictestPermission(list) {
  let worst = "allow";
  for (const p of list) if ((RANK[p] ?? 0) > RANK[worst]) worst = p;
  return worst;
}

// The push control a tree's project resolves to, for the panel's own decision paths (the request route and
// the merge flow). `branch` + `isNew` name the write being decided; without them the answer is the strictest
// of both controls, which is what a write whose ref is unknown has to be.
export function pushModeFor(resolved, { branch = "", isNew = null } = {}) {
  if (isNew === true || isNew === false) return permissionForPush(resolved, { branch, isNew });
  return strictestPermission([branchPermission(resolved?.newBranches, branch), branchPermission(resolved?.existingBranches, branch)]);
}
