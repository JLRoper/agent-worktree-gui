// THE TAG HALF OF THE INITIATIVE STORE: who carries a tag, and the one save that takes a deleted tag off every card.
//
// Cut out of lib/initiatives.js (row 519; module-separation plan entry 20) so a tag change lands in a different file
// from the store, its writers and the note log. lib/initiative-tags.js is the registry - the vocabulary and its
// two-step delete - and this file is the initiative side of that delete: the list a refusal counts, and the write
// that removes the id. The two methods below are verbatim from lib/initiatives.js at 691c65d8 (blob
// 4f37f225ffaa1383007d6e7c249b632b19d32c73, lines 765-805), which now extends this class, so no caller changed and
// no `this.` was rewritten.
//
// The plan's card measures 765-1,011 (247 lines) for this cut; the section measured on this base is 765-805 (41
// lines), because the card's own "what moves" sentence names only carriersOfTag and dropTag and the longer span
// would also take the note log and `move`, which the card gives to other cuts or leaves behind.
//
// The one direction matters: this module imports nothing from lib/initiatives.js. It reads only `this` - the
// document, the save, the refusal and the log the store's constructor owns - so the base declares no state and the
// parent's one added line is `super()`.
//
// TAGS ARE IDS, NEVER TEXT (`tagIds`). An initiative carries registry ids, never names: see the header of
// lib/initiatives.js for why. Archived records are included in carriersOfTag because Restore brings back exactly the
// record it put away, and a card returning with a tag the registry has dropped would be a dangling chip.

export class InitiativeTagOps {
  // ---- the board's tags: who carries one, and taking a deleted one off every card ---------------------------------

  // EVERY INITIATIVE THAT CARRIES THIS TAG, archived ones included - the list a delete's refusal counts and names.
  // Archived records are in it because their ids must leave too: Restore brings back exactly the record it put away,
  // and a card returning with a tag the registry has dropped would be a dangling chip nobody can fix from the tab.
  carriersOfTag(id) {
    this.load();
    const want = String(id ?? "");
    if (!want) return [];
    return this.doc.initiatives
      .filter((i) => Array.isArray(i.tagIds) && i.tagIds.includes(want))
      .map((i) => ({ id: i.id, title: i.title, archivedAt: i.archivedAt || null }));
  }

  // THE SECOND HALF OF A CONFIRMED TAG DELETE: one save that takes the id off every initiative that carries it.
  // It is deliberately NOT an edit of anybody's words - no `updatedAt`, no history event per card - because one press
  // in the registry changed the vocabulary, not twelve pieces of work, and twelve history lines saying so would bury
  // the changes that were made. The route logs the delete with its count, which is the record a reader needs.
  dropTag({ id = "", by = "reader" } = {}) {
    this.load({ fresh: true });
    const refused = this.refuse();
    if (refused) return refused;
    const want = String(id ?? "").trim();
    if (!want) return { ok: false, error: "dropping a tag needs the tag id" };
    let removed = 0;
    this.doc.initiatives = this.doc.initiatives.map((i) => {
      const list = Array.isArray(i.tagIds) ? i.tagIds : [];
      if (!list.includes(want)) return i;
      removed += 1;
      return { ...i, tagIds: list.filter((tid) => tid !== want) };
    });
    if (!removed) return { ok: true, changed: false, removed: 0, file: this.file };
    const wrote = this.save();
    if (!wrote.ok) {
      this.load({ fresh: true });
      return { ok: false, error: `the tag was not taken off the initiatives: ${wrote.error}` };
    }
    this.indexCache = null;
    this.log(`initiatives: dropped tag ${want} from ${removed} initiative${removed === 1 ? "" : "s"} as ${String(by || "reader")}`);
    return { ok: true, changed: true, removed, file: this.file };
  }
}
