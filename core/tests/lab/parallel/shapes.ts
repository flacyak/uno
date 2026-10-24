/**
 * @fileoverview The data shapes the parallel lab checks and measures.
 *
 * - sales: tests/testdata/sales-q3.csv repeated, CRLF rows with a quoted
 *   "1,204" in many of them.
 * - synthetic: the generator of tests/efficiency/index.test.ts, with quoted
 *   commas, quoted newlines, CRLF rows and multi-byte characters.
 * - plain: no quote anywhere.
 * - emptyQuotes, bareQuotes, alternating, quoteRun: made so the paths of a
 *   speculative scan stay apart, to find its worst cases.
 */

import { repeated } from '@core-tests/testdata/sales-q3';

/** A shape: its name and a function that makes about `size` bytes of it. */
export interface Shape {
  readonly name: string;
  make(size: number): Uint8Array<ArrayBuffer>;
}

const encoder = new TextEncoder();

/** Rows encoded at a time while a shape is built. */
const BATCH_ROWS = 4096;

/**
 * build writes `header`, then `row(0)`, `row(1)` and on, until the bytes
 * reach `size`. Rows are added a batch at a time, so it may run a little
 * past `size`.
 */
export function build(
  header: string,
  row: (i: number) => string,
  size: number,
): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [encoder.encode(header)];
  let total = parts[0]!.length;
  for (let first = 0; total < size; first += BATCH_ROWS) {
    const batch: string[] = [];
    for (let i = first; i < first + BATCH_ROWS; i++) batch.push(row(i));
    const bytes = encoder.encode(batch.join(''));
    parts.push(bytes);
    total += bytes.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// The synthetic CSV of tests/efficiency/index.test.ts, copied from there.
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
/** The amount column runs through this many whole values. */
const AMOUNT_SPAN = 100000;
/** Multiplier that spreads the amounts over their span. */
const AMOUNT_STEP = 37;
/** Cents run through this many values. */
const CENTS = 100;

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
  const amount = `${(i * AMOUNT_STEP) % AMOUNT_SPAN}.${i % CENTS}`;
  return `${i},${customer},${note},${amount},${city}${end}`;
}

const REGIONS = ['West', 'East', 'North', 'South'];

/** A row with no quote in it, ending in CRLF one time in CRLF_EVERY. */
function plainRow(i: number): string {
  const end = i % CRLF_EVERY === 0 ? '\r\n' : '\n';
  const amount = `${(i * AMOUNT_STEP) % AMOUNT_SPAN}.${i % CENTS}`;
  return `${i},${REGIONS[i % REGIONS.length]!},${amount},rep ${i % CITIES.length}${end}`;
}

/** The bytes of one copy of sales-q3.csv's rows, for sizing `repeated`. */
const SALES_COPY_BYTES = repeated(2).length - repeated(1).length;

export const SALES: Shape = {
  name: 'sales',
  make: (size) => repeated(Math.max(1, Math.ceil(size / SALES_COPY_BYTES))),
};

export const SYNTHETIC: Shape = {
  name: 'synthetic',
  make: (size) => build(SYNTHETIC_HEADER, syntheticRow, size),
};

export const PLAIN: Shape = {
  name: 'plain',
  make: (size) => build('id,region,amount,rep\n', plainRow, size),
};

/**
 * Every quote is an empty quoted field. Read from inside quotes, `""` is an
 * escaped quote, so that path stays inside quotes for good.
 */
export const EMPTY_QUOTES: Shape = {
  name: 'emptyQuotes',
  make: (size) => build('id,note,city\n', (i) => `${i},"",x\n`, size),
};

/**
 * Every quote is data in an unquoted field. Read from inside quotes, each one
 * is a bare quote, so that path stays inside quotes for good.
 */
export const BARE_QUOTES: Shape = {
  name: 'bareQuotes',
  make: (size) => build('id,note,city\n', (i) => `${i},ab"cd,x\n`, size),
};

/**
 * Each row holds one quote before a separator, so a quoted field opens on
 * one row and closes on the next. The two readings trade places every row
 * and both report records.
 */
export const ALTERNATING: Shape = {
  name: 'alternating',
  make: (size) => build('id,note,city\n', (i) => `${i},",x\n`, size),
};

/** One field of nothing but quotes: every path steps one byte at a time. */
export const QUOTE_RUN: Shape = {
  name: 'quoteRun',
  make: (size) => {
    const header = encoder.encode('note\n');
    const out = new Uint8Array(header.length + size).fill('"'.charCodeAt(0));
    out.set(header);
    return out;
  },
};

/** Every shape, real ones first. */
export const SHAPES: readonly Shape[] = [
  SALES,
  SYNTHETIC,
  PLAIN,
  EMPTY_QUOTES,
  BARE_QUOTES,
  ALTERNATING,
  QUOTE_RUN,
];
