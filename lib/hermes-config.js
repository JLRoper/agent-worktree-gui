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
export function readApprovalSettings(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  let blockLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^approvals\s*:\s*(?:#.*)?$/.test(lines[i])) {
      blockLine = i;
      break;
    }
  }
  if (blockLine < 0) return { blockLine: -1, timeout: null, mode: null };

  let timeout = null;
  let mode = null;
  for (let i = blockLine + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() && !/^\s/.test(line)) break; // the next top-level key ends this block
    const m = /^\s+([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].replace(/\s+#.*$/, "").trim();
    if (m[1] === "timeout") timeout = value;
    if (m[1] === "mode") mode = value;
  }
  return { blockLine, timeout, mode };
}

// Rewrite (or add) `timeout:` under `approvals:`, preserving the file's line endings, indentation,
// trailing comment and every other byte.
export function setApprovalTimeoutText(text, seconds) {
  const src = String(text ?? "");
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const lines = src.split(/\r?\n/);
  const { blockLine } = readApprovalSettings(src);

  if (blockLine < 0) {
    const body = src && !src.endsWith("\n") ? src + eol : src;
    return { text: `${body}approvals:${eol}  timeout: ${seconds}${eol}`, changed: true };
  }

  let end = lines.length;
  for (let i = blockLine + 1; i < lines.length; i++) {
    if (lines[i].trim() && !/^\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  // Keep the block's own indentation rather than assuming two spaces.
  let indent = "  ";
  for (let i = blockLine + 1; i < end; i++) {
    const m = /^(\s+)\S/.exec(lines[i]);
    if (m) {
      indent = m[1];
      break;
    }
  }
  for (let i = blockLine + 1; i < end; i++) {
    const m = /^(\s+)timeout\s*:(.*)$/.exec(lines[i]);
    if (m) {
      // Keep the comment and the spacing in front of it exactly as it was; only the number changes.
      const rest = m[2];
      const hash = rest.indexOf("#");
      const gap = hash >= 0 ? rest.slice(0, hash).match(/\s*$/)[0] : "";
      const comment = hash >= 0 ? rest.slice(hash) : "";
      lines[i] = `${m[1]}timeout: ${seconds}${gap}${comment}`;
      return { text: lines.join(eol), changed: true };
    }
  }
  lines.splice(blockLine + 1, 0, `${indent}timeout: ${seconds}`);
  return { text: lines.join(eol), changed: true };
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
