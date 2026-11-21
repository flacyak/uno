/** @fileoverview A slope chart's kind, whose window says it is not drawn yet. */

import type { SlopePlot } from "@document";
import type { ChartKind } from "../kind.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** slope is what a window does with a slope chart's plot, titled by its column of values until it draws. */
export const slope: ChartKind<SlopePlot> = (plot) => ({
  title: () => named(plot.by),
  numbered: plot.of === undefined ? [] : [plot.of],
  valued: [plot.by, plot.between],
  drawing: () => undrawn,
});
