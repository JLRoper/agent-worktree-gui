// ---- where skills are absorbed from, and what they are -----------------------------------------
// An agent started from this panel loads skills from four kinds of place, and the panel can only
// answer "which skills does it have?" by reading all of them:
//
//   * the profile's own `skills/` directory — `<HERMES_HOME>/skills`, which holds category folders
//     (`software-development/gradle-builds/SKILL.md`), skills that sit at the top level
//     (`code-review-report/SKILL.md`), and, on this machine, a JUNCTION named `sefl` that points at the
//     team's own repository (`~/.config/kilo/skills`). A naive walk follows that junction, so the same
//     25 skills are listed once under the category the junction happens to sit in and once under
//     nothing at all — with no way to tell which copy a row is. So a junctioned directory is its OWN
//     source: it keeps its own name, it records what it points at, and the walk that found it does not
//     descend into it. A realpath dedupe then catches the case the shape alone cannot — the same target
//     reachable from two sources (an `external_dirs` entry that IS the junction's target).
//   * `skills.create_dir`, when the profile names one: where Hermes is told to write new skills.
//   * `skills.external_dirs`, when the profile names any: shared, read-only trees.
//   * a project's own `.hermes/skills` or `.agents/skills`, but only when the project root is listed in
//     `skills.trusted_project_dirs` — Hermes refuses those dirs for an untrusted checkout, so a source
//     that is present but ignored must say so rather than pretend the skills are absorbed.
//
// That is the disk half. It is not the same question as "what does the agent actually load": a skill on
// disk can be shadowed by a higher tier, disabled by name, gated to another platform, or quarantined by
// the project scan, and the one thing that reports the RESOLVED set is the gateway's `GET /v1/skills`.
// So the two answers are merged: every on-disk row is marked served / not served by the gateway's
// answer, a name the gateway serves that no root carries (a plugin's `plugin:skill`) becomes a row of
// its own, and a gateway that cannot answer leaves every row UNVERIFIED rather than claiming either.
//
// Nothing here writes, creates or repairs a skill: the Skills tab is an inventory, and its arrows all
// point one way — from the disk, through the gateway, to the reader.
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { blockRange, hermesConfigPath } from "./hermes-config.js";

// A skills tree is shallow (root -> category -> skill -> SKILL.md, or root -> skill -> SKILL.md). The cap
// is a guard against a junctioned loop or a pathological checkout, not a real depth limit.
const MAX_DEPTH = 8;
// Directories that are never a skills root: a checkout's git store, an installed package, a Python cache,
// and the profile's own archive of retired skills (those are explicitly NOT in the index).
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", ".archive", ".trash"]);
const NAME_MAX = 120;
const DESCRIPTION_MAX = 400;

