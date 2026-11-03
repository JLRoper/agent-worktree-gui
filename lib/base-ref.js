// Which remote a project's base ref is built from — one answer, asked by both the project header (lib/project.js)
// and every row's scan (lib/scheduler.js `ctxFor`), so the two can never name different refs.
//
// WHY. `config.json` is the reader's file, and a `projects[]` entry carries `remote` through discovery verbatim
// (lib/projects.js merges the explicit entry OVER the probe's own answer). Nothing used to check that the name is a
// remote the checkout actually has, so this repository's own entry — `"remote": "github"` while its clone has only
// `origin` — built `${remote}/${mainBranch}` = `github/main` for the header and for every row: `git rev-parse` and
// `git rev-list` answered "fatal: Needed a single revision", `lib/scan.js` read that as "a base ref that does not
// exist here", and all ten rows of the panel's own project read NO BASE REF (docs/rounds/playwright-round-1.md).
//
// So the configured name is honoured when the checkout has it, and otherwise the base ref is built from the remote
// that IS there: `origin` if it exists, else the only remote there is. One log line per project names the
// substitution — the reader's mistake is still visible — and the board reads real verdicts instead of a blank column.
// When there is no single better answer (several remotes, none of them `origin`) the configured name is left alone:
// inventing a remote would put a ref in every row that nobody configured.
import { gitIn } from "./scan.js";

// A project's remotes change when a reader runs `git remote add/rename`, not between two row scans, and `ctxFor`
// asks once per scanned row. One answer per project per minute is plenty; a failed read is NOT cached, so a
// transient git hiccup cannot pin a project to a wrong answer for the rest of the process.
const REMOTES_TTL_MS = 60_000;
const remotesCache = new Map(); // path -> { at, remotes }

// The substitution is worth ONE line per project per process, not one per pass: `ctxFor` runs for every row on
// every tick, so a line per call would be a log storm that hides the one fact it carries.
const announced = new Set();

const stamp = () => new Date().toISOString().slice(11, 19);
const pathKey = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

async function remotesOf(projectPath) {
  const key = pathKey(projectPath);
  if (!key) return null;
  const hit = remotesCache.get(key);
  if (hit && Date.now() - hit.at < REMOTES_TTL_MS) return hit.remotes;
  const r = await gitIn(projectPath, ["remote"], 15000);
  // `null` means "could not look", which is not the same as "no remotes": an unreadable checkout must not turn a
  // correct configured name into a substitution, so the caller is told the question went unanswered.
  if (!r.ok) return null;
  const remotes = r.out ? r.out.split("\n").map((l) => l.trim()).filter(Boolean) : [];
  remotesCache.set(key, { at: Date.now(), remotes });
  return remotes;
}

// The rule, without a repository, so it can be read and tested on its own. `remotes` is the list `git remote` gave,
// or null when that read failed.
export function chooseRemote(configured, remotes) {
  const want = String(configured || "").trim();
  if (!want) return { remote: null, substituted: false, note: "" };
  if (!Array.isArray(remotes)) return { remote: want, substituted: false, note: "" };
  if (remotes.includes(want)) return { remote: want, substituted: false, note: "" };
  const fallback = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : null;
  if (!fallback) return { remote: want, substituted: false, note: "" };
  return {
    remote: fallback,
    substituted: true,
    note: `the configured remote '${want}' is not in this checkout (remotes: ${remotes.join(", ") || "none"}); using '${fallback}'`,
  };
}

// The one exported answer. `remoteRef` is exactly what the old two call sites built — `<remote>/<mainBranch>`, or the
// local `<mainBranch>` for a project with no remote — only built from a remote the checkout has.
export async function resolveBaseRef(project = {}) {
  const configured = String(project.remote || "").trim() || null;
  const mainBranch = String(project.mainBranch || "").trim() || null;
  const picked = chooseRemote(configured, configured ? await remotesOf(project.path) : []);
  const remoteRef = picked.remote && mainBranch ? `${picked.remote}/${mainBranch}` : mainBranch || null;
  if (picked.substituted) {
    const key = `${pathKey(project.path)}::${configured}`;
    if (!announced.has(key)) {
      announced.add(key);
      console.log(
        stamp(),
        `project ${project.name || "(unnamed)"}: ${picked.note} — its base ref is ${remoteRef || "(none)"}`,
      );
    }
  }
  return { configured, remote: picked.remote, remoteRef, substituted: picked.substituted, note: picked.note };
}
