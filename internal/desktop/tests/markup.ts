// The page's own markup, for a test that needs the document the app ships.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Body markup, read from the real index.html and not retyped: a second copy
 * drifts from what Shell actually queries (`#app`, `#workspaces`, `#banner`,
 * `#empty`, `#content`, and the status bar's ids) without anyone noticing.
 */
export function bodyMarkup(): string {
  const html = readFileSync(join(HERE, "..", "index.html"), "utf8");
  const open = html.indexOf("<body>") + "<body>".length;
  const close = html.indexOf("</body>");
  // The module script that boots main.ts is the one piece of the body a test
  // must not run: it starts the app against a host the test did not make.
  return html.slice(open, close).replace(/<script[\s\S]*?<\/script>\s*/, "");
}
