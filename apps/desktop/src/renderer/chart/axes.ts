/**
 * @fileoverview A chart's axes: ticks 1, 2 or 5 times a power of ten apart,
 * from at or below the least value to at or above the most, so every mark
 * stands on the axis, and their labels.
 *
 * An axis writes every label one way, as the dataviz skill does: compactly once
 * it reaches COMPACT_FROM, or ALONG_COMPACT_FROM for an axis along a plot whose
 * labels fit side by side, and in full below that. The labels are mono, as the
 * window is, so the room they take is their length in ch.
 */

import { compact, compactsExactly, places } from "@renderer/locale";
import { el } from "@renderer/shell/util";

/** The ticks an axis asks for: the 1-2-5 steps give it 3 to 5. */
const TICKS_WANTED = 4;

/**
 * The most ticks an axis takes from the 1-2-5 step under the one it asks for,
 * which fills more of the plot: 0 to 7.5 ticks by 2 up to 8, where by 5 it
 * runs to 10.
 */
const TICKS_MOST = TICKS_WANTED + 1;

/** An axis that reaches this, above or below zero, writes compactly: the dataviz skill's 10K. */
const COMPACT_FROM = 10_000;

/**
 * An axis along a plot, whose labels in full fit side by side, writes compactly
 * once it reaches this: the dataviz skill writes one in full under a million.
 */
export const ALONG_COMPACT_FROM = 1_000_000;

/** The leading digits of a step between ticks. Past 5 comes 1 of the next power of ten. */
const DIGITS = [1, 2, 5] as const;

/**
 * How far past a whole number of steps a value may land and still stand on a
 * tick, in steps: far above a double's error near zero, and far below a step.
 */
const ON_TICK = 1e-9;

/** How far an axis over 0 alone reaches either side, as 0 gives no scale of its own. */
const ZERO_REACH = 1;

/**
 * The least span an axis tells from one value, as a share of the values' size:
 * far below a span a person charts, and far above a double's error of 2.2e-16,
 * near which the ticks run together.
 */
const APART_LEAST = 1e-12;

/** A step between ticks: `digit` times ten to the `exponent`. */
interface Step {
  readonly digit: number;
  readonly exponent: number;
}

/** An axis: the ticks it draws, and how it writes them. */
export interface Axis {
  /** The ticks, least first, a step apart. */
  readonly ticks: readonly number[];
  /** Each tick as its label writes it. */
  readonly labels: readonly string[];
  /** Whether compact() wrote the labels, in letters no message holds. */
  readonly compact: boolean;
}

/**
 * decimal gives `digit` times ten to the `exponent`, written out and read back,
 * so 3 tenths is 0.3, where 3 * 0.1 is 0.30000000000000004.
 */
function decimal(digit: number, exponent: number): number {
  return Number(`${digit}e${exponent}`);
}

/** stepOver gives the least 1-2-5 step at or above `least`. */
function stepOver(least: number): Step {
  const exponent = Math.floor(Math.log10(least));
  const digit = DIGITS.find((d) => decimal(d, exponent) >= least);
  // Past 5, or where log10 lands a hair under a power of ten, the step is that power.
  return digit === undefined ? { digit: 1, exponent: exponent + 1 } : { digit, exponent };
}

/** finer gives the 1-2-5 step under `step`. Under 1 comes 5 of the power of ten below. */
function finer(step: Step): Step {
  const digit = DIGITS.findLast((d) => d < step.digit);
  return digit === undefined
    ? { digit: DIGITS.at(-1)!, exponent: step.exponent - 1 }
    : { digit, exponent: step.exponent };
}

/** ticksBy gives the ticks `step` apart from at or below `from` to at or above `to`. */
function ticksBy(step: Step, from: number, to: number): number[] {
  const size = decimal(step.digit, step.exponent);
  let first = Math.floor(from / size + ON_TICK);
  let last = Math.ceil(to / size - ON_TICK);
  // Far from zero, the quotient's error passes ON_TICK, so an end that stands
  // on a tick is checked against that tick's own value.
  while (decimal((first + 1) * step.digit, step.exponent) <= from) first++;
  while (decimal((last - 1) * step.digit, step.exponent) >= to) last--;
  const ticks: number[] = [];
  for (let i = 0; i <= last - first; i++) {
    ticks.push(decimal((first + i) * step.digit, step.exponent));
  }
  return ticks;
}

/**
 * axis gives the axis over values from `low` to `high`, where `low` is at most
 * `high`, which writes compactly once it reaches `compactFrom`. An axis over
 * one value runs from zero to twice it, and one over values a double barely
 * tells apart runs as over the one further from zero. It serves values within
 * ten to the 307 of zero, over a span of ten to the -307 or more: past those, a
 * double cannot hold the ticks.
 */
export function axis(low: number, high: number, compactFrom = COMPACT_FROM): Axis {
  const most = Math.max(Math.abs(low), Math.abs(high));
  const apart = high - low > most * APART_LEAST;
  const reach = apart ? 0 : most === 0 ? ZERO_REACH : most;
  const from = low - reach;
  const to = high + reach;
  const wanted = stepOver((to - from) / (TICKS_WANTED - 1));
  const fine = finer(wanted);
  const step = ticksBy(fine, from, to).length <= TICKS_MOST ? fine : wanted;
  const ticks = ticksBy(step, from, to);
  // A label that rounds its tick, as 1.1M does 1,050,000, would misstate it, so
  // such an axis writes its ticks in full.
  const short =
    Math.max(...ticks.map((tick) => Math.abs(tick))) >= compactFrom &&
    ticks.every((tick) => compactsExactly(tick));
  const labels = ticks.map((tick) => (short ? compact(tick) : places(tick, -step.exponent)));
  return { ticks, labels, compact: short };
}

/** gutter gives the room the widest of `axis`'s labels takes, in ch at a tick's size. */
export function gutter(axis: Axis): number {
  return Math.max(0, ...axis.labels.map((label) => label.length));
}

/**
 * tickLabels gives `axis`'s labels as chart.css writes ticks, least first. A
 * compact one sits under .from-file, as compact() writes letters no message
 * holds: 1.2M in the pseudo-locale.
 */
export function tickLabels(axis: Axis): HTMLElement[] {
  const cls = axis.compact ? "chart-tick from-file" : "chart-tick";
  return axis.labels.map((label) => el("span", cls, label));
}
