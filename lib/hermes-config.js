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
import { hermesHome } from "./jobs.js";

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
  lines.splice(range.start + 1, 0, `${indent}${rendered}`);
  return { text: lines.join(eol), changed: true };
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
