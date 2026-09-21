// The desktop reads no file itself.
//
// Main writes saves and screenshots, and asks dialogs for paths. Every read --
// a source, a .uno, an object in S3 -- happens in the engine, through the
// FileHandlers that src/engine/index.ts lists. This fails the day something
// here reaches for a file on its own.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );
}

const READS = /\breadFile(Sync)?\b|\bcreateReadStream\b|\bfetch\(|\bnodeSource\b|\bblobSource\b/;

test("nothing in the desktop reads a file except through the engine's handlers", () => {
  const found = sources(SRC)
    .filter((file) => READS.test(readFileSync(file, "utf8")))
    .map((file) => relative(SRC, file));
  expect(found).toEqual([]);
});

test("the engine lists the handlers it opens with", () => {
  const entry = readFileSync(join(SRC, "engine/index.ts"), "utf8");
  expect(entry).toMatch(/localFiles\(\)/);
  expect(entry).toMatch(/s3Files\(/);
});
