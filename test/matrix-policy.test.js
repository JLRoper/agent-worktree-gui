// lib/matrix-policy.js, the policy the Bridge tab edits and the bridge turn carries.
//
// What this pins:
//   1. the precedence is PANEL > environment default > template, and the answer says which one is in force;
//   2. a save is the whole file (tmp+rename), survives a reload byte for byte, and reports the mtime the next save
//      is guarded against;
//   3. an empty save clears the panel's copy and lets the environment default (or the template) fill the gap —
//      deleting the file is not the only way to back out;
//   4. the cap and the mtime guard are refusals with their own codes, and a refused save leaves the file untouched;
//   5. `textForTurn` is the effective text, and the preamble is empty when there is no policy — so the next row
//      cannot inject a heading with nothing under it.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MATRIX_POLICY_ENV,
  MATRIX_POLICY_MAX_CHARS,
  MatrixPolicyStore,
  envPolicyText,
  matrixPolicyPreamble,
  matrixPolicyTemplate,
  resolvePolicyText,
  writePolicyFile,
} from "../lib/matrix-policy.js";

async function scratch(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wag-matrix-policy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, "state", "matrix-policy.md") };
}

test("the template names the four subjects the tab promises, and carries no credential", () => {
  const body = matrixPolicyTemplate();
  for (const subject of ["## Tone", "## When you may ping my phone", "## Quiet hours", "## Which assistant to route to"]) {
    assert.ok(body.includes(subject), `the template must open on ${subject}`);
  }
  assert.ok(body.includes(MATRIX_POLICY_ENV), "it names the environment default it loses to");
  assert.doesNotMatch(body, /MATRIX_PASSWORD|bridge\.env=|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, "no secret or token shape");
  assert.ok(body.length < MATRIX_POLICY_MAX_CHARS, "the seed fits the cap with room to edit");
});

test("precedence is panel > environment default > template, and the source is stated", () => {
  assert.deepEqual(resolvePolicyText({ panelText: "", envText: "", template: "T" }), { text: "T", source: "template" });
  assert.deepEqual(resolvePolicyText({ panelText: "  \n ", envText: "E", template: "T" }), { text: "E", source: "env" });
  assert.deepEqual(resolvePolicyText({ panelText: "P", envText: "E", template: "T" }), { text: "P", source: "panel" });
  // The reader's bytes are not trimmed: formatting in a policy is part of the instruction.
  assert.deepEqual(resolvePolicyText({ panelText: " P\n\n", envText: "E", template: "" }), { text: " P\n\n", source: "panel" });
});

test("envPolicyText reads only the panel's own variable and trims the trailing newline an export leaves", () => {
  assert.equal(envPolicyText({ [MATRIX_POLICY_ENV]: "  be brief\n" }), "be brief");
  assert.equal(envPolicyText({ MATRIX_PASSWORD: "must-not-be-read" }), "");
  assert.equal(envPolicyText(null), "");
});

test("a panel with no file and no environment carries the template, and says so", async (t) => {
  const { file } = await scratch(t);
  const store = new MatrixPolicyStore({ file, env: {} });
  const out = store.payload();
  assert.equal(out.source, "template");
  assert.equal(out.saved, false);
  assert.equal(out.exists, false);
  assert.equal(out.text, matrixPolicyTemplate());
  assert.equal(out.cap, MATRIX_POLICY_MAX_CHARS);
  assert.equal(out.envVar, MATRIX_POLICY_ENV);
  assert.equal(out.path.includes("\\"), false, "the page gets a forward-slash path");
});

test("an environment default fills a panel that has never saved, and loses the moment the reader saves", async (t) => {
  const { file } = await scratch(t);
  const store = new MatrixPolicyStore({ file, env: { [MATRIX_POLICY_ENV]: "From the environment." } });
  assert.equal(store.payload().source, "env");
  assert.equal(store.payload().text, "From the environment.");

  const saved = store.save("From the panel.\nSecond line.", {});
  assert.equal(saved.source, "panel");
  assert.equal(saved.text, "From the panel.\nSecond line.");
  assert.equal(saved.saved, true);
  assert.ok(saved.mtime > 0 && Number.isFinite(Date.parse(saved.mtimeIso)));
  // A second store reads the file, not a cache: the panel is the source of truth.
  assert.equal(new MatrixPolicyStore({ file, env: { [MATRIX_POLICY_ENV]: "From the environment." } }).payload().text, "From the panel.\nSecond line.");
});

