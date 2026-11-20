/**
 * @fileoverview A spread's histogram levels: rows per bin of 1, 2 or 5 times
 * a power of ten, each only where the spread holds every edge.
 */

import { scaled, snapped } from './figures.ts';
import type { Bucket, Figures } from './spread.ts';

/** The most bins a level's span takes, more than a window draws at 4 px a bin. */
export const SPAN_BINS_AT_MOST = 512;
/** The coarsest level a spread sends takes at most this many bins over its span. */
export const SPAN_BINS_AT_LEAST = 8;
/** The most bins a level sends: its span, and the bins past it to each side. */
export const BINS_SENT_AT_MOST = 1_024;
/** The widths of a level's bins, times a power of ten. */
const STEPS = [1, 2, 5] as const;
/** The range a lone 0 spans, so it has a bin of its own. */
const LONE_ZERO_RANGE = 1;

/**
 * One level: rows per bin `step` times 10^`power` wide, from bin `first`,
 * whose low edge is `first` times the width. The span takes `spans` bins
 * from the place `at`; `below` and `above` are the rows past every bin sent.
 */
export interface Level {
  step: number;
  power: number;
  first: number;
  rows: number[];
  at: number;
  spans: number;
  below: number;
  above: number;
}

/** edgeOf is the low edge of the bin at place `i` of `level`, the double nearest it. */
export function edgeOf(level: Level, i: number): number {
  return Number(`${(level.first + i) * level.step}e${level.power}`);
}

/** figuresOf is how many significant figures a whole number writes. */
function figuresOf(n: number): number {
  let digits = `${Math.abs(n)}`;
  while (digits.endsWith('0')) digits = digits.slice(0, -1);
  return digits.length;
}

/**
 * binned is `buckets` counted in bins `step` times 10^`power` wide, over the
 * span from `low` to `high` and the bins past it out to the least and most,
 * at most BINS_SENT_AT_MOST in all, shared evenly where both sides want more.
 * It is undefined where the span takes more than SPAN_BINS_AT_MOST bins or a
 * spread of `figures` does not hold each of its edges, and the bins past it
 * stop at the first edge it does not hold, so no bucket crosses an edge.
 */
function binned(
  buckets: readonly Bucket[],
  [step, power]: [number, number],
  [low, high]: [number, number],
  figures: Figures,
): Level | undefined {
  const binOf = (x: number) => Math.floor(snapped(scaled(x, -power)) / step);
  const held = (edge: number) =>
    figures === 'exact' || figuresOf(edge * step) <= figures;
  const [from, to] = [binOf(low), binOf(high)];
  const spans = to - from + 1;
  if (spans > SPAN_BINS_AT_MOST) return undefined;
  for (let edge = from; edge <= to + 1; edge++) {
    if (!held(edge)) return undefined;
  }
  const room = BINS_SENT_AT_MOST - spans;
  // How many bins past the span, out to `want`, have each edge held.
  const reach = (want: number, edgeAt: (n: number) => number) => {
    let n = 0;
    while (n < Math.min(want, room) && held(edgeAt(n))) n++;
    return n;
  };
  const left = reach(from - binOf(buckets[0]!.low), (n) => from - 1 - n);
  const right = reach(binOf(buckets.at(-1)!.low) - to, (n) => to + 2 + n);
  const at = Math.min(left, Math.max(Math.floor(room / 2), room - right));
  const length = at + spans + Math.min(right, room - at);
  const first = from - at;
  const rows = Array.from({ length }, () => 0);
  let [below, above] = [0, 0];
  for (const b of buckets) {
    const i = binOf(b.low) - first;
    if (i < 0) below += b.rows;
    else if (i >= length) above += b.rows;
    else rows[i] += b.rows;
  }
  return { step, power, first, rows, at, spans, below, above };
}

/**
 * levelsOf bins `buckets`, least first, at each 1, 2 and 5 width, finest
 * first, from the finest whose span from `low` to `high` takes at most
 * SPAN_BINS_AT_MOST bins to the first that takes at most
 * SPAN_BINS_AT_LEAST. A width whose edges need more than `figures` is left
 * out, so every bin is exact; a wide enough one has edges of one figure.
 */
export function levelsOf(
  buckets: readonly Bucket[],
  figures: Figures,
  low: number,
  high: number,
): Level[] {
  if (buckets.length === 0) return [];
  const all = buckets.at(-1)!.low - buckets[0]!.low;
  const range = high - low || all || Math.abs(low) || LONE_ZERO_RANGE;
  const levels: Level[] = [];
  let power = Math.floor(Math.log10(range / SPAN_BINS_AT_MOST));
  for (; ; power++) {
    for (const step of STEPS) {
      const level = binned(buckets, [step, power], [low, high], figures);
      if (level === undefined) continue;
      levels.push(level);
      if (level.spans <= SPAN_BINS_AT_LEAST) return levels;
    }
  }
}
