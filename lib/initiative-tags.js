// INITIATIVE TAGS: the board's own small vocabulary for the initiatives, in a state file of its own.
//
// WHY A REGISTRY AND NOT TEXT ON THE CARD. An initiative's tags have to survive a rename of the tag itself: the reader
// types "SSO" on twelve cards and then decides the chip should read "sso" or the name should be "Okta sign-in", and
// every card and every saved filter has to follow in one write. That is only possible if a card stores an ID and the
// words live in one place, which is what this file is: `initiative-tags.json`, beside `initiatives.json`, holding
//
//   { id, ident, name, description, color, createdAt }
//
// `id` is the panel's to hand out and never the caller's (two readers cannot collide, and a reload does not depend on
// remembering one). `ident` is the short text the chip draws - 2 to 6 letters or digits, UNIQUE CASE-INSENSITIVELY, so
// "SSO" and "sso" cannot both exist and a filter cannot silently mean two different tags. `name` is the full word the
// ident stands for (cap 40), `description` what the tag means when the reader needs reminding (cap 200), `color` one
// of a FIXED palette of ten dark-theme names (TAG_PALETTE) - a name, not a hex, so the sheet owns the actual colour
// and a palette change is one CSS block rather than a migration. `createdAt` is the SERVER's clock: a caller that
// posts one is ignored, the same way an initiative's stamps are.
//
// THE CAPS REFUSE RATHER THAN TRUNCATE, in the manner lib/initiatives.js already uses for titles and descriptions:
// an ident that breaks the rule, a name past its cap, a description past its cap and a colour outside the palette all
// answer `{ ok: false, error }` naming the rule and the size given. A chip that silently lost the tail of its name is
// a tag the reader cannot find again.
//
// THE STORE IS REFUSED, NOT REPAIRED. A file that exists and cannot be read is reported (`readable: false` with the
// sentence and the path), every write is refused with that same sentence, and the bytes stay exactly as they are -
// starting from `{ tags: [] }` would delete every tag on the board the first time an assistant wrote one.
//
// DELETING IS THE CALLER'S TWO-STEP, because only the caller can see the initiatives. `remove` takes the initiatives
// that carry the tag (`carried`) and refuses while that list is non-empty unless `confirm` is set; the count in its
// refusal is what the reader's confirm names. Taking the id off every initiative is `Initiatives.dropTag` - one save
// over the initiative document - and the route composes the two, exactly as the archive route composes the wave fold
// with the initiative store.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const INITIATIVE_TAGS_VERSION = 1;
export const TAG_IDENT_MIN = 2;
export const TAG_IDENT_MAX = 6;
export const TAG_NAME_MAX = 40;
export const TAG_DESCRIPTION_MAX = 200;
// The rule as a string as well as a RegExp: the pane's create form prints it beside the field, and the route's refusal
// quotes it, so the door and the label cannot say two different things.
export const TAG_IDENT_RULE = "^[A-Za-z0-9]{2,6}$";
const IDENT_RE = new RegExp(TAG_IDENT_RULE);

// THE TEN. A fixed list, in the order the picker draws them: a dark-theme palette where every entry is legible on the
// panel's #0d1117 surface and distinguishable from the count chips beside it. One of these names is what a tag stores;
// public/style.css owns the colour each name paints.
export const TAG_PALETTE = Object.freeze([
  { id: "slate", label: "slate" },
  { id: "red", label: "red" },
  { id: "amber", label: "amber" },
  { id: "olive", label: "olive" },
  { id: "green", label: "green" },
  { id: "teal", label: "teal" },
  { id: "sky", label: "sky" },
  { id: "blue", label: "blue" },
  { id: "violet", label: "violet" },
  { id: "pink", label: "pink" },
]);
export const TAG_COLOR_IDS = Object.freeze(TAG_PALETTE.map((c) => c.id));
export const DEFAULT_TAG_COLOR = TAG_PALETTE[0].id;

