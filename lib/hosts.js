// Where a project's branches and pull requests actually live.
//
// The board used to know exactly one host. `https://github.com/<prRepo>/pull/<n>` was written out in server.js and
// `<repo>/tree/<branch>` in lib/project.js, and a project whose remote was not github.com got no link at all — which
// is why every SEFL Bitbucket repo on this board showed a PR number it could not open. That is a fact about a
// repository, not a fact about this code, so it now lives in a file the reader edits: logs/hosts.json.
//
// Three rules decide the shape of this module:
//
//   1. A host record is DATA, and every link is a TEMPLATE over the tokens `{base} {owner} {repo} {projectKey}
//      {repoSlug} {branch} {sha} {pr} {main}`. A host nobody has seen yet (a GitLab, a Gitea, a second Bitbucket)
//      is mapped by adding a record, never by a patch: nothing in this file names github or bitbucket except the
//      seed file itself, and even that is read from disk.
//   2. An unmapped project gets NO link, and a sentence saying why. A guessed URL that 404s is worse than plain
//      text: it costs the reader a click to learn the panel was wrong. Nothing here derives a URL from a host
//      record it cannot resolve, and nothing falls back to github.com.
//   3. The landing doctrine is data too, and it is the host's, not the project's: what merging means on
//      git.sefl.com (a pull request into master for `code_review_java`, merged by a human) is not what it means on
//      GitHub. lib/merge-prompt.js injects it into the prompt a landing agent runs on.
//
// The file lives under logs/, which is this panel's own gitignored state, and NOT in logs/projects.json, which the
// discovery sweep rewrites every pass. `hosts.seed.json` (committed) supplies the defaults — the two hosts this
// board actually has and the repos it monitors — and logs/hosts.json overrides them per host id and per project,
// so a new seed record reaches an existing install without the reader merging anything by hand.
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

// The whole vocabulary a template may use. A template naming anything else is refused, at load time and at
// render time, instead of producing a URL with `{branch}` still in it.
export const HOST_TOKENS = ["base", "owner", "repo", "projectKey", "repoSlug", "branch", "sha", "pr", "main"];

export const HOST_KINDS = ["github", "bitbucket-server"];

export const DEFAULT_HOSTS_FILE = "logs/hosts.json";
export const DEFAULT_SEED_FILE = "hosts.seed.json";

// The link kinds the board and the prompt know how to ask for. A host may carry any subset; `branch` and `pull`
// are the two the cells need, and a record missing either is invalid (see validateHost).
export const LINK_KINDS = ["repo", "branch", "pull", "commit", "newPull"];

const TOKEN_RE = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

function clean(value) {
  return String(value ?? "").trim();
}

function trimBase(value) {
  return clean(value).replace(/\/+$/, "");
}

