/**
 * @fileoverview rowRank against splitmix32 worked out apart.
 */

import { expect, test } from 'vite-plus/test';

import { Ranked, byRank, rowRank } from '@tally/rank';
import { SampleFold } from '@tally/sample';
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

test('a ranked keeps the rows of least rank, whatever the order it keeps them in', () => {
  const AT_MOST = 128;
  const rows = [...Array(ROWS >> 10).keys()];
  const first = [...rows].sort(byRank).slice(0, AT_MOST);
  // A row holds its number, but every third holds none.
  const held = (row: number) => (row % 3 === 0 ? undefined : row);
  for (const order of [rows, [...rows].reverse()]) {
    const ranked = new Ranked<number>(AT_MOST);
    for (const row of order) ranked.keep(row, held(row));
    expect(ranked.size).toBeLessThanOrEqual(2 * AT_MOST);
    const holding = first.filter((r) => held(r) !== undefined);
    expect(ranked.first()).toEqual(holding.map((r) => [r, r]));
    // A row let go of leaves the sample, and a row past the cut is not kept.
    ranked.delete(holding[0]!);
    expect(ranked.first().map(([r]) => r)).not.toContain(holding[0]);
    const size = ranked.size;
    ranked.keep([...rows].sort(byRank).at(-1)!, 1);
    expect(ranked.size).toBe(size);
  }
  // A sample fold of 128 rows sends as many.
  const fold = new SampleFold(['point'], AT_MOST);
  for (const row of rows) fold.add(row >> 10, row, `${row}`);
  expect(fold.snapshot().values).toEqual(first.map((r) => [r]));
});
