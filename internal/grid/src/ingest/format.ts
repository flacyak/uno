// Format reads a file a piece at a time: it names the columns from the head,
// finds where records start as bytes go past, and decodes a run of whole
// records into rows.
//
// CSV and TSV are the only formats today.

import { english } from "../said/index.ts";
import type { ByteSource } from "../store/index.ts";
import { readAll } from "./csv.ts";
import { RecordScanner, bomLength } from "./scan.ts";
import type { Charset, Said } from "../said/index.ts";
import { sniffDelimiter, sniffEncoding } from "./sniff.ts";
import type { Encoding } from "./sniff.ts";

/** How much of the head is read first, to sniff and to find the header. */
const PEEK = 64 << 10;

export type { Charset } from "../said/index.ts";

/** The decoders a file is read with: one for its head, one for its records. */
interface Decoders {
  /** Strips a leading byte order mark. */
  readonly head: TextDecoder;
  /** Keeps one. Records start past any byte order mark, so a U+FEFF in one
   * is data. */
  readonly data: TextDecoder;
  readonly charset: Charset;
}

const UTF8: Decoders = {
  head: new TextDecoder("utf-8"),
  data: new TextDecoder("utf-8", { ignoreBOM: true }),
  charset: "UTF-8",
};

/**
 * Bytes sniffed as "other" are read as Windows-1252, in which every byte is
 * a character, so one decoder serves both roles.
 */
const WINDOWS_1252: Decoders = (() => {
  const decoder = new TextDecoder("windows-1252");
  return { head: decoder, data: decoder, charset: "Windows-1252" };
})();

/**
 * UnsupportedEncodingError is thrown for an encoding beyond this build:
 * UTF-16 today.
 * It carries the encoding.
 */
export class UnsupportedEncodingError extends Error {
  readonly encoding: Encoding;

  constructor(name: string, encoding: Encoding) {
    super(`${name}: ${encodingName(encoding)} is not supported yet`);
    this.name = "UnsupportedEncodingError";
    this.encoding = encoding;
  }
}

/**
 * decodersFor returns the decoders for `encoding`. Throws
 * UnsupportedEncodingError for UTF-16.
 */
export function decodersFor(name: string, encoding: Encoding): Decoders {
  switch (encoding) {
    case "utf-8":
      return UTF8;
    case "other":
      return WINDOWS_1252;
    case "utf-16le":
    case "utf-16be":
      throw new UnsupportedEncodingError(name, encoding);
  }
}

export interface Scanner {
  push(chunk: Uint8Array, base: number): void;
}

/**
 * Whether a file has a header row. "first": the first record names the
 * columns. "none": every record is a row, and the columns are named by
 * `columnNames`. The default is "first".
 */
export type HeaderMode = "first" | "none";

/** The prefix of a generated column name, before its number. */
const COLUMN = "column_";

/**
 * columnNames names the columns of a file whose header mode is "none":
 * column_1,
 * column_2 and on.
 */
export function columnNames(width: number): string[] {
  return Array.from({ length: width }, (_, i) => `${COLUMN}${i + 1}`);
}

export interface Format {
  /** How the bytes were read, for the status bar to show verbatim. */
  readonly label: string;
  /** The character between fields: sniffed, or a tab for a .tsv. */
  readonly delimiter: string;
  /** The text encoding the head of the file is in, which the file is read as. */
  readonly encoding: Encoding;
  /** The name of that encoding, for the status bar. */
  readonly charset: Charset;
  /** Whether the first record was taken as the header row. */
  readonly header: HeaderMode;
  /** The header row, or `columnNames` for a file read as having none. */
  readonly columns: string[];
  /**
   * The offset of the first data record, or the file's size when there is
   * none. Under "none" that is the first record, past a byte order mark.
   */
  readonly dataStart: number;
  /** A scanner that reports the first byte of every record it is fed. */
  scanner(begin: (offset: number) => void): Scanner;
  /**
   * The records in bytes that begin at one record's first byte and end at
   * another's, or at the end of the file.
   */
  decode(bytes: Uint8Array): string[][];
}

/**
 * openFormat reads the head of a file through `src` and returns its Format:
 * same extension rules, sniffing and errors as `read`. Throws for an empty
 * file. `header` says whether the first record names the columns.
 */
export async function openFormat(
  name: string,
  src: ByteSource,
  header: HeaderMode = "first",
): Promise<Format> {
  const format = await peekFormat(name, src, header);
  if (format === undefined) throw new Error(`${name}: file is empty`);
  return format;
}

