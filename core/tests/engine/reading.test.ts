/**
 * @fileoverview A Reading reads a source as the View read it before: a row
 * index reports the bytes it has scanned out of the file's size.
 */

import { expect, test } from 'vite-plus/test';

import { RowIndex } from '@engine';

test('a row index has indexed the bytes it has scanned, out of the size', () => {
  const index = new RowIndex(10, 1010, { blockRows: 2, blockBytes: 1 << 20 });
  // Before any scan, the bytes ahead of the first record are accounted for.
  expect(index.indexed()).toEqual({ done: 10, total: 1010 });

  for (const offset of [10, 20, 30]) index.begin(offset);
  index.scanned = 40;
  expect(index.indexed()).toEqual({ done: 40, total: 1010 });
});
