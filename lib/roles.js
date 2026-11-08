// The roles: the board's library of assistant jobs, and the charter each one carries.
//
// A role is {id, name, description, prompt, charter}. `name` and the one-line `description` are what the float's
// Role tab shows and what the preamble tells an assistant it is; `prompt` is the short instruction a turn of that
// role begins with (the default an assistant's own prompt overrides, if it has one); `charter` is the long tier —
// the same 20,000-character continuity file an assistant used to own alone, now owned by the ROLE the assistant was
// seeded from.
//
// Why a role and not a second charter file: a charter written for "watch the board and answer" is not the
// document a manager that drives every agent to an approved PR needs, and two assistants doing different jobs
// need two of them. The role is the unit the reader picks, edits, copies and hands to a new assistant; an
// assistant is one Hermes thread plus the role it runs.
//
// The seed is not invented here. `data/roles/assistant-agent-manager.md` is a byte-for-byte copy of the panel's
// own `state/assistant-charter.md` as it stood when roles were introduced — the live file's sha256 is in the commit
// that added it — so seeding a role loses nothing the reader had already written, and the reframing of what the
// job IS lives in `description` (one line the preamble carries) rather than in an edit to their prose. The copy
// is 19,956 characters, which is why nothing is prepended to it: the cap is 20,000 and a header would push the
// reader's own file over it.
//
// The id carries the `assistant-` prefix the Director already uses, and the job does not change with it: this role
// used to be `agent-manager`, and every store written under that id is upgraded on read (`upgradeRetiredRoles`
// below renames the record in place, so a reader's edits to its charter survive byte for byte) before the built-ins
// are registered — which is why the retired id is the one string in this module that is never seeded again.
//
// Pure text plus one atomic file: the seed, the whole-store read, one role's save, and the cap and mtime
// refusals the route maps to 409/413 — the same two refusals the charter file raises, because a role's charter
// is written by the same hand.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { CHARTER_MAX_CHARS } from "./charter.js";
import { PROMPT_CAP } from "./assistant/profile.js";
import { reasonOf } from "./assistant/read.js";

export const ROLES_VERSION = 1;
// The cap is the charter's own: a role's charter is a charter, and a second number for the same text is how two
// answers to one question start disagreeing.
export const ROLE_CHARTER_MAX_CHARS = CHARTER_MAX_CHARS;
export const ROLE_MAX = 8;
export const ROLE_NAME_MAX = 80;
export const ROLE_DESCRIPTION_MAX = 400;
export const ASSISTANT_AGENT_MANAGER_ID = "assistant-agent-manager";
export const ASSISTANT_AGENT_MANAGER_NAME = "Agent Manager";
// What the role is FOR, in the words the preamble carries into every turn. The charter under it is the reader's
// own file; this line is the reframing: the same assistant, now with a job that has an end state.
export const ASSISTANT_AGENT_MANAGER_DESCRIPTION =
  "The board manager: drives every agent it starts to an approved PR ready to merge, and wakes on a settle, an EXITED run, a loop, a quiet agent and leftover work.";
// The ONE retired id this module still names, and the only reason it names it: a library written before the role
// moved under the `assistant-` prefix carries a record here, and `upgradeRetiredRoles` reads that id so the record
// can be renamed IN PLACE (its name, description, prompt and 19,956-character charter untouched) instead of being
// re-seeded from `data/roles/`. It is never a built-in, never a seed, and nothing is registered under it again.
export const RETIRED_AGENT_MANAGER_ID = "agent-manager";
/** Retired id -> the id that replaced it. The map is the whole upgrade: one record, renamed, byte for byte. */
export const RETIRED_ROLE_IDS = Object.freeze({ [RETIRED_AGENT_MANAGER_ID]: ASSISTANT_AGENT_MANAGER_ID });
// The seed, as bytes on disk rather than a template literal: a 20 KB string in a module is a string nobody can
// diff, and this file is the reader's own charter — copied once, verbatim, and never regenerated.
const SEED_CHARTER_URL = new URL("../data/roles/assistant-agent-manager.md", import.meta.url);

