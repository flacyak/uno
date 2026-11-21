/** @fileoverview A horizon chart's kind: rows, or a sum, per period, a row of folded bands per series. */

import type { HorizonPlot } from "@document";
import { horizonRows, seriesOf } from "../horizon.ts";
import type { ChartKind } from "../kind.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** horizon is what a window does with a horizon chart's plot, titled by its dates. */
export const horizon: ChartKind<HorizonPlot> = (plot) => ({
  title: () => named(plot.at),
  numbered: plot.sum === undefined ? [] : [plot.sum],
  dated: { at: plot.at, reading: "order" in plot ? plot.order : plot.unit },
  valued: plot.by === undefined ? [plot.at] : [plot.by, plot.at],
  drawing: (tally, room) => {
    if (tally.t !== "time" && tally.t !== "heat") return undefined;
    const summed = plot.sum !== undefined;
    const series = seriesOf(tally, summed, room);
    if (series.length === 0) return { ...undrawn, empty: true };
    return { ...undrawn, draw: (height) => horizonRows(series, summed, room, height) };
  },
});
