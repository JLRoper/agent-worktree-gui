// /api/open-url hands a URL to the operating system. The old opener was `cmd.exe /c start "" <url>`,
// which made cmd the parser of a string the caller controls. These assert the mechanism: no
// interpreter, and the URL stays one argument.
import assert from "node:assert/strict";
import test from "node:test";
import { openerFor, safeUrl } from "../lib/open-url.js";
import { post, startPanel } from "../tools/panel-testkit.mjs";

// A URL that is also a command injection if anything re-parses it as a command line.
const HOSTILE = "http://127.0.0.1:9/?a=1&calc.exe&b=2";

test("windows opens with explorer.exe, and never cmd.exe", () => {
  const { bin, args } = openerFor(HOSTILE, "win32");
  assert.equal(bin, "explorer.exe");
  assert.doesNotMatch(bin, /cmd(\.exe)?$/i, "cmd.exe re-parses its command line: a URL must never reach it");
});

test("the URL is one argv element on every platform", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const { args } = openerFor(HOSTILE, platform);
    assert.equal(args.length, 1, `${platform}: the URL must not be split into extra arguments`);
    assert.equal(args[0], HOSTILE, `${platform}: the whole URL is the argument, metacharacters included`);
  }
});

test("only http(s) leaves the server, and the refusal keeps its two sentences", () => {
  assert.equal(safeUrl("https://example.com/a?b=1&c=2").url, "https://example.com/a?b=1&c=2");
  assert.equal(safeUrl("file:///C:/Windows/System32/calc.exe").error, "only http(s) links can be opened");
  assert.equal(safeUrl("javascript:alert(1)").error, "only http(s) links can be opened");
  assert.equal(safeUrl("not a url").error, "not a URL");
});

test("the route refuses the same URL the opener would", async (t) => {
  const panel = await startPanel();
  t.after(() => panel.stop());
  const r = await post(panel.base, "/api/open-url", { body: { url: "file:///C:/Windows/System32/calc.exe" } });
  assert.equal(r.status, 400);
  assert.equal(r.json?.error, "only http(s) links can be opened");
});
