// The docs mirror: what the board serves at /docs/ and /reviews/ is a COPY of docs/ and
// docs/reviews/, made when a page is requested. These cases pin the copy (new files, changed
// files, deleted files, nested folders), the throttle that keeps a page's asset burst to one
// walk, and the route itself: three real pages served, and a mirror that had gone stale repaired
// on the next request instead of answered.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MIRROR_ROOTS, SYNC_WINDOW_MS, mirrorRootFor, refreshMirror, resetMirrorClock, syncMirror } from "../lib/http/docs-mirror.js";
import { serveStatic } from "../lib/http/static.js";

// The checkout this test file belongs to: the same tree lib/http/static.js serves public/ from.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const statOf = (p) => stat(p).catch(() => null);

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-docs-mirror-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "docs");
  const target = path.join(dir, "public", "docs");
  await mkdir(path.join(source, "reports"), { recursive: true });
  await writeFile(path.join(source, "architecture.html"), "<html>architecture one</html>\n");
  await writeFile(path.join(source, "reports", "round.html"), "<html>round one</html>\n");
  return { dir, source, target };
}

test("a request path belongs to one mirror root, and only on its own prefix", () => {
  assert.equal(mirrorRootFor("docs/architecture.html"), MIRROR_ROOTS[0], "a page under docs/ is the docs root");
  assert.equal(mirrorRootFor("/docs/architecture.html"), MIRROR_ROOTS[0], "a leading slash is stripped, not a second prefix");
  assert.equal(mirrorRootFor("reviews/ping-pong-round-7.html"), MIRROR_ROOTS[1], "a page under reviews/ is the reviews root");
  assert.equal(mirrorRootFor("docs-old/architecture.html"), null, "docs-old is not docs");
  assert.equal(mirrorRootFor("index.html"), null, "the shell is not a mirror");
  assert.equal(mirrorRootFor(""), null, "an empty path is not a mirror");
});

test("the first sync copies the tree, nested folders included, and the second copies nothing", async (t) => {
  const { source, target } = await fixture(t);

  const first = await syncMirror(source, target);
  assert.deepEqual({ copied: first.copied, removed: first.removed, files: first.files }, { copied: 2, removed: 0, files: 2 });
  assert.equal(await readFile(path.join(target, "architecture.html"), "utf8"), "<html>architecture one</html>\n");
  assert.equal(await readFile(path.join(target, "reports", "round.html"), "utf8"), "<html>round one</html>\n");

  // The copy carries the source's mtime, which is what lets an unchanged file settle.
  const from = await stat(path.join(source, "architecture.html"));
  const to = await stat(path.join(target, "architecture.html"));
  assert.ok(Math.abs(from.mtimeMs - to.mtimeMs) < 2, `the copy keeps the source's mtime (${from.mtimeMs} vs ${to.mtimeMs})`);

  const second = await syncMirror(source, target);
  assert.equal(second.copied, 0, "a second pass has nothing to copy");
  assert.equal(second.removed, 0, "and nothing to remove");
});

test("a changed page is copied again, and a page the source dropped is removed", async (t) => {
  const { source, target } = await fixture(t);
  await syncMirror(source, target);

  // Same length, different bytes: size alone would miss this, the mtime is what catches it.
  await writeFile(path.join(source, "architecture.html"), "<html>architecture two</html>\n");
  await rm(path.join(source, "reports", "round.html"));

  const next = await syncMirror(source, target);
  assert.equal(next.copied, 1, "the edited page is the one copied");
  assert.equal(next.removed, 1, "the dropped page is removed, so a deleted page 404s");
  assert.equal(await readFile(path.join(target, "architecture.html"), "utf8"), "<html>architecture two</html>\n");
  assert.equal(await statOf(path.join(target, "reports", "round.html")), null, "the copy is gone, not just stale");
});

test("a missing source folder is a no-op, not a wipe of the copy", async (t) => {
  const { dir, target } = await fixture(t);
  await syncMirror(path.join(dir, "docs"), target);
  const gone = await syncMirror(path.join(dir, "no-such-docs"), target);
  assert.equal(gone.copied, 0);
  assert.equal(gone.removed, 0);
  assert.equal(gone.skipped, "no source folder");
  assert.ok(await statOf(path.join(target, "architecture.html")), "without a source there is nothing to sync against, so nothing is deleted");
});

