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
  const { buckets } = fold.read();
  const { span } = fold.snapshot().box!;
  const [low, high] = [span[0]![0], span[1]![0]];
  return { levels: levelsOf(buckets, low, high), low, high };
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
  expect(levelsOf([], 0, 0)).toStrictEqual([]);
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