const say = (e) => String((e && e.code) || (e && e.message) || e || "unknown error");
const trim = (s) => String(s == null ? "" : s).trim();
const quote = (s) => {
  const t = trim(s);
  return t.replace(/^["']|["']$/g, "");
};

// ---- config.yaml: the skills block ---------------------------------------------------------------
// `create_dir` is one scalar; `external_dirs` and `trusted_project_dirs` are lists. Only the lines this
// module needs are located — config.yaml is the reader's file, full of their own comments, and parsing it
// wholesale is how a round-trip eats them (the same rule lib/hermes-config.js states for approvals).
const listItems = (lines, start, end, key) => {
  const out = [];
  const keyAt = lines.findIndex((line, i) => i > start && i < end && new RegExp(`^\\s+${key}\\s*:`).test(line));
  if (keyAt < 0) return out;
  const inline = lines[keyAt].replace(new RegExp(`^\\s+${key}\\s*:\\s*`), "").trim();
  if (inline.startsWith("[") && inline.endsWith("]")) {
    return inline
      .slice(1, -1)
      .split(",")
      .map((s) => quote(s))
      .filter(Boolean);
  }
  for (let i = keyAt + 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (!m) break; // the next key ends the list
    const item = quote(m[1].replace(/\s+#.*$/, ""));
    if (item) out.push(item);
  }
  return out;
};

// `~` and `${VAR}` the way Hermes expands them, then a relative value resolves against HERMES_HOME —
// never against the panel's own cwd, which is a checkout and not a Hermes install.
export function expandSkillDir(raw, { home }) {
  const text = trim(raw);
  if (!text) return null;
  const env = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (all, name) => process.env[name] ?? all);
  let p = env;
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    p = path.join(process.env.USERPROFILE || process.env.HOME || home, p.slice(2));
  }
  return path.resolve(home, p);
}

export function readSkillsConfig(text, { home }) {
  const lines = String(text ?? "").split(/\r?\n/);
  const range = blockRange(lines, "skills");
  const empty = { createDir: null, externalDirs: [], trustedProjectDirs: [], projectDiscovery: true };
  if (!range) return empty;
  const scalar = (key) => {
    for (let i = range.start + 1; i < range.end; i++) {
      const m = new RegExp(`^\\s+${key}\\s*:\\s*(.*)$`).exec(lines[i]);
      if (m) return quote(m[1].replace(/\s+#.*$/, ""));
    }
    return null;
  };
  const discovery = scalar("project_discovery");
  return {
    createDir: expandSkillDir(scalar("create_dir"), { home }),
    externalDirs: listItems(lines, range.start, range.end, "external_dirs")
      .map((entry) => expandSkillDir(entry, { home }))
      .filter(Boolean),
    trustedProjectDirs: listItems(lines, range.start, range.end, "trusted_project_dirs")
      .map((entry) => expandSkillDir(entry, { home }))
      .filter(Boolean),
    projectDiscovery: !/^(false|no|off|0)$/i.test(trim(discovery)),
  };
}

// ---- SKILL.md: the two fields a list can show -----------------------------------------------------
// A frontmatter reader, not a YAML parse: `name` and `description` are what the list needs, and a skill
// with a syntax error in some other key must still be listed (Hermes parses the frontmatter and skips a
// file it cannot read at all — the panel shows it, with the name it could find).
export function parseSkillText(text) {
  const src = String(text ?? "").replace(/^\uFEFF/, "");
  const lines = src.split(/\r?\n/);
  const out = { name: null, description: null, body: "" };
  if (!/^---\s*$/.test(lines[0] || "")) {
    out.body = src;
    return out;
  }
  let end = lines.length;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const head = lines.slice(1, end);
  out.body = lines.slice(end + 1).join("\n");
  for (let i = 0; i < head.length; i++) {
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(head[i]);
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    // A folded or literal block (`description: >`) continues on the indented lines below it.
    if (/^[>|][+-]?\s*$/.test(value)) {
      const block = [];
      for (let j = i + 1; j < head.length; j++) {
        if (!/^\s+\S/.test(head[j])) break;
        block.push(head[j].trim());
      }
      value = /^>/.test(value) ? block.join(" ") : block.join("\n");
      i += block.length;
    }
    if (key === "name" && !out.name) out.name = quote(value);
    if (key === "description" && !out.description) out.description = quote(value);
  }
  return out;
}

// The description a SKILL.md with no `description:` key still has: its first line of prose. Hermes reads
// the first non-heading body line as the fallback, so a list built here agrees with the one it serves.
const fallbackDescription = (body) =>
  trim(String(body || "").split(/\r?\n/).find((line) => trim(line) && !trim(line).startsWith("#")) || "");

const clip = (text, max) => {
  const t = trim(text);
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

// ---- the sources ---------------------------------------------------------------------------------
const samePath = (a, b) =>
  process.platform === "win32"
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);

const realOrNull = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

const sourceOf = (root, extra = {}) => ({
  key: root.key,
  label: root.label,
  kind: root.kind,
  path: root.path,
  // The path a category is read from: the root the source hangs under, so a junctioned directory keeps
  // the category its own position in the tree gives it (Hermes reads `skills/sefl/x/SKILL.md` as category
  // `sefl`, and the panel must say the same word).
  categoryBase: root.categoryBase || root.path,
  isLink: Boolean(root.isLink),
  target: root.target || null,
  status: "ok",
  reason: null,
  count: 0,
  skills: [],
  ...extra,
});

const sourceSlug = (kind, index) => `${kind}:${index}`;

export function skillSources({ home, skills = {}, projects = [] }) {
  const skillsHome = path.join(home, "skills");
  // The profile root may itself be a link (a relocated skills directory): then the source says so, and the
  // walk still reads through it — the junction rule only applies to directories INSIDE a root.
  const profileReal = realOrNull(skillsHome);
  const profileLink = profileReal && !samePath(skillsHome, profileReal);
  const list = [
    {
      key: "profile",
      label: "Profile",
      kind: "profile",
      path: skillsHome,
      categoryBase: skillsHome,
      isLink: Boolean(profileLink),
      target: profileLink ? profileReal : null,
    },
  ];
  if (skills.createDir) {
    list.push({
      key: "create",
      label: "Create directory",
      kind: "create-dir",
      path: skills.createDir,
      categoryBase: skills.createDir,
    });
  }
  (skills.externalDirs || []).forEach((dir, i) => {
    list.push({
      key: sourceSlug("external", i),
      label: path.basename(dir) || dir,
      kind: "external",
      path: dir,
      categoryBase: dir,
    });
  });
  if (skills.projectDiscovery !== false) {
    const trusted = new Set((skills.trustedProjectDirs || []).map((p) => path.resolve(p).toLowerCase()));
    for (const project of projects) {
      const root = project && project.path ? path.resolve(project.path) : null;
      if (!root) continue;
      for (const sub of [path.join(".hermes", "skills"), path.join(".agents", "skills")]) {
        const dir = path.join(root, sub);
        let present = false;
        try {
          present = statSync(dir).isDirectory();
        } catch {
          present = false;
        }
        if (!present) continue;
        const isTrusted = trusted.has(root.toLowerCase());
        list.push({
          key: `project:${project.name || path.basename(root)}:${sub.replace(/\\/g, "/")}`,
          label: `${project.name || path.basename(root)}`,
          kind: "project",
          path: dir,
          categoryBase: dir,
          status: isTrusted ? "ok" : "ignored",
          reason: isTrusted
            ? null
            : "this checkout is not in skills.trusted_project_dirs, so Hermes does not load these skills",
        });
      }
    }
  }
  return list.map((root) => sourceOf(root, root.status ? { status: root.status, reason: root.reason } : {}));
}

// ---- the walk -------------------------------------------------------------------------------------
// One source's own tree, plus the junctioned directories it finds on the way (each becomes its own source
// and is NOT descended into here). `seen` is shared across every source: it is the realpath dedupe, and
// the first source to claim a file keeps it.
function walkSource(source, { seen, duplicates, children }) {
  const rows = [];
  const stack = [{ dir: source.path, depth: 0 }];
  const visited = new Set();
  while (stack.length) {
    const { dir, depth } = stack.pop();
    const realDir = realOrNull(dir) || dir;
    if (visited.has(realDir.toLowerCase())) continue; // a junction that loops back onto an ancestor
    visited.add(realDir.toLowerCase());
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      // The root itself failing is the source's own reason; a directory INSIDE it is one more line in
      // that reason, because a partial answer presented as complete is worse than a named gap.
      const reason = `${dir}: ${say(e)}`;
      if (source.path === dir) {
        source.status = e && e.code === "ENOENT" ? "missing" : "error";
        source.reason = e && e.code === "ENOENT" ? "this directory does not exist" : reason;
      } else {
        source.status = source.status === "ok" ? "error" : source.status;
        source.reason = source.reason ? `${source.reason} · ${reason}` : reason;
      }
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target = null;
        let isDir = false;
        try {
          isDir = statSync(full).isDirectory();
          target = realOrNull(full);
        } catch (e) {
          // A junction whose target is gone. It is still a place skills were meant to come from, so it is
          // a source that says why it is empty rather than a row that silently disappears.
          children.push(
            sourceOf(
              {
                key: `link:${path.relative(source.path, full).replace(/\\/g, "/")}`,
                label: path.relative(source.path, full).replace(/\\/g, "/"),
                kind: "link",
                path: full,
                categoryBase: source.categoryBase,
                isLink: true,
                target: null,
              },
              { status: "error", reason: `the link's target cannot be read (${say(e)})` },
            ),
          );
          continue;
        }
        if (isDir) {
          // Its own source: same label as the folder, the target recorded, and the parent does not descend.
          children.push(
            sourceOf({
              key: `link:${path.relative(source.path, full).replace(/\\/g, "/")}`,
              label: path.relative(source.path, full).replace(/\\/g, "/"),
              kind: "link",
              path: full,
              categoryBase: source.categoryBase,
              isLink: true,
              target,
            }),
          );
          continue;
        }
        if (entry.name !== "SKILL.md") continue;
      } else if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase()) || depth >= MAX_DEPTH) continue;
        stack.push({ dir: full, depth: depth + 1 });
        continue;
      } else if (entry.name !== "SKILL.md") {
        continue;
      }
      // A SKILL.md: this directory is a skill.
      const real = realOrNull(full) || full;
      const key = real.toLowerCase();
      if (seen.has(key)) {
        duplicates.push({ name: path.basename(path.dirname(full)), path: full, source: source.key, keptBy: seen.get(key) });
        continue;
      }
      seen.set(key, source.key);
      let text = "";
      try {
        text = readFileSync(full, "utf8");
      } catch (e) {
        source.status = source.status === "ok" ? "error" : source.status;
        source.reason = source.reason ? `${source.reason} · ${full}: ${say(e)}` : `${full}: ${say(e)}`;
        continue;
      }
      const parsed = parseSkillText(text);
      // `rel` is the path the LIST draws: relative to the source's own base (the absolute path the heading above
      // the group prints), so every row reads as `category/skill/SKILL.md`. The whole absolute path stays on the
      // row for its tooltip — that is what settles "same name, different file" by hand.
      const rel = path.relative(source.categoryBase, full).split(/\\/).join("/");
      const parts = rel.split("/");
      const category = parts.length >= 3 ? parts[0] : null;
      rows.push({
        name: clip(parsed.name || path.basename(path.dirname(full)), NAME_MAX),
        description: clip(parsed.description || fallbackDescription(parsed.body), DESCRIPTION_MAX),
        category,
        source: source.key,
        sourceLabel: source.label,
        path: full,
        rel,
        realPath: real,
        isLink: !samePath(full, real),
        served: null,
      });
    }
  }
  rows.sort((a, b) => (a.category || "").localeCompare(b.category || "") || a.name.localeCompare(b.name));
  return rows;
}