test("a current page is two stats, and a burst is one walk per root", async () => {
  resetMirrorClock();
  const root = MIRROR_ROOTS[0];
  const page = "gateway-usage-changes.html";

  const first = await refreshMirror(`${root.route}${page}`, { force: true });
  assert.equal(typeof first.copied, "number", "a forced refresh is a real walk");

  const current = await refreshMirror(`${root.route}${page}`);
  assert.equal(current.skipped, "current", "a page whose copy is the source's bytes costs two stats, not a walk");

  // A page the source does not have still needs the walk (its copy must go), and that is what
  // the window throttles - the walk is the expensive half, not the stat.
  const missing = await refreshMirror(`${root.route}no-such-page.html`);
  assert.equal(missing.skipped, "inside the sync window", "the page's own asset burst does not walk the tree again");
  assert.equal(missing.files, null);

  assert.ok(SYNC_WINDOW_MS <= 2000, "the window stays short enough that a stale page is a second old at most");
  assert.equal(await refreshMirror("index.html"), null, "a path outside the mirrors asks for no sync");
  resetMirrorClock();
});

test("a path that climbs out of its root is refused, not mirrored", async () => {
  // public/app.js exists beside public/docs; a `..` after the prefix must not reach it through
  // the mirror, either to read it or to write it.
  const climbed = await refreshMirror("docs/../app.js", { force: true });
  assert.equal(climbed.skipped, "outside the mirror root");
  assert.equal(mirrorRootFor("docs/..\\app.js"), MIRROR_ROOTS[0], "the backslash form is still recognised as the docs prefix");
  assert.equal((await refreshMirror("docs/..\\app.js", { force: true })).skipped, "outside the mirror root", "and refused as a path out of the root");
});

// ---- the route the board serves -------------------------------------------------------------
// These run against this checkout's own docs/, because that is the tree the static route reads
// (lib/http/static.js derives public/ from its own file). The three pages are the proof the row
// asked for: the docs root, a nested page, and one from reviews/, which the hand-kept mirror had
// 1 of 226 files of.

const SERVED = [
  "docs/gateway-usage-changes.html",
  "docs/reports/worktree-aggregate-2026-11-13.html",
  "reviews/ping-pong-round-7-dossier-2026-11-09.html",
];
// /reviews/ is the mirror of docs/reviews/, so that is where its source file lives.
const SOURCE_OF = (rel) =>
  rel.startsWith("reviews/") ? path.join(ROOT, "docs", "reviews", rel.slice("reviews/".length)) : path.join(ROOT, rel);

async function serve(route) {
  const res = {
    code: null,
    headers: null,
    body: null,
    writeHead(code, headers) {
      this.code = code;
      this.headers = headers;
      return this;
    },
    end(body) {
      this.body = body;
    },
  };
  await serveStatic({ url: route, headers: {} }, res, route, null);
  return res;
}

test("the three pages are served, byte-identical to the source files", async () => {
  resetMirrorClock();
  for (const rel of SERVED) {
    const answer = await serve(`/${rel}`);
    assert.equal(answer.code, 200, `/${rel} is served (got ${answer.code})`);
    const source = await readFile(SOURCE_OF(rel));
    assert.equal(answer.body.length, source.length, `/${rel} has the source's length`);
    assert.ok(answer.body.equals(source), `/${rel} is byte-identical to its source file`);
  }
});

test("a page the copy had gone stale on is repaired on the next request, not answered", async () => {
  // The defect this replaces: public/reviews held 1 file of 226, so /reviews/<page> was a 404.
  // Damage the copy the way a hand copy goes stale, then prove one request puts the source's
  // bytes back instead of serving the stale ones.
  const rel = "docs/gateway-usage-changes.html";
  const mirrorCopy = path.join(ROOT, "public", "docs", "gateway-usage-changes.html");
  await mkdir(path.dirname(mirrorCopy), { recursive: true });
  await writeFile(mirrorCopy, "<html>stale copy from months ago</html>\n");
  resetMirrorClock();

  const answer = await serve(`/${rel}`);
  const source = await readFile(SOURCE_OF(rel));
  assert.equal(answer.code, 200);
  assert.ok(answer.body.equals(source), "the request answered the source's bytes, not the stale copy");
  assert.ok((await readFile(mirrorCopy)).equals(source), "and the copy on disk is the source's again");
});
