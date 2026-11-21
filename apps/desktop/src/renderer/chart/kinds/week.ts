/** @fileoverview A week heatmap's kind: rows, or the sum of another column, per hour of the week. */

import type { WeekPlot } from "@document";
import { m } from "@paraglide/messages";
import type { ChartKind } from "../kind.ts";
import { weekOver } from "../summary.ts";
import { tableOf, weekly } from "../table.ts";
import { PER_WORDS } from "../periods.ts";
import { slotsOf, weekGrid, weekTargets } from "../week.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** title gives the title a week heatmap's plot makes: what it measures per hour of the week of its dates. */
function title({ at, sum }: WeekPlot): string {
  if (sum === undefined) return m.chart_title_week_rows({ at: named(at) });
  return m.chart_title_week_sum({ at: named(at), sum: named(sum) });
}

/** week is what a window does with a week heatmap's plot. */
export const week: ChartKind<WeekPlot> = (plot) => ({
  title: () => title(plot),
  numbered: plot.sum === undefined ? [] : [plot.sum],
  dated: { at: plot.at, reading: "order" in plot ? plot.order : plot.unit },
  valued: [plot.at],
  drawing: (tally, room) => {
    if (tally.t !== "week") return undefined;
    if (tally.hours.every(({ rows }) => rows === 0)) return { ...undrawn, empty: true };
    const summed = plot.sum !== undefined;
    return {
      ...undrawn,
      draw: () => weekGrid(tally, summed, room),
      targets: (drawn) => weekTargets(tally, summed, drawn),
      table: (called) => tableOf(weekly(plot, tally), called),
      told: () => weekOver(tally, summed),
      // A grid of days says so, as an over-time chart drawn coarser than its size does.
      kept: () => (slotsOf(tally).across > 1 ? "" : m.chart_time_drawn({ drawn: PER_WORDS.day() })),
    };
  },
});
