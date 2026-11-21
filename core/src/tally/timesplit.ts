/**
 * @fileoverview A date column's rows counted, or another column summed, per
 * value of a text column and per hour.
 */

import { readDate } from '@date';
import type { Order, UnixUnit } from '@date';
import type { Mark } from '@num';
import { Count, counted } from './groups.ts';
import type { Skipped } from './skipped.ts';
import { keyAt, undate } from './time.ts';
import type { Period, Undated } from './time.ts';

/** One value's rows per hour, and undated. */
class Group {
  readonly periods = new Map<number, Count>();
  readonly undated = new Count();
}

/** One value, read: its hours earliest first, and its undated rows. */
export interface ValuePeriods {
  value: string;
  periods: Period[];
  undated: { rows: number; sum: number };
}

/** What a fold holds, read: its values in the order they began, and what it left out. */
export interface TimeSplits {
  values: ValuePeriods[];
  dates: Undated;
  skipped: Skipped;
}

/** plain is a count's rows and sum as plain numbers. */
const plain = ({ rows, sum }: Count) => ({ rows, sum: sum.value() });

/**
 * TimeSplitFold counts a date column's rows per value of a text column and
 * per hour, as TimeFold reads its dates, and when it sums, adds up their cells
 * in another column. An edit moves it by the row it changed.
 */
export class TimeSplitFold {
  readonly reading: Order | UnixUnit;
  readonly mark: Mark | undefined;
  private readonly groups = new Map<string, Group>();
  private readonly dates: Undated = { blank: 0, unparsed: 0, other: 0 };
  private readonly skipped: Skipped = { blank: 0, unparsed: 0 };

  /** A fold that sums reads its cells with `mark`; one with none counts rows. */
  constructor(reading: Order | UnixUnit, mark?: Mark) {
    this.reading = reading;
    this.mark = mark;
  }

  /** add counts a row of `value` dated `date`, whose summed cell is `cell`. */
  add(value: string, date: string, cell = ''): void {
    const group = this.groups.get(value) ?? new Group();
    this.groups.set(value, group);
    this.count(group, date, cell, 1);
  }

  /** remove takes back a row that add counted, and any place it emptied. */
  remove(value: string, date: string, cell = ''): void {
    const group = this.groups.get(value);
    if (group === undefined) return;
    this.count(group, date, cell, -1);
    if (group.periods.size === 0 && group.undated.rows === 0)
      this.groups.delete(value);
  }

  /** read is what the fold holds, as plain numbers. */
  read(): TimeSplits {
    const values = [...this.groups].map(([value, g]) => ({
      value,
      periods: [...g.periods]
        .map(([key, c]) => ({ key, ...plain(c) }))
        .sort((a, b) => a.key - b.key),
      undated: plain(g.undated),
    }));
    return { values, dates: { ...this.dates }, skipped: { ...this.skipped } };
  }

  /** count adds a row to `group`'s hour or undated rows, or takes one back when `sign` is -1. */
  private count(group: Group, date: string, cell: string, sign: 1 | -1): void {
    const minute = readDate(date, this.reading);
    if (minute === undefined) undate(this.dates, date, this.reading, sign);
    const key = minute === undefined ? undefined : keyAt(minute, 0);
    const to =
      key === undefined
        ? group.undated
        : (group.periods.get(key) ?? new Count());
    if (key !== undefined) group.periods.set(key, to);
    counted(to, cell, sign, this.mark, this.skipped);
    if (to.rows === 0 && key !== undefined) group.periods.delete(key);
  }
}
