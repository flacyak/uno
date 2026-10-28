/**
 * @fileoverview textOf writes a Parquet LIST, MAP or repeated field as
 * compact JSON, each value in it written as a value of its own column is: a
 * number as a JSON number, and a date, a UUID or bytes as a string.
 */

import type { SchemaElement } from 'hyparquet/src/index.js';
import { expect, test } from 'vite-plus/test';

import { textsOf } from './texts.ts';

const encoder = new TextEncoder();

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
