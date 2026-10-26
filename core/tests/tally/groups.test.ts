/**
 * @fileoverview GroupsFold against its rows read again from scratch.
 */

import { expect, test } from 'vite-plus/test';

import { read } from '@ingest';
import { GroupsFold } from '@tally/groups';
import { seeded } from '@core-tests/lab/cache/stats';
import { CHANNEL, REGION, bytes } from '@core-tests/testdata/sales-q3';

// Enough seeds that edits empty and start groups dozens of times.
const SEEDS = 50;
// Few enough rows per value that edits empty some groups and start others.
const ROWS = 16;
const VALUES = ['', 'East', 'North', 'South', 'West', 'North America'];

function folded(rows: string[]): GroupsFold {
  const fold = new GroupsFold();
  for (const value of rows) fold.add(value);
  return fold;
}

test('a groups fold tallies the sales sheet by channel and region', () => {
  const sheet = read('sales-q3.csv', bytes);
  const column = (col: number) =>
    Array.from({ length: sheet.rows() }, (_, r) => sheet.display(r, col));
  expect(folded(column(CHANNEL)).snapshot().groups).toMatchObject([
    { value: 'web', rows: 1605 },
    { value: 'direct', rows: 1604 },
    { value: 'partner', rows: 1603 },
  ]);
  // Each region has 1,203 rows, so the counts tie and go in value order.
  const tied = folded(column(REGION)).snapshot().groups;
  expect(tied.map((g) => g.value)).toEqual(['East', 'North', 'South', 'West']);
});

test('a groups fold moved by edits reads as one that counts again', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = seeded(seed);
    const row = () => VALUES[Math.floor(random() * VALUES.length)]!;
    const rows = Array.from({ length: ROWS }, row);
    const fold = folded(rows);
    // As many edits as rows, each a new row in place of an old one.
    for (let edit = 0; edit < ROWS; edit++) {
      const r = Math.floor(random() * ROWS);
      fold.remove(rows[r]!);
      rows[r] = row();
      fold.add(rows[r]);
    }
    expect(fold.snapshot(), `seed ${seed}`).toEqual(folded(rows).snapshot());
  }
});
