/**
 * @fileoverview A stacked bar chart's kind: a bar per value, of its rows or of
 * the sum of another column, split by the value of a third. Its record lands
 * before its drawing, so its window says it is not drawn yet.
 */

import type { StackPlot } from "@document";
import { m } from "@paraglide/messages";
import type { ChartKind } from "../kind.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** stack is what a window does with a stacked bar chart's plot. */
export const stack: ChartKind<StackPlot> = (plot) => ({
  title: () =>
    plot.sum === undefined
      ? m.chart_title_rows({ by: named(plot.by) })
      : m.chart_title_sum({ by: named(plot.by), sum: named(plot.sum) }),
  numbered: plot.sum === undefined ? [] : [plot.sum],
  valued: [plot.by, plot.split],
  drawing: () => undrawn,
});
