/**
 * @fileoverview A column's rows counted per value.
 */

import { compareStrings } from '@go';

/** One value and its rows. */
export interface Group {
  value: string;
  rows: number;
}

/** What a fold holds, read. */
export interface Groups {
  /** Every group, the largest first, ties in value order. */
  groups: Group[];
}

/**
 * GroupsFold counts a column's rows per value. Rows are added and taken back
 * one at a time, so an edit moves a fold by the row it changed.
 */
export class GroupsFold {
  private readonly groups = new Map<string, number>();

  /** add counts a row of `value`. */
  add(value: string): void {
    this.groups.set(value, (this.groups.get(value) ?? 0) + 1);
  }

  /** remove takes back a row that add counted, and an empty group with it. */
  remove(value: string): void {
    const rows = this.groups.get(value)! - 1;
    if (rows === 0) this.groups.delete(value);
    else this.groups.set(value, rows);
  }

  /** snapshot reads the fold as plain numbers and strings. */
  snapshot(): Groups {
    const groups = [...this.groups].map(([value, rows]) => ({ value, rows }));
    groups.sort((a, b) => b.rows - a.rows || compareStrings(a.value, b.value));
    return { groups };
  }
}
