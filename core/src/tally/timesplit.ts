/**
 * @fileoverview A date column's rows counted, or another column summed, per
 * value of a text column and per period, every value at one period held.
 */

import { END_MINUTE, FIRST_MINUTE, readDate } from '@date';
import type { Order, UnixUnit } from '@date';
import type { Mark } from '@num';
import { coarsen } from './coarsen.ts';
import { ExactSum } from './exact.ts';
import type { SavedSum } from './exact.ts';
import { Count, DISTINCT_AT_MOST, counted } from './groups.ts';
import { isCount, isMark, isRecord } from './saved.ts';
import { restoredSkipped } from './skipped.ts';
import type { Skipped } from './skipped.ts';
import { PAIRS_AT_MOST } from './split.ts';
import {
  COARSER,
  HELD,
  LEVEL_BATCH,
  PER,
  isReading,
  keyAt,
  restoredCount,
  sizer,
  undate,
} from './time.ts';
import type { Held, Per, Period, Undated } from './time.ts';

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

/** A count as a save writes it: its rows, and their sum when summed. */
type SavedCount = { rows: number; sum?: SavedSum };

/** A period as a save writes it: its key, its rows, and their sum when summed. */
type SavedPeriod = [number, number] | [number, number, SavedSum];

/**
 * SavedTimeSplit is every bit of a TimeSplitFold, as a save writes it: how it
 * reads dates, the mark it sums with, the period it holds, each value's
 * periods, undated and unsplit rows in the order they began, the rest, and
 * what it left out.
 */
export interface SavedTimeSplit {
  reading: Order | UnixUnit;
  mark?: Mark;
  held: Held;
  groups: Array<{
    value: string;
    periods: SavedPeriod[];
    undated: SavedCount;
    unsplit: SavedCount;
  }>;
  rest: SavedCount;
  dates: Undated;
  skipped: Skipped;
}

/** How many values a snapshot sends, largest first: more than a heatmap or a horizon draws rows. */
export const SPLIT_VALUES_SENT = 16;

/** A value a snapshot sends: its rows and sum in all, its undated rows and its rows past the bound. */
export interface SentValue {
  value: string;
  rows: number;
  sum: number;
  undated: { rows: number; sum: number };
  unsplit: { rows: number; sum: number };
}

/** The values a chart draws, largest first, and the rows of the rest, with the values they hold. */
export interface Ranked {
  values: SentValue[];
  others: { values: number; rows: number; sum: number };
}

/** One size's periods for every value sent, dense from its first to its last, zeros included, at most LEVEL_BATCH of them. */
export interface SplitLevel {
  per: Per;
  /** The key of the size's first period, and how many periods it spans to its last. */
  from: number;
  span: number;
  /** Each value's rows per period, and its sums, empty when the fold counts rows, as values are sent. */
  rows: number[][];
  sum: number[][];
}

/** What a snapshot sends: the values a chart draws, each size from the one asked for, and what the fold left out. */
export interface TimeSplitSnapshot extends Ranked {
  levels: SplitLevel[];
  dates: Undated;
  skipped: Skipped;
}

