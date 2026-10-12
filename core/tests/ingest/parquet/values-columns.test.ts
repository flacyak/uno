/**
 * @fileoverview columnsOf reads a footer's schema, as hyparquet hands it, as
 * the columns a sheet shows, each keyed by an RFC 6901 pointer.
 */

import type { SchemaElement } from 'hyparquet/src/index.js';
import { expect, test } from 'vite-plus/test';

import { columnsOf } from '@ingest/parquet/values';
import type { Leaf } from '@ingest/parquet/values';

/** The columns of a schema written as hyparquet types one. */
function leavesOf(schema: SchemaElement[]): Leaf[] {
  return columnsOf(schema);
}

/** The columns of one top-level field, the elements under it following. */
function fieldOf(...elements: SchemaElement[]): Leaf[] {
  return leavesOf([{ name: 'root', num_children: 1 }, ...elements]);
}

test('a top-level field is a column named for it, keyed by a pointer', () => {
  const leaves = leavesOf([
    { name: 'root', num_children: 2 },
    { name: 'id', type: 'INT64', repetition_type: 'REQUIRED' },
    { name: 'name', type: 'BYTE_ARRAY', converted_type: 'UTF8' },
  ]);
  expect(leaves).toEqual([
    {
      column: { name: 'id', key: '/id' },
      path: ['id'],
      shape: { t: 'primitive', physical: 'INT64' },
    },
    {
      column: { name: 'name', key: '/name' },
      path: ['name'],
      shape: { t: 'primitive', physical: 'BYTE_ARRAY' },
    },
  ]);
});

test("a pointer escapes '~' and '/' in a name", () => {
  const [leaf] = fieldOf({ name: 'm~/s', type: 'INT32' });
  expect(leaf!.column).toEqual({ name: 'm~/s', key: '/m~0~1s' });
});

test('a schema that ends inside a group, or a leaf with no type, is refused', () => {
  expect(() => leavesOf([{ name: 'root', num_children: 2 }])).toThrow(
    'parquet schema ends inside a group',
  );
  expect(() => fieldOf({ name: 'x' })).toThrow('parquet column x has no type');
});
