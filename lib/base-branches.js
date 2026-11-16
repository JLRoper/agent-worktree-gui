// A project's base branches: the list a row picks ITS OWN base out of.
//
// WHY. The board compared every row of a project against one ref - `<remote>/<mainBranch>`, built by
// lib/base-ref.js. That is right for a repository with one landing branch, and wrong for a fleet whose environments
// are long-lived branches of their own: fleet-kafka has no `main` at all, only `dev`, `qa`, `uat` and `prod`, so the
// single-ref rule resolved nothing and EVERY fleet-kafka row read NO BASE REF, with no ahead/behind at all. The
// verdict column was not measuring the work; it was measuring the absence of a branch the project never had.
//
// WHERE IT LIVES. `projects[].baseBranches` in `config.json`, beside `remote` and `mainBranch`. Each entry is a
// branch and the ENVIRONMENT it serves:
//
//   "baseBranches": [
//     { "branch": "dev",  "env": "dev" },
//     { "branch": "qa",   "env": "qa" },
//     { "branch": "uat",  "env": "uat" },
//     { "branch": "prod", "env": "prod" }
//   ]
//
// Reading is FORGIVING (a hand-edited file still boots the panel): a plain list of names reads each name as its own
// environment (`["dev", "qa"]`), and an object reads env -> branch (`{"dev": "origin/dev"}`). `env` is only ever a
// label used to MATCH a tree; the branch is what git is asked about. A branch written `origin/dev` is read as `dev`
// and qualified with the project's resolved remote, so one spelling of the ref is built (lib/base-ref.js).
//
// THE RESOLUTION ORDER IS PER ROW, in this file's `rowBaseCandidates()`:
//
//   1. the tree's recorded PARENT branch (lib/parents.js), when that parent is one of this project's base branches
//      (matched by branch name first, then by the environment its name carries). A tree cut from `dev` measures
//      against `origin/dev` even if its own name says nothing.
//   2. the project's list matched on the ENVIRONMENT carried by the tree's branch name, then by the tree's
//      directory name - `fleet-kafka-qa`, branch `fix-login-qa`, `release/uat` all name their environment.
//   3. today's single base (`<remote>/<mainBranch>`) as the fallback, so a project with no list behaves exactly as
//      it did before this file existed.
//
// A parent that is NOT a base of this project is skipped on purpose: a tree cut from an ordinary feature branch, or
// from a turnover branch, must still be measured against the base its work would LAND on, and `MERGED` against a
// sibling feature branch would be a false claim about main. The environment match and the fallback cover it.
//
// A row whose own base is missing is that row's problem, never the project's: the scan tries each candidate ref in
// order and only the row that runs out says NO BASE REF, so one deleted environment branch cannot blank the column
// for every tree of the project.

// A branch name, not a sentence: refs can hold almost anything, but a config value with a space or a quote is a
// hand-editing mistake, and putting it in a `git rev-list` argument is worse than ignoring it.
const BRANCH_OK = /^[A-Za-z0-9._/@{}^~+-]+$/;
const MAX_BRANCH = 120;
const MAX_ENV = 32;

const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();

// `release/prod` names the environment `prod`; `dev` names `dev`. Used only when an entry states no `env`.
export function envOfBranchName(name) {
  const parts = clean(name).split("/").filter(Boolean);
  return lower(parts[parts.length - 1] || "");
}

// The list, as the rest of the panel reads it: `[{ branch, env }]`, deduped by branch, in the reader's order.
// Anything unrecognisable is dropped rather than guessed at, because a wrong branch here would move a row's verdict.
export function baseBranchesFrom(value) {
  const out = [];
  const add = (branch, env) => {
    const b = clean(branch).replace(/^refs\/heads\//, "");
    if (!b || b.length > MAX_BRANCH || !BRANCH_OK.test(b)) return;
    if (out.some((entry) => lower(entry.branch) === lower(b))) return;
    const label = clean(env).slice(0, MAX_ENV);
    out.push({ branch: b, env: label ? lower(label) : envOfBranchName(b) });
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") add(item, null);
      else if (item && typeof item === "object") add(item.branch ?? item.ref ?? item.name, item.env ?? item.label ?? item.environment);
    }
  } else if (value && typeof value === "object") {
    // `{ "dev": "origin/dev" }`: the KEY is the environment, the value the branch.
    for (const [env, branch] of Object.entries(value)) {
      if (typeof branch === "string") add(branch, env);
      else if (branch && typeof branch === "object") add(branch.branch ?? branch.ref ?? branch.name, branch.env ?? env);
    }
  }
  return out;
}

