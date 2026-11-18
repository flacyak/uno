/**
 * @fileoverview A stacked bar chart's kind: a bar per value, of its rows or of
 * the sum of another column, split into a segment per value of a third. Its
 * table, summary and tooltip land after its drawing, so they say it is not
 * drawn yet.
 */

import type { StackPlot } from "@document";
import { m } from "@paraglide/messages";
import { num } from "@renderer/locale";
import { PAIRS_AT_MOST } from "@tally";
import { fitTips } from "../bars.ts";
import type { ChartKind } from "../kind.ts";
import { stack as drawStack } from "../stack.ts";
import { split } from "../summary.ts";
import { stacked, tableOf } from "../table.ts";
import { stackTargets } from "../tooltip.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** stack is what a window does with a stacked bar chart's plot. */
export const stack: ChartKind<StackPlot> = (plot) => ({
  title: () => {
    const [by, split] = [named(plot.by), named(plot.split)];
    return plot.sum === undefined
      ? m.chart_title_stack_rows({ by, split })
      : m.chart_title_stack_sum({ by, split, sum: named(plot.sum) });
  },
  numbered: plot.sum === undefined ? [] : [plot.sum],
  valued: [plot.by, plot.split],
  drawing: (tally, room) =>
    tally.t !== "stack"
      ? undefined
      : {
          ...undrawn,
          empty: tally.values.length === 0,
          draw: (height) => drawStack(plot, tally, height, room),
          fit: fitTips,
          targets: (drawn) => stackTargets(plot, tally, drawn),
          table: (called) => tableOf(stacked(plot, tally), called),
          told: () => split(plot, tally),
          notes: () =>
            tally.unsplit > 0 ? [m.chart_stack_unsplit({ count: num(PAIRS_AT_MOST) })] : [],
        },
});
