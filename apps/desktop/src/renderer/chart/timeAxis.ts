/**
 * @fileoverview An over-time chart's labels under its columns: at the starts
 * of periods a step apart, centred under their columns and kept inside the
 * plot, at the first of the size's natural steps whose labels, two at least,
 * stand TICK_GAP apart. The first label, and each that starts a larger
 * period, carries it ("Mar 2024", "Apr"). Where no step fits, the first and
 * the last are labelled, or the first alone.
 */

import { EPOCH_YEAR } from "@date";
import { sundayOf } from "@tally";
import type { Per, TimeLevel } from "@tally";
import { label, larger, mod } from "./periods.ts";
import { TICK_GAP } from "./scatter.ts";

const WEEK_DAYS = 7;

/** The steps each size labels at, in its periods, finest first. */
const STEPS: Readonly<Record<Per, readonly number[]>> = {
  hour: [1, 2, 3, 6, 12, 24],
  day: [1, 2, 7, 14, 28],
  week: [1, 2, 4, 13],
  month: [1, 2, 3, 6, 12],
  quarter: [1, 2, 4],
  year: [1, 2, 5, 10, 20, 50, 100],
};

/** A label under the columns: the place of the period it names, and its words. */
export interface Tick {
  at: number;
  words: string;
}

/** labelled gives the labels of `level`'s periods at the places `at`, each carrying a larger period it starts. */
function labelled({ per, from }: TimeLevel, at: readonly number[]): Tick[] {
  return at.map((i, n) => {
    const carried = n === 0 || larger(per, from + i) !== larger(per, from + at[n - 1]!);
    return { at: i, words: label(per, from + i, carried) };
  });
}

/**
 * apart says whether `ticks` stand TICK_GAP apart under periods `across` px
 * wide, each `ch` px a character, centred under its column and kept between
 * `low` px left of the periods and their right edge, as chart.css stands them.
 */
function apart(
  ticks: readonly Tick[],
  span: number,
  across: number,
  low: number,
  ch: number,
): boolean {
  const lefts = ticks.map(({ at, words }) => {
    const wide = words.length * ch;
    const left = ((at + 0.5) / span) * across - wide / 2;
    return [Math.min(Math.max(left, low), across - wide), wide] as const;
  });
  return lefts.every(
    ([left], i) => i === 0 || left - lefts[i - 1]![0] - lefts[i - 1]![1] >= TICK_GAP,
  );
}

/**
 * ticksOf gives the labels of `level` drawn over periods `across` px wide,
 * which may reach `low` px past their left, in characters `ch` px wide.
 */
export function ticksOf(level: TimeLevel, across: number, low: number, ch: number): Tick[] {
  const { per, from, span } = level;
  const places = Array.from({ length: span }, (_, i) => i);
  // A step lands on midnight, the first Sunday or week, January or a round year.
  const sunday = from + mod(sundayOf(0) - from, WEEK_DAYS);
  const origins: Partial<Record<Per, number>> = { day: -sunday, week: -from, year: EPOCH_YEAR };
  const origin = origins[per] ?? 0;
  for (const step of STEPS[per]) {
    const at = places.filter((i) => mod(from + i + origin, step) === 0);
    // A step that labels one period of several, or whose labels could not
    // stand apart a character each, is passed by unwritten.
    if (at.length < Math.min(span, 2) || at.length * (ch + TICK_GAP) > across - low) continue;
    const ticks = labelled(level, at);
    if (apart(ticks, span, across, low, ch)) return ticks;
  }
  const ends = labelled(level, span > 1 ? [0, span - 1] : [0]);
  return apart(ends, span, across, low, ch) ? ends : ends.slice(0, 1);
}
