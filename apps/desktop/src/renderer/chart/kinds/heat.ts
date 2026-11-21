/** @fileoverview A heatmap over periods' kind, whose window says it is not drawn yet. */

import type { HeatPlot } from "@document";
import type { ChartKind } from "../kind.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** heat is what a window does with a heatmap over periods' plot, titled by its values until it draws. */
export const heat: ChartKind<HeatPlot> = (plot) => ({
  title: () => named(plot.by),
  numbered: plot.sum === undefined ? [] : [plot.sum],
  dated: { at: plot.at, reading: "order" in plot ? plot.order : plot.unit },
  valued: [plot.by, plot.at],
  drawing: () => undrawn,
});