// Which environment a piece of text names, as the rightmost matching word. Tokens are alphanumeric runs, so
// `fleet-kafka-prod`, `release/uat` and `fix-qa-2` are read without a substring rule that would match `dev` inside
// `devops`. A digit suffix counts (`dev2`, `qa2`), because that is how a second environment of the same name is
// usually written; a letter suffix does not.
export function envIn(text, bases) {
  const list = Array.isArray(bases) ? bases : [];
  const tokens = lower(text).split(/[^a-z0-9]+/).filter(Boolean);
  let best = null;
  for (const entry of list) {
    const env = lower(entry?.env);
    if (!env) continue;
    const shaped = new RegExp(`^${env.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[0-9]*$`);
    for (let i = tokens.length - 1; i >= 0; i -= 1) {
      if (!shaped.test(tokens[i])) continue;
      if (!best || i > best.index) best = { env, index: i };
      break;
    }
  }
  return best;
}

// The row's own environment: the branch name first, then the tree's directory name. The branch is the fact the
// panel already treats as the row's identity, so when the two disagree (a `dev` branch inside a folder called
// `...-prod`) the branch wins.
export function envOfRow({ branch = "", treeName = "", bases = [] } = {}) {
  const inBranch = envIn(branch, bases);
  if (inBranch) return { ...inBranch, where: "branch" };
  const inTree = envIn(treeName, bases);
  if (inTree) return { ...inTree, where: "tree" };
  return null;
}

// The branch part of a ref, given the remote it was qualified with. Only the resolved remote is stripped: a branch
// may itself contain a slash (`feature/x`), so the first path segment is not a remote by definition.
export function branchOfRef(ref, remote = null) {
  const r = clean(ref).replace(/^refs\/heads\//, "");
  const name = clean(remote);
  if (name && r.startsWith(`${name}/`)) return r.slice(name.length + 1);
  return r;
}

// The verdict word for a row that stands ON its own base. `ON MAIN` keeps its meaning for the project's main branch,
// because several readers (removal, spawn reuse, the summary) already key on that word; a row standing on `origin/dev`
// says `ON BASE` instead of claiming to be on a main branch the project may not even have.
export function onBaseVerdict({ branch, baseBranch, mainBranch = null }) {
  const b = clean(branch);
  if (!b || b !== clean(baseBranch)) return null;
  return mainBranch && b === clean(mainBranch) ? "ON MAIN" : "ON BASE";
}

// Every `ON MAIN` / `ON BASE` reader wants the same question answered: does this row stand on its own base?
export function isOnBase(verdict) {
  const v = clean(verdict);
  return v === "ON MAIN" || v === "ON BASE";
}

// The ordered candidate bases for ONE row, without a repository: the scan asks git whether each ref exists. Pure, so
// the order itself is testable (test/base-branches.test.js) and so the same answer can be explained in a tooltip.
export function rowBaseCandidates({
  bases = [],
  parent = null,
  branch = "",
  treeName = "",
  remote = null,
  mainBranch = null,
  fallbackRef = null,
} = {}) {
  const list = baseBranchesFrom(bases);
  const byBranch = (name) => list.find((entry) => lower(entry.branch) === lower(name));
  // One spelling of a ref: the branch as configured, qualified with the resolved remote when the project has one.
  // A branch already written `origin/dev` is not prefixed twice.
  const qualify = (name) => {
    const b = clean(name);
    const prefix = clean(remote);
    if (!prefix) return b;
    return b.startsWith(`${prefix}/`) ? b : `${prefix}/${b}`;
  };
  const out = [];
  const seen = new Set();
  const add = (ref, { source, entry = null, why = "" }) => {
    const r = clean(ref).replace(/^refs\/heads\//, "");
    if (!r || seen.has(lower(r))) return;
    seen.add(lower(r));
    out.push({
      ref: r,
      branch: entry ? branchOfRef(entry.branch, remote) : branchOfRef(r, remote),
      env: entry?.env || null,
      source,
      why,
    });
  };

  // 1. The recorded parent, when this project has it as a base.
  const parentName = branchOfRef(parent, remote);
  if (parentName && lower(parentName) !== lower(branchOfRef(branch, remote))) {
    const direct = byBranch(parentName) || (mainBranch && lower(parentName) === lower(mainBranch) ? { branch: clean(mainBranch), env: null } : null);
    if (direct) {
      add(qualify(direct.branch), { source: "parent", entry: direct, why: `this tree was cut from ${parentName}` });
    } else {
      const inherited = envIn(parentName, list);
      const entry = inherited ? list.find((candidate) => lower(candidate.env) === inherited.env) : null;
      if (entry) {
        add(qualify(entry.branch), {
          source: "parent",
          entry,
          why: `this tree was cut from ${parentName}, which carries the ${entry.env} environment`,
        });
      }
    }
  }

  // 2. The environment this row's branch or folder name carries.
  const hit = envOfRow({ branch, treeName, bases: list });
  if (hit) {
    const entry = list.find((candidate) => lower(candidate.env) === lower(hit.env));
    if (entry) {
      add(qualify(entry.branch), {
        source: "env",
        entry,
        why: `the ${hit.where} name carries the ${entry.env} environment`,
      });
    }
  }

  // 3. Today's single base, unchanged for every project that names no list.
  add(fallbackRef, { source: "default", why: "the project's single base" });
  return out;
}
