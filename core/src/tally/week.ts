/**
 * @fileoverview A date column's rows counted, or another column summed, per
 * hour of the week, Sunday first.
 */

import { readDate } from '@date';
import type { Order, UnixUnit } from '@date';
import type { Mark } from '@num';

import type { SavedSum } from './exact.ts';
import { Count, counted } from './groups.ts';
import { isCount, isMark, isRecord } from './saved.ts';
import { restoredSkipped } from './skipped.ts';
import type { Skipped } from './skipped.ts';
import { isReading, restoredCount, undate } from './time.ts';
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
  /** Each hour of the week's rows and their sum, Sunday 00:00 first; sums 0 when counting rows. */
  hours: Array<{ rows: number; sum: number }>;
  /** Rows dated past midnight, so a column of dates offers weekdays alone. */
  timed: number;
  /** Rows whose date cell was blank or not a date, and their sum. */
  undated: { rows: number; sum: number };
  dates: Undated;
  /** Cells of the summed column, none when the fold counts rows. */
  skipped: Skipped;
}

/** One hour that holds a row, as a save writes it: its hour of the week, its rows, and their sum when summed. */
type SavedHour = [number, number] | [number, number, SavedSum];

/**
 * SavedWeek is every bit of a WeekFold, as a save writes it: how it reads
 * dates, the mark it sums with, none when it counts rows, its rows dated past
 * midnight, the hours that hold a row in the week's order, and what it left
 * out.
 */
export interface SavedWeek {
  reading: Order | UnixUnit;
  mark?: Mark;
  timed: number;
  hours: SavedHour[];
  undated: { rows: number; sum?: SavedSum };
  dates: Undated;
  skipped: Skipped;
}

/**
 * WeekFold counts a date column's rows per hour of the week, and when it
 * sums, adds up their cells in another column. Rows are added
 * and taken back one at a time, so an edit moves a fold by the row it
 * changed. A week has WEEK_HOURS hours, so it never coarsens. A row whose
 * date does not read with the fold's reading is counted as undated, as a time
 * fold counts it.
 */
export class WeekFold {
  /** How date cells read: by an order, or as Unix time. */
  readonly reading: Order | UnixUnit;
  /** The mark summed cells are read with; undefined when counting rows. */
  readonly mark: Mark | undefined;
  private readonly hours = Array.from(
    { length: WEEK_HOURS },
    () => new Count(),
  );
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

  /** remove takes back a row that add counted. */
  remove(date: string, cell = ''): void {
    this.count(date, cell, -1);
  }

  /** saved is what the fold holds, which `restored` reads back as it was. */
  saved(): SavedWeek {
    const summed = this.mark !== undefined;
    const { rows, sum } = this.undated;
    const hours = this.hours.flatMap((c, hour): SavedHour[] => {
      if (c.rows === 0) return [];
      return [summed ? [hour, c.rows, c.sum.saved()] : [hour, c.rows]];
    });
    return {
      reading: this.reading,
      mark: this.mark,
      timed: this.timed,
      hours,
      undated: summed ? { rows, sum: sum.saved() } : { rows },
      dates: { ...this.dates },
      skipped: { ...this.skipped },
    };
  }

  /**
   * restored is the fold `saved` holds, or undefined where it holds none: a
   * field out of range, or an hour past the week, empty, or not after the
   * hour before it.
   */
  static restored(saved: unknown): WeekFold | undefined {
    if (!isRecord(saved) || !isRecord(saved['dates'])) return undefined;
    const { reading, mark, timed, hours, undated } = saved;
    const dates = restoredSkipped(saved['dates']);
    const other = saved['dates']['other'];
    const skipped = restoredSkipped(saved['skipped']);
    const fields =
      isReading(reading) &&
      (mark === undefined || isMark(mark)) &&
      isCount(timed) &&
      isCount(other) &&
      dates !== undefined &&
      skipped !== undefined &&
      isRecord(undated) &&
      Array.isArray(hours);
    if (!fields) return undefined;
    const fold = new WeekFold(reading, mark);
    let last = -1;
    for (const h of hours as unknown[]) {
      const [hour, rows, sum]: unknown[] = Array.isArray(h) ? h : [];
      const count = restoredCount(rows, sum, mark);
      const placed = isCount(hour) && hour > last && hour < WEEK_HOURS;
      if (!placed || count === undefined || count.rows === 0) return undefined;
      fold.hours[hour] = count;
      last = hour;
    }
    const count = restoredCount(undated['rows'], undated['sum'], mark);
    if (count === undefined) return undefined;
    Object.assign(fold.undated, count);
    Object.assign(fold.dates, dates, { other });
    Object.assign(fold.skipped, skipped);
    fold.timed = timed;
    return fold;
  }

  /** snapshot is what the fold holds, as plain numbers. */
  snapshot(): Week {
    const { rows, sum } = this.undated;
    return {
      hours: this.hours.map((c) => ({ rows: c.rows, sum: c.sum.value() })),
      timed: this.timed,
      undated: { rows, sum: sum.value() },
      dates: { ...this.dates },
      skipped: { ...this.skipped },
    };
  }

  /** count adds a row dated `date`, or takes one back when `sign` is -1. */
  private count(date: string, cell: string, sign: 1 | -1): void {
    const minute = readDate(date, this.reading);
    const { mark, skipped } = this;
    if (minute === undefined) {
      undate(this.dates, date, this.reading, sign);
      counted(this.undated, cell, sign, mark, skipped);
      return;
    }
    if (mod(minute, DAY_MINUTES) !== 0) this.timed += sign;
    counted(this.hours[hourOfWeek(minute)]!, cell, sign, mark, skipped);
  }
}
