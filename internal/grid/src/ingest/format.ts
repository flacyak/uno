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
import { sniffDelimiter } from "./sniff.ts";

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

export interface Format {
  /** How the bytes were read, for the status bar to show verbatim. */
  readonly label: string;
  /** The header row. */
  readonly columns: string[];
  /** The offset of the first data record, or the file's size when there is none. */
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
 */
export async function openFormat(name: string, src: ByteSource): Promise<Format> {
  const ext = extensionOf(name);
  if (ext === ".json") throw new Error(`${name}: JSON is not supported yet`);

  let want = Math.min(PEEK, src.size);
  let head = await src.read(0, want);
  const comma = ext === ".tsv" ? "\t" : sniffDelimiter(headDecoder.decode(head));

  let dataStart: number | undefined;
  for (;;) {
    const whole = head.length < want || want >= src.size;
    dataStart = findDataStart(head, comma, whole);
    if (dataStart !== undefined) break;

    // The header runs past what was read: names with newlines in them, or a
    // few thousand columns. Rare enough that doubling is plenty.
    want = Math.min(want * 2, src.size);
    head = await src.read(0, want);
  }
  if (dataStart < 0) throw new Error(`${name}: file is empty`);

  const columns = headerOf(readAll(headDecoder.decode(head.subarray(0, dataStart)), comma)[0]!);
  return {
    label: describe(comma),
    columns,
    dataStart,
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
 */
export function describe(comma: string): string {
  if (comma === "\t") return "UTF-8 · tab-separated";
  return `UTF-8 · delimiter '${comma}'`;
}
