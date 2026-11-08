# The Agent Manager role is retired, and a role delete refuses while an assistant runs it

**2026-11-08 · v1.60.4**

The panel's first built-in role carried the id `agent-manager` while the second carries `assistant-director`. One
library with two spellings of the same idea is how a reader ends up with two records for one job — which is exactly
what the reader's own `roles.json` held: the original record, and a hand-made copy of it under
`assistant-agent-manager`. Three assistants still named the original.

This landing retires the old id and closes the hole that let the duplicate survive: a role can now be deleted, and
the delete **refuses while any assistant still names it**.

## The id

`lib/roles.js` seeds `assistant-agent-manager`. The charter is the same file, renamed — `data/roles/agent-manager.md`
→ `data/roles/assistant-agent-manager.md` — and the bytes are untouched (`-text` in `.gitattributes` keeps both blob
and checkout as the reader wrote them): sha256 `e106606f618afb2af6bad572ccdffcb25c3b3ad50f70c49c521ad9a86381a53b`,
19,773 characters, under the 20,000 cap. A role named `Agent Manager` on a fresh panel reads exactly as it did.

## The upgrade, on read

`readRolesFile` upgrades an older store **before** it registers a built-in the store predates:

| The store holds | What the boot does | Why |
|---|---|---|
| the old id only | renames that record to the new id, field for field | a re-seed would silently replace the reader's own charter text; the rename carries their name, remit, prompt and bytes |
| both ids | leaves both, reports the old id as retired | two records for one job: the copy is the delete pass's business, never a rename |
| neither | seeds the two built-ins | a fresh panel |

Then, after the roster is read, `Assistant.retireRoles()` re-points every assistant naming a retired id
(`lib/assistants.js` `repointRetiredRoles`) and only then deletes the retired record. A re-point is not a re-charter:
each assistant keeps its own copy of the charter its file holds.

## The refusal

`deleteRole(file, roles, id, { heldBy })` is the one role delete. An assistant's record stores a `roleId`, not a copy
of the role, so deleting a role someone still names would leave that assistant resolving nothing — no job title, no
remit, no prompt, no `Your role:` line in its preamble. `heldBy` non-empty is therefore `role-in-use`, the refusal
names the assistants, and nothing is written. Re-pointing is a decision the reader (or the upgrade) makes, never a
cascade a delete performs behind their back.

The upgrade relies on that order rather than working around it: re-point, then delete with the roster as it now
stands. If the roster write fails, the delete refuses by name and the role stays in the library — the safe end state,
with one log line.

`roleIdFrom` also treats a retired id as taken, so a role a reader names "Agent Manager" tomorrow gets
`agent-manager-2` rather than minting the id the upgrade pass reads.

## The reader's store, after

Run against the live `roles.json` / `assistants.json` (before: three assistants on `agent-manager`, three role
records):

- the delete was refused while the three still named it — `role-in-use`, `roles.json` byte-identical afterwards;
- the three assistants were re-pointed through `POST /api/assistant/role/pick`, so the running panel and the file
  agreed at every step;
- the retired record was deleted: `roles.json` now holds `assistant-agent-manager` and `assistant-director`;
- the surviving role's charter sha256 is unchanged by the whole exercise;
- neither file contains the retired id (checked with the new id masked out, so the substring `agent-manager` inside
  `assistant-agent-manager` is not miscounted);
- every assistant resolves a role:

| Assistant | roleId | Resolves |
|---|---|---|
| assistant-1 | assistant-agent-manager | Assistant Agent Manager |
| assistant-2 | assistant-agent-manager | Assistant Agent Manager |
| assistant-3 | assistant-agent-manager | Assistant Agent Manager |
| assistant-5 | assistant-director | Assistant Director |

The running 1.60.1 process keeps its in-memory library until it restarts, which is the same restart a `lib/**` change
needs; the boot pass then re-asserts the two-role library from the file.

## Proof

`node --test test/roles.test.js` — **13 pass, 0 fail** (the seed, the remit, the cap, the
stale-save refusal, the four-field role save, the prompt's place in the preamble, and the retired id absent from a
fresh library).

`node --test test/assistant-role-resolution.test.js` — **4 pass, 0 fail**: the delete refusing with its holders and
the file untouched; a boot over the reader's library re-pointing #1/#2/#3, leaving two roles and every assistant
resolving one; a store holding only the retired record renamed in place with the reader's edited bytes (asserted
different from the seed's sha); and a second boot writing neither file.

Every other file that named the old id was updated in the same commit (13 test files and 8 `tools/` harnesses), and
that set was run once: **99 tests, 99 pass, 0 fail**. The full suite was not swept — the brief asked for the roles
and assistant-resolution tests, and those two are the gate above.

The only remaining mentions of `agent-manager` in the tree are the legacy constant that names it
(`RETIRED_AGENT_MANAGER_ID`, read by the upgrade and seeded by nothing) and a dated report of a 2026-11-04 verify run,
which is a record of what that run printed and is not rewritten.
