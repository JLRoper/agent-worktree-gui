// ---- the permissions actually in force, and where each one comes from -----------------------------
// The Permissions tab is read-only: it reports what the files and the gateway say TODAY, never a
// snapshot. Five of the sources are blocks in the gateway's own config.yaml — approvals,
// command_allowlist, tool_loop_guardrails, platform_toolsets and code_execution — and the tab has to
// survive that file being missing, a block being absent, or a block being malformed. So the blocks are
// parsed from the file's text at request time, every row keeps the 1-based line it was read from, and
// a source that cannot be read says why instead of showing a stale or guessed value.
//
// The other three answers are different kinds of thing and are reported as their own sources:
//   * the gateway's advertised surface, `GET <gateway>/v1/capabilities`. Without a token the gateway
//     answers 401; that is "not exposed, needs a token", never a guess at what the features are.
//   * this panel's standing branch policy, config.json's `remoteBranchPolicy` (plus each project's
//     override, which wins over the global one).
//   * this panel's own remote-write layer, lib/remote-writes.js: the grant choices, the request
//     window that bounds a parked question, and the grants that live in memory or are consumed once.
//
// Nothing here writes. A row whose source line cannot be found keeps its value and says so; the tab
// must never claim a `file:line` it did not read.

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { blockRange, hermesConfigPath } from "./hermes-config.js";
import { hermesHome } from "./hermes-runtime.js";
import { pathKey, resolveConfigPath } from "./paths.js";
import {
  DEFAULT_GRANT_TIMEOUT_SECONDS,
  DEFAULT_POLICY,
  GRANT_CHOICES,
  MAX_GRANT_TIMEOUT_SECONDS,
  POLICIES,
  policyFrom,
} from "./remote-writes.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The checkout root, which is the `here` server.js resolves its own config from. This module asks
// lib/paths.js the SAME question rather than deriving a second answer: PANEL_CONFIG wins, then a config
// moved into the data directory, then `<checkout>/config.json`. A copy of that rule here is how the tab
// came to report the checkout's policy while a sandbox panel was running on its own file.
export const CHECKOUT_DIR = path.resolve(HERE, "..");
export const REMOTE_WRITES_PATH = path.join(HERE, "remote-writes.js");
export const CAPABILITIES_PATH = "/v1/capabilities";

// The five config.yaml blocks the tab reports, in the order a reader looks for them: what may run
// without asking first, then the guards around a looping agent, then which toolsets a platform gets,
// then the code-execution sandbox those calls run in.
export const BLOCKS = [
  { key: "approvals", label: "Approvals", shape: "map" },
  { key: "command_allowlist", label: "Always-ask commands", shape: "list" },
  { key: "tool_loop_guardrails", label: "Tool loop guardrails", shape: "map" },
  { key: "platform_toolsets", label: "Platform toolsets", shape: "map" },
  { key: "code_execution", label: "Code execution", shape: "map" },
];

export class BlockParseError extends Error {
  constructor(message, line) {
    super(message);
    this.name = "BlockParseError";
    this.line = line;
  }
}

// A `#` starts a comment only outside a quote and only where a YAML comment can start (the beginning
// of the value or after whitespace). An apostrophe inside a plain scalar — "the reader's file" — is
// not an opening quote, which is why the previous character decides.
function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const prev = i === 0 ? "" : text[i - 1];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if ((ch === '"' || ch === "'") && (i === 0 || /[\s[,]/.test(prev))) {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(prev))) return text.slice(0, i);
  }
  return text;
}

