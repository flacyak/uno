/**
 * @fileoverview A pie chart: each value's share of the rows, or of a sum. The
 * six largest values above zero have a slice each, and one Other after them
 * holds the rest. A value at or below zero has no share to draw.
 */

import type { Plot } from "@document";
import type { Groups } from "@engine";

/** How many values have a slice of their own: the colours a theme gives a chart. */
export const PIE_SLICES_AT_MOST = 6;

/** What a pie chart draws. */
type Pie = Extract<Plot, { t: "pie" }>;

/** A slice of a pie: the value it stands for, or none for Other, and what it measures. */
export interface Slice {
  value: string | undefined;
  size: number;
}

/**
 * slices gives `groups` as a pie draws them, each as `plot` measures it: the
 * PIE_SLICES_AT_MOST largest sent groups above zero, then Other, which adds the
 * rest above zero and the values past those a tally keeps apart. A pie of fewer
 * has no Other, as the chart colours hold Other apart from the sixth alone.
 */
export function slices(plot: Pie, groups: Groups): Slice[] {
  const measure = (g: { rows: number; sum: number }): number =>
    plot.sum === undefined ? g.rows : g.sum;
  const above = groups.groups.filter((g) => measure(g) > 0);
  const own = above.slice(0, PIE_SLICES_AT_MOST).map((g) => ({ value: g.value, size: measure(g) }));
  if (own.length < PIE_SLICES_AT_MOST) return own;
  const after = above.slice(PIE_SLICES_AT_MOST).reduce((sum, g) => sum + measure(g), 0);
  // The values past those a tally keeps apart sum together whatever their sign,
  // so Other takes them only where they come to more than zero.
  const other = after + measure(groups.others) + Math.max(measure(groups.rest), 0);
  return other > 0 ? [...own, { value: undefined, size: other }] : own;
}
