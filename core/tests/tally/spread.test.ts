/**
 * @fileoverview SpreadFold against its cells sorted again from scratch.
 */

import { expect, test } from 'vite-plus/test';

import { parse } from '@num';
import type { Mark } from '@num';
import { FIGURES_AT_MOST, SPREAD_AT_MOST, SpreadFold } from '@tally/spread';
import type { Bucket } from '@tally/spread';
import { seeded, shuffled } from '@core-tests/lab/cache/stats';
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

/** folded is a fold of `cells` that holds `atMost` buckets. */
function folded(cells: readonly string[], atMost: number): SpreadFold {
  const fold = new SpreadFold('point', atMost);
  for (const c of cells) fold.add(c);
  return fold;
}

test('a spread past its bound keeps the leading figures each cell wrote', () => {
  const cells = ['2.3', '2.31', '2.35', '0.29', '0.291', '-2.3', '-2.25'];
  // Three buckets fit at 2 figures, and five at 3.
  expect(folded(cells, 3).read()).toMatchObject({
    figures: 2,
    buckets: [
      { low: -2.3, high: -2.2, rows: 2 },
      { low: 0.29, high: 0.3, rows: 2 },
      { low: 2.3, high: 2.4, rows: 3 },
    ],
  });
  expect(folded(cells, cells.length).read().figures).toBe('exact');
  // 12 figures tell the first two apart, and not the last two.
  const fine = ['1.00000000001', '1', '1.000000000001'];
  expect(folded(fine, 2).read()).toMatchObject({
    figures: FIGURES_AT_MOST,
    buckets: [
      { low: 1, rows: 2 },
      { low: 1.00000000001, rows: 1 },
    ],
  });
});

test('a spread holds a bucket of every number it counted, at any figures', () => {
  // Numbers over 30 decades, of up to 6 figures, either side of zero.
  const DECADES = 30;
  const FIGURES = 6;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = seeded(seed);
    const cells = Array.from({ length: CELLS }, () => {
      const lead = Math.floor(random() * 10 ** FIGURES);
      const e = Math.floor(random() * DECADES) - DECADES / 2;
      return `${random() < 1 / 2 ? '-' : ''}${lead}e${e}`;
    });
    for (const atMost of [1, CELLS / 8, CELLS / 2]) {
      const fold = folded(cells, atMost);
      const { buckets, figures } = fold.read();
      // One figure is the least, however many buckets it takes.
      if (figures !== 1) expect(buckets.length).toBeLessThanOrEqual(atMost);
      expect(figures, `seed ${seed}`).not.toBe('exact');
      const counted = buckets.map((b) => ({ ...b, rows: 0 }));
      for (const c of cells) {
        const x = parse(c, 'point')!;
        const into = counted.filter(
          (b) => (b.low <= x && x < b.high) || b.low === x,
        );
        expect(into, `seed ${seed}: ${c}`).toHaveLength(1);
        into[0]!.rows++;
      }
      expect(counted).toStrictEqual(buckets);
      const again = folded(shuffled(cells, random), atMost);
      expect(again.read(), `seed ${seed}`).toStrictEqual(fold.read());
    }
  }
});

test('a spread of zeros and the ends of a double keeps one figure at least', () => {
  const ends = ['0', '-0', '1e300', '-1.7e308', '5e-324', '-2.2e-308'];
  const fold = folded([...ends, ...ends], 1);
  const { buckets, figures } = fold.read();
  expect(figures).toBe(1);
  expect(buckets.map((b) => b.rows)).toStrictEqual([2, 2, 4, 2, 2]);
  expect(buckets.flatMap((b) => [b.low, b.high]).every(Number.isFinite)).toBe(
    true,
  );
  expect(buckets[2]).toStrictEqual({ low: 0, high: 0, rows: 4 });
});

test('a spread takes a row back at the figures it holds, and never goes finer', () => {
  const fold = new SpreadFold('point', 2);
  // Two buckets fit at 3 figures: [1, 1.01) and [1.01, 1.02).
  for (const c of ['1', '1.01', '1.001']) fold.add(c);
  fold.remove('1.01');
  fold.remove('1.001');
  expect(fold.read()).toMatchObject({
    figures: 3,
    buckets: [{ low: 1, high: 1.01, rows: 1 }],
  });
  expect(new SpreadFold('point').read().figures).toBe('exact');
  expect(SPREAD_AT_MOST).toBeGreaterThan(CELLS);
});
