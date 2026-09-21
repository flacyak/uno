/**
 * @fileoverview The row shapes the cache lab measures, and how to make files
 * of them.
 *
 * - sales: sales-q3.csv's rows repeated, about 50 bytes and 6 columns a row.
 *   This is the shape of the 2.5 GB fixture.
 * - synthetic: the efficiency suite's generator (tests/efficiency/index.test.ts),
 *   with quoted commas, quoted newlines, CRLF rows and multi-byte characters.
 *   It is copied here because a test file cannot be imported without running it.
 * - wide: each sales-q3 row written WIDE_COPIES times side by side, about 400
 *   bytes and 48 columns a row, so a band of rows is 8 times the bytes.
 */

import { closeSync, existsSync, openSync, statSync, writeSync } from 'node:fs';

import type { ByteSource } from '@store';
import { bytes as salesBytes } from '@core-tests/testdata/sales-q3';

export type ShapeName = 'sales' | 'synthetic' | 'wide';

export const SHAPES: readonly ShapeName[] = ['sales', 'synthetic', 'wide'];

/** How many copies of a sales-q3 row make one wide row. */
export const WIDE_COPIES = 8;

const LF = 0x0a;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The sales-q3 header line, newline included, and the rows after it. */
function salesParts(): { header: Uint8Array; body: Uint8Array } {
  const end = salesBytes.indexOf(LF) + 1;
  return {
    header: salesBytes.subarray(0, end),
    body: salesBytes.subarray(end),
  };
}

/** The lines of some text, without their terminators, blank lines dropped. */
function linesOf(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line !== '');
}

/**
 * wideParts returns the wide header and rows. Column names get a `_n` suffix
 * per copy, so they stay unique.
 */
function wideParts(): { header: Uint8Array; body: Uint8Array } {
  const { header, body } = salesParts();
  const names = decoder.decode(header).trim().split(',');
  const copies = Array.from({ length: WIDE_COPIES }, (_, i) => i + 1);
  const wideHeader = copies
    .flatMap((n) => names.map((name) => `${name}_${n}`))
    .join(',');
  // sales-q3 has no quoted newlines, so a line is a record.
  const rows = linesOf(decoder.decode(body)).map((line) =>
    copies.map(() => line).join(','),
  );
  return {
    header: encoder.encode(`${wideHeader}\n`),
    body: encoder.encode(`${rows.join('\n')}\n`),
  };
}

// --- The synthetic shape, as tests/efficiency/index.test.ts writes it. ---

const SYNTHETIC_HEADER = 'id,customer,note,amount,city\n';
/** One in this many rows has a newline inside a quoted field. */
const NEWLINE_EVERY = 7;
/** One in this many rows ends in CRLF. */
const CRLF_EVERY = 5;
/** One in this many rows has a multi-byte character. */
const WIDE_EVERY = 3;
const CUSTOMERS = [
  '"Okafor, Ada"',
  'Lindqvist',
  '"Diaz ""Pepe"" Ruiz"',
  'Nakamura',
];
const CITIES = ['Lagos', 'Malmö', 'São Paulo', '東京', 'Lyon'];
/** The amount column cycles through this many whole values. */
const AMOUNT_RANGE = 100000;
/** The step the amount column advances by per row. */
const AMOUNT_STEP = 37;
/** The amount's cents cycle through this many values. */
const CENTS = 100;
/** Synthetic rows encoded per piece. */
const SYNTHETIC_BATCH = 4096;

/** The efficiency suite's i-th row, terminator included. */
function syntheticRow(i: number): string {
  const customer = CUSTOMERS[i % CUSTOMERS.length]!;
  const note =
    i % NEWLINE_EVERY === 0
      ? '"first line\nsecond line, with a comma"'
      : i % WIDE_EVERY === 0
        ? 'naïve café'
        : 'plain';
  const city = CITIES[i % CITIES.length]!;
  const end = i % CRLF_EVERY === 0 ? '\r\n' : '\n';
  return `${i},${customer},${note},${(i * AMOUNT_STEP) % AMOUNT_RANGE}.${i % CENTS},${city}${end}`;
}

/** The synthetic shape's bytes, in pieces, until `target` bytes are reached. */
function* syntheticPieces(target: number): Generator<Uint8Array> {
  let written = 0;
  const head = encoder.encode(SYNTHETIC_HEADER);
  yield head;
  written += head.length;
  for (let i = 0; written < target; i += SYNTHETIC_BATCH) {
    const rows: string[] = [];
    for (let r = i; r < i + SYNTHETIC_BATCH; r++) rows.push(syntheticRow(r));
    const piece = encoder.encode(rows.join(''));
    yield piece;
    written += piece.length;
  }
}

/** Copies of a body joined per piece, so a piece is a few megabytes. */
const REPEATS_PER_PIECE = 16;

/** A header, then `body` repeated whole until `target` bytes are reached. */
function* repeatedPieces(
  header: Uint8Array,
  body: Uint8Array,
  target: number,
): Generator<Uint8Array> {
  yield header;
  const piece = new Uint8Array(body.length * REPEATS_PER_PIECE);
  for (let i = 0; i < REPEATS_PER_PIECE; i++) piece.set(body, i * body.length);
  let written = header.length;
  while (written < target) {
    const left = Math.ceil((target - written) / body.length);
    const copies = Math.min(left, REPEATS_PER_PIECE);
    yield piece.subarray(0, copies * body.length);
    written += copies * body.length;
  }
}

/** The bytes of a shape, header first, in pieces, about `target` long. */
export function pieces(shape: ShapeName, target: number): Iterable<Uint8Array> {
  switch (shape) {
    case 'sales': {
      const { header, body } = salesParts();
      return repeatedPieces(header, body, target);
    }
    case 'wide': {
      const { header, body } = wideParts();
      return repeatedPieces(header, body, target);
    }
    case 'synthetic':
      return syntheticPieces(target);
    default:
      throw new Error(`unknown shape ${String(shape)}`);
  }
}

/** A shape's bytes in memory, about `target` long. */
export function shapeBytes(shape: ShapeName, target: number): Uint8Array {
  const parts = [...pieces(shape, target)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The file name a shape of a size is written to. */
export function fileName(shape: ShapeName, target: number): string {
  return `${shape}-${target}.csv`;
}

/**
 * writeShape writes a shape's file at `path` unless one of at least `target`
 * bytes is already there. Returns the file's size.
 */
export function writeShape(
  shape: ShapeName,
  path: string,
  target: number,
): number {
  if (existsSync(path) && statSync(path).size >= target)
    return statSync(path).size;
  const fd = openSync(path, 'w');
  try {
    for (const piece of pieces(shape, target)) writeSync(fd, piece);
  } finally {
    closeSync(fd);
  }
  return statSync(path).size;
}

/** memorySource reads bytes held in memory, copying each read as a file read would. */
export function memorySource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read: (offset, length) =>
      Promise.resolve(
        bytes.slice(offset, Math.min(offset + length, bytes.length)),
      ),
    close: () => Promise.resolve(),
  };
}