const nowIso = (now = Date.now()) => new Date(now).toISOString();
const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) : t;
};
// A name and an ident are one line; the description keeps its paragraphs like an initiative's, so only runs of spaces
// are collapsed.
const cleanLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const cleanDescription = (s) => String(s ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();

export function newTagId(now = Date.now(), rand = Math.random) {
  return `tag_${now.toString(36)}_${rand().toString(36).slice(2, 8)}`;
}

// WHAT A CALLER MAY POST, CHECKED. One function for create and rename so the two doors cannot disagree about the
// caps, and it is pure so the store's tests can ask it without a file. Absent fields are not checked here - rename
// validates only the halves it was given - and `null` is how this returns a refusal.
export function validateTag({ ident, name, description, color } = {}) {
  const id = cleanLine(ident);
  if (!id) {
    return { ok: false, field: "ident", error: `a tag needs an ident - ${TAG_IDENT_MIN} to ${TAG_IDENT_MAX} letters or digits, the short text its chips draw` };
  }
  if (!IDENT_RE.test(id)) {
    const why =
      id.length < TAG_IDENT_MIN || id.length > TAG_IDENT_MAX
        ? `is ${id.length} character${id.length === 1 ? "" : "s"}`
        : "holds a character other than A-Z, a-z or 0-9";
    return { ok: false, field: "ident", error: `a tag ident is ${TAG_IDENT_MIN} to ${TAG_IDENT_MAX} letters or digits - "${clip(id, 40)}" ${why}` };
  }
  const full = cleanLine(name);
  if (!full) return { ok: false, field: "name", error: "a tag needs a name - the full word its ident stands for, so a chip reads as shorthand rather than as a code" };
  if (full.length > TAG_NAME_MAX) {
    return { ok: false, field: "name", error: `a tag name is at most ${TAG_NAME_MAX} characters - this one is ${full.length}; shorten it, because the ident is what the chip draws` };
  }
  const desc = cleanDescription(description);
  if (desc.length > TAG_DESCRIPTION_MAX) {
    return { ok: false, field: "description", error: `a tag description is at most ${TAG_DESCRIPTION_MAX} characters - this one is ${desc.length}; trim it or leave it empty` };
  }
  const paint = String(color ?? "").trim().toLowerCase() || DEFAULT_TAG_COLOR;
  if (!TAG_COLOR_IDS.includes(paint)) {
    return { ok: false, field: "color", error: `a tag colour is one of ${TAG_COLOR_IDS.join(", ")} - "${clip(color, 20)}" is not one of them` };
  }
  return { ok: true, tag: { ident: id, name: full, description: desc, color: paint } };
}

// The one shape a stored tag has, read through this so a hand edit cannot put an object where the page expects a
// string. A record with no id, no ident or no name is dropped - those three are what a chip draws - and an unknown
// colour falls back to the palette's first name rather than painting nothing (the palette is a rule for WRITES).
function pickTag(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id ?? "").trim();
  const ident = clip(raw.ident, TAG_IDENT_MAX);
  const name = clip(raw.name, TAG_NAME_MAX);
  if (!id || !ident || !name) return null;
  const color = String(raw.color ?? "").trim().toLowerCase();
  return {
    id,
    ident,
    name,
    description: clip(raw.description, TAG_DESCRIPTION_MAX),
    color: TAG_COLOR_IDS.includes(color) ? color : DEFAULT_TAG_COLOR,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
  };
}

// WHAT THE PANE DRAWS AND THE ROUTE ANSWERS: the tags oldest first (a new tag lands at the end of the row), the
// palette, and the caps the form prints. The store's own status travels with it so a tab can say the file cannot be
// read without a second request.
export function tagsView(tags) {
  const status = tags.statusOf();
  return {
    file: status.file,
    found: status.found,
    readable: status.readable,
    error: status.error,
    at: status.at,
    tags: tags.list(),
    palette: TAG_PALETTE.map((c) => ({ id: c.id, label: c.label })),
    caps: { identMin: TAG_IDENT_MIN, identMax: TAG_IDENT_MAX, name: TAG_NAME_MAX, description: TAG_DESCRIPTION_MAX, colors: TAG_COLOR_IDS.slice() },
    identRule: TAG_IDENT_RULE,
  };
}

export class InitiativeTags {
  constructor({ file = null, log = () => {}, now = () => Date.now() } = {}) {
    this.file = file ? String(file) : null;
    this.log = log;
    this.now = now;
    this.doc = { tags: [] };
    this.status = { found: false, readable: true, error: null, at: null };
    this.stamp = null;
  }

