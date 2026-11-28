// THE SHEETS THAT REPLACED public/style.css, read the way the page loads them.
//
// A test that pins a rule by reading the panel's stylesheet has to read EVERY sheet, in the order public/index.html
// links them: the cascade position a rule holds is half of what these tests assert, and a rule that moved to an
// earlier sheet is a different rule to the browser. chart.css and the shared core/ card sheets were already separate
// files before the split and are not part of this concatenation.
import { readFileSync } from "node:fs";

export function styleSheetFiles() {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  return [...html.matchAll(/<link\s+rel="stylesheet"\s+href="\/([^"]+\.css)"/g)]
    .map((m) => m[1])
    .filter((href) => href !== "chart.css" && !href.startsWith("core/"));
}

// One string, LF only: the sheets on disk are CRLF (core.autocrlf), and every caller here compares text.
export function readStyleSheets() {
  return styleSheetFiles()
    .map((name) => readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8"))
    .join("\n")
    .replace(/\r\n/g, "\n");
}
