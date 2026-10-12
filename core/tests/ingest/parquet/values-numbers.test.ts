/**
 * @fileoverview textOf writes a Parquet number as the text its writer
 * meant: an integer as digits, a float at its own precision, and a decimal
 * exactly, from the unscaled integer hyparquet reads with no DECIMAL
 * annotation.
 */

import type { SchemaElement } from 'hyparquet/src/index.js';
import { expect, test } from 'vite-plus/test';

import { columnsOf, textOf } from '@ingest/parquet/values';
import type { Leaf, ParquetValue } from '@ingest/parquet/values';

/** The one column of a file whose schema holds element alone. */
function leafOf(element: SchemaElement): Leaf {
  const [leaf] = columnsOf([{ name: 'root', num_children: 1 }, element]);
  return leaf!;
}

/** Each value as textOf writes it in a column of element. */
function textsOf(element: SchemaElement, values: ParquetValue[]): string[] {
  const leaf = leafOf(element);
  return values.map((value) => textOf(leaf, value));
}

const INT64_MAX = 2n ** 63n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;
const UINT32_MAX = 2 ** 32 - 1;

const BYTE_BITS = 8;
const BYTE_MASK = 0xffn;

/** The bytes a DECIMAL(38, s) takes as a FIXED_LEN_BYTE_ARRAY. */
const DECIMAL38_BYTES = 16;

/** n as big-endian two's complement bytes, width of them. */
function twosComplementOf(n: bigint, width: number): Uint8Array {
  const bytes = new Uint8Array(width);
  let rest = BigInt.asUintN(width * BYTE_BITS, n);
  for (let i = width - 1; i >= 0; i--) {
    bytes[i] = Number(rest & BYTE_MASK);
    rest >>= BigInt(BYTE_BITS);
  }
  return bytes;
}

test('a null is an empty cell, and a boolean is true or false', () => {
  expect(
    textsOf({ name: 'x', type: 'BOOLEAN' }, [null, undefined, true, false]),
  ).toEqual(['', '', 'true', 'false']);
});

test('an INT32 and an INT64 are written as digits', () => {
  expect(textsOf({ name: 'x', type: 'INT32' }, [-5, 0, 2147483647])).toEqual([
    '-5',
    '0',
    '2147483647',
  ]);
  expect(
    textsOf({ name: 'x', type: 'INT64' }, [-INT64_MAX, INT64_MAX]),
  ).toEqual(['-9223372036854775807', '9223372036854775807']);
});

test('an unsigned value is exact, however its stored bits were read', () => {
  const uint64: SchemaElement = {
    name: 'x',
    type: 'INT64',
    converted_type: 'UINT_64',
  };
  expect(textsOf(uint64, [UINT64_MAX, -1n])).toEqual([
    '18446744073709551615',
    '18446744073709551615',
  ]);
  const uint32: SchemaElement = {
    name: 'x',
    type: 'INT32',
    logical_type: { type: 'INTEGER', bitWidth: 32, isSigned: false },
  };
  expect(textsOf(uint32, [UINT32_MAX, -1, 7])).toEqual([
    '4294967295',
    '4294967295',
    '7',
  ]);
});

test('a float32 is the shortest text that reads back as it', () => {
  const values = [1.1, 0.1, -2.5, 16777217, 3.4028234663852886e38, 1e-45, -0];
  expect(
    textsOf({ name: 'x', type: 'FLOAT' }, values.map(Math.fround)),
  ).toEqual(['1.1', '0.1', '-2.5', '16777216', '3.4028235e+38', '1e-45', '-0']);
});

test('a float32 takes nine digits where eight do not read back', () => {
  const [text] = textsOf({ name: 'x', type: 'FLOAT' }, [
    Math.fround(0.105660856),
  ]);
  expect(text).toBe('0.105660856');
});

test('a float16 is the shortest text that reads back as it', () => {
  const element: SchemaElement = {
    name: 'x',
    type: 'FIXED_LEN_BYTE_ARRAY',
    type_length: 2,
    logical_type: { type: 'FLOAT16' },
  };
  // 0.1 as stored, 1 plus the smallest step, the largest finite float16,
  // which 65500 reads back as, the smallest subnormal, and a value 32 from
  // its neighbours.
  const values = [0.0999755859375, 1.0009765625, 65504, 2 ** -24, 33824];
  expect(textsOf(element, [...values, -Infinity, -0])).toEqual([
    '0.1',
    '1.001',
    '65500',
    '6e-8',
    '33820',
    '-Infinity',
    '-0',
  ]);
});

test('a float that is not finite is written as JavaScript names it', () => {
  const values = [NaN, Infinity, -Infinity];
  expect(textsOf({ name: 'x', type: 'FLOAT' }, values)).toEqual([
    'NaN',
    'Infinity',
    '-Infinity',
  ]);
  expect(textsOf({ name: 'x', type: 'DOUBLE' }, values)).toEqual([
    'NaN',
    'Infinity',
    '-Infinity',
  ]);
});

test('a DOUBLE is the shortest text that reads back as it', () => {
  expect(
    textsOf({ name: 'x', type: 'DOUBLE' }, [0.1 + 0.2, 1e21, -0.5, -0]),
  ).toEqual(['0.30000000000000004', '1e+21', '-0.5', '-0']);
});

test('a decimal keeps every digit of its scale', () => {
  const element: SchemaElement = {
    name: 'x',
    type: 'INT32',
    converted_type: 'DECIMAL',
    precision: 4,
    scale: 2,
  };
  expect(textsOf(element, [100, -5, 0, 9999])).toEqual([
    '1.00',
    '-0.05',
    '0.00',
    '99.99',
  ]);
});

test('a decimal with no scale is an integer', () => {
  const element: SchemaElement = {
    name: 'x',
    type: 'INT64',
    logical_type: { type: 'DECIMAL', precision: 18, scale: 0 },
  };
  expect(textsOf(element, [INT64_MAX, -42n])).toEqual([
    '9223372036854775807',
    '-42',
  ]);
});

test('a DECIMAL(38,10) in bytes is exact', () => {
  const element: SchemaElement = {
    name: 'x',
    type: 'FIXED_LEN_BYTE_ARRAY',
    type_length: DECIMAL38_BYTES,
    logical_type: { type: 'DECIMAL', precision: 38, scale: 10 },
  };
  const unscaled = 12345678901234567890123456789012345678n;
  const values = [unscaled, -unscaled, -1n].map((n) =>
    twosComplementOf(n, DECIMAL38_BYTES),
  );
  expect(textsOf(element, values)).toEqual([
    '1234567890123456789012345678.9012345678',
    '-1234567890123456789012345678.9012345678',
    '-0.0000000001',
  ]);
});

test('a decimal in a BYTE_ARRAY reads its bytes as they come', () => {
  const element: SchemaElement = {
    name: 'x',
    type: 'BYTE_ARRAY',
    converted_type: 'DECIMAL',
    scale: 3,
  };
  const values = [new Uint8Array([0x30, 0x39]), new Uint8Array([0xff])];
  expect(textsOf(element, values)).toEqual(['12.345', '-0.001']);
});
