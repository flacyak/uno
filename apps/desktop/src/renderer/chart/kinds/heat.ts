/** @fileoverview A heatmap over periods' kind: rows, or a sum, per value and period. */

import type { HeatPlot } from "@document";
import { m } from "@paraglide/messages";
import { heatGrid, heatLevel, heatTargets } from "../heat.ts";
import type { ChartKind } from "../kind.ts";
import { PER_WORDS } from "../periods.ts";
import { heatOver } from "../summary.ts";
import { heated, tableOf } from "../table.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** title gives the title a heatmap's plot makes: what it measures per value, per its size or over its dates. */
function title({ by, at, sum, per }: HeatPlot): string {
  const words = { by: named(by), at: named(at) };
  if (per === "auto") {
    if (sum === undefined) return m.chart_title_heat_rows_over(words);
    return m.chart_title_heat_sum_over({ ...words, sum: named(sum) });
  }
  const size = { ...words, per: PER_WORDS[per]() };
  if (sum === undefined) return m.chart_title_heat_rows(size);
  return m.chart_title_heat_sum({ ...size, sum: named(sum) });
}

/** heat is what a window does with a heatmap over periods' plot. */
export const heat: ChartKind<HeatPlot> = (plot) => ({
  title: () => title(plot),
  numbered: plot.sum === undefined ? [] : [plot.sum],
  dated: { at: plot.at, reading: "order" in plot ? plot.order : plot.unit },
  valued: [plot.by, plot.at],
  drawing: (tally, room) => {
    if (tally.t !== "heat") return undefined;
    const level = heatLevel(tally, room);
    if (level === undefined) return { ...undrawn, empty: true };
    const summed = plot.sum !== undefined;
    return {
      ...undrawn,
      draw: (height) => heatGrid(tally, level, summed, room, height),
      targets: (drawn) => heatTargets(tally, level, summed, drawn),
      table: (called) => tableOf(heated(plot, tally, level), called),
      told: () => heatOver(tally, level, summed),
    };
  },
});
