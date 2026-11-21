/** @fileoverview Parallel coordinates' kind: a line per sampled row across an axis per number column. */

import type { ParallelPlot } from "@document";
import type { ChartKind } from "../kind.ts";
import { parallelLines } from "../parallel.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** parallel is what a window does with parallel coordinates' plot, titled by its first axis until its title comes. */
export const parallel: ChartKind<ParallelPlot> = (plot) => ({
  title: () => named(plot.axes[0]!),
  numbered: plot.axes,
  valued: plot.axes,
  drawing: (tally) => {
    if (tally.t !== "parallel") return undefined;
    if (tally.plotted === 0) return { ...undrawn, empty: true };
    return {
      ...undrawn,
      draw: () => parallelLines(plot, tally),
    };
  },
});
