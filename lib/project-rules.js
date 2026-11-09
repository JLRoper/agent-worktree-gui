// A project's own short rules: the one-line sentences a worker in that project is meant to obey.
//
// WHERE THEY LIVE. On the project's entry in `config.json` (`projects[].rules`), not in a store of their own. A
// project's entry is already the reader's record of what that project IS - its remote, its main branch, its push
// controls - and a rule is the same kind of fact: something a reader typed about one project, which has to survive a
// restart and travel with the file. lib/projects.js merges those entries onto the scanned repository by NAME, so a
// rule list written here is the same list the board draws without a second reader.
//
// THE SHAPE. `rules` is OPTIONAL and defaults to EMPTY: absent, null, a string, a number, an object, or an array with
// junk in it all read as `[]`. That is the rule for every field this file's neighbours read out of a hand-editable
// config, and it is what makes the key safe to leave out of an install that never uses it.
//
// A RULE IS ONE LINE. Newlines collapse to spaces and runs of whitespace collapse to one, so a rule is one sentence
// on one row of the editor and one line in the worker brief. Reading is FORGIVING (a hand-edited file with a long
// line is capped rather than rejected, because the panel must still boot and still show something); WRITING is STRICT
// (`validateRules` refuses a blank line, a non-string, or a line over the cap), because a save that silently changes
// what the reader typed is a lie about what was stored.
//
// The caps are exported and travel to the page with the read (`routes/project-rules.js`), so the editor's `maxlength`
// and the writer's refusal are the same two numbers.

/** How many characters one rule may carry, after whitespace collapses. */
export const RULE_MAX_CHARS = 200;

/** How many rules one project may carry. */
export const RULES_MAX = 40;

const collapse = (value) => String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();

// The READ side: whatever the file holds, answered as a list of one-line strings, capped in both directions.
// Order is the reader's order - it is the order the editor draws and the order a brief would carry - so nothing here
// sorts, dedupes or reflows it.
export function rulesFrom(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = collapse(item).slice(0, RULE_MAX_CHARS);
    if (!text) continue;
    out.push(text);
    if (out.length >= RULES_MAX) break;
  }
  return out;
}

// The WRITE side: the list a POST asked to store, or the reason it cannot be stored. One answer shape, so the route
// never has to interpret: `{ rules }` on success, `{ error }` otherwise.
export function validateRules(value) {
  if (!Array.isArray(value)) return { error: "rules must be a list of one-line strings" };
  if (value.length > RULES_MAX) return { error: `a project can carry at most ${RULES_MAX} rules (this save has ${value.length})` };
  const rules = [];
  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    if (typeof raw !== "string") return { error: `rule ${i + 1} is not a string` };
    const text = collapse(raw);
    if (!text) return { error: `rule ${i + 1} is empty - delete it instead of saving a blank line` };
    if (text.length > RULE_MAX_CHARS) {
      return { error: `rule ${i + 1} is ${text.length} characters - the cap is ${RULE_MAX_CHARS} (one line, one sentence)` };
    }
    rules.push(text);
  }
  return { rules };
}

/** How many rules a project record carries. Absence reads as zero, so the chip can draw it for every project. */
export function rulesCount(project) {
  return rulesFrom(project?.rules).length;
}

// The `projects[]` ROW, as the settings writer leaves it: the SAME row with only `rules` moved, or - for a project
// config.json does not name yet - `{ name }` plus the rules.
//
// A new row carries NO PATH, for the reason lib/push-permissions.js `projectPushRow` states: the board keys a project
// by NAME and discovery merges this row onto the repository it scanned by that name, so a path written here is a
// second copy of a fact the scan already owns - and the path of ONE machine, in a file meant to travel.
//
// An EMPTY list REMOVES the key rather than storing `[]`: the field is optional, absence is its empty value, and a
// file that has never held a rule should not grow a key per project the reader opened once.
export function projectRulesRow(existing, name, rules) {
  const row = existing && typeof existing === "object" ? { ...existing } : { name: String(name ?? "").trim() };
  const list = rulesFrom(rules);
  if (list.length) row.rules = list;
  else delete row.rules;
  return row;
}
