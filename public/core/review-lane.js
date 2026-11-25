// review-lane.js - the review lane's arithmetic, in one place: is a row awaiting a check, how many are, and what a
// row's review marker and a collision marker say.
//
// WHY THIS EXISTS. The lane is drawn on three surfaces - the amber marker on the row, the card in the row's detail,
// and the header Review count that filters the table - and every one of them has to answer "is this row awaiting
// review" the same way. A predicate copied three times is a predicate that will disagree with itself the first time
// a field moves, which is the defect this module exists to prevent: the row carries `review` from the panel
// (server.js `withReviews` -> lib/review-inbox.js), and the ONE reading of it is `awaiting` below.
//
// THE ROW IS THE TRUTH ABOUT THE COUNT. A delivery lives in a store (reviews.json) and a store outlives the tree it
// describes: a row that was archived or deleted still has an entry until the panel prunes it. Counting entries would
// then badge work that is gone. So every count here takes ROWS - the list the board is drawing - and a row that is
// not in that list cannot be counted, whatever the store says. The header count and the filter read the same list,
// so "the count" and "the rows it filters to" are the same number by construction.
//
// Published on globalThis as `wtReviewLane`, loaded as a classic script by public/index.html (before app.js) and
// imported by test/review-lane.test.js - the same load contract public/core/search-count.js has.
(function (root) {
  "use strict";

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // A delivery awaiting a check: the one predicate. `reviewedAt` is the panel's stamp, and its ABSENCE is what the
  // amber marker means - not the presence of the record, because a reviewed delivery keeps its card.
  function awaiting(row) {
    const rec = row && row.review;
    return Boolean(rec && rec.summary && !rec.reviewedAt);
  }

  // A collision awaiting the reader: the pair has been handed over (state `reader`) and nobody has ruled on it. The
  // SAME PAIR is carried by BOTH rows, so every count and every marker here dedupes on the record's key: one overlap
  // is one decision, however many rows wear the marker. A ruled pair is not awaiting anything - it renders as already
  // ruled, which is the whole point of storing the ruling against the pair. A pair with a side whose OWN task is done
  // or parked is not awaiting anything either: the collision is with finished work (lib/collisions.js
  // `finishedSides`), and a badge that counted it would send the reader to arbitrate work nobody is doing.
  function awaitingCollisions(row) {
    const list = row && Array.isArray(row.collisions) ? row.collisions : [];
    return list.filter((c) => c && c.state === "reader" && !(Array.isArray(c.stoodByTask) && c.stoodByTask.length));
  }

  // How old a delivery is, in ms, for the oldest-first order. An entry with no readable stamp sorts last within its
  // kind rather than pretending to be from 1970.
  function since(row) {
    const at = Date.parse(row?.review?.at || "");
    return Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER;
  }

  // The header count: rows awaiting review, from the ROWS. `rows` is any iterable of row objects (a Map's values, an
  // array), so the caller never has to flatten the board into a second list first.
  function count(rows) {
    let n = 0;
    for (const row of rows || []) if (awaiting(row)) n += 1;
    return n;
  }

  // The row marker's own wording, so the tooltip and the marker agree about what the amber mark is. Distinct from
  // the yellow lock (a tree held by a live run) and the blue turnover marker on purpose - see public/style.css.
  function markerTitle(row) {
    const rec = row?.review;
    if (!rec || !rec.summary) return "";
    const bits = ["result to review", rec.summary];
    if (rec.report) bits.push(`report: ${rec.report}`);
    if (rec.next && rec.next.length) bits.push(`${plural(rec.next.length, "next step", "next steps")}`);
    return bits.join(" - ");
  }

  // A LAND ORDER is a pair the VERSION LINE alone put together: both sides claim the next patch above main, nothing else
  // differs, and the land step settles it by rebasing onto the current main and keeping the higher version. It is named
  // (both trees, the manifest, both numbers) but it is never a question, so the marker says "land order" instead of
  // "collision". Read from the record's own fields, so the lane does not need to know how the sweep decided.
  function landOrderOf(rec) {
    if (!rec) return null;
    if (rec.landOrder) return rec.landOrder;
    return rec.ruling?.basis === "version" ? rec.ruling : null;
  }

  // What a collision marker says: the counterpart by NAME, then the evidence, then whose turn it is. The counterpart is
  // the first thing, because "this row is in a collision" without naming the other tree is the bare flag this whole
  // feature exists to avoid. The TASK each side is working is named after the evidence, because "two trees landing into
  // main" and "two trees on one piece of work" are the two things a reader has to tell apart.
  function collisionTitle(rec) {
    if (!rec) return "";
    const other = rec.other?.name || rec.otherTarget || "an unnamed tree";
    const files = Array.isArray(rec.files) ? rec.files : [];
    const order = landOrderOf(rec);
    const bits = [`${order ? "land order" : "collision"} with ${other}`, plural(files.length, "shared file", "shared files")];
    if (files.length) bits.push(files.slice(0, 4).join(", "));
    const taskOf = (side) =>
      side?.task ? `#${side.task.id}${side.task.name ? ` ${side.task.name}` : ""}${side.task.state ? ` (${side.task.state})` : ""}` : "no task row";
    const mine = rec.role === "b" ? rec.b : rec.a;
    if (mine || rec.other) bits.push(`${mine?.name || "this tree"} ${taskOf(mine)} vs ${other} ${taskOf(rec.other)}`);
    if (rec.state === "ruled") {
      const ruling = rec.ruling || {};
      if (order) {
        // BOTH NUMBERS, AND WHY IT IS NOT A FIGHT. The order is the lower version first because the higher number is the
        // one that rebases on top of it, and nothing here is the reader's to arbitrate.
        const versions = order.versions || rec.versionCheck?.versions || {};
        const lower = order.pick === "b" ? rec.b : rec.a;
        const higher = order.pick === "b" ? rec.a : rec.b;
        const lowerVersion = order.pick === "b" ? versions.b : versions.a;
        const higherVersion = order.pick === "b" ? versions.a : versions.b;
        bits.push(
          `land order: ${lower?.name || "the lower version"} ${lowerVersion || ""} goes first and ${higher?.name || "the higher version"} ${
            higherVersion || ""
          } lands on top - a version line alone, not a file fight`,
        );
      } else {
        // AN AUTOMATIC PICK SAYS SO, with the reason git gave. "already ruled" would credit it to the reader and hide the
        // one thing he needs to know about it: a pick the panel made is one press from being overruled.
        bits.push(
          ruling.auto
            ? `auto-settled: ${ruling.name || "a side"} goes first${ruling.reason ? ` - ${ruling.reason}` : " - no merge risk either way"}`
            : `already ruled: ${ruling.name || "a side"} goes first`,
        );
      }
    } else if (Array.isArray(rec.stoodByTask) && rec.stoodByTask.length) bits.push(`already stood down: ${rec.stoodByTask.map((f) => `${f.tree} is ${f.state}`).join(", ")}`);
    else if (rec.state === "reader") bits.push("yours to rule on - the Collisions control in the header is where you rule");
    // A VERDICT: the note named nothing alive, so the panel settled it and the marker says so instead of reading like
    // an alarm. It is checked before the "with both assistants" fallback, which would claim a live pair. Three kinds of
    // verdict share the state: a note whose target answered to nothing, a pair (or note) whose trees have all been
    // removed, and a pair with a side git no longer registers - a leftover directory that cannot stand down or land.
    else if (rec.state === "absent") {
      bits.push(
        rec.absent?.how === "trees-gone"
          ? "resolved by absence - every tree it names is gone from disk"
          : rec.absent?.how === "tree-unregistered"
            ? "resolved by absence - a tree it names is no longer a registered worktree, a leftover directory with no worker behind it"
            : "resolved by absence - no row on this board and no live agent answers to it",
      );
    } else bits.push("with both assistants");
    return bits.join(" - ");
  }

  root.wtReviewLane = {
    awaiting,
    awaitingCollisions,
    since,
    count,
    markerTitle,
    collisionTitle,
    landOrderOf,
  };
})(globalThis);
