// ---- the Hermes setting this panel does not own -----------------------------------------
// approvals.timeout is enforced by the GATEWAY, not by this process. A prompt is answered by the
// human in the panel, but the gate that waits for the answer — and gives up — lives in the gateway
// that is running the turn, so the panel only ever sees the ask appear and then expire. That is why
// a parked approval vanished after two minutes: 120 s was the gateway's window, and the panel hid
// the box when the turn came back.
//
// So the knob has to be read and written where the gateway reads it: <HERMES_HOME>/config.yaml. It
// takes effect without a restart, because Hermes re-reads that file whenever its signature changes
// (hermes_cli.config keys its cache on mtime+size), and the approval timeout is read per request.
//
// The edit is deliberately one line. That file belongs to the user: thousands of lines of
// hand-written comments, and a YAML round-trip would silently delete every one of them. So find the
// timeout inside the top-level approvals block, rewrite only it, then re-parse and refuse to write
// if the result does not read back as intended.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hermesHome } from "./hermes-runtime.js";

// tools/approval_context._get_approval_timeout: `config.get("timeout", 300)`, then clamped to the
// platform-safe ceiling (~1 year). The UI offers a far smaller range than that clamp.
export const APPROVAL_TIMEOUT_DEFAULT = 300;
export const APPROVAL_TIMEOUT_MIN = 15;
export const APPROVAL_TIMEOUT_MAX = 86400;

export function hermesConfigPath(home = hermesHome()) {
  return path.join(home, "config.yaml");
}

