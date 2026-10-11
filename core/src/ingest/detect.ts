/**
 * @fileoverview What a file holds, told from its stored bytes before any
 * text is sniffed: Parquet, a compression or delimited text.
 *
 * The bytes decide first. Parquet starts and ends with its magic, and each
 * compression starts with its own. What this build does not read yet comes
 * back named, so it can be refused by name.
 */

import type { Compression, Unread } from '@said';

/** How many bytes Parquet's magic takes, at each end of the file. */
export const PARQUET_MAGIC_BYTES = 4;

/** How many bytes the footer's length takes, before the closing magic. */
const FOOTER_LENGTH_BYTES = 4;

/** The fewest bytes a Parquet file takes: its magics around a footer length. */
const PARQUET_MIN_BYTES = 2 * PARQUET_MAGIC_BYTES + FOOTER_LENGTH_BYTES;

/** 'PAR1', and 'PARE' for a file whose footer is encrypted. */
const PARQUET_MAGICS = [
  [0x50, 0x41, 0x52, 0x31],
  [0x50, 0x41, 0x52, 0x45],
];

/** 'BZh', then a block size digit from '1' to '9'. */
const BZIP2 = [0x42, 0x5a, 0x68];
const BZIP2_DIGITS = { at: BZIP2.length, low: 0x31, high: 0x39 };

/** What follows the digit: a first block, or the end of an empty stream. */
const BZIP2_BLOCK = [0x31, 0x41, 0x59, 0x26, 0x53, 0x59];
const BZIP2_END = [0x17, 0x72, 0x45, 0x38, 0x50, 0x90];
const BZIP2_BODY_AT = BZIP2_DIGITS.at + 1;

const GZIP = [0x1f, 0x8b, 0x08];
const ZSTD = [0x28, 0xb5, 0x2f, 0xfd];
const XZ = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];
/** The snappy framing format's stream identifier, which spells 'sNaPpY'. */
const SNAPPY = [0xff, 0x06, 0x00, 0x00, 0x73, 0x4e, 0x61, 0x50, 0x70, 0x59];
const LZ4 = [0x04, 0x22, 0x4d, 0x18];
/** 'PK' and a zip's first local file header. */
const ZIP = [0x50, 0x4b, 0x03, 0x04];

/** Each compression's stream start, in the order they are checked. */
const COMPRESSIONS: ReadonlyArray<
  readonly [Unread, (bytes: Uint8Array) => boolean]
> = [
  ['gzip', (b) => startsWith(b, GZIP)],
  ['zstd', (b) => startsWith(b, ZSTD)],
  ['bzip2', isBzip2],
  ['xz', (b) => startsWith(b, XZ)],
  ['snappy', (b) => startsWith(b, SNAPPY)],
  ['LZ4', (b) => startsWith(b, LZ4)],
  ['zip', (b) => startsWith(b, ZIP)],
];

/** StoredHead is the front of a file as stored, and a way to its end. */
export interface StoredHead {
  /** The front of the stored file: one read. */
  readonly bytes: Uint8Array;
  /** The size of the whole stored file. */
  readonly size: number;
  /** The last `length` stored bytes. Called only to confirm a Parquet head. */
  tail(length: number): Promise<Uint8Array>;
}

/** Layout is how records sit in a file's text. */
export type Layout = 'delimited' | 'lines';

/** Detected is what a file holds, or what it is that this build does not read. */
export type Detected =
  | {
      readonly t: 'records';
      readonly layout: Layout;
      readonly compression?: Compression;
    }
  | { readonly t: 'parquet' }
  | { readonly t: 'not-read'; readonly what: Unread };

/** Delimited text, which the encoding and delimiter sniffs read from here. */
const DELIMITED: Detected = { t: 'records', layout: 'delimited' };

/**
 * detect says what a file called `name` holds. Parquet comes first,
 * confirmed by the file's last bytes, then each compression, and the rest is
 * delimited text.
 */
export async function detect(
  _name: string,
  head: StoredHead,
): Promise<Detected> {
  if (await isParquet(head)) return unread('Parquet');
  const compressed = COMPRESSIONS.find(([, starts]) => starts(head.bytes));
  if (compressed !== undefined) return unread(compressed[0]);
  return DELIMITED;
}

function unread(what: Unread): Detected {
  return { t: 'not-read', what };
}

/** isParquet says whether a file starts and ends with the same Parquet magic. */
async function isParquet(head: StoredHead): Promise<boolean> {
  const magic = PARQUET_MAGICS.find((m) => startsWith(head.bytes, m));
  if (magic === undefined || head.size < PARQUET_MIN_BYTES) return false;
  return startsWith(await head.tail(PARQUET_MAGIC_BYTES), magic);
}

/** isBzip2 says whether bytes start a bzip2 stream: 'BZh', a digit, a block. */
function isBzip2(bytes: Uint8Array): boolean {
  const digit = bytes[BZIP2_DIGITS.at];
  return (
    startsWith(bytes, BZIP2) &&
    digit !== undefined &&
    digit >= BZIP2_DIGITS.low &&
    digit <= BZIP2_DIGITS.high &&
    (startsWith(bytes, BZIP2_BLOCK, BZIP2_BODY_AT) ||
      startsWith(bytes, BZIP2_END, BZIP2_BODY_AT))
  );
}

/** startsWith says whether `bytes` hold `magic` from `at` on. */
function startsWith(
  bytes: Uint8Array,
  magic: readonly number[],
  at = 0,
): boolean {
  return (
    bytes.length >= at + magic.length &&
    magic.every((b, i) => bytes[at + i] === b)
  );
}
