/** @fileoverview A week heatmap's kind: rows, or the sum of another column, per hour of the week. */

import type { WeekPlot } from "@document";
import type { ChartKind } from "../kind.ts";
import { weekGrid } from "../week.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** week is what a window does with a week heatmap's plot, titled by its dates. */
export const week: ChartKind<WeekPlot> = (plot) => ({
  title: () => named(plot.at),
  numbered: plot.sum === undefined ? [] : [plot.sum],
  dated: { at: plot.at, reading: "order" in plot ? plot.order : plot.unit },
  valued: [plot.at],
  drawing: (tally) => {
    if (tally.t !== "week") return undefined;
    if (tally.hours.every(({ rows }) => rows === 0)) return { ...undrawn, empty: true };
    return { ...undrawn, draw: () => weekGrid(tally, plot.sum !== undefined) };
  },
});
