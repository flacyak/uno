/**
 * @fileoverview GroupsFold against its rows read again from scratch.
 */

import { expect, test } from 'vite-plus/test';

import { read } from '@ingest';
import {
  DISTINCT_AT_MOST,
  GROUPS_SENT,
  GroupsFold,
  LABEL_AT_MOST,
} from '@tally/groups';
import { seeded } from '@core-tests/lab/cache/stats';
import { CHANNEL, REGION, REVENUE, bytes } from '@core-tests/testdata/sales-q3';

// Enough seeds that edits empty and start groups dozens of times.
const SEEDS = 50;
// Few enough rows per value that edits empty some groups and start others.
const ROWS = 16;
const VALUES = ['', 'East', 'North', 'South', 'West', 'North America'];
// Amounts of up to a million in whole cents, whose sums a running total rounds.
const CENTS = 100;
const MOST_CENTS = 1e8;
// One code point, written in two UTF-16 units.
const WIDE = '\u{1D538}';

function folded(rows: string[]): GroupsFold {
  const fold = new GroupsFold();
  for (const value of rows) fold.add(value);
  return fold;
}

function summed(rows: Array<[string, string]>): GroupsFold {
  const fold = new GroupsFold('sum');
  for (const [value, cell] of rows) fold.add(value, cell);
  return fold;
}

test('a groups fold tallies the sales sheet by channel and region', () => {
  const sheet = read('sales-q3.csv', bytes);
  const column = (col: number) =>
    Array.from({ length: sheet.rows() }, (_, r) => sheet.display(r, col));
  const channels = folded(column(CHANNEL)).snapshot();
  expect(channels.skipped).toEqual({ blank: 0, unparsed: 0 });
  expect(channels.groups).toEqual([
    { value: 'web', rows: 1605, sum: 0 },
    { value: 'direct', rows: 1604, sum: 0 },
    { value: 'partner', rows: 1603, sum: 0 },
  ]);
  // Each region has 1,203 rows, so the counts tie and go in value order.
  const tied = folded(column(REGION)).snapshot().groups;
  expect(tied.map((g) => g.value)).toEqual(['East', 'North', 'South', 'West']);
  const revenue = column(REVENUE);
  const sums = summed(column(REGION).map((value, r) => [value, revenue[r]!]));
  expect(sums.snapshot().groups).toEqual([
    { value: 'South', rows: 1203, sum: 67819080 },
    { value: 'East', rows: 1203, sum: 67779480 },
    { value: 'West', rows: 1203, sum: 66425080 },
    { value: 'North', rows: 1203, sum: 65339640 },
  ]);
  expect(sums.snapshot().skipped).toEqual({ blank: 4, unparsed: 0 });
});

test('a groups fold moved by edits reads as one that counts again', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = seeded(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)]!;
    const amount = () => Math.round((random() * 2 - 1) * MOST_CENTS) / CENTS;
    const row = (): [string, string] => [
      pick(VALUES),
      pick(['', 'n/a', `${amount()}`, `${amount()}`]),
    ];
    const rows = Array.from({ length: ROWS }, row);
    const fold = summed(rows);
    // As many edits as rows, each a new row in place of an old one.
    for (let edit = 0; edit < ROWS; edit++) {
      const r = Math.floor(random() * ROWS);
      fold.remove(...rows[r]!);
      rows[r] = row();
      fold.add(...rows[r]);
    }
    expect(fold.snapshot(), `seed ${seed}`).toEqual(summed(rows).snapshot());
  }
});

test('a blank is a value, and a cell that is not a number is left out', () => {
  const fold = summed([
    ['', '$1,200.50'],
    ['', ''],
    ['', 'n/a'],
    ['', 'n/a'],
    ['', '(0.50)'],
  ]);
  fold.remove('', 'n/a');
  expect(fold.snapshot()).toEqual({
    groups: [{ value: '', rows: 4, sum: 1200 }],
    others: { values: 0, rows: 0, sum: 0 },
    below: { values: 0, rows: 0, sum: 0 },
    rest: { rows: 0, sum: 0 },
    skipped: { blank: 1, unparsed: 1 },
  });
});

test('values first seen past DISTINCT_AT_MOST are counted in the rest', () => {
  const early = Array.from({ length: DISTINCT_AT_MOST }, (_, i) => `${i}`);
  const fold = summed(early.map((value) => [value, '1']));
  fold.add('late', '0.1');
  fold.add('0', '0.1');
  // A place given up stays empty while the rest holds a row.
  fold.remove('1', '1');
  fold.add('later', '0.2');
  fold.add('late', '0.3');
  fold.remove('late', '0.1');
  const { groups, others, rest } = fold.snapshot();
  expect(groups[0]).toEqual({ value: '0', rows: 2, sum: 1.1 });
  expect(groups.length + others.values).toBe(DISTINCT_AT_MOST - 1);
  expect(rest).toEqual({ rows: 2, sum: 0.5 });
  // Once the rest is empty, a value first seen has a group again.
  fold.remove('later', '0.2');
  fold.remove('late', '0.3');
  fold.add('last', '1');
  expect(fold.snapshot().others.values).toBe(DISTINCT_AT_MOST - GROUPS_SENT);
  expect(fold.snapshot().rest).toEqual({ rows: 0, sum: 0 });
});

test('a snapshot sends the largest groups, each value cut to a label', () => {
  // A wide value of 1, then values of 0.1 and 0.2, eleven of them unsent,
  // and two unsent values of 0 and -1, which a pie leaves out.
  const fold = new GroupsFold('sum');
  fold.add(WIDE.repeat(LABEL_AT_MOST + 1), '1');
  fold.add('even', '0');
  fold.add('loss', '-1');
  const cells = ['0.1', '0.2'];
  const unsent = 11;
  for (let i = 0; i < GROUPS_SENT - 1 + unsent; i++) {
    for (const cell of cells) fold.add(`${i}`, cell);
  }
  const { groups, others, below } = fold.snapshot();
  const label = WIDE.repeat(LABEL_AT_MOST);
  expect(groups[0]).toEqual({ value: label, rows: 1, sum: 1 });
  // The small ones tie, so the first in value order are sent.
  expect(groups.slice(1, 4).map((g) => g.value)).toEqual(['0', '1', '10']);
  expect(groups.length).toBe(GROUPS_SENT);
  // The unsent cells add up to 3.3000000000000003. Their groups' sums,
  // 0.30000000000000004 each, add up to 3.3000000000000007.
  const rows = cells.length * unsent;
  expect(others).toEqual({ values: unsent, rows, sum: 3.3000000000000003 });
  expect(below).toEqual({ values: 2, rows: 2, sum: -1 });
  // A snapshot leaves the fold as it was.
  expect(fold.snapshot()).toEqual(fold.snapshot());
  // A fold that counts rows has none below, though its sums are 0.
  const ids = Array.from({ length: GROUPS_SENT + 1 }, (_, i) => `${i}`);
  expect(folded(ids).snapshot().others).toEqual({ values: 1, rows: 1, sum: 0 });
});
