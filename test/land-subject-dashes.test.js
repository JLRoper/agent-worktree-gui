// The message tools/land.mjs commits is ASCII: one hyphen between "changelog" and the release count.
//
// WHY: the render commit's subject is quoted by CHANGELOG.md itself and by every landing report, and it sat on
// main as a U+2014 ("docs: render the changelog" plus a long dash plus "452 releases"). The same defect was fixed
// in tools/version.mjs's bump subject; this file pins the land template the same way. The first case drives the
// real tool in a throwaway repository and reads the commit it made, so what is asserted is the character the tool
// emits, not the source's wording; the second calls the exported builder the CLI itself goes through, which is
// also the path a release count this repository has not seen yet takes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FILE, renderMessage } from "../tools/land.mjs";
import { ROOT, configureRepo, git } from "../tools/panel-testkit.mjs";

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const EM_DASH = 0x2014;
const EN_DASH = 0x2013;
const HYPHEN_MINUS = 0x2d;

// The offending code points, collected one at a time so an assertion names the character it rejects instead of
// trusting a regex literal that could itself be typed with a lookalike dash.
const longDashes = (text) =>
  [...String(text || "")].filter((c) => c.codePointAt(0) === EM_DASH || c.codePointAt(0) === EN_DASH);

const hyphen = String.fromCharCode(HYPHEN_MINUS);

function copyTools(dest) {
  mkdirSync(path.join(dest, "tools"), { recursive: true });
  for (const f of ["land.mjs", "changelog.mjs", "changelog-scope.mjs", "changelog-scope.json", "release-history.mjs", "release-tag.mjs", "verify-version-tags.mjs"]) {
    writeFileSync(
      path.join(dest, "tools", f),
      readFileSync(path.join(ROOT, "tools", f), "utf8").split(CR + LF).join(LF),
      "utf8",
    );
  }
}

function setVersion(work, v) {
  const file = path.join(work, "package.json");
  writeFileSync(file, readFileSync(file, "utf8").replace(/"version":\s*"[^"]*"/, `"version": "${v}"`), "utf8");
}

function land(work, ...args) {
  const r = spawnSync(process.execPath, [path.join(work, "tools", "land.mjs"), ...args], {
    cwd: work,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    windowsHide: true,
    timeout: 120000,
  });
  return { status: r.status, text: `${r.stdout || ""}${r.stderr || ""}` };
}

// A repository on main with three tagged releases, a GitHub remote naming the links, and a copy of the tool: the
// same shape test/land.test.js builds, which is what makes the render commit here the one a landing makes.
function sandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-land-dashes-"));
  const work = path.join(dir, "work");
  mkdirSync(work, { recursive: true });
  git(work, ["init", "-q", "-b", "main"]);
  configureRepo(work);
  git(work, ["config", "core.autocrlf", "false"]);
  git(work, ["remote", "add", "github", "https://github.com/JTest/sandbox.git"]);
  copyTools(work);
  writeFileSync(path.join(work, "package.json"), `{\n  "name": "sandbox",\n  "version": "1.0.0",\n  "private": true\n}\n`, "utf8");
  writeFileSync(path.join(work, FILE), "# Changelog\n", "utf8");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "feat: the first capability, so a release has something to name"]);
  setVersion(work, "1.1.0");
  git(work, ["commit", "-q", "-am", "feat: the second capability, and the version this release carries"]);
  setVersion(work, "1.2.0");
  git(work, ["commit", "-q", "-am", "feat: the third capability, and the version this release carries"]);
  return { dir, work, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the render commit's subject and body carry a plain hyphen and no long dash", () => {
  const box = sandbox();
  try {
    const { work } = box;
    const run = land(work, "--no-fetch", "--no-push");
    assert.equal(run.status, 0, run.text);

    const message = git(work, ["log", "-1", "--format=%B"]);
    const [subject, ...rest] = message.split("\n");
    const body = rest.join("\n").trim();

    assert.deepEqual(longDashes(message), [], `no U+2014 and no U+2013 in ${JSON.stringify(message)}`);
    assert.equal(subject, "docs: render the changelog - 3 releases", "the words are the template's words; only the separator changed");
    assert.ok(subject.includes(hyphen), "the changelog and the count are separated by a hyphen-minus");
    assert.deepEqual(longDashes(body), [], `no U+2014 and no U+2013 in the body ${JSON.stringify(body)}`);
    assert.match(body, /carries - never the branch's/, "the body's own dash is the same hyphen-minus");
    assert.deepEqual(
      { subject, body },
      renderMessage(3, "main"),
      "the commit is the builder's message, so the builder is what the test can pin",
    );
  } finally {
    box.done();
  }
});

test("the builder land.mjs uses emits ASCII for any release count and base", () => {
  const { subject, body } = renderMessage(452, "origin/main");
  assert.equal(subject, "docs: render the changelog - 452 releases");
  assert.deepEqual(longDashes(subject), []);
  assert.deepEqual(longDashes(body), []);
  assert.ok(subject.includes(hyphen), "the subject separates its words with a hyphen-minus");
  assert.match(body, /names the shas origin\/main carries - never the branch's/, "the base is still named, after a hyphen");
});
