/**
 * @fileoverview A column's rows counted, or another column summed, per value.
 */

import { compareStrings } from '@go';
import { parse } from '@num';

import { ExactSum } from './exact.ts';

/** What a fold ranks its groups by: their rows, or the sum of their cells. */
export type Measure = 'rows' | 'sum';

/** One value's rows, and the sum of their cells. */
export interface Group {
  value: string;
  rows: number;
  /** 0 when the fold's measure is `rows`. */
  sum: number;
}

/** What a fold holds, read. */
export interface Groups {
  /** Every group, the largest first, ties in value order. */
  groups: Group[];
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
 */
export class GroupsFold {
  private readonly measure: Measure;
  private readonly groups = new Map<string, Count>();

  constructor(measure: Measure = 'rows') {
    this.measure = measure;
  }

  /** add counts a row of `value`, whose cell in the summed column is `cell`. */
  add(value: string, cell = ''): void {
    let group = this.groups.get(value);
    if (group === undefined) {
      group = new Count();
      this.groups.set(value, group);
    }
    this.count(group, cell, 1);
  }

  /** remove takes back a row that add counted, and an empty group with it. */
  remove(value: string, cell = ''): void {
    const group = this.groups.get(value)!;
    this.count(group, cell, -1);
    if (group.rows === 0) this.groups.delete(value);
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
    return { groups };
  }

  /** count adds a row to `to`, or takes one back when `sign` is -1. */
  private count(to: Count, cell: string, sign: 1 | -1): void {
    to.rows += sign;
    if (this.measure === 'rows') return;
    const x = parse(cell);
    if (x !== undefined) to.sum.add(sign * x);
  }
}
