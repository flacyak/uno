/**
 * @fileoverview A column's rows counted, or another column summed, per value.
 */

import { compareStrings, runes } from '@go';
import type { Mark } from '@num';
import { parse } from '@num';

import { ExactSum } from './exact.ts';
import type { SavedSum } from './exact.ts';
import { isCount, isMark, isRecord } from './saved.ts';
import { restoredSkipped } from './skipped.ts';
import type { Skipped } from './skipped.ts';

/**
 * DISTINCT_AT_MOST is how many values a fold keeps a group for, far more than
 * a chart draws. A fold of short ids that reaches it holds about 3 MB.
 */
export const DISTINCT_AT_MOST = 10_000;
/** GROUPS_SENT is how many groups a snapshot sends, more than a chart shows. */
export const GROUPS_SENT = 50;
/**
 * LABEL_AT_MOST is how many code points of its value a sent group keeps, a
 * few lines of text. At 4 bytes a code point, GROUPS_SENT labels come to 50 KB
 * at most, however many values a column has and however long they are.
 */
export const LABEL_AT_MOST = 256;

/** label cuts a value to the LABEL_AT_MOST code points a snapshot sends. */
export function label(value: string): string {
  return runes(value).slice(0, LABEL_AT_MOST).join('');
}

/**
 * movedFirst gives `ranked` with the values a person moved first, in the
 * order of `moved`, each found by the label a snapshot sends it under, and
 * the rest after them as they ranked. A moved value the fold holds no group
 * of is passed over.
 */
export function movedFirst<T extends { value: string }>(
  ranked: readonly T[],
  moved: readonly string[],
): T[] {
  const at = new Map(moved.map((value, i) => [value, i]));
  const placed = ranked.map((g) => ({ g, at: at.get(label(g.value)) }));
  const first = placed.flatMap(({ g, at }) =>
    at === undefined ? [] : [{ g, at }],
  );
  first.sort((a, b) => a.at - b.at);
  return [
    ...first.map(({ g }) => g),
    ...ranked.filter((g) => !at.has(label(g.value))),
  ];
}

/**
 * What a fold ranks its groups by: their rows, the sum of their cells, or
 * their mean, the sum over the cells that read as numbers.
 */
export type Measure = 'rows' | 'sum' | 'mean';

/** One value's rows, and the sum of their cells. */
export interface Group {
  /** Cut to LABEL_AT_MOST code points when sent, so two can read the same. */
  value: string;
  rows: number;
  /** 0 when the fold's measure is `rows`. */
  sum: number;
}

/** How many values regroup names of those it could give no key, the largest. */
export const UNKEYED_NAMED = 5;

/** A fold's groups merged by a key, as `regroup` reads them. */
export interface Regrouped {
  /** Every key with rows, ascending, with its rows and their sum. */
  keys: Array<{ key: string; rows: number; sum: number }>;
  /** The values given no key: how many, their rows and sum, the largest named. */
  unkeyed: { values: number; rows: number; sum: number; top: Group[] };
  rest: { rows: number; sum: number };
  skipped: Skipped;
}

/** One value's group of a mean fold: its cells that read as numbers too. */
export interface MeanGroup extends Group {
  numbers: number;
}

/** What a fold holds, read. */
export interface Groups<G extends Group = Group> {
  /**
   * At most GROUPS_SENT groups, the largest first, ties in value order; of a
   * mean, the values with no number last.
   */
  groups: G[];
  /** The groups not sent that measure more than zero, read as one. */
  others: { values: number; rows: number; sum: number };
  /** The groups not sent that measure zero or less, which a pie leaves out. */
  below: { values: number; rows: number; sum: number };
  /** The rows of values first seen past DISTINCT_AT_MOST, and their sum. */
  rest: { rows: number; sum: number };
  /** Cells of the summed column, none when the fold's measure is `rows`. */
  skipped: Skipped;
}

/**
 * One group as a save writes it: its rows, their sum when summed, and its
 * cells that read as numbers for a mean.
 */
interface SavedCount {
  value: string;
  rows: number;
  sum?: SavedSum;
  numbers?: number;
}

/**
 * SavedGroups is every bit of a GroupsFold, as a save writes it: whether it
 * means, the mark it sums with, none when it counts rows, its groups in the
 * order they began, the rest's rows and sum, and the cells it left out.
 */
export interface SavedGroups {
  measure?: 'mean';
  mark?: Mark;
  groups: SavedCount[];
  rest: Omit<SavedCount, 'value'>;
  skipped: Skipped;
}

