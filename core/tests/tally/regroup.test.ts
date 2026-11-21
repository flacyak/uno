/**
 * @fileoverview GroupsFold.regroup merges every value one key names, rows
 * added and sums merged exactly, and keeps the values no key holds apart.
 */

import { expect, test } from 'vite-plus/test';

import { ExactSum, GroupsFold, UNKEYED_NAMED } from '@tally';

/** Each value as written, and the place it names, or none. */
const NAMES: Record<string, string | undefined> = {
  Germany: 'DE',
  DE: 'DE',
  Alemania: 'DE',
  France: 'FR',
  fr: 'FR',
  Atlantis: undefined,
  'N/A': undefined,
  Lemuria: undefined,
};
/** Amounts whose doubles sum differently by order. */
const AMOUNTS = ['1e16', '1', '-1e16', '0.1', '2.5'];
const ROWS = 200;

test('regrouped keys hold their values exactly, and unkeyed values keep their own', () => {
  const values = Object.keys(NAMES);
  const fold = new GroupsFold('sum', 'point');
  const exact = new Map<string, ExactSum>();
  const rows = new Map<string, number>();
  for (let r = 0; r < ROWS; r++) {
    const value = values[(r * r) % values.length]!;
    const cell = AMOUNTS[r % AMOUNTS.length]!;
    fold.add(value, cell);
    const key = NAMES[value] ?? `?${value}`;
    if (!exact.has(key)) exact.set(key, new ExactSum());
    exact.get(key)!.add(Number(cell));
    rows.set(key, (rows.get(key) ?? 0) + 1);
  }
  const { keys, unkeyed } = fold.regroup((v) => NAMES[v]);
  expect(keys).toEqual(
    ['DE', 'FR'].map((key) => ({
      key,
      rows: rows.get(key),
      sum: exact.get(key)!.value(),
    })),
  );
  const loose = values.filter(
    (v) => NAMES[v] === undefined && rows.has(`?${v}`),
  );
  expect(unkeyed.values).toBe(loose.length);
  expect(unkeyed.rows).toBe(loose.reduce((n, v) => n + rows.get(`?${v}`)!, 0));
  expect(unkeyed.top.map((g) => g.value).sort()).toEqual(loose.sort());
  expect(unkeyed.top.length).toBeLessThanOrEqual(UNKEYED_NAMED);
});

test('the largest unkeyed values are named first', () => {
  const fold = new GroupsFold();
  const counts = [9, 1, 7, 3, 5, 8, 2];
  counts.forEach((n, i) => {
    for (let r = 0; r < n; r++) fold.add(`v${i}`);
  });
  const { unkeyed } = fold.regroup(() => undefined);
  expect(unkeyed.top.map((g) => g.rows)).toEqual(
    [9, 8, 7, 5, 3].slice(0, UNKEYED_NAMED),
  );
  expect(unkeyed).toMatchObject({ values: counts.length, rows: 35 });
});
