// Every file uno reads is opened through a FileHandler, and every place uno
// browses is browsed through a Lister.
//
// This is the guard on that. It reads the source rather than running it,
// because the thing it protects against is a second way in -- a readFile
// somebody reached for in a hurry -- and that is a line of code, not a
// behaviour a test would ever call.
//
// A lister is allowed exactly the reads its handler is: they browse and open
// the same place, so they live in the same module and the list below names a
// module rather than an interface.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

import { blobFiles, openWith, readAll } from "../../src/store/index.ts";
import { localFiles } from "../../src/store/node.ts";
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
 * Where each way of reading a file or a network is allowed: inside a handler or
 * the lister beside it, and nowhere else.
 */
const ALLOWED: Array<[RegExp, string[]]> = [
  // The local handler's descriptor, the disk lister's readdir and stat, and
  // the store's atomic write.
  [/\bfrom "node:fs(\/promises)?"/, ["store/node.ts"]],
  // The S3 handler's requests, and the S3 lister's ListObjectsV2.
  [/\bfetch\b/, ["store/s3.ts"]],
  // The blob handler.
  [/\.slice\([^)]*\)\.arrayBuffer\(/, ["store/index.ts"]],
];

test("nothing outside a handler or a lister reads a file or a network", () => {
  const found: string[] = [];
  for (const file of sources(SRC)) {
    const name = relative(SRC, file).replace(/\\/g, "/");
    const text = readFileSync(file, "utf8");
    for (const [pattern, where] of ALLOWED) {
      if (pattern.test(text) && !where.includes(name)) found.push(`${name}: ${pattern}`);
    }
  }
  expect(found).toEqual([]);
});

// Accepting dropped bytes is a platform's decision. The desktop does not list
// the blob handler, and a Blob that reaches its engine is refused by name.
test("an engine without the blob handler refuses a Blob by name", async () => {
  const { engine, done } = connect(undefined, [localFiles()]);
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
