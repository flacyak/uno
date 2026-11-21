/** @fileoverview A heatmap over periods' kind: rows, or a sum, per value and period. */

import type { HeatPlot } from "@document";
import { heatGrid, heatLevel, heatTargets } from "../heat.ts";
import type { ChartKind } from "../kind.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** heat is what a window does with a heatmap over periods' plot, titled by its values. */
export const heat: ChartKind<HeatPlot> = (plot) => ({
  title: () => named(plot.by),
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
    };
  },
});
