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
import { readdirSync, watch } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { syncTiming } from "./sync-timing.js";

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
// The shell carries TWO facts about the build, not one. The hash says which bytes the tab is
// running; the number says which release those bytes were, which is what the update chip's
// expanded panel needs to name the releases between this tab and the disk. public/ has no record of
// the package version it shipped with, so the shell is stamped with it at serve time.
export function rewriteShell(html, version, files, semver = "") {
  const withoutMeta = html.replace(/[ \t]*<meta\s+name="panel-(?:build|version)"[^>]*>\r?\n?/gi, "");
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
  const meta =
    `  <meta name="panel-build" content="${version}" />\n` +
    (semver ? `  <meta name="panel-version" content="${semver}" />\n` : "");
  return withVersions.replace(/<\/head>/i, `${meta}</head>`);
}

// The bundle as the server holds it. It is read at boot and re-read only when a file's mtime or
// size moves (the panel is edited while it runs, and a version that could not follow an edit
// would serve new bytes under the old URL — the exact staleness this exists to stop).
//
// The freshness proof is the WATCHER's job, never a request's. A request is answered from the
// held bundle, which the watcher has already proved (or failed to disprove); a look at the disk
// is scheduled behind the response and its answer, when it lands, is what the *next* request
// reads. That is deliberate: the check is a chain of awaits, and on a loaded host each await is
// a turn of an event loop that may be seconds away — twenty-four of them in series is how a
// cached file came to take thirteen seconds. A request that never joins that chain cannot be
// held by it, and a check that cannot finish in time leaves the last good bundle in place.
//
// So there are two clocks and no third: a watcher event (or the backstop, when the platform
// cannot watch or an event was missed) marks the bundle due, and one background check at a time
// re-reads it. `get()` is a field read and a possible `schedule()`; that is the whole hot path.
export function createBuild({ publicDir, semver = "", bootedAt = new Date(), log = () => {}, scanTimeoutMs = 1200, retryAfterMs = 10_000, bundleReader = readBundle, stat: statFn = stat, watchFn = watch, backstopMs = 300_000 } = {}) {
  const bootedAtIso = bootedAt.toISOString();
  let current = null;
  let inflight = null;
  // After a read or a check that ran out of time, serve what is held without starting another
  // attempt for this long: a disk that cannot answer would otherwise cost every attempt its own
  // timeout.
  let stuckUntil = 0;
  let warned = false;
  // The watcher is the authority: it arms on publicDir and every directory under it, and flips
  // `dirty` when a file there is written, renamed or added. `sweptAt` is when the held bundle
  // was last proved, so the backstop is a comparison rather than a timer of its own.
  let watcher = null;
  let dirty = false;
  let sweptAt = 0;
  // The one pending background check. A second is never queued behind a running one, and no
  // request ever waits on either.
  let timer = null;
  let checking = false;
  // A burst of writes (a save that rewrites a bundle) is one read, not one per file.
  const DIRTY_DEBOUNCE_MS = 25;
  // A watcher that cannot arm leaves the sweep as the only proof there is; it still may not run
  // more than this often, however many requests ask.
  const MIN_CHECK_GAP_MS = 250;

  // One recursive watcher per publicDir would be the shorter code, but its internal walk keeps a
  // handle past close on Windows once a watched directory is removed, and then a test runner or a
  // tool importing the panel would never exit. A plain watcher per directory has no such tail: the
  // directories are enumerated here (bounded), each watched non-recursively, and the set re-arms on
  // every scan so a directory born after the last scan gets its watcher then.
  const WATCH_MAX_DIRS = 200;
  const WATCH_MAX_DEPTH = 8;

  function closeWatchers() {
    try { watcher?.close?.(); } catch { /* the watcher is already gone */ }
    watcher = null;
  }

  function armWatcher() {
    if (typeof watchFn !== "function") return;
    closeWatchers();
    const dirs = [];
    const collect = (dir, depth) => {
      if (dirs.length >= WATCH_MAX_DIRS || depth > WATCH_MAX_DEPTH) return;
      dirs.push(dir);
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // an unreadable directory is not a reason to lose the watcher on the others
      }
      for (const ent of entries) {
        if (ent.isDirectory()) collect(path.join(dir, ent.name), depth + 1);
      }
    };
    collect(publicDir, 0);
    const arms = [];
    const closeAll = () => {
      while (arms.length) {
        const arm = arms.pop();
        try { arm.close?.(); } catch { /* the watcher is already gone */ }
      }
    };
    for (const dir of dirs) {
      try {
        // An event is the proof this module trusts: it does not answer the request that is
        // already being served (it has the held bundle) — it only asks for the re-read that the
        // NEXT request will read.
        const arm = watchFn(dir, {}, () => markDue());
        // Watchers are live handles and would hold a short-lived process (a test runner, a tool)
        // open after its last request; unref'd they still deliver events while anything else keeps
        // the loop alive, which the server that arms them always does.
        arm.unref?.();
        // A watcher that errors is not a reason to stat on every request again: `watcher` going
        // null puts the backstop in charge, still behind the response.
        arm.on?.("error", () => { closeAll(); watcher = null; });
        arms.push(arm);
      } catch { /* a directory that vanished between the walk and here is simply not watched */ }
    }
    watcher = arms.length ? { close: closeAll } : null;
  }

  // What a watcher event does: mark the held bundle unproved and ask for one background check.
  function markDue() {
    dirty = true;
    schedule(DIRTY_DEBOUNCE_MS);
  }

  // One pending check, never a queue: a check that is already running (or a read that is still
  // out) is the one that will settle this. Unref'd so a short-lived process that only imported the
  // module is not held open by a pending look at the disk.
  function schedule(delay = 0) {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void check();
    }, Math.max(0, delay));
    timer.unref?.();
  }
  let lastCheckAt = 0;

  const stampOf = async (target) => {
    const s = await statFn(target).catch(() => null);
    return s ? { mtimeMs: s.mtimeMs, size: s.size } : null;
  };

  async function scanBundle() {
    // Clear the dirty flag BEFORE reading: anything written while this scan runs re-sets it, and
    // the next check sweeps again rather than trusting a half-read tree.
    dirty = false;
    sweptAt = Date.now();
    const bundle = await bundleReader(publicDir);
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
      semver,
      files: bundle.files,
      html: bundle.html,
      stamps,
      bootedAt: bootedAtIso,
      computedAt: new Date().toISOString(),
    };
    if (prev && prev !== bundle.version) log(`static bundle changed on disk: ${prev} → ${bundle.version} — an open tab is offered the reload`);
    syncTiming.measure("static watcher setup", () => armWatcher());
    return current;
  }

  async function staleCheck() {
    for (const [rel, prev] of Object.entries(current.stamps)) {
      const target = rel.endsWith("/") ? path.join(publicDir, rel.slice(0, -1)) : path.join(publicDir, rel);
      const now = await stampOf(target);
      if (!now || now.mtimeMs !== prev.mtimeMs || now.size !== prev.size) return true;
    }
    return false;
  }

  const TIMED_OUT = Symbol("timed out");
  const unversioned = () => ({ version: "", semver, files: {}, html: "", stamps: {}, bootedAt: bootedAtIso, computedAt: null });

  // Everything this module waits on is bounded. A scan or a stat that never answers used to be a
  // wedge with no way out: the memoised promise was cleared only by its own `finally`, so one stuck
  // fs call took `/`, every asset and `/api/build` with it until the process restarted. A read that
  // runs out of time is reported, and the caller gets what is already held.
  function bounded(work, what) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        log(`${what} did not answer within ${scanTimeoutMs} ms - serving the last good bundle`);
        resolve(TIMED_OUT);
      }, scanTimeoutMs);
      timer.unref?.();
      work.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  // The background half of the pair. It decides whether the held bundle is still the one on disk
  // and, if it is not, re-reads it. Nothing awaits this but the timer that started it: a request
  // that came in while it runs is answered from `current`, which is the last bundle the watcher
  // proved, and is exactly what "serve the last good bundle" means when the check is slow.
  async function check() {
    if (checking || inflight) return;
    if (Date.now() < stuckUntil) {
      // A read that just ran out of time is not retried in a hot loop: come back when the cool-off
      // ends, and serve what is held until then.
      schedule(stuckUntil - Date.now());
      return;
    }
    checking = true;
    try {
      await prove();
    } finally {
      checking = false;
      // A write that landed while the check was running is still owed a read of its own.
      if (dirty) schedule(DIRTY_DEBOUNCE_MS);
    }
  }

  async function prove() {
    if (!current || !current.version || dirty) {
      // The watcher saw the tree move (or there is no bundle yet): the read is the answer.
      await refresh();
      return;
    }
    // No event and a watcher in play: the bundle is already proved, so not one file is statted.
    if (watcher && Date.now() - sweptAt < backstopMs) return;
    // No watcher at all (the platform cannot watch, or one errored out) or the backstop is due:
    // the stat sweep is the proof. Still off the request path, still bounded.
    if (Date.now() - lastCheckAt < MIN_CHECK_GAP_MS) {
      schedule(MIN_CHECK_GAP_MS - (Date.now() - lastCheckAt));
      return;
    }
    lastCheckAt = Date.now();
    let verdict;
    try {
      verdict = await bounded(staleCheck(), "the static bundle staleness check");
    } catch {
      return;
    }
    if (verdict === TIMED_OUT) {
      stuckUntil = Date.now() + retryAfterMs;
      // The bundle was never disproved, so it stays the answer — and the write that is still
      // landing has to be looked at again when the cool-off ends.
      if (dirty) schedule(stuckUntil - Date.now());
      return;
    }
    if (verdict === true) {
      await refresh();
      return;
    }
    dirty = false;
    sweptAt = Date.now();
  }

  function refresh() {
    if (inflight) return inflight;
    if (Date.now() < stuckUntil) return Promise.resolve(current || unversioned());
    inflight = bounded(scanBundle(), "the static bundle scan")
      .catch((e) => {
        // A half-written file (or no public/ at all) must not take the panel down: the page keeps
        // its previous version, the shell is still served, and the log says why the build moved.
        if (!warned) log(`static bundle could not be read: ${String((e && e.message) || e)} - serving it unversioned`);
        warned = true;
        // The bundle is unknown, not fresh: keep the flag up so the next check tries again after
        // the cool-off instead of waiting out the backstop.
        dirty = true;
        stuckUntil = Date.now() + retryAfterMs;
        return current || unversioned();
      })
      .then((value) => {
        if (value !== TIMED_OUT) return value;
        // The scan is still out there; a later answer still lands on `current` from `scanBundle`.
        // Until then, and for the cool-off, the panel serves what it already holds.
        stuckUntil = Date.now() + retryAfterMs;
        dirty = true;
        return current || unversioned();
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  // The request path. It is a field read: the held bundle is the answer. The only time it waits is
  // before any bundle exists at all, which is boot — the server awaits that read before it starts
  // listening, so no request ever lands there.
  async function get() {
    if (!current) return refresh();
    // Whether the held bundle is worth re-proving is the watcher's call and the clock's. It is
    // asked here, but only ever answered behind this response.
    if (!watcher || dirty || !current.version || Date.now() - sweptAt >= backstopMs) schedule();
    return current;
  }

  return {
    bootedAt: bootedAtIso,
    current: get,
    refresh,
    // The watchers are OS handles; a short-lived consumer (a test, a tool) closes them so the
    // process can exit — unref alone does not release the fs_event wake pipes on Windows, and a
    // deleted watched directory leaves them referenced for good. The pending check goes with them.
    close: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      closeWatchers();
    },
    info: async () => {
      const b = await get();
      return {
        version: b.version,
        semver,
        bootedAt: b.bootedAt,
        computedAt: b.computedAt,
        uptimeSeconds: Math.max(0, Math.round((Date.now() - Date.parse(b.bootedAt)) / 1000)),
        files: b.files,
      };
    },
  };
}
