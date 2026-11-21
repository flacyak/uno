/**
 * @fileoverview A horizon chart's kind: rows, or a sum, per period, a row of
 * folded bands per series, and the table and summary of the over-time chart
 * or the heatmap whose fold it draws, at the size it draws.
 */

import type { HorizonPlot } from "@document";
import {
  fitHatches,
  heatSeries,
  horizonLevel,
  horizonRows,
  horizonTargets,
  timeSeries,
} from "../horizon.ts";
import type { Horizon } from "../horizon.ts";
import type { Drawing, PlotRoom } from "../kind.ts";
import { heatOver, spannedOver } from "../summary.ts";
import { heated, tableOf, timed } from "../table.ts";
import type { ChartKind } from "../kind.ts";
import { heatTitle } from "./heat.ts";
import { timeTitle } from "./time.ts";
import { undrawn } from "./undrawn.ts";

/** horizon is what a window does with a horizon chart's plot, titled as an over-time chart, or as a heatmap where it names a column of values. */
export const horizon: ChartKind<HorizonPlot> = (plot) => ({
  title: () => (plot.by === undefined ? timeTitle(plot) : heatTitle({ ...plot, by: plot.by })),
  numbered: plot.sum === undefined ? [] : [plot.sum],
  dated: { at: plot.at, reading: "order" in plot ? plot.order : plot.unit },
  valued: plot.by === undefined ? [plot.at] : [plot.by, plot.at],
  drawing: (tally, room) => {
    const summed = plot.sum !== undefined;
    if (tally.t === "time") {
      const level = horizonLevel(tally.levels, room);
      if (level === undefined) return { ...undrawn, empty: true };
      return {
        ...drawn(timeSeries(level, summed), summed, room),
        table: (called) => tableOf(timed(plot, tally, level), called),
        told: () => spannedOver(plot, level),
      };
    }
    const { by, sum } = plot;
    if (tally.t !== "heat" || by === undefined) return undefined;
    const level = horizonLevel(tally.levels, room);
    if (level === undefined) return { ...undrawn, empty: true };
    return {
      ...drawn(heatSeries(tally, level, summed), summed, room),
      table: (called) => tableOf(heated({ by, sum }, tally, level), called),
      told: () => heatOver(tally, level, summed),
    };
  },
});

/** drawn gives the drawing of `horizon`, of rows or sums where `summed`, in `room`, and its targets. */
function drawn(horizon: Horizon, summed: boolean, room: PlotRoom): Drawing {
  return {
    ...undrawn,
    empty: horizon.series.length === 0,
    draw: (height) => horizonRows(horizon, summed, room, height),
    fit: fitHatches,
    targets: (box) => horizonTargets(horizon, summed, box),
  };
}
