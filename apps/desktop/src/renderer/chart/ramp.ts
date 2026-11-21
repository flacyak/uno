/**
 * @fileoverview The classes a heatmap wears an amount in: as many equal
 * steps from zero up as the ramp has, in the accent's arm, and as many down,
 * in the pole's, all of one round width, so their breaks read as round
 * numbers (2026-11-17, answers 6 and 7).
 */

import { RAMP_SHARES } from "@renderer/theme";
import { decimal } from "./axes.ts";

/** The classes either side of zero, one per step of the ramp. */
export const CLASSES = RAMP_SHARES.length;

/** How far past a break a value may read and still class under it, as 0.1 + 0.2 does 0.3. */
const ON_BREAK = 1e-9;

/**
 * A class's width, in tenths of a power of ten: each at most a third wider
 * than the one before, so the value furthest from zero always lands in the
 * last class, and each round enough that its breaks read well.
 */
const WIDTH_TENTHS = [10, 12, 15, 20, 25, 30, 40, 50, 60, 80] as const;

/** A width: its tenths, and the power of ten they count in. */
interface Width {
  readonly tenths: number;
  readonly exponent: number;
}

/** The width of a scale with nothing either side of zero. */
const ONE: Width = { tenths: WIDTH_TENTHS[0], exponent: -1 };

/** widthOver gives the least width at or above `least`, a whole one where `whole`. */
function widthOver(least: number, whole: boolean): Width {
  const power = Math.floor(Math.log10(least));
  for (const exponent of [power - 1, power]) {
    const tenths = WIDTH_TENTHS.find((t) => {
      const width = decimal(t, exponent);
      return width >= least && (!whole || Number.isInteger(width));
    });
    if (tenths !== undefined) return { tenths, exponent };
  }
  // Ten tenths of the next power of ten is past `least`, and whole.
  return { tenths: WIDTH_TENTHS[0], exponent: power };
}

/** A scale's classes either side of zero. */
export interface Classes {
  /** How wide each class is. */
  readonly width: number;
  /** Each class's top, from zero out, CLASSES of them, each written exactly. */
  readonly breaks: readonly number[];
}

/**
 * classesOver gives the classes of `values`: the least round width whose
 * CLASSES steps reach the value furthest from zero, either side, a whole one
 * of at least 1 for `whole` values, as counts are.
 */
export function classesOver(values: readonly number[], whole: boolean): Classes {
  const most = values.reduce((far, v) => Math.max(far, Math.abs(v)), 0);
  const least = whole ? Math.max(most / CLASSES, 1) : most / CLASSES;
  const { tenths, exponent } = most === 0 ? ONE : widthOver(least, whole);
  const breaks = Array.from({ length: CLASSES }, (_, i) => decimal((i + 1) * tenths, exponent));
  return { width: breaks[0]!, breaks };
}

/**
 * classOf gives the class `value` falls in: 1 to CLASSES above zero, each up
 * to and with its break, -1 to -CLASSES below it, and 0 at zero.
 */
export function classOf(value: number, classes: Classes): number {
  if (value === 0) return 0;
  const reached = Math.ceil(Math.abs(value) / classes.width - ON_BREAK);
  return Math.sign(value) * Math.min(Math.max(reached, 1), CLASSES);
}
