/**
 * @fileoverview SampleFold against its rows read again from scratch.
 */

import { expect, test } from 'vite-plus/test';

import { byRank } from '@tally/rank';
import { SCATTER_POINTS_AT_MOST, SampleFold } from '@tally/sample';

// Enough rows that a fold cuts its kept rows down more than once.
const ROWS = 5 * SCATTER_POINTS_AT_MOST;
// One row in this many has a blank y.
const BLANK_EVERY = 3;

test('a sample fold sends the points of the rows of least rank', () => {
  // A row's y is twice its x, or blank.
  const y = (r: number) => (r % BLANK_EVERY === 0 ? '' : `${2 * r}`);
  const ranked = [...Array(ROWS).keys()].sort(byRank);
  const fold = new SampleFold();
  for (let r = 0; r < ROWS; r++) fold.add(r, `${r}`, y(r));
  // A row left out keeps its place in the sample, with no point.
  const sampled = ranked.slice(0, SCATTER_POINTS_AT_MOST);
  const x = sampled.filter((r) => y(r) !== '');
  expect(fold.snapshot()).toMatchObject({ x, y: x.map((r) => 2 * r) });
  // Rows that all read as numbers fill the sample, whatever their order.
  const full = new SampleFold();
  for (const r of ranked) full.add(r, `${r}`, `${r}`);
  expect(full.snapshot().x).toHaveLength(SCATTER_POINTS_AT_MOST);
});