// A record is only usable if every one of these holds. The errors are sentences the reader can act on, because the
// one place this is reported is a log line and the Settings-style summary, never a stack trace.
export function validateHostRecord(id, rec) {
  const errors = [];
  const name = clean(id);
  if (!name) errors.push("a host record needs an id");
  if (!rec || typeof rec !== "object") return [`host "${name}": not an object`];
  if (!HOST_KINDS.includes(clean(rec.kind))) {
    errors.push(`host "${name}": kind must be one of ${HOST_KINDS.join(", ")} (got ${JSON.stringify(rec.kind)})`);
  }
  const base = trimBase(rec.base);
  if (!/^https?:\/\/[^/\s]+/i.test(base)) errors.push(`host "${name}": base must be an http(s) URL (got ${JSON.stringify(rec.base)})`);
  if (rec.coordinates != null && typeof rec.coordinates !== "object") errors.push(`host "${name}": coordinates must be an object`);
  if (rec.links == null || typeof rec.links !== "object") {
    errors.push(`host "${name}": links is missing`);
  } else {
    for (const kind of LINK_KINDS) {
      const tpl = rec.links[kind];
      if (tpl == null) continue;
      if (typeof tpl !== "string" || !tpl.trim()) {
        errors.push(`host "${name}": links.${kind} must be a non-empty template`);
        continue;
      }
      for (const token of templateTokens(tpl)) {
        if (!HOST_TOKENS.includes(token)) errors.push(`host "${name}": links.${kind} uses unknown token {${token}}`);
      }
      if (!tpl.includes("{base}")) errors.push(`host "${name}": links.${kind} does not start from {base}`);
    }
    for (const kind of ["branch", "pull"]) {
      if (!rec.links[kind]) errors.push(`host "${name}": links.${kind} is required (the board's branch and PR cells read it)`);
    }
  }
  if (rec.api == null || typeof rec.api !== "object") {
    errors.push(`host "${name}": api is missing (listOpenPrs + tokenEnv are what a PR list needs)`);
  } else {
    if (!clean(rec.api.listOpenPrs)) errors.push(`host "${name}": api.listOpenPrs is required`);
    else {
      for (const token of templateTokens(rec.api.listOpenPrs)) {
        if (!HOST_TOKENS.includes(token)) errors.push(`host "${name}": api.listOpenPrs uses unknown token {${token}}`);
      }
    }
    if (rec.api.listPullRequests != null) {
      for (const token of templateTokens(rec.api.listPullRequests)) {
        if (!HOST_TOKENS.includes(token)) errors.push(`host "${name}": api.listPullRequests uses unknown token {${token}}`);
      }
    }
    if (!clean(rec.api.tokenEnv)) errors.push(`host "${name}": api.tokenEnv is required (the env var holding the token)`);
    if (rec.api.transport != null && !["rest", "gh"].includes(clean(rec.api.transport))) {
      errors.push(`host "${name}": api.transport must be "rest" or "gh" (got ${JSON.stringify(rec.api.transport)})`);
    }
  }
  if (!clean(rec.landing)) errors.push(`host "${name}": landing is required (the prose a landing agent is given)`);
  return errors;
}

export function templateTokens(template) {
  const out = [];
  for (const m of String(template || "").matchAll(TOKEN_RE)) out.push(m[1]);
  return out;
}

// The values a template sees. Coordinates are the only per-project part; `main` is the project's base branch and
// the rest come from the row being linked.
function valuesFor(mapping, extra = {}) {
  const c = mapping.coordinates || {};
  return {
    base: trimBase(mapping.base),
    owner: clean(c.owner),
    repo: clean(c.repo),
    projectKey: clean(c.projectKey),
    repoSlug: clean(c.repoSlug),
    branch: clean(extra.branch),
    sha: clean(extra.sha),
    pr: extra.pr == null ? "" : clean(extra.pr),
    main: clean(extra.main),
  };
}

// A token is encoded by WHERE it sits, not by what it holds, because the two contexts want different answers for
// the same branch name: a GitHub `tree/feature/foo` needs the slash left alone (one path segment per branch
// segment, which is the shape GitHub documents), while Bitbucket's `browse?at=refs/heads/feature/foo` wants the
// whole ref as one query value (`refs%2Fheads%2Ffeature%2Ffoo`). `base` is a URL and is never encoded — encoding it
// per segment would turn `https://git.sefl.com` into `https%3A//git.sefl.com`.
export function renderTemplate(template, values = {}) {
  const tpl = String(template || "");
  if (!tpl.trim()) throw new Error("empty template");
  const queryAt = tpl.indexOf("?");
  return tpl.replace(TOKEN_RE, (whole, key, offset) => {
    if (!HOST_TOKENS.includes(key)) throw new Error(`unknown token ${whole}`);
    const raw = values[key];
    if (raw == null || String(raw) === "") throw new Error(`no value for ${whole}`);
    const text = String(raw);
    if (key === "base") return text;
    if (queryAt >= 0 && offset > queryAt) return encodeURIComponent(text);
    return text.split("/").map(encodeURIComponent).join("/");
  });
}

// Prose keeps its tokens but is not URL-encoded: a doctrine says `refs/heads/{branch}` and a reader has to read it.
// Unknown tokens are left alone here — the prose belongs to the reader, and a `{thing}` in their own sentence is
// their business, unlike a link, where it would be a broken URL.
export function renderProse(text, values = {}) {
  return String(text || "").replace(TOKEN_RE, (whole, key) => {
    if (!HOST_TOKENS.includes(key)) return whole;
    const raw = values[key];
    return raw == null || String(raw) === "" ? whole : String(raw);
  });
}

