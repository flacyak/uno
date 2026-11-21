/** @fileoverview Parallel coordinates' kind, whose window says it is not drawn yet. */

import type { ParallelPlot } from "@document";
import type { ChartKind } from "../kind.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** parallel is what a window does with parallel coordinates' plot, titled by its first axis until it draws. */
export const parallel: ChartKind<ParallelPlot> = (plot) => ({
  title: () => named(plot.axes[0]!),
  numbered: plot.axes,
  valued: plot.axes,
  drawing: () => undrawn,
});
