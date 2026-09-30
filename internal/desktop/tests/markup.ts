// The body markup of the app's index.html, for tests that need the real
// document.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The body markup, read from the real index.html so it matches what Shell
 * queries (`#app`, `#workspaces`, `#banner`, `#empty`, `#content`, and the
 * status bar's ids).
 */
export function bodyMarkup(): string {
  const html = readFileSync(join(HERE, "..", "index.html"), "utf8");
  const open = html.indexOf("<body>") + "<body>".length;
  const close = html.indexOf("</body>");
  // The module script that boots main.ts is stripped, so a test boots only
  // what it needs.
  return html.slice(open, close).replace(/<script[\s\S]*?<\/script>\s*/, "");
}
