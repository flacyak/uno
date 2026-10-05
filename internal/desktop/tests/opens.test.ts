// The desktop reads no file itself.
//
// Main writes saves and screenshots, and asks dialogs for paths. Every read --
// a source, a .uno, an object in S3 -- happens in the engine, through the
// providers that src/engine/index.ts lists. This fails the day something here
// reaches for a file on its own.

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

// What the desktop can reach is a list written here and nowhere else. It is
// providers now rather than handlers, so browsing arrives with the same list
// rather than a second one somebody has to remember to keep in step.
test("the engine lists the providers it reaches through", () => {
  const entry = readFileSync(join(SRC, "engine/index.ts"), "utf8");
  expect(entry).toMatch(/sources\(\[/);
  expect(entry).toMatch(/diskProvider\(\)/);
  expect(entry).toMatch(/s3Provider\(/);
  // Several files read as one, over the places one file can be.
  expect(entry).toMatch(/multiProvider\(single\)/);
});

/**
 * child_process named as a string, however it is reached for: `from`,
 * `import()` or `require()`, with the `node:` prefix or without.
 */
const RUNS = /["'](node:)?child_process["']/;

// The one program uno runs is a profile's credential_process, and it runs in
// the engine, inside @uno/grid/store/node, where grid's guard holds it. The
// desktop starts engines through Electron's utilityProcess and runs nothing
// else, so child_process here is a second way to run one.
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
