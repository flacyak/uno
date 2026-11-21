/** @fileoverview A week heatmap's kind, whose window says it is not drawn yet. */

import type { WeekPlot } from "@document";
import type { ChartKind } from "../kind.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** week is what a window does with a week heatmap's plot, titled by its dates until it draws. */
export const week: ChartKind<WeekPlot> = (plot) => ({
  title: () => named(plot.at),
  numbered: plot.sum === undefined ? [] : [plot.sum],
  dated: { at: plot.at, reading: "order" in plot ? plot.order : plot.unit },
  valued: [plot.at],
  drawing: () => undrawn,
});
