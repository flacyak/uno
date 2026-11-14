/**
 * @fileoverview A date column's rows counted per hour.
 */

import { readDate } from '@date';
import type { Order, UnixUnit } from '@date';

import { Count } from './groups.ts';

const HOUR_MINUTES = 60;

/** One held period: its key, and its rows. */
export interface Period {
  key: number;
  rows: number;
}

/** What a fold holds, read. */
export interface Periods {
  /** The periods that hold a row, earliest first. */
  periods: Period[];
  /** Rows whose date cell was blank or not a date. */
  undated: { rows: number };
}

/**
 * TimeFold counts a date column's rows per hour. Rows are added and taken
 * back one at a time, so an edit moves a fold by the row it changed. A key
 * counts its hours since 1970-01-01 00:00. A row whose date does not read
 * with the fold's reading is counted as undated.
 */
export class TimeFold {
  /** How date cells read: by an order, or as Unix time. */
  readonly reading: Order | UnixUnit;
  private readonly periods = new Map<number, Count>();
  private readonly undated = new Count();

  constructor(reading: Order | UnixUnit) {
    this.reading = reading;
  }

  /** add counts a row dated `date`. */
  add(date: string): void {
    this.count(date, 1);
  }

  /** remove takes back a row that add counted, and an empty period with it. */
  remove(date: string): void {
    this.count(date, -1);
  }

  /** read is what the fold holds, as plain numbers. */
  read(): Periods {
    const periods = [...this.periods]
      .map(([key, { rows }]) => ({ key, rows }))
      .sort((a, b) => a.key - b.key);
    return { periods, undated: { rows: this.undated.rows } };
  }

  /** count adds a row dated `date`, or takes one back when `sign` is -1. */
  private count(date: string, sign: 1 | -1): void {
    const minute = readDate(date, this.reading);
    if (minute === undefined) {
      this.undated.rows += sign;
      return;
    }
    const key = Math.floor(minute / HOUR_MINUTES);
    let period = this.periods.get(key);
    if (period === undefined) {
      period = new Count();
      this.periods.set(key, period);
    }
    period.rows += sign;
    if (period.rows === 0) this.periods.delete(key);
  }
}