const parseSeconds = (raw) => {
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// The top-level `approvals:` block → its `timeout` and `mode` as written. Not a YAML parse: the file
// is read only to locate these two lines, and reaching for a parser here is what invites the
// round-trip that would eat the comments.
// ---- one value in a top-level block ---------------------------------------------------------
// Everything the panel writes into config.yaml goes through these two: find the block, find the key
// inside it, replace only that value. Indentation, a trailing comment, blank lines and the file's
// own line endings all survive, because a YAML round-trip would delete every comment in the file.
export function blockRange(lines, block) {
  const head = new RegExp(`^${block}\\s*:\\s*(?:#.*)?$`);
  const start = lines.findIndex((line) => head.test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() && !/^\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

// The raw value of `block.key`, or null when the block or the key is not there.
export function readBlockValue(text, block, key) {
  const lines = String(text ?? "").split(/\r?\n/);
  const range = blockRange(lines, block);
  if (!range) return null;
  const keyRe = new RegExp(`^\\s+${key}\\s*:\\s*(.*)$`);
  for (let i = range.start + 1; i < range.end; i++) {
    const m = keyRe.exec(lines[i]);
    if (!m) continue;
    // Drop an inline comment and the quotes a YAML string may carry.
    return m[1].replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

// Rewrite `block.key`, keeping the block's indentation and any comment on the line; insert the key
// when the block exists without it, and append the whole block when the file has none.
export function setBlockValueText(text, block, key, value) {
  const src = String(text ?? "");
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const lines = src.split(/\r?\n/);
  const range = blockRange(lines, block);
  const rendered = `${key}: ${value}`;

  if (!range) {
    const body = src && !src.endsWith("\n") ? src + eol : src;
    return { text: `${body}${block}:${eol}  ${rendered}${eol}`, changed: true };
  }
  let indent = "  ";
  for (let i = range.start + 1; i < range.end; i++) {
    const m = /^(\s+)\S/.exec(lines[i]);
    if (m) {
      indent = m[1];
      break;
    }
  }
  const keyRe = new RegExp(`^(\\s+)${key}\\s*:(.*)$`);
  for (let i = range.start + 1; i < range.end; i++) {
    const m = keyRe.exec(lines[i]);
    if (!m) continue;
    // Keep the comment and the spacing in front of it exactly as it was; only the value changes.
    const rest = m[2];
    const hash = rest.indexOf("#");
    const gap = hash >= 0 ? rest.slice(0, hash).match(/\s*$/)[0] : "";
    const comment = hash >= 0 ? rest.slice(hash) : "";
    lines[i] = `${m[1]}${rendered}${gap}${comment}`;
    return { text: lines.join(eol), changed: true };
  }
  // A key that is not there yet goes beside the block's own keys, not above the comment that introduces
  // the block: `api_key` belongs next to provider/base_url where a reader looks for it.
  let insertAt = range.start + 1;
  for (let i = range.start + 1; i < range.end; i++) {
    if (!lines[i].trim() || /^\s*#/.test(lines[i])) continue;
    insertAt = i + 1;
  }
  lines.splice(insertAt, 0, `${indent}${rendered}`);
  return { text: lines.join(eol), changed: true };
}

// Drop `block.key` entirely (a commented placeholder stays where it is). Used for a key the reader
// clears: an empty string is not the same as absent - Hermes would read "" as a key and fail.
export function deleteBlockValueText(text, block, key) {
  const src = String(text ?? "");
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const lines = src.split(/\r?\n/);
  const range = blockRange(lines, block);
  if (!range) return { text: src, changed: false };
  const keyRe = new RegExp(`^\\s+${key}\\s*:`);
  for (let i = range.start + 1; i < range.end; i++) {
    if (!keyRe.test(lines[i])) continue;
    lines.splice(i, 1);
    return { text: lines.join(eol), changed: true };
  }
  return { text: src, changed: false };
}

// The approvals block, as written: the two values the panel reads back.
export function readApprovalSettings(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const range = blockRange(lines, "approvals");
  return {
    blockLine: range ? range.start : -1,
    timeout: readBlockValue(text, "approvals", "timeout"),
    mode: readBlockValue(text, "approvals", "mode"),
  };
}

export function setApprovalTimeoutText(text, seconds) {
  return setBlockValueText(text, "approvals", "timeout", seconds);
}

// ---- the clarify window (read-only) ------------------------------------------------------
// HOW LONG THE GATEWAY WILL WAIT, NEVER HOW LONG THIS PANEL WOULD LIKE IT TO. The one resolver every surface
// uses is `tools/clarify_gateway.resolve_clarify_timeout`: `clarify.timeout` when it is written, else
// `agent.clarify_timeout`, else the value `hermes_cli/config_defaults.py` ships for that same key, with 0 or
// negative meaning it waits indefinitely. The panel repeats that order over the same config.yaml, and reads the
// shipped default out of that same defaults file when the gateway's tree is on this host, so the countdown it
// draws is the window the gateway enforces rather than a second opinion about it.
//
// This constant is only what is left when the gateway's own source cannot be read (a bare checkout, a test with
// its own HERMES_HOME). It is the gateway's shipped default and must never grow a mind of its own:
// `test/clarify-window.test.js` fails when the two disagree, and the panel once drew 3600 s over a gateway that
// gave up at 90 because this line was a copy of an old comment instead of the gateway's default.
export const CLARIFY_TIMEOUT_DEFAULT = 90;

// The shipped `agent.clarify_timeout`, read where the gateway keeps it. `from` says which answered, so a report
// can tell the gateway's own default from the fallback; a file that cannot be read or parsed is the fallback, not
// an invented number.
export function clarifyDefaultSeconds({ home = hermesHome() } = {}) {
  const file = path.join(String(home || ""), "hermes-agent", "hermes_cli", "config_defaults.py");
  try {
    const m = /["']clarify_timeout["']\s*:\s*(-?\d+)/.exec(readFileSync(file, "utf8"));
    const n = m ? Number.parseInt(m[1], 10) : NaN;
    if (Number.isFinite(n)) return { seconds: n, from: "config_defaults.py", file };
  } catch {
    /* no gateway source here: the constant is the answer */
  }
  return { seconds: CLARIFY_TIMEOUT_DEFAULT, from: "constant", file: null };
}

// Which line the gateway reads, in its order: `clarify.timeout` when it is written, else `agent.clarify_timeout`.
// "Written" is the resolver's own test: YAML's null spellings (`null`, `~`, or a key with no value) read as None
// there, so the resolver moves on to the next key, and they are absent here too. A value the resolver's `int()`
// cannot take is its `except` branch, the default - never the next key.
const YAML_NULL = new Set(["", "null", "~", "NULL", "Null"]);
export function readClarifyTimeout(text) {
  const clarify = readBlockValue(text, "clarify", "timeout");
  if (clarify !== null && !YAML_NULL.has(String(clarify).trim())) return { raw: String(clarify).trim(), key: "clarify.timeout" };
  const agent = readBlockValue(text, "agent", "clarify_timeout");
  if (agent !== null && !YAML_NULL.has(String(agent).trim())) return { raw: String(agent).trim(), key: "agent.clarify_timeout" };
  return null;
}

// `int(x)` as the gateway's resolver reads it, over the text a line carries. A whole number (with an optional
// sign) is itself; a YAML float is truncated toward zero, as Python's `int()` truncates it (`int(300.5)` is 300);
// anything else raises there and is `null` here, which the caller turns into the default.
function resolverInt(raw) {
  if (/^[+-]?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^[+-]?\d+\.\d+$/.test(raw)) return Math.trunc(Number(raw));
  return null;
}

// One answer for the whole panel. `source` is the line or default that answered, `written` is the number as it
// stands in the file (0 and negatives are kept verbatim, because they mean "unlimited"), and `seconds` is what a
// countdown may use: never a negative, and 0 only alongside `unlimited: true`.
export function clarifyWindowSeconds({ home = hermesHome() } = {}) {
  let text = null;
  try {
    text = readFileSync(hermesConfigPath(home), "utf8");
  } catch {
    text = null;
  }
  const found = text === null ? null : readClarifyTimeout(text);
  // `parseSeconds` throws away 0 and negatives (they mean "unlimited"), so this reads the number raw and only
  // accepts what the gateway's `int()` accepts: a non-number is its `except` branch, the default.
  const written = found ? resolverInt(found.raw) : null;
  const fallback = clarifyDefaultSeconds({ home });
  const seconds = written === null ? fallback.seconds : written;
  return {
    seconds: Math.max(0, seconds),
    written,
    fromFile: written !== null,
    // The gateway keeps waiting: a countdown would be a lie, so the card draws none.
    unlimited: written !== null && written <= 0,
    source: written === null ? (found ? "default (a value the resolver cannot read)" : `default (${fallback.from})`) : found.key,
    defaultSeconds: fallback.seconds,
    defaultFrom: fallback.from,
    configPath: hermesConfigPath(home),
  };
}

// The window the gateway gives a parked APPROVAL, read the way the clarify one is — from the same config file,
// per call, because the gateway reads `approvals.timeout` per request and a reader who changes it in Settings
// gets the new number without a restart. There is no `unlimited`: `tools/approval_gateway_wait._poll_event`
// computes `deadline = now + approvals.timeout` and denies when it passes, so 0 means "deny at once", never
// "wait forever".
export function approvalWindowSeconds({ home = hermesHome() } = {}) {
  let text = null;
  try {
    text = readFileSync(hermesConfigPath(home), "utf8");
  } catch {
    text = null;
  }
  const raw = Number.parseInt(String(text === null ? "" : (readApprovalSettings(text).timeout ?? "")).trim(), 10);
  const written = Number.isFinite(raw) ? raw : null;
  return {
    seconds: written === null ? APPROVAL_TIMEOUT_DEFAULT : Math.max(0, written),
    fromFile: written !== null,
    defaultSeconds: APPROVAL_TIMEOUT_DEFAULT,
  };
}

// A gateway on another machine has its own config.yaml, so writing this one would be a lie.
export function isLocalGatewayUrl(url) {
  try {
    const host = new URL(String(url)).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || host === "0.0.0.0" || /^127\./.test(host);
  } catch {
    return false;
  }
}

export function approvalState({ gatewayUrl, home = hermesHome() } = {}) {
  const configPath = hermesConfigPath(home);
  let text = null;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    text = null;
  }
  const parsed = text === null ? { timeout: null, mode: null } : readApprovalSettings(text);
  const written = parseSeconds(parsed.timeout);
  const local = isLocalGatewayUrl(gatewayUrl);
  return {
    timeoutSeconds: written ?? APPROVAL_TIMEOUT_DEFAULT,
    // Did the file actually say it, or are we showing the gateway's built-in default?
    fromFile: written !== null,
    defaultSeconds: APPROVAL_TIMEOUT_DEFAULT,
    minSeconds: APPROVAL_TIMEOUT_MIN,
    maxSeconds: APPROVAL_TIMEOUT_MAX,
    mode: parsed.mode || null,
    configPath,
    configExists: text !== null,
    gatewayUrl,
    editable: local && text !== null,
    reason: !local
      ? `the gateway at ${gatewayUrl} is not on this machine — approvals.timeout has to be set where it runs`
      : text === null
        ? `no config.yaml at ${configPath}`
        : null,
  };
}

export function writeApprovalTimeout(seconds, { home = hermesHome() } = {}) {
  const configPath = hermesConfigPath(home);
  const n = Number(seconds);
  if (!Number.isInteger(n) || n < APPROVAL_TIMEOUT_MIN || n > APPROVAL_TIMEOUT_MAX) {
    throw new Error(`timeout must be a whole number of seconds between ${APPROVAL_TIMEOUT_MIN} and ${APPROVAL_TIMEOUT_MAX}`);
  }
  const before = readFileSync(configPath, "utf8"); // a missing file throws: there is nothing to edit
  const { text } = setApprovalTimeoutText(before, n);

  // Verify before writing: a bad edit here breaks the user's Hermes, so the rewritten file must say
  // exactly what we meant, and the block's mode must be untouched.
  const was = readApprovalSettings(before);
  const now = readApprovalSettings(text);
  if (parseSeconds(now.timeout) !== n || now.mode !== was.mode || now.blockLine !== was.blockLine) {
    throw new Error("edited config did not read back as intended — nothing was written");
  }
  // Hermes keys its config cache on the file signature, so a plain overwrite is picked up on the
  // next read; the rename just keeps a half-written file from ever being that signature.
  const tmp = `${configPath}.panel-${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, configPath);
  return { configPath, timeoutSeconds: n };
}

// ---- how many sessions the CLI's picker shows ------------------------------------------------
// The store keeps every session — nothing deletes at ten; the in-chat browser was the thing capped,
// with a literal 10 at each call site. The local CLI patch reads `sessions.list_limit`, and the panel
// writes that line. A patch that `hermes update` replaced is REPORTED, not pretended: `patched: false`
// means the number in config.yaml is being ignored by the CLI.
export const SESSION_LIST_DEFAULT = 10;
export const SESSION_LIST_MIN = 1;
export const SESSION_LIST_MAX = 500;

const CLI_PATCH_MARKER = "_configured_session_list_limit";

export async function sessionSettings({ home = hermesHome() } = {}) {
  const configPath = hermesConfigPath(home);
  let text = null;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    text = null;
  }
  const raw = text === null ? null : readBlockValue(text, "sessions", "list_limit");
  const parsed = Number.parseInt(String(raw ?? "").trim(), 10);
  const written = Number.isFinite(parsed) ? Math.max(SESSION_LIST_MIN, Math.min(parsed, SESSION_LIST_MAX)) : null;

  // What the store actually holds — the answer to "am I only keeping ten of them?"
  let store = null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(home, "state.db"), { readOnly: true });
    try {
      store = {
        sessions: db.prepare("select count(*) as c from sessions").get().c,
        messages: db.prepare("select count(*) as c from messages").get().c,
        bySource: db
          .prepare("select source, count(*) as c from sessions group by source order by c desc limit 6")
          .all()
          .map((r) => ({ source: r.source || "?", sessions: r.c })),
      };
    } finally {
      db.close();
    }
  } catch {
    store = null;
  }

  // Is the CLI half installed? `hermes update` replaces hermes_cli/*.py the way it replaces the gateway.
  const cliFile = path.join(home, "hermes-agent", "hermes_cli", "cli_session_mixin.py");
  let patched = null;
  try {
    patched = readFileSync(cliFile, "utf8").includes(CLI_PATCH_MARKER);
  } catch {
    patched = null;
  }

  return {
    listLimit: written ?? SESSION_LIST_DEFAULT,
    fromFile: written !== null,
    defaultLimit: SESSION_LIST_DEFAULT,
    minLimit: SESSION_LIST_MIN,
    maxLimit: SESSION_LIST_MAX,
    patched,
    store,
    configPath,
    configExists: text !== null,
    editable: text !== null,
    reason: text === null ? `no config.yaml at ${configPath}` : null,
  };
}

export function writeSessionListLimit(limit, { home = hermesHome() } = {}) {
  const n = Number(limit);
  if (!Number.isInteger(n) || n < SESSION_LIST_MIN || n > SESSION_LIST_MAX) {
    throw new Error(`the list limit must be a whole number between ${SESSION_LIST_MIN} and ${SESSION_LIST_MAX}`);
  }
  const configPath = hermesConfigPath(home);
  const before = readFileSync(configPath, "utf8"); // a missing file throws: there is nothing to edit
  const { text } = setBlockValueText(before, "sessions", "list_limit", n);
  // Same guard as the approval window: the file must say what we meant before it becomes the file.
  if (Number.parseInt(readBlockValue(text, "sessions", "list_limit") ?? "", 10) !== n) {
    throw new Error("edited config did not read back as intended — nothing was written");
  }
  const tmp = `${configPath}.panel-${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, configPath);
  return { configPath, listLimit: n };
}

// ---- the provider endpoint (OpenRouter URL and key) -------------------------------------------
// Both live in the top-level `model:` block: `base_url` is the endpoint every run talks to and
// `api_key` is what it authenticates with, falling back to OPENROUTER_API_KEY (or OPENAI_API_KEY) in
// the environment when the file carries none. The key is NEVER sent back to the browser: the panel
// shows whether one is set, where it came from, and its last four characters.
export const PROVIDER_DEFAULT_URL = "https://openrouter.ai/api/v1";
const PROVIDER_KEY_ENV = ["OPENROUTER_API_KEY", "OPENAI_API_KEY"];

function readEnvValue(home, names) {
  let text = "";
  try {
    text = readFileSync(path.join(home, ".env"), "utf8");
  } catch {
    return null;
  }
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m || !names.includes(m[1])) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, "").replace(/\s+#.*$/, "").trim();
    if (value) return { name: m[1], value };
  }
  return null;
}

// The last four characters, never the key: the same mask the Gateway tab's field shows, and the one a
// saved profile's `key.masked` carries (lib/provider-profiles.js) so the two read alike.
export function maskKey(value) {
  const v = String(value || "");
  if (v.length < 12) return "set";
  return `${v.slice(0, Math.min(7, v.length - 6))}…${v.slice(-4)}`;
}

export function providerState({ home = hermesHome() } = {}) {
  const configPath = hermesConfigPath(home);
  let text = null;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    text = null;
  }
  const provider = text === null ? null : readBlockValue(text, "model", "provider");
  const baseUrl = text === null ? null : readBlockValue(text, "model", "base_url");
  const keyInFile = text === null ? null : readBlockValue(text, "model", "api_key");
  const envKey = keyInFile ? null : readEnvValue(home, PROVIDER_KEY_ENV);
  return {
    provider: provider || "openrouter",
    configPath,
    configExists: text !== null,
    baseUrl: baseUrl || "",
    defaultBaseUrl: PROVIDER_DEFAULT_URL,
    fromFile: Boolean(baseUrl),
    key: {
      set: Boolean(keyInFile || envKey),
      inConfig: Boolean(keyInFile),
      envName: envKey ? envKey.name : null,
      masked: keyInFile ? maskKey(keyInFile) : envKey ? maskKey(envKey.value) : null,
    },
    editable: text !== null,
    reason: text === null ? `no config.yaml at ${configPath}` : null,
  };
}

export function writeProviderSettings({ baseUrl, apiKey, clearKey = false } = {}, { home = hermesHome() } = {}) {
  const configPath = hermesConfigPath(home);
  const before = readFileSync(configPath, "utf8"); // a missing file throws: there is nothing to edit
  let next = before;

  let wantedUrl = null;
  if (typeof baseUrl === "string" && baseUrl.trim()) {
    wantedUrl = baseUrl.trim().replace(/\/+$/, "");
    let parsed;
    try {
      parsed = new URL(wantedUrl);
    } catch {
      throw new Error("the URL has to be an http(s) address");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("the URL has to be http or https");
    next = setBlockValueText(next, "model", "base_url", JSON.stringify(wantedUrl)).text;
  }

  let wantedKey = null;
  if (clearKey) {
    next = deleteBlockValueText(next, "model", "api_key").text;
  } else if (typeof apiKey === "string" && apiKey.trim()) {
    wantedKey = apiKey.trim();
    if (wantedKey.length < 8 || !/^[\x21-\x7e]+$/.test(wantedKey)) throw new Error("that does not look like an API key");
    // A quoted scalar: keys are opaque, and this keeps a `#` or `:` in one from ending the value.
    next = setBlockValueText(next, "model", "api_key", JSON.stringify(wantedKey)).text;
  }

  // Verify before the file becomes the file, the same guard the other two settings use.
  const nowUrl = readBlockValue(next, "model", "base_url");
  const nowKey = readBlockValue(next, "model", "api_key");
  if (wantedUrl !== null && nowUrl !== wantedUrl) throw new Error("edited config did not read back as intended — nothing was written");
  if (wantedKey !== null && nowKey !== wantedKey) throw new Error("edited config did not read back as intended — nothing was written");
  if (clearKey && nowKey) throw new Error("the key was not removed — nothing was written");
  if (next !== before) {
    const tmp = `${configPath}.panel-${process.pid}.tmp`;
    writeFileSync(tmp, next, "utf8");
    renameSync(tmp, configPath);
  }
  return { configPath, wroteUrl: wantedUrl !== null, wroteKey: wantedKey !== null, clearedKey: Boolean(clearKey) };
}
