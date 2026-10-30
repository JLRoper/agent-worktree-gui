// rowHtml reads `namedLine` for the rename button's tooltip on every non-root row. The PR #17 integration merge
// dropped its declaration, so the first real worktree row threw a ReferenceError and the chart drew only the
// project's own checkout while the header still counted every tree. This pins the declaration in place: every
// identifier rowHtml uses for naming must be declared inside rowHtml itself.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const begin = src.indexOf("function rowHtml(row) {");
assert.ok(begin >= 0, "public/app.js defines rowHtml");
const end = src.indexOf("\nfunction ", begin + 1);
const body = src.slice(begin, end > begin ? end : undefined);

for (const name of ["shownTitle", "suggestName", "namedLine"]) {
  test(`rowHtml declares ${name} before using it`, () => {
    const decl = new RegExp(`\\b(const|let|var)\\s+${name}\\b`).exec(body);
    assert.ok(decl, `rowHtml uses ${name} but does not declare it`);
    const firstUse = body.search(new RegExp(`\\$\\{${name}\\b|\\b${name}\\s*\\?`));
    if (firstUse >= 0) assert.ok(decl.index < firstUse, `${name} is used before it is declared`);
  });
}
