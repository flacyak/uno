/**
 * @fileoverview What a file holds, told from its stored bytes before any
 * text is sniffed: Parquet or delimited text.
 *
 * The bytes decide first. Parquet starts and ends with its magic. What this
 * build does not read yet comes back named, so it can be refused by name.
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
 * confirmed by the file's last bytes, and the rest is delimited text.
 */
export async function detect(
  _name: string,
  head: StoredHead,
): Promise<Detected> {
  if (await isParquet(head)) return unread('Parquet');
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
