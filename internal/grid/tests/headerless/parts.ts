// Fixtures and helpers for the headerless tests: the three parts of
// sales-q3.csv with the header line removed from each.

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

/** The headerless parts concatenated: every data row of sales-q3.csv. */
export const allRows = ((): Uint8Array => {
  const out = new Uint8Array(rowsOnly.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of rowsOnly) {
    out.set(part, at);
    at += part.length;
  }
  return out;
})();

/** File name of each headerless part, in order. */
export const NAMES: readonly string[] = Array.from(
  { length: PARTS },
  (_, i) => `sales-q3-rows-${i + 1}.csv`,
);

/** The generated column names for a headerless file with COLS columns. */
export const COLUMNS = columnNames(COLS);

/** Source name for the parts opened as one. */
export const SOURCE = "sales-q3-rows";

/** Writes `files` into a new temp dir and returns the dir and each path. */
export async function onDisk(
  files: readonly Uint8Array[] = rowsOnly,
): Promise<{ dir: string; paths: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "uno-headerless-"));
  const paths = NAMES.slice(0, files.length).map((name) => join(dir, name));
  await Promise.all(paths.map((path, i) => writeFile(path, files[i]!)));
  return { dir, paths };
}

/** A SourceRef for the files at `paths` as one source. Header mode defaults to "none". */
export function asOne(paths: readonly string[], header: HeaderMode = "none"): SourceRef {
  return {
    name: SOURCE,
    parts: paths.map((path, i) => ({ ref: { name: NAMES[i]!, path } })),
    header,
  };
}

/** Disk, blob and multi-file providers. */
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
