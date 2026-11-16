// The repo's own pages, served as their own static roots: /docs/... reads docs/ and /reviews/...
// reads docs/reviews/, each with its own containment check and the same MIME and cache policy as
// public/. These cases pin the roots (a real page from each, byte-identical to its source), the two
// refusals (a `..` out of the named root is a 403, a missing page is a 404 and not a 500), the
// panel's own files still answering beside them, and the fact that a stale copy left in public/docs
// can no longer shadow the source it used to be a copy of.
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DOCS_DIR, PAGE_ROOTS, PUBLIC_DIR, REVIEWS_DIR, pageRootFor, serveStatic } from "../lib/http/static.js";

// The checkout this test file belongs to: the same tree lib/http/static.js serves from.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function firstHtml(dir) {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".html")).sort();
  assert.ok(names.length > 0, `there is an HTML page in ${path.relative(ROOT, dir)} to serve`);
  return names[0];
}

async function serve(route) {
  const res = {
    code: null,
    headers: null,
    body: null,
    writeHead(code, headers) {
      this.code = code;
      this.headers = headers || {};
      return this;
    },
    end(body) {
      this.body = body;
    },
  };
  await serveStatic({ url: route, headers: {} }, res, route, null);
  return res;
}

test("a request path names one root, and only on its own prefix", () => {
  assert.equal(pageRootFor("docs/architecture.md"), PAGE_ROOTS[0], "docs/ is the docs root");
  assert.equal(pageRootFor("docs/reports/x.html"), PAGE_ROOTS[0], "a nested page stays in the docs root");
  assert.equal(pageRootFor("reviews/x.html"), PAGE_ROOTS[1], "reviews/ is the reviews root");
  assert.equal(pageRootFor("docs-old/x.html"), null, "docs-old is not docs");
  assert.equal(pageRootFor("index.html"), null, "the shell is a public/ file");
  assert.equal(pageRootFor(""), null, "an empty path is a public/ file");
  assert.equal(PAGE_ROOTS[1].dir, REVIEWS_DIR, "the reviews root is docs/reviews");
  assert.equal(PAGE_ROOTS[0].dir, DOCS_DIR, "the docs root is docs/");
});

test("a docs page, a report and a reviews page are served byte-identical to their sources", async () => {
  const pages = [
    { route: `docs/${await firstHtml(DOCS_DIR)}`, source: path.join(DOCS_DIR, await firstHtml(DOCS_DIR)) },
    { route: `docs/reports/${await firstHtml(path.join(DOCS_DIR, "reports"))}`, source: path.join(DOCS_DIR, "reports", await firstHtml(path.join(DOCS_DIR, "reports"))) },
    { route: `reviews/${await firstHtml(REVIEWS_DIR)}`, source: path.join(REVIEWS_DIR, await firstHtml(REVIEWS_DIR)) },
  ];
  for (const page of pages) {
    const answer = await serve(`/${page.route}`);
    assert.equal(answer.code, 200, `/${page.route} is served (got ${answer.code})`);
    assert.equal(answer.headers["Content-Type"], "text/html; charset=utf-8", `/${page.route} keeps the MIME table's type`);
    assert.equal(answer.headers["Cache-Control"], "no-store", `/${page.route} is no-store, never a versioned asset`);
    const source = await readFile(page.source);
    assert.equal(answer.body.length, source.length, `/${page.route} has the source's length`);
    assert.ok(answer.body.equals(source), `/${page.route} is byte-identical to ${path.relative(ROOT, page.source)}`);
  }
});

test("a `..` out of the named root is a 403, never a read beside it", async () => {
  for (const route of [
    "/docs/../config.json",
    "/docs/../../config.json",
    "/reviews/../architecture-modules.html",
    "/reviews/..\\architecture-modules.html",
    "/docs/..",
    "/docs/../package.json",
  ]) {
    const answer = await serve(route);
    assert.equal(answer.code, 403, `${route} is refused (got ${answer.code})`);
    assert.equal(String(answer.body), "forbidden", `${route} says why`);
  }
});

test("a missing page is a 404 and never a 500", async () => {
  for (const route of ["/docs/no-such-file.html", "/reviews/no-such-file.html", "/docs/reports/no-such-file.html"]) {
    const answer = await serve(route);
    assert.equal(answer.code, 404, `${route} is missing, not a server fault (got ${answer.code})`);
  }
});

test("the panel shell and its own assets still answer beside the page roots", async () => {
  const shell = await serve("/");
  assert.equal(shell.code, 200, "the shell is served");
  assert.equal(shell.headers["Cache-Control"], "no-store, must-revalidate", "the shell is still never cached");
  assert.ok(shell.body.length > 0, "with its bytes");

  const asset = await serve("/app.js");
  assert.equal(asset.code, 200, "a public/ asset is served");
  assert.equal(asset.headers["Content-Type"], "text/javascript; charset=utf-8", "with the MIME table's type");

  // docs-old/ is a public/ path, not the docs root: the prefix is matched with its separator.
  const beside = await serve("/docs-old/index.html");
  assert.equal(beside.code, 404, "docs-old/ is read from public/, where nothing sits (got " + beside.code + ")");
});

test("a stale copy in public/docs cannot shadow the source the root reads", async (t) => {
  const page = await firstHtml(DOCS_DIR);
  const copyDir = path.join(PUBLIC_DIR, "docs");
  const copy = path.join(copyDir, page);
  await mkdir(copyDir, { recursive: true });
  await writeFile(copy, "<html>a copy from the days the board mirrored docs/</html>\n");
  t.after(() => rm(copyDir, { recursive: true, force: true }));

  const answer = await serve(`/docs/${page}`);
  const source = await readFile(path.join(DOCS_DIR, page));
  assert.equal(answer.code, 200);
  assert.ok(answer.body.equals(source), "the request answered docs/'s bytes, not the copy beside it");

  // The old defect in one read: the copy on disk is not what a request is served from any more.
  assert.notEqual((await readFile(copy, "utf8")).length, source.length, "the copy is untouched, and unused");
  assert.ok(await stat(path.join(DOCS_DIR, page)), "the source is still the file being read");
});

test("an encoded `..` is a literal name that 404s, not a way out of the root", async () => {
  // No percent-decoding happens on the way in, so this reaches the root as one odd file name.
  const answer = await serve("/docs/%2e%2e/config.json");
  assert.equal(answer.code, 404, `an encoded climb is a missing file (got ${answer.code})`);
});
