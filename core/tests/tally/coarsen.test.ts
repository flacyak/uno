/**
 * @fileoverview coarsen merges counts into their coarser keys exactly: the
 * merged map equals the counts of the same rows made at the coarser keys.
 */

import { expect, test } from 'vite-plus/test';

import { Count, coarsen, counted } from '@tally';

/** How many rows go into each key, and the key a coarser level holds them under. */
const ROWS = 40;
const KEYS = 8;
const parent = (key: number) => Math.floor(key / 2);

/** Cells whose doubles sum differently by order, and a blank. */
const cell = (row: number) => ['1e16', '1', '-1e16', '0.1', ''][row % 5]!;

test('coarsened counts equal the counts made at the coarser keys', () => {
  const skipped = { blank: 0, unparsed: 0 };
  const fine = new Map<number, Count>();
  const coarse = new Map<number, Count>();
  for (let row = 0; row < ROWS; row++) {
    const key = row % KEYS;
    for (const [map, at] of [
      [fine, key],
      [coarse, parent(key)],
    ] as const) {
      if (!map.has(at)) map.set(at, new Count());
      counted(map.get(at)!, cell(row), 1, 'point', skipped);
    }
  }
  coarsen(fine, parent);
  const read = (m: Map<number, Count>) =>
    [...m]
      .map(([k, c]) => [k, c.rows, c.numbers, c.sum.value()])
      .sort((a, b) => a[0]! - b[0]!);
  expect(read(fine)).toEqual(read(coarse));
  expect(fine.size).toBe(KEYS / 2);
});
