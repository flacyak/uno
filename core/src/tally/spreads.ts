/** @fileoverview A number column's spread per value of another, for a box plot of one by the other. */

import { compareStrings } from '@go';
import type { Mark } from '@num';

import { isMark, isRecord } from './saved.ts';
import { SpreadFold } from './spread.ts';
import type { Boxed, SavedSpread } from './spread.ts';
import type { Skipped } from './skipped.ts';

/** The most values a box plot by a column keeps a spread of; later values share Other's. */
export const BOX_VALUES_AT_MOST = 32;
/** The buckets each value's spread holds: 3 figures over most columns. */
export const SPREAD_VALUE_AT_MOST = 4_096;

/** One value's spread, as a snapshot sends it. */
export type ValueSpread = { value: string; spread: Boxed };

/** What a snapshot sends: the values kept, by median, and Other's spread where a row is in it. */
export type Spreads = { values: ValueSpread[]; rest?: Boxed };

/** SavedSpreads is every bit of a SpreadsFold: its mark, each value's spread in the order they began, and Other's. */
export interface SavedSpreads {
  mark: Mark;
  values: Array<[string, SavedSpread]>;
  rest: SavedSpread;
}

/**
 * SpreadsFold keeps a spread per value, as GroupsFold keeps a group: while
 * fewer than BOX_VALUES_AT_MOST have one and Other is empty, so a value's rows
 * are all in its spread or all in Other's. A spread an edit empties goes.
 */
export class SpreadsFold {
  /** The mark cells are read with. */
  readonly mark: Mark;
  private readonly values = new Map<string, SpreadFold>();
  private rest: SpreadFold;

  constructor(mark: Mark) {
    this.mark = mark;
    this.rest = new SpreadFold(mark, SPREAD_VALUE_AT_MOST);
  }

  /** add counts a row whose value is `value` and whose number cell is `cell`. */
  add(value: string, cell: string): void {
    let spread = this.values.get(value);
    const room = this.values.size < BOX_VALUES_AT_MOST;
    if (spread === undefined && room && this.rest.rows === 0) {
      spread = new SpreadFold(this.mark, SPREAD_VALUE_AT_MOST);
      this.values.set(value, spread);
    }
    (spread ?? this.rest).add(cell);
  }

  /** remove takes back a row that add counted. */
  remove(value: string, cell: string): void {
    const spread = this.values.get(value);
    (spread ?? this.rest).remove(cell);
    if (spread?.rows === 0) this.values.delete(value);
  }

  /** saved is what the fold holds, which `restored` reads back as it was. */
  saved(): SavedSpreads {
    const values = [...this.values].map(([v, fold]): [string, SavedSpread] => [
      v,
      fold.saved(),
    ]);
    return { mark: this.mark, values, rest: this.rest.saved() };
  }

  /**
   * restored is the fold `saved` holds, or undefined where it holds none: a
   * spread that is not one of its mark, a value twice or empty, or more than
   * BOX_VALUES_AT_MOST values.
   */
  static restored(saved: unknown): SpreadsFold | undefined {
    if (!isRecord(saved) || !isMark(saved['mark'])) return undefined;
    const { mark, values } = saved;
    const fold = new SpreadsFold(mark);
    const spreadOf = (s: unknown) => {
      const back = SpreadFold.restored(s, SPREAD_VALUE_AT_MOST);
      return back?.mark === mark ? back : undefined;
    };
    const rest = spreadOf(saved['rest']);
    if (rest === undefined || !Array.isArray(values)) return undefined;
    if (values.length > BOX_VALUES_AT_MOST) return undefined;
    for (const v of values as unknown[]) {
      const [value, spread]: unknown[] = Array.isArray(v) ? v : [];
      const back = spreadOf(spread);
      if (typeof value !== 'string' || fold.values.has(value)) return undefined;
      if (back === undefined || back.rows === 0) return undefined;
      fold.values.set(value, back);
    }
    fold.rest = rest;
    return fold;
  }

  /** skipped counts the number cells left out, of every value and Other. */
  skipped(): Skipped {
    const left = [...this.values.values(), this.rest].map(
      (s) => s.boxed().skipped,
    );
    const sum = (key: keyof Skipped) => left.reduce((n, s) => n + s[key], 0);
    return { blank: sum('blank'), unparsed: sum('unparsed') };
  }

  /** snapshot reads each value's spread, the highest median first, ties by value, and Other's. */
  snapshot(): Spreads {
    const values = [...this.values].map(([value, fold]) => ({
      value,
      spread: fold.boxed(),
    }));
    const median = (v: ValueSpread) =>
      v.spread.box?.five[2]![0] ?? Number.NEGATIVE_INFINITY;
    values.sort(
      (a, b) => median(b) - median(a) || compareStrings(a.value, b.value),
    );
    return this.rest.rows === 0
      ? { values }
      : { values, rest: this.rest.boxed() };
  }
}