function unquote(text) {
  const t = String(text ?? "").trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

// A comma-separated inline list, split with quotes respected (`["a, b", c]` is two items).
function splitInlineList(body, line) {
  const out = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    const prev = i === 0 ? "" : body[i - 1];
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"') {
        if (i + 1 < body.length) cur += body[++i];
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if ((ch === '"' || ch === "'") && (i === 0 || /[\s[,]/.test(prev))) {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (quote) throw new BlockParseError("an unterminated quote in an inline list", line);
  out.push(cur);
  return out.map(unquote).filter((s) => s !== "");
}

// What a scalar looks like on screen: quotes removed, an inline list shown as `a, b`.
export function displayValue(raw) {
  const t = String(raw ?? "").trim();
  if (t.startsWith("[") && t.endsWith("]")) return splitInlineList(t.slice(1, -1), 0).join(", ");
  return unquote(t);
}

function parseValue(raw, line) {
  const text = stripComment(String(raw ?? "")).trim();
  if (!text) return { value: null, items: null };
  if (text.startsWith("[")) {
    if (!text.endsWith("]")) throw new BlockParseError("an inline list does not close with `]`", line);
    return { value: text, items: splitInlineList(text.slice(1, -1), line) };
  }
  if (text.startsWith("{")) throw new BlockParseError("an inline map is not read by this parser", line);
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0];
    if (text.length < 2 || !text.endsWith(quote)) throw new BlockParseError("an unterminated quoted value", line);
  }
  return { value: text, items: null };
}

// Parse the body of one top-level block into a small tree:
//   { key, value, line, items: [{ value, line }] | null, children: [entry] }
// It understands exactly the YAML these blocks use — nested maps, `- item` lists, inline `[a, b]`
// lists, quoted and plain scalars — and refuses anything else with the line it gave up on, so a
// malformed block becomes a reason instead of a wrong permission.
export function parseYamlBlock(lines, start, end = lines.length) {
  const header = String(lines[start] ?? "").trim();
  const hm = /^([A-Za-z0-9_]+):\s*(?:#.*)?$/.exec(header);
  if (!hm) throw new BlockParseError("not a top-level `name:` header", start + 1);
  const root = { key: hm[1], value: null, line: start + 1, items: null, children: [], childIndent: null };
  const stack = [{ indent: 0, entry: root }];
  let baseIndent = null;

  for (let i = start + 1; i < end; i += 1) {
    const raw = String(lines[i] ?? "");
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    if (/^\t/.test(raw) || /^ *\t/.test(raw)) throw new BlockParseError("a tab in the indentation", i + 1);
    const indent = raw.match(/^ */)[0].length;
    if (indent === 0) throw new BlockParseError("a line at column 0 inside the block", i + 1);
    if (baseIndent === null) baseIndent = indent;
    if (indent < baseIndent) throw new BlockParseError("the indentation steps back outside the block", i + 1);

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent.indent >= indent) throw new BlockParseError("a line with no parent key", i + 1);
    if (parent.entry.childIndent === null) parent.entry.childIndent = indent;
    else if (parent.entry.childIndent !== indent) {
      throw new BlockParseError(`the indentation changes from ${parent.entry.childIndent} to ${indent} spaces`, i + 1);
    }

    const content = raw.slice(indent);
    const list = /^-\s*(.*)$/.exec(content);
    if (list) {
      if (parent.entry.value !== null) throw new BlockParseError("a list item under a key that already has a value", i + 1);
      if (parent.entry.children.length) throw new BlockParseError("a list item under a key that holds a map", i + 1);
      if (!parent.entry.items) parent.entry.items = [];
      const item = parseValue(list[1], i + 1);
      if (item.value === null) throw new BlockParseError("an empty list item", i + 1);
      parent.entry.items.push({ value: item.value, line: i + 1 });
      continue;
    }

    // A YAML key may carry spaces (`force push: true`), so the key is anything up to the first
    // colon that is not itself a comment. A list item is matched above and never reaches this.
    const map = /^([^:#]+):(?:\s(.*))?$/.exec(content);
    if (!map) throw new BlockParseError("expected `key: value` or `- item`", i + 1);
    if (parent.entry.items) throw new BlockParseError("a map key inside a list", i + 1);
    const key = map[1].trim();
    const parsed = parseValue(map[2] ?? "", i + 1);
    if (parent.entry.children.some((child) => child.key === key)) {
      throw new BlockParseError(`duplicate key \`${key}\``, i + 1);
    }
    const entry = { key, value: parsed.value, line: i + 1, items: parsed.items, children: [], childIndent: null };
    parent.entry.children.push(entry);
    if (entry.value === null) stack.push({ indent, entry });
  }
  return root;
}

function flattenEntries(entries, prefix = []) {
  const rows = [];
  for (const entry of entries) {
    const name = [...prefix, entry.key].join(".");
    if (entry.value !== null) rows.push({ name, value: displayValue(entry.value), line: entry.line });
    else if (entry.items) {
      entry.items.forEach((item, idx) => rows.push({ name: `${name}[${idx + 1}]`, value: displayValue(item.value), line: item.line }));
    }
    if (entry.children.length) rows.push(...flattenEntries(entry.children, [...prefix, entry.key]));
  }
  return rows;
}

// A platform maps to one toolset list: `cli: [hermes-cli]` or a key with `- toolset` items under it.
function platformRows(root) {
  return root.children.map((entry) => {
    let value = "";
    if (entry.value !== null) value = displayValue(entry.value);
    else if (entry.items) value = entry.items.map((item) => displayValue(item.value)).join(", ");
    else if (entry.children.length) value = flattenEntries(entry.children).map((r) => `${r.name}: ${r.value}`).join(", ");
    return { name: entry.key, value: value || "(empty)", line: entry.line };
  });
}

function rowsForBlock(block, root) {
  if (block.shape === "list") {
    if (root.value !== null) throw new BlockParseError("expected a list, found a scalar", root.line);
    if (root.children.length) {
      throw new BlockParseError("expected a list, found a map", root.children[0].line || root.line);
    }
    return (root.items || []).map((item) => ({
      name: displayValue(item.value),
      value: "always ask",
      line: item.line,
    }));
  }
  if (root.items) throw new BlockParseError("expected a map, found a list", root.line);
  if (block.key === "platform_toolsets") return platformRows(root);
  return flattenEntries(root.children);
}

const readText = (file) => {
  try {
    return { text: readFileSync(file, "utf8"), reason: null, code: null };
  } catch (e) {
    const code = String((e && e.code) || "");
    const why =
      code === "ENOENT"
        ? `the file was not found at ${file}`
        : `the file could not be read at ${file} (${code || (e && e.message) || "unknown error"})`;
    return { text: null, reason: why, code };
  }
};

const lineOf = (text, needle, from = 1) => {
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = Math.max(0, from - 1); i < lines.length; i += 1) {
    if (lines[i].includes(needle)) return i + 1;
  }
  return null;
};

const sourceAt = (file, line) => (line ? `${file}:${line}` : file);

function yamlSource(block, { configPath, text, fileReason }) {
  const base = {
    key: block.key,
    label: block.label,
    kind: "yaml",
    file: configPath,
    line: null,
    source: configPath,
    status: "ok",
    reason: null,
    rows: [],
  };
  if (text === null) return { ...base, status: "unreadable", reason: fileReason };
  const lines = String(text).split(/\r?\n/);
  const range = blockRange(lines, block.key);
  if (!range) {
    return { ...base, status: "missing", reason: `no top-level \`${block.key}:\` block in ${configPath}` };
  }
  base.line = range.start + 1;
  base.source = sourceAt(configPath, base.line);
  let root;
  try {
    root = parseYamlBlock(lines, range.start, range.end);
  } catch (e) {
    return { ...base, status: "malformed", reason: `line ${e.line || base.line}: ${e.message}` };
  }
  try {
    base.rows = rowsForBlock(block, root).map((row) => ({ ...row, source: sourceAt(configPath, row.line) }));
  } catch (e) {
    return { ...base, status: "malformed", reason: `line ${e.line || base.line}: ${e.message}` };
  }
  return base;
}

// ---- the gateway's advertised surface ------------------------------------------------------------
// The only live source. A keyed gateway answers 401 without a token, which is a fact about the
// deployment, not a set of features to guess at; the tab prints that sentence and no rows.
export async function fetchGatewayCapabilities({ url, key = null, timeoutMs = 1800, fetchImpl = globalThis.fetch } = {}) {
  const endpoint = url ? `${String(url).replace(/\/+$/, "")}${CAPABILITIES_PATH}` : null;
  const base = {
    key: "gateway",
    label: "Gateway advertised surface",
    kind: "gateway",
    file: null,
    line: null,
    endpoint,
    source: endpoint || "(no gateway URL)",
    status: "unreadable",
    reason: null,
    rows: [],
  };
  if (!url) return { ...base, reason: "the panel has no gateway URL" };
  if (typeof fetchImpl !== "function") return { ...base, reason: "this build has no fetch to ask the gateway with" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(endpoint, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (res.status === 401) {
      return {
        ...base,
        status: "unauthorized",
        reason: "not exposed, needs a token (HTTP 401 — set apiServer.key or API_SERVER_KEY)",
      };
    }
    if (!res.ok) {
      let detail = "";
      try {
        const body = JSON.parse(text);
        detail = String(body?.error?.message || body?.error || "").trim();
      } catch {
        detail = String(text || "").trim().slice(0, 200);
      }
      return { ...base, status: "error", reason: `HTTP ${res.status}${detail ? ` — ${detail}` : ""}` };
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { ...base, status: "error", reason: "the answer was not JSON" };
    }
    const features = body?.features;
    if (!features || typeof features !== "object") {
      return { ...base, status: "error", reason: "the answer carried no features object" };
    }
    const rows = Object.entries(features).map(([name, on]) => ({
      name,
      value: on ? "yes" : "no",
      line: null,
      source: endpoint,
    }));
    if (body.version) rows.unshift({ name: "version", value: String(body.version), line: null, source: endpoint });
    return { ...base, status: "ok", rows };
  } catch (e) {
    const why =
      e && e.name === "AbortError"
        ? `the gateway did not answer within ${Math.round(timeoutMs / 100) / 10}s`
        : `cannot reach the gateway at ${url}: ${String((e && e.message) || e)}`;
    return { ...base, status: "unreachable", reason: why };
  } finally {
    clearTimeout(timer);
  }
}

// ---- this panel's own remote-write layer ---------------------------------------------------------
// config.json's standing policy, and the per-project value that overrides it.
//
// WHICH config.json is the question this tab got wrong: the one THIS INSTANCE is running on. The answer is
// lib/paths.js's rule — PANEL_CONFIG, then a config moved into the data directory, then `<checkout>/config.json`
// — asked here rather than copied, so a sandbox panel booted on its own file reports that file. `env` and
// `home` are spelled out so a test can ask what a boot with a given environment would read without moving this
// process's own environment.
export function panelConfigFile({ env = process.env, home = os.homedir() } = {}) {
  const file = resolveConfigPath({ here: CHECKOUT_DIR, env, home });
  return { path: path.resolve(file.path), source: file.source };
}

// `panelConfigPath` is for a caller that has already resolved it (server.js passes the CONFIG_PATH it booted
// from); with nothing given, the rule above answers. `configSource` records which rule picked the path.
export function remotePolicySource({
  panelConfigPath = null,
  panelConfigText = null,
  env = process.env,
  home = os.homedir(),
  checkoutConfigPath = path.join(CHECKOUT_DIR, "config.json"),
} = {}) {
  const rule = panelConfigFile({ env, home });
  const resolved = panelConfigPath
    ? {
        path: path.resolve(String(panelConfigPath)),
        // A caller that passes the path its boot resolved gets that boot's rule named back; a path from somewhere
        // else is honestly "given" rather than wearing a rule it did not come from.
        source: pathKey(rule.path) === pathKey(path.resolve(String(panelConfigPath))) ? rule.source : "given",
      }
    : rule;
  const file = resolved.path;
  const base = {
    key: "remoteBranchPolicy",
    label: "Remote branch policy",
    kind: "panel",
    file,
    line: null,
    source: file,
    configSource: resolved.source,
    status: "ok",
    reason: null,
    rows: [],
  };
  let raw = null;
  let text = panelConfigText;
  if (text === null) {
    const read = readText(file);
    if (read.text === null) {
      // NOT a fallback. Showing another file's value under this chip is the defect this row exists to fix, so
      // the rows stay empty and the reason names the file that was wanted and what the other candidate did.
      const other = checkoutConfigPath ? path.resolve(String(checkoutConfigPath)) : null;
      let tried = "";
      if (other && other !== file) {
        const alt = readText(other);
        tried =
          alt.text === null
            ? `; nor is there a readable copy of the checkout's config.json at ${other} (${alt.code || "unreadable"})`
            : `; the checkout's copy at ${other} was not used instead`;
      }
      return { ...base, status: "unreadable", reason: `${read.reason}${tried}` };
    }
    text = read.text;
  }
  try {
    raw = JSON.parse(text);
  } catch {
    return { ...base, status: "malformed", reason: `config.json is not valid JSON at ${file}` };
  }
  if (!raw || typeof raw !== "object") return { ...base, status: "unreadable", reason: `config.json carries no object at ${file}` };

  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const lines = text === null ? null : String(text).split(/\r?\n/);
  const projectsLine = lines ? lineOf(text, '"projects"') : null;
  const globalSet = has(raw, "remoteBranchPolicy");
  const globalLine = lines && globalSet ? lineOf(text, '"remoteBranchPolicy"', 1) : null;
  base.line = globalLine;
  base.source = sourceAt(file, globalLine);
  base.rows.push({
    name: "global",
    value: globalSet ? policyFrom(raw.remoteBranchPolicy) : `${DEFAULT_POLICY} (not set — the default)`,
    line: globalLine,
    source: sourceAt(file, globalLine),
  });

  const projects = Array.isArray(raw.projects) ? raw.projects : [];
  const nameLines = [];
  let searchFrom = projectsLine || 1;
  for (const project of projects) {
    const name = String(project?.name || "");
    const at = lines && name ? lineOf(text, `"name": ${JSON.stringify(name)}`, searchFrom) : null;
    nameLines.push(at);
    if (at) searchFrom = at + 1;
  }
  projects.forEach((project, idx) => {
    const name = String(project?.name || `project ${idx + 1}`);
    const own = has(project, "remoteBranchPolicy");
    const at = nameLines[idx];
    const boundary = nameLines[idx + 1] || (lines ? lines.length + 1 : null);
    let policyLine = null;
    if (lines && at) {
      for (let i = at; i < boundary - 1; i += 1) {
        if (lines[i].includes('"remoteBranchPolicy"')) {
          policyLine = i + 1;
          break;
        }
      }
    }
    base.rows.push({
      name: `projects.${name}`,
      value: own ? policyFrom(project.remoteBranchPolicy) : "(inherits the global policy)",
      line: policyLine,
      source: sourceAt(file, policyLine),
    });
  });
  return base;
}

// lib/remote-writes.js's own choices and grants. The values are imported, not copied: a change to the
// module moves this tab with it. Only the line numbers are located in the text, because a row has to
// say where the value it reports came from.
export function remoteWritesSource({ modulePath = REMOTE_WRITES_PATH, moduleText = null } = {}) {
  const base = {
    key: "remote-writes",
    label: "Remote-write grants",
    kind: "panel",
    file: modulePath,
    line: null,
    source: modulePath,
    status: "ok",
    reason: null,
    rows: [],
  };
  const read = moduleText === null ? readText(modulePath) : { text: moduleText, reason: null };
  if (read.text === null) return { ...base, status: "unreadable", reason: read.reason };
  const text = String(read.text);
  const line = (needle) => lineOf(text, needle);
  const row = (name, value, needle) => {
    const at = line(needle);
    return { name, value, line: at, source: at ? `${modulePath}:${at}` : `${modulePath} (line not found)` };
  };
  base.rows = [
    row("policy choices", POLICIES.join(" / "), `export const POLICIES =`),
    row("grant choices", GRANT_CHOICES.join(" / "), "export const GRANT_CHOICES ="),
    row(
      "permission window",
      `${DEFAULT_GRANT_TIMEOUT_SECONDS} s, capped at ${MAX_GRANT_TIMEOUT_SECONDS} s`,
      "export const DEFAULT_GRANT_TIMEOUT_SECONDS =",
    ),
    row("session grant", "this panel's lifetime only — in memory, a restart asks again", "this.session = new Set()"),
    row("one-time grant", "consumed by the next write", "this.once = new Map()"),
    row("landing trees", "started to land — push without a question", "this.landing = new Set()"),
  ];
  // The heading carries a line too: the module's first located value is the honest anchor for "this
  // group was read from lib/remote-writes.js at ...", and a reader can open it from the heading.
  const anchor = base.rows.find((r) => Number.isInteger(r.line) && r.line > 0);
  if (anchor) {
    base.line = anchor.line;
    base.source = `${modulePath}:${anchor.line}`;
  }
  return base;
}

// ---- the whole answer ----------------------------------------------------------------------------
export async function readPermissions({
  home = hermesHome(),
  configPath = hermesConfigPath(home),
  // The PANEL's own config file: `panelConfigPath` when the caller has already resolved it (the server passes
  // the CONFIG_PATH it booted from), else lib/paths.js's rule over this environment. `panelEnv`/`panelHome`/
  // `checkoutConfigPath` are separate from `home` on purpose — `home` is the gateway's HERMES_HOME, not the
  // user profile the checkout config is resolved against.
  panelConfigPath = null,
  panelConfigText = null,
  panelEnv = process.env,
  panelHome = os.homedir(),
  checkoutConfigPath = path.join(CHECKOUT_DIR, "config.json"),
  modulePath = REMOTE_WRITES_PATH,
  moduleText = null,
  gateway = {},
  timeoutMs = 1800,
  fetchImpl = globalThis.fetch,
} = {}) {
  const file = readText(configPath);
  const sources = BLOCKS.map((block) => yamlSource(block, { configPath, text: file.text, fileReason: file.reason }));
  sources.push(await fetchGatewayCapabilities({ url: gateway.url, key: gateway.key, timeoutMs, fetchImpl }));
  const policy = remotePolicySource({ panelConfigPath, panelConfigText, env: panelEnv, home: panelHome, checkoutConfigPath });
  sources.push(policy);
  sources.push(remoteWritesSource({ modulePath, moduleText }));
  const rows = sources.reduce((n, source) => n + source.rows.length, 0);
  return {
    checkedAt: new Date().toISOString(),
    configFile: { path: configPath, status: file.text === null ? "unreadable" : "ok", reason: file.reason },
    // Which config.json this instance's policy was read from, and which rule chose it. The tab prints the path
    // on its own row; this is what says why it is that path, so a reader comparing two panels can tell them apart.
    panelConfig: { path: policy.file, source: policy.configSource, status: policy.status, reason: policy.reason },
    sources,
    counts: {
      sources: sources.length,
      rows,
      unreadable: sources.filter((source) => source.status !== "ok").length,
    },
  };
}
