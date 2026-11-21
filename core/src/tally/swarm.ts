/** @fileoverview A beeswarm's dots: a sample of each value's rows by rank, and every row's least and most. */

import { compareStrings } from '@go';
import type { Mark } from '@num';
import { parse } from '@num';

import { Ranked } from './rank.ts';
import { SampleFold } from './sample.ts';
import type { Sampled } from './sample.ts';

/** The rows a beeswarm samples of a value: the owner's 128. */
export const SWARM_ROWS_AT_MOST = 128;
/** The most values a beeswarm keeps a sample of, as a box plot keeps a spread; later values share Other's. */
export const SWARM_VALUES_AT_MOST = 32;

/** A value's strip: its rows with a number, and its sampled rows with their numbers, in rank order. */
export interface Strip {
  value: string;
  plotted: number;
  rows: number[];
  at: number[];
}

/** What a beeswarm's fold sends: each value's strip, the most rows first, Other's where a row is in it, and every row's counts and extent. */
export interface Swarm extends Omit<Sampled, 'values' | 'least' | 'most'> {
  strips: Strip[];
  rest?: Strip;
  least: number;
  most: number;
}

/** A value's rows: how many, how many with a number, and a sample of them. */
class Kept {
  rows = 0;
  plotted = 0;
  readonly ranked = new Ranked<number>(SWARM_ROWS_AT_MOST);

  /** count counts `row`, with its number `n` where it has one, or takes it back where `sign` is -1. */
  count(row: number, n: number | undefined, sign: 1 | -1): void {
    this.rows += sign;
    if (n !== undefined) this.plotted += sign;
    if (sign > 0) this.ranked.keep(row, n);
    else this.ranked.delete(row);
  }

  /** strip is the strip of `value`, with these rows. */
  strip(value: string): Strip {
    const first = this.ranked.first();
    const rows = first.map(([row]) => row);
    return { value, plotted: this.plotted, rows, at: first.map(([, n]) => n) };
  }
}

/**
 * SwarmFold keeps a sample of SWARM_ROWS_AT_MOST rows of each value, by rank,
 * while fewer than SWARM_VALUES_AT_MOST have one and Other is empty, so a
 * value's rows are all in its sample or all in Other's. Beside them a sample
 * fold of every row's number keeps its counts and each block's least and
 * most, so an axis takes in every row.
 */
export class SwarmFold {
  readonly mark: Mark;
  private readonly all: SampleFold;
  private readonly values = new Map<string, Kept>();
  private readonly rest = new Kept();

  constructor(mark: Mark) {
    this.mark = mark;
    this.all = new SampleFold([mark], SWARM_ROWS_AT_MOST);
  }

  /** add folds `row` of `block`, whose value is `value` and number cell `cell`. */
  add(block: number, row: number, value: string, cell: string): void {
    this.all.add(block, row, cell);
    let kept = this.values.get(value);
    const room = this.values.size < SWARM_VALUES_AT_MOST;
    if (kept === undefined && room && this.rest.rows === 0) {
      kept = new Kept();
      this.values.set(value, kept);
    }
    (kept ?? this.rest).count(row, parse(cell, this.mark), 1);
  }

  /** remove takes back a row that add folded, which leaves its value's sample, as SampleFold's remove does. */
  remove(block: number, row: number, value: string, cell: string): void {
    this.all.remove(block, row, cell);
    this.take(row, value, cell);
  }

  /** forget takes back a row as remove does, for a block that folds again whole. */
  forget(row: number, value: string, cell: string): void {
    this.all.forget(row, cell);
    this.take(row, value, cell);
  }

  /** refold mends stale `block` from `alone`, a fold of its rows alone. */
  refold(block: number, alone: SwarmFold): void {
    this.all.refold(block, alone.all);
  }

  /** stale lists the blocks whose least and most an edit may leave too wide. */
  stale(): number[] {
    return this.all.stale();
  }

  /** snapshot reads the fold as plain numbers. */
  snapshot(): Swarm {
    const sampled = this.all.snapshot();
    const { plotted, skipped } = sampled;
    const [least, most] = [sampled.least[0]!, sampled.most[0]!];
    const strips = [...this.values].map(([value, kept]) => kept.strip(value));
    strips.sort(
      (a, b) => b.plotted - a.plotted || compareStrings(a.value, b.value),
    );
    const rest = this.rest.rows === 0 ? {} : { rest: this.rest.strip('') };
    return { strips, ...rest, plotted, least, most, skipped };
  }

  /** take takes `row` back from its value's sample, and the value goes once it has no row. */
  private take(row: number, value: string, cell: string): void {
    const kept = this.values.get(value);
    (kept ?? this.rest).count(row, parse(cell, this.mark), -1);
    if (kept?.rows === 0) this.values.delete(value);
  }
}
