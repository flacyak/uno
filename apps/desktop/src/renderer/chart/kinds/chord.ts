/** @fileoverview A chord chart's kind, whose window says it is not drawn yet. */

import type { ChordPlot } from "@document";
import type { ChartKind } from "../kind.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** chord is what a window does with a chord chart's plot, titled by its from column until it draws. */
export const chord: ChartKind<ChordPlot> = (plot) => ({
  title: () => named(plot.from),
  numbered: plot.sum === undefined ? [] : [plot.sum],
  valued: [plot.from, plot.to],
  drawing: () => undrawn,
});
