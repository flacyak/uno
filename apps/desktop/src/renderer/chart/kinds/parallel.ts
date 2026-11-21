/** @fileoverview Parallel coordinates' kind: a line per sampled row across an axis per number column. */

import type { ParallelPlot } from "@document";
import { m } from "@paraglide/messages";
import { num } from "@renderer/locale";
import type { ChartKind } from "../kind.ts";
import { LINES_DRAWN, parallelLines, parallelTargets } from "../parallel.ts";
import { parallelOver } from "../summary.ts";
import { paralleled, tableOf } from "../table.ts";
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
    const shown = Math.min(tally.values.length, LINES_DRAWN);
    return {
      ...undrawn,
      draw: () => parallelLines(plot, tally),
      targets: (box) => parallelTargets(plot, tally, box),
      table: (called) => tableOf(paralleled(plot, tally), called),
      told: () => parallelOver(plot, tally),
      notes: () => {
        if (shown >= tally.plotted) return [];
        const rows = m.rows_count({ count: tally.plotted });
        return [m.chart_rows_sampled({ shown: num(shown), rows })];
      },
    };
  },
});
