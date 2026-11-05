/**
 * @fileoverview A chart's axes: ticks 1, 2 or 5 times a power of ten apart,
 * from at or below the least value to at or above the most, so every mark
 * stands on the axis.
 */

/** The ticks an axis asks for: the 1-2-5 steps give it 3 to 5. */
const TICKS_WANTED = 4;

/** The leading digits of a step between ticks. Past 5 comes 1 of the next power of ten. */
const DIGITS = [1, 2, 5] as const;

/**
 * How far past a whole number of steps a value may land and still stand on a
 * tick, in steps: far above a double's error, and far below a step.
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

/** An axis: the ticks it draws. */
export interface Axis {
  /** The ticks, least first, a step apart. */
  readonly ticks: readonly number[];
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

/** ticksBy gives the ticks `step` apart from at or below `from` to at or above `to`. */
function ticksBy(step: Step, from: number, to: number): number[] {
  const size = decimal(step.digit, step.exponent);
  const first = Math.floor(from / size + ON_TICK);
  const last = Math.ceil(to / size - ON_TICK);
  const ticks: number[] = [];
  for (let i = 0; i <= last - first; i++) {
    ticks.push(decimal((first + i) * step.digit, step.exponent));
  }
  return ticks;
}

/**
 * axis gives the axis over values from `low` to `high`, where `low` is at most
 * `high`. An axis over one value runs from zero to twice it, and one over
 * values a double barely tells apart runs as over the one further from zero.
 * It serves values within ten to the 307 of zero, over a span of ten to the
 * -307 or more: past those, a double cannot hold the ticks.
 */
export function axis(low: number, high: number): Axis {
  const most = Math.max(Math.abs(low), Math.abs(high));
  const apart = high - low > most * APART_LEAST;
  const reach = apart ? 0 : most === 0 ? ZERO_REACH : most;
  const from = low - reach;
  const to = high + reach;
  const step = stepOver((to - from) / (TICKS_WANTED - 1));
  return { ticks: ticksBy(step, from, to) };
}
