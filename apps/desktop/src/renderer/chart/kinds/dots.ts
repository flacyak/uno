/** @fileoverview A dot plot's kind, whose window says it is not drawn yet. */

import type { DotsPlot } from "@document";
import { m } from "@paraglide/messages";
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
  drawing: () => undrawn,
});
