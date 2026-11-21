/** @fileoverview A slope chart's kind: a line per value between its two states. */

import type { SlopePlot } from "@document";
import type { ChartKind } from "../kind.ts";
import { fitSlopes, slopeTargets, sloped, slopes } from "../slope.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** slope is what a window does with a slope chart's plot, titled by its column of values until it is named. */
export const slope: ChartKind<SlopePlot> = (plot) => ({
  title: () => named(plot.by),
  numbered: plot.of === undefined ? [] : [plot.of],
  valued: [plot.by, plot.between],
  drawing: (tally) =>
    tally.t !== "slope"
      ? undefined
      : {
          ...undrawn,
          empty: tally.values.length === 0,
          draw: () => slopes(sloped(plot, tally)),
          fit: fitSlopes,
          targets: (drawn) => slopeTargets(sloped(plot, tally), drawn),
        },
});
