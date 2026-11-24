// The SHAPE of a clarify card: how many choices it offers, whether the four directions are present, and whether the
// recommended one is first. It says nothing about whether an option is any good.
//
// WHY THIS EXISTS. The fleet's rule (docs/clarify-juggling-design-2026-11-24.md, section 1) is that a card ends a
// piece of work with four directions in a closed vocabulary - `Finish:`, `Deeper:`, `Route:`, `Ask:` - recommended
// first. Prose cannot be counted, so the panel parses the labels it receives into a field and counts it. This module
// is that parse: a pure classifier, no DOM, no clock, no store.
//
// WHAT IT MUST NEVER DO. It never blocks, refuses or delays a card. A card that cannot be raised strands the run that
// is parked on it, so this module only ANNOTATES: `ok` is a measurement, and a card whose `ok` is false is raised,
// answered and settled exactly like one whose `ok` is true. The call site treats a throw as "no verdict" for the same
// reason, and `checkChoices` is total over anything it is handed.
//
// WHAT IT CANNOT SEE. A prefix cannot tell whether four options really differ in kind. Four labels reading
// `Route: rename it`, `Route: move it`, `Route: delete it`, `Ask: ...` repeat a kind and are caught, but four clever
// labels that all mean "do the next small thing" pass. That is why the vocabulary sits at the front of the label,
// where the reader sees it too, and why `ok` is a floor rather than a judgement of substance.
//
// THE KINDS, in the order the design recommends them. The order is the canonical one: a complete card names its
// directions in this order, and the recommended one is first.
export const CLARIFY_KINDS = ["finish", "deeper", "route", "ask"];

/** The label each kind is drawn as. One spelling, so the card and a test cannot word the same kind differently. */
export const CLARIFY_KIND_LABELS = { finish: "Finish", deeper: "Deeper", route: "Route", ask: "Ask" };

// The kind is a PREFIX of the choice label, matched at the start and followed by a colon. The gateway appends
// " (Recommended)" to the first choice, so the prefix is matched before any tail handling: "Deeper: build it
// (Recommended)" is a Deeper.
const KIND_PREFIX = /^\s*(finish|deeper|route|ask)\s*:/i;

// The clarify tool marks its best option by suffixing the label with "(Recommended)". Same spelling as the room's
// (`lib/jobs.js` `waitsOf`, which now imports this one), so the panel has one definition of "this choice was marked
// as the recommendation", not two that can drift.
export const RECOMMENDED_TAIL = /^(.*?)\s*\(recommended\)\s*$/i;

/** Whether one choice label carries the gateway's recommended marker. */
export function isRecommended(label) {
  return RECOMMENDED_TAIL.test(String(label ?? ""));
}

/** The kind a choice announces, or "" when it announces none. Shape only: the words after the colon are not read. */
export function kindOf(label) {
  const m = KIND_PREFIX.exec(String(label ?? ""));
  return m ? m[1].toLowerCase() : "";
}

const labelOf = (kind) => CLARIFY_KIND_LABELS[kind] || String(kind || "");

// The one line the card draws. Built from the verdict so the card, the history row and a test all read the same
// sentence. It names the directions in the card's own order when all four are there, and names the MISSING kinds when
// they are not - which is the whole point of drawing it: a reader can see at a glance what the card did not offer.
export function shapeLine(shape = {}) {
  const kinds = Array.isArray(shape.kinds) ? shape.kinds : [];
  const missing = Array.isArray(shape.missing) ? shape.missing : [];
  const repeated = Array.isArray(shape.repeated) ? shape.repeated : [];
  const count = Math.max(0, Number(shape.count) || 0);
  const named = kinds.map(labelOf).join(", ");
  const distinct = [...new Set(kinds)];
  const apart = distinct.map(labelOf).join(", ");
  const absent = missing.map(labelOf).join(", ");
  const twice = repeated.map(labelOf).join(", ");
  const orderNote = "out of order: the recommended choice is not first";
  if (!count) return `no choices offered · missing ${absent}`;
  // The complete card, the case the rule wants: the four directions, named in the order the card offers them.
  if (count === CLARIFY_KINDS.length && distinct.length === CLARIFY_KINDS.length && !repeated.length) {
    const lead = shape.ordered === false ? "four directions, out of order" : "four directions, in order";
    return `${lead}: ${named}${shape.ordered === false ? " · the recommended choice is not first" : ""}`;
  }
  const parts = [];
  parts.push(
    distinct.length
      ? `short: ${distinct.length} of the 4 directions (${apart})`
      : `short: none of the 4 directions in ${count} choice${count === 1 ? "" : "s"}`,
  );
  // A kind offered twice is named once by the distinct list above, so the repeat has to be said out loud.
  if (twice) parts.push(`${twice} appears twice`);
  if (absent) parts.push(`missing ${absent}`);
  if (count > CLARIFY_KINDS.length) parts.push(`${count} choices, the rule wants 4`);
  if (shape.ordered === false) parts.push(orderNote);
  return parts.join(" · ");
}

