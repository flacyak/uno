/**
 * @fileoverview SpreadFold against its cells sorted again from scratch.
 */

import { expect, test } from 'vite-plus/test';

import { parse } from '@num';
import type { Mark } from '@num';
import { SpreadFold } from '@tally/spread';
import type { Bucket } from '@tally/spread';
import { seeded } from '@core-tests/lab/cache/stats';
import type { Random } from '@core-tests/lab/cache/stats';

// Enough seeds that edits empty and start buckets dozens of times.
const SEEDS = 50;
// Few enough distinct numbers that edits empty some buckets and start others.
const CELLS = 200;
const WHOLE_AT_MOST = 40;
const CENTS = 100;
// Cells a fold leaves out, and ones that read as numbers only with a mark.
const ODD = ['', 'n/a', '-0', '0', '1,5', '1.204,50', '(3)', '$12'];

/** cellOf is a random cell: a whole number, a decimal, or an odd one. */
function cellOf(random: Random): string {
  const whole = Math.floor(random() * WHOLE_AT_MOST) - WHOLE_AT_MOST / 2;
  const pick = random();
  if (pick < 1 / 3) return `${whole}`;
  if (pick < 2 / 3) return `${whole / CENTS}`;
  return ODD[Math.floor(random() * ODD.length)]!;
}

/** sorted gives the buckets of `cells` read with `mark`, from a sorted array. */
function sorted(cells: readonly string[], mark: Mark): Bucket[] {
  const numbers = cells.flatMap((c) => parse(c, mark) ?? []);
  numbers.sort((a, b) => a - b);
  const buckets: Bucket[] = [];
  for (const x of numbers) {
    const last = buckets.at(-1);
    if (last?.low === x) last.rows++;
    else buckets.push({ low: x, high: x, rows: 1 });
  }
  return buckets.map((b) => ({ ...b, low: b.low + 0, high: b.high + 0 }));
}

test('a spread counts each number exactly, least first', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = seeded(seed);
    const cells = Array.from({ length: CELLS }, () => cellOf(random));
    for (const mark of ['point', 'comma'] as const) {
      const fold = new SpreadFold(mark);
      for (const c of cells) fold.add(c);
      const { buckets, numbers, skipped } = fold.read();
      expect(buckets, `seed ${seed}`).toStrictEqual(sorted(cells, mark));
      const read = cells.filter((c) => parse(c, mark) !== undefined);
      expect(numbers).toBe(read.length);
      expect(skipped.blank).toBe(cells.filter((c) => c === '').length);
      expect(skipped.blank + skipped.unparsed + numbers).toBe(CELLS);
    }
  }
});

test('a spread an edit took rows back from holds what the rest make', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = seeded(seed);
    const cells = Array.from({ length: CELLS }, () => cellOf(random));
    const fold = new SpreadFold('point');
    for (const c of cells) fold.add(c);
    const kept = cells.filter(() => random() < 1 / 2);
    for (const c of cells.filter((c) => !kept.includes(c))) fold.remove(c);
    const left = cells.filter((c) => kept.includes(c));
    const again = new SpreadFold('point');
    for (const c of left) again.add(c);
    expect(fold.read(), `seed ${seed}`).toStrictEqual(again.read());
    expect(fold.read().buckets).toStrictEqual(sorted(left, 'point'));
  }
});

test('a spread sums its numbers exactly for their mean', () => {
  const fold = new SpreadFold('point');
  for (const c of ['0.1', '0.2', '0.3', 'n/a', '']) fold.add(c);
  expect(fold.read()).toMatchObject({
    numbers: 3,
    sum: 0.6,
    skipped: { blank: 1, unparsed: 1 },
  });
});
