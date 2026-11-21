/**
 * @fileoverview A map's rows counted per cell of a fixed latitude and
 * longitude quadtree, merged four into one past a bound.
 */

import { parse } from '@num';
import type { Mark } from '@num';

import { coarsen } from './coarsen.ts';
import { Count } from './groups.ts';
import {
  LAT_AT_MOST,
  LEVEL_FINEST,
  LON_AT_MOST,
  cellAt,
  parentOf,
} from './quad.ts';
import type { Skipped } from './skipped.ts';

/** The most cells a fold holds before every four merge into one. */
export const CELLS_AT_MOST = 8_192;

/** How a map's coordinate columns read: each with its own decimal mark. */
export interface Coords {
  lat: Mark;
  lon: Mark;
}

/** Rows a fold could not place: a blank, not a number, out of range. */
export type Unplaced = Skipped & { outside: number };

/** What a fold holds, read: its level, and its cells by ascending key. */
export interface Cells {
  level: number;
  keys: number[];
  rows: number[];
  left: Unplaced;
}

/**
 * GridFold counts a map's rows per lat/lon cell, merging each four into
 * their parent past CELLS_AT_MOST and never going back. A level's cells only
 * grow with rows, so the level held is the finest whose cells fit, however
 * rows arrive, and an edit, which takes its old row back first, moves a fold
 * by its one row.
 */
export class GridFold {
  readonly coords: Coords;
  private level = LEVEL_FINEST;
  private readonly cells = new Map<number, Count>();
  private readonly left: Unplaced = { blank: 0, unparsed: 0, outside: 0 };

  constructor(coords: Coords) {
    this.coords = coords;
  }

  /** add counts a row at `lat` and `lon`. */
  add(lat: string, lon: string): void {
    this.count(lat, lon, 1);
  }

  /** remove takes back a row add counted, and an empty cell with it. */
  remove(lat: string, lon: string): void {
    this.count(lat, lon, -1);
  }

  /** read is what the fold holds, as plain numbers. */
  read(): Cells {
    const cells = [...this.cells].sort(([a], [b]) => a - b);
    return {
      level: this.level,
      keys: cells.map(([key]) => key),
      rows: cells.map(([, c]) => c.rows),
      left: { ...this.left },
    };
  }

  private count(lat: string, lon: string, sign: 1 | -1): void {
    const y = parse(lat, this.coords.lat);
    const x = parse(lon, this.coords.lon);
    if (y === undefined || x === undefined) {
      this.left[lat === '' || lon === '' ? 'blank' : 'unparsed'] += sign;
    } else if (Math.abs(y) > LAT_AT_MOST || Math.abs(x) > LON_AT_MOST) {
      this.left.outside += sign;
    } else {
      const key = cellAt(y, x, this.level);
      const held = this.cells.get(key) ?? new Count();
      this.cells.set(key, held);
      held.rows += sign;
      if (held.rows === 0) this.cells.delete(key);
    }
    while (this.cells.size > CELLS_AT_MOST) {
      const level = this.level--;
      coarsen(this.cells, (k) => parentOf(k, level));
    }
  }
}
