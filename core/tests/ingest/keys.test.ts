/**
 * @fileoverview KeyRegistry gives each JSON Lines key a column in the order
 * keys are first seen, and names it once.
 */

import { describe, expect, test } from 'vite-plus/test';

import { JSON_COLUMNS_LIMIT, KeyRegistry } from '@ingest/keys';
import type { KeyedColumn } from '@ingest/keys';

/**
 * Columns a save pinned, where nested a then b was seen before a literal
 * 'a.b' and so holds the name a.b.
 */
const PINNED: readonly KeyedColumn[] = [
  { name: 'b', key: '/b' },
  { name: 'a.b', key: '/a/b' },
  { name: 'a.b_2', key: '/a.b' },
];

/** registry returns a registry under `limit` that starts from `pinned`. */
function registry(
  limit = JSON_COLUMNS_LIMIT,
  pinned: readonly KeyedColumn[] = [],
): KeyRegistry {
  return new KeyRegistry(pinned, limit);
}

describe('KeyRegistry places keys in the order they are first seen', () => {
  test('each key keeps its column, named by its pointer joined by dots', () => {
    const keys = registry();
    expect(keys.place('/id')).toBe(0);
    expect(keys.place('/user/name')).toBe(1);
    expect(keys.place('/id')).toBe(0);
    expect(keys.place('/a~1b/t~0x')).toBe(2);
    expect(keys.place('/~01')).toBe(3);
    expect(keys.place('/')).toBe(4);
    expect(keys.columns()).toEqual([
      { name: 'id', key: '/id' },
      { name: 'user.name', key: '/user/name' },
      { name: 'a/b.t~x', key: '/a~1b/t~0x' },
      { name: '~1', key: '/~01' },
      { name: '', key: '/' },
    ]);
  });

  test("a literal 'a.b' after nested a then b becomes a.b_2", () => {
    const keys = registry();
    keys.place('/a/b');
    keys.place('/a.b');
    keys.place('/a.b_2');
    expect(keys.columns().map(({ name }) => name)).toEqual([
      'a.b',
      'a.b_2',
      'a.b_2_2',
    ]);
  });

  test('columnOf finds a placed key and adds none', () => {
    const keys = registry();
    expect(keys.columnOf('/a')).toBeUndefined();
    expect(keys.columns()).toEqual([]);
    keys.place('/a');
    expect(keys.columnOf('/a')).toBe(0);
  });

  test('names never change once given', () => {
    const keys = registry();
    keys.place('/a/b');
    keys.place('/x');
    const given = keys.columns().map((column) => ({ ...column }));
    keys.place('/a.b');
    keys.place('/x_2');
    keys.place('/x~1');
    expect(keys.columns().slice(0, given.length)).toEqual(given);
  });
});

describe('KeyRegistry starts from the pinned columns', () => {
  test('pinned columns keep their places, and a key claims its own', () => {
    const keys = registry(JSON_COLUMNS_LIMIT, PINNED);
    expect(keys.columns()).toEqual(PINNED);
    expect(keys.place('/a.b')).toBe(2);
    expect(keys.place('/c')).toBe(3);
    expect(keys.place('/b')).toBe(0);
    expect(keys.place('/a/b')).toBe(1);
    expect(keys.columns()).toEqual([...PINNED, { name: 'c', key: '/c' }]);
  });

  test('a new key is named against every pinned name', () => {
    const keys = registry(JSON_COLUMNS_LIMIT, [{ name: 'x', key: '/y' }]);
    keys.place('/x');
    expect(keys.columns()[1]).toEqual({ name: 'x_2', key: '/x' });
  });

  test('a key pinned twice keeps its first column', () => {
    const twice = [...PINNED, { name: 'b_2', key: '/b' }];
    const keys = registry(JSON_COLUMNS_LIMIT, twice);
    expect(keys.columns()).toEqual(twice);
    expect(keys.place('/b')).toBe(0);
  });
});
