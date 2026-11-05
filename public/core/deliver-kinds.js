// core/deliver-kinds.js — the DELIVERABLES list's two narrowings, as one pure answer so a test can drive them
// without a browser.
//
// The popover narrows its 200-row archive twice: by the text the reader types in #dl-filter, and by the kind chips
// beside it. Both narrow the SAME list, so they compose by intersection — and the head's count has to describe what
// the reader can see rather than what the store holds. Three answers live here, and nothing that touches the page:
//
//   1. which chips exist: only a kind with rows in this popup gets one. A chip for a kind nobody delivered is
//      hidden, never greyed — a dead control is worse than an absent one.
//   2. which rows are visible: kind AND text, never one overriding the other.
//   3. what #dl-count says: `12 of 30 · link file image` while anything is narrowed, the plain total otherwise.
//
// The kinds are lib/deliverables.js's DELIVER_KINDS in the same order; test/deliver-kinds.test.js compares the two
// lists, because the page is a classic script and cannot import the store's constant. The chips narrow the VIEW
// only: nothing here deletes, hides or rewrites a stored deliverable, so a kind switched off is still on disk and
// comes back the moment its chip is pressed again.
(function (root) {
  const KINDS = ["link", "file", "image"];
  const GLYPH = { link: "🔗", file: "📄", image: "🖼" };
  const NAME = { link: "links", file: "files", image: "images" };

  // A row's kind. The store records only DELIVER_KINDS, so the fallback is for a hand-edited file — and it is the
  // same one deliverRowHtml makes: an unknown kind reads as a file.
  function kindOf(entry) {
    const kind = String((entry && entry.kind) || "");
    return KINDS.includes(kind) ? kind : "file";
  }

  // Is this kind switched off? The page keeps an array; a Set or the object shape a Set serialises to would work
  // just as well, because membership is all this asks. `undefined` means "nothing is off" — the all-on default.
  function isOff(kind, off) {
    if (!off) return false;
    if (typeof off.has === "function") return off.has(kind);
    if (Array.isArray(off)) return off.includes(kind);
    return Boolean(off[kind]);
  }

  // The chips to draw, in canonical order: a kind with no row in the list is not a chip at all.
  function presentKinds(entries) {
    const seen = new Set((entries || []).map(kindOf));
    return KINDS.filter((kind) => seen.has(kind));
  }

  // The kinds a count describes: present AND switched on.
  function onKinds(entries, off) {
    return presentKinds(entries).filter((kind) => !isOff(kind, off));
  }

  function matchesText(entry, needle) {
    if (!needle) return true;
    return [entry && entry.title, entry && entry.target, entry && entry.agent, entry && entry.project].some((v) =>
      String(v == null ? "" : v).toLowerCase().includes(needle),
    );
  }

  // Both narrowings at once, over the store's own order (the page never re-sorts). The kind test comes first because
  // it is the cheap one and the reader thinks in kinds before words.
  function visible(entries, { query = "", off = [] } = {}) {
    const needle = String(query == null ? "" : query).trim().toLowerCase();
    return (entries || []).filter((entry) => !isOff(kindOf(entry), off) && matchesText(entry, needle));
  }

  // Is anything narrowing the list at all? The head's sentence differs only for this answer.
  function narrowed({ query = "", off = [] } = {}) {
    if (String(query == null ? "" : query).trim()) return true;
    return KINDS.some((kind) => isOff(kind, off));
  }

  // `12 of 30 · link file image` — the shown count FIRST, because that is the number the reader is looking for, then
  // what it is a count of. With all three kinds on the tail names all three: it says the count is over the whole
  // archive's kinds, which is what makes an `image`-only store read as one kind rather than as a defect.
  function countText({ shown = 0, total = 0, query = "", off = [], entries = [] } = {}) {
    if (!narrowed({ query, off })) return `${total} ${total === 1 ? "deliverable" : "deliverables"} — newest first`;
    const on = onKinds(entries, off);
    return `${shown} of ${total}${on.length ? ` · ${on.join(" ")}` : ""}`;
  }

  // The two ways a narrowed list can be empty, said differently: a text that matches nothing is not the same defect
  // as every chip being switched off, and the reader's next action is different.
  function emptyText({ query = "", off = [] } = {}) {
    if (KINDS.every((kind) => isOff(kind, off))) return "every kind is switched off — press a chip to see those rows again.";
    const q = String(query == null ? "" : query).trim();
    if (q) return `nothing matches “${q}”.`;
    return "nothing matches the kinds left on.";
  }

  // What a chip's title says: a press either hides or shows that kind, and the chip is the only place the reader is
  // told which. The accessible NAME stays the kind ("images") so aria-pressed is the whole state, as AT expects.
  function chipTitle(kind, off) {
    return `${isOff(kind, off) ? "show" : "hide"} ${NAME[kind] || kind} — ${isOff(kind, off) ? "they are hidden now" : "they are in the list now"}`;
  }

  root.wtDeliverKinds = { KINDS, GLYPH, NAME, kindOf, isOff, presentKinds, onKinds, matchesText, visible, narrowed, countText, emptyText, chipTitle };
})(globalThis);