// Which host a project belongs to, and with which coordinates.
//
// Precedence, most specific last: the host record's own coordinates are the defaults (github's `JLRoper`,
// Bitbucket's `IT`), a project may carry its own on the record the discovery sweep keeps, and logs/hosts.json's
// `projects.<name>.coordinates` wins over both — that file is the reader's ruling and the only one of the three the
// scan never rewrites. That is how one repo in `IT` and another in `SA` are told apart without a second host.
export function resolveMapping(doc, project = {}) {
  const name = clean(project.name);
  const entry = (doc?.projects || {})[name] || {};
  const hostId = clean(entry.host || project.host);
  if (!hostId) {
    return { id: null, why: `${name || "this project"} has no host mapping — add projects.${name || "<name>"}.host in logs/hosts.json (the board will not guess a link)` };
  }
  const host = (doc?.hosts || {})[hostId];
  if (!host) return { id: hostId, why: `host "${hostId}" is not defined in logs/hosts.json (or it was refused: ${(doc?.warnings || []).find((w) => w.startsWith(`host "${hostId}"`)) || "no record with that id"})` };
  const coordinates = { ...(host.coordinates || {}), ...(project.coordinates || {}), ...(entry.coordinates || {}) };
  return { id: hostId, kind: clean(host.kind), base: trimBase(host.base), coordinates, links: host.links || {}, api: host.api || {}, landing: clean(host.landing) };
}

// One link of one kind, or null and the sentence explaining what is missing. Every caller gets the same words, so
// the branch cell, the PR cell, the detail strip and the tests cannot disagree about why a cell is plain text.
export function linkFor(doc, project, kind, extra = {}) {
  const mapping = resolveMapping(doc, project);
  if (!mapping.id) return { url: null, why: mapping.why, mapping };
  if (mapping.why) return { url: null, why: mapping.why, mapping };
  const template = mapping.links?.[kind];
  if (!template) return { url: null, why: `host "${mapping.id}" has no links.${kind} template`, mapping };
  try {
    const values = valuesFor(mapping, { main: project.mainBranch, ...extra });
    return { url: renderTemplate(template, values), why: "", mapping };
  } catch (e) {
    return { url: null, why: `host "${mapping.id}" cannot build links.${kind} for ${clean(project.name)}: ${String((e && e.message) || e)}`, mapping };
  }
}

// What a PR list would call. A host may name both the open-PR endpoint (the one the reader is handed) and the
// all-states one (which is what the board needs to know a branch's PR was merged); `listPullRequests` wins when it
// exists. `transport` says how the panel reads it: `gh` for a GitHub checkout with the CLI, `rest` for a JSON API
// reached with a bearer token from `tokenEnv`.
export function prListing(doc, project) {
  const mapping = resolveMapping(doc, project);
  if (!mapping.id) return { url: null, why: mapping.why, mapping };
  const api = mapping.api || {};
  const template = clean(api.listPullRequests) || clean(api.listOpenPrs);
  if (!template) return { url: null, why: `host "${mapping.id}" has no api.listOpenPrs endpoint`, mapping };
  try {
    return {
      url: renderTemplate(template, valuesFor(mapping, { main: project.mainBranch })),
      openUrl: api.listOpenPrs ? renderTemplate(api.listOpenPrs, valuesFor(mapping, { main: project.mainBranch })) : null,
      transport: clean(api.transport) || "rest",
      tokenEnv: clean(api.tokenEnv),
      kind: mapping.kind,
      coordinates: mapping.coordinates,
      id: mapping.id,
      why: "",
      mapping,
    };
  } catch (e) {
    return { url: null, why: `host "${mapping.id}" cannot build its PR list endpoint: ${String((e && e.message) || e)}`, mapping };
  }
}

