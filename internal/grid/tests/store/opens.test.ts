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
 * Where each way of reading a file, reaching a network or running a program is
 * allowed: inside a handler, the lister beside it, or the exchange that turns
 * a sign-in into keys, and nowhere else.
 *
 * Each pattern is the way in rather than one function on the far side of it:
 * an import of node:child_process is what makes a spawn possible, whichever of
 * spawn, execFile or fork is called after.
 */
const ALLOWED: Array<[RegExp, string[]]> = [
  // The local handler's descriptor and the store's atomic write, and beside
  // them the disk lister's readdir and stat.
  [/\bfrom "node:fs(\/promises)?"/, ["store/node.ts", "store/disklister.ts"]],
  // The S3 handler's requests, and through them the S3 lister's
  // ListObjectsV2. Beside them, the exchanges that turn a sign-in into keys:
  // the SSO portal and STS.
  [/\bfetch\b/, ["store/s3.ts", "store/sts.ts"]],
  // A profile's credential_process, which is the one program uno runs.
  [/\bfrom "node:child_process"/, ["store/node.ts"]],
  // The blob handler.
  [/\.slice\([^)]*\)\.arrayBuffer\(/, ["store/index.ts"]],
  // Every other way to a network or a process, which nothing in the core
  // takes: a socket, a server, a worker's own requests, the process bindings.
  [/\bfrom "node:(net|http|https|http2|dgram|tls|worker_threads|cluster)"/, []],
  [/\b(XMLHttpRequest|WebSocket|EventSource)\b|process\.binding\b|navigator\.sendBeacon/, []],
];

/** Every way in the guard found outside where it is allowed, as `file: pattern`. */
function offences(files: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const [name, text] of files) {
    for (const [pattern, where] of ALLOWED) {
      if (pattern.test(text) && !where.includes(name)) found.push(`${name}: ${pattern}`);
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

test("nothing outside a handler or a lister reads a file or a network, or runs a program", () => {
  expect(offences(core())).toEqual([]);
});

// The guard is only worth what it catches, so each allowance is planted
// somewhere it is not allowed and has to be found there.
test("a planted spawn outside store/node.ts fails it", () => {
  const planted = new Map(core());
  planted.set(
    "engine/serve.ts",
    `${planted.get("engine/serve.ts")}\nimport { spawn } from "node:child_process";\n`,
  );
  expect(offences(planted)).toEqual(['engine/serve.ts: /\\bfrom "node:child_process"/']);
});

test("a planted fetch, readFile or socket outside the allowed places fails it", () => {
  const plants: Array<[string, string]> = [
    ["store/list.ts", "await fetch(url);"],
    ["library/connection.ts", 'import { readFile } from "node:fs/promises";'],
    ["engine/peek.ts", 'import { connect } from "node:net";'],
    ["store/s3lister.ts", "new WebSocket(url);"],
  ];
  for (const [file, line] of plants) {
    const planted = new Map(core());
    planted.set(file, `${planted.get(file)}\n${line}\n`);
    expect(offences(planted), `${line} in ${file}`).toHaveLength(1);
  }
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
