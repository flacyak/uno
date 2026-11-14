/**
 * @fileoverview A date column's rows counted, or another column summed, per
 * hour, or per day, month or year once there are too many hours to hold.
 */

import { EPOCH_YEAR, civilFromDays, readDate } from '@date';
import type { Order, UnixUnit } from '@date';
import type { Mark } from '@num';

import { Count, counted } from './groups.ts';
import type { Skipped } from './skipped.ts';

/** The periods a fold holds, finest first. Each merges exactly into the next. */
export const HELD = ['hour', 'day', 'month', 'year'] as const;
export type Held = (typeof HELD)[number];

/**
 * HELD_AT_MOST is how many periods a fold holds before it coarsens: about 341
 * days of hours, 22 years of days or 680 years of months. Years never
 * coarsen, and the years 0000 to 9999 are 10,000 at most.
 */
export const HELD_AT_MOST = 8_192;

const HOUR_MINUTES = 60;
const DAY_HOURS = 24;
const DAY_MINUTES = DAY_HOURS * HOUR_MINUTES;
const YEAR_MONTHS = 12;

/**
 * Each held period but the year, as the key of the next coarser one, by
 * HELD's place. A key counts its periods since 1970-01-01 00:00.
 */
const COARSER: ReadonlyArray<(key: number) => number> = [
  (hour) => Math.floor(hour / DAY_HOURS),
  (day) => {
    const { year, month } = civilFromDays(day);
    return (year - EPOCH_YEAR) * YEAR_MONTHS + month - 1;
  },
  (month) => Math.floor(month / YEAR_MONTHS),
];

/** The order a date written year last reads in when the fold's does not. */
const OTHER: Record<Order | UnixUnit, Order | undefined> = {
  day: 'month',
  month: 'day',
  s: undefined,
  ms: undefined,
};

/** Date cells a fold left out, and of those, how many read in the other order. */
export type Undated = Skipped & { other: number };

/** One held period: its key, its rows, and their sum, 0 when counting rows. */
export interface Period {
  key: number;
  rows: number;
  sum: number;
}

/** What a fold holds, read. */
export interface Periods {
  held: Held;
  /** The periods that hold a row, earliest first. */
  periods: Period[];
  /**
   * Rows dated past midnight, so a column of dates, or of date-times all at
   * 00:00, never offers hours.
   */
  timed: number;
  /** Rows whose date cell was blank or not a date, and their sum. */
  undated: { rows: number; sum: number };
  dates: Undated;
  /** Cells of the summed column, none when the fold counts rows. */
  skipped: Skipped;
}

/**
 * TimeFold counts a date column's rows per period, and when it sums, adds up
 * their cells in another column. Rows are added and taken back one at a
 * time, so an edit moves a fold by the row it changed. It holds hours while
 * there are at most HELD_AT_MOST of them, then merges them into days, months
 * and years as each passes the bound, so every count and sum stays exact. It
 * never goes back to a finer period. A row whose date does not read with the
 * fold's reading is counted as undated.
 */
export class TimeFold {
  /** How date cells read: by an order, or as Unix time. */
  readonly reading: Order | UnixUnit;
  /** The mark summed cells are read with; undefined when counting rows. */
  readonly mark: Mark | undefined;
  /** HELD's place of the period held. */
  private level = 0;
  private readonly periods = new Map<number, Count>();
  private timed = 0;
  private readonly undated = new Count();
  private readonly dates: Undated = { blank: 0, unparsed: 0, other: 0 };
  private readonly skipped: Skipped = { blank: 0, unparsed: 0 };

  /** A fold that sums reads its cells with `mark`; one with none counts rows. */
  constructor(reading: Order | UnixUnit, mark?: Mark) {
    this.reading = reading;
    this.mark = mark;
  }

  /** add counts a row dated `date`, whose cell in the summed column is `cell`. */
  add(date: string, cell = ''): void {
    this.count(date, cell, 1);
  }

  /** remove takes back a row that add counted, and an empty period with it. */
  remove(date: string, cell = ''): void {
    this.count(date, cell, -1);
  }

  /** read is what the fold holds, as plain numbers. */
  read(): Periods {
    const periods = [...this.periods]
      .map(([key, { rows, sum }]) => ({ key, rows, sum: sum.value() }))
      .sort((a, b) => a.key - b.key);
    const { rows, sum } = this.undated;
    return {
      held: HELD[this.level]!,
      periods,
      timed: this.timed,
      undated: { rows, sum: sum.value() },
      dates: { ...this.dates },
      skipped: { ...this.skipped },
    };
  }

  /** count adds a row dated `date`, or takes one back when `sign` is -1. */
  private count(date: string, cell: string, sign: 1 | -1): void {
    const minute = readDate(date, this.reading);
    if (minute === undefined) {
      this.undate(date, sign);
      counted(this.undated, cell, sign, this.mark, this.skipped);
      return;
    }
    if (minute % DAY_MINUTES !== 0) this.timed += sign;
    let key = Math.floor(minute / HOUR_MINUTES);
    for (let i = 0; i < this.level; i++) key = COARSER[i]!(key);
    let period = this.periods.get(key);
    if (period === undefined) {
      period = new Count();
      this.periods.set(key, period);
    }
    counted(period, cell, sign, this.mark, this.skipped);
    if (period.rows === 0) this.periods.delete(key);
    while (this.periods.size > HELD_AT_MOST && this.level < COARSER.length) {
      this.coarsen();
    }
  }

  /** undate counts a date cell left out, or takes one back. */
  private undate(date: string, sign: 1 | -1): void {
    if (date === '') {
      this.dates.blank += sign;
      return;
    }
    this.dates.unparsed += sign;
    const other = OTHER[this.reading];
    if (other !== undefined && readDate(date, other) !== undefined) {
      this.dates.other += sign;
    }
  }

  /** coarsen merges every period into the next coarser one that holds it. */
  private coarsen(): void {
    const finer = [...this.periods];
    const next = COARSER[this.level++]!;
    this.periods.clear();
    for (const [key, count] of finer) {
      const into = this.periods.get(next(key));
      if (into === undefined) {
        this.periods.set(next(key), count);
        continue;
      }
      into.rows += count.rows;
      into.sum.merge(count.sum);
    }
  }
}
