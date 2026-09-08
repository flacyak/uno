// Package ingest turns bytes into rows. It is the only module that knows a file
// had a delimiter, an encoding or a header row, so adding a format later never
// reaches the grid.
//
// There are two ways in. `read` takes a whole file and returns a Sheet, for a
// file that fits in memory. `openFormat` reads a file a piece at a time through
// a ByteSource, for the engine, which never holds one.

import { Sheet } from "../sheet/index.ts";
import { readAll } from "./csv.ts";
import { describe, extensionOf, headerOf } from "./format.ts";
import { sniffDelimiter } from "./sniff.ts";

export { readAll } from "./csv.ts";
export { headerOf, openFormat } from "./format.ts";
export type { Format, Scanner } from "./format.ts";
export { RecordScanner } from "./scan.ts";
export { sniffDelimiter } from "./sniff.ts";

/**
 * read picks a decoder from the extension, then from the bytes.
 *
 * It takes the bytes rather than a path: a .uno carries its source embedded,
 * and the web build has no filesystem to read one from.
 */
export function read(name: string, bytes: Uint8Array | string): Sheet {
  const text = typeof bytes === "string" ? bytes : new TextDecoder("utf-8").decode(bytes);

  switch (extensionOf(name)) {
    case ".json":
      throw new Error(`${name}: JSON is not supported yet`);
    case ".tsv":
      return readSeparated(name, text, "\t");
    default:
      return readSeparated(name, text, sniffDelimiter(text));
  }
}

function readSeparated(name: string, text: string, comma: string): Sheet {
  // Ragged rows are the norm in real exports, so short rows are tolerated
  // rather than made a reason to reject the file.
  const rows = readAll(text, comma);
  if (rows.length === 0) throw new Error(`${name}: file is empty`);

  const s = new Sheet(name, headerOf(rows[0]!), rows.slice(1));
  s.source = describe(comma);
  return s;
}