// The doctrine, ready for a prompt: the prose with this project's own coordinates filled in. `extra` carries the
// branch being landed, which is the one token the prompt knows and the project record does not (the tree in front of
// the agent may be on any branch).
export function landingFor(doc, project, extra = {}) {
  const mapping = resolveMapping(doc, project);
  if (!mapping.id || !mapping.landing) return null;
  return {
    id: mapping.id,
    kind: mapping.kind,
    base: mapping.base,
    text: renderProse(mapping.landing, valuesFor(mapping, { main: project.mainBranch, ...extra })),
    pullUrl: (() => {
      const link = linkFor(doc, project, "pull", { pr: 1, ...extra });
      return link.url || null;
    })(),
  };
}

// ---- the file ------------------------------------------------------------------------------------------------

function emptyDoc(extra = {}) {
  return { version: 1, hosts: {}, projects: {}, warnings: [], file: null, seedFile: null, ...extra };
}

// Read one file, validating every host record. A record with a typo is DROPPED with a warning rather than taking
// the board's links down with it: one bad host id is a project with plain text, not a panel that will not start.
export function readHostsFile(file) {
  const doc = emptyDoc({ file: file ? path.resolve(file) : null });
  if (!file) return doc;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if (e && e.code === "ENOENT") return doc;
    doc.warnings.push(`${file}: ${String((e && e.message) || e)} — no host mapping is in force`);
    return doc;
  }
  if (!raw || typeof raw !== "object") {
    doc.warnings.push(`${file}: not a JSON object — no host mapping is in force`);
    return doc;
  }
  for (const [id, rec] of Object.entries(raw.hosts || {})) {
    const errors = validateHostRecord(id, rec);
    if (errors.length) {
      doc.warnings.push(...errors);
      continue;
    }
    doc.hosts[id] = rec;
  }
  for (const [name, entry] of Object.entries(raw.projects || {})) {
    if (!entry || typeof entry !== "object") {
      doc.warnings.push(`projects.${name}: not an object — ignored`);
      continue;
    }
    if (!clean(entry.host)) {
      doc.warnings.push(`projects.${name}: no host id — ignored`);
      continue;
    }
    doc.projects[name] = entry;
  }
  return doc;
}

// The seed supplies defaults; the live file wins per host id and per project. Merging (rather than copying the seed
// into the live file on first boot) is what lets a new host record ship in the seed and reach an install whose
// logs/hosts.json already exists.
export function mergeDocs(seed, live) {
  const doc = emptyDoc({ file: live?.file || null, seedFile: seed?.file || null });
  doc.hosts = { ...(seed?.hosts || {}), ...(live?.hosts || {}) };
  doc.projects = { ...(seed?.projects || {}), ...(live?.projects || {}) };
  doc.warnings = [...(seed?.warnings || []), ...(live?.warnings || [])];
  return doc;
}

// Read the pair and merge them. Cached on (mtime,size) of both files so the scan can ask for a link per row, per
// pass, without a stat storm — and a reader's edit is live on the next pass, not on the next restart.
const cache = new Map();
export function hostsDoc({ file = DEFAULT_HOSTS_FILE, seedFile = DEFAULT_SEED_FILE, ttlMs = 1500, now = Date.now() } = {}) {
  const livePath = file ? path.resolve(file) : null;
  const seedPath = seedFile ? path.resolve(seedFile) : null;
  const stamp = (p) => {
    if (!p) return "-";
    try {
      const s = statSync(p);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return "missing";
    }
  };
  const key = `${stamp(livePath)}|${stamp(seedPath)}`;
  const hit = cache.get(livePath || "-");
  if (hit && hit.key === key && now - hit.at < ttlMs) return hit.doc;
  const doc = mergeDocs(readHostsFile(seedPath), readHostsFile(livePath));
  cache.set(livePath || "-", { key, at: now, doc });
  return doc;
}

export function resetHostsCache() {
  cache.clear();
}

