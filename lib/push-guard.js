// The pre-push guard: the only half of "local only" that a worker's shell cannot decide to ignore for free.
//
// A brief line is advice — the panel cannot see inside a worker's shell. A git hook CAN stand between the worker
// and the remote, so the panel installs one into every worktree it cuts:
//
//   * the hook lives in `<git-common-dir>/wtgui-hooks/` — inside .git, so it is not a tracked file and cannot
//     show up in the worktree's own `git status`;
//   * it is ENABLED per worktree (`git config --worktree core.hooksPath <dir>` under
//     `extensions.worktreeConfig=true`), so the reader's own checkout and every other tree keep the hooks they
//     had. This panel's own repo gates commits with a tracked `.githooks/commit-msg`, and taking a whole clone's
//     hooks path would silently switch that off — which is why the guard dir is filled with SHIMS that run each
//     hook the worktree had before, with the same arguments;
//   * a push it refuses can REQUEST a grant: the hook posts to the panel, the panel draws its own permission box,
//     and the hook waits for the answer. That is what makes the granted path work end to end instead of being a
//     wall.
//
// What it is NOT, and this is the honest half: `git push --no-verify`, `git -c core.hooksPath= push`, a push from
// a tree the panel did not cut, or WTGUI_PUSH_GRANT=1 all go around it. It is a speed bump on the DEFAULT path,
// not a lock — see the report for what a determined worker can still get past.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const pexec = promisify(execFile);

export const GUARD_DIR_NAME = "wtgui-hooks";
// 2: the chained hook may be named relative to the tree (a tracked .githooks/pre-push), and a repo that ships one is
// chained even when it never set core.hooksPath. A tree installed at version 1 carries the old hook text and the old
// empty chain, so a re-install is what puts the repository's own gate back in the push path there.
export const GUARD_VERSION = 2;
// Line endings, built rather than written: this file is stored CRLF, and the hook it emits is stored LF.
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const CRLF = CR + LF;
// The names the guard writes itself. Anything else found in the worktree's previous hooks dir gets a shim.
const OURS = new Set(["pre-push", "panel", "timeout", "policy", "landing", "chain", "wtgui-guard.json", "README"]);

