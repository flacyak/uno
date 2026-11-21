/**
 * @fileoverview The mono font ships inside the app: each face the app draws
 * mono text in, the font's licence beside them, and no font from anywhere
 * else.
 *
 * A machine without JetBrains Mono drew the app's mono text in whatever its
 * fontconfig chose, DejaVu Sans Mono on many Linux desktops, whose wider
 * underscore a box that ends in an ellipsis clipped.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

const DESKTOP = fileURLToPath(new URL("..", import.meta.url));
const RENDERER = join(DESKTOP, "src/renderer");
const BASE = readFileSync(join(RENDERER, "base.css"), "utf8");

/** The family --mono names first. */
const MONO = "JetBrains Mono";

/** Each @font-face rule in base.css, as its declarations. */
const FACES = [...BASE.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => body ?? "");

/** One declaration's value in a rule, or undefined. */
function declared(face: string, property: string): string | undefined {
  return new RegExp(`${property}:\\s*([^;]+);`).exec(face)?.[1]?.trim();
}

test("--mono names the bundled family first", () => {
  expect(BASE).toMatch(new RegExp(`--mono: "${MONO}",`));
});

// The faces a full smoke run draws mono text in: body cells and the sidebar
// at 400, the grid's header row at 500, an unnamed column's header and a
// bound column's fx at 500 italic, and the banner's file and the open
// workspace at 600.
test("each face the app draws mono text in is bundled, and no other", () => {
  const bundled = FACES.map((face) => {
    expect(declared(face, "font-family")).toBe(`"${MONO}"`);
    return `${declared(face, "font-weight")} ${declared(face, "font-style")}`;
  });
  expect(bundled.sort()).toEqual(["400 normal", "500 italic", "500 normal", "600 normal"]);
});

test("each face is a woff2 inside the app, read from nowhere else", () => {
  for (const face of FACES) {
    const src = declared(face, "src") ?? "";
    const url = /^url\("(\.\/fonts\/[\w-]+\.woff2)"\) format\("woff2"\)$/.exec(src)?.[1];
    expect(url, src).toBeDefined();
    expect(existsSync(join(RENDERER, url ?? "")), url).toBe(true);
  }
});

test("the font's licence ships beside it", () => {
  expect(readFileSync(join(RENDERER, "fonts/OFL.txt"), "utf8")).toMatch(/SIL OPEN FONT LICENSE/);
});

test("the page takes fonts from the app itself and from no other origin", () => {
  const html = readFileSync(join(DESKTOP, "index.html"), "utf8");
  expect(html).toMatch(/font-src 'self';/);
});