// Create logs/hosts.json when it is not there, so the file the panel reads is a file the reader can find and edit.
// It starts EMPTY on purpose: the seed holds the defaults, and a copy of them here would freeze them.
export function ensureHostsFile({ file = DEFAULT_HOSTS_FILE, seedFile = DEFAULT_SEED_FILE, log = () => {} } = {}) {
  if (!file) return { created: false, file: null };
  const target = path.resolve(file);
  try {
    statSync(target);
    return { created: false, file: target };
  } catch {
    /* not there yet: write the skeleton */
  }
  const body = {
    version: 1,
    note: "Reader-edited host mappings: where this board's projects keep their branches and pull requests. Records here override hosts.seed.json per host id and per project; docs/hosts.md has the tokens and the doctrine. This file is not rewritten by the discovery scan.",
    hosts: {},
    projects: {},
  };
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    log(`hosts: created ${target} (defaults come from ${seedFile ? path.resolve(seedFile) : "no seed"})`);
    resetHostsCache();
    return { created: true, file: target };
  } catch (e) {
    log(`hosts: could not create ${target}: ${String((e && e.message) || e)}`);
    return { created: false, file: target, error: String((e && e.message) || e) };
  }
}

// Write ONE project's mapping into the live file, leaving every host record and every other project exactly as it
// was. `coordinates` is replaced wholesale (a merge would make an override impossible to remove).
export function saveProjectMapping(file, projectName, { host, coordinates = null, log = () => {} } = {}) {
  const name = clean(projectName);
  const hostId = clean(host);
  if (!name) throw new Error("a project name is required");
  if (!hostId) throw new Error("a host id is required");
  const target = path.resolve(file || DEFAULT_HOSTS_FILE);
  let raw = { version: 1, hosts: {}, projects: {} };
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8"));
    if (parsed && typeof parsed === "object") raw = { ...parsed };
  } catch (e) {
    if (e && e.code !== "ENOENT") throw new Error(`${target} is not readable JSON: ${String((e && e.message) || e)}`);
  }
  raw.version = raw.version || 1;
  raw.hosts = raw.hosts || {};
  raw.projects = { ...(raw.projects || {}) };
  const entry = { ...(raw.projects[name] || {}), host: hostId };
  const coords = {};
  for (const [k, v] of Object.entries(coordinates || {})) if (clean(v)) coords[k] = clean(v);
  if (Object.keys(coords).length) entry.coordinates = coords;
  else delete entry.coordinates;
  raw.projects[name] = entry;
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  resetHostsCache();
  log(`hosts: mapped ${name} -> ${hostId}${Object.keys(coords).length ? ` (${Object.entries(coords).map(([k, v]) => `${k}=${v}`).join(", ")})` : ""}`);
  return raw;
}

// ---- proposing a mapping ---------------------------------------------------------------------------------------

// What a remote URL says about where it lives: a host id this board ALREADY has (matched on the URL's hostname,
// never on the kind — a second Bitbucket is another record, not another code path) and the coordinates the paths
// carry. Anything else is refused with the reason, because the one thing a proposal must not do is invent a host.
//
// The shapes a real remote uses, all of them seen on this box:
//   git@github.com:owner/repo.git                      github, owner/repo
//   https://github.com/owner/repo(.git)                github, owner/repo
//   ssh://git@git.sefl.com/it/email-multi.git          bitbucket-server, IT + email-multi
//   https://git.sefl.com/scm/IT/email-multi.git        bitbucket-server, IT + email-multi
export function parseRemote(remoteUrl) {
  const url = clean(remoteUrl);
  if (!url) return { why: "this project has no remote URL to read" };
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+)$/i.exec(url);
  if (!m) return { why: `cannot read a host out of ${url}` };
  const hostname = m[1].toLowerCase();
  // A drive letter or a bare directory ("C:/ProjectDevelopment/x") matches the shape of a remote and is not one.
  // A hostname has a dot; `localhost` is the one exception, and it is only ever a proof server.
  if (!hostname.includes(".") && hostname !== "localhost") return { why: `${url} is a local path, not a remote URL — there is no host to map` };
  const rest = m[2].replace(/^\/+/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const segments = rest.split("/").filter(Boolean).map(decodeURIComponent);
  const keyed = segments[0] && segments[0].toLowerCase() === "scm" ? segments.slice(1) : segments;
  return { hostname, segments: keyed, path: keyed.slice(-2) };
}

