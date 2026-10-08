// Package ingest turns bytes into rows. It is the only module that knows a file
// had a delimiter, an encoding or a header row, so adding a format later never
// reaches the grid.
//
// There are two ways in. `read` takes a whole file and returns a Sheet, for a
// file that fits in memory. `openFormat` reads a file a piece at a time through
// a ByteSource, for the engine, which never holds one.

import { Sheet } from "../sheet/index.ts";
import { readAll } from "./csv.ts";
import { columnNames, decodersFor, describe, extensionOf, headerOf } from "./format.ts";
import type { Charset, HeaderMode } from "./format.ts";
import { sniffDelimiter, sniffEncoding } from "./sniff.ts";

export { readAll } from "./csv.ts";
export {
  UnsupportedEncodingError,
  columnNames,
  decodersFor,
  delimiterName,
  encodingName,
  headerOf,
  openFormat,
  peekFormat,
} from "./format.ts";
export type { Format, HeaderMode, Scanner, Charset } from "./format.ts";
export { RecordScanner, bomLength } from "./scan.ts";
export { sniffDelimiter, sniffEncoding } from "./sniff.ts";
export type { Encoding } from "./sniff.ts";

/**
 * read picks a decoder from the extension, then from the bytes.
 *
 * It takes the bytes rather than a path: a .uno carries its source embedded,
 * and the web build has no filesystem to read one from.
 *
 * `header` says whether the first record names the columns, as it does for
 * `openFormat`.
 */
export function read(
  name: string,
  bytes: Uint8Array | string,
  header: HeaderMode = "first",
): Sheet {
  const [text, charset] =
    typeof bytes === "string" ? [stripBOM(bytes), "UTF-8" as const] : decoded(name, bytes);

  switch (extensionOf(name)) {
    case ".json":
      throw new Error(`${name}: JSON is not supported yet`);
    case ".tsv":
      return readSeparated(name, text, "\t", header, charset);
    default:
      return readSeparated(name, text, sniffDelimiter(text), header, charset);
  }
}

/**
 * decoded reads a file's bytes as the encoding they are in, the way
 * `openFormat` reads a file's head: a UTF-8 mark goes, Windows-1252 is read
 * as itself, and UTF-16 is refused by name.
 */
function decoded(name: string, bytes: Uint8Array): [string, Charset] {
  const decoders = decodersFor(name, sniffEncoding(bytes));
  return [decoders.head.decode(bytes), decoders.charset];
}

/** The byte order mark as a character, which the decoder strips from bytes. */
const BOM = "\uFEFF";

/** stripBOM does for a string what the decoder does for bytes, so both ways in
 * read the same header. */
function stripBOM(text: string): string {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

function readSeparated(
  name: string,
  text: string,
  comma: string,
  header: HeaderMode,
  charset: Charset,
): Sheet {
  // Ragged rows are the norm in real exports, so short rows are tolerated
  // rather than made a reason to reject the file.
  const rows = readAll(text, comma);
  if (rows.length === 0) throw new Error(`${name}: file is empty`);

  const s =
    header === "first"
      ? new Sheet(name, headerOf(rows[0]!), rows.slice(1))
      : new Sheet(name, columnNames(rows[0]!.length), rows);
  s.source = describe(comma, header, charset);
  return s;
}
