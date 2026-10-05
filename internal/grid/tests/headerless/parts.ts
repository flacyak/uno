// Files with no header row, for the tests of reading them.
//
// They are the three parts of sales-q3.csv with the header taken off each, so
// every line of every one is a row, and together they hold exactly the rows
// the whole file has under its header. What a headerless read shows can then
// be held to what the ordinary read of the whole file shows, cell for cell.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SourceRef } from "../../src/engine/index.ts";
import { columnNames } from "../../src/ingest/index.ts";
import type { HeaderMode } from "../../src/ingest/index.ts";
import type { Provider } from "../../src/plugin/index.ts";
import { blobProvider, multiProvider } from "../../src/store/index.ts";
import { diskProvider } from "../../src/store/node.ts";
import { COLS } from "../testdata/sales-q3.ts";
import { PARTS, partBytes } from "../testdata/sales-q3-parts.ts";

const LF = 0x0a;

/** A UTF-8 byte order mark. */
export const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

/** Each part with its header line taken off, in order. */
export const rowsOnly: readonly Uint8Array[] = partBytes.map((bytes) =>
  bytes.subarray(bytes.indexOf(LF) + 1),
);

/** The parts end to end: every row of sales-q3.csv and no header. */
export const allRows = ((): Uint8Array => {
  const out = new Uint8Array(rowsOnly.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of rowsOnly) {
    out.set(part, at);
    at += part.length;
  }
  return out;
})();

/** What each headerless part is called, in order. */
export const NAMES: readonly string[] = Array.from(
  { length: PARTS },
  (_, i) => `sales-q3-rows-${i + 1}.csv`,
);

/** What the columns of a file that names none are called. */
export const COLUMNS = columnNames(COLS);

/** What the parts are called as one source. */
export const SOURCE = "sales-q3-rows";

/** onDisk writes `files` into a folder of their own and says where each is. */
export async function onDisk(
  files: readonly Uint8Array[] = rowsOnly,
): Promise<{ dir: string; paths: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "uno-headerless-"));
  const paths = NAMES.slice(0, files.length).map((name) => join(dir, name));
  await Promise.all(paths.map((path, i) => writeFile(path, files[i]!)));
  return { dir, paths };
}

/** The files at `paths` as one source. With no header row unless said. */
export function asOne(paths: readonly string[], header: HeaderMode = "none"): SourceRef {
  return {
    name: SOURCE,
    parts: paths.map((path, i) => ({ ref: { name: NAMES[i]!, path } })),
    header,
  };
}

/** What an engine on a machine with a disk reads through, several files as one included. */
export function providers(): Provider[] {
  const single = [diskProvider(), blobProvider()];
  return [...single, multiProvider(single)];
}

/** `bytes` with a byte order mark in front. */
export function marked(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(BOM.length + bytes.length);
  out.set(BOM);
  out.set(bytes, BOM.length);
  return out;
}