export function proposeMapping(doc, project, remoteUrl) {
  const parsed = parseRemote(remoteUrl);
  if (parsed.why) return { ok: false, why: parsed.why, remoteUrl: clean(remoteUrl) };
  const hosts = doc?.hosts || {};
  const match = Object.entries(hosts).find(([, rec]) => {
    try {
      return new URL(trimBase(rec.base)).hostname.toLowerCase() === parsed.hostname;
    } catch {
      return false;
    }
  });
  if (!match) {
    return {
      ok: false,
      remoteUrl: clean(remoteUrl),
      hostname: parsed.hostname,
      why: `no host record has base ${parsed.hostname} — add one to logs/hosts.json (or hosts.seed.json) and this project can be mapped by template`,
    };
  }
  const [id, rec] = match;
  if (parsed.path.length < 2) return { ok: false, remoteUrl: clean(remoteUrl), hostname: parsed.hostname, why: `${parsed.hostname} URL ${clean(remoteUrl)} does not carry two path segments (owner/repo or project/slug)` };
  const [first, second] = parsed.path;
  const coordinates = rec.kind === "bitbucket-server" ? { projectKey: first.toUpperCase(), repoSlug: second } : { owner: first, repo: second };
  return { ok: true, host: id, kind: rec.kind, base: trimBase(rec.base), coordinates, remoteUrl: clean(remoteUrl), hostname: parsed.hostname, why: "" };
}

// The whole mapping, as the page reads it: what the project resolves to today, the repository page it can build, and
// the two templates the cells will use. Deliberately no sample branch or PR: the header's job is to say where a link
// GOES, and inventing `master` for a row whose branch is something else would be the kind of guess this module exists
// to refuse.
export function mappingView(doc, project) {
  const mapping = resolveMapping(doc, project);
  const out = {
    project: clean(project.name),
    host: mapping.id || null,
    kind: mapping.id ? mapping.kind : null,
    coordinates: mapping.id ? mapping.coordinates : null,
    why: mapping.id ? "" : mapping.why,
    links: {},
    templates: {},
    api: null,
    landing: false,
  };
  if (mapping.id) {
    const repo = linkFor(doc, project, "repo", {});
    if (repo.url) out.links.repo = repo.url;
    out.templates = { branch: mapping.links?.branch || null, pull: mapping.links?.pull || null };
    out.api = mapping.api?.listOpenPrs || null;
    out.landing = Boolean(mapping.landing);
  }
  return out;
}

// The object the server hands around: one file pair, one cache, the same answers the pure functions give. A caller
// that holds this never has to think about mtime or about which file won.
export class Hosts {
  constructor({ file = DEFAULT_HOSTS_FILE, seedFile = DEFAULT_SEED_FILE, ttlMs = 1500, log = () => {} } = {}) {
    this.file = file;
    this.seedFile = seedFile;
    this.ttlMs = ttlMs;
    this.log = log;
    this.cached = null;
    this.at = 0;
  }
  doc({ fresh = false } = {}) {
    const now = Date.now();
    if (!fresh && this.cached && now - this.at < this.ttlMs) return this.cached;
    this.cached = hostsDoc({ file: this.file, seedFile: this.seedFile, now, ttlMs: this.ttlMs });
    this.at = now;
    return this.cached;
  }
  linkFor(project, kind, extra = {}) {
    return linkFor(this.doc(), project, kind, extra);
  }
  prListing(project) {
    return prListing(this.doc(), project);
  }
  landing(project, extra = {}) {
    return landingFor(this.doc(), project, extra);
  }
  view(project) {
    return mappingView(this.doc(), project);
  }
  ensure() {
    return ensureHostsFile({ file: this.file, seedFile: this.seedFile, log: this.log });
  }
  save(projectName, mapping) {
    return saveProjectMapping(this.file, projectName, { ...mapping, log: this.log });
  }
  // What /api/state carries: the host ids a reader can choose from, and where the file is. The per-project mapping
  // travels with each project instead (see projectHosts), so a section repaint reads it from its own project.
  state() {
    const doc = this.doc();
    return {
      file: doc.file,
      seedFile: doc.seedFile,
      hosts: Object.fromEntries(
        Object.entries(doc.hosts).map(([id, rec]) => [id, { kind: clean(rec.kind), base: trimBase(rec.base), coordinates: rec.coordinates || {}, landing: Boolean(clean(rec.landing)), api: rec.api || null }]),
      ),
      warnings: doc.warnings,
    };
  }
}

