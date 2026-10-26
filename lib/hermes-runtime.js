// ---- where Hermes is, and what its gateway wants -----------------------------------------
// The panel does not own Hermes: it reads the files a Hermes install leaves behind and it talks to
// the gateway that install runs. So four things have to be answered the same way everywhere — where
// the home directory is, which key the gateway expects, how a turn's attachments are trimmed, and
// what a preview request looks like — and they are answered here rather than in lib/jobs.js,
// because lib/hermes-config.js and lib/hermes-models.js need them too. That import was the tree's
// one cycle: hermes-config.js reached into the run supervisor for `hermesHome`, which is why
// lib/jobs.js could not read a setting back out of hermes-config.js without a hard import.
//
// Nothing in this module touches a job, a store or the HTTP layer, and nothing here has a
// side effect at import time.
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

// A turn's attachments, trimmed to what the card needs to draw a link: the path is the identity, the
// name is what is shown, and the type/size exist only for the tooltip.
export function normaliseAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => a && typeof a.path === "string" && a.path.trim())
    .slice(0, 12)
    .map((a) => ({
      path: String(a.path).trim(),
      name: String(a.name || path.basename(String(a.path).trim())).slice(0, 160),
      type: typeof a.type === "string" ? a.type.slice(0, 80) : "",
      bytes: Number(a.bytes) || 0,
    }));
}

export function hermesHome() {
  const env = process.env.HERMES_HOME;
  if (env && !env.startsWith("/")) return env; // an MSYS-shaped home is a mistake, not a path
  const local = process.env.LOCALAPPDATA || process.env.HOME || "";
  return path.join(local, "hermes");
}

// The gateway's token, when the panel was not handed one: `<HERMES_HOME>/.env` is where a Hermes
// install keeps API_SERVER_KEY. Read on demand — a panel started before the key existed should not
// have to be restarted to see it.
export function readKeyFromEnvFile() {
  try {
    const envPath = path.join(hermesHome(), ".env");
    if (!existsSync(envPath)) return null;
    const m = /^\s*API_SERVER_KEY\s*=\s*(.+?)\s*$/m.exec(readFileSync(envPath, "utf8"));
    if (!m) return null;
    return m[1].trim().replace(/^["']|["']$/g, "") || null;
  } catch {
    return null;
  }
}

export function apiConfig(config = {}) {
  const api = config.apiServer || {};
  const url = String(api.url || process.env.API_SERVER_URL || "http://127.0.0.1:8642").replace(/\/+$/, "");
  return { url, key: api.key || process.env.API_SERVER_KEY || null };
}

// The last moment a turn was seen working: the newest line the store kept, or its start when it printed nothing.
// This is where an interrupted turn's clock stops — the panel never saw more than this.
export function lastSeenIso(j) {
  const last = (j.lines || []).reduce((a, l) => Math.max(a, Number(l?.at) || 0), 0);
  return new Date(last || Date.parse(j.startedAt || "") || Date.now()).toISOString();
}

// ---- preview ------------------------------------------------------------------------
// There is no command line any more, so a preview shows the request that will be sent.
export function previewRequest(o = {}) {
  const body = { input: String(o.prompt ?? "") };
  // The real body appends the clarify hint when this build cannot deliver a question (create());
  // a dry run has to show the same input or it is not a preview of what will be sent.
  if (o.clarifyInstruction) body.input += `\n\n${String(o.clarifyInstruction)}`;
  if (o.thread) body.session_id = String(o.thread);
  if (o.cwd) body.cwd = String(o.cwd);
  if (o.model) body.model = String(o.model);
  if (o.maxTurns) body.max_turns = Number(o.maxTurns);
  if (o.budget) body.run_budget = Number(o.budget);
  return { method: "POST", path: "/v1/runs", body };
}

export function makeThreadName(prompt) {
  const slug = String(prompt || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28)
    .replace(/-+$/, "");
  return `wtgui-${slug || "agent"}-${randomUUID().slice(0, 6)}`;
}
