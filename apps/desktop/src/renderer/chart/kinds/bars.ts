/**
 * @fileoverview A bar chart's kind: a bar per value, of its rows or of the
 * sum of another column, with each value's tip at its end.
 */

import type { ChartColumn, Plot } from "@document";
import { m } from "@paraglide/messages";
import { columnLabel } from "@renderer/grid/rows";
import { bars as drawBars, fitTips } from "../bars.ts";
import type { ChartKind } from "../kind.ts";
import { valued } from "../summary.ts";
import { grouped, tableOf } from "../table.ts";
import { barTargets } from "../tooltip.ts";

/** named gives a column as the head names it. */
export const named = ({ header, col }: ChartColumn): string => columnLabel(header, col);

/** bars is what a window does with a bar chart's plot. */
export const bars: ChartKind<Extract<Plot, { t: "bars" }>> = (plot) => ({
  title: () =>
    plot.sum === undefined
      ? m.chart_title_rows({ by: named(plot.by) })
      : m.chart_title_sum({ by: named(plot.by), sum: named(plot.sum) }),
  numbered: plot.sum === undefined ? [] : [plot.sum],
  valued: [plot.by],
  drawing: (tally) =>
    tally.t !== "groups"
      ? undefined
      : {
          empty: tally.groups.length === 0,
          draw: (height) => drawBars(plot, tally, height),
          fit: fitTips,
          targets: (drawn) => barTargets(plot, tally, drawn),
          table: (called) => tableOf(grouped(plot, tally), called),
          told: () => valued(plot, tally),
          notes: () => [],
        },
});
