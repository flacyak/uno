/**
 * @fileoverview A spread's histogram levels against its cells binned again
 * from scratch.
 */

import { expect, test } from 'vite-plus/test';

import { parse } from '@num';
import {
  BINS_SENT_AT_MOST,
  SPAN_BINS_AT_LEAST,
  SPAN_BINS_AT_MOST,
  edgeOf,
  levelsOf,
} from '@tally/levels';
import type { Level } from '@tally/levels';
import { SpreadFold } from '@tally/spread';
import { seeded } from '@core-tests/lab/cache/stats';
import type { Random } from '@core-tests/lab/cache/stats';

const SEEDS = 50;
const CELLS = 400;
// Few enough buckets that a spread of CELLS coarsens.
const COARSE = 64;
const STEPS = [1, 2, 5];

/** cellOf is a log-normal-ish amount, a few far out, as a cell writes it. */
function cellOf(random: Random): string {
  const far = random() < 1 / 50 ? 1e6 : 1;
  const sign = random() < 1 / 10 ? -1 : 1;
  return `${(sign * far * Math.round(Math.exp(random() * 8) * 100)) / 100}`;
}

/** binned is `level` counted again from `numbers`, one comparison an edge. */
function binned(level: Level, numbers: readonly number[]) {
  const edges = Array.from({ length: level.rows.length + 1 }, (_, i) =>
    edgeOf(level, i),
  );
  const rows = level.rows.map(
    (_, i) => numbers.filter((x) => edges[i]! <= x && x < edges[i + 1]!).length,
  );
  const below = numbers.filter((x) => x < edges[0]!).length;
  const above = numbers.filter((x) => x >= edges.at(-1)!).length;
  return { ...level, rows, below, above };
}

/** spanned is the levels of `cells` over their 1st to 99th percentile, and that span. */
function spanned(cells: readonly string[]) {
  const fold = new SpreadFold('point');
  for (const c of cells) fold.add(c);
  const { buckets, figures } = fold.read();
  const { span } = fold.snapshot('most').box!;
  const [low, high] = [span[0]![0], span[1]![0]];
  return { levels: levelsOf(buckets, figures, low, high), low, high };
}

test('every level counts what its edges hold', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = seeded(seed);
    const cells = Array.from({ length: CELLS }, () => cellOf(random));
    const numbers = cells.map((c) => parse(c, 'point')!);
    const { levels } = spanned(cells);
    expect(levels.length, `seed ${seed}`).toBeGreaterThan(0);
    for (const level of levels) {
      expect(level, `seed ${seed}`).toStrictEqual(binned(level, numbers));
    }
  }
});

test('levels step by 1, 2 and 5 from the finest that spans few enough bins', () => {
  const random = seeded(1);
  const cells = Array.from({ length: CELLS }, () => cellOf(random));
  const { levels, low, high } = spanned(cells);
  const widths = levels.map((l) => l.step * 10 ** l.power);
  expect(widths).toStrictEqual([...widths].sort((a, b) => a - b));
  for (const level of levels) {
    expect(STEPS).toContain(level.step);
    expect(level.spans).toBeLessThanOrEqual(SPAN_BINS_AT_MOST);
    expect(level.rows.length).toBeLessThanOrEqual(BINS_SENT_AT_MOST);
    // The span's bins hold its 1st and 99th percentiles.
    expect(edgeOf(level, level.at)).toBeLessThanOrEqual(low);
    expect(edgeOf(level, level.at + level.spans)).toBeGreaterThan(high);
  }
  expect(levels.at(-1)!.spans).toBeLessThanOrEqual(SPAN_BINS_AT_LEAST);
  expect(levels.at(-2)!.spans).toBeGreaterThan(SPAN_BINS_AT_LEAST);
  // The finest a step finer would span too many bins.
  expect(levels[0]!.spans * STEPS.length).toBeGreaterThan(SPAN_BINS_AT_MOST);
});

test('a spread of one number sends one bin of it', () => {
  for (const cell of ['5', '0', '-0.003']) {
    const { levels } = spanned([cell, cell]);
    expect(levels, cell).toHaveLength(1);
    expect(levels[0]).toMatchObject({ rows: [2], at: 0, spans: 1 });
  }
  expect(new SpreadFold('point').snapshot('most').levels).toStrictEqual([]);
});

test('a level sends the bins past its span to each side, evenly where both want more', () => {
  // Far out either side of 0 to 999, past what the bins sent reach.
  const middle = Array.from({ length: 1000 }, (_, i) => `${i}`);
  const most = spanned(['-5000', '5000', ...middle]).levels[0]!;
  expect(most.rows).toHaveLength(BINS_SENT_AT_MOST);
  expect(most.at).toBe(Math.floor((BINS_SENT_AT_MOST - most.spans) / 2));
  expect(most).toMatchObject({ below: 1, above: 1 });
  // A span that starts at the least gives the other side every bin.
  const zeros = Array.from({ length: 50 }, () => '0');
  const low = spanned([...zeros, ...middle, '5000']).levels[0]!;
  expect(low).toMatchObject({ at: 0, below: 0, above: 1 });
  expect(low.rows).toHaveLength(BINS_SENT_AT_MOST);
});

test('every level a snapshot sends counts what its edges hold, coarsened too', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = seeded(seed);
    const cells = Array.from({ length: CELLS }, () => cellOf(random));
    const numbers = cells.map((c) => parse(c, 'point')!);
    const fold = new SpreadFold('point', COARSE);
    for (const c of cells) fold.add(c);
    expect(fold.read().figures).not.toBe('exact');
    for (const span of ['most', 'all'] as const) {
      const { levels } = fold.snapshot(span);
      expect(levels.length, `seed ${seed}`).toBeGreaterThan(0);
      for (const level of levels) {
        expect(level, `seed ${seed} ${span}`).toStrictEqual(
          binned(level, numbers),
        );
      }
    }
  }
});

test('a snapshot sends no level whose edges need more figures than it holds', () => {
  // Three figures fit 900 buckets a decade, two only 90.
  const fold = new SpreadFold('point', 2 * 90);
  for (let i = 100; i < 1000; i++) fold.add(`${i}`);
  expect(fold.read().figures).toBe(2);
  const { levels } = fold.snapshot('all');
  expect(levels.map((l) => [l.step, l.power])[0]).toStrictEqual([1, 1]);
});

test("a snapshot's levels span every bin with 'all'", () => {
  const random = seeded(2);
  const fold = new SpreadFold('point');
  for (let i = 0; i < CELLS; i++) fold.add(cellOf(random));
  for (const level of fold.snapshot('all').levels) {
    expect(level).toMatchObject({ at: 0, below: 0, above: 0 });
    expect(level.spans).toBe(level.rows.length);
  }
});

test('the bins past a span stop at the first edge a coarsened spread does not hold', () => {
  // 3 figures hold 100 to 999 and [1000, 1010), so 1001 and 1002 share one.
  const hundreds = Array.from({ length: 900 }, (_, i) => `${100 + i}`);
  const fold = new SpreadFold('point', hundreds.length + 2);
  for (const c of [...hundreds, '1001', '1002', '50000']) fold.add(c);
  expect(fold.read().figures).toBe(3);
  const finest = fold.snapshot('most').levels[0]!;
  expect([finest.step, finest.power]).toStrictEqual([2, 0]);
  expect(edgeOf(finest, finest.rows.length)).toBe(1000);
  expect(finest.above).toBe(3);
});
