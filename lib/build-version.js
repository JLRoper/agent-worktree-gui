// ---- the served client bundle, and its version --------------------------------------------
// public/ is read from disk on every request, which is right for a panel that is edited while it
// runs — but it means the URL of app.js never moves. A browser holding yesterday's copy keeps
// running it: the page's own script tags say the same thing, a hard cache (or a long-lived tab)
// has no reason to ask again, and a panel restart is invisible from the tab's side.
//
// The cure is a URL that changes with the bytes. Every file the shell loads is hashed, the
// hashes are folded into one short version, and the shell's <script>/<link> URLs are rewritten to
// carry it. The shell itself is served no-store (it is the only file whose URL cannot move), and
// a hashed asset is served immutable because a changed file changes its URL rather than the bytes
// behind an old one.
//
// The set is derived, not hand-kept: index.html, the three files the shell has always named, and
// every local script or stylesheet its tags reference — public/core, public/board and
// assistant.js included. A second list here would be one more thing to forget.
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export const SHELL = "index.html";
// Named even when a tag is missing: the shell is nothing without its own script and stylesheet,
// and core/ is what those scripts call. Everything else is picked up from index.html's tags.
const ALWAYS = [SHELL, "app.js", "style.css"];
const CORE_DIR = "core";

// Short enough for a URL and long enough that a collision is not a thing a local panel meets.
const VERSION_CHARS = 12;

export const hashBytes = (buf) => createHash("sha256").update(buf).digest("hex");

// Every same-origin script or stylesheet the shell loads, as public/-relative paths. A protocol
// URL (a CDN) and an anchor are not part of the bundle.
function referencedFiles(html) {
  const out = new Set();
  for (const tag of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const attr = /\b(?:src|href)\s*=\s*(["'])([^"']+)\1/i.exec(tag[0]);
    if (!attr) continue;
    const url = attr[2];
    if (!url.startsWith("/") || url.startsWith("//")) continue;
    const withoutHash = url.split("#")[0].split("?")[0];
    const rel = withoutHash.replace(/^\/+/, "");
    if (!rel || rel.includes("..")) continue;
    out.add(rel);
  }
  return out;
}

async function walk(dir, prefix) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === "ENOENT") return []; // no core/ at all is not a broken bundle
    throw e;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out = [];
  for (const ent of entries) {
    const rel = `${prefix}/${ent.name}`;
    if (ent.isDirectory()) out.push(...(await walk(path.join(dir, ent.name), rel)));
    else if (ent.isFile()) out.push(rel);
  }
  return out;
}

// The bundle's one version: a hash of the sorted per-file hashes, so the same bytes give the same
// number whatever the walk order or the files' mtimes, and any changed byte gives a new one.
export function versionOf(files) {
  const h = createHash("sha256");
  for (const rel of Object.keys(files).sort()) h.update(`${rel}\0${files[rel]}\n`);
  return h.digest("hex").slice(0, VERSION_CHARS);
}

// Read the bundle once: the shell's own text (its raw bytes are what gets hashed, never the
// rewritten output), the per-file hashes, and the version they fold to.
export async function readBundle(publicDir) {
  const shellBuf = await readFile(path.join(publicDir, SHELL));
  const html = shellBuf.toString("utf8");
  const files = new Set([...ALWAYS, ...referencedFiles(html), ...(await walk(path.join(publicDir, CORE_DIR), CORE_DIR))]);
  const hashes = {};
  for (const rel of [...files].sort()) {
    if (rel === SHELL) {
      hashes[rel] = hashBytes(shellBuf);
      continue;
    }
    try {
      hashes[rel] = hashBytes(await readFile(path.join(publicDir, rel)));
    } catch (e) {
      // A tag that names a file which is not there is already a 404 in the page; it is not a
      // reason to refuse a version to everything else.
      if (e && (e.code === "ENOENT" || e.code === "EISDIR")) continue;
      throw e;
    }
  }
  return { html, files: hashes, version: versionOf(hashes) };
}

