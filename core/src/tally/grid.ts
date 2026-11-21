/**
 * @fileoverview A map's rows counted, or another column summed, per cell of
 * a fixed latitude and longitude quadtree, merged four into one past a bound.
 */

import { parse } from '@num';
import type { Mark } from '@num';

import { coarsen } from './coarsen.ts';
import type { SavedSum } from './exact.ts';
import { Count, counted } from './groups.ts';
import {
  LAT_AT_MOST,
  LEVEL_FINEST,
  LON_AT_MOST,
  cellAt,
  parentOf,
} from './quad.ts';
import { isCount, isMark, isRecord } from './saved.ts';
import { restoredSkipped } from './skipped.ts';
import type { Skipped } from './skipped.ts';
import { restoredCount } from './time.ts';

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

/** One cell as a save writes it: its key, its rows, and their sum when summed. */
type SavedCell = [number, number] | [number, number, SavedSum];

/**
 * SavedGrid is every bit of a GridFold, as a save writes it. Cells are in
 * ascending key order, so a fold saves the same bytes however its rows came.
 */
export interface SavedGrid {
  coords: Coords;
  mark?: Mark;
  level: number;
  cells: SavedCell[];
  unplaced: { rows: number; sum?: SavedSum };
  left: Unplaced;
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

  /** saved is what the fold holds, which `restored` reads back as it was. */
  saved(): SavedGrid {
    const summed = this.mark !== undefined;
    const { rows, sum } = this.unplaced;
    const cells = [...this.cells].sort(([a], [b]) => a - b);
    return {
      coords: { ...this.coords },
      mark: this.mark,
      level: this.level,
      cells: cells.map(([key, c]): SavedCell =>
        summed ? [key, c.rows, c.sum.saved()] : [key, c.rows],
      ),
      unplaced: summed ? { rows, sum: sum.saved() } : { rows },
      left: { ...this.left },
      skipped: { ...this.skipped },
    };
  }

  /**
   * restored is the fold `saved` holds, or undefined where it holds none: a
   * level past 0 to LEVEL_FINEST, more than CELLS_AT_MOST cells, a key out
   * of its level's range or out of order, or an empty cell.
   */
  static restored(saved: unknown): GridFold | undefined {
    if (!isRecord(saved) || !isRecord(saved['coords'])) return undefined;
    const { mark, level, cells, unplaced, left } = saved;
    const { lat, lon } = saved['coords'];
    const skipped = restoredSkipped(saved['skipped']);
    const unread = restoredSkipped(left);
    const outside = isRecord(left) ? left['outside'] : undefined;
    const fields =
      isMark(lat) &&
      isMark(lon) &&
      (mark === undefined || isMark(mark)) &&
      typeof level === 'number' &&
      Number.isInteger(level) &&
      level >= 0 &&
      level <= LEVEL_FINEST &&
      Array.isArray(cells) &&
      cells.length <= CELLS_AT_MOST &&
      isRecord(unplaced) &&
      unread !== undefined &&
      isCount(outside) &&
      skipped !== undefined;
    if (!fields) return undefined;
    const fold = new GridFold({ lat, lon }, mark);
    fold.level = level;
    // Level z holds 2^z rows of 2^(z+1) columns.
    const keys = 2 ** (2 * level + 1);
    let last = -1;
    for (const c of cells as unknown[]) {
      const [key, rows, sum]: unknown[] = Array.isArray(c) ? c : [];
      const count = restoredCount(rows, sum, mark);
      const ordered =
        typeof key === 'number' &&
        Number.isSafeInteger(key) &&
        key > last &&
        key < keys;
      if (!ordered || count === undefined || count.rows === 0) return undefined;
      fold.cells.set(key, count);
      last = key;
    }
    const count = restoredCount(unplaced['rows'], unplaced['sum'], mark);
    if (count === undefined) return undefined;
    Object.assign(fold.unplaced, count);
    Object.assign(fold.left, unread, { outside });
    Object.assign(fold.skipped, skipped);
    return fold;
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
