/**
 * @fileoverview textOf writes a Parquet LIST, MAP or repeated field as
 * compact JSON, each value in it written as a value of its own column is: a
 * number as a JSON number, and a date, a UUID or bytes as a string.
 */

import type { SchemaElement } from 'hyparquet/src/index.js';
import { expect, test } from 'vite-plus/test';

import type { ParquetValue } from '@ingest/parquet/values';

import { textsOf } from './texts.ts';

const encoder = new TextEncoder();

/** The bytes of a UUID. */
const UUID_BYTES = 16;

/** A three-level LIST named `name`, whose `element` follows. */
function list(name: string, element: SchemaElement): SchemaElement[] {
  return [
    { name, converted_type: 'LIST', num_children: 1 },
    { name: 'list', repetition_type: 'REPEATED', num_children: 1 },
    element,
  ];
}

test('a list of decimals writes raw digits', () => {
  const elements = list('prices', {
    name: 'element',
    type: 'INT64',
    converted_type: 'DECIMAL',
    scale: 2,
  });
  expect(textsOf(elements, [[100n, -5n, null], [], null])).toEqual([
    '[1.00,-0.05,null]',
    '[]',
    '',
  ]);
});

test('a number JSON cannot hold, a date and bytes are strings in a list', () => {
  const floats = list('f', { name: 'element', type: 'FLOAT' });
  expect(textsOf(floats, [[Math.fround(1.1), NaN, -Infinity]])).toEqual([
    '[1.1,"NaN","-Infinity"]',
  ]);
  const dates = list('d', {
    name: 'element',
    type: 'INT32',
    converted_type: 'DATE',
  });
  expect(textsOf(dates, [[-1, 0]])).toEqual(['["1969-12-31","1970-01-01"]']);
  const bytes = list('b', { name: 'element', type: 'BYTE_ARRAY' });
  const values = [encoder.encode('say "hi"'), new Uint8Array([0xff])];
  expect(textsOf(bytes, [values])).toEqual(['["say \\"hi\\"","0xff"]']);
});

/** A MAP named `name`, its `key` and `value` columns following. */
function map(
  name: string,
  key: SchemaElement,
  value: SchemaElement,
): SchemaElement[] {
  return [
    { name, converted_type: 'MAP', num_children: 1 },
    { name: 'key_value', repetition_type: 'REPEATED', num_children: 2 },
    { ...key, name: 'key', repetition_type: 'REQUIRED' },
    { ...value, name: 'value' },
  ];
}

/** A MAP key as hyparquet reads one with identity parsers. */
type Key = boolean | number | bigint | string | Uint8Array;

/**
 * A MAP's value as hyparquet's assembleMaps builds one: an object keyed by
 * String of each stored key, so a key stored as bytes is their numbers
 * joined by commas.
 */
function mapOf(
  keys: readonly Key[],
  values: readonly ParquetValue[],
): ParquetValue {
  return Object.fromEntries(keys.map((key, i) => [String(key), values[i]]));
}

test('a map writes its values as its value column says', () => {
  const elements = map(
    'counts',
    { name: 'key', type: 'BYTE_ARRAY', converted_type: 'UTF8' },
    { name: 'value', type: 'INT64', converted_type: 'UINT_64' },
  );
  const counts = mapOf(
    [encoder.encode('a"b'), encoder.encode('cd')],
    [-1n, null],
  );
  expect(textsOf(elements, [counts, mapOf([], [])])).toEqual([
    '{"a\\"b":18446744073709551615,"cd":null}',
    '{}',
  ]);
});

test('a map writes its keys as its key column says', () => {
  const value: SchemaElement = { name: 'value', type: 'INT32' };
  const uuid = new Uint8Array(UUID_BYTES).fill(0xab);
  const cases: Array<[SchemaElement, Key[], string]> = [
    [
      { name: 'key', type: 'INT32', converted_type: 'DATE' },
      [19782, -1],
      '{"2024-02-29":0,"1969-12-31":1}',
    ],
    [
      { name: 'key', type: 'INT32', converted_type: 'DECIMAL', scale: 2 },
      [100, -5],
      '{"1.00":0,"-0.05":1}',
    ],
    [
      { name: 'key', type: 'INT64', converted_type: 'TIMESTAMP_MILLIS' },
      [1n],
      '{"1970-01-01T00:00:00.001Z":0}',
    ],
    [
      {
        name: 'key',
        type: 'FIXED_LEN_BYTE_ARRAY',
        logical_type: { type: 'UUID' },
      },
      [uuid],
      '{"abababab-abab-abab-abab-abababababab":0}',
    ],
    // Keys that String could not have written for the key column.
    [{ name: 'key', type: 'BYTE_ARRAY' }, ['red'], '{"red":0}'],
    [{ name: 'key', type: 'INT64' }, ['1.5'], '{"1.5":0}'],
  ];
  for (const [key, keys, json] of cases) {
    const values = keys.map((_, i) => i);
    expect(textsOf(map('m', key, value), [mapOf(keys, values)])).toEqual([
      json,
    ]);
  }
});

test('a struct in a list writes each field as its own column would', () => {
  const elements: SchemaElement[] = [
    ...list('points', { name: 'element', num_children: 3 }),
    {
      name: 'at',
      type: 'INT64',
      logical_type: {
        type: 'TIMESTAMP',
        isAdjustedToUTC: true,
        unit: 'MILLIS',
      },
    },
    { name: 'label', type: 'BYTE_ARRAY', logical_type: { type: 'STRING' } },
    { name: 'ok', type: 'BOOLEAN' },
  ];
  const point = { at: 1n, label: encoder.encode('é'), ok: true };
  expect(textsOf(elements, [[point, null]])).toEqual([
    '[{"at":"1970-01-01T00:00:00.001Z","label":"é","ok":true},null]',
  ]);
});

test('a list of lists and a repeated field are arrays too', () => {
  const lists: SchemaElement[] = [
    ...list('grid', {
      name: 'element',
      converted_type: 'LIST',
      num_children: 1,
    }),
    { name: 'list', repetition_type: 'REPEATED', num_children: 1 },
    { name: 'element', type: 'INT32' },
  ];
  expect(textsOf(lists, [[[1, 2], [], null]])).toEqual(['[[1,2],[],null]']);
  const repeated: SchemaElement = {
    name: 'tags',
    type: 'INT64',
    repetition_type: 'REPEATED',
  };
  expect(textsOf(repeated, [[-1n, 9007199254740993n]])).toEqual([
    '[-1,9007199254740993]',
  ]);
});
