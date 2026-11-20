/** @fileoverview A dot plot's kind, whose window says it is not drawn yet. */

import type { DotsPlot } from "@document";
import { m } from "@paraglide/messages";
import type { ChartKind } from "../kind.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** dots is what a window does with a dot plot's plot: "sum of revenue per region". */
export const dots: ChartKind<DotsPlot> = (plot) => ({
  title: () =>
    plot.of === undefined
      ? m.chart_title_rows({ by: named(plot.by) })
      : m.chart_title_sum({ sum: named(plot.of), by: named(plot.by) }),
  numbered: plot.of === undefined ? [] : [plot.of],
  valued: [plot.by],
  drawing: () => undrawn,
});
