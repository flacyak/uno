/**
 * @fileoverview A column's rows counted per value and per series.
 */

import { compareStrings } from '@go';

import { Count, GROUPS_SENT } from './groups.ts';

/** SERIES_AT_MOST is how many series a snapshot sends, the most a stack colours. */
export const SERIES_AT_MOST = 6;

/** Rows counted together, as a snapshot sends them. */
export interface Measured {
  rows: number;
}

/** One value's rows, split by series. */
export interface SplitValue {
  value: string;
  /** One per sent series, in the snapshot's `series` order. */
  cells: Measured[];
  /** The rest of the value's rows, in series not sent. */
  other: Measured;
  total: Measured;
}

/** What a fold holds, read. */
export interface Split {
  /** At most SERIES_AT_MOST series, the largest over the whole file first. */
  series: string[];
  /** At most GROUPS_SENT values, the largest first, ties in value order. */
  values: SplitValue[];
  /** The values not sent, read as one. */
  others: Measured & { values: number };
}

/**
 * SplitFold counts a column's rows per value, and each value's rows per
 * series, the cell of a second column. Rows are added and taken back one at
 * a time, so an edit moves a fold by the row it changed. It also counts each
 * series over the whole file, which ranks the series a snapshot sends.
 */
export class SplitFold {
  private readonly groups = new Map<string, Map<string, Count>>();
  private readonly totals = new Map<string, Count>();

  /** add counts a row of `value` whose cell in the split column is `series`. */
  add(value: string, series: string): void {
    const cells = placed(this.groups, value, () => new Map<string, Count>());
    placed(cells, series, () => new Count()).rows++;
    placed(this.totals, series, () => new Count()).rows++;
  }

  /** remove takes back a row that add counted, and any place it emptied. */
  remove(value: string, series: string): void {
    const cells = this.groups.get(value)!;
    for (const counts of [cells, this.totals]) {
      if (--counts.get(series)!.rows === 0) counts.delete(series);
    }
    if (cells.size === 0) this.groups.delete(value);
  }

  /** snapshot reads the fold as plain numbers and strings. */
  snapshot(): Split {
    const series = [...this.totals]
      .sort(([a, x], [b, y]) => y.rows - x.rows || compareStrings(a, b))
      .slice(0, SERIES_AT_MOST)
      .map(([name]) => name);
    const values = [...this.groups].map(([value, group]) => {
      const cells = series.map((s) => ({ rows: group.get(s)?.rows ?? 0 }));
      const rows = added([...group.values()]);
      const other = { rows: rows - added(cells) };
      return { value, cells, other, total: { rows } };
    });
    values.sort(
      (a, b) => b.total.rows - a.total.rows || compareStrings(a.value, b.value),
    );
    const unsent = values.splice(GROUPS_SENT);
    const rows = added(unsent.map((v) => v.total));
    return { series, values, others: { values: unsent.length, rows } };
  }
}

/** placed is `key`'s place in `places`, made with `make` when it has none. */
function placed<T>(places: Map<string, T>, key: string, make: () => T): T {
  let place = places.get(key);
  if (place === undefined) {
    place = make();
    places.set(key, place);
  }
  return place;
}

/** added is the rows of `counts` together. */
function added(counts: Measured[]): number {
  return counts.reduce((all, { rows }) => all + rows, 0);
}