export const seedCharter = () => readFileSync(SEED_CHARTER_URL, "utf8");

// ---- the Assistant Director ----------------------------------------------------------------------
//
// The second BUILT-IN role: a director that wakes every twenty minutes, reads every assistant's queue and puts the
// next action in front of the assistant that should take it. It is a role rather than a special case in the sentry
// because the job is a job: its charter is the brief, its name is what the tab and the row call it, and the
// twenty-minute clock is a field of the assistant profile (lib/assistant/profile.js `wakeEveryMinutes`), not a
// second timer in server.js.
//
// Where the Manager is asked to land its own work, the Director is asked to route other people's. That difference
// lives in the charter and in the two action lines only this role may use (`QUEUE` / `MESSAGE`, see
// lib/assistant/actions.js and the `director` branch of `Assistant.applyActions`).
export const ASSISTANT_DIRECTOR_ID = "assistant-director";
export const ASSISTANT_DIRECTOR_NAME = "Assistant Director";
export const ASSISTANT_DIRECTOR_DESCRIPTION =
  "The board's director: wakes every 20 minutes to read every assistant's queue, find a dead run, a row parked past an hour and work nobody has started, then files the row or messages the assistant that should carry it — it never starts a worker itself.";
// Minutes between the Director's own wake. Exported so the profile seed, the test and the tab all name one number.
export const ASSISTANT_DIRECTOR_WAKE_MINUTES = 20;
const SEED_DIRECTOR_CHARTER_URL = new URL("../data/roles/assistant-director.md", import.meta.url);

export const seedDirectorCharter = () => readFileSync(SEED_DIRECTOR_CHARTER_URL, "utf8");

const iso = (at) => new Date(at || Date.now()).toISOString();
const clip = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n) : t;
};

/** The role a panel with no roles yet starts from: the panel's own charter, under the job it was written for. */
export function assistantAgentManagerRole({ at = new Date(), charter = seedCharter() } = {}) {
  const when = iso(at);
  return {
    id: ASSISTANT_AGENT_MANAGER_ID,
    name: ASSISTANT_AGENT_MANAGER_NAME,
    description: ASSISTANT_AGENT_MANAGER_DESCRIPTION,
    prompt: "",
    charter: String(charter),
    createdAt: when,
    updatedAt: when,
  };
}

/** The Director's own role record: its charter is a NEW file, not the manager's text under another name. */
export function assistantDirectorRole({ at = new Date(), charter = seedDirectorCharter() } = {}) {
  const when = iso(at);
  return {
    id: ASSISTANT_DIRECTOR_ID,
    name: ASSISTANT_DIRECTOR_NAME,
    description: ASSISTANT_DIRECTOR_DESCRIPTION,
    prompt: "",
    charter: String(charter),
    createdAt: when,
    updatedAt: when,
  };
}

// The built-ins, in the order a fresh library lists them. A store written before the Director existed gets it
// APPENDED; a store written before the manager role moved under the `assistant-` prefix is upgraded first
// (`upgradeRetiredRoles`), so the record #1 has always run keeps its bytes and only its id changes.
const BUILT_IN_ROLES = [
  { id: ASSISTANT_AGENT_MANAGER_ID, make: assistantAgentManagerRole },
  { id: ASSISTANT_DIRECTOR_ID, make: assistantDirectorRole },
];

export const seedRoles = (opts = {}) => BUILT_IN_ROLES.map((b) => b.make(opts));

/**
 * The upgrade a store written under a RETIRED id needs, run on the raw list BEFORE the built-ins are registered.
 *
 * A role that moved to a new id keeps everything about the record except the id: the same name, the same one-line
 * remit, the same prompt and — the point of the exercise — the same charter BYTES, because it is the reader's own
 * text and re-seeding it from `data/roles/` would silently replace whatever they wrote. The rename is therefore in
 * place and field-for-field, never a delete-and-create.
 *
 * A store that already carries the new id as well (two records for one job, which is what a reader who created a
 * copy of it by hand leaves behind) is NOT renamed: the retired record is reported in `retired` and left for the
 * caller to delete once nothing names it. `deleteRole` below is the guard that makes that order safe.
 * @returns {{ roles: object[], renamed: {from: string, to: string}[], retired: string[] }} `retired` names every
 *   legacy id still present after the rename, which is exactly the list the caller must re-point assistants off and
 *   then delete. `roles` is a new list; the records in it are copies.
 */
