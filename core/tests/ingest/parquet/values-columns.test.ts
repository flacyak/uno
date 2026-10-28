/**
 * @fileoverview columnsOf reads a footer's schema, as hyparquet hands it, as
 * the columns a sheet shows, each keyed by an RFC 6901 pointer: a struct's
 * fields under dotted names, and a LIST, a MAP or a repeated field as one
 * column.
 */

import type { SchemaElement } from 'hyparquet/src/index.js';
import { expect, test } from 'vite-plus/test';

import { columnsOf } from '@ingest/parquet/values';
import type { Leaf, Primitive, Shape } from '@ingest/parquet/values';

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

const INT32: Primitive = { t: 'primitive', physical: 'INT32' };

/** A struct of two INT32 fields, x and y. */
const POINT: Shape = {
  t: 'struct',
  fields: new Map([
    ['x', INT32],
    ['y', INT32],
  ]),
};

test('a struct flattens to dotted names, keyed by pointers', () => {
  const leaves = leavesOf([
    { name: 'root', num_children: 1 },
    { name: 'user', repetition_type: 'OPTIONAL', num_children: 2 },
    { name: 'name', type: 'BYTE_ARRAY', converted_type: 'UTF8' },
    { name: 'home', num_children: 1 },
    { name: 'city', type: 'BYTE_ARRAY', logical_type: { type: 'STRING' } },
  ]);
  expect(leaves.map((leaf) => [leaf.column, leaf.path])).toEqual([
    [{ name: 'user.name', key: '/user/name' }, ['user', 'name']],
    [
      { name: 'user.home.city', key: '/user/home/city' },
      ['user', 'home', 'city'],
    ],
  ]);
});

test("a literal 'a.b' and a struct a holding b are two columns", () => {
  const leaves = leavesOf([
    { name: 'root', num_children: 2 },
    { name: 'a.b', type: 'INT32' },
    { name: 'a', num_children: 1 },
    { name: 'b', type: 'INT32' },
  ]);
  expect(leaves.map((leaf) => leaf.column)).toEqual([
    { name: 'a.b', key: '/a.b' },
    { name: 'a.b_2', key: '/a/b' },
  ]);
});

test('a repeated field is one column, a list of its values', () => {
  const leaves = leavesOf([
    { name: 'root', num_children: 2 },
    { name: 'ids', type: 'INT32', repetition_type: 'REPEATED' },
    { name: 'points', repetition_type: 'REPEATED', num_children: 2 },
    { name: 'x', type: 'INT32' },
    { name: 'y', type: 'INT32' },
  ]);
  expect(leaves.map((leaf) => [leaf.column.name, leaf.shape])).toEqual([
    ['ids', { t: 'list', of: INT32 }],
    ['points', { t: 'list', of: POINT }],
  ]);
});

test('a LIST is one column of its elements, in either layout', () => {
  const threeLevel = fieldOf(
    { name: 'ids', converted_type: 'LIST', num_children: 1 },
    { name: 'list', repetition_type: 'REPEATED', num_children: 1 },
    { name: 'element', type: 'INT32' },
  );
  const twoLevel = fieldOf(
    { name: 'ids', converted_type: 'LIST', num_children: 1 },
    { name: 'array', type: 'INT32', repetition_type: 'REPEATED' },
  );
  const list: Shape = { t: 'list', of: INT32 };
  expect(threeLevel.map((leaf) => [leaf.column.name, leaf.shape])).toEqual([
    ['ids', list],
  ]);
  expect(twoLevel.map((leaf) => [leaf.column.name, leaf.shape])).toEqual([
    ['ids', list],
  ]);
});

test('a MAP is one column, and a struct inside a LIST stays whole', () => {
  const leaves = leavesOf([
    { name: 'root', num_children: 2 },
    { name: 'tags', converted_type: 'MAP', num_children: 1 },
    { name: 'key_value', repetition_type: 'REPEATED', num_children: 2 },
    { name: 'key', type: 'BYTE_ARRAY', repetition_type: 'REQUIRED' },
    { name: 'value', type: 'INT32' },
    { name: 'points', converted_type: 'LIST', num_children: 1 },
    { name: 'list', repetition_type: 'REPEATED', num_children: 1 },
    { name: 'element', num_children: 2 },
    { name: 'x', type: 'INT32' },
    { name: 'y', type: 'INT32' },
  ]);
  expect(leaves.map((leaf) => [leaf.column.name, leaf.shape])).toEqual([
    ['tags', { t: 'map', values: INT32 }],
    ['points', { t: 'list', of: POINT }],
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
