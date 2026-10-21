/**
 * @fileoverview What a file holds, told from its stored bytes and its name
 * before any text is sniffed: Parquet, a compression, JSON Lines or delimited
 * text.
 *
 * The bytes decide first. Parquet starts and ends with its magic, and each
 * compression starts with its own. Only then does the name decide between
 * JSON Lines and delimited text. What this build does not read yet comes back
 * named, and an open refuses it by name: through openReading for one file,
 * and through `readableHead` for each part of several.
 */

import { unreachable } from '@never';
import { Refusal } from '@said';
import type { Compression, ReadKind, Unread } from '@said';
import type { ByteSource } from '@store';
import { HEAD_BYTES } from './format.ts';
import { nameParts } from './names.ts';
import { bomLength } from './scan.ts';

/** How many bytes Parquet's magic takes, at each end of the file. */
export const PARQUET_MAGIC_BYTES = 4;

/** How many bytes a Parquet footer's length takes, before the closing magic. */
export const PARQUET_FOOTER_LENGTH_BYTES = 4;

/** The fewest bytes a Parquet file takes: its magics around a footer length. */
export const PARQUET_MIN_BYTES =
  2 * PARQUET_MAGIC_BYTES + PARQUET_FOOTER_LENGTH_BYTES;

/**
 * ParquetMagic is the magic at each end of a Parquet file: PAR1, or PARE
 * where its footer is encrypted.
 */
export type ParquetMagic = 'PAR1' | 'PARE';

/** Each Parquet magic's bytes. */
const PARQUET_MAGICS: ReadonlyArray<readonly [ParquetMagic, number[]]> = [
  ['PAR1', [0x50, 0x41, 0x52, 0x31]],
  ['PARE', [0x50, 0x41, 0x52, 0x45]],
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

/** The extensions that name delimited text, whatever the first line holds. */
const DELIMITED_EXTENSIONS = ['.csv', '.tsv'];

/** The extensions that name JSON Lines. */
const LINES_EXTENSIONS = ['.jsonl', '.ndjson'];

/** A JSON document's extension. It is JSON Lines when its first line is an object. */
const JSON_EXTENSION = '.json';

const LF = 0x0a;

/** The bytes a line can hold and still be blank: space, tab and CR. */
const BLANK = [0x20, 0x09, 0x0d];

const UTF8 = new TextDecoder('utf-8');

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

/** The kind of rows each layout of records is. */
const LAYOUT_KINDS: Record<Layout, ReadKind> = {
  delimited: 'delimited',
  lines: 'jsonl',
};

/**
 * The kind of rows each format this build names and does not read yet
 * holds. A compression hides its kind, and a JSON document has none.
 */
const UNREAD_KINDS: Partial<Record<Unread, ReadKind>> = {
  'JSON Lines': 'jsonl',
  Parquet: 'parquet',
};

/**
 * detect says what a file holds. Parquet comes first, confirmed by the
 * file's last bytes, then each compression. Then the name decides: .jsonl
 * and .ndjson are JSON Lines, and so is a .json or a name with no layout
 * extension whose first non-blank line is one complete JSON object. Any
 * other .json is JSON, and the rest is delimited text.
 */
export async function detect(
  name: string,
  head: StoredHead,
): Promise<Detected> {
  if (await isParquet(head)) return unread('Parquet');
  const compressed = COMPRESSIONS.find(([, starts]) => starts(head.bytes));
  if (compressed !== undefined) return unread(compressed[0]);

  const { extension } = nameParts(name);
  if (DELIMITED_EXTENSIONS.includes(extension)) return DELIMITED;
  if (LINES_EXTENSIONS.includes(extension) || opensWithObject(head))
    return unread('JSON Lines');
  return extension === JSON_EXTENSION ? unread('JSON') : DELIMITED;
}

/**
 * kindOf returns the kind of rows a detected file holds, whether this build
 * reads it yet or not. Undefined for a compression, whose bytes hide what it
 * holds until they are read, and for a JSON document.
 */
export function kindOf(found: Detected): ReadKind | undefined {
  switch (found.t) {
    case 'records':
      return LAYOUT_KINDS[found.layout];
    case 'parquet':
      return 'parquet';
    case 'not-read':
      return UNREAD_KINDS[found.what];
    default:
      return unreachable(found);
  }
}

/**
 * opensAsParquet says whether bytes start with a Parquet magic, which only
 * the file's last bytes confirm. Only such a head needs its tail read.
 */
export function opensAsParquet(bytes: Uint8Array): boolean {
  return parquetMagicAt(bytes, 0) !== undefined;
}

/** parquetMagicAt returns the Parquet magic `bytes` hold from `at`, if any. */
export function parquetMagicAt(
  bytes: Uint8Array,
  at: number,
): ParquetMagic | undefined {
  return PARQUET_MAGICS.find(([, magic]) => startsWith(bytes, magic, at))?.[0];
}

/**
 * refuseUnread detects what a file holds, and refuses it by name where this
 * build does not read it yet.
 */
export async function refuseUnread(
  name: string,
  head: StoredHead,
): Promise<void> {
  refuseNotRead(name, await detect(name, head));
}

/**
 * refuseNotRead refuses a file by name where this build does not read what
 * it holds.
 */
export function refuseNotRead(name: string, found: Detected): void {
  if (found.t === 'not-read')
    throw new Refusal({ t: 'not-read', name, what: found.what });
}

/**
 * headOf reads the front of a stored file as detection reads it: its first
 * HEAD_BYTES in one read, and its last bytes only when detection asks.
 */
export async function headOf(source: ByteSource): Promise<StoredHead> {
  const bytes = await source.read(0, Math.min(HEAD_BYTES, source.size));
  return {
    bytes,
    size: source.size,
    tail: (length) => source.read(source.size - length, length),
  };
}

/**
 * readableHead reads the first HEAD_BYTES of `source` and returns them,
 * once what the file holds is something this build reads. Otherwise it
 * refuses the file by name. A Parquet head is confirmed by a read of the
 * source's tail.
 */
export async function readableHead(
  name: string,
  source: ByteSource,
): Promise<Uint8Array> {
  const head = await headOf(source);
  await refuseUnread(name, head);
  return head.bytes;
}

function unread(what: Unread): Detected {
  return { t: 'not-read', what };
}

/** isParquet says whether a file starts and ends with the same Parquet magic. */
async function isParquet(head: StoredHead): Promise<boolean> {
  const magic = parquetMagicAt(head.bytes, 0);
  if (magic === undefined || head.size < PARQUET_MIN_BYTES) return false;
  return parquetMagicAt(await head.tail(PARQUET_MAGIC_BYTES), 0) === magic;
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

/**
 * opensWithObject says whether the first line of a head that holds a
 * non-blank byte is one complete JSON object. A line the head cuts off is not
 * complete.
 */
function opensWithObject(head: StoredHead): boolean {
  const { bytes } = head;
  const whole = bytes.length >= head.size;
  for (let start = bomLength(bytes); start < bytes.length;) {
    let end = bytes.indexOf(LF, start);
    if (end < 0) {
      if (!whole) return false;
      end = bytes.length;
    }
    const line = bytes.subarray(start, end);
    if (!line.every((b) => BLANK.includes(b))) return isObject(line);
    start = end + 1;
  }
  return false;
}

/** isObject says whether a line is one JSON object and nothing else. */
function isObject(line: Uint8Array): boolean {
  try {
    const value: unknown = JSON.parse(UTF8.decode(line));
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
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
