/**
 * @fileoverview A scatter's kind: a point per row of one number column
 * against another, drawn from a sample with the extent of every row.
 */

import type { Plot } from "@document";
import { m } from "@paraglide/messages";
import type { ChartKind } from "../kind.ts";
import { fitAlong, sampled, scatter as drawScatter } from "../scatter.ts";
import { spanned } from "../summary.ts";
import { points, tableOf } from "../table.ts";
import { pointTargets } from "../tooltip.ts";
import { named } from "./bars.ts";

/** scatter is what a window does with a scatter's plot. */
export const scatter: ChartKind<Extract<Plot, { t: "scatter" }>> = (plot) => ({
  title: () => m.chart_title_against({ x: named(plot.x), y: named(plot.y) }),
  numbered: [plot.x, plot.y],
  valued: [plot.x, plot.y],
  drawing: (tally) =>
    tally.t !== "sample"
      ? undefined
      : {
          empty: tally.plotted === 0,
          draw: () => drawScatter(tally),
          fit: (drawn) => fitAlong(drawn, tally),
          targets: (drawn) => pointTargets(plot, tally, drawn),
          table: (called) => tableOf(points(plot, tally), called),
          told: () => spanned(plot, tally),
          notes: () => [sampled(tally)],
        },
});
