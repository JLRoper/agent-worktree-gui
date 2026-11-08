// The subject the version tool writes is ASCII: one hyphen between the number and the words.
//
// WHY: every landing's bump commit carries "chore: <n> - the version this landing carries". Until this test the
// template held a U+2014, so the dash reached terminal logs and the changelog render, where a reader picking the
// bytes up in a non-UTF-8 locale sees three bytes of mojibake. The subject is read by people, by grep and by the
// changelog renderer, so what is pinned here is the character the template emits, not the source's wording: the
// first case drives the real tool in a throwaway repository and reads the commit it made, and the second reads
// the two templates so the rewrite path (claim, when a number was taken) cannot drift back on its own.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GIT_TEST_ENV, ROOT, configureRepo, git, readSource } from "../tools/panel-testkit.mjs";

const VERSION = path.join(ROOT, "tools", "version.mjs");
const EM_DASH = 0x2014;
const EN_DASH = 0x2013;
const HYPHEN_MINUS = 0x2d;

// The offending code points, collected one at a time so the assertion names the character it rejects instead of
// trusting a regex literal that could itself be typed with a lookalike dash.
const longDashes = (text) =>
  [...text].filter((c) => c.codePointAt(0) === EM_DASH || c.codePointAt(0) === EN_DASH);

function tool(args, cwd) {
  const r = spawnSync(process.execPath, [VERSION, ...args], {
    cwd,
    encoding: "utf8",
    env: GIT_TEST_ENV,
    windowsHide: true,
    timeout: 120000,
  });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

// A repository on main declaring 1.0.0, with the identity written into .git/config so the tool's own commit does
// not depend on whatever global git configuration this machine happens to carry.
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-version-subject-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  git(dir, ["init", "-b", "main"]);
  configureRepo(dir);
  await writeFile(path.join(dir, "package.json"), `{\n  "name": "subject-fixture",\n  "version": "1.0.0"\n}\n`);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "feat: the change this landing carries"]);
  return dir;
}

test("apply writes a bump subject with an ASCII hyphen and no long dash", async (t) => {
  const dir = await fixture(t);
  const r = tool(["apply", "patch"], dir);
  assert.equal(r.code, 0, r.err);

  const subject = git(dir, ["log", "-1", "--format=%s"]);
  assert.deepEqual(longDashes(subject), [], `no U+2014 and no U+2013 in ${JSON.stringify(subject)}`);
  assert.equal(
    subject,
    "chore: 1.0.1 - the version this landing carries",
    "the words are the template's words; only the separator changed",
  );
  assert.ok(
    subject.includes(String.fromCharCode(HYPHEN_MINUS)),
    "the number and the words are separated by a hyphen-minus",
  );
  assert.match(r.out, /chore: 1\.0\.1 - the version this landing carries/, "the run's own report prints the same subject");
});

test("both subject templates in tools/version.mjs build an ASCII subject", () => {
  const templates = readSource("tools/version.mjs")
    .split("\n")
    .filter((line) => line.includes("const subject = `chore:"));
  assert.equal(templates.length, 2, "apply and claim each build a subject of their own");
  for (const line of templates) {
    assert.deepEqual(longDashes(line), [], `no U+2014 and no U+2013 in ${line.trim()}`);
    assert.match(line, /chore: \$\{[a-z]+\} - the version this landing carries/, "one ASCII hyphen, unchanged words");
  }
});
