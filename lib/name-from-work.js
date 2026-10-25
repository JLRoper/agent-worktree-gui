// What this branch is actually building, read from git — the name a tree should have had.
//
// A tree is named from whichever prompt cut it (24 characters, usually mid-word), or from the title of whichever
// agent finished in it last. Neither describes the work: the first is what the reader typed before anything was
// built, the second is what one agent happened to say. The commits on the branch and the diff against the base
// branch are what the work actually is, and they are already here — so this module reads them and reduces them
// to a name shaped exactly like the ones the panel already cuts (`<slug>-<tag>`, slug at most 40 characters).
//
// It is deliberately deterministic: the same commits always give the same name, the reader sees the name (and
// the commits it came from) before anything is renamed, and no model or gateway is involved. Which words win is
// the whole of the heuristic, so it is spelled out in one place:
//
//   * a word in a commit subject scores 2 — a word the newest subject also carries scores 3
//   * a word in a changed file's path scores 1, once per file it appears in
//   * the winning subject is the one whose words the REST OF THE BRANCH also uses ("the retention sweep" across
//     three commits beats the newest commit's "test the sweep across a panel restart", which is only the last thing
//     done); a branch whose commits share no vocabulary, or a one-commit branch, is judged on its words alone
//   * the name is that subject's words that the branch shares, in that sentence's order — a phrase, not a bag of
//     keywords — and the highest-scoring words fill it out when the winning subject is one word long
//   * generic engineering verbs (add, update, fix, remove, ...) never appear in it: they say a commit happened,
//     not what it was about
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

// Words that carry no subject: articles, auxiliaries, and the vocabulary every commit shares.
const STOPWORDS = new Set(
  (
    "a an and are as at be been being but by can could did do does doing done for from had has have having he her him his how i if in into is it its just like may me might more most much must my no nor not of off on once only or other our out over own said same she should since so some such than that the their theirs them then there these they this those through to too under until up use used using very was we were what when where which while who whom why will with within without would you your yours " +
    "add added adds adding update updated updates updating fix fixed fixes fixing remove removed removes removing make made makes making use used using change changed changes changing ensure ensures ensured allow allows allowed improve improved improves refactor refactored refactoring cleanup tidy typos typo wip misc minor various also still back again now new newer newest old older first second third final finally really actually simply merely properly correctly instead rather plus via per etc"
  ).split(/\s+/).filter(Boolean),
);

// Conventional-commit prefixes and issue/bracket decorations, which are about the commit, not the work.
const stripSubject = (raw) =>
  String(raw ?? "")
    .replace(/^\s*(?:revert\s+)?[a-z]+(?:\([^)]*\))?!?:\s*/i, "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\(#\d+\)/g, " ")
    .replace(/^[\s*•-]+/, "")
    .replace(/\s+/g, " ")
    .replace(/[.]+$/, "")
    .trim();

const tokensOf = (text) =>
  stripSubject(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !/^\d+$/.test(w) && !/^[0-9a-f]{6}$/.test(w) && !STOPWORDS.has(w));

// The words a path is made of: the FILE's own name first (the part that carries the most signal), then the
// directories it sits in, minus extensions.
const tokensOfPath = (p) => {
  const segs = String(p ?? "")
    .toLowerCase()
    .split(/[\\/]+/)
    .filter(Boolean);
  const words = (seg) =>
    seg
      .replace(/\.[a-z0-9]+$/, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !/^\d+$/.test(w) && !STOPWORDS.has(w));
  const file = segs.pop() || "";
  return [...words(file), ...segs.flatMap(words)];
};

// `<word>-<word>-…`, at most 40 characters and never cut mid-word — the shape `worktreeDirName` wants.
export function slugWords(words, { maxChars = 40, maxWords = 6 } = {}) {
  const out = [];
  for (const w of words) {
    if (out.length >= maxWords) break;
    const next = [...out, w].join("-");
    if (next.length > maxChars) break;
    out.push(w);
  }
  // A single word longer than the cap still has to be *something*: cut it rather than return nothing.
  if (!out.length && words.length) out.push(String(words[0]).slice(0, maxChars).replace(/-+$/, ""));
  return out.join("-");
}