// The shell as it is served: the meta tag that tells the page which build it is running, and a
// ?v= on every URL that belongs to the bundle. Idempotent — an existing ?v= and an existing meta
// are replaced, so serving a file that was already rewritten cannot stack them.
export function rewriteShell(html, version, files) {
  const withoutMeta = html.replace(/[ \t]*<meta\s+name="panel-build"[^>]*>\r?\n?/gi, "");
  const withVersions = withoutMeta.replace(/<(script|link)\b[^>]*>/gi, (tag) => {
    const attr = /\b(src|href)\s*=\s*(["'])([^"']+)\2/i.exec(tag);
    if (!attr) return tag;
    const raw = attr[3];
    if (!raw.startsWith("/") || raw.startsWith("//")) return tag;
    const [beforeHash, hash] = raw.split("#");
    const [pathOnly] = beforeHash.split("?");
    const rel = pathOnly.replace(/^\/+/, "");
    if (!(rel in files)) return tag;
    const next = `${pathOnly}?v=${version}${hash ? `#${hash}` : ""}`;
    return `${tag.slice(0, attr.index)}${attr[1]}="${next}"${tag.slice(attr.index + attr[0].length)}`;
  });
  const meta = `  <meta name="panel-build" content="${version}" />\n`;
  return withVersions.replace(/<\/head>/i, `${meta}</head>`);
}

// The bundle as the server holds it. It is read at boot and re-read only when a file's mtime or
// size moves (the panel is edited while it runs, and a version that could not follow an edit
// would serve new bytes under the old URL — the exact staleness this exists to stop).
export function createBuild({ publicDir, bootedAt = new Date(), log = () => {} } = {}) {
  const bootedAtIso = bootedAt.toISOString();
  let current = null;
  let pending = null;
  let warned = false;

  const stampOf = async (target) => {
    const s = await stat(target).catch(() => null);
    return s ? { mtimeMs: s.mtimeMs, size: s.size } : null;
  };

  async function scan() {
    const bundle = await readBundle(publicDir);
    const stamps = {};
    for (const rel of Object.keys(bundle.files)) {
      const stamp = await stampOf(path.join(publicDir, rel));
      if (stamp) stamps[rel] = stamp;
    }
    // A file ADDED under core/ (or removed) moves the directory, and the file set with it.
    const coreDir = await stampOf(path.join(publicDir, CORE_DIR));
    if (coreDir) stamps[`${CORE_DIR}/`] = coreDir;
    const prev = current?.version || null;
    current = {
      version: bundle.version,
      files: bundle.files,
      html: bundle.html,
      stamps,
      bootedAt: bootedAtIso,
      computedAt: new Date().toISOString(),
    };
    if (prev && prev !== bundle.version) log(`static bundle changed on disk: ${prev} → ${bundle.version} — an open tab is offered the reload`);
    return current;
  }

  async function stale() {
    for (const [rel, prev] of Object.entries(current.stamps)) {
      const target = rel.endsWith("/") ? path.join(publicDir, rel.slice(0, -1)) : path.join(publicDir, rel);
      const now = await stampOf(target);
      if (!now || now.mtimeMs !== prev.mtimeMs || now.size !== prev.size) return true;
    }
    return false;
  }

  function refresh() {
    if (!pending) {
      pending = scan()
        .catch((e) => {
          // A half-written file (or no public/ at all) must not take the panel down: the page keeps
          // its previous version, the shell is still served, and the log says why the build moved.
          if (!warned) log(`static bundle could not be read: ${String((e && e.message) || e)} — serving it unversioned`);
          warned = true;
          return current || { version: "", files: {}, html: "", stamps: {}, bootedAt: bootedAtIso, computedAt: null };
        })
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  }

  async function get() {
    if (pending) return pending;
    // An empty version means the last read failed (or there was no public/ at boot): keep trying,
    // because the file that was missing may be back, and "unversioned" must not be sticky.
    if (!current || !current.version) return refresh();
    if (await stale()) return refresh();
    return current;
  }

  return {
    bootedAt: bootedAtIso,
    current: get,
    refresh,
    info: async () => {
      const b = await get();
      return {
        version: b.version,
        bootedAt: b.bootedAt,
        computedAt: b.computedAt,
        uptimeSeconds: Math.max(0, Math.round((Date.now() - Date.parse(b.bootedAt)) / 1000)),
        files: b.files,
      };
    },
  };
}
