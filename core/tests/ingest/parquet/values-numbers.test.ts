/**
 * @fileoverview textOf writes a Parquet number as the text its writer
 * meant: an integer as digits and a float at its own precision.
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