export function upgradeRetiredRoles(roles = []) {
  const out = (Array.isArray(roles) ? roles : []).map((r) => ({ ...r }));
  const have = new Set(out.map((r) => String(r?.id || "")));
  const renamed = [];
  for (const [from, to] of Object.entries(RETIRED_ROLE_IDS)) {
    if (!have.has(from)) continue;
    if (have.has(to)) continue; // both present: the duplicate is the delete pass's business, never a rename
    const role = out.find((r) => String(r.id) === from);
    role.id = to;
    renamed.push({ from, to });
    have.delete(from);
    have.add(to);
  }
  const retired = Object.keys(RETIRED_ROLE_IDS).filter((id) => have.has(id));
  return { roles: out, renamed, retired };
}

/**
 * Add every built-in role the library is missing, and change nothing else. This is the boot registration: the
 * Director exists on a panel whose roles.json predates it without the reader having to recreate it, and a second
 * boot finds the id already there and adds nothing. A role the reader renamed or re-chartered under the same id is
 * the reader's: only a MISSING id is seeded.
 * @returns {{ roles: object[], added: object[] }} `roles` is the caller's list with the missing built-ins appended.
 */
export function ensureBuiltInRoles(roles = [], { at = new Date() } = {}) {
  const out = Array.isArray(roles) ? roles.slice() : [];
  const have = new Set(out.map((r) => r.id));
  const added = [];
  for (const b of BUILT_IN_ROLES) {
    if (have.has(b.id)) continue;
    const role = b.make({ at });
    out.push(role);
    have.add(role.id);
    added.push(role);
  }
  return { roles: out, added };
}

/** A role's name, one line of remit, and its size — everything the tab and the picker need, never the text. */
export function roleMeta(role) {
  const charter = String(role?.charter ?? "");
  return {
    id: String(role?.id || ""),
    name: String(role?.name || ""),
    description: String(role?.description || ""),
    chars: charter.length,
    cap: ROLE_CHARTER_MAX_CHARS,
    over: charter.length > ROLE_CHARTER_MAX_CHARS,
    updatedAt: role?.updatedAt || null,
  };
}

export const rolesMeta = (roles = []) => roles.map(roleMeta);
export const findRole = (roles = [], id) => roles.find((r) => r.id === id) || null;

// One store, one writer: a role's charter is edited in place and the whole file is rewritten through a tmp file,
// so a crash between two saves cannot leave half a role on disk. The store's own mtime is not the guard — each
// role carries `updatedAt`, because two roles are two edits and one file mtime cannot tell them apart.
export function writeRolesFile(file, roles = []) {
  const body = JSON.stringify({ version: ROLES_VERSION, roles }, null, 1);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, file);
  } catch (err) {
    const e = new Error(`could not write ${file}: ${reasonOf(err)}`);
    e.code = "roles-write-failed";
    throw e;
  }
  return roles;
}

// Read is a repair, not a parse: a record without an id or a charter is dropped rather than crashing a boot,
// and a store whose manager role is present but whose timestamps are missing gets them, so the tab can show an
// age without the file having to have been written by this build.
function normaliseRoles(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.roles) ? raw.roles : [];
  const out = [];
  const seen = new Set();
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const id = String(r.id || "").trim();
    const name = String(r.name || "").trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: clip(name, ROLE_NAME_MAX),
      description: clip(r.description || "", ROLE_DESCRIPTION_MAX),
      prompt: clip(r.prompt || "", PROMPT_CAP),
      charter: String(r.charter ?? ""),
      createdAt: r.createdAt || null,
      updatedAt: r.updatedAt || r.createdAt || null,
    });
  }
  return out;
}

