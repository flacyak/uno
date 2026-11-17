/**
 * @fileoverview An over-time chart's kind: rows, or the sum of another column,
 * per period of a date column. Its record lands before its drawing, so its
 * window says it is not drawn yet.
 */

import type { TimePlot } from "@document";
import { m } from "@paraglide/messages";
import type { ChartKind } from "../kind.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** time is what a window does with an over-time chart's plot. */
export const time: ChartKind<TimePlot> = (plot) => ({
  title: () =>
    plot.sum === undefined
      ? m.chart_title_rows({ by: named(plot.at) })
      : m.chart_title_sum({ by: named(plot.at), sum: named(plot.sum) }),
  numbered: plot.sum === undefined ? [] : [plot.sum],
  valued: [plot.at],
  drawing: () => undrawn,
});
