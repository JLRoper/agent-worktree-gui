// A SPAWN IN line names a tree by PATH — and the panel renames a finished run's worktree directory and its
// branch after the thread's own title (`renameWorktree` in server.js). The slug is rebuilt by that rename; the
// six-hex tag is kept. So a path the reader typed yesterday, or the assistant wrote down when the worker
// finished, stops existing while the tree it named is still standing one directory over. This module is the
// second question a spawn asks before it refuses: not "is that a directory" but "which tree of that project is
// the one you meant".
//
// It will not guess. Exactly one match is used, and the card says which tree and what tied the want to it;
// several is a refusal that names every candidate; none keeps the refusal the panel always gave. And the tree
// it picks is stat()-ed as a directory before it is handed back, so a match read out of a worktree list that
// went stale between the two calls can never start a run in a directory that is not there.
import path from "node:path";
import { stat } from "node:fs/promises";
import { worktreeList } from "./project.js";

const TAG_RE = /-([0-9a-f]{6})$/i;
const normKey = (s) => String(s ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const clean = (s) => String(s ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
const lastSegment = (s) => normKey(s).split("/").filter(Boolean).pop() || "";
// Absolute the way Windows and POSIX write one: a drive letter, a UNC prefix, or a leading slash. A relative
// name is never this, which is the whole point — it is a name that has to be resolved somewhere.
const isAbsoluteish = (s) => /^[a-zA-Z]:[\\/]/.test(String(s)) || String(s).startsWith("\\\\") || String(s).startsWith("/");

// The parts every tree name is made of: `<slug>-<tag>` on the directory and on `wtgui/<slug>-<tag>` on the
// branch. The slug is cut from whatever named the tree first; the tag is six hex. Six hex can also BE the whole
// name, and then it is the tag being named — the one part a rename keeps.
export function nameParts(raw) {
  const full = normKey(raw).replace(/^refs\/heads\//, "");
  const base = lastSegment(full);
  if (!base) return null;
  if (full === base && /^[0-9a-f]{6}$/i.test(base)) return { full, base, tag: base.toLowerCase(), slug: null, tagOnly: true };
  const found = (TAG_RE.exec(base) || [])[1];
  const tag = found ? found.toLowerCase() : null;
  return { full, base, tag, slug: tag ? base.slice(0, -(tag.length + 1)) || null : base, tagOnly: false };
}

// Which predicate found it, worded as the card says it back. Ordered by how much each one actually ties the
// want to this tree: the name still being there, then the branch, then the tag a rename keeps, then a slug cut
// from the same prompt. Returns null when nothing ties them.
export function matchHow(want, tree) {
  if (!want || !tree?.path) return null;
  const dir = nameParts(tree.path);
  const br = tree.branch ? nameParts(tree.branch) : null;
  if (want.tagOnly) {
    if (dir?.tag === want.tag) return `the tag ${want.tag} on ${dir.base}`;
    if (br?.tag === want.tag) return `the tag ${want.tag} on branch ${br.full}`;
    return null;
  }
  // A want written as a branch (`wtgui/<slug>-<tag>`) says its own kind: the branch rule answers before the
  // directory-name rule, because that is what was actually named. A bare name is a directory name first.
  const branchish = want.full !== want.base;
  if (branchish && br && (want.full === br.full || want.base === br.base)) return `the branch ${br.full}`;
  if (dir && want.base === dir.base) return `the directory name ${dir.base}`;
  if (br && (want.full === br.full || want.base === br.base)) return `the branch ${br.full}`;
  if (want.tag && (dir?.tag === want.tag || br?.tag === want.tag)) return `the six-hex tag ${want.tag} (a rename keeps it)`;
  if (want.slug && (want.slug === dir?.slug || want.slug === br?.slug)) return `the slug ${want.slug}`;
  return null;
}

const isDir = (p) => stat(p).then((s) => s.isDirectory()).catch(() => false);

// Where a written-down name can mean something, in order: the path as written (absolute, or relative to the
// process's cwd — exactly what the spawn asked before), then inside the project's own checkout, then that
// project's `.worktrees/` directory, which is where a tree cut from a prompt lands and where a branch whose
// base is the directory name (`wtgui/<slug>-<tag>`) is found without asking git anything.
function literalCandidates(asked, project) {
  if (isAbsoluteish(asked)) return [{ at: asked, how: "the path as written", resolved: false }];
  const out = [{ at: path.resolve(asked), how: "the path as written", resolved: false }];
  if (project?.path) {
    const base = lastSegment(asked);
    out.push({ at: path.join(project.path, asked), how: `a directory inside ${project.name}`, resolved: true });
    if (base) out.push({ at: path.join(project.path, ".worktrees", base), how: `the worktree directory ${base} of ${project.name}`, resolved: true });
  }
  return out;
}

// Which projects' worktree lists are worth asking. A path inside a project is that project's business; an
// absolute path that belongs to no project cannot be placed in any repository — a worktree list is per
// repository — so it refuses instead of matching a directory name in someone else's repo. A bare name or a
// branch could belong to any of them, and there is no repository to ask first.
function projectsToSearch({ asked, project, projects }) {
  if (project?.path) return [project];
  const key = normKey(asked);
  const inside = projects
    .filter((p) => p?.path && (key === normKey(p.path) || key.startsWith(`${normKey(p.path)}/`)))
    .sort((a, b) => normKey(b.path).length - normKey(a.path).length);
  if (inside.length) return [inside[0]];
  if (isAbsoluteish(asked)) return [];
  return projects.filter((p) => p?.path);
}

const describeTree = (t) => `${t.path}${t.branch ? ` (${t.branch})` : ""}`;

// What the card says, in one place: the tree that was picked and the one thing that tied the want to it. Empty
// when nothing had to be resolved, because a path that was where the line said it was is not news.
export function resolutionNote(res) {
  if (!res?.ok || !res.resolved) return "";
  return `${res.asked} → ${res.path} (matched ${res.how})`;
}

export async function resolveExistingTarget({ target, project = null, projects = [], thread = null, listTrees = (p) => worktreeList(p.path) } = {}) {
  const asked = String(target ?? "").trim().replace(/^["']|["']$/g, "");
  const asPath = () => `${path.resolve(asked)} does not exist or is not a directory`;
  const asName = () => `${asked} is not a directory, a worktree directory name, or a branch of any known project`;
  if (!asked) return { ok: false, reason: "empty", error: "a SPAWN IN line needs a directory, a worktree name or a branch", candidates: [] };
  const want = nameParts(asked);

  // 1. A directory that is still where the line said it was is never second-guessed.
  for (const cand of literalCandidates(asked, project)) {
    if (!(await isDir(cand.at))) continue;
    return { ok: true, path: clean(cand.at), branch: null, project: project?.name || null, asked, from: asked, resolved: cand.resolved, how: cand.how, candidates: [] };
  }

  // 2. Otherwise ask git which trees the project(s) actually have. The one thread that is not a path — a thread
  //    whose slug named this tree — is matched the same way a written-down slug is, because it is the same slug.
  const wants = [want, thread ? nameParts(String(thread).replace(/^wtgui-/, "")) : null].filter(Boolean);
  const search = projectsToSearch({ asked, project, projects });
  const matches = [];
  for (const proj of search) {
    const trees = await Promise.resolve(listTrees(proj)).catch(() => []);
    for (const t of Array.isArray(trees) ? trees : []) {
      if (!t?.path) continue;
      const who = wants.map((w) => matchHow(w, t)).find(Boolean);
      if (!who) continue;
      if (matches.some((m) => normKey(m.path) === normKey(t.path))) continue;
      matches.push({ path: clean(t.path), branch: t.branch || null, project: proj.name || null, how: who });
    }
  }

  const pathLike = isAbsoluteish(asked) || asked.includes("/") || asked.includes("\\");
  if (!matches.length) return { ok: false, reason: "missing", error: pathLike ? asPath() : asName(), candidates: [] };

  // The list is a read, not a promise: a tree moved or removed a second ago must land in the same refusal.
  const live = [];
  for (const m of matches) if (await isDir(m.path)) live.push(m);
  if (!live.length) return { ok: false, reason: "missing", error: pathLike ? asPath() : asName(), candidates: [] };
  if (live.length > 1) {
    const where = search.length === 1 ? `the worktrees of ${search[0].name}` : "the known projects";
    return {
      ok: false,
      reason: "ambiguous",
      error: `${asked} matches ${live.length} worktrees in ${where} — name one of them: ${live.map(describeTree).join(" · ")}`,
      candidates: live,
    };
  }
  const [only] = live;
  return { ok: true, path: only.path, branch: only.branch, project: only.project, asked, from: asked, resolved: true, how: only.how, candidates: [] };
}
