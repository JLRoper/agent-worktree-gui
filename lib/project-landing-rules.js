// The landing rules a READER wrote for one project, and the two places they are carried.
//
// NOT `lib/project-rules.js`. That module is a different fact and already owns its name: a project's list of one-line
// rules (`projects[].rules`), drawn on the board's rules bar and written by POST /api/project-rules. This file is the
// single free-text `projects[].landingRules` paragraph described below, and the two must not be confused: one is a
// list of short sentences about how work is done, the other is HOW A PROJECT'S WORK LANDS.
//
// Not every repository lands the same way, and the LANDING paragraph (lib/branch-policy.js) can only describe what
// the tree's PARENT puts it: a tree cut from a local turnover branch merges back into it, a tree cut from main is
// pushed for a pull request. What it cannot know is the PROJECT's own pattern - a SEFL checkout lands one turnover
// branch, with worker branches cut from it and rolled back into it locally so that only the turnover branch is ever
// pushed, while this panel's own GitHub checkout lands a `wtgui/*` branch straight onto main with
// `gh pr merge <n> --rebase --admin`. Writing that into the panel was the alternative; instead a project may carry
// its own `landingRules` text in config.json, and it rides every worker brief in that project and the board
// assistant's preamble, so a SEFL turnover reads differently from a GitHub PR land.
//
// The field is one optional string on a `projects[]` entry, and nothing else:
//
//   "landingRules": "one turnover branch ... only the turnover branch is pushed"
//
// A project WITHOUT the field carries no paragraph at all - not an empty heading, not a placeholder - which is what
// keeps this invisible to every repository that lands the ordinary way. The text is the reader's, so it is carried
// verbatim: trimmed and capped, newlines kept. A rules paragraph the panel reflowed is one the reader cannot grep
// back to the file they wrote.

export const PROJECT_RULES_FIELD = "landingRules";

// The cap. A rules text is a paragraph or two, and it rides EVERY brief in the project and the assistant's standing
// preamble, so the cost is per turn: 2000 characters is past the longest pattern worth writing down and far short of
// a document pasted into the wrong field.
export const PROJECT_RULES_MAX = 2000;

// The assistant's preamble lists every project that carries rules. These two numbers bound that block: the first N
// projects, each clipped, and one line naming the rest.
export const PREAMBLE_PROJECTS_MAX = 12;
export const PREAMBLE_RULES_CHARS = 400;

// The path spelling every comparison here uses: forward slashes, no trailing separator, case folded. Windows prints
// a drive letter and backslashes, config.json may keep either, and a tree sits UNDER its project - so the raw strings
// are never compared.
const pathKey = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** One project's rules text: trimmed, newlines kept, capped. Absent, blank or non-string reads as none. */
export function projectRulesOf(project) {
  const raw = typeof project?.[PROJECT_RULES_FIELD] === "string" ? project[PROJECT_RULES_FIELD] : "";
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  return text.length > PROJECT_RULES_MAX ? `${text.slice(0, PROJECT_RULES_MAX - 1)}…` : text;
}

/**
 * The project a run belongs to: by NAME when the caller names one, else by the TREE it works in.
 *
 * The name is the board's key and is tried first, because it is the answer when a caller has it. The tree is the
 * fallback every reply needs: the panel's reply route and an existing-tree SPAWN hand `lib/jobs.js` a directory and
 * no project name, and the rules have to reach those briefs too. Longest matching root wins, so a project inside
 * another project's folder is not shadowed by the outer one. This is the same containment rule the board's own
 * membership test uses (the project record's `path` against the tree).
 */
export function projectForRun({ projects = [], name = null, tree = null } = {}) {
  const list = Array.isArray(projects) ? projects.filter((p) => p && p.name) : [];
  const want = String(name ?? "").trim();
  if (want) {
    const exact = list.find((p) => String(p.name) === want) || list.find((p) => String(p.name).toLowerCase() === want.toLowerCase());
    if (exact) return exact;
  }
  const dir = pathKey(tree);
  if (!dir) return null;
  let best = null;
  let bestLen = -1;
  for (const p of list) {
    const root = pathKey(p.path);
    if (!root || root.length <= bestLen) continue;
    // Equality counts: a run in the project's own checkout IS a run in that project, which is how the board reads
    // the primary row too.
    if (dir === root || dir.startsWith(`${root}/`)) {
      best = p;
      bestLen = root.length;
    }
  }
  return best;
}

/**
 * The paragraph a worker's brief carries, for a project that has rules, or "" for one that does not.
 *
 * It says whose rules these are and that they win over the general landing paragraph above, because the two can
 * genuinely disagree: a SEFL project cut from `main` is handed the panel's "push and open a pull request" line by
 * branch-policy, while the project's own rule is that worker branches never go up and only the turnover branch does.
 * The last clause keeps the push GUARD where it belongs: these rules decide the branch shape and the sequence, not
 * whether the panel's guard lets a push through.
 */
export function projectRulesBrief(project, rules = projectRulesOf(project)) {
  const text = String(rules ?? "").trim();
  if (!text) return "";
  const name = String(project?.name ?? "").trim();
  const label = name ? `LANDING RULES FOR ${name}` : "LANDING RULES FOR THIS PROJECT";
  return (
    `${label}: the reader wrote these rules for this project, and they decide how its work lands. ` +
    "Follow them over the general landing paragraph above where the two differ; the panel's push guard still has the last word on whether a push goes through.\n" +
    text
  );
}

const oneLine = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * The assistant preamble's lines: every project that carries rules, labelled by name, right beside the standing
 * rules. The board assistant writes the briefs workers run on, so it has to know a project's landing pattern to
 * write one that fits - a SEFL SPAWN that says "push the branch and open a PR" is the mistake this block prevents.
 *
 * Bounded on purpose: the preamble is sent on every turn, so this lists at most `max` projects, clips each text,
 * and says how many more there are rather than growing without limit.
 */
export function projectRulesPreambleLines(projects = [], { max = PREAMBLE_PROJECTS_MAX, chars = PREAMBLE_RULES_CHARS } = {}) {
  const carrying = (Array.isArray(projects) ? projects : [])
    .map((p) => ({ name: String(p?.name ?? "").trim(), rules: projectRulesOf(p) }))
    .filter((p) => p.name && p.rules);
  if (!carrying.length) return ["(none - no project carries landing rules)"];
  const shown = carrying.slice(0, Math.max(1, max));
  const lines = shown.map((p) => `- ${p.name}: ${oneLine(p.rules, chars)}`);
  const hidden = carrying.length - shown.length;
  if (hidden > 0) lines.push(`(${hidden} more project${hidden === 1 ? "" : "s"} carries landing rules - read that project's config entry before briefing a worker in it)`);
  return lines;
}
