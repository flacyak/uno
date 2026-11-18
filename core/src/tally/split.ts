/**
 * @fileoverview A column's rows counted, or another column summed, per value
 * and per series.
 */

import { compareStrings, runes } from '@go';
import type { Mark } from '@num';
import { parse } from '@num';

import {
  Count,
  DISTINCT_AT_MOST,
  GROUPS_SENT,
  LABEL_AT_MOST,
} from './groups.ts';
import type { SavedSum } from './exact.ts';
import type { Skipped } from './skipped.ts';

/**
 * PAIRS_AT_MOST is how many cells, a value and a series together, a fold
 * keeps across all its values: 3,333 values at 6 series, about 7 MB of heap.
 */
export const PAIRS_AT_MOST = 20_000;

/** SERIES_AT_MOST is how many series a snapshot sends, the most a stack colours. */
export const SERIES_AT_MOST = 6;

/** Rows counted together, and their sum, 0 when counting rows. */
export interface Measured {
  rows: number;
  sum: number;
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
  /**
   * At most SERIES_AT_MOST series, the largest over the whole file first,
   * by size either side of zero, since a stack draws a negative sum leftward.
   */
  series: string[];
  /** At most GROUPS_SENT values, the largest first, ties in value order. */
  values: SplitValue[];
  /** The values not sent that measure more than zero, read as one. */
  others: Measured & { values: number };
  /** The values not sent that measure zero or less, which a stack draws left. */
  below: Measured & { values: number };
  /** The rows of values first seen past DISTINCT_AT_MOST. */
  rest: Measured;
  /** Rows a value counts apart from its series, past PAIRS_AT_MOST. */
  unsplit: number;
  /** Cells of the summed column, none when the fold counts rows. */
  skipped: Skipped;
}

/** One count as a save writes it: its rows, and their sum when summed. */
export interface SavedTally {
  rows: number;
  sum?: SavedSum;
}

/** One cell or series total as a save writes it, its series first. */
export type SavedCell =
  | [series: string, rows: number]
  | [series: string, rows: number, sum: SavedSum];

/**
 * SavedSplit is every bit of a SplitFold, as a save writes it: the mark it
 * sums with, none when it counts rows, its groups, cells and series totals
 * in the order they began, each rest, and the cells it left out.
 */
export interface SavedSplit {
  mark?: Mark;
  groups: Array<{ value: string; cells: SavedCell[]; unsplit: SavedTally }>;
  rest: SavedTally;
  totals: SavedCell[];
  totalsRest: SavedTally;
  skipped: Skipped;
}

/** One value's cells per series, and its rows no cell holds. */
class Group {
  readonly cells = new Map<string, Count>();
  readonly unsplit = new Count();
}

/**
 * SplitFold counts a column's rows per value, and each value's rows per
 * series, the cell of a second column. Rows are added and taken back one at
 * a time, so an edit moves a fold by the row it changed. When it sums, it
 * parses each row's cell in a third column once, for its cell and its total.
 * A value gets a group as in GroupsFold, and other values count in the rest.
 * Inside a group, a series gets a cell while fewer than PAIRS_AT_MOST cells
 * exist and the group's unsplit is empty; other rows of the value count in
 * its unsplit. So a pair's rows are all in its cell or all in its unsplit.
 * Each series' total over the file follows GroupsFold's rule, so they rank
 * exactly past any pair.
 */
export class SplitFold {
  /** The mark summed cells are read with; undefined when counting rows. */
  readonly mark: Mark | undefined;
  private readonly groups = new Map<string, Group>();
  private readonly rest = new Count();
  private readonly totals = new Map<string, Count>();
  private readonly totalsRest = new Count();
  private pairs = 0;
  private readonly skipped: Skipped = { blank: 0, unparsed: 0 };

  /** A fold that sums reads its cells with `mark`; one with none counts rows. */
  constructor(mark?: Mark) {
    this.mark = mark;
  }

  /** add counts a row of `value` in `series`, whose summed cell is `cell`. */
  add(value: string, series: string, cell = ''): void {
    const x = this.parsed(cell, 1);
    const fresh = roomIn(this.groups, this.rest);
    const group = placed(this.groups, value, fresh, () => new Group());
    if (group === undefined) tallied(this.rest, x, 1);
    else {
      const room = this.pairs < PAIRS_AT_MOST && group.unsplit.rows === 0;
      const held = placed(group.cells, series, room, () => new Count());
      // A cell made now has no rows, as an emptied one is deleted.
      if (held?.rows === 0) this.pairs++;
      tallied(held ?? group.unsplit, x, 1);
    }
    const named = roomIn(this.totals, this.totalsRest);
    const total = placed(this.totals, series, named, () => new Count());
    tallied(total ?? this.totalsRest, x, 1);
  }

