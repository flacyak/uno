/**
 * @fileoverview A slope chart's rows: each value it draws, where it stands at
 * its From state and at its To state, as the chart measures it.
 */

import type { SlopePlot } from "@document";
import type { SlopeTally } from "@engine";
import type { Ended } from "@tally";

/** The most values a slope draws, the largest first: past a dozen, lines cross into a tangle. */
export const SLOPES_AT_MOST = 12;

/** A value a slope draws: its label, and where it stands at each state, none where it has no number there. */
export interface Sloped {
  label: string;
  ends: [number | undefined, number | undefined];
}

/** A slope's rows to draw, its two states, and the values it leaves out. */
export interface Slopes {
  rows: Sloped[];
  states: [string, string];
  /** The values past those drawn, which a line under the plot counts. */
  more: number;
}

/**
 * sloped gives the first SLOPES_AT_MOST of `tally`'s values as `plot`
 * measures them at each end: its rows, its sum, or its mean, none for an end
 * of no rows or of no number, and none at all for a value whose rows count
 * apart from their states, as its ends may lack some.
 */
export function sloped(plot: SlopePlot, tally: SlopeTally): Slopes {
  const at = ({ rows, sum, numbers }: Ended): number | undefined => {
    if (rows === 0) return undefined;
    if (plot.of === undefined) return rows;
    if (plot.measure === "sum") return sum;
    return numbers === 0 ? undefined : sum / numbers;
  };
  const rows = tally.values.map(({ value, ends, unsplit }): Sloped => ({
    label: value,
    ends: unsplit ? [undefined, undefined] : [at(ends[0]), at(ends[1])],
  }));
  const more = Math.max(rows.length - SLOPES_AT_MOST, 0) + tally.others.values;
  return { rows: rows.slice(0, SLOPES_AT_MOST), states: [plot.from, plot.to], more };
}