/**
 * Rows counted together, their cells added exactly, those read as numbers,
 * and the blank ones, which a split fold keeps per cell.
 */
export class Count {
  rows = 0;
  sum = new ExactSum();
  numbers = 0;
  blank = 0;
}

/**
 * counted adds a row to `to`, or takes one back when `sign` is -1, with its
 * cell read with `mark` where the fold sums. A cell left out is counted in
 * `skipped`.
 */
export function counted(
  to: Count,
  cell: string,
  sign: 1 | -1,
  mark: Mark | undefined,
  skipped: Skipped,
): void {
  to.rows += sign;
  if (mark === undefined) return;
  const x = parse(cell, mark);
  if (x !== undefined) {
    to.sum.add(sign * x);
    to.numbers += sign;
  } else if (cell === '') skipped.blank += sign;
  else skipped.unparsed += sign;
}

/**
 * GroupsFold counts a column's rows per value. Rows are added and taken back
 * one at a time, so an edit moves a fold by the row it changed. When its
 * measure is `sum`, it also adds up each value's cells in another column.
 * A value gets a group while fewer than DISTINCT_AT_MOST have one and the
 * rest is empty. Any other value is counted in the rest, so a value's rows
 * are all in its group or all in the rest, and every count and sum is exact.
 * An edit takes back its old row first, so its new row can fill a freed place.
 * A fold that sums reads the cells with the decimal mark of their column.
 * A fold that means sums them too, and counts each value's cells that read
 * as numbers, which `means` sends and its save keeps.
 */
export class GroupsFold {
  private readonly measure: Measure;
  /** The mark summed cells are read with; undefined when counting rows. */
  readonly mark: Mark | undefined;
  private readonly groups = new Map<string, Count>();
  private readonly rest = new Count();
  private readonly skipped: Skipped = { blank: 0, unparsed: 0 };

  constructor();
  constructor(measure: 'sum' | 'mean', mark: Mark);
  constructor(measure?: 'sum' | 'mean', mark?: Mark) {
    this.measure = measure ?? 'rows';
    this.mark = mark;
  }

  /** add counts a row of `value`, whose cell in the summed column is `cell`. */
  add(value: string, cell = ''): void {
    let group = this.groups.get(value);
    const room = this.groups.size < DISTINCT_AT_MOST;
    if (group === undefined && room && this.rest.rows === 0) {
      group = new Count();
      this.groups.set(value, group);
    }
    this.count(group ?? this.rest, cell, 1);
  }

  /** remove takes back a row that add counted, and an empty group with it. */
  remove(value: string, cell = ''): void {
    const group = this.groups.get(value);
    this.count(group ?? this.rest, cell, -1);
    if (group?.rows === 0) this.groups.delete(value);
  }

  /** saved is what the fold holds, which `restored` reads back as it was. */
  saved(): SavedGroups {
    const summed = this.mark !== undefined;
    const meant = this.measure === 'mean';
    const kept = ({ rows, sum, numbers }: Count) => ({
      rows,
      ...(summed ? { sum: sum.saved() } : {}),
      ...(meant ? { numbers } : {}),
    });
    return {
      ...(meant ? { measure: 'mean' as const } : {}),
      mark: this.mark,
      groups: [...this.groups].map(([value, c]) => ({ value, ...kept(c) })),
      rest: kept(this.rest),
      skipped: { ...this.skipped },
    };
  }

  /** restored is the fold `saved` holds, or undefined where it holds none. */
  static restored(saved: unknown): GroupsFold | undefined {
    if (!isRecord(saved)) return undefined;
    const { measure, mark, groups, rest } = saved;
    const skipped = restoredSkipped(saved['skipped']);
    if (skipped === undefined || (mark !== undefined && !isMark(mark)))
      return undefined;
    const meant = measure === 'mean';
    if (!Array.isArray(groups) || groups.length > DISTINCT_AT_MOST)
      return undefined;
    if ((measure !== undefined && !meant) || (meant && mark === undefined))
      return undefined;
    const fold =
      mark === undefined
        ? new GroupsFold()
        : new GroupsFold(meant ? 'mean' : 'sum', mark);
    // A count holds rows, its sum where the fold sums, and of a mean, its
    // numbers, none past its rows.
    const count = (v: unknown, into: Count): boolean => {
      if (!isRecord(v) || !isCount(v['rows'])) return false;
      into.rows = v['rows'];
      const numbers = v['numbers'];
      if (meant) {
        if (!isCount(numbers) || numbers > into.rows) return false;
        into.numbers = numbers;
      }
      const sum = mark === undefined ? into.sum : ExactSum.restored(v['sum']);
      if (sum !== undefined) into.sum = sum;
      return sum !== undefined;
    };
    for (const g of groups) {
      const into = new Count();
      if (!isRecord(g) || typeof g['value'] !== 'string') return undefined;
      if (!count(g, into) || into.rows === 0) return undefined;
      fold.groups.set(g['value'], into);
    }
    if (!count(rest, fold.rest)) return undefined;
    Object.assign(fold.skipped, skipped);
    return fold;
  }

