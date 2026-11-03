// The rule that keeps a bad `config.json` remote from blanking the Verdict column.
//
// Measured shape of the bug (docs/rounds/playwright-round-1.md): both projects in config.json said
// `"remote": "github"`, this checkout has only `origin`, so `lib/project.js` and `lib/scheduler.js` built
// `github/main` for the header and for every row, git answered "Needed a single revision", and all ten rows read
// NO BASE REF. `tools/verify-base-ref.mjs` proves the whole board end to end; this file pins the rule itself, which
// is where an edge can quietly become a guess (several remotes and no `origin`; a read that failed; no remote at
// all) without needing a repository for each one except the last.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chooseRemote, resolveBaseRef } from "../lib/base-ref.js";
import { git } from "../tools/panel-testkit.mjs";

test("a configured remote the checkout has is used verbatim", () => {
  const out = chooseRemote("upstream", ["origin", "upstream"]);
  assert.deepEqual(out, { remote: "upstream", substituted: false, note: "" });
});

test("a configured remote that is absent falls back to origin, and the note says why", () => {
  const out = chooseRemote("github", ["origin"]);
  assert.equal(out.remote, "origin");
  assert.equal(out.substituted, true);
  assert.match(out.note, /configured remote 'github' is not in this checkout \(remotes: origin\); using 'origin'/);
});

test("with no origin, the only remote there is is the fallback", () => {
  const out = chooseRemote("github", ["sefl"]);
  assert.equal(out.remote, "sefl");
  assert.equal(out.substituted, true);
  assert.match(out.note, /using 'sefl'/);
});

test("several remotes and none of them origin: no guess, the configured name is left alone", () => {
  const out = chooseRemote("github", ["sefl", "bitbucket"]);
  assert.deepEqual(out, { remote: "github", substituted: false, note: "" });
});

test("a remote list that could not be read is not evidence: the configured name survives", () => {
  assert.deepEqual(chooseRemote("github", null), { remote: "github", substituted: false, note: "" });
});

test("no configured remote means no remote, and the base ref is the local main branch", async () => {
  const out = await resolveBaseRef({ name: "local", path: "C:/nowhere", remote: null, mainBranch: "main" });
  assert.equal(out.remote, null);
  assert.equal(out.remoteRef, "main");
  assert.equal(out.substituted, false);
});

test("resolveBaseRef reads the checkout's remotes, and names the substitution once, not once per call", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-base-ref-unit-"));
  try {
    git(dir, "init", "-q", "--bare", "-b", "main", `${dir}/origin.git`);
    git(dir, "init", "-q", "-b", "main", `${dir}/checkout`);
    git(`${dir}/checkout`, "remote", "add", "origin", `${dir}/origin.git`);
    const project = { name: "proof", path: `${dir}/checkout`, remote: "github", mainBranch: "main" };

    const lines = [];
    const real = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    let first;
    let second;
    try {
      first = await resolveBaseRef(project);
      second = await resolveBaseRef(project);
    } finally {
      console.log = real;
    }

    assert.deepEqual(
      { remote: first.remote, remoteRef: first.remoteRef, substituted: first.substituted },
      { remote: "origin", remoteRef: "origin/main", substituted: true },
    );
    assert.deepEqual(second, first);
    const named = lines.filter((l) => /is not in this checkout/.test(l));
    assert.equal(named.length, 1, `one line for the project, got: ${JSON.stringify(named)}`);
    assert.match(named[0], /project proof:/);
    assert.match(named[0], /remotes: origin/);
    assert.match(named[0], /its base ref is origin\/main/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
