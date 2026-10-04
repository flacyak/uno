/**
 * @fileoverview The data shapes the scanner variants are checked and timed
 * on, each built to a requested size the same way on every machine.
 *
 * Each shape is a header line and then a block of whole records repeated
 * until the size is reached, so building 96 MB costs one block of work and
 * a run of copies. Every block is at least 240 KB, too long for a branch
 * predictor to learn.
 */

import { readAll } from '@ingest/csv';
import { bytes as SALES_BYTES, repeated } from '@core-tests/testdata/sales-q3';

const encoder = new TextEncoder();
const LF = 0x0a;

/** Shape is one kind of file. */
export interface Shape {
  readonly name: string;
  /** What is in it, for the report. */
  readonly about: string;
  readonly comma: string;
  /** The file, at least `bytes` long. */
  build(bytes: number): Uint8Array;
}

/** tile repeats `body` under `header` until the whole is at least `bytes`. */
function tile(header: Uint8Array, body: Uint8Array, bytes: number): Uint8Array {
  const repeats = Math.max(1, Math.ceil((bytes - header.length) / body.length));
  const out = new Uint8Array(header.length + body.length * repeats);
  out.set(header);
  for (let i = 0; i < repeats; i++)
    out.set(body, header.length + i * body.length);
  return out;
}

/** blockOf encodes rows 0 to `rowsPerBlock - 1` as one block. */
function blockOf(
  rows: (i: number) => string,
  rowsPerBlock: number,
): Uint8Array {
  const parts: string[] = [];
  for (let i = 0; i < rowsPerBlock; i++) parts.push(rows(i));
  return encoder.encode(parts.join(''));
}

/** The sales-q3 fixture's header line and data rows, parsed once. */
const SALES_HEADER_END = SALES_BYTES.indexOf(LF) + 1;
const SALES_RECORDS: readonly string[][] = readAll(
  new TextDecoder().decode(SALES_BYTES),
  ',',
);

/** joined writes records with `comma`, each field passed through `field`. */
function joined(
  records: readonly string[][],
  comma: string,
  field: (value: string) => string,
): string {
  return records.map((r) => `${r.map(field).join(comma)}\n`).join('');
}

/** quoted wraps a field in quotes, doubling the quotes inside. */
function quoted(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** mulberry32, as tests/ingest/scan.test.ts uses. */
export function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The efficiency suite's synthetic rows, copied from
// tests/efficiency/index.test.ts, whose generator is not exported.
const SYNTHETIC_HEADER = 'id,customer,note,amount,city\n';
const NEWLINE_EVERY = 7;
const CRLF_EVERY = 5;
const WIDE_EVERY = 3;
const CUSTOMERS = [
  '"Okafor, Ada"',
  'Lindqvist',
  '"Diaz ""Pepe"" Ruiz"',
  'Nakamura',
];
const CITIES = ['Lagos', 'Malmö', 'São Paulo', '東京', 'Lyon'];
/** A whole number of periods of every pattern above: 7 × 5 × 3 × 4 × 100. */
const SYNTHETIC_ROWS = 42000;
const AMOUNT_MODULUS = 100000;
const AMOUNT_STEP = 37;
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
  return `${i},${customer},${note},${(i * AMOUNT_STEP) % AMOUNT_MODULUS}.${i % CENTS},${city}${end}`;
}

// Long quoted free text: about 200 bytes of words per row, some with
// commas, one row in LONG_QUOTE_EVERY with a doubled quote and one in
// LONG_NEWLINE_EVERY with a newline.
const LONG_HEADER = 'id,text,amount\n';
const LONG_TEXT_BYTES = 200;
const LONG_ROWS = 5000;
const LONG_QUOTE_EVERY = 4;
const LONG_NEWLINE_EVERY = 10;
const LONG_SEED = 65;
const WORDS = [
  'the',
  'shipment',
  'arrived',
  'late,',
  'and',
  'the',
  'customer',
  'asked',
  'for',
  'a',
  'refund',
  'on',
  'two',
  'items;',
  'support',
  'agreed',
  'after',
  'review',
  'of',
  'photos',
  'showing',
  'damage',
  'to',
  'the',
  'outer',
  'box',
];

function longTextBlock(): Uint8Array {
  const rand = random(LONG_SEED);
  return blockOf((i) => {
    let text = '';
    while (text.length < LONG_TEXT_BYTES) {
      text += `${WORDS[Math.floor(rand() * WORDS.length)]!} `;
    }
    if (i % LONG_QUOTE_EVERY === 0) text += 'marked ""fragile"" ';
    if (i % LONG_NEWLINE_EVERY === 0) text += '\nsee attached ';
    return `${i},"${text.trimEnd()}",${(i * AMOUNT_STEP) % AMOUNT_MODULUS}.${i % CENTS}\n`;
  }, LONG_ROWS);
}

// Narrow numeric rows of about 20 bytes and no quotes.
const NUMERIC_HEADER = 'id,count,price\n';
const NUMERIC_ROWS = 100000;
const COUNT_MODULUS = 10000;
const COUNT_STEP = 13;
const PRICE_MODULUS = 1000;

function numericRow(i: number): string {
  return `${i},${(i * COUNT_STEP) % COUNT_MODULUS},${(i * AMOUNT_STEP) % PRICE_MODULUS}.${i % CENTS}\n`;
}

export const SHAPES: readonly Shape[] = [
  {
    name: 'sales-q3',
    about: 'sales-q3.csv repeated: 50-byte rows, about 1.3 quotes per line',
    comma: ',',
    build: (bytes) =>
      repeated(
        Math.max(
          1,
          Math.ceil(
            (bytes - SALES_HEADER_END) /
              (SALES_BYTES.length - SALES_HEADER_END),
          ),
        ),
      ),
  },
  {
    name: 'synthetic',
    about:
      'the efficiency suite rows: quoted commas and newlines, CRLF, multi-byte',
    comma: ',',
    build: (bytes) =>
      tile(
        encoder.encode(SYNTHETIC_HEADER),
        blockOf(syntheticRow, SYNTHETIC_ROWS),
        bytes,
      ),
  },
  {
    name: 'all-quoted',
    about: 'sales-q3 with every field quoted',
    comma: ',',
    build: (bytes) =>
      tile(
        encoder.encode(joined(SALES_RECORDS.slice(0, 1), ',', quoted)),
        encoder.encode(joined(SALES_RECORDS.slice(1), ',', quoted)),
        bytes,
      ),
  },
  {
    name: 'long-text',
    about: 'a quoted free-text field of about 200 bytes per row',
    comma: ',',
    build: (bytes) => tile(encoder.encode(LONG_HEADER), longTextBlock(), bytes),
  },
  {
    name: 'numeric',
    about: 'narrow numeric rows of about 20 bytes, no quotes',
    comma: ',',
    build: (bytes) =>
      tile(
        encoder.encode(NUMERIC_HEADER),
        blockOf(numericRow, NUMERIC_ROWS),
        bytes,
      ),
  },
  {
    name: 'tsv',
    about: 'sales-q3 as TSV: tab separated, nothing quoted',
    comma: '\t',
    build: (bytes) =>
      tile(
        encoder.encode(joined(SALES_RECORDS.slice(0, 1), '\t', (v) => v)),
        encoder.encode(joined(SALES_RECORDS.slice(1), '\t', (v) => v)),
        bytes,
      ),
  },
];

/** shapeNamed returns the shape called `name`, or throws. */
export function shapeNamed(name: string): Shape {
  const shape = SHAPES.find((s) => s.name === name);
  if (shape === undefined) throw new Error(`no shape ${name}`);
  return shape;
}
