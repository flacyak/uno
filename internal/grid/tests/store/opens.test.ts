// Every file uno reads is opened through a FileHandler, every place uno
// browses is browsed through a Lister, and the one program uno runs is a
// profile's credential_process.
//
// This is the guard on that. It reads the source rather than running it,
// because the thing it protects against is a second way in -- a readFile
// somebody reached for in a hurry -- and that is a line of code, not a
// behaviour a test would ever call.
//
// A lister is allowed exactly the reads its handler is, because they reach the
// same place. The list below names modules and not interfaces, so where the two
// are one file it holds one name and where they are split -- the disk's are --
// it holds both.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

import { blobFiles, openWith, readAll } from "../../src/store/index.ts";
import { diskProvider, localFiles } from "../../src/store/node.ts";
import { FIXTURE, bytes, connect } from "../engine/harness.ts";

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
 * A module named as a string, however it is reached for: `from`, a bare
 * `import`, `import()` or `require()`, with the `node:` prefix or without.
 * Matching the import statement alone would let the lazy `await import(...)`
 * a browser-safe module reaches for through, and `child_process` without its
 * prefix is still child_process.
 */
function named(modules: string): RegExp {
  return new RegExp(`["'](node:)?(${modules})["']`);
}

/** One way out of the core, and the only modules it may be taken in. */
interface Rule {
  way: string;
  pattern: RegExp;
  where: readonly string[];
}

/**
 * Where each way of reading a file, reaching a network or running a program is
 * allowed: inside a handler, the lister beside it, or the exchange that turns
 * a sign-in into keys, and nowhere else.
 *
 * Each pattern is the way in rather than one function on the far side of it:
 * naming node:child_process is what makes a spawn possible, whichever of
 * spawn, execFile or fork is called after.
 */
const RULES: readonly Rule[] = [
  // The local handler's descriptor and the store's atomic write, and beside
  // them the disk lister's readdir and stat.
  {
    way: "the disk",
    pattern: named("fs|fs/promises"),
    where: ["store/node.ts", "store/disklister.ts"],
  },
  // The S3 handler's requests, and through them the S3 lister's
  // ListObjectsV2. Beside them, the exchanges that turn a sign-in into keys:
  // the SSO portal and STS.
  { way: "fetch", pattern: /\bfetch\b/, where: ["store/s3.ts", "store/sts.ts"] },
  // A profile's credential_process, which is the one program uno runs.
  { way: "a program", pattern: named("child_process"), where: ["store/node.ts"] },
  // The blob handler.
  { way: "a Blob's bytes", pattern: /\.slice\([^)]*\)\.arrayBuffer\(/, where: ["store/index.ts"] },
  // Every other way to a network or a process, which nothing in the core
  // takes: a socket, a server, a name lookup, a worker's own requests.
  {
    way: "a socket",
    pattern: named("net|http|https|http2|dgram|tls|dns|worker_threads|cluster"),
    where: [],
  },
  {
    way: "a page's own requests",
    pattern: /\b(XMLHttpRequest|WebSocket|EventSource)\b|process\.binding\b|navigator\.sendBeacon/,
    where: [],
  },
];

/** Every way out the guard found outside where it is allowed, as `file: way`. */
function offences(files: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const [name, text] of files) {
    for (const { way, pattern, where } of RULES) {
      if (pattern.test(text) && !where.includes(name)) found.push(`${name}: ${way}`);
    }
  }
  return found;
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

// The task's own sentence, in each way a spawn is written.
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

// The guard is only worth what it catches, so every rule is planted somewhere
// it is not allowed, in each form it could be written, and has to be found
// there and nowhere else.
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
    // Allowed the disk and a program, and still not a server.
    ["a socket", "store/node.ts", 'const { createServer } = await import("http");'],
    ["a page's own requests", "store/s3lister.ts", "new WebSocket(url);"],
    ["a page's own requests", "engine/client.ts", "new XMLHttpRequest();"],
    ["a page's own requests", "engine/client.ts", "navigator.sendBeacon(url, body);"],
    ["a page's own requests", "engine/client.ts", 'process.binding("tcp_wrap");'],
  ];
  for (const [way, file, line] of plants) {
    expect(offences(plant(file, line)), `${line} in ${file}`).toEqual([`${file}: ${way}`]);
  }
  // And each rule has a plant, so a rule added later is proved too.
  expect(new Set(plants.map(([way]) => way))).toEqual(new Set(RULES.map((r) => r.way)));
});

// Accepting dropped bytes is a platform's decision. The desktop does not list
// the blob handler, and a Blob that reaches its engine is refused by name.
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