const gitOut = async (cwd, args, timeout = 20000) => {
  try {
    const { stdout } = await pexec("git", ["-C", cwd, ...args], { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return String(stdout || "").replace(/\r\n/g, "\n").trim();
  } catch {
    return null;
  }
};

// One spelling for a tree path, whether it came from git in the native `C:/x` form or from a hook that ran under
// git's own shell in the MSYS `/c/x` form. Grants are keyed on this, so the two must not be two different trees.
export function normTree(p) {
  let s = String(p || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  // `/c/Users/…` and `c:/Users/…` are the same directory on this box; a hook asking about one must match a grant
  // recorded for the other.
  s = s.replace(/^\/([a-z])\//, "$1:/");
  return s;
}

export function guardPaths(commonDir) {
  const dir = path.join(commonDir, GUARD_DIR_NAME);
  return {
    dir,
    config: path.join(dir, "wtgui-guard.json"),
    panel: path.join(dir, "panel"),
    timeout: path.join(dir, "timeout"),
    policy: path.join(dir, "policy"),
    landing: path.join(dir, "landing"),
    // The pre-push this worktree had before the guard took its hooks path, chained rather than shadowed.
    chain: path.join(dir, "chain"),
  };
}

// The git dir every worktree of a clone shares — where a guard that covers the whole clone can live without ever
// touching a tracked file.
export async function commonDirOf(projectPath) {
  const raw = await gitOut(projectPath, ["rev-parse", "--git-common-dir"]);
  if (!raw) return null;
  return path.resolve(projectPath, raw.replace(/\\/g, "/"));
}

// What this worktree's hooks path was BEFORE the guard: an absolute path, so a shim can run it from anywhere.
// A relative `core.hooksPath` (this repo's `.githooks`) resolves against the worktree root — measured: a push from
// a linked worktree does NOT find `<main-checkout>/.githooks`, it looks in its own tree — so that is what is
// resolved here, and a configured dir that does not exist falls back to git's own `<git-dir>/hooks`.
//
// A clone that ships its hooks in a TRACKED `.githooks/` dir and never ran the one-line install that points
// `core.hooksPath` at it (this repository's own state) has NO configured hooks path, so git itself runs
// `<git-dir>/hooks` — the sample hooks — and the tracked gate is not in any push's path at all. Reading only the
// config therefore reported "this worktree had no pre-push" for a repository that ships one, and the guard's
// promise (taking a worktree's hooks path must not be a way to skip the repo's own gate) was false for every
// tree the panel cut. The tracked dir IS the hooks this tree already had; it is chained like any other.
export async function previousHooksDir({ projectPath, worktree }) {
  const common = await commonDirOf(projectPath);
  const fallback = common ? path.join(common, "hooks") : null;
  const tracked = trackedHooksDir(worktree || projectPath);
  const configured = await gitOut(worktree || projectPath, ["config", "--get", "core.hooksPath"]);
  if (!configured) return tracked || fallback;
  const abs = path.isAbsolute(configured) ? configured : path.resolve(worktree || projectPath, configured);
  if (common && normTree(abs) === normTree(guardPaths(common).dir)) {
    // RE-INSTALL: a tree that already carries the guard has the GUARD'S OWN dir as its hooks path. Reading that as
    // "the hooks this worktree had before the panel took them" would shim every hook the guard owns onto itself —
    // a commit-msg that execs itself, forever — and one install covers the whole clone, so that is every worktree
    // of it. The dir the guard replaced is in its record instead, so a second install writes the same shims as the
    // first, and the guard's own dir can never be recorded as its own predecessor.
    const rec = guardRecord(common);
    const recorded = rec && rec.previousHooksPath ? rec.previousHooksPath : null;
    if (recorded && normTree(recorded) !== normTree(guardPaths(common).dir)) {
      // A recorded path INSIDE the tree that installed it is that tree's tracked hooks dir, and this record is
      // shared by every worktree of the clone — so for any other tree it names somebody else's copy. This tree's
      // own tracked dir is the same relative path with the same meaning, so it wins; for a version gate the
      // difference is which package.json gets read.
      const sibling = rec.worktree && normTree(rec.worktree) !== normTree(worktree || projectPath) && normTree(recorded).startsWith(`${normTree(rec.worktree)}/`);
      if (!(sibling && tracked)) {
        try {
          if (statSync(recorded).isDirectory()) return recorded.replace(/\\/g, "/");
        } catch {
          /* the recorded dir is gone: the fallback below is the honest answer */
        }
      }
    }
    return tracked || fallback;
  }
  try {
    if (statSync(abs).isDirectory()) return abs.replace(/\\/g, "/");
  } catch {
    /* configured but absent: git would silently run no hooks at all, which is what the fallback is for */
  }
  return tracked || fallback;
}

// The hooks a repository SHIPS in a tracked `.githooks/` dir, when it has one with a real hook in it. Only a dir
// holding at least one hook counts: an empty or docs-only `.githooks` is not a hooks path, and treating it as one
// would shim nothing and chain nothing while claiming a predecessor. The guard's own file names are NOT excluded
// here — this dir is the repository's, not the guard's, and `pre-push` is exactly the hook this exists to find.
function trackedHooksDir(tree) {
  if (!tree) return null;
  const dir = path.join(tree, ".githooks");
  let names;
  try {
    if (!statSync(dir).isDirectory()) return null;
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const hooks = names.filter((n) => !n.endsWith(".sample") && !n.startsWith(".") && !n.endsWith(".md"));
  if (!hooks.length) return null;
  return dir.replace(/\\/g, "/");
}

// How a chained hook is NAMED in the guard's chain file. A hook inside the worktree is written RELATIVE, because
// the guard dir — and so its chain file — is shared by every worktree of the clone: an absolute path recorded by
// whichever tree installed last would make a push from any other tree run THAT tree's copy of the hook. For a
// version gate that is not a cosmetic difference, it reads the other tree's package.json and either refuses a
// bumped branch or blesses an unbumped one. The hook resolves a relative entry against the tree doing the pushing.
export function chainEntry(tree, file) {
  const root = normTree(tree).replace(/\/+$/, "");
  const abs = String(file || "").replace(/\\/g, "/");
  if (!abs) return "";
  const norm = normTree(abs);
  if (norm === root) return "";
  if (norm.startsWith(`${root}/`)) return abs.slice(root.length + 1);
  return abs;
}

// The dir the guard replaced, as the guard's own record remembers it: what a RE-install has to read, because once
// the guard is in, that tree's configured hooks path is the guard's dir, which is not a "previous" hooks dir.
function guardRecord(common) {
  if (!common) return null;
  try {
    return JSON.parse(readFileSync(guardPaths(common).config, "utf8"));
  } catch {
    return null;
  }
}

function recordedPreviousHooks(common) {
  const record = guardRecord(common);
  const prev = String(record?.previousHooksPath || "").trim();
  return prev || null;
}

const shimFor = (target) =>
  `#!/bin/sh
# wtgui guard shim — the hook this worktree had before the panel's push guard took its hooks path.
# The guard installs these so that enabling itself never switches off a hook somebody else added.
exec "${target}" "$@"
`;

// The guard itself. Plain POSIX sh, because that is what git runs a hook with, and no JSON parsing: every fact it
// needs is a one-word file written beside it, so a shell script can read it without a parser.
export const guardScript = () => `#!/bin/sh
# wtgui pre-push guard — installed by the worktree panel (see lib/push-guard.js).
#
# A worktree the panel cut is LOCAL ONLY unless the reader allowed a remote write for it. This hook asks the panel,
# which draws its own permission box (Allow once / this session / Always allow / Deny), and waits for the answer.
# Nothing is pushed before that answer arrives.
#
# This is a speed bump, not a lock: \`git push --no-verify\`, \`git -c core.hooksPath= push\`, a push from a checkout
# the panel did not cut, or WTGUI_PUSH_GRANT=1 all go around it.
set -u

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
panel=$(cat "$here/panel" 2>/dev/null || true)
timeout_s=$(cat "$here/timeout" 2>/dev/null || echo 300)
policy=$(cat "$here/policy" 2>/dev/null || echo local-only)
refs=$(cat 2>/dev/null || true)

# Two spellings of one path: "show" is what a reader sees, "norm" is what a grant is matched on.
show() {
  printf '%s' "$1" | tr '\\\\' '/'
}

norm() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr '\\\\' '/' | sed -e 's|/*$||' -e 's|^/\\([a-z]\\)/|\\1:/|'
}

refuse() {
  echo "" >&2
  echo "wtgui LOCAL-ONLY: refusing to push from $(show "$top")" >&2
  echo "  reason: $1" >&2
  echo "  nothing was pushed and the remote is unchanged." >&2
  echo "  what to do: answer the panel's permission box (it says which tree is asking), or push deliberately with" >&2
  echo "    WTGUI_PUSH_GRANT=1 git push ...    (no panel involved — your own call, nothing is asked)" >&2
  echo '  the setting that decides this: Settings > Branches on the remote — config.json remoteBranchPolicy, or the' >&2
  echo '    policy this PROJECT carries (projects[].remoteBranchPolicy), which wins over the global one.' >&2
  echo "" >&2
  exit 1
}

# DEFINED HERE, ABOVE THE FIRST CALL TO IT, AND THAT IS THE WHOLE POINT: sh reads a script top-down and does
# NOT hoist function definitions. With allow_push defined below the WTGUI_PUSH_GRANT=1 branch, that branch
# dies with "allow_push: command not found" and falls straight through to the ask-the-panel path — printing
# "no permission was asked" while it asks, then parking the push for the guard's whole window. Every path
# below that allows a push calls this, so it has to exist before the first of them runs.
#
# The pre-push this worktree ALREADY had, if the panel found one when it installed the guard (this repo ships its own
# at .githooks/pre-push, a version gate). It is chained from every path that allows a push, so taking the worktree's
# hooks path never switches off a hook somebody else added — and ITS refusal is this hook's refusal.
chain=$(cat "$here/chain" 2>/dev/null || true)
# A chain entry may be RELATIVE to the tree being pushed: a tracked .githooks/pre-push is the same path in every
# worktree, but this file is shared by all of them, so an absolute path would make a push from one tree run another
# tree's copy of the hook — and a version gate run that way reads the OTHER tree's package.json. Resolved here,
# against the tree doing the pushing.
case "$chain" in
  ""|/*|[A-Za-z]:/*) : ;;
  *) chain="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/$chain" ;;
esac
allow_push() {
  if [ -n "$chain" ] && [ -f "$chain" ]; then
    if [ -n "$refs" ]; then
      printf '%s\\n' "$refs" | run_chain
    else
      run_chain < /dev/null
    fi
    rc=$?
    if [ "$rc" -ne 0 ]; then
      echo "wtgui: the pre-push hook this worktree already had refused this push (exit $rc) — this is not the guard's refusal" >&2
      exit "$rc"
    fi
  fi
  exit 0
}

run_chain() {
  if [ -x "$chain" ]; then
    "$chain"
  else
    sh "$chain"
  fi
}

if [ "\${WTGUI_PUSH_GRANT:-}" = "1" ]; then
  echo "wtgui: push guard bypassed by WTGUI_PUSH_GRANT=1 — no permission was asked." >&2
  allow_push
fi

if [ "$policy" = "allow" ]; then
  allow_push
fi

top=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
norm_top=$(norm "$top")
branch=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null || echo "")
remote=$(git remote 2>/dev/null | head -1 || true)
remote_url=""
if [ -n "$remote" ]; then
  remote_url=$(git remote get-url "$remote" 2>/dev/null || true)
fi

if [ -f "$here/landing" ]; then
  if grep -qxF "$norm_top" "$here/landing" 2>/dev/null; then
    allow_push
  fi
fi

if [ "$policy" = "deny" ]; then
  refuse "the policy in force for this project refuses remote writes outright (remoteBranchPolicy: deny)"
fi

ask_supported=1
if [ -z "$panel" ]; then ask_supported=0; fi

curl_bin=""
for c in curl /mingw64/bin/curl /usr/bin/curl /usr/local/bin/curl; do
  if command -v "$c" >/dev/null 2>&1; then curl_bin="$c"; break; fi
done
if [ -z "$curl_bin" ]; then ask_supported=0; fi

if [ "$ask_supported" = "0" ]; then
  if [ -z "$panel" ]; then
    refuse "this guard has no panel to ask (it was installed without one)"
  fi
  refuse "the panel could not be reached to ask — no curl on PATH, or no answer from $panel"
fi

safe() {
  [ -z "$1" ] && return 0
  printf '%s' "$1" | tr -d '"\\\\' | tr '\\n\
' '  ' | cut -c1-300
}

body=$(printf '{"worktree":"%s","branch":"%s","remote":"%s","remoteUrl":"%s","refs":"%s"}' \\
  "$(safe "$norm_top")" "$(safe "$branch")" "$(safe "$remote")" "$(safe "$remote_url")" "$(safe "$refs")")

answer=$(curl -fsS -m 10 -X POST -H "Content-Type: application/json" -d "$body" "$panel/api/remote-write/request" 2>/dev/null || true)
if [ -z "$answer" ]; then
  refuse "the panel at $panel did not answer (is it running?)"
fi
if printf '%s' "$answer" | grep -q '"allowed":true'; then
  allow_push
fi
id=$(printf '%s' "$answer" | sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p')
if [ -z "$id" ]; then
  refuse "the panel answered something this guard could not read"
fi
echo "" >&2
echo "wtgui LOCAL-ONLY: $norm_top is waiting on the panel's permission box for a push of $branch to $remote." >&2
echo "  the panel is asking now: Allow once / this session / Always allow / Deny (id $id)." >&2
echo "  this push is parked until it is answered — up to \${timeout_s}s." >&2
echo "" >&2

i=0
while [ "$i" -lt "$timeout_s" ]; do
  sleep 1
  i=$((i + 1))
  st=$(curl -fsS -m 10 "$panel/api/remote-write/status?id=$id" 2>/dev/null || true)
  choice=$(printf '%s' "$st" | sed -n 's/.*"choice":"\\([a-z]*\\)".*/\\1/p')
  case "$choice" in
    once|session|always)
      echo "wtgui: the panel granted this push ($choice) — going ahead." >&2
      allow_push
      ;;
    deny)
      refuse "the permission box was answered with Deny (or was never answered)"
      ;;
  esac
done
refuse "nobody answered the permission box within \${timeout_s}s"
`;

// Install (or refresh) the guard for ONE worktree. Idempotent: the same call twice leaves one guard, and any hook
// the worktree gained in the meantime gets a shim on the next install.
export async function installGuard({ projectPath, worktree, panelUrl, timeoutSeconds = 300, policy = "local-only", landing = [], log = () => {} }) {
  const tree = worktree || projectPath;
  const common = await commonDirOf(projectPath || tree);
  if (!common) return { ok: false, error: `cannot find the git dir of ${projectPath || tree}` };
  const paths = guardPaths(common);
  const prev = await previousHooksDir({ projectPath: projectPath || tree, worktree: tree });
  try {
    mkdirSync(paths.dir, { recursive: true });
  } catch (e) {
    return { ok: false, error: `cannot create ${paths.dir}: ${String((e && e.message) || e)}` };
  }

  // 1. The guard's own files. LF on disk, always: this file is a POSIX shell script inside .git, git runs it with
  // sh, and a CRLF shebang or a CR at the end of a line is not executable — this checkout stores source as CRLF,
  // so the line endings the script is BUILT from are not the ones it is allowed to have.
  writeFileSync(path.join(paths.dir, "pre-push"), guardScript().split(CRLF).join(LF), { encoding: "utf8" });
  writeFileSync(paths.panel, `${String(panelUrl || "").trim()}\n`, "utf8");
  writeFileSync(paths.timeout, `${Math.max(30, Number(timeoutSeconds) || 300)}\n`, "utf8");
  writeFileSync(paths.policy, `${policy}\n`, "utf8");
  writeFileSync(paths.landing, `${(landing || []).map(normTree).filter(Boolean).join("\n")}\n`, "utf8");
  // The worktree's own pre-push, if it had one, is CHAINED (the guard runs it from every path that allows a push)
  // rather than shadowed: this repository ships a version gate at .githooks/pre-push, and taking a worktree's hooks
  // path must not be a way to skip it. It is named RELATIVE when it lives inside the worktree, because this one
  // chain file is shared by every worktree of the clone (see chainEntry).
  const prevPrePushFile = prev && existsSync(path.join(prev, "pre-push")) ? path.join(prev, "pre-push") : "";
  const prevPrePush = prevPrePushFile ? chainEntry(tree, prevPrePushFile) : "";
  writeFileSync(paths.chain, `${prevPrePush}\n`, "utf8");

  // 2. A shim per hook the worktree had before, so taking its hooks path changes nothing else.
  const shims = [];
  if (prev && existsSync(prev)) {
    for (const name of readdirSync(prev)) {
      if (OURS.has(name) || name.endsWith(".sample")) continue;
      const target = path.join(prev, name);
      try {
        if (!statSync(target).isFile()) continue;
      } catch {
        continue;
      }
      // LF for the shim too: it is a shell script git execs (see the note on the guard's own file above).
      writeFileSync(path.join(paths.dir, name), shimFor(target.replace(/\\/g, "/")).split(CRLF).join(LF), { encoding: "utf8" });
      shims.push(name);
    }
  }
  // A re-install that no longer needs a shim takes it away. Every file in this dir that is not one of the guard's
  // own was written here by an earlier install, and a leftover is not harmless: git runs it on every commit, and
  // one left pointing back at this same dir execs itself, forever.
  const stale = readdirSync(paths.dir).filter((name) => !OURS.has(name) && !name.endsWith(".sample") && !shims.includes(name));
  for (const name of stale) {
    try {
      rmSync(path.join(paths.dir, name), { force: true });
    } catch {
      /* a file held open is not a reason to fail the install; the record below still names the real shims */
    }
  }
  writeFileSync(
    paths.config,
    `${JSON.stringify({ version: GUARD_VERSION, project: projectPath || null, worktree: tree, previousHooksPath: prev, installedAt: new Date().toISOString(), shims }, null, 2)}\n`,
    "utf8",
  );

  // 3. Point THIS worktree's hooks path at the guard. `extensions.worktreeConfig` has to be on for a per-worktree
  //    value to exist at all; it is one line of repo config and it changes nothing by itself.
  const enable = await gitOut(tree, ["config", "extensions.worktreeConfig", "true"]);
  if (enable === null && !(await gitOut(tree, ["config", "--get", "extensions.worktreeConfig"]))) {
    return { ok: false, error: "could not enable extensions.worktreeConfig" };
  }
  const set = await gitOut(tree, ["config", "--worktree", "core.hooksPath", paths.dir.replace(/\\/g, "/")]);
  if (set === null) return { ok: false, error: `could not set core.hooksPath for ${tree}` };
  log(`push guard: ${tree} now runs ${paths.dir} (previous hooks: ${prev || "none"}; shims: ${shims.join(", ") || "none"})`);
  return { ok: true, dir: paths.dir.replace(/\\/g, "/"), previous: prev, shims, version: GUARD_VERSION };
}

// Undo the per-worktree half. The guard directory itself is left in place: it belongs to the clone and another
// worktree may still be using it (the record of which ones names them).
export async function uninstallGuard({ worktree, log = () => {} }) {
  const set = await gitOut(worktree, ["config", "--worktree", "--unset", "core.hooksPath"]);
  // `--unset` exits 5 with no output when there was nothing to remove; that is not a failure.
  // Read the WORKTREE's own value back, not the effective one: a clone that sets a hooks path repo-wide (this
  // repo's `.githooks`) keeps reading a value after the guard's own key is gone, and that is the point of the undo.
  const own = await gitOut(worktree, ["config", "--worktree", "--get", "core.hooksPath"]);
  if (own) return { ok: false, error: `this worktree still has its own core.hooksPath (${own})` };
  const now = await gitOut(worktree, ["config", "--get", "core.hooksPath"]);
  log(`push guard: removed from ${worktree}${set === null ? " (nothing was set there)" : ""} — hooks fall back to ${now || "git's own <git-dir>/hooks"}`);
  return { ok: true, fallsBackTo: now || null };
}

// What the Settings row and GET /api/remote-write/state report: whether the guard is in the path of this worktree,
// what it replaced, and what the guard's own copy of the policy says.
export async function guardState({ projectPath, worktree }) {
  const tree = worktree || projectPath;
  const common = await commonDirOf(projectPath || tree);
  const paths = common ? guardPaths(common) : null;
  const hooksPath = await gitOut(tree, ["config", "--get", "core.hooksPath"]);
  const read = (file) => {
    try {
      return readFileSync(file, "utf8").trim();
    } catch {
      return null;
    }
  };
  let record = null;
  if (paths) {
    try {
      record = JSON.parse(readFileSync(paths.config, "utf8"));
    } catch {
      record = null;
    }
  }
  const installed = Boolean(paths && hooksPath && path.resolve(tree || ".", hooksPath) === paths.dir);
  const worktreeConfig = await gitOut(tree, ["config", "--get", "extensions.worktreeConfig"]);
  return {
    installed,
    dir: paths ? paths.dir.replace(/\\/g, "/") : null,
    hooksPath: hooksPath || null,
    previousHooksPath: record?.previousHooksPath || null,
    shims: record?.shims || [],
    guardPolicy: paths ? read(paths.policy) : null,
    panel: paths ? read(paths.panel) : null,
    // The worktree's own pre-push, which the guard chains from every path that allows a push (empty when it had none).
    chained: paths ? read(paths.chain) : null,
    worktreeConfig: worktreeConfig === "true",
    record,
  };
}

// Refresh the guard's own copy of the facts (policy, window, which trees are meant to land) without touching the
// hook files or the worktree config: called whenever the reader changes the setting or a run is started to land.
export async function refreshGuardFiles({ projectPath, panelUrl, timeoutSeconds = 300, policy = "local-only", landing = [], log = () => {} }) {
  const common = await commonDirOf(projectPath);
  if (!common) return { ok: false, error: `cannot find the git dir of ${projectPath}` };
  const paths = guardPaths(common);
  if (!existsSync(paths.dir)) return { ok: false, error: "no guard installed for that project yet", skipped: true };
  try {
    writeFileSync(paths.panel, `${String(panelUrl || "").trim()}\n`, "utf8");
    writeFileSync(paths.timeout, `${Math.max(30, Number(timeoutSeconds) || 300)}\n`, "utf8");
    writeFileSync(paths.policy, `${policy}\n`, "utf8");
    writeFileSync(paths.landing, `${(landing || []).map(normTree).filter(Boolean).join("\n")}\n`, "utf8");
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  log(`push guard files refreshed for ${projectPath} (policy ${policy}, ${(landing || []).length} landing tree(s))`);
  return { ok: true, dir: paths.dir.replace(/\\/g, "/") };
}
