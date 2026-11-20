/** @fileoverview A dot plot's kind: a dot per value at its rows, or at the sum or mean of another column. */

import type { DotsPlot } from "@document";
import { m } from "@paraglide/messages";
import { dotTargets, dots as drawDots, dotsTold, fitDots } from "../dots.ts";
import { dotted, tableOf } from "../table.ts";
import type { ChartKind } from "../kind.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** dots is what a window does with a dot plot's plot: "mean of days per carrier". */
export const dots: ChartKind<DotsPlot> = (plot) => ({
  title: () => {
    const by = named(plot.by);
    if (plot.of === undefined) return m.chart_title_rows({ by });
    const of = named(plot.of);
    return plot.measure === "mean"
      ? m.chart_title_mean({ of, by })
      : m.chart_title_sum({ sum: of, by });
  },
  numbered: plot.of === undefined ? [] : [plot.of],
  valued: [plot.by],
  drawing: (tally) =>
    tally.t !== "groups" && tally.t !== "mean"
      ? undefined
      : {
          ...undrawn,
          empty: tally.groups.length === 0,
          draw: (height) => drawDots(plot, tally, height),
          fit: fitDots,
          targets: (drawn) => dotTargets(plot, tally, drawn),
          table: (called) => tableOf(dotted(plot, tally), called),
          told: () => dotsTold(plot, tally),
        },
});
