/** @fileoverview A horizon chart's kind: rows, or a sum, per period, a row of folded bands per series. */

import type { HorizonPlot } from "@document";
import { horizonRows, horizonTargets, seriesOf } from "../horizon.ts";
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
    if (tally.t !== "time" && tally.t !== "heat") return undefined;
    const summed = plot.sum !== undefined;
    const horizon = seriesOf(tally, summed, room);
    if (horizon === undefined || horizon.series.length === 0) return { ...undrawn, empty: true };
    return {
      ...undrawn,
      draw: (height) => horizonRows(horizon, summed, room, height),
      targets: (drawn) => horizonTargets(horizon, summed, drawn),
    };
  },
});
