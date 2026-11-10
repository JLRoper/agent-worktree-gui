// ---- what each release since this build carried, in one line -----------------------------------
// The update chip's expanded panel answers two questions at once: which build a reload would put
// into service, and what each release between this tab's build and that one actually carried. The
// second half costs a parse of CHANGELOG.md, and the page asks for it on its 30 second poll.
//
// So the parse happens ONCE per revision of the file and is held: the key is the file's mtime and
// size together (the same pair a build stamp uses - a same-size write inside one millisecond is the
// only edit this cannot see, and that is not how a renderer writes). A poll pays for one stat and a
// range slice; a changed changelog pays for one read. Concurrent callers share the one in-flight
// read rather than starting a second.
//
// The line a release shows is the FIRST bullet not under "Docs & tests", the grouping
// tools/changelog.mjs writes. A release that only moved docs and tests has no line of its own:
// `null` here, and the sentence the chip says in public/core/update-check.js. Inventing a line from
// a docs bullet would put housekeeping in front of a reader asking what the new build does.
//
// The range is (since, upto]: the release the tab is running is not news, and the release on disk
// is. A version with no section at all (the landing's own bump, before its post-merge render) is
// still listed with no line, because that IS the build a restart would pick up and the reader is
// owed the fact that nothing describes it yet. Versions in between exist only where the changelog
// names them: the file is the only record of the release sequence this panel has.
import { readFile, stat } from "node:fs/promises";

// The heading tools/changelog.mjs writes: "## v1.76.25 - date - N commits". Only the number is
// parsed here, and the separator is deliberately not matched: this module needs the version, not
// the file's punctuation.
const HEADING = /^##\s+v(\d+\.\d+\.\d+)\s/;
const DOCS_GROUP = /^###\s+Docs\s*&\s*tests\s*$/i;

// A bullet as a reader says it: the commit link's markdown reduced to its short sha, the backticks
// gone. The same transformation server.js's release-notes tab applies, so the chip and the settings
// tab cannot describe one release two ways.
function bulletLine(raw) {
  return raw
    .replace(/^[-*]\s+/, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .trim();
}

// version -> the release's top non-docs bullet, or null when it has none.
export function parseReleaseNotes(text) {
  const notes = new Map();
  let version = null;
  let docs = false;
  let line = null;
  const keep = () => {
    if (version) notes.set(version, line);
  };
  for (const raw of String(text || "").split("\n")) {
    const trimmed = raw.trim();
    const heading = HEADING.exec(trimmed);
    if (heading) {
      keep();
      version = heading[1];
      docs = false;
      line = null;
      continue;
    }
    if (!version) continue;
    if (trimmed.startsWith("### ")) {
      docs = DOCS_GROUP.test(trimmed);
      continue;
    }
    // The sha/compare line under a heading is metadata, not a bullet; a bullet in a docs group is
    // housekeeping. Everything else before the first such bullet is skipped.
    if (line || docs || !/^[-*]\s+/.test(trimmed)) continue;
    line = bulletLine(trimmed);
  }
  keep();
  return notes;
}

// x.y.z as three numbers, or null. Plain versions only: a range it cannot read is not a range, and
// guessing one would show the reader releases that are not between their build and the disk.
export function versionParts(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i.exec(String(v ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareParts(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

// The releases in (since, upto], newest first, each { version, note }. `since` missing or
// unreadable means the running build did not name its version: only the release on disk is listed,
// which is the short honest answer rather than a range nobody can vouch for.
export function betweenVersions(notes, since, upto) {
  const to = versionParts(upto);
  if (!to) return [];
  const from = versionParts(since);
  const found = [];
  const seen = new Set();
  for (const [version, note] of notes) {
    const parts = versionParts(version);
    if (!parts) continue;
    if (compareParts(parts, to) > 0) continue;
    if (from && compareParts(parts, from) <= 0) continue;
    if (!from && compareParts(parts, to) !== 0) continue;
    found.push({ version, note: note || null });
    seen.add(version);
  }
  const uptoText = String(upto).trim();
  if (!seen.has(uptoText) && (!from || compareParts(to, from) > 0)) {
    found.push({ version: uptoText, note: null });
  }
  found.sort((a, b) => compareParts(versionParts(b.version), versionParts(a.version)));
  return found;
}

// The held parse. `stat`/`read`/`parse` are seams for the tests; production uses the defaults.
export function createReleaseNotes({ file, read = readFile, stat: statFn = stat, parse = parseReleaseNotes, log = () => {} } = {}) {
  let held = null;
  let inflight = null;

  async function stampOf() {
    let info = null;
    try {
      info = await statFn(file);
    } catch {
      return null;
    }
    return info ? { key: `${Math.round(info.mtimeMs)}:${info.size}`, at: new Date(info.mtimeMs).toISOString() } : null;
  }

  async function load() {
    const stamp = await stampOf();
    if (!stamp) return { key: null, at: null, state: "missing", notes: new Map() };
    if (held && held.key === stamp.key) return held;
    if (inflight && inflight.key === stamp.key) return inflight.promise;
    const key = stamp.key;
    const promise = (async () => {
      try {
        const entry = { key, at: stamp.at, state: "ok", notes: parse(await read(file, "utf8")) };
        held = entry;
        return entry;
      } catch (e) {
        // An unreadable file is not a reason to forget the last good parse: it is why the chip
        // says nothing new rather than going blank.
        log(`the changelog could not be read: ${String((e && e.message) || e)}`);
        return held && held.key === key ? held : { key, at: stamp.at, state: "unreadable", notes: new Map() };
      } finally {
        if (inflight && inflight.key === key) inflight = null;
      }
    })();
    inflight = { key, promise };
    return promise;
  }

  async function between(since, upto) {
    const entry = await load();
    const from = versionParts(since);
    const to = versionParts(upto);
    return {
      since: from ? String(since).trim() : null,
      upto: to ? String(upto).trim() : null,
      at: entry.at,
      state: entry.state,
      releases: betweenVersions(entry.notes, since, upto),
    };
  }

  return { between };
}
