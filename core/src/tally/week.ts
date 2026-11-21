/**
 * @fileoverview A date column's rows counted per hour of the week, Sunday
 * first.
 */

import { readDate } from '@date';
import type { Order, UnixUnit } from '@date';

import { undate } from './time.ts';
import type { Undated } from './time.ts';

const HOUR_MINUTES = 60;
export const DAY_HOURS = 24;
export const WEEK_DAYS = 7;
const DAY_MINUTES = DAY_HOURS * HOUR_MINUTES;

/** The hours of a week, each a cell of a week heatmap. */
export const WEEK_HOURS = WEEK_DAYS * DAY_HOURS;

/** 1970-01-01 was a Thursday, 4 days after Sunday. */
const THURSDAY = 4;

/** mod is `n` modulo `m`, never below zero, for the days before 1970. */
function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/** The hour of the week `minute` falls in: its weekday from Sunday, by 24, and its hour. */
function hourOfWeek(minute: number): number {
  const day = Math.floor(minute / DAY_MINUTES);
  const hour = Math.floor(mod(minute, DAY_MINUTES) / HOUR_MINUTES);
  return mod(day + THURSDAY, WEEK_DAYS) * DAY_HOURS + hour;
}

/** What a snapshot sends. */
export interface Week {
  /** Each hour of the week's rows, Sunday 00:00 first. */
  hours: Array<{ rows: number }>;
  /** Rows whose date cell was blank or not a date. */
  undated: { rows: number };
  dates: Undated;
}

/**
 * WeekFold counts a date column's rows per hour of the week. Rows are added
 * and taken back one at a time, so an edit moves a fold by the row it
 * changed. A week has WEEK_HOURS hours, so it never coarsens. A row whose
 * date does not read with the fold's reading is counted as undated, as a time
 * fold counts it.
 */
export class WeekFold {
  /** How date cells read: by an order, or as Unix time. */
  readonly reading: Order | UnixUnit;
  private readonly hours = Array.from({ length: WEEK_HOURS }, () => 0);
  private undated = 0;
  private readonly dates: Undated = { blank: 0, unparsed: 0, other: 0 };

  constructor(reading: Order | UnixUnit) {
    this.reading = reading;
  }

  /** add counts a row dated `date`. */
  add(date: string): void {
    this.count(date, 1);
  }

  /** remove takes back a row that add counted. */
  remove(date: string): void {
    this.count(date, -1);
  }

  /** snapshot is what the fold holds, as plain numbers. */
  snapshot(): Week {
    return {
      hours: this.hours.map((rows) => ({ rows })),
      undated: { rows: this.undated },
      dates: { ...this.dates },
    };
  }

  /** count adds a row dated `date`, or takes one back when `sign` is -1. */
  private count(date: string, sign: 1 | -1): void {
    const minute = readDate(date, this.reading);
    if (minute === undefined) {
      undate(this.dates, date, this.reading, sign);
      this.undated += sign;
      return;
    }
    this.hours[hourOfWeek(minute)]! += sign;
  }
}
