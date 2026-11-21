/**
 * @fileoverview GridFold counts rows, or sums a column, per cell of a fixed
 * lat/lon quadtree, merging four cells into their parent past CELLS_AT_MOST,
 * the same however its rows arrive, and moved by one row on an edit.
 */

import { expect, test } from 'vite-plus/test';

import { CELLS_AT_MOST, GridFold, LEVEL_FINEST } from '@tally';
import type { Coords } from '@tally';
import { seeded, shuffled } from '@core-tests/lab/cache/stats';

const POINT: Coords = { lat: 'point', lon: 'point' };
/** Rows spread over the world, enough to coarsen a fold several levels. */
const WORLD_ROWS = 40_000;
/** How many blocks the rows arrive in. */
const BLOCKS = 16;

type Row = [string, string, string];

/** Seeded rows anywhere on the world, with an amount whose doubles round by order. */
function world(seed: number): Row[] {
  const random = seeded(seed);
  const amounts = ['1e16', '1', '-1e16', '0.1', '2.5'];
  return Array.from({ length: WORLD_ROWS }, (_, i): Row => [
    String(random() * 180 - 90),
    String(random() * 360 - 180),
    amounts[i % amounts.length]!,
  ]);
}

const fold = (rows: readonly Row[]) => {
  const f = new GridFold(POINT);
  for (const [lat, lon] of rows) f.add(lat, lon);
  return f;
};

test('a fold is the same however its rows arrive', () => {
  const rows = world(1);
  const whole = fold(rows).read();
  const size = rows.length / BLOCKS;
  const blocks = Array.from({ length: BLOCKS }, (_, b) =>
    rows.slice(b * size, (b + 1) * size),
  );
  expect(fold(shuffled(blocks, seeded(3)).flat()).read()).toEqual(whole);
  expect(whole.keys.length).toBeLessThanOrEqual(CELLS_AT_MOST);
  expect(whole.level).toBeLessThan(LEVEL_FINEST);
});

test('an edit moves a fold by its one row', () => {
  const rows = world(5);
  const edited = fold(rows);
  const [lat, lon] = rows[7]!;
  edited.remove(lat, lon);
  edited.add('-33.8688', '151.2093');
  const before = fold(rows);
  const was = before.read();
  const now = edited.read();
  expect(now.level).toBe(was.level);
  const total = (c: typeof was) => c.rows.reduce((a, b) => a + b, 0);
  expect(total(now)).toBe(total(was));
  edited.remove('-33.8688', '151.2093');
  edited.add(lat, lon);
  expect(edited.read()).toEqual(was);
});

test('a row whose coordinates do not read is counted apart, by why', () => {
  const f = new GridFold({ lat: 'point', lon: 'comma' });
  for (const [lat, lon] of [
    ['40.7', '-74,0'],
    ['', '-74,0'],
    ['40.7', 'west'],
    ['91', '0'],
    ['0', '-180,5'],
  ] as const)
    f.add(lat, lon);
  const { keys, rows, left } = f.read();
  expect([keys.length, rows]).toEqual([1, [1]]);
  expect(left).toEqual({ blank: 1, unparsed: 1, outside: 2 });
});