/** peekFormat is `openFormat`, returning undefined when the file holds zero
 * records. */
export async function peekFormat(
  name: string,
  src: ByteSource,
  header: HeaderMode = "first",
): Promise<Format | undefined> {
  const ext = extensionOf(name);
  if (ext === ".json") throw new Error(`${name}: JSON is not supported yet`);

  let want = Math.min(PEEK, src.size);
  let head = await src.read(0, want);
  const encoding = sniffEncoding(head);
  const decoders = decodersFor(name, encoding);
  const comma = ext === ".tsv" ? "\t" : sniffDelimiter(decoders.head.decode(head));

  // Where the second record begins, which is where the first ends.
  let second: number | undefined;
  for (;;) {
    const whole = head.length < want || want >= src.size;
    second = findDataStart(head, comma, whole);
    if (second !== undefined) break;

    // The first record runs past what was read. Read twice as much.
    want = Math.min(want * 2, src.size);
    head = await src.read(0, want);
  }
  if (second < 0) return undefined;

  const first = readAll(decoders.head.decode(head.subarray(0, second)), comma)[0]!;
  return {
    label: describe(comma, header, decoders.charset),
    delimiter: comma,
    encoding,
    charset: decoders.charset,
    header,
    columns: header === "first" ? headerOf(first) : columnNames(first.length),
    // Under "none" the first record is data, after any byte order mark.
    dataStart: header === "first" ? second : bomLength(head),
    scanner: (begin) => new RecordScanner(comma, begin),
    decode: (bytes) => readAll(decoders.data.decode(bytes), comma),
  };
}

/**
 * findDataStart returns the offset of the second record. Undefined when the
 * head ends before it can tell, and -1 when the file holds zero records.
 */
function findDataStart(head: Uint8Array, comma: string, whole: boolean): number | undefined {
  let records = 0;
  let second = -1;
  const scanner = new RecordScanner(comma, (offset) => {
    if (++records === 2) second = offset;
  });

  const bom = bomLength(head);
  scanner.push(head.subarray(bom), bom);

  if (second >= 0) return second;
  if (!whole) return undefined;
  return records === 0 ? -1 : head.length;
}

/**
 * headerOf makes every column name unique. The first keeps its name; each
 * later duplicate takes the lowest free suffix: product_cost_2, then _3.
 */
export function headerOf(record: readonly string[]): string[] {
  const taken = new Set(record);
  const seen = new Set<string>();
  return record.map((name) => {
    if (!seen.has(name)) {
      seen.add(name);
      return name;
    }
    let n = 2;
    while (taken.has(`${name}_${n}`)) n++;
    const unique = `${name}_${n}`;
    taken.add(unique);
    return unique;
  });
}

/** The extension, lower-cased, including its dot. "" when there is none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  if (dot < 0 || dot < slash) return "";
  return name.slice(dot).toLowerCase();
}

/**
 * describe is the status bar text for how a file was read. The delimiter is
 * quoted in single quotes, as Go's `%q` quotes a rune.
 */
export function describe(
  comma: string,
  header: HeaderMode = "first",
  charset: Charset = "UTF-8",
): string {
  return english(labelOf({ delimiter: comma, header, charset }));
}

/** labelOf returns how a file was read, as Said. */
export function labelOf(format: Pick<Format, "delimiter" | "header" | "charset">): Said {
  const { delimiter, header, charset } = format;
  return { t: "read", delimiter, header, charset };
}

/** What each sniffable delimiter is called. */
const DELIMITER_NAMES: ReadonlyMap<string, string> = new Map([
  [",", "comma"],
  ["\t", "tab"],
  [";", "semicolon"],
  ["|", "pipe"],
]);

/** delimiterName is a delimiter as a word, or the character in quotes. */
export function delimiterName(comma: string): string {
  return DELIMITER_NAMES.get(comma) ?? `'${comma}'`;
}

const ENCODING_NAMES: Readonly<Record<Encoding, string>> = {
  "utf-8": "UTF-8",
  "utf-16le": "UTF-16 little-endian",
  "utf-16be": "UTF-16 big-endian",
  other: "neither UTF-8 nor UTF-16",
};

/** encodingName is an encoding's display name. */
export function encodingName(encoding: Encoding): string {
  return ENCODING_NAMES[encoding];
}