/**
 * Read the library, seeding it once from `data/roles/*.md` when there is no file yet, adding any built-in role a
 * file written by an older build predates, and upgrading a record written under a retired id before either of those
 * runs. Every path writes through the same atomic writer; a role that is ALREADY there is never regenerated, so a
 * reader's edit survives a boot.
 * @returns {{ roles: object[], seeded: boolean, added: object[], renamed: {from: string, to: string}[],
 *   retired: string[], error: string|null }} `seeded` means this call CREATED the file; `added` names the built-ins
 *   this call wrote into a file that already existed; `renamed` names the retired-id records this call re-identified
 *   in place; `retired` names any retired id STILL in the list (a store that also carried the new id), which the
 *   caller must re-point assistants off and then delete.
 */
export function readRolesFile(file, { at = new Date(), seed = true } = {}) {
  try {
    if (!existsSync(file)) {
      if (!seed) return { roles: [], seeded: false, added: [], renamed: [], retired: [], error: null };
      const roles = seedRoles({ at });
      writeRolesFile(file, roles);
      return { roles, seeded: true, added: roles, renamed: [], retired: [], error: null };
    }
    const read = normaliseRoles(JSON.parse(readFileSync(file, "utf8")));
    // The upgrade comes FIRST: registering a built-in the store predates would append a fresh seed under the new
    // id and then make the rename impossible, so the reader's own charter would be shadowed by the seed's bytes.
    const up = upgradeRetiredRoles(read);
    const { roles, added } = ensureBuiltInRoles(up.roles, { at });
    if (added.length || up.renamed.length) writeRolesFile(file, roles);
    return { roles, seeded: false, added, renamed: up.renamed, retired: up.retired, error: null };
  } catch (err) {
    // An unreadable library is an empty one this turn rather than a boot that fails: the panel still has its
    // assistant, its charter and its board, and the caller says so in the log.
    return { roles: [], seeded: false, added: [], renamed: [], retired: [], error: reasonOf(err) };
  }
}

/**
 * Remove ONE role from the library — and refuse while any assistant still runs it.
 *
 * The refusal is the whole point of this writer. An assistant record stores a `roleId`, not a copy of the role, so
 * deleting a role someone still names leaves that assistant resolving `null` — no job title, no description, no
 * prompt, and a preamble with no `Your role:` line. The caller passes the roster it read (`heldBy`: the ids of the
 * assistants running this role), and a non-empty list is a refusal rather than a cascade: re-pointing is the
 * reader's (or the upgrade's) decision, and a delete that quietly re-homed three assistants would change jobs
 * nobody asked it to change.
 * @returns {{ deleted: object, roles: object[] }} the removed record's meta and the library without it.
 * @throws code "role-unknown" | "role-in-use" | "roles-write-failed"; a refusal carries `heldBy`.
 */
export function deleteRole(file, roles = [], id, { heldBy = [] } = {}) {
  const role = findRole(roles, String(id || ""));
  if (!role) {
    const e = new Error(`no such role: ${id}`);
    e.code = "role-unknown";
    throw e;
  }
  const holders = (Array.isArray(heldBy) ? heldBy : []).map((h) => String(h || "")).filter(Boolean);
  if (holders.length) {
    const e = new Error(
      `the ${role.name} role is still run by ${holders.join(", ")} — re-point or remove ${holders.length === 1 ? "that assistant" : "those assistants"} first`,
    );
    e.code = "role-in-use";
    e.heldBy = holders;
    throw e;
  }
  const at = roles.indexOf(role);
  if (at >= 0) roles.splice(at, 1);
  writeRolesFile(file, roles);
  return { deleted: roleMeta(role), roles };
}