test("a save replaces the file whole, byte for byte, and the mtime it returns is the guard the next save gets", async (t) => {
  const { file } = await scratch(t);
  const store = new MatrixPolicyStore({ file, env: {} });
  const body = "# Mine\n\n- short\n- quiet at night\n";
  const first = store.save(body);
  assert.equal(await readFile(file, "utf8"), body, "the file holds the reader's bytes, not a re-serialised copy");
  assert.equal(first.chars, body.length);

  const second = store.save("next", { expectMtime: first.mtime });
  assert.equal(second.text, "next");
  assert.equal((await stat(file)).mtimeMs, second.mtime, "the answer describes the bytes that are on disk");
});

test("an empty save clears the panel's copy and lets the default back in — a delete is not the only way out", async (t) => {
  const { file } = await scratch(t);
  const store = new MatrixPolicyStore({ file, env: { [MATRIX_POLICY_ENV]: "env default" } });
  store.save("mine");
  const cleared = store.save("", {});
  assert.equal(cleared.saved, true, "the file exists: the reader saved an empty policy");
  assert.equal(cleared.panelChars, 0);
  assert.equal(cleared.source, "env");
  assert.equal(cleared.text, "env default");
});

test("over the cap is a policy-too-long refusal, and the file is not touched", async (t) => {
  const { file } = await scratch(t);
  const store = new MatrixPolicyStore({ file, env: {}, cap: 12 });
  store.save("kept");
  const before = await readFile(file, "utf8");
  assert.throws(
    () => store.save("x".repeat(13)),
    (e) => e.code === "policy-too-long" && e.message.includes("13") && e.message.includes("12"),
  );
  assert.equal(await readFile(file, "utf8"), before, "a refused save leaves the reader's last good policy alone");
});

test("a file that moved under the caller is a policy-stale refusal, not a silent overwrite", async (t) => {
  const { file } = await scratch(t);
  const store = new MatrixPolicyStore({ file, env: {} });
  const first = store.save("original");
  // The assistant (or another surface) writes after this reader loaded the file.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(file, "written elsewhere", "utf8");
  assert.throws(
    () => store.save("mine", { expectMtime: first.mtime }),
    (e) => e.code === "policy-stale" && /changed on disk/.test(e.message),
  );
  assert.equal(await readFile(file, "utf8"), "written elsewhere", "the newer text is kept");
});

test("a save that is not a string is refused before the file moves", async (t) => {
  const { file } = await scratch(t);
  const store = new MatrixPolicyStore({ file, env: {} });
  for (const bad of [undefined, null, 7, {}, ["x"]]) {
    assert.throws(() => store.save(bad), (e) => e.code === "policy-text-required");
  }
  assert.equal(store.payload().saved, false, "nothing was created");
});

test("writePolicyFile is the bare writer: the same refusals without a store, and it creates the folder", async (t) => {
  const { file } = await scratch(t);
  assert.equal(writePolicyFile(file, "bare", {}), "bare");
  assert.equal(await readFile(file, "utf8"), "bare");
  assert.throws(() => writePolicyFile(file, "x".repeat(5), { cap: 4 }), (e) => e.code === "policy-too-long");
});

test("textForTurn is the effective text, and an empty policy injects nothing", async (t) => {
  const { file } = await scratch(t);
  const store = new MatrixPolicyStore({ file, env: {}, template: "" });
  assert.equal(store.textForTurn(), "", "no panel file, no env, no template: an empty policy");
  assert.equal(matrixPolicyPreamble(store.textForTurn()), "", "a heading with nothing under it is not injected");
  store.save("- be brief");
  assert.equal(store.textForTurn(), "- be brief");
  assert.match(matrixPolicyPreamble(store.textForTurn()), /^## How the reader wants the Matrix bridge to speak to them\n\n- be brief\n$/);
  // The payload carries that same preamble verbatim: the bridge appends ONE shape, built here, rather than a
  // Python copy of the heading that could drift from this one.
  assert.equal(store.payload().preamble, matrixPolicyPreamble(store.textForTurn()));
  assert.match(store.payload().preamble, /^- be brief\n$/m);
});
