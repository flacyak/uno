/**
 * @fileoverview SpreadsFold against a SpreadFold of each value's cells alone.
 */

import { expect, test } from 'vite-plus/test';

import { SpreadFold } from '@tally/spread';
import {
  BOX_VALUES_AT_MOST,
  SPREAD_VALUE_AT_MOST,
  SpreadsFold,
} from '@tally/spreads';
import { seeded } from '@core-tests/lab/cache/stats';

const SEEDS = 50;
const ROWS = 400;
// More values than a fold keeps a spread of, so the later share Other.
const VALUES = BOX_VALUES_AT_MOST + 8;
const WHOLE_AT_MOST = 1_000;
const CELLS = ['', 'n/a', '-3', '0.5'];

type Row = [value: string, cell: string];

/** rowsOf is ROWS random rows, a value of VALUES and a cell, a number most often. */
function rowsOf(seed: number): Row[] {
  const random = seeded(seed);
  return Array.from({ length: ROWS }, (): Row => {
    const value = `v${Math.floor(random() * VALUES)}`;
    const odd = random() < 1 / 10;
    const cell = odd
      ? CELLS[Math.floor(random() * CELLS.length)]!
      : `${Math.floor(random() * WHOLE_AT_MOST)}`;
    return [value, cell];
  });
}

/** alone is a spread of `rows`' cells, as each value's in a SpreadsFold. */
function alone(rows: readonly Row[]): SpreadFold {
  const fold = new SpreadFold('point', SPREAD_VALUE_AT_MOST);
  for (const [, cell] of rows) fold.add(cell);
  return fold;
}

test("a spreads fold holds each of the first values' cells as a spread of their own, and the rest's as Other", () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rows = rowsOf(seed);
    const fold = new SpreadsFold('point');
    for (const [value, cell] of rows) fold.add(value, cell);
    const firsts = [...new Set(rows.map(([value]) => value))];
    const kept = firsts.slice(0, BOX_VALUES_AT_MOST);
    const { values, rest } = fold.snapshot();
    expect(values.map((v) => v.value).sort(), `seed ${seed}`).toStrictEqual(
      [...kept].sort(),
    );
    for (const { value, spread } of values) {
      const own = rows.filter(([v]) => v === value);
      expect(spread, `seed ${seed} ${value}`).toStrictEqual(alone(own).boxed());
    }
    const others = rows.filter(([v]) => !kept.includes(v));
    expect(rest).toStrictEqual(
      others.length > 0 ? alone(others).boxed() : undefined,
    );
  }
});

test('values stand by their medians, the highest first, ties by value', () => {
  const fold = new SpreadsFold('point');
  for (const [value, cell] of [
    ['b', '5'],
    ['a', '5'],
    ['c', '9'],
    ['c', '1'],
    ['d', '7'],
  ] as const) {
    fold.add(value, cell);
  }
  expect(fold.snapshot().values.map((v) => v.value)).toStrictEqual([
    'd',
    'a',
    'b',
    'c',
  ]);
});

test('a spreads fold an edit took rows back from holds the rest, each row in its value or Other, a value emptied gone', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rows = rowsOf(seed);
    const fold = new SpreadsFold('point');
    for (const row of rows) fold.add(...row);
    const random = seeded(seed + SEEDS);
    const kept = rows.filter(() => random() < 1 / 2);
    for (const row of rows.filter((r) => !kept.includes(r)))
      fold.remove(...row);
    const { values, rest } = fold.snapshot();
    const held = values.map((v) => v.value);
    for (const { value, spread } of values) {
      const own = kept.filter(([v]) => v === value);
      expect(own.length, `seed ${seed} ${value}`).toBeGreaterThan(0);
      expect(spread).toStrictEqual(alone(own).boxed());
    }
    const others = kept.filter(([v]) => !held.includes(v));
    expect(rest).toStrictEqual(
      others.length > 0 ? alone(others).boxed() : undefined,
    );
  }
});

test('a spreads fold counts the number cells left out, of every value and Other', () => {
  const fold = new SpreadsFold('point');
  for (const [value, cell] of [
    ['a', ''],
    ['b', 'n/a'],
    ['a', '3'],
    ['b', ''],
  ] as const)
    fold.add(value, cell);
  expect(fold.skipped()).toStrictEqual({ blank: 2, unparsed: 1 });
});
