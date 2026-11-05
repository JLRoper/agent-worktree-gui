// The Matrix bridge's policy — how the reader wants to be spoken to.
//
// ONE markdown file in the panel's state folder, beside the charter and the job store: the policy is the
// reader's words, not a credential, so it lives where the panel can write it and where no commit can reach
// it. It is deliberately NOT bridge.env and never sits beside the bridge script; the panel never opens that
// file, and a policy save must never be able to rewrite one.
//
// The bridge turn reads the effective text from GET /api/matrix/policy (the next row consumes it) and carries
// it into the turn. Precedence is deliberate and tested:
//
//   panel text  >  WTGUI_MATRIX_POLICY (the environment default)  >  the template
//
// The panel's text wins because the reader edited it here. The environment default fills a panel that has
// never been saved, so a headless install can ship a policy without a file; the template fills a panel with
// neither, so the box opens on something useful instead of a blank page.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MATRIX_POLICY_MAX_CHARS = 12000;
// The panel's own environment variable, never one of bridge.env's: the bridge's file is not read by this
// process at all, and naming its variables here would imply otherwise.
export const MATRIX_POLICY_ENV = "WTGUI_MATRIX_POLICY";

const slash = (p) => String(p || "").replace(/\\/g, "/");

// The policy a reader starts from. The four subjects the Bridge tab names — tone, when the bridge may ping
// the phone, quiet hours, and which assistant to route to — are all here, in the reader's own voice, so the
// first save is an edit rather than a blank page. No room id or path is baked in: this template ships in a
// public repo and must read the same on every machine.
export function matrixPolicyTemplate() {
  return `# How the Matrix bridge should speak to me

This is the panel's copy of the bridge policy. It is injected into the bridge turn, and this text wins over
the ${MATRIX_POLICY_ENV} environment default. Edit it here, then press Save policy.

## Tone

- Short, plain replies: one thought per message, no essay, and never restate my question back to me.
- Say what you did and what you need from me. If you are unsure, ask one direct question instead of guessing.

## When you may ping my phone

- Ping when I am the only one who can answer: an approval, a blocked run, or a question from a worker.
- Do not ping for routine progress, a turn that is still running, or a status I can read on the board.
- If several waits are open, send one message that names them instead of one message each.

## Quiet hours

- No messages between 22:00 and 07:00 local time, except a run that is already blocked and cannot wait.
- Hold routine updates inside that window and send them in one message when it opens.

## Which assistant to route to

- Assistant #1 is the default for new work.
- When I name an assistant ("assistant 2", "#2", or its own name), file the work into that assistant's queue.
- If the name is ambiguous, ask which assistant rather than choosing one for me.

## Never

- Never ask for a password, a token, or the contents of bridge.env in the room.
- Never paste a credential or a private key into a message.
`;
}

// The environment default. Trimmed because an exported variable commonly carries a trailing newline, which
// would make an "empty" default look non-empty and silently outrank the template's useful first screen.
export function envPolicyText(env = process.env) {
  const raw = env && typeof env === "object" ? env[MATRIX_POLICY_ENV] : "";
  return String(raw == null ? "" : raw).trim();
}

// The one precedence rule, pure and testable. `source` is what the page draws beside the box: the reader can
// see whether they are editing their own saved text, an environment default, or the template.
export function resolvePolicyText({ panelText = "", envText = "", template = "" } = {}) {
  const panel = String(panelText == null ? "" : panelText);
  if (panel.trim()) return { text: panel, source: "panel" };
  const env = String(envText == null ? "" : envText);
  if (env.trim()) return { text: env, source: "env" };
  return { text: String(template == null ? "" : template), source: "template" };
}

// What a turn carries: a heading that names the policy, then the reader's words unchanged. Empty policy is
// the empty string, never a heading with nothing under it.
export function matrixPolicyPreamble(text) {
  const body = String(text == null ? "" : text).trim();
  if (!body) return "";
  return `## How the reader wants the Matrix bridge to speak to them\n\n${body}\n`;
}

