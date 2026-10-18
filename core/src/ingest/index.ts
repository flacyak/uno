/**
 * @fileoverview Package ingest turns bytes into rows. It is the only module
 * that knows about delimiters, encodings and header rows.
 *
 * `read` takes a whole file and returns a Sheet. `openFormat` reads a file a
 * piece at a time through a ByteSource, for the engine.
 */

import { Sheet } from '@sheet';
import { readAll } from './csv.ts';
import {
  columnNames,
  decodersFor,
  describe,
  extensionOf,
  headerOf,
} from './format.ts';
import type { Charset, HeaderMode } from './format.ts';
import { sniffDelimiter, sniffEncoding } from './sniff.ts';

export { readAll } from './csv.ts';
export {
  UnsupportedEncodingError,
  columnNames,
  decodersFor,
  delimiterName,
  encodingName,
  headerOf,
  labelOf,
  openFormat,
  peekFormat,
  pointerTo,
} from './format.ts';
export type { Format, HeaderMode, Scanner, Charset } from './format.ts';
export {
  PARQUET_MAGIC_BYTES,
  detect,
  headOf,
  kindOf,
  opensAsParquet,
  readableHead,
  refuseNotRead,
  refuseUnread,
} from './detect.ts';
export type { Detected, Layout, StoredHead } from './detect.ts';
export {
  DIALOG_EXTENSIONS,
  READ_COMPRESSIONS,
  READ_EXTENSIONS,
  nameParts,
  readable,
} from './names.ts';
export type { NameParts, StoredCompression } from './names.ts';
export { linesFormat } from './jsonl.ts';
export type { KeyedColumn } from './keys.ts';
export { delimitedRecords } from './records.ts';
export type { Column, RecordFormat } from './records.ts';
export { RecordScanner, bomLength } from './scan.ts';
export { sniffDelimiter, sniffEncoding } from './sniff.ts';
export type { Encoding } from './sniff.ts';

/**
 * read decodes the bytes, picks the delimiter from the extension or by
 * sniffing, and returns a Sheet. `header` says whether the first record names
 * the columns.
 */
export function read(
  name: string,
  bytes: Uint8Array | string,
  header: HeaderMode = 'first',
): Sheet {
  const [text, charset] =
    typeof bytes === 'string'
      ? [stripBOM(bytes), 'UTF-8' as const]
      : decoded(name, bytes);

  const ext = extensionOf(name);
  if (ext === '.json') throw new Error(`${name}: JSON is not supported yet`);
  const comma = ext === '.tsv' ? '\t' : sniffDelimiter(text);

  // Short rows are tolerated.
  const rows = readAll(text, comma);
  if (rows.length === 0) throw new Error(`${name}: file is empty`);

  const s =
    header === 'first'
      ? new Sheet(name, headerOf(rows[0]!), rows.slice(1))
      : new Sheet(name, columnNames(rows[0]!.length), rows);
  s.source = describe(comma, header, charset);
  return s;
}

/**
 * decoded decodes a file's bytes by their sniffed encoding: a UTF-8 byte
 * order mark is stripped, and UTF-16 throws.
 */
function decoded(name: string, bytes: Uint8Array): [string, Charset] {
  const decoders = decodersFor(name, sniffEncoding(bytes));
  return [decoders.head.decode(bytes), decoders.charset];
}

/** The byte order mark as a character. */
const BOM = '\uFEFF';

/** stripBOM strips a leading byte order mark from a string, as the decoder
 * does for bytes. */
function stripBOM(text: string): string {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}
