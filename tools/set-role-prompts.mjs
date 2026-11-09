#!/usr/bin/env node
// tools/set-role-prompts.mjs - fill the TIER-1 seat on the built-in roles from the seed's own contract.
//
// WHY: a role's prompt is the operating contract that rides every turn, and the two built-in roles shipped with an
// empty one - so their assistants began every turn with an identity line and an action grammar, while the stance
// sat in a charter the panel sends once every twenty turns (docs/design/prompt-tiers-2026-11-08.md section 2.1).
// The Role tab's route fills the seat one role at a time; this tool exists for the pass over the LIVE store, which
// has to run with the panel stopped, and for a reviewer who wants to see the exact bytes before they are written.
//
// The text is not duplicated here: `ASSISTANT_AGENT_MANAGER_PROMPT` and `ASSISTANT_DIRECTOR_PROMPT` in lib/roles.js
// are the seed, and a fresh panel seeds the same strings. This tool only COPIES the seed onto a library that was
// written before the contract existed.
//
//   node tools/set-role-prompts.mjs --dry-run          preview both roles
//   node tools/set-role-prompts.mjs                    write both, snapshotting roles.json first
//   node tools/set-role-prompts.mjs --role assistant-director --force
//
// A role whose prompt is not empty is SKIPPED, not overwritten: the prompt is the reader's operating contract, and
// a pass that replaced one would be the second authority the Role tab exists to avoid. `--force` is the explicit
// press that replaces it, and it still snapshots first.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ASSISTANT_AGENT_MANAGER_ID,
  ASSISTANT_AGENT_MANAGER_PROMPT,
  ASSISTANT_DIRECTOR_ID,
  ASSISTANT_DIRECTOR_PROMPT,
  readRolesFile,
  writeRole,
} from "../lib/roles.js";
import { ROLE_PROMPT_MAX } from "../lib/assistant/consolidate.js";
import { statePaths } from "../lib/paths.js";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const next = process.argv[i + 1];
  args.set(a.slice(2), next && !next.startsWith("--") ? next : true);
}

const dataDir = String(args.get("data-dir") || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".wag"));
const dryRun = args.get("dry-run") === true;
const force = args.get("force") === true;
const only = args.get("role") ? String(args.get("role")) : "";
const port = Number(args.get("port") || 7331);

const SEEDS = [
  { id: ASSISTANT_AGENT_MANAGER_ID, prompt: ASSISTANT_AGENT_MANAGER_PROMPT },
  { id: ASSISTANT_DIRECTOR_ID, prompt: ASSISTANT_DIRECTOR_PROMPT },
].filter((s) => !only || s.id === only);

if (!SEEDS.length) {
  console.error(`no such built-in role: ${only}`);
  process.exit(2);
}

// ONE WRITER. The panel holds every role record in memory and rewrites roles.json from them on its next save, so a
// file edited under it is silently reverted. A dry run writes nothing and is allowed beside a live panel.
try {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 700);
  const res = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: ac.signal });
  clearTimeout(timer);
  if (res.ok && !dryRun) {
    console.error(`refused: a panel is serving on ${port} and holds these records in memory - stop it (stop-background.cmd), run this, then start it again.`);
    process.exit(3);
  }
  if (res.ok && dryRun) console.log(`note: a panel is serving on ${port}; this is a dry run, so nothing is written.`);
} catch {
  /* nothing serving: the store has one writer, this process */
}

const state = statePaths({ dataDir });
const rolesFile = state.rolesFile;
const before = readFileSync(rolesFile);
const roles = readRolesFile(rolesFile, { seed: false }).roles;
const bytes = (s) => Buffer.byteLength(String(s || ""), "utf8");

const write = [];
for (const seed of SEEDS) {
  const role = roles.find((r) => r.id === seed.id);
  if (!role) {
    console.log(`${seed.id}: absent from this library, skipped`);
    continue;
  }
  const current = String(role.prompt || "");
  if (current.trim() && !force) {
    console.log(`${seed.id}: prompt is ${current.length} chars and not empty - skipped (--force replaces it)`);
    continue;
  }
  if (seed.prompt.length > ROLE_PROMPT_MAX) {
    console.error(`${seed.id}: the seed prompt is ${seed.prompt.length} chars, over the ${ROLE_PROMPT_MAX}-char tier-1 seat`);
    process.exit(4);
  }
  console.log(`${seed.id} (${role.name}): prompt ${current.length} -> ${seed.prompt.length} chars, ${seed.prompt.split("\n").length} lines, ${bytes(seed.prompt)} bytes`);
  write.push(seed.id);
}

if (!write.length) {
  console.log("nothing to write");
  process.exit(0);
}
if (dryRun) {
  console.log(`dry run: ${write.length} role(s) would be written; roles.json is untouched`);
  process.exit(0);
}

// SNAPSHOT FIRST, as the consolidation pass does: a pass whose before state cannot be kept does not run.
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = path.join(state.logsDir, "role-prompts");
mkdirSync(dir, { recursive: true });
const snapshot = path.join(dir, `${stamp}-roles.json`);
copyFileSync(rolesFile, snapshot);
console.log(`snapshot: ${snapshot.replace(/\\/g, "/")} (${before.length} bytes)`);

for (const seed of SEEDS.filter((s) => write.includes(s.id))) {
  writeRole(rolesFile, roles, seed.id, { prompt: seed.prompt });
}
// One write per role, then read the file back: a report that quotes the store's bytes is the proof the copy landed.
const after = readRolesFile(rolesFile, { seed: false }).roles;
for (const seed of SEEDS.filter((s) => write.includes(s.id))) {
  const role = after.find((r) => r.id === seed.id);
  const ok = String(role?.prompt || "") === seed.prompt;
  console.log(`${seed.id}: ${ok ? "written" : "MISMATCH"} (${String(role?.prompt || "").length} chars)`);
  if (!ok) process.exit(5);
}
console.log(`roles.json ${before.length} -> ${readFileSync(rolesFile).length} bytes; ${write.length} prompt(s) set`);