  stampOf() {
    if (!this.file) return "no-file";
    try {
      const st = statSync(this.file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  }

  // A missing file is the normal first-run answer (no tags, nothing to repair). A file that exists and cannot be read
  // is the one answer that is NOT "empty": every write is refused until the reader fixes it.
  load({ fresh = false } = {}) {
    if (!this.file) {
      this.status = { found: false, readable: true, error: null, at: null };
      this.doc = { tags: [] };
      return this;
    }
    const stamp = this.stampOf();
    if (!fresh && stamp && stamp === this.stamp) return this;
    this.stamp = stamp;
    if (!existsSync(this.file)) {
      this.status = { found: false, readable: true, error: null, at: null };
      this.doc = { tags: [] };
      return this;
    }
    let raw;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (err) {
      this.status = { found: true, readable: false, error: String((err && err.message) || err), at: null };
      this.doc = { tags: [] };
      return this;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      this.status = { found: true, readable: false, error: "the file does not hold an object", at: null };
      this.doc = { tags: [] };
      return this;
    }
    const tags = [];
    const seen = new Set();
    for (const rec of Array.isArray(raw.tags) ? raw.tags : []) {
      const picked = pickTag(rec);
      if (!picked || seen.has(picked.id)) continue;
      seen.add(picked.id);
      tags.push(picked);
    }
    // Oldest first, and a record with no clock keeps the place the file gave it - a hand-edited file is not reordered
    // under the reader for a stamp it never had.
    tags.sort((a, b) => {
      if (a.createdAt && b.createdAt) return String(a.createdAt).localeCompare(String(b.createdAt));
      if (a.createdAt) return -1;
      if (b.createdAt) return 1;
      return 0;
    });
    this.status = { found: true, readable: true, error: null, at: typeof raw.savedAt === "string" ? raw.savedAt : null };
    this.doc = { tags };
    return this;
  }

  statusOf() {
    this.load();
    return { file: this.file, found: this.status.found, readable: this.status.readable, error: this.status.error, at: this.status.at };
  }

  list() {
    this.load();
    return this.doc.tags.slice();
  }

  byId(id) {
    this.load();
    const want = String(id ?? "");
    return this.doc.tags.find((t) => t.id === want) || null;
  }

  // The ident is unique whatever the case, so the LOOKUP is too: "sso" and "SSO" are one tag.
  byIdent(ident) {
    this.load();
    const want = String(ident ?? "").trim().toLowerCase();
    if (!want) return null;
    return this.doc.tags.find((t) => t.ident.toLowerCase() === want) || null;
  }

  // The one gate every write goes through: an unreadable store is a refusal with the file and the reason, and the
  // bytes stay where they are.
  refuse() {
    const status = this.statusOf();
    if (!status.readable) {
      return {
        ok: false,
        refused: "unreadable",
        file: status.file,
        error: `${status.file || "the tag registry"} could not be read (${status.error || "unknown error"}) - it was NOT overwritten. Fix or move that file, then try again: every initiative tag lives in it.`,
      };
    }
    return null;
  }

  save() {
    if (!this.file) return { ok: false, error: "no tag registry file is configured" };
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const body = { version: INITIATIVE_TAGS_VERSION, savedAt: nowIso(this.now()), tags: this.doc.tags };
      const tmp = `${this.file}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
      renameSync(tmp, this.file);
      this.stamp = this.stampOf();
      this.status = { found: true, readable: true, error: null, at: body.savedAt };
      return { ok: true, file: this.file };
    } catch (err) {
      const error = String((err && err.message) || err);
      this.log(`initiative-tags: could not write ${this.file} (${error})`);
      return { ok: false, error };
    }
  }

  create({ ident = "", name = "", description = "", color = undefined, by = "reader" } = {}) {
    this.load({ fresh: true });
    const refused = this.refuse();
    if (refused) return refused;
    const checked = validateTag({ ident, name, description, color });
    if (!checked.ok) return checked;
    const clash = this.byIdent(checked.tag.ident);
    if (clash) {
      return { ok: false, duplicate: true, field: "ident", error: `a tag already uses the ident "${clash.ident}" (${clash.name}) - idents are unique whatever the case` };
    }
    const tag = { id: newTagId(this.now()), ...checked.tag, createdAt: nowIso(this.now()) };
    this.doc.tags = [...this.doc.tags, tag];
    const wrote = this.save();
    if (!wrote.ok) {
      this.load({ fresh: true });
      return { ok: false, error: `the tag was not saved: ${wrote.error}` };
    }
    this.log(`initiative-tags: created "${tag.ident}" (${tag.name}) as ${String(by || "reader")}`);
    return { ok: true, changed: true, tag, file: this.file };
  }

  // ONE ENTRY EDITED, so every card and every saved filter follows without touching one of them: the cards store ids.
  rename({ id = "", ident = undefined, name = undefined, description = undefined, color = undefined, by = "reader" } = {}) {
    this.load({ fresh: true });
    const refused = this.refuse();
    if (refused) return refused;
    const cur = this.byId(id);
    if (!cur) return { ok: false, notFound: true, error: `no such tag: ${String(id || "(none)")}` };
    if (ident === undefined && name === undefined && description === undefined && color === undefined) {
      return { ok: false, error: "nothing to change: send an ident, a name, a description, a colour, or several" };
    }
    const checked = validateTag({
      ident: ident === undefined ? cur.ident : ident,
      name: name === undefined ? cur.name : name,
      description: description === undefined ? cur.description : description,
      color: color === undefined ? cur.color : color,
    });
    if (!checked.ok) return checked;
    const clash = this.byIdent(checked.tag.ident);
    if (clash && clash.id !== cur.id) {
      return { ok: false, duplicate: true, field: "ident", error: `a tag already uses the ident "${clash.ident}" (${clash.name}) - idents are unique whatever the case` };
    }
    const fields = ["ident", "name", "description", "color"].filter((f) => checked.tag[f] !== cur[f]);
    if (!fields.length) return { ok: true, changed: false, tag: cur, file: this.file };
    const next = { ...cur, ...checked.tag };
    this.doc.tags = this.doc.tags.map((t) => (t.id === cur.id ? next : t));
    const wrote = this.save();
    if (!wrote.ok) {
      this.load({ fresh: true });
      return { ok: false, error: `the change was not saved: ${wrote.error}` };
    }
    this.log(`initiative-tags: renamed "${cur.ident}" to "${next.ident}" (${fields.join(" and ")}) as ${String(by || "reader")}`);
    return { ok: true, changed: true, tag: next, fields, file: this.file };
  }

  // DELETE, WITH THE INITIATIVES IN VIEW. `carried` is every initiative that still carries this id, as `{ id, title }`
  // (the route reads it from the initiative store). A carried tag refuses unless `confirm` is set, and the refusal's
  // sentence NAMES THE COUNT - that is the sentence the reader's confirm repeats. Confirmed, the entry goes; the ids
  // leave the initiatives through `Initiatives.dropTag`, which the route calls right after.
  remove({ id = "", confirm = false, carried = [], by = "reader" } = {}) {
    this.load({ fresh: true });
    const refused = this.refuse();
    if (refused) return refused;
    const cur = this.byId(id);
    if (!cur) return { ok: false, notFound: true, error: `no such tag: ${String(id || "(none)")}` };
    const users = Array.isArray(carried) ? carried.filter(Boolean) : [];
    if (users.length && !confirm) {
      const names = users.slice(0, 3).map((i) => `"${String(i.title || i.id || "")}"`);
      const list = names.join(", ") + (users.length > 3 ? ` and ${users.length - 3} more` : "");
      return {
        ok: false,
        refused: "carried",
        carried: users.length,
        initiatives: users.map((i) => ({ id: String(i.id || ""), title: String(i.title || "") })),
        error: `the tag "${cur.ident}" is on ${users.length} initiative${users.length === 1 ? "" : "s"} (${list}) - deleting it takes it off every one of them; confirm to delete it`,
      };
    }
    this.doc.tags = this.doc.tags.filter((t) => t.id !== cur.id);
    const wrote = this.save();
    if (!wrote.ok) {
      this.load({ fresh: true });
      return { ok: false, error: `the delete was not saved: ${wrote.error}` };
    }
    this.log(`initiative-tags: deleted "${cur.ident}" (${cur.name})${users.length ? ` from ${users.length} initiative${users.length === 1 ? "" : "s"}` : ""} as ${String(by || "reader")}`);
    return { ok: true, changed: true, deleted: cur, carried: users.length, file: this.file };
  }
}
