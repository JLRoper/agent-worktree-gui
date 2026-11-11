// The links a clarify question carries: what the reader is meant to OPEN before answering.
//
// A question often asks about a thing - a report, a screenshot, a run, a page - and the old card printed the path as
// escaped text, so the reader copied it out of the card and pasted it into a browser (or into an editor). `links` is
// the field that turns that into an anchor: one label plus one target, where the target is either an http(s) URL or a
// local file path.
//
// WHY THIS IS ITS OWN MODULE. The gateway's `clarify.request` is a JSON envelope written by somebody else, and a
// three-hour-old worker will keep sending the old shape: no links at all, a string where this file wants an object, a
// `file:///` URL where a path is wanted, twelve entries when a card can show four. All of that has to degrade into
// something a card can draw, and none of it may throw inside a run's event handler - so the parsing is one pure
// function with a test, and lib/jobs.js only stores its answer.
//
// WHAT IS DELIBERATELY REFUSED: any scheme but http(s). A `javascript:` or `data:` target is a string this panel would
// hand to the operating system, and the panel's own opener (lib/open-url.js) refuses those for the same reason. A
// refused entry is DROPPED, not thrown: a question with one bad link still draws its other links and its text.

export const MAX_LINKS = 8;
export const MAX_LABEL = 120;
export const MAX_TARGET = 900;

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const REFUSED_SCHEME = /^(?:javascript|data|vbscript|about|chrome|ms-[a-z]+):/i;

// A label when the caller did not give one: the last segment of a path, or the host and path of a URL. Short enough
// for a card, never empty, and it never repeats the whole target - the target is drawn beside it in its own type.
export function labelFor(target, kind) {
  const raw = String(target || "").trim();
  if (!raw) return "";
  if (kind === "url") {
    try {
      const u = new URL(raw);
      const tail = u.pathname.split("/").filter(Boolean).pop() || "";
      return tail ? `${u.host}/${tail}`.slice(0, MAX_LABEL) : u.host.slice(0, MAX_LABEL);
    } catch {
      return raw.slice(0, MAX_LABEL);
    }
  }
  const parts = raw.replace(/\\/g, "/").split("/").filter(Boolean);
  return (parts.pop() || raw).slice(0, MAX_LABEL);
}

// `file:///C:/x/y.html` -> `C:/x/y.html`. A worker that read the panel's own docs tends to hand a file URL, and the
// opener's ladder wants a path (it makes the file:/// URL itself, with the drive letter in the authority position).
export function pathFromFileUrl(raw) {
  const text = String(raw || "").trim();
  if (!/^file:/i.test(text)) return null;
  try {
    const u = new URL(text);
    let p = decodeURIComponent(u.pathname || "");
    // `/C:/x/y` -> `C:/x/y`; a POSIX path keeps its leading slash.
    if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1);
    return p || null;
  } catch {
    return null;
  }
}

// One entry, normalized, or null when it cannot be drawn. `value` is the target: `url`, `href`, `path`, `file` and
// `target` are all read because three gateway shapes have been seen in the wild and one of them is always missing the
// field this file would have picked.
export function linkOf(raw, index = 0) {
  if (raw == null) return null;
  let target = "";
  let label = "";
  if (typeof raw === "string") {
    target = raw;
  } else if (typeof raw === "object") {
    target = [raw.url, raw.href, raw.path, raw.file, raw.target].find((v) => typeof v === "string" && v.trim()) || "";
    label = [raw.label, raw.title, raw.name].find((v) => typeof v === "string" && v.trim()) || "";
  }
  target = String(target || "").trim();
  if (!target || target.length > MAX_TARGET) return null;
  if (REFUSED_SCHEME.test(target)) return null;
  label = String(label || "").trim().slice(0, MAX_LABEL);
  const filePath = pathFromFileUrl(target);
  if (filePath) {
    // A file:/// URL is a file, whatever it was spelled as: the card opens it through the same ladder.
    return { label: label || labelFor(filePath, "file"), kind: "file", target: filePath, index };
  }
  if (URL_SCHEME.test(target)) {
    // A WINDOWS DRIVE LETTER IS NOT A SCHEME. `C:/x/y.html` matches the scheme pattern (`c:`), and `new URL` then
    // parses it as protocol `c:` - which the http(s) rule refuses, dropping a perfectly good file link. The drive is
    // tested first, and a path it names falls through to the branch below.
    if (/^[A-Za-z]:[\\/]/.test(target)) return { label: label || labelFor(target, "file"), kind: "file", target, index };
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return { label: label || labelFor(parsed.toString(), "url"), kind: "url", target: parsed.toString(), index };
  }
  // No scheme: a local path. The card cannot tell whether it exists (the server answers that on the click), so a
  // plausible one is kept and a click that finds nothing says so.
  return { label: label || labelFor(target, "file"), kind: "file", target, index };
}

// The whole field: an array of entries, or one entry, or nothing. Order is the caller's, indices are kept so a test
// and the page can name the same link, and the cap is applied AFTER the refusals so a bad entry cannot push a good one
// off the card.
export function linksOf(raw) {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const out = [];
  for (const entry of list) {
    const link = linkOf(entry, out.length);
    if (link) out.push(link);
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

// What a room message can say about a link without drawing one: the label, then the target. Kept here so the Matrix
// passage and the card name a link the same way.
export function linkLine(link) {
  if (!link) return "";
  return `${link.label} - ${link.target}`;
}
