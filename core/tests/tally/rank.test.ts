/**
 * @fileoverview rowRank against splitmix32 worked out apart.
 */

import { expect, test } from 'vite-plus/test';

import { byRank, rowRank } from '@tally/rank';
import { UINT32_RANGE } from '@core-tests/lab/cache/stats';

// 2^20 rows, about as many as a large sheet holds.
const ROWS = 1 << 20;

test('a rank is splitmix32 of the row, and no two rows share one', () => {
  // The first number splitmix32 draws from seeds 0, 1 and 2^32 - 1, worked
  // out with Python's integers.
  const last = UINT32_RANGE - 1;
  expect([0, 1, last].map(rowRank)).toEqual([
    1684164658, 1580013426, 3950124170,
  ]);
  const ranks = new Set(Array.from({ length: ROWS }, (_, r) => rowRank(r)));
  expect(ranks.size).toBe(ROWS);
  // Rows 2^32 apart share a rank, and go in row order.
  expect(rowRank(UINT32_RANGE)).toBe(rowRank(0));
  expect([UINT32_RANGE, 0].sort(byRank)).toEqual([0, UINT32_RANGE]);
});
