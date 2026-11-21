/**
 * @fileoverview A date column's rows counted, or another column summed, per
 * value of a text column and per period, every value at one period held.
 */

import { readDate } from '@date';
import type { Order, UnixUnit } from '@date';
import type { Mark } from '@num';
import { Count, DISTINCT_AT_MOST, counted } from './groups.ts';
import type { Skipped } from './skipped.ts';
import { PAIRS_AT_MOST } from './split.ts';
import { COARSER, HELD, keyAt, undate } from './time.ts';
import type { Held, Period, Undated } from './time.ts';

/** One value's rows per period held, undated, and past the bound at years. */
class Group {
  readonly periods = new Map<number, Count>();
  readonly undated = new Count();
  readonly unsplit = new Count();
}

/** One value, read: its periods earliest first, its undated rows, and its rows past the bound. */
export interface ValuePeriods {
  value: string;
  periods: Period[];
  undated: { rows: number; sum: number };
  unsplit: { rows: number; sum: number };
}

/** What a fold holds, read: its period, its values as they began, the rest, and what it left out. */
export interface TimeSplits {
  held: Held;
  values: ValuePeriods[];
  rest: { rows: number; sum: number };
  dates: Undated;
  skipped: Skipped;
}

/** plain is a count's rows and sum as plain numbers. */
const plain = ({ rows, sum }: Count) => ({ rows, sum: sum.value() });

/**
 * TimeSplitFold counts a date column's rows per value of a text column and
 * per period, as TimeFold reads its dates, and when it sums, adds up their
 * cells in another column. An edit moves it by the row it changed. Values
 * past GroupsFold's bound count in the rest. Past PAIRS_AT_MOST cells, every
 * value merges into the next coarser period together, as TimeFold does, so
 * every count stays exact in any block order. At years, a new cell past the
 * bound counts in its value's unsplit rows, as SplitFold counts a pair.
 */
export class TimeSplitFold {
  readonly reading: Order | UnixUnit;
  readonly mark: Mark | undefined;
  /** HELD's place of the period every group holds, and how many cells they hold. */
  private level = 0;
  private cells = 0;
  private readonly groups = new Map<string, Group>();
  private readonly rest = new Count();
  private readonly dates: Undated = { blank: 0, unparsed: 0, other: 0 };
  private readonly skipped: Skipped = { blank: 0, unparsed: 0 };

  /** A fold that sums reads its cells with `mark`; one with none counts rows. */
  constructor(reading: Order | UnixUnit, mark?: Mark) {
    this.reading = reading;
    this.mark = mark;
  }

  /** add counts a row of `value` dated `date`, whose summed cell is `cell`. */
  add(value: string, date: string, cell = ''): void {
    let group = this.groups.get(value);
    const room = this.groups.size < DISTINCT_AT_MOST && this.rest.rows === 0;
    if (group === undefined && room) {
      group = new Group();
      this.groups.set(value, group);
    }
    this.count(group, date, cell, 1);
  }

  /** remove takes back a row that add counted, and any place it emptied. */
  remove(value: string, date: string, cell = ''): void {
    const group = this.groups.get(value);
    this.count(group, date, cell, -1);
    const empty = group?.periods.size === 0 && group.undated.rows === 0;
    if (empty && group.unsplit.rows === 0) this.groups.delete(value);
  }

  /** read is what the fold holds, as plain numbers. */
  read(): TimeSplits {
    const values = [...this.groups].map(([value, g]) => ({
      value,
      periods: [...g.periods]
        .map(([key, c]) => ({ key, ...plain(c) }))
        .sort((a, b) => a.key - b.key),
      undated: plain(g.undated),
      unsplit: plain(g.unsplit),
    }));
    return {
      held: HELD[this.level]!,
      values,
      rest: plain(this.rest),
      dates: { ...this.dates },
      skipped: { ...this.skipped },
    };
  }

  /** count adds a row to `group`, or the rest where it has none, or takes one back when `sign` is -1. */
  private count(
    group: Group | undefined,
    date: string,
    cell: string,
    sign: 1 | -1,
  ): void {
    const minute = readDate(date, this.reading);
    if (minute === undefined) undate(this.dates, date, this.reading, sign);
    const to =
      group === undefined ? this.rest : this.placed(group, minute, sign);
    counted(to, cell, sign, this.mark, this.skipped);
    const key = minute === undefined ? undefined : keyAt(minute, this.level);
    if (to.rows === 0 && key !== undefined && group?.periods.get(key) === to) {
      group.periods.delete(key);
      this.cells--;
    }
    while (this.cells > PAIRS_AT_MOST && this.level < COARSER.length) {
      this.coarsen();
    }
  }

  /** placed is the count of `group` a row dated `minute` goes to, made for an add where it has none and the bound has room. */
  private placed(
    group: Group,
    minute: number | undefined,
    sign: 1 | -1,
  ): Count {
    if (minute === undefined) return group.undated;
    const key = keyAt(minute, this.level);
    const held = group.periods.get(key);
    if (held !== undefined || sign < 0) return held ?? group.unsplit;
    const full = this.cells >= PAIRS_AT_MOST && this.level === COARSER.length;
    if (full) return group.unsplit;
    const made = new Count();
    group.periods.set(key, made);
    this.cells++;
    return made;
  }

  /** coarsen merges every group's periods into the next coarser ones that hold them. */
  private coarsen(): void {
    const next = COARSER[this.level++]!;
    this.cells = 0;
    for (const group of this.groups.values()) {
      const finer = [...group.periods];
      group.periods.clear();
      for (const [key, count] of finer) {
        const into = group.periods.get(next(key));
        if (into === undefined) {
          group.periods.set(next(key), count);
          this.cells++;
          continue;
        }
        into.rows += count.rows;
        into.numbers += count.numbers;
        into.sum.merge(count.sum);
      }
    }
  }
}