/** The hours of a day, which a key held in hours past midnight is no whole number of. */
const HOURS_A_DAY = 24;

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

  /** saved is what the fold holds, which `restored` reads back as it was. */
  saved(): SavedTimeSplit {
    const summed = this.mark !== undefined;
    const count = (c: Count): SavedCount =>
      summed ? { rows: c.rows, sum: c.sum.saved() } : { rows: c.rows };
    const groups = [...this.groups].map(([value, g]) => ({
      value,
      periods: [...g.periods].map(([key, c]): SavedPeriod =>
        summed ? [key, c.rows, c.sum.saved()] : [key, c.rows],
      ),
      undated: count(g.undated),
      unsplit: count(g.unsplit),
    }));
    return {
      reading: this.reading,
      mark: this.mark,
      held: HELD[this.level]!,
      groups,
      rest: count(this.rest),
      dates: { ...this.dates },
      skipped: { ...this.skipped },
    };
  }

  /**
   * restored is the fold `saved` holds, or undefined where it holds none: a
   * field out of range, a value or a period twice, an empty period, one past
   * the years readDate reads, more values or cells than its bounds, or rows
   * unsplit below years.
   */
  static restored(saved: unknown): TimeSplitFold | undefined {
    if (!isRecord(saved) || !isRecord(saved['dates'])) return undefined;
    const { reading, mark, held, groups, rest } = saved;
    const level = HELD.findIndex((h) => h === held);
    const dates = restoredSkipped(saved['dates']);
    const other = saved['dates']['other'];
    const skipped = restoredSkipped(saved['skipped']);
    const fields =
      isReading(reading) &&
      (mark === undefined || isMark(mark)) &&
      level >= 0 &&
      isCount(other) &&
      dates !== undefined &&
      skipped !== undefined &&
      isRecord(rest) &&
      Array.isArray(groups) &&
      groups.length <= DISTINCT_AT_MOST;
    if (!fields) return undefined;
    const fold = new TimeSplitFold(reading, mark);
    fold.level = level;
    const [least, most] = [
      keyAt(FIRST_MINUTE, level),
      keyAt(END_MINUTE - 1, level),
    ];
    const years = level === COARSER.length;
    for (const g of groups as unknown[]) {
      const read = isRecord(g) ? fold.restoredGroup(g, least, most) : undefined;
      if (read === undefined || fold.groups.has(read[0])) return undefined;
      if (!years && read[1].unsplit.rows > 0) return undefined;
      fold.groups.set(...read);
    }
    const bound = years ? PAIRS_AT_MOST + 1 : PAIRS_AT_MOST;
    const counted = restoredCount(rest['rows'], rest['sum'], mark);
    if (counted === undefined || fold.cells > bound) return undefined;
    Object.assign(fold.rest, counted);
    Object.assign(fold.dates, dates, { other });
    Object.assign(fold.skipped, skipped);
    return fold;
  }

  /** restoredGroup is a value and its group as a save holds them, its keys from `least` to `most`, or undefined where it holds none. */
  private restoredGroup(
    g: Record<string, unknown>,
    least: number,
    most: number,
  ): [string, Group] | undefined {
    const { value, periods, undated, unsplit } = g;
    if (typeof value !== 'string' || !Array.isArray(periods)) return undefined;
    if (!isRecord(undated) || !isRecord(unsplit)) return undefined;
    const group = new Group();
    for (const p of periods as unknown[]) {
      const [key, rows, sum]: unknown[] = Array.isArray(p) ? p : [];
      const count = restoredCount(rows, sum, this.mark);
      const placed =
        Number.isSafeInteger(key) &&
        Number(key) >= least &&
        Number(key) <= most;
      if (!placed || count === undefined || count.rows === 0) return undefined;
      if (group.periods.has(Number(key))) return undefined;
      group.periods.set(Number(key), count);
      this.cells++;
    }
    const [none, past] = [undated, unsplit].map((c) =>
      restoredCount(c['rows'], c['sum'], this.mark),
    );
    if (none === undefined || past === undefined) return undefined;
    Object.assign(group.undated, none);
    Object.assign(group.unsplit, past);
    return [value, group];
  }

  /**
   * snapshot sends the values `ranked` gives, each at every size from `per`
   * to years made from the period held, every value from one first period,
   * so their columns line up. Automatic starts at hours where a row is dated
   * past midnight while hours are held, and at days otherwise.
   */
  snapshot(per: Per | 'auto'): TimeSplitSnapshot {
    const ranked = this.ranked();
    const groups = ranked.values.map(({ value }) => this.groups.get(value)!);
    const keys = groups.flatMap((g) => [...g.periods.keys()]);
    const timed = this.level === 0 && keys.some((k) => k % HOURS_A_DAY !== 0);
    const first = per !== 'auto' ? per : timed ? 'hour' : 'day';
    const levels = PER.slice(PER.indexOf(first)).flatMap((size) => {
      const keyOf = sizer(size, this.level);
      if (keyOf === undefined || keys.length === 0) return [];
      const sized = keys.map(keyOf);
      const from = Math.min(...sized);
      const span = Math.max(...sized) - from + 1;
      const length = Math.min(span, LEVEL_BATCH);
      const each = groups.map((g) => {
        const rows = Array.from({ length }, () => 0);
        const sums = Array.from({ length }, () => new ExactSum());
        for (const [key, c] of g.periods) {
          const i = keyOf(key) - from;
          if (i >= length) continue;
          rows[i] = rows[i]! + c.rows;
          sums[i]!.merge(c.sum);
        }
        return {
          rows,
          sum: this.mark === undefined ? [] : sums.map((s) => s.value()),
        };
      });
      const [rows, sum] = [each.map((e) => e.rows), each.map((e) => e.sum)];
      return [{ per: size, from, span, rows, sum }];
    });
    return {
      ...ranked,
      levels,
      dates: { ...this.dates },
      skipped: { ...this.skipped },
    };
  }

  /**
   * ranked gives the SPLIT_VALUES_SENT values of most rows, or of the largest
   * sum where the fold sums, ties in value order, and the rows and sum of the
   * values past them and the rest.
   */
  ranked(): Ranked {
    const summed = this.mark !== undefined;
    const totals = [...this.groups].map(([value, g]) => {
      const total = new Count();
      for (const c of [...g.periods.values(), g.undated, g.unsplit]) {
        total.rows += c.rows;
        total.sum.merge(c.sum);
      }
      const { rows, sum } = plain(total);
      return { value, g, total, rows, sum };
    });
    const size = (t: { rows: number; sum: number }) =>
      summed ? t.sum : t.rows;
    totals.sort((a, b) => size(b) - size(a) || (a.value < b.value ? -1 : 1));
    const left = new Count();
    for (const { total } of [
      ...totals.slice(SPLIT_VALUES_SENT),
      { total: this.rest },
    ]) {
      left.rows += total.rows;
      left.sum.merge(total.sum);
    }
    const values = totals
      .slice(0, SPLIT_VALUES_SENT)
      .map(({ value, g, rows, sum }) => ({
        value,
        rows,
        sum,
        undated: plain(g.undated),
        unsplit: plain(g.unsplit),
      }));
    const others = {
      values: Math.max(totals.length - SPLIT_VALUES_SENT, 0),
      ...plain(left),
    };
    return { values, others };
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
      this.coarsenGroups();
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

  /** coarsenGroups merges every group's periods into the next coarser ones that hold them. */
  private coarsenGroups(): void {
    const next = COARSER[this.level++]!;
    this.cells = 0;
    for (const group of this.groups.values()) {
      coarsen(group.periods, next);
      this.cells += group.periods.size;
    }
  }
}
