/** @fileoverview A slope chart's kind: a line per value between its two states. */

import type { SlopePlot } from "@document";
import type { ChartKind } from "../kind.ts";
import { m } from "@paraglide/messages";
import { fitSlopes, slopeTargets, sloped, slopes } from "../slope.ts";
import { measuredTitle } from "./dots.ts";
import { undrawn } from "./undrawn.ts";

/** slope is what a window does with a slope chart's plot: "sum of revenue per region, 2024 to 2025". */
export const slope: ChartKind<SlopePlot> = (plot) => ({
  title: () => m.chart_title_slope({ title: measuredTitle(plot), from: plot.from, to: plot.to }),
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