// ---- the gateway's own answer ---------------------------------------------------------------------
// `GET /v1/skills` is the only report of what a run is actually SERVED (it resolves shadowing, disabled
// names, platform gates and plugin skills). It is also the half that can be missing: an old build has no
// such route, a keyed gateway answers 401, and a build whose route raises answers 500. Every one of those
// is a reason, not a failure — the disk half is still worth showing, and a row is only "not served" when
// the gateway actually answered.
export async function fetchGatewaySkills({ url, key = null, timeoutMs = 1800 } = {}) {
  if (!url) return { url: null, ok: false, status: 0, reason: "the panel has no gateway URL", skills: [] };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/v1/skills`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = "";
      try {
        const body = JSON.parse(text);
        detail = trim(body?.error?.message || body?.error || "");
      } catch {
        detail = trim(text).slice(0, 200);
      }
      const why =
        res.status === 401
          ? "the gateway refused the key (HTTP 401 — API_SERVER_KEY)"
          : `HTTP ${res.status}${detail ? ` — ${detail}` : ""}`;
      return { url, ok: false, status: res.status, reason: why, skills: [] };
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { url, ok: false, status: res.status, reason: "the gateway's answer was not JSON", skills: [] };
    }
    const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;
    if (!list) {
      return { url, ok: false, status: res.status, reason: "the gateway's answer carried no skill list", skills: [] };
    }
    const skills = list
      .map((s) => ({
        name: clip(s?.name, NAME_MAX),
        description: clip(s?.description, DESCRIPTION_MAX),
        category: trim(s?.category) || null,
      }))
      .filter((s) => s.name);
    return { url, ok: true, status: res.status, reason: null, skills };
  } catch (e) {
    const why =
      e?.name === "AbortError"
        ? `the gateway did not answer within ${Math.round(timeoutMs / 100) / 10}s`
        : `cannot reach the gateway at ${url}: ${say(e)}`;
    return { url, ok: false, status: 0, reason: why, skills: [] };
  } finally {
    clearTimeout(timer);
  }
}

// ---- the whole answer -----------------------------------------------------------------------------
export async function readSkillsIndex({ home, projects = [], gateway = {}, configText = null } = {}) {
  let text = configText;
  if (text == null) {
    try {
      text = readFileSync(hermesConfigPath(home), "utf8");
    } catch {
      text = "";
    }
  }
  // Named for what it is — the `skills:` block of the HERMES config.yaml — so it is never mistaken for this
  // panel's own config.json (test/paths.test.js polices `config.*Dir` as panel state, and this is neither).
  const hermesSkills = readSkillsConfig(text, { home });
  const roots = skillSources({ home, skills: hermesSkills, projects });
  const seen = new Map();
  const duplicates = [];
  const skills = [];

  // The profile first, and a junctioned directory goes in IMMEDIATELY after the source that found it —
  // not after every configured root — so the list reads like the tree it describes and the junction wins
  // the realpath dedupe over a later external entry pointing at the same target. Depth is bounded: a
  // junction chain is a chain of sources, and one that loops is caught by the walk's own visited set.
  const sources = [];
  const scanOne = (source, depth = 0) => {
    sources.push(source);
    // A source Hermes will not read is listed with its reason and nothing else: walking it would show skills
    // that no run ever loads, which is the one thing this tab must not do.
    if (source.status !== "ok") {
      source.skills = [];
      source.count = 0;
      return;
    }
    const children = [];
    source.skills = walkSource(source, { seen, duplicates, children });
    source.count = source.skills.length;
    skills.push(...source.skills);
    if (depth < MAX_DEPTH) for (const child of children) scanOne(child, depth + 1);
  };
  for (const root of roots) scanOne(root);

  const answer = await fetchGatewaySkills({ url: gateway.url, key: gateway.key });
  let gatewayOnly = [];
  if (answer.ok) {
    const served = new Set(answer.skills.map((s) => s.name.toLowerCase()));
    for (const row of skills) row.served = served.has(row.name.toLowerCase());
    const known = new Set(skills.map((row) => row.name.toLowerCase()));
    gatewayOnly = answer.skills
      .filter((s) => !known.has(s.name.toLowerCase()))
      .map((s) => ({
        name: s.name,
        description: s.description,
        category: s.category,
        source: "gateway",
        sourceLabel: "Gateway",
        path: null,
        rel: null,
        realPath: null,
        isLink: false,
        served: true,
      }))
      .sort((a, b) => (a.category || "").localeCompare(b.category || "") || a.name.localeCompare(b.name));
  }
  const rows = [...skills, ...gatewayOnly];
  const onDisk = skills.length;
  const counts = {
    sources: sources.length,
    readable: sources.filter((s) => s.status === "ok").length,
    skills: onDisk,
    gatewayOnly: gatewayOnly.length,
    rows: rows.length,
    served: answer.ok ? rows.filter((r) => r.served === true).length : null,
    unserved: answer.ok ? rows.filter((r) => r.served === false).length : null,
    unknown: answer.ok ? 0 : rows.length,
    duplicates: duplicates.length,
  };
  return {
    checkedAt: new Date().toISOString(),
    home,
    configPath: hermesConfigPath(home),
    sources,
    skills: rows,
    duplicates: duplicates.slice(0, 40),
    gateway: { url: answer.url, ok: answer.ok, status: answer.status, reason: answer.reason, count: answer.skills.length },
    counts,
  };
}
