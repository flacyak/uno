// Format is how a file is read when it is never held whole.
//
// `read` takes every byte and returns a sheet, which suits a file that fits in
// memory and nothing else. A Format splits that into what an engine can do a
// piece at a time: name the columns from the head of the file, find where
// records start as the bytes go past, and turn a run of whole records back into
// rows.
//
// CSV and TSV are the only format today. JSON Lines and Parquet come next, and a
// format converter writes through the same seam from the other side.

import type { ByteSource } from "../store/index.ts";
import { readAll } from "./csv.ts";
import { RecordScanner, bomLength } from "./scan.ts";
import { sniffDelimiter, sniffEncoding } from "./sniff.ts";
import type { Encoding } from "./sniff.ts";

/** How much of the head is read first, to sniff and to find the header. */
const PEEK = 64 << 10;

/** Strips a leading byte order mark, the way `read` does for a whole file. */
const headDecoder = new TextDecoder("utf-8");

/**
 * Keeps one. Data never starts at byte 0, so a U+FEFF at the start of a run of
 * records is a character in a field and not a mark to strip.
 */
const dataDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

export interface Scanner {
  push(chunk: Uint8Array, base: number): void;
}

/**
 * Whether a file has a header row.
 *
 * With "first", its first record names the columns and the rows start at the
 * second. With "none" every record is a row, the first included, and the
 * columns are named by `columnNames`. A file cannot say which it is, so the
 * person who adds it does, and a reader told nothing takes "first".
 */
export type HeaderMode = "first" | "none";

/** What a column nobody named is called, before its number. */
const COLUMN = "column_";

/**
 * columnNames is what the columns of a file with no header row are called:
 * column_1, column_2 and on, counted from one as a person counts columns.
 *
 * Each is an identifier, so a formula can use one, and each is a function of
 * the column's place alone, so the same file reads the same names on every
 * open.
 */
export function columnNames(width: number): string[] {
  return Array.from({ length: width }, (_, i) => `${COLUMN}${i + 1}`);
}

export interface Format {
  /** How the bytes were read, for the status bar to show verbatim. */
  readonly label: string;
  /** The character between fields: sniffed, or a tab for a .tsv. */
  readonly delimiter: string;
  /**
   * The text encoding the head of the file is in. Every file is decoded as
   * UTF-8 whatever this says, so it is here for a caller to refuse on.
   */
  readonly encoding: Encoding;
  /** Whether the first record was taken as the header row. */
  readonly header: HeaderMode;
  /** The header row, or `columnNames` for a file read as having none. */
  readonly columns: string[];
  /**
   * The offset of the first data record, or the file's size when there is
   * none. With no header row that is the first record, past a byte order mark.
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
 * openFormat picks a reader from the extension, then from the bytes, and reads
 * the header. It is `read` for a file that is never loaded: same extension
 * rules, same sniff, same errors.
 *
 * `header` says whether the first record names the columns. It does unless
 * the caller says there is no header row.
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

/**
 * peekFormat is `openFormat` for a caller that has a use for a file with no
 * record in it: it answers undefined for one, where `openFormat` refuses it.
 */
export async function peekFormat(
  name: string,
  src: ByteSource,
  header: HeaderMode = "first",
): Promise<Format | undefined> {
  const ext = extensionOf(name);
  if (ext === ".json") throw new Error(`${name}: JSON is not supported yet`);

  let want = Math.min(PEEK, src.size);
  let head = await src.read(0, want);
  const comma = ext === ".tsv" ? "\t" : sniffDelimiter(headDecoder.decode(head));

  // Where the second record begins, which is where the first ends. The first
  // is read whole either way: it is the names, or it is how wide the rows are.
  let second: number | undefined;
  for (;;) {
    const whole = head.length < want || want >= src.size;
    second = findDataStart(head, comma, whole);
    if (second !== undefined) break;

    // The first record runs past what was read: names with newlines in them,
    // or a few thousand columns. Rare enough that doubling is plenty.
    want = Math.min(want * 2, src.size);
    head = await src.read(0, want);
  }
  if (second < 0) return undefined;

  const first = readAll(headDecoder.decode(head.subarray(0, second)), comma)[0]!;
  return {
    label: describe(comma, header),
    delimiter: comma,
    encoding: sniffEncoding(head),
    header,
    columns: header === "first" ? headerOf(first) : columnNames(first.length),
    // With no header row the first record is a row, and only a byte order
    // mark comes before it.
    dataStart: header === "first" ? second : bomLength(head),
    scanner: (begin) => new RecordScanner(comma, begin),
    decode: (bytes) => readAll(dataDecoder.decode(bytes), comma),
  };
}

/**
 * findDataStart is where the second record begins. Undefined when the head
 * ends before it can tell, and -1 for a file with no records at all.
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
 * headerOf names every column once. A file can say product_cost twice, and a
 * name two columns share is one no formula can use: the first keeps it and each
 * later one takes the lowest free suffix, product_cost_2, then _3. The suffix
 * keeps the name an identifier, and the renamed header is on screen, so a
 * person sees both columns rather than a name that quietly means one of them.
 *
 * It is a function of the header alone, so a .uno that carries its source
 * reads the same names on every open.
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
 * describe is how the status bar says what was guessed, so a wrong guess is
 * visible rather than silent.
 *
 * The quoting is Go's `%q` on a rune, which is a single-quoted character
 * literal rather than a double-quoted string.
 *
 * A file read as having no header row says so here too: the names on screen
 * are uno's, and a first line that was a header after all is sitting in the
 * first row, where somebody should be told to look.
 */
export function describe(comma: string, header: HeaderMode = "first"): string {
  const read = comma === "\t" ? "UTF-8 · tab-separated" : `UTF-8 · delimiter '${comma}'`;
  return header === "first" ? read : `${read}${NO_HEADER}`;
}

/** What is added to how a file was read when it was read as having no header row. */
const NO_HEADER = " · no header row";

/** What each delimiter worth guessing is called. */
const DELIMITER_NAMES: ReadonlyMap<string, string> = new Map([
  [",", "comma"],
  ["\t", "tab"],
  [";", "semicolon"],
  ["|", "pipe"],
]);

/** delimiterName is a delimiter in a word, for a sentence about it. */
export function delimiterName(comma: string): string {
  return DELIMITER_NAMES.get(comma) ?? `'${comma}'`;
}

const ENCODING_NAMES: Readonly<Record<Encoding, string>> = {
  "utf-8": "UTF-8",
  "utf-16le": "UTF-16 little-endian",
  "utf-16be": "UTF-16 big-endian",
  other: "neither UTF-8 nor UTF-16",
};

/** encodingName is an encoding as a sentence about it says it. */
export function encodingName(encoding: Encoding): string {
  return ENCODING_NAMES[encoding];
}