/**
 * The reader's save of ONE role: the four fields the Role tab edits, written together so a name, its remit, its
 * prompt and its charter can never land in two different writes.
 * @param patch - `{name, description, prompt, charter}`; a field left out keeps what the role already carries.
 * @param expectMtime - the `updatedAt` the caller READ before editing (ms). A role that moved since (another
 *   surface, a second tab) refuses the save instead of silently discarding the newer text; absent or non-numeric
 *   skips the guard, which is what a copy from one role to another wants.
 * @returns the updated role.
 * @throws code "role-unknown" | "role-invalid" | "charter-too-long" | "charter-stale" | "roles-write-failed".
 */
export function writeRole(file, roles = [], id, patch = {}, { expectMtime = null } = {}) {
  const role = findRole(roles, id);
  if (!role) {
    const e = new Error(`no such role: ${id}`);
    e.code = "role-unknown";
    throw e;
  }
  const expect = Number(expectMtime);
  if (Number.isFinite(expect) && expect > 0) {
    const now = new Date(role.updatedAt || 0).getTime();
    if (Number.isFinite(now) && now > 0 && Math.abs(now - expect) > 1) {
      const e = new Error("the role changed since this copy was loaded — reload it and re-apply the edit");
      e.code = "charter-stale";
      throw e;
    }
  }
  const name = clip(String(patch.name ?? role.name ?? "").trim(), ROLE_NAME_MAX);
  if (!name) {
    const e = new Error("a role needs a name");
    e.code = "role-invalid";
    throw e;
  }
  const body = String(patch.charter ?? role.charter ?? "");
  if (body.length > ROLE_CHARTER_MAX_CHARS) {
    const e = new Error(
      `the role's charter is ${body.length} characters and the cap is ${ROLE_CHARTER_MAX_CHARS} — prune the oldest changelog entries first`,
    );
    e.code = "charter-too-long";
    throw e;
  }
  role.name = name;
  role.description = clip(String(patch.description ?? role.description ?? ""), ROLE_DESCRIPTION_MAX);
  role.prompt = clip(String(patch.prompt ?? role.prompt ?? ""), PROMPT_CAP);
  role.charter = body;
  role.updatedAt = iso();
  writeRolesFile(file, roles);
  return role;
}

/**
 * The role's charter on its own. Kept because a role's text is the field a caller usually has in hand (a copy from
 * one role to another, the seed's own write); it is `writeRole` with one field, so the cap and the stale refusal
 * have exactly one implementation.
 */
export function writeRoleCharter(file, roles = [], id, text, { expectMtime = null } = {}) {
  return writeRole(file, roles, id, { charter: text }, { expectMtime });
}

/** A new role, copied from one that exists (its text fields are the starting point) or from nothing. */
export function createRole(file, roles = [], { name, description = "", prompt = "", from = "", charter = "", at = new Date() } = {}) {
  const name_ = clip(String(name || "").trim(), ROLE_NAME_MAX);
  if (!name_) throw Object.assign(new Error("a role needs a name"), { code: "role-invalid" });
  if (roles.length >= ROLE_MAX) throw Object.assign(new Error(`this panel holds ${ROLE_MAX} roles already`), { code: "role-full" });
  const base = from ? findRole(roles, from) : null;
  const id = roleIdFrom(name_, roles);
  const when = iso(at);
  const role = {
    id,
    name: name_,
    description: clip(description || base?.description || "", ROLE_DESCRIPTION_MAX),
    prompt: clip(prompt || base?.prompt || "", PROMPT_CAP),
    charter: String(base ? base.charter : charter),
    createdAt: when,
    updatedAt: when,
  };
  roles.push(role);
  writeRolesFile(file, roles);
  return role;
}

// A slug with a suffix only when it has to have one: a reader who names two roles the same thing gets two
// roles, and neither of them silently becomes the other. A RETIRED id is treated as taken: a role named "Agent
// Manager" tomorrow must not mint the id the upgrade pass reads for an old store, or its first boot would rename
// the reader's new role into a duplicate of the built-in.
export function roleIdFrom(name, roles = []) {
  const base =
    String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || `role-${randomUUID().slice(0, 6)}`;
  const taken = new Set([...roles.map((r) => r.id), ...Object.keys(RETIRED_ROLE_IDS)]);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  return `${base}-${randomUUID().slice(0, 6)}`;
}