  /** remove takes back a row that add counted, and any place it emptied. */
  remove(value: string, series: string, cell = ''): void {
    const x = this.parsed(cell, -1);
    const group = this.groups.get(value);
    if (group === undefined) tallied(this.rest, x, -1);
    else {
      if (taken(group.cells, series, group.unsplit, x)) this.pairs--;
      if (group.cells.size === 0 && group.unsplit.rows === 0)
        this.groups.delete(value);
    }
    taken(this.totals, series, this.totalsRest, x);
  }

  /** parsed is `cell` as a number where the fold sums, counting one left out. */
  private parsed(cell: string, sign: 1 | -1): number | undefined {
    if (this.mark === undefined) return undefined;
    const x = parse(cell, this.mark);
    if (x === undefined && cell === '') this.skipped.blank += sign;
    else if (x === undefined) this.skipped.unparsed += sign;
    return x;
  }

  /** saved is what the fold holds, which `restored` reads back as it was. */
  saved(): SavedSplit {
    const summed = this.mark !== undefined;
    const tally = ({ rows, sum }: Count): SavedTally =>
      summed ? { rows, sum: sum.saved() } : { rows };
    const cells = (held: Map<string, Count>) =>
      [...held].map(([series, c]): SavedCell =>
        summed ? [series, c.rows, c.sum.saved()] : [series, c.rows],
      );
    return {
      mark: this.mark,
      groups: [...this.groups].map(([value, group]) => ({
        value,
        cells: cells(group.cells),
        unsplit: tally(group.unsplit),
      })),
      rest: tally(this.rest),
      totals: cells(this.totals),
      totalsRest: tally(this.totalsRest),
      skipped: { ...this.skipped },
    };
  }

  /** snapshot reads the fold as plain numbers and strings. */
  snapshot(): Split {
    const size = (m: Measured) => (this.mark === undefined ? m.rows : m.sum);
    const series = [...this.totals]
      .map(([name, total]) => ({ name, size: Math.abs(size(measured(total))) }))
      .sort((a, b) => b.size - a.size || compareStrings(a.name, b.name))
      .slice(0, SERIES_AT_MOST)
      .map(({ name }) => name);
    const sent = new Set(series);
    let unsplit = 0;
    const values = [...this.groups].map(([value, group]) => {
      unsplit += group.unsplit.rows;
      const cells = series.map((s) => measured(group.cells.get(s)));
      const apart = [...group.cells].filter(([s]) => !sent.has(s));
      const other = merged([...apart.map(([, c]) => c), group.unsplit]);
      return { value, cells, other, total: merged(held(group)) };
    });
    values.sort(
      (a, b) =>
        size(b.total) - size(a.total) || compareStrings(a.value, b.value),
    );
    // The unsent values read as one, their sums merged and read once.
    const unsent = (vs: SplitValue[]) => ({
      values: vs.length,
      ...merged(vs.flatMap((v) => held(this.groups.get(v.value)!))),
    });
    const left = values.splice(GROUPS_SENT);
    return {
      series: series.map(label),
      values: values.map((v) => ({ ...v, value: label(v.value) })),
      others: unsent(left.filter((v) => size(v.total) > 0)),
      below: unsent(left.filter((v) => size(v.total) <= 0)),
      rest: measured(this.rest),
      unsplit,
      skipped: { ...this.skipped },
    };
  }
}

/** held is every count of a group's rows. */
function held(group: Group): Count[] {
  return [...group.cells.values(), group.unsplit];
}

/** measured is a count as plain numbers, or none where there is no count. */
function measured(count: Count | undefined): Measured {
  return { rows: count?.rows ?? 0, sum: count?.sum.value() ?? 0 };
}

/** merged reads counts as one, their sums merged and read once. */
function merged(counts: Count[]): Measured {
  const all = new Count();
  for (const { rows, sum } of counts) {
    all.rows += rows;
    all.sum.merge(sum);
  }
  return measured(all);
}

/** tallied adds a row to `to`, or takes one back, with `x` its number if any. */
function tallied(to: Count, x: number | undefined, sign: 1 | -1): void {
  to.rows += sign;
  if (x !== undefined) to.sum.add(sign * x);
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
 * taken takes a row back from `key`'s cell, or from `rest` where it has none,
 * and says whether it emptied and deleted the cell.
 */
function taken(
  cells: Map<string, Count>,
  key: string,
  rest: Count,
  x: number | undefined,
): boolean {
  const cell = cells.get(key) ?? rest;
  tallied(cell, x, -1);
  return cell.rows === 0 && cell !== rest && cells.delete(key);
}

/** label cuts a value to the LABEL_AT_MOST code points a snapshot sends. */
function label(value: string): string {
  return runes(value).slice(0, LABEL_AT_MOST).join('');
}
