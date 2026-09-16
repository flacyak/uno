// The desktop leaves every file read to the engine.
//
// Main writes saves and screenshots, and asks dialogs for paths. Every read
// happens in the engine, through the providers src/engine/index.ts lists.

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

// The providers the engine reads through are listed in src/engine/index.ts.
test("the engine lists the providers it reaches through", () => {
  const entry = readFileSync(join(SRC, "engine/index.ts"), "utf8");
  expect(entry).toMatch(/sources\(\[/);
  expect(entry).toMatch(/diskProvider\(\)/);
  expect(entry).toMatch(/s3Provider\(/);
  // multiProvider reads several files as one.
  expect(entry).toMatch(/multiProvider\(single\)/);
});

/**
 * child_process as a string, from `from`, `import()` or `require()`, the
 * `node:` prefix optional.
 */
const RUNS = /["'](node:)?child_process["']/;

// The only program uno runs is a profile's credential_process, inside
// @uno/grid/store/node in the engine. The desktop starts engines through
// Electron's utilityProcess alone.
test("nothing in the desktop runs a program of its own", () => {
  const found = sources(SRC)
    .filter((file) => RUNS.test(readFileSync(file, "utf8")))
    .map((file) => relative(SRC, file));
  expect(found).toEqual([]);
});

test("child_process is found however it is written", () => {
  for (const line of [
    'import { spawn } from "node:child_process";',
    'import { spawn } from "child_process";',
    'const { fork } = await import("node:child_process");',
    "const cp = require('child_process');",
  ]) {
    expect(RUNS.test(line), line).toBe(true);
  }
});
