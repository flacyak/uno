/**
 * @fileoverview namesBeside names columns beside those already kept, so no
 * two share a name, by the rule a header row is named by.
 */

import { describe, expect, test } from 'vite-plus/test';

import { namesBeside, suffixed } from '@sheet';

describe('namesBeside', () => {
  test('names a header row beside nothing: the first of each name keeps it', () => {
    expect(namesBeside([], ['a', 'a', 'a_2', 'b', 'a'])).toEqual([
      'a',
      'a_3',
      'a_2',
      'b',
      'a_4',
    ]);
  });

  test('beside kept columns, every name one of them has takes a suffix', () => {
    expect(namesBeside(['a', 'a_2'], ['a', 'b', 'a', 'b'])).toEqual([
      'a_3',
      'b',
      'a_4',
      'b_2',
    ]);
  });
});

describe('suffixed', () => {
  test('takes the lowest suffix from _2 that makes a name not yet taken', () => {
    expect(suffixed('a', new Set(['a']))).toBe('a_2');
    expect(suffixed('a', new Set(['a', 'a_2', 'a_3']))).toBe('a_4');
    expect(suffixed('_line', new Set(['_line_2']))).toBe('_line_3');
  });
});
