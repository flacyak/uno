/**
 * @fileoverview A column's rows counted per value and per series.
 */

import { compareStrings, runes } from '@go';

import {
  Count,
  DISTINCT_AT_MOST,
  GROUPS_SENT,
  LABEL_AT_MOST,
} from './groups.ts';

/**
 * PAIRS_AT_MOST is how many cells, a value and a series together, a fold
 * keeps across all its values: 3,333 values at 6 series, about 7 MB of heap.
 */
export const PAIRS_AT_MOST = 20_000;

/** SERIES_AT_MOST is how many series a snapshot sends, the most a stack colours. */
export const SERIES_AT_MOST = 6;

/** Rows counted together, as a snapshot sends them. */
export interface Measured {
  rows: number;
}

/** One value's rows, split by series. */
export interface SplitValue {
  /** Cut to LABEL_AT_MOST code points when sent, so two can read the same. */
  value: string;
  /** One per sent series, in the snapshot's `series` order. */
  cells: Measured[];
  /** The rest of the value's rows: other series, and its unsplit rows. */
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
  /** The rows of values first seen past DISTINCT_AT_MOST. */
  rest: Measured;
  /** Rows a value counts apart from its series, past PAIRS_AT_MOST. */
  unsplit: number;
}

/** One value's cells per series, and its rows no cell holds. */
class Group {
  readonly cells = new Map<string, Count>();
  readonly unsplit = new Count();
}

/**
 * SplitFold counts a column's rows per value, and each value's rows per
 * series, the cell of a second column. Rows are added and taken back one at
 * a time, so an edit moves a fold by the row it changed.
 * A value gets a group as in GroupsFold, and other values count in the rest.
 * Inside a group, a series gets a cell while fewer than PAIRS_AT_MOST cells
 * exist and the group's unsplit is empty; other rows of the value count in
 * its unsplit. So a pair's rows are all in its cell or all in its unsplit.
 * Each series' total over the file follows GroupsFold's rule, so they rank
 * exactly past any pair.
 */
export class SplitFold {
  private readonly groups = new Map<string, Group>();
  private readonly rest = new Count();
  private readonly totals = new Map<string, Count>();
  private readonly totalsRest = new Count();
  private pairs = 0;

  /** add counts a row of `value` whose cell in the split column is `series`. */
  add(value: string, series: string): void {
    const fresh = roomIn(this.groups, this.rest);
    const group = placed(this.groups, value, fresh, () => new Group());
    if (group === undefined) this.rest.rows++;
    else {
      const room = this.pairs < PAIRS_AT_MOST && group.unsplit.rows === 0;
      const cell = placed(group.cells, series, room, () => new Count());
      // A cell made now has no rows, as an emptied one is deleted.
      if (cell?.rows === 0) this.pairs++;
      (cell ?? group.unsplit).rows++;
    }
    const named = roomIn(this.totals, this.totalsRest);
    const total = placed(this.totals, series, named, () => new Count());
    (total ?? this.totalsRest).rows++;
  }

  /** remove takes back a row that add counted, and any place it emptied. */
  remove(value: string, series: string): void {
    const group = this.groups.get(value);
    if (group === undefined) this.rest.rows--;
    else {
      if (taken(group.cells, series, group.unsplit)) this.pairs--;
      if (group.cells.size === 0 && group.unsplit.rows === 0)
        this.groups.delete(value);
    }
    taken(this.totals, series, this.totalsRest);
  }

  /** snapshot reads the fold as plain numbers and strings. */
  snapshot(): Split {
    const series = [...this.totals]
      .sort(([a, x], [b, y]) => y.rows - x.rows || compareStrings(a, b))
      .slice(0, SERIES_AT_MOST)
      .map(([name]) => name);
    let unsplit = 0;
    const values = [...this.groups].map(([value, group]) => {
      unsplit += group.unsplit.rows;
      const cells = series.map((s) => ({
        rows: group.cells.get(s)?.rows ?? 0,
      }));
      const rows = added([...group.cells.values(), group.unsplit]);
      const other = { rows: rows - added(cells) };
      return { value, cells, other, total: { rows } };
    });
    values.sort(
      (a, b) => b.total.rows - a.total.rows || compareStrings(a.value, b.value),
    );
    const unsent = values.splice(GROUPS_SENT);
    const rows = added(unsent.map((v) => v.total));
    return {
      series: series.map(label),
      values: values.map((v) => ({ ...v, value: label(v.value) })),
      others: { values: unsent.length, rows },
      rest: { rows: this.rest.rows },
      unsplit,
    };
  }
}

/** roomIn says whether a key first seen gets a place, by GroupsFold's rule. */
function roomIn(places: Map<string, unknown>, rest: Count): boolean {
  return places.size < DISTINCT_AT_MOST && rest.rows === 0;
}

/** placed is `key`'s place in `places`, made with `make` if it has none and room. */
function placed<T>(
  places: Map<string, T>,
  key: string,
  room: boolean,
  make: () => T,
): T | undefined {
  let place = places.get(key);
  if (place === undefined && room) {
    place = make();
    places.set(key, place);
  }
  return place;
}

/**
 * taken takes a row back from `key`'s count, or from `rest` where it has
 * none, and says whether it emptied and deleted the count.
 */
function taken(counts: Map<string, Count>, key: string, rest: Count): boolean {
  const count = counts.get(key) ?? rest;
  return --count.rows === 0 && count !== rest && counts.delete(key);
}

/** added is the rows of `counts` together. */
function added(counts: Measured[]): number {
  return counts.reduce((all, { rows }) => all + rows, 0);
}

/** label cuts a value to the LABEL_AT_MOST code points a snapshot sends. */
function label(value: string): string {
  return runes(value).slice(0, LABEL_AT_MOST).join('');
}