// The name, from the work, with the reasoning kept so the reader can judge it before pressing anything.
export function nameFromWork({ commits = [], files = [], current = "" } = {}) {
  const subjects = (Array.isArray(commits) ? commits : [])
    .map((c) => (typeof c === "string" ? c : c?.subject))
    .map((s) => String(s ?? "").trim())
    .filter(Boolean);
  const changed = (Array.isArray(files) ? files : [])
    .map((f) => (typeof f === "string" ? { path: f } : f))
    .filter((f) => f && f.path);

  const perSubject = subjects.map((s) => [...new Set(tokensOf(s))]);
  const perPath = [...new Set(changed.flatMap((f) => tokensOfPath(f.path)))];

  const score = new Map();
  const bump = (w, by) => score.set(w, (score.get(w) || 0) + by);
  perSubject.forEach((words, i) => {
    for (const w of words) bump(w, i === 0 ? 3 : 2);
  });
  for (const w of perPath) bump(w, 1);
  // Which words more than one commit carries: the branch's own vocabulary, as opposed to one commit's wording. A
  // token in a single subject is that sentence's turn of phrase; a token two subjects share is what the branch is
  // about — "retention sweep" across three commits, not "test the sweep across a panel restart", which is only the
  // last thing done.
  const carrying = new Map();
  for (const words of perSubject) for (const w of words) carrying.set(w, (carrying.get(w) || 0) + 1);
  const shared = (w) => (carrying.get(w) || 0) > 1;

  const whose = perSubject.map((words, i) => ({
    i,
    subject: subjects[i],
    words,
    theme: words.reduce((a, w) => a + (shared(w) ? score.get(w) || 0 : 0), 0),
    total: words.reduce((a, w) => a + (score.get(w) || 0), 0),
  }));
  // The frame is the subject that best echoes the rest of the branch, and a tie goes to the newest subject: the
  // last thing the branch did is the least stale phrasing of it. A branch whose commits share no vocabulary at all
  // (one commit, or three unrelated ones) is judged on its words alone, and then the name is that subject's words.
  const frame = whose.length
    ? whose.reduce((best, x) => (x.theme > best.theme || (x.theme === best.theme && (x.total > best.total || (x.total === best.total && x.i < best.i))) ? x : best))
    : null;

  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([w]) => w);

  let words = [];
  let source = "none";
  if (frame && frame.total > 0) {
    // The echoed words, in the winning sentence's own order — the phrase, not a bag of keywords.
    const echoed = frame.theme > 0 ? frame.words.filter(shared) : [];
    words = echoed.length ? echoed : frame.words;
    source = "commits";
    // Two words already read as a name ("retention-sweep"). ONE word is thin ("retention"): fill it out from the
    // words the branch shares, then from the winning sentence's own wording — never from the current name, which is
    // the thing being replaced.
    if (words.length === 1) {
      for (const w of [...ranked.filter(shared), ...frame.words]) {
        if (words.length >= 3) break;
        if (!words.includes(w)) words.push(w);
      }
    }
  } else if (subjects.length) {
    // Subjects made of nothing but generic words: fall back to the paths rather than inventing a name.
    words = perPath.slice(0, 3);
    source = words.length ? "files" : "none";
  } else if (perPath.length) {
    words = perPath.slice(0, 3);
    source = "files";
  }

  const slug = slugWords(words);
  if (!slug) {
    return {
      name: "",
      source: "none",
      why: subjects.length || changed.length
        ? "there is work here, but nothing in it names itself — commits and file names are all generic words"
        : "nothing to name it from yet: no commits against the base branch and no changed files",
      frame: null,
      words: [],
      stats: { commits: subjects.length, files: changed.length, added: 0, removed: 0 },
    };
  }

  const added = changed.reduce((a, f) => a + (Number(f.added) || 0), 0);
  const removed = changed.reduce((a, f) => a + (Number(f.removed) || 0), 0);
  const uncommitted = changed.filter((f) => f.uncommitted).length;
  const figures = [
    subjects.length ? `${subjects.length} commit${subjects.length === 1 ? "" : "s"} on the branch` : "no commits against the base branch yet",
    changed.length ? `${changed.length} file${changed.length === 1 ? "" : "s"} changed` : null,
    changed.length && (added || removed) ? `+${added}/−${removed}` : null,
    uncommitted ? `${uncommitted} of them uncommitted` : null,
  ].filter(Boolean);
  const why =
    source === "commits"
      ? `${figures.join(", ")} — from “${frame.subject}”`
      : `${figures.join(", ")} — no commit subject to read, so the changed paths name it`;

  return {
    name: slug,
    source,
    why,
    frame: frame ? frame.subject : null,
    words,
    stats: { commits: subjects.length, files: changed.length, added, removed, uncommitted },
    current: String(current || ""),
  };
}

