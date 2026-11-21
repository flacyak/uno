/**
 * @fileoverview The lat/lon quadtree a map's fold counts in: a point's cell
 * at one level lies in its cell's parent at every level, and the edges of
 * the world land where the spatial design says.
 */

import { expect, test } from 'vite-plus/test';

import { LEVEL_FINEST, cellAt, parentOf } from '@tally';
import { seeded } from '@core-tests/lab/cache/stats';

/** Random points tried at every level. */
const POINTS = 1_000;

test('a parent is its child shifted, at every level', () => {
  const random = seeded(2);
  for (let i = 0; i < POINTS; i++) {
    const lat = random() * 180 - 90;
    const lon = random() * 360 - 180;
    for (let z = LEVEL_FINEST; z > 0; z--)
      expect(parentOf(cellAt(lat, lon, z), z)).toBe(cellAt(lat, lon, z - 1));
  }
});

test('latitude 90 is in the top row, and longitude 180 is the column of -180', () => {
  const z = LEVEL_FINEST;
  const columns = 2 ** (z + 1);
  expect(Math.floor(cellAt(90, 0, z) / columns)).toBe(2 ** z - 1);
  expect(Math.floor(cellAt(-90, 0, z) / columns)).toBe(0);
  expect(cellAt(10, 180, z)).toBe(cellAt(10, -180, z));
});
