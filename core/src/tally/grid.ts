/**
 * @fileoverview A map's rows counted, or another column summed, per cell of
 * a fixed latitude and longitude quadtree, merged four into one past a bound.
 */

import { parse } from '@num';
import type { Mark } from '@num';

import { coarsen } from './coarsen.ts';
import { Count, counted } from './groups.ts';
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
  /** Each cell's sum, empty when the fold counts rows. */
  sum: number[];
  /** Rows the fold could not place, and their sum. */
  unplaced: { rows: number; sum: number };
  left: Unplaced;
  /** Cells of the summed column left out, none when counting rows. */
  skipped: Skipped;
}

/**
 * GridFold counts a map's rows per lat/lon cell, and when it sums, adds up
 * their cells in another column exactly. It merges each four into
 * their parent past CELLS_AT_MOST and never going back. A level's cells only
 * grow with rows, so the level held is the finest whose cells fit, however
 * rows arrive, and an edit, which takes its old row back first, moves a fold
 * by its one row.
 */
export class GridFold {
  readonly coords: Coords;
  /** The mark summed cells are read with; undefined when counting rows. */
  readonly mark: Mark | undefined;
  private level = LEVEL_FINEST;
  private readonly cells = new Map<number, Count>();
  private readonly unplaced = new Count();
  private readonly left: Unplaced = { blank: 0, unparsed: 0, outside: 0 };
  private readonly skipped: Skipped = { blank: 0, unparsed: 0 };

  /** A fold that sums reads its cells with `mark`; one with none counts rows. */
  constructor(coords: Coords, mark?: Mark) {
    this.coords = coords;
    this.mark = mark;
  }

  /** add counts a row at `lat` and `lon`, whose summed cell is `cell`. */
  add(lat: string, lon: string, cell = ''): void {
    this.count(lat, lon, cell, 1);
  }

  /** remove takes back a row add counted, and an empty cell with it. */
  remove(lat: string, lon: string, cell = ''): void {
    this.count(lat, lon, cell, -1);
  }

  /** read is what the fold holds, as plain numbers. */
  read(): Cells {
    const cells = [...this.cells].sort(([a], [b]) => a - b);
    return {
      level: this.level,
      keys: cells.map(([key]) => key),
      rows: cells.map(([, c]) => c.rows),
      sum: this.mark === undefined ? [] : cells.map(([, c]) => c.sum.value()),
      unplaced: { rows: this.unplaced.rows, sum: this.unplaced.sum.value() },
      left: { ...this.left },
      skipped: { ...this.skipped },
    };
  }

  private count(lat: string, lon: string, cell: string, sign: 1 | -1): void {
    const key = this.keyOf(lat, lon, sign);
    const to =
      key === undefined ? this.unplaced : (this.cells.get(key) ?? new Count());
    if (key !== undefined) this.cells.set(key, to);
    counted(to, cell, sign, this.mark, this.skipped);
    if (key !== undefined && to.rows === 0) this.cells.delete(key);
    while (this.cells.size > CELLS_AT_MOST) {
      const level = this.level--;
      coarsen(this.cells, (k) => parentOf(k, level));
    }
  }

  /**
   * keyOf is the key of the held cell a row at `lat` and `lon` goes to, or
   * undefined when it is placed in none, counted in `left` by why.
   */
  private keyOf(lat: string, lon: string, sign: 1 | -1): number | undefined {
    const y = parse(lat, this.coords.lat);
    const x = parse(lon, this.coords.lon);
    if (y === undefined || x === undefined) {
      this.left[lat === '' || lon === '' ? 'blank' : 'unparsed'] += sign;
    } else if (Math.abs(y) > LAT_AT_MOST || Math.abs(x) > LON_AT_MOST) {
      this.left.outside += sign;
    } else {
      return cellAt(y, x, this.level);
    }
    return undefined;
  }
}