// ---- reading the work out of git --------------------------------------------------------------
// The base branch is the project's own (`main` here). It is asked for by name and then by its remote-tracking
// form, because a tree cut from a fresh clone can be ahead of `origin/main` while a local `main` does not exist.
async function resolveBase(dir, base, exec) {
  for (const ref of [base, `origin/${base}`]) {
    if (!ref) continue;
    const ok = await exec("git", ["-C", dir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
      .then((r) => String(r.stdout || "").trim())
      .catch(() => "");
    if (ok) return ref;
  }
  return null;
}

const parseNumstat = (out) =>
  String(out || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...rest] = line.split("\t");
      const file = rest.join("\t").trim();
      if (!file) return null;
      return { path: file, added: /^\d+$/.test(added) ? Number(added) : 0, removed: /^\d+$/.test(removed) ? Number(removed) : 0 };
    })
    .filter(Boolean);

// Every fact the namer gets, in one read: the branch's own commits against the base, the diff against the base
// (`...` = against the merge base, so a base branch that moved on does not count its own work here), and what is
// still uncommitted — which is the freshest statement of what is being built right now.
export async function readWorktreeWork({ dir, base = "main", exec = pexec, limit = 40 } = {}) {
  const run = (args) => exec("git", ["-C", dir, ...args], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  const out = (args) => run(args).then((r) => String(r.stdout || "")).catch(() => "");
  const baseRef = await resolveBase(dir, base, exec);
  const commits = baseRef ? (await out(["log", "--no-merges", "--format=%s", `-n`, String(limit), `${baseRef}..HEAD`])).split(/\r?\n/).filter(Boolean) : [];
  const byPath = new Map();
  if (baseRef) for (const f of parseNumstat(await out(["diff", "--numstat", `${baseRef}...HEAD`]))) byPath.set(f.path, { ...f, committed: true });
  for (const f of parseNumstat(await out(["diff", "--numstat", "HEAD"]))) {
    const prev = byPath.get(f.path) || { path: f.path, added: 0, removed: 0 };
    byPath.set(f.path, { ...prev, added: prev.added + f.added, removed: prev.removed + f.removed, uncommitted: true });
  }
  for (const line of (await out(["status", "--porcelain", "--untracked-files=normal"])).split(/\r?\n/).filter(Boolean)) {
    if (!line.startsWith("?? ")) continue;
    const rel = line.slice(3).trim().replace(/^"(.*)"$/, "$1");
    if (rel && !byPath.has(rel)) byPath.set(rel, { path: rel, added: 0, removed: 0, uncommitted: true, untracked: true });
  }
  return {
    dir,
    base,
    baseRef,
    ahead: commits.length,
    commits,
    files: [...byPath.values()],
    note: baseRef ? "" : `neither ${base} nor origin/${base} is in this repo, so only the working tree was read`,
  };
}

// The whole answer for one tree: the name, why that name, and the evidence it came from. Nothing here renames
// anything — the reader sees this in a confirm box and the rename is a separate, deliberate request.
export async function suggestWorktreeName({ dir, base = "main", current = "", tag = null, exec = pexec } = {}) {
  const work = await readWorktreeWork({ dir, base, exec });
  const picked = nameFromWork({ commits: work.commits, files: work.files, current });
  return {
    ...picked,
    dir,
    base: work.baseRef || base,
    note: work.note,
    tag: tag || null,
    proposed: picked.name && tag ? `${picked.name}-${tag}` : picked.name,
    evidence: {
      ahead: work.ahead,
      commits: work.commits.slice(0, 6),
      files: work.files.slice(0, 8).map((f) => ({ path: f.path, added: f.added, removed: f.removed, uncommitted: Boolean(f.uncommitted), untracked: Boolean(f.untracked) })),
      changedFiles: work.files.length,
    },
  };
}