// The panel's own record of the file. Kept in this module rather than on the server so the route, a test and
// any future turn reader all agree about which bytes were measured.
function readPanel(file) {
  try {
    const st = statSync(file);
    const text = readFileSync(file, "utf8");
    return { exists: true, text, mtime: st.mtimeMs };
  } catch {
    // No file yet, or unreadable: no panel text, and the env default (or the template) is what is in force.
    return { exists: false, text: "", mtime: null };
  }
}

/**
 * The reader's save. Whole file, tmp+rename, with the two refusals this store owns.
 * @param expectMtime - the mtime the caller READ before editing. A file that moved since refuses the save
 *   instead of silently discarding the newer text. Absent or non-numeric skips the guard.
 * @throws err.code === "policy-stale" (moved under the caller), "policy-too-long" (over the cap),
 *   "policy-write-failed" (the write itself). The route maps the first two to 409 and 413.
 */
export function writePolicyFile(file, text, { expectMtime = null, cap = MATRIX_POLICY_MAX_CHARS } = {}) {
  const body = String(text == null ? "" : text);
  const expect = Number(expectMtime);
  if (Number.isFinite(expect) && expect > 0) {
    let now = null;
    try {
      now = statSync(file).mtimeMs;
    } catch {
      now = null;
    }
    if (now !== null && Math.abs(now - expect) > 1) {
      const stale = new Error("the policy changed on disk since this copy was loaded — reload it and re-apply the edit");
      stale.code = "policy-stale";
      throw stale;
    }
  }
  if (body.length > cap) {
    const err = new Error(`the policy is ${body.length} characters and the cap is ${cap} — shorten it before saving`);
    err.code = "policy-too-long";
    throw err;
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, file);
  } catch (err) {
    const e = new Error(`could not write ${file}: ${String((err && err.message) || err)}`);
    e.code = "policy-write-failed";
    throw e;
  }
  return body;
}

export class MatrixPolicyStore {
  constructor({ file = "", env = process.env, cap = MATRIX_POLICY_MAX_CHARS, template = matrixPolicyTemplate() } = {}) {
    this.file = String(file || "");
    this.env = env || {};
    this.cap = cap;
    this.template = String(template == null ? "" : template);
  }

  // The effective policy and what produced it, in one object. `text` is the effective text the box shows and
  // a turn would carry; `panelChars` is the SAVED file's size, which is how the page can say "saved, but empty"
  // without pretending the env default is the reader's own writing.
  meta() {
    const panel = readPanel(this.file);
    const envText = envPolicyText(this.env);
    const resolved = resolvePolicyText({ panelText: panel.text, envText, template: this.template });
    return {
      path: slash(this.file),
      exists: panel.exists,
      saved: panel.exists,
      mtime: panel.mtime,
      mtimeIso: panel.mtime == null ? null : new Date(panel.mtime).toISOString(),
      chars: resolved.text.length,
      panelChars: panel.exists ? panel.text.length : 0,
      cap: this.cap,
      source: resolved.source,
      envVar: MATRIX_POLICY_ENV,
      envPresent: Boolean(envText),
      text: resolved.text,
    };
  }

  payload() {
    return this.meta();
  }

  // DELETE is deliberately not offered: saving an empty box is how a reader clears the policy, and the
  // environment default (or the template) then fills the gap. That is the same precedence rule as above — an
  // empty panel file is no panel text, which is the one case the env default exists for.
  save(text, { expectMtime = null } = {}) {
    if (typeof text !== "string") {
      const err = new Error("send a JSON object with a string `text` — that is the whole policy");
      err.code = "policy-text-required";
      throw err;
    }
    writePolicyFile(this.file, text, { expectMtime, cap: this.cap });
    return this.payload();
  }

  // What the next row's turn reader calls. Returns the effective text, already resolved.
  textForTurn() {
    return this.meta().text;
  }
}
