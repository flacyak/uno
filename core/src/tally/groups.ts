/**
 * @fileoverview A column's rows counted, or another column summed, per value.
 */

import { compareStrings, runes } from '@go';
import { parse } from '@num';

import { ExactSum } from './exact.ts';
import type { Skipped } from './skipped.ts';

/**
 * DISTINCT_AT_MOST is how many values a fold keeps a group for, far more than
 * a chart draws. A fold of short ids that reaches it holds about 3 MB.
 */
export const DISTINCT_AT_MOST = 10_000;
/** GROUPS_SENT is how many groups a snapshot sends, more than a chart shows. */
export const GROUPS_SENT = 50;
/**
 * LABEL_AT_MOST is how many code points of its value a sent group keeps, a
 * few lines of text. At 4 bytes a code point, GROUPS_SENT labels come to 50 KB
 * at most, however many values a column has and however long they are.
 */
export const LABEL_AT_MOST = 256;

/** What a fold ranks its groups by: their rows, or the sum of their cells. */
export type Measure = 'rows' | 'sum';

/** One value's rows, and the sum of their cells. */
export interface Group {
  /** Cut to LABEL_AT_MOST code points when sent, so two can read the same. */
  value: string;
  rows: number;
  /** 0 when the fold's measure is `rows`. */
  sum: number;
}

/** What a fold holds, read. */
export interface Groups {
  /** At most GROUPS_SENT groups, the largest first, ties in value order. */
  groups: Group[];
  /** The groups not sent that measure more than zero, read as one. */
  others: { values: number; rows: number; sum: number };
  /** The groups not sent that measure zero or less, which a pie leaves out. */
  below: { values: number; rows: number; sum: number };
  /** The rows of values first seen past DISTINCT_AT_MOST, and their sum. */
  rest: { rows: number; sum: number };
  /** Cells of the summed column, none when the fold's measure is `rows`. */
  skipped: Skipped;
}

/** Rows counted together, and their cells added exactly. */
class Count {
  rows = 0;
  readonly sum = new ExactSum();
}

/**
 * GroupsFold counts a column's rows per value. Rows are added and taken back
 * one at a time, so an edit moves a fold by the row it changed. When its
 * measure is `sum`, it also adds up each value's cells in another column.
 * A value gets a group while fewer than DISTINCT_AT_MOST have one and the
 * rest is empty. Any other value is counted in the rest, so a value's rows
 * are all in its group or all in the rest, and every count and sum is exact.
 * An edit takes back its old row first, so its new row can fill a freed place.
 */
export class GroupsFold {
  private readonly measure: Measure;
  private readonly groups = new Map<string, Count>();
  private readonly rest = new Count();
  private readonly skipped: Skipped = { blank: 0, unparsed: 0 };

  constructor(measure: Measure = 'rows') {
    this.measure = measure;
  }

  /** add counts a row of `value`, whose cell in the summed column is `cell`. */
  add(value: string, cell = ''): void {
    let group = this.groups.get(value);
    const room = this.groups.size < DISTINCT_AT_MOST;
    if (group === undefined && room && this.rest.rows === 0) {
      group = new Count();
      this.groups.set(value, group);
    }
    this.count(group ?? this.rest, cell, 1);
  }

  /** remove takes back a row that add counted, and an empty group with it. */
  remove(value: string, cell = ''): void {
    const group = this.groups.get(value);
    this.count(group ?? this.rest, cell, -1);
    if (group?.rows === 0) this.groups.delete(value);
  }

  /** snapshot reads the fold as plain numbers and strings. */
  snapshot(): Groups {
    const groups = [...this.groups].map(([value, { rows, sum }]) => ({
      value,
      rows,
      sum: sum.value(),
    }));
    const size = (g: Group) => g[this.measure];
    // Two infinite sums differ by NaN, a tie, which goes to value order too.
    groups.sort(
      (a, b) => size(b) - size(a) || compareStrings(a.value, b.value),
    );
    const unsent = groups.splice(GROUPS_SENT);
    return {
      groups: groups.map((g) => ({
        ...g,
        value: runes(g.value).slice(0, LABEL_AT_MOST).join(''),
      })),
      others: this.merged(unsent.filter((g) => size(g) > 0)),
      below: this.merged(unsent.filter((g) => size(g) <= 0)),
      rest: { rows: this.rest.rows, sum: this.rest.sum.value() },
      skipped: { ...this.skipped },
    };
  }

  /** merged reads groups as one, their sums merged and read once. */
  private merged(unsent: Group[]): Groups['others'] {
    const all = new Count();
    for (const { value } of unsent) {
      const { rows, sum } = this.groups.get(value)!;
      all.rows += rows;
      all.sum.merge(sum);
    }
    return { values: unsent.length, rows: all.rows, sum: all.sum.value() };
  }

  /** count adds a row to `to`, or takes one back when `sign` is -1. */
  private count(to: Count, cell: string, sign: 1 | -1): void {
    to.rows += sign;
    if (this.measure === 'rows') return;
    const x = parse(cell);
    if (x !== undefined) to.sum.add(sign * x);
    else if (cell === '') this.skipped.blank += sign;
    else this.skipped.unparsed += sign;
  }
}
