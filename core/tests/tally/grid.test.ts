/**
 * @fileoverview GridFold counts rows, or sums a column, per cell of a fixed
 * lat/lon quadtree, merging four cells into their parent past CELLS_AT_MOST,
 * the same however its rows arrive, and moved by one row on an edit.
 */

import { describe, expect, test } from 'vite-plus/test';

import {
  CELLS_AT_MOST,
  CELLS_SENT_READING,
  ExactSum,
  GridFold,
  LEVEL_FINEST,
  cellAt,
} from '@tally';
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

const fold = (rows: readonly Row[], summed: boolean) => {
  const f = new GridFold(POINT, summed ? 'point' : undefined);
  for (const [lat, lon, cell] of rows) f.add(lat, lon, cell);
  return f;
};

describe('a fold is the same however its rows arrive', () => {
  for (const summed of [false, true])
    test(summed ? 'summed' : 'counted', () => {
      const rows = world(1);
      const whole = fold(rows, summed).read();
      const size = rows.length / BLOCKS;
      const blocks = Array.from({ length: BLOCKS }, (_, b) =>
        rows.slice(b * size, (b + 1) * size),
      );
      const byBlock = fold(shuffled(blocks, seeded(3)).flat(), summed);
      expect(byBlock.read()).toEqual(whole);
      expect(whole.keys.length).toBeLessThanOrEqual(CELLS_AT_MOST);
      expect(whole.level).toBeLessThan(LEVEL_FINEST);
    });
});

test('a summed cell is exact, whatever order its doubles came in', () => {
  const rows = world(4);
  const { level, keys, sum } = fold(rows, true).read();
  const exact = new Map<number, ExactSum>();
  for (const [lat, lon, cell] of rows) {
    const key = cellAt(Number(lat), Number(lon), level);
    if (!exact.has(key)) exact.set(key, new ExactSum());
    exact.get(key)!.add(Number(cell));
  }
  expect(sum).toEqual(keys.map((k) => exact.get(k)!.value()));
});

test('a fold read at fewer cells merges them up a level at a time, exactly, and keeps its own', () => {
  const rows = world(6);
  const held = fold(rows, true);
  const was = held.read();
  const { level, keys, rows: counts, sum } = held.read(CELLS_SENT_READING);
  expect(keys.length).toBeLessThanOrEqual(CELLS_SENT_READING);
  expect(level).toBe(was.level - 1);
  const exact = new Map<number, [number, ExactSum]>();
  for (const [lat, lon, cell] of rows) {
    const key = cellAt(Number(lat), Number(lon), level);
    const [n, s] = exact.get(key) ?? [0, new ExactSum()];
    s.add(Number(cell));
    exact.set(key, [n + 1, s]);
  }
  expect([...keys]).toEqual([...exact.keys()].sort((a, b) => a - b));
  expect(counts).toEqual(keys.map((k) => exact.get(k)![0]));
  expect(sum).toEqual(keys.map((k) => exact.get(k)![1].value()));
  expect(held.read()).toEqual(was);
});

test('an edit moves a fold by its one row', () => {
  const rows = world(5);
  const edited = fold(rows, true);
  const [lat, lon, cell] = rows[7]!;
  edited.remove(lat, lon, cell);
  edited.add('-33.8688', '151.2093', '12');
  const before = fold(rows, true);
  const was = before.read();
  const now = edited.read();
  expect(now.level).toBe(was.level);
  const total = (c: typeof was) => c.rows.reduce((a, b) => a + b, 0);
  expect(total(now)).toBe(total(was));
  edited.remove('-33.8688', '151.2093', '12');
  edited.add(lat, lon, cell);
  expect(edited.read()).toEqual(was);
});

test('a row whose coordinates do not read is counted apart, by why', () => {
  const f = new GridFold({ lat: 'point', lon: 'comma' }, 'point');
  f.add('40.7', '-74,0', '1');
  f.add('', '-74,0', '2');
  f.add('40.7', 'west', '3');
  f.add('91', '0', '4');
  f.add('0', '-180,5', 'x');
  const { keys, rows, unplaced, left, skipped } = f.read();
  expect([keys.length, rows]).toEqual([1, [1]]);
  expect(unplaced).toEqual({ rows: 4, sum: 9 });
  expect(left).toEqual({ blank: 1, unparsed: 1, outside: 2 });
  expect(skipped).toEqual({ blank: 0, unparsed: 1 });
});
