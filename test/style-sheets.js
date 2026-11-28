// THE SHEETS THAT REPLACED THE ONE PANEL SHEET, read the way the page loads them.
//
// A test that pins a rule by reading the panel's stylesheet has to read EVERY sheet, in the order public/index.html
// links them: the cascade position a rule holds is half of what these tests assert, and a rule that moved to an
// earlier sheet is a different rule to the browser. chart.css and the shared core/ card sheets were already separate
// files before the split and are not part of this concatenation.
//
// The parse itself lives in tools/style-sheets.mjs, so the tests and every tool read the page ONE way. This module
// keeps the tests' own subset filter and the two names the test files already import.
import { styleSheetFiles as linkedSheets, readStyleSheets as readLinked } from "../tools/style-sheets.mjs";

const CUT_SHEETS = (names) => names.filter((href) => href !== "chart.css" && !href.startsWith("core/"));

export function styleSheetFiles() {
  return CUT_SHEETS(linkedSheets());
}

// One string, LF only: the sheets on disk are CRLF (core.autocrlf), and every caller here compares text.
export function readStyleSheets() {
  return readLinked({ files: styleSheetFiles() });
}
