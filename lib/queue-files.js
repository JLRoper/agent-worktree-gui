// The file claims a queue row makes, compared the one way the whole panel compares them.
//
// Why this is its own module: TWO readers now decide whether a file is claimed - the queue's digest (lib/assistant/
// queue.js) and the SPAWN checks (lib/spawn-check.js) - and lib/assistant/queue.js imports the checks, so the checks
// cannot import the queue back. A copied boundary matcher would be a second opinion about what "the same file" means,
// and the one thing this whole change exists to stop is two readers answering that differently. Everything here is
// pure string work; nothing reads a file or a store.

export const normQueueFile = (f) =>
  String(f ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();

// Two claimed paths intersect when they name the same file or one names a directory the other lives in. Exact
// equality alone would let `lib/assistant.js` and `lib/assistant` pass as disjoint when they are the same file and its
// directory; substring matching would call `lib/a.js` and `lib/ab.js` a clash. A boundary match is the honest middle.
export function filesIntersect(a, b) {
  const x = normQueueFile(a);
  const y = normQueueFile(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

export function intersectingFiles(filesA, filesB) {
  const out = [];
  for (const a of Array.isArray(filesA) ? filesA : []) {
    for (const b of Array.isArray(filesB) ? filesB : []) {
      if (filesIntersect(a, b) && !out.some((f) => normQueueFile(f) === normQueueFile(a))) out.push(a);
    }
  }
  return out;
}
