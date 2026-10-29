// The versioned static bundle: the hash, its stability, and the shell it rewrites.
//
// The point of all three is that a URL only moves when the bytes under it move. These cases drive
// the module over a throwaway public/ so a change of size, of mtime or of walk order is measured
// rather than assumed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBuild, hashBytes, readBundle, rewriteShell, versionOf } from "../lib/build-version.js";

const INDEX = `<!DOCTYPE html>
<html><head>
  <link rel="stylesheet" href="/style.css" />
</head><body>
  <script src="/core/dom.js"></script>
  <script src="/core/nested/extra.js"></script>
  <script src="/app.js"></script>
  <script src="/assistant.js"></script>
  <script src="/board/hot.js"></script>
  <script src="https://cdn.example.test/vendor.js"></script>
  <a href="/somewhere">not an asset</a>
</body></html>
`;

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-build-"));
  await mkdir(path.join(dir, "core", "nested"), { recursive: true });
  await mkdir(path.join(dir, "board"), { recursive: true });
  await writeFile(path.join(dir, "index.html"), INDEX);
  await writeFile(path.join(dir, "app.js"), "console.log('app');\n");
  await writeFile(path.join(dir, "style.css"), ":root { color: red }\n");
  await writeFile(path.join(dir, "assistant.js"), "/* assistant */\n");
  await writeFile(path.join(dir, "board", "hot.js"), "/* hot */\n");
  await writeFile(path.join(dir, "core", "dom.js"), "/* dom */\n");
  await writeFile(path.join(dir, "core", "nested", "extra.js"), "/* extra */\n");
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("the bundle is the shell, its own files, everything it references and all of core/", async (t) => {
  const dir = await fixture(t);
  const bundle = await readBundle(dir);
  assert.deepEqual(
    Object.keys(bundle.files).sort(),
    [
      "app.js",
      "assistant.js",
      "board/hot.js",
      "core/dom.js",
      "core/nested/extra.js",
      "index.html",
      "style.css",
    ],
    "every local script and stylesheet in the shell, plus core/ walked to its leaves"
  );
  assert.equal(bundle.files["app.js"], createHash("sha256").update("console.log('app');\n").digest("hex"), "a per-file hash is the sha256 of the bytes");
  assert.match(bundle.version, /^[0-9a-f]{12}$/, "the version is a short hex digest");
  assert.equal(bundle.version, versionOf(bundle.files), "the version folds the per-file hashes");
});

test("the same bytes give the same version — a touch, a walk order or a second read does not move it", async (t) => {
  const dir = await fixture(t);
  const first = await readBundle(dir);
  const second = await readBundle(dir);
  assert.equal(second.version, first.version, "reading the bundle twice cannot move the URL");

  // mtime alone is not content. A rebuild that copies files in another order must not invalidate
  // every browser's cache.
  const later = new Date(Date.now() + 60_000);
  await utimes(path.join(dir, "app.js"), later, later);
  const touched = await readBundle(dir);
  assert.equal(touched.version, first.version, "an mtime change with identical bytes keeps the version");

  // …and the fold itself is order-independent.
  const files = { "a.js": "1".repeat(64), "b.js": "2".repeat(64) };
  assert.equal(versionOf(files), versionOf({ "b.js": "2".repeat(64), "a.js": "1".repeat(64) }));
});

test("one changed byte moves the version, and only that one", async (t) => {
  const dir = await fixture(t);
  const before = await readBundle(dir);
  await writeFile(path.join(dir, "core", "nested", "extra.js"), "/* extra, edited */\n");
  const after = await readBundle(dir);
  assert.notEqual(after.version, before.version, "a changed module is a different build");
  assert.notEqual(after.files["core/nested/extra.js"], before.files["core/nested/extra.js"]);
  assert.equal(after.files["app.js"], before.files["app.js"], "the untouched files keep their own hashes");
  assert.equal(hashBytes(Buffer.from("x")), createHash("sha256").update("x").digest("hex"));
});

test("the served shell carries the version on every bundle URL, and nowhere else", async (t) => {
  const dir = await fixture(t);
  const bundle = await readBundle(dir);
  const html = rewriteShell(bundle.html, bundle.version, bundle.files);

  assert.match(html, new RegExp(`<meta name="panel-build" content="${bundle.version}"`), "the page is told which build it is");
  for (const rel of ["style.css", "core/dom.js", "core/nested/extra.js", "app.js", "assistant.js", "board/hot.js"]) {
    assert.ok(html.includes(`href="/${rel}?v=${bundle.version}"`) || html.includes(`src="/${rel}?v=${bundle.version}"`), `${rel} must be fetched from a versioned URL`);
  }
  assert.ok(html.includes('src="https://cdn.example.test/vendor.js"'), "a CDN URL is not this bundle and is left alone");
  assert.ok(html.includes('href="/somewhere"'), "an anchor is not an asset and is left alone");
  assert.equal(rewriteShell(html, bundle.version, bundle.files), html, "rewriting an already rewritten shell changes nothing");
});

test("a running panel notices an edit under public/ and moves the build", async (t) => {
  const dir = await fixture(t);
  const lines = [];
  const build = createBuild({ publicDir: dir, log: (line) => lines.push(line) });

  const first = await build.current();
  assert.equal(first.bootedAt, build.bootedAt, "the boot time is fixed at construction");
  assert.equal((await build.current()).computedAt, first.computedAt, "an unchanged bundle is not re-read");

  await writeFile(path.join(dir, "style.css"), ":root { color: blue }\n");
  const second = await build.current();
  assert.notEqual(second.version, first.version, "the panel serves a new build without a restart");
  assert.ok(lines.some((l) => l.includes("static bundle changed on disk")), "and says so in the log");
  assert.equal(second.bootedAt, first.bootedAt, "a re-read is not a restart");

  const info = await build.info();
  assert.equal(info.version, second.version);
  assert.equal(info.bootedAt, first.bootedAt);
  assert.ok(Number.isInteger(info.uptimeSeconds) && info.uptimeSeconds >= 0);
  assert.equal(info.files["style.css"], second.files["style.css"], "the payload carries the per-file hashes");
});

test("the shell the server holds is the file, not the rewritten copy", async (t) => {
  const dir = await fixture(t);
  const bundle = await readBundle(dir);
  assert.equal(bundle.html, await readFile(path.join(dir, "index.html"), "utf8"), "the meta and ?v= are added per response, never written back");
  assert.equal(bundle.files["index.html"], hashBytes(Buffer.from(INDEX)), "and the shell's hash is of its raw bytes");
});
