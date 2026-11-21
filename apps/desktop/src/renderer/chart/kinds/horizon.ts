/** @fileoverview A horizon chart's kind: rows, or a sum, per period, a row of folded bands per series. */

import type { HorizonPlot } from "@document";
import { amountsOf, horizonRow } from "../horizon.ts";
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
    // A horizon of a row per value draws in the next step.
    if (tally.t === "heat") return undrawn;
    if (tally.t !== "time") return undefined;
    const amounts = amountsOf(tally, plot.sum !== undefined, room);
    if (amounts === undefined) return { ...undrawn, empty: true };
    return { ...undrawn, draw: () => horizonRow(amounts) };
  },
});