  /**
   * snapshot reads the fold as plain numbers and strings, the values in
   * `moved` first, in its order, and the rest largest first.
   */
  snapshot(moved: readonly string[] = []): Groups {
    return this.read(moved, (value, { rows, sum }) => ({
      value,
      rows,
      sum: sum.value(),
    }));
  }

  /**
   * regroup reads the fold with its values merged by the key `keyOf` gives
   * each, rows added and sums merged exactly, as a map of places reads the
   * groups bars keep. A value `keyOf` gives no key stays its own, unkeyed.
   */
  regroup(keyOf: (value: string) => string | undefined): Regrouped {
    const keyed = new Map<string, Count>();
    const unkeyed: Group[] = [];
    const loose = new Count();
    for (const [value, count] of this.groups) {
      const key = keyOf(value);
      if (key === undefined) {
        unkeyed.push({ value, rows: count.rows, sum: count.sum.value() });
        loose.rows += count.rows;
        loose.sum.merge(count.sum);
        continue;
      }
      const into = keyed.get(key) ?? new Count();
      keyed.set(key, into);
      into.rows += count.rows;
      into.sum.merge(count.sum);
    }
    const keys = [...keyed].sort(([a], [b]) => (a < b ? -1 : 1));
    unkeyed.sort((a, b) => b.rows - a.rows || (a.value < b.value ? -1 : 1));
    const { rest, skipped } = this.snapshot();
    return {
      keys: keys.map(([key, c]) => ({ key, rows: c.rows, sum: c.sum.value() })),
      unkeyed: {
        values: unkeyed.length,
        rows: loose.rows,
        sum: loose.sum.value(),
        top: unkeyed.slice(0, UNKEYED_NAMED),
      },
      rest,
      skipped,
    };
  }

  /** means reads a fold that means as snapshot does, with each group's numbers. */
  means(moved: readonly string[] = []): Groups<MeanGroup> {
    return this.read(moved, (value, { rows, sum, numbers }) => ({
      value,
      rows,
      sum: sum.value(),
      numbers,
    }));
  }

  /** read is the snapshot of the fold, each group read by `of`. */
  private read<G extends Group>(
    moved: readonly string[],
    of: (value: string, count: Count) => G,
  ): Groups<G> {
    const ranked = [...this.groups].map(([value, count]) => of(value, count));
    // A mean ranks a value with no number under every value with one.
    const size = (g: Group) => {
      if (this.measure !== 'mean') return g[this.measure];
      const { numbers } = this.groups.get(g.value)!;
      return numbers === 0 ? Number.NEGATIVE_INFINITY : g.sum / numbers;
    };
    // Two infinite sums differ by NaN, a tie, which goes to value order too.
    ranked.sort(
      (a, b) => size(b) - size(a) || compareStrings(a.value, b.value),
    );
    const groups = movedFirst(ranked, moved);
    const unsent = groups.splice(GROUPS_SENT);
    return {
      groups: groups.map((g) => ({ ...g, value: label(g.value) })),
      others: this.merged(unsent.filter((g) => size(g) > 0)),
      below: this.merged(unsent.filter((g) => size(g) <= 0)),
      rest: { rows: this.rest.rows, sum: this.rest.sum.value() },
      skipped: { ...this.skipped },
    };
  }

  /** merged reads groups as one, their sums merged and read once. */
  private merged(unsent: readonly Group[]): Groups['others'] {
    const all = new Count();
    for (const { value } of unsent) {
      const { rows, sum } = this.groups.get(value)!;
      all.rows += rows;
      all.sum.merge(sum);
    }
    return { values: unsent.length, rows: all.rows, sum: all.sum.value() };
  }

  /** count adds a row to `to`, or takes one back when `sign` is -1. */
  private count(to: Count, cell: string, sign: 1 | -1): void {
    counted(to, cell, sign, this.mark, this.skipped);
  }
}
