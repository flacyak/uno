// A text guard: every file uno reads goes through a FileHandler, every place
// it browses through a Lister, and the one program it runs is a profile's
// credential_process.
//
// It reads the source under src/, matches each module's text against the
// rules below, and holds the uses to the places in ways.ts. reaches.test.ts
// is the same guard with the core running.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

import { blobFiles, openWith, readAll } from "../../src/store/index.ts";
import { diskProvider, localFiles } from "../../src/store/node.ts";
import { FIXTURE, bytes, connect } from "../engine/harness.ts";
import { MODULES, PLACES, offences as outside } from "./ways.ts";
import type { Way } from "./ways.ts";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );
}

/**
 * A pattern matching a module named as a string in any form: `from`, a bare
 * `import`, `import()` or `require()`, with the `node:` prefix optional.
 */
function named(modules: string): RegExp {
  return new RegExp(`["'](node:)?(${modules})["']`);
}

/** A pattern that finds one way out in a module's text. */
interface Rule {
  way: Way;
  pattern: RegExp;
}

/**
 * Each pattern matches the module or global that gives the way out, as a
 * whole.
 */
const RULES: readonly Rule[] = [
  ...Object.entries(MODULES).map(([way, modules]) => ({
    way: way as Way,
    pattern: named(modules.join("|")),
  })),
  { way: "fetch", pattern: /\bfetch\b/ },
  { way: "a Blob's bytes", pattern: /\.slice\([^)]*\)\.arrayBuffer\(/ },
  {
    way: "a page's own requests",
    pattern: /\b(XMLHttpRequest|WebSocket|EventSource)\b|process\.binding\b|navigator\.sendBeacon/,
  },
];

/** Every way out found outside where it is allowed, as `file: way`. */
function offences(files: ReadonlyMap<string, string>): string[] {
  const uses = [...files].flatMap(([file, text]) =>
    RULES.filter((r) => r.pattern.test(text)).map((r) => ({ file, way: r.way })),
  );
  return outside(uses);
}

/** The core's sources, by their path under src/. */
function core(): Map<string, string> {
  return new Map(
    sources(SRC).map((file) => [
      relative(SRC, file).replace(/\\/g, "/"),
      readFileSync(file, "utf8"),
    ]),
  );
}

/** The core with one line added to one file. */
function plant(file: string, line: string): Map<string, string> {
  const files = core();
  const text = files.get(file);
  if (text === undefined) throw new Error(`there is no ${file} to plant in`);
  files.set(file, `${text}\n${line}\n`);
  return files;
}

test("nothing outside a handler or a lister reads a file or a network, or runs a program", () => {
  expect(offences(core())).toEqual([]);
});

// Each way a spawn can be written.
test("a planted spawn outside store/node.ts fails it", () => {
  for (const line of [
    'import { spawn } from "node:child_process";',
    'import { spawn } from "child_process";',
    'const { spawn } = await import("node:child_process");',
    "const { fork } = require('child_process');",
  ]) {
    expect(offences(plant("engine/serve.ts", line)), line).toEqual(["engine/serve.ts: a program"]);
  }
});

// Every rule is planted outside its places and must be found there, and
// only there.
test("every rule is found where it is planted outside its places", () => {
  const plants: Array<[way: string, file: string, line: string]> = [
    ["the disk", "library/connection.ts", 'import { readFile } from "node:fs/promises";'],
    ["the disk", "engine/view.ts", 'const { open } = await import("fs/promises");'],
    ["the disk", "sheet/sheet.ts", "const { readFileSync } = require('node:fs');"],
    ["fetch", "store/list.ts", "await fetch(url);"],
    ["a program", "store/disklister.ts", 'import { execFile } from "node:child_process";'],
    ["a Blob's bytes", "engine/peek.ts", "await blob.slice(0, 64).arrayBuffer();"],
    ["a socket", "engine/peek.ts", 'import { connect } from "node:net";'],
    ["a socket", "store/s3lister.ts", 'import "node:dns";'],
    // Allowed the disk and a program, and a server is still an offence.
    ["a socket", "store/node.ts", 'const { createServer } = await import("http");'],
    ["a page's own requests", "store/s3lister.ts", "new WebSocket(url);"],
    ["a page's own requests", "engine/client.ts", "new XMLHttpRequest();"],
    ["a page's own requests", "engine/client.ts", "navigator.sendBeacon(url, body);"],
    ["a page's own requests", "engine/client.ts", 'process.binding("tcp_wrap");'],
  ];
  for (const [way, file, line] of plants) {
    expect(offences(plant(file, line)), `${line} in ${file}`).toEqual([`${file}: ${way}`]);
  }
  // Every rule and every place has a plant.
  expect(new Set(plants.map(([way]) => way))).toEqual(new Set(RULES.map((r) => r.way)));
  expect(new Set(RULES.map((r) => r.way))).toEqual(new Set(Object.keys(PLACES)));
});

// An engine built with the disk handler only refuses a Blob ref by name.
test("an engine without the blob handler refuses a Blob by name", async () => {
  const { engine, done } = connect(undefined, [diskProvider()]);
  try {
    await expect(engine.open({ name: "dropped.csv", blob: new Blob([bytes]) })).rejects.toThrow(
      "dropped.csv: nothing here opens it · this build reads local files",
    );
  } finally {
    done();
  }
});

test("a ref is opened by the first handler that claims it", async () => {
  const both = [localFiles(), blobFiles()];
  expect(await readAll(both, { name: "sales-q3.csv", path: FIXTURE })).toEqual(bytes);
  expect(await readAll(both, { name: "held.csv", blob: new Blob([bytes]) })).toEqual(bytes);
  await expect(openWith(both, { name: "x.csv", path: "s3://acme/x.csv" })).rejects.toThrow(
    "s3://acme/x.csv: nothing here opens it · this build reads local files, dropped files",
  );
});
