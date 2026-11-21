/** @fileoverview A horizon chart's kind, whose window says it is not drawn yet. */

import type { HorizonPlot } from "@document";
import type { ChartKind } from "../kind.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** horizon is what a window does with a horizon chart's plot, titled by its dates until it draws. */
export const horizon: ChartKind<HorizonPlot> = (plot) => ({
  title: () => named(plot.at),
  numbered: plot.sum === undefined ? [] : [plot.sum],
  dated: { at: plot.at, reading: "order" in plot ? plot.order : plot.unit },
  valued: plot.by === undefined ? [plot.at] : [plot.by, plot.at],
  drawing: () => undrawn,
});