/**
 * Classify a card's choices. Returns
 *
 *   ok          all four kinds, once each, four choices, recommended first (or no marker at all to contradict)
 *   count       how many choices the card offers
 *   kinds       the kinds found, in the card's own order, duplicates included ("" entries are not kinds)
 *   missing     the kinds not present, in CLARIFY_KINDS order
 *   repeated    the kinds present more than once, in CLARIFY_KINDS order
 *   recommendedIndex  the index of the choice the tool marked recommended, or -1 when none is marked
 *   ordered     false ONLY when a recommendation is marked and it is not the first choice. With no marker there is
 *               nothing to contradict, so this stays true rather than claiming a defect the label cannot prove
 *   why         the short reason, for a tooltip or a test
 *   line        the one sentence the card draws (shapeLine above)
 *
 * Total over anything: a missing list is zero choices, a string is not a list, and a non-string choice is read as its
 * own text. No branch throws, because a throw here would be a card that never reaches the reader.
 */
export function checkChoices(choices) {
  try {
    const list = (Array.isArray(choices) ? choices : [])
      .map((c) => String(c ?? ""))
      .filter((c) => c.trim());
    const count = list.length;
    const kinds = [];
    let recommendedIndex = -1;
    list.forEach((label, i) => {
      const kind = kindOf(label);
      if (kind) kinds.push(kind);
      if (recommendedIndex < 0 && isRecommended(label)) recommendedIndex = i;
    });
    const seen = new Map();
    for (const kind of kinds) seen.set(kind, (seen.get(kind) || 0) + 1);
    const missing = CLARIFY_KINDS.filter((kind) => !seen.has(kind));
    const repeated = CLARIFY_KINDS.filter((kind) => (seen.get(kind) || 0) > 1);
    // A marker on any choice but the first is the out-of-order case the gateway cannot produce itself; a page, a
    // hand-built prompt or a model that wrote the marker into a later label can. With no marker, `ordered` stays true:
    // "nothing contradicts first" is not the same claim as "the first is marked".
    const ordered = recommendedIndex <= 0;
    const ok = count === CLARIFY_KINDS.length && !missing.length && !repeated.length && ordered;
    const reasons = [];
    if (count !== CLARIFY_KINDS.length) reasons.push(`${count} choice${count === 1 ? "" : "s"}, not 4`);
    if (missing.length) reasons.push(`missing ${missing.map(labelOf).join(", ")}`);
    if (repeated.length) reasons.push(`repeated ${repeated.map(labelOf).join(", ")}`);
    if (!ordered) reasons.push("out of order: the recommended choice is not first");
    const shape = {
      ok,
      count,
      kinds,
      missing,
      repeated,
      recommendedIndex,
      ordered,
      why: reasons.length ? reasons.join("; ") : "four directions, in order",
    };
    return { ...shape, line: shapeLine(shape) };
  } catch {
    // Unreachable for any real envelope, and still a verdict rather than a failed card: an unclassifiable set of
    // choices is drawn as "no verdict" (line "") and nothing else about the prompt changes.
    return {
      ok: false,
      count: 0,
      kinds: [],
      missing: CLARIFY_KINDS.slice(),
      repeated: [],
      recommendedIndex: -1,
      ordered: true,
      why: "the choices could not be classified",
      line: "",
    };
  }
}

/**
 * A stored verdict, read back defensively: a record written by another build (or hand-edited) arrives with the fields
 * the card and the popup read, or with null when there was no verdict at all. `line` is recomputed when the stored
 * record predates it, so an older row still draws.
 */
export function normalizeShape(shape) {
  if (!shape || typeof shape !== "object" || Array.isArray(shape)) return null;
  const kinds = (Array.isArray(shape.kinds) ? shape.kinds : []).filter((k) => CLARIFY_KINDS.includes(k));
  const missing = CLARIFY_KINDS.filter((k) => (Array.isArray(shape.missing) ? shape.missing : []).includes(k));
  const repeated = CLARIFY_KINDS.filter((k) => (Array.isArray(shape.repeated) ? shape.repeated : []).includes(k));
  const count = Math.max(0, Number(shape.count) || 0);
  const recommendedIndex = Number.isFinite(Number(shape.recommendedIndex)) ? Number(shape.recommendedIndex) : -1;
  const ordered = shape.ordered === false ? false : true;
  const out = {
    ok: Boolean(shape.ok),
    count,
    kinds,
    missing,
    repeated,
    recommendedIndex,
    ordered,
    why: String(shape.why || ""),
  };
  return { ...out, line: String(shape.line || "") || shapeLine(out) };
}
